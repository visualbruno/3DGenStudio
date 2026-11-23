// PBR mode left panel. Derives normal / roughness / metalness / AO (and a
// height map for download) from the mesh's own albedo texture — no AI model,
// image filters only (utils/pbrFromAlbedo.js, ported from
// ComfyUI-PBR-Material-Generator, Apache-2.0).
//
// Flow: Preview attaches low-resolution maps to the viewport only (the mesh is
// untouched, sliders re-run it live); Apply recomputes at the texture's full
// resolution and attaches the maps to the material, so they travel with save
// and export; Revert undoes the last Apply.
// Presentational: state + handlers come from MeshEditorPage.
import { RangeField, ToggleField } from './MeshToolField'

const MAP_ORDER = [
  { key: 'normal', label: 'Normal' },
  { key: 'roughness', label: 'Roughness' },
  { key: 'metalness', label: 'Metalness' },
  { key: 'ao', label: 'Ambient occlusion' },
]

const THUMB_ORDER = [
  { key: 'baseColor', label: 'Base colour' },
  { key: 'normal', label: 'Normal' },
  { key: 'roughness', label: 'Roughness' },
  { key: 'metalness', label: 'Metalness' },
  { key: 'ao', label: 'AO' },
  { key: 'height', label: 'Height' },
]

