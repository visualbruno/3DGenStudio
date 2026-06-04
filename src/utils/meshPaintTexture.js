// meshPaintTexture.js
// Pure helpers extracted from src/pages/MeshEditorPage.jsx (behaviour-preserving move).
// No React, no component state.

import * as THREE from 'three'

/**
 * Convert a screen-space brush radius (pixels) into the equivalent radius in
 * texture-canvas pixels, taking into account:
 *   1. Camera perspective: farther away → smaller footprint on the mesh.
 *   2. Local UV density of the hit face: how many texture pixels cover one
 *      world-space unit at the hit point.
 *
 * Falls back to `paintBrushSize` unchanged if any required data is missing.
 */
export function computePaintBrushTexturePx(paintBrushSize, camera, canvasHeight, intersection, textureWidth, textureHeight) {
  if (!camera || !intersection?.face || !intersection?.object) return paintBrushSize

  const geom = intersection.object.geometry
  if (!geom?.attributes?.position || !geom?.attributes?.uv) return paintBrushSize

  const pos = geom.attributes.position
  const uvAttr = geom.attributes.uv
  const { a, b, c } = intersection.face

  // World-space triangle vertices (applying the mesh's world transform).
  const mat = intersection.object.matrixWorld
  const vA = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mat)
  const vB = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mat)
  const vC = new THREE.Vector3().fromBufferAttribute(pos, c).applyMatrix4(mat)

  const worldArea = new THREE.Vector3()
    .crossVectors(vB.clone().sub(vA), vC.clone().sub(vA))
    .length() * 0.5
  if (worldArea <= 0) return paintBrushSize

  // UV-space triangle area in texture pixels.
  const uvA = new THREE.Vector2().fromBufferAttribute(uvAttr, a)
  const uvB = new THREE.Vector2().fromBufferAttribute(uvAttr, b)
  const uvC = new THREE.Vector2().fromBufferAttribute(uvAttr, c)
  const uvEdge1x = (uvB.x - uvA.x) * textureWidth
  const uvEdge1y = (uvB.y - uvA.y) * textureHeight
  const uvEdge2x = (uvC.x - uvA.x) * textureWidth
  const uvEdge2y = (uvC.y - uvA.y) * textureHeight
  const uvArea = Math.abs(uvEdge1x * uvEdge2y - uvEdge1y * uvEdge2x) * 0.5
  if (uvArea <= 0) return paintBrushSize

  // Texture pixels per world unit at the hit face.
  const uvDensity = Math.sqrt(uvArea / worldArea)

  // World units per screen pixel at the hit distance.
  const distance = camera.position.distanceTo(intersection.point)
  const fovRad = (camera.fov || 50) * Math.PI / 180
  const worldHeightAtDistance = 2 * Math.tan(fovRad / 2) * distance
  if (worldHeightAtDistance <= 0) return paintBrushSize
  const worldUnitsPerScreenPx = worldHeightAtDistance / Math.max(1, canvasHeight)

  return Math.max(1, paintBrushSize * worldUnitsPerScreenPx * uvDensity)
}

/**
 * Convert a user-facing brush angle (defined in screen/canvas space) into the
 * equivalent UV-space stamp angle for the currently hit triangle.
 *
 * This keeps brush orientation visually stable on screen even when UV islands
 * are rotated/flipped relative to each other.
 */
