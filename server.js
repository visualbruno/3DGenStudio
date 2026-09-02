import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import { createAssetEditRecord, createBrushChildRecord, resolveProjectImageSource, resolveProjectMeshSource } from './storage.js';
import fs from 'fs/promises';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import si from 'systeminformation';
import { WebSocket as WsWebSocket } from 'ws';
import tencentcloudSdk from 'tencentcloud-sdk-nodejs-intl-en';
import { mountMcp } from './mcp/http.js';
import { mountLogs } from './logs.js';
import { moveGlbPivot, PIVOT_MODES } from './meshPivot.js';
// The self-managed PostgreSQL for a shared server that is not running Docker.
import * as pgEmbedded from './pgEmbedded.js';
import { mountAuth, resolveJwtSecret, seedAdminFromEnv } from './auth.js';
import { mountLocalOnlyGuard } from './serverMode.js';
import { isGatewayActive, mountGateway } from './gateway.js';
import { buildProjectExportPlan, clearCardProcessing, copyAssetFileTo, createWorkflow, importProject, listWorkflows, getAssetRecord, getWorkflowDefinition, readAssetBytes, resolveProjectSource, replaceAssetFile, saveAssetEdit, saveAssetVersion, saveRootAsset, setCardProcessing, updateWorkflow } from './dataStore.js';

// Node 20 (bundled by Electron 33) has no global WebSocket, so fall back to the
// `ws` package. Newer Node runtimes (dev) expose a global WebSocket we can reuse.
const WebSocketImpl = globalThis.WebSocket ?? WsWebSocket;
import {
  ASSETS_DIR,
  DATA_DIR,
  DEFAULT_SETTINGS,
  WORKFLOW_ASSETS_DIR,
  WIKI_ASSETS_DIR,
  THUMBNAIL_ASSETS_DIR,
  createProject,
  updateProject,
  buildProjectExport,
  importProjectExport,
  createLibraryAsset,
  createCardAttribute,
  createProjectAsset,
  createTask,
  createWorkflowRecord,
  clearCardProcessingState,
  clearStaleProcessingCards,
  deleteCard,
  deleteCardAttribute,
  deleteAssetEditByFilePath,
  deleteAssetVersionByFilePath,
  deleteAssetById,
  deleteProjectConnection,
  deleteProjectNode,
  deleteBoard,
  listMotions,
  readMotionBvh,
  createMotion,
  renameMotion,
  deleteMotion,
  listCustomAnimations,
  readCustomAnimationData,
  createCustomAnimation,
  renameCustomAnimation,
  deleteCustomAnimation,
  listProjectBoards,
  getProjectBatchConfig,
  setCardAssetLink,
  saveProjectBatchConfig,
  getBoardById,
  createBoard,
  updateBoard,
  resolveEditableSourceReference,
  deleteLibraryAssetByFilePath,
  deleteProjectById,
  findLibraryAssetByFilePath,
  getAssetDirectory,
  listAttributeTypes,
  listProjectConnections,
  listProjectCards,
  listProjectCardAttributes,
  listProjectNodes,
  getProjectById,
  getSettings,
  getAssetOwnerId,
  getWorkflowRecordById,
  initializeStorage,
  selectedDialect,
  listLibraryAssetsByType,
  listAllAssetTags,
  listAssetTags,
  setAssetTags,
  addAssetTags,
  removeAssetTag,
  findAssetsByTags,
  linkExistingAssetToProject,
  unlinkAssetFromProjectById,
  listProjectAssets,
  listProjectTasks,
  listProjects,
  listWorkflowRecords,
  listWikiPages as dbListWikiPages,
  getWikiPage as dbGetWikiPage,
  moveCard,
  createProjectConnection,
  createProjectNode,
  createAssetVersion,
  findAssetByFilePath,
  getAssetRecordById,
  getPaintDocumentByAssetId,
  upsertPaintDocument,
  PAINT_DOCS_DIR,
  toStoredPaintDocPath,
  getPaintDocSubdir,
  renameLibraryAssetByFilePath,
  replaceAssetFileById,
  renameAssetEditByFilePath,
  saveSettings,
  toAssetUrlPath,
  setCardProcessingState,
  toAbsoluteStoragePath,
  toStoredAssetPath,
  toStoredThumbnailPath,
  updateAssetThumbnail,
  updateCardAttribute,
  updateProjectNode,
  updateProjectNodePosition,
  updateWorkflowRecord
} from './storage.js';
import {
  WIKI_MEDIA_DIR,
  wikiManifestExists,
  listWikiPages,
  getWikiPage,
  createWikiPage,
  updateWikiPage,
  deleteWikiPage,
  moveWikiPage,
  seedWikiFiles,
  importWikiPages
} from './wikiStorage.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Where this backend ended up, for anything that has to FIND it rather than be
// told: chiefly the MCP stdio bridge (mcp/stdio.js). The desktop shell moves the
// backend off 3001 when something else holds it, so a hardcoded 3001 in a client
// is a bug waiting to happen. Written on listen, removed on a clean exit.
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');

function publishRuntimeInfo(port) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RUNTIME_FILE, JSON.stringify({
      port,
      origin: `http://127.0.0.1:${port}`,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2));
  } catch {
    // A read-only data dir costs discovery, not the server.
  }
}

// Only clear the file if it is still OURS — a second instance that started on
// another port has since overwritten it, and stomping that would point clients
// at a dead server.
function unpublishRuntimeInfo() {
  try {
    const cur = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
    if (cur?.pid === process.pid) rmSync(RUNTIME_FILE, { force: true });
  } catch {
    // absent, unreadable, or not ours — nothing to do
  }
}
process.on('exit', unpublishRuntimeInfo);

// Last-resort safety net: a single dropped stream or stray async error should
// never take the whole server down (which forced a full restart before). Log
// and keep serving; individual requests still fail on their own if broken.
process.on('uncaughtException', err => {
  console.error('Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection (server kept alive):', reason);
});

// Parent watchdog (desktop app only). The Electron shell spawns this backend as
// a child of the main process using the SAME executable with ELECTRON_RUN_AS_NODE
// (electron/main.cjs startBackend), so on Windows it appears in Task Manager as
// "3D Gen Studio.exe" - with no window, under "Background processes".
//
// main.cjs kills it from its `before-quit` shutdown, but that never runs when the
// main process dies abruptly (Task Manager "End task", a GPU/renderer crash). The
// installer's "app is still running" check matches on image name alone (see
// build/installer.nsh), so a leftover backend blocks every update.
//
// libuv normally prevents that on its own: a non-detached child goes into a job
// object that terminates it when the parent dies. Measured on Windows 11 - an
// attached child dies with its parent, a `detached: true` one survives. This
// watchdog is the belt to that safety net's braces, for the cases where the job
// object does not apply (creation failed, the child gets re-parented, or a future
// change passes `detached`).
//
// Two independent tripwires, because neither is reliable alone:
//   - 'disconnect' fires when the IPC channel to main closes - the normal case.
//   - polling GENSTUDIO_PARENT_PID covers a channel that broke silently or was
//     never established (pid reuse could mask a dead parent; that only delays
//     the exit until the next real check, it never kills a live app).
// Both are inert outside the desktop app (no IPC channel, no parent pid env var),
// so `npm start` / dev runs are unaffected.
const PARENT_PID = Number(process.env.GENSTUDIO_PARENT_PID) || 0;

function exitWithParent(why) {
  console.error(`Parent process is gone (${why}) - shutting the backend down.`);
  // Hard exit on purpose: the uncaughtException handler above keeps this process
  // alive through almost anything, and a lingering backend is exactly the bug.
  process.exit(0);
}

if (typeof process.send === 'function') {
  process.on('disconnect', () => exitWithParent('IPC channel closed'));
}

if (PARENT_PID > 0) {
  const parentWatchdog = setInterval(() => {
    try {
      // Signal 0 sends nothing: it only probes whether the pid still exists.
      process.kill(PARENT_PID, 0);
    } catch (err) {
      // EPERM means the process exists but is not ours to signal - still alive.
      if (err?.code === 'ESRCH') exitWithParent(`pid ${PARENT_PID} no longer exists`);
    }
  }, 5000);
  parentWatchdog.unref(); // never keep the event loop alive on the watchdog's account
}

// Explicit override for the externally-reachable base URL. Set this when the
// app sits behind a proxy that rewrites or drops the original host/port, e.g.
//   PUBLIC_BASE_URL=https://studio.example.com:4443
// When unset the base URL is derived per request (see getRequestBaseUrl).
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
// Forwarded headers are honoured by default (a proxy sets them deliberately).
// Set TRUST_PROXY_HEADERS=0 to ignore them and use the raw connection instead.
const TRUST_PROXY_HEADERS = !/^(0|false|no)$/i.test(String(process.env.TRUST_PROXY_HEADERS ?? '1').trim());
// host[:port] only — keeps a spoofed header from injecting anything else into
// the URLs we hand back to the client.
const SAFE_HOST_PATTERN = /^[A-Za-z0-9._-]+(:\d{1,5})?$/;
const DEFAULT_PORTS = { http: '80', https: '443' };
// Remember which base URLs we have already logged so a misconfigured proxy is
// obvious in the console without spamming a line per request.
const loggedBaseUrls = new Set();

// A forwarded header may carry a comma-separated list (proxy chain); the first
// entry is the value the original client saw.
function firstForwardedValue(req, header) {
  const raw = req.get(header);
  if (!raw) return '';
  return String(raw).split(',')[0].trim();
}

// Build the externally-reachable base URL ("http://host:port") from the
// incoming request so generated asset/media URLs point back at whatever host
// and port the client actually used to reach us — works on another machine or
// another port without baking "localhost" into responses.
//
// Behind a reverse proxy the connection itself only knows about the internal
// hop, so X-Forwarded-Proto/Host/Port win when present. This matters because
// the widespread `proxy_set_header Host $host;` drops the port: without the
// forwarded headers we would emit https://example.com/assets/... for a proxy
// listening on :4443, and every image would silently load from the wrong port.
function getRequestBaseUrl(req) {
  // A local install proxying for a browser asked for these URLs on its own
  // behalf. Return them RELATIVE so the browser resolves them against the
  // gateway it can actually reach — this server may be unroutable from the
  // user's network, and the browser holds no token for it either.
  if (req.get('x-genstudio-gateway') === '1') return '';
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  let protocol = req.protocol;
  let host = req.get('host') || `localhost:${PORT}`;

  if (TRUST_PROXY_HEADERS) {
    const forwardedProto = firstForwardedValue(req, 'x-forwarded-proto').toLowerCase();
    if (forwardedProto === 'http' || forwardedProto === 'https') protocol = forwardedProto;

    const forwardedHost = firstForwardedValue(req, 'x-forwarded-host');
    if (SAFE_HOST_PATTERN.test(forwardedHost)) host = forwardedHost;

    // Re-attach the public port when the forwarded host lost it (`$host`) and
    // the proxy told us which port it actually listens on (`$server_port`).
    if (!host.includes(':')) {
      const forwardedPort = firstForwardedValue(req, 'x-forwarded-port');
      if (/^\d{1,5}$/.test(forwardedPort) && forwardedPort !== DEFAULT_PORTS[protocol]) {
        host = `${host}:${forwardedPort}`;
      }
    }
  }

  const baseUrl = `${protocol}://${host}`;
  if (!loggedBaseUrls.has(baseUrl)) {
    loggedBaseUrls.add(baseUrl);
    console.log(`🌐 Resolved external base URL for generated asset URLs: ${baseUrl}`);
    console.log('   (wrong host or port? set PUBLIC_BASE_URL, or forward X-Forwarded-Host/-Proto/-Port from your proxy)');
  }
  return baseUrl;
}
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);
const comfyProgressSubscribers = new Map();
const comfyProgressSnapshots = new Map();
// Subscribers to the multiplexed progress stream — a single connection that
// receives progress for every promptId. This keeps a handful of concurrent
// workflows from exhausting the browser's ~6 connection-per-origin cap.
const comfyProgressGlobalSubscribers = new Set();
// In-flight ComfyUI runs, keyed by promptId, so a cancel request can reach the
// execution monitor that is waiting on them. A run stays registered from the
// moment its monitor is created until it settles (success, failure or cancel).
const comfyActiveRuns = new Map();
// Cancels that landed before their run registered itself — the request was
// still uploading input files to ComfyUI, so there was nothing to stop yet.
// Kept briefly so the run honours the cancel the moment it starts, instead of
// executing with nobody listening to it.
const comfyPendingCancels = new Map();
const COMFY_PENDING_CANCEL_TTL_MS = 10 * 60 * 1000;
const TENCENT_MESH_GENERATION_API_ID = 'tencent_meshgeneration';
const TENCENT_HUNYUAN_ENDPOINT = 'hunyuan.intl.tencentcloudapi.com';
const TENCENT_HUNYUAN_VERSION = '2023-09-01';
const TENCENT_REGIONS = new Set(['ap-singapore', 'eu-frankfurt', 'na-siliconvalley']);
const TENCENT_MODEL_VERSIONS = new Set(['3.0', '3.1']);
const TENCENT_GENERATION_TYPES = new Set(['Normal', 'LowPoly', 'Geometry']);
const TENCENT_POLYGON_TYPES = new Set(['triangle', 'quadrilaterial']);
const TRIPO_MESH_GENERATION_API_ID = 'tripo_meshgeneration';
const TRIPO_API_BASE_URL = 'https://openapi.tripo3d.ai/v3';
const TRIPO_MODEL_VERSIONS = new Set(['v2.0-20240919', 'v2.5-20250123', 'v3.0-20250812', 'v3.1-20260211', 'Turbo-v1.0-20250506', 'P1-20260311']);
const TRIPO_TEXTURE_ALIGNMENT_OPTIONS = new Set(['original_image', 'geometry']);
const TRIPO_TEXTURE_QUALITY_OPTIONS = new Set(['standard', 'detailed', 'extreme']);
const TRIPO_ORIENTATION_OPTIONS = new Set(['default', 'align_image']);
const TRIPO_GEOMETRY_QUALITY_OPTIONS = new Set(['standard', 'detailed']);
const TRIPO_RUNNING_STATUSES = new Set(['queued', 'running']);
const TRIPO_SUCCESS_STATUS = 'success';
const TRIPO_FAILURE_STATUSES = new Set(['failed', 'banned', 'expired', 'cancelled', 'unknown']);
const HITEM_MESH_GENERATION_API_ID = 'hitem_meshgeneration';
const HITEM_API_BASE_URL = 'https://api.hitem3d.ai/open-api/v1';
const HITEM_MODEL_VERSIONS = new Set(['hitem3dv1.5', 'hitem3dv2.0', 'hitem3dv2.1', 'hi3dv3.0']);
// Allowed resolution enum values per model (v2.1 differs from v1.5/v2.0).
const HITEM_RESOLUTIONS_BY_MODEL = {
  'hitem3dv1.5': new Set(['512', '1024', '1536', '1536pro']),
  'hitem3dv2.0': new Set(['512', '1024', '1536', '1536pro']),
  'hitem3dv2.1': new Set(['1536fast', '1536pro']),
  'hi3dv3.0': new Set(['2048quality','2048master'])
};
const HITEM_REQUEST_TYPES = new Set([1, 3]); // 1 = Mesh Only, 3 = Textured Mesh
const HITEM_FACE_MIN = 100000;
const HITEM_FACE_MAX = 5000000;
const HITEM_FORMAT_GLB = 2; // GLB output (never surfaced in the UI)
const HITEM_RUNNING_STATUSES = new Set(['processing', 'queued', 'queueing', 'pending', 'running', 'waiting']);
const HITEM_SUCCESS_STATUS = 'success';
const HITEM_FAILURE_STATUSES = new Set(['failed', 'error', 'fail']);

console.log('DEBUG: DATA_DIR is', DATA_DIR);

// Which half of the app this process is: 'local' runs everything (ComfyUI, the
// Python sidecars, Settings), 'server' serves only the shared data routes for a
// multi-user deployment. Read once here so every later guard agrees.
const SERVER_MODE = process.env.GENSTUDIO_MODE === 'server' ? 'server' : 'local';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(cors());

// Hide the local-machine routes when this process is the shared server.
// Mounted first, ahead of the body parsers and the auth gate, so a local-only
// path reads as absent whether or not the caller is authenticated.
mountLocalOnlyGuard(app, { mode: SERVER_MODE });

// Forward the shared-data routes to a remote server when one is configured,
// and serve its asset bytes from a local disk cache. Position is critical: it
// must run BEFORE express.json() and the multer routes below, so request
// bodies are still unread and a large upload streams straight through, and
// before the /assets static mount so cached remote assets win.
mountGateway(app, { mode: SERVER_MODE });
app.use('/api/meshes/editor/save', express.json({ limit: '50mb' }));
// A hand-edited clip is a key per bone per frame: a 10-second, 60-bone clip runs
// to a few megabytes of JSON, which the global 10mb limit would reject.
app.use('/api/animations/library', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '10mb' }));

// Authentication gate (server mode only; a no-op in a desktop install).
// Position is load-bearing: it must sit AFTER express.json() so the login
// route can read its body, and BEFORE the /assets static mount so asset bytes
// are gated too. The SPA shell in dist/ stays public so a browser can reach
// the login form — see PROTECTED_PREFIXES in auth.js.
// Misconfiguration must exit non-zero, not throw: the uncaughtException handler
// above deliberately keeps this process alive through almost anything, which
// would turn "no JWT secret" into a silent exit 0 that an orchestrator reads as
// a clean shutdown instead of a failed deploy.
let JWT_SECRET = null;
if (SERVER_MODE === 'server') {
  try {
    JWT_SECRET = resolveJwtSecret();
  } catch (err) {
    console.error(`\n❌ Refusing to start in server mode: ${err.message}\n`);
    process.exit(1);
  }
}
mountAuth(app, { secret: JWT_SECRET, mode: SERVER_MODE });

// Project ownership, enforced in ONE place rather than on each of the ~30
// routes that take a projectId. Cards, graph nodes, connections, boards, the
// Batch config, tags and project assets are all addressed by project, so a
// single check here covers them; adding a new project-scoped route cannot
// forget it.
//
// Mounted after mountAuth (it needs req.user) and after express.json() (a
// projectId may arrive in the body). Local installs never reach the lookup: no
// accounts, so scopeId is null and there is nothing to scope to.
app.use(async (req, res, next) => {
  if (!req.user) return next();

  // Path form: /api/projects/<digits>/... . Digits only, so /api/projects/import
  // and the collection routes fall through.
  const fromPath = /^\/api\/projects\/(\d+)(?:\/|$)/.exec(req.path)?.[1];
  const raw = fromPath ?? req.query?.projectId ?? req.body?.projectId;
  const projectId = Number(raw);
  if (!Number.isFinite(projectId) || projectId <= 0) return next();

  try {
    const project = await getProjectById(projectId);
    // A missing project is left to the route: it knows whether that is a 404, a
    // no-op, or (for a create) perfectly fine.
    if (project && !mayUse(project.ownerId, req)) {
      return res.status(403).json({ error: 'This project belongs to another user.' });
    }
  } catch (err) {
    console.warn('Project ownership check failed:', err.message);
  }
  return next();
});

// The same idea for assets addressed by id: /api/assets/<digits>/... covers
// tags, the paint document, thumbnails and the version/edit/replace ingest
// endpoints in one place.
app.use(async (req, res, next) => {
  if (!req.user) return next();

  const fromPath = /^\/api\/assets\/(\d+)(?:\/|$)/.exec(req.path)?.[1];
  if (!fromPath) return next();

  try {
    const owner = await getAssetOwnerId(Number(fromPath));
    // undefined means no such asset -- left to the route, which knows whether
    // that is a 404 or harmless.
    if (owner !== undefined && !mayUse(owner, req)) {
      return res.status(403).json({ error: 'This asset belongs to another user.' });
    }
  } catch (err) {
    console.warn('Asset ownership check failed:', err.message);
  }
  return next();
});

app.use('/assets', express.static(ASSETS_DIR));
app.use('/wiki-media', express.static(WIKI_MEDIA_DIR));

// Bundled reference animation library (mesh2motion, MIT). Ships with the app
// under resources/ (animations = skinned GLBs with clips, animpreviews = mp4s)
// and is served read-only for the mesh-editor Auto Rig → Animations feature.
const RESOURCES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resources');
app.use('/resources', express.static(RESOURCES_DIR));

// Serve the production frontend build (vite build → dist/) from the same
// origin as the API, so a single `node server.js` can host the whole app on
// any machine/port. In development the Vite dev server is used instead, so
// dist/ is absent and this is skipped.
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const HAS_DIST = existsSync(DIST_DIR);
if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
}


// Liveness probe for the Docker healthcheck. Deliberately unauthenticated and
// dependency-free: it must answer even when the database or a sidecar is down,
// otherwise an orchestrator restarts a container that is merely degraded.
// version.json is resolved against the module dir, not cwd — the desktop shell
// spawns this process with cwd set to the per-user data root, where it is absent.
app.get('/api/health', async (req, res) => {
  let version = '';
  try {
    version = JSON.parse(await fs.readFile(path.join(APP_DIR, 'version.json'), 'utf8'))?.version || '';
  } catch { /* not fatal — the probe only needs to answer */ }
  res.json({ ok: true, mode: SERVER_MODE, version });
});

// App-level event stream (SSE). Lets an open browser UI learn about mutations
// made outside of it (e.g. by an MCP client) and refetch instead of showing
// stale data until the next manual refresh.
const appEventSubscribers = new Set();
function publishAppEvent(event) {
  const serialized = `data: ${JSON.stringify({ timestamp: Date.now(), ...event })}\n\n`;
  for (const response of appEventSubscribers) {
    response.write(serialized);
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  appEventSubscribers.add(res);

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    appEventSubscribers.delete(res);
  });
});

// MCP server endpoint (POST /mcp) — lets any MCP client (Claude, ChatGPT,
// local LLMs) automate the app. Tools loop back through this server's own
// REST API, so SQLite stays behind this single process. Gated by
// settings.mcp (enabled/token) in mcp/http.js.
if (SERVER_MODE !== 'server') mountMcp(app, {
  baseUrl: `http://127.0.0.1:${PORT}`,
  getSettings,
  notifyMutation: (projectId, detail) => publishAppEvent({
    type: 'externalMutation',
    projectId: projectId ?? null,
    ...(detail || {})
  })
});

// Service logs (GET /api/logs, GET /api/logs/:id) — read-only tails of the log
// files the desktop shell writes for itself, the backend, the two Python
// services and the managed ComfyUI. Backs the Logs panel in the header.
if (SERVER_MODE !== 'server') mountLogs(app);

// Multer Config for Asset Uploads
// Uploads land here first and are moved to their real asset directory by the
// route handler, once the whole multipart body has been parsed.
//
// The destination CANNOT be derived from req.body.type as it once was: with
// multipart, text fields only populate as the stream is parsed, so whenever the
// file part arrives before the `type` field this callback saw `undefined` and
// filed the bytes under the inferred type while the database row was written
// with the real one. The record then pointed at a path with no file behind it
// and the asset downloaded as 0 bytes.
//
// Deliberately outside ASSETS_DIR so in-flight uploads are never reachable
// through the /assets static mount.
const UPLOAD_STAGING_DIR = path.join(DATA_DIR, 'incoming');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir(UPLOAD_STAGING_DIR, { recursive: true })
      .then(() => cb(null, UPLOAD_STAGING_DIR))
      .catch(err => cb(err));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Move a staged upload into the asset directory for its (now known) type.
// Returns the final absolute path so callers can clean it up on failure.
async function commitStagedUpload(file, assetType) {
  const destinationDir = getAssetDirectory(assetType);
  await fs.mkdir(destinationDir, { recursive: true });
  const finalPath = path.join(destinationDir, file.filename);
  await fs.rename(file.path, finalPath);
  file.path = finalPath;
  return finalPath;
}

app.delete('/api/assets/library/edits', async (req, res) => {
  try {
    const { filePath } = req.query;

    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const result = await deleteAssetEditByFilePath(String(filePath));

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Edit not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete asset edit:', err);
    res.status(500).json({ error: err.message || 'Failed to delete asset edit' });
  }
});

app.delete('/api/assets/library/versions', async (req, res) => {
  try {
    const { filePath, force } = req.query;

    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const result = await deleteAssetVersionByFilePath(String(filePath), {
      force: String(force || '').toLowerCase() === 'true'
    });

    if (result.status === 'linked') {
      return res.status(409).json({
        error: 'Mesh version is linked to a project',
        projectId: result.projectId,
        projectName: result.projectName || null
      });
    }

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Mesh version not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete mesh version:', err);
    res.status(500).json({ error: err.message || 'Failed to delete mesh version' });
  }
});

app.put('/api/assets/library/edits', async (req, res) => {
  try {
    const { filePath, name } = req.body;

    if (!filePath || !name?.trim()) {
      return res.status(400).json({ error: 'filePath and name are required' });
    }

    res.json(await renameAssetEditByFilePath(String(filePath), name));
  } catch (err) {
    console.error('Failed to rename asset edit:', err);
    res.status(500).json({ error: err.message || 'Failed to rename asset edit' });
  }
});

// --- ownership -----------------------------------------------------------
// On a shared server, projects and assets belong to the user who made them and
// nobody sees anyone else's. Two cases see everything, and both are expressed
// as "no viewer to scope to":
//
//   * a desktop install -- there are no accounts, so req.user is undefined and
//     every listing behaves exactly as it did before this existed;
//   * an administrator.
//
// Unowned rows (ownerId NULL) stay visible to everyone: they were written
// before ownership existed and belong to no one to hide them from.

// The signed-in user, or null when there is none.
function viewerId(req) {
  const id = Number(req.user?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// Who to scope a LISTING to -- null means "show everything".
function scopeId(req) {
  return req.user?.role === 'admin' ? null : viewerId(req);
}

// Whether the caller may touch one record, given its owner.
function mayUse(ownerId, req) {
  const owner = ownerId ?? null;
  if (owner === null) return true;
  if (req.user?.role === 'admin') return true;
  return Number(owner) === viewerId(req);
}

function mayUseWorkflow(record, req) {
  return mayUse(record?.ownerId, req);
}

const NOT_YOURS = 'This belongs to another user.';

// The middleware pair above cannot see a MULTIPART body: multer parses it
// inside the route, long after they run, so a projectId or assetId sent as a
// form field is invisible to them. Those routes call these two helpers
// themselves, immediately after multer. (This is the same body-timing trap that
// once filed uploaded assets under the wrong type.)
async function requireAssetAccess(req, res, assetId) {
  const owner = await getAssetOwnerId(Number(assetId));
  if (owner === undefined) return true;          // no such asset: the route reports it
  if (mayUse(owner, req)) return true;
  res.status(403).json({ error: 'This asset belongs to another user.' });
  return false;
}

async function requireProjectAccess(req, res, projectId) {
  const id = Number(projectId);
  if (!Number.isFinite(id) || id <= 0) return true;
  const project = await getProjectById(id);
  if (!project) return true;                     // the route decides what a missing project means
  if (mayUse(project.ownerId, req)) return true;
  res.status(403).json({ error: 'This project belongs to another user.' });
  return false;
}

// Ownership for an asset addressed by its stored path instead of its id.
async function mayUseAssetByFilePath(type, filePath, req) {
  if (!req.user) return true;
  const existing = await findAssetByFilePath(type, filePath);
  if (!existing) return true;   // nothing there; the route reports it
  return mayUse(await getAssetOwnerId(Number(existing.id)), req);
}

// Resolve a project and refuse it if it is not the caller's. Returns the
// project, or null once it has already answered the request -- so callers read
// as `const project = await requireProject(...); if (!project) return;`
async function requireProject(req, res, projectId) {
  const project = await getProjectById(Number(projectId));
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  if (!mayUse(project.ownerId, req)) {
    // 403 rather than 404: it exists, and "not found" reads as data loss.
    res.status(403).json({ error: 'This project belongs to another user.' });
    return null;
  }
  return project;
}

app.get('/api/library/comfy-workflows', async (req, res) => {
  try {
    const workflowRecords = await listWorkflowRecords(viewerId(req));
    const workflows = (await Promise.all(workflowRecords.map(async record => {
      try {
        return await buildWorkflowResponse(record);
      } catch (err) {
        console.warn(`Skipping invalid workflow ${record?.id}:`, err.message);
        return null;
      }
    }))).filter(Boolean);

    res.json(workflows);
  } catch (err) {
    console.error('Failed to list ComfyUI workflows:', err);
    res.status(500).json({ error: 'Failed to list ComfyUI workflows' });
  }
});

// One workflow, graph JSON included. Workflow DEFINITIONS are shared so that a
// card's workflowId means the same thing to everyone, while EXECUTION stays on
// each user's own ComfyUI — so a remote-connected install fetches the definition
// from here at run time. Needed as a by-id route because the list above returns
// every graph in the library, which is far too much to pull per run.
app.get('/api/library/comfy-workflows/:id', async (req, res) => {
  try {
    const record = await getWorkflowRecordById(Number(req.params.id));
    if (!record) return res.status(404).json({ error: 'ComfyUI workflow not found' });
    if (!mayUseWorkflow(record, req)) {
      // Not a 404: it does exist, and saying so is the difference between "your
      // data is gone" and "that one belongs to a teammate".
      return res.status(403).json({
        error: 'This workflow belongs to another user. Import your own copy to run it.'
      });
    }
    res.json(await buildWorkflowResponse(record));
  } catch (err) {
    console.error('Failed to read the ComfyUI workflow:', err);
    res.status(500).json({ error: err.message || 'Failed to read the ComfyUI workflow' });
  }
});

app.post('/api/library/comfy-workflows/inspect', async (req, res) => {
  try {
    const { workflowJson } = req.body;
    const parsed = parseComfyWorkflow(workflowJson);
    res.json(parsed);
  } catch (err) {
    console.error('Failed to inspect ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to inspect workflow JSON' });
  }
});

app.post('/api/library/comfy-workflows', async (req, res) => {
  try {
    const { name, workflowJson, parameters = [], outputs = [] } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'A workflow name is required' });
    }

    const parsed = parseComfyWorkflow(workflowJson);
    const availableParameters = new Map(parsed.inputs.map(input => [input.id, input]));
    const availableOutputs = new Map(parsed.outputs.map(output => [output.nodeId, output]));

    const selectedParameters = parameters.map(parameter => {
      const sourceParameter = availableParameters.get(parameter.id);
      if (!sourceParameter) {
        throw new Error(`Unknown workflow parameter: ${parameter.id}`);
      }

      const valueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(sourceParameter));

      return {
        ...sourceParameter,
        name: sanitizeDisplayName(parameter.name || sourceParameter.name, sourceParameter.name),
        valueType,
        enums: normalizeComfyEnums(parameter.enums, valueType)
      };
    });

    const selectedOutputs = outputs.map(output => {
      const outputId = String(output.nodeId || output.id);
      const sourceOutput = availableOutputs.get(outputId);
      if (!sourceOutput) {
        throw new Error(`Unknown workflow output: ${outputId}`);
      }

      return {
        ...sourceOutput,
        name: sanitizeDisplayName(output.name || sourceOutput.nodeTitle, sourceOutput.nodeTitle),
        valueType: normalizeComfyValueType(output.valueType, getDefaultComfyValueType(sourceOutput, true))
      };
    });

    if (selectedOutputs.length === 0) {
      return res.status(400).json({ error: 'Select at least one output node to save images from' });
    }

    const filePath = await saveWorkflowFile(name, workflowJson);
    const workflowRecord = await createWorkflowRecord({
      name: sanitizeDisplayName(name, 'Workflow'),
      filePath,
      parameters: selectedParameters,
      outputs: selectedOutputs,
      ownerId: viewerId(req)
    });

    res.status(201).json(await buildWorkflowResponse(workflowRecord));
  } catch (err) {
    console.error('Failed to save ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to save ComfyUI workflow' });
  }
});

app.put('/api/library/comfy-workflows/:id', async (req, res) => {
  try {
    const { name, parameters = [], outputs = [], workflowJson } = req.body;
    const existingWorkflowRecord = await getWorkflowRecordById(Number(req.params.id));

    if (!existingWorkflowRecord) {
      return res.status(404).json({ error: 'ComfyUI workflow not found' });
    }
    if (!mayUseWorkflow(existingWorkflowRecord, req)) {
      return res.status(403).json({ error: 'This workflow belongs to another user.' });
    }

    const existingWorkflow = await buildWorkflowResponse(existingWorkflowRecord);

    // When a new graph is supplied (overwriting an existing workflow with an
    // imported .3dgw bundle), validate the parameters/outputs against the NEW
    // graph and persist it; otherwise keep the existing graph and only update
    // its configuration.
    const replacingGraph = workflowJson !== undefined && workflowJson !== null;
    const parsedGraph = replacingGraph ? parseComfyWorkflow(workflowJson) : null;
    const availableInputsSource = replacingGraph ? parsedGraph.inputs : (existingWorkflow.availableInputs || []);
    const availableOutputsSource = replacingGraph ? parsedGraph.outputs : (existingWorkflow.availableOutputs || []);
    const availableParameters = new Map(availableInputsSource.map(input => [input.id, input]));
    const availableOutputs = new Map(availableOutputsSource.map(output => [output.nodeId, output]));
    const existingParameters = new Map((existingWorkflow.parameters || []).map(parameter => [parameter.id, parameter]));

    const nextParameters = parameters.map(parameter => {
      const sourceParameter = availableParameters.get(parameter.id);
      if (!sourceParameter) {
        throw new Error(`Unknown workflow parameter: ${parameter.id}`);
      }

      const storedParameter = existingParameters.get(parameter.id);
      // Persist the saved default: prefer an incoming defaultValue (e.g. "Set as default"),
      // otherwise keep any previously stored default, and finally fall back to the workflow file value.
      let defaultValue;
      if (Object.prototype.hasOwnProperty.call(parameter, 'defaultValue')) {
        defaultValue = coerceComfyParameterValue(sourceParameter, parameter.defaultValue);
      } else if (storedParameter && storedParameter.defaultValue !== undefined) {
        defaultValue = cloneSerializable(storedParameter.defaultValue);
      } else {
        defaultValue = cloneSerializable(sourceParameter.defaultValue);
      }

      const valueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(sourceParameter));

      // Same rule as defaultValue: an incoming list wins (including an empty one,
      // which clears the enums), otherwise keep whatever was stored — callers such
      // as "Set as default" send a minimal parameter list and must not wipe it.
      const enums = Object.prototype.hasOwnProperty.call(parameter, 'enums')
        ? normalizeComfyEnums(parameter.enums, valueType)
        : normalizeComfyEnums(storedParameter?.enums, valueType);

      return {
        ...sourceParameter,
        name: sanitizeDisplayName(parameter.name || sourceParameter.name, sourceParameter.name),
        valueType,
        enums,
        defaultValue
      };
    });

    const nextOutputs = outputs.map(output => {
      const outputId = String(output.nodeId || output.id);
      const sourceOutput = availableOutputs.get(outputId);
      if (!sourceOutput) {
        throw new Error(`Unknown workflow output: ${outputId}`);
      }

      return {
        ...sourceOutput,
        name: sanitizeDisplayName(output.name || sourceOutput.nodeTitle, sourceOutput.nodeTitle),
        valueType: normalizeComfyValueType(output.valueType, getDefaultComfyValueType(sourceOutput, true))
      };
    });

    if (nextOutputs.length === 0) {
      return res.status(400).json({ error: 'Select at least one output node to save images from' });
    }

    // Persist the new graph to disk (and remember the old file for cleanup)
    // only once the configuration above has validated successfully.
    let nextFilePath;
    if (replacingGraph) {
      nextFilePath = await saveWorkflowFile(name || existingWorkflow.name, workflowJson);
    }

    const nextWorkflow = await updateWorkflowRecord(existingWorkflow.id, {
      name: sanitizeDisplayName(name || existingWorkflow.name, existingWorkflow.name),
      parameters: nextParameters,
      outputs: nextOutputs,
      ...(replacingGraph ? { filePath: nextFilePath } : {})
    });

    // Drop the superseded graph file now that the record points at the new one.
    if (replacingGraph && existingWorkflowRecord.filePath && existingWorkflowRecord.filePath !== nextFilePath) {
      try {
        await fs.unlink(toAbsoluteStoragePath(existingWorkflowRecord.filePath));
      } catch (cleanupErr) {
        console.warn('Failed to remove superseded workflow file:', cleanupErr);
      }
    }

    res.json(await buildWorkflowResponse(nextWorkflow));
  } catch (err) {
    console.error('Failed to update ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to update ComfyUI workflow' });
  }
});
const upload = multer({ storage });
const workflowExecutionUpload = multer({ storage: multer.memoryStorage() });
const libraryImportUpload = multer({ storage: multer.memoryStorage() });
const thumbnailUpload = multer({ storage: multer.memoryStorage() });
const meshEditorSaveUpload = multer({ storage: multer.memoryStorage() });
const paintDocumentUpload = multer({ storage: multer.memoryStorage() });
const wikiMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 * 1024 } });

const WIKI_MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
  '.mp4', '.webm', '.ogg', '.mov', '.m4v'
]);

