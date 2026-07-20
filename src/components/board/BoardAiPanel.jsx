import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { useSettings } from '../../context/SettingsContext.shared'
import { useNotifications } from '../../context/NotificationContext'
import { useWorkflowJobs } from '../../context/WorkflowJobsContext'
import {
  IMAGE_API_LIST,
  normalizeCustomApiType,
  filterImageGenerationWorkflows,
  filterImageEditWorkflows,
  getWorkflowParameterValueType,
  isFileWorkflowValueType,
  getWorkflowFileInputAccept,
  createComfyExecutionId
} from '../../utils/graphHelpers'
import { getComfyDraftFromWorkflow } from '../../utils/kanbanHelpers'
import AssetSelectorModal from '../AssetSelectorModal'

// An image/file input value chosen from the Assets library (vs an uploaded File).
function isAssetReferenceValue(value) {
  return value && typeof value === 'object' && !(value instanceof File) && typeof value.source === 'string'
}

function describeFileValue(value, valueType) {
  if (value instanceof File) return value.name
  if (isAssetReferenceValue(value)) return value.name || 'Selected asset'
  return `Choose ${valueType} file`
}

// Merge image-generation + image-edit workflows, de-duplicated by id and
// sorted alphabetically by name.
function collectImageWorkflows(workflows = []) {
  const seen = new Set()
  const result = []
  for (const wf of [...filterImageGenerationWorkflows(workflows), ...filterImageEditWorkflows(workflows)]) {
    if (seen.has(wf.id)) continue
    seen.add(wf.id)
    result.push(wf)
  }
  return result.sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  )
}

