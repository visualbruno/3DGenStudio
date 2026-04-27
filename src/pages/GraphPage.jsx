import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useUpdateNodeInternals,
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import Viewer from '../components/Viewer'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext.shared'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import '@xyflow/react/dist/style.css'
import './KanbanPage.css'
import './GraphPage.css'
import AssetSelectorModal from '../components/AssetSelectorModal';

const DEFAULT_OUTPUT_ID = 'output-0'
const DEFAULT_INPUT_ID = 'input-0'
const IMAGE_COMPARE_NODE_TYPE_NAME = 'Image Compare'
const IMAGE_COMPARE_INPUT_IDS = ['input-0', 'input-1']
const LEGACY_INPUT_ID = 'image-input'
const DEFAULT_CUSTOM_API_TYPE = 'image-generation'
const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai_gpt_image_1', name: 'OpenAI · gpt-image-1' },
  { id: 'openai_gpt_image_1_5', name: 'OpenAI · gpt-image-1.5' }
]
const GRAPH_NODE_TYPE_OPTIONS = ['Image', 'Mesh', IMAGE_COMPARE_NODE_TYPE_NAME, 'Number', 'Text', 'Boolean']
const CONNECTOR_TYPE_META = {
  image: { key: 'image', label: 'Image', letter: 'I', color: '#8ff5ff', background: 'rgba(143, 245, 255, 0.14)' },
  mesh: { key: 'mesh', label: 'Mesh', letter: 'M', color: '#ac89ff', background: 'rgba(172, 137, 255, 0.14)' },
  video: { key: 'video', label: 'Video', letter: 'V', color: '#ff9a62', background: 'rgba(255, 154, 98, 0.14)' },
  number: { key: 'number', label: 'Number', letter: 'N', color: '#79e388', background: 'rgba(121, 227, 136, 0.14)' },
  text: { key: 'text', label: 'Text', letter: 'T', color: '#ffd36e', background: 'rgba(255, 211, 110, 0.16)' },
  boolean: { key: 'boolean', label: 'Boolean', letter: 'B', color: '#ff7fc8', background: 'rgba(255, 127, 200, 0.16)' },
  unknown: { key: 'unknown', label: 'Open', letter: '+', color: 'rgba(191, 196, 204, 0.8)', background: 'rgba(191, 196, 204, 0.12)' }
}

function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit', 'mesh-texturing'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE
}

function getNodeKind(nodeTypeName = '') {
  const normalizedNodeType = String(nodeTypeName).trim().toLowerCase()

  if (normalizedNodeType === 'image compare') {
    return 'imageCompare'
  }

  if (['mesh', 'mesh gen'].includes(normalizedNodeType)) {
    return 'meshGen'
  }

  if (['number', 'text', 'boolean'].includes(normalizedNodeType)) {
    return normalizedNodeType
  }

  return 'image'
}

function getDefaultNodeOutputType(nodeTypeName = '') {
  const nodeKind = getNodeKind(nodeTypeName)

  if (nodeKind === 'imageCompare') {
    return null
  }

  if (nodeKind === 'meshGen') {
    return 'mesh'
  }

  if (['number', 'text', 'boolean'].includes(nodeKind)) {
    return nodeKind
  }

  return 'image'
}

function getDefaultNodeOutputValue(nodeTypeName = '') {
  const nodeKind = getNodeKind(nodeTypeName)

  if (nodeKind === 'number') {
    return 0
  }

  if (nodeKind === 'boolean') {
    return false
  }

  return ''
}

function isValueNodeKind(nodeKind = '') {
  return ['number', 'text', 'boolean'].includes(String(nodeKind || '').trim().toLowerCase())
}

function normalizeNodeOutputValue(nodeKind = '', value = null) {
  if (nodeKind === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }

    const normalizedNumber = Number(String(value ?? '').trim())
    return Number.isFinite(normalizedNumber) ? normalizedNumber : 0
  }

  if (nodeKind === 'boolean') {
    return Boolean(value)
  }

  return String(value ?? '')
}

function normalizeConnectorType(type) {
  const normalizedType = String(type || '').trim().toLowerCase()

  if (['image', 'mesh', 'video', 'number', 'boolean'].includes(normalizedType)) {
    return normalizedType
  }

  if (['text', 'string', 'json'].includes(normalizedType)) {
    return 'text'
  }

  return null
}

function getConnectorTypeMeta(type) {
  return CONNECTOR_TYPE_META[normalizeConnectorType(type) || 'unknown']
}

function getNodeOutputType(node) {
  const outputType = normalizeConnectorType(
    node?.data?.metadata?.outputType
    || node?.metadata?.outputType
    || node?.data?.asset?.type
    || node?.asset?.type
  )

  if (outputType) {
    return outputType
  }

  const nodeKind = node?.data?.nodeKind || node?.type

  if (nodeKind === 'meshGen') {
    return 'mesh'
  }

  if (nodeKind === 'image') {
    return 'image'
  }

  if (isValueNodeKind(nodeKind)) {
    return nodeKind
  }

  return null
}

function getInputHandleIndex(handleId) {
  if (handleId === LEGACY_INPUT_ID) {
    return 0
  }

  const match = String(handleId || '').match(/(\d+)$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function compareHandleIds(leftHandleId, rightHandleId) {
  return getInputHandleIndex(leftHandleId) - getInputHandleIndex(rightHandleId)
}

function getNextInputHandleId(usedHandleIds) {
  let nextIndex = 0

  while (usedHandleIds.includes(`input-${nextIndex}`)) {
    nextIndex += 1
  }

  return `input-${nextIndex}`
}

function getConnectorPosition(index, total) {
  const safeTotal = Math.max(total, 1)
  return {
    top: `${((index + 1) / (safeTotal + 1)) * 100}%`
  }
}

function buildInputConnectors(nodeId, currentNodes, currentEdges) {
  const targetNode = currentNodes.find(node => node.id === String(nodeId))

  if (targetNode?.data?.nodeKind === 'imageCompare') {
    return IMAGE_COMPARE_INPUT_IDS.map(handleId => ({
      id: handleId,
      type: 'image',
      isConnected: currentEdges.some(edge => edge.target === String(nodeId) && (edge.targetHandle || DEFAULT_INPUT_ID) === handleId)
    }))
  }

  const incomingEdges = currentEdges
    .filter(edge => edge.target === String(nodeId))
    .sort((leftEdge, rightEdge) => compareHandleIds(leftEdge.targetHandle || DEFAULT_INPUT_ID, rightEdge.targetHandle || DEFAULT_INPUT_ID))

  const usedHandleIds = [...new Set(incomingEdges.map(edge => edge.targetHandle || DEFAULT_INPUT_ID))]
  const usedConnectors = usedHandleIds.map(handleId => {
    const matchingEdge = incomingEdges.find(edge => (edge.targetHandle || DEFAULT_INPUT_ID) === handleId)
    const sourceNode = currentNodes.find(node => node.id === matchingEdge?.source)

    return {
      id: handleId,
      type: getNodeOutputType(sourceNode),
      isConnected: true
    }
  })

  return [
    ...usedConnectors,
    {
      id: getNextInputHandleId(usedHandleIds),
      type: null,
      isConnected: false
    }
  ]
}

function getInputSource(currentNodes, currentEdges, nodeId, expectedType = null) {
  const incomingEdges = currentEdges
    .filter(edge => edge.target === String(nodeId))
    .sort((leftEdge, rightEdge) => compareHandleIds(leftEdge.targetHandle || DEFAULT_INPUT_ID, rightEdge.targetHandle || DEFAULT_INPUT_ID))

  for (const edge of incomingEdges) {
    const sourceNode = currentNodes.find(node => node.id === edge.source)
    const outputType = getNodeOutputType(sourceNode)

    if (!expectedType || outputType === expectedType) {
      return {
        edge,
        sourceNode,
        asset: sourceNode?.data?.asset || null
      }
    }
  }

  return {
    edge: null,
    sourceNode: null,
    asset: null
  }
}

function formatAssetDimensions(width, height) {
  if (!width || !height) {
    return null
  }

  return `${width} × ${height}`
}

function getAssetPreviewUrl(filename) {
  if (!filename) {
    return null
  }

  return `http://localhost:3001/assets/${encodeURI(filename)}`
}

function appendCacheBust(url, cacheKey) {
  if (!url) {
    return null
  }

  return `${url}${url.includes('?') ? '&' : '?'}refresh=${encodeURIComponent(String(cacheKey))}`
}

function buildMeshEditorPath({ asset, projectId, nodeId, returnTo }) {
  const query = new URLSearchParams({
    assetId: String(asset?.id || ''),
    filePath: asset?.filePath || asset?.filename || '',
    url: asset?.filename ? getAssetPreviewUrl(asset.filename) : '',
    name: asset?.name || 'Mesh',
    projectId: String(projectId || ''),
    nodeId: String(nodeId || ''),
    returnTo
  })

  return `/mesh-editor?${query.toString()}`
}

function buildEdgeId(connection) {
  return `edge:${connection.sourceNodeId}:${connection.outputId}:${connection.targetNodeId}:${connection.inputId}`
}

function toFlowEdge(connection) {
  return {
    id: buildEdgeId(connection),
    source: String(connection.sourceNodeId),
    target: String(connection.targetNodeId),
    sourceHandle: connection.outputId || DEFAULT_OUTPUT_ID,
    targetHandle: connection.inputId || DEFAULT_INPUT_ID,
    type: 'deletable',
    animated: true
  }
}

function toBaseFlowNode(node, onDelete) {
  const nodeKind = getNodeKind(node.nodeTypeName)

  return {
    id: String(node.id),
    type: nodeKind,
    position: {
      x: Number(node.xPos) || 0,
      y: Number(node.yPos) || 0
    },
    data: {
      ...node,
      nodeKind,
      onDelete,
      actionDraft: null,
      connectedInputAsset: null,
      imageGenerationApis: [],
      imageEditApis: [],
      imageGenerationWorkflows: [],
      imageEditWorkflows: [],
      libraryImageOptions: [],
      libraryLoading: false,
      comfyLoading: false,
      meshGenerationApis: [],
      meshGenerationWorkflows: [],
      onToggleAction: null,
      onImageModeSelect: null,
      onImageEditModeSelect: null,
      onMeshGenModeSelect: null,
      onDraftFieldChange: null,
      onDraftInputChange: null,
      onRequestLocalFile: null,
      onAttachLibraryAsset: null,
      onRunNodeAction: null,
      onCloseAction: null
    }
  }
}

function getWorkflowParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

function isFileWorkflowValueType(valueType) {
  return ['image', 'video', 'mesh'].includes(valueType)
}

function getWorkflowFileInputAccept(valueType) {
  if (valueType === 'video') return 'video/*'
  if (valueType === 'mesh') return '.glb,.gltf,.obj,.fbx,.stl,.ply,.usdz,.usd,.usda,.usdc'
  return 'image/*'
}

function getWorkflowFileInputIcon(valueType) {
  if (valueType === 'video') return 'video_file'
  if (valueType === 'mesh') return 'deployed_code'
  return 'image'
}

function formatWorkflowDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function createComfyExecutionId(prefix = 'comfy') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

function getAssetSourceReference(asset) {
  if (!asset?.id) {
    return ''
  }

  if (asset.parentId || asset.metadata?.editId) {
    return `edit:${asset.filePath}`
  }

  return `asset:${asset.id}`
}

function createWorkflowDraftInputs(workflow, resolver = () => null) {
  return Object.fromEntries((workflow?.parameters || []).map(parameter => {
    const valueType = getWorkflowParameterValueType(parameter)

    if (isFileWorkflowValueType(valueType)) {
      return [parameter.id, resolver(parameter, valueType)]
    }

    if (valueType === 'boolean') {
      return [parameter.id, Boolean(parameter.defaultValue ?? false)]
    }

    return [parameter.id, parameter.defaultValue ?? '']
  }))
}

function getInputSourceSelectionValue(inputSource) {
  return inputSource?.connectorId ? `connector:${inputSource.connectorId}` : ''
}

function buildNodeInputSources(nodeId, currentNodes, currentEdges) {
  return currentEdges
    .filter(edge => edge.target === String(nodeId))
    .sort((leftEdge, rightEdge) => compareHandleIds(leftEdge.targetHandle || DEFAULT_INPUT_ID, rightEdge.targetHandle || DEFAULT_INPUT_ID))
    .map(edge => {
      const sourceNode = currentNodes.find(node => node.id === edge.source)
      const outputType = getNodeOutputType(sourceNode)
      const sourceAsset = sourceNode?.data?.asset || null
      const sourceReference = getAssetSourceReference(sourceAsset)
      const sourceName = sourceAsset?.name || sourceNode?.data?.name || `Node ${edge.source}`

      return {
        connectorId: edge.targetHandle || DEFAULT_INPUT_ID,
        sourceNodeId: edge.source,
        type: outputType,
        label: sourceName,
        asset: sourceAsset,
        sourceReference,
        value: isFileWorkflowValueType(outputType)
          ? (sourceReference ? { source: sourceReference } : null)
          : (sourceNode?.data?.metadata?.outputValue ?? sourceNode?.data?.outputValue ?? null)
      }
    })
}

function filterMeshGenerationWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const parameterValueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

    return parameterValueTypes.includes('image') && outputValueTypes.includes('mesh')
  })
}

function getCompatibleInputSources(inputSources, valueType) {
  const normalizedValueType = normalizeConnectorType(valueType)
  return (inputSources || []).filter(source => normalizeConnectorType(source.type) === normalizedValueType)
}

