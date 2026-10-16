const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");

let mainWindow = null;

/** zoomLevel 上下限：±4 档（每档 0.5），够用且不会把页面变成像素汤 */
const ZOOM_MAX = 4;
const ZOOM_MIN = -4;

function applyZoom(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, wc.getZoomLevel() + delta));
  wc.setZoomLevel(next);
}

function resetZoom() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomLevel(0);
}

/**
 * 内容缩放 —— 不依赖默认菜单的加速键：
 * - 默认菜单的放大注册在 `Ctrl+Plus` 上，那个键要 Shift+= 才按得出来，
 *   所以 `Ctrl+=` 永远不匹配（缩小 `Ctrl+-` 是直配键，因此能用）——这里自己接。
 * - Ctrl+滚轮 Electron 本身不带，preload 把 ctrlKey 的 wheel 转发到这里的 IPC。
 */
function bindZoomShortcuts(wc) {
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // F12 或 Ctrl+Shift+I 呼出 DevTools（便于调试控制台日志与渲染异常）
    if (input.key === "F12" || (input.control && input.shift && (input.key || "").toLowerCase() === "i")) {
      wc.toggleDevTools();
      event.preventDefault();
      return;
    }
    if (!input.control || input.alt || input.meta) return;
    const key = (input.key || "").toLowerCase();
    if (key === "=" || key === "+" || input.code === "NumpadAdd") {
      applyZoom(0.5);
      event.preventDefault();
    } else if (key === "-" || input.code === "NumpadSubtract") {
      applyZoom(-0.5);
      event.preventDefault();
    } else if (key === "0") {
      resetZoom();
      event.preventDefault();
    }
  });
}

ipcMain.on("zoom-wheel", (_event, deltaY) => {
  applyZoom(deltaY < 0 ? 0.5 : -0.5);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    title: "Agent Workbench",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#f7f7f4",
    show: true, // 立即显示窗口，防止 ready-to-show 被阻塞
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  bindZoomShortcuts(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5280";

  // 监听加载失败事件（例如服务器尚未启动时），每 800ms 自动重试
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.log(`[electron] 加载未完成 (${errorCode}: ${errorDescription})，正在重试...`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(devUrl).catch(() => {});
      }
    }, 800);
  });

  console.log(`[electron] 正在加载页面: ${devUrl}`);
  mainWindow.loadURL(devUrl).catch((err) => {
    console.warn("[electron] 首次加载触发重试机制:", err.message);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
