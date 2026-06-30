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
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext.shared'
import { useNotifications } from '../context/NotificationContext'
import { useWorkflowJobs } from '../context/WorkflowJobsContext'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import '@xyflow/react/dist/style.css'
import './KanbanPage.css'
import './GraphPage.css'
import AssetSelectorModal from '../components/AssetSelectorModal';
import {
  CONNECTOR_TYPE_META,
  DEFAULT_CUSTOM_API_TYPE,
  DEFAULT_INPUT_ID,
  DEFAULT_OUTPUT_ID,
  GRAPH_NODE_TYPE_OPTIONS,
  IMAGE_API_LIST,
  IMAGE_COMPARE_INPUT_IDS,
  IMAGE_COMPARE_NODE_TYPE_NAME,
  LEGACY_INPUT_ID,
  TENCENT_GENERATION_TYPE_OPTIONS,
  TENCENT_MESH_API_OPTION,
  TENCENT_MESH_GENERATION_API_ID,
  TENCENT_MODEL_VERSION_OPTIONS,
  TENCENT_POLYGON_TYPE_OPTIONS,
  TENCENT_REGION_OPTIONS,
  TRIPO_GEOMETRY_QUALITY_OPTIONS,
  TRIPO_MESH_API_OPTION,
  TRIPO_MESH_GENERATION_API_ID,
  TRIPO_MODEL_VERSION_OPTIONS,
  TRIPO_ORIENTATION_OPTIONS,
  TRIPO_TEXTURE_ALIGNMENT_OPTIONS,
  TRIPO_TEXTURE_QUALITY_OPTIONS,
  buildInputConnectors,
  buildLastActionParams,
  buildNodeInputSources,
  canFetchTencentMeshResult,
  canFetchTripoMeshResult,
  canNodeTypeAcceptIncomingConnection,
  createComfyExecutionId,
  createWorkflowDraftBindings,
  createWorkflowDraftInputs,
  describeWorkflowParams,
  filterImageEditWorkflows,
  filterImageGenerationWorkflows,
  filterMeshGenerationWorkflows,
  filterTextGenerationWorkflows,
  getAssetPreviewUrl,
  getAssetSourceReference,
  getCompatibleInputSources,
  getDefaultNodeOutputType,
  getDefaultNodeOutputValue,
  getDefaultTargetInputId,
  getInputSource,
  getInputSourceSelectionValue,
  getNodeKind,
  getNodeOutputType,
  getPointerClientPosition,
  getWorkflowParameterBinding,
  getWorkflowParameterValueType,
  isFileWorkflowValueType,
  isTencentMeshGenerationApi,
  isTripoMeshGenerationApi,
  isValueNodeKind,
  normalizeCustomApiType,
  normalizeNodeOutputValue,
  resolveImageSourceOption,
  resolveSelectedInputSource,
  resolveWorkflowParameterValue,
  toBaseFlowNode,
  toFlowEdge
} from '../utils/graphHelpers'
import GraphAssetNode from '../components/graph/GraphAssetNode'
import GraphDeleteEdge from '../components/graph/GraphDeleteEdge'
import GraphImageCompareNode from '../components/graph/GraphImageCompareNode'
import GraphValueNode from '../components/graph/GraphValueNode'
import { saveWorkflowDefaults } from '../utils/workflowDefaults'

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
    updateComfyWorkflow,
    runComfyWorkflow,
    runImageEditApi,
    runImageEditComfy,
    runMeshGenerationApi,
    queryTencentMeshGenerationResult,
    queryTripoMeshGenerationResult
  } = useProjects()
  const { settings } = useSettings()
  const { addNotification } = useNotifications()
  const { jobs: workflowJobs, registerJob, completeJob, removeJobsForTarget } = useWorkflowJobs()

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
	const [assetSelectorShowEdits, setAssetSelectorShowEdits] = useState(true);

  const fileInputRef = useRef(null)
  const pendingUploadNodeIdRef = useRef(null)
  const pendingConnectionRef = useRef(null)
  const skipNextPaneClickRef = useRef(false)
  const libraryLoadedRef = useRef(false)
  const workflowsLoadedRef = useRef(false)
  const graphCanvasRef = useRef(null)
  const hasAutoFitOnLoadRef = useRef(false)

  const pushMeshGenerationFailureNotification = useCallback((message, source = 'Mesh generation API') => {
    addNotification({
      title: 'Mesh generation failed',
      message: message || 'Mesh generation request failed',
      source,
      tone: 'error'
    })
  }, [addNotification])

  const pushExternalApiFailureNotification = useCallback((title, message, source = 'External API') => {
    addNotification({
      title,
      message: message || 'External API request failed',
      source,
      tone: 'error'
    })
  }, [addNotification])

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
    [
      TENCENT_MESH_API_OPTION,
      TRIPO_MESH_API_OPTION,
      ...customApis
        .filter(api => normalizeCustomApiType(api?.type) === 'mesh-generation')
        .map(api => ({ id: `custom_${api.id}`, name: api.name }))
    ]
  ), [customApis])

  const imageGenerationWorkflows = useMemo(() => filterImageGenerationWorkflows(comfyWorkflows), [comfyWorkflows])

  const imageEditWorkflows = useMemo(() => filterImageEditWorkflows(comfyWorkflows), [comfyWorkflows])

  const meshGenerationWorkflows = useMemo(() => filterMeshGenerationWorkflows(comfyWorkflows), [comfyWorkflows])

  const textGenerationWorkflows = useMemo(() => filterTextGenerationWorkflows(comfyWorkflows), [comfyWorkflows])

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

  const createTextNodeDraft = useCallback((mode = 'select', inputSources = [], workflowListOverride = null) => {
    const workflowList = workflowListOverride || textGenerationWorkflows
    const defaultWorkflow = workflowList[0] || null
    return {
      mode,
      workflowId: defaultWorkflow?.id || '',
      inputs: mode === 'comfy'
        ? createWorkflowDraftInputs(defaultWorkflow, () => null)
        : {},
      inputBindings: mode === 'comfy'
        ? createWorkflowDraftBindings(defaultWorkflow, inputSources, ['string', 'number', 'boolean'])
        : {}
    }
  }, [textGenerationWorkflows])

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
        ? (getInputSourceSelectionValue(defaultImageInputSource) || sourceReference || '')
        : '',
      workflowId: defaultWorkflow?.id || '',
      inputs: mode === 'comfy'
        ? createWorkflowDraftInputs(defaultWorkflow, (_parameter, valueType) => valueType === 'image'
            ? ({ source: libraryOptions[0]?.sourceReference || sourceReference || '' })
            : null)
        : {},
      inputBindings: mode === 'comfy'
        ? createWorkflowDraftBindings(defaultWorkflow, inputSources, ['image'])
        : {},
      region: 'eu-frankfurt',
      modelVersion: '3.0',
      enablePBR: false,
      faceCount: 500000,
      generationType: 'Normal',
      polygonType: 'triangle',
      modelSeed: '',
      enableImageAutofix: false,
      faceLimit: '',
      texture: true,
      pbr: true,
      textureSeed: '',
      textureAlignment: 'original_image',
      textureQuality: 'standard',
      autoSize: false,
      orientation: 'default',
      quad: false,
      smartLowPoly: false,
      generateParts: false,
      exportUv: true,
      geometryQuality: 'standard'
    }
  }, [meshGenerationApis, meshGenerationWorkflows])

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

  // Live workflow progress is owned by the app-level WorkflowJobs store so it
  // survives navigating away from this page. While the page is mounted, mirror
  // the progress of any in-flight job onto its node for display.
  useEffect(() => {
    if (!project?.id) {
      return
    }
    const activeJobs = workflowJobs.filter(job => (
      job.projectId === project.id
      && job.page === 'graph'
      && job.targetId
      && (job.status === 'queued' || job.status === 'processing')
    ))
    if (activeJobs.length === 0) {
      return
    }
    setNodes(current => {
      let changed = false
      const next = current.map(item => {
        const job = activeJobs.find(candidate => candidate.targetId === item.id)
        if (!job) {
          return item
        }
        const nextStatus = job.status === 'error' ? 'error' : 'processing'
        const nextProgress = Math.max(Number(item.data.progress) || 0, Number(job.progressPercent) || 0)
        const nextDetail = job.detail || item.data.progressDetail || null
        const nextLabel = job.currentNodeLabel || item.data.currentNodeLabel || null
        if (
          item.data.status === nextStatus
          && item.data.progress === nextProgress
          && item.data.progressDetail === nextDetail
          && item.data.currentNodeLabel === nextLabel
        ) {
          return item
        }
        changed = true
        return {
          ...item,
          data: {
            ...item.data,
            status: nextStatus,
            progress: nextProgress,
            progressDetail: nextDetail,
            currentNodeLabel: nextLabel
          }
        }
      })
      return changed ? next : current
    })
  }, [workflowJobs, project?.id, setNodes])

  const handleDeleteNode = useCallback(async (nodeId) => {
    removeJobsForTarget(project.id, nodeId)
    await deleteProjectNode(project.id, Number(nodeId))
    setNodes(currentNodes => currentNodes.filter(node => node.id !== String(nodeId)))
    setEdges(currentEdges => currentEdges.filter(edge => edge.source !== String(nodeId) && edge.target !== String(nodeId)))
    setActionDraftsByNodeId(currentDrafts => {
      const nextDrafts = { ...currentDrafts }
      delete nextDrafts[String(nodeId)]
      return nextDrafts
    })
  }, [removeJobsForTarget, deleteProjectNode, project.id, setEdges, setNodes])

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

  // Persist current field values as the workflow's defaults when "Set as default" is checked,
  // then refresh the in-memory workflow list so later nodes pick up the new defaults.
  const persistWorkflowDefaultsIfRequested = useCallback(async (draft, workflow, values) => {
    if (!draft?.setAsDefault) return
    const saved = await saveWorkflowDefaults(updateComfyWorkflow, workflow, values)
    if (saved) {
      try {
        setComfyWorkflows(await getComfyWorkflows())
      } catch (err) {
        console.error('Failed to refresh ComfyUI workflows:', err)
      }
    }
  }, [getComfyWorkflows, updateComfyWorkflow])

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

  const openNodePickerAt = useCallback((clientX, clientY, pendingConnection = null) => {
    const canvasBounds = graphCanvasRef.current?.getBoundingClientRect()
    const flowPosition = reactFlowInstance?.screenToFlowPosition
      ? reactFlowInstance.screenToFlowPosition({ x: clientX, y: clientY })
      : { x: 96, y: 96 }

    setNodePicker({
      menuX: canvasBounds ? clientX - canvasBounds.left : clientX,
      menuY: canvasBounds ? clientY - canvasBounds.top : clientY,
      flowX: flowPosition.x,
      flowY: flowPosition.y,
      pendingConnection
    })
  }, [reactFlowInstance])

  const handlePaneContextMenu = useCallback((event) => {
    event.preventDefault()
    openNodePickerAt(event.clientX, event.clientY)
  }, [openNodePickerAt])

  const handleCreateNodeFromPicker = useCallback(async (nodeTypeName) => {
    if (!nodePicker) {
      return
    }

    const createdNode = await handleCreateNode(nodeTypeName, {
      xPos: nodePicker.flowX,
      yPos: nodePicker.flowY
    })

    if (nodePicker.pendingConnection && canNodeTypeAcceptIncomingConnection(nodeTypeName, nodePicker.pendingConnection.outputType)) {
      try {
        const createdConnection = await createProjectConnection(project.id, {
          sourceNodeId: Number(nodePicker.pendingConnection.sourceNodeId),
          targetNodeId: Number(createdNode.id),
          inputId: getDefaultTargetInputId(nodeTypeName),
          outputId: nodePicker.pendingConnection.outputId || DEFAULT_OUTPUT_ID
        })

        setEdges(currentEdges => {
          const nextEdge = toFlowEdge(createdConnection)
          if (currentEdges.some(edge => edge.id === nextEdge.id)) {
            return currentEdges
          }

          return addEdge(nextEdge, currentEdges)
        })
      } catch (err) {
        console.error('Failed to connect newly created graph node:', err)
      }
    }

    setNodePicker(null)
  }, [createProjectConnection, handleCreateNode, nodePicker, project.id, setEdges])

  const handleConnectStart = useCallback((_event, params) => {
    if (params?.handleType !== 'source' || !params?.nodeId) {
      pendingConnectionRef.current = null
      return
    }

    const sourceNode = nodes.find(node => node.id === String(params.nodeId))
    pendingConnectionRef.current = {
      sourceNodeId: String(params.nodeId),
      outputId: params.handleId || DEFAULT_OUTPUT_ID,
      outputType: getNodeOutputType(sourceNode)
    }
  }, [nodes])

  const handleConnectEnd = useCallback((event, connectionState) => {
    const pendingConnection = pendingConnectionRef.current
    pendingConnectionRef.current = null

    if (!pendingConnection || connectionState?.isValid) {
      return
    }

    const pointerPosition = getPointerClientPosition(event)
    if (!pointerPosition) {
      return
    }

    const canvasBounds = graphCanvasRef.current?.getBoundingClientRect()
    if (canvasBounds) {
      const droppedInsideCanvas = (
        pointerPosition.x >= canvasBounds.left
        && pointerPosition.x <= canvasBounds.right
        && pointerPosition.y >= canvasBounds.top
        && pointerPosition.y <= canvasBounds.bottom
      )

      if (!droppedInsideCanvas) {
        return
      }
    }

    skipNextPaneClickRef.current = true
    openNodePickerAt(pointerPosition.x, pointerPosition.y, pendingConnection)
  }, [openNodePickerAt])

  const openActionDraft = useCallback((nodeId, nodeKind) => {
    const inputSources = buildNodeInputSources(nodeId, nodes, edges)
    setActionDraftsByNodeId({
      [String(nodeId)]: nodeKind === 'meshGen'
        ? createMeshGenNodeDraft('select', getConnectedInputAssetFrom(nodes, edges, nodeId), inputSources, libraryImageOptions)
        : nodeKind === 'imageEdit'
        ? createImageEditNodeDraft('select', getConnectedInputAssetFrom(nodes, edges, nodeId), inputSources, libraryImageOptions)
        : nodeKind === 'text'
        ? createTextNodeDraft('select', inputSources)
        : createImageNodeDraft('select', inputSources)
    })
  }, [createImageEditNodeDraft, createImageNodeDraft, createMeshGenNodeDraft, createTextNodeDraft, edges, getConnectedInputAssetFrom, libraryImageOptions, nodes])

	const handleOpenAssetSelector = useCallback((nodeId, type, showEdits = true) => {
		setAssetSelectorType(type === 'mesh' ? 'mesh' : 'image');
		setPendingAssetNodeId(nodeId);
		setAssetSelectorOpen(true);
		setAssetSelectorShowEdits(showEdits);
	}, []);	

	const handleAssetSelected = useCallback(async (asset) => {
		if (!pendingAssetNodeId) return;

		if (!asset) {
			console.error('No asset provided');
			return;
		}

		const assetType = assetSelectorType; // 'image' or 'mesh'
		try {
			// A library version/edit (child asset) already exists as its own row and
			// owns a unique file. Reference it directly instead of attaching it: going
			// through attachExistingAsset would mint a NEW root-level asset pointing at
			// the version's file, which (a) surfaces a duplicate at the root of the
			// asset library, (b) has no thumbnail (the link lookup only finds roots),
			// and (c) shares the file, so deleting that root nukes the version's mesh.
			const versionAssetId = (asset.isChild || asset.isEdit) ? Number(asset.id) : NaN;
			const isLibraryVersion = Number.isFinite(versionAssetId) && versionAssetId > 0;

			let resolvedAssetId;
			let resolvedName;

			if (isLibraryVersion) {
				resolvedAssetId = versionAssetId;
				resolvedName = asset.name;
			} else {
				// Root library asset: attach a project-scoped reference as before.
				const attachedAsset = await attachExistingAsset(project.id, {
					filename: asset.filename || asset.filePath,
					type: assetType,
					name: asset.name,
					metadata: {
						format: asset.extension || (asset.filename?.split('.').pop() || '').toUpperCase(),
						source: 'ASSET LIB'
					}
				});
				resolvedAssetId = attachedAsset.id;
				resolvedName = attachedAsset.name;
			}

			// Update the graph node – IMPORTANT: use the returned updated node directly
			const updatedNode = await updateProjectNode(project.id, Number(pendingAssetNodeId), {
				assetId: resolvedAssetId,
				name: resolvedName,
				status: null,
				progress: null,
				metadata: { lastAction: 'asset-library' }
			});

			// 3. Apply the fresh node data to the React Flow state
			if (updatedNode) replaceFlowNodeData(updatedNode);

			// 4. Clear the draft panel for this node
			setActionDraftsByNodeId(prev => {
				const next = { ...prev };
				delete next[String(pendingAssetNodeId)];
				return next;
			});
		} catch (err) {
			console.error('Failed to attach asset to node:', err);
			// Optional: show user-friendly error (you can integrate a toast/notification here)
		} finally {
			setAssetSelectorOpen(false);
			setPendingAssetNodeId(null);
		}
	}, [attachExistingAsset, assetSelectorType, pendingAssetNodeId, project.id, updateProjectNode, replaceFlowNodeData, setActionDraftsByNodeId]);

  const renderedNodes = useMemo(() => nodes.map(node => {
    const nodeInputConnectors = buildInputConnectors(node.id, nodes, edges)
    const nodeInputSources = buildNodeInputSources(node.id, nodes, edges)

    return ({
    ...node,
    dragHandle: isValueNodeKind(node.data.nodeKind)
      ? '.graph-node__value-card'
      : node.data.nodeKind === 'imageCompare'
        ? '.graph-node__compare-header'
        : '.graph-node__card',
    data: {
      ...node.data,
      inputConnectors: nodeInputConnectors,
      inputSources: nodeInputSources,
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
      textGenerationWorkflows,
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
					handleOpenAssetSelector(targetNodeId, 'image');
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
					handleOpenAssetSelector(targetNodeId, 'mesh');
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
      onTextModeSelect: async (targetNodeId, mode) => {
        if (mode === 'comfy') {
          const workflows = await ensureComfyWorkflowsLoaded()
          const nodeInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

          setActionDraftsByNodeId({
            [String(targetNodeId)]: createTextNodeDraft('comfy', nodeInputSources, filterTextGenerationWorkflows(workflows || []))
          })
          return
        }

        setActionDraftsByNodeId({
          [String(targetNodeId)]: createTextNodeDraft('select', buildNodeInputSources(targetNodeId, nodes, edges))
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
            const isTextNode = node.data.nodeKind === 'text'
            const workflowList = isTextNode
              ? textGenerationWorkflows
              : isMeshGenNode
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
              inputBindings: isTextNode
                ? createWorkflowDraftBindings(selectedWorkflow, targetInputSources, ['string', 'number', 'boolean'])
                : (isEditNode || isMeshGenNode)
                  ? createWorkflowDraftBindings(selectedWorkflow, targetInputSources, ['image'])
                  : createWorkflowDraftBindings(selectedWorkflow, targetInputSources)
            }
          }

          if (field === 'selectedApi' && node.data.nodeKind === 'meshGen') {
            const defaultImageInputSource = getCompatibleInputSources(targetInputSources, 'image')[0] || null
            const isAsyncImageConnectorApi = isTencentMeshGenerationApi(value) || isTripoMeshGenerationApi(value)
            nextDraft = {
              ...nextDraft,
              selectedInputSource: isAsyncImageConnectorApi
                ? (getInputSourceSelectionValue(defaultImageInputSource) || '')
                : (nextDraft.selectedInputSource || getInputSourceSelectionValue(defaultImageInputSource) || libraryImageOptions[0]?.sourceReference || ''),
              modelVersion: isTripoMeshGenerationApi(value)
                ? (TRIPO_MODEL_VERSION_OPTIONS.includes(nextDraft.modelVersion) ? nextDraft.modelVersion : 'v2.5-20250123')
                : (TENCENT_MODEL_VERSION_OPTIONS.includes(nextDraft.modelVersion) ? nextDraft.modelVersion : '3.0')
            }
          }

          if (field === 'generationType' && value !== 'LowPoly') {
            nextDraft = {
              ...nextDraft,
              polygonType: 'triangle'
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

        if (targetNode.data.nodeKind === 'text') {
          if (targetDraft.mode !== 'comfy') {
            return
          }

          const workflow = textGenerationWorkflows.find(item => item.id == targetDraft.workflowId)
          if (!workflow) {
            return
          }

          const targetInputSources = buildNodeInputSources(targetNodeId, nodes, edges)
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

          const promptId = createComfyExecutionId('graph-text-prompt')
          const clientId = createComfyExecutionId('graph-text-client')
          setActionDraftsByNodeId({})
          registerJob({
            id: promptId,
            projectId: project.id,
            projectName: project.name,
            page: 'graph',
            targetId: targetNodeId,
            kind: 'text',
            label: targetNode.data.name || workflow.name
          })

          await setProcessingState('processing', 0, { processingSource: 'ComfyUI', promptId }, {
            progressDetail: 'Preparing ComfyUI workflow',
            currentNodeLabel: 'Waiting for ComfyUI execution to start'
          })
          try {
            const results = await runComfyWorkflow(project.id, {
              workflowId: Number(targetDraft.workflowId),
              name: targetNode.data.name || workflow.name,
              inputs: inputValues,
              promptId,
              clientId,
              persistProcessingCard: false,
              persistGeneratedAssets: false
            })
            const textResult = (Array.isArray(results) ? results : [results]).find(item => item?.type === 'text')
            if (!textResult || typeof textResult.text !== 'string') {
              throw new Error('The workflow did not return any text output')
            }
            setNodeTransientData(targetNodeId, {
              status: 'processing',
              progress: 100,
              progressDetail: 'Saving generated text',
              currentNodeLabel: 'ComfyUI workflow completed'
            })
            const updatedNode = await updateProjectNode(project.id, Number(targetNodeId), {
              status: null,
              progress: null,
              metadata: {
                outputValue: textResult.text,
                lastAction: 'comfy-text',
                promptId,
                lastActionParams: buildLastActionParams({
                  source: 'ComfyUI',
                  label: workflow.name,
                  params: describeWorkflowParams(workflow, inputValues, targetDraft, targetInputSources)
                })
              }
            })
            replaceFlowNodeData(updatedNode)
            setNodeTransientData(targetNodeId, {
              progressDetail: null,
              currentNodeLabel: null
            })
            completeJob(promptId, { status: 'completed' })
          } catch (err) {
            await setProcessingState('error', null, { error: err.message || 'ComfyUI workflow failed', promptId })
            completeJob(promptId, { status: 'error', error: err.message || 'ComfyUI workflow failed' })
          }
          return
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
              await applyNodeResult(generatedAsset, {
                lastAction: 'image-api',
                lastActionParams: buildLastActionParams({
                  source: 'API',
                  label: imageGenerationApis.find(api => api.id === targetDraft.selectedApi)?.name || targetDraft.selectedApi,
                  params: [
                    { label: 'Prompt', type: 'string', value: targetDraft.prompt.trim() }
                  ]
                })
              })
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'Image generation failed' })
              pushExternalApiFailureNotification(
                'Image generation failed',
                err.message || 'Image generation failed',
                imageGenerationApis.find(api => api.id === targetDraft.selectedApi)?.name || 'Image generation API'
              )
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
            registerJob({
              id: promptId,
              projectId: project.id,
              projectName: project.name,
              page: 'graph',
              targetId: targetNodeId,
              kind: 'image',
              label: targetDraft.name.trim() || workflow.name
            })

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
              await applyNodeResult(imageAssets[0], {
                lastAction: 'comfy-workflow',
                promptId,
                lastActionParams: buildLastActionParams({
                  source: 'ComfyUI',
                  label: workflow.name,
                  params: describeWorkflowParams(workflow, inputValues, targetDraft, targetInputSources)
                })
              })
              if (imageAssets.length > 1) {
                await spawnAdditionalResultNodes('Image', imageAssets.slice(1))
              }
              await persistWorkflowDefaultsIfRequested(targetDraft, workflow, inputValues)
              completeJob(promptId, { status: 'completed' })
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI workflow failed', promptId })
              completeJob(promptId, { status: 'error', error: err.message || 'ComfyUI workflow failed' })
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
                inputSource: sourceReference,
                lastActionParams: buildLastActionParams({
                  source: 'API',
                  label: imageEditApis.find(api => api.id === targetDraft.selectedApi)?.name || targetDraft.selectedApi,
                  params: [
                    { label: 'Prompt', type: 'string', value: targetDraft.prompt.trim() },
                    { label: 'Image source', type: 'image', value: sourceReference, boundFrom: selectedApiSource?.label || null }
                  ]
                })
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
              pushExternalApiFailureNotification(
                'Image edit failed',
                err.message || 'Image edit failed',
                imageEditApis.find(api => api.id === targetDraft.selectedApi)?.name || 'Image edit API'
              )
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
            registerJob({
              id: promptId,
              projectId: project.id,
              projectName: project.name,
              page: 'graph',
              targetId: targetNodeId,
              kind: 'imageEdit',
              label: targetDraft.name.trim() || 'Image edit'
            })

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
                inputSource: JSON.stringify(inputValues),
                lastActionParams: buildLastActionParams({
                  source: 'ComfyUI',
                  label: workflow.name,
                  params: describeWorkflowParams(workflow, inputValues, targetDraft, targetInputSources)
                })
              })
              if (savedEdits.length > 1) {
                await spawnAdditionalResultNodes('Image', savedEdits.slice(1).map(edit => ({
                  id: edit.id,
                  name: edit.name || targetDraft.name.trim()
                })))
              }
              await persistWorkflowDefaultsIfRequested(targetDraft, workflow, inputValues)
              completeJob(promptId, { status: 'completed' })
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI image edit failed', promptId })
              completeJob(promptId, { status: 'error', error: err.message || 'ComfyUI image edit failed' })
            }
            return
          }

          return
        }

        const targetInputSources = buildNodeInputSources(targetNodeId, nodes, edges)

        if (targetNode.data.nodeKind === 'meshGen') {
          // When a mesh is connected to (and therefore used to edit) this node, the
          // generated mesh should become a version (child) of that connected mesh
          // instead of a brand-new root asset in the Assets page.
          const connectedMeshAssetId = getInputSource(nodes, edges, targetNodeId, 'mesh')?.asset?.id || null

          if (targetDraft.mode === 'api') {
            const selectedApiSource = resolveImageSourceOption(targetDraft.selectedInputSource, targetInputSources, libraryImageOptions)
            const sourceAsset = selectedApiSource?.asset || getConnectedInputAssetFrom(nodes, edges, targetNodeId)
            const sourceReference = selectedApiSource?.sourceReference || getAssetSourceReference(sourceAsset)
            const isTencentMeshApi = isTencentMeshGenerationApi(targetDraft.selectedApi)
            const isTripoMeshApi = isTripoMeshGenerationApi(targetDraft.selectedApi)
            const trimmedPrompt = String(targetDraft.prompt || '').trim()
            const effectiveSourceReference = (isTencentMeshApi || isTripoMeshApi) && trimmedPrompt
              ? ''
              : sourceReference

            if (!isTencentMeshApi && !isTripoMeshApi && !effectiveSourceReference) {
              return
            }

            if (!targetDraft.selectedApi || !String(targetDraft.name || '').trim()) {
              return
            }

            if (isTencentMeshApi) {
              if (Boolean(trimmedPrompt) === Boolean(effectiveSourceReference)) {
                const validationMessage = 'Provide either a prompt or an image input for Tencent Cloud mesh generation'
                await setProcessingState('error', null, {
                  processingSource: 'Tencent Cloud',
                  selectedApi: targetDraft.selectedApi,
                  error: validationMessage,
                  detail: 'Use either prompt-only or image-only input for Tencent Cloud',
                  currentNodeLabel: 'Tencent Cloud input validation failed'
                }, {
                  progressDetail: 'Use either prompt-only or image-only input for Tencent Cloud',
                  currentNodeLabel: 'Tencent Cloud input validation failed'
                })
                pushMeshGenerationFailureNotification(validationMessage, 'Tencent Cloud · Hunyuan3D Pro')
                return
              }

              await setProcessingState('processing', null, {
                processingSource: 'Tencent Cloud',
                selectedApi: targetDraft.selectedApi,
                inputSource: effectiveSourceReference || null,
                region: targetDraft.region,
                modelVersion: targetDraft.modelVersion,
                generationType: targetDraft.generationType,
                polygonType: targetDraft.generationType === 'LowPoly' ? targetDraft.polygonType : null,
                enablePBR: Boolean(targetDraft.enablePBR),
                faceCount: Number(targetDraft.faceCount) || 500000,
                prompt: trimmedPrompt,
                parentAssetId: connectedMeshAssetId,
                jobStatus: 'WAIT',
                detail: 'Submitting Tencent Cloud mesh generation job',
                currentNodeLabel: 'Waiting for Tencent Cloud job id'
              }, {
                progressDetail: 'Submitting Tencent Cloud mesh generation job',
                currentNodeLabel: 'Waiting for Tencent Cloud job id'
              })

              try {
                const response = await runMeshGenerationApi(project.id, {
                  imageSource: effectiveSourceReference || null,
                  name: targetDraft.name.trim(),
                  selectedApi: targetDraft.selectedApi,
                  prompt: trimmedPrompt,
                  region: targetDraft.region,
                  modelVersion: targetDraft.modelVersion,
                  enablePBR: Boolean(targetDraft.enablePBR),
                  faceCount: Number(targetDraft.faceCount) || 500000,
                  generationType: targetDraft.generationType,
                  polygonType: targetDraft.generationType === 'LowPoly' ? targetDraft.polygonType : undefined
                })

                await setProcessingState('processing', null, {
                  processingSource: 'Tencent Cloud',
                  selectedApi: response.selectedApi || targetDraft.selectedApi,
                  inputSource: effectiveSourceReference || null,
                  region: response.region || targetDraft.region,
                  modelVersion: targetDraft.modelVersion,
                  generationType: targetDraft.generationType,
                  polygonType: targetDraft.generationType === 'LowPoly' ? targetDraft.polygonType : null,
                  enablePBR: Boolean(targetDraft.enablePBR),
                  faceCount: Number(targetDraft.faceCount) || 500000,
                  prompt: trimmedPrompt,
                  meshName: targetDraft.name.trim(),
                  jobId: response.jobId,
                  promptId: response.jobId,
                  jobStatus: 'WAIT',
                  detail: 'Tencent Cloud job submitted. Use GET RESULT to refresh status.',
                  currentNodeLabel: 'Tencent Cloud job is queued',
                  lastActionParams: buildLastActionParams({
                    source: 'API',
                    label: meshGenerationApis.find(api => api.id === targetDraft.selectedApi)?.name || 'Tencent Cloud',
                    params: [
                      { label: 'Prompt', type: 'string', value: trimmedPrompt },
                      { label: 'Image source', type: 'image', value: effectiveSourceReference || '' },
                      { label: 'Region', type: 'string', value: response.region || targetDraft.region },
                      { label: 'Model version', type: 'string', value: targetDraft.modelVersion },
                      { label: 'Generation type', type: 'string', value: targetDraft.generationType },
                      { label: 'Polygon type', type: 'string', value: targetDraft.generationType === 'LowPoly' ? targetDraft.polygonType : '' },
                      { label: 'Enable PBR', type: 'boolean', value: Boolean(targetDraft.enablePBR) },
                      { label: 'Face count', type: 'number', value: Number(targetDraft.faceCount) || 500000 }
                    ]
                  })
                }, {
                  progressDetail: 'Tencent Cloud job submitted. Use GET RESULT to refresh status.',
                  currentNodeLabel: 'Tencent Cloud job is queued'
                })
                setActionDraftsByNodeId({})
              } catch (err) {
                await setProcessingState('error', null, {
                  processingSource: 'Tencent Cloud',
                  selectedApi: targetDraft.selectedApi,
                  inputSource: effectiveSourceReference || null,
                  region: targetDraft.region,
                  prompt: trimmedPrompt,
                  error: err.message || 'Tencent Cloud mesh generation failed',
                  detail: err.message || 'Tencent Cloud mesh generation failed',
                  currentNodeLabel: 'Tencent Cloud job submission failed',
                  jobStatus: 'FAIL'
                }, {
                  progressDetail: err.message || 'Tencent Cloud mesh generation failed',
                  currentNodeLabel: 'Tencent Cloud job submission failed'
                })
                pushMeshGenerationFailureNotification(
                  err.message || 'Tencent Cloud mesh generation failed',
                  'Tencent Cloud · Hunyuan3D Pro'
                )
              }
              return
            }

            if (isTripoMeshApi) {
              if (Boolean(trimmedPrompt) === Boolean(effectiveSourceReference)) {
                const validationMessage = 'Provide either a prompt or an image input for Tripo AI mesh generation'
                await setProcessingState('error', null, {
                  processingSource: 'Tripo AI',
                  selectedApi: targetDraft.selectedApi,
                  error: validationMessage,
                  detail: 'Use either prompt-only or image-only input for Tripo AI',
                  currentNodeLabel: 'Tripo AI input validation failed'
                }, {
                  progressDetail: 'Use either prompt-only or image-only input for Tripo AI',
                  currentNodeLabel: 'Tripo AI input validation failed'
                })
                pushMeshGenerationFailureNotification(validationMessage, 'Tripo AI')
                return
              }

              await setProcessingState('processing', null, {
                processingSource: 'Tripo AI',
                selectedApi: targetDraft.selectedApi,
                inputSource: effectiveSourceReference || null,
                prompt: trimmedPrompt,
                parentAssetId: connectedMeshAssetId,
                modelVersion: targetDraft.modelVersion || 'v2.5-20250123',
                modelSeed: targetDraft.modelSeed,
                enableImageAutofix: Boolean(targetDraft.enableImageAutofix),
                faceLimit: targetDraft.faceLimit,
                texture: Boolean(targetDraft.texture),
                pbr: Boolean(targetDraft.pbr),
                textureSeed: targetDraft.textureSeed,
                textureAlignment: targetDraft.textureAlignment || 'original_image',
                textureQuality: targetDraft.textureQuality || 'standard',
                autoSize: Boolean(targetDraft.autoSize),
                orientation: targetDraft.orientation || 'default',
                quad: Boolean(targetDraft.quad),
                smartLowPoly: Boolean(targetDraft.smartLowPoly),
                generateParts: Boolean(targetDraft.generateParts),
                exportUv: Boolean(targetDraft.exportUv),
                geometryQuality: targetDraft.geometryQuality || 'standard',
                detail: 'Submitting Tripo AI mesh generation task',
                currentNodeLabel: 'Waiting for Tripo AI task id'
              }, {
                progressDetail: 'Submitting Tripo AI mesh generation task',
                currentNodeLabel: 'Waiting for Tripo AI task id'
              })

              try {
                const response = await runMeshGenerationApi(project.id, {
                  imageSource: effectiveSourceReference || null,
                  name: targetDraft.name.trim(),
                  selectedApi: targetDraft.selectedApi,
                  prompt: trimmedPrompt,
                  modelVersion: targetDraft.modelVersion || 'v2.5-20250123',
                  modelSeed: targetDraft.modelSeed,
                  faceLimit: targetDraft.faceLimit,
                  texture: Boolean(targetDraft.texture),
                  pbr: Boolean(targetDraft.pbr),
                  textureSeed: targetDraft.textureSeed,
                  textureQuality: targetDraft.textureQuality || 'standard',
                  autoSize: Boolean(targetDraft.autoSize),
                  exportUv: Boolean(targetDraft.exportUv),
                  ...(targetDraft.modelVersion === 'P1-20260311'
                    ? {}
                    : {
                        enableImageAutofix: Boolean(targetDraft.enableImageAutofix),
                        textureAlignment: targetDraft.textureAlignment || 'original_image',
                        orientation: targetDraft.orientation || 'default',
                        quad: Boolean(targetDraft.quad),
                        smartLowPoly: Boolean(targetDraft.smartLowPoly),
                        generateParts: Boolean(targetDraft.generateParts),
                        geometryQuality: targetDraft.geometryQuality || 'standard'
                      })
                })

                await setProcessingState('processing', null, {
                  processingSource: 'Tripo AI',
                  selectedApi: response.selectedApi || targetDraft.selectedApi,
                  inputSource: effectiveSourceReference || null,
                  prompt: trimmedPrompt,
                  modelVersion: targetDraft.modelVersion || 'v2.5-20250123',
                  modelSeed: targetDraft.modelSeed,
                  enableImageAutofix: Boolean(targetDraft.enableImageAutofix),
                  faceLimit: targetDraft.faceLimit,
                  texture: Boolean(targetDraft.texture),
                  pbr: Boolean(targetDraft.pbr),
                  textureSeed: targetDraft.textureSeed,
                  textureAlignment: targetDraft.textureAlignment || 'original_image',
                  textureQuality: targetDraft.textureQuality || 'standard',
                  autoSize: Boolean(targetDraft.autoSize),
                  orientation: targetDraft.orientation || 'default',
                  quad: Boolean(targetDraft.quad),
                  smartLowPoly: Boolean(targetDraft.smartLowPoly),
                  generateParts: Boolean(targetDraft.generateParts),
                  exportUv: Boolean(targetDraft.exportUv),
                  geometryQuality: targetDraft.geometryQuality || 'standard',
                  meshName: targetDraft.name.trim(),
                  taskId: response.taskId,
                  promptId: response.taskId,
                  taskStatus: 'queued',
                  detail: 'Tripo AI task submitted. Use GET RESULT to refresh status.',
                  currentNodeLabel: 'Tripo AI task is queued',
                  lastActionParams: buildLastActionParams({
                    source: 'API',
                    label: meshGenerationApis.find(api => api.id === targetDraft.selectedApi)?.name || 'Tripo AI',
                    params: [
                      { label: 'Prompt', type: 'string', value: trimmedPrompt },
                      { label: 'Image source', type: 'image', value: effectiveSourceReference || '' },
                      { label: 'Model version', type: 'string', value: targetDraft.modelVersion || 'v2.5-20250123' },
                      { label: 'Model seed', type: 'string', value: targetDraft.modelSeed },
                      { label: 'Face limit', type: 'string', value: targetDraft.faceLimit },
                      { label: 'Texture', type: 'boolean', value: Boolean(targetDraft.texture) },
                      { label: 'PBR', type: 'boolean', value: Boolean(targetDraft.pbr) },
                      { label: 'Texture quality', type: 'string', value: targetDraft.textureQuality || 'standard' },
                      { label: 'Auto size', type: 'boolean', value: Boolean(targetDraft.autoSize) },
                      { label: 'Export UV', type: 'boolean', value: Boolean(targetDraft.exportUv) },
                      { label: 'Geometry quality', type: 'string', value: targetDraft.geometryQuality || 'standard' }
                    ]
                  })
                }, {
                  progressDetail: 'Tripo AI task submitted. Use GET RESULT to refresh status.',
                  currentNodeLabel: 'Tripo AI task is queued'
                })
                setActionDraftsByNodeId({})
              } catch (err) {
                await setProcessingState('error', null, {
                  processingSource: 'Tripo AI',
                  selectedApi: targetDraft.selectedApi,
                  inputSource: effectiveSourceReference || null,
                  prompt: trimmedPrompt,
                  error: err.message || 'Tripo AI mesh generation failed',
                  detail: err.message || 'Tripo AI mesh generation failed',
                  currentNodeLabel: 'Tripo AI task submission failed',
                  taskStatus: 'failed'
                }, {
                  progressDetail: err.message || 'Tripo AI mesh generation failed',
                  currentNodeLabel: 'Tripo AI task submission failed'
                })
                pushMeshGenerationFailureNotification(
                  err.message || 'Tripo AI mesh generation failed',
                  'Tripo AI'
                )
              }
              return
            }

            await setProcessingState('processing', null, { processingSource: 'API', inputSource: sourceReference })
            try {
              const response = await runMeshGenerationApi(project.id, {
                imageSource: sourceReference,
                name: targetDraft.name.trim(),
                selectedApi: targetDraft.selectedApi,
                prompt: targetDraft.prompt.trim(),
                parentAssetId: connectedMeshAssetId
              })
              const savedMeshes = (Array.isArray(response) ? response : [response]).filter(asset => asset?.type === 'mesh')
              if (savedMeshes.length === 0) {
                throw new Error('Mesh generation did not return any saved mesh')
              }
              await ensureGeneratedMeshThumbnails(savedMeshes)
              await applyNodeResult(savedMeshes[0], {
                lastAction: 'mesh-generation-api',
                inputSource: sourceReference,
                lastActionParams: buildLastActionParams({
                  source: 'API',
                  label: meshGenerationApis.find(api => api.id === targetDraft.selectedApi)?.name || targetDraft.selectedApi,
                  params: [
                    { label: 'Prompt', type: 'string', value: targetDraft.prompt.trim() },
                    { label: 'Image source', type: 'image', value: sourceReference, boundFrom: selectedApiSource?.label || null }
                  ]
                })
              })
              if (savedMeshes.length > 1) {
                await spawnAdditionalResultNodes('Mesh Gen', savedMeshes.slice(1))
              }
              setActionDraftsByNodeId({})
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'Mesh generation failed', inputSource: sourceReference })
              pushMeshGenerationFailureNotification(err.message || 'Mesh generation failed', 'Mesh generation API')
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
            registerJob({
              id: promptId,
              projectId: project.id,
              projectName: project.name,
              page: 'graph',
              targetId: targetNodeId,
              kind: 'mesh',
              label: targetDraft.name.trim() || workflow.name
            })

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
                clientId,
                parentAssetId: connectedMeshAssetId,
                // A version is nested under its parent mesh, so don't spawn a new
                // standalone Kanban card for it (progress is tracked via the node).
                persistProcessingCard: connectedMeshAssetId ? false : true
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
              await applyNodeResult(meshAssets[0], {
                lastAction: 'mesh-generation-comfy',
                promptId,
                lastActionParams: buildLastActionParams({
                  source: 'ComfyUI',
                  label: workflow.name,
                  params: describeWorkflowParams(workflow, inputValues, targetDraft, targetInputSources)
                })
              })
              if (meshAssets.length > 1) {
                await spawnAdditionalResultNodes('Mesh Gen', meshAssets.slice(1))
              }
              await persistWorkflowDefaultsIfRequested(targetDraft, workflow, inputValues)
              completeJob(promptId, { status: 'completed' })
            } catch (err) {
              await setProcessingState('error', null, { error: err.message || 'ComfyUI mesh generation failed', promptId })
              completeJob(promptId, { status: 'error', error: err.message || 'ComfyUI mesh generation failed' })
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
            pushExternalApiFailureNotification(
              'Image edit failed',
              err.message || 'Image edit failed',
              imageEditApis.find(api => api.id === targetDraft.selectedApi)?.name || 'Image edit API'
            )
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
          registerJob({
            id: promptId,
            projectId: project.id,
            projectName: project.name,
            page: 'graph',
            targetId: targetNodeId,
            kind: 'imageEdit',
            label: targetDraft.name.trim() || 'Image edit'
          })

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
            completeJob(promptId, { status: 'completed' })
          } catch (err) {
            await setProcessingState('error', null, { error: err.message || 'ComfyUI image edit failed', promptId })
            completeJob(promptId, { status: 'error', error: err.message || 'ComfyUI image edit failed' })
          }
        }
      },
      onGetAsyncMeshResult: async (targetNodeId) => {
        const targetNode = nodes.find(item => item.id === String(targetNodeId))
        const runtimeMetadata = targetNode?.data?.metadata || {}
        const isTencentRuntime = isTencentMeshGenerationApi(runtimeMetadata?.selectedApi)
        const isTripoRuntime = isTripoMeshGenerationApi(runtimeMetadata?.selectedApi)

        if (!targetNode || !(canFetchTencentMeshResult(runtimeMetadata, targetNode.data.status) || canFetchTripoMeshResult(runtimeMetadata, targetNode.data.status))) {
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
          const baseX = targetNode.position.x
          const baseY = targetNode.position.y
          for (let index = 0; index < assets.length; index += 1) {
            const asset = assets[index]
            await handleCreateNode(nodeTypeName, {
              name: asset.name || nodeTypeName,
              assetId: asset.id,
              xPos: baseX + 360,
              yPos: baseY + ((index + 1) * 140),
              metadata: {
                createdFromNodeId: Number(targetNodeId)
              }
            })
          }
        }

        await setProcessingState('processing', null, {
          ...runtimeMetadata,
          detail: isTencentRuntime ? 'Checking Tencent Cloud job result…' : 'Checking Tripo AI task result…',
          currentNodeLabel: isTencentRuntime
            ? `Job ${runtimeMetadata.jobId}`
            : `Task ${runtimeMetadata.taskId}`
        }, {
          progressDetail: isTencentRuntime ? 'Checking Tencent Cloud job result…' : 'Checking Tripo AI task result…',
          currentNodeLabel: isTencentRuntime
            ? `Job ${runtimeMetadata.jobId}`
            : `Task ${runtimeMetadata.taskId}`
        })

        try {
          const response = isTencentRuntime
            ? await queryTencentMeshGenerationResult(project.id, {
              jobId: runtimeMetadata.jobId,
              region: runtimeMetadata.region,
              name: runtimeMetadata.meshName || targetNode.data.name || targetNode.data.asset?.name || 'Generated Mesh',
              prompt: runtimeMetadata.prompt || '',
              selectedApi: runtimeMetadata.selectedApi || TENCENT_MESH_GENERATION_API_ID,
              parentAssetId: runtimeMetadata.parentAssetId || null
            })
            : await queryTripoMeshGenerationResult(project.id, {
              taskId: runtimeMetadata.taskId,
              name: runtimeMetadata.meshName || targetNode.data.name || targetNode.data.asset?.name || 'Generated Mesh',
              prompt: runtimeMetadata.prompt || '',
              selectedApi: runtimeMetadata.selectedApi || TRIPO_MESH_GENERATION_API_ID,
              parentAssetId: runtimeMetadata.parentAssetId || null
            })

          if (response.status === 'processing') {
            const processingProgress = isTripoRuntime && Number.isFinite(response.progress)
              ? Math.max(0, Math.min(100, Math.round(response.progress)))
              : null
            await setProcessingState('processing', processingProgress, {
              ...runtimeMetadata,
              selectedApi: response.selectedApi || runtimeMetadata.selectedApi,
              region: response.region || runtimeMetadata.region,
              jobId: response.jobId || runtimeMetadata.jobId,
              promptId: isTencentRuntime
                ? (response.jobId || runtimeMetadata.promptId)
                : (response.taskId || runtimeMetadata.promptId),
              jobStatus: response.jobStatus || runtimeMetadata.jobStatus,
              taskId: response.taskId || runtimeMetadata.taskId,
              taskStatus: response.taskStatus || runtimeMetadata.taskStatus,
              detail: isTencentRuntime
                ? `Tencent Cloud job status: ${response.jobStatus}`
                : `Tripo AI task status: ${response.taskStatus}`,
              currentNodeLabel: isTencentRuntime
                ? (response.jobStatus === 'RUN' ? 'Tencent Cloud job is running' : 'Tencent Cloud job is queued')
                : (response.taskStatus === 'running' ? 'Tripo AI task is running' : 'Tripo AI task is queued')
            }, {
              progressDetail: isTencentRuntime
                ? `Tencent Cloud job status: ${response.jobStatus}`
                : `Tripo AI task status: ${response.taskStatus}`,
              currentNodeLabel: isTencentRuntime
                ? (response.jobStatus === 'RUN' ? 'Tencent Cloud job is running' : 'Tencent Cloud job is queued')
                : (response.taskStatus === 'running' ? 'Tripo AI task is running' : 'Tripo AI task is queued')
            })
            return
          }

          if (response.status === 'error') {
            const failureMessage = response.error || (isTencentRuntime ? 'Tencent Cloud mesh generation failed' : 'Tripo AI mesh generation failed')
            await setProcessingState('error', null, {
              ...runtimeMetadata,
              jobStatus: isTencentRuntime ? 'FAIL' : runtimeMetadata.jobStatus,
              taskStatus: isTripoRuntime ? 'failed' : runtimeMetadata.taskStatus,
              detail: failureMessage,
              currentNodeLabel: isTencentRuntime ? 'Tencent Cloud job failed' : 'Tripo AI task failed',
              error: failureMessage
            }, {
              progressDetail: failureMessage,
              currentNodeLabel: isTencentRuntime ? 'Tencent Cloud job failed' : 'Tripo AI task failed'
            })
            pushMeshGenerationFailureNotification(failureMessage, isTencentRuntime ? 'Tencent Cloud · Hunyuan3D Pro' : 'Tripo AI')
            return
          }

          const savedMeshes = (response.assets || []).filter(asset => asset?.type === 'mesh')
          if (savedMeshes.length === 0) {
            throw new Error('Tencent Cloud job finished but no saved mesh was returned')
          }

          await ensureGeneratedMeshThumbnails(savedMeshes)
          await applyNodeResult(savedMeshes[0], {
            lastAction: isTencentRuntime ? 'mesh-generation-tencent' : 'mesh-generation-tripo',
            inputSource: runtimeMetadata.inputSource || null,
            processingSource: null,
            selectedApi: null,
            region: null,
            jobId: null,
            promptId: null,
            jobStatus: null,
            taskId: null,
            taskStatus: null,
            parentAssetId: null,
            detail: null,
            currentNodeLabel: null,
            error: null
          })
          if (savedMeshes.length > 1) {
            await spawnAdditionalResultNodes('Mesh Gen', savedMeshes.slice(1))
          }
          setActionDraftsByNodeId({})
        } catch (err) {
          const failureMessage = err.message || (isTencentRuntime ? 'Failed to fetch Tencent Cloud mesh result' : 'Failed to fetch Tripo AI mesh result')
          await setProcessingState('error', null, {
            ...runtimeMetadata,
            jobStatus: isTencentRuntime ? 'FAIL' : runtimeMetadata.jobStatus,
            taskStatus: isTripoRuntime ? 'failed' : runtimeMetadata.taskStatus,
            detail: failureMessage,
            currentNodeLabel: isTencentRuntime ? 'Tencent Cloud result query failed' : 'Tripo AI result query failed',
            error: failureMessage
          }, {
            progressDetail: failureMessage,
            currentNodeLabel: isTencentRuntime ? 'Tencent Cloud result query failed' : 'Tripo AI result query failed'
          })
          pushMeshGenerationFailureNotification(failureMessage, isTencentRuntime ? 'Tencent Cloud · Hunyuan3D Pro' : 'Tripo AI')
        }
      },
      onCloseAction: () => setActionDraftsByNodeId({})
    }
  })}), [actionDraftsByNodeId, attachExistingAsset, comfyLoading, completeJob, createImageEditNodeDraft, createImageNodeDraft, createMeshGenNodeDraft, createTextNodeDraft, createProjectConnection, edges, ensureComfyWorkflowsLoaded, ensureGeneratedMeshThumbnails, ensureLibraryLoaded, generateImage, getConnectedInputAssetFrom, handleCreateNode, handleNodeNameChange, handleNodeNameCommit, handleNodeOutputValueChange, handleNodeOutputValueCommit, handleOpenAssetSelector, imageEditApis, imageEditWorkflows, imageGenerationApis, imageGenerationWorkflows, libraryImageOptions, libraryLoading, libraryMeshOptions, meshGenerationApis, meshGenerationWorkflows, textGenerationWorkflows, nodes, openActionDraft, project.id, project.name, pushExternalApiFailureNotification, pushMeshGenerationFailureNotification, queryTencentMeshGenerationResult, queryTripoMeshGenerationResult, registerJob, replaceFlowNodeData, runComfyWorkflow, runImageEditApi, runImageEditComfy, runMeshGenerationApi, persistWorkflowDefaultsIfRequested, setEdges, setNodeTransientData, setNodes, updateProjectNode])

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

  const handleCanvasFileDragOver = useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  // Import dropped image files into Assets and create an Image node at the drop
  // position for each file, then bind the uploaded asset to that node.
  const handleCanvasFileDrop = useCallback(async (event) => {
    const files = Array.from(event.dataTransfer?.files || []).filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()

    const flowPosition = reactFlowInstance?.screenToFlowPosition
      ? reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : { x: 96, y: 96 }

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      try {
        const createdNode = await handleCreateNode('Image', {
          xPos: flowPosition.x + (index * 32),
          yPos: flowPosition.y + (index * 32),
          name: file.name?.replace(/\.[^.]+$/, '') || 'Image'
        })
        const uploadedAsset = await uploadAsset(project.id, file, 'image', {
          resolution: 'Unknown',
          format: file.type.split('/')[1]?.toUpperCase() || 'IMG',
          source: 'IMPORT'
        })
        const updatedNode = await updateProjectNode(project.id, Number(createdNode.id), {
          assetId: uploadedAsset.id,
          name: uploadedAsset.name,
          status: null,
          progress: null,
          metadata: { lastAction: 'local-upload' }
        })
        if (updatedNode) replaceFlowNodeData(updatedNode)
      } catch (err) {
        console.error('Failed to import dropped image to graph:', err)
      }
    }
  }, [handleCreateNode, project.id, reactFlowInstance, replaceFlowNodeData, updateProjectNode, uploadAsset])

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
    if (skipNextPaneClickRef.current) {
      skipNextPaneClickRef.current = false
      return
    }

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
        const isTextNode = node.data.nodeKind === 'text'
        let nextDraft = draft

        if (draft.mode === 'api' && (isEditNode || isMeshGenNode)) {
          const validImageSelections = isMeshGenNode && isTencentMeshGenerationApi(draft.selectedApi)
            ? getCompatibleInputSources(nodeInputSources, 'image').map(getInputSourceSelectionValue)
            : [
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
          const workflowList = isTextNode
            ? textGenerationWorkflows
            : isMeshGenNode ? meshGenerationWorkflows : isEditNode ? imageEditWorkflows : imageGenerationWorkflows
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
  }, [edges, imageEditWorkflows, imageGenerationWorkflows, libraryImageOptions, meshGenerationWorkflows, textGenerationWorkflows, nodes])

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
					showEdits={assetSelectorShowEdits}
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
                  {GRAPH_NODE_TYPE_OPTIONS
                    .filter(nodeTypeName => !nodePicker.pendingConnection || getDefaultTargetInputId(nodeTypeName))
                    .map(nodeTypeName => (
                    <button
                      key={nodeTypeName}
                      type="button"
                      className="graph-page__node-picker-option"
                      disabled={Boolean(nodePicker.pendingConnection) && !canNodeTypeAcceptIncomingConnection(nodeTypeName, nodePicker.pendingConnection.outputType)}
                      onClick={() => handleCreateNodeFromPicker(nodeTypeName)}
                      title={nodePicker.pendingConnection && !canNodeTypeAcceptIncomingConnection(nodeTypeName, nodePicker.pendingConnection.outputType)
                        ? 'This node cannot accept the dragged connection'
                        : undefined}
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
              onlyRenderVisibleElements
              onInit={setReactFlowInstance}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnectStart={handleConnectStart}
              onConnect={handleConnect}
              onConnectEnd={handleConnectEnd}
              isValidConnection={isValidConnection}
              onPaneClick={handlePaneClick}
              onPaneContextMenu={handlePaneContextMenu}
              onDragOver={handleCanvasFileDragOver}
              onDrop={handleCanvasFileDrop}
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
