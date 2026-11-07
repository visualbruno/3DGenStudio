// The built-in (Blender) bake of the Workspace Texture module, and the step
// that puts baked maps onto a GLB (shared with the UV module's "Keep the
// texture"): /meshes/bake returns PNGs, /meshes/apply-maps embeds them with the
// Batch bake stage's applyBakedMapsToGlb.
import { API_BASE } from '../config'
import { autoUv, bakeMaps, ensureDesktopService, DEFAULT_AUTO_UV_OPTIONS } from './meshTools'
import { fetchAssetBlob } from './workspaceRetopo'

export const BAKE_MAP_CHOICES = [
  { id: 'base_color', label: 'Colour', hint: 'The high poly’s texture (albedo)' },
  { id: 'normal', label: 'Normal', hint: 'The high poly’s surface detail as a normal map' },
  { id: 'ao', label: 'AO', hint: 'Ambient occlusion: contact shadows in creases' },
  { id: 'roughness', label: 'Roughness', hint: 'The high poly’s roughness' },
  { id: 'metallic', label: 'Metallic', hint: 'The high poly’s metallic' }
]

export const DEFAULT_WORKSPACE_BAKE = {
  maps: ['base_color', 'normal', 'roughness', 'metallic'],
  resolution: 2048,
  samples: 8,
  margin: 8,
  cage_extrusion: 0,
  align_source: true,
  require_overlap: 0.5,
  unwrapFirst: false
}

function base64ToBlob(base64, type) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

export async function applyMaps(meshBlob, maps, ormChannels) {
  const form = new FormData()
  form.append('meshFile', meshBlob, 'mesh.glb')
  for (const [name, blob] of Object.entries(maps)) form.append(name, blob, `${name}.png`)
  form.append('options', JSON.stringify({ ormChannels }))
  const res = await fetch(`${API_BASE}/meshes/apply-maps`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || 'Could not put the baked maps on the mesh')
  return { blob: base64ToBlob(data.mesh_b64, 'model/gltf-binary'), applied: data.applied || [] }
}

export function slice(onProgress, from, to) {
  return (evt) => {
    const frac = Number(evt?.frac)
    onProgress?.({ ...evt, frac: Number.isFinite(frac) ? from + frac * (to - from) : from })
  }
}

// Bake `high` onto `low` (both stored mesh assets). Resolves { blob, rows }.
export async function runWorkspaceBake(low, high, options, { onProgress } = {}) {
  onProgress?.({ frac: 0, message: 'Starting the Mesh Tools service…' })
  await ensureDesktopService('meshtools')
  onProgress?.({ frac: 0.02, message: 'Loading the meshes…' })
  const [lowBlobRaw, highBlob] = await Promise.all([fetchAssetBlob(low), fetchAssetBlob(high)])

  let lowBlob = lowBlobRaw
  let unwrapped = null
  if (options.unwrapFirst) {
    unwrapped = await autoUv(lowBlobRaw, {
      options: DEFAULT_AUTO_UV_OPTIONS,
      fileName: 'low.glb',
      onProgress: slice(onProgress, 0.03, 0.35)
    })
    lowBlob = unwrapped.blob
  }

  const bakeOptions = { ...options }
  delete bakeOptions.unwrapFirst
  const baked = await bakeMaps(lowBlob, highBlob, {
    options: bakeOptions,
    fileName: 'low.glb',
    sourceName: 'high.glb',
    onProgress: slice(onProgress, options.unwrapFirst ? 0.35 : 0.03, 0.92)
  })
  if (!Object.keys(baked.maps).length) throw new Error('The bake returned no maps')

  onProgress?.({ frac: 0.94, message: 'Putting the maps on the mesh…' })
  const textured = await applyMaps(lowBlob, baked.maps, baked.stats?.orm_channels || [])

  const stats = baked.stats || {}
  const rows = [
    { label: 'Maps', value: textured.applied.length ? textured.applied.join(', ') : 'none' },
    { label: 'Resolution', value: `${stats.resolution || options.resolution} px` }
  ]
  if (typeof stats.coverage === 'number') rows.push({ label: 'Coverage', value: `${Math.round(stats.coverage * 100)}%` })
  if (unwrapped?.stats?.tool?.n_charts != null) rows.push({ label: 'Unwrapped first', value: `${unwrapped.stats.tool.n_charts} UV islands` })
  if (Array.isArray(stats.flat_channels) && stats.flat_channels.length) {
    rows.push({ label: 'Flat channels', value: stats.flat_channels.join(', ') })
  }
  return { blob: textured.blob, rows, coverage: stats.coverage ?? null }
}
