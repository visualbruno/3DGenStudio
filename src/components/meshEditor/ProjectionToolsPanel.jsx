import { getWorkflowValueType } from '../../utils/meshTexturing'

// Projection-mode left panel (projection setup, AI workflow + image-input
// config) extracted from MeshEditorPage.jsx. Presentational: state + handlers
// in via props.
export default function ProjectionToolsPanel({
  projectionTextureSize,
  setProjectionTextureSize,
  projectionStarted,
  projecting,
  projectionKeepTexture,
  projectionViewResolution,
  setProjectionViewResolution,
  projectionBlendPixels,
  setProjectionBlendPixels,
  texturingUnavailableReason,
  projectionRebuilding,
  handleStartProjectionSession,
  handleRunProjectionWorkflow,
  projectionReady,
  comfyLoading,
  projectionWorkflowId,
  setProjectionWorkflowId,
  projectionWorkflows,
  selectedProjectionWorkflow,
  projectionImageParamSources,
  handleProjectionImageParamSourceChange,
  setPendingAssetParamId,
  setPendingAssetSelectorMode,
  setShowAssetSelector,
  projectionWorkflowParameters,
  projectionWorkflowInputs,
  setProjectionWorkflowInputs,
  projectionSetAsDefault,
  setProjectionSetAsDefault
}) {
  return (
    <>{/* PROJECTION */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Projection setup</span>
        <label className="mesh-editor-range-field">
          <span>Texture size</span>
          <input
            type="range"
            min="512"
            max="4096"
            step="256"
            value={projectionTextureSize}
            onChange={event => setProjectionTextureSize(Number(event.target.value))}
            disabled={projectionStarted || projecting || projectionKeepTexture}
          />
          <strong>{projectionTextureSize}px</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Position view resolution</span>
          <input
            type="range"
            min="512"
            max="2048"
            step="128"
            value={projectionViewResolution}
            onChange={event => setProjectionViewResolution(Number(event.target.value))}
            disabled={projecting}
          />
          <strong>{projectionViewResolution}px</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Blend overlap</span>
          <input
            type="range"
            min="0"
            max="64"
            step="1"
            value={projectionBlendPixels}
            onChange={event => setProjectionBlendPixels(Number(event.target.value))}
            disabled={!projectionStarted || projecting}
          />
          <strong>{projectionBlendPixels}px</strong>
        </label>

        <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--secondary"
            onClick={handleStartProjectionSession}
            disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
          >
            <span className="material-symbols-outlined">refresh</span>
            <span>{projectionStarted ? 'Restart' : 'Start'}</span>
          </button>
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--primary"
            onClick={handleRunProjectionWorkflow}
            disabled={!projectionReady || !projectionStarted || projecting || comfyLoading || projectionRebuilding}
          >
            <span className="material-symbols-outlined">play_arrow</span>
            <span>{projecting ? 'Projecting…' : 'Project view'}</span>
          </button>
        </div>
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">AI workflow</span>
        <select
          className="mesh-editor-panel__input mesh-editor-panel__select"
          value={projectionWorkflowId}
          onChange={event => setProjectionWorkflowId(event.target.value)}
          disabled={comfyLoading || projectionWorkflows.length === 0 || !!texturingUnavailableReason || projecting}
        >
          {projectionWorkflows.length === 0 ? (
            <option value="">No compatible ComfyUI workflow found</option>
          ) : (
            projectionWorkflows.map(workflow => (
              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
            ))
          )}
        </select>

        {selectedProjectionWorkflow && (
          <div className="mesh-editor-panel__section">
            <span className="mesh-editor-panel__section-title">Image Inputs Configuration</span>
            {(selectedProjectionWorkflow.parameters || [])
              .filter(input => getWorkflowValueType(input) === 'image')
              .map(param => {
                const config = projectionImageParamSources[param.id] || { type: 'none' }
                return (
                  <div key={param.id} className="mesh-editor-workflow-field">
                    <span>{param.name}</span>
                    <select
                      className="mesh-editor-panel__input mesh-editor-panel__select"
                      value={config.type}
                      onChange={(e) => handleProjectionImageParamSourceChange(param.id, e.target.value)}
                      disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                    >
                      <option value="none">— Not used —</option>
                      <option value="position-view">Use as Position View</option>
                      <option value="textured-view">Use as Textured View</option>
                      <option value="untextured-view">Use as Untextured View</option>
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
                            setPendingAssetParamId(param.id)
                            setPendingAssetSelectorMode('projection')
                            setShowAssetSelector(true)
                          }}
                          disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
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
                              const file = e.target.files?.[0]
                              if (file) {
                                handleProjectionImageParamSourceChange(param.id, 'file', file)
                              }
                            }}
                            disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        )}

        {projectionWorkflowParameters.map(parameter => {
          const valueType = getWorkflowValueType(parameter)
          const currentValue = projectionWorkflowInputs?.[parameter.id]

          return (
            <label key={parameter.id} className="mesh-editor-workflow-field">
              <span>{parameter.name}</span>
              {valueType === 'boolean' ? (
                <button
                  type="button"
                  className={`mesh-editor-toggle ${currentValue ? 'mesh-editor-toggle--active' : ''}`}
                  onClick={() => setProjectionWorkflowInputs(current => ({
                    ...current,
                    [parameter.id]: !currentValue
                  }))}
                  disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                >
                  {currentValue ? 'Enabled' : 'Disabled'}
                </button>
              ) : valueType === 'string' ? (
                <textarea
                  className="mesh-editor-panel__input mesh-editor-panel__textarea"
                  value={currentValue ?? ''}
                  onChange={event => setProjectionWorkflowInputs(current => ({
                    ...current,
                    [parameter.id]: event.target.value
                  }))}
                  disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                />
              ) : (
                <input
                  type="number"
                  className="mesh-editor-panel__input"
                  value={currentValue ?? ''}
                  onChange={event => setProjectionWorkflowInputs(current => ({
                    ...current,
                    [parameter.id]: event.target.value === '' ? '' : Number(event.target.value)
                  }))}
                  disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                />
              )}
            </label>
          )
        })}

        {projectionWorkflowParameters.length > 0 && (
          <label className="mesh-editor-workflow-field mesh-editor-workflow-field--checkbox">
            <span>Set as default</span>
            <input
              type="checkbox"
              checked={!!projectionSetAsDefault}
              onChange={event => setProjectionSetAsDefault?.(event.target.checked)}
              disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
            />
          </label>
        )}
      </div>

      <div className="mesh-editor-panel__notes">
        {texturingUnavailableReason ? (
          <span className="mesh-editor-panel__hint">{texturingUnavailableReason}</span>
        ) : (
          <>
            <span className="mesh-editor-panel__hint">Start clears the working texture to transparent and initializes projection coverage.</span>
            <span className="mesh-editor-panel__hint">Position View is a square screenshot from the current camera. Projection fills uncovered texels first.</span>
            <span className="mesh-editor-panel__hint">Blend overlap controls the transition zone at the projected border.</span>
            <span className="mesh-editor-panel__hint">Crop border trims the alpha silhouette border of each projected view before reprojection.</span>
            {projectionRebuilding && <span className="mesh-editor-panel__hint">Rebuilding projection stack...</span>}
          </>
        )}
      </div>
    </>
  )
}
