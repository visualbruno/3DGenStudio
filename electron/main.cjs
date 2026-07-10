// Electron main process for 3D Gen Studio.
//
// Responsibilities:
//   1. Resolve the app root + a writable data directory.
//   2. Spawn the Node/Express backend (server.js) using Electron's own Node
//      runtime (ELECTRON_RUN_AS_NODE) so users don't need Node installed.
//   3. Spawn the Python mesh-tools service (optional; Auto UV / Auto Retopo).
//      On first launch it creates a venv and installs requirements — this is
//      the "require Python on the machine" model (fastest to ship).
//   4. Wait for the backend to answer, then open the window pointing at it.
//   5. Kill both child processes on quit.
//
// The window loads http://localhost:<PORT>, where the backend serves the Vite
// production build (dist/) and the API from the same origin — see server.js.

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { startPythonService } = require('./python.cjs');

// Force a stable, brandable name BEFORE any getPath('userData') call so the
// per-user data folder is ".../3DGenStudio" instead of ".../app" (which came
// from package.json "name"). Applies to both dev and packaged builds.
app.setName('3DGenStudio');

const BACKEND_PORT = Number(process.env.PORT) || 3001;
const BACKEND_ORIGIN = `http://localhost:${BACKEND_PORT}`;
const PYTHON_PORT = Number(process.env.MESHTOOLS_PORT) || 8200;

// app.getAppPath() is the project root in dev and resources/app in a packaged
// build (we ship unpacked — asar:false — so relative requires + dist/ resolve
// normally and the backend can serve static files without asar path shims).
const APP_ROOT = app.getAppPath();
const SERVER_JS = path.join(APP_ROOT, 'server.js');
const PYTHON_DIR = path.join(APP_ROOT, 'python-server');

// The backend keys its data/ folder off process.cwd() (see storage.js), so we
// point it at a per-user writable location. The installed app directory is
// read-only on macOS/Linux, so we must not write there.
const DATA_ROOT = process.env.GENSTUDIO_DATA_ROOT || app.getPath('userData');
const LOG_DIR = path.join(DATA_ROOT, 'logs');

let backendProc = null;
let pythonHandle = null;
let mainWindow = null;
let shuttingDown = false;

function log(line) {
  const stamped = `[main] ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'desktop.log'), stamped + '\n');
  } catch {
    /* logging must never crash startup */
  }
}

function openLogStream(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return fs.createWriteStream(path.join(LOG_DIR, name), { flags: 'a' });
}

function startBackend() {
  log(`Starting backend: ${SERVER_JS} (port ${BACKEND_PORT}, cwd ${DATA_ROOT})`);
  fs.mkdirSync(DATA_ROOT, { recursive: true });

  const out = openLogStream('backend.log');
  const proc = spawn(process.execPath, [SERVER_JS], {
    cwd: DATA_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run server.js as plain Node, not an Electron window
      PORT: String(BACKEND_PORT),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.on('exit', (code, signal) => {
    log(`Backend exited (code=${code} signal=${signal})`);
    if (!shuttingDown) {
      dialog.showErrorBox(
        '3D Gen Studio — backend stopped',
        `The backend process exited unexpectedly (code ${code}).\n\nSee ${path.join(LOG_DIR, 'backend.log')}`
      );
      app.quit();
    }
  });
  return proc;
}

// Poll the backend until it answers or we time out.
function waitForBackend(timeoutMs = 60000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BACKEND_ORIGIN}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Backend did not start in time'));
        else setTimeout(tick, intervalMs);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#111318',
    show: false,
    title: '3D Gen Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(BACKEND_ORIGIN);

  // Open external links (docs, Discord, cloud API dashboards) in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(BACKEND_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadingWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 320,
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: true,
    center: true,
    title: '3D Gen Studio',
    // Edit electron/splash.html to change the splash design.
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  return win;
}

async function boot() {
  const splash = loadingWindow();

  backendProc = startBackend();

  // Python is optional — Auto UV/Retopo only. Never block or fail the app on it.
  try {
    pythonHandle = startPythonService({
      pythonDir: PYTHON_DIR,
      dataRoot: DATA_ROOT,
      port: PYTHON_PORT,
      logStream: openLogStream('python.log'),
      log,
    });
  } catch (err) {
    log(`Python service failed to start (non-fatal): ${err.message}`);
  }

  try {
    await waitForBackend();
    log('Backend is up.');
  } catch (err) {
    log(`Backend startup failed: ${err.message}`);
    dialog.showErrorBox(
      '3D Gen Studio — failed to start',
      `The backend did not start.\n\nSee ${path.join(LOG_DIR, 'backend.log')}`
    );
    app.quit();
    return;
  }

  createWindow();
  if (!splash.isDestroyed()) splash.close();
}

function shutdown() {
  shuttingDown = true;
  if (pythonHandle && typeof pythonHandle.stop === 'function') {
    try { pythonHandle.stop(); } catch { /* ignore */ }
  }
  if (backendProc && !backendProc.killed) {
    try { backendProc.kill(); } catch { /* ignore */ }
  }
}

// Single-instance: focus the existing window instead of launching a 2nd copy
// (which would fight over ports 3001/8200).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', shutdown);
  process.on('exit', shutdown);
}