function buildWikiPageTree(pages) {
  const byId = new Map(pages.map(page => [page.id, { ...page, children: [] }]));
  const roots = [];
  for (const page of byId.values()) {
    if (page.parentId !== null && page.parentId !== undefined && byId.has(page.parentId)) {
      byId.get(page.parentId).children.push(page);
    } else {
      roots.push(page);
    }
  }
  const sortNodes = nodes => {
    nodes.sort((a, b) => (a.position - b.position) || (a.id - b.id));
    nodes.forEach(node => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

// ── Wiki ──────────────────────────────────────────────────────────────────
// Author mode is unlocked only when the gitignored `.wiki-author` marker file
// exists at the project root. Checked live so it can be toggled without a
// restart. Read-only installations (end users) never have this file.
const WIKI_AUTHOR_FLAG = path.join(process.cwd(), '.wiki-author');

function isWikiAuthorMode() {
  return existsSync(WIKI_AUTHOR_FLAG);
}

function requireWikiAuthor(req, res, next) {
  if (!isWikiAuthorMode()) {
    return res.status(403).json({ error: 'The Wiki is read-only on this installation.' });
  }
  next();
}

app.get('/api/wiki/config', (req, res) => {
  res.json({ authorMode: isWikiAuthorMode() });
});

app.get('/api/wiki/pages', async (req, res) => {
  try {
    const pages = await listWikiPages();
    res.json({ pages, tree: buildWikiPageTree(pages) });
  } catch (err) {
    console.error('Failed to list wiki pages:', err);
    res.status(500).json({ error: err.message || 'Failed to list wiki pages' });
  }
});

app.get('/api/wiki/pages/:id', async (req, res) => {
  try {
    const page = await getWikiPage(req.params.id);
    if (!page) {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.json(page);
  } catch (err) {
    console.error('Failed to load wiki page:', err);
    res.status(500).json({ error: err.message || 'Failed to load wiki page' });
  }
});

app.post('/api/wiki/pages', requireWikiAuthor, async (req, res) => {
  try {
    const { parentId = null, title, icon = null, content = '' } = req.body || {};
    const page = await createWikiPage({ parentId, title, icon, content });
    res.status(201).json(page);
  } catch (err) {
    console.error('Failed to create wiki page:', err);
    res.status(400).json({ error: err.message || 'Failed to create wiki page' });
  }
});

app.put('/api/wiki/pages/:id', requireWikiAuthor, async (req, res) => {
  try {
    const { title, icon, content } = req.body || {};
    const page = await updateWikiPage(req.params.id, { title, icon, content });
    if (!page) {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.json(page);
  } catch (err) {
    console.error('Failed to update wiki page:', err);
    res.status(400).json({ error: err.message || 'Failed to update wiki page' });
  }
});

app.put('/api/wiki/pages/:id/move', requireWikiAuthor, async (req, res) => {
  try {
    const { parentId, position } = req.body || {};
    const page = await moveWikiPage(req.params.id, { parentId, position });
    if (!page) {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.json(page);
  } catch (err) {
    console.error('Failed to move wiki page:', err);
    res.status(400).json({ error: err.message || 'Failed to move wiki page' });
  }
});

app.delete('/api/wiki/pages/:id', requireWikiAuthor, async (req, res) => {
  try {
    const result = await deleteWikiPage(req.params.id);
    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete wiki page:', err);
    res.status(500).json({ error: err.message || 'Failed to delete wiki page' });
  }
});

app.post('/api/wiki/media', requireWikiAuthor, wikiMediaUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const extension = path.extname(req.file.originalname).toLowerCase();
    if (!WIKI_MEDIA_EXTENSIONS.has(extension)) {
      return res.status(400).json({ error: `Unsupported file type: ${extension || 'unknown'}` });
    }

    await fs.mkdir(WIKI_MEDIA_DIR, { recursive: true });
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    await fs.writeFile(path.join(WIKI_MEDIA_DIR, uniqueName), req.file.buffer);

    const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.m4v'].includes(extension);
    res.status(201).json({
      url: `${getRequestBaseUrl(req)}/wiki-media/${encodeURIComponent(uniqueName)}`,
      kind: isVideo ? 'video' : 'image',
      name: req.file.originalname
    });
  } catch (err) {
    console.error('Failed to upload wiki media:', err);
    res.status(500).json({ error: err.message || 'Failed to upload wiki media' });
  }
});

const INITIAL_SCHEMA = {
  projects: [
    {
      id: 1,
      name: 'Cyberpunk_District_V1',
      description: 'High-fidelity urban environment with neon-lit architecture.',
      preset: 'Photorealistic ArchViz',
      createdAt: Date.now(),
      status: 'active'
    }
  ],
  assets: [],
  tasks: [],
  settings: {
    profile: {
      name: 'User',
      avatar: null
    },
    apis: {
      google: {
        apiKey: '',
        imageGeneration: {
          headerName: 'x-goog-api-key',
          payloadTemplate: {
            contents: [
              {
                parts: [
                  { text: '{prompt}' }
                ]
              }
            ],
			generationConfig: {
			  responseModalities: ['Image']
			}
          },
          models: {
            nanobana: {
              name: 'Nanobanana',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent'
            },
            nanobana_pro: {
              name: 'Nanobanana Pro',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent'
            },
            nanobana_2: {
              name: 'Nanobanana 2',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent'
            }
          }
        }
      },
      openai: { apiKey: '' },
      tencentcloud: {
        secretId: '',
        secretKey: '',
        meshGeneration: {
          models: {
            meshgeneration: {
              name: 'Hunyuan3D Pro',
              model: 'meshgeneration'
            }
          }
        }
      },
      tripoai: {
        apiKey: '',
        meshGeneration: {
          models: {
            meshgeneration: {
              name: 'Tripo AI',
              model: 'meshgeneration'
            }
          }
        }
      },
      hitem3d: {
        accessKey: '',
        secretKey: '',
        accessToken: ''
      },
      comfyui: {
        path: '',
        url: 'http://127.0.0.1',
        port: '8188'
      },
      custom: []
    }
  },
  library: {
    comfyWorkflows: []
  }
};

async function updateCardProcessingSnapshot(projectId, cardId, {
  columnName = 'Images',
  name = null,
  status = 'processing',
  progressPercent = null,
  detail = '',
  currentNodeLabel = '',
  promptId = null,
  source = 'ComfyUI',
  operationType = 'workflow',
  workflowId = null,
  workflowName = null,
  startedAt = Date.now(),
  ...processingMetadata
} = {}) {
  if (!projectId || !cardId) {
    return null;
  }

  return await setCardProcessing(Number(projectId), cardId, {
    columnName,
    name,
    status,
    progress: Number.isFinite(progressPercent) ? Math.max(0, Math.min(100, Math.round(progressPercent))) : null,
    processing: {
      status,
      name,
      progressPercent: Number.isFinite(progressPercent) ? Math.max(0, Math.min(100, Math.round(progressPercent))) : null,
      detail,
      currentNodeLabel,
      promptId,
      source,
      operationType,
      workflowId,
      workflowName,
      startedAt,
      updatedAt: Date.now(),
      ...processingMetadata
    },
    creationDate: startedAt
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeDisplayName(value = '', fallback = 'Workflow') {
  const normalized = String(value)
    .trim()
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  return normalized || fallback;
}

function sanitizeFileSegment(value = '', fallback = 'mesh') {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function createMeshEditorFilePath(name = 'mesh') {
  return `data/assets/meshes/${sanitizeFileSegment(name)}-${Date.now()}.glb`;
}

async function resolveEditableMeshAsset({ assetId, filePath }) {
  const numericAssetId = Number(assetId)

  if (Number.isFinite(numericAssetId) && numericAssetId > 0) {
    return await getAssetRecord({ assetId: numericAssetId });
  }

  if (!filePath) {
    return null;
  }

  return await getAssetRecord({ type: 'mesh', filePath });
}

function inferComfyParameterType(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value) || isPlainObject(value)) return 'json';
  return 'string';
}

function getDefaultComfyValueType(item, isOutput = false) {
  if (isOutput) return 'image';
  if (item?.type === 'boolean') return 'boolean';
  return item?.type === 'number' ? 'number' : 'string';
}

function normalizeComfyValueType(value, fallback = 'string') {
  return ['string', 'number', 'boolean', 'image', 'video', 'mesh'].includes(value) ? value : fallback;
}

// Enums restrict a String / Number parameter to a fixed list of allowed values,
// which the UI renders as a dropdown. Entries are coerced to the parameter's value
// type and de-duplicated; a non-String/Number parameter never keeps a list.
// Returns undefined when there is nothing to store (JSON.stringify drops the key).
function normalizeComfyEnums(rawEnums, valueType) {
  if (!Array.isArray(rawEnums) || !['string', 'number'].includes(valueType)) return undefined;

  const values = [];

  for (const entry of rawEnums) {
    if (entry === null || entry === undefined || typeof entry === 'boolean' || typeof entry === 'object') continue;

    if (valueType === 'number') {
      const numericValue = Number(entry);
      if (!Number.isFinite(numericValue) || values.includes(numericValue)) continue;
      values.push(numericValue);
      continue;
    }

    const textValue = String(entry).trim();
    if (!textValue || values.includes(textValue)) continue;
    values.push(textValue);
  }

  return values.length > 0 ? values : undefined;
}

function getComfyNodeLabel(nodeId, node = {}) {
  return sanitizeDisplayName(node._meta?.title || node.title || node.class_type || `Node ${nodeId}`, `Node ${nodeId}`);
}

function parseComfyWorkflow(workflowJson) {
  if (!isPlainObject(workflowJson) || Object.keys(workflowJson).length === 0) {
    throw new Error('The workflow JSON is empty or invalid');
  }

  const nodes = Object.entries(workflowJson)
    .filter(([, node]) => isPlainObject(node))
    .map(([nodeId, node]) => [String(nodeId), node]);

  if (nodes.length === 0) {
    throw new Error('The workflow JSON does not contain any nodes');
  }

  const referencedNodeIds = new Set();

  for (const [, node] of nodes) {
    for (const value of Object.values(node.inputs || {})) {
      if (Array.isArray(value) && value.length >= 2 && (typeof value[0] === 'string' || typeof value[0] === 'number')) {
        referencedNodeIds.add(String(value[0]));
      }
    }
  }

  const inputs = [];

  for (const [nodeId, node] of nodes) {
    const nodeLabel = getComfyNodeLabel(nodeId, node);

    for (const [inputKey, value] of Object.entries(node.inputs || {})) {
      const isNodeReference = Array.isArray(value) && value.length >= 2 && (typeof value[0] === 'string' || typeof value[0] === 'number');
      if (isNodeReference || value === null || value === undefined) continue;

      const type = inferComfyParameterType(value);
      if (!['string', 'number', 'boolean', 'json'].includes(type)) continue;

      inputs.push({
        id: `${nodeId}.${inputKey}`,
        nodeId,
        inputKey,
        nodeTitle: nodeLabel,
        classType: node.class_type || 'Unknown',
        name: sanitizeDisplayName(`${nodeLabel} ${inputKey}`, inputKey),
        label: `${nodeLabel} • ${inputKey}`,
        type,
        defaultValue: cloneSerializable(value)
      });
    }
  }

  const outputs = nodes
    .filter(([nodeId]) => !referencedNodeIds.has(nodeId))
    .map(([nodeId, node]) => ({
      id: nodeId,
      nodeId,
      nodeTitle: getComfyNodeLabel(nodeId, node),
      classType: node.class_type || 'Unknown',
      label: `${getComfyNodeLabel(nodeId, node)} • ${node.class_type || 'Output'}`
    }));

  return { inputs, outputs };
}

function buildComfyUiBaseUrl(settings = {}) {
  const comfySettings = settings?.apis?.comfyui || {};
  const rawUrl = String(comfySettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(comfySettings.port || parsedUrl.port || '8188').trim();

  parsedUrl.port = port;
  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

function buildMeshToolsBaseUrl(settings = {}) {
  const meshSettings = settings?.apis?.meshtools || {};
  const rawUrl = String(meshSettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(meshSettings.port || parsedUrl.port || '8200').trim();

  parsedUrl.port = port;
  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

// Base URL of the dedicated rigging micro-service (thirdparty/skintokens/rig_server.py).
// It lives on its own host/port because it needs a heavy GPU/ML environment that
// must not mix with the mesh-tools service. Mirrors buildMeshToolsBaseUrl.
function buildRigToolsBaseUrl(settings = {}) {
  const rigSettings = settings?.apis?.rigtools || {};
  const rawUrl = String(rigSettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(rigSettings.port || parsedUrl.port || '8300').trim();

  parsedUrl.port = port;
  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

// Base URL of the text-to-motion micro-service (thirdparty/kimodo/motion_server.py).
// A third GPU service on its own host/port: Kimodo pins transformers==5.1.0 for
// its bidirectional text encoder, which the rigging venv (5.13) cannot satisfy.
// Mirrors buildRigToolsBaseUrl.
function buildMotionToolsBaseUrl(settings = {}) {
  const motionSettings = settings?.apis?.motiontools || {};
  const rawUrl = String(motionSettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(motionSettings.port || parsedUrl.port || '8400').trim();

  parsedUrl.port = port;
  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

// Base URL of the video-to-motion micro-service
// (thirdparty/mocapanything/mocap_server.py). A fourth GPU service on its own
// host/port: MoCapAnything pins torch 2.9 / transformers 4.57, which neither the
// Kimodo venv (transformers 5.1.0) nor the rigging venv (5.13) can satisfy.
// Mirrors buildMotionToolsBaseUrl.
function buildMocapToolsBaseUrl(settings = {}) {
  const mocapSettings = settings?.apis?.mocaptools || {};
  const rawUrl = String(mocapSettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(mocapSettings.port || parsedUrl.port || '8401').trim();

  parsedUrl.port = port;
  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

function buildComfyUiWebSocketUrl(baseUrl, clientId) {
  const parsedUrl = new URL(baseUrl);
  const currentPath = parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname.replace(/\/$/, '') : '';

  parsedUrl.protocol = parsedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  parsedUrl.pathname = `${currentPath}/ws`;
  parsedUrl.search = '';
  parsedUrl.hash = '';
  parsedUrl.searchParams.set('clientId', clientId);

  return parsedUrl.toString();
}

function getComfyExecutionNodeIds(workflowJson = {}, selectedOutputs = []) {
  const availableNodeIds = Object.keys(workflowJson || {});

  if (availableNodeIds.length === 0) {
    return new Set();
  }

  const preferredNodeIds = selectedOutputs
    .map(output => String(output?.nodeId || output?.id || ''))
    .filter(nodeId => nodeId && workflowJson?.[nodeId]);
  const reachableNodeIds = new Set();
  const queue = preferredNodeIds.length > 0 ? [...preferredNodeIds] : [...availableNodeIds];

  while (queue.length > 0) {
    const nodeId = String(queue.pop());
    if (!nodeId || reachableNodeIds.has(nodeId) || !workflowJson?.[nodeId]) {
      continue;
    }

    reachableNodeIds.add(nodeId);

    for (const inputValue of Object.values(workflowJson[nodeId]?.inputs || {})) {
      if (Array.isArray(inputValue) && inputValue.length > 0 && workflowJson?.[String(inputValue[0])]) {
        queue.push(String(inputValue[0]));
      }
    }
  }

  return reachableNodeIds.size > 0 ? reachableNodeIds : new Set(availableNodeIds);
}

function getComfyExecutionNodeLabel(workflowJson, nodeId) {
  const node = workflowJson?.[String(nodeId)];
  return node?._meta?.title || node?.title || node?.class_type || `Node ${nodeId}`;
}

function getComfyExecutionProgressPercent(completedNodeCount, totalNodeCount, nodeProgress = 0, isComplete = false) {
  if (isComplete) {
    return 100;
  }

  const safeTotalNodeCount = Math.max(1, Number(totalNodeCount) || 1);
  const safeNodeProgress = Number.isFinite(nodeProgress) ? Math.min(Math.max(nodeProgress, 0), 1) : 0;
  const rawPercent = ((completedNodeCount + safeNodeProgress) / safeTotalNodeCount) * 100;

  return Math.max(0, Math.min(99, Math.round(rawPercent)));
}

function getComfyProgressSubscribers(promptId) {
  const key = String(promptId || '');
  if (!comfyProgressSubscribers.has(key)) {
    comfyProgressSubscribers.set(key, new Set());
  }

  return comfyProgressSubscribers.get(key);
}

function publishComfyProgress(promptId, payload) {
  const key = String(promptId || '');
  const message = {
    promptId: key,
    timestamp: Date.now(),
    ...payload
  };

  comfyProgressSnapshots.set(key, message);

  const serialized = `data: ${JSON.stringify(message)}\n\n`;

  for (const response of getComfyProgressSubscribers(key)) {
    response.write(serialized);
  }

  for (const response of comfyProgressGlobalSubscribers) {
    response.write(serialized);
  }

  if (message.status === 'completed' || message.status === 'error' || message.status === 'cancelled') {
    setTimeout(() => {
      if ((comfyProgressSubscribers.get(key)?.size || 0) === 0) {
        comfyProgressSubscribers.delete(key);
        comfyProgressSnapshots.delete(key);
      }
    }, 60000);
  }
}

// A run the user asked to stop. Thrown by the execution monitor so the routes
// can tell "the user cancelled" apart from "ComfyUI failed" and report a
// cancellation instead of an error.
class ComfyCancelledError extends Error {
  constructor(message = 'Workflow cancelled') {
    super(message);
    this.name = 'ComfyCancelledError';
    this.cancelled = true;
  }
}

function markComfyCancelledBeforeStart(promptId) {
  const now = Date.now();
  for (const [id, requestedAt] of comfyPendingCancels) {
    if (now - requestedAt > COMFY_PENDING_CANCEL_TTL_MS) {
      comfyPendingCancels.delete(id);
    }
  }
  comfyPendingCancels.set(String(promptId || ''), now);
}

function registerComfyRun(promptId, run) {
  const key = String(promptId || '');
  if (!key) {
    return () => {};
  }

  // Cancelled while this run was still being prepared: carry that decision
  // into the run so it stops instead of queueing.
  if (comfyPendingCancels.delete(key)) {
    run.cancelRequested = true;
  }

  comfyActiveRuns.set(key, run);
  return () => {
    if (comfyActiveRuns.get(key) === run) {
      comfyActiveRuns.delete(key);
    }
  };
}

// Ask ComfyUI to stop a prompt. The v2 jobs API cancels a specific job (queued
// or running); older builds have no such endpoint, so fall back to the legacy
// pair: delete it from the pending queue, or interrupt it if it is the one
// currently executing. Either way the stop only takes effect at a node/step
// boundary, so the monitor is settled locally by the caller.
async function cancelComfyPrompt(baseUrl, promptId) {
  const key = String(promptId || '');

  try {
    const response = await fetch(`${baseUrl}/api/v2/jobs/${encodeURIComponent(key)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });

    if (response.ok) {
      return { cancelled: true, via: 'jobs-v2' };
    }
  } catch (err) {
    console.warn(`ComfyUI v2 cancel endpoint unreachable for ${key}:`, err.message);
  }

  // Legacy path: find out whether the prompt is still pending or already running.
  let isPending = false;
  let isRunning = false;

  try {
    const queueResponse = await fetch(`${baseUrl}/queue`);
    const queue = await queueResponse.json().catch(() => ({}));
    const matches = (entries) => (Array.isArray(entries) ? entries : []).some(entry => String(entry?.[1] || '') === key);
    isPending = matches(queue?.queue_pending);
    isRunning = matches(queue?.queue_running);
  } catch (err) {
    console.warn(`Failed to read the ComfyUI queue while cancelling ${key}:`, err.message);
  }

  if (isPending) {
    const response = await fetch(`${baseUrl}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [key] })
    });

    if (!response.ok) {
      throw new Error('ComfyUI refused to remove the queued workflow');
    }

    return { cancelled: true, via: 'queue-delete' };
  }

  if (isRunning) {
    const response = await fetch(`${baseUrl}/interrupt`, { method: 'POST' });

    if (!response.ok) {
      throw new Error('ComfyUI refused to interrupt the running workflow');
    }

    return { cancelled: true, via: 'interrupt' };
  }

  // Neither queued nor running: it finished (or never reached ComfyUI) between
  // the click and this request. Nothing to stop on the ComfyUI side.
  return { cancelled: false, via: 'already-terminal' };
}

// Stop a run this server is tracking: tell ComfyUI, then settle the local
// monitor so the waiting route stops immediately instead of hanging until the
// WebSocket happens to close (a prompt deleted while still queued never emits
// an interruption message at all).
async function cancelComfyRun(promptId) {
  const key = String(promptId || '');
  const run = comfyActiveRuns.get(key);

  if (!run) {
    return { cancelled: false, tracked: false };
  }

  run.cancelRequested = true;

  let outcome = { cancelled: false, via: 'already-terminal' };
  let settledByMonitor = false;
  try {
    outcome = await cancelComfyPrompt(run.baseUrl, key);
  } finally {
    settledByMonitor = Boolean(run.monitor?.cancel?.('Workflow cancelled'));
  }

  // The monitor had already settled — the run finished on ComfyUI's side and is
  // somewhere in the finalize phase (waiting on /history, downloading, saving).
  // Nothing left will publish a terminal event for it, so publish one here or
  // the client sits on "Cancelling…" until it gives up. The finalizer sees
  // cancelRequested at its next checkpoint and stops.
  if (!settledByMonitor) {
    publishComfyProgress(key, {
      status: 'cancelled',
      detail: 'Workflow cancelled',
      currentNodeLabel: 'Cancelled',
      done: true,
      cancelled: true
    });
  }

  return { ...outcome, tracked: true, settledByMonitor };
}

function subscribeToAllComfyProgress(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  comfyProgressGlobalSubscribers.add(res);

  // Replay the latest snapshot for every in-flight prompt so a freshly opened
  // (or reconnected) stream immediately catches up on current state.
  for (const snapshot of comfyProgressSnapshots.values()) {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    comfyProgressGlobalSubscribers.delete(res);
  });
}

function subscribeToComfyProgress(promptId, req, res) {
  const key = String(promptId || '');
  const subscribers = getComfyProgressSubscribers(key);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  subscribers.add(res);

  const snapshot = comfyProgressSnapshots.get(key);
  if (snapshot) {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(res);

    if (subscribers.size === 0 && !comfyProgressSnapshots.has(key)) {
      comfyProgressSubscribers.delete(key);
    }
  });
}

function createComfyExecutionMonitor(baseUrl, { clientId, promptId, workflowJson, selectedOutputs = [], timeout = null, onProgress = null }) {
  const trackedNodeIds = getComfyExecutionNodeIds(workflowJson, selectedOutputs);
  const totalNodeCount = Math.max(1, trackedNodeIds.size || Object.keys(workflowJson || {}).length || 1);
  const wsUrl = buildComfyUiWebSocketUrl(baseUrl, clientId);
  const completedNodes = new Set();
  let currentNodeId = null;
  let currentNodeProgress = 0;
  let socket = null;
  let timer = null;
  let isReady = false;
  let isSettled = false;
  let rejectCompletion = null;
  let rejectReady = null;

  const normalizeNodeId = (nodeId) => String(nodeId || '');
  const isTrackedNode = (nodeId) => trackedNodeIds.size === 0 || trackedNodeIds.has(normalizeNodeId(nodeId));
  const getCompletedNodeCount = () => completedNodes.size;
  const getProgressPercent = (isComplete = false) => {
    const runningNodeBonus = currentNodeId && !completedNodes.has(currentNodeId) && isTrackedNode(currentNodeId)
      ? currentNodeProgress
      : 0;

    return getComfyExecutionProgressPercent(getCompletedNodeCount(), totalNodeCount, runningNodeBonus, isComplete);
  };
  const markNodeCompleted = (nodeId) => {
    const normalizedNodeId = normalizeNodeId(nodeId);
    if (!normalizedNodeId || !isTrackedNode(normalizedNodeId)) {
      return false;
    }

    completedNodes.add(normalizedNodeId);

    if (currentNodeId === normalizedNodeId) {
      currentNodeProgress = 0;
    }

    return true;
  };
  const publishState = (payload) => {
    const nextPayload = {
      totalNodeCount,
      completedNodeCount: getCompletedNodeCount(),
      progressPercent: getProgressPercent(payload?.status === 'completed'),
      ...payload
    };

    publishComfyProgress(promptId, nextPayload);
    onProgress?.(nextPayload);
  };

  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    socket = new WebSocketImpl(wsUrl);

    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        isSettled = true;
        publishState({
          status: 'error',
          detail: `Job did not complete within ${Math.round(timeout / 1000)}s`,
          currentNodeLabel: 'Timed out'
        });
        socket.close();
        rejectCompletion?.(new Error(`Job did not complete within ${Math.round(timeout / 1000)}s`));
        reject(new Error(`Job did not complete within ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }

    socket.onopen = () => {
      isReady = true;
      publishState({
        status: 'connected',
        detail: `Connected to ComfyUI • ${totalNodeCount} workflow nodes`,
        currentNodeLabel: 'Waiting for execution to start'
      });
      resolve();
    };

    socket.onerror = (error) => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      publishState({
        status: 'error',
        detail: 'Failed to connect to ComfyUI progress stream',
        currentNodeLabel: 'Connection failed'
      });

      rejectCompletion?.(error instanceof Error ? error : new Error('Failed to connect to ComfyUI progress stream'));
      reject(error instanceof Error ? error : new Error('Failed to connect to ComfyUI progress stream'));
    };
  });

  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      let payload;

      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      const messageType = payload?.type;
      const messageData = payload?.data || {};

      if (messageData.prompt_id && String(messageData.prompt_id) !== String(promptId)) {
        return;
      }

      if (messageType === 'execution_cached') {
        for (const nodeId of messageData.nodes || []) {
          markNodeCompleted(nodeId);
        }

        publishState({
          status: 'running',
          detail: `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: 'Using cached nodes'
        });
        return;
      }

      if (messageType === 'executing') {
        const previousNodeId = currentNodeId;
        const nextNodeId = messageData.node ? normalizeNodeId(messageData.node) : null;

        if (previousNodeId && previousNodeId !== nextNodeId) {
          markNodeCompleted(previousNodeId);
        }

        currentNodeId = nextNodeId;
        currentNodeProgress = 0;

        if (!nextNodeId) {
          if (previousNodeId) {
            markNodeCompleted(previousNodeId);
          }

          publishState({
            status: 'running',
            detail: 'Finalizing outputs',
            currentNodeLabel: 'Execution complete',
            progressPercent: Math.max(getProgressPercent(), 99)
          });
          return;
        }

        if (!isTrackedNode(nextNodeId)) {
          return;
        }

        publishState({
          status: 'running',
          detail: `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: `Running ${getComfyExecutionNodeLabel(workflowJson, nextNodeId)}`
        });
        return;
      }

      if (messageType === 'progress') {
        const maxValue = Number(messageData.max) || 0;
        const currentValue = Number(messageData.value) || 0;
        currentNodeProgress = maxValue > 0 ? currentValue / maxValue : 0;

        publishState({
          status: 'running',
          detail: maxValue > 0 ? `Step ${currentValue}/${maxValue}` : `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: currentNodeId ? `Running ${getComfyExecutionNodeLabel(workflowJson, currentNodeId)}` : 'Processing workflow'
        });
        return;
      }

      if (messageType === 'executed' && messageData.node) {
        const executedNodeId = normalizeNodeId(messageData.node);

        if (!markNodeCompleted(executedNodeId)) {
          return;
        }

        publishState({
          status: 'running',
          detail: `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: `Completed ${getComfyExecutionNodeLabel(workflowJson, executedNodeId)}`
        });
        return;
      }

      if (messageType === 'execution_success') {
        if (currentNodeId) {
          markNodeCompleted(currentNodeId);
        }

        isSettled = true;

        publishState({
          status: 'completed',
          detail: 'ComfyUI execution completed',
          currentNodeLabel: 'Saving generated image',
          progressPercent: 100
        });

        clearTimeout(timer);
        socket.close();
        resolve();
        return;
      }

      // ComfyUI answers an interrupt with this once the running node reaches a
      // step boundary. It is a cancellation, not a failure.
      if (messageType === 'execution_interrupted') {
        isSettled = true;

        publishState({
          status: 'cancelled',
          detail: 'ComfyUI execution cancelled',
          currentNodeLabel: 'Cancelled'
        });

        clearTimeout(timer);
        socket.close();
        reject(new ComfyCancelledError('Workflow cancelled'));
        return;
      }

      if (messageType === 'execution_error') {
        const errorMessage = messageData.exception_message || 'Unknown ComfyUI error';

        isSettled = true;

        publishState({
          status: 'error',
          detail: errorMessage,
          currentNodeLabel: 'ComfyUI execution failed'
        });

        clearTimeout(timer);
        socket.close();
        reject(new Error(errorMessage));
      }
    };

    socket.onclose = () => {
      clearTimeout(timer);

      if (!isSettled && isReady) {
        isSettled = true;
        publishState({
          status: 'error',
          detail: 'ComfyUI progress stream closed unexpectedly',
          currentNodeLabel: 'Connection closed'
        });
        reject(new Error('ComfyUI progress stream closed unexpectedly'));
      }
    };
  });

  // The completion promise can reject before a caller gets to await it (a cancel
  // that lands while the prompt is still being queued). Marking it handled here
  // keeps that from surfacing as an unhandled rejection; awaiting it still
  // rejects for the caller.
  completion.catch(() => {});

  return {
    ready,
    completion,
    // Settle the run as cancelled without waiting for ComfyUI to say anything:
    // a prompt removed from the queue before it started emits no message at all,
    // and an interrupted one only answers at the next node/step boundary.
    cancel: (reason = 'Workflow cancelled') => {
      if (isSettled) {
        return false;
      }

      isSettled = true;
      clearTimeout(timer);
      publishState({
        status: 'cancelled',
        detail: reason,
        currentNodeLabel: 'Cancelled'
      });
      rejectCompletion?.(new ComfyCancelledError(reason));
      // A cancel can land while the progress socket is still connecting: the
      // open event will never arrive once it is closed, so settle `ready` too
      // rather than leaving the caller awaiting it forever.
      rejectReady?.(new ComfyCancelledError(reason));
      if (socket && socket.readyState < WebSocketImpl.CLOSING) {
        socket.close();
      }

      return true;
    },
    close: () => {
      isSettled = true;
      clearTimeout(timer);
      if (socket && socket.readyState < WebSocketImpl.CLOSING) {
        socket.close();
      }
    }
  };
}

// A file (image / video / mesh) parameter the app explicitly bound to "None":
// nothing is uploaded for it and the value stored in the workflow JSON is kept.
// The marker is required rather than an omitted key, so a file parameter left
// unset by mistake (e.g. from an MCP call) still fails loudly.
function isComfyNoneInput(value) {
  return isPlainObject(value) && value.__none === true;
}

function coerceComfyParameterValue(parameter, providedValue) {
  if (providedValue === undefined || isComfyNoneInput(providedValue)) return cloneSerializable(parameter.defaultValue);

  switch (parameter.type) {
    case 'number': {
      const numericValue = Number(providedValue);
      return Number.isFinite(numericValue) ? numericValue : Number(parameter.defaultValue || 0);
    }
    case 'boolean':
      if (typeof providedValue === 'boolean') return providedValue;
      if (typeof providedValue === 'string') return providedValue.toLowerCase() === 'true';
      return Boolean(providedValue);
    case 'json':
      if (typeof providedValue === 'string') {
        return JSON.parse(providedValue);
      }
      return cloneSerializable(providedValue);
    case 'string':
    default:
      return String(providedValue);
  }
}

function applyComfyParametersToWorkflow(workflowJson, parameters = [], values = {}) {
  const nextWorkflow = cloneSerializable(workflowJson);

  for (const parameter of parameters) {
    const node = nextWorkflow?.[parameter.nodeId];

    if (!node?.inputs || !(parameter.inputKey in node.inputs)) {
      throw new Error(`Workflow parameter ${parameter.label || parameter.id} is no longer valid`);
    }

    node.inputs[parameter.inputKey] = coerceComfyParameterValue(parameter, values[parameter.id]);
  }

  return nextWorkflow;
}

async function sleep(ms) {
  return await new Promise(resolve => setTimeout(resolve, ms));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function queueComfyPrompt(baseUrl, workflowJson, identifiers = {}) {
  const clientId = String(identifiers?.clientId || '').trim() || randomUUID();
  const promptId = String(identifiers?.promptId || '').trim() || randomUUID();

  // ComfyUI rejects a non-UUID prompt_id. The id is not rewritten here because the client
  // subscribes to progress under the id it sent, so substituting one would strand that listener.
  if (!UUID_PATTERN.test(promptId)) {
    console.warn(`Client supplied a non-UUID promptId (${promptId}); ComfyUI will likely reject it.`);
  }

  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: workflowJson,
      client_id: clientId,
      prompt_id: promptId
    })
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(responseBody?.error?.message || responseBody?.error || 'Failed to queue ComfyUI workflow');
  }

  return {
    clientId,
    promptId: responseBody?.prompt_id || promptId
  };
}

// `isCancelled` is polled between attempts so a cancel during the finalize
// phase stops here instead of holding the run open for the full timeout.
async function waitForComfyHistory(baseUrl, promptId, maxAttempts = 180, { isCancelled = null } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isCancelled?.()) {
      throw new ComfyCancelledError('Workflow cancelled');
    }

    const response = await fetch(`${baseUrl}/history/${promptId}`);
    const history = await response.json().catch(() => ({}));
    const promptHistory = history?.[promptId];

    if (response.ok && promptHistory?.outputs && Object.keys(promptHistory.outputs).length > 0) {
      return promptHistory;
    }

    await sleep(1000);
  }

  throw new Error('ComfyUI workflow timed out before producing outputs');
}

function getComfyHistoryImages(historyRecord, selectedOutputs = []) {
  const preferredNodeIds = selectedOutputs.map(output => String(output.nodeId || output.id));
  const orderedNodeIds = preferredNodeIds.length > 0
    ? preferredNodeIds.filter(nodeId => historyRecord?.outputs?.[nodeId])
    : Object.keys(historyRecord?.outputs || {});

  const images = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    if (!nodeOutput?.images?.length) continue;

    for (const image of nodeOutput.images) {
      images.push({ nodeId, ...image });
    }
  }

  return images;
}

async function downloadComfyImage(baseUrl, image) {
  const viewUrl = new URL(`${baseUrl}/view`);
  viewUrl.searchParams.set('filename', image.filename);
  viewUrl.searchParams.set('subfolder', image.subfolder || '');
  viewUrl.searchParams.set('type', image.type || 'output');

  const response = await fetch(viewUrl);
  if (!response.ok) {
    throw new Error('Failed to download ComfyUI output image');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'image/png';

  return {
    buffer,
    contentType
  };
}

async function uploadComfyInputFile(baseUrl, file) {
  const formData = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });

  formData.append('image', blob, file.originalname);
  formData.append('overwrite', 'true');

  const response = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(responseBody?.error || 'Failed to upload reference file to ComfyUI');
  }

  return responseBody?.name || file.originalname;
}

function mergeDeep(defaultValue, currentValue) {
  if (Array.isArray(defaultValue)) {
    return Array.isArray(currentValue) ? currentValue : defaultValue;
  }

  if (!isPlainObject(defaultValue)) {
    return currentValue === undefined ? defaultValue : currentValue;
  }

  const result = { ...defaultValue };

  if (!isPlainObject(currentValue)) {
    return result;
  }

  for (const [key, value] of Object.entries(currentValue)) {
    result[key] = key in defaultValue ? mergeDeep(defaultValue[key], value) : value;
  }

  return result;
}

function replacePromptPlaceholder(value, prompt) {
  if (Array.isArray(value)) {
    return value.map(item => replacePromptPlaceholder(item, prompt));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, replacePromptPlaceholder(nestedValue, prompt)])
    );
  }

  if (typeof value === 'string') {
    return value.replaceAll('{prompt}', prompt);
  }

  return value;
}

function replaceTemplatePlaceholders(value, replacements) {
  if (Array.isArray(value)) {
    return value.map(item => replaceTemplatePlaceholders(item, replacements));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, replaceTemplatePlaceholders(nestedValue, replacements)])
    );
  }

  if (typeof value === 'string') {
    return Object.entries(replacements).reduce(
      (result, [placeholder, replacement]) => result.replaceAll(`{${placeholder}}`, replacement),
      value
    );
  }

  return value;
}

function parseJsonTemplate(value, label, fallback = {}) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (isPlainObject(value) || Array.isArray(value)) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function getCustomApiConfig(settings, selectedApi, expectedType = null) {
  const customApiId = String(selectedApi || '').startsWith('custom_')
    ? String(selectedApi).slice(7)
    : '';
  const customApi = (settings?.apis?.custom || []).find(api => String(api?.id) === customApiId);

  if (!customApi) {
    throw new Error('Selected custom API was not found in settings');
  }

  const normalizedType = ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit', 'mesh-texturing', 'mesh-rigging'].includes(customApi?.type)
    ? customApi.type
    : 'image-generation';

  if (expectedType && normalizedType !== expectedType) {
    throw new Error(`Selected custom API must be of type ${expectedType}`);
  }

  return {
    ...customApi,
    type: normalizedType
  };
}

function isTencentMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === TENCENT_MESH_GENERATION_API_ID;
}

function getTencentCloudConfig(settings = {}) {
  const providerSettings = settings?.apis?.tencentcloud || {};

  return {
    secretId: String(providerSettings.secretId || '').trim(),
    secretKey: String(providerSettings.secretKey || '').trim(),
    meshGeneration: {
      models: {
        meshgeneration: {
          name: providerSettings?.meshGeneration?.models?.meshgeneration?.name || 'Hunyuan3D Pro',
          model: providerSettings?.meshGeneration?.models?.meshgeneration?.model || 'meshgeneration'
        }
      }
    }
  };
}

function isTripoMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === TRIPO_MESH_GENERATION_API_ID;
}

function getTripoAiConfig(settings = {}) {
  const providerSettings = settings?.apis?.tripoai || {};

  return {
    apiKey: String(providerSettings.apiKey || '').trim(),
    meshGeneration: {
      models: {
        meshgeneration: {
          name: providerSettings?.meshGeneration?.models?.meshgeneration?.name || 'Tripo AI',
          model: providerSettings?.meshGeneration?.models?.meshgeneration?.model || 'meshgeneration'
        }
      }
    }
  };
}

function normalizeTripoBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === 'true') return true;
    if (normalizedValue === 'false') return false;
  }

  return Boolean(value);
}

function normalizeTripoNullableInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.round(numericValue) : fallback;
}

function normalizeTripoMeshGenerationInput({
  prompt,
  hasImageSource = false,
  modelVersion,
  modelSeed,
  enableImageAutofix,
  faceLimit,
  texture,
  pbr,
  textureSeed,
  textureAlignment,
  textureQuality,
  autoSize,
  orientation,
  quad,
  smartLowPoly,
  generateParts,
  exportUv,
  geometryQuality
} = {}) {
  const trimmedPrompt = String(prompt || '').trim();
  const hasPrompt = Boolean(trimmedPrompt);

  const normalizedModelVersion = TRIPO_MODEL_VERSIONS.has(String(modelVersion || '').trim())
    ? String(modelVersion || '').trim()
    : 'v2.5-20250123';
  const normalizedModelSeed = normalizeTripoNullableInteger(modelSeed, null);
  const normalizedEnableImageAutofix = normalizeTripoBoolean(enableImageAutofix, false);
  const normalizedFaceLimit = normalizeTripoNullableInteger(faceLimit, null);
  const normalizedTexture = normalizeTripoBoolean(texture, true);
  const normalizedPbr = normalizeTripoBoolean(pbr, true);
  const normalizedTextureSeed = normalizeTripoNullableInteger(textureSeed, null);
  const normalizedTextureAlignment = TRIPO_TEXTURE_ALIGNMENT_OPTIONS.has(String(textureAlignment || '').trim())
    ? String(textureAlignment || '').trim()
    : 'original_image';
  const normalizedTextureQuality = TRIPO_TEXTURE_QUALITY_OPTIONS.has(String(textureQuality || '').trim())
    ? String(textureQuality || '').trim()
    : 'standard';
  const normalizedAutoSize = normalizeTripoBoolean(autoSize, false);
  const normalizedOrientation = TRIPO_ORIENTATION_OPTIONS.has(String(orientation || '').trim())
    ? String(orientation || '').trim()
    : 'default';
  const normalizedQuad = normalizeTripoBoolean(quad, false);
  const normalizedSmartLowPoly = normalizeTripoBoolean(smartLowPoly, false);
  const normalizedGenerateParts = normalizeTripoBoolean(generateParts, false);
  const normalizedExportUv = normalizeTripoBoolean(exportUv, true);
  const normalizedGeometryQuality = TRIPO_GEOMETRY_QUALITY_OPTIONS.has(String(geometryQuality || '').trim())
    ? String(geometryQuality || '').trim()
    : 'standard';
  const isP1Model = normalizedModelVersion === 'P1-20260311';
  const effectiveEnableImageAutofix = isP1Model ? false : normalizedEnableImageAutofix;
  const effectiveTextureAlignment = isP1Model ? 'original_image' : normalizedTextureAlignment;
  const effectiveOrientation = isP1Model ? 'default' : normalizedOrientation;
  const effectiveQuad = isP1Model ? false : normalizedQuad;
  const effectiveSmartLowPoly = isP1Model ? false : normalizedSmartLowPoly;
  const effectiveGenerateParts = isP1Model ? false : normalizedGenerateParts;
  const effectiveGeometryQuality = isP1Model ? 'standard' : normalizedGeometryQuality;

  if (hasPrompt === hasImageSource) {
    throw new Error('Provide either a prompt or an image input for Tripo AI mesh generation');
  }

  if (normalizedFaceLimit !== null && normalizedFaceLimit < 1000) {
    throw new Error('Tripo AI face_limit must be at least 1000 when provided');
  }

  if (effectiveGenerateParts && (normalizedTexture || normalizedPbr || effectiveQuad)) {
    throw new Error('Tripo AI generate_parts is not compatible with texture=true, pbr=true, or quad=true');
  }

  const supportsGeometryQuality = normalizedModelVersion === 'v3.0-20250812'
    || normalizedModelVersion === 'v3.1-20260211';

  return {
    trimmedPrompt,
    hasPrompt,
    hasImageSource,
    normalizedModelVersion,
    normalizedModelSeed,
    normalizedEnableImageAutofix: effectiveEnableImageAutofix,
    normalizedFaceLimit,
    normalizedTexture,
    normalizedPbr,
    normalizedTextureSeed,
    normalizedTextureAlignment: effectiveTextureAlignment,
    normalizedTextureQuality,
    normalizedAutoSize,
    normalizedOrientation: effectiveOrientation,
    normalizedQuad: effectiveQuad,
    normalizedSmartLowPoly: effectiveSmartLowPoly,
    normalizedGenerateParts: effectiveGenerateParts,
    normalizedExportUv,
    normalizedGeometryQuality: effectiveGeometryQuality,
    supportsGeometryQuality,
    isP1Model
  };
}

async function uploadTripoImageAndGetToken(apiKey, imageBuffer, inputFilePath = '') {
  if (!apiKey) {
    throw new Error('Tripo AI API Key is required');
  }

  if (!imageBuffer) {
    throw new Error('Tripo AI image upload requires an input image');
  }

  const extension = path.extname(String(inputFilePath || '')).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  const uploadFilename = path.basename(inputFilePath || `input${extension || '.png'}`);
  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer], { type: mimeType }), uploadFilename);

  console.log('[TripoAI][UploadFile] request payload:', JSON.stringify({
    filename: uploadFilename,
    mimeType,
    sizeBytes: imageBuffer.length
  }, null, 2));

  const response = await fetch(`${TRIPO_API_BASE_URL}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  const responseBody = await response.json().catch(() => ({}));
  console.log('[TripoAI][UploadFile] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 0) {
    throw new Error(responseBody?.message || responseBody?.msg || 'Failed to upload source image to Tripo AI');
  }

  const fileToken = String(responseBody?.data?.file_token || '').trim();

  if (!fileToken) {
    throw new Error('Tripo AI image upload succeeded but file_token was missing');
  }

  return fileToken;
}

async function submitTripoMeshGenerationTask(settings, {
  prompt = '',
  imageBuffer = null,
  inputFilePath = '',
  modelVersion,
  modelSeed,
  enableImageAutofix,
  faceLimit,
  texture,
  pbr,
  textureSeed,
  textureAlignment,
  textureQuality,
  autoSize,
  orientation,
  quad,
  smartLowPoly,
  generateParts,
  exportUv,
  geometryQuality
} = {}) {
  const providerConfig = getTripoAiConfig(settings);
  if (!providerConfig.apiKey) {
    throw new Error('Tripo AI API Key is required');
  }

  const validatedInput = normalizeTripoMeshGenerationInput({
    prompt,
    hasImageSource: Boolean(imageBuffer),
    modelVersion,
    modelSeed,
    enableImageAutofix,
    faceLimit,
    texture,
    pbr,
    textureSeed,
    textureAlignment,
    textureQuality,
    autoSize,
    orientation,
    quad,
    smartLowPoly,
    generateParts,
    exportUv,
    geometryQuality
  });

  let fileToken = null;
  if (validatedInput.hasImageSource) {
    fileToken = await uploadTripoImageAndGetToken(providerConfig.apiKey, imageBuffer, inputFilePath);
  }

  const taskPayload = {
    type: validatedInput.hasImageSource ? 'image_to_model' : 'text_to_model',
    model_version: validatedInput.normalizedModelVersion,
    texture: validatedInput.normalizedTexture,
    pbr: validatedInput.normalizedPbr,
    texture_quality: validatedInput.normalizedTextureQuality,
    auto_size: validatedInput.normalizedAutoSize,
    export_uv: validatedInput.normalizedExportUv
  };

  if (!validatedInput.isP1Model) {
    taskPayload.enable_image_autofix = validatedInput.normalizedEnableImageAutofix;
    taskPayload.texture_alignment = validatedInput.normalizedTextureAlignment;
    taskPayload.orientation = validatedInput.normalizedOrientation;
    taskPayload.quad = validatedInput.normalizedQuad;
    taskPayload.smart_low_poly = validatedInput.normalizedSmartLowPoly;
    taskPayload.generate_parts = validatedInput.normalizedGenerateParts;
  }

  if (validatedInput.hasImageSource) {
    taskPayload.file = {
      type: path.extname(String(inputFilePath || '')).toLowerCase().includes('jpg') ? 'jpg' : 'png',
      file_token: fileToken
    };
  } else {
    taskPayload.prompt = validatedInput.trimmedPrompt;
  }

  if (validatedInput.normalizedModelSeed !== null) taskPayload.model_seed = validatedInput.normalizedModelSeed;
  if (validatedInput.normalizedFaceLimit !== null) taskPayload.face_limit = validatedInput.normalizedFaceLimit;
  if (validatedInput.normalizedTextureSeed !== null) taskPayload.texture_seed = validatedInput.normalizedTextureSeed;
  if (!validatedInput.isP1Model && validatedInput.supportsGeometryQuality) {
    taskPayload.geometry_quality = validatedInput.normalizedGeometryQuality;
  }

  // v3 routes text vs image generation to separate endpoints (v2 used a single
  // /task endpoint discriminated by the `type` field).
  const submitEndpoint = validatedInput.hasImageSource
    ? `${TRIPO_API_BASE_URL}/generation/image-to-model`
    : `${TRIPO_API_BASE_URL}/generation/text-to-model`;

  console.log('[TripoAI][SubmitTask] request payload:', JSON.stringify(createTripoDebugPayload(taskPayload), null, 2));

  const response = await fetch(submitEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(taskPayload)
  });

  const responseBody = await response.json().catch(() => ({}));
  console.log('[TripoAI][SubmitTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 0) {
    throw new Error(responseBody?.message || responseBody?.msg || 'Tripo AI task submission failed');
  }

  const taskId = String(responseBody?.data?.task_id || '').trim();
  if (!taskId) {
    console.error('[TripoAI][SubmitTask] missing task_id in response payload:', JSON.stringify(responseBody || {}, null, 2));
    throw new Error('Tripo AI task submission succeeded but task_id was missing');
  }

  return {
    taskId,
    fileToken,
    requestPayload: taskPayload,
    validatedInput
  };
}

async function queryTripoMeshGenerationTask(settings, { taskId } = {}) {
  const providerConfig = getTripoAiConfig(settings);
  if (!providerConfig.apiKey) {
    throw new Error('Tripo AI API Key is required');
  }

  console.log('[TripoAI][QueryTask] request payload:', JSON.stringify({
    taskId: String(taskId || '').trim()
  }, null, 2));

  const response = await fetch(`${TRIPO_API_BASE_URL}/tasks/${encodeURIComponent(String(taskId || '').trim())}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${providerConfig.apiKey}`
    }
  });

  const responseBody = await response.json().catch(() => ({}));
  console.log('[TripoAI][QueryTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 0) {
    throw new Error(responseBody?.message || responseBody?.msg || 'Failed to query Tripo AI task status');
  }

  const taskData = responseBody?.data || {};
  const status = String(taskData.status || '').trim().toLowerCase() || 'unknown';

  const normalizedTaskResult = {
    taskId: String(taskData.task_id || taskId || '').trim(),
    status,
    progress: Number(taskData.progress),
    errorMessage: String(taskData.error_message || '').trim(),
    output: isPlainObject(taskData.output) ? taskData.output : {}
  };

  console.log('[TripoAI][QueryTask] parsed result:', JSON.stringify(normalizedTaskResult, null, 2));

  return normalizedTaskResult;
}

async function downloadTripoMeshResult(output = {}) {
  // v3 returns a single `model_url`; the older v2 fields are kept as fallbacks.
  const modelUrlV3 = String(output?.model_url || '').trim();
  const pbrModelUrl = String(output?.pbr_model || '').trim();
  const modelUrl = String(output?.model || '').trim();
  const baseModelUrl = String(output?.base_model || '').trim();
  const selectedUrl = modelUrlV3 || pbrModelUrl || modelUrl || baseModelUrl;

  if (!selectedUrl) {
    throw new Error('Tripo AI task succeeded but no model URL was returned');
  }

  const response = await fetch(selectedUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Tripo AI mesh result (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(getFilenameFromUrl(selectedUrl, '')).replace('.', '') || getExtensionFromContentType(contentType, 'glb');
  const filename = getFilenameFromUrl(selectedUrl, `generated_mesh.${extension}`);

  return {
    url: selectedUrl,
    contentType,
    extension,
    filename,
    buffer,
    isPbr: Boolean(pbrModelUrl),
    // Cover render Tripo returns alongside the model — used as the mesh thumbnail
    // for headless generation (rendered_image_url on v3; rendered_image on v2).
    previewImageUrl: String(output?.rendered_image_url || output?.rendered_image || '').trim() || null
  };
}

function isHitemMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === HITEM_MESH_GENERATION_API_ID;
}

function getHitem3dConfig(settings = {}) {
  const providerSettings = settings?.apis?.hitem3d || {};

  return {
    accessKey: String(providerSettings.accessKey || '').trim(),
    secretKey: String(providerSettings.secretKey || '').trim(),
    accessToken: String(providerSettings.accessToken || '').trim()
  };
}

// Requests a fresh Hitem3D access token from the Access/Secret key pair and
// persists it back onto the settings so subsequent calls can reuse it. The
// docs do not mention an expiry, so we cache it and only re-request on demand
// (e.g. when a request returns an authentication error).
async function requestHitem3dAccessToken(providerConfig) {
  if (!providerConfig.accessKey || !providerConfig.secretKey) {
    throw new Error('Hitem3D Access Key and Secret Key are required');
  }

  const authValue = Buffer.from(`${providerConfig.accessKey}:${providerConfig.secretKey}`).toString('base64');

  const response = await fetch(`${HITEM_API_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authValue}`,
      'Content-Type': 'application/json'
    }
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok || Number(responseBody?.code) !== 200) {
    throw new Error(responseBody?.msg || responseBody?.message || 'Failed to obtain Hitem3D access token');
  }

  const accessToken = String(responseBody?.data?.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('Hitem3D authentication succeeded but no access token was returned');
  }

  return accessToken;
}

// Returns a usable Hitem3D access token, persisting a freshly minted one back
// onto the settings record. Pass `forceRefresh` to bypass the cached token
// (used when a downstream request rejects the cached token as unauthorized).
async function getHitem3dAccessToken(settings, { forceRefresh = false } = {}) {
  const providerConfig = getHitem3dConfig(settings);

  if (!forceRefresh && providerConfig.accessToken) {
    return providerConfig.accessToken;
  }

  const accessToken = await requestHitem3dAccessToken(providerConfig);

  try {
    const latestSettings = await getSettings();
    await saveSettings({
      ...latestSettings,
      apis: {
        ...latestSettings?.apis,
        hitem3d: {
          ...latestSettings?.apis?.hitem3d,
          accessToken
        }
      }
    });
  } catch (persistErr) {
    console.warn('Failed to persist Hitem3D access token:', persistErr.message);
  }

  return accessToken;
}

// Detects whether a Hitem3D response indicates the access token is bad/expired,
// so the caller can mint a fresh token and retry. Hitem wraps most responses in
// HTTP 200 with a body `code`/`msg`, so besides HTTP 401/403 and body code
// 401/403 we also match token/auth-related messages (e.g. "invalid token",
// "token expired", "unauthorized").
function isHitemAuthError(response, responseBody) {
  const code = Number(responseBody?.code);
  if (response?.status === 401 || response?.status === 403 || code === 401 || code === 403) {
    return true;
  }

  const message = String(responseBody?.msg || responseBody?.message || '').toLowerCase();
  if (!message) {
    return false;
  }

  return message.includes('token')
    || message.includes('unauthorized')
    || message.includes('unauthenticated')
    || message.includes('invalid credential')
    || message.includes('expired');
}

function normalizeHitemMeshGenerationInput({
  hasImageSource = false,
  model,
  resolution,
  requestType,
  face,
  pbr
} = {}) {
  const normalizedModel = HITEM_MODEL_VERSIONS.has(String(model || '').trim())
    ? String(model || '').trim()
    : 'hitem3dv2.1';

  const allowedResolutions = HITEM_RESOLUTIONS_BY_MODEL[normalizedModel] || HITEM_RESOLUTIONS_BY_MODEL['hitem3dv2.1'];
  const requestedResolution = String(resolution || '').trim();
  const normalizedResolution = allowedResolutions.has(requestedResolution)
    ? requestedResolution
    : (normalizedModel === 'hitem3dv2.1' ? '1536pro' : '1024');

  const requestedType = Number(requestType);
  const normalizedRequestType = HITEM_REQUEST_TYPES.has(requestedType) ? requestedType : 3;

  const requestedFace = Number(face);
  const normalizedFace = Number.isFinite(requestedFace)
    ? Math.max(HITEM_FACE_MIN, Math.min(HITEM_FACE_MAX, Math.round(requestedFace)))
    : 300000;

  const normalizedPbr = normalizeTripoBoolean(pbr, false) ? 1 : 0;

  if (!hasImageSource) {
    throw new Error('Hitem3D requires an image input for mesh generation');
  }

  return {
    normalizedModel,
    normalizedResolution,
    normalizedRequestType,
    normalizedFace,
    normalizedPbr
  };
}

async function submitHitemMeshGenerationTask(settings, {
  imageBuffer = null,
  inputFilePath = '',
  model,
  resolution,
  requestType,
  face,
  pbr
} = {}) {
  const providerConfig = getHitem3dConfig(settings);
  if (!providerConfig.accessKey || !providerConfig.secretKey) {
    throw new Error('Hitem3D Access Key and Secret Key are required');
  }

  const validatedInput = normalizeHitemMeshGenerationInput({
    hasImageSource: Boolean(imageBuffer),
    model,
    resolution,
    requestType,
    face,
    pbr
  });

  const extension = path.extname(String(inputFilePath || '')).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  const uploadFilename = path.basename(inputFilePath || `input${extension || '.png'}`);

  const buildFormData = () => {
    const formData = new FormData();
    formData.append('request_type', String(validatedInput.normalizedRequestType));
    formData.append('model', validatedInput.normalizedModel);
    formData.append('resolution', validatedInput.normalizedResolution);
    formData.append('pbr', String(validatedInput.normalizedPbr));
    formData.append('face', String(validatedInput.normalizedFace));
    formData.append('format', String(HITEM_FORMAT_GLB));
    formData.append('images', new Blob([imageBuffer], { type: mimeType }), uploadFilename);
    return formData;
  };

  console.log('[Hitem3D][SubmitTask] request payload:', JSON.stringify({
    model: validatedInput.normalizedModel,
    resolution: validatedInput.normalizedResolution,
    request_type: validatedInput.normalizedRequestType,
    pbr: validatedInput.normalizedPbr,
    face: validatedInput.normalizedFace,
    format: HITEM_FORMAT_GLB,
    filename: uploadFilename
  }, null, 2));

  const performSubmit = async (accessToken) => {
    const response = await fetch(`${HITEM_API_BASE_URL}/submit-task`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: buildFormData()
    });
    const responseBody = await response.json().catch(() => ({}));
    return { response, responseBody };
  };

  let accessToken = await getHitem3dAccessToken(settings);
  let { response, responseBody } = await performSubmit(accessToken);

  // The cached token may have expired; refresh once and retry on auth errors.
  if (isHitemAuthError(response, responseBody)) {
    accessToken = await getHitem3dAccessToken(settings, { forceRefresh: true });
    ({ response, responseBody } = await performSubmit(accessToken));
  }

  console.log('[Hitem3D][SubmitTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 200) {
    throw new Error(responseBody?.msg || responseBody?.message || 'Hitem3D task submission failed');
  }

  const taskId = String(responseBody?.data?.task_id || '').trim();
  if (!taskId) {
    console.error('[Hitem3D][SubmitTask] missing task_id in response payload:', JSON.stringify(responseBody || {}, null, 2));
    throw new Error('Hitem3D task submission succeeded but task_id was missing');
  }

  return {
    taskId,
    validatedInput
  };
}

async function queryHitemMeshGenerationTask(settings, { taskId } = {}) {
  const providerConfig = getHitem3dConfig(settings);
  if (!providerConfig.accessKey || !providerConfig.secretKey) {
    throw new Error('Hitem3D Access Key and Secret Key are required');
  }

  const trimmedTaskId = String(taskId || '').trim();

  console.log('[Hitem3D][QueryTask] request payload:', JSON.stringify({ taskId: trimmedTaskId }, null, 2));

  const performQuery = async (accessToken) => {
    const response = await fetch(`${HITEM_API_BASE_URL}/query-task?task_id=${encodeURIComponent(trimmedTaskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const responseBody = await response.json().catch(() => ({}));
    return { response, responseBody };
  };

  let accessToken = await getHitem3dAccessToken(settings);
  let { response, responseBody } = await performQuery(accessToken);

  if (isHitemAuthError(response, responseBody)) {
    accessToken = await getHitem3dAccessToken(settings, { forceRefresh: true });
    ({ response, responseBody } = await performQuery(accessToken));
  }

  console.log('[Hitem3D][QueryTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 200) {
    throw new Error(responseBody?.msg || responseBody?.message || 'Failed to query Hitem3D task status');
  }

  const taskData = responseBody?.data || {};
  const status = String(taskData.state || '').trim().toLowerCase() || 'unknown';

  const normalizedTaskResult = {
    taskId: String(taskData.task_id || trimmedTaskId || '').trim(),
    status,
    url: String(taskData.url || '').trim(),
    coverUrl: String(taskData.cover_url || '').trim()
  };

  console.log('[Hitem3D][QueryTask] parsed result:', JSON.stringify(normalizedTaskResult, null, 2));

  return normalizedTaskResult;
}

async function downloadHitemMeshResult(taskResult = {}) {
  const selectedUrl = String(taskResult?.url || '').trim();

  if (!selectedUrl) {
    throw new Error('Hitem3D task succeeded but no model URL was returned');
  }

  const response = await fetch(selectedUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Hitem3D mesh result (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(getFilenameFromUrl(selectedUrl, '')).replace('.', '') || getExtensionFromContentType(contentType, 'glb');
  const filename = getFilenameFromUrl(selectedUrl, `generated_mesh.${extension}`);

  return {
    url: selectedUrl,
    contentType,
    extension,
    filename,
    buffer,
    previewImageUrl: String(taskResult?.coverUrl || '').trim() || null
  };
}

function normalizeTencentBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === 'true') return true;
    if (normalizedValue === 'false') return false;
  }

  return Boolean(value);
}

function normalizeTencentFaceCount(value, fallback = 500000) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.round(numericValue) : fallback;
}

function normalizeTencentMeshGenerationInput({
  prompt,
  hasImageSource = false,
  region,
  modelVersion,
  enablePBR,
  faceCount,
  generationType,
  polygonType
} = {}) {
  const trimmedPrompt = String(prompt || '').trim();
  const hasPrompt = Boolean(trimmedPrompt);
  const regionValue = String(region || '').trim();
  const normalizedRegion = TENCENT_REGIONS.has(regionValue) ? regionValue : null;
  const normalizedModelVersion = TENCENT_MODEL_VERSIONS.has(String(modelVersion || '').trim())
    ? String(modelVersion || '').trim()
    : '3.0';
  const normalizedGenerationType = TENCENT_GENERATION_TYPES.has(String(generationType || '').trim())
    ? String(generationType || '').trim()
    : 'Normal';
  const normalizedPolygonType = TENCENT_POLYGON_TYPES.has(String(polygonType || '').trim())
    ? String(polygonType || '').trim()
    : 'triangle';
  const normalizedFaceCount = normalizeTencentFaceCount(faceCount);
  const normalizedEnablePBR = normalizeTencentBoolean(enablePBR, false);

  if (!normalizedRegion) {
    throw new Error('Tencent Cloud region must be ap-singapore, eu-frankfurt, or na-siliconvalley');
  }

  if (hasPrompt === hasImageSource) {
    throw new Error('Provide either a prompt or an image input for Tencent Cloud mesh generation');
  }

  if (normalizedFaceCount < 3000 || normalizedFaceCount > 1500000) {
    throw new Error('Tencent Cloud FaceCount must be between 3000 and 1500000');
  }

  if (normalizedGenerationType === 'LowPoly' && normalizedModelVersion !== '3.0') {
    throw new Error('Tencent Cloud LowPoly generation is only available with model 3.0');
  }

  return {
    trimmedPrompt,
    normalizedRegion,
    normalizedModelVersion,
    normalizedEnablePBR,
    normalizedFaceCount,
    normalizedGenerationType,
    normalizedPolygonType,
    hasPrompt,
    hasImageSource
  };
}

function createTencentCloudClient({ secretId, secretKey, region }) {
  if (!secretId || !secretKey) {
    throw new Error('Tencent Cloud Secret Id and Secret Key are required');
  }

  const tencentcloud = tencentcloudSdk?.default || tencentcloudSdk;
  const { Credential, ClientProfile, HttpProfile, CommonClient } = tencentcloud.common;
  const HunyuanClient = tencentcloud?.hunyuan?.v20230901?.Client;
  const credential = new Credential(secretId, secretKey);
  const httpProfile = new HttpProfile();
  httpProfile.endpoint = TENCENT_HUNYUAN_ENDPOINT;
  const clientProfile = new ClientProfile();
  clientProfile.httpProfile = httpProfile;
  // Large payload requests (for example ImageBase64) must use the TC3 signature flow.
  clientProfile.signMethod = 'TC3-HMAC-SHA256';

  if (typeof HunyuanClient === 'function') {
    return new HunyuanClient(credential, region, clientProfile);
  }

  return new CommonClient(TENCENT_HUNYUAN_ENDPOINT, TENCENT_HUNYUAN_VERSION, credential, region, clientProfile);
}

async function requestTencentCloud(client, action, params) {
  return await new Promise((resolve, reject) => {
    if (typeof client?.[action] === 'function') {
      client[action](params, (err, response) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(response || {});
      });
      return;
    }

    client.request(action, params, (err, response) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(response || {});
    });
  });
}

function createTencentDebugPayload(params = {}) {
  const safePayload = { ...params };

  if (typeof safePayload.ImageBase64 === 'string') {
    safePayload.ImageBase64 = `[base64:${safePayload.ImageBase64.length} chars redacted]`;
  }

  return safePayload;
}

function createTripoDebugPayload(params = {}) {
  const safePayload = JSON.parse(JSON.stringify(params || {}));

  if (safePayload?.file?.file_token) {
    const token = String(safePayload.file.file_token);
    safePayload.file.file_token = `[token:${token.length} chars redacted]`;
  }

  return safePayload;
}

function getTencentCloudResponsePayload(response) {
  if (response && typeof response === 'object') {
    if (response.Response && typeof response.Response === 'object') {
      return response.Response;
    }

    return response;
  }

  return {};
}

async function submitTencentCloudMeshGenerationJob(settings, {
  region,
  modelVersion = '3.0',
  prompt = '',
  imageBuffer = null,
  enablePBR = false,
  faceCount = 500000,
  generationType = 'Normal',
  polygonType = 'triangle'
} = {}) {
  const providerConfig = getTencentCloudConfig(settings);
  const client = createTencentCloudClient({
    secretId: providerConfig.secretId,
    secretKey: providerConfig.secretKey,
    region
  });
  const params = {
    Model: modelVersion,
    EnablePBR: Boolean(enablePBR),
    FaceCount: faceCount,
    GenerateType: generationType
  };

  if (prompt) {
    params.Prompt = prompt;
  }

  if (imageBuffer) {
    params.ImageBase64 = imageBuffer.toString('base64');
  }

  if (generationType === 'LowPoly') {
    params.PolygonType = polygonType;
  }

  console.log('[TencentCloud][SubmitHunyuanTo3DProJob] request params:', JSON.stringify(createTencentDebugPayload(params), null, 2));

  const response = await requestTencentCloud(client, 'SubmitHunyuanTo3DProJob', params);
  console.log('[TencentCloud][SubmitHunyuanTo3DProJob] raw response:', JSON.stringify(response || {}, null, 2));
  const payload = getTencentCloudResponsePayload(response);

  if (!payload.JobId) {
    console.error('[TencentCloud][SubmitHunyuanTo3DProJob] missing JobId in payload:', JSON.stringify(payload, null, 2));
    throw new Error(payload.ErrorMessage || 'Tencent Cloud mesh generation did not return a job id');
  }

  return {
    jobId: String(payload.JobId),
    requestId: payload.RequestId || null
  };
}

async function queryTencentCloudMeshGenerationJob(settings, { region, jobId } = {}) {
  const providerConfig = getTencentCloudConfig(settings);
  const client = createTencentCloudClient({
    secretId: providerConfig.secretId,
    secretKey: providerConfig.secretKey,
    region
  });
  const response = await requestTencentCloud(client, 'QueryHunyuanTo3DProJob', {
    JobId: String(jobId || '').trim()
  });
  const payload = getTencentCloudResponsePayload(response);

  return {
    requestId: payload.RequestId || null,
    status: String(payload.Status || '').trim() || 'WAIT',
    errorCode: String(payload.ErrorCode || '').trim(),
    errorMessage: String(payload.ErrorMessage || '').trim(),
    resultFiles: Array.isArray(payload.ResultFile3Ds) ? payload.ResultFile3Ds : []
  };
}

function selectTencentPreferredResultFile(resultFiles = []) {
  const normalizedFiles = Array.isArray(resultFiles) ? resultFiles.filter(Boolean) : [];
  if (normalizedFiles.length === 0) {
    return null;
  }

  const glbFile = normalizedFiles.find((entry) => String(entry?.Type || '').toUpperCase() === 'GLB');
  if (glbFile?.Url) {
    return glbFile;
  }

  const objFile = normalizedFiles.find((entry) => String(entry?.Type || '').toUpperCase() === 'OBJ');
  if (objFile?.Url) {
    return objFile;
  }

  const firstFileWithUrl = normalizedFiles.find((entry) => entry?.Url);
  return firstFileWithUrl || normalizedFiles[0];
}

async function downloadTencentCloudResultFiles(resultFiles = []) {
  const resultFile = selectTencentPreferredResultFile(resultFiles);
  if (!resultFile?.Url) {
    return [];
  }

  const response = await fetch(resultFile.Url);
  if (!response.ok) {
    throw new Error(`Failed to download Tencent Cloud mesh result (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(getFilenameFromUrl(resultFile.Url, '')).replace('.', '') || getExtensionFromContentType(contentType, 'glb');
  const filename = getFilenameFromUrl(resultFile.Url, `generated_mesh.${extension}`);

  return [{
    buffer,
    contentType,
    filename,
    previewImageUrl: resultFile.PreviewImageUrl || '',
    resultType: resultFile.Type || ''
  }];
}

// Download a provider's cover/preview render and store it as a mesh thumbnail.
// Mesh thumbnails are normally rendered client-side (WebGL) in the browser;
// headless generation (MCP / external API callers) has no browser, so we fall
// back to the provider's own cover image. Returns the stored thumbnail filename,
// or null on any failure — a missing thumbnail must never fail mesh generation.
async function downloadPreviewThumbnail(previewImageUrl, baseName = 'mesh') {
  const url = String(previewImageUrl || '').trim();
  if (!url) return null;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return null;

    // Returns bytes rather than writing them: whether a thumbnail belongs on
    // this disk or on a shared server is dataStore's decision, not ours.
    return { filename: createLibraryThumbnailFilename(baseName), bytes: buffer };
  } catch (err) {
    console.warn('Failed to download provider preview thumbnail:', err.message);
    return null;
  }
}

// Ask the Electron main process (desktop app only) to start a Python service on
// demand. The backend runs as a separate process with an IPC channel to main
// (electron/main.cjs startBackend); outside the desktop app `process.send` is
// undefined and this is a no-op. Best-effort: resolves true when the service is
// confirmed running, false otherwise (timeout / not desktop / start failed).
const pendingServiceEnsures = new Map();
if (typeof process.send === 'function') {
  process.on('message', (msg) => {
    if (!msg || msg.type !== 'services:ensure:result') return;
    const pending = pendingServiceEnsures.get(msg.requestId);
    if (!pending) return;
    pendingServiceEnsures.delete(msg.requestId);
    clearTimeout(pending.timer);
    pending.resolve(Boolean(msg.ok));
  });
}

function ensureDesktopService(name, { timeoutMs = 120000 } = {}) {
  if (typeof process.send !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingServiceEnsures.delete(requestId);
      resolve(false);
    }, timeoutMs);
    pendingServiceEnsures.set(requestId, { resolve, timer });
    try {
      process.send({ type: 'services:ensure', name, requestId });
    } catch {
      pendingServiceEnsures.delete(requestId);
      clearTimeout(timer);
      resolve(false);
    }
  });
}

// Render a mesh thumbnail headlessly via the Python mesh-tools service (:8200),
// which runs a Blender subprocess (see app/routes/meshes.py /meshes/thumbnail).
// Meshes generated without a browser (ComfyUI / external API over MCP) have no
// client-side WebGL thumbnail; this is the fallback when there is no provider
// cover to use. Returns the stored thumbnail filename, or null on any failure —
// the render is best-effort and must never fail mesh generation (e.g. when the
// mesh-tools service is not installed or running).
async function renderMeshThumbnailViaService(buffer, baseName = 'mesh') {
  if (!buffer?.length) return null;

  try {
    // In the desktop app, start the mesh-tools service on demand if it isn't
    // running (best-effort — proceed regardless; a stopped service just yields
    // no thumbnail, as before).
    await ensureDesktopService('meshtools');

    const settings = await getSettings();
    const baseUrl = buildMeshToolsBaseUrl(settings);

    const form = new FormData();
    form.append('meshFile', new Blob([buffer], { type: 'model/gltf-binary' }), 'mesh.glb');

    const response = await fetch(`${baseUrl}/meshes/thumbnail`, { method: 'POST', body: form });
    if (!response.ok) return null;

    const data = await response.json().catch(() => null);
    const pngBuffer = data?.preview_b64 ? Buffer.from(data.preview_b64, 'base64') : null;
    if (!pngBuffer?.length) return null;

    // Bytes, not a path — see downloadPreviewThumbnail above.
    return { filename: createLibraryThumbnailFilename(baseName), bytes: pngBuffer };
  } catch (err) {
    console.warn('Failed to render mesh thumbnail via service:', err.message);
    return null;
  }
}

// Resolve a thumbnail for a generated mesh: prefer the provider's own cover
// render (free, always available for the external APIs), else fall back to a
// headless Blender render (covers ComfyUI meshes, which have no cover).
// Returns { filename, bytes }, or null when neither is available.
async function resolveMeshThumbnail({ buffer, previewImageUrl, baseName = 'mesh' }) {
  const cover = await downloadPreviewThumbnail(previewImageUrl, baseName);
  if (cover) return cover;
  return renderMeshThumbnailViaService(buffer, baseName);
}

async function saveGeneratedMeshAssets({
  projectId,
  name,
  cardId = null,
  provider = 'API',
  prompt = '',
  metadata = {},
  downloadedFiles = [],
  parentAssetId = null
} = {}) {
  const savedAssets = [];
  const normalizedParentAssetId = Number(parentAssetId) || null;

  for (const [index, downloadedFile] of downloadedFiles.entries()) {
    const extension = path.extname(downloadedFile.filename).replace('.', '') || getExtensionFromContentType(downloadedFile.contentType, 'glb');

    const assetPayload = {
      type: 'mesh',
      name: downloadedFiles.length > 1 ? `${name} ${index + 1}` : name,
      metadata: {
        format: extension.toUpperCase(),
        source: provider,
        provider,
        prompt,
        cardId,
        previewImageUrl: downloadedFile.previewImageUrl || null,
        resultType: downloadedFile.resultType || null,
        ...metadata
      },
      createdAt: Date.now() + index
    };

    // Meshes have no client-side thumbnail on the headless generation path, so
    // use the provider's cover render, falling back to a headless Blender render
    // when there is no cover (best-effort).
    const thumbnail = await resolveMeshThumbnail({
      buffer: downloadedFile.buffer,
      previewImageUrl: downloadedFile.previewImageUrl,
      baseName: assetPayload.name
    });

    // dataStore decides where these bytes land: this machine's own database, or
    // the shared server when this install is connected to one.
    const common = {
      ...assetPayload,
      bytes: downloadedFile.buffer,
      extension,
      thumbnailBytes: thumbnail?.bytes || null,
      thumbnailFilename: thumbnail?.filename || null
    };

    // When the mesh was edited from a connected mesh, save it as a version (child)
    // of that mesh instead of creating a new root asset.
    savedAssets.push(normalizedParentAssetId
      ? await saveAssetVersion({ ...common, parentAssetId: normalizedParentAssetId, projectId: Number(projectId) })
      : await saveRootAsset({ ...common, projectId: Number(projectId) }));
  }

  return savedAssets;
}

function getTencentJobRuntimeLabel(jobStatus = 'WAIT') {
  if (jobStatus === 'RUN') {
    return 'Tencent Cloud job is running';
  }

  if (jobStatus === 'WAIT') {
    return 'Tencent Cloud job is queued';
  }

  if (jobStatus === 'DONE') {
    return 'Tencent Cloud job finished';
  }

  return 'Tencent Cloud job failed';
}

function getNestedValue(value, pathExpression = '') {
  return String(pathExpression || '')
    .split('.')
    .filter(Boolean)
    .reduce((currentValue, segment) => currentValue?.[segment], value);
}

function findFirstResponseField(responseBody, paths = []) {
  for (const pathExpression of paths) {
    const value = getNestedValue(responseBody, pathExpression);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return null;
}

function parseDataUri(value = '') {
  const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;

  return {
    mimeType: match[1],
    data: match[2]
  };
}

function getFilenameFromUrl(rawUrl = '', fallback = 'generated_mesh.glb') {
  try {
    const parsedUrl = new URL(String(rawUrl || ''));
    const filename = path.basename(parsedUrl.pathname || '');
    return filename || fallback;
  } catch {
    return fallback;
  }
}

async function extractMeshOutputFromApiResponse(response, responseBody) {
  const contentType = response.headers.get('content-type') || '';

  if (!String(contentType).toLowerCase().includes('application/json')) {
    const extension = getExtensionFromContentType(contentType, 'glb');
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      filename: `generated_mesh.${extension}`,
      contentType
    };
  }

  const base64Value = findFirstResponseField(responseBody, [
    'meshBase64',
    'mesh_base64',
    'base64',
    'data.meshBase64',
    'data.mesh_base64',
    'data.base64',
    'file.base64',
    'output.base64'
  ]);
  const meshUrl = findFirstResponseField(responseBody, [
    'meshUrl',
    'mesh_url',
    'url',
    'fileUrl',
    'downloadUrl',
    'data.meshUrl',
    'data.mesh_url',
    'data.url',
    'file.url',
    'output.url'
  ]);
  const filename = findFirstResponseField(responseBody, [
    'filename',
    'fileName',
    'meshFilename',
    'mesh_filename',
    'data.filename',
    'data.fileName',
    'file.filename',
    'output.filename'
  ]);
  const declaredMimeType = findFirstResponseField(responseBody, [
    'mimeType',
    'contentType',
    'data.mimeType',
    'data.contentType',
    'file.mimeType',
    'output.mimeType'
  ]);

  if (typeof base64Value === 'string' && base64Value.trim()) {
    const parsedDataUri = parseDataUri(base64Value);
    const normalizedBase64 = parsedDataUri?.data || base64Value;
    const mimeType = parsedDataUri?.mimeType || declaredMimeType || 'model/gltf-binary';
    const inferredFilename = filename || `generated_mesh.${getExtensionFromContentType(mimeType, 'glb')}`;

    return {
      buffer: Buffer.from(normalizedBase64, 'base64'),
      filename: inferredFilename,
      contentType: mimeType
    };
  }

  if (typeof meshUrl === 'string' && meshUrl.trim()) {
    const downloadResponse = await fetch(meshUrl);
    if (!downloadResponse.ok) {
      throw new Error('Failed to download generated mesh from custom API response');
    }

    const downloadedContentType = downloadResponse.headers.get('content-type') || declaredMimeType || 'model/gltf-binary';
    return {
      buffer: Buffer.from(await downloadResponse.arrayBuffer()),
      filename: filename || getFilenameFromUrl(meshUrl, `generated_mesh.${getExtensionFromContentType(downloadedContentType, 'glb')}`),
      contentType: downloadedContentType
    };
  }

  throw new Error('Mesh generation API succeeded but no mesh payload was returned');
}

function getComfyHistoryFiles(historyRecord, selectedOutputs = []) {
  const selectedOutputsByNodeId = new Map(selectedOutputs.map(output => [String(output.nodeId || output.id), output]));
  const preferredNodeIds = selectedOutputs.map(output => String(output.nodeId || output.id));
  const orderedNodeIds = preferredNodeIds.length > 0
    ? preferredNodeIds.filter(nodeId => historyRecord?.outputs?.[nodeId])
    : Object.keys(historyRecord?.outputs || {});
  const files = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    const selectedOutput = selectedOutputsByNodeId.get(String(nodeId));
    const expectedType = normalizeComfyValueType(selectedOutput?.valueType, getDefaultComfyValueType(selectedOutput, true));

    // String/text outputs are collected separately by getComfyHistoryTexts.
    if (expectedType === 'string') {
      continue;
    }

    for (const [outputKey, outputValue] of Object.entries(nodeOutput || {})) {
      if (!Array.isArray(outputValue)) {
        continue;
      }

      for (const file of outputValue) {
        let normalizedFile = null;

        if (typeof file === 'string' && file.trim()) {
          normalizedFile = {
            filename: path.basename(file.trim()),
            absolutePath: file.trim()
          };
        } else if (file && typeof file === 'object' && file.filename) {
          normalizedFile = file;
        }

        if (!normalizedFile?.filename) {
          continue;
        }

        const inferredType = inferSupportedAssetTypeFromFilename(normalizedFile.filename);
        const normalizedKey = String(outputKey || '').toLowerCase();

        if (expectedType === 'mesh') {
          if (inferredType && inferredType !== 'mesh') continue;
          if (!inferredType && !normalizedKey.includes('mesh') && normalizedKey !== 'result') continue;
        }

        if (expectedType === 'image') {
          if (inferredType && inferredType !== 'image') continue;
          if (!inferredType && !normalizedKey.includes('image')) continue;
        }

        files.push({
          nodeId,
          outputKey,
          expectedType,
          ...normalizedFile
        });
      }
    }
  }

  return files;
}

function collectComfyOutputStrings(value, collected) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      collected.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectComfyOutputStrings(entry, collected);
    }
    return;
  }

  if (value && typeof value === 'object') {
    // ComfyUI text nodes commonly expose their result under a `text` key.
    if (typeof value.text === 'string') {
      collectComfyOutputStrings(value.text, collected);
      return;
    }
    if (Array.isArray(value.text)) {
      collectComfyOutputStrings(value.text, collected);
      return;
    }
    if (typeof value.string === 'string') {
      collectComfyOutputStrings(value.string, collected);
      return;
    }
  }
}

function getComfyHistoryTexts(historyRecord, selectedOutputs = []) {
  const selectedOutputsByNodeId = new Map(selectedOutputs.map(output => [String(output.nodeId || output.id), output]));
  const preferredNodeIds = selectedOutputs
    .filter(output => normalizeComfyValueType(output?.valueType, getDefaultComfyValueType(output, true)) === 'string')
    .map(output => String(output.nodeId || output.id));
  const orderedNodeIds = preferredNodeIds.filter(nodeId => historyRecord?.outputs?.[nodeId]);
  const texts = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    const selectedOutput = selectedOutputsByNodeId.get(String(nodeId));

    for (const [outputKey, outputValue] of Object.entries(nodeOutput || {})) {
      const collected = [];
      collectComfyOutputStrings(outputValue, collected);

      if (collected.length === 0) {
        continue;
      }

      texts.push({
        nodeId,
        outputKey,
        expectedType: 'string',
        text: collected.join('\n'),
        outputName: selectedOutput?.name || null
      });
    }
  }

  return texts;
}

async function downloadComfyOutputFile(baseUrl, file) {
  if (file.absolutePath && path.isAbsolute(file.absolutePath)) {
    const extension = path.extname(file.filename || file.absolutePath).toLowerCase();
    const contentType = extension === '.glb'
      ? 'model/gltf-binary'
      : extension === '.gltf'
        ? 'model/gltf+json'
        : 'application/octet-stream';

    return {
      buffer: await fs.readFile(file.absolutePath),
      contentType
    };
  }

  const viewUrl = new URL(`${baseUrl}/view`);
  viewUrl.searchParams.set('filename', file.filename);
  viewUrl.searchParams.set('subfolder', file.subfolder || '');
  viewUrl.searchParams.set('type', file.type || 'output');

  const response = await fetch(viewUrl);
  if (!response.ok) {
    throw new Error('Failed to download ComfyUI output file');
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  };
}

function getExtensionFromMimeType(mimeType = 'image/png') {
  const mimeMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp'
  };

  return mimeMap[mimeType] || 'png';
}

function createGeneratedImageName(prompt, extension) {
  const baseName = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${baseName || 'generated_image'}.${extension}`;
}

function inferAssetTypeFromFilename(filename = '') {
  const supportedType = inferSupportedAssetTypeFromFilename(filename);

  if (supportedType) return supportedType;

  return 'image';
}

function inferSupportedAssetTypeFromFilename(filename = '') {
  const extension = path.extname(filename).toLowerCase();

  if (MESH_EXTENSIONS.has(extension)) return 'mesh';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';

  return null;
}

function getExtensionFromContentType(contentType = '', fallback = 'bin') {
  const normalized = String(contentType || '').toLowerCase();

  if (normalized.includes('model/gltf-binary')) return 'glb';
  if (normalized.includes('model/gltf+json')) return 'gltf';
  if (normalized.includes('model/obj') || normalized.includes('application/x-tgif')) return 'obj';
  if (normalized.includes('application/octet-stream')) return fallback;
  if (normalized.includes('application/json')) return 'json';

  return fallback;
}

function createLibraryImportFilename(originalName = 'asset') {
  const extension = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, extension)
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${baseName || 'asset'}-${randomUUID().slice(0, 8)}${extension}`;
}

function createLibraryThumbnailFilename(originalName = 'asset') {
  const baseName = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${baseName || 'asset'}-thumbnail-${randomUUID().slice(0, 8)}.png`;
}

function getMimeTypeFromFilename(filename = '') {
  const extension = path.extname(filename).toLowerCase();

  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.bmp') return 'image/bmp';

  return 'image/png';
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function getImageDimensionsFromBuffer(buffer, { filename = '', mimeType = '' } = {}) {
  if (!buffer || buffer.length < 10) {
    return { width: 0, height: 0 };
  }

  const extension = path.extname(String(filename || '')).toLowerCase();
  const normalizedMimeType = String(mimeType || '').toLowerCase();

  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    };
  }

  if ((extension === '.bmp' || normalizedMimeType === 'image/bmp') && buffer.length >= 26) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22))
    };
  }

  if ((extension === '.webp' || normalizedMimeType === 'image/webp') && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunkType = buffer.toString('ascii', 12, 16);

    if (chunkType === 'VP8X' && buffer.length >= 30) {
      return {
        width: readUInt24LE(buffer, 24) + 1,
        height: readUInt24LE(buffer, 27) + 1
      };
    }

    if (chunkType === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      };
    }

    if (chunkType === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff
      };
    }
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;

    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }

      const segmentLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);

      if (isStartOfFrame && offset + 8 < buffer.length) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5)
        };
      }

      if (!segmentLength || segmentLength < 2) {
        break;
      }

      offset += 2 + segmentLength;
    }
  }

  return { width: 0, height: 0 };
}

function formatImageResolution(width, height) {
  if (!width || !height) {
    return 'Unknown';
  }

  return `${width} x ${height}`;
}

function sanitizeAssetFolderName(value = 'image') {
  return String(value)
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function getImageEditStoredFilePath(sourceAsset, editId, extension) {
  const sourcePath = sourceAsset.filePath || sourceAsset.filename || sourceAsset.name || 'image';
  const sourceName = sanitizeAssetFolderName(path.basename(sourcePath, path.extname(sourcePath))) || 'image';
  return toStoredAssetPath('image', `images/${sourceName}/${editId}/${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`);
}

function getBrushChildStoredFilePath(parentId, extension = 'png') {
  const safeParentFolder = sanitizeAssetFolderName(`brush-${parentId}`) || 'brush';
  return toStoredAssetPath('brush', `brushes/${safeParentFolder}/${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`);
}

function collectInlineImageParts(responseBody) {
  return responseBody?.candidates
    ?.flatMap(candidate => candidate?.content?.parts || [])
    ?.map(part => part?.inlineData)
    ?.filter(part => part?.data) || [];
}

async function saveImageEdits({ sourceAsset, editId, name = '', imageOutputs = [] }) {
  const savedEdits = [];

  for (const [index, imageOutput] of imageOutputs.entries()) {
    const extension = imageOutput.extension || getExtensionFromMimeType(imageOutput.mimeType);
    const createdAt = Date.now() + index;
    const { width, height } = getImageDimensionsFromBuffer(imageOutput.buffer, {
      filename: `image.${extension}`,
      mimeType: imageOutput.mimeType
    });

    savedEdits.push(await saveAssetEdit({
      parentAssetId: sourceAsset.id,
      editId,
      name,
      bytes: imageOutput.buffer,
      extension,
      // Keep the images/<source>/<editId>/ layout: edits are deleted and renamed
      // by file path, so a flat name here would orphan those operations.
      relativePath: toAssetUrlPath(getImageEditStoredFilePath(sourceAsset, editId, extension)),
      width,
      height,
      createdAt
    }));
  }

  return savedEdits;
}

async function loadWorkflowJson(filePath) {
  const workflowContent = await fs.readFile(toAbsoluteStoragePath(filePath), 'utf-8');
  return JSON.parse(workflowContent);
}

// Load and build a workflow definition from THIS install's database. Passed to
// dataStore.getWorkflowDefinition as the local branch (it cannot import
// parseComfyWorkflow / loadWorkflowJson from here without a cycle).
async function buildLocalWorkflowResponse(workflowId) {
  const record = await getWorkflowRecordById(Number(workflowId));
  return record ? await buildWorkflowResponse(record) : null;
}

async function buildWorkflowResponse(record) {
  if (!record) return null;

  const workflowJson = await loadWorkflowJson(record.filePath);
  const parsedWorkflow = parseComfyWorkflow(workflowJson);

  return {
    id: record.id,
    name: record.name,
    filePath: record.filePath,
    workflowJson,
    availableInputs: parsedWorkflow.inputs,
    availableOutputs: parsedWorkflow.outputs,
    parameters: JSON.parse(record.parametersJson || '[]'),
    outputs: JSON.parse(record.outputsJson || '[]'),
    createdAt: record.creationDate
  };
}

async function saveWorkflowFile(name, workflowJson) {
  await fs.mkdir(WORKFLOW_ASSETS_DIR, { recursive: true });

  const workflowSlug = sanitizeDisplayName(name, 'Workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'workflow';
  const workflowFilename = `${workflowSlug}_${Date.now()}_${Math.round(Math.random() * 1E9)}.json`;
  const workflowFilePath = toStoredAssetPath('workflow', workflowFilename);

  await fs.writeFile(toAbsoluteStoragePath(workflowFilePath), JSON.stringify(workflowJson, null, 2), 'utf-8');

  return workflowFilePath;
}

// ─── API ROUTES ───

app.get('/api/projects', async (req, res) => {
  try {
    res.json(await listProjects(scopeId(req)));
  } catch {
    res.status(500).json({ error: 'Server read error' });
  }
});

app.get('/api/comfyui/workflows/progress/:promptId', (req, res) => {
  subscribeToComfyProgress(req.params.promptId, req, res);
});

// Multiplexed progress stream: a single SSE connection carrying progress for
// every promptId. The client uses this instead of one connection per job so
// running many workflows at once doesn't saturate the browser connection pool.
app.get('/api/comfyui/workflows/events', (req, res) => {
  subscribeToAllComfyProgress(req, res);
});

// Cancel a running (or still queued) ComfyUI workflow. The stop takes effect at
// the next node/step boundary on the ComfyUI side; the run is settled here right
// away so the client stops waiting either way.
app.post('/api/comfyui/workflows/:promptId/cancel', async (req, res) => {
  const promptId = String(req.params.promptId || '').trim();

  if (!promptId) {
    return res.status(400).json({ error: 'promptId is required' });
  }

  try {
    const outcome = await cancelComfyRun(promptId);

    if (!outcome.tracked) {
      // Not tracked here: it already finished, or it was started before a
      // restart / by another process. Still worth asking ComfyUI to drop it.
      const settings = await getSettings();
      const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
      const fallback = await cancelComfyPrompt(baseUrl, promptId);

      // It may not be tracked because its request is still uploading inputs;
      // remember the cancel so the run stops as soon as it registers.
      markComfyCancelledBeforeStart(promptId);

      // Either way nothing here is going to report on this run again, so end it
      // for the client instead of leaving it waiting on a run that is gone.
      publishComfyProgress(promptId, {
        status: 'cancelled',
        detail: fallback.cancelled ? 'Workflow cancelled' : 'Workflow already finished',
        currentNodeLabel: 'Cancelled',
        done: true,
        cancelled: true
      });

      return res.json({
        promptId,
        cancelled: fallback.cancelled,
        via: fallback.via,
        tracked: false,
        alreadyFinished: !fallback.cancelled
      });
    }

    res.json({
      promptId,
      cancelled: outcome.cancelled,
      via: outcome.via,
      tracked: true,
      // ComfyUI had nothing left to stop: the run was already past execution
      // and only the finalize phase was cut short.
      alreadyFinished: !outcome.cancelled
    });
  } catch (err) {
    console.error('Failed to cancel ComfyUI workflow:', err);
    res.status(502).json({ error: err.message || 'Failed to cancel the ComfyUI workflow' });
  }
});

app.post('/api/comfyui/workflows/run', workflowExecutionUpload.any(), async (req, res) => {
  let executionMonitor = null;
  let unregisterRun = null;
  let processingCardId = null;
  let processingProjectId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();
  let processingWorkflowId = null;
  let processingWorkflowName = null;
  let executionPromptId = null;
  let responded = false;
  let backgroundStarted = false;

  try {
    const { projectId, workflowId, cardId, name, parentAssetId } = req.body;
    const normalizedProjectId = Number(projectId);
    const hasProjectId = Number.isFinite(normalizedProjectId) && normalizedProjectId > 0;
    const trimmedName = String(name || '').trim();
    const normalizedParentAssetId = Number(parentAssetId) || null;
    const inputValues = JSON.parse(req.body.inputValues || '{}');
    const persistProcessingCard = String(req.body.persistProcessingCard || '').toLowerCase() !== 'false';
    const persistGeneratedAssets = String(req.body.persistGeneratedAssets || '').toLowerCase() !== 'false';
    // Brainstorming Board generations link assets to the project without creating
    // a visible Kanban card (an Assets_Projects row and no Cards_Assets row).
    const persistAssetsDetached = String(req.body.detachedAsset || '').toLowerCase() === 'true';
    // Default ON: when no explicit parentAssetId is given, save each output under
    // the resolved input asset of the same type — a mesh output becomes a version of
    // the input mesh, an image output an edit of the input image. This means MCP
    // callers get edit/version linkage without tracking parentAssetId (and it does
    // not depend on the MCP tool version, only on this backend). The app frontend
    // opts out explicitly (autoParentFromInputs=false), because it manages its own
    // edit/version saving and its generate flows must produce new root assets.
    const autoParentFromInputs = String(req.body.autoParentFromInputs ?? 'true').toLowerCase() !== 'false';

    if (!workflowId) {
      return res.status(400).json({ error: 'workflowId is required' });
    }

    if (!hasProjectId && (persistProcessingCard || persistGeneratedAssets)) {
      return res.status(400).json({ error: 'projectId is required when persisting workflow results' });
    }

    // The definition may live on the shared server; the run itself never does.
    const workflow = await getWorkflowDefinition(workflowId, buildLocalWorkflowResponse);

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    processingProjectId = hasProjectId ? normalizedProjectId : null;
    processingCardId = persistProcessingCard ? (cardId || randomUUID()) : null;
    processingCardName = trimmedName || workflow.name;
    processingWorkflowId = workflow.id;
    processingWorkflowName = workflow.name;

    const settings = await getSettings();
    const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
    const uploadedFiles = new Map((req.files || []).map(file => [file.fieldname, file]));
    const resolvedInputs = { ...inputValues };
    // The project assets used as image/mesh inputs, grouped by type, so an output
    // can be saved as an edit/version of the same-type source it was derived from.
    const resolvedInputAssetsByType = { image: [], mesh: [] };

    for (const parameter of workflow.parameters || []) {
      const parameterValueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter));
      if (!['image', 'video', 'mesh'].includes(parameterValueType)) continue;

      const fileMarker = inputValues?.[parameter.id];
      const fieldName = fileMarker?.__fileField;
      const uploadedFile = uploadedFiles.get(fieldName);

      if (uploadedFile) {
        resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, uploadedFile);
        continue;
      }

      // "None": upload nothing and resolve no source asset, so the input keeps the
      // value baked into the saved workflow JSON.
      if (isComfyNoneInput(fileMarker)) {
        delete resolvedInputs[parameter.id];
        continue;
      }

      if (['image', 'mesh'].includes(parameterValueType)) {
        if (!hasProjectId) {
          throw new Error(`A project-linked reference is required for ${parameter.name}`);
        }

        const sourceReference = isPlainObject(fileMarker)
          ? (fileMarker.source || fileMarker.filePath || fileMarker.assetId)
          : fileMarker;
        const resolvedSource = parameterValueType === 'mesh'
            ? await resolveProjectSource(normalizedProjectId, 'mesh', sourceReference)
            : await resolveProjectSource(normalizedProjectId, 'image', sourceReference);

        if (!resolvedSource?.asset || resolvedSource.asset.type !== parameterValueType) {
          throw new Error(`A reference file is required for ${parameter.name}`);
        }

        if (resolvedSource.asset.id) {
          resolvedInputAssetsByType[parameterValueType].push(resolvedSource.asset.id);
        }

        const inputBuffer = await readAssetBytes(resolvedSource.inputFilePath);
        resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, {
          buffer: inputBuffer,
          mimetype: getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName),
          originalname: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName)
        });
        continue;
      }

      throw new Error(`A reference file is required for ${parameter.name}`);
    }

    const promptWorkflow = applyComfyParametersToWorkflow(workflow.workflowJson, workflow.parameters, resolvedInputs);
    const executionClientId = String(req.body.clientId || '').trim() || randomUUID();
    executionPromptId = String(req.body.promptId || '').trim() || randomUUID();
    processingStartedAt = Date.now();

    if (persistProcessingCard) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Images',
        name: processingCardName,
        status: 'processing',
        progressPercent: 0,
        detail: 'Preparing ComfyUI workflow',
        currentNodeLabel: 'Waiting for ComfyUI execution to start',
        promptId: executionPromptId,
        source: 'ComfyUI',
        operationType: 'workflow',
        workflowId: processingWorkflowId,
        workflowName: processingWorkflowName,
        startedAt: processingStartedAt
      });
    }

    executionMonitor = createComfyExecutionMonitor(baseUrl, {
      clientId: executionClientId,
      promptId: executionPromptId,
      workflowJson: promptWorkflow,
      selectedOutputs: workflow.outputs,
      onProgress: (payload) => {
        if (!persistProcessingCard) {
          return;
        }

        updateCardProcessingSnapshot(processingProjectId, processingCardId, {
          columnName: 'Images',
          name: processingCardName,
          status: payload?.status === 'error' ? 'error' : 'processing',
          progressPercent: payload?.progressPercent,
          detail: payload?.detail || 'Running ComfyUI workflow',
          currentNodeLabel: payload?.currentNodeLabel || '',
          promptId: executionPromptId,
          source: 'ComfyUI',
          operationType: 'workflow',
          workflowId: processingWorkflowId,
          workflowName: processingWorkflowName,
          startedAt: processingStartedAt
        }).catch(err => {
          console.warn('Failed to persist ComfyUI workflow progress:', err.message);
        });
      }
    });

    // Reachable by /cancel from here on, including while it is only queued.
    const activeRun = { baseUrl, monitor: executionMonitor, cancelRequested: false };
    unregisterRun = registerComfyRun(executionPromptId, activeRun);

    // Cancelled while the inputs were still being uploaded: never queue it.
    if (activeRun.cancelRequested) {
      throw new ComfyCancelledError('Workflow cancelled');
    }

    await executionMonitor.ready;
    publishComfyProgress(executionPromptId, {
      status: 'queued',
      progressPercent: 0,
      detail: 'Queueing ComfyUI workflow',
      currentNodeLabel: workflow.name
    });

    const { promptId: queuedPromptId } = await queueComfyPrompt(baseUrl, promptWorkflow, {
      clientId: executionClientId,
      promptId: executionPromptId
    });

    // A cancel that landed while the prompt was still on its way to ComfyUI
    // found nothing to stop, so ask again now that it is queued — otherwise it
    // would run to completion with nobody waiting for it.
    if (activeRun.cancelRequested) {
      await cancelComfyPrompt(baseUrl, executionPromptId).catch(err => {
        console.warn('Failed to cancel a just-queued ComfyUI workflow:', err.message);
      });
      throw new ComfyCancelledError('Workflow cancelled');
    }

    // Respond immediately once the prompt is queued so the browser connection
    // isn't held open for the entire (possibly multi-minute) generation. The
    // outputs and terminal status are delivered over the multiplexed progress
    // stream instead of this request's response body.
    responded = true;
    backgroundStarted = true;
    res.status(202).json({
      promptId: executionPromptId,
      clientId: executionClientId,
      status: 'queued'
    });

    // Finalize the run in the background: wait for ComfyUI to finish, download
    // and persist the outputs, then publish the terminal event carrying the
    // generated assets to the client.
    (async () => {
      try {
        await executionMonitor.completion;
        // A cancel that lands after execution finished still stops the run here,
        // so nothing is downloaded or saved for a workflow the user let go of.
        if (activeRun.cancelRequested) {
          throw new ComfyCancelledError('Workflow cancelled');
        }
        const historyRecord = await waitForComfyHistory(baseUrl, queuedPromptId, 180, {
          isCancelled: () => activeRun.cancelRequested
        });
        if (activeRun.cancelRequested) {
          throw new ComfyCancelledError('Workflow cancelled');
        }
    const workflowFiles = getComfyHistoryFiles(historyRecord, workflow.outputs);
    const workflowTexts = getComfyHistoryTexts(historyRecord, workflow.outputs);

    if (workflowFiles.length === 0 && workflowTexts.length === 0) {
      throw new Error('The ComfyUI workflow finished but no compatible files were returned');
    }

    const imageCardId = persistProcessingCard ? processingCardId : null;
    const baseTimestamp = Date.now();
    const generatedAssets = [];

    // Resolve which asset an output should be saved under, by output type, so it
    // becomes an image edit / mesh version instead of a new root. An explicit
    // parentAssetId wins when its type matches the output; otherwise, when
    // autoParentFromInputs is set, the output is saved under a resolved input asset
    // of the same type (the source it was derived from). No match → new root asset.
    // Through dataStore: the parent asset's record lives wherever the project
    // does. Reading it from the local database left this empty when connected to
    // a shared server, so the type never matched the output, the explicit parent
    // was silently ignored, and every generated mesh landed as a new root asset
    // instead of a version of its source.
    const explicitParentType = normalizedParentAssetId
      ? String((await getAssetRecord({ assetId: normalizedParentAssetId }))?.assetTypeName || '').toLowerCase()
      : null;
    const resolveOutputParentId = (outputType) => {
      if (normalizedParentAssetId && explicitParentType === outputType) {
        return normalizedParentAssetId;
      }
      if (autoParentFromInputs) {
        return resolvedInputAssetsByType[outputType]?.[0] || null;
      }
      return null;
    };
    const workflowEditId = randomUUID();

    for (const [index, workflowText] of workflowTexts.entries()) {
      generatedAssets.push({
        type: 'text',
        name: workflowText.outputName || trimmedName || workflow.name,
        text: workflowText.text,
        metadata: {
          source: 'COMFYUI',
          provider: 'ComfyUI',
          workflowId: workflow.id,
          workflowName: workflow.name,
          promptId: queuedPromptId,
          outputNodeId: workflowText.nodeId,
          outputKey: workflowText.outputKey
        },
        createdAt: baseTimestamp + index,
        outputKey: workflowText.outputKey,
        outputNodeId: workflowText.nodeId,
        expectedType: 'string',
        temporary: true
      });
    }

    for (const [index, workflowFile] of workflowFiles.entries()) {
      const downloadedFile = await downloadComfyOutputFile(baseUrl, workflowFile);
      const inferredAssetType = inferSupportedAssetTypeFromFilename(workflowFile.filename) || workflowFile.expectedType || 'image';
      const fallbackExtension = inferredAssetType === 'mesh'
        ? getExtensionFromContentType(downloadedFile.contentType, 'glb')
        : getExtensionFromMimeType(downloadedFile.contentType);
      const extension = path.extname(workflowFile.filename).replace('.', '') || fallbackExtension;
      const dimensions = inferredAssetType === 'image'
        ? getImageDimensionsFromBuffer(downloadedFile.buffer, {
            filename: workflowFile.filename,
            mimeType: downloadedFile.contentType
          })
        : { width: 0, height: 0 };
      const generatedAssetPayload = {
        projectId: normalizedProjectId,
        type: inferredAssetType,
        name: (trimmedName || inferredAssetType === 'mesh')
          ? processingCardName
          : createGeneratedImageName(workflow.name, extension), // honor the user-provided Result name; fall back to a generated name only when none was given
        width: dimensions.width,
        height: dimensions.height,
        metadata: {
          resolution: inferredAssetType === 'image' ? formatImageResolution(dimensions.width, dimensions.height) : 'Unknown',
          format: extension.toUpperCase(),
          source: 'COMFYUI',
          provider: 'ComfyUI',
          workflowId: workflow.id,
          workflowName: workflow.name,
          promptId: queuedPromptId,
          outputNodeId: workflowFile.nodeId,
          outputFilename: workflowFile.filename,
          savedOutputs: workflowFiles.length,
          ...(imageCardId ? { cardId: imageCardId } : {})
        },
        createdAt: baseTimestamp + index
      };

      if (persistGeneratedAssets) {
        // ComfyUI returns no cover image, so headless mesh outputs have no
        // thumbnail — render one via the mesh-tools service (best-effort).
        const meshThumbnail = inferredAssetType === 'mesh'
          ? await renderMeshThumbnailViaService(downloadedFile.buffer, generatedAssetPayload.name)
          : null;

        // dataStore writes to this machine's database, or to the shared server
        // when this install is connected to one. The bytes never touch disk here.
        const ingest = {
          ...generatedAssetPayload,
          bytes: downloadedFile.buffer,
          extension,
          thumbnailBytes: meshThumbnail?.bytes || null,
          thumbnailFilename: meshThumbnail?.filename || null
        };

        // Store the output under the source it was derived from when one applies: a
        // mesh output becomes a version of the source mesh, an image output an edit
        // of the source image. Otherwise it's a new root asset.
        const outputParentId = resolveOutputParentId(inferredAssetType);
        const persistedAsset = (outputParentId && inferredAssetType === 'mesh')
          ? await saveAssetVersion({ ...ingest, parentAssetId: outputParentId, projectId: hasProjectId ? normalizedProjectId : null })
          : (outputParentId && inferredAssetType === 'image')
            ? {
                ...(await saveAssetEdit({
                  ...ingest,
                  parentAssetId: outputParentId,
                  editId: workflowEditId,
                  projectId: hasProjectId ? normalizedProjectId : null
                })),
                type: 'image'
              }
            : await saveRootAsset({ ...ingest, detached: persistAssetsDetached });

        // Built from what was actually stored: the destination picks the final
        // filename, so it can no longer be predicted before the write.
        const storedPath = persistedAsset?.filePath || persistedAsset?.filename || '';
        generatedAssets.push({
          ...persistedAsset,
          url: `${getRequestBaseUrl(req)}/assets/${encodeURI(toAssetUrlPath(storedPath))}`,
          outputKey: workflowFile.outputKey,
          outputNodeId: workflowFile.nodeId,
          expectedType: workflowFile.expectedType,
          temporary: false
        });
        continue;
      }

      generatedAssets.push({
        type: generatedAssetPayload.type,
        name: generatedAssetPayload.name,
        filename: workflowFile.filename,
        filePath: workflowFile.filename,
        url: `data:${downloadedFile.contentType};base64,${downloadedFile.buffer.toString('base64')}`,
        width: generatedAssetPayload.width,
        height: generatedAssetPayload.height,
        metadata: generatedAssetPayload.metadata,
        createdAt: generatedAssetPayload.createdAt,
        outputKey: workflowFile.outputKey,
        outputNodeId: workflowFile.nodeId,
        expectedType: workflowFile.expectedType,
        temporary: true
      });
    }

        if (persistProcessingCard) {
          await clearCardProcessing(processingProjectId, processingCardId, {
            name: processingCardName
          });
        }

        // A cancel that arrived while the outputs were being saved: they are on
        // disk now, but the client has already been told the run is cancelled, so
        // don't overwrite that with a completed snapshot a reconnecting stream
        // would replay and act on.
        if (activeRun.cancelRequested) {
          throw new ComfyCancelledError('Workflow cancelled');
        }

        // Terminal event: `done` + `result` signal the client that the run has
        // fully completed and carry the generated assets it used to receive in
        // the (now non-blocking) POST response body.
        publishComfyProgress(executionPromptId, {
          status: 'completed',
          progressPercent: 100,
          detail: 'ComfyUI workflow completed',
          currentNodeLabel: 'ComfyUI workflow completed',
          done: true,
          result: generatedAssets
        });
      } catch (finalizeErr) {
        const wasCancelled = Boolean(finalizeErr?.cancelled);

        if (wasCancelled) {
          console.log(`ComfyUI workflow ${executionPromptId} cancelled by the user`);
        } else {
          console.error('ComfyUI workflow finalization failed:', finalizeErr);
        }

        if (processingProjectId && processingCardId) {
          // A cancelled run leaves no result, so the processing card goes back to
          // idle instead of being marked failed.
          const restoreCard = wasCancelled
            ? clearCardProcessing(processingProjectId, processingCardId, { name: processingCardName })
            : updateCardProcessingSnapshot(processingProjectId, processingCardId, {
                columnName: 'Images',
                name: processingCardName,
                status: 'error',
                progressPercent: null,
                detail: finalizeErr.message || 'Failed to execute ComfyUI workflow',
                currentNodeLabel: 'ComfyUI execution failed',
                promptId: executionPromptId,
                source: 'ComfyUI',
                operationType: 'workflow',
                workflowId: processingWorkflowId,
                workflowName: processingWorkflowName,
                startedAt: processingStartedAt
              });

          await restoreCard.catch(persistErr => {
            console.warn('Failed to persist the ComfyUI workflow terminal state:', persistErr.message);
          });
        }
        publishComfyProgress(executionPromptId, wasCancelled
          ? {
              status: 'cancelled',
              detail: finalizeErr.message || 'Workflow cancelled',
              currentNodeLabel: 'Cancelled',
              done: true,
              cancelled: true
            }
          : {
              status: 'error',
              detail: finalizeErr.message || 'Failed to execute ComfyUI workflow',
              currentNodeLabel: 'ComfyUI execution failed',
              done: true
            });
      } finally {
        unregisterRun?.();
        executionMonitor?.close();
      }
    })();
  } catch (err) {
    const wasCancelled = Boolean(err?.cancelled);

    if (wasCancelled) {
      console.log('ComfyUI workflow cancelled before it started running');
    } else {
      console.error('ComfyUI workflow execution failed:', err);
    }

    if (processingProjectId && processingCardId) {
      const restoreCard = wasCancelled
        ? clearCardProcessing(processingProjectId, processingCardId, { name: processingCardName })
        : updateCardProcessingSnapshot(processingProjectId, processingCardId, {
            columnName: 'Images',
            name: processingCardName,
            status: 'error',
            progressPercent: null,
            detail: err.message || 'Failed to execute ComfyUI workflow',
            currentNodeLabel: 'ComfyUI execution failed',
            promptId: executionPromptId,
            source: 'ComfyUI',
            operationType: 'workflow',
            workflowId: processingWorkflowId,
            workflowName: processingWorkflowName,
            startedAt: processingStartedAt
          });

      await restoreCard.catch(persistErr => {
        console.warn('Failed to persist the ComfyUI workflow terminal state:', persistErr.message);
      });
    }
    const failedPromptId = String(req.body?.promptId || '').trim() || String(executionPromptId || '').trim();
    if (failedPromptId) {
      publishComfyProgress(failedPromptId, wasCancelled
        ? {
            status: 'cancelled',
            detail: err.message || 'Workflow cancelled',
            currentNodeLabel: 'Cancelled',
            done: true,
            cancelled: true
          }
        : {
            status: 'error',
            detail: err.message || 'Failed to execute ComfyUI workflow',
            currentNodeLabel: 'ComfyUI execution failed',
            done: true
          });
    }

    if (!responded) {
      res.status(wasCancelled ? 409 : 500).json({
        error: err.message || 'Failed to execute ComfyUI workflow',
        ...(wasCancelled ? { cancelled: true } : {})
      });
    }
  } finally {
    // The background finalizer owns the monitor once it has started; only close
    // here for failures that happen before the response is sent.
    if (!backgroundStarted) {
      unregisterRun?.();
      executionMonitor?.close();
    }
  }
});

app.post('/api/meshes/generate', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const {
      projectId,
      selectedApi,
      prompt,
      name,
      imageSource,
      cardId,
      region,
      modelVersion,
      enablePBR,
      faceCount,
      generationType,
      polygonType,
      parentAssetId
    } = req.body;
    const normalizedParentAssetId = Number(parentAssetId) || null;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();
    const isTencentMeshApi = isTencentMeshGenerationApi(selectedApi);
    const isTripoMeshApi = isTripoMeshGenerationApi(selectedApi);
    const isHitemMeshApi = isHitemMeshGenerationApi(selectedApi);
    const effectiveImageSource = (isTencentMeshApi || isTripoMeshApi) && trimmedPrompt
      ? ''
      : imageSource;

    if (!projectId || !selectedApi || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi and name are required' });
    }

    if (!isTencentMeshApi && !isTripoMeshApi && !isHitemMeshApi && !trimmedPrompt) {
      return res.status(400).json({ error: 'prompt is required for mesh generation' });
    }

    if (isHitemMeshApi && !effectiveImageSource) {
      return res.status(400).json({ error: 'Hitem3D requires an image source for mesh generation' });
    }

    if (!isTencentMeshApi && !isTripoMeshApi && !isHitemMeshApi && !String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh generation currently supports custom APIs only' });
    }

    let resolvedSource = null;
    let sourceAsset = null;
    if (effectiveImageSource) {
      resolvedSource = await resolveProjectSource(Number(projectId), 'image', effectiveImageSource);
      sourceAsset = resolvedSource?.asset;

      if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'image') {
        return res.status(404).json({ error: 'Source image or edit not found' });
      }
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset?.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    const settings = await getSettings();

    if (isTencentMeshApi) {
      const validatedInput = normalizeTencentMeshGenerationInput({
        prompt: trimmedPrompt,
        hasImageSource: Boolean(resolvedSource),
        region,
        modelVersion,
        enablePBR,
        faceCount,
        generationType,
        polygonType
      });
      // The bytes may live on the shared server, so read them through dataStore.
      const sourceBuffer = resolvedSource ? await readAssetBytes(resolvedSource.inputFilePath) : null;

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Submitting Tencent Cloud mesh generation job',
        currentNodeLabel: 'Waiting for Tencent Cloud job id',
        source: 'Tencent Cloud',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        selectedApi,
        region: validatedInput.normalizedRegion,
        modelVersion: validatedInput.normalizedModelVersion,
        generationType: validatedInput.normalizedGenerationType,
        polygonType: validatedInput.normalizedGenerationType === 'LowPoly' ? validatedInput.normalizedPolygonType : null,
        enablePBR: validatedInput.normalizedEnablePBR,
        faceCount: validatedInput.normalizedFaceCount,
        inputSource: effectiveImageSource || null
      });

      const submittedJob = await submitTencentCloudMeshGenerationJob(settings, {
        region: validatedInput.normalizedRegion,
        modelVersion: validatedInput.normalizedModelVersion,
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : '',
        imageBuffer: sourceBuffer,
        enablePBR: validatedInput.normalizedEnablePBR,
        faceCount: validatedInput.normalizedFaceCount,
        generationType: validatedInput.normalizedGenerationType,
        polygonType: validatedInput.normalizedPolygonType
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Tencent Cloud job submitted. Use GET RESULT to refresh status.',
        currentNodeLabel: getTencentJobRuntimeLabel('WAIT'),
        source: 'Tencent Cloud',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        promptId: submittedJob.jobId,
        selectedApi,
        region: validatedInput.normalizedRegion,
        modelVersion: validatedInput.normalizedModelVersion,
        generationType: validatedInput.normalizedGenerationType,
        polygonType: validatedInput.normalizedGenerationType === 'LowPoly' ? validatedInput.normalizedPolygonType : null,
        enablePBR: validatedInput.normalizedEnablePBR,
        faceCount: validatedInput.normalizedFaceCount,
        jobId: submittedJob.jobId,
        jobStatus: 'WAIT',
        inputSource: effectiveImageSource || null
      });

      return res.status(202).json({
        status: 'queued',
        provider: 'Tencent Cloud',
        selectedApi,
        jobId: submittedJob.jobId,
        requestId: submittedJob.requestId,
        region: validatedInput.normalizedRegion,
        name: trimmedName,
        cardId: processingCardId
      });
    }

    if (isTripoMeshApi) {
      console.log('[TripoAI][GenerateRoute] request summary:', JSON.stringify({
        promptLength: trimmedPrompt.length,
        receivedImageSource: String(imageSource || ''),
        effectiveImageSource: String(effectiveImageSource || ''),
        selectedApi: String(selectedApi || '')
      }, null, 2));

      // The bytes may live on the shared server, so read them through dataStore.
      const sourceBuffer = resolvedSource ? await readAssetBytes(resolvedSource.inputFilePath) : null;
      const validatedInput = normalizeTripoMeshGenerationInput({
        prompt: trimmedPrompt,
        hasImageSource: Boolean(resolvedSource),
        modelVersion: req.body?.modelVersion,
        modelSeed: req.body?.modelSeed,
        enableImageAutofix: req.body?.enableImageAutofix,
        faceLimit: req.body?.faceLimit,
        texture: req.body?.texture,
        pbr: req.body?.pbr,
        textureSeed: req.body?.textureSeed,
        textureAlignment: req.body?.textureAlignment,
        textureQuality: req.body?.textureQuality,
        autoSize: req.body?.autoSize,
        orientation: req.body?.orientation,
        quad: req.body?.quad,
        smartLowPoly: req.body?.smartLowPoly,
        generateParts: req.body?.generateParts,
        exportUv: req.body?.exportUv,
        geometryQuality: req.body?.geometryQuality
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Uploading image and submitting Tripo AI mesh generation task',
        currentNodeLabel: 'Waiting for Tripo AI task id',
        source: 'Tripo AI',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        selectedApi,
        inputSource: effectiveImageSource || null,
        modelVersion: validatedInput.normalizedModelVersion,
        texture: validatedInput.normalizedTexture,
        pbr: validatedInput.normalizedPbr,
        textureAlignment: validatedInput.normalizedTextureAlignment,
        textureQuality: validatedInput.normalizedTextureQuality,
        orientation: validatedInput.normalizedOrientation,
        quad: validatedInput.normalizedQuad,
        smartLowPoly: validatedInput.normalizedSmartLowPoly,
        generateParts: validatedInput.normalizedGenerateParts,
        exportUv: validatedInput.normalizedExportUv,
        autoSize: validatedInput.normalizedAutoSize,
        geometryQuality: validatedInput.supportsGeometryQuality ? validatedInput.normalizedGeometryQuality : null,
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : ''
      });

      const submittedTask = await submitTripoMeshGenerationTask(settings, {
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : '',
        imageBuffer: sourceBuffer,
        inputFilePath: resolvedSource?.inputFilePath || resolvedSource?.inputFilename || '',
        modelVersion: validatedInput.normalizedModelVersion,
        modelSeed: validatedInput.normalizedModelSeed,
        enableImageAutofix: validatedInput.normalizedEnableImageAutofix,
        faceLimit: validatedInput.normalizedFaceLimit,
        texture: validatedInput.normalizedTexture,
        pbr: validatedInput.normalizedPbr,
        textureSeed: validatedInput.normalizedTextureSeed,
        textureAlignment: validatedInput.normalizedTextureAlignment,
        textureQuality: validatedInput.normalizedTextureQuality,
        autoSize: validatedInput.normalizedAutoSize,
        orientation: validatedInput.normalizedOrientation,
        quad: validatedInput.normalizedQuad,
        smartLowPoly: validatedInput.normalizedSmartLowPoly,
        generateParts: validatedInput.normalizedGenerateParts,
        exportUv: validatedInput.normalizedExportUv,
        geometryQuality: validatedInput.normalizedGeometryQuality
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Tripo AI task submitted. Use GET RESULT to refresh status.',
        currentNodeLabel: 'Tripo AI task is queued',
        source: 'Tripo AI',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        promptId: submittedTask.taskId,
        selectedApi,
        taskId: submittedTask.taskId,
        taskStatus: 'queued',
        inputSource: effectiveImageSource || null,
        modelVersion: validatedInput.normalizedModelVersion,
        texture: validatedInput.normalizedTexture,
        pbr: validatedInput.normalizedPbr,
        textureAlignment: validatedInput.normalizedTextureAlignment,
        textureQuality: validatedInput.normalizedTextureQuality,
        orientation: validatedInput.normalizedOrientation,
        quad: validatedInput.normalizedQuad,
        smartLowPoly: validatedInput.normalizedSmartLowPoly,
        generateParts: validatedInput.normalizedGenerateParts,
        exportUv: validatedInput.normalizedExportUv,
        autoSize: validatedInput.normalizedAutoSize,
        geometryQuality: validatedInput.supportsGeometryQuality ? validatedInput.normalizedGeometryQuality : null,
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : ''
      });

      return res.status(202).json({
        status: 'queued',
        provider: 'Tripo AI',
        selectedApi,
        taskId: submittedTask.taskId,
        name: trimmedName,
        cardId: processingCardId,
        canFetchResult: true
      });
    }

    if (isHitemMeshApi) {
      // The bytes may live on the shared server, so read them through dataStore.
      const sourceBuffer = resolvedSource ? await readAssetBytes(resolvedSource.inputFilePath) : null;
      const validatedInput = normalizeHitemMeshGenerationInput({
        hasImageSource: Boolean(sourceBuffer),
        model: req.body?.hitemModel,
        resolution: req.body?.hitemResolution,
        requestType: req.body?.hitemRequestType,
        face: req.body?.hitemFace,
        pbr: req.body?.hitemPbr
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Submitting Hitem3D mesh generation task',
        currentNodeLabel: 'Waiting for Hitem3D task id',
        source: 'Hitem3D',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        selectedApi,
        inputSource: effectiveImageSource || null,
        hitemModel: validatedInput.normalizedModel,
        hitemResolution: validatedInput.normalizedResolution,
        hitemRequestType: validatedInput.normalizedRequestType,
        hitemFace: validatedInput.normalizedFace,
        hitemPbr: validatedInput.normalizedPbr
      });

      const submittedTask = await submitHitemMeshGenerationTask(settings, {
        imageBuffer: sourceBuffer,
        inputFilePath: resolvedSource?.inputFilePath || resolvedSource?.inputFilename || '',
        model: validatedInput.normalizedModel,
        resolution: validatedInput.normalizedResolution,
        requestType: validatedInput.normalizedRequestType,
        face: validatedInput.normalizedFace,
        pbr: validatedInput.normalizedPbr
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Hitem3D task submitted. Use GET RESULT to refresh status.',
        currentNodeLabel: 'Hitem3D task is queued',
        source: 'Hitem3D',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        promptId: submittedTask.taskId,
        selectedApi,
        taskId: submittedTask.taskId,
        taskStatus: 'processing',
        inputSource: effectiveImageSource || null,
        hitemModel: validatedInput.normalizedModel,
        hitemResolution: validatedInput.normalizedResolution,
        hitemRequestType: validatedInput.normalizedRequestType,
        hitemFace: validatedInput.normalizedFace,
        hitemPbr: validatedInput.normalizedPbr
      });

      return res.status(202).json({
        status: 'queued',
        provider: 'Hitem3D',
        selectedApi,
        taskId: submittedTask.taskId,
        name: trimmedName,
        cardId: processingCardId,
        canFetchResult: true
      });
    }

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Mesh Gen',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh generation request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-generation',
      startedAt: processingStartedAt
    });

    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-generation');
    // The bytes may live on the shared server, so read them through dataStore.
    const sourceBuffer = await readAssetBytes(resolvedSource.inputFilePath);
    const imageMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      imageBase64: sourceBuffer.toString('base64'),
      imageMimeType,
      imageFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'image.png')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh generation request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');

    const meshAssetPayload = {
      type: 'mesh',
      name: trimmedName,
      bytes: meshOutput.buffer,
      extension,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now()
    };

    // When a mesh was connected to the node and used to edit it, save the
    // result as a version (child) of that mesh instead of a new root asset.
    const savedAsset = normalizedParentAssetId
      ? await saveAssetVersion({ ...meshAssetPayload, parentAssetId: normalizedParentAssetId, projectId: Number(projectId) })
      : await saveRootAsset({ ...meshAssetPayload, projectId: Number(projectId) });

    await clearCardProcessing(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh generation API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh generation API',
        currentNodeLabel: 'Mesh generation failed',
        source: 'API',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh generation error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh generation API' });
  }
});

app.post('/api/meshes/generate/tencent/result', async (req, res) => {
  try {
    const { projectId, jobId, region, name, prompt = '', cardId = null, selectedApi = TENCENT_MESH_GENERATION_API_ID, parentAssetId = null } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !jobId || !region || !trimmedName) {
      return res.status(400).json({ error: 'projectId, jobId, region and name are required' });
    }

    const normalizedRegion = TENCENT_REGIONS.has(String(region || '').trim()) ? String(region || '').trim() : null;
    if (!normalizedRegion) {
      return res.status(400).json({ error: 'Invalid Tencent Cloud region' });
    }

    const settings = await getSettings();
    const jobResult = await queryTencentCloudMeshGenerationJob(settings, {
      region: normalizedRegion,
      jobId
    });

    if (jobResult.status === 'FAIL') {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'error',
          progressPercent: null,
          detail: jobResult.errorMessage || jobResult.errorCode || 'Tencent Cloud mesh generation failed',
          currentNodeLabel: getTencentJobRuntimeLabel('FAIL'),
          source: 'Tencent Cloud',
          operationType: 'mesh-generation',
          selectedApi,
          region: normalizedRegion,
          promptId: String(jobId),
          jobId: String(jobId),
          jobStatus: 'FAIL'
        });
      }

      return res.json({
        status: 'error',
        provider: 'Tencent Cloud',
        selectedApi,
        jobId: String(jobId),
        region: normalizedRegion,
        requestId: jobResult.requestId,
        error: jobResult.errorMessage || jobResult.errorCode || 'Tencent Cloud mesh generation failed'
      });
    }

    if (jobResult.status === 'RUN' || jobResult.status === 'WAIT') {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'processing',
          progressPercent: null,
          detail: `Tencent Cloud job status: ${jobResult.status}`,
          currentNodeLabel: getTencentJobRuntimeLabel(jobResult.status),
          source: 'Tencent Cloud',
          operationType: 'mesh-generation',
          selectedApi,
          region: normalizedRegion,
          promptId: String(jobId),
          jobId: String(jobId),
          jobStatus: jobResult.status
        });
      }

      return res.json({
        status: 'processing',
        provider: 'Tencent Cloud',
        selectedApi,
        jobId: String(jobId),
        region: normalizedRegion,
        requestId: jobResult.requestId,
        jobStatus: jobResult.status,
        canFetchResult: true
      });
    }

    if (jobResult.status !== 'DONE') {
      return res.status(500).json({ error: `Unsupported Tencent Cloud job status: ${jobResult.status}` });
    }

    const downloadedFiles = await downloadTencentCloudResultFiles(jobResult.resultFiles);
    if (downloadedFiles.length === 0) {
      throw new Error('Tencent Cloud job finished but no mesh result files were returned');
    }

    const savedAssets = await saveGeneratedMeshAssets({
      projectId: Number(projectId),
      name: trimmedName,
      cardId,
      provider: 'Tencent Cloud',
      prompt: String(prompt || '').trim(),
      metadata: {
        region: normalizedRegion,
        selectedApi,
        jobId: String(jobId)
      },
      downloadedFiles,
      parentAssetId
    });

    if (cardId) {
      await clearCardProcessing(Number(projectId), cardId, {
        name: trimmedName
      });
    }

    return res.json({
      status: 'completed',
      provider: 'Tencent Cloud',
      selectedApi,
      jobId: String(jobId),
      region: normalizedRegion,
      requestId: jobResult.requestId,
      jobStatus: 'DONE',
      assets: savedAssets
    });
  } catch (err) {
    console.error('Tencent Cloud mesh generation result query failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Tencent Cloud mesh generation result' });
  }
});

app.post('/api/meshes/generate/tripo/result', async (req, res) => {
  try {
    const { projectId, taskId, name, prompt = '', cardId = null, selectedApi = TRIPO_MESH_GENERATION_API_ID, parentAssetId = null } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !taskId || !trimmedName) {
      return res.status(400).json({ error: 'projectId, taskId and name are required' });
    }

    const settings = await getSettings();
    const taskResult = await queryTripoMeshGenerationTask(settings, { taskId });

    if (TRIPO_FAILURE_STATUSES.has(taskResult.status)) {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'error',
          progressPercent: Number.isFinite(taskResult.progress) ? Math.max(0, Math.min(100, Math.round(taskResult.progress))) : null,
          detail: taskResult.errorMessage || `Tripo AI task failed with status: ${taskResult.status}`,
          currentNodeLabel: 'Tripo AI task failed',
          source: 'Tripo AI',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'error',
        provider: 'Tripo AI',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        error: taskResult.errorMessage || `Tripo AI task failed with status: ${taskResult.status}`
      });
    }

    if (TRIPO_RUNNING_STATUSES.has(taskResult.status)) {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'processing',
          progressPercent: Number.isFinite(taskResult.progress) ? Math.max(0, Math.min(100, Math.round(taskResult.progress))) : null,
          detail: `Tripo AI task status: ${taskResult.status}`,
          currentNodeLabel: taskResult.status === 'running' ? 'Tripo AI task is running' : 'Tripo AI task is queued',
          source: 'Tripo AI',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'processing',
        provider: 'Tripo AI',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        progress: Number.isFinite(taskResult.progress) ? Math.max(0, Math.min(100, Math.round(taskResult.progress))) : null,
        canFetchResult: true
      });
    }

    if (taskResult.status !== TRIPO_SUCCESS_STATUS) {
      return res.status(500).json({ error: `Unsupported Tripo AI task status: ${taskResult.status}` });
    }

    const downloadedFile = await downloadTripoMeshResult(taskResult.output);
    const savedAssets = await saveGeneratedMeshAssets({
      projectId: Number(projectId),
      name: trimmedName,
      cardId,
      provider: 'Tripo AI',
      prompt: String(prompt || '').trim(),
      metadata: {
        selectedApi,
        taskId: String(taskId),
        sourceUrl: downloadedFile.url,
        isPbrModel: downloadedFile.isPbr
      },
      downloadedFiles: [downloadedFile],
      parentAssetId
    });

    if (cardId) {
      await clearCardProcessing(Number(projectId), cardId, {
        name: trimmedName
      });
    }

    return res.json({
      status: 'completed',
      provider: 'Tripo AI',
      selectedApi,
      taskId: String(taskId),
      taskStatus: TRIPO_SUCCESS_STATUS,
      assets: savedAssets
    });
  } catch (err) {
    console.error('Tripo AI mesh generation result query failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Tripo AI mesh generation result' });
  }
});

app.post('/api/meshes/generate/hitem/result', async (req, res) => {
  try {
    const { projectId, taskId, name, prompt = '', cardId = null, selectedApi = HITEM_MESH_GENERATION_API_ID, parentAssetId = null } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !taskId || !trimmedName) {
      return res.status(400).json({ error: 'projectId, taskId and name are required' });
    }

    const settings = await getSettings();
    const taskResult = await queryHitemMeshGenerationTask(settings, { taskId });

    if (HITEM_FAILURE_STATUSES.has(taskResult.status)) {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'error',
          progressPercent: null,
          detail: `Hitem3D task failed with status: ${taskResult.status}`,
          currentNodeLabel: 'Hitem3D task failed',
          source: 'Hitem3D',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'error',
        provider: 'Hitem3D',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        error: `Hitem3D task failed with status: ${taskResult.status}`
      });
    }

    if (taskResult.status !== HITEM_SUCCESS_STATUS) {
      // Any non-success, non-failure state is treated as still-processing.
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'processing',
          progressPercent: null,
          detail: `Hitem3D task status: ${taskResult.status}`,
          currentNodeLabel: 'Hitem3D task is running',
          source: 'Hitem3D',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'processing',
        provider: 'Hitem3D',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        canFetchResult: true
      });
    }

    const downloadedFile = await downloadHitemMeshResult(taskResult);
    const savedAssets = await saveGeneratedMeshAssets({
      projectId: Number(projectId),
      name: trimmedName,
      cardId,
      provider: 'Hitem3D',
      prompt: String(prompt || '').trim(),
      metadata: {
        selectedApi,
        taskId: String(taskId),
        sourceUrl: downloadedFile.url
      },
      downloadedFiles: [downloadedFile],
      parentAssetId
    });

    if (cardId) {
      await clearCardProcessing(Number(projectId), cardId, {
        name: trimmedName
      });
    }

    return res.json({
      status: 'completed',
      provider: 'Hitem3D',
      selectedApi,
      taskId: String(taskId),
      taskStatus: HITEM_SUCCESS_STATUS,
      assets: savedAssets
    });
  } catch (err) {
    console.error('Hitem3D mesh generation result query failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Hitem3D mesh generation result' });
  }
});

app.post('/api/meshes/edit', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, meshSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh edit currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectSource(Number(projectId), 'mesh', meshSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'mesh') {
      return res.status(404).json({ error: 'Source mesh not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Mesh Edit',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh edit request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-edit',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-edit');
    // The bytes may live on the shared server, so read them through dataStore.
    const sourceBuffer = await readAssetBytes(resolvedSource.inputFilePath);
    const meshMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      meshBase64: sourceBuffer.toString('base64'),
      meshMimeType,
      meshFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'mesh.glb')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh edit request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    // The result was produced from an existing source mesh, so save it as a
    // version (child) of that mesh instead of creating a new root asset.
    // dataStore decides whether the bytes land here or on the shared server.
    const savedAsset = await saveAssetVersion({
      parentAssetId: sourceAsset.id,
      type: 'mesh',
      name: trimmedName,
      bytes: meshOutput.buffer,
      extension,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now(),
      // The generated geometry differs from the parent, so render its own thumbnail.
      inheritThumbnail: false
    });

    await clearCardProcessing(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh edit API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Edit',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh edit API',
        currentNodeLabel: 'Mesh edit failed',
        source: 'API',
        operationType: 'mesh-edit',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh edit error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh edit API' });
  }
});

app.post('/api/meshes/texture', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, meshSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh texturing currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectSource(Number(projectId), 'mesh', meshSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'mesh') {
      return res.status(404).json({ error: 'Source mesh not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Texturing',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh texturing request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-texturing',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-texturing');
    // The bytes may live on the shared server, so read them through dataStore.
    const sourceBuffer = await readAssetBytes(resolvedSource.inputFilePath);
    const meshMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      meshBase64: sourceBuffer.toString('base64'),
      meshMimeType,
      meshFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'mesh.glb')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh texturing request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    // The result was produced from an existing source mesh, so save it as a
    // version (child) of that mesh instead of creating a new root asset.
    // dataStore decides whether the bytes land here or on the shared server.
    const savedAsset = await saveAssetVersion({
      parentAssetId: sourceAsset.id,
      type: 'mesh',
      name: trimmedName,
      bytes: meshOutput.buffer,
      extension,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now(),
      // The generated geometry differs from the parent, so render its own thumbnail.
      inheritThumbnail: false
    });

    await clearCardProcessing(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh texturing API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Texturing',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh texturing API',
        currentNodeLabel: 'Mesh texturing failed',
        source: 'API',
        operationType: 'mesh-texturing',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh texturing error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh texturing API' });
  }
});

// Kanban "Rigging" column custom-API runner. Mirrors the mesh texturing/edit
// flow: takes a source mesh, POSTs it to the user's configured mesh-rigging
// custom API, and saves the returned mesh as a version of the source. Distinct
// from POST /api/meshes/rig, which proxies the built-in rig micro-service.
app.post('/api/meshes/rigging', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, meshSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh rigging currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectSource(Number(projectId), 'mesh', meshSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'mesh') {
      return res.status(404).json({ error: 'Source mesh not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Rigging',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh rigging request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-rigging',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-rigging');
    // The bytes may live on the shared server, so read them through dataStore.
    const sourceBuffer = await readAssetBytes(resolvedSource.inputFilePath);
    const meshMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      meshBase64: sourceBuffer.toString('base64'),
      meshMimeType,
      meshFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'mesh.glb')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh rigging request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    // The result was produced from an existing source mesh, so save it as a
    // version (child) of that mesh instead of creating a new root asset.
    // dataStore decides whether the bytes land here or on the shared server.
    const savedAsset = await saveAssetVersion({
      parentAssetId: sourceAsset.id,
      type: 'mesh',
      name: trimmedName,
      bytes: meshOutput.buffer,
      extension,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now(),
      // The generated geometry differs from the parent, so render its own thumbnail.
      inheritThumbnail: false
    });

    await clearCardProcessing(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh rigging API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Rigging',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh rigging API',
        currentNodeLabel: 'Mesh rigging failed',
        source: 'API',
        operationType: 'mesh-rigging',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh rigging error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh rigging API' });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    res.status(201).json(await createProject({ ...req.body, ownerId: viewerId(req) }));
  } catch {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await requireProject(req, res, req.params.id);
    if (!project) return;
    res.json(project);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const updated = await updateProject(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: 'Project not found' });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const deleteAssets = req.query.deleteAssets === 'true';
    await deleteProjectById(Number(req.params.id), { deleteAssets });
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Deletion failed' });
  }
});

// Project <-> asset membership (Assets_Projects). An asset belongs to a project
// on its own, with no card required: any asset id works, root or edit/version.
app.post('/api/projects/:id/assets', async (req, res) => {
  try {
    const assetId = Number(req.body?.assetId);

    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ error: 'assetId is required' });
    }

    const linked = await linkExistingAssetToProject(Number(req.params.id), assetId, {
      cascadeChildren: req.body?.cascadeChildren === true
    });

    res.status(201).json(linked);
  } catch (err) {
    if (err.message === 'Asset not found') {
      return res.status(404).json({ error: 'Asset not found' });
    }
    if (err.message?.startsWith('Project not found:')) {
      return res.status(404).json({ error: 'Project not found' });
    }
    console.error('Failed to link asset to project:', err);
    res.status(500).json({ error: 'Failed to link asset to project' });
  }
});

app.delete('/api/projects/:id/assets/:assetId', async (req, res) => {
  try {
    const result = await unlinkAssetFromProjectById(Number(req.params.id), Number(req.params.assetId), {
      cascadeChildren: req.query.cascadeChildren !== 'false'
    });

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(result);
  } catch (err) {
    console.error('Failed to unlink asset from project:', err);
    res.status(500).json({ error: 'Failed to unlink asset from project' });
  }
});

// Turn a filesystem-unsafe name into a folder base name (letters, digits,
// spaces, dot, dash, underscore) so it can name the export folder + .3dgp file.
function sanitizeProjectExportName(name, fallback = 'project') {
  // eslint-disable-next-line no-control-regex -- intentionally strips control chars (illegal in filenames)
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?* -]+/g, '_').replace(/\.+$/, '').trim();
  return cleaned || fallback;
}

async function readAppVersion() {
  try {
    // APP_DIR, not cwd: the desktop shell spawns this process with cwd set to the
    // per-user data root, where version.json is absent — every exported bundle was
    // recording an empty appVersion.
    const raw = await fs.readFile(path.join(APP_DIR, 'version.json'), 'utf8');
    return JSON.parse(raw)?.version || '';
  } catch {
    return '';
  }
}

// Export a project as a self-contained .3dgp bundle folder under `folder`.
//
// This runs on the LOCAL install even when the project lives on a shared server:
// `folder` is a path on the user's own machine, chosen with the native folder
// picker. Forwarded to the container, "C:\Travaux" failed the isAbsolute check
// (it is not absolute on Linux), and a POSIX-looking path would instead have
// written the bundle inside the container. serverMode.js keeps this route off the
// gateway's forward list; the data half comes through dataStore.
app.post('/api/projects/:id/export', async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
    const requestedName = typeof req.body?.name === 'string' ? req.body.name : '';

    if (!folder) {
      return res.status(400).json({ error: 'A destination folder is required.' });
    }
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'The destination folder must be an absolute path.' });
    }

    const { manifest, files } = await buildProjectExportPlan(projectId, await readAppVersion());
    const bundleName = sanitizeProjectExportName(requestedName || manifest.project.name, 'project');
    const bundleDir = path.join(path.resolve(folder), bundleName);

    await fs.mkdir(bundleDir, { recursive: true });

    let copied = 0;
    for (const file of files) {
      const destination = path.join(bundleDir, file.dest);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        // By storagePath, not by absolute source: the bytes may be on the shared
        // server, where a path from this machine means nothing.
        await copyAssetFileTo(file.storagePath, destination);
        copied += 1;
      } catch (copyErr) {
        console.warn(`Failed to copy export file ${file.storagePath}:`, copyErr.message);
      }
    }

    await fs.writeFile(path.join(bundleDir, `${bundleName}.3dgp`), JSON.stringify(manifest, null, 2), 'utf8');

    res.status(201).json({
      folder: bundleDir,
      name: bundleName,
      assetCount: manifest.assets.length,
      fileCount: copied
    });
  } catch (err) {
    console.error('Failed to export project:', err);
    const message = err.code === 'EACCES'
      ? 'Access to the destination folder is denied.'
      : (err.message || 'Failed to export project');
    res.status(err.message === 'Project not found' ? 404 : 500).json({ error: message });
  }
});

// The manifest plus the list of files to copy, with no bytes written anywhere.
// This is the half of an export that must happen where the data is: a
// remote-connected install asks its shared server for the plan, then writes the
// bundle to the user's own disk itself.
app.get('/api/projects/:id/export-plan', async (req, res) => {
  try {
    const appVersion = typeof req.query.appVersion === 'string' ? req.query.appVersion : '';
    const { manifest, files } = await buildProjectExport(Number(req.params.id), { appVersion });
    // `source` is deliberately dropped: it is an absolute path on this machine,
    // and the caller fetches the bytes over HTTP by storagePath instead.
    res.json({ manifest, files: files.map(({ storagePath, dest }) => ({ storagePath, dest })) });
  } catch (err) {
    if (err.message === 'Project not found') {
      return res.status(404).json({ error: 'Project not found' });
    }
    console.error('Failed to build the project export plan:', err);
    res.status(500).json({ error: err.message || 'Failed to build the project export plan' });
  }
});

// --- project import --------------------------------------------------------

// Where a bundle is staged before a shared server imports it.
// importProjectExport inserts rows AND copies files in one transaction, so it has
// to run where the database is — which means the bundle travels there first.
//
// Under data/incoming rather than ASSETS_DIR, so a half-staged bundle is never
// reachable through the /assets static mount.
const IMPORT_STAGING_ROOT = path.join(UPLOAD_STAGING_DIR, 'imports');

// Resolve a bundle-relative path inside one staging directory, or null if it
// would escape. The id is generated by the caller, so its shape is checked here
// rather than trusted.
function resolveImportStagingPath(stagingId, relativePath) {
  const id = String(stagingId || '');
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return null;
  const root = path.join(IMPORT_STAGING_ROOT, id);
  const target = path.resolve(root, String(relativePath || '.'));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return { root, target };
}

// stagingId and relPath are read from the QUERY STRING, not the body: multer's
// destination/filename callbacks run while the multipart stream is still being
// parsed, so a body field is not reliably populated yet. That race is exactly
// what once filed uploaded assets under the wrong type.
const importStagingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const resolved = resolveImportStagingPath(req.query.stagingId, req.query.relPath);
      if (!resolved) return cb(new Error('Invalid staging path'));
      const directory = path.dirname(resolved.target);
      fs.mkdir(directory, { recursive: true })
        .then(() => cb(null, directory))
        .catch(err => cb(err));
    },
    filename: (req, file, cb) => {
      const resolved = resolveImportStagingPath(req.query.stagingId, req.query.relPath);
      if (!resolved) return cb(new Error('Invalid staging path'));
      cb(null, path.basename(resolved.target));
    }
  })
});

app.post('/api/projects/import/files', (req, res) => {
  // Checked before multer runs, so a bad path never starts consuming the body.
  // multer reports a rejection from its own callbacks as a route error, which
  // Express turns into a 500 HTML page — wrong status, and it leaks a stack.
  if (!resolveImportStagingPath(req.query.stagingId, req.query.relPath)) {
    return res.status(400).json({ error: 'Invalid staging path.' });
  }

  importStagingUpload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Failed to stage an import bundle file:', err);
      return res.status(400).json({ error: err.message || 'Failed to stage the file' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A file part is required.' });
    }
    res.status(201).json({ relPath: String(req.query.relPath || ''), size: req.file.size });
  });
});

// Read the single .3dgp out of a bundle folder. Shared by the local-folder path
// and the staged-upload path so both reject the same malformed bundle with the
// same message.
async function readBundleManifest(bundleDir) {
  const stats = await fs.stat(bundleDir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw Object.assign(new Error('The selected path is not a folder.'), { status: 400 });
  }

  const entries = await fs.readdir(bundleDir);
  const manifestFiles = entries.filter(entry => entry.toLowerCase().endsWith('.3dgp'));
  if (manifestFiles.length === 0) {
    throw Object.assign(new Error('No .3dgp file was found in the selected folder.'), { status: 400 });
  }
  if (manifestFiles.length > 1) {
    throw Object.assign(new Error('The selected folder contains more than one .3dgp file.'), { status: 400 });
  }

  const manifestRaw = await fs.readFile(path.join(bundleDir, manifestFiles[0]), 'utf8');
  try {
    return { manifest: JSON.parse(manifestRaw), manifestFilename: manifestFiles[0] };
  } catch {
    throw Object.assign(new Error('The .3dgp file is not valid JSON.'), { status: 400 });
  }
}

// Import a project from a previously exported bundle folder (contains a .3dgp).
//
// Two request shapes, and only the first ever comes from a browser:
//   { folder }    — a path on the machine running this install. Never forwarded
//                   to a shared server (see serverMode.js), because the folder
//                   exists on the user's disk, not the container's.
//   { stagingId } — a bundle already uploaded to data/incoming/imports by a
//                   remote-connected install. This is what makes importing a
//                   local bundle land in the shared database.
app.post('/api/projects/import', async (req, res) => {
  const stagingId = typeof req.body?.stagingId === 'string' ? req.body.stagingId.trim() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

  if (stagingId) {
    const resolved = resolveImportStagingPath(stagingId, '.');
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid staging id.' });
    }
    try {
      const { manifest } = await readBundleManifest(resolved.root);
      res.status(201).json(await importProjectExport(manifest, resolved.root, { name }));
    } catch (err) {
      console.error('Failed to import a staged project bundle:', err);
      res.status(err.status || 500).json({ error: err.message || 'Failed to import project' });
    } finally {
      // Disposable either way: keeping it would leave a second full copy of the
      // project on the server's disk forever.
      await fs.rm(resolved.root, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  try {
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';

    if (!folder) {
      return res.status(400).json({ error: 'A source folder is required.' });
    }
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'The source folder must be an absolute path.' });
    }

    const bundleDir = path.resolve(folder);
    const { manifest, manifestFilename } = await readBundleManifest(bundleDir);

    // Locally this is importProjectExport as before; against a shared server it
    // uploads the bundle to a staging directory there and hands the import over.
    res.status(201).json(await importProject(
      { bundleDir, manifestFilename, name },
      () => importProjectExport(manifest, bundleDir, { name })
    ));
  } catch (err) {
    console.error('Failed to import project:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to import project' });
  }
});

app.get('/api/assets', async (req, res) => {
  const { projectId, includeChildren } = req.query;
  if (projectId && !(await requireProject(req, res, projectId))) return;
  // includeChildren returns every project-linked edit/version as a row of its
  // own, on top of the copies nested in each root's `children` array.
  res.json(await listProjectAssets(projectId ? Number(projectId) : null, {
    includeChildren: String(includeChildren || '').toLowerCase() === 'true',
    viewerId: scopeId(req)
  }));
});

app.get('/api/cards', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectCards(Number(projectId)));
  } catch (err) {
    console.error('Failed to list project cards:', err);
    res.status(500).json({ error: 'Failed to list project cards' });
  }
});

app.get('/api/graph/nodes', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectNodes(Number(projectId)));
  } catch (err) {
    console.error('Failed to list graph nodes:', err);
    res.status(500).json({ error: err.message || 'Failed to list graph nodes' });
  }
});

app.post('/api/graph/nodes', async (req, res) => {
  try {
    const { projectId, nodeTypeId, nodeTypeName, name, xPos, yPos, assetId, status, progress, metadata } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.status(201).json(await createProjectNode({
      projectId: Number(projectId),
      nodeTypeId: nodeTypeId ? Number(nodeTypeId) : null,
      nodeTypeName,
      name,
      xPos,
      yPos,
      assetId,
      status,
      progress,
      metadata
    }));
  } catch (err) {
    console.error('Failed to create graph node:', err);
    res.status(500).json({ error: err.message || 'Failed to create graph node' });
  }
});

app.put('/api/graph/nodes/:id/position', async (req, res) => {
  try {
    const { projectId, xPos, yPos } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await updateProjectNodePosition(Number(projectId), Number(req.params.id), { xPos, yPos }));
  } catch (err) {
    console.error('Failed to update graph node position:', err);
    res.status(500).json({ error: err.message || 'Failed to update graph node position' });
  }
});

app.put('/api/graph/nodes/:id', async (req, res) => {
  try {
    const { projectId, name, assetId, status, progress, metadata } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await updateProjectNode(Number(projectId), Number(req.params.id), {
      name,
      assetId,
      status,
      progress,
      metadata
    }));
  } catch (err) {
    console.error('Failed to update graph node:', err);
    res.status(500).json({ error: err.message || 'Failed to update graph node' });
  }
});

app.delete('/api/graph/nodes/:id', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    await deleteProjectNode(Number(projectId), Number(req.params.id));
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete graph node:', err);
    res.status(500).json({ error: err.message || 'Failed to delete graph node' });
  }
});

app.get('/api/graph/connections', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectConnections(Number(projectId)));
  } catch (err) {
    console.error('Failed to list graph connections:', err);
    res.status(500).json({ error: err.message || 'Failed to list graph connections' });
  }
});

app.post('/api/graph/connections', async (req, res) => {
  try {
    const { projectId, sourceNodeId, targetNodeId, inputId, outputId } = req.body;

    if (!projectId || !sourceNodeId || !targetNodeId) {
      return res.status(400).json({ error: 'projectId, sourceNodeId, and targetNodeId are required' });
    }

    res.status(201).json(await createProjectConnection(Number(projectId), {
      sourceNodeId,
      targetNodeId,
      inputId,
      outputId
    }));
  } catch (err) {
    console.error('Failed to create graph connection:', err);
    res.status(500).json({ error: err.message || 'Failed to create graph connection' });
  }
});

app.delete('/api/graph/connections', async (req, res) => {
  try {
    const { projectId, sourceNodeId, targetNodeId, inputId, outputId } = req.query;

    if (!projectId || !sourceNodeId || !targetNodeId) {
      return res.status(400).json({ error: 'projectId, sourceNodeId, and targetNodeId are required' });
    }

    const result = await deleteProjectConnection(Number(projectId), {
      sourceNodeId,
      targetNodeId,
      inputId,
      outputId
    });

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Connection not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete graph connection:', err);
    res.status(500).json({ error: err.message || 'Failed to delete graph connection' });
  }
});

// ---------------------------------------------------------------------------
// Batch Processing
// ---------------------------------------------------------------------------

app.put('/api/projects/:projectId/batch-cards/:cardKey/asset', async (req, res) => {
  try {
    const asset = await setCardAssetLink(
      Number(req.params.projectId),
      req.params.cardKey,
      Number(req.body?.assetId)
    );
    res.json(asset);
  } catch (err) {
    if (err.message === 'Card not found' || err.message === 'Asset not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Failed to link a batch result to its card:', err);
    res.status(500).json({ error: err.message || 'Failed to link the batch result' });
  }
});

app.get('/api/projects/:projectId/batch-config', async (req, res) => {
  try {
    res.json(await getProjectBatchConfig(Number(req.params.projectId)));
  } catch (err) {
    console.error('Failed to load batch config:', err);
    res.status(500).json({ error: err.message || 'Failed to load batch config' });
  }
});

app.put('/api/projects/:projectId/batch-config', async (req, res) => {
  try {
    res.json(await saveProjectBatchConfig(Number(req.params.projectId), req.body?.state ?? {}));
  } catch (err) {
    console.error('Failed to save batch config:', err);
    res.status(500).json({ error: err.message || 'Failed to save batch config' });
  }
});

// ---------------------------------------------------------------------------
// Brainstorming Boards
// ---------------------------------------------------------------------------

app.get('/api/boards', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectBoards(Number(projectId)));
  } catch (err) {
    console.error('Failed to list boards:', err);
    res.status(500).json({ error: err.message || 'Failed to list boards' });
  }
});

app.post('/api/boards', async (req, res) => {
  try {
    const { projectId, name } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.status(201).json(await createBoard({ projectId: Number(projectId), name }));
  } catch (err) {
    console.error('Failed to create board:', err);
    res.status(500).json({ error: err.message || 'Failed to create board' });
  }
});

app.get('/api/boards/:id', async (req, res) => {
  try {
    const board = await getBoardById(Number(req.params.id));

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    res.json(board);
  } catch (err) {
    console.error('Failed to get board:', err);
    res.status(500).json({ error: err.message || 'Failed to get board' });
  }
});

app.put('/api/boards/:id', async (req, res) => {
  try {
    const { name, state, position, thumbnailPath } = req.body;
    const board = await updateBoard(Number(req.params.id), { name, state, position, thumbnailPath });

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    res.json(board);
  } catch (err) {
    console.error('Failed to update board:', err);
    res.status(500).json({ error: err.message || 'Failed to update board' });
  }
});

app.delete('/api/boards/:id', async (req, res) => {
  try {
    const result = await deleteBoard(Number(req.params.id));

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Board not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete board:', err);
    res.status(500).json({ error: err.message || 'Failed to delete board' });
  }
});

app.get('/api/assets/library', async (req, res) => {
  try {
    const scope = scopeId(req);
    const [images, meshes, brushes] = await Promise.all([
      listLibraryAssetsByType('image', getRequestBaseUrl(req), scope),
      listLibraryAssetsByType('mesh', getRequestBaseUrl(req), scope),
      listLibraryAssetsByType('brush', getRequestBaseUrl(req), scope)
    ]);
    res.json({ images, meshes, brushes });
  } catch (err) {
    console.error('Failed to list asset library:', err);
    res.status(500).json({ error: 'Failed to list asset library' });
  }
});

app.delete('/api/assets/library', async (req, res) => {
  try {
    const { type, filename, force } = req.query;

    if (!type || !filename) {
      return res.status(400).json({ error: 'type and filename are required' });
    }

    // A library asset is addressed by stored path rather than id, so the id
    // middleware above cannot see it. This is also what stops the setup
    // wizard's overwrite -- which deletes by name before reinstalling -- from
    // clearing a teammate's workflow that shares a template name.
    if (!(await mayUseAssetByFilePath(String(type), String(filename), req))) {
      return res.status(403).json({ error: NOT_YOURS });
    }

    const result = await deleteLibraryAssetByFilePath(String(type), String(filename), {
      force: String(force || '').toLowerCase() === 'true'
    });

    if (result.status === 'linked') {
      return res.status(409).json({
        error: 'Asset is linked to a project',
        projectId: result.projectId,
        projectName: result.projectName || null
      });
    }

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete library asset:', err);
    res.status(500).json({ error: 'Failed to delete library asset' });
  }
});

app.put('/api/assets/library', async (req, res) => {
  try {
    const { type, filename, name } = req.body;

    if (!type || !filename || !name?.trim()) {
      return res.status(400).json({ error: 'type, filename and name are required' });
    }

    const storedFilePath = toStoredAssetPath(String(type), String(filename));
    const absoluteAssetPath = toAbsoluteStoragePath(storedFilePath);

    try {
      await fs.access(absoluteAssetPath);
    } catch {
      return res.status(404).json({ error: 'Selected asset file was not found' });
    }

    res.json(await renameLibraryAssetByFilePath(String(type), String(filename), String(name)));
  } catch (err) {
    console.error('Failed to rename library asset:', err);
    res.status(500).json({ error: err.message || 'Failed to rename library asset' });
  }
});

// The tag vocabulary in use, with counts. `type` scopes it to one asset type so
// the Images section is not offered tags only meshes carry.
app.get('/api/assets/tags', async (req, res) => {
  try {
    const { type } = req.query;
    res.json({ tags: await listAllAssetTags({ type: type ? String(type) : null, viewerId: scopeId(req) }) });
  } catch (err) {
    console.error('Failed to list asset tags:', err);
    res.status(500).json({ error: 'Failed to list asset tags' });
  }
});

app.get('/api/assets/:assetId/tags', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);

    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ error: 'A numeric assetId is required' });
    }

    res.json({ tags: await listAssetTags(assetId) });
  } catch (err) {
    console.error('Failed to load asset tags:', err);
    res.status(500).json({ error: 'Failed to load asset tags' });
  }
});

// Replace the asset's whole tag set. The editor sends the list it wants, so a
// single PUT covers add, remove and rename without three round trips.
app.put('/api/assets/:assetId/tags', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);

    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ error: 'A numeric assetId is required' });
    }

    const { tags } = req.body || {};

    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }

    const result = await setAssetTags(assetId, tags || []);

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json({ assetId: result.assetId, tags: result.tags });
  } catch (err) {
    console.error('Failed to save asset tags:', err);
    res.status(500).json({ error: 'Failed to save asset tags' });
  }
});

// Additive tag edits: add and/or remove without knowing (or clobbering) the
// tags an asset already carries. The UI PUTs whole sets; automation usually
// only knows the tags it wants to contribute or drop.
app.patch('/api/assets/:assetId/tags', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);

    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ error: 'A numeric assetId is required' });
    }

    const { add, remove } = req.body || {};

    if (add !== undefined && !Array.isArray(add)) {
      return res.status(400).json({ error: 'add must be an array of strings' });
    }

    if (remove !== undefined && !Array.isArray(remove)) {
      return res.status(400).json({ error: 'remove must be an array of strings' });
    }

    if (!Array.isArray(add) && !Array.isArray(remove)) {
      return res.status(400).json({ error: 'Pass add and/or remove' });
    }

    // Add first, so a call that both adds and removes the same tag ends up
    // without it — "remove" is the more explicit intent.
    if (Array.isArray(add) && add.length > 0) {
      const added = await addAssetTags(assetId, add);

      if (added.status === 'not-found') {
        return res.status(404).json({ error: 'Asset not found' });
      }
    } else if (!(await getAssetRecordById(assetId))) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    for (const tag of Array.isArray(remove) ? remove : []) {
      await removeAssetTag(assetId, tag);
    }

    res.json({ assetId, tags: await listAssetTags(assetId) });
  } catch (err) {
    console.error('Failed to update asset tags:', err);
    res.status(500).json({ error: 'Failed to update asset tags' });
  }
});

// Tag search across the whole library (root assets, edits and versions alike).
// `tags` is comma-separated; matchAll=false turns the AND into an OR.
app.get('/api/assets/by-tags', async (req, res) => {
  try {
    const { tags, matchAll, type, projectId, limit } = req.query;

    const wantedTags = Array.isArray(tags)
      ? tags
      : String(tags || '').split(',');

    if (wantedTags.filter(tag => String(tag).trim()).length === 0) {
      return res.status(400).json({ error: 'At least one tag is required' });
    }

    const assets = await findAssetsByTags(wantedTags, {
      matchAll: String(matchAll ?? 'true') !== 'false',
      type: type ? String(type) : null,
      projectId: projectId !== undefined && projectId !== '' ? Number(projectId) : null,
      limit: limit !== undefined ? Number(limit) : 200,
      viewerId: scopeId(req)
    });

    res.json({ assets });
  } catch (err) {
    console.error('Failed to search assets by tag:', err);
    res.status(500).json({ error: 'Failed to search assets by tag' });
  }
});

app.post('/api/assets/library/import', libraryImportUpload.any(), async (req, res) => {
  try {
    const multipartFiles = req.files || [];
    const files = multipartFiles.filter(file => file.fieldname === 'files');
    const thumbnailsByIndex = new Map(
      multipartFiles
        .filter(file => file.fieldname.startsWith('thumbnail:'))
        .map(file => [Number(file.fieldname.split(':')[1]), file])
    );

    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const imported = [];
    const skipped = [];

    const overrideAssetType = (() => {
      const requested = String(req.query?.assetType || req.body?.assetType || '').toLowerCase();
      return ['image', 'mesh', 'brush'].includes(requested) ? requested : null;
    })();

    await Promise.all(files.map(async (file, index) => {
      let assetType = overrideAssetType;
      if (!assetType) {
        assetType = inferSupportedAssetTypeFromFilename(file.originalname);
      } else if (assetType === 'brush') {
        // Brushes must be PNG images
        const extension = path.extname(file.originalname).toLowerCase();
        if (extension !== '.png') {
          skipped.push({ name: file.originalname, reason: 'Brushes must be PNG files' });
          return;
        }
      }

      if (!assetType) {
        skipped.push({
          name: file.originalname,
          reason: 'Unsupported asset type'
        });
        return;
      }

      const destinationDir = getAssetDirectory(assetType);
      const filename = createLibraryImportFilename(file.originalname);
      const storedFilePath = toStoredAssetPath(assetType, filename);
      const thumbnailFile = thumbnailsByIndex.get(index);
      let thumbnailPath = null;
      const dimensions = (assetType === 'image' || assetType === 'brush')
        ? getImageDimensionsFromBuffer(file.buffer, { filename: file.originalname, mimeType: file.mimetype })
        : { width: 0, height: 0 };

      await fs.mkdir(destinationDir, { recursive: true });
      await fs.writeFile(path.join(destinationDir, filename), file.buffer);

      if (thumbnailFile) {
        const thumbnailFilename = createLibraryThumbnailFilename(file.originalname);
        thumbnailPath = toStoredThumbnailPath(thumbnailFilename);
        await fs.mkdir(THUMBNAIL_ASSETS_DIR, { recursive: true });
        await fs.writeFile(path.join(THUMBNAIL_ASSETS_DIR, thumbnailFilename), thumbnailFile.buffer);
      }

      const createdAsset = await createLibraryAsset({
        name: file.originalname,
        type: assetType,
        filePath: storedFilePath,
        thumbnailPath,
        width: dimensions.width,
        height: dimensions.height,
        metadata: {
          resolution: (assetType === 'image' || assetType === 'brush') ? formatImageResolution(dimensions.width, dimensions.height) : 'Unknown',
          source: 'LIBRARY IMPORT'
        },
        createdAt: Date.now(),
        ownerId: viewerId(req)
      });

      imported.push({
        id: createdAsset?.id ?? null,
        name: file.originalname,
        filename,
        type: assetType,
        thumbnailPath
      });
    }));

    if (imported.length === 0) {
      return res.status(400).json({
        error: 'No supported assets were imported',
        imported,
        skipped
      });
    }

    res.status(201).json({ imported, skipped });
  } catch (err) {
    console.error('Failed to import library assets:', err);
    res.status(500).json({ error: 'Failed to import library assets' });
  }
});

// -------------------------------------------------------------------------
// Brush child assets — import additional brush PNGs as children of a parent brush
// -------------------------------------------------------------------------

app.post('/api/assets/library/brush-edits', libraryImportUpload.any(), async (req, res) => {
  try {
    const parentId = parseInt(String(req.body?.parentId || ''), 10);
    if (!parentId || isNaN(parentId)) {
      return res.status(400).json({ error: 'parentId is required and must be a valid asset id' });
    }
    // Multipart body -- see requireAssetAccess.
    if (!(await requireAssetAccess(req, res, parentId))) return;

    const files = (req.files || []).filter(f => f.fieldname === 'files');
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const imported = [];
    const skipped = [];

    await Promise.all(files.map(async (file) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (extension !== '.png') {
        skipped.push({ name: file.originalname, reason: 'Brush edits must be PNG files' });
        return;
      }

      const storedFilePath = getBrushChildStoredFilePath(parentId, 'png');
      const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);
      const filename = toAssetUrlPath(storedFilePath);
      const dimensions = getImageDimensionsFromBuffer(file.buffer, { filename: file.originalname, mimeType: file.mimetype });

      await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
      await fs.writeFile(absoluteFilePath, file.buffer);

      const childRecord = await createBrushChildRecord({
        parentAssetId: parentId,
        name: file.originalname.replace(/\.png$/i, ''),
        filePath: storedFilePath,
        width: dimensions.width,
        height: dimensions.height,
        createdAt: Date.now()
      });

      imported.push({
        id: childRecord.id,
        name: childRecord.name,
        filename,
        parentId: childRecord.parentId
      });
    }));

    if (imported.length === 0 && skipped.length > 0) {
      return res.status(400).json({
        error: 'No brush edits were imported',
        imported,
        skipped
      });
    }

    res.status(201).json({ imported, skipped });
  } catch (err) {
    console.error('Failed to import brush edits:', err);
    res.status(500).json({ error: err.message || 'Failed to import brush edits' });
  }
});

// -------------------------------------------------------------------------
// Paint documents — sidecar layer data for painted meshes
// -------------------------------------------------------------------------

function buildPaintDocumentResponse(doc, assetId, baseUrl) {
  if (!doc) return null;
  const baseTextureUrl = doc.baseFilePath
    ? `${baseUrl}/assets/${encodeURI(doc.baseFilePath.replace(/^data\/assets\//, ''))}`
    : null;
  return {
    assetId,
    textureWidth: doc.textureWidth,
    textureHeight: doc.textureHeight,
    base: doc.baseFilePath ? { filePath: doc.baseFilePath, url: baseTextureUrl } : null,
    layers: (doc.layers || []).map(layer => ({
      ...layer,
      url: layer.filePath
        ? `${baseUrl}/assets/${encodeURI(layer.filePath.replace(/^data\/assets\//, ''))}`
        : null
    })),
    updatedAt: doc.updatedAt
  };
}

app.get('/api/assets/:assetId/paint-document', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid assetId' });
    }

    const doc = await getPaintDocumentByAssetId(assetId);
    if (!doc) {
      return res.status(404).json({ error: 'Paint document not found' });
    }

    res.json(buildPaintDocumentResponse(doc, assetId, getRequestBaseUrl(req)));
  } catch (err) {
    console.error('Failed to load paint document:', err);
    res.status(500).json({ error: err.message || 'Failed to load paint document' });
  }
});

app.put('/api/assets/:assetId/paint-document', paintDocumentUpload.any(), async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid assetId' });
    }

    const asset = await getAssetRecordById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    let metadata;
    try {
      metadata = JSON.parse(req.body?.metadata || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid metadata JSON' });
    }

    const textureWidth = Number(metadata.textureWidth) || 0;
    const textureHeight = Number(metadata.textureHeight) || 0;
    const incomingLayers = Array.isArray(metadata.layers) ? metadata.layers : [];

    const multipartFiles = req.files || [];
    const baseFile = multipartFiles.find(file => file.fieldname === 'base') || null;
    const layerFilesById = new Map(
      multipartFiles
        .filter(file => file.fieldname.startsWith('layer:'))
        .map(file => [file.fieldname.slice('layer:'.length), file])
    );

    const docDir = getPaintDocSubdir(assetId);
    await fs.mkdir(docDir, { recursive: true });

    // Existing record (so we can keep file paths for layers that weren't re-uploaded).
    const existing = await getPaintDocumentByAssetId(assetId);
    const existingLayerByFile = new Map();
    (existing?.layers || []).forEach(layer => {
      if (layer.filePath) existingLayerByFile.set(layer.id, layer.filePath);
    });

    // Write base texture if provided.
    let baseFilePath = existing?.baseFilePath || null;
    if (baseFile) {
      const baseFilename = 'base.png';
      await fs.writeFile(path.join(docDir, baseFilename), baseFile.buffer);
      baseFilePath = toStoredPaintDocPath(assetId, baseFilename);
    }

    // Write each layer file (if uploaded), then build the persisted layer list.
    const persistedLayers = [];
    const keptFilenames = new Set();
    if (baseFilePath) keptFilenames.add(path.basename(baseFilePath));

    for (const layer of incomingLayers) {
      if (!layer || typeof layer.id !== 'string') continue;
      const safeId = layer.id.replace(/[^a-zA-Z0-9._-]/g, '_');
      let filePath = existingLayerByFile.get(layer.id) || null;
      const file = layerFilesById.get(layer.id);

      if (file) {
        const filename = `${safeId}.png`;
        await fs.writeFile(path.join(docDir, filename), file.buffer);
        filePath = toStoredPaintDocPath(assetId, filename);
      }

      if (!filePath) continue; // no file for this layer — skip

      keptFilenames.add(path.basename(filePath));
      persistedLayers.push({
        id: layer.id,
        name: typeof layer.name === 'string' ? layer.name : '',
        opacity: Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1,
        blendMode: typeof layer.blendMode === 'string' ? layer.blendMode : 'source-over',
        color: typeof layer.color === 'string' ? layer.color : '#ffffff',
        visible: layer.visible !== false,
        filePath
      });
    }

    // Clean up orphan files (layers that were removed by the client).
    try {
      const entries = await fs.readdir(docDir);
      await Promise.all(entries.map(async name => {
        if (keptFilenames.has(name)) return;
        try {
          await fs.unlink(path.join(docDir, name));
        } catch (cleanupErr) {
          if (cleanupErr?.code !== 'ENOENT') {
            console.warn(`Failed to remove orphan paint file ${name}:`, cleanupErr);
          }
        }
      }));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn('Failed to inspect paint document dir for cleanup:', err);
      }
    }

    const saved = await upsertPaintDocument({
      assetId,
      baseFilePath,
      textureWidth,
      textureHeight,
      layers: persistedLayers
    });

    res.status(200).json(buildPaintDocumentResponse(saved, assetId, getRequestBaseUrl(req)));
  } catch (err) {
    console.error('Failed to save paint document:', err);
    res.status(500).json({ error: err.message || 'Failed to save paint document' });
  }
});

app.post('/api/assets/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    // Safe to read req.body.type now: multer has parsed the whole body, so the
    // type no longer depends on the order the client sent its fields in.
    // Checked here rather than in the middleware: projectId arrives as a
    // multipart field, which is only parsed once multer has run.
    if (!(await requireProjectAccess(req, res, req.body.projectId))) return;

    const assetType = req.body.type || inferAssetTypeFromFilename(req.file.originalname);
    await commitStagedUpload(req.file, assetType);
    const inputMetadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
    const dimensions = assetType === 'image'
      ? getImageDimensionsFromBuffer(await fs.readFile(req.file.path), { filename: req.file.originalname, mimeType: req.file.mimetype })
      : { width: 0, height: 0 };
    const newAsset = await createProjectAsset({
      projectId: Number(req.body.projectId),
      ownerId: viewerId(req),
      type: assetType,
      name: req.body.name || req.file.originalname,
      filePath: toStoredAssetPath(assetType, req.file.filename),
      width: dimensions.width,
      height: dimensions.height,
      metadata: {
        ...inputMetadata,
        resolution: assetType === 'image'
          ? formatImageResolution(dimensions.width, dimensions.height)
          : (inputMetadata.resolution || 'Unknown')
      },
      createdAt: Date.now()
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Upload recording failed:', err);
    // No database row will reference these bytes, so don't leave them behind
    // (whether still staged or already moved into the asset directory).
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    if (err.message?.startsWith('Project not found:')) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (err.message === 'A valid projectId is required') {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: 'Upload recording failed' });
  }
});

