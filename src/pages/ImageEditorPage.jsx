import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import AssetSelectorModal from '../components/AssetSelectorModal'
import { useProjects } from '../context/ProjectContext'
import { useNotifications } from '../context/NotificationContext'
import { buildAssetUrl, createExecutionId } from '../utils/meshTexturing'
import { applyShadowRemoverToCanvas, disposeShadowRemoverRenderer } from '../utils/shadowRemoverGPU'
import {
  applyAdjustmentsToCanvas,
  applyBlurSharpenToCanvas,
  canvasToPngFile,
  clamp,
  createComfyMaskCanvas,
  createLayerId,
  cropCanvas,
  getMaskBoundingBox,
  getValueType,
  loadImageToCanvas,
  normalizeWorkflowResult
} from '../utils/imageEditorCanvas'
import ImageEditorToolbar from '../components/imageEditor/ImageEditorToolbar'
import ToolSidebar from '../components/imageEditor/ToolSidebar'
import LayersPanel from '../components/imageEditor/LayersPanel'
import CropControls from '../components/imageEditor/controls/CropControls'
import ResizeControls from '../components/imageEditor/controls/ResizeControls'
import AdjustControls from '../components/imageEditor/controls/AdjustControls'
import FilterControls from '../components/imageEditor/controls/FilterControls'
import ShadowRemoverControls from '../components/imageEditor/controls/ShadowRemoverControls'
import PaintControls from '../components/imageEditor/controls/PaintControls'
import ComfyUIFullControls from '../components/imageEditor/controls/ComfyUIFullControls'
import ComfyUIMaskControls from '../components/imageEditor/controls/ComfyUIMaskControls'
import useImageEditorHistory from '../hooks/useImageEditorHistory'
import { saveWorkflowDefaults } from '../utils/workflowDefaults'
import './ImageEditorPage.css'

const DEFAULT_ADJUST_VALUES = { blackPoint: 0, whitePoint: 255, contrast: 0, saturation: 0 }
const DEFAULT_FILTER_VALUES = { blur: 0, sharpen: 0 }
const DEFAULT_SHADOW_REMOVER_VALUES = { strength: 40, threshold: 32, softness: 18, midtoneProtection: 72, warmth: 0 }
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_STEP = 1.15

