// Preload bridges.
//   - genStudioDesktop: read-only marker so the web UI can tell it runs in the
//     desktop shell.
//   - genStudioSetup: used ONLY by the first-run setup window (setup.html) to
//     drive the Python provisioning and stream progress. Harmless elsewhere.
//   - genStudioPortPrompt: used ONLY by the port-conflict window
//     (portPrompt.html), shown when the backend's usual port is taken.
//     Harmless elsewhere.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('genStudioDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version || null,
});

// Start/stop the on-demand Python services (Mesh Tools, Rigging). Used by the
// mesh-editor tool handlers (ensure the right service is up before a request)
// and by Settings (manual Start/Stop). No-op semantics outside the desktop app,
// where the services are launched externally.
contextBridge.exposeInMainWorld('genStudioServices', {
  isDesktop: true,
  // Ensure a service is running + healthy before use. name: 'meshtools' | 'rigging'.
  ensure: (name) => ipcRenderer.invoke('services:ensure', { name }),
  start: (name) => ipcRenderer.invoke('services:start', { name }),
  stop: (name) => ipcRenderer.invoke('services:stop', { name }),
  status: () => ipcRenderer.invoke('services:status'),
  // Re-point apis.comfyui.* at the managed install. Resolves { ok, port, path,
  // modelsPath } or { ok: false, error }.
  useManagedComfy: () => ipcRenderer.invoke('comfyui:use-managed'),

  // Managed ComfyUI upgrades. Installing a newer app version leaves an existing
  // ComfyUI on its old pins, so Settings offers this explicitly.
  //   checkComfyUpdate -> { ok, plan } — what the shipped manifest wants vs what
  //     is installed (node pack refs, ComfyUI ref, dependency lock, torch, and
  //     packages that are no longer needed). Cheap: no network, no changes.
  //   updateComfyUI    -> { ok, changed, summary, wasRunning } — applies it.
  //   reinstallComfyUI -> { ok } — wipes code + venv and installs fresh, for when
  //     an update can't be incremental (a Python version bump). Models are kept.
  // Progress for the last two streams through genStudioSetup.onProgress tagged
  // `service: 'comfyui-update'`.
  checkComfyUpdate: () => ipcRenderer.invoke('comfyui:update-check'),
  updateComfyUI: () => ipcRenderer.invoke('comfyui:update-run'),
  reinstallComfyUI: () => ipcRenderer.invoke('comfyui:reinstall'),
});

contextBridge.exposeInMainWorld('genStudioSetup', {
  // Kick off provisioning. opts: { rigging: boolean }. Resolves to { ok, error }.
  run: (opts) => ipcRenderer.invoke('setup:run', opts),
  // Which services are provisioned: { desktop, meshtools, rigging }.
  status: () => ipcRenderer.invoke('setup:status'),
  // Subscribe to progress events: { service, kind, phase, pct, text }.
  // Returns an unsubscribe function.
  onProgress: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.removeListener('setup:progress', handler);
  },
  // Tell the main process the user is done and the app can launch (first-run window).
  finish: () => ipcRenderer.send('setup:finish'),
});

contextBridge.exposeInMainWorld('genStudioPortPrompt', {
  // Live-validate a candidate port as still free. Resolves { ok, free, error? }.
  check: (port) => ipcRenderer.invoke('port-prompt:check', { port }),
  // Confirm the chosen port. Fire-and-forget — main closes the window once it
  // receives this (mirrors genStudioSetup.finish's send/on shape).
  confirm: (port) => ipcRenderer.send('port-prompt:confirm', { port }),
});