app.post('/api/assets/:id/thumbnail', thumbnailUpload.single('thumbnail'), async (req, res) => {
  try {
    const assetId = Number(req.params.id);

    if (!assetId) {
      return res.status(400).json({ error: 'A valid asset id is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No thumbnail provided' });
    }

    const thumbnailFilename = createLibraryThumbnailFilename(req.file.originalname || `asset-${assetId}.png`);
    const thumbnailPath = toStoredThumbnailPath(thumbnailFilename);
    const absoluteThumbnailPath = toAbsoluteStoragePath(thumbnailPath);

    await fs.mkdir(path.dirname(absoluteThumbnailPath), { recursive: true });
    await fs.writeFile(absoluteThumbnailPath, req.file.buffer);

    const updatedAsset = await updateAssetThumbnail(assetId, thumbnailPath);

    if (!updatedAsset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(updatedAsset);
  } catch (err) {
    console.error('Failed to upload asset thumbnail:', err);
    res.status(500).json({ error: 'Failed to upload asset thumbnail' });
  }
});


// Asset metadata lookups a remote-connected install needs. Its compute routes
// run locally but the records live on the shared server, so the same resolvers
// have to be reachable over HTTP. Both are plain reads under /api/assets, which
// the gateway already forwards.
app.get('/api/assets/record', async (req, res) => {
  try {
    const { assetId, type = 'mesh', filePath } = req.query;
    const numericAssetId = Number(assetId);

    const record = (Number.isFinite(numericAssetId) && numericAssetId > 0)
      ? await getAssetRecordById(numericAssetId)
      : (filePath ? await findAssetByFilePath(String(type), String(filePath)) : null);

    if (!record) return res.status(404).json({ error: 'Asset not found' });
    // Addressed by query rather than path, so the id middleware never saw it.
    if (!mayUse(await getAssetOwnerId(Number(record.id)), req)) {
      return res.status(403).json({ error: NOT_YOURS });
    }
    res.json(record);
  } catch (err) {
    console.error('Failed to read the asset record:', err);
    res.status(500).json({ error: err.message || 'Failed to read the asset record' });
  }
});

// Mirrors resolveProjectMeshSource / resolveProjectImageSource, which accept an
// "asset:<id>", "edit:<path>" or bare-id reference.
app.get('/api/assets/project-source', async (req, res) => {
  try {
    const { projectId, type = 'image', reference } = req.query;
    if (!projectId || reference === undefined) {
      return res.status(400).json({ error: 'projectId and reference are required' });
    }

    // Calls storage directly on purpose: this endpoint IS the authority a
    // remote-connected install asks. Routing it back through dataStore would be
    // circular the moment a server were itself pointed at another one.
    const resolved = String(type).toLowerCase() === 'mesh'
      ? await resolveProjectMeshSource(Number(projectId), reference)
      : await resolveProjectImageSource(Number(projectId), reference);

    if (!resolved) return res.status(404).json({ error: 'Source asset not found' });
    res.json(resolved);
  } catch (err) {
    console.error('Failed to resolve the project source asset:', err);
    res.status(500).json({ error: err.message || 'Failed to resolve the project source asset' });
  }
});
// ---------------------------------------------------------------------------
// Asset ingest (multi-user server mode)
//
// A local install does its GPU work itself, then has to land the result in the
// shared database. It cannot call storage.js across the network, and it must
// not reimplement it either: createAssetVersion() resolves the source asset,
// walks to the root, inherits project links on both, and reads back a composed
// view. That logic has to run where the data lives, so it is exposed here and
// the gateway forwards to it (see dataStore.js).
//
// Bodies are staged to disk rather than buffered: a textured mesh version can
// be hundreds of megabytes.
// ---------------------------------------------------------------------------
const assetIngestUpload = multer({ storage }).fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

// Move a staged thumbnail into the thumbnails directory. Returns the stored
// filename, which is what the storage layer expects for thumbnailPath.
async function commitStagedThumbnail(file, baseName) {
  const thumbnailFilename = createLibraryThumbnailFilename(baseName || file.originalname || 'asset.png');
  const absolute = toAbsoluteStoragePath(toStoredThumbnailPath(thumbnailFilename));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.rename(file.path, absolute);
  return thumbnailFilename;
}

// Shared prologue: validate, move the staged files into place, and hand back the
// payload plus the stored paths.
async function prepareIngest(req, { requireFile = true } = {}) {
  const assetId = Number(req.params.id);
  if (!assetId) throw Object.assign(new Error('A valid asset id is required'), { status: 400 });

  const file = req.files?.file?.[0] || null;
  if (requireFile && !file) throw Object.assign(new Error('No file provided'), { status: 400 });

  let payload = {};
  if (req.body?.payload) {
    try {
      payload = JSON.parse(req.body.payload);
    } catch {
      throw Object.assign(new Error('payload must be valid JSON'), { status: 400 });
    }
  }

  const type = String(payload.type || inferAssetTypeFromFilename(file?.originalname || '') || 'image');

  // Callers may dictate the layout. Image edits in particular live under
  // images/<source>/<editId>/, and deleting or renaming one looks the record up
  // by that path — so a flat filename here would quietly break those.
  const storedFilePath = file
    ? toStoredAssetPath(type, payload.relativePath || file.filename)
    : null;

  if (file) {
    const absolutePath = toAbsoluteStoragePath(storedFilePath);
    const assetsRoot = toAbsoluteStoragePath('data/assets');
    if (!path.resolve(absolutePath).startsWith(path.resolve(assetsRoot) + path.sep)) {
      throw Object.assign(new Error('relativePath must stay inside the asset directory'), { status: 400 });
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.rename(file.path, absolutePath);
    file.path = absolutePath;
  }

  const thumbnailFile = req.files?.thumbnail?.[0] || null;
  const thumbnailPath = thumbnailFile
    ? await commitStagedThumbnail(thumbnailFile, payload.name)
    : null;

  return { assetId, payload, type, storedFilePath, thumbnailPath };
}

// Discard bytes whose database row never got written.
async function discardIngestFiles(req) {
  for (const file of [...(req.files?.file || []), ...(req.files?.thumbnail || [])]) {
    if (file?.path) await fs.unlink(file.path).catch(() => {});
  }
}

function ingestFailed(res, err, what) {
  console.error(`Failed to ${what}:`, err);
  res.status(err.status || 500).json({ error: err.message || `Failed to ${what}` });
}

// Save bytes as a new VERSION of an existing asset (mesh pipeline results).
app.post('/api/assets/:id/versions', assetIngestUpload, async (req, res) => {
  try {
    const { assetId, payload, type, storedFilePath, thumbnailPath } = await prepareIngest(req);
    res.status(201).json(await createAssetVersion({
      assetId,
      type,
      name: payload.name,
      filePath: storedFilePath,
      thumbnailPath,
      width: payload.width,
      height: payload.height,
      metadata: payload.metadata || {},
      createdAt: payload.createdAt || Date.now(),
      // Default false: an ingest carries its own thumbnail or none, and silently
      // inheriting the source's would mislabel a freshly generated result.
      inheritThumbnail: payload.inheritThumbnail === true,
      projectId: payload.projectId ?? null
    }));
  } catch (err) {
    await discardIngestFiles(req);
    ingestFailed(res, err, 'save the asset version');
  }
});

// Save bytes as a new EDIT of an existing image asset.
app.post('/api/assets/:id/edits', assetIngestUpload, async (req, res) => {
  try {
    const { assetId, payload, storedFilePath, thumbnailPath } = await prepareIngest(req);
    const saved = await createAssetEditRecord({
      assetId,
      editId: payload.editId || randomUUID(),
      name: payload.name || '',
      filePath: storedFilePath,
      width: payload.width,
      height: payload.height,
      createdAt: payload.createdAt || Date.now(),
      projectId: payload.projectId ?? null
    });
    // createAssetEditRecord has no thumbnail argument, so apply one separately.
    res.status(201).json(thumbnailPath && saved?.id
      ? await updateAssetThumbnail(saved.id, thumbnailPath)
      : saved);
  } catch (err) {
    await discardIngestFiles(req);
    ingestFailed(res, err, 'save the asset edit');
  }
});

// Replace an existing asset's file in place (keeps its id and links).
app.post('/api/assets/:id/replace', assetIngestUpload, async (req, res) => {
  try {
    const { assetId, payload, type, storedFilePath, thumbnailPath } = await prepareIngest(req);
    const saved = await replaceAssetFileById(assetId, {
      name: payload.name,
      type,
      filePath: storedFilePath,
      thumbnailPath,
      width: payload.width,
      height: payload.height,
      metadata: payload.metadata || {}
    });
    if (!saved) return res.status(404).json({ error: 'Asset not found' });
    res.json(saved);
  } catch (err) {
    await discardIngestFiles(req);
    ingestFailed(res, err, 'replace the asset file');
  }
});

// Card processing snapshots. These are what make the UI still show "processing"
// after a reload, so a local install running a job has to write them to the
// shared database rather than its own.
app.put('/api/cards/:cardKey/processing', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const cardKey = String(req.params.cardKey || '');
    const projectId = Number(req.body?.projectId);
    if (!cardKey || !projectId) {
      return res.status(400).json({ error: 'projectId and a card key are required' });
    }

    if (req.body?.clear === true) {
      return res.json(await clearCardProcessingState(projectId, cardKey, {
        name: req.body?.name,
        keepCard: req.body?.keepCard
      }));
    }

    res.json(await setCardProcessingState(projectId, cardKey, req.body?.state || {}));
  } catch (err) {
    ingestFailed(res, err, 'update the card processing state');
  }
});