export default function ImageEditorPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { getComfyWorkflows, updateComfyWorkflow, runComfyWorkflow, subscribeToComfyWorkflowProgress, saveImageEditorFile } = useProjects()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [loading, setLoading] = useState(true)

  const [layers, setLayers] = useState([])
  const [selectedLayerId, setSelectedLayerId] = useState(null)
  const layerCanvasesRef = useRef(new Map())
  const [renderRevision, setRenderRevision] = useState(0)
  const [cursorPreview, setCursorPreview] = useState(null)

  const [toolGroup, setToolGroup] = useState('edit')
  const [toolId, setToolId] = useState('crop')

  const [cropValues, setCropValues] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const [resizeValues, setResizeValues] = useState({ width: 0, height: 0 })
  const [adjustValues, setAdjustValues] = useState(DEFAULT_ADJUST_VALUES)
  const [filterValues, setFilterValues] = useState(DEFAULT_FILTER_VALUES)
  const [shadowRemoverValues, setShadowRemoverValues] = useState(DEFAULT_SHADOW_REMOVER_VALUES)
  const [adjustPreviewDirty, setAdjustPreviewDirty] = useState(false)
  const [filterPreviewDirty, setFilterPreviewDirty] = useState(false)
  const [shadowRemoverPreviewDirty, setShadowRemoverPreviewDirty] = useState(false)

  const [paintColor, setPaintColor] = useState('#ffffff')
  const [paintSize, setPaintSize] = useState(32)
  const [paintOpacity, setPaintOpacity] = useState(0.9)
  const [paintHardness, setPaintHardness] = useState(0.6)
  const [paintMode, setPaintMode] = useState('draw')
  const [paintBlendMode, setPaintBlendMode] = useState('source-over')
  const [paintBrushSource, setPaintBrushSource] = useState('color')
  const [paintBrushAsset, setPaintBrushAsset] = useState(null)
  const [paintBrushFile, setPaintBrushFile] = useState(null)
  const [showBrushSelector, setShowBrushSelector] = useState(false)
  const paintBrushFileInputRef = useRef(null)
  const brushImageRef = useRef(null)

  const [maskSize, setMaskSize] = useState(60)
  const [maskHardness, setMaskHardness] = useState(0.7)
  const [maskMode, setMaskMode] = useState('paint')
  const maskCanvasRef = useRef(null)
  const [maskRevision, setMaskRevision] = useState(0)

  const [workflows, setWorkflows] = useState([])
  const [workflowLoading, setWorkflowLoading] = useState(true)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('')
  const [workflowValues, setWorkflowValues] = useState({})
  const [setAsDefault, setSetAsDefault] = useState(false)
  const [imageParamSources, setImageParamSources] = useState({})
  const [showAssetSelector, setShowAssetSelector] = useState(false)
  const [pendingAssetParamId, setPendingAssetParamId] = useState(null)
  const [aiRunning, setAiRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })

  const displayCanvasRef = useRef(null)
  const canvasWrapperRef = useRef(null)
  const interactionRef = useRef({ active: false, last: null, pointerId: null, mode: null, layerId: null })
  const panInteractionRef = useRef({ active: false, pointerId: null, lastX: 0, lastY: 0 })
  const pointerPositionRef = useRef(null)

  const {
    canUndo,
    canRedo,
    pushUndoSnapshot,
    undo,
    redo,
    resetHistory
  } = useImageEditorHistory({
    layers,
    selectedLayerId,
    setLayers,
    setSelectedLayerId,
    layerCanvasesRef,
    maskCanvasRef,
    setMaskRevision,
    setRenderRevision
  })

  const assetId = searchParams.get('assetId') || ''
  const filePath = searchParams.get('filePath') || ''
  const imageUrl = searchParams.get('url') || ''
  const imageName = searchParams.get('name') || 'Image'
  const projectId = searchParams.get('projectId') || ''
  const returnTo = searchParams.get('returnTo') || '/assets'

  const numericAssetId = Number(assetId)

  const imageSourceUrl = useMemo(() => {
    if (imageUrl) return buildAssetUrl({ url: imageUrl })
    if (filePath) return buildAssetUrl({ filePath })
    return ''
  }, [imageUrl, filePath])

  const selectedWorkflow = useMemo(
    () => workflows.find(item => String(item.id) === String(selectedWorkflowId)) || null,
    [selectedWorkflowId, workflows]
  )

  const activeLayer = useMemo(
    () => layers.find(layer => layer.id === selectedLayerId) || null,
    [layers, selectedLayerId]
  )

  const getPreviewTargetLayerId = useCallback(() => {
    const preferred = activeLayer && !activeLayer.locked
      ? activeLayer.id
      : (layers.find(layer => !layer.locked)?.id || layers[0]?.id || null)
    return preferred
  }, [activeLayer, layers])

  const handleImageParamSourceChange = useCallback((paramId, type, value = null) => {
    setImageParamSources(prev => {
      const next = { ...prev }

      if (type === 'source') {
        Object.entries(next).forEach(([id, config]) => {
          if (id !== paramId && config?.type === 'source') {
            next[id] = { type: 'none' }
          }
        })
      }

      if (type === 'mask') {
        Object.entries(next).forEach(([id, config]) => {
          if (id !== paramId && config?.type === 'mask') {
            next[id] = { type: 'none' }
          }
        })
      }

      if (type === 'asset') {
        next[paramId] = {
          type: 'asset',
          asset: value
        }
      } else if (type === 'file') {
        next[paramId] = {
          type: 'file',
          file: value,
          fileName: value?.name
        }
      } else {
        next[paramId] = { type }
      }

      return next
    })
  }, [])

  const loadAssetAsFile = useCallback(async (asset) => {
    const url = buildAssetUrl(asset)
    if (!url) throw new Error('Asset URL not found')

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load asset ${asset?.name || ''}`.trim())

    const blob = await response.blob()
    const fileName = asset?.name || asset?.filename || 'image.png'
    return new File([blob], fileName, { type: blob.type || 'image/png' })
  }, [])

  const paintTargetLayerId = useMemo(() => {
    if (activeLayer && !activeLayer.locked) {
      return activeLayer.id
    }
    const firstEditable = [...layers].reverse().find(layer => !layer.locked)
    return firstEditable?.id || null
  }, [activeLayer, layers])

  const maskHasPixels = useMemo(() => {
    void maskRevision
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return false
    const imageData = maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data
    for (let index = 3; index < imageData.length; index += 4) {
      if (imageData[index] > 0) return true
    }
    return false
  }, [maskRevision])

  const refreshCanvas = useCallback(() => {
    const displayCanvas = displayCanvasRef.current
    if (!displayCanvas || layers.length === 0) return

    const baseCanvas = layerCanvasesRef.current.get(layers[0].id)
    if (!baseCanvas) return

    displayCanvas.width = baseCanvas.width
    displayCanvas.height = baseCanvas.height

    const context = displayCanvas.getContext('2d')
    context.clearRect(0, 0, displayCanvas.width, displayCanvas.height)

    const previewLayerId = getPreviewTargetLayerId()

    layers.forEach(layer => {
      if (!layer.visible) return
      const originalLayerCanvas = layerCanvasesRef.current.get(layer.id)
      if (!originalLayerCanvas) return

      let layerCanvas = originalLayerCanvas

      if (layer.id === previewLayerId && toolGroup === 'edit' && toolId === 'adjust' && adjustPreviewDirty) {
        const previewCanvas = applyAdjustmentsToCanvas(originalLayerCanvas, adjustValues)
        if (previewCanvas) {
          layerCanvas = previewCanvas
        }
      }

      if (layer.id === previewLayerId && toolGroup === 'edit' && toolId === 'filters' && filterPreviewDirty) {
        const previewCanvas = applyBlurSharpenToCanvas(originalLayerCanvas, filterValues)
        if (previewCanvas) {
          layerCanvas = previewCanvas
        }
      }

      if (layer.id === previewLayerId && toolGroup === 'edit' && toolId === 'shadow-remover' && shadowRemoverPreviewDirty) {
        const previewResult = applyShadowRemoverToCanvas(originalLayerCanvas, shadowRemoverValues)
        if (previewResult?.canvas) {
          layerCanvas = previewResult.canvas
        }
      }

      if (!layerCanvas) return
      context.save()
      context.globalAlpha = clamp(layer.opacity, 0, 1)
      context.globalCompositeOperation = layer.blendMode || 'source-over'
      context.drawImage(layerCanvas, 0, 0)
      context.restore()
    })

    if (toolGroup === 'ai' && toolId === 'mask') {
      const maskCanvas = maskCanvasRef.current
      if (maskCanvas) {
        const overlayCanvas = document.createElement('canvas')
        overlayCanvas.width = displayCanvas.width
        overlayCanvas.height = displayCanvas.height
        const overlayContext = overlayCanvas.getContext('2d')
        overlayContext.fillStyle = '#8ff5ff'
        overlayContext.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height)
        overlayContext.globalCompositeOperation = 'destination-in'
        overlayContext.drawImage(maskCanvas, 0, 0)

        context.save()
        context.globalCompositeOperation = 'screen'
        context.globalAlpha = 0.42
        context.drawImage(overlayCanvas, 0, 0)
        context.restore()
      }
    }

    if (toolGroup === 'edit' && toolId === 'crop') {
      const x = Math.round(clamp(cropValues.x, 0, Math.max(0, displayCanvas.width - 1)))
      const y = Math.round(clamp(cropValues.y, 0, Math.max(0, displayCanvas.height - 1)))
      const maxWidth = Math.max(1, displayCanvas.width - x)
      const maxHeight = Math.max(1, displayCanvas.height - y)
      const width = Math.round(clamp(cropValues.width, 1, maxWidth))
      const height = Math.round(clamp(cropValues.height, 1, maxHeight))

      context.save()
      const overlayCanvas = document.createElement('canvas')
      overlayCanvas.width = displayCanvas.width
      overlayCanvas.height = displayCanvas.height
      const overlayContext = overlayCanvas.getContext('2d')
      overlayContext.fillStyle = 'rgba(0, 0, 0, 0.35)'
      overlayContext.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height)
      overlayContext.globalCompositeOperation = 'destination-out'
      overlayContext.fillRect(x, y, width, height)
      overlayContext.globalCompositeOperation = 'source-over'
      context.drawImage(overlayCanvas, 0, 0)

      context.strokeStyle = '#8ff5ff'
      context.lineWidth = 2
      context.setLineDash([10, 6])
      context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1))

      context.fillStyle = 'rgba(10, 16, 26, 0.78)'
      context.fillRect(x, Math.max(0, y - 24), 168, 22)
      context.fillStyle = '#e9f7ff'
      context.font = '12px "Inter", sans-serif'
      context.textBaseline = 'middle'
      context.fillText(`X:${x}  Y:${y}  W:${width}  H:${height}`, x + 8, Math.max(0, y - 13))
      context.restore()
    }
  }, [adjustPreviewDirty, adjustValues, cropValues.height, cropValues.width, cropValues.x, cropValues.y, filterPreviewDirty, filterValues, getPreviewTargetLayerId, layers, shadowRemoverPreviewDirty, shadowRemoverValues, toolGroup, toolId])

  const bumpRender = useCallback(() => {
    setRenderRevision(prev => prev + 1)
  }, [])

  const bumpMask = useCallback(() => {
    setMaskRevision(prev => prev + 1)
  }, [])

  const resetView = useCallback(() => {
    setZoom(1)
    setPanOffset({ x: 0, y: 0 })
    setCursorPreview(null)
  }, [])

  const zoomIn = useCallback(() => {
    setZoom(prev => clamp(prev * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))
    setCursorPreview(null)
  }, [])

  const zoomOut = useCallback(() => {
    setZoom(prev => clamp(prev / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))
    setCursorPreview(null)
  }, [])

  const handleCanvasWheel = useCallback((event) => {
    event.preventDefault()
    pointerPositionRef.current = { x: event.clientX, y: event.clientY }
    const factor = event.deltaY < 0 ? ZOOM_STEP : (1 / ZOOM_STEP)
    setZoom(prev => clamp(prev * factor, MIN_ZOOM, MAX_ZOOM))
  }, [])

  const handleShellPointerDown = useCallback((event) => {
    if (event.button !== 1) return

    event.preventDefault()
    setCursorPreview(null)

    panInteractionRef.current = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY
    }

    canvasWrapperRef.current?.setPointerCapture?.(event.pointerId)
  }, [])

  const finishPanInteraction = useCallback((pointerId) => {
    const interaction = panInteractionRef.current
    if (!interaction.active || interaction.pointerId !== pointerId) return

    panInteractionRef.current = { active: false, pointerId: null, lastX: 0, lastY: 0 }
  }, [])

  const handleShellPointerUp = useCallback((event) => {
    finishPanInteraction(event.pointerId)
  }, [finishPanInteraction])

  const handleShellPointerCancel = useCallback((event) => {
    finishPanInteraction(event.pointerId)
  }, [finishPanInteraction])

  const createEmptyCanvas = useCallback((width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }, [])

  const ensureEditableLayer = useCallback(() => {
    if (paintTargetLayerId) {
      return paintTargetLayerId
    }

    const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
    if (!baseCanvas) return null

    const newId = createLayerId()
    const newLayer = {
      id: newId,
      name: `Layer ${layers.filter(layer => !layer.locked).length + 1}`,
      opacity: 1,
      blendMode: 'source-over',
      visible: true,
      locked: false
    }

    const newCanvas = createEmptyCanvas(baseCanvas.width, baseCanvas.height)
    layerCanvasesRef.current.set(newId, newCanvas)

    setLayers(prev => [...prev, newLayer])
    setSelectedLayerId(newId)
    return newId
  }, [createEmptyCanvas, layers, paintTargetLayerId])

  const exportCurrentComposite = useCallback(async () => {
    if (layers.length === 0) return null

    const baseCanvas = layerCanvasesRef.current.get(layers[0].id)
    if (!baseCanvas) return null

    const exportCanvas = createEmptyCanvas(baseCanvas.width, baseCanvas.height)
    const context = exportCanvas.getContext('2d')

    layers.forEach(layer => {
      if (!layer.visible) return
      const layerCanvas = layerCanvasesRef.current.get(layer.id)
      if (!layerCanvas) return
      context.save()
      context.globalAlpha = clamp(layer.opacity, 0, 1)
      context.globalCompositeOperation = layer.blendMode || 'source-over'
      context.drawImage(layerCanvas, 0, 0)
      context.restore()
    })

    return exportCanvas
  }, [createEmptyCanvas, layers])

  const getPointInCanvas = useCallback((event) => {
    const canvas = displayCanvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height

    return {
      x: clamp(x, 0, canvas.width),
      y: clamp(y, 0, canvas.height)
    }
  }, [])

  const stampSoftCircle = useCallback((context, point, size, hardness, color, alpha) => {
    const radius = size / 2
    const innerRadius = radius * clamp(hardness, 0, 1)
    const gradient = context.createRadialGradient(point.x, point.y, innerRadius, point.x, point.y, radius)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
    context.save()
    context.globalAlpha = clamp(alpha, 0, 1)
    context.fillStyle = gradient
    context.beginPath()
    context.arc(point.x, point.y, radius, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }, [])

  const stampPaint = useCallback((layerCanvas, point) => {
    if (!layerCanvas) return
    const context = layerCanvas.getContext('2d')

    context.save()
    context.globalCompositeOperation = paintMode === 'erase' ? 'destination-out' : paintBlendMode

    if (paintBrushSource === 'color' || !brushImageRef.current) {
      stampSoftCircle(context, point, paintSize, paintHardness, paintColor, paintOpacity)
    } else {
      const brushImage = brushImageRef.current
      const aspect = brushImage.width > 0 && brushImage.height > 0 ? brushImage.width / brushImage.height : 1
      let width = paintSize
      let height = paintSize
      if (aspect >= 1) {
        width = paintSize
        height = Math.max(1, Math.round(paintSize / aspect))
      } else {
        height = paintSize
        width = Math.max(1, Math.round(paintSize * aspect))
      }

      const stampCanvas = document.createElement('canvas')
      stampCanvas.width = width
      stampCanvas.height = height
      const stampContext = stampCanvas.getContext('2d')
      stampContext.drawImage(brushImage, 0, 0, width, height)

      if (paintMode !== 'erase') {
        stampContext.globalCompositeOperation = 'source-in'
        stampContext.fillStyle = paintColor
        stampContext.fillRect(0, 0, width, height)
        stampContext.globalCompositeOperation = 'source-over'
      }

      context.globalAlpha = clamp(paintOpacity, 0, 1)
      context.drawImage(stampCanvas, point.x - width / 2, point.y - height / 2, width, height)
    }

    context.restore()
  }, [paintBlendMode, paintBrushSource, paintColor, paintHardness, paintMode, paintOpacity, paintSize, stampSoftCircle])

  const stampMask = useCallback((point) => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return

    const context = maskCanvas.getContext('2d')
    context.save()
    context.globalCompositeOperation = maskMode === 'erase' ? 'destination-out' : 'source-over'
    stampSoftCircle(context, point, maskSize, maskHardness, '#ffffff', 1)
    context.restore()
  }, [maskHardness, maskMode, maskSize, stampSoftCircle])

  const drawInterpolated = useCallback((from, to, drawPoint, spacing) => {
    const deltaX = to.x - from.x
    const deltaY = to.y - from.y
    const distance = Math.hypot(deltaX, deltaY)
    const step = Math.max(1, spacing)
    const steps = Math.max(1, Math.floor(distance / step))

    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      drawPoint({
        x: from.x + deltaX * t,
        y: from.y + deltaY * t
      })
    }
  }, [])

  const updateCursorPreviewAtPosition = useCallback((clientX, clientY) => {
    if (!(toolGroup === 'paint' || (toolGroup === 'ai' && toolId === 'mask'))) {
      setCursorPreview(null)
      return
    }

    const canvas = displayCanvasRef.current
    const shell = canvasWrapperRef.current
    const rect = canvas?.getBoundingClientRect()
    const shellRect = shell?.getBoundingClientRect()

    if (!rect || !shellRect) {
      setCursorPreview(null)
      return
    }

    const scrollLeft = shell.scrollLeft || 0
    const scrollTop = shell.scrollTop || 0

    const insideCanvas = clientX >= rect.left
      && clientX <= rect.right
      && clientY >= rect.top
      && clientY <= rect.bottom

    if (!insideCanvas) {
      setCursorPreview(null)
      return
    }

    const diameter = toolGroup === 'paint' ? paintSize : maskSize
    const scale = rect.width > 0 && canvas?.width > 0 ? rect.width / canvas.width : 1
    let previewWidth = Math.max(1, diameter * scale)
    let previewHeight = previewWidth
    let previewBorderRadius = '999px'

    if (toolGroup === 'paint' && paintBrushSource !== 'color' && brushImageRef.current) {
      const brushWidth = brushImageRef.current.width || 1
      const brushHeight = brushImageRef.current.height || 1
      const aspect = brushWidth / brushHeight
      if (aspect >= 1) {
        previewWidth = Math.max(1, diameter * scale)
        previewHeight = Math.max(1, (diameter * scale) / aspect)
      } else {
        previewHeight = Math.max(1, diameter * scale)
        previewWidth = Math.max(1, (diameter * scale) * aspect)
      }
      previewBorderRadius = '8px'
    }

    setCursorPreview({
      x: clientX - shellRect.left + scrollLeft,
      y: clientY - shellRect.top + scrollTop,
      width: previewWidth,
      height: previewHeight,
      borderRadius: previewBorderRadius,
      mode: toolGroup,
      color: toolGroup === 'paint' ? (paintMode === 'erase' ? '#ff716c' : '#8ff5ff') : '#8ff5ff'
    })
  }, [maskSize, paintBrushSource, paintMode, paintSize, toolGroup, toolId])

  const updateCursorPreviewFromEvent = useCallback((event) => {
    pointerPositionRef.current = { x: event.clientX, y: event.clientY }
    updateCursorPreviewAtPosition(event.clientX, event.clientY)
  }, [updateCursorPreviewAtPosition])

  const handleCanvasPointerDown = useCallback((event) => {
    if (!displayCanvasRef.current) return
    if (!(toolGroup === 'paint' || (toolGroup === 'ai' && toolId === 'mask'))) return
    if (event.button !== 0) return

    const point = getPointInCanvas(event)
    if (!point) return

    let layerId = null

    if (toolGroup === 'paint') {
      pushUndoSnapshot()
      layerId = ensureEditableLayer()
      if (!layerId) {
        setFeedback('Select or create a paint layer first.')
        return
      }

      const targetCanvas = layerCanvasesRef.current.get(layerId)
      stampPaint(targetCanvas, point)
      bumpRender()
    } else {
      pushUndoSnapshot()
      stampMask(point)
      bumpMask()
    }

    interactionRef.current = {
      active: true,
      last: point,
      pointerId: event.pointerId,
      mode: toolGroup,
      layerId
    }

    displayCanvasRef.current.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }, [bumpMask, bumpRender, ensureEditableLayer, getPointInCanvas, pushUndoSnapshot, setFeedback, stampMask, stampPaint, toolGroup, toolId])

  const handleCanvasPointerMove = useCallback((event) => {
    if (panInteractionRef.current.active) {
      setCursorPreview(null)
      return
    }

    updateCursorPreviewFromEvent(event)

    const interaction = interactionRef.current
    if (!interaction.active) return

    const point = getPointInCanvas(event)
    if (!point) return

    if (interaction.mode === 'paint') {
      const targetCanvas = layerCanvasesRef.current.get(interaction.layerId)
      if (targetCanvas) {
        drawInterpolated(interaction.last, point, nextPoint => stampPaint(targetCanvas, nextPoint), paintSize * 0.22)
        bumpRender()
      }
    } else {
      drawInterpolated(interaction.last, point, nextPoint => stampMask(nextPoint), maskSize * 0.22)
      bumpMask()
    }

    interactionRef.current.last = point
    event.preventDefault()
  }, [bumpMask, bumpRender, drawInterpolated, getPointInCanvas, maskSize, paintSize, stampMask, stampPaint, updateCursorPreviewFromEvent])

  const handleShellPointerMove = useCallback((event) => {
    const interaction = panInteractionRef.current
    if (interaction.active && interaction.pointerId === event.pointerId) {
      event.preventDefault()

      const deltaX = event.clientX - interaction.lastX
      const deltaY = event.clientY - interaction.lastY

      interaction.lastX = event.clientX
      interaction.lastY = event.clientY

      setPanOffset(prev => ({ x: prev.x + deltaX, y: prev.y + deltaY }))
      setCursorPreview(null)
      return
    }

    updateCursorPreviewFromEvent(event)
  }, [updateCursorPreviewFromEvent])

  const finishPointerInteraction = useCallback((pointerId) => {
    if (!interactionRef.current.active) return
    if (interactionRef.current.pointerId !== pointerId) return

    interactionRef.current = { active: false, last: null, pointerId: null, mode: null, layerId: null }
  }, [])

  const handleCanvasPointerUp = useCallback((event) => {
    finishPointerInteraction(event.pointerId)
  }, [finishPointerInteraction])

  const handleCanvasPointerCancel = useCallback((event) => {
    finishPointerInteraction(event.pointerId)
  }, [finishPointerInteraction])

  const handleCanvasPointerLeave = useCallback(() => {
    setCursorPreview(null)
  }, [])

  const handleAddLayer = useCallback(() => {
    const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
    if (!baseCanvas) return

    pushUndoSnapshot()
    const id = createLayerId()
    const layer = {
      id,
      name: `Layer ${layers.filter(item => !item.locked).length + 1}`,
      opacity: 1,
      blendMode: 'source-over',
      visible: true,
      locked: false
    }

    const canvas = createEmptyCanvas(baseCanvas.width, baseCanvas.height)
    layerCanvasesRef.current.set(id, canvas)
    setLayers(prev => [...prev, layer])
    setSelectedLayerId(id)
    setFeedback('New paint layer added.')
  }, [createEmptyCanvas, layers, pushUndoSnapshot])

  const handleDeleteLayer = useCallback((id) => {
    const layer = layers.find(item => item.id === id)
    if (!layer || layer.id === 'base-layer') {
      setFeedback('Base layer cannot be deleted.')
      return
    }

    pushUndoSnapshot()
    layerCanvasesRef.current.delete(id)
    setLayers(prev => prev.filter(item => item.id !== id))
    setSelectedLayerId(prev => (prev === id ? null : prev))
  }, [layers, pushUndoSnapshot])

  const handleMoveLayer = useCallback((id, direction) => {
    pushUndoSnapshot()
    setLayers(prev => {
      const index = prev.findIndex(layer => layer.id === id)
      if (index === -1) return prev
      const target = direction === 'up' ? index + 1 : index - 1
      if (target < 0 || target >= prev.length) return prev

      const next = [...prev]
      const [moving] = next.splice(index, 1)
      next.splice(target, 0, moving)
      return next
    })
  }, [pushUndoSnapshot])

  const handleUpdateLayer = useCallback((id, updates) => {
    pushUndoSnapshot()
    setLayers(prev => prev.map(layer => (layer.id === id ? { ...layer, ...updates } : layer)))
  }, [pushUndoSnapshot])

  const applyToLayerCanvas = useCallback((fn) => {
    const targetLayer = activeLayer && !activeLayer.locked ? activeLayer : layers.find(layer => !layer.locked) || layers[0]
    const targetCanvas = layerCanvasesRef.current.get(targetLayer?.id)
    if (!targetLayer || !targetCanvas) {
      setFeedback('No editable layer available.')
      return
    }

    fn(targetCanvas)
    bumpRender()
  }, [activeLayer, bumpRender, layers])

  const handleApplyCrop = useCallback(() => {
    pushUndoSnapshot()
    const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
    if (!baseCanvas) return

    const x = Math.round(clamp(cropValues.x, 0, baseCanvas.width - 1))
    const y = Math.round(clamp(cropValues.y, 0, baseCanvas.height - 1))
    const width = Math.round(clamp(cropValues.width, 1, baseCanvas.width - x))
    const height = Math.round(clamp(cropValues.height, 1, baseCanvas.height - y))

    layers.forEach(layer => {
      const source = layerCanvasesRef.current.get(layer.id)
      if (!source) return
      const next = createEmptyCanvas(width, height)
      next.getContext('2d').drawImage(source, x, y, width, height, 0, 0, width, height)
      layerCanvasesRef.current.set(layer.id, next)
    })

    const oldMask = maskCanvasRef.current
    if (oldMask) {
      const nextMask = createEmptyCanvas(width, height)
      nextMask.getContext('2d').drawImage(oldMask, x, y, width, height, 0, 0, width, height)
      maskCanvasRef.current = nextMask
      bumpMask()
    }

    setCropValues({ x: 0, y: 0, width, height })
    setResizeValues({ width, height })
    setFeedback(`Image cropped to ${width} x ${height}.`)
    bumpRender()
  }, [bumpMask, bumpRender, createEmptyCanvas, cropValues, layers, pushUndoSnapshot])

  const cropLimits = useMemo(() => {
    const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
    const canvasWidth = Math.max(1, baseCanvas?.width || 1)
    const canvasHeight = Math.max(1, baseCanvas?.height || 1)

    const xMax = Math.max(0, canvasWidth - 1)
    const yMax = Math.max(0, canvasHeight - 1)
    const x = Math.round(clamp(cropValues.x, 0, xMax))
    const y = Math.round(clamp(cropValues.y, 0, yMax))

    return {
      xMin: 0,
      xMax,
      yMin: 0,
      yMax,
      widthMin: 1,
      widthMax: Math.max(1, canvasWidth - x),
      heightMin: 1,
      heightMax: Math.max(1, canvasHeight - y)
    }
  }, [cropValues.x, cropValues.y, layers])

  const handleCropXChange = useCallback((value) => {
    const numeric = Number(value)
    setCropValues(prev => {
      const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
      const canvasWidth = Math.max(1, baseCanvas?.width || 1)
      const x = Math.round(clamp(Number.isFinite(numeric) ? numeric : 0, 0, canvasWidth - 1))
      const maxWidth = Math.max(1, canvasWidth - x)
      return {
        ...prev,
        x,
        width: Math.round(clamp(prev.width, 1, maxWidth))
      }
    })
  }, [layers])

  const handleCropYChange = useCallback((value) => {
    const numeric = Number(value)
    setCropValues(prev => {
      const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
      const canvasHeight = Math.max(1, baseCanvas?.height || 1)
      const y = Math.round(clamp(Number.isFinite(numeric) ? numeric : 0, 0, canvasHeight - 1))
      const maxHeight = Math.max(1, canvasHeight - y)
      return {
        ...prev,
        y,
        height: Math.round(clamp(prev.height, 1, maxHeight))
      }
    })
  }, [layers])

  const handleCropWidthChange = useCallback((value) => {
    const numeric = Number(value)
    setCropValues(prev => {
      const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
      const canvasWidth = Math.max(1, baseCanvas?.width || 1)
      const maxWidth = Math.max(1, canvasWidth - Math.round(clamp(prev.x, 0, canvasWidth - 1)))
      return {
        ...prev,
        width: Math.round(clamp(Number.isFinite(numeric) ? numeric : 1, 1, maxWidth))
      }
    })
  }, [layers])

  const handleCropHeightChange = useCallback((value) => {
    const numeric = Number(value)
    setCropValues(prev => {
      const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
      const canvasHeight = Math.max(1, baseCanvas?.height || 1)
      const maxHeight = Math.max(1, canvasHeight - Math.round(clamp(prev.y, 0, canvasHeight - 1)))
      return {
        ...prev,
        height: Math.round(clamp(Number.isFinite(numeric) ? numeric : 1, 1, maxHeight))
      }
    })
  }, [layers])

  const handleApplyResize = useCallback(() => {
    pushUndoSnapshot()
    const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
    if (!baseCanvas) return

    const width = Math.round(clamp(resizeValues.width, 1, 8192))
    const height = Math.round(clamp(resizeValues.height, 1, 8192))

    layers.forEach(layer => {
      const source = layerCanvasesRef.current.get(layer.id)
      if (!source) return
      const next = createEmptyCanvas(width, height)
      const context = next.getContext('2d')
      context.imageSmoothingEnabled = true
      context.drawImage(source, 0, 0, width, height)
      layerCanvasesRef.current.set(layer.id, next)
    })

    const oldMask = maskCanvasRef.current
    if (oldMask) {
      const nextMask = createEmptyCanvas(width, height)
      const context = nextMask.getContext('2d')
      context.imageSmoothingEnabled = true
      context.drawImage(oldMask, 0, 0, width, height)
      maskCanvasRef.current = nextMask
      bumpMask()
    }

    setCropValues(prev => ({ ...prev, width, height }))
    setFeedback(`Image resized to ${width} x ${height}.`)
    bumpRender()
  }, [bumpMask, bumpRender, createEmptyCanvas, layers, pushUndoSnapshot, resizeValues.height, resizeValues.width])

  const handleApplyAdjustments = useCallback(() => {
    pushUndoSnapshot()
    applyToLayerCanvas(layerCanvas => {
      const result = applyAdjustmentsToCanvas(layerCanvas, adjustValues)
      if (!result) return
      const context = layerCanvas.getContext('2d')
      context.clearRect(0, 0, layerCanvas.width, layerCanvas.height)
      context.drawImage(result, 0, 0)
    })

    setAdjustPreviewDirty(false)
    setFeedback('Levels and color adjustments applied.')
  }, [adjustValues, applyToLayerCanvas, pushUndoSnapshot])

  const handleResetAdjustments = useCallback(() => {
    setAdjustValues(DEFAULT_ADJUST_VALUES)
    setAdjustPreviewDirty(false)
    setFeedback('Adjustment sliders reset.')
  }, [])

  const handleApplyBlurSharpen = useCallback(() => {
    pushUndoSnapshot()
    applyToLayerCanvas(layerCanvas => {
      const result = applyBlurSharpenToCanvas(layerCanvas, filterValues)
      if (!result) return
      const context = layerCanvas.getContext('2d')
      context.clearRect(0, 0, layerCanvas.width, layerCanvas.height)
      context.drawImage(result, 0, 0)
    })

    setFilterPreviewDirty(false)
    setFeedback('Blur / sharpen filter applied.')
  }, [applyToLayerCanvas, filterValues, pushUndoSnapshot])

  const handleResetFilters = useCallback(() => {
    setFilterValues(DEFAULT_FILTER_VALUES)
    setFilterPreviewDirty(false)
    setFeedback('Filter sliders reset.')
  }, [])

  const handleApplyShadowRemover = useCallback(() => {
    let fallbackMessage = ''

    pushUndoSnapshot()
    applyToLayerCanvas(layerCanvas => {
      const result = applyShadowRemoverToCanvas(layerCanvas, shadowRemoverValues)
      if (!result?.canvas) return
      const context = layerCanvas.getContext('2d')
      context.clearRect(0, 0, layerCanvas.width, layerCanvas.height)
      context.drawImage(result.canvas, 0, 0)
      fallbackMessage = result.mode === 'cpu' ? result.fallbackReason || 'GPU rendering was unavailable.' : ''
    })

    setShadowRemoverPreviewDirty(false)
    setFeedback(
      fallbackMessage
        ? `Shadow remover applied using CPU fallback. ${fallbackMessage}`
        : 'Shadow remover applied.'
    )
  }, [applyToLayerCanvas, pushUndoSnapshot, shadowRemoverValues])

  const handleResetShadowRemover = useCallback(() => {
    setShadowRemoverValues(DEFAULT_SHADOW_REMOVER_VALUES)
    setShadowRemoverPreviewDirty(false)
    setFeedback('Shadow remover sliders reset.')
  }, [])

  const clearMask = useCallback(() => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return
    pushUndoSnapshot()
    maskCanvas.getContext('2d').clearRect(0, 0, maskCanvas.width, maskCanvas.height)
    bumpMask()
  }, [bumpMask, pushUndoSnapshot])

  const handleRunAi = useCallback(async () => {
    if (!selectedWorkflow) {
      setFeedback('Select a ComfyUI workflow first.')
      return
    }

    if (!maskHasPixels) {
      setFeedback('Paint a mask before running AI.')
      return
    }

    const sourceCanvas = await exportCurrentComposite()
    const maskCanvas = maskCanvasRef.current

    if (!sourceCanvas || !maskCanvas) {
      setFeedback('Unable to prepare source image and mask.')
      return
    }

    const bounds = getMaskBoundingBox(maskCanvas, 0)
    if (!bounds) {
      setFeedback('Paint a mask before running AI.')
      return
    }

    const croppedSourceCanvas = cropCanvas(sourceCanvas, bounds)
    const comfyMaskCanvas = createComfyMaskCanvas(maskCanvas, bounds)

    if (!croppedSourceCanvas || !comfyMaskCanvas) {
      setFeedback('Failed to crop source and mask region.')
      return
    }

    setAiRunning(true)
    setFeedback('Running ComfyUI workflow...')

    const promptId = createExecutionId('image-editor-prompt')
    const clientId = createExecutionId('image-editor-client')
    const stopProgress = subscribeToComfyWorkflowProgress(promptId, {
      onMessage: payload => {
        const detail = payload?.detail || payload?.currentNodeLabel
        if (detail) {
          setFeedback(String(detail))
        }
      },
      onError: () => null
    })

    try {
      const sourceFile = await canvasToPngFile(croppedSourceCanvas, 'image-editor-source-cropped.png')
      const maskFile = await canvasToPngFile(comfyMaskCanvas, 'image-editor-mask-cropped.png')

      const inputs = {}

      for (const parameter of (selectedWorkflow.parameters || [])) {
        const valueType = getValueType(parameter)

        if (valueType === 'image') {
          const config = imageParamSources[parameter.id] || { type: 'none' }

          if (config.type === 'source') {
            inputs[parameter.id] = sourceFile
            continue
          }

          if (config.type === 'mask') {
            inputs[parameter.id] = maskFile
            continue
          }

          if (config.type === 'asset') {
            if (!config.asset) {
              throw new Error(`Select an asset for image parameter "${parameter.name}".`)
            }
             
            inputs[parameter.id] = await loadAssetAsFile(config.asset)
            continue
          }

          if (config.type === 'file') {
            if (!config.file) {
              throw new Error(`Select a local file for image parameter "${parameter.name}".`)
            }
            inputs[parameter.id] = config.file
            continue
          }

          continue
        }

        if (valueType === 'boolean') {
          inputs[parameter.id] = Boolean(workflowValues[parameter.id])
          continue
        }

        if (valueType === 'number') {
          const parsed = Number(workflowValues[parameter.id])
          inputs[parameter.id] = Number.isFinite(parsed) ? parsed : Number(parameter.defaultValue || 0)
          continue
        }

        inputs[parameter.id] = workflowValues[parameter.id] ?? parameter.defaultValue ?? ''
      }

      const hasSourceInput = Object.values(imageParamSources).some(config => config?.type === 'source')
      const hasMaskInput = Object.values(imageParamSources).some(config => config?.type === 'mask')
      const hasImageParams = (selectedWorkflow.parameters || []).some(parameter => getValueType(parameter) === 'image')

      if (hasImageParams && (!hasSourceInput || !hasMaskInput)) {
        throw new Error('Select one image input as source and one as mask.')
      }

      const result = await runComfyWorkflow(projectId ? Number(projectId) : null, {
        workflowId: Number(selectedWorkflow.id),
        name: `${imageName} AI Edit`,
        promptId,
        clientId,
        persistGeneratedAssets: false,
        persistProcessingCard: false,
        inputs
      })

      const generated = normalizeWorkflowResult(result)
      if (!generated) {
        throw new Error('The workflow did not return an output image.')
      }

      const outputUrl = buildAssetUrl(generated)
      if (!outputUrl) {
        throw new Error('Unable to resolve output image URL.')
      }

      const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
      if (!baseCanvas) {
        throw new Error('Unable to resolve destination canvas for AI output.')
      }

      const outputCanvas = await loadImageToCanvas(outputUrl)
      const patchCanvas = createEmptyCanvas(baseCanvas.width, baseCanvas.height)
      const patchContext = patchCanvas.getContext('2d')
      const patchWidth = Math.max(1, bounds.right - bounds.left + 1)
      const patchHeight = Math.max(1, bounds.bottom - bounds.top + 1)

      patchContext.drawImage(outputCanvas, bounds.left, bounds.top, patchWidth, patchHeight)
      patchContext.save()
      patchContext.globalCompositeOperation = 'destination-in'
      patchContext.drawImage(maskCanvas, 0, 0)
      patchContext.restore()

      pushUndoSnapshot()
      const id = createLayerId()
      const nextLayer = {
        id,
        name: `AI ${layers.filter(layer => !layer.locked).length + 1}`,
        opacity: 1,
        blendMode: 'source-over',
        visible: true,
        locked: false
      }

      layerCanvasesRef.current.set(id, patchCanvas)
      setLayers(prev => [...prev, nextLayer])
      setSelectedLayerId(id)
      setFeedback('AI result applied to the masked region.')
      bumpRender()
      if (setAsDefault && await saveWorkflowDefaults(updateComfyWorkflow, selectedWorkflow, workflowValues)) {
        try {
          const refreshed = await getComfyWorkflows()
          setWorkflows((refreshed || []).filter(workflow =>
            (workflow.parameters || []).some(param => getValueType(param) === 'image') &&
            (workflow.outputs || []).some(output => getValueType(output) === 'image')
          ))
        } catch (refreshErr) {
          console.error('Failed to refresh ComfyUI workflows:', refreshErr)
        }
      }
    } catch (err) {
      const failureMessage = err.message || 'ComfyUI execution failed.'
      setFeedback(failureMessage)
      addNotification({
        title: 'Image edit failed',
        message: failureMessage,
        source: 'ComfyUI',
        tone: 'error'
      })
    } finally {
      stopProgress()
      setAiRunning(false)
    }
  }, [addNotification, bumpRender, createEmptyCanvas, exportCurrentComposite, getComfyWorkflows, imageName, imageParamSources, layers, loadAssetAsFile, maskHasPixels, projectId, pushUndoSnapshot, runComfyWorkflow, selectedWorkflow, setAsDefault, subscribeToComfyWorkflowProgress, updateComfyWorkflow, workflowValues])

  const handleRunAiFull = useCallback(async () => {
    if (!selectedWorkflow) {
      setFeedback('Select a ComfyUI workflow first.')
      return
    }

    const sourceCanvas = await exportCurrentComposite()
    if (!sourceCanvas) {
      setFeedback('Unable to prepare source image.')
      return
    }

    setAiRunning(true)
    setFeedback('Running ComfyUI workflow...')

    const promptId = createExecutionId('image-editor-prompt')
    const clientId = createExecutionId('image-editor-client')
    const stopProgress = subscribeToComfyWorkflowProgress(promptId, {
      onMessage: payload => {
        const detail = payload?.detail || payload?.currentNodeLabel
        if (detail) {
          setFeedback(String(detail))
        }
      },
      onError: () => null
    })

    try {
      const sourceFile = await canvasToPngFile(sourceCanvas, 'image-editor-source.png')

      const inputs = {}

      for (const parameter of (selectedWorkflow.parameters || [])) {
        const valueType = getValueType(parameter)

        if (valueType === 'image') {
          const config = imageParamSources[parameter.id] || { type: 'none' }

          if (config.type === 'source') {
            inputs[parameter.id] = sourceFile
            continue
          }

          if (config.type === 'asset') {
            if (!config.asset) {
              throw new Error(`Select an asset for image parameter "${parameter.name}".`)
            }
            inputs[parameter.id] = await loadAssetAsFile(config.asset)
            continue
          }

          if (config.type === 'file') {
            if (!config.file) {
              throw new Error(`Select a local file for image parameter "${parameter.name}".`)
            }
            inputs[parameter.id] = config.file
            continue
          }

          // 'mask' or 'none' have no meaning when working on the whole image
          continue
        }

        if (valueType === 'boolean') {
          inputs[parameter.id] = Boolean(workflowValues[parameter.id])
          continue
        }

        if (valueType === 'number') {
          const parsed = Number(workflowValues[parameter.id])
          inputs[parameter.id] = Number.isFinite(parsed) ? parsed : Number(parameter.defaultValue || 0)
          continue
        }

        inputs[parameter.id] = workflowValues[parameter.id] ?? parameter.defaultValue ?? ''
      }

      const hasSourceInput = Object.values(imageParamSources).some(config => config?.type === 'source')
      const hasImageParams = (selectedWorkflow.parameters || []).some(parameter => getValueType(parameter) === 'image')

      if (hasImageParams && !hasSourceInput) {
        throw new Error('Select one image input as source.')
      }

      const result = await runComfyWorkflow(projectId ? Number(projectId) : null, {
        workflowId: Number(selectedWorkflow.id),
        name: `${imageName} AI Edit`,
        promptId,
        clientId,
        persistGeneratedAssets: false,
        persistProcessingCard: false,
        inputs
      })

      const generated = normalizeWorkflowResult(result)
      if (!generated) {
        throw new Error('The workflow did not return an output image.')
      }

      const outputUrl = buildAssetUrl(generated)
      if (!outputUrl) {
        throw new Error('Unable to resolve output image URL.')
      }

      const baseCanvas = layerCanvasesRef.current.get(layers[0]?.id)
      if (!baseCanvas) {
        throw new Error('Unable to resolve destination canvas for AI output.')
      }

      const outputCanvas = await loadImageToCanvas(outputUrl)
      const patchCanvas = createEmptyCanvas(baseCanvas.width, baseCanvas.height)
      const patchContext = patchCanvas.getContext('2d')
      patchContext.imageSmoothingEnabled = true
      patchContext.drawImage(outputCanvas, 0, 0, baseCanvas.width, baseCanvas.height)

      pushUndoSnapshot()
      const id = createLayerId()
      const nextLayer = {
        id,
        name: `AI ${layers.filter(layer => !layer.locked).length + 1}`,
        opacity: 1,
        blendMode: 'source-over',
        visible: true,
        locked: false
      }

      layerCanvasesRef.current.set(id, patchCanvas)
      setLayers(prev => [...prev, nextLayer])
      setSelectedLayerId(id)
      setFeedback('AI result applied to the full image.')
      bumpRender()
      if (setAsDefault && await saveWorkflowDefaults(updateComfyWorkflow, selectedWorkflow, workflowValues)) {
        try {
          const refreshed = await getComfyWorkflows()
          setWorkflows((refreshed || []).filter(workflow =>
            (workflow.parameters || []).some(param => getValueType(param) === 'image') &&
            (workflow.outputs || []).some(output => getValueType(output) === 'image')
          ))
        } catch (refreshErr) {
          console.error('Failed to refresh ComfyUI workflows:', refreshErr)
        }
      }
    } catch (err) {
      const failureMessage = err.message || 'ComfyUI execution failed.'
      setFeedback(failureMessage)
      addNotification({
        title: 'Image edit failed',
        message: failureMessage,
        source: 'ComfyUI',
        tone: 'error'
      })
    } finally {
      stopProgress()
      setAiRunning(false)
    }
  }, [addNotification, bumpRender, createEmptyCanvas, exportCurrentComposite, getComfyWorkflows, imageName, imageParamSources, layers, loadAssetAsFile, projectId, pushUndoSnapshot, runComfyWorkflow, selectedWorkflow, setAsDefault, subscribeToComfyWorkflowProgress, updateComfyWorkflow, workflowValues])

  const handleSaveImage = useCallback(async () => {
    if (!numericAssetId) return
    setSaving(true)
    try {
      const canvas = await exportCurrentComposite()
      if (!canvas) return
      const file = await canvasToPngFile(canvas, `${imageName || 'image'}.png`)
      await saveImageEditorFile(numericAssetId, file, imageName, 'replace')
      setFeedback('Image saved.')
    } catch (err) {
      setFeedback(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }, [exportCurrentComposite, imageName, numericAssetId, saveImageEditorFile])

  const handleSaveNewVersion = useCallback(async () => {
    if (!numericAssetId) return
    setSaving(true)
    try {
      const canvas = await exportCurrentComposite()
      if (!canvas) return
      const file = await canvasToPngFile(canvas, `${imageName || 'image'}-edit.png`)
      await saveImageEditorFile(numericAssetId, file, `${imageName || 'Image'} Edit`, 'version')
      setFeedback('New version saved.')
    } catch (err) {
      setFeedback(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }, [exportCurrentComposite, imageName, numericAssetId, saveImageEditorFile])

  const handleExportPng = useCallback(async () => {
    const canvas = await exportCurrentComposite()
    if (!canvas) return

    const file = await canvasToPngFile(canvas, `${imageName || 'image'}-edited.png`)
    const url = URL.createObjectURL(file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.name
    anchor.click()
    URL.revokeObjectURL(url)
  }, [exportCurrentComposite, imageName])

  useEffect(() => {
    let cancelled = false

    async function loadInitialImage() {
      if (!imageSourceUrl) {
        setFeedback('No source image provided.')
        setLoading(false)
        return
      }

      setLoading(true)

      try {
        const baseCanvas = await loadImageToCanvas(imageSourceUrl)
        if (cancelled) return

        const baseLayerId = 'base-layer'
        layerCanvasesRef.current.clear()
        layerCanvasesRef.current.set(baseLayerId, baseCanvas)

        const maskCanvas = createEmptyCanvas(baseCanvas.width, baseCanvas.height)
        maskCanvasRef.current = maskCanvas

        setLayers([
          {
            id: baseLayerId,
            name: 'Base',
            opacity: 1,
            blendMode: 'source-over',
            visible: true,
            locked: false
          }
        ])
        setSelectedLayerId(baseLayerId)
        setCropValues({ x: 0, y: 0, width: baseCanvas.width, height: baseCanvas.height })
        setResizeValues({ width: baseCanvas.width, height: baseCanvas.height })
        resetView()
        resetHistory()
        setFeedback('Image loaded.')
      } catch (err) {
        if (!cancelled) {
          setFeedback(err.message || 'Failed to load image for editing.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadInitialImage()

    return () => {
      cancelled = true
    }
  }, [createEmptyCanvas, imageSourceUrl, resetView, resetHistory])

  useEffect(() => {
    const onKeyDown = event => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey
      if (!ctrlOrMeta) return
      if (event.key.toLowerCase() !== 'z') return

      event.preventDefault()
      if (event.shiftKey) {
        redo()
      } else {
        undo()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [redo, undo])

  useEffect(() => {
    let cancelled = false

    async function loadWorkflows() {
      try {
        setWorkflowLoading(true)
        const data = await getComfyWorkflows()
        if (cancelled) return

        const eligible = (data || []).filter(workflow => {
          const hasImageParam = (workflow.parameters || []).some(param => getValueType(param) === 'image')
          const hasImageOutput = (workflow.outputs || []).some(output => getValueType(output) === 'image')
          return hasImageParam && hasImageOutput
        })

        setWorkflows(eligible)

        if (eligible.length > 0) {
          setSelectedWorkflowId(String(eligible[0].id))
        }
      } catch (err) {
        if (!cancelled) {
          setFeedback(err.message || 'Failed to load workflows.')
        }
      } finally {
        if (!cancelled) {
          setWorkflowLoading(false)
        }
      }
    }

    loadWorkflows()

    return () => {
      cancelled = true
    }
  }, [getComfyWorkflows])

  useEffect(() => {
    if (!selectedWorkflow) {
      setWorkflowValues({})
      setImageParamSources({})
      return
    }

    const defaults = Object.fromEntries((selectedWorkflow.parameters || []).map(parameter => {
      const valueType = getValueType(parameter)
      if (valueType === 'boolean') return [parameter.id, Boolean(parameter.defaultValue ?? false)]
      if (valueType === 'number') return [parameter.id, Number(parameter.defaultValue ?? 0)]
      if (valueType === 'image') return [parameter.id, null]
      return [parameter.id, parameter.defaultValue ?? '']
    }))

    setWorkflowValues(defaults)

    const imageParams = (selectedWorkflow.parameters || []).filter(parameter => getValueType(parameter) === 'image')
    let maskParamId = null
    let sourceParamId = null

    imageParams.forEach(parameter => {
      const name = String(parameter?.name || '').toLowerCase()
      if (!maskParamId && /mask|matte|alpha/.test(name)) {
        maskParamId = parameter.id
      } else if (!sourceParamId) {
        sourceParamId = parameter.id
      }
    })

    if (!sourceParamId && imageParams[0]) {
      sourceParamId = imageParams[0].id
    }

    if (!maskParamId && imageParams[1]) {
      maskParamId = imageParams[1].id
    }

    const defaultSources = {}
    imageParams.forEach(parameter => {
      if (parameter.id === sourceParamId) {
        defaultSources[parameter.id] = { type: 'source' }
      } else if (parameter.id === maskParamId) {
        defaultSources[parameter.id] = { type: 'mask' }
      } else {
        defaultSources[parameter.id] = { type: 'none' }
      }
    })

    setImageParamSources(defaultSources)
  }, [selectedWorkflow])

  useEffect(() => {
    let cancelled = false
    let objectUrl = null

    async function loadBrush() {
      let sourceUrl = null

      if (paintBrushSource === 'asset' && paintBrushAsset) {
        sourceUrl = buildAssetUrl(paintBrushAsset)
      }

      if (paintBrushSource === 'computer' && paintBrushFile) {
        objectUrl = URL.createObjectURL(paintBrushFile)
        sourceUrl = objectUrl
      }

      if (!sourceUrl || paintBrushSource === 'color') {
        brushImageRef.current = null
        return
      }

      try {
        const response = await fetch(sourceUrl)
        if (!response.ok) {
          throw new Error(`Failed to fetch brush (${response.status})`)
        }

        const blob = await response.blob()
        const brushObjectUrl = URL.createObjectURL(blob)
        if (!objectUrl) {
          objectUrl = brushObjectUrl
        }

        const image = new Image()
        await new Promise((resolve, reject) => {
          image.onload = resolve
          image.onerror = () => reject(new Error('Failed to decode brush image'))
          image.src = brushObjectUrl
        })

        if (cancelled) return

        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth || image.width
        canvas.height = image.naturalHeight || image.height
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
        brushImageRef.current = canvas
      } catch (err) {
        if (!cancelled) {
          brushImageRef.current = null
          setFeedback(err.message || 'Failed to load brush image.')
        }
      }
    }

    loadBrush()

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [paintBrushAsset, paintBrushFile, paintBrushSource])

  useEffect(() => {
    refreshCanvas()
  }, [maskRevision, refreshCanvas, renderRevision, toolGroup, toolId])

  useEffect(() => {
    const pointer = pointerPositionRef.current
    if (!pointer) {
      setCursorPreview(null)
      return
    }

    updateCursorPreviewAtPosition(pointer.x, pointer.y)
  }, [panOffset, updateCursorPreviewAtPosition, zoom])

  useEffect(() => {
    const shell = canvasWrapperRef.current
    if (!shell) return undefined

    const handleScroll = () => {
      const pointer = pointerPositionRef.current
      if (!pointer) {
        setCursorPreview(null)
        return
      }

      updateCursorPreviewAtPosition(pointer.x, pointer.y)
    }

    shell.addEventListener('scroll', handleScroll, { passive: true })
    return () => shell.removeEventListener('scroll', handleScroll)
  }, [updateCursorPreviewAtPosition])

  useEffect(() => () => {
    disposeShadowRemoverRenderer()
  }, [])

  const handleWorkflowValueChange = (parameterId, value) => {
    setWorkflowValues(prev => ({ ...prev, [parameterId]: value }))
  }

  const handleBrowseImageParamAsset = parameterId => {
    setPendingAssetParamId(parameterId)
    setShowAssetSelector(true)
  }

  const handleChooseImageParamFile = (parameterId, file) => {
    handleImageParamSourceChange(parameterId, 'file', file)
  }

  const workflowControlsProps = {
    workflows,
    workflowLoading,
    selectedWorkflowId,
    setSelectedWorkflowId,
    selectedWorkflow,
    workflowValues,
    onWorkflowValueChange: handleWorkflowValueChange,
    imageParamSources,
    aiRunning,
    setAsDefault,
    onToggleSetAsDefault: setSetAsDefault
  }

  const renderToolControls = () => {
    if (toolGroup === 'edit' && toolId === 'crop') {
      return (
        <CropControls
          cropValues={cropValues}
          cropLimits={cropLimits}
          onChangeX={handleCropXChange}
          onChangeY={handleCropYChange}
          onChangeWidth={handleCropWidthChange}
          onChangeHeight={handleCropHeightChange}
          onApply={handleApplyCrop}
        />
      )
    }

    if (toolGroup === 'edit' && toolId === 'resize') {
      return (
        <ResizeControls
          resizeValues={resizeValues}
          setResizeValues={setResizeValues}
          onApply={handleApplyResize}
        />
      )
    }

    if (toolGroup === 'edit' && toolId === 'adjust') {
      return (
        <AdjustControls
          adjustValues={adjustValues}
          setAdjustValues={setAdjustValues}
          setAdjustPreviewDirty={setAdjustPreviewDirty}
          onReset={handleResetAdjustments}
          onApply={handleApplyAdjustments}
        />
      )
    }

    if (toolGroup === 'edit' && toolId === 'filters') {
      return (
        <FilterControls
          filterValues={filterValues}
          setFilterValues={setFilterValues}
          setFilterPreviewDirty={setFilterPreviewDirty}
          onReset={handleResetFilters}
          onApply={handleApplyBlurSharpen}
        />
      )
    }

    if (toolGroup === 'edit' && toolId === 'shadow-remover') {
      return (
        <ShadowRemoverControls
          shadowRemoverValues={shadowRemoverValues}
          setShadowRemoverValues={setShadowRemoverValues}
          setShadowRemoverPreviewDirty={setShadowRemoverPreviewDirty}
          onReset={handleResetShadowRemover}
          onApply={handleApplyShadowRemover}
        />
      )
    }

    if (toolGroup === 'paint') {
      return (
        <PaintControls
          paint={{
            paintMode,
            setPaintMode,
            paintBrushSource,
            setPaintBrushSource,
            paintBrushFileInputRef,
            setPaintBrushFile,
            setPaintBrushAsset,
            paintColor,
            setPaintColor,
            paintSize,
            setPaintSize,
            paintOpacity,
            setPaintOpacity,
            paintHardness,
            setPaintHardness,
            paintBlendMode,
            setPaintBlendMode
          }}
          canUndo={canUndo}
          onUndo={undo}
          onSelectBrushFromLibrary={() => setShowBrushSelector(true)}
        />
      )
    }

    if (toolGroup === 'ai' && toolId === 'comfyui') {
      return (
        <ComfyUIFullControls
          workflow={workflowControlsProps}
          onChangeImageParamSource={handleImageParamSourceChange}
          onBrowseAsset={handleBrowseImageParamAsset}
          onChooseFile={handleChooseImageParamFile}
          onRun={handleRunAiFull}
        />
      )
    }

    return (
      <ComfyUIMaskControls
        workflow={workflowControlsProps}
        mask={{
          maskMode,
          setMaskMode,
          maskSize,
          setMaskSize,
          maskHardness,
          setMaskHardness,
          maskHasPixels
        }}
        onChangeImageParamSource={handleImageParamSourceChange}
        onBrowseAsset={handleBrowseImageParamAsset}
        onChooseFile={handleChooseImageParamFile}
        onClearMask={clearMask}
        onRun={handleRunAi}
      />
    )
  }

  return (
    <div className="image-editor-layout">
      <Header onSettingsClick={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="image-editor-page">
        <section className="image-editor-shell">
          <ImageEditorToolbar
            imageName={imageName}
            onBack={() => navigate(returnTo)}
            onUndo={undo}
            onRedo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
            showSaveButtons={numericAssetId > 0}
            onSaveImage={handleSaveImage}
            onSaveNewVersion={handleSaveNewVersion}
            onExportPng={handleExportPng}
            loading={loading}
            saving={saving}
            layerCount={layers.length}
          />

          {feedback && (
            <div className="image-editor-feedback">
              <span className="material-symbols-outlined">info</span>
              <span>{feedback}</span>
            </div>
          )}

          <div className="image-editor-workspace">
            <ToolSidebar
              toolGroup={toolGroup}
              toolId={toolId}
              onSelectTool={(group, id) => {
                setToolGroup(group)
                setToolId(id)
              }}
            >
              {renderToolControls()}
            </ToolSidebar>

            <div
              className="image-editor-canvas-shell"
              ref={canvasWrapperRef}
              onPointerDown={handleShellPointerDown}
              onPointerMove={handleShellPointerMove}
              onPointerUp={handleShellPointerUp}
              onPointerCancel={handleShellPointerCancel}
            >
              <div className="image-editor-zoom-controls">
                <button type="button" className="image-editor-btn" onClick={zoomIn}>
                  Zoom In
                </button>
                <button type="button" className="image-editor-btn" onClick={zoomOut}>
                  Zoom Out
                </button>
                <button type="button" className="image-editor-btn" onClick={resetView}>
                  Fit View
                </button>
                <span className="image-editor-zoom-label">{Math.round(zoom * 100)}%</span>
              </div>

              {loading ? (
                <div className="image-editor-loading">
                  <span className="material-symbols-outlined image-editor-spinner">progress_activity</span>
                  <span>Loading image...</span>
                </div>
              ) : (
                <canvas
                  ref={displayCanvasRef}
                  className="image-editor-canvas"
                  style={{
                    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                    transformOrigin: 'center center'
                  }}
                  onWheel={handleCanvasWheel}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  onPointerCancel={handleCanvasPointerCancel}
                  onPointerLeave={handleCanvasPointerLeave}
                />
              )}
              {cursorPreview && (
                <div
                  className={`image-editor-cursor-preview ${cursorPreview.mode === 'ai' ? 'image-editor-cursor-preview--mask' : ''}`}
                  style={{
                    left: cursorPreview.x,
                    top: cursorPreview.y,
                    width: cursorPreview.width,
                    height: cursorPreview.height,
                    borderColor: cursorPreview.color,
                    borderRadius: cursorPreview.borderRadius
                  }}
                />
              )}
            </div>

            <LayersPanel
              layers={layers}
              selectedLayerId={selectedLayerId}
              setSelectedLayerId={setSelectedLayerId}
              loading={loading}
              onAddLayer={handleAddLayer}
              onUpdateLayer={handleUpdateLayer}
              onMoveLayer={handleMoveLayer}
              onDeleteLayer={handleDeleteLayer}
            />
          </div>
        </section>
      </main>

      {showBrushSelector && (
        <AssetSelectorModal
          assetType="brush"
          onSelect={asset => {
            setPaintBrushAsset(asset)
            setPaintBrushFile(null)
            setPaintBrushSource('asset')
            setShowBrushSelector(false)
          }}
          onClose={() => setShowBrushSelector(false)}
          showEdits
        />
      )}

      {showAssetSelector && (
        <AssetSelectorModal
          assetType="image"
          onSelect={asset => {
            if (pendingAssetParamId) {
              handleImageParamSourceChange(pendingAssetParamId, 'asset', asset)
            }
            setShowAssetSelector(false)
            setPendingAssetParamId(null)
          }}
          onClose={() => {
            setShowAssetSelector(false)
            setPendingAssetParamId(null)
          }}
          showEdits
        />
      )}

      <Footer />
    </div>
  )
}
