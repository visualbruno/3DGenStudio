// The settings of a cloud mesh API in the Workspace Mesh panel: the provider's
// model choices, Target Faces, texture / PBR, seed (Tripo), then Advanced.
// Field lists come from src/utils/workspaceMeshCloud.js.
import { useState } from 'react'
import { cloudFacePresets, cloudFaceRange, cloudMeshFields, cloudSupports, formatCloudFaces } from '../../utils/workspaceMeshCloud'

function optionEntries(options) {
  return options.map(option => (typeof option === 'object' ? option : { value: option, label: option }))
}

function CloudField({ field, value, onChange }) {
  if (field.kind === 'switch') {
    return (
      <label className="workspace-toggle-row">
        <span>{field.label}</span>
        <input
          type="checkbox"
          className="workspace-switch"
          checked={Boolean(value)}
          onChange={event => onChange(field.key, event.target.checked)}
        />
      </label>
    )
  }
  return (
    <label className="workspace-field">
      <span className="workspace-field__label">{field.label}</span>
      <select className="workspace-input" value={value ?? ''} onChange={event => onChange(field.key, event.target.value)}>
        {optionEntries(field.options).map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

export default function WorkspaceCloudMeshFields({
  model,
  options,
  tab,
  onChange,
  seed,
  onSeedChange,
  randomSeed,
  onToggleRandomSeed
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const fields = cloudMeshFields(model, options, tab)
  const supports = cloudSupports(model, options)
  const presets = cloudFacePresets(model, options)
  const range = cloudFaceRange(model, options)
  const set = (key, value) => onChange({ [key]: value })

  return (
    <>
      {fields.main.length > 0 && (
        <div className="workspace-section">
          {fields.main.map(field => (
            <CloudField key={field.key} field={field} value={options[field.key]} onChange={set} />
          ))}
        </div>
      )}

      <div className="workspace-section">
        <div className="workspace-section__head">
          <span>Target Faces</span>
          <span className="workspace-section__aside" title={`${range.min.toLocaleString()} – ${range.max.toLocaleString()}`}>
            {formatCloudFaces(options.faces)}
          </span>
        </div>
        <div className="workspace-chips workspace-chips--even">
          {presets.map(value => (
            <button
              key={value ?? 'auto'}
              type="button"
              className={`workspace-chip workspace-chip--box ${options.faces === value ? 'workspace-chip--active' : ''}`}
              onClick={() => set('faces', value)}
              title={value == null ? `Let ${model.label} choose` : `${value.toLocaleString()} faces`}
            >
              {formatCloudFaces(value)}
            </button>
          ))}
        </div>
        <input
          className="workspace-input"
          type="number"
          min={range.min}
          max={range.max}
          step={1000}
          value={options.faces ?? ''}
          placeholder={presets.includes(null) ? 'Auto' : ''}
          onChange={event => set('faces', event.target.value === '' ? null : Number(event.target.value))}
          aria-label="Target face count"
        />
      </div>

      {(supports.texture || supports.pbr) && (
        <div className="workspace-section">
          {supports.texture && (
            <label className="workspace-toggle-row">
              <span>Textured</span>
              <input
                type="checkbox"
                className="workspace-switch"
                checked={Boolean(options.texture)}
                onChange={event => set('texture', event.target.checked)}
              />
            </label>
          )}
          {supports.pbr && (
            <label className="workspace-toggle-row" title="Metallic / roughness / normal maps on top of the colour">
              <span>PBR Materials</span>
              <input
                type="checkbox"
                className="workspace-switch"
                checked={Boolean(options.pbr) && (!supports.texture || Boolean(options.texture)) && options.generationType !== 'Geometry'}
                disabled={(supports.texture && !options.texture) || options.generationType === 'Geometry'}
                onChange={event => set('pbr', event.target.checked)}
              />
            </label>
          )}
        </div>
      )}

      {supports.seed && (
        <div className="workspace-section">
          <div className="workspace-field">
            <span className="workspace-field__label">Seed</span>
            <div className="workspace-field__row">
              <input
                className="workspace-input"
                type="number"
                value={randomSeed ? '' : (seed ?? '')}
                placeholder={randomSeed ? 'Random each run' : ''}
                disabled={randomSeed}
                onChange={event => onSeedChange(event.target.value)}
              />
              <button
                type="button"
                className={`workspace-icon-btn ${randomSeed ? 'workspace-icon-btn--active' : ''}`}
                onClick={onToggleRandomSeed}
                title={randomSeed ? 'Random seed on — click to use a fixed seed' : 'Fixed seed — click to randomize each run'}
                aria-pressed={randomSeed}
              >
                <span className="material-symbols-outlined">casino</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {fields.advanced.length > 0 && (
        <div className="workspace-section">
          <button
            type="button"
            className="workspace-disclosure"
            onClick={() => setShowAdvanced(open => !open)}
            aria-expanded={showAdvanced}
          >
            <span>Advanced</span>
            <span className="material-symbols-outlined">{showAdvanced ? 'expand_less' : 'expand_more'}</span>
          </button>
          {showAdvanced && (
            <div className="workspace-advanced">
              {fields.advanced.map(field => (
                <CloudField key={field.key} field={field} value={options[field.key]} onChange={set} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
