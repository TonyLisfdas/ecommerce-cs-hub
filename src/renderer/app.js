/**
 * app.js - 聚客宝·八大电商平台聚合客服工作台 前端核心控制器
 * 同时支持：
 * 1. Windows Electron 桌面端真实 <webview> 独立沙箱容器模式 + Win32 千牛接待窗嵌入
 * 2. 浏览器在线高保真交互预览模式（完整还原8大平台原版客服布局、来消息标签页变色闪烁+WebAudio合成提示音、纯净客服去后台切换、账密自动填充）
 */

(function () {
  const isElectron = Boolean(window.csElectronAPI && window.csElectronAPI.isElectron);
  const platforms = window.PLATFORMS || [];
  const platformMap = {};
  platforms.forEach((p) => {
    platformMap[p.id] = p;
  });

  // 应用全局状态
  let appState = null;
  let watcherPreloadPath = '';
  let isWindowsOS = true;
  let autoStreamTimer = null;

  // 每个店铺运行时的未读数、闪烁状态与会话数据
  const runtimeShops = {};
  // v11 Phase D/E: 订单仪表盘 + 新订单提醒 运行时状态
  const orderCounts = {}; // shopId → 待发货 count (-1=未读到, 0=无, >0=有)
  let orderDashVisible = false;


  // ============================================================================
  // 1. Web Audio API 零依赖客服提示音合成器（叮咚声 / 水晶铃 / 急促多巴胺提醒）
  // ============================================================================
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playAlertChime(toneType) {
    const tone = toneType || (appState?.soundSettings?.tone) || 'dingdong';
    if (tone === 'mute') return;

    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      if (tone === 'dingdong') {
        // 经典千牛/飞鸽风格“叮-咚”双音
        playNote(ctx, 987.77, now, 0.16, 'sine', 0.35);       // B5 叮
        playNote(ctx, 783.99, now + 0.16, 0.32, 'sine', 0.38); // G5 咚
      } else if (tone === 'crystal') {
        // 清脆水晶三连琶音
        playNote(ctx, 1046.5, now, 0.12, 'triangle', 0.3);        // C6
        playNote(ctx, 1318.5, now + 0.11, 0.12, 'triangle', 0.3); // E6
        playNote(ctx, 1567.98, now + 0.22, 0.28, 'sine', 0.35);   // G6
      } else if (tone === 'urgent') {
        // 高峰期防漏单急促双脉冲提示音
        playNote(ctx, 880, now, 0.09, 'square', 0.2);
        playNote(ctx, 1174.66, now + 0.1, 0.09, 'square', 0.22);
        playNote(ctx, 880, now + 0.22, 0.09, 'square', 0.2);
        playNote(ctx, 1318.5, now + 0.32, 0.18, 'square', 0.25);
      }
    } catch (err) {
      console.warn('音频播放受限:', err);
    }
  }

  function playNote(ctx, freq, startTime, duration, waveType, peakGain) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveType || 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  // ============================================================================
  // 2. 初始化状态加载（兼容 Electron IPC 与浏览器 LocalStorage）
  // ============================================================================
  function buildDefaultBrowserState() {
    const shops = platforms.map((p, idx) => ({
      id: `shop_${p.id}_1`,
      platformId: p.id,
      shopName: `${p.shortName}·主营1店`,
      customUrl: p.url,
      partition: `persist:shop_${p.id}_1`,
      cleanMode: true,
      autoFill: true,
      autoSubmit: false,
      muted: false,
      username: `${p.id}_kefu01`,
      password: '••••••••••',
      order: idx
    }));

    return {
      shops,
      activeShopId: shops[0].id,
      soundSettings: {
        enabled: true,
        tone: 'dingdong',
        volume: 0.85,
        flashTaskbar: true,
        desktopNotification: true
      },
      quickReplies: [
        { id: 'qr1', category: '发货物流', title: '当天闪电发货', text: '亲，咱们家现货每天16:00前拍下都是当天安排发出的哦，正常2-3天就能收到啦~' },
        { id: 'qr2', category: '尺码导购', title: '身高体重核码', text: '亲，您可以发一下身高、体重以及平时常穿尺码，我帮您对照尺码表精准推荐哈！' },
        { id: 'qr3', category: '改地址', title: '优先拦截改址', text: '收到亲！只要快递还没揽收，我现在马上帮您在系统里修改收货地址，请稍等1分钟~' },
        { id: 'qr4', category: '售后保障', title: '7天无理由+运费险', text: '亲放心拍，咱们店铺赠送运费险且支持7天无理由退换，不满意随时可退换，退货运费自动理赔！' },
        { id: 'qr5', category: '催付转化', title: '库存紧张锁单提醒', text: '亲，您看中的这款目前活动库存只剩最后几件啦，现在拍下还能赠运费险并优先打包发出哦~' },
        { id: 'qr6', category: '发票说明', title: '电子专票/普票登记', text: '亲，咱们支持开具正规电子增值税普票/专票，您把【发票抬头+税号】发我，我给您备注登记！' }
      ]
    };
  }

  async function initApp() {
    if (isElectron) {
      const data = await window.csElectronAPI.getInitialData();
      appState = data.state;
      watcherPreloadPath = data.watcherPreloadPath;
      isWindowsOS = data.isWindows;
      window.csElectronAPI.onFocusShopTab(({ shopId }) => {
        if (shopId) switchToShopTab(shopId);
      });
      if (window.csElectronAPI.onFocusOrderTab) {
        window.csElectronAPI.onFocusOrderTab(({ platformName }) => {
          const plat = platforms.find((x) => x.shortName === platformName);
          if (plat) {
            const shop = appState.shops.find((x) => x.platformId === plat.id);
            if (shop) { switchToShopTab(shop.id); switchShopSubTab(shop, 'order'); }
          }
        });
      }
    } else {
      const saved = localStorage.getItem('cs_hub_browser_state_v1');
      if (saved) {
        try {
          appState = JSON.parse(saved);
        } catch (e) {
          appState = buildDefaultBrowserState();
        }
      } else {
        appState = buildDefaultBrowserState();
      }
    }

    groupShopsByPlatform(appState.shops); // 同平台店铺自动聚拢相邻
    // 初始化每个店铺的运行时会话数据
    appState.shops.forEach((shop) => {
      initShopRuntime(shop);
    });

    populateAddShopPlatformSelect();
    renderAllTabs();
    renderAllShopPanes();
    switchToShopTab(appState.activeShopId || appState.shops[0]?.id);
    // ★ 创建拖拽指示器 DOM（竖线 #tabDropIndicator + ghost #tabDragGhost）
    if (!document.getElementById('tabDropIndicator')) {
      const ind = document.createElement('div');
      ind.id = 'tabDropIndicator';
      document.body.appendChild(ind);
    }
    if (!document.getElementById('tabDragGhost')) {
      const gh = document.createElement('div');
      gh.id = 'tabDragGhost';
      document.body.appendChild(gh);
    }
    bindToolbarEvents();
    bindOrderDashboardEvents(); // v11 Phase D/E 订单仪表盘 + 新订单提醒

  }

  function persistState() {
    if (isElectron) {
      window.csElectronAPI.saveState(appState);
    } else {
      localStorage.setItem('cs_hub_browser_state_v1', JSON.stringify(appState));
    }
  }

  function initShopRuntime(shop) {
    if (runtimeShops[shop.id]) return;
    const plat = platformMap[shop.platformId] || platforms[0];
    const buyers = (plat.sampleBuyers || []).map((b, i) => ({
      id: `${shop.id}_buyer_${i}`,
      name: b.name,
      avatar: b.avatar,
      time: b.time,
      orderNo: b.orderNo,
      product: b.product,
      price: b.price,
      unread: i === 0 ? 1 : 0,
      messages: [
        { sender: 'buyer', text: b.msg, time: b.time }
      ]
    }));

    runtimeShops[shop.id] = {
      unreadCount: 0,
      flashing: false,
      activeBuyerIdx: 0,
      buyers,
      useRealWebviewInElectron: isElectron
    };
  }

  // ============================================================================
  // ============================================================================ 
  // 2.5 同平台聚合 + 标签拖拽换位 + Windows 原生窗口内嵌控制条
  // ============================================================================ 
  function groupShopsByPlatform(shops) {
    if (!Array.isArray(shops) || shops.length === 0) return shops;
    const platOrder = platforms.map((p) => p.id);
    shops.forEach((s) => { if (!platOrder.includes(s.platformId)) platOrder.push(s.platformId); });
    shops.sort((a, b) => {
      const ia = platOrder.indexOf(a.platformId), ib = platOrder.indexOf(b.platformId);
      if (ia !== ib) return ia - ib;
      return (a.order == null ? 0 : a.order) - (b.order == null ? 0 : b.order);
    });
    shops.forEach((s, i2) => { s.order = i2; });
    return shops;
  }

  // ★ 测试钩子：暴露给外部调用，等价于拖拽完成时的重排逻辑
  window.__switchTab = function (shopId) { switchToShopTab(shopId); };

  window.__doReorder = function (shopId, insertIndex) {
    const fromIdx = appState.shops.findIndex((x) => x.id === shopId);
    if (fromIdx < 0) return;
    const [moved] = appState.shops.splice(fromIdx, 1);
    let toIdx = insertIndex;
    if (fromIdx < insertIndex) toIdx--;
    if (toIdx < 0) toIdx = 0;
    if (toIdx > appState.shops.length) toIdx = appState.shops.length;
    appState.shops.splice(toIdx, 0, moved);
    appState.shops.forEach((x, i) => { x.order = i; });
    renderAllTabs();
    renderAllShopPanes();
    persistState();
  };

  function moveShopTab(fromId, toId) {
    const from = appState.shops.find((s) => s.id === fromId);
    const to = appState.shops.find((s) => s.id === toId);
    if (!from || !to || from.id === to.id) return;
    const fi = appState.shops.indexOf(from);
    appState.shops.splice(fi, 1);
    const ti = appState.shops.indexOf(to);
    appState.shops.splice(ti, 0, from);
    appState.shops.forEach((s, i2) => { s.order = i2; });
    renderAllTabs();
    persistState();
  }

  // ★ 轻量原地更新标签页状态（不清空 innerHTML、不重建 DOM 节点）
  function updateTabBadgesInPlace() {
    if (!appState || !appState.shops) return;
    let totalUnread = 0;
    appState.shops.forEach((shop) => {
      const rt = runtimeShops[shop.id];
      const tabEl = document.getElementById('tab_' + shop.id);
      if (!tabEl) return;
      totalUnread += (rt && rt.unreadCount) || 0;
      tabEl.classList.toggle('active', shop.id === appState.activeShopId);
      tabEl.classList.toggle('tab-flashing', !!(rt && rt.flashing));
      const badge = tabEl.querySelector('.tab-unread-badge');
      if (badge) {
        const unread = (rt && rt.unreadCount) || 0;
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.classList.toggle('hidden', unread === 0);
      }
    });
    const gc = document.getElementById('globalUnreadCount');
    if (gc) gc.textContent = String(totalUnread);
  }

  // 3. 渲染顶部多店铺标签栏（含未读红点与变色呼吸闪烁状态）
  // ============================================================================
  function renderAllTabs() {
  if (window.__renderTabsLock) return; window.__renderTabsLock = true;
  try {
    const container = document.getElementById('tabsScrollArea');
    container.innerHTML = '';

    let totalUnread = 0;

    appState.shops.forEach((shop) => {
      initShopRuntime(shop);
      const plat = platformMap[shop.platformId] || platforms[0];
      const rt = runtimeShops[shop.id];
      totalUnread += rt.unreadCount || 0;

      const tabEl = document.createElement('div');
      tabEl.className = `shop-tab ${shop.id === appState.activeShopId ? 'active' : ''} ${rt.flashing ? 'tab-flashing' : ''}`;
      tabEl.id = `tab_${shop.id}`;
      tabEl.style.setProperty('--platform-color', plat.color);

      const hasSavedCred = Boolean(shop.username);
      tabEl.innerHTML = `
        <div class="tab-platform-icon" style="background:${plat.color};">${plat.iconText}</div>
        <div class="tab-title-wrap">
          <span class="tab-shop-name">${escapeHtml(shop.shopName)}</span>
          <span class="tab-platform-sub">${plat.shortName} · ${hasSavedCred ? '已存账密' : '独立沙箱'}</span>
        </div>
        <span class="tab-status-dot" title="客服长连接在线"></span>
        <span class="tab-unread-badge ${rt.unreadCount > 0 ? '' : 'hidden'}">${rt.unreadCount > 99 ? '99+' : rt.unreadCount}</span>
        ${appState.shops.length > 1 ? `<span class="tab-close-btn" data-close-id="${shop.id}" title="关闭此店铺标签页">✕</span>` : ''}
      `;

      // ★ 灵敏拖拽：点击(< 5px)切换 / 按住(>= 5px)拖动换位（竖线指示器 + ghost 残影 + pointer-events 屏蔽 webview）
      tabEl.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        if (ev.target.getAttribute && ev.target.getAttribute('data-close-id')) return;
        const startX = ev.clientX;
        const startY = ev.clientY;
        let dragging = false;
        let insertIndex = -1;

        function getInsertIndex(cx) {
          const allTabs = Array.from(document.querySelectorAll('#tabsScrollArea .shop-tab'));
          for (let i = 0; i < allTabs.length; i++) {
            const r = allTabs[i].getBoundingClientRect();
            const mid = r.left + r.width / 2;
            if (cx < mid) return i;
          }
          return allTabs.length;
        }

        function showIndicator(cx) {
          const tabs = document.querySelectorAll('#tabsScrollArea .shop-tab');
          if (!tabs.length) return;
          let idx = getInsertIndex(cx);
          insertIndex = idx;
          // 竖线定位
          const ind = document.getElementById('tabDropIndicator');
          if (!ind) return;
          if (idx === 0) {
            ind.style.left = (tabs[0].getBoundingClientRect().left - 2) + 'px';
          } else if (idx >= tabs.length) {
            const last = tabs[tabs.length - 1];
            const lr = last.getBoundingClientRect();
            ind.style.left = (lr.right + 2) + 'px';
          } else {
            ind.style.left = (tabs[idx].getBoundingClientRect().left - 2) + 'px';
          }
          const tabbar = document.querySelector('.tabs-scroll-area');
          if (tabbar) {
            const br = tabbar.getBoundingClientRect();
            ind.style.top = (br.top + 2) + 'px';
            ind.style.height = (br.height - 4) + 'px';
          }
          ind.style.display = 'block';
        }

        function onMove(me) {
          if (!dragging) {
            if (Math.abs(me.clientX - startX) < 5 && Math.abs(me.clientY - startY) < 5) return;
            dragging = true;
            // 屏蔽 webview 区域，防止鼠标进 webview 后收不到 mousemove
            const stage = document.getElementById('webviewsStage');
            if (stage) stage.style.pointerEvents = 'none';
            document.body.style.cursor = 'grabbing';
            tabEl.classList.add('tab-dragging');
            // ghost
            const g = document.getElementById('tabDragGhost');
            if (g) {
              g.innerHTML = tabEl.innerHTML;
              g.style.width = tabEl.offsetWidth + 'px';
              g.style.display = 'block';
            }
          }
          // ghost 跟随
          const g = document.getElementById('tabDragGhost');
          if (g) {
            g.style.left = (me.clientX + 8) + 'px';
            g.style.top = (me.clientY - 18) + 'px';
          }
          showIndicator(me.clientX);
          me.preventDefault();
        }

        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          tabEl.classList.remove('tab-dragging');
          // 恢复 webview
          const stage = document.getElementById('webviewsStage');
          if (stage) stage.style.pointerEvents = '';
          // 隐藏指示器 + ghost
          const ind = document.getElementById('tabDropIndicator');
          if (ind) ind.style.display = 'none';
          const g = document.getElementById('tabDragGhost');
          if (g) g.style.display = 'none';
          if (dragging && insertIndex >= 0) {
            // 按 insertIndex 移动 appState.shops
            const fromIdx = appState.shops.findIndex((x) => x.id === shop.id);
            const [moved] = appState.shops.splice(fromIdx, 1);
            let toIdx = insertIndex;
            if (fromIdx < insertIndex) toIdx--; // 数组缩短后索引前移
            if (toIdx < 0) toIdx = 0;
            if (toIdx > appState.shops.length) toIdx = appState.shops.length;
            appState.shops.splice(toIdx, 0, moved);
            appState.shops.forEach((x2, i2) => { x2.order = i2; });
            renderAllTabs();
            renderAllShopPanes();
            persistState();
          } else if (!dragging) {
            switchToShopTab(shop.id);
          }
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      // 关闭按钮（独立 click，不影响拖拽）
      const _closeBtn = tabEl.querySelector('.tab-close-btn');
      if (_closeBtn) _closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeShopTab(shop.id); });
      container.appendChild(tabEl);
    });

    const globalCountEl = document.getElementById('globalUnreadCount');
    if (globalCountEl) {
      globalCountEl.textContent = String(totalUnread);
    }
  } finally { window.__renderTabsLock = false; }
  }

  // ============================================================================
  // 4. 渲染每个店铺的主工作台面板（Electron真实<webview> + 原版高保真交互工作台）
  // ============================================================================
  function renderAllShopPanes() {
    const stage = document.getElementById('webviewsStage');
    // 保留已创建的pane避免重载，只补齐新店铺pane
    appState.shops.forEach((shop) => {
      if (!document.getElementById(`pane_${shop.id}`)) {
        const pane = createShopPaneElement(shop);
        stage.appendChild(pane);
      }
    });
  }

  // ============================================================================
  // v11 Phase C: 客服/订单 横排子标签（两个 webview 常驻，同 partition 共享 Cookie）
  // ============================================================================
  function buildShopWebview(id, srcUrl, shop, plat, kind) {
    const webview = document.createElement('webview');
    webview.id = id;
    webview.className = 'shop-webview';
    webview.setAttribute('src', srcUrl);
    webview.setAttribute('partition', shop.partition); // ★ 客服与订单同分区：登录一次两边通用
    webview.setAttribute('allowpopups', 'true');
    if (watcherPreloadPath) webview.setAttribute('preload', watcherPreloadPath);
    webview.dataset.kind = kind;

    webview.addEventListener('dom-ready', () => {
      webview.send('cs-init-config', {
        platformId: plat.id,
        cleanModeEnabled: shop.cleanMode,
        cleanCss: plat.cleanCss,
        unreadSelectors: plat.unreadSelectors,
        loginSelectors: plat.loginSelectors,
        autoFillOnLoad: shop.autoFill,
        credentials: { username: shop.username || '', password: shop.password || '', autoSubmit: shop.autoSubmit },
        orderUnreadKeyword: plat.orderUnreadKeyword || []
      });
    });

    // 抖店未登录卡死兜底（客服页 8s 仍停在 im 域 → 跳登录页，每个 webview 生命周期只跳 1 次）
    if (kind === 'cs' && plat.id === 'douyin') {
      let hasFallbackToLogin = false;
      setTimeout(() => {
        if (!hasFallbackToLogin && (webview.getURL() || '').indexOf('im.jinritemai.com') !== -1) {
          hasFallbackToLogin = true;
          webview.loadURL('https://fxg.jinritemai.com/login/common');
        }
      }, 8000);
    }

    // 消息感知只挂客服 webview（订单页不产生买家消息）
    if (kind === 'cs') {
      webview.addEventListener('ipc-message', (event) => {
        if (event.channel === 'cs-incoming-alert') {
          const payload = event.args[0] || {};
          handleIncomingMessageAlert(shop.id, payload.title || '买家新消息', payload.body || '请及时接待回复');
        } else if (event.channel === 'cs-unread-update') {
          const payload = event.args[0] || {};
          const rt = runtimeShops[shop.id];
          if (payload.isNewMessage && shop.id !== appState.activeShopId) {
            handleIncomingMessageAlert(shop.id, `${shop.shopName} 有新未读消息`, `当前未读会话数: ${payload.unreadCount || 1}`);
          } else if (typeof payload.unreadCount === 'number') {
            rt.unreadCount = payload.unreadCount;
            updateTabBadgesInPlace();
          }
        }
      });
    }
    // v11 Phase D: 订单页「待发货」数字感知
    if (kind === 'order') {
      webview.addEventListener('ipc-message', (event) => {
        if (event.channel === 'cs-order-update') {
          handleOrderCountUpdate(shop.id, event.args[0] || {});
        }
      });
    }
    return webview;
  }

  // 切换某店铺的子标签：只切 display（两个 webview 都常驻），速度快、不重新加载、不重新登录
  function switchShopSubTab(shop, key) {
    const rt = runtimeShops[shop.id] || {};
    rt.activeSubTab = key;
    applySubTabVisibility(shop);
  }

  function applySubTabVisibility(shop) {
    const key = (runtimeShops[shop.id] || {}).activeSubTab;
    const hosts = document.querySelectorAll(`#pane_${shop.id} .subtab-pane`);
    hosts.forEach((h) => h.classList.toggle('active', h.dataset.subtab === key));
    const bar = document.getElementById(`subtabbar_${shop.id}`);
    if (bar) bar.querySelectorAll('.subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.subtab === key));
  }
  window.__switchSubTab = (shopId, key) => {
    const shop = appState.shops.find((x) => x.id === shopId);
    if (shop) switchShopSubTab(shop, key);
  };

  // ============================================================================
  function createShopPaneElement(shop, existingPane) {
    const plat = platformMap[shop.platformId] || platforms[0];
    const pane = existingPane || document.createElement('div');
    if (existingPane) {
      existingPane.innerHTML = ''; // 复用已有 pane（win32 与网页互切时重建）
    } else {
      pane.className = `shop-pane ${shop.id === appState.activeShopId ? 'active' : ''}`;
      pane.id = `pane_${shop.id}`;
      pane.style.setProperty('--platform-color', plat.color);
    }

    if (isElectron) {
      const csUrl = shop.customUrl || plat.url;
      const hasCS = plat.hasCustomerService !== false;          // v11: 淘宝/小红书 = false（只有订单）
      const orderUrl = (plat.orderUrl || shop.orderUrl || '').trim();
      const canOrder = !plat.orderUnsupported && orderUrl !== '';
      if (typeof runtimeShops[shop.id].activeSubTab === 'undefined') {
        runtimeShops[shop.id].activeSubTab = hasCS ? 'cs' : 'order'; // 默认选中：有客服选客服，否则订单
      }

      // ── C-1: 横排子标签栏（像浏览器书签，同时只显示一个；切换不重载、不重新登录）──
      const bar = document.createElement('div');
      bar.className = 'subtab-bar';
      bar.id = `subtabbar_${shop.id}`;
      const mkBtn = (label, key) => {
        const b = document.createElement('button');
        b.className = 'subtab-btn' + (runtimeShops[shop.id].activeSubTab === key ? ' active' : '');
        b.textContent = label;
        b.dataset.subtab = key;
        b.addEventListener('click', () => switchShopSubTab(shop, key));
        return b;
      };
      if (hasCS) bar.appendChild(mkBtn('💬 客服', 'cs'));
      if (canOrder) bar.appendChild(mkBtn('📦 订单', 'order'));
      pane.appendChild(bar);

      // ── C-2: 子标签视口（两个 webview 常驻，同一 partition 共享 Cookie，切 tab 只切 display）──
      const viewport = document.createElement('div');
      viewport.className = 'subtab-viewport';
      pane.appendChild(viewport);
      if (hasCS) {
        const hostCs = document.createElement('div');
        hostCs.className = 'subtab-pane webview-host' + (runtimeShops[shop.id].activeSubTab === 'cs' ? ' active' : '');
        hostCs.dataset.subtab = 'cs';
        hostCs.appendChild(buildShopWebview(`webview_${shop.id}`, csUrl, shop, plat, 'cs'));
        viewport.appendChild(hostCs);
      }
      if (canOrder) {
        const hostOd = document.createElement('div');
        hostOd.className = 'subtab-pane webview-host' + (runtimeShops[shop.id].activeSubTab === 'order' ? ' active' : '');
        hostOd.dataset.subtab = 'order';
        hostOd.appendChild(buildShopWebview(`webview_order_${shop.id}`, orderUrl, shop, plat, 'order'));
        viewport.appendChild(hostOd);
      }
    } else {
      // 在浏览器在线预览环境中，渲染高保真 1:1 原版客服工作台交互仿真器
      renderSimulatedWorkbench(pane, shop);
    }

    return pane;
  }

  function renderSimulatedWorkbench(pane, shop) {
    const plat = platformMap[shop.platformId] || platforms[0];
    const rt = runtimeShops[shop.id];
    const activeBuyer = rt.buyers[rt.activeBuyerIdx] || rt.buyers[0];

    pane.innerHTML = `
      <div id="sim_wb_${shop.id}" class="sim-workbench ${shop.cleanMode ? 'clean-mode-on' : ''}" style="--platform-color:${plat.color};">
        <!-- 当用户关闭「纯净客服模式」时才会出现的臃肿商家后台顶部栏（用于直观对比去后台效果） -->
        <div class="sim-bloated-header">
          <div>
            <strong>⚠️ [${plat.shortName}商家后台顶栏]</strong>
            <span style="margin-left:12px;">商品管理 · 订单查询 · 营销活动 · 数据罗盘 · 财务对账 · 店铺装修</span>
          </div>
          <span style="color:#fcd34d;">（开启顶部「✨ 纯净客服模式」即可自动隐藏此商家后台菜单，只留100%纯客服界面）</span>
        </div>

        <div class="sim-bloated-body">
          <!-- 当关闭「纯净客服模式」时显示的左侧商家后台菜单 -->
          <div class="sim-bloated-sidebar">
            <div style="color:#f8fafc;font-weight:700;padding:4px 6px;">📦 商家后台导航</div>
            <div class="bloated-menu-item"><span>商品管理</span><span>›</span></div>
            <div class="bloated-menu-item"><span>订单发货</span><span>›</span></div>
            <div class="bloated-menu-item"><span>售后工作台</span><span>›</span></div>
            <div class="bloated-menu-item"><span>营销推广</span><span>›</span></div>
            <div class="bloated-menu-item"><span>达人带货</span><span>›</span></div>
            <div class="bloated-menu-item"><span>数据中心</span><span>›</span></div>
            <div class="bloated-menu-item"><span>资金结算</span><span>›</span></div>
            <div style="margin-top:auto;padding:8px;background:rgba(239,68,68,0.15);border-radius:6px;color:#fca5a5;font-size:11px;line-height:1.4;">
              当前处于「含商家后台视图」。点击上方工具栏 <strong>✨ 纯净客服模式</strong> 可一键剥离这些非客服菜单！
            </div>
          </div>

          <!-- 100% 原版风格三栏式纯客服接待工作台 -->
          <div class="sim-cs-core">
            <!-- 左栏：原版客服会话列表 -->
            <div class="cs-session-list">
              <div class="cs-platform-header" style="background:${plat.color};">
                <div>
                  <div style="font-size:14px;font-weight:800;">${plat.fullName}</div>
                  <div style="font-size:11px;opacity:0.9;margin-top:2px;">当前店铺：${escapeHtml(shop.shopName)}</div>
                </div>
                <div class="cs-agent-status">
                  <span style="width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;"></span>
                  <span>接待在线</span>
                </div>
              </div>

              <!-- 账密自动登录状态提示条 -->
              <div style="padding:7px 12px;background:#f0fdf4;border-bottom:1px solid #dcfce7;font-size:11.5px;color:#166534;display:flex;justify-content:space-between;align-items:center;">
                <span>🔐 账号: <strong>${escapeHtml(shop.username || '未配置(点顶部保存账密)')}</strong></span>
                <span style="color:#15803d;font-weight:600;">Cookie已持久保存</span>
              </div>

              <div class="cs-search-box">
                <input type="text" placeholder="搜索买家昵称 / 订单编号 / 聊天记录..." />
              </div>

              <div class="cs-buyer-items" id="buyer_list_${shop.id}">
                ${rt.buyers.map((b, idx) => `
                  <div class="cs-buyer-item ${idx === rt.activeBuyerIdx ? 'active' : ''}" data-buyer-idx="${idx}">
                    <div class="buyer-avatar" style="background:${plat.color};">${escapeHtml(b.avatar)}</div>
                    <div class="buyer-info">
                      <div class="buyer-top-row">
                        <span class="buyer-name">${escapeHtml(b.name)}</span>
                        <span class="buyer-time">${escapeHtml(b.time)}</span>
                      </div>
                      <div class="buyer-last-msg">${escapeHtml(b.messages[b.messages.length - 1]?.text || '')}</div>
                    </div>
                    ${b.unread > 0 ? `<span class="buyer-unread-dot">${b.unread}</span>` : ''}
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- 中栏：当前买家对话窗口 -->
            <div class="cs-chat-main">
              <div class="cs-chat-topbar">
                <div style="display:flex;align-items:center;gap:10px;">
                  <strong style="font-size:15px;color:#0f172a;">${escapeHtml(activeBuyer.name)}</strong>
                  <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${plat.bgLight};color:${plat.color};font-weight:600;">
                    ${plat.shortName}买家咨询中
                  </span>
                  <span style="font-size:12px;color:#64748b;">关联单号: ${escapeHtml(activeBuyer.orderNo)}</span>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                  <span style="font-size:11px;color:#64748b;">官方原版地址: <code style="color:#0f172a;">${escapeHtml(shop.customUrl || plat.url)}</code></span>
                  <a href="${escapeHtml(shop.customUrl || plat.url)}" target="_blank" rel="noopener"
                     style="font-size:11.5px;padding:4px 10px;border-radius:5px;background:#f1f5f9;color:#2563eb;text-decoration:none;font-weight:600;border:1px solid #cbd5e1;">
                    ↗ 浏览器新窗口打开官方页
                  </a>
                </div>
              </div>

              <div class="cs-chat-messages" id="chat_msgs_${shop.id}">
                <div style="text-align:center;font-size:11.5px;color:#94a3b8;margin:4px 0;">
                  —— ${plat.fullName} · 原版实时接待通道已连接（支持 3 分钟回复率考核防漏单提醒） ——
                </div>
                ${activeBuyer.messages.map((m) => `
                  <div class="msg-row ${m.sender === 'buyer' ? 'msg-buyer' : 'msg-seller'}">
                    <div class="buyer-avatar" style="width:32px;height:32px;font-size:12px;background:${m.sender === 'buyer' ? '#64748b' : plat.color};">
                      ${m.sender === 'buyer' ? escapeHtml(activeBuyer.avatar) : '客'}
                    </div>
                    <div>
                      <div class="msg-meta" style="text-align:${m.sender === 'buyer' ? 'left' : 'right'};">
                        ${m.sender === 'buyer' ? escapeHtml(activeBuyer.name) : escapeHtml(shop.shopName + '·客服')} · ${escapeHtml(m.time)}
                      </div>
                      <div class="msg-bubble">${escapeHtml(m.text)}</div>
                    </div>
                  </div>
                `).join('')}
              </div>

              <div class="cs-chat-composer">
                <div class="composer-toolbar">
                  <div class="composer-tools-left">
                    <button class="composer-tool-btn">😊 表情</button>
                    <button class="composer-tool-btn">🖼️ 发送图片</button>
                    <button class="composer-tool-btn">📦 发送商品卡</button>
                    <button class="composer-tool-btn">🎟️ 推送店铺优惠券</button>
                    <button class="composer-tool-btn">🔄 转接其他客服</button>
                  </div>
                  <span style="font-size:11px;color:#94a3b8;">按 Enter 快速发送 / 点击右侧「快捷话术」一键填入</span>
                </div>
                <textarea id="composer_input_${shop.id}" class="composer-textarea" placeholder="在此输入回复 ${escapeHtml(activeBuyer.name)} 的消息，按 Enter 发送..."></textarea>
                <div class="composer-footer">
                  <span style="font-size:11.5px;color:#64748b;">
                    💡 提示：在 Windows 上运行本软件（双击 <code>start-windows.bat</code>）将直接内嵌加载 <strong>${plat.fullName}</strong> 真实官方网页
                  </span>
                  <button id="btn_send_${shop.id}" class="btn-send-msg" style="background:${plat.color};">发送回复 (Enter)</button>
                </div>
              </div>
            </div>

            <!-- 右栏：客服核单与咨询商品卡片（客服专用栏） -->
            <div class="cs-order-aside">
              <div class="aside-card">
                <div class="aside-card-title">
                  <span>🛍️ 买家正在咨询的商品</span>
                  <span style="color:${plat.color};">发给买家</span>
                </div>
                <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:4px;">
                  ${escapeHtml(activeBuyer.product)}
                </div>
                <div style="font-size:14px;font-weight:800;color:#ef4444;">
                  ${escapeHtml(activeBuyer.price)}
                </div>
                <div style="font-size:11px;color:#64748b;margin-top:6px;">
                  库存充足 · 赠送运费险 · 48小时内发货
                </div>
              </div>

              <div class="aside-card">
                <div class="aside-card-title">
                  <span>📋 关联订单核对</span>
                  <span style="color:#10b981;">待发货</span>
                </div>
                <div style="font-size:12px;color:#334155;line-height:1.7;">
                  <div><strong>订单号：</strong>${escapeHtml(activeBuyer.orderNo)}</div>
                  <div><strong>买家昵称：</strong>${escapeHtml(activeBuyer.name)}</div>
                  <div><strong>实付金额：</strong>${escapeHtml(activeBuyer.price)}</div>
                  <div><strong>客服备注：</strong>老客户优先打包，核对尺码</div>
                </div>
              </div>

              <div class="aside-card" style="background:#eff6ff;border-color:#bfdbfe;">
                <div class="aside-card-title" style="color:#1d4ed8;">
                  <span>🛡️ 该平台接入方案说明</span>
                </div>
                <div style="font-size:11.5px;color:#1e40af;line-height:1.55;">
                  ${escapeHtml(plat.notes)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // 绑定左侧买家切换事件
    pane.querySelectorAll('.cs-buyer-item').forEach((item) => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.getAttribute('data-buyer-idx'), 10) || 0;
        rt.activeBuyerIdx = idx;
        if (rt.buyers[idx]) {
          rt.unreadCount = Math.max(0, rt.unreadCount - (rt.buyers[idx].unread || 0));
          rt.buyers[idx].unread = 0;
        }
        renderSimulatedWorkbench(pane, shop);
        renderAllTabs();
      });
    });

    // 绑定发送消息事件
    const inputEl = pane.querySelector(`#composer_input_${shop.id}`);
    const sendBtn = pane.querySelector(`#btn_send_${shop.id}`);
    const doSend = () => {
      const text = (inputEl.value || '').trim();
      if (!text) return;
      activeBuyer.messages.push({
        sender: 'seller',
        text,
        time: '刚刚'
      });
      activeBuyer.unread = 0;
      inputEl.value = '';
      renderSimulatedWorkbench(pane, shop);
      const msgBox = pane.querySelector(`#chat_msgs_${shop.id}`);
      if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;
    };

    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });
    }
  }

  // ============================================================================
  // 5. 切换店铺标签页（零延迟切换，自动消除变色闪烁与未读提醒）
  // ============================================================================
  function switchToShopTab(shopId) {
    const shop = appState.shops.find((s) => s.id === shopId) || appState.shops[0];
    if (!shop) return;

    appState.activeShopId = shop.id;
    const rt = runtimeShops[shop.id];
    if (rt) {
      rt.flashing = false;
      rt.unreadCount = 0;
      if (rt.buyers && rt.buyers[rt.activeBuyerIdx]) {
        rt.buyers[rt.activeBuyerIdx].unread = 0;
      }
    }

    // 切换主面板显示状态
    document.querySelectorAll('.shop-pane').forEach((p) => {
      p.classList.toggle('active', p.id === `pane_${shop.id}`);
    });

    updateToolbarForActiveShop(shop);
    updateTabBadgesInPlace();
    persistState();

  }

  function updateToolbarForActiveShop(shop) {
    const plat = platformMap[shop.platformId] || platforms[0];
    const badgeEl = document.getElementById('currentPlatformBadge');
    const shopLabelEl = document.getElementById('currentShopLabel');
    const partLabelEl = document.getElementById('currentPartitionLabel');
    const urlSelectEl = document.getElementById('urlEntrySelect');

    badgeEl.style.background = plat.color;
    badgeEl.textContent = plat.iconText;
    shopLabelEl.textContent = shop.shopName;
    partLabelEl.textContent = shop.partition;

    // 填充官方纯客服地址下拉选项
    urlSelectEl.innerHTML = '';
    (plat.backupUrls || []).forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.url;
      opt.textContent = `${u.label}`;
      if (u.url === (shop.customUrl || plat.url)) opt.selected = true;
      urlSelectEl.appendChild(opt);
    });
  }

  // ============================================================================
  // 6. ★ 核心功能：收到新消息时触发标签页变色呼吸闪烁 + 提示音 + 悬浮通知
  // ============================================================================
  function handleIncomingMessageAlert(shopId, buyerName, messageText) {
    const shop = appState.shops.find((s) => s.id === shopId);
    if (!shop) return;
    const plat = platformMap[shop.platformId] || platforms[0];
    const rt = runtimeShops[shop.id];

    // 如果不是当前正在查看的标签页，则启动橙红变色呼吸闪烁 + 累加未读角标
    if (shop.id !== appState.activeShopId) {
      rt.flashing = true;
      rt.unreadCount = (rt.unreadCount || 0) + 1;
    } else {
      // 即使在当前标签页，也给一个轻微高亮提醒
      rt.flashing = true;
      setTimeout(() => {
        rt.flashing = false;
        updateTabBadgesInPlace();
      }, 2400);
    }

    // 播放合成客服提示音
    if (!shop.muted) {
      playAlertChime(appState.soundSettings?.tone || 'dingdong');
    }

    // 如果在 Electron 中，同步触发 Windows 任务栏闪烁与系统右下角通知
    if (isElectron) {
      window.csElectronAPI.triggerSystemAlert({
        shopId: shop.id,
        shopName: shop.shopName,
        platformName: plat.shortName,
        message: `${buyerName}: ${messageText}`,
        flashTaskbar: true,
        desktopNotification: true
      });
    }

    updateTabBadgesInPlace(); // 高频消息路径：只原地刷新角标，绝不重建 DOM
    showIncomingToast(shop, plat, buyerName, messageText);
  }

  function showIncomingToast(shop, plat, buyerName, messageText) {
    const stack = document.getElementById('toastStack');
    const toast = document.createElement('div');
    toast.className = 'incoming-toast';
    toast.style.borderLeftColor = plat.color;
    toast.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="tab-platform-icon" style="width:18px;height:18px;font-size:10px;background:${plat.color};">${plat.iconText}</span>
          <strong style="font-size:12.5px;color:#fff;">${escapeHtml(shop.shopName)} · 新咨询消息</strong>
        </div>
        <span style="font-size:10.5px;color:#fde047;font-weight:700;">点击立即接待 ›</span>
      </div>
      <div style="font-size:12px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        <strong>${escapeHtml(buyerName)}：</strong>${escapeHtml(messageText)}
      </div>
    `;

    toast.addEventListener('click', () => {
      switchToShopTab(shop.id);
      toast.remove();
    });

    stack.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 5500);
  }

  // 模拟一条真实买家发来的新消息（方便用户直接测试变色闪烁与提示音效果）
  function triggerSimulatedBuyerMessage() {
    const otherShops = appState.shops.filter((s) => s.id !== appState.activeShopId);
    const targetShop = otherShops.length > 0
      ? otherShops[Math.floor(Math.random() * otherShops.length)]
      : appState.shops[0];

    const plat = platformMap[targetShop.platformId] || platforms[0];
    const sampleInquiries = [
      '亲，在吗？刚刚拍下的那单能帮我备注发顺丰或者京东快递吗？',
      '老板，我现在下单今天能发走吗？急着周末送人用！',
      '这款买两件有没有组合优惠价呀？老客户回购了~',
      '你好，尺码拍小了一号，还没发货能直接帮我改成XL码吗？',
      '收到宝贝质量很满意！想再买3件可以开公司增值税发票吗？'
    ];
    const randomMsg = sampleInquiries[Math.floor(Math.random() * sampleInquiries.length)];
    const rt = runtimeShops[targetShop.id];

    if (rt && rt.buyers && rt.buyers.length > 0) {
      const buyer = rt.buyers[0];
      buyer.messages.push({
        sender: 'buyer',
        text: randomMsg,
        time: '刚刚'
      });
      buyer.time = '刚刚';
      buyer.unread = (buyer.unread || 0) + 1;

      if (!isElectron) {
        const pane = document.getElementById(`pane_${targetShop.id}`);
        if (pane) renderSimulatedWorkbench(pane, targetShop);
      }
      handleIncomingMessageAlert(targetShop.id, buyer.name, randomMsg);
    } else {
      handleIncomingMessageAlert(targetShop.id, `${plat.shortName}新买家`, randomMsg);
    }
  }

  // ============================================================================
  // 7. 工具栏与弹窗交互绑定（纯净客服模式、账密保存与自动填充、新增多开店铺）
  // ============================================================================
  function bindToolbarEvents() {
    if (window.__toolbarBound) return; window.__toolbarBound = true;
    // 切换官方客服入口或触发 Windows 原生窗口嵌入
    document.getElementById('urlEntrySelect').addEventListener('change', async (e) => {
      const newUrl = e.target.value;
      const shop = getActiveShop();
      if (!shop) return;
      shop.customUrl = newUrl; // v11: 改的是「客服」子标签入口
      persistState();
      if (isElectron) {
        const wv = document.getElementById(`webview_${shop.id}`);
        if (wv) wv.setAttribute('src', newUrl);
      } else {
        const pane = document.getElementById(`pane_${shop.id}`);
        if (pane) renderSimulatedWorkbench(pane, shop);
      }
    });

    // 打开「保存账密 / 自动登录设置」弹窗
    document.getElementById('btnOpenVault').addEventListener('click', () => {
      const shop = getActiveShop();
      if (!shop) return;
      const plat = platformMap[shop.platformId];
      document.getElementById('vaultModalTitle').textContent = `🔐 ${plat.shortName} · 账密保存与自动登录 (${shop.shopName})`;
      document.getElementById('vaultShopName').value = shop.shopName || '';
      document.getElementById('vaultUsername').value = shop.username || '';
      document.getElementById('vaultPassword').value = shop.password || '';
      document.getElementById('vaultAutoFill').checked = shop.autoFill !== false;
      document.getElementById('vaultAutoSubmit').checked = Boolean(shop.autoSubmit);
      document.getElementById('vaultModal').classList.remove('hidden');
    });

    const closeVault = () => document.getElementById('vaultModal').classList.add('hidden');
    document.getElementById('btnCloseVault').addEventListener('click', closeVault);
    document.getElementById('btnCancelVault').addEventListener('click', closeVault);

    // 保存账密并立即填充
    document.getElementById('btnSaveVault').addEventListener('click', () => {
      const shop = getActiveShop();
      if (!shop) return;
      shop.shopName = document.getElementById('vaultShopName').value.trim() || shop.shopName;
      shop.username = document.getElementById('vaultUsername').value.trim();
      shop.password = document.getElementById('vaultPassword').value;
      shop.autoFill = document.getElementById('vaultAutoFill').checked;
      shop.autoSubmit = document.getElementById('vaultAutoSubmit').checked;

      persistState();
      renderAllTabs();
      updateToolbarForActiveShop(shop);
      closeVault();
      triggerAutoFillForShop(shop);
    });

    // 清除当前店铺独立 Cookie 沙箱
    document.getElementById('btnClearCookie').addEventListener('click', async () => {
      const shop = getActiveShop();
      if (!shop) return;
      if (isElectron) {
        await window.csElectronAPI.clearShopSession(shop.partition);
        const pane = document.getElementById(`pane_${shop.id}`);
        if (pane) pane.querySelectorAll('webview').forEach((wv) => wv.reload()); // v11: 客服+订单两个子标签都重载
      }
      closeVault();
      const plat = platformMap[shop.platformId];
      showIncomingToast(shop, plat, '独立沙箱缓存已重置', `已清空 ${shop.partition} 的登录态，可重新登录新账号`);
    });

    // 一键填入账密按钮
    document.getElementById('btnAutoFillNow').addEventListener('click', () => {
      const shop = getActiveShop();
      if (shop) triggerAutoFillForShop(shop);
    });

    // 模拟买家发来新消息（测试闪烁+声音）
    document.getElementById('btnSimulateIncoming').addEventListener('click', () => {
      triggerSimulatedBuyerMessage();
    });

    // 开启/关闭自动消息流轮巡演示
    const autoStreamBtn = document.getElementById('btnAutoStream');
    autoStreamBtn.addEventListener('click', () => {
      if (autoStreamTimer) {
        clearInterval(autoStreamTimer);
        autoStreamTimer = null;
        autoStreamBtn.classList.remove('btn-active-green');
        autoStreamBtn.innerHTML = '<span>⏱️ 自动消息流: 关</span>';
      } else {
        triggerSimulatedBuyerMessage();
        autoStreamTimer = setInterval(triggerSimulatedBuyerMessage, 5500);
        autoStreamBtn.classList.add('btn-active-green');
        autoStreamBtn.innerHTML = '<span>⏱️ 自动消息流: 开启中</span>';
      }
    });

    // 提示音切换与试听
    const toneSelect = document.getElementById('soundToneSelect');
    toneSelect.value = appState.soundSettings?.tone || 'dingdong';
    toneSelect.addEventListener('change', (e) => {
      appState.soundSettings = appState.soundSettings || {};
      appState.soundSettings.tone = e.target.value;
      persistState();
      playAlertChime(e.target.value);
    });

    document.getElementById('btnTestSound').addEventListener('click', () => {
      playAlertChime(toneSelect.value);
    });

    // ★ 标签栏滚轮横向滚动（上下滚轮 -> 左右滑动）
    const scrollArea = document.getElementById('tabsScrollArea');
    if (scrollArea) {
      scrollArea.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0 || e.deltaX !== 0) {
          e.preventDefault();
          scrollArea.scrollLeft += (e.deltaY !== 0 ? e.deltaY : e.deltaX);
        }
      }, { passive: false });
    }

    // 新增多开店铺弹窗
    document.getElementById('btnOpenAddShop').addEventListener('click', () => {
      const platId = document.getElementById('newShopPlatform').value;
      const plat = platformMap[platId] || platforms[0];
      const countForPlat = appState.shops.filter((s) => s.platformId === plat.id).length + 1;
      document.getElementById('newShopName').value = `${plat.shortName}·专营${countForPlat}店`;
      document.getElementById('newShopUser').value = '';
      document.getElementById('newShopPass').value = '';
      document.getElementById('addShopModal').classList.remove('hidden');
    });

    document.getElementById('newShopPlatform').addEventListener('change', (e) => {
      const plat = platformMap[e.target.value] || platforms[0];
      const countForPlat = appState.shops.filter((s) => s.platformId === plat.id).length + 1;
      document.getElementById('newShopName').value = `${plat.shortName}·专营${countForPlat}店`;
    });

    const closeAddShop = () => document.getElementById('addShopModal').classList.add('hidden');
    document.getElementById('btnCloseAddShop').addEventListener('click', closeAddShop);
    document.getElementById('btnCancelAddShop').addEventListener('click', closeAddShop);

    document.getElementById('btnConfirmAddShop').addEventListener('click', () => {
    if (window.__addingShopLock) return; window.__addingShopLock = true; setTimeout(() => { window.__addingShopLock = false; }, 400);
      const platId = document.getElementById('newShopPlatform').value;
      const plat = platformMap[platId] || platforms[0];
      const shopName = document.getElementById('newShopName').value.trim() || `${plat.shortName}·新店铺`;
      const username = document.getElementById('newShopUser').value.trim();
      const password = document.getElementById('newShopPass').value;

      const uniqueId = `shop_${plat.id}_${Date.now().toString(36)}`;
      const newShop = {
        id: uniqueId,
        platformId: plat.id,
        shopName,
        customUrl: plat.url,
        partition: `persist:${uniqueId}`,
        cleanMode: true,
        autoFill: true,
        autoSubmit: false,
        muted: false,
        username,
        password,
        order: appState.shops.length
      };

      if (appState.shops.some((s) => s.id === uniqueId)) { window.__addingShopLock = false; return; }
      // 同平台自动聚合：插入到最后一个同平台店铺右侧（而非最末尾）
      newShop.order = appState.shops.length;
      let insertAt = appState.shops.length;
      for (let k = appState.shops.length - 1; k >= 0; k--) { if (appState.shops[k].platformId === plat.id) { insertAt = k + 1; break; } }
      appState.shops.splice(insertAt, 0, newShop);
      groupShopsByPlatform(appState.shops); // 归位（保险）
      initShopRuntime(newShop);
      renderAllTabs();
      renderAllShopPanes();
      switchToShopTab(newShop.id);
      closeAddShop();
    });
  }

  function triggerAutoFillForShop(shop) {
    const plat = platformMap[shop.platformId] || platforms[0];
    if (isElectron) {
      const wv = document.getElementById(`webview_${shop.id}`);
      if (wv) {
        wv.send('cs-autofill-now', {
          username: shop.username,
          password: shop.password,
          autoSubmit: shop.autoSubmit,
          loginSelectors: plat.loginSelectors
        });
      }
    } else {
      const pane = document.getElementById(`pane_${shop.id}`);
      if (pane) renderSimulatedWorkbench(pane, shop);
      showIncomingToast(
        shop,
        plat,
        '⚡ 账密自动填充成功',
        `已向 [${shop.shopName}] 自动填入账号 (${shop.username || '默认客服号'}) 并保持独立 Cookie 免密会话`
      );
    }
  }

  function removeShopTab(shopId) {
    if (appState.shops.length <= 1) return;
    const idx = appState.shops.findIndex((s) => s.id === shopId);
    if (idx === -1) return;
    appState.shops.splice(idx, 1);
    delete runtimeShops[shopId];

    const pane = document.getElementById(`pane_${shopId}`);
    if (pane) pane.remove();

    if (appState.activeShopId === shopId) {
      const nextShop = appState.shops[Math.max(0, idx - 1)];
      switchToShopTab(nextShop.id);
    } else {
      renderAllTabs();
      persistState();
    }
  }

  function populateAddShopPlatformSelect() {
    const sel = document.getElementById('newShopPlatform');
    sel.innerHTML = '';
    platforms.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.url})`;
      sel.appendChild(opt);
    });
  }

  function getActiveShop() {
    return appState.shops.find((s) => s.id === appState.activeShopId) || appState.shops[0];
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }


  // ===========================================================================
  // v11 Phase D: 订单仪表盘渲染 + 订单数字更新处理
  // ===========================================================================
  function handleOrderCountUpdate(shopId, payload) {
    if (!appState || !Array.isArray(appState.shops)) return;
    const oldCount = (typeof orderCounts[shopId] === 'number') ? orderCounts[shopId] : -1;
    const newCount = (typeof payload.count === 'number' && payload.count >= 0) ? payload.count : -1;
    orderCounts[shopId] = newCount;
    // 只在两个都是有效数字且新数字 > 旧数字时触发提醒
    if (newCount >= 0 && oldCount >= 0 && newCount > oldCount) {
      maybeTriggerOrderAlert(shopId, newCount);
    }
    renderOrderDashboard();
  }

  function maybeTriggerOrderAlert(shopId, newCount) {
    if (appState.orderAlertEnabled === false) return;
    const shop = appState.shops.find((s) => s.id === shopId);
    if (!shop) return;
    const plat = platformMap[shop.platformId] || platforms[0];
    playAlertChime(appState.soundSettings?.tone || 'dingdong');
    showOrderToast(plat, shop, newCount);
    if (isElectron && window.csElectronAPI.triggerOrderAlert) {
      window.csElectronAPI.triggerOrderAlert({
        platformName: plat.shortName,
        shopName: shop.shopName,
        count: newCount
      });
    }
  }

  function showOrderToast(plat, shop, count) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = 'incoming-toast';
    toast.style.borderLeftColor = plat.color;
    toast.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;">'
      + '<span class="tab-platform-icon" style="width:18px;height:18px;font-size:10px;background:' + plat.color + '" >' + plat.iconText + '</span>'
      + '<strong style="font-size:12.5px;color:#fff;">' + plat.shortName + ' 有新订单</strong>'
      + '<span style="font-size:11px;color:#94a3b8;">待发货 ' + count + ' 单</span>'
      + '</div>';
    toast.addEventListener('click', () => {
      switchToShopTab(shop.id);
      switchShopSubTab(shop, 'order');
      toast.remove();
    });
    stack.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 6000);
  }

  function renderOrderDashboard() {
    if (!appState || !Array.isArray(appState.shops)) return;
    const list = document.getElementById('orderDashList');
    if (!list) return;
    list.innerHTML = '';
    platforms.forEach((plat) => {
      if (plat.orderUnsupported) {
        const card = document.createElement('div');
        card.className = 'order-dash-card disabled';
        card.innerHTML =
          '<span class="od-icon" style="background:' + plat.color + '">' + plat.iconText + '</span>'
          + '<div class="od-info"><strong>' + plat.shortName + '</strong><em>暂不支持</em></div>';
        list.appendChild(card);
        return;
      }
      if (!plat.orderUrl) return;
      let total = 0, hasData = false;
      appState.shops.filter((s) => s.platformId === plat.id).forEach((s) => {
        const c = orderCounts[s.id];
        if (typeof c === 'number' && c >= 0) { total += c; hasData = true; }
      });
      const card = document.createElement('div');
      card.className = 'order-dash-card';
      card.style.borderLeftColor = plat.color;
      card.innerHTML =
        '<span class="od-icon" style="background:' + plat.color + '">' + plat.iconText + '</span>'
        + '<div class="od-info"><strong>' + plat.shortName + '</strong><em>'
        + (hasData ? total + ' 单待发货' : '读取中…') + '</em></div>';
      card.addEventListener('click', () => {
        const shop = appState.shops.find((s) => s.platformId === plat.id);
        if (shop) { switchToShopTab(shop.id); switchShopSubTab(shop, 'order'); }
        toggleOrderDashboard(false);
      });
      list.appendChild(card);
    });
    const refAt = document.getElementById('orderDashRefreshAt');
    if (refAt) refAt.textContent = '上次刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function toggleOrderDashboard(show) {
    const dash = document.getElementById('orderDashboard');
    const floatBtn = document.getElementById('orderDashFloatBtn');
    const toggleBtn = document.getElementById('btnToggleOrderDashboard');
    if (!dash) return;
    orderDashVisible = (show !== undefined) ? show : !orderDashVisible;
    dash.classList.toggle('hidden', !orderDashVisible);
    if (floatBtn) floatBtn.style.display = orderDashVisible ? 'none' : '';
    if (toggleBtn) toggleBtn.classList.toggle('btn-active-green', orderDashVisible);
    if (orderDashVisible) renderOrderDashboard();
  }

  // ===========================================================================
  // v11 Phase D/E: 仪表盘按钮绑定
  // ===========================================================================
  function bindOrderDashboardEvents() {
    const btnAlert = document.getElementById('btnToggleOrderAlert');
    if (btnAlert) {
      const syncBtn = () => {
        const on = appState.orderAlertEnabled !== false;
        const span = btnAlert.querySelector('span');
        if (span) span.textContent = '📥 新订单提醒: ' + (on ? '开' : '关');
        btnAlert.classList.toggle('btn-active-green', on);
      };
      syncBtn();
      btnAlert.addEventListener('click', () => {
        appState.orderAlertEnabled = !appState.orderAlertEnabled;
        persistState();
        syncBtn();
      });
    }
    const btnDash = document.getElementById('btnToggleOrderDashboard');
    if (btnDash) btnDash.addEventListener('click', () => toggleOrderDashboard());
    const btnClose = document.getElementById('btnCloseOrderDash');
    if (btnClose) btnClose.addEventListener('click', () => toggleOrderDashboard(false));
    const floatBtn = document.getElementById('orderDashFloatBtn');
    if (floatBtn) floatBtn.addEventListener('click', () => toggleOrderDashboard(true));
  }
  window.addEventListener('DOMContentLoaded', initApp);
})();
