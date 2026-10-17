/**
 * main.js - 聚客宝·八大电商平台聚合客服工作台 (Electron 主进程)
 * v11: 移除 Win32 原生窗口嵌入（千牛/千帆 客户端嵌入），保留 8 平台网页版客服 + 订单
 * 核心能力：
 * 1. 多店铺独立 Session 沙箱隔离（persist:shop_{shopId}），同一平台可同时登录多家店铺互不串号
 * 2. 账密本地 AES-256-GCM 加密持久化存储，配合 preload.js 实现自动填充登录
 * 3. 请求头净化（移除 X-Frame-Options / CSP frame-ancestors 限制）与标准 Chrome UA 伪装
 * 4. 收到新消息时：Windows 任务栏高亮闪烁 (flashFrame) + 系统右下角通知
 * 5. 订单提醒：各平台待发货数字变化 → 声音 + 弹窗「XX平台有新订单」
 */

const { app, BrowserWindow, ipcMain, session, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PLATFORMS } = require('./src/platforms');

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML and Gecko) Chrome/128.0.0.0 Safari/537.36';

let mainWindow = null;
const configuredPartitions = new Set();

// v18: 让 Windows 任务栏把本窗口识别成「聚客宝」而不是 Electron。
//      必须在创建任何窗口之前调用，固定到任务栏才会显示正确的名字/图标。
app.setAppUserModelId('com.cshub.ecommerce.aggregator');

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
    decrypted += decipher.final('hex');
    return decrypted;
  } catch (err) {
    return '';
  }
}

