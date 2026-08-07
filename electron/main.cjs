// Electron main process for 3D Gen Studio.
//
// Responsibilities:
//   1. Resolve the app root + a writable data directory.
//   2. EVERY LAUNCH: make sure the backend's port is free (an unrelated app —
//      Grafana, another Node process, etc. — may already hold it); if not,
//      let the user confirm a different one before the backend ever spawns.
//   3. Spawn the Node/Express backend (server.js) using Electron's own Node
//      runtime (ELECTRON_RUN_AS_NODE) so users don't need Node installed.
//   4. FIRST RUN: show a setup window that provisions the Python services with
//      uv (Mesh Tools always; Rigging and a managed ComfyUI opt-in) and streams
//      live progress. Later runs skip straight to the splash — the venvs exist.
//   5. Launch the Python services on demand (Mesh Tools, Rigging, ComfyUI).
//   6. Wait for the backend to answer, then open the app window.
//   7. Kill child processes on quit.

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
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
const {
  COMFY_SETUP_TAG,
  loadManifest: loadComfyManifest,
  isAvailableHere: comfyAvailableHere,
  setupComfyUI,
  startComfyUI,
  planComfyUpdate,
  updateComfyUI,
} = require('./comfysetup.cjs');

// Force a stable, brandable name BEFORE any getPath('userData') call.
app.setName('3DGenStudio');

// Default only — process.env.PORT is an explicit developer override, honored
// unconditionally (see resolveBackendPort). BACKEND_PORT/BACKEND_ORIGIN are
// `let`: boot() resolves the real port (the default if free, otherwise a
// user-confirmed one — see resolveBackendPort/promptForBackendPort) before
// the backend is spawned, then reassigns both.
const BACKEND_PORT_DEFAULT = Number(process.env.PORT) || 3001;
let BACKEND_PORT = BACKEND_PORT_DEFAULT;
let BACKEND_ORIGIN = `http://localhost:${BACKEND_PORT}`;
const PYTHON_PORT = Number(process.env.MESHTOOLS_PORT) || 8200;
const RIG_PORT = Number(process.env.RIGTOOLS_PORT) || 8300;
// ComfyUI's conventional port. The managed install must NOT assume it's free —
// plenty of users already run their own ComfyUI there — so this is only the first
// candidate; the actual port is picked at install time and stored in settings.
const COMFY_PORT_DEFAULT = Number(process.env.COMFYUI_PORT) || 8188;

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
// Managed ComfyUI: code, venv, and a separate data root (models/input/output/
// user/temp, each passed as its own --*-directory flag — see startComfyUI for why
// NOT --base-directory). Keeping data out of the code dir means reinstalling or
// upgrading ComfyUI never risks the multi-GB model downloads.
const COMFY_VENV = path.join(DATA_ROOT, 'comfy-venv');
const COMFY_DIR = path.join(DATA_ROOT, 'comfyui');
const COMFY_DATA = path.join(DATA_ROOT, 'comfy-data');

let backendProc = null;
let mainWindow = null;
let setupWindow = null;
let portPromptWindow = null;
let shuttingDown = false;

// The two Python services are started ON DEMAND (not at boot) and can be
// stopped from Settings — stopping the rigging service fully releases its GPU
// memory (the CUDA context an in-process unload can't free). `handles[name]`
// holds a running service's { stop() }; `starting[name]` dedupes concurrent
// ensure() calls. The registry is populated after the launchers are defined.
const handles = { meshtools: null, rigging: null, comfyui: null };
const starting = { meshtools: null, rigging: null, comfyui: null };
let SERVICES = null;
// Set while a managed-ComfyUI update or reinstall is rewriting the install tree.
// Both jobs delete files a running ComfyUI would have open, so starting the
// service is refused for the duration (and a second job is refused outright).
let comfyMaintenance = null;

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
    // 4th fd = IPC channel: lets the headless backend ask the main process to
    // start a Python service on demand (e.g. to render a mesh thumbnail) —
    // something it otherwise can't do (ensureService lives here, not there).
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);

  // Backend → main service requests. Reuses the same ensureService the Start
  // buttons and on-demand UI path use (start + health wait + dedupe).
  proc.on('message', async (msg) => {
    if (!msg || msg.type !== 'services:ensure') return;
    const { name, requestId } = msg;
    let reply = { type: 'services:ensure:result', requestId };
    try {
      await ensureService(name);
      reply.ok = true;
    } catch (err) {
      reply = { ...reply, ok: false, error: err?.message || String(err) };
    }
    try { proc.send(reply); } catch { /* backend gone */ }
  });
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

