import { AUTO_RIG_BONE_NAME_OPTIONS } from '../utils/meshTools'

// The Auto Rig option set, rendered as params-card fields. Shared by every
// surface that runs the rigging service outside the Mesh Editor (the graph's
// Rig Mesh node and the Kanban Rigging column), so the parameter list, ranges
// and hints stay identical between them.
//
// `options` is the current value bag (the surface's draft), `onChange(key, value)`
// writes one field back. `controlClassName` is appended to every interactive
// element — React Flow needs "nodrag" there, the Kanban card needs nothing.
export default function AutoRigParameterFields({
  options,
  onChange,
  disabled = false,
  controlClassName = '',
  selectClassName = 'params-card__select'
}) {
  const withControlClass = (base) => `${base}${controlClassName ? ` ${controlClassName}` : ''}`

  const renderToggle = (field, label, hint) => (
    <div key={field} className="params-card__field">
      <label className={withControlClass('params-card__checkbox-label')}>
        <div
          className={`params-card__checkbox ${options?.[field] ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
          onClick={() => !disabled && onChange(field, !options?.[field])}
        >
          {options?.[field] && (
            <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>
          )}
        </div>
        <span>{label}</span>
      </label>
      <span className="image-card__param-hint">{hint}</span>
    </div>
  )

  const renderNumber = (field, label, { min, max, step, hint = null }) => (
    <div key={field} className="params-card__field">
      <label className="params-card__label font-label">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className={withControlClass('params-card__input')}
        value={options?.[field] ?? ''}
        disabled={disabled}
        onChange={event => onChange(field, event.target.value === '' ? '' : Number(event.target.value))}
      />
      {hint && <span className="image-card__param-hint">{hint}</span>}
    </div>
  )

  return (
    <>
      <div className="params-card__field">
        <label className="params-card__label font-label">Bone names</label>
        <select
          className={withControlClass(selectClassName)}
          value={options?.rename_bones || 'mixamo'}
          disabled={disabled}
          onChange={event => onChange('rename_bones', event.target.value)}
        >
          {AUTO_RIG_BONE_NAME_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span className="image-card__param-hint">Rename the generated bones to a standard humanoid convention for retargeting</span>
      </div>

      {renderToggle('use_transfer', 'Preserve texture & scale', 'Transfer the rig onto the original mesh (keeps its texture and scale). Recommended.')}
      {renderToggle('use_postprocess', 'Voxel-skin postprocess', 'Clean up skin weights with a voxel pass to reduce bleed across disconnected parts')}
      {renderToggle('keep_loaded', 'Keep model loaded in memory', 'Keep the rig model in (GPU) memory for fast repeat rigs')}

      {renderNumber('top_k', 'Top-k', { min: 1, max: 200, step: 1, hint: 'Top-k sampling' })}
      {renderNumber('top_p', 'Top-p', { min: 0.1, max: 1, step: 0.01, hint: 'Nucleus (top-p) sampling' })}
      {renderNumber('temperature', 'Temperature', { min: 0.1, max: 2, step: 0.1 })}
      {renderNumber('repetition_penalty', 'Repetition penalty', { min: 0.5, max: 3, step: 0.1 })}
      {renderNumber('num_beams', 'Beams', { min: 1, max: 20, step: 1, hint: 'Beam-search width' })}
      {renderNumber('length_penalty', 'Length penalty', {
        min: 0.5, max: 3, step: 0.05, hint: 'Beam-search length preference. Above 1.0 favours skeletons with MORE bones — raise it when a rig comes back stopping short of the fingers or the tail. Only does anything with Beams above 1.',
      })}
    </>
  )
}
