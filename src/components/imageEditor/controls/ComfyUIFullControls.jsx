// AI → "ComfyUI" control panel: runs a workflow on the full composited image.
// Presentational.
import { getValueType } from '../../../utils/imageEditorCanvas'
import WorkflowSelect from './WorkflowSelect'
import WorkflowImageInputs from './WorkflowImageInputs'
import WorkflowParameterField from './WorkflowParameterField'

export default function ComfyUIFullControls({ workflow, onChangeImageParamSource, onBrowseAsset, onChooseFile, onRun }) {
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

  const allParameters = selectedWorkflow?.parameters || []
  const imageParameters = allParameters.filter(parameter => getValueType(parameter) === 'image')
  const nonImageParameters = allParameters.filter(parameter => getValueType(parameter) !== 'image')

  return (
    <div className="image-editor-controls">
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
          allowMask={false}
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
        disabled={aiRunning || !selectedWorkflow}
        onClick={onRun}
      >
        {aiRunning ? 'Running...' : 'Run ComfyUI'}
      </button>

      <p className="image-editor-help">Sends the full composited image to ComfyUI and adds the result as a new layer.</p>
    </div>
  )
}
