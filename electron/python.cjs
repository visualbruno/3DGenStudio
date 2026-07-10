// Cross-platform launcher for the Python mesh-tools service (Auto UV / Auto
// Retopo). This is the Node/Electron equivalent of python-server/run.bat, made
// to work on Windows, macOS and Linux.
//
// Model: "require Python on the machine" (fastest to ship). On first launch we
//   1. locate a system Python interpreter,
//   2. create a virtualenv in a WRITABLE location (the per-user data dir — the
//      installed app folder is read-only on macOS/Linux),
//   3. install requirements.txt (CPU-only base install),
// then run main.py against that venv. Subsequent launches reuse the venv.
//
// IMPORTANT: every step here is ASYNCHRONOUS. venv creation + pip install take
// minutes on first run; doing them synchronously (spawnSync) would block
// Electron's main-process event loop and starve the backend health-poll,
// causing a bogus "backend did not start" error on first launch.
//
// GPU acceleration (CuPy/Warp) is intentionally NOT installed here to keep the
// first-run install portable and fast; it can be layered in later per the
// python-server README (requirements-nvidia.txt + detect_cuda.py).

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

function venvPython(venvDir) {
  return IS_WIN
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

// Written only after requirements install fully succeeds. Gating on this (not
// just python.exe's existence) means a venv left half-built by a crashed or
// interrupted first run is detected and completed on the next launch, instead
// of launching a broken service that fails on missing imports.
function depsMarker(venvDir) {
  return path.join(venvDir, '.deps-installed');
}

// Find a usable system Python (3.x). A one-shot `--version` probe is instant,
// so spawnSync is fine here (it does not block for any meaningful time).
function findSystemPython() {
  const candidates = IS_WIN ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0 && /Python 3\./.test((r.stdout || '') + (r.stderr || ''))) {
        return c;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

// Public entry point. Fully non-blocking: kicks off setup + launch and returns
// immediately with a handle exposing stop().
function startPythonService({ pythonDir, dataRoot, port, logStream, log }) {
  const venvDir = path.join(dataRoot, 'python-venv');
  let proc = null;
  let stopped = false;

  const write = (s) => { try { logStream.write(s); } catch { /* ignore */ } };

  // Run a command asynchronously, streaming output to the log. Resolves to the
  // exit code (0 = success). Never rejects.
  const run = (cmd, args) =>
    new Promise((resolve) => {
      write(`\n$ ${cmd} ${args.join(' ')}\n`);
      let p;
      try {
        p = spawn(cmd, args, { cwd: pythonDir });
      } catch (err) {
        write(`spawn error: ${err.message}\n`);
        return resolve(-1);
      }
      // {end:false} so a finished child doesn't close the shared log stream.
      p.stdout.on('data', (d) => write(d.toString()));
      p.stderr.on('data', (d) => write(d.toString()));
      p.on('error', (err) => { write(`error: ${err.message}\n`); resolve(-1); });
      p.on('exit', (code) => resolve(code));
    });

  async function ensureVenv() {
    // Fully set up already (venv + deps marker) → nothing to do.
    if (fs.existsSync(venvPython(venvDir)) && fs.existsSync(depsMarker(venvDir))) {
      return true;
    }

    const py = venvPython(venvDir);

    // Create the venv only if it isn't there yet. If a previous run created it
    // but crashed before finishing pip install, reuse it and just (re)install.
    if (!fs.existsSync(py)) {
      const sysPython = findSystemPython();
      if (!sysPython) {
        log(
          'Python 3 not found on PATH — the mesh-tools service (Auto UV/Retopo) ' +
            'will be unavailable. Install Python 3.10+ and restart to enable it.'
        );
        return false;
      }
      log(`First run: creating Python venv with "${sysPython}" (this can take a few minutes)…`);
      fs.mkdirSync(path.dirname(venvDir), { recursive: true });
      if ((await run(sysPython, ['-m', 'venv', venvDir])) !== 0) {
        log('Failed to create Python venv — see python.log.');
        return false;
      }
    } else {
      log('Completing Python setup (installing dependencies)…');
    }

    await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip']);

    const reqs = path.join(pythonDir, 'requirements.txt');
    if ((await run(py, ['-m', 'pip', 'install', '-r', reqs])) !== 0) {
      log('Failed to install Python requirements — see python.log.');
      return false;
    }

    try { fs.writeFileSync(depsMarker(venvDir), new Date().toISOString()); } catch { /* ignore */ }
    log('Python environment ready.');
    return true;
  }

  async function launch() {
    try {
      if (stopped) return;
      const ok = await ensureVenv();
      if (stopped || !ok) return;

      const py = venvPython(venvDir);
      log(`Starting Python mesh-tools service on port ${port}…`);
      proc = spawn(py, ['main.py'], {
        cwd: pythonDir,
        env: {
          ...process.env,
          MESHTOOLS_HOST: '127.0.0.1',
          MESHTOOLS_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (d) => write(d.toString()));
      proc.stderr.on('data', (d) => write(d.toString()));
      proc.on('exit', (code, signal) => {
        log(`Python service exited (code=${code} signal=${signal})`);
      });
    } catch (err) {
      log(`Python service failed: ${err.message}`);
    }
  }

  // Fire and forget — runs on the microtask queue, never blocks the caller.
  launch();

  return {
    stop() {
      stopped = true;
      if (proc && !proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
    },
  };
}

module.exports = { startPythonService };
