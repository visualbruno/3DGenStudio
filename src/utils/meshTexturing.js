import * as THREE from 'three'
import { assetUrl } from '../config'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

if (THREE.BufferGeometry.prototype.computeBoundsTree !== computeBoundsTree) {
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
}

if (THREE.BufferGeometry.prototype.disposeBoundsTree !== disposeBoundsTree) {
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
}

if (THREE.Mesh.prototype.raycast !== acceleratedRaycast) {
  THREE.Mesh.prototype.raycast = acceleratedRaycast
}

const PROJECTED_PATCH_ROW_BATCH = 16
const PROJECTED_PATCH_PROGRESS_INTERVAL_MS = 125
const DEPTH_PREPASS_EPSILON = 0.003

let sharedDepthPrepassRenderer = null
let sharedDepthPrepassTarget = null
let sharedDepthPrepassMaterial = null
let sharedDepthPrepassPixels = null

let sharedProjectionRenderer = null
let sharedMaskProjectionRenderer = null

// A persistent offscreen WebGLRenderer can silently lose its GPU context
// (driver reset, tab backgrounding, or the browser evicting the oldest WebGL
// context once too many exist — e.g. after a ComfyUI crash followed by retries).
// Three.js does NOT auto-recreate it, so a dead renderer keeps producing BLANK
// frames: the projection capture turns black and the GPU bake writes nothing,
// until a full page reload. Treat a lost context as "needs rebuild".
function isRendererContextLost(renderer) {
  if (!renderer) return false
  try {
    return renderer.getContext().isContextLost()
  } catch {
    return true
  }
}

function getSharedProjectionRenderer() {
  if (isRendererContextLost(sharedProjectionRenderer)) {
    sharedProjectionRenderer.dispose?.()
    sharedProjectionRenderer = null
  }
  if (!sharedProjectionRenderer) {
    sharedProjectionRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    })
    sharedProjectionRenderer.setPixelRatio(1)
  }
  return sharedProjectionRenderer
}

function getSharedMaskProjectionRenderer() {
  if (isRendererContextLost(sharedMaskProjectionRenderer)) {
    sharedMaskProjectionRenderer.dispose?.()
    sharedMaskProjectionRenderer = null
  }
  if (!sharedMaskProjectionRenderer) {
    sharedMaskProjectionRenderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    })
    sharedMaskProjectionRenderer.setPixelRatio(1)
  }
  return sharedMaskProjectionRenderer
}

function getDepthPrepassResources(width, height) {
  const safeWidth = Math.max(1, Math.round(width || 1))
  const safeHeight = Math.max(1, Math.round(height || 1))

  if (isRendererContextLost(sharedDepthPrepassRenderer)) {
    sharedDepthPrepassRenderer.dispose?.()
    sharedDepthPrepassRenderer = null
    // The render target's framebuffer belongs to the dead context — drop it so
    // it is rebuilt against the fresh renderer below.
    sharedDepthPrepassTarget?.dispose?.()
    sharedDepthPrepassTarget = null
  }

  if (!sharedDepthPrepassRenderer) {
    sharedDepthPrepassRenderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    })
    sharedDepthPrepassRenderer.setPixelRatio(1)
  }

  if (!sharedDepthPrepassTarget || sharedDepthPrepassTarget.width !== safeWidth || sharedDepthPrepassTarget.height !== safeHeight) {
    sharedDepthPrepassTarget?.dispose?.()
    sharedDepthPrepassTarget = new THREE.WebGLRenderTarget(safeWidth, safeHeight, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false
    })
  }

  if (!sharedDepthPrepassMaterial) {
    sharedDepthPrepassMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.FrontSide,
      blending: THREE.NoBlending
    })
  }

  const requiredBytes = safeWidth * safeHeight * 4
  if (!sharedDepthPrepassPixels || sharedDepthPrepassPixels.length !== requiredBytes) {
    sharedDepthPrepassPixels = new Uint8Array(requiredBytes)
  }

  sharedDepthPrepassRenderer.setSize(safeWidth, safeHeight, false)

  return {
    width: safeWidth,
    height: safeHeight,
    renderer: sharedDepthPrepassRenderer,
    target: sharedDepthPrepassTarget,
    material: sharedDepthPrepassMaterial,
    pixels: sharedDepthPrepassPixels
  }
}

function unpackRgbDepth(r, g, b, a) {
  const rf = r / 255
  const gf = g / 255
  const bf = b / 255
  const af = a / 255
  // Matches three.js unpackRGBAToDepth (no extra 255/256 scaling).
  return rf / (256 * 256 * 256) + gf / (256 * 256) + bf / 256 + af
}

function samplePackedDepth(depthPrepass, screenX, screenY) {
  if (!depthPrepass?.pixels || !depthPrepass.width || !depthPrepass.height) {
    return NaN
  }

  const x = Math.max(0, Math.min(depthPrepass.width - 1, Math.floor(screenX)))
  const yTop = Math.max(0, Math.min(depthPrepass.height - 1, Math.floor(screenY)))
  const y = depthPrepass.height - 1 - yTop
  const idx = (y * depthPrepass.width + x) * 4
  const pixels = depthPrepass.pixels
  return unpackRgbDepth(pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3])
}

// Two-pass chamfer distance transform: for every pixel inside `mask` (value > 0)
// returns the approximate distance (cost units: 10 per ortho step, 14 per diag)
// to the nearest pixel outside the mask. Pixels outside the mask are 0.
// Used to measure how far a covered screen pixel sits from the projection's
// screen-space silhouette / occlusion border.
function computeScreenDistanceInsideMask(mask, width, height) {
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

// Fills 1px pinholes / stitches anti-aliased edge fragments in a binary screen
// coverage mask so depth/raycast speckle does not create false pinhole seams.
function stitchScreenCoverageMask(mask, width, height) {
  const pixelCount = width * height
  if (!mask || mask.length !== pixelCount) {
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
      const ortho = has(x - 1, y) + has(x + 1, y) + has(x, y - 1) + has(x, y + 1)
      const diag = has(x - 1, y - 1) + has(x + 1, y - 1) + has(x - 1, y + 1) + has(x + 1, y + 1)
      if (ortho >= 3 || (ortho >= 2 && diag >= 2)) {
        next[i] = 1
      }
    }
  }

  return next
}

function captureDepthPrepass({ meshes, camera, width, height }) {
  if (!Array.isArray(meshes) || meshes.length === 0 || !camera || !width || !height) {
    return null
  }

  try {
    const resources = getDepthPrepassResources(width, height)
    const scene = new THREE.Scene()

    meshes.forEach(mesh => {
      if (!mesh?.geometry) {
        return
      }

      const depthMesh = new THREE.Mesh(mesh.geometry, resources.material)
      depthMesh.matrixWorld.copy(mesh.matrixWorld)
      depthMesh.matrixAutoUpdate = false
      depthMesh.frustumCulled = false
      scene.add(depthMesh)
    })

    camera.updateMatrixWorld?.(true)
    resources.renderer.setRenderTarget(resources.target)
    resources.renderer.setClearColor(0x000000, 1)
    resources.renderer.clear(true, true, true)
    resources.renderer.render(scene, camera)
    resources.renderer.readRenderTargetPixels(resources.target, 0, 0, resources.width, resources.height, resources.pixels)
    resources.renderer.setRenderTarget(null)

    return {
      width: resources.width,
      height: resources.height,
      pixels: resources.pixels
    }
  } catch {
    return null
  }
}

function getExtensionFromUrl(url = '') {
  const sanitizedUrl = String(url).split('?')[0].toLowerCase()
  const match = sanitizedUrl.match(/\.[^.]+$/)
  return match?.[0] || ''
}

function loadWithLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject)
  })
}

function getTextureKey(texture) {
  if (!texture) {
    return ''
  }

  return String(
    texture.source?.uuid
    || texture.uuid
    || texture.image?.currentSrc
    || texture.image?.src
    || texture.name
    || ''
  )
}

