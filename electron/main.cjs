// Electron main process for 3D Gen Studio.
//
// Responsibilities:
//   1. Resolve the app root + a writable data directory.
//   2. Spawn the Node/Express backend (server.js) using Electron's own Node
//      runtime (ELECTRON_RUN_AS_NODE) so users don't need Node installed.
//   3. FIRST RUN: show a setup window that provisions the Python services with
//      uv (Mesh Tools always; Rigging opt-in) and streams live progress. Later
//      runs skip straight to the splash — the venvs already exist.
//   4. Launch the Python services (Mesh Tools always; Rigging if it was set up).
//   5. Wait for the backend to answer, then open the app window.
//   6. Kill child processes on quit.

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  isReady,
  MESHTOOLS_REQS_TAG,
  ensureUv,
  setupPythonServer,
  setupSkintokens,
  startPythonServer,
  startSkintokens,
} = require('./pysetup.cjs');

// Force a stable, brandable name BEFORE any getPath('userData') call.
app.setName('3DGenStudio');

const BACKEND_PORT = Number(process.env.PORT) || 3001;
const BACKEND_ORIGIN = `http://localhost:${BACKEND_PORT}`;
const PYTHON_PORT = Number(process.env.MESHTOOLS_PORT) || 8200;
const RIG_PORT = Number(process.env.RIGTOOLS_PORT) || 8300;

const APP_ROOT = app.getAppPath();
const SERVER_JS = path.join(APP_ROOT, 'server.js');
const PYTHON_DIR = path.join(APP_ROOT, 'python-server');
const SKINTOKENS_DIR = path.join(APP_ROOT, 'thirdparty', 'skintokens');

// Backend keys data/ off process.cwd() (storage.js); point it at a per-user
// writable dir. The venvs also live here — the installed app dir is read-only.
const DATA_ROOT = process.env.GENSTUDIO_DATA_ROOT || app.getPath('userData');
const LOG_DIR = path.join(DATA_ROOT, 'logs');
const PY_VENV = path.join(DATA_ROOT, 'python-venv');
const RIG_VENV = path.join(DATA_ROOT, 'rig-venv');
// Rigging model weights (experiments/, models/) — the installed app dir is
// read-only, so download them here and point rig_server.py at it.
const RIG_DATA = path.join(DATA_ROOT, 'rig-data');

let backendProc = null;
let mainWindow = null;
let setupWindow = null;
let shuttingDown = false;

// The two Python services are started ON DEMAND (not at boot) and can be
// stopped from Settings — stopping the rigging service fully releases its GPU
// memory (the CUDA context an in-process unload can't free). `handles[name]`
// holds a running service's { stop() }; `starting[name]` dedupes concurrent
// ensure() calls. The registry is populated after the launchers are defined.
const handles = { meshtools: null, rigging: null };
const starting = { meshtools: null, rigging: null };
let SERVICES = null;

