// Reusable labeled controls for the Auto UV / Auto Retopo parameter panels.
// Presentational only — value + onChange come from the parent.

export function RangeField({ label, hint, value, min, max, step, suffix = '', decimals = null, onChange, disabled }) {
  const shown = decimals != null ? Number(value).toFixed(decimals) : value
  return (
    <label className="mesh-editor-range-field" title={hint || label}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        disabled={disabled}
      />
      <strong>{shown}{suffix}</strong>
    </label>
  )
}

export function NumberField({ label, hint, value, min, max, step = 1, onChange, disabled }) {
  return (
    <div className="mesh-editor-workflow-field" title={hint || label}>
      <span>{label}</span>
      <input
        className="mesh-editor-panel__input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => {
          const next = event.target.value === '' ? '' : Number(event.target.value)
          onChange(next)
        }}
        disabled={disabled}
      />
    </div>
  )
}

export function ToggleField({ label, hint, value, onChange, disabled }) {
  return (
    <label className="mesh-editor-workflow-field mesh-editor-workflow-field--checkbox" title={hint || label}>
      <input
        type="checkbox"
        checked={value}
        onChange={event => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span>{label}</span>
    </label>
  )
}

export function SelectField({ label, hint, value, options, onChange, disabled }) {
  return (
    <div className="mesh-editor-workflow-field" title={hint || label}>
      <span>{label}</span>
      <select
        className="mesh-editor-panel__input mesh-editor-panel__select"
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  )
}
