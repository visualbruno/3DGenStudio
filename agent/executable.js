// Finding and launching the user's own CLI agents (Claude Code, Codex).
//
// These run on the user's SUBSCRIPTION through their own installed, logged-in
// CLI - the app never sees a credential. On Windows the CLIs come either as a
// real .exe (native installers) or as an npm .cmd shim, and Node refuses to
// spawn a .cmd without a shell (EINVAL since Node 20). With a shell every
// argument is re-parsed by cmd.exe, so the launch keeps arguments SIMPLE:
// prompts go through stdin and anything structured (system prompt, MCP config)
// through files, never through the command line.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const cache = new Map();

async function which(name) {
  try {
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync('where', [name], { windowsHide: true, timeout: 5000 })
      : await execFileAsync('which', [name], { timeout: 5000 });
    const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      // Prefer a real executable over a shim when both are on PATH.
      return lines.find(l => /\.exe$/i.test(l)) || lines.find(l => /\.(cmd|bat)$/i.test(l)) || lines[0] || null;
    }
    return lines[0] || null;
  } catch {
    return null;
  }
}

/**
 * Locate a CLI and read its version. Returns { path, version, error }.
 * Cached for a minute - the providers list is polled by the UI.
 */
export async function findCli(name, override = '') {
  const key = `${name}|${override}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  let value;
  const candidate = override && fs.existsSync(override) ? override : await which(name);
  if (!candidate) {
    value = { path: null, version: null, error: `${name} was not found on PATH.` };
  } else {
    try {
      const { stdout } = await runCapture(candidate, ['--version'], { timeout: 15000 });
      value = { path: candidate, version: stdout.trim().split(/\r?\n/)[0] || 'unknown', error: null };
    } catch (err) {
      value = { path: candidate, version: null, error: `${name} did not start: ${err.message}` };
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

function needsShell(file) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

function runCapture(file, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: needsShell(file), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `exit ${code}`).trim().slice(0, 300)));
    });
  });
}

/**
 * Spawn a CLI agent. `stdin` is written and closed; stdout is split into
 * lines for `onLine`. Returns { child, done: Promise<{code, stderr}> }.
 */
// npm's Windows shims are `node "%dp0%\node_modules\<pkg>\bin\x.js" %*`. Running
// that script with node directly avoids cmd.exe entirely - which matters for
// Codex, whose config overrides are full of quotes and brackets.
function unwrapNpmShim(file) {
  if (!needsShell(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /"%~?dp0%\\?([^"%]+\.(?:js|mjs|cjs))"/i.exec(text);
    if (!m) return null;
    const script = path.join(path.dirname(file), m[1]);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

export function launch(file, args, { cwd, env, stdin = '', onLine }) {
  const script = unwrapNpmShim(file);
  if (script) {
    const nodeEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
    return launchDirect(process.execPath, [script, ...args], { cwd, env: nodeEnv, stdin, onLine });
  }
  let finalArgs = args;
  if (needsShell(file)) {
    // cmd.exe re-parses the line: quote empties and paths with spaces, and
    // refuse anything that could be interpreted (no user text ever gets here).
    finalArgs = args.map((a) => {
      if (/["&|<>^%]/.test(a)) throw new Error(`Internal: argument "${a}" is not shell-safe for a .cmd launcher.`);
      return a === '' || /\s/.test(a) ? `"${a}"` : a;
    });
  }
  return launchDirect(file, finalArgs, { cwd, env, stdin, onLine, shell: needsShell(file) });
}

function launchDirect(file, finalArgs, { cwd, env, stdin = '', onLine, shell = false }) {
  const child = spawn(file, finalArgs, { cwd, env, shell, windowsHide: true });
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  if (stdin) child.stdin.write(stdin);
  child.stdin.end();
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      resolve({ code, stderr });
    });
  });
  return { child, done };
}

/** Kill a CLI and everything it started (MCP bridges, model calls). */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

/** A private, empty working directory per run: no project CLAUDE.md / AGENTS.md leaks in. */
export function runDirectory(runId) {
  const dir = path.join(os.tmpdir(), 'genstudio-agent', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
