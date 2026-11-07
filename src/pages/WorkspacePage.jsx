// "Workspace" project: a single-screen studio. Left, a rail of modules (Image,
// Mesh, Retopo, UV, Texture, Rig) and the active module's panel; center, the
// selected result; right, the project's history (WorkspaceHistory table).
//
// Only the Image module is built. The others show a draft panel for now.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import WorkspaceToolRail from '../components/workspace/WorkspaceToolRail'
import WorkspaceImagePanel from '../components/workspace/WorkspaceImagePanel'
import WorkspaceHistoryPanel from '../components/workspace/WorkspaceHistoryPanel'
import WorkspaceCenterView from '../components/workspace/WorkspaceCenterView'
import WorkspaceModuleDraft from '../components/workspace/WorkspaceModuleDraft'
import { useWorkflowJobs } from '../context/WorkflowJobsContext'
import { useNotifications } from '../context/NotificationContext'
import { buildImageEditorPath } from '../utils/graphHelpers'
import {
  addWorkspaceHistory,
  deleteWorkspaceHistoryEntry,
  fetchWorkspaceHistory,
  resolveSourceReference,
  uploadDetachedAsset
} from '../utils/workspaceApi'
import './WorkspacePage.css'

const HISTORY_PAGE = 120
const TERMINAL_JOB_STATUSES = ['completed', 'error', 'cancelled']

// Newest first, no duplicates (a run can report entries already loaded).
function mergeEntries(incoming, existing) {
  const seen = new Set()
  const merged = []
  for (const entry of [...incoming, ...existing]) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  return merged.sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id))
}

function sourceFromAsset(asset, sourceReference) {
  return {
    assetId: asset.id,
    name: asset.name || 'Image',
    filename: asset.filename,
    thumbnail: asset.thumbnail || null,
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    sourceReference
  }
}