function createWorkflowDraftBindings(workflow, inputSources = [], preferredConnectorTypes = []) {
  return Object.fromEntries((workflow?.parameters || []).map(parameter => {
    const valueType = getWorkflowParameterValueType(parameter)
    const compatibleSources = getCompatibleInputSources(inputSources, valueType)
    const shouldPreferConnector = compatibleSources.length > 0
      && (isFileWorkflowValueType(valueType) || preferredConnectorTypes.includes(valueType))

    return [parameter.id, {
      source: shouldPreferConnector ? getInputSourceSelectionValue(compatibleSources[0]) : 'custom'
    }]
  }))
}

function getWorkflowParameterBinding(draft, parameter) {
  return draft?.inputBindings?.[parameter.id] || { source: 'custom' }
}

function resolveSelectedInputSource(sourceSelection, inputSources = []) {
  if (!String(sourceSelection || '').startsWith('connector:')) {
    return null
  }

  const connectorId = String(sourceSelection).slice(10)
  return (inputSources || []).find(source => source.connectorId === connectorId) || null
}

function resolveWorkflowParameterValue(parameter, draft, inputSources = []) {
  const binding = getWorkflowParameterBinding(draft, parameter)
  if (binding.source && binding.source !== 'custom') {
    const selectedSource = resolveSelectedInputSource(binding.source, inputSources)
    return selectedSource?.value ?? null
  }

  return draft?.inputs?.[parameter.id]
}

function resolveImageSourceOption(sourceSelection, inputSources = [], libraryOptions = []) {
  const connectorSource = resolveSelectedInputSource(sourceSelection, inputSources)
  if (connectorSource) {
    return {
      type: 'connector',
      sourceReference: connectorSource.sourceReference,
      asset: connectorSource.asset,
      label: connectorSource.label,
      connectorId: connectorSource.connectorId
    }
  }

  const librarySource = (libraryOptions || []).find(option => option.sourceReference === sourceSelection)
  if (librarySource) {
    return {
      type: 'library',
      sourceReference: librarySource.sourceReference,
      asset: null,
      label: librarySource.name
    }
  }

  return null
}

function filterImageGenerationWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')
    return outputValueTypes.includes('image')
  })
}

function filterImageEditWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const parameterValueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

    return outputValueTypes.includes('image')
      && parameterValueTypes.every(valueType => ['image', 'string', 'number', 'boolean'].includes(valueType))
  })
}

function GraphDeleteEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    const handleDocumentPointerDown = () => {
      setMenuOpen(false)
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown)
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown)
  }, [menuOpen])

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="graph-page__edge-menu nodrag nopan"
          style={{
            left: `${labelX}px`,
            top: `${labelY}px`
          }}
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            type="button"
            className="graph-page__edge-delete"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(current => !current)
            }}
            title="Connection actions"
          >
            <span className="material-symbols-outlined">more_horiz</span>
          </button>

          {menuOpen && (
            <div className="graph-page__edge-dropdown">
              <button
                type="button"
                className="graph-page__edge-dropdown-action"
                onClick={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenuOpen(false)
                  data?.onDelete?.()
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

function GraphAssetNode({ data }) {
  const navigate = useNavigate()
  const updateNodeInternals = useUpdateNodeInternals()
  const isMeshGen = data.nodeKind === 'meshGen'
  const libraryAssetOptions = isMeshGen ? (data.libraryMeshOptions || []) : (data.libraryImageOptions || [])
  const previewFilename = data.asset?.thumbnail || data.asset?.filename || null
  const previewUrl = getAssetPreviewUrl(previewFilename)
  const meshModelUrl = isMeshGen && data.asset?.filename ? getAssetPreviewUrl(data.asset.filename) : null
  const dimensions = formatAssetDimensions(data.asset?.width, data.asset?.height)
  const isProcessing = data.status === 'processing'
  const progressDetail = data.progressDetail || data.metadata?.detail || ''
  const currentNodeLabel = data.currentNodeLabel || data.metadata?.currentNodeLabel || ''
  const [showNormals, setShowNormals] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showLightSlider, setShowLightSlider] = useState(false)
  const [lightIntensity, setLightIntensity] = useState(2.2)
  const draft = data.actionDraft
  const isImageEditMode = ['edit-api', 'edit-comfy'].includes(draft?.mode)
  const sourceLabel = isMeshGen ? 'MESH' : 'IMAGE'
  const metaLabel = isProcessing
    ? (Number.isFinite(data.progress) ? `${data.progress}%` : 'Processing…')
    : (dimensions || (isMeshGen
        ? 'Connect an input image and generate a 3D mesh.'
        : 'Attach, generate, or edit a single image.'))
  const selectedWorkflow = (isMeshGen
    ? data.meshGenerationWorkflows
    : isImageEditMode
      ? data.imageEditWorkflows
      : data.imageGenerationWorkflows)
    .find(workflow => workflow.id == draft?.workflowId) || null
  const inputConnectors = data.inputConnectors || [{ id: DEFAULT_INPUT_ID, type: null, isConnected: false }]
  const inputSources = data.inputSources || []
  const outputConnector = data.outputConnector || { id: DEFAULT_OUTPUT_ID, type: isMeshGen ? 'mesh' : 'image' }
  const hasOutputAsset = Boolean(data.asset?.id)
  const connectedInputCount = inputConnectors.filter(connector => connector.isConnected).length
  const outputMeta = getConnectorTypeMeta(outputConnector.type)
  const imageInputSources = getCompatibleInputSources(inputSources, 'image')
  const selectedApiImageSource = resolveImageSourceOption(draft?.selectedInputSource, inputSources, data.libraryImageOptions)
  const nodeDisplayName = data.name || data.asset?.name || sourceLabel
  const meshEditorPath = isMeshGen && data.asset?.id
    ? buildMeshEditorPath({
        asset: data.asset,
        projectId: data.projectId,
        nodeId: data.id,
        returnTo: `/projects/${data.projectId}`
      })
    : ''

  useEffect(() => {
    updateNodeInternals(String(data.id))
  }, [data.id, inputConnectors, outputConnector.id, updateNodeInternals])

  const renderWorkflowField = (parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)
    const currentValue = draft?.inputs?.[parameter.id]
    const compatibleSources = getCompatibleInputSources(inputSources, valueType)
    const binding = getWorkflowParameterBinding(draft, parameter)
    const selectedSource = resolveSelectedInputSource(binding.source, compatibleSources)

    const renderCustomValueField = () => {
      if ((isImageEditMode || isMeshGen) && valueType === 'image') {
        const selectedSourceReference = currentValue?.source || currentValue || ''

        if (data.libraryImageOptions.length === 0) {
          return (
            <div className="graph-node__linked-input font-label">
              No custom image sources available in the asset library.
            </div>
          )
        }

        return (
          <select
            className="params-card__select nodrag"
            value={selectedSourceReference}
            onChange={event => data.onDraftInputChange?.(data.id, parameter, { source: event.target.value })}
          >
            {data.libraryImageOptions.map(asset => (
              <option key={asset.id} value={asset.sourceReference || asset.id}>{asset.name}</option>
            ))}
          </select>
        )
      }

      if (isFileWorkflowValueType(valueType)) {
        return (
          <label className="image-card__file-input nodrag">
            <input
              type="file"
              accept={getWorkflowFileInputAccept(valueType)}
              onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.files?.[0] || null)}
            />
            <span className="material-symbols-outlined">{getWorkflowFileInputIcon(valueType)}</span>
            <span>{currentValue?.name || `Select ${valueType} file`}</span>
          </label>
        )
      }

      if (valueType === 'boolean') {
        return (
          <label className="params-card__checkbox-label nodrag">
            <div
              className={`params-card__checkbox ${currentValue ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
              onClick={() => data.onDraftInputChange?.(data.id, parameter, !currentValue)}
            >
              {currentValue && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
            </div>
            <span>{parameter.label || 'Toggle value'}</span>
          </label>
        )
      }

      if (valueType === 'string' || parameter.type === 'json') {
        return (
          <textarea
            className="gen-prompt-input image-card__param-textarea nodrag"
            value={typeof currentValue === 'string' ? currentValue : JSON.stringify(currentValue ?? '', null, 2)}
            onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.value)}
          />
        )
      }

      return (
        <input
          type={valueType === 'number' ? 'number' : 'text'}
          className="params-card__input nodrag"
          value={currentValue ?? ''}
          onChange={event => data.onDraftInputChange?.(data.id, parameter, event.target.value)}
        />
      )
    }

    return (
      <>
        {compatibleSources.length > 0 && (
          <select
            className="params-card__select nodrag"
            value={binding.source || 'custom'}
            onChange={event => data.onDraftInputSourceChange?.(data.id, parameter, event.target.value)}
          >
            {compatibleSources.map(source => (
              <option key={source.connectorId} value={getInputSourceSelectionValue(source)}>
                {`${getConnectorTypeMeta(source.type).letter} · ${source.label}`}
              </option>
            ))}
            <option value="custom">Custom value</option>
          </select>
        )}

        {selectedSource ? (
          <div className="graph-node__linked-input font-label">
            {`Using ${getConnectorTypeMeta(selectedSource.type).label} input · ${selectedSource.label}`}
          </div>
        ) : renderCustomValueField()}
      </>
    )
  }

  return (
    <div className={`graph-node graph-node--${data.nodeKind}`}>
      {inputConnectors.map((connector, index) => {
        const connectorMeta = getConnectorTypeMeta(connector.type)

        return (
          <div
            key={connector.id}
            className="graph-node__connector graph-node__connector--input"
            style={getConnectorPosition(index, inputConnectors.length)}
          >
            <Handle
              type="target"
              id={connector.id}
              position={Position.Left}
              className="graph-node__handle graph-node__handle--input"
              style={{ borderColor: connectorMeta.color }}
            />
            <span
              className="graph-node__connector-badge font-label"
              style={{
                color: connectorMeta.color,
                background: connectorMeta.background,
                borderColor: connectorMeta.color
              }}
              title={connector.type ? connectorMeta.label : 'Available input'}
            >
              {connectorMeta.letter}
            </span>
          </div>
        )
      })}

      <div className={`graph-node__card image-card ${isProcessing ? 'image-card--loading image-card--locked' : ''}`}>
        <div className="image-card__actions">
          <button
            type="button"
            className="image-card__action-btn image-card__delete nodrag"
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="image-card__thumb graph-node__thumb">
          {meshModelUrl ? (
            <div className="graph-node__mesh-preview">
              <div className="graph-node__mesh-toolbar nodrag">
                <button
                  type="button"
                  className={`graph-node__mesh-tool ${showNormals ? 'graph-node__mesh-tool--active' : ''}`}
                  onClick={() => setShowNormals(current => !current)}
                  aria-pressed={showNormals}
                  title="Toggle normal material"
                >
                  N
                </button>
                <button
                  type="button"
                  className={`graph-node__mesh-tool ${showGrid ? 'graph-node__mesh-tool--active' : ''}`}
                  onClick={() => setShowGrid(current => !current)}
                  aria-pressed={showGrid}
                  title="Toggle grid"
                >
                  G
                </button>
                <button
                  type="button"
                  className={`graph-node__mesh-tool ${showLightSlider ? 'graph-node__mesh-tool--active' : ''}`}
                  onClick={() => setShowLightSlider(current => !current)}
                  aria-pressed={showLightSlider}
                  title="Adjust light"
                >
                  L
                </button>
                {showLightSlider && (
                  <div className="graph-node__mesh-light-panel">
                    <input
                      type="range"
                      min="0.4"
                      max="4"
                      step="0.1"
                      value={lightIntensity}
                      onChange={event => setLightIntensity(Number(event.target.value))}
                    />
                  </div>
                )}
              </div>
              <Viewer
                height="100%"
                modelUrl={meshModelUrl}
                showNormals={showNormals}
                showGrid={showGrid}
                lightIntensity={lightIntensity}
                fitMode="center"
              />
            </div>
          ) : previewUrl ? (
            <div className="image-card__thumb-item">
              <img src={previewUrl} alt={data.asset?.name || data.name || sourceLabel} className="image-card__thumb-image" />
            </div>
          ) : (
            <div className="image-card__thumb-placeholder">
              <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.12)' }}>
                {isMeshGen ? 'deployed_code' : isImageEditMode ? 'photo_filter' : 'image'}
              </span>
            </div>
          )}

          {(isImageEditMode || isMeshGen) && (
            <div className="image-card__edit-preview-indicator font-label">
              {data.connectedInputAsset ? `INPUT • ${data.connectedInputAsset.name}` : 'INPUT • IMAGE'}
            </div>
          )}

          {dimensions && (
            <div className="image-card__thumb-dimensions font-label">
              {dimensions}
            </div>
          )}
        </div>

        <div className="image-card__info">
          <div className="image-card__row">
            <input
              type="text"
              className="image-card__name graph-node__name-input nodrag"
              value={nodeDisplayName}
              placeholder={sourceLabel}
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <div className="image-card__badges">
              <span
                className="image-card__source"
                style={{
                  color: 'var(--primary)',
                  background: 'rgba(143,245,255,0.1)'
                }}
              >
                {sourceLabel}
              </span>
            </div>
          </div>

          <p className="image-card__meta font-label">{metaLabel}</p>

          {isProcessing && progressDetail && (
            <p className="image-card__meta font-label">{progressDetail}</p>
          )}

          {isProcessing && currentNodeLabel && (
            <p className="image-card__meta font-label image-card__meta--loading-node">{currentNodeLabel}</p>
          )}

          {isProcessing && Number.isFinite(data.progress) && (
            <div className="image-card__progress graph-node__progress" aria-hidden="true">
              <div
                className="image-card__progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, data.progress || 0))}%` }}
              />
            </div>
          )}

          <div className="graph-node__ports-summary font-label">
            <span className="graph-node__port-label">Inputs · {connectedInputCount + 1 > 1 ? `${connectedInputCount} connected` : 'empty'}</span>
            <span className="graph-node__port-label graph-node__port-label--output">Output · {outputMeta.label}</span>
          </div>

          <div className="image-card__attributes graph-node__actions-panel">
            <div className="image-card__edit-actions">
              <button className="image-card__edit-action-btn nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} disabled={isProcessing}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                Action
              </button>
              {meshEditorPath && (
                <button className="image-card__edit-action-btn nodrag" onClick={() => navigate(meshEditorPath)}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit_square</span>
                  Edit
                </button>
              )}

              {draft?.mode === 'select' && (
                <div className="image-card__edit-action-menu">
                  {!isMeshGen && (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'local')}>
                        Local Computer
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'assets')}>
                        From Assets
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'comfy')}>
                        Generate · ComfyUI Workflow
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageModeSelect?.(data.id, 'api')}>
                        Generate · Remote API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageEditModeSelect?.(data.id, 'edit-api')}>
                        Edit · API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onImageEditModeSelect?.(data.id, 'edit-comfy')}>
                        Edit · ComfyUI Workflow
                      </button>
                    </>
                  )}
                  {isMeshGen ? (
                    <>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'assets')}>
                        Assets
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'api')}>
                        API
                      </button>
                      <button className="image-card__edit-action-option nodrag" onClick={() => data.onMeshGenModeSelect?.(data.id, 'comfy')}>
                        ComfyUI Workflow
                      </button>
                    </>
                  ) : null}
                </div>
              )}

							{draft?.mode === 'assets' && (
								<div className="image-card__edit-panel nodrag">
									<span className="graph-node__panel-title font-label">SELECT FROM ASSETS</span>
									<div className="image-card__asset-picker-empty">
										<span className="material-symbols-outlined">perm_media</span>
										<span>Opening asset library...</span>
									</div>
									<button
										className="kanban-sidebar__nav-item nodrag"
										onClick={() => data.onOpenAssetSelector?.(data.id, data.nodeKind === 'meshGen' ? 'mesh' : 'image')}
										style={{ justifyContent: 'center' }}
									>
										Open Asset Selector
									</button>
									<button
										className="kanban-sidebar__nav-item nodrag"
										onClick={() => data.onToggleAction?.(data.id, data.nodeKind)}
										style={{ justifyContent: 'center' }}
									>
										BACK
									</button>
								</div>
							)}

              {draft?.mode === 'api' && !isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">REMOTE API</span>
                  <input
                    type="text"
                    className="params-card__input nodrag"
                    placeholder="Result name"
                    value={draft.name || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                  />
                  <select
                    className="api-select nodrag"
                    value={draft.selectedApi || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedApi', event.target.value)}
                  >
                    {data.imageGenerationApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  <textarea
                    className="gen-prompt-input nodrag"
                    placeholder="What should we generate?"
                    value={draft.prompt || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                  />
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.name?.trim() || !draft.prompt?.trim()}>
                    <span className="material-symbols-outlined">auto_awesome</span>
                    GENERATE
                  </button>
                </div>
              )}

              {draft?.mode === 'comfy' && !isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI WORKFLOW</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.imageGenerationWorkflows.length > 0 ? (
                    <>
                      <input
                        type="text"
                        className="params-card__input nodrag"
                        placeholder="Result name"
                        value={draft.name || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                      />
                      <select
                        className="params-card__select nodrag"
                        value={draft.workflowId || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'workflowId', event.target.value)}
                      >
                        {data.imageGenerationWorkflows.map(workflow => (
                          <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                        ))}
                      </select>
                      <div className="image-card__workflow-meta">
                        <span>{selectedWorkflow?.parameters?.length || 0} input parameters configured</span>
                        <span>{selectedWorkflow?.outputs?.length || 0} outputs selected</span>
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 ? (
                        <div className="image-card__workflow-params">
                          {selectedWorkflow.parameters.map(parameter => (
                            <div key={parameter.id} className="params-card__field">
                              <label className="params-card__label font-label">
                                {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                              </label>
                              {renderWorkflowField(parameter)}
                              <span className="image-card__param-hint">
                                {parameter.label} • default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                          <span className="material-symbols-outlined">tune</span>
                          <span>This workflow has no exposed parameters. Start it directly.</span>
                        </div>
                      )}
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.name?.trim()}>
                        <span className="material-symbols-outlined">bolt</span>
                        START WORKFLOW
                      </button>
                    </>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">account_tree</span>
                      <span>No imported workflows available.</span>
                    </div>
                  )}
                </div>
              )}

              {draft?.mode === 'api' && isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">MESH GEN API</span>
                  <input
                    type="text"
                    className="params-card__input nodrag"
                    placeholder="Result name"
                    value={draft.name || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                  />
                  <select
                    className="api-select nodrag"
                    value={draft.selectedApi || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedApi', event.target.value)}
                  >
                    {data.meshGenerationApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  <textarea
                    className="gen-prompt-input nodrag"
                    placeholder="Describe the mesh to generate"
                    value={draft.prompt || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                  />
                  <select
                    className="params-card__select nodrag"
                    value={draft.selectedInputSource || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedInputSource', event.target.value)}
                  >
                    {imageInputSources.length > 0 && (
                      <optgroup label="Connected inputs">
                        {imageInputSources.map(source => (
                          <option key={source.connectorId} value={getInputSourceSelectionValue(source)}>
                            {`${getConnectorTypeMeta(source.type).letter} · ${source.label}`}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {data.libraryImageOptions.length > 0 && (
                      <optgroup label="Asset library">
                        {data.libraryImageOptions.map(asset => (
                          <option key={asset.id} value={asset.sourceReference || asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {imageInputSources.length === 0 && data.libraryImageOptions.length === 0 && (
                      <option value="">No image sources available</option>
                    )}
                  </select>
                  <div className="graph-node__linked-input font-label">
                    {selectedApiImageSource?.label
                      ? `Input: ${selectedApiImageSource.label}`
                      : 'Select an image source from the graph or asset library'}
                  </div>
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.selectedInputSource}>
                    <span className="material-symbols-outlined">deployed_code</span>
                    RUN GENERATION
                  </button>
                </div>
              )}

              {draft?.mode === 'comfy' && isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI MESH GEN</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.meshGenerationWorkflows.length > 0 ? (
                    <>
                      <input
                        type="text"
                        className="params-card__input nodrag"
                        placeholder="Result name"
                        value={draft.name || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                      />
                      <select
                        className="params-card__select nodrag"
                        value={draft.workflowId || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'workflowId', event.target.value)}
                      >
                        {data.meshGenerationWorkflows.map(workflow => (
                          <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                        ))}
                      </select>
                      <div className="image-card__workflow-meta">
                        <span>{selectedWorkflow?.parameters?.length || 0} input parameters configured</span>
                        <span>{selectedWorkflow?.outputs?.length || 0} outputs selected</span>
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 ? (
                        <div className="image-card__workflow-params">
                          {selectedWorkflow.parameters.map(parameter => (
                            <div key={parameter.id} className="params-card__field">
                              <label className="params-card__label font-label">
                                {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                              </label>
                              {renderWorkflowField(parameter)}
                              <span className="image-card__param-hint">
                                {parameter.label} • default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                          <span className="material-symbols-outlined">tune</span>
                          <span>This workflow has no exposed parameters. Start it directly.</span>
                        </div>
                      )}
                      <div className="graph-node__linked-input font-label">
                        {imageInputSources.length > 0
                          ? `${imageInputSources.length} compatible image input${imageInputSources.length === 1 ? '' : 's'} available`
                          : 'Use a connected image or upload a custom file for image parameters'}
                      </div>
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.name?.trim()}>
                        <span className="material-symbols-outlined">bolt</span>
                        START WORKFLOW
                      </button>
                    </>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">account_tree</span>
                      <span>No imported workflows available.</span>
                    </div>
                  )}
                </div>
              )}

              {draft?.mode === 'edit-api' && !isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">IMAGE EDIT API</span>
                  <input
                    type="text"
                    className="params-card__input nodrag"
                    placeholder="Result name"
                    value={draft.name || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                  />
                  <select
                    className="api-select nodrag"
                    value={draft.selectedApi || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedApi', event.target.value)}
                  >
                    {data.imageEditApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>
                  <textarea
                    className="gen-prompt-input nodrag"
                    placeholder="Describe the edit"
                    value={draft.prompt || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'prompt', event.target.value)}
                  />
                  <select
                    className="params-card__select nodrag"
                    value={draft.selectedInputSource || ''}
                    onChange={event => data.onDraftFieldChange?.(data.id, 'selectedInputSource', event.target.value)}
                  >
                    {imageInputSources.length > 0 && (
                      <optgroup label="Connected inputs">
                        {imageInputSources.map(source => (
                          <option key={source.connectorId} value={getInputSourceSelectionValue(source)}>
                            {`${getConnectorTypeMeta(source.type).letter} · ${source.label}`}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {data.libraryImageOptions.length > 0 && (
                      <optgroup label="Asset library">
                        {data.libraryImageOptions.map(asset => (
                          <option key={asset.id} value={asset.sourceReference || asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {imageInputSources.length === 0 && data.libraryImageOptions.length === 0 && (
                      <option value="">No image sources available</option>
                    )}
                  </select>
                  <div className="graph-node__linked-input font-label">
                    {selectedApiImageSource?.label
                      ? `Input: ${selectedApiImageSource.label}`
                      : 'Select an image source from the graph or asset library'}
                  </div>
                  <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)} disabled={!draft.selectedInputSource}>
                    <span className="material-symbols-outlined">auto_fix_high</span>
                    RUN EDIT
                  </button>
                </div>
              )}

              {draft?.mode === 'edit-comfy' && !isMeshGen && (
                <div className="image-card__edit-panel nodrag">
                  <span className="graph-node__panel-title font-label">COMFYUI IMAGE EDIT</span>
                  {data.comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : data.imageEditWorkflows.length > 0 ? (
                    <>
                      <input
                        type="text"
                        className="params-card__input nodrag"
                        placeholder="Result name"
                        value={draft.name || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'name', event.target.value)}
                      />
                      <select
                        className="params-card__select nodrag"
                        value={draft.workflowId || ''}
                        onChange={event => data.onDraftFieldChange?.(data.id, 'workflowId', event.target.value)}
                      >
                        {data.imageEditWorkflows.map(workflow => (
                          <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                        ))}
                      </select>
                      <div className="image-card__workflow-meta">
                        <span>{selectedWorkflow?.parameters?.length || 0} input parameters configured</span>
                        <span>{selectedWorkflow?.outputs?.length || 0} outputs selected</span>
                      </div>
                      {(selectedWorkflow?.parameters || []).length > 0 ? (
                        <div className="image-card__workflow-params">
                          {selectedWorkflow.parameters.map(parameter => (
                            <div key={parameter.id} className="params-card__field">
                              <label className="params-card__label font-label">
                                {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                              </label>
                              {renderWorkflowField(parameter)}
                              <span className="image-card__param-hint">
                                {parameter.label} • default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                          <span className="material-symbols-outlined">tune</span>
                          <span>This workflow has no exposed parameters. Start it directly.</span>
                        </div>
                      )}
                      <div className="graph-node__linked-input font-label">
                        {imageInputSources.length > 0
                          ? `${imageInputSources.length} compatible image input${imageInputSources.length === 1 ? '' : 's'} available`
                          : 'Use a connected image or upload a custom file for image parameters'}
                      </div>
                      <button className="gen-btn nodrag" onClick={() => data.onRunNodeAction?.(data.id)}>
                        <span className="material-symbols-outlined">bolt</span>
                        START WORKFLOW
                      </button>
                    </>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">account_tree</span>
                      <span>No imported workflows available.</span>
                    </div>
                  )}
                </div>
              )}

              {draft && draft.mode !== 'select' && (
                <button className="kanban-sidebar__nav-item nodrag" onClick={() => data.onToggleAction?.(data.id, data.nodeKind)} style={{ justifyContent: 'center' }}>
                  BACK
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {hasOutputAsset && (
        <div className="graph-node__connector graph-node__connector--output" style={getConnectorPosition(0, 1)}>
          <span
            className="graph-node__connector-badge font-label"
            style={{
              color: outputMeta.color,
              background: outputMeta.background,
              borderColor: outputMeta.color
            }}
            title={outputMeta.label}
          >
            {outputMeta.letter}
          </span>
          <Handle
            type="source"
            id={outputConnector.id}
            position={Position.Right}
            className="graph-node__handle graph-node__handle--output"
            style={{ borderColor: outputMeta.color }}
          />
        </div>
      )}
    </div>
  )
}

function GraphImageCompareNode({ data }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [comparePosition, setComparePosition] = useState(50)
  const inputConnectors = data.inputConnectors || IMAGE_COMPARE_INPUT_IDS.map(id => ({ id, type: 'image', isConnected: false }))
  const leftSource = (data.inputSources || []).find(source => source.connectorId === IMAGE_COMPARE_INPUT_IDS[0]) || null
  const rightSource = (data.inputSources || []).find(source => source.connectorId === IMAGE_COMPARE_INPUT_IDS[1]) || null
  const leftAsset = leftSource?.asset || null
  const rightAsset = rightSource?.asset || null
  const leftPreviewUrl = appendCacheBust(getAssetPreviewUrl(leftAsset?.thumbnail || leftAsset?.filename), refreshKey)
  const rightPreviewUrl = appendCacheBust(getAssetPreviewUrl(rightAsset?.thumbnail || rightAsset?.filename), refreshKey)
  const hasBothImages = Boolean(leftPreviewUrl && rightPreviewUrl)
  const nodeDisplayName = data.name || data.nodeTypeName || IMAGE_COMPARE_NODE_TYPE_NAME
  const connectedInputCount = inputConnectors.filter(connector => connector.isConnected).length

  useEffect(() => {
    setComparePosition(50)
  }, [leftPreviewUrl, rightPreviewUrl])

  const handlePointerMove = useCallback((event) => {
    if (!hasBothImages) {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width) {
      return
    }

    const nextPosition = ((event.clientX - bounds.left) / bounds.width) * 100
    setComparePosition(Math.max(0, Math.min(100, nextPosition)))
  }, [hasBothImages])

  return (
    <div className="graph-node graph-node--imageCompare">
      {inputConnectors.map((connector, index) => {
        const connectorMeta = getConnectorTypeMeta(connector.type)

        return (
          <div
            key={connector.id}
            className="graph-node__connector graph-node__connector--input"
            style={getConnectorPosition(index, inputConnectors.length)}
          >
            <Handle
              type="target"
              id={connector.id}
              position={Position.Left}
              className="graph-node__handle graph-node__handle--input"
              style={{ borderColor: connectorMeta.color }}
            />
            <span
              className="graph-node__connector-badge font-label"
              style={{
                color: connectorMeta.color,
                background: connectorMeta.background,
                borderColor: connectorMeta.color
              }}
              title={connectorMeta.label}
            >
              {connectorMeta.letter}
            </span>
          </div>
        )
      })}

      <div className="graph-node__compare-card">
        <div className="graph-node__compare-header">
          <div className="graph-node__compare-title-group">
            <input
              type="text"
              className="graph-node__name-input nodrag"
              value={nodeDisplayName}
              placeholder={IMAGE_COMPARE_NODE_TYPE_NAME}
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <span className="graph-node__compare-type font-label">COMPARE</span>
          </div>

          <button
            type="button"
            className="image-card__action-btn image-card__delete nodrag"
            style={{ opacity: 1, flexShrink: 0 }}
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="graph-node__compare-body">
          <div
            className={`graph-node__compare-stage nodrag ${hasBothImages ? 'graph-node__compare-stage--active' : ''}`}
            onPointerMove={handlePointerMove}
          >
            {hasBothImages ? (
              <>
                <img src={rightPreviewUrl} alt={rightAsset?.name || 'Right comparison image'} className="graph-node__compare-image" draggable={false} />
                <img
                  src={leftPreviewUrl}
                  alt={leftAsset?.name || 'Left comparison image'}
                  className="graph-node__compare-image graph-node__compare-image--overlay"
                  style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}
                  draggable={false}
                />
                <div className="graph-node__compare-divider" style={{ left: `${comparePosition}%` }}>
                  <span className="material-symbols-outlined">compare_arrows</span>
                </div>
              </>
            ) : (
              <div className="graph-node__compare-placeholder">
                {[leftSource, rightSource].map((source, index) => (
                  <div key={IMAGE_COMPARE_INPUT_IDS[index]} className="graph-node__compare-slot">
                    <span className="material-symbols-outlined">image</span>
                    <span>{source?.label || `Connect image ${index + 1}`}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="graph-node__compare-caption font-label">
              <span>{leftSource?.label || 'Left image'}</span>
              <span>{rightSource?.label || 'Right image'}</span>
            </div>
          </div>

          <p className="image-card__meta font-label">
            {hasBothImages
              ? 'Move across the preview to inspect the differences between both inputs.'
              : 'Connect two image outputs to enable the comparer.'}
          </p>

          <div className="graph-node__ports-summary font-label">
            <span className="graph-node__port-label">Inputs · {connectedInputCount}/2 connected</span>
          </div>

          <button
            type="button"
            className="image-card__edit-action-btn graph-node__compare-refresh nodrag"
            onClick={() => setRefreshKey(current => current + 1)}
            disabled={!hasBothImages}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}

function GraphValueNode({ data }) {
  const nodeKind = data.nodeKind
  const outputMeta = getConnectorTypeMeta(nodeKind)
  const outputValue = data.metadata?.outputValue ?? getDefaultNodeOutputValue(data.nodeTypeName || nodeKind)
  const nodeDisplayName = data.name || data.nodeTypeName || outputMeta.label

  return (
    <div className={`graph-node graph-node--value graph-node--${nodeKind}`}>
      <div className="graph-node__value-card">
        <div className="graph-node__value-header graph-node__drag-handle">
          <div className="graph-node__value-title-group">
            <input
              type="text"
              className="graph-node__name-input graph-node__name-input--value nodrag"
              value={nodeDisplayName}
              placeholder={outputMeta.label}
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <span
              className="graph-node__value-type font-label"
              style={{
                color: outputMeta.color,
                background: outputMeta.background,
                borderColor: outputMeta.color
              }}
            >
              {outputMeta.label}
            </span>
          </div>

          <button
            type="button"
            className="image-card__action-btn image-card__delete graph-node__value-delete nodrag"
            style={{ opacity: 1, flexShrink: 0 }}
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="graph-node__value-body">
          <span className="graph-node__panel-title font-label">VALUE</span>

          {nodeKind === 'text' ? (
            <textarea
              className="gen-prompt-input graph-node__value-input graph-node__value-input--textarea nodrag"
              value={String(outputValue ?? '')}
              placeholder="Type text"
              onChange={event => data.onNodeOutputValueChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeOutputValueCommit?.(data.id, event.target.value)}
            />
          ) : nodeKind === 'boolean' ? (
            <button
              type="button"
              className={`graph-node__boolean-toggle nodrag ${outputValue ? 'graph-node__boolean-toggle--active' : ''}`}
              onClick={() => {
                const nextValue = !outputValue
                data.onNodeOutputValueChange?.(data.id, nextValue)
                data.onNodeOutputValueCommit?.(data.id, nextValue)
              }}
              aria-pressed={outputValue}
            >
              <span className="material-symbols-outlined">{outputValue ? 'check_circle' : 'radio_button_unchecked'}</span>
              <span>{outputValue ? 'True' : 'False'}</span>
            </button>
          ) : (
            <input
              type="number"
              className="params-card__input graph-node__value-input nodrag"
              value={outputValue ?? ''}
              onChange={event => data.onNodeOutputValueChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeOutputValueCommit?.(data.id, event.target.value)}
            />
          )}

          <div className="graph-node__ports-summary font-label">
            <span className="graph-node__port-label graph-node__port-label--output">Output · {outputMeta.label}</span>
          </div>
        </div>
      </div>

      <div className="graph-node__connector graph-node__connector--output" style={getConnectorPosition(0, 1)}>
        <span
          className="graph-node__connector-badge font-label"
          style={{
            color: outputMeta.color,
            background: outputMeta.background,
            borderColor: outputMeta.color
          }}
          title={outputMeta.label}
        >
          {outputMeta.letter}
        </span>
        <Handle
          type="source"
          id={DEFAULT_OUTPUT_ID}
          position={Position.Right}
          className="graph-node__handle graph-node__handle--output"
          style={{ borderColor: outputMeta.color }}
        />
      </div>
    </div>
  )
}

const flowNodeTypes = {
  image: GraphAssetNode,
  imageEdit: GraphAssetNode,
  imageCompare: GraphImageCompareNode,
  meshGen: GraphAssetNode,
  number: GraphValueNode,
  text: GraphValueNode,
  boolean: GraphValueNode
}

const flowEdgeTypes = {
  deletable: GraphDeleteEdge
}

export default function GraphPage({ project }) {
  const {
    getProjectNodes,
    createProjectNode,
    updateProjectNode,
    updateProjectNodePosition,
    deleteProjectNode,
    getProjectConnections,
    createProjectConnection,
    deleteProjectConnection,
    uploadAsset,
    uploadAssetThumbnail,
    attachExistingAsset,
    getLibraryAssets,
    generateImage,
    getComfyWorkflows,
    runComfyWorkflow,
    subscribeToComfyWorkflowProgress,
    runImageEditApi,
    runImageEditComfy,
    runMeshGenerationApi
  } = useProjects()
  const { settings } = useSettings()

  const [showSettings, setShowSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [actionDraftsByNodeId, setActionDraftsByNodeId] = useState({})
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [comfyLoading, setComfyLoading] = useState(false)
  const [nodePicker, setNodePicker] = useState(null)
  const [reactFlowInstance, setReactFlowInstance] = useState(null)

	const [assetSelectorOpen, setAssetSelectorOpen] = useState(false);
	const [assetSelectorType, setAssetSelectorType] = useState('image');
	const [pendingAssetNodeId, setPendingAssetNodeId] = useState(null);

  const fileInputRef = useRef(null)
  const pendingUploadNodeIdRef = useRef(null)
  const progressSubscriptionsRef = useRef(new Map())
  const libraryLoadedRef = useRef(false)
  const workflowsLoadedRef = useRef(false)
  const graphCanvasRef = useRef(null)
  const hasAutoFitOnLoadRef = useRef(false)

  const customApis = useMemo(() => settings?.apis?.custom || [], [settings])
  const imageGenerationApis = useMemo(() => ([
    ...IMAGE_API_LIST,
    ...customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'image-generation')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]), [customApis])
  const imageEditApis = useMemo(() => ([
    ...IMAGE_API_LIST,
    ...customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'image-edit')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]), [customApis])

  const meshGenerationApis = useMemo(() => (
    customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'mesh-generation')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ), [customApis])

  const imageGenerationWorkflows = useMemo(() => filterImageGenerationWorkflows(comfyWorkflows), [comfyWorkflows])

  const imageEditWorkflows = useMemo(() => filterImageEditWorkflows(comfyWorkflows), [comfyWorkflows])

  const meshGenerationWorkflows = useMemo(() => filterMeshGenerationWorkflows(comfyWorkflows), [comfyWorkflows])

  const libraryImageOptions = useMemo(() => {
    return (libraryAssets.images || []).flatMap(asset => {
      const children = asset.children || asset.edits || []
      const originalOption = {
        id: `asset:${asset.id}`,
        name: asset.name,
        filename: asset.filename,
        url: asset.url,
        extension: asset.extension || (asset.filename?.split('.').pop() || '').toUpperCase(),
        isEdit: false
      }

      const childOptions = children.map(child => ({
        id: `edit:${child.id}`,
        name: child.name || `${asset.name} Edit`,
        filename: child.filename,
        url: child.url || getAssetPreviewUrl(child.filename),
        extension: (child.filename?.split('.').pop() || '').toUpperCase(),
        sourceReference: child.filePath ? `edit:${child.filePath}` : '',
        isEdit: true
      }))

      return [{
        ...originalOption,
        sourceReference: `asset:${asset.id}`
      }, ...childOptions]
    })
  }, [libraryAssets])

  const libraryMeshOptions = useMemo(() => {
    return (libraryAssets.meshes || []).flatMap(asset => {
      const children = asset.children || asset.edits || []
      const originalOption = {
        id: `asset:${asset.id}`,
        name: asset.name,
        filename: asset.filename,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl || null,
        extension: asset.extension || (asset.filename?.split('.').pop() || '').toUpperCase(),
        type: 'mesh',
        isEdit: false
      }

      const childOptions = children.map(child => ({
        id: `edit:${child.id}`,
        name: child.name || `${asset.name} Edit`,
        filename: child.filename,
        url: child.url || getAssetPreviewUrl(child.filename),
        thumbnailUrl: child.thumbnailUrl || null,
        extension: (child.filename?.split('.').pop() || '').toUpperCase(),
        sourceReference: child.filePath ? `edit:${child.filePath}` : '',
        type: 'mesh',
        isEdit: true
      }))

      return [{
        ...originalOption,
        sourceReference: `asset:${asset.id}`
      }, ...childOptions]
    })
  }, [libraryAssets])

  const getConnectedInputAssetFrom = useCallback((currentNodes, currentEdges, nodeId) => {
    return getInputSource(currentNodes, currentEdges, nodeId, 'image').asset
  }, [])

  const createImageNodeDraft = useCallback((mode = 'select', inputSources = [], workflowListOverride = null) => {
    const workflowList = workflowListOverride || imageGenerationWorkflows
    const defaultWorkflow = workflowList[0] || null
    return {
      mode,
      name: '',
      selectedApi: imageGenerationApis[0]?.id || '',
      prompt: '',
      workflowId: defaultWorkflow?.id || '',
      inputs: mode === 'comfy' ? createWorkflowDraftInputs(defaultWorkflow, () => null) : {},
      inputBindings: mode === 'comfy' ? createWorkflowDraftBindings(defaultWorkflow, inputSources) : {}
    }
  }, [imageGenerationApis, imageGenerationWorkflows])

  const createImageEditNodeDraft = useCallback((mode = 'select', sourceAsset = null, inputSources = [], libraryOptions = [], workflowListOverride = null) => {
    const workflowList = workflowListOverride || imageEditWorkflows
    const defaultWorkflow = workflowList[0] || null
    const sourceReference = getAssetSourceReference(sourceAsset)
    const defaultImageInputSource = getCompatibleInputSources(inputSources, 'image')[0] || null
    const isApiMode = mode === 'edit-api' || mode === 'api'
    const isComfyMode = mode === 'edit-comfy' || mode === 'comfy'
    return {
      mode,
      name: '',
      selectedApi: imageEditApis[0]?.id || '',
      prompt: '',
      selectedInputSource: isApiMode
        ? (getInputSourceSelectionValue(defaultImageInputSource) || libraryOptions[0]?.sourceReference || sourceReference || '')
        : '',
      workflowId: defaultWorkflow?.id || '',
      inputs: isComfyMode
        ? createWorkflowDraftInputs(defaultWorkflow, (_parameter, valueType) => valueType === 'image'
            ? ({ source: libraryOptions[0]?.sourceReference || sourceReference || '' })
            : null)
        : {},
      inputBindings: isComfyMode
        ? createWorkflowDraftBindings(defaultWorkflow, inputSources, ['image'])
        : {}
    }
  }, [imageEditApis, imageEditWorkflows])

  const createMeshGenNodeDraft = useCallback((mode = 'select', sourceAsset = null, inputSources = [], libraryOptions = [], workflowListOverride = null) => {
    const workflowList = workflowListOverride || meshGenerationWorkflows
    const defaultWorkflow = workflowList[0] || null
    const sourceReference = getAssetSourceReference(sourceAsset)
    const defaultImageInputSource = getCompatibleInputSources(inputSources, 'image')[0] || null

    return {
      mode,
      name: '',
      selectedApi: meshGenerationApis[0]?.id || '',
      prompt: '',
      selectedInputSource: mode === 'api'
        ? (getInputSourceSelectionValue(defaultImageInputSource) || libraryOptions[0]?.sourceReference || sourceReference || '')
        : '',
      workflowId: defaultWorkflow?.id || '',
      inputs: mode === 'comfy'
        ? createWorkflowDraftInputs(defaultWorkflow, (_parameter, valueType) => valueType === 'image'
            ? ({ source: libraryOptions[0]?.sourceReference || sourceReference || '' })
            : null)
        : {},
      inputBindings: mode === 'comfy'
        ? createWorkflowDraftBindings(defaultWorkflow, inputSources, ['image'])
        : {}
    }
  }, [meshGenerationApis, meshGenerationWorkflows])

  const closeNodeProgressSubscription = useCallback((nodeId) => {
    progressSubscriptionsRef.current.get(String(nodeId))?.()
    progressSubscriptionsRef.current.delete(String(nodeId))
  }, [])

  const replaceFlowNodeData = useCallback((updatedNode) => {
    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(updatedNode.id)
        ? {
            ...node,
            position: node.position,
            data: {
              ...node.data,
              ...updatedNode,
              nodeKind: getNodeKind(updatedNode.nodeTypeName)
            }
          }
        : node
    )))
  }, [setNodes])

  const handleNodeNameChange = useCallback((nodeId, name) => {
    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(nodeId)
        ? {
            ...node,
            data: {
              ...node.data,
              name
            }
          }
        : node
    )))
  }, [setNodes])

  const handleNodeNameCommit = useCallback(async (nodeId, name) => {
    const existingNode = nodes.find(node => node.id === String(nodeId))
    if (!existingNode) {
      return
    }

    const nextName = String(name || '').trim() || existingNode.data.asset?.name || existingNode.data.nodeTypeName || 'Node'

    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(nodeId)
        ? {
            ...node,
            data: {
              ...node.data,
              name: nextName
            }
          }
        : node
    )))

    try {
      const updatedNode = await updateProjectNode(project.id, Number(nodeId), { name: nextName })
      replaceFlowNodeData(updatedNode)
    } catch (err) {
      console.error('Failed to rename graph node:', err)
    }
  }, [nodes, project.id, replaceFlowNodeData, setNodes, updateProjectNode])

  const handleNodeOutputValueChange = useCallback((nodeId, outputValue) => {
    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(nodeId)
        ? {
            ...node,
            data: {
              ...node.data,
              metadata: {
                ...(node.data.metadata || {}),
                outputValue
              }
            }
          }
        : node
    )))
  }, [setNodes])

  const handleNodeOutputValueCommit = useCallback(async (nodeId, outputValue) => {
    const existingNode = nodes.find(node => node.id === String(nodeId))
    if (!existingNode) {
      return
    }

    const normalizedValue = normalizeNodeOutputValue(existingNode.data.nodeKind, outputValue)

    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(nodeId)
        ? {
            ...node,
            data: {
              ...node.data,
              metadata: {
                ...(node.data.metadata || {}),
                outputValue: normalizedValue
              }
            }
          }
        : node
    )))

    try {
      const updatedNode = await updateProjectNode(project.id, Number(nodeId), {
        metadata: {
          outputValue: normalizedValue
        }
      })
      replaceFlowNodeData(updatedNode)
    } catch (err) {
      console.error('Failed to persist graph node value:', err)
    }
  }, [nodes, project.id, replaceFlowNodeData, setNodes, updateProjectNode])

  useEffect(() => {
    return () => {
      progressSubscriptionsRef.current.forEach(unsubscribe => unsubscribe?.())
      progressSubscriptionsRef.current.clear()
    }
  }, [])

  const handleDeleteNode = useCallback(async (nodeId) => {
    closeNodeProgressSubscription(nodeId)
    await deleteProjectNode(project.id, Number(nodeId))
    setNodes(currentNodes => currentNodes.filter(node => node.id !== String(nodeId)))
    setEdges(currentEdges => currentEdges.filter(edge => edge.source !== String(nodeId) && edge.target !== String(nodeId)))
    setActionDraftsByNodeId(currentDrafts => {
      const nextDrafts = { ...currentDrafts }
      delete nextDrafts[String(nodeId)]
      return nextDrafts
    })
  }, [closeNodeProgressSubscription, deleteProjectNode, project.id, setEdges, setNodes])

  const ensureGeneratedMeshThumbnail = useCallback(async (asset) => {
    if (!asset || asset.type !== 'mesh' || asset.thumbnail) {
      return asset
    }

    const assetUrl = getAssetPreviewUrl(asset.filename)
    const response = await fetch(assetUrl)

    if (!response.ok) {
      throw new Error(`Failed to download generated mesh ${asset.name || asset.filename}`)
    }

    const blob = await response.blob()
    const file = new File([blob], asset.filename?.split('/').pop() || `${asset.name || 'mesh'}.glb`, {
      type: blob.type || 'application/octet-stream'
    })
    const thumbnailFile = await createMeshThumbnailFile(file)

    if (!thumbnailFile) {
      return asset
    }

    return await uploadAssetThumbnail(asset.id, thumbnailFile)
  }, [uploadAssetThumbnail])

  const ensureGeneratedMeshThumbnails = useCallback(async (generatedAssets) => {
    const meshAssets = (Array.isArray(generatedAssets) ? generatedAssets : [generatedAssets]).filter(asset => asset?.type === 'mesh')

    for (const meshAsset of meshAssets) {
      try {
        await ensureGeneratedMeshThumbnail(meshAsset)
      } catch (err) {
        console.warn(`Failed to generate thumbnail for mesh ${meshAsset?.name || meshAsset?.id}:`, err)
      }
    }
  }, [ensureGeneratedMeshThumbnail])

  const setNodeTransientData = useCallback((nodeId, updates) => {
    setNodes(currentNodes => currentNodes.map(node => (
      node.id === String(nodeId)
        ? {
            ...node,
            data: {
              ...node.data,
              ...updates
            }
          }
        : node
    )))
  }, [setNodes])

  const ensureLibraryLoaded = useCallback(async () => {
    if (libraryLoadedRef.current) {
      return
    }

    setLibraryLoading(true)
    try {
      const library = await getLibraryAssets()
      setLibraryAssets(library)
      libraryLoadedRef.current = true
    } finally {
      setLibraryLoading(false)
    }
  }, [getLibraryAssets])

  const ensureComfyWorkflowsLoaded = useCallback(async () => {
    if (workflowsLoadedRef.current) {
      return comfyWorkflows
    }

    setComfyLoading(true)
    try {
      const workflows = await getComfyWorkflows()
      setComfyWorkflows(workflows)
      workflowsLoadedRef.current = true
      return workflows
    } finally {
      setComfyLoading(false)
    }
  }, [comfyWorkflows, getComfyWorkflows])

  useEffect(() => {
    let cancelled = false

    async function loadGraph() {
      setLoading(true)

      try {
        const [projectNodes, projectConnections] = await Promise.all([
          getProjectNodes(project.id),
          getProjectConnections(project.id)
        ])

        if (cancelled) {
          return
        }

        setNodes(projectNodes.map(node => toBaseFlowNode(node, handleDeleteNode)))
        setEdges(projectConnections.map(toFlowEdge))
      } catch (err) {
        console.error('Failed to load workflow graph:', err)
        if (!cancelled) {
          setNodes([])
          setEdges([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadGraph()

    return () => {
      cancelled = true
    }
  }, [getProjectConnections, getProjectNodes, handleDeleteNode, project.id, setEdges, setNodes])

  const handleCreateNode = useCallback(async (nodeTypeName, initialData = {}) => {
    const nextIndex = nodes.length
    const defaultOutputType = getDefaultNodeOutputType(nodeTypeName)
    const createdNode = await createProjectNode(project.id, {
      nodeTypeName,
      name: initialData.name || nodeTypeName,
      xPos: initialData.xPos ?? (96 + ((nextIndex % 4) * 48)),
      yPos: initialData.yPos ?? (96 + (nextIndex * 32)),
      assetId: initialData.assetId ?? null,
      status: initialData.status ?? null,
      progress: initialData.progress ?? null,
      metadata: {
        inputType: null,
        outputType: defaultOutputType,
        ...(isValueNodeKind(defaultOutputType) ? { outputValue: getDefaultNodeOutputValue(nodeTypeName) } : {}),
        ...(initialData.metadata || {})
      }
    })

    setNodes(currentNodes => [...currentNodes, toBaseFlowNode(createdNode, handleDeleteNode)])
    return createdNode
  }, [createProjectNode, handleDeleteNode, nodes.length, project.id, setNodes])

  const handlePaneContextMenu = useCallback((event) => {
    event.preventDefault()

    const canvasBounds = graphCanvasRef.current?.getBoundingClientRect()
    const flowPosition = reactFlowInstance?.screenToFlowPosition
      ? reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : { x: 96, y: 96 }

    setNodePicker({
      menuX: canvasBounds ? event.clientX - canvasBounds.left : event.clientX,
      menuY: canvasBounds ? event.clientY - canvasBounds.top : event.clientY,
      flowX: flowPosition.x,
      flowY: flowPosition.y
    })
  }, [reactFlowInstance])

  const handleCreateNodeFromPicker = useCallback(async (nodeTypeName) => {
    if (!nodePicker) {
      return
    }

    await handleCreateNode(nodeTypeName, {
      xPos: nodePicker.flowX,
      yPos: nodePicker.flowY
    })

    setNodePicker(null)
  }, [handleCreateNode, nodePicker])

  const openActionDraft = useCallback((nodeId, nodeKind) => {
    const inputSources = buildNodeInputSources(nodeId, nodes, edges)
    setActionDraftsByNodeId({
      [String(nodeId)]: nodeKind === 'meshGen'
        ? createMeshGenNodeDraft('select', getConnectedInputAssetFrom(nodes, edges, nodeId), inputSources, libraryImageOptions)
        : nodeKind === 'imageEdit'
        ? createImageEditNodeDraft('select', getConnectedInputAssetFrom(nodes, edges, nodeId), inputSources, libraryImageOptions)
        : createImageNodeDraft('select', inputSources)
    })
  }, [createImageEditNodeDraft, createImageNodeDraft, createMeshGenNodeDraft, edges, getConnectedInputAssetFrom, libraryImageOptions, nodes])

	const handleOpenAssetSelector = useCallback((nodeId, type) => {
		setAssetSelectorType(type === 'mesh' ? 'mesh' : 'image');
		setPendingAssetNodeId(nodeId);
		setAssetSelectorOpen(true);
	}, []);	

	const handleAssetSelected = useCallback(async (asset) => {
		if (!pendingAssetNodeId) return;

		if (!asset) {
			console.error('No asset provided');
			return;
		}

		const assetType = assetSelectorType; // 'image' or 'mesh'
		try {
			const attachedAsset = await attachExistingAsset(project.id, {
				filename: asset.filename,
				type: assetType,
				name: asset.name,
				metadata: {
					format: asset.extension,
					source: 'ASSET LIB'
				}
			});

			await updateProjectNode(project.id, Number(pendingAssetNodeId), {
				assetId: attachedAsset.id,
				name: attachedAsset.name,
				status: null,
				progress: null,
				metadata: { lastAction: 'asset-library' }
			});

			// Refresh node data
			const updatedNode = await getProjectNodes(project.id).then(nodes => 
				nodes.find(n => n.id === Number(pendingAssetNodeId))
			);
			if (updatedNode) replaceFlowNodeData(updatedNode);

			// Clear draft for this node
			setActionDraftsByNodeId(prev => {
				const next = { ...prev };
				delete next[String(pendingAssetNodeId)];
				return next;
			});
		} catch (err) {
			console.error('Failed to attach asset to node:', err);
		} finally {
			setAssetSelectorOpen(false);
			setPendingAssetNodeId(null);
		}
	}, [attachExistingAsset, assetSelectorType, project.id, updateProjectNode, getProjectNodes, replaceFlowNodeData]);

  const renderedNodes = useMemo(() => nodes.map(node => ({
    ...node,
    dragHandle: isValueNodeKind(node.data.nodeKind)
      ? '.graph-node__value-card'
      : node.data.nodeKind === 'imageCompare'
        ? '.graph-node__compare-header'
        : '.graph-node__card',
    data: {
      ...node.data,
      inputConnectors: buildInputConnectors(node.id, nodes, edges),
      inputSources: buildNodeInputSources(node.id, nodes, edges),
      outputConnector: {
        id: DEFAULT_OUTPUT_ID,
        type: getNodeOutputType(node)
      },
			onOpenAssetSelector: (nodeId, type) => handleOpenAssetSelector(nodeId, type),
      actionDraft: actionDraftsByNodeId[node.id] || null,
      connectedInputAsset: getConnectedInputAssetFrom(nodes, edges, node.id),
      imageGenerationApis,
      imageEditApis,
      meshGenerationApis,
      imageGenerationWorkflows,
      imageEditWorkflows,
      meshGenerationWorkflows,
      libraryImageOptions,
      libraryMeshOptions,
      libraryLoading,
      comfyLoading,
      onNodeNameChange: handleNodeNameChange,
      onNodeNameCommit: handleNodeNameCommit,
      onNodeOutputValueChange: handleNodeOutputValueChange,
      onNodeOutputValueCommit: handleNodeOutputValueCommit,
      onToggleAction: openActionDraft,
      onImageModeSelect: async (targetNodeId, mode) => {
        if (mode === 'local') {
          pendingUploadNodeIdRef.current = String(targetNodeId)
          fileInputRef.current?.click()
          return
        }

				if (mode === 'assets') {
					await ensureLibraryLoaded();
					setActionDraftsByNodeId({
						[String(targetNodeId)]: createImageNodeDraft('assets')
					});
					handleOpenAssetSelector(targetNodeId, 'image');   // ✅ fixed
					return;
				}

        if (mode === 'comfy') {
          const workflows = await ensureComfyWorkflowsLoaded()
          const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

          setActionDraftsByNodeId({
            [String(targetNodeId)]: createImageNodeDraft('comfy', nodeInputSources, filterImageGenerationWorkflows(workflows || []))
          })
          return
        }

        const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

        setActionDraftsByNodeId({
          [String(targetNodeId)]: mode === 'comfy'
            ? createImageNodeDraft('comfy', nodeInputSources)
            : createImageNodeDraft(mode, nodeInputSources)
        })
      },
      onImageEditModeSelect: async (targetNodeId, mode) => {
        if (mode === 'edit-api' || mode === 'api') {
          await ensureLibraryLoaded()
        }

        if (mode === 'edit-comfy' || mode === 'comfy') {
          await ensureLibraryLoaded()
          const workflows = await ensureComfyWorkflowsLoaded()
          const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

          setActionDraftsByNodeId({
            [String(targetNodeId)]: createImageEditNodeDraft(
              mode,
              getConnectedInputAssetFrom(nodes, edges, targetNodeId),
              nodeInputSources,
              libraryImageOptions,
              filterImageEditWorkflows(workflows || [])
            )
          })
          return
        }

        const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

        setActionDraftsByNodeId({
          [String(targetNodeId)]: createImageEditNodeDraft(mode, getConnectedInputAssetFrom(nodes, edges, targetNodeId), nodeInputSources, libraryImageOptions)
        })
      },
      onMeshGenModeSelect: async (targetNodeId, mode) => {
        if (mode === 'api') {
          await ensureLibraryLoaded()
        }
				
				if (mode === 'assets') {
					await ensureLibraryLoaded();
					setActionDraftsByNodeId({
						[String(targetNodeId)]: createImageNodeDraft('assets')
					});
					handleOpenAssetSelector(targetNodeId, 'mesh');   // ✅ fixed
					return;
				}

        if (mode === 'comfy') {
          await ensureLibraryLoaded()
          const workflows = await ensureComfyWorkflowsLoaded()
          const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

          setActionDraftsByNodeId({
            [String(targetNodeId)]: createMeshGenNodeDraft(
              mode,
              getConnectedInputAssetFrom(nodes, edges, targetNodeId),
              nodeInputSources,
              libraryImageOptions,
              filterMeshGenerationWorkflows(workflows || [])
            )
          })
          return
        }

        const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

        setActionDraftsByNodeId({
          [String(targetNodeId)]: createMeshGenNodeDraft(mode, getConnectedInputAssetFrom(nodes, edges, targetNodeId), nodeInputSources, libraryImageOptions)
        })
      },
      onDraftFieldChange: (targetNodeId, field, value) => {
        setActionDraftsByNodeId(currentDrafts => {
          const nodeDraft = currentDrafts[String(targetNodeId)]
          if (!nodeDraft) {
            return currentDrafts
          }

          const targetInputSources = buildNodeInputSources(targetNodeId, nodes, edges)
          let nextDraft = {
            ...nodeDraft,
            [field]: value
          }

          if (field === 'workflowId') {
            const isEditNode = ['edit-api', 'edit-comfy'].includes(nodeDraft.mode)
            const isMeshGenNode = node.data.nodeKind === 'meshGen'
            const workflowList = isMeshGenNode
              ? meshGenerationWorkflows
              : isEditNode
                ? imageEditWorkflows
                : imageGenerationWorkflows
            const selectedWorkflow = workflowList.find(workflow => workflow.id == value) || null
            nextDraft = {
              ...nextDraft,
              inputs: (isEditNode || isMeshGenNode)
                ? createWorkflowDraftInputs(selectedWorkflow, (_parameter, valueType) => valueType === 'image'
                    ? ({ source: libraryImageOptions[0]?.sourceReference || '' })
                    : null)
                : createWorkflowDraftInputs(selectedWorkflow, () => null),
              inputBindings: (isEditNode || isMeshGenNode)
                ? createWorkflowDraftBindings(selectedWorkflow, targetInputSources, ['image'])
                : createWorkflowDraftBindings(selectedWorkflow, targetInputSources)
            }
          }

          return {
            [String(targetNodeId)]: nextDraft
          }
        })
      },
      onDraftInputChange: (targetNodeId, parameter, nextValue) => {
        setActionDraftsByNodeId(currentDrafts => {
          const nodeDraft = currentDrafts[String(targetNodeId)]
          if (!nodeDraft) {
            return currentDrafts
          }

          return {
            [String(targetNodeId)]: {
              ...nodeDraft,
              inputs: {
                ...(nodeDraft.inputs || {}),
                [parameter.id]: nextValue
              }
            }
          }
        })
      },
      onDraftInputSourceChange: (targetNodeId, parameter, source) => {
        setActionDraftsByNodeId(currentDrafts => {
          const nodeDraft = currentDrafts[String(targetNodeId)]
          if (!nodeDraft) {
            return currentDrafts
          }

          return {
            [String(targetNodeId)]: {
              ...nodeDraft,
              inputBindings: {
                ...(nodeDraft.inputBindings || {}),
                [parameter.id]: {
                  ...getWorkflowParameterBinding(nodeDraft, parameter),
                  source
                }
              }
            }
          }
        })
      },
      onRequestLocalFile: (targetNodeId) => {
        pendingUploadNodeIdRef.current = String(targetNodeId)
        fileInputRef.current?.click()
      },
      onAttachLibraryAsset: async (targetNodeId, libraryAsset) => {
        const assetType = libraryAsset.type || (node.data.nodeKind === 'meshGen' ? 'mesh' : 'image')
        const attachedAsset = await attachExistingAsset(project.id, {
          filename: libraryAsset.filename,
          type: assetType,
          name: libraryAsset.name,
          metadata: {
            ...(assetType === 'image' ? { resolution: 'Unknown' } : {}),
            format: libraryAsset.extension,
            source: 'ASSET LIB'
          }
        })
        const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
          assetId: attachedAsset.id,
          name: attachedAsset.name,
          status: null,
          progress: null,
          metadata: {
            lastAction: 'asset-library'
          }
        })
        replaceFlowNodeData(updatedNode)
        setActionDraftsByNodeId({})
      },
      onRunNodeAction: async (targetNodeId) => {
        const targetNode = nodes.find(item => item.id === String(targetNodeId))
        const targetDraft = actionDraftsByNodeId[String(targetNodeId)]
        if (!targetNode || !targetDraft) {
          return
        }

        const setProcessingState = async (status, progress = null, metadata = {}, transientData = {}) => {
          const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
            status,
            progress,
            metadata
          })
          replaceFlowNodeData(updatedNode)
          setNodeTransientData(targetNodeId, {
            progressDetail: transientData.progressDetail ?? null,
            currentNodeLabel: transientData.currentNodeLabel ?? null
          })
        }

        const applyNodeResult = async (asset, metadata = {}) => {
          const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
            assetId: asset.id,
            name: asset.name,
            status: null,
            progress: null,
            metadata
          })
          replaceFlowNodeData(updatedNode)
          setNodeTransientData(targetNodeId, {
            progressDetail: null,
            currentNodeLabel: null
          })
        }

        const spawnAdditionalResultNodes = async (nodeTypeName, assets) => {
          const sourceEdge = getInputSource(nodes, edges, targetNodeId, 'image').edge
          const baseX = targetNode.position.x
          const baseY = targetNode.position.y
          for (let index = 0; index < assets.length; index += 1) {
            const asset = assets[index]
            const createdNode = await handleCreateNode(nodeTypeName, {
              name: asset.name || nodeTypeName,
              assetId: asset.id,
              xPos: baseX + 360,
              yPos: baseY + ((index + 1) * 140),
              metadata: {
                createdFromNodeId: Number(targetNodeId)
              }
            })

            if ((nodeTypeName === 'Image Edit' || nodeTypeName === 'Mesh Gen') && sourceEdge) {
              const newConnection = await createProjectConnection(project.id, {
                sourceNodeId: Number(sourceEdge.source),
                targetNodeId: createdNode.id,
                inputId: DEFAULT_INPUT_ID,
                outputId: sourceEdge.sourceHandle || DEFAULT_OUTPUT_ID
              })

              setEdges(currentEdges => {
                const nextEdge = toFlowEdge(newConnection)
                if (currentEdges.some(edge => edge.id === nextEdge.id)) {
                  return currentEdges
                }
                return addEdge(nextEdge, currentEdges)
              })
            }
          }
        }

        if (targetNode.data.nodeKind === 'image') {
          const targetInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

          if (targetDraft.mode === 'api') {
            if (!targetDraft.selectedApi || !String(targetDraft.prompt || '').trim() || !String(targetDraft.name || '').trim()) {
              return
            }

            await setProcessingState('processing', null, { processingSource: 'API' })
            try {
              const generatedAsset = await generateImage(project.id, {
                selectedApi: targetDraft.selectedApi,
                prompt: targetDraft.prompt.trim(),
                name: targetDraft.name.trim()
              })
              await applyNodeResult(generatedAsset, { lastAction: 'image-api' })
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'Image generation failed' })
            }
            return
          }

          if (targetDraft.mode === 'comfy') {
            const workflow = imageGenerationWorkflows.find(item => item.id == targetDraft.workflowId)
            if (!workflow || !String(targetDraft.name || '').trim()) {
              return
            }

            const inputValues = {}
            for (const parameter of workflow.parameters || []) {
              const valueType = getWorkflowParameterValueType(parameter)
              const inputValue = resolveWorkflowParameterValue(parameter, targetDraft, targetInputSources)

              if (isFileWorkflowValueType(valueType)) {
                if (!inputValue) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'number') {
                if (String(inputValue ?? '').trim() === '' || Number.isNaN(Number(inputValue))) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'boolean') {
                inputValues[parameter.id] = Boolean(inputValue)
                continue
              }

              if (!String(inputValue ?? '').trim()) {
                return
              }

              inputValues[parameter.id] = inputValue
            }

            const promptId = createComfyExecutionId('graph-image-prompt')
            const clientId = createComfyExecutionId('graph-image-client')
            setActionDraftsByNodeId({})
            closeNodeProgressSubscription(targetNodeId)
            progressSubscriptionsRef.current.set(String(targetNodeId), subscribeToComfyWorkflowProgress(promptId, {
              onMessage: payload => {
                setNodes(current => current.map(item => (
                  item.id === String(targetNodeId)
                    ? {
                        ...item,
                        data: {
                          ...item.data,
                          status: payload?.status === 'error' ? 'error' : 'processing',
                          progress: Math.max(Number(item.data.progress) || 0, Number(payload?.progressPercent) || 0),
                          progressDetail: payload?.detail || item.data.progressDetail || null,
                          currentNodeLabel: payload?.currentNodeLabel || item.data.currentNodeLabel || null
                        }
                      }
                    : item
                )))
              },
              onError: () => {}
            }))

            await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId }, {
              progressDetail: 'Preparing ComfyUI workflow',
              currentNodeLabel: 'Waiting for ComfyUI execution to start'
            })
            try {
              const generatedAssets = await runComfyWorkflow(project.id, {
                workflowId: Number(targetDraft.workflowId),
                name: targetDraft.name.trim(),
                inputs: inputValues,
                promptId,
                clientId
              })
              const imageAssets = (Array.isArray(generatedAssets) ? generatedAssets : [generatedAssets]).filter(asset => asset?.type === 'image')
              if (imageAssets.length === 0) {
                throw new Error('The workflow did not return any image output')
              }
              setNodeTransientData(targetNodeId, {
                status: 'processing',
                progress: 100,
                progressDetail: 'Saving generated image',
                currentNodeLabel: 'ComfyUI workflow completed'
              })
              await applyNodeResult(imageAssets[0], { lastAction: 'comfy-workflow', promptId })
              if (imageAssets.length > 1) {
                await spawnAdditionalResultNodes('Image', imageAssets.slice(1))
              }
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI workflow failed', promptId })
            } finally {
              closeNodeProgressSubscription(targetNodeId)
            }
            return
          }

          if (targetDraft.mode === 'edit-api') {
            const selectedApiSource = resolveImageSourceOption(targetDraft.selectedInputSource, targetInputSources, libraryImageOptions)
            const sourceAsset = selectedApiSource?.asset || getConnectedInputAssetFrom(nodes, edges, targetNodeId)
            const sourceReference = selectedApiSource?.sourceReference || getAssetSourceReference(sourceAsset)
            if (!sourceReference) {
              return
            }

            if (!targetDraft.selectedApi || !String(targetDraft.prompt || '').trim() || !String(targetDraft.name || '').trim()) {
              return
            }

            await setProcessingState('processing', null, { processingSource: 'API', inputSource: sourceReference })
            try {
              const response = await runImageEditApi(project.id, {
                imageSource: sourceReference,
                name: targetDraft.name.trim(),
                selectedApi: targetDraft.selectedApi,
                prompt: targetDraft.prompt.trim()
              })
              const savedEdits = response?.savedEdits || []
              if (savedEdits.length === 0) {
                throw new Error('Image edit did not return any saved image')
              }
              await applyNodeResult({ id: savedEdits[0].id, name: savedEdits[0].name || targetDraft.name.trim() }, {
                lastAction: 'image-edit-api',
                inputSource: sourceReference
              })
              if (savedEdits.length > 1) {
                await spawnAdditionalResultNodes('Image', savedEdits.slice(1).map(edit => ({
                  id: edit.id,
                  name: edit.name || targetDraft.name.trim()
                })))
              }
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'Image edit failed', inputSource: sourceReference })
            }
            return
          }

          if (targetDraft.mode === 'edit-comfy') {
            const workflow = imageEditWorkflows.find(item => item.id == targetDraft.workflowId)
            if (!workflow || !String(targetDraft.name || '').trim()) {
              return
            }

            const inputValues = {}
            for (const parameter of workflow.parameters || []) {
              const valueType = getWorkflowParameterValueType(parameter)
              const inputValue = resolveWorkflowParameterValue(parameter, targetDraft, targetInputSources)

              if (isFileWorkflowValueType(valueType)) {
                if (!inputValue) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'number') {
                if (String(inputValue ?? '').trim() === '' || Number.isNaN(Number(inputValue))) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'boolean') {
                inputValues[parameter.id] = Boolean(inputValue)
                continue
              }

              if (!String(inputValue ?? '').trim()) {
                return
              }

              inputValues[parameter.id] = inputValue
            }

            const promptId = createComfyExecutionId('graph-image-edit-prompt')
            const clientId = createComfyExecutionId('graph-image-edit-client')
            setActionDraftsByNodeId({})
            closeNodeProgressSubscription(targetNodeId)
            progressSubscriptionsRef.current.set(String(targetNodeId), subscribeToComfyWorkflowProgress(promptId, {
              onMessage: payload => {
                setNodes(current => current.map(item => (
                  item.id === String(targetNodeId)
                    ? {
                        ...item,
                        data: {
                          ...item.data,
                          status: payload?.status === 'error' ? 'error' : 'processing',
                          progress: Math.max(Number(item.data.progress) || 0, Number(payload?.progressPercent) || 0),
                          progressDetail: payload?.detail || item.data.progressDetail || null,
                          currentNodeLabel: payload?.currentNodeLabel || item.data.currentNodeLabel || null
                        }
                      }
                    : item
                )))
              },
              onError: () => {}
            }))

            await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId }, {
              progressDetail: 'Preparing ComfyUI image edit',
              currentNodeLabel: 'Waiting for ComfyUI execution to start'
            })
            try {
              const response = await runImageEditComfy(project.id, {
                assetId: getConnectedInputAssetFrom(nodes, edges, targetNodeId)?.id || null,
                workflowId: Number(targetDraft.workflowId),
                name: targetDraft.name.trim(),
                inputValues,
                promptId,
                clientId
              })
              const savedEdits = response?.savedEdits || []
              if (savedEdits.length === 0) {
                throw new Error('ComfyUI image edit did not return any saved image')
              }
              setNodeTransientData(targetNodeId, {
                status: 'processing',
                progress: 100,
                progressDetail: 'Saving edited image',
                currentNodeLabel: 'ComfyUI image edit completed'
              })
              await applyNodeResult({ id: savedEdits[0].id, name: savedEdits[0].name || targetDraft.name.trim() }, {
                lastAction: 'image-edit-comfy',
                promptId,
                inputSource: JSON.stringify(inputValues)
              })
              if (savedEdits.length > 1) {
                await spawnAdditionalResultNodes('Image', savedEdits.slice(1).map(edit => ({
                  id: edit.id,
                  name: edit.name || targetDraft.name.trim()
                })))
              }
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI image edit failed', promptId })
            } finally {
              closeNodeProgressSubscription(targetNodeId)
            }
            return
          }

          return
        }

        const targetInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

        if (targetNode.data.nodeKind === 'meshGen') {
          if (targetDraft.mode === 'api') {
            const selectedApiSource = resolveImageSourceOption(targetDraft.selectedInputSource, targetInputSources, libraryImageOptions)
            const sourceAsset = selectedApiSource?.asset || getConnectedInputAssetFrom(nodes, edges, targetNodeId)
            const sourceReference = selectedApiSource?.sourceReference || getAssetSourceReference(sourceAsset)

            if (!sourceReference) {
              return
            }

            if (!targetDraft.selectedApi || !String(targetDraft.prompt || '').trim() || !String(targetDraft.name || '').trim()) {
              return
            }

            await setProcessingState('processing', null, { processingSource: 'API', inputSource: sourceReference })
            try {
              const response = await runMeshGenerationApi(project.id, {
                imageSource: sourceReference,
                name: targetDraft.name.trim(),
                selectedApi: targetDraft.selectedApi,
                prompt: targetDraft.prompt.trim()
              })
              const savedMeshes = (Array.isArray(response) ? response : [response]).filter(asset => asset?.type === 'mesh')
              if (savedMeshes.length === 0) {
                throw new Error('Mesh generation did not return any saved mesh')
              }
              await ensureGeneratedMeshThumbnails(savedMeshes)
              await applyNodeResult(savedMeshes[0], {
                lastAction: 'mesh-generation-api',
                inputSource: sourceReference
              })
              if (savedMeshes.length > 1) {
                await spawnAdditionalResultNodes('Mesh Gen', savedMeshes.slice(1))
              }
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'Mesh generation failed', inputSource: sourceReference })
            }
            return
          }

          if (targetDraft.mode === 'comfy') {
            const workflow = meshGenerationWorkflows.find(item => item.id == targetDraft.workflowId)
            if (!workflow || !String(targetDraft.name || '').trim()) {
              return
            }

            const inputValues = {}
            for (const parameter of workflow.parameters || []) {
              const valueType = getWorkflowParameterValueType(parameter)
              const inputValue = resolveWorkflowParameterValue(parameter, targetDraft, targetInputSources)

              if (isFileWorkflowValueType(valueType)) {
                if (!inputValue) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'number') {
                if (String(inputValue ?? '').trim() === '' || Number.isNaN(Number(inputValue))) {
                  return
                }
                inputValues[parameter.id] = inputValue
                continue
              }

              if (valueType === 'boolean') {
                inputValues[parameter.id] = Boolean(inputValue)
                continue
              }

              if (!String(inputValue ?? '').trim()) {
                return
              }

              inputValues[parameter.id] = inputValue
            }

            const promptId = createComfyExecutionId('graph-mesh-gen-prompt')
            const clientId = createComfyExecutionId('graph-mesh-gen-client')
            setActionDraftsByNodeId({})
            closeNodeProgressSubscription(targetNodeId)
            progressSubscriptionsRef.current.set(String(targetNodeId), subscribeToComfyWorkflowProgress(promptId, {
              onMessage: payload => {
                setNodes(current => current.map(item => (
                  item.id === String(targetNodeId)
                    ? {
                        ...item,
                        data: {
                          ...item.data,
                          status: payload?.status === 'error' ? 'error' : 'processing',
                          progress: Math.max(Number(item.data.progress) || 0, Number(payload?.progressPercent) || 0),
                          progressDetail: payload?.detail || item.data.progressDetail || null,
                          currentNodeLabel: payload?.currentNodeLabel || item.data.currentNodeLabel || null
                        }
                      }
                    : item
                )))
              },
              onError: () => {}
            }))

            await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId }, {
              progressDetail: 'Preparing ComfyUI mesh generation',
              currentNodeLabel: 'Waiting for ComfyUI execution to start'
            })
            try {
              const generatedAssets = await runComfyWorkflow(project.id, {
                workflowId: Number(targetDraft.workflowId),
                name: targetDraft.name.trim(),
                inputs: inputValues,
                promptId,
                clientId
              })
              const meshAssets = (Array.isArray(generatedAssets) ? generatedAssets : [generatedAssets]).filter(asset => asset?.type === 'mesh')
              if (meshAssets.length === 0) {
                throw new Error('The workflow did not return any mesh output')
              }
              await ensureGeneratedMeshThumbnails(meshAssets)
              setNodeTransientData(targetNodeId, {
                status: 'processing',
                progress: 100,
                progressDetail: 'Saving generated mesh',
                currentNodeLabel: 'ComfyUI mesh generation completed'
              })
              await applyNodeResult(meshAssets[0], { lastAction: 'mesh-generation-comfy', promptId })
              if (meshAssets.length > 1) {
                await spawnAdditionalResultNodes('Mesh Gen', meshAssets.slice(1))
              }
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI mesh generation failed', promptId })
            } finally {
              closeNodeProgressSubscription(targetNodeId)
            }
            return
          }
        }

        if (targetDraft.mode === 'api') {
          const selectedApiSource = resolveImageSourceOption(targetDraft.selectedInputSource, targetInputSources, libraryImageOptions)
          const sourceAsset = selectedApiSource?.asset || getConnectedInputAssetFrom(nodes, edges, targetNodeId)
          const sourceReference = selectedApiSource?.sourceReference || getAssetSourceReference(sourceAsset)
          if (!sourceReference) {
            return
          }

          if (!targetDraft.selectedApi || !String(targetDraft.prompt || '').trim() || !String(targetDraft.name || '').trim()) {
            return
          }

          await setProcessingState('processing', null, { processingSource: 'API', inputSource: sourceReference })
          try {
            const response = await runImageEditApi(project.id, {
              imageSource: sourceReference,
              name: targetDraft.name.trim(),
              selectedApi: targetDraft.selectedApi,
              prompt: targetDraft.prompt.trim()
            })
            const savedEdits = response?.savedEdits || []
            if (savedEdits.length === 0) {
              throw new Error('Image edit did not return any saved image')
            }
            await applyNodeResult({ id: savedEdits[0].id, name: savedEdits[0].name || targetDraft.name.trim() }, {
              lastAction: 'image-edit-api',
              inputSource: sourceReference
            })
            if (savedEdits.length > 1) {
              await spawnAdditionalResultNodes('Image Edit', savedEdits.slice(1).map(edit => ({
                id: edit.id,
                name: edit.name || targetDraft.name.trim()
              })))
            }
            setActionDraftsByNodeId({})
          } catch (err) {
            await setProcessingState('error', null, { error: err.message || 'Image edit failed', inputSource: sourceReference })
          }
          return
        }

        if (targetDraft.mode === 'comfy') {
          const workflow = imageEditWorkflows.find(item => item.id == targetDraft.workflowId)
          if (!workflow || !String(targetDraft.name || '').trim()) {
            return
          }

          const inputValues = {}
          for (const parameter of workflow.parameters || []) {
            const valueType = getWorkflowParameterValueType(parameter)
            const inputValue = resolveWorkflowParameterValue(parameter, targetDraft, targetInputSources)

            if (isFileWorkflowValueType(valueType)) {
              if (!inputValue) {
                return
              }
              inputValues[parameter.id] = inputValue
              continue
            }

            if (valueType === 'number') {
              if (String(inputValue ?? '').trim() === '' || Number.isNaN(Number(inputValue))) {
                return
              }
              inputValues[parameter.id] = inputValue
              continue
            }

            if (valueType === 'boolean') {
              inputValues[parameter.id] = Boolean(inputValue)
              continue
            }

            if (!String(inputValue ?? '').trim()) {
              return
            }

            inputValues[parameter.id] = inputValue
          }

          const promptId = createComfyExecutionId('graph-image-edit-prompt')
          const clientId = createComfyExecutionId('graph-image-edit-client')
          setActionDraftsByNodeId({})
          closeNodeProgressSubscription(targetNodeId)
          progressSubscriptionsRef.current.set(String(targetNodeId), subscribeToComfyWorkflowProgress(promptId, {
            onMessage: payload => {
              setNodes(current => current.map(item => (
                item.id === String(targetNodeId)
                  ? {
                      ...item,
                      data: {
                        ...item.data,
                        status: payload?.status === 'error' ? 'error' : 'processing',
                        progress: Math.max(Number(item.data.progress) || 0, Number(payload?.progressPercent) || 0),
                        progressDetail: payload?.detail || item.data.progressDetail || null,
                        currentNodeLabel: payload?.currentNodeLabel || item.data.currentNodeLabel || null
                      }
                    }
                  : item
              )))
            },
            onError: () => {}
          }))

          await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId }, {
            progressDetail: 'Preparing ComfyUI image edit',
            currentNodeLabel: 'Waiting for ComfyUI execution to start'
          })
          try {
            const response = await runImageEditComfy(project.id, {
              assetId: getConnectedInputAssetFrom(nodes, edges, targetNodeId)?.id || null,
              workflowId: Number(targetDraft.workflowId),
              name: targetDraft.name.trim(),
              inputValues,
              promptId,
              clientId
            })
            const savedEdits = response?.savedEdits || []
            if (savedEdits.length === 0) {
              throw new Error('ComfyUI image edit did not return any saved image')
            }
            setNodeTransientData(targetNodeId, {
              status: 'processing',
              progress: 100,
              progressDetail: 'Saving edited image',
              currentNodeLabel: 'ComfyUI image edit completed'
            })
            await applyNodeResult({ id: savedEdits[0].id, name: savedEdits[0].name || targetDraft.name.trim() }, {
              lastAction: 'image-edit-comfy',
              promptId,
              inputSource: JSON.stringify(inputValues)
            })
            if (savedEdits.length > 1) {
              await spawnAdditionalResultNodes('Image Edit', savedEdits.slice(1).map(edit => ({
                id: edit.id,
                name: edit.name || targetDraft.name.trim()
              })))
            }
          } catch (err) {
            await setProcessingState('error', null, { error: err.message || 'ComfyUI image edit failed', promptId })
          } finally {
            closeNodeProgressSubscription(targetNodeId)
          }
        }
      },
      onCloseAction: () => setActionDraftsByNodeId({})
    }
  })), [actionDraftsByNodeId, attachExistingAsset, closeNodeProgressSubscription, comfyLoading, createImageEditNodeDraft, createImageNodeDraft, createMeshGenNodeDraft, createProjectConnection, edges, ensureComfyWorkflowsLoaded, ensureGeneratedMeshThumbnails, ensureLibraryLoaded, generateImage, getConnectedInputAssetFrom, handleCreateNode, handleNodeNameChange, handleNodeNameCommit, handleNodeOutputValueChange, handleNodeOutputValueCommit, imageEditApis, imageEditWorkflows, imageGenerationApis, imageGenerationWorkflows, libraryImageOptions, libraryLoading, meshGenerationApis, meshGenerationWorkflows, nodes, openActionDraft, project.id, replaceFlowNodeData, runComfyWorkflow, runImageEditApi, runImageEditComfy, runMeshGenerationApi, setEdges, setNodeTransientData, setNodes, subscribeToComfyWorkflowProgress, updateProjectNode])

  const handleFileUpload = useCallback(async (event) => {
    const file = event.target.files?.[0]
    const nodeId = pendingUploadNodeIdRef.current
    event.target.value = ''

    if (!file || !nodeId) {
      pendingUploadNodeIdRef.current = null
      return
    }

    try {
      const uploadedAsset = await uploadAsset(project.id, file, 'image', {
        resolution: 'Unknown',
        format: file.type.split('/')[1]?.toUpperCase() || 'IMG',
        source: 'IMPORT'
      })
      const updatedNode = await updateProjectNode(project.id, Number(nodeId), {
        assetId: uploadedAsset.id,
        name: uploadedAsset.name,
        status: null,
        progress: null,
        metadata: {
          lastAction: 'local-upload'
        }
      })
      replaceFlowNodeData(updatedNode)
      setActionDraftsByNodeId({})
    } catch (err) {
      console.error('Failed to upload image to node:', err)
    } finally {
      pendingUploadNodeIdRef.current = null
    }
  }, [project.id, replaceFlowNodeData, updateProjectNode, uploadAsset])

  const handleDeleteConnection = useCallback(async (edgeToDelete) => {
    if (!edgeToDelete) {
      return
    }

    setEdges(currentEdges => currentEdges.filter(edge => edge.id !== edgeToDelete.id))

    try {
      await deleteProjectConnection(project.id, {
        sourceNodeId: Number(edgeToDelete.source),
        targetNodeId: Number(edgeToDelete.target),
        inputId: edgeToDelete.targetHandle || DEFAULT_INPUT_ID,
        outputId: edgeToDelete.sourceHandle || DEFAULT_OUTPUT_ID
      })
    } catch (err) {
      console.error('Failed to delete graph connection:', err)
    }
  }, [deleteProjectConnection, project.id, setEdges])

  const handleConnect = useCallback(async (connection) => {
    if (!connection.source || !connection.target) {
      return
    }

    const sourceNode = nodes.find(node => node.id === String(connection.source))
    const targetNode = nodes.find(node => node.id === String(connection.target))

    if (!sourceNode || !targetNode) {
      return
    }

    const targetHandleId = connection.targetHandle || DEFAULT_INPUT_ID
    if (targetNode.data.nodeKind === 'imageCompare') {
      if (!IMAGE_COMPARE_INPUT_IDS.includes(targetHandleId) || getNodeOutputType(sourceNode) !== 'image') {
        return
      }
    }

    if (edges.some(edge => edge.target === String(connection.target) && (edge.targetHandle || DEFAULT_INPUT_ID) === targetHandleId)) {
      return
    }

    const createdConnection = await createProjectConnection(project.id, {
      sourceNodeId: Number(connection.source),
      targetNodeId: Number(connection.target),
      inputId: targetHandleId,
      outputId: connection.sourceHandle || DEFAULT_OUTPUT_ID
    })

    setEdges(currentEdges => {
      const nextEdge = toFlowEdge(createdConnection)
      if (currentEdges.some(edge => edge.id === nextEdge.id)) {
        return currentEdges
      }

      return addEdge(nextEdge, currentEdges)
    })
  }, [createProjectConnection, edges, nodes, project.id, setEdges])

  const isValidConnection = useCallback((connection) => {
    if (!connection.source || !connection.target) {
      return false
    }

    const sourceNode = nodes.find(node => node.id === String(connection.source))
    const targetNode = nodes.find(node => node.id === String(connection.target))

    if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) {
      return false
    }

    const targetHandleId = connection.targetHandle || DEFAULT_INPUT_ID
    if (edges.some(edge => edge.target === String(connection.target) && (edge.targetHandle || DEFAULT_INPUT_ID) === targetHandleId)) {
      return false
    }

    if (targetNode.data.nodeKind === 'imageCompare') {
      return IMAGE_COMPARE_INPUT_IDS.includes(targetHandleId) && getNodeOutputType(sourceNode) === 'image'
    }

    return true
  }, [edges, nodes])

  const handlePaneClick = useCallback(() => {
    if (nodePicker) {
      setNodePicker(null)
    }
  }, [nodePicker])

  const handleNodeDragStop = useCallback(async (_event, node) => {
    try {
      await updateProjectNodePosition(project.id, Number(node.id), node.position)
    } catch (err) {
      console.error('Failed to persist node position:', err)
    }
  }, [project.id, updateProjectNodePosition])

  const handleEdgesDelete = useCallback(async (deletedEdges) => {
    await Promise.all(
      deletedEdges.map(edge => handleDeleteConnection(edge))
    )
  }, [handleDeleteConnection])

  const renderedEdges = useMemo(() => edges.map(edge => ({
    ...edge,
    data: {
      ...(edge.data || {}),
      onDelete: () => handleDeleteConnection(edge)
    }
  })), [edges, handleDeleteConnection])

  useEffect(() => {
    setActionDraftsByNodeId(currentDrafts => {
      const nextDrafts = Object.entries(currentDrafts).reduce((accumulator, [nodeId, draft]) => {
        const node = nodes.find(item => item.id === nodeId)
        if (!node || !draft) {
          return accumulator
        }

        const nodeInputSources = buildNodeInputSources(nodeId, nodes, edges)
        const isEditNode = node.data.nodeKind === 'imageEdit'
        const isMeshGenNode = node.data.nodeKind === 'meshGen'
        let nextDraft = draft

        if (draft.mode === 'api' && (isEditNode || isMeshGenNode)) {
          const validImageSelections = [
            ...getCompatibleInputSources(nodeInputSources, 'image').map(getInputSourceSelectionValue),
            ...libraryImageOptions.map(option => option.sourceReference).filter(Boolean)
          ]

          const nextSelectedInputSource = validImageSelections.includes(draft.selectedInputSource)
            ? draft.selectedInputSource
            : (validImageSelections[0] || '')

          if (nextSelectedInputSource !== draft.selectedInputSource) {
            nextDraft = {
              ...nextDraft,
              selectedInputSource: nextSelectedInputSource
            }
          }
        }

        if (draft.mode === 'comfy') {
          const workflowList = isMeshGenNode ? meshGenerationWorkflows : isEditNode ? imageEditWorkflows : imageGenerationWorkflows
          const selectedWorkflow = workflowList.find(workflow => workflow.id == draft.workflowId) || null

          if (selectedWorkflow) {
            const nextBindings = { ...(nextDraft.inputBindings || {}) }
            let bindingsChanged = false

            for (const parameter of selectedWorkflow.parameters || []) {
              const valueType = getWorkflowParameterValueType(parameter)
              const compatibleSources = getCompatibleInputSources(nodeInputSources, valueType)
              const currentBinding = getWorkflowParameterBinding(nextDraft, parameter)
              const currentSource = currentBinding.source || 'custom'
              let nextSource = currentSource

              if (currentSource !== 'custom' && !resolveSelectedInputSource(currentSource, compatibleSources)) {
                nextSource = compatibleSources[0]
                  ? getInputSourceSelectionValue(compatibleSources[0])
                  : 'custom'
              }

              if (nextSource !== currentSource) {
                nextBindings[parameter.id] = {
                  ...currentBinding,
                  source: nextSource
                }
                bindingsChanged = true
              }
            }

            if (bindingsChanged) {
              nextDraft = {
                ...nextDraft,
                inputBindings: nextBindings
              }
            }
          }
        }

        accumulator[nodeId] = nextDraft
        return accumulator
      }, {})

      const currentSerialized = JSON.stringify(currentDrafts)
      const nextSerialized = JSON.stringify(nextDrafts)
      return currentSerialized === nextSerialized ? currentDrafts : nextDrafts
    })
  }, [edges, imageEditWorkflows, imageGenerationWorkflows, libraryImageOptions, meshGenerationWorkflows, nodes])

  useEffect(() => {
    hasAutoFitOnLoadRef.current = false
  }, [project.id])

  useEffect(() => {
    if (!reactFlowInstance || loading || nodes.length === 0) {
      return
    }

    if (hasAutoFitOnLoadRef.current) {
      return
    }

    hasAutoFitOnLoadRef.current = true

    const fitWorkflow = () => {
      reactFlowInstance.fitView({
        padding: 0.18,
        duration: 300,
        includeHiddenNodes: true
      })
    }

    const frameId = window.requestAnimationFrame(() => {
      fitWorkflow()
    })
    const timeoutId = window.setTimeout(() => {
      fitWorkflow()
    }, 220)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
    }
  }, [edges.length, loading, nodes.length, project.id, reactFlowInstance])

  const showEmptyState = !loading && nodes.length === 0
  const minimapNodeColor = useCallback((node) => {
    if (node.type === 'meshGen') return '#79e388'
    if (node.type === 'imageCompare') return '#ff9a62'
    if (node.type === 'text') return '#ffd36e'
    if (node.type === 'boolean') return '#ff7fc8'
    if (node.type === 'number') return '#79e388'
    if (node.type === 'imageEdit') return '#ac89ff'
    return '#8ff5ff'
  }, [])

  return (
    <div className="graph-layout">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Workspace'}
        centerTitle
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
			
			{assetSelectorOpen && (
				<AssetSelectorModal
					assetType={assetSelectorType}
					onSelect={handleAssetSelected}
					onClose={() => {
						setAssetSelectorOpen(false);
						setPendingAssetNodeId(null);
						// Optionally clear the draft for the pending node if user cancels
						if (pendingAssetNodeId) {
							setActionDraftsByNodeId(prev => {
								const next = { ...prev };
								delete next[String(pendingAssetNodeId)];
								return next;
							});
						}
					}}
				/>
			)}			

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileUpload} />

      <div className="graph-page__body">
        <main className="graph-page__main" id="graph-main">
          <div className="graph-page__canvas-shell" ref={graphCanvasRef}>
            {showEmptyState && (
              <div className="graph-page__empty-state">
                <div className="graph-page__empty-icon">
                  <span className="material-symbols-outlined">account_tree</span>
                </div>
                <div className="graph-page__empty-copy">
                  <h2 className="graph-page__empty-title font-headline">Empty workflow graph</h2>
                  <p className="graph-page__empty-text">
                    Right-click anywhere on the graph to add a node.
                  </p>
                </div>
              </div>
            )}

            {loading && (
              <div className="graph-page__loading font-label">Loading graph…</div>
            )}

            {nodePicker && (
              <div
                className="graph-page__node-picker"
                style={{ left: `${nodePicker.menuX}px`, top: `${nodePicker.menuY}px` }}
              >
                <div className="graph-page__node-picker-title font-label">ADD NODE</div>
                <div className="graph-page__node-picker-options">
                  {GRAPH_NODE_TYPE_OPTIONS.map(nodeTypeName => (
                    <button
                      key={nodeTypeName}
                      type="button"
                      className="graph-page__node-picker-option"
                      onClick={() => handleCreateNodeFromPicker(nodeTypeName)}
                    >
                      {nodeTypeName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ReactFlow
              className="graph-page__canvas"
              nodes={renderedNodes}
              edges={renderedEdges}
              nodeTypes={flowNodeTypes}
              edgeTypes={flowEdgeTypes}
              onInit={setReactFlowInstance}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              isValidConnection={isValidConnection}
              onPaneClick={handlePaneClick}
              onPaneContextMenu={handlePaneContextMenu}
              onNodeDragStop={handleNodeDragStop}
              onEdgesDelete={handleEdgesDelete}
              defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
              minZoom={0.2}
              maxZoom={2}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="rgba(143, 245, 255, 0.14)" />
              <MiniMap pannable zoomable className="graph-page__minimap" nodeColor={minimapNodeColor} />
              <Controls className="graph-page__controls" showInteractive={false} />
            </ReactFlow>
          </div>
        </main>
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
