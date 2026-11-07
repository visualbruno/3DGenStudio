// Workspace → UV module: the Mesh Editor's Auto UV, run on a STORED mesh.
//
// Auto UV returns geometry with a new UV layout and nothing else, so the old
// texture no longer fits. "Keep the texture" fixes that the way the Batch
// pipeline does: bake the source's colour (and optionally its roughness /
// metallic) onto the new layout with /meshes/bake, then embed the maps in the
// GLB with /meshes/apply-maps (the Batch bake stage's applyBakedMapsToGlb).
import { API_BASE } from '../config'
import { autoUv, bakeMaps, ensureDesktopService } from './meshTools'
import { fetchAssetBlob } from './workspaceRetopo'

export const UV_RESOLUTIONS = [1024, 2048, 4096]
export const BAKE_RESOLUTIONS = [1024, 2048, 4096]

function base64ToBlob(base64, type) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function applyMaps(meshBlob, maps, ormChannels) {
  const form = new FormData()
  form.append('meshFile', meshBlob, 'mesh.glb')
  for (const [name, blob] of Object.entries(maps)) form.append(name, blob, `${name}.png`)
  form.append('options', JSON.stringify({ ormChannels }))
  const res = await fetch(`${API_BASE}/meshes/apply-maps`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || 'Could not put the texture back on the mesh')
  return { blob: base64ToBlob(data.mesh_b64, 'model/gltf-binary'), applied: data.applied || [] }
}

// Remap a tool's 0..1 progress into a slice of the whole run.
function slice(onProgress, from, to) {
  return (evt) => {
    const frac = Number(evt?.frac)
    onProgress?.({ ...evt, frac: Number.isFinite(frac) ? from + frac * (to - from) : from })
  }
}

// Resolves { blob, stats, previewUrl, bake }.
export async function runWorkspaceAutoUv(asset, { uvOptions, keepTexture, bakeResolution, bakePbr, onProgress }) {
  onProgress?.({ frac: 0, message: 'Starting the Mesh Tools service…' })
  await ensureDesktopService('meshtools')
  onProgress?.({ frac: 0.02, message: 'Loading the mesh…' })
  const sourceBlob = await fetchAssetBlob(asset)
  const fileName = String(asset.filename || 'mesh.glb').split('/').pop() || 'mesh.glb'

  const unwrapped = await autoUv(sourceBlob, {
    options: uvOptions,
    fileName,
    onProgress: slice(onProgress, 0.03, keepTexture ? 0.5 : 0.95)
  })
  if (!keepTexture) return { ...unwrapped, bake: null }

  const maps = bakePbr ? ['base_color', 'roughness', 'metallic'] : ['base_color']
  const baked = await bakeMaps(unwrapped.blob, sourceBlob, {
    options: {
      maps,
      resolution: bakeResolution,
      // Same surface on both sides of the bake, so the checks a retopo bake
      // needs (alignment, overlap) cost nothing and still guard a bad input.
      align_source: true,
      require_overlap: 0.5
    },
    fileName: 'unwrapped.glb',
    sourceName: fileName,
    onProgress: slice(onProgress, 0.5, 0.92)
  })
  if (!Object.keys(baked.maps).length) throw new Error('The texture bake returned no maps')

  onProgress?.({ frac: 0.94, message: 'Putting the texture on the new UVs…' })
  const textured = await applyMaps(unwrapped.blob, baked.maps, baked.stats?.orm_channels || [])
  return {
    blob: textured.blob,
    stats: unwrapped.stats,
    previewUrl: unwrapped.previewUrl,
    bake: { applied: textured.applied, coverage: baked.stats?.coverage ?? null, flat: baked.stats?.flat_channels || [] }
  }
}

export function describeUvResult(stats, bake) {
  const tool = stats?.tool || {}
  const rows = []
  if (tool.n_charts != null) rows.push({ label: 'UV islands', value: tool.n_charts })
  if (tool.fill_ratio != null) rows.push({ label: 'Atlas fill', value: `${(tool.fill_ratio * 100).toFixed(0)}%` })
  if (tool.overlap_share != null) rows.push({ label: 'Overlap', value: `${(tool.overlap_share * 100).toFixed(1)}%` })
  if (tool.stretch_energy_p95 != null) rows.push({ label: 'Stretch (p95)', value: tool.stretch_energy_p95.toFixed(2) })
  if (tool.flipped_triangles != null) rows.push({ label: 'Flipped tris', value: tool.flipped_triangles })
  if (tool.character_rescue === 'kept') rows.push({ label: 'Layout', value: 'Character (limbs / joints)' })
  if (bake) {
    rows.push({ label: 'Texture', value: bake.applied?.length ? `kept (${bake.applied.join(', ')})` : 'not applied' })
    if (typeof bake.coverage === 'number') rows.push({ label: 'Bake coverage', value: `${Math.round(bake.coverage * 100)}%` })
  } else {
    rows.push({ label: 'Texture', value: 'none (new UVs)' })
  }
  return rows
}
