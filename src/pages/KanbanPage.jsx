import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext.shared'
import Header from '../components/Header'
import Footer from '../components/Footer'
import Viewer from '../components/Viewer'
import MeshPreviewDialog from '../components/MeshPreviewDialog'
import SettingsModal from '../components/SettingsModal'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import './KanbanPage.css'

const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai_gpt_image_1', name: 'OpenAI · gpt-image-1' },
  { id: 'openai_gpt_image_1_5', name: 'OpenAI · gpt-image-1.5' },
]

const IMAGE_CARD_COLUMNS = [
  { id: 'images', dbId: 1, icon: 'image', title: 'IMAGES' },
  { id: 'imageedit', dbId: 2, icon: 'photo_filter', title: 'IMAGE EDIT', showAttributes: true, emptyLabel: 'Drag an image card here to edit it' },
  { id: 'meshgen', dbId: 3, icon: 'deployed_code', title: 'MESH GEN', showAttributes: true, emptyLabel: 'Drag an image card here to generate a mesh' },
  { id: 'meshedit', dbId: 4, icon: 'edit_square', title: 'MESH EDIT', showAttributes: true, emptyLabel: 'Drag a mesh card here to edit it' },
]

const DEFAULT_ATTRIBUTE_TYPE_ID = 1
const DEFAULT_CUSTOM_API_TYPE = 'image-generation'

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

function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE
}

function getComfyDraftFromWorkflow(workflow) {
  return {
    mode: 'comfy',
    workflowId: workflow?.id || '',
    inputs: Object.fromEntries(
      (workflow?.parameters || []).map(parameter => {
        const valueType = getWorkflowParameterValueType(parameter)
        return [parameter.id, isFileWorkflowValueType(valueType) ? null : (valueType === 'boolean' ? Boolean(parameter.defaultValue ?? false) : (parameter.defaultValue ?? ''))]
      })
    )
  }
}

function formatWorkflowDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function getWorkflowParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

function getAssetChildren(asset) {
  return asset?.children || asset?.edits || []
}

function createImageCardId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `image-card-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

function createComfyExecutionId(prefix = 'comfy') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

export default function KanbanPage() {
  const { projectId } = useParams()
  const {
    getProject,
    getProjectAssets,
      getProjectCards,
    uploadAsset,
    uploadAssetThumbnail,
    attachExistingAsset,
    deleteAsset,
    moveKanbanCard,
    getLibraryAssets,
    getAttributeTypes,
    getProjectCardAttributes,
    createCardAttribute,
    updateCardAttribute,
    deleteCardAttribute,
    runImageEditApi,
    runMeshGenerationApi,
    runMeshEditApi,
    runImageEditComfy,
    generateImage,
    getComfyWorkflows,
    runComfyWorkflow,
    subscribeToComfyWorkflowProgress
  } = useProjects()
  const { settings } = useSettings()
  
  const [project, setProject] = useState(null)
  const [assets, setAssets] = useState([])
  const [projectCards, setProjectCards] = useState([])
  const [loading, setLoading] = useState(true)

  const [texResolution, setTexResolution] = useState('2048 x 2048 (2K)')
  const [texEngine, setTexEngine] = useState('stable')
  const [pbrEnabled, setPbrEnabled] = useState(true)
  const [aoEnabled, setAoEnabled] = useState(false)

  // NEW: Settings and Image Creation State
  const [showSettings, setShowSettings] = useState(false)
  const [imageDraft, setImageDraft] = useState(null) // null | { mode: 'select'|'local'|'comfy'|'api' }
  const [pendingImageGeneration, setPendingImageGeneration] = useState(null)
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [comfyLoading, setComfyLoading] = useState(false)
  const [imageCardPages, setImageCardPages] = useState({})
  const [attributeTypes, setAttributeTypes] = useState([])
  const [cardAttributes, setCardAttributes] = useState([])
  const [draggedCard, setDraggedCard] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  const [imageEditDraft, setImageEditDraft] = useState(null)
  const [imageEditPendingCardId, setImageEditPendingCardId] = useState(null)
  const [imageEditProgressByCardId, setImageEditProgressByCardId] = useState({})
  const [imageEditPreviewIndexes, setImageEditPreviewIndexes] = useState({})
  const [meshPreviewAsset, setMeshPreviewAsset] = useState(null)
  const [statusMessage, setStatusMessage] = useState(null)
  const fileInputRef = useRef(null)
  const fileUploadContextRef = useRef({ cardId: null, closeDraft: true })
  const pendingComfyProgressSubscriptionRef = useRef(null)
  const imageEditProgressSubscriptionsRef = useRef(new Map())
  const statusMessageTimeoutRef = useRef(null)

  const showStatusMessage = (message, tone = 'info') => {
    if (!message) {
      return
    }

    const id = Date.now()
    clearTimeout(statusMessageTimeoutRef.current)
    setStatusMessage({ id, message, tone })
    statusMessageTimeoutRef.current = setTimeout(() => {
      setStatusMessage(prev => prev?.id === id ? null : prev)
    }, 10000)
  }

  // Fetch all data for this project
  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [projData, assetsData, cardsData, attributesData] = await Promise.all([
          getProject(projectId),
          getProjectAssets(projectId),
          getProjectCards(projectId),
          getProjectCardAttributes(projectId)
        ])
        setProject(projData)
        setAssets(assetsData)
        setProjectCards(cardsData)
        setCardAttributes(attributesData)
      } catch (err) {
        console.error('Failed to load project data:', err)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [projectId, getProject, getProjectAssets, getProjectCards, getProjectCardAttributes])

  useEffect(() => {
    async function loadAttributeTypes() {
      try {
        const types = await getAttributeTypes()
        setAttributeTypes(types)
      } catch (err) {
        console.error('Failed to load attribute types:', err)
      }
    }

    loadAttributeTypes()
  }, [getAttributeTypes])

  useEffect(() => {
    async function loadComfyWorkflows() {
      try {
        setComfyLoading(true)
        const workflows = await getComfyWorkflows()
        setComfyWorkflows(workflows)
      } catch (err) {
        console.error('Failed to load ComfyUI workflows:', err)
      } finally {
        setComfyLoading(false)
      }
    }

    loadComfyWorkflows()
  }, [getComfyWorkflows])

  const openImageSourceMenu = (cardId = null) => {
    setImageDraft({ mode: 'select', cardId })
  }

  const openLocalFilePicker = (cardId = null) => {
    fileUploadContextRef.current = {
      cardId,
      closeDraft: !cardId
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    const { cardId, closeDraft } = fileUploadContextRef.current
    const nextCardId = cardId || createImageCardId()

    try {
      setLoading(true)

      for (const file of files) {
        await uploadAsset(projectId, file, 'image', {
          resolution: 'Unknown',
          format: file.type.split('/')[1]?.toUpperCase() || 'IMG',
          source: 'IMPORT',
          cardId: nextCardId
        })
      }

      const assetsData = await getProjectAssets(projectId)
      setAssets(assetsData)

      if (closeDraft) {
        setImageDraft(null)
      }
    } catch (err) {
      console.error('Upload failed:', err)
      showStatusMessage(err.message || 'Upload failed', 'error')
    } finally {
      setLoading(false)
      e.target.value = ''
      fileUploadContextRef.current = { cardId: null, closeDraft: true }
    }
  }

  const refreshProjectAssets = async () => {
    const [assetsData, cardsData] = await Promise.all([
      getProjectAssets(projectId),
      getProjectCards(projectId)
    ])
    setAssets(assetsData)
    setProjectCards(cardsData)
  }

  const ensureGeneratedMeshThumbnail = async (asset) => {
    if (!asset || asset.type !== 'mesh' || asset.thumbnail) {
      return asset
    }

    const assetUrl = `http://localhost:3001/assets/${encodeURI(asset.filename)}`
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
  }

  const ensureGeneratedMeshThumbnails = async (generatedAssets) => {
    const meshAssets = (Array.isArray(generatedAssets) ? generatedAssets : [generatedAssets]).filter(asset => asset?.type === 'mesh')

    for (const meshAsset of meshAssets) {
      try {
        await ensureGeneratedMeshThumbnail(meshAsset)
      } catch (err) {
        console.warn(`Failed to generate thumbnail for mesh ${meshAsset?.name || meshAsset?.id}:`, err)
      }
    }
  }

  const refreshCardAttributes = async () => {
    const attributesData = await getProjectCardAttributes(projectId)
    setCardAttributes(attributesData)
  }

  const closePendingComfyProgressSubscription = () => {
    pendingComfyProgressSubscriptionRef.current?.()
    pendingComfyProgressSubscriptionRef.current = null
  }

  const openPendingComfyProgressSubscription = (promptId) => {
    closePendingComfyProgressSubscription()

    pendingComfyProgressSubscriptionRef.current = subscribeToComfyWorkflowProgress(promptId, {
      onMessage: (payload) => {
        setPendingImageGeneration(prev => {
          if (!prev || prev.promptId !== promptId) {
            return prev
          }

          return {
            ...prev,
            progressPercent: Math.max(prev.progressPercent || 0, Number(payload?.progressPercent) || 0),
            detail: payload?.detail || prev.detail,
            currentNodeLabel: payload?.currentNodeLabel || prev.currentNodeLabel
          }
        })
      },
      onError: () => {}
    })
  }

  const closeImageEditProgressSubscription = (cardId = null) => {
    if (cardId) {
      imageEditProgressSubscriptionsRef.current.get(cardId)?.()
      imageEditProgressSubscriptionsRef.current.delete(cardId)
      return
    }

    imageEditProgressSubscriptionsRef.current.forEach(unsubscribe => unsubscribe?.())
    imageEditProgressSubscriptionsRef.current.clear()
  }

  useEffect(() => {
    return () => {
      clearTimeout(statusMessageTimeoutRef.current)
      closePendingComfyProgressSubscription()
      closeImageEditProgressSubscription()
    }
  }, [])

  const imageGenerationWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return outputValueTypes.includes('image')
    })
  }, [comfyWorkflows])

  const selectedComfyWorkflow = imageGenerationWorkflows.find(workflow => workflow.id == imageDraft?.workflowId) || null

  const openComfyWorkflowDraft = (cardId = imageDraft?.cardId || null) => {
    if (imageGenerationWorkflows.length === 0) {
      showStatusMessage('No compatible ComfyUI workflows available. Import a workflow with at least one image output.', 'error')
      return
    }

    setImageDraft({
      ...getComfyDraftFromWorkflow(imageGenerationWorkflows[0]),
      cardId
    })
  }

  const handleComfyWorkflowChange = (workflowId) => {
    const workflow = imageGenerationWorkflows.find(item => item.id == workflowId)
    setImageDraft(prev => ({
      ...getComfyDraftFromWorkflow(workflow),
      cardId: prev?.cardId || null
    }))
  }

  const handleComfyInputChange = (parameter, rawValue) => {
    const valueType = getWorkflowParameterValueType(parameter)
    let nextValue = rawValue

    if (['image', 'video'].includes(valueType)) {
      nextValue = rawValue
    } else if (valueType === 'boolean') {
      nextValue = Boolean(rawValue)
    } else if (parameter.type === 'number' || valueType === 'number') {
      nextValue = rawValue
    } else if (parameter.type === 'json' && typeof rawValue === 'string') {
      nextValue = rawValue
    }

    setImageDraft(prev => ({
      ...prev,
      inputs: {
        ...(prev?.inputs || {}),
        [parameter.id]: nextValue
      }
    }))
  }

  const openAssetLibrary = async (cardId = imageDraft?.cardId || null) => {
    try {
      setLibraryLoading(true)
      const library = await getLibraryAssets()
      setLibraryAssets(library)
      setImageDraft({ mode: 'assets', cardId })
    } catch (err) {
      console.error('Failed to load asset library:', err)
      showStatusMessage(err.message || 'Failed to load assets library', 'error')
    } finally {
      setLibraryLoading(false)
    }
  }

  const handleAttachLibraryImage = async (libraryImage) => {
    try {
      setLoading(true)
      const cardId = imageDraft?.cardId || createImageCardId()
      await attachExistingAsset(projectId, {
        filename: libraryImage.filename,
        type: 'image',
        name: libraryImage.name,
        metadata: {
          resolution: 'Unknown',
          format: libraryImage.extension,
          source: 'ASSET LIB',
          cardId
        }
      })
      await refreshProjectAssets()
      setImageDraft(null)
    } catch (err) {
      console.error('Failed to attach image from assets:', err)
      showStatusMessage(err.message || 'Failed to attach image from assets', 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveImage = async (assetId) => {
    try {
      await deleteAsset(assetId)
      await Promise.all([refreshProjectAssets(), refreshCardAttributes()])
    } catch (err) {
      console.error('Failed to remove image:', err)
      showStatusMessage(err.message || 'Failed to remove image', 'error')
    }
  }

  const handleRemoveImageCard = async (cardAssets) => {
    try {
      for (const asset of cardAssets) {
        await deleteAsset(asset.id)
      }

      await Promise.all([refreshProjectAssets(), refreshCardAttributes()])
    } catch (err) {
      console.error('Failed to remove image card:', err)
      showStatusMessage(err.message || 'Failed to remove image card', 'error')
    }
  }

  const handleGenerateImage = async (draft) => {
    if (draft.mode === 'comfy') {
      if (!draft?.workflowId) return

      const workflow = comfyWorkflows.find(item => item.id == draft.workflowId)
      if (!workflow) {
        showStatusMessage('Select a valid ComfyUI workflow.', 'error')
        return
      }

      for (const parameter of workflow.parameters || []) {
        const valueType = getWorkflowParameterValueType(parameter)
        const currentValue = draft.inputs?.[parameter.id]

        if (['image', 'video'].includes(valueType) && !currentValue) {
          showStatusMessage(`Select a ${valueType} file for ${parameter.name}.`, 'error')
          return
        }

        if (valueType === 'string' && !String(currentValue ?? '').trim()) {
          showStatusMessage(`Enter a value for ${parameter.name}.`, 'error')
          return
        }
      }

      try {
        const comfyClientId = createComfyExecutionId('comfy-client')
        const promptId = createComfyExecutionId('comfy-prompt')

        setPendingImageGeneration({
          title: workflow.name,
          source: 'ComfyUI',
          detail: 'Preparing ComfyUI workflow',
          progressPercent: 0,
          currentNodeLabel: 'Waiting for ComfyUI execution to start',
          promptId
        })
        setImageDraft(null)
        setLoading(true)
        openPendingComfyProgressSubscription(promptId)
        await runComfyWorkflow(projectId, {
          workflowId: draft.workflowId,
          inputs: draft.inputs || {},
          cardId: draft.cardId || createImageCardId(),
          clientId: comfyClientId,
          promptId
        })
        setPendingImageGeneration(prev => prev ? {
          ...prev,
          progressPercent: 100,
          detail: 'Saving generated image',
          currentNodeLabel: 'Generated image received'
        } : prev)
        await refreshProjectAssets()
      } catch (err) {
        console.error('ComfyUI workflow failed:', err)
        setImageDraft(draft)
        showStatusMessage(err.message || 'ComfyUI workflow failed', 'error')
      } finally {
        closePendingComfyProgressSubscription()
        setPendingImageGeneration(null)
        setLoading(false)
      }

      return
    }

    if (!draft?.prompt?.trim()) return

    try {
      setPendingImageGeneration({
        selectedApi: draft.selectedApi,
        title: draft.prompt.trim(),
        source: imageGenerationApis.find(api => api.id === draft.selectedApi)?.name || 'Remote API',
        detail: 'Waiting for image response'
      })
      setImageDraft(null)
      setLoading(true)
      await generateImage(projectId, {
        selectedApi: draft.selectedApi,
        prompt: draft.prompt,
        cardId: draft.cardId || createImageCardId()
      })
      await refreshProjectAssets()
      setImageDraft(null)
    } catch (err) {
      console.error('Image generation failed:', err)
      setImageDraft(draft)
      showStatusMessage(err.message || 'Image generation failed', 'error')
    } finally {
      setPendingImageGeneration(null)
      setLoading(false)
    }
  }

  const images = assets.filter(a => a.type === 'image')
  const meshes = assets.filter(a => a.type === 'mesh')

  const meshAssetsByCardId = useMemo(() => {
    return meshes.reduce((accumulator, asset) => {
      const cardId = asset.metadata?.cardId || `asset-${asset.id}`
      if (!accumulator[cardId]) {
        accumulator[cardId] = []
      }

      accumulator[cardId].push(asset)
      return accumulator
    }, {})
  }, [meshes])

  const projectCardsById = useMemo(() => {
    return projectCards.reduce((accumulator, card) => {
      accumulator[card.id] = card
      return accumulator
    }, {})
  }, [projectCards])

  const imageCards = useMemo(() => {
    const cards = new Map()

    for (const asset of images) {
      const cardId = asset.metadata?.cardId || `asset-${asset.id}`

      if (!cards.has(cardId)) {
        cards.set(cardId, [])
      }

      cards.get(cardId).push(asset)
    }

    for (const card of projectCards) {
      if (!IMAGE_CARD_COLUMNS.some(column => column.dbId === card.kanbanColumnId)) {
        continue
      }

      if (!cards.has(card.id)) {
        cards.set(card.id, [])
      }
    }

    return Array.from(cards.entries())
      .map(([id, cardAssets]) => {
        const persistedCard = projectCardsById[id] || null
        const sortedAssets = [...cardAssets].sort((left, right) => {
          const leftPosition = left.assetPosition ?? Number.MAX_SAFE_INTEGER
          const rightPosition = right.assetPosition ?? Number.MAX_SAFE_INTEGER

          if (leftPosition !== rightPosition) {
            return leftPosition - rightPosition
          }

          return (right.createdAt || 0) - (left.createdAt || 0)
        })
        const primaryAsset = sortedAssets[0]
        const meshAssets = (meshAssetsByCardId[id] || []).slice().sort((left, right) => {
          const leftPosition = left.assetPosition ?? Number.MAX_SAFE_INTEGER
          const rightPosition = right.assetPosition ?? Number.MAX_SAFE_INTEGER

          if (leftPosition !== rightPosition) {
            return leftPosition - rightPosition
          }

          return (right.createdAt || 0) - (left.createdAt || 0)
        })
        const primaryDisplayAsset = primaryAsset || meshAssets[0] || null
        const allAssets = [...sortedAssets, ...meshAssets]
        const sources = [...new Set(allAssets.map(asset => asset.metadata?.source).filter(Boolean))]
        const formats = [...new Set(allAssets.map(asset => asset.metadata?.format).filter(Boolean))]
        const processingState = sortedAssets.find(asset => asset.processing)?.processing
          || meshAssets.find(asset => asset.processing)?.processing
          || persistedCard?.processing
          || null
        const isProcessing = processingState?.status === 'processing'
        const sourceLabel = processingState?.source
          ? String(processingState.source).toUpperCase()
          : (sources.length === 1 ? sources[0] : 'MIXED')
        const metaLabel = isProcessing
          ? processingState?.detail || 'Processing…'
          : sortedAssets.length === 1
            ? `${primaryAsset?.metadata?.resolution || 'N/A'} • ${primaryAsset?.metadata?.format || 'N/A'}`
            : sortedAssets.length > 1
              ? `${sortedAssets.length} images • ${formats.slice(0, 2).join(', ') || 'Mixed formats'}`
              : meshAssets.length === 1
                ? `${meshAssets[0]?.metadata?.format || 'N/A'} • 3D mesh`
                : meshAssets.length > 1
                  ? `${meshAssets.length} meshes • ${formats.slice(0, 2).join(', ') || 'Mixed formats'}`
              : (processingState?.detail || 'Waiting for output')

        return {
          id,
          assets: sortedAssets,
          meshAssets,
          allAssets,
          primaryAsset,
          primaryDisplayAsset,
          sourceLabel,
          metaLabel,
          processing: processingState,
          isLocked: isProcessing,
          cardDbId: primaryDisplayAsset?.cardDbId ?? persistedCard?.cardDbId ?? null,
          cardKey: primaryDisplayAsset?.cardKey || persistedCard?.id || id,
          kanbanColumnId: primaryDisplayAsset?.kanbanColumnId ?? persistedCard?.kanbanColumnId ?? 1,
          kanbanColumnName: primaryDisplayAsset?.kanbanColumnName || persistedCard?.kanbanColumnName || 'Images',
          cardPosition: primaryDisplayAsset?.cardPosition ?? persistedCard?.position ?? Number.MAX_SAFE_INTEGER,
          createdAt: primaryDisplayAsset?.createdAt || persistedCard?.createdAt || 0
        }
      })
      .filter(card => card.assets.length > 0 || card.meshAssets.length > 0 || card.processing)
      .sort((left, right) => {
        if (left.kanbanColumnId !== right.kanbanColumnId) {
          return left.kanbanColumnId - right.kanbanColumnId
        }

        if (left.cardPosition !== right.cardPosition) {
          return left.cardPosition - right.cardPosition
        }

        return right.createdAt - left.createdAt
      })
  }, [images, meshAssetsByCardId, projectCards, projectCardsById])

  const imageCardsByColumn = useMemo(() => {
    return IMAGE_CARD_COLUMNS.reduce((accumulator, column) => {
      accumulator[column.dbId] = imageCards.filter(card => card.kanbanColumnId === column.dbId)
      return accumulator
    }, {})
  }, [imageCards])

  useEffect(() => {
    const activePromptIdsByCardId = new Map(
      imageCards
        .filter(card => card.processing?.status === 'processing' && card.processing?.promptId)
        .map(card => [card.id, card.processing.promptId])
    )

    Object.entries(imageEditProgressByCardId).forEach(([cardId, runtimeState]) => {
      if (runtimeState?.promptId && runtimeState?.status !== 'completed') {
        activePromptIdsByCardId.set(cardId, runtimeState.promptId)
      }
    })

    imageEditProgressSubscriptionsRef.current.forEach((unsubscribe, cardId) => {
      const expectedPromptId = activePromptIdsByCardId.get(cardId)
      const currentPromptId = imageEditProgressByCardId[cardId]?.promptId

      if (!expectedPromptId || (currentPromptId && currentPromptId !== expectedPromptId)) {
        unsubscribe?.()
        imageEditProgressSubscriptionsRef.current.delete(cardId)
      }
    })

    activePromptIdsByCardId.forEach((promptId, cardId) => {
      if (!imageEditProgressByCardId[cardId] || imageEditProgressByCardId[cardId]?.promptId !== promptId) {
        const sourceCard = imageCards.find(card => card.id === cardId)
        if (sourceCard?.processing) {
          setImageEditProgressByCardId(prev => ({
            ...prev,
            [cardId]: sourceCard.processing
          }))
        }
      }

      if (imageEditProgressSubscriptionsRef.current.has(cardId)) {
        return
      }

      imageEditProgressSubscriptionsRef.current.set(cardId, subscribeToComfyWorkflowProgress(promptId, {
        onMessage: async (payload) => {
          setImageEditProgressByCardId(prev => ({
            ...prev,
            [cardId]: {
              ...(prev[cardId] || {}),
              ...payload,
              promptId
            }
          }))

          if (['completed', 'error'].includes(payload?.status)) {
            closeImageEditProgressSubscription(cardId)

            try {
              const [assetsData, cardsData] = await Promise.all([
                getProjectAssets(projectId),
                getProjectCards(projectId)
              ])
              setAssets(assetsData)
              setProjectCards(cardsData)
            } catch (err) {
              console.error('Failed to refresh project data after progress update:', err)
            }
          }
        },
        onError: () => {}
      }))
    })
  }, [imageCards, imageEditProgressByCardId, projectId, getProjectAssets, getProjectCards, subscribeToComfyWorkflowProgress])

  const cardAttributesByCardId = useMemo(() => {
    return cardAttributes.reduce((accumulator, attribute) => {
      if (!accumulator[attribute.cardId]) {
        accumulator[attribute.cardId] = []
      }

      accumulator[attribute.cardId].push(attribute)
      return accumulator
    }, {})
  }, [cardAttributes])

  const imageEditWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const valueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return valueTypes.includes('image')
        && outputValueTypes.includes('image')
        && valueTypes.every(valueType => ['image', 'string', 'number', 'boolean'].includes(valueType))
    })
  }, [comfyWorkflows])

  const meshGenWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const parameterValueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return parameterValueTypes.includes('image') && outputValueTypes.includes('mesh')
    })
  }, [comfyWorkflows])

  const meshEditWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const parameterValueTypes = (workflow.parameters || []).map(parameter => getWorkflowParameterValueType(parameter))
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return parameterValueTypes.includes('mesh')
        && outputValueTypes.includes('mesh')
        && parameterValueTypes.every(valueType => ['image', 'mesh', 'string', 'number', 'boolean'].includes(valueType))
    })
  }, [comfyWorkflows])

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

  const meshEditApis = useMemo(() => (
    customApis
      .filter(api => normalizeCustomApiType(api?.type) === 'mesh-edit')
      .map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ), [customApis])

  const getWorkflowsForCard = (card) => {
    if (card?.kanbanColumnId === 3) return meshGenWorkflows
    if (card?.kanbanColumnId === 4) return meshEditWorkflows
    return imageEditWorkflows
  }

  const getApiOptionsForColumnId = (columnId) => {
    if (columnId === 3) return meshGenerationApis
    if (columnId === 4) return meshEditApis
    return imageEditApis
  }

  const getApiOptionsForCard = (card) => getApiOptionsForColumnId(card?.kanbanColumnId)

  const getDefaultApiForCard = (card) => getApiOptionsForCard(card)[0]?.id || ''

  const getAttributeOptionsForCard = (cardId, typeName) => {
    const matchingAttributes = (cardAttributesByCardId[cardId] || []).filter(attribute => {
      const attributeType = attributeTypes.find(type => type.id === attribute.attributeTypeId)
      return attributeType?.name === typeName
    })

    return [
      ...matchingAttributes.map(attribute => ({
        id: `attribute:${attribute.position}`,
        label: attribute.attributeValue?.toString().trim() ? attribute.attributeValue : `${typeName} Attribute ${attribute.position + 1}`,
        value: attribute.attributeValue || ''
      })),
      { id: 'custom', label: 'Custom', value: '' }
    ]
  }

  const getPromptOptionsForCard = (cardId) => {
    return getAttributeOptionsForCard(cardId, 'Text')
  }

  const getCardImageSourceGroups = (card) => {
    return (card.assets || []).filter(asset => asset.type === 'image').map(asset => ({
      asset,
      options: [
        {
          value: `asset:${asset.id}`,
          label: asset.name,
          previewFilename: asset.filename,
          isEdit: false
        },
        ...getAssetChildren(asset).map((edit, index) => ({
          value: `edit:${edit.filePath}`,
          label: edit.name?.trim() || `Edit ${index + 1}`,
          previewFilename: edit.filename,
          isEdit: true
        }))
      ]
    }))
  }

  const getCardMeshSourceGroups = (card) => {
    return (card.meshAssets || []).filter(asset => asset.type === 'mesh').map(asset => ({
      asset,
      options: [
        {
          value: `asset:${asset.id}`,
          label: asset.name,
          previewFilename: asset.thumbnail || asset.filename,
          isEdit: false
        }
      ]
    }))
  }

  const getCardFileSourceGroups = (card, valueType) => valueType === 'mesh'
    ? getCardMeshSourceGroups(card)
    : getCardImageSourceGroups(card)

  const getWorkflowSourceOptionLabel = (valueType, option) => {
    const assetTypeLabel = valueType === 'mesh' ? 'Mesh' : 'Image'
    return option.isEdit ? `Edit • ${option.label}` : `${assetTypeLabel} • ${option.label}`
  }

  const getAssetEditDisplayItems = (asset) => {
    return [
      {
        key: `asset:${asset.id}`,
        name: asset.name,
        filename: asset.filename,
        width: asset.width,
        height: asset.height,
        isEdit: false
      },
      ...(getAssetChildren(asset).map((edit, index) => ({
        key: `edit:${edit.filePath}`,
        name: edit.name?.trim() || `Edit ${index + 1}`,
        filename: edit.filename,
        width: edit.width,
        height: edit.height,
        isEdit: true
      })))
    ]
  }

  const getCardPreviewItems = (card, showAttributes = false) => {
    const hasMeshAssets = (card.meshAssets?.length || 0) > 0
    const useMixedAssetCarousel = showAttributes && [3, 4].includes(card.kanbanColumnId) && hasMeshAssets

    if (!useMixedAssetCarousel) {
      return []
    }

    return [
      ...(card.assets || []).flatMap(asset => (
        getAssetEditDisplayItems(asset).map(item => ({
          key: item.key,
          name: item.name,
          filename: item.filename,
          width: item.width,
          height: item.height,
          assetType: 'image',
          isEdit: item.isEdit,
          asset
        }))
      )),
      ...((card.meshAssets || []).map(asset => ({
        key: `mesh:${asset.id}`,
        name: asset.name,
        filename: asset.filename,
        previewFilename: asset.thumbnail || null,
        assetType: 'mesh',
        isEdit: false,
        asset
      })))
    ]
  }

  const getAssetPreviewUrl = (filename) => {
    if (!filename) {
      return null
    }

    return `http://localhost:3001/assets/${encodeURI(filename)}`
  }

  const formatAssetDimensions = (width, height) => {
    if (!width || !height) {
      return null
    }

    return `${width} × ${height}`
  }

  const openMeshPreview = (asset) => {
    if (!asset?.filename) {
      return
    }

    setMeshPreviewAsset({
      name: asset.name,
      url: getAssetPreviewUrl(asset.filename)
    })
  }

  const handleImageEditPreviewStep = (asset, step) => {
    const itemCount = 1 + getAssetChildren(asset).length
    if (itemCount <= 1) {
      return
    }

    setImageEditPreviewIndexes(prev => {
      const currentIndex = prev[asset.id] || 0
      let nextIndex = currentIndex + step

      if (nextIndex < 0) {
        nextIndex = itemCount - 1
      }

      if (nextIndex >= itemCount) {
        nextIndex = 0
      }

      return {
        ...prev,
        [asset.id]: nextIndex
      }
    })
  }

  const createImageEditInputBindings = (card, workflow) => {
    return Object.fromEntries((workflow?.parameters || []).map(parameter => {
      const valueType = getWorkflowParameterValueType(parameter)

      if (['image', 'mesh'].includes(valueType)) {
        const defaultSource = getCardFileSourceGroups(card, valueType)[0]?.options?.[0]?.value || ''
        return [parameter.id, {
          source: defaultSource,
          customValue: ''
        }]
      }

      if (valueType === 'boolean') {
        return [parameter.id, {
          source: 'custom',
          customValue: Boolean(parameter.defaultValue ?? false)
        }]
      }

      const options = getAttributeOptionsForCard(card.id, valueType === 'number' ? 'Number' : 'Text')
      const firstOption = options[0] || { id: 'custom', value: parameter.defaultValue ?? '' }

      return [parameter.id, {
        source: firstOption.id,
        customValue: String(firstOption.id === 'custom' ? (parameter.defaultValue ?? '') : (firstOption.value ?? ''))
      }]
    }))
  }

  const getImageEditParameterBinding = (draft, parameter) => {
    const valueType = getWorkflowParameterValueType(parameter)

    return draft?.inputBindings?.[parameter.id] || {
      source: isFileWorkflowValueType(valueType) ? '' : 'custom',
      customValue: valueType === 'boolean' ? false : ''
    }
  }

  const resolveImageEditParameterValue = (card, draft, parameter) => {
    const binding = getImageEditParameterBinding(draft, parameter)
    const valueType = getWorkflowParameterValueType(parameter)

    if (isFileWorkflowValueType(valueType)) {
      return binding.source || ''
    }

    if (valueType === 'boolean') {
      return Boolean(binding.customValue)
    }

    if (binding.source?.startsWith('attribute:')) {
      const attributePosition = Number(binding.source.slice(10))
      const attribute = (cardAttributesByCardId[card.id] || []).find(item => item.position === attributePosition)
      return attribute?.attributeValue ?? ''
    }

    return binding.customValue ?? ''
  }

  const createImageEditDraft = (card, mode) => {
    const promptOptions = getPromptOptionsForCard(card.id)
    const firstPromptOption = promptOptions[0] || { id: 'custom', value: '' }
    const isCustomPrompt = firstPromptOption.id === 'custom'
    const availableWorkflows = getWorkflowsForCard(card)
    const initialWorkflow = mode === 'comfy' ? (availableWorkflows[0] || null) : null

    return {
      cardId: card.id,
      mode,
      name: '',
      selectedApi: getDefaultApiForCard(card),
      selectedAssetId: card.kanbanColumnId === 4
        ? (card.meshAssets[0]?.id ? `asset:${card.meshAssets[0].id}` : '')
        : (card.assets[0]?.id ? `asset:${card.assets[0].id}` : ''),
      workflowId: initialWorkflow?.id || '',
      inputBindings: createImageEditInputBindings(card, initialWorkflow),
      promptSource: firstPromptOption.id,
      customPrompt: isCustomPrompt ? '' : firstPromptOption.value,
      promptValue: isCustomPrompt ? '' : firstPromptOption.value
    }
  }

  const openImageEditActionMenu = (card, mode = null) => {
    if (!mode) {
      setImageEditDraft(prev => prev?.cardId === card.id && !prev?.mode ? null : { cardId: card.id, mode: null })
      return
    }

    setImageEditDraft(createImageEditDraft(card, mode))
  }

  const closeImageEditActionMenu = () => {
    if (imageEditDraft?.cardId) {
      closeImageEditProgressSubscription(imageEditDraft.cardId)
      setImageEditProgressByCardId(prev => {
        if (!(imageEditDraft.cardId in prev)) {
          return prev
        }

        const nextState = { ...prev }
        delete nextState[imageEditDraft.cardId]
        return nextState
      })
    }

    setImageEditDraft(null)
    setImageEditPendingCardId(null)
  }

  const handleImageEditDraftChange = (card, field, value) => {
    setImageEditDraft(prev => {
      if (!prev || prev.cardId !== card.id) {
        return prev
      }

      const nextDraft = {
        ...prev,
        [field]: value
      }

      if (field === 'promptSource') {
        const promptOption = getPromptOptionsForCard(card.id).find(option => option.id === value)
        nextDraft.promptValue = promptOption?.id === 'custom' ? (prev.customPrompt || '') : (promptOption?.value || '')
      }

      if (field === 'customPrompt') {
        nextDraft.promptValue = prev.promptSource === 'custom' ? value : prev.promptValue
      }

      if (field === 'mode' && value === 'comfy' && !nextDraft.workflowId) {
        const availableWorkflows = getWorkflowsForCard(card)
        nextDraft.workflowId = availableWorkflows[0]?.id || ''
        nextDraft.inputBindings = createImageEditInputBindings(card, availableWorkflows[0])
      }

      if (field === 'workflowId' && nextDraft.mode === 'comfy') {
        const workflow = getWorkflowsForCard(card).find(item => item.id == value)
        nextDraft.inputBindings = createImageEditInputBindings(card, workflow)
      }

      return nextDraft
    })
  }

  const handleImageEditParameterSourceChange = (card, parameter, source) => {
    setImageEditDraft(prev => {
      if (!prev || prev.cardId !== card.id) {
        return prev
      }

      const currentBinding = getImageEditParameterBinding(prev, parameter)
      const currentValue = resolveImageEditParameterValue(card, prev, parameter)
      const valueType = getWorkflowParameterValueType(parameter)

      return {
        ...prev,
        inputBindings: {
          ...(prev.inputBindings || {}),
          [parameter.id]: {
            ...currentBinding,
            source,
            customValue: source === 'custom'
              ? valueType === 'boolean'
                ? Boolean(currentValue ?? currentBinding.customValue ?? parameter.defaultValue ?? false)
                : String(currentValue ?? currentBinding.customValue ?? parameter.defaultValue ?? '')
              : currentBinding.customValue
          }
        }
      }
    })
  }

  const handleImageEditParameterValueChange = (card, parameter, value) => {
    setImageEditDraft(prev => {
      if (!prev || prev.cardId !== card.id) {
        return prev
      }

      const currentBinding = getImageEditParameterBinding(prev, parameter)

      return {
        ...prev,
        inputBindings: {
          ...(prev.inputBindings || {}),
          [parameter.id]: {
            ...currentBinding,
            customValue: value
          }
        }
      }
    })
  }

  const resolveDraftPrompt = (card, draft) => {
    const promptOption = getPromptOptionsForCard(card.id).find(option => option.id === draft.promptSource)
    if (promptOption?.id === 'custom') {
      return draft.customPrompt?.trim() || ''
    }

    return promptOption?.value?.trim() || ''
  }

  const handleRunImageEdit = async (card) => {
    if (!imageEditDraft || imageEditDraft.cardId !== card.id) {
      return
    }

    const name = imageEditDraft.name?.trim() || ''
    const isMeshGenCard = card.kanbanColumnId === 3
    const isMeshEditCard = card.kanbanColumnId === 4
    const isMeshWorkflowCard = isMeshGenCard || isMeshEditCard
    const actionLabel = isMeshGenCard ? 'mesh generation' : isMeshEditCard ? 'mesh edit' : 'image edit'
    const sourceAssetLabel = isMeshEditCard ? 'mesh' : 'image'

    try {
      setImageEditPendingCardId(card.id)

      if (imageEditDraft.mode === 'api') {
        const prompt = resolveDraftPrompt(card, imageEditDraft)

        if (!imageEditDraft.selectedAssetId || !prompt || !name) {
          showStatusMessage(`Select a ${sourceAssetLabel}, add a name, and provide a prompt.`, 'error')
          return
        }

        if (isMeshGenCard) {
          const generatedMesh = await runMeshGenerationApi(projectId, {
            imageSource: imageEditDraft.selectedAssetId,
            name,
            selectedApi: imageEditDraft.selectedApi,
            prompt,
            cardId: card.id
          })

          await ensureGeneratedMeshThumbnails(generatedMesh)
        } else if (isMeshEditCard) {
          const editedMesh = await runMeshEditApi(projectId, {
            meshSource: imageEditDraft.selectedAssetId,
            name,
            selectedApi: imageEditDraft.selectedApi,
            prompt,
            cardId: card.id
          })

          await ensureGeneratedMeshThumbnails(editedMesh)
        } else {
          await runImageEditApi(projectId, {
            imageSource: imageEditDraft.selectedAssetId,
            name,
            selectedApi: imageEditDraft.selectedApi,
            prompt
          })
        }
      } else if (imageEditDraft.mode === 'comfy') {
        if (!imageEditDraft.workflowId) {
          showStatusMessage('Select a ComfyUI workflow.', 'error')
          return
        }

        if (!name) {
          showStatusMessage('Add a name for the generated edit.', 'error')
          return
        }

        const workflow = getWorkflowsForCard(card).find(item => item.id == imageEditDraft.workflowId)
        if (!workflow) {
          showStatusMessage('Select a valid ComfyUI workflow.', 'error')
          return
        }

        const inputValues = {}
        let primaryAssetId = null

        for (const parameter of workflow.parameters || []) {
          const valueType = getWorkflowParameterValueType(parameter)
          const resolvedValue = resolveImageEditParameterValue(card, imageEditDraft, parameter)

          if (isFileWorkflowValueType(valueType)) {
            if (!resolvedValue) {
              showStatusMessage(`Select a ${valueType} for ${parameter.name}.`, 'error')
              return
            }

            const matchingAssetGroup = getCardFileSourceGroups(card, valueType).find(group => group.options.some(option => option.value === resolvedValue))
            if (!isMeshWorkflowCard && valueType === 'image' && !primaryAssetId && matchingAssetGroup?.asset?.id) {
              primaryAssetId = matchingAssetGroup.asset.id
            }

            inputValues[parameter.id] = { source: resolvedValue }
            continue
          }

          if (valueType === 'number') {
            const trimmedValue = String(resolvedValue ?? '').trim()
            if (trimmedValue === '' || Number.isNaN(Number(trimmedValue))) {
              showStatusMessage(`Enter a valid number for ${parameter.name}.`, 'error')
              return
            }

            inputValues[parameter.id] = trimmedValue
            continue
          }

          if (valueType === 'boolean') {
            inputValues[parameter.id] = Boolean(resolvedValue)
            continue
          }

          const trimmedValue = String(resolvedValue ?? '').trim()
          if (!trimmedValue) {
            showStatusMessage(`Enter a value for ${parameter.name}.`, 'error')
            return
          }

          inputValues[parameter.id] = trimmedValue
        }

        if (!isMeshWorkflowCard && !primaryAssetId) {
          showStatusMessage('Select at least one image input for the workflow.', 'error')
          return
        }

        const promptId = createComfyExecutionId('comfy-edit-prompt')
        const clientId = createComfyExecutionId('comfy-edit-client')

        setImageEditProgressByCardId(prev => ({
          ...prev,
          [card.id]: {
            status: 'processing',
            source: 'ComfyUI',
            progressPercent: 0,
            detail: `Preparing ComfyUI ${actionLabel}`,
            currentNodeLabel: 'Waiting for ComfyUI execution to start',
            promptId
          }
        }))

        closeImageEditProgressSubscription(card.id)
        imageEditProgressSubscriptionsRef.current.set(card.id, subscribeToComfyWorkflowProgress(promptId, {
          onMessage: (payload) => {
            setImageEditProgressByCardId(prev => {
              const currentState = prev[card.id]
              if (!currentState || currentState.promptId !== promptId) {
                return prev
              }

              return {
                ...prev,
                [card.id]: {
                  ...currentState,
                  status: payload?.status === 'error'
                    ? 'error'
                    : payload?.status === 'completed'
                      ? 'completed'
                      : 'processing',
                  source: payload?.source || currentState.source || 'ComfyUI',
                  progressPercent: Math.max(currentState.progressPercent || 0, Number(payload?.progressPercent) || 0),
                  detail: payload?.detail || currentState.detail,
                  currentNodeLabel: payload?.currentNodeLabel || currentState.currentNodeLabel
                }
              }
            })
          },
          onError: () => {}
        }))

        if (isMeshWorkflowCard) {
          const generatedMeshes = await runComfyWorkflow(projectId, {
            workflowId: Number(imageEditDraft.workflowId),
            cardId: card.id,
            name,
            inputs: inputValues,
            promptId,
            clientId
          })

          await ensureGeneratedMeshThumbnails(generatedMeshes)

          setImageEditProgressByCardId(prev => prev[card.id]
            ? {
                ...prev,
                [card.id]: {
                  ...prev[card.id],
                  progressPercent: 100,
                  detail: isMeshGenCard ? 'Saving generated mesh' : 'Saving edited mesh',
                  currentNodeLabel: isMeshGenCard ? 'ComfyUI mesh generation completed' : 'ComfyUI mesh edit completed'
                }
              }
            : prev)
        } else {
          await runImageEditComfy(projectId, {
            assetId: primaryAssetId,
            workflowId: Number(imageEditDraft.workflowId),
            name,
            inputValues,
            promptId,
            clientId
          })

          setImageEditProgressByCardId(prev => prev[card.id]
            ? {
                ...prev,
                [card.id]: {
                  ...prev[card.id],
                  progressPercent: 100,
                  detail: 'Saving edited image',
                  currentNodeLabel: 'ComfyUI image edit completed'
                }
              }
            : prev)
        }
      }

      await refreshProjectAssets()
      closeImageEditActionMenu()
      showStatusMessage(isMeshGenCard
        ? 'Mesh generation completed successfully.'
        : isMeshEditCard
          ? 'Mesh edit completed successfully.'
          : 'Image edit completed successfully.', 'success')
    } catch (err) {
      console.error(`Failed to run ${actionLabel}:`, err)
      await refreshProjectAssets().catch(refreshErr => {
        console.error('Failed to refresh project assets after action error:', refreshErr)
      })
      showStatusMessage(err.message || (isMeshGenCard
        ? 'Failed to run mesh generation'
        : isMeshEditCard
          ? 'Failed to run mesh edit'
          : 'Failed to run image edit'), 'error')
    } finally {
      closeImageEditProgressSubscription(card.id)
      setImageEditProgressByCardId(prev => {
        if (!(card.id in prev)) {
          return prev
        }

        const nextState = { ...prev }
        delete nextState[card.id]
        return nextState
      })
      setImageEditPendingCardId(null)
    }
  }

  const getCardRuntimeState = (card) => {
    const liveState = imageEditProgressByCardId[card.id]
    if (liveState?.status === 'completed') {
      return null
    }

    return liveState || card.processing || null
  }

  const isCardLocked = (card) => getCardRuntimeState(card)?.status === 'processing'

  const getCardInsertPosition = (cardId, destinationColumnId, destinationIndex) => {
    const sourceColumnId = draggedCard?.columnId
    const sourceCards = imageCardsByColumn[sourceColumnId] || []
    const sourceIndex = sourceCards.findIndex(card => card.id === cardId)

    if (sourceColumnId === destinationColumnId && sourceIndex !== -1 && sourceIndex < destinationIndex) {
      return destinationIndex - 1
    }

    return destinationIndex
  }

  const handleCardDragStart = (event, card) => {
    if (isCardLocked(card)) {
      event.preventDefault()
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', card.id)
    setDraggedCard({ id: card.id, columnId: card.kanbanColumnId })
    setDropTarget({ columnId: card.kanbanColumnId, position: card.cardPosition ?? 0 })
  }

  const handleCardDragEnd = () => {
    setDraggedCard(null)
    setDropTarget(null)
  }

  const handleCardDragOver = (event, columnId, position) => {
    event.preventDefault()

    if (!draggedCard) {
      return
    }

    setDropTarget({ columnId, position })
  }

  const handleCardDrop = async (event, columnId, destinationIndex) => {
    event.preventDefault()

    if (!draggedCard) {
      return
    }

    const nextPosition = getCardInsertPosition(draggedCard.id, columnId, destinationIndex)

    try {
      await moveKanbanCard(projectId, draggedCard.id, columnId, nextPosition)
      await Promise.all([refreshProjectAssets(), refreshCardAttributes()])
    } catch (err) {
      console.error('Failed to move card:', err)
      showStatusMessage(err.message || 'Failed to move card', 'error')
    } finally {
      handleCardDragEnd()
    }
  }

  const handleAddCustomAttribute = async (cardId) => {
    try {
      await createCardAttribute(projectId, cardId, {
        attributeTypeId: attributeTypes[0]?.id || DEFAULT_ATTRIBUTE_TYPE_ID,
        attributeValue: ''
      })
      await refreshCardAttributes()
    } catch (err) {
      console.error('Failed to add custom attribute:', err)
      showStatusMessage(err.message || 'Failed to add custom attribute', 'error')
    }
  }

  const handleAttributeTypeChange = async (cardId, position, attributeTypeId) => {
    try {
      await updateCardAttribute(projectId, cardId, position, { attributeTypeId })
      await refreshCardAttributes()
    } catch (err) {
      console.error('Failed to update attribute type:', err)
      showStatusMessage(err.message || 'Failed to update attribute type', 'error')
    }
  }

  const handleAttributeValueChange = (cardId, position, value) => {
    setCardAttributes(prev => prev.map(attribute => {
      if (attribute.cardId !== cardId || attribute.position !== position) {
        return attribute
      }

      return {
        ...attribute,
        attributeValue: value
      }
    }))
  }

  const handleAttributeValueBlur = async (cardId, position, attributeValue) => {
    try {
      await updateCardAttribute(projectId, cardId, position, { attributeValue })
      await refreshCardAttributes()
    } catch (err) {
      console.error('Failed to update attribute value:', err)
      showStatusMessage(err.message || 'Failed to update attribute value', 'error')
    }
  }

  const handleDeleteCustomAttribute = async (cardId, position) => {
    try {
      await deleteCardAttribute(projectId, cardId, position)
      await refreshCardAttributes()
    } catch (err) {
      console.error('Failed to delete attribute:', err)
      showStatusMessage(err.message || 'Failed to delete attribute', 'error')
    }
  }

  if (loading && !project) {
    return (
      <div className="kanban-layout" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="font-headline">Synchronizing Workspace...</p>
      </div>
    )
  }

  const draftColumnId = imageDraft?.cardId
    ? imageCards.find(card => card.id === imageDraft.cardId)?.kanbanColumnId || IMAGE_CARD_COLUMNS[0].dbId
    : IMAGE_CARD_COLUMNS[0].dbId

  const renderDropZone = (columnId, position, isEmpty = false) => {
    const isActive = dropTarget?.columnId === columnId && dropTarget?.position === position
    const column = IMAGE_CARD_COLUMNS.find(item => item.dbId === columnId)

    return (
      <div
        key={`drop-zone-${columnId}-${position}`}
        className={`kanban-drop-zone ${isActive ? 'kanban-drop-zone--active' : ''} ${isEmpty ? 'kanban-drop-zone--empty' : ''}`}
        onDragOver={event => handleCardDragOver(event, columnId, position)}
        onDrop={event => handleCardDrop(event, columnId, position)}
      >
        {isEmpty && !imageDraft && !pendingImageGeneration && (
          <span className="kanban-drop-zone__label font-label">
            {column?.emptyLabel || 'Drop image cards here'}
          </span>
        )}
      </div>
    )
  }

  const renderImageCard = (card, showAttributes = false) => {
    const runtimeState = getCardRuntimeState(card)
    const cardLocked = runtimeState?.status === 'processing'
    const displaySourceLabel = runtimeState?.source
      ? String(runtimeState.source).toUpperCase()
      : card.sourceLabel
    const displayMetaLabel = cardLocked
      ? (Number.isFinite(runtimeState?.progressPercent)
          ? `${runtimeState.progressPercent}%`
          : (runtimeState?.detail || card.metaLabel || 'Processing…'))
      : card.metaLabel
    const isMeshGenCard = card.kanbanColumnId === 3
    const isMeshEditCard = card.kanbanColumnId === 4
    const isMeshWorkflowCard = isMeshGenCard || isMeshEditCard
    const carouselItems = getCardPreviewItems(card, showAttributes)
    const useAssetCarousel = carouselItems.length > 0
    const previewAssets = isMeshWorkflowCard && (card.meshAssets?.length || 0) > 0 && !useAssetCarousel
      ? card.meshAssets
      : card.assets
    const totalPages = useAssetCarousel
      ? Math.max(1, carouselItems.length)
      : Math.max(1, Math.ceil(previewAssets.length / 4))
    const currentPage = Math.min(imageCardPages[card.id] || 0, totalPages - 1)
    const visibleAssets = useAssetCarousel
      ? carouselItems.slice(currentPage, currentPage + 1)
      : previewAssets.slice(currentPage * 4, currentPage * 4 + 4)
    const attributes = cardAttributesByCardId[card.id] || []
    const imageSourceGroups = getCardImageSourceGroups(card)
    const meshSourceGroups = getCardMeshSourceGroups(card)
    const availableActionApis = getApiOptionsForCard(card)
    const availableActionWorkflows = getWorkflowsForCard(card)
    const selectedActionWorkflow = availableActionWorkflows.find(workflow => workflow.id == imageEditDraft?.workflowId) || null
    const apiSourceGroups = isMeshEditCard ? meshSourceGroups : imageSourceGroups
    const apiSourceValueType = isMeshEditCard ? 'mesh' : 'image'

    return (
      <div
        key={card.id}
        className={`image-card ${draggedCard?.id === card.id ? 'image-card--dragging' : ''} ${cardLocked ? 'image-card--loading image-card--locked' : ''}`}
        id={`image-card-${card.id}`}
        draggable={!cardLocked}
        onDragStart={(event) => handleCardDragStart(event, card)}
        onDragEnd={handleCardDragEnd}
      >
        <div className="image-card__actions">
          {!showAttributes && (
            <button
              className="image-card__action-btn"
              disabled={cardLocked}
              onClick={(e) => {
                e.stopPropagation()
                openImageSourceMenu(card.id)
              }}
              title="Add more images"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add_photo_alternate</span>
            </button>
          )}
          <button
            className="image-card__action-btn image-card__delete"
            disabled={cardLocked}
            onClick={(e) => {
              e.stopPropagation()
              handleRemoveImageCard(card.allAssets || card.assets)
            }}
            title="Remove card"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className={`image-card__thumb ${visibleAssets.length > 1 && !useAssetCarousel ? 'image-card__thumb--grid' : ''} ${useAssetCarousel ? 'image-card__thumb--carousel' : ''} ${cardLocked && visibleAssets.length === 0 ? 'image-card__thumb--loading' : ''}`}>
          {visibleAssets.length > 0 ? (
            visibleAssets.map(asset => {
              const displayItems = showAttributes && !useAssetCarousel && asset.type === 'image' ? getAssetEditDisplayItems(asset) : []
              const previewIndex = showAttributes
                ? Math.min(imageEditPreviewIndexes[asset.id] || 0, Math.max(0, displayItems.length - 1))
                : 0
              const previewItem = showAttributes ? (displayItems[previewIndex] || displayItems[0]) : asset
              const previewFilename = useAssetCarousel
                ? (asset.previewFilename || asset.filename)
                : (showAttributes ? previewItem?.filename : asset.filename)
              const previewName = useAssetCarousel
                ? asset.name
                : (showAttributes ? previewItem?.name : asset.name)
              const previewDimensions = useAssetCarousel
                ? formatAssetDimensions(asset.width, asset.height)
                : (showAttributes ? formatAssetDimensions(previewItem?.width, previewItem?.height) : formatAssetDimensions(asset.width, asset.height))
              const previewType = useAssetCarousel ? asset.assetType : asset.type
              const previewUrl = getAssetPreviewUrl(previewFilename)
              const sourceAsset = useAssetCarousel ? asset.asset : asset
              const modelUrl = getAssetPreviewUrl(sourceAsset?.filename)

              return (
              <div
                key={asset.key || asset.id}
                className={`image-card__thumb-item ${previewType === 'mesh' ? 'image-card__thumb-item--mesh' : ''}`}
                onClick={previewType === 'mesh' ? (event) => {
                  event.stopPropagation()
                  openMeshPreview(sourceAsset)
                } : undefined}
                role={previewType === 'mesh' ? 'button' : undefined}
                tabIndex={previewType === 'mesh' ? 0 : undefined}
                onKeyDown={previewType === 'mesh' ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    openMeshPreview(sourceAsset)
                  }
                } : undefined}
              >
                {previewType === 'mesh' && previewUrl ? (
                  asset.previewFilename ? (
                    <img
                      src={previewUrl}
                      alt={previewName}
                      className="image-card__thumb-image"
                    />
                  ) : (
                    <Viewer
                      height="100%"
                      modelUrl={modelUrl}
                    />
                  )
                ) : previewFilename ? (
                  <img
                    src={previewUrl}
                    alt={previewName}
                    className="image-card__thumb-image"
                  />
                ) : (
                  <div className="image-card__thumb-placeholder">
                    <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>{previewType === 'mesh' ? 'deployed_code' : 'image'}</span>
                  </div>
                )}

                {!showAttributes && !useAssetCarousel && (
                  <button
                    className="image-card__thumb-remove"
                    disabled={cardLocked}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemoveImage(asset.id)
                    }}
                    title="Remove image"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
                  </button>
                )}

                {previewType === 'mesh' && sourceAsset?.id && (
                  <button
                    className="image-card__thumb-remove image-card__thumb-remove--left"
                    disabled={cardLocked}
                    onClick={(event) => {
                      event.stopPropagation()
                      handleRemoveImage(sourceAsset.id)
                    }}
                    title="Remove mesh"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
                  </button>
                )}

                {showAttributes && (
                  <div className="image-card__thumb-caption font-label">
                    {previewName}
                  </div>
                )}

                {previewType === 'image' && previewDimensions && (
                  <div className={`image-card__thumb-dimensions font-label ${showAttributes ? 'image-card__thumb-dimensions--with-caption' : ''}`}>
                    {previewDimensions}
                  </div>
                )}

                {useAssetCarousel && previewType === 'mesh' && (
                  <div className="image-card__edit-preview-indicator font-label">
                    3D MESH
                  </div>
                )}

                {showAttributes && !useAssetCarousel && displayItems.length > 1 && (
                  <>
                    <div className="image-card__edit-preview-indicator font-label">
                      {previewIndex === 0
                        ? `ORIGINAL • 1/${displayItems.length}`
                        : `EDIT ${previewIndex}/${displayItems.length - 1} • ${previewIndex + 1}/${displayItems.length}`}
                    </div>
                    <button
                      className="image-card__thumb-nav image-card__thumb-nav--prev"
                      onClick={(event) => {
                        event.stopPropagation()
                        handleImageEditPreviewStep(asset, -1)
                      }}
                      title="Previous image edit"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_left</span>
                    </button>
                    <button
                      className="image-card__thumb-nav image-card__thumb-nav--next"
                      onClick={(event) => {
                        event.stopPropagation()
                        handleImageEditPreviewStep(asset, 1)
                      }}
                      title="Next image edit"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_right</span>
                    </button>
                  </>
                )}
              </div>
            )})
          ) : cardLocked ? (
            <div className="image-card__loading-state">
              <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
              <span className="font-label image-card__loading-label">
                {Number.isFinite(runtimeState?.progressPercent) ? `${runtimeState.progressPercent}%` : 'PROCESSING'}
              </span>
            </div>
          ) : (
            <div className="image-card__thumb-placeholder">
              <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
            </div>
          )}

          {totalPages > 1 && (
            <>
              <button
                className="image-card__thumb-nav image-card__thumb-nav--prev"
                onClick={(e) => {
                  e.stopPropagation()
                  setImageCardPages(prev => ({
                    ...prev,
                    [card.id]: Math.max(0, currentPage - 1)
                  }))
                }}
                disabled={cardLocked || currentPage === 0}
                title={useAssetCarousel ? 'Previous asset' : 'Previous images'}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_left</span>
              </button>
              <button
                className="image-card__thumb-nav image-card__thumb-nav--next"
                onClick={(e) => {
                  e.stopPropagation()
                  setImageCardPages(prev => ({
                    ...prev,
                    [card.id]: Math.min(totalPages - 1, currentPage + 1)
                  }))
                }}
                disabled={cardLocked || currentPage >= totalPages - 1}
                title={useAssetCarousel ? 'Next asset' : 'Next images'}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_right</span>
              </button>
              <div className="image-card__thumb-page-indicator font-label">
                {currentPage + 1}/{totalPages}
              </div>
            </>
          )}
        </div>

        <div className="image-card__info">
          <div className="image-card__row">
            <h3 className="image-card__name">{card.primaryDisplayAsset?.name || 'Untitled asset'}</h3>
            <div className="image-card__badges">
              {card.assets.length > 1 && (
                <span className="image-card__count font-label">{card.assets.length} IMAGES</span>
              )}
              <span
                className="image-card__source"
                style={{
                  color: ['AI GEN', 'COMFYUI'].includes(displaySourceLabel) ? 'var(--primary)' : 'var(--on-surface-variant)',
                  background: ['AI GEN', 'COMFYUI'].includes(displaySourceLabel) ? 'rgba(143,245,255,0.1)' : 'rgba(71,72,74,0.2)',
                }}
              >
                {displaySourceLabel}
              </span>
            </div>
          </div>
          <p className="image-card__meta font-label">{displayMetaLabel}</p>

          {runtimeState && (
            <div className="image-card__edit-progress">
              <p className="image-card__meta font-label">{runtimeState.detail || (cardLocked ? 'Processing…' : 'Last operation update')}</p>
              {runtimeState.currentNodeLabel && (
                <p className="image-card__meta font-label image-card__meta--loading-node">
                  {runtimeState.currentNodeLabel}
                </p>
              )}
              {Number.isFinite(runtimeState.progressPercent) && (
                <div className="image-card__progress" aria-hidden="true">
                  <div
                    className="image-card__progress-bar"
                    style={{ width: `${Math.max(0, Math.min(100, runtimeState.progressPercent || 0))}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {showAttributes && (
            <div className="image-card__attributes">
              <div className="image-card__edit-actions">
                <button className="image-card__edit-action-btn" onClick={() => openImageEditActionMenu(card)} disabled={cardLocked}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                  Action
                </button>

                {imageEditDraft?.cardId === card.id && !imageEditDraft?.mode && imageEditPendingCardId !== card.id && (
                  <div className="image-card__edit-action-menu">
                    <button className="image-card__edit-action-option" onClick={() => openImageEditActionMenu(card, 'api')}>
                      API
                    </button>
                    <button className="image-card__edit-action-option" onClick={() => openImageEditActionMenu(card, 'comfy')}>
                      ComfyUI
                    </button>
                  </div>
                )}

                {imageEditDraft?.cardId === card.id && imageEditDraft?.mode && imageEditPendingCardId !== card.id && (
                  <div className="image-card__edit-panel">
                    <div className="params-card__field">
                      <label className="params-card__label font-label">NAME</label>
                      <input
                        type="text"
                        className="params-card__input"
                        value={imageEditDraft.name}
                        onChange={event => handleImageEditDraftChange(card, 'name', event.target.value)}
                        placeholder="Enter edit name"
                        required
                      />
                    </div>

                    {imageEditDraft.mode === 'api' ? (
                      <>
                        <div className="params-card__field">
                          <label className="params-card__label font-label">{isMeshEditCard ? 'Mesh' : 'Image'}</label>
                          <select
                            className="image-card__attribute-select"
                            value={imageEditDraft.selectedAssetId}
                            onChange={event => handleImageEditDraftChange(card, 'selectedAssetId', event.target.value)}
                          >
                            {apiSourceGroups.length === 0 && <option value="">{isMeshEditCard ? 'No meshes available' : 'No images available'}</option>}
                            {apiSourceGroups.map(group => (
                              <optgroup key={group.asset.id} label={group.asset.name}>
                                {group.options.map(option => (
                                  <option key={option.value} value={option.value}>
                                    {getWorkflowSourceOptionLabel(apiSourceValueType, option)}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </div>

                        <div className="params-card__field">
                          <label className="params-card__label font-label">API</label>
                          <select
                            className="image-card__attribute-select"
                            value={imageEditDraft.selectedApi}
                            onChange={event => handleImageEditDraftChange(card, 'selectedApi', event.target.value)}
                            disabled={availableActionApis.length === 0}
                          >
                            {availableActionApis.length === 0 && <option value="">No APIs available</option>}
                            {availableActionApis.map(api => (
                              <option key={api.id} value={api.id}>{api.name}</option>
                            ))}
                          </select>
                        </div>

                        <div className="params-card__field">
                          <label className="params-card__label font-label">Prompt Source</label>
                          <select
                            className="image-card__attribute-select"
                            value={imageEditDraft.promptSource}
                            onChange={event => handleImageEditDraftChange(card, 'promptSource', event.target.value)}
                          >
                            {getPromptOptionsForCard(card.id).map(option => (
                              <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                          </select>
                        </div>

                        {imageEditDraft.promptSource === 'custom' && (
                          <div className="params-card__field">
                            <label className="params-card__label font-label">Custom Prompt</label>
                            <textarea
                              className="gen-prompt-input"
                              value={imageEditDraft.customPrompt}
                              onChange={event => handleImageEditDraftChange(card, 'customPrompt', event.target.value)}
                              placeholder="Enter a custom prompt"
                            />
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="params-card__field">
                          <label className="params-card__label font-label">ComfyUI Workflow</label>
                          <select
                            className="image-card__attribute-select"
                            value={imageEditDraft.workflowId}
                            onChange={event => handleImageEditDraftChange(card, 'workflowId', event.target.value)}
                            disabled={availableActionWorkflows.length === 0}
                          >
                            {availableActionWorkflows.length === 0 && <option value="">No workflows available</option>}
                            {availableActionWorkflows.map(workflow => (
                              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                            ))}
                          </select>
                        </div>

                        {selectedActionWorkflow ? (
                          selectedActionWorkflow.parameters.map(parameter => {
                            const valueType = getWorkflowParameterValueType(parameter)
                            const binding = getImageEditParameterBinding(imageEditDraft, parameter)
                            const resolvedValue = resolveImageEditParameterValue(card, imageEditDraft, parameter)

                            if (['image', 'mesh'].includes(valueType)) {
                              const selectedAssetSource = binding.source || ''
                              const sourceGroups = getCardFileSourceGroups(card, valueType)

                              return (
                                <div key={parameter.id} className="params-card__field">
                                  <label className="params-card__label font-label">{parameter.name} • {valueType.toUpperCase()}</label>
                                  <select
                                    className="image-card__attribute-select"
                                    value={selectedAssetSource}
                                    onChange={event => handleImageEditParameterSourceChange(card, parameter, event.target.value)}
                                  >
                                    {sourceGroups.map(group => (
                                      <optgroup key={group.asset.id} label={group.asset.name}>
                                        {group.options.map(option => (
                                          <option key={option.value} value={option.value}>
                                            {getWorkflowSourceOptionLabel(valueType, option)}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ))}
                                  </select>
                                  <span className="image-card__param-hint">{parameter.label}</span>
                                </div>
                              )
                            }

                            if (valueType === 'boolean') {
                              return (
                                <div key={parameter.id} className="params-card__field">
                                  <label className="params-card__label font-label">{parameter.name} • BOOLEAN</label>
                                  <label className="params-card__checkbox-label">
                                    <div className={`params-card__checkbox ${binding.customValue ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => handleImageEditParameterValueChange(card, parameter, !binding.customValue)}>
                                      {binding.customValue && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                                    </div>
                                    <span>{parameter.label || 'Toggle value'}</span>
                                  </label>
                                </div>
                              )
                            }

                            const sourceOptions = getAttributeOptionsForCard(card.id, valueType === 'number' ? 'Number' : 'Text')

                            return (
                              <div key={parameter.id} className="params-card__field">
                                <label className="params-card__label font-label">{parameter.name} • {valueType.toUpperCase()}</label>
                                <select
                                  className="image-card__attribute-select"
                                  value={binding.source || 'custom'}
                                  onChange={event => handleImageEditParameterSourceChange(card, parameter, event.target.value)}
                                >
                                  {sourceOptions.map(option => (
                                    <option key={option.id} value={option.id}>{option.label}</option>
                                  ))}
                                </select>
                                {valueType === 'string' ? (
                                  <textarea
                                    className="gen-prompt-input image-card__param-textarea"
                                    value={binding.source === 'custom' ? (binding.customValue ?? '') : String(resolvedValue ?? '')}
                                    onChange={event => handleImageEditParameterValueChange(card, parameter, event.target.value)}
                                    disabled={binding.source !== 'custom'}
                                    placeholder={`Enter ${valueType} value`}
                                  />
                                ) : (
                                  <input
                                    type={valueType === 'number' ? 'number' : 'text'}
                                    className="params-card__input"
                                    value={binding.source === 'custom' ? (binding.customValue ?? '') : String(resolvedValue ?? '')}
                                    onChange={event => handleImageEditParameterValueChange(card, parameter, event.target.value)}
                                    disabled={binding.source !== 'custom'}
                                    placeholder={`Enter ${valueType} value`}
                                  />
                                )}
                                <span className="image-card__param-hint">{parameter.label}</span>
                              </div>
                            )
                          })
                        ) : (
                          <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                            <span className="material-symbols-outlined">tune</span>
                            <span>{isMeshGenCard
                              ? 'No compatible ComfyUI workflow available for mesh generation.'
                              : isMeshEditCard
                                ? 'No compatible ComfyUI workflow available for mesh edits.'
                                : 'No compatible ComfyUI workflow available for image edits.'}</span>
                          </div>
                        )}
                      </>
                    )}

                    <div className="image-card__edit-panel-actions">
                      <button
                        className="gen-btn"
                        onClick={() => handleRunImageEdit(card)}
                        disabled={imageEditPendingCardId === card.id || !imageEditDraft.name?.trim()}
                      >
                        <span className="material-symbols-outlined">bolt</span>
                        {imageEditPendingCardId === card.id
                          ? `${imageEditProgressByCardId[card.id]?.progressPercent || 0}%`
                          : 'RUN ACTION'}
                      </button>
                      <button className="kanban-sidebar__nav-item" onClick={closeImageEditActionMenu} style={{ justifyContent: 'center' }}>
                        CANCEL
                      </button>
                    </div>

                    {imageEditPendingCardId === card.id && imageEditProgressByCardId[card.id] && (
                      <div className="image-card__edit-progress">
                        <p className="image-card__meta font-label">{imageEditProgressByCardId[card.id].detail}</p>
                        {imageEditProgressByCardId[card.id].currentNodeLabel && (
                          <p className="image-card__meta font-label image-card__meta--loading-node">
                            {imageEditProgressByCardId[card.id].currentNodeLabel}
                          </p>
                        )}
                        <div className="image-card__progress" aria-hidden="true">
                          <div
                            className="image-card__progress-bar"
                            style={{ width: `${Math.max(0, Math.min(100, imageEditProgressByCardId[card.id].progressPercent || 0))}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="image-card__attributes-header">
                <span className="image-card__attributes-title font-label">CUSTOM ATTRIBUTES</span>
                <button className="image-card__attribute-add" onClick={() => handleAddCustomAttribute(card.id)} disabled={cardLocked}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
                  Add Custom Attribute
                </button>
              </div>

              {attributes.length > 0 ? (
                <div className="image-card__attribute-list">
                  {attributes.map(attribute => {
                    const selectedType = attributeTypes.find(type => type.id === attribute.attributeTypeId)

                    return (
                      <div key={`${attribute.cardId}-${attribute.position}`} className="image-card__attribute-row">
                        <select
                          className="image-card__attribute-select"
                          value={attribute.attributeTypeId}
                          onChange={event => handleAttributeTypeChange(card.id, attribute.position, Number(event.target.value))}
                          disabled={cardLocked}
                        >
                          {attributeTypes.map(type => (
                            <option key={type.id} value={type.id}>{type.name}</option>
                          ))}
                        </select>

                        <input
                          type={selectedType?.name === 'Number' ? 'number' : 'text'}
                          className="image-card__attribute-input"
                          value={attribute.attributeValue || ''}
                          onChange={event => handleAttributeValueChange(card.id, attribute.position, event.target.value)}
                          onBlur={event => handleAttributeValueBlur(card.id, attribute.position, event.target.value)}
                          disabled={cardLocked}
                          placeholder={`Enter ${selectedType?.name?.toLowerCase() || 'attribute'} value`}
                        />

                        <button
                          className="image-card__attribute-delete"
                          onClick={() => handleDeleteCustomAttribute(card.id, attribute.position)}
                          disabled={cardLocked}
                          title="Delete attribute"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="image-card__attribute-empty">
                  No custom attributes yet.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderImageColumn = (column) => {
    const cards = imageCardsByColumn[column.dbId] || []

    return (
      <div key={column.id} className="kanban-col" id={`col-${column.id}`}>
        <div className="kanban-col__header">
          <div className="kanban-col__title-group">
            <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--primary)' }}>{column.icon}</span>
            <h2 className="kanban-col__title font-headline">{column.title}</h2>
          </div>
          <span className="kanban-col__badge font-label">{cards.length.toString().padStart(2, '0')} ITEMS</span>
        </div>

        <div className="kanban-col__content">
          {cards.length === 0 && renderDropZone(column.dbId, 0, true)}

          {cards.map((card, index) => (
            <Fragment key={card.id}>
              {renderDropZone(column.dbId, index)}
              {renderImageCard(card, column.showAttributes)}
            </Fragment>
          ))}

          {cards.length > 0 && renderDropZone(column.dbId, cards.length)}

          {imageDraft && draftColumnId === column.dbId && (
            <div className="image-card image-card--draft">
              {imageDraft.mode === 'select' && (
                <div className="image-card__options">
                  <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>IMAGE SOURCE</span>
                  <button className="option-btn" onClick={() => openLocalFilePicker(imageDraft?.cardId || null)}>
                    <span className="material-symbols-outlined">computer</span>
                    Local Computer
                  </button>
                  <button className="option-btn" onClick={() => openAssetLibrary(imageDraft?.cardId || null)}>
                    <span className="material-symbols-outlined">folder_open</span>
                    From Assets
                  </button>
                  <button className="option-btn" onClick={() => openComfyWorkflowDraft(imageDraft?.cardId || null)}>
                    <span className="material-symbols-outlined">account_tree</span>
                    ComfyUI Workflow
                  </button>
                  <button className="option-btn" onClick={() => setImageDraft({ mode: 'api', selectedApi: imageGenerationApis[0]?.id || '', prompt: '', cardId: imageDraft?.cardId || null })}>
                    <span className="material-symbols-outlined">api</span>
                    Remote API
                  </button>
                  <button className="kanban-sidebar__nav-item" onClick={() => setImageDraft(null)} style={{ marginTop: '0.5rem', justifyContent: 'center' }}>CANCEL</button>
                </div>
              )}

              {imageDraft.mode === 'assets' && (
                <div className="image-card__options">
                  <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>FROM ASSETS</span>
                  {libraryLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading images...</span>
                    </div>
                  ) : libraryAssets.images.length > 0 ? (
                    <div className="image-card__asset-picker">
                      {libraryAssets.images.map(asset => (
                        <button
                          key={asset.id}
                          className="image-card__asset-option"
                          onClick={() => handleAttachLibraryImage(asset)}
                        >
                          <img
                            src={asset.url}
                            alt={asset.name}
                            className="image-card__asset-thumb"
                          />
                          <span className="image-card__asset-name">{asset.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">perm_media</span>
                      <span>No images available in `assets/images`.</span>
                    </div>
                  )}
                  <button className="kanban-sidebar__nav-item" onClick={() => openImageSourceMenu(imageDraft?.cardId || null)} style={{ justifyContent: 'center' }}>BACK</button>
                </div>
              )}

              {imageDraft.mode === 'comfy' && (
                <div className="image-card__options">
                  <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>COMFYUI WORKFLOW</span>
                  {comfyLoading ? (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                      <span>Loading workflows...</span>
                    </div>
                  ) : imageGenerationWorkflows.length > 0 ? (
                    <>
                      <select
                        className="params-card__select"
                        value={imageDraft.workflowId}
                        onChange={e => handleComfyWorkflowChange(e.target.value)}
                      >
                        {imageGenerationWorkflows.map(workflow => (
                          <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                        ))}
                      </select>

                      <div className="image-card__workflow-meta">
                        <span>{selectedComfyWorkflow?.parameters?.length || 0} input parameters configured</span>
                        <span>{selectedComfyWorkflow?.outputs?.length || 0} outputs selected</span>
                      </div>

                      <div className="gen-section">
                        {(selectedComfyWorkflow?.parameters || []).length > 0 ? (
                          <div className="image-card__workflow-params">
                            {selectedComfyWorkflow.parameters.map(parameter => (
                              <div key={parameter.id} className="params-card__field">
                                <label className="params-card__label font-label">
                                  {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                                </label>

                                {isFileWorkflowValueType(getWorkflowParameterValueType(parameter)) ? (
                                  <label className="image-card__file-input">
                                    <input
                                      type="file"
                                      accept={getWorkflowFileInputAccept(getWorkflowParameterValueType(parameter))}
                                      onChange={e => handleComfyInputChange(parameter, e.target.files?.[0] || null)}
                                    />
                                    <span className="material-symbols-outlined">
                                      {getWorkflowFileInputIcon(getWorkflowParameterValueType(parameter))}
                                    </span>
                                    <span>
                                      {imageDraft.inputs?.[parameter.id]?.name || `Select ${getWorkflowParameterValueType(parameter)} file`}
                                    </span>
                                  </label>
                                ) : getWorkflowParameterValueType(parameter) === 'boolean' ? (
                                  <label className="params-card__checkbox-label">
                                    <div className={`params-card__checkbox ${imageDraft.inputs?.[parameter.id] ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => handleComfyInputChange(parameter, !(imageDraft.inputs?.[parameter.id]))}>
                                      {imageDraft.inputs?.[parameter.id] && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                                    </div>
                                    <span>{parameter.label || 'Toggle value'}</span>
                                  </label>
                                ) : getWorkflowParameterValueType(parameter) === 'string' ? (
                                  <textarea
                                    className="gen-prompt-input image-card__param-textarea"
                                    value={imageDraft.inputs?.[parameter.id] ?? ''}
                                    onChange={e => handleComfyInputChange(parameter, e.target.value)}
                                  />
                                ) : parameter.type === 'json' ? (
                                  <textarea
                                    className="gen-prompt-input image-card__param-textarea"
                                    value={typeof imageDraft.inputs?.[parameter.id] === 'string'
                                      ? imageDraft.inputs?.[parameter.id]
                                      : JSON.stringify(imageDraft.inputs?.[parameter.id] ?? parameter.defaultValue, null, 2)}
                                    onChange={e => handleComfyInputChange(parameter, e.target.value)}
                                  />
                                ) : (
                                  <input
                                    type={getWorkflowParameterValueType(parameter) === 'number' ? 'number' : 'text'}
                                    className="params-card__input"
                                    value={imageDraft.inputs?.[parameter.id] ?? ''}
                                    onChange={e => handleComfyInputChange(parameter, e.target.value)}
                                  />
                                )}

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

                        <button className="gen-btn" onClick={() => handleGenerateImage(imageDraft)}>
                          <span className="material-symbols-outlined">bolt</span>
                          START WORKFLOW
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="image-card__asset-picker-empty">
                      <span className="material-symbols-outlined">account_tree</span>
                      <span>No imported workflows available. Open the Library page to import one.</span>
                    </div>
                  )}
                  <button className="kanban-sidebar__nav-item" onClick={() => openImageSourceMenu(imageDraft?.cardId || null)} style={{ justifyContent: 'center' }}>BACK</button>
                </div>
              )}

              {imageDraft.mode === 'api' && (
                <div className="image-card__options">
                  <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>REMOTE API</span>
                  <select
                    className="api-select"
                    value={imageDraft.selectedApi}
                    onChange={e => setImageDraft({ ...imageDraft, selectedApi: e.target.value })}
                  >
                    {imageGenerationApis.map(api => (
                      <option key={api.id} value={api.id}>{api.name}</option>
                    ))}
                  </select>

                  <div className="gen-section">
                    <textarea
                      className="gen-prompt-input"
                      placeholder="What should we generate?"
                      value={imageDraft.prompt}
                      onChange={e => setImageDraft({ ...imageDraft, prompt: e.target.value })}
                    />
                    <button className="gen-btn" onClick={() => handleGenerateImage(imageDraft)}>
                      <span className="material-symbols-outlined">auto_awesome</span>
                      GENERATE
                    </button>
                  </div>
                  <button className="kanban-sidebar__nav-item" onClick={() => openImageSourceMenu(imageDraft?.cardId || null)} style={{ justifyContent: 'center' }}>BACK</button>
                </div>
              )}
            </div>
          )}

          {pendingImageGeneration && column.dbId === IMAGE_CARD_COLUMNS[0].dbId && (
            <div className="image-card image-card--loading" id="image-card-loading">
              <div className="image-card__thumb image-card__thumb--loading">
                <div className="image-card__loading-state">
                  <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                  <span className="font-label image-card__loading-label">
                    {Number.isFinite(pendingImageGeneration.progressPercent) ? `${pendingImageGeneration.progressPercent}%` : 'Processing image...'}
                  </span>
                </div>
              </div>
              <div className="image-card__info">
                <div className="image-card__row">
                  <h3 className="image-card__name">{pendingImageGeneration.title}</h3>
                  <span className="image-card__source image-card__source--loading">PENDING</span>
                </div>
                <p className="image-card__meta font-label">{pendingImageGeneration.source} • {pendingImageGeneration.detail}</p>
                {pendingImageGeneration.currentNodeLabel && (
                  <p className="image-card__meta font-label image-card__meta--loading-node">{pendingImageGeneration.currentNodeLabel}</p>
                )}
                <div className="image-card__progress" aria-hidden="true">
                  <div
                    className="image-card__progress-bar"
                    style={{ width: `${Math.max(0, Math.min(100, pendingImageGeneration.progressPercent || 0))}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {column.dbId === IMAGE_CARD_COLUMNS[0].dbId && (
            <>
              <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileUpload}
                ref={fileInputRef}
              />

              {!imageDraft && !pendingImageGeneration && (
                <button className="kanban-col__add-btn" id="add-image-btn" onClick={() => openImageSourceMenu()}>
                  <span className="material-symbols-outlined">add_photo_alternate</span>
                  <span className="font-label">ADD NEW IMAGE</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="kanban-layout">
      <Header
        showSearch
        showCreateNew
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Workspace'}
        centerTitle
      />

      {statusMessage && (
        <div className={`kanban-status-message kanban-status-message--${statusMessage.tone}`} role="status" aria-live="polite">
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
            {statusMessage.tone === 'success' ? 'check_circle' : statusMessage.tone === 'error' ? 'error' : 'info'}
          </span>
          <span>{statusMessage.message}</span>
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {meshPreviewAsset && <MeshPreviewDialog asset={meshPreviewAsset} titleId="kanban-mesh-preview-dialog-title" onClose={() => setMeshPreviewAsset(null)} />}

      <div className="kanban-body">
        <main className="kanban-main" id="kanban-main">
          <div className="kanban-columns">
            {IMAGE_CARD_COLUMNS.map(renderImageColumn)}

            {/* ═══ Column 5: Texturing ═══ */}
            <div className="kanban-col" id="col-texturing">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--tertiary)' }}>texture</span>
                  <h2 className="kanban-col__title font-headline">TEXTURING</h2>
                </div>
                <span className="kanban-col__badge font-label">READY</span>
              </div>

              <div className="kanban-col__content">
                {/* Texture Params Card */}
                <div className="params-card params-card--tertiary" id="texturing-params">
                  <div className="params-card__header">
                    <span className="material-symbols-outlined" style={{ fontSize: '14px', color: 'var(--tertiary)' }}>palette</span>
                    <span className="params-card__title font-label">MAP GENERATION</span>
                  </div>

                  <div className="params-card__body">
                    <div className="params-card__field">
                      <label className="params-card__label font-label">Output Resolution</label>
                      <select
                        className="params-card__select"
                        value={texResolution}
                        onChange={(e) => setTexResolution(e.target.value)}
                        id="tex-resolution-select"
                      >
                        <option>1024 x 1024 (1K)</option>
                        <option>2048 x 2048 (2K)</option>
                        <option>4096 x 4096 (4K)</option>
                      </select>
                    </div>

                    <div className="params-card__field">
                      <label className="params-card__label font-label">Engine Configuration</label>
                      <div className="params-card__engine-grid">
                        <button
                          className={`params-card__engine-btn ${texEngine === 'stable' ? 'params-card__engine-btn--active-tertiary' : ''}`}
                          onClick={() => setTexEngine('stable')}
                          id="tex-engine-stable"
                        >STABLE API</button>
                        <button
                          className={`params-card__engine-btn ${texEngine === 'comfy' ? 'params-card__engine-btn--active-tertiary' : ''}`}
                          onClick={() => setTexEngine('comfy')}
                          id="tex-engine-comfy"
                        >COMFYUI</button>
                      </div>
                    </div>

                    <div className="params-card__checkboxes">
                      <label className="params-card__checkbox-label">
                        <div className={`params-card__checkbox ${pbrEnabled ? 'params-card__checkbox--checked' : ''}`} onClick={() => setPbrEnabled(!pbrEnabled)}>
                          {pbrEnabled && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>PBR Map Set (Diff, Norm, Rough)</span>
                      </label>
                      <label className={`params-card__checkbox-label ${!aoEnabled ? 'params-card__checkbox-label--dim' : ''}`}>
                        <div className={`params-card__checkbox ${aoEnabled ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => setAoEnabled(!aoEnabled)}>
                          {aoEnabled && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Bake Ambient Occlusion</span>
                      </label>
                    </div>
                  </div>

                  <button className="params-card__action params-card__action--tertiary" id="start-texturing-btn">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>brush</span>
                    START TEXTURING
                  </button>
                </div>

                {/* Recent Presets */}
                <div className="presets-card" id="recent-presets">
                  <span className="presets-card__title font-label">RECENT PRESETS</span>
                  <div className="presets-card__tags">
                    <div className="presets-card__tag">Cybermetal_01</div>
                    <div className="presets-card__tag">Procedural_Grip</div>
                    <div className="presets-card__tag">Organic_Skin_v2</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