// Bone mappings arrive as a JSON string in the multipart body (the editor holds
// one per animation source: { [sourceKey]: { [targetBone]: sourceBone } }).
// Anything malformed is dropped rather than rejected: it is a convenience the
// mesh carries, and losing a save over it would be absurd. The size ceiling is
// the same reasoning — a mapping is a few kB, and asset metadata is read on
// every library listing.
const MAX_BONE_MAPPINGS_BYTES = 256 * 1024;

function parseBoneMappings(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.length > MAX_BONE_MAPPINGS_BYTES) {
    console.warn('Ignoring an oversized bone-mapping payload on a mesh save.');
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const cleaned = {};
    for (const [sourceKey, mapping] of Object.entries(parsed)) {
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) continue;
      const pairs = {};
      for (const [targetBone, sourceBone] of Object.entries(mapping)) {
        if (typeof sourceBone === 'string' && sourceBone) pairs[targetBone] = sourceBone;
      }
      if (Object.keys(pairs).length) cleaned[sourceKey] = pairs;
    }
    return Object.keys(cleaned).length ? cleaned : null;
  } catch {
    console.warn('Ignoring an unparseable bone-mapping payload on a mesh save.');
    return null;
  }
}

app.post('/api/meshes/editor/save', meshEditorSaveUpload.single('meshFile'), async (req, res) => {
  try {
    const { assetId, filePath, name, saveMode = 'replace', boneMappings } = req.body || {};
    const meshFile = req.file;

    if (!meshFile?.buffer?.length) {
      return res.status(400).json({ error: 'meshFile is required' });
    }

    if (!assetId && !filePath) {
      return res.status(400).json({ error: 'assetId or filePath is required' });
    }

    if (!['replace', 'version'].includes(saveMode)) {
      return res.status(400).json({ error: 'saveMode must be replace or version' });
    }

    const sourceAsset = await resolveEditableMeshAsset({ assetId, filePath });

    if (!sourceAsset) {
      return res.status(404).json({ error: 'Mesh asset not found' });
    }

    if (String(sourceAsset.assetTypeName || '').toLowerCase() !== 'mesh') {
      return res.status(400).json({ error: 'Selected asset is not a mesh' });
    }

    const nextName = sanitizeDisplayName(name || sourceAsset.name, sourceAsset.name || 'Mesh');
    const sourceExtension = path.extname(String(sourceAsset.filePath || '')).toLowerCase();
    const storedMeshPath = saveMode === 'version'
      ? toStoredAssetPath('mesh', createMeshEditorFilePath(nextName))
      : (sourceExtension === '.glb'
          ? toStoredAssetPath('mesh', sourceAsset.filePath)
          : toStoredAssetPath('mesh', createMeshEditorFilePath(nextName)));
    const metadata = {
      ...JSON.parse(sourceAsset.metadata || '{}'),
      source: 'MESH EDITOR',
      editedAt: Date.now(),
      savedFromAssetId: sourceAsset.id,
      saveMode
    };

    // Bone mappings ride along with the mesh so the next session can retarget
    // animations onto it without redoing the mapping by hand. Absent means "the
    // editor had nothing to say", not "clear them": the spread above already
    // carried the stored ones onto this save, which is what keeps a mapping
    // alive across a save made from a mode that never touched the rig.
    const parsedBoneMappings = parseBoneMappings(boneMappings);
    if (parsedBoneMappings) metadata.boneMappings = parsedBoneMappings;

    // The path above is deliberate — a .glb "replace" overwrites the source in
    // place — so it is passed through rather than letting dataStore invent one.
    const ingest = {
      name: nextName,
      type: 'mesh',
      bytes: meshFile.buffer,
      extension: 'glb',
      relativePath: toAssetUrlPath(storedMeshPath),
      width: 0,
      height: 0,
      metadata
    };

    const savedAsset = saveMode === 'version'
      ? await saveAssetVersion({ ...ingest, parentAssetId: sourceAsset.id, createdAt: Date.now() })
      : await replaceAssetFile({ ...ingest, assetId: sourceAsset.id });

    // Only meaningful for a local store: when connected to a shared server the
    // superseded file lives there, and a rename-extension replace leaves it
    // behind as an orphan (wasted disk, never wrong data).
    if (saveMode === 'replace' && !isGatewayActive() && sourceAsset.filePath && sourceAsset.filePath !== storedMeshPath) {
      await fs.rm(toAbsoluteStoragePath(sourceAsset.filePath), { force: true }).catch(() => null);
    }

    res.status(saveMode === 'version' ? 201 : 200).json(savedAsset);
  } catch (err) {
    console.error('Failed to save mesh editor result:', err);
    res.status(500).json({ error: err.message || 'Failed to save mesh editor result' });
  }
});

