import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

const THUMBNAIL_SIZE = 512
const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply'])

function getFileExtension(fileName = '') {
  const match = String(fileName).toLowerCase().match(/\.[^.]+$/)
  return match?.[0] || ''
}

function createDefaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: '#cfd8ff',
    metalness: 0.18,
    roughness: 0.55
  })
}

function normalizeMeshObject(object) {
  const root = object?.scene || object
  const container = new THREE.Group()

  if (!root) {
    throw new Error('No mesh data found')
  }

  container.add(root)
  root.traverse(child => {
    if (!child.isMesh) {
      return
    }

    child.castShadow = true
    child.receiveShadow = true

    if (!child.material) {
      child.material = createDefaultMaterial()
    }

    if (child.geometry && !child.geometry.attributes.normal) {
      child.geometry.computeVertexNormals()
    }
  })

  return container
}

async function loadMeshObject(file) {
  const extension = getFileExtension(file.name)

  if (!MESH_EXTENSIONS.has(extension)) {
    return null
  }

  if (extension === '.obj') {
    const text = await file.text()
    return normalizeMeshObject(new OBJLoader().parse(text))
  }

  const buffer = await file.arrayBuffer()

  if (extension === '.glb' || extension === '.gltf') {
    const loader = new GLTFLoader()
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(buffer, '', resolve, reject)
    })

    return normalizeMeshObject(gltf)
  }

  if (extension === '.fbx') {
    return normalizeMeshObject(new FBXLoader().parse(buffer, ''))
  }

  if (extension === '.stl') {
    const geometry = new STLLoader().parse(buffer)
    return normalizeMeshObject(new THREE.Mesh(geometry, createDefaultMaterial()))
  }

  if (extension === '.ply') {
    const geometry = new PLYLoader().parse(buffer)
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals()
    }
    return normalizeMeshObject(new THREE.Mesh(geometry, createDefaultMaterial()))
  }

  return null
}

function disposeSceneObject(root) {
  root?.traverse(child => {
    if (child.geometry) {
      child.geometry.dispose()
    }

    if (Array.isArray(child.material)) {
      child.material.forEach(material => material?.dispose?.())
    } else {
      child.material?.dispose?.()
    }
  })
}

/**
 * Render a prepared scene to a PNG blob, on a throwaway renderer.
 *
 * Extracted so the VFX thumbnail path can share it (src/utils/vfxThumbnail.js)
 * rather than duplicating forty lines of renderer setup and the toBlob dance.
 * Behaviour-preserving for the mesh path: the defaults below are exactly what
 * it used before.
 *
 * `toneMapping` is an option because it has to be. Particle materials include
 * three's tonemapping chunk gated on the renderer's own setting, so a thumbnail
 * rendered with NoToneMapping would come out brighter and more saturated than
 * the same effect in the preview - the card would not match the thing it is a
 * picture of. Meshes want the existing NoToneMapping default; effects pass ACES.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{size?: number, clearColor?: string, toneMapping?: number}} [options]
 * @returns {Promise<Blob>}
 */
export async function renderSceneToBlob(scene, camera, options = {}) {
  const size = options.size || THUMBNAIL_SIZE
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, preserveDrawingBuffer: true })
  renderer.setSize(size, size, false)
  renderer.setPixelRatio(1)
  renderer.setClearColor(options.clearColor || '#121316', 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = options.toneMapping ?? THREE.NoToneMapping

  renderer.render(scene, camera)

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => {
      if (result) {
        resolve(result)
        return
      }
      reject(new Error('Failed to capture thumbnail'))
    }, 'image/png')
  })

  renderer.dispose()
  return blob
}

async function renderObjectToBlob(object) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#121316')

  const ambientLight = new THREE.AmbientLight('#ffffff', 1.8)
  const keyLight = new THREE.DirectionalLight('#ffffff', 2.4)
  keyLight.position.set(4, 6, 8)
  const rimLight = new THREE.DirectionalLight('#8ff5ff', 1.2)
  rimLight.position.set(-5, 3, -4)

  scene.add(ambientLight, keyLight, rimLight, object)

  const bounds = new THREE.Box3().setFromObject(object)
  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const maxDimension = Math.max(size.x, size.y, size.z, 1)

  object.position.sub(center)

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, maxDimension * 20)
  const distance = maxDimension * 2.2
  camera.position.set(distance * 0.75, distance * 0.55, distance)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()

  const blob = await renderSceneToBlob(scene, camera)
  disposeSceneObject(object)
  return blob
}

export function isMeshFile(fileName = '') {
  return MESH_EXTENSIONS.has(getFileExtension(fileName))
}

export async function createMeshThumbnailFile(file) {
  const meshObject = await loadMeshObject(file)

  if (!meshObject) {
    return null
  }

  const blob = await renderObjectToBlob(meshObject)
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'mesh'
  return new File([blob], `${baseName}-thumbnail.png`, { type: 'image/png' })
}
