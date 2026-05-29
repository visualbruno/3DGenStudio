import { Canvas, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { useNotifications } from '../context/NotificationContext'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import {
  bridgeSelectedHoleSegments,
  bridgeAndFillSelectedHole,
  deleteSelectedFaces,
  deleteSelectedVertices,
  exportGeometryToGlb,
  fillHoleLoops,
  geometryFaceCount,
  getClosestVertexIndex,
  getGeometryHoleLoops,
  getFaceSelectionGeometry,
  getSelectedHoleLoops,
  getVertexSelectionPositions,
  loadEditableGeometryFromObject,
  mergeSelectedVertices,
  smoothSelectedVertices,
  subdivideSelectedFaces
} from '../utils/meshEditor'
import {
  buildAssetUrl,
  canvasToFile,
  captureTexturedMeshView,
  clearCanvas,
  createCanvasTexture,
  createExecutionId,
  createTexturePaintWorkflowDraft,
  cropCanvas,
  drawCanvasStroke,
  drawUvStroke,
  exportTexturedMeshToGlb,
  getMaskBoundingBox,
  getTextureKeyFromMaterial,
  getUvIslandHitInfo,
  getWorkflowValueType,
  loadMeshRootFromUrl,
  loadTexturableMeshFromRoot,
  mapUvToCanvasPoint,
  updateCanvasTexture,
  accumulateProjectedPatch,
  captureTextureMaskScreenView,
  finalizeProjectedPatch,
  generateOrbitalCameras,
  estimateMaskOrbitTarget
} from '../utils/meshTexturing'
import {
  applyBrushTextureWeights as applySculptBrushTextureWeights,
  applyClay as applySculptClay,
  applyFlatten as applySculptFlatten,
  applyGrab as applySculptGrab,
  applyInflate as applySculptInflate,
  applyPinch as applySculptPinch,
  applySmooth as applySculptSmooth,
  applyStandard as applySculptStandard,
  createSculptContext,
  ensureGrid as ensureSculptGrid,
  filterFrontFacing as sculptFilterFrontFacing,
  finalizeStroke as finalizeSculptStroke,
  getSymmetryMirrors as sculptGetSymmetryMirrors,
  incrementalRecomputeNormals as sculptIncrementalNormals,
  invalidateGrid as invalidateSculptGrid,
  queryRadius as sculptQueryRadius,
  raycastMesh as sculptRaycastMesh,
  restorePositions as sculptRestorePositions,
  snapshotPositions as sculptSnapshotPositions
} from '../utils/meshSculpt'
import './MeshEditorPage.css'
import AssetSelectorModal from '../components/AssetSelectorModal';
import SculptToolsPanel from '../components/SculptToolsPanel';

const AUTO_PROJECTION_SEAM_SAFE_CROP_PX = 0
const AUTO_PROJECTION_SEAM_SAFE_BLEND_PX = 0

function drawProjectionCheckerboard(context, width, height) {
  if (!context || !width || !height) {
    return
  }

  const cellSize = Math.max(16, Math.round(width / 64))
  for (let cy = 0; cy < height; cy += cellSize) {
    for (let cx = 0; cx < width; cx += cellSize) {
      context.fillStyle = (((cx / cellSize) + (cy / cellSize)) % 2 === 0) ? '#d4d4d4' : '#bcbcbc'
      context.fillRect(cx, cy, cellSize, cellSize)
    }
  }
}

function computeProjectionDistanceInsideMask(mask, width, height) {
  const pixelCount = width * height
  const dist = new Int32Array(pixelCount)
  if (!mask || mask.length !== pixelCount || !width || !height) {
    return dist
  }

  const INF = 1 << 29
  const ORTHO = 10
  const DIAG = 14

  for (let i = 0; i < pixelCount; i += 1) {
    dist[i] = mask[i] > 0 ? INF : 0
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      let best = dist[i]
      if (x > 0) best = Math.min(best, dist[i - 1] + ORTHO)
      if (y > 0) best = Math.min(best, dist[i - width] + ORTHO)
      if (x > 0 && y > 0) best = Math.min(best, dist[i - width - 1] + DIAG)
      if (x + 1 < width && y > 0) best = Math.min(best, dist[i - width + 1] + DIAG)
      dist[i] = best
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x
      let best = dist[i]
      if (x + 1 < width) best = Math.min(best, dist[i + 1] + ORTHO)
      if (y + 1 < height) best = Math.min(best, dist[i + width] + ORTHO)
      if (x > 0 && y + 1 < height) best = Math.min(best, dist[i + width - 1] + DIAG)
      if (x + 1 < width && y + 1 < height) best = Math.min(best, dist[i + width + 1] + DIAG)
      dist[i] = best
    }
  }

  return dist
}

function buildProjectionOverlapWeights(previousCoverage, previousSharedCoverage, layerCoverage, layerSharedMask, width, height, blendPixels = 0) {
  const pixelCount = width * height
  if (
    !previousCoverage
    || !layerCoverage
    || previousCoverage.length !== pixelCount
    || layerCoverage.length !== pixelCount
  ) {
    return null
  }

  const weights = new Float32Array(pixelCount)
  const radius = Math.max(0, Number(blendPixels) || 0)
  const maxOverlapInfluence = 0.68

  if (radius <= 0) {
    for (let i = 0; i < pixelCount; i += 1) {
      if (!layerCoverage[i]) {
        weights[i] = 0
      } else if (previousCoverage[i] <= 0) {
        weights[i] = 1
      } else if ((previousSharedCoverage?.[i] || 0) > 0 || (layerSharedMask?.[i] || 0) > 0) {
        weights[i] = maxOverlapInfluence
      } else {
        weights[i] = 0
      }
    }
    return weights
  }

  const distToUntouched = computeProjectionDistanceInsideMask(previousCoverage, width, height)

  const seamRadiusPx = Math.max(1, Math.min(6, Math.round(Math.max(1, radius) * 0.6)))
  const seamRadiusCost = Math.max(10, seamRadiusPx * 10)
  const seamDenom = seamRadiusCost + 1

  for (let i = 0; i < pixelCount; i += 1) {
    if (!layerCoverage[i]) {
      weights[i] = 0
      continue
    }

    if (previousCoverage[i] <= 0) {
      weights[i] = 1
      continue
    }

    if ((previousSharedCoverage?.[i] || 0) <= 0 && (layerSharedMask?.[i] || 0) <= 0) {
      weights[i] = 0
      continue
    }

    const dUntouched = distToUntouched[i]
    if (dUntouched > seamRadiusCost) {
      weights[i] = 0
      continue
    }

    const t = Math.max(0, Math.min(1, 1 - dUntouched / seamDenom))
    const eased = t * t * (3 - 2 * t)
    weights[i] = Math.min(maxOverlapInfluence, eased)
  }

  return weights
}

function buildProjectionCoverageMaskFromBakedAlpha(alphaBytes, width, height, {
  minAlpha = 1,
  stitchEdges = true
} = {}) {
  const pixelCount = width * height

  const mask = new Uint8Array(pixelCount)
  if (!alphaBytes || alphaBytes.length !== pixelCount || !width || !height) {
    return mask
  }

  // Keep most anti-aliased edge texels so projected borders stay smooth.

  // Tiny pinholes are still patched in a second pass below.
  for (let i = 0; i < pixelCount; i += 1) {
    mask[i] = alphaBytes[i] > minAlpha ? 1 : 0
  }

  if (!stitchEdges) {
    return mask
  }

  const next = mask.slice()
  const has = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return 0
    }
    return mask[y * width + x]
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      if (mask[i]) {
        continue
      }

      // Fill small 1px holes and stitch anti-aliased edge fragments so the
      // overlap mask does not create zipper seams.
      const ortho = has(x - 1, y) + has(x + 1, y) + has(x, y - 1) + has(x, y + 1)
      const diag = has(x - 1, y - 1) + has(x + 1, y - 1) + has(x - 1, y + 1) + has(x + 1, y + 1)
      if (ortho >= 3 || (ortho >= 2 && diag >= 2)) {
        next[i] = 1
      }
    }
  }

  return next
}

function buildProjectionSharedSeamMask(coverageMask, ownershipMask, width, height, seamPixels = 0) {
  const pixelCount = width * height
  const sharedMask = new Uint8Array(pixelCount)
  if (
    !coverageMask
    || !ownershipMask
    || coverageMask.length !== pixelCount
    || ownershipMask.length !== pixelCount
    || !width
    || !height
  ) {
    return sharedMask
  }

  const seamRadiusPx = Math.max(0, Math.min(8, Math.round(Number(seamPixels) || 0)))
  if (seamRadiusPx <= 0) {
    return sharedMask
  }

  const seamRadiusCost = Math.max(10, seamRadiusPx * 10)
  const distToOutsideOwnership = computeProjectionDistanceInsideMask(ownershipMask, width, height)

  for (let i = 0; i < pixelCount; i += 1) {
    if (!coverageMask[i]) {
      continue
    }

    if (!ownershipMask[i] || distToOutsideOwnership[i] <= seamRadiusCost) {
      sharedMask[i] = 1
    }
  }

  return sharedMask
}

function buildProjectionConfidenceMap(accumulatedWeight, coverageMask, alphaBytes) {
  const pixelCount = accumulatedWeight?.length || 0
  const confidence = new Float32Array(pixelCount)
  if (!accumulatedWeight || !pixelCount) {
    return confidence
  }

  for (let i = 0; i < pixelCount; i += 1) {
    if (coverageMask && !coverageMask[i]) {
      continue
    }

    const weight = Math.max(0, Number(accumulatedWeight[i]) || 0)
    if (weight <= 1e-6) {
      if (alphaBytes && alphaBytes[i] > 0) {
        // UV gap-filled fringes have 0 accumulated weight but are crucial to prevent black cracks.
        // We restore their confidence using the dilated alpha.
        confidence[i] = alphaBytes[i] / 255
      }
      continue
    }

    confidence[i] = Math.max(0, Math.min(1, 1 - Math.exp(-weight)))
  }

  return confidence
}

function applyProjectionEdgeBleed(canvas, passes = 1) {
  if (!canvas?.width || !canvas?.height) {
    return
  }

  const width = canvas.width
  const height = canvas.height
  const context = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d')
  if (!context) {
    return
  }

  let imageData = context.getImageData(0, 0, width, height)
  let data = imageData.data
  const totalPasses = Math.max(1, Math.min(2, Math.floor(passes)))

  for (let pass = 0; pass < totalPasses; pass += 1) {
    const source = new Uint8ClampedArray(data)
    let changed = false

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x
        const offset = index * 4
        const a = source[offset + 3]
        if (a > 0) {
          continue
        }

        let sumR = 0
        let sumG = 0
        let sumB = 0
        let sumA = 0
        let count = 0

        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy
          if (ny < 0 || ny >= height) {
            continue
          }

          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue
            }

            const nx = x + dx
            if (nx < 0 || nx >= width) {
              continue
            }

            const nOffset = (ny * width + nx) * 4
            const na = source[nOffset + 3]
            if (na <= 0) {
              continue
            }

            sumR += source[nOffset]
            sumG += source[nOffset + 1]
            sumB += source[nOffset + 2]
            sumA += na
            count += 1
          }
        }

        if (count > 0) {
          data[offset] = Math.round(sumR / count)
          data[offset + 1] = Math.round(sumG / count)
          data[offset + 2] = Math.round(sumB / count)
          data[offset + 3] = Math.max(1, Math.min(255, Math.round((sumA / count) * 0.38)))
          changed = true
        }
      }
    }

    if (!changed) {
      break
    }
  }

  context.putImageData(imageData, 0, 0)
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function blendRgbByMode(mode, dstR, dstG, dstB, srcR, srcG, srcB) {
  const m = String(mode || 'source-over').toLowerCase()
  if (m === 'multiply') {
    return [
      (dstR * srcR) / 255,
      (dstG * srcG) / 255,
      (dstB * srcB) / 255
    ]
  }

  if (m === 'screen') {
    return [
      255 - ((255 - dstR) * (255 - srcR)) / 255,
      255 - ((255 - dstG) * (255 - srcG)) / 255,
      255 - ((255 - dstB) * (255 - srcB)) / 255
    ]
  }

  if (m === 'overlay') {
    const overlayChannel = (d, s) => {
      if (d < 128) {
        return (2 * d * s) / 255
      }
      return 255 - (2 * (255 - d) * (255 - s)) / 255
    }
    return [overlayChannel(dstR, srcR), overlayChannel(dstG, srcG), overlayChannel(dstB, srcB)]
  }

  if (m === 'darken') {
    return [Math.min(dstR, srcR), Math.min(dstG, srcG), Math.min(dstB, srcB)]
  }

  if (m === 'lighten') {
    return [Math.max(dstR, srcR), Math.max(dstG, srcG), Math.max(dstB, srcB)]
  }

  // Normal / source-over fallback.
  return [srcR, srcG, srcB]
}

function compositeProjectionLayerIntoImageData({
  outputData,
  layerData,
  layerCoverage,
  ownershipMask,
  sharedMask,
  layerConfidence,
  overlapWeights,
  composedCoverage,
  composedSharedCoverage,
  composedConfidence,
  seamAccumColor,
  seamAccumWeight,
  opacity,
  blendMode
}) {
  if (
    !outputData
    || !layerData
    || !layerCoverage
    || !overlapWeights
    || !composedCoverage
    || !composedSharedCoverage
    || !composedConfidence
    || !seamAccumColor
    || !seamAccumWeight
  ) {
    return 0
  }

  const pixelCount = layerCoverage.length
  let contributed = 0
  const op = clamp01(Number(opacity) || 0)

  if (op <= 0) {
    return 0
  }

  for (let i = 0; i < pixelCount; i += 1) {
    if (!layerCoverage[i]) {
      continue
    }

    const w = overlapWeights[i]
    if (w <= 1e-6) {
      continue
    }

    const alpha = clamp01(op * w)
    if (alpha <= 1e-6) {
      continue
    }

    const j = i * 4
    const dstR = outputData[j]
    const dstG = outputData[j + 1]
    const dstB = outputData[j + 2]
    const srcR = layerData[j]
    const srcG = layerData[j + 1]
    const srcB = layerData[j + 2]
    const srcAlpha = layerData[j + 3] / 255
    if (srcAlpha <= 1e-4) {
      continue
    }

    const [blendR, blendG, blendB] = blendRgbByMode(blendMode, dstR, dstG, dstB, srcR, srcG, srcB)
    const effectiveAlpha = clamp01(alpha * srcAlpha)
    if (effectiveAlpha <= 1e-6) {
      continue
    }
    const confidence = Math.max(0.05, Math.min(1, layerConfidence?.[i] || effectiveAlpha))

    const shouldAccumulateShared = Boolean(
      sharedMask?.[i]
      && (composedCoverage[i] > 0 || composedSharedCoverage[i] > 0)
    )

    if (shouldAccumulateShared) {
      if (seamAccumWeight[i] <= 1e-6) {
        const baseConfidence = Math.max(0.05, Math.min(1, composedConfidence[i] || 0.05))
        seamAccumColor[j] = dstR * baseConfidence
        seamAccumColor[j + 1] = dstG * baseConfidence
        seamAccumColor[j + 2] = dstB * baseConfidence
        seamAccumWeight[i] = baseConfidence
      }

      const seamWeight = effectiveAlpha * confidence
      seamAccumColor[j] += blendR * seamWeight
      seamAccumColor[j + 1] += blendG * seamWeight
      seamAccumColor[j + 2] += blendB * seamWeight
      seamAccumWeight[i] += seamWeight
      composedSharedCoverage[i] = 1
      composedConfidence[i] = Math.max(composedConfidence[i], confidence)
      contributed += 1
      continue
    }

    outputData[j] = Math.round(dstR * (1 - effectiveAlpha) + blendR * effectiveAlpha)
    outputData[j + 1] = Math.round(dstG * (1 - effectiveAlpha) + blendG * effectiveAlpha)
    outputData[j + 2] = Math.round(dstB * (1 - effectiveAlpha) + blendB * effectiveAlpha)
    outputData[j + 3] = 255
    composedConfidence[i] = Math.max(composedConfidence[i], confidence)

    if (sharedMask?.[i]) {
      composedSharedCoverage[i] = 1
    }

    if (ownershipMask?.[i]) {
      composedCoverage[i] = 1
      if (!sharedMask?.[i]) {
        composedSharedCoverage[i] = 0
      }
    }

    contributed += 1
  }

  return contributed
}

function resolveProjectionSharedSeams(outputData, seamAccumColor, seamAccumWeight) {
  if (!outputData || !seamAccumColor || !seamAccumWeight) {
    return
  }

  for (let i = 0; i < seamAccumWeight.length; i += 1) {
    const weight = seamAccumWeight[i]
    if (weight <= 1e-6) {
      continue
    }

    const j = i * 4
    outputData[j] = Math.round(seamAccumColor[j] / weight)
    outputData[j + 1] = Math.round(seamAccumColor[j + 1] / weight)
    outputData[j + 2] = Math.round(seamAccumColor[j + 2] / weight)
    outputData[j + 3] = 255
  }
}

function resolveProjectionLayersIntoImageData(outputData, layerSnapshots, width, height) {
  if (!outputData || !Array.isArray(layerSnapshots) || layerSnapshots.length === 0 || !width || !height) {
    return
  }

  const pixelCount = width * height

  for (let i = 0; i < pixelCount; i += 1) {
    const j = i * 4
    const baseR = outputData[j]
    const baseG = outputData[j + 1]
    const baseB = outputData[j + 2]

    let accumR = 0
    let accumG = 0
    let accumB = 0
    let accumWeight = 0
    let finalMaxOpacity = 0

    for (let layerIndex = 0; layerIndex < layerSnapshots.length; layerIndex += 1) {
      if (accumWeight >= 0.999) {
        break // Fully occluded by previous layers' weighted color
      }

      const layer = layerSnapshots[layerIndex]
      if (!layer?.coverageMask?.[i]) {
        continue
      }

      const srcAlpha = (layer.pixelData[j + 3] || 0) / 255
      if (srcAlpha <= 1e-4) {
        continue
      }

      // At seam pixels (boundary zone of the projection), fade towards the
      // underlying texture by scaling down this layer's effective opacity.
      // opacitySeams = 1 keeps the previous behavior (opaque seams).
      const seamFactor = layer.sharedSeamMask?.[i]
        ? clamp01(layer.opacitySeams ?? 1)
        : 1
      const effectiveLayerOpacity = clamp01((layer.opacity ?? 1) * seamFactor)
      const layerOpacity = clamp01(effectiveLayerOpacity * srcAlpha)

      // Use the pure 3D mathematically-derived confidence (based on facing angle and distance)
      let conf = layer.confidenceMap?.[i] || 0

      // A gentle curve to contrast the confidence slightly over the mesh curvature
      const smoothConf = conf * conf * (3 - 2 * conf)

      const mixWeight = smoothConf * layerOpacity
      if (mixWeight <= 1e-4) {
        continue
      }

      // Cascade priority: each layer gets the remaining unoccupied weight
      const factor = mixWeight * (1 - accumWeight)
      if (factor <= 1e-4) {
        continue
      }

      // The baked canvas stores color * blend (effectively premultiplied by the mask weight).
      // Divide by srcAlpha to recover the actual projection colour before blending.
      const invSrcAlpha = 1 / srcAlpha
      const srcR = Math.min(255, Math.round(layer.pixelData[j]     * invSrcAlpha))
      const srcG = Math.min(255, Math.round(layer.pixelData[j + 1] * invSrcAlpha))
      const srcB = Math.min(255, Math.round(layer.pixelData[j + 2] * invSrcAlpha))
      const [blendR, blendG, blendB] = blendRgbByMode(layer.blendMode, baseR, baseG, baseB, srcR, srcG, srcB)

      accumR += blendR * factor
      accumG += blendG * factor
      accumB += blendB * factor
      accumWeight += factor

      // Any covered pixel must be fully opaque — using srcAlpha here caused
      // the feathered mask edge to bleed the checkerboard through as a white
      // gradient at projection silhouette boundaries.
      finalMaxOpacity = Math.max(finalMaxOpacity, effectiveLayerOpacity)
    }

    if (accumWeight > 0) {
      // 1. Normalize the color by the accumulated weight.
      // This mathematically eliminates the "white gradient" caused by overlapping soft seams
      // because we re-normalize the color instead of letting the checkerboard bleed through the transparency.
      const r = accumR / accumWeight
      const g = accumG / accumWeight
      const b = accumB / accumWeight

      // 2. The final opacity against the checkerboard is simply the strongest 2D alpha.
      // This guarantees that internal 3D-angle seams never become semi-transparent 
      // (which is exactly what caused the white checkerboard bleeding).
      const finalAlpha = Math.min(1.0, finalMaxOpacity)
      const invAlpha = Math.max(0, 1 - finalAlpha)

      outputData[j] = Math.round(baseR * invAlpha + r * finalAlpha)
      outputData[j + 1] = Math.round(baseG * invAlpha + g * finalAlpha)
      outputData[j + 2] = Math.round(baseB * invAlpha + b * finalAlpha)
      outputData[j + 3] = 255
    }
  }
}

async function applySeamPostProcessing(textureCanvas, layerSnapshots, seamThreshold, blurRadius, strength) {
  const w = textureCanvas.width
  const h = textureCanvas.height
  const pixelCount = w * h

  // Build per-pixel max confidence and coverage union from snapshot data
  const maxConf = new Float32Array(pixelCount)
  const anyCoverage = new Uint8Array(pixelCount)
  for (let li = 0; li < layerSnapshots.length; li++) {
    const layer = layerSnapshots[li]
    if (!layer?.coverageMask || !layer?.confidenceMap) continue
    for (let i = 0; i < pixelCount; i++) {
      if (layer.coverageMask[i]) {
        anyCoverage[i] = 1
        if (layer.confidenceMap[i] > maxConf[i]) maxConf[i] = layer.confidenceMap[i]
      }
    }
  }

  // Read current texture pixels
  const ctx = textureCanvas.getContext('2d')
  const origData = ctx.getImageData(0, 0, w, h)

  // Build a coverage-masked canvas (uncovered pixels are transparent)
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = w
  maskCanvas.height = h
  const maskCtx = maskCanvas.getContext('2d')
  const maskImg = maskCtx.createImageData(w, h)
  for (let i = 0; i < pixelCount; i++) {
    const j = i * 4
    if (anyCoverage[i]) {
      maskImg.data[j]     = origData.data[j]
      maskImg.data[j + 1] = origData.data[j + 1]
      maskImg.data[j + 2] = origData.data[j + 2]
      maskImg.data[j + 3] = 255
    }
    // else leave transparent (0)
  }
  maskCtx.putImageData(maskImg, 0, 0)

  // Blur with CSS filter — GPU-accelerated, spreads covered colours into seam zone
  const blurCanvas = document.createElement('canvas')
  blurCanvas.width = w
  blurCanvas.height = h
  const blurCtx = blurCanvas.getContext('2d')
  blurCtx.filter = `blur(${blurRadius}px)`
  blurCtx.drawImage(maskCanvas, 0, 0)
  blurCtx.filter = 'none'
  const blurData = blurCtx.getImageData(0, 0, w, h).data

  // Blend blurred colours into seam pixels (low-confidence covered pixels)
  const outData = new Uint8ClampedArray(origData.data)
  for (let i = 0; i < pixelCount; i++) {
    if (!anyCoverage[i]) continue
    const conf = maxConf[i]
    if (conf >= seamThreshold) continue  // well-textured pixel — leave alone
    const j = i * 4
    const blurAlpha = blurData[j + 3] / 255
    if (blurAlpha < 0.01) continue

    const t = 1 - conf / seamThreshold  // 0 at threshold edge, 1 at conf=0
    const smooth = t * t * (3 - 2 * t)
    const blendFactor = smooth * strength

    // Unpremultiply blur colour
    const bR = blurData[j]     / blurAlpha
    const bG = blurData[j + 1] / blurAlpha
    const bB = blurData[j + 2] / blurAlpha

    outData[j]     = Math.round(outData[j]     * (1 - blendFactor) + bR * blendFactor)
    outData[j + 1] = Math.round(outData[j + 1] * (1 - blendFactor) + bG * blendFactor)
    outData[j + 2] = Math.round(outData[j + 2] * (1 - blendFactor) + bB * blendFactor)
    // alpha stays 255
  }

  const outImg = new ImageData(outData, w, h)
  ctx.putImageData(outImg, 0, 0)
}

// 3D-aware hole filling. UV-space proximity is unreliable for AI-generated
// meshes where neighbouring UV islands can come from opposite sides of the
// body, so we fill each uncovered texel from the K nearest covered samples
// in 3D world space instead.
async function fillHolesPostProcessing(textureCanvas, layerSnapshots, texturableMesh, smoothness, onProgress) {
  const w = textureCanvas.width
  const h = textureCanvas.height
  const pixelCount = w * h

  // Build coverage union across all snapshots
  const anyCoverage = new Uint8Array(pixelCount)
  for (let li = 0; li < layerSnapshots.length; li++) {
    const layer = layerSnapshots[li]
    if (!layer?.coverageMask) continue
    for (let i = 0; i < pixelCount; i++) {
      if (layer.coverageMask[i]) anyCoverage[i] = 1
    }
  }

  // Gather textured meshes (every mesh under root with a uv attribute)
  const meshes = []
  if (texturableMesh?.root) {
    texturableMesh.root.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.geometry.attributes?.uv) {
        meshes.push(obj)
      }
    })
  }
  if (meshes.length === 0) return

  const textureConfig = texturableMesh.textureConfig
  const ctx = textureCanvas.getContext('2d')
  const origData = ctx.getImageData(0, 0, w, h)
  const outData = new Uint8ClampedArray(origData.data)

  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const uvA = new THREE.Vector2()
  const uvB = new THREE.Vector2()
  const uvC = new THREE.Vector2()

  // ── PASS 1: build samples (3D position + texture colour) from covered triangles ──
  const samples = []  // flat: [x, y, z, r, g, b, ...]

  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi]
    mesh.updateWorldMatrix(true, false)
    const matrixWorld = mesh.matrixWorld
    const geom = mesh.geometry
    const posAttr = geom.attributes.position
    const uvAttr = geom.attributes.uv
    const indexAttr = geom.index
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3

    for (let t = 0; t < triCount; t++) {
      const base = t * 3
      const i0 = indexAttr ? indexAttr.getX(base) : base
      const i1 = indexAttr ? indexAttr.getX(base + 1) : base + 1
      const i2 = indexAttr ? indexAttr.getX(base + 2) : base + 2

      vA.fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld)
      vB.fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld)
      vC.fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld)

      uvA.set(uvAttr.getX(i0), uvAttr.getY(i0))
      uvB.set(uvAttr.getX(i1), uvAttr.getY(i1))
      uvC.set(uvAttr.getX(i2), uvAttr.getY(i2))
      const pA = mapUvToCanvasPoint(uvA, w, h, textureConfig)
      const pB = mapUvToCanvasPoint(uvB, w, h, textureConfig)
      const pC = mapUvToCanvasPoint(uvC, w, h, textureConfig)

      const ucx = Math.floor((pA.x + pB.x + pC.x) / 3)
      const ucy = Math.floor((pA.y + pB.y + pC.y) / 3)
      if (ucx < 0 || ucx >= w || ucy < 0 || ucy >= h) continue

      const centroidIdx = ucy * w + ucx
      if (!anyCoverage[centroidIdx]) continue

      const j = centroidIdx * 4
      samples.push(
        (vA.x + vB.x + vC.x) / 3,
        (vA.y + vB.y + vC.y) / 3,
        (vA.z + vB.z + vC.z) / 3,
        origData.data[j],
        origData.data[j + 1],
        origData.data[j + 2]
      )
    }
  }

  const sampleCount = samples.length / 6
  if (sampleCount === 0) return

  // ── Build a spatial hash grid for fast 3D nearest-neighbour queries ──
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < sampleCount; i++) {
    const x = samples[i * 6], y = samples[i * 6 + 1], z = samples[i * 6 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const bboxSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6)
  const cellsPerDim = Math.max(4, Math.min(48, Math.round(Math.cbrt(sampleCount) * 1.4)))
  const cellSize = bboxSize / cellsPerDim
  const invCellSize = 1 / cellSize

  // Pack (cx, cy, cz) into a single int key: assumes |c| < 1024
  const hashCell = (cx, cy, cz) => ((cx + 512) << 20) | ((cy + 512) << 10) | (cz + 512)

  const grid = new Map()
  for (let i = 0; i < sampleCount; i++) {
    const cx = Math.floor((samples[i * 6]     - minX) * invCellSize)
    const cy = Math.floor((samples[i * 6 + 1] - minY) * invCellSize)
    const cz = Math.floor((samples[i * 6 + 2] - minZ) * invCellSize)
    const key = hashCell(cx, cy, cz)
    let cell = grid.get(key)
    if (!cell) { cell = []; grid.set(key, cell) }
    cell.push(i)
  }

  const K = Math.max(1, Math.min(32, Math.round(smoothness)))

  // Returns [r, g, b] for a query 3D point
  function findFillColor(qx, qy, qz) {
    const baseCx = Math.floor((qx - minX) * invCellSize)
    const baseCy = Math.floor((qy - minY) * invCellSize)
    const baseCz = Math.floor((qz - minZ) * invCellSize)

    let candidates = []
    let radius = 0
    const maxRadius = cellsPerDim * 2 + 4

    while (candidates.length < K && radius <= maxRadius) {
      if (radius === 0) {
        const cell = grid.get(hashCell(baseCx, baseCy, baseCz))
        if (cell) candidates.push(...cell)
      } else {
        // Add shells of cells at exactly this radius
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius) continue
              const cell = grid.get(hashCell(baseCx + dx, baseCy + dy, baseCz + dz))
              if (cell) candidates.push(...cell)
            }
          }
        }
      }
      radius++
    }

    if (candidates.length === 0) {
      for (let i = 0; i < sampleCount; i++) candidates.push(i)
    }

    // Compute distances and pick K nearest
    const dArr = new Array(candidates.length)
    for (let c = 0; c < candidates.length; c++) {
      const sIdx = candidates[c]
      const dx = samples[sIdx * 6]     - qx
      const dy = samples[sIdx * 6 + 1] - qy
      const dz = samples[sIdx * 6 + 2] - qz
      dArr[c] = [sIdx, dx * dx + dy * dy + dz * dz]
    }
    dArr.sort((a, b) => a[1] - b[1])

    const numK = Math.min(K, dArr.length)
    let sumR = 0, sumG = 0, sumB = 0, sumW = 0
    for (let k = 0; k < numK; k++) {
      const [sIdx, d2] = dArr[k]
      const weight = 1 / (d2 + 1e-6)
      sumR += samples[sIdx * 6 + 3] * weight
      sumG += samples[sIdx * 6 + 4] * weight
      sumB += samples[sIdx * 6 + 5] * weight
      sumW += weight
    }
    return [sumR / sumW, sumG / sumW, sumB / sumW]
  }

  // Per-vertex colour cache (vertex world-pos → fill colour)
  const vertexColorCache = new Map()
  function getVertexFillColor(x, y, z) {
    const kx = Math.round(x * 1e4)
    const ky = Math.round(y * 1e4)
    const kz = Math.round(z * 1e4)
    const key = `${kx},${ky},${kz}`
    let c = vertexColorCache.get(key)
    if (!c) {
      c = findFillColor(x, y, z)
      vertexColorCache.set(key, c)
    }
    return c
  }

  // Total triangle count for progress
  let totalTris = 0
  for (const m of meshes) {
    const g = m.geometry
    totalTris += (g.index ? g.index.count : g.attributes.position.count) / 3
  }

  // ── PASS 2: rasterise every triangle, fill uncovered texels by barycentric vertex-colour interpolation ──
  let trisDone = 0
  let lastYield = performance.now()

  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi]
    const matrixWorld = mesh.matrixWorld
    const geom = mesh.geometry
    const posAttr = geom.attributes.position
    const uvAttr = geom.attributes.uv
    const indexAttr = geom.index
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3

    for (let t = 0; t < triCount; t++) {
      const base = t * 3
      const i0 = indexAttr ? indexAttr.getX(base) : base
      const i1 = indexAttr ? indexAttr.getX(base + 1) : base + 1
      const i2 = indexAttr ? indexAttr.getX(base + 2) : base + 2

      vA.fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld)
      vB.fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld)
      vC.fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld)

      uvA.set(uvAttr.getX(i0), uvAttr.getY(i0))
      uvB.set(uvAttr.getX(i1), uvAttr.getY(i1))
      uvC.set(uvAttr.getX(i2), uvAttr.getY(i2))
      const pA = mapUvToCanvasPoint(uvA, w, h, textureConfig)
      const pB = mapUvToCanvasPoint(uvB, w, h, textureConfig)
      const pC = mapUvToCanvasPoint(uvC, w, h, textureConfig)

      const x0 = pA.x, y0 = pA.y
      const x1 = pB.x, y1 = pB.y
      const x2 = pC.x, y2 = pC.y

      const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
      if (Math.abs(denom) < 1e-10) { trisDone++; continue }

      const minPx = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
      const maxPx = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)))
      const minPy = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
      const maxPy = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)))

      // Fast skip if every pixel in the bbox is already covered
      let hasUncovered = false
      for (let py = minPy; py <= maxPy && !hasUncovered; py++) {
        const row = py * w
        for (let px = minPx; px <= maxPx; px++) {
          if (!anyCoverage[row + px]) { hasUncovered = true; break }
        }
      }
      if (!hasUncovered) { trisDone++; continue }

      const cA = getVertexFillColor(vA.x, vA.y, vA.z)
      const cB = getVertexFillColor(vB.x, vB.y, vB.z)
      const cC = getVertexFillColor(vC.x, vC.y, vC.z)

      const invDenom = 1 / denom
      const baryEps = -1e-3

      for (let py = minPy; py <= maxPy; py++) {
        const row = py * w
        for (let px = minPx; px <= maxPx; px++) {
          const pixelIdx = row + px
          if (anyCoverage[pixelIdx]) continue

          const fx = px + 0.5
          const fy = py + 0.5
          const wa = ((y1 - y2) * (fx - x2) + (x2 - x1) * (fy - y2)) * invDenom
          const wb = ((y2 - y0) * (fx - x2) + (x0 - x2) * (fy - y2)) * invDenom
          const wc = 1 - wa - wb
          if (wa < baryEps || wb < baryEps || wc < baryEps) continue

          const j = pixelIdx * 4
          outData[j]     = Math.round(wa * cA[0] + wb * cB[0] + wc * cC[0])
          outData[j + 1] = Math.round(wa * cA[1] + wb * cB[1] + wc * cC[1])
          outData[j + 2] = Math.round(wa * cA[2] + wb * cB[2] + wc * cC[2])
          outData[j + 3] = 255
        }
      }

      trisDone++

      if ((trisDone & 0xFF) === 0) {
        const now = performance.now()
        if (now - lastYield > 30) {
          if (onProgress) onProgress(trisDone / totalTris)
          await new Promise(r => setTimeout(r, 0))
          lastYield = now
        }
      }
    }
  }

  if (onProgress) onProgress(1)
  ctx.putImageData(new ImageData(outData, w, h), 0, 0)
}