// Enumerate available Windows drive roots (C:\, D:\, ...) by probing letters.
async function listWindowsDriveRoots() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      await fs.access(root);
      drives.push(root);
    } catch {
      // Drive letter not mounted; skip it.
    }
  }
  return drives;
}

function isWindowsDriveRoot(targetPath) {
  return /^[A-Za-z]:[\\/]?$/.test(targetPath);
}

// Browse directories on the host so the export dialog can pick an output
// folder. With no `path`, returns the drive list on Windows (or `/` elsewhere).
app.get('/api/filesystem/folders', async (req, res) => {
  try {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const isWindows = process.platform === 'win32';
    const home = os.homedir();
    const drives = isWindows ? await listWindowsDriveRoots() : [];

    // Empty path on Windows => show the list of drives as the top level.
    if (!requestedPath && isWindows) {
      return res.json({
        path: '',
        parent: null,
        separator: path.sep,
        home,
        drives,
        entries: drives.map(drive => ({ name: drive, path: drive, isDirectory: true }))
      });
    }

    const resolvedPath = path.resolve(requestedPath || (isWindows ? home : '/'));
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'The selected path is not a folder.' });
    }

    const dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const entries = dirEntries
      .filter(entry => {
        try {
          return entry.isDirectory();
        } catch {
          return false;
        }
      })
      .map(entry => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
        isDirectory: true
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Up from a drive root returns to the drive list on Windows; otherwise the
    // parent directory, or null when already at the filesystem root.
    let parent = path.dirname(resolvedPath);
    if (isWindows && isWindowsDriveRoot(resolvedPath)) {
      parent = '';
    } else if (parent === resolvedPath) {
      parent = null;
    }

    res.json({
      path: resolvedPath,
      parent,
      separator: path.sep,
      home,
      drives,
      entries
    });
  } catch (err) {
    console.error('Failed to browse folders:', err);
    const message = err.code === 'EACCES'
      ? 'Access to this folder is denied.'
      : err.code === 'ENOENT'
        ? 'That folder does not exist.'
        : (err.message || 'Failed to browse folders');
    res.status(400).json({ error: message });
  }
});

