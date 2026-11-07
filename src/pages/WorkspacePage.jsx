// "Workspace" project: a single-screen studio. Left, a rail of modules (Image,
// Mesh, Retopo, UV, Texture, Rig) and the active module's panel; center, the
// selected result; right, the project's history (WorkspaceHistory table).
//
// Image and Mesh are built. The other modules show a draft panel for now.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import WorkspaceToolRail from '../components/workspace/WorkspaceToolRail'
import WorkspaceImagePanel from '../components/workspace/WorkspaceImagePanel'
import WorkspaceMeshPanel from '../components/workspace/WorkspaceMeshPanel'
import WorkspaceHistoryPanel from '../components/workspace/WorkspaceHistoryPanel'
import WorkspaceCenterView from '../components/workspace/WorkspaceCenterView'
import WorkspaceModuleDraft from '../components/workspace/WorkspaceModuleDraft'
import { useWorkflowJobs } from '../context/WorkflowJobsContext'
import { useNotifications } from '../context/NotificationContext'
import { assetUrl } from '../config'
import { buildImageEditorPath, buildMeshEditorPath } from '../utils/graphHelpers'
import { createMeshThumbnailFileFromUrl } from '../utils/meshThumbnail'
import {
  addWorkspaceHistory,
  deleteWorkspaceHistoryEntry,
  fetchWorkspaceHistory,
  resolveSourceReference,
  uploadAssetThumbnail,
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
  const [meshSource, setMeshSource] = useState(null)
  const [meshSourceBusy, setMeshSourceBusy] = useState(false)
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

  // Meshes saved without a thumbnail (the mesh-tools service was not running,
  // or the mesh came from elsewhere) get one rendered here, once per session.
  const thumbnailAttemptsRef = useRef(new Set())
  useEffect(() => {
    const missing = history.filter(entry => entry.asset.type === 'mesh'
      && !entry.asset.thumbnail
      && entry.asset.filename
      && !thumbnailAttemptsRef.current.has(entry.asset.id))
    if (!missing.length) return
    missing.forEach(entry => thumbnailAttemptsRef.current.add(entry.asset.id))

    ;(async () => {
      for (const entry of missing) {
        try {
          const fileName = String(entry.asset.filename).split('/').pop() || 'mesh.glb'
          const file = await createMeshThumbnailFileFromUrl(assetUrl(entry.asset.filename), fileName)
          if (!file) continue
          const updated = await uploadAssetThumbnail(entry.asset.id, file)
          if (!updated?.thumbnail) continue
          setHistory(prev => prev.map(candidate => (candidate.asset.id === entry.asset.id
            ? { ...candidate, asset: { ...candidate.asset, thumbnail: updated.thumbnail } }
            : candidate)))
        } catch (err) {
          console.warn(`Could not render a thumbnail for mesh ${entry.asset.id}`, err)
        }
      }
    })()
  }, [history])

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

  // --- image inputs, shared by every module ---------------------------------
  // Each returns the `source` a panel feeds to a workflow:
  // { assetId, name, filename, thumbnail, width, height, sourceReference }.

  // A file from the computer: becomes a root project asset and is logged as an
  // import.
  const importImageFile = async (file) => {
    const asset = await uploadDetachedAsset(projectId, file, 'image')
    const entries = await addWorkspaceHistory(projectId, [{ assetId: asset.id, module: 'image', action: 'import' }])
    setHistory(prev => mergeEntries(entries, prev))
    if (entries[0]) setSelectedEntryId(entries[0].id)
    return sourceFromAsset(asset, `asset:${asset.id}`)
  }

  // An image from the Assets library (a root or an edit). Linked to the project
  // if it was not already, and logged as an import the first time it shows up.
  const importLibraryImage = async (asset) => {
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
    return sourceFromAsset({ ...asset, id: resolvedId }, sourceReference)
  }

  // An image already in the history.
  const sourceFromEntry = async (entry) => {
    const { sourceReference } = await resolveSourceReference(projectId, 'image', entry.asset.filePath || entry.asset.filename)
    return sourceFromAsset(entry.asset, sourceReference)
  }

  const importers = { fromFile: importImageFile, fromAsset: importLibraryImage, fromEntry: sourceFromEntry }

  // Image module: the image being edited.
  const loadImageSource = async (load, errorTitle) => {
    setSourceBusy(true)
    try {
      setSource(await load())
    } catch (err) {
      reportError(errorTitle, err)
    } finally {
      setSourceBusy(false)
    }
  }

  // Mesh module: the image turned into 3D.
  const loadMeshSource = async (load) => {
    setMeshSourceBusy(true)
    try {
      setMeshSource(await load())
    } catch (err) {
      reportError('Could not use that image', err)
    } finally {
      setMeshSourceBusy(false)
    }
  }

  const editEntry = (entry) => {
    if (entry.asset.type !== 'image') return
    setActiveModule('image')
    setSelectedEntryId(entry.id)
    loadImageSource(() => sourceFromEntry(entry), 'Could not edit that image')
  }

  const makeMeshFromEntry = (entry) => {
    if (entry.asset.type !== 'image') return
    setActiveModule('mesh')
    setSelectedEntryId(entry.id)
    loadMeshSource(() => sourceFromEntry(entry))
  }

  // Clicking an image while the Mesh module is open makes it the image to turn
  // into 3D (as in Tripo); anything else just shows the entry.
  const selectEntry = (entry) => {
    setSelectedEntryId(entry.id)
    if (activeModule === 'mesh' && entry.asset.type === 'image' && entry.asset.id !== meshSource?.assetId) {
      loadMeshSource(() => sourceFromEntry(entry))
    }
  }

  // Opening the Mesh module with an image selected starts from that image.
  const selectModule = (moduleId) => {
    setActiveModule(moduleId)
    if (moduleId === 'mesh' && !meshSource && selectedEntry?.asset.type === 'image') {
      loadMeshSource(() => sourceFromEntry(selectedEntry))
    }
  }

  const reuseEntry = (entry) => {
    const module = entry.module || 'image'
    setActiveModule(module)
    setReuse({ entry, nonce: `${entry.id}:${Date.now()}` })
    const original = entry.sourceAssetId
      ? history.find(candidate => candidate.asset.id === entry.sourceAssetId)
      : null
    if (module === 'mesh') {
      if (original?.asset.type === 'image') loadMeshSource(() => sourceFromEntry(original))
    } else if (entry.action === 'edit') {
      if (original) loadImageSource(() => sourceFromEntry(original), 'Could not edit that image')
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

  const openInEditor = (entry) => {
    const options = { asset: entry.asset, projectId, returnTo: `/projects/${projectId}` }
    navigate(entry.asset.type === 'mesh' ? buildMeshEditorPath(options) : buildImageEditorPath(options))
  }

  const emptyState = activeModule === 'mesh'
    ? { title: 'Ready for a new 3D model?', text: 'Pick an image on the left, then Generate Mesh.' }
    : { title: 'Create your first image!', text: 'Describe it on the left, or import an image to edit it.' }

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
          <WorkspaceToolRail activeModule={activeModule} onSelect={selectModule} />
          {/* The built panels stay mounted (hidden when not active), so each
              keeps its prompt, picks and settings while another is open. */}
          <section className="workspace-panel" hidden={activeModule !== 'image'}>
            <WorkspaceImagePanel
              projectId={projectId}
              projectName={project?.name || ''}
              source={source}
              sourceBusy={sourceBusy}
              onPickSourceFile={(file) => loadImageSource(() => importImageFile(file), 'Image import failed')}
              onPickSourceAsset={(asset) => loadImageSource(() => importLibraryImage(asset), 'Could not use that image')}
              onClearSource={() => setSource(null)}
              onRunComplete={handleRunComplete}
              onPendingAdd={addCloudPending}
              onPendingRemove={removeCloudPending}
              reuse={reuse && (reuse.entry.module || 'image') === 'image' ? reuse : null}
            />
          </section>
          <section className="workspace-panel" hidden={activeModule !== 'mesh'}>
            <WorkspaceMeshPanel
              projectId={projectId}
              projectName={project?.name || ''}
              source={meshSource}
              sourceBusy={meshSourceBusy}
              onSourceChange={setMeshSource}
              importers={importers}
              selectedImageEntry={selectedEntry?.asset.type === 'image' ? selectedEntry : null}
              onRunComplete={handleRunComplete}
              onGoToImageModule={() => setActiveModule('image')}
              reuse={reuse?.entry.module === 'mesh' ? reuse : null}
            />
          </section>
          {!['image', 'mesh'].includes(activeModule) && (
            <section className="workspace-panel">
              <WorkspaceModuleDraft moduleId={activeModule} />
            </section>
          )}
        </div>

        <main className="workspace-main">
          <WorkspaceCenterView
            entry={selectedEntry}
            sourceEntry={sourceEntry}
            emptyTitle={historyLoading ? 'Loading…' : emptyState.title}
            emptyText={historyLoading ? '' : emptyState.text}
            onEdit={editEntry}
            onMakeMesh={makeMeshFromEntry}
            onReuse={reuseEntry}
            onSelectEntry={(entry) => setSelectedEntryId(entry.id)}
            onOpenInEditor={openInEditor}
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
          onSelect={selectEntry}
          onEdit={editEntry}
          onMakeMesh={makeMeshFromEntry}
          onOpenInEditor={openInEditor}
          onRemove={removeEntry}
          onCancelJob={cancelPendingJob}
        />
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
