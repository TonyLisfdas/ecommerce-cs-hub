/**
 * main.js - 聚客宝·八大电商平台聚合客服工作台 (Electron 主进程)
 * 核心能力：
 * 1. 多店铺独立 Session 沙箱隔离（persist:shop_{shopId}），同一平台可同时登录多家店铺互不串号
 * 2. 账密本地 AES-256-GCM 加密持久化存储，配合 preload-watcher.js 实现自动填充登录
 * 3. 请求头净化（移除 X-Frame-Options / CSP frame-ancestors 限制）与标准 Chrome UA 伪装
 * 4. 收到新消息时：Windows 任务栏高亮闪烁 (flashFrame) + 系统右下角通知（点击直达对应店铺标签页）
 * 5. Windows 原生窗口内嵌桥接（支持把本地千牛「接待中心」独立聊天窗口嵌进标签页）
 */

const { app, BrowserWindow, ipcMain, session, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { PLATFORMS } = require('./src/platforms');

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

let mainWindow = null;
const configuredPartitions = new Set();

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
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
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
      { id: 'qr4', category: '售后安抚', title: '退换货无忧', text: '亲您放心，咱们店铺支持7天无理由退换货且赠送运费险，如果有任何不合适直接申请换货/退货就可以，运费系统会自动理赔的！' },
      { id: 'qr5', category: '发票开具', title: '电子发票说明', text: '亲，确认收货后您可以在订单详情页直接申请开具电子普票/专票，也可以直接把【发票抬头+税号+邮箱】发给我，我帮您登记开具！' }
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

  // 主窗口 resize → 通知渲染进程重新对齐 win32 嵌入窗口（500ms debounce）
  let _resizeTimer = null;
  mainWindow.on('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cs-window-resized', {
          width: mainWindow.getContentSize()[0],
          height: mainWindow.getContentSize()[1]
        });
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

ipcMain.handle('cs-win32-embed', async (event, { action, processName, titleKeyword, bounds, targetHwnd }) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: '当前不是 Windows 系统，原生窗口嵌入仅在 Windows 10/11 上可用' };
  }
  const scriptPath = path.join(__dirname, 'scripts/win32-embed.ps1');
  const parentHwndBuf = mainWindow ? mainWindow.getNativeWindowHandle() : null;
  const parentHwnd = parentHwndBuf
    ? (parentHwndBuf.length >= 8 ? Number(parentHwndBuf.readBigInt64LE(0)) : parentHwndBuf.readInt32LE(0))
    : 0;

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
    String(parentHwnd),
    '-X',
    String(bounds?.x || 0),
    '-Y',
    String(bounds?.y || 92),
    '-Width',
    String(bounds?.width || 1280),
    '-Height',
    String(bounds?.height || 760),
    '-TargetHwnd',
    String(targetHwnd || 0)
  ];

  return new Promise((resolve) => {
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
// 退出前自动还原所有被内嵌的原生客服窗口（千牛/微信/咚咚/多多），
// 防止关闭本软件时把客户端窗口一起关掉
// ============================================================================
app.on('before-quit', () => {
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

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