export function computePaintBrushUvRotationDeg(requestedRotationDeg, camera, canvasWidth, canvasHeight, intersection) {
  if (!camera || !intersection?.face || !intersection?.object) return requestedRotationDeg
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) {
    return requestedRotationDeg
  }

  const geom = intersection.object.geometry
  if (!geom?.attributes?.position || !geom?.attributes?.uv) return requestedRotationDeg

  const pos = geom.attributes.position
  const uvAttr = geom.attributes.uv
  const { a, b, c } = intersection.face

  const mat = intersection.object.matrixWorld
  const vA = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mat)
  const vB = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mat)
  const vC = new THREE.Vector3().fromBufferAttribute(pos, c).applyMatrix4(mat)

  const uvA = new THREE.Vector2().fromBufferAttribute(uvAttr, a)
  const uvB = new THREE.Vector2().fromBufferAttribute(uvAttr, b)
  const uvC = new THREE.Vector2().fromBufferAttribute(uvAttr, c)

  const edge1 = vB.clone().sub(vA)
  const edge2 = vC.clone().sub(vA)
  const du1 = uvB.x - uvA.x
  const dv1 = uvB.y - uvA.y
  const du2 = uvC.x - uvA.x
  const dv2 = uvC.y - uvA.y
  const uvDet = du1 * dv2 - dv1 * du2
  if (Math.abs(uvDet) < 1e-10) return requestedRotationDeg

  // World delta for +U / +V on this face.
  const invUvDet = 1 / uvDet
  const tangent = edge1.clone().multiplyScalar(dv2).addScaledVector(edge2, -dv1).multiplyScalar(invUvDet)
  const bitangent = edge2.clone().multiplyScalar(du1).addScaledVector(edge1, -du2).multiplyScalar(invUvDet)
  if (tangent.lengthSq() < 1e-12 || bitangent.lengthSq() < 1e-12) return requestedRotationDeg

  const faceScale = Math.max(edge1.length(), edge2.length(), vC.distanceTo(vB), 1e-4)
  const sampleStep = faceScale * 0.05
  const hitPoint = intersection.point

  const projectToScreen = (point) => {
    const projected = point.clone().project(camera)
    return new THREE.Vector2(
      (projected.x * 0.5 + 0.5) * canvasWidth,
      (-projected.y * 0.5 + 0.5) * canvasHeight
    )
  }

  const p0 = projectToScreen(hitPoint)
  const pU = projectToScreen(hitPoint.clone().addScaledVector(tangent, sampleStep))
  const pV = projectToScreen(hitPoint.clone().addScaledVector(bitangent, sampleStep))
  const uScreen = pU.sub(p0)
  const vScreen = pV.sub(p0)

  // Jacobian from local UV axes to local screen axes.
  const m00 = uScreen.x
  const m01 = vScreen.x
  const m10 = uScreen.y
  const m11 = vScreen.y
  const screenDet = m00 * m11 - m01 * m10
  if (Math.abs(screenDet) < 1e-10) return requestedRotationDeg

  // Solve M * w = targetScreenDir, where w is the UV-space direction vector.
  const requestedRad = (requestedRotationDeg * Math.PI) / 180
  const tx = Math.cos(requestedRad)
  const ty = Math.sin(requestedRad)
  const invScreenDet = 1 / screenDet
  const wx = (m11 * tx - m01 * ty) * invScreenDet
  const wy = (-m10 * tx + m00 * ty) * invScreenDet
  if (Math.abs(wx) < 1e-12 && Math.abs(wy) < 1e-12) return requestedRotationDeg

  return (Math.atan2(wy, wx) * 180) / Math.PI
}

export function pickGeneratedTextureAsset(generatedAssets = []) {
  if (!Array.isArray(generatedAssets) || generatedAssets.length === 0) {
    return null
  }

  const preferredAsset = generatedAssets.find(asset => {
    const descriptor = [
      asset?.outputKey,
      asset?.name,
      asset?.filename,
      asset?.filePath,
      asset?.metadata?.outputFilename
    ].join(' ').toLowerCase()

    return !/\b(mask|alpha|matte|preview|depth|normal)\b/.test(descriptor)
  })

  return preferredAsset || generatedAssets[0]
}

export function buildFramedProjectionCamera(sourceCamera, root, aspect = 1) {
  const projectionCamera = sourceCamera?.clone?.()
  if (!projectionCamera || !root) {
    return projectionCamera
  }

  if ('aspect' in projectionCamera && Number.isFinite(aspect) && aspect > 0) {
    projectionCamera.aspect = aspect
  }

  const bounds = new THREE.Box3().setFromObject(root)
  const sphere = bounds.getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(sphere?.radius || 1, 1e-3)
  const center = sphere?.center || new THREE.Vector3()
  const forward = new THREE.Vector3()
  projectionCamera.getWorldDirection(forward)

  const verticalFovRad = THREE.MathUtils.degToRad(
    projectionCamera.getEffectiveFOV?.() || projectionCamera.fov || 50
  )
  const horizontalFovRad = 2 * Math.atan(Math.tan(verticalFovRad / 2) * Math.max(0.01, aspect))
  // Perspective fit uses tan(FOV/2): using sin pushes the camera too far back.
  const distVertical = radius / Math.max(Math.tan(verticalFovRad / 2), 1e-4)
  const distHorizontal = radius / Math.max(Math.tan(horizontalFovRad / 2), 1e-4)
  const framedDistance = Math.max(distVertical, distHorizontal) * 1.03

  projectionCamera.position.copy(center).addScaledVector(forward, -framedDistance)
  projectionCamera.lookAt(center)
  projectionCamera.near = Math.max(0.001, framedDistance - radius * 2.2)
  projectionCamera.far = Math.max(projectionCamera.near + 1, framedDistance + radius * 4)
  projectionCamera.updateProjectionMatrix?.()
  projectionCamera.updateMatrixWorld?.(true)
  return projectionCamera
}