// Write exported mesh files (mesh + companions) into a user-chosen folder.
// --- Python mesh-tools proxy (Auto UV / Auto Retopo) -------------------------
// The browser uploads a mesh to one of these routes; Node forwards it to the
// configurable Python service (Settings > Mesh Tools) and streams back its
// Server-Sent Events (progress events + a terminal `done` event carrying the
// mesh_b64/stats/preview_b64). Mirrors how the ComfyUI integration proxies
// external compute.
const meshToolsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

async function proxyMeshTool(operationPath, req, res, { baseUrlBuilder = buildMeshToolsBaseUrl, serviceLabel = 'Mesh Tools' } = {}) {
  const meshFile = req.file;
  if (!meshFile?.buffer?.length) {
    return res.status(400).json({ error: 'meshFile is required' });
  }

  const settings = await getSettings();
  const baseUrl = baseUrlBuilder(settings);

  const form = new FormData();
  form.append(
    'meshFile',
    new Blob([meshFile.buffer], { type: meshFile.mimetype || 'model/gltf-binary' }),
    meshFile.originalname || 'mesh.glb',
  );
  if (typeof req.body?.options === 'string' && req.body.options.length) {
    form.append('options', req.body.options);
  }
  if (typeof req.body?.format === 'string' && req.body.format.length) {
    form.append('format', req.body.format);
  }

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}${operationPath}`, { method: 'POST', body: form });
  } catch (err) {
    console.error(`Mesh tool proxy (${operationPath}) could not reach the Python service:`, err);
    return res.status(502).json({
      error: `Could not reach the ${serviceLabel} (Python) service at ${baseUrl}. `
        + `Is it running? (The rigging service can take a while to start on first launch while the model loads.)`,
    });
  }

  if (!upstream.ok) {
    // Pre-stream failures (bad options, mesh load) come back as JSON.
    const detail = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({
      error: `Mesh tool failed (${upstream.status})`,
      detail: detail.slice(0, 2000),
    });
  }

  return pipeToolSse(operationPath, upstream, res);
}

// Stream a Python service's Server-Sent Events straight through to the browser.
// Shared by proxyMeshTool and proxyMotionTool — the upstream error handling below
// is load-bearing, so it lives in one place rather than being copied per service.
function pipeToolSse(operationPath, upstream, res) {
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!upstream.body) {
    res.end();
    return undefined;
  }

  // Stream the upstream SSE to the browser. An aborted/failed upstream (e.g. the
  // Python service dies, or undici's fetch body timeout fires on a long silent
  // stage) makes this Readable emit 'error'. `.pipe()` does NOT forward source
  // errors, so without this handler the unhandled 'error' would crash the whole
  // Node process — taking every other endpoint (footer /system/stats, etc.) with
  // it. Handle it: log, send a terminal SSE error so the browser stops waiting,
  // and close cleanly.
  const source = Readable.fromWeb(upstream.body);
  source.on('error', err => {
    console.error(`Mesh tool proxy (${operationPath}) upstream stream error:`, err);
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', detail: 'The mesh service connection was lost.' })}\n\n`);
      } catch { /* response already gone */ }
      res.end();
    }
  });
  // If the browser hangs up, stop reading the upstream.
  res.on('close', () => { if (!source.destroyed) source.destroy(); });
  return source.pipe(res);
}

// Forwards a JSON body (not a mesh upload) to the motion service and streams its
// SSE back. Text-to-motion has no input file — the prompt IS the input — so it
// cannot go through proxyMeshTool, which requires req.file.
async function proxyMotionTool(operationPath, req, res, { serviceLabel = 'Motion Generation' } = {}) {
  const settings = await getSettings();
  const baseUrl = buildMotionToolsBaseUrl(settings);

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}${operationPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
  } catch (err) {
    console.error(`Motion proxy (${operationPath}) could not reach the Python service:`, err);
    return res.status(502).json({
      error: `Could not reach the ${serviceLabel} (Python) service at ${baseUrl}. `
        + 'Is it running? (First launch is slow — it loads the model and may download the text encoder.)',
    });
  }

  if (!upstream.ok) {
    // Validation failures (empty prompt, too many segments) arrive as JSON.
    const detail = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({
      error: `Motion generation failed (${upstream.status})`,
      detail: detail.slice(0, 2000),
    });
  }

  return pipeToolSse(operationPath, upstream, res);
}

// Same forwarding as proxyMeshTool, for the mesh-tools endpoints that answer with
// a single JSON body instead of an SSE stream (/meshes/inspect, /meshes/thumbnail).
// Those produce no mesh and finish in seconds, so there is nothing to stream.
async function proxyMeshToolJson(operationPath, req, res, { baseUrlBuilder = buildMeshToolsBaseUrl, serviceLabel = 'Mesh Tools' } = {}) {
  const meshFile = req.file;
  if (!meshFile?.buffer?.length) {
    return res.status(400).json({ error: 'meshFile is required' });
  }

  const settings = await getSettings();
  const baseUrl = baseUrlBuilder(settings);

  const form = new FormData();
  form.append(
    'meshFile',
    new Blob([meshFile.buffer], { type: meshFile.mimetype || 'model/gltf-binary' }),
    meshFile.originalname || 'mesh.glb',
  );
  if (typeof req.body?.options === 'string' && req.body.options.length) {
    form.append('options', req.body.options);
  }

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}${operationPath}`, { method: 'POST', body: form });
  } catch (err) {
    console.error(`Mesh tool proxy (${operationPath}) could not reach the Python service:`, err);
    return res.status(502).json({
      error: `Could not reach the ${serviceLabel} (Python) service at ${baseUrl}. Is it running?`,
    });
  }

  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) {
    return res.status(upstream.status).json({
      error: `Mesh tool failed (${upstream.status})`,
      detail: text.slice(0, 2000),
    });
  }

  try {
    return res.json(JSON.parse(text));
  } catch {
    return res.status(502).json({ error: 'The mesh service returned a malformed response.' });
  }
}

app.post('/api/meshes/auto-uv', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/auto-uv', req, res);
  } catch (err) {
    console.error('Auto UV proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Auto UV failed' });
  }
});

// Game-Ready check — read-only analysis, returns a JSON report (no mesh).
app.post('/api/meshes/inspect', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshToolJson('/meshes/inspect', req, res);
  } catch (err) {
    console.error('Game-Ready check proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Game-Ready check failed' });
  }
});

// High-to-low texture bake. The only mesh-tools route that takes TWO meshes —
// the low-poly bake target and the high-poly it samples detail from — so it
// forwards both instead of going through proxyMeshTool's single-file contract.
app.post('/api/meshes/bake',
  meshToolsUpload.fields([{ name: 'meshFile', maxCount: 1 }, { name: 'sourceFile', maxCount: 1 }]),
  async (req, res) => {
    try {
      const low = req.files?.meshFile?.[0];
      const high = req.files?.sourceFile?.[0];
      if (!low?.buffer?.length || !high?.buffer?.length) {
        return res.status(400).json({ error: 'Both meshFile (low-poly) and sourceFile (high-poly) are required.' });
      }

      const settings = await getSettings();
      const baseUrl = buildMeshToolsBaseUrl(settings);

      const form = new FormData();
      form.append('meshFile', new Blob([low.buffer], { type: 'model/gltf-binary' }), low.originalname || 'low.glb');
      form.append('sourceFile', new Blob([high.buffer], { type: 'model/gltf-binary' }), high.originalname || 'high.glb');
      if (typeof req.body?.options === 'string' && req.body.options.length) {
        form.append('options', req.body.options);
      }

      let upstream;
      try {
        upstream = await fetch(`${baseUrl}/meshes/bake`, { method: 'POST', body: form });
      } catch (err) {
        console.error('Bake proxy could not reach the Python service:', err);
        return res.status(502).json({ error: `Could not reach the Mesh Tools (Python) service at ${baseUrl}. Is it running?` });
      }

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({ error: `Bake failed (${upstream.status})`, detail: detail.slice(0, 2000) });
      }

      res.status(200);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      if (!upstream.body) { res.end(); return undefined; }

      const source = Readable.fromWeb(upstream.body);
      source.on('error', err => {
        console.error('Bake proxy upstream stream error:', err);
        if (!res.writableEnded) {
          try { res.write(`data: ${JSON.stringify({ type: 'error', detail: 'The mesh service connection was lost.' })}\n\n`); } catch { /* gone */ }
          res.end();
        }
      });
      res.on('close', () => { if (!source.destroyed) source.destroy(); });
      return source.pipe(res);
    } catch (err) {
      console.error('Bake proxy failed:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message || 'Bake failed' });
      return undefined;
    }
  });

// Convex collision hulls (CoACD decomposition). Returns a GLB scene with one
// node per hull; engine-specific naming happens client-side at export time.
app.post('/api/meshes/collision', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/collision', req, res);
  } catch (err) {
    console.error('Collision proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Collision generation failed' });
  }
});

// Smart Segmentation. Streams SSE like the other mesh tools, but the terminal
// event carries the merge hierarchy and the face->proxy map instead of a mesh —
// the editor turns those into parts client-side, so the Parts slider never comes
// back here.
app.post('/api/meshes/segment', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/segment', req, res);
  } catch (err) {
    console.error('Smart Segmentation proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Smart Segmentation failed' });
  }
});

app.post('/api/meshes/auto-retopo', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/auto-retopo', req, res);
  } catch (err) {
    console.error('Auto Retopo proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Auto Retopo failed' });
  }
});

app.post('/api/meshes/repair', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/repair', req, res);
  } catch (err) {
    console.error('Repair proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Repair failed' });
  }
});

// GLB -> FBX engine-preset conversion (headless Blender in the mesh-tools
// service). Used by the Unity/Unreal/FBX export presets; preserves the
// skeleton and one animation take per clip.
app.post('/api/meshes/convert', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/convert', req, res);
  } catch (err) {
    console.error('Mesh convert proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Mesh convert failed' });
  }
});

// Auto Rig proxies to the dedicated rigging micro-service (SkinTokens/TokenRig),
// which runs on its own host/port (settings.apis.rigtools) with a GPU/ML stack.
// Same SSE contract as the mesh-tools routes above.
app.post('/api/meshes/rig', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/rig', req, res, { baseUrlBuilder: buildRigToolsBaseUrl, serviceLabel: 'Rigging' });
  } catch (err) {
    console.error('Auto Rig proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Auto Rig failed' });
  }
});

// --- Motion library ---------------------------------------------------------
// Saved generations, so a motion survives leaving the page and can be retargeted
// onto a different mesh later. Registered BEFORE the proxy routes below and kept
// under /api/motions/library/... — the proxy owns the sibling literals
// (/generate, /skeleton, /health), and a bare /api/motions/:id here would happily
// swallow all three.
//
// The BVH is the stored artifact, not the retargeted clip: retargeting bakes in
// one rig's bone mapping, and re-running it on load costs milliseconds.
app.get('/api/motions/library', async (_req, res) => {
  try {
    res.json({ motions: await listMotions() });
  } catch (error) {
    console.error('Listing motions failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/motions/library', async (req, res) => {
  try {
    const motion = await createMotion({
      name: req.body?.name,
      prompt: req.body?.prompt,
      bvh: req.body?.bvh,
      inPlace: !!req.body?.inPlace,
      seed: req.body?.seed ?? null,
      source: req.body?.source || 'kimodo',
    });
    res.status(201).json({ motion });
  } catch (error) {
    console.error('Saving a motion failed:', error);
    res.status(400).json({ error: error.message });
  }
});

// The BVH text itself, fetched only when a saved motion is actually applied —
// the list view needs none of it, and these run to a few hundred KB each.
app.get('/api/motions/library/:id/bvh', async (req, res) => {
  try {
    const bvh = await readMotionBvh(req.params.id);
    if (bvh === null) return res.status(404).json({ error: 'That motion is no longer available.' });
    res.json({ bvh });
  } catch (error) {
    console.error('Reading a motion failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/motions/library/:id', async (req, res) => {
  try {
    const motion = await renameMotion(req.params.id, req.body?.name);
    if (!motion) return res.status(404).json({ error: 'Motion not found' });
    res.json({ motion });
  } catch (error) {
    console.error('Renaming a motion failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/motions/library/:id', async (req, res) => {
  try {
    const result = await deleteMotion(req.params.id);
    if (result.status === 'not-found') return res.status(404).json({ error: 'Motion not found' });
    res.json(result);
  } catch (error) {
    console.error('Deleting a motion failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Custom animation library ------------------------------------------------
// Clips the user corrected by hand in the mesh editor's animation dock, kept so
// an edit survives the session and can be put on a different mesh later.
//
// The stored document is the clip PLUS the skeleton it was authored on: the
// retargeter measures every frame as a delta from the source rig's rest pose, so
// a clip on its own could only ever be replayed on the exact mesh it came from.
// With its skeleton it goes through the same mapping + retarget path as a
// bundled reference clip or a Kimodo generation.
app.get('/api/animations/library', async (_req, res) => {
  try {
    res.json({ animations: await listCustomAnimations() });
  } catch (error) {
    console.error('Listing custom animations failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/animations/library', async (req, res) => {
  try {
    const animation = await createCustomAnimation({
      name: req.body?.name,
      data: req.body?.data,
      sourceMesh: req.body?.sourceMesh || '',
      sourceClip: req.body?.sourceClip || '',
      rigKey: req.body?.rigKey || '',
    });
    res.status(201).json({ animation });
  } catch (error) {
    console.error('Saving a custom animation failed:', error);
    res.status(400).json({ error: error.message });
  }
});

// The document itself, fetched only when an animation is actually applied — the
// list view needs none of it, and these run to megabytes each.
app.get('/api/animations/library/:id/data', async (req, res) => {
  try {
    const data = await readCustomAnimationData(req.params.id);
    if (data === null) return res.status(404).json({ error: 'That animation is no longer available.' });
    res.json({ data });
  } catch (error) {
    console.error('Reading a custom animation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/animations/library/:id', async (req, res) => {
  try {
    const animation = await renameCustomAnimation(req.params.id, req.body?.name);
    if (!animation) return res.status(404).json({ error: 'Animation not found' });
    res.json({ animation });
  } catch (error) {
    console.error('Renaming a custom animation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/animations/library/:id', async (req, res) => {
  try {
    const result = await deleteCustomAnimation(req.params.id);
    if (result.status === 'not-found') return res.status(404).json({ error: 'Animation not found' });
    res.json(result);
  } catch (error) {
    console.error('Deleting a custom animation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Text-to-motion (NVIDIA Kimodo) proxies to the motion micro-service on its own
// host/port (settings.apis.motiontools). Same SSE contract as the routes above,
// but the request body is JSON — there is no mesh to upload, only a prompt.
app.post('/api/motions/generate', async (req, res) => {
  try {
    await proxyMotionTool('/motions/generate', req, res);
  } catch (err) {
    console.error('Motion generation proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Motion generation failed' });
  }
});

// The SOMA-77 source skeleton at rest, so bone mapping is available before the
// first generation. Cheap upstream (no model load), so it is fetched on demand.
app.get('/api/motions/skeleton', async (req, res) => {
  const settings = await getSettings();
  const baseUrl = buildMotionToolsBaseUrl(settings);
  try {
    const upstream = await fetch(`${baseUrl}/motions/skeleton`, { signal: AbortSignal.timeout(30000) });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Motion service returned ${upstream.status}` });
    }
    return res.json(await upstream.json());
  } catch {
    return res.status(502).json({ error: `Could not reach the motion service at ${baseUrl}.` });
  }
});

