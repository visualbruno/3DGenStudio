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

function CameraRig({ geometry, frameKey, onCameraReady, controlsEnabled = true }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const [distanceBounds, setDistanceBounds] = useState({ minDistance: 0.001, maxDistance: 100 })
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
  }, [camera, geometry, frameKey])

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
    uploadAssetThumbnail,
    getPaintDocument,
    savePaintDocument
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
  const [meshFrameKey, setMeshFrameKey] = useState(0)
  const [modelingCanUndo, setModelingCanUndo] = useState(false)
  const [modelingCanRedo, setModelingCanRedo] = useState(false)
  const modelingUndoStackRef = useRef([])
  const modelingRedoStackRef = useRef([])
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
        const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

        const rootStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
        const loadedRoot = await loadMeshRootFromUrl(modelUrl)
        const rootLoadedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

        const geometryStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
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

  // Texturing & Painting both require a textured material with valid UVs.
  // While the mesh is still loading we keep the modes enabled (otherwise the
  // tabs would flicker on/off); once loading completes, a missing texture
  // canvas or an explicit support error disables both modes.
  const textureModesSupported = loading
    ? true
    : !!texturableMesh?.textureCanvas && !texturableMesh?.supportError
  const textureModesDisabledReason = textureModesSupported
    ? ''
    : (texturableMesh?.supportError || 'This mesh has no material or UVs, so texturing and painting are unavailable.')

  // If the active tab becomes unsupported after the mesh finishes loading
  // (e.g. a UV-less mesh), fall back to Modeling so the panel stays usable.
  useEffect(() => {
    if (!textureModesSupported && (activeMenu === 'texturing' || activeMenu === 'painting')) {
      setActiveMenu('modeling')
    }
  }, [activeMenu, textureModesSupported])

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

    event.preventDefault()

    dragStateRef.current = {
      startPoint: nextPoint,
      shiftKey: event.shiftKey,
      pointerId: event.pointerId,
      isDragging: false
    }

    canvasShellRef.current?.setPointerCapture?.(event.pointerId)
  }, [activeMenu, applySculptStamp, beginPaintStroke, brushSize, computeSculptCursorPixelRadius, ensureSculptMesh, getMeshIntersection, getPointerPosition, numericAssetId, paintBrushSize, paintColor, paintFlow, paintHardness, paintLayers, paintMode, paintRotation, pendingPatch, pushSculptUndo, resetSelection, sculptBrush, sculptFrontFacesOnly, sculptHardness, sculptSize, sculptStampRotation, sculptSymmetry, selectedLayerId, stampBrushAtUv, syncProjectionMaskCanvasSize, texturableMesh, texturingReady])

  const handleCanvasPointerMove = useCallback((event) => {
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
  }, [activeMenu, applySculptStamp, brushSize, computeSculptCursorPixelRadius, ensureSculptMesh, getMeshIntersection, getPointerPosition, paintBrushSize, paintColor, paintFlow, paintHardness, paintMode, paintRotation, recompositePaintTexture, sculptSpacing, sculptSteadyStroke, sculptStrength, stampBrushAtUv, texturableMesh])

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
            // eslint-disable-next-line no-await-in-loop
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

          <div className={`mesh-editor-workspace ${activeMenu === 'painting' ? 'mesh-editor-workspace--with-layers' : ''}`}>
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
              className={`mesh-editor-canvas-shell ${(activeMenu === 'texturing' || activeMenu === 'painting') ? 'mesh-editor-canvas-shell--texturing' : ''}`}
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
                  <Canvas shadows={{ type: THREE.PCFShadowMap }} resize={{ offsetSize: true }} style={{ width: '100%', height: '100%' }}>
                    <PerspectiveCamera makeDefault position={[3, 3, 5]} near={0.0001} far={4000} />
                    <ambientLight intensity={1.25} />
                    <directionalLight position={[5, 7, 9]} intensity={2} castShadow />
                    <directionalLight position={[-5, 3, -4]} intensity={0.6} color="#8ff5ff" />
                    {(activeMenu === 'texturing' || activeMenu === 'painting') && texturableMesh?.root && displayTextureRef.current && (activeMenu !== 'texturing' || (maskTextureRef.current && !texturingUnavailableReason)) ? (
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
                      frameKey={meshFrameKey}
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
