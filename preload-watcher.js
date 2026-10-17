/**
 * preload-watcher.js
 * 注入到每个电商平台 <webview> 内部的预加载脚本
 * 核心职责：
 * 1. 四重消息感知引擎（Web Notification拦截 + Audio播放拦截 + Title闪烁监听 + DOM未读红点MutationObserver）
 * 2. 纯净客服CSS净化器（一键剥离商家后台左侧菜单/顶部导航/广告弹窗，只留原版聊天接待区）
 * 3. React/Vue受控组件级账密自动填充器（绕过直接修改input.value无效的问题）
 */

const { ipcRenderer } = require('electron');

(function initCSWatcher() {
  let lastUnreadCount = 0;
  let lastTitle = '';
  let platformConfig = null;
  let cleanStyleEl = null;
  // v11 Phase D: 订单页「待发货」数字轮扫状态
  let lastOrderCount = -1;
  let orderSentOnce = false;

  // ============================================================================
  // 1. 拦截网页原生 Notification API（飞鸽、多多、咚咚、千帆等收到消息时会调用）
  // ============================================================================
  try {
    const OriginalNotification = window.Notification;
    function HookedNotification(title, options = {}) {
      ipcRenderer.sendToHost('cs-incoming-alert', {
        source: 'web-notification',
        title: String(title || '新客户消息'),
        body: String(options.body || '收到一条新的买家咨询消息'),
        timestamp: Date.now()
      });
      if (OriginalNotification) {
        return new OriginalNotification(title, options);
      }
    }
    HookedNotification.permission = 'granted';
    HookedNotification.requestPermission = async () => 'granted';
    window.Notification = HookedNotification;
  } catch (err) {
    // 忽略部分严格沙箱页面重写异常
  }

  // ============================================================================
  // 2. 拦截网页原生 <audio>.play()（当原版客服网页播放叮咚声时同步触发标签页变色闪烁）
  // ============================================================================
  try {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      ipcRenderer.sendToHost('cs-incoming-alert', {
        source: 'native-audio',
        title: '收到新消息（原版提示音触发）',
        body: document.title || '买家发来新消息',
        timestamp: Date.now()
      });
      return originalPlay.apply(this, args);
    };
  } catch (err) {}

  // ============================================================================
  // 3. 监听网页 Title 与 DOM 未读角标变化
  // ============================================================================
  function parseUnreadFromTitle(title) {
    if (!title) return 0;
    // 匹配 (3)、【2条新消息】、[5] 等常见标题未读格式
    const bracketMatch = title.match(/[\(\[（【]\s*(\d+)\s*(?:条|未读|新消息)?\s*[\)\]）】]/);
    if (bracketMatch) {
      return parseInt(bracketMatch[1], 10) || 0;
    }
    if (/新消息|有未读|客户咨询|待回复/.test(title)) {
      return 1;
    }
    return 0;
  }

  function scanDomUnreadCount() {
    let total = 0;
    const defaultSelectors = [
      '.unread-num',
      '.unread-count',
      '.chat-unread-dot',
      '[class*="unreadCount"]',
      '[class*="unread-badge"]',
      '[class*="unread-num"]',
      '.auxo-badge-count',
      '.beast-badge-count',
      '.d-badge-count',
      '.ks-badge-count',
      '.weui-badge',
      '.dd-badge',
      '.im-unread-num'
    ];
    const selectors = (platformConfig && Array.isArray(platformConfig.unreadSelectors))
      ? [...new Set([...platformConfig.unreadSelectors, ...defaultSelectors])]
      : defaultSelectors;

    const visitedNodes = new Set();
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        nodes.forEach((node) => {
          if (visitedNodes.has(node)) return;
          visitedNodes.add(node);
          // 确保元素可见
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return;
          }
          const text = (node.innerText || node.textContent || '').trim();
          if (/^\d+$/.test(text)) {
            total += parseInt(text, 10);
          } else if (/^\d+\+$/.test(text)) {
            total += parseInt(text, 10) || 99;
          } else if (node.classList.contains('red-dot') || node.classList.contains('chat-unread-dot')) {
            total += 1;
          }
        });
      } catch (e) {}
    }

    const titleUnread = parseUnreadFromTitle(document.title);
    return Math.max(total, titleUnread);
  }

  function checkUnreadAndNotify() {
    const currentTitle = document.title || '';
    const currentUnread = scanDomUnreadCount();

    const titleHasAlert = currentTitle !== lastTitle && /新消息|未读|待回复|提醒/.test(currentTitle);
    const unreadIncreased = currentUnread > lastUnreadCount;

    if (unreadIncreased || titleHasAlert || currentUnread !== lastUnreadCount) {
      ipcRenderer.sendToHost('cs-unread-update', {
        unreadCount: currentUnread,
        isNewMessage: unreadIncreased || titleHasAlert,
        pageTitle: currentTitle,
        timestamp: Date.now()
      });
    }

    lastUnreadCount = currentUnread;
    lastTitle = currentTitle;
  }

  // ============================================================================
  // 4. 纯净客服模式（CSS注入剥离商家后台菜单栏，只保留原版客服聊天窗口）
  // ============================================================================
  function applyCleanMode(enabled, cssText) {
    if (!cleanStyleEl) {
      cleanStyleEl = document.getElementById('cs-hub-clean-style');
      if (!cleanStyleEl && document.head) {
        cleanStyleEl = document.createElement('style');
        cleanStyleEl.id = 'cs-hub-clean-style';
        document.head.appendChild(cleanStyleEl);
      }
    }
    if (cleanStyleEl) {
      cleanStyleEl.textContent = enabled && cssText ? cssText : '';
    }
  }

  // ============================================================================
  // 5. React / Vue 受控表单级账密自动填充登录
  // ============================================================================
  function setNativeInputValue(inputEl, value) {
    if (!inputEl) return false;
    inputEl.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(inputEl, value);
    } else {
      inputEl.value = value;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    inputEl.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function findFirstVisibleElement(selectorList = []) {
    for (const sel of selectorList) {
      try {
        if (sel.includes(':contains(')) {
          const match = sel.match(/^([a-zA-Z0-9_-]*):contains\("(.+)"\)$/);
          if (match) {
            const tag = match[1] || '*';
            const keyword = match[2];
            const candidates = document.querySelectorAll(tag);
            for (const el of candidates) {
              if ((el.innerText || '').trim().includes(keyword) && el.offsetParent !== null) {
                return el;
              }
            }
          }
          continue;
        }
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.offsetParent !== null) return el;
        }
      } catch (e) {}
    }
    return null;
  }

  function showInPageBanner(msg, color = '#07C160') {
    try {
      let banner = document.getElementById('cs-hub-autofill-toast');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'cs-hub-autofill-toast';
        banner.style.cssText = `
          position: fixed; top: 14px; right: 14px; z-index: 2147483647;
          background: ${color}; color: #fff; padding: 10px 16px;
          border-radius: 8px; font-size: 13px; font-weight: 600;
          box-shadow: 0 6px 20px rgba(0,0,0,0.25); pointer-events: none;
          transition: opacity 0.3s ease; font-family: system-ui, -apple-system, sans-serif;
        `;
        document.body.appendChild(banner);
      }
      banner.style.background = color;
      banner.style.opacity = '1';
      banner.textContent = msg;
      setTimeout(() => {
        if (banner) banner.style.opacity = '0';
      }, 3800);
    } catch (e) {}
  }

  function executeAutoFill({ username, password, autoSubmit, loginSelectors }) {
    if (!username && !password) {
      showInPageBanner('请先在顶部「保存账密」中设置该店铺的账号与密码', '#FF5000');
      return;
    }

    const selectors = loginSelectors || (platformConfig && platformConfig.loginSelectors) || {};

    // 第一步：如果当前默认是扫码登录，尝试点击切换到“密码登录/账号登录”
    const switchBtn = findFirstVisibleElement(selectors.switchPasswordTab || []);
    if (switchBtn) {
      switchBtn.click();
    }

    setTimeout(() => {
      const userEl = findFirstVisibleElement(
        selectors.username || [
          'input[placeholder*="手机"]',
          'input[placeholder*="账号"]',
          'input[placeholder*="用户名"]',
          'input[placeholder*="邮箱"]',
          'input[type="text"]',
          'input[type="tel"]'
        ]
      );
      const passEl = findFirstVisibleElement(
        selectors.password || ['input[type="password"]', 'input[placeholder*="密码"]']
      );

      let filledCount = 0;
      if (userEl && username) {
        setNativeInputValue(userEl, username);
        filledCount++;
      }
      if (passEl && password) {
        setNativeInputValue(passEl, password);
        filledCount++;
      }

      // 自动勾选“我已阅读并同意服务协议”复选框
      const agreeEl = findFirstVisibleElement(selectors.agreement || ['input[type="checkbox"]']);
      if (agreeEl && !agreeEl.checked) {
        agreeEl.click();
      }

      if (filledCount > 0) {
        showInPageBanner(`已为您自动填入店铺账号密码（${username}）`, '#07C160');
        if (autoSubmit) {
          setTimeout(() => {
            const submitBtn = findFirstVisibleElement(
              selectors.submit || ['button[type="submit"]', '[class*="login-btn"]']
            );
            if (submitBtn) submitBtn.click();
          }, 350);
        }
      } else {
        showInPageBanner('当前页面未检测到登录输入框（可能已处于登录状态或需先切到密码登录Tab）', '#FF9900');
      }
    }, 300);
  }

  // ============================================================================
  // ============================================================================
  // v11 Phase D: 订单页「待发货」数字扫描（每 90s）
  // 策略：先找包含关键词(待发货/未发货)文本的 Tab/按钮/统计块，读取其数字徽标或同行数字
  // ============================================================================
  function scanOrderPendingCount() {
    const keywords = (platformConfig && Array.isArray(platformConfig.orderUnreadKeyword)) && platformConfig.orderUnreadKeyword.length
      ? platformConfig.orderUnreadKeyword
      : ['待发货'];
    // 1) 找文本命中关键词的可见元素（Tab/按钮/统计标题）
    const hitEls = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const txt = (el.innerText || '').trim();
      if (txt.length > 40) continue; // 只看小文本块
      if (keywords.some((k) => txt.includes(k))) hitEls.push(el);
    }
    for (const el of hitEls) {
      // 元素自身带数字徽标（如「待发货 12」）
      const selfNum = (el.innerText || '').match(/(\d+)\s*单?\s*$/m) || (el.innerText || '').match(/\d+/m);
      let m = null;
      const t = (el.innerText || '').trim();
      const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
      for (const line of lines) {
        if (!keywords.some((k) => line.includes(k))) continue;
        const nm = line.match(/(\d+)/); // 关键词同一行内的数字
        if (nm) { m = nm; break; }
      }
      if (!m) {
        // 数字在相邻的徽标/数字节点（子元素、父元素内的 badge）
        const badges = el.querySelectorAll('[class*="badge"], [class*="count"], [class*="num"], sup');
        badges.forEach((b) => {
          if (m) return;
          const bt = (b.innerText || b.textContent || '').trim();
          if (/^\d+$/.test(bt)) m = bt.match(/\d+/);
        });
      }
      if (m) {
        return parseInt(m[1], 10) || 0;
      }
    }
    // 3) 没找到带数字的关键词块 → 未知，返回 -1（仪表盘显示「读取中」，不触发提醒）
    return -1;
  }

  // v18: 判断当前是不是停在登录页（没登录当然读不到订单数字，不该一直显示「读取中」）
  function csOrderLoginRequired() {
    try {
      const u = location.href || '';
      if (/\/(login|signin|passport|sso)/i.test(u)) return true;
      if (/login\.taobao\.com|login\.kwaixiaodian\.com|passport\.jd\.com|passport\.shop\.jd\.com|mms\.pinduoduo\.com\/login/i.test(u)) return true;
      const pwds = document.querySelectorAll('input[type="password"]');
      for (const p of pwds) {
        const r = p.getBoundingClientRect();
        if (r.width > 40 && r.height > 8) return true;
      }
    } catch (e) {}
    return false;
  }

  function checkOrderCount() {
    const c = scanOrderPendingCount();
    lastOrderCount = c;
    // v18: 停在登录页 -> 上报 -2（仪表盘显示「未登录」），别再一直显示「读取中」
    const needLogin = (c < 0) && csOrderLoginRequired();
    if (needLogin) {
      ipcRenderer.sendToHost('cs-order-update', { count: -2, loginRequired: true, timestamp: Date.now() });
      orderSentOnce = true;
      return;
    }
    // 首次读到有效数字也要上报一次，让仪表盘显示
    if (c >= 0 || !orderSentOnce) {
      ipcRenderer.sendToHost('cs-order-update', { count: c, timestamp: Date.now() });
      orderSentOnce = true;
    }
  }

  // v18: 京东订单页第一次打开常出现「数据异常，请刷新重试」，自动刷新一次即可。
  //      只重试一次，避免死循环。
  function csAutoReloadOnce() {
    if (window.__csReloadedOnce) return;
    setTimeout(() => {
      try {
        if (window.__csReloadedOnce) return;
        const t = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000);
        if (/数据异常|请刷新重试|加载失败|网络异常|页面出错/.test(t)) {
          window.__csReloadedOnce = true;
          location.reload();
        }
      } catch (e) {}
    }, 3500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', csAutoReloadOnce);
  else csAutoReloadOnce();

  // v18: 一键跳到「等待时间最长」的买家对话（通用启发式，靠时间文字判断）
  function csWaitMinutes(s) {
    let m;
    if ((m = /^(\d+)\s*秒前/.exec(s))) return Number(m[1]) / 60;
    if (/刚刚/.test(s)) return 0.5;
    if ((m = /^(\d+)\s*分钟前/.exec(s))) return Number(m[1]);
    if ((m = /^(\d+)\s*小时前/.exec(s))) return Number(m[1]) * 60;
    if ((m = /^(\d+)\s*天前/.exec(s))) return Number(m[1]) * 1440;
    if (/昨天/.test(s)) return 1440;
    if (/前天/.test(s)) return 2880;
    if ((m = /^(\d{1,2})\s*:\s*(\d{2})/.exec(s))) return 1440 - (Number(m[1]) * 60 + Number(m[2]));
    return 0;
  }
  function csClickableAncestor(el) {
    let cur = el, depth = 0;
    while (cur && cur !== document.body && depth < 8) {
      let st = null;
      try { st = window.getComputedStyle(cur); } catch (e) {}
      const tag = (cur.tagName || '').toLowerCase();
      const cls = (typeof cur.className === 'string') ? cur.className : '';
      if ((st && st.cursor === 'pointer') || cur.getAttribute('role') === 'button' ||
          tag === 'a' || tag === 'button' || /item|row|session|chat|conv|list/i.test(cls)) return cur;
      cur = cur.parentElement; depth++;
    }
    return el;
  }
  function csFindOldestConversation() {
    const timeRe = /(刚刚|\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|昨天|前天|\d+\s*天前|\d{1,2}\s*:\s*\d{2})/;
    const cands = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.children.length > 6) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (!txt || txt.length > 60 || txt.length < 2) continue;
      const m = txt.match(timeRe);
      if (!m) continue;
      let st = null;
      try { st = window.getComputedStyle(el); } catch (e) {}
      if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) continue;
      cands.push({ el: el, wait: csWaitMinutes(m[0]), tag: m[0] });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.wait - a.wait);
    return cands[0];
  }
  ipcRenderer.on('cs-jump-oldest', () => {
    try {
      const best = csFindOldestConversation();
      if (!best) { ipcRenderer.sendToHost('cs-jump-oldest-result', { ok: false, reason: '页面上没找到带时间标记的对话' }); return; }
      const target = csClickableAncestor(best.el);
      if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      target.click();
      ipcRenderer.sendToHost('cs-jump-oldest-result', { ok: true, waitText: best.tag });
    } catch (e) {
      ipcRenderer.sendToHost('cs-jump-oldest-result', { ok: false, reason: String((e && e.message) || e) });
    }
  });

  // =========================================================================
  // 6. IPC 通信绑定与生命周期启动
  // ============================================================================
  ipcRenderer.on('cs-init-config', (event, config) => {
    platformConfig = config;
    // v11 Phase D: 订单页 webview 启动 90s 待发货数字轮扫（客服页无 orderUnreadKeyword 自动跳过）
    if (config && Array.isArray(config.orderUnreadKeyword) && config.orderUnreadKeyword.length) {
      checkOrderCount();
      setInterval(checkOrderCount, 90000);
    }
    if (config && config.cleanModeEnabled && config.cleanCss) {
      applyCleanMode(true, config.cleanCss);
    }
    if (config && config.autoFillOnLoad && config.credentials && config.credentials.username) {
      setTimeout(() => {
        executeAutoFill({
          username: config.credentials.username,
          password: config.credentials.password,
          autoSubmit: config.credentials.autoSubmit,
          loginSelectors: config.loginSelectors
        });
      }, 1200);
    }
  });

  ipcRenderer.on('cs-toggle-clean-mode', (event, { enabled, cleanCss }) => {
    applyCleanMode(enabled, cleanCss || (platformConfig && platformConfig.cleanCss));
    showInPageBanner(
      enabled ? '已开启「纯净客服模式」：已隐藏多余商家后台菜单' : '已恢复原始完整网页视图',
      '#1677FF'
    );
  });

  ipcRenderer.on('cs-autofill-now', (event, payload) => {
    executeAutoFill(payload);
  });

  window.addEventListener('DOMContentLoaded', () => {
    if (platformConfig && platformConfig.cleanModeEnabled && platformConfig.cleanCss) {
      applyCleanMode(true, platformConfig.cleanCss);
    }

    // 启动 DOM 变化监控
    const observer = new MutationObserver(() => {
      checkUnreadAndNotify();
    });
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    // 定时兜底扫描（每 1.5 秒检查一次未读角标与标题）
    setInterval(checkUnreadAndNotify, 1500);
  });
})();
