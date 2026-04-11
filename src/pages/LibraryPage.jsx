import { useEffect, useMemo, useState } from 'react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import './LibraryPage.css'

const COMFY_VALUE_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
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

export default function LibraryPage() {
  const { getComfyWorkflows, inspectComfyWorkflow, importComfyWorkflow, updateComfyWorkflow } = useProjects()
  const [showSettings, setShowSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [workflows, setWorkflows] = useState([])
  const [workflowName, setWorkflowName] = useState('')
  const [workflowJson, setWorkflowJson] = useState(null)
  const [inspectedWorkflow, setInspectedWorkflow] = useState(null)
  const [selectedInputs, setSelectedInputs] = useState({})
  const [selectedOutputs, setSelectedOutputs] = useState({})
  const [editingWorkflowId, setEditingWorkflowId] = useState(null)
  const [feedback, setFeedback] = useState('')

  const loadWorkflows = async () => {
    try {
      setLoading(true)
      const data = await getComfyWorkflows()
      setWorkflows(data)
    } catch (err) {
      console.error('Failed to load ComfyUI workflows:', err)
      setFeedback(err.message || 'Failed to load ComfyUI workflows')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadWorkflows()
  }, [])

  const selectedInputCount = useMemo(
    () => Object.values(selectedInputs).filter(item => item.selected).length,
    [selectedInputs]
  )

  const selectedOutputCount = useMemo(
    () => Object.values(selectedOutputs).filter(item => item.selected).length,
    [selectedOutputs]
  )

  const resetImportState = () => {
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

  const handleWorkflowFileChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const fileText = await file.text()
      const parsedJson = JSON.parse(fileText)
      const inspection = await inspectComfyWorkflow(parsedJson)

      setWorkflowName(file.name.replace(/\.[^.]+$/, ''))
      setWorkflowJson(parsedJson)
      setInspectedWorkflow(inspection)
      setSelectedInputs(createSelectionMap(inspection.inputs, input => input.name))
      setSelectedOutputs(createSelectionMap(inspection.outputs, output => output.nodeTitle, true))
      setEditingWorkflowId(null)
      setFeedback('')
    } catch (err) {
      console.error('Failed to inspect workflow file:', err)
      setFeedback(err.message || 'Invalid workflow JSON file')
      resetImportState()
    } finally {
      event.target.value = ''
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
    setFeedback('')
    document.querySelector('.library-page')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const buildPayload = () => {
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

    const { parameters, outputs } = buildPayload()

    if (outputs.length === 0) {
      setFeedback('Select at least one ComfyUI output to save.')
      return
    }

    try {
      setSaving(true)

      if (editingWorkflowId) {
        await updateComfyWorkflow(editingWorkflowId, {
          name: workflowName,
          parameters,
          outputs
        })
        setFeedback('Workflow updated successfully.')
      } else {
        await importComfyWorkflow({
          name: workflowName,
          workflowJson,
          parameters,
          outputs
        })
        setFeedback('Workflow imported successfully.')
      }

      resetImportState()
      await loadWorkflows()
    } catch (err) {
      console.error('Failed to save workflow:', err)
      setFeedback(err.message || 'Failed to save workflow')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="library-layout">
      <Header showSearch onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="library-page">
        <div className="library-page__container">
          <div className="library-page__header">
            <div>
              <h1 className="library-page__title font-headline">Library</h1>
              <p className="library-page__desc">Import and configure reusable ComfyUI workflows for Kanban image cards.</p>
            </div>
            <div className="library-page__stats">
              <span className="library-page__stat">
                <span className="material-symbols-outlined">account_tree</span>
                <span>{workflows.length} Workflows</span>
              </span>
            </div>
          </div>

          <section className="library-section">
            <div className="library-section__header">
              <div>
                <h2 className="library-section__title font-headline">ComfyUI Workflows</h2>
                <p className="library-section__subtitle">Import a workflow JSON, review detected inputs and outputs, then choose what Kanban should expose as parameters.</p>
              </div>
              <label className="library-upload-btn">
                <input type="file" accept="application/json,.json" onChange={handleWorkflowFileChange} hidden />
                <span className="material-symbols-outlined">upload_file</span>
                Import JSON
              </label>
            </div>

            {feedback && <div className="library-feedback">{feedback}</div>}

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
                            <button className="library-link-btn" onClick={() => applySelectionToAll(setSelectedInputs, true)}>Select All</button>
                            <button className="library-link-btn" onClick={() => applySelectionToAll(setSelectedInputs, false)}>Unselect All</button>
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
                            <button className="library-link-btn" onClick={() => applySelectionToAll(setSelectedOutputs, true)}>Select All</button>
                            <button className="library-link-btn" onClick={() => applySelectionToAll(setSelectedOutputs, false)}>Unselect All</button>
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
                      <button className="library-btn library-btn--secondary" onClick={resetImportState}>Clear</button>
                      <button className="library-btn library-btn--primary" onClick={handleSaveWorkflow} disabled={saving || !workflowName.trim()}>
                        {saving ? (editingWorkflowId ? 'Saving...' : 'Importing...') : (editingWorkflowId ? 'Update Workflow' : 'Save Workflow')}
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

                {loading ? (
                  <div className="library-empty-state">
                    <span className="material-symbols-outlined library-spinner">progress_activity</span>
                    <span>Loading library...</span>
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
                            <button className="library-icon-btn" onClick={() => handleEditWorkflow(workflow)} title="Edit workflow">
                              <span className="material-symbols-outlined">edit</span>
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
          </section>
        </div>
      </main>

      <Footer />
    </div>
  )
}