function log(line) {
  const stamped = `[main] ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'desktop.log'), stamped + '\n');
  } catch { /* logging must never crash startup */ }
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
      ELECTRON_RUN_AS_NODE: '1',
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

function waitForBackend(timeoutMs = 60000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BACKEND_ORIGIN}/`, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Backend did not start in time'));
        else setTimeout(tick, intervalMs);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

// --- On-demand Python service management ------------------------------------
function serviceRegistry() {
  return {
    meshtools: {
      // reqsTag: a requirements.txt bump flips this service back to
      // "not installed" until setup re-runs (incrementally) and re-tags it.
      label: 'Mesh Tools', venv: PY_VENV, port: PYTHON_PORT, reqsTag: MESHTOOLS_REQS_TAG,
      start: () => startPythonServer({
        serviceDir: PYTHON_DIR, venvDir: PY_VENV, port: PYTHON_PORT,
        logStream: openLogStream('python.log'), log,
      }),
    },
    rigging: {
      label: 'Rigging', venv: RIG_VENV, port: RIG_PORT,
      start: () => startSkintokens({
        serviceDir: SKINTOKENS_DIR, venvDir: RIG_VENV, dataDir: RIG_DATA, port: RIG_PORT,
        logStream: openLogStream('rig.log'), log,
      }),
    },
  };
}

// One /health probe → boolean.
function isHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Poll /health until healthy or timeout. Rigging can take a while (heavy imports
// + model), hence the generous default.
function waitForHealth(port, timeoutMs = 180000, intervalMs = 600) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isHealthy(port)) return resolve();
      if (Date.now() > deadline) return reject(new Error('service did not become ready in time'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function stopService(name) {
  const h = handles[name];
  handles[name] = null;
  starting[name] = null;
  if (h && typeof h.stop === 'function') {
    log(`Stopping ${name} service`);
    try { h.stop(); } catch { /* ignore */ }
  }
}

// Start the service if needed and wait until it answers /health. Concurrent
// callers share one in-flight start. Recovers a crashed service (handle present
// but not answering) by restarting it.
function ensureService(name) {
  const svc = SERVICES[name];
  if (!svc) return Promise.reject(new Error(`Unknown service: ${name}`));
  if (!isReady(svc.venv, svc.reqsTag)) {
    return Promise.reject(new Error(`${svc.label} is not installed yet. Install it in Settings.`));
  }
  if (starting[name]) return starting[name];

  const p = (async () => {
    if (handles[name]) {
      if (await isHealthy(svc.port)) return;
      stopService(name); // crashed → restart
    }
    log(`Starting ${name} service on demand`);
    handles[name] = svc.start();
    await waitForHealth(svc.port);
  })();
  starting[name] = p;
  p.catch(() => {}).finally(() => { if (starting[name] === p) starting[name] = null; });
  return p;
}

function serviceStatus() {
  const out = {};
  for (const [name, svc] of Object.entries(SERVICES)) {
    out[name] = {
      label: svc.label,
      installed: isReady(svc.venv, svc.reqsTag),
      running: !!handles[name],
      starting: !!starting[name],
    };
  }
  return out;
}

function registerServicesIpc() {
  ipcMain.handle('services:status', () => serviceStatus());
  ipcMain.handle('services:ensure', async (_e, { name } = {}) => {
    try { await ensureService(name); return { ok: true, status: serviceStatus() }; }
    catch (err) { return { ok: false, error: err.message, status: serviceStatus() }; }
  });
  ipcMain.handle('services:start', async (_e, { name } = {}) => {
    try { await ensureService(name); return { ok: true, status: serviceStatus() }; }
    catch (err) { return { ok: false, error: err.message, status: serviceStatus() }; }
  });
  ipcMain.handle('services:stop', (_e, { name } = {}) => {
    stopService(name);
    return { ok: true, status: serviceStatus() };
  });
}

// Provision the Python services with uv, forwarding progress to `send`. Skips a
// service that is already set up (so the in-app "install rigging" path doesn't
// needlessly reinstall Mesh Tools).
async function doSetup(rigging, send) {
  const uv = await ensureUv({ appRoot: APP_ROOT, onLine: (t) => send({ service: 'meshtools', kind: 'log', text: t }) });
  if (!uv) throw new Error('Could not find or install uv (the Python toolchain manager).');

  if (!isReady(PY_VENV, MESHTOOLS_REQS_TAG)) {
    await setupPythonServer({
      uv, serviceDir: PYTHON_DIR, venvDir: PY_VENV,
      onProgress: (e) => send({ service: 'meshtools', ...e }),
    });
  } else {
    send({ service: 'meshtools', kind: 'done' });
  }

  if (rigging && !isReady(RIG_VENV)) {
    await setupSkintokens({
      uv, serviceDir: SKINTOKENS_DIR, venvDir: RIG_VENV, dataDir: RIG_DATA,
      onProgress: (e) => send({ service: 'rigging', ...e }),
    });
  }
}

// Global setup IPC — used by BOTH the first-run window and the running app
// (Settings → Rigging "install" action). Progress streams back to whichever
// window invoked it; on success the newly-provisioned services are launched.
function registerSetupIpc() {
  ipcMain.handle('setup:status', () => ({
    desktop: true,
    meshtools: isReady(PY_VENV, MESHTOOLS_REQS_TAG),
    rigging: isReady(RIG_VENV),
  }));

  ipcMain.handle('setup:run', async (event, opts = {}) => {
    const send = (evt) => { try { event.sender.send('setup:progress', evt); } catch { /* window gone */ } };
    try {
      await doSetup(!!opts.rigging, send);
      // Provisioned only — services are started on demand (or from Settings),
      // not here, so installing doesn't spin up a process the user isn't using.
      log('Setup run complete.');
      return { ok: true, status: { meshtools: isReady(PY_VENV, MESHTOOLS_REQS_TAG), rigging: isReady(RIG_VENV) } };
    } catch (err) {
      log(`Setup run failed: ${err.message}`);
      send({ kind: 'error', text: err.message });
      return { ok: false, error: err.message };
    }
  });
}

// First-run setup window. Resolves when the user launches (or closes) it.
function runFirstRunSetup() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640, height: 560, resizable: false, backgroundColor: '#0d0f14',
      title: '3D Gen Studio — Setup', show: true, center: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    setupWindow = win;
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'setup.html'));

    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    ipcMain.once('setup:finish', done);
    win.on('closed', done);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1024, minHeight: 700,
    backgroundColor: '#111318', show: false, title: '3D Gen Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(BACKEND_ORIGIN);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(BACKEND_ORIGIN)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function loadingWindow() {
  const win = new BrowserWindow({
    width: 520, height: 320, frame: false, resizable: false, transparent: true,
    backgroundColor: '#00000000', show: true, center: true, title: '3D Gen Studio',
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  return win;
}

async function boot() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  SERVICES = serviceRegistry();
  registerSetupIpc();
  registerServicesIpc();
  backendProc = startBackend();

  // First run OR a broken/absent Mesh Tools venv → guided setup window with
  // progress (isReady probes the venv, so a legacy venv whose system Python was
  // removed is detected and rebuilt). Otherwise → fast path (splash).
  let splash = null;
  if (!isReady(PY_VENV, MESHTOOLS_REQS_TAG)) {
    await runFirstRunSetup();
  } else {
    splash = loadingWindow();
  }

  // Python services are NOT started here — they start on demand when the user
  // runs Auto UV/Retopo (Mesh Tools) or Auto Rig (Rigging), or from Settings.

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
  if (splash && !splash.isDestroyed()) splash.close();
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
}

let didShutdown = false;
function shutdown() {
  if (didShutdown) return;
  didShutdown = true;
  shuttingDown = true;
  // Kill each running service's whole process tree (the rigging service spawns
  // a bpy_server child + cold worker that a plain kill would orphan).
  for (const name of Object.keys(handles)) {
    const h = handles[name];
    if (h && typeof h.stop === 'function') { try { h.stop(); } catch { /* ignore */ } }
  }
  // Backend is a lone Node process (no long-lived children) → a plain kill is fine.
  if (backendProc && !backendProc.killed) { try { backendProc.kill(); } catch { /* ignore */ } }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow || setupWindow;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
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
