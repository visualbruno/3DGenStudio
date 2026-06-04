// meshBooleanGeometry.js
// Pure helpers extracted from src/pages/MeshEditorPage.jsx (behaviour-preserving move).
// No React, no component state.

import * as THREE from 'three'
import { subdivideSelectedFaces } from './meshEditor'

export function getRectangleBounds(startPoint, endPoint) {
  return {
    left: Math.min(startPoint.x, endPoint.x),
    right: Math.max(startPoint.x, endPoint.x),
    top: Math.min(startPoint.y, endPoint.y),
    bottom: Math.max(startPoint.y, endPoint.y)
  }
}

export function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load the generated texture result.'))
    image.src = url
  })
}

export function createBooleanBrushMaskFromImage(image, maxResolution = 96) {
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

export function buildBooleanStampGeometry(mask, size = 0.2, depth = 0.06, threshold = 24) {
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

export function computeBooleanStampBasis(intersection, camera) {
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

export function buildBooleanStampMatrix(basis, rotationDeg = 0, offset = 0, nudgeX = 0, nudgeY = 0) {
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

export function sampleBooleanMaskAlpha(mask, u, v) {
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

export function deformGeometryWithBooleanStamp(baseGeometry, mask, stampMatrix, {
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

export function collectBooleanDeformationFaceIndices(baseGeometry, mask, stampMatrix, {
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

export function tessellateBooleanDeformationRegion(baseGeometry, mask, stampMatrix, {
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
