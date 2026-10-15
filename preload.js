/**
 * preload.js - 主界面渲染进程与 Electron 主进程通信桥
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('csElectronAPI', {
  isElectron: true,
  getInitialData: () => ipcRenderer.invoke('cs-get-initial-data'),
  saveState: (state) => ipcRenderer.invoke('cs-save-state', state),
  clearShopSession: (partition) => ipcRenderer.invoke('cs-clear-shop-session', partition),
  triggerSystemAlert: (payload) => ipcRenderer.invoke('cs-trigger-system-alert', payload),
  win32Embed: (payload) => ipcRenderer.invoke('cs-win32-embed', payload),
  onFocusShopTab: (callback) => {
    ipcRenderer.on('cs-focus-shop-tab', (event, data) => callback(data));
  },
  onWindowResized: (callback) => {
    ipcRenderer.on('cs-window-resized', (event, data) => callback(data));
  }
});
