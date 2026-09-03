// Client helpers for the Python mesh-tools service (Auto UV / Auto Retopo).
//
// These call the Node proxy routes (/api/meshes/auto-uv, /api/meshes/auto-retopo),
// which forward to the configurable Python service. Pass the mesh as a Blob/File
// (a GLB exported from the editor via utils/meshExport.js works directly).
//
// The service returns a JSON envelope { format, mesh_b64, stats, preview_b64 };
// this helper decodes it into { blob, stats, previewUrl }.
import { API_BASE } from '../config'

// Only for the fallback message below — the main process supplies a real error
// for every failure it can describe, and this covers the ones it can't.
const SERVICE_LABELS = {
  meshtools: 'Mesh Tools',
  rigging: 'Rigging',
  motion: 'Motion Generation',
  mocap: 'Video to Motion',
  comfyui: 'ComfyUI',
}

// In the desktop app the Python services (Mesh Tools, Rigging, Motion) are
// started on demand. Call this before a request that needs one — it starts the
// service and waits until it's healthy. Outside the desktop app it's a no-op (the
// services are launched externally).
// name: 'meshtools' | 'rigging' | 'motion' | 'comfyui'.
export async function ensureDesktopService(name) {
  const svc = typeof window !== 'undefined' ? window.genStudioServices : null
  if (!svc?.isDesktop) return
  const res = await svc.ensure(name)
  if (!res?.ok) {
    throw new Error(res?.error || `Could not start the ${SERVICE_LABELS[name] || name} service.`)
  }
}

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
// Exported for the motion service (src/utils/motionGen.js), which speaks the same
// SSE contract over a JSON request instead of a mesh upload.
export async function readSseStream(response, onProgress) {
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

// Lived in MeshEditorPage until the export dialog needed to unwrap too. Kept
// here with the other DEFAULT_*_OPTIONS so both callers unwrap identically.
export const DEFAULT_AUTO_UV_OPTIONS = {
  max_cone_deg: 50,
  sharp_weight: 0.35,
  min_faces: 20,
  min_area_frac: 0.004,
  fold_cap_deg: 88,
  refine: true,
  refine_target_faces: 80,
  refine_ad_thresh: 1.32,
  method: 'auto',
  arap_iters: 4,
  resolution: 1024,
  padding_texels: 4,
  weld: true,
  weld_tol_frac: 0.1,
  preserve_normals: true,
  normal_smooth_deg: 180,
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

// GLB -> FBX engine-preset conversion (headless Blender in the mesh-tools
// service). options: { preset: 'unity'|'unreal'|'generic', ... } — see the
// service's ConvertOptions. Same SSE contract; the returned blob is the FBX and
// stats.tool carries { bones, meshes, clips, preset, validation }.
export function convertMesh(meshBlob, opts = {}) {
  return callMeshTool('/meshes/convert', meshBlob, { ...opts, format: 'fbx' })
}

// Convex collision hulls (CoACD decomposition in the mesh-tools service). Same
// SSE contract as the tools above; the returned blob is a GLB *scene* with one
// node per hull (named collision_01, collision_02, …) and stats.tool carries
// { method, parts, faces, volume_ratio, fallback }.
export function generateCollision(meshBlob, opts = {}) {
  return callMeshTool('/meshes/collision', meshBlob, opts)
}

// Mirrors CollisionOptions in python-server/app/schemas.py. The CoACD search
// parameters sit well below its own defaults on purpose — decomposition costs
// tens of seconds no matter how light the mesh is, because the work is in the
// search over cut planes, and a collider does not need the fidelity the slower
// settings buy.
export const DEFAULT_COLLISION_OPTIONS = {
  method: 'convex_hull',
  max_hulls: 16,
  threshold: 0.25,
  input_faces: 1000,
  max_hull_vertices: 64,
  resolution: 1000,
  mcts_nodes: 6,
  mcts_iterations: 40,
  mcts_max_depth: 2,
  preprocess_resolution: 50,
  seed: 0,
}

export const COLLISION_METHOD_OPTIONS = [
  { value: 'convex_hull', label: 'Single convex hull — instant' },
  { value: 'decomposition', label: 'Convex decomposition — accurate, ~1 min' },
  { value: 'box', label: 'Box — instant' },
  { value: 'sphere', label: 'Sphere — instant' },
]

// High-to-low texture bake. Takes TWO meshes — the low-poly target (needs UVs)
// and the high-poly source whose detail is captured — and returns IMAGES, not a
// mesh, so it does not go through callMeshTool's single-file/mesh_b64 contract.
// Resolves to { maps: { normal?: Blob, ao?: Blob, base_color?: Blob }, stats }.
export async function bakeMaps(lowBlob, highBlob, { options = {}, fileName = 'low.glb', sourceName = 'high.glb', onProgress = null } = {}) {
  const form = new FormData()
  form.append('meshFile', lowBlob, fileName)
  form.append('sourceFile', highBlob, sourceName)
  form.append('options', JSON.stringify(options))

  const response = await fetch(`${API_BASE}/meshes/bake`, { method: 'POST', body: form })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const payload = await response.json()
      message = payload.detail ? `${payload.error}: ${payload.detail}` : (payload.error || message)
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message)
  }

  const data = await readSseStream(response, onProgress)
  const maps = {}
  for (const [name, base64] of Object.entries(data.maps || {})) {
    maps[name] = base64ToBlob(base64, 'image/png')
  }
  return { maps, stats: data.stats?.tool || null }
}

