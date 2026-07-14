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
