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

async function callMeshTool(endpoint, meshBlob, { options = {}, fileName = 'mesh.glb', format = 'glb' } = {}) {
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

  const data = await response.json()
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
