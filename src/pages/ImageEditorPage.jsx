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
import './ImageEditorPage.css'

const PAINT_BLEND_MODES = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' }
]

const TOOLS = {
  edit: [
    { id: 'crop', label: 'Crop', icon: 'crop' },
    { id: 'resize', label: 'Resize', icon: 'open_in_full' },
    { id: 'adjust', label: 'Levels / Contrast / Saturation', icon: 'tune' },
    { id: 'filters', label: 'Blur / Sharpen', icon: 'blur_on' },
    { id: 'shadow-remover', label: 'Shadow Remover', icon: 'light_mode' }
  ],
  paint: [
    { id: 'paint', label: 'Brush / Image Brush', icon: 'brush' }
  ],
  ai: [
    { id: 'mask', label: 'Mask + ComfyUI', icon: 'auto_fix_high' }
  ]
}

const DEFAULT_ADJUST_VALUES = { blackPoint: 0, whitePoint: 255, contrast: 0, saturation: 0 }
const DEFAULT_FILTER_VALUES = { blur: 0, sharpen: 0 }
const DEFAULT_SHADOW_REMOVER_VALUES = { strength: 40, threshold: 32, softness: 18, midtoneProtection: 72, warmth: 0 }
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_STEP = 1.15

function createLayerId() {
  return `image-layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function cloneCanvasElement(sourceCanvas) {
  if (!sourceCanvas) return null
  const cloned = document.createElement('canvas')
  cloned.width = sourceCanvas.width
  cloned.height = sourceCanvas.height
  cloned.getContext('2d').drawImage(sourceCanvas, 0, 0)
  return cloned
}

function applyAdjustmentsToCanvas(sourceCanvas, settings) {
  const outputCanvas = cloneCanvasElement(sourceCanvas)
  if (!outputCanvas) return null

  const context = outputCanvas.getContext('2d')
  const imageData = context.getImageData(0, 0, outputCanvas.width, outputCanvas.height)
  const data = imageData.data

  const black = clamp(settings.blackPoint, 0, 254)
  const white = clamp(settings.whitePoint, black + 1, 255)
  const contrastFactor = (259 * (settings.contrast + 255)) / (255 * (259 - settings.contrast))
  const saturationFactor = 1 + settings.saturation / 100

  for (let index = 0; index < data.length; index += 4) {
    let red = data[index]
    let green = data[index + 1]
    let blue = data[index + 2]

    red = clamp(((red - black) * 255) / (white - black), 0, 255)
    green = clamp(((green - black) * 255) / (white - black), 0, 255)
    blue = clamp(((blue - black) * 255) / (white - black), 0, 255)

    red = clamp(contrastFactor * (red - 128) + 128, 0, 255)
    green = clamp(contrastFactor * (green - 128) + 128, 0, 255)
    blue = clamp(contrastFactor * (blue - 128) + 128, 0, 255)

    const gray = red * 0.299 + green * 0.587 + blue * 0.114
    red = clamp(gray + (red - gray) * saturationFactor, 0, 255)
    green = clamp(gray + (green - gray) * saturationFactor, 0, 255)
    blue = clamp(gray + (blue - gray) * saturationFactor, 0, 255)

    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }

  context.putImageData(imageData, 0, 0)
  return outputCanvas
}

function applyBlurSharpenToCanvas(sourceCanvas, settings) {
  const outputCanvas = cloneCanvasElement(sourceCanvas)
  if (!outputCanvas) return null

  const context = outputCanvas.getContext('2d')

  if (settings.blur > 0) {
    const blurredSource = cloneCanvasElement(outputCanvas)
    context.clearRect(0, 0, outputCanvas.width, outputCanvas.height)
    context.filter = `blur(${settings.blur}px)`
    context.drawImage(blurredSource, 0, 0)
    context.filter = 'none'
  }

  if (settings.sharpen > 0) {
    const sourceData = context.getImageData(0, 0, outputCanvas.width, outputCanvas.height)
    const output = context.createImageData(outputCanvas.width, outputCanvas.height)
    const input = sourceData.data
    const out = output.data
    const width = outputCanvas.width
    const height = outputCanvas.height
    const amount = clamp(settings.sharpen / 100, 0, 1.5)

    const kernel = [
      0, -1, 0,
      -1, 5 + amount * 2.5, -1,
      0, -1, 0
    ]

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4

        let red = 0
        let green = 0
        let blue = 0

        let kernelIndex = 0
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const sampleX = clamp(x + kx, 0, width - 1)
            const sampleY = clamp(y + ky, 0, height - 1)
            const sampleIndex = (sampleY * width + sampleX) * 4
            const weight = kernel[kernelIndex]
            red += input[sampleIndex] * weight
            green += input[sampleIndex + 1] * weight
            blue += input[sampleIndex + 2] * weight
            kernelIndex += 1
          }
        }

        out[index] = clamp(red, 0, 255)
        out[index + 1] = clamp(green, 0, 255)
        out[index + 2] = clamp(blue, 0, 255)
        out[index + 3] = input[index + 3]
      }
    }

    context.putImageData(output, 0, 0)
  }

  return outputCanvas
}

function getValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'number') return 'number'
  if (parameter?.type === 'boolean') return 'boolean'
  return 'string'
}

function normalizeWorkflowResult(result) {
  const list = Array.isArray(result) ? result : [result]
  const imageAsset = list.find(item => item?.type === 'image') || list[0]
  return imageAsset || null
}

async function loadImageToCanvas(url, width, height) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load image (${response.status})`)
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)

  try {
    const image = new Image()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('Failed to decode image'))
      image.src = objectUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = width || image.naturalWidth || image.width
    canvas.height = height || image.naturalHeight || image.height
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function canvasToPngFile(canvas, filename) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(nextBlob => {
      if (!nextBlob) {
        reject(new Error('Failed to encode image as PNG'))
        return
      }
      resolve(nextBlob)
    }, 'image/png')
  })

  return new File([blob], filename, { type: 'image/png' })
}

