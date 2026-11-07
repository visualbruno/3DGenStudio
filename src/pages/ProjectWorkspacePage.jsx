import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import KanbanPage from './KanbanPage'
import GraphPage from './GraphPage'
import BatchPage from './BatchPage'
import WorkspacePage from './WorkspacePage'

function presetKey(project) {
  return String(project?.preset || '').trim().toLowerCase()
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

  if (presetKey(project) === 'graph') {
    return <GraphPage project={project} />
  }

  if (presetKey(project) === 'batch') {
    return <BatchPage project={project} />
  }

  if (presetKey(project) === 'workspace') {
    // Keyed: per-project state (history, cloud tasks) must not carry over.
    return <WorkspacePage key={project.id} project={project} />
  }

  return <KanbanPage />
}
