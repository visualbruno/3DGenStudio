// Electron main process for 3D Gen Studio.
//
// Responsibilities:
//   1. Resolve the app root + a writable data directory.
//   2. Spawn the Node/Express backend (server.js) using Electron's own Node
//      runtime (ELECTRON_RUN_AS_NODE) so users don't need Node installed.
//   3. FIRST RUN: show a setup window that provisions the Python services with
//      uv (Mesh Tools always; Rigging, Motion Generation and a managed ComfyUI
//      opt-in) and streams live progress. Later runs skip straight to the splash
//      — the venvs exist.
//   4. Launch the Python services on demand (Mesh Tools, Rigging, Motion, ComfyUI).
//   5. Wait for the backend to answer, then open the app window.
//   6. Kill child processes on quit.

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
  setupMocap,
  setupKimodo,
  startPythonServer,
  startSkintokens,
  startKimodo,
  startMocap,
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

// Every port below is a PREFERENCE, not a reservation: a user's own ComfyUI, a
// container publishing the same number, or an orphan from a hard kill can already
// hold it. Binding on top of one fails with EADDRINUSE after the process has
// spawned, which surfaces as a mystery timeout — so each is probed and, if taken,
// resolved before anything starts (see resolvePort / resolveBackendPort).
// An explicit env override is the user's decision and is never remapped.
let BACKEND_PORT = Number(process.env.PORT) || 3001;
let BACKEND_ORIGIN = `http://localhost:${BACKEND_PORT}`;
const BACKEND_PORT_PINNED = Boolean(process.env.PORT);
const PYTHON_PORT = Number(process.env.MESHTOOLS_PORT) || 8200;
const RIG_PORT = Number(process.env.RIGTOOLS_PORT) || 8300;
const MOTION_PORT = Number(process.env.KIMODO_PORT) || 8400;
const MOCAP_PORT = Number(process.env.MOCAP_PORT) || 8401;
// Which repo the motion service's 16 GB text-encoder base comes from. The
// official meta-llama repo is GATED — it 403s until the user requests access and
// runs `hf auth login` — so the default is the ungated mirror of the same
// weights, matching what run.bat sets for the CLI. Override with KIMODO_LLAMA_BASE
// (setting it to meta-llama/Meta-Llama-3-8B-Instruct uses the official repo).
const LLAMA_BASE = process.env.KIMODO_LLAMA_BASE || 'NousResearch/Meta-Llama-3-8B-Instruct';
// ComfyUI's conventional port. The managed install must NOT assume it's free —
// plenty of users already run their own ComfyUI there — so this is only the first
// candidate; the actual port is picked at install time and stored in settings.
const COMFY_PORT_DEFAULT = Number(process.env.COMFYUI_PORT) || 8188;

const APP_ROOT = app.getAppPath();
const SERVER_JS = path.join(APP_ROOT, 'server.js');
const PYTHON_DIR = path.join(APP_ROOT, 'python-server');
const SKINTOKENS_DIR = path.join(APP_ROOT, 'thirdparty', 'skintokens');
const KIMODO_DIR = path.join(APP_ROOT, 'thirdparty', 'kimodo');
const MOCAP_DIR = path.join(APP_ROOT, 'thirdparty', 'mocapanything');

