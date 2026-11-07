// Workspace → Retopo module: run the Mesh Editor's Auto Retopo, Repair and
// Optimize on a STORED mesh asset (the editor runs them on its in-memory
// geometry), and save each result as a new version of the source mesh — the
// same path the MCP mesh tools take (mcp/tools/meshTools.js).
import { API_BASE, assetUrl } from '../config'
import {
  autoRetopo,
  ensureDesktopService,
  inspectMesh,
  optimizeMesh,
  repairMesh
} from './meshTools'

export const RETOPO_TOOLS = {
  autoretopo: { label: 'Auto Retopo', service: 'meshtools', run: autoRetopo, suffix: 'retopo' },
  repair: { label: 'Repair', service: 'meshtools', run: repairMesh, suffix: 'repaired' },
  // gltfpack runs inside the Node server: no Python service to start.
  optimize: { label: 'Optimize', service: null, run: optimizeMesh, suffix: 'optimized' }
}

export const RETOPO_FACE_PRESETS = [2000, 6000, 10000, 20000, 50000]
export const OPTIMIZE_RATIO_PRESETS = [0.75, 0.5, 0.25, 0.1]

function fileNameOf(asset) {
  return String(asset?.filename || asset?.filePath || 'mesh.glb').split('/').pop() || 'mesh.glb'
}

export async function fetchAssetBlob(asset) {
  const res = await fetch(assetUrl(asset.filename))
  if (!res.ok) throw new Error(`Could not load ${asset.name || 'the mesh'} (HTTP ${res.status})`)
  return await res.blob()
}

// Run one tool on a stored mesh. Resolves { blob, stats }.
export async function runRetopoTool(toolId, asset, options, { onProgress } = {}) {
  const tool = RETOPO_TOOLS[toolId]
  if (!tool) throw new Error(`Unknown tool ${toolId}`)
  if (tool.service) {
    onProgress?.({ frac: 0, message: 'Starting the Mesh Tools service…' })
    await ensureDesktopService(tool.service)
  }
  onProgress?.({ frac: 0.02, message: 'Loading the mesh…' })
  const blob = await fetchAssetBlob(asset)
  return await tool.run(blob, { options, fileName: fileNameOf(asset), onProgress })
}

// Save a result as a new version (child) of the source mesh.
export async function saveMeshVersion(asset, blob, name) {
  const form = new FormData()
  form.append('assetId', String(asset.id))
  form.append('filePath', '')
  form.append('name', name)
  form.append('saveMode', 'version')
  form.append('source', 'Workspace')
  form.append('meshFile', blob, 'mesh.glb')
  const res = await fetch(`${API_BASE}/meshes/editor/save`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || 'Failed to save the new version')
  return data
}

export function versionName(asset, toolId) {
  const base = String(asset?.name || 'Mesh').replace(/\.[^.]+$/, '').replace(/\s*\((retopo|repaired|optimized)\)$/i, '')
  return `${base} (${RETOPO_TOOLS[toolId]?.suffix || toolId})`
}

// "Check mesh": the topology part of the Game-Ready report.
export async function checkMesh(asset) {
  await ensureDesktopService('meshtools')
  const blob = await fetchAssetBlob(asset)
  const report = await inspectMesh(blob, { fileName: fileNameOf(asset) })
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const byId = id => checks.find(check => check.id === id) || null
  return {
    faces: byId('tri_count'),
    vertices: byId('vertex_count'),
    nonManifold: byId('non_manifold'),
    openEdges: byId('boundary'),
    watertight: byId('watertight'),
    degenerate: byId('degenerate'),
    duplicates: byId('duplicate_faces'),
    needsRepair: ['non_manifold', 'degenerate', 'duplicate_faces'].some(id => byId(id)?.status === 'fail'),
    stats: report?.stats || null
  }
}

// One-line summaries of a result, for the panel and the history entry.
export function describeResult(toolId, stats) {
  const tool = stats?.tool || {}
  if (toolId === 'repair') {
    const before = tool.before || {}
    const after = tool.after || {}
    return [
      { label: 'Non-manifold edges', value: `${before.non_manifold_edges ?? '?'} → ${after.non_manifold_edges ?? '?'}` },
      { label: 'Open edges', value: `${before.boundary_edges ?? '?'} → ${after.boundary_edges ?? '?'}` },
      { label: 'Faces', value: `${before.faces?.toLocaleString?.() ?? '?'} → ${after.faces?.toLocaleString?.() ?? '?'}` }
    ]
  }
  if (toolId === 'autoretopo') {
    const metrics = tool.metrics || {}
    const rows = [{ label: 'Faces', value: stats?.faceCount?.toLocaleString?.() ?? '—' }]
    const watertight = metrics?.topology?.watertight
    if (watertight != null) rows.push({ label: 'Watertight', value: watertight ? 'Yes' : 'No — has holes' })
    const hausdorff = metrics?.fidelity?.hausdorff_pct_diag
    if (hausdorff != null) rows.push({ label: 'Deviation', value: `${hausdorff.toFixed(2)}% of size` })
    const wellShaped = metrics?.triangle_quality?.pct_well_shaped
    if (wellShaped != null) rows.push({ label: 'Well-shaped tris', value: `${wellShaped.toFixed(0)}%` })
    return rows
  }
  const rows = []
  if (stats?.input_triangles != null && stats?.triangles != null) {
    rows.push({ label: 'Triangles', value: `${stats.input_triangles.toLocaleString()} → ${stats.triangles.toLocaleString()}` })
  }
  if (stats?.achieved_ratio != null) rows.push({ label: 'Achieved ratio', value: Number(stats.achieved_ratio.toFixed(3)) })
  if (stats?.seams_broken) rows.push({ label: 'Seams welded', value: 'yes — check hard edges and texture' })
  return rows
}