/**
 * Blend two texture canvases by opacity and add optional noise to the patched region
 * border to help break up seam artifacts. Writes the result into outputCanvas in-place.
 */
export function applyPatchBlendToCanvas(originalCanvas, patchedCanvas, outputCanvas, opacity, noise, sharpness, saturation, maskCanvas = null, featherRadius = 12) {
  const width = outputCanvas.width
  const height = outputCanvas.height
  const ctx = outputCanvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.globalAlpha = 1
  ctx.drawImage(originalCanvas, 0, 0)
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.drawImage(patchedCanvas, 0, 0)
  ctx.globalAlpha = 1

  if (noise > 0 || sharpness > 0 || saturation !== 1) {
    const origData = originalCanvas.getContext('2d').getImageData(0, 0, width, height).data
    const patchData = patchedCanvas.getContext('2d').getImageData(0, 0, width, height).data
    const pixelCount = width * height
    const hardMask = new Uint8Array(pixelCount)

    // Detect patch pixels (difference between patched and original)
    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 4
      const delta = Math.abs(patchData[idx] - origData[idx]) +
        Math.abs(patchData[idx + 1] - origData[idx + 1]) +
        Math.abs(patchData[idx + 2] - origData[idx + 2])
      if (delta > 4) hardMask[i] = 1
    }

    // --- Noise: only in the feathered transition area (outside the sharp mask) ---
    if (noise > 0 && maskCanvas) {
      // Get the gradient mask that represents the feather falloff (peak at edge, decays outward)
      const gradientMask = generateBlurBorderGradient(maskCanvas, width, height, featherRadius)

      // Also get the sharp mask (where the original paint is solid white)
      const sharpMaskCanvas = document.createElement('canvas')
      sharpMaskCanvas.width = width
      sharpMaskCanvas.height = height
      const sharpCtx = sharpMaskCanvas.getContext('2d')
      sharpCtx.drawImage(maskCanvas, 0, 0, width, height)
      const sharpData = sharpCtx.getImageData(0, 0, width, height).data

      const outImg = ctx.getImageData(0, 0, width, height)
      const out = outImg.data

      for (let i = 0; i < pixelCount; i++) {
        const gradient = gradientMask[i]
        if (gradient <= 0.01) continue

        // Only apply noise outside the solid mask (alpha < 128) – i.e., in the transition zone
        const sharpAlpha = sharpData[i * 4 + 3]
        if (sharpAlpha > 128) continue  // inside the original mask, no seam noise needed

        // Noise amplitude: max 12 per channel when noise=32, scaled by gradient
        const amp = (noise / 32) * 12 * gradient
        const n = (Math.random() * 2 - 1) * amp
        const idx = i * 4
        out[idx] = Math.max(0, Math.min(255, out[idx] + n))
        out[idx + 1] = Math.max(0, Math.min(255, out[idx + 1] + n))
        out[idx + 2] = Math.max(0, Math.min(255, out[idx + 2] + n))
      }
      ctx.putImageData(outImg, 0, 0)
    }

    // --- Sharpness and saturation (unchanged, applied to whole patch area) ---
    if (sharpness > 0 || saturation !== 1) {
      let imgData = ctx.getImageData(0, 0, width, height)
      imgData = processPatchImage(imgData, sharpness, saturation, hardMask)
      ctx.putImageData(imgData, 0, 0)
    }
  }
}

/**
 * Replicates ComfyUI's GrowMaskWithBlur logic to find the exact border.
 * Flattens transparency against white to ensure the blur creates a measurable gradient.
 */
