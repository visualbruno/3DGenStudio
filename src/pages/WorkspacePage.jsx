// "Workspace" project: a single-screen studio. Left, a rail of modules (Image,
// Mesh, Retopo, UV, Texture, Rig) and the active module's panel; center, the
// selected result; right, the project's history (WorkspaceHistory table).
//
// Image, Mesh, Retopo, UV and Texture are built. Rig shows a draft panel for now.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import WorkspaceToolRail from '../components/workspace/WorkspaceToolRail'
import WorkspaceImagePanel from '../components/workspace/WorkspaceImagePanel'
import WorkspaceMeshPanel from '../components/workspace/WorkspaceMeshPanel'
import WorkspaceRetopoPanel from '../components/workspace/WorkspaceRetopoPanel'
import WorkspaceUvPanel from '../components/workspace/WorkspaceUvPanel'
import WorkspaceTexturePanel from '../components/workspace/WorkspaceTexturePanel'
import WorkspaceHistoryPanel from '../components/workspace/WorkspaceHistoryPanel'
import WorkspaceCenterView from '../components/workspace/WorkspaceCenterView'
import WorkspaceModuleDraft from '../components/workspace/WorkspaceModuleDraft'
import useWorkspaceCloudTasks from '../hooks/useWorkspaceCloudTasks'
import { useWorkflowJobs } from '../context/WorkflowJobsContext'
import { useNotifications } from '../context/NotificationContext'
import { assetUrl } from '../config'
import { buildImageEditorPath, buildMeshEditorPath } from '../utils/graphHelpers'
import { createMeshThumbnailFile, createMeshThumbnailFileFromUrl } from '../utils/meshThumbnail'
import { RETOPO_TOOLS } from '../utils/workspaceRetopo'
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
// Modules that work on the shared mesh source (meshTarget).
const MESH_MODULES = ['retopo', 'uv', 'texture']
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
  // The mesh the mesh-processing modules (Retopo, later UV / Texture / Rig)
  // work on: { assetId, name, filename, filePath, thumbnail }.
  const [meshTarget, setMeshTarget] = useState(null)
  const [meshTargetBusy] = useState(false)
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

  const addCloudPending = useCallback((item) => {
    setCloudPending(prev => [...prev, { createdAt: Date.now(), ...item }])
  }, [])

  const updateCloudPending = useCallback((id, patch) => {
    setCloudPending(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)))
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

  // Cloud mesh tasks (Tripo AI, Hitem3D, Tencent Cloud): polled until the mesh
  // is saved, then logged to the history like any other result.
  const handleCloudTaskCompleted = useCallback(async (task, assets) => {
    const meshes = assets.filter(asset => asset && asset.id != null)
    if (!meshes.length) {
      reportError('Mesh generation failed', new Error(`${task.label || 'The cloud API'} finished without a mesh`))
      return
    }
    try {
      const entries = await addWorkspaceHistory(projectId, meshes.map(mesh => ({
        assetId: mesh.id,
        module: 'mesh',
        action: 'generate',
        runId: task.id,
        sourceAssetId: task.history?.sourceAssetId ?? null,
        workflowName: task.history?.workflowName || task.label || '',
        params: task.history?.params || {}
      })))
      handleRunComplete(entries)
    } catch (err) {
      reportError('Could not add the mesh to the history', err)
    }
  }, [projectId, handleRunComplete, reportError])

  const handleCloudTaskFailed = useCallback((task, err) => {
    addNotification({
      title: 'Mesh generation failed',
      message: err?.message || 'The cloud API failed',
      tone: 'error',
      source: task.label || 'Cloud API',
      projectId
    })
  }, [addNotification, projectId])

  const cloudTasks = useWorkspaceCloudTasks(projectId, {
    onCompleted: handleCloudTaskCompleted,
    onFailed: handleCloudTaskFailed
  })

  const pendingJobs = useMemo(
    () => [
      ...cloudPending,
      ...cloudTasks.tasks.map(task => ({
        id: task.id,
        label: task.label || 'Cloud mesh',
        cloud: true,
        stoppable: true,
        progressPercent: cloudTasks.progressById[task.id]?.progress ?? null,
        detail: cloudTasks.progressById[task.id]?.status || 'Submitted',
        createdAt: task.createdAt
      })),
      ...jobs.filter(job => String(job.projectId) === String(projectId)
        && job.page === 'workspace'
        && !TERMINAL_JOB_STATUSES.includes(job.status))
    ].sort((a, b) => b.createdAt - a.createdAt),
    [jobs, projectId, cloudPending, cloudTasks.tasks, cloudTasks.progressById]
  )

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

  // --- mesh inputs (Retopo and the later mesh modules) ----------------------
  const meshTargetFromAsset = (asset) => ({
    assetId: asset.id,
    name: asset.name || 'Mesh',
    filename: asset.filename,
    filePath: asset.filePath,
    thumbnail: asset.thumbnail || null
  })

  // A mesh file from the computer: a root project asset with a rendered
  // thumbnail, logged as an import.
  const importMeshFile = async (file) => {
    let asset = await uploadDetachedAsset(projectId, file, 'mesh')
    try {
      const thumbnail = await createMeshThumbnailFile(file)
      if (thumbnail) asset = { ...asset, ...(await uploadAssetThumbnail(asset.id, thumbnail)) }
    } catch (err) {
      console.warn('Could not render the mesh thumbnail', err)
    }
    const entries = await addWorkspaceHistory(projectId, [{ assetId: asset.id, module: 'mesh', action: 'import' }])
    setHistory(prev => mergeEntries(entries, prev))
    if (entries[0]) setSelectedEntryId(entries[0].id)
    return meshTargetFromAsset(asset)
  }

  // A mesh from the Assets library (root or version): linked to the project
  // and logged as an import the first time it shows up.
  const importLibraryMesh = async (asset) => {
    const { assetId } = await resolveSourceReference(projectId, 'mesh', asset.filename || asset.filePath)
    const resolvedId = assetId ?? asset.id
    const existing = history.find(entry => entry.asset.id === resolvedId)
    if (existing) {
      setSelectedEntryId(existing.id)
      return meshTargetFromAsset(existing.asset)
    }
    const entries = await addWorkspaceHistory(projectId, [{ assetId: resolvedId, module: 'mesh', action: 'import' }])
    setHistory(prev => mergeEntries(entries, prev))
    if (entries[0]) setSelectedEntryId(entries[0].id)
    return meshTargetFromAsset(entries[0]?.asset || { ...asset, id: resolvedId })
  }

  const meshImporters = {
    fromMeshFile: importMeshFile,
    fromMeshAsset: importLibraryMesh,
    fromEntry: async (entry) => meshTargetFromAsset(entry.asset)
  }

  // A mesh-tool result (Retopo / Repair / Optimize, Auto UV): already saved as
  // a version of the source; log it, show it, and make it the next source.
  const handleMeshToolResult = useCallback(async ({ asset, module = 'retopo', label, toolId, options, rows, params, source: runSource }) => {
    const entries = await addWorkspaceHistory(projectId, [{
      assetId: asset.id,
      module,
      action: 'edit',
      sourceAssetId: runSource?.assetId ?? null,
      workflowName: label || RETOPO_TOOLS[toolId]?.label || toolId,
      params: params || { tool: toolId, options, summary: rows }
    }])
    handleRunComplete(entries)
    setMeshTarget(meshTargetFromAsset(entries[0]?.asset || asset))
  }, [projectId, handleRunComplete])

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

  // Open a mesh-processing module on a history mesh.
  const openMeshModule = (moduleId, entry) => {
    if (entry.asset.type !== 'mesh') return
    setActiveModule(moduleId)
    setSelectedEntryId(entry.id)
    setMeshTarget(meshTargetFromAsset(entry.asset))
  }
  const retopoFromEntry = (entry) => openMeshModule('retopo', entry)
  const uvFromEntry = (entry) => openMeshModule('uv', entry)
  const textureFromEntry = (entry) => openMeshModule('texture', entry)

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
    // In a mesh-processing module, clicking a mesh makes it the one to work on.
    if (MESH_MODULES.includes(activeModule) && entry.asset.type === 'mesh') {
      setMeshTarget(meshTargetFromAsset(entry.asset))
    }
  }

  // Opening the Mesh module with an image selected starts from that image.
  const selectModule = (moduleId) => {
    setActiveModule(moduleId)
    if (moduleId === 'mesh' && !meshSource && selectedEntry?.asset.type === 'image') {
      loadMeshSource(() => sourceFromEntry(selectedEntry))
    }
    if (MESH_MODULES.includes(moduleId) && !meshTarget && selectedEntry?.asset.type === 'mesh') {
      setMeshTarget(meshTargetFromAsset(selectedEntry.asset))
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
    } else if (MESH_MODULES.includes(module)) {
      if (original?.asset.type === 'mesh') setMeshTarget(meshTargetFromAsset(original.asset))
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
    // A cloud task cannot be cancelled at the provider; this only stops
    // waiting for it here.
    if (cloudTasks.tasks.some(task => task.id === jobId)) {
      cloudTasks.removeTask(jobId)
      return
    }
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
    : activeModule === 'retopo'
      ? { title: 'Clean up a mesh', text: 'Choose a mesh on the left, then repair, retopologize or optimize it.' }
      : activeModule === 'uv'
        ? { title: 'Unwrap a mesh', text: 'Choose a mesh on the left, then Unwrap UVs.' }
        : activeModule === 'texture'
          ? { title: 'Texture a mesh', text: 'Choose a mesh and a reference image, or a high poly to bake from.' }
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
              onPickSourceEntry={(entry) => loadImageSource(() => sourceFromEntry(entry), 'Could not edit that image')}
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
              onCloudTaskSubmitted={cloudTasks.addTask}
              onGoToImageModule={() => setActiveModule('image')}
              reuse={reuse?.entry.module === 'mesh' ? reuse : null}
            />
          </section>
          <section className="workspace-panel" hidden={activeModule !== 'retopo'}>
            <WorkspaceRetopoPanel
              projectId={projectId}
              target={meshTarget}
              targetBusy={meshTargetBusy}
              importers={meshImporters}
              onTargetChange={setMeshTarget}
              selectedMeshEntry={selectedEntry?.asset.type === 'mesh' ? selectedEntry : null}
              onResult={handleMeshToolResult}
              onPendingAdd={addCloudPending}
              onPendingUpdate={updateCloudPending}
              onPendingRemove={removeCloudPending}
              reuse={reuse?.entry.module === 'retopo' ? reuse : null}
            />
          </section>
          <section className="workspace-panel" hidden={activeModule !== 'uv'}>
            <WorkspaceUvPanel
              projectId={projectId}
              target={meshTarget}
              targetBusy={meshTargetBusy}
              importers={meshImporters}
              onTargetChange={setMeshTarget}
              selectedMeshEntry={selectedEntry?.asset.type === 'mesh' ? selectedEntry : null}
              onResult={handleMeshToolResult}
              onPendingAdd={addCloudPending}
              onPendingUpdate={updateCloudPending}
              onPendingRemove={removeCloudPending}
              reuse={reuse?.entry.module === 'uv' ? reuse : null}
            />
          </section>
          <section className="workspace-panel" hidden={activeModule !== 'texture'}>
            <WorkspaceTexturePanel
              projectId={projectId}
              projectName={project?.name || ''}
              target={meshTarget}
              targetBusy={meshTargetBusy}
              meshImporters={meshImporters}
              imageImporters={importers}
              onTargetChange={setMeshTarget}
              selectedMeshEntry={selectedEntry?.asset.type === 'mesh' ? selectedEntry : null}
              selectedImageEntry={selectedEntry?.asset.type === 'image' ? selectedEntry : null}
              onResult={handleMeshToolResult}
              onPendingAdd={addCloudPending}
              onPendingUpdate={updateCloudPending}
              onPendingRemove={removeCloudPending}
              reuse={reuse?.entry.module === 'texture' ? reuse : null}
            />
          </section>
          {!['image', 'mesh', 'retopo', 'uv', 'texture'].includes(activeModule) && (
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
            onRetopo={retopoFromEntry}
            onAutoUv={uvFromEntry}
            onTexture={textureFromEntry}
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
          onRetopo={retopoFromEntry}
          onAutoUv={uvFromEntry}
          onTexture={textureFromEntry}
          onOpenInEditor={openInEditor}
          onRemove={removeEntry}
          onCancelJob={cancelPendingJob}
        />
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
