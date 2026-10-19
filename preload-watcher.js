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
  let lastOrderWhy = '';   // v21: 记录这个数字是从哪儿抓来的，方便排查抓错

  // v21: 递归收集所有能读到的文档（页面正文 + 内嵌框架，最多 3 层）。
  //      很多商家后台是「页面套框架、框架里再套框架」，只扫一层永远读不到。
  function collectReadableDocs(depth, seen) {
    const out = [];
    if (depth > 3) return out;
    try { if (document.body) out.push(document.body); } catch (e) {}
    let frames = [];
    try { frames = Array.prototype.slice.call(document.querySelectorAll('iframe')); } catch (e) {}
    for (const f of frames) {
      let d = null;
      try { d = f.contentDocument; } catch (e) { d = null; } // 跨域会抛异常，跳过
      if (!d || !d.body) continue;
      if (seen.indexOf(d) >= 0) continue;
      seen.push(d);
      const inner = [];
      let ifr = [];
      try { ifr = Array.prototype.slice.call(d.querySelectorAll('iframe')); } catch (e) {}
      for (const g of ifr) {
        let gd = null;
        try { gd = g.contentDocument; } catch (e) { gd = null; }
        if (gd && gd.body && seen.indexOf(gd) < 0) { seen.push(gd); inner.push(gd.body); }
      }
      out.push(d.body);
      for (const b of inner) { if (out.indexOf(b) < 0) out.push(b); }
    }
    return out;
  }

  function visibleText(el) {
    try {
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return '';
      return String(el.innerText || '').trim();
    } catch (e) { return ''; }
  }

  // v21: 给「数字候选」打分，取分最高的那个。
  //      之前是「碰到第一个数字就用」—— 抖店读数错误就是这么来的：
  //      抓到了别的页签上的数字。
  function collectNumberCandidates(el, keywords) {
    const cands = [];
    const own = visibleText(el);
    const lines = own.split('\n').map((x) => x.trim()).filter(Boolean);

    // ① 关键词「最近」的数字（最可信）。
    //      注意不能简单取「这一行第一个数字」—— 一行里可能是
    //      「全部 99  待付款 7  待发货 3」，取第一个就变成 99 了（抖店就栽在这）。
    //      所以：先找关键词位置，优先取它【后面】的数字，没有再取【前面紧挨着】的。
    // v22: 以前只要求「数字在关键词后面」，不管隔了多远 ——
    //      淘宝那一行是「待发货 即将超时 已发货 …」，中间隔了十几个字，
    //      结果抓到了后面别的状态的数字（明明 0 单待发货，却显示成 3 单）。
    //      现在要求数字必须【紧贴】关键词：中间只允许空格、括号、冒号之类，最多 6 个。
    const GAP = /^[\s()（）\[\]【】〔〕:：、,.，。\u00b7\uff0d\u2014-]{0,6}(\d[\d,]*)/;
    for (const line of lines) {
      const afterHits = [];
      let beforeTail = null;
      for (const k of keywords) {
        let from = 0;
        for (;;) {
          const pos = line.indexOf(k, from);
          if (pos < 0) break;
          from = pos + 1;
          const tail = line.slice(pos + k.length);
          const an = tail.match(GAP);
          if (an) afterHits.push({ n: parseInt(an[1].replace(/,/g, ''), 10) || 0, why: '词后:' + k + tail.slice(0, 12) });
          // 数字在前面的写法（「3 单待发货」）：只认关键词前面【紧挨着】的那一个，
          //  中间最多夹个「单 / 笔 / 个 / 条 / 件」量词；隔了别的字就不算。
          const bn = line.slice(0, pos).slice(-8).match(/(\d[\d,]*)\s*[\u5355\u7b14\u4e2a\u6761\u4ef6]?\s*$/);
          if (bn) beforeTail = { n: parseInt(bn[1].replace(/,/g, ''), 10) || 0, why: '词前:' + line.slice(Math.max(0, pos - 16), pos) };
        }
      }
      // 同一个地方可能既匹配到 0 又匹配到别的数（比如「待发货订单」和「待发货」），
      // 优先认不是 0 的那个；要是全都是 0，那 0 本身就是答案。
      let pick = afterHits.filter(function (h) { return h.n > 0; })[0] || afterHits[0] || beforeTail;
      if (pick) cands.push({ n: pick.n, score: (pick === beforeTail ? 70 : 100), why: pick.why });
    }
    // ② 带 badge / count / num 这类字样的小徽标（可信）
    let badges = [];
    try { badges = Array.prototype.slice.call(el.querySelectorAll('[class*="badge"], [class*="count"], [class*="num"], sup')); } catch (e) {}
    for (const b of badges) {
      const bt = visibleText(b);
      if (/^\d{1,7}$/.test(bt)) cands.push({ n: parseInt(bt, 10) || 0, score: 80, why: '徽标:' + bt });
    }
    // ③ 紧挨着的兄弟节点里孤零零一个数字
    const sib = [];
    try {
      if (el.nextElementSibling) sib.push(el.nextElementSibling);
      if (el.previousElementSibling) sib.push(el.previousElementSibling);
    } catch (e) {}
    for (const s of sib) {
      const st = visibleText(s);
      if (/^\d{1,7}$/.test(st)) cands.push({ n: parseInt(st, 10) || 0, score: 60, why: '相邻:' + st });
      const m2 = st.match(/(\d[\d,]*)\s*单/);
      if (m2) cands.push({ n: parseInt(m2[1].replace(/,/g, ''), 10) || 0, score: 55, why: '相邻单:' + st.slice(0, 16) });
    }
    // ④ 自己的直接子节点里孤零零一个数字
    try {
      for (let ci = 0; ci < el.children.length && ci < 8; ci++) {
        const ct = visibleText(el.children[ci]);
        if (/^\d{1,7}$/.test(ct)) cands.push({ n: parseInt(ct, 10) || 0, score: 50, why: '子节点:' + ct });
      }
    } catch (e) {}
    // ⑤ 兜底：整块文字里的数字（最不可信，只有上面都没有时才轮到它）
    // v22: 兜底也不能乱来。淘宝那一大块订单明细里也含「待发货」三个字，
    //      直接取第一个数字，就把订单行里的数当成待发货数了（0 单显示成 3 单）。
    //      现在要求：这一小块文字本身就含关键词、而且不长（顶多是个页签），才认。
    let ownHasKw = false;
    for (const k of keywords) { if (own.indexOf(k) >= 0) { ownHasKw = true; break; } }
    if (ownHasKw && own.length <= 60) {
      // 兜底也得「紧贴」：整块文字里找「关键词 + 最多 6 个分隔符 + 数字」。
      // 这么一来，跨行也能认（「待发货」和「3」分在两行），但隔了别的字还是不认。
      for (const k of keywords) {
        let from = 0;
        for (;;) {
          const pos = own.indexOf(k, from);
          if (pos < 0) break;
          from = pos + 1;
          const m = own.slice(pos + k.length).match(GAP);
          if (m) {
            cands.push({ n: parseInt(m[1].replace(/,/g, ''), 10) || 0, score: 20, why: '兜底:' + k + own.slice(pos + k.length, pos + k.length + 12) });
            break;
          }
        }
      }
    }
    return cands;
  }

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
      let txt = '';
      try { txt = visibleText(el); } catch (e) { continue; }
      if (!txt || txt.length > 80) continue;
      let hit = false;
      for (const k of keywords) { if (txt.indexOf(k) >= 0) { hit = true; break; } }
      if (hit) hitEls.push({ el: el, txt: txt });
    }
    // 文字越短的元素越「专一」，优先看它
    hitEls.sort((a, b) => a.txt.length - b.txt.length);

    let best = null;
    for (const h of hitEls) {
      if (!foundKeyword) {
        for (const k of keywords) { if (h.txt.indexOf(k) >= 0) { foundKeyword = k; break; } }
        snippet = h.txt.replace(/\s+/g, ' ').slice(0, 50);
      }
      for (const c of collectNumberCandidates(h.el, keywords)) {
        // 同分时，元素文字越短越可信
        const score = c.score - Math.min(15, Math.floor(h.txt.length / 4));
        if (!best || score > best.score) best = { n: c.n, score: score, why: c.why };
      }
    }
    if (best) return { count: best.n, foundKeyword: foundKeyword, snippet: snippet, why: best.why };
    return { count: -1, foundKeyword: foundKeyword, snippet: snippet };
  }

  function scanOrderPendingCount() {
    let keywords = (platformConfig && Array.isArray(platformConfig.orderUnreadKeyword) && platformConfig.orderUnreadKeyword.length)
      ? platformConfig.orderUnreadKeyword.slice()
      : ['待发货'];
    // v19: 各平台叫法不一样，多补几个常见说法
    ['待发货订单', '未发货', '待处理发货', '待出库', '待备货', '待发货数'].forEach(function (k) {
      if (keywords.indexOf(k) < 0) keywords.push(k);
    });

    // v21: 递归收集（页面套框架、框架套框架都能扫到）
    let roots = [];
    try { roots = collectReadableDocs(0, []); } catch (e) { roots = []; }
    if (!roots.length) { try { if (document.body) roots = [document.body]; } catch (e) {} }

    let foundKeyword = null;
    let snippet = '';
    let why = '';
    for (const root of roots) {
      const r = scanRootForOrder(root, keywords);
      if (typeof r.count === 'number' && r.count >= 0) {
        lastOrderKeyword = r.foundKeyword || '';
        lastOrderSnippet = r.snippet || '';
        lastOrderWhy = r.why || '';
        return r.count;
      }
      if (r.foundKeyword && !foundKeyword) { foundKeyword = r.foundKeyword; snippet = r.snippet; }
    }
    lastOrderKeyword = foundKeyword || '';
    lastOrderSnippet = snippet || '';
    lastOrderWhy = why || '';
    // 页面上确实写着「待发货」，只是旁边没数字 —— 那基本就是 0 单
    if (foundKeyword) return 0;
    return -1;
  }

  // v19: 把订单页的真实情况报回去，方便远程定位「读取中」到底卡在哪
  function csOrderDebug() {
    const d = {
      url: '', title: '', bodyLen: 0, iframes: 0, sameOriginIframes: 0,
      keyword: lastOrderKeyword || '', snippet: lastOrderSnippet || '',
      why: lastOrderWhy || '',
      loginRequired: false,
      lastCount: (typeof lastOrderCount === 'number' ? lastOrderCount : -1),
      frames: [], hints: []
    };
    try { d.url = location.href || ''; } catch (e) {}
    try { d.title = document.title || ''; } catch (e) {}
    try { d.iframes = document.querySelectorAll('iframe').length; } catch (e) {}

    // v21: 把每一个能读到的文档的正文前 300 字都报回来 ——
    //      光看「有没有待发货」没法定位，必须看见页面上到底写了什么。
    let docs = [];
    try { docs = collectReadableDocs(0, []); } catch (e) {}
    try { d.sameOriginIframes = Math.max(0, docs.length - 1); } catch (e) {}
    docs.slice(0, 4).forEach(function (bd, i) {
      let t = '';
      try { t = String(bd.innerText || ''); } catch (e) {}
      d.frames.push({ i: i, len: t.length, text: t.replace(/\s+/g, ' ').slice(0, 300) });
      if (i === 0) d.bodyLen = t.length;
    });

    // v21: 把所有含「发货 / 待 / 订单 / 单」的短片段列出来（最多 40 条），
    //      这样就算关键词没命中，也能一眼看出页面上用的是什么词。
    const want = /发货|待|订单|出库|备货/;
    const seen = {};
    for (const bd of docs) {
      let nodes = [];
      try { nodes = Array.prototype.slice.call(bd.querySelectorAll('*')); } catch (e) {}
      for (const el of nodes) {
        if (d.hints.length >= 40) break;
        if (el.children && el.children.length > 0) continue; // 只看最里层的文字节点
        let t = '';
        try { t = String(el.innerText || el.textContent || '').trim(); } catch (e) { continue; }
        if (!t || t.length > 24 || !want.test(t)) continue;
        if (seen[t]) continue;
        seen[t] = 1;
        d.hints.push(t);
      }
      if (d.hints.length >= 40) break;
    }

    // v22: 把每个内嵌框架的来历也报出来。微信小店的订单列表就装在里面，
    //      可一直读到的是空的 —— 得知道它的网址和类名才有的放矢。
    d.iframeInfo = [];
    try {
      const fl = Array.prototype.slice.call(document.querySelectorAll('iframe'));
      for (let i = 0; i < fl.length && i < 8; i++) {
        const f = fl[i];
        let ok = false, len = 0, fsrc = '', fid = '', fcls = '';
        try { fsrc = String(f.src || ''); } catch (e) {}
        try { fid = String(f.id || ''); } catch (e) {}
        try { fcls = String(f.className || ''); } catch (e) {}
        try {
          ok = !!(f.contentDocument && f.contentDocument.body);
          if (ok) len = String(f.contentDocument.body.innerText || '').length;
        } catch (e) { ok = false; }
        d.iframeInfo.push({ src: fsrc.slice(0, 120), id: fid.slice(0, 40), cls: fcls.slice(0, 60), readable: ok, len: len });
      }
    } catch (e) {}
    try { d.loginRequired = csOrderLoginRequired(); } catch (e) {}
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
      // v22: 刚刷新完那一会儿，页面可能半渲染，数字忽大忽小 ——
      //      这段时间读到什么都先不往外报，免得仪表盘乱跳、还误弹「有新订单」。
      if (Date.now() < orderFreezeUntil) return;
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
  // ─────────────────────────────────────────────────────────────────────────
  // v22: 订单页自动刷新
  //   抖店来了新订单，页面自己不动，扫到的数字也不变 ——
  //   仪表盘不更新、也不弹「有新订单」提醒（提醒是靠数字变大了才触发的）。
  //
  //   注意不能简单 location.reload()：抖店的「待发货」是点页签切过去的，
  //   一重载就退回默认页，待发货的数字反而没了。所以优先点页面上的「刷新」按钮。
  // ─────────────────────────────────────────────────────────────────────────
  let lastUserActionAt = 0;
  function csMarkUserAction() { lastUserActionAt = Date.now(); }
  ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    try { window.addEventListener(ev, csMarkUserAction, { passive: true, capture: true }); } catch (e) {}
  });

  const ORDER_REFRESH_MS = 180000; // 3 分钟重新查一次
  let orderFreezeUntil = 0;        // 刷新后的静默期：这段时间读到什么都不往外报

  // 找页面上的「刷新」按钮；找不到就用「查询 / 搜索」；避开重置、导出之类
  function csFindRefreshButton() {
    const badWords = ['重置', '清空', '导出', '下载', '打印', '新建', '添加', '删除', '登录', '退出'];
    let fallback = null;
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="refresh"]')); } catch (e) { return null; }
    for (const el of nodes) {
      let t = '';
      try { t = String((el.innerText || el.textContent) || '').trim(); } catch (e) { continue; }
      if (!t || t.length > 8) continue;
      let bad = false;
      for (const b of badWords) { if (t.indexOf(b) >= 0) { bad = true; break; } }
      if (bad) continue;
      let st = null;
      try { st = window.getComputedStyle(el); } catch (e) {}
      if (!st || st.display === 'none' || st.visibility === 'hidden') continue;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) {}
      if (!r || r.width < 16 || r.height < 10) continue;
      if (t.indexOf('刷新') >= 0) return el;
      if (!fallback && t.indexOf('查询') >= 0) fallback = el;
    }
    return fallback;
  }

  function csOrderAutoRefresh() {
    try {
      if (!platformConfig) return;
      if (!Array.isArray(platformConfig.orderUnreadKeyword) || !platformConfig.orderUnreadKeyword.length) return;
      // 页面没加载完 / 窗口不可见（这个网页没在眼前）—— 都不动
      if (document.readyState !== 'complete') return;
      try { if (document.visibilityState === 'hidden') return; } catch (e) {}
      // 用户正在输入 —— 绝不打断
      const ae = document.activeElement;
      if (ae) {
        const tag = String(ae.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || ae.isContentEditable) return;
      }
      // 用户 45 秒内刚动过鼠标键盘 —— 等他忙完
      if (lastUserActionAt && Date.now() - lastUserActionAt < 45000) return;

      const btn = csFindRefreshButton();
      window.__csPendingTabTried = false; // 刷新完允许重新点「待发货」页签
      if (btn) {
        orderFreezeUntil = Date.now() + 25000;
        btn.click();
        [5000, 12000, 26000].forEach(function (ms) { setTimeout(checkOrderCount, ms); });
        [8000, 20000].forEach(function (ms) { setTimeout(csTryClickPendingTab, ms); });
      } else {
        // 没有刷新按钮只能整页重载；多静默一会儿，等重新点回「待发货」页签
        orderFreezeUntil = Date.now() + 45000;
        location.reload();
      }
    } catch (e) {}
  }

  function csTryClickPendingTab() {
    if (window.__csPendingTabTried) return;
    // v22: 以前只要读到「任意一个」数字就不再点页签了 —— 淘宝读到个错的 3，
    //      就再也不去点「待发货」页签，错的数一直挂着没人纠正。
    //      现在只有读到【紧贴关键词】的数字（来源标着「词后」）才算数，其余照样点。
    if (typeof lastOrderCount === 'number' && lastOrderCount >= 0 && /^\u8bcd\u540e/.test(lastOrderWhy || '')) return;
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
      // v21: 京东那种页面正文只有 36 字（还没渲染完），要多给它点时间
      [0, 4000, 9000, 18000, 30000, 45000, 60000, 90000].forEach(function (ms) { setTimeout(checkOrderCount, ms); });
      setInterval(checkOrderCount, 90000);
      // v20: 扫不到数字时，自动点一下「待发货」页签（抖店等平台必须要点）
      [6000, 20000, 45000].forEach(function (ms) { setTimeout(csTryClickPendingTab, ms); });
      // v22: 抖店来了新订单页面自己不动，数字不变，仪表盘不更新也不提醒。
      //      所以每 3 分钟让订单页重新查一次（具体做法见 csOrderAutoRefresh）。
      setInterval(csOrderAutoRefresh, ORDER_REFRESH_MS);
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