function getMaterialList(material) {
  if (Array.isArray(material)) {
    return material
  }

  return material ? [material] : []
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function getObjectMaterialList(object) {
  if (Array.isArray(object?.material)) {
    return object.material
  }

  return object?.material ? [object.material] : []
}

function applyWrapMode(value, wrapMode) {
  if (wrapMode === THREE.RepeatWrapping) {
    return value - Math.floor(value)
  }

  if (wrapMode === THREE.MirroredRepeatWrapping) {
    if (Math.abs(Math.floor(value) % 2) === 1) {
      return Math.ceil(value) - value
    }

    return value - Math.floor(value)
  }

  return THREE.MathUtils.clamp(value, 0, 1)
}

function transformUvToTextureSpace(uv, textureConfig = null) {
  const nextUv = uv.clone()

  if (!textureConfig) {
    return nextUv
  }

  const matrix = new THREE.Matrix3().setUvTransform(
    textureConfig.offset?.x || 0,
    textureConfig.offset?.y || 0,
    textureConfig.repeat?.x || 1,
    textureConfig.repeat?.y || 1,
    textureConfig.rotation || 0,
    textureConfig.center?.x || 0,
    textureConfig.center?.y || 0
  )

  nextUv.applyMatrix3(matrix)
  nextUv.x = applyWrapMode(nextUv.x, textureConfig.wrapS)
  nextUv.y = applyWrapMode(nextUv.y, textureConfig.wrapT)

  if (textureConfig.flipY) {
    nextUv.y = 1 - nextUv.y
  }

  return nextUv
}

export function mapUvToCanvasPoint(uv, textureWidth, textureHeight, textureConfig = null) {
  const textureUv = transformUvToTextureSpace(uv, textureConfig)

  return {
    x: textureUv.x * textureWidth,
    y: textureUv.y * textureHeight
  }
}

function getGeometryFaceCount(geometry) {
  if (!geometry?.attributes?.position) {
    return 0
  }

  return geometry.index
    ? geometry.index.count / 3
    : geometry.attributes.position.count / 3
}

function getFaceVertexIndices(geometry, faceIndex) {
  if (geometry.index) {
    const indexArray = geometry.index.array
    const offset = faceIndex * 3
    return [indexArray[offset], indexArray[offset + 1], indexArray[offset + 2]]
  }

  const offset = faceIndex * 3
  return [offset, offset + 1, offset + 2]
}

function createEdgeKey(leftIndex, rightIndex) {
  return leftIndex < rightIndex
    ? `${leftIndex}:${rightIndex}`
    : `${rightIndex}:${leftIndex}`
}

function buildUvPaintTarget(geometry, textureWidth, textureHeight, textureConfig = null) {
  if (!geometry?.attributes?.uv?.count) {
    return null
  }

  const uvArray = geometry.attributes.uv.array
  const faceCount = getGeometryFaceCount(geometry)
  const faceAdjacency = Array.from({ length: faceCount }, () => new Set())
  const edgeToFaces = new Map()

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const vertices = getFaceVertexIndices(geometry, faceIndex)
    const edges = [
      createEdgeKey(vertices[0], vertices[1]),
      createEdgeKey(vertices[1], vertices[2]),
      createEdgeKey(vertices[2], vertices[0])
    ]

    edges.forEach(edgeKey => {
      if (!edgeToFaces.has(edgeKey)) {
        edgeToFaces.set(edgeKey, [])
      }

      edgeToFaces.get(edgeKey).push(faceIndex)
    })
  }

  edgeToFaces.forEach(faces => {
    if (faces.length < 2) {
      return
    }

    for (let index = 0; index < faces.length; index += 1) {
      for (let neighborIndex = index + 1; neighborIndex < faces.length; neighborIndex += 1) {
        faceAdjacency[faces[index]].add(faces[neighborIndex])
        faceAdjacency[faces[neighborIndex]].add(faces[index])
      }
    }
  })

  const faceIslandIndices = new Array(faceCount).fill(-1)
  const islandFacesList = []
  let islandIndex = 0

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    if (faceIslandIndices[faceIndex] !== -1) {
      continue
    }

    const queue = [faceIndex]
    const islandFaces = []
    faceIslandIndices[faceIndex] = islandIndex

    while (queue.length > 0) {
      const currentFaceIndex = queue.pop()
      islandFaces.push(currentFaceIndex)

      faceAdjacency[currentFaceIndex].forEach(neighborFaceIndex => {
        if (faceIslandIndices[neighborFaceIndex] !== -1) {
          return
        }

        faceIslandIndices[neighborFaceIndex] = islandIndex
        queue.push(neighborFaceIndex)
      })
    }

    islandFacesList.push(islandFaces)
    islandIndex += 1
  }

  return {
    faceIslandIndices,
    islandFacesList,
    uvArray,
    textureWidth,
    textureHeight,
    textureConfig,
    geometry,
    islandPaths: [] // Will be lazy-loaded
  }
}

function drawImageSourceToCanvas(source) {
  const width = source?.naturalWidth || source?.videoWidth || source?.displayWidth || source?.width || 0
  const height = source?.naturalHeight || source?.videoHeight || source?.displayHeight || source?.height || 0

  if (!width || !height) {
    throw new Error('The mesh texture could not be read.')
  }

  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(source, 0, 0, width, height)
  return canvas
}

function getOrBuildIslandPath(paintTarget, islandIndex) {
  if (!paintTarget) {
    return null
  }

  // Check if already built
  if (paintTarget.islandPaths[islandIndex]) {
    return paintTarget.islandPaths[islandIndex]
  }

  // Build the path lazily
  const islandFaces = paintTarget.islandFacesList?.[islandIndex]
  if (!islandFaces) {
    return null
  }

  const { uvArray, textureWidth, textureHeight, textureConfig, geometry } = paintTarget
  const islandPath = new Path2D()

  islandFaces.forEach(currentFaceIndex => {
    const vertices = getFaceVertexIndices(geometry, currentFaceIndex)
    let [a, b, c] = vertices.map(vertexIndex => mapUvToCanvasPoint(
      new THREE.Vector2(uvArray[vertexIndex * 2], uvArray[vertexIndex * 2 + 1]),
      textureWidth,
      textureHeight,
      textureConfig
    ))

    // Skip degenerate triangles whose mapped coordinates aren't finite. A single
    // NaN/Infinity in a Path2D poisons the WHOLE path, so isPointInPath/clip then
    // misbehave for every point. Faces referencing vertices with missing/invalid
    // UVs are the usual source.
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) ||
        !Number.isFinite(b.x) || !Number.isFinite(b.y) ||
        !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return
    }

    // Normalize every triangle to a consistent (CCW) winding before adding it.
    // Meshes with mirrored UVs (e.g. symmetric characters) pack left/right faces
    // onto the same UV area with OPPOSITE winding; under Canvas's default nonzero
    // fill rule those overlapping triangles cancel out, collapsing the island's
    // clip region to (near) empty. That made the clip erase every brush stamp —
    // i.e. painting silently did nothing on such meshes.
    const signedArea = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
    if (signedArea < 0) {
      const swap = b
      b = c
      c = swap
    }

    islandPath.moveTo(a.x, a.y)
    islandPath.lineTo(b.x, b.y)
    islandPath.lineTo(c.x, c.y)
    islandPath.closePath()
  })

  paintTarget.islandPaths[islandIndex] = islandPath
  return islandPath
}

export async function loadMeshRootFromUrl(url) {
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  const extension = getExtensionFromUrl(url)

  if (extension === '.glb' || extension === '.gltf') {
    const root = (await loadWithLoader(new GLTFLoader(), url))?.scene || null
    return root
  }

  if (extension === '.obj') {
    const root = await loadWithLoader(new OBJLoader(), url)
    return root
  }

  if (extension === '.fbx') {
    const root = await loadWithLoader(new FBXLoader(), url)
    return root
  }

  if (extension === '.stl') {
    const geometry = await loadWithLoader(new STLLoader(), url)
    const root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#cfd8ff' }))
    return root
  }

  if (extension === '.ply') {
    const geometry = await loadWithLoader(new PLYLoader(), url)
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals()
    }

    const root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#cfd8ff' }))
    return root
  }

  throw new Error('Unsupported mesh format')
}

export async function loadTexturableMeshFromUrl(url) {
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  const root = await loadMeshRootFromUrl(url)

  return loadTexturableMeshFromRoot(root, { url, startedAt })
}

export async function loadTexturableMeshFromRoot(root, { url = '', startedAt: explicitStartedAt = null } = {}) {
  const startedAt = explicitStartedAt ?? (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

  if (!root) {
    throw new Error('No mesh data found')
  }

  root.updateMatrixWorld(true)

  const texturedMaterials = []
  let hasUvs = false

  root.traverse(child => {
    if (!child.isMesh) {
      return
    }

    if (child.geometry?.attributes?.uv?.count) {
      hasUvs = true
    }

    getMaterialList(child.material).forEach(material => {
      if (material?.map?.image) {
        texturedMaterials.push({ child, material, texture: material.map })
      }
    })
  })

  if (!hasUvs) {
    return {
      root,
      textureCanvas: null,
      textureKey: '',
      textureConfig: null,
      supportError: 'This mesh has no UVs, so texture painting is unavailable.'
    }
  }

  if (texturedMaterials.length === 0) {
    return {
      root,
      textureCanvas: null,
      textureKey: '',
      textureConfig: null,
      supportError: 'This mesh has no texture map to edit.'
    }
  }

  const firstTexture = texturedMaterials[0].texture
  const textureKey = getTextureKey(firstTexture)
  const uniqueTextureKeys = new Set(texturedMaterials.map(entry => getTextureKey(entry.texture)).filter(Boolean))
  const textureCanvas = drawImageSourceToCanvas(firstTexture.image)
  const textureConfig = {
    wrapS: firstTexture.wrapS,
    wrapT: firstTexture.wrapT,
    repeat: firstTexture.repeat.clone(),
    offset: firstTexture.offset.clone(),
    center: firstTexture.center.clone(),
    rotation: firstTexture.rotation,
    flipY: firstTexture.flipY,
    colorSpace: firstTexture.colorSpace,
    minFilter: firstTexture.minFilter,
    magFilter: firstTexture.magFilter
  }

  if (uniqueTextureKeys.size > 1) {
    return {
      root,
      textureCanvas: null,
      textureKey,
      textureConfig: null,
      supportError: 'Texture painting currently supports meshes that use a single shared texture map.'
    }
  }

  const paintTargetsByMeshUuid = {}
  texturedMaterials.forEach(({ child, texture }) => {
    if (!child?.uuid || getTextureKey(texture) !== textureKey) {
      return
    }

    const paintTarget = buildUvPaintTarget(child.geometry, textureCanvas.width, textureCanvas.height, textureConfig)
    if (paintTarget) {
      paintTargetsByMeshUuid[child.uuid] = paintTarget
    }
  })

  return {
    root,
    textureCanvas,
    textureKey,
    paintTargetsByMeshUuid,
    textureConfig,
    supportError: ''
  }
}

export function createCanvasTexture(sourceCanvas, textureConfig = null) {
  const texture = new THREE.CanvasTexture(sourceCanvas)
  texture.needsUpdate = true

  if (textureConfig) {
    texture.wrapS = textureConfig.wrapS
    texture.wrapT = textureConfig.wrapT
    texture.repeat.copy(textureConfig.repeat)
    texture.offset.copy(textureConfig.offset)
    texture.center.copy(textureConfig.center)
    texture.rotation = textureConfig.rotation
    texture.flipY = textureConfig.flipY
    texture.colorSpace = textureConfig.colorSpace
    texture.minFilter = textureConfig.minFilter
    texture.magFilter = textureConfig.magFilter
  }

  return texture
}

function exportObjectToGlb(object) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter()

    exporter.parse(
      object,
      result => {
        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('Failed to export the mesh as a binary GLB file.'))
          return
        }

        resolve(result)
      },
      error => {
        reject(error instanceof Error ? error : new Error('Failed to export the mesh as GLB.'))
      },
      {
        binary: true,
        onlyVisible: false
      }
    )
  })
}

