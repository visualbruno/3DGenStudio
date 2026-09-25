import {
  BATCH_ACTIONS,
  BATCH_ACTION_LABELS,
  BINDING_MANUAL,
  BINDING_STAGE,
  BINDING_VARIABLE,
  articleFor,
  bindingToSelectValue,
  getBinding,
  getBindingOptionsForParameter,
  getStageAction,
  getStageLabel,
  isBuiltInBatchAction,
  getVariableLabel,
  isVariableCompatibleWithValueType,
  resolveStageName,
  selectValueToBinding,
  variableToken
} from '../../utils/batchHelpers'
import {
  formatWorkflowDefaultValue,
  getWorkflowParameterValueType,
  isFileWorkflowValueType
} from '../../utils/graphHelpers'
import { getWorkflowEnumOptions, resolveWorkflowEnumValue } from '../../utils/workflowEnums'

// One stage. Every stage runs once per group, in column order, and can consume
// the output of any earlier stage. What it runs is its ACTION: a ComfyUI
// workflow, or one of the Mesh Editor's tools — which describe themselves as a
// workflow (see batch/actions.js), so the parameter list below serves both.
export default function BatchStageColumn({
  stage,
  stageIndex,
  stages,
  variables,
  groups,
  workflows,
  workflow,
  locked,
  onUpdateStage,
  onSetBinding,
  onSetManualInput,
  onRemoveStage,
  onMoveStage
}) {
  const parameters = workflow?.parameters || []
  const action = getStageAction(stage)
  const isBuiltIn = isBuiltInBatchAction(action)

  // Show what the name template resolves to for the first group, so the effect
  // of a {{token}} is visible without running the batch.
  const previewName = (stage.name || '').includes('{{') && groups?.length
    ? resolveStageName(stage, stageIndex, { group: groups[0], variables })
    : ''

  const renderManualField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const currentValue = stage.inputs?.[parameter.id]

    if (valueType === 'boolean') {
      return (
        <label className="batch-checkbox">
          <input
            type="checkbox"
            checked={Boolean(currentValue)}
            onChange={event => onSetManualInput(stage.id, parameter.id, event.target.checked)}
            disabled={locked}
          />
          {/* A built-in action's label is a sentence of help, shown below. */}
          <span>{isBuiltIn ? 'Enabled' : (parameter.label || 'Enabled')}</span>
        </label>
      )
    }

    // A built-in action's choice carries a label per value (bone naming reads
    // "Unreal Engine 5", not "ue5"); a workflow enum's label is its value.
    const enumOptions = getWorkflowEnumOptions(parameter, currentValue)?.map(option => ({
      ...option,
      label: parameter.options?.find(item => String(item.value) === option.value)?.label || option.label
    }))
    if (enumOptions) {
      return (
        <select
          className="batch-select"
          value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
          onChange={event => onSetManualInput(stage.id, parameter.id, resolveWorkflowEnumValue(parameter, event.target.value))}
          disabled={locked}
        >
          {enumOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )
    }

    if (valueType === 'number') {
      return (
        <input
          type="number"
          className="batch-input"
          min={parameter.min}
          max={parameter.max}
          step={parameter.step ?? 'any'}
          value={currentValue ?? ''}
          onChange={event => onSetManualInput(stage.id, parameter.id, event.target.value)}
          disabled={locked}
        />
      )
    }

    return (
      <textarea
        className="batch-textarea"
        rows={3}
        value={currentValue ?? ''}
        onChange={event => onSetManualInput(stage.id, parameter.id, event.target.value)}
        disabled={locked}
      />
    )
  }

  return (
    <div className="batch-column batch-column--stage">
      <div className="batch-column__header">
        <span className="batch-column__title font-label">STAGE {stageIndex + 1}</span>
        <div className="batch-column__header-actions">
          <button
            type="button"
            className="batch-icon-btn"
            onClick={() => onMoveStage(stage.id, -1)}
            disabled={locked || stageIndex === 0}
            title="Move earlier"
          >
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <button
            type="button"
            className="batch-icon-btn"
            onClick={() => onMoveStage(stage.id, 1)}
            disabled={locked || stageIndex === stages.length - 1}
            title="Move later"
          >
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
          <button
            type="button"
            className="batch-icon-btn"
            onClick={() => onRemoveStage(stage.id)}
            disabled={locked}
            title="Remove stage"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>

      <div className="batch-column__body">
        <div className="batch-field">
          <span className="batch-field__label font-label">RESULT NAME</span>
          <input
            type="text"
            className="batch-input batch-input--title"
            placeholder={getStageLabel(stage, stageIndex)}
            value={stage.name || ''}
            onChange={event => onUpdateStage(stage.id, { name: event.target.value })}
            disabled={locked}
          />
          {variables.length > 0 && (
            <select
              className="batch-select batch-select--compact"
              value=""
              onChange={event => {
                if (!event.target.value) return
                onUpdateStage(stage.id, { name: `${stage.name || ''}${event.target.value}` })
              }}
              disabled={locked}
            >
              <option value="">Insert variable…</option>
              {variables.map((variable, variableIndex) => (
                <option key={variable.id} value={variableToken(variable, variableIndex)}>
                  {getVariableLabel(variable, variableIndex)}
                </option>
              ))}
            </select>
          )}
          <span className="batch-param__hint">
            Names every asset this stage produces. Use {'{{variable}}'} tokens to name each
            result after the values that made it.
            {previewName && <><br />Group 1 → <strong>{previewName}</strong></>}
          </span>
        </div>

        <label className="batch-field">
          <span className="batch-field__label font-label">ACTION</span>
          <select
            className="batch-select"
            value={action}
            onChange={event => onUpdateStage(stage.id, { action: event.target.value })}
            disabled={locked}
          >
            {BATCH_ACTIONS.map(item => (
              <option key={item} value={item}>{BATCH_ACTION_LABELS[item]}</option>
            ))}
          </select>
          {isBuiltIn && workflow?.description && (
            <span className="batch-param__hint">{workflow.description}</span>
          )}
        </label>

        {!isBuiltIn && (
          <label className="batch-field">
            <span className="batch-field__label font-label">COMFYUI WORKFLOW</span>
            <select
              className="batch-select"
              value={stage.workflowId || ''}
              onChange={event => onUpdateStage(stage.id, { workflowId: event.target.value })}
              disabled={locked}
            >
              <option value="">Select a workflow…</option>
              {[...workflows].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        )}

        {!workflow ? (
          <p className="batch-empty">Pick a workflow to configure its parameters.</p>
        ) : parameters.length === 0 ? (
          <p className="batch-empty">This workflow exposes no parameters. It will run as-is, once per group.</p>
        ) : (
          <div className="batch-param-list">
            {parameters.map(parameter => {
              const binding = getBinding(stage, parameter.id)
              const valueType = getWorkflowParameterValueType(parameter)
              const options = getBindingOptionsForParameter(parameter, { variables, stages, stageIndex })
              const boundVariable = binding.source === BINDING_VARIABLE
                ? variables.find(item => item.id === binding.variableId)
                : null
              const boundStage = binding.source === BINDING_STAGE
                ? stages.find(item => item.id === binding.stageId)
                : null
              const isDanglingBinding = (binding.source === BINDING_VARIABLE && !boundVariable)
                || (binding.source === BINDING_STAGE && !boundStage)
              // Retyping a variable (string → image, say) leaves the binding in
              // place but pointing at something this parameter cannot take.
              const isMistypedBinding = Boolean(boundVariable)
                && !isVariableCompatibleWithValueType(boundVariable, valueType)

              return (
                <div key={parameter.id} className="batch-param">
                  <span className="batch-param__label font-label">
                    {parameter.name} · {valueType.toUpperCase()}
                  </span>

                  <select
                    className="batch-select"
                    value={bindingToSelectValue(binding)}
                    onChange={event => onSetBinding(stage.id, parameter.id, selectValueToBinding(event.target.value))}
                    disabled={locked}
                  >
                    {options.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>

                  {isBuiltIn && isFileWorkflowValueType(valueType) && parameter.label && (
                    <span className="batch-param__hint">{parameter.label}.</span>
                  )}

                  {isDanglingBinding && (
                    <span className="batch-param__warning">
                      The bound source no longer exists — pick another.
                    </span>
                  )}

                  {isMistypedBinding && (
                    <span className="batch-param__warning">
                      {getVariableLabel(boundVariable, variables.indexOf(boundVariable))} is
                      {' '}{articleFor(boundVariable.type)} {boundVariable.type} variable and cannot feed
                      {' '}{articleFor(valueType)} {valueType} input — pick another.
                    </span>
                  )}

                  {binding.source === BINDING_VARIABLE && boundVariable && !isMistypedBinding && (
                    <span className="batch-param__hint">
                      Each group supplies {getVariableLabel(boundVariable, variables.indexOf(boundVariable))}
                      {isFileWorkflowValueType(valueType) ? `'s ${valueType}` : ''}.
                    </span>
                  )}

                  {binding.source === BINDING_STAGE && boundStage && (
                    <span className="batch-param__hint">
                      Receives {getStageLabel(boundStage, stages.indexOf(boundStage))}&apos;s output from the same group.
                    </span>
                  )}

                  {binding.source === BINDING_MANUAL && (
                    isFileWorkflowValueType(valueType) ? (
                      <span className="batch-param__warning">
                        {stageIndex === 0
                          ? `Declare ${articleFor(valueType)} ${valueType} variable and give each group one, or move this stage later so an earlier stage can feed it.`
                          : `Bind this to an earlier stage or ${articleFor(valueType)} ${valueType} variable.`}
                      </span>
                    ) : (
                      <>
                        {renderManualField(parameter)}
                        <span className="batch-param__hint">
                          {parameter.label} · default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                        </span>
                      </>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