export function generateBlurBorderGradient(sourceMaskCanvas, targetWidth, targetHeight, blurRadius = 12) {
  const tempCanvas = document.createElement('canvas')
  tempCanvas.width = targetWidth
  tempCanvas.height = targetHeight
  const tempCtx = tempCanvas.getContext('2d')

  // Black background, draw white mask
  tempCtx.fillStyle = '#000000'
  tempCtx.fillRect(0, 0, targetWidth, targetHeight)
  tempCtx.drawImage(sourceMaskCanvas, 0, 0, targetWidth, targetHeight)

  const sharpData = tempCtx.getImageData(0, 0, targetWidth, targetHeight).data

  const blurCanvas = document.createElement('canvas')
  blurCanvas.width = targetWidth
  blurCanvas.height = targetHeight
  const blurCtx = blurCanvas.getContext('2d')
  blurCtx.filter = `blur(${blurRadius}px)`
  blurCtx.drawImage(tempCanvas, 0, 0)
  blurCtx.filter = 'none'

  const blurData = blurCtx.getImageData(0, 0, targetWidth, targetHeight).data
  const pixelCount = targetWidth * targetHeight
  const gradientMask = new Float32Array(pixelCount)

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4
    const sharpVal = sharpData[idx] / 255
    const blurVal = blurData[idx] / 255
    let delta = blurVal - sharpVal
    if (delta > 0.01) {
      // Normalize so the peak edge is ~1.0 and falls off
      gradientMask[i] = Math.min(1.0, delta * 2.0)
    }
  }
  return gradientMask
}

export function processPatchImage(imageData, sharpness = 0, saturation = 1, patchMask = null) {
  const { data, width, height } = imageData;

  // --- SATURATION ---
  for (let i = 0; i < data.length; i += 4) {
    // If a mask is provided, skip pixels that are not part of the patch
    if (patchMask && !patchMask[i / 4]) {
      continue;
    }

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const gray = 0.299 * r + 0.587 * g + 0.114 * b;

    data[i] = gray + (r - gray) * saturation;
    data[i + 1] = gray + (g - gray) * saturation;
    data[i + 2] = gray + (b - gray) * saturation;
  }

  // --- SHARPEN (simple unsharp mask) ---
  if (sharpness > 0.001) {
    const copy = new Uint8ClampedArray(data);

    const kernel = [
      0, -1, 0,
      -1, 5, -1,
      0, -1, 0
    ];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        // If a mask is provided, skip pixels that are not part of the patch
        const pixelIndex = y * width + x;
        if (patchMask && !patchMask[pixelIndex]) {
          continue;
        }

        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let ki = 0;

          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const px = x + kx;
              const py = y + ky;
              const idx = (py * width + px) * 4 + c;
              sum += copy[idx] * kernel[ki++];
            }
          }

          const i = (y * width + x) * 4 + c;
          data[i] = copy[i] + (sum - copy[i]) * sharpness;
        }
      }
    }
  }

  return imageData;
}

export function createFullAlphaMaskCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  return canvas
}

