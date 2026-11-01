// uv-based provisioning + launch for the bundled Python services, with progress
// callbacks so the first-run setup window can show live status. Supersedes the
// older python.cjs (system-Python model).
//
// Model: uv provisions a pinned standalone Python (3.13 — see each service's
// .python-version) and a venv in a WRITABLE per-user dir (the installed app
// folder is read-only on macOS/Linux). This mirrors the CLI run.bat/run.sh and
// makes the flash-attn wheel selection for rigging deterministic.
//
//   - Mesh Tools (python-server): always provisioned. CPU, plus CuPy + Warp for
//     Auto Retopo when an NVIDIA GPU is present (Windows/Linux; see MESHTOOLS_GPU).
//   - Motion Generation (kimodo): opt-in. Heavy (torch + a 1.1 GB checkpoint +
//     a 16 GB text encoder) and needs an NVIDIA GPU. No flash-attn, so the setup
//     is the plain run_server.bat sequence; macOS has no CUDA and is refused.
//   - Rigging (skintokens): opt-in. Heavy (torch + flash-attn + model) and needs
//     an NVIDIA GPU; the setup reuses the service's own Python helpers
//     (select_flash_attn.py / download_wheel.py / download.py). Windows and Linux
//     only — flash-attn comes from a prebuilt wheel curated PER PLATFORM
//     (flash_attention_windows.txt / flash_attention_linux.txt) because building
//     it from source takes ~an hour either way. macOS has no CUDA and is refused.
//
// Everything is async and streams output to an onProgress callback; nothing
// blocks the Electron main-process event loop.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PYVER = '3.13';
const UV_EXE = IS_WIN ? 'uv.exe' : 'uv';

// Bump whenever python-server/requirements.txt changes so EXISTING installs
// re-run the (incremental) mesh-tools setup and pick up the new deps — the
// marker alone only proves that SOME requirements set was installed once.
// History: 2 = added bpy (GLB->FBX engine export, v1.5.0).
//          3 = GPU acceleration for Auto Retopo (MESHTOOLS_GPU).
const MESHTOOLS_REQS_TAG = 'meshtools-reqs-3';

// GPU acceleration for Auto Retopo, the two packages of requirements-nvidia.txt:
//   - CuPy (watertight-shell stage), one CUDA major per platform — the same line
//     the managed ComfyUI build uses there (cu130 Windows, cu128 Linux). The
//     wheel alone is not enough on a machine without a CUDA toolkit:
//     cupyx.scipy.ndimage JIT-compiles its kernels with NVRTC and the voxelizer's
//     einsum calls cuBLAS, and the driver ships neither. cuda-toolkit[nvrtc,cublas]
//     brings exactly those two as wheels (~520 MB) that cuda-pathfinder finds in
//     site-packages; CuPy's own [ctk] extra is the whole toolkit (~1.5 GB) for
//     libraries Auto Retopo never loads.
//   - Warp (projection stage's closest-point queries). Self-contained: warp.dll
//     carries its own NVRTC, so it needs nothing beyond the driver.
// No macOS entry: there is no CUDA there.
const MESHTOOLS_GPU = {
  win32: ['cupy-cuda13x', 'cuda-toolkit[nvrtc,cublas]==13.*', 'warp-lang>=1.0'],
  linux: ['cupy-cuda12x', 'cuda-toolkit[nvrtc,cublas]==12.*', 'warp-lang>=1.0'],
};

// Exercises what the two GPU stages need — CuPy's device, NVRTC (an ndimage
// kernel) and cuBLAS (einsum); Warp seeing a CUDA device — so a driver too old
// for a wheel's CUDA major shows up in the setup log instead of as a silent CPU
// fallback later.
const GPU_PROBE = [
  'import cupy as cp',
  'from cupyx.scipy import ndimage as ndi',
  'a = cp.ones((16, 16, 16), cp.float32)',
  'cp.einsum("ij,jk->ik", a[0], a[0])',
  'ndi.gaussian_filter(ndi.distance_transform_edt(a > 0), 1.0)',
  'cp.cuda.Device().synchronize()',
  'print("CuPy", cp.__version__, "OK on", cp.cuda.runtime.getDeviceProperties(0)["name"].decode())',
  'import warp as wp',
  'wp.init()',
  'assert wp.get_cuda_device_count() > 0, "Warp sees no CUDA device"',
  'print("Warp", wp.__version__, "OK")',
].join('\n');