// Lets the Kimodo panel say "the service isn't running" (and whether the ~16 GB
// text encoder is currently resident) before the user waits on a generation.
app.get('/api/motions/health', async (req, res) => {
  const settings = await getSettings();
  const baseUrl = buildMotionToolsBaseUrl(settings);
  try {
    const upstream = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) {
      return res.status(502).json({ error: `Motion service returned ${upstream.status}`, baseUrl });
    }
    return res.json(await upstream.json());
  } catch {
    return res.status(502).json({
      error: `Could not reach the motion service at ${baseUrl}.`,
      baseUrl,
    });
  }
});

// --- Video-to-motion (MoCapAnything V2) -------------------------------------
// Two-step by nature, and the UI depends on the distinction: a video can only
// drive a rig that has been BAKED first (skeleton topology, joint-name
// embeddings, a reference pose and a rendered view). The bake needs Blender and
// takes minutes; it is cached by mesh content hash, so it is once per rig rather
// than once per clip. /inspect is the cheap "is this mesh already baked?" probe
// the panel calls on open.
async function proxyMocapTool(operationPath, req, res, { field, fields = {}, serviceLabel = 'Video to Motion' } = {}) {
  const file = req.file;
  if (!file?.buffer?.length) {
    return res.status(400).json({ error: `${field} is required` });
  }

  const settings = await getSettings();
  const baseUrl = buildMocapToolsBaseUrl(settings);

  const form = new FormData();
  form.append(
    field,
    new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' }),
    file.originalname || (field === 'videoFile' ? 'clip.mp4' : 'mesh.glb'),
  );
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && String(value).length) form.append(key, String(value));
  }

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}${operationPath}`, { method: 'POST', body: form });
  } catch (err) {
    console.error(`MoCap proxy (${operationPath}) could not reach the Python service:`, err);
    return res.status(502).json({
      error: `Could not reach the ${serviceLabel} (Python) service at ${baseUrl}. `
        + 'Is it running? (Preparing a rig also needs Blender.)',
    });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({
      error: `Video-to-motion failed (${upstream.status})`,
      detail: detail.slice(0, 2000),
    });
  }

  // /inspect answers with a plain JSON body, not a stream.
  const contentType = upstream.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    return res.json(await upstream.json());
  }
  return pipeToolSse(operationPath, upstream, res);
}

app.post('/api/mocap/inspect', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMocapTool('/mocap/inspect', req, res, {
      field: 'meshFile',
      fields: { rigKey: req.body?.rigKey },
    });
  } catch (error) {
    console.error('MoCap inspect failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'MoCap inspect failed' });
  }
});

app.post('/api/mocap/prepare', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMocapTool('/mocap/prepare', req, res, {
      field: 'meshFile',
      fields: { rigName: req.body?.rigName || 'rig', rigKey: req.body?.rigKey },
    });
  } catch (error) {
    console.error('MoCap prepare failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'MoCap prepare failed' });
  }
});

app.post('/api/mocap/generate', meshToolsUpload.single('videoFile'), async (req, res) => {
  try {
    await proxyMocapTool('/mocap/generate', req, res, {
      field: 'videoFile',
      fields: { rigId: req.body?.rigId, maxFrames: req.body?.maxFrames },
    });
  } catch (error) {
    console.error('MoCap generate failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'MoCap generate failed' });
  }
});

// Lets the MoCap panel say "the service isn't running", and — just as important
// — whether Blender is present, before the user picks a video and waits.
app.get('/api/mocap/health', async (req, res) => {
  const settings = await getSettings();
  const baseUrl = buildMocapToolsBaseUrl(settings);
  try {
    const upstream = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) {
      return res.status(502).json({ error: `MoCap service returned ${upstream.status}`, baseUrl });
    }
    return res.json(await upstream.json());
  } catch {
    return res.status(502).json({ error: `Could not reach the MoCap service at ${baseUrl}.`, baseUrl });
  }
});

app.delete('/api/mocap/rigs/:rigId', async (req, res) => {
  const settings = await getSettings();
  const baseUrl = buildMocapToolsBaseUrl(settings);
  try {
    const upstream = await fetch(`${baseUrl}/mocap/rigs/${encodeURIComponent(req.params.rigId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(15000),
    });
    return res.status(upstream.status).json(await upstream.json().catch(() => ({})));
  } catch {
    return res.status(502).json({ error: `Could not reach the MoCap service at ${baseUrl}.` });
  }
});

// --- Mesh optimize (meshoptimizer / gltfpack binary) ------------------------
// Unlike Auto UV / Auto Retopo (which proxy to the Python service), this runs
// the bundled `gltfpack` binary locally. The browser uploads a GLB; we write it
// to a temp file, run gltfpack to simplify it (-si <ratio>), then return the
// simplified GLB as base64. `-noq` disables quantization so the output stays
// plain-float and loads cleanly into the editable geometry pipeline.
const MESHOPTIMIZER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'meshoptimizer');

// gltfpack's own -se default is 0.01, which is strict enough that most meshes
// stop well short of the ratio they were asked for. 0.05 was picked by measuring
// the bundled binary: it reaches the target wherever 0.01 stalled on the test
// meshes, and never collapsed one to nothing (which -se 1 does — see the guard
// in spawnGltfpack). Callers that want the old behaviour can pass 0.01.
const DEFAULT_SIMPLIFY_ERROR = 0.05;
const MIN_SIMPLIFY_ERROR = 0.001;
const MAX_SIMPLIFY_ERROR = 1;

function resolveGltfpackPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(MESHOPTIMIZER_DIR, 'win', 'gltfpack.exe');
  }
  if (platform === 'linux') {
    return path.join(MESHOPTIMIZER_DIR, 'linux', 'gltfpack');
  }
  if (platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm' : 'intel';
    return path.join(MESHOPTIMIZER_DIR, 'macos', arch, 'gltfpack');
  }
  throw new Error(`Unsupported platform for gltfpack: ${platform}`);
}

// One gltfpack invocation. `flags` picks the simplifier's behaviour; see
// runGltfpack for how they are chosen.
// Returns { buffer, triangles, inputTriangles } — the counts come from the -v
// report, which gltfpack only prints when asked.
async function spawnGltfpack(inputBuffer, ratio, flags = {}) {
  const {
    error = DEFAULT_SIMPLIFY_ERROR,
    permissive = false,
    aggressive = false,
    lockBorder = false,
  } = flags;
  const binaryPath = resolveGltfpackPath();
  if (!existsSync(binaryPath)) {
    throw new Error(`gltfpack binary not found at ${binaryPath}`);
  }
  // git-checked-out unix binaries may lack the execute bit.
  if (process.platform !== 'win32') {
    try { await fs.chmod(binaryPath, 0o755); } catch { /* best effort */ }
  }

  const id = randomUUID();
  const inputPath = path.join(os.tmpdir(), `meshopt-${id}-in.glb`);
  const outputPath = path.join(os.tmpdir(), `meshopt-${id}-out.glb`);
  try {
    await fs.writeFile(inputPath, inputBuffer);

    // -kv keeps source vertex attributes (UVs, normals) even when they look
    // "unused" — the editor exports meshes with an untextured placeholder
    // material, so without -kv gltfpack strips TEXCOORD_0 and the reloaded mesh
    // loses its UVs (disabling the texture/paint/projection modes).
    // -v makes gltfpack report the triangle counts we parse below; its output is
    // captured, never shown.
    // -se caps how far the simplifier may move the surface. gltfpack defaults
    // it to 0.01 (1%), and that — not UV seams — is what stops most meshes
    // short of their target: on a 37.9k-triangle textured mesh, -si 0.25 stalls
    // at 11,740 triangles under the default and reaches its 9,475 target at
    // -se 0.05, welding nothing. Passing it explicitly is what keeps -sa (which
    // does weld, taking normals and UVs with it) from being the only way down.
    const args = [
      '-i', inputPath, '-o', outputPath,
      '-si', String(ratio), '-se', String(error),
      '-noq', '-kv', '-v',
    ];
    // -sp allows collapses across attribute discontinuities while staying
    // quality-driven. It measured as a no-op on every mesh tried here (identical
    // triangle counts with and without, at every ratio), so it is an opt-in knob
    // rather than an automatic step on the way to -sa.
    if (permissive) args.push('-sp');
    if (aggressive) args.push('-sa');
    // -slb pins border vertices, so a mesh that is one piece of a larger set
    // does not pull away from its neighbours along the shared edge.
    if (lockBorder) args.push('-slb');

    const report = await new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, args, { windowsHide: true });
      let out = '';
      proc.stderr.on('data', chunk => { out += chunk.toString(); });
      proc.stdout.on('data', chunk => { out += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve(out);
        else reject(new Error(out.trim() || `gltfpack exited with code ${code}`));
      });
    });

    const buffer = await fs.readFile(outputPath);

    // "input:  1 mesh primitives (12846 triangles, 17130 vertices)"
    // "output: 1 mesh primitives (3097 triangles, 1332 vertices)"
    const count = label => {
      const match = report.match(new RegExp(`^${label}:.*?\\((\\d+) triangles`, 'm'));
      return match ? Number(match[1]) : null;
    };

    const triangles = count('output');
    const inputTriangles = count('input');
    // A loose error budget can collapse the mesh outright, and gltfpack still
    // exits 0 when it does: the GLB comes back with zero primitives and the
    // images still attached, so it is neither an error nor suspiciously small.
    // Catch it here, where the cause is still known, rather than let an empty
    // mesh reach the editor as "No editable mesh geometry found".
    if (inputTriangles && !triangles) {
      throw new Error('Simplification removed the whole mesh. Lower the simplification error, or raise the target ratio.');
    }

    return { buffer, triangles, inputTriangles };
  } finally {
    await Promise.all([inputPath, outputPath].map(f => fs.rm(f, { force: true }).catch(() => {})));
  }
}

// Does this GLB carry UVs? Read straight from the JSON chunk — cheap, and it
// decides whether breaking attribute seams is allowed to happen silently.
function glbHasUvs(buffer) {
  try {
    if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) return false; // 'glTF'
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
    return (json.meshes || []).some(mesh =>
      (mesh.primitives || []).some(primitive => primitive?.attributes?.TEXCOORD_0 !== undefined));
  } catch {
    return false;
  }
}

// Simplify a GLB to `ratio` of its triangle count.
//
// Two different things stop a mesh short of its target, and they were previously
// conflated. Measured on the bundled gltfpack 1.2:
//
//   1. The error budget (-se, default 0.01). This is the one that bites first
//      and most often. A 37.9k-triangle textured mesh asked for -si 0.25 stalls
//      at 11,740 triangles under the default and lands on its 9,475 target at
//      -se 0.05 — no seams welded, normals and UVs untouched. This is a knob,
//      not a wall, which is why simplifyError is now a caller-facing option.
//
//   2. A genuine attribute-seam floor. The same mesh will not go below ~9,200
//      triangles at any error budget, because the simplifier will not collapse
//      across attribute discontinuities. Only -sa breaks that floor, and it does
//      so by rebuilding the vertex set: normals and UVs are both reassigned, so
//      hard edges smooth over and the texture scrambles together.
//
// -sp ("permissive") reads like the middle ground and is exposed as one, but it
// measured as a no-op here: identical triangle counts with and without, on every
// mesh and ratio tried. It is passed through when asked for and nothing more.
//
// So the ladder only escalates to the destructive pass, and only when the caller
// has said yes to it:
//
//   * no UVs            -> nothing to protect, use -sa and hit the target.
//   * UVs, not allowed  -> stop where the seam-preserving pass reached and
//                          report `seamLimited` so the UI can say why.
//   * UVs, allowed      -> the caller opted in with eyes open.
//
// Falling back to -sa automatically (as this did, before the error budget was
// even in play) trades a silently under-simplified mesh for a silently ruined
// one. Both are silent; the second is worse, because it looks like it worked.
async function runGltfpack(inputBuffer, ratio, {
  allowSeamBreaking = false,
  simplifyError = DEFAULT_SIMPLIFY_ERROR,
  permissive = false,
  lockBorder = false,
  aggressive = null,
} = {}) {
  // `aggressive` splits the destructive pass out from the seam permission so the
  // UI can offer it separately. Existing callers (MCP tools, saved Kanban steps)
  // send only allow_seam_breaking and must keep reaching their target, so when
  // it is unset it follows the seam permission exactly as before.
  const allowAggressive = aggressive == null ? !!allowSeamBreaking : !!aggressive;
  const base = { error: simplifyError, permissive, lockBorder };
  const first = await spawnGltfpack(inputBuffer, ratio, base);
  const achieved = (result) => ({
    ...result,
    achievedRatio: result.inputTriangles && result.triangles
      ? result.triangles / result.inputTriangles
      : null,
  });

  if (ratio >= 1 || !first.inputTriangles || !first.triangles) {
    return achieved({ ...first, seamLimited: false });
  }

  const target = first.inputTriangles * ratio;
  // 1.5x leaves room for the simplifier landing a little above target, which is
  // normal, while still catching the "barely moved" case.
  if (first.triangles <= target * 1.5) {
    return achieved({ ...first, seamLimited: false });
  }

  if (glbHasUvs(inputBuffer) && !allowSeamBreaking) {
    return achieved({ ...first, seamLimited: true });
  }

  // Seams may be broken but the destructive pass was refused outright: report it
  // the same way, because the outcome the caller sees is the same — short of
  // target, nothing scrambled.
  if (!allowAggressive) {
    return achieved({ ...first, seamLimited: true });
  }

  const sloppy = await spawnGltfpack(inputBuffer, ratio, { ...base, aggressive: true });
  const best = sloppy.triangles && sloppy.triangles < first.triangles ? sloppy : first;
  return achieved({ ...best, seamLimited: false, seamsBroken: best === sloppy });
}

function clampSimplifyRatio(value, fallback = 1) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return fallback;
  return Math.min(1, Math.max(0.001, ratio));
}

// Unset means "use the measured default", not 0 — gltfpack treats -se 0 as
// "deviate by nothing", which returns the mesh completely unsimplified.
function clampSimplifyError(value, fallback = DEFAULT_SIMPLIFY_ERROR) {
  const error = Number(value);
  if (!Number.isFinite(error)) return fallback;
  return Math.min(MAX_SIMPLIFY_ERROR, Math.max(MIN_SIMPLIFY_ERROR, error));
}

// The simplifier options shared by /optimize and /lods.
function readSimplifyOptions(options = {}) {
  return {
    allowSeamBreaking: !!options.allow_seam_breaking,
    simplifyError: clampSimplifyError(options.simplify_error),
    permissive: !!options.permissive,
    lockBorder: !!options.lock_border,
    aggressive: options.aggressive == null ? null : !!options.aggressive,
  };
}

app.post('/api/meshes/optimize', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    const meshFile = req.file;
    if (!meshFile?.buffer?.length) {
      return res.status(400).json({ error: 'meshFile is required' });
    }

    let options = {};
    if (typeof req.body?.options === 'string' && req.body.options.length) {
      try { options = JSON.parse(req.body.options); } catch { options = {}; }
    }
    const ratio = clampSimplifyRatio(options.simplify_ratio);
    const simplify = readSimplifyOptions(options);

    const result = await runGltfpack(meshFile.buffer, ratio, simplify);

    res.json({
      mesh_b64: result.buffer.toString('base64'),
      stats: {
        simplify_ratio: ratio,
        simplify_error: simplify.simplifyError,
        triangles: result.triangles,
        input_triangles: result.inputTriangles,
        achieved_ratio: result.achievedRatio,
        seam_limited: !!result.seamLimited,
        seams_broken: !!result.seamsBroken,
      },
    });
  } catch (err) {
    console.error('Mesh optimize failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Mesh optimize failed' });
  }
});

// LOD chain — the same simplifier as /optimize, run once per requested ratio.
// Each level is simplified from the ORIGINAL mesh rather than from the previous
// level: chaining compounds the error, so LOD3 built off LOD2 off LOD1 drifts
// visibly further from the source than one built directly from it.
app.post('/api/meshes/lods', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    const meshFile = req.file;
    if (!meshFile?.buffer?.length) {
      return res.status(400).json({ error: 'meshFile is required' });
    }

    let options = {};
    if (typeof req.body?.options === 'string' && req.body.options.length) {
      try { options = JSON.parse(req.body.options); } catch { options = {}; }
    }

    const requested = Array.isArray(options.ratios) ? options.ratios : [];
    if (!requested.length) {
      return res.status(400).json({ error: 'options.ratios must be a non-empty array.' });
    }
    if (requested.length > 8) {
      return res.status(400).json({ error: 'At most 8 LOD levels can be generated at once.' });
    }
    const ratios = requested.map(value => clampSimplifyRatio(value));
    const simplify = readSimplifyOptions(options);

    const lods = [];
    for (let level = 0; level < ratios.length; level += 1) {
      const ratio = ratios[level];
      // Ratio 1 means "the source, untouched" — skip gltfpack entirely so LOD0
      // keeps the original bytes (textures and rig included). No mesh is sent
      // back for those levels: the caller already holds what it uploaded, and
      // echoing a large GLB just to have it thrown away is pure waste.
      if (ratio >= 1) {
        lods.push({ level, ratio, mesh_b64: null, triangles: null, passthrough: true });
        continue;
      }
      const result = await runGltfpack(meshFile.buffer, ratio, simplify);
      lods.push({
        level,
        ratio,
        mesh_b64: result.buffer.toString('base64'),
        triangles: result.triangles,
        achieved_ratio: result.achievedRatio,
        seam_limited: !!result.seamLimited,
        seams_broken: !!result.seamsBroken,
        passthrough: false,
      });
    }

    res.json({ lods });
  } catch (err) {
    console.error('LOD generation failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'LOD generation failed' });
  }
});

// Pivot placement — the headless twin of the Mesh Editor's "move pivot" buttons.
// Runs in-process (see meshPivot.js): it rewrites the glTF node graph only, so
// skins, animations, and textures survive, which a trimesh round trip would not
// guarantee. Returns the mesh unchanged when the pivot is already in place.
app.post('/api/meshes/pivot', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    const meshFile = req.file;
    if (!meshFile?.buffer?.length) {
      return res.status(400).json({ error: 'meshFile is required' });
    }

    let options = {};
    if (typeof req.body?.options === 'string' && req.body.options.length) {
      try { options = JSON.parse(req.body.options); } catch { options = {}; }
    }
    const mode = options.mode || req.body?.mode || 'ground_pivot';
    if (!PIVOT_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of ${PIVOT_MODES.join(', ')}` });
    }

    const result = moveGlbPivot(meshFile.buffer, mode);

    res.json({
      mesh_b64: result.buffer.toString('base64'),
      stats: {
        mode,
        moved: result.moved,
        offset: result.offset,
        bounds_before: result.bounds,
        bounds_after: result.boundsAfter,
      },
    });
  } catch (err) {
    console.error('Pivot move failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Pivot move failed' });
  }
});

app.post('/api/export/mesh', multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } }).array('files'), async (req, res) => {
  try {
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
    const files = Array.isArray(req.files) ? req.files : [];

    if (!folder) {
      return res.status(400).json({ error: 'An output folder is required.' });
    }
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files were provided to export.' });
    }
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'The output folder must be an absolute path.' });
    }

    const resolvedFolder = path.resolve(folder);
    await fs.mkdir(resolvedFolder, { recursive: true });

    const written = [];
    for (const file of files) {
      // Use only the base name to prevent writing outside the chosen folder.
      const safeName = path.basename(file.originalname || 'mesh.bin');
      const destination = path.join(resolvedFolder, safeName);
      await fs.writeFile(destination, file.buffer);
      written.push(safeName);
    }

    res.status(201).json({ folder: resolvedFolder, written });
  } catch (err) {
    console.error('Failed to export mesh files:', err);
    const message = err.code === 'EACCES'
      ? 'Access to the output folder is denied.'
      : (err.message || 'Failed to export mesh files');
    res.status(500).json({ error: message });
  }
});

app.post('/api/assets/image-editor/save', multer({ storage: multer.memoryStorage() }).single('imageFile'), async (req, res) => {
  try {
    const { assetId, saveMode = 'replace', name } = req.body || {};
    const imageFile = req.file;

    if (!imageFile?.buffer?.length) {
      return res.status(400).json({ error: 'imageFile is required' });
    }

    if (!assetId) {
      return res.status(400).json({ error: 'assetId is required' });
    }

    if (!['replace', 'version'].includes(saveMode)) {
      return res.status(400).json({ error: 'saveMode must be replace or version' });
    }

    // Multipart body -- see requireAssetAccess.
    if (!(await requireAssetAccess(req, res, assetId))) return;

    const sourceAsset = await getAssetRecordById(Number(assetId));
    if (!sourceAsset) {
      return res.status(404).json({ error: 'Image asset not found' });
    }

    if (String(sourceAsset.assetTypeName || '').toLowerCase() !== 'image') {
      return res.status(400).json({ error: 'Selected asset is not an image' });
    }

    const nextName = String(name || '').trim() || sourceAsset.name || 'Image';
    const { width, height } = getImageDimensionsFromBuffer(imageFile.buffer, { filename: 'image.png', mimeType: 'image/png' });

    if (saveMode === 'replace') {
      const storedFilePath = sourceAsset.filePath;
      const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

      await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
      await fs.writeFile(absoluteFilePath, imageFile.buffer);

      const savedAsset = await replaceAssetFileById(sourceAsset.id, {
        name: nextName,
        type: 'image',
        filePath: storedFilePath,
        width,
        height,
        metadata: {
          ...JSON.parse(sourceAsset.metadata || '{}'),
          source: 'IMAGE EDITOR',
          editedAt: Date.now()
        }
      });

      return res.status(200).json(savedAsset);
    }

    // saveMode === 'version': save as new edit child of the root parent
    const editId = `edit-${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const storedFilePath = getImageEditStoredFilePath(sourceAsset, editId, 'png');
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, imageFile.buffer);

    const savedEdit = await createAssetEditRecord({
      assetId: sourceAsset.id,
      editId,
      name: nextName,
      filePath: storedFilePath,
      width,
      height,
      createdAt: Date.now()
    });

    return res.status(201).json(savedEdit);
  } catch (err) {
    console.error('Failed to save image editor result:', err);
    res.status(500).json({ error: err.message || 'Failed to save image editor result' });
  }
});

// Resolve a chosen file (served filename or stored path) to a workflow source
// reference that parents edits to the root ancestor. Used by the board panel.
app.get('/api/assets/resolve-source', async (req, res) => {
  try {
    const { projectId, type = 'image', filePath } = req.query;

    if (!projectId || !filePath) {
      return res.status(400).json({ error: 'projectId and filePath are required' });
    }

    res.json(await resolveEditableSourceReference(Number(projectId), type, filePath));
  } catch (err) {
    console.error('Failed to resolve asset source:', err);
    res.status(500).json({ error: err.message || 'Failed to resolve asset source' });
  }
});

app.post('/api/assets/link', async (req, res) => {
  try {
    const { projectId, assetId, filename, type = 'image', name, metadata, detached } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    // Link an EXISTING asset by id — works for a root asset as well as for an
    // image edit or a mesh version, which have no file of their own to look up
    // in the library and previously could not be attached to a project at all.
    if (assetId !== undefined && assetId !== null && assetId !== '') {
      const numericAssetId = Number(assetId);

      if (!Number.isFinite(numericAssetId)) {
        return res.status(400).json({ error: 'assetId must be a number' });
      }

      try {
        const linked = await linkExistingAssetToProject(Number(projectId), numericAssetId, {
          cascadeChildren: req.body.cascadeChildren === true
        });
        return res.status(201).json(linked);
      } catch (linkErr) {
        if (linkErr.message === 'Asset not found') {
          return res.status(404).json({ error: 'Asset not found' });
        }
        if (linkErr.message?.startsWith('Project not found:')) {
          return res.status(404).json({ error: 'Project not found' });
        }
        throw linkErr;
      }
    }

    if (!filename) {
      return res.status(400).json({ error: 'assetId or filename is required' });
    }

    const assetType = type || inferAssetTypeFromFilename(filename);
    const storedFilePath = toStoredAssetPath(assetType, filename);
    const absoluteAssetPath = toAbsoluteStoragePath(storedFilePath);

    await fs.access(absoluteAssetPath).catch(() => null);
    try {
      await fs.access(absoluteAssetPath);
    } catch {
      return res.status(404).json({ error: 'Selected asset file was not found' });
    }

    const libraryAsset = await findLibraryAssetByFilePath(assetType, storedFilePath);
    const newAsset = await createProjectAsset({
      projectId: Number(projectId),
      ownerId: viewerId(req),
      type: assetType,
      name: name || path.basename(storedFilePath),
      filePath: storedFilePath,
      thumbnailPath: libraryAsset?.thumbnail || null,
      width: libraryAsset?.width ?? 0,
      height: libraryAsset?.height ?? 0,
      metadata: {
        ...(metadata || {}),
        resolution: assetType === 'image'
          ? formatImageResolution(libraryAsset?.width ?? 0, libraryAsset?.height ?? 0)
          : 'Unknown',
        format: path.extname(storedFilePath).replace('.', '').toUpperCase() || assetType.toUpperCase(),
        source: 'ASSET LIB'
      },
      createdAt: Date.now(),
      detached: detached === true || String(detached).toLowerCase() === 'true'
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Failed to link existing asset:', err);
    res.status(500).json({ error: 'Failed to attach asset from library' });
  }
});

app.delete('/api/assets/:id', async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    // With ?projectId= the asset is detached from that project only; without it,
    // from every project (and deleted outright when it belonged to none).
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    const result = await deleteAssetById(assetId, { projectId });

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Asset card not found' });
    }

    if (result.status === 'linked') {
      return res.status(409).json({ error: 'Cannot delete an asset while it is linked to a card' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to remove asset card:', err);
    res.status(500).json({ error: 'Failed to remove asset card' });
  }
});

app.put('/api/cards/move', async (req, res) => {
  try {
    const { projectId, cardId, kanbanColumnId, position } = req.body;

    if (!projectId || !cardId || kanbanColumnId === undefined || position === undefined) {
      return res.status(400).json({ error: 'projectId, cardId, kanbanColumnId and position are required' });
    }

    res.json(await moveCard(Number(projectId), cardId, Number(kanbanColumnId), Number(position)));
  } catch (err) {
    console.error('Failed to move card:', err);
    res.status(500).json({ error: err.message || 'Failed to move card' });
  }
});

app.delete('/api/cards/:cardId', async (req, res) => {
  try {
    const projectId = Number(req.query.projectId);

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await deleteCard(projectId, req.params.cardId));
  } catch (err) {
    console.error('Failed to delete card:', err);
    res.status(500).json({ error: err.message || 'Failed to delete card' });
  }
});

app.get('/api/card-attributes/types', async (req, res) => {
  try {
    res.json(await listAttributeTypes());
  } catch (err) {
    console.error('Failed to list attribute types:', err);
    res.status(500).json({ error: 'Failed to list attribute types' });
  }
});

app.get('/api/card-attributes', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectCardAttributes(Number(projectId)));
  } catch (err) {
    console.error('Failed to list card attributes:', err);
    res.status(500).json({ error: 'Failed to list card attributes' });
  }
});

app.post('/api/card-attributes', async (req, res) => {
  try {
    const { projectId, cardId, attributeTypeId, attributeValue = '' } = req.body;

    if (!projectId || !cardId || !attributeTypeId) {
      return res.status(400).json({ error: 'projectId, cardId and attributeTypeId are required' });
    }

    const attribute = await createCardAttribute(Number(projectId), cardId, {
      attributeTypeId: Number(attributeTypeId),
      attributeValue
    });

    res.status(201).json(attribute);
  } catch (err) {
    console.error('Failed to create card attribute:', err);
    res.status(500).json({ error: err.message || 'Failed to create card attribute' });
  }
});

app.put('/api/card-attributes/:cardId/:position', async (req, res) => {
  try {
    const { projectId, attributeTypeId, attributeValue } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const attribute = await updateCardAttribute(
      Number(projectId),
      req.params.cardId,
      Number(req.params.position),
      {
        attributeTypeId: attributeTypeId === undefined ? undefined : Number(attributeTypeId),
        attributeValue
      }
    );

    res.json(attribute);
  } catch (err) {
    console.error('Failed to update card attribute:', err);
    res.status(500).json({ error: err.message || 'Failed to update card attribute' });
  }
});

app.delete('/api/card-attributes/:cardId/:position', async (req, res) => {
  try {
    const projectId = Number(req.query.projectId);

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const result = await deleteCardAttribute(projectId, req.params.cardId, Number(req.params.position));

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Card attribute not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete card attribute:', err);
    res.status(500).json({ error: err.message || 'Failed to delete card attribute' });
  }
});

app.post('/api/image-edits/api', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, assetId, selectedApi, prompt, name, imageSource } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !selectedApi || !prompt?.trim() || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    const resolvedSource = await resolveProjectSource(Number(projectId), 'image', imageSource || assetId);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'image') {
      return res.status(404).json({ error: 'Source image or edit not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Image Edit',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting image edit request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'image-edit',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const googleSettings = settings?.apis?.google;
    const googleGenerationSettings = googleSettings?.imageGeneration;
    const openAiSettings = settings?.apis?.openai;
    const openAiEditSettings = openAiSettings?.imageEdit;

    // The bytes may live on the shared server, so read them through dataStore.
    const sourceBuffer = await readAssetBytes(resolvedSource.inputFilePath);
    const mimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const trimmedPrompt = String(prompt).trim();
    let response;
    let responseBody;
    let imageOutputs;
    let providerName;

    if (selectedApi.startsWith('openai')) {
      if (!openAiSettings?.apiKey) {
        return res.status(400).json({ error: 'OpenAI API key is not configured in settings' });
      }

      const modelConfig = openAiEditSettings?.models?.[selectedApi];
      if (!openAiEditSettings?.url || !modelConfig?.model) {
        return res.status(400).json({ error: `Unsupported image edit API: ${selectedApi}` });
      }

      const requestHeaders = replaceTemplatePlaceholders(openAiEditSettings?.headers || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt,
        model: modelConfig.model
      });
      const requestPayload = replaceTemplatePlaceholders(openAiEditSettings?.payloadTemplate || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt,
        model: modelConfig.model
      });
      const formData = new FormData();
      const imageBlob = new Blob([sourceBuffer], { type: mimeType || 'image/png' });

      formData.append('image', imageBlob, path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'image.png'));
      Object.entries(requestPayload || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          formData.append(key, String(value));
        }
      });

      response = await fetch(openAiEditSettings.url, {
        method: 'POST',
        headers: requestHeaders,
        body: formData
      });

      responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          error: responseBody?.error?.message || responseBody?.error || 'Image edit request failed'
        });
      }

      const imageBase64 = responseBody?.data?.[0]?.b64_json;
      if (!imageBase64) {
        return res.status(502).json({ error: 'Image edit succeeded but no image data was returned' });
      }

      imageOutputs = [{
        buffer: Buffer.from(imageBase64, 'base64'),
        mimeType: 'image/png',
        extension: 'png'
      }];
      providerName = modelConfig.name;
    } else {
      const modelConfig = googleGenerationSettings?.models?.[selectedApi];

      if (!modelConfig?.url) {
        return res.status(400).json({ error: `Unsupported image edit API: ${selectedApi}` });
      }

      if (!googleSettings?.apiKey) {
        return res.status(400).json({ error: 'Google API key is not configured in settings' });
      }

      response = await fetch(modelConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [googleGenerationSettings?.headerName || 'x-goog-api-key']: googleSettings.apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: trimmedPrompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: sourceBuffer.toString('base64')
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: {
              aspectRatio: '1:1',
              imageSize: '1K'
            }
          }
        })
      });

      responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          error: responseBody?.error?.message || responseBody?.error || 'Image edit request failed'
        });
      }

      const imageParts = collectInlineImageParts(responseBody);
      if (imageParts.length === 0) {
        return res.status(502).json({ error: 'Image edit succeeded but no image data was returned' });
      }

      imageOutputs = imageParts.map(part => ({
        buffer: Buffer.from(part.data, 'base64'),
        mimeType: part.mimeType,
        extension: getExtensionFromMimeType(part.mimeType)
      }));
      providerName = modelConfig.name;
    }

    const editId = randomUUID();
    const savedEdits = await saveImageEdits({
      sourceAsset,
      editId,
      name: trimmedName,
      imageOutputs
    });

    await clearCardProcessing(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json({
      editId,
      assetId: sourceAsset.id,
      savedEdits,
      provider: providerName
    });
  } catch (err) {
    console.error('Image edit API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Image Edit',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run image edit API',
        currentNodeLabel: 'Image edit failed',
        source: 'API',
        operationType: 'image-edit',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist image edit API error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run image edit API' });
  }
});

