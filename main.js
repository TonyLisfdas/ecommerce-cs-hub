/**
 * main.js - 聚客宝·八大电商平台聚合客服工作台 (Electron 主进程)
 * 核心能力：
 * 1. 多店铺独立 Session 沙箱隔离（persist:shop_{shopId}），同一平台可同时登录多家店铺互不串号
 * 2. 账密本地 AES-256-GCM 加密持久化存储，配合 preload-watcher.js 实现自动填充登录
 * 3. 请求头净化（移除 X-Frame-Options / CSP frame-ancestors 限制）与标准 Chrome UA 伪装
 * 4. 收到新消息时：Windows 任务栏高亮闪烁 (flashFrame) + 系统右下角通知（点击直达对应店铺标签页）
 * 5. Windows 原生窗口内嵌桥接（Owned Top-Level 方案：把本地千牛「接待中心」/千帆接待窗接入标签页，
 *    窗口保持独立顶层、保留自身消息循环，鼠标键盘 100% 正常；SetWinEventHook+60ms 轮询实时跟随）
 */

const { app, BrowserWindow, ipcMain, session, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { PLATFORMS } = require('./src/platforms');

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

let mainWindow = null;
const configuredPartitions = new Set();

// ============================================================================
// Win32 跟随 watcher（Owned Top-Level 实时跟随：SetWinEventHook + 60ms 轮询兜底）
// 每个被接管的客户端窗口对应一个常驻 PowerShell watcher 进程；
// 切标签 hide/show 不动它（稳定常驻），主窗口 resize 时按新内容尺寸重建。
// ============================================================================
const win32Watchers = {}; // String(targetHwnd) -> { proc, targetHwnd, styleMode, x,y,w,h, processName, titleKeyword }

function getMainOwnerHwnd() {
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  try {
    const buf = mainWindow.getNativeWindowHandle();
    return Number(buf.length >= 8 ? buf.readBigInt64LE(0) : buf.readInt32LE(0));
  } catch (e) { return 0; }
}

function killWin32Watcher(targetHwnd) {
  const key = String(targetHwnd);
  const w = win32Watchers[key];
  if (w && w.proc) { try { w.proc.kill(); } catch (e) {} }
  delete win32Watchers[key];
}

// ==== Fix 14: watcher 单实例保障（杜绝进程堆积） ====
// 按命令行里的 -TargetHwnd <值> 匹配并杀掉【未注册在 win32Watchers 里的孤儿 watcher 进程】
function killOrphanWin32WatchersByTarget(targetHwnd) {
  const re = 'win32-embed.*-TargetHwnd ' + Number(targetHwnd) + '(\\s|$)';
  try {
    execFile('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match '" + re + "' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ], { timeout: 8000 }, () => {});
  } catch (e) {}
}

// 杀掉所有 win32-embed watcher（用于：启动时清理上一实例遗留孤儿 + before-quit 兜底）
function killOrphanWin32WatchersAll() {
  try {
    execFile('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'win32-embed' -and $_.CommandLine -match 'watch' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ], { timeout: 8000 }, () => {});
  } catch (e) {}
}

function spawnWin32Watcher(opts) {
  const targetHwnd = opts.targetHwnd;
  if (!targetHwnd) return null;
  killWin32Watcher(targetHwnd);
  // Fix 14: 先按命令行杀掉同 TargetHwnd 的孤儿 watcher（未注册的遗留进程）
  killOrphanWin32WatchersByTarget(targetHwnd);
  // Fix 14: 同一平台（processName）最多 1 个 watcher → 全局最多 2 个（淘宝 + 小红书）
  const _pn = opts.processName || 'AliWorkbench';
  Object.keys(win32Watchers).forEach((k) => {
    const _w = win32Watchers[k];
    if (_w && Number(_w.targetHwnd) !== Number(targetHwnd) && (_w.processName || 'AliWorkbench') === _pn) {
      killWin32Watcher(Number(_w.targetHwnd));
    }
  });
  const scriptPath = path.join(__dirname, 'scripts', 'win32-embed.ps1');
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-Action', 'watch',
    '-TargetHwnd', String(targetHwnd),
    '-ParentHwnd', String(opts.ownerHwnd || 0),
    '-X', String(opts.x || 0), '-Y', String(opts.y || 92),
    '-Width', String(opts.w || 1280), '-Height', String(opts.h || 760),
    '-StyleMode', opts.styleMode || 'auto',
    '-ProcessName', opts.processName || 'AliWorkbench',
    '-TitleKeyword', opts.titleKeyword || '接待中心',
    '-FollowMs', '60'
  ];
  let proc = null;
  try {
    proc = spawn('powershell.exe', args, { stdio: 'ignore' });
  } catch (e) { return null; }
  win32Watchers[String(targetHwnd)] = {
    proc, targetHwnd, styleMode: opts.styleMode || 'auto',
    x: opts.x || 0, y: opts.y || 92, w: opts.w || 1280, h: opts.h || 760,
    processName: opts.processName || 'AliWorkbench', titleKeyword: opts.titleKeyword || '接待中心'
  };
  return proc;
}

// ============================================================================
// 本地加密配置与账密保险箱 (AES-256-GCM)
// ============================================================================
function getVaultPath() {
  return path.join(app.getPath('userData'), 'cs-hub-vault.json');
}

function getMasterKey() {
  const machineSeed = `cs-hub-key-${process.env.USERNAME || process.env.USER || 'merchant'}-v1`;
  return crypto.createHash('sha256').update(machineSeed).digest();
}

function encryptText(plainText) {
  if (!plainText) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  let encrypted = cipher.update(String(plainText), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptText(cipherPayload) {
  if (!cipherPayload || !cipherPayload.includes(':')) return cipherPayload || '';
  try {
    const [ivHex, tagHex, encryptedHex] = cipherPayload.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getMasterKey(),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'utf8', 'hex');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return '';
  }
}

function getDefaultState() {
  // 默认初始化八大电商平台各 1 个主店铺标签页（用户可随时新增同平台第2、第3家店）
  const shops = PLATFORMS.map((p, idx) => ({
    id: `shop_${p.id}_1`,
    platformId: p.id,
    shopName: `${p.shortName}·主营1店`,
    customUrl: p.url,
    partition: `persist:shop_${p.id}_1`,
    cleanMode: true,
    autoFill: true,
    autoSubmit: false,
    muted: false,
    username: '',
    passwordEncrypted: '',
    order: idx
  }));

  return {
    shops,
    activeShopId: shops[0].id,
    soundSettings: {
      enabled: true,
      tone: 'dingdong', // dingdong | crystal | urgent
      volume: 0.85,
      flashTaskbar: true,
      desktopNotification: true
    },
    quickReplies: [
      { id: 'qr1', category: '发货物流', title: '当天发货承诺', text: '亲，咱们家的现货订单每天下午 16:00 前拍下都是当天安排发出的哦，一般 2-3 天左右就能收到啦~' },
      { id: 'qr2', category: '尺码导购', title: '尺码推荐询问', text: '亲，您可以告诉我一下您的身高、体重以及平时常穿的尺码吗？我帮您精准核对一下版型哈！' },
      { id: 'qr3', category: '改地址/核对', title: '确认修改地址', text: '收到亲！只要包裹还没被快递员揽收，我现在马上在系统里帮您登记修改收货地址，请稍等1分钟哈~' },
      { id: 'qr4', category: '售后安抚', title: '退换货无忧', text: '亲您放心，咱们店铺支持7天无理由退换货并赠送运费险，如果有任何不合适直接申请换货/退货就可以，系统会自动理赔的！' },
      { id: 'qr5', category: '发票开具', title: '发票开具说明', text: '好的亲！确认收货后您可以在订单详情页直接申请开具电子普票/专票，也可以直接把【发票抬头+税号+邮箱】发给我，我会帮您登记开具的！' }
    ]
  };
}

function loadAppState() {
  const vaultPath = getVaultPath();
  if (!fs.existsSync(vaultPath)) {
    const def = getDefaultState();
    saveAppState(def);
    return hydratePasswords(def);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
    return hydratePasswords(raw);
  } catch (err) {
    return hydratePasswords(getDefaultState());
  }
}

function hydratePasswords(state) {
  const cloned = JSON.parse(JSON.stringify(state));
  migrateShopUrls(cloned); // 自动升级旧地址 (im.jd.com->dongdong.jd.com, air.tb.cn->work.taobao.com)
  (cloned.shops || []).forEach((s) => {
    if (!s) return;
    s.cleanMode = false; // cleanCss 已取消，默认不再误隐藏任何按钮
    // 淘宝 → 千牛接待中心原生嵌入
    if (s.platformId === 'taobao') s.customUrl = 'win32://AliWorkbench/接待中心';
    // 小红书 → 千帆客服工作台原生嵌入
    if (s.platformId === 'xiaohongshu') s.customUrl = 'win32://千帆客服工作台/客服';
  });
  cloned.shops = (cloned.shops || []).map((shop) => ({
    ...shop,
    password: decryptText(shop.passwordEncrypted || '')
  }));
  return cloned;
}

function saveAppState(state) {
  const vaultPath = getVaultPath();
  const toSave = JSON.parse(JSON.stringify(state));
  toSave.shops = (toSave.shops || []).map((shop) => {
    const copy = { ...shop };
    if (typeof copy.password === 'string') {
      copy.passwordEncrypted = copy.password ? encryptText(copy.password) : '';
      delete copy.password;
    }
    return copy;
  });
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  fs.writeFileSync(vaultPath, JSON.stringify(toSave, null, 2), 'utf8');
  return true;
}

// ============================================================================
// 独立 Session 分区配置（每个店铺标签页独立 Cookie / 缓存 / 免X-Frame限制）
// ============================================================================
function ensurePartitionConfigured(partitionName) {
  if (!partitionName || configuredPartitions.has(partitionName)) return;
  configuredPartitions.add(partitionName);

  const ses = session.fromPartition(partitionName, { cache: true });
  ses.setUserAgent(CHROME_USER_AGENT);

  // 自动授予通知、音频播放、剪贴板发图权限
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['notifications', 'media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  // 移除可能阻止嵌入的响应头，确保8大平台网页100%顺畅加载
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    Object.keys(responseHeaders).forEach((headerName) => {
      const lower = headerName.toLowerCase();
      if (lower === 'x-frame-options' || lower === 'content-security-policy') {
        delete responseHeaders[headerName];
      }
    });
    callback({ cancel: false, responseHeaders });
  });

  // 微信小店沙箱：把 Cookie 续期为 30 天，减少重复扫码
  applyWeixinCookiePersist(partitionName);
}

// ============================================================================
// 主窗口创建
// ============================================================================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: '聚客宝 · 八大电商平台聚合客服工作台 (纯客服多开版)',
    backgroundColor: '#0F172A',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false // 关键：禁止后台标签页降频，确保8个平台WebSocket实时收消息不延迟！
    }
  });

  const state = loadAppState();
  (state.shops || []).forEach((s) => ensurePartitionConfigured(s.partition));

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));

  // 当所有 webview 挂载时，拦截 window.open 在当前标签页或系统浏览器打开
  app.on('web-contents-created', (event, contents) => {
    if (contents.getType() === 'webview') {
      contents.setUserAgent(CHROME_USER_AGENT);
      contents.setWindowOpenHandler(({ url }) => {
        // 如果是客服聊天相关链接则在当前webview内跳转，商品详情或外部链接用系统浏览器打开
        if (
          url.includes('im.jinritemai.com') ||
          url.includes('chat-merchant') ||
          url.includes('im.kwaixiaodian.com') ||
          url.includes('ark.xiaohongshu.com/app-customer') ||
          url.includes('customer.xiaohongshu.com') ||
          url.includes('im.jd.com') ||
          url.includes('store.weixin.qq.com') ||
          url.includes('goofish.com/im')
        ) {
          contents.loadURL(url);
        } else {
          shell.openExternal(url);
        }
        return { action: 'deny' };
      });
    }
  });

  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false);
  });

  // 主窗口 resize → 按新内容尺寸重建 win32 跟随 watcher + 通知渲染进程（500ms debounce）
  let _resizeTimer = null;
  mainWindow.on('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const cw = mainWindow.getContentSize()[0];
        const ch = mainWindow.getContentSize()[1];
        const ownerHwnd = getMainOwnerHwnd();
        Object.values(win32Watchers).forEach((w) => {
          spawnWin32Watcher({
            targetHwnd: w.targetHwnd, ownerHwnd, x: w.x, y: w.y, w: cw, h: ch,
            styleMode: w.styleMode, processName: w.processName, titleKeyword: w.titleKeyword
          });
        });
        mainWindow.webContents.send('cs-window-resized', { width: cw, height: ch });
      }
    }, 500);
  });
}

