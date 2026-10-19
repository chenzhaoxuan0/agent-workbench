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
  /**
   * 前端自绘窗口控制按钮（WindowControls.tsx）的通道。
   * 纯浏览器访问时整块 electronAPI 不存在，组件自行隐藏。
   */
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChanged: (listener) => {
      const wrapped = (_event, value) => listener(value);
      ipcRenderer.on("window:maximized-changed", wrapped);
      return () => ipcRenderer.removeListener("window:maximized-changed", wrapped);
    },
  },
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
