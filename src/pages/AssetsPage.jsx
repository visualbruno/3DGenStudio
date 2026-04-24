import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import MeshPreviewDialog from '../components/MeshPreviewDialog'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { createMeshThumbnailFile, isMeshFile } from '../utils/meshThumbnail'
import './AssetsPage.css'

const ASSETS_PER_PAGE = 20
const COMFY_VALUE_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'mesh', label: 'Mesh' }
]

const ASSET_SECTIONS = [
  {
    key: 'images',
    label: 'Images',
    icon: 'image',
    path: 'assets/images',
    emptyIcon: 'image_not_supported',
    emptyMessage: 'No images found in `assets/images`.'
  },
  {
    key: 'meshes',
    label: 'Meshes',
    icon: 'deployed_code',
    path: 'assets/meshes',
    emptyIcon: 'deployed_code',
    emptyMessage: 'No meshes found in `assets/meshes`.'
  },
  {
    key: 'workflows',
    label: 'Workflows',
    icon: 'account_tree',
    path: 'library/workflows',
    emptyIcon: 'account_tree',
    emptyMessage: 'No ComfyUI workflows imported yet.'
  }
]

function getDefaultValueType(item, isOutput = false) {
  if (item?.valueType) return item.valueType
  if (isOutput) return 'image'
  if (item?.type === 'boolean') return 'boolean'
  return item?.type === 'number' ? 'number' : 'string'
}

function createSelectionMap(items, getLabel, isOutput = false, selected = false) {
  return Object.fromEntries(
    items.map(item => [
      item.id || item.nodeId,
      {
        selected,
        name: getLabel(item),
        valueType: getDefaultValueType(item, isOutput)
      }
    ])
  )
}

function hydrateWorkflowSelection(workflow) {
  const parameterMap = new Map((workflow.parameters || []).map(parameter => [parameter.id, parameter]))
  const outputMap = new Map((workflow.outputs || []).map(output => [output.nodeId, output]))

  const inputs = Object.fromEntries(
    (workflow.availableInputs || []).map(input => {
      const selectedParameter = parameterMap.get(input.id)
      return [
        input.id,
        {
          selected: Boolean(selectedParameter),
          name: selectedParameter?.name || input.name,
          valueType: getDefaultValueType(selectedParameter || input)
        }
      ]
    })
  )

  const outputs = Object.fromEntries(
    (workflow.availableOutputs || []).map(output => {
      const selectedOutput = outputMap.get(output.nodeId)
      return [
        output.nodeId,
        {
          selected: Boolean(selectedOutput),
          name: selectedOutput?.name || output.nodeTitle,
          valueType: getDefaultValueType(selectedOutput || output, true)
        }
      ]
    })
  )

  return { inputs, outputs }
}

function formatDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function selectWorkflowItem(setter, key, name, valueType) {
  setter(prev => ({
    ...prev,
    [key]: {
      selected: true,
      name: prev[key]?.name || name,
      valueType: prev[key]?.valueType || valueType
    }
  }))
}

function deselectWorkflowItem(setter, key) {
  setter(prev => ({
    ...prev,
    [key]: {
      ...prev[key],
      selected: false
    }
  }))
}

function formatDimensions(width, height) {
  if (!width || !height) return null
  return `${width} × ${height}`
}

function getAssetChildren(asset) {
  return asset?.children || asset?.edits || []
}

function buildMeshEditorPath(asset, returnTo = '/assets') {
  const assetIdMatch = String(asset.id || '').match(/^library:(\d+)$/) || String(asset.id || '').match(/^(\d+)$/)
  const inheritedProjectId = asset.projectId || asset.parentProjectId || null
  const query = new URLSearchParams({
    assetId: assetIdMatch?.[1] || '',
    filePath: asset.filePath || asset.filename || '',
    url: asset.url || '',
    name: asset.name || 'Mesh',
    projectId: inheritedProjectId ? String(inheritedProjectId) : '',
    returnTo
  })

  return `/mesh-editor?${query.toString()}`
}

