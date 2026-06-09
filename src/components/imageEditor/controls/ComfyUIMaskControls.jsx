// AI → "Mask + ComfyUI" control panel: paint a mask, then run a workflow on the
// masked region. Presentational.
import { getValueType } from '../../../utils/imageEditorCanvas'
import WorkflowSelect from './WorkflowSelect'
import WorkflowImageInputs from './WorkflowImageInputs'
import WorkflowParameterField from './WorkflowParameterField'

export default function ComfyUIMaskControls({
  workflow,
  mask,
  onChangeImageParamSource,
  onBrowseAsset,
  onChooseFile,
  onClearMask,
  onRun
}) {
  const {
    workflows,
    workflowLoading,
    selectedWorkflowId,
    setSelectedWorkflowId,
    selectedWorkflow,
    workflowValues,
    onWorkflowValueChange,
    imageParamSources,
    aiRunning,
    setAsDefault,
    onToggleSetAsDefault
  } = workflow

  const { maskMode, setMaskMode, maskSize, setMaskSize, maskHardness, setMaskHardness, maskHasPixels } = mask

  const allParameters = selectedWorkflow?.parameters || []
  const imageParameters = allParameters.filter(parameter => getValueType(parameter) === 'image')
  const nonImageParameters = allParameters.filter(parameter => getValueType(parameter) !== 'image')

  return (
    <div className="image-editor-controls">
      <div className="image-editor-toggle-row">
        <button
          type="button"
          className={`image-editor-toggle ${maskMode === 'paint' ? 'image-editor-toggle--active' : ''}`}
          onClick={() => setMaskMode('paint')}
        >
          Paint Mask
        </button>
        <button
          type="button"
          className={`image-editor-toggle ${maskMode === 'erase' ? 'image-editor-toggle--active' : ''}`}
          onClick={() => setMaskMode('erase')}
        >
          Erase Mask
        </button>
      </div>

      <label className="image-editor-label">
        Mask Size
        <input
          className="image-editor-input"
          type="range"
          min="4"
          max="360"
          value={maskSize}
          onChange={event => setMaskSize(Number(event.target.value))}
        />
      </label>

      <label className="image-editor-label">
        Mask Hardness
        <input
          className="image-editor-input"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={maskHardness}
          onChange={event => setMaskHardness(Number(event.target.value))}
        />
      </label>

      <button type="button" className="image-editor-btn" onClick={onClearMask}>
        Clear Mask
      </button>

      <WorkflowSelect
        workflows={workflows}
        selectedWorkflowId={selectedWorkflowId}
        onChange={setSelectedWorkflowId}
        disabled={workflowLoading || workflows.length === 0}
      />

      {selectedWorkflow && (
        <WorkflowImageInputs
          parameters={imageParameters}
          imageParamSources={imageParamSources}
          allowMask
          onChangeSource={onChangeImageParamSource}
          onBrowseAsset={onBrowseAsset}
          onChooseFile={onChooseFile}
        />
      )}

      {nonImageParameters.map(parameter => (
        <WorkflowParameterField
          key={parameter.id}
          parameter={parameter}
          value={workflowValues[parameter.id]}
          onChange={onWorkflowValueChange}
        />
      ))}

      {selectedWorkflow && nonImageParameters.length > 0 && (
        <label className="image-editor-label image-editor-label--checkbox">
          <input
            type="checkbox"
            checked={Boolean(setAsDefault)}
            onChange={event => onToggleSetAsDefault?.(event.target.checked)}
          />
          <span>Set as default</span>
        </label>
      )}

      <button
        type="button"
        className="image-editor-btn image-editor-btn--primary"
        disabled={aiRunning || !selectedWorkflow || !maskHasPixels}
        onClick={onRun}
      >
        {aiRunning ? 'Running...' : 'Run ComfyUI'}
      </button>

      {!maskHasPixels && <p className="image-editor-help">Paint a mask region before running AI.</p>}
    </div>
  )
}