export default function BoardAiPanel({ projectId, projectName, boardId, onImageGenerated }) {
  const { getComfyWorkflows, runComfyWorkflow, generateImage, attachExistingAsset } = useProjects()
  const { settings } = useSettings()
  const { addNotification } = useNotifications()
  const { registerJob, completeJob } = useWorkflowJobs()

  const [tab, setTab] = useState('comfy')
  const [workflows, setWorkflows] = useState([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('')
  const [comfyInputs, setComfyInputs] = useState({})
  const [comfyName, setComfyName] = useState('')

  const [selectedApi, setSelectedApi] = useState('')
  const [apiPrompt, setApiPrompt] = useState('')
  const [apiName, setApiName] = useState('')

  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState(null)
  const [assetPickerParam, setAssetPickerParam] = useState(null) // { paramId, valueType }
  const fileInputsRef = useRef({})

  const customApis = useMemo(() => settings?.apis?.custom || [], [settings])
  const imageApis = useMemo(() => ([
    ...IMAGE_API_LIST,
    ...customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'image-generation')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]), [customApis])

  useEffect(() => {
    let cancelled = false
    getComfyWorkflows()
      .then(list => { if (!cancelled) setWorkflows(collectImageWorkflows(list || [])) })
      .catch(err => console.error('Failed to load ComfyUI workflows', err))
    return () => { cancelled = true }
  }, [getComfyWorkflows])

  useEffect(() => {
    if (imageApis.length && !selectedApi) setSelectedApi(imageApis[0].id)
  }, [imageApis, selectedApi])

  // Workflow ids are numeric but <select> values are strings — match loosely
  // (same approach as GraphAssetNode) so the selected workflow resolves.
  const selectedWorkflow = useMemo(
    () => workflows.find(wf => String(wf.id) === String(selectedWorkflowId)) || null,
    [workflows, selectedWorkflowId]
  )

  const handleSelectWorkflow = (id) => {
    setSelectedWorkflowId(id)
    const wf = workflows.find(w => String(w.id) === String(id))
    setComfyInputs(wf ? getComfyDraftFromWorkflow(wf).inputs : {})
  }

  const setInputValue = (paramId, value) => {
    setComfyInputs(prev => ({ ...prev, [paramId]: value }))
  }

  const flash = (message, tone = 'info') => setStatus({ message, tone })

  const runComfy = async () => {
    if (!selectedWorkflow) { flash('Select a workflow first.', 'error'); return }

    // Validate required file/string params (numbers/booleans always have a value).
    for (const parameter of selectedWorkflow.parameters || []) {
      const valueType = getWorkflowParameterValueType(parameter)
      const value = comfyInputs[parameter.id]
      if (isFileWorkflowValueType(valueType) && !(value instanceof File) && !isAssetReferenceValue(value)) {
        flash(`Select a ${valueType} for ${parameter.name}.`, 'error')
        return
      }
      if (valueType === 'string' && parameter.required && !String(value ?? '').trim()) {
        flash(`Enter a value for ${parameter.name}.`, 'error')
        return
      }
    }

    const promptId = createComfyExecutionId('comfy-prompt')
    const clientId = createComfyExecutionId('comfy-client')
    setRunning(true)
    flash('Running ComfyUI workflow…')
    registerJob({
      id: promptId,
      projectId,
      projectName,
      page: 'board',
      targetId: boardId,
      kind: 'image',
      label: selectedWorkflow.name
    })

    try {
      const assets = await runComfyWorkflow(projectId, {
        workflowId: selectedWorkflow.id,
        inputs: comfyInputs,
        name: comfyName.trim() || undefined,
        clientId,
        promptId,
        persistProcessingCard: false,
        // Detached: image-generation outputs (no image input) become root project
        // assets with no Kanban card. autoParentFromInputs: when an image input is
        // an asset, the output is saved as an Edit of that source image instead.
        detachedAsset: true,
        autoParentFromInputs: true
      })
      const imageAssets = (Array.isArray(assets) ? assets : [assets]).filter(
        a => a && (a.type ? a.type === 'image' : true)
      )
      for (const asset of imageAssets) {
        await onImageGenerated(asset)
      }
      completeJob(promptId, { status: 'completed' })
      flash(`Added ${imageAssets.length} image${imageAssets.length === 1 ? '' : 's'} to the board.`, 'success')
    } catch (err) {
      console.error('ComfyUI board generation failed', err)
      completeJob(promptId, { status: 'error', error: err.message })
      flash(err.message || 'ComfyUI workflow failed.', 'error')
      addNotification({ title: 'Board generation failed', message: err.message || 'ComfyUI workflow failed', tone: 'error', source: selectedWorkflow.name, projectId })
    } finally {
      setRunning(false)
    }
  }

  const runApi = async () => {
    if (!selectedApi) { flash('Select an API.', 'error'); return }
    if (!apiPrompt.trim()) { flash('Enter a prompt.', 'error'); return }
    const name = apiName.trim()
    if (!name) { flash('Enter a name for the image.', 'error'); return }

    setRunning(true)
    flash('Generating image…')
    try {
      const asset = await generateImage(projectId, { selectedApi, prompt: apiPrompt.trim(), name, detachedAsset: true })
      await onImageGenerated(asset)
      flash('Image added to the board.', 'success')
    } catch (err) {
      console.error('API board generation failed', err)
      flash(err.message || 'Image generation failed.', 'error')
      addNotification({ title: 'Board generation failed', message: err.message || 'Image generation failed', tone: 'error', source: imageApis.find(a => a.id === selectedApi)?.name || 'Image API', projectId })
    } finally {
      setRunning(false)
    }
  }

  const renderParameterField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const value = comfyInputs[parameter.id]
    const label = parameter.label || parameter.name || parameter.id

    if (isFileWorkflowValueType(valueType)) {
      const hasValue = value instanceof File || isAssetReferenceValue(value)
      return (
        <div className="board-ai-panel__field" key={parameter.id}>
          <span className="board-ai-panel__label">{label}</span>
          <button
            type="button"
            className={`board-ai-panel__file-btn ${hasValue ? 'board-ai-panel__file-btn--set' : ''}`}
            onClick={() => fileInputsRef.current[parameter.id]?.click()}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>upload</span>
            {describeFileValue(value, valueType)}
          </button>
          <div className="board-ai-panel__file-actions">
            <button
              type="button"
              className="board-ai-panel__link-btn"
              onClick={() => fileInputsRef.current[parameter.id]?.click()}
            >
              From computer
            </button>
            <button
              type="button"
              className="board-ai-panel__link-btn"
              onClick={() => setAssetPickerParam({ paramId: parameter.id, valueType })}
            >
              From Assets
            </button>
          </div>
          <input
            ref={(el) => { fileInputsRef.current[parameter.id] = el }}
            type="file"
            accept={getWorkflowFileInputAccept(valueType)}
            style={{ display: 'none' }}
            onChange={(e) => setInputValue(parameter.id, e.target.files?.[0] || null)}
          />
        </div>
      )
    }

    if (valueType === 'boolean') {
      return (
        <label className="board-ai-panel__field" key={parameter.id} style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setInputValue(parameter.id, e.target.checked)}
          />
          <span className="board-ai-panel__label" style={{ margin: 0 }}>{label}</span>
        </label>
      )
    }

    if (valueType === 'number') {
      return (
        <div className="board-ai-panel__field" key={parameter.id}>
          <span className="board-ai-panel__label">{label}</span>
          <input
            className="board-ai-panel__input"
            type="number"
            value={value ?? ''}
            onChange={(e) => setInputValue(parameter.id, e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
      )
    }

    // string / json / anything else — multiline like the Graph Image node.
    return (
      <div className="board-ai-panel__field" key={parameter.id}>
        <span className="board-ai-panel__label">{label}</span>
        <textarea
          className="board-ai-panel__textarea"
          value={typeof value === 'string' ? value : (value == null ? '' : JSON.stringify(value, null, 2))}
          onChange={(e) => setInputValue(parameter.id, e.target.value)}
        />
      </div>
    )
  }

  return (
    <aside className="board-ai-panel">
      <div className="board-ai-panel__head">
        <div className="board-ai-panel__title">Generate images</div>
        <div className="board-ai-panel__subtitle">Saved to Assets and placed on the board</div>
      </div>

      <div className="board-ai-panel__body">
        <div className="board-ai-panel__tabs">
          <button
            type="button"
            className={`board-ai-panel__tab ${tab === 'comfy' ? 'board-ai-panel__tab--active' : ''}`}
            onClick={() => setTab('comfy')}
          >
            ComfyUI
          </button>
          <button
            type="button"
            className={`board-ai-panel__tab ${tab === 'api' ? 'board-ai-panel__tab--active' : ''}`}
            onClick={() => setTab('api')}
          >
            External API
          </button>
        </div>

        {tab === 'comfy' ? (
          <>
            <div className="board-ai-panel__field">
              <span className="board-ai-panel__label">Workflow</span>
              <select
                className="board-ai-panel__select"
                value={selectedWorkflowId}
                onChange={(e) => handleSelectWorkflow(e.target.value)}
              >
                <option value="">Select a workflow…</option>
                {workflows.map(wf => (
                  <option key={wf.id} value={wf.id}>{wf.name}</option>
                ))}
              </select>
              {workflows.length === 0 && (
                <span className="board-ai-panel__hint" style={{ marginTop: '0.3rem' }}>
                  No image workflows found. Import one from the Assets library.
                </span>
              )}
            </div>

            {selectedWorkflow && (
              <>
                <div className="board-ai-panel__field">
                  <span className="board-ai-panel__label">Image name (optional)</span>
                  <input
                    className="board-ai-panel__input"
                    value={comfyName}
                    onChange={(e) => setComfyName(e.target.value)}
                    placeholder={selectedWorkflow.name}
                  />
                </div>
                {(selectedWorkflow.parameters || []).map(renderParameterField)}
              </>
            )}

            <button className="board-ai-panel__run" onClick={runComfy} disabled={running || !selectedWorkflow}>
              {running ? 'Working…' : 'Run workflow'}
            </button>
          </>
        ) : (
          <>
            <div className="board-ai-panel__field">
              <span className="board-ai-panel__label">API</span>
              <select
                className="board-ai-panel__select"
                value={selectedApi}
                onChange={(e) => setSelectedApi(e.target.value)}
              >
                {imageApis.map(api => (
                  <option key={api.id} value={api.id}>{api.name}</option>
                ))}
              </select>
            </div>
            <div className="board-ai-panel__field">
              <span className="board-ai-panel__label">Image name</span>
              <input
                className="board-ai-panel__input"
                value={apiName}
                onChange={(e) => setApiName(e.target.value)}
                placeholder="Concept sketch"
              />
            </div>
            <div className="board-ai-panel__field">
              <span className="board-ai-panel__label">Prompt</span>
              <textarea
                className="board-ai-panel__textarea"
                value={apiPrompt}
                onChange={(e) => setApiPrompt(e.target.value)}
                placeholder="Describe the image to generate…"
              />
            </div>
            <button className="board-ai-panel__run" onClick={runApi} disabled={running}>
              {running ? 'Working…' : 'Generate image'}
            </button>
          </>
        )}

        {status && (
          <div className={`board-ai-panel__status ${status.tone === 'error' ? 'board-ai-panel__status--error' : ''}`}>
            {status.message}
          </div>
        )}
      </div>

      {assetPickerParam && (
        <AssetSelectorModal
          assetType={assetPickerParam.valueType === 'mesh' ? 'mesh' : 'image'}
          showEdits
          onSelect={async (asset) => {
            const picker = assetPickerParam
            setAssetPickerParam(null)
            if (!asset) return
            try {
              // The selector lists library assets whose ids aren't project-scoped.
              // Attach the file to this project (mirrors GraphPage) so the server
              // can resolve it as a project image/mesh source for the workflow.
              const attached = await attachExistingAsset(projectId, {
                filename: asset.filename || asset.filePath,
                type: picker.valueType === 'mesh' ? 'mesh' : 'image',
                name: asset.name,
                metadata: { source: 'ASSET LIB' },
                // Link the source to the project without a Kanban card; the edit
                // output is parented to it (see autoParentFromInputs below).
                detached: true
              })
              setInputValue(picker.paramId, {
                source: `asset:${attached.id}`,
                name: attached.name || asset.name || 'Selected asset'
              })
            } catch (err) {
              console.error('Failed to use selected asset for board input', err)
              flash(err.message || 'Failed to use the selected asset.', 'error')
            }
          }}
          onClose={() => setAssetPickerParam(null)}
        />
      )}
    </aside>
  )
}
