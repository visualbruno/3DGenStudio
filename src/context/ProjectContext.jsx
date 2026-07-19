/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { API_BASE } from '../config'

const ProjectContext = createContext(null)

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  // A single shared SSE connection multiplexes progress for every ComfyUI
  // prompt. Using one connection for all jobs (instead of one per job) keeps
  // concurrent workflows from exhausting the browser's ~6 connection-per-origin
  // limit, which otherwise stalls all other requests (navigation, asset loads).
  const comfyStreamRef = useRef(null)

  const getComfyStream = useCallback(() => {
    if (comfyStreamRef.current) {
      return comfyStreamRef.current
    }

    const listeners = new Map() // promptId -> Set<handler>
    const lastTerminal = new Map() // promptId -> terminal payload (for late subscribers)
    const stream = { listeners, lastTerminal, eventSource: null }

    const dispatch = (payload) => {
      const promptId = String(payload?.promptId || '')
      if (!promptId) return
      if (payload?.done || payload?.status === 'error') {
        lastTerminal.set(promptId, payload)
      }
      const handlers = listeners.get(promptId)
      if (handlers) {
        for (const handler of [...handlers]) {
          handler(payload)
        }
      }
    }

    if (typeof EventSource !== 'undefined') {
      const eventSource = new EventSource(`${API_BASE}/comfyui/workflows/events`)
      eventSource.onmessage = (event) => {
        try {
          dispatch(JSON.parse(event.data))
        } catch {
          // Ignore malformed frames (e.g. heartbeats/comments never reach onmessage).
        }
      }
      // EventSource auto-reconnects on error; the server replays current
      // snapshots on reconnect, so no manual recovery is needed here.
      eventSource.onerror = () => {}
      stream.eventSource = eventSource
    }

    comfyStreamRef.current = stream
    return stream
  }, [])

  useEffect(() => {
    return () => {
      comfyStreamRef.current?.eventSource?.close()
      comfyStreamRef.current = null
    }
  }, [])

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`)
      const data = await res.json()
      setProjects(data)
    } catch (err) {
      console.error('Failed to fetch projects:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // App-level event stream: the backend publishes `externalMutation` events
  // when something outside this browser (e.g. an MCP client / AI agent)
  // changes data. Refresh the project list and let open pages refetch via a
  // window event so the UI doesn't sit on stale state until a manual reload.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined

    const eventSource = new EventSource(`${API_BASE}/events`)
    eventSource.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload?.type !== 'externalMutation') return
      fetchProjects()
      window.dispatchEvent(new CustomEvent('genstudio:external-mutation', { detail: payload }))
    }
    eventSource.onerror = () => {}

    return () => eventSource.close()
  }, [fetchProjects])

  const createProject = async (projectData) => {
    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectData)
      })
      const newProject = await res.json()
      await fetchProjects() // Refresh list
      return newProject
    } catch (err) {
      console.error('Failed to create project:', err)
      throw err
    }
  }

  const moveKanbanCard = async (projectId, cardId, kanbanColumnId, position) => {
    const res = await fetch(`${API_BASE}/cards/move`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, cardId, kanbanColumnId, position })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to move card')
    }

    return data
  }

  const updateProjectNode = async (projectId, nodeId, nodeData) => {
    const res = await fetch(`${API_BASE}/graph/nodes/${nodeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...nodeData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to update graph node')
    }

    return data
  }

  const runMeshTexturingApi = async (projectId, textureData) => {
    const res = await fetch(`${API_BASE}/meshes/texture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...textureData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to run mesh texturing API')
    }

    return data
  }

  const runMeshRiggingApi = async (projectId, rigData) => {
    const res = await fetch(`${API_BASE}/meshes/rigging`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...rigData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to run mesh rigging API')
    }

    return data
  }

  const runMeshEditApi = async (projectId, editData) => {
    const res = await fetch(`${API_BASE}/meshes/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...editData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to run mesh edit API')
    }

    return data
  }

  const runMeshGenerationApi = async (projectId, generationData) => {
    const res = await fetch(`${API_BASE}/meshes/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...generationData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to run mesh generation API')
    }

    return data
  }

  const queryTencentMeshGenerationResult = async (projectId, queryData) => {
    const res = await fetch(`${API_BASE}/meshes/generate/tencent/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...queryData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to query Tencent Cloud mesh generation result')
    }

    return data
  }

  const queryTripoMeshGenerationResult = async (projectId, queryData) => {
    const res = await fetch(`${API_BASE}/meshes/generate/tripo/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...queryData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to query Tripo AI mesh generation result')
    }

    return data
  }

  const queryHitemMeshGenerationResult = async (projectId, queryData) => {
    const res = await fetch(`${API_BASE}/meshes/generate/hitem/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...queryData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to query Hitem3D mesh generation result')
    }

    return data
  }

  const deleteAssetEdit = async ({ filePath }) => {
    const params = new URLSearchParams({ filePath })
    const res = await fetch(`${API_BASE}/assets/library/edits?${params.toString()}`, {
      method: 'DELETE'
    })

    if (res.status === 204) {
      return { deleted: true }
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to delete asset edit')
    }

    return data
  }

  const deleteAssetVersion = async ({ filePath, force = false }) => {
    const params = new URLSearchParams({ filePath })
    if (force) {
      params.set('force', 'true')
    }
    const res = await fetch(`${API_BASE}/assets/library/versions?${params.toString()}`, {
      method: 'DELETE'
    })

    if (res.status === 204) {
      return { deleted: true }
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      const error = new Error(data?.error || 'Failed to delete mesh version')
      error.status = res.status
      error.details = data
      throw error
    }

    return data
  }

  const renameAssetEdit = async ({ filePath, name }) => {
    const res = await fetch(`${API_BASE}/assets/library/edits`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, name })
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to rename asset edit')
    }

    return data
  }

  const renameLibraryAsset = async ({ type, filename, name }) => {
    const res = await fetch(`${API_BASE}/assets/library`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, filename, name })
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to rename asset')
    }

    return data
  }

  const runImageEditApi = async (projectId, editData) => {
    const res = await fetch(`${API_BASE}/image-edits/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...editData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to run image edit API')
    }

    return data
  }

  const runImageEditComfy = async (projectId, editData) => {
    const res = await fetch(`${API_BASE}/image-edits/comfy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...editData, progressId: editData.progressId })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to run ComfyUI image edit')
    }

    return data
  }

  const getAttributeTypes = async () => {
    const res = await fetch(`${API_BASE}/card-attributes/types`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load attribute types')
    }

    return data
  }

  const getProjectCardAttributes = async (projectId) => {
    const res = await fetch(`${API_BASE}/card-attributes?projectId=${projectId}`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load card attributes')
    }

    return data
  }

  const createCardAttribute = async (projectId, cardId, attributeData) => {
    const res = await fetch(`${API_BASE}/card-attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, cardId, ...attributeData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to create card attribute')
    }

    return data
  }

  const updateCardAttribute = async (projectId, cardId, position, attributeData) => {
    const res = await fetch(`${API_BASE}/card-attributes/${encodeURIComponent(cardId)}/${position}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...attributeData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to update card attribute')
    }

    return data
  }

  const deleteCard = async (projectId, cardId) => {
    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}?projectId=${projectId}`, {
      method: 'DELETE'
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to delete card')
    }

    return data
  }

  const deleteCardAttribute = async (projectId, cardId, position) => {
    const res = await fetch(`${API_BASE}/card-attributes/${encodeURIComponent(cardId)}/${position}?projectId=${projectId}`, {
      method: 'DELETE'
    })

    if (res.status === 204) {
      return { deleted: true }
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to delete card attribute')
    }

    return data
  }

  const getProject = async (id) => {
    const res = await fetch(`${API_BASE}/projects/${id}`)
    if (!res.ok) return null
    return await res.json()
  }

  const updateProject = async (id, updates) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      })
      const updated = await res.json()
      if (!res.ok) throw new Error(updated?.error || 'Failed to update project')
      await fetchProjects()
      return updated
    } catch (err) {
      console.error('Failed to update project:', err)
      throw err
    }
  }

  // Persist the Graph canvas viewport (pan + zoom) without triggering a full
  // projects refetch — this fires on every pan/zoom end, so it must stay cheap.
  const saveGraphViewport = async (id, viewport) => {
    try {
      await fetch(`${API_BASE}/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graphViewport: viewport })
      })
    } catch (err) {
      console.error('Failed to save graph viewport:', err)
    }
  }

  const deleteProject = async (id, { deleteAssets = false } = {}) => {
    const query = deleteAssets ? '?deleteAssets=true' : ''
    await fetch(`${API_BASE}/projects/${id}${query}`, { method: 'DELETE' })
    await fetchProjects()
  }

  const exportProject = async (id, { folder, name }) => {
    const res = await fetch(`${API_BASE}/projects/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, name })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to export project')
    }
    return data
  }

  const importProject = async ({ folder, name }) => {
    const res = await fetch(`${API_BASE}/projects/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, name })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to import project')
    }
    await fetchProjects()
    return data
  }

  const getProjectAssets = async (projectId) => {
    const res = await fetch(`${API_BASE}/assets?projectId=${projectId}`)
    return await res.json()
  }

  const getProjectCards = async (projectId) => {
    const res = await fetch(`${API_BASE}/cards?projectId=${projectId}`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load project cards')
    }

    return data
  }

  const getProjectNodes = async (projectId) => {
    const res = await fetch(`${API_BASE}/graph/nodes?projectId=${projectId}`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load graph nodes')
    }

    return data
  }

  const createProjectNode = async (projectId, nodeData) => {
    const res = await fetch(`${API_BASE}/graph/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...nodeData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to create graph node')
    }

    return data
  }

  const updateProjectNodePosition = async (projectId, nodeId, position) => {
    const normalizedPosition = {
      xPos: position?.xPos ?? position?.x ?? 0,
      yPos: position?.yPos ?? position?.y ?? 0
    }

    const res = await fetch(`${API_BASE}/graph/nodes/${nodeId}/position`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...normalizedPosition })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to update graph node position')
    }

    return data
  }

  const deleteProjectNode = async (projectId, nodeId) => {
    const res = await fetch(`${API_BASE}/graph/nodes/${nodeId}?projectId=${projectId}`, {
      method: 'DELETE'
    })

    if (res.status === 204) {
      return { deleted: true }
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to delete graph node')
    }

    return data
  }

  const getProjectConnections = async (projectId) => {
    const res = await fetch(`${API_BASE}/graph/connections?projectId=${projectId}`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load graph connections')
    }

    return data
  }

  const createProjectConnection = async (projectId, connectionData) => {
    const res = await fetch(`${API_BASE}/graph/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...connectionData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to create graph connection')
    }

    return data
  }

  const deleteProjectConnection = async (projectId, connectionData) => {
    const params = new URLSearchParams({
      projectId,
      sourceNodeId: connectionData.sourceNodeId,
      targetNodeId: connectionData.targetNodeId,
      inputId: connectionData.inputId,
      outputId: connectionData.outputId
    })

    const res = await fetch(`${API_BASE}/graph/connections?${params.toString()}`, {
      method: 'DELETE'
    })

    if (res.status === 204) {
      return { deleted: true }
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to delete graph connection')
    }

    return data
  }

  const getProjectTasks = async (projectId) => {
    const res = await fetch(`${API_BASE}/tasks?projectId=${projectId}`)
    return await res.json()
  }

  const createTask = async (taskData) => {
    const res = await fetch(`${API_BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData)
    });
    return await res.json();
  }

  const uploadAssetThumbnail = async (assetId, file) => {
    const formData = new FormData()
    formData.append('thumbnail', file)

    const res = await fetch(`${API_BASE}/assets/${assetId}/thumbnail`, {
      method: 'POST',
      body: formData
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to upload asset thumbnail')
    }

    return data
  }

  const saveMeshEdit = async (payload) => {
    const formData = new FormData()
    formData.append('assetId', payload?.assetId ?? '')
    formData.append('filePath', payload?.filePath ?? '')
    formData.append('name', payload?.name ?? '')
    formData.append('saveMode', payload?.saveMode ?? 'replace')

    if (payload?.meshFile) {
      formData.append('meshFile', payload.meshFile)
    }

    const res = await fetch(`${API_BASE}/meshes/editor/save`, {
      method: 'POST',
      body: formData
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save mesh edit')
    }

    return data
  }

  const getPaintDocument = async (assetId) => {
    if (!Number.isFinite(Number(assetId)) || Number(assetId) <= 0) return null
    const res = await fetch(`${API_BASE}/assets/${Number(assetId)}/paint-document`)
    if (res.status === 404) return null
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data?.error || 'Failed to load paint document')
    }
    return await res.json()
  }

  const savePaintDocument = async (assetId, { metadata, baseFile, layerFiles }) => {
    if (!Number.isFinite(Number(assetId)) || Number(assetId) <= 0) {
      throw new Error('A valid assetId is required to save a paint document')
    }

    const formData = new FormData()
    formData.append('metadata', JSON.stringify(metadata || {}))
    if (baseFile) formData.append('base', baseFile)
    Object.entries(layerFiles || {}).forEach(([layerId, file]) => {
      if (file) formData.append(`layer:${layerId}`, file)
    })

    const res = await fetch(`${API_BASE}/assets/${Number(assetId)}/paint-document`, {
      method: 'PUT',
      body: formData
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save paint document')
    }
    return data
  }

  const saveImageEditorFile = async (assetId, file, name, saveMode = 'replace') => {
    const formData = new FormData()
    formData.append('imageFile', file)
    formData.append('assetId', String(assetId))
    formData.append('name', name || '')
    formData.append('saveMode', saveMode)

    const res = await fetch(`${API_BASE}/assets/image-editor/save`, {
      method: 'POST',
      body: formData
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save image')
    }

    return data
  }

  const uploadAsset = async (projectId, file, type = 'image', metadata = {}) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('projectId', projectId);
    formData.append('type', type);
    formData.append('metadata', JSON.stringify(metadata));

    const res = await fetch(`${API_BASE}/assets/upload`, {
      method: 'POST',
      body: formData
    });
    return await res.json();
  }

  const attachExistingAsset = async (projectId, assetData) => {
    const res = await fetch(`${API_BASE}/assets/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...assetData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to attach asset')
    }

    return data
  }

  const deleteLibraryAsset = async ({ type, filename, force = false }) => {
    const params = new URLSearchParams({ type, filename })
    if (force) {
      params.set('force', 'true')
    }
    const res = await fetch(`${API_BASE}/assets/library?${params.toString()}`, {
      method: 'DELETE'
    })

    if (res.status === 204) {
      return { deleted: true }
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      const error = new Error(data?.error || 'Failed to delete asset')
      error.status = res.status
      error.details = data
      throw error
    }

    return data
  }

  const deleteAsset = async (assetId) => {
    const res = await fetch(`${API_BASE}/assets/${assetId}`, { method: 'DELETE' })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data?.error || 'Failed to remove asset card')
    }
  }

  const getLibraryAssets = async () => {
    const res = await fetch(`${API_BASE}/assets/library`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data?.error || 'Failed to load asset library')
    }

    return await res.json()
  }

  const importLibraryAssets = async (assets, options = {}) => {
    const formData = new FormData()

    Array.from(assets || []).forEach((asset, index) => {
      if (!asset?.file) {
        return
      }

      formData.append('files', asset.file)

      if (asset.thumbnail) {
        formData.append(`thumbnail:${index}`, asset.thumbnail)
      }
    })

    const importUrl = options?.assetType
      ? `${API_BASE}/assets/library/import?assetType=${encodeURIComponent(options.assetType)}`
      : `${API_BASE}/assets/library/import`

    const res = await fetch(importUrl, {
      method: 'POST',
      body: formData
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to import assets')
    }

    return data
  }

  const importBrushChildAssets = async (parentId, files = []) => {
    const formData = new FormData()
    formData.append('parentId', String(parentId))
    Array.from(files).forEach(file => formData.append('files', file))

    const res = await fetch(`${API_BASE}/assets/library/brush-edits`, {
      method: 'POST',
      body: formData
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to import brush edits')
    }

    return data
  }

  const generateImage = async (projectId, generationData) => {
    const res = await fetch(`${API_BASE}/images/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...generationData })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to generate image')
    }

    return data
  }

  const getComfyWorkflows = async () => {
    const res = await fetch(`${API_BASE}/library/comfy-workflows`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load ComfyUI workflows')
    }

    return data
  }

  const inspectComfyWorkflow = async (workflowJson) => {
    const res = await fetch(`${API_BASE}/library/comfy-workflows/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowJson })
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to inspect ComfyUI workflow')
    }

    return data
  }

  const importComfyWorkflow = async (workflowData) => {
    const res = await fetch(`${API_BASE}/library/comfy-workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflowData)
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to import ComfyUI workflow')
    }

    return data
  }

  const updateComfyWorkflow = async (workflowId, workflowData) => {
    const res = await fetch(`${API_BASE}/library/comfy-workflows/${workflowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflowData)
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to update ComfyUI workflow')
    }

    return data
  }

  const runComfyWorkflow = async (projectId, workflowData) => {
    const formData = new FormData()
    const inputValues = {}

    if (projectId !== null && projectId !== undefined && String(projectId) !== '') {
      formData.append('projectId', projectId)
    }
    formData.append('workflowId', workflowData.workflowId)
    if (workflowData.clientId) {
      formData.append('clientId', workflowData.clientId)
    }
    if (workflowData.promptId) {
      formData.append('promptId', workflowData.promptId)
    }
    if (workflowData.cardId) {
      formData.append('cardId', workflowData.cardId)
    }
    if (workflowData.name) {
      formData.append('name', workflowData.name)
    }
    if (workflowData.parentAssetId) {
      formData.append('parentAssetId', workflowData.parentAssetId)
    }
    if (workflowData.persistProcessingCard === false) {
      formData.append('persistProcessingCard', 'false')
    }
    if (workflowData.persistGeneratedAssets === false) {
      formData.append('persistGeneratedAssets', 'false')
    }
    // The app manages its own edit/version saving (e.g. image edits via
    // /image-edits/comfy, mesh versions via an explicit parentAssetId), and its
    // generate flows must create new root assets — so opt out of the server's
    // input-based parent inference unless a caller explicitly asks for it.
    formData.append('autoParentFromInputs', workflowData.autoParentFromInputs === true ? 'true' : 'false')

    Object.entries(workflowData.inputs || {}).forEach(([key, value]) => {
      if (typeof File !== 'undefined' && value instanceof File) {
        const fieldName = `comfyFile:${key}`
        formData.append(fieldName, value)
        inputValues[key] = { __fileField: fieldName }
      } else {
        inputValues[key] = value
      }
    })

    formData.append('inputValues', JSON.stringify(inputValues))

    // The /run endpoint returns as soon as the prompt is queued (it no longer
    // blocks for the whole generation). The generated assets arrive on the
    // multiplexed progress stream as the terminal `done`/`error` event, so we
    // start listening before the POST resolves to avoid missing it.
    const promptId = String(workflowData.promptId || '')
    let stopCompletion = null
    const completion = (promptId && typeof EventSource !== 'undefined')
      ? new Promise((resolve, reject) => {
          stopCompletion = subscribeToComfyWorkflowProgress(promptId, {
            onMessage: (payload) => {
              if (payload?.status === 'error') {
                stopCompletion?.()
                reject(new Error(payload?.detail || payload?.error || 'ComfyUI workflow failed'))
              } else if (payload?.done) {
                stopCompletion?.()
                const result = payload?.result
                resolve(Array.isArray(result) ? result : (result ? [result] : []))
              }
            },
            onError: () => {}
          })
        })
      : null

    let res
    try {
      res = await fetch(`${API_BASE}/comfyui/workflows/run`, {
        method: 'POST',
        body: formData
      })
    } catch (err) {
      stopCompletion?.()
      throw err
    }

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      stopCompletion?.()
      throw new Error(data?.error || 'Failed to execute ComfyUI workflow')
    }

    // Fallback for environments without EventSource: the terminal event can't
    // be delivered, so return whatever the response body carried.
    if (!completion) {
      return data
    }

    return await completion
  }

  const getWikiConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/wiki/config`)
      if (!res.ok) return { authorMode: false }
      return await res.json()
    } catch {
      return { authorMode: false }
    }
  }

  const getWikiPages = async () => {
    const res = await fetch(`${API_BASE}/wiki/pages`)
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load wiki pages')
    }
    return data
  }

  const getWikiPage = async (id) => {
    const res = await fetch(`${API_BASE}/wiki/pages/${id}`)
    if (res.status === 404) return null
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to load wiki page')
    }
    return data
  }

  const createWikiPage = async (payload) => {
    const res = await fetch(`${API_BASE}/wiki/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to create wiki page')
    }
    return data
  }

  const updateWikiPage = async (id, payload) => {
    const res = await fetch(`${API_BASE}/wiki/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to update wiki page')
    }
    return data
  }

  const moveWikiPage = async (id, payload) => {
    const res = await fetch(`${API_BASE}/wiki/pages/${id}/move`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to move wiki page')
    }
    return data
  }

  const deleteWikiPage = async (id) => {
    const res = await fetch(`${API_BASE}/wiki/pages/${id}`, { method: 'DELETE' })
    if (res.status === 204) {
      return { deleted: true }
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to delete wiki page')
    }
    return data
  }

  const uploadWikiMedia = async (file) => {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch(`${API_BASE}/wiki/media`, {
      method: 'POST',
      body: formData
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to upload media')
    }
    return data
  }

  const subscribeToComfyWorkflowProgress = (promptId, handlers = {}) => {
    const key = String(promptId || '')
    if (!key) {
      return () => {}
    }

    const stream = getComfyStream()
    const handler = (payload) => {
      try {
        handlers.onMessage?.(payload)
      } catch (err) {
        handlers.onError?.(err)
      }
    }

    if (!stream.listeners.has(key)) {
      stream.listeners.set(key, new Set())
    }
    stream.listeners.get(key).add(handler)

    // Deliver any already-seen terminal event so a listener that subscribes
    // after completion (or right after the run POST resolves) still fires.
    const cachedTerminal = stream.lastTerminal.get(key)
    if (cachedTerminal) {
      Promise.resolve().then(() => handler(cachedTerminal))
    }

    return () => {
      const set = stream.listeners.get(key)
      if (set) {
        set.delete(handler)
        if (set.size === 0) {
          stream.listeners.delete(key)
        }
      }
    }
  }

  return (
    <ProjectContext.Provider value={{ 
      projects, 
      loading,
      createProject,
      updateProject,
      saveGraphViewport,
      getProject,
      deleteProject,
      exportProject,
      importProject,
      getProjectAssets,
      getProjectCards,
      getProjectNodes,
      createProjectNode,
      updateProjectNode,
      updateProjectNodePosition,
      deleteProjectNode,
      getProjectConnections,
      createProjectConnection,
      deleteProjectConnection,
      getProjectTasks,
      createTask,
      uploadAsset,
      saveImageEditorFile,
      uploadAssetThumbnail,
      saveMeshEdit,
      getPaintDocument,
      savePaintDocument,
      attachExistingAsset,
      deleteAsset,
      moveKanbanCard,
      deleteCard,
      getLibraryAssets,
      importLibraryAssets,
      importBrushChildAssets,
      deleteLibraryAsset,
      renameLibraryAsset,
      renameAssetEdit,
      deleteAssetEdit,
      deleteAssetVersion,
      getAttributeTypes,
      getProjectCardAttributes,
      createCardAttribute,
      updateCardAttribute,
      deleteCardAttribute,
      runImageEditApi,
      runMeshGenerationApi,
      queryTencentMeshGenerationResult,
      queryTripoMeshGenerationResult,
      queryHitemMeshGenerationResult,
      runMeshEditApi,
      runMeshTexturingApi,
      runMeshRiggingApi,
      runImageEditComfy,
      generateImage,
      getComfyWorkflows,
      inspectComfyWorkflow,
      importComfyWorkflow,
      updateComfyWorkflow,
      runComfyWorkflow,
      subscribeToComfyWorkflowProgress,
      getWikiConfig,
      getWikiPages,
      getWikiPage,
      createWikiPage,
      updateWikiPage,
      moveWikiPage,
      deleteWikiPage,
      uploadWikiMedia,
      refreshProjects: fetchProjects
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProjects() {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProjects must be used within ProjectProvider')
  return ctx
}
