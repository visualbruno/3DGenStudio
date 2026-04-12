import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import Viewer from '../components/Viewer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { createMeshThumbnailFile, isMeshFile } from '../utils/meshThumbnail'
import './AssetsPage.css'

const ASSETS_PER_PAGE = 20
const COMFY_VALUE_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' }
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
  return item?.type === 'number' ? 'number' : 'string'
}

function createSelectionMap(items, getLabel, isOutput = false) {
  return Object.fromEntries(
    items.map(item => [
      item.id || item.nodeId,
      {
        selected: true,
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

export default function AssetsPage() {
  const {
    getLibraryAssets,
    importLibraryAssets,
    deleteLibraryAsset,
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
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleGoToProject} disabled={!linkedAssetDialog.projectId}>
                Go to project
              </button>
            </div>
          </div>
        </div>
      )}

      {meshPreviewAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setMeshPreviewAsset(null)}>
          <div className="assets-dialog assets-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby="mesh-preview-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="mesh-preview-dialog-title" className="assets-dialog__title font-headline">{meshPreviewAsset.name}</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setMeshPreviewAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body assets-dialog__body--viewer">
              <Viewer height="100%" modelUrl={meshPreviewAsset.url} />
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setMeshPreviewAsset(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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

                                <div className="library-config-list">
                                  {inspectedWorkflow.inputs.length > 0 ? inspectedWorkflow.inputs.map(input => (
                                    <div key={input.id} className="library-config-item">
                                      <label className="library-checkbox-row">
                                        <input
                                          type="checkbox"
                                          checked={selectedInputs[input.id]?.selected || false}
                                          onChange={event => setSelectedInputs(prev => ({
                                            ...prev,
                                            [input.id]: {
                                              ...prev[input.id],
                                              selected: event.target.checked
                                            }
                                          }))}
                                        />
                                        <div>
                                          <strong>{input.label}</strong>
                                          <span>{input.type} • default: {formatDefaultValue(input.defaultValue)}</span>
                                        </div>
                                      </label>

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
                                  )) : (
                                    <p className="library-empty-inline">No editable workflow inputs were detected.</p>
                                  )}
                                </div>
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

                                <div className="library-config-list">
                                  {inspectedWorkflow.outputs.length > 0 ? inspectedWorkflow.outputs.map(output => (
                                    <div key={output.nodeId} className="library-config-item">
                                      <label className="library-checkbox-row">
                                        <input
                                          type="checkbox"
                                          checked={selectedOutputs[output.nodeId]?.selected || false}
                                          onChange={event => setSelectedOutputs(prev => ({
                                            ...prev,
                                            [output.nodeId]: {
                                              ...prev[output.nodeId],
                                              selected: event.target.checked
                                            }
                                          }))}
                                        />
                                        <div>
                                          <strong>{output.label}</strong>
                                          <span>{output.classType}</span>
                                        </div>
                                      </label>

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
                                  )) : (
                                    <p className="library-empty-inline">No output nodes were detected.</p>
                                  )}
                                </div>
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
                                {activeSection === 'meshes' ? (
                                  <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => setMeshPreviewAsset(asset)}>
                                    OPEN
                                  </button>
                                ) : (
                                  <a href={asset.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                                )}
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
