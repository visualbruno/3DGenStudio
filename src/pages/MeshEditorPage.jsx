import { Canvas, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
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
  getFaceSelectionGeometry,
  getSelectedHoleLoops,
  getVertexSelectionPositions,
  loadEditableGeometryFromUrl,
  mergeSelectedVertices,
  smoothSelectedVertices,
  subdivideSelectedFaces
} from '../utils/meshEditor'
import {
  applyProjectedTexturePatch,
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
  getDefaultTextureWorkflowParameterIds,
  getMaskBoundingBox,
  getTextureKeyFromMaterial,
  getUvIslandHitInfo,
  getWorkflowValueType,
  loadTexturableMeshFromUrl,
  updateCanvasTexture,
  accumulateProjectedPatch,
  captureTextureMaskScreenView,
  finalizeProjectedPatch,
  generateOrbitalCameras,
  estimateMaskOrbitTarget
} from '../utils/meshTexturing'
import './MeshEditorPage.css'
import AssetSelectorModal from '../components/AssetSelectorModal';

function getRectangleBounds(startPoint, endPoint) {
  return {
    left: Math.min(startPoint.x, endPoint.x),
    right: Math.max(startPoint.x, endPoint.x),
    top: Math.min(startPoint.y, endPoint.y),
    bottom: Math.max(startPoint.y, endPoint.y)
  }
}

function getSupersampledCanvasSize(width, height, targetMinDimension = 1024) {
  const maxDim = Math.max(width, height)
  if (maxDim >= targetMinDimension) {
    return { width, height }
  }
  const scale = targetMinDimension / maxDim
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
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

function CameraRig({ geometry, onCameraReady, controlsEnabled = true }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const [distanceBounds, setDistanceBounds] = useState({ minDistance: 0.001, maxDistance: 100 })

  useEffect(() => {
    onCameraReady?.(camera)
  }, [camera, onCameraReady])

  useEffect(() => {
    if (!geometry) {
      return
    }

    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    const radius = Math.max(sphere?.radius || 1, 1)
    const center = sphere?.center || new THREE.Vector3()
    const distance = radius * 2.6
    const minDistance = Math.max(radius * 0.0025, 0.0005)
    const maxDistance = Math.max(radius * 24, 24)

    setDistanceBounds({ minDistance, maxDistance })

    camera.position.set(center.x + distance, center.y + distance * 0.65, center.z + distance)
    // eslint-disable-next-line react-hooks/immutability
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
  }, [camera, geometry])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={controlsEnabled}
      enableDamping
      minDistance={distanceBounds.minDistance}
      maxDistance={distanceBounds.maxDistance}
      mouseButtons={{
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.PAN
      }}
    />
  )
}

