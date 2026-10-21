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
   * 用系统默认程序打开文件 / 在资源管理器中显示（设置页「打开文件」按钮）。
   * 纯浏览器访问时整块 electronAPI 不存在，前端回落 daemon 的 open-folder。
   */
  shell: {
    openPath: (path) => ipcRenderer.invoke("shell:open-path", path),
    showItemInFolder: (path) => ipcRenderer.invoke("shell:show-item-in-folder", path),
  },
  /**
   * 前端自绘窗口控制按钮（WindowControls.tsx）的通道。
   * 纯浏览器访问时整块 electronAPI 不存在，组件自行隐藏。
   */
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    /** 标题栏右键：弹出 Windows 系统菜单同款的原生菜单（还原/最大化/最小化/关闭） */
    openSystemMenu: () => ipcRenderer.send("window:system-menu"),
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