// Build a cloned, fully-textured THREE.Object3D ready to feed to any exporter.
// Returns the object plus the transient materials/texture it created so the
// caller can dispose them once the export has been serialized.
export function buildTexturedMeshObject({ root, textureKey, textureCanvas, textureConfig = null }) {
  if (!root || !textureCanvas) {
    throw new Error('A textured mesh is required to build a textured export object.')
  }

  const object = root.clone(true)
  const materials = []
  const exportTexture = createCanvasTexture(textureCanvas, textureConfig)
  exportTexture.name = 'MeshEditorTexture'

  object.traverse(child => {
    if (!child.isMesh) {
      return
    }

    if (Array.isArray(child.material)) {
      child.material = child.material.map(material => {
        const nextMaterial = material?.clone?.() || material

        if (nextMaterial && getTextureKeyFromMaterial(material) === textureKey) {
          nextMaterial.map = exportTexture
          nextMaterial.needsUpdate = true
        }

        if (nextMaterial) {
          materials.push(nextMaterial)
        }

        return nextMaterial
      })
      return
    }

    const nextMaterial = child.material?.clone?.() || child.material

    if (nextMaterial && getTextureKeyFromMaterial(child.material) === textureKey) {
      nextMaterial.map = exportTexture
      nextMaterial.needsUpdate = true
    }

    child.material = nextMaterial

    if (nextMaterial) {
      materials.push(nextMaterial)
    }
  })

  return { object, materials, exportTexture }
}

export async function exportTexturedMeshToGlb(args) {
  const { object, materials, exportTexture } = buildTexturedMeshObject(args)

  try {
    return await exportObjectToGlb(object)
  } finally {
    materials.forEach(material => material?.dispose?.())
    exportTexture.dispose()
  }
}

export function updateCanvasTexture(texture) {
  if (!texture) {
    return
  }

  texture.needsUpdate = true
}

export function drawUvStroke(maskCanvas, fromUv, toUv, radius, islandPath = null, textureConfig = null) {
  if (!maskCanvas || !fromUv || !toUv) {
    return
  }

  const context = maskCanvas.getContext('2d', { willReadFrequently: true }) || maskCanvas.getContext('2d')
  const startPoint = mapUvToCanvasPoint(fromUv, maskCanvas.width, maskCanvas.height, textureConfig)
  const endPoint = mapUvToCanvasPoint(toUv, maskCanvas.width, maskCanvas.height, textureConfig)

  context.save()
  if (islandPath) {
    context.clip(islandPath)
  }
  context.fillStyle = '#ffffff'
  context.strokeStyle = '#ffffff'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(1, radius * 2)
  context.beginPath()
  context.moveTo(startPoint.x, startPoint.y)
  context.lineTo(endPoint.x, endPoint.y)
  context.stroke()
  context.beginPath()
  context.arc(endPoint.x, endPoint.y, Math.max(1, radius), 0, Math.PI * 2)
  context.fill()
  context.restore()
}

export function drawCanvasStroke(maskCanvas, fromPoint, toPoint, radius) {
  if (!maskCanvas || !fromPoint || !toPoint) {
    return
  }

  const context = maskCanvas.getContext('2d')

  context.save()
  context.fillStyle = '#ffffff'
  context.strokeStyle = '#ffffff'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(1, radius * 2)
  context.beginPath()
  context.moveTo(fromPoint.x, fromPoint.y)
  context.lineTo(toPoint.x, toPoint.y)
  context.stroke()
  context.beginPath()
  context.arc(toPoint.x, toPoint.y, Math.max(1, radius), 0, Math.PI * 2)
  context.fill()
  context.restore()
}

export function clearCanvas(canvas) {
  if (!canvas) {
    return
  }

  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
}

export function getMaskBoundingBox(maskCanvas, padding = 0) {
  if (!maskCanvas) {
    return null
  }

  const context = maskCanvas.getContext('2d')
  const { width, height } = maskCanvas
  const { data } = context.getImageData(0, 0, width, height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha <= 0) {
        continue
      }

      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) {
    return null
  }

  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(width - Math.max(0, minX - padding), maxX - minX + 1 + padding * 2),
    height: Math.min(height - Math.max(0, minY - padding), maxY - minY + 1 + padding * 2)
  }
}

export function cropCanvas(sourceCanvas, bbox) {
  const canvas = createCanvas(bbox.width, bbox.height)
  const context = canvas.getContext('2d')
  context.drawImage(
    sourceCanvas,
    bbox.x,
    bbox.y,
    bbox.width,
    bbox.height,
    0,
    0,
    bbox.width,
    bbox.height
  )
  return canvas
}

export function featherMask(maskCanvas, radius) {
  if (!maskCanvas) {
    return null
  }

  if (!radius || radius <= 0) {
    const copy = createCanvas(maskCanvas.width, maskCanvas.height)
    copy.getContext('2d').drawImage(maskCanvas, 0, 0)
    return copy
  }

  const blurred = createCanvas(maskCanvas.width, maskCanvas.height)
  const context = blurred.getContext('2d')
  context.filter = `blur(${radius}px)`
  context.drawImage(maskCanvas, 0, 0)
  context.filter = 'none'
  return blurred
}

export function compositeTexturePatch(baseCanvas, patchImage, bbox, maskCanvas, featherRadius = 12) {
  const baseContext = baseCanvas.getContext('2d')
  const featheredMask = featherMask(maskCanvas, featherRadius)
  const maskPatchCanvas = cropCanvas(featheredMask, bbox)
  const patchCanvas = createCanvas(bbox.width, bbox.height)
  const patchContext = patchCanvas.getContext('2d')

  patchContext.drawImage(patchImage, 0, 0, bbox.width, bbox.height)
  patchContext.globalCompositeOperation = 'destination-in'
  patchContext.drawImage(maskPatchCanvas, 0, 0)
  patchContext.globalCompositeOperation = 'source-over'

  baseContext.drawImage(patchCanvas, bbox.x, bbox.y)
}

function createTexturedRenderClone(root, textureKey, displayTexture) {
  if (!root) {
    return { object: null, dispose: () => {} }
  }

  const object = root.clone(true)
  const materials = []

  object.traverse(child => {
    if (!child.isMesh) {
      return
    }

    child.castShadow = false
    child.receiveShadow = false

    // Use MeshBasicMaterial (unlit) so the captured image contains raw texture
    // albedo colors rather than lit/shaded colors. This prevents double-lighting:
    // the projected result is stored as albedo, and Three.js applies its own
    // lighting pipeline on display.
    if (Array.isArray(child.material)) {
      child.material = child.material.map(material => {
        const usesThisTexture = getTextureKeyFromMaterial(material) === textureKey
        const nextMaterial = new THREE.MeshBasicMaterial({
          map: usesThisTexture ? displayTexture : (material?.map ?? null),
          side: material?.side ?? THREE.FrontSide,
          transparent: material?.transparent ?? false,
          alphaTest: material?.alphaTest ?? 0
        })
        materials.push(nextMaterial)
        return nextMaterial
      })
      return
    }

    const usesThisTexture = getTextureKeyFromMaterial(child.material) === textureKey
    const nextMaterial = new THREE.MeshBasicMaterial({
      map: usesThisTexture ? displayTexture : (child.material?.map ?? null),
      side: child.material?.side ?? THREE.FrontSide,
      transparent: child.material?.transparent ?? false,
      alphaTest: child.material?.alphaTest ?? 0
    })
    child.material = nextMaterial
    materials.push(nextMaterial)
  })

  return {
    object,
    dispose: () => {
      materials.forEach(material => material?.dispose?.())
    }
  }
}

function createLitGeometryRenderClone(root) {
  if (!root) {
    return { object: null, dispose: () => {} }
  }

  const object = root.clone(true)
  const materials = []

  object.traverse(child => {
    if (!child.isMesh) {
      return
    }

    child.castShadow = false
    child.receiveShadow = false

    const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material]
    const nextMaterials = sourceMaterials.map(sourceMaterial => {
      const material = new THREE.MeshStandardMaterial({
        color: sourceMaterial?.color?.clone?.() || new THREE.Color('#cfd6df'),
        roughness: 0.78,
        metalness: 0.04,
        side: sourceMaterial?.side ?? THREE.FrontSide,
        transparent: false,
        opacity: 1,
        flatShading: false
      })
      materials.push(material)
      return material
    })

    child.material = Array.isArray(child.material) ? nextMaterials : nextMaterials[0]
  })

  return {
    object,
    dispose: () => {
      materials.forEach(material => material?.dispose?.())
    }
  }
}