function hasNvidiaGpu() {
  try {
    return spawnSync('nvidia-smi', ['-L'], { timeout: 20000, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function venvPython(venvDir) {
  return IS_WIN
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

// Force UTF-8 on EVERY Python we spawn — provisioning as well as the long-running
// services. Layered on top of `base` (the app environment by default).
//
// Windows outside a UTF-8 locale is the reason this exists. On a Chinese system
// the ANSI codepage is GBK/cp936 (cp932 on Japanese, cp949 on Korean, cp1252 on
// Western), and a child Python inherits it as its default text encoding, which
// breaks provisioning in two ways:
//
//   - Source builds die. setuptools opens a package's UTF-8 setup.py/README with
//     the locale codec: `UnicodeDecodeError: 'gbk' codec can't decode byte 0xa4`
//     while building groundingdino-py, so the whole managed ComfyUI install fails
//     on a machine where the identical lock installs fine in an English locale.
//   - Output we read back through a pipe is mojibake, because for a pipe (as
//     opposed to a console) Python picks the ANSI codepage while Node decodes as
//     UTF-8.
//
// PYTHONUTF8=1 is UTF-8 Mode (PEP 540): the interpreter uses UTF-8 for files and
// streams regardless of locale. PYTHONIOENCODING covers stdio on interpreters
// that ignore UTF-8 Mode. Set unconditionally rather than only on Windows —
// the same guarantee costs nothing elsewhere, and an ambient PYTHONIOENCODING
// inherited from the user's shell is exactly what we do NOT want to honour here.
function utf8Env(base) {
  return { ...(base || process.env), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
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
    const r = spawnSync(vp, ['-c', 'import sys'], { timeout: 20000, stdio: 'ignore', env: utf8Env() });
    return r.status === 0;
  } catch {
    return false;
  }
}

// `requiredTag` (optional) additionally requires the marker to start with that
// tag — pass MESHTOOLS_REQS_TAG for the mesh-tools venv so a requirements bump
// re-triggers its setup. Rigging keeps the tag-less check (its marker must not
// be invalidated by mesh-tools changes: re-setup means multi-GB torch/model
// downloads).
function isReady(venvDir, requiredTag) {
  if (!fs.existsSync(depsMarker(venvDir)) || !venvUsable(venvDir)) return false;
  if (!requiredTag) return true;
  try {
    return fs.readFileSync(depsMarker(venvDir), 'utf8').startsWith(requiredTag);
  } catch {
    return false;
  }
}

// Create the venv with uv, rebuilding from scratch if the existing one is broken
// (e.g. a legacy python -m venv whose base interpreter is gone). A healthy venv
// is left untouched. Returns an exit code (0 = ok).
//
// `pythonVersion` defaults to PYVER; the managed ComfyUI install passes its own
// (its prebuilt CUDA wheels are tagged for a specific interpreter, which need not
// be the one the other services use).
async function ensureVenv({ uv, serviceDir, venvDir, onLine, pythonVersion }) {
  if (venvUsable(venvDir)) return 0;
  if (fs.existsSync(venvDir)) {
    if (onLine) onLine(`Existing virtual environment is unusable — rebuilding it.\n`);
    try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const r = await runStream(uv, ['venv', venvDir, '--python', pythonVersion || PYVER], { cwd: serviceDir, env: process.env, onLine });
  return r.code;
}

// Spawn a command, stream stdout+stderr line-ish chunks to onLine, resolve the
// exit code. Never rejects. `capture` also accumulates stdout for the caller.
//
// Every provisioning command — uv, the venv's python, the build backends uv
// spawns underneath — goes through here, so this is where UTF-8 is guaranteed
// for the whole install rather than at each of the ~15 call sites. See utf8Env.
function runStream(cmd, args, { cwd, env, onLine } = {}) {
  return new Promise((resolve) => {
    const emit = (s) => { if (onLine) try { onLine(s); } catch { /* ignore */ } };
    emit(`$ ${path.basename(cmd)} ${args.join(' ')}\n`);
    let p;
    try {
      p = spawn(cmd, args, { cwd, env: utf8Env(env) });
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
    {
      // Never fatal: gpu.py falls back to the CPU whenever CuPy or Warp is missing
      // or unusable, so Mesh Tools works either way — just slower.
      label: 'Installing GPU acceleration (CuPy, Warp)', weight: 2, required: false,
      run: async (log) => {
        const pkgs = MESHTOOLS_GPU[process.platform];
        if (!pkgs || !hasNvidiaGpu()) {
          log('No NVIDIA GPU detected — Auto Retopo will run on the CPU.\n');
          return 0;
        }
        const r = await runStream(uv, ['pip', 'install', '--python', vp, ...pkgs], { cwd: serviceDir, env, onLine: log });
        if (r.code !== 0) {
          log('\nWARNING: GPU acceleration did not install. Auto Retopo will run on the CPU.\n');
          return r.code;
        }
        const probe = await runStream(vp, ['-c', GPU_PROBE], { cwd: serviceDir, env, onLine: log });
        if (probe.code !== 0) {
          log('\nWARNING: GPU acceleration is installed but cannot use the GPU (often an NVIDIA driver too old for this CUDA version). Auto Retopo may run on the CPU.\n');
        }
        return probe.code;
      },
    },
  ], onProgress);
  fs.writeFileSync(depsMarker(venvDir), `${MESHTOOLS_REQS_TAG} ${new Date().toISOString()}`);
  onProgress({ kind: 'done' });
}

// ---- Rigging (skintokens) --------------------------------------------------
// `dataDir` is a WRITABLE folder for the downloaded weights (experiments/,
// models/). The packaged app's code dir is read-only, so the model MUST NOT be
// downloaded there; rig_server.py chdirs to this same dir at launch (via
// RIGTOOLS_DATA_DIR) so its relative weight lookups resolve here.
async function setupSkintokens({ uv, serviceDir, venvDir, dataDir, onProgress }) {
  // Rigging needs an NVIDIA GPU. Say so up front rather than failing several GB
  // into a torch install that has no macOS CUDA build to find.
  if (IS_MAC) {
    throw new Error('Rigging (Auto Rig) needs an NVIDIA GPU (CUDA), which macOS does not provide. The rest of the app works normally.');
  }
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
  // select_flash_attn.py picks the table for THIS platform (win_amd64 wheels from
  // flash_attention_windows.txt, linux_x86_64 from flash_attention_linux.txt) —
  // a wheel from the wrong table is rejected outright by uv at install time.
  onProgress({ kind: 'phase', phase: 'Selecting CUDA build', pct: 0.4 });
  const sel = await runStream(vp, ['select_flash_attn.py'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
  let wheel = null, torchArgs = null;
  for (const line of sel.stdout.split(/\r?\n/)) {
    if (line.startsWith('WHEEL=')) wheel = line.slice(6).trim();
    else if (line.startsWith('TORCHARGS=')) torchArgs = line.slice(10).trim();
  }

  // No match -> no rigging. Bail BEFORE the torch download: flash-attn is a hard
  // requirement (src/model/tokenrig.py imports it unguarded, so the service cannot
  // even load without it), and building it from source takes ~an hour on every
  // platform. Pulling multi-GB of torch on the way to a certain failure is waste.
  if (!wheel || !torchArgs) {
    throw new Error('No prebuilt flash-attn wheel matched this GPU/CUDA (see details). Rigging is unavailable on this machine.');
  }

  // Install torch with the curated per-wheel command, ABI-matched to the wheel.
  onProgress({ kind: 'phase', phase: 'Installing PyTorch', pct: 0.45 });
  {
    const r = await runStream(uv, ['pip', 'install', '--python', vp, ...torchArgs.split(/\s+/)], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error(`PyTorch install failed (exit ${r.code}).`);
  }

  // flash-attn — download the prebuilt wheel first (Hugging Face Xet URLs 403 for
  // pip and need the HF client; GitHub release assets are plain URLs), install it,
  // then PROVE it loads: a wheel built against a different torch ABI installs
  // cleanly and only dies at `import flash_attn` with `undefined symbol: _ZN3c10…`.
  // Catching that here beats surfacing it after the multi-GB checkpoint download.
  onProgress({ kind: 'phase', phase: 'Installing flash-attn', pct: 0.6 });
  {
    const dl = await runStream(vp, ['download_wheel.py', wheel], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    const localWheel = dl.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (dl.code !== 0 || !localWheel) throw new Error('flash-attn download failed. Rigging cannot start without it.');
    const r = await runStream(uv, ['pip', 'install', '--python', vp, localWheel], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error('flash-attn install failed. Rigging cannot start without it.');
  }
  onProgress({ kind: 'phase', phase: 'Verifying flash-attn', pct: 0.72 });
  {
    const probe = 'import torch, flash_attn; print("flash_attn", flash_attn.__version__, "/ torch", torch.__version__)';
    const r = await runStream(vp, ['-c', probe], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error('flash-attn installed but will not import — most likely a torch ABI mismatch with the selected wheel (see details). Rigging cannot start.');
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

// ---- Motion Generation (Kimodo) --------------------------------------------
// `dataDir` is a WRITABLE folder for everything the service downloads or writes
// (checkpoints/, cache/). `modelsDir` overrides just the weights location — it is
// the Settings "Model folder" box, so a user can put 17 GB on the drive that has
// room for it without moving the embedding cache with it.
//
// This mirrors thirdparty/kimodo/run_server.bat step for step; see that file for
// why each one is shaped the way it is. Three are load-bearing:
//
//   - torch is installed AFTER requirements.txt with --reinstall-package torch.
//     requirements pulls peft/accelerate, which drag in a CPU torch, and the CUDA
//     build carries the SAME version number with a +cuXXX local tag — so uv
//     "audits" the requirement as satisfied and installs nothing. The service then
//     starts silently on the CPU.
//   - SKIP_MOTION_CORRECTION_IN_SETUP keeps setup.py from building the CMake
//     extension during the editable install, so a machine with no C++ compiler
//     still gets a working service.
//   - the vendored package installs with --no-deps: its pyproject pulls the
//     interactive demo's stack (gradio, viser, mujoco) this headless service
//     never imports.
async function setupKimodo({ uv, appRoot, serviceDir, venvDir, dataDir, modelsDir, llamaBase, onProgress }) {
  // Kimodo needs an NVIDIA GPU. Say so before, not several GB into, a torch
  // install that has no macOS CUDA build to find.
  if (IS_MAC) {
    throw new Error('Motion generation (Kimodo) needs an NVIDIA GPU (CUDA), which macOS does not provide. The rest of the app works normally.');
  }
  const vp = venvPython(venvDir);
  const dataRoot = dataDir || serviceDir;
  try { fs.mkdirSync(dataRoot, { recursive: true }); } catch { /* ignore */ }

  // Every python.exe below is the service's own, and each needs the same view of
  // where things live as the running service will have (see startKimodo) — the
  // download steps in particular write into exactly the folders it reads from.
  const env = { ...process.env, KIMODO_DATA_DIR: dataRoot };
  if (modelsDir) env.KIMODO_CHECKPOINT_DIR = modelsDir;
  if (llamaBase) env.KIMODO_LLAMA_BASE = llamaBase;

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
      label: 'Installing motion dependencies', weight: 4,
      run: (log) => runStream(uv, ['pip', 'install', '--python', vp, '-r', 'requirements.txt'], { cwd: serviceDir, env, onLine: log }).then((r) => r.code),
    },
  ], (e) => onProgress(scaled(e, 0, 0.25)));

  // torch, CUDA-matched by the service's own selector (the same table the CLI uses).
  onProgress({ kind: 'phase', phase: 'Selecting CUDA build', pct: 0.25 });
  const sel = await runStream(vp, ['select_torch.py'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
  const torchArgs = sel.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';

  onProgress({ kind: 'phase', phase: 'Installing PyTorch', pct: 0.3 });
  {
    // No GPU detected -> a CPU torch still installs, and the probe below turns
    // that into a warning rather than a failure. Generation would take minutes
    // per clip, but "installed and slow" beats "install failed" for someone
    // setting the app up before the card is in the machine.
    const args = torchArgs ? torchArgs.split(/\s+/) : ['torch'];
    const r = await runStream(uv, ['pip', 'install', '--python', vp, '--reinstall-package', 'torch', ...args], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error(`PyTorch install failed (exit ${r.code}).`);
  }
  {
    const probe = 'import torch,sys; print("torch", torch.__version__, "cuda", torch.cuda.is_available()); sys.exit(0 if torch.cuda.is_available() else 1)';
    const r = await runStream(vp, ['-c', probe], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) {
      onProgress({ kind: 'log', text: '\nWARNING: torch cannot see a CUDA GPU. Motion generation will run on the CPU and be very slow.\n' });
    }
  }

  // Not fatal, deliberately. An editable install writes kimodo.egg-info back into
  // the source tree, and the packaged app's code directory is READ-ONLY on Linux
  // (/opt, /usr) and inside a macOS bundle. Nothing needs the install to succeed:
  // motion_server.py is launched with cwd=serviceDir, so sys.path[0] is that
  // directory and `import kimodo` resolves to the vendored tree either way, and
  // nothing in the package reads its own installed metadata.
  onProgress({ kind: 'phase', phase: 'Installing Kimodo', pct: 0.42 });
  {
    const r = await runStream(uv, ['pip', 'install', '--python', vp, '--no-deps', '-e', '.'], {
      cwd: serviceDir, env: { ...env, SKIP_MOTION_CORRECTION_IN_SETUP: '1' },
      onLine: (t) => onProgress({ kind: 'log', text: t }),
    });
    if (r.code !== 0) {
      onProgress({ kind: 'log', text: '\nRegistering the Kimodo package failed (the app folder is usually read-only). The service imports it from its own directory instead, so this is not a problem.\n' });
    }
  }

  // The C++ foot-skate cleanup (`motion_correction`). Building it from source needs
  // CMake, a C++17 compiler, Python headers AND git + network access (its CMakeLists
  // fetches pybind11 and Eigen) — a combination almost no end user has, which is why
  // a prebuilt wheel is tried first and the source build is only the fallback.
  //
  // Never fatal either way: without it the service still generates motion, it just
  // reports `postprocess_unavailable` and skips the cleanup.
  onProgress({ kind: 'phase', phase: 'Installing MotionCorrection (foot-skate cleanup)', pct: 0.5 });
  {
    const installed = await installPrebuiltWheel({
      uv, vp, appRoot, package: 'motion_correction', env,
      onLine: (t) => onProgress({ kind: 'log', text: t }),
    });
    if (!installed) {
      onProgress({ kind: 'phase', phase: 'Building MotionCorrection from source (optional)', pct: 0.52 });
      const r = await runStream(uv, ['pip', 'install', '--python', vp, '--no-deps', path.join(serviceDir, 'MotionCorrection')], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
      if (r.code !== 0) {
        onProgress({ kind: 'log', text: '\nMotionCorrection is not installed: no prebuilt wheel matched this platform and the source build failed (it needs CMake, a C++17 compiler, and git + network access for pybind11/Eigen). The service still works — generation just skips foot-skate cleanup.\n' });
      }
    }
  }

  onProgress({ kind: 'phase', phase: 'Downloading the Kimodo checkpoint', pct: 0.55 });
  {
    const r = await runStream(vp, ['download.py', '--model'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error(`Checkpoint download failed (exit ${r.code}).`);
  }

  // The 16 GB text encoder, fetched here rather than lazily on the first prompt —
  // otherwise the first generation appears to hang for an hour. download.py skips
  // it when the weights are already in the shared Hugging Face cache from an
  // earlier CLI run, so this is not a second copy.
  onProgress({ kind: 'phase', phase: 'Downloading the text encoder (~16 GB)', pct: 0.62 });
  {
    const r = await runStream(vp, ['download.py', '--text-encoder'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) {
      // Not fatal: the encoder is fetched on demand at first use, and a failure
      // here is usually a gated-repo 403 that the service itself explains better.
      onProgress({ kind: 'log', text: '\nWARNING: the text encoder did not download. It will be fetched on the first generation instead.\n' });
    }
  }

  fs.writeFileSync(depsMarker(venvDir), new Date().toISOString());
  onProgress({ kind: 'phase', phase: 'Motion generation ready', pct: 1 });
  onProgress({ kind: 'done' });
}

// Install a wheel we shipped for this platform, if one matches.
//
// Matching is left to uv/pip: a wheel's filename encodes the Python ABI and the
// platform (`…-cp313-cp313-win_amd64.whl`), and installing a mismatched one is
// refused rather than silently wrong. So each candidate is simply attempted, and the
// IMPORT is what decides success — a wheel can install and still fail to load (a
// missing system library, the wrong glibc), and quietly leaving that broken would be
// worse than falling back to a source build.
//
// Returns true only when the module actually imports.
// Provision the video-to-motion service (MoCapAnything V2).
//
// Simpler than setupKimodo in one way and fussier in two:
//   - no text encoder, so no gated weights and no separate process;
//   - torch AND torchvision, because the per-rig bake reaches
//     torchvision.transforms through utils.common. A torch-only install fails
//     several stages into the first bake rather than here;
//   - Blender arrives as the `bpy` WHEEL from requirements.txt (~323 MB), so
//     there is no Blender to install separately. That is also why this pins
//     PYVER: bpy publishes wheels for CPython 3.11 and 3.13 only.
async function setupMocap({ uv, serviceDir, venvDir, dataDir, modelsDir, onProgress }) {
  // Needs an NVIDIA GPU. Say so before, not several GB into, a torch install
  // that has no macOS CUDA build to find.
  if (IS_MAC) {
    throw new Error('Video to motion (MoCapAnything) needs an NVIDIA GPU (CUDA), which macOS does not provide. The rest of the app works normally.');
  }
  const vp = venvPython(venvDir);
  const dataRoot = dataDir || serviceDir;
  try { fs.mkdirSync(dataRoot, { recursive: true }); } catch { /* ignore */ }

  // The same view of where things live as the running service will have (see
  // startMocap) — download.py below writes into exactly the folder it reads.
  const env = { ...process.env, MOCAP_DATA_DIR: dataRoot };
  if (modelsDir) env.MOCAP_CKPT_DIR = modelsDir;

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
      // Includes bpy — the single biggest item here after torch.
      label: 'Installing video-to-motion dependencies (includes Blender)', weight: 5,
      run: (log) => runStream(uv, ['pip', 'install', '--python', vp, '-r', 'requirements.txt'], { cwd: serviceDir, env, onLine: log }).then((r) => r.code),
    },
  ], (e) => onProgress(scaled(e, 0, 0.3)));

  // torch, CUDA-matched by the service's own selector (the same table the CLI
  // uses). It emits "torch torchvision --index-url ..." so both come from one
  // index and their CUDA builds cannot drift apart.
  onProgress({ kind: 'phase', phase: 'Selecting CUDA build', pct: 0.3 });
  const sel = await runStream(vp, ['select_torch.py'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
  const torchArgs = sel.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';

  onProgress({ kind: 'phase', phase: 'Installing PyTorch', pct: 0.35 });
  {
    // No GPU detected -> a CPU torch still installs, and the probe below turns
    // that into a warning rather than a failure.
    const args = torchArgs ? torchArgs.split(/\s+/) : ['torch', 'torchvision'];
    // --reinstall-package for BOTH: requirements can leave a CPU build already
    // satisfying the version (local +cuXXX tag and all), which uv would then
    // "audit" and skip, silently leaving the service on the CPU.
    const r = await runStream(uv, ['pip', 'install', '--python', vp, '--reinstall-package', 'torch', '--reinstall-package', 'torchvision', ...args], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) throw new Error(`PyTorch install failed (exit ${r.code}).`);
  }
  {
    const probe = 'import torch,torchvision,sys; print("torch", torch.__version__, "torchvision", torchvision.__version__, "cuda", torch.cuda.is_available()); sys.exit(0 if torch.cuda.is_available() else 1)';
    const r = await runStream(vp, ['-c', probe], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) {
      onProgress({ kind: 'log', text: '\nWARNING: torch cannot see a CUDA GPU. Capturing motion will run on the CPU and be very slow.\n' });
    }
  }

  // Which Blender the bake will use. Not fatal — capturing motion works without
  // one; only PREPARING a rig needs it — so this reports rather than throws.
  onProgress({ kind: 'phase', phase: 'Checking Blender', pct: 0.55 });
  {
    const probe = 'import sys; sys.path.insert(0, "."); import pipeline; m, w = pipeline.blender_runner(); print("Blender:", "bpy module" if m == "bpy" else "application", w)';
    const r = await runStream(vp, ['-c', probe], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) {
      onProgress({ kind: 'log', text: '\nWARNING: no bpy module and no Blender executable. Preparing a rig will fail; set BLENDER to a Blender 3.6+ binary.\n' });
    }
  }

  // The checkpoint (~460 MB). Downloaded with the same env the service runs
  // with, so it lands where mocap_paths.checkpoint_dir() will look for it.
  onProgress({ kind: 'phase', phase: 'Downloading the motion checkpoint', pct: 0.6 });
  {
    const r = await runStream(vp, ['download.py'], { cwd: serviceDir, env, onLine: (t) => onProgress({ kind: 'log', text: t }) });
    if (r.code !== 0) {
      // Recoverable: the service starts and reports checkpoint_present=false,
      // and the download can be retried. Better than failing a 3 GB install on
      // its last step.
      onProgress({ kind: 'log', text: '\nWARNING: the checkpoint download failed. The service will start but cannot capture motion until it succeeds.\n' });
    }
  }

  // The marker is what isReady() checks — without it the install "succeeds" and
  // the Settings card immediately offers to install again, because nothing on
  // disk says it is done. Written last, so a failure above leaves the venv
  // correctly marked as not-ready.
  fs.writeFileSync(depsMarker(venvDir), new Date().toISOString());

  onProgress({ kind: 'phase', phase: 'Video to motion ready', pct: 1 });
  onProgress({ kind: 'done' });
}

async function installPrebuiltWheel({ uv, vp, appRoot, package: pkg, env, onLine }) {
  const dir = appRoot ? path.join(appRoot, 'resources', 'wheels', pkg) : null;
  const emit = (s) => { if (onLine) try { onLine(s); } catch { /* ignore */ } };
  let wheels = [];
  try {
    wheels = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.whl'))
      // Prefer the ones whose platform tag mentions this OS, but try the rest too:
      // the tag vocabulary (manylinux_x_y, musllinux, …) is not ours to parse.
      .sort((a, b) => platformScore(b) - platformScore(a));
  } catch { /* no wheels shipped for this package */ }
  if (!wheels.length) {
    emit(`No prebuilt ${pkg} wheel is bundled for this platform.\n`);
    return false;
  }

  for (const wheel of wheels) {
    const r = await runStream(uv, ['pip', 'install', '--python', vp, '--no-deps', path.join(dir, wheel)], { env, onLine });
    if (r.code !== 0) continue;
    const probe = await runStream(vp, ['-c', `import ${pkg}; print("${pkg} ok")`], { env, onLine });
    if (probe.code === 0) {
      emit(`Installed the prebuilt ${wheel} — no compiler needed.\n`);
      return true;
    }
    // Installed but unusable: take it back out so a later source build is not
    // shadowed by a broken module.
    emit(`${wheel} installed but could not be imported on this machine; removing it.\n`);
    await runStream(uv, ['pip', 'uninstall', '--python', vp, pkg], { env, onLine });
  }
  return false;
}

// Ranking, not filtering: uv is the authority on whether a wheel is installable, so
// this only decides what to TRY FIRST. On Linux a `manylinux_*` wheel outranks a bare
// `linux_x86_64` one, which carries the glibc of whatever machine built it — a wheel
// built on Ubuntu 26.04 requires GLIBC_2.43 and will not load on 24.04 or older, so
// trying it first would cost an install-and-uninstall round trip on most machines.
function platformScore(wheel) {
  const name = wheel.toLowerCase();
  if (IS_WIN) return name.includes('win') ? 1 : 0;
  if (IS_MAC) return name.includes('macos') ? 1 : 0;
  if (name.includes('manylinux') || name.includes('musllinux')) return 2;
  return name.includes('linux') ? 1 : 0;
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
// `host` is the address each service binds. Loopback by default; 0.0.0.0 when
// the user lets other computers use it (Settings -> "Allow other computers to
// connect"), which is how a GPU machine serves a frontend running elsewhere.
function startPythonServer({ serviceDir, venvDir, port, host = '127.0.0.1', logStream, log }) {
  return startService({
    name: 'mesh-tools', serviceDir, venvDir, script: 'main.py', logStream, log,
    env: { MESHTOOLS_HOST: host, MESHTOOLS_PORT: String(port) },
  });
}

function startSkintokens({ serviceDir, venvDir, dataDir, port, host = '127.0.0.1', logStream, log }) {
  // RIGTOOLS_DATA_DIR makes rig_server.py chdir to the same writable folder the
  // weights were downloaded into, so its relative model lookups resolve.
  const env = { RIGTOOLS_HOST: host, RIGTOOLS_PORT: String(port) };
  if (dataDir) env.RIGTOOLS_DATA_DIR = dataDir;
  return startService({ name: 'rigging', serviceDir, venvDir, script: 'rig_server.py', logStream, log, env });
}

// The motion service writes into `dataDir` and reads weights from `modelsDir`
// (Settings -> Motion Generation -> "Model folder"). `llamaBase` names the repo
// the 16 GB text-encoder base comes from — an ungated mirror by default, because
// the official one is gated behind an access request.
//
// It spawns the text-encoder sidecar as a child, so stopping it has to kill the
// tree — startService already does (killTree), which is the whole reason that
// helper exists.
function startKimodo({ serviceDir, venvDir, dataDir, modelsDir, llamaBase, port, host = '127.0.0.1', logStream, log }) {
  const env = { KIMODO_HOST: host, KIMODO_PORT: String(port) };
  if (dataDir) env.KIMODO_DATA_DIR = dataDir;
  if (modelsDir) env.KIMODO_CHECKPOINT_DIR = modelsDir;
  if (llamaBase) env.KIMODO_LLAMA_BASE = llamaBase;
  return startService({ name: 'motion', serviceDir, venvDir, script: 'motion_server.py', logStream, log, env });
}

function startMocap({ serviceDir, venvDir, dataDir, modelsDir, port, host = '127.0.0.1', logStream, log }) {
  const env = { MOCAP_HOST: host, MOCAP_PORT: String(port) };
  // Without MOCAP_DATA_DIR the service would cache per-rig bakes under
  // %LOCALAPPDATA%; pointing it at the app's data root keeps everything the
  // desktop app writes in one place the uninstaller can offer by name.
  if (dataDir) env.MOCAP_DATA_DIR = dataDir;
  if (modelsDir) env.MOCAP_CKPT_DIR = modelsDir;
  return startService({ name: 'mocap', serviceDir, venvDir, script: 'mocap_server.py', logStream, log, env });
}

function startService({ name, serviceDir, venvDir, script, env, logStream, log }) {
  const write = (s) => { try { logStream && logStream.write(s); } catch { /* ignore */ } };
  const vp = venvPython(venvDir);
  if (!isReady(venvDir)) {
    log && log(`${name} not set up yet — skipping launch.`);
    return { stop() {} };
  }
  let proc = null;
  // Keep the last chunk of output so a launch failure can be reported with its
  // real cause rather than as a health-check timeout.
  let tail = '';
  const keepTail = (s) => { tail = (tail + s).slice(-4000); };
  let settleExit;
  const exited = new Promise((resolve) => { settleExit = resolve; });

  try {
    log && log(`Starting ${name} service…`);
    proc = spawn(vp, [script], {
      cwd: serviceDir,
      // utf8Env: output goes through a pipe, and for pipes Python defaults to the
      // ANSI codepage on Windows — any non-ASCII log line then raises
      // UnicodeEncodeError inside logging and can kill the service mid-startup.
      env: utf8Env({ ...process.env, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { const s = d.toString(); write(s); keepTail(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); write(s); keepTail(s); });
    proc.on('exit', (code, signal) => {
      log && log(`${name} service exited (code=${code} signal=${signal})`);
      settleExit({ code, signal, tail });
    });
    proc.on('error', (err) => {
      log && log(`${name} service failed to start: ${err.message}`);
      settleExit({ code: -1, signal: null, tail: err.message });
    });
  } catch (err) {
    log && log(`${name} service failed to start: ${err.message}`);
    settleExit({ code: -1, signal: null, tail: err.message });
  }
  let stopped = false;
  return {
    exited,
    stop() {
      if (stopped) return;
      stopped = true;
      if (proc && proc.pid) killTree(proc.pid);
    },
  };
}

module.exports = {
  PYVER,
  MESHTOOLS_REQS_TAG,
  venvPython,
  isReady,
  ensureUv,
  // Exported for the wheel-vs-source check: it decides whether a feature works on a
  // machine with no compiler, so it is worth being able to test on its own.
  installPrebuiltWheel,
  setupPythonServer,
  setupSkintokens,
  setupMocap,
  setupKimodo,
  startPythonServer,
  startSkintokens,
  startKimodo,
  startMocap,
  killTree,
  // Shared with comfysetup.cjs, which provisions a third service the same way.
  runStream,
  ensureVenv,
  depsMarker,
  venvUsable,
  utf8Env,
};
