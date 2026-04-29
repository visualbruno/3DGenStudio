import * as THREE from 'three'
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
    const [a, b, c] = vertices.map(vertexIndex => mapUvToCanvasPoint(
      new THREE.Vector2(uvArray[vertexIndex * 2], uvArray[vertexIndex * 2 + 1]),
      textureWidth,
      textureHeight,
      textureConfig
    ))

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
  console.log('[meshTexturing] loadMeshRootFromUrl:start', { url })
  const extension = getExtensionFromUrl(url)

  if (extension === '.glb' || extension === '.gltf') {
    const root = (await loadWithLoader(new GLTFLoader(), url))?.scene || null
    console.log('[meshTexturing] loadMeshRootFromUrl:done', { url, elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10, type: 'gltf' })
    return root
  }

  if (extension === '.obj') {
    const root = await loadWithLoader(new OBJLoader(), url)
    console.log('[meshTexturing] loadMeshRootFromUrl:done', { url, elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10, type: 'obj' })
    return root
  }

  if (extension === '.fbx') {
    const root = await loadWithLoader(new FBXLoader(), url)
    console.log('[meshTexturing] loadMeshRootFromUrl:done', { url, elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10, type: 'fbx' })
    return root
  }

  if (extension === '.stl') {
    const geometry = await loadWithLoader(new STLLoader(), url)
    const root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#cfd8ff' }))
    console.log('[meshTexturing] loadMeshRootFromUrl:done', { url, elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10, type: 'stl' })
    return root
  }

  if (extension === '.ply') {
    const geometry = await loadWithLoader(new PLYLoader(), url)
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals()
    }

    const root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#cfd8ff' }))
    console.log('[meshTexturing] loadMeshRootFromUrl:done', { url, elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10, type: 'ply' })
    return root
  }

  throw new Error('Unsupported mesh format')
}

