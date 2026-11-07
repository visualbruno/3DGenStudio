// Small form controls shared by the Workspace tool panels (Retopo, UV…),
// styled with the workspace-* classes in WorkspacePage.css.
import { useState } from 'react'

export function Switch({ label, value, onChange, hint, disabled }) {
  return (
    <label className="workspace-toggle-row" title={hint}>
      <span>{label}</span>
      <input type="checkbox" className="workspace-switch" checked={Boolean(value)} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    </label>
  )
}

export function NumberInput({ label, value, onChange, min, max, step, hint, disabled }) {
  return (
    <label className="workspace-field" title={hint}>
      <span className="workspace-field__label">{label}</span>
      <input
        className="workspace-input"
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))}
      />
    </label>
  )
}

export function Select({ label, value, onChange, options, hint, disabled }) {
  return (
    <label className="workspace-field" title={hint}>
      <span className="workspace-field__label">{label}</span>
      <select className="workspace-input" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

export function Disclosure({ label, children }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="workspace-section">
      <button type="button" className="workspace-disclosure" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span>{label}</span>
        <span className="material-symbols-outlined">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && <div className="workspace-advanced">{children}</div>}
    </div>
  )
}

export function ResultRows({ rows }) {
  if (!rows?.length) return null
  return (
    <dl className="workspace-result">
      {rows.map(row => (
        <div key={row.label} className="workspace-result__row">
          <dt>{row.label}</dt>
          <dd>{String(row.value)}</dd>
        </div>
      ))}
    </dl>
  )
}
