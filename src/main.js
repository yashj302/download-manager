const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const DownloadManager = require('./download-manager');
const { startApiServer } = require('./api-server');

const bundledExtensionPath = path.join(__dirname, '..', 'extension');
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
let extensionPath = bundledExtensionPath;

let manager;
let api;
let win;
let tray;
let quitting = false;
let shuttingDown = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.quit();
  });
}

async function start() {
  app.setAppUserModelId('com.idm.clone');
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  if (app.isPackaged) extensionPath = installExtension(dataDir);
  manager = new DownloadManager({
    dataDir,
    downloadDir: app.getPath('downloads'),
  });
  manager.extensionPath = extensionPath;
  await manager.load();
  await bindApi();

  manager.on('update', (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('state:update', state);
  });
  manager.on('added', (task) => {
    if (!win || win.isDestroyed()) return;
    win.flashFrame(true);
    if (task.source === 'extension' && Notification.isSupported()) {
      new Notification({
        title: 'Caught a download',
        body: task.filename || task.url,
        icon: iconPath,
      }).show();
    }
  });
  manager.on('notify', ({ title, body }) => {
    if (!manager.settings.notifyOnComplete || !Notification.isSupported()) return;
    new Notification({ title, body, icon: iconPath }).show();
  });
  manager.on('server-restart', () => {
    bindApi().catch((err) => {
      manager.setServerStatus({ running: false, port: manager.settings.port, error: err.message });
    });
  });

  createWindow();
  createTray();
  registerIpc();
  win.webContents.send('state:update', manager.snapshot());
}

function installExtension(dataDir) {
  const target = path.join(dataDir, 'browser-extension');
  try {
    fs.rmSync(target, { recursive: true, force: true });
    copyDir(bundledExtensionPath, target);
    return target;
  } catch (err) {
    console.error('Could not unpack the browser extension', err);
    return bundledExtensionPath;
  }
}

// fs.cpSync cannot read from inside the app's asar archive, so copy file by file.
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, dest);
    else fs.writeFileSync(dest, fs.readFileSync(source));
  }
}

async function bindApi() {
  if (api) await api.close();
  api = await startApiServer(manager);
  manager.setServerStatus(api.status);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#0c1222',
    title: 'IDM Clone',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('state:update', manager.snapshot());
  });
  win.on('close', (event) => {
    if (!quitting && manager?.settings.closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  let image = nativeImage.createEmpty();
  if (fs.existsSync(iconPath)) image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;
  tray = new Tray(image);
  tray.setToolTip('IDM Clone');
  const menu = Menu.buildFromTemplate([
    { label: 'Open IDM Clone', click: showWindow },
    { label: 'Pause all', click: () => manager.pauseAll() },
    { label: 'Resume all', click: () => manager.resumeAll() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showWindow);
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function registerIpc() {
  ipcMain.handle('state:get', () => manager.snapshot());
  ipcMain.handle('download:add', (_event, payload) => guard(() => addDownloads(payload)));
  ipcMain.handle('download:pause', (_event, id) => guard(() => { manager.pause(id); }));
  ipcMain.handle('download:resume', (_event, id) => guard(() => { manager.resume(id); }));
  ipcMain.handle('download:cancel', (_event, id) => guard(() => manager.cancel(id)));
  ipcMain.handle('download:remove', (_event, id) => guard(() => manager.remove(id)));
  ipcMain.handle('download:retry', (_event, id) => guard(() => { manager.resume(id); }));
  ipcMain.handle('download:pauseAll', () => guard(() => { manager.pauseAll(); }));
  ipcMain.handle('download:resumeAll', () => guard(() => { manager.resumeAll(); }));
  ipcMain.handle('download:clearCompleted', () => guard(() => manager.clearCompleted()));
  ipcMain.handle('download:deleteFile', (_event, id) => guard(() => manager.deleteFile(id)));
  ipcMain.handle('download:open', (_event, id) => openTask(id));
  ipcMain.handle('download:show', (_event, id) => showTask(id));
  ipcMain.handle('settings:update', (_event, settings) => guard(() => manager.updateSettings(settings || {})));
  ipcMain.handle('settings:regenerateToken', () => guard(async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await manager.updateSettings({ token });
    return { token };
  }));
  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose download folder',
      defaultPath: manager.settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: true, path: null };
    return { ok: true, path: result.filePaths[0] };
  });
  ipcMain.handle('shell:openExtension', () => shell.openPath(extensionPath));
}

async function addDownloads(payload) {
  const urls = String(payload?.urls || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!urls.length) throw new Error('Enter at least one URL');
  const tasks = [];
  for (const url of urls) {
    tasks.push(await manager.add({
      url,
      filename: urls.length === 1 ? payload.filename : '',
      source: 'manual',
    }));
  }
  return { tasks };
}

async function openTask(id) {
  const task = manager.getTask(id);
  if (!task?.savePath || task.status !== 'completed') return { ok: false, error: 'The file is not ready yet' };
  const error = await shell.openPath(task.savePath);
  return error ? { ok: false, error } : { ok: true };
}

function showTask(id) {
  const task = manager.getTask(id);
  const target = task?.savePath && fs.existsSync(task.savePath)
    ? task.savePath
    : manager.settings.downloadDir;
  shell.showItemInFolder(target);
  return { ok: true };
}

async function guard(fn) {
  try {
    const result = await fn();
    return { ok: true, ...(result || {}) };
  } catch (err) {
    return { ok: false, error: err.message || 'Something went wrong' };
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!manager || shuttingDown) return;
  event.preventDefault();
  quitting = true;
  shuttingDown = true;
  (async () => {
    try {
      await manager.shutdown();
      if (api) await api.close();
    } catch (err) {
      console.error(err);
    } finally {
      app.quit();
    }
  })();
});
