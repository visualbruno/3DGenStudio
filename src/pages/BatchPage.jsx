import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import AssetSelectorModal from '../components/AssetSelectorModal'
import BatchVariablesColumn from '../components/batch/BatchVariablesColumn'
import BatchStageColumn from '../components/batch/BatchStageColumn'
import BatchResultsGrid from '../components/batch/BatchResultsGrid'
import { useProjects } from '../context/ProjectContext'
import { useBatchRun } from '../context/BatchRunContext'
import { createMeshThumbnailFile, createMeshThumbnailFileFromUrl } from '../utils/meshThumbnail'
import {
  buildImageEditorPath,
  buildMeshEditorPath,
  getAssetPreviewUrl,
  getWorkflowFileInputAccept
} from '../utils/graphHelpers'
import {
  BATCH_ORDER_BY_GROUP,
  BATCH_ORDER_BY_STAGE,
  createBatchAssetValue,
  createEmptyBatchConfig,
  createGroup,
  createStage,
  createStageDefaultBindings,
  createStageDefaultInputs,
  createVariable,
  deriveCellsFromAssets,
  getBatchAssetIds,
  getGroupLabel,
  getRunIdFromCells,
  getStageLabel,
  isBatchStageWorkflow,
  variableValueKind,
  summarizeRunProgress,
  normalizeBatchConfig,
  validateBatch
} from '../utils/batchHelpers'
import './BatchPage.css'

const AUTOSAVE_DELAY = 700

