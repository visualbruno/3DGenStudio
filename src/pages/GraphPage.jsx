import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext.shared'
import '@xyflow/react/dist/style.css'
import './KanbanPage.css'
import './GraphPage.css'

const DEFAULT_OUTPUT_ID = 'image-output'
const DEFAULT_INPUT_ID = 'image-input'
const DEFAULT_CUSTOM_API_TYPE = 'image-generation'
const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai_gpt_image_1', name: 'OpenAI · gpt-image-1' },
  { id: 'openai_gpt_image_1_5', name: 'OpenAI · gpt-image-1.5' }
]

function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit', 'mesh-texturing'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE
}

function getNodeKind(nodeTypeName = '') {
  return String(nodeTypeName).trim().toLowerCase() === 'image edit' ? 'imageEdit' : 'image'
}

function formatAssetDimensions(width, height) {
  if (!width || !height) {
    return null
  }

  return `${width} × ${height}`
}

function getAssetPreviewUrl(filename) {
  if (!filename) {
    return null
  }

  return `http://localhost:3001/assets/${encodeURI(filename)}`
}

function buildEdgeId(connection) {
  return `edge:${connection.sourceNodeId}:${connection.outputId}:${connection.targetNodeId}:${connection.inputId}`
}

function toFlowEdge(connection) {
  return {
    id: buildEdgeId(connection),
    source: String(connection.sourceNodeId),
    target: String(connection.targetNodeId),
    sourceHandle: connection.outputId || DEFAULT_OUTPUT_ID,
    targetHandle: connection.inputId || DEFAULT_INPUT_ID,
    type: 'smoothstep',
    animated: true
  }
}

function toBaseFlowNode(node, onDelete) {
  const nodeKind = getNodeKind(node.nodeTypeName)

  return {
    id: String(node.id),
    type: nodeKind,
    position: {
      x: Number(node.xPos) || 0,
      y: Number(node.yPos) || 0
    },
    data: {
      ...node,
      nodeKind,
      onDelete,
      actionDraft: null,
      connectedInputAsset: null,
      imageGenerationApis: [],
      imageEditApis: [],
      imageGenerationWorkflows: [],
      imageEditWorkflows: [],
      libraryImageOptions: [],
      libraryLoading: false,
      comfyLoading: false,
      onToggleAction: null,
      onImageModeSelect: null,
      onImageEditModeSelect: null,
      onDraftFieldChange: null,
      onDraftInputChange: null,
      onRequestLocalFile: null,
      onAttachLibraryAsset: null,
      onRunNodeAction: null,
      onCloseAction: null
    }
  }
}

function getWorkflowParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

function isFileWorkflowValueType(valueType) {
  return ['image', 'video', 'mesh'].includes(valueType)
}

function getWorkflowFileInputAccept(valueType) {
  if (valueType === 'video') return 'video/*'
  if (valueType === 'mesh') return '.glb,.gltf,.obj,.fbx,.stl,.ply,.usdz,.usd,.usda,.usdc'
  return 'image/*'
}

function getWorkflowFileInputIcon(valueType) {
  if (valueType === 'video') return 'video_file'
  if (valueType === 'mesh') return 'deployed_code'
  return 'image'
}

function formatWorkflowDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function createComfyExecutionId(prefix = 'comfy') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

function getAssetSourceReference(asset) {
  if (!asset?.id) {
    return ''
  }

  if (asset.parentId || asset.metadata?.editId) {
    return `edit:${asset.filePath}`
  }

  return `asset:${asset.id}`
}

function createWorkflowDraftInputs(workflow, resolver = () => null) {
  return Object.fromEntries((workflow?.parameters || []).map(parameter => {
    const valueType = getWorkflowParameterValueType(parameter)

    if (isFileWorkflowValueType(valueType)) {
      return [parameter.id, resolver(parameter, valueType)]
    }

    if (valueType === 'boolean') {
      return [parameter.id, Boolean(parameter.defaultValue ?? false)]
    }

    return [parameter.id, parameter.defaultValue ?? '']
  }))
}