function getMaskBoundingBox(canvas, padding = 0) {
  if (!canvas?.width || !canvas?.height) return null
  const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data

  let minX = canvas.width
  let minY = canvas.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4 + 3
      if (imageData[index] <= 0) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0 || maxY < 0) return null

  return {
    left: clamp(Math.floor(minX - padding), 0, canvas.width - 1),
    top: clamp(Math.floor(minY - padding), 0, canvas.height - 1),
    right: clamp(Math.ceil(maxX + padding), 0, canvas.width - 1),
    bottom: clamp(Math.ceil(maxY + padding), 0, canvas.height - 1)
  }
}

function cropCanvas(canvas, bounds) {
  if (!canvas || !bounds) return null
  const width = Math.max(1, bounds.right - bounds.left + 1)
  const height = Math.max(1, bounds.bottom - bounds.top + 1)
  const cropped = document.createElement('canvas')
  cropped.width = width
  cropped.height = height
  cropped.getContext('2d').drawImage(canvas, bounds.left, bounds.top, width, height, 0, 0, width, height)
  return cropped
}

function createComfyMaskCanvas(sourceMaskCanvas, bounds = null) {
  if (!sourceMaskCanvas) return null

  const maskSource = bounds ? cropCanvas(sourceMaskCanvas, bounds) : sourceMaskCanvas
  if (!maskSource) return null

  const sourceContext = maskSource.getContext('2d')
  const sourceImageData = sourceContext.getImageData(0, 0, maskSource.width, maskSource.height)

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = maskSource.width
  maskCanvas.height = maskSource.height
  const maskContext = maskCanvas.getContext('2d')
  const maskImageData = maskContext.createImageData(maskSource.width, maskSource.height)

  for (let index = 0; index < sourceImageData.data.length; index += 4) {
    const alpha = sourceImageData.data[index + 3]
    maskImageData.data[index] = alpha
    maskImageData.data[index + 1] = alpha
    maskImageData.data[index + 2] = alpha
    maskImageData.data[index + 3] = 255
  }

  maskContext.putImageData(maskImageData, 0, 0)
  return maskCanvas
}

