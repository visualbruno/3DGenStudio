// One ComfyUI workflow parameter as a Workspace field: enum → select, boolean →
// switch, number → input, anything else → text. A seed (`randomSeed` given)
// gets the "random each run" dice toggle.
import { getWorkflowEnumOptions, resolveWorkflowEnumValue } from '../../utils/workflowEnums'
import { getParameterValueType } from '../../utils/workspaceImage'

export default function WorkspaceParamField({ parameter, value, onChange, label, randomSeed, onToggleRandomSeed }) {
  const valueType = getParameterValueType(parameter)
  const text = label || parameter.name || parameter.id
  const isSeed = typeof randomSeed === 'boolean'

  const enumOptions = getWorkflowEnumOptions(parameter, value)
  if (enumOptions) {
    return (
      <label className="workspace-field">
        <span className="workspace-field__label">{text}</span>
        <select
          className="workspace-input"
          value={value == null ? '' : String(value)}
          onChange={event => onChange(parameter.id, resolveWorkflowEnumValue(parameter, event.target.value))}
        >
          {enumOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    )
  }

  if (valueType === 'boolean') {
    return (
      <label className="workspace-toggle-row">
        <span>{text}</span>
        <input
          type="checkbox"
          className="workspace-switch"
          checked={Boolean(value)}
          onChange={event => onChange(parameter.id, event.target.checked)}
        />
      </label>
    )
  }

  if (valueType === 'number') {
    return (
      <div className="workspace-field">
        <span className="workspace-field__label">{text}</span>
        <div className="workspace-field__row">
          <input
            className="workspace-input"
            type="number"
            value={isSeed && randomSeed ? '' : (value ?? '')}
            placeholder={isSeed && randomSeed ? 'Random each run' : ''}
            disabled={isSeed && randomSeed}
            onChange={event => onChange(parameter.id, event.target.value)}
          />
          {isSeed && (
            <button
              type="button"
              className={`workspace-icon-btn ${randomSeed ? 'workspace-icon-btn--active' : ''}`}
              onClick={onToggleRandomSeed}
              title={randomSeed ? 'Random seed on — click to use a fixed seed' : 'Fixed seed — click to randomize each run'}
              aria-pressed={randomSeed}
            >
              <span className="material-symbols-outlined">casino</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <label className="workspace-field">
      <span className="workspace-field__label">{text}</span>
      <input
        className="workspace-input"
        type="text"
        value={value ?? ''}
        onChange={event => onChange(parameter.id, event.target.value)}
      />
    </label>
  )
}