function WorkflowOptionSelector({
  title,
  items,
  selectedMap,
  getKey,
  getPrimaryText,
  getSecondaryText,
  onSelect,
  emptyMessage,
  searchPlaceholder
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const containerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined

    const handleClickOutside = event => {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const availableItems = useMemo(
    () => items.filter(item => !selectedMap[getKey(item)]?.selected),
    [getKey, items, selectedMap]
  )

  const filteredItems = useMemo(() => {
    const query = searchValue.trim().toLowerCase()
    if (!query) return availableItems

    return availableItems.filter(item => {
      const haystack = `${getPrimaryText(item)} ${getSecondaryText(item)}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [availableItems, getPrimaryText, getSecondaryText, searchValue])

  const handleSelect = item => {
    onSelect(item)
    setSearchValue('')
    setIsOpen(false)
  }

  return (
    <div ref={containerRef} className="library-selector">
      <button
        type="button"
        className="library-selector__trigger"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
      >
        <span>{title}</span>
        <span className="material-symbols-outlined">{isOpen ? 'expand_less' : 'expand_more'}</span>
      </button>

      {isOpen && (
        <div className="library-selector__menu">
          <div className="library-selector__search">
            <span className="material-symbols-outlined">search</span>
            <input
              className="library-selector__search-input"
              value={searchValue}
              onChange={event => setSearchValue(event.target.value)}
              placeholder={searchPlaceholder}
              autoFocus
            />
          </div>

          <div className="library-selector__options">
            {filteredItems.length > 0 ? filteredItems.map(item => (
              <button
                key={getKey(item)}
                type="button"
                className="library-selector__option"
                onClick={() => handleSelect(item)}
              >
                <strong>{getPrimaryText(item)}</strong>
                <span>{getSecondaryText(item)}</span>
              </button>
            )) : (
              <div className="library-selector__empty">{availableItems.length === 0 ? emptyMessage : 'No matches found.'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AssetsPage() {
  const {
    getLibraryAssets,
    importLibraryAssets,
    deleteLibraryAsset,
    renameLibraryAsset,
    renameAssetEdit,
    deleteAssetEdit,
    deleteAsset,
    getComfyWorkflows,
    inspectComfyWorkflow,
    importComfyWorkflow,
    updateComfyWorkflow
  } = useProjects()
  const navigate = useNavigate()
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [activeSection, setActiveSection] = useState('images')
  const [currentPage, setCurrentPage] = useState(1)
  const [importing, setImporting] = useState(false)
  const [importFeedback, setImportFeedback] = useState(null)
  const [workflowLoading, setWorkflowLoading] = useState(true)
  const [workflowSaving, setWorkflowSaving] = useState(false)
  const [workflows, setWorkflows] = useState([])
  const [workflowName, setWorkflowName] = useState('')
  const [workflowJson, setWorkflowJson] = useState(null)
  const [inspectedWorkflow, setInspectedWorkflow] = useState(null)
  const [selectedInputs, setSelectedInputs] = useState({})
  const [selectedOutputs, setSelectedOutputs] = useState({})
  const [editingWorkflowId, setEditingWorkflowId] = useState(null)
  const [workflowFeedback, setWorkflowFeedback] = useState('')
  const [deletingWorkflowId, setDeletingWorkflowId] = useState(null)
  const [deletingAssetKey, setDeletingAssetKey] = useState(null)
  const [linkedAssetDialog, setLinkedAssetDialog] = useState(null)
  const [meshPreviewAsset, setMeshPreviewAsset] = useState(null)
  const [meshVersionsAsset, setMeshVersionsAsset] = useState(null)
  const [editPreviewAsset, setEditPreviewAsset] = useState(null)
  const [renamingAsset, setRenamingAsset] = useState(null)
  const [renamingAssetName, setRenamingAssetName] = useState('')
  const [renamingAssetKey, setRenamingAssetKey] = useState(null)
  const [renamingEdit, setRenamingEdit] = useState(null)
  const [renamingEditName, setRenamingEditName] = useState('')
  const [renamingEditKey, setRenamingEditKey] = useState(null)
  const [deletingEditKey, setDeletingEditKey] = useState(null)
  const assetFileInputRef = useRef(null)
  const workflowFileInputRef = useRef(null)

  const loadLibrary = useCallback(async () => {
    try {
      const data = await getLibraryAssets()
      setLibraryAssets(data)
    } catch (err) {
      console.error('Failed to load assets library:', err)
    } finally {
      setLoading(false)
    }
  }, [getLibraryAssets])

  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflowLoading(true)
      const data = await getComfyWorkflows()
      setWorkflows(data)
    } catch (err) {
      console.error('Failed to load ComfyUI workflows:', err)
      setWorkflowFeedback(err.message || 'Failed to load ComfyUI workflows')
    } finally {
      setWorkflowLoading(false)
    }
  }, [getComfyWorkflows])

  useEffect(() => {
    loadLibrary()
    loadWorkflows()
  }, [loadLibrary, loadWorkflows])

  useEffect(() => {
    setCurrentPage(1)
  }, [activeSection])

  const selectedInputCount = useMemo(
    () => Object.values(selectedInputs).filter(item => item.selected).length,
    [selectedInputs]
  )

  const selectedOutputCount = useMemo(
    () => Object.values(selectedOutputs).filter(item => item.selected).length,
    [selectedOutputs]
  )

  const selectedInputItems = useMemo(
    () => (inspectedWorkflow?.inputs || []).filter(input => selectedInputs[input.id]?.selected),
    [inspectedWorkflow, selectedInputs]
  )

  const selectedOutputItems = useMemo(
    () => (inspectedWorkflow?.outputs || []).filter(output => selectedOutputs[output.nodeId]?.selected),
    [inspectedWorkflow, selectedOutputs]
  )

  const activeConfig = ASSET_SECTIONS.find(section => section.key === activeSection) || ASSET_SECTIONS[0]
  const isWorkflowSection = activeSection === 'workflows'
  const activeAssets = isWorkflowSection ? [] : (libraryAssets[activeConfig.key] || [])
  const totalPages = Math.max(1, Math.ceil(activeAssets.length / ASSETS_PER_PAGE))
  const pageStart = (currentPage - 1) * ASSETS_PER_PAGE
  const paginatedAssets = activeAssets.slice(pageStart, pageStart + ASSETS_PER_PAGE)
  const pageRangeStart = activeAssets.length === 0 ? 0 : pageStart + 1
  const pageRangeEnd = Math.min(pageStart + ASSETS_PER_PAGE, activeAssets.length)

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const resetWorkflowState = () => {
    setWorkflowName('')
    setWorkflowJson(null)
    setInspectedWorkflow(null)
    setSelectedInputs({})
    setSelectedOutputs({})
    setEditingWorkflowId(null)
  }

  const applySelectionToAll = (setter, selected) => {
    setter(prev => Object.fromEntries(
      Object.entries(prev).map(([key, value]) => [key, { ...value, selected }])
    ))
  }

  const handleImportClick = () => {
    if (isWorkflowSection) {
      workflowFileInputRef.current?.click()
      return
    }

    assetFileInputRef.current?.click()
  }

  const handleAssetImportChange = async (event) => {
    const input = event.target
    const files = Array.from(input.files || [])

    if (files.length === 0) {
      return
    }

    setImporting(true)
    setImportFeedback(null)

    try {
      const assetsToImport = []

      for (const file of files) {
        let thumbnail = null

        if (isMeshFile(file.name)) {
          try {
            thumbnail = await createMeshThumbnailFile(file)
          } catch (err) {
            console.warn(`Failed to generate mesh thumbnail for ${file.name}:`, err)
          }
        }

        assetsToImport.push({ file, thumbnail })
      }

      const result = await importLibraryAssets(assetsToImport)
      await loadLibrary()

      const importedCount = result.imported?.length || 0
      const skippedCount = result.skipped?.length || 0

      setImportFeedback({
        type: skippedCount > 0 ? 'warning' : 'success',
        message: skippedCount > 0
          ? `Imported ${importedCount} assets. ${skippedCount} files were skipped.`
          : `Imported ${importedCount} assets.`
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to import assets.'
      })
    } finally {
      setImporting(false)
      input.value = ''
    }
  }

  const handleStartRenameEdit = (asset, edit) => {
    setRenamingEdit({ asset, edit })
    setRenamingEditName(edit.name || '')
    setImportFeedback(null)
  }

  const handleRenameEdit = async () => {
    if (!renamingEdit?.edit) {
      return
    }

    const nextName = renamingEditName.trim()
    if (!nextName) {
      setImportFeedback({
        type: 'error',
        message: 'Edit name cannot be empty.'
      })
      return
    }

    const editKey = renamingEdit.edit.filePath
    setRenamingEditKey(editKey)

    try {
      await renameAssetEdit({
        filePath: renamingEdit.edit.filePath,
        name: nextName
      })

      const data = await getLibraryAssets()
      setLibraryAssets(data)

      const refreshedAsset = (data.images || []).find(asset => asset.filename === renamingEdit.asset.filename)
      setEditPreviewAsset(refreshedAsset || null)
      setImportFeedback({
        type: 'success',
        message: `Edit renamed to ${nextName}.`
      })
      setRenamingEdit(null)
      setRenamingEditName('')
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to rename edit.'
      })
    } finally {
      setRenamingEditKey(null)
    }
  }

  const handleDeleteEdit = async (asset, edit) => {
    if (!edit?.filePath) {
      return
    }

    const confirmed = window.confirm(`Delete edit "${edit.name?.trim() || 'Unnamed edit'}"?`)
    if (!confirmed) {
      return
    }

    setDeletingEditKey(edit.filePath)
    setImportFeedback(null)

    try {
      await deleteAssetEdit({ filePath: edit.filePath })

      const data = await getLibraryAssets()
      setLibraryAssets(data)

      const refreshedAsset = (data.images || []).find(item => item.filename === asset.filename)
      setEditPreviewAsset(refreshedAsset || { ...asset, children: [], edits: [], childCount: 0, editCount: 0 })
      setImportFeedback({
        type: 'success',
        message: 'Edit deleted.'
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to delete edit.'
      })
    } finally {
      setDeletingEditKey(null)
    }
  }

  const handleStartRenameAsset = (asset) => {
    setRenamingAsset(asset)
    setRenamingAssetName(asset.name || '')
    setImportFeedback(null)
  }

  const handleRenameAsset = async () => {
    if (!renamingAsset) {
      return
    }

    const nextName = renamingAssetName.trim()
    if (!nextName) {
      setImportFeedback({
        type: 'error',
        message: 'Asset name cannot be empty.'
      })
      return
    }

    const assetKey = `${renamingAsset.type}:${renamingAsset.filename}`
    setRenamingAssetKey(assetKey)

    try {
      await renameLibraryAsset({
        type: renamingAsset.type,
        filename: renamingAsset.filename,
        name: nextName
      })

      await loadLibrary()
      setImportFeedback({
        type: 'success',
        message: `${renamingAsset.name} renamed to ${nextName}.`
      })
      setRenamingAsset(null)
      setRenamingAssetName('')
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to rename asset.'
      })
    } finally {
      setRenamingAssetKey(null)
    }
  }

  const handleDeleteAsset = async (asset) => {
    const assetKey = `${asset.type}:${asset.filename}`
    setDeletingAssetKey(assetKey)
    setImportFeedback(null)

    try {
      await deleteLibraryAsset({
        type: asset.type,
        filename: asset.filename
      })

      await loadLibrary()
      setImportFeedback({
        type: 'success',
        message: `${asset.name} deleted.`
      })
    } catch (err) {
      if (err.status === 409) {
        setLinkedAssetDialog({
          asset,
          assetName: asset.name,
          projectId: err.details?.projectId,
          projectName: err.details?.projectName || null
        })
      } else {
        setImportFeedback({
          type: 'error',
          message: err.message || 'Failed to delete asset.'
        })
      }
    } finally {
      setDeletingAssetKey(null)
    }
  }

  const handleGoToProject = () => {
    if (!linkedAssetDialog?.projectId) {
      return
    }

    navigate(`/projects/${linkedAssetDialog.projectId}`)
    setLinkedAssetDialog(null)
  }

  const handleForceDeleteLinkedAsset = async () => {
    if (!linkedAssetDialog?.asset) {
      return
    }

    const asset = linkedAssetDialog.asset
    const assetKey = `${asset.type}:${asset.filename}`
    setDeletingAssetKey(assetKey)
    setImportFeedback(null)

    try {
      await deleteLibraryAsset({
        type: asset.type,
        filename: asset.filename,
        force: true
      })

      await loadLibrary()
      setLinkedAssetDialog(null)
      setImportFeedback({
        type: 'success',
        message: `${asset.name} deleted.`
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to delete asset.'
      })
    } finally {
      setDeletingAssetKey(null)
    }
  }

  const handleDeleteWorkflow = async (workflow) => {
    setDeletingWorkflowId(workflow.id)
    setWorkflowFeedback('')

    try {
      await deleteAsset(workflow.id)

      if (editingWorkflowId === workflow.id) {
        resetWorkflowState()
      }

      await loadWorkflows()
      setWorkflowFeedback(`${workflow.name} deleted.`)
    } catch (err) {
      console.error('Failed to delete workflow:', err)
      setWorkflowFeedback(err.message || 'Failed to delete workflow')
    } finally {
      setDeletingWorkflowId(null)
    }
  }

  const handleWorkflowFileChange = async (event) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return

    try {
      const fileText = await file.text()
      const parsedJson = JSON.parse(fileText)
      const inspection = await inspectComfyWorkflow(parsedJson)

      setWorkflowName(file.name.replace(/\.[^.]+$/, ''))
      setWorkflowJson(parsedJson)
      setInspectedWorkflow(inspection)
      setSelectedInputs(createSelectionMap(inspection.inputs, item => item.name))
      setSelectedOutputs(createSelectionMap(inspection.outputs, item => item.nodeTitle, true))
      setEditingWorkflowId(null)
      setWorkflowFeedback('')
    } catch (err) {
      console.error('Failed to inspect workflow file:', err)
      setWorkflowFeedback(err.message || 'Invalid workflow JSON file')
      resetWorkflowState()
    } finally {
      input.value = ''
    }
  }

  const handleEditWorkflow = (workflow) => {
    const hydratedSelection = hydrateWorkflowSelection(workflow)
    setWorkflowName(workflow.name)
    setWorkflowJson(workflow.workflowJson)
    setInspectedWorkflow({
      inputs: workflow.availableInputs || [],
      outputs: workflow.availableOutputs || []
    })
    setSelectedInputs(hydratedSelection.inputs)
    setSelectedOutputs(hydratedSelection.outputs)
    setEditingWorkflowId(workflow.id)
    setWorkflowFeedback('')
    document.querySelector('.assets-page')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const buildWorkflowPayload = () => {
    const parameters = (inspectedWorkflow?.inputs || [])
      .filter(input => selectedInputs[input.id]?.selected)
      .map(input => ({
        id: input.id,
        name: selectedInputs[input.id]?.name || input.name,
        valueType: selectedInputs[input.id]?.valueType || getDefaultValueType(input)
      }))

    const outputs = (inspectedWorkflow?.outputs || [])
      .filter(output => selectedOutputs[output.nodeId]?.selected)
      .map(output => ({
        nodeId: output.nodeId,
        name: selectedOutputs[output.nodeId]?.name || output.nodeTitle,
        valueType: selectedOutputs[output.nodeId]?.valueType || getDefaultValueType(output, true)
      }))

    return { parameters, outputs }
  }

  const handleSaveWorkflow = async () => {
    if (!workflowJson || !inspectedWorkflow) return

    const { parameters, outputs } = buildWorkflowPayload()

    if (outputs.length === 0) {
      setWorkflowFeedback('Select at least one ComfyUI output to save.')
      return
    }

    try {
      setWorkflowSaving(true)

      if (editingWorkflowId) {
        await updateComfyWorkflow(editingWorkflowId, {
          name: workflowName,
          parameters,
          outputs
        })
        setWorkflowFeedback('Workflow updated successfully.')
      } else {
        await importComfyWorkflow({
          name: workflowName,
          workflowJson,
          parameters,
          outputs
        })
        setWorkflowFeedback('Workflow imported successfully.')
      }

      resetWorkflowState()
      await loadWorkflows()
    } catch (err) {
      console.error('Failed to save workflow:', err)
      setWorkflowFeedback(err.message || 'Failed to save workflow')
    } finally {
      setWorkflowSaving(false)
    }
  }

  const getSectionCount = (sectionKey) => {
    if (sectionKey === 'workflows') {
      return workflows.length
    }

    return libraryAssets[sectionKey]?.length || 0
  }

  const importButtonLabel = isWorkflowSection
    ? (workflowSaving ? 'Importing...' : 'Import JSON')
    : (importing ? 'Importing...' : 'Import')

  const importButtonDisabled = isWorkflowSection ? workflowSaving : importing

  return (
    <div className="assets-layout">
      <Header showSearch onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {linkedAssetDialog && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setLinkedAssetDialog(null)}>
          <div className="assets-dialog" role="dialog" aria-modal="true" aria-labelledby="linked-asset-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="linked-asset-dialog-title" className="assets-dialog__title font-headline">Asset linked to a project</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setLinkedAssetDialog(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              <p>
                `{linkedAssetDialog.assetName}` is linked to
                {linkedAssetDialog.projectName ? ` ${linkedAssetDialog.projectName}` : ' a project'}.
                Remove it from the project before deleting the library asset.
              </p>
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setLinkedAssetDialog(null)}>
                Close
              </button>
              <button
                type="button"
                className="assets-dialog__btn assets-dialog__btn--danger"
                onClick={handleForceDeleteLinkedAsset}
                disabled={deletingAssetKey === `${linkedAssetDialog.asset?.type}:${linkedAssetDialog.asset?.filename}`}
              >
                Delete Anyway
              </button>
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleGoToProject} disabled={!linkedAssetDialog.projectId}>
                Go to project
              </button>
            </div>
          </div>
        </div>
      )}

      {editPreviewAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setEditPreviewAsset(null)}>
          <div className="assets-dialog assets-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby="asset-edits-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="asset-edits-dialog-title" className="assets-dialog__title font-headline">{editPreviewAsset.name} edits</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setEditPreviewAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              {getAssetChildren(editPreviewAsset).length > 0 ? (
                <div className="asset-edits-grid">
                  {getAssetChildren(editPreviewAsset).map((edit, index) => (
                    <article key={`${edit.editId}-${edit.filePath}-${index}`} className="asset-edit-card">
                      <div className="asset-edit-card__preview">
                        <img src={edit.url} alt={`${editPreviewAsset.name} ${edit.name?.trim() || `edit ${index + 1}`}`} className="asset-card__image" />
                        {formatDimensions(edit.width, edit.height) && (
                          <span className="asset-card__dimensions font-label">{formatDimensions(edit.width, edit.height)}</span>
                        )}
                      </div>
                      <div className="asset-edit-card__body">
                        <div className="asset-edit-card__details">
                          <span className="asset-edit-card__title">{edit.name?.trim() || `Edit ${index + 1}`}</span>
                        </div>
                        <div className="asset-card__actions">
                          <button
                            type="button"
                            className="asset-card__icon-btn asset-card__icon-btn--edit"
                            onClick={() => handleStartRenameEdit(editPreviewAsset, edit)}
                            disabled={renamingEditKey === edit.filePath || deletingEditKey === edit.filePath}
                            title="Rename edit"
                          >
                            <span className="material-symbols-outlined">edit</span>
                          </button>
                          <button
                            type="button"
                            className="asset-card__icon-btn"
                            onClick={() => handleDeleteEdit(editPreviewAsset, edit)}
                            disabled={deletingEditKey === edit.filePath || renamingEditKey === edit.filePath}
                            title="Delete edit"
                          >
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                          <a href={edit.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="assets-page__empty-state assets-page__empty-state--compact">
                  <span className="material-symbols-outlined">image_not_supported</span>
                  <span>No edits available for this asset.</span>
                </div>
              )}
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setEditPreviewAsset(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {meshVersionsAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setMeshVersionsAsset(null)}>
          <div className="assets-dialog assets-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby="mesh-versions-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="mesh-versions-dialog-title" className="assets-dialog__title font-headline">{meshVersionsAsset.name} versions</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setMeshVersionsAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              {getAssetChildren(meshVersionsAsset).length > 0 ? (
                <div className="asset-edits-grid">
                  {getAssetChildren(meshVersionsAsset).map((version, index) => (
                    <article key={`${version.filePath}-${index}`} className="asset-edit-card">
                      <div className={`asset-edit-card__preview asset-card__preview--mesh ${version.thumbnailUrl ? 'asset-card__preview--mesh-thumbnail' : ''}`}>
                        {version.thumbnailUrl ? (
                          <>
                            <img src={version.thumbnailUrl} alt={`${version.name?.trim() || `Version ${index + 1}`} thumbnail`} className="asset-card__image" />
                            <span className="asset-card__mesh-tag font-label">VERSION</span>
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined asset-card__mesh-icon">view_in_ar</span>
                            <span className="asset-card__mesh-label font-label">VERSION</span>
                          </>
                        )}
                      </div>
                      <div className="asset-edit-card__body">
                        <div className="asset-edit-card__details">
                          <span className="asset-edit-card__title">{version.name?.trim() || `Version ${index + 1}`}</span>
                        </div>
                        <div className="asset-card__actions">
                          <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => setMeshPreviewAsset(version)}>
                            OPEN
                          </button>
                          <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => navigate(buildMeshEditorPath(version))}>
                            EDIT
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="library-empty-state">
                  <span className="material-symbols-outlined">deployed_code</span>
                  <span>No mesh versions available for this asset.</span>
                </div>
              )}
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setMeshVersionsAsset(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {renamingAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setRenamingAsset(null)}>
          <div className="assets-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-asset-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="rename-asset-dialog-title" className="assets-dialog__title font-headline">Rename asset</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setRenamingAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              <div className="library-field">
                <label className="library-label">Asset Name</label>
                <input
                  className="library-input"
                  value={renamingAssetName}
                  onChange={event => setRenamingAssetName(event.target.value)}
                  placeholder="Enter a new asset name"
                  autoFocus
                />
              </div>
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setRenamingAsset(null)}>
                Cancel
              </button>
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleRenameAsset} disabled={renamingAssetKey === `${renamingAsset.type}:${renamingAsset.filename}`}>
                {renamingAssetKey === `${renamingAsset.type}:${renamingAsset.filename}` ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {renamingEdit && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setRenamingEdit(null)}>
          <div className="assets-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-edit-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="rename-edit-dialog-title" className="assets-dialog__title font-headline">Rename edit</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setRenamingEdit(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              <div className="library-field">
                <label className="library-label">Edit Name</label>
                <input
                  className="library-input"
                  value={renamingEditName}
                  onChange={event => setRenamingEditName(event.target.value)}
                  placeholder="Enter a new edit name"
                  autoFocus
                />
              </div>
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setRenamingEdit(null)}>
                Cancel
              </button>
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleRenameEdit} disabled={renamingEditKey === renamingEdit.edit.filePath}>
                {renamingEditKey === renamingEdit.edit.filePath ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {meshPreviewAsset && <MeshPreviewDialog asset={meshPreviewAsset} onClose={() => setMeshPreviewAsset(null)} />}

      <main className="assets-page">
        <div className="assets-page__container">
          <div className="assets-page__header">
            <div>
              <h1 className="assets-page__title font-headline">Assets Library</h1>
              <p className="assets-page__desc">Browse and import local files, meshes, and reusable ComfyUI workflows.</p>
            </div>
            <div className="assets-page__header-actions">
              <div className="assets-page__stats">
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">image</span>
                  <span>{libraryAssets.images.length} Images</span>
                </div>
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">deployed_code</span>
                  <span>{libraryAssets.meshes.length} Meshes</span>
                </div>
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">account_tree</span>
                  <span>{workflows.length} Workflows</span>
                </div>
              </div>
              <button type="button" className="assets-page__import-btn" onClick={handleImportClick} disabled={importButtonDisabled}>
                <span className="material-symbols-outlined">upload_file</span>
                <span>{importButtonLabel}</span>
              </button>
            </div>
          </div>

          <input
            ref={assetFileInputRef}
            type="file"
            multiple
            className="assets-page__file-input"
            accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.glb,.gltf,.obj,.fbx,.stl,.ply"
            onChange={handleAssetImportChange}
          />

          <input
            ref={workflowFileInputRef}
            type="file"
            className="assets-page__file-input"
            accept="application/json,.json"
            onChange={handleWorkflowFileChange}
          />

          {loading ? (
            <div className="assets-page__loading">
              <span className="material-symbols-outlined assets-page__spinner">progress_activity</span>
              <span>Loading asset folders...</span>
            </div>
          ) : (
            <div className="assets-page__content">
              <aside className="assets-sidebar">
                {ASSET_SECTIONS.map(section => (
                  <button
                    key={section.key}
                    type="button"
                    className={`assets-sidebar__item ${activeSection === section.key ? 'assets-sidebar__item--active' : ''}`}
                    onClick={() => setActiveSection(section.key)}
                  >
                    <span className="material-symbols-outlined">{section.icon}</span>
                    <span className="assets-sidebar__label">{section.label}</span>
                    <span className="assets-sidebar__count">{getSectionCount(section.key)}</span>
                  </button>
                ))}
              </aside>

              <section className="assets-section">
                <div className="assets-section__header">
                  <div>
                    <h2 className="assets-section__title font-headline">{activeConfig.label}</h2>
                    <span className="assets-section__path font-label">{activeConfig.path}</span>
                  </div>
                  <div className="assets-section__summary">
                    <span>{isWorkflowSection ? `${workflows.length} total workflows` : `${activeAssets.length} total assets`}</span>
                    {!isWorkflowSection && <span>{pageRangeStart}-{pageRangeEnd || 0} shown</span>}
                  </div>
                </div>

                {!isWorkflowSection && importFeedback && (
                  <div className={`assets-page__feedback assets-page__feedback--${importFeedback.type}`}>
                    <span className="material-symbols-outlined">
                      {importFeedback.type === 'error' ? 'error' : importFeedback.type === 'warning' ? 'warning' : 'check_circle'}
                    </span>
                    <span>{importFeedback.message}</span>
                  </div>
                )}

                {isWorkflowSection ? (
                  <>
                    {workflowFeedback && <div className="library-feedback">{workflowFeedback}</div>}

                    <div className="library-grid">
                      <article className="library-panel library-panel--import">
                        <div className="library-panel__header">
                          <h3 className="library-panel__title">{editingWorkflowId ? 'Edit Workflow' : 'Import Workflow'}</h3>
                          <span className="library-panel__badge">Setup</span>
                        </div>

                        {inspectedWorkflow ? (
                          <div className="library-import-form">
                            <div className="library-field">
                              <label className="library-label">Workflow Name</label>
                              <input
                                className="library-input"
                                value={workflowName}
                                onChange={event => setWorkflowName(event.target.value)}
                                placeholder="Portrait Studio"
                              />
                            </div>

                            <div className="library-config-grid">
                              <section className="library-config-card">
                                <div className="library-config-card__header">
                                  <div>
                                    <h4>Inputs as Parameters</h4>
                                    <span>{selectedInputCount} selected</span>
                                  </div>
                                  <div className="library-config-actions">
                                    <button type="button" className="library-link-btn" onClick={() => applySelectionToAll(setSelectedInputs, true)}>Select All</button>
                                    <button type="button" className="library-link-btn" onClick={() => applySelectionToAll(setSelectedInputs, false)}>Unselect All</button>
                                  </div>
                                </div>

                                {inspectedWorkflow.inputs.length > 0 ? (
                                  <div className="library-config-list">
                                    <WorkflowOptionSelector
                                      title="Add input"
                                      items={inspectedWorkflow.inputs}
                                      selectedMap={selectedInputs}
                                      getKey={input => input.id}
                                      getPrimaryText={input => input.label || input.name}
                                      getSecondaryText={input => `${input.type} • default: ${formatDefaultValue(input.defaultValue)}`}
                                      onSelect={input => selectWorkflowItem(setSelectedInputs, input.id, input.name, getDefaultValueType(input))}
                                      emptyMessage="All inputs have already been selected."
                                      searchPlaceholder="Search inputs"
                                    />

                                    {selectedInputItems.length > 0 ? (
                                      <div className="library-selected-list">
                                        {selectedInputItems.map(input => (
                                          <div key={input.id} className="library-selected-item">
                                            <div className="library-selected-item__header">
                                              <div>
                                                <strong>{input.label || input.name}</strong>
                                                <span>{input.type} • default: {formatDefaultValue(input.defaultValue)}</span>
                                              </div>
                                              <button
                                                type="button"
                                                className="library-icon-btn"
                                                onClick={() => deselectWorkflowItem(setSelectedInputs, input.id)}
                                                title="Remove input"
                                              >
                                                <span className="material-symbols-outlined">delete</span>
                                              </button>
                                            </div>

                                            <div className="library-config-fields">
                                              <input
                                                className="library-input"
                                                value={selectedInputs[input.id]?.name || ''}
                                                onChange={event => setSelectedInputs(prev => ({
                                                  ...prev,
                                                  [input.id]: {
                                                    ...prev[input.id],
                                                    name: event.target.value
                                                  }
                                                }))}
                                                placeholder="Parameter label"
                                              />
                                              <select
                                                className="library-input"
                                                value={selectedInputs[input.id]?.valueType || getDefaultValueType(input)}
                                                onChange={event => setSelectedInputs(prev => ({
                                                  ...prev,
                                                  [input.id]: {
                                                    ...prev[input.id],
                                                    valueType: event.target.value
                                                  }
                                                }))}
                                              >
                                                {COMFY_VALUE_TYPES.map(option => (
                                                  <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                              </select>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <p className="library-empty-inline">No inputs selected yet.</p>
                                    )}
                                  </div>
                                ) : (
                                  <p className="library-empty-inline">No editable workflow inputs were detected.</p>
                                )}
                              </section>

                              <section className="library-config-card">
                                <div className="library-config-card__header">
                                  <div>
                                    <h4>Outputs to Save</h4>
                                    <span>{selectedOutputCount} selected</span>
                                  </div>
                                  <div className="library-config-actions">
                                    <button type="button" className="library-link-btn" onClick={() => applySelectionToAll(setSelectedOutputs, true)}>Select All</button>
                                    <button type="button" className="library-link-btn" onClick={() => applySelectionToAll(setSelectedOutputs, false)}>Unselect All</button>
                                  </div>
                                </div>

                                {inspectedWorkflow.outputs.length > 0 ? (
                                  <div className="library-config-list">
                                    <WorkflowOptionSelector
                                      title="Add output"
                                      items={inspectedWorkflow.outputs}
                                      selectedMap={selectedOutputs}
                                      getKey={output => output.nodeId}
                                      getPrimaryText={output => output.label || output.nodeTitle}
                                      getSecondaryText={output => output.classType}
                                      onSelect={output => selectWorkflowItem(setSelectedOutputs, output.nodeId, output.nodeTitle, getDefaultValueType(output, true))}
                                      emptyMessage="All outputs have already been selected."
                                      searchPlaceholder="Search outputs"
                                    />

                                    {selectedOutputItems.length > 0 ? (
                                      <div className="library-selected-list">
                                        {selectedOutputItems.map(output => (
                                          <div key={output.nodeId} className="library-selected-item">
                                            <div className="library-selected-item__header">
                                              <div>
                                                <strong>{output.label || output.nodeTitle}</strong>
                                                <span>{output.classType}</span>
                                              </div>
                                              <button
                                                type="button"
                                                className="library-icon-btn"
                                                onClick={() => deselectWorkflowItem(setSelectedOutputs, output.nodeId)}
                                                title="Remove output"
                                              >
                                                <span className="material-symbols-outlined">delete</span>
                                              </button>
                                            </div>

                                            <div className="library-config-fields">
                                              <input
                                                className="library-input"
                                                value={selectedOutputs[output.nodeId]?.name || ''}
                                                onChange={event => setSelectedOutputs(prev => ({
                                                  ...prev,
                                                  [output.nodeId]: {
                                                    ...prev[output.nodeId],
                                                    name: event.target.value
                                                  }
                                                }))}
                                                placeholder="Output label"
                                              />
                                              <select
                                                className="library-input"
                                                value={selectedOutputs[output.nodeId]?.valueType || getDefaultValueType(output, true)}
                                                onChange={event => setSelectedOutputs(prev => ({
                                                  ...prev,
                                                  [output.nodeId]: {
                                                    ...prev[output.nodeId],
                                                    valueType: event.target.value
                                                  }
                                                }))}
                                              >
                                                {COMFY_VALUE_TYPES.map(option => (
                                                  <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                              </select>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <p className="library-empty-inline">No outputs selected yet.</p>
                                    )}
                                  </div>
                                ) : (
                                  <p className="library-empty-inline">No output nodes were detected.</p>
                                )}
                              </section>
                            </div>

                            <div className="library-actions">
                              <button type="button" className="library-btn library-btn--secondary" onClick={resetWorkflowState}>Clear</button>
                              <button type="button" className="library-btn library-btn--primary" onClick={handleSaveWorkflow} disabled={workflowSaving || !workflowName.trim()}>
                                {workflowSaving ? (editingWorkflowId ? 'Saving...' : 'Importing...') : (editingWorkflowId ? 'Update Workflow' : 'Save Workflow')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="library-empty-state">
                            <span className="material-symbols-outlined">upload_file</span>
                            <span>Select a ComfyUI workflow JSON file to inspect its inputs and outputs.</span>
                          </div>
                        )}
                      </article>

                      <article className="library-panel">
                        <div className="library-panel__header">
                          <h3 className="library-panel__title">Imported Workflows</h3>
                          <span className="library-panel__badge">Ready</span>
                        </div>

                        {workflowLoading ? (
                          <div className="library-empty-state">
                            <span className="material-symbols-outlined library-spinner">progress_activity</span>
                            <span>Loading workflows...</span>
                          </div>
                        ) : workflows.length > 0 ? (
                          <div className="library-workflow-list">
                            {workflows.map(workflow => (
                              <article key={workflow.id} className="library-workflow-card">
                                <div className="library-workflow-card__header">
                                  <div>
                                    <h4>{workflow.name}</h4>
                                    <p>{workflow.parameters?.length || 0} parameters • {workflow.outputs?.length || 0} outputs</p>
                                  </div>
                                  <div className="library-workflow-card__actions">
                                    <span className="library-workflow-card__badge">ComfyUI</span>
                                    <button type="button" className="library-icon-btn" onClick={() => handleEditWorkflow(workflow)} title="Edit workflow">
                                      <span className="material-symbols-outlined">edit</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="library-icon-btn"
                                      onClick={() => handleDeleteWorkflow(workflow)}
                                      title="Delete workflow"
                                      disabled={deletingWorkflowId === workflow.id}
                                    >
                                      <span className="material-symbols-outlined">delete</span>
                                    </button>
                                  </div>
                                </div>

                                <div className="library-workflow-card__section">
                                  <span className="library-workflow-card__label">Parameters</span>
                                  <div className="library-chip-list">
                                    {(workflow.parameters || []).length > 0 ? workflow.parameters.map(parameter => (
                                      <span key={parameter.id} className="library-chip">{parameter.name} · {getDefaultValueType(parameter)}</span>
                                    )) : <span className="library-chip library-chip--muted">No exposed parameters</span>}
                                  </div>
                                </div>

                                <div className="library-workflow-card__section">
                                  <span className="library-workflow-card__label">Outputs</span>
                                  <div className="library-chip-list">
                                    {(workflow.outputs || []).map(output => (
                                      <span key={output.nodeId} className="library-chip library-chip--secondary">{output.name || output.nodeTitle} · {getDefaultValueType(output, true)}</span>
                                    ))}
                                  </div>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="library-empty-state">
                            <span className="material-symbols-outlined">account_tree</span>
                            <span>No ComfyUI workflows imported yet.</span>
                          </div>
                        )}
                      </article>
                    </div>

                  </>
                ) : activeAssets.length > 0 ? (
                  <>
                    <div className={`assets-grid ${activeSection === 'images' ? 'assets-grid--images' : 'assets-grid--meshes'}`}>
                      {paginatedAssets.map(asset => (
                        <article key={asset.id} className={`asset-card ${activeSection === 'images' ? 'asset-card--image' : 'asset-card--mesh'}`}>
                          {activeSection === 'images' ? (
                            <div className="asset-card__preview asset-card__preview--image">
                              <img src={asset.url} alt={asset.name} className="asset-card__image" />
                              {formatDimensions(asset.width, asset.height) && (
                                <span className="asset-card__dimensions font-label">{formatDimensions(asset.width, asset.height)}</span>
                              )}
                            </div>
                          ) : (
                            <div className={`asset-card__preview asset-card__preview--mesh ${asset.thumbnailUrl ? 'asset-card__preview--mesh-thumbnail' : ''}`}>
                              {asset.thumbnailUrl ? (
                                <>
                                  <img src={asset.thumbnailUrl} alt={`${asset.name} thumbnail`} className="asset-card__image" />
                                  <span className="asset-card__mesh-tag font-label">3D MESH</span>
                                </>
                              ) : (
                                <>
                                  <span className="material-symbols-outlined asset-card__mesh-icon">view_in_ar</span>
                                  <span className="asset-card__mesh-label font-label">3D MESH</span>
                                </>
                              )}
                            </div>
                          )}
                          <div className="asset-card__body">
                            <h3 className="asset-card__name">{asset.name}</h3>
                            <div className="asset-card__meta">
                              <span className={`asset-card__badge ${activeSection === 'meshes' ? 'asset-card__badge--secondary' : ''}`}>{asset.extension}</span>
                              <div className="asset-card__actions">
                                {activeSection === 'images' && getAssetChildren(asset).length > 0 && (
                                  <button
                                    type="button"
                                    className="asset-card__edits-btn"
                                    onClick={() => setEditPreviewAsset(asset)}
                                    title="Show edits"
                                  >
                                    <span className="material-symbols-outlined">history</span>
                                    {getAssetChildren(asset).length}
                                  </button>
                                )}
                                {activeSection === 'meshes' && getAssetChildren(asset).length > 0 && (
                                  <button
                                    type="button"
                                    className="asset-card__edits-btn"
                                    onClick={() => setMeshVersionsAsset(asset)}
                                    title="Show mesh versions"
                                  >
                                    <span className="material-symbols-outlined">history</span>
                                    {getAssetChildren(asset).length}
                                  </button>
                                )}
                                {activeSection === 'meshes' ? (
                                  <>
                                    <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => setMeshPreviewAsset(asset)}>
                                      OPEN
                                    </button>
                                    <button
                                      type="button"
                                      className="asset-card__link asset-card__link-btn"
                                      onClick={() => navigate(buildMeshEditorPath(asset))}
                                    >
                                      EDIT
                                    </button>
                                  </>
                                ) : (
                                  <a href={asset.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                                )}
                                <button
                                  type="button"
                                  className="asset-card__icon-btn asset-card__icon-btn--edit"
                                  onClick={() => handleStartRenameAsset(asset)}
                                  disabled={renamingAssetKey === `${asset.type}:${asset.filename}`}
                                  title="Rename asset"
                                >
                                  <span className="material-symbols-outlined">edit</span>
                                </button>
                                <button
                                  type="button"
                                  className="asset-card__icon-btn"
                                  onClick={() => handleDeleteAsset(asset)}
                                  disabled={deletingAssetKey === `${asset.type}:${asset.filename}`}
                                  title="Delete asset"
                                >
                                  <span className="material-symbols-outlined">delete</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>

                    <div className="assets-pagination">
                      <div className="assets-pagination__summary">
                        Showing {pageRangeStart}-{pageRangeEnd} of {activeAssets.length}
                      </div>
                      <div className="assets-pagination__controls">
                        <button type="button" className="assets-pagination__button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={currentPage === 1}>
                          Previous
                        </button>
                        <span className="assets-pagination__page">Page {currentPage} / {totalPages}</span>
                        <button type="button" className="assets-pagination__button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={currentPage === totalPages}>
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="assets-page__empty-state">
                    <span className="material-symbols-outlined">{activeConfig.emptyIcon}</span>
                    <span>{activeConfig.emptyMessage}</span>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  )
}
