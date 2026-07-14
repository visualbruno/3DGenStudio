// uv-based provisioning + launch for the bundled Python services, with progress
// callbacks so the first-run setup window can show live status. Supersedes the
// older python.cjs (system-Python model).
//
// Model: uv provisions a pinned standalone Python (3.13 — see each service's
// .python-version) and a venv in a WRITABLE per-user dir (the installed app
// folder is read-only on macOS/Linux). This mirrors the CLI run.bat/run.sh and
// makes the flash-attn wheel selection for rigging deterministic.
//
//   - Mesh Tools (python-server): always provisioned. CPU only.
//   - Rigging (skintokens): opt-in. Heavy (torch + flash-attn + model) and needs
//     an NVIDIA GPU; the setup reuses the service's own Python helpers
//     (select_flash_attn.py / download_wheel.py / download.py).
//
// Everything is async and streams output to an onProgress callback; nothing
// blocks the Electron main-process event loop.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const PYVER = '3.13';
const UV_EXE = IS_WIN ? 'uv.exe' : 'uv';

function venvPython(venvDir) {
  return IS_WIN
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

// Written only after a service's deps fully install, so an interrupted first run
// is detected and re-completed next time instead of launching a broken service.
function depsMarker(venvDir) {
  return path.join(venvDir, '.deps-installed');
}

// A venv's python.exe existing on disk is NOT enough: a venv made by
// `python -m venv` depends on its base interpreter, so if that system Python was
// uninstalled/moved the venv python fails to launch ("did not find executable at
// C:\PythonXXX\python.exe", exit 103). Actually PROBE it so a broken venv is
// detected and rebuilt (uv venvs are self-contained and don't have this issue).
function venvUsable(venvDir) {
  const vp = venvPython(venvDir);
  if (!fs.existsSync(vp)) return false;
  try {
    const r = spawnSync(vp, ['-c', 'import sys'], { timeout: 20000, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function isReady(venvDir) {
  return fs.existsSync(depsMarker(venvDir)) && venvUsable(venvDir);
}

// Create the venv with uv, rebuilding from scratch if the existing one is broken
// (e.g. a legacy python -m venv whose base interpreter is gone). A healthy venv
// is left untouched. Returns an exit code (0 = ok).
async function ensureVenv({ uv, serviceDir, venvDir, onLine }) {
  if (venvUsable(venvDir)) return 0;
  if (fs.existsSync(venvDir)) {
    if (onLine) onLine(`Existing virtual environment is unusable — rebuilding it.\n`);
    try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const r = await runStream(uv, ['venv', venvDir, '--python', PYVER], { cwd: serviceDir, env: process.env, onLine });
  return r.code;
}

// Spawn a command, stream stdout+stderr line-ish chunks to onLine, resolve the
// exit code. Never rejects. `capture` also accumulates stdout for the caller.
function runStream(cmd, args, { cwd, env, onLine } = {}) {
  return new Promise((resolve) => {
    const emit = (s) => { if (onLine) try { onLine(s); } catch { /* ignore */ } };
    emit(`$ ${path.basename(cmd)} ${args.join(' ')}\n`);
    let p;
    try {
      p = spawn(cmd, args, { cwd, env: env || process.env });
    } catch (err) {
      emit(`spawn error: ${err.message}\n`);
      return resolve({ code: -1, stdout: '' });
    }
    let stdout = '';
    p.stdout.on('data', (d) => { const s = d.toString(); stdout += s; emit(s); });
    p.stderr.on('data', (d) => emit(d.toString()));
    p.on('error', (err) => { emit(`error: ${err.message}\n`); resolve({ code: -1, stdout }); });
    p.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

// Locate uv, or install it. Order: env override -> bundled resource ->
// PATH -> ~/.local/bin -> official installer (into ~/.local/bin). Returns the
// uv path, or null on failure.
async function ensureUv({ appRoot, onLine }) {
  const emit = (s) => { if (onLine) try { onLine(s); } catch { /* ignore */ } };

  const candidates = [
    process.env.GENSTUDIO_UV,
    // Bundled via electron-builder extraResources (resources/uv/uv[.exe]).
    appRoot && path.join(appRoot, 'resources', 'uv', UV_EXE),
    path.join(os.homedir(), '.local', 'bin', UV_EXE),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // On PATH?
  try {
    const probe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return 'uv';
  } catch { /* not on PATH */ }

  emit('Installing uv (Python toolchain manager)…\n');
  if (IS_WIN) {
    await runStream('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'irm https://astral.sh/uv/install.ps1 | iex',
    ], { onLine });
  } else {
    await runStream('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { onLine });
  }
  const installed = path.join(os.homedir(), '.local', 'bin', UV_EXE);
  if (fs.existsSync(installed)) return installed;
  try {
    const probe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return 'uv';
  } catch { /* still not found */ }
  return null;
}

// Run a weighted list of steps, mapping progress to 0..1 and forwarding phase +
// log events via onProgress({ kind, phase, pct, text }). A step returns an exit
// code (0 = ok); a non-zero code from a `required` step aborts with an error.
async function runSteps(steps, onProgress) {
  const total = steps.reduce((s, st) => s + (st.weight || 1), 0);
  let done = 0;
  const emitLog = (text) => onProgress({ kind: 'log', text });
  for (const step of steps) {
    onProgress({ kind: 'phase', phase: step.label, pct: done / total });
    const code = await step.run(emitLog);
    if (code !== 0 && step.required !== false) {
      throw new Error(`${step.label} failed (exit ${code}).`);
    }
    done += step.weight || 1;
    onProgress({ kind: 'phase', phase: step.label, pct: done / total });
  }
}

// ---- Mesh Tools (python-server) -------------------------------------------
async function setupPythonServer({ uv, serviceDir, venvDir, onProgress }) {
  const vp = venvPython(venvDir);
  const env = process.env;
  await runSteps([
    {
      label: 'Provisioning Python', weight: 2,
      run: (log) => runStream(uv, ['python', 'install', PYVER], { cwd: serviceDir, env, onLine: log }).then((r) => r.code),
    },
    {
      label: 'Creating virtual environment', weight: 1,
      run: (log) => ensureVenv({ uv, serviceDir, venvDir, onLine: log }),
    },
    {
      label: 'Installing mesh-tools dependencies', weight: 6,
      run: (log) => runStream(uv, ['pip', 'install', '--python', vp, '-r', 'requirements.txt'], { cwd: serviceDir, env, onLine: log }).then((r) => r.code),
    },
  ], onProgress);
  fs.writeFileSync(depsMarker(venvDir), new Date().toISOString());
  onProgress({ kind: 'done' });
}

// ---- Rigging (skintokens) --------------------------------------------------
// `dataDir` is a WRITABLE folder for the downloaded weights (experiments/,
// models/). The packaged app's code dir is read-only, so the model MUST NOT be
// downloaded there; rig_server.py chdirs to this same dir at launch (via
// RIGTOOLS_DATA_DIR) so its relative weight lookups resolve here.
async function setupSkintokens({ uv, serviceDir, venvDir, dataDir, onProgress }) {
  const vp = venvPython(venvDir);
  const env = process.env;
  const modelDir = dataDir || serviceDir;
  try { fs.mkdirSync(modelDir, { recursive: true }); } catch { /* ignore */ }

  // Provision + base deps first.
  await runSteps([
    {
      label: 'Provisioning Python', weight: 2,
      run: (log) => runStream(uv, ['python', 'install', PYVER], { cwd: serviceDir, env, onLine: log }).then((r) => r.code),
    },
    {
      label: 'Creating virtual environment', weight: 1,
      run: (log) => ensureVenv({ uv, serviceDir, venvDir, onLine: log }),
    },
    {
      label: 'Installing rigging dependencies', weight: 5,
      run: (log) => runStream(uv, ['pip', 'install', '--python', vp, '-r', 'requirements.txt'], { cwd: serviceDir, env, onLine: log }).then((r) => r.code),
    },
  ], (e) => onProgress(scaled(e, 0, 0.4)));

  // Select the flash-attn wheel + matching torch for this machine's CUDA.
  onProgress({ kind: 'phase', phase: 'Selecting CUDA build', pct: 0.4 });
  const sel = await runStream(vp, ['select_flash_attn.py'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
  let wheel = null, torchArgs = null;
  for (const line of sel.stdout.split(/\r?\n/)) {
    if (line.startsWith('WHEEL=')) wheel = line.slice(6).trim();
    else if (line.startsWith('TORCHARGS=')) torchArgs = line.slice(10).trim();
  }

  // Install torch (curated per-wheel command, or a sane default).
  onProgress({ kind: 'phase', phase: 'Installing PyTorch', pct: 0.45 });
  const torchInstall = torchArgs
    ? torchArgs.split(/\s+/)
    : ['torch==2.7.0', 'torchvision==0.22.0', 'torchaudio==2.7.0', '--index-url', 'https://download.pytorch.org/whl/cu128'];
  {
    const r = await runStream(uv, ['pip', 'install', '--python', vp, ...torchInstall], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error(`PyTorch install failed (exit ${r.code}).`);
  }

  // flash-attn — download the prebuilt wheel via the HF client, then install it.
  if (wheel) {
    onProgress({ kind: 'phase', phase: 'Installing flash-attn', pct: 0.65 });
    const dl = await runStream(vp, ['download_wheel.py', wheel], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    const localWheel = dl.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (dl.code === 0 && localWheel) {
      const r = await runStream(uv, ['pip', 'install', '--python', vp, localWheel], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
      if (r.code !== 0) throw new Error('flash-attn install failed. Rigging cannot start without it.');
    } else {
      throw new Error('flash-attn download failed. Rigging cannot start without it.');
    }
  } else {
    throw new Error('No prebuilt flash-attn wheel matched this GPU/CUDA. Rigging is unavailable.');
  }

  // Model checkpoints (large; downloaded into the WRITABLE data dir).
  onProgress({ kind: 'phase', phase: 'Downloading model checkpoints', pct: 0.8 });
  {
    const r = await runStream(vp, ['download.py', '--model', '--dir', modelDir], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error(`Model download failed (exit ${r.code}).`);
  }

  fs.writeFileSync(depsMarker(venvDir), new Date().toISOString());
  onProgress({ kind: 'phase', phase: 'Rigging ready', pct: 1 });
  onProgress({ kind: 'done' });
}

// Remap a child onProgress event's pct into a [lo, hi] slice of the parent bar.
function scaled(evt, lo, hi) {
  if (evt.kind === 'phase' && typeof evt.pct === 'number') {
    return { ...evt, pct: lo + (hi - lo) * evt.pct };
  }
  return evt;
}

// Kill a process AND its descendants. The rigging service is a tree —
// rig_server.py spawns bpy_server.py as a child — and a plain proc.kill() only
// terminates the direct child, orphaning bpy_server (which then keeps holding
// the rig venv). On Windows `taskkill /T` walks the whole PID tree; on POSIX we
// signal the process group.
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
    }
  } catch { /* already gone */ }
}

// ---- Launchers -------------------------------------------------------------
function startPythonServer({ serviceDir, venvDir, port, logStream, log }) {
  return startService({
    name: 'mesh-tools', serviceDir, venvDir, script: 'main.py', logStream, log,
    env: { MESHTOOLS_HOST: '127.0.0.1', MESHTOOLS_PORT: String(port) },
  });
}

function startSkintokens({ serviceDir, venvDir, dataDir, port, logStream, log }) {
  // RIGTOOLS_DATA_DIR makes rig_server.py chdir to the same writable folder the
  // weights were downloaded into, so its relative model lookups resolve.
  const env = { RIGTOOLS_HOST: '127.0.0.1', RIGTOOLS_PORT: String(port) };
  if (dataDir) env.RIGTOOLS_DATA_DIR = dataDir;
  return startService({ name: 'rigging', serviceDir, venvDir, script: 'rig_server.py', logStream, log, env });
}

function startService({ name, serviceDir, venvDir, script, env, logStream, log }) {
  const write = (s) => { try { logStream && logStream.write(s); } catch { /* ignore */ } };
  const vp = venvPython(venvDir);
  if (!isReady(venvDir)) {
    log && log(`${name} not set up yet — skipping launch.`);
    return { stop() {} };
  }
  let proc = null;
  try {
    log && log(`Starting ${name} service…`);
    proc = spawn(vp, [script], {
      cwd: serviceDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => write(d.toString()));
    proc.stderr.on('data', (d) => write(d.toString()));
    proc.on('exit', (code, signal) => { log && log(`${name} service exited (code=${code} signal=${signal})`); });
  } catch (err) {
    log && log(`${name} service failed to start: ${err.message}`);
  }
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (proc && proc.pid) killTree(proc.pid);
    },
  };
}

module.exports = {
  PYVER,
  venvPython,
  isReady,
  ensureUv,
  setupPythonServer,
  setupSkintokens,
  startPythonServer,
  startSkintokens,
  killTree,
};