function createProjectionRenderCamera(camera, aspect) {
  if (!camera?.clone) {
    return null
  }

  const nextCamera = camera.clone()

  if ('aspect' in nextCamera && Number.isFinite(aspect) && aspect > 0) {
    nextCamera.aspect = aspect
  }

  nextCamera.updateProjectionMatrix?.()
  nextCamera.updateMatrixWorld?.(true)
  return nextCamera
}

function createProjectionScene(renderObject) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#0b0d12')

  if (!renderObject) {
    return scene
  }

  const bounds = new THREE.Box3().setFromObject(renderObject)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())
  const lightDistance = Math.max(size.length() || 1, 2)

  const ambientLight = new THREE.AmbientLight('#ffffff', 1.25)
  const keyLight = new THREE.DirectionalLight('#ffffff', 2)
  keyLight.position.copy(center).add(new THREE.Vector3(lightDistance, lightDistance * 1.3, lightDistance))

  const fillLight = new THREE.DirectionalLight('#8ff5ff', 0.6)
  fillLight.position.copy(center).add(new THREE.Vector3(-lightDistance, lightDistance * 0.4, -lightDistance * 0.75))

  scene.add(ambientLight)
  scene.add(keyLight)
  scene.add(fillLight)
  scene.add(renderObject)

  return scene
}

export function captureTexturedMeshView({
  root,
  textureKey,
  displayTexture,
  camera,
  width,
  height,
  targetContext,
  renderMode = 'textured'
}) {
  if (!root || !displayTexture || !camera || !width || !height) {
    throw new Error('The mesh projection view could not be rendered.')
  }

  // If a target context is provided, use ITS physical dimensions for high-res rendering
  const renderWidth = targetContext?.canvas?.width || width
  const renderHeight = targetContext?.canvas?.height || height

  const projectionCamera = createProjectionRenderCamera(camera, renderWidth / renderHeight)
  const { object, dispose } = renderMode === 'lit-geometry'
    ? createLitGeometryRenderClone(root)
    : createTexturedRenderClone(root, textureKey, displayTexture)
  const scene = createProjectionScene(object)
  const renderer = getSharedProjectionRenderer()

  try {
    // Render Three.js natively at the high-res dimensions
    renderer.setSize(renderWidth, renderHeight, false)
    renderer.outputColorSpace = displayTexture.colorSpace || THREE.SRGBColorSpace
    // No tone mapping: the materials are MeshBasicMaterial (unlit) so the output
    // is the raw texture albedo. ComfyUI will inpaint those albedo colors and the
    // result will be stored back as albedo — preventing double-lighting when
    // Three.js applies its own lighting + ACESFilmic tone mapping on display.
    renderer.toneMapping = THREE.NoToneMapping
    renderer.render(scene, projectionCamera)

    // Draw 1:1 mapping (no stretching, perfect pixel quality)
    const context = targetContext || createCanvas(width, height).getContext('2d')
    context.drawImage(renderer.domElement, 0, 0, renderWidth, renderHeight)

    return context.canvas
  } finally {
    dispose()
  }
}

function objectUsesTextureKey(object, textureKey) {
  if (!textureKey) {
    return true
  }

  return getObjectMaterialList(object).some(material => getTextureKeyFromMaterial(material) === textureKey)
}

function ensureRaycastAcceleration(root, textureKey) {
  const meshes = []

  root?.traverse(child => {
    if (!child?.isMesh || !child.geometry || !objectUsesTextureKey(child, textureKey)) {
      return
    }

    if (!child.geometry.boundsTree && typeof child.geometry.computeBoundsTree === 'function') {
      child.geometry.computeBoundsTree()
    }

    meshes.push(child)
  })

  return meshes
}

function countActiveProjectionPixels(maskData) {
  let activePixelCount = 0

  for (let index = 3; index < maskData.length; index += 4) {
    if (maskData[index] > 2) {
      activePixelCount += 1
    }
  }

  return activePixelCount
}

export function estimateMaskOrbitTarget({ root, textureKey = '', maskCanvas, camera, maxSamples = 900 }) {
  if (!root || !maskCanvas || !camera) {
    return null
  }

  const context = maskCanvas.getContext('2d')
  const { width, height } = maskCanvas

  if (!context || !width || !height) {
    return null
  }

  const { data } = context.getImageData(0, 0, width, height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3]

      if (alpha <= 0) {
        continue
      }

      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) {
    return null
  }

  const sampledMeshes = ensureRaycastAcceleration(root, textureKey)
  if (sampledMeshes.length === 0) {
    return new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3())
  }

  const raycaster = new THREE.Raycaster()
  raycaster.firstHitOnly = true
  const pointer = new THREE.Vector2()
  const accumulatedTarget = new THREE.Vector3()
  let totalWeight = 0
  const bboxWidth = maxX - minX + 1
  const bboxHeight = maxY - minY + 1
  const step = Math.max(2, Math.ceil(Math.sqrt((bboxWidth * bboxHeight) / maxSamples)))

  camera.updateMatrixWorld?.(true)
  root.updateMatrixWorld?.(true)

  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const alpha = data[(y * width + x) * 4 + 3] / 255

      if (alpha <= 0.01) {
        continue
      }

      pointer.set(
        (x / width) * 2 - 1,
        -((y / height) * 2 - 1)
      )

      raycaster.setFromCamera(pointer, camera)
      const [intersection] = raycaster.intersectObjects(sampledMeshes, false)

      if (!intersection?.point) {
        continue
      }

      accumulatedTarget.addScaledVector(intersection.point, alpha)
      totalWeight += alpha
    }
  }

  if (totalWeight > 0) {
    return accumulatedTarget.multiplyScalar(1 / totalWeight)
  }

  return new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3())
}

function waitForNextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }

    setTimeout(resolve, 0)
  })
}

function estimatePatchMatteColor(patchData, maskData, width, height) {
  if (!patchData || !maskData || !width || !height) {
    return { r: 0, g: 0, b: 0 }
  }

  let sumR = 0
  let sumG = 0
  let sumB = 0
  let count = 0

  const sample = (x, y) => {
    const i = y * width + x
    const idx = i * 4
    const maskA = maskData[idx + 3] / 255

    // Prefer near-outside pixels for matte estimation.
    if (maskA > 0.08) {
      return
    }

    sumR += patchData[idx]
    sumG += patchData[idx + 1]
    sumB += patchData[idx + 2]
    count += 1
  }

  for (let x = 0; x < width; x += 1) {
    sample(x, 0)
    if (height > 1) {
      sample(x, height - 1)
    }
  }

  for (let y = 1; y + 1 < height; y += 1) {
    sample(0, y)
    if (width > 1) {
      sample(width - 1, y)
    }
  }

  if (count <= 0) {
    return { r: 0, g: 0, b: 0 }
  }

  return {
    r: sumR / count,
    g: sumG / count,
    b: sumB / count
  }
}

function buildCoverageBlendWeights(coverageMap, textureWidth, textureHeight, blendPixels = 0) {
  const pixelCount = textureWidth * textureHeight
  if (!coverageMap || coverageMap.length !== pixelCount) {
    return null
  }

  const weights = new Float32Array(pixelCount)
  const radius = Math.max(0, Number(blendPixels) || 0)

  if (radius <= 0) {
    for (let i = 0; i < pixelCount; i += 1) {
      weights[i] = coverageMap[i] > 0 ? 0 : 1
    }
    return weights
  }

  // Approximate Euclidean distance transform (chamfer metric) from uncovered
  // texels. This keeps overlap blending linear-time even on large textures.
  const INF = 1 << 29
  const ORTHO = 10
  const DIAG = 14
  const dist = new Int32Array(pixelCount)
  let hasUncovered = false

  for (let i = 0; i < pixelCount; i += 1) {
    if (coverageMap[i] > 0) {
      dist[i] = INF
    } else {
      dist[i] = 0
      hasUncovered = true
    }
  }

  if (!hasUncovered) {
    return weights
  }

  for (let y = 0; y < textureHeight; y += 1) {
    for (let x = 0; x < textureWidth; x += 1) {
      const i = y * textureWidth + x
      let best = dist[i]
      if (x > 0) best = Math.min(best, dist[i - 1] + ORTHO)
      if (y > 0) best = Math.min(best, dist[i - textureWidth] + ORTHO)
      if (x > 0 && y > 0) best = Math.min(best, dist[i - textureWidth - 1] + DIAG)
      if (x + 1 < textureWidth && y > 0) best = Math.min(best, dist[i - textureWidth + 1] + DIAG)
      dist[i] = best
    }
  }

  for (let y = textureHeight - 1; y >= 0; y -= 1) {
    for (let x = textureWidth - 1; x >= 0; x -= 1) {
      const i = y * textureWidth + x
      let best = dist[i]
      if (x + 1 < textureWidth) best = Math.min(best, dist[i + 1] + ORTHO)
      if (y + 1 < textureHeight) best = Math.min(best, dist[i + textureWidth] + ORTHO)
      if (x > 0 && y + 1 < textureHeight) best = Math.min(best, dist[i + textureWidth - 1] + DIAG)
      if (x + 1 < textureWidth && y + 1 < textureHeight) best = Math.min(best, dist[i + textureWidth + 1] + DIAG)
      dist[i] = best
    }
  }

  const radiusCost = Math.max(1, Math.round(radius * ORTHO))
  const denom = radiusCost + 1
  for (let i = 0; i < pixelCount; i += 1) {
    if (coverageMap[i] <= 0) {
      weights[i] = 1
      continue
    }

    const d = dist[i]
    if (d > radiusCost) {
      weights[i] = 0
      continue
    }

    const t = Math.max(0, Math.min(1, 1 - d / denom))
    // Ease overlap falloff to reduce noisy transitions between projections.
    weights[i] = t * t * (3 - 2 * t)
  }

  return weights
}

