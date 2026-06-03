import { memo, useEffect, useMemo } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import {
  DEFAULT_INPUT_ID,
  DEFAULT_OUTPUT_ID,
  formatWorkflowDefaultValue,
  getCompatibleInputSources,
  getConnectorPosition,
  getConnectorTypeMeta,
  getDefaultNodeOutputValue,
  getInputSourceSelectionValue,
  getWorkflowParameterBinding,
  getWorkflowParameterValueType,
  isFileWorkflowValueType,
  resolveSelectedInputSource
} from '../../utils/graphHelpers'

// Value node for Number / Text / Boolean outputs. Text nodes also accept inputs
// and can run text-generating ComfyUI workflows.
const GraphValueNode = memo(function GraphValueNode({ data }) {
  const updateNodeInternals = useUpdateNodeInternals()
  const nodeKind = data.nodeKind
  const isTextNode = nodeKind === 'text'
  const outputMeta = getConnectorTypeMeta(nodeKind)
  const outputValue = data.metadata?.outputValue ?? getDefaultNodeOutputValue(data.nodeTypeName || nodeKind)
  const nodeDisplayName = data.name || data.nodeTypeName || outputMeta.label

  const draft = data.actionDraft
  const isProcessing = data.status === 'processing'
  const progressDetail = data.progressDetail || data.metadata?.detail || ''
  const currentNodeLabel = data.currentNodeLabel || data.metadata?.currentNodeLabel || ''
  const textWorkflows = data.textGenerationWorkflows || []
  const selectedWorkflow = textWorkflows.find(workflow => workflow.id == draft?.workflowId) || null
  const inputConnectors = useMemo(() => (
    isTextNode
      ? (data.inputConnectors || [{ id: DEFAULT_INPUT_ID, type: null, isConnected: false }])
      : []
  ), [isTextNode, data.inputConnectors])
  const inputSources = data.inputSources || []
  const connectedInputCount = inputConnectors.filter(connector => connector.isConnected).length

  useEffect(() => {
    if (isTextNode) {
      updateNodeInternals(String(data.id))
    }
  }, [data.id, isTextNode, inputConnectors, updateNodeInternals])

  const renderWorkflowField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const currentValue = draft?.inputs?.[parameter.id]
    const compatibleSources = getCompatibleInputSources(inputSources, valueType)
    const binding = getWorkflowParameterBinding(draft, parameter)
    const selectedSource = resolveSelectedInputSource(binding.source, compatibleSources)

    const renderCustomValueField = () => {
      if (isFileWorkflowValueType(valueType)) {
        return (
          <div className="graph-node__linked-input font-label">
            {`Connect a ${valueType} input to provide this value.`}
          </div>
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
    <div className={`graph-node graph-node--value graph-node--${nodeKind}`}>
      {isTextNode && inputConnectors.map((connector, index) => {
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

      <div className="graph-node__value-card">
        <div className="graph-node__value-header graph-node__drag-handle">
          <div className="graph-node__value-title-group">
            <input
              type="text"
              className="graph-node__name-input graph-node__name-input--value nodrag"
              value={nodeDisplayName}
              placeholder={outputMeta.label}
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <span
              className="graph-node__value-type font-label"
              style={{
                color: outputMeta.color,
                background: outputMeta.background,
                borderColor: outputMeta.color
              }}
            >
              {outputMeta.label}
            </span>
          </div>

          <button
            type="button"
            className="image-card__action-btn image-card__delete graph-node__value-delete nodrag"
            style={{ opacity: 1, flexShrink: 0 }}
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="graph-node__value-body">
          <span className="graph-node__panel-title font-label">VALUE</span>

          {nodeKind === 'text' ? (
            <textarea
              className="gen-prompt-input graph-node__value-input graph-node__value-input--textarea nodrag"
              value={String(outputValue ?? '')}
              placeholder="Type text or generate it with a workflow"
              onChange={event => data.onNodeOutputValueChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeOutputValueCommit?.(data.id, event.target.value)}
            />
          ) : nodeKind === 'boolean' ? (
            <button
              type="button"
              className={`graph-node__boolean-toggle nodrag ${outputValue ? 'graph-node__boolean-toggle--active' : ''}`}
              onClick={() => {
                const nextValue = !outputValue
                data.onNodeOutputValueChange?.(data.id, nextValue)
                data.onNodeOutputValueCommit?.(data.id, nextValue)
              }}
              aria-pressed={outputValue}
            >
              <span className="material-symbols-outlined">{outputValue ? 'check_circle' : 'radio_button_unchecked'}</span>
              <span>{outputValue ? 'True' : 'False'}</span>
            </button>
          ) : (
            <input
              type="number"
              className="params-card__input graph-node__value-input nodrag"
              value={outputValue ?? ''}
              onChange={event => data.onNodeOutputValueChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeOutputValueCommit?.(data.id, event.target.value)}
            />
          )}

          {isTextNode && isProcessing && (
            <>
              <p className="image-card__meta font-label">{progressDetail || 'Processing…'}</p>
              {currentNodeLabel && (
                <p className="image-card__meta font-label image-card__meta--loading-node">{currentNodeLabel}</p>
              )}
              {Number.isFinite(data.progress) && (
                <div className="image-card__progress graph-node__progress" aria-hidden="true">
                  <div
                    className="image-card__progress-bar"
                    style={{ width: `${Math.max(0, Math.min(100, data.progress || 0))}%` }}
                  />
                </div>
              )}
            </>
          )}

          <div className="graph-node__ports-summary font-label">
            {isTextNode && (
              <span className="graph-node__port-label">Inputs · {connectedInputCount > 0 ? `${connectedInputCount} connected` : 'empty'}</span>
            )}
            <span className="graph-node__port-label graph-node__port-label--output">Output · {outputMeta.label}</span>
          </div>

          {isTextNode && (
            <div className="image-card__attributes graph-node__actions-panel">
              <div className="image-card__edit-actions">
                <div className="graph-node__primary-actions">
                  <button className="image-card__edit-action-btn nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} disabled={isProcessing}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                    Action
                  </button>
                </div>

                {draft?.mode === 'select' && (
                  <div className="image-card__edit-action-menu">
                    <button className="image-card__edit-action-option nodrag" onClick={() => data.onTextModeSelect?.(data.id, 'comfy')}>
                      Generate · ComfyUI Workflow
                    </button>
                  </div>
                )}

                {draft?.mode === 'comfy' && (
                  <div className="image-card__edit-panel nodrag">
                    <span className="graph-node__panel-title font-label">COMFYUI WORKFLOW</span>
                    {data.comfyLoading ? (
                      <div className="image-card__asset-picker-empty">
                        <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                        <span>Loading workflows...</span>
                      </div>
                    ) : textWorkflows.length > 0 ? (
                      <>
                        <select
                          className="params-card__select nodrag"
                          value={draft.workflowId || ''}
                          onChange={event => data.onDraftFieldChange?.(data.id, 'workflowId', event.target.value)}
                        >
                          {textWorkflows.map(workflow => (
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
                        <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={isProcessing}>
                          <span className="material-symbols-outlined">bolt</span>
                          GENERATE TEXT
                        </button>
                        <button
                          className="kanban-sidebar__nav-item nodrag"
                          onClick={() => data.onTextModeSelect?.(data.id, 'select')}
                          style={{ justifyContent: 'center' }}
                        >
                          BACK
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="image-card__asset-picker-empty">
                          <span className="material-symbols-outlined">account_tree</span>
                          <span>No imported workflows with a text (String) output are available.</span>
                        </div>
                        <button
                          className="kanban-sidebar__nav-item nodrag"
                          onClick={() => data.onTextModeSelect?.(data.id, 'select')}
                          style={{ justifyContent: 'center' }}
                        >
                          BACK
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

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
          id={DEFAULT_OUTPUT_ID}
          position={Position.Right}
          className="graph-node__handle graph-node__handle--output"
          style={{ borderColor: outputMeta.color }}
        />
      </div>
    </div>
  )
})

export default GraphValueNode