export const DEFAULT_BAKE_OPTIONS = {
  maps: ['normal', 'ao'],
  resolution: 2048,
  samples: 8,
  cage_extrusion: 0,
  max_ray_distance: 0,
  margin: 8,
}

export const BAKE_MAP_LABELS = {
  normal: 'Normal (tangent space)',
  ao: 'Ambient occlusion',
  base_color: 'Base colour (albedo)',
  roughness: 'Roughness',
  metallic: 'Metallic',
  // Only appears in results, never as a request: the service packs it from the
  // three channels above because that is the layout glTF stores them in.
  orm: 'Packed ORM (AO / rough / metal)',
}

// Game-Ready check. Read-only: returns a report, never a mesh, so this is a plain
// JSON round trip rather than the SSE contract the mesh-returning tools use.
// Resolves to { checks: [...], summary: {...}, stats: {...} } — see
// python-server/app/services/inspect.py for the shape.
export async function inspectMesh(meshBlob, { options = {}, fileName = 'mesh.glb' } = {}) {
  const form = new FormData()
  form.append('meshFile', meshBlob, fileName)
  form.append('options', JSON.stringify(options))

  const response = await fetch(`${API_BASE}/meshes/inspect`, { method: 'POST', body: form })
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
  return await response.json()
}

// Budgets the Game-Ready check grades against (see InspectOptions). These are
// deliberately generous defaults — a hero prop and a background rock disagree
// about every one of them, so the panel exposes them.
export const DEFAULT_INSPECT_OPTIONS = {
  tri_budget: 50000,
  texture_resolution: 2048,
  max_material_count: 4,
  uv_overlap_grid: 512,
  uv_scan_max_faces: 60000,
  max_extent: 50,
  min_extent: 0.01,
  expect_ground_pivot: false,
}

// The gltfpack simplifier knobs, shared by Optimize and the LOD chain so a new
// option cannot reach one path and quietly miss the other.
//
// simplify_error is the important one: it maps to gltfpack's -se, whose own
// default (0.01) is what stops most meshes short of their target ratio. Raising
// it reaches the target by moving the surface, which costs nothing in normals or
// UVs — unlike `aggressive`, which reaches it by rebuilding the vertex set.
export const DEFAULT_SIMPLIFY_OPTIONS = {
  simplify_error: 0.05,
  permissive: false,
  lock_border: false,
  // Left on so a mesh that asks to break seams still reaches its target as it
  // always did. It is separated from allow_seam_breaking only so it can be
  // turned off on its own, which is the setting that protects hard edges.
  aggressive: true,
}

