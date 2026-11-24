import {
  MESHY_AI_MODEL_OPTIONS,
  MESHY_DEFAULTS,
  MESHY_SMART_TOPOLOGY_MODELS,
  MESHY_TEXTURE_MODEL_OPTIONS,
  MESHY_TOPOLOGY_OPTIONS
} from '../utils/kanbanHelpers'

// Credits per docs.meshy.ai/en/api/pricing: the 7.1 / 6 models cost 20 for the
// mesh, the lite and Smart Topology ones 5; a texture adds 10.
function estimateMeshyCredits(aiModel, shouldTexture) {
  const meshCredits = ['latest', 'meshy-7.1', 'meshy-6'].includes(aiModel) ? 20 : 5
  return meshCredits + (shouldTexture ? 10 : 0)
}

function Checkbox({ checked, onToggle, label }) {
  return (
    <label className="params-card__checkbox-label nodrag">
      <div className={`params-card__checkbox ${checked ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={onToggle}>
        {checked && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
      </div>
      <span>{label}</span>
    </label>
  )
}

// Meshy mesh generation fields, shared by the Kanban card / "Add New Mesh"
// draft and the Graph mesh-gen node. `onChange(field, value)` mutates the draft.
export default function MeshyOptionsFields({ draft, onChange, selectClassName, inputClassName }) {
  const value = key => draft?.[key] ?? MESHY_DEFAULTS[key]
  const aiModel = value('meshyAiModel')
  const isSmartTopology = MESHY_SMART_TOPOLOGY_MODELS.includes(aiModel)
  const shouldTexture = Boolean(value('meshyShouldTexture'))
  const isN1 = value('meshyTextureModel') === 'meshy-n1'
  const shouldRemesh = !isSmartTopology && Boolean(value('meshyShouldRemesh'))
  const maxPolycount = aiModel === 'meshy-t2' ? 15000 : aiModel === 'meshy-t2.5' ? 30000 : 300000

  return (
    <>
      <div className="params-card__field">
        <label className="params-card__label font-label">Model</label>
        <select className={selectClassName} value={aiModel} onChange={event => onChange('meshyAiModel', event.target.value)}>
          {MESHY_AI_MODEL_OPTIONS.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>

      <div className="params-card__field">
        <label className="params-card__label font-label">Texture</label>
        <Checkbox checked={shouldTexture} onToggle={() => onChange('meshyShouldTexture', !shouldTexture)} label="Generate a texture" />
      </div>

      {shouldTexture && (
        <>
          <div className="params-card__field">
            <label className="params-card__label font-label">Texture Model</label>
            <select className={selectClassName} value={value('meshyTextureModel')} onChange={event => onChange('meshyTextureModel', event.target.value)}>
              {MESHY_TEXTURE_MODEL_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          {!isN1 && (
            <>
              <div className="params-card__field">
                <label className="params-card__label font-label">PBR</label>
                <Checkbox checked={Boolean(value('meshyEnablePbr'))} onToggle={() => onChange('meshyEnablePbr', !value('meshyEnablePbr'))} label="Metallic, roughness and normal maps" />
              </div>

              <div className="params-card__field">
                <label className="params-card__label font-label">Texture Prompt (Optional)</label>
                <input
                  type="text"
                  maxLength={800}
                  className={inputClassName}
                  value={value('meshyTexturePrompt')}
                  onChange={event => onChange('meshyTexturePrompt', event.target.value)}
                />
              </div>
            </>
          )}
        </>
      )}

      {!isSmartTopology && (
        <div className="params-card__field">
          <label className="params-card__label font-label">Remesh</label>
          <Checkbox checked={shouldRemesh} onToggle={() => onChange('meshyShouldRemesh', !shouldRemesh)} label="Remesh to the target polycount" />
        </div>
      )}

      {shouldRemesh && (
        <div className="params-card__field">
          <label className="params-card__label font-label">Topology</label>
          <select className={selectClassName} value={value('meshyTopology')} onChange={event => onChange('meshyTopology', event.target.value)}>
            {MESHY_TOPOLOGY_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      )}

      {(isSmartTopology || shouldRemesh) && (
        <div className="params-card__field">
          <label className="params-card__label font-label">Target Polycount</label>
          <input
            type="number"
            min="100"
            max={maxPolycount}
            className={inputClassName}
            value={value('meshyTargetPolycount')}
            onChange={event => onChange('meshyTargetPolycount', event.target.value)}
          />
        </div>
      )}

      <p className="image-card__param-hint">
        Meshy generates a GLB from an image (2-4 views in the Workspace multi-view tab). About {estimateMeshyCredits(aiModel, shouldTexture)} credits per run.
        {isSmartTopology ? ' Smart Topology models take a single image only.' : ''}
      </p>
    </>
  )
}
