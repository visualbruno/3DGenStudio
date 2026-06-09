import { getWorkflowValueType } from '../../utils/meshTexturing'

// Texturing-mode left panel (brush/crop/feather, AI workflow + image-input
// config, patch review sliders) extracted from MeshEditorPage.jsx.
// Presentational: state + handlers in via props.
export default function TexturingToolsPanel({
  brushSize,
  setBrushSize,
  cropPadding,
  setCropPadding,
  featherRadius,
  setFeatherRadius,
  multiViewCount,
  setMultiViewCount,
  texturingUnavailableReason,
  pendingPatch,
  texturing,
  handleClearTextureMask,
  textureWorkflowId,
  setTextureWorkflowId,
  comfyLoading,
  texturingWorkflows,
  selectedTextureWorkflow,
  imageParamSources,
  handleImageParamSourceChange,
  setPendingAssetParamId,
  setPendingAssetSelectorMode,
  setShowAssetSelector,
  textureWorkflowParameters,
  textureWorkflowInputs,
  handleTextureWorkflowInputChange,
  projectionOpacities,
  setProjectionOpacities,
  patchNoise,
  setPatchNoise,
  patchSharpness,
  setPatchSharpness,
  patchSaturation,
  setPatchSaturation,
  handleApplyPatch,
  handleCancelPatch,
  handleRunTextureWorkflow,
  texturingReady,
  textureSetAsDefault,
  setTextureSetAsDefault
}) {
  return (
    <>{/* TEXTURING */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Brush</span>
        <label className="mesh-editor-range-field">
          <span>Size</span>
          <input type="range" min="4" max="96" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
          <strong>{brushSize}px</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Crop margin</span>
          <input type="range" min="0" max="256" value={cropPadding} onChange={event => setCropPadding(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
          <strong>{cropPadding}px</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Feather</span>
          <input type="range" min="0" max="32" value={featherRadius} onChange={event => setFeatherRadius(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
          <strong>{featherRadius}px</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Projection views <em className="mesh-editor-range-field__sub">(coverage vs speed)</em></span>
          <input
            type="range" min="1" max="7" step="1"
            value={multiViewCount}
            onChange={e => setMultiViewCount(Number(e.target.value))}
            disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
          />
          <strong>{multiViewCount} {multiViewCount === 1 ? 'view (current)' : `views (±${(multiViewCount - 1) * 30}°)`}</strong>
        </label>
        <button type="button" className="mesh-editor-btn mesh-editor-btn--ghost" onClick={handleClearTextureMask} disabled={!!texturingUnavailableReason || !!pendingPatch}>Clear mask</button>
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">AI workflow</span>
        <select
          className="mesh-editor-panel__input mesh-editor-panel__select"
          value={textureWorkflowId}
          onChange={event => setTextureWorkflowId(event.target.value)}
          disabled={comfyLoading || texturingWorkflows.length === 0 || !!texturingUnavailableReason || !!pendingPatch}
        >
          {texturingWorkflows.length === 0 ? (
            <option value="">No 2-image ComfyUI workflow found</option>
          ) : (
            texturingWorkflows.map(workflow => (
              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
            ))
          )}
        </select>

        {selectedTextureWorkflow && (
          <div className="mesh-editor-panel__section">
            <span className="mesh-editor-panel__section-title">Image Inputs Configuration</span>
            {(selectedTextureWorkflow.parameters || [])
              .filter(input => getWorkflowValueType(input) === 'image')
              .map(param => {
                const config = imageParamSources[param.id] || { type: 'none' };
                return (
                  <div key={param.id} className="mesh-editor-workflow-field">
                    <span>{param.name}</span>
                    <select
                      className="mesh-editor-panel__input mesh-editor-panel__select"
                      value={config.type}
                      onChange={(e) => handleImageParamSourceChange(param.id, e.target.value)}
                      disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                    >
                      <option value="none">— Not used —</option>
                      <option value="source">Use as source image (painted mesh view)</option>
                      <option value="mask">Use as mask image (painted mask)</option>
                      <option value="asset">From assets</option>
                      <option value="file">From computer</option>
                    </select>
                    {config.type === 'asset' && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                        <span className="mesh-editor-panel__hint" style={{ flex: 1 }}>{config.assetName || 'No asset selected'}</span>
                        <button
                          type="button"
                          className="mesh-editor-btn mesh-editor-btn--ghost"
                          onClick={() => {
                            setPendingAssetParamId(param.id);
                            setPendingAssetSelectorMode('texturing');
                            setShowAssetSelector(true);
                          }}
                          disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                        >
                          Browse
                        </button>
                      </div>
                    )}
                    {config.type === 'file' && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                        <span className="mesh-editor-panel__hint" style={{ flex: 1 }}>{config.fileName || 'No file chosen'}</span>
                        <label className="mesh-editor-btn mesh-editor-btn--ghost" style={{ cursor: 'pointer' }}>
                          Choose file
                          <input
                            type="file"
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                handleImageParamSourceChange(param.id, 'file', file);
                              }
                            }}
                            disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {textureWorkflowParameters.map(parameter => {
          const valueType = getWorkflowValueType(parameter)
          const currentValue = textureWorkflowInputs?.[parameter.id]

          return (
            <label key={parameter.id} className="mesh-editor-workflow-field">
              <span>{parameter.name}</span>
              {valueType === 'boolean' ? (
                <button
                  type="button"
                  className={`mesh-editor-toggle ${currentValue ? 'mesh-editor-toggle--active' : ''}`}
                  onClick={() => handleTextureWorkflowInputChange(parameter, !currentValue)}
                  disabled={!!texturingUnavailableReason || !!pendingPatch}
                >
                  {currentValue ? 'Enabled' : 'Disabled'}
                </button>
              ) : valueType === 'string' ? (
                <textarea
                  className="mesh-editor-panel__input mesh-editor-panel__textarea"
                  value={currentValue ?? ''}
                  onChange={event => handleTextureWorkflowInputChange(parameter, event.target.value)}
                  disabled={!!texturingUnavailableReason || !!pendingPatch}
                />
              ) : (
                <input
                  type="number"
                  className="mesh-editor-panel__input"
                  value={currentValue ?? ''}
                  onChange={event => handleTextureWorkflowInputChange(parameter, event.target.value)}
                  disabled={!!texturingUnavailableReason || !!pendingPatch}
                />
              )}
            </label>
          )
        })}

        {pendingPatch ? (
          <div className="mesh-editor-patch-preview">
            <span className="mesh-editor-panel__section-title mesh-editor-patch-preview__title">
              <span className="material-symbols-outlined">tune</span>
              Review patch
            </span>
            <div className="mesh-editor-panel__section mesh-editor-panel__section--nested">
              <span className="mesh-editor-panel__section-title">Projection opacity</span>
              {projectionOpacities.slice(0, multiViewCount).map((value, index) => (
                <label key={`projection-opacity-${index}`} className="mesh-editor-range-field">
                  <span>{index === 0 ? 'Current view' : `View ${index + 1}`}</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={value}
                    onChange={event => {
                      const nextValue = Number(event.target.value)
                      setProjectionOpacities(current => current.map((item, itemIndex) => (itemIndex === index ? nextValue : item)))
                    }}
                  />
                  <strong>{Math.round(value * 100)}%</strong>
                </label>
              ))}
            </div>
            <label className="mesh-editor-range-field">
              <span>Noise <em className="mesh-editor-range-field__sub">(Prevent Seams)</em></span>
              <input
                type="range"
                min="0"
                max="32"
                step="1"
                value={patchNoise}
                onChange={event => setPatchNoise(Number(event.target.value))}
              />
              <strong>{patchNoise}</strong>
            </label>
            <label className="mesh-editor-range-field">
              <strong>Sharpness</strong>
              <input
                type="range"
                min="0"
                max="2"
                step="0.01"
                value={patchSharpness}
                onChange={(e) => setPatchSharpness(parseFloat(e.target.value))}
              />
              <strong>{patchSharpness}</strong>
            </label>
            <label className="mesh-editor-range-field">
              <strong>Saturation</strong>
              <input
                type="range"
                min="0"
                max="2"
                step="0.01"
                value={patchSaturation}
                onChange={(e) => setPatchSaturation(parseFloat(e.target.value))}
              />
              <strong>{patchSaturation}</strong>
            </label>
            <div className="mesh-editor-actions mesh-editor-patch-preview__actions">
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--primary"
                onClick={handleApplyPatch}
              >
                <span className="material-symbols-outlined">check</span>
                Apply
              </button>
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--ghost"
                onClick={handleCancelPatch}
              >
                <span className="material-symbols-outlined">close</span>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {textureWorkflowParameters.length > 0 && (
              <label className="mesh-editor-workflow-field mesh-editor-workflow-field--checkbox">
                <span>Set as default</span>
                <input
                  type="checkbox"
                  checked={!!textureSetAsDefault}
                  onChange={event => setTextureSetAsDefault?.(event.target.checked)}
                />
              </label>
            )}
            <button type="button" className="mesh-editor-btn mesh-editor-btn--primary" onClick={handleRunTextureWorkflow} disabled={!texturingReady || texturing || comfyLoading}>
              {texturing ? 'Regenerating…' : 'Regenerate zone'}
            </button>
          </>
        )}
      </div>

      <div className="mesh-editor-panel__notes">
        {texturingUnavailableReason ? (
          <span className="mesh-editor-panel__hint">{texturingUnavailableReason}</span>
        ) : (
          <>
            <span className="mesh-editor-panel__hint">Paint directly on the mesh view, then run a 2-image ComfyUI inpaint workflow.</span>
            <span className="mesh-editor-panel__hint">The editor now sends a camera-view mask to AI and reprojects the generated patch back onto the texture.</span>
            <span className="mesh-editor-panel__hint">The camera stays locked while a paint mask exists. Clear the mask to orbit again.</span>
          </>
        )}
      </div>
    </>
  )
}
