// Preload bridges.
//   - genStudioDesktop: read-only marker so the web UI can tell it runs in the
//     desktop shell.
//   - genStudioSetup: used ONLY by the first-run setup window (setup.html) to
//     drive the Python provisioning and stream progress. Harmless elsewhere.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('genStudioDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version || null,
});

// Start/stop the on-demand Python services (Mesh Tools, Rigging, Motion). Used by the
// mesh-editor tool handlers (ensure the right service is up before a request)
// and by Settings (manual Start/Stop). No-op semantics outside the desktop app,
// where the services are launched externally.
contextBridge.exposeInMainWorld('genStudioServices', {
  isDesktop: true,
  // Ensure a service is running + healthy before use.
  // name: 'meshtools' | 'rigging' | 'motion' | 'comfyui'.
  ensure: (name) => ipcRenderer.invoke('services:ensure', { name }),
  start: (name) => ipcRenderer.invoke('services:start', { name }),
  stop: (name) => ipcRenderer.invoke('services:stop', { name }),
  status: () => ipcRenderer.invoke('services:status'),
  // Does this URL/port (straight from the Settings form) name another computer,
  // and does the service answer there? -> { ok, remote, address, reachable,
  // error, lanAddresses }. name: 'meshtools' | 'rigging' | 'motion' | 'mocap'.
  target: (name, url, port) => ipcRenderer.invoke('services:target', { name, url, port }),
  // Re-point apis.comfyui.* at the managed install. Resolves { ok, port, path,
  // modelsPath } or { ok: false, error }.
  useManagedComfy: () => ipcRenderer.invoke('comfyui:use-managed'),
  // NVIDIA GPUs on this computer -> { ok, gpus: [{ index, uuid, name, memoryMB }] }.
  // The managed ComfyUI runs on the one whose uuid is in apis.comfyui.gpu.
  listComfyGpus: () => ipcRenderer.invoke('comfyui:list-gpus'),

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

  // Open the log directory in the OS file manager. The Logs panel reads log
  // CONTENT over the API (/api/logs) — this is only for attaching the files to
  // a bug report, and for reaching the previous session's *.prev.log.
  openLogsFolder: () => ipcRenderer.invoke('logs:open-folder'),

  // "Clear the logs at startup" (the Logs panel checkbox). This one preference
  // lives with the shell, not in the settings DB, because the shell rotates the
  // logs before the backend — and its settings store — is running.
  //   getLogPrefs -> { ok, clearAtStartup }
  //   setLogPrefs({ clearAtStartup }) -> { ok, clearAtStartup } | { ok: false, error }
  getLogPrefs: () => ipcRenderer.invoke('logs:get-prefs'),
  setLogPrefs: (prefs) => ipcRenderer.invoke('logs:set-prefs', prefs),
});

contextBridge.exposeInMainWorld('genStudioSetup', {
  // Kick off provisioning. opts: { rigging, motion, comfyui } booleans, each
  // naming an opt-in service to install. Resolves to { ok, error }.
  run: (opts) => ipcRenderer.invoke('setup:run', opts),
  // Which services are provisioned: { desktop, meshtools, rigging, motion, comfyui }.
  status: () => ipcRenderer.invoke('setup:status'),
  // Subscribe to progress events: { service, kind, phase, pct, text }.
  // Returns an unsubscribe function.
  onProgress: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.removeListener('setup:progress', handler);
  },
  // Meta Llama 3 licence, which the motion service's text encoder is built on.
  // Installing it is gated on acceptance in the main process, so both installers
  // (first-run window and Settings) show the same text and record the same consent.
  //   llamaLicense       -> { ok, accepted, text }
  //   acceptLlamaLicense -> { ok, accepted }
  llamaLicense: () => ipcRenderer.invoke('license:llama3'),
  acceptLlamaLicense: () => ipcRenderer.invoke('license:llama3-accept'),
  // Tell the main process the user is done and the app can launch (first-run window).
  finish: () => ipcRenderer.send('setup:finish'),
});
