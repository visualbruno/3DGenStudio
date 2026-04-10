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
      attachExistingAsset,
      deleteAsset,
      getLibraryAssets,
      generateImage,
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