// Backend keys data/ off process.cwd() (storage.js); point it at a per-user
// writable dir. The venvs also live here — the installed app dir is read-only.
const DATA_ROOT = process.env.GENSTUDIO_DATA_ROOT || app.getPath('userData');
const LOG_DIR = path.join(DATA_ROOT, 'logs');
const PY_VENV = path.join(DATA_ROOT, 'python-venv');
const RIG_VENV = path.join(DATA_ROOT, 'rig-venv');
// Rigging model weights (experiments/, models/) — the installed app dir is
// read-only, so download them here and point rig_server.py at it.
const RIG_DATA = path.join(DATA_ROOT, 'rig-data');
const MOTION_VENV = path.join(DATA_ROOT, 'motion-venv');
// Everything the motion service writes: the embedding cache, the rebased LLM2Vec
// adapter, and — unless Settings points the model folder elsewhere — the Kimodo
// checkpoint and the 16 GB Llama-3 base beneath checkpoints/.
const MOTION_DATA = path.join(DATA_ROOT, 'motion-data');
const MOCAP_VENV = path.join(DATA_ROOT, 'mocap-venv');
// Everything the video-to-motion service writes: the per-rig bakes (a few
// hundred MB each) and — unless Settings points the model folder elsewhere —
// the 460 MB checkpoint beneath checkpoints/. The installed app dir is
// read-only, so this must not live beside the vendored model tree.
const MOCAP_DATA = path.join(DATA_ROOT, 'mocap-data');
// Kimodo's text encoder is LLM2Vec over Meta Llama 3, so installing it downloads
// Llama-3-8B-Instruct weights — which are licensed, not merely open. The Meta Llama 3
// Community License requires the user to accept it ("By clicking 'I Accept' below or
// by using or distributing any portion or element of the Llama Materials"), so the
// install is gated on an explicit acceptance recorded here.
//
// The gate is enforced in doSetup(), NOT in the UI: there are two ways to install the
// motion service — the first-run setup window and Settings — and a check in one of
// them would leave the other as an unlocked side door.
const LLAMA_LICENSE_FILE = path.join(APP_ROOT, 'META-LLAMA-3-LICENSE');
const LLAMA_ACCEPT_FILE = path.join(DATA_ROOT, 'meta-llama-3-license-accepted.json');
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
let shuttingDown = false;

// The Python services are started ON DEMAND (not at boot) and can be stopped
// from Settings — stopping the rigging or motion service fully releases its GPU
// memory (the CUDA context an in-process unload can't free). `handles[name]`
// holds a running service's { stop() }; `starting[name]` dedupes concurrent
// ensure() calls. The registry is populated after the launchers are defined.
const handles = { meshtools: null, rigging: null, motion: null, mocap: null, comfyui: null };
const starting = { meshtools: null, rigging: null, motion: null, mocap: null, comfyui: null };
// Services answering on their port that we did NOT spawn — an orphan of a hard
// kill, or a copy the user runs themselves. They work, so the UI must not call
// them "Stopped", but there is no handle to kill and quitting must not try.
const adopted = new Set();
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

// Shell preferences: a tiny JSON file the MAIN process owns, for the few
// settings that have to be readable BEFORE the backend — and therefore the
// normal settings store — exists. "Clear the logs at startup" is one: resetLogs()
// runs before startBackend(), so it cannot ask the database.
const SHELL_PREFS_FILE = path.join(DATA_ROOT, 'shell-prefs.json');
const SHELL_PREFS_DEFAULTS = { clearLogsAtStartup: true };

function readShellPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SHELL_PREFS_FILE, 'utf8'));
    return { ...SHELL_PREFS_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...SHELL_PREFS_DEFAULTS }; // absent or corrupt -> defaults
  }
}

function writeShellPrefs(patch) {
  const next = { ...readShellPrefs(), ...patch };
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(SHELL_PREFS_FILE, JSON.stringify(next, null, 2));
  return next;
}

function openLogStream(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return fs.createWriteStream(path.join(LOG_DIR, name), { flags: 'a' });
}

// Every log this app writes. Kept in one place because both the startup reset
// below and the Logs panel (logs.js, via the backend) key off these names.
const LOG_FILES = ['desktop.log', 'backend.log', 'python.log', 'rig.log', 'kimodo.log', 'comfyui.log'];

