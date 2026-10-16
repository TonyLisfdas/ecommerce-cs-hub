# v11 Phase F 瘦身记录

## 瘦身结果
| 项目 | 瘦身前 | 瘦身后 | 变化 |
|------|--------|--------|------|
| 项目文件夹（ecommerce-cs-hub） | 440.5 MB | 259.2 MB | -181.3 MB |
| node_modules | 439.8 MB | 258.4 MB | -181.3 MB |
| C:\Users\YC\AppData\Local\electron（浏览器缓存） | 211 MB | 0 MB | -211 MB（自动重建） |

**合计释放约 392 MB。**

## 删了什么
1. **node_modules 里 electron-builder 打包工具链（181.3MB，共 231 个顶层包）**：
   - app-builder-bin（121MB）、typescript（22.5MB）、7zip-bin（11.7MB）、app-builder-lib 等。
   - 这些只在「打包发布 exe」时才需要，**日常启动软件完全用不到**。
2. **C:\Users\YC\AppData\Local\electron 的 Chromium 缓存（211MB）**：删后自动重建，不影响功能。

## 保留了什么
- `node_modules/electron`（258MB，Electron 运行时本身，含 electron.exe）——启动软件必需。
- 全部源码（main.js / preload.js / preload-watcher.js / src / scripts）未动。
- package.json、package-lock.json 保留（恢复工具链用）。

## 440MB 的真实构成（大白话）
这 440MB 里 **99.8% 是 node_modules**，而 node_modules 主要是：
- Electron 运行时 258MB（软件要跑就必须有，压不下去）
- electron-builder 打包工具 181MB（已删，仅打包发布时需要）
删除淘宝/小红书客服页只省了**几十 KB**，对体积几乎没帮助——体积大头一直是 Electron 本体。

## 如何恢复打包工具
```
cd 项目目录
npm install
```
装回后 node_modules 会回到 ~440MB（正常，只有要打包发布 exe 才需要）。

## 验证
瘦身后已重启软件并 CDP 实测：软件正常启动，10 个店铺面板、8 个客服 webview（收消息引擎已注入）、9 个订单 webview、8 张订单仪表盘卡片全部正常。
