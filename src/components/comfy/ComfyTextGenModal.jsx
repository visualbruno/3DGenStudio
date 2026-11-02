// Popup that generates a String using a ComfyUI workflow and returns it to the
// caller. Reuses the existing ComfyUI plumbing from ProjectContext and the
// workflow helpers. Runs ephemerally (no project, no persisted assets/cards).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjects } from '../../context/ProjectContext'
import AssetSelectorModal from '../AssetSelectorModal'
import {
  filterTextGenerationWorkflows,
  getWorkflowParameterValueType,
  isFileWorkflowValueType,
  getWorkflowFileInputAccept,
  createComfyExecutionId
} from '../../utils/graphHelpers'
import { getComfyDraftFromWorkflow } from '../../utils/kanbanHelpers'
import { getWorkflowEnumOptions, resolveWorkflowEnumValue } from '../../utils/workflowEnums'
import { buildAssetUrl } from '../../utils/meshTexturing'
import './ComfyTextGenModal.css'

// Fetch a library asset and turn it into an uploadable File. The popup runs
// without a project, so workflow file inputs must be sent as real uploads
// rather than project-linked asset references.
async function loadAssetAsFile(asset) {
  const url = buildAssetUrl(asset)
  if (!url) throw new Error('Asset URL not found')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load asset ${asset?.name || ''}`.trim())
  const blob = await response.blob()
  const fileName = asset?.filename || asset?.name || 'asset'
  return new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
}

// image/mesh have a library; video does not, so only those two offer "From assets".
function assetTypeForValueType(valueType) {
  if (valueType === 'mesh') return 'mesh'
  if (valueType === 'image') return 'image'
  return null
}

export default function ComfyTextGenModal({ open, onClose, onResult }) {
  const { getComfyWorkflows, runComfyWorkflow, subscribeToComfyWorkflowProgress } = useProjects()

  const [loadingWorkflows, setLoadingWorkflows] = useState(true)
  const [workflows, setWorkflows] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('')
  const [inputs, setInputs] = useState({}) // non-file params: id -> value
  const [fileSources, setFileSources] = useState({}) // file params: id -> { kind, file, source, label }

  const [phase, setPhase] = useState('config') // 'config' | 'running' | 'result'
  const [progress, setProgress] = useState(null) // { percent, detail, label, status }
  const [resultText, setResultText] = useState('')
  const [runError, setRunError] = useState(null)

  const [assetPickerParam, setAssetPickerParam] = useState(null) // { id, assetType }

  const unsubscribeRef = useRef(null)

  const selectedWorkflow = workflows.find(workflow => String(workflow.id) === String(selectedWorkflowId)) || null

  const applyWorkflowSelection = (workflow) => {
    setSelectedWorkflowId(workflow ? String(workflow.id) : '')
    const draft = getComfyDraftFromWorkflow(workflow)
    setInputs(draft.inputs || {})
    setFileSources({})
    setRunError(null)
  }

  // Reset the run when the modal closes, and show the loading state as it opens.
  // Adjusted during render rather than in the effect below, so neither the last
  // run nor a stale error paints for a frame.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setLoadingWorkflows(true)
      setLoadError(null)
    } else {
      setPhase('config')
      setProgress(null)
      setResultText('')
      setRunError(null)
    }
  }

  // Load workflows whenever the modal opens; drop the progress stream when it closes.
  useEffect(() => {
    if (!open) {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      return
    }

    let cancelled = false
    getComfyWorkflows()
      .then(allWorkflows => {
        if (cancelled) return
        const textWorkflows = filterTextGenerationWorkflows(allWorkflows || [])
        setWorkflows(textWorkflows)
        applyWorkflowSelection(textWorkflows[0] || null)
      })
      .catch(err => {
        if (cancelled) return
        setLoadError(err.message || 'Failed to load ComfyUI workflows')
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkflows(false)
      })

    return () => { cancelled = true }
    // getComfyWorkflows is re-created each render; we intentionally reload only when `open` toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Close the progress stream if the component unmounts mid-run.
  useEffect(() => () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
      unsubscribeRef.current = null
    }
  }, [])

  if (!open) return null

  const handleWorkflowChange = (workflowId) => {
    const workflow = workflows.find(item => String(item.id) === String(workflowId)) || null
    applyWorkflowSelection(workflow)
  }

  const handleInputChange = (parameter, rawValue) => {
    setInputs(prev => ({ ...prev, [parameter.id]: rawValue }))
  }

  const handleFileSourceKind = (parameter, kind, assetType) => {
    if (kind === 'asset') {
      setAssetPickerParam({ id: parameter.id, assetType })
      return
    }
    setFileSources(prev => ({ ...prev, [parameter.id]: { kind } }))
  }

  const handleChooseFile = (parameter, file) => {
    if (!file) return
    setFileSources(prev => ({ ...prev, [parameter.id]: { kind: 'file', file, label: file.name } }))
  }

  const handleAssetSelected = async (asset) => {
    const target = assetPickerParam
    setAssetPickerParam(null)
    if (!target) return

    setFileSources(prev => ({
      ...prev,
      [target.id]: { kind: 'asset', loading: true, label: asset?.name || 'Loading…' }
    }))

    try {
      const file = await loadAssetAsFile(asset)
      setFileSources(prev => ({
        ...prev,
        [target.id]: { kind: 'asset', file, label: asset?.name || file.name }
      }))
    } catch (err) {
      setFileSources(prev => ({ ...prev, [target.id]: { kind: 'asset' } }))
      setRunError(err.message || 'Failed to load the selected asset')
    }
  }

  const buildInputs = () => {
    const built = {}
    for (const parameter of selectedWorkflow?.parameters || []) {
      const valueType = getWorkflowParameterValueType(parameter)
      if (isFileWorkflowValueType(valueType)) {
        const source = fileSources[parameter.id]
        built[parameter.id] = source?.file instanceof File ? source.file : null
      } else if (valueType === 'boolean') {
        built[parameter.id] = Boolean(inputs[parameter.id])
      } else {
        built[parameter.id] = inputs[parameter.id]
      }
    }
    return built
  }

  const validate = () => {
    for (const parameter of selectedWorkflow?.parameters || []) {
      const valueType = getWorkflowParameterValueType(parameter)
      const value = inputs[parameter.id]
      if (isFileWorkflowValueType(valueType)) {
        const source = fileSources[parameter.id]
        if (source?.loading) return `Wait for "${parameter.name}" to finish loading.`
        if (!(source?.file instanceof File)) return `Choose a ${valueType} for "${parameter.name}".`
      } else if (valueType === 'number') {
        if (String(value ?? '').trim() === '' || Number.isNaN(Number(value))) {
          return `Enter a valid number for "${parameter.name}".`
        }
      } else if (valueType !== 'boolean') {
        if (!String(value ?? '').trim()) return `Enter a value for "${parameter.name}".`
      }
    }
    return null
  }

  const handleGenerate = async () => {
    if (!selectedWorkflow) return
    const validationError = validate()
    if (validationError) {
      setRunError(validationError)
      return
    }

    const promptId = createComfyExecutionId('comfy-text-prompt')
    const clientId = createComfyExecutionId('comfy-text-client')

    setRunError(null)
    setResultText('')
    setProgress({ percent: 0, detail: 'Preparing ComfyUI workflow', label: 'Waiting for ComfyUI execution to start', status: 'processing' })
    setPhase('running')

    if (unsubscribeRef.current) unsubscribeRef.current()
    unsubscribeRef.current = subscribeToComfyWorkflowProgress(promptId, {
      onMessage: payload => {
        setProgress(prev => ({
          percent: Math.max(Number(prev?.percent) || 0, Number(payload?.progressPercent) || 0),
          detail: payload?.detail || prev?.detail || null,
          label: payload?.currentNodeLabel || prev?.label || null,
          status: payload?.status === 'error' ? 'error' : 'processing'
        }))
      },
      onError: () => {}
    })

    try {
      const results = await runComfyWorkflow(null, {
        workflowId: Number(selectedWorkflow.id),
        inputs: buildInputs(),
        promptId,
        clientId,
        persistProcessingCard: false,
        persistGeneratedAssets: false
      })
      const textResult = (Array.isArray(results) ? results : [results]).find(item => item?.type === 'text')
      if (!textResult || typeof textResult.text !== 'string') {
        throw new Error('The workflow did not return any text output.')
      }
      setResultText(textResult.text)
      setPhase('result')
    } catch (err) {
      setRunError(err.message || 'ComfyUI workflow failed')
      setPhase('config')
    } finally {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }

  const handleInsert = () => {
    onResult?.(resultText)
  }

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget && phase !== 'running') {
      onClose?.()
    }
  }

  const renderParameterField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const value = inputs[parameter.id]

    if (isFileWorkflowValueType(valueType)) {
      const source = fileSources[parameter.id] || { kind: 'none' }
      const assetType = assetTypeForValueType(valueType)
      return (
        <div key={parameter.id} className="comfy-tg-field">
          <label className="comfy-tg-label">{parameter.name} • {valueType.toUpperCase()}</label>
          <select
            className="comfy-tg-input"
            value={source.kind === 'none' ? '' : source.kind}
            onChange={event => handleFileSourceKind(parameter, event.target.value, assetType)}
          >
            <option value="">- Choose a source -</option>
            <option value="file">From computer</option>
            {assetType && <option value="asset">From assets</option>}
          </select>
          {source.kind === 'file' && (
            <div className="comfy-tg-file-row">
              <span className="comfy-tg-hint">{source.label || 'No file chosen'}</span>
              <label className="comfy-tg-btn comfy-tg-btn--ghost comfy-tg-file-btn">
                Choose file
                <input
                  type="file"
                  accept={getWorkflowFileInputAccept(valueType)}
                  className="comfy-tg-hidden-file"
                  onChange={event => {
                    const file = event.target.files?.[0]
                    if (file) handleChooseFile(parameter, file)
                    event.target.value = ''
                  }}
                />
              </label>
            </div>
          )}
          {source.kind === 'asset' && (
            <div className="comfy-tg-file-row">
              <span className="comfy-tg-hint">{source.label || 'No asset selected'}</span>
              <button
                type="button"
                className="comfy-tg-btn comfy-tg-btn--ghost"
                onClick={() => setAssetPickerParam({ id: parameter.id, assetType })}
              >
                Browse
              </button>
            </div>
          )}
        </div>
      )
    }

    if (valueType === 'boolean') {
      return (
        <div key={parameter.id} className="comfy-tg-field">
          <label className="comfy-tg-checkbox">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={event => handleInputChange(parameter, event.target.checked)}
            />
            <span>{parameter.name}</span>
          </label>
        </div>
      )
    }

    const enumOptions = getWorkflowEnumOptions(parameter, value)
    if (enumOptions) {
      return (
        <div key={parameter.id} className="comfy-tg-field">
          <label className="comfy-tg-label">{parameter.name} • {valueType.toUpperCase()}</label>
          <select
            className="comfy-tg-input"
            value={value == null ? '' : String(value)}
            onChange={event => handleInputChange(parameter, resolveWorkflowEnumValue(parameter, event.target.value))}
          >
            {enumOptions.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      )
    }

    if (valueType === 'number') {
      return (
        <div key={parameter.id} className="comfy-tg-field">
          <label className="comfy-tg-label">{parameter.name} • NUMBER</label>
          <input
            type="number"
            className="comfy-tg-input"
            value={value ?? ''}
            onChange={event => handleInputChange(parameter, event.target.value)}
          />
        </div>
      )
    }

    return (
      <div key={parameter.id} className="comfy-tg-field">
        <label className="comfy-tg-label">{parameter.name} • {valueType.toUpperCase()}</label>
        <textarea
          className="comfy-tg-textarea"
          value={typeof value === 'string' ? value : (value ?? '')}
          placeholder={parameter.label || ''}
          onChange={event => handleInputChange(parameter, event.target.value)}
        />
      </div>
    )
  }

  return createPortal(
    <div className="comfy-tg-overlay" role="presentation" onClick={handleBackdropClick}>
      <div className="comfy-tg-modal" role="dialog" aria-modal="true" aria-labelledby="comfy-tg-title">
        <div className="comfy-tg-header">
          <h2 id="comfy-tg-title" className="comfy-tg-title font-headline">Generate text · ComfyUI</h2>
          <button
            type="button"
            className="comfy-tg-close"
            onClick={() => onClose?.()}
            disabled={phase === 'running'}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="comfy-tg-body">
          {loadingWorkflows ? (
            <div className="comfy-tg-state">
              <span className="material-symbols-outlined comfy-tg-spinner">progress_activity</span>
              <span>Loading workflows…</span>
            </div>
          ) : loadError ? (
            <div className="comfy-tg-state comfy-tg-state--error">
              <span className="material-symbols-outlined">error</span>
              <span>{loadError}</span>
            </div>
          ) : workflows.length === 0 ? (
            <div className="comfy-tg-state">
              <span className="material-symbols-outlined">info</span>
              <span>No compatible workflows. Import a ComfyUI workflow with a String output.</span>
            </div>
          ) : (
            <>
              <div className="comfy-tg-field">
                <label className="comfy-tg-label">ComfyUI Workflow</label>
                <select
                  className="comfy-tg-input"
                  value={selectedWorkflowId}
                  onChange={event => handleWorkflowChange(event.target.value)}
                  disabled={phase === 'running'}
                >
                  {workflows.map(workflow => (
                    <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                  ))}
                </select>
              </div>

              {phase !== 'result' && (selectedWorkflow?.parameters || []).map(renderParameterField)}

              {phase === 'running' && (
                <div className="comfy-tg-progress">
                  <div className="comfy-tg-progress-bar">
                    <div
                      className="comfy-tg-progress-fill"
                      style={{ width: `${Math.min(100, Math.max(0, Number(progress?.percent) || 0))}%` }}
                    />
                  </div>
                  <span className="comfy-tg-hint">{progress?.label || progress?.detail || 'Running workflow…'}</span>
                </div>
              )}

              {phase === 'result' && (
                <div className="comfy-tg-field">
                  <label className="comfy-tg-label">Generated text</label>
                  <textarea className="comfy-tg-textarea comfy-tg-textarea--result" value={resultText} readOnly />
                </div>
              )}

              {runError && (
                <div className="comfy-tg-error">
                  <span className="material-symbols-outlined">error</span>
                  <span>{runError}</span>
                </div>
              )}
            </>
          )}
        </div>

        {!loadingWorkflows && !loadError && workflows.length > 0 && (
          <div className="comfy-tg-footer">
            <button
              type="button"
              className="comfy-tg-btn comfy-tg-btn--secondary"
              onClick={() => onClose?.()}
              disabled={phase === 'running'}
            >
              Cancel
            </button>
            {phase === 'result' ? (
              <>
                <button
                  type="button"
                  className="comfy-tg-btn comfy-tg-btn--secondary"
                  onClick={() => { setPhase('config'); setResultText('') }}
                >
                  Regenerate
                </button>
                <button type="button" className="comfy-tg-btn comfy-tg-btn--primary" onClick={handleInsert}>
                  Insert text
                </button>
              </>
            ) : (
              <button
                type="button"
                className="comfy-tg-btn comfy-tg-btn--primary"
                onClick={handleGenerate}
                disabled={phase === 'running' || !selectedWorkflow}
              >
                {phase === 'running' ? 'Generating…' : 'Generate'}
              </button>
            )}
          </div>
        )}
      </div>

      {assetPickerParam && (
        <AssetSelectorModal
          assetType={assetPickerParam.assetType}
          showEdits
          onSelect={handleAssetSelected}
          onClose={() => setAssetPickerParam(null)}
        />
      )}
    </div>,
    document.body
  )
}
