// Network calls of the Workspace project page. Plain fetches (not ProjectContext
// wrappers) so effects can depend on them without re-running every time the
// context provider re-renders.
import { API_BASE } from '../config'

async function readJson(res, fallbackError) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || fallbackError)
  return data
}

export async function fetchWorkspaceHistory(projectId, { module = null, limit = 200, before = null } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  if (module) query.set('module', module)
  if (before != null) query.set('before', String(before))
  const res = await fetch(`${API_BASE}/projects/${projectId}/workspace-history?${query.toString()}`)
  return await readJson(res, 'Failed to load the history')
}

// entries: [{ assetId, module, action, runId?, sourceAssetId?, prompt?, workflowId?, workflowName?, params? }]
export async function addWorkspaceHistory(projectId, entries) {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workspace-history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries })
  })
  return await readJson(res, 'Failed to save the history')
}

export async function deleteWorkspaceHistoryEntry(projectId, entryId) {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workspace-history/${entryId}`, { method: 'DELETE' })
  return await readJson(res, 'Failed to remove the history entry')
}

export async function fetchComfyWorkflows() {
  const res = await fetch(`${API_BASE}/library/comfy-workflows`)
  return await readJson(res, 'Failed to load ComfyUI workflows')
}

// A file from the computer becomes a ROOT project asset with no Kanban card.
export async function uploadDetachedAsset(projectId, file, type = 'image') {
  const form = new FormData()
  form.append('file', file)
  form.append('projectId', String(projectId))
  form.append('type', type)
  form.append('detached', 'true')
  form.append('metadata', JSON.stringify({ source: 'WORKSPACE IMPORT' }))
  const res = await fetch(`${API_BASE}/assets/upload`, { method: 'POST', body: form })
  return await readJson(res, 'Failed to import the file')
}

// Make an asset (library root, project root or edit) usable as a workflow input
// of this project: returns { sourceReference, assetId }.
export async function resolveSourceReference(projectId, type, filePath) {
  const query = new URLSearchParams({ projectId: String(projectId), type, filePath })
  const res = await fetch(`${API_BASE}/assets/resolve-source?${query.toString()}`)
  return await readJson(res, 'Failed to resolve the asset')
}

// Attach a rendered thumbnail to an asset; returns the updated asset view.
export async function uploadAssetThumbnail(assetId, file) {
  const form = new FormData()
  form.append('thumbnail', file)
  const res = await fetch(`${API_BASE}/assets/${assetId}/thumbnail`, { method: 'POST', body: form })
  return await readJson(res, 'Failed to save the thumbnail')
}

// Submit a cloud mesh generation (Tripo AI / Hitem3D / Tencent Cloud). Answers
// 202 with the task / job id to poll (see useWorkspaceCloudTasks).
export async function submitCloudMeshGeneration(body) {
  const res = await fetch(`${API_BASE}/meshes/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return await readJson(res, 'Failed to submit the mesh generation')
}
