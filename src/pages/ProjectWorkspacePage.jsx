import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import KanbanPage from './KanbanPage'
import GraphPage from './GraphPage'

function isGraphPreset(project) {
  return String(project?.preset || '').trim().toLowerCase() === 'graph'
}

export default function ProjectWorkspacePage() {
  const { projectId } = useParams()
  const { getProject } = useProjects()
  const [project, setProject] = useState(undefined)

  useEffect(() => {
    let cancelled = false

    async function loadProject() {
      try {
        const projectData = await getProject(projectId)

        if (!cancelled) {
          setProject(projectData)
        }
      } catch (err) {
        console.error('Failed to load project:', err)

        if (!cancelled) {
          setProject(null)
        }
      }
    }

    loadProject()

    return () => {
      cancelled = true
    }
  }, [projectId, getProject])

  if (project === undefined) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--background)',
        color: 'var(--on-surface-variant)'
      }}>
        Loading workspace…
      </div>
    )
  }

  if (!project) {
    return <Navigate to="/projects" replace />
  }

  if (isGraphPreset(project)) {
    return <GraphPage project={project} />
  }

  return <KanbanPage />
}