function getRectangleBounds(startPoint, endPoint) {
  return {
    left: Math.min(startPoint.x, endPoint.x),
    right: Math.max(startPoint.x, endPoint.x),
    top: Math.min(startPoint.y, endPoint.y),
    bottom: Math.max(startPoint.y, endPoint.y)
  }
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load the generated texture result.'))
    image.src = url
  })
}

function createBooleanBrushMaskFromImage(image, maxResolution = 96) {
  if (!image) {
    return null
  }

  const sourceW = Math.max(1, image.naturalWidth || image.width || 1)
  const sourceH = Math.max(1, image.naturalHeight || image.height || 1)
  const scale = Math.min(1, maxResolution / Math.max(sourceW, sourceH))
  const width = Math.max(8, Math.round(sourceW * scale))
  const height = Math.max(8, Math.round(sourceH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  const pixels = ctx.getImageData(0, 0, width, height).data
  const alpha = new Uint8Array(width * height)

  let alphaCoverage = 0
  for (let i = 0; i < pixels.length; i += 4) {
    alphaCoverage += pixels[i + 3]
  }

  // If the source has no meaningful alpha channel, treat it like
  // black-on-white stencil art (black = filled, white = empty).
  const alphaIsMeaningful = alphaCoverage > width * height * 20
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4
    const a = pixels[i + 3]
    if (alphaIsMeaningful) {
      alpha[p] = a
      continue
    }

    const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
    alpha[p] = Math.max(0, Math.min(255, Math.round(255 - lum)))
  }

  return { alpha, width, height }
}

function buildBooleanStampGeometry(mask, size = 0.2, depth = 0.06, threshold = 24) {
  if (!mask?.alpha || !mask.width || !mask.height) {
    return null
  }

  const { alpha, width, height } = mask
  const occupied = new Uint8Array(width * height)
  let occupiedCount = 0

  for (let index = 0; index < occupied.length; index += 1) {
    const filled = alpha[index] >= threshold ? 1 : 0
    occupied[index] = filled
    occupiedCount += filled
  }

  if (occupiedCount === 0) {
    return null
  }

  const maxDim = Math.max(width, height)
  const stampWidth = Math.max(1e-5, size * (width / maxDim))
  const stampHeight = Math.max(1e-5, size * (height / maxDim))
  const cellW = stampWidth / width
  const cellH = stampHeight / height
  const z0 = 0
  const z1 = Math.max(1e-5, depth)
  const positions = []

  const isFilled = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return false
    }
    return occupied[y * width + x] === 1
  }

  const pushTri = (a, b, c) => {
    positions.push(
      a[0], a[1], a[2],
      b[0], b[1], b[2],
      c[0], c[1], c[2]
    )
  }

  const pushQuad = (a, b, c, d) => {
    pushTri(a, b, c)
    pushTri(a, c, d)
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isFilled(x, y)) {
        continue
      }

      const x0 = -stampWidth / 2 + x * cellW
      const x1 = x0 + cellW
      const y0 = stampHeight / 2 - (y + 1) * cellH
      const y1 = y0 + cellH

      // Front (+Z)
      pushQuad(
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1]
      )
      // Back (-Z)
      pushQuad(
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
        [x0, y0, z0]
      )

      if (!isFilled(x - 1, y)) {
        pushQuad(
          [x0, y0, z0],
          [x0, y1, z0],
          [x0, y1, z1],
          [x0, y0, z1]
        )
      }
      if (!isFilled(x + 1, y)) {
        pushQuad(
          [x1, y1, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x1, y1, z1]
        )
      }
      if (!isFilled(x, y - 1)) {
        pushQuad(
          [x1, y1, z0],
          [x0, y1, z0],
          [x0, y1, z1],
          [x1, y1, z1]
        )
      }
      if (!isFilled(x, y + 1)) {
        pushQuad(
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x0, y0, z1]
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function computeBooleanStampBasis(intersection, camera) {
  if (!intersection?.point || !intersection?.face?.normal || !intersection?.object) {
    return null
  }

  const normal = intersection.face.normal.clone().transformDirection(intersection.object.matrixWorld).normalize()
  if (normal.lengthSq() < 1e-10) {
    return null
  }

  const cameraForward = new THREE.Vector3(0, 0, -1)
  camera?.getWorldDirection?.(cameraForward)
  let tangent = new THREE.Vector3().crossVectors(cameraForward, normal)
  if (tangent.lengthSq() < 1e-8) {
    const helper = Math.abs(normal.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0)
    tangent = new THREE.Vector3().crossVectors(helper, normal)
  }
  tangent.normalize()
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize()

  return {
    point: intersection.point.clone(),
    normal,
    tangent,
    bitangent
  }
}

function buildBooleanStampMatrix(basis, rotationDeg = 0, offset = 0, nudgeX = 0, nudgeY = 0) {
  const matrix = new THREE.Matrix4()
  if (!basis) {
    return matrix
  }

  const angle = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const xAxis = basis.tangent.clone().multiplyScalar(cos).addScaledVector(basis.bitangent, sin).normalize()
  const yAxis = basis.bitangent.clone().multiplyScalar(cos).addScaledVector(basis.tangent, -sin).normalize()
  const zAxis = basis.normal.clone().normalize()
  const position = basis.point.clone()
    .addScaledVector(zAxis, offset)
    .addScaledVector(xAxis, nudgeX)
    .addScaledVector(yAxis, nudgeY)

  matrix.makeBasis(xAxis, yAxis, zAxis)
  matrix.setPosition(position)
  return matrix
}

function sampleBooleanMaskAlpha(mask, u, v) {
  if (!mask?.alpha || !mask.width || !mask.height) {
    return 0
  }

  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) {
    return 0
  }

  const { alpha, width, height } = mask
  const x = u * (width - 1)
  const y = v * (height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0

  const a00 = alpha[y0 * width + x0]
  const a10 = alpha[y0 * width + x1]
  const a01 = alpha[y1 * width + x0]
  const a11 = alpha[y1 * width + x1]
  const top = a00 + (a10 - a00) * tx
  const bottom = a01 + (a11 - a01) * tx
  return top + (bottom - top) * ty
}

function deformGeometryWithBooleanStamp(baseGeometry, mask, stampMatrix, {
  operation = 'out',
  size = 0.2,
  depth = 0.06,
  offset = 0.01,
  threshold = 24
} = {}) {
  if (!baseGeometry?.attributes?.position || !mask || !stampMatrix) {
    return null
  }

  const result = baseGeometry.clone()
  const positionAttr = result.attributes.position
  if (!positionAttr?.array) {
    return null
  }

  const pos = positionAttr.array
  const normalAttr = result.attributes.normal
  const normals = normalAttr?.array || null
  const vertexCount = positionAttr.count

  const stampWidth = Math.max(1e-5, size * (mask.width / Math.max(mask.width, mask.height)))
  const stampHeight = Math.max(1e-5, size * (mask.height / Math.max(mask.width, mask.height)))
  const halfW = stampWidth * 0.5
  const halfH = stampHeight * 0.5
  const maxDepth = Math.max(1e-5, depth)
  const hitSide = offset < 0 ? 1 : -1

  const invStamp = stampMatrix.clone().invert()
  const stampZ = new THREE.Vector3().setFromMatrixColumn(stampMatrix, 2).normalize()
  const worldPoint = new THREE.Vector3()
  const localPoint = new THREE.Vector3()
  const displacement = new THREE.Vector3()

  let sign = 1
  const op = String(operation || 'out').toLowerCase()
  if (op === 'in' || op === 'subtract' || op === 'substract' || op === 'difference') {
    sign = -1
  }

  for (let i = 0; i < vertexCount; i += 1) {
    const offset = i * 3
    worldPoint.set(pos[offset], pos[offset + 1], pos[offset + 2])
    localPoint.copy(worldPoint).applyMatrix4(invStamp)

    const u = (localPoint.x + halfW) / stampWidth
    const v = (halfH - localPoint.y) / stampHeight
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      continue
    }

    const alpha = sampleBooleanMaskAlpha(mask, u, v)
    if (alpha < threshold) {
      continue
    }

    const alphaWeight = alpha / 255
    // Only deform the side of the plane where the stamp was placed.
    // This avoids opposite-side vertices being pushed the other way on thin meshes.
    const sideDistance = localPoint.z * hitSide
    if (sideDistance < 0) {
      continue
    }

    const zFalloff = Math.max(0, 1 - sideDistance / (maxDepth * 2.0))
    if (zFalloff <= 0) {
      continue
    }

    const edgeU = Math.min(u, 1 - u)
    const edgeV = Math.min(v, 1 - v)
    const edgeSoftness = Math.max(0.02, Math.min(0.22, threshold / 255))
    const edgeWeight = Math.min(1, Math.min(edgeU, edgeV) / edgeSoftness)
    const strength = maxDepth * alphaWeight * zFalloff * edgeWeight

    if (strength <= 1e-7) {
      continue
    }

    displacement.copy(stampZ).multiplyScalar(sign * strength)
    pos[offset] += displacement.x
    pos[offset + 1] += displacement.y
    pos[offset + 2] += displacement.z
  }

  positionAttr.needsUpdate = true
	result.deleteAttribute('normal')
  result.computeVertexNormals()
  result.computeBoundingBox()
  result.computeBoundingSphere()
  return result
}

function collectBooleanDeformationFaceIndices(baseGeometry, mask, stampMatrix, {
  size = 0.2,
  depth = 0.06,
  offset = 0.01,
  threshold = 24
} = {}) {
  if (!baseGeometry?.attributes?.position || !mask || !stampMatrix) {
    return []
  }

  const positionAttr = baseGeometry.attributes.position
  const indexAttr = baseGeometry.index
  const vertexCount = positionAttr.count
  if (!vertexCount) {
    return []
  }

  const stampWidth = Math.max(1e-5, size * (mask.width / Math.max(mask.width, mask.height)))
  const stampHeight = Math.max(1e-5, size * (mask.height / Math.max(mask.width, mask.height)))
  const halfW = stampWidth * 0.5
  const halfH = stampHeight * 0.5
  const maxDepth = Math.max(1e-5, depth)
  const hitSide = offset < 0 ? 1 : -1
  const invStamp = stampMatrix.clone().invert()
  const localPoint = new THREE.Vector3()

  const sampleVertex = (vertexIndex) => {
    localPoint
      .fromBufferAttribute(positionAttr, vertexIndex)
      .applyMatrix4(invStamp)

    const u = (localPoint.x + halfW) / stampWidth
    const v = (halfH - localPoint.y) / stampHeight
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      return false
    }

    const alpha = sampleBooleanMaskAlpha(mask, u, v)
    if (alpha < threshold) {
      return false
    }

    const sideDistance = localPoint.z * hitSide
    return sideDistance >= 0 && sideDistance < maxDepth * 1.5
  }

  const faceCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(vertexCount / 3)
  const touchedFaceIndices = []

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const ia = indexAttr ? indexAttr.array[faceIndex * 3] : faceIndex * 3
    const ib = indexAttr ? indexAttr.array[faceIndex * 3 + 1] : faceIndex * 3 + 1
    const ic = indexAttr ? indexAttr.array[faceIndex * 3 + 2] : faceIndex * 3 + 2

    if (sampleVertex(ia) || sampleVertex(ib) || sampleVertex(ic)) {
      touchedFaceIndices.push(faceIndex)
      continue
    }

    // Also sample the face centroid so large triangles inside the brush area
    // are still selected for local subdivision.
    const ax = positionAttr.getX(ia)
    const ay = positionAttr.getY(ia)
    const az = positionAttr.getZ(ia)
    const bx = positionAttr.getX(ib)
    const by = positionAttr.getY(ib)
    const bz = positionAttr.getZ(ib)
    const cx = positionAttr.getX(ic)
    const cy = positionAttr.getY(ic)
    const cz = positionAttr.getZ(ic)

    localPoint
      .set((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3)
      .applyMatrix4(invStamp)

    const u = (localPoint.x + halfW) / stampWidth
    const v = (halfH - localPoint.y) / stampHeight
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      continue
    }

    const alpha = sampleBooleanMaskAlpha(mask, u, v)
    if (alpha < threshold) {
      continue
    }

    const sideDistance = localPoint.z * hitSide
    if (sideDistance >= 0 && sideDistance < maxDepth * 1.5) {
      touchedFaceIndices.push(faceIndex)
    }
  }

  return touchedFaceIndices
}

function tessellateBooleanDeformationRegion(baseGeometry, mask, stampMatrix, {
  size = 0.2,
  depth = 0.06,
  offset = 0.01,
  threshold = 24,
  levels = 0
} = {}) {
  const passes = Math.max(0, Math.min(2, Math.floor(levels)))
  if (passes <= 0) {
    return baseGeometry
  }

  let nextGeometry = baseGeometry
  for (let level = 0; level < passes; level += 1) {
    const faceIndices = collectBooleanDeformationFaceIndices(nextGeometry, mask, stampMatrix, {
      size,
      depth,
      offset,
      threshold
    })

    if (faceIndices.length === 0) {
      break
    }

    nextGeometry = subdivideSelectedFaces(nextGeometry, faceIndices)
  }

  return nextGeometry
}

/**
 * Convert a screen-space brush radius (pixels) into the equivalent radius in
 * texture-canvas pixels, taking into account:
 *   1. Camera perspective: farther away → smaller footprint on the mesh.
 *   2. Local UV density of the hit face: how many texture pixels cover one
 *      world-space unit at the hit point.
 *
 * Falls back to `paintBrushSize` unchanged if any required data is missing.
 */
