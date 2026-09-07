#!/usr/bin/env node
// stdio entry point for MCP clients that spawn a process (e.g. Claude Desktop
// local servers). It is a thin bridge: tools still call the RUNNING 3D Gen
// Studio backend over loopback HTTP — this process never opens the database.
//
// Usage: node mcp/stdio.js        (app must be running; its port is discovered)
//        GENSTUDIO_URL=http://localhost:3001 node mcp/stdio.js
//        node mcp/stdio.js --tools=projects,graph,assets   (load only those groups)
//        node mcp/stdio.js --tools=-mesh                   (load everything except mesh)
//
// The full catalog costs a client ~25k tokens of system prompt per session, so
// --tools / MCP_TOOLS lets a small-context model load only what it needs. The
// flag exists as well as the env var because clients differ in whether they
// pass `env` through to the spawned process — every client passes `args`.
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './index.js';

// The backend does not always live on 3001: the desktop shell moves it when
// something else holds that port. It publishes where it landed to
// <data dir>/runtime.json (server.js: publishRuntimeInfo), so look there before
// falling back. Candidate order: explicit URL/PORT -> published file(s) -> 3001,
// each PROBED in turn because a published file can name a port that is dead.
function runtimeDataDirs() {
  const dirs = [];
  if (process.env.GENSTUDIO_DATA_ROOT) dirs.push(path.join(process.env.GENSTUDIO_DATA_ROOT, 'data'));
  dirs.push(path.join(process.cwd(), 'data')); // repo checkout / Docker mount
  // The desktop app runs the backend with cwd = Electron's userData dir, so the
  // published file lands under the per-platform app-data path, not the checkout.
  const home = os.homedir();
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, '3DGenStudio', 'data'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', '3DGenStudio', 'data'));
  } else {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), '3DGenStudio', 'data'));
  }
  return dirs;
}

// A published runtime.json can outlive the server that wrote it: 'exit' does not
// run for a signal-terminated process, so a file naming a DEAD port survives a
// hard kill. Returning the first file found therefore aims the bridge at a port
// nothing is listening on — the "not reachable at :3002 while the app serves on
// :3001" failure. Collect every candidate in priority order instead and let the
// probe below pick the one that actually answers.
function candidateBaseUrls() {
  const urls = [];
  const add = value => {
    if (!value) return;
    const clean = String(value).replace(/[/]+$/, '');
    if (clean && !urls.includes(clean)) urls.push(clean);
  };
  if (process.env.GENSTUDIO_URL) add(process.env.GENSTUDIO_URL);
  if (process.env.PORT) add(`http://127.0.0.1:${process.env.PORT}`);
  for (const dir of runtimeDataDirs()) {
    try {
      const info = JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
      if (info?.port) add(info.origin || `http://127.0.0.1:${info.port}`);
    } catch {
      // not there, or stale/corrupt — try the next location
    }
  }
  add('http://127.0.0.1:3001');
  return urls;
}

// The timeout matters as much as the probe: a port that accepts the connection
// and then never answers would hang the MCP handshake indefinitely, which the
// client surfaces as the same opaque "Connection closed".
async function isLive(url) {
  try {
    const res = await fetch(`${url}/api/projects`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// An explicit URL/PORT is an override, not a hint: if the caller named an
// instance and it is down, say so rather than quietly attaching to a different
// one they never asked for.
const explicit = Boolean(process.env.GENSTUDIO_URL || process.env.PORT);
const candidates = explicit ? candidateBaseUrls().slice(0, 1) : candidateBaseUrls();

let baseUrl;
for (const candidate of candidates) {
  if (await isLive(candidate)) {
    baseUrl = candidate;
    break;
  }
}

// --tools=a,b  |  --tools a,b  |  fall back to MCP_TOOLS, then every group.
function readToolsFlag(argv) {
  const index = argv.findIndex(arg => arg === '--tools' || arg.startsWith('--tools='));
  if (index === -1) return undefined;
  const arg = argv[index];
  return arg.startsWith('--tools=') ? arg.slice('--tools='.length) : argv[index + 1];
}

const groups = readToolsFlag(process.argv.slice(2)) ?? process.env.MCP_TOOLS;

if (!baseUrl) {
  console.error(`3D Gen Studio is not reachable. Tried: ${candidates.join(', ')}.`);
  console.error('Start the app first (npm run dev, or launch the desktop app), then retry.');
  console.error('If it is running elsewhere, set GENSTUDIO_URL=http://127.0.0.1:<port>.');
  process.exit(1);
}

const server = buildMcpServer({ baseUrl, groups });
await server.connect(new StdioServerTransport());