// ============================================================================
// IPC 通信接口
// ============================================================================
ipcMain.handle('cs-get-initial-data', async () => {
  const state = loadAppState();
  return {
    platforms: PLATFORMS,
    state,
    watcherPreloadPath: 'file://' + path.join(__dirname, 'preload-watcher.js').replace(/\\/g, '/'),
    isWindows: process.platform === 'win32'
  };
});

ipcMain.handle('cs-save-state', async (event, newState) => {
  (newState.shops || []).forEach((s) => ensurePartitionConfigured(s.partition));
  saveAppState(newState);
  return { ok: true };
});

ipcMain.handle('cs-clear-shop-session', async (event, partitionName) => {
  if (!partitionName) return { ok: false };
  const ses = session.fromPartition(partitionName);
  await ses.clearStorageData();
  await ses.clearCache();
  return { ok: true };
});

ipcMain.handle('cs-trigger-system-alert', async (event, { shopId, shopName, platformName, message, flashTaskbar, desktopNotification }) => {
  if (mainWindow && flashTaskbar && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
  if (desktopNotification && Notification.isSupported()) {
    const notif = new Notification({
      title: `【${platformName}】${shopName} 收到新消息`,
      body: message || '有买家发来新的咨询消息，点击立即切换接待',
      silent: true // 声音由渲染进程合成器统一播放，避免双重系统提示音冲突
    });
    notif.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send('cs-focus-shop-tab', { shopId });
      }
    });
    notif.show();
  }
  return { ok: true };
});

