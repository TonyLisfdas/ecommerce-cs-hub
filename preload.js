/**
 * preload.js - 主界面渲染进程与 Electron 主进程通信桥
 * v11: 移除 win32Embed 原生嵌入桥；新增订单提醒桥
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('csElectronAPI', {
  isElectron: true,
  getInitialData: () => ipcRenderer.invoke('cs-get-initial-data'),
  saveState: (state) => ipcRenderer.invoke('cs-save-state', state),
  clearShopSession: (partition) => ipcRenderer.invoke('cs-clear-shop-session', partition),
  triggerSystemAlert: (payload) => ipcRenderer.invoke('cs-trigger-system-alert', payload),
  triggerOrderAlert: (payload) => ipcRenderer.invoke('cs-trigger-order-alert', payload),
  onFocusShopTab: (callback) => {
    ipcRenderer.on('cs-focus-shop-tab', (event, data) => callback(data));
  },
  onFocusOrderTab: (callback) => {
    ipcRenderer.on('cs-focus-order-tab', (event, data) => callback(data));
  }
});