export async function applyProjectedTexturePatch(params) {
  const { textureCanvas } = params
  const W = textureCanvas.width, H = textureCanvas.height
  const accumulatedColor  = new Float32Array(W * H * 4)
  const accumulatedWeight = new Float32Array(W * H)

  const stats = await accumulateProjectedPatch({
    ...params,
    accumulatedColor,
    accumulatedWeight,
    textureWidth: W,
    textureHeight: H
  })

  finalizeProjectedPatch({ textureCanvas, accumulatedColor, accumulatedWeight })
  return stats
}

export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Failed to encode canvas image.'))
        return
      }

      resolve(blob)
    }, type, quality)
  })
}

export async function canvasToFile(canvas, fileName, type = 'image/png', quality = 0.92) {
  const blob = await canvasToBlob(canvas, type, quality)
  return new File([blob], fileName, { type })
}

export function buildAssetUrl(asset) {
  const rawPath = asset?.url || asset?.filename || asset?.filePath || ''
  if (!rawPath) {
    return ''
  }

  if (rawPath.startsWith('http://') || rawPath.startsWith('https://') || rawPath.startsWith('data:') || rawPath.startsWith('blob:')) {
    return rawPath
  }

  const normalizedPath = String(rawPath)
    .replace(/\\/g, '/')
    .replace(/^data\/assets\//, '')
    .replace(/^assets\//, '')

  return assetUrl(normalizedPath)
}

export function createTexturePaintWorkflowDraft(workflow) {
  return Object.fromEntries((workflow?.parameters || []).map(parameter => {
    const valueType = parameter?.valueType || (parameter?.type === 'boolean' ? 'boolean' : parameter?.type === 'number' ? 'number' : 'string')

    if (valueType === 'image') {
      return [parameter.id, null]
    }

    if (valueType === 'boolean') {
      return [parameter.id, Boolean(parameter.defaultValue ?? false)]
    }

    return [parameter.id, parameter.defaultValue ?? '']
  }))
}

export function getWorkflowValueType(parameter) {
  if (parameter?.valueType) {
    return parameter.valueType
  }

  if (parameter?.type === 'boolean') {
    return 'boolean'
  }

  if (parameter?.type === 'number') {
    return 'number'
  }

  return 'string'
}

export function getDefaultTextureWorkflowParameterIds(workflow) {
  const imageParameters = (workflow?.parameters || []).filter(parameter => getWorkflowValueType(parameter) === 'image')
  const maskParameter = imageParameters.find(parameter => /mask/i.test(parameter.name || '') || /mask/i.test(parameter.label || '')) || imageParameters[1] || null
  const sourceParameter = imageParameters.find(parameter => parameter.id !== maskParameter?.id) || imageParameters[0] || null

  return {
    sourceParameterId: sourceParameter?.id || '',
    maskParameterId: maskParameter?.id || ''
  }
}

export function createExecutionId(prefix = 'mesh-texture') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}`
}

export function getTextureKeyFromMaterial(material) {
  return getTextureKey(material?.map)
}

export function getUvIslandHitInfo(texturableMesh, intersection) {
  const meshUuid = intersection?.object?.uuid
  const faceIndex = Number(intersection?.faceIndex)

  if (!meshUuid || !Number.isInteger(faceIndex) || faceIndex < 0) {
    return null
  }

  const paintTarget = texturableMesh?.paintTargetsByMeshUuid?.[meshUuid]
  if (!paintTarget) {
    return null
  }

  const islandIndex = paintTarget.faceIslandIndices?.[faceIndex]
  if (!Number.isInteger(islandIndex) || islandIndex < 0) {
    return null
  }

  return {
    key: `${meshUuid}:${islandIndex}`,
    path: getOrBuildIslandPath(paintTarget, islandIndex) || null
  }
}

// ─── Multi-view accumulation helpers ────────────────────────────────────────

/**
 * Renders the mesh from a given camera using the UV mask canvas as an unlit
 * texture. The Z-buffer handles occlusion automatically, so the returned
 * canvas is a correct screen-space mask for that viewpoint without any
 * raycasting.
 */
export function captureTextureMaskScreenView({
  root,
  textureKey,
  maskCanvas,
  textureConfig,
  camera,
  width,
  height,
  ignoreOcclusion = false
}) {
  if (!root || !maskCanvas || !camera || !width || !height) {
    throw new Error('The mesh mask projection view could not be rendered.')
  }

  const maskTexture = createCanvasTexture(maskCanvas, textureConfig)
  const object = root.clone(true)
  const materials = []

  object.traverse(child => {
    if (!child.isMesh) {
      return
    }

    const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material]
    const hasMaskedMaterial = sourceMaterials.some(
      material => getTextureKeyFromMaterial(material) === textureKey
    )

    if (!hasMaskedMaterial) {
      return
    }

    const mat = new THREE.MeshBasicMaterial({
      map: maskTexture,
      transparent: true,
      alphaTest: 0.01,
      side: ignoreOcclusion ? THREE.DoubleSide : THREE.FrontSide,
      depthTest: !ignoreOcclusion,
      depthWrite: false
    })

    child.material = mat
    materials.push(mat)
  })

  const scene = new THREE.Scene()
  scene.background = null
  scene.add(object)

  const projectionCamera = createProjectionRenderCamera(camera, width / height)
  const renderer = getSharedMaskProjectionRenderer()

  try {
    renderer.setSize(width, height, false)
    renderer.setClearColor(0x000000, 0)
    renderer.render(scene, projectionCamera)

    const canvas = createCanvas(width, height)
    canvas.getContext('2d').drawImage(renderer.domElement, 0, 0, width, height)
    return canvas
  } finally {
    materials.forEach(mat => mat.dispose())
    maskTexture.dispose()
  }
}

/**
 * Builds N additional cameras by orbiting around orbitTarget at fixed azimuth
 * increments (alternating ±30°, ±60°, …) while preserving the original
 * elevation and distance.
 *
 * Returns [sourceCamera, ...additionalCameras].
 */
export function generateOrbitalCameras(sourceCamera, orbitTarget, additionalCount, azimuthStepDeg = 30) {
  const cameras = [sourceCamera]

  if (!additionalCount || additionalCount <= 0 || !sourceCamera || !orbitTarget) {
    return cameras
  }

  const offset = sourceCamera.position.clone().sub(orbitTarget)
  const dist = offset.length()

  if (dist < 0.0001) {
    return cameras
  }

  const theta0 = Math.atan2(offset.x, offset.z)
  const phi0 = Math.acos(THREE.MathUtils.clamp(offset.y / dist, -1, 1))
  const stepRad = (azimuthStepDeg * Math.PI) / 180

  for (let i = 1; i <= additionalCount; i += 1) {
    const sign = i % 2 === 1 ? 1 : -1
    const multiplier = Math.ceil(i / 2)
    const theta = theta0 + sign * multiplier * stepRad

    const nextPos = new THREE.Vector3(
      orbitTarget.x + dist * Math.sin(phi0) * Math.sin(theta),
      orbitTarget.y + dist * Math.cos(phi0),
      orbitTarget.z + dist * Math.sin(phi0) * Math.cos(theta)
    )

    const cam = sourceCamera.clone()
    cam.position.copy(nextPos)
    cam.lookAt(orbitTarget)
    cam.updateProjectionMatrix?.()
    cam.updateMatrixWorld?.(true)
    cameras.push(cam)
  }

  return cameras
}

/**
 * Like applyProjectedTexturePatch but writes into caller-owned accumulation
 * buffers instead of creating its own, and does NOT call putImageData.
 * Call finalizeProjectedPatch once after all views have been accumulated.
 */
export async function accumulateProjectedPatch({
  root,
  textureKey,
  textureConfig,
  camera,
  maskCanvas,
  bbox,
  patchImage,
  featherRadius = 12,
  viewOpacity = 1,
  accumulatedColor,
  accumulatedWeight,
  textureWidth,
  textureHeight,
  onProgress = null,
  binaryMask = false,
  coverageMap = null,
  blendPixels = 0,
  markCoverage = false,
  grazingCoverageThreshold = 0.15,
  minFacingCos = 0,
  facingPower = 1.5,
  minMaskAlpha = 0.01,
  unmatteFringe = false,
  unmatteStrength = 1,
  layerId = '',
  faceOwnershipMap = null,
  faceLockPolicy = 'none',
  faceLockCoverageThreshold = 0.7,
  faceLockFacingThreshold = 0.45,
  occlusionMode = 'auto', // Step 1 (analysis): depth-prepass by default; was 'raycast'
  cullBackfaces = true
}) {
  if (!root || !camera || !maskCanvas || !bbox || !patchImage || !accumulatedColor || !accumulatedWeight) {
    return { processedSamples: 0, appliedSamples: 0, activePixelCount: 0 }
  }

  const startedAt = performance.now()
  const maskPatchCanvas = featherMask(cropCanvas(maskCanvas, bbox), featherRadius)
	
	if (binaryMask) {
		const ctx = maskPatchCanvas.getContext('2d')
		const imgData = ctx.getImageData(0, 0, bbox.width, bbox.height)
		const d = imgData.data
		const w = bbox.width, h = bbox.height
		
		// Step 1: binarise
		for (let i = 3; i < d.length; i += 4) {
			d[i] = d[i] > 0 ? 255 : 0
		}
		
		// Step 2: dilate by 1 pixel (fills any 1-pixel gaps)
		const copy = new Uint8ClampedArray(d)
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const idx = (y * w + x) * 4
				if (copy[idx + 3] > 0) continue
				// Check 4-connectivity neighbours
				const hasFilledNeighbour =
					(x > 0 && copy[((y * w + (x-1)) * 4) + 3] > 0) ||
					(x < w-1 && copy[((y * w + (x+1)) * 4) + 3] > 0) ||
					(y > 0 && copy[(((y-1) * w + x) * 4) + 3] > 0) ||
					(y < h-1 && copy[(((y+1) * w + x) * 4) + 3] > 0)
				if (hasFilledNeighbour) {
					d[idx + 3] = 255
				}
			}
		}
		ctx.putImageData(imgData, 0, 0)
	}
	
  const patchCanvas = createCanvas(bbox.width, bbox.height)
  const patchContext = patchCanvas.getContext('2d')
  patchContext.drawImage(patchImage, 0, 0, bbox.width, bbox.height)

  const { data: patchData } = patchContext.getImageData(0, 0, bbox.width, bbox.height)
  const { data: maskData } = maskPatchCanvas.getContext('2d').getImageData(0, 0, bbox.width, bbox.height)
  const matteColor = unmatteFringe
    ? estimatePatchMatteColor(patchData, maskData, bbox.width, bbox.height)
    : null
  const clampedUnmatteStrength = Math.max(0, Math.min(1, Number(unmatteStrength) || 0))
  const clampedMinMaskAlpha = Math.max(0, Math.min(1, Number(minMaskAlpha) || 0))

  const activePixelCount = countActiveProjectionPixels(maskData)
  const coverageWeights = buildCoverageBlendWeights(coverageMap, textureWidth, textureHeight, blendPixels)
  const touchedCoverage = markCoverage && coverageMap && coverageMap.length === textureWidth * textureHeight
    ? new Uint8Array(textureWidth * textureHeight)
    : null
  const touchedCoverageIndices = touchedCoverage ? [] : null

  // Screen-space coverage of accepted (non-grazing) samples, in bbox-local
  // resolution (the same space as localX/localY below). Its silhouette is the
  // projection's croppable view-space border (outer outline + self-occlusion
  // holes), independent of the UV layout. `texelScreenIdx` maps each covered
  // texel back to its screen pixel so the border distance can be looked up per
  // texel after the bake.
  const screenSeamWidth = bbox.width
  const screenSeamHeight = bbox.height
  const screenCoverage = new Uint8Array(screenSeamWidth * screenSeamHeight)
  const texelScreenIdx = new Int32Array(textureWidth * textureHeight).fill(-1)

  camera.updateMatrixWorld?.(true)
  root.updateMatrixWorld?.(true)
  const projectableMeshes = ensureRaycastAcceleration(root, textureKey)
  const hasDeformingMeshes = projectableMeshes.some(mesh => (
    Boolean(mesh?.isSkinnedMesh)
    || (Array.isArray(mesh?.morphTargetInfluences) && mesh.morphTargetInfluences.length > 0)
  ))

  const requestedOcclusionMode = String(occlusionMode || 'auto').toLowerCase()
  const allowDepthPrepassOcclusion = (requestedOcclusionMode === 'auto' || requestedOcclusionMode === 'depth-prepass')
    && !hasDeformingMeshes
  const depthPrepass = allowDepthPrepassOcclusion
    ? captureDepthPrepass({
      meshes: projectableMeshes,
      camera,
      width: maskCanvas.width,
      height: maskCanvas.height
    })
    : null
  const useDepthPrepassOcclusion = Boolean(depthPrepass)
  const useRaycastOcclusion = !useDepthPrepassOcclusion
    && (requestedOcclusionMode === 'auto' || requestedOcclusionMode === 'raycast' || requestedOcclusionMode === 'depth-prepass')
  const useNoOcclusion = !useDepthPrepassOcclusion && !useRaycastOcclusion

  const raycaster = useRaycastOcclusion ? new THREE.Raycaster() : null
  if (raycaster) {
    raycaster.firstHitOnly = true
  }
  const pointer = useRaycastOcclusion ? new THREE.Vector2() : null

  if (activePixelCount === 0 || projectableMeshes.length === 0) {
    return {
      durationMs: performance.now() - startedAt,
      activePixelCount,
      processedSamples: 0,
      appliedSamples: 0,
      viewSeamMask: new Uint8Array(textureWidth * textureHeight)
    }
  }

  let processedSamples = 0
  let appliedSamples = 0
  let lockedFaces = 0
  let lastProgressAt = startedAt

  {
    // ─── Backward mapping ────────────────────────────────────────────────
    // Iterate every UV texel inside each triangle's UV bbox, derive its 3D
    // position via barycentrics, project to screen, sample the patch. This
    // guarantees no gaps regardless of camera distance.
    // For binaryMask we do nearest-neighbour stamping; otherwise we
    // bilinearly sample patch+mask and accumulate with weight.
    const clampedViewOpacity = Math.max(0, Math.min(1, viewOpacity))
    const camWorldPos = camera.getWorldPosition(new THREE.Vector3())
    const sceneSize = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).length() || 1
    const occlusionEps = Math.max(1e-4, sceneSize * 0.002)

    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3()
    const sA = new THREE.Vector3(), sB = new THREE.Vector3(), sC = new THREE.Vector3()
    const triNormal = new THREE.Vector3()
    const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3()
    const viewVec = new THREE.Vector3()
    const tmpWorld = new THREE.Vector3()
    const triCenter = new THREE.Vector3()
    const projTmp = new THREE.Vector3()
    const uvAv = new THREE.Vector2(), uvBv = new THREE.Vector2(), uvCv = new THREE.Vector2()
    const lockPolicy = String(faceLockPolicy || 'none').toLowerCase()
    const ownershipEnabled = faceOwnershipMap instanceof Map

    let totalTriCount = 0
    for (const mesh of projectableMeshes) {
      totalTriCount += getGeometryFaceCount(mesh.geometry)
    }
    let trisDone = 0

    for (const mesh of projectableMeshes) {
      const geom = mesh.geometry
      const posAttr = geom.attributes.position
      const uvAttr = geom.attributes.uv
      if (!posAttr || !uvAttr) {
        continue
      }
      const indexAttr = geom.index
      const triCount = getGeometryFaceCount(geom)
      const matrixWorld = mesh.matrixWorld

      for (let tri = 0; tri < triCount; tri += 1) {
        const base = tri * 3
        const i0 = indexAttr ? indexAttr.getX(base) : base
        const i1 = indexAttr ? indexAttr.getX(base + 1) : base + 1
        const i2 = indexAttr ? indexAttr.getX(base + 2) : base + 2
        const faceKey = `${mesh.uuid}:${tri}`

        if (ownershipEnabled && lockPolicy !== 'none') {
          const previousOwnership = faceOwnershipMap.get(faceKey)
          if (previousOwnership && previousOwnership.layerId !== layerId) {
            const previousCoverage = Number(previousOwnership.coverage) || 0
            const previousFacing = Number(previousOwnership.facingCos) || 0
            const isStrongFace = previousCoverage >= faceLockCoverageThreshold && previousFacing >= faceLockFacingThreshold

            if (lockPolicy === 'strict' || (lockPolicy === 'quality-aware' && isStrongFace)) {
              lockedFaces += 1
              processedSamples += 1
              trisDone += 1
              continue
            }
          }
        }

        vA.fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld)
        vB.fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld)
        vC.fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld)

        // Optional backface cull. Some imported assets have mixed or inverted
        // winding; allowing two-sided projection prevents those meshes from
        // being almost fully rejected.
        edge1.subVectors(vB, vA)
        edge2.subVectors(vC, vA)
        triNormal.crossVectors(edge1, edge2)
        triCenter.copy(vA).add(vB).add(vC).multiplyScalar(1 / 3)
        viewVec.subVectors(triCenter, camWorldPos)
        const faceDot = triNormal.dot(viewVec)
        if (cullBackfaces && faceDot > 0) {
          processedSamples += 1
          continue
        }

        // Grazing-angle check: near-silhouette triangles are still painted
        // but NOT marked as covered so that subsequent projections with a
        // better facing angle can overwrite them (prevents dark seam lines).
        const nLenSq = triNormal.lengthSq()
        const vLenSq = viewVec.lengthSq()
        const isGrazingTriangle = grazingCoverageThreshold > 0
          && nLenSq > 0 && vLenSq > 0
          && (faceDot * faceDot) / (nLenSq * vLenSq) < grazingCoverageThreshold * grazingCoverageThreshold

        const facingCos = nLenSq > 0 && vLenSq > 0
          ? Math.max(0, (cullBackfaces ? -faceDot : Math.abs(faceDot)) / Math.sqrt(nLenSq * vLenSq))
          : 0
        const facingWeight = Math.pow(facingCos, Math.max(1, facingPower))

        // Project verts to NDC
        sA.copy(vA).project(camera)
        sB.copy(vB).project(camera)
        sC.copy(vC).project(camera)

        // Cheap frustum reject (all behind / all on one side)
        if ((sA.z < -1 && sB.z < -1 && sC.z < -1) || (sA.z > 1 && sB.z > 1 && sC.z > 1)) {
          processedSamples += 1
          continue
        }

        // Screen-space bbox vs mask bbox
        const ax = (sA.x * 0.5 + 0.5) * maskCanvas.width
        const ay = (-sA.y * 0.5 + 0.5) * maskCanvas.height
        const bx = (sB.x * 0.5 + 0.5) * maskCanvas.width
        const by = (-sB.y * 0.5 + 0.5) * maskCanvas.height
        const cx = (sC.x * 0.5 + 0.5) * maskCanvas.width
        const cy = (-sC.y * 0.5 + 0.5) * maskCanvas.height
        const minSx = Math.min(ax, bx, cx)
        const maxSx = Math.max(ax, bx, cx)
        const minSy = Math.min(ay, by, cy)
        const maxSy = Math.max(ay, by, cy)
        if (maxSx < bbox.x || minSx > bbox.x + bbox.width
          || maxSy < bbox.y || minSy > bbox.y + bbox.height) {
          processedSamples += 1
          continue
        }

        // UV pixel coords (with full texture transform applied)
        uvAv.set(uvAttr.getX(i0), uvAttr.getY(i0))
        uvBv.set(uvAttr.getX(i1), uvAttr.getY(i1))
        uvCv.set(uvAttr.getX(i2), uvAttr.getY(i2))
        const uvAp = mapUvToCanvasPoint(uvAv, textureWidth, textureHeight, textureConfig)
        const uvBp = mapUvToCanvasPoint(uvBv, textureWidth, textureHeight, textureConfig)
        const uvCp = mapUvToCanvasPoint(uvCv, textureWidth, textureHeight, textureConfig)

        const denom = (uvBp.y - uvCp.y) * (uvAp.x - uvCp.x) + (uvCp.x - uvBp.x) * (uvAp.y - uvCp.y)
        if (Math.abs(denom) < 1e-10) {
          processedSamples += 1
          continue
        }
        const invDenom = 1 / denom

        const minPx = Math.max(0, Math.floor(Math.min(uvAp.x, uvBp.x, uvCp.x)))
        const maxPx = Math.min(textureWidth - 1, Math.ceil(Math.max(uvAp.x, uvBp.x, uvCp.x)))
        const minPy = Math.max(0, Math.floor(Math.min(uvAp.y, uvBp.y, uvCp.y)))
        const maxPy = Math.min(textureHeight - 1, Math.ceil(Math.max(uvAp.y, uvBp.y, uvCp.y)))

        // Slight inflation to avoid seams between adjacent triangles
        const baryEps = -1e-4
        let faceCoveredTexels = 0
        let faceAcceptedTexels = 0
        let faceAccumulatedWeight = 0

        for (let py = minPy; py <= maxPy; py += 1) {
          for (let px = minPx; px <= maxPx; px += 1) {
            const fx = px + 0.5
            const fy = py + 0.5
            const w0 = ((uvBp.y - uvCp.y) * (fx - uvCp.x) + (uvCp.x - uvBp.x) * (fy - uvCp.y)) * invDenom
            const w1 = ((uvCp.y - uvAp.y) * (fx - uvCp.x) + (uvAp.x - uvCp.x) * (fy - uvCp.y)) * invDenom
            const w2 = 1 - w0 - w1
            if (w0 < baryEps || w1 < baryEps || w2 < baryEps) {
              continue
            }

            faceCoveredTexels += 1

            const pixelIdx = py * textureWidth + px
            const isPreviouslyCovered = Boolean(coverageMap && coverageMap[pixelIdx] > 0)
            if (isPreviouslyCovered && facingCos < Math.max(0, minFacingCos)) {
              continue
            }
            const coverageWeight = coverageWeights ? coverageWeights[pixelIdx] : 1
            if (coverageWeight <= 1e-6) {
              continue
            }
            const overlapWeight = isPreviouslyCovered ? (coverageWeight * coverageWeight) : coverageWeight
            if (isPreviouslyCovered && overlapWeight <= 0.02) {
              continue
            }

            // Interpolated 3D world position of this UV texel
            tmpWorld.set(
              vA.x * w0 + vB.x * w1 + vC.x * w2,
              vA.y * w0 + vB.y * w1 + vC.y * w2,
              vA.z * w0 + vB.z * w1 + vC.z * w2
            )

            // Project to screen
            projTmp.copy(tmpWorld).project(camera)
            if (projTmp.z < -1 || projTmp.z > 1) {
              continue
            }
            const sxF = (projTmp.x * 0.5 + 0.5) * maskCanvas.width
            const syF = (-projTmp.y * 0.5 + 0.5) * maskCanvas.height
            const localX = Math.floor(sxF - bbox.x)
            const localY = Math.floor(syF - bbox.y)
            if (localX < 0 || localY < 0 || localX >= bbox.width || localY >= bbox.height) {
              continue
            }

            // Cheap rejection on nearest mask alpha
            const nearestIdx = (localY * bbox.width + localX) * 4
            if (maskData[nearestIdx + 3] <= 0) {
              continue
            }

            // Occlusion test: prefer GPU depth prepass when available, then
            // fall back to BVH raycast for compatibility.
            if (useDepthPrepassOcclusion) {
              const sampledDepth = samplePackedDepth(depthPrepass, sxF, syF)
              if (!Number.isFinite(sampledDepth)) {
                continue
              }

              const projectedDepth = projTmp.z * 0.5 + 0.5
              if (projectedDepth > sampledDepth + DEPTH_PREPASS_EPSILON) {
                continue
              }
            } else if (useRaycastOcclusion && raycaster && pointer) {
              pointer.set(projTmp.x, projTmp.y)
              raycaster.setFromCamera(pointer, camera)
              const [hit] = raycaster.intersectObjects(projectableMeshes, false)
              if (!hit) {
                continue
              }
              const camDist = camWorldPos.distanceTo(tmpWorld)
              if (hit.distance < camDist - occlusionEps) {
                continue
              }
            } else if (useNoOcclusion) {
              // Intentionally skip visibility filtering. Used as a safety
              // fallback for meshes/camera states where occlusion heuristics
              // become over-restrictive and reject almost all samples.
            }

            const idx = (py * textureWidth + px) * 4

            if (binaryMask) {
              const alphaNorm = patchData[nearestIdx + 3] / 255
              if (alphaNorm <= 0.02) {
                continue
              }

              const angleWeight = isPreviouslyCovered ? facingWeight : 1
              const weight = overlapWeight * alphaNorm * angleWeight
              accumulatedColor[idx]     = patchData[nearestIdx] * weight
              accumulatedColor[idx + 1] = patchData[nearestIdx + 1] * weight
              accumulatedColor[idx + 2] = patchData[nearestIdx + 2] * weight
              accumulatedColor[idx + 3] = patchData[nearestIdx + 3] * weight
              accumulatedWeight[pixelIdx] = Math.max(accumulatedWeight[pixelIdx], weight)
              faceAcceptedTexels += 1
              faceAccumulatedWeight += weight
            } else {
              // Bilinear sample of patch + mask at the projected screen point
              const fxLocal = sxF - bbox.x - 0.5
              const fyLocal = syF - bbox.y - 0.5
              const x0 = Math.max(0, Math.min(bbox.width - 1, Math.floor(fxLocal)))
              const y0 = Math.max(0, Math.min(bbox.height - 1, Math.floor(fyLocal)))
              const x1 = Math.min(bbox.width - 1, x0 + 1)
              const y1 = Math.min(bbox.height - 1, y0 + 1)
              const tx = Math.max(0, Math.min(1, fxLocal - x0))
              const ty = Math.max(0, Math.min(1, fyLocal - y0))

              const i00 = (y0 * bbox.width + x0) * 4
              const i10 = (y0 * bbox.width + x1) * 4
              const i01 = (y1 * bbox.width + x0) * 4
              const i11 = (y1 * bbox.width + x1) * 4

              const w00 = (1 - tx) * (1 - ty)
              const w10 = tx * (1 - ty)
              const w01 = (1 - tx) * ty
              const w11 = tx * ty

              const sampleR = patchData[i00] * w00 + patchData[i10] * w10 + patchData[i01] * w01 + patchData[i11] * w11
              const sampleG = patchData[i00 + 1] * w00 + patchData[i10 + 1] * w10 + patchData[i01 + 1] * w01 + patchData[i11 + 1] * w11
              const sampleB = patchData[i00 + 2] * w00 + patchData[i10 + 2] * w10 + patchData[i01 + 2] * w01 + patchData[i11 + 2] * w11
              const sampleA = patchData[i00 + 3] * w00 + patchData[i10 + 3] * w10 + patchData[i01 + 3] * w01 + patchData[i11 + 3] * w11
              const sampleAlphaNorm = sampleA / 255

              const maskAlpha = (
                maskData[i00 + 3] * w00
                + maskData[i10 + 3] * w10
                + maskData[i01 + 3] * w01
                + maskData[i11 + 3] * w11
              ) / 255

              if (maskAlpha <= clampedMinMaskAlpha || sampleAlphaNorm <= 0.02) {
                continue
              }

              let correctedR = sampleR
              let correctedG = sampleG
              let correctedB = sampleB

              if (matteColor && maskAlpha < 0.995 && clampedUnmatteStrength > 0) {
                const safeAlpha = Math.max(0.08, maskAlpha)
                const edgeFactor = Math.max(0, Math.min(1, (1 - maskAlpha) / 0.75))
                const blendFactor = edgeFactor * clampedUnmatteStrength

                const unmatteR = Math.max(0, Math.min(255, (sampleR - matteColor.r * (1 - maskAlpha)) / safeAlpha))
                const unmatteG = Math.max(0, Math.min(255, (sampleG - matteColor.g * (1 - maskAlpha)) / safeAlpha))
                const unmatteB = Math.max(0, Math.min(255, (sampleB - matteColor.b * (1 - maskAlpha)) / safeAlpha))

                correctedR = sampleR + (unmatteR - sampleR) * blendFactor
                correctedG = sampleG + (unmatteG - sampleG) * blendFactor
                correctedB = sampleB + (unmatteB - sampleB) * blendFactor
              }

              const angleWeight = isPreviouslyCovered ? facingWeight : 1
              const weight = maskAlpha * clampedViewOpacity * overlapWeight * sampleAlphaNorm * angleWeight
              if (weight <= 0.0025) {
                continue
              }
              accumulatedColor[idx]     += correctedR * weight
              accumulatedColor[idx + 1] += correctedG * weight
              accumulatedColor[idx + 2] += correctedB * weight
              accumulatedColor[idx + 3] += sampleA * weight
              accumulatedWeight[pixelIdx] += weight
              faceAcceptedTexels += 1
              faceAccumulatedWeight += weight
            }

            if (touchedCoverage && !touchedCoverage[pixelIdx] && !isGrazingTriangle) {
              touchedCoverage[pixelIdx] = 1
              touchedCoverageIndices.push(pixelIdx)
            }

            // Record the screen footprint of accepted samples so the seam mask
            // can later be derived from the view-space silhouette rather than
            // the UV layout. Grazing (near-silhouette) texels are mapped but not
            // counted as covered, so they fall on the border and become seams.
            const screenSeamIdx = localY * screenSeamWidth + localX
            texelScreenIdx[pixelIdx] = screenSeamIdx
            if (!isGrazingTriangle) {
              screenCoverage[screenSeamIdx] = 1
            }

            appliedSamples += 1
          }
        }

        if (ownershipEnabled && faceAcceptedTexels > 0) {
          const coverageRatio = faceCoveredTexels > 0
            ? Math.min(1, faceAcceptedTexels / faceCoveredTexels)
            : 0
          const nextOwnership = {
            layerId,
            coverage: coverageRatio,
            facingCos,
            weight: faceAccumulatedWeight,
            score: coverageRatio * facingCos
          }
          const previousOwnership = faceOwnershipMap.get(faceKey)

          if (!previousOwnership || previousOwnership.layerId === layerId) {
            faceOwnershipMap.set(faceKey, nextOwnership)
          } else {
            const previousScore = Number(previousOwnership.score)
              || ((Number(previousOwnership.coverage) || 0) * (Number(previousOwnership.facingCos) || 0))
            const nextScore = nextOwnership.score
            const previousCoverage = Number(previousOwnership.coverage) || 0
            const previousFacing = Number(previousOwnership.facingCos) || 0
            const previousStrong = previousCoverage >= faceLockCoverageThreshold && previousFacing >= faceLockFacingThreshold

            if (!previousStrong || nextScore > previousScore + 1e-4) {
              faceOwnershipMap.set(faceKey, nextOwnership)
            }
          }
        }

        processedSamples += 1
        trisDone += 1

        if ((trisDone & 1023) === 0) {
          const now = performance.now()
          if (typeof onProgress === 'function' && now - lastProgressAt >= PROJECTED_PATCH_PROGRESS_INTERVAL_MS) {
            onProgress(Math.min(1, trisDone / Math.max(1, totalTriCount)))
            lastProgressAt = now
          }
          await waitForNextFrame()
        }
      }
    }

    if (typeof onProgress === 'function') {
      onProgress(1)
    }

    if (coverageMap && touchedCoverageIndices?.length) {
      for (let i = 0; i < touchedCoverageIndices.length; i += 1) {
        coverageMap[touchedCoverageIndices[i]] = 1
      }
    }

    // Derive the view-space seam mask: a texel is a seam when its screen
    // footprint lies within `seamRadiusCost` of the projection's screen-space
    // coverage border. Interior UV-island gutters project to the middle of the
    // coverage (large distance) and are correctly excluded.
    const viewSeamMask = new Uint8Array(textureWidth * textureHeight)
    const seamRadiusPx = Math.max(0, Math.min(64, Math.round(Number(blendPixels) || 0)))
    if (seamRadiusPx > 0) {
      const stitchedScreenCoverage = stitchScreenCoverageMask(screenCoverage, screenSeamWidth, screenSeamHeight)
      const screenDist = computeScreenDistanceInsideMask(stitchedScreenCoverage, screenSeamWidth, screenSeamHeight)
      const seamRadiusCost = Math.max(10, seamRadiusPx * 10)
      for (let i = 0; i < texelScreenIdx.length; i += 1) {
        const screenIdx = texelScreenIdx[i]
        if (screenIdx < 0) {
          continue
        }
        if (screenDist[screenIdx] <= seamRadiusCost) {
          viewSeamMask[i] = 1
        }
      }
    }

    return {
      durationMs: performance.now() - startedAt,
      activePixelCount,
      processedSamples,
      appliedSamples,
      coveredPixels: touchedCoverageIndices?.length || 0,
      lockedFaces,
      viewSeamMask,
      occlusionModeUsed: useDepthPrepassOcclusion
        ? 'depth-prepass'
        : (useRaycastOcclusion ? 'raycast' : 'none')
    }
  }
}

/**
 * Normalizes the accumulated color/weight buffers and blends the result into
 * textureCanvas in-place. Call this once after all views have been accumulated.
 */
export function finalizeProjectedPatch({
  textureCanvas,
  accumulatedColor,
  accumulatedWeight,
  gapFillRadius = 0,
  previousCoverageMap = null,
  boundaryBlendPixels = 0,
  boundaryOnlyBlend = false
}) {
  const textureWidth = textureCanvas.width
  const textureHeight = textureCanvas.height
  const textureContext = textureCanvas.getContext('2d')
  const textureImageData = textureContext.getImageData(0, 0, textureWidth, textureHeight)
  const boundaryBlendWeights = boundaryOnlyBlend
    ? buildCoverageBlendWeights(previousCoverageMap, textureWidth, textureHeight, boundaryBlendPixels)
    : null
  let appliedPixels = 0

  for (let pixelIndex = 0; pixelIndex < accumulatedWeight.length; pixelIndex += 1) {
    const weight = accumulatedWeight[pixelIndex]

    if (weight <= 0) {
      continue
    }

    const colorIndex = pixelIndex * 4
    const wasPreviouslyCovered = Boolean(previousCoverageMap && previousCoverageMap[pixelIndex] > 0)
    let blend = Math.min(1, weight)

    if (boundaryOnlyBlend && wasPreviouslyCovered) {
      const boundaryWeight = boundaryBlendWeights ? boundaryBlendWeights[pixelIndex] : 0
      if (boundaryWeight <= 1e-6) {
        continue
      }
      blend *= boundaryWeight
    }

    if (blend <= 1e-6) {
      continue
    }

    textureImageData.data[colorIndex]     = Math.round(textureImageData.data[colorIndex]     * (1 - blend) + (accumulatedColor[colorIndex]     / weight) * blend)
    textureImageData.data[colorIndex + 1] = Math.round(textureImageData.data[colorIndex + 1] * (1 - blend) + (accumulatedColor[colorIndex + 1] / weight) * blend)
    textureImageData.data[colorIndex + 2] = Math.round(textureImageData.data[colorIndex + 2] * (1 - blend) + (accumulatedColor[colorIndex + 2] / weight) * blend)
    textureImageData.data[colorIndex + 3] = Math.round(textureImageData.data[colorIndex + 3] * (1 - blend) + (accumulatedColor[colorIndex + 3] / weight) * blend)
    appliedPixels += 1
  }

  const fillRadius = Math.max(0, Math.min(4, Math.floor(gapFillRadius)))
  if (fillRadius > 0) {
    const sourceData = new Uint8ClampedArray(textureImageData.data)

    for (let pixelIndex = 0; pixelIndex < accumulatedWeight.length; pixelIndex += 1) {
      if (boundaryOnlyBlend && previousCoverageMap && previousCoverageMap[pixelIndex] > 0) {
        continue
      }

      if (accumulatedWeight[pixelIndex] > 0) {
        continue
      }

      const x = pixelIndex % textureWidth
      const y = Math.floor(pixelIndex / textureWidth)
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      let hits = 0

      for (let dy = -fillRadius; dy <= fillRadius; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= textureHeight) {
          continue
        }

        for (let dx = -fillRadius; dx <= fillRadius; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue
          }

          const nx = x + dx
          if (nx < 0 || nx >= textureWidth) {
            continue
          }

          const neighborIndex = ny * textureWidth + nx
          if (accumulatedWeight[neighborIndex] <= 0) {
            continue
          }

          const sourceIndex = neighborIndex * 4
          sumR += sourceData[sourceIndex]
          sumG += sourceData[sourceIndex + 1]
          sumB += sourceData[sourceIndex + 2]
          sumA += sourceData[sourceIndex + 3]
          hits += 1
        }
      }

      if (hits <= 0) {
        continue
      }

      const colorIndex = pixelIndex * 4
      textureImageData.data[colorIndex] = Math.round(sumR / hits)
      textureImageData.data[colorIndex + 1] = Math.round(sumG / hits)
      textureImageData.data[colorIndex + 2] = Math.round(sumB / hits)
      textureImageData.data[colorIndex + 3] = Math.round(sumA / hits)
    }
  }

  textureContext.putImageData(textureImageData, 0, 0)
  return { appliedPixels }
}

