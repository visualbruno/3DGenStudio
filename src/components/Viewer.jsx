import { Canvas, useThree } from '@react-three/fiber'
import { Environment, Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

function PlaceholderMesh() {
  return (
    <mesh castShadow receiveShadow>
      <torusKnotGeometry args={[1, 0.3, 128, 32]} />
      <meshPhysicalMaterial 
        color="#AC89FF" 
        roughness={0.1} 
        metalness={1} 
        emissive="#AC89FF"
        emissiveIntensity={0.2}
      />
    </mesh>
  )
}

function createDefaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: '#cfd8ff',
    metalness: 0.18,
    roughness: 0.55
  })
}

function getExtensionFromUrl(url = '') {
  const sanitizedUrl = String(url).split('?')[0].toLowerCase()
  const match = sanitizedUrl.match(/\.[^.]+$/)
  return match?.[0] || ''
}

function normalizeLoadedModel(asset, fitMode = 'ground') {
  const root = asset?.scene || asset

  if (!root) {
    throw new Error('No mesh data found')
  }

  const container = new THREE.Group()
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

  root.updateMatrixWorld(true)

  const bounds = new THREE.Box3().setFromObject(root)
  const target = new THREE.Vector3(0, 0, 0)
  const cameraPosition = new THREE.Vector3(3, 3, 5)

  if (!bounds.isEmpty()) {
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z, 1)
    const scale = 2 / maxDimension

    root.scale.setScalar(scale)

    if (fitMode === 'center') {
      root.position.set(
        -center.x * scale,
        -center.y * scale,
        -center.z * scale
      )
    } else {
      root.position.set(
        -center.x * scale,
        -bounds.min.y * scale,
        -center.z * scale
      )
    }

    root.updateMatrixWorld(true)

    const scaledHeight = size.y * scale
    const maxScaledDimension = Math.max(size.x, size.y, size.z) * scale
    const distance = Math.max(maxScaledDimension * 1.5, 2)

    if (fitMode === 'center') {
      target.set(0, 0, 0)
      cameraPosition.set(distance, Math.max(distance * 0.7, 1.75), distance)
    } else {
      target.set(0, scaledHeight / 2, 0)
      cameraPosition.set(distance, Math.max(scaledHeight * 0.8, distance * 0.55), distance)
    }
  }

  return {
    object: container,
    target,
    cameraPosition
  }
}

function loadWithLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject)
  })
}

function applyDisplayMaterial(object, showNormals) {
  object?.traverse(child => {
    if (!child.isMesh) {
      return
    }

    if (!child.userData.originalMat) {
      child.userData.originalMat = child.material
    }

    if (showNormals) {
      if (!child.userData.normalMat) {
        child.userData.normalMat = new THREE.MeshNormalMaterial()
      }

      child.material = child.userData.normalMat
      return
    }

    if (child.userData.originalMat) {
      child.material = child.userData.originalMat
    }
  })
}

async function loadModelFromUrl(url, fitMode = 'ground') {
  const extension = getExtensionFromUrl(url)

  if (extension === '.glb' || extension === '.gltf') {
    return normalizeLoadedModel(await loadWithLoader(new GLTFLoader(), url), fitMode)
  }

  if (extension === '.obj') {
    return normalizeLoadedModel(await loadWithLoader(new OBJLoader(), url), fitMode)
  }

  if (extension === '.fbx') {
    return normalizeLoadedModel(await loadWithLoader(new FBXLoader(), url), fitMode)
  }

  if (extension === '.stl') {
    const geometry = await loadWithLoader(new STLLoader(), url)
    return normalizeLoadedModel(new THREE.Mesh(geometry, createDefaultMaterial()), fitMode)
  }

  if (extension === '.ply') {
    const geometry = await loadWithLoader(new PLYLoader(), url)
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals()
    }

    return normalizeLoadedModel(new THREE.Mesh(geometry, createDefaultMaterial()), fitMode)
  }

  throw new Error('Unsupported mesh format')
}

function CameraController({ autoRotate, target, cameraPosition }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)

  useEffect(() => {
    camera.position.copy(cameraPosition)
    camera.lookAt(target)
    camera.updateProjectionMatrix()

    if (controlsRef.current) {
      controlsRef.current.target.copy(target)
      controlsRef.current.update()
    }
  }, [camera, cameraPosition, target])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      autoRotate={autoRotate}
      autoRotateSpeed={0.5}
      enableDamping
    />
  )
}

export default function Viewer({
  height = '100%',
  modelUrl = null,
  showNormals = false,
  showGrid = true,
  lightIntensity = 2.2,
  fitMode = 'ground'
}) {
  const [modelState, setModelState] = useState(null)

  useEffect(() => {
    let active = true

    if (!modelUrl) {
      return undefined
    }

    loadModelFromUrl(modelUrl, fitMode)
      .then(loadedModelState => {
        if (active) {
          setModelState({
            ...loadedModelState,
            modelUrl
          })
        }
      })
      .catch(err => {
        console.error('Failed to load mesh preview:', err)
      })

    return () => {
      active = false
    }
  }, [fitMode, modelUrl])

  const renderedModel = useMemo(() => {
    if (!modelState?.object || modelState.modelUrl !== modelUrl) {
      return null
    }

    const modelClone = modelState.object.clone(true)
    applyDisplayMaterial(modelClone, showNormals)
    return modelClone
  }, [modelState, modelUrl, showNormals])

  const cameraTarget = modelState?.modelUrl === modelUrl ? modelState.target : new THREE.Vector3(0, 0.75, 0)
  const cameraPosition = modelState?.modelUrl === modelUrl ? modelState.cameraPosition : new THREE.Vector3(3, 3, 5)

  return (
    <div style={{ width: '100%', height, background: '#0D0E10', borderRadius: '8px', overflow: 'hidden' }}>
      <Canvas key={modelUrl || 'placeholder'} shadows>
        <PerspectiveCamera makeDefault position={[3, 3, 5]} />
          <ambientLight intensity={Math.max(lightIntensity * 0.55, 0.35)} />
          <directionalLight position={[4, 6, 8]} intensity={lightIntensity} castShadow />
          <directionalLight position={[-5, 3, -4]} intensity={Math.max(lightIntensity * 0.4, 0.15)} color="#8ff5ff" />
        <Suspense fallback={null}>
          {renderedModel ? <primitive object={renderedModel} /> : <PlaceholderMesh />}
            {showGrid && (
              <Grid
                infiniteGrid
                fadeDistance={30}
                cellColor="#47484A"
                sectionColor="#AC89FF"
                sectionThickness={1.5}
                sectionSize={10}
              />
            )}
        </Suspense>
        <Environment preset="night" />
        <CameraController autoRotate={!modelUrl} target={cameraTarget} cameraPosition={cameraPosition} />
      </Canvas>
    </div>
  )
}
