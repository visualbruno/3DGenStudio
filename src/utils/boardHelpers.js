// Pure helpers for the Brainstorming Board (BoardPage). No React state.

// Fields of Excalidraw's appState that are safe + useful to persist. We
// deliberately drop transient/unserializable ones (collaborators, selection,
// cursor, etc.) so re-hydrating via initialData never crashes.
export function sanitizeBoardAppState(appState = {}) {
  const { viewBackgroundColor, scrollX, scrollY, zoom, gridSize } = appState
  return {
    viewBackgroundColor: viewBackgroundColor ?? '#0d0e10',
    scrollX: Number.isFinite(scrollX) ? scrollX : 0,
    scrollY: Number.isFinite(scrollY) ? scrollY : 0,
    zoom: zoom && Number.isFinite(zoom.value) ? { value: zoom.value } : { value: 1 },
    gridSize: gridSize ?? null
  }
}

// A cheap change signature so the debounced autosave skips redundant writes
// (e.g. the initial onChange that echoes the data we just loaded, or pure
// selection changes which live in appState we don't include here).
export function boardStateSignature(elements = [], appState = {}) {
  const sanitized = sanitizeBoardAppState(appState)
  const elementSig = elements.map(el => `${el.id}:${el.version}`).join(',')
  return JSON.stringify({ e: elementSig, a: sanitized })
}

// Normalize an asset path to the served (url) form assetUrl() expects. Assets
// created as edits return a stored filePath ("data/assets/images/x.png") with no
// filename field; the served mount strips the "data/assets/" prefix.
export function toServedAssetPath(pathOrFilename) {
  return String(pathOrFilename || '').replace(/\\/g, '/').replace(/^data\/assets\//, '')
}

export function mimeFromName(name = '') {
  const ext = String(name).split('.').pop().toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/png'
}

export function extFromMime(mime = '') {
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('svg')) return 'svg'
  return 'png'
}

// Fetch a served asset URL and return it as a data URL (Excalidraw renders
// images from data URLs in its `files` map).
export async function urlToDataURL(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)
  const blob = await res.blob()
  return await blobToDataURL(blob)
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Failed to read image blob'))
    reader.readAsDataURL(blob)
  })
}

export function dataURLToFile(dataURL, filename) {
  const [meta, b64] = String(dataURL).split(',')
  const mime = /data:(.*?)(;|$)/.exec(meta)?.[1] || 'image/png'
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], filename, { type: mime })
}

// Natural pixel size of a data URL, capped so huge renders land at a usable
// size on the canvas while preserving aspect ratio.
export function measureImage(dataURL, maxDimension = 720) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { naturalWidth: w, naturalHeight: h } = img
      if (!w || !h) { resolve({ width: 512, height: 512 }); return }
      const largest = Math.max(w, h)
      if (largest > maxDimension) {
        const scale = maxDimension / largest
        w = Math.round(w * scale)
        h = Math.round(h * scale)
      }
      resolve({ width: w, height: h })
    }
    img.onerror = () => resolve({ width: 512, height: 512 })
    img.src = dataURL
  })
}