// A "Batch" preset project: run one linear chain of ComfyUI workflows once per
// group of parameter values. Each executed cell becomes a normal project Card
// carrying its asset, so results behave like any other generation.
export default function BatchPage({ project }) {
  const navigate = useNavigate()
  const {
    getBatchConfig,
    saveBatchConfig,
    getComfyWorkflows,
    getProjectAssets,
    createProject,
    linkAssetToProject,
    uploadAsset,
    uploadAssetThumbnail,
    resolveAssetSourceReference,
    deleteAsset,
    deleteCard
  } = useProjects()

  const [config, setConfig] = useState(createEmptyBatchConfig)
  const [workflows, setWorkflows] = useState([])
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [showSettings, setShowSettings] = useState(false)
  // Collapsed by default: a long problem list used to push the whole workspace
  // below the fold. The count stays visible either way.
  const [problemsOpen, setProblemsOpen] = useState(false)
  // Stages and results compete for vertical space, so only one is shown at a
  // time rather than cropping both.
  const [activeTab, setActiveTab] = useState('stages')
  const [duplicateName, setDuplicateName] = useState(null) // null = dialog closed
  const [duplicating, setDuplicating] = useState(false)
  const [duplicateError, setDuplicateError] = useState('')
  // Filling an image/mesh variable: the library picker, the busy cell while the
  // pick is being attached or uploaded, and whatever went wrong.
  const [assetPicker, setAssetPicker] = useState(null) // { groupId, variableId, type }
  const [pendingAssetKey, setPendingAssetKey] = useState(null) // `${groupId}:${variableId}`
  const [assetError, setAssetError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null) // null = dialog closed
  const [deletingResult, setDeletingResult] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [runError, setRunError] = useState('')
  const [startingRun, setStartingRun] = useState(false)

  const saveTimerRef = useRef(null)
  const lastSavedRef = useRef('')
  const hydratedRef = useRef(false)
  const fileInputRef = useRef(null)
  const uploadTargetRef = useRef(null)
  const thumbnailAttemptsRef = useRef(new Set())

  // Any workflow can be a stage: the chain mixes image generation, image edit
  // and mesh generation, so everything that produces an image or a mesh is
  // offered rather than a single category. The rule lives in the document model
  // because the MCP batch tools have to offer the same list.
  const stageWorkflows = useMemo(
    () => (workflows || []).filter(isBatchStageWorkflow),
    [workflows]
  )

  const workflowsById = useMemo(() => {
    const map = {}
    for (const workflow of stageWorkflows) {
      map[String(workflow.id)] = workflow
    }
    return map
  }, [stageWorkflows])

  // Returns the fresh list as well as storing it, so a caller that has to reason
  // about what survived (deleting a result) does not race the state update.
  const refreshAssets = useCallback(async () => {
    try {
      const next = await getProjectAssets(project.id, { includeChildren: true })
      setAssets(next)
      return next
    } catch (err) {
      console.error('Failed to refresh batch results:', err)
      return null
    }
  }, [getProjectAssets, project.id])

  // The run lives in the backend, so it keeps going while this tab is asleep,
  // reloaded or closed; the page only draws it. `runStateSynced` is false until
  // the backend has said which runs exist — until then an idle-looking grid
  // might be a batch that is running, so Run and Continue stay disabled.
  const {
    runState,
    synced: runStateSynced,
    resultsVersion,
    startBatch,
    cancelBatch,
    clearCells
  } = useBatchRun(project.id)
  const isRunning = runState.status === 'running' || runState.status === 'cancelling'

  // Re-fetch as each cell settles so thumbnails appear while the batch runs, and
  // once on return from an editor so anything finished while away shows up.
  useEffect(() => {
    if (!loading) {
      refreshAssets()
    }
  }, [resultsVersion, loading, refreshAssets])

  // The backend renders a result mesh's thumbnail through the mesh-tools
  // service, and saves the mesh without one when that service is not running.
  // Such results get their thumbnail rendered here instead — one at a time, and
  // once per asset per visit, so a mesh that cannot be rendered is not retried
  // on every refresh.
  useEffect(() => {
    const missing = assets.filter(asset => asset?.type === 'mesh'
      && !asset.thumbnail
      && asset.filename
      && String(asset.cardKey || '').startsWith('batch:')
      && !thumbnailAttemptsRef.current.has(asset.id))
    if (missing.length === 0) {
      return
    }
    missing.forEach(asset => thumbnailAttemptsRef.current.add(asset.id))

    ;(async () => {
      let rendered = 0
      for (const asset of missing) {
        try {
          const fileName = String(asset.filename).split('/').pop() || `${asset.name || 'mesh'}.glb`
          const thumbnailFile = await createMeshThumbnailFileFromUrl(getAssetPreviewUrl(asset.filename), fileName)
          if (thumbnailFile) {
            await uploadAssetThumbnail(asset.id, thumbnailFile)
            rendered += 1
          }
        } catch (err) {
          console.warn(`Failed to render a thumbnail for ${asset.name || asset.id}:`, err)
        }
      }
      if (rendered > 0) {
        refreshAssets()
      }
    })()
  }, [assets, refreshAssets, uploadAssetThumbnail])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const [configResponse, workflowList] = await Promise.all([
          getBatchConfig(project.id),
          getComfyWorkflows()
        ])
        if (cancelled) return
        setConfig(normalizeBatchConfig(configResponse?.state))
        setWorkflows(workflowList || [])
        lastSavedRef.current = JSON.stringify(normalizeBatchConfig(configResponse?.state))
        hydratedRef.current = true
        await refreshAssets()
      } catch (err) {
        console.error('Failed to load the batch project:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [getBatchConfig, getComfyWorkflows, project.id, refreshAssets])

  // Debounced autosave of the whole document, diffed so idle renders don't write.
  useEffect(() => {
    if (loading || !hydratedRef.current) {
      return undefined
    }

    const serialized = JSON.stringify(config)
    if (serialized === lastSavedRef.current) {
      return undefined
    }

    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('saving')
      try {
        await saveBatchConfig(project.id, config)
        lastSavedRef.current = serialized
        setSaveStatus('saved')
      } catch (err) {
        console.error('Failed to save the batch config:', err)
        setSaveStatus('error')
      }
    }, AUTOSAVE_DELAY)

    return () => clearTimeout(saveTimerRef.current)
  }, [config, loading, project.id, saveBatchConfig])

  // --- Config mutation -----------------------------------------------------

  const patchConfig = useCallback((updater) => {
    setConfig(current => updater(normalizeBatchConfig(current)))
  }, [])

  // The order is part of the saved document, so it survives a reload and is
  // carried by Duplicate Project. It is locked while a run is in flight: the
  // walk is decided once, when the run starts.
  const handleSetExecutionOrder = useCallback((executionOrder) => {
    patchConfig(current => ({ ...current, executionOrder }))
  }, [patchConfig])

  const handleAddVariable = useCallback(() => {
    patchConfig(current => ({ ...current, variables: [...current.variables, createVariable()] }))
  }, [patchConfig])

  // Retyping across value kinds — file, boolean, scalar — makes every value that
  // groups already hold meaningless (a typed-in prompt is not an image, and it
  // would resolve to `true` as a boolean), so they are dropped rather than left
  // to fail at run time. Any stage still bound to the variable reports the
  // mismatch until it is repointed.
  const handleUpdateVariable = useCallback((variableId, patch) => {
    patchConfig(current => {
      const previous = current.variables.find(item => item.id === variableId)
      const kindChanged = patch.type !== undefined
        && variableValueKind(patch.type) !== variableValueKind(previous?.type)

      return {
        ...current,
        variables: current.variables.map(item => (item.id === variableId ? { ...item, ...patch } : item)),
        groups: kindChanged
          ? current.groups.map(group => {
            const values = { ...(group.values || {}) }
            delete values[variableId]
            return { ...group, values }
          })
          : current.groups
      }
    })
  }, [patchConfig])

  // Dropping a variable also drops its values and unbinds any stage that used
  // it, so the document never references something that no longer exists.
  const handleRemoveVariable = useCallback((variableId) => {
    patchConfig(current => ({
      ...current,
      variables: current.variables.filter(item => item.id !== variableId),
      groups: current.groups.map(group => {
        const values = { ...(group.values || {}) }
        delete values[variableId]
        return { ...group, values }
      }),
      stages: current.stages.map(stage => ({
        ...stage,
        bindings: Object.fromEntries(
          Object.entries(stage.bindings || {}).filter(([, binding]) => binding?.variableId !== variableId)
        )
      }))
    }))
  }, [patchConfig])

  const handleAddGroup = useCallback(() => {
    patchConfig(current => ({ ...current, groups: [...current.groups, createGroup()] }))
  }, [patchConfig])

  const handleUpdateGroup = useCallback((groupId, patch) => {
    patchConfig(current => ({
      ...current,
      groups: current.groups.map(group => (group.id === groupId ? { ...group, ...patch } : group))
    }))
  }, [patchConfig])

  const handleRemoveGroup = useCallback((groupId) => {
    patchConfig(current => ({ ...current, groups: current.groups.filter(group => group.id !== groupId) }))
  }, [patchConfig])

  const handleDuplicateGroup = useCallback((groupId) => {
    patchConfig(current => {
      const index = current.groups.findIndex(group => group.id === groupId)
      if (index === -1) return current
      const source = current.groups[index]
      const copy = { ...createGroup(source.name ? `${source.name} copy` : ''), values: { ...(source.values || {}) } }
      const groups = [...current.groups]
      groups.splice(index + 1, 0, copy)
      return { ...current, groups }
    })
  }, [patchConfig])

  const handleSetGroupValue = useCallback((groupId, variableId, value) => {
    patchConfig(current => ({
      ...current,
      groups: current.groups.map(group => (
        group.id === groupId
          ? { ...group, values: { ...(group.values || {}), [variableId]: value } }
          : group
      ))
    }))
  }, [patchConfig])

  const handleAddStage = useCallback(() => {
    patchConfig(current => ({ ...current, stages: [...current.stages, createStage()] }))
  }, [patchConfig])

  // Changing the workflow invalidates every binding and manual value, since they
  // were keyed to the previous workflow's parameter ids. The replacement is
  // seeded from the new workflow's own defaults so the stage starts valid
  // instead of reporting one problem per parameter per group.
  const handleUpdateStage = useCallback((stageId, patch) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages.map((stage, stageIndex) => {
        if (stage.id !== stageId) return stage
        const isWorkflowChange = patch.workflowId !== undefined && String(patch.workflowId) !== String(stage.workflowId)
        if (!isWorkflowChange) {
          return { ...stage, ...patch }
        }
        const nextWorkflow = workflowsById[String(patch.workflowId)] || null
        return {
          ...stage,
          ...patch,
          inputs: createStageDefaultInputs(nextWorkflow),
          bindings: createStageDefaultBindings(nextWorkflow, current.stages, stageIndex, current.variables)
        }
      })
    }))
  }, [patchConfig, workflowsById])

  const handleRemoveStage = useCallback((stageId) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages
        .filter(stage => stage.id !== stageId)
        .map(stage => ({
          ...stage,
          bindings: Object.fromEntries(
            Object.entries(stage.bindings || {}).filter(([, binding]) => binding?.stageId !== stageId)
          )
        }))
    }))
  }, [patchConfig])

  // Reordering can put a stage before the one it consumed, so any binding that
  // would now point forwards is cleared rather than left silently broken.
  const handleMoveStage = useCallback((stageId, direction) => {
    patchConfig(current => {
      const index = current.stages.findIndex(stage => stage.id === stageId)
      const nextIndex = index + direction
      if (index === -1 || nextIndex < 0 || nextIndex >= current.stages.length) {
        return current
      }

      const stages = [...current.stages]
      const [moved] = stages.splice(index, 1)
      stages.splice(nextIndex, 0, moved)

      const orderById = new Map(stages.map((stage, position) => [stage.id, position]))
      return {
        ...current,
        stages: stages.map((stage, position) => ({
          ...stage,
          bindings: Object.fromEntries(
            Object.entries(stage.bindings || {}).filter(([, binding]) => (
              binding?.source !== 'stage' || (orderById.get(binding.stageId) ?? Infinity) < position
            ))
          )
        }))
      }
    })
  }, [patchConfig])

  const handleSetBinding = useCallback((stageId, parameterId, binding) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages.map(stage => (
        stage.id === stageId
          ? { ...stage, bindings: { ...(stage.bindings || {}), [parameterId]: binding } }
          : stage
      ))
    }))
  }, [patchConfig])

  const handleSetManualInput = useCallback((stageId, parameterId, value) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages.map(stage => (
        stage.id === stageId
          ? { ...stage, inputs: { ...(stage.inputs || {}), [parameterId]: value } }
          : stage
      ))
    }))
  }, [patchConfig])

  // --- Image / mesh variables ----------------------------------------------

  // Two ways to fill one: pick something already in the library, or upload a
  // file. Both end at the same place — an asset reference stored in the group,
  // which the run hands to ComfyUI exactly like an earlier stage's output.
  const handlePickGroupAsset = useCallback((groupId, variable, mode) => {
    setAssetError('')

    if (mode === 'library') {
      setAssetPicker({ groupId, variableId: variable.id, type: variable.type })
      return
    }

    uploadTargetRef.current = { groupId, variableId: variable.id, type: variable.type }
    const input = fileInputRef.current
    if (input) {
      input.value = ''
      input.accept = getWorkflowFileInputAccept(variable.type)
      input.click()
    }
  }, [])

  const handleLibraryAssetSelected = useCallback(async (asset) => {
    const target = assetPicker
    setAssetPicker(null)
    if (!target || !asset) {
      return
    }

    const pendingKey = `${target.groupId}:${target.variableId}`
    setPendingAssetKey(pendingKey)
    try {
      // Resolving the file rather than sending it straight through is what makes
      // the batch's project a member of the asset, and what keeps an edit or a
      // version referenced as one so results file under the right root.
      const { sourceReference } = await resolveAssetSourceReference(
        project.id,
        target.type,
        asset.filename || asset.filePath
      )
      const assetIdMatch = String(sourceReference || '').match(/^asset:(\d+)$/)

      handleSetGroupValue(target.groupId, target.variableId, createBatchAssetValue({
        source: sourceReference,
        assetId: assetIdMatch ? Number(assetIdMatch[1]) : null,
        name: asset.name || '',
        // A mesh with no rendered thumbnail draws its icon instead — pointing an
        // <img> at the .glb itself would just be a broken image.
        thumbnail: target.type === 'mesh'
          ? (asset.thumbnail || null)
          : (asset.thumbnail || asset.filename || null),
        type: target.type,
        origin: 'library'
      }))
      await refreshAssets()
    } catch (err) {
      console.error('Failed to attach the selected asset:', err)
      setAssetError(err?.message || 'Failed to attach the selected asset')
    } finally {
      setPendingAssetKey(null)
    }
  }, [assetPicker, handleSetGroupValue, project.id, refreshAssets, resolveAssetSourceReference])

  const handleLocalFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0]
    const target = uploadTargetRef.current
    uploadTargetRef.current = null
    event.target.value = ''

    if (!file || !target) {
      return
    }

    const pendingKey = `${target.groupId}:${target.variableId}`
    setPendingAssetKey(pendingKey)
    try {
      const uploaded = await uploadAsset(project.id, file, target.type, {
        ...(target.type === 'image' ? { resolution: 'Unknown' } : {}),
        format: (target.type === 'mesh'
          ? file.name.split('.').pop()
          : file.type.split('/')[1])?.toUpperCase() || target.type.toUpperCase(),
        source: 'IMPORT'
      })

      if (!uploaded?.id) {
        throw new Error(uploaded?.error || 'The upload returned no asset')
      }

      // A mesh has no preview of its own, so render one — otherwise the group
      // shows a bare icon for something the user just picked out of a folder.
      let thumbnail = target.type === 'mesh'
        ? (uploaded.thumbnail || null)
        : (uploaded.thumbnail || uploaded.filename || null)
      if (target.type === 'mesh') {
        try {
          const thumbnailFile = await createMeshThumbnailFile(file)
          if (thumbnailFile) {
            const withThumbnail = await uploadAssetThumbnail(uploaded.id, thumbnailFile)
            thumbnail = withThumbnail?.thumbnail || thumbnail
          }
        } catch (thumbErr) {
          console.warn('Failed to generate a thumbnail for the uploaded mesh:', thumbErr)
        }
      }

      handleSetGroupValue(target.groupId, target.variableId, createBatchAssetValue({
        source: `asset:${uploaded.id}`,
        assetId: uploaded.id,
        name: uploaded.name || file.name,
        thumbnail,
        type: target.type,
        origin: 'local'
      }))
      await refreshAssets()
    } catch (err) {
      console.error('Failed to upload the selected file:', err)
      setAssetError(err?.message || 'Failed to upload the selected file')
    } finally {
      setPendingAssetKey(null)
    }
  }, [handleSetGroupValue, project.id, refreshAssets, uploadAsset, uploadAssetThumbnail])

  // --- Results -------------------------------------------------------------

  // Batch results are ordinary Cards; an asset carries the clientKey of the card
  // it is linked to, which is how each one finds its cell.
  const assetsByCardKey = useMemo(() => {
    const map = {}
    for (const asset of assets) {
      if (asset?.cardKey) {
        map[asset.cardKey] = asset
      }
    }
    return map
  }, [assets])

  // A live run owns the grid; with no run in flight the last run is rebuilt from
  // the cards already in the project, so results survive a reload.
  const displayCells = useMemo(() => {
    if (runState.status !== 'idle') {
      return runState.cells
    }
    return deriveCellsFromAssets(assets, { groups: normalizeBatchConfig(config).groups, stages: normalizeBatchConfig(config).stages })
  }, [assets, config, runState])

  const handleOpenAsset = useCallback((asset) => {
    const path = asset.type === 'mesh'
      ? buildMeshEditorPath({ asset, projectId: project.id, returnTo: `/projects/${project.id}` })
      : buildImageEditorPath({ asset, projectId: project.id, returnTo: `/projects/${project.id}` })
    if (path) navigate(path)
  }, [navigate, project.id])

  const handleRequestDeleteResult = useCallback((target) => {
    setDeleteError('')
    setDeleteTarget({
      cellKey: target.cellKey,
      cardKey: target.cell?.cardKey || null,
      assetId: target.asset?.id ?? target.cell?.assetId ?? null,
      groupId: target.group.id,
      stageIndex: target.stageIndex,
      label: `${getGroupLabel(target.group, target.groupIndex)} · ${getStageLabel(target.stage, target.stageIndex)}`
    })
  }, [])

  // Emptying a cell is what makes it outstanding again, so Continue re-runs this
  // one result and leaves the rest of the grid alone. The result card goes with
  // it; the generated file itself stays in the asset library, exactly as
  // removing a Kanban result does.
  const handleConfirmDeleteResult = useCallback(async () => {
    const target = deleteTarget
    if (!target) return

    setDeletingResult(true)
    setDeleteError('')
    try {
      if (target.assetId) {
        await deleteAsset(target.assetId, { projectId: project.id })
      }
      if (target.cardKey) {
        // Unlinking the asset already prunes an emptied card; this also covers a
        // cell that failed and left a card carrying nothing but its error.
        await deleteCard(project.id, target.cardKey)
      }

      const remaining = await refreshAssets()
      const cellKeys = [target.cellKey]

      // A result that was filed as an edit/version of this one goes with it, so
      // a later stage of the same group can be left pointing at something that
      // is no longer in the project. Those cells are emptied too rather than
      // left claiming a result nothing can open.
      if (remaining) {
        const liveCardKeys = new Set(remaining.filter(item => item?.cardKey).map(item => item.cardKey))
        normalizeBatchConfig(config).stages.slice(target.stageIndex + 1).forEach(stage => {
          const cellKey = `${target.groupId}:${stage.id}`
          const cell = displayCells[cellKey]
          if (cell?.cardKey && !liveCardKeys.has(cell.cardKey)) {
            cellKeys.push(cellKey)
          }
        })
      }

      await clearCells(cellKeys)
      setDeleteTarget(null)
    } catch (err) {
      console.error('Failed to delete the batch result:', err)
      setDeleteError(err?.message || 'Failed to delete the result')
    } finally {
      setDeletingResult(false)
    }
  }, [clearCells, config, deleteAsset, deleteCard, deleteTarget, displayCells, project.id, refreshAssets])

  // --- Duplicate -----------------------------------------------------------

  // Copies the recipe, never the results. Variables, groups and stages are the
  // whole config document; results live as Cards, so not copying them is simply
  // a matter of leaving the new project empty. lastRunId is dropped so the fresh
  // project's grid does not claim to have run anything.
  const handleDuplicate = useCallback(async () => {
    const trimmedName = String(duplicateName || '').trim()
    if (!trimmedName) {
      setDuplicateError('Give the new project a name')
      return
    }

    setDuplicating(true)
    setDuplicateError('')
    try {
      const source = normalizeBatchConfig(config)
      const newProject = await createProject({
        name: trimmedName,
        description: project.description || '',
        preset: 'Batch'
      })
      if (!newProject?.id) {
        throw new Error('The new project was not created')
      }

      await saveBatchConfig(newProject.id, {
        ...source,
        lastRunId: null
      })

      // The recipe travels, and so must the files it points at: a workflow only
      // accepts an asset its own project is a member of, so a copied image/mesh
      // variable would otherwise fail on the first run.
      for (const assetId of getBatchAssetIds(source)) {
        try {
          await linkAssetToProject(newProject.id, assetId)
        } catch (linkErr) {
          console.error('Failed to carry a batch input asset into the copy:', linkErr)
        }
      }

      setDuplicateName(null)
      navigate(`/projects/${newProject.id}`)
    } catch (err) {
      console.error('Failed to duplicate the batch project:', err)
      setDuplicateError(err?.message || 'Failed to duplicate the project')
    } finally {
      setDuplicating(false)
    }
  }, [config, createProject, duplicateName, linkAssetToProject, navigate, project.description, saveBatchConfig])

  // --- Run -----------------------------------------------------------------

  const problems = useMemo(
    () => validateBatch({ config, workflowsById }),
    [config, workflowsById]
  )

  const normalized = normalizeBatchConfig(config)
  const plannedRuns = normalized.groups.length * normalized.stages.length
  const completedCount = Object.values(displayCells).filter(cell => cell?.status === 'completed').length

  // A stopped (or reloaded) run can be picked up where it left off: keep its run
  // id so results land in the same cells, and skip whatever already finished.
  // Works after a reload too, because the derived cells carry their card keys.
  const progress = summarizeRunProgress(displayCells, normalized)
  // Deleting results can empty every cell that carried the run id, so a live run
  // falls back to its own — otherwise Continue would vanish mid-grid.
  const resumeRunId = getRunIdFromCells(displayCells)
    || (runState.status !== 'idle' ? runState.runId : null)
  const orderDescription = normalized.executionOrder === BATCH_ORDER_BY_STAGE
    ? 'one stage at a time across all groups'
    : 'one group at a time through all stages'
  const canContinue = !isRunning
    && Boolean(resumeRunId)
    && progress.done > 0
    && progress.outstanding > 0
  const runBlocked = loading || !runStateSynced || startingRun || problems.length > 0

  // "continue" keeps every cell that already has a result; "restart" runs the
  // whole grid again. The backend decides what is done from the result cards.
  const handleStartBatch = async (mode) => {
    setRunError('')
    setStartingRun(true)
    try {
      await startBatch({ config, mode })
    } catch (err) {
      console.error('Failed to start the batch:', err)
      setRunError(err?.message || 'Failed to start the batch')
    } finally {
      setStartingRun(false)
    }
  }

  const handleCancelBatch = async () => {
    try {
      await cancelBatch()
    } catch (err) {
      console.error('Failed to stop the batch:', err)
      setRunError(err?.message || 'Failed to stop the batch')
    }
  }

  const runProblem = runError || (runState.status === 'error' ? `The batch stopped: ${runState.error || 'unknown error'}` : '')

  return (
    <div className="batch-page">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Batch'}
        centerTitle
        projectId={project?.id}
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {assetPicker && (
        <AssetSelectorModal
          assetType={assetPicker.type}
          showEdits
          onSelect={handleLibraryAssetSelected}
          onClose={() => setAssetPicker(null)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleLocalFileSelected}
      />

      {deleteTarget && (
        <div className="batch-modal__overlay" onClick={() => !deletingResult && setDeleteTarget(null)}>
          <div className="batch-modal" onClick={event => event.stopPropagation()}>
            <h2 className="batch-modal__title font-headline">Delete Result</h2>
            <p className="batch-modal__desc">
              Empties <strong>{deleteTarget.label}</strong>. The cell goes back to
              {' '}<em>Not run</em>, so <strong>Continue</strong> generates just this one again —
              every other result is left alone. The generated file itself stays in your asset
              library.
            </p>

            {deleteError && <p className="batch-modal__error">{deleteError}</p>}

            <div className="batch-modal__actions">
              <button
                type="button"
                className="batch-btn batch-btn--ghost"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingResult}
              >
                Cancel
              </button>
              <button
                type="button"
                className="batch-btn batch-btn--danger"
                onClick={handleConfirmDeleteResult}
                disabled={deletingResult}
              >
                <span className="material-symbols-outlined">delete</span>
                {deletingResult ? 'Deleting…' : 'Delete result'}
              </button>
            </div>
          </div>
        </div>
      )}

      {duplicateName !== null && (
        <div className="batch-modal__overlay" onClick={() => !duplicating && setDuplicateName(null)}>
          <div className="batch-modal" onClick={event => event.stopPropagation()}>
            <h2 className="batch-modal__title font-headline">Duplicate Batch Project</h2>
            <p className="batch-modal__desc">
              Creates a new Batch project with the same {normalized.variables.length} variable
              {normalized.variables.length === 1 ? '' : 's'}, {normalized.groups.length} group
              {normalized.groups.length === 1 ? '' : 's'} and {normalized.stages.length} stage
              {normalized.stages.length === 1 ? '' : 's'}. Generated images and meshes are not copied.
            </p>

            <label className="batch-field">
              <span className="batch-field__label font-label">NEW PROJECT NAME</span>
              <input
                type="text"
                className="batch-input"
                value={duplicateName}
                autoFocus
                onChange={event => setDuplicateName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') handleDuplicate()
                  if (event.key === 'Escape' && !duplicating) setDuplicateName(null)
                }}
                disabled={duplicating}
              />
            </label>

            {duplicateError && <p className="batch-modal__error">{duplicateError}</p>}

            <div className="batch-modal__actions">
              <button
                type="button"
                className="batch-btn batch-btn--ghost"
                onClick={() => setDuplicateName(null)}
                disabled={duplicating}
              >
                Cancel
              </button>
              <button
                type="button"
                className="batch-btn batch-btn--primary"
                onClick={handleDuplicate}
                disabled={duplicating || !String(duplicateName).trim()}
              >
                <span className="material-symbols-outlined">content_copy</span>
                {duplicating ? 'Duplicating…' : 'Duplicate'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="batch-page__toolbar">
        <div className="batch-page__toolbar-left">
          <span className="batch-page__badge font-label">BATCH</span>

          <div className="batch-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'stages'}
              className={`batch-tab ${activeTab === 'stages' ? 'batch-tab--active' : ''}`}
              onClick={() => setActiveTab('stages')}
            >
              STAGES
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'results'}
              className={`batch-tab ${activeTab === 'results' ? 'batch-tab--active' : ''}`}
              onClick={() => setActiveTab('results')}
            >
              RESULTS
              {completedCount > 0 && <span className="batch-tab__count">{completedCount}</span>}
            </button>
          </div>

          <span className="batch-page__summary">
            {normalized.groups.length} group{normalized.groups.length === 1 ? '' : 's'}
            {' · '}
            {normalized.stages.length} stage{normalized.stages.length === 1 ? '' : 's'}
            {' · '}
            {plannedRuns} run{plannedRuns === 1 ? '' : 's'}
          </span>
          <span className={`batch-page__save batch-page__save--${saveStatus}`}>
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed' : saveStatus === 'saved' ? 'Saved' : ''}
          </span>
        </div>

        <div className="batch-page__toolbar-right">
          <div
            className="batch-order"
            role="group"
            aria-label="Execution order"
            title={isRunning
              ? 'The execution order cannot be changed while the batch is running'
              : 'By group: one group through every stage, then the next group. By stage: one stage across every group, then the next stage — which keeps ComfyUI’s model loaded between groups instead of swapping it at every stage.'}
          >
            <span className="batch-order__label font-label">ORDER</span>
            <button
              type="button"
              aria-pressed={normalized.executionOrder === BATCH_ORDER_BY_GROUP}
              className={`batch-order__option ${normalized.executionOrder === BATCH_ORDER_BY_GROUP ? 'batch-order__option--active' : ''}`}
              onClick={() => handleSetExecutionOrder(BATCH_ORDER_BY_GROUP)}
              disabled={loading || isRunning}
            >
              <span className="material-symbols-outlined">table_rows</span>
              BY GROUP
            </button>
            <button
              type="button"
              aria-pressed={normalized.executionOrder === BATCH_ORDER_BY_STAGE}
              className={`batch-order__option ${normalized.executionOrder === BATCH_ORDER_BY_STAGE ? 'batch-order__option--active' : ''}`}
              onClick={() => handleSetExecutionOrder(BATCH_ORDER_BY_STAGE)}
              disabled={loading || isRunning}
            >
              <span className="material-symbols-outlined">view_column</span>
              BY STAGE
            </button>
          </div>

          <button
            type="button"
            className="batch-btn"
            onClick={() => {
              setDuplicateError('')
              setDuplicateName(`${project.name || 'Batch'} copy`)
            }}
            disabled={loading || isRunning}
            title="Create a new Batch project with these variables, groups and stages — without the results"
          >
            <span className="material-symbols-outlined">content_copy</span>
            Duplicate Project
          </button>

          {isRunning ? (
            <button
              type="button"
              className="batch-btn batch-btn--danger"
              onClick={handleCancelBatch}
              disabled={runState.status === 'cancelling'}
              title="The batch runs in the backend on this computer: closing or reloading this tab does not stop it. Stop lets the generation in progress finish."
            >
              <span className="material-symbols-outlined">stop</span>
              {runState.status === 'cancelling' ? 'Stopping after this run…' : 'Stop'}
            </button>
          ) : (
            <>
              {canContinue && (
                <button
                  type="button"
                  className="batch-btn batch-btn--primary"
                  onClick={() => handleStartBatch('continue')}
                  disabled={runBlocked}
                  title={problems.length > 0
                    ? 'Resolve the problems listed below first'
                    : `Pick up where the run stopped — ${progress.done} done, ${progress.outstanding} to go`}
                >
                  <span className="material-symbols-outlined">resume</span>
                  Continue ({progress.outstanding})
                </button>
              )}
              <button
                type="button"
                className={`batch-btn ${canContinue ? '' : 'batch-btn--primary'}`}
                onClick={() => handleStartBatch('restart')}
                disabled={runBlocked || plannedRuns === 0}
                title={problems.length > 0
                  ? 'Resolve the problems listed below first'
                  : `${canContinue ? 'Start over: run' : 'Run'} every group through every stage, ${orderDescription}`}
              >
                <span className="material-symbols-outlined">{canContinue ? 'restart_alt' : 'play_arrow'}</span>
                {canContinue ? 'Restart' : 'Run batch'}
              </button>
            </>
          )}
        </div>
      </div>

      {assetError && (
        <div className="batch-page__problems batch-page__problems--error">
          <button
            type="button"
            className="batch-page__problems-toggle"
            onClick={() => setAssetError('')}
            title="Dismiss"
          >
            <span className="material-symbols-outlined">error</span>
            <span className="batch-page__problems-title font-label">{assetError}</span>
          </button>
        </div>
      )}

      {runProblem && (
        <div className="batch-page__problems batch-page__problems--error">
          <button
            type="button"
            className="batch-page__problems-toggle"
            onClick={() => setRunError('')}
            title="Dismiss"
          >
            <span className="material-symbols-outlined">error</span>
            <span className="batch-page__problems-title font-label">{runProblem}</span>
          </button>
        </div>
      )}

      {problems.length > 0 && !isRunning && (
        <div className="batch-page__problems">
          <button
            type="button"
            className="batch-page__problems-toggle"
            onClick={() => setProblemsOpen(current => !current)}
            aria-expanded={problemsOpen}
          >
            <span className="material-symbols-outlined">
              {problemsOpen ? 'expand_less' : 'expand_more'}
            </span>
            <span className="batch-page__problems-title font-label">
              {problems.length} thing{problems.length === 1 ? '' : 's'} to fix before running
            </span>
          </button>
          {problemsOpen && (
            <ul className="batch-page__problems-list">
              {problems.map((problem, index) => (
                <li key={`${problem.scope}-${index}`}>{problem.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <main className="batch-page__main">
        {loading ? (
          <div className="batch-page__loading font-label">Loading batch…</div>
        ) : activeTab === 'stages' ? (
          <div className="batch-page__columns">
            <BatchVariablesColumn
              variables={normalized.variables}
              groups={normalized.groups}
              locked={isRunning}
              pendingAssetKey={pendingAssetKey}
              onPickGroupAsset={handlePickGroupAsset}
              onAddVariable={handleAddVariable}
              onUpdateVariable={handleUpdateVariable}
              onRemoveVariable={handleRemoveVariable}
              onAddGroup={handleAddGroup}
              onUpdateGroup={handleUpdateGroup}
              onRemoveGroup={handleRemoveGroup}
              onDuplicateGroup={handleDuplicateGroup}
              onSetGroupValue={handleSetGroupValue}
            />

            {normalized.stages.map((stage, stageIndex) => (
              <BatchStageColumn
                key={stage.id}
                stage={stage}
                stageIndex={stageIndex}
                stages={normalized.stages}
                variables={normalized.variables}
                groups={normalized.groups}
                workflows={stageWorkflows}
                workflow={workflowsById[String(stage.workflowId)] || null}
                locked={isRunning}
                onUpdateStage={handleUpdateStage}
                onSetBinding={handleSetBinding}
                onSetManualInput={handleSetManualInput}
                onRemoveStage={handleRemoveStage}
                onMoveStage={handleMoveStage}
              />
            ))}

            <div className="batch-column batch-column--add">
              <button
                type="button"
                className="batch-add-stage"
                onClick={handleAddStage}
                disabled={isRunning}
              >
                <span className="material-symbols-outlined">add</span>
                <span>Add stage</span>
                <span className="batch-add-stage__hint">
                  A stage runs once per group and can consume any earlier stage&apos;s output.
                </span>
              </button>
            </div>
          </div>
        ) : (
          <BatchResultsGrid
            groups={normalized.groups}
            stages={normalized.stages}
            cells={displayCells}
            assetsByCardKey={assetsByCardKey}
            locked={isRunning}
            onOpenAsset={handleOpenAsset}
            onDeleteResult={handleRequestDeleteResult}
          />
        )}
      </main>

      <Footer variant="kanban" />
    </div>
  )
}