export default function ImageEditorPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { getComfyWorkflows, runComfyWorkflow, subscribeToComfyWorkflowProgress, saveImageEditorFile } = useProjects()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [loading, setLoading] = useState(true)

  const [layers, setLayers] = useState([])
  const [selectedLayerId, setSelectedLayerId] = useState(null)
  const layerCanvasesRef = useRef(new Map())
  const [renderRevision, setRenderRevision] = useState(0)
  const historyUndoRef = useRef([])
  const historyRedoRef = useRef([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
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

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyUndoRef.current.length > 0)
    setCanRedo(historyRedoRef.current.length > 0)
  }, [])

  const captureSnapshot = useCallback(() => {
    const layerCanvases = {}
    layers.forEach(layer => {
      layerCanvases[layer.id] = cloneCanvasElement(layerCanvasesRef.current.get(layer.id))
    })

    return {
      layers: layers.map(layer => ({ ...layer })),
      selectedLayerId,
      layerCanvases,
      maskCanvas: cloneCanvasElement(maskCanvasRef.current)
    }
  }, [layers, selectedLayerId])

  const restoreSnapshot = useCallback((snapshot) => {
    const nextMap = new Map()
    snapshot.layers.forEach(layer => {
      const sourceCanvas = snapshot.layerCanvases[layer.id]
      if (sourceCanvas) {
        nextMap.set(layer.id, cloneCanvasElement(sourceCanvas))
      }
    })

    layerCanvasesRef.current = nextMap
    maskCanvasRef.current = snapshot.maskCanvas ? cloneCanvasElement(snapshot.maskCanvas) : null
    setLayers(snapshot.layers.map(layer => ({ ...layer })))
    setSelectedLayerId(snapshot.selectedLayerId || null)
    setMaskRevision(prev => prev + 1)
    setRenderRevision(prev => prev + 1)
  }, [])

  const pushUndoSnapshot = useCallback(() => {
    if (layers.length === 0) return
    const snapshot = captureSnapshot()
    historyUndoRef.current.push(snapshot)
    if (historyUndoRef.current.length > 40) {
      historyUndoRef.current.shift()
    }
    historyRedoRef.current = []
    syncHistoryFlags()
  }, [captureSnapshot, layers.length, syncHistoryFlags])

  const undo = useCallback(() => {
    if (historyUndoRef.current.length === 0) return
    const current = captureSnapshot()
    const previous = historyUndoRef.current.pop()
    historyRedoRef.current.push(current)
    restoreSnapshot(previous)
    syncHistoryFlags()
  }, [captureSnapshot, restoreSnapshot, syncHistoryFlags])

  const redo = useCallback(() => {
    if (historyRedoRef.current.length === 0) return
    const current = captureSnapshot()
    const next = historyRedoRef.current.pop()
    historyUndoRef.current.push(current)
    restoreSnapshot(next)
    syncHistoryFlags()
  }, [captureSnapshot, restoreSnapshot, syncHistoryFlags])

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
  }, [addNotification, bumpRender, createEmptyCanvas, exportCurrentComposite, imageName, imageParamSources, layers, loadAssetAsFile, maskHasPixels, projectId, pushUndoSnapshot, runComfyWorkflow, selectedWorkflow, subscribeToComfyWorkflowProgress, workflowValues])

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
        historyUndoRef.current = []
        historyRedoRef.current = []
        syncHistoryFlags()
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
  }, [createEmptyCanvas, imageSourceUrl, resetView, syncHistoryFlags])

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

  const renderToolControls = () => {
    if (toolGroup === 'edit' && toolId === 'crop') {
      return (
        <div className="image-editor-controls">
          <label className="image-editor-label">
            X
            <input
              className="image-editor-input"
              type="number"
              value={cropValues.x}
              min={cropLimits.xMin}
              max={cropLimits.xMax}
              step="1"
              onChange={event => handleCropXChange(event.target.value)}
            />
            <input
              className="image-editor-input"
              type="range"
              min={cropLimits.xMin}
              max={cropLimits.xMax}
              step="1"
              value={cropValues.x}
              onChange={event => handleCropXChange(event.target.value)}
            />
          </label>
          <label className="image-editor-label">
            Y
            <input
              className="image-editor-input"
              type="number"
              value={cropValues.y}
              min={cropLimits.yMin}
              max={cropLimits.yMax}
              step="1"
              onChange={event => handleCropYChange(event.target.value)}
            />
            <input
              className="image-editor-input"
              type="range"
              min={cropLimits.yMin}
              max={cropLimits.yMax}
              step="1"
              value={cropValues.y}
              onChange={event => handleCropYChange(event.target.value)}
            />
          </label>
          <label className="image-editor-label">
            Width
            <input
              className="image-editor-input"
              type="number"
              value={cropValues.width}
              min={cropLimits.widthMin}
              max={cropLimits.widthMax}
              step="1"
              onChange={event => handleCropWidthChange(event.target.value)}
            />
            <input
              className="image-editor-input"
              type="range"
              min={cropLimits.widthMin}
              max={cropLimits.widthMax}
              step="1"
              value={cropValues.width}
              onChange={event => handleCropWidthChange(event.target.value)}
            />
          </label>
          <label className="image-editor-label">
            Height
            <input
              className="image-editor-input"
              type="number"
              value={cropValues.height}
              min={cropLimits.heightMin}
              max={cropLimits.heightMax}
              step="1"
              onChange={event => handleCropHeightChange(event.target.value)}
            />
            <input
              className="image-editor-input"
              type="range"
              min={cropLimits.heightMin}
              max={cropLimits.heightMax}
              step="1"
              value={cropValues.height}
              onChange={event => handleCropHeightChange(event.target.value)}
            />
          </label>
          <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={handleApplyCrop}>
            Apply Crop
          </button>
        </div>
      )
    }

    if (toolGroup === 'edit' && toolId === 'resize') {
      return (
        <div className="image-editor-controls">
          <label className="image-editor-label">
            Width
            <input
              className="image-editor-input"
              type="number"
              value={resizeValues.width}
              onChange={event => setResizeValues(prev => ({ ...prev, width: Number(event.target.value) }))}
            />
          </label>
          <label className="image-editor-label">
            Height
            <input
              className="image-editor-input"
              type="number"
              value={resizeValues.height}
              onChange={event => setResizeValues(prev => ({ ...prev, height: Number(event.target.value) }))}
            />
          </label>
          <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={handleApplyResize}>
            Apply Resize
          </button>
        </div>
      )
    }

    if (toolGroup === 'edit' && toolId === 'adjust') {
      return (
        <div className="image-editor-controls">
          <label className="image-editor-label">
            Black Point
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="254"
              value={adjustValues.blackPoint}
              onChange={event => {
                setAdjustValues(prev => ({ ...prev, blackPoint: Number(event.target.value) }))
                setAdjustPreviewDirty(true)
              }}
            />
          </label>
          <label className="image-editor-label">
            White Point
            <input
              className="image-editor-input"
              type="range"
              min="1"
              max="255"
              value={adjustValues.whitePoint}
              onChange={event => {
                setAdjustValues(prev => ({ ...prev, whitePoint: Number(event.target.value) }))
                setAdjustPreviewDirty(true)
              }}
            />
          </label>
          <label className="image-editor-label">
            Contrast
            <input
              className="image-editor-input"
              type="range"
              min="-80"
              max="80"
              value={adjustValues.contrast}
              onChange={event => {
                setAdjustValues(prev => ({ ...prev, contrast: Number(event.target.value) }))
                setAdjustPreviewDirty(true)
              }}
            />
          </label>
          <label className="image-editor-label">
            Saturation
            <input
              className="image-editor-input"
              type="range"
              min="-100"
              max="100"
              value={adjustValues.saturation}
              onChange={event => {
                setAdjustValues(prev => ({ ...prev, saturation: Number(event.target.value) }))
                setAdjustPreviewDirty(true)
              }}
            />
          </label>
          <div className="image-editor-toggle-row">
            <button type="button" className="image-editor-btn" onClick={handleResetAdjustments}>
              Reset
            </button>
            <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={handleApplyAdjustments}>
              Apply Adjustments
            </button>
          </div>
        </div>
      )
    }

    if (toolGroup === 'edit' && toolId === 'filters') {
      return (
        <div className="image-editor-controls">
          <label className="image-editor-label">
            Blur
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="30"
              value={filterValues.blur}
              onChange={event => {
                setFilterValues(prev => ({ ...prev, blur: Number(event.target.value) }))
                setFilterPreviewDirty(true)
              }}
            />
          </label>
          <label className="image-editor-label">
            Sharpen
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="100"
              value={filterValues.sharpen}
              onChange={event => {
                setFilterValues(prev => ({ ...prev, sharpen: Number(event.target.value) }))
                setFilterPreviewDirty(true)
              }}
            />
          </label>
          <div className="image-editor-toggle-row">
            <button type="button" className="image-editor-btn" onClick={handleResetFilters}>
              Reset
            </button>
            <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={handleApplyBlurSharpen}>
              Apply Filters
            </button>
          </div>
        </div>
      )
    }

    if (toolGroup === 'edit' && toolId === 'shadow-remover') {
      return (
        <div className="image-editor-controls">
          <label className="image-editor-label">
            Strength ({shadowRemoverValues.strength}%)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="100"
              value={shadowRemoverValues.strength}
              onChange={event => {
                setShadowRemoverValues(prev => ({ ...prev, strength: Number(event.target.value) }))
                setShadowRemoverPreviewDirty(true)
              }}
            />
          </label>

          <label className="image-editor-label">
            Shadow Threshold ({shadowRemoverValues.threshold}%)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="100"
              value={shadowRemoverValues.threshold}
              onChange={event => {
                setShadowRemoverValues(prev => ({ ...prev, threshold: Number(event.target.value) }))
                setShadowRemoverPreviewDirty(true)
              }}
            />
          </label>

          <label className="image-editor-label">
            Edge Softness ({shadowRemoverValues.softness}%)
            <input
              className="image-editor-input"
              type="range"
              min="1"
              max="100"
              value={shadowRemoverValues.softness}
              onChange={event => {
                setShadowRemoverValues(prev => ({ ...prev, softness: Number(event.target.value) }))
                setShadowRemoverPreviewDirty(true)
              }}
            />
          </label>

          <label className="image-editor-label">
            Midtone Protection ({shadowRemoverValues.midtoneProtection}%)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="100"
              value={shadowRemoverValues.midtoneProtection}
              onChange={event => {
                setShadowRemoverValues(prev => ({ ...prev, midtoneProtection: Number(event.target.value) }))
                setShadowRemoverPreviewDirty(true)
              }}
            />
          </label>

          <label className="image-editor-label">
            Shadow Warmth ({shadowRemoverValues.warmth > 0 ? '+' : ''}{shadowRemoverValues.warmth}%)
            <input
              className="image-editor-input"
              type="range"
              min="-100"
              max="100"
              value={shadowRemoverValues.warmth}
              onChange={event => {
                setShadowRemoverValues(prev => ({ ...prev, warmth: Number(event.target.value) }))
                setShadowRemoverPreviewDirty(true)
              }}
            />
          </label>

          <div className="image-editor-toggle-row">
            <button type="button" className="image-editor-btn" onClick={handleResetShadowRemover}>
              Reset
            </button>
            <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={handleApplyShadowRemover}>
              Apply Shadow Remover
            </button>
          </div>

          <p className="image-editor-help">Lifts shadows using a gamma curve (like Lightroom&apos;s Shadows slider). Warmth corrects the cool blue cast common in outdoor shadows. GPU-accelerated with CPU fallback.</p>
        </div>
      )
    }

    if (toolGroup === 'paint') {
      return (
        <div className="image-editor-controls">
          <div className="image-editor-toggle-row">
            <button
              type="button"
              className={`image-editor-toggle ${paintMode === 'draw' ? 'image-editor-toggle--active' : ''}`}
              onClick={() => setPaintMode('draw')}
            >
              Draw
            </button>
            <button
              type="button"
              className={`image-editor-toggle ${paintMode === 'erase' ? 'image-editor-toggle--active' : ''}`}
              onClick={() => setPaintMode('erase')}
            >
              Erase
            </button>
          </div>

          <button type="button" className="image-editor-btn" onClick={undo} disabled={!canUndo}>
            Undo
          </button>

          <label className="image-editor-label">
            Brush Source
            <select
              className="image-editor-input"
              value={paintBrushSource}
              onChange={event => setPaintBrushSource(event.target.value)}
            >
              <option value="color">Color Brush</option>
              <option value="asset">Image Brush (Library)</option>
              <option value="computer">Image Brush (Computer)</option>
            </select>
          </label>

          {paintBrushSource === 'asset' && (
            <button type="button" className="image-editor-btn" onClick={() => setShowBrushSelector(true)}>
              Select Brush from Library
            </button>
          )}

          {paintBrushSource === 'computer' && (
            <>
              <button type="button" className="image-editor-btn" onClick={() => paintBrushFileInputRef.current?.click()}>
                Upload Brush from Computer
              </button>
              <input
                ref={paintBrushFileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                className="image-editor-hidden-file"
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) {
                    setPaintBrushFile(file)
                    setPaintBrushAsset(null)
                  }
                  event.target.value = ''
                }}
              />
            </>
          )}

          <label className="image-editor-label">
            Color
            <input
              className="image-editor-input image-editor-input--color"
              type="color"
              value={paintColor}
              onChange={event => setPaintColor(event.target.value)}
            />
          </label>

          <label className="image-editor-label">
            Size ({paintSize}px)
            <input
              className="image-editor-input"
              type="range"
              min="1"
              max="320"
              value={paintSize}
              onChange={event => setPaintSize(Number(event.target.value))}
            />
          </label>

          <label className="image-editor-label">
            Opacity ({Math.round(paintOpacity * 100)}%)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={paintOpacity}
              onChange={event => setPaintOpacity(Number(event.target.value))}
            />
          </label>

          <label className="image-editor-label">
            Hardness ({Math.round(paintHardness * 100)}%)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={paintHardness}
              onChange={event => setPaintHardness(Number(event.target.value))}
            />
          </label>

          <label className="image-editor-label">
            Blend Mode
            <select
              className="image-editor-input"
              value={paintBlendMode}
              onChange={event => setPaintBlendMode(event.target.value)}
            >
              {PAINT_BLEND_MODES.map(mode => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </label>

          <p className="image-editor-help">Paint directly on the canvas. If the selected layer is locked, a new layer will be created automatically.</p>
        </div>
      )
    }

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

        <button type="button" className="image-editor-btn" onClick={clearMask}>
          Clear Mask
        </button>

        <label className="image-editor-label">
          ComfyUI Workflow
          <select
            className="image-editor-input"
            value={selectedWorkflowId}
            onChange={event => setSelectedWorkflowId(event.target.value)}
            disabled={workflowLoading || workflows.length === 0}
          >
            {workflows.length === 0 ? (
              <option value="">No compatible workflows</option>
            ) : workflows.map(workflow => (
              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
            ))}
          </select>
        </label>

        {selectedWorkflow && (
          <div className="image-editor-controls image-editor-controls--nested">
            <span className="image-editor-label">Image Inputs</span>
            {(selectedWorkflow.parameters || [])
              .filter(parameter => getValueType(parameter) === 'image')
              .map(parameter => {
                const config = imageParamSources[parameter.id] || { type: 'none' }
                return (
                  <div key={parameter.id} className="image-editor-label image-editor-ai-input">
                    <span>{parameter.name}</span>
                    <select
                      className="image-editor-input"
                      value={config.type}
                      onChange={event => handleImageParamSourceChange(parameter.id, event.target.value)}
                    >
                      <option value="none">- Not used -</option>
                      <option value="source">Use as source image (painted image view)</option>
                      <option value="mask">Use as mask image (painted mask)</option>
                      <option value="asset">From assets</option>
                      <option value="file">From computer</option>
                    </select>

                    {config.type === 'asset' && (
                      <div className="image-editor-ai-row">
                        <span className="image-editor-help">{config.asset?.name || 'No asset selected'}</span>
                        <button
                          type="button"
                          className="image-editor-btn"
                          onClick={() => {
                            setPendingAssetParamId(parameter.id)
                            setShowAssetSelector(true)
                          }}
                        >
                          Browse
                        </button>
                      </div>
                    )}

                    {config.type === 'file' && (
                      <div className="image-editor-ai-row">
                        <span className="image-editor-help">{config.fileName || 'No file chosen'}</span>
                        <label className="image-editor-btn" style={{ cursor: 'pointer' }}>
                          Choose file
                          <input
                            type="file"
                            accept="image/*"
                            className="image-editor-hidden-file"
                            onChange={event => {
                              const file = event.target.files?.[0]
                              if (file) {
                                handleImageParamSourceChange(parameter.id, 'file', file)
                              }
                              event.target.value = ''
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        )}

        {(selectedWorkflow?.parameters || [])
          .filter(parameter => getValueType(parameter) !== 'image')
          .map(parameter => {
            const valueType = getValueType(parameter)
            if (valueType === 'boolean') {
              return (
                <label key={parameter.id} className="image-editor-label image-editor-label--checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(workflowValues[parameter.id])}
                    onChange={event => setWorkflowValues(prev => ({ ...prev, [parameter.id]: event.target.checked }))}
                  />
                  <span>{parameter.name}</span>
                </label>
              )
            }

            return (
              <label key={parameter.id} className="image-editor-label">
                {parameter.name}
                <input
                  className="image-editor-input"
                  type={valueType === 'number' ? 'number' : 'text'}
                  value={workflowValues[parameter.id] ?? ''}
                  onChange={event => setWorkflowValues(prev => ({ ...prev, [parameter.id]: event.target.value }))}
                />
              </label>
            )
          })}

        <button
          type="button"
          className="image-editor-btn image-editor-btn--primary"
          disabled={aiRunning || !selectedWorkflow || !maskHasPixels}
          onClick={handleRunAi}
        >
          {aiRunning ? 'Running...' : 'Run ComfyUI'}
        </button>

        {!maskHasPixels && <p className="image-editor-help">Paint a mask region before running AI.</p>}
      </div>
    )
  }

  return (
    <div className="image-editor-layout">
      <Header onSettingsClick={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="image-editor-page">
        <section className="image-editor-shell">
          <div className="image-editor-toolbar">
            <div className="image-editor-toolbar__left">
              <button type="button" className="image-editor-btn" onClick={() => navigate(returnTo)}>
                <span className="material-symbols-outlined">arrow_back</span>
                Back
              </button>
              <div>
                <h1 className="image-editor-title font-headline">Image Editor</h1>
                <p className="image-editor-subtitle">{imageName}</p>
              </div>
            </div>

            <div className="image-editor-toolbar__right">
              <button type="button" className="image-editor-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
                <span className="material-symbols-outlined">undo</span>
                Undo
              </button>
              <button type="button" className="image-editor-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">
                <span className="material-symbols-outlined">redo</span>
                Redo
              </button>
              {numericAssetId > 0 && (
                <button type="button" className="image-editor-btn" onClick={handleSaveImage} disabled={loading || layers.length === 0 || saving}>
                  <span className="material-symbols-outlined">save</span>
                  Save Image
                </button>
              )}
              {numericAssetId > 0 && (
                <button type="button" className="image-editor-btn" onClick={handleSaveNewVersion} disabled={loading || layers.length === 0 || saving}>
                  <span className="material-symbols-outlined">save_as</span>
                  Save New Version
                </button>
              )}
              <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={handleExportPng} disabled={loading || layers.length === 0}>
                Export PNG
              </button>
            </div>
          </div>

          {feedback && (
            <div className="image-editor-feedback">
              <span className="material-symbols-outlined">info</span>
              <span>{feedback}</span>
            </div>
          )}

          <div className="image-editor-workspace">
            <aside className="image-editor-tools">
              <div className="image-editor-tools__group">
                <h3 className="image-editor-tools__group-title">Edit</h3>
                {TOOLS.edit.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`image-editor-tools__item ${toolGroup === 'edit' && toolId === item.id ? 'image-editor-tools__item--active' : ''}`}
                    onClick={() => {
                      setToolGroup('edit')
                      setToolId(item.id)
                    }}
                  >
                    <span className="material-symbols-outlined">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>

              <div className="image-editor-tools__group">
                <h3 className="image-editor-tools__group-title">Paint</h3>
                {TOOLS.paint.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`image-editor-tools__item ${toolGroup === 'paint' && toolId === item.id ? 'image-editor-tools__item--active' : ''}`}
                    onClick={() => {
                      setToolGroup('paint')
                      setToolId(item.id)
                    }}
                  >
                    <span className="material-symbols-outlined">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>

              <div className="image-editor-tools__group">
                <h3 className="image-editor-tools__group-title">AI</h3>
                {TOOLS.ai.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`image-editor-tools__item ${toolGroup === 'ai' && toolId === item.id ? 'image-editor-tools__item--active' : ''}`}
                    onClick={() => {
                      setToolGroup('ai')
                      setToolId(item.id)
                    }}
                  >
                    <span className="material-symbols-outlined">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>

              {renderToolControls()}
            </aside>

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

            <aside className="image-editor-layers-panel">
              <div className="image-editor-layers-panel__header">
                <span className="image-editor-layers-panel__title">Layers</span>
                <div className="image-editor-layers-panel__actions">
                  <button type="button" className="image-editor-layer-btn" onClick={handleAddLayer} disabled={loading}>
                    <span className="material-symbols-outlined">add</span>
                  </button>
                </div>
              </div>

              <div className="image-editor-layers-panel__list">
                {layers.length === 0 ? (
                  <div className="image-editor-layers-panel__empty">No layers loaded.</div>
                ) : (
                  [...layers].slice().reverse().map((layer, reverseIndex) => {
                    const index = layers.length - 1 - reverseIndex
                    const isFirst = index === layers.length - 1
                    const isLast = index === 0

                    return (
                      <div
                        key={layer.id}
                        className={`image-editor-layer-card ${selectedLayerId === layer.id ? 'image-editor-layer-card--selected' : ''}`}
                        onClick={() => setSelectedLayerId(prev => (prev === layer.id ? null : layer.id))}
                      >
                        <div className="image-editor-layer-card__header">
                          <input
                            type="radio"
                            className="image-editor-layer-card__radio"
                            checked={selectedLayerId === layer.id}
                            onChange={() => setSelectedLayerId(layer.id)}
                            onClick={event => {
                              event.stopPropagation()
                              if (selectedLayerId === layer.id) {
                                event.preventDefault()
                                setSelectedLayerId(null)
                              }
                            }}
                          />

                          <button
                            type="button"
                            className="image-editor-layer-card__icon-btn"
                            onClick={event => {
                              event.stopPropagation()
                              handleUpdateLayer(layer.id, { visible: !layer.visible })
                            }}
                            title={layer.visible ? 'Hide layer' : 'Show layer'}
                          >
                            <span className="material-symbols-outlined">{layer.visible ? 'visibility' : 'visibility_off'}</span>
                          </button>

                          <input
                            className="image-editor-layer-card__name"
                            value={layer.name}
                            onChange={event => handleUpdateLayer(layer.id, { name: event.target.value })}
                            onClick={event => event.stopPropagation()}
                          />

                          <button
                            type="button"
                            className="image-editor-layer-card__icon-btn"
                            title="Move up"
                            disabled={isFirst}
                            onClick={event => {
                              event.stopPropagation()
                              handleMoveLayer(layer.id, 'up')
                            }}
                          >
                            <span className="material-symbols-outlined">keyboard_arrow_up</span>
                          </button>

                          <button
                            type="button"
                            className="image-editor-layer-card__icon-btn"
                            title="Move down"
                            disabled={isLast}
                            onClick={event => {
                              event.stopPropagation()
                              handleMoveLayer(layer.id, 'down')
                            }}
                          >
                            <span className="material-symbols-outlined">keyboard_arrow_down</span>
                          </button>

                          <button
                            type="button"
                            className="image-editor-layer-card__icon-btn"
                            title={layer.id === 'base-layer' ? 'Base layer cannot be deleted' : 'Delete layer'}
                            disabled={layer.id === 'base-layer'}
                            onClick={event => {
                              event.stopPropagation()
                              handleDeleteLayer(layer.id)
                            }}
                          >
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                        </div>

                        <div className="image-editor-layer-card__row">
                          <span>Opacity</span>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={layer.opacity}
                            onChange={event => handleUpdateLayer(layer.id, { opacity: Number(event.target.value) })}
                            onClick={event => event.stopPropagation()}
                          />
                        </div>

                        <div className="image-editor-layer-card__row">
                          <span>Blend</span>
                          <select
                            value={layer.blendMode}
                            onChange={event => handleUpdateLayer(layer.id, { blendMode: event.target.value })}
                            onClick={event => event.stopPropagation()}
                          >
                            {PAINT_BLEND_MODES.map(mode => (
                              <option key={mode.value} value={mode.value}>{mode.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </aside>
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
