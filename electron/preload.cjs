// Minimal preload. The UI is a normal same-origin web app served by the
// backend, so it needs no privileged bridge today. We expose only a tiny,
// read-only marker so the frontend can detect it's running inside the desktop
// shell (e.g. to hide "open in browser" hints) without granting Node access.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('genStudioDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version || null,
});