function computePaintBrushTexturePx(paintBrushSize, camera, canvasHeight, intersection, textureWidth, textureHeight) {
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
function computePaintBrushUvRotationDeg(requestedRotationDeg, camera, canvasWidth, canvasHeight, intersection) {
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

function pickGeneratedTextureAsset(generatedAssets = []) {
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

function buildFramedProjectionCamera(sourceCamera, root, aspect = 1) {
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
function applyPatchBlendToCanvas(originalCanvas, patchedCanvas, outputCanvas, opacity, noise, sharpness, saturation, maskCanvas = null, featherRadius = 12) {
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
function generateBlurBorderGradient(sourceMaskCanvas, targetWidth, targetHeight, blurRadius = 12) {
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

function CameraRig({ geometry, frameKey, onCameraReady, controlsEnabled = true, allowPan = true, lockToCenter = false }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const lastFramedKeyRef = useRef(null)

  useEffect(() => {
    onCameraReady?.(camera)
  }, [camera, onCameraReady])

  useEffect(() => {
    if (!geometry) {
      return
    }
    // Re-frame only when the frameKey changes (i.e. a new mesh was loaded).
    // Topology edits (delete / merge / subdivide / fill / undo) keep the same
    // frameKey so the camera doesn't snap back to its initial framing.
    if (lastFramedKeyRef.current === frameKey) {
      return
    }
    lastFramedKeyRef.current = frameKey

    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    const radius = Math.max(sphere?.radius || 1, 1)
    const center = sphere?.center || new THREE.Vector3()
    const distance = radius * 2.6
    const minDistance = Math.max(radius * 0.0025, 0.0005)
    const maxDistance = Math.max(radius * 24, 24)

    camera.position.set(center.x + distance, center.y + distance * 0.65, center.z + distance)
     
    Object.assign(camera, {
      near: Math.max(radius * 0.00005, 0.0001),
      far: Math.max(radius * 80, 4000)
    })
    camera.lookAt(center)
    camera.updateProjectionMatrix()

    if (controlsRef.current) {
      controlsRef.current.minDistance = minDistance
      controlsRef.current.maxDistance = maxDistance
      controlsRef.current.target.copy(center)
      controlsRef.current.update()
    }
  }, [camera, geometry, frameKey])

  useEffect(() => {
    if (!lockToCenter || !geometry || !controlsRef.current) {
      return
    }

    geometry.computeBoundingSphere()
    const center = geometry.boundingSphere?.center || new THREE.Vector3()
    controlsRef.current.target.copy(center)
    camera.lookAt(center)
    controlsRef.current.update()
  }, [camera, geometry, lockToCenter])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={controlsEnabled}
      enableDamping
      enablePan={allowPan}
      minDistance={0.001}
      maxDistance={100}
      mouseButtons={{
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: allowPan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
      }}
    />
  )
}

function EditorMesh({ geometry, selectedFaceIndices, selectedVertexIndices, showShadows = false, showAlbedo = false }) {
  const faceSelectionGeometry = useMemo(() => getFaceSelectionGeometry(geometry, selectedFaceIndices), [geometry, selectedFaceIndices])
  const selectedVertexPositions = useMemo(() => getVertexSelectionPositions(geometry, selectedVertexIndices), [geometry, selectedVertexIndices])
  const selectedVertexVectors = useMemo(() => {
    const vectors = []

    for (let index = 0; index < selectedVertexPositions.length; index += 3) {
      vectors.push([
        selectedVertexPositions[index],
        selectedVertexPositions[index + 1],
        selectedVertexPositions[index + 2]
      ])
    }

    return vectors
  }, [selectedVertexPositions])

  useEffect(() => () => faceSelectionGeometry?.dispose?.(), [faceSelectionGeometry])

  return (
    <group>
      <mesh geometry={geometry} castShadow={showShadows} receiveShadow={showShadows}>
        {showAlbedo
          ? <meshBasicMaterial color="#a9b6ff" />
          : <meshStandardMaterial color="#a9b6ff" metalness={0.08} roughness={0.62} />}
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.36} />
      </mesh>
      {selectedFaceIndices.length > 0 && faceSelectionGeometry?.attributes?.position?.count > 0 && (
        <mesh geometry={faceSelectionGeometry}>
          <meshBasicMaterial color="#ff9a62" transparent opacity={0.68} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {selectedVertexVectors.length > 0 && (
        <group>
          {selectedVertexVectors.map(([x, y, z], index) => (
            <mesh key={`${x}-${y}-${z}-${index}`} position={[x, y, z]}>
              <sphereGeometry args={[0.001, 8, 8]} />
              <meshBasicMaterial color="#8ff5ff" depthTest={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  )
}

function BooleanPreviewMesh({
  geometry,
  maskTexture,
  maskWidth,
  maskHeight,
  stampMatrix,
  operation = 'union',
  size = 0.2,
  depth = 0.06,
  offset = 0.01,
  threshold = 24,
  previewColor = '#72ff9d',
  showShadows = false
}) {
  const uniforms = useMemo(() => ({
    uInvStamp: { value: new THREE.Matrix4() },
    uStampZ: { value: new THREE.Vector3(0, 0, 1) },
    uStampSize: { value: new THREE.Vector2(0.2, 0.2) },
    uDepth: { value: 0.06 },
    uThreshold: { value: 24 / 255 },
    uHitSide: { value: -1 },
    uSign: { value: 1 },
    uMask: { value: null },
    uBaseColor: { value: new THREE.Color('#a9b6ff') },
    uPreviewColor: { value: new THREE.Color('#72ff9d') }
  }), [])

  useEffect(() => {
    const maxDim = Math.max(maskWidth || 1, maskHeight || 1)
    const stampWidth = Math.max(1e-5, size * ((maskWidth || 1) / maxDim))
    const stampHeight = Math.max(1e-5, size * ((maskHeight || 1) / maxDim))
    const sign = (String(operation || 'out').toLowerCase() === 'out') ? 1 : -1

    uniforms.uInvStamp.value.copy(stampMatrix).invert()
    uniforms.uStampSize.value.set(stampWidth, stampHeight)
    uniforms.uDepth.value = Math.max(1e-5, depth)
    uniforms.uThreshold.value = Math.max(0, Math.min(1, threshold / 255))
    uniforms.uHitSide.value = offset < 0 ? 1 : -1
    uniforms.uSign.value = sign
    uniforms.uMask.value = maskTexture
    uniforms.uPreviewColor.value.set(previewColor)

    const stampZ = new THREE.Vector3().setFromMatrixColumn(stampMatrix, 2).normalize()
    uniforms.uStampZ.value.copy(stampZ)
  }, [depth, maskHeight, maskTexture, maskWidth, offset, operation, previewColor, size, stampMatrix, threshold, uniforms])

  useEffect(() => () => {
    uniforms.uPreviewColor.value?.dispose?.()
  }, [uniforms])

  return (
    <group>
      <mesh geometry={geometry} castShadow={showShadows} receiveShadow={showShadows}>
        <shaderMaterial
          uniforms={uniforms}
          side={THREE.DoubleSide}
          transparent={false}
          depthTest
          depthWrite
          vertexShader={`
            varying vec3 vNormal;
            varying float vStrength;

            uniform mat4 uInvStamp;
            uniform vec3 uStampZ;
            uniform vec2 uStampSize;
            uniform float uDepth;
            uniform float uThreshold;
            uniform float uHitSide;
            uniform float uSign;
            uniform sampler2D uMask;

            void main() {
              vec3 displaced = position;
              float strength = 0.0;

              vec3 localPoint = (uInvStamp * vec4(position, 1.0)).xyz;
              float halfW = uStampSize.x * 0.5;
              float halfH = uStampSize.y * 0.5;
              float u = (localPoint.x + halfW) / uStampSize.x;
              float v = (halfH - localPoint.y) / uStampSize.y;

              if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
                float alpha = texture2D(uMask, vec2(u, v)).r;
                if (alpha >= uThreshold) {
                  float sideDistance = localPoint.z * uHitSide;
                  if (sideDistance >= 0.0) {
                    float zFalloff = max(0.0, 1.0 - sideDistance / (uDepth * 2.0));
                    float edgeU = min(u, 1.0 - u);
                    float edgeV = min(v, 1.0 - v);
                    float edgeSoftness = clamp(uThreshold, 0.02, 0.22);
                    float edgeWeight = min(1.0, min(edgeU, edgeV) / edgeSoftness);

                    strength = uDepth * alpha * zFalloff * edgeWeight;
                    displaced += uStampZ * (uSign * strength);
                  }
                }
              }

              vStrength = strength;
              vNormal = normalize(normalMatrix * normal);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
            }
          `}
          fragmentShader={`
            varying vec3 vNormal;
            varying float vStrength;

            uniform vec3 uBaseColor;
            uniform vec3 uPreviewColor;
            uniform float uDepth;

            void main() {
              vec3 n = normalize(vNormal);
              vec3 l1 = normalize(vec3(0.4, 0.8, 0.5));
              vec3 l2 = normalize(vec3(-0.55, 0.35, -0.45));
              float lambert = 0.28 + 0.52 * max(dot(n, l1), 0.0) + 0.20 * max(dot(n, l2), 0.0);
              float normalizedStrength = clamp(vStrength / max(uDepth, 1e-5), 0.0, 1.0);
              float t = smoothstep(0.08, 0.55, normalizedStrength);
              vec3 base = mix(uBaseColor, uPreviewColor, t);
              vec3 lit = base * lambert + (uPreviewColor * (0.18 * t));
              gl_FragColor = vec4(lit, 1.0);
            }
          `}
        />
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.08} depthWrite={false} />
      </mesh>
    </group>
  )
}

function TexturedMesh({ root, textureKey, displayTexture, showShadows = false, showAlbedo = false }) {
  const baseObject = useMemo(() => {
    if (!root || !displayTexture) {
      return null
    }

    const object = root.clone(true)
    const materials = []

    const buildMaterial = sourceMaterial => {
      const isTargetTexture = sourceMaterial && getTextureKeyFromMaterial(sourceMaterial) === textureKey

      if (showAlbedo) {
        const params = {}
        if (sourceMaterial?.color?.isColor) {
          params.color = sourceMaterial.color.clone()
        } else if (sourceMaterial?.color) {
          params.color = new THREE.Color(sourceMaterial.color)
        } else {
          params.color = new THREE.Color('#ffffff')
        }
        const albedoMap = isTargetTexture ? displayTexture : (sourceMaterial?.map || null)
        if (albedoMap) {
          params.map = albedoMap
        }
        if (sourceMaterial?.transparent) {
          params.transparent = true
          params.opacity = sourceMaterial.opacity ?? 1
        }
        if (typeof sourceMaterial?.side === 'number') {
          params.side = sourceMaterial.side
        }
        return new THREE.MeshBasicMaterial(params)
      }

      const nextMaterial = sourceMaterial?.clone?.() || sourceMaterial
      if (nextMaterial && isTargetTexture) {
        nextMaterial.map = displayTexture
        nextMaterial.needsUpdate = true
      }
      return nextMaterial
    }

    object.traverse(child => {
      if (!child.isMesh) {
        return
      }

      child.castShadow = showShadows
      child.receiveShadow = showShadows

      if (Array.isArray(child.material)) {
        child.material = child.material.map(material => {
          const nextMaterial = buildMaterial(material)
          if (nextMaterial) {
            materials.push(nextMaterial)
          }
          return nextMaterial
        })
        return
      }

      const nextMaterial = buildMaterial(child.material)
      child.material = nextMaterial
      if (nextMaterial) {
        materials.push(nextMaterial)
      }
    })

    object.userData.meshEditorMaterials = materials
    return object
  }, [displayTexture, root, showAlbedo, showShadows, textureKey])

  useEffect(() => () => {
    baseObject?.userData?.meshEditorMaterials?.forEach(material => material?.dispose?.())
  }, [baseObject])

  return (
    <group>
      {baseObject && <primitive object={baseObject} />}
    </group>
  )
}

function processPatchImage(imageData, sharpness = 0, saturation = 1, patchMask = null) {
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

function createFullAlphaMaskCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  return canvas
}

function createProjectionCropMaskCanvasFromPatch(patchCanvas, cropBorder = 0) {
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

export default function MeshEditorPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    getComfyWorkflows,
    runComfyWorkflow,
    saveMeshEdit,
    subscribeToComfyWorkflowProgress,
    updateProjectNode,
    uploadAssetThumbnail,
    getPaintDocument,
    savePaintDocument
  } = useProjects()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [showShadows, setShowShadows] = useState(false)
  const [showAlbedo, setShowAlbedo] = useState(false)
  const [activeMenu, setActiveMenu] = useState('modeling')
  const [geometry, setGeometry] = useState(null)
  const [texturableMesh, setTexturableMesh] = useState(null)
  const [textureRevision, setTextureRevision] = useState(0)
  const [contextRevision, setContextRevision] = useState(0)
  const [comfyLoading, setComfyLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [textureWorkflowId, setTextureWorkflowId] = useState('')
  const [textureWorkflowInputs, setTextureWorkflowInputs] = useState({})
  const [projectionWorkflowId, setProjectionWorkflowId] = useState('')
  const [projectionWorkflowInputs, setProjectionWorkflowInputs] = useState({})
  const [projectionImageParamSources, setProjectionImageParamSources] = useState({})
  const [projectionStarted, setProjectionStarted] = useState(false)
  const [projectionKeepTexture, setProjectionKeepTexture] = useState(false)
  const [projecting, setProjecting] = useState(false)
  const [projectionRebuilding, setProjectionRebuilding] = useState(false)
  const [projectionRebuildProgress, setProjectionRebuildProgress] = useState(0)
  const [projectionLayerDrafts, setProjectionLayerDrafts] = useState({})
  const [projectionTextureSize, setProjectionTextureSize] = useState(2048)
  const [projectionViewResolution, setProjectionViewResolution] = useState(1024)
  const [projectionBlendPixels, setProjectionBlendPixels] = useState(12)
  const [projectionLayers, setProjectionLayers] = useState([])
  const [brushSize, setBrushSize] = useState(20)
  const [cropPadding, setCropPadding] = useState(36)
  const [featherRadius, setFeatherRadius] = useState(12)
  const [geometryRevision, setGeometryRevision] = useState(0)
  const [meshFrameKey, setMeshFrameKey] = useState(0)
  const [modelingCanUndo, setModelingCanUndo] = useState(false)
  const [modelingCanRedo, setModelingCanRedo] = useState(false)
  const modelingUndoStackRef = useRef([])
  const modelingRedoStackRef = useRef([])
  const [booleanOperation, setBooleanOperation] = useState('out')
  const [booleanPlaceMode, setBooleanPlaceMode] = useState(false)
  const [booleanBrushSource, setBooleanBrushSource] = useState('asset')
  const [booleanBrushAsset, setBooleanBrushAsset] = useState(null)
  const [booleanBrushFile, setBooleanBrushFile] = useState(null)
  const [showBooleanBrushSelector, setShowBooleanBrushSelector] = useState(false)
  const booleanBrushFileInputRef = useRef(null)
  const booleanBrushMaskRef = useRef(null)
  const [booleanBrushRevision, setBooleanBrushRevision] = useState(0)
  const [booleanStampBasis, setBooleanStampBasis] = useState(null)
  const [booleanStampSize, setBooleanStampSize] = useState(0.2)
  const [booleanStampDepth, setBooleanStampDepth] = useState(0.06)
  const [booleanTessellation, setBooleanTessellation] = useState(0)
  const [booleanStampRotation, setBooleanStampRotation] = useState(0)
  const [booleanStampOffset, setBooleanStampOffset] = useState(0.01)
  const [booleanStampNudgeX, setBooleanStampNudgeX] = useState(0)
  const [booleanStampNudgeY, setBooleanStampNudgeY] = useState(0)
  const booleanLastHoverUpdateRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [texturing, setTexturing] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [selectionMode, setSelectionMode] = useState('face')
  const [selectedFaceIndices, setSelectedFaceIndices] = useState([])
  const [selectedVertexIndices, setSelectedVertexIndices] = useState([])
  const [_holeLoops, setHoleLoops] = useState([])
  const [meshName, setMeshName] = useState(searchParams.get('name') || 'Mesh')
  const [selectionBox, setSelectionBox] = useState(null)
  const [pendingPatch, setPendingPatch] = useState(null)
  const [patchNoise, setPatchNoise] = useState(0)
  const [patchSharpness, setPatchSharpness] = useState(0.0); // 0 → 2
  const [patchSaturation, setPatchSaturation] = useState(1.0); // 0 → 2	
  const [multiViewCount, setMultiViewCount] = useState(1)
  const [projectionOpacities, setProjectionOpacities] = useState([1])
  const [postProcSeamThreshold, setPostProcSeamThreshold] = useState(0.35)
  const [postProcBlurRadius, setPostProcBlurRadius] = useState(8)
  const [postProcStrength, setPostProcStrength] = useState(0.85)
  const [postProcSeamEnabled, setPostProcSeamEnabled] = useState(true)
  const [postProcFillHolesEnabled, setPostProcFillHolesEnabled] = useState(true)
  const [postProcFillHolesBlur, setPostProcFillHolesBlur] = useState(8)
  const [postProcApplied, setPostProcApplied] = useState(false)

  const assetId = searchParams.get('assetId') || ''
  const numericAssetId = Number(assetId)
  const filePath = searchParams.get('filePath') || ''
  const modelUrl = searchParams.get('url') || ''
  const projectId = searchParams.get('projectId') || ''
  const nodeId = searchParams.get('nodeId') || ''
  const returnTo = searchParams.get('returnTo') || ''
  const canvasShellRef = useRef(null)
  const cameraRef = useRef(null)
  const dragStateRef = useRef(null)
  const paintStateRef = useRef(null)
  const displayTextureRef = useRef(null)
  const maskTextureRef = useRef(null)
  const projectionMaskCanvasRef = useRef(null)
  const maskOverlayCanvasRef = useRef(null);
  const projectionMaskBackupRef = useRef(null)
  const texturableEditableMeshRef = useRef(null)
  const projectionCameraRef = useRef(null)
  const [hasProjectionMask, setHasProjectionMask] = useState(false)
  const originalTextureBackupRef = useRef(null)
  const postProcBackupRef = useRef(null)
  const projectionLayerSnapshotsRef = useRef([])
  const patchedTextureRef = useRef(null)
  const projectionViewDataRef = useRef([])
  const projectionCoverageRef = useRef(null)
  const projectionFaceOwnershipRef = useRef(new Map())
  const projectionLayerDataRef = useRef(new Map())
  const projectionLayerCounterRef = useRef(0)
  const projectionRebuildTokenRef = useRef(0)
  const projectionBaseTextureRef = useRef(null)
  const [imageParamSources, setImageParamSources] = useState({});
  const [showAssetSelector, setShowAssetSelector] = useState(false);
  const [pendingAssetParamId, setPendingAssetParamId] = useState(null);
  const [pendingAssetSelectorMode, setPendingAssetSelectorMode] = useState('texturing')

  // --- Painting mode state ---
  const [paintBrushSource, setPaintBrushSource] = useState('asset'); // 'asset' | 'computer'
  const [paintBrushAsset, setPaintBrushAsset] = useState(null);
  const [paintBrushFile, setPaintBrushFile] = useState(null);
  const [showBrushSelector, setShowBrushSelector] = useState(false);
  const [paintBrushSize, setPaintBrushSize] = useState(32);
  const [paintBrushNaturalSize, setPaintBrushNaturalSize] = useState(null); // { width, height } of the loaded brush, null = unknown (treat as square)
  const [paintOpacity, setPaintOpacity] = useState(1);
  const [paintFlow, setPaintFlow] = useState(1);
  const [paintHardness, setPaintHardness] = useState(0.5);
  const [paintRotation, setPaintRotation] = useState(0);
  const [paintBlendMode, setPaintBlendMode] = useState('source-over');
  const [paintColor, setPaintColor] = useState('#ffffff');
  // 'draw' stamps the brush onto the active layer; 'erase' uses the brush
  // shape to remove pixels from the active layer (destination-out). Erase is
  // only meaningful with a selected layer; if the active layer is cleared we
  // automatically fall back to 'draw' (see effect below).
  const [paintMode, setPaintMode] = useState('draw');
  const [paintLayers, setPaintLayers] = useState([]); // [{ id, name, opacity, blendMode, color, visible }]
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const paintBrushFileInputRef = useRef(null);
  const paintBrushImageRef = useRef(null); // HTMLImageElement of current brush
  const paintingBaseTextureRef = useRef(null); // canvas snapshot of the base texture
  const paintLayerCanvasesRef = useRef(new Map()); // layerId -> canvas
  const activeStrokeRef = useRef(null); // { layerId, lastUv, lastIslandKey, pointerId }
  const paintLayerCounterRef = useRef(0);
  const hydratedPaintDocAssetIdRef = useRef(null);
  // Tracks whether the current session has any reason to push a paint document
  // to the server (either we loaded one from disk, or the user painted at
  // least one stroke). Stays true across mode switches so deleting every
  // layer + saving the mesh still triggers a server-side cleanup of orphan
  // layer PNGs. Reset only when the asset under edit changes.
  const paintDocDirtyForAssetIdRef = useRef(null);
  const [paintCursorPos, setPaintCursorPos] = useState(null); // { x, y } in canvasShell coords

  // --- Sculpting mode state ---
  // Brush kind: 'standard' is the only kernel wired up in this step. Smooth
  // and Inflate kernels exist in meshSculpt.js for the auto-smooth slider
  // and an upcoming step.
  const [sculptBrush, setSculptBrush] = useState('standard');
  // Brush radius in world units. Default is recomputed from the bounding
  // sphere when geometry loads (effect below).
  const [sculptSize, setSculptSize] = useState(0.05);
  const [sculptSizeRange, setSculptSizeRange] = useState({ min: 0.001, max: 1 });
  const [sculptStrength, setSculptStrength] = useState(0.5);
  const [sculptHardness, setSculptHardness] = useState(0.4);
  const [sculptSpacing, setSculptSpacing] = useState(0.25);
  const [sculptDirection, setSculptDirection] = useState(1); // +1 add, -1 subtract
  const [sculptFrontFacesOnly, setSculptFrontFacesOnly] = useState(false);
  const [sculptSymmetry, setSculptSymmetry] = useState({ x: false, y: false, z: false });
  const [sculptSteadyStroke, setSculptSteadyStroke] = useState(0);
  const [sculptAutoSmooth, setSculptAutoSmooth] = useState(0);
  const [sculptCursor, setSculptCursor] = useState(null); // { x, y, pixelRadius } or null
  const [sculptCanUndo, setSculptCanUndo] = useState(false);
  const [sculptCanRedo, setSculptCanRedo] = useState(false);

  // Optional textured brush stamp: an alpha map sampled across the brush
  // footprint at kernel time. None = pure spherical falloff.
  const [sculptStampSource, setSculptStampSource] = useState('none'); // 'none' | 'asset' | 'computer'
  const [sculptStampAsset, setSculptStampAsset] = useState(null);
  const [sculptStampFile, setSculptStampFile] = useState(null);
  const [sculptStampRotation, setSculptStampRotation] = useState(0); // degrees
  const [showSculptStampSelector, setShowSculptStampSelector] = useState(false);
  const sculptStampFileInputRef = useRef(null);
  // Cached alpha map for the active stamp: { alphaMap: Uint8Array, width, height }
  const sculptStampRef = useRef(null);

  const sculptContextRef = useRef(null);
  // Object3D used for raycasting in sculpt mode (created on demand from `geometry`).
  const sculptMeshRef = useRef(null);
  // Active stroke state during a left-button drag.
  // { pointerId, lastPoint, lazyPoint, accumulated, lastWorldHit, undoSnapshot }
  const sculptStrokeRef = useRef(null);
  // Bounded ring buffer of position-attribute snapshots for undo / redo.
  const sculptUndoStackRef = useRef([]);
  const sculptRedoStackRef = useRef([]);
  // Per-stroke key state captured on pointerdown (Ctrl flips direction; Shift
  // forces smooth-on-the-fly even if the active brush is something else).
  const sculptStrokeKeysRef = useRef({ ctrl: false, shift: false });

  const PAINT_BLEND_MODES = useMemo(() => [
    { value: 'source-over', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'color-burn', label: 'Color Burn' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' }
  ], []);

  useEffect(() => {
    if (!geometry) {
      setBooleanStampBasis(null)
      setBooleanPlaceMode(false)
      return
    }

    geometry.computeBoundingSphere()
    const radius = Math.max(geometry.boundingSphere?.radius || 1, 0.01)
    setBooleanStampSize(Math.max(radius * 0.2, 0.02))
    setBooleanStampDepth(Math.max(radius * 0.06, 0.005))
    setBooleanStampOffset(Math.max(radius * 0.005, 0.001))
    setBooleanStampNudgeX(0)
    setBooleanStampNudgeY(0)
    setBooleanStampBasis(null)
  }, [geometry])

  useEffect(() => {
    if (activeMenu !== 'boolean') {
      setBooleanPlaceMode(false)
      setBooleanStampBasis(null)
    }
  }, [activeMenu])

  useEffect(() => {
    let cancelled = false
    let objectUrl = null

    async function loadBooleanBrushMask() {
      let sourceUrl = null
      if (booleanBrushSource === 'asset' && booleanBrushAsset) {
        sourceUrl = buildAssetUrl(booleanBrushAsset)
      } else if (booleanBrushSource === 'computer' && booleanBrushFile) {
        objectUrl = URL.createObjectURL(booleanBrushFile)
        sourceUrl = objectUrl
      }

      if (!sourceUrl) {
        booleanBrushMaskRef.current = null
        setBooleanBrushRevision(current => current + 1)
        return
      }

      try {
        const image = new Image()
        image.crossOrigin = 'anonymous'
        await new Promise((resolve, reject) => {
          image.onload = resolve
          image.onerror = () => reject(new Error('Failed to load boolean brush image.'))
          image.src = sourceUrl
        })

        if (cancelled) {
          return
        }

        booleanBrushMaskRef.current = createBooleanBrushMaskFromImage(image)
        setBooleanBrushRevision(current => current + 1)
      } catch (err) {
        if (cancelled) {
          return
        }
        booleanBrushMaskRef.current = null
        setBooleanBrushRevision(current => current + 1)
        setError(err instanceof Error ? err.message : 'Failed to load boolean brush image.')
      }
    }

    loadBooleanBrushMask()

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [booleanBrushAsset, booleanBrushFile, booleanBrushSource])

  const handlePaintBrushFileChange = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPaintBrushFile(file);
    setPaintBrushAsset(null);
    event.target.value = '';
  }, []);

  // Load the brush whenever the source changes. We fetch as a blob (then create
  // an object URL) so the resulting <img> draws onto a non-tainted canvas, which
  // is required for getImageData later on. We also pre-bake an alpha-only canvas
  // for the brush: PNGs distributed as black-on-white grayscale (no alpha channel)
  // are converted to alpha-from-luminance, while true alpha brushes are kept as-is.
  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;

    async function load() {
      let sourceUrl = null;
      if (paintBrushSource === 'asset' && paintBrushAsset) {
        sourceUrl = paintBrushAsset.url
          || (paintBrushAsset.filename
            ? `http://localhost:3001/assets/${encodeURI(paintBrushAsset.filename)}`
            : null);
      } else if (paintBrushSource === 'computer' && paintBrushFile) {
        objectUrl = URL.createObjectURL(paintBrushFile);
        sourceUrl = objectUrl;
      }

      if (!sourceUrl) {
        paintBrushImageRef.current = null;
        return;
      }

      try {
        // Fetch as blob → object URL so the image is same-origin and the
        // resulting canvas isn't tainted (drawImage + getImageData both work).
        let imageUrl = sourceUrl;
        if (paintBrushSource === 'asset') {
          const response = await fetch(sourceUrl);
          if (!response.ok) throw new Error(`Failed to fetch brush (${response.status})`);
          const blob = await response.blob();
          imageUrl = URL.createObjectURL(blob);
          objectUrl = imageUrl;
        }

        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('Failed to decode brush image'));
          image.src = imageUrl;
        });

        if (cancelled) return;

        // Bake an "alpha mask" canvas: pixels carry the brush shape as alpha,
        // RGB is white. This way stamping is just: drawImage + source-in fill.
        const w = image.naturalWidth || image.width;
        const h = image.naturalHeight || image.height;
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = w;
        maskCanvas.height = h;
        const mctx = maskCanvas.getContext('2d');
        mctx.drawImage(image, 0, 0);
        const imgData = mctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // Detect if PNG actually has an alpha channel (any pixel with alpha < 255).
        let hasAlpha = false;
        let hasMeaningfulColor = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 250) { hasAlpha = true; break; }
        }

        // Distinguish colored image brushes from grayscale mask brushes.
        // Transparent black/white/grayscale brushes should still take the
        // Tools color; only brushes with real RGB chroma keep their own color.
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue;
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (Math.max(red, green, blue) - Math.min(red, green, blue) > 10) {
            hasMeaningfulColor = true;
            break;
          }
        }

        // For PNGs without an alpha channel (typical black-on-white brushes),
        // derive alpha from luminance (darker pixel = more opaque) and convert
        // RGB to white so the brush is a clean alpha mask. Convention: black =
        // brush, white = no brush.
        // For grayscale brushes with alpha, keep the alpha but normalize RGB to
        // white so the Tools color is applied during stamping.
        // Only genuinely colored brushes preserve their RGB at stamp time.
        if (!hasAlpha) {
          for (let i = 0; i < data.length; i += 4) {
            const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.max(0, Math.min(255, Math.round(255 - luminance)));
          }
          mctx.putImageData(imgData, 0, 0);
        } else if (!hasMeaningfulColor) {
          for (let i = 0; i < data.length; i += 4) {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
          }
          mctx.putImageData(imgData, 0, 0);
        }

        // Tag the brush canvas so the stamp routine knows whether to tint it.
        // Only brushes with meaningful RGB chroma keep their own colors.
        // Grayscale masks, even with transparency, should use the Tools color.
        maskCanvas.__isColorBrush = hasMeaningfulColor;
        paintBrushImageRef.current = maskCanvas;
        if (!cancelled) setPaintBrushNaturalSize({ width: w, height: h });
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to load brush image:', err);
          paintBrushImageRef.current = null;
          setPaintBrushNaturalSize(null);
        }
      }
    }
    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [paintBrushSource, paintBrushAsset, paintBrushFile]);

  // -------- Paint document persistence --------
  const canvasToPngFile = useCallback(async (canvas, filename) => {
    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) {
          reject(new Error('Failed to encode canvas to PNG'));
          return;
        }
        resolve(new File([blob], filename, { type: 'image/png' }));
      }, 'image/png');
    });
  }, []);

  const loadImageToCanvas = useCallback(async (url, width, height) => {
    // Fetch as blob -> object URL so getImageData / re-export remains untainted.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Failed to decode image'));
        image.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = width || image.naturalWidth || image.width;
      canvas.height = height || image.naturalHeight || image.height;
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }, []);

  // When the asset under edit changes, drop the dirty flag from any previous mesh.
  useEffect(() => {
    if (paintDocDirtyForAssetIdRef.current !== numericAssetId) {
      paintDocDirtyForAssetIdRef.current = null;
    }
  }, [numericAssetId]);

  // Hydrate the paint document for the current asset (once per assetId).
  useEffect(() => {
    let cancelled = false;
    if (!texturableMesh?.textureCanvas) return undefined;
    if (!Number.isFinite(numericAssetId) || numericAssetId <= 0) return undefined;
    if (hydratedPaintDocAssetIdRef.current === numericAssetId) return undefined;

    hydratedPaintDocAssetIdRef.current = numericAssetId;

    (async () => {
      try {
        const doc = await getPaintDocument(numericAssetId);
        if (cancelled || !doc) return;

        // Remember that this asset has a server-side paint document so subsequent
        // saves keep it in sync (e.g. clean up after layers are deleted).
        paintDocDirtyForAssetIdRef.current = numericAssetId;

        const w = doc.textureWidth || texturableMesh.textureCanvas.width;
        const h = doc.textureHeight || texturableMesh.textureCanvas.height;

        if (doc.base?.url) {
          try {
            paintingBaseTextureRef.current = await loadImageToCanvas(doc.base.url, w, h);
          } catch (err) {
            console.warn('Failed to load paint base:', err);
          }
        }

        const hydratedLayers = [];
        for (const layer of doc.layers || []) {
          if (!layer?.url || !layer?.id) continue;
          try {
            const canvas = await loadImageToCanvas(layer.url, w, h);
            paintLayerCanvasesRef.current.set(layer.id, canvas);
            hydratedLayers.push({
              id: layer.id,
              name: layer.name || 'Layer',
              opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
              blendMode: layer.blendMode || 'source-over',
              color: layer.color || '#ffffff',
              visible: layer.visible !== false
            });
          } catch (err) {
            console.warn(`Failed to hydrate paint layer ${layer.id}:`, err);
          }
        }

        if (cancelled) return;

        // Bump counter so newly-painted layers get distinct names/ids.
        paintLayerCounterRef.current = Math.max(paintLayerCounterRef.current, hydratedLayers.length);

        setPaintLayers(hydratedLayers);
        setSelectedLayerId(null);
      } catch (err) {
        console.warn('Failed to load paint document:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [numericAssetId, texturableMesh, getPaintDocument, loadImageToCanvas]);

  const recompositePaintTexture = useCallback(() => {
    if (!texturableMesh?.textureCanvas || !paintingBaseTextureRef.current) {
      return;
    }
    const target = texturableMesh.textureCanvas;
    const ctx = target.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(paintingBaseTextureRef.current, 0, 0);

    // Reusable scratch canvas for tinted layer copies
    let tintCanvas = null;

    for (const layer of paintLayers) {
      if (!layer.visible) continue;
      const layerCanvas = paintLayerCanvasesRef.current.get(layer.id);
      if (!layerCanvas) continue;

      const lower = String(layer.color || '#ffffff').toLowerCase();
      const isWhite = lower === '#ffffff' || lower === '#fff';
      let sourceCanvas = layerCanvas;

      if (!isWhite) {
        if (!tintCanvas) {
          tintCanvas = document.createElement('canvas');
          tintCanvas.width = layerCanvas.width;
          tintCanvas.height = layerCanvas.height;
        }
        const tctx = tintCanvas.getContext('2d');
        tctx.globalAlpha = 1;
        tctx.globalCompositeOperation = 'source-over';
        tctx.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
        tctx.drawImage(layerCanvas, 0, 0);
        // Multiply by color, then restore the layer's alpha shape.
        tctx.globalCompositeOperation = 'multiply';
        tctx.fillStyle = layer.color;
        tctx.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(layerCanvas, 0, 0);
        tctx.globalCompositeOperation = 'source-over';
        sourceCanvas = tintCanvas;
      }

      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      ctx.globalCompositeOperation = layer.blendMode || 'source-over';
      ctx.drawImage(sourceCanvas, 0, 0);
    }
    ctx.restore();

    updateCanvasTexture(displayTextureRef.current);
    setTextureRevision(rev => rev + 1);
  }, [paintLayers, texturableMesh]);

  // Snapshot the base texture exactly once when entering painting mode.
  // We deliberately do NOT re-snapshot when the layer count changes; otherwise
  // deleting the last layer would re-capture the (still-composited) texture
  // canvas as a new base, baking the doomed layer in permanently.
  useEffect(() => {
    if (activeMenu !== 'painting' || !texturableMesh?.textureCanvas) return;
    if (paintingBaseTextureRef.current) return;

    const base = document.createElement('canvas');
    base.width = texturableMesh.textureCanvas.width;
    base.height = texturableMesh.textureCanvas.height;
    base.getContext('2d').drawImage(texturableMesh.textureCanvas, 0, 0);
    paintingBaseTextureRef.current = base;
  }, [activeMenu, texturableMesh]);

  // Recomposite when layer settings change
  useEffect(() => {
    if (activeMenu === 'painting') {
      recompositePaintTexture();
    }
  }, [activeMenu, recompositePaintTexture]);

  // Flatten layers when leaving painting mode so the composited texture is kept and other modes get a clean slate.
  const prevActiveMenuRef = useRef(activeMenu);
  useEffect(() => {
    if (prevActiveMenuRef.current === 'painting' && activeMenu !== 'painting') {
      // The textureCanvas already contains the composited result; just drop layer state.
      paintLayerCanvasesRef.current.clear();
      paintingBaseTextureRef.current = null;
      setPaintLayers([]);
      setSelectedLayerId(null);
      // Allow the persisted paint document to be re-hydrated if the user comes back.
      hydratedPaintDocAssetIdRef.current = null;
      // Note: we deliberately do NOT clear paintDocDirtyForAssetIdRef here, so
      // saving the mesh after exiting painting still lets the server clean up
      // any orphan layer files for this asset.
    }
    prevActiveMenuRef.current = activeMenu;
  }, [activeMenu]);

  // Stamp the brush onto a layer canvas at a UV point
  const stampBrushAtUv = useCallback((layerCanvas, uv, sizePx, rotationDeg, color, flow, hardness, blendMode, islandPath = null) => {
    const brushImage = paintBrushImageRef.current;
    if (!brushImage || !layerCanvas) return;

    const point = mapUvToCanvasPoint(
      uv,
      layerCanvas.width,
      layerCanvas.height,
      texturableMesh?.textureConfig || null
    );

    // Build a tinted+softened brush stamp on a temp canvas.
    // Preserve the brush's natural aspect ratio — sizePx is the longer dimension.
    const bw = brushImage.width;
    const bh = brushImage.height;
    const bAspect = bw > 0 && bh > 0 ? bw / bh : 1;
    let stampW, stampH;
    if (bAspect >= 1) {
      stampW = Math.max(1, Math.round(sizePx));
      stampH = Math.max(1, Math.round(sizePx / bAspect));
    } else {
      stampH = Math.max(1, Math.round(sizePx));
      stampW = Math.max(1, Math.round(sizePx * bAspect));
    }
    const stampCanvas = document.createElement('canvas');
    stampCanvas.width = stampW;
    stampCanvas.height = stampH;
    const sctx = stampCanvas.getContext('2d');
    // Draw brush scaled to size, preserving aspect ratio
    sctx.drawImage(brushImage, 0, 0, stampCanvas.width, stampCanvas.height);
    // Apply hardness as a soft fade: lower hardness => fade outer pixels
    if (hardness < 0.999) {
      const imgData = sctx.getImageData(0, 0, stampCanvas.width, stampCanvas.height);
      const data = imgData.data;
      const cx = stampCanvas.width / 2;
      const cy = stampCanvas.height / 2;
      const maxR = Math.max(cx, cy);
      const innerR = maxR * Math.max(0, Math.min(1, hardness));
      for (let i = 0; i < data.length; i += 4) {
        const px = ((i / 4) % stampCanvas.width);
        const py = Math.floor((i / 4) / stampCanvas.width);
        const dx = px - cx;
        const dy = py - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r <= innerR) continue;
        const fade = r >= maxR ? 0 : 1 - (r - innerR) / (maxR - innerR);
        data[i + 3] = Math.round(data[i + 3] * fade);
      }
      sctx.putImageData(imgData, 0, 0);
    }
    // Bake the brush color (from the Tools panel) into the stamp using
    // source-in so the brush alpha is preserved. The layer's own color
    // multiplies on top at composite time (white = no tint by default).
    // Skip tinting for color image brushes — those carry their own RGB and
    // should be drawn as-is, otherwise we'd overwrite the picture with a
    // flat color.
    const isColorBrush = brushImage.__isColorBrush === true;
    if (color && !isColorBrush) {
      sctx.globalCompositeOperation = 'source-in'
      sctx.fillStyle = color
      sctx.fillRect(0, 0, stampCanvas.width, stampCanvas.height)
      sctx.globalCompositeOperation = 'source-over'
    }

    // Draw stamp into layer canvas with flow alpha and rotation. When an
    // island path is provided, clip to it so a stamp landing near a UV
    // island border doesn't bleed into adjacent (unrelated) islands packed
    // next to it in the texture atlas. NOTE: This does not prevent paint
    // appearing on mirrored/overlapping UVs — those map to the same texels
    // by design and will always share painted pixels.
    const lctx = layerCanvas.getContext('2d');
    lctx.save();
    if (islandPath) {
      lctx.clip(islandPath);
    }
    lctx.globalAlpha = Math.max(0, Math.min(1, flow));
    lctx.globalCompositeOperation = blendMode || 'source-over';
    lctx.translate(point.x, point.y);
    if (rotationDeg) lctx.rotate((rotationDeg * Math.PI) / 180);
    lctx.drawImage(stampCanvas, -stampCanvas.width / 2, -stampCanvas.height / 2);
    lctx.restore();
  }, [texturableMesh]);

  // Begin a new paint stroke (creates a new layer)
  const beginPaintStroke = useCallback(() => {
    if (!texturableMesh?.textureCanvas) return null;
    const w = texturableMesh.textureCanvas.width;
    const h = texturableMesh.textureCanvas.height;
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = w;
    layerCanvas.height = h;

    paintLayerCounterRef.current += 1;
    const id = `layer-${Date.now()}-${paintLayerCounterRef.current}`;
    const layer = {
      id,
      name: `Layer ${paintLayerCounterRef.current}`,
      opacity: paintOpacity,
      blendMode: paintBlendMode,
      // Layer color defaults to white so the brush color (from the Tools
      // panel, baked into each stamp) is shown as-is. The user can still
      // tint the entire layer afterwards via the layer color picker.
      color: '#ffffff',
      visible: true
    };
    paintLayerCanvasesRef.current.set(id, layerCanvas);
    if (Number.isFinite(numericAssetId) && numericAssetId > 0) {
      paintDocDirtyForAssetIdRef.current = numericAssetId;
    }
    return { layer, layerCanvas };
  }, [paintBlendMode, paintOpacity, texturableMesh, numericAssetId]);

  // Layer management actions
  // Erase requires a selected layer. As soon as no layer is active, snap
  // the tool back to 'draw' so the UI can't get stuck in an unusable state.
  useEffect(() => {
    if (paintMode === 'erase' && !selectedLayerId) {
      setPaintMode('draw');
    }
  }, [paintMode, selectedLayerId]);

  // Clicking the active layer deselects it, so the next stroke creates a
  // brand-new layer. Otherwise selecting a layer makes subsequent strokes
  // paint into that layer.
  const handleSelectLayer = useCallback((id) => {
    setSelectedLayerId(prev => prev === id ? null : id);
  }, []);

  const handleUpdateLayer = useCallback((id, updates) => {
    setPaintLayers(prev => prev.map(layer => layer.id === id ? { ...layer, ...updates } : layer));
  }, []);

  const handleDeleteLayer = useCallback((id) => {
    paintLayerCanvasesRef.current.delete(id);
    setPaintLayers(prev => prev.filter(layer => layer.id !== id));
    setSelectedLayerId(prev => prev === id ? null : prev);
  }, []);

  const handleMoveLayer = useCallback((id, direction) => {
    setPaintLayers(prev => {
      const index = prev.findIndex(layer => layer.id === id);
      if (index === -1) return prev;
      // Higher array index = drawn last = visually on top.
      // "up" in the panel means move toward the top of the visual stack.
      const target = direction === 'up' ? index + 1 : index - 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const handleClearAllLayers = useCallback(() => {
    paintLayerCanvasesRef.current.clear();
    setPaintLayers([]);
    setSelectedLayerId(null);
  }, []);

  useEffect(() => () => geometry?.dispose?.(), [geometry])

  // --- Sculpting: build / dispose the sculpt context per geometry. -------
  // The context owns CSR adjacency arrays, a uniform spatial grid, and
  // scratch buffers, all sized to the current vertex count. A new geometry
  // (post-modeling edits or a freshly loaded mesh) means we throw it away.
  useEffect(() => {
    if (!geometry) {
      sculptContextRef.current = null;
      sculptMeshRef.current = null;
      sculptUndoStackRef.current = [];
      sculptRedoStackRef.current = [];
      setSculptCanUndo(false);
      setSculptCanRedo(false);
      return undefined;
    }

    let ctx = null;
    try {
      ctx = createSculptContext(geometry);
    } catch (err) {
      console.warn('Could not create sculpt context:', err);
      sculptContextRef.current = null;
      return undefined;
    }
    sculptContextRef.current = ctx;
    sculptUndoStackRef.current = [];
    sculptRedoStackRef.current = [];
    setSculptCanUndo(false);
    setSculptCanRedo(false);

    // Make sure the BVH exists for accelerated raycasting (meshEditor.js
    // patches the prototype but doesn't always call computeBoundsTree).
    if (!geometry.boundsTree && typeof geometry.computeBoundsTree === 'function') {
      geometry.computeBoundsTree();
    }

    // Default brush size = ~8% of the bounding sphere radius. Also derive a
    // sensible slider range so users don't have to scrub through huge values.
    geometry.computeBoundingSphere();
    const r = geometry.boundingSphere?.radius || 1;
    setSculptSizeRange({ min: r * 0.001, max: r * 1.0 });
    setSculptSize(prev => (prev > 0 && prev < r * 2 ? prev : r * 0.08));

    return () => {
      // Drop refs so the next geometry rebuilds adjacency cleanly.
      if (sculptContextRef.current === ctx) {
        sculptContextRef.current = null;
        sculptMeshRef.current = null;
      }
    };
  }, [geometry]);

  // Build / refresh the raycast Object3D for sculpt mode. Reuses the same
  // geometry instance (so BVH refits during a stroke take effect), and is
  // identity-positioned in world space.
  const ensureSculptMesh = useCallback(() => {
    if (!geometry) return null;
    if (!sculptMeshRef.current || sculptMeshRef.current.geometry !== geometry) {
      const mesh = new THREE.Mesh(geometry);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrixWorld(true);
      sculptMeshRef.current = mesh;
    }
    return sculptMeshRef.current;
  }, [geometry]);

  // Compute screen-space pixel radius of a world-space brush at a given hit
  // point, for the cursor ring overlay.
  const computeSculptCursorPixelRadius = useCallback((worldHitPoint, canvasHeight) => {
    const camera = cameraRef.current;
    if (!camera || !worldHitPoint) return 24;
    const distance = camera.position.distanceTo(worldHitPoint);
    const fovRad = (camera.fov || 50) * Math.PI / 180;
    const worldHeightAtDistance = 2 * Math.tan(fovRad / 2) * distance;
    if (worldHeightAtDistance <= 0) return 24;
    return Math.max(4, (sculptSize / worldHeightAtDistance) * canvasHeight);
  }, [sculptSize]);

  const pushSculptUndo = useCallback(() => {
    if (!geometry) return;
    const stack = sculptUndoStackRef.current;
    stack.push(sculptSnapshotPositions(geometry));
    // Keep at most ~10 strokes of history (Float32Array * 3 * vertCount).
    while (stack.length > 10) stack.shift();
    // A new action invalidates the redo history.
    sculptRedoStackRef.current.length = 0;
    setSculptCanUndo(true);
    setSculptCanRedo(false);
  }, [geometry]);

  const handleSculptUndo = useCallback(() => {
    if (!geometry) return;
    const undoStack = sculptUndoStackRef.current;
    const snap = undoStack.pop();
    if (!snap) {
      setSculptCanUndo(false);
      return;
    }
    // Save the current state into the redo stack so the user can replay.
    const redoStack = sculptRedoStackRef.current;
    redoStack.push(sculptSnapshotPositions(geometry));
    while (redoStack.length > 10) redoStack.shift();

    sculptRestorePositions(geometry, snap);
    if (sculptContextRef.current) invalidateSculptGrid(sculptContextRef.current);
    setGeometryRevision(rev => rev + 1);
    setSculptCanUndo(undoStack.length > 0);
    setSculptCanRedo(true);
  }, [geometry]);

  const handleSculptRedo = useCallback(() => {
    if (!geometry) return;
    const redoStack = sculptRedoStackRef.current;
    const snap = redoStack.pop();
    if (!snap) {
      setSculptCanRedo(false);
      return;
    }
    const undoStack = sculptUndoStackRef.current;
    undoStack.push(sculptSnapshotPositions(geometry));
    while (undoStack.length > 10) undoStack.shift();

    sculptRestorePositions(geometry, snap);
    if (sculptContextRef.current) invalidateSculptGrid(sculptContextRef.current);
    setGeometryRevision(rev => rev + 1);
    setSculptCanUndo(true);
    setSculptCanRedo(redoStack.length > 0);
  }, [geometry]);

  // Apply a single brush stamp at a given object-space point with the given
  // surface normal. Mutates geometry buffers in place and runs an
  // incremental normal recompute over the touched triangle fan.
  //
  // Handles symmetry by re-running the kernel for each mirror combination,
  // and front-faces-only by post-filtering the queried vertex set against
  // the (mirrored) camera position.
  const applySculptStamp = useCallback((point, normal) => {
    const ctx = sculptContextRef.current;
    if (!ctx) return;
    ensureSculptGrid(ctx, sculptSize);

    const keys = sculptStrokeKeysRef.current;
    const direction = (keys.ctrl ? -sculptDirection : sculptDirection);
    const isSmoothing = keys.shift || sculptBrush === 'smooth';
    // The reference per-stamp displacement scales with brush radius so
    // strength stays radius-independent.
    const displacement = sculptSize;

    let cameraX = 0, cameraY = 0, cameraZ = 0;
    if (sculptFrontFacesOnly && cameraRef.current) {
      cameraX = cameraRef.current.position.x;
      cameraY = cameraRef.current.position.y;
      cameraZ = cameraRef.current.position.z;
    }

    const mirrors = sculptGetSymmetryMirrors(sculptSymmetry);
    for (let m = 0; m < mirrors.length; m++) {
      const sx = mirrors[m][0];
      const sy = mirrors[m][1];
      const sz = mirrors[m][2];
      const px = point.x * sx;
      const py = point.y * sy;
      const pz = point.z * sz;
      const nx = normal.x * sx;
      const ny = normal.y * sy;
      const nz = normal.z * sz;

      const queried = sculptQueryRadius(ctx, px, py, pz, sculptSize, sculptHardness);
      if (queried === 0) continue;

      let count = queried;
      if (sculptFrontFacesOnly) {
        count = sculptFilterFrontFacing(
          ctx, ctx._outIndices, ctx._outWeights, queried,
          cameraX * sx, cameraY * sy, cameraZ * sz
        );
        if (count === 0) continue;
      }

      // Optional textured-falloff modulation: multiply the per-vertex
      // weights by an alpha map sampled across the brush's tangent plane.
      // Vertices outside the brush footprint get weight 0; the kernels
      // multiply by weight so they no-op on those.
      const stamp = sculptStampRef.current;
      if (stamp) {
        applySculptBrushTextureWeights(
          ctx, ctx._outIndices, ctx._outWeights, count,
          px, py, pz, nx, ny, nz,
          sculptSize, stamp.alphaMap, stamp.width, stamp.height,
          (sculptStampRotation * Math.PI) / 180
        );
      }

      if (isSmoothing) {
        applySculptSmooth(ctx, ctx._outIndices, ctx._outWeights, count, sculptStrength);
      } else if (sculptBrush === 'inflate') {
        applySculptInflate(ctx, ctx._outIndices, ctx._outWeights, count, sculptStrength, displacement, direction);
      } else if (sculptBrush === 'flatten') {
        applySculptFlatten(ctx, ctx._outIndices, ctx._outWeights, count,
          px, py, pz, nx, ny, nz, sculptStrength, direction);
      } else if (sculptBrush === 'clay') {
        applySculptClay(ctx, ctx._outIndices, ctx._outWeights, count,
          px, py, pz, nx, ny, nz, sculptStrength, displacement, direction);
      } else if (sculptBrush === 'pinch') {
        applySculptPinch(ctx, ctx._outIndices, ctx._outWeights, count,
          px, py, pz, nx, ny, nz, sculptStrength, direction);
      } else {
        // 'standard' (and any unknown brush) — push along the brush normal.
        // We pass a bare {x,y,z} object (the kernel only reads .x/.y/.z and
        // never mutates) to avoid allocating a Vector3 per stamp.
        applySculptStandard(
          ctx, ctx._outIndices, ctx._outWeights, count,
          { x: nx, y: ny, z: nz },
          sculptStrength, displacement, direction
        );
      }

      // Auto-smooth: blend in a fraction of the smooth kernel after every
      // stamp (except when the user is already smoothing — auto-smoothing
      // a smooth stroke would just compound to no useful effect).
      if (sculptAutoSmooth > 0 && !isSmoothing) {
        applySculptSmooth(
          ctx, ctx._outIndices, ctx._outWeights, count,
          sculptAutoSmooth * sculptStrength
        );
      }
    }

    sculptIncrementalNormals(ctx);
    ctx.geometry.attributes.position.needsUpdate = true;
    ctx.geometry.attributes.normal.needsUpdate = true;
  }, [sculptAutoSmooth, sculptBrush, sculptDirection, sculptFrontFacesOnly, sculptHardness, sculptSize, sculptStampRotation, sculptStrength, sculptSymmetry]);

  // Cancel any active sculpt stroke (used by pointercancel / mode switch).
  const cancelSculptStroke = useCallback(() => {
    const stroke = sculptStrokeRef.current;
    if (!stroke) return;
    canvasShellRef.current?.releasePointerCapture?.(stroke.pointerId);
    sculptStrokeRef.current = null;
  }, []);

  // When leaving sculpting mode, drop the cursor and any in-flight stroke.
  useEffect(() => {
    if (activeMenu !== 'sculpting') {
      cancelSculptStroke();
      setSculptCursor(null);
    }
  }, [activeMenu, cancelSculptStroke]);

  // Keyboard shortcuts within sculpting mode: Ctrl/Cmd+Z = undo,
  // Ctrl/Cmd+Shift+Z and Ctrl+Y = redo. Ignored while typing in form
  // fields so the layer/brush name editors keep their own undo behavior.
  useEffect(() => {
    if (activeMenu !== 'sculpting') return undefined;
    const onKey = (event) => {
      const target = event.target;
      if (target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      )) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleSculptUndo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        handleSculptRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeMenu, handleSculptUndo, handleSculptRedo]);

  // Load the active textured stamp into a flat Uint8Array alpha map so the
  // sculpt kernel can sample it without canvas API calls in the hot loop.
  // Mirrors the painting-mode brush loader: PNGs without alpha are converted
  // to alpha-from-luminance (black = brush, white = no brush); PNGs with
  // an explicit alpha channel are kept as-is.
  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;

    async function load() {
      if (sculptStampSource === 'none') {
        sculptStampRef.current = null;
        return;
      }

      let sourceUrl = null;
      if (sculptStampSource === 'asset' && sculptStampAsset) {
        sourceUrl = sculptStampAsset.url
          || (sculptStampAsset.filename
            ? `http://localhost:3001/assets/${encodeURI(sculptStampAsset.filename)}`
            : null);
      } else if (sculptStampSource === 'computer' && sculptStampFile) {
        objectUrl = URL.createObjectURL(sculptStampFile);
        sourceUrl = objectUrl;
      }
      if (!sourceUrl) {
        sculptStampRef.current = null;
        return;
      }

      try {
        let imageUrl = sourceUrl;
        if (sculptStampSource === 'asset') {
          const response = await fetch(sourceUrl);
          if (!response.ok) throw new Error(`Failed to fetch stamp (${response.status})`);
          const blob = await response.blob();
          imageUrl = URL.createObjectURL(blob);
          objectUrl = imageUrl;
        }

        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('Failed to decode stamp image'));
          image.src = imageUrl;
        });
        if (cancelled) return;

        const w = image.naturalWidth || image.width;
        const h = image.naturalHeight || image.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const cctx = canvas.getContext('2d');
        cctx.drawImage(image, 0, 0);
        const pixels = cctx.getImageData(0, 0, w, h).data;

        // Detect a real alpha channel.
        let hasAlpha = false;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] < 250) { hasAlpha = true; break; }
        }

        const alphaMap = new Uint8Array(w * h);
        if (hasAlpha) {
          for (let i = 0; i < w * h; i++) alphaMap[i] = pixels[i * 4 + 3];
        } else {
          for (let i = 0; i < w * h; i++) {
            const luminance = 0.299 * pixels[i * 4]
              + 0.587 * pixels[i * 4 + 1]
              + 0.114 * pixels[i * 4 + 2];
            alphaMap[i] = Math.max(0, Math.min(255, Math.round(255 - luminance)));
          }
        }

        if (!cancelled) {
          sculptStampRef.current = { alphaMap, width: w, height: h };
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to load sculpt stamp:', err);
          sculptStampRef.current = null;
        }
      }
    }
    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sculptStampSource, sculptStampAsset, sculptStampFile]);


  useEffect(() => () => displayTextureRef.current?.dispose?.(), [])

  useEffect(() => () => maskTextureRef.current?.dispose?.(), [])

  useEffect(() => {
    setProjectionOpacities(current => {
      const next = current.slice(0, multiViewCount)

      while (next.length < multiViewCount) {
        next.push(1)
      }

      return next.length === current.length && next.every((value, index) => value === current[index])
        ? current
        : next
    })
  }, [multiViewCount])

  const syncProjectionMaskCanvasSize = useCallback(() => {
    const shell = canvasShellRef.current
    const projectionMaskCanvas = projectionMaskCanvasRef.current

    if (!shell || !projectionMaskCanvas) {
      return
    }

    const rect = shell.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))

    if (projectionMaskCanvas.width === width && projectionMaskCanvas.height === height) {
      return
    }

    const previousCanvas = projectionMaskCanvas.width > 0 && projectionMaskCanvas.height > 0
      ? Object.assign(document.createElement('canvas'), {
        width: projectionMaskCanvas.width,
        height: projectionMaskCanvas.height
      })
      : null

    if (previousCanvas) {
      previousCanvas.getContext('2d').drawImage(projectionMaskCanvas, 0, 0)
    }

    projectionMaskCanvas.width = width
    projectionMaskCanvas.height = height

    if (previousCanvas) {
      projectionMaskCanvas.getContext('2d').drawImage(previousCanvas, 0, 0, width, height)
    }

    if (projectionCameraRef.current && 'aspect' in projectionCameraRef.current) {
      projectionCameraRef.current.aspect = width / height
      projectionCameraRef.current.updateProjectionMatrix?.()
      projectionCameraRef.current.updateMatrixWorld?.(true)
    }
  }, [])

  const updateMaskOverlay = useCallback(() => {
    const maskCanvas = projectionMaskCanvasRef.current;
    const overlayCanvas = maskOverlayCanvasRef.current;
    if (!maskCanvas || !overlayCanvas) return;

    const ctx = overlayCanvas.getContext('2d');
    const { width, height } = maskCanvas;
    overlayCanvas.width = width;
    overlayCanvas.height = height;
    ctx.clearRect(0, 0, width, height);

    // Compute mask bounding box
    const bbox = getMaskBoundingBox(maskCanvas, 0); // no extra padding here
    if (!bbox) return;

    // Expand by cropPadding
    const cropLeft = Math.max(0, bbox.x - cropPadding);
    const cropTop = Math.max(0, bbox.y - cropPadding);
    const cropRight = Math.min(width, bbox.x + bbox.width + cropPadding);
    const cropBottom = Math.min(height, bbox.y + bbox.height + cropPadding);
    const cropWidth = cropRight - cropLeft;
    const cropHeight = cropBottom - cropTop;

    // Draw crop rectangle (white dashed)
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([5, 8]);
    ctx.lineWidth = 2;
    ctx.strokeRect(cropLeft, cropTop, cropWidth, cropHeight);
    ctx.setLineDash([]); // reset

    // Draw feather area (a semi-transparent gradient from the crop rectangle inward)
    if (featherRadius > 0) {
      // Create a gradient that fades from the crop edge towards the center
      // Simpler: draw a stroked inner rectangle with fading opacity? 
      // Better: use a radial gradient or multiple strokes.
      // We'll draw a series of thin rectangles from the crop edge inward.
      const steps = Math.min(featherRadius, 20);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps; // 0 (outer) -> 1 (inner)
        const alpha = 0.3 * (1 - t); // fades out inward
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = 2;
        const inset = i * (featherRadius / steps);
        ctx.strokeRect(
          cropLeft + inset,
          cropTop + inset,
          cropWidth - inset * 2,
          cropHeight - inset * 2
        );
      }
    }
    ctx.restore();
  }, [cropPadding, featherRadius]);

  useEffect(() => {
    if (activeMenu === 'texturing') {
      updateMaskOverlay();
    }
  }, [cropPadding, featherRadius, updateMaskOverlay, activeMenu]);

  useEffect(() => {
    syncProjectionMaskCanvasSize()

    if (typeof ResizeObserver === 'undefined' || !canvasShellRef.current) {
      return
    }

    const observer = new ResizeObserver(() => {
      syncProjectionMaskCanvasSize()
    })

    observer.observe(canvasShellRef.current)
    return () => observer.disconnect()
  }, [syncProjectionMaskCanvasSize])

  useEffect(() => {
    clearCanvas(projectionMaskCanvasRef.current)
    projectionCameraRef.current = null
    setHasProjectionMask(false)
  }, [texturableMesh])

  useEffect(() => {
    const root = texturableMesh?.root
    if (!root) {
      texturableEditableMeshRef.current = null
      return
    }

    const textureKey = texturableMesh?.textureKey || ''
    let fallbackMesh = null
    let matchedMesh = null

    root.traverse(child => {
      if (!child.isMesh) {
        return
      }

      if (!fallbackMesh) {
        fallbackMesh = child
      }

      if (matchedMesh || !textureKey) {
        return
      }

      const materials = Array.isArray(child.material) ? child.material : [child.material]
      const hasMatchingTexture = materials.some(material => getTextureKeyFromMaterial(material) === textureKey)
      if (hasMatchingTexture) {
        matchedMesh = child
      }
    })

    texturableEditableMeshRef.current = matchedMesh || fallbackMesh
  }, [texturableMesh?.root, texturableMesh?.textureKey])

  useEffect(() => {
    const root = texturableMesh?.root
    if (!root || !geometry) {
      return
    }

    let targetMesh = texturableEditableMeshRef.current

    if (!targetMesh) {
      root.traverse(child => {
        if (!targetMesh && child.isMesh) {
          targetMesh = child
        }
      })
      texturableEditableMeshRef.current = targetMesh
    }

    if (!targetMesh) {
      return
    }

    targetMesh.geometry = geometry
    targetMesh.updateMatrixWorld(true)
    root.updateMatrixWorld(true)
  }, [geometry, geometryRevision, texturableMesh])

  useEffect(() => {
    let cancelled = false

    async function loadWorkflows() {
      try {
        setComfyLoading(true)
        const workflows = await getComfyWorkflows()

        if (!cancelled) {
          setComfyWorkflows(workflows)
        }
      } catch (workflowError) {
        if (!cancelled) {
          console.error('Failed to load ComfyUI workflows:', workflowError)
        }
      } finally {
        if (!cancelled) {
          setComfyLoading(false)
        }
      }
    }

    loadWorkflows()

    return () => {
      cancelled = true
    }
  }, [getComfyWorkflows])

  useEffect(() => {
    let cancelled = false

    async function loadGeometry() {
      if (!modelUrl) {
        setError('Mesh URL is missing.')
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        setError('')
        const loadedRoot = await loadMeshRootFromUrl(modelUrl)
        const texturableStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

        const geometryPromise = Promise.resolve().then(() => loadEditableGeometryFromObject(loadedRoot)).then(loadedGeometry => {
          return loadedGeometry
        })

        const texturableMeshPromise = loadTexturableMeshFromRoot(loadedRoot, { url: modelUrl, startedAt: texturableStartedAt })
          .then(loadedTexturableMesh => {
            return loadedTexturableMesh
          })
          .catch(textureError => ({
            root: loadedRoot,
            textureCanvas: null,
            textureKey: '',
            textureConfig: null,
            supportError: textureError.message || 'Texture editing is unavailable for this mesh.'
          }))

        const [loadedGeometry, loadedTexturableMesh] = await Promise.all([geometryPromise, texturableMeshPromise])

        if (!cancelled) {
          setGeometry(loadedGeometry)
          setTexturableMesh(loadedTexturableMesh?.textureCanvas
            ? {
              ...loadedTexturableMesh,
              maskCanvas: Object.assign(document.createElement('canvas'), {
                width: loadedTexturableMesh.textureCanvas.width,
                height: loadedTexturableMesh.textureCanvas.height
              })
            }
            : loadedTexturableMesh)
          setGeometryRevision(0)
          setTextureRevision(0)
          setSelectedFaceIndices([])
          setSelectedVertexIndices([])
          setHoleLoops([])
          // Bump the camera framing key so CameraRig re-frames the new mesh.
          // Topology edits below do NOT bump this so the view stays put.
          setMeshFrameKey(key => key + 1)
          // Clear any modeling history from the previously loaded mesh.
          modelingUndoStackRef.current = []
          modelingRedoStackRef.current = []
          setModelingCanUndo(false)
          setModelingCanRedo(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Failed to load mesh editor')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadGeometry()

    return () => {
      cancelled = true
    }
  }, [modelUrl])

  useEffect(() => {
    displayTextureRef.current?.dispose?.()
    maskTextureRef.current?.dispose?.()
    displayTextureRef.current = null
    maskTextureRef.current = null

    if (!texturableMesh?.textureCanvas || !texturableMesh?.maskCanvas) {
      return
    }

    displayTextureRef.current = createCanvasTexture(texturableMesh.textureCanvas, texturableMesh.textureConfig)
    maskTextureRef.current = createCanvasTexture(texturableMesh.maskCanvas, texturableMesh.textureConfig)
    setTextureRevision(current => current + 1)
  }, [texturableMesh])

  const texturingWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const valueTypes = (workflow.parameters || []).map(parameter => getWorkflowValueType(parameter))
      const imageInputCount = valueTypes.filter(valueType => valueType === 'image').length
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return imageInputCount >= 2
        && outputValueTypes.includes('image')
        && valueTypes.every(valueType => ['image', 'string', 'number', 'boolean'].includes(valueType))
    })
  }, [comfyWorkflows])

  const projectionWorkflows = useMemo(() => {
    return comfyWorkflows.filter(workflow => {
      const valueTypes = (workflow.parameters || []).map(parameter => getWorkflowValueType(parameter))
      const imageInputCount = valueTypes.filter(valueType => valueType === 'image').length
      const outputValueTypes = (workflow.outputs || []).map(output => output.valueType || 'image')

      return imageInputCount >= 1
        && outputValueTypes.includes('image')
        && valueTypes.every(valueType => ['image', 'string', 'number', 'boolean'].includes(valueType))
    })
  }, [comfyWorkflows])

  useEffect(() => {
    if (texturingWorkflows.length === 0) {
      setTextureWorkflowId('')
      return
    }

    setTextureWorkflowId(current => (
      texturingWorkflows.some(workflow => String(workflow.id) === String(current))
        ? current
        : String(texturingWorkflows[0].id)
    ))
  }, [texturingWorkflows])

  useEffect(() => {
    if (projectionWorkflows.length === 0) {
      setProjectionWorkflowId('')
      return
    }

    setProjectionWorkflowId(current => (
      projectionWorkflows.some(workflow => String(workflow.id) === String(current))
        ? current
        : String(projectionWorkflows[0].id)
    ))
  }, [projectionWorkflows])

  const selectedTextureWorkflow = useMemo(() => {
    return texturingWorkflows.find(workflow => String(workflow.id) === String(textureWorkflowId)) || null
  }, [textureWorkflowId, texturingWorkflows])

  const selectedProjectionWorkflow = useMemo(() => {
    return projectionWorkflows.find(workflow => String(workflow.id) === String(projectionWorkflowId)) || null
  }, [projectionWorkflowId, projectionWorkflows])

  useEffect(() => {
    setTextureWorkflowInputs(createTexturePaintWorkflowDraft(selectedTextureWorkflow))
  }, [selectedTextureWorkflow])

  useEffect(() => {
    setProjectionWorkflowInputs(createTexturePaintWorkflowDraft(selectedProjectionWorkflow))
  }, [selectedProjectionWorkflow])

  const editableGeometryHasUvs = !!geometry?.attributes?.uv?.count
  const texturingUnavailableReason = useMemo(() => {
    if (!editableGeometryHasUvs) {
      return 'The edited mesh has no UVs, so texturing and painting are unavailable for this revision.'
    }

    if (texturableMesh?.supportError) {
      return texturableMesh.supportError
    }

    if (!texturableMesh?.textureCanvas || !texturableMesh?.maskCanvas) {
      return 'Texture painting is unavailable for this mesh.'
    }

    return ''
  }, [editableGeometryHasUvs, texturableMesh])

  const handleImageParamSourceChange = (paramId, type, value = null) => {
    setImageParamSources(prev => {
      const newSources = { ...prev };
      // If setting as source or mask, unset any other param with same type
      if (type === 'source') {
        for (const [id, config] of Object.entries(newSources)) {
          if (config.type === 'source' && id !== paramId) {
            newSources[id] = { type: 'none' };
          }
        }
      } else if (type === 'mask') {
        for (const [id, config] of Object.entries(newSources)) {
          if (config.type === 'mask' && id !== paramId) {
            newSources[id] = { type: 'none' };
          }
        }
      }
      if (type === 'asset') {
        newSources[paramId] = { type: 'asset', assetId: value?.id, assetName: value?.name, filePath: value?.filePath };
      } else if (type === 'file') {
        newSources[paramId] = { type: 'file', file: value, fileName: value?.name };
      } else {
        newSources[paramId] = { type };
      }
      return newSources;
    });
  };

  useEffect(() => {
    if (!selectedTextureWorkflow) {
      setImageParamSources({});
      return;
    }
    // Use parameters, filter image inputs
    const imageParams = (selectedTextureWorkflow.parameters || [])
      .filter(param => getWorkflowValueType(param) === 'image');
    const defaultSources = {};
    // Auto-detect mask: look for 'mask' in name
    let maskParamId = null;
    let sourceParamId = null;
    for (const param of imageParams) {
      const nameLower = (param.name || '').toLowerCase();
      if (nameLower.includes('mask')) {
        maskParamId = param.id;
      } else if (!sourceParamId) {
        sourceParamId = param.id;
      }
    }
    // If no mask found, pick second param as mask
    if (!maskParamId && imageParams.length >= 2) {
      maskParamId = imageParams[1].id;
      sourceParamId = imageParams[0].id;
    }
    for (const param of imageParams) {
      if (param.id === sourceParamId) {
        defaultSources[param.id] = { type: 'source' };
      } else if (param.id === maskParamId) {
        defaultSources[param.id] = { type: 'mask' };
      } else {
        defaultSources[param.id] = { type: 'none' };
      }
    }
    setImageParamSources(defaultSources);
  }, [selectedTextureWorkflow]);

  const handleProjectionImageParamSourceChange = useCallback((paramId, type, value = null) => {
    setProjectionImageParamSources(prev => {
      const next = { ...prev }

      if (type === 'position-view') {
        for (const [id, config] of Object.entries(next)) {
          if (config.type === 'position-view' && id !== paramId) {
            next[id] = { type: 'none' }
          }
        }
      }

      if (type === 'textured-view') {
        for (const [id, config] of Object.entries(next)) {
          if (config.type === 'textured-view' && id !== paramId) {
            next[id] = { type: 'none' }
          }
        }
      }

      if (type === 'untextured-view') {
        for (const [id, config] of Object.entries(next)) {
          if (config.type === 'untextured-view' && id !== paramId) {
            next[id] = { type: 'none' }
          }
        }
      }

      if (type === 'asset') {
        next[paramId] = {
          type: 'asset',
          assetId: value?.id,
          assetName: value?.name,
          filePath: value?.filePath,
          asset: value || null
        }
      } else if (type === 'file') {
        next[paramId] = { type: 'file', file: value, fileName: value?.name }
      } else {
        next[paramId] = { type }
      }

      return next
    })
  }, [])

  useEffect(() => {
    if (!selectedProjectionWorkflow) {
      setProjectionImageParamSources({})
      return
    }

    const imageParams = (selectedProjectionWorkflow.parameters || [])
      .filter(param => getWorkflowValueType(param) === 'image')
    const defaults = {}

    imageParams.forEach((param, index) => {
      defaults[param.id] = { type: index === 0 ? 'position-view' : 'none' }
    })

    setProjectionImageParamSources(defaults)
  }, [selectedProjectionWorkflow])

  const texturingReady = !loading && !texturingUnavailableReason && !!selectedTextureWorkflow && !!displayTextureRef.current && !!maskTextureRef.current
  const projectionReady = !loading && !texturingUnavailableReason && !!selectedProjectionWorkflow && !!displayTextureRef.current

  // Texturing & Painting both require a textured material with valid UVs.
  // While the mesh is still loading we keep the modes enabled (otherwise the
  // tabs would flicker on/off); once loading completes, a missing texture
  // canvas or an explicit support error disables both modes.
  const textureModesSupported = loading
    ? true
    : !!texturableMesh?.textureCanvas && !texturableMesh?.supportError
  const textureModesDisabledReason = textureModesSupported
    ? ''
    : (texturableMesh?.supportError || 'This mesh has no material or UVs, so texturing, painting, and projection are unavailable.')

  // If the active tab becomes unsupported after the mesh finishes loading
  // (e.g. a UV-less mesh), fall back to Modeling so the panel stays usable.
  useEffect(() => {
    if (!textureModesSupported && (activeMenu === 'texturing' || activeMenu === 'painting' || activeMenu === 'projection')) {
      setActiveMenu('modeling')
    }
  }, [activeMenu, textureModesSupported])

  const projectionWorkflowParameters = useMemo(() => {
    return (selectedProjectionWorkflow?.parameters || []).filter(parameter => getWorkflowValueType(parameter) !== 'image')
  }, [selectedProjectionWorkflow])

	const rebuildProjectedTexturePreview = useCallback(() => {
		if (
			!pendingPatch
			|| !originalTextureBackupRef.current
			|| !texturableMesh?.textureCanvas
			|| projectionViewDataRef.current.length === 0
		) {
			return
		}

		const textureWidth = texturableMesh.textureCanvas.width
		const textureHeight = texturableMesh.textureCanvas.height
		const patchedCanvas = document.createElement('canvas')
		patchedCanvas.width = textureWidth
		patchedCanvas.height = textureHeight
		const patchedContext = patchedCanvas.getContext('2d')
		patchedContext.drawImage(originalTextureBackupRef.current, 0, 0)

		// --- Normalize opacities ---
		const rawOpacities = projectionOpacities.slice(0, projectionViewDataRef.current.length)
		const totalOpacity = rawOpacities.reduce((sum, v) => sum + Math.max(0, Math.min(1, v)), 0)
		const divisor = Math.max(1, totalOpacity)

		if (totalOpacity <= 0) {
			patchedContext.drawImage(originalTextureBackupRef.current, 0, 0)
		} else {
			projectionViewDataRef.current.forEach((viewData, viewIndex) => {
				const raw = Math.max(0, Math.min(1, projectionOpacities[viewIndex] ?? 1))
				if (raw <= 0 || !viewData?.patchCanvas) return
				const normalizedAlpha = raw / divisor
				patchedContext.globalAlpha = normalizedAlpha
				patchedContext.drawImage(viewData.patchCanvas, 0, 0)
			})
		}
		patchedContext.globalAlpha = 1
		patchedTextureRef.current = patchedCanvas

		// Apply blending with additional smoothing
		applyPatchBlendToCanvas(
			originalTextureBackupRef.current,
			patchedCanvas,
			texturableMesh.textureCanvas,
			1,
			patchNoise,
			patchSharpness,
			patchSaturation,
			projectionMaskBackupRef.current,
			Math.max(featherRadius, 4) // Force minimum feather for preview
		)
		updateCanvasTexture(displayTextureRef.current)
		setTextureRevision(current => current + 1)
	}, [patchNoise, patchSharpness, patchSaturation, pendingPatch, projectionOpacities, texturableMesh, featherRadius])

  useEffect(() => {
    void rebuildProjectedTexturePreview()
  }, [rebuildProjectedTexturePreview, projectionOpacities])

  const stats = useMemo(() => ({
    geometryRevision,
    vertices: geometry?.attributes?.position?.count || 0,
    faces: geometryFaceCount(geometry)
  }), [geometry, geometryRevision])
  const availableHoleLoops = useMemo(() => {
    void geometryRevision
    if (!geometry) {
      return []
    }

    return getSelectedHoleLoops(geometry, {
      selectionMode,
      selectedFaceIndices,
      selectedVertexIndices
    })
  }, [geometry, geometryRevision, selectedFaceIndices, selectedVertexIndices, selectionMode])
  const selectionMesh = useMemo(() => {
    if (!geometry) {
      return null
    }

    const mesh = new THREE.Mesh(geometry)
    mesh.updateMatrixWorld(true)
    return mesh
  }, [geometry])

  const booleanStampLocalGeometry = useMemo(() => {
    void booleanBrushRevision
    const mask = booleanBrushMaskRef.current
    if (!mask) {
      return null
    }

    return buildBooleanStampGeometry(mask, booleanStampSize, booleanStampDepth)
  }, [booleanBrushRevision, booleanStampDepth, booleanStampSize])

  const booleanMaskTexture = useMemo(() => {
    void booleanBrushRevision
    const mask = booleanBrushMaskRef.current
    if (!mask?.alpha || !mask.width || !mask.height) {
      return null
    }

    const texture = new THREE.DataTexture(mask.alpha, mask.width, mask.height, THREE.RedFormat)
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.flipY = false
    texture.generateMipmaps = false
    texture.needsUpdate = true
    return texture
  }, [booleanBrushRevision])

  const booleanStampMatrix = useMemo(() => {
    if (!booleanStampBasis) {
      return null
    }

    return buildBooleanStampMatrix(
      booleanStampBasis,
      booleanStampRotation,
      booleanStampOffset,
      booleanStampNudgeX,
      booleanStampNudgeY
    )
  }, [booleanStampBasis, booleanStampNudgeX, booleanStampNudgeY, booleanStampOffset, booleanStampRotation])

  const booleanPreviewGeometry = useMemo(() => {
    if (!geometry || activeMenu !== 'boolean' || !booleanStampMatrix) {
      return geometry
    }

    const mask = booleanBrushMaskRef.current
    if (!mask) {
      return geometry
    }

    const tessellationPasses = Math.max(0, Math.min(4, Math.floor(booleanTessellation)))
    if (tessellationPasses <= 0) {
      return geometry
    }

    return tessellateBooleanDeformationRegion(
      geometry,
      mask,
      booleanStampMatrix,
      {
        size: booleanStampSize,
        depth: booleanStampDepth,
        offset: booleanStampOffset,
        levels: tessellationPasses
      }
    )
  }, [activeMenu, booleanBrushRevision, booleanStampDepth, booleanStampMatrix, booleanStampOffset, booleanStampSize, booleanTessellation, geometry])

  const booleanHasPreview = !!booleanStampLocalGeometry && !!booleanStampMatrix

  useEffect(() => () => booleanStampLocalGeometry?.dispose?.(), [booleanStampLocalGeometry])
  useEffect(() => () => booleanMaskTexture?.dispose?.(), [booleanMaskTexture])
  useEffect(() => () => {
    if (booleanPreviewGeometry && booleanPreviewGeometry !== geometry) {
      booleanPreviewGeometry.dispose?.()
    }
  }, [booleanPreviewGeometry, geometry])

  const booleanPreviewColor = useMemo(() => {
    if (booleanOperation === 'subtract') {
      return '#ff7c7c'
    }
    if (booleanOperation === 'intersect') {
      return '#7cb4ff'
    }
    return '#72ff9d'
  }, [booleanOperation])

  const textureWorkflowParameters = useMemo(() => {
    return (selectedTextureWorkflow?.parameters || []).filter(parameter => getWorkflowValueType(parameter) !== 'image')
  }, [selectedTextureWorkflow])

  const resetSelection = useCallback(() => {
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
  }, [])

  useEffect(() => {
    if (activeMenu !== 'texturing') {
      return
    }

    dragStateRef.current = null
    resetSelection()
    setSelectionBox(null)
  }, [activeMenu, resetSelection])

  useEffect(() => {
    if (activeMenu !== 'texturing') {
      return
    }

    if (selectedFaceIndices.length === 0 && selectedVertexIndices.length === 0) {
      return
    }

    resetSelection()
  }, [activeMenu, resetSelection, selectedFaceIndices, selectedVertexIndices])

  const applySelection = useCallback((type, nextSelection, isMultiSelect) => {
    setFeedback('')

    if (type === 'face') {
      setSelectedVertexIndices([])
      setSelectedFaceIndices(current => {
        if (!isMultiSelect) {
          return nextSelection
        }

        const currentSet = new Set(current)
        nextSelection.forEach(index => {
          if (currentSet.has(index)) {
            currentSet.delete(index)
          } else {
            currentSet.add(index)
          }
        })

        return [...currentSet].sort((left, right) => left - right)
      })
      return
    }

    setSelectedFaceIndices([])
    setSelectedVertexIndices(current => {
      if (!isMultiSelect) {
        return nextSelection
      }

      const currentSet = new Set(current)
      nextSelection.forEach(index => {
        if (currentSet.has(index)) {
          currentSet.delete(index)
        } else {
          currentSet.add(index)
        }
      })

      return [...currentSet].sort((left, right) => left - right)
    })
  }, [])

  const createRectangleSamplePoints = useCallback((bounds) => {
    const width = Math.max(1, bounds.right - bounds.left)
    const height = Math.max(1, bounds.bottom - bounds.top)
    const maxSamples = 1600
    const step = Math.max(6, Math.ceil(Math.sqrt((width * height) / maxSamples)))
    const points = []

    for (let y = bounds.top; y <= bounds.bottom; y += step) {
      for (let x = bounds.left; x <= bounds.right; x += step) {
        points.push({ x, y })
      }
    }

    points.push(
      { x: bounds.left, y: bounds.top },
      { x: bounds.right, y: bounds.top },
      { x: bounds.left, y: bounds.bottom },
      { x: bounds.right, y: bounds.bottom },
      { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }
    )

    return points
  }, [])

  const selectAtPoint = useCallback((point, isMultiSelect) => {
    if (activeMenu !== 'modeling' || !geometry || !cameraRef.current || !canvasShellRef.current) {
      return
    }

    const rect = canvasShellRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      return
    }

    const raycaster = new THREE.Raycaster()
    raycaster.firstHitOnly = true
    const pointer = new THREE.Vector2(
      (point.x / rect.width) * 2 - 1,
      -((point.y / rect.height) * 2 - 1)
    )

    raycaster.setFromCamera(pointer, cameraRef.current)
    selectionMesh.updateMatrixWorld(true)
    const [intersection] = raycaster.intersectObject(selectionMesh, false)

    if (!intersection) {
      if (!isMultiSelect) {
        resetSelection()
      }
      return
    }

    if (selectionMode === 'vertex') {
      const vertexIndex = getClosestVertexIndex(geometry, intersection.faceIndex, intersection.point)
      if (vertexIndex !== null && vertexIndex !== undefined) {
        applySelection('vertex', [vertexIndex], isMultiSelect)
      }
      return
    }

    if (intersection.faceIndex !== undefined && intersection.faceIndex !== null) {
      applySelection('face', [intersection.faceIndex], isMultiSelect)
    }
  }, [activeMenu, applySelection, geometry, resetSelection, selectionMesh, selectionMode])

  const getMeshIntersection = useCallback((point, targetObject) => {
    if (!targetObject || !cameraRef.current || !canvasShellRef.current) {
      return null
    }

    const rect = canvasShellRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      return null
    }

    const raycaster = new THREE.Raycaster()
    raycaster.firstHitOnly = true
    const pointer = new THREE.Vector2(
      (point.x / rect.width) * 2 - 1,
      -((point.y / rect.height) * 2 - 1)
    )

    raycaster.setFromCamera(pointer, cameraRef.current)
    targetObject.updateMatrixWorld?.(true)
    const [intersection] = raycaster.intersectObject(targetObject, true)
    return intersection || null
  }, [])

  const selectWithinRectangle = useCallback((startPoint, endPoint, isMultiSelect) => {
    if (activeMenu !== 'modeling' || !geometry || !cameraRef.current || !canvasShellRef.current) {
      return
    }

    const rect = canvasShellRef.current.getBoundingClientRect()
    const bounds = getRectangleBounds(startPoint, endPoint)
    const raycaster = new THREE.Raycaster()
    raycaster.firstHitOnly = true
    const samplePoints = createRectangleSamplePoints(bounds)
    selectionMesh.updateMatrixWorld(true)

    if (selectionMode === 'vertex') {
      const nextVertices = new Set()

      samplePoints.forEach(samplePoint => {
        const pointer = new THREE.Vector2(
          (samplePoint.x / rect.width) * 2 - 1,
          -((samplePoint.y / rect.height) * 2 - 1)
        )

        raycaster.setFromCamera(pointer, cameraRef.current)
        const [intersection] = raycaster.intersectObject(selectionMesh, false)

        if (!intersection) {
          return
        }

        const vertexIndex = getClosestVertexIndex(geometry, intersection.faceIndex, intersection.point)
        if (vertexIndex !== null && vertexIndex !== undefined) {
          nextVertices.add(vertexIndex)
        }
      })

      applySelection('vertex', [...nextVertices].sort((left, right) => left - right), isMultiSelect)
      return
    }

    const nextFaces = new Set()

    samplePoints.forEach(samplePoint => {
      const pointer = new THREE.Vector2(
        (samplePoint.x / rect.width) * 2 - 1,
        -((samplePoint.y / rect.height) * 2 - 1)
      )

      raycaster.setFromCamera(pointer, cameraRef.current)
      const [intersection] = raycaster.intersectObject(selectionMesh, false)

      if (intersection?.faceIndex !== undefined && intersection.faceIndex !== null) {
        nextFaces.add(intersection.faceIndex)
      }
    })

    applySelection('face', [...nextFaces].sort((left, right) => left - right), isMultiSelect)
  }, [activeMenu, applySelection, createRectangleSamplePoints, geometry, selectionMesh, selectionMode])

  const getPointerPosition = useCallback((event) => {
    const rect = canvasShellRef.current?.getBoundingClientRect()

    if (!rect) {
      return null
    }

    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    }
  }, [])

  const handleCanvasPointerDown = useCallback((event) => {
    if (event.button !== 0) {
      return
    }

    const nextPoint = getPointerPosition(event)
    if (!nextPoint) {
      return
    }

    if (activeMenu === 'boolean' && booleanPlaceMode) {
      if (!selectionMesh) {
        return
      }
      if (!booleanBrushMaskRef.current) {
        setFeedback('Choose a boolean brush image first.')
        return
      }

      const intersection = getMeshIntersection(nextPoint, selectionMesh)
      if (!intersection?.point || !intersection?.face) {
        return
      }

      const basis = computeBooleanStampBasis(intersection, cameraRef.current)
      if (!basis) {
        return
      }

      event.preventDefault()
      setBooleanStampBasis(basis)
      setBooleanStampNudgeX(0)
      setBooleanStampNudgeY(0)
      setBooleanPlaceMode(false)
      setFeedback('Boolean stamp locked. Adjust parameters, or click on the mesh to reposition.')
      return
    }

    if (activeMenu === 'sculpting') {
      const ctx = sculptContextRef.current
      const mesh = ensureSculptMesh()
      const camera = cameraRef.current
      const shell = canvasShellRef.current
      if (!ctx || !mesh || !camera || !shell) return

      const rect = shell.getBoundingClientRect()
      const hit = sculptRaycastMesh(mesh, camera, nextPoint.x, nextPoint.y, rect.width, rect.height)
      if (!hit) return

      event.preventDefault()
      sculptStrokeKeysRef.current = { ctrl: !!event.ctrlKey || !!event.metaKey, shift: !!event.shiftKey }
      pushSculptUndo()

      // --- Grab brush: capture indices/weights once, then translate them
      // by world-space deltas during pointermove. We do NOT call
      // applySculptStamp at all — Grab has its own pipeline.
      if (sculptBrush === 'grab') {
        ensureSculptGrid(ctx, sculptSize)
        const cameraPos = camera.position
        const mirrors = sculptGetSymmetryMirrors(sculptSymmetry)
        const grabMirrors = []
        for (let mi = 0; mi < mirrors.length; mi++) {
          const sx = mirrors[mi][0]
          const sy = mirrors[mi][1]
          const sz = mirrors[mi][2]
          const queried = sculptQueryRadius(
            ctx,
            hit.point.x * sx, hit.point.y * sy, hit.point.z * sz,
            sculptSize, sculptHardness
          )
          if (queried === 0) continue
          let count = queried
          if (sculptFrontFacesOnly) {
            count = sculptFilterFrontFacing(
              ctx, ctx._outIndices, ctx._outWeights, queried,
              cameraPos.x * sx, cameraPos.y * sy, cameraPos.z * sz
            )
            if (count === 0) continue
          }
          // Apply the textured stamp once at capture time so the grabbed
          // region matches the brush footprint (the move handler then just
          // translates the captured indices — no per-frame texture sampling).
          const stamp = sculptStampRef.current
          if (stamp) {
            applySculptBrushTextureWeights(
              ctx, ctx._outIndices, ctx._outWeights, count,
              hit.point.x * sx, hit.point.y * sy, hit.point.z * sz,
              hit.normal.x * sx, hit.normal.y * sy, hit.normal.z * sz,
              sculptSize, stamp.alphaMap, stamp.width, stamp.height,
              (sculptStampRotation * Math.PI) / 180
            )
          }
          // Snapshot the index/weight pair (the shared scratch buffers
          // would be clobbered by the next mirror's queryRadius call).
          grabMirrors.push({
            indices: ctx._outIndices.slice(0, count),
            weights: ctx._outWeights.slice(0, count),
            count,
            flip: [sx, sy, sz]
          })
        }
        if (grabMirrors.length === 0) return

        sculptStrokeRef.current = {
          pointerId: event.pointerId,
          isGrab: true,
          grabHitDistance: hit.distance,
          grabMirrors,
          lastScreen: { x: nextPoint.x, y: nextPoint.y }
        }

        setSculptCursor({
          x: nextPoint.x,
          y: nextPoint.y,
          pixelRadius: computeSculptCursorPixelRadius(hit.worldPoint, rect.height)
        })

        shell.setPointerCapture?.(event.pointerId)
        return
      }

      // Standard pipeline: first stamp at the hit point.
      applySculptStamp(hit.point, hit.normal)

      sculptStrokeRef.current = {
        pointerId: event.pointerId,
        lastScreen: { x: nextPoint.x, y: nextPoint.y },
        lazyScreen: { x: nextPoint.x, y: nextPoint.y },
        accumulated: 0
      }

      setSculptCursor({
        x: nextPoint.x,
        y: nextPoint.y,
        pixelRadius: computeSculptCursorPixelRadius(hit.worldPoint, rect.height)
      })

      shell.setPointerCapture?.(event.pointerId)
      return
    }

    if (activeMenu === 'painting') {
      if (!texturableMesh?.root || !paintBrushImageRef.current) {
        return
      }

      const intersection = getMeshIntersection(nextPoint, texturableMesh.root)
      if (!intersection?.uv) return
      event.preventDefault()

      // Reuse the currently selected layer if one is selected; otherwise
      // create a new layer (which becomes selected). Erase mode never
      // creates a new layer — it requires an existing target.
      const existingLayer = selectedLayerId
        ? paintLayers.find(l => l.id === selectedLayerId)
        : null
      const existingCanvas = existingLayer
        ? paintLayerCanvasesRef.current.get(existingLayer.id)
        : null

      let activeLayerId
      let activeLayerCanvas
      let createdLayer = null

      if (existingLayer && existingCanvas) {
        activeLayerId = existingLayer.id
        activeLayerCanvas = existingCanvas
        if (Number.isFinite(numericAssetId) && numericAssetId > 0) {
          paintDocDirtyForAssetIdRef.current = numericAssetId
        }
      } else {
        if (paintMode === 'erase') {
          // No layer to erase from — bail out instead of accidentally
          // creating a fresh layer just to immediately cut holes in it.
          return
        }
        const stroke = beginPaintStroke()
        if (!stroke) return
        activeLayerId = stroke.layer.id
        activeLayerCanvas = stroke.layerCanvas
        createdLayer = stroke.layer
      }

      const islandHit = getUvIslandHitInfo(texturableMesh, intersection)
      // Erasing uses destination-out so the brush alpha is subtracted from
      // the layer; drawing keeps the normal source-over compositing.
      const stampBlend = paintMode === 'erase' ? 'destination-out' : 'source-over'
      const rect0 = canvasShellRef.current?.getBoundingClientRect()
      const scaledBrushSize = computePaintBrushTexturePx(
        paintBrushSize,
        cameraRef.current,
        rect0?.height ?? 1,
        intersection,
        texturableMesh.textureCanvas?.width ?? 1024,
        texturableMesh.textureCanvas?.height ?? 1024
      )
      const adjustedPaintRotation = computePaintBrushUvRotationDeg(
        paintRotation,
        cameraRef.current,
        rect0?.width ?? 1,
        rect0?.height ?? 1,
        intersection
      )
      stampBrushAtUv(
        activeLayerCanvas,
        intersection.uv.clone(),
        scaledBrushSize,
        adjustedPaintRotation,
        paintColor,
        paintFlow,
        paintHardness,
        stampBlend,
        islandHit?.path || null
      )

      if (createdLayer) {
        setPaintLayers(prev => [...prev, createdLayer])
        setSelectedLayerId(createdLayer.id)
      }

      activeStrokeRef.current = {
        pointerId: event.pointerId,
        layerId: activeLayerId,
        layerCanvas: activeLayerCanvas,
        lastUv: intersection.uv.clone(),
        lastIslandKey: islandHit?.key || '',
        lastBrushSize: scaledBrushSize
      }

      canvasShellRef.current?.setPointerCapture?.(event.pointerId)
      return
    }

    if (activeMenu === 'texturing') {
      if (!texturingReady || !texturableMesh?.root || !texturableMesh?.maskCanvas || pendingPatch) {
        return
      }

      dragStateRef.current = null
      resetSelection()
      setSelectionBox(null)

      const intersection = getMeshIntersection(nextPoint, texturableMesh.root)
      if (!intersection?.uv) {
        return
      }

      event.preventDefault()
      syncProjectionMaskCanvasSize()

      if (!projectionCameraRef.current && cameraRef.current?.clone) {
        projectionCameraRef.current = cameraRef.current.clone()
        projectionCameraRef.current.updateProjectionMatrix?.()
        projectionCameraRef.current.updateMatrixWorld?.(true)
      }

      const uvPoint = intersection.uv.clone()
      const islandHit = getUvIslandHitInfo(texturableMesh, intersection)
      drawCanvasStroke(projectionMaskCanvasRef.current, nextPoint, nextPoint, brushSize)
      drawUvStroke(
        texturableMesh.maskCanvas,
        uvPoint,
        uvPoint,
        brushSize,
        islandHit?.path || null,
        texturableMesh.textureConfig
      )
      updateCanvasTexture(maskTextureRef.current)
      setTextureRevision(current => current + 1)
      setHasProjectionMask(true)

      paintStateRef.current = {
        pointerId: event.pointerId,
        lastUv: uvPoint,
        lastIslandKey: islandHit?.key || '',
        lastScreenPoint: nextPoint
      }

      canvasShellRef.current?.setPointerCapture?.(event.pointerId)
      return
    }

    if (activeMenu !== 'modeling') {
      return
    }

    event.preventDefault()

    dragStateRef.current = {
      startPoint: nextPoint,
      shiftKey: event.shiftKey,
      pointerId: event.pointerId,
      isDragging: false
    }

    canvasShellRef.current?.setPointerCapture?.(event.pointerId)
  }, [activeMenu, applySculptStamp, beginPaintStroke, booleanPlaceMode, booleanStampBasis, brushSize, computeSculptCursorPixelRadius, ensureSculptMesh, getMeshIntersection, getPointerPosition, numericAssetId, paintBrushSize, paintColor, paintFlow, paintHardness, paintLayers, paintMode, paintRotation, pendingPatch, pushSculptUndo, resetSelection, sculptBrush, sculptFrontFacesOnly, sculptHardness, sculptSize, sculptStampRotation, sculptSymmetry, selectedLayerId, selectionMesh, stampBrushAtUv, syncProjectionMaskCanvasSize, texturableMesh, texturingReady])

  const handleCanvasPointerMove = useCallback((event) => {
    if (activeMenu === 'boolean' && booleanPlaceMode) {
      if (!selectionMesh || !booleanBrushMaskRef.current) {
        return
      }

      const now = performance.now()
      if (now - booleanLastHoverUpdateRef.current < 16) {
        return
      }
      booleanLastHoverUpdateRef.current = now

      const nextPoint = getPointerPosition(event)
      if (!nextPoint) {
        return
      }

      const intersection = getMeshIntersection(nextPoint, selectionMesh)
      if (!intersection?.point || !intersection?.face) {
        return
      }

      const basis = computeBooleanStampBasis(intersection, cameraRef.current)
      if (!basis) {
        return
      }

      setBooleanStampBasis(basis)
      return
    }


    if (activeMenu === 'boolean' && !booleanPlaceMode && booleanStampBasis) {
      // Stamp is locked — clicking on the mesh re-enters placement mode so the
      // user can reposition it, then click again to lock.
      if (selectionMesh && booleanBrushMaskRef.current) {
        const intersection = getMeshIntersection(nextPoint, selectionMesh)
        if (intersection?.point && intersection?.face) {
          const basis = computeBooleanStampBasis(intersection, cameraRef.current)
          if (basis) {
            setBooleanStampBasis(basis)
            setBooleanStampNudgeX(0)
            setBooleanStampNudgeY(0)
          }
        }
      }
      event.preventDefault()
      setBooleanPlaceMode(true)
      setFeedback('Move pointer on mesh to reposition stamp, then click to lock.')
      return
    }

    if (activeMenu === 'sculpting') {
      const ctx = sculptContextRef.current
      const mesh = ensureSculptMesh()
      const camera = cameraRef.current
      const shell = canvasShellRef.current
      if (!ctx || !mesh || !camera || !shell) return

      const nextPoint = getPointerPosition(event)
      if (!nextPoint) return
      const rect = shell.getBoundingClientRect()

      // Update the cursor ring even when the user isn't drawing — but only
      // when the pointer is actually over the mesh, so it doubles as a
      // "can I sculpt here?" indicator.
      const hoverHit = sculptRaycastMesh(mesh, camera, nextPoint.x, nextPoint.y, rect.width, rect.height)
      if (hoverHit) {
        setSculptCursor({
          x: nextPoint.x,
          y: nextPoint.y,
          pixelRadius: computeSculptCursorPixelRadius(hoverHit.worldPoint, rect.height)
        })
      } else if (!sculptStrokeRef.current) {
        setSculptCursor(null)
      }

      const stroke = sculptStrokeRef.current
      if (!stroke) return

      // --- Grab: translate captured verts by world-space delta. We never
      // re-query the grid mid-stroke (Blender behavior).
      if (stroke.isGrab) {
        const dxPx = nextPoint.x - stroke.lastScreen.x
        const dyPx = nextPoint.y - stroke.lastScreen.y
        if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return

        const fovRad = (camera.fov || 50) * Math.PI / 180
        const worldHeightAtDist = 2 * Math.tan(fovRad / 2) * stroke.grabHitDistance
        const pxToWorld = worldHeightAtDist / Math.max(1, rect.height)

        // Camera basis in world space.
        const right = new THREE.Vector3()
        const up = new THREE.Vector3()
        const fwd = new THREE.Vector3()
        camera.matrix.extractBasis(right, up, fwd)

        // Screen Y points down → subtract the up component.
        const wx = right.x * dxPx * pxToWorld - up.x * dyPx * pxToWorld
        const wy = right.y * dxPx * pxToWorld - up.y * dyPx * pxToWorld
        const wz = right.z * dxPx * pxToWorld - up.z * dyPx * pxToWorld

        for (let mi = 0; mi < stroke.grabMirrors.length; mi++) {
          const m = stroke.grabMirrors[mi]
          // Mirror the world delta the same way we mirrored the seed point.
          applySculptGrab(
            ctx, m.indices, m.weights, m.count,
            wx * m.flip[0], wy * m.flip[1], wz * m.flip[2],
            sculptStrength
          )
          // Mark dirty by hand — applySculptGrab already does, but only
          // for the verts it touched. Nothing else to do here.
        }
        sculptIncrementalNormals(ctx)
        ctx.geometry.attributes.position.needsUpdate = true
        ctx.geometry.attributes.normal.needsUpdate = true

        stroke.lastScreen.x = nextPoint.x
        stroke.lastScreen.y = nextPoint.y
        return
      }

      // Steady stroke: lazy-mouse interpolation in screen space. At
      // steadyStroke=0 the lazy cursor snaps to the pointer instantly.
      const lazyT = 1 - sculptSteadyStroke
      stroke.lazyScreen.x += (nextPoint.x - stroke.lazyScreen.x) * lazyT
      stroke.lazyScreen.y += (nextPoint.y - stroke.lazyScreen.y) * lazyT

      // Walk from the previous lazy position toward the new one in steps of
      // `spacing * sculptSize` projected to screen pixels. We approximate
      // pixels-per-world-unit using the most recent cursor pixelRadius.
      const dx = stroke.lazyScreen.x - stroke.lastScreen.x
      const dy = stroke.lazyScreen.y - stroke.lastScreen.y
      const screenDist = Math.hypot(dx, dy)
      if (screenDist <= 0.01) return

      const pxPerWorldRadius = (hoverHit && setSculptCursor /* sentinel */)
        ? Math.max(1, computeSculptCursorPixelRadius(hoverHit.worldPoint, rect.height))
        : 24
      const stepPixels = Math.max(1, sculptSpacing * pxPerWorldRadius)

      let walked = stroke.accumulated
      const steps = Math.floor((walked + screenDist) / stepPixels)
      if (steps <= 0) {
        stroke.accumulated = walked + screenDist
        stroke.lastScreen.x = stroke.lazyScreen.x
        stroke.lastScreen.y = stroke.lazyScreen.y
        return
      }

      const ux = dx / screenDist
      const uy = dy / screenDist
      let cursorX = stroke.lastScreen.x
      let cursorY = stroke.lastScreen.y
      let traveled = 0
      let firstStepDist = stepPixels - walked
      for (let s = 0; s < steps; s++) {
        const advance = s === 0 ? firstStepDist : stepPixels
        cursorX += ux * advance
        cursorY += uy * advance
        traveled += advance
        const stepHit = sculptRaycastMesh(mesh, camera, cursorX, cursorY, rect.width, rect.height)
        if (!stepHit) continue
        applySculptStamp(stepHit.point, stepHit.normal)
      }

      stroke.accumulated = (walked + screenDist) - traveled
      stroke.lastScreen.x = stroke.lazyScreen.x
      stroke.lastScreen.y = stroke.lazyScreen.y
      return
    }

    if (activeMenu === 'painting') {
      // Update brush cursor preview (always while pointer is over the canvas)
      const shell = canvasShellRef.current
      if (shell) {
        const rect = shell.getBoundingClientRect()
        setPaintCursorPos({ x: event.clientX - rect.left, y: event.clientY - rect.top })
      }

      if (!activeStrokeRef.current || !texturableMesh?.root) return

      const nextPoint = getPointerPosition(event)
      if (!nextPoint) return

      const intersection = getMeshIntersection(nextPoint, texturableMesh.root)
      if (!intersection?.uv) return

      const islandHit = getUvIslandHitInfo(texturableMesh, intersection)
      const fromUv = activeStrokeRef.current.lastIslandKey === (islandHit?.key || '')
        ? activeStrokeRef.current.lastUv
        : intersection.uv.clone()
      const toUv = intersection.uv.clone()

      // Stamp along the segment from fromUv to toUv. Spacing in canvas pixels.
      const layerCanvas = activeStrokeRef.current.layerCanvas
      const a = mapUvToCanvasPoint(fromUv, layerCanvas.width, layerCanvas.height, texturableMesh?.textureConfig || null)
      const b = mapUvToCanvasPoint(toUv, layerCanvas.width, layerCanvas.height, texturableMesh?.textureConfig || null)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.hypot(dx, dy)

      // Compute the perspective-adjusted brush size for this hit point.
      const paintRect = canvasShellRef.current?.getBoundingClientRect()
      const scaledBrushSize = computePaintBrushTexturePx(
        paintBrushSize,
        cameraRef.current,
        paintRect?.height ?? 1,
        intersection,
        texturableMesh.textureCanvas?.width ?? 1024,
        texturableMesh.textureCanvas?.height ?? 1024
      )
      const adjustedPaintRotation = computePaintBrushUvRotationDeg(
        paintRotation,
        cameraRef.current,
        paintRect?.width ?? 1,
        paintRect?.height ?? 1,
        intersection
      )
      // Use the scaled size for spacing so the gap between stamps scales with the brush.
      const spacing = Math.max(1, scaledBrushSize * 0.25)
      const steps = Math.max(1, Math.ceil(dist / spacing))

      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps
        const uv = fromUv.clone().lerp(toUv, t)
        stampBrushAtUv(
          layerCanvas,
          uv,
          scaledBrushSize,
          adjustedPaintRotation,
          paintColor,
          paintFlow,
          paintHardness,
          paintMode === 'erase' ? 'destination-out' : 'source-over',
          islandHit?.path || null
        )
      }

      activeStrokeRef.current.lastUv = toUv
      activeStrokeRef.current.lastIslandKey = islandHit?.key || ''
      activeStrokeRef.current.lastBrushSize = scaledBrushSize
      // Live recomposite so the user sees the stroke
      recompositePaintTexture()
      return
    }

    if (activeMenu === 'texturing') {
      if (!paintStateRef.current || !texturableMesh?.root || !texturableMesh?.maskCanvas) {
        return
      }

      const nextPoint = getPointerPosition(event)
      if (!nextPoint) {
        return
      }

      const intersection = getMeshIntersection(nextPoint, texturableMesh.root)
      if (!intersection?.uv) {
        return
      }

      const nextUv = intersection.uv.clone()
      const islandHit = getUvIslandHitInfo(texturableMesh, intersection)
      const previousUv = paintStateRef.current.lastIslandKey && paintStateRef.current.lastIslandKey === islandHit?.key
        ? paintStateRef.current.lastUv
        : nextUv

      drawCanvasStroke(
        projectionMaskCanvasRef.current,
        paintStateRef.current.lastScreenPoint || nextPoint,
        nextPoint,
        brushSize
      )
      drawUvStroke(
        texturableMesh.maskCanvas,
        previousUv,
        nextUv,
        brushSize,
        islandHit?.path || null,
        texturableMesh.textureConfig
      )
      paintStateRef.current.lastUv = nextUv
      paintStateRef.current.lastIslandKey = islandHit?.key || ''
      paintStateRef.current.lastScreenPoint = nextPoint
      updateCanvasTexture(maskTextureRef.current)
      updateMaskOverlay();
      setTextureRevision(current => current + 1)
      setHasProjectionMask(true)
      return
    }

    if (!dragStateRef.current) {
      return
    }

    const nextPoint = getPointerPosition(event)
    if (!nextPoint) {
      return
    }

    const deltaX = Math.abs(nextPoint.x - dragStateRef.current.startPoint.x)
    const deltaY = Math.abs(nextPoint.y - dragStateRef.current.startPoint.y)
    const isDragging = deltaX >= 4 || deltaY >= 4

    dragStateRef.current.isDragging = isDragging

    if (!isDragging) {
      setSelectionBox(null)
      return
    }

    setSelectionBox({
      startPoint: dragStateRef.current.startPoint,
      endPoint: nextPoint
    })
  }, [activeMenu, applySculptStamp, booleanPlaceMode, brushSize, computeSculptCursorPixelRadius, ensureSculptMesh, getMeshIntersection, getPointerPosition, paintBrushSize, paintColor, paintFlow, paintHardness, paintMode, paintRotation, recompositePaintTexture, sculptSpacing, sculptSteadyStroke, sculptStrength, selectionMesh, stampBrushAtUv, texturableMesh, updateMaskOverlay])

  const handleCanvasPointerUp = useCallback((event) => {
    if (activeMenu === 'sculpting') {
      const stroke = sculptStrokeRef.current
      if (!stroke || event.button !== 0) return
      canvasShellRef.current?.releasePointerCapture?.(stroke.pointerId)
      sculptStrokeRef.current = null

      // Stroke-end: full normal recompute + bounds + BVH refit. Topology is
      // unchanged so refit is O(n) and dramatically cheaper than a rebuild.
      const ctx = sculptContextRef.current
      if (ctx) {
        finalizeSculptStroke(ctx)
        // Vertex positions changed: the spatial grid's cell assignments may
        // be stale. Mark for a lazy rebuild on the next stroke.
        invalidateSculptGrid(ctx)
      }
      // Bumping geometryRevision keeps stats / texture-mode warnings in sync.
      setGeometryRevision(rev => rev + 1)
      return
    }

    if (activeMenu === 'painting') {
      if (!activeStrokeRef.current || event.button !== 0) return
      canvasShellRef.current?.releasePointerCapture?.(activeStrokeRef.current.pointerId)
      activeStrokeRef.current = null
      recompositePaintTexture()
      return
    }

    if (activeMenu === 'texturing') {
      if (!paintStateRef.current || event.button !== 0) {
        return
      }

      canvasShellRef.current?.releasePointerCapture?.(paintStateRef.current.pointerId)
      paintStateRef.current = null
      return
    }

    if (!dragStateRef.current || event.button !== 0) {
      return
    }

    const nextPoint = getPointerPosition(event) || dragStateRef.current.startPoint
    const startPoint = dragStateRef.current.startPoint

    if (dragStateRef.current.isDragging) {
      selectWithinRectangle(startPoint, nextPoint, dragStateRef.current.shiftKey)
    } else {
      selectAtPoint(startPoint, dragStateRef.current.shiftKey)
    }

    canvasShellRef.current?.releasePointerCapture?.(dragStateRef.current.pointerId)
    dragStateRef.current = null
    setSelectionBox(null)
  }, [activeMenu, getPointerPosition, recompositePaintTexture, selectAtPoint, selectWithinRectangle])

  const handleCanvasPointerCancel = useCallback(() => {
    if (sculptStrokeRef.current) {
      cancelSculptStroke()
      const ctx = sculptContextRef.current
      if (ctx) {
        finalizeSculptStroke(ctx)
        invalidateSculptGrid(ctx)
      }
      setGeometryRevision(rev => rev + 1)
      return
    }
    if (activeStrokeRef.current) {
      canvasShellRef.current?.releasePointerCapture?.(activeStrokeRef.current.pointerId)
      activeStrokeRef.current = null
    }
    if (paintStateRef.current) {
      canvasShellRef.current?.releasePointerCapture?.(paintStateRef.current.pointerId)
      paintStateRef.current = null
    }

    dragStateRef.current = null
    resetSelection()
    setSelectionBox(null)
  }, [cancelSculptStroke, resetSelection])

  const handleTextureWorkflowInputChange = useCallback((parameter, rawValue) => {
    const valueType = getWorkflowValueType(parameter)

    setTextureWorkflowInputs(current => ({
      ...current,
      [parameter.id]: valueType === 'number'
        ? (rawValue === '' ? '' : Number(rawValue))
        : rawValue
    }))
  }, [])

  const handleClearTextureMask = useCallback(() => {
    if (!texturableMesh?.maskCanvas) {
      return
    }

    clearCanvas(texturableMesh.maskCanvas)
    clearCanvas(projectionMaskCanvasRef.current)
    updateMaskOverlay();
    projectionCameraRef.current = null
    setHasProjectionMask(false)
    updateCanvasTexture(maskTextureRef.current)
    setTextureRevision(current => current + 1)
    setFeedback('Texture mask cleared.')
  }, [texturableMesh, updateMaskOverlay])

  const applyGeometryUpdate = useCallback((nextGeometry, nextHoleLoops = [], { pushUndo = true } = {}) => {
    if (pushUndo && geometry) {
      // Clone before the disposal effect tears the previous geometry down.
      const snapshot = geometry.clone()
      const stack = modelingUndoStackRef.current
      stack.push(snapshot)
      while (stack.length > 20) {
        const dropped = stack.shift()
        dropped?.dispose?.()
      }
      // Any new edit invalidates the redo history.
      modelingRedoStackRef.current.forEach(g => g?.dispose?.())
      modelingRedoStackRef.current = []
      setModelingCanUndo(true)
      setModelingCanRedo(false)
    }
    setGeometry(nextGeometry)
    setGeometryRevision(current => current + 1)
    setHoleLoops(nextHoleLoops)
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
    setFeedback('Mesh updated.')
  }, [geometry])

  const handleModelingUndo = useCallback(() => {
    const undoStack = modelingUndoStackRef.current
    const snap = undoStack.pop()
    if (!snap) {
      setModelingCanUndo(false)
      return
    }
    if (geometry) {
      modelingRedoStackRef.current.push(geometry.clone())
      while (modelingRedoStackRef.current.length > 20) {
        modelingRedoStackRef.current.shift()?.dispose?.()
      }
    }
    setGeometry(snap)
    setGeometryRevision(current => current + 1)
    setHoleLoops([])
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
    setModelingCanUndo(undoStack.length > 0)
    setModelingCanRedo(true)
    setFeedback('Undo.')
  }, [geometry])

  const handleModelingRedo = useCallback(() => {
    const redoStack = modelingRedoStackRef.current
    const snap = redoStack.pop()
    if (!snap) {
      setModelingCanRedo(false)
      return
    }
    if (geometry) {
      modelingUndoStackRef.current.push(geometry.clone())
      while (modelingUndoStackRef.current.length > 20) {
        modelingUndoStackRef.current.shift()?.dispose?.()
      }
    }
    setGeometry(snap)
    setGeometryRevision(current => current + 1)
    setHoleLoops([])
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
    setModelingCanUndo(true)
    setModelingCanRedo(redoStack.length > 0)
    setFeedback('Redo.')
  }, [geometry])

  // Keyboard shortcuts within modeling mode: Ctrl/Cmd+Z = undo,
  // Ctrl/Cmd+Shift+Z and Ctrl+Y = redo.
  useEffect(() => {
    if (activeMenu !== 'modeling') return undefined
    const onKey = (event) => {
      const target = event.target
      if (target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      )) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        handleModelingUndo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        handleModelingRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeMenu, handleModelingUndo, handleModelingRedo])

  const handleDelete = useCallback(() => {
    if (!geometry) {
      return
    }

    if (selectionMode === 'face') {
      const result = deleteSelectedFaces(geometry, selectedFaceIndices)
      applyGeometryUpdate(result.geometry, result.holeLoops)
      return
    }

    const result = deleteSelectedVertices(geometry, selectedVertexIndices)
    applyGeometryUpdate(result.geometry, result.holeLoops)
  }, [applyGeometryUpdate, geometry, selectedFaceIndices, selectedVertexIndices, selectionMode])

  const handleSmooth = useCallback(() => {
    if (!geometry || selectedVertexIndices.length === 0) {
      return
    }

    applyGeometryUpdate(smoothSelectedVertices(geometry, selectedVertexIndices), [])
  }, [applyGeometryUpdate, geometry, selectedVertexIndices])

  const handleMerge = useCallback(() => {
    if (!geometry || selectedVertexIndices.length < 2) {
      return
    }

    applyGeometryUpdate(mergeSelectedVertices(geometry, selectedVertexIndices), [])
  }, [applyGeometryUpdate, geometry, selectedVertexIndices])

  const handleSubdivide = useCallback(() => {
    if (!geometry || selectedFaceIndices.length === 0) {
      return
    }

    applyGeometryUpdate(subdivideSelectedFaces(geometry, selectedFaceIndices), [])
  }, [applyGeometryUpdate, geometry, selectedFaceIndices])

  const handleBridge = useCallback(() => {
    if (!geometry || selectionMode !== 'vertex') {
      return
    }

    const result = bridgeSelectedHoleSegments(geometry, selectedVertexIndices)
    if (!result.applied) {
      setFeedback('Select two boundary vertex segments on the same hole to bridge them.')
      return
    }

    applyGeometryUpdate(result.geometry, result.holeLoops)
  }, [applyGeometryUpdate, geometry, selectedVertexIndices, selectionMode])

  const handleFillHole = useCallback(() => {
    if (!geometry) {
      return
    }

    if (selectionMode === 'vertex' && selectedVertexIndices.length > 0) {
      const result = bridgeAndFillSelectedHole(geometry, selectedVertexIndices)
      if (result.applied) {
        applyGeometryUpdate(result.geometry, [])
        return
      }
    }

    // Prefer hole loops derived from the current selection; otherwise fall
    // back to ALL hole loops in the geometry so the user can fill holes
    // without having to manually select boundary edges first.
    const loopsToFill = availableHoleLoops.length > 0
      ? availableHoleLoops
      : getGeometryHoleLoops(geometry)

    if (!loopsToFill || loopsToFill.length === 0) {
      setFeedback('No holes detected in this mesh.')
      return
    }

    applyGeometryUpdate(fillHoleLoops(geometry, loopsToFill), [])
  }, [applyGeometryUpdate, availableHoleLoops, geometry, selectedVertexIndices, selectionMode])

  const handleApplyBoolean = useCallback(() => {
    if (!geometry || !booleanStampLocalGeometry || !booleanStampMatrix) {
      return
    }

    try {
      setError('')
      const tessellationPasses = Math.max(0, Math.min(4, Math.floor(booleanTessellation)))
      const tessellatedGeometry = tessellationPasses > 0
        ? tessellateBooleanDeformationRegion(
          geometry,
          booleanBrushMaskRef.current,
          booleanStampMatrix,
          {
            size: booleanStampSize,
            depth: booleanStampDepth,
            offset: booleanStampOffset,
            threshold: 1,
            levels: tessellationPasses
          }
        )
        : geometry

      const nextGeometry = deformGeometryWithBooleanStamp(
        tessellatedGeometry,
        booleanBrushMaskRef.current,
        booleanStampMatrix,
        {
          operation: booleanOperation,
          size: booleanStampSize,
          depth: booleanStampDepth,
          offset: booleanStampOffset,
          threshold: 1
        }
      )

      if (!nextGeometry) {
        setError('Unable to apply brush deformation at this position.')
        setFeedback('')
        return
      }

      applyGeometryUpdate(nextGeometry, [])
      setBooleanPlaceMode(false)
      setBooleanStampBasis(null)
      setFeedback(
        tessellationPasses > 0
          ? `Brush deformation (${booleanOperation}) applied with tessellation x${tessellationPasses}.`
          : `Brush deformation (${booleanOperation}) applied.`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Boolean operation failed.')
      setFeedback('')
    }
  }, [applyGeometryUpdate, booleanOperation, booleanStampDepth, booleanStampLocalGeometry, booleanStampMatrix, booleanStampOffset, booleanStampSize, booleanTessellation, geometry])

  const handleClearBooleanStamp = useCallback(() => {
    setBooleanStampBasis(null)
    setBooleanStampNudgeX(0)
    setBooleanStampNudgeY(0)
    setBooleanPlaceMode(false)
  }, [])

  const handleSave = useCallback(async (saveMode) => {
    if (!geometry || saving) {
      return
    }

    try {
      setSaving(true)
      setError('')
      setFeedback('Saving mesh...')
      const canExportTextured = !!(
        texturableMesh?.root
        && texturableMesh?.textureCanvas
        && geometry?.attributes?.uv?.count
      )
      const meshBinary = canExportTextured
        ? await exportTexturedMeshToGlb({
          root: texturableMesh.root,
          textureKey: texturableMesh.textureKey,
          textureCanvas: texturableMesh.textureCanvas,
          textureConfig: texturableMesh.textureConfig
        })
        : await exportGeometryToGlb(geometry)
      const meshFile = new File(
        [meshBinary],
        `${(meshName || 'mesh').trim() || 'mesh'}.glb`,
        { type: 'model/gltf-binary' }
      )

      const savedAsset = await saveMeshEdit({
        assetId: Number.isFinite(numericAssetId) && numericAssetId > 0 ? numericAssetId : null,
        filePath,
        name: meshName,
        saveMode,
        meshFile
      })

      try {
        const assetUrl = savedAsset?.filename ? `http://localhost:3001/assets/${encodeURI(savedAsset.filename)}` : ''
        const response = assetUrl ? await fetch(assetUrl) : null
        if (response?.ok) {
          const blob = await response.blob()
          const meshFile = new File([blob], savedAsset.filename?.split('/').pop() || `${savedAsset.name || 'mesh'}.glb`, {
            type: blob.type || 'application/octet-stream'
          })
          const thumbnailFile = await createMeshThumbnailFile(meshFile)
          if (thumbnailFile) {
            await uploadAssetThumbnail(savedAsset.id, thumbnailFile)
          }
        }
      } catch (thumbnailError) {
        console.warn('Failed to refresh mesh thumbnail:', thumbnailError)
      }

      // Persist the paint document. We sync to the server when EITHER the user
      // currently has painting state in memory (layers + base) OR this asset
      // had a paint document earlier in the session — otherwise deleting every
      // layer + saving wouldn't clean up orphan PNGs on disk.
      try {
        const hasInMemoryPaintState = paintLayers.length > 0 && !!paintingBaseTextureRef.current
        const isReplaceSave = saveMode !== 'version'
        // For "Save as version" we only push if the user actually has painted
        // something — we don't want to inherit a stale dirty flag onto a fresh
        // version that has nothing to clean up.
        const shouldSyncForReplace = isReplaceSave
          && paintDocDirtyForAssetIdRef.current === savedAsset?.id
        const shouldSync = savedAsset?.id && (hasInMemoryPaintState || shouldSyncForReplace)

        if (shouldSync) {
          const baseCanvas = paintingBaseTextureRef.current
          const baseFile = baseCanvas
            ? await canvasToPngFile(baseCanvas, 'base.png')
            : null

          const layerFiles = {}
          for (const layer of paintLayers) {
            const layerCanvas = paintLayerCanvasesRef.current.get(layer.id)
            if (!layerCanvas) continue
             
            layerFiles[layer.id] = await canvasToPngFile(layerCanvas, `${layer.id}.png`)
          }

          await savePaintDocument(savedAsset.id, {
            metadata: {
              textureWidth: baseCanvas?.width || 0,
              textureHeight: baseCanvas?.height || 0,
              layers: paintLayers.map(layer => ({
                id: layer.id,
                name: layer.name,
                opacity: layer.opacity,
                blendMode: layer.blendMode,
                color: layer.color,
                visible: layer.visible
              }))
            },
            baseFile,
            layerFiles
          })

          // After a successful save the on-disk state matches the in-memory
          // state. Clear the dirty marker; subsequent edits will re-set it.
          if (paintLayers.length === 0) {
            paintDocDirtyForAssetIdRef.current = null
          } else {
            paintDocDirtyForAssetIdRef.current = savedAsset.id
          }
        }
      } catch (paintDocError) {
        console.warn('Failed to save paint document:', paintDocError)
      }

      if (saveMode === 'version' && savedAsset?.id) {
        const nextSearchParams = new URLSearchParams(searchParams)
        const savedFilename = savedAsset.filename || (savedAsset.filePath ? savedAsset.filePath.replace(/^data\/assets\//, '') : '')
        const savedUrl = savedFilename ? `http://localhost:3001/assets/${encodeURI(savedFilename)}` : modelUrl

        nextSearchParams.set('assetId', String(savedAsset.id))
        nextSearchParams.set('filePath', savedAsset.filePath || '')
        nextSearchParams.set('url', savedUrl)
        nextSearchParams.set('name', savedAsset.name || meshName)

        navigate(`/mesh-editor?${nextSearchParams.toString()}`, { replace: true })
      }

      setFeedback(saveMode === 'version' ? 'New mesh version saved.' : 'Mesh saved.')
    } catch (err) {
      setError(err.message || 'Failed to save mesh')
      setFeedback('')
    } finally {
      setSaving(false)
    }
  }, [filePath, geometry, geometryRevision, meshName, modelUrl, navigate, numericAssetId, saveMeshEdit, saving, searchParams, texturableMesh, uploadAssetThumbnail, paintLayers, canvasToPngFile, savePaintDocument])

  const handleBack = useCallback(() => {
    if (returnTo) {
      navigate(returnTo)
      return
    }

    navigate(-1)
  }, [navigate, returnTo])

  useEffect(() => {
    setProjectionStarted(false)
    setProjectionKeepTexture(false)
    projectionBaseTextureRef.current = null
    projectionCoverageRef.current = null
    projectionFaceOwnershipRef.current.clear()
    projectionLayerDataRef.current.clear()
    projectionLayerCounterRef.current = 0
    setProjectionLayers([])
  }, [texturableMesh])

  const rebuildProjectionTexture = useCallback(async (layers, { announce = false } = {}) => {
    if (!texturableMesh?.textureCanvas || !displayTextureRef.current) {
      return
    }

    const textureCanvas = texturableMesh.textureCanvas
    const texW = textureCanvas.width
    const texH = textureCanvas.height
    const rebuildToken = ++projectionRebuildTokenRef.current

    setProjectionRebuilding(true)
    setProjectionRebuildProgress(0)

    const rebuildStartedAt = performance.now()

    try {
      const textureContext = textureCanvas.getContext('2d')
      textureContext.clearRect(0, 0, texW, texH)
      const baseSnapshot = projectionBaseTextureRef.current
      if (baseSnapshot && baseSnapshot.width === texW && baseSnapshot.height === texH) {
        textureContext.drawImage(baseSnapshot, 0, 0)
      } else {
        drawProjectionCheckerboard(textureContext, texW, texH)
      }
      const composedImage = textureContext.getImageData(0, 0, texW, texH)
      const composedData = composedImage.data
      const layerSnapshots = []

      const visibleLayers = layers.filter(layer => layer.visible !== false)
      const totalVisibleLayers = Math.max(1, visibleLayers.length)

      for (let layerIndex = 0; layerIndex < visibleLayers.length; layerIndex += 1) {
        if (projectionRebuildTokenRef.current !== rebuildToken) {
          return
        }

        const layer = visibleLayers[layerIndex]
        const layerData = projectionLayerDataRef.current.get(layer.id)
        if (!layerData?.camera || !layerData?.patchCanvas) {
          const overall = (layerIndex + 1) / totalVisibleLayers
          setProjectionRebuildProgress(overall)
          continue
        }

        const patchCanvas = layerData.patchCanvas
        const projectionCamera = layerData.camera.clone()
        projectionCamera.updateProjectionMatrix?.()
        projectionCamera.updateMatrixWorld?.(true)
        const layerStartedAt = performance.now()

        const effectiveCropBorder = Math.max(AUTO_PROJECTION_SEAM_SAFE_CROP_PX, layer.cropBorder || 0)
        const effectiveBlendPixels = Math.max(AUTO_PROJECTION_SEAM_SAFE_BLEND_PX, layer.blendPixels || 0)
        const effectiveMaskFeather = Math.max(1, Math.min(4, Math.round(effectiveBlendPixels * 0.3)))

        const bakeSignature = [
          `tex:${texW}x${texH}`,
          `patch:${patchCanvas.width}x${patchCanvas.height}`,
          `crop:${effectiveCropBorder}`,
          `blend:${effectiveBlendPixels}`,
          `feather:${effectiveMaskFeather}`
        ].join('|')

        const requiresRebake = (
          !layerData.bakedCanvas
          || layerData.bakeSignature !== bakeSignature
          || !layerData.coverageMask
          || layerData.coverageMask.length !== texW * texH
          || !layerData.ownershipMask
          || layerData.ownershipMask.length !== texW * texH
          || !layerData.sharedSeamMask
          || layerData.sharedSeamMask.length !== texW * texH
          || !layerData.confidenceMap
          || layerData.confidenceMap.length !== texW * texH
        )
        let accumulateStats = null
        let finalizeStats = null

        if (requiresRebake) {
          const maskCanvas = createProjectionCropMaskCanvasFromPatch(patchCanvas, effectiveCropBorder)
          const accumulatedColor = new Float32Array(texW * texH * 4)
          const accumulatedWeight = new Float32Array(texW * texH)
          const bakedCanvas = document.createElement('canvas')
          bakedCanvas.width = texW
          bakedCanvas.height = texH

          accumulateStats = await accumulateProjectedPatch({
            root: texturableMesh.root,
            textureKey: texturableMesh.textureKey,
            textureConfig: texturableMesh.textureConfig,
            camera: projectionCamera,
            maskCanvas,
            bbox: { x: 0, y: 0, width: patchCanvas.width, height: patchCanvas.height },
            patchImage: patchCanvas,
            featherRadius: effectiveMaskFeather,
            accumulatedColor,
            accumulatedWeight,
            textureWidth: texW,
            textureHeight: texH,
            binaryMask: false,
            grazingCoverageThreshold: 0.15,
            minFacingCos: 0,
            facingPower: 1.2,
            minMaskAlpha: 0.12,
            unmatteFringe: true,
            unmatteStrength: 0.92,
            layerId: layer.id,
            faceOwnershipMap: null,
            faceLockPolicy: 'none',
            // Keep visibility filtering so front-view projection does not bleed
            // through to back-facing / hidden surfaces.
            // Raycast is slower than depth-prepass, but it is more robust for
            // imported meshes that otherwise lose large surface areas.
            occlusionMode: 'raycast',
            cullBackfaces: false,
            onProgress: progress => {
              const overall = (layerIndex + progress) / totalVisibleLayers
              setProjectionRebuildProgress(overall)
              if (announce) {
                setFeedback(`Rebuilding projections... ${layerIndex + 1}/${visibleLayers.length} ${Math.round(progress * 100)}%`)
              }
            }
          })

          if (projectionRebuildTokenRef.current !== rebuildToken) {
            return
          }

          finalizeStats = finalizeProjectedPatch({
            textureCanvas: bakedCanvas,
            accumulatedColor,
            accumulatedWeight,
            gapFillRadius: Math.max(2, Math.round(effectiveBlendPixels / 2)),
            previousCoverageMap: null,
            boundaryBlendPixels: 0,
            boundaryOnlyBlend: false
          })

          applyProjectionEdgeBleed(bakedCanvas, Math.max(1, Math.round(effectiveMaskFeather / 2)))

          const bakedContext = bakedCanvas.getContext('2d', { willReadFrequently: true }) || bakedCanvas.getContext('2d')
          const bakedData = bakedContext.getImageData(0, 0, texW, texH).data
          const alphaBytes = new Uint8Array(texW * texH)
          for (let i = 0; i < alphaBytes.length; i += 1) {
            alphaBytes[i] = bakedData[i * 4 + 3]
          }
          const coverageMask = buildProjectionCoverageMaskFromBakedAlpha(alphaBytes, texW, texH, {
            minAlpha: 1,
            stitchEdges: true
          })
          const ownershipMask = buildProjectionCoverageMaskFromBakedAlpha(alphaBytes, texW, texH, {
            minAlpha: 112,
            stitchEdges: false
          })
          const sharedSeamMask = buildProjectionSharedSeamMask(
            coverageMask,
            ownershipMask,
            texW,
            texH,
            effectiveBlendPixels
          )
          const confidenceMap = buildProjectionConfidenceMap(accumulatedWeight, coverageMask, alphaBytes)

          layerData.bakedCanvas = bakedCanvas
          layerData.bakeSignature = bakeSignature
          layerData.coverageMask = coverageMask
          layerData.ownershipMask = ownershipMask
          layerData.sharedSeamMask = sharedSeamMask
          layerData.confidenceMap = confidenceMap
        }

        if (projectionRebuildTokenRef.current !== rebuildToken) {
          return
        }

        const layerOpacity = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)))
        const layerOpacitySeams = Math.max(0, Math.min(1, Number(layer.opacitySeams ?? 1)))
        const layerBlendMode = layer.blendMode || 'source-over'
        const layerCoverage = layerData.coverageMask
        const layerOwnership = layerData.ownershipMask
        const layerSharedSeam = layerData.sharedSeamMask
        const layerConfidence = layerData.confidenceMap

        if (layerData.bakedCanvas && layerOpacity > 0 && layerCoverage && layerCoverage.length === texW * texH) {
          const bakedContext = layerData.bakedCanvas.getContext('2d', { willReadFrequently: true }) || layerData.bakedCanvas.getContext('2d')
          const bakedImage = bakedContext.getImageData(0, 0, texW, texH)

          layerSnapshots.push({
            pixelData: bakedImage.data,
            coverageMask: layerCoverage,
            ownershipMask: layerOwnership,
            sharedSeamMask: layerSharedSeam,
            confidenceMap: layerConfidence,
            opacity: layerOpacity,
            opacitySeams: layerOpacitySeams,
            blendMode: layerBlendMode,
            blendPixels: effectiveBlendPixels
          })
        }

        const overall = (layerIndex + 1) / totalVisibleLayers
        setProjectionRebuildProgress(overall)

        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          const layerDurationMs = performance.now() - layerStartedAt
          const rebakeLabel = requiresRebake ? 'rebaked' : 'cached'
          console.debug(
            `[Projection] Rebuild layer ${layerIndex + 1}/${visibleLayers.length}: `
            + `${layer.name || layer.id} in ${layerDurationMs.toFixed(1)}ms (${rebakeLabel}) `
            + `(occlusion=${accumulateStats?.occlusionModeUsed || 'cached'}, `
            + `applied=${accumulateStats?.appliedSamples || 0}, `
            + `finalized=${finalizeStats?.appliedPixels || 0})`
          )
        }
      }

      if (projectionRebuildTokenRef.current !== rebuildToken) {
        return
      }

      resolveProjectionLayersIntoImageData(composedData, layerSnapshots, texW, texH)
      textureContext.putImageData(composedImage, 0, 0)
      projectionLayerSnapshotsRef.current = layerSnapshots
      postProcBackupRef.current = null  // invalidate any prior post-proc backup on rebuild
      setPostProcApplied(false)
      projectionCoverageRef.current = null
      projectionFaceOwnershipRef.current.clear()
      updateCanvasTexture(displayTextureRef.current)
      setTextureRevision(current => current + 1)
      if (typeof console !== 'undefined' && typeof console.debug === 'function') {
        const rebuildDurationMs = performance.now() - rebuildStartedAt
        console.debug(
          `[Projection] Rebuild complete in ${rebuildDurationMs.toFixed(1)}ms `
          + `(${visibleLayers.length} visible layer${visibleLayers.length === 1 ? '' : 's'})`
        )
      }
      if (announce) {
        setFeedback(visibleLayers.length > 0
          ? `Projection stack rebuilt (${visibleLayers.length} projection${visibleLayers.length === 1 ? '' : 's'}).`
          : 'Projection stack cleared.')
      }
    } finally {
      if (projectionRebuildTokenRef.current === rebuildToken) {
        setProjectionRebuilding(false)
        setProjectionRebuildProgress(0)
      }
    }
  }, [texturableMesh])

  const projectionLayersForRebuild = useMemo(() => projectionLayers, [
    projectionLayers.map(layer => [
      layer.id,
      layer.visible === false ? 0 : 1,
      layer.opacity ?? 1,
      layer.opacitySeams ?? 1,
      layer.blendMode || 'source-over',
      layer.blendPixels ?? '',
      layer.cropBorder ?? ''
    ].join(':')).join('|')
  ])

  useEffect(() => {
    if (!projectionStarted || !texturableMesh?.textureCanvas) {
      return
    }

    void rebuildProjectionTexture(projectionLayersForRebuild, { announce: false })
  }, [projectionLayersForRebuild, projectionStarted, rebuildProjectionTexture, texturableMesh])

  const handleUpdateProjectionLayer = useCallback((id, updates) => {
    setProjectionLayers(current => current.map(layer => layer.id === id ? { ...layer, ...updates } : layer))
  }, [])

  const handleDeleteProjectionLayer = useCallback((id) => {
    projectionLayerDataRef.current.delete(id)
    setProjectionLayers(current => current.filter(layer => layer.id !== id))
  }, [])

  const handleMoveProjectionLayer = useCallback((id, direction) => {
    setProjectionLayers(current => {
      const index = current.findIndex(layer => layer.id === id)
      if (index === -1) {
        return current
      }

      const target = direction === 'up' ? index + 1 : index - 1
      if (target < 0 || target >= current.length) {
        return current
      }

      const next = current.slice()
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }, [])

  const handleApplyAllProjectionLayers = useCallback(() => {
    setProjectionLayers(current => current.map(layer => {
      const draft = projectionLayerDrafts[layer.id]
      if (!draft) {
        return layer
      }

      return {
        ...layer,
        blendPixels: draft.blendPixels,
        cropBorder: draft.cropBorder
      }
    }))
    setProjectionLayerDrafts({})
    setFeedback('Applied all modified projections.')
  }, [projectionLayerDrafts])

  const handleStartProjectionSession = useCallback(() => {
    if (!texturableMesh?.textureCanvas) {
      setFeedback('Projection mode requires a texturable mesh.')
      return
    }

    const keepTexture = window.confirm(
      'Keep the current texture for this projection session?\n\n'
      + 'OK = keep the existing texture (Texture Size cannot be changed; projections will fade with the current texture at their seams).\n'
      + 'Cancel = clear the texture and start with a fresh checkerboard.'
    )

    const textureCanvas = texturableMesh.textureCanvas
    const textureCtx = textureCanvas.getContext('2d')

    if (keepTexture) {
      const baseW = textureCanvas.width
      const baseH = textureCanvas.height
      const baseSnapshot = document.createElement('canvas')
      baseSnapshot.width = baseW
      baseSnapshot.height = baseH
      baseSnapshot.getContext('2d').drawImage(textureCanvas, 0, 0)
      projectionBaseTextureRef.current = baseSnapshot

      if (texturableMesh.maskCanvas) {
        if (texturableMesh.maskCanvas.width !== baseW || texturableMesh.maskCanvas.height !== baseH) {
          texturableMesh.maskCanvas.width = baseW
          texturableMesh.maskCanvas.height = baseH
        }
        clearCanvas(texturableMesh.maskCanvas)
      }

      projectionCoverageRef.current = new Uint8Array(baseW * baseH)
    } else {
      const clampedSize = Math.max(512, Math.min(4096, Math.round(projectionTextureSize)))
      textureCanvas.width = clampedSize
      textureCanvas.height = clampedSize
      textureCtx.clearRect(0, 0, clampedSize, clampedSize)
      drawProjectionCheckerboard(textureCtx, clampedSize, clampedSize)

      if (texturableMesh.maskCanvas) {
        texturableMesh.maskCanvas.width = clampedSize
        texturableMesh.maskCanvas.height = clampedSize
        clearCanvas(texturableMesh.maskCanvas)
      }

      projectionCoverageRef.current = new Uint8Array(clampedSize * clampedSize)
      projectionBaseTextureRef.current = null
    }

    projectionFaceOwnershipRef.current.clear()
    projectionLayerDataRef.current.clear()
    projectionLayerCounterRef.current = 0
    setProjectionLayers([])
    setProjectionKeepTexture(keepTexture)
    setProjectionStarted(true)
    setPendingPatch(null)
    setPatchNoise(0)
    setProjectionOpacities([1])
    originalTextureBackupRef.current = null
    postProcBackupRef.current = null
    projectionLayerSnapshotsRef.current = []
    setPostProcApplied(false)
    patchedTextureRef.current = null
    projectionViewDataRef.current = []
    projectionMaskBackupRef.current = null

    displayTextureRef.current?.dispose?.()
    maskTextureRef.current?.dispose?.()
    displayTextureRef.current = createCanvasTexture(textureCanvas, texturableMesh.textureConfig)
    maskTextureRef.current = texturableMesh.maskCanvas
      ? createCanvasTexture(texturableMesh.maskCanvas, texturableMesh.textureConfig)
      : null

    setTextureRevision(current => current + 1)
    const w = textureCanvas.width
    const h = textureCanvas.height
    setFeedback(keepTexture
      ? `Projection session started — keeping current ${w}x${h} texture.`
      : `Projection session started with ${w}x${h} texture.`)
  }, [projectionTextureSize, texturableMesh])

  const modifiedProjectionCount = Object.entries(projectionLayerDrafts).reduce((count, [layerId, draft]) => {
    const layer = projectionLayers.find(item => item.id === layerId)
    if (!layer || !draft) {
      return count
    }

    const layerBlendPixels = layer.blendPixels
    const layerCropBorder = layer.cropBorder || 0
    const isModified = draft.blendPixels !== layerBlendPixels || draft.cropBorder !== layerCropBorder
    return count + (isModified ? 1 : 0)
  }, 0)

  const handleApplyPostProcessing = useCallback(async () => {
    if (!texturableMesh?.textureCanvas) return
    const snapshots = projectionLayerSnapshotsRef.current
    if (!snapshots || snapshots.length === 0) return
    if (!postProcSeamEnabled && !postProcFillHolesEnabled) return

    const textureCanvas = texturableMesh.textureCanvas

    setProjectionRebuilding(true)
    setProjectionRebuildProgress(0)

    try {
      // Save a backup on first apply so we can reset or re-apply idempotently
      if (!postProcBackupRef.current) {
        const backupCanvas = document.createElement('canvas')
        backupCanvas.width = textureCanvas.width
        backupCanvas.height = textureCanvas.height
        backupCanvas.getContext('2d').drawImage(textureCanvas, 0, 0)
        postProcBackupRef.current = backupCanvas
      } else {
        textureCanvas.getContext('2d').drawImage(postProcBackupRef.current, 0, 0)
      }

      // Fill Holes runs first so Seam Smoothing can smooth the new fill boundaries
      if (postProcFillHolesEnabled) {
        setFeedback('Filling holes (3D-aware)...')
        const fillShare = postProcSeamEnabled ? 0.9 : 1.0
        await fillHolesPostProcessing(
          textureCanvas,
          snapshots,
          texturableMesh,
          postProcFillHolesBlur,
          p => setProjectionRebuildProgress(p * fillShare)
        )
      }
      if (postProcSeamEnabled) {
        setFeedback('Smoothing seams...')
        setProjectionRebuildProgress(postProcFillHolesEnabled ? 0.9 : 0)
        await applySeamPostProcessing(textureCanvas, snapshots, postProcSeamThreshold, postProcBlurRadius, postProcStrength)
      }

      setProjectionRebuildProgress(1)
      updateCanvasTexture(displayTextureRef.current)
      setTextureRevision(current => current + 1)
      setPostProcApplied(true)
      setFeedback('Post-processing complete.')
    } catch (err) {
      console.error('[Post Processing] Failed:', err)
      setFeedback('Post-processing failed.')
    } finally {
      setProjectionRebuilding(false)
    }
  }, [
    texturableMesh,
    postProcSeamEnabled, postProcSeamThreshold, postProcBlurRadius, postProcStrength,
    postProcFillHolesEnabled, postProcFillHolesBlur
  ])

  const handleResetPostProcessing = useCallback(() => {
    if (!texturableMesh?.textureCanvas || !postProcBackupRef.current) return
    texturableMesh.textureCanvas.getContext('2d').drawImage(postProcBackupRef.current, 0, 0)
    updateCanvasTexture(displayTextureRef.current)
    setTextureRevision(current => current + 1)
    postProcBackupRef.current = null
    setPostProcApplied(false)
  }, [texturableMesh])

  const handleRunProjectionWorkflow = useCallback(async () => {
    if (projecting || !projectionStarted || !projectionReady || !selectedProjectionWorkflow || !texturableMesh?.textureCanvas) {
      return
    }

    const viewParamEntries = Object.entries(projectionImageParamSources)
    const positionViewParam = viewParamEntries.find(([, config]) => config?.type === 'position-view')
    if (!positionViewParam?.[0]) {
      setFeedback('Select one image input as Position View.')
      return
    }

    if (!cameraRef.current) {
      setFeedback('Camera is not ready yet. Try again.')
      return
    }

    const [positionViewParamId] = positionViewParam
    const texturedViewParam = viewParamEntries.find(([, config]) => config?.type === 'textured-view')
    const texturedViewParamId = texturedViewParam?.[0] || null
    const untexturedViewParam = viewParamEntries.find(([, config]) => config?.type === 'untextured-view')
    const untexturedViewParamId = untexturedViewParam?.[0] || null
    const staticImageParams = viewParamEntries.filter(([, config]) => config?.type === 'asset' || config?.type === 'file')
    const texW = texturableMesh.textureCanvas.width
    const texH = texturableMesh.textureCanvas.height
    const sendResolution = Math.max(512, Math.min(2048, Math.round(projectionViewResolution)))

    try {
      setProjecting(true)
      setError('')
      setFeedback('Capturing position view...')

      const projectionCamera = buildFramedProjectionCamera(cameraRef.current, texturableMesh.root, 1)

      const viewCanvas = captureTexturedMeshView({
        root: texturableMesh.root,
        textureKey: texturableMesh.textureKey,
        displayTexture: displayTextureRef.current,
        camera: projectionCamera,
        width: sendResolution,
        height: sendResolution,
        renderMode: 'lit-geometry'
      })
      const positionViewFile = await canvasToFile(viewCanvas, 'projection-position-view.png')

      let texturedViewFile = null
      let untexturedViewFile = null
      if (texturedViewParamId || untexturedViewParamId) {
        setFeedback('Capturing textured view...')
        const texturedViewCanvas = captureTexturedMeshView({
          root: texturableMesh.root,
          textureKey: texturableMesh.textureKey,
          displayTexture: displayTextureRef.current,
          camera: projectionCamera,
          width: sendResolution,
          height: sendResolution,
          renderMode: 'textured'
        })

        // Build a UV-space union of all visible projection layer coverage masks.
        // Covered texels are white, uncovered black. We render this through the
        // same camera to get a per-pixel covered/uncovered classifier in screen
        // space, then use it as an alpha mask on the textured view.
        const coverageCanvas = document.createElement('canvas')
        coverageCanvas.width = texW
        coverageCanvas.height = texH
        const coverageCtx = coverageCanvas.getContext('2d')
        coverageCtx.fillStyle = '#000000'
        coverageCtx.fillRect(0, 0, texW, texH)
        const coverageImage = coverageCtx.getImageData(0, 0, texW, texH)
        const coverageData = coverageImage.data
        let hasAnyCoverage = false
        for (const layer of projectionLayers) {
          if (layer?.visible === false) continue
          const data = projectionLayerDataRef.current.get(layer.id)
          if (!data?.coverageMask || data.coverageMask.length !== texW * texH) continue
          hasAnyCoverage = true
          for (let i = 0; i < data.coverageMask.length; i += 1) {
            if (data.coverageMask[i] > 0) {
              coverageData[i * 4] = 255
              coverageData[i * 4 + 1] = 255
              coverageData[i * 4 + 2] = 255
              coverageData[i * 4 + 3] = 255
            }
          }
        }

        const renderMaskFromUVCanvas = (uvCanvas) => {
          const tex = createCanvasTexture(uvCanvas, texturableMesh.textureConfig)
          try {
            return captureTexturedMeshView({
              root: texturableMesh.root,
              textureKey: texturableMesh.textureKey,
              displayTexture: tex,
              camera: projectionCamera,
              width: sendResolution,
              height: sendResolution,
              renderMode: 'textured'
            })
          } finally {
            tex.dispose?.()
          }
        }

        // Threshold the mask render's brightness against the dark scene background
        // (#0b0d12 ≈ 11) so off-mesh and the inverse-classified surface both
        // become fully transparent.
        const composeMaskedView = (maskRenderCanvas) => {
          const composedCanvas = document.createElement('canvas')
          composedCanvas.width = sendResolution
          composedCanvas.height = sendResolution
          const composedCtx = composedCanvas.getContext('2d')
          composedCtx.drawImage(texturedViewCanvas, 0, 0)
          const composed = composedCtx.getImageData(0, 0, sendResolution, sendResolution)
          const maskPixels = maskRenderCanvas.getContext('2d').getImageData(0, 0, sendResolution, sendResolution).data
          for (let i = 0; i < composed.data.length; i += 4) {
            composed.data[i + 3] = maskPixels[i] > 64 ? 255 : 0
          }
          composedCtx.putImageData(composed, 0, 0)
          return composedCanvas
        }

        if (hasAnyCoverage) {
          coverageCtx.putImageData(coverageImage, 0, 0)

          if (texturedViewParamId) {
            const maskedTextured = composeMaskedView(renderMaskFromUVCanvas(coverageCanvas))
            texturedViewFile = await canvasToFile(maskedTextured, 'projection-textured-view.png')
          }

          if (untexturedViewParamId) {
            setFeedback('Capturing untextured view...')
            // Invert: covered → black, uncovered → white. Off-mesh stays as
            // scene background (~11) and is rejected by the same threshold.
            const invertedCanvas = document.createElement('canvas')
            invertedCanvas.width = texW
            invertedCanvas.height = texH
            const invertedCtx = invertedCanvas.getContext('2d')
            const invertedImage = invertedCtx.createImageData(texW, texH)
            const invertedData = invertedImage.data
            for (let i = 0; i < coverageData.length; i += 4) {
              const v = coverageData[i] > 0 ? 0 : 255
              invertedData[i] = v
              invertedData[i + 1] = v
              invertedData[i + 2] = v
              invertedData[i + 3] = 255
            }
            invertedCtx.putImageData(invertedImage, 0, 0)
            const maskedUntextured = composeMaskedView(renderMaskFromUVCanvas(invertedCanvas))
            untexturedViewFile = await canvasToFile(maskedUntextured, 'projection-untextured-view.png')
          }
        } else {
          // No projection coverage yet: by definition the whole mesh is
          // "untextured" and nothing is "textured". Send the full view as the
          // fallback for whichever input is configured.
          if (texturedViewParamId) {
            texturedViewFile = await canvasToFile(texturedViewCanvas, 'projection-textured-view.png')
          }
          if (untexturedViewParamId) {
            untexturedViewFile = await canvasToFile(texturedViewCanvas, 'projection-untextured-view.png')
          }
        }
      }

      const staticFiles = {}
      for (const [paramId, config] of staticImageParams) {
        let file = null
        if (config.type === 'asset') {
          const url = config.asset ? buildAssetUrl(config.asset) : buildAssetUrl({ filePath: config.filePath, filename: config.filePath })
          if (!url) {
            throw new Error(`Could not resolve selected asset for input ${paramId}.`)
          }
          const response = await fetch(url)
          if (!response.ok) {
            throw new Error(`Failed to fetch asset image (${response.status}).`)
          }
          const blob = await response.blob()
          file = new File([blob], config.assetName || 'projection-input.png', { type: blob.type || 'image/png' })
        } else if (config.type === 'file') {
          file = config.file
        }

        if (file) {
          staticFiles[paramId] = file
        }
      }

      const workflowInputs = {
        ...projectionWorkflowInputs,
        ...staticFiles,
        [positionViewParamId]: positionViewFile,
        ...(texturedViewFile ? { [texturedViewParamId]: texturedViewFile } : {}),
        ...(untexturedViewFile ? { [untexturedViewParamId]: untexturedViewFile } : {})
      }

      const promptId = createExecutionId('mesh-projection-prompt')
      const clientId = createExecutionId('mesh-projection-client')
      const stopProgress = subscribeToComfyWorkflowProgress(promptId, {
        onMessage: payload => {
          const detail = payload?.detail || payload?.currentNodeLabel
          if (detail) {
            setFeedback(detail)
          }
        },
        onError: () => {}
      })

      let generatedAssets
      try {
        setFeedback('Running projection workflow...')
        generatedAssets = await runComfyWorkflow(projectId ? Number(projectId) : null, {
          workflowId: Number(selectedProjectionWorkflow.id),
          name: `${meshName || 'Mesh'} Projection`,
          promptId,
          clientId,
          persistProcessingCard: false,
          persistGeneratedAssets: false,
          inputs: workflowInputs
        })
      } finally {
        stopProgress()
      }

      const generatedPatchAsset = pickGeneratedTextureAsset(generatedAssets)
      if (!generatedPatchAsset) {
        throw new Error('The projection workflow did not return an image output.')
      }

      setFeedback('Preparing projection layer...')
      const patchImage = await loadImageElement(buildAssetUrl(generatedPatchAsset))
      const patchCanvas = document.createElement('canvas')
      patchCanvas.width = sendResolution
      patchCanvas.height = sendResolution
      patchCanvas.getContext('2d').drawImage(patchImage, 0, 0, sendResolution, sendResolution)

      const initialCropBorder = Math.max(AUTO_PROJECTION_SEAM_SAFE_CROP_PX, 0)
      const initialBlendPixels = Math.max(AUTO_PROJECTION_SEAM_SAFE_BLEND_PX, projectionBlendPixels)

      projectionLayerCounterRef.current += 1
      const layerId = `projection-${Date.now()}-${projectionLayerCounterRef.current}`
      const layerName = `Projection ${projectionLayerCounterRef.current}`
      projectionLayerDataRef.current.set(layerId, {
        camera: projectionCamera.clone(),
        patchCanvas,
        bakedCanvas: null,
        bakeSignature: '',
        coverageMask: null,
        ownershipMask: null,
        sharedSeamMask: null,
        confidenceMap: null,
        generatedAsset: generatedPatchAsset,
        sendResolution,
        cropBorder: initialCropBorder
      })

      setProjectionLayers(current => ([
        ...current,
        {
          id: layerId,
          name: layerName,
          opacity: 1,
          opacitySeams: 1,
          blendMode: 'source-over',
          blendPixels: initialBlendPixels,
          cropBorder: initialCropBorder,
          visible: true,
          sendResolution
        }
      ]))

      if (projectId && nodeId) {
        await updateProjectNode(Number(projectId), Number(nodeId), {
          metadata: { lastAction: 'mesh-editor-projection' }
        })
      }

      setFeedback(`${layerName} added to the projection stack.`)
    } catch (projectionError) {
      const failureMessage = projectionError?.message || 'Failed to project workflow result to texture.'
      setError(failureMessage)
      setFeedback('')
      addNotification({
        title: 'Projection failed',
        message: failureMessage,
        source: 'ComfyUI',
        tone: 'error'
      })
    } finally {
      setProjecting(false)
    }
  }, [
    addNotification,
    meshName,
    nodeId,
    projectId,
    projectionBlendPixels,
    projectionImageParamSources,
    projectionReady,
    projectionStarted,
    projectionViewResolution,
    projectionWorkflowInputs,
    projecting,
    runComfyWorkflow,
    selectedProjectionWorkflow,
    subscribeToComfyWorkflowProgress,
    texturableMesh,
    updateProjectNode
  ])

  const handleRunTextureWorkflow = useCallback(async () => {
    if (texturing || !selectedTextureWorkflow || !texturableMesh?.textureCanvas || !texturableMesh?.maskCanvas) {
      return;
    }

    const projectionMaskCanvas = projectionMaskCanvasRef.current;
    const projectionCamera = projectionCameraRef.current;
    const bbox = getMaskBoundingBox(projectionMaskCanvas, cropPadding);

    if (!bbox) {
      setFeedback('Paint a zone on the mesh first.');
      return;
    }

    if (!projectionMaskCanvas || !projectionCamera) {
      setFeedback('Paint a zone on the mesh first.');
      return;
    }

    // Determine which parameters are source and mask from user selection
    let sourceParamId = null;
    let maskParamId = null;
    const staticImageParams = []; // { paramId, file }

    for (const [paramId, config] of Object.entries(imageParamSources)) {
      if (config.type === 'source') {
        sourceParamId = paramId;
      } else if (config.type === 'mask') {
        maskParamId = paramId;
      } else if (config.type === 'asset' || config.type === 'file') {
        staticImageParams.push({ paramId, config });
      }
    }

    if (!sourceParamId || !maskParamId) {
      setFeedback('Please select one image input as source and one as mask.');
      return;
    }

    const textureWidth = texturableMesh.textureCanvas.width;
    const textureHeight = texturableMesh.textureCanvas.height;
    const screenW = projectionMaskCanvas.width;
    const screenH = projectionMaskCanvas.height;

    const orbitTarget = estimateMaskOrbitTarget({
      root: texturableMesh.root,
      textureKey: texturableMesh.textureKey,
      maskCanvas: projectionMaskCanvas,
      camera: projectionCamera
    }) || new THREE.Box3()
      .setFromObject(texturableMesh.root)
      .getCenter(new THREE.Vector3());

    const cameras = generateOrbitalCameras(projectionCamera, orbitTarget, multiViewCount - 1, 30);
    const viewResults = [];

    try {
      setTexturing(true);
      setError('');

      // Pre‑upload static images (assets / local files) to ComfyUI once
      const staticFiles = {};
      for (const { paramId, config } of staticImageParams) {
        let file = null;
        if (config.type === 'asset') {
          // Build asset URL
          const url = config.filePath ? `http://localhost:3001/assets/${encodeURI(config.filePath.replace(/^data\/assets\//, ''))}` : null;
          if (!url) throw new Error(`Asset ${config.assetName} has no file path`);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to load asset ${config.assetName}`);
          const blob = await response.blob();
          file = new File([blob], config.assetName || 'image.png', { type: blob.type || 'image/png' });
        } else if (config.type === 'file') {
          file = config.file;
        }
        if (file) staticFiles[paramId] = file;
      }

      let anyViewApplied = false;

      for (let viewIndex = 0; viewIndex < cameras.length; viewIndex += 1) {
        const viewCamera = cameras[viewIndex];
        const viewLabel = cameras.length > 1 ? ` (view ${viewIndex + 1}/${cameras.length})` : '';

        // Resolve screen‑space mask for this camera
        let viewScreenMask, viewBbox;
        if (viewIndex === 0) {
          viewScreenMask = projectionMaskCanvas;
          viewBbox = bbox;
        } else {
          setFeedback(`Rendering mask projection${viewLabel}…`);
          viewScreenMask = captureTextureMaskScreenView({
            root: texturableMesh.root,
            textureKey: texturableMesh.textureKey,
            maskCanvas: texturableMesh.maskCanvas,
            textureConfig: texturableMesh.textureConfig,
            camera: viewCamera,
            width: screenW,
            height: screenH,
            ignoreOcclusion: true
          });
          viewBbox = getMaskBoundingBox(viewScreenMask, cropPadding);
          if (!viewBbox) continue;
        }

        setFeedback(`Capturing view${viewLabel}…`);
        const colorViewCanvas = captureTexturedMeshView({
          root: texturableMesh.root,
          textureKey: texturableMesh.textureKey,
          displayTexture: displayTextureRef.current,
          camera: viewCamera,
          width: screenW,
          height: screenH
        });

        const croppedSource = cropCanvas(colorViewCanvas, viewBbox);
        const croppedMask = cropCanvas(viewScreenMask, viewBbox);

        // Supersample to ~1024px
				let supersample = 1024;
        const ssSourceCanvas = document.createElement('canvas');
        const ssMaskCanvas = document.createElement('canvas');
        let ssSourceFile = null, ssMaskFile = null;
        if (croppedSource.width > 0 && croppedSource.height > 0) {
          const scale = Math.max(supersample / croppedSource.width, supersample / croppedSource.height, 1);
          ssSourceCanvas.width = Math.round(croppedSource.width * scale);
          ssSourceCanvas.height = Math.round(croppedSource.height * scale);
          ssSourceCanvas.getContext('2d').drawImage(croppedSource, 0, 0, ssSourceCanvas.width, ssSourceCanvas.height);
          ssMaskCanvas.width = Math.round(croppedMask.width * scale);
          ssMaskCanvas.height = Math.round(croppedMask.height * scale);
          ssMaskCanvas.getContext('2d').drawImage(croppedMask, 0, 0, ssMaskCanvas.width, ssMaskCanvas.height);
          ssSourceFile = await canvasToFile(ssSourceCanvas, `source-view-${viewIndex}.png`);
          ssMaskFile = await canvasToFile(ssMaskCanvas, `mask-view-${viewIndex}.png`);
        }

        // Prepare workflow inputs for this view
        const viewWorkflowInputs = {
          ...textureWorkflowInputs,
          [sourceParamId]: ssSourceFile,
          [maskParamId]: ssMaskFile,
          ...staticFiles
        };

        const viewPromptId = createExecutionId('mesh-texture-prompt');
        const viewClientId = createExecutionId('mesh-texture-client');

        const stopProgress = subscribeToComfyWorkflowProgress(viewPromptId, {
          onMessage: payload => {
            const detail = payload?.detail || payload?.currentNodeLabel;
            if (detail) setFeedback(`${detail}${viewLabel}`);
          },
          onError: () => { }
        });

        let generatedAssets;
        try {
          setFeedback(`Running inpaint workflow${viewLabel}…`);
          generatedAssets = await runComfyWorkflow(projectId ? Number(projectId) : null, {
            workflowId: Number(selectedTextureWorkflow.id),
            name: `${meshName || 'Mesh'} Texture`,
            promptId: viewPromptId,
            clientId: viewClientId,
            persistProcessingCard: false,
            persistGeneratedAssets: false,
            inputs: viewWorkflowInputs
          });
        } finally {
          stopProgress();
        }

        const generatedPatchAsset = pickGeneratedTextureAsset(generatedAssets);
        if (!generatedPatchAsset) {
          throw new Error(cameras.length > 1
            ? `The texture workflow did not return any image for view ${viewIndex + 1}.`
            : 'The texture workflow did not return any image.');
        }

        const patchImage = await loadImageElement(buildAssetUrl(generatedPatchAsset));
        const viewAccumulatedColor = new Float32Array(textureWidth * textureHeight * 4);
        const viewAccumulatedWeight = new Float32Array(textureWidth * textureHeight);
        const viewPatchCanvas = document.createElement('canvas');
        viewPatchCanvas.width = textureWidth;
        viewPatchCanvas.height = textureHeight;
        const viewPatchContext = viewPatchCanvas.getContext('2d', { willReadFrequently: true }) || viewPatchCanvas.getContext('2d');
        viewPatchContext.drawImage(texturableMesh.textureCanvas, 0, 0);

        viewResults.push({
          camera: viewCamera,
          maskCanvas: viewScreenMask,
          bbox: viewBbox,
          patchImage,
          patchCanvas: viewPatchCanvas
        });

        await accumulateProjectedPatch({
          root: texturableMesh.root,
          textureKey: texturableMesh.textureKey,
          textureConfig: texturableMesh.textureConfig,
          camera: viewCamera,
          maskCanvas: viewScreenMask,
          bbox: viewBbox,
          patchImage,
          featherRadius,
          accumulatedColor: viewAccumulatedColor,
          accumulatedWeight: viewAccumulatedWeight,
          textureWidth,
          textureHeight,
          onProgress: progress => {
            setFeedback(`Reprojecting${viewLabel}… ${Math.round(progress * 100)}%`);
          },
					binaryMask: featherRadius === 0
        });

        finalizeProjectedPatch({
          textureCanvas: viewPatchCanvas,
          accumulatedColor: viewAccumulatedColor,
          accumulatedWeight: viewAccumulatedWeight
        });

        anyViewApplied = true;
      }

      if (!anyViewApplied) {
        throw new Error('No camera angle could see the painted region. Try painting from a more direct angle.');
      }

      // Finalize – composite all view patches
      const backupCanvas = document.createElement('canvas');
      backupCanvas.width = textureWidth;
      backupCanvas.height = textureHeight;
      backupCanvas.getContext('2d').drawImage(texturableMesh.textureCanvas, 0, 0);
      originalTextureBackupRef.current = backupCanvas;

      const maskBackup = document.createElement('canvas');
      maskBackup.width = screenW;
      maskBackup.height = screenH;
      maskBackup.getContext('2d').drawImage(projectionMaskCanvas, 0, 0);
      projectionMaskBackupRef.current = maskBackup;

      const patchedCanvas = document.createElement('canvas');
      patchedCanvas.width = textureWidth;
      patchedCanvas.height = textureHeight;
      const patchedContext = patchedCanvas.getContext('2d');
      patchedContext.drawImage(backupCanvas, 0, 0);

      const rawOpacities = projectionOpacities.slice(0, viewResults.length);
      const totalOpacity = rawOpacities.reduce((sum, v) => sum + Math.max(0, Math.min(1, v)), 0);
      if (totalOpacity > 0) {
        viewResults.forEach((viewData, viewIndex) => {
          const raw = Math.max(0, Math.min(1, projectionOpacities[viewIndex] ?? 1));
          if (raw <= 0 || !viewData.patchCanvas) return;
          const normalizedAlpha = raw / totalOpacity;
          patchedContext.globalAlpha = normalizedAlpha;
          patchedContext.drawImage(viewData.patchCanvas, 0, 0);
        });
      }
      patchedContext.globalAlpha = 1;
      patchedTextureRef.current = patchedCanvas;
      projectionViewDataRef.current = viewResults;

      clearCanvas(texturableMesh.maskCanvas);
      clearCanvas(projectionMaskCanvas);
      projectionCameraRef.current = null;
      setHasProjectionMask(false);
      updateCanvasTexture(maskTextureRef.current);

      applyPatchBlendToCanvas(
        backupCanvas,
        patchedCanvas,
        texturableMesh.textureCanvas,
        1,
        patchNoise,
        patchSharpness,
        patchSaturation,
        projectionMaskBackupRef.current,
        featherRadius
      );
      updateCanvasTexture(displayTextureRef.current);
      setTextureRevision(current => current + 1);
      updateMaskOverlay();

      if (projectId && nodeId) {
        await updateProjectNode(Number(projectId), Number(nodeId), {
          metadata: { lastAction: 'mesh-editor-texture' }
        });
      }

      setPendingPatch({ timestamp: Date.now() });
      setFeedback(
        cameras.length > 1
          ? `Patch ready (${cameras.length} views accumulated) — adjust per-view opacity, then Apply or Cancel.`
          : 'Patch ready — adjust the review sliders, then click Apply or Cancel.'
      );
    } catch (textureError) {
      const failureMessage = textureError.message || 'Failed to regenerate the mesh texture.'
      setError(failureMessage);
      setFeedback('');
      addNotification({
        title: 'Mesh edit failed',
        message: failureMessage,
        source: 'ComfyUI',
        tone: 'error'
      })
    } finally {
      setTexturing(false);
    }
  }, [
    cropPadding, featherRadius, meshName, multiViewCount, nodeId,
    patchNoise, patchSharpness, patchSaturation, projectionOpacities,
    projectId, runComfyWorkflow, selectedTextureWorkflow,
    subscribeToComfyWorkflowProgress, texturableMesh,
    textureWorkflowInputs, texturing, updateProjectNode,
    updateMaskOverlay, imageParamSources, addNotification
  ]);

  const handleApplyPatch = useCallback(() => {
    if (!pendingPatch) {
      return
    }

    // The textureCanvas already holds the blended result — just clean up refs
    originalTextureBackupRef.current = null
    patchedTextureRef.current = null
    projectionViewDataRef.current = []
    projectionMaskBackupRef.current = null
    setPendingPatch(null)
    updateMaskOverlay();
    setPatchNoise(0)
    setProjectionOpacities([1])
    setFeedback('Texture patch applied.')
  }, [pendingPatch, updateMaskOverlay])

  const handleCancelPatch = useCallback(() => {
    if (!pendingPatch || !originalTextureBackupRef.current || !texturableMesh?.textureCanvas) {
      return
    }

    // Restore the original texture from the backup canvas
    const ctx = texturableMesh.textureCanvas.getContext('2d')
    ctx.clearRect(0, 0, texturableMesh.textureCanvas.width, texturableMesh.textureCanvas.height)
    ctx.drawImage(originalTextureBackupRef.current, 0, 0)
    updateCanvasTexture(displayTextureRef.current)
    setTextureRevision(current => current + 1)

    originalTextureBackupRef.current = null
    patchedTextureRef.current = null
    projectionViewDataRef.current = []
    projectionMaskBackupRef.current = null
    setPendingPatch(null)
    updateMaskOverlay();
    setPatchNoise(0)
    setProjectionOpacities([1])
    setFeedback('Texture patch cancelled.')
  }, [pendingPatch, texturableMesh, updateMaskOverlay])

  const deleteDisabled = selectionMode === 'face' ? selectedFaceIndices.length === 0 : selectedVertexIndices.length === 0
  const smoothDisabled = selectedVertexIndices.length === 0
  const mergeDisabled = selectedVertexIndices.length < 2
  const subdivideDisabled = selectedFaceIndices.length === 0
  const bridgeDisabled = selectionMode !== 'vertex' || selectedVertexIndices.length < 4
  // Fill is enabled whenever we have geometry: when there's no selection we
  // fall back to filling every hole in the mesh.
  const fillDisabled = !geometry

  return (
    <div className="mesh-editor-layout">
      <Header onSettingsClick={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="mesh-editor-page">
        <section className="mesh-editor-shell">
          <div className="mesh-editor-toolbar">
            <div className="mesh-editor-toolbar__group">
              <button type="button" className="mesh-editor-toolbar__back" onClick={handleBack}>
                <span className="material-symbols-outlined">arrow_back</span>
                Back
              </button>
              <div className="mesh-editor-toolbar__title-group">
                <h1 className="mesh-editor-page__title font-headline">Mesh Editor</h1>
              </div>
              <div className="mesh-editor-toolbar__name-field">
                <label className="mesh-editor-panel__label">Mesh name</label>
              </div>
              <div className="mesh-editor-toolbar__name-field">
                <input className="mesh-editor-panel__input" value={meshName} onChange={event => setMeshName(event.target.value)} />
              </div>
              <div className="mesh-editor-toolbar__save-panel">
                <label className="mesh-editor-panel__label">Save</label>
              </div>
              <div className="mesh-editor-actions mesh-editor-toolbar__save-actions">
                <button type="button" className="mesh-editor-btn mesh-editor-btn--primary" onClick={() => handleSave('replace')} disabled={saving || !geometry}>Save mesh</button>
                <button type="button" className="mesh-editor-btn mesh-editor-btn--secondary" onClick={() => handleSave('version')} disabled={saving || !geometry}>Save as version</button>
                <button
                  type="button"
                  className={`mesh-editor-btn ${showShadows ? 'mesh-editor-btn--secondary' : 'mesh-editor-btn--ghost'}`}
                  onClick={() => setShowShadows(current => !current)}
                  aria-pressed={showShadows}
                  title="Toggle scene shadows"
                >
                  {showShadows ? 'Shadows on' : 'Shadows off'}
                </button>
                <button
                  type="button"
                  className={`mesh-editor-btn ${showAlbedo ? 'mesh-editor-btn--secondary' : 'mesh-editor-btn--ghost'}`}
                  onClick={() => setShowAlbedo(current => !current)}
                  aria-pressed={showAlbedo}
                  title="Toggle albedo (unlit) / PBR shading"
                >
                  {showAlbedo ? 'Albedo' : 'PBR'}
                </button>
              </div>
            </div>
            <div className="mesh-editor-toolbar__stats">
              <span>{stats.vertices} vertices</span>
              <span>{stats.faces} faces</span>
            </div>
          </div>

          {(error || feedback) && (
            <div className={`mesh-editor-feedback ${error ? 'mesh-editor-feedback--error' : 'mesh-editor-feedback--success'}`}>
              <span className="material-symbols-outlined">{error ? 'error' : 'check_circle'}</span>
              <span>{error || feedback}</span>
            </div>
          )}

          <div className={`mesh-editor-workspace ${(activeMenu === 'painting' || activeMenu === 'projection') ? 'mesh-editor-workspace--with-layers' : ''}`}>
            <aside className="mesh-editor-sidebar">
              <div className="mesh-editor-panel mesh-editor-panel--compact">
                <span className="mesh-editor-panel__label">Tools</span>
                <div className="mesh-editor-mode-menu">
                  <button
                    type="button"
                    className={`mesh-editor-mode-btn ${activeMenu === 'modeling' ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => setActiveMenu('modeling')}
                  >
                    <span className="material-symbols-outlined">deployed_code</span>
                    <span>Modeling</span>
                  </button>
                  <button
                    type="button"
                    className={`mesh-editor-mode-btn ${activeMenu === 'texturing' ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => setActiveMenu('texturing')}
                    disabled={!textureModesSupported}
                    title={textureModesDisabledReason || undefined}
                  >
                    <span className="material-symbols-outlined">texture</span>
                    <span>Texturing</span>
                  </button>
                  <button
                    type="button"
                    className={`mesh-editor-mode-btn ${activeMenu === 'painting' ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => setActiveMenu('painting')}
                    disabled={!textureModesSupported}
                    title={textureModesDisabledReason || undefined}
                  >
                    <span className="material-symbols-outlined">brush</span>
                    <span>Painting</span>
                  </button>
                  <button
                    type="button"
                    className={`mesh-editor-mode-btn ${activeMenu === 'projection' ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => setActiveMenu('projection')}
                    disabled={!textureModesSupported}
                    title={textureModesDisabledReason || undefined}
                  >
                    <span className="material-symbols-outlined">filter_center_focus</span>
                    <span>Projection</span>
                  </button>
                  <button
                    type="button"
                    className={`mesh-editor-mode-btn ${activeMenu === 'boolean' ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => setActiveMenu('boolean')}
                    title="Apply brush-based displacement operations"
                  >
                    <span className="material-symbols-outlined">difference</span>
                    <span>Displace</span>
                  </button>
                  <button
                    type="button"
                    className={`mesh-editor-mode-btn ${activeMenu === 'sculpting' ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => setActiveMenu('sculpting')}
                    title="Sculpt the mesh with brushes"
                  >
                    <span className="material-symbols-outlined">back_hand</span>
                    <span>Sculpting</span>
                  </button>
                </div>

                {activeMenu === 'modeling' ? (
                  <>{/* MODELING */}
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Selection</span>
                      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
                        <button
                          type="button"
                          className={`mesh-editor-icon-btn ${selectionMode === 'face' ? 'mesh-editor-icon-btn--active' : ''}`}
                          onClick={() => {
                            setSelectionMode('face')
                            resetSelection()
                          }}
                          title="Face selection"
                        >
                          <span className="material-symbols-outlined">crop_square</span>
                          <span>Faces</span>
                        </button>
                        <button
                          type="button"
                          className={`mesh-editor-icon-btn ${selectionMode === 'vertex' ? 'mesh-editor-icon-btn--active' : ''}`}
                          onClick={() => {
                            setSelectionMode('vertex')
                            resetSelection()
                          }}
                          title="Vertex selection"
                        >
                          <span className="material-symbols-outlined">scatter_plot</span>
                          <span>Vertices</span>
                        </button>
                      </div>
                    </div>

                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">History</span>
                      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleModelingUndo} disabled={!modelingCanUndo} title="Undo (Ctrl+Z)">
                          <span className="material-symbols-outlined">undo</span>
                          <span>Undo</span>
                        </button>
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleModelingRedo} disabled={!modelingCanRedo} title="Redo (Ctrl+Shift+Z)">
                          <span className="material-symbols-outlined">redo</span>
                          <span>Redo</span>
                        </button>
                      </div>
                    </div>

                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Actions</span>
                      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleDelete} disabled={deleteDisabled} title="Delete selection">
                          <span className="material-symbols-outlined">delete</span>
                          <span>Delete</span>
                        </button>
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleSmooth} disabled={smoothDisabled} title="Smooth selected vertices">
                          <span className="material-symbols-outlined">auto_fix_high</span>
                          <span>Smooth</span>
                        </button>
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleMerge} disabled={mergeDisabled} title="Merge selected vertices">
                          <span className="material-symbols-outlined">merge_type</span>
                          <span>Merge</span>
                        </button>
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleSubdivide} disabled={subdivideDisabled} title="Subdivide selected faces">
                          <span className="material-symbols-outlined">grid_view</span>
                          <span>Subdivide</span>
                        </button>
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleBridge} disabled={bridgeDisabled} title="Bridge selected hole segments">
                          <span className="material-symbols-outlined">alt_route</span>
                          <span>Bridge</span>
                        </button>
                        <button type="button" className="mesh-editor-icon-btn" onClick={handleFillHole} disabled={fillDisabled} title="Fill selected hole">
                          <span className="material-symbols-outlined">layers_clear</span>
                          <span>Fill hole</span>
                        </button>
                      </div>
                    </div>

                    <div className="mesh-editor-panel__notes">
                      <span className="mesh-editor-panel__hint">Left mouse drag selects with a rectangle. Shift+drag adds or removes items.</span>
                      <span className="mesh-editor-panel__hint">Middle mouse drag rotates the mesh.</span>
                    </div>
                  </>
                ) : activeMenu === 'boolean' ? (
                  <>{/* DISPLACE */}
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Displace stamp</span>

                      <div className="mesh-editor-workflow-field">
                        <span>Brush source</span>
                        <select
                          className="mesh-editor-panel__input mesh-editor-panel__select"
                          value={booleanBrushSource}
                          onChange={event => setBooleanBrushSource(event.target.value)}
                        >
                          <option value="asset">From assets</option>
                          <option value="computer">From computer</option>
                        </select>
                      </div>

                      {booleanBrushSource === 'asset' ? (
                        <button
                          type="button"
                          className="mesh-editor-btn mesh-editor-btn--secondary"
                          onClick={() => setShowBooleanBrushSelector(true)}
                        >
                          <span className="material-symbols-outlined">stamp</span>
                          {booleanBrushAsset ? `Brush: ${booleanBrushAsset.name}` : 'Choose displace brush…'}
                        </button>
                      ) : (
                        <div className="mesh-editor-workflow-field">
                          <input
                            ref={booleanBrushFileInputRef}
                            type="file"
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={event => {
                              const file = event.target.files?.[0]
                              if (file) {
                                setBooleanBrushFile(file)
                                setBooleanBrushAsset(null)
                              }
                              event.target.value = ''
                            }}
                          />
                          <button
                            type="button"
                            className="mesh-editor-btn mesh-editor-btn--secondary"
                            onClick={() => booleanBrushFileInputRef.current?.click()}
                          >
                            <span className="material-symbols-outlined">upload_file</span>
                            {booleanBrushFile ? booleanBrushFile.name : 'Upload displace brush…'}
                          </button>
                        </div>
                      )}

                      <div className="mesh-editor-workflow-field">
                        <span>Operation</span>
                        <select
                          className="mesh-editor-panel__input mesh-editor-panel__select"
                          value={booleanOperation}
                          onChange={event => setBooleanOperation(event.target.value)}
                        >
                          <option value="out">Out</option>
                          <option value="in">In</option>
                        </select>
                      </div>

                      <button
                        type="button"
                        className={`mesh-editor-btn ${booleanPlaceMode ? 'mesh-editor-btn--primary' : 'mesh-editor-btn--ghost'}`}
                        disabled={!booleanBrushMaskRef.current}
                        onClick={() => {
                          setBooleanPlaceMode(current => !current)
                          if (booleanPlaceMode) {
                            setBooleanStampBasis(null)
                          }
                        }}
                      >
                        <span className="material-symbols-outlined">ads_click</span>
                        {booleanPlaceMode ? 'Placing: move pointer on mesh' : 'Place stamp'}
                      </button>

                      <label className="mesh-editor-range-field">
                        <span>Size</span>
                        <input
                          type="range"
                          min="0.01"
                          max={Math.max(0.05, stats.faces > 0 ? booleanStampSize * 4 : 1)}
                          step="0.001"
                          value={booleanStampSize}
                          onChange={event => setBooleanStampSize(Number(event.target.value))}
                          disabled={!booleanBrushMaskRef.current}
                        />
                        <strong>{booleanStampSize.toFixed(3)}</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Depth</span>
                        <input
                          type="range"
                          min="0.001"
                          max={Math.max(0.02, booleanStampDepth * 6)}
                          step="0.001"
                          value={booleanStampDepth}
                          onChange={event => setBooleanStampDepth(Number(event.target.value))}
                          disabled={!booleanBrushMaskRef.current}
                        />
                        <strong>{booleanStampDepth.toFixed(3)}</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Tessellation</span>
                        <input
                          type="range"
                          min="0"
                          max="4"
                          step="1"
                          value={booleanTessellation}
                          onChange={event => setBooleanTessellation(Number(event.target.value))}
                          disabled={!booleanBrushMaskRef.current}
                        />
                        <strong>x{booleanTessellation}</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Rotation</span>
                        <input
                          type="range"
                          min="0"
                          max="360"
                          step="1"
                          value={booleanStampRotation}
                          onChange={event => setBooleanStampRotation(Number(event.target.value))}
                          disabled={!booleanStampBasis}
                        />
                        <strong>{booleanStampRotation}°</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Normal offset</span>
                        <input
                          type="range"
                          min={-Math.max(0.01, booleanStampDepth * 2)}
                          max={Math.max(0.01, booleanStampDepth * 2)}
                          step="0.001"
                          value={booleanStampOffset}
                          onChange={event => setBooleanStampOffset(Number(event.target.value))}
                          disabled={!booleanStampBasis}
                        />
                        <strong>{booleanStampOffset.toFixed(3)}</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Nudge X</span>
                        <input
                          type="range"
                          min={-Math.max(0.01, booleanStampSize)}
                          max={Math.max(0.01, booleanStampSize)}
                          step="0.001"
                          value={booleanStampNudgeX}
                          onChange={event => setBooleanStampNudgeX(Number(event.target.value))}
                          disabled={!booleanStampBasis}
                        />
                        <strong>{booleanStampNudgeX.toFixed(3)}</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Nudge Y</span>
                        <input
                          type="range"
                          min={-Math.max(0.01, booleanStampSize)}
                          max={Math.max(0.01, booleanStampSize)}
                          step="0.001"
                          value={booleanStampNudgeY}
                          onChange={event => setBooleanStampNudgeY(Number(event.target.value))}
                          disabled={!booleanStampBasis}
                        />
                        <strong>{booleanStampNudgeY.toFixed(3)}</strong>
                      </label>

                      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
                        <button
                          type="button"
                          className="mesh-editor-btn mesh-editor-btn--primary"
                          onClick={handleApplyBoolean}
                          disabled={!booleanStampLocalGeometry || !booleanStampMatrix}
                          title="Apply displacement operation"
                        >
                          <span className="material-symbols-outlined">check</span>
                          <span>Apply Displace</span>
                        </button>
                        <button
                          type="button"
                          className="mesh-editor-btn mesh-editor-btn--ghost"
                          onClick={handleClearBooleanStamp}
                          disabled={!booleanStampBasis && !booleanPlaceMode}
                          title="Clear displacement placement"
                        >
                          <span className="material-symbols-outlined">close</span>
                          <span>Clear</span>
                        </button>
                      </div>
                    </div>

                    <div className="mesh-editor-panel__notes">
                      <span className="mesh-editor-panel__hint">Pick a brush, click Place stamp, move over mesh to position, then click to lock. Click the mesh again to reposition.</span>
                      <span className="mesh-editor-panel__hint">Use size/depth/rotation/offset and nudge sliders for final placement.</span>
                      <span className="mesh-editor-panel__hint">Click Apply Displace to commit Out / In operations.</span>
                    </div>
                  </>
                ) : activeMenu === 'texturing' ? (
                  <>{/* TEXTURING */}
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Brush</span>
                      <label className="mesh-editor-range-field">
                        <span>Size</span>
                        <input type="range" min="4" max="96" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
                        <strong>{brushSize}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Crop margin</span>
                        <input type="range" min="0" max="256" value={cropPadding} onChange={event => setCropPadding(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
                        <strong>{cropPadding}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Feather</span>
                        <input type="range" min="0" max="32" value={featherRadius} onChange={event => setFeatherRadius(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
                        <strong>{featherRadius}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Projection views <em className="mesh-editor-range-field__sub">(coverage vs speed)</em></span>
                        <input
                          type="range" min="1" max="7" step="1"
                          value={multiViewCount}
                          onChange={e => setMultiViewCount(Number(e.target.value))}
                          disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                        />
                        <strong>{multiViewCount} {multiViewCount === 1 ? 'view (current)' : `views (±${(multiViewCount - 1) * 30}°)`}</strong>
                      </label>
                      <button type="button" className="mesh-editor-btn mesh-editor-btn--ghost" onClick={handleClearTextureMask} disabled={!!texturingUnavailableReason || !!pendingPatch}>Clear mask</button>
                    </div>

                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">AI workflow</span>
                      <select
                        className="mesh-editor-panel__input mesh-editor-panel__select"
                        value={textureWorkflowId}
                        onChange={event => setTextureWorkflowId(event.target.value)}
                        disabled={comfyLoading || texturingWorkflows.length === 0 || !!texturingUnavailableReason || !!pendingPatch}
                      >
                        {texturingWorkflows.length === 0 ? (
                          <option value="">No 2-image ComfyUI workflow found</option>
                        ) : (
                          texturingWorkflows.map(workflow => (
                            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                          ))
                        )}
                      </select>

                      {selectedTextureWorkflow && (
                        <div className="mesh-editor-panel__section">
                          <span className="mesh-editor-panel__section-title">Image Inputs Configuration</span>
                          {(selectedTextureWorkflow.parameters || [])
                            .filter(input => getWorkflowValueType(input) === 'image')
                            .map(param => {
                              const config = imageParamSources[param.id] || { type: 'none' };
                              return (
                                <div key={param.id} className="mesh-editor-workflow-field">
                                  <span>{param.name}</span>
                                  <select
                                    className="mesh-editor-panel__input mesh-editor-panel__select"
                                    value={config.type}
                                    onChange={(e) => handleImageParamSourceChange(param.id, e.target.value)}
                                    disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                                  >
                                    <option value="none">— Not used —</option>
                                    <option value="source">Use as source image (painted mesh view)</option>
                                    <option value="mask">Use as mask image (painted mask)</option>
                                    <option value="asset">From assets</option>
                                    <option value="file">From computer</option>
                                  </select>
                                  {config.type === 'asset' && (
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                                      <span className="mesh-editor-panel__hint" style={{ flex: 1 }}>{config.assetName || 'No asset selected'}</span>
                                      <button
                                        type="button"
                                        className="mesh-editor-btn mesh-editor-btn--ghost"
                                        onClick={() => {
                                          setPendingAssetParamId(param.id);
                                          setPendingAssetSelectorMode('texturing');
                                          setShowAssetSelector(true);
                                        }}
                                        disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                                      >
                                        Browse
                                      </button>
                                    </div>
                                  )}
                                  {config.type === 'file' && (
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                                      <span className="mesh-editor-panel__hint" style={{ flex: 1 }}>{config.fileName || 'No file chosen'}</span>
                                      <label className="mesh-editor-btn mesh-editor-btn--ghost" style={{ cursor: 'pointer' }}>
                                        Choose file
                                        <input
                                          type="file"
                                          accept="image/*"
                                          style={{ display: 'none' }}
                                          onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) {
                                              handleImageParamSourceChange(param.id, 'file', file);
                                            }
                                          }}
                                          disabled={!!texturingUnavailableReason || !!pendingPatch || texturing}
                                        />
                                      </label>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                        </div>
                      )}

                      {textureWorkflowParameters.map(parameter => {
                        const valueType = getWorkflowValueType(parameter)
                        const currentValue = textureWorkflowInputs?.[parameter.id]

                        return (
                          <label key={parameter.id} className="mesh-editor-workflow-field">
                            <span>{parameter.name}</span>
                            {valueType === 'boolean' ? (
                              <button
                                type="button"
                                className={`mesh-editor-toggle ${currentValue ? 'mesh-editor-toggle--active' : ''}`}
                                onClick={() => handleTextureWorkflowInputChange(parameter, !currentValue)}
                                disabled={!!texturingUnavailableReason || !!pendingPatch}
                              >
                                {currentValue ? 'Enabled' : 'Disabled'}
                              </button>
                            ) : valueType === 'string' ? (
                              <textarea
                                className="mesh-editor-panel__input mesh-editor-panel__textarea"
                                value={currentValue ?? ''}
                                onChange={event => handleTextureWorkflowInputChange(parameter, event.target.value)}
                                disabled={!!texturingUnavailableReason || !!pendingPatch}
                              />
                            ) : (
                              <input
                                type="number"
                                className="mesh-editor-panel__input"
                                value={currentValue ?? ''}
                                onChange={event => handleTextureWorkflowInputChange(parameter, event.target.value)}
                                disabled={!!texturingUnavailableReason || !!pendingPatch}
                              />
                            )}
                          </label>
                        )
                      })}

                      {pendingPatch ? (
                        <div className="mesh-editor-patch-preview">
                          <span className="mesh-editor-panel__section-title mesh-editor-patch-preview__title">
                            <span className="material-symbols-outlined">tune</span>
                            Review patch
                          </span>
                          <div className="mesh-editor-panel__section mesh-editor-panel__section--nested">
                            <span className="mesh-editor-panel__section-title">Projection opacity</span>
                            {projectionOpacities.slice(0, multiViewCount).map((value, index) => (
                              <label key={`projection-opacity-${index}`} className="mesh-editor-range-field">
                                <span>{index === 0 ? 'Current view' : `View ${index + 1}`}</span>
                                <input
                                  type="range"
                                  min="0"
                                  max="1"
                                  step="0.01"
                                  value={value}
                                  onChange={event => {
                                    const nextValue = Number(event.target.value)
                                    setProjectionOpacities(current => current.map((item, itemIndex) => (itemIndex === index ? nextValue : item)))
                                  }}
                                />
                                <strong>{Math.round(value * 100)}%</strong>
                              </label>
                            ))}
                          </div>
                          <label className="mesh-editor-range-field">
                            <span>Noise <em className="mesh-editor-range-field__sub">(Prevent Seams)</em></span>
                            <input
                              type="range"
                              min="0"
                              max="32"
                              step="1"
                              value={patchNoise}
                              onChange={event => setPatchNoise(Number(event.target.value))}
                            />
                            <strong>{patchNoise}</strong>
                          </label>
                          <label className="mesh-editor-range-field">
                            <strong>Sharpness</strong>
                            <input
                              type="range"
                              min="0"
                              max="2"
                              step="0.01"
                              value={patchSharpness}
                              onChange={(e) => setPatchSharpness(parseFloat(e.target.value))}
                            />
                            <strong>{patchSharpness}</strong>
                          </label>
                          <label className="mesh-editor-range-field">
                            <strong>Saturation</strong>
                            <input
                              type="range"
                              min="0"
                              max="2"
                              step="0.01"
                              value={patchSaturation}
                              onChange={(e) => setPatchSaturation(parseFloat(e.target.value))}
                            />
                            <strong>{patchSaturation}</strong>
                          </label>
                          <div className="mesh-editor-actions mesh-editor-patch-preview__actions">
                            <button
                              type="button"
                              className="mesh-editor-btn mesh-editor-btn--primary"
                              onClick={handleApplyPatch}
                            >
                              <span className="material-symbols-outlined">check</span>
                              Apply
                            </button>
                            <button
                              type="button"
                              className="mesh-editor-btn mesh-editor-btn--ghost"
                              onClick={handleCancelPatch}
                            >
                              <span className="material-symbols-outlined">close</span>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" className="mesh-editor-btn mesh-editor-btn--primary" onClick={handleRunTextureWorkflow} disabled={!texturingReady || texturing || comfyLoading}>
                          {texturing ? 'Regenerating…' : 'Regenerate zone'}
                        </button>
                      )}
                    </div>

                    <div className="mesh-editor-panel__notes">
                      {texturingUnavailableReason ? (
                        <span className="mesh-editor-panel__hint">{texturingUnavailableReason}</span>
                      ) : (
                        <>
                          <span className="mesh-editor-panel__hint">Paint directly on the mesh view, then run a 2-image ComfyUI inpaint workflow.</span>
                          <span className="mesh-editor-panel__hint">The editor now sends a camera-view mask to AI and reprojects the generated patch back onto the texture.</span>
                          <span className="mesh-editor-panel__hint">The camera stays locked while a paint mask exists. Clear the mask to orbit again.</span>
                        </>
                      )}
                    </div>
                  </>
                ) : activeMenu === 'projection' ? (
                  <>{/* PROJECTION */}
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Projection setup</span>
                      <label className="mesh-editor-range-field">
                        <span>Texture size</span>
                        <input
                          type="range"
                          min="512"
                          max="4096"
                          step="256"
                          value={projectionTextureSize}
                          onChange={event => setProjectionTextureSize(Number(event.target.value))}
                          disabled={projectionStarted || projecting || projectionKeepTexture}
                        />
                        <strong>{projectionTextureSize}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Position view resolution</span>
                        <input
                          type="range"
                          min="512"
                          max="2048"
                          step="128"
                          value={projectionViewResolution}
                          onChange={event => setProjectionViewResolution(Number(event.target.value))}
                          disabled={projecting}
                        />
                        <strong>{projectionViewResolution}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Blend overlap</span>
                        <input
                          type="range"
                          min="0"
                          max="64"
                          step="1"
                          value={projectionBlendPixels}
                          onChange={event => setProjectionBlendPixels(Number(event.target.value))}
                          disabled={!projectionStarted || projecting}
                        />
                        <strong>{projectionBlendPixels}px</strong>
                      </label>

                      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
                        <button
                          type="button"
                          className="mesh-editor-btn mesh-editor-btn--secondary"
                          onClick={handleStartProjectionSession}
                          disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                        >
                          <span className="material-symbols-outlined">refresh</span>
                          <span>{projectionStarted ? 'Restart' : 'Start'}</span>
                        </button>
                        <button
                          type="button"
                          className="mesh-editor-btn mesh-editor-btn--primary"
                          onClick={handleRunProjectionWorkflow}
                          disabled={!projectionReady || !projectionStarted || projecting || comfyLoading || projectionRebuilding}
                        >
                          <span className="material-symbols-outlined">play_arrow</span>
                          <span>{projecting ? 'Projecting…' : 'Project view'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">AI workflow</span>
                      <select
                        className="mesh-editor-panel__input mesh-editor-panel__select"
                        value={projectionWorkflowId}
                        onChange={event => setProjectionWorkflowId(event.target.value)}
                        disabled={comfyLoading || projectionWorkflows.length === 0 || !!texturingUnavailableReason || projecting}
                      >
                        {projectionWorkflows.length === 0 ? (
                          <option value="">No compatible ComfyUI workflow found</option>
                        ) : (
                          projectionWorkflows.map(workflow => (
                            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                          ))
                        )}
                      </select>

                      {selectedProjectionWorkflow && (
                        <div className="mesh-editor-panel__section">
                          <span className="mesh-editor-panel__section-title">Image Inputs Configuration</span>
                          {(selectedProjectionWorkflow.parameters || [])
                            .filter(input => getWorkflowValueType(input) === 'image')
                            .map(param => {
                              const config = projectionImageParamSources[param.id] || { type: 'none' }
                              return (
                                <div key={param.id} className="mesh-editor-workflow-field">
                                  <span>{param.name}</span>
                                  <select
                                    className="mesh-editor-panel__input mesh-editor-panel__select"
                                    value={config.type}
                                    onChange={(e) => handleProjectionImageParamSourceChange(param.id, e.target.value)}
                                    disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                                  >
                                    <option value="none">— Not used —</option>
                                    <option value="position-view">Use as Position View</option>
                                    <option value="textured-view">Use as Textured View</option>
                                    <option value="untextured-view">Use as Untextured View</option>
                                    <option value="asset">From assets</option>
                                    <option value="file">From computer</option>
                                  </select>

                                  {config.type === 'asset' && (
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                                      <span className="mesh-editor-panel__hint" style={{ flex: 1 }}>{config.assetName || 'No asset selected'}</span>
                                      <button
                                        type="button"
                                        className="mesh-editor-btn mesh-editor-btn--ghost"
                                        onClick={() => {
                                          setPendingAssetParamId(param.id)
                                          setPendingAssetSelectorMode('projection')
                                          setShowAssetSelector(true)
                                        }}
                                        disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                                      >
                                        Browse
                                      </button>
                                    </div>
                                  )}

                                  {config.type === 'file' && (
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                                      <span className="mesh-editor-panel__hint" style={{ flex: 1 }}>{config.fileName || 'No file chosen'}</span>
                                      <label className="mesh-editor-btn mesh-editor-btn--ghost" style={{ cursor: 'pointer' }}>
                                        Choose file
                                        <input
                                          type="file"
                                          accept="image/*"
                                          style={{ display: 'none' }}
                                          onChange={(e) => {
                                            const file = e.target.files?.[0]
                                            if (file) {
                                              handleProjectionImageParamSourceChange(param.id, 'file', file)
                                            }
                                          }}
                                          disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                                        />
                                      </label>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                        </div>
                      )}

                      {projectionWorkflowParameters.map(parameter => {
                        const valueType = getWorkflowValueType(parameter)
                        const currentValue = projectionWorkflowInputs?.[parameter.id]

                        return (
                          <label key={parameter.id} className="mesh-editor-workflow-field">
                            <span>{parameter.name}</span>
                            {valueType === 'boolean' ? (
                              <button
                                type="button"
                                className={`mesh-editor-toggle ${currentValue ? 'mesh-editor-toggle--active' : ''}`}
                                onClick={() => setProjectionWorkflowInputs(current => ({
                                  ...current,
                                  [parameter.id]: !currentValue
                                }))}
                                disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                              >
                                {currentValue ? 'Enabled' : 'Disabled'}
                              </button>
                            ) : valueType === 'string' ? (
                              <textarea
                                className="mesh-editor-panel__input mesh-editor-panel__textarea"
                                value={currentValue ?? ''}
                                onChange={event => setProjectionWorkflowInputs(current => ({
                                  ...current,
                                  [parameter.id]: event.target.value
                                }))}
                                disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                              />
                            ) : (
                              <input
                                type="number"
                                className="mesh-editor-panel__input"
                                value={currentValue ?? ''}
                                onChange={event => setProjectionWorkflowInputs(current => ({
                                  ...current,
                                  [parameter.id]: event.target.value === '' ? '' : Number(event.target.value)
                                }))}
                                disabled={!!texturingUnavailableReason || projecting || projectionRebuilding}
                              />
                            )}
                          </label>
                        )
                      })}
                    </div>

                    <div className="mesh-editor-panel__notes">
                      {texturingUnavailableReason ? (
                        <span className="mesh-editor-panel__hint">{texturingUnavailableReason}</span>
                      ) : (
                        <>
                          <span className="mesh-editor-panel__hint">Start clears the working texture to transparent and initializes projection coverage.</span>
                          <span className="mesh-editor-panel__hint">Position View is a square screenshot from the current camera. Projection fills uncovered texels first.</span>
                          <span className="mesh-editor-panel__hint">Blend overlap controls the transition zone at the projected border.</span>
                          <span className="mesh-editor-panel__hint">Crop border trims the alpha silhouette border of each projected view before reprojection.</span>
                          {projectionRebuilding && <span className="mesh-editor-panel__hint">Rebuilding projection stack...</span>}
                        </>
                      )}
                    </div>
                  </>
                ) : activeMenu === 'sculpting' ? (
                  <>{/* SCULPTING */}
                    <SculptToolsPanel
                      brushType={sculptBrush}
                      onBrushTypeChange={setSculptBrush}
                      size={sculptSize}
                      sizeMin={sculptSizeRange.min}
                      sizeMax={sculptSizeRange.max}
                      sizeStep={Math.max(0.0001, sculptSizeRange.max / 1000)}
                      onSizeChange={setSculptSize}
                      strength={sculptStrength}
                      onStrengthChange={setSculptStrength}
                      hardness={sculptHardness}
                      onHardnessChange={setSculptHardness}
                      spacing={sculptSpacing}
                      onSpacingChange={setSculptSpacing}
                      direction={sculptDirection}
                      onDirectionChange={setSculptDirection}
                      frontFacesOnly={sculptFrontFacesOnly}
                      onFrontFacesOnlyChange={setSculptFrontFacesOnly}
                      symmetry={sculptSymmetry}
                      onSymmetryChange={setSculptSymmetry}
                      steadyStroke={sculptSteadyStroke}
                      onSteadyStrokeChange={setSculptSteadyStroke}
                      autoSmooth={sculptAutoSmooth}
                      onAutoSmoothChange={setSculptAutoSmooth}
                      // All seven brushes are now wired up.
                      enabledBrushes={['standard', 'clay', 'inflate', 'smooth', 'flatten', 'pinch', 'grab']}
                      onUndo={handleSculptUndo}
                      canUndo={sculptCanUndo}
                      onRedo={handleSculptRedo}
                      canRedo={sculptCanRedo}
                      stampSource={sculptStampSource}
                      onStampSourceChange={value => {
                        setSculptStampSource(value)
                        if (value === 'none') {
                          setSculptStampAsset(null)
                          setSculptStampFile(null)
                        }
                      }}
                      stampAsset={sculptStampAsset}
                      onPickStampAsset={() => setShowSculptStampSelector(true)}
                      stampFile={sculptStampFile}
                      onStampFileChange={event => {
                        const file = event.target.files?.[0]
                        if (file) {
                          setSculptStampFile(file)
                          setSculptStampAsset(null)
                        }
                        event.target.value = ''
                      }}
                      stampRotation={sculptStampRotation}
                      onStampRotationChange={setSculptStampRotation}
                      stampFileInputRef={sculptStampFileInputRef}
                      disabled={!geometry}
                    />
                  </>
                ) : (
                  <>{/* PAINTING */}
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Brush</span>

                      <div className="mesh-editor-paint-mode-switch" role="radiogroup" aria-label="Paint mode">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={paintMode === 'draw'}
                          className={`mesh-editor-paint-mode-switch__btn ${paintMode === 'draw' ? 'mesh-editor-paint-mode-switch__btn--active' : ''}`}
                          onClick={() => setPaintMode('draw')}
                        >
                          <span className="material-symbols-outlined">brush</span>
                          Drawing
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={paintMode === 'erase'}
                          className={`mesh-editor-paint-mode-switch__btn ${paintMode === 'erase' ? 'mesh-editor-paint-mode-switch__btn--active' : ''}`}
                          disabled={!selectedLayerId}
                          title={selectedLayerId ? 'Erase from the selected layer' : 'Select a layer to enable erasing'}
                          onClick={() => { if (selectedLayerId) setPaintMode('erase') }}
                        >
                          <span className="material-symbols-outlined">ink_eraser</span>
                          Erasing
                        </button>
                      </div>

                      <div className="mesh-editor-workflow-field">
                        <span>Source</span>
                        <select
                          className="mesh-editor-panel__input mesh-editor-panel__select"
                          value={paintBrushSource}
                          onChange={(e) => setPaintBrushSource(e.target.value)}
                        >
                          <option value="asset">From assets</option>
                          <option value="computer">From computer</option>
                        </select>
                      </div>

                      {paintBrushSource === 'asset' ? (
                        <div className="mesh-editor-workflow-field">
                          <button
                            type="button"
                            className="mesh-editor-btn mesh-editor-btn--secondary"
                            onClick={() => setShowBrushSelector(true)}
                          >
                            <span className="material-symbols-outlined">brush</span>
                            {paintBrushAsset ? `Brush: ${paintBrushAsset.name}` : 'Choose brush…'}
                          </button>
                        </div>
                      ) : (
                        <div className="mesh-editor-workflow-field">
                          <input
                            ref={paintBrushFileInputRef}
                            type="file"
                            accept=".png"
                            style={{ display: 'none' }}
                            onChange={handlePaintBrushFileChange}
                          />
                          <button
                            type="button"
                            className="mesh-editor-btn mesh-editor-btn--secondary"
                            onClick={() => paintBrushFileInputRef.current?.click()}
                          >
                            <span className="material-symbols-outlined">upload_file</span>
                            {paintBrushFile ? paintBrushFile.name : 'Upload brush PNG…'}
                          </button>
                        </div>
                      )}

                      <label className="mesh-editor-range-field">
                        <span>Size</span>
                        <input
                          type="range" min="1" max="256" step="1"
                          value={paintBrushSize}
                          onChange={e => setPaintBrushSize(Number(e.target.value))}
                        />
                        <strong>{paintBrushSize}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Opacity</span>
                        <input
                          type="range" min="0" max="1" step="0.01"
                          value={paintOpacity}
                          onChange={e => setPaintOpacity(Number(e.target.value))}
                        />
                        <strong>{Math.round(paintOpacity * 100)}%</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Flow</span>
                        <input
                          type="range" min="0" max="1" step="0.01"
                          value={paintFlow}
                          onChange={e => setPaintFlow(Number(e.target.value))}
                        />
                        <strong>{Math.round(paintFlow * 100)}%</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Hardness</span>
                        <input
                          type="range" min="0" max="1" step="0.01"
                          value={paintHardness}
                          onChange={e => setPaintHardness(Number(e.target.value))}
                        />
                        <strong>{Math.round(paintHardness * 100)}%</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Rotation</span>
                        <input
                          type="range" min="0" max="360" step="1"
                          value={paintRotation}
                          onChange={e => setPaintRotation(Number(e.target.value))}
                        />
                        <strong>{paintRotation}°</strong>
                      </label>

                      <div className="mesh-editor-workflow-field">
                        <span>Blend mode</span>
                        <select
                          className="mesh-editor-panel__input mesh-editor-panel__select"
                          value={paintBlendMode}
                          onChange={e => setPaintBlendMode(e.target.value)}
                        >
                          {PAINT_BLEND_MODES.map(mode => (
                            <option key={mode.value} value={mode.value}>{mode.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="mesh-editor-workflow-field">
                      <span>Color</span>
                      <input
                        type="color"
                        value={paintColor}
                        onChange={e => setPaintColor(e.target.value)}
                      />
                    </div>

                    <div className="mesh-editor-panel__notes">
                      <span className="mesh-editor-panel__hint">Select a brush, then click and drag on the mesh to paint.</span>
                      <span className="mesh-editor-panel__hint">Each stroke creates a new layer in the panel on the right.</span>
                      <span className="mesh-editor-panel__hint">Middle-click drag to orbit while painting.</span>
                    </div>
                    {paintLayers.length > 0 && (
                      <button
                        type="button"
                        className="mesh-editor-btn mesh-editor-btn--ghost"
                        onClick={handleClearAllLayers}
                      >
                        Clear all layers
                      </button>
                    )}
                  </>
                )}
              </div>
            </aside>

            <div
              ref={canvasShellRef}
              className={`mesh-editor-canvas-shell ${(activeMenu === 'texturing' || activeMenu === 'painting' || activeMenu === 'projection') ? 'mesh-editor-canvas-shell--texturing' : ''}`}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerCancel}
              onPointerLeave={() => { setPaintCursorPos(null); setSculptCursor(null); }}
            >
              <canvas
                ref={projectionMaskCanvasRef}
                className={`mesh-editor-projection-mask ${activeMenu === 'texturing' && hasProjectionMask ? 'mesh-editor-projection-mask--active' : ''}`}
              />
              <canvas ref={maskOverlayCanvasRef} className="mesh-editor-mask-overlay" />
              {loading ? (
                <div className="mesh-editor-empty-state">
                  <span className="material-symbols-outlined mesh-editor-empty-state__icon">progress_activity</span>
                  <span>Loading mesh editor...</span>
                </div>
              ) : geometry ? (
                <>
                  <Canvas
                    key={contextRevision}
                    shadows={showShadows ? { type: THREE.PCFSoftShadowMap } : false}
                    resize={{ offsetSize: true }}
                    style={{ width: '100%', height: '100%' }}
                    gl={{ powerPreference: 'high-performance' }}
                    onCreated={({ gl }) => {
                      const canvas = gl.domElement
                      const handleLost = (event) => {
                        event.preventDefault()
                        console.warn('WebGL context lost — awaiting restore.')
                      }
                      const handleRestored = () => {
                        console.warn('WebGL context restored — rebuilding scene.')
                        setContextRevision(rev => rev + 1)
                      }
                      canvas.addEventListener('webglcontextlost', handleLost, false)
                      canvas.addEventListener('webglcontextrestored', handleRestored, false)
                    }}
                  >
                    <PerspectiveCamera makeDefault position={[3, 3, 5]} near={0.0001} far={4000} />
                    <ambientLight intensity={1.25} />
                    <directionalLight
                      position={[5, 7, 9]}
                      intensity={2}
                      castShadow={showShadows}
                      shadow-mapSize-width={2048}
                      shadow-mapSize-height={2048}
                      shadow-bias={-0.00015}
                      shadow-normalBias={0.04}
                      shadow-camera-near={0.5}
                      shadow-camera-far={120}
                    />
                    <directionalLight position={[-5, 3, -4]} intensity={0.6} color="#8ff5ff" />
                    {(activeMenu === 'texturing' || activeMenu === 'painting' || activeMenu === 'projection') && texturableMesh?.root && displayTextureRef.current && (activeMenu !== 'texturing' || maskTextureRef.current) ? (
                      <TexturedMesh
                        key={textureRevision}
                        root={texturableMesh.root}
                        textureKey={texturableMesh.textureKey}
                        displayTexture={displayTextureRef.current}
                        showShadows={showShadows}
                        showAlbedo={showAlbedo}
                      />
                    ) : activeMenu === 'boolean' && booleanHasPreview && booleanMaskTexture ? (
                      <BooleanPreviewMesh
                        geometry={booleanPreviewGeometry || geometry}
                        maskTexture={booleanMaskTexture}
                        maskWidth={booleanBrushMaskRef.current?.width || 1}
                        maskHeight={booleanBrushMaskRef.current?.height || 1}
                        stampMatrix={booleanStampMatrix}
                        operation={booleanOperation}
                        size={booleanStampSize}
                        depth={booleanStampDepth}
                        offset={booleanStampOffset}
                        threshold={24}
                        previewColor={booleanPreviewColor}
                        showShadows={showShadows}
                      />
                    ) : (
                      <EditorMesh
                        geometry={geometry}
                        selectedFaceIndices={activeMenu === 'modeling' ? selectedFaceIndices : []}
                        selectedVertexIndices={activeMenu === 'modeling' ? selectedVertexIndices : []}
                        showShadows={showShadows}
                        showAlbedo={showAlbedo}
                      />
                    )}
                    {activeMenu === 'boolean' && booleanHasPreview && (!booleanMaskTexture || booleanPlaceMode) && (
                      <group renderOrder={30}>
                        <mesh geometry={booleanStampLocalGeometry} matrix={booleanStampMatrix} matrixAutoUpdate={false}>
                          <meshStandardMaterial
                            color={booleanPreviewColor}
                            emissive={booleanPreviewColor}
                            emissiveIntensity={0.12}
                            transparent
                            opacity={0.14}
                            metalness={0.05}
                            roughness={0.45}
                            depthTest
                            depthWrite={false}
                            side={THREE.DoubleSide}
                          />
                        </mesh>
                        <mesh geometry={booleanStampLocalGeometry} matrix={booleanStampMatrix} matrixAutoUpdate={false}>
                          <meshBasicMaterial
                            color="#ffffff"
                            wireframe
                            transparent
                            opacity={0.18}
                            depthTest
                            depthWrite={false}
                          />
                        </mesh>
                      </group>
                    )}
                    <Grid
                      infiniteGrid
                      fadeDistance={60}
                      cellColor="#47484A"
                      sectionColor="#AC89FF"
                      sectionThickness={1.5}
                      sectionSize={10}
                    />
                    <CameraRig
                      geometry={geometry}
                      frameKey={meshFrameKey}
                      onCameraReady={camera => { cameraRef.current = camera }}
                      controlsEnabled={activeMenu !== 'texturing' || !hasProjectionMask}
                      allowPan={activeMenu !== 'projection'}
                      lockToCenter={activeMenu === 'projection'}
                    />
                  </Canvas>
                  {selectionBox && activeMenu === 'modeling' && (
                    <div
                      className="mesh-editor-selection-box"
                      style={{
                        left: Math.min(selectionBox.startPoint.x, selectionBox.endPoint.x),
                        top: Math.min(selectionBox.startPoint.y, selectionBox.endPoint.y),
                        width: Math.max(1, Math.abs(selectionBox.endPoint.x - selectionBox.startPoint.x)),
                        height: Math.max(1, Math.abs(selectionBox.endPoint.y - selectionBox.startPoint.y))
                      }}
                    />
                  )}
                </>
              ) : (
                <div className="mesh-editor-empty-state">
                  <span className="material-symbols-outlined mesh-editor-empty-state__icon">deployed_code_alert</span>
                  <span>Mesh could not be loaded.</span>
                </div>
              )}
              {activeMenu === 'sculpting' && sculptCursor && (
                <div
                  className="mesh-editor-paint-cursor mesh-editor-sculpt-cursor"
                  style={{
                    left: sculptCursor.x,
                    top: sculptCursor.y,
                    width: sculptCursor.pixelRadius * 2,
                    height: sculptCursor.pixelRadius * 2
                  }}
                />
              )}
              {activeMenu === 'painting' && paintCursorPos && (
                <div
                  className="mesh-editor-paint-cursor"
                  style={{
                    left: paintCursorPos.x,
                    top: paintCursorPos.y,
                    width: paintBrushNaturalSize
                      ? (paintBrushNaturalSize.width >= paintBrushNaturalSize.height
                          ? paintBrushSize
                          : paintBrushSize * (paintBrushNaturalSize.width / paintBrushNaturalSize.height))
                      : paintBrushSize,
                    height: paintBrushNaturalSize
                      ? (paintBrushNaturalSize.height >= paintBrushNaturalSize.width
                          ? paintBrushSize
                          : paintBrushSize * (paintBrushNaturalSize.height / paintBrushNaturalSize.width))
                      : paintBrushSize
                  }}
                />
              )}
            </div>

            {activeMenu === 'painting' && (
              <aside className="mesh-editor-layers-panel">
                <div className="mesh-editor-layers-panel__header">
                  <span className="mesh-editor-layers-panel__title">Layers</span>
                  <span className="mesh-editor-panel__hint">{paintLayers.length}</span>
                </div>
                <div className="mesh-editor-layers-panel__list">
                  {paintLayers.length === 0 ? (
                    <div className="mesh-editor-layers-panel__empty">
                      No layers yet — paint on the mesh to create one.
                    </div>
                  ) : (
                    // Render top-most layer first
                    [...paintLayers].slice().reverse().map((layer, reverseIndex) => {
                      const index = paintLayers.length - 1 - reverseIndex
                      const isFirst = index === paintLayers.length - 1
                      const isLast = index === 0
                      return (
                        <div
                          key={layer.id}
                          className={`mesh-editor-layer-card ${selectedLayerId === layer.id ? 'mesh-editor-layer-card--selected' : ''}`}
                          onClick={() => handleSelectLayer(layer.id)}
                        >
                          <div className="mesh-editor-layer-card__header">
                            <input
                              type="radio"
                              className="mesh-editor-layer-card__radio"
                              name="mesh-editor-active-layer"
                              title="Select layer for painting"
                              checked={selectedLayerId === layer.id}
                              onChange={() => setSelectedLayerId(layer.id)}
                              onClick={e => {
                                e.stopPropagation()
                                // Allow toggling off by clicking the active radio.
                                if (selectedLayerId === layer.id) {
                                  e.preventDefault()
                                  setSelectedLayerId(null)
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title={layer.visible ? 'Hide layer' : 'Show layer'}
                              onClick={(e) => { e.stopPropagation(); handleUpdateLayer(layer.id, { visible: !layer.visible }) }}
                            >
                              <span className="material-symbols-outlined">{layer.visible ? 'visibility' : 'visibility_off'}</span>
                            </button>
                            <input
                              className="mesh-editor-layer-card__name"
                              value={layer.name}
                              onChange={e => handleUpdateLayer(layer.id, { name: e.target.value })}
                              onClick={e => e.stopPropagation()}
                            />
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title="Move up"
                              disabled={isFirst}
                              onClick={(e) => { e.stopPropagation(); handleMoveLayer(layer.id, 'up') }}
                            >
                              <span className="material-symbols-outlined">keyboard_arrow_up</span>
                            </button>
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title="Move down"
                              disabled={isLast}
                              onClick={(e) => { e.stopPropagation(); handleMoveLayer(layer.id, 'down') }}
                            >
                              <span className="material-symbols-outlined">keyboard_arrow_down</span>
                            </button>
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title="Delete layer"
                              onClick={(e) => { e.stopPropagation(); handleDeleteLayer(layer.id) }}
                            >
                              <span className="material-symbols-outlined">delete</span>
                            </button>
                          </div>

                          <div className="mesh-editor-layer-card__row">
                            <span>Opacity</span>
                            <input
                              type="range" min="0" max="1" step="0.01"
                              value={layer.opacity}
                              onChange={e => handleUpdateLayer(layer.id, { opacity: Number(e.target.value) })}
                              onClick={e => e.stopPropagation()}
                            />
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Blend</span>
                            <select
                              value={layer.blendMode}
                              onChange={e => handleUpdateLayer(layer.id, { blendMode: e.target.value })}
                              onClick={e => e.stopPropagation()}
                            >
                              {PAINT_BLEND_MODES.map(mode => (
                                <option key={mode.value} value={mode.value}>{mode.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Color</span>
                            <input
                              type="color"
                              className="mesh-editor-layer-card__color"
                              value={layer.color}
                              onChange={e => handleUpdateLayer(layer.id, { color: e.target.value })}
                              onClick={e => e.stopPropagation()}
                            />
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </aside>
            )}

            {activeMenu === 'projection' && (
              <aside className="mesh-editor-layers-panel">
                <div className="mesh-editor-layers-panel__header">
                  <span className="mesh-editor-layers-panel__title">Projections</span>
                  <div className="mesh-editor-layers-panel__header-actions">
                    <span className="mesh-editor-panel__hint">{projectionLayers.length}</span>
                    {modifiedProjectionCount > 0 && (
                      <button
                        type="button"
                        className="mesh-editor-layers-panel__apply-all-btn"
                        disabled={projectionRebuilding}
                        onClick={handleApplyAllProjectionLayers}
                      >
                        Apply all ({modifiedProjectionCount})
                      </button>
                    )}
                  </div>
                </div>
                {projectionRebuilding && (
                  <div className="mesh-editor-rebuild-progress">
                    <div
                      className="mesh-editor-rebuild-progress__bar"
                      style={{ width: `${Math.round(projectionRebuildProgress * 100)}%` }}
                    />
                  </div>
                )}
                <div className="mesh-editor-layers-panel__list">
                  {projectionLayers.length === 0 ? (
                    <div className="mesh-editor-layers-panel__empty">
                      No projections yet — run Projection to add one.
                    </div>
                  ) : (
                    [...projectionLayers].slice().reverse().map((layer, reverseIndex) => {
                      const index = projectionLayers.length - 1 - reverseIndex
                      const isFirst = index === projectionLayers.length - 1
                      const isLast = index === 0
                      const draft = projectionLayerDrafts[layer.id]
                      const draftBlendPixels = draft?.blendPixels ?? layer.blendPixels
                      const draftCropBorder = draft?.cropBorder ?? (layer.cropBorder || 0)
                      const isDirty = draft !== undefined && (
                        draftBlendPixels !== layer.blendPixels ||
                        draftCropBorder !== (layer.cropBorder || 0)
                      )

                      return (
                        <div key={layer.id} className="mesh-editor-layer-card">
                          <div className="mesh-editor-layer-card__header">
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title={layer.visible ? 'Hide projection' : 'Show projection'}
                              onClick={() => handleUpdateProjectionLayer(layer.id, { visible: !layer.visible })}
                            >
                              <span className="material-symbols-outlined">{layer.visible ? 'visibility' : 'visibility_off'}</span>
                            </button>
                            <input
                              className="mesh-editor-layer-card__name"
                              value={layer.name}
                              onChange={e => handleUpdateProjectionLayer(layer.id, { name: e.target.value })}
                            />
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title="Move up"
                              disabled={isFirst || projectionRebuilding}
                              onClick={() => handleMoveProjectionLayer(layer.id, 'up')}
                            >
                              <span className="material-symbols-outlined">keyboard_arrow_up</span>
                            </button>
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title="Move down"
                              disabled={isLast || projectionRebuilding}
                              onClick={() => handleMoveProjectionLayer(layer.id, 'down')}
                            >
                              <span className="material-symbols-outlined">keyboard_arrow_down</span>
                            </button>
                            <button
                              type="button"
                              className="mesh-editor-layer-card__icon-btn"
                              title="Delete projection"
                              disabled={projectionRebuilding}
                              onClick={() => handleDeleteProjectionLayer(layer.id)}
                            >
                              <span className="material-symbols-outlined">delete</span>
                            </button>
                          </div>

                          <div className="mesh-editor-layer-card__row">
                            <span>Blend overlap</span>
                            <input
                              type="range" min="0" max="64" step="1"
                              value={draftBlendPixels}
                              onChange={e => setProjectionLayerDrafts(prev => ({
                                ...prev,
                                [layer.id]: {
                                  blendPixels: Number(e.target.value),
                                  cropBorder: prev[layer.id]?.cropBorder ?? (layer.cropBorder || 0)
                                }
                              }))}
                              disabled={projectionRebuilding}
                            />
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Border blend</span>
                            <strong>{draftBlendPixels}px</strong>
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Crop border</span>
                            <input
                              type="range" min="0" max="64" step="1"
                              value={draftCropBorder}
                              onChange={e => setProjectionLayerDrafts(prev => ({
                                ...prev,
                                [layer.id]: {
                                  cropBorder: Number(e.target.value),
                                  blendPixels: prev[layer.id]?.blendPixels ?? layer.blendPixels
                                }
                              }))}
                              disabled={projectionRebuilding}
                            />
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Crop</span>
                            <strong>{draftCropBorder}px</strong>
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Opacity</span>
                            <input
                              type="range" min="0" max="1" step="0.01"
                              value={layer.opacity ?? 1}
                              onChange={e => handleUpdateProjectionLayer(layer.id, { opacity: Number(e.target.value) })}
                              disabled={projectionRebuilding}
                            />
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Alpha</span>
                            <strong>{Math.round((layer.opacity ?? 1) * 100)}%</strong>
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Opacity seams</span>
                            <input
                              type="range" min="0" max="1" step="0.01"
                              value={layer.opacitySeams ?? 1}
                              onChange={e => handleUpdateProjectionLayer(layer.id, { opacitySeams: Number(e.target.value) })}
                              disabled={projectionRebuilding}
                            />
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Seams</span>
                            <strong>{Math.round((layer.opacitySeams ?? 1) * 100)}%</strong>
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Blend</span>
                            <select
                              value={layer.blendMode || 'source-over'}
                              onChange={e => handleUpdateProjectionLayer(layer.id, { blendMode: e.target.value })}
                              disabled={projectionRebuilding}
                            >
                              {PAINT_BLEND_MODES.map(mode => (
                                <option key={mode.value} value={mode.value}>{mode.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="mesh-editor-layer-card__row">
                            <span>Capture</span>
                            <strong>{layer.sendResolution}px</strong>
                          </div>
                          {isDirty && (
                            <div className="mesh-editor-layer-card__dirty-note">Modified</div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>

                {projectionLayers.length > 0 && (
                  <div className="post-proc-panel">
                    <div className="post-proc-panel__title">Post Processing</div>

                    {/* ── Fill Holes ── */}
                    <label className="post-proc-panel__section-toggle">
                      <input
                        type="checkbox"
                        checked={postProcFillHolesEnabled}
                        onChange={e => setPostProcFillHolesEnabled(e.target.checked)}
                      />
                      Fill Holes
                    </label>
                    {postProcFillHolesEnabled && (
                      <div className="post-proc-panel__row">
                        <label>Smoothness</label>
                        <input
                          type="range" min="1" max="32" step="1"
                          value={postProcFillHolesBlur}
                          onChange={e => setPostProcFillHolesBlur(Number(e.target.value))}
                        />
                        <span>{postProcFillHolesBlur}</span>
                      </div>
                    )}

                    {/* ── Seam Smoothing ── */}
                    <label className="post-proc-panel__section-toggle">
                      <input
                        type="checkbox"
                        checked={postProcSeamEnabled}
                        onChange={e => setPostProcSeamEnabled(e.target.checked)}
                      />
                      Seam Smoothing
                    </label>
                    {postProcSeamEnabled && (
                      <>
                        <div className="post-proc-panel__row">
                          <label>Seam width</label>
                          <input
                            type="range" min="0.05" max="1.0" step="0.01"
                            value={postProcSeamThreshold}
                            onChange={e => setPostProcSeamThreshold(Number(e.target.value))}
                          />
                          <span>{postProcSeamThreshold.toFixed(2)}</span>
                        </div>
                        <div className="post-proc-panel__row">
                          <label>Blur radius</label>
                          <input
                            type="range" min="1" max="32" step="1"
                            value={postProcBlurRadius}
                            onChange={e => setPostProcBlurRadius(Number(e.target.value))}
                          />
                          <span>{postProcBlurRadius}px</span>
                        </div>
                        <div className="post-proc-panel__row">
                          <label>Strength</label>
                          <input
                            type="range" min="0.0" max="1.0" step="0.01"
                            value={postProcStrength}
                            onChange={e => setPostProcStrength(Number(e.target.value))}
                          />
                          <span>{Math.round(postProcStrength * 100)}%</span>
                        </div>
                      </>
                    )}

                    <div className="post-proc-panel__actions">
                      <button
                        type="button"
                        className="post-proc-panel__apply-btn"
                        onClick={handleApplyPostProcessing}
                        disabled={projectionRebuilding || (!postProcSeamEnabled && !postProcFillHolesEnabled)}
                      >
                        {postProcApplied ? 'Re-apply' : 'Apply'}
                      </button>
                      {postProcApplied && (
                        <button
                          type="button"
                          className="post-proc-panel__reset-btn"
                          onClick={handleResetPostProcessing}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </aside>
            )}
          </div>
        </section>
      </main>
      {showBrushSelector && (
        <AssetSelectorModal
          assetType="brush"
          onSelect={(asset) => {
            setPaintBrushAsset(asset);
            setPaintBrushFile(null);
            setShowBrushSelector(false);
          }}
          onClose={() => setShowBrushSelector(false)}
        />
      )}
      {showBooleanBrushSelector && (
        <AssetSelectorModal
          assetType="brush"
          onSelect={(asset) => {
            setBooleanBrushAsset(asset)
            setBooleanBrushFile(null)
            setShowBooleanBrushSelector(false)
          }}
          onClose={() => setShowBooleanBrushSelector(false)}
        />
      )}
      {showSculptStampSelector && (
        <AssetSelectorModal
          assetType="brush"
          onSelect={(asset) => {
            setSculptStampAsset(asset);
            setSculptStampFile(null);
            setShowSculptStampSelector(false);
          }}
          onClose={() => setShowSculptStampSelector(false)}
        />
      )}
      {showAssetSelector && (
        <AssetSelectorModal
          assetType="image"
          onSelect={(asset) => {
            if (pendingAssetParamId) {
              if (pendingAssetSelectorMode === 'projection') {
                handleProjectionImageParamSourceChange(pendingAssetParamId, 'asset', asset)
              } else {
                handleImageParamSourceChange(pendingAssetParamId, 'asset', asset)
              }
            }
            setShowAssetSelector(false);
            setPendingAssetParamId(null);
            setPendingAssetSelectorMode('texturing')
          }}
          onClose={() => {
            setShowAssetSelector(false);
            setPendingAssetParamId(null);
            setPendingAssetSelectorMode('texturing')
          }}
          showEdits
        />
      )}
      <Footer />
    </div>
  )
}
