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
  let lastOrderKeyword = '';
  let lastOrderSnippet = '';

  function scanRootForOrder(root, keywords) {
    let foundKeyword = null;
    let snippet = '';
    const hitEls = [];
    let walker = null;
    try { walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); } catch (e) { return { count: -1 }; }
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!el || !el.tagName) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
      let st = null;
      try { st = window.getComputedStyle(el); } catch (e) { continue; }
      if (!st || st.display === 'none' || st.visibility === 'hidden') continue;
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 60) continue;
      let hit = false;
      for (const k of keywords) { if (txt.indexOf(k) >= 0) { hit = true; break; } }
      if (hit) hitEls.push(el);
    }
    for (const el of hitEls) {
      const t = (el.innerText || '').trim();
      if (!foundKeyword) {
        for (const k of keywords) { if (t.indexOf(k) >= 0) { foundKeyword = k; break; } }
        snippet = t.replace(/\s+/g, ' ').slice(0, 50);
      }
      // ① 关键词同一行里的数字
      const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
      for (const line of lines) {
        let has = false;
        for (const k of keywords) { if (line.indexOf(k) >= 0) { has = true; break; } }
        if (!has) continue;
        const nm = line.match(/(\d[\d,]*)/);
        if (nm) return { count: parseInt(nm[1].replace(/,/g, ''), 10) || 0, foundKeyword: foundKeyword, snippet: snippet };
      }
      // ② 元素内部的小徽标数字
      let badges = [];
      try { badges = Array.prototype.slice.call(el.querySelectorAll('[class*="badge"], [class*="count"], [class*="num"], sup, em, i, span')); } catch (e) { badges = []; }
      for (const b of badges) {
        const bt = String((b && (b.innerText || b.textContent)) || '').trim();
        if (/^\d{1,7}$/.test(bt)) return { count: parseInt(bt, 10) || 0, foundKeyword: foundKeyword, snippet: snippet };
      }
      // ③ v19: 相邻兄弟节点 / 子节点 / 父节点里光秃秃一个数字
      const cands = [];
      try {
        if (el.nextElementSibling) cands.push(el.nextElementSibling);
        if (el.previousElementSibling) cands.push(el.previousElementSibling);
        for (let ci = 0; ci < el.children.length && ci < 6; ci++) cands.push(el.children[ci]);
        if (el.parentElement) cands.push(el.parentElement);
      } catch (e) {}
      for (const c of cands) {
        const ct = String((c && (c.innerText || c.textContent)) || '').trim();
        if (/^\d{1,7}$/.test(ct)) return { count: parseInt(ct, 10) || 0, foundKeyword: foundKeyword, snippet: snippet };
        const m2 = ct.match(/(\d[\d,]*)\s*单/);
        if (m2) return { count: parseInt(m2[1].replace(/,/g, ''), 10) || 0, foundKeyword: foundKeyword, snippet: snippet };
      }
    }
    return { count: -1, foundKeyword: foundKeyword, snippet: snippet };
  }

  function scanOrderPendingCount() {
    let keywords = (platformConfig && Array.isArray(platformConfig.orderUnreadKeyword) && platformConfig.orderUnreadKeyword.length)
      ? platformConfig.orderUnreadKeyword.slice()
      : ['待发货'];
    // v19: 各平台叫法不一样，多补几个常见说法
    ['待发货订单', '未发货', '待处理发货', '待出库', '待备货'].forEach(function (k) {
      if (keywords.indexOf(k) < 0) keywords.push(k);
    });

    const roots = [];
    try { if (document.body) roots.push(document.body); } catch (e) {}
    // v19: 很多商家后台把订单列表放在内嵌框架(iframe)里，不扫框架就永远读不到
    try {
      const ifr = document.querySelectorAll('iframe');
      for (let i = 0; i < ifr.length; i++) {
        try { if (ifr[i] && ifr[i].contentDocument && ifr[i].contentDocument.body) roots.push(ifr[i].contentDocument.body); } catch (e) {}
      }
    } catch (e) {}

    let foundKeyword = null;
    let snippet = '';
    for (const root of roots) {
      const r = scanRootForOrder(root, keywords);
      if (typeof r.count === 'number' && r.count >= 0) {
        lastOrderKeyword = r.foundKeyword || '';
        lastOrderSnippet = r.snippet || '';
        return r.count;
      }
      if (r.foundKeyword && !foundKeyword) { foundKeyword = r.foundKeyword; snippet = r.snippet; }
    }
    lastOrderKeyword = foundKeyword || '';
    lastOrderSnippet = snippet || '';
    // v19: 页面上确实写着「待发货」，只是旁边没数字 —— 那基本就是 0 单。
    //      以前这种情况返回 -1，仪表盘就一直显示「读取中」，看着像坏了。
    if (foundKeyword) return 0;
    return -1;
  }

  // v19: 把订单页的真实情况报回去，方便远程定位「读取中」到底卡在哪
  function csOrderDebug() {
    const d = {
      url: '', title: '', bodyLen: 0, iframes: 0, sameOriginIframes: 0,
      keyword: lastOrderKeyword || '', snippet: lastOrderSnippet || '',
      loginRequired: false,
      lastCount: (typeof lastOrderCount === 'number' ? lastOrderCount : -1)
    };
    try { d.url = location.href || ''; } catch (e) {}
    try { d.title = document.title || ''; } catch (e) {}
    try { d.bodyLen = (document.body && document.body.innerText) ? document.body.innerText.length : 0; } catch (e) {}
    try { d.iframes = document.querySelectorAll('iframe').length; } catch (e) {}
    try {
      const ifr = document.querySelectorAll('iframe');
      for (let i = 0; i < ifr.length; i++) { try { if (ifr[i] && ifr[i].contentDocument) d.sameOriginIframes++; } catch (e) {} }
    } catch (e) {}
    try { d.loginRequired = csOrderLoginRequired(); } catch (e) {}
    try {
      if (!d.keyword && document.body) {
        const bt = document.body.innerText || '';
        ['待发货', '未发货', '待出库', '待备货', '待处理'].forEach(function (k) {
          if (!d.keyword && bt.indexOf(k) >= 0) d.keyword = k + '（页面上出现过，但没读到数字）';
        });
      }
    } catch (e) {}
    return d;
  }

  // v20: 以前只在「第一次」上报，之后只要读到 -1 就再也不上报了 ——
  //      结果页面还没渲染完那一次扫空，就被永久卡在「读取中」。
  //      现在改成：数字一变就上报；连续失败并且已经过了预热期，才认定「读不到」。
  let lastSentCount = null;
  let orderFailStreak = 0;
  let firstScanAt = 0;

  function checkOrderCount() {
    if (!firstScanAt) firstScanAt = Date.now();
    const c = scanOrderPendingCount();
    lastOrderCount = c;

    // 停在登录页 -> 上报 -2（仪表盘显示「未登录」）
    if (c < 0 && csOrderLoginRequired()) {
      if (lastSentCount !== -2) {
        ipcRenderer.sendToHost('cs-order-update', { count: -2, loginRequired: true, timestamp: Date.now() });
        lastSentCount = -2;
      }
      orderFailStreak = 0;
      return;
    }

    if (c >= 0) {
      orderFailStreak = 0;
      if (lastSentCount !== c) {
        ipcRenderer.sendToHost('cs-order-update', { count: c, timestamp: Date.now() });
        lastSentCount = c;
      }
      return;
    }

    // c < 0 且不是登录页：连续失败 3 次、并且已经过了 35 秒预热期，才显示「读取中」
    orderFailStreak++;
    if (orderFailStreak >= 3 && (Date.now() - firstScanAt) > 35000 && lastSentCount !== -1) {
      ipcRenderer.sendToHost('cs-order-update', { count: -1, timestamp: Date.now() });
      lastSentCount = -1;
    }
  }

  // v20: 抖店这类平台的「待发货」页签要点一下才出来，网址里没有参数，刷新就丢了。
  //      扫不到数字的时候，自动帮忙点一次。
  function csTryClickPendingTab() {
    if (window.__csPendingTabTried) return;
    if (typeof lastOrderCount === 'number' && lastOrderCount >= 0) return; // 已经读到数字，不用点
    try {
      const words = ['待发货', '待发货订单'];
      const nodes = document.querySelectorAll('li, a, button, [role="tab"], [class*="tab"], [class*="menu-item"]');
      for (const el of nodes) {
        const txt = String((el && (el.innerText || el.textContent)) || '').trim();
        if (!txt || txt.length > 12) continue;
        let hit = false;
        for (const w of words) { if (txt.indexOf(w) >= 0) { hit = true; break; } }
        if (!hit) continue;
        const st = window.getComputedStyle(el);
        if (!st || st.display === 'none' || st.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;
        window.__csPendingTabTried = true;
        el.click();
        setTimeout(checkOrderCount, 2500);
        return;
      }
    } catch (e) {}
  }

  // v18: 京东订单页第一次打开常出现「数据异常，请刷新重试」，自动刷新一次即可。
  //      只重试一次，避免死循环。
  function csAutoReloadOnce() {
    // v20: 只给京东用。抖店等平台的「待发货」是要自己点页签才切过去的（网址里没有 tab 参数），
    //      一刷新就退回默认页，待发货数字就没了 —— 所以别的平台一律不自动刷新。
    if (!platformConfig || platformConfig.platformId !== 'jd') return;
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
  // v19: 订单页诊断 —— 主界面问，这里答
  ipcRenderer.on('cs-order-debug-request', () => {
    try { ipcRenderer.sendToHost('cs-order-debug', csOrderDebug()); } catch (e) {}
  });

  ipcRenderer.on('cs-init-config', (event, config) => {
    platformConfig = config;
    // v11 Phase D: 订单页 webview 启动 90s 待发货数字轮扫（客服页无 orderUnreadKeyword 自动跳过）
    if (config && Array.isArray(config.orderUnreadKeyword) && config.orderUnreadKeyword.length) {
      // v20: SPA 页面渲染慢，只在 dom-ready 扫一次经常扫空。前 30 秒多扫几次。
      [0, 4000, 9000, 18000, 30000].forEach(function (ms) { setTimeout(checkOrderCount, ms); });
      setInterval(checkOrderCount, 90000);
      // v20: 扫不到数字时，自动点一下「待发货」页签（抖店等平台必须要点）
      [6000, 20000].forEach(function (ms) { setTimeout(csTryClickPendingTab, ms); });
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