ipcMain.handle('cs-win32-embed', async (event, { action, processName, titleKeyword, bounds, targetHwnd, styleMode, expectClass }) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: '当前不是 Windows 系统，原生窗口嵌入仅在 Windows 10/11 上可用' };
  }
  const scriptPath = path.join(__dirname, 'scripts', 'win32-embed.ps1');
  const ownerHwnd = getMainOwnerHwnd();

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Action',
    action || 'embed',
    '-ProcessName',
    processName || 'AliWorkbench',
    '-TitleKeyword',
    titleKeyword || '接待中心',
    '-ParentHwnd',
    String(ownerHwnd),
    '-X',
    String(bounds?.x || 0),
    '-Y',
    String(bounds?.y || 92),
    '-Width',
    String(bounds?.width || 1280),
    '-Height',
    String(bounds?.height || 760),
    '-TargetHwnd',
    String(targetHwnd || 0),
    '-StyleMode',
    styleMode || 'auto',
    '-ExpectClass',
    expectClass || ''
  ];

  const result = await new Promise((resolve) => {
    execFile('powershell.exe', args, { timeout: 6000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        resolve({ ok: true, raw: stdout.trim() });
      }
    });
  });

  // Owned Top-Level 实时跟随：接管(embed)后重建 watcher；show 时若已有 watcher 则保持常驻不动（稳定）
  if (result && result.ok && targetHwnd) {
    const key = String(Number(targetHwnd));
    if (action === 'embed' || !win32Watchers[key]) {
      spawnWin32Watcher({
        targetHwnd: Number(targetHwnd),
        ownerHwnd: ownerHwnd,
        x: bounds?.x || 0,
        y: bounds?.y || 92,
        w: bounds?.width || 1280,
        h: bounds?.height || 760,
        styleMode: styleMode || 'auto',
        processName: processName || 'AliWorkbench',
        titleKeyword: titleKeyword || '接待中心'
      });
    }
  }
  // 弹出还原(detach)时，停掉对应的跟随 watcher（窗口已交还桌面）
  if (action === 'detach' || action === 'detach-all') {
    if (targetHwnd) killWin32Watcher(Number(targetHwnd));
    else Object.keys(win32Watchers).forEach((k) => killWin32Watcher(k));
  }

  return result;
});

