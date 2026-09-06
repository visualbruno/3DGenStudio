// Grouped parameter panel. Basic controls are always visible; the rest appear
// only when Advanced is on, which is what keeps ~40 fields from reading as a
// wall of sliders.
import { useMemo, useState } from 'react'
import { PARAM_GROUPS, TREE_PARAMS } from './treeParams'
import { readSpecValue } from '../../utils/treeGen'

function Field({ field, value, onChange }) {
  const id = `tp-${field.path.replace(/\./g, '-')}`

  if (field.type === 'boolean') {
    return (
      <label className="treegen__field treegen__field--check" htmlFor={id} title={field.hint || ''}>
        <input
          id={id}
          type="checkbox"
          checked={!!value}
          onChange={event => onChange(field.path, event.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    )
  }

  if (field.type === 'select') {
    return (
      <div className="treegen__field" title={field.hint || ''}>
        <label htmlFor={id}>{field.label}</label>
        <select id={id} value={value ?? ''} onChange={event => onChange(field.path, event.target.value)}>
          {field.options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
    )
  }

  const numeric = Number(value ?? 0)
  // Show enough decimals for the step, so a 0.001-step field does not read as a
  // row of identical zeroes while it is being dragged.
  const decimals = Math.max(0, Math.ceil(-Math.log10(field.step || 1)))

  return (
    <div className="treegen__field" title={field.hint || ''}>
      <label htmlFor={id}>
        {field.label}
        <span className="treegen__value">
          {numeric.toFixed(decimals)}{field.unit || ''}
        </span>
      </label>
      <div className="treegen__slider-row">
        <input
          id={id}
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={numeric}
          onChange={event => onChange(field.path, Number(event.target.value))}
        />
        <input
          className="treegen__number"
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={numeric}
          onChange={event => onChange(field.path, Number(event.target.value))}
        />
      </div>
    </div>
  )
}

export default function TreeParamPanel({ spec, onChange, disabled = false }) {
  const [advanced, setAdvanced] = useState(false)
  const [collapsed, setCollapsed] = useState({})

  const grouped = useMemo(() => {
    const map = new Map(PARAM_GROUPS.map(group => [group, []]))
    for (const field of TREE_PARAMS) {
      if (!advanced && !field.basic) continue
      map.get(field.group)?.push(field)
    }
    return map
  }, [advanced])

  if (!spec) return null

  return (
    <div className={`treegen__params ${disabled ? 'treegen__params--disabled' : ''}`}>
      <label className="treegen__advanced-toggle">
        <input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />
        <span>Advanced parameters</span>
      </label>

      {PARAM_GROUPS.map(group => {
        const fields = grouped.get(group) || []
        if (!fields.length) return null
        const isCollapsed = !!collapsed[group]
        return (
          <section key={group} className="treegen__group">
            <button
              type="button"
              className="treegen__group-header"
              onClick={() => setCollapsed(state => ({ ...state, [group]: !state[group] }))}
            >
              <span className="treegen__chevron">{isCollapsed ? '▸' : '▾'}</span>
              {group}
              <span className="treegen__group-count">{fields.length}</span>
            </button>
            {!isCollapsed && (
              <div className="treegen__group-body">
                {fields.map(field => (
                  <Field
                    key={field.path}
                    field={field}
                    value={readSpecValue(spec, field.path)}
                    onChange={onChange}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
