const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
  /**
   * 窗口宽度插块：delta > 0 加宽、delta < 0 减回。resolve 实际变化宽度（屏幕边
   * 截断时小于请求值）。纯浏览器访问（无 preload）时调用方拿不到本函数，静默降级。
   */
  adjustWindowWidth: (delta) => ipcRenderer.invoke("window-adjust-width", delta),
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
