const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
  /**
   * 原生目录选择对话框：系统文件资源管理器的「选择文件夹」窗口。
   * resolve 选中的绝对路径；取消 / 不可用 resolve null。
   */
  pickDirectory: (opts) => ipcRenderer.invoke("dialog:pick-directory", opts),
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
