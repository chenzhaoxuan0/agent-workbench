const { app, BrowserWindow, dialog, shell, ipcMain, Menu } = require("electron");
const path = require("path");

let mainWindow = null;

/** zoomLevel 上下限：±4 档（每档 0.5），够用且不会把页面变成像素汤 */
const ZOOM_MAX = 4;
const ZOOM_MIN = -4;

/**
 * 文本语义的右键菜单（对齐 ZCode desktopWindowChrome.ts 的 buildTextContextMenuTemplate）：
 * - 可编辑区域（对话输入框等）→ 剪切 / 复制 / 粘贴（按 editFlags 置灰）；
 * - 纯文本选区（对话内容里选中文字）→ 只给 复制；
 * - 其余（无选区且不可编辑）→ 不弹菜单，保持右键安静。
 * 用 Electron 原生菜单而不是 DOM 浮层：剪贴板 role 由 Chromium 实现，输入框、
 * 只读文本、跨进程剪贴板行为都和系统一致，无需在前端各处接 contextmenu。
 */
function buildTextContextMenuTemplate(params) {
  if (params.isEditable) {
    return [
      { label: "剪切", role: "cut", enabled: params.editFlags.canCut },
      { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
      { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
    ];
  }
  if ((params.selectionText || "").trim().length > 0) {
    return [{ label: "复制", role: "copy", enabled: params.editFlags.canCopy }];
  }
  return [];
}

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

/**
 * 原生「选择文件夹」对话框（与 <input type="file"> 附件选择同款系统 UI）。
 * 渲染层的 FolderPickerField 在桌面端优先走这里；纯浏览器访问没有本通道，
 * 回落到组件内置的目录浏览器。返回 null = 用户取消。
 */
ipcMain.handle("dialog:pick-directory", (_event, opts) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const o = opts !== null && typeof opts === "object" ? opts : {};
  return dialog
    .showOpenDialog(mainWindow, {
      title: typeof o.title === "string" && o.title !== "" ? o.title : "选择文件夹",
      defaultPath:
        typeof o.defaultPath === "string" && o.defaultPath !== "" ? o.defaultPath : undefined,
      properties: ["openDirectory"],
    })
    .then((r) => (r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]));
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 360,
    minHeight: 480,
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

  // 文本编辑语义的右键菜单（剪切/复制/粘贴/复制选区）——见 buildTextContextMenuTemplate 注释。
  // 之前完全没有 context-menu 处理，输入框里右键粘贴、选中对话文字右键复制都像被禁用了。
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const template = buildTextContextMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // 粘贴走 Clipboard 异步 API 的场景（前端自定义菜单等）需要这两个许可；默认拒绝会让 readText 静默失败
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write");
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