export default function WorkspacePage({ project }) {
  const projectId = project.id
  const navigate = useNavigate()
  const { jobs, cancelJob } = useWorkflowJobs()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [activeModule, setActiveModule] = useState('image')
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [selectedEntryId, setSelectedEntryId] = useState(null)
  const [source, setSource] = useState(null)
  const [sourceBusy, setSourceBusy] = useState(false)
  const [reuse, setReuse] = useState(null)
  // Cloud API requests in flight (they have no ComfyUI job to show).
  const [cloudPending, setCloudPending] = useState([])

  useEffect(() => {
    let cancelled = false
    fetchWorkspaceHistory(projectId, { limit: HISTORY_PAGE })
      .then(entries => {
        if (cancelled) return
        setHistory(entries)
        setHasMore(entries.length >= HISTORY_PAGE)
        setHistoryError('')
      })
      .catch(err => {
        if (!cancelled) setHistoryError(err.message || 'Failed to load the history')
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => { cancelled = true }
  }, [projectId])

  const loadMore = async () => {
    const last = history[history.length - 1]
    if (!last) return
    setHistoryLoading(true)
    try {
      const entries = await fetchWorkspaceHistory(projectId, { limit: HISTORY_PAGE, before: last.id })
      setHistory(prev => mergeEntries(entries, prev))
      setHasMore(entries.length >= HISTORY_PAGE)
    } catch (err) {
      setHistoryError(err.message || 'Failed to load the history')
    } finally {
      setHistoryLoading(false)
    }
  }

  const pendingJobs = useMemo(
    () => [
      ...cloudPending,
      ...jobs.filter(job => String(job.projectId) === String(projectId)
        && job.page === 'workspace'
        && !TERMINAL_JOB_STATUSES.includes(job.status))
    ].sort((a, b) => b.createdAt - a.createdAt),
    [jobs, projectId, cloudPending]
  )

  const addCloudPending = useCallback((item) => {
    setCloudPending(prev => [...prev, item])
  }, [])

  const removeCloudPending = useCallback((id) => {
    setCloudPending(prev => prev.filter(item => item.id !== id))
  }, [])

  const selectedEntry = history.find(entry => entry.id === selectedEntryId) || history[0] || null
  const sourceEntry = selectedEntry?.sourceAssetId
    ? history.find(entry => entry.asset.id === selectedEntry.sourceAssetId) || null
    : null

  const reportError = useCallback((title, err) => {
    console.error(title, err)
    addNotification({ title, message: err?.message || String(err), tone: 'error', projectId })
  }, [addNotification, projectId])

  const handleRunComplete = useCallback((entries) => {
    if (!entries?.length) return
    setHistory(prev => mergeEntries(entries, prev))
    setSelectedEntryId(entries[0].id)
  }, [])

  // A file from the computer: becomes a root project asset, is logged as an
  // import, and is attached as the image to edit.
  const pickSourceFile = async (file) => {
    setSourceBusy(true)
    try {
      const asset = await uploadDetachedAsset(projectId, file, 'image')
      const entries = await addWorkspaceHistory(projectId, [{ assetId: asset.id, module: 'image', action: 'import' }])
      setHistory(prev => mergeEntries(entries, prev))
      if (entries[0]) setSelectedEntryId(entries[0].id)
      setSource(sourceFromAsset(asset, `asset:${asset.id}`))
    } catch (err) {
      reportError('Image import failed', err)
    } finally {
      setSourceBusy(false)
    }
  }

  // An image from the Assets library (a root or an edit). Linked to the project
  // if it was not already, and logged as an import the first time it shows up.
  const pickSourceAsset = async (asset) => {
    setSourceBusy(true)
    try {
      const { sourceReference, assetId } = await resolveSourceReference(projectId, 'image', asset.filename || asset.filePath)
      const resolvedId = assetId ?? asset.id
      const existing = history.find(entry => entry.asset.id === resolvedId)
      if (existing) {
        setSelectedEntryId(existing.id)
      } else if (resolvedId != null) {
        const entries = await addWorkspaceHistory(projectId, [{ assetId: resolvedId, module: 'image', action: 'import' }])
        setHistory(prev => mergeEntries(entries, prev))
        if (entries[0]) setSelectedEntryId(entries[0].id)
      }
      setSource(sourceFromAsset({ ...asset, id: resolvedId }, sourceReference))
    } catch (err) {
      reportError('Could not use that image', err)
    } finally {
      setSourceBusy(false)
    }
  }

  const editEntry = async (entry) => {
    if (entry.asset.type !== 'image') return
    setActiveModule('image')
    setSelectedEntryId(entry.id)
    setSourceBusy(true)
    try {
      const { sourceReference } = await resolveSourceReference(projectId, 'image', entry.asset.filePath || entry.asset.filename)
      setSource(sourceFromAsset(entry.asset, sourceReference))
    } catch (err) {
      reportError('Could not edit that image', err)
    } finally {
      setSourceBusy(false)
    }
  }

  const reuseEntry = (entry) => {
    setActiveModule(entry.module || 'image')
    setReuse({ entry, nonce: `${entry.id}:${Date.now()}` })
    if (entry.action === 'edit') {
      const original = history.find(candidate => candidate.asset.id === entry.sourceAssetId)
      if (original) editEntry(original)
    } else {
      setSource(null)
    }
  }

  const removeEntry = async (entry) => {
    try {
      await deleteWorkspaceHistoryEntry(projectId, entry.id)
      setHistory(prev => prev.filter(candidate => candidate.id !== entry.id))
      if (selectedEntryId === entry.id) setSelectedEntryId(null)
    } catch (err) {
      reportError('Could not remove the entry', err)
    }
  }

  const cancelPendingJob = async (jobId) => {
    if (!await cancelJob(jobId)) {
      addNotification({ title: 'Cancel failed', message: 'The run could not be cancelled.', tone: 'error', projectId })
    }
  }

  const openInImageEditor = (entry) => {
    navigate(buildImageEditorPath({ asset: entry.asset, projectId, returnTo: `/projects/${projectId}` }))
  }

  return (
    <div className="workspace-page">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Workspace'}
        centerTitle
        projectId={projectId}
      />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="workspace-body">
        <div className="workspace-left">
          <WorkspaceToolRail activeModule={activeModule} onSelect={setActiveModule} />
          <section className="workspace-panel">
            {activeModule === 'image' ? (
              <WorkspaceImagePanel
                projectId={projectId}
                projectName={project?.name || ''}
                source={source}
                sourceBusy={sourceBusy}
                onPickSourceFile={pickSourceFile}
                onPickSourceAsset={pickSourceAsset}
                onClearSource={() => setSource(null)}
                onRunComplete={handleRunComplete}
                onPendingAdd={addCloudPending}
                onPendingRemove={removeCloudPending}
                reuse={reuse}
              />
            ) : (
              <WorkspaceModuleDraft moduleId={activeModule} />
            )}
          </section>
        </div>

        <main className="workspace-main">
          <WorkspaceCenterView
            entry={selectedEntry}
            sourceEntry={sourceEntry}
            emptyTitle={historyLoading ? 'Loading…' : 'Create your first image!'}
            emptyText={historyLoading ? '' : 'Describe it on the left, or import an image to edit it.'}
            onEdit={editEntry}
            onReuse={reuseEntry}
            onSelectEntry={(entry) => setSelectedEntryId(entry.id)}
            onOpenInEditor={openInImageEditor}
          />
        </main>

        <WorkspaceHistoryPanel
          entries={history}
          loading={historyLoading}
          error={historyError}
          hasMore={hasMore}
          onLoadMore={loadMore}
          pendingJobs={pendingJobs}
          selectedEntryId={selectedEntry?.id ?? null}
          onSelect={(entry) => setSelectedEntryId(entry.id)}
          onEdit={editEntry}
          onRemove={removeEntry}
          onCancelJob={cancelPendingJob}
        />
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
