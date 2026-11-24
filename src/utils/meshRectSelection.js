import * as THREE from 'three'

// Rectangle (marquee) selection for the Modeling tool.
//
// The old implementation fired a sparse grid of rays (<= 1600, >= 6 px apart)
// through the rectangle and kept whatever face each ray hit. On a dense mesh
// most triangles are smaller than the ray spacing, so roughly half the faces
// inside the rectangle were never hit — a speckled, incomplete selection.
//
// This renders a face-ID pass instead: every triangle is drawn in a unique
// colour (faceIndex + 1, packed into RGB) into an offscreen target that covers
// ONLY the rectangle (camera.setViewOffset), supersampled, then the pixels are
// read back. Every face with at least one visible pixel inside the rectangle
// is selected; occluded faces lose the depth test, exactly like the viewport.

const MAX_PICK_PIXELS = 8 * 1024 * 1024
const MIN_SUPERSAMPLE = 3

const PICK_VERTEX_SHADER = /* glsl */`
attribute vec3 faceColor;
varying vec3 vFaceColor;
void main() {
  vFaceColor = faceColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const PICK_FRAGMENT_SHADER = /* glsl */`
varying vec3 vFaceColor;
void main() {
  gl_FragColor = vec4(vFaceColor, 1.0);
}
`

// One cached pick geometry at a time: the editor only ever has one working
// geometry, and holding a de-indexed copy per historical geometry would leak.
let cachedPick = null

function getFaceCount(geometry) {
  return geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor(geometry.attributes.position.count / 3)
}

function getPickGeometry(geometry) {
  const position = geometry.attributes.position
  const index = geometry.index
  const faceCount = getFaceCount(geometry)

  if (
    cachedPick &&
    cachedPick.source === geometry &&
    cachedPick.positionVersion === position.version &&
    cachedPick.indexVersion === (index ? index.version : -1) &&
    cachedPick.faceCount === faceCount
  ) {
    return cachedPick.geometry
  }

  cachedPick?.geometry.dispose()

  const positions = new Float32Array(faceCount * 9)
  const colors = new Uint8Array(faceCount * 9)
  const indexArray = index ? index.array : null

  for (let face = 0; face < faceCount; face += 1) {
    const id = face + 1
    const r = id & 0xff
    const g = (id >> 8) & 0xff
    const b = (id >> 16) & 0xff

    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indexArray ? indexArray[face * 3 + corner] : face * 3 + corner
      const offset = face * 9 + corner * 3
      positions[offset] = position.getX(vertex)
      positions[offset + 1] = position.getY(vertex)
      positions[offset + 2] = position.getZ(vertex)
      colors[offset] = r
      colors[offset + 1] = g
      colors[offset + 2] = b
    }
  }

  const pickGeometry = new THREE.BufferGeometry()
  pickGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  pickGeometry.setAttribute('faceColor', new THREE.BufferAttribute(colors, 3, true))

  cachedPick = {
    source: geometry,
    positionVersion: position.version,
    indexVersion: index ? index.version : -1,
    faceCount,
    geometry: pickGeometry
  }

  return pickGeometry
}

let pickMaterial = null
function getPickMaterial() {
  if (!pickMaterial) {
    pickMaterial = new THREE.ShaderMaterial({
      vertexShader: PICK_VERTEX_SHADER,
      fragmentShader: PICK_FRAGMENT_SHADER,
      // The viewport material is FrontSide, and so is the click raycast.
      side: THREE.FrontSide,
      toneMapped: false
    })
  }
  return pickMaterial
}

/**
 * Render the face-ID pass for a screen rectangle.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Camera} camera
 * @param {THREE.BufferGeometry} geometry  editor geometry (identity transform)
 * @param {{left:number, top:number, right:number, bottom:number}} bounds  CSS px, relative to the canvas
 * @param {{width:number, height:number}} viewSize  canvas size in CSS px
 * @returns {null | { faceMask: Uint8Array, ids: Uint32Array, width: number, height: number, bounds: object }}
 */
function renderFaceIdPass(renderer, camera, geometry, bounds, viewSize) {
  const left = Math.max(0, Math.floor(bounds.left))
  const top = Math.max(0, Math.floor(bounds.top))
  const right = Math.min(viewSize.width, Math.ceil(bounds.right))
  const bottom = Math.min(viewSize.height, Math.ceil(bounds.bottom))
  const rectWidth = right - left
  const rectHeight = bottom - top
  if (rectWidth < 1 || rectHeight < 1) {
    return null
  }

  const maxTextureSize = renderer.capabilities?.maxTextureSize || 4096
  let scale = Math.max(MIN_SUPERSAMPLE, renderer.getPixelRatio?.() || 1)
  scale = Math.min(scale, Math.sqrt(MAX_PICK_PIXELS / (rectWidth * rectHeight)))
  scale = Math.min(scale, maxTextureSize / rectWidth, maxTextureSize / rectHeight)
  const width = Math.max(1, Math.round(rectWidth * scale))
  const height = Math.max(1, Math.round(rectHeight * scale))

  const pickGeometry = getPickGeometry(geometry)
  const pickMesh = new THREE.Mesh(pickGeometry, getPickMaterial())
  pickMesh.frustumCulled = false
  const pickScene = new THREE.Scene()
  pickScene.add(pickMesh)

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true
  })

  const previousTarget = renderer.getRenderTarget()
  const previousClearColor = renderer.getClearColor(new THREE.Color())
  const previousClearAlpha = renderer.getClearAlpha()
  const previousAutoClear = renderer.autoClear
  const previousView = camera.view && camera.view.enabled ? { ...camera.view } : null
  const pixels = new Uint8Array(width * height * 4)

  try {
    // Render only the rectangle, at full resolution, without touching the
    // camera's framing: setViewOffset crops the projection to the sub-window.
    camera.setViewOffset(viewSize.width, viewSize.height, left, top, rectWidth, rectHeight)

    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.autoClear = true
    renderer.clear(true, true, false)
    renderer.render(pickScene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  } finally {
    if (previousView) {
      camera.setViewOffset(
        previousView.fullWidth, previousView.fullHeight,
        previousView.offsetX, previousView.offsetY,
        previousView.width, previousView.height
      )
    } else {
      camera.clearViewOffset()
    }
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClearColor, previousClearAlpha)
    renderer.autoClear = previousAutoClear
    target.dispose()
    pickScene.remove(pickMesh)
  }

  const faceCount = getFaceCount(geometry)
  const faceMask = new Uint8Array(faceCount)
  // ids[] is stored top-row-first (readPixels returns bottom-row-first) and
  // holds faceIndex + 1, 0 = background.
  const ids = new Uint32Array(width * height)
  let previousId = 0

  for (let row = 0; row < height; row += 1) {
    const sourceRow = (height - 1 - row) * width * 4
    const destRow = row * width
    for (let column = 0; column < width; column += 1) {
      const offset = sourceRow + column * 4
      const id = pixels[offset] | (pixels[offset + 1] << 8) | (pixels[offset + 2] << 16)
      ids[destRow + column] = id
      if (id !== 0 && id !== previousId && id <= faceCount) {
        faceMask[id - 1] = 1
      }
      previousId = id
    }
  }

  return {
    faceMask,
    ids,
    width,
    height,
    bounds: { left, top, right, bottom, width: rectWidth, height: rectHeight }
  }
}

function maskToSortedIndices(mask) {
  const result = []
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) result.push(index)
  }
  return result
}

/**
 * Faces with at least one visible (unoccluded, front-facing) pixel inside the
 * rectangle. Returns null when the GPU pass cannot run, so callers can fall back.
 */
export function pickVisibleFacesInRect({ renderer, camera, geometry, bounds, viewSize }) {
  if (!renderer || !camera || !geometry?.attributes?.position) return null
  const pass = renderFaceIdPass(renderer, camera, geometry, bounds, viewSize)
  if (!pass) return []
  return maskToSortedIndices(pass.faceMask)
}

/**
 * Vertices that project inside the rectangle AND are visible: a vertex counts
 * as visible when the ID buffer around its projected position shows one of the
 * faces that use it (so a vertex hidden behind other geometry is skipped even
 * if part of an adjacent face is visible).
 */
export function pickVisibleVerticesInRect({ renderer, camera, geometry, bounds, viewSize }) {
  if (!renderer || !camera || !geometry?.attributes?.position) return null
  const pass = renderFaceIdPass(renderer, camera, geometry, bounds, viewSize)
  if (!pass) return []

  const { faceMask, ids, width, height } = pass
  const rect = pass.bounds
  const position = geometry.attributes.position
  const indexArray = geometry.index ? geometry.index.array : null
  const scaleX = width / rect.width
  const scaleY = height / rect.height
  const radius = Math.max(1, Math.ceil(Math.max(scaleX, scaleY)))
  const vertexState = new Uint8Array(position.count) // 0 untested, 1 accepted, 2 rejected
  const projected = new THREE.Vector3()

  camera.updateMatrixWorld()

  const faceUsesVertex = (faceIndex, vertex) => {
    if (indexArray) {
      const base = faceIndex * 3
      return indexArray[base] === vertex || indexArray[base + 1] === vertex || indexArray[base + 2] === vertex
    }
    return Math.floor(vertex / 3) === faceIndex
  }

  for (let face = 0; face < faceMask.length; face += 1) {
    if (!faceMask[face]) continue

    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indexArray ? indexArray[face * 3 + corner] : face * 3 + corner
      if (vertexState[vertex]) continue
      vertexState[vertex] = 2

      projected.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).project(camera)
      if (projected.z < -1 || projected.z > 1) continue
      const screenX = (projected.x + 1) * 0.5 * viewSize.width
      const screenY = (1 - projected.y) * 0.5 * viewSize.height
      if (screenX < bounds.left || screenX > bounds.right || screenY < bounds.top || screenY > bounds.bottom) continue

      const pixelX = Math.floor((screenX - rect.left) * scaleX)
      const pixelY = Math.floor((screenY - rect.top) * scaleY)
      let visible = false

      for (let dy = -radius; dy <= radius && !visible; dy += 1) {
        const y = pixelY + dy
        if (y < 0 || y >= height) continue
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = pixelX + dx
          if (x < 0 || x >= width) continue
          const id = ids[y * width + x]
          if (id !== 0 && faceUsesVertex(id - 1, vertex)) {
            visible = true
            break
          }
        }
      }

      if (visible) vertexState[vertex] = 1
    }
  }

  const result = []
  for (let vertex = 0; vertex < vertexState.length; vertex += 1) {
    if (vertexState[vertex] === 1) result.push(vertex)
  }
  return result
}
