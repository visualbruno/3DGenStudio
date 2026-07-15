// Pure helpers and config constants for the node-graph editor (GraphPage).
// Extracted from GraphPage.jsx — no React, no component state.
import { assetUrl } from '../config'

export const DEFAULT_OUTPUT_ID = 'output-0'
export const DEFAULT_INPUT_ID = 'input-0'
export const IMAGE_COMPARE_NODE_TYPE_NAME = 'Image Compare'
export const IMAGE_COMPARE_INPUT_IDS = ['input-0', 'input-1']
export const LEGACY_INPUT_ID = 'image-input'
export const DEFAULT_CUSTOM_API_TYPE = 'image-generation'
export const TENCENT_MESH_GENERATION_API_ID = 'tencent_meshgeneration'
export const TRIPO_MESH_GENERATION_API_ID = 'tripo_meshgeneration'
export const HITEM_MESH_GENERATION_API_ID = 'hitem_meshgeneration'
export const TENCENT_MESH_API_OPTION = { id: TENCENT_MESH_GENERATION_API_ID, name: 'Tencent Cloud · Hunyuan3D Pro' }
export const TRIPO_MESH_API_OPTION = { id: TRIPO_MESH_GENERATION_API_ID, name: 'Tripo AI' }
export const HITEM_MESH_API_OPTION = { id: HITEM_MESH_GENERATION_API_ID, name: 'Hitem3D' }
export const TENCENT_REGION_OPTIONS = ['ap-singapore', 'eu-frankfurt', 'na-siliconvalley']
export const TENCENT_MODEL_VERSION_OPTIONS = ['3.0', '3.1']
export const TENCENT_GENERATION_TYPE_OPTIONS = ['Normal', 'LowPoly', 'Geometry']
export const TENCENT_POLYGON_TYPE_OPTIONS = ['triangle', 'quadrilaterial']
export const TRIPO_MODEL_VERSION_OPTIONS = ['v2.0-20240919', 'v2.5-20250123', 'v3.0-20250812', 'v3.1-20260211', 'Turbo-v1.0-20250506', 'P1-20260311']
export const TRIPO_TEXTURE_ALIGNMENT_OPTIONS = ['original_image', 'geometry']
export const TRIPO_TEXTURE_QUALITY_OPTIONS = ['standard', 'detailed']
export const TRIPO_ORIENTATION_OPTIONS = ['default', 'align_image']
export const TRIPO_GEOMETRY_QUALITY_OPTIONS = ['standard', 'detailed']
export const HITEM_MODEL_VERSION_OPTIONS = ['hitem3dv1.5', 'hitem3dv2.0', 'hitem3dv2.1']
// Resolution enum values are model-dependent (v2.1 differs from v1.5/v2.0).
export const HITEM_RESOLUTION_OPTIONS_BY_MODEL = {
  'hitem3dv1.5': ['512', '1024', '1536', '1536pro'],
  'hitem3dv2.0': ['512', '1024', '1536', '1536pro'],
  'hitem3dv2.1': ['1536fast', '1536pro']
}
export const HITEM_REQUEST_TYPE_OPTIONS = [
  { value: 1, label: 'Mesh Only' },
  { value: 3, label: 'Textured Mesh' }
]
export const HITEM_FACE_MIN = 100000
export const HITEM_FACE_MAX = 2000000

