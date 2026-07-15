import { memo, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import Viewer from '../Viewer'
import {
  DEFAULT_INPUT_ID,
  DEFAULT_OUTPUT_ID,
  HITEM_FACE_MAX,
  HITEM_FACE_MIN,
  HITEM_MODEL_VERSION_OPTIONS,
  HITEM_REQUEST_TYPE_OPTIONS,
  TENCENT_GENERATION_TYPE_OPTIONS,
  TENCENT_MODEL_VERSION_OPTIONS,
  TENCENT_POLYGON_TYPE_OPTIONS,
  TENCENT_REGION_OPTIONS,
  TRIPO_GEOMETRY_QUALITY_OPTIONS,
  TRIPO_MODEL_VERSION_OPTIONS,
  TRIPO_ORIENTATION_OPTIONS,
  TRIPO_TEXTURE_ALIGNMENT_OPTIONS,
  TRIPO_TEXTURE_QUALITY_OPTIONS,
  buildImageEditorPath,
  buildMeshEditorPath,
  canFetchHitemMeshResult,
  canFetchTencentMeshResult,
  canFetchTripoMeshResult,
  formatAssetDimensions,
  formatWorkflowDefaultValue,
  getAssetPreviewUrl,
  getCompatibleInputSources,
  getConnectorPosition,
  getConnectorTypeMeta,
  getInputSourceSelectionValue,
  getWorkflowFileInputAccept,
  getWorkflowFileInputIcon,
  getWorkflowParameterBinding,
  getHitemResolutionOptions,
  getWorkflowParameterValueType,
  isFileWorkflowValueType,
  isHitemMeshGenerationApi,
  isTencentMeshGenerationApi,
  isTripoMeshGenerationApi,
  resolveImageSourceOption,
  resolveSelectedInputSource
} from '../../utils/graphHelpers'
import ComfyTextButton from '../comfy/ComfyTextButton'
import LastActionInfo from './LastActionInfo'

// Image / mesh asset node. Handles preview (incl. 3D mesh viewer), generation
// and edit action panels (local / assets / API / ComfyUI), and async mesh polling.
const GraphAssetNode = memo(function GraphAssetNode({ data }) {
  const navigate = useNavigate()
  const updateNodeInternals = useUpdateNodeInternals()
  const isMeshGen = data.nodeKind === 'meshGen'
  const previewFilename = data.asset?.thumbnail || data.asset?.filename || null
  const previewUrl = getAssetPreviewUrl(previewFilename)
  const meshModelUrl = isMeshGen && data.asset?.filename ? getAssetPreviewUrl(data.asset.filename) : null
  const dimensions = formatAssetDimensions(data.asset?.width, data.asset?.height)
  const isProcessing = data.status === 'processing'
  const progressDetail = data.progressDetail || data.metadata?.detail || ''
  const currentNodeLabel = data.currentNodeLabel || data.metadata?.currentNodeLabel || ''
  const [showNormals, setShowNormals] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showLightSlider, setShowLightSlider] = useState(false)
  const [lightIntensity, setLightIntensity] = useState(2.2)
  const [showMeshPreview, setShowMeshPreview] = useState(false)
  const draft = data.actionDraft
  const isImageEditMode = ['edit-api', 'edit-comfy'].includes(draft?.mode)
  const sourceLabel = isMeshGen ? 'MESH' : 'IMAGE'
  const metaLabel = isProcessing
    ? (Number.isFinite(data.progress) ? `${data.progress}%` : 'Processing…')
    : (dimensions || (isMeshGen
        ? 'Connect an input image and generate a 3D mesh.'
        : 'Attach, generate, or edit a single image.'))
  const selectedWorkflow = (isMeshGen
    ? data.meshGenerationWorkflows
    : isImageEditMode
      ? data.imageEditWorkflows
      : data.imageGenerationWorkflows)
    .find(workflow => workflow.id == draft?.workflowId) || null
  const inputConnectors = useMemo(() => {
    return data.inputConnectors || [{ id: DEFAULT_INPUT_ID, type: null, isConnected: false }]
  }, [data.inputConnectors])
  const inputSources = data.inputSources || []
  const outputConnector = data.outputConnector || { id: DEFAULT_OUTPUT_ID, type: isMeshGen ? 'mesh' : 'image' }
  const hasOutputAsset = Boolean(data.asset?.id)
  const connectedInputCount = inputConnectors.filter(connector => connector.isConnected).length
  const outputMeta = getConnectorTypeMeta(outputConnector.type)
  const imageInputSources = getCompatibleInputSources(inputSources, 'image')
  const selectedApiImageSource = resolveImageSourceOption(draft?.selectedInputSource, inputSources, data.libraryImageOptions)
  const isTencentMeshApi = isMeshGen && isTencentMeshGenerationApi(draft?.selectedApi)
  const isTripoMeshApi = isMeshGen && isTripoMeshGenerationApi(draft?.selectedApi)
  const isHitemMeshApi = isMeshGen && isHitemMeshGenerationApi(draft?.selectedApi)
  const isTripoP1Model = isTripoMeshApi && (draft?.modelVersion || 'v2.5-20250123') === 'P1-20260311'
  const hitemResolutionOptions = getHitemResolutionOptions(draft?.hitemModel || 'hitem3dv2.1')
  const hasDraftPrompt = Boolean(String(draft?.prompt || '').trim())
  const hasDraftInputSource = Boolean(String(draft?.selectedInputSource || '').trim())
  const canFetchAsyncResult = isMeshGen
    && (canFetchTencentMeshResult(data.metadata, data.status) || canFetchTripoMeshResult(data.metadata, data.status) || canFetchHitemMeshResult(data.metadata, data.status))
  const nodeDisplayName = data.name || data.asset?.name || sourceLabel
  const meshEditorPath = isMeshGen && data.asset?.id
    ? buildMeshEditorPath({
        asset: data.asset,
        projectId: data.projectId,
        nodeId: data.id,
        returnTo: `/projects/${data.projectId}`
      })
    : ''
  const imageEditorPath = !isMeshGen && data.asset?.id
    ? buildImageEditorPath({
        asset: data.asset,
        projectId: data.projectId,
        nodeId: data.id,
        returnTo: `/projects/${data.projectId}`
      })
    : ''

  useEffect(() => {
    updateNodeInternals(String(data.id))
  }, [data.id, inputConnectors, outputConnector.id, updateNodeInternals])

  const renderWorkflowField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const currentValue = draft?.inputs?.[parameter.id]
    const compatibleSources = getCompatibleInputSources(inputSources, valueType)
    const binding = getWorkflowParameterBinding(draft, parameter)
    const selectedSource = resolveSelectedInputSource(binding.source, compatibleSources)

    const renderCustomValueField = () => {
      if ((isImageEditMode || isMeshGen) && valueType === 'image') {
        const selectedSourceReference = currentValue?.source || currentValue || ''

        if (data.libraryImageOptions.length === 0) {
          return (
            <div className="graph-node__linked-input font-label">
              No custom image sources available in the asset library.
            </div>
          )
        }

        return (
          <select
            className="params-card__select nodrag"
            value={selectedSourceReference}
            onChange={event => data.onDraftInputChange?.(data.id, parameter, { source: event.target.value })}
          >
            {data.libraryImageOptions.map(asset => (
              <option key={asset.id} value={asset.sourceReference || asset.id}>{asset.name}</option>
            ))}
          </select>
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
          <div className="comfy-textfield-wrap nodrag">
            <textarea
              className="gen-prompt-input image-card__param-textarea nodrag"
              value={typeof currentValue === 'string' ? currentValue : JSON.stringify(currentValue ?? '', null, 2)}
              onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.value)}
            />
            <ComfyTextButton
              className="comfy-text-btn--corner"
              onResult={text => data.onDraftInputChange?.(data.id, parameter, text)}
            />
          </div>
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
      <>
        {compatibleSources.length > 0 && (
          <select
            className="params-card__select nodrag"
            value={binding.source || 'custom'}
            onChange={event => data.onDraftInputSourceChange?.(data.id, parameter, event.target.value)}
          >
            {compatibleSources.map(source => (
              <option key={source.connectorId} value={getInputSourceSelectionValue(source)}>
                {`${getConnectorTypeMeta(source.type).letter} · ${source.label}`}
              </option>
            ))}
            <option value="custom">Custom value</option>
          </select>
        )}

        {selectedSource ? (
          <div className="graph-node__linked-input font-label">
            {`Using ${getConnectorTypeMeta(selectedSource.type).label} input · ${selectedSource.label}`}
          </div>
        ) : renderCustomValueField()}
      </>
    )
  }

  return (
    <div className={`graph-node graph-node--${data.nodeKind}`}>
      {inputConnectors.map((connector, index) => {
        const connectorMeta = getConnectorTypeMeta(connector.type)

        return (
          <div
            key={connector.id}
            className="graph-node__connector graph-node__connector--input"
            style={getConnectorPosition(index, inputConnectors.length)}
          >
            <Handle
              type="target"
              id={connector.id}
              position={Position.Left}
              className="graph-node__handle graph-node__handle--input"
              style={{ borderColor: connectorMeta.color }}
            />
            <span
              className="graph-node__connector-badge font-label"
              style={{
                color: connectorMeta.color,
                background: connectorMeta.background,
                borderColor: connectorMeta.color
              }}
              title={connector.type ? connectorMeta.label : 'Available input'}
            >
              {connectorMeta.letter}
            </span>
          </div>
        )
      })}

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
          {meshModelUrl && showMeshPreview ? (
            <div className="graph-node__mesh-preview">
              <div className="graph-node__mesh-toolbar nodrag">
                <button
                  type="button"
                  className={`graph-node__mesh-tool ${showNormals ? 'graph-node__mesh-tool--active' : ''}`}
                  onClick={() => setShowNormals(current => !current)}
                  aria-pressed={showNormals}
                  title="Toggle normal material"
                >
                  N
                </button>
                <button
                  type="button"
                  className={`graph-node__mesh-tool ${showGrid ? 'graph-node__mesh-tool--active' : ''}`}
                  onClick={() => setShowGrid(current => !current)}
                  aria-pressed={showGrid}
                  title="Toggle grid"
                >
                  G
                </button>
                <button
                  type="button"
                  className={`graph-node__mesh-tool ${showLightSlider ? 'graph-node__mesh-tool--active' : ''}`}
                  onClick={() => setShowLightSlider(current => !current)}
                  aria-pressed={showLightSlider}
                  title="Adjust light"
                >
                  L
                </button>
                <button
                  type="button"
                  className="graph-node__mesh-tool"
                  onClick={() => setShowMeshPreview(false)}
                  title="Close 3D preview (use static thumbnail)"
                >
                  ×
                </button>
                {showLightSlider && (
                  <div className="graph-node__mesh-light-panel">
                    <input
                      type="range"
                      min="0.4"
                      max="4"
                      step="0.1"
                      value={lightIntensity}
                      onChange={event => setLightIntensity(Number(event.target.value))}
                    />
                  </div>
                )}
              </div>
              <Viewer
                height="100%"
                modelUrl={meshModelUrl}
                showNormals={showNormals}
                showGrid={showGrid}
                showShadows={false}
                lightIntensity={lightIntensity}
                fitMode="center"
              />
            </div>
          ) : meshModelUrl ? (
            <div className="image-card__thumb-item" style={{ position: 'relative', cursor: 'pointer' }} onClick={() => setShowMeshPreview(true)}>
              {previewUrl ? (
                <img src={previewUrl} alt={data.asset?.name || data.name || sourceLabel} className="image-card__thumb-image" />
              ) : (
                <div className="image-card__thumb-placeholder">
                  <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(172,137,255,0.5)' }}>deployed_code</span>
                </div>
              )}
              <button
                type="button"
                className="image-card__edit-action-btn nodrag"
                style={{ position: 'absolute', bottom: '8px', right: '8px' }}
                onClick={event => { event.stopPropagation(); setShowMeshPreview(true) }}
                title="Load 3D preview"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>play_arrow</span>
                3D
              </button>
            </div>
          ) : previewUrl ? (
            <div className="image-card__thumb-item">
              <img src={previewUrl} alt={data.asset?.name || data.name || sourceLabel} className="image-card__thumb-image" />
            </div>
          ) : (
            <div className="image-card__thumb-placeholder">
              <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.12)' }}>
                {isMeshGen ? 'deployed_code' : isImageEditMode ? 'photo_filter' : 'image'}
              </span>
            </div>
          )}

          {(isImageEditMode || isMeshGen) && (
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
            <input
              type="text"
              className="image-card__name graph-node__name-input nodrag"
              value={nodeDisplayName}
              placeholder={sourceLabel}
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <div className="image-card__badges">
              {data.metadata?.lastActionParams && (
                <LastActionInfo lastActionParams={data.metadata.lastActionParams} />
              )}
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

          {isProcessing && progressDetail && (
            <p className="image-card__meta font-label">{progressDetail}</p>
          )}

          {isProcessing && currentNodeLabel && (
            <p className="image-card__meta font-label image-card__meta--loading-node">{currentNodeLabel}</p>
          )}

          {isProcessing && Number.isFinite(data.progress) && (
            <div className="image-card__progress graph-node__progress" aria-hidden="true">
              <div
                className="image-card__progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, data.progress || 0))}%` }}
              />
            </div>
          )}

          <div className="graph-node__ports-summary font-label">
            <span className="graph-node__port-label">Inputs · {connectedInputCount + 1 > 1 ? `${connectedInputCount} connected` : 'empty'}</span>
            <span className="graph-node__port-label graph-node__port-label--output">Output · {outputMeta.label}</span>
          </div>

          <div className="image-card__attributes graph-node__actions-panel">
            <div className="image-card__edit-actions">
              <div className="graph-node__primary-actions">
                <button className="image-card__edit-action-btn nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} disabled={isProcessing}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                  Action
                </button>
                {canFetchAsyncResult && (
                  <button className="image-card__edit-action-btn nodrag" onClick={() => data.onGetAsyncMeshResult?.(data.id)}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
                    GET RESULT
                  </button>
                )}
                {meshEditorPath && (
                  <button className="image-card__edit-action-btn graph-node__edit-action nodrag" onClick={() => navigate(meshEditorPath)}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit_square</span>
                    Edit
                  </button>
                )}
                {imageEditorPath && (
                  <button className="image-card__edit-action-btn graph-node__edit-action nodrag" onClick={() => navigate(imageEditorPath)}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit_square</span>
                    Edit
                  </button>
                )}
              </div>

              {draft?.mode === 'select' && (
                <div className="image-card__edit-action-menu">
                  {!isMeshGen && (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'local')}>
                        Local Computer
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'assets')}>
                        From Assets
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'comfy')}>
                        Generate · ComfyUI Workflow
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'api')}>
                        Generate · Remote API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageEditModeSelect?.(data.id, 'edit-api')}>
                        Edit · API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageEditModeSelect?.(data.id, 'edit-comfy')}>
                        Edit · ComfyUI Workflow
                      </button>
                    </>
                  )}
                  {isMeshGen ? (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'local')}>
                        Local Computer
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'assets')}>
                        Assets
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'api')}>
                        API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'comfy')}>
                        ComfyUI Workflow
                      </button>
                    </>
                  ) : null}
                </div>
              )}

							{draft?.mode === 'assets' && (
								<div className="image-card__edit-panel nodrag">
									<span className="graph-node__panel-title font-label">SELECT FROM ASSETS</span>
									<div className="image-card__asset-picker-empty">
										<span className="material-symbols-outlined">perm_media</span>
										<span>Opening asset library...</span>
									</div>
									<button
										className="kanban-sidebar__nav-item nodrag"
										onClick={() => data.onOpenAssetSelector?.(data.id, data.nodeKind === 'meshGen' ? 'mesh' : 'image')}
										style={{ justifyContent: 'center' }}
									>
										Open Asset Selector
									</button>
									<button
										className="kanban-sidebar__nav-item nodrag"
										onClick={() => data.onToggleAction?.(data.id, data.nodeKind)}
										style={{ justifyContent: 'center' }}
									>
										BACK
									</button>
								</div>
							)}

              {draft?.mode === 'api' && !isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">REMOTE API</span>
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
                    {data.imageGenerationApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  <div className="comfy-textfield-wrap nodrag">
                    <textarea
                      className="gen-prompt-input nodrag"
                      placeholder="What should we generate?"
                      value={draft.prompt || ''}
                      onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                    />
                    <ComfyTextButton
                      className="comfy-text-btn--corner"
                      onResult={text => data.onDraftFieldChange?.(data.id, 'prompt', text)}
                    />
                  </div>
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.name?.trim() || !draft.prompt?.trim()}>
                    <span className="material-symbols-outlined">auto_awesome</span>
                    GENERATE
                  </button>
                </div>
              )}

              {draft?.mode === 'comfy' && !isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI WORKFLOW</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.imageGenerationWorkflows.length > 0 ? (
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
                        {[...data.imageGenerationWorkflows].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(workflow => (
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
                      {(selectedWorkflow?.parameters || []).length > 0 && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.setAsDefault ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'setAsDefault', !draft.setAsDefault)}
                          >
                            {draft.setAsDefault && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Set as default</span>
                        </label>
                      )}
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.name?.trim()}>
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

              {draft?.mode === 'api' && isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">MESH GEN API</span>
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
                    {data.meshGenerationApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  {/* Hitem3D is image-only and does not take a prompt. */}
                  {!isHitemMeshApi && (
                    <textarea
                      className="gen-prompt-input nodrag"
                      placeholder="Describe the mesh to generate"
                      value={draft.prompt || ''}
                      onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                    />
                  )}
                  <select
                    className="params-card__select nodrag"
                    value={draft.selectedInputSource || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedInputSource', event.target.value)}
                  >
                    {(isTencentMeshApi || isTripoMeshApi) && (
                      <option value="">No image source (use prompt)</option>
                    )}
                    {imageInputSources.length > 0 && (
                      <optgroup label="Connected inputs">
                        {imageInputSources.map(source => (
                          <option key={source.connectorId} value={getInputSourceSelectionValue(source)}>
                            {`${getConnectorTypeMeta(source.type).letter} · ${source.label}`}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {!isTencentMeshApi && !isTripoMeshApi && data.libraryImageOptions.length > 0 && (
                      <optgroup label="Asset library">
                        {data.libraryImageOptions.map(asset => (
                          <option key={asset.id} value={asset.sourceReference || asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {imageInputSources.length === 0 && (isTencentMeshApi || isTripoMeshApi || data.libraryImageOptions.length === 0) && (
                      <option value="">No image sources available</option>
                    )}
                  </select>
                  {isTripoMeshApi && (
                    <>
                      <select
                        className="params-card__select nodrag"
                        value={draft.modelVersion || 'v2.5-20250123'}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'modelVersion', event.target.value)}
                      >
                        {TRIPO_MODEL_VERSION_OPTIONS.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        className="params-card__input nodrag"
                        placeholder="Model seed (optional)"
                        value={draft.modelSeed ?? ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'modelSeed', event.target.value)}
                      />
                      {!isTripoP1Model && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.enableImageAutofix ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'enableImageAutofix', !draft.enableImageAutofix)}
                          >
                            {draft.enableImageAutofix && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Enable image autofix</span>
                        </label>
                      )}
                      <input
                        type="number"
                        min="1000"
                        max="300000"
                        className="params-card__input nodrag"
                        placeholder="Face limit (1000-300000, optional)"
                        value={draft.faceLimit ?? ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'faceLimit', event.target.value)}
                      />
                      <label className="params-card__checkbox-label nodrag">
                        <div
                          className={`params-card__checkbox ${draft.texture ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                          onClick={() => data.onDraftFieldChange?.(data.id, 'texture', !draft.texture)}
                        >
                          {draft.texture && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Texture</span>
                      </label>
                      <label className="params-card__checkbox-label nodrag">
                        <div
                          className={`params-card__checkbox ${draft.pbr ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                          onClick={() => data.onDraftFieldChange?.(data.id, 'pbr', !draft.pbr)}
                        >
                          {draft.pbr && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>PBR</span>
                      </label>
                      <input
                        type="number"
                        className="params-card__input nodrag"
                        placeholder="Texture seed (optional)"
                        value={draft.textureSeed ?? ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'textureSeed', event.target.value)}
                      />
                      {!isTripoP1Model && (
                        <select
                          className="params-card__select nodrag"
                          value={draft.textureAlignment || 'original_image'}
                          onChange={event => data.onDraftFieldChange?.(data.id, 'textureAlignment', event.target.value)}
                        >
                          {TRIPO_TEXTURE_ALIGNMENT_OPTIONS.map(option => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      )}
                      <select
                        className="params-card__select nodrag"
                        value={draft.textureQuality || 'standard'}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'textureQuality', event.target.value)}
                      >
                        {TRIPO_TEXTURE_QUALITY_OPTIONS.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <label className="params-card__checkbox-label nodrag">
                        <div
                          className={`params-card__checkbox ${draft.autoSize ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                          onClick={() => data.onDraftFieldChange?.(data.id, 'autoSize', !draft.autoSize)}
                        >
                          {draft.autoSize && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Auto size</span>
                      </label>
                      {!isTripoP1Model && (
                        <select
                          className="params-card__select nodrag"
                          value={draft.orientation || 'default'}
                          onChange={event => data.onDraftFieldChange?.(data.id, 'orientation', event.target.value)}
                        >
                          {TRIPO_ORIENTATION_OPTIONS.map(option => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      )}
                      {!isTripoP1Model && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.quad ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'quad', !draft.quad)}
                          >
                            {draft.quad && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Quad topology</span>
                        </label>
                      )}
                      {!isTripoP1Model && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.smartLowPoly ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'smartLowPoly', !draft.smartLowPoly)}
                          >
                            {draft.smartLowPoly && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Smart low poly</span>
                        </label>
                      )}
                      {!isTripoP1Model && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.generateParts ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'generateParts', !draft.generateParts)}
                          >
                            {draft.generateParts && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Generate parts</span>
                        </label>
                      )}
                      <label className="params-card__checkbox-label nodrag">
                        <div
                          className={`params-card__checkbox ${draft.exportUv ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                          onClick={() => data.onDraftFieldChange?.(data.id, 'exportUv', !draft.exportUv)}
                        >
                          {draft.exportUv && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Export UV</span>
                      </label>
                      {!isTripoP1Model && (
                        <select
                          className="params-card__select nodrag"
                          value={draft.geometryQuality || 'standard'}
                          onChange={event => data.onDraftFieldChange?.(data.id, 'geometryQuality', event.target.value)}
                        >
                          {TRIPO_GEOMETRY_QUALITY_OPTIONS.map(option => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      )}
                      {!isTripoP1Model && draft.generateParts && (draft.texture || draft.pbr || draft.quad) && (
                        <div className="graph-node__linked-input font-label">
                          generate_parts is not compatible with texture, pbr, or quad.
                        </div>
                      )}
                    </>
                  )}
                  {isTencentMeshApi && (
                    <>
                      <select
                        className="params-card__select nodrag"
                        value={draft.region || 'eu-frankfurt'}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'region', event.target.value)}
                      >
                        {TENCENT_REGION_OPTIONS.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <select
                        className="params-card__select nodrag"
                        value={draft.modelVersion || '3.0'}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'modelVersion', event.target.value)}
                      >
                        {TENCENT_MODEL_VERSION_OPTIONS.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <select
                        className="params-card__select nodrag"
                        value={draft.generationType || 'Normal'}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'generationType', event.target.value)}
                      >
                        {TENCENT_GENERATION_TYPE_OPTIONS.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      {draft.generationType === 'LowPoly' && (
                        <select
                          className="params-card__select nodrag"
                          value={draft.polygonType || 'triangle'}
                          onChange={event => data.onDraftFieldChange?.(data.id, 'polygonType', event.target.value)}
                        >
                          {TENCENT_POLYGON_TYPE_OPTIONS.map(option => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      )}
                      <input
                        type="number"
                        min="3000"
                        max="1500000"
                        className="params-card__input nodrag"
                        placeholder="Face count"
                        value={draft.faceCount ?? 500000}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'faceCount', event.target.value)}
                      />
                      <label className="params-card__checkbox-label nodrag">
                        <div
                          className={`params-card__checkbox ${draft.enablePBR ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                          onClick={() => data.onDraftFieldChange?.(data.id, 'enablePBR', !draft.enablePBR)}
                        >
                          {draft.enablePBR && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Enable PBR</span>
                      </label>
                    </>
                  )}
                  {isHitemMeshApi && (
                    <>
                      <select
                        className="params-card__select nodrag"
                        value={draft.hitemModel || 'hitem3dv2.1'}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'hitemModel', event.target.value)}
                      >
                        {HITEM_MODEL_VERSION_OPTIONS.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <select
                        className="params-card__select nodrag"
                        value={hitemResolutionOptions.includes(draft.hitemResolution) ? draft.hitemResolution : hitemResolutionOptions[0]}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'hitemResolution', event.target.value)}
                      >
                        {hitemResolutionOptions.map(option => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <select
                        className="params-card__select nodrag"
                        value={Number(draft.hitemRequestType) || 3}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'hitemRequestType', Number(event.target.value))}
                      >
                        {HITEM_REQUEST_TYPE_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={HITEM_FACE_MIN}
                        max={HITEM_FACE_MAX}
                        step="10000"
                        className="params-card__input nodrag"
                        placeholder="Face count"
                        value={draft.hitemFace ?? 300000}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'hitemFace', event.target.value)}
                      />
                      <label className="params-card__checkbox-label nodrag">
                        <div
                          className={`params-card__checkbox ${draft.hitemPbr ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                          onClick={() => data.onDraftFieldChange?.(data.id, 'hitemPbr', !draft.hitemPbr)}
                        >
                          {draft.hitemPbr && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Enable PBR</span>
                      </label>
                    </>
                  )}
                  <div className="graph-node__linked-input font-label">
                    {selectedApiImageSource?.label
                      ? `Input: ${selectedApiImageSource.label}`
                      : isTencentMeshApi
                        ? 'Select a connected image input or leave empty to use prompt only'
                        : isTripoMeshApi
                          ? 'Provide either a prompt or an image input connector for Tripo AI'
                          : isHitemMeshApi
                            ? 'Connect an image input or pick one from the asset library for Hitem3D'
                            : 'Select an image source from the graph or asset library'}
                  </div>
                  <button
                    className="gen-btn nodrag"
                    onClick={() => data.onRunNodeAction?.(data.id)}
                    disabled={isTencentMeshApi
                      ? (!draft.name?.trim() || (!hasDraftPrompt && !hasDraftInputSource))
                      : isTripoMeshApi
                        ? (!draft.name?.trim() || (!hasDraftPrompt && !hasDraftInputSource))
                        : isHitemMeshApi
                          ? (!draft.name?.trim() || !hasDraftInputSource)
                      : !draft.selectedInputSource}
                  >
                    <span className="material-symbols-outlined">deployed_code</span>
                    RUN GENERATION
                  </button>
                </div>
              )}

              {draft?.mode === 'comfy' && isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI MESH GEN</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.meshGenerationWorkflows.length > 0 ? (
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
                        {[...data.meshGenerationWorkflows].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(workflow => (
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
                        {imageInputSources.length > 0
                          ? `${imageInputSources.length} compatible image input${imageInputSources.length === 1 ? '' : 's'} available`
                          : 'Use a connected image or upload a custom file for image parameters'}
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.setAsDefault ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'setAsDefault', !draft.setAsDefault)}
                          >
                            {draft.setAsDefault && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Set as default</span>
                        </label>
                      )}
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.name?.trim()}>
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

              {draft?.mode === 'edit-api' && !isMeshGen && (
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
                  <select
                    className="params-card__select nodrag"
                    value={draft.selectedInputSource || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedInputSource', event.target.value)}
                  >
                    {imageInputSources.length > 0 && (
                      <optgroup label="Connected inputs">
                        {imageInputSources.map(source => (
                          <option key={source.connectorId} value={getInputSourceSelectionValue(source)}>
                            {`${getConnectorTypeMeta(source.type).letter} · ${source.label}`}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {data.libraryImageOptions.length > 0 && (
                      <optgroup label="Asset library">
                        {data.libraryImageOptions.map(asset => (
                          <option key={asset.id} value={asset.sourceReference || asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {imageInputSources.length === 0 && data.libraryImageOptions.length === 0 && (
                      <option value="">No image sources available</option>
                    )}
                  </select>
                  <div className="graph-node__linked-input font-label">
                    {selectedApiImageSource?.label
                      ? `Input: ${selectedApiImageSource.label}`
                      : 'Select an image source from the graph or asset library'}
                  </div>
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.selectedInputSource}>
                    <span className="material-symbols-outlined">auto_fix_high</span>
                    RUN EDIT
                  </button>
                </div>
              )}

              {draft?.mode === 'edit-comfy' && !isMeshGen && (
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
                        {[...data.imageEditWorkflows].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(workflow => (
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
                        {imageInputSources.length > 0
                          ? `${imageInputSources.length} compatible image input${imageInputSources.length === 1 ? '' : 's'} available`
                          : 'Use a connected image or upload a custom file for image parameters'}
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 && (
                        <label className="params-card__checkbox-label nodrag">
                          <div
                            className={`params-card__checkbox ${draft.setAsDefault ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
                            onClick={() => data.onDraftFieldChange?.(data.id, 'setAsDefault', !draft.setAsDefault)}
                          >
                            {draft.setAsDefault && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Set as default</span>
                        </label>
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

              {draft && draft.mode !== 'select' && (
                <button className="kanban-sidebar__nav-item nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} style={{ justifyContent: 'center' }}>
                  BACK
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {hasOutputAsset && (
        <div className="graph-node__connector graph-node__connector--output" style={getConnectorPosition(0, 1)}>
          <span
            className="graph-node__connector-badge font-label"
            style={{
              color: outputMeta.color,
              background: outputMeta.background,
              borderColor: outputMeta.color
            }}
            title={outputMeta.label}
          >
            {outputMeta.letter}
          </span>
          <Handle
            type="source"
            id={outputConnector.id}
            position={Position.Right}
            className="graph-node__handle graph-node__handle--output"
            style={{ borderColor: outputMeta.color }}
          />
        </div>
      )}
    </div>
  )
})

export default GraphAssetNode
