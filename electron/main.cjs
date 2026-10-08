const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const http = require("http");

let mainWindow = null;

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      const req = http.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on("error", () => retry());
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for dev server: ${url}`));
        return;
      }
      setTimeout(ping, 300);
    }

    ping();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    title: "Agent Workbench",
    backgroundColor: "#0f1115",
    show: false, // 等待加载好后再显示，防止白屏闪烁
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5280";
  const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

  if (isDev) {
    try {
      await waitForServer(devUrl, 20000);
      await mainWindow.loadURL(devUrl);
    } catch (err) {
      console.warn("[electron] Dev server not ready, retrying loadURL directly...", err);
      await mainWindow.loadURL(devUrl);
    }
  } else {
    const indexPath = path.join(__dirname, "../prototype/dist/index.html");
    await mainWindow.loadFile(indexPath);
  }
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