export function getHitemResolutionOptions(model) {
  return HITEM_RESOLUTION_OPTIONS_BY_MODEL[model] || HITEM_RESOLUTION_OPTIONS_BY_MODEL['hitem3dv2.1']
}
export const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai_gpt_image_1', name: 'OpenAI · gpt-image-1' },
  { id: 'openai_gpt_image_1_5', name: 'OpenAI · gpt-image-1.5' },
  { id: 'openai_gpt_image_2', name: 'OpenAI · gpt-image-2' }
]
export const GRAPH_NODE_TYPE_OPTIONS = ['Image', 'Mesh', IMAGE_COMPARE_NODE_TYPE_NAME, 'Number', 'Text', 'Boolean']
export const CONNECTOR_TYPE_META = {
  image: { key: 'image', label: 'Image', letter: 'I', color: '#8ff5ff', background: 'rgba(143, 245, 255, 0.14)' },
  mesh: { key: 'mesh', label: 'Mesh', letter: 'M', color: '#ac89ff', background: 'rgba(172, 137, 255, 0.14)' },
  video: { key: 'video', label: 'Video', letter: 'V', color: '#ff9a62', background: 'rgba(255, 154, 98, 0.14)' },
  number: { key: 'number', label: 'Number', letter: 'N', color: '#79e388', background: 'rgba(121, 227, 136, 0.14)' },
  text: { key: 'text', label: 'Text', letter: 'T', color: '#ffd36e', background: 'rgba(255, 211, 110, 0.16)' },
  boolean: { key: 'boolean', label: 'Boolean', letter: 'B', color: '#ff7fc8', background: 'rgba(255, 127, 200, 0.16)' },
  unknown: { key: 'unknown', label: 'Open', letter: '+', color: 'rgba(191, 196, 204, 0.8)', background: 'rgba(191, 196, 204, 0.12)' }
}

export function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit', 'mesh-texturing', 'mesh-rigging'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE
}

export function isTencentMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '') === TENCENT_MESH_GENERATION_API_ID
}

export function isTripoMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '') === TRIPO_MESH_GENERATION_API_ID
}

export function isHitemMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '') === HITEM_MESH_GENERATION_API_ID
}

export function canFetchTencentMeshResult(metadata = {}, status = null) {
  return isTencentMeshGenerationApi(metadata?.selectedApi)
    && status === 'processing'
    && ['RUN', 'WAIT'].includes(String(metadata?.jobStatus || '').toUpperCase())
    && metadata?.jobId
    && metadata?.region
}

export function canFetchTripoMeshResult(metadata = {}, status = null) {
  return isTripoMeshGenerationApi(metadata?.selectedApi)
    && status === 'processing'
    && ['queued', 'running'].includes(String(metadata?.taskStatus || '').toLowerCase())
    && metadata?.taskId
}

// Hitem3D reports a range of in-progress states (queueing, processing, running…),
// so keep the button available for any non-terminal task instead of allowlisting.
export const HITEM_TERMINAL_STATUSES = ['success', 'failed', 'error', 'fail']

export function canFetchHitemMeshResult(metadata = {}, status = null) {
  return isHitemMeshGenerationApi(metadata?.selectedApi)
    && status === 'processing'
    && !HITEM_TERMINAL_STATUSES.includes(String(metadata?.taskStatus || '').toLowerCase())
    && metadata?.taskId
}