export default function PbrToolsPanel({
  options,
  setOption,
  previewing,
  busy,
  thumbnails,
  previewSize,
  textureSize,
  existingMaps = [],
  shadingHidesMaps = false,
  onPreview,
  onApply,
  onDiscard,
  onDownload,
  canRevert,
  onRevert,
  unavailableReason = '',
}) {
  const o = options
  const disabled = !!unavailableReason
  const fieldsDisabled = disabled || (busy && !previewing)
  const maps = o.maps || {}
  const anyMap = MAP_ORDER.some(entry => maps[entry.key])

  const setMap = (key, on) => setOption('maps', { ...maps, [key]: on })

  return (
    <>{/* PBR */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">PBR from albedo</span>
        <span className="mesh-editor-panel__hint">
          Estimates normal, roughness, metalness and ambient occlusion from the colour texture
          alone, treating brightness as height. Fast and offline, but it is a guess: dark paint
          reads as a dent. It suits stone, wood, fabric and worn surfaces more than clean
          painted ones.
        </span>

        {unavailableReason && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>{unavailableReason}</span>
        )}

        {!unavailableReason && existingMaps.length > 0 && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
            This mesh already has {existingMaps.join(', ')}. Applying replaces {existingMaps.length === 1 ? 'it' : 'them'};
            maps you switch off below are left as they are.
          </span>
        )}

        {!previewing ? (
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--primary"
            onClick={onPreview}
            disabled={disabled || busy || (!anyMap && !(o.delightStrength > 0))}
            title="Generate the maps at preview resolution and show them on the mesh — nothing is changed until you apply"
          >
            <span className="material-symbols-outlined">{busy ? 'progress_activity' : 'auto_awesome'}</span>
            <span>{busy ? 'Generating…' : 'Preview PBR maps'}</span>
          </button>
        ) : (
          <>
            <div className="mesh-editor-actions">
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--primary"
                onClick={onApply}
                disabled={busy}
                title={`Recompute at the full ${textureSize}px and attach the maps to the material`}
              >
                <span className="material-symbols-outlined">{busy ? 'progress_activity' : 'done_all'}</span>
                <span>Apply to mesh</span>
              </button>
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--secondary"
                onClick={onDiscard}
                disabled={busy}
                title="Drop the preview and leave the mesh as it was"
              >
                <span className="material-symbols-outlined">close</span>
                <span>Discard</span>
              </button>
            </div>
            <span className="mesh-editor-panel__hint">
              Previewing at {previewSize}px{previewSize < textureSize ? ` (the texture is ${textureSize}px — Apply recomputes at full size)` : ''}.
              The sliders update the viewport live.
              {shadingHidesMaps ? ' The viewport shading is not PBR, which hides these maps — switch it back with the shading button above the viewport.' : ''}
            </span>
          </>
        )}

        {canRevert && !previewing && (
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--secondary"
            onClick={onRevert}
            disabled={busy}
            title="Restore the material (and albedo) to what it was before the last Apply"
          >
            <span className="material-symbols-outlined">undo</span>
            <span>Revert last apply</span>
          </button>
        )}
      </div>

      {thumbnails && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Maps</span>
          <div className="mesh-editor-bake-grid">
            {THUMB_ORDER.filter(entry => thumbnails[entry.key]).map(entry => (
              <figure className="mesh-editor-bake-map" key={entry.key}>
                <img src={thumbnails[entry.key]} alt={entry.label} />
                <figcaption>{entry.label}</figcaption>
              </figure>
            ))}
          </div>
          <button
            type="button"
            className="mesh-editor-btn"
            onClick={onDownload}
            disabled={busy}
            title={`Download every map as a PNG at ${textureSize}px — includes the height map, which glTF has no slot for`}
          >
            <span className="material-symbols-outlined">download</span>
            <span>Download maps (.zip)</span>
          </button>
        </div>
      )}

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Generate</span>
        {MAP_ORDER.map(entry => (
          <label className="mesh-editor-workflow-field mesh-editor-workflow-field--checkbox" key={entry.key}>
            <input
              type="checkbox"
              checked={!!maps[entry.key]}
              onChange={event => setMap(entry.key, event.target.checked)}
              disabled={fieldsDisabled}
            />
            <span>{entry.label}</span>
          </label>
        ))}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Albedo</span>
        <RangeField label="De-light" min={0} max={1} step={0.05} decimals={2}
          value={o.delightStrength} onChange={v => setOption('delightStrength', v)} disabled={fieldsDisabled}
          hint="Evens out shadows and highlights baked into the colour, so the new AO and lighting are not applied twice. 0 leaves the albedo untouched." />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Height</span>
        <RangeField label="Contrast" min={0.1} max={4} step={0.05} decimals={2}
          value={o.depthContrast} onChange={v => setOption('depthContrast', v)} disabled={fieldsDisabled}
          hint="Spreads brightness differences into a taller relief. Everything below builds on this." />
        <RangeField label="Smoothness" min={0} max={15} step={1}
          value={o.depthSmoothness} onChange={v => setOption('depthSmoothness', v)} disabled={fieldsDisabled}
          hint="Blur radius before the height is used, in pixels of a 1024px texture (scaled to the real size)." />
        <ToggleField label="Invert (dark = raised)" value={!!o.invertDepth}
          onChange={v => setOption('invertDepth', v)} disabled={fieldsDisabled}
          hint="By default bright reads as raised. Invert it for surfaces whose grooves are lighter than the faces, such as mortar between dark bricks." />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Normal</span>
        <RangeField label="Strength" min={0} max={20} step={0.1} decimals={1}
          value={o.normalStrength} onChange={v => setOption('normalStrength', v)} disabled={fieldsDisabled || !maps.normal} />
        <RangeField label="Blur" min={0} max={10} step={1}
          value={o.normalBlur} onChange={v => setOption('normalBlur', v)} disabled={fieldsDisabled || !maps.normal}
          hint="Softens the large-scale shape before the fine detail is mixed back in." />
        <RangeField label="Detail mix" min={0} max={1} step={0.05} decimals={2}
          value={o.detailMix} onChange={v => setOption('detailMix', v)} disabled={fieldsDisabled || !maps.normal}
          hint="How much fine, per-pixel detail from the raw colour is added on top of the shape." />
        <ToggleField label="DirectX (green down)" value={!!o.invertNormalY}
          onChange={v => setOption('invertNormalY', v)} disabled={fieldsDisabled || !maps.normal}
          hint="Off writes the OpenGL convention glTF requires. Only turn this on to download a map for an engine that wants DirectX — a mesh saved with it on will look lit from below." />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Roughness</span>
        <RangeField label="Base" min={0} max={1} step={0.02} decimals={2}
          value={o.roughnessBase} onChange={v => setOption('roughnessBase', v)} disabled={fieldsDisabled || !maps.roughness}
          hint="Roughness at mid height. 0 is mirror-smooth, 1 fully matte." />
        <RangeField label="Contrast" min={0.1} max={4} step={0.05} decimals={2}
          value={o.roughnessContrast} onChange={v => setOption('roughnessContrast', v)} disabled={fieldsDisabled || !maps.roughness} />
        <ToggleField label="Raised areas are smoother" value={!!o.invertRoughness}
          onChange={v => setOption('invertRoughness', v)} disabled={fieldsDisabled || !maps.roughness}
          hint="On: high points read as worn smooth and crevices as rough (the upstream default). Off: the reverse." />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Metalness</span>
        <RangeField label="Strength" min={0} max={1} step={0.05} decimals={2}
          value={o.metalnessStrength} onChange={v => setOption('metalnessStrength', v)} disabled={fieldsDisabled || !maps.metalness}
          hint="0 makes the whole surface non-metal, which is right for most materials." />
        <RangeField label="Threshold" min={0} max={1} step={0.02} decimals={2}
          value={o.metalnessThreshold} onChange={v => setOption('metalnessThreshold', v)} disabled={fieldsDisabled || !maps.metalness || !(o.metalnessStrength > 0)}
          hint="Only areas brighter than this (and not strongly coloured) turn metallic." />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Ambient occlusion</span>
        <RangeField label="Strength" min={0} max={3} step={0.05} decimals={2}
          value={o.aoStrength} onChange={v => setOption('aoStrength', v)} disabled={fieldsDisabled || !maps.ao} />
        <RangeField label="Radius" min={1} max={25} step={1}
          value={o.aoRadius} onChange={v => setOption('aoRadius', v)} disabled={fieldsDisabled || !maps.ao}
          hint="How far a crevice looks for higher ground around it, in pixels of a 1024px texture." />
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">
          Roughness, metalness and AO are packed into one ORM texture, the layout glTF expects. The
          height map has no glTF slot, so it is only in the download.
        </span>
        <span className="mesh-editor-panel__hint">
          Ported from ComfyUI-PBR-Material-Generator by aimpowerment (Apache-2.0).
        </span>
      </div>
    </>
  )
}
