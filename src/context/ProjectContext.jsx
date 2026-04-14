import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const ProjectContext = createContext(null)
const API_BASE = 'http://localhost:3001/api'

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

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

  const deleteProject = async (id) => {
    await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' })
    await fetchProjects()
  }

  const getProjectAssets = async (projectId) => {
    const res = await fetch(`${API_BASE}/assets?projectId=${projectId}`)
    return await res.json()
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

  const deleteLibraryAsset = async ({ type, filename }) => {
    const params = new URLSearchParams({ type, filename })
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

  const importLibraryAssets = async (assets) => {
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

    const res = await fetch(`${API_BASE}/assets/library/import`, {
      method: 'POST',
      body: formData
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to import assets')
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

    formData.append('projectId', projectId)
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

    const res = await fetch(`${API_BASE}/comfyui/workflows/run`, {
      method: 'POST',
      body: formData
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data?.error || 'Failed to execute ComfyUI workflow')
    }

    return data
  }

  const subscribeToComfyWorkflowProgress = (promptId, handlers = {}) => {
    if (!promptId || typeof EventSource === 'undefined') {
      return () => {}
    }

    const eventSource = new EventSource(`${API_BASE}/comfyui/workflows/progress/${encodeURIComponent(promptId)}`)

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        handlers.onMessage?.(payload)
      } catch (err) {
        handlers.onError?.(err)
      }
    }

    eventSource.onerror = (event) => {
      handlers.onError?.(event)
    }

    return () => {
      eventSource.close()
    }
  }

  return (
    <ProjectContext.Provider value={{ 
      projects, 
      loading,
      createProject, 
      getProject, 
      deleteProject,
      getProjectAssets,
      getProjectTasks,
      createTask,
      uploadAsset,
      uploadAssetThumbnail,
      attachExistingAsset,
      deleteAsset,
      moveKanbanCard,
      getLibraryAssets,
      importLibraryAssets,
      deleteLibraryAsset,
      renameLibraryAsset,
      renameAssetEdit,
      deleteAssetEdit,
      getAttributeTypes,
      getProjectCardAttributes,
      createCardAttribute,
      updateCardAttribute,
      deleteCardAttribute,
      runImageEditApi,
      runMeshGenerationApi,
      runImageEditComfy,
      generateImage,
      getComfyWorkflows,
      inspectComfyWorkflow,
      importComfyWorkflow,
      updateComfyWorkflow,
      runComfyWorkflow,
      subscribeToComfyWorkflowProgress,
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
