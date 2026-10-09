const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
});

// Ctrl+滚轮缩放：Electron 没有内置，这里捕获后转给主进程调 webContents.setZoomLevel
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    ipcRenderer.send("zoom-wheel", e.deltaY);
  },
  { passive: false },
);
