# 聚客宝 · 八大电商平台聚合客服工作台 (Windows 纯客服多开版)

专为多平台、多店铺电商卖家打造的 **纯客服接待聚合桌面软件**。将 **抖店（飞鸽）、拼多多（多多客服）、淘宝/天猫（千牛接待）、微信小店/视频号客服、快手小店、小红书（千帆客服）、京东（咚咚网页版）、闲鱼（网页版 IM）** 八大平台统一收进同一个软件窗口中，像浏览器标签页一样零延迟点击切换。

---

## 一、参考与融合的 GitHub 开源项目模块

本项目在架构设计与核心模块上深度参考并融合了以下 GitHub 成熟开源方案：

1. **[ferdium/ferdium-app](https://github.com/ferdium/ferdium-app)（10k+ Stars，开源多服务聚合桌面容器）**
   - **借鉴模块**：基于 Electron `partition="persist:shop_{id}"` 的 **多实例沙箱隔离机制** 与 `preload` 消息角标注入脚本（Recipe Preload），实现同一平台开多家店铺 Cookie 100% 物理隔离、互不串号，且重启软件永久保持登录态。
2. **[zhizheng114/electronie](https://github.com/zhizheng114/electronie)（Electron + Chromium 多标签页浏览器外壳）**
   - **借鉴模块**：顶部 Chrome 风格多标签栏调度架构，所有后台标签页保持存活且关闭 Chromium 后台降频（`backgroundThrottling: false`），确保 8 个平台的 WebSocket 长连接在后台标签页也能毫秒级实时收消息。
3. **[juzichat/-Ai-](https://github.com/juzichat/-Ai-) & [cs-lazy-tools/ChatGPT-On-CS](https://github.com/cs-lazy-tools/ChatGPT-On-CS)（国内八大电商聚合客服方案）**
   - **借鉴模块**：
     - 各平台 **官方独立客服工作台直连路由表** 与 **未读消息 DOM 选择器**；
     - 针对淘宝千牛 PC 客户端的 **Windows Win32 原生窗口内嵌模块（`user32.dll` `SetParent` + `MoveWindow`）**，支持只抓取本地千牛的「接待中心」独立聊天窗口嵌进标签页，彻底抛弃臃肿的千牛商家后台主窗口。

---

## 二、八大平台「只留原版客服、去掉商家后台」实现方案一览

| 平台 | 官方纯客服直连地址 | 如何做到「100%原版体验 + 只有客服没有商家后台」 | 同平台多店铺多开 & 自动登录 |
| :--- | :--- | :--- | :--- |
| **1. 抖店（飞鸽）** | `https://im.jinritemai.com/pc_seller_v2/main/workspace` | 官方原生提供独立飞鸽网页工作台，打开直接就是纯聊天界面，配合 CSS 净化屏蔽顶部营销横幅 | 独立 `persist:shop_douyin_N` 持久保存 Cookie + 自动填账密 |
| **2. 拼多多（多多客服）** | `https://mms.pinduoduo.com/chat-merchant/index.html` | 直连多多网页版独立客服端 `chat-merchant`，并注入 CSS 自动隐藏 `mms` 左侧后台导航栏 | 支持无限添加拼多多2店、3店，独立缓存不串号 |
| **3. 淘宝/天猫（千牛）** | 网页端：`https://air.tb.cn/app/im/chat/index.html`<br>客户端内嵌：`win32://AliWorkbench/接待中心` | **双模式**：① 网页端旺旺直连并隐藏卖家中心菜单；② **Windows 窗口内嵌模式**（只把本地千牛「接待中心」聊天窗吸进软件标签页，不显示千牛主后台） | 网页模式按标签页隔离；内嵌模式支持绑定多个千牛接待窗口 |
| **4. 微信小店/视频号** | `https://store.weixin.qq.com/shop/kf` | 直达微信小店客服路径，开启「纯净客服模式」后通过 CSS 自动隐藏左侧商品/订单/资金管理菜单栏 | 每个微信小店独立沙箱保存登录态，支持备用切换 `kf.weixin.qq.com` |
| **5. 快手小店** | `https://im.kwaixiaodian.com/` | 官方独立 IM 域名，原生即为纯粹的三栏式客服接待工作台 | 独立 Session 持久保存登录态 + React 受控表单自动填账密 |
| **6. 小红书（千帆客服）** | `https://ark.xiaohongshu.com/app-customer/chat` | 直连千帆客服路由，并自动注入 CSS 隐藏千帆左侧 `ark-sidebar` 商家菜单与顶栏，让聊天框 100% 铺满 | 支持多店铺标签页独立 Cookie + 邮箱/手机号密码自动填充 |
| **7. 京东（咚咚网页版）** | `https://im.jd.com/` | 京东官方提供咚咚 Web 商家版（`im.jd.com`），无需打开京麦商家后台即可全屏接待 | 独立 Session 保存登录态 + 自动填入京东账号密码 |
| **8. 闲鱼（网页版 IM）** | `https://www.goofish.com/im` | 基于阿里官方最新闲鱼网页版 `goofish.com/im`，通过 CSS 净化自动剔除闲鱼首页商品流与搜索栏，将 IM 聊天窗口 100% 全屏化 | 支持闲鱼多账号同时在线接待，实时监听未读消息角标 |

---

## 三、核心特性说明

1. **收到新消息：标签页变色呼吸闪烁 + 合成提示音 + 任务栏高亮**
   - `preload-watcher.js` 内置 **四重消息感知引擎**：
     1. 拦截网页原生 `window.Notification` 通知；
     2. 拦截网页原生 `<audio>.play()` 提示音播放；
     3. 监听网页 `<title>` 出现 `【新消息】`、`(1)`、`未读` 等变化；
     4. `MutationObserver` 实时扫描八大平台会话列表的红点与未读数字角标（`.unread-num`、`.badge-count` 等）。
   - 一旦后台店铺收到买家消息：
     - 顶部对应店铺标签页立即呈现 **橙红渐变呼吸闪烁 (`tabAlertFlash`)** 并显示未读数字；
     - 自动播放内置 Web Audio 合成器生成的 **清脆客服提示音**（支持「叮咚客服音」「清脆水晶铃」「急促防漏单音」三档切换与独立静音）；
     - Windows 任务栏图标闪烁（`mainWindow.flashFrame(true)`）并弹出右下角通知卡片，点击通知直接跳到对应店铺标签页。

2. **保存账密自动登录 + 持久化免重复扫码**
   - **第一重（持久化 Session 沙箱）**：每个店铺标签页拥有独立的 Chromium Session 目录，只要首次登录成功，Cookie 与 LocalStorage 永久保存在本地磁盘，下次打开软件直接进入已登录客服台。
   - **第二重（AES-256-GCM 加密账密保险箱 + 自动填充）**：点击工具栏「🔐 保存账密 / 自动登录设置」保存各店账号密码（使用本机密钥 AES-256-GCM 加密存储于本地）。当遇到平台 Cookie 过期弹出登录页时，自动调用原生 `HTMLInputElement.prototype.value` setter 突破 React/Vue 受控组件限制，自动填入账密并勾选服务协议。

---

## 四、在 Windows 电脑上如何运行与打包

### 方式 1：一键直接启动（最简单）
1. 确保你的 Windows 电脑已安装 [Node.js (LTS版本)](https://nodejs.org/zh-cn)。
2. 解压本项目文件夹，直接双击运行 **`start-windows.bat`**。
3. 脚本会自动配置国内镜像源（`npmmirror.com`）高速下载 Electron 运行时并拉起桌面客服工作台。

### 方式 2：打包成独立 `.exe` 桌面软件
- 双击运行 **`build-windows-exe.bat`**（或在终端执行 `npm run build:win`），打包完成后在 `release/` 目录下即可获得免安装的便携版 `.exe` 及安装程序。