export function getNodeKind(nodeTypeName = '') {
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

export function getDefaultNodeOutputType(nodeTypeName = '') {
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

export function getDefaultNodeOutputValue(nodeTypeName = '') {
  const nodeKind = getNodeKind(nodeTypeName)

  if (nodeKind === 'number') {
    return 0
  }

  if (nodeKind === 'boolean') {
    return false
  }

  return ''
}

export function getDefaultTargetInputId(nodeTypeName = '') {
  const nodeKind = getNodeKind(nodeTypeName)

  if (nodeKind === 'imageCompare') {
    return IMAGE_COMPARE_INPUT_IDS[0]
  }

  // Text nodes can run text-generating ComfyUI workflows, so they accept inputs
  // (e.g. an image to describe). Pure value nodes (number/boolean) do not.
  if (nodeKind === 'text') {
    return DEFAULT_INPUT_ID
  }

  if (isValueNodeKind(nodeKind)) {
    return null
  }

  return DEFAULT_INPUT_ID
}

export function canNodeTypeAcceptIncomingConnection(nodeTypeName = '', outputType = null) {
  const targetInputId = getDefaultTargetInputId(nodeTypeName)

  if (!targetInputId) {
    return false
  }

  if (getNodeKind(nodeTypeName) === 'imageCompare') {
    return normalizeConnectorType(outputType) === 'image'
  }

  return true
}

export function isValueNodeKind(nodeKind = '') {
  return ['number', 'text', 'boolean'].includes(String(nodeKind || '').trim().toLowerCase())
}

export function normalizeNodeOutputValue(nodeKind = '', value = null) {
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

export function normalizeConnectorType(type) {
  const normalizedType = String(type || '').trim().toLowerCase()

  if (['image', 'mesh', 'video', 'number', 'boolean'].includes(normalizedType)) {
    return normalizedType
  }

  if (['text', 'string', 'json'].includes(normalizedType)) {
    return 'text'
  }

  return null
}

export function getConnectorTypeMeta(type) {
  return CONNECTOR_TYPE_META[normalizeConnectorType(type) || 'unknown']
}

export function getNodeOutputType(node) {
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

export function getInputHandleIndex(handleId) {
  if (handleId === LEGACY_INPUT_ID) {
    return 0
  }

  const match = String(handleId || '').match(/(\d+)$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

export function compareHandleIds(leftHandleId, rightHandleId) {
  return getInputHandleIndex(leftHandleId) - getInputHandleIndex(rightHandleId)
}

export function getNextInputHandleId(usedHandleIds) {
  let nextIndex = 0

  while (usedHandleIds.includes(`input-${nextIndex}`)) {
    nextIndex += 1
  }

  return `input-${nextIndex}`
}

export function getConnectorPosition(index, total) {
  const safeTotal = Math.max(total, 1)
  return {
    top: `${((index + 1) / (safeTotal + 1)) * 100}%`
  }
}

export function buildInputConnectors(nodeId, currentNodes, currentEdges) {
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

export function getInputSource(currentNodes, currentEdges, nodeId, expectedType = null) {
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

export function formatAssetDimensions(width, height) {
  if (!width || !height) {
    return null
  }

  return `${width} × ${height}`
}

export function getAssetPreviewUrl(filename) {
  if (!filename) {
    return null
  }

  return assetUrl(filename)
}

export function appendCacheBust(url, cacheKey) {
  if (!url) {
    return null
  }

  return `${url}${url.includes('?') ? '&' : '?'}refresh=${encodeURIComponent(String(cacheKey))}`
}

export function buildMeshEditorPath({ asset, projectId, nodeId, returnTo }) {
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

export function buildImageEditorPath({ asset, projectId, nodeId, returnTo }) {
  const query = new URLSearchParams({
    assetId: String(asset?.id || ''),
    filePath: asset?.filePath || asset?.filename || '',
    url: asset?.filename ? getAssetPreviewUrl(asset.filename) : '',
    name: asset?.name || 'Image',
    projectId: String(projectId || ''),
    nodeId: String(nodeId || ''),
    returnTo
  })

  return `/image-editor?${query.toString()}`
}

export function buildEdgeId(connection) {
  return `edge:${connection.sourceNodeId}:${connection.outputId}:${connection.targetNodeId}:${connection.inputId}`
}

export function getPointerClientPosition(event) {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY }
  }

  const touch = event.changedTouches?.[0] || event.touches?.[0]
  if (touch) {
    return { x: touch.clientX, y: touch.clientY }
  }

  return null
}

export function toFlowEdge(connection) {
  return {
    id: buildEdgeId(connection),
    source: String(connection.sourceNodeId),
    target: String(connection.targetNodeId),
    sourceHandle: connection.outputId || DEFAULT_OUTPUT_ID,
    targetHandle: connection.inputId || DEFAULT_INPUT_ID,
    type: 'deletable',
    animated: false
  }
}

export function toBaseFlowNode(node, onDelete) {
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
      onGetAsyncMeshResult: null,
      onDraftFieldChange: null,
      onDraftInputChange: null,
      onRequestLocalFile: null,
      onAttachLibraryAsset: null,
      onRunNodeAction: null,
      onCloseAction: null
    }
  }
}

export function getWorkflowParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

export function isFileWorkflowValueType(valueType) {
  return ['image', 'video', 'mesh'].includes(valueType)
}

export const MESH_FILE_EXTENSIONS = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'usdz', 'usd', 'usda', 'usdc']

export function getWorkflowFileInputAccept(valueType) {
  if (valueType === 'video') return 'video/*'
  if (valueType === 'mesh') return MESH_FILE_EXTENSIONS.map(ext => `.${ext}`).join(',')
  return 'image/*'
}

export function getWorkflowFileInputIcon(valueType) {
  if (valueType === 'video') return 'video_file'
  if (valueType === 'mesh') return 'deployed_code'
  return 'image'
}

export function formatWorkflowDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function createComfyExecutionId(prefix = 'comfy') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

export function getAssetSourceReference(asset) {
  if (!asset?.id) {
    return ''
  }

  if (asset.parentId || asset.metadata?.editId) {
    return `edit:${asset.filePath}`
  }

  return `asset:${asset.id}`
}

export function createWorkflowDraftInputs(workflow, resolver = () => null) {
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

export function getInputSourceSelectionValue(inputSource) {
  return inputSource?.connectorId ? `connector:${inputSource.connectorId}` : ''
}

export function buildNodeInputSources(nodeId, currentNodes, currentEdges) {
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

export function filterMeshGenerationWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')
    return outputValueTypes.includes('mesh')
  })
}

export function getCompatibleInputSources(inputSources, valueType) {
  const normalizedValueType = normalizeConnectorType(valueType)
  return (inputSources || []).filter(source => normalizeConnectorType(source.type) === normalizedValueType)
}

export function createWorkflowDraftBindings(workflow, inputSources = [], preferredConnectorTypes = []) {
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

export function getWorkflowParameterBinding(draft, parameter) {
  return draft?.inputBindings?.[parameter.id] || { source: 'custom' }
}

export function resolveSelectedInputSource(sourceSelection, inputSources = []) {
  if (!String(sourceSelection || '').startsWith('connector:')) {
    return null
  }

  const connectorId = String(sourceSelection).slice(10)
  return (inputSources || []).find(source => source.connectorId === connectorId) || null
}

export function resolveWorkflowParameterValue(parameter, draft, inputSources = []) {
  const binding = getWorkflowParameterBinding(draft, parameter)
  if (binding.source && binding.source !== 'custom') {
    const selectedSource = resolveSelectedInputSource(binding.source, inputSources)
    return selectedSource?.value ?? null
  }

  return draft?.inputs?.[parameter.id]
}

// --- Last action parameter snapshots -------------------------------------
// A "last action" snapshot is a display-ready record of the parameters that
// produced a node's current result. It is serialized into node.metadata so the
// (i) popover can show it later without re-resolving anything. Only ComfyUI and
// external API actions are recorded.

export function formatLastActionValue(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') {
    if (value.source) return String(value.source)
    return JSON.stringify(value)
  }
  return String(value)
}

// Build the labeled-value list for a ComfyUI workflow run from the resolved
// inputValues, mapping each value back to its parameter definition and noting
// when a value came from a connected node (boundFrom).
export function describeWorkflowParams(workflow, inputValues = {}, draft = null, inputSources = []) {
  return (workflow?.parameters || []).map(parameter => {
    const valueType = getWorkflowParameterValueType(parameter)
    const binding = getWorkflowParameterBinding(draft, parameter)
    let boundFrom = null
    if (binding.source && binding.source !== 'custom') {
      boundFrom = resolveSelectedInputSource(binding.source, inputSources)?.label || null
    }

    return {
      label: parameter.name || parameter.label || String(parameter.id),
      type: valueType,
      value: inputValues?.[parameter.id],
      boundFrom
    }
  })
}

// Wrap a params list into the stored snapshot shape. `params` is an array of
// { label, type, value, boundFrom } entries (e.g. from describeWorkflowParams
// or built inline for external API actions). Raw values are formatted here so
// callers can pass booleans/numbers/objects directly.
export function buildLastActionParams({ source, label = null, params = [], ranAt = null }) {
  return {
    source,
    label: label || null,
    ranAt: ranAt || new Date().toISOString(),
    params: (params || [])
      .filter(param => param && param.label)
      .map(param => ({
        label: param.label,
        type: param.type || 'string',
        value: formatLastActionValue(param.value),
        boundFrom: param.boundFrom || null
      }))
  }
}

export function resolveImageSourceOption(sourceSelection, inputSources = [], libraryOptions = []) {
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

export function filterImageGenerationWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')
    return outputValueTypes.includes('image')
  })
}

export function filterImageEditWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const parameterValueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

    return outputValueTypes.includes('image')
      && parameterValueTypes.every(valueType => ['image', 'string', 'number', 'boolean'].includes(valueType))
  })
}

export function filterTextGenerationWorkflows(workflows = []) {
  return workflows.filter(workflow => {
    const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')
    return outputValueTypes.includes('string')
  })
}