// Fetch the app settings from the backend over HTTP (the backend owns the DB).
// Resolves null on any error — callers treat that as "no auto-start".
function fetchSettings(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_ORIGIN}/api/settings`, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => req.destroy());
  });
}

// Deep-merge a settings patch through the backend (POST /api/settings merges).
// Used to point apis.comfyui.* at the managed install once it's provisioned.
// Resolves false on any error — the caller treats that as "tell the user".
function patchSettings(patch, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(patch), 'utf8');
    const req = http.request({
      host: 'localhost', port: BACKEND_PORT, path: '/api/settings', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

// Is a TCP port free to bind? `host` matters: pass '127.0.0.1' to match a
// service that binds there explicitly (e.g. ComfyUI's own --listen 127.0.0.1,
// comfysetup.cjs), or omit it to match a plain listen(port) with no host —
// Node's dual-stack default, which is how the backend itself binds
// (server.js's app.listen(PORT, cb) passes no host). The two checks are NOT
// interchangeable: on Windows, a bind to 127.0.0.1 (or 0.0.0.0) can succeed
// even while the dual-stack default is genuinely taken — observed in practice
// with Docker Desktop's own port-forwarding — so checking the wrong one gives
// a false "free" reading for whichever service you're actually about to start.
function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    if (host) srv.listen(port, host);
    else srv.listen(port);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickFreePort(start, tries = 20, host) {
  for (let p = start; p < start + tries; p += 1) {
    if (await portFree(p, host)) return p;
  }
  return start;
}

// Remembers the backend port the user last CONFIRMED after a conflict (see
// promptForBackendPort), so the next launch tries it first. Only written on an
// explicit confirm — the common case (default port free) never touches this
// file. Lives directly under DATA_ROOT: unlike comfy-install.json this isn't
// tied to any one venv/subsystem dir, so there's no better home for it.
const BACKEND_PORT_FILE = path.join(DATA_ROOT, 'backend-port.json');

// null when absent, unreadable, or not a usable port — callers treat that as
// "nothing remembered, use the default".
function readSavedBackendPort() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BACKEND_PORT_FILE, 'utf8'));
    const port = Number(parsed?.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function writeSavedBackendPort(port) {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(BACKEND_PORT_FILE, `${JSON.stringify({ port }, null, 2)}\n`);
  } catch (err) {
    log(`Could not save the chosen backend port: ${err.message}`); // non-fatal
  }
}

// Start the services the user opted into auto-starting (Settings → Mesh Tools /
// Auto Rig / ComfyUI). Non-blocking and best-effort: failures are logged, never
// fatal, and never delay the window. Setting key `rigtools` maps to service
// `rigging`; ComfyUI only auto-starts when it is the MANAGED install (a user's
// own external ComfyUI is not ours to launch).
async function autoStartServices() {
  const settings = await fetchSettings();
  const apis = settings?.apis || {};
  // ComfyUI only auto-starts when it is OUR install — an external one isn't ours
  // to launch. Say so out loud, because the checkbox otherwise looks broken.
  if (apis.comfyui?.autoStart && !apis.comfyui?.managed) {
    log('ComfyUI auto-start is enabled but Settings point at an external ComfyUI ' +
      '(managed=false), so it will not be started. Use Settings → ComfyUI → ' +
      '"Use the managed ComfyUI" to switch back.');
  }
  const wanted = [
    apis.meshtools?.autoStart ? 'meshtools' : null,
    apis.rigtools?.autoStart ? 'rigging' : null,
    apis.comfyui?.managed && apis.comfyui?.autoStart ? 'comfyui' : null,
  ].filter(Boolean);
  for (const name of wanted) {
    log(`Auto-starting ${name} service (enabled in Settings)`);
    ensureService(name).catch((err) => log(`Auto-start of ${name} failed: ${err?.message || err}`));
  }
}

// --- On-demand Python service management ------------------------------------
function serviceRegistry() {
  return {
    meshtools: {
      // reqsTag: a requirements.txt bump flips this service back to
      // "not installed" until setup re-runs (incrementally) and re-tags it.
      label: 'Mesh Tools', venv: PY_VENV, port: PYTHON_PORT, reqsTag: MESHTOOLS_REQS_TAG, logFile: 'python.log',
      start: () => startPythonServer({
        serviceDir: PYTHON_DIR, venvDir: PY_VENV, port: PYTHON_PORT,
        logStream: openLogStream('python.log'), log,
      }),
    },
    rigging: {
      label: 'Rigging', venv: RIG_VENV, port: RIG_PORT, logFile: 'rig.log',
      start: () => startSkintokens({
        serviceDir: SKINTOKENS_DIR, venvDir: RIG_VENV, dataDir: RIG_DATA, port: RIG_PORT,
        logStream: openLogStream('rig.log'), log,
      }),
    },
    comfyui: {
      // ComfyUI has no /health endpoint; /system_stats is its readiness probe and
      // only answers once the server is actually accepting API calls.
      label: 'ComfyUI', venv: COMFY_VENV, port: COMFY_PORT_DEFAULT, logFile: 'comfyui.log',
      healthPath: '/system_stats', reqsTag: COMFY_SETUP_TAG,
      // Venv AND code dir must both be present — see comfyReady().
      isInstalled: () => comfyReady(),
      // The port is chosen at install time (to dodge a user's own ComfyUI) and
      // stored in settings, so it must be read at start time, not at boot.
      resolvePort: async () => {
        const settings = await fetchSettings();
        const p = Number(settings?.apis?.comfyui?.port);
        return Number.isFinite(p) && p > 0 ? p : COMFY_PORT_DEFAULT;
      },
      start: (port) => startComfyUI({
        appRoot: APP_ROOT, installDir: COMFY_DIR, dataDir: COMFY_DATA, venvDir: COMFY_VENV,
        port, logStream: openLogStream('comfyui.log'), log,
      }),
    },
  };
}

// One readiness probe → boolean. `healthPath` defaults to the /health endpoint
// both Python services expose; ComfyUI overrides it.
function isHealthy(port, healthPath = '/health') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: healthPath, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Poll until healthy or timeout. Rigging can take a while (heavy imports + model)
// and so can ComfyUI (torch import + node scan), hence the generous default.
function waitForHealth(port, healthPath, timeoutMs = 180000, intervalMs = 600) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isHealthy(port, healthPath)) return resolve();
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
  // Starting ComfyUI mid-update would load files the update is replacing (and on
  // Windows lock them against deletion). Auto-start and on-demand callers land
  // here too, so the guard belongs in ensureService, not just the buttons.
  if (name === 'comfyui' && comfyMaintenance) {
    return Promise.reject(new Error(`${comfyMaintenance} ComfyUI will be startable once it finishes.`));
  }
  if (!serviceInstalled(svc)) {
    return Promise.reject(new Error(`${svc.label} is not installed yet. Install it in Settings.`));
  }
  if (starting[name]) return starting[name];

  const p = (async () => {
    // Services with a configurable port resolve it now and cache it on the
    // registry entry, so status/health checks elsewhere see the real port.
    if (svc.resolvePort) {
      try { svc.port = await svc.resolvePort(); } catch { /* keep the default */ }
    }
    if (handles[name]) {
      if (await isHealthy(svc.port, svc.healthPath)) return;
      stopService(name); // crashed → restart
    }
    log(`Starting ${name} service on demand (port ${svc.port})`);
    const handle = svc.start(svc.port);
    handles[name] = handle;

    // Race readiness against the process dying. Without this, a service that
    // crashes on startup (a bad flag, a missing directory) looks like a 3-minute
    // hang and then a generic timeout; here the real error and the tail of its
    // output surface immediately.
    let died = null;
    if (handle && handle.exited && typeof handle.exited.then === 'function') {
      // Forget a handle whose process is gone, so serviceStatus() stops reporting
      // "Running" for a service that already died (which made a crash look like a
      // healthy service that simply wasn't answering) and the next ensure() starts
      // a fresh one instead of trusting the corpse.
      handle.exited.then(() => {
        if (handles[name] === handle) handles[name] = null;
      }).catch(() => {});

      died = handle.exited.then(({ code, tail }) => {
        const last = String(tail || '').trim().split(/\r?\n/).slice(-8).join('\n');
        throw new Error(
          `${svc.label} stopped right after starting (exit code ${code}).` +
          (last ? `\n\n${last}` : '') +
          (svc.logFile ? `\n\nFull log: ${path.join(LOG_DIR, svc.logFile)}` : '')
        );
      });
      died.catch(() => {}); // a crash after we're healthy must not go unhandled
    }
    await Promise.race([waitForHealth(svc.port, svc.healthPath), died].filter(Boolean));
  })();
  starting[name] = p;
  p.catch(() => {}).finally(() => { if (starting[name] === p) starting[name] = null; });
  return p;
}

// "Installed" defaults to the venv marker check; a service with extra artifacts
// outside the venv (ComfyUI's code dir) supplies its own predicate.
function serviceInstalled(svc) {
  return svc.isInstalled ? svc.isInstalled() : isReady(svc.venv, svc.reqsTag);
}

function serviceStatus() {
  const out = {};
  for (const [name, svc] of Object.entries(SERVICES)) {
    out[name] = {
      label: svc.label,
      installed: serviceInstalled(svc),
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
  // Re-point the app at the managed ComfyUI (Settings action). Needed when the
  // settings drifted to an external instance after the install.
  ipcMain.handle('comfyui:use-managed', async () => {
    if (!comfyReady()) return { ok: false, error: 'The managed ComfyUI is not installed yet.' };
    const applied = await applyManagedComfySettings();
    if (!applied) return { ok: false, error: 'Could not save the settings.' };
    log(`Re-pointed settings at the managed ComfyUI on port ${applied.port}.`);
    return { ok: true, port: applied.port, path: COMFY_DIR, modelsPath: path.join(COMFY_DATA, 'models') };
  });

  // --- Managed ComfyUI upgrades ---------------------------------------------
  // Updating the app does NOT update an existing managed ComfyUI: the installer
  // short-circuits once the install exists, and the node packs are pinned
  // tarballs. So a newer app version ships newer refs and a newer dependency lock
  // that the user's install never sees. These two handlers close that gap: check
  // what the shipped manifest wants vs what is installed, then apply it.

  // Cheap and side-effect free (one metadata query, no network) so Settings can
  // call it whenever the ComfyUI panel opens.
  ipcMain.handle('comfyui:update-check', async () => {
    if (!comfyReady()) return { ok: false, error: 'The managed ComfyUI is not installed yet.' };
    if (comfyMaintenance) return { ok: false, error: comfyMaintenance, busy: true };
    try {
      const plan = await planComfyUpdate({ appRoot: APP_ROOT, installDir: COMFY_DIR, venvDir: COMFY_VENV });
      return { ok: true, plan, version: app.getVersion() };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('comfyui:update-run', async (event) => {
    const send = (evt) => {
      try { event.sender.send('setup:progress', { ...evt, service: 'comfyui-update' }); } catch { /* window gone */ }
    };
    if (!comfyReady()) return { ok: false, error: 'The managed ComfyUI is not installed yet.' };
    if (comfyMaintenance) return { ok: false, error: comfyMaintenance, busy: true };
    comfyMaintenance = 'A ComfyUI update is already running.';
    try {
      const uv = await ensureUv({ appRoot: APP_ROOT, onLine: (t) => send({ kind: 'log', text: t }) });
      if (!uv) throw new Error('Could not find or install uv (the Python toolchain manager).');
      // The update replaces files a running ComfyUI has open — and Windows will
      // not delete a loaded .pyd at all — so stop it first and give the tree a
      // moment to be released.
      const wasRunning = !!handles.comfyui || !!starting.comfyui;
      if (wasRunning) {
        send({ kind: 'log', text: 'Stopping ComfyUI — the update replaces files it has open.\n' });
        stopService('comfyui');
        await sleep(2000);
      }
      const res = await updateComfyUI({
        uv, appRoot: APP_ROOT, installDir: COMFY_DIR, dataDir: COMFY_DATA, venvDir: COMFY_VENV,
        appVersion: app.getVersion(), onProgress: send,
      });
      log(`Managed ComfyUI update: ${res.summary}`);
      return { ok: true, changed: res.changed, summary: res.summary, wasRunning };
    } catch (err) {
      const message = err?.message || String(err);
      log(`Managed ComfyUI update failed: ${message}`);
      send({ kind: 'error', text: message });
      return { ok: false, error: message };
    } finally {
      comfyMaintenance = null;
    }
  });

  // Full reinstall. Needed when an update cannot be incremental — a Python
  // version bump invalidates every wheel in the lock — and useful as a repair for
  // an environment that has been broken by hand.
  ipcMain.handle('comfyui:reinstall', async (event) => {
    const send = (evt) => {
      try { event.sender.send('setup:progress', { ...evt, service: 'comfyui-update' }); } catch { /* window gone */ }
    };
    if (comfyMaintenance) return { ok: false, error: comfyMaintenance, busy: true };
    comfyMaintenance = 'A ComfyUI install is already running.';
    try {
      stopService('comfyui');
      await sleep(2000);
      // Code and venv only — NEVER the data dir. Models, inputs, outputs and the
      // ComfyUI database live there and are multi-GB to replace.
      send({ kind: 'log', text: 'Removing the existing ComfyUI environment (models and outputs are kept)…\n' });
      for (const dir of [COMFY_VENV, COMFY_DIR]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          throw new Error(`Could not remove ${dir}: ${err.message}. Close anything using that folder and try again.`);
        }
      }
      // Only ComfyUI's own progress is interesting here — doSetup also reports on
      // Mesh Tools, whose "done" would look like this job finishing.
      await doSetup({ comfyui: true }, (evt) => { if (!evt.service || evt.service === 'comfyui') send(evt); });
      log('Managed ComfyUI reinstalled.');
      return { ok: true };
    } catch (err) {
      const message = err?.message || String(err);
      log(`Managed ComfyUI reinstall failed: ${message}`);
      send({ kind: 'error', text: message });
      return { ok: false, error: message };
    } finally {
      comfyMaintenance = null;
    }
  });
}

// A managed ComfyUI counts as installed only if BOTH its venv is tagged/usable
// and the code is on disk — the two live in separate folders, so either can go
// missing on its own (a cleared data dir, an interrupted download).
function comfyReady() {
  return isReady(COMFY_VENV, COMFY_SETUP_TAG) && fs.existsSync(path.join(COMFY_DIR, 'main.py'));
}

// Whether this platform has a shipped dependency set at all. Reported to the UI
// so the install option is hidden rather than offered and then failed.
function comfyAvailable() {
  try {
    return comfyAvailableHere(loadComfyManifest(APP_ROOT));
  } catch {
    return false;
  }
}

// Provision the Python services with uv, forwarding progress to `send`. Skips a
// service that is already set up (so the in-app "install rigging" path doesn't
// needlessly reinstall Mesh Tools).
async function doSetup(opts, send) {
  const { rigging = false, comfyui = false } = opts || {};
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

  if (comfyui && !comfyReady()) {
    const result = await setupComfyUI({
      uv, appRoot: APP_ROOT, installDir: COMFY_DIR, dataDir: COMFY_DATA, venvDir: COMFY_VENV,
      // Recorded in the install state, so a later update can report which app
      // version provisioned what is on disk.
      appVersion: app.getVersion(),
      onProgress: (e) => send({ service: 'comfyui', ...e }),
    });

    const applied = await applyManagedComfySettings();
    if (applied) {
      log(`ComfyUI installed at ${COMFY_DIR}; set as the default on port ${applied.port}.`);
    } else {
      // The install itself succeeded — don't fail the whole setup over the
      // settings write, but say so, because nothing will point at it yet.
      log('ComfyUI installed, but writing the app settings failed.');
      send({
        service: 'comfyui', kind: 'log',
        text: `\nWARNING: could not save settings automatically. Set Settings -> ComfyUI path to ${COMFY_DIR}.\n`,
      });
    }
  }
}

// Point apis.comfyui.* at the managed install and flag it `managed`. Called after
// a successful install, and again from Settings ("Use the managed ComfyUI") for
// anyone whose settings drifted to an external instance — without this second
// path there is no way back, because the installer short-circuits once the
// install exists and so never re-writes these fields.
// Returns { port } on success, null if the settings write failed.
async function applyManagedComfySettings() {
  // '127.0.0.1': matches ComfyUI's own --listen flag (comfysetup.cjs) — see
  // portFree's doc comment for why the host argument isn't optional here.
  const port = await pickFreePort(COMFY_PORT_DEFAULT, 20, '127.0.0.1');
  const ok = await patchSettings({
    apis: {
      comfyui: {
        managed: true,
        path: COMFY_DIR,
        modelsPath: path.join(COMFY_DATA, 'models'),
        url: 'http://127.0.0.1',
        port: String(port),
      },
    },
  });
  if (!ok) return null;
  if (SERVICES?.comfyui) SERVICES.comfyui.port = port;
  return { port };
}

// IPC for the port-conflict prompt window (portPrompt.html). Registered
// unconditionally at boot, like registerSetupIpc/registerServicesIpc — cheap,
// and inert on launches where the window never appears.
function registerPortPromptIpc() {
  ipcMain.handle('port-prompt:check', async (_e, { port } = {}) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { ok: false, error: 'Enter a whole number between 1 and 65535.' };
    }
    return { ok: true, free: await portFree(p) };
  });
}

// Global setup IPC — used by BOTH the first-run window and the running app
// (Settings → Rigging "install" action). Progress streams back to whichever
// window invoked it; on success the newly-provisioned services are launched.
function registerSetupIpc() {
  ipcMain.handle('setup:status', () => ({
    desktop: true,
    meshtools: isReady(PY_VENV, MESHTOOLS_REQS_TAG),
    rigging: isReady(RIG_VENV),
    comfyui: comfyReady(),
    comfyuiAvailable: comfyAvailable(),
  }));

  ipcMain.handle('setup:run', async (event, opts = {}) => {
    const send = (evt) => { try { event.sender.send('setup:progress', evt); } catch { /* window gone */ } };
    try {
      await doSetup({ rigging: !!opts.rigging, comfyui: !!opts.comfyui }, send);
      // Provisioned only — services are started on demand (or from Settings),
      // not here, so installing doesn't spin up a process the user isn't using.
      log('Setup run complete.');
      return {
        ok: true,
        status: {
          meshtools: isReady(PY_VENV, MESHTOOLS_REQS_TAG),
          rigging: isReady(RIG_VENV),
          comfyui: comfyReady(),
        },
      };
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

// Shown once, only when the backend's port is occupied (see resolveBackendPort).
// Modeled on runFirstRunSetup: a real interactive window (title bar, not
// resizable). Resolves on EITHER an explicit confirm OR the window being
// closed — closing without confirming is a valid outcome (falls back to the
// auto-suggested free port, NOT persisted — see the confirm handler below) so
// this can never hang boot.
function promptForBackendPort(occupiedPort, suggestedPort) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480, height: 340, resizable: false, backgroundColor: '#0d0f14',
      title: '3D Gen Studio — Port in use', show: true, center: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    portPromptWindow = win;
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'portPrompt.html'), {
      query: { occupied: String(occupiedPort), suggested: String(suggestedPort) },
    });

    let resolved = false;
    const done = (port) => {
      if (resolved) return;
      resolved = true;
      portPromptWindow = null;
      resolve(port);
    };
    ipcMain.once('port-prompt:confirm', (_e, { port } = {}) => {
      const chosen = Number(port);
      writeSavedBackendPort(chosen); // only an explicit confirm is remembered
      done(chosen);
      if (!win.isDestroyed()) win.close();
    });
    win.on('closed', () => {
      if (!resolved) log(`Port prompt closed without confirming — using the suggested port ${suggestedPort}.`);
      done(suggestedPort);
    });
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

// Runs on EVERY launch, before the backend is spawned — a port conflict is a
// per-launch condition (whatever else is running on the machine that day),
// never gated on first-run/venv state the way runFirstRunSetup() is.
//
// process.env.PORT is an explicit override and is trusted unconditionally: no
// check, no prompt. It's also what server.js's own `PORT` const reads, so the
// two processes agree without this function's involvement.
async function resolveBackendPort() {
  if (process.env.PORT) return BACKEND_PORT_DEFAULT;

  const candidate = readSavedBackendPort() || BACKEND_PORT_DEFAULT;
  if (await portFree(candidate)) return candidate;

  log(`Backend port ${candidate} is already in use — asking the user to confirm another.`);
  const suggested = await pickFreePort(candidate + 1);
  return promptForBackendPort(candidate, suggested);
}

async function boot() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });

  registerPortPromptIpc();
  BACKEND_PORT = await resolveBackendPort();
  BACKEND_ORIGIN = `http://localhost:${BACKEND_PORT}`;

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

  // Fire the opt-in service auto-starts AFTER the window is up so they never
  // delay launch (fire-and-forget — each service reports its own readiness).
  autoStartServices();
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
    const win = mainWindow || setupWindow || portPromptWindow;
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
