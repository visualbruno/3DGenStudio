// Pure canvas/image helper functions for the Image Editor page.
// Extracted from ImageEditorPage.jsx — no component state, fully testable in isolation.

export function createLayerId() {
  return `image-layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function cloneCanvasElement(sourceCanvas) {
  if (!sourceCanvas) return null
  const cloned = document.createElement('canvas')
  cloned.width = sourceCanvas.width
  cloned.height = sourceCanvas.height
  cloned.getContext('2d').drawImage(sourceCanvas, 0, 0)
  return cloned
}

export function applyAdjustmentsToCanvas(sourceCanvas, settings) {
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

export function applyBlurSharpenToCanvas(sourceCanvas, settings) {
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

export function getValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'number') return 'number'
  if (parameter?.type === 'boolean') return 'boolean'
  return 'string'
}

export function normalizeWorkflowResult(result) {
  const list = Array.isArray(result) ? result : [result]
  const imageAsset = list.find(item => item?.type === 'image') || list[0]
  return imageAsset || null
}

export async function loadImageToCanvas(url, width, height) {
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

export async function canvasToPngFile(canvas, filename) {
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

// Whether any pixel of the canvas is painted (non-zero alpha). False for no canvas.
export function canvasHasPixels(canvas) {
  if (!canvas) return false
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true
  }
  return false
}

export function getMaskBoundingBox(canvas, padding = 0) {
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

export function cropCanvas(canvas, bounds) {
  if (!canvas || !bounds) return null
  const width = Math.max(1, bounds.right - bounds.left + 1)
  const height = Math.max(1, bounds.bottom - bounds.top + 1)
  const cropped = document.createElement('canvas')
  cropped.width = width
  cropped.height = height
  cropped.getContext('2d').drawImage(canvas, bounds.left, bounds.top, width, height, 0, 0, width, height)
  return cropped
}

export function createComfyMaskCanvas(sourceMaskCanvas, bounds = null) {
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
