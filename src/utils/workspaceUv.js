// Workspace → UV module: the Mesh Editor's Auto UV, run on a STORED mesh.
//
// Auto UV returns geometry with a new UV layout and nothing else, so the old
// texture no longer fits. "Keep the texture" fixes that the way the Batch
// pipeline does: bake the source's colour (and optionally its roughness /
// metallic) onto the new layout with /meshes/bake, then embed the maps in the
// GLB with /meshes/apply-maps (the Batch bake stage's applyBakedMapsToGlb).
import { autoUv, bakeMaps, ensureDesktopService } from './meshTools'
import { applyMaps, slice } from './workspaceBake'
import { fetchAssetBlob } from './workspaceRetopo'

export const UV_RESOLUTIONS = [1024, 2048, 4096]
export const BAKE_RESOLUTIONS = [1024, 2048, 4096]

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
