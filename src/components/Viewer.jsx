import { Canvas } from '@react-three/fiber'
import { Bounds, Center, Environment, Grid, OrbitControls, PerspectiveCamera, Stage } from '@react-three/drei'
import { Suspense, useEffect, useMemo, useState } from 'react'
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

function normalizeLoadedModel(asset) {
  const root = asset?.scene || asset

  if (!root) {
    throw new Error('No mesh data found')
  }

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

  return root
}

function loadWithLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject)
  })
}

async function loadModelFromUrl(url) {
  const extension = getExtensionFromUrl(url)

  if (extension === '.glb' || extension === '.gltf') {
    return normalizeLoadedModel(await loadWithLoader(new GLTFLoader(), url))
  }

  if (extension === '.obj') {
    return normalizeLoadedModel(await loadWithLoader(new OBJLoader(), url))
  }

  if (extension === '.fbx') {
    return normalizeLoadedModel(await loadWithLoader(new FBXLoader(), url))
  }

  if (extension === '.stl') {
    const geometry = await loadWithLoader(new STLLoader(), url)
    return normalizeLoadedModel(new THREE.Mesh(geometry, createDefaultMaterial()))
  }

  if (extension === '.ply') {
    const geometry = await loadWithLoader(new PLYLoader(), url)
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals()
    }

    return normalizeLoadedModel(new THREE.Mesh(geometry, createDefaultMaterial()))
  }

  throw new Error('Unsupported mesh format')
}

function ModelPreview({ modelUrl }) {
  const [model, setModel] = useState(null)

  useEffect(() => {
    let active = true

    if (!modelUrl) {
      return undefined
    }

    loadModelFromUrl(modelUrl)
      .then(loadedModel => {
        if (active) {
          setModel(loadedModel)
        }
      })
      .catch(err => {
        console.error('Failed to load mesh preview:', err)
      })

    return () => {
      active = false
    }
  }, [modelUrl])

  const renderedModel = useMemo(() => {
    if (!model) {
      return null
    }

    return model.clone()
  }, [model])

  if (!renderedModel) {
    return <PlaceholderMesh />
  }

  return (
    <Bounds fit clip observe margin={1.2}>
      <Center>
        <primitive object={renderedModel} />
      </Center>
    </Bounds>
  )
}

export default function Viewer({ height = '100%', modelUrl = null }) {
  return (
    <div style={{ width: '100%', height, background: '#0D0E10', borderRadius: '8px', overflow: 'hidden' }}>
      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[3, 3, 5]} />
        <Suspense fallback={null}>
          <Stage environment="city" intensity={0.5} contactShadow={{ opacity: 0.4, blur: 2 }}>
            {modelUrl ? <ModelPreview modelUrl={modelUrl} /> : <PlaceholderMesh />}
          </Stage>
          <Grid 
            infiniteGrid 
            fadeDistance={30} 
            cellColor="#47484A" 
            sectionColor="#AC89FF" 
            sectionThickness={1.5}
            sectionSize={10}
          />
        </Suspense>
        <Environment preset="night" />
        <OrbitControls makeDefault autoRotate={!modelUrl} autoRotateSpeed={0.5} enableDamping />
      </Canvas>
    </div>
  )
}
