// Client helpers for the Python mesh-tools service (Auto UV / Auto Retopo).
//
// These call the Node proxy routes (/api/meshes/auto-uv, /api/meshes/auto-retopo),
// which forward to the configurable Python service. Pass the mesh as a Blob/File
// (a GLB exported from the editor via utils/meshExport.js works directly).
//
// The service returns a JSON envelope { format, mesh_b64, stats, preview_b64 };
// this helper decodes it into { blob, stats, previewUrl }.
import { API_BASE } from '../config'

// Decode a base64 string into a Blob of the given MIME type.
function base64ToBlob(base64, type) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type })
}

// Parse the Server-Sent Events stream. Calls onProgress for each progress event
// and resolves with the terminal "done" event payload. Throws on "error".
async function readSseStream(response, onProgress) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneEvent = null

  const handleEvent = raw => {
    const dataLine = raw.split('\n').find(line => line.startsWith('data:'))
    if (!dataLine) return
    let evt
    try {
      evt = JSON.parse(dataLine.slice(5).trim())
    } catch {
      return
    }
    if (evt.type === 'progress') {
      onProgress?.(evt)
    } else if (evt.type === 'done') {
      doneEvent = evt
    } else if (evt.type === 'error') {
      throw new Error(evt.detail || 'The mesh tool reported an error.')
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      handleEvent(raw)
    }
  }
  if (buffer.trim()) handleEvent(buffer)

  if (!doneEvent) {
    throw new Error('The mesh tool finished without returning a result.')
  }
  return doneEvent
}

async function callMeshTool(endpoint, meshBlob, { options = {}, fileName = 'mesh.glb', format = 'glb', onProgress = null } = {}) {
  const form = new FormData()
  form.append('meshFile', meshBlob, fileName)
  form.append('options', JSON.stringify(options))
  form.append('format', format)

  const response = await fetch(`${API_BASE}${endpoint}`, { method: 'POST', body: form })

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const payload = await response.json()
      message = payload.detail ? `${payload.error}: ${JSON.stringify(payload.detail)}` : (payload.error || message)
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message)
  }

  const data = await readSseStream(response, onProgress)
  const outFormat = data.format || 'glb'
  const mimeType = outFormat === 'glb' ? 'model/gltf-binary' : 'application/octet-stream'
  const blob = base64ToBlob(data.mesh_b64, mimeType)
  const s = data.stats || {}

  return {
    blob,
    stats: {
      vertexCount: s.vertex_count ?? null,
      faceCount: s.face_count ?? null,
      hasUv: !!s.has_uv,
      tool: s.tool || null,
    },
    previewUrl: data.preview_b64 ? `data:image/png;base64,${data.preview_b64}` : null,
  }
}

export function autoUv(meshBlob, opts = {}) {
  return callMeshTool('/meshes/auto-uv', meshBlob, opts)
}

export function autoRetopo(meshBlob, opts = {}) {
  return callMeshTool('/meshes/auto-retopo', meshBlob, opts)
}

// Non-manifold / topology repair. Same SSE contract as Auto UV / Auto Retopo;
// the tool stats carry before/after non-manifold + boundary edge counts.
export function repairMesh(meshBlob, opts = {}) {
  return callMeshTool('/meshes/repair', meshBlob, opts)
}

// Runs the bundled gltfpack binary server-side (not the Python service). Unlike
// the SSE-based tools above, this returns a single JSON envelope with the
// simplified GLB as base64. Same { blob, stats, previewUrl } contract so it
// plugs into runMeshTool alongside Auto UV / Auto Retopo.
export async function optimizeMesh(meshBlob, { options = {}, fileName = 'mesh.glb', onProgress = null } = {}) {
  const form = new FormData()
  form.append('meshFile', meshBlob, fileName)
  form.append('options', JSON.stringify(options))

  onProgress?.({ type: 'progress', stage: 'run', frac: 0.3, message: 'Optimizing…' })

  const response = await fetch(`${API_BASE}/meshes/optimize`, { method: 'POST', body: form })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const payload = await response.json()
      message = payload.error || message
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message)
  }

  const data = await response.json()
  const blob = base64ToBlob(data.mesh_b64, 'model/gltf-binary')
  return { blob, stats: data.stats || null, previewUrl: null }
}