// ============================================================================
// 静默启动：屏蔽 Chromium SSL -103 日志刷屏 + 忽略证书错误（避免 -103 刷黑框）
// ============================================================================
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('log-level', '3');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

// ============================================================================
// 旧 vault 地址自动迁移（把已知失效/下载页 URL 升级到正确客服入口）
// ============================================================================
const URL_MIGRATIONS = [
  { from: 'im.jd.com', to: 'https://dongdong.jd.com/' },
  // 淘宝旧URL全部 -> win32:// 千牛接待中心
  { from: 'air.tb.cn', to: 'win32://AliWorkbench/接待中心' },
  { from: 'work.taobao.com', to: 'win32://AliWorkbench/接待中心' },
  { from: 'market.m.taobao.com/app/im/chat', to: 'win32://AliWorkbench/接待中心' },
  { from: 'myseller.taobao.com', to: 'win32://AliWorkbench/接待中心' },
  // 小红书旧URL -> win32:// 千帆客服工作台
  { from: 'ark.xiaohongshu.com/app-customer', to: 'win32://千帆客服工作台/客服' },
  { from: 'customer.xiaohongshu.com', to: 'win32://千帆客服工作台/客服' }
];

function migrateShopUrls(state) {
  (state.shops || []).forEach((shop) => {
    if (typeof shop.customUrl === 'string' && shop.customUrl) {
      for (const m of URL_MIGRATIONS) {
        if (shop.customUrl.includes(m.from)) shop.customUrl = m.to;
      }
    }
  });
  return state;
}