app.post('/api/image-edits/comfy', async (req, res) => {
  let executionMonitor = null;
  let unregisterRun = null;
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();
  let executionPromptId = null;
  let processingWorkflowId = null;
  let processingWorkflowName = null;

  try {
    const { projectId, assetId, workflowId, prompt, name } = req.body;
    const trimmedName = String(name || '').trim();
    const rawInputValues = isPlainObject(req.body?.inputValues) ? req.body.inputValues : {};

    if (!projectId || !workflowId || !trimmedName) {
      return res.status(400).json({ error: 'projectId, workflowId and name are required' });
    }

    // The definition may live on the shared server; the run itself never does.
    const workflow = await getWorkflowDefinition(workflowId, buildLocalWorkflowResponse);

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    const imageParameters = (workflow.parameters || []).filter(parameter => normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter)) === 'image');

    if (imageParameters.length === 0) {
      return res.status(400).json({ error: 'The selected workflow must expose at least one image input' });
    }

    const firstStringParameterId = (workflow.parameters || []).find(parameter => normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter)) === 'string')?.id;

    const settings = await getSettings();
    const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
    const resolvedInputs = {};
    const referencedImageAssets = [];

    for (const parameter of workflow.parameters || []) {
      const valueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter));
      const providedValue = rawInputValues?.[parameter.id];

      if (valueType === 'image') {
        // "None": upload nothing and reference no asset, so the input keeps the
        // value baked into the saved workflow JSON.
        if (isComfyNoneInput(providedValue)) {
          continue;
        }

        const sourceReference = isPlainObject(providedValue)
          ? (providedValue.source || providedValue.filePath || providedValue.assetId)
          : providedValue;

        if (!sourceReference) {
          return res.status(400).json({ error: `An image asset is required for ${parameter.name}` });
        }

        const resolvedImageSource = await resolveProjectSource(Number(projectId), 'image', sourceReference);
        if (!resolvedImageSource?.asset || resolvedImageSource.asset.type !== 'image') {
          return res.status(404).json({ error: `Image source not found for ${parameter.name}` });
        }

        const inputBuffer = await readAssetBytes(resolvedImageSource.inputFilePath);
        resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, {
          buffer: inputBuffer,
          mimetype: getMimeTypeFromFilename(resolvedImageSource.inputFilePath || resolvedImageSource.inputFilename || resolvedImageSource.inputName),
          originalname: path.basename(resolvedImageSource.inputFilePath || resolvedImageSource.inputFilename || resolvedImageSource.inputName)
        });
        referencedImageAssets.push(resolvedImageSource.asset);
        continue;
      }

      if (valueType === 'number') {
        const numericValue = Number(providedValue);
        if (providedValue === '' || providedValue === null || providedValue === undefined || Number.isNaN(numericValue)) {
          return res.status(400).json({ error: `A valid number is required for ${parameter.name}` });
        }

        resolvedInputs[parameter.id] = numericValue;
        continue;
      }

      const stringValue = String(providedValue ?? '').trim() || (parameter.id === firstStringParameterId
        ? String(prompt || '').trim()
        : '');

      if (!stringValue) {
        return res.status(400).json({ error: `A value is required for ${parameter.name}` });
      }

      resolvedInputs[parameter.id] = stringValue;
    }

    const sourceAsset = referencedImageAssets.find(item => item.id === Number(assetId)) || referencedImageAssets[0];
    if (!sourceAsset) {
      return res.status(400).json({ error: 'At least one workflow image input is required' });
    }

    processingProjectId = Number(projectId);
    processingCardId = sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingWorkflowId = workflow.id;
    processingWorkflowName = workflow.name;

    const promptWorkflow = applyComfyParametersToWorkflow(workflow.workflowJson, workflow.parameters, resolvedInputs);
    const executionClientId = String(req.body.clientId || '').trim() || randomUUID();
    executionPromptId = String(req.body.promptId || '').trim() || randomUUID();
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Image Edit',
      name: processingCardName,
      status: 'processing',
      progressPercent: 0,
      detail: 'Preparing ComfyUI image edit',
      currentNodeLabel: 'Waiting for ComfyUI execution to start',
      promptId: executionPromptId,
      source: 'ComfyUI',
      operationType: 'image-edit',
      workflowId: processingWorkflowId,
      workflowName: processingWorkflowName,
      startedAt: processingStartedAt
    });

    executionMonitor = createComfyExecutionMonitor(baseUrl, {
      clientId: executionClientId,
      promptId: executionPromptId,
      workflowJson: promptWorkflow,
      selectedOutputs: workflow.outputs,
      onProgress: (payload) => {
        updateCardProcessingSnapshot(processingProjectId, processingCardId, {
          columnName: 'Image Edit',
          name: processingCardName,
          status: payload?.status === 'error' ? 'error' : 'processing',
          progressPercent: payload?.progressPercent,
          detail: payload?.detail || 'Running ComfyUI image edit',
          currentNodeLabel: payload?.currentNodeLabel || '',
          promptId: executionPromptId,
          source: 'ComfyUI',
          operationType: 'image-edit',
          workflowId: processingWorkflowId,
          workflowName: processingWorkflowName,
          startedAt: processingStartedAt
        }).catch(err => {
          console.warn('Failed to persist ComfyUI image edit progress:', err.message);
        });
      }
    });

    // Reachable by /cancel from here on, including while it is only queued.
    const activeRun = { baseUrl, monitor: executionMonitor, cancelRequested: false };
    unregisterRun = registerComfyRun(executionPromptId, activeRun);

    // Cancelled while the inputs were still being uploaded: never queue it.
    if (activeRun.cancelRequested) {
      throw new ComfyCancelledError('Workflow cancelled');
    }

    await executionMonitor.ready;
    publishComfyProgress(executionPromptId, {
      status: 'queued',
      progressPercent: 0,
      detail: 'Queueing ComfyUI image edit',
      currentNodeLabel: workflow.name
    });

    const { promptId } = await queueComfyPrompt(baseUrl, promptWorkflow, {
      clientId: executionClientId,
      promptId: executionPromptId
    });

    // A cancel that landed while the prompt was still on its way to ComfyUI found
    // nothing to stop, so ask again now that it is queued.
    if (activeRun.cancelRequested) {
      await cancelComfyPrompt(baseUrl, executionPromptId).catch(err => {
        console.warn('Failed to cancel a just-queued ComfyUI image edit:', err.message);
      });
      throw new ComfyCancelledError('Image edit cancelled');
    }

    await executionMonitor.completion;
    // As above: a cancel that lands after execution finished still stops the
    // run before anything is downloaded or saved.
    if (activeRun.cancelRequested) {
      throw new ComfyCancelledError('Image edit cancelled');
    }
    const historyRecord = await waitForComfyHistory(baseUrl, promptId, 180, {
      isCancelled: () => activeRun.cancelRequested
    });
    if (activeRun.cancelRequested) {
      throw new ComfyCancelledError('Image edit cancelled');
    }
    const workflowImages = getComfyHistoryImages(historyRecord, workflow.outputs);

    if (workflowImages.length === 0) {
      throw new Error('The ComfyUI workflow finished but no images were returned');
    }

    const downloadedImages = await Promise.all(workflowImages.map(async workflowImage => {
      const downloadedImage = await downloadComfyImage(baseUrl, workflowImage);
      return {
        buffer: downloadedImage.buffer,
        mimeType: downloadedImage.contentType,
        extension: path.extname(workflowImage.filename).replace('.', '') || getExtensionFromMimeType(downloadedImage.contentType)
      };
    }));

    const editId = randomUUID();
    const savedEdits = await saveImageEdits({
      sourceAsset,
      editId,
      name: trimmedName,
      imageOutputs: downloadedImages
    });

    await clearCardProcessing(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json({
      editId,
      assetId: sourceAsset.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      promptId,
      savedEdits
    });
  } catch (err) {
    const wasCancelled = Boolean(err?.cancelled);

    if (wasCancelled) {
      console.log('ComfyUI image edit cancelled by the user');
    } else {
      console.error('ComfyUI image edit execution failed:', err);
    }

    executionMonitor?.close();
    if (processingProjectId && processingCardId) {
      // A cancelled run leaves no result, so the card goes back to idle rather
      // than being marked failed.
      const restoreCard = wasCancelled
        ? clearCardProcessing(processingProjectId, processingCardId, { name: processingCardName })
        : updateCardProcessingSnapshot(processingProjectId, processingCardId, {
            columnName: 'Image Edit',
            name: processingCardName,
            status: 'error',
            progressPercent: null,
            detail: err.message || 'Failed to run ComfyUI image edit',
            currentNodeLabel: 'ComfyUI image edit failed',
            promptId: executionPromptId,
            source: 'ComfyUI',
            operationType: 'image-edit',
            workflowId: processingWorkflowId,
            workflowName: processingWorkflowName,
            startedAt: processingStartedAt
          });

      await restoreCard.catch(persistErr => {
        console.warn('Failed to persist the ComfyUI image edit terminal state:', persistErr.message);
      });
    }
    const failedPromptId = String(req.body?.promptId || '').trim() || String(executionPromptId || '').trim();
    if (failedPromptId) {
      publishComfyProgress(failedPromptId, wasCancelled
        ? {
            status: 'cancelled',
            detail: err.message || 'Image edit cancelled',
            currentNodeLabel: 'Cancelled',
            done: true,
            cancelled: true
          }
        : {
            status: 'error',
            detail: err.message || 'Failed to run ComfyUI image edit',
            currentNodeLabel: 'ComfyUI image edit failed'
          });
    }
    res.status(wasCancelled ? 409 : 500).json({
      error: err.message || 'Failed to run ComfyUI image edit',
      ...(wasCancelled ? { cancelled: true } : {})
    });
  } finally {
    unregisterRun?.();
  }
});

app.post('/api/images/generate', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    // Brainstorming Board generations link the asset to the project without a
    // visible Kanban card, so skip the processing-card snapshot entirely.
    const detachedAsset = String(req.body.detachedAsset || '').toLowerCase() === 'true';

    if (!projectId || !selectedApi || !prompt?.trim() || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    const settings = await getSettings();
    const trimmedPrompt = prompt.trim();
    processingProjectId = Number(projectId);
    processingCardId = detachedAsset ? null : (cardId || randomUUID());
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    if (!detachedAsset) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Images',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Submitting image generation request',
        currentNodeLabel: 'Waiting for API response',
        source: 'API',
        operationType: 'image-generation',
        startedAt: processingStartedAt
      });
    }

    const googleSettings = settings?.apis?.google;
    const googleGenerationSettings = googleSettings?.imageGeneration;
    const openAiSettings = settings?.apis?.openai;
    const openAiGenerationSettings = openAiSettings?.imageGeneration;

    let response;
    let responseBody;
    let inlineData;
    let providerName;
    let modelVersion;
    let responseId;
    let outputFormat;

    if (selectedApi.startsWith('openai')) {
      if (!openAiSettings?.apiKey) {
        return res.status(400).json({ error: 'OpenAI API key is not configured in settings' });
      }

      const openAiModelConfig = openAiGenerationSettings?.models?.[selectedApi];
      if (!openAiGenerationSettings?.url || !openAiModelConfig?.model) {
        return res.status(400).json({ error: `Unsupported image API: ${selectedApi}` });
      }

      const requestHeaders = replaceTemplatePlaceholders(openAiGenerationSettings?.headers || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt
      });
      const requestPayload = replaceTemplatePlaceholders(openAiGenerationSettings?.payloadTemplate, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt,
        model: openAiModelConfig.model
      });

      response = await fetch(openAiGenerationSettings?.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...requestHeaders
        },
        body: JSON.stringify(requestPayload)
      });

      responseBody = await response.json();

      if (!response.ok) {
        console.error('OpenAI image generation failed:', responseBody);
        return res.status(response.status).json({
          error: responseBody?.error?.message || 'Image generation request failed'
        });
      }

      const imageBase64 = responseBody?.data?.[0]?.b64_json;
      if (!imageBase64) {
        return res.status(502).json({ error: 'Image generation succeeded but no image data was returned' });
      }

      inlineData = {
        mimeType: 'image/png',
        data: imageBase64
      };
      providerName = 'OpenAI';
      modelVersion = openAiModelConfig.model;
      responseId = responseBody?.created ? String(responseBody.created) : null;
      outputFormat = 'PNG';
    } else {
      const modelConfig = googleGenerationSettings?.models?.[selectedApi];

      if (!modelConfig?.url) {
        return res.status(400).json({ error: `Unsupported image API: ${selectedApi}` });
      }

      if (!googleSettings?.apiKey) {
        return res.status(400).json({ error: 'Google API key is not configured in settings' });
      }

      const payloadTemplate = googleGenerationSettings?.payloadTemplate;
      const requestPayload = replacePromptPlaceholder(payloadTemplate, trimmedPrompt);
      const headerName = googleGenerationSettings?.headerName || 'x-goog-api-key';

      response = await fetch(modelConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [headerName]: googleSettings.apiKey
        },
        body: JSON.stringify(requestPayload)
      });

      responseBody = await response.json();

      if (!response.ok) {
        console.error('Google image generation failed:', responseBody);
        return res.status(response.status).json({
          error: responseBody?.error?.message || 'Image generation request failed'
        });
      }

      inlineData = responseBody?.candidates
        ?.flatMap(candidate => candidate?.content?.parts || [])
        ?.find(part => part?.inlineData?.data)
        ?.inlineData;

      if (!inlineData?.data) {
        return res.status(502).json({ error: 'Image generation succeeded but no image data was returned' });
      }

      providerName = modelConfig.name;
      modelVersion = responseBody?.modelVersion || null;
      responseId = responseBody?.responseId || null;
      outputFormat = getExtensionFromMimeType(inlineData.mimeType).toUpperCase();
    }

    const extension = getExtensionFromMimeType(inlineData.mimeType);
    const imageBuffer = Buffer.from(inlineData.data, 'base64');
    const dimensions = getImageDimensionsFromBuffer(imageBuffer, {
      filename: `generated.${extension}`,
      mimeType: inlineData.mimeType
    });
    const newAsset = await saveRootAsset({
      projectId: Number(projectId),
      type: 'image',
      name: trimmedName,
      bytes: imageBuffer,
      extension,
      width: dimensions.width,
      height: dimensions.height,
      metadata: {
        resolution: formatImageResolution(dimensions.width, dimensions.height),
        format: outputFormat || extension.toUpperCase(),
        source: 'AI GEN',
        provider: providerName,
        modelVersion,
        mimeType: inlineData.mimeType,
        responseId,
        usage: responseBody?.usage || responseBody?.usageMetadata || null,
        ...(processingCardId ? { cardId: processingCardId } : {})
      },
      createdAt: Date.now(),
      detached: detachedAsset
    });

    if (!detachedAsset) {
      await clearCardProcessing(processingProjectId, processingCardId, {
        name: processingCardName
      });
    }

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Image generation failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Images',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to generate image',
        currentNodeLabel: 'Image generation failed',
        source: 'API',
        operationType: 'image-generation',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist image generation error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: 'Failed to generate and save image' });
  }
});

app.get('/api/tasks', async (req, res) => {
  const { projectId } = req.query;
  res.json(projectId ? await listProjectTasks(Number(projectId)) : []);
});

app.post('/api/tasks', async (req, res) => {
  try {
    res.status(201).json(await createTask(Number(req.body.projectId), req.body));
  } catch {
    res.status(500).json({ error: 'Task creation failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const currentSettings = await getSettings();
    const nextSettings = mergeDeep(currentSettings || DEFAULT_SETTINGS, req.body);
    res.json(await saveSettings(nextSettings));
  } catch {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/* app.get('/api/system/stats', async (req, res) => {
  try {
    const [cpu, mem, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.graphics()
    ]);

    // Get the primary GPU controller
    const gpu = graphics.controllers[0] || {};
    
    res.json({
      cpu: Math.round(cpu.currentLoad),
      ram: {
        used: (mem.active / 1024 / 1024 / 1024).toFixed(1),
        total: (mem.total / 1024 / 1024 / 1024).toFixed(1),
        percent: Math.round((mem.active / mem.total) * 100)
      },
      gpu: {
        name: gpu.model || 'N/A',
        utilization: gpu.utilizationGpu || 0,
        vramUsed: gpu.vramUsage ? (gpu.vramUsage / 1024).toFixed(1) : 0,
        vramTotal: gpu.vram ? (gpu.vram / 1024).toFixed(1) : 0
      }
    });
  } catch (err) {
    console.error('System stats error:', err);
    res.status(500).json({ error: 'Failed to fetch system stats' });
  }
}); */

// si.graphics() on Windows shells out to WMI/PowerShell and can take several
// seconds. Running it per-request (the footer polls every 3s) stacked up slow
// requests and saturated the browser's 6-connections-per-origin limit, stalling
// every other API call. Instead we refresh a cached snapshot in the background
// and serve it instantly.
let cachedSystemStats = null;
let systemStatsRefreshing = false;

async function refreshSystemStats() {
  if (systemStatsRefreshing) return;
  systemStatsRefreshing = true;
  try {
    const [cpu, mem, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.graphics()
    ]);

    // 1. Better Search: Find the card with the most VRAM (usually the dedicated one)
    // This works regardless of whether it's NVIDIA, AMD, or Intel Arc.
    const gpu = graphics.controllers.reduce((prev, current) => {
      return (current.vram > (prev.vram || 0)) ? current : prev;
    }, graphics.controllers[0] || {});

    // 2. Universal Mapping: Check for both 'memoryUsed' (NVIDIA style)
    // and 'vramUsage' (AMD/Standard style)
    const rawVramUsed = gpu.memoryUsed || gpu.vramUsage || 0;
    const rawVramTotal = gpu.memoryTotal || gpu.vram || 0;

    cachedSystemStats = {
      cpu: Math.round(cpu.currentLoad),
      ram: {
        used: (mem.active / (1024 ** 3)).toFixed(1),
        total: (mem.total / (1024 ** 3)).toFixed(1)
      },
      gpu: {
        name: gpu.model,
        vendor: gpu.vendor,
        // Convert to GB, handling the 0 case gracefully
        vramUsed: rawVramUsed > 0 ? (rawVramUsed / 1024).toFixed(1) : "0.0",
        vramTotal: rawVramTotal > 0 ? (rawVramTotal / 1024).toFixed(1) : "0.0",
        utilization: gpu.utilizationGpu || 0
      }
    };
  } catch (err) {
    console.error('Stats Error:', err);
  } finally {
    systemStatsRefreshing = false;
  }
}

// Kick off the first refresh immediately, then keep it warm in the background.
if (SERVER_MODE !== 'server') {
  refreshSystemStats();
  setInterval(refreshSystemStats, 5000);
}

app.get('/api/system/stats', (req, res) => {
  if (!cachedSystemStats) {
    return res.status(503).json({ error: 'Stats not ready yet' });
  }
  res.json(cachedSystemStats);
});

// ─── INITIAL SETUP ───

const SETUP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup');
const SETUP_CONFIG_PATH = path.join(SETUP_DIR, 'setup.json');
const SETUP_TYPE_TO_VALUE_TYPE = { Image: 'image', String: 'string', Number: 'number', Boolean: 'boolean', Mesh: 'mesh', Video: 'video' };
const setupDownloadJobs = new Map();

function getSetupDownloadJob(jobId) {
  if (!setupDownloadJobs.has(jobId)) {
    setupDownloadJobs.set(jobId, { subscribers: new Set(), snapshot: null });
  }
  return setupDownloadJobs.get(jobId);
}

function publishSetupDownloadProgress(jobId, payload) {
  const job = getSetupDownloadJob(jobId);
  const message = { jobId, timestamp: Date.now(), ...payload };
  job.snapshot = message;

  for (const response of job.subscribers) {
    response.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  if (message.status === 'done' || message.status === 'error') {
    setTimeout(() => {
      if (job.subscribers.size === 0) {
        setupDownloadJobs.delete(jobId);
      }
    }, 60000);
  }
}

function subscribeSetupDownload(jobId, req, res) {
  const job = getSetupDownloadJob(jobId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  job.subscribers.add(res);

  if (job.snapshot) {
    res.write(`data: ${JSON.stringify(job.snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.subscribers.delete(res);
  });
}

async function loadSetupConfig() {
  const raw = await fs.readFile(SETUP_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileSizeOrNull(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function resolveComfySubPath(comfyPath, relativePath, modelsPath) {
  const normalizedRelative = String(relativePath || '').replace(/^[/\\]+/, '');
  if (modelsPath) {
    const afterModels = normalizedRelative.replace(/^models[/\\]?/, '');
    if (afterModels !== normalizedRelative) {
      return path.join(modelsPath, afterModels);
    }
  }
  return path.join(comfyPath, normalizedRelative);
}

async function downloadFileWithProgress(url, destinationPath, onChunk) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  const totalBytes = Number(response.headers.get('content-length')) || 0;
  const tempPath = `${destinationPath}.part`;
  const writeStream = createWriteStream(tempPath);

  let receivedBytes = 0;

  try {
    for await (const chunk of response.body) {
      const writeOk = writeStream.write(chunk);
      if (!writeOk) {
        await new Promise(resolve => writeStream.once('drain', resolve));
      }
      receivedBytes += chunk.length;
      onChunk?.(receivedBytes, totalBytes);
    }

    await new Promise((resolve, reject) => {
      writeStream.end(err => err ? reject(err) : resolve());
    });

    await fs.rename(tempPath, destinationPath);
  } catch (err) {
    writeStream.destroy();
    try { await fs.unlink(tempPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  return { receivedBytes, totalBytes };
}

async function runSetupDownloads(jobId, comfyPath, files, modelsPath) {
  const totalExpectedBytes = files.reduce((sum, file) => sum + (Number(file.expectedBytes) || 0), 0);
  let cumulativeCompletedBytes = 0;

  publishSetupDownloadProgress(jobId, {
    status: 'downloading',
    currentIndex: 0,
    totalFiles: files.length,
    currentFile: files[0]?.fileName || '',
    currentBytes: 0,
    currentTotalBytes: 0,
    currentPercent: 0,
    overallPercent: 0
  });

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const destinationPath = resolveComfySubPath(comfyPath, path.join(file.relativeDir, file.fileName), modelsPath);

    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });

      const existingSize = await fileSizeOrNull(destinationPath);
      if (existingSize !== null && existingSize > 0) {
        cumulativeCompletedBytes += existingSize;
        publishSetupDownloadProgress(jobId, {
          status: 'downloading',
          currentIndex: index,
          totalFiles: files.length,
          currentFile: file.fileName,
          currentBytes: existingSize,
          currentTotalBytes: existingSize,
          currentPercent: 100,
          overallPercent: totalExpectedBytes > 0 ? Math.min(100, Math.round((cumulativeCompletedBytes / totalExpectedBytes) * 100)) : 0,
          skipped: true
        });
        continue;
      }

      let lastEmit = 0;
      let lastReceived = 0;

      const result = await downloadFileWithProgress(file.url, destinationPath, (currentBytes, currentTotalBytes) => {
        const now = Date.now();
        if (now - lastEmit < 200 && currentBytes < currentTotalBytes) {
          return;
        }
        lastEmit = now;
        lastReceived = currentBytes;

        publishSetupDownloadProgress(jobId, {
          status: 'downloading',
          currentIndex: index,
          totalFiles: files.length,
          currentFile: file.fileName,
          currentBytes,
          currentTotalBytes,
          currentPercent: currentTotalBytes > 0 ? Math.round((currentBytes / currentTotalBytes) * 100) : 0,
          overallPercent: totalExpectedBytes > 0 ? Math.min(100, Math.round(((cumulativeCompletedBytes + currentBytes) / totalExpectedBytes) * 100)) : 0
        });
      });

      cumulativeCompletedBytes += Math.max(result.receivedBytes, lastReceived);

      publishSetupDownloadProgress(jobId, {
        status: 'downloading',
        currentIndex: index,
        totalFiles: files.length,
        currentFile: file.fileName,
        currentBytes: result.receivedBytes,
        currentTotalBytes: result.totalBytes || result.receivedBytes,
        currentPercent: 100,
        overallPercent: totalExpectedBytes > 0 ? Math.min(100, Math.round((cumulativeCompletedBytes / totalExpectedBytes) * 100)) : 0
      });
    } catch (err) {
      console.error(`[setup] download failed for ${file.fileName}:`, err);
      publishSetupDownloadProgress(jobId, {
        status: 'error',
        currentIndex: index,
        totalFiles: files.length,
        currentFile: file.fileName,
        error: err.message || String(err)
      });
      return;
    }
  }

  publishSetupDownloadProgress(jobId, {
    status: 'done',
    totalFiles: files.length,
    currentIndex: files.length,
    overallPercent: 100
  });
}

async function installSetupWorkflow(workflowConfig, diffusionModelFileName = '', existingId = null) {
  if (!workflowConfig?.File) {
    throw new Error('Workflow configuration is missing a File path');
  }

  const absoluteWorkflowPath = path.join(path.dirname(fileURLToPath(import.meta.url)), workflowConfig.File);
  const rawJson = await fs.readFile(absoluteWorkflowPath, 'utf-8');
  const substitutedJson = diffusionModelFileName
    ? rawJson.replaceAll('{diffusion_model}', diffusionModelFileName)
    : rawJson;
  const workflowJson = JSON.parse(substitutedJson);

  const parsedWorkflow = parseComfyWorkflow(workflowJson);
  const availableParameters = new Map(parsedWorkflow.inputs.map(input => [input.id, input]));
  const availableOutputs = new Map(parsedWorkflow.outputs.map(output => [String(output.nodeId), output]));

  const parameters = [];
  for (const inputCfg of workflowConfig.Inputs || []) {
    const parameterId = `${inputCfg.Node}.${inputCfg.Input}`;
    const sourceParameter = availableParameters.get(parameterId);
    if (!sourceParameter) {
      throw new Error(`Workflow "${workflowConfig.Name}": input ${parameterId} not found`);
    }
    const valueType = normalizeComfyValueType(SETUP_TYPE_TO_VALUE_TYPE[inputCfg.Type], getDefaultComfyValueType(sourceParameter));
    parameters.push({
      ...sourceParameter,
      name: sanitizeDisplayName(inputCfg.Name || sourceParameter.name, sourceParameter.name),
      valueType,
      // Optional "Enums": [...] in setup.json turns the field into a dropdown.
      enums: normalizeComfyEnums(inputCfg.Enums, valueType)
    });
  }

  const outputs = [];
  for (const outputCfg of workflowConfig.Outputs || []) {
    const outputNodeId = String(outputCfg.Node);
    const sourceOutput = availableOutputs.get(outputNodeId);
    if (!sourceOutput) {
      throw new Error(`Workflow "${workflowConfig.Name}": output node ${outputNodeId} not found`);
    }
    outputs.push({
      ...sourceOutput,
      name: sanitizeDisplayName(outputCfg.Name || sourceOutput.nodeTitle, sourceOutput.nodeTitle),
      valueType: normalizeComfyValueType(SETUP_TYPE_TO_VALUE_TYPE[outputCfg.Type], 'image')
    });
  }

  if (outputs.length === 0) {
    throw new Error(`Workflow "${workflowConfig.Name}" has no outputs configured`);
  }

  const displayName = sanitizeDisplayName(workflowConfig.Name, 'Workflow');

  // Overwriting an existing install UPDATES it rather than replacing it, so the
  // id survives. Graph nodes, Batch stages and Kanban cards all store that id:
  // a delete-and-recreate turned every one of them into a dangling reference
  // that only failed when the user next hit Run.
  if (existingId) {
    return await updateWorkflow(
      existingId,
      { name: displayName, workflowJson, parameters, outputs },
      async () => {
        // Remember the graph file the record points at before repointing it, or
        // every reinstall leaves its predecessor behind. (The remote path does
        // this in the PUT route.)
        const previous = await getWorkflowRecordById(existingId);
        const filePath = await saveWorkflowFile(workflowConfig.Name, workflowJson);
        const record = await updateWorkflowRecord(existingId, { name: displayName, parameters, outputs, filePath });

        if (previous?.filePath && previous.filePath !== filePath) {
          try {
            await fs.unlink(toAbsoluteStoragePath(previous.filePath));
          } catch (cleanupErr) {
            console.warn('[setup] failed to remove the superseded workflow file:', cleanupErr.message);
          }
        }
        return record;
      }
    );
  }

  // Installs into the library on the shared server when this install is
  // connected to one, so the workflow follows the user to any machine.
  return await createWorkflow(
    {
      name: displayName,
      workflowJson,
      parameters,
      outputs
    },
    async () => {
      const filePath = await saveWorkflowFile(workflowConfig.Name, workflowJson);
      return await createWorkflowRecord({
        name: displayName,
        filePath,
        parameters,
        outputs
      });
    }
  );
}

async function pickFolderNative({ description = 'Select folder', initialPath = '' } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Native folder picker is only available on Windows');
  }

  const safeDescription = String(description).replace(/'/g, "''");
  const safeInitial = String(initialPath || '').replace(/'/g, "''");

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '${safeDescription}'
$dlg.ShowNewFolderButton = $false
if ('${safeInitial}'.Length -gt 0 -and (Test-Path -LiteralPath '${safeInitial}')) {
  $dlg.SelectedPath = '${safeInitial}'
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
try {
  $result = $dlg.ShowDialog($owner)
} finally {
  $owner.Close()
  $owner.Dispose()
}
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
`;

  return await new Promise((resolve, reject) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`));
        return;
      }
      const selected = stdout.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
      resolve(selected);
    });
  });
}

app.post('/api/setup/pick-folder', async (req, res) => {
  try {
    const description = String(req.body?.description || 'Select folder').slice(0, 200);
    const initialPath = String(req.body?.initialPath || '').slice(0, 1024);
    const selected = await pickFolderNative({ description, initialPath });
    res.json({ path: selected });
  } catch (err) {
    console.error('Folder picker failed:', err);
    res.status(500).json({ error: err.message || 'Folder picker failed' });
  }
});

app.get('/api/setup/config', async (req, res) => {
  try {
    res.json(await loadSetupConfig());
  } catch (err) {
    console.error('Failed to load setup config:', err);
    res.status(500).json({ error: err.message || 'Failed to load setup config' });
  }
});

app.post('/api/setup/check-comfy-path', async (req, res) => {
  try {
    const comfyPath = String(req.body?.path || '').trim();
    const modelsPath = String(req.body?.modelsPath || '').trim();
    if (!comfyPath) {
      return res.status(400).json({ error: 'A ComfyUI folder path is required' });
    }

    const rootExists = await pathExists(comfyPath);
    if (!rootExists) {
      return res.status(400).json({ error: `Folder does not exist: ${comfyPath}` });
    }

    if (modelsPath) {
      const modelsPathExists = await pathExists(modelsPath);
      if (!modelsPathExists) {
        return res.status(400).json({ error: `Models folder does not exist: ${modelsPath}` });
      }
    } else {
      const modelsDir = path.join(comfyPath, 'models');
      const modelsExist = await pathExists(modelsDir);
      if (!modelsExist) {
        return res.status(400).json({ error: `This does not look like a ComfyUI folder (missing "models" subfolder): ${comfyPath}` });
      }
    }

    const config = await loadSetupConfig();
    const created = [];
    for (const relativePath of Object.values(config.ComfyUIPaths || {})) {
      const target = resolveComfySubPath(comfyPath, relativePath, modelsPath);
      if (!(await pathExists(target))) {
        await fs.mkdir(target, { recursive: true });
        created.push(relativePath);
      }
    }

    res.json({ ok: true, comfyPath, modelsPath, createdSubfolders: created });
  } catch (err) {
    console.error('Failed to validate ComfyUI path:', err);
    res.status(500).json({ error: err.message || 'Failed to validate ComfyUI path' });
  }
});

app.post('/api/setup/check-files', async (req, res) => {
  try {
    const comfyPath = String(req.body?.comfyPath || '').trim();
    const modelsPath = String(req.body?.modelsPath || '').trim();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];

    if (!comfyPath) {
      return res.status(400).json({ error: 'comfyPath is required' });
    }

    const results = [];
    for (const file of files) {
      const absPath = resolveComfySubPath(comfyPath, path.join(file.relativeDir || '', file.fileName || ''), modelsPath);
      const size = await fileSizeOrNull(absPath);
      results.push({
        relativeDir: file.relativeDir || '',
        fileName: file.fileName || '',
        exists: size !== null && size > 0,
        sizeBytes: size
      });
    }

    res.json({ files: results });
  } catch (err) {
    console.error('Failed to check setup files:', err);
    res.status(500).json({ error: err.message || 'Failed to check setup files' });
  }
});

app.post('/api/setup/download', async (req, res) => {
  try {
    const comfyPath = String(req.body?.comfyPath || '').trim();
    const modelsPath = String(req.body?.modelsPath || '').trim();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];

    if (!comfyPath) {
      return res.status(400).json({ error: 'comfyPath is required' });
    }

    if (files.length === 0) {
      const jobId = randomUUID();
      publishSetupDownloadProgress(jobId, { status: 'done', totalFiles: 0, currentIndex: 0, overallPercent: 100 });
      return res.json({ jobId });
    }

    const jobId = randomUUID();
    getSetupDownloadJob(jobId);

    runSetupDownloads(jobId, comfyPath, files, modelsPath).catch(err => {
      console.error('[setup] download job crashed:', err);
      publishSetupDownloadProgress(jobId, { status: 'error', error: err.message || String(err) });
    });

    res.json({ jobId });
  } catch (err) {
    console.error('Failed to start setup downloads:', err);
    res.status(500).json({ error: err.message || 'Failed to start setup downloads' });
  }
});

app.get('/api/setup/download/progress/:jobId', (req, res) => {
  subscribeSetupDownload(req.params.jobId, req, res);
});

app.post('/api/setup/install-workflows', async (req, res) => {
  try {
    const workflows = Array.isArray(req.body?.workflows) ? req.body.workflows : [];
    const overwrite = req.body?.overwrite === true;

    if (workflows.length === 0) {
      return res.json({ installed: [], skipped: [], errors: [] });
    }

    const config = await loadSetupConfig();
    const packByName = new Map((config.Models || []).map(model => [model.Name, model]));
    const workflowsByFile = new Map();
    for (const pack of config.Models || []) {
      for (const workflow of pack.Workflows || []) {
        workflowsByFile.set(workflow.File, { workflow, pack });
      }
    }
    for (const workflow of config.OtherWorkflows || []) {
      workflowsByFile.set(workflow.File, { workflow, pack: null });
    }

    const existingByName = new Map();
    for (const record of await listWorkflows()) {
      existingByName.set(sanitizeDisplayName(record.name, 'Workflow'), record);
    }

    const installed = [];
    const skipped = [];
    const errors = [];

    for (const selection of workflows) {
      const entry = workflowsByFile.get(selection.workflowFile);
      if (!entry) {
        errors.push({ workflowFile: selection.workflowFile, error: 'Unknown workflow' });
        continue;
      }

      const { workflow: workflowConfig, pack } = entry;
      const normalizedName = sanitizeDisplayName(workflowConfig.Name, 'Workflow');
      const existing = existingByName.get(normalizedName);

      if (existing && !overwrite) {
        skipped.push({ name: normalizedName, reason: 'already-installed' });
        continue;
      }

      // Only packs that ship quality variants have a {diffusion_model} placeholder to
      // fill in; checkpoint-only packs reference their file inside the workflow itself.
      let diffusionFileName = '';
      const packRecord = selection.modelName ? packByName.get(selection.modelName) : pack;
      if (packRecord?.DiffusionModels) {
        const modelEntry = packRecord.DiffusionModels[selection.modelQuality];
        if (!modelEntry?.FileName) {
          errors.push({ workflow: normalizedName, error: 'Missing diffusion model selection' });
          continue;
        }
        diffusionFileName = modelEntry.FileName;
      }

      try {
        // Deliberately NOT a delete-then-create: overwriting reuses the record
        // so its id -- which every saved node and Batch stage points at --
        // survives the reinstall.
        const record = await installSetupWorkflow(
          workflowConfig,
          diffusionFileName,
          existing && overwrite ? existing.id : null
        );
        existingByName.set(normalizedName, record);
        installed.push({ id: record.id, name: record.name, overwritten: Boolean(existing) });
      } catch (err) {
        console.error(`[setup] failed to install workflow ${workflowConfig?.Name}:`, err);
        errors.push({ workflow: normalizedName, error: err.message || String(err) });
      }
    }

    res.json({ installed, skipped, errors });
  } catch (err) {
    console.error('Failed to install setup workflows:', err);
    res.status(500).json({ error: err.message || 'Failed to install setup workflows' });
  }
});

// Start server
// Copy any media referenced from the legacy data/assets/wiki location into the
// git-tracked wiki/media folder and rewrite the URLs so docs ship with the app.
async function rewriteAndCopyWikiMedia(content) {
  if (!content) return content;
  const regex = /(?:https?:\/\/[^/\s)]+)?\/assets\/wiki\/([^\s)"'<>]+)/g;
  const matches = [...content.matchAll(regex)];
  let result = content;
  for (const match of matches) {
    const fileName = decodeURIComponent(match[1]);
    try {
      await fs.copyFile(path.join(WIKI_ASSETS_DIR, fileName), path.join(WIKI_MEDIA_DIR, fileName));
    } catch {
      // source missing — leave the reference, nothing to copy
    }
    const newUrl = `http://localhost:${PORT}/wiki-media/${encodeURIComponent(fileName)}`;
    result = result.split(match[0]).join(newUrl);
  }
  return result;
}

async function migrateWikiIfNeeded() {
  if (wikiManifestExists()) return;

  let dbRows = [];
  try {
    dbRows = await dbListWikiPages();
  } catch {
    dbRows = [];
  }

  if (dbRows.length > 0) {
    await fs.mkdir(WIKI_MEDIA_DIR, { recursive: true });
    const fullPages = [];
    for (const row of dbRows) {
      const page = await dbGetWikiPage(row.id);
      if (!page) continue;
      page.content = await rewriteAndCopyWikiMedia(page.content);
      fullPages.push(page);
    }
    await importWikiPages(fullPages);
    console.log(`📚 Migrated ${fullPages.length} wiki page(s) from the database into the wiki/ folder`);
  } else {
    await seedWikiFiles();
    console.log('📚 Seeded the wiki/ folder with default documentation');
  }
}

// SPA fallback: any GET that isn't an API/asset/media route and didn't match a
// static file is a client-side (react-router) route — serve index.html so deep
// links work on a full reload. Registered last so it never shadows real routes.
if (HAS_DIST) {
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (/^\/(api|wiki-media|mcp)(\/|$)/.test(req.path)) return next();
    // `/assets/<file>` is a stored asset file (served above, or a genuine 404) —
    // never the SPA. But bare `/assets` and `/assets/` ARE the Assets Library
    // client route, so they must fall through to index.html on a full reload.
    if (/^\/assets\/.+/.test(req.path)) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// Brings up the database the app is configured to use, before anything opens
// it. Three cases:
//
//   GENSTUDIO_DATABASE_URL set  -> an external PostgreSQL (Docker Compose, or
//                                  one you run yourself). Nothing to do here.
//   GENSTUDIO_DATABASE=embedded -> 3D Gen Studio installs and runs its own
//                                  PostgreSQL under the data directory. This is
//                                  the shared-server path for a machine that is
//                                  not running Docker.
//   neither                     -> SQLite, which is every desktop install.
async function bootstrapDatabase() {
  const wantsEmbedded = String(process.env.GENSTUDIO_DATABASE || '').toLowerCase() === 'embedded';

  if (wantsEmbedded && !process.env.GENSTUDIO_DATABASE_URL) {
    if (!pgEmbedded.isAvailableHere()) {
      throw new Error(pgEmbedded.unavailableReason());
    }
    // The first run downloads a few hundred megabytes, so say what is going on
    // rather than looking hung.
    const url = await pgEmbedded.start({
      dataRoot: DATA_DIR,
      onStatus: message => console.log(`🐘 ${message}`)
    });
    // storage.js reads this when it opens the database, which has not happened
    // yet — the whole point of doing this first.
    process.env.GENSTUDIO_DATABASE_URL = url;
  }

  if (selectedDialect() === 'postgres') {
    console.log(`DEBUG: database is PostgreSQL${wantsEmbedded ? ' (managed by 3D Gen Studio)' : ''}`);
  } else {
    console.log('DEBUG: database is SQLite at', path.join(DATA_DIR, 'app.db'));
  }
}

// Stop the embedded server with the app. Without this it survives as an orphan;
// the next start adopts it rather than failing, but a machine slowly collecting
// stray postgres processes is not a good look.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    pgEmbedded.stop().finally(() => process.exit(0));
  });
}

bootstrapDatabase().then(() => initializeStorage()).then(async () => {
  // Server mode comes up usable without a shell: create the first admin from
  // the environment when the Users table is still empty. A no-op afterwards.
  if (SERVER_MODE === 'server') {
    try {
      await seedAdminFromEnv();
    } catch (err) {
      // Fatal on purpose. This used to be a console.warn, which meant the
      // container came up "healthy" with no account at all and the only
      // symptom was "Invalid credentials" for a user that was never created.
      console.error(`\n❌ Could not create the initial administrator: ${err.message}`);
      console.error('   The server has no usable account, so it is refusing to start.');
      console.error('   Fix GENSTUDIO_ADMIN_LOGIN / GENSTUDIO_ADMIN_PASSWORD in your .env and restart.\n');
      process.exit(1);
    }
  }

  try {
    await migrateWikiIfNeeded();
  } catch (err) {
    console.warn('Failed to prepare wiki documentation folder:', err.message);
  }

  // Staged import bundles are abandoned by definition at startup: nothing can be
  // in flight in a process that has only just booted. An import that lost its
  // connection halfway through would otherwise leave a full copy of the project
  // on disk forever, since the route that cleans up never runs.
  try {
    await fs.rm(IMPORT_STAGING_ROOT, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to clear staged import bundles on startup:', err.message);
  }

  // Skipped in server mode: from Phase 4 on, a card marked "processing" is
  // being worked on by some user's LOCAL machine, which this container knows
  // nothing about, so clearing on restart would cancel live runs in the UI.
  // A timestamp-based sweep belongs here instead, once runs are attributable.
  if (SERVER_MODE !== 'server') {
    try {
      const cleared = await clearStaleProcessingCards({
        preservedSources: ['Tencent Cloud', 'Tripo AI', 'Hitem3D']
      });
      if (cleared > 0) {
        console.log(`🧹 Cleared ${cleared} stale processing card(s) on startup`);
      }
    } catch (err) {
      console.warn('Failed to clear stale processing cards on startup:', err.message);
    }
  }

  const server = app.listen(PORT, () => {
    publishRuntimeInfo(PORT);
    console.log(`🚀 3D Gen Studio Backend running at http://localhost:${PORT}`);
    console.log(`📁 Local Workspace: ${DATA_DIR}`);
    if (PUBLIC_BASE_URL) {
      console.log(`🌐 External base URL pinned by PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
    } else {
      console.log(`🌐 External base URL: derived per request${TRUST_PROXY_HEADERS ? ' (X-Forwarded-Proto/Host/Port honoured)' : ' (forwarded headers ignored — TRUST_PROXY_HEADERS=0)'} — logged on the first request`);
    }
    if (HAS_DIST) {
      console.log(`🖥️  Serving bundled UI from dist/ — open http://localhost:${PORT}`);
    } else {
      console.log('ℹ️  No dist/ build found — run "npm run build" to serve the UI from this server.');
    }
  });

  // A port collision is the one startup failure with an obvious fix, so say what
  // it is. The desktop shell picks a free port before spawning this process, but
  // that check and this bind are not atomic — and a bare `npm start` or a
  // container with a clashing publish gets here with no shell to help.
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    // The banner above may already have printed: binding the unspecified address
    // can report `listening` for the IPv6 half and only then fail on the IPv4 one,
    // so say plainly that the server is not up.
    console.error(
      `❌ Port ${PORT} is already in use — another 3D Gen Studio (or another program) has it.\n` +
      `   The backend did NOT start.\n` +
      `   Start it on a different port with:  PORT=${PORT + 1} npm start`
    );
    process.exit(1);
  });
}).catch(err => {
  // Without this, a storage failure becomes an unhandled rejection, which the
  // global handler above deliberately survives -- so the process stayed alive
  // having never started listening, and the only symptom was a server that
  // answered nothing. A database that will not open is fatal, and says so.
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