export function createProjectionCropMaskCanvasFromPatch(patchCanvas, cropBorder = 0) {
  const width = patchCanvas?.width || 0
  const height = patchCanvas?.height || 0
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  if (!width || !height || !patchCanvas) {
    return canvas
  }

  const context = canvas.getContext('2d')
  const patchContext = patchCanvas.getContext('2d', { willReadFrequently: true }) || patchCanvas.getContext('2d')
  const patchData = patchContext.getImageData(0, 0, width, height).data
  const out = context.createImageData(width, height)
  const outData = out.data
  const pixelCount = width * height
  const mask = new Uint8Array(pixelCount)
  let alphaCoverage = 0

  for (let i = 0; i < pixelCount; i += 1) {
    alphaCoverage += patchData[i * 4 + 3]
  }

  let borderCount = 0
  let borderMaxSum = 0
  let borderMinSum = 0
  const sampleBorderPixel = (x, y) => {
    const idx = (y * width + x) * 4
    const r = patchData[idx]
    const g = patchData[idx + 1]
    const b = patchData[idx + 2]
    borderMaxSum += Math.max(r, g, b)
    borderMinSum += Math.min(r, g, b)
    borderCount += 1
  }

  for (let x = 0; x < width; x += 1) {
    sampleBorderPixel(x, 0)
    if (height > 1) {
      sampleBorderPixel(x, height - 1)
    }
  }
  for (let y = 1; y + 1 < height; y += 1) {
    sampleBorderPixel(0, y)
    if (width > 1) {
      sampleBorderPixel(width - 1, y)
    }
  }

  const borderMeanMax = borderCount > 0 ? borderMaxSum / borderCount : 0
  const borderMeanMin = borderCount > 0 ? borderMinSum / borderCount : 0
  const darkMatteLikely = borderMeanMax <= 80 && borderMeanMin <= 52

  // If the generated view has a useful alpha channel, use it directly.
  // Otherwise remove black matte background by flood-filling from borders.
  const alphaIsMeaningful = alphaCoverage > pixelCount * 20
  if (alphaIsMeaningful) {
    for (let i = 0; i < pixelCount; i += 1) {
      // Use a slightly stricter alpha gate to suppress fringe antialiasing.
      mask[i] = patchData[i * 4 + 3] > 20 ? 1 : 0
    }
  } else {
    const darkThreshold = Math.max(18, Math.min(64, Math.round(borderMeanMax + 16)))
    const queue = new Int32Array(pixelCount)
    const isBackground = new Uint8Array(pixelCount)
    let queueHead = 0
    let queueTail = 0

    const isDarkMattePixel = (index) => {
      const idx = index * 4
      const r = patchData[idx]
      const g = patchData[idx + 1]
      const b = patchData[idx + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      return max <= darkThreshold && (max - min) <= 24
    }

    const trySeed = (x, y) => {
      const i = y * width + x
      if (isBackground[i] || !isDarkMattePixel(i)) {
        return
      }
      isBackground[i] = 1
      queue[queueTail] = i
      queueTail += 1
    }

    for (let x = 0; x < width; x += 1) {
      trySeed(x, 0)
      if (height > 1) {
        trySeed(x, height - 1)
      }
    }
    for (let y = 1; y + 1 < height; y += 1) {
      trySeed(0, y)
      if (width > 1) {
        trySeed(width - 1, y)
      }
    }

    while (queueHead < queueTail) {
      const current = queue[queueHead]
      queueHead += 1
      const x = current % width
      const y = Math.floor(current / width)

      const visit = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          return
        }
        const ni = ny * width + nx
        if (isBackground[ni] || !isDarkMattePixel(ni)) {
          return
        }
        isBackground[ni] = 1
        queue[queueTail] = ni
        queueTail += 1
      }

      visit(x - 1, y)
      visit(x + 1, y)
      visit(x, y - 1)
      visit(x, y + 1)
    }

    for (let i = 0; i < pixelCount; i += 1) {
      mask[i] = isBackground[i] ? 0 : 1
    }
  }

  let borderPx = Math.max(0, Math.floor(cropBorder || 0))

  // If the generated image appears matted against a dark background,
  // remove dark low-chroma pixels only on the silhouette ring.
  if (darkMatteLikely) {
    const removed = new Uint8Array(pixelCount)
    const maxThreshold = Math.max(24, Math.min(96, Math.round(borderMeanMax + 26)))
    const chromaThreshold = 28

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        if (!mask[i]) {
          continue
        }

        let touchesOutside = false
        if (x === 0 || !mask[i - 1]) touchesOutside = true
        if (!touchesOutside && x + 1 >= width) touchesOutside = true
        if (!touchesOutside && x + 1 < width && !mask[i + 1]) touchesOutside = true
        if (!touchesOutside && (y === 0 || !mask[i - width])) touchesOutside = true
        if (!touchesOutside && y + 1 >= height) touchesOutside = true
        if (!touchesOutside && y + 1 < height && !mask[i + width]) touchesOutside = true

        if (!touchesOutside) {
          continue
        }

        const idx = i * 4
        const r = patchData[idx]
        const g = patchData[idx + 1]
        const b = patchData[idx + 2]
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        if (max <= maxThreshold && (max - min) <= chromaThreshold) {
          removed[i] = 1
        }
      }
    }

    for (let i = 0; i < pixelCount; i += 1) {
      if (removed[i]) {
        mask[i] = 0
      }
    }

    // Add a tiny automatic erosion in dark-matte cases so users do not need
    // to bump crop border manually for common black fringe artifacts.
    borderPx = Math.max(borderPx, 1)
  }

  // Gradient-aware silhouette ring suppression:
  // If a faint matte line remains, reject only the first 1-2 interior pixels
  // where we detect a strong border->interior brightness jump. This keeps
  // interior detail intact while cleaning seam-colored halos.
  {
    const ring1 = new Uint8Array(pixelCount)
    const ring2 = new Uint8Array(pixelCount)

    const touchesOutside4 = (x, y) => {
      const i = y * width + x
      if (!mask[i]) {
        return false
      }
      if (x === 0 || !mask[i - 1]) return true
      if (x + 1 >= width || !mask[i + 1]) return true
      if (y === 0 || !mask[i - width]) return true
      if (y + 1 >= height || !mask[i + width]) return true
      return false
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        if (mask[i] && touchesOutside4(x, y)) {
          ring1[i] = 1
        }
      }
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        if (!mask[i] || ring1[i]) {
          continue
        }

        let nearRing1 = false
        for (let oy = -1; oy <= 1 && !nearRing1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (!ox && !oy) {
              continue
            }
            const nx = x + ox
            const ny = y + oy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              continue
            }
            if (ring1[ny * width + nx]) {
              nearRing1 = true
              break
            }
          }
        }

        if (nearRing1) {
          ring2[i] = 1
        }
      }
    }

    const removed = new Uint8Array(pixelCount)
    const maxDark = Math.max(30, Math.min(124, Math.round(borderMeanMax + 34)))
    const maxChroma = 30
    const gradientThreshold = darkMatteLikely ? 7 : 10
    const contrastThreshold = darkMatteLikely ? 12 : 16

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        if (!mask[i] || (!ring1[i] && !ring2[i])) {
          continue
        }

        const idx = i * 4
        const r = patchData[idx]
        const g = patchData[idx + 1]
        const b = patchData[idx + 2]
        const selfMax = Math.max(r, g, b)
        const selfMin = Math.min(r, g, b)
        const selfLuma = 0.299 * r + 0.587 * g + 0.114 * b

        if (selfMax > maxDark || (selfMax - selfMin) > maxChroma) {
          continue
        }

        let insideCount = 0
        let insideLumaSum = 0
        let insideLumaMax = 0

        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (!ox && !oy) {
              continue
            }
            const nx = x + ox
            const ny = y + oy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              continue
            }
            const ni = ny * width + nx
            if (!mask[ni]) {
              continue
            }
            // Compare against a more interior sample so we only suppress true
            // edge halos, not legitimate dark texture detail.
            if (ring1[ni]) {
              continue
            }

            const nIdx = ni * 4
            const nr = patchData[nIdx]
            const ng = patchData[nIdx + 1]
            const nb = patchData[nIdx + 2]
            const nl = 0.299 * nr + 0.587 * ng + 0.114 * nb
            insideLumaSum += nl
            insideLumaMax = Math.max(insideLumaMax, nl)
            insideCount += 1
          }
        }

        if (insideCount < 2) {
          continue
        }

        const insideLumaMean = insideLumaSum / insideCount
        const meanGradient = insideLumaMean - selfLuma
        const maxContrast = insideLumaMax - selfLuma

        if (meanGradient >= gradientThreshold || maxContrast >= contrastThreshold) {
          removed[i] = 1
        }
      }
    }

    for (let i = 0; i < pixelCount; i += 1) {
      if (removed[i]) {
        mask[i] = 0
      }
    }
  }

  if (borderPx > 0) {
    // Erode along the alpha silhouette border (not square bounds) using a
    // chamfer distance transform from transparent -> opaque pixels.
    const ORTHO = 10
    const DIAG = 14
    const INF = 1 << 28
    const distance = new Int32Array(pixelCount)

    for (let i = 0; i < pixelCount; i += 1) {
      distance[i] = mask[i] ? INF : 0
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        let best = distance[i]
        if (x > 0) best = Math.min(best, distance[i - 1] + ORTHO)
        if (y > 0) best = Math.min(best, distance[i - width] + ORTHO)
        if (x > 0 && y > 0) best = Math.min(best, distance[i - width - 1] + DIAG)
        if (x + 1 < width && y > 0) best = Math.min(best, distance[i - width + 1] + DIAG)
        distance[i] = best
      }
    }

    for (let y = height - 1; y >= 0; y -= 1) {
      for (let x = width - 1; x >= 0; x -= 1) {
        const i = y * width + x
        let best = distance[i]
        if (x + 1 < width) best = Math.min(best, distance[i + 1] + ORTHO)
        if (y + 1 < height) best = Math.min(best, distance[i + width] + ORTHO)
        if (x > 0 && y + 1 < height) best = Math.min(best, distance[i + width - 1] + DIAG)
        if (x + 1 < width && y + 1 < height) best = Math.min(best, distance[i + width + 1] + DIAG)
        distance[i] = best
      }
    }

    const borderCost = borderPx * ORTHO
    for (let i = 0; i < pixelCount; i += 1) {
      if (!mask[i]) {
        continue
      }
      if (distance[i] <= borderCost) {
        mask[i] = 0
      }
    }
  }

  for (let i = 0; i < pixelCount; i += 1) {
    if (!mask[i]) {
      continue
    }
    const idx = i * 4
    outData[idx] = 255
    outData[idx + 1] = 255
    outData[idx + 2] = 255
    outData[idx + 3] = 255
  }

  context.putImageData(out, 0, 0)
  return canvas
}