function simplifyPayload(options = {}) {
  return {
    simplify_error: options.simplify_error ?? DEFAULT_SIMPLIFY_OPTIONS.simplify_error,
    permissive: !!options.permissive,
    lock_border: !!options.lock_border,
    aggressive: options.aggressive ?? DEFAULT_SIMPLIFY_OPTIONS.aggressive,
  }
}

// LOD chain. Runs the bundled gltfpack binary once per ratio server-side (not the
// Python service) and returns one GLB per level, each simplified from the
// original. `ratios` is ordered LOD0 → LODn, e.g. [1, 0.5, 0.25, 0.12].
// `simplify` carries the same option bag Optimize uses, so a chain is built with
// the settings shown in the panel rather than the server's defaults.
// Resolves to [{ level, ratio, blob, triangles, passthrough }].
export async function generateLods(meshBlob, { ratios = [], allowSeamBreaking = false, simplify = null, fileName = 'mesh.glb', onProgress = null } = {}) {
  const form = new FormData()
  form.append('meshFile', meshBlob, fileName)
  form.append('options', JSON.stringify({
    ratios,
    allow_seam_breaking: allowSeamBreaking,
    ...simplifyPayload(simplify || {}),
  }))

  onProgress?.({ type: 'progress', stage: 'run', frac: 0.2, message: `Generating ${ratios.length} LOD levels…` })

  const response = await fetch(`${API_BASE}/meshes/lods`, { method: 'POST', body: form })
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
  // A `passthrough` level carries no payload — it *is* the mesh that was
  // uploaded, so the caller reuses the source it already holds.
  return (data.lods || []).map(lod => ({
    level: lod.level,
    ratio: lod.ratio,
    triangles: lod.triangles ?? null,
    // The ratio actually reached. `seamLimited` means the simplifier stopped
    // early rather than weld UV seams — the level is valid, just coarser than
    // asked for. `seamsBroken` means seams were welded, so the texture moved.
    achievedRatio: lod.achieved_ratio ?? null,
    seamLimited: !!lod.seam_limited,
    seamsBroken: !!lod.seams_broken,
    passthrough: !!lod.passthrough,
    blob: lod.mesh_b64 ? base64ToBlob(lod.mesh_b64, 'model/gltf-binary') : null,
  }))
}

// Default LOD ratios per level count. LOD0 is always 1 (the untouched source);
// each subsequent level roughly halves, which is the ratio Unity's and Unreal's
// own auto-LOD tools default to.
export function defaultLodRatios(levels) {
  const count = Math.max(2, Math.min(6, Number(levels) || 4))
  return Array.from({ length: count }, (_, index) => (index === 0 ? 1 : Number((0.5 ** index).toFixed(3))))
}

// Auto Rig option defaults + the bone-naming conventions the service supports.
// Shared by every Auto Rig surface (the Mesh Editor panel and the graph's Rig
// Mesh node) so they cannot drift apart.
export const DEFAULT_AUTO_RIG_OPTIONS = {
  use_transfer: true,
  use_postprocess: false,
  rename_bones: 'mixamo',
  keep_loaded: true,
  top_k: 5,
  top_p: 0.95,
  temperature: 1.0,
  repetition_penalty: 2.0,
  num_beams: 10,
}

// The creature entries name bones the way the mesh2motion reference rigs do, so
// the Animations tab's Auto-Map pairs them by exact name instead of guessing.
// Pick the one matching the reference you intend to retarget from.
export const AUTO_RIG_BONE_NAME_OPTIONS = [
  { value: 'mixamo', label: 'Mixamo' },
  { value: 'ue5', label: 'Unreal Engine 5' },
  { value: 'bird', label: 'Bird (mesh2motion)' },
  { value: 'dragon', label: 'Dragon (mesh2motion)' },
  { value: 'fox', label: 'Fox (mesh2motion)' },
  { value: 'horse', label: 'Horse (mesh2motion)' },
  { value: 'kaiju', label: 'Kaiju (mesh2motion)' },
  { value: 'shark', label: 'Shark (mesh2motion)' },
  { value: 'snake', label: 'Snake (mesh2motion)' },
  { value: 'spider', label: 'Spider (mesh2motion)' },
  { value: 'original', label: 'Keep model names' },
]

