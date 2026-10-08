const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

let mainWindow = null;

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
