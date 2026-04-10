import { createContext, useContext, useState, useCallback } from 'react'

const ProjectContext = createContext(null)

const SAMPLE_PROJECTS = [
  {
    id: 'proj_001',
    name: 'Cyberpunk_District_V1',
    description: 'High-fidelity urban environment with neon-lit architecture and volumetric fog.',
    preset: 'Photorealistic ArchViz',
    createdAt: '2026-04-01T10:30:00Z',
    imageCount: 4,
    meshCount: 2,
    status: 'active',
  },
  {
    id: 'proj_002',
    name: 'Organic_Creature_Alpha',
    description: 'Stylized creature design for real-time game engine integration.',
    preset: 'Stylized Game Asset',
    createdAt: '2026-03-28T14:15:00Z',
    imageCount: 8,
    meshCount: 5,
    status: 'complete',
  },
  {
    id: 'proj_003',
    name: 'Mech_Prototype_03',
    description: 'Hard-surface mechanical design — rapid concept iteration.',
    preset: 'Rapid Concept Sculpt',
    createdAt: '2026-04-05T09:00:00Z',
    imageCount: 2,
    meshCount: 0,
    status: 'processing',
  },
]

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState(() => {
    const saved = localStorage.getItem('3dgs_projects')
    return saved ? JSON.parse(saved) : SAMPLE_PROJECTS
  })

  const persist = useCallback((updated) => {
    setProjects(updated)
    localStorage.setItem('3dgs_projects', JSON.stringify(updated))
  }, [])

  const createProject = useCallback((project) => {
    const newProject = {
      ...project,
      id: 'proj_' + Date.now(),
      createdAt: new Date().toISOString(),
      imageCount: 0,
      meshCount: 0,
      status: 'active',
    }
    persist([newProject, ...projects])
    return newProject
  }, [projects, persist])

  const getProject = useCallback((id) => {
    return projects.find(p => p.id === id) || null
  }, [projects])

  const deleteProject = useCallback((id) => {
    persist(projects.filter(p => p.id !== id))
  }, [projects, persist])

  return (
    <ProjectContext.Provider value={{ projects, createProject, getProject, deleteProject }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProjects() {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProjects must be used within ProjectProvider')
  return ctx
}