// Keep only the keys the rigging service understands — the graph node stores its
// options inside a parameter draft that also carries UI-only fields (name, mode).
// Values are coerced back to the type of their default, so a cleared number field
// falls back instead of sending "" to the service.
export function pickAutoRigOptions(source = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_AUTO_RIG_OPTIONS).map(([key, defaultValue]) => {
      const value = source?.[key]

      if (value === undefined || value === null || value === '') {
        return [key, defaultValue]
      }

      if (typeof defaultValue === 'number') {
        const numericValue = Number(value)
        return [key, Number.isFinite(numericValue) ? numericValue : defaultValue]
      }

      if (typeof defaultValue === 'boolean') {
        return [key, Boolean(value)]
      }

      return [key, value]
    })
  )
}

// Auto Rig (SkinTokens/TokenRig). Proxies to the dedicated rigging service; the
// returned blob is a SKINNED GLB (mesh + skeleton + skin weights) — unlike the
// tools above it must NOT be flattened into editable geometry. Same SSE contract;
// tool stats carry { bones, rename_bones, transfer, postprocess }.
export function autoRig(meshBlob, opts = {}) {
  return callMeshTool('/meshes/rig', meshBlob, opts)
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

// ── Smart Segmentation ──────────────────────────────────────────────────────
// Speaks the SSE contract like the other Python-service tools, but the terminal
// event carries the segmentation HIERARCHY instead of a mesh: the merge history,
// its costs, and the map from each original face onto the analysis proxy. Parts
// are derived from those client-side (see utils/meshSegment.js), so moving the
// Parts slider never comes back here.
//
// The arrays arrive as base64 raw typed arrays. Decoded straight into typed
// arrays — going through JSON numbers would cost a megabyte of decimal text and
// a per-element parse on every analysis.
function base64ToTypedArray(base64, Ctor) {
  if (!base64) return new Ctor(0)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Ctor(bytes.buffer)
}

export async function segmentMesh(meshBlob, { options = {}, fileName = 'mesh.glb', onProgress = null } = {}) {
  const form = new FormData()
  form.append('meshFile', meshBlob, fileName)
  form.append('options', JSON.stringify(options))

  const response = await fetch(`${API_BASE}/meshes/segment`, { method: 'POST', body: form })
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
  return {
    faceCount: data.faceCount,
    proxyFaceCount: data.proxyFaceCount,
    shells: data.shells,
    minParts: data.minParts,
    escapeRatio: data.escapeRatio,
    suggestedParts: data.suggestedParts,
    // 'mesh' when the thickness rays hit the full-resolution geometry, 'proxy'
    // when they had to fall back to the decimated copy. `note` says why.
    rayTarget: data.rayTarget,
    note: data.note || null,
    // [n][2] flattened: history[2i], history[2i+1] is the i-th merged pair.
    history: base64ToTypedArray(data.history_b64, Int32Array),
    costs: base64ToTypedArray(data.costs_b64, Float32Array),
    mapping: base64ToTypedArray(data.mapping_b64, Int32Array),
  }
}

// See SegmentOptions in python-server/app/schemas.py for what each one does.
// Defaults match it; the panel only exposes the ones worth touching.
export const DEFAULT_SEGMENT_OPTIONS = {
  proxy_faces: 3000,
  sdf_rays: 20,
  sdf_cone: 120,
  sdf_alpha: 4,
  sdf_smooth: 2,
  sdf_sigma: 0.08,
  convex_eta: 0.12,
  w_thickness: 1,
  w_concavity: 1,
  precise: true,
}