export async function loadTexturableMeshFromUrl(url) {
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  console.log('[meshTexturing] loadTexturableMeshFromUrl:start', { url })
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

  console.log('[meshTexturing] loadTexturableMeshFromRoot:scan', {
    url,
    elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10,
    hasUvs,
    texturedMaterialCount: texturedMaterials.length
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
    console.log('[meshTexturing] loadTexturableMeshFromRoot:done', {
      url,
      elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10,
      supported: false,
      reason: 'multiple texture maps'
    })
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

  console.log('[meshTexturing] loadTexturableMeshFromRoot:done', {
    url,
    elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10,
    supported: true,
    textureWidth: textureCanvas.width,
    textureHeight: textureCanvas.height,
    paintTargetCount: Object.keys(paintTargetsByMeshUuid).length
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

export async function exportTexturedMeshToGlb({ root, textureKey, textureCanvas, textureConfig = null }) {
  if (!root || !textureCanvas) {
    throw new Error('A textured mesh is required to export a textured GLB file.')
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

    child.castShadow = true
    child.receiveShadow = true

    if (Array.isArray(child.material)) {
      child.material = child.material.map(material => {
        const nextMaterial = material?.clone?.() || material

        if (nextMaterial && getTextureKeyFromMaterial(material) === textureKey) {
          nextMaterial.map = displayTexture
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
      nextMaterial.map = displayTexture
      nextMaterial.needsUpdate = true
    }

    child.material = nextMaterial

    if (nextMaterial) {
      materials.push(nextMaterial)
    }
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

export function captureTexturedMeshView({ root, textureKey, displayTexture, camera, width, height, targetContext }) {
  if (!root || !displayTexture || !camera || !width || !height) {
    throw new Error('The mesh projection view could not be rendered.')
  }

  // If a target context is provided, use ITS physical dimensions for high-res rendering
  const renderWidth = targetContext?.canvas?.width || width
  const renderHeight = targetContext?.canvas?.height || height

  const projectionCamera = createProjectionRenderCamera(camera, renderWidth / renderHeight)
  const { object, dispose } = createTexturedRenderClone(root, textureKey, displayTexture)
  const scene = createProjectionScene(object)
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true
  })

  try {
    renderer.setPixelRatio(1)
    // Render Three.js natively at the high-res dimensions
    renderer.setSize(renderWidth, renderHeight, false) 
    renderer.outputColorSpace = displayTexture.colorSpace || THREE.SRGBColorSpace
    renderer.render(scene, projectionCamera)

    // Draw 1:1 mapping (no stretching, perfect pixel quality)
    const context = targetContext || createCanvas(width, height).getContext('2d')
    context.drawImage(renderer.domElement, 0, 0, renderWidth, renderHeight)
    
    return context.canvas
  } finally {
    renderer.dispose()
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

function splatProjectedColor(accumulatedColor, accumulatedWeight, textureWidth, textureHeight, x, y, rgba, weight) {
  const clampedX = THREE.MathUtils.clamp(x - 0.5, 0, textureWidth - 1)
  const clampedY = THREE.MathUtils.clamp(y - 0.5, 0, textureHeight - 1)
  const x0 = Math.floor(clampedX)
  const y0 = Math.floor(clampedY)
  const x1 = Math.min(textureWidth - 1, x0 + 1)
  const y1 = Math.min(textureHeight - 1, y0 + 1)
  const tx = clampedX - x0
  const ty = clampedY - y0

  ;[
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty]
  ].forEach(([pixelX, pixelY, pixelWeight]) => {
    if (pixelWeight <= 0) {
      return
    }

    const nextWeight = weight * pixelWeight
    const pixelIndex = pixelY * textureWidth + pixelX
    const colorIndex = pixelIndex * 4

    accumulatedColor[colorIndex] += rgba[0] * nextWeight
    accumulatedColor[colorIndex + 1] += rgba[1] * nextWeight
    accumulatedColor[colorIndex + 2] += rgba[2] * nextWeight
    accumulatedColor[colorIndex + 3] += rgba[3] * nextWeight
    accumulatedWeight[pixelIndex] += nextWeight
  })
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

  return `http://localhost:3001/assets/${encodeURI(normalizedPath)}`
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
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })

  try {
    renderer.setPixelRatio(1)
    renderer.setSize(width, height, false)
    renderer.setClearColor(0x000000, 0)
    renderer.render(scene, projectionCamera)

    const canvas = createCanvas(width, height)
    canvas.getContext('2d').drawImage(renderer.domElement, 0, 0, width, height)
    return canvas
  } finally {
    renderer.dispose()
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
	binaryMask = false
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

  const raycaster = new THREE.Raycaster()
  raycaster.firstHitOnly = true
  const pointer = new THREE.Vector2()
  const activePixelCount = countActiveProjectionPixels(maskData)

  camera.updateMatrixWorld?.(true)
  root.updateMatrixWorld?.(true)
  const projectableMeshes = ensureRaycastAcceleration(root, textureKey)

  if (activePixelCount === 0 || projectableMeshes.length === 0) {
    return {
      durationMs: performance.now() - startedAt,
      activePixelCount,
      processedSamples: 0,
      appliedSamples: 0
    }
  }

  let processedSamples = 0
  let appliedSamples = 0
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
    const projTmp = new THREE.Vector3()
    const uvAv = new THREE.Vector2(), uvBv = new THREE.Vector2(), uvCv = new THREE.Vector2()

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

        vA.fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld)
        vB.fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld)
        vC.fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld)

        // Backface cull
        edge1.subVectors(vB, vA)
        edge2.subVectors(vC, vA)
        triNormal.crossVectors(edge1, edge2)
        viewVec.subVectors(vA, camWorldPos)
        if (triNormal.dot(viewVec) > 0) {
          processedSamples += 1
          continue
        }

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

            // Occlusion test: raycast through this screen point and verify our
            // 3D point is the closest visible surface.
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

            const idx = (py * textureWidth + px) * 4
            const pixelIdx = py * textureWidth + px

            if (binaryMask) {
              accumulatedColor[idx]     = patchData[nearestIdx]
              accumulatedColor[idx + 1] = patchData[nearestIdx + 1]
              accumulatedColor[idx + 2] = patchData[nearestIdx + 2]
              accumulatedColor[idx + 3] = patchData[nearestIdx + 3]
              accumulatedWeight[pixelIdx] = 1.0
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

              const maskAlpha = (
                maskData[i00 + 3] * w00
                + maskData[i10 + 3] * w10
                + maskData[i01 + 3] * w01
                + maskData[i11 + 3] * w11
              ) / 255

              if (maskAlpha <= 0.01) {
                continue
              }

              const weight = maskAlpha * clampedViewOpacity
              accumulatedColor[idx]     += sampleR * weight
              accumulatedColor[idx + 1] += sampleG * weight
              accumulatedColor[idx + 2] += sampleB * weight
              accumulatedColor[idx + 3] += sampleA * weight
              accumulatedWeight[pixelIdx] += weight
            }
            appliedSamples += 1
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

    return {
      durationMs: performance.now() - startedAt,
      activePixelCount,
      processedSamples,
      appliedSamples
    }
  }
}

function gaussianBlurWeight(weightMap, width, height, radius) {
  const kernelSize = Math.ceil(radius * 2)
  const kernel = []
  let kernelSum = 0
  const sigma = radius / 2
  for (let y = -kernelSize; y <= kernelSize; y++) {
    for (let x = -kernelSize; x <= kernelSize; x++) {
      const d = Math.sqrt(x*x + y*y)
      const val = Math.exp(-(d*d) / (2*sigma*sigma))
      kernel.push(val)
      kernelSum += val
    }
  }
  // Normalize kernel
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kernelSum
  
  const result = new Float32Array(weightMap.length)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let sum = 0
      let ki = 0
      for (let ky = -kernelSize; ky <= kernelSize; ky++) {
        for (let kx = -kernelSize; kx <= kernelSize; kx++) {
          const sx = Math.min(width-1, Math.max(0, px + kx))
          const sy = Math.min(height-1, Math.max(0, py + ky))
          sum += weightMap[sy * width + sx] * kernel[ki++]
        }
      }
      result[py * width + px] = sum
    }
  }
  return result
}

/**
 * Normalizes the accumulated color/weight buffers and blends the result into
 * textureCanvas in-place. Call this once after all views have been accumulated.
 */
export function finalizeProjectedPatch({ textureCanvas, accumulatedColor, accumulatedWeight }) {
  const textureWidth = textureCanvas.width
  const textureHeight = textureCanvas.height
  const textureContext = textureCanvas.getContext('2d')
  const textureImageData = textureContext.getImageData(0, 0, textureWidth, textureHeight)
  let appliedPixels = 0

  for (let pixelIndex = 0; pixelIndex < accumulatedWeight.length; pixelIndex += 1) {
    const weight = accumulatedWeight[pixelIndex]

    if (weight <= 0) {
      continue
    }

    const colorIndex = pixelIndex * 4
    const blend = Math.min(1, weight)

    textureImageData.data[colorIndex]     = Math.round(textureImageData.data[colorIndex]     * (1 - blend) + (accumulatedColor[colorIndex]     / weight) * blend)
    textureImageData.data[colorIndex + 1] = Math.round(textureImageData.data[colorIndex + 1] * (1 - blend) + (accumulatedColor[colorIndex + 1] / weight) * blend)
    textureImageData.data[colorIndex + 2] = Math.round(textureImageData.data[colorIndex + 2] * (1 - blend) + (accumulatedColor[colorIndex + 2] / weight) * blend)
    textureImageData.data[colorIndex + 3] = Math.round(textureImageData.data[colorIndex + 3] * (1 - blend) + (accumulatedColor[colorIndex + 3] / weight) * blend)
    appliedPixels += 1
  }

  textureContext.putImageData(textureImageData, 0, 0)
  return { appliedPixels }
}

// Add this helper function to smooth weight transitions
function blurWeightMap(weightMap, width, height, radius) {
  const result = new Float32Array(weightMap.length)
  const kernelSize = Math.ceil(radius)
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let totalWeight = 0
      let sampleCount = 0
      
      // Sample nearby pixels in a square kernel
      for (let dy = -kernelSize; dy <= kernelSize; dy++) {
        for (let dx = -kernelSize; dx <= kernelSize; dx++) {
          const sampleX = Math.max(0, Math.min(width - 1, x + dx))
          const sampleY = Math.max(0, Math.min(height - 1, y + dy))
          const distance = Math.sqrt(dx * dx + dy * dy)
          
          if (distance <= radius) {
            const gaussianWeight = Math.exp(-(distance * distance) / (2 * radius * radius))
            totalWeight += weightMap[sampleY * width + sampleX] * gaussianWeight
            sampleCount += gaussianWeight
          }
        }
      }
      
      result[y * width + x] = sampleCount > 0 ? totalWeight / sampleCount : 0
    }
  }
  
  return result
}