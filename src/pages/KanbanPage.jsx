import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext'
import Header from '../components/Header'
import Footer from '../components/Footer'
import Viewer from '../components/Viewer'
import SettingsModal from '../components/SettingsModal'
import './KanbanPage.css'

const SIDEBAR_ITEMS = [
  { id: 'images', icon: 'image', label: 'Images' },
  { id: 'imageedit', icon: 'photo_filter', label: 'Image Edit' },
  { id: 'meshgen', icon: 'deployed_code', label: 'Mesh Gen', filled: true },
  { id: 'meshedit', icon: 'edit_square', label: 'Mesh Edit' },
  { id: 'texturing', icon: 'texture', label: 'Texturing' },
]

const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai', name: 'OpenAI (DALL-E 3)' },
]

const IMAGE_CARD_COLUMNS = [
  { id: 'images', dbId: 1, icon: 'image', title: 'IMAGES' },
  { id: 'imageedit', dbId: 2, icon: 'photo_filter', title: 'IMAGE EDIT' },
]

const DEFAULT_ATTRIBUTE_TYPE_ID = 1

function getComfyDraftFromWorkflow(workflow) {
  return {
    mode: 'comfy',
    workflowId: workflow?.id || '',
    inputs: Object.fromEntries(
      (workflow?.parameters || []).map(parameter => {
        const valueType = parameter.valueType || (parameter.type === 'number' ? 'number' : 'string')
        return [parameter.id, ['image', 'video'].includes(valueType) ? null : (parameter.defaultValue ?? '')]
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
  return parameter.valueType || (parameter.type === 'number' ? 'number' : 'string')
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
    getProjectTasks,
    uploadAsset,
    attachExistingAsset,
    deleteAsset,
    moveKanbanCard,
    getLibraryAssets,
    createTask,
    getAttributeTypes,
    getProjectCardAttributes,
    createCardAttribute,
    updateCardAttribute,
    deleteCardAttribute,
    runImageEditApi,
    runImageEditComfy,
    generateImage,
    getComfyWorkflows,
    runComfyWorkflow,
    subscribeToComfyWorkflowProgress
  } = useProjects()
  const { settings } = useSettings()
  
  const [project, setProject] = useState(null)
  const [assets, setAssets] = useState([])
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)

  const [activeTab, setActiveTab] = useState('meshgen')
  const [genSeed, setGenSeed] = useState('8841295201')
  const [faceCount, setFaceCount] = useState('15000')
  const [meshBatch, setMeshBatch] = useState('1')
  const [processEngine, setProcessEngine] = useState('api')
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
  const fileInputRef = useRef(null)
  const fileUploadContextRef = useRef({ cardId: null, closeDraft: true })
  const pendingComfyProgressSubscriptionRef = useRef(null)
  const imageEditProgressSubscriptionsRef = useRef(new Map())

  // Fetch all data for this project
  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [projData, assetsData, tasksData, attributesData] = await Promise.all([
          getProject(projectId),
          getProjectAssets(projectId),
          getProjectTasks(projectId),
          getProjectCardAttributes(projectId)
        ])
        setProject(projData)
        setAssets(assetsData)
        setTasks(tasksData)
        setCardAttributes(attributesData)
      } catch (err) {
        console.error('Failed to load project data:', err)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [projectId, getProject, getProjectAssets, getProjectTasks, getProjectCardAttributes])

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
      alert(err.message || 'Upload failed')
    } finally {
      setLoading(false)
      e.target.value = ''
      fileUploadContextRef.current = { cardId: null, closeDraft: true }
    }
  }

  const refreshProjectAssets = async () => {
    const assetsData = await getProjectAssets(projectId)
    setAssets(assetsData)
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
      closePendingComfyProgressSubscription()
      closeImageEditProgressSubscription()
    }
  }, [])

  const selectedComfyWorkflow = comfyWorkflows.find(workflow => workflow.id == imageDraft?.workflowId) || null

  const openComfyWorkflowDraft = (cardId = imageDraft?.cardId || null) => {
    if (comfyWorkflows.length === 0) {
      alert('Import a ComfyUI workflow in Assets > Workflows first.')
      return
    }

    setImageDraft({
      ...getComfyDraftFromWorkflow(comfyWorkflows[0]),
      cardId
    })
  }

  const handleComfyWorkflowChange = (workflowId) => {
    const workflow = comfyWorkflows.find(item => item.id == workflowId)
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
      alert(err.message || 'Failed to load assets library')
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
      alert(err.message || 'Failed to attach image from assets')
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
      alert(err.message || 'Failed to remove image')
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
      alert(err.message || 'Failed to remove image card')
    }
  }

  const handleGenerateImage = async (draft) => {
    if (draft.mode === 'comfy') {
      if (!draft?.workflowId) return

      const workflow = comfyWorkflows.find(item => item.id == draft.workflowId)
      if (!workflow) {
        alert('Select a valid ComfyUI workflow.')
        return
      }

      for (const parameter of workflow.parameters || []) {
        const valueType = getWorkflowParameterValueType(parameter)
        const currentValue = draft.inputs?.[parameter.id]

        if (['image', 'video'].includes(valueType) && !currentValue) {
          alert(`Select a ${valueType} file for ${parameter.name}.`)
          return
        }

        if (valueType === 'string' && !String(currentValue ?? '').trim()) {
          alert(`Enter a value for ${parameter.name}.`)
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
        alert(err.message || 'ComfyUI workflow failed')
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
        source: combinedApis.find(api => api.id === draft.selectedApi)?.name || 'Remote API',
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
      alert(err.message || 'Image generation failed')
    } finally {
      setPendingImageGeneration(null)
      setLoading(false)
    }
  }

  const handleGenerateMesh = async () => {
    try {
      await createTask({
        projectId,
        name: `Mesh_Synth_${tasks.length + 1}`,
        metadata: { genSeed, faceCount, meshBatch, processEngine }
      });
      const tasksData = await getProjectTasks(projectId);
      setTasks(tasksData);
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  };

  const images = assets.filter(a => a.type === 'image')
  const imageCards = useMemo(() => {
    const cards = new Map()

    for (const asset of images) {
      const cardId = asset.metadata?.cardId || `asset-${asset.id}`

      if (!cards.has(cardId)) {
        cards.set(cardId, [])
      }

      cards.get(cardId).push(asset)
    }

    return Array.from(cards.entries())
      .map(([id, cardAssets]) => {
        const sortedAssets = [...cardAssets].sort((left, right) => {
          const leftPosition = left.assetPosition ?? Number.MAX_SAFE_INTEGER
          const rightPosition = right.assetPosition ?? Number.MAX_SAFE_INTEGER

          if (leftPosition !== rightPosition) {
            return leftPosition - rightPosition
          }

          return (right.createdAt || 0) - (left.createdAt || 0)
        })
        const primaryAsset = sortedAssets[0]
        const sources = [...new Set(sortedAssets.map(asset => asset.metadata?.source).filter(Boolean))]
        const formats = [...new Set(sortedAssets.map(asset => asset.metadata?.format).filter(Boolean))]

        return {
          id,
          assets: sortedAssets,
          primaryAsset,
          sourceLabel: sources.length === 1 ? sources[0] : 'MIXED',
          metaLabel: sortedAssets.length === 1
            ? `${primaryAsset.metadata?.resolution || 'N/A'} • ${primaryAsset.metadata?.format || 'N/A'}`
            : `${sortedAssets.length} images • ${formats.slice(0, 2).join(', ') || 'Mixed formats'}`,
          cardDbId: primaryAsset.cardDbId ?? null,
          cardKey: primaryAsset.cardKey || id,
          kanbanColumnId: primaryAsset.kanbanColumnId ?? 1,
          kanbanColumnName: primaryAsset.kanbanColumnName || 'Images',
          cardPosition: primaryAsset.cardPosition ?? Number.MAX_SAFE_INTEGER,
          createdAt: primaryAsset.createdAt || 0
        }
      })
      .sort((left, right) => {
        if (left.kanbanColumnId !== right.kanbanColumnId) {
          return left.kanbanColumnId - right.kanbanColumnId
        }

        if (left.cardPosition !== right.cardPosition) {
          return left.cardPosition - right.cardPosition
        }

        return right.createdAt - left.createdAt
      })
  }, [images])

  const imageCardsByColumn = useMemo(() => {
    return IMAGE_CARD_COLUMNS.reduce((accumulator, column) => {
      accumulator[column.dbId] = imageCards.filter(card => card.kanbanColumnId === column.dbId)
      return accumulator
    }, {})
  }, [imageCards])

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
      const hasImageInput = (workflow.parameters || []).some(parameter => getWorkflowParameterValueType(parameter) === 'image')
      const hasStringInput = (workflow.parameters || []).some(parameter => getWorkflowParameterValueType(parameter) === 'string')
      return hasImageInput && hasStringInput
    })
  }, [comfyWorkflows])

  const getPromptOptionsForCard = (cardId) => {
    const textAttributes = (cardAttributesByCardId[cardId] || []).filter(attribute => {
      const attributeType = attributeTypes.find(type => type.id === attribute.attributeTypeId)
      return attributeType?.name === 'Text'
    })

    return [
      ...textAttributes.map(attribute => ({
        id: `attribute:${attribute.position}`,
        label: attribute.attributeValue?.trim() ? attribute.attributeValue : `Text Attribute ${attribute.position + 1}`,
        value: attribute.attributeValue || ''
      })),
      { id: 'custom', label: 'Custom', value: '' }
    ]
  }

  const createImageEditDraft = (card, mode) => {
    const promptOptions = getPromptOptionsForCard(card.id)
    const firstPromptOption = promptOptions[0] || { id: 'custom', value: '' }
    const isCustomPrompt = firstPromptOption.id === 'custom'

    return {
      cardId: card.id,
      mode,
      selectedApi: IMAGE_API_LIST[0]?.id || 'nanobana',
      selectedAssetId: card.assets[0]?.id || '',
      workflowId: imageEditWorkflows[0]?.id || '',
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
        nextDraft.workflowId = imageEditWorkflows[0]?.id || ''
      }

      return nextDraft
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

    const prompt = resolveDraftPrompt(card, imageEditDraft)
    if (!imageEditDraft.selectedAssetId || !prompt) {
      alert('Select an image and provide a prompt.')
      return
    }

    try {
      setImageEditPendingCardId(card.id)

      if (imageEditDraft.mode === 'api') {
        await runImageEditApi(projectId, {
          assetId: Number(imageEditDraft.selectedAssetId),
          selectedApi: imageEditDraft.selectedApi,
          prompt
        })
      } else if (imageEditDraft.mode === 'comfy') {
        if (!imageEditDraft.workflowId) {
          alert('Select a ComfyUI workflow.')
          return
        }

        const promptId = createComfyExecutionId('comfy-edit-prompt')
        const clientId = createComfyExecutionId('comfy-edit-client')

        setImageEditProgressByCardId(prev => ({
          ...prev,
          [card.id]: {
            progressPercent: 0,
            detail: 'Preparing ComfyUI image edit',
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
                  progressPercent: Math.max(currentState.progressPercent || 0, Number(payload?.progressPercent) || 0),
                  detail: payload?.detail || currentState.detail,
                  currentNodeLabel: payload?.currentNodeLabel || currentState.currentNodeLabel
                }
              }
            })
          },
          onError: () => {}
        }))

        await runImageEditComfy(projectId, {
          assetId: Number(imageEditDraft.selectedAssetId),
          workflowId: Number(imageEditDraft.workflowId),
          prompt,
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

      closeImageEditActionMenu()
      alert('Image edit completed successfully.')
    } catch (err) {
      console.error('Failed to run image edit:', err)
      alert(err.message || 'Failed to run image edit')
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
      alert(err.message || 'Failed to move card')
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
      alert(err.message || 'Failed to add custom attribute')
    }
  }

  const handleAttributeTypeChange = async (cardId, position, attributeTypeId) => {
    try {
      await updateCardAttribute(projectId, cardId, position, { attributeTypeId })
      await refreshCardAttributes()
    } catch (err) {
      console.error('Failed to update attribute type:', err)
      alert(err.message || 'Failed to update attribute type')
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
      alert(err.message || 'Failed to update attribute value')
    }
  }

  const handleDeleteCustomAttribute = async (cardId, position) => {
    try {
      await deleteCardAttribute(projectId, cardId, position)
      await refreshCardAttributes()
    } catch (err) {
      console.error('Failed to delete attribute:', err)
      alert(err.message || 'Failed to delete attribute')
    }
  }

  if (loading && !project) {
    return (
      <div className="kanban-layout" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="font-headline">Synchronizing Workspace...</p>
      </div>
    )
  }

  // Combined API list: Static + Custom from settings
  const combinedApis = [
    ...IMAGE_API_LIST,
    ...(settings?.apis?.custom || []).map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]

  const draftColumnId = imageDraft?.cardId
    ? imageCards.find(card => card.id === imageDraft.cardId)?.kanbanColumnId || IMAGE_CARD_COLUMNS[0].dbId
    : IMAGE_CARD_COLUMNS[0].dbId

  const renderDropZone = (columnId, position, isEmpty = false) => {
    const isActive = dropTarget?.columnId === columnId && dropTarget?.position === position

    return (
      <div
        key={`drop-zone-${columnId}-${position}`}
        className={`kanban-drop-zone ${isActive ? 'kanban-drop-zone--active' : ''} ${isEmpty ? 'kanban-drop-zone--empty' : ''}`}
        onDragOver={event => handleCardDragOver(event, columnId, position)}
        onDrop={event => handleCardDrop(event, columnId, position)}
      >
        {isEmpty && !imageDraft && !pendingImageGeneration && (
          <span className="kanban-drop-zone__label font-label">
            {columnId === 2 ? 'Drag an image card here to edit it' : 'Drop image cards here'}
          </span>
        )}
      </div>
    )
  }

  const renderImageCard = (card, showAttributes = false) => {
    const totalPages = Math.max(1, Math.ceil(card.assets.length / 4))
    const currentPage = Math.min(imageCardPages[card.id] || 0, totalPages - 1)
    const visibleAssets = card.assets.slice(currentPage * 4, currentPage * 4 + 4)
    const attributes = cardAttributesByCardId[card.id] || []

    return (
      <div
        key={card.id}
        className={`image-card ${draggedCard?.id === card.id ? 'image-card--dragging' : ''}`}
        id={`image-card-${card.id}`}
        draggable
        onDragStart={(event) => handleCardDragStart(event, card)}
        onDragEnd={handleCardDragEnd}
      >
        <div className="image-card__actions">
          {!showAttributes && (
            <button
              className="image-card__action-btn"
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
            onClick={(e) => {
              e.stopPropagation()
              handleRemoveImageCard(card.assets)
            }}
            title="Remove card"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className={`image-card__thumb ${visibleAssets.length > 1 ? 'image-card__thumb--grid' : ''}`}>
          {visibleAssets.length > 0 ? (
            visibleAssets.map(asset => (
              <div key={asset.id} className="image-card__thumb-item">
                {asset.filename ? (
                  <img
                    src={`http://localhost:3001/assets/${encodeURI(asset.filename)}`}
                    alt={asset.name}
                    className="image-card__thumb-image"
                  />
                ) : (
                  <div className="image-card__thumb-placeholder">
                    <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
                  </div>
                )}

                {!showAttributes && (
                  <button
                    className="image-card__thumb-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemoveImage(asset.id)
                    }}
                    title="Remove image"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
                  </button>
                )}

                {showAttributes && (
                  <div className="image-card__thumb-caption font-label">
                    {asset.name}
                  </div>
                )}
              </div>
            ))
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
                disabled={currentPage === 0}
                title="Previous images"
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
                disabled={currentPage >= totalPages - 1}
                title="Next images"
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
            <h3 className="image-card__name">{card.primaryAsset?.name || 'Untitled image'}</h3>
            <div className="image-card__badges">
              {card.assets.length > 1 && (
                <span className="image-card__count font-label">{card.assets.length} IMAGES</span>
              )}
              <span
                className="image-card__source"
                style={{
                  color: ['AI GEN', 'COMFYUI'].includes(card.sourceLabel) ? 'var(--primary)' : 'var(--on-surface-variant)',
                  background: ['AI GEN', 'COMFYUI'].includes(card.sourceLabel) ? 'rgba(143,245,255,0.1)' : 'rgba(71,72,74,0.2)',
                }}
              >
                {card.sourceLabel}
              </span>
            </div>
          </div>
          <p className="image-card__meta font-label">{card.metaLabel}</p>

          {showAttributes && (
            <div className="image-card__attributes">
              <div className="image-card__edit-actions">
                <button className="image-card__edit-action-btn" onClick={() => openImageEditActionMenu(card)}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                  Action
                </button>

                {imageEditDraft?.cardId === card.id && !imageEditDraft?.mode && (
                  <div className="image-card__edit-action-menu">
                    <button className="image-card__edit-action-option" onClick={() => openImageEditActionMenu(card, 'api')}>
                      API
                    </button>
                    <button className="image-card__edit-action-option" onClick={() => openImageEditActionMenu(card, 'comfy')}>
                      ComfyUI
                    </button>
                  </div>
                )}

                {imageEditDraft?.cardId === card.id && imageEditDraft?.mode && (
                  <div className="image-card__edit-panel">
                    <div className="params-card__field">
                      <label className="params-card__label font-label">Image</label>
                      <select
                        className="image-card__attribute-select"
                        value={imageEditDraft.selectedAssetId}
                        onChange={event => handleImageEditDraftChange(card, 'selectedAssetId', event.target.value)}
                      >
                        {card.assets.map(asset => (
                          <option key={asset.id} value={asset.id}>{asset.name}</option>
                        ))}
                      </select>
                    </div>

                    {imageEditDraft.mode === 'api' ? (
                      <div className="params-card__field">
                        <label className="params-card__label font-label">API</label>
                        <select
                          className="image-card__attribute-select"
                          value={imageEditDraft.selectedApi}
                          onChange={event => handleImageEditDraftChange(card, 'selectedApi', event.target.value)}
                        >
                          {combinedApis.filter(api => api.id !== 'openai').map(api => (
                            <option key={api.id} value={api.id}>{api.name}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="params-card__field">
                        <label className="params-card__label font-label">ComfyUI Workflow</label>
                        <select
                          className="image-card__attribute-select"
                          value={imageEditDraft.workflowId}
                          onChange={event => handleImageEditDraftChange(card, 'workflowId', event.target.value)}
                        >
                          {imageEditWorkflows.map(workflow => (
                            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                          ))}
                        </select>
                      </div>
                    )}

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

                    <div className="image-card__edit-panel-actions">
                      <button
                        className="gen-btn"
                        onClick={() => handleRunImageEdit(card)}
                        disabled={imageEditPendingCardId === card.id}
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
                <button className="image-card__attribute-add" onClick={() => handleAddCustomAttribute(card.id)}>
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
                          placeholder={`Enter ${selectedType?.name?.toLowerCase() || 'attribute'} value`}
                        />

                        <button
                          className="image-card__attribute-delete"
                          onClick={() => handleDeleteCustomAttribute(card.id, attribute.position)}
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
              {renderImageCard(card, column.dbId === 2)}
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
                  <button className="option-btn" onClick={() => setImageDraft({ mode: 'api', selectedApi: 'nanobana', prompt: '', cardId: imageDraft?.cardId || null })}>
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
                  ) : comfyWorkflows.length > 0 ? (
                    <>
                      <select
                        className="params-card__select"
                        value={imageDraft.workflowId}
                        onChange={e => handleComfyWorkflowChange(e.target.value)}
                      >
                        {comfyWorkflows.map(workflow => (
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

                                {['image', 'video'].includes(getWorkflowParameterValueType(parameter)) ? (
                                  <label className="image-card__file-input">
                                    <input
                                      type="file"
                                      accept={getWorkflowParameterValueType(parameter) === 'video' ? 'video/*' : 'image/*'}
                                      onChange={e => handleComfyInputChange(parameter, e.target.files?.[0] || null)}
                                    />
                                    <span className="material-symbols-outlined">
                                      {getWorkflowParameterValueType(parameter) === 'video' ? 'video_file' : 'image'}
                                    </span>
                                    <span>
                                      {imageDraft.inputs?.[parameter.id]?.name || `Select ${getWorkflowParameterValueType(parameter)} file`}
                                    </span>
                                  </label>
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
                    {combinedApis.map(api => (
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
      <Header showSearch showCreateNew onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="kanban-body">
        {/* ── Sidebar ── */}
        <aside className="kanban-sidebar" id="kanban-sidebar">
          <div className="kanban-sidebar__workspace">
            <div className="kanban-sidebar__ws-icon">
              <span className="material-symbols-outlined" style={{ color: 'var(--secondary)' }}>token</span>
            </div>
            <div className="kanban-sidebar__ws-info">
              <span className="kanban-sidebar__ws-name">{project?.name || 'Workspace'}</span>
              <span className="kanban-sidebar__ws-version font-label">V0.4.2 Prototype</span>
            </div>
          </div>

          <nav className="kanban-sidebar__nav">
            {SIDEBAR_ITEMS.map(item => (
              <button
                key={item.id}
                className={`kanban-sidebar__nav-item ${activeTab === item.id ? 'kanban-sidebar__nav-item--active' : ''}`}
                onClick={() => setActiveTab(item.id)}
                id={`sidebar-${item.id}`}
              >
                <span className={`material-symbols-outlined ${item.filled && activeTab === item.id ? 'filled' : ''}`} style={{ fontSize: '18px' }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}

            <div className="kanban-sidebar__divider" />

            <button className="kanban-sidebar__new-asset" id="new-asset-btn" onClick={() => setShowSettings(true)}>
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>settings</span>
              <span className="font-label">PROJECT SETTINGS</span>
            </button>
          </nav>

          <div className="kanban-sidebar__bottom">
            <button className="kanban-sidebar__link" onClick={() => setShowSettings(true)} style={{ background: 'transparent', border: 'none', width: '100%', cursor: 'pointer', textAlign: 'left' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>account_circle</span>
              Profile
            </button>
            <a href="#" className="kanban-sidebar__link">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>help</span>
              Support
            </a>
          </div>
        </aside>

        {/* ── Main Kanban Area ── */}
        <main className="kanban-main" id="kanban-main">
          <div className="kanban-columns">
            {IMAGE_CARD_COLUMNS.map(renderImageColumn)}

            {/* ═══ Column 3: Mesh Generation ═══ */}
            <div className="kanban-col" id="col-meshgen">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--secondary)' }}>deployed_code</span>
                  <h2 className="kanban-col__title font-headline">MESH GEN</h2>
                </div>
                <span className="kanban-col__badge kanban-col__badge--secondary font-label">
                  {tasks.some(t => t.status === 'processing') ? 'PROCESSING' : 'READY'}
                </span>
              </div>

              <div className="kanban-col__content">
                {/* Parameters Card */}
                <div className="params-card params-card--secondary" id="meshgen-params">
                  <div className="params-card__header">
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>settings_input_component</span>
                    <span className="params-card__title font-label">PARAMETERS</span>
                  </div>

                  <div className="params-card__body">
                    <div className="params-card__field">
                      <label className="params-card__label font-label">Generation Seed</label>
                      <input
                        type="text"
                        className="params-card__input params-card__input--seed"
                        value={genSeed}
                        onChange={(e) => setGenSeed(e.target.value)}
                        id="gen-seed-input"
                      />
                    </div>

                    <div className="params-card__row">
                      <div className="params-card__field">
                        <label className="params-card__label font-label">Face Count</label>
                        <input
                          type="number"
                          className="params-card__input"
                          value={faceCount}
                          onChange={(e) => setFaceCount(e.target.value)}
                          id="face-count-input"
                        />
                      </div>
                      <div className="params-card__field">
                        <label className="params-card__label font-label">Mesh Batch</label>
                        <input
                          type="number"
                          className="params-card__input"
                          value={meshBatch}
                          onChange={(e) => setMeshBatch(e.target.value)}
                          id="mesh-batch-input"
                        />
                      </div>
                    </div>

                    <div className="params-card__engine">
                      <span className="params-card__engine-label">Processing Engine</span>
                      <div className="params-card__toggle-group">
                        <button
                          className={`params-card__toggle ${processEngine === 'api' ? 'params-card__toggle--active-secondary' : ''}`}
                          onClick={() => setProcessEngine('api')}
                          id="engine-api-btn"
                        >API</button>
                        <button
                          className={`params-card__toggle ${processEngine === 'comfy' ? 'params-card__toggle--active-secondary' : ''}`}
                          onClick={() => setProcessEngine('comfy')}
                          id="engine-comfy-btn"
                        >COMFY</button>
                      </div>
                    </div>
                  </div>

                  <button className="params-card__action params-card__action--secondary" id="generate-mesh-btn" onClick={handleGenerateMesh}>
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>bolt</span>
                    GENERATE MESH
                  </button>
                </div>

                {/* Active Tasks */}
                {tasks.map(task => (
                  <div key={task.id} className="task-card" id={`task-card-${task.id}`}>
                    <div className="task-card__progress-bar">
                      <div className="task-card__progress-fill" style={{ width: `${task.progress}%` }} />
                    </div>
                    <div className="task-card__header">
                      <span className="task-card__name">Task: {task.name}</span>
                      <span className="task-card__pct">{task.progress}%</span>
                    </div>
                    <p className="task-card__status">{task.status === 'processing' ? 'Processing...' : 'Complete'}</p>
                    <div className="task-card__preview">
                      <span className="material-symbols-outlined task-card__preview-icon">
                        {task.status === 'processing' ? 'hourglass_top' : 'check_circle'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ═══ Column 4: Mesh Edit ═══ */}
            <div className="kanban-col" id="col-meshedit">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>edit_square</span>
                  <h2 className="kanban-col__title font-headline">MESH EDIT</h2>
                </div>
                <span className="kanban-col__badge font-label">3 TOOLS</span>
              </div>

              <div className="kanban-col__content">
                {/* 3D Editor */}
                <div className="tool-card" id="tool-3d-editor">
                  <div className="tool-card__header">
                    <div className="tool-card__icon tool-card__icon--primary">
                      <span className="material-symbols-outlined">view_in_ar</span>
                    </div>
                    <div>
                      <h3 className="tool-card__name">3D Editor</h3>
                      <p className="tool-card__desc">Native vertex manipulator</p>
                    </div>
                  </div>
                  <div className="tool-card__viewport" style={{ height: '200px', padding: '0', overflow: 'hidden' }}>
                    <Viewer height="200px" />
                    <div className="tool-card__viewport-label">
                      LIVE VIEWPORT
                    </div>
                  </div>
                </div>

                {/* AI Simplify */}
                <div className="tool-card tool-card--hoverable-tertiary" id="tool-ai-simplify">
                  <div className="tool-card__header">
                    <div className="tool-card__inline-header">
                      <div className="tool-card__inline-left">
                        <span className="material-symbols-outlined" style={{ color: 'var(--tertiary)' }}>compress</span>
                        <h3 className="tool-card__name">AI Simplify</h3>
                      </div>
                      <span className="tool-card__api-badge tool-card__api-badge--tertiary">API</span>
                    </div>
                  </div>
                  <p className="tool-card__body-text">Intelligent decimation preserving silhouette topology. Best for game assets.</p>
                </div>

                {/* Remeshing */}
                <div className="tool-card tool-card--hoverable-primary" id="tool-remeshing">
                  <div className="tool-card__header">
                    <span className="material-symbols-outlined">rebase_edit</span>
                    <h3 className="tool-card__name">Remeshing</h3>
                  </div>
                  <p className="tool-card__body-text">Quadriflow or Instant Meshes conversion logic.</p>
                </div>
              </div>
            </div>

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
