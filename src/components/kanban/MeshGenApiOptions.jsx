import {
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
  getHitemResolutionOptions,
  isHitemMeshGenerationApi,
  isTencentMeshGenerationApi,
  isTripoMeshGenerationApi,
  isTripoPSeriesModel
} from '../../utils/kanbanHelpers'

// Provider-specific mesh generation fields (Tencent Cloud / Tripo AI / Hitem3D).
// Shared between the per-card action menu and the "Add New Mesh" draft.
// `draft` holds the current option values; `onChange(field, value)` mutates them.
export default function MeshGenApiOptions({ draft, onChange }) {
  const selectedApi = draft?.selectedApi
  const isTencent = isTencentMeshGenerationApi(selectedApi)
  const isTripo = isTripoMeshGenerationApi(selectedApi)
  const isHitem = isHitemMeshGenerationApi(selectedApi)
  const isTripoPModel = isTripo && isTripoPSeriesModel(draft?.modelVersion || 'v3.1-20260211')

  if (isTencent) {
    return (
      <>
        <div className="params-card__field">
          <label className="params-card__label font-label">Region</label>
          <select
            className="image-card__attribute-select"
            value={draft.region}
            onChange={event => onChange('region', event.target.value)}
          >
            {TENCENT_REGION_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Model</label>
          <select
            className="image-card__attribute-select"
            value={draft.modelVersion}
            onChange={event => onChange('modelVersion', event.target.value)}
          >
            {TENCENT_MODEL_VERSION_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Generation Type</label>
          <select
            className="image-card__attribute-select"
            value={draft.generationType}
            onChange={event => onChange('generationType', event.target.value)}
          >
            {TENCENT_GENERATION_TYPE_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        {draft.generationType === 'LowPoly' && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Polygon Type</label>
            <select
              className="image-card__attribute-select"
              value={draft.polygonType}
              onChange={event => onChange('polygonType', event.target.value)}
            >
              {TENCENT_POLYGON_TYPE_OPTIONS.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        <div className="params-card__field">
          <label className="params-card__label font-label">Face Count</label>
          <input
            type="number"
            min="3000"
            max="1500000"
            className="params-card__input"
            value={draft.faceCount}
            onChange={event => onChange('faceCount', event.target.value)}
          />
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Enable PBR</label>
          <label className="params-card__checkbox-label">
            <div className={`params-card__checkbox ${draft.enablePBR ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('enablePBR', !draft.enablePBR)}>
              {draft.enablePBR && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>Generate a PBR-ready mesh</span>
          </label>
        </div>

        <p className="image-card__param-hint">Provide either a prompt or an image source for Tencent Cloud mesh generation.</p>
      </>
    )
  }

  if (isTripo) {
    return (
      <>
        <div className="params-card__field">
          <label className="params-card__label font-label">Model</label>
          <select
            className="image-card__attribute-select"
            value={draft.modelVersion || 'v3.1-20260211'}
            onChange={event => onChange('modelVersion', event.target.value)}
          >
            {TRIPO_MODEL_VERSION_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Model Seed (Optional)</label>
          <input
            type="number"
            className="params-card__input"
            value={draft.modelSeed ?? ''}
            onChange={event => onChange('modelSeed', event.target.value)}
          />
        </div>

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Enable Image Autofix</label>
            <label className="params-card__checkbox-label">
              <div className={`params-card__checkbox ${draft.enableImageAutofix ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('enableImageAutofix', !draft.enableImageAutofix)}>
                {draft.enableImageAutofix && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
              </div>
              <span>Fix input image before generation</span>
            </label>
          </div>
        )}

        <div className="params-card__field">
          <label className="params-card__label font-label">Face Limit (Optional)</label>
          <input
            type="number"
            min="1000"
            max="300000"
            className="params-card__input"
            value={draft.faceLimit ?? ''}
            onChange={event => onChange('faceLimit', event.target.value)}
          />
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Texture</label>
          <label className="params-card__checkbox-label">
            <div className={`params-card__checkbox ${draft.texture ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('texture', !draft.texture)}>
              {draft.texture && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>Generate texture maps</span>
          </label>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">PBR</label>
          <label className="params-card__checkbox-label">
            <div className={`params-card__checkbox ${draft.pbr ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('pbr', !draft.pbr)}>
              {draft.pbr && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>Export PBR model</span>
          </label>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Texture Seed (Optional)</label>
          <input
            type="number"
            className="params-card__input"
            value={draft.textureSeed ?? ''}
            onChange={event => onChange('textureSeed', event.target.value)}
          />
        </div>

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Texture Alignment</label>
            <select
              className="image-card__attribute-select"
              value={draft.textureAlignment || 'original_image'}
              onChange={event => onChange('textureAlignment', event.target.value)}
            >
              {TRIPO_TEXTURE_ALIGNMENT_OPTIONS.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        <div className="params-card__field">
          <label className="params-card__label font-label">Texture Quality</label>
          <select
            className="image-card__attribute-select"
            value={draft.textureQuality || 'standard'}
            onChange={event => onChange('textureQuality', event.target.value)}
          >
            {TRIPO_TEXTURE_QUALITY_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Auto Size</label>
          <label className="params-card__checkbox-label">
            <div className={`params-card__checkbox ${draft.autoSize ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('autoSize', !draft.autoSize)}>
              {draft.autoSize && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>Auto fit scale</span>
          </label>
        </div>

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Orientation</label>
            <select
              className="image-card__attribute-select"
              value={draft.orientation || 'default'}
              onChange={event => onChange('orientation', event.target.value)}
            >
              {TRIPO_ORIENTATION_OPTIONS.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Quad</label>
            <label className="params-card__checkbox-label">
              <div className={`params-card__checkbox ${draft.quad ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('quad', !draft.quad)}>
                {draft.quad && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
              </div>
              <span>Generate quad mesh</span>
            </label>
          </div>
        )}

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Smart Low Poly</label>
            <label className="params-card__checkbox-label">
              <div className={`params-card__checkbox ${draft.smartLowPoly ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('smartLowPoly', !draft.smartLowPoly)}>
                {draft.smartLowPoly && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
              </div>
              <span>Optimize for low poly</span>
            </label>
          </div>
        )}

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Generate Parts</label>
            <label className="params-card__checkbox-label">
              <div className={`params-card__checkbox ${draft.generateParts ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('generateParts', !draft.generateParts)}>
                {draft.generateParts && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
              </div>
              <span>Split into semantic parts</span>
            </label>
          </div>
        )}

        <div className="params-card__field">
          <label className="params-card__label font-label">Export UV</label>
          <label className="params-card__checkbox-label">
            <div className={`params-card__checkbox ${draft.exportUv ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('exportUv', !draft.exportUv)}>
              {draft.exportUv && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>Include UVs in output</span>
          </label>
        </div>

        {!isTripoPModel && (
          <div className="params-card__field">
            <label className="params-card__label font-label">Geometry Quality</label>
            <select
              className="image-card__attribute-select"
              value={draft.geometryQuality || 'standard'}
              onChange={event => onChange('geometryQuality', event.target.value)}
            >
              {TRIPO_GEOMETRY_QUALITY_OPTIONS.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        )}

        {!isTripoPModel && draft.generateParts && (draft.texture || draft.pbr || draft.quad) && (
          <p className="image-card__param-hint">generate_parts is not compatible with texture, pbr, or quad.</p>
        )}

        <p className="image-card__param-hint">Provide either a prompt or an image source for Tripo AI mesh generation.</p>
      </>
    )
  }

  if (isHitem) {
    const hitemModel = HITEM_MODEL_VERSION_OPTIONS.includes(draft?.hitemModel) ? draft.hitemModel : 'hitem3dv2.1'
    const resolutionOptions = getHitemResolutionOptions(hitemModel)

    return (
      <>
        <div className="params-card__field">
          <label className="params-card__label font-label">Model</label>
          <select
            className="image-card__attribute-select"
            value={hitemModel}
            onChange={event => onChange('hitemModel', event.target.value)}
          >
            {HITEM_MODEL_VERSION_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Resolution</label>
          <select
            className="image-card__attribute-select"
            value={resolutionOptions.includes(draft?.hitemResolution) ? draft.hitemResolution : resolutionOptions[0]}
            onChange={event => onChange('hitemResolution', event.target.value)}
          >
            {resolutionOptions.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Generation Type</label>
          <select
            className="image-card__attribute-select"
            value={Number(draft?.hitemRequestType) || 3}
            onChange={event => onChange('hitemRequestType', Number(event.target.value))}
          >
            {HITEM_REQUEST_TYPE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Face Count</label>
          <input
            type="number"
            min={HITEM_FACE_MIN}
            max={HITEM_FACE_MAX}
            step="10000"
            className="params-card__input"
            value={draft?.hitemFace ?? 300000}
            onChange={event => onChange('hitemFace', event.target.value)}
          />
        </div>

        <div className="params-card__field">
          <label className="params-card__label font-label">Enable PBR</label>
          <label className="params-card__checkbox-label">
            <div className={`params-card__checkbox ${draft?.hitemPbr ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => onChange('hitemPbr', !draft?.hitemPbr)}>
              {draft?.hitemPbr && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>Generate a PBR-ready mesh</span>
          </label>
        </div>

        <p className="image-card__param-hint">Hitem3D generates a mesh from an image source (GLB output).</p>
      </>
    )
  }

  return null
}