function GraphAssetNode({ data }) {
  const isImageEdit = data.nodeKind === 'imageEdit'
  const previewFilename = data.asset?.thumbnail || data.asset?.filename || null
  const previewUrl = getAssetPreviewUrl(previewFilename)
  const dimensions = formatAssetDimensions(data.asset?.width, data.asset?.height)
  const isProcessing = data.status === 'processing'
  const sourceLabel = isImageEdit ? 'IMAGE EDIT' : 'IMAGE'
  const metaLabel = isProcessing
    ? (Number.isFinite(data.progress) ? `${data.progress}%` : 'Processing…')
    : (dimensions || (isImageEdit ? 'Connect an input image and generate a result.' : 'Attach or generate a single image.'))
  const draft = data.actionDraft
  const selectedWorkflow = (isImageEdit ? data.imageEditWorkflows : data.imageGenerationWorkflows)
    .find(workflow => workflow.id == draft?.workflowId) || null

  const renderWorkflowField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const currentValue = draft?.inputs?.[parameter.id]

    if (isImageEdit && valueType === 'image') {
      return (
        <div className="graph-node__linked-input font-label">
          {data.connectedInputAsset?.name || 'Connect an input image to use this parameter'}
        </div>
      )
    }

    if (isFileWorkflowValueType(valueType)) {
      return (
        <label className="image-card__file-input nodrag">
          <input
            type="file"
            accept={getWorkflowFileInputAccept(valueType)}
            onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.files?.[0] || null)}
          />
          <span className="material-symbols-outlined">{getWorkflowFileInputIcon(valueType)}</span>
          <span>{currentValue?.name || `Select ${valueType} file`}</span>
        </label>
      )
    }

    if (valueType === 'boolean') {
      return (
        <label className="params-card__checkbox-label nodrag">
          <div
            className={`params-card__checkbox ${currentValue ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
            onClick={() => data.onDraftInputChange?.(data.id, parameter, !currentValue)}
          >
            {currentValue && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
          </div>
          <span>{parameter.label || 'Toggle value'}</span>
        </label>
      )
    }

    if (valueType === 'string' || parameter.type === 'json') {
      return (
        <textarea
          className="gen-prompt-input image-card__param-textarea nodrag"
          value={typeof currentValue === 'string' ? currentValue : JSON.stringify(currentValue ?? '', null, 2)}
          onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.value)}
        />
      )
    }

    return (
      <input
        type={valueType === 'number' ? 'number' : 'text'}
        className="params-card__input nodrag"
        value={currentValue ?? ''}
        onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.value)}
      />
    )
  }

  return (
    <div className={`graph-node graph-node--${data.nodeKind}`}>
      {isImageEdit && (
        <Handle
          type="target"
          id={DEFAULT_INPUT_ID}
          position={Position.Left}
          className="graph-node__handle graph-node__handle--input"
        />
      )}

      <div className={`graph-node__card image-card ${isProcessing ? 'image-card--loading image-card--locked' : ''}`}>
        <div className="image-card__actions">
          <button
            type="button"
            className="image-card__action-btn image-card__delete nodrag"
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="image-card__thumb graph-node__thumb">
          {previewUrl ? (
            <div className="image-card__thumb-item">
              <img src={previewUrl} alt={data.asset?.name || data.name || sourceLabel} className="image-card__thumb-image" />
            </div>
          ) : (
            <div className="image-card__thumb-placeholder">
              <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.12)' }}>
                {isImageEdit ? 'photo_filter' : 'image'}
              </span>
            </div>
          )}

          {isImageEdit && (
            <div className="image-card__edit-preview-indicator font-label">
              {data.connectedInputAsset ? `INPUT • ${data.connectedInputAsset.name}` : 'INPUT • IMAGE'}
            </div>
          )}

          {dimensions && (
            <div className="image-card__thumb-dimensions font-label">
              {dimensions}
            </div>
          )}
        </div>

        <div className="image-card__info">
          <div className="image-card__row">
            <h3 className="image-card__name">{data.asset?.name || data.name || sourceLabel}</h3>
            <div className="image-card__badges">
              <span
                className="image-card__source"
                style={{
                  color: 'var(--primary)',
                  background: 'rgba(143,245,255,0.1)'
                }}
              >
                {sourceLabel}
              </span>
            </div>
          </div>

          <p className="image-card__meta font-label">{metaLabel}</p>

          {isProcessing && Number.isFinite(data.progress) && (
            <div className="image-card__progress graph-node__progress" aria-hidden="true">
              <div
                className="image-card__progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, data.progress || 0))}%` }}
              />
            </div>
          )}

          <div className="graph-node__ports-summary font-label">
            {isImageEdit && <span className="graph-node__port-label">Input · Image</span>}
            <span className="graph-node__port-label graph-node__port-label--output">Output · Image</span>
          </div>

          <div className="image-card__attributes graph-node__actions-panel">
            <div className="image-card__edit-actions">
              <button className="image-card__edit-action-btn nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} disabled={isProcessing}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                Action
              </button>

              {draft?.mode === 'select' && (
                <div className="image-card__edit-action-menu">
                  {!isImageEdit && (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'local')}>
                        Local Computer
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'assets')}>
                        From Assets
                      </button>
                    </>
                  )}
                  {isImageEdit ? (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageEditModeSelect?.(data.id, 'api')}>
                        API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageEditModeSelect?.(data.id, 'comfy')}>
                        ComfyUI Workflow
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'comfy')}>
                        ComfyUI Workflow
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'api')}>
                        Remote API
                      </button>
                    </>
                  )}
                </div>
              )}

              {draft?.mode === 'assets' && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">FROM ASSETS</span>
                  {data.libraryLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading images...</span>
                    </div>
                  ) : data.libraryImageOptions.length > 0 ? (
                    <div className="image-card__asset-picker graph-node__asset-picker">
                      {data.libraryImageOptions.map(asset => (
                        <button
                          key={asset.id}
                          className="image-card__asset-option nodrag"
                          onClick={() => data.onAttachLibraryAsset?.(data.id, asset)}
                        >
                          {asset.url ? (
                            <img src={asset.url} alt={asset.name} className="image-card__asset-thumb" />
                          ) : (
                            <div className="image-card__asset-thumb graph-node__asset-thumb-placeholder">
                              <span className="material-symbols-outlined">image</span>
                            </div>
                          )}
                          <span className="image-card__asset-name">{asset.name}</span>
                          {asset.isEdit && <span className="graph-node__asset-kind font-label">IMAGE EDIT</span>}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">perm_media</span>
                      <span>No images available in Assets.</span>
                    </div>
                  )}
                  <button className="kanban-sidebar__nav-item nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} style={{ justifyContent: 'center' }}>BACK</button>
                </div>
              )}

              {draft?.mode === 'api' && !isImageEdit && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">REMOTE API</span>
                  <select
                    className="api-select nodrag"
                    value={draft.selectedApi || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedApi', event.target.value)}
                  >
                    {data.imageGenerationApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  <textarea
                    className="gen-prompt-input nodrag"
                    placeholder="What should we generate?"
                    value={draft.prompt || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                  />
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)}>
                    <span className="material-symbols-outlined">auto_awesome</span>
                    GENERATE
                  </button>
                </div>
              )}

              {draft?.mode === 'comfy' && !isImageEdit && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI WORKFLOW</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.imageGenerationWorkflows.length > 0 ? (
                    <>
                      <select
                        className="params-card__select nodrag"
                        value={draft.workflowId || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'workflowId', event.target.value)}
                      >
                        {data.imageGenerationWorkflows.map(workflow => (
                          <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                        ))}
                      </select>
                      <div className="image-card__workflow-meta">
                        <span>{selectedWorkflow?.parameters?.length || 0} input parameters configured</span>
                        <span>{selectedWorkflow?.outputs?.length || 0} outputs selected</span>
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 ? (
                        <div className="image-card__workflow-params">
                          {selectedWorkflow.parameters.map(parameter => (
                            <div key={parameter.id} className="params-card__field">
                              <label className="params-card__label font-label">
                                {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                              </label>
                              {renderWorkflowField(parameter)}
                              <span className="image-card__param-hint">
                                {parameter.label} • default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                          <span className="material-symbols-outlined">tune</span>
                          <span>This workflow has no exposed parameters. Start it directly.</span>
                        </div>
                      )}
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)}>
                        <span className="material-symbols-outlined">bolt</span>
                        START WORKFLOW
                      </button>
                    </>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">account_tree</span>
                      <span>No imported workflows available.</span>
                    </div>
                  )}
                </div>
              )}

              {draft?.mode === 'api' && isImageEdit && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">IMAGE EDIT API</span>
                  <input
                    type="text"
                    className="params-card__input nodrag"
                    placeholder="Result name"
                    value={draft.name || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                  />
                  <select
                    className="api-select nodrag"
                    value={draft.selectedApi || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedApi', event.target.value)}
                  >
                    {data.imageEditApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  <textarea
                    className="gen-prompt-input nodrag"
                    placeholder="Describe the edit"
                    value={draft.prompt || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                  />
                  <div className="graph-node__linked-input font-label">
                    {data.connectedInputAsset ? `Input: ${data.connectedInputAsset.name}` : 'Connect an input image first'}
                  </div>
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!data.connectedInputAsset}>
                    <span className="material-symbols-outlined">auto_fix_high</span>
                    RUN EDIT
                  </button>
                </div>
              )}

              {draft?.mode === 'comfy' && isImageEdit && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI IMAGE EDIT</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.imageEditWorkflows.length > 0 ? (
                    <>
                      <input
                        type="text"
                        className="params-card__input nodrag"
                        placeholder="Result name"
                        value={draft.name || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                      />
                      <select
                        className="params-card__select nodrag"
                        value={draft.workflowId || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'workflowId', event.target.value)}
                      >
                        {data.imageEditWorkflows.map(workflow => (
                          <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                        ))}
                      </select>
                      <div className="image-card__workflow-meta">
                        <span>{selectedWorkflow?.parameters?.length || 0} input parameters configured</span>
                        <span>{selectedWorkflow?.outputs?.length || 0} outputs selected</span>
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 ? (
                        <div className="image-card__workflow-params">
                          {selectedWorkflow.parameters.map(parameter => (
                            <div key={parameter.id} className="params-card__field">
                              <label className="params-card__label font-label">
                                {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                              </label>
                              {renderWorkflowField(parameter)}
                              <span className="image-card__param-hint">
                                {parameter.label} • default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                          <span className="material-symbols-outlined">tune</span>
                          <span>This workflow has no exposed parameters. Start it directly.</span>
                        </div>
                      )}
                      <div className="graph-node__linked-input font-label">
                        {data.connectedInputAsset ? `Input: ${data.connectedInputAsset.name}` : 'Connect an input image first'}
                      </div>
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!data.connectedInputAsset}>
                        <span className="material-symbols-outlined">bolt</span>
                        START WORKFLOW
                      </button>
                    </>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">account_tree</span>
                      <span>No imported workflows available.</span>
                    </div>
                  )}
                </div>
              )}

              {draft && draft.mode !== 'select' && (
                <button className="kanban-sidebar__nav-item nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} style={{ justifyContent: 'center' }}>
                  BACK
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        id={DEFAULT_OUTPUT_ID}
        position={Position.Right}
        className="graph-node__handle graph-node__handle--output"
      />
    </div>
  )
}

const flowNodeTypes = {
  image: GraphAssetNode,
  imageEdit: GraphAssetNode
}

export default function GraphPage({ project }) {
  const {
    getProjectNodes,
    createProjectNode,
    updateProjectNode,
    updateProjectNodePosition,
    deleteProjectNode,
    getProjectConnections,
    createProjectConnection,
    deleteProjectConnection,
    uploadAsset,
    attachExistingAsset,
    getLibraryAssets,
    generateImage,
    getComfyWorkflows,
    runComfyWorkflow,
    subscribeToComfyWorkflowProgress,
    runImageEditApi,
    runImageEditComfy
  } = useProjects()
  const { settings } = useSettings()

  const [showSettings, setShowSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [actionDraftsByNodeId, setActionDraftsByNodeId] = useState({})
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [comfyLoading, setComfyLoading] = useState(false)

  const fileInputRef = useRef(null)
  const pendingUploadNodeIdRef = useRef(null)
  const progressSubscriptionsRef = useRef(new Map())
  const libraryLoadedRef = useRef(false)
  const workflowsLoadedRef = useRef(false)

  const customApis = useMemo(() => settings?.apis?.custom || [], [settings])
  const imageGenerationApis = useMemo(() => ([
    ...IMAGE_API_LIST,
    ...customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'image-generation')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]), [customApis])
  const imageEditApis = useMemo(() => ([
    ...IMAGE_API_LIST,
    ...customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'image-edit')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]), [customApis])

  const imageGenerationWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')
      return outputValueTypes.includes('image')
    })
  }, [comfyWorkflows])

  const imageEditWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const parameterValueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return outputValueTypes.includes('image')
        && parameterValueTypes.every(valueType => ['image', 'string', 'number', 'boolean'].includes(valueType))
    })
  }, [comfyWorkflows])

  const libraryImageOptions = useMemo(() => {
    return (libraryAssets.images || []).flatMap(asset => {
      const children = asset.children || asset.edits || []
      const originalOption = {
        id: `asset:${asset.id}`,
        name: asset.name,
        filename: asset.filename,
        url: asset.url,
        extension: asset.extension || (asset.filename?.split('.').pop() || '').toUpperCase(),
        isEdit: false
      }

      const childOptions = children.map(child => ({
        id: `edit:${child.id}`,
        name: child.name || `${asset.name} Edit`,
        filename: child.filename,
        url: child.url || getAssetPreviewUrl(child.filename),
        extension: (child.filename?.split('.').pop() || '').toUpperCase(),
        isEdit: true
      }))

      return [originalOption, ...childOptions]
    })
  }, [libraryAssets])

  const getConnectedInputAssetFrom = useCallback((currentNodes, currentEdges, nodeId) => {
    const inputEdge = currentEdges.find(edge => edge.target === String(nodeId) && (edge.targetHandle || DEFAULT_INPUT_ID) === DEFAULT_INPUT_ID)
    const sourceNode = currentNodes.find(node => node.id === inputEdge?.source)
    return sourceNode?.data?.asset || null
  }, [])

  const createImageNodeDraft = useCallback((mode = 'select') => {
    const defaultWorkflow = imageGenerationWorkflows[0] || null
    return {
      mode,
      selectedApi: imageGenerationApis[0]?.id || '',
      prompt: '',
      workflowId: defaultWorkflow?.id || '',
      inputs: mode === 'comfy' ? createWorkflowDraftInputs(defaultWorkflow, () => null) : {}
    }
  }, [imageGenerationApis, imageGenerationWorkflows])

  const createImageEditNodeDraft = useCallback((mode = 'select', sourceAsset = null) => {
    const defaultWorkflow = imageEditWorkflows[0] || null
    const sourceReference = getAssetSourceReference(sourceAsset)
    return {
      mode,
      name: '',
      selectedApi: imageEditApis[0]?.id || '',
      prompt: '',
      workflowId: defaultWorkflow?.id || '',
      inputs: mode === 'comfy'
        ? createWorkflowDraftInputs(defaultWorkflow, (_parameter, valueType) => valueType === 'image' ? { source: sourceReference } : null)
        : {}
    }
  }, [imageEditApis, imageEditWorkflows])

  const closeNodeProgressSubscription = useCallback((nodeId) => {
    progressSubscriptionsRef.current.get(String(nodeId))?.()
    progressSubscriptionsRef.current.delete(String(nodeId))
  }, [])

  useEffect(() => {
    return () => {
      progressSubscriptionsRef.current.forEach(unsubscribe => unsubscribe?.())
      progressSubscriptionsRef.current.clear()
    }
  }, [])

  const handleDeleteNode = useCallback(async (nodeId) => {
    closeNodeProgressSubscription(nodeId)
    await deleteProjectNode(project.id, Number(nodeId))
    setNodes(currentNodes => currentNodes.filter(node => node.id !== String(nodeId)))
    setEdges(currentEdges => currentEdges.filter(edge => edge.source !== String(nodeId) && edge.target !== String(nodeId)))
    setActionDraftsByNodeId(currentDrafts => {
      const nextDrafts = { ...currentDrafts }
      delete nextDrafts[String(nodeId)]
      return nextDrafts
    })
  }, [closeNodeProgressSubscription, deleteProjectNode, project.id, setEdges, setNodes])

  const replaceFlowNodeData = useCallback((updatedNode) => {
    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(updatedNode.id)
        ? {
            ...node,
            position: {
              x: Number(updatedNode.xPos) || 0,
              y: Number(updatedNode.yPos) || 0
            },
            data: {
              ...node.data,
              ...updatedNode,
              nodeKind: getNodeKind(updatedNode.nodeTypeName)
            }
          }
        : node
    )))
  }, [setNodes])

  const ensureLibraryLoaded = useCallback(async () => {
    if (libraryLoadedRef.current) {
      return
    }

    setLibraryLoading(true)
    try {
      const library = await getLibraryAssets()
      setLibraryAssets(library)
      libraryLoadedRef.current = true
    } finally {
      setLibraryLoading(false)
    }
  }, [getLibraryAssets])

  const ensureComfyWorkflowsLoaded = useCallback(async () => {
    if (workflowsLoadedRef.current) {
      return
    }

    setComfyLoading(true)
    try {
      const workflows = await getComfyWorkflows()
      setComfyWorkflows(workflows)
      workflowsLoadedRef.current = true
    } finally {
      setComfyLoading(false)
    }
  }, [getComfyWorkflows])

  useEffect(() => {
    let cancelled = false

    async function loadGraph() {
      setLoading(true)

      try {
        const [projectNodes, projectConnections] = await Promise.all([
          getProjectNodes(project.id),
          getProjectConnections(project.id)
        ])

        if (cancelled) {
          return
        }

        setNodes(projectNodes.map(node => toBaseFlowNode(node, handleDeleteNode)))
        setEdges(projectConnections.map(toFlowEdge))
      } catch (err) {
        console.error('Failed to load workflow graph:', err)
        if (!cancelled) {
          setNodes([])
          setEdges([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadGraph()

    return () => {
      cancelled = true
    }
  }, [getProjectConnections, getProjectNodes, handleDeleteNode, project.id, setEdges, setNodes])

  const handleCreateNode = useCallback(async (nodeTypeName, initialData = {}) => {
    const nextIndex = nodes.length
    const createdNode = await createProjectNode(project.id, {
      nodeTypeName,
      name: initialData.name || nodeTypeName,
      xPos: initialData.xPos ?? (96 + ((nextIndex % 4) * 48)),
      yPos: initialData.yPos ?? (96 + (nextIndex * 32)),
      assetId: initialData.assetId ?? null,
      status: initialData.status ?? null,
      progress: initialData.progress ?? null,
      metadata: {
        inputType: nodeTypeName === 'Image Edit' ? 'image' : null,
        outputType: 'image',
        ...(initialData.metadata || {})
      }
    })

    setNodes(currentNodes => [...currentNodes, toBaseFlowNode(createdNode, handleDeleteNode)])
    return createdNode
  }, [createProjectNode, handleDeleteNode, nodes.length, project.id, setNodes])

  const openActionDraft = useCallback((nodeId, nodeKind) => {
    setActionDraftsByNodeId({
      [String(nodeId)]: nodeKind === 'imageEdit'
        ? createImageEditNodeDraft('select', getConnectedInputAssetFrom(nodes, edges, nodeId))
        : createImageNodeDraft('select')
    })
  }, [createImageEditNodeDraft, createImageNodeDraft, edges, getConnectedInputAssetFrom, nodes])

  const renderedNodes = useMemo(() => nodes.map(node => ({
    ...node,
    data: {
      ...node.data,
      actionDraft: actionDraftsByNodeId[node.id] || null,
      connectedInputAsset: getConnectedInputAssetFrom(nodes, edges, node.id),
      imageGenerationApis,
      imageEditApis,
      imageGenerationWorkflows,
      imageEditWorkflows,
      libraryImageOptions,
      libraryLoading,
      comfyLoading,
      onToggleAction: openActionDraft,
      onImageModeSelect: async (targetNodeId, mode) => {
        if (mode === 'local') {
          pendingUploadNodeIdRef.current = String(targetNodeId)
          fileInputRef.current?.click()
          return
        }

        if (mode === 'assets') {
          await ensureLibraryLoaded()
        }

        if (mode === 'comfy') {
          await ensureComfyWorkflowsLoaded()
        }

        setActionDraftsByNodeId({
          [String(targetNodeId)]: mode === 'comfy'
            ? createImageNodeDraft('comfy')
            : createImageNodeDraft(mode)
        })
      },
      onImageEditModeSelect: async (targetNodeId, mode) => {
        if (mode === 'comfy') {
          await ensureComfyWorkflowsLoaded()
        }

        setActionDraftsByNodeId({
          [String(targetNodeId)]: createImageEditNodeDraft(mode, getConnectedInputAssetFrom(nodes, edges, targetNodeId))
        })
      },
      onDraftFieldChange: (targetNodeId, field, value) => {
        setActionDraftsByNodeId(currentDrafts => {
          const nodeDraft = currentDrafts[String(targetNodeId)]
          if (!nodeDraft) {
            return currentDrafts
          }

          const sourceAsset = getConnectedInputAssetFrom(nodes, edges, targetNodeId)
          let nextDraft = {
            ...nodeDraft,
            [field]: value
          }

          if (field === 'workflowId') {
            const isEditNode = node.data.nodeKind === 'imageEdit'
            const workflowList = isEditNode ? imageEditWorkflows : imageGenerationWorkflows
            const selectedWorkflow = workflowList.find(workflow => workflow.id == value) || null
            nextDraft = {
              ...nextDraft,
              inputs: isEditNode
                ? createWorkflowDraftInputs(selectedWorkflow, (_parameter, valueType) => valueType === 'image' ? { source: getAssetSourceReference(sourceAsset) } : null)
                : createWorkflowDraftInputs(selectedWorkflow, () => null)
            }
          }

          return {
            [String(targetNodeId)]: nextDraft
          }
        })
      },
      onDraftInputChange: (targetNodeId, parameter, nextValue) => {
        setActionDraftsByNodeId(currentDrafts => {
          const nodeDraft = currentDrafts[String(targetNodeId)]
          if (!nodeDraft) {
            return currentDrafts
          }

          return {
            [String(targetNodeId)]: {
              ...nodeDraft,
              inputs: {
                ...(nodeDraft.inputs || {}),
                [parameter.id]: nextValue
              }
            }
          }
        })
      },
      onRequestLocalFile: (targetNodeId) => {
        pendingUploadNodeIdRef.current = String(targetNodeId)
        fileInputRef.current?.click()
      },
      onAttachLibraryAsset: async (targetNodeId, libraryAsset) => {
        const attachedAsset = await attachExistingAsset(project.id, {
          filename: libraryAsset.filename,
          type: 'image',
          name: libraryAsset.name,
          metadata: {
            resolution: 'Unknown',
            format: libraryAsset.extension,
            source: 'ASSET LIB'
          }
        })
        const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
          assetId: attachedAsset.id,
          name: attachedAsset.name,
          status: null,
          progress: null,
          metadata: {
            lastAction: 'asset-library'
          }
        })
        replaceFlowNodeData(updatedNode)
        setActionDraftsByNodeId({})
      },
      onRunNodeAction: async (targetNodeId) => {
        const targetNode = nodes.find(item => item.id === String(targetNodeId))
        const targetDraft = actionDraftsByNodeId[String(targetNodeId)]
        if (!targetNode || !targetDraft) {
          return
        }

        const setProcessingState = async (status, progress = null, metadata = {}) => {
          const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
            status,
            progress,
            metadata
          })
          replaceFlowNodeData(updatedNode)
        }

        const applyNodeResult = async (asset, metadata = {}) => {
          const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
            assetId: asset.id,
            name: asset.name,
            status: null,
            progress: null,
            metadata
          })
          replaceFlowNodeData(updatedNode)
        }

        const spawnAdditionalResultNodes = async (nodeTypeName, assets) => {
          const sourceEdge = edges.find(edge => edge.target === String(targetNodeId) && (edge.targetHandle || DEFAULT_INPUT_ID) === DEFAULT_INPUT_ID)
          const baseX = targetNode.position.x
          const baseY = targetNode.position.y
          for (let index = 0; index < assets.length; index += 1) {
            const asset = assets[index]
            const createdNode = await handleCreateNode(nodeTypeName, {
              name: asset.name || nodeTypeName,
              assetId: asset.id,
              xPos: baseX + 360,
              yPos: baseY + ((index + 1) * 140),
              metadata: {
                createdFromNodeId: Number(targetNodeId)
              }
            })

            if (nodeTypeName === 'Image Edit' && sourceEdge) {
              const newConnection = await createProjectConnection(project.id, {
                sourceNodeId: Number(sourceEdge.source),
                targetNodeId: createdNode.id,
                inputId: DEFAULT_INPUT_ID,
                outputId: sourceEdge.sourceHandle || DEFAULT_OUTPUT_ID
              })

              setEdges(currentEdges => {
                const nextEdge = toFlowEdge(newConnection)
                if (currentEdges.some(edge => edge.id === nextEdge.id)) {
                  return currentEdges
                }
                return addEdge(nextEdge, currentEdges)
              })
            }
          }
        }

        if (targetNode.data.nodeKind === 'image') {
          if (targetDraft.mode === 'api') {
            if (!targetDraft.selectedApi || !String(targetDraft.prompt || '').trim()) {
              return
            }

            await setProcessingState('processing', null, { processingSource: 'API' })
            try {
              const generatedAsset = await generateImage(project.id, {
                selectedApi: targetDraft.selectedApi,
                prompt: targetDraft.prompt.trim()
              })
              await applyNodeResult(generatedAsset, { lastAction: 'image-api' })
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'Image generation failed' })
            }
            return
          }

          if (targetDraft.mode === 'comfy') {
            const workflow = imageGenerationWorkflows.find(item => item.id == targetDraft.workflowId)
            if (!workflow) {
              return
            }

            const inputValues = {}
            for (const parameter of workflow.parameters || []) {
              const valueType = getWorkflowParameterValueType(parameter)
              const inputValue = targetDraft.inputs?.[parameter.id]

              if (isFileWorkflowValueType(valueType)) {
                if (!inputValue) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'number') {
                if (String(inputValue ?? '').trim() === '' || Number.isNaN(Number(inputValue))) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'boolean') {
                inputValues[parameter.id] = Boolean(inputValue)
                continue
              }

              if (!String(inputValue ?? '').trim()) {
                return
              }

              inputValues[parameter.id] = inputValue
            }

            const promptId = createComfyExecutionId('graph-image-prompt')
            const clientId = createComfyExecutionId('graph-image-client')
            closeNodeProgressSubscription(targetNodeId)
            progressSubscriptionsRef.current.set(String(targetNodeId), subscribeToComfyWorkflowProgress(promptId, {
              onMessage: payload => {
                setNodes(current => current.map(item => (
                  item.id === String(targetNodeId)
                    ? {
                        ...item,
                        data: {
                          ...item.data,
                          status: payload?.status === 'error' ? 'error' : payload?.status === 'completed' ? null : 'processing',
                          progress: Number(payload?.progressPercent) || item.data.progress || 0
                        }
                      }
                    : item
                )))
              },
              onError: () => {}
            }))

            await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId })
            try {
              const generatedAssets = await runComfyWorkflow(project.id, {
                workflowId: Number(targetDraft.workflowId),
                inputs: inputValues,
                promptId,
                clientId
              })
              const imageAssets = (Array.isArray(generatedAssets) ? generatedAssets : [generatedAssets]).filter(asset => asset?.type === 'image')
              if (imageAssets.length === 0) {
                throw new Error('The workflow did not return any image output')
              }
              await applyNodeResult(imageAssets[0], { lastAction: 'comfy-workflow', promptId })
              if (imageAssets.length > 1) {
                await spawnAdditionalResultNodes('Image', imageAssets.slice(1))
              }
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI workflow failed', promptId })
            } finally {
              closeNodeProgressSubscription(targetNodeId)
            }
            return
          }

          return
        }

        const sourceAsset = getConnectedInputAssetFrom(nodes, edges, targetNodeId)
        const sourceReference = getAssetSourceReference(sourceAsset)
        if (!sourceReference) {
          return
        }

        if (targetDraft.mode === 'api') {
          if (!targetDraft.selectedApi || !String(targetDraft.prompt || '').trim() || !String(targetDraft.name || '').trim()) {
            return
          }

          await setProcessingState('processing', null, { processingSource: 'API', inputSource: sourceReference })
          try {
            const response = await runImageEditApi(project.id, {
              imageSource: sourceReference,
              name: targetDraft.name.trim(),
              selectedApi: targetDraft.selectedApi,
              prompt: targetDraft.prompt.trim()
            })
            const savedEdits = response?.savedEdits || []
            if (savedEdits.length === 0) {
              throw new Error('Image edit did not return any saved image')
            }
            await applyNodeResult({ id: savedEdits[0].id, name: savedEdits[0].name || targetDraft.name.trim() }, {
              lastAction: 'image-edit-api',
              inputSource: sourceReference
            })
            if (savedEdits.length > 1) {
              await spawnAdditionalResultNodes('Image Edit', savedEdits.slice(1).map(edit => ({
                id: edit.id,
                name: edit.name || targetDraft.name.trim()
              })))
            }
            setActionDraftsByNodeId({})
          } catch (err) {
            await setProcessingState('error', null, { error: err.message || 'Image edit failed', inputSource: sourceReference })
          }
          return
        }

        if (targetDraft.mode === 'comfy') {
          const workflow = imageEditWorkflows.find(item => item.id == targetDraft.workflowId)
          if (!workflow || !String(targetDraft.name || '').trim()) {
            return
          }

          const inputValues = {}
          for (const parameter of workflow.parameters || []) {
            const valueType = getWorkflowParameterValueType(parameter)
            const inputValue = targetDraft.inputs?.[parameter.id]

            if (valueType === 'image') {
              inputValues[parameter.id] = { source: sourceReference }
              continue
            }

            if (valueType === 'number') {
              if (String(inputValue ?? '').trim() === '' || Number.isNaN(Number(inputValue))) {
                return
              }
              inputValues[parameter.id] = inputValue
              continue
            }

            if (valueType === 'boolean') {
              inputValues[parameter.id] = Boolean(inputValue)
              continue
            }

            if (!String(inputValue ?? '').trim()) {
              return
            }

            inputValues[parameter.id] = inputValue
          }

          const promptId = createComfyExecutionId('graph-image-edit-prompt')
          const clientId = createComfyExecutionId('graph-image-edit-client')
          closeNodeProgressSubscription(targetNodeId)
          progressSubscriptionsRef.current.set(String(targetNodeId), subscribeToComfyWorkflowProgress(promptId, {
            onMessage: payload => {
              setNodes(current => current.map(item => (
                item.id === String(targetNodeId)
                  ? {
                      ...item,
                      data: {
                        ...item.data,
                        status: payload?.status === 'error' ? 'error' : payload?.status === 'completed' ? null : 'processing',
                        progress: Number(payload?.progressPercent) || item.data.progress || 0
                      }
                    }
                  : item
              )))
            },
            onError: () => {}
          }))

          await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId, inputSource: sourceReference })
          try {
            const response = await runImageEditComfy(project.id, {
              assetId: sourceAsset.id,
              workflowId: Number(targetDraft.workflowId),
              name: targetDraft.name.trim(),
              inputValues,
              promptId,
              clientId
            })
            const savedEdits = response?.savedEdits || []
            if (savedEdits.length === 0) {
              throw new Error('ComfyUI image edit did not return any saved image')
            }
            await applyNodeResult({ id: savedEdits[0].id, name: savedEdits[0].name || targetDraft.name.trim() }, {
              lastAction: 'image-edit-comfy',
              promptId,
              inputSource: sourceReference
            })
            if (savedEdits.length > 1) {
              await spawnAdditionalResultNodes('Image Edit', savedEdits.slice(1).map(edit => ({
                id: edit.id,
                name: edit.name || targetDraft.name.trim()
              })))
            }
            setActionDraftsByNodeId({})
          } catch (err) {
            await setProcessingState('error', null, { error: err.message || 'ComfyUI image edit failed', promptId, inputSource: sourceReference })
          } finally {
            closeNodeProgressSubscription(targetNodeId)
          }
        }
      },
      onCloseAction: () => setActionDraftsByNodeId({})
    }
  })), [actionDraftsByNodeId, attachExistingAsset, closeNodeProgressSubscription, comfyLoading, createImageEditNodeDraft, createImageNodeDraft, createProjectConnection, edges, ensureComfyWorkflowsLoaded, ensureLibraryLoaded, generateImage, getConnectedInputAssetFrom, handleCreateNode, imageEditApis, imageEditWorkflows, imageGenerationApis, imageGenerationWorkflows, libraryImageOptions, libraryLoading, nodes, openActionDraft, project.id, replaceFlowNodeData, runComfyWorkflow, runImageEditApi, runImageEditComfy, setEdges, setNodes, subscribeToComfyWorkflowProgress, updateProjectNode])

  const handleFileUpload = useCallback(async (event) => {
    const file = event.target.files?.[0]
    const nodeId = pendingUploadNodeIdRef.current
    event.target.value = ''

    if (!file || !nodeId) {
      pendingUploadNodeIdRef.current = null
      return
    }

    try {
      const uploadedAsset = await uploadAsset(project.id, file, 'image', {
        resolution: 'Unknown',
        format: file.type.split('/')[1]?.toUpperCase() || 'IMG',
        source: 'IMPORT'
      })
      const updatedNode = await updateProjectNode(project.id, Number(nodeId), {
        assetId: uploadedAsset.id,
        name: uploadedAsset.name,
        status: null,
        progress: null,
        metadata: {
          lastAction: 'local-upload'
        }
      })
      replaceFlowNodeData(updatedNode)
      setActionDraftsByNodeId({})
    } catch (err) {
      console.error('Failed to upload image to node:', err)
    } finally {
      pendingUploadNodeIdRef.current = null
    }
  }, [project.id, replaceFlowNodeData, updateProjectNode, uploadAsset])

  const handleConnect = useCallback(async (connection) => {
    if (!connection.source || !connection.target) {
      return
    }

    const createdConnection = await createProjectConnection(project.id, {
      sourceNodeId: Number(connection.source),
      targetNodeId: Number(connection.target),
      inputId: connection.targetHandle || DEFAULT_INPUT_ID,
      outputId: connection.sourceHandle || DEFAULT_OUTPUT_ID
    })

    setEdges(currentEdges => {
      const nextEdge = toFlowEdge(createdConnection)
      if (currentEdges.some(edge => edge.id === nextEdge.id)) {
        return currentEdges
      }

      return addEdge(nextEdge, currentEdges)
    })
  }, [createProjectConnection, project.id, setEdges])

  const handleNodeDragStop = useCallback(async (_event, node) => {
    try {
      await updateProjectNodePosition(project.id, Number(node.id), node.position)
    } catch (err) {
      console.error('Failed to persist node position:', err)
    }
  }, [project.id, updateProjectNodePosition])

  const handleEdgesDelete = useCallback(async (deletedEdges) => {
    await Promise.all(
      deletedEdges.map(edge => deleteProjectConnection(project.id, {
        sourceNodeId: Number(edge.source),
        targetNodeId: Number(edge.target),
        inputId: edge.targetHandle || DEFAULT_INPUT_ID,
        outputId: edge.sourceHandle || DEFAULT_OUTPUT_ID
      }).catch(err => {
        console.error('Failed to delete graph connection:', err)
      }))
    )
  }, [deleteProjectConnection, project.id])

  const showEmptyState = !loading && nodes.length === 0
  const minimapNodeColor = useCallback(node => node.type === 'imageEdit' ? '#ac89ff' : '#8ff5ff', [])

  return (
    <div className="graph-layout">
      <Header
        showSearch
        showCreateNew
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Workspace'}
        centerTitle
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileUpload} />

      <div className="graph-page__body">
        <main className="graph-page__main" id="graph-main">
          <div className="graph-page__toolbar">
            <div className="graph-page__toolbar-chip graph-page__toolbar-chip--primary">
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>hub</span>
              Graph Workspace
            </div>
            <div className="graph-page__toolbar-chip">
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>tune</span>
              Preset: {project?.preset || 'Graph'}
            </div>
            <div className="graph-page__toolbar-actions">
              <button type="button" className="graph-page__toolbar-btn" onClick={() => handleCreateNode('Image')}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>image</span>
                Add Image Node
              </button>
              <button type="button" className="graph-page__toolbar-btn graph-page__toolbar-btn--secondary" onClick={() => handleCreateNode('Image Edit')}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>photo_filter</span>
                Add Image Edit Node
              </button>
            </div>
          </div>

          <div className="graph-page__canvas-shell">
            {showEmptyState && (
              <div className="graph-page__empty-state">
                <div className="graph-page__empty-icon">
                  <span className="material-symbols-outlined">account_tree</span>
                </div>
                <div className="graph-page__empty-copy">
                  <h2 className="graph-page__empty-title font-headline">Empty workflow graph</h2>
                  <p className="graph-page__empty-text">
                    Start by adding an Image node or an Image Edit node.
                  </p>
                </div>
              </div>
            )}

            {loading && (
              <div className="graph-page__loading font-label">Loading graph…</div>
            )}

            <ReactFlow
              className="graph-page__canvas"
              nodes={renderedNodes}
              edges={edges}
              nodeTypes={flowNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              onNodeDragStop={handleNodeDragStop}
              onEdgesDelete={handleEdgesDelete}
              defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
              minZoom={0.2}
              maxZoom={2}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="rgba(143, 245, 255, 0.14)" />
              <MiniMap pannable zoomable className="graph-page__minimap" nodeColor={minimapNodeColor} />
              <Controls className="graph-page__controls" showInteractive={false} />
            </ReactFlow>
          </div>
        </main>
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