// Start each launch with empty logs (unless the user opted out in the Logs
// panel), so whatever a user reads in the Logs panel
// — or sends us — is this session and nothing else. Without it the files grow
// without bound and every report needs "scroll to the end and guess where your
// last restart was".
//
// The old file is kept alongside as <name>.prev.log rather than deleted: when
// something crashes, the log worth having is the one from the run that just
// died, and by then the user has already relaunched. Exactly one generation is
// kept, so the directory stays bounded.
//
// MUST run before anything opens a log — i.e. before startBackend() and before
// any service start() calls openLogStream().
function resetLogs() {
  // Opt-out (Logs panel -> "Clear the logs at startup"): keep appending to the
  // existing files instead. They then grow without bound, which is the point —
  // it is for chasing something that only shows up across restarts.
  if (!readShellPrefs().clearLogsAtStartup) {
    log('Keeping the existing logs ("Clear the logs at startup" is off in the Logs panel).');
    return;
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    return; // no log dir → nothing to rotate; logging must never block startup
  }
  for (const name of LOG_FILES) {
    const current = path.join(LOG_DIR, name);
    if (!fs.existsSync(current)) continue;
    const previous = path.join(LOG_DIR, name.replace(/\.log$/, '.prev.log'));
    try {
      fs.rmSync(previous, { force: true }); // Windows rename won't clobber
      fs.renameSync(current, previous);
    } catch {
      // A leftover process from a previous run can still hold the file open on
      // Windows, which fails the rename. Truncating in place loses the previous
      // session but still gives this one a clean file.
      try { fs.truncateSync(current, 0); } catch { /* give up quietly */ }
    }
  }
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
      // Lets the backend serve /api/logs — the desktop shell owns the log
      // directory, so it has to tell the backend where it is.
      GENSTUDIO_LOG_DIR: LOG_DIR,
      // Lifetime tether: if this main process dies without running `shutdown`
      // (Task Manager "End task", a crash), the backend polls this pid and exits
      // on its own. Without it the orphan lives on as a window-less
      // "3D Gen Studio.exe" and blocks the next install (see build/installer.nsh).
      GENSTUDIO_PARENT_PID: String(process.pid),
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

// Can we bind this port on this address? Only EADDRINUSE/EACCES mean "taken" —
// an IPv6 probe on a machine with IPv6 disabled fails for reasons that say
// nothing about the port, and treating that as a conflict would remap every
// service on every launch.
function bindable(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Is a TCP port free? Every address is probed, not just loopback, because
// "free" is per-address on Windows (libuv sets SO_REUSEADDR): a program holding
// 0.0.0.0:8200 is INVISIBLE to a 127.0.0.1 probe, which happily succeeds — and
// the service then dies on EADDRINUSE seconds later, looking like a startup
// hang rather than a port clash. The app has services of both kinds: the Node
// backend binds every interface, the Python services bind 127.0.0.1 only. So a
// port only counts as free when nothing holds any of these.
const PROBE_HOSTS = ['0.0.0.0', '127.0.0.1', '::', '::1'];

async function portFree(port) {
  for (const host of PROBE_HOSTS) {
    if (!(await bindable(port, host))) return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns null when nothing in the window is free — callers must handle that
// rather than binding a port this never vouched for.
async function pickFreePort(start, tries = 20) {
  for (let p = start; p < start + tries; p += 1) {
    if (await portFree(p)) return p;
  }
  return null;
}

// --- Port conflict resolution -------------------------------------------------
// A taken port is resolved by asking three questions in order:
//   1. Is it free?               -> use it
//   2. Is it OUR service, alive? -> reuse it (an orphan of a hard kill, or a copy
//                                  the user started by hand); a second instance
//                                  would only fight it
//   3. Someone else holds it     -> move to the next free port and PERSIST that
//                                  choice, so the backend's proxy (server.js) and
//                                  the Settings UI agree with what actually bound
// ComfyUI leaves this sequence after step 1: a listener on 8188 is usually the
// user's own ComfyUI, which they may well prefer over a second copy competing for
// the same VRAM, so that one asks instead of deciding (resolveComfyPort).

// Remaps made this launch, reported to the user once. Keyed by service so a
// repeated probe can't double-report.
const portRemaps = new Map();
let portRemapTimer = null;

// Write a service's real port back through the backend. Best-effort: an
// unreachable backend costs consistency, not the start.
async function persistPort(svc, port) {
  if (!svc.settingsKey) return;
  const ok = await patchSettings({ apis: { [svc.settingsKey]: { port: String(port) } } });
  if (!ok) log(`${svc.label}: could not save port ${port} to settings — the backend may still proxy to the old one.`);
}

// The port `svc` should actually bind, or null when the caller should NOT start
// it (something equivalent already answers there). Never mutates svc.port — the
// caller assigns, so status and health checks read one source of truth.
async function resolvePort(name, svc) {
  const wanted = svc.port;
  if (await portFree(wanted)) return wanted;

  // ComfyUI goes first: unlike the others, a healthy instance on its port is not
  // automatically the one to use — a user's own ComfyUI does not have the node
  // packs the managed install provides, and adopting it silently turns a port
  // clash into workflows failing with "node not found" much later.
  if (name === 'comfyui') return resolveComfyPort(svc);

  if (await isHealthy(wanted, svc.healthPath)) {
    log(`${svc.label}: port ${wanted} already answers a health check — reusing that instance.`);
    adopted.add(name);
    return null;
  }

  const next = await pickFreePort(wanted + 1);
  if (!next) {
    log(`${svc.label}: port ${wanted} is taken and nothing in the 20 ports above it is free.`);
    return wanted; // fail loudly on the bind rather than silently doing nothing
  }
  log(`${svc.label}: port ${wanted} is used by another program → moving to ${next}.`);
  await persistPort(svc, next);
  notePortRemap(name, svc.label, wanted, next);
  return next;
}

// Does the ComfyUI answering on this port belong to us? /system_stats reports the
// process argv, and ours always carries the managed install's own directories
// (startComfyUI passes --models-directory & friends under COMFY_DATA). Older
// ComfyUI builds omit argv — then the answer is "unknown", which is reported as
// not-ours so the user gets the choice rather than a silent adoption.
function isManagedComfy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/system_stats', timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const argv = JSON.parse(body)?.system?.argv;
          const line = Array.isArray(argv) ? argv.join(' ') : '';
          resolve(Boolean(line) && (line.includes(COMFY_DATA) || line.includes(COMFY_DIR)));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// A busy ComfyUI port is ambiguous in a way the others are not, so it is the one
// case that asks. Returns the port to start on, or null to use what is already
// running; throws if the user cancels (ensureService surfaces that as the error).
async function resolveComfyPort(svc) {
  const wanted = svc.port;
  const theirs = await isHealthy(wanted, '/system_stats');

  // Our own managed install, left behind by a hard kill or started by hand?
  // Then there is nothing to ask about — adopt it like any other service.
  if (theirs && await isManagedComfy(wanted)) {
    log(`ComfyUI: the managed install is already running on port ${wanted} — reusing it.`);
    adopted.add('comfyui');
    return null;
  }

  const next = await pickFreePort(wanted + 1);

  const buttons = [];
  if (theirs) buttons.push('Use the running ComfyUI');
  if (next) buttons.push(`Start mine on port ${next}`);
  buttons.push('Cancel');

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '3D Gen Studio — ComfyUI port in use',
    message: theirs
      ? `A ComfyUI is already running on port ${wanted}.`
      : `Port ${wanted} is already used by another program.`,
    detail: theirs
      ? '3D Gen Studio can use that one instead of starting its own copy — two ComfyUI instances would compete for the same GPU memory.'
        + (next ? `\n\nOr it can start its own managed ComfyUI on port ${next} and leave the running one alone.` : '')
      : `The managed ComfyUI cannot start there.`
        + (next ? ` It can use port ${next} instead.` : ' No free port was found nearby either.'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });

  const choice = buttons[response];
  if (choice === 'Use the running ComfyUI') {
    // Point the app at it as an EXTERNAL instance: `managed` is what makes the app
    // treat ComfyUI as its own to launch, and this one is not ours. Settings →
    // "Use the managed ComfyUI" is the way back.
    await patchSettings({ apis: { comfyui: { managed: false, url: 'http://127.0.0.1', port: String(wanted) } } });
    log(`Using the ComfyUI already running on port ${wanted} instead of the managed one.`);
    return null;
  }
  if (choice === 'Cancel' || !next) {
    throw new Error(`Port ${wanted} is in use, so ComfyUI was not started. Pick a different port in Settings → ComfyUI.`);
  }
  log(`ComfyUI: port ${wanted} is taken → starting the managed install on ${next}.`);
  await persistPort(svc, next);
  notePortRemap('comfyui', svc.label, wanted, next);
  return next;
}

// Tell the user once, not per service. Debounced because several services can
// remap within a second of each other at auto-start; and because the new numbers
// are saved, this dialog does not come back on the next launch.
function notePortRemap(name, label, from, to) {
  portRemaps.set(name, { label, from, to });
  if (portRemapTimer) clearTimeout(portRemapTimer);
  portRemapTimer = setTimeout(() => {
    portRemapTimer = null;
    const lines = [...portRemaps.values()].map((r) => `  • ${r.label}: ${r.from} → ${r.to}`);
    portRemaps.clear();
    if (!lines.length || shuttingDown) return;
    dialog.showMessageBox({
      type: 'info',
      title: '3D Gen Studio — ports changed',
      message: lines.length === 1
        ? 'A port 3D Gen Studio wanted was already in use, so it moved to a free one.'
        : 'Some ports 3D Gen Studio wanted were already in use, so it moved to free ones.',
      detail: `${lines.join('\n')}\n\nThis has been saved — you can change it in Settings.`,
      buttons: ['OK'],
      noLink: true,
    }).catch(() => {});
  }, 2500);
  if (portRemapTimer.unref) portRemapTimer.unref();
}

// The backend's own port has to be settled BEFORE it spawns: nothing can ask it
// where it lives afterwards. Nothing external depends on the number — the
// production bundle uses same-origin URLs and the window loads BACKEND_ORIGIN —
// so this one moves silently. server.js publishes wherever it landed to
// data/runtime.json for the MCP bridge.
async function resolveBackendPort() {
  if (BACKEND_PORT_PINNED) return;
  if (await portFree(BACKEND_PORT)) return;
  const next = await pickFreePort(BACKEND_PORT + 1);
  if (!next) {
    log(`Backend port ${BACKEND_PORT} is in use and no nearby port is free — starting anyway.`);
    return;
  }
  log(`Backend port ${BACKEND_PORT} is in use → using ${next}.`);
  BACKEND_PORT = next;
  BACKEND_ORIGIN = `http://localhost:${next}`;
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
    apis.motiontools?.autoStart ? 'motion' : null,
    apis.mocaptools?.autoStart ? 'mocap' : null,
    apis.comfyui?.managed && apis.comfyui?.autoStart ? 'comfyui' : null,
  ].filter(Boolean);
  for (const name of wanted) {
    log(`Auto-starting ${name} service (enabled in Settings)`);
    ensureService(name).catch((err) => log(`Auto-start of ${name} failed: ${err?.message || err}`));
  }
}

// --- On-demand Python service management ------------------------------------

// Read a service's configured port out of settings onto the registry entry, so
// the health checks and status reporting elsewhere see the same number the
// process is about to bind. Every service whose port the Settings UI exposes
// needs this — without it a user's port change is honoured by the backend's
// proxy (server.js) but ignored by the launcher, and the two talk past each
// other. Returns the service's whole api settings block for callers that want
// more out of it (model folders). Best-effort: an unreachable backend leaves
// the default in place rather than blocking the start.
async function resolveConfiguredPort(svc, fallback) {
  const settings = await fetchSettings();
  const api = settings?.apis?.[svc.settingsKey] || {};
  const p = Number(api.port);
  svc.port = Number.isFinite(p) && p > 0 ? p : fallback;
  return api;
}

function serviceRegistry() {
  return {
    meshtools: {
      // reqsTag: a requirements.txt bump flips this service back to
      // "not installed" until setup re-runs (incrementally) and re-tags it.
      label: 'Mesh Tools', venv: PY_VENV, port: PYTHON_PORT, reqsTag: MESHTOOLS_REQS_TAG, logFile: 'python.log',
      settingsKey: 'meshtools',
      resolveLaunch: (svc) => resolveConfiguredPort(svc, PYTHON_PORT),
      start(port) {
        return startPythonServer({
          serviceDir: PYTHON_DIR, venvDir: PY_VENV, port,
          logStream: openLogStream('python.log'), log,
        });
      },
    },
    rigging: {
      label: 'Rigging', venv: RIG_VENV, port: RIG_PORT, logFile: 'rig.log',
      settingsKey: 'rigtools',
      resolveLaunch: (svc) => resolveConfiguredPort(svc, RIG_PORT),
      start(port) {
        return startSkintokens({
          serviceDir: SKINTOKENS_DIR, venvDir: RIG_VENV, dataDir: RIG_DATA, port,
          logStream: openLogStream('rig.log'), log,
        });
      },
    },
    motion: {
      label: 'Motion Generation', venv: MOTION_VENV, port: MOTION_PORT, logFile: 'kimodo.log',
      settingsKey: 'motiontools',
      // Port and model folder both live in settings, so they are read at start
      // time — changing either in Settings takes effect on the next start rather
      // than on the next app launch.
      resolveLaunch: async (svc) => {
        const api = await resolveConfiguredPort(svc, MOTION_PORT);
        svc.modelsDir = String(api.modelsPath || '').trim() || null;
      },
      start(port) {
        return startKimodo({
          serviceDir: KIMODO_DIR, venvDir: MOTION_VENV, dataDir: MOTION_DATA,
          modelsDir: this.modelsDir, llamaBase: LLAMA_BASE, port,
          logStream: openLogStream('kimodo.log'), log,
        });
      },
    },
    mocap: {
      label: 'Video to Motion', venv: MOCAP_VENV, port: MOCAP_PORT, logFile: 'mocap.log',
      settingsKey: 'mocaptools',
      // Same as motion: port and model folder are read at start time, so a
      // change in Settings takes effect on the next start rather than the next
      // app launch.
      resolveLaunch: async (svc) => {
        const api = await resolveConfiguredPort(svc, MOCAP_PORT);
        svc.modelsDir = String(api.modelsPath || '').trim() || null;
      },
      start(port) {
        return startMocap({
          serviceDir: MOCAP_DIR, venvDir: MOCAP_VENV, dataDir: MOCAP_DATA,
          modelsDir: this.modelsDir, port,
          logStream: openLogStream('mocap.log'), log,
        });
      },
    },
    comfyui: {
      // ComfyUI has no /health endpoint; /system_stats is its readiness probe and
      // only answers once the server is actually accepting API calls.
      label: 'ComfyUI', venv: COMFY_VENV, port: COMFY_PORT_DEFAULT, logFile: 'comfyui.log',
      healthPath: '/system_stats', reqsTag: COMFY_SETUP_TAG,
      settingsKey: 'comfyui',
      // Venv AND code dir must both be present — see comfyReady().
      isInstalled: () => comfyReady(),
      // The port is chosen at install time (to dodge a user's own ComfyUI) and
      // stored in settings, so it must be read at start time, not at boot.
      resolveLaunch: (svc) => resolveConfiguredPort(svc, COMFY_PORT_DEFAULT),
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
  if (adopted.delete(name)) {
    // Not our process to kill — killing someone else's ComfyUI because the user
    // pressed Stop in OUR settings panel would be a nasty surprise.
    log(`${name} is running outside 3D Gen Studio — leaving it alone.`);
  }
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
    // Services configured through Settings read that configuration now and cache
    // it on the registry entry, so status/health checks elsewhere see the real
    // port. Best-effort: an unreachable backend leaves the defaults in place
    // rather than blocking the start.
    if (svc.resolveLaunch) {
      try { await svc.resolveLaunch(svc); } catch { /* keep the defaults */ }
    }
    if (handles[name]) {
      if (await isHealthy(svc.port, svc.healthPath)) return;
      stopService(name); // crashed → restart
    }

    // Somebody else may hold the configured port. This is the last moment before
    // the bind, and the only one that sees the truth — a port free at install or
    // at boot can be taken by the time the user asks for the service. null means
    // an equivalent instance already answers there, so there is nothing to start.
    const port = await resolvePort(name, svc);
    if (port === null) return;
    adopted.delete(name); // this one is ours from here on
    svc.port = port;

    log(`Starting ${name} service on demand (port ${port})`);
    const handle = svc.start(port);
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

// An adoption is inferred, not owned: nothing tells us when an externally-started
// service dies, so without this the UI would report "Running" forever. Cheap in
// the normal case — `adopted` is empty.
async function pruneAdopted() {
  for (const name of [...adopted]) {
    const svc = SERVICES?.[name];
    if (!svc || !(await isHealthy(svc.port, svc.healthPath))) {
      adopted.delete(name);
      log(`${svc?.label || name} is no longer answering on port ${svc?.port} — no longer reported as running.`);
    }
  }
}

function serviceStatus() {
  const out = {};
  for (const [name, svc] of Object.entries(SERVICES)) {
    out[name] = {
      label: svc.label,
      installed: serviceInstalled(svc),
      running: !!handles[name] || adopted.has(name),
      starting: !!starting[name],
      // Answering, but not spawned by us — Stop cannot touch it.
      external: adopted.has(name),
    };
  }
  return out;
}

function registerServicesIpc() {
  ipcMain.handle('services:status', async () => { await pruneAdopted(); return serviceStatus(); });
  // Reveal the log directory in the OS file manager. The Logs panel reads the
  // files over the API; this is the escape hatch for attaching them to a bug
  // report — and the only way to reach the previous session's *.prev.log.
  ipcMain.handle('logs:open-folder', async () => {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const error = await shell.openPath(LOG_DIR);
      return error ? { ok: false, error } : { ok: true, path: LOG_DIR };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Whether the shell wipes the logs at startup. Read/written here rather than
  // through the settings API because resetLogs() runs before the backend is up.
  ipcMain.handle('logs:get-prefs', () => ({
    ok: true,
    clearAtStartup: readShellPrefs().clearLogsAtStartup !== false,
  }));
  ipcMain.handle('logs:set-prefs', (_e, { clearAtStartup } = {}) => {
    try {
      const next = writeShellPrefs({ clearLogsAtStartup: Boolean(clearAtStartup) });
      log(`Logs: clear at startup is now ${next.clearLogsAtStartup ? 'ON' : 'OFF'}.`);
      return { ok: true, clearAtStartup: next.clearLogsAtStartup };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
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
  const { rigging = false, motion = false, mocap = false, comfyui = false } = opts || {};
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

  // Gate the DOWNLOAD, not the request: a re-run with motion already installed has
  // nothing to fetch, and failing an idempotent call would be a worse answer than
  // doing nothing. Settings still shows the licence notice in that case.
  if (motion && !isReady(MOTION_VENV) && !llamaLicenseAccepted()) {
    throw new Error('Motion generation needs the Meta Llama 3 Community License to be accepted first — its text encoder downloads Meta Llama 3 weights. Accept it in the installer, or in Settings → Mesh Tools → Motion Generation.');
  }
  if (motion && !isReady(MOTION_VENV)) {
    // The model folder is a setting, so an install started from Settings has to
    // honour it — otherwise the weights land in the default folder and the
    // service then looks for them somewhere else.
    let modelsDir = null;
    try {
      const settings = await fetchSettings();
      modelsDir = String(settings?.apis?.motiontools?.modelsPath || '').trim() || null;
    } catch { /* fall back to the default folder under MOTION_DATA */ }
    await setupKimodo({
      // appRoot: where the prebuilt motion_correction wheels ship
      // (resources/wheels/), so the foot-skate cleanup does not need a compiler.
      uv, appRoot: APP_ROOT, serviceDir: KIMODO_DIR, venvDir: MOTION_VENV, dataDir: MOTION_DATA,
      modelsDir, llamaBase: LLAMA_BASE,
      onProgress: (e) => send({ service: 'motion', ...e }),
    });
  }

  if (mocap && !isReady(MOCAP_VENV)) {
    // Same as motion: the model folder is a setting, so an install started from
    // Settings has to honour it or the checkpoint lands somewhere the service
    // will not look. No licence gate here — MoCapAnything and its weights are
    // MIT, and Blender arrives as a pip wheel.
    let modelsDir = null;
    try {
      const settings = await fetchSettings();
      modelsDir = String(settings?.apis?.mocaptools?.modelsPath || '').trim() || null;
    } catch { /* fall back to the default folder under MOCAP_DATA */ }
    await setupMocap({
      uv, serviceDir: MOCAP_DIR, venvDir: MOCAP_VENV, dataDir: MOCAP_DATA,
      modelsDir,
      onProgress: (e) => send({ service: 'mocap', ...e }),
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
  // Nothing free nearby is not fatal here: the install still records the default,
  // and the conflict is resolved again (with the user in the loop) at start time.
  const port = (await pickFreePort(COMFY_PORT_DEFAULT)) || COMFY_PORT_DEFAULT;
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

// Global setup IPC — used by BOTH the first-run window and the running app
// (Settings → Rigging "install" action). Progress streams back to whichever
// window invoked it; on success the newly-provisioned services are launched.
function registerSetupIpc() {
  ipcMain.handle('setup:status', () => ({
    desktop: true,
    meshtools: isReady(PY_VENV, MESHTOOLS_REQS_TAG),
    rigging: isReady(RIG_VENV),
    motion: isReady(MOTION_VENV),
    mocap: isReady(MOCAP_VENV),
    comfyui: comfyReady(),
    comfyuiAvailable: comfyAvailable(),
    // Whether the motion service may be installed at all (see LLAMA_ACCEPT_FILE).
    llama3License: llamaLicenseAccepted(),
  }));

  // The licence text itself, so both installers can show it in-app rather than
  // sending the user to a web page to agree to something.
  ipcMain.handle('license:llama3', () => ({
    ok: true,
    accepted: llamaLicenseAccepted(),
    text: readLlamaLicense(),
  }));

  ipcMain.handle('license:llama3-accept', () => ({
    ok: acceptLlamaLicense(),
    accepted: llamaLicenseAccepted(),
  }));

  ipcMain.handle('setup:run', async (event, opts = {}) => {
    const send = (evt) => { try { event.sender.send('setup:progress', evt); } catch { /* window gone */ } };
    try {
      await doSetup({ rigging: !!opts.rigging, motion: !!opts.motion, mocap: !!opts.mocap, comfyui: !!opts.comfyui }, send);
      // Provisioned only — services are started on demand (or from Settings),
      // not here, so installing doesn't spin up a process the user isn't using.
      log('Setup run complete.');
      return {
        ok: true,
        status: {
          meshtools: isReady(PY_VENV, MESHTOOLS_REQS_TAG),
          rigging: isReady(RIG_VENV),
          motion: isReady(MOTION_VENV),
          mocap: isReady(MOCAP_VENV),
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

function llamaLicenseAccepted() {
  try { return fs.existsSync(LLAMA_ACCEPT_FILE); } catch { return false; }
}

function readLlamaLicense() {
  try { return fs.readFileSync(LLAMA_LICENSE_FILE, 'utf8'); } catch { return null; }
}

// Records WHAT was accepted, not just that something was: the file is the evidence,
// and a future licence revision has to be distinguishable from this one.
function acceptLlamaLicense() {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(LLAMA_ACCEPT_FILE, `${JSON.stringify({
      license: 'META LLAMA 3 COMMUNITY LICENSE AGREEMENT',
      version: 'Meta Llama 3 Version Release Date: April 18, 2024',
      url: 'https://llama.meta.com/llama3/license',
      acceptedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    log(`Recording the Meta Llama 3 licence acceptance failed: ${err.message}`);
    return false;
  }
}

// First-run setup window. Resolves when the user launches (or closes) it.
function runFirstRunSetup() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      // useContentSize, so these numbers are the PAGE, not the page plus the
      // window frame — without it the content box was ~30px shorter than asked
      // for, which was part of why the install button ended up clipped.
      //
      // Resizable with a floor: the page keeps the footer pinned and scrolls the
      // service list, so a short window degrades gracefully, and a user who opens
      // the details log on a small screen can still make room for it.
      width: 780, height: 700, minWidth: 620, minHeight: 460,
      useContentSize: true, resizable: true, backgroundColor: '#0d0f14',
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
  resetLogs();
  SERVICES = serviceRegistry();
  registerSetupIpc();
  registerServicesIpc();
  // Must happen before the spawn: once the backend is running, nothing can ask
  // it to move. The Python services get the same treatment individually, at the
  // moment they start (ensureService → resolvePort).
  await resolveBackendPort();
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
  // On Windows child.kill() is TerminateProcess: no signal is delivered, so the
  // backend's own cleanup never runs and its published location outlives it.
  // Clear it here or discovery (mcp/stdio.js) keeps aiming MCP clients at a dead
  // port long after the app has quit.
  try { fs.rmSync(path.join(DATA_ROOT, 'data', 'runtime.json'), { force: true }); } catch { /* ignore */ }
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