// 微信小店：把 Session Cookie 手动续期为 30 天持久 Cookie，减少重复扫码
function applyWeixinCookiePersist(partitionName) {
  if (!partitionName || partitionName.indexOf('shop_weixin') === -1) return;
  try {
    const ses = session.fromPartition(partitionName);
    ses.cookies.on('changed', (event, cookie, cause, removed) => {
      if (!removed && cookie.domain && cookie.domain.indexOf('weixin.qq.com') !== -1 && cookie.session) {
        const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
        ses.cookies.set({
          url: 'https://store.weixin.qq.com', name: cookie.name, value: cookie.value,
          domain: cookie.domain, expirationDate: expiry
        }, () => {});
      }
    });
  } catch (e) {}
}

// ============================================================================
// 退出前：先停跟随 watcher，再 detach-only 还原所有被接管的原生客服窗口
// （清 owner + 还原样式 + 桌面显示原窗口），绝不 WM_CLOSE 关掉千牛/千帆
// ============================================================================
app.on('before-quit', () => {
  Object.keys(win32Watchers).forEach((k) => killWin32Watcher(k));
  killOrphanWin32WatchersAll(); // Fix 14: 再按命令行兜底杀掉所有 win32-embed watcher
  ['AliWorkbench', '千帆客服工作台', 'WeChat', 'JMWorkbench', 'PddWorkbench'].forEach((pn) => {
    try {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'scripts', 'win32-embed.ps1'),
        '-Action', 'detach-all', '-ProcessName', pn
      ], () => {});
    } catch (e) {}
  });
});

// ============================================================================
// 单实例锁：重复双击桌面图标时，自动把已打开的窗口恢复置顶，绝不后台多开
// ============================================================================
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(true);
    }
  });
}

app.whenReady().then(async () => {
  killOrphanWin32WatchersAll(); // Fix 14: 启动时先清理上一实例遗留的孤儿 watcher 进程
  createMainWindow();

  // 修复19: 启动救援 —— 若上次是强杀/崩溃退出（before-quit detach 没跑），客服窗口会永远藏在后台。
  // 对 platforms.js 登记的 win32ProcessName 各跑一次 rescue（RESTORE+SHOW，绝不关窗）。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rescueProcs = [...new Set(PLATFORMS.filter((p) => p.supportWin32Embed).map((p) => p.win32ProcessName).filter(Boolean))];
  const mainHwndNow = getMainOwnerHwnd();
  console.log('[win32] STARTUP mainHwnd=' + mainHwndNow + ' rescue process=[' + rescueProcs.join(',') + ']');
  for (const pn of rescueProcs) {
    try {
      await new Promise((res) => {
        execFile('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(__dirname, 'scripts', 'win32-embed.ps1'),
          '-Action', 'rescue', '-ProcessName', pn, '-ParentHwnd', String(getMainOwnerHwnd())
        ], { timeout: 8000 }, () => res());
      });
    } catch (e) {}
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