function EditorMesh({ geometry, selectedFaceIndices, selectedVertexIndices }) {
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
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#a9b6ff" metalness={0.08} roughness={0.62} />
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

function TexturedMesh({ root, textureKey, displayTexture }) {
  const baseObject = useMemo(() => {
    if (!root || !displayTexture) {
      return null
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

    object.userData.meshEditorMaterials = materials
    return object
  }, [displayTexture, root, textureKey])

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

export default function MeshEditorPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    getComfyWorkflows,
    runComfyWorkflow,
    saveMeshEdit,
    subscribeToComfyWorkflowProgress,
    updateProjectNode,
    uploadAssetThumbnail
  } = useProjects()

  const [showSettings, setShowSettings] = useState(false)
  const [activeMenu, setActiveMenu] = useState('modeling')
  const [geometry, setGeometry] = useState(null)
  const [texturableMesh, setTexturableMesh] = useState(null)
  const [textureRevision, setTextureRevision] = useState(0)
  const [comfyLoading, setComfyLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [textureWorkflowId, setTextureWorkflowId] = useState('')
  const [textureWorkflowInputs, setTextureWorkflowInputs] = useState({})
  const [brushSize, setBrushSize] = useState(20)
  const [cropPadding, setCropPadding] = useState(36)
  const [featherRadius, setFeatherRadius] = useState(12)
  const [geometryRevision, setGeometryRevision] = useState(0)
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
  const projectionCameraRef = useRef(null)
  const [hasProjectionMask, setHasProjectionMask] = useState(false)
  const originalTextureBackupRef = useRef(null)
  const patchedTextureRef = useRef(null)
  const projectionViewDataRef = useRef([])
  const [imageParamSources, setImageParamSources] = useState({});
  const [localImageFiles, setLocalImageFiles] = useState({});
  const [showAssetSelector, setShowAssetSelector] = useState(false);
  const [pendingAssetParamId, setPendingAssetParamId] = useState(null);
  const [uploadingImages, setUploadingImages] = useState(false);

  useEffect(() => () => geometry?.dispose?.(), [geometry])

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
        const [loadedGeometry, loadedTexturableMesh] = await Promise.all([
          loadEditableGeometryFromUrl(modelUrl),
          loadTexturableMeshFromUrl(modelUrl).catch(textureError => ({
            root: null,
            textureCanvas: null,
            textureKey: '',
            textureConfig: null,
            supportError: textureError.message || 'Texture editing is unavailable for this mesh.'
          }))
        ])

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

  const selectedTextureWorkflow = useMemo(() => {
    return texturingWorkflows.find(workflow => String(workflow.id) === String(textureWorkflowId)) || null
  }, [textureWorkflowId, texturingWorkflows])

  useEffect(() => {
    setTextureWorkflowInputs(createTexturePaintWorkflowDraft(selectedTextureWorkflow))
  }, [selectedTextureWorkflow])

  const textureWorkflowParameterIds = useMemo(() => {
    return getDefaultTextureWorkflowParameterIds(selectedTextureWorkflow)
  }, [selectedTextureWorkflow])

  const texturingUnavailableReason = useMemo(() => {
    if (geometryRevision > 0) {
      return 'Texture painting works on the original UV mesh. Save and reopen the mesh after topology edits to paint accurately.'
    }

    if (texturableMesh?.supportError) {
      return texturableMesh.supportError
    }

    if (!texturableMesh?.textureCanvas || !texturableMesh?.maskCanvas) {
      return 'Texture painting is unavailable for this mesh.'
    }

    return ''
  }, [geometryRevision, texturableMesh])

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

  const loadAssetAsFile = useCallback(async (asset) => {
    const url = asset.url || (asset.filename ? `http://localhost:3001/assets/${encodeURI(asset.filename)}` : '');
    if (!url) throw new Error('Asset URL not found');
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch asset');
    const blob = await response.blob();
    const fileName = asset.name || 'image.png';
    return new File([blob], fileName, { type: blob.type || 'image/png' });
  }, []);

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
    setLocalImageFiles({});
  }, [selectedTextureWorkflow]);

  const texturingReady = !loading && !texturingUnavailableReason && !!selectedTextureWorkflow && !!displayTextureRef.current && !!maskTextureRef.current

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
      // Nothing visible – just show the original texture
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

    applyPatchBlendToCanvas(
      originalTextureBackupRef.current,
      patchedCanvas,
      texturableMesh.textureCanvas,
      1,
      patchNoise,
      patchSharpness,
      patchSaturation,
      projectionMaskBackupRef.current,
      featherRadius
    )
    updateCanvasTexture(displayTextureRef.current)
    setTextureRevision(current => current + 1)
  }, [patchNoise, patchSharpness, patchSaturation, pendingPatch, projectionOpacities, texturableMesh, featherRadius])

  useEffect(() => {
    void rebuildProjectedTexturePreview()
  }, [rebuildProjectedTexturePreview, projectionOpacities])

  const stats = useMemo(() => ({
    vertices: geometry?.attributes?.position?.count || 0,
    faces: geometryFaceCount(geometry)
  }), [geometry, geometryRevision])
  const availableHoleLoops = useMemo(() => {
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
    if (activeMenu === 'texturing' || !geometry || !cameraRef.current || !canvasShellRef.current) {
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
    if (activeMenu === 'texturing' || !geometry || !cameraRef.current || !canvasShellRef.current) {
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

    event.preventDefault()

    dragStateRef.current = {
      startPoint: nextPoint,
      shiftKey: event.shiftKey,
      pointerId: event.pointerId,
      isDragging: false
    }

    canvasShellRef.current?.setPointerCapture?.(event.pointerId)
  }, [activeMenu, brushSize, getMeshIntersection, getPointerPosition, resetSelection, syncProjectionMaskCanvasSize, texturableMesh, texturingReady])

  const handleCanvasPointerMove = useCallback((event) => {
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
  }, [activeMenu, brushSize, getMeshIntersection, getPointerPosition, texturableMesh])

  const handleCanvasPointerUp = useCallback((event) => {
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
  }, [activeMenu, getPointerPosition, selectAtPoint, selectWithinRectangle])

  const handleCanvasPointerCancel = useCallback(() => {
    if (paintStateRef.current) {
      canvasShellRef.current?.releasePointerCapture?.(paintStateRef.current.pointerId)
      paintStateRef.current = null
    }

    dragStateRef.current = null
    resetSelection()
    setSelectionBox(null)
  }, [resetSelection])

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

  const applyGeometryUpdate = useCallback((nextGeometry, nextHoleLoops = []) => {
    setGeometry(nextGeometry)
    setGeometryRevision(current => current + 1)
    setHoleLoops(nextHoleLoops)
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
    setFeedback('Mesh updated.')
  }, [])

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
    if (!geometry || availableHoleLoops.length === 0) {
      return
    }

    if (selectionMode === 'vertex') {
      const result = bridgeAndFillSelectedHole(geometry, selectedVertexIndices)
      if (result.applied) {
        applyGeometryUpdate(result.geometry, [])
        return
      }
    }

    applyGeometryUpdate(fillHoleLoops(geometry, availableHoleLoops), [])
  }, [applyGeometryUpdate, availableHoleLoops, geometry, selectedVertexIndices, selectionMode])

  const handleSave = useCallback(async (saveMode) => {
    if (!geometry || saving) {
      return
    }

    try {
      setSaving(true)
      setError('')
      setFeedback('Saving mesh...')
      const meshBinary = geometryRevision === 0 && texturableMesh?.root && texturableMesh?.textureCanvas
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
  }, [filePath, geometry, geometryRevision, meshName, modelUrl, navigate, numericAssetId, saveMeshEdit, saving, searchParams, texturableMesh, uploadAssetThumbnail])

  const handleBack = useCallback(() => {
    if (returnTo) {
      navigate(returnTo)
      return
    }

    navigate(-1)
  }, [navigate, returnTo])

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
        const ssSourceCanvas = document.createElement('canvas');
        const ssMaskCanvas = document.createElement('canvas');
        let ssSourceFile = null, ssMaskFile = null;
        if (croppedSource.width > 0 && croppedSource.height > 0) {
          const scale = Math.max(1024 / croppedSource.width, 1024 / croppedSource.height, 1);
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
          }
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
      setError(textureError.message || 'Failed to regenerate the mesh texture.');
      setFeedback('');
    } finally {
      setTexturing(false);
    }
  }, [
    cropPadding, featherRadius, meshName, multiViewCount, nodeId,
    patchNoise, patchSharpness, patchSaturation, projectionOpacities,
    projectId, runComfyWorkflow, selectedTextureWorkflow,
    subscribeToComfyWorkflowProgress, texturableMesh,
    textureWorkflowInputs, texturing, updateProjectNode,
    updateMaskOverlay, imageParamSources
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
  const fillDisabled = availableHoleLoops.length === 0

  return (
    <div className="mesh-editor-layout">
      <Header showSearch onSettingsClick={() => setShowSettings(true)} />
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

          <div className="mesh-editor-workspace">
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
                  >
                    <span className="material-symbols-outlined">texture</span>
                    <span>Texturing</span>
                  </button>
                </div>

                {activeMenu === 'modeling' ? (
                  <>
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
                ) : (
                  <>
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Brush</span>
                      <label className="mesh-editor-range-field">
                        <span>Size</span>
                        <input type="range" min="4" max="96" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
                        <strong>{brushSize}px</strong>
                      </label>
                      <label className="mesh-editor-range-field">
                        <span>Crop margin</span>
                        <input type="range" min="0" max="128" value={cropPadding} onChange={event => setCropPadding(Number(event.target.value))} disabled={!!texturingUnavailableReason || !!pendingPatch} />
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
                )}
              </div>
            </aside>

            <div
              ref={canvasShellRef}
              className={`mesh-editor-canvas-shell ${activeMenu === 'texturing' ? 'mesh-editor-canvas-shell--texturing' : ''}`}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerCancel}
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
                  <Canvas shadows={{ type: THREE.PCFShadowMap }} resize={{ offsetSize: true }} style={{ width: '100%', height: '100%' }}>
                    <PerspectiveCamera makeDefault position={[3, 3, 5]} near={0.0001} far={4000} />
                    <ambientLight intensity={1.25} />
                    <directionalLight position={[5, 7, 9]} intensity={2} castShadow />
                    <directionalLight position={[-5, 3, -4]} intensity={0.6} color="#8ff5ff" />
                    {activeMenu === 'texturing' && texturableMesh?.root && displayTextureRef.current && maskTextureRef.current && !texturingUnavailableReason ? (
                      <TexturedMesh
                        key={textureRevision}
                        root={texturableMesh.root}
                        textureKey={texturableMesh.textureKey}
                        displayTexture={displayTextureRef.current}
                      />
                    ) : (
                      <EditorMesh
                        geometry={geometry}
                        selectedFaceIndices={selectedFaceIndices}
                        selectedVertexIndices={selectedVertexIndices}
                      />
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
                      onCameraReady={camera => { cameraRef.current = camera }}
                      controlsEnabled={activeMenu !== 'texturing' || !hasProjectionMask}
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
            </div>
          </div>
        </section>
      </main>
      {showAssetSelector && (
        <AssetSelectorModal
          assetType="image"
          onSelect={(asset) => {
            if (pendingAssetParamId) {
              handleImageParamSourceChange(pendingAssetParamId, 'asset', asset);
            }
            setShowAssetSelector(false);
            setPendingAssetParamId(null);
          }}
          onClose={() => {
            setShowAssetSelector(false);
            setPendingAssetParamId(null);
          }}
          showEdits
        />
      )}
      <Footer />
    </div>
  )
}
