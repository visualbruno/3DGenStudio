// Central place to resolve where the backend (server.js) lives.
//
// Set VITE_SERVER_ORIGIN in a .env file to point the frontend at a backend on
// another computer or port, e.g.
//   VITE_SERVER_ORIGIN=http://192.168.1.50:3001
// Leave it as an empty string ("") to use the same origin the app was served
// from — useful once Express serves the built UI itself (single origin).
// When unset, it defaults to the local dev backend.
const rawOrigin = import.meta.env.VITE_SERVER_ORIGIN

export const SERVER_ORIGIN = (rawOrigin === undefined ? 'http://localhost:3001' : rawOrigin)
  .replace(/\/$/, '')

export const API_BASE = `${SERVER_ORIGIN}/api`

// Build a URL to a static asset served from the backend's /assets mount.
export function assetUrl(pathOrFilename) {
  return `${SERVER_ORIGIN}/assets/${encodeURI(pathOrFilename)}`
}