function getDefaultState() {
  const shops = PLATFORMS.map((p, idx) => ({
    id: `shop_${p.id}_1`,
    platformId: p.id,
    shopName: `${p.shortName}·主营1店`,
    customUrl: p.url,
    orderUrl: p.orderUrl || '',
    hasCustomerService: p.hasCustomerService !== false, // 淘宝/小红书=false
    partition: `persist:shop_${p.id}_1`,
    cleanMode: false,
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
      tone: 'dingdong',
      volume: 0.85,
      flashTaskbar: true,
      desktopNotification: true
    },
    orderAlertEnabled: true
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
  migrateShopUrls(cloned);
  (cloned.shops || []).forEach((s) => {
    if (!s) return;
    s.cleanMode = false; // v11: 默认纯客服
  });
  cloned.shops = (cloned.shops || []).map((shop) => ({
    ...shop,
    password: decryptText(shop.passwordEncrypted || '')
  }));
  // 补齐新版字段（旧 vault 没有的）
  cloned.orderAlertEnabled = cloned.orderAlertEnabled !== false;
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

  applyCookiePersist(partitionName); // v17: 所有平台都做 Cookie 持久化（原来只有微信小店）
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
    title: '聚客宝 · 八大电商平台聚合客服工作台',
    backgroundColor: '#0F172A',
    autoHideMenuBar: true,
    titleBarOverlay: { color: '#0f172a', symbolColor: '#e2e8f0', height: 36 }, // v18: 标题栏跟随配色
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false // 禁止后台降频，确保 WebSocket 实时收消息
    }
  });

  const state = loadAppState();
  (state.shops || []).forEach((s) => ensurePartitionConfigured(s.partition));

  mainWindow.maximize(); // v17: 打开就最大化

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));

  // 拦截 window.open：客服/订单相关链接在 webview 内跳转，其余用系统浏览器
  app.on('web-contents-created', (event, contents) => {
    if (contents.getType() === 'webview') {
      contents.setUserAgent(CHROME_USER_AGENT);
      contents.setWindowOpenHandler(({ url }) => {
        const internalPatterns = [
          'im.jinritemai.com', 'fxg.jinritemai.com', 'chat-merchant',
          'mms.pinduoduo.com',
          'im.kwaixiaodian.com', 's.kwaixiaodian.com',
          'ark.xiaohongshu.com', 'customer.xiaohongshu.com', 'qianfan.xiaohongshu.com',
          'im.jd.com', 'dongdong.jd.com', 'shop.jd.com',
          'store.weixin.qq.com',
          'goofish.com',
          'trade.taobao.com', 'myseller.taobao.com', 'market.m.taobao.com'
        ];
        if (internalPatterns.some((p) => url.includes(p))) {
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

// v18: 让界面能改标题栏（最小化/最大化/关闭那一行）的颜色
ipcMain.handle('cs-set-titlebar', async (event, opts) => {
  try {
    if (mainWindow && typeof mainWindow.setTitleBarOverlay === 'function' && opts) {
      mainWindow.setTitleBarOverlay({ color: opts.color, symbolColor: opts.symbolColor });
    }
  } catch (e) {}
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
      silent: true
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

// 订单提醒（Phase E）：「XX平台有新订单」简单版弹窗
ipcMain.handle('cs-trigger-order-alert', async (event, { platformName, shopName, count }) => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: `【${platformName}】有新订单`,
      body: `${shopName || '店铺'} 待发货 ${count} 单`,
      silent: false
    });
    notif.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send('cs-focus-order-tab', { platformName, shopName });
      }
    });
    notif.show();
  }
  return { ok: true };
});

// ============================================================================
// 静默启动：屏蔽 Chromium SSL -103 日志刷屏
// ============================================================================
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('log-level', '3');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

// ============================================================================
// 旧 vault 地址自动迁移
// ============================================================================
const URL_MIGRATIONS = [
  { from: 'im.jd.com', to: 'https://dongdong.jd.com/' }
];

function migrateShopUrls(state) {
  (state.shops || []).forEach((shop) => {
    if (typeof shop.customUrl === 'string' && shop.customUrl) {
      for (const m of URL_MIGRATIONS) {
        if (shop.customUrl.includes(m.from)) shop.customUrl = m.to;
      }
    }
    // v11: 清理旧 win32:// 地址（淘宝/小红书客服已删除，改为订单页或空）
    if (typeof shop.customUrl === 'string' && shop.customUrl.startsWith('win32://')) {
      if (shop.platformId === 'taobao') shop.customUrl = 'https://trade.taobao.com/trade/itemlist/list_sold_items.htm';
      if (shop.platformId === 'xiaohongshu') shop.customUrl = 'https://qianfan.xiaohongshu.com/shop/order';
      shop.hasCustomerService = false;
    }
  });
  return state;
}

// v17: 所有平台通用 —— 把「会话 Cookie」续期为 30 天持久 Cookie
//      背景：Electron 的 persist 分区只会把「有到期时间」的 Cookie 写到硬盘；
//      快手、微信、拼多多这些平台登录用的是「会话 Cookie」（没有到期时间），
//      一关软件就被丢掉，下次还得重新扫码登录。这里统一给它们补上到期时间。
const PERSIST_COOKIE_DOMAINS = [
  'jinritemai.com', 'pinduoduo.com', 'yangkeduo.com', 'taobao.com', 'tmall.com', 'alibaba.com',
  'weixin.qq.com', 'kwaixiaodian.com', 'kuaishou.com', 'xiaohongshu.com', 'xhscdn.com',
  'jd.com', '360buyimg.com', 'goofish.com'
];

function applyCookiePersist(partitionName) {
  if (!partitionName) return;
  try {
    const ses = session.fromPartition(partitionName);
    ses.cookies.on('changed', (event, cookie, cause, removed) => {
      try {
        if (removed || !cookie || !cookie.session || !cookie.domain) return;
        const d = String(cookie.domain).replace(/^\./, '').toLowerCase();
        if (!PERSIST_COOKIE_DOMAINS.some((x) => d === x || d.endsWith('.' + x))) return;
        const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
        const url = (cookie.secure ? 'https://' : 'http://') + d + '/';
        const p = ses.cookies.set({
          url: url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: expiry
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {}
    });
  } catch (e) {}
}

// ============================================================================
// 单实例锁
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

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
