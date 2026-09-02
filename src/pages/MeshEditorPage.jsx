import { Canvas } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { useNotifications } from '../context/NotificationContext'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import { assetUrl } from '../config'
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
  getGeometryWatertight,
  getSelectedHoleLoops,
  loadEditableGeometryFromObject,
  loadEditableGeometryFromGlbBuffer,
  parseGlbScene,
  extractSkeletonFromObject,
  filterSkeleton,
  translateSkeleton,
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
  buildTexturedMeshObject,
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
  bakeViewToTextureGPU,
  bakeMultiViewTextureGPU,
  isGpuBakeSupported,
  paintProjectionMaskDabGPU,
  solveViewGains
} from '../utils/gpuTextureBake'
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
  filterConnected as sculptFilterConnected,
  filterFrontFacing as sculptFilterFrontFacing,
  filterNeedles as sculptFilterNeedles,
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
import ExportMeshDialog from '../components/ExportMeshDialog';

const AUTO_PROJECTION_SEAM_SAFE_CROP_PX = 0
const AUTO_PROJECTION_SEAM_SAFE_BLEND_PX = 0
// Per-view Brown–Lowe gain compensation recolours each view to equalise tones across
// seams. It inherently shifts the views' ORIGINAL colours (the whole surface tints when
// a second view is added), which is not wanted: every view must keep the colour ComfyUI
// produced. Residual tonal steps between views are handled by the Seam post-process
// instead. The solver is kept available but OFF.
const PROJECTION_GAIN_COMPENSATION = false
// GPU UV-space projection bake (see utils/gpuTextureBake.js and the projection
// analysis). When the platform supports float render targets, each layer is baked
// on the GPU: a native depth-map occlusion test + parallel per-texel projective
// texturing replace the CPU per-texel loop and per-texel BVH raycast. The CPU path
// (accumulateProjectedPatch + finalizeProjectedPatch) stays as the automatic fallback.
const USE_GPU_PROJECTION_BAKE = isGpuBakeSupported()
// Step 0 de-risk from the analysis: stop using the screen-space seam mask (the
// source of the colour leak and the white-gradient bleed at silhouettes). Set this
// back to true only to restore the legacy seam-fade behaviour for comparison.
const PROJECTION_USE_SCREEN_SEAM_MASK = false

import {
  drawProjectionCheckerboard,
  buildProjectionCoverageMaskFromBakedAlpha,
  buildProjectionConfidenceMap,
  applyProjectionEdgeBleed,
  resolveProjectionLayersIntoImageData,
  buildProjectionSurfacePositionMap,
  applySeamPostProcessing,
  fillHolesPostProcessing
} from '../utils/meshProjection'
import {
  getRectangleBounds,
  loadImageElement,
  createBooleanBrushMaskFromImage,
  buildBooleanStampGeometry,
  computeBooleanStampBasis,
  buildBooleanStampMatrix,
  deformGeometryWithBooleanStamp,
  tessellateBooleanDeformationRegion
} from '../utils/meshBooleanGeometry'
import {
  computePaintBrushTexturePx,
  computePaintBrushUvRotationDeg,
  pickGeneratedTextureAsset,
  buildFramedProjectionCamera,
  applyPatchBlendToCanvas,
  createProjectionCropMaskCanvasFromPatch
} from '../utils/meshPaintTexture'
import { viewWorldHeightAt } from '../utils/cameraViewport'
import { isPointerOverViewGizmo } from '../utils/viewGizmoLayout'

import CameraRig from '../components/meshEditor/CameraRig'
import ViewportCameras from '../components/meshEditor/ViewportCameras'
import ViewGizmo from '../components/meshEditor/ViewGizmo'
import EditorMesh from '../components/meshEditor/EditorMesh'
import BooleanPreviewMesh from '../components/meshEditor/BooleanPreviewMesh'
import TexturedMesh from '../components/meshEditor/TexturedMesh'
import ModelingToolsPanel from '../components/meshEditor/ModelingToolsPanel'
import BooleanToolsPanel from '../components/meshEditor/BooleanToolsPanel'
import TexturingToolsPanel from '../components/meshEditor/TexturingToolsPanel'
import ProjectionToolsPanel from '../components/meshEditor/ProjectionToolsPanel'
import { saveWorkflowDefaults } from '../utils/workflowDefaults'
import PaintingToolsPanel from '../components/meshEditor/PaintingToolsPanel'
import AutoUvToolsPanel from '../components/meshEditor/AutoUvToolsPanel'
import AutoRetopoToolsPanel from '../components/meshEditor/AutoRetopoToolsPanel'
import AutoRigToolsPanel from '../components/meshEditor/AutoRigToolsPanel'
import SkeletonOverlay from '../components/meshEditor/SkeletonOverlay'
import SkeletonPanel from '../components/meshEditor/SkeletonPanel'
import AnimatedMeshPreview from '../components/meshEditor/AnimatedMeshPreview'
import BoneMappingModal from '../components/meshEditor/BoneMappingModal'
import MotionLibraryModal from '../components/meshEditor/MotionLibraryModal'
import AnimationEditPanel from '../components/meshEditor/AnimationEditPanel'
import AnimatedSkeletonOverlay from '../components/meshEditor/AnimatedSkeletonOverlay'
import AnimationBoneGizmo from '../components/meshEditor/AnimationBoneGizmo'
import { loadReferenceScene, loadReferenceRigScene, loadTargetScene, autoMapBones, retargetAnimationClip, makeClipInPlace, exportAnimatedGlb, findUpperArmTargets, getReference, withBindPose } from '../utils/animationLibrary'
import { withHandPose } from '../utils/handPose'
import { describeClip, applyFrameEdit, applyFrameOperation, applyFrameRotation, applyFramePosition,
  copyFramePose, pasteFramePose, ensurePositionTrack, ensureRotationTrack, clearFrameValue, clearBoneAnimation, smoothLoopSeam,
  restoreTrackValues, frameTime, flattenFrameRange, shiftFrameRange,
  DEFAULT_EDIT_SCOPE, DEFAULT_EDIT_SPAN } from '../utils/animationEdit'
import { MOCAP_SOURCE_ID, MOCAP_MAX_FRAMES, MOCAP_MIN_FRAMES, MOCAP_ASSUMED_FPS,
  MOCAP_DEFAULT_SECONDS, estimateMocapVram, mocapFramesForSeconds, mocapMaxSeconds,
  detectVideoFps, inspectMocapRig,
  prepareMocapRig, generateMocapClip, mocapIdentityMapping, mocapRigKey,
  forgetMocapRig, MOCAP_BONE_GROUPS } from '../utils/mocapGen'
import { KIMODO_SOURCE_ID, MOTION_SOURCE_MOCAP, countPromptSegments, generateMotionClip,
  loadKimodoSkeletonSource, listSavedMotions, saveMotion, deleteSavedMotion,
  loadSavedMotionClip } from '../utils/motionGen'
import { CUSTOM_SOURCE_ID, buildCustomAnimationDocument, customClipFromDocument,
  customMappingKey, customSourceFromDocument, fetchCustomAnimationDocument, listCustomAnimations,
  mapCustomBones, saveCustomAnimation, deleteCustomAnimation, renameCustomAnimation } from '../utils/customAnimations'
import { parseAnimationFile, buildImportedDocuments } from '../utils/animationImport'
import AnimationLibraryModal from '../components/meshEditor/AnimationLibraryModal'
import OptimizeToolsPanel from '../components/meshEditor/OptimizeToolsPanel'
import GameReadyPanel from '../components/meshEditor/GameReadyPanel'
import SegmentationToolsPanel from '../components/meshEditor/SegmentationToolsPanel'
import ToolModeMenu from '../components/meshEditor/ToolModeMenu'
import BakeToolsPanel from '../components/meshEditor/BakeToolsPanel'
import { autoUv as runAutoUvService, autoRetopo as runAutoRetopoService, optimizeMesh as runOptimizeService, repairMesh as runRepairService, autoRig as runAutoRigService, inspectMesh as runInspectService, segmentMesh as runSegmentService, generateLods, defaultLodRatios, bakeMaps, ensureDesktopService, DEFAULT_AUTO_RIG_OPTIONS, DEFAULT_INSPECT_OPTIONS, DEFAULT_BAKE_OPTIONS, DEFAULT_SIMPLIFY_OPTIONS, DEFAULT_AUTO_UV_OPTIONS, DEFAULT_SEGMENT_OPTIONS } from '../utils/meshTools'
import {
  addSegmentMerge,
  applyBrushFaces,
  applySegmentExplode,
  applySegmentFocus,
  buildPartGeometries,
  computeExplodeDirections,
  clearSegmentFocus,
  clearSegmentPaint,
  computeSegmentLabels,
  countPaintedFaces,
  countSegmentPendingSplits,
  createSegmentDisplayGeometry,
  createSegmentOverrides,
  exportPartsToGlb,
  facesOfPart,
  openSegmentFocus,
  paletteFor as segmentPaletteFor,
  partFaceCounts,
  queryBrushFaces,
  recolorSegmentFaces,
  resetSegmentMerges,
  resetSegmentSplits,
  undoBrushStroke,
  writeSegmentColors
} from '../utils/meshSegment'
import { exportObject3D, measureUvHealth, uvsAreBroken } from '../utils/meshExport'
import { extractRigFromObject, buildRiggedObject, geometryHasSkin, translateRig } from '../utils/meshRig'
import BoneTransformGizmo from '../components/meshEditor/BoneTransformGizmo'
import {
  addChildBone,
  computeRigInfluence,
  deleteRigBones,
  findUnusedBones,
  moveRigBone,
  renameRigBone,
  restoreRigSnapshot,
  rigSkeletonIndices,
  snapshotRig,
  takeWeightsFromParent,
} from '../utils/meshRigEdit'
import {
  applyWeightBrush,
  fillBoneWeight,
  readBoneWeights,
  refreshWeightColors,
  writeWeightColors,
} from '../utils/meshWeightPaint'

// Default option sets for the Python mesh-tools panels. These mirror the
// defaults of autouv.unwrap() and autoretopo.RetopoConfig 1:1 (see
// python-server/app/schemas.py).
const DEFAULT_AUTO_RETOPO_OPTIONS = {
  target_faces: 6000,
  quads: false,
  watertight: true,
  shell_resolution: 256,
  shell_close_iter: 1,
  shell_smooth: 1.4,
  shell_taubin: 10,
  shell_samples_per_pitch: 2,
  max_memory_gb: 4,
  adaptive: true,
  remesh_iters: 10,
  feature_deg: 30,
  calibrate_passes: 1,
  preserve_features: false,
  feature_angle: 25,
  project: true,
  project_iters: 10,
  project_clamp: 1.5,
  relax_strength: 0.4,
  device: 'auto',
  seed: 0,
}

// Non-manifold / topology repair (see python-server/app/schemas.py RepairOptions).
const DEFAULT_REPAIR_OPTIONS = {
  method: 'remove',
  close_holes: true,
  max_hole_size: 30,
  weld: true,
  // Surgical repair that keeps UVs (and so the texture) intact. Off falls back
  // to the pymeshlab rebuild, which is stronger on badly broken meshes but welds
  // across UV seams and discards every UV.
  preserve_uv: true,
}

// How many pre-operation meshes the Bake mode keeps as high-poly sources. Each
// one is a full geometry GLB held in memory, so this is a cap rather than a
// history: at 10, a heavy 300k-face mesh costs on the order of 100 MB if every
// slot is filled with one.
const MAX_BAKE_SOURCES = 10
// Undo depth for the animation edit dock. Each entry holds two copies of one
// track's values (~2 KB for a 4s rotation track), so 100 is a few hundred KB.
const ANIM_EDIT_HISTORY_LIMIT = 100

const DEFAULT_OPTIMIZE_OPTIONS = {
  simplify_ratio: 0.5,
  // Off by default: welding attribute seams is the only way past a seamed mesh's
  // simplification floor, and it scrambles the texture and the hard edges alike.
  // Under-simplifying and saying so beats silently ruining the asset.
  allow_seam_breaking: false,
  // simplify_error / permissive / lock_border / aggressive. The error budget is
  // the knob that reaches most targets, and unlike seam welding it costs nothing
  // in normals or UVs — see DEFAULT_SIMPLIFY_OPTIONS.
  ...DEFAULT_SIMPLIFY_OPTIONS,
}

// ── Projection per-layer mask helpers ───────────────────────────────────────
// A projection layer can carry a user-drawn UV-space mask so the layer's view is
// applied ONLY where the mask is painted. The mask lives in a canvas the same size
// (and pixel layout) as the texture canvas, so its alpha aligns 1:1 with the bake's
// coverageMask — gating happens at composite time, which means the expensive GPU
// bake stays cached and only the light composite re-runs while drawing (realtime).

// Paint (or erase) a stroke into a layer's mask canvas, mapping UV→canvas and
// clipping to the hit UV island (same convention as drawUvStroke). Erase uses
// destination-out so painted coverage is subtracted.
function stampProjectionMaskStroke(maskCanvas, fromUv, toUv, radius, islandPath, erase, textureConfig) {
  if (!maskCanvas || !fromUv || !toUv) {
    return
  }
  const context = maskCanvas.getContext('2d', { willReadFrequently: true }) || maskCanvas.getContext('2d')
  const startPoint = mapUvToCanvasPoint(fromUv, maskCanvas.width, maskCanvas.height, textureConfig)
  const endPoint = mapUvToCanvasPoint(toUv, maskCanvas.width, maskCanvas.height, textureConfig)

  context.save()
  // Clip to the UV island ONLY when the stamp point is provably inside it. On
  // meshes with mirrored/overlapping UVs the island path can wind such that the
  // hit point reads as outside its own island; clipping there would erase the
  // whole stamp (→ an empty mask, i.e. nothing visibly happens). Falling back to
  // an unclipped stamp guarantees the mask is painted. A little cross-chart bleed
  // is harmless here: gating only takes effect where the layer already has baked
  // coverage, so mask pixels on faces this view never projected do nothing.
  if (islandPath && context.isPointInPath(islandPath, endPoint.x, endPoint.y)) {
    context.clip(islandPath)
  }
  context.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
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

// Read a layer's mask canvas into a cached per-texel alpha array (0..255) aligned
// to the texture/coverage layout. Returns null when the layer has no mask canvas
// or the mask is empty (all transparent) — in both cases the layer applies its
// whole view, i.e. the default behaviour. Recomputes only when marked dirty.
function refreshLayerMaskAlpha(layerData) {
  const canvas = layerData?.maskCanvas
  if (!canvas) {
    return null
  }
  if (!layerData.maskDirty && layerData.maskAlpha) {
    return layerData.maskHasPixels ? layerData.maskAlpha : null
  }
  const context = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d')
  const { width, height } = canvas
  const data = context.getImageData(0, 0, width, height).data
  const count = width * height
  const alpha = layerData.maskAlpha && layerData.maskAlpha.length === count
    ? layerData.maskAlpha
    : new Uint8Array(count)
  let hasPixels = false
  for (let i = 0; i < count; i += 1) {
    const a = data[i * 4 + 3]
    alpha[i] = a
    if (a > 0) {
      hasPixels = true
    }
  }
  layerData.maskAlpha = alpha
  layerData.maskHasPixels = hasPixels
  layerData.maskDirty = false
  return hasPixels ? alpha : null
}

// Gate a baked layer snapshot by a mask-alpha array, returning COPIES (the cached
// snapshot is never mutated). Texels with alpha 0 are dropped from the layer's
// coverage so lower layers / the base show through; partial alpha scales the
// texel's opacity for a soft mask edge.
function gateProjectionSnapshotByMask(snapshot, maskAlpha) {
  if (!maskAlpha || !snapshot?.coverageMask || !snapshot?.pixelData) {
    return snapshot
  }
  const count = snapshot.coverageMask.length
  const coverage = new Uint8Array(count)
  const ownership = snapshot.ownershipMask ? new Uint8Array(count) : null
  const confidence = snapshot.confidenceMap ? new Float32Array(count) : null
  const pixelData = new Uint8ClampedArray(snapshot.pixelData)
  for (let i = 0; i < count; i += 1) {
    const m = maskAlpha[i]
    if (m > 0 && snapshot.coverageMask[i]) {
      coverage[i] = 1
      if (ownership) ownership[i] = snapshot.ownershipMask[i]
      if (confidence) confidence[i] = snapshot.confidenceMap[i]
      if (m < 255) {
        pixelData[i * 4 + 3] = Math.round((pixelData[i * 4 + 3] || 0) * (m / 255))
      }
    } else {
      pixelData[i * 4 + 3] = 0
    }
  }
  return { ...snapshot, coverageMask: coverage, ownershipMask: ownership, confidenceMap: confidence, pixelData }
}

// World-space radius for a mask brush of `brushSizePx` screen pixels at the hit
// point — so the GPU 3D-gated dab covers a footprint that matches the on-screen
// cursor regardless of zoom/distance.
function computeProjectionMaskWorldRadius(intersection, camera, canvasHeight, brushSizePx) {
  if (!camera || !intersection?.point) {
    return 0.05
  }
  const distance = camera.position.distanceTo(intersection.point)
  const worldPerPixel = viewWorldHeightAt(camera, distance) / Math.max(1, canvasHeight)
  return Math.max(1e-4, (brushSizePx / 2) * worldPerPixel)
}

// Diagonal white/grey hatch used for the live mask-draw preview (instead of a flat
// white fill). Built once: a small tile of a white band over a grey band that, once
// the pattern is rotated 45°, repeats into diagonal stripes.
let maskStripeTile = null
function getMaskStripeTile() {
  if (maskStripeTile) {
    return maskStripeTile
  }
  const period = 10
  const tile = document.createElement('canvas')
  tile.width = period
  tile.height = period
  const ctx = tile.getContext('2d')
  ctx.fillStyle = '#686868'
  ctx.fillRect(0, 0, period, period)
  ctx.fillStyle = '#333333'
  ctx.fillRect(0, 0, period, period / 2)
  maskStripeTile = tile
  return tile
}
function createMaskStripePattern(ctx) {
  const pattern = ctx.createPattern(getMaskStripeTile(), 'repeat')
  if (pattern?.setTransform && typeof DOMMatrix !== 'undefined') {
    pattern.setTransform(new DOMMatrix().rotate(45))
  }
  return pattern
}

export default function MeshEditorPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    getComfyWorkflows,
    updateComfyWorkflow,
    runComfyWorkflow,
    cancelComfyWorkflow,
    saveMeshEdit,
    subscribeToComfyWorkflowProgress,
    updateProjectNode,
    uploadAssetThumbnail,
    getAssetRecord,
    getPaintDocument,
    savePaintDocument
  } = useProjects()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [showShadows, setShowShadows] = useState(false)
  const [displayMode, setDisplayMode] = useState('pbr')
  const [showWireframe, setShowWireframe] = useState(false)
  // Viewport projection. Perspective is the only safe default: Texturing and
  // Projection bake THROUGH this camera and their framing math is perspective-only
  // (see `cameraLockedToPerspective` below).
  const [orthographic, setOrthographic] = useState(false)
  const [activeMenu, setActiveMenu] = useState('modeling')
  const [geometry, setGeometry] = useState(null)
  const [texturableMesh, setTexturableMesh] = useState(null)
  const [textureRevision, setTextureRevision] = useState(0)
  // Resolution used when a UV-only mesh (no baked texture) starts from a blank
  // texture, so painting/texturing/projection can be enabled.
  const [blankTextureSize, setBlankTextureSize] = useState(1024)
  const [contextRevision, setContextRevision] = useState(0)
  const [comfyLoading, setComfyLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [textureWorkflowId, setTextureWorkflowId] = useState('')
  const [textureWorkflowInputs, setTextureWorkflowInputs] = useState({})
  const [textureSetAsDefault, setTextureSetAsDefault] = useState(false)
  const [projectionWorkflowId, setProjectionWorkflowId] = useState('')
  const [projectionWorkflowInputs, setProjectionWorkflowInputs] = useState({})
  const [projectionSetAsDefault, setProjectionSetAsDefault] = useState(false)
  const [projectionImageParamSources, setProjectionImageParamSources] = useState({})
  const [projectionStarted, setProjectionStarted] = useState(false)
  const [projectionKeepTexture, setProjectionKeepTexture] = useState(false)
  const [projecting, setProjecting] = useState(false)
  // The ComfyUI run in flight, so Texturing and Projection can stop it. Only one
  // runs at a time — Texturing's multi-view pass runs its views in sequence, so
  // this holds whichever view is currently with ComfyUI.
  const [comfyRunPromptId, setComfyRunPromptId] = useState(null)
  const [comfyRunCancelling, setComfyRunCancelling] = useState(false)
  // Read inside the progress subscriptions, which close over their own render's
  // state: without it ComfyUI's next progress line would overwrite "Cancelling…".
  const comfyRunCancellingRef = useRef(false)
  // Survives view boundaries: Texturing sends one ComfyUI run per view, so a
  // cancel that lands between two views has to stop the whole pass rather than
  // being forgotten when the next view starts.
  const comfyRunCancelRequestedRef = useRef(false)
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
  // Auto UV / Auto Retopo (Python mesh-tools service)
  const [autoUvOptions, setAutoUvOptions] = useState(DEFAULT_AUTO_UV_OPTIONS)
  const [autoRetopoOptions, setAutoRetopoOptions] = useState(DEFAULT_AUTO_RETOPO_OPTIONS)
  const [autoUvRunning, setAutoUvRunning] = useState(false)
  const [autoRetopoRunning, setAutoRetopoRunning] = useState(false)
  const [autoUvResult, setAutoUvResult] = useState(null)
  const [autoRetopoResult, setAutoRetopoResult] = useState(null)
  const [autoUvProgress, setAutoUvProgress] = useState(null)
  const [autoRetopoProgress, setAutoRetopoProgress] = useState(null)
  // Auto Rig (SkinTokens/TokenRig) — dedicated rigging service.
  const [autoRigOptions, setAutoRigOptions] = useState(DEFAULT_AUTO_RIG_OPTIONS)
  const [autoRigRunning, setAutoRigRunning] = useState(false)
  const [autoRigProgress, setAutoRigProgress] = useState(null)
  const [autoRigResult, setAutoRigResult] = useState(null)
  const [autoRigSaving, setAutoRigSaving] = useState(false)
  // Skeleton overlay: the rig of the currently-loaded mesh (if it arrived rigged)
  // or of the freshly-generated rig result. `showSkeleton` toggles its visibility.
  const [skeleton, setSkeleton] = useState(null)
  const [showSkeleton, setShowSkeleton] = useState(true)
  // Label every joint in the viewport, not just the selected one. Off by default:
  // on a dense rig the labels cover the mesh, so it is a look-up mode you turn on
  // to read the naming convention, not a permanent overlay.
  const [showBoneNames, setShowBoneNames] = useState(false)
  // The real rig (bones + inverse bind matrices), kept out of React state
  // because it is a scene graph that never re-renders. `rigDropped` records that
  // an edit destroyed the per-vertex weights, so saving can no longer carry it.
  const rigRef = useRef(null)
  const [rigDropped, setRigDropped] = useState(false)
  // Index of the bone selected in the Skeleton panel / by clicking it on the mesh
  // (null = none). Highlighted in the viewport by SkeletonOverlay.
  const [selectedBone, setSelectedBone] = useState(null)
  // Bone editing (Skeleton panel → "Edit"): fixing what Auto Rig got wrong by
  // moving joints, renaming and deleting bones. Its undo stack is separate from
  // the modeling one because a rig edit spans two things that have to travel
  // together — the bone graph in rigRef and the skin weights on the geometry —
  // and restoring one without the other yields a rig that describes nothing.
  const [rigEditing, setRigEditing] = useState(false)
  const [rigEditDirty, setRigEditDirty] = useState(false)
  const [rigMoveChildren, setRigMoveChildren] = useState(false)
  const [rigCanUndo, setRigCanUndo] = useState(false)
  const [rigCanRedo, setRigCanRedo] = useState(false)
  const [rigRevision, setRigRevision] = useState(0)
  const rigUndoStackRef = useRef([])
  const rigRedoStackRef = useRef([])
  const rigBaselineRef = useRef(null)      // rig as it was when editing began (Revert)
  const rigGizmoDragRef = useRef(false)    // suppresses bone picking mid-drag
  // Net edits away from the baseline. The undo stack is capped, so its emptiness
  // stops meaning "unchanged" after 20 edits; this counter still does.
  const rigEditCountRef = useRef(0)
  // Names of bones added by hand this session, so the unused-bone sweep doesn't
  // offer to delete a bone the user has only just created.
  const rigAddedBonesRef = useRef(new Set())

  // --- Weight painting (Auto Rig panel → "Paint Weights") ---------------------
  // The other half of fixing a bad rig: correcting which vertices a bone moves,
  // rather than where the bone is. Shares the rig undo stack and the `selectedBone`
  // selection with bone editing, and is mutually exclusive with it so the bone
  // gizmo never competes with the brush for the same drag.
  const [weightPainting, setWeightPainting] = useState(false)
  const [weightBrush, setWeightBrush] = useState('add')
  const [weightSize, setWeightSize] = useState(0.1)
  const [weightSizeRange, setWeightSizeRange] = useState({ min: 0.002, max: 1 })
  const [weightStrength, setWeightStrength] = useState(0.5)
  const [weightHardness, setWeightHardness] = useState(0.5)
  const [weightTarget, setWeightTarget] = useState(1)
  const [weightFrontOnly, setWeightFrontOnly] = useState(true)
  const [weightConnectedOnly, setWeightConnectedOnly] = useState(true)
  const [weightNormalize, setWeightNormalize] = useState(true)
  const [weightCursor, setWeightCursor] = useState(null)   // { x, y, pixelRadius } or null
  const weightStrokeRef = useRef(null)                     // { pointerId, lastScreen, accumulated }
  const weightStrokeKeysRef = useRef({ ctrl: false, shift: false })
  // The heatmap: the selected bone's weight per vertex, plus the display geometry
  // carrying the colours. Refs, not state — a dab rewrites them and lets
  // frameloop="always" re-upload, with no React work per stroke.
  //
  // The colour attribute is deliberately NOT cached separately. Holding it in its
  // own ref gave the mesh two sources of truth for "the thing being drawn", and
  // any render whose result React discarded (StrictMode renders twice) left the
  // ref pointing at a buffer nothing would ever display — a solid black mesh.
  // Reading it back off the geometry cannot drift.
  const weightValuesRef = useRef(null)
  const weightPaintGeometryRef = useRef(null)
  const weightColors = () => weightPaintGeometryRef.current?.attributes?.color || null

  // --- Auto Rig → Animations (mesh2motion reference clips retargeted onto the mesh) ---
  const [animReferenceId, setAnimReferenceId] = useState('')
  const [animMapping, setAnimMapping] = useState(null)      // { [targetBone]: sourceBone } once saved
  const [animClips, setAnimClips] = useState([])            // [{ name }] for the selected reference
  const [selectedAnimation, setSelectedAnimation] = useState(null)
  const [showBoneMapping, setShowBoneMapping] = useState(false)
  const [boneMapSkeletons, setBoneMapSkeletons] = useState(null)  // { source, target } skeleton data for the mapping 3D views
  const [animLoading, setAnimLoading] = useState(false)
  const [animError, setAnimError] = useState(null)
  const [animRetargeting, setAnimRetargeting] = useState(null)   // clip name currently retargeting
  const [animPreview, setAnimPreview] = useState(null)           // { scene, skinnedMesh, clip, floorOffset }
  const [animAlignFloor, setAnimAlignFloor] = useState(true)     // sit the animated mesh on the grid
  // Pose the mesh like the reference rig before measuring the retarget deltas, so
  // a mesh modelled with its legs/arms apart doesn't keep that stance through the
  // whole clip. On by default; off keeps the mesh's own rest stance.
  const [animMatchRestPose, setAnimMatchRestPose] = useState(true)
  // Strip the clip's horizontal travel at bake time so it plays on the spot. A
  // property of the BAKE, not of the motion: the source clip keeps its travel, so
  // this can be turned on and off for any clip, however it was produced.
  const [animInPlace, setAnimInPlace] = useState(false)
  // --- Animation edit dock (Phase 1) ---
  // Frame-level correction of the RETARGETED clip: the dock pauses the preview,
  // holds it at `animEditFrame`, and edits the clip object the mixer is already
  // playing, so a change lands on the mesh without a rebake. An edited clip becomes
  // AUTHORITATIVE — `editedClipsRef` outlives the bake cache, which every bake
  // toggle clears — and only a rig/mapping change or an explicit Revert drops it.
  const [animEditOpen, setAnimEditOpen] = useState(false)
  const [animPlaying, setAnimPlaying] = useState(true)
  const [animEditFrame, setAnimEditFrame] = useState(0)
  const [animEditBone, setAnimEditBone] = useState(null)          // bone NAME, not index
  // Which gizmo the selected bone carries in the viewport. Right-clicking a bone
  // toggles it, so the mode can be changed without leaving the mesh.
  const [animEditGizmoMode, setAnimEditGizmoMode] = useState('rotate')
  const [animEditScope, setAnimEditScope] = useState(DEFAULT_EDIT_SCOPE)
  const [animEditSpan, setAnimEditSpan] = useState(DEFAULT_EDIT_SPAN)
  // How many frames the loop transition is spread over. 1 = rewrite only the last
  // frame; more is smoother but bends more of the tail towards the start pose, which
  // reads as the motion briefly running backwards when the tail was heading the other
  // way. Deliberately separate from `animEditSpan` (the value-edit falloff).
  const [animSeamFrames, setAnimSeamFrames] = useState(1)
  const [animEditRevision, setAnimEditRevision] = useState(0)     // the clip mutates in place
  const [animEditedClips, setAnimEditedClips] = useState(() => new Set())
  // Copied frame pose: the values live in a ref (they are only read on paste), the
  // label in state so the Paste button can enable itself and say what it holds.
  const [animPoseLabel, setAnimPoseLabel] = useState(null)
  const [animEditUndoCount, setAnimEditUndoCount] = useState(0)
  const [animEditRedoCount, setAnimEditRedoCount] = useState(0)
  const [animArmExtension, setAnimArmExtension] = useState(0)    // Expand/Contract arms (%)
  const [animArmTargets, setAnimArmTargets] = useState(null)     // { left:[], right:[] } upper-arm target bones
  const [checkedAnimations, setCheckedAnimations] = useState(() => new Set())  // clip names ticked for Save
  const [animSaving, setAnimSaving] = useState(false)            // exporting/saving the animated mesh
  // --- Bone mappings stored WITH the mesh -----------------------------------
  // Mapping a reference skeleton onto a rig is a minute of careful work and it is
  // valid for as long as the rig is, so it is kept in the asset's metadata rather
  // than thrown away with the page: { [sourceKey]: { [targetBone]: sourceBone } },
  // where sourceKey is the animation source ('human', 'kimodo', 'custom:<rig>'…).
  //
  // A ref as well as state because Save reads it from callbacks that must not be
  // rebuilt (and re-memoised down the tree) every time a mapping changes.
  const [storedBoneMappings, setStoredBoneMappings] = useState(null)
  const storedBoneMappingsRef = useRef(null)
  // True once a mapping has been made or changed but not yet written to the mesh —
  // the panel says so, because the only thing that persists it is a save.
  const [boneMappingsDirty, setBoneMappingsDirty] = useState(false)
  // The current mapping came back off the mesh rather than from the modal or the
  // auto-matcher. Worth saying: the clips simply appear, and without a word about
  // why, a mapping that was silently reused looks like one that was guessed.
  const [boneMappingRestored, setBoneMappingRestored] = useState(false)

  // --- Auto Rig → Custom animations (hand-edited clips, reusable on any mesh) ---
  // The library rows only (no clip data): applying one fetches its document, which
  // carries the skeleton it was authored on and becomes the source rig.
  const [customAnimations, setCustomAnimations] = useState([])
  const [customLibLoading, setCustomLibLoading] = useState(false)
  const [customLibError, setCustomLibError] = useState(null)
  // The picker popup, and the file being imported through it. A dropdown was the
  // first shape of this and did not survive contact with the point of the feature:
  // a marketplace pack is dozens of clips, which needs search, multi-select and
  // somewhere to put an import button.
  const [customLibOpen, setCustomLibOpen] = useState(false)
  const [customBusyId, setCustomBusyId] = useState(null)
  // A parsed file's CONTENTS, before anything is written: the user picks which of
  // its clips to keep. The scenes stay in a ref — they carry whole skeletons (and
  // sometimes a character mesh) and have no business in React state.
  const [customParsed, setCustomParsed] = useState(null)
  const [customImporting, setCustomImporting] = useState(false)
  const [customImportProgress, setCustomImportProgress] = useState(null)
  const customParsedRef = useRef([])
  const [customApplying, setCustomApplying] = useState(false)
  const [customSavingClip, setCustomSavingClip] = useState(false)
  const [customSavedNotice, setCustomSavedNotice] = useState(null)
  const [customAutoMapped, setCustomAutoMapped] = useState(false)
  // The rig the animations in the source slot were authored on. Two animations
  // that share it share a bone mapping, so a second one can be added to the slot
  // without asking the user to map anything again.
  const customRigKeyRef = useRef(null)

  // --- Auto Rig → Kimodo (text-to-motion) ---
  // Kimodo shares the Animations pipeline above rather than duplicating it: a
  // generated clip becomes a clip on animSourceRef, is retargeted by the same
  // code and saved by the same button. What is Kimodo-specific is only the
  // prompt form and the fact that its source rig is the SOMA-77 skeleton, which
  // occupies the same single source slot a mesh2motion reference would.
  const [kimodoPrompt, setKimodoPrompt] = useState('')
  const [kimodoDuration, setKimodoDuration] = useState(5)
  const [kimodoRunning, setKimodoRunning] = useState(false)
  const [kimodoProgress, setKimodoProgress] = useState(null)
  const [kimodoError, setKimodoError] = useState(null)
  // The bone map was produced automatically rather than confirmed by the user, so
  // the panel can suggest checking it if the motion comes out wrong.
  const [kimodoAutoMapped, setKimodoAutoMapped] = useState(false)
  // The saved-motion library: catalogue rows only (no BVH), fetched when the
  // Kimodo tab takes the source slot. Global, not per-project.
  const [motionLibrary, setMotionLibrary] = useState([])
  const [motionLibLoading, setMotionLibLoading] = useState(false)
  const [motionLibError, setMotionLibError] = useState(null)
  // Whichever row is mid-apply or mid-delete, so only that one shows a spinner.
  const [motionLibBusyId, setMotionLibBusyId] = useState(null)
  // A batch (apply or delete several) is in flight; `progress` drives the count
  // in the picker's footer, which is the only feedback a 20-motion apply gives.
  const [motionLibBusy, setMotionLibBusy] = useState(false)
  const [motionLibProgress, setMotionLibProgress] = useState(null)
  const [motionLibOpen, setMotionLibOpen] = useState(false)
  // Finger curl (%) per hand, baked into generated clips as a constant pose —
  // Kimodo never animates fingers, so without this a punch lands with an open
  // hand. Per-hand because a punch usually wants one fist and one open guard.
  const [handCurl, setHandCurl] = useState({
    left: 0, right: 0, leftThumb: 0, rightThumb: 0,
    // Which local axis the thumb folds about. 'auto' infers it from the rig;
    // inference proved unreliable across rigs, so the axis is selectable.
    thumbAxis: 'auto', thumbFlip: false,
  })
  const kimodoCounterRef = useRef(0)   // makes generated clip names unique per session

  const animSourceRef = useRef(null)   // loaded reference: { scene, skinnedMesh, boneNames, clips, hipName }
  const animTargetRef = useRef(null)   // loaded target skinned mesh: { scene, skinnedMesh, boneNames }
  const retargetedClipsRef = useRef(new Map())  // clipName -> retargeted THREE.AnimationClip (cache)
  const editedClipsRef = useRef(new Map())     // clipName -> hand-edited clip (survives cache clears)
  // Undo history per clip, so undo can never reach into a clip you are not looking
  // at: { clipName -> { undo: [op], redo: [op] } }, op = { trackName, before, after }.
  const animEditHistoryRef = useRef(new Map())
  // What the animated skeleton overlay drew on the last frame: { names, positions }.
  // The bone picker hit-tests THIS while an animation is playing — the rest-pose
  // joints it uses otherwise are somewhere else entirely once the mesh moves.
  const liveJointsRef = useRef(null)
  const animPoseRef = useRef(null)   // { frame, tracks } from copyFramePose
  // The clip the gizmo is writing to, and the snapshot taken when its drag began.
  // Both are refs because a drag delivers dozens of events between renders: reading
  // the clip out of a closure would write to whatever object that render captured,
  // and pushing an undo entry per event would bury the history.
  const animClipRef = useRef(null)
  const animGizmoDragRef = useRef(null)
  // Scratch for the world->local conversion, which runs on every drag event.
  const gizmoMatrixRef = useRef(new THREE.Matrix4())
  const gizmoQuatRef = useRef(new THREE.Quaternion())
  // Edits are bound to the target rig and the bone mapping that produced them, so
  // when either changes they are not "stale", they are meaningless. Declared here,
  // beside the refs it clears, because the callbacks that call it are defined
  // further up the body than the rest of the dock's handlers.
  const resetAnimEdits = useCallback(() => {
    animPoseRef.current = null
    setAnimPoseLabel(null)
    editedClipsRef.current.clear()
    animEditHistoryRef.current.clear()
    setAnimEditUndoCount(0)
    setAnimEditRedoCount(0)
    setAnimEditedClips(prev => (prev.size ? new Set() : prev))
  }, [])
  // The rigged GLB blob returned by the service, kept for Save-as-version / download.
  const riggedBlobRef = useRef(null)
  // Whether the live rig came from the last Auto Rig result (adopted) or the
  // service blob is still the only copy of it.
  const rigResultAdoptedRef = useRef(true)
  // Watertight check (Auto Retopo panel) — runs on demand via a button.
  const [watertightChecking, setWatertightChecking] = useState(false)
  const [watertightResult, setWatertightResult] = useState(null)
  // Non-manifold / topology repair (Auto Retopo panel) — Python mesh-tools service.
  const [repairOptions, setRepairOptions] = useState(DEFAULT_REPAIR_OPTIONS)
  const [repairRunning, setRepairRunning] = useState(false)
  const [repairResult, setRepairResult] = useState(null)
  const [repairProgress, setRepairProgress] = useState(null)
  const [optimizeOptions, setOptimizeOptions] = useState(DEFAULT_OPTIMIZE_OPTIONS)
  const [optimizeRunning, setOptimizeRunning] = useState(false)
  const [optimizeResult, setOptimizeResult] = useState(null)
  const [optimizeProgress, setOptimizeProgress] = useState(null)
  // LOD ladder built from the current mesh. `lodSourceFaces` records what it was
  // built from so the panel can flag the numbers as stale after further edits
  // instead of showing figures that quietly stopped being true.
  const [lodLevels, setLodLevels] = useState(4)
  const [lodChain, setLodChain] = useState([])
  const [lodSourceFaces, setLodSourceFaces] = useState(0)
  const [lodGenerating, setLodGenerating] = useState(false)
  const [lodProgress, setLodProgress] = useState(null)
  // ── Bake ────────────────────────────────────────────────────────────────
  // Snapshots of the mesh as it was *before* each tool ran, newest first, so a
  // bake can sample the detail Retopo/Optimize removed. Capped because each one
  // is a full GLB in memory.
  const [bakeSources, setBakeSources] = useState([])
  const [bakeSourceId, setBakeSourceId] = useState('')
  const [bakeOptions, setBakeOptions] = useState(DEFAULT_BAKE_OPTIONS)
  const [bakeRunning, setBakeRunning] = useState(false)
  const [bakeProgress, setBakeProgress] = useState(null)
  const [bakeSourceLoading, setBakeSourceLoading] = useState(false)
  const [showBakeSourceSelector, setShowBakeSourceSelector] = useState(false)
  const [bakedMaps, setBakedMaps] = useState(null)
  // Baked maps assigned to the mesh, kept so the export paths can reattach them
  // to whatever material they build.
  const appliedMapsRef = useRef({})
  // Game-Ready check (read-only analysis) — no result/undo state, it never edits.
  const [gameReadyOptions, setGameReadyOptions] = useState(DEFAULT_INSPECT_OPTIONS)
  const [gameReadyRunning, setGameReadyRunning] = useState(false)
  const [gameReadyReport, setGameReadyReport] = useState(null)
  // Set by a fix that edits the mesh, so the check re-runs once the new geometry
  // has actually landed in state rather than against the pre-fix closure.
  const pendingGameReadyRecheckRef = useRef(false)
  // Smart Segmentation. `segmentation` is the hierarchy the service returned —
  // analysed once — and `segmentParts` is which level of it is on screen. Moving
  // the slider only replays the hierarchy locally, so it never touches the
  // service and is deliberately not gated on `segmentRunning`.
  const [segmentOptions, setSegmentOptions] = useState(DEFAULT_SEGMENT_OPTIONS)
  const [segmentRunning, setSegmentRunning] = useState(false)
  const [segmentProgress, setSegmentProgress] = useState(null)
  const [segmentation, setSegmentation] = useState(null)
  const [segmentParts, setSegmentParts] = useState(8)
  const [segmentMinPartFaces, setSegmentMinPartFaces] = useState(4)
  const [segmentExporting, setSegmentExporting] = useState(false)
  // Hand corrections layered over the analysis (brush / merge / split). Held in
  // state so the label memo re-runs, but the arrays inside are mutated in place —
  // copying a per-face Int32Array on every brush dab would stall the stroke. A
  // change therefore publishes a shallow clone rather than a new object.
  const [segmentOverrides, setSegmentOverrides] = useState(null)
  const [segmentTool, setSegmentTool] = useState('none')   // none | brush | merge | focus
  const [segmentTargetFace, setSegmentTargetFace] = useState(-1)
  const [segmentMergePicks, setSegmentMergePicks] = useState([])
  const [segmentBrushSize, setSegmentBrushSize] = useState(0)
  const [segmentBrushSizeRange, setSegmentBrushSizeRange] = useState({ min: 0.002, max: 1 })
  const [segmentCursor, setSegmentCursor] = useState(null)  // { x, y, pixelRadius } or null
  const [segmentCanUndo, setSegmentCanUndo] = useState(false)
  // Inspection only: the parts are pushed apart on the display geometry, never on
  // the editable mesh, so nothing here reaches an export.
  const [segmentExplode, setSegmentExplode] = useState(0)
  const segmentOverridesRef = useRef(null)
  const segmentStrokeRef = useRef(null)
  const segmentUndoStackRef = useRef([])
  // Scratch buffers reused by every dab: the candidate list the BVH fills, and
  // the per-stroke "already recorded" flags behind the undo entry.
  const segmentBrushFacesRef = useRef(null)
  const segmentTouchedRef = useRef(null)
  // The canvas pointer callbacks are declared thousands of lines ABOVE the
  // segmentation section, so they cannot name any of it in a dependency array —
  // that reads the binding before initialisation, the same trap documented on
  // pushRigSnapshotRef. They go through these instead, which also spares those
  // very large callbacks from being rebuilt every time a tool is armed.
  const segmentToolRef = useRef('none')
  const segmentationRef = useRef(null)
  const segmentTargetFaceRef = useRef(-1)
  const segmentActionsRef = useRef({})
  // Snapshot of the texturable-mesh state from just before a mesh tool ran, so
  // "Revert" can restore the original texture/UVs alongside the geometry undo.
  const preToolTexturableRef = useRef(null)
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
  const [showExport, setShowExport] = useState(false)
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
  // Per-texel UV-island occupancy (1 = belongs to some chart). Computed by the GPU
  // bake and reused so the final composite gutter dilation only fills empty gutters,
  // never bleeds a view's colour across a thin gutter onto a neighbouring island.
  const projectionUvOccupancyRef = useRef(null)
  // Per-texel 3D world position of the UV layout (from buildProjectionSurfacePositionMap),
  // cached for the projection session. Lets the keep-texture base feather seed only at
  // genuine 3D silhouette edges instead of every UV-island boundary. Built lazily and
  // keyed by mesh + texture size so the live (per-mask-paint) compose reuses it.
  const projectionSurfacePositionsRef = useRef(null)
  const projectionFaceOwnershipRef = useRef(new Map())
  const projectionLayerDataRef = useRef(new Map())
  const projectionLayerCounterRef = useRef(0)
  const projectionRebuildTokenRef = useRef(0)
  const projectionBaseTextureRef = useRef(null)
  // --- Projection per-layer mask drawing state ---
  // Id of the layer whose mask is currently being drawn on the mesh (null = off).
  const [projectionMaskEditLayerId, setProjectionMaskEditLayerId] = useState(null)
  const [projectionMaskErase, setProjectionMaskErase] = useState(false)
  const [projectionMaskBrushSize, setProjectionMaskBrushSize] = useState(40)
  // Cursor ring is positioned via direct DOM (ref), NOT React state: a brush stroke
  // fires many pointer-moves, and re-rendering this huge page per move makes the ring
  // visibly lag seconds behind the pointer. The ref update is synchronous and free.
  const projectionMaskCursorRef = useRef(null)
  const projectionMaskStrokeRef = useRef(null)
  // Last gains solved by a full rebuild, reused by the live (cached) compose so the
  // colours don't shift while painting a mask.
  const projectionViewGainsRef = useRef(null)
  // Throttle guard for the GPU mask brush dab (coalesces pointer moves to one
  // dab + preview per animation frame).
  const projectionMaskPaintRef = useRef({ scheduled: false })
  // Snapshot of the composited texture taken when a mask stroke begins. While the
  // stroke is in progress we draw the painted mask as a cheap translucent-white
  // overlay on TOP of this snapshot (no expensive compose), then restore + apply
  // the real composite once on release.
  const maskPreviewBaseRef = useRef(null)
  // Reusable offscreen canvas holding the striped hatch clipped to the painted mask.
  const maskPreviewVeilRef = useRef(null)
  // True while a released mask stroke (or a Clear) is being applied: shows an
  // animated "applying" veil and blocks starting another stroke / clearing until
  // the compose finishes.
  const [maskApplying, setMaskApplying] = useState(false)
  const maskApplyingRef = useRef(false)
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

  const cycleDisplayMode = () => {
    setDisplayMode(current => {
      if (current === 'pbr') return 'albedo'
      if (current === 'albedo') return 'sculpt'
      return 'pbr'
    })
  }

  // Texturing and Projection are the two modes that PROJECT through the viewport
  // camera rather than merely looking through it: `buildFramedProjectionCamera` fits
  // the mesh with tan(fov/2) (an orthographic camera has no fov and never gets its
  // frustum refit), `createProjectionRenderCamera` re-aims only `aspect` (which
  // orthographic cameras do not have, so a square render target would come out
  // stretched), and the GPU bake shader derives its per-texel view direction as
  // `normalize(uProjectorPos - worldPos)` — true for a perspective projector, wrong
  // for a parallel one. Any of those alone misregisters the ComfyUI render against
  // the texture it is baked back into, so these modes stay on perspective.
  const cameraLockedToPerspective = activeMenu === 'texturing' || activeMenu === 'projection'

  // Texturing with a mask on screen freezes the camera: the mask is painted in
  // SCREEN space against the current view, so orbiting would slide it off the mesh.
  // The view cube is hidden along with orbiting — a snap-to-face is exactly the kind
  // of camera move that would invalidate the mask.
  const orbitEnabled = activeMenu !== 'texturing' || !hasProjectionMask

  useEffect(() => {
    if (cameraLockedToPerspective && orthographic) {
      setOrthographic(false)
      setFeedback('Switched back to a perspective view — Texturing and Projection project through the viewport camera.')
    }
  }, [cameraLockedToPerspective, orthographic])

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
            ? assetUrl(paintBrushAsset.filename)
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
    // Clip to the UV island only when the stamp point actually lies inside it.
    // On some meshes the island path doesn't contain a legitimately-hit texel
    // (UV layout / index quirks); clipping then erases the whole stamp and
    // painting silently does nothing. Falling back to no clip keeps painting
    // working (a stamp may bleed past a chart border when the clip can't be
    // trusted, which is far preferable to drawing nothing).
    if (islandPath && lctx.isPointInPath(islandPath, point.x, point.y)) {
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
    // The weight brush shares this context, so it shares the sizing too.
    setWeightSizeRange({ min: r * 0.002, max: r * 0.6 });
    setWeightSize(prev => (prev > 0 && prev < r * 2 ? prev : r * 0.08));
    // The segmentation brush moves whole faces rather than smoothing a field, so
    // it starts wider: corrections are usually "this strip belongs to the arm",
    // not a per-triangle touch-up.
    setSegmentBrushSizeRange({ min: r * 0.002, max: r * 0.6 });
    setSegmentBrushSize(prev => (prev > 0 && prev < r * 2 ? prev : r * 0.12));

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
    const worldHeightAtDistance = viewWorldHeightAt(camera, distance);
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

  // ── Weight painting ────────────────────────────────────────────────────────
  // Reuses the sculpt context wholesale: the same spatial grid finds the vertices
  // under the brush, the same smoothstep falloff shapes the dab, the same BVH
  // proxy answers the raycast. Only what gets written differs — skinWeight
  // instead of position — so none of that had to be built twice.

  // `commitRigEdit` and `pushRigSnapshot` are defined further down, alongside the
  // animation-invalidation plumbing they need. Reached through refs because the
  // brush belongs up here with the other stroke kernels, and a direct call would
  // read them before initialisation.
  const pushRigSnapshotRef = useRef(null)
  const commitRigEditRef = useRef(null)

  // The selected bone, translated from the overlay index the UI speaks into the
  // skeleton index `skinIndex` stores. Never assume the two coincide — see the
  // header of utils/meshRigEdit.js.
  const weightBoneSkel = useMemo(() => {
    const rig = rigRevision >= 0 ? rigRef.current : null
    if (!rig || selectedBone == null) return -1
    const map = rigSkeletonIndices(rig)
    return selectedBone < map.length ? map[selectedBone] : -1
  }, [selectedBone, rigRevision])

  // Where weight goes when the brush takes it off a vertex this bone owns
  // outright: up the chain, to the parent. Without it, lowering a bone that is a
  // vertex's only influence has nowhere to put the share it frees, so
  // Subtract/Set/Blur silently do nothing on exactly the solid-red regions that
  // most need correcting. -1 for a root bone, which genuinely has nowhere.
  const weightFallbackSkel = useMemo(() => {
    const rig = rigRevision >= 0 ? rigRef.current : null
    const parent = selectedBone == null ? -1 : (skeleton?.parents?.[selectedBone] ?? -1)
    if (!rig || parent < 0) return -1
    const map = rigSkeletonIndices(rig)
    return parent < map.length ? map[parent] : -1
  }, [selectedBone, rigRevision, skeleton])

  // Mirrored into a ref so the display geometry can colour itself the moment it
  // is built, without taking the bone as a memo dependency (which would rebuild
  // the whole container on every bone click).
  const weightBoneSkelRef = useRef(-1)
  weightBoneSkelRef.current = weightBoneSkel

  const computeWeightCursorPixelRadius = useCallback((worldHitPoint, canvasHeight) => {
    const camera = cameraRef.current
    if (!camera || !worldHitPoint) return 24
    const distance = camera.position.distanceTo(worldHitPoint)
    const worldHeightAtDistance = viewWorldHeightAt(camera, distance)
    if (worldHeightAtDistance <= 0) return 24
    return Math.max(4, (weightSize / worldHeightAtDistance) * canvasHeight)
  }, [weightSize])

  // Recolour the whole mesh for the current bone. Called when the bone, the
  // geometry or the weights change wholesale (entering the mode, undo, Fill);
  // a brush dab takes the cheaper per-vertex path in applyWeightStamp.
  const refreshWeightHeatmap = useCallback(() => {
    const attribute = weightColors()
    if (!attribute || !geometry) return
    const values = readBoneWeights(geometry, weightBoneSkel, weightValuesRef.current)
    weightValuesRef.current = values
    writeWeightColors(attribute.array, values)
    attribute.needsUpdate = true
  }, [geometry, weightBoneSkel])

  // One brush dab at an object-space point on the surface. `faceIndex` is the
  // triangle the pointer ray hit, which is what tells the brush which piece of
  // surface it is on — see the connectivity filter below.
  const applyWeightStamp = useCallback((point, faceIndex = -1) => {
    const ctx = sculptContextRef.current
    if (!ctx || weightBoneSkel < 0 || !geometryHasSkin(ctx.geometry)) return
    ensureSculptGrid(ctx, weightSize)

    const queried = sculptQueryRadius(ctx, point.x, point.y, point.z, weightSize, weightHardness)
    if (queried === 0) return

    let count = queried
    // The radius query is a ball in space, so on anything folded it also holds
    // surface the pointer is nowhere near — the other thigh, the chest behind an
    // arm — and the stroke shows up over there instead of (or as well as) under
    // the cursor. Keep only what is reachable across the surface from the
    // triangle that was actually hit. Runs BEFORE the front-facing pass: that
    // one compacts vertices away, and a discarded back-facing vertex may be the
    // only bridge between two front-facing patches of the same surface.
    if (weightConnectedOnly) {
      count = sculptFilterConnected(ctx, ctx._outIndices, ctx._outWeights, count, faceIndex)
      if (count === 0) return
    }
    // A vertex is drawn (and skinned) across every triangle it belongs to, so a
    // dab that clips one corner of a sliver triangle repaints the whole sliver —
    // on a generated mesh that reaches a fifth of the model away. Those corners
    // are junk geometry; leave their weight alone rather than paint a stripe
    // across the mesh. (Fill / Clear still reach them.)
    count = sculptFilterNeedles(ctx, ctx._outIndices, ctx._outWeights, count, weightSize)
    if (count === 0) return

    if (weightFrontOnly && cameraRef.current) {
      const camera = cameraRef.current.position
      // `count`, not `queried`: the passes above have already compacted the
      // set, and re-reading the full one would undo them.
      count = sculptFilterFrontFacing(ctx, ctx._outIndices, ctx._outWeights, count, camera.x, camera.y, camera.z)
      if (count === 0) return
    }

    // Held modifiers override the chosen brush for the length of the stroke, the
    // same way they do while sculpting: Ctrl takes weight away, Shift blurs.
    const keys = weightStrokeKeysRef.current
    const mode = keys.shift ? 'blur' : (keys.ctrl ? 'subtract' : weightBrush)

    const changed = applyWeightBrush(ctx, ctx._outIndices, ctx._outWeights, count, weightBoneSkel, {
      mode,
      strength: weightStrength,
      target: weightTarget,
      normalize: weightNormalize,
      fallbackBone: weightFallbackSkel,
    })
    if (!changed) return

    const attribute = weightColors()
    if (attribute && weightValuesRef.current) {
      refreshWeightColors(
        attribute.array, weightValuesRef.current,
        ctx.geometry, weightBoneSkel, ctx._outIndices, count,
      )
      attribute.needsUpdate = true
    }
  }, [weightBoneSkel, weightBrush, weightConnectedOnly, weightFallbackSkel, weightFrontOnly, weightHardness, weightNormalize, weightSize, weightStrength, weightTarget])

  const cancelWeightStroke = useCallback(() => {
    const stroke = weightStrokeRef.current
    if (!stroke) return
    canvasShellRef.current?.releasePointerCapture?.(stroke.pointerId)
    weightStrokeRef.current = null
  }, [])

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
            ? assetUrl(sculptStampAsset.filename)
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

    // A rigged mesh arrives as a SkinnedMesh, and the editable `geometry` below
    // holds rest-pose *world* positions (loadEditableGeometryFromObject bakes
    // each vertex through child.matrixWorld). Leaving the node skinned would
    // therefore be wrong in two different ways depending on the mesh:
    //
    //   * without skin attributes — the case before rig preservation, and still
    //     the case after any topology edit — three throws in
    //     computeBoundingSphere() -> applyBoneTransform() while frustum culling,
    //     dereferencing the missing skinIndex and taking the whole canvas down;
    //   * with skin attributes, the original bind matrix would be applied on top
    //     of geometry that already has it baked in, deforming the mesh.
    //
    // The editor never poses the skeleton, so a static node renders identically
    // to a correctly-bound one. Demote unconditionally and keep the real rig
    // aside in rigRef, which is what save/export reattaches.
    //
    // The uuid is carried over deliberately: paint targets are keyed by it
    // (texturableMesh.paintTargetsByMeshUuid), so a fresh uuid would silently
    // break painting and projection on this mesh.
    if (targetMesh.isSkinnedMesh && targetMesh.parent) {
      const plainMesh = new THREE.Mesh(geometry, targetMesh.material)
      plainMesh.uuid = targetMesh.uuid
      plainMesh.name = targetMesh.name
      plainMesh.userData = targetMesh.userData
      plainMesh.visible = targetMesh.visible
      plainMesh.castShadow = targetMesh.castShadow
      plainMesh.receiveShadow = targetMesh.receiveShadow
      targetMesh.parent.add(plainMesh)
      targetMesh.removeFromParent()
      targetMesh = plainMesh
      texturableEditableMeshRef.current = plainMesh
    }

    targetMesh.geometry = geometry
    // The editable `geometry` already has the mesh's full world transform baked
    // in (loadEditableGeometryFromObject applies child.matrixWorld). If the
    // source node carries its own transform we must NOT apply it again — e.g.
    // gltfpack / KHR_mesh_quantization stores the real scale in the node
    // transform, so leaving it in place double-applies it and collapses the mesh
    // to an invisible speck in the texture/paint/projection views (modeling mode
    // renders the geometry directly, which is why it stayed visible there). Pin
    // this node's world matrix to identity so the textured display and its
    // raycasting match the editable geometry.
    targetMesh.position.set(0, 0, 0)
    targetMesh.quaternion.identity()
    targetMesh.scale.set(1, 1, 1)
    targetMesh.matrix.identity()
    targetMesh.matrixWorldAutoUpdate = false
    targetMesh.matrixWorld.identity()
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
        // Capture any existing skeleton BEFORE the editable/texturable pipelines
        // consume the graph — an already-rigged mesh (skinned GLB) carries bones
        // we can show as an overlay. Bone positions are in the same world space
        // the editable geometry is baked into, so they align.
        let loadedSkeleton = null
        try {
          loadedSkeleton = extractSkeletonFromObject(loadedRoot)
        } catch (skeletonError) {
          console.warn('Skeleton extraction failed:', skeletonError)
        }
        // Capture the actual rig (bones + inverse bind matrices) alongside the
        // display-only overlay data. The editing pipeline can carry per-vertex
        // skin weights as geometry attributes but not a scene graph, so the
        // skeleton is kept aside and reattached on save/export.
        let loadedRig = null
        try {
          loadedRig = extractRigFromObject(loadedRoot)
        } catch (rigError) {
          console.warn('Rig capture failed:', rigError)
        }
        const texturableStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

        const geometryPromise = Promise.resolve().then(() => loadEditableGeometryFromObject(loadedRoot)).then(loadedGeometry => {
          return loadedGeometry
        })

        const texturableMeshPromise = loadTexturableMeshFromRoot(loadedRoot, { url: modelUrl, startedAt: texturableStartedAt, blankTextureSize })
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
          // Reset the rig overlay to whatever this mesh arrived with.
          rigRef.current = loadedRig
          setRigDropped(false)
          setSkeleton(loadedSkeleton)
          setShowSkeleton(true)
          setSelectedBone(null)
          // A different mesh means a different skeleton — no edit history of the
          // previous one may survive into it.
          setRigEditing(false)
          setRigEditDirty(false)
          rigUndoStackRef.current = []
          rigRedoStackRef.current = []
          rigBaselineRef.current = null
          rigEditCountRef.current = 0
          rigAddedBonesRef.current.clear()
          setRigCanUndo(false)
          setRigCanRedo(false)
          setRigRevision(current => current + 1)
          // A new mesh means a new target skeleton — reset the Animations feature.
          setAnimReferenceId('')
          setAnimMapping(null)
          setBoneMappingRestored(false)
          setAnimClips([])
          setSelectedAnimation(null)
          setAnimPreview(null)
          setAnimError(null)
          setAnimArmTargets(null)
          setAnimArmExtension(0)
          setCheckedAnimations(new Set())
          animSourceRef.current = null
          customRigKeyRef.current = null
          animTargetRef.current = null
          retargetedClipsRef.current.clear()
          editedClipsRef.current.clear()
          animEditHistoryRef.current.clear()
          setAutoRigResult(null)
          riggedBlobRef.current = null
          rigResultAdoptedRef.current = true
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

  // Ensure a projection layer has a mask canvas matching the texture size.
  const ensureLayerMaskCanvas = useCallback((layerId) => {
    const layerData = projectionLayerDataRef.current.get(layerId)
    const textureCanvas = texturableMesh?.textureCanvas
    if (!layerData || !textureCanvas) {
      return null
    }
    const texW = textureCanvas.width
    const texH = textureCanvas.height
    let canvas = layerData.maskCanvas
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = texW
      canvas.height = texH
      layerData.maskCanvas = canvas
      layerData.maskAlpha = null
      layerData.maskHasPixels = false
      layerData.maskDirty = true
    } else if (canvas.width !== texW || canvas.height !== texH) {
      canvas.width = texW
      canvas.height = texH
      layerData.maskAlpha = null
      layerData.maskHasPixels = false
      layerData.maskDirty = true
    }
    return canvas
  }, [texturableMesh])

  // Build-once-and-cache the mesh's per-texel 3D position map for the current texture
  // size (see buildProjectionSurfacePositionMap). The keep-texture base feather uses it
  // to seed only at real 3D silhouette edges instead of every UV-island boundary.
  // Rasterizing the mesh is too slow to redo per live mask-paint compose, so the result
  // is cached and only rebuilt when the mesh or texture size changes.
  const getProjectionSurfacePositions = useCallback((width, height) => {
    const mesh = texturableMesh
    if (!mesh?.root || !width || !height) {
      return null
    }
    const cached = projectionSurfacePositionsRef.current
    if (cached && cached.mesh === mesh && cached.width === width && cached.height === height) {
      return cached.data
    }
    const data = buildProjectionSurfacePositionMap(mesh, width, height)
    projectionSurfacePositionsRef.current = data ? { mesh, width, height, data } : null
    return data
  }, [texturableMesh])

  // Recompose the projection stack from the CACHED per-layer bakes, applying each
  // layer's mask. The expensive GPU bake is never re-run here, so this is fast
  // enough to call live while painting a mask (gives realtime feedback on the mesh).
  const composeProjectionFromCache = useCallback((layers) => {
    const mesh = texturableMesh
    if (!mesh?.textureCanvas || !displayTextureRef.current) {
      return
    }
    const textureCanvas = mesh.textureCanvas
    const texW = textureCanvas.width
    const texH = textureCanvas.height
    const context = textureCanvas.getContext('2d')
    context.clearRect(0, 0, texW, texH)
    const baseSnapshot = projectionBaseTextureRef.current
    if (baseSnapshot && baseSnapshot.width === texW && baseSnapshot.height === texH) {
      context.drawImage(baseSnapshot, 0, 0)
    } else {
      drawProjectionCheckerboard(context, texW, texH)
    }
    const composedImage = context.getImageData(0, 0, texW, texH)
    const layerSnapshots = []
    const visibleLayers = (layers || []).filter(layer => layer.visible !== false)
    for (const layer of visibleLayers) {
      const layerData = projectionLayerDataRef.current.get(layer.id)
      if (!layerData?.bakedCanvas || !layerData.coverageMask || layerData.coverageMask.length !== texW * texH) {
        continue
      }
      const opacity = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)))
      if (opacity <= 0) {
        continue
      }
      // Read the baked pixels ONCE per bake (not every frame). The bake canvas only
      // changes on a full rebuild (new canvas identity), so cache the pixel array and
      // reuse it across all the live composes a brush stroke triggers.
      if (layerData.bakedPixelDataSource !== layerData.bakedCanvas
        || !layerData.bakedPixelData
        || layerData.bakedPixelData.length !== texW * texH * 4) {
        const bakedContext = layerData.bakedCanvas.getContext('2d', { willReadFrequently: true }) || layerData.bakedCanvas.getContext('2d')
        layerData.bakedPixelData = bakedContext.getImageData(0, 0, texW, texH).data
        layerData.bakedPixelDataSource = layerData.bakedCanvas
      }
      let snapshot = {
        pixelData: layerData.bakedPixelData,
        coverageMask: layerData.coverageMask,
        ownershipMask: layerData.ownershipMask,
        sharedSeamMask: layerData.sharedSeamMask,
        confidenceMap: layerData.confidenceMap,
        opacity,
        opacitySeams: Math.max(0, Math.min(1, Number(layer.opacitySeams ?? 1))),
        blendMode: layer.blendMode || 'source-over',
        blendPixels: Math.max(AUTO_PROJECTION_SEAM_SAFE_BLEND_PX, layer.blendPixels || 0)
      }
      const maskAlpha = refreshLayerMaskAlpha(layerData)
      if (maskAlpha) {
        snapshot = gateProjectionSnapshotByMask(snapshot, maskAlpha)
      }
      layerSnapshots.push(snapshot)
    }
    const keepingBaseTexture = Boolean(baseSnapshot && baseSnapshot.width === texW && baseSnapshot.height === texH)
    const surfacePositions = keepingBaseTexture ? getProjectionSurfacePositions(texW, texH) : null
    resolveProjectionLayersIntoImageData(composedImage.data, layerSnapshots, texW, texH, projectionViewGainsRef.current, projectionUvOccupancyRef.current, keepingBaseTexture, surfacePositions)
    context.putImageData(composedImage, 0, 0)
    projectionLayerSnapshotsRef.current = layerSnapshots
    // Flag the texture for re-upload WITHOUT bumping textureRevision: the live mask
    // preview must not remount <TexturedMesh> (which deep-clones the whole mesh). The
    // mounted material's map IS this texture object, and frameloop="always" re-uploads
    // it from needsUpdate every frame, so the mesh updates with no clone per frame.
    updateCanvasTexture(displayTextureRef.current)
  }, [texturableMesh, getProjectionSurfacePositions])

  // Paint the pending brush dab (capsule [lastPoint3D → pendingPoint3D]) into the
  // layer's mask canvas — GPU 3D-gated (seam-safe), with a UV-stamp CPU fallback.
  const paintProjectionMaskDabNow = useCallback((stroke, layerData) => {
    const maskCanvas = layerData?.maskCanvas
    if (!stroke || !maskCanvas || !texturableMesh?.root) {
      return false
    }
    const target = stroke.pendingPoint3D || stroke.lastPoint3D
    if (!target) {
      return false
    }
    const dab = paintProjectionMaskDabGPU({
      root: texturableMesh.root,
      textureKey: texturableMesh.textureKey,
      textureConfig: texturableMesh.textureConfig,
      hitA: stroke.lastPoint3D || target,
      hitB: target,
      radiusWorld: stroke.radiusWorld,
      textureWidth: maskCanvas.width,
      textureHeight: maskCanvas.height
    })
    const maskCtx = maskCanvas.getContext('2d')
    if (dab) {
      // GPU 3D-gated dab: union for draw, subtract for erase.
      maskCtx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
      maskCtx.drawImage(dab, 0, 0)
      maskCtx.globalCompositeOperation = 'source-over'
    } else if (stroke.pendingUv) {
      // CPU fallback (GPU unavailable): UV-space stamp (can bleed at seams).
      stampProjectionMaskStroke(
        maskCanvas,
        stroke.pendingFromUv || stroke.pendingUv,
        stroke.pendingUv,
        stroke.textureRadius || 16,
        stroke.pendingIslandPath || null,
        stroke.erase,
        texturableMesh.textureConfig
      )
    }
    stroke.lastPoint3D = target.clone ? target.clone() : target
    stroke.pendingPoint3D = null
    layerData.maskDirty = true
    return true
  }, [texturableMesh])

  // Snapshot the current composited texture so the live mask preview can be drawn
  // on top of it and the original restored each frame. Called once, at stroke start.
  const captureMaskPreviewBase = useCallback(() => {
    const textureCanvas = texturableMesh?.textureCanvas
    if (!textureCanvas) {
      return
    }
    let base = maskPreviewBaseRef.current
    if (!base) {
      base = document.createElement('canvas')
      maskPreviewBaseRef.current = base
    }
    if (base.width !== textureCanvas.width || base.height !== textureCanvas.height) {
      base.width = textureCanvas.width
      base.height = textureCanvas.height
    }
    const ctx = base.getContext('2d')
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, base.width, base.height)
    ctx.drawImage(textureCanvas, 0, 0)
  }, [texturableMesh])

  // Cheap live feedback while drawing a mask: restore the pre-stroke composite and
  // paint the layer's mask canvas on top as translucent white. This avoids the
  // expensive per-texel compose on every pointer move — the real masked result is
  // produced once, on release (see applyProjectionMaskAsync).
  const renderMaskPreview = useCallback((layerData) => {
    const textureCanvas = texturableMesh?.textureCanvas
    const base = maskPreviewBaseRef.current
    const maskCanvas = layerData?.maskCanvas
    if (!textureCanvas || !base || !maskCanvas || !displayTextureRef.current) {
      return
    }
    const w = textureCanvas.width
    const h = textureCanvas.height

    // Build the veil: a diagonal white/grey hatch kept ONLY where the mask is painted
    // (fill the hatch over everything, then 'destination-in' the mask alpha).
    let veil = maskPreviewVeilRef.current
    if (!veil) {
      veil = document.createElement('canvas')
      maskPreviewVeilRef.current = veil
    }
    if (veil.width !== w || veil.height !== h) {
      veil.width = w
      veil.height = h
    }
    const vctx = veil.getContext('2d')
    vctx.globalCompositeOperation = 'source-over'
    vctx.globalAlpha = 1
    vctx.clearRect(0, 0, w, h)
    const stripePattern = createMaskStripePattern(vctx)
    if (stripePattern) {
      vctx.fillStyle = stripePattern
    } else {
      vctx.fillStyle = '#ffffff'
    }
    vctx.fillRect(0, 0, w, h)
    vctx.globalCompositeOperation = 'destination-in'
    vctx.drawImage(maskCanvas, 0, 0)
    vctx.globalCompositeOperation = 'source-over'

    const ctx = textureCanvas.getContext('2d')
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(base, 0, 0)
    // Slightly translucent so the underlying surface stays readable through the hatch.
    ctx.globalAlpha = 0.5
    ctx.drawImage(veil, 0, 0)
    ctx.globalAlpha = 1
    updateCanvasTexture(displayTextureRef.current)
  }, [texturableMesh])

  // Apply a finished mask stroke (or a Clear/Fill) asynchronously: flag "applying"
  // so the animated veil shows + the UI blocks, yield two frames so the browser
  // paints that state before the heavy synchronous compose runs, then compose and
  // clear the flag. `mutate` runs the actual mask-canvas change (null for a plain
  // re-apply of an existing stroke).
  const applyProjectionMaskAsync = useCallback((layerId, layers, mutate) => {
    maskApplyingRef.current = true
    setMaskApplying(true)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof mutate === 'function') {
        mutate()
      }
      const layerData = projectionLayerDataRef.current.get(layerId)
      if (layerData) {
        refreshLayerMaskAlpha(layerData)
        const hasMask = !!layerData.maskHasPixels
        setProjectionLayers(current => current.map(layer => (
          layer.id === layerId && layer.hasMask !== hasMask ? { ...layer, hasMask } : layer
        )))
      }
      composeProjectionFromCache(layers)
      maskPreviewBaseRef.current = null
      maskApplyingRef.current = false
      setMaskApplying(false)
    }))
  }, [composeProjectionFromCache])

  // Coalesce pointer moves to one dab + one cheap preview render per animation frame.
  const scheduleProjectionMaskPaint = useCallback(() => {
    const state = projectionMaskPaintRef.current
    if (state.scheduled) {
      return
    }
    state.scheduled = true
    requestAnimationFrame(() => {
      state.scheduled = false
      const stroke = projectionMaskStrokeRef.current
      const layerId = projectionMaskEditLayerId
      const layerData = layerId ? projectionLayerDataRef.current.get(layerId) : null
      if (!stroke || !layerData) {
        return
      }
      paintProjectionMaskDabNow(stroke, layerData)
      renderMaskPreview(layerData)
    })
  }, [paintProjectionMaskDabNow, projectionMaskEditLayerId, renderMaskPreview])

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

  // Which bone is under a viewport point, as an index into `skeleton.names`.
  // `{ ok: false }` means picking is not possible right now (no camera, or a clip is
  // playing with no live joints drawn) — as opposed to `{ ok: true, index: null }`,
  // which is a click on empty space and does deselect.
  const pickBoneAt = useCallback((point) => {
    const camera = cameraRef.current
    const rect = canvasShellRef.current?.getBoundingClientRect()
    if (!camera || !rect || !skeleton?.joints?.length) return { ok: false, index: null }
    // While a clip plays, hit-test the joints the user can actually see (the ones the
    // animated overlay drew this frame) instead of the bind pose. Testing the bind
    // pose then would select a bone from wherever the mesh ISN'T.
    const live = animPreview && showSkeleton ? liveJointsRef.current : null
    if (animPreview && !live) return { ok: false, index: null }
    const joints = live?.positions || skeleton.joints

    const projected = new THREE.Vector3()
    const PICK_RADIUS_PX = 16
    let closest = null
    let closestDist = PICK_RADIUS_PX
    for (let i = 0; i < joints.length / 3; i += 1) {
      projected.set(joints[i * 3], joints[i * 3 + 1], joints[i * 3 + 2]).project(camera)
      if (projected.z > 1) continue // behind the camera
      const px = (projected.x * 0.5 + 0.5) * rect.width
      const py = (-projected.y * 0.5 + 0.5) * rect.height
      const dist = Math.hypot(px - point.x, py - point.y)
      if (dist <= closestDist) {
        closestDist = dist
        closest = i
      }
    }
    if (!live || closest == null) return { ok: true, index: closest }
    // Map back BY NAME: `selectedBone` indexes the rest-pose skeleton the Skeleton
    // tree is built from, and the two bone orders need not agree.
    const index = skeleton.names?.indexOf(live.names[closest])
    return { ok: true, index: index != null && index >= 0 ? index : null }
  }, [skeleton, animPreview, showSkeleton])

  const handleCanvasPointerDown = useCallback((event) => {
    // The view cube lives inside the R3F canvas, so its clicks land here too (R3F's
    // stopPropagation is scene-internal, not DOM). Bow out over its corner or a
    // snap-to-face would also start a stroke / box selection / bone pick.
    const shellRect = canvasShellRef.current?.getBoundingClientRect()
    if (shellRect && isPointerOverViewGizmo(event.clientX - shellRect.left, event.clientY - shellRect.top, shellRect)) {
      return
    }

    // Right-click a bone to swap its gizmo between move and rotate (and select it, so
    // one gesture does both). Anywhere else the button still belongs to OrbitControls,
    // which pans with it.
    if (event.button === 2) {
      if (activeMenu !== 'autorig' || !animEditOpen || animPlaying || !animPreview) return
      const point = getPointerPosition(event)
      if (!point) return
      const pick = pickBoneAt(point)
      if (!pick.ok || pick.index == null) return
      event.preventDefault()
      setSelectedBone(pick.index)
      setAnimEditGizmoMode(prev => (prev === 'translate' ? 'rotate' : 'translate'))
      return
    }
    if (event.button !== 0) {
      return
    }

    const nextPoint = getPointerPosition(event)
    if (!nextPoint) {
      return
    }

    // Auto Rig: left-click picks the nearest bone joint (screen-space) so it can be
    // highlighted + selected in the Skeleton panel. Clicking empty space deselects.
    // While the bone gizmo has the pointer, the click belongs to the drag — picking
    // there would deselect the very bone being moved.
    if (rigGizmoDragRef.current || animGizmoDragRef.current) {
      return
    }

    // Smart Segmentation: whichever tool is armed owns the left button. Merge and
    // Focus are single picks; the brush starts a stroke and captures the pointer,
    // which is what stops OrbitControls from orbiting the view out from under it.
    if (activeMenu === 'segmentation' && segmentToolRef.current !== 'none' && segmentationRef.current) {
      const mesh = ensureSculptMesh()
      const camera = cameraRef.current
      const shell = canvasShellRef.current
      if (!mesh || !camera || !shell) return
      const rect = shell.getBoundingClientRect()
      const hit = sculptRaycastMesh(mesh, camera, nextPoint.x, nextPoint.y, rect.width, rect.height)
      if (!hit) return
      event.preventDefault()

      // Shift re-picks the target mid-session, and with no target yet the first
      // click sets one rather than painting into nothing.
      if (segmentToolRef.current !== 'brush' || event.shiftKey || segmentTargetFaceRef.current < 0) {
        segmentActionsRef.current.pick?.(hit.faceIndex)
        return
      }

      segmentActionsRef.current.beginStroke?.()
      const stroke = segmentStrokeRef.current
      if (!stroke) return
      stroke.pointerId = event.pointerId
      stroke.lastScreen = { x: nextPoint.x, y: nextPoint.y }
      stroke.accumulated = 0
      stroke.erase = !!(event.ctrlKey || event.metaKey)
      segmentActionsRef.current.dab?.(hit, stroke.erase)
      setSegmentCursor({
        x: nextPoint.x,
        y: nextPoint.y,
        pixelRadius: segmentActionsRef.current.cursorRadius?.(hit.worldPoint, rect.height) ?? 24
      })
      shell.setPointerCapture?.(event.pointerId)
      return
    }

    // Weight painting owns the left button while it is on, so the bone-pick
    // branch below would never see it. Alt is the way back to picking a bone on
    // the mesh — the Skeleton list is the other.
    // With no bone chosen yet there is nothing to paint, so the click falls
    // through to the bone-pick branch instead: the first click selects, the ones
    // after it paint.
    if (activeMenu === 'autorig' && weightPainting && !event.altKey && weightBoneSkel >= 0) {
      const ctx = sculptContextRef.current
      const mesh = ensureSculptMesh()
      const camera = cameraRef.current
      const shell = canvasShellRef.current
      if (!ctx || !mesh || !camera || !shell) return

      const rect = shell.getBoundingClientRect()
      const hit = sculptRaycastMesh(mesh, camera, nextPoint.x, nextPoint.y, rect.width, rect.height)
      if (!hit) return

      event.preventDefault()
      weightStrokeKeysRef.current = { ctrl: !!event.ctrlKey || !!event.metaKey, shift: !!event.shiftKey }
      // One snapshot per stroke, taken before the first dab — the same contract
      // the bone gizmo uses for a drag. Through the ref, like the commit below:
      // pushRigSnapshot is declared further down the component, so naming it in
      // this callback's dependency array would read it before initialisation.
      if (!pushRigSnapshotRef.current?.()) return
      applyWeightStamp(hit.point, hit.faceIndex)

      weightStrokeRef.current = {
        pointerId: event.pointerId,
        lastScreen: { x: nextPoint.x, y: nextPoint.y },
        accumulated: 0,
      }
      setWeightCursor({
        x: nextPoint.x,
        y: nextPoint.y,
        pixelRadius: computeWeightCursorPixelRadius(hit.worldPoint, rect.height)
      })
      shell.setPointerCapture?.(event.pointerId)
      return
    }

    if (activeMenu === 'autorig' && skeleton?.joints?.length && cameraRef.current) {
      const pick = pickBoneAt(nextPoint)
      if (!pick.ok) return
      event.preventDefault()
      setSelectedBone(pick.index)
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

    // Projection mask drawing: paint (left-drag) the active layer's mask directly on
    // the mesh. Middle/right-drag still orbits (OrbitControls LEFT is disabled).
    if (activeMenu === 'projection' && projectionMaskEditLayerId) {
      if (!texturableMesh?.root) {
        return
      }
      // A previous stroke is still being applied — don't let a new one start.
      if (maskApplyingRef.current) {
        return
      }
      const intersection = getMeshIntersection(nextPoint, texturableMesh.root)
      if (!intersection?.uv || !intersection?.point) {
        setFeedback('Mask drawing: aim the cursor at the mesh surface, then left-drag.')
        return
      }
      event.preventDefault()
      const layerData = projectionLayerDataRef.current.get(projectionMaskEditLayerId)
      const maskCanvas = ensureLayerMaskCanvas(projectionMaskEditLayerId)
      if (!layerData || !maskCanvas) {
        return
      }
      const rect0 = canvasShellRef.current?.getBoundingClientRect()
      const point3D = intersection.point.clone()
      const uvPoint = intersection.uv.clone()
      // Stroke state: the GPU dab gates by WORLD distance to [lastPoint3D, pendingPoint3D]
      // (capsule) so it never bleeds across UV seams. UV fields are CPU fallback only.
      projectionMaskStrokeRef.current = {
        pointerId: event.pointerId,
        erase: projectionMaskErase,
        radiusWorld: computeProjectionMaskWorldRadius(intersection, cameraRef.current, rect0?.height ?? 1, projectionMaskBrushSize),
        lastPoint3D: point3D,
        pendingPoint3D: point3D,
        pendingUv: uvPoint,
        pendingFromUv: uvPoint,
        pendingIslandPath: getUvIslandHitInfo(texturableMesh, intersection)?.path || null,
        textureRadius: computePaintBrushTexturePx(projectionMaskBrushSize, cameraRef.current, rect0?.height ?? 1, intersection, maskCanvas.width, maskCanvas.height)
      }
      canvasShellRef.current?.setPointerCapture?.(event.pointerId)
      // Snapshot the current composite once; the stroke paints a cheap white preview
      // on top of it (no compose) until the pointer is released.
      captureMaskPreviewBase()
      scheduleProjectionMaskPaint()
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
  }, [activeMenu, animEditOpen, animPlaying, animPreview, applySculptStamp, applyWeightStamp, beginPaintStroke, booleanPlaceMode, booleanStampBasis, brushSize, captureMaskPreviewBase, computeSculptCursorPixelRadius, computeWeightCursorPixelRadius, ensureLayerMaskCanvas, ensureSculptMesh, getMeshIntersection, getPointerPosition, numericAssetId, paintBrushSize, paintColor, paintFlow, paintHardness, paintLayers, paintMode, paintRotation, pendingPatch, pickBoneAt, projectionMaskBrushSize, projectionMaskEditLayerId, projectionMaskErase, pushSculptUndo, resetSelection, scheduleProjectionMaskPaint, sculptBrush, sculptFrontFacesOnly, sculptHardness, sculptSize, sculptStampRotation, sculptSymmetry, selectedLayerId, selectionMesh, skeleton, stampBrushAtUv, syncProjectionMaskCanvasSize, texturableMesh, texturingReady, weightBoneSkel, weightPainting])

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

    if (activeMenu === 'segmentation' && segmentToolRef.current === 'brush') {
      const mesh = ensureSculptMesh()
      const camera = cameraRef.current
      const shell = canvasShellRef.current
      if (!mesh || !camera || !shell) return

      const nextPoint = getPointerPosition(event)
      if (!nextPoint) return
      const rect = shell.getBoundingClientRect()

      const hoverHit = sculptRaycastMesh(mesh, camera, nextPoint.x, nextPoint.y, rect.width, rect.height)
      if (hoverHit) {
        setSegmentCursor({
          x: nextPoint.x,
          y: nextPoint.y,
          pixelRadius: segmentActionsRef.current.cursorRadius?.(hoverHit.worldPoint, rect.height) ?? 24
        })
      } else if (!segmentStrokeRef.current) {
        setSegmentCursor(null)
      }

      const stroke = segmentStrokeRef.current
      if (!stroke) return

      // Walk the segment in fixed screen-space steps so a fast drag sweeps a
      // continuous band instead of leaving gaps where the pointer events landed.
      // Same accounting as the weight brush, including the reason `accumulated`
      // is measured against THIS segment only — folding the previous leftover
      // back in double-counts it, and the error compounds once per event until a
      // stroke that never moved is stamping its way across the mesh.
      const dx = nextPoint.x - stroke.lastScreen.x
      const dy = nextPoint.y - stroke.lastScreen.y
      const screenDist = Math.hypot(dx, dy)
      if (screenDist <= 0.01) return

      const pxPerWorldRadius = hoverHit
        ? Math.max(1, segmentActionsRef.current.cursorRadius?.(hoverHit.worldPoint, rect.height) ?? 24)
        : 24
      const stepPixels = Math.max(1, 0.4 * pxPerWorldRadius)

      const walked = stroke.accumulated
      const steps = Math.floor((walked + screenDist) / stepPixels)
      if (steps <= 0) {
        stroke.accumulated = walked + screenDist
        stroke.lastScreen.x = nextPoint.x
        stroke.lastScreen.y = nextPoint.y
        return
      }

      const ux = dx / screenDist
      const uy = dy / screenDist
      let cursorX = stroke.lastScreen.x
      let cursorY = stroke.lastScreen.y
      let traveled = 0
      for (let step = 0; step < steps; step += 1) {
        const advance = step === 0 ? stepPixels - walked : stepPixels
        cursorX += ux * advance
        cursorY += uy * advance
        traveled += advance
        const stepHit = sculptRaycastMesh(mesh, camera, cursorX, cursorY, rect.width, rect.height)
        if (!stepHit) continue
        segmentActionsRef.current.dab?.(stepHit, stroke.erase)
      }

      stroke.accumulated = Math.max(0, screenDist - traveled)
      stroke.lastScreen.x = nextPoint.x
      stroke.lastScreen.y = nextPoint.y
      return
    }

    if (activeMenu === 'autorig' && weightPainting) {
      const ctx = sculptContextRef.current
      const mesh = ensureSculptMesh()
      const camera = cameraRef.current
      const shell = canvasShellRef.current
      if (!ctx || !mesh || !camera || !shell) return

      const nextPoint = getPointerPosition(event)
      if (!nextPoint) return
      const rect = shell.getBoundingClientRect()

      const hoverHit = sculptRaycastMesh(mesh, camera, nextPoint.x, nextPoint.y, rect.width, rect.height)
      if (hoverHit) {
        setWeightCursor({
          x: nextPoint.x,
          y: nextPoint.y,
          pixelRadius: computeWeightCursorPixelRadius(hoverHit.worldPoint, rect.height)
        })
      } else if (!weightStrokeRef.current) {
        setWeightCursor(null)
      }

      const stroke = weightStrokeRef.current
      if (!stroke) return

      // Walk the segment in fixed screen-space steps so a fast drag lays a
      // continuous band instead of isolated blobs where the events landed. Same
      // idea as the sculpt stroke below, without the lazy-mouse smoothing —
      // weights want the pointer's actual path, not a trailing one.
      const dx = nextPoint.x - stroke.lastScreen.x
      const dy = nextPoint.y - stroke.lastScreen.y
      const screenDist = Math.hypot(dx, dy)
      if (screenDist <= 0.01) return

      const pxPerWorldRadius = hoverHit
        ? Math.max(1, computeWeightCursorPixelRadius(hoverHit.worldPoint, rect.height))
        : 24
      const stepPixels = Math.max(1, 0.25 * pxPerWorldRadius)

      const walked = stroke.accumulated
      const steps = Math.floor((walked + screenDist) / stepPixels)
      if (steps <= 0) {
        stroke.accumulated = walked + screenDist
        stroke.lastScreen.x = nextPoint.x
        stroke.lastScreen.y = nextPoint.y
        return
      }

      const ux = dx / screenDist
      const uy = dy / screenDist
      let cursorX = stroke.lastScreen.x
      let cursorY = stroke.lastScreen.y
      let traveled = 0
      for (let step = 0; step < steps; step += 1) {
        const advance = step === 0 ? stepPixels - walked : stepPixels
        cursorX += ux * advance
        cursorY += uy * advance
        traveled += advance
        const stepHit = sculptRaycastMesh(mesh, camera, cursorX, cursorY, rect.width, rect.height)
        if (!stepHit) continue
        applyWeightStamp(stepHit.point, stepHit.faceIndex)
      }

      // Leftover distance toward the NEXT stamp, measured against THIS segment
      // only: `traveled` already has the previous leftover folded into its
      // first step, so adding `walked` back in double-counts it. That error
      // compounds once per pointer event and never resets inside a stroke, so
      // a held drag inflates it without bound — and since step 0 advances
      // `stepPixels - accumulated`, the walk starts that far BEHIND the pointer
      // and stamps its way forward. A couple of seconds of jiggling in one spot
      // is enough to reach several hundred pixels and tens of thousands of
      // stamps, which is how a stroke that never moved cleared weights right
      // across the mesh. Releasing and clicking again hid it: pointerdown
      // resets `accumulated` to 0.
      stroke.accumulated = Math.max(0, screenDist - traveled)
      stroke.lastScreen.x = nextPoint.x
      stroke.lastScreen.y = nextPoint.y
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

        const worldHeightAtDist = viewWorldHeightAt(camera, stroke.grabHitDistance)
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

      // Against THIS segment only — see the weight-paint walk above for why
      // adding `walked` back in compounds into stamps hundreds of pixels off
      // the pointer over a long drag.
      stroke.accumulated = Math.max(0, screenDist - traveled)
      stroke.lastScreen.x = stroke.lazyScreen.x
      stroke.lastScreen.y = stroke.lazyScreen.y
      return
    }

    if (activeMenu === 'projection' && projectionMaskEditLayerId) {
      // Update the brush cursor preview via direct DOM so it tracks the pointer with
      // zero React re-render latency (this fires on every pointer-move).
      const shell = canvasShellRef.current
      const cursorEl = projectionMaskCursorRef.current
      if (shell && cursorEl) {
        const rect = shell.getBoundingClientRect()
        cursorEl.style.left = `${event.clientX - rect.left}px`
        cursorEl.style.top = `${event.clientY - rect.top}px`
        cursorEl.style.display = 'block'
      }

      const stroke = projectionMaskStrokeRef.current
      if (!stroke || !texturableMesh?.root) {
        return
      }
      const nextPoint = getPointerPosition(event)
      if (!nextPoint) {
        return
      }
      const intersection = getMeshIntersection(nextPoint, texturableMesh.root)
      if (!intersection?.uv || !intersection?.point) {
        return
      }
      const paintRect = canvasShellRef.current?.getBoundingClientRect()
      // Push the latest segment endpoint + brush footprint into the stroke; the
      // throttled rAF paints the capsule [lastPoint3D → pendingPoint3D] on the GPU.
      stroke.radiusWorld = computeProjectionMaskWorldRadius(intersection, cameraRef.current, paintRect?.height ?? 1, projectionMaskBrushSize)
      stroke.pendingFromUv = stroke.pendingUv || intersection.uv.clone()
      stroke.pendingUv = intersection.uv.clone()
      stroke.pendingIslandPath = getUvIslandHitInfo(texturableMesh, intersection)?.path || null
      stroke.textureRadius = computePaintBrushTexturePx(
        projectionMaskBrushSize,
        cameraRef.current,
        paintRect?.height ?? 1,
        intersection,
        texturableMesh.textureCanvas?.width ?? 1024,
        texturableMesh.textureCanvas?.height ?? 1024
      )
      stroke.pendingPoint3D = intersection.point.clone()
      scheduleProjectionMaskPaint()
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
  }, [activeMenu, applySculptStamp, applyWeightStamp, booleanPlaceMode, brushSize, computeSculptCursorPixelRadius, computeWeightCursorPixelRadius, ensureSculptMesh, getMeshIntersection, getPointerPosition, paintBrushSize, paintColor, paintFlow, paintHardness, paintMode, paintRotation, projectionMaskBrushSize, projectionMaskEditLayerId, projectionMaskErase, recompositePaintTexture, scheduleProjectionMaskPaint, sculptSpacing, sculptSteadyStroke, sculptStrength, selectionMesh, stampBrushAtUv, texturableMesh, updateMaskOverlay, weightPainting])

  const handleCanvasPointerUp = useCallback((event) => {
    if (activeMenu === 'segmentation' && segmentStrokeRef.current) {
      if (event.button !== 0) return
      canvasShellRef.current?.releasePointerCapture?.(segmentStrokeRef.current.pointerId)
      // Commits the stroke to the undo stack and republishes the overrides, which
      // is the point at which the label pipeline runs again for real.
      segmentActionsRef.current.endStroke?.()
      return
    }

    if (activeMenu === 'autorig' && weightStrokeRef.current) {
      const stroke = weightStrokeRef.current
      if (event.button !== 0) return
      canvasShellRef.current?.releasePointerCapture?.(stroke.pointerId)
      weightStrokeRef.current = null

      // One commit per stroke, not per dab: this refreshes the overlay, marks
      // the rig dirty for the save banners, and stales the cached animation
      // retargets — all of which are keyed to the weights that just changed.
      const name = rigRef.current?.boneNames?.[selectedBone] || 'bone'
      commitRigEditRef.current?.(`Painted weights on ${name}.`)
      return
    }

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

    if (activeMenu === 'projection' && projectionMaskStrokeRef.current) {
      if (event.button !== 0) {
        return
      }
      const stroke = projectionMaskStrokeRef.current
      canvasShellRef.current?.releasePointerCapture?.(stroke.pointerId)
      const layerId = projectionMaskEditLayerId
      const layerData = layerId ? projectionLayerDataRef.current.get(layerId) : null
      // Flush the final segment (between the last move and release) into the mask and
      // refresh the cheap preview so the released stroke is shown immediately, then
      // clear stroke state.
      if (layerData) {
        paintProjectionMaskDabNow(stroke, layerData)
        renderMaskPreview(layerData)
      }
      projectionMaskStrokeRef.current = null
      // Apply the mask asynchronously: the animated veil shows + drawing/clearing is
      // blocked while the (expensive) compose runs, then the white preview is replaced
      // by the real masked result. No full GPU rebuild — the bakes are unchanged.
      if (layerData) {
        applyProjectionMaskAsync(layerId, projectionLayers)
      }
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
  }, [activeMenu, applyProjectionMaskAsync, getPointerPosition, paintProjectionMaskDabNow, projectionLayers, projectionMaskEditLayerId, recompositePaintTexture, renderMaskPreview, selectAtPoint, selectedBone, selectWithinRectangle])

  const handleCanvasPointerCancel = useCallback(() => {
    if (segmentStrokeRef.current) {
      // The dabs already landed, so this is a finished edit either way — commit
      // it rather than leave faces reassigned with nothing on the undo stack
      // pointing at them.
      canvasShellRef.current?.releasePointerCapture?.(segmentStrokeRef.current.pointerId)
      segmentActionsRef.current.endStroke?.()
      setSegmentCursor(null)
      return
    }

    if (weightStrokeRef.current) {
      // The dabs already landed, so this is a finished edit either way — commit
      // it rather than leave the rig changed with nothing on the undo stack
      // pointing at it.
      cancelWeightStroke()
      setWeightCursor(null)
      const name = rigRef.current?.boneNames?.[selectedBone] || 'bone'
      commitRigEditRef.current?.(`Painted weights on ${name}.`)
      return
    }

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
    if (projectionMaskStrokeRef.current) {
      canvasShellRef.current?.releasePointerCapture?.(projectionMaskStrokeRef.current.pointerId)
      const layerId = projectionMaskEditLayerId
      projectionMaskStrokeRef.current = null
      // The cancelled stroke still painted into the mask canvas and left the white
      // preview on the texture — apply it so the texture reflects the real result.
      if (layerId && projectionLayerDataRef.current.get(layerId)) {
        applyProjectionMaskAsync(layerId, projectionLayers)
      }
    }

    dragStateRef.current = null
    resetSelection()
    setSelectionBox(null)
  }, [applyProjectionMaskAsync, cancelSculptStroke, cancelWeightStroke, projectionLayers, projectionMaskEditLayerId, resetSelection, selectedBone])

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

    // Anything that rebuilds topology — the Python tools, gltfpack, CSG, the
    // local face/vertex ops — returns geometry with no skin attributes, and a
    // weight cannot be invented for a vertex that did not exist before. Rather
    // than let the rig disappear from the saved file unannounced, notice it here
    // once and say so. Checked instead of enumerating operations, so a tool
    // added later cannot forget to report it.
    if (rigRef.current && !geometryHasSkin(nextGeometry)) {
      rigRef.current = null
      setRigDropped(true)
      setFeedback('Mesh updated — this operation rebuilt the topology, so the skin weights were lost. Re-run Auto Rig before saving if you need the rig.')
      return
    }

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

  // Rebuild the texturable-mesh state from a (possibly UV-only) geometry, so the
  // painting/texturing/projection modes stay in sync after a topology change.
  // A UV-only mesh yields a blank-texture texturable (loadTexturableMeshFromRoot);
  // a UV-less one yields a supportError that correctly disables those modes.
  const buildTexturableFromGeometry = useCallback(async (geom, size) => {
    if (!geom) return null
    const root = new THREE.Mesh(
      geom.clone(),
      new THREE.MeshStandardMaterial({ color: '#cfd8ff', metalness: 0.08, roughness: 0.62 })
    )
    root.name = 'MeshEditorResult'
    const loaded = await loadTexturableMeshFromRoot(root, { url: modelUrl, blankTextureSize: size })
    if (loaded?.textureCanvas) {
      return {
        ...loaded,
        maskCanvas: Object.assign(document.createElement('canvas'), {
          width: loaded.textureCanvas.width,
          height: loaded.textureCanvas.height,
        }),
      }
    }
    return loaded
  }, [modelUrl])

  // Texture pipeline for a freshly-rigged mesh the editor is adopting.
  //
  // The rig round trip uploads the TEXTURED glb and, with "Preserve texture &
  // scale" on, gets the same mesh back with a skeleton — so the result itself is
  // the truthful source of the texture, whatever its vertex count came back as.
  // Rebuilding from geometry alone (buildTexturableFromGeometry) would hand back
  // a blank white canvas, which is how a rigged save lost its material.
  const adoptRiggedTexturable = useCallback(async (scene, nextGeometry) => {
    const withMask = loaded => (loaded?.textureCanvas
      ? {
        ...loaded,
        maskCanvas: Object.assign(document.createElement('canvas'), {
          width: loaded.textureCanvas.width,
          height: loaded.textureCanvas.height,
        }),
      }
      : loaded)

    let loaded = null
    try {
      loaded = await loadTexturableMeshFromRoot(scene, { url: modelUrl, blankTextureSize })
    } catch (err) {
      console.warn('Could not read the rigged result for texture editing:', err)
    }
    if (loaded?.textureCanvas && !loaded.isBlank) return withMask(loaded)

    // The result came back bare (rig transfer off, or an untextured upload).
    // Carry the canvas the editor already holds onto the new geometry instead of
    // dropping it — the UV layout is the one we sent.
    const currentCanvas = texturableMesh?.textureCanvas
    if (currentCanvas && !texturableMesh?.isBlank && nextGeometry?.attributes?.uv?.count) {
      const carriedRoot = new THREE.Mesh(
        nextGeometry.clone(),
        new THREE.MeshStandardMaterial({
          map: createCanvasTexture(currentCanvas, texturableMesh.textureConfig),
          metalness: 0.08,
          roughness: 0.62,
        }),
      )
      carriedRoot.name = 'MeshEditorRigged'
      try {
        const carried = await loadTexturableMeshFromRoot(carriedRoot, { url: modelUrl, blankTextureSize })
        if (carried?.textureCanvas) return withMask(carried)
      } catch (err) {
        console.warn('Could not carry the texture onto the rigged mesh:', err)
      }
    }

    return withMask(loaded) || await buildTexturableFromGeometry(nextGeometry, blankTextureSize)
  }, [modelUrl, blankTextureSize, texturableMesh, buildTexturableFromGeometry])

  const handleBlankTextureSizeChange = useCallback(async (size) => {
    setBlankTextureSize(size)
    if (texturableMesh?.isBlank && geometry) {
      const next = await buildTexturableFromGeometry(geometry, size)
      setTexturableMesh(next)
      setTextureRevision(0)
      setPaintLayers([])
      setSelectedLayerId(null)
    }
  }, [texturableMesh, geometry, buildTexturableFromGeometry])

  // ── Auto UV / Auto Retopo (Python mesh-tools service) ────────────────────
  // Both run the same round-trip: export the current geometry to GLB, POST it
  // to the Node proxy (which forwards to the Python service), then load the
  // returned GLB back as editable geometry. applyGeometryUpdate pushes the
  // pre-op mesh onto the modeling undo stack, so "Revert" is just an undo.
  // After applying, the texturable-mesh state is rebuilt so the new UVs (Auto
  // UV) immediately enable painting/texturing/projection.
  const runMeshTool = useCallback(async (service, options, { setRunning, setResult, setProgress, buildRows, label, preserveTexture = false, requiresService = null }) => {
    if (!geometry || autoUvRunning || autoRetopoRunning || optimizeRunning || repairRunning) {
      return
    }
    setRunning(true)
    setResult(null)
    setProgress({ stage: 'start', frac: 0, message: `${label} starting…` })
    setError('')
    setFeedback(`${label}…`)
    try {
      // Desktop: start the required Python service on demand (no-op elsewhere).
      if (requiresService) {
        setProgress({ stage: 'service', frac: 0, message: 'Starting service…' })
        await ensureDesktopService(requiresService)
      }
      const glbBuffer = await exportGeometryToGlb(geometry)
      const meshBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' })
      // Keep the pre-operation mesh as a bake source. Retopo and Optimize hand
      // back clean topology with the detail *deleted*; this is the only moment
      // that detail still exists, and baking from it is what turns those tools
      // from destructive into non-destructive. Captured for every tool rather
      // than a chosen few, so one added later cannot forget to.
      //
      // It must be the TEXTURED mesh, not `meshBlob`. That one is geometry with a
      // flat placeholder material, which is fine for the service (none of the
      // tools read the texture, and sending it would mean re-encoding megabytes
      // per call) but useless as a bake source: a base-colour transfer from it
      // reproduces the placeholder colour instead of the artwork. The extra
      // export only happens when there is actually a texture to lose.
      let snapshotBlob = meshBlob
      if (texturableMesh?.root && texturableMesh?.textureCanvas && geometry?.attributes?.uv?.count) {
        try {
          const files = await exportObject3D(getExportObject(), { format: 'glb', baseName: 'bake-source' })
          if (files?.[0]?.blob) snapshotBlob = files[0].blob
        } catch (snapshotError) {
          console.warn('Could not capture a textured bake snapshot; keeping geometry only:', snapshotError)
        }
      }
      rememberBakeSource(snapshotBlob, `Before ${label}`, geometryFaceCount(geometry))
      const { blob, stats, previewUrl } = await service(meshBlob, {
        options,
        fileName: 'mesh.glb',
        onProgress: evt => setProgress(evt),
      })
      const resultBuffer = await blob.arrayBuffer()
      const nextGeometry = await loadEditableGeometryFromGlbBuffer(resultBuffer)
      applyGeometryUpdate(nextGeometry, [], { pushUndo: true })
      // Resync texture editing to the new topology/UVs (enables the texture
      // modes when the result carries UVs, disables them otherwise). When the
      // operation preserves the existing UV layout (Optimize/simplify only
      // reduces triangles), carry the current texture over onto the new geometry
      // instead of resetting to a blank canvas.
      let nextTexturable
      if (preserveTexture && texturableMesh?.textureCanvas) {
        const preservedTexture = createCanvasTexture(texturableMesh.textureCanvas, texturableMesh.textureConfig)
        const preservedRoot = new THREE.Mesh(
          nextGeometry.clone(),
          new THREE.MeshStandardMaterial({ map: preservedTexture, metalness: 0.08, roughness: 0.62 })
        )
        preservedRoot.name = 'MeshEditorResult'
        const loaded = await loadTexturableMeshFromRoot(preservedRoot, { url: modelUrl, blankTextureSize })
        nextTexturable = loaded?.textureCanvas
          ? {
            ...loaded,
            maskCanvas: Object.assign(document.createElement('canvas'), {
              width: loaded.textureCanvas.width,
              height: loaded.textureCanvas.height,
            }),
          }
          : loaded
      } else {
        nextTexturable = await buildTexturableFromGeometry(nextGeometry, blankTextureSize)
      }
      // Remember the pre-op texturable so Revert can bring the texture back.
      preToolTexturableRef.current = texturableMesh
      setTexturableMesh(nextTexturable)
      setTextureRevision(0)
      setPaintLayers([])
      setSelectedLayerId(null)
      setResult({ rows: buildRows(stats, nextGeometry), previewUrl })
      setFeedback(`${label} complete.`)
    } catch (err) {
      console.error(`${label} failed:`, err)
      setError(err?.message || `${label} failed.`)
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }, [geometry, autoUvRunning, autoRetopoRunning, optimizeRunning, repairRunning, applyGeometryUpdate, buildTexturableFromGeometry, blankTextureSize, texturableMesh, modelUrl])

  const handleRunAutoUv = useCallback(() => {
    runMeshTool(runAutoUvService, autoUvOptions, {
      setRunning: setAutoUvRunning,
      setResult: setAutoUvResult,
      setProgress: setAutoUvProgress,
      label: 'Auto UV',
      requiresService: 'meshtools',
      buildRows: stats => {
        const t = stats?.tool || {}
        const rows = []
        if (t.n_charts != null) rows.push({ label: 'UV islands', value: t.n_charts })
        if (t.fill_ratio != null) rows.push({ label: 'Atlas fill', value: `${(t.fill_ratio * 100).toFixed(0)}%` })
        if (t.flipped_triangles != null) rows.push({ label: 'Flipped tris', value: t.flipped_triangles })
        if (t.mean_angle_distortion != null) rows.push({ label: 'Angle distortion', value: t.mean_angle_distortion.toFixed(3) })
        return rows
      },
    })
  }, [runMeshTool, autoUvOptions])

  const handleRunAutoRetopo = useCallback(() => {
    runMeshTool(runAutoRetopoService, autoRetopoOptions, {
      setRunning: setAutoRetopoRunning,
      setResult: setAutoRetopoResult,
      setProgress: setAutoRetopoProgress,
      label: 'Auto Retopo',
      requiresService: 'meshtools',
      buildRows: stats => {
        const m = stats?.tool?.metrics || {}
        const rows = [
          { label: 'Vertices', value: stats?.vertexCount ?? '—' },
          { label: 'Faces', value: stats?.faceCount ?? '—' },
        ]
        const haus = m?.fidelity?.hausdorff_pct_diag
        if (haus != null) rows.push({ label: 'Hausdorff', value: `${haus.toFixed(2)}% diag` })
        const wellShaped = m?.triangle_quality?.pct_well_shaped
        if (wellShaped != null) rows.push({ label: 'Well-shaped tris', value: `${wellShaped.toFixed(0)}%` })
        const wt = m?.topology?.watertight
        if (wt != null) rows.push({ label: 'Watertight', value: wt ? 'Yes' : 'No — has holes' })
        if (stats?.tool?.quad_face_count != null) rows.push({ label: 'Quad faces', value: stats.tool.quad_face_count })
        return rows
      },
    })
  }, [runMeshTool, autoRetopoOptions])

  const handleRunOptimize = useCallback(() => {
    runMeshTool(runOptimizeService, optimizeOptions, {
      setRunning: setOptimizeRunning,
      setResult: setOptimizeResult,
      setProgress: setOptimizeProgress,
      label: 'Optimize',
      preserveTexture: true,
      buildRows: (stats, geo) => {
        const rows = [
          { label: 'Simplify ratio', value: optimizeOptions.simplify_ratio },
          { label: 'Error budget', value: optimizeOptions.simplify_error },
        ]
        // The ratio actually reached: the number that says whether the target
        // was met, without making anyone do the arithmetic.
        if (stats?.achieved_ratio != null) {
          rows.push({ label: 'Achieved ratio', value: Number(stats.achieved_ratio.toFixed(3)) })
        }
        if (stats?.seams_broken) {
          rows.push({ label: 'Seams welded', value: 'yes — check hard edges and texture' })
        }
        if (geo?.index) rows.push({ label: 'Faces', value: geo.index.count / 3 })
        if (geo?.attributes?.position) rows.push({ label: 'Vertices', value: geo.attributes.position.count })
        return rows
      },
    })
  }, [runMeshTool, optimizeOptions])

  const setAutoUvOption = useCallback((key, value) => {
    setAutoUvOptions(prev => ({ ...prev, [key]: value }))
  }, [])
  const setAutoRetopoOption = useCallback((key, value) => {
    setAutoRetopoOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  const setAutoRigOption = useCallback((key, value) => {
    setAutoRigOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  // Auto Rig: generate a skeleton + skin weights via the SkinTokens rigging
  // service. Unlike the other mesh tools this does NOT replace the editable
  // geometry (that would discard the rig) — instead we parse the returned skinned
  // GLB for a skeleton overlay and keep the blob so it can be saved as a new
  // version or downloaded. We upload the TEXTURED GLB when available so the
  // service's rig transfer preserves the texture and scale.
  const handleRunAutoRig = useCallback(async () => {
    if (!geometry || autoRigRunning) return
    setAutoRigRunning(true)
    setAutoRigResult(null)
    setAutoRigProgress({ stage: 'start', frac: 0, message: 'Auto Rig starting…' })
    setError('')
    setFeedback('Auto Rig…')
    try {
      // Desktop: start the rigging service on demand (no-op elsewhere).
      setAutoRigProgress({ stage: 'service', frac: 0, message: 'Starting rigging service…' })
      await ensureDesktopService('rigging')
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
          textureConfig: texturableMesh.textureConfig,
        })
        : await exportGeometryToGlb(geometry)
      const meshBlob = new Blob([meshBinary], { type: 'model/gltf-binary' })

      const { blob, stats } = await runAutoRigService(meshBlob, {
        options: autoRigOptions,
        fileName: 'mesh.glb',
        onProgress: evt => setAutoRigProgress(evt),
      })

      const resultBuffer = await blob.arrayBuffer()
      riggedBlobRef.current = blob

      // Adopt the result as the editor's working mesh instead of only reading an
      // overlay off it. The rig arrives as a scene graph plus per-vertex weights;
      // taking both means the bones can be corrected afterwards, and that every
      // save path (Save mesh, Export, LOD, Game-Ready) reattaches the *current*
      // skeleton rather than replaying a service blob that no longer matches.
      const riggedScene = await parseGlbScene(resultBuffer)
      const riggedGeometry = loadEditableGeometryFromObject(riggedScene)
      const nextRig = extractRigFromObject(riggedScene)
      const rigSkeleton = extractSkeletonFromObject(riggedScene)
      // Adopting a result with no UVs would cost the mesh its texture for good,
      // and no rig is worth that — keep the textured mesh and fall back to the
      // downloadable-result behaviour (bone editing is unavailable for it).
      const hadTexture = !!(texturableMesh?.textureCanvas && !texturableMesh.isBlank)
      const riggedHasUvs = !!riggedGeometry.attributes?.uv?.count
      const riggable = !!nextRig && geometryHasSkin(riggedGeometry)
      const adopted = riggable && (riggedHasUvs || !hadTexture)
      const keptForTexture = riggable && !adopted

      rigResultAdoptedRef.current = adopted
      if (adopted) {
        rigRef.current = nextRig
        setRigDropped(false)
        // Resolved before the geometry swap so it still sees the outgoing texture.
        const nextTexturable = await adoptRiggedTexturable(riggedScene, riggedGeometry)
        applyGeometryUpdate(riggedGeometry, [], { pushUndo: true })
        if (nextTexturable) {
          setTexturableMesh(nextTexturable)
          setTextureRevision(0)
          // The layers were composited into the texture we uploaded, so they come
          // back baked into the result rather than as separate layers.
          setPaintLayers([])
          setSelectedLayerId(null)
        }
      }

      setSkeleton(rigSkeleton)
      setShowSkeleton(true)
      setSelectedBone(null)
      setRigEditDirty(false)
      rigUndoStackRef.current = []
      rigRedoStackRef.current = []
      rigEditCountRef.current = 0
      rigAddedBonesRef.current.clear()
      // Re-running Auto Rig replaces the skeleton, so anything the user had
      // edited is gone with it — the fresh rig becomes what Revert returns to.
      rigBaselineRef.current = adopted ? snapshotRig(nextRig, riggedGeometry) : null
      setRigCanUndo(false)
      setRigCanRedo(false)
      setRigRevision(current => current + 1)
      // The target skeleton changed — drop any cached target scene / mapping so
      // the Animations tab re-maps against the freshly-rigged bones.
      animTargetRef.current = null
      retargetedClipsRef.current.clear()
      resetAnimEdits()
      setAnimMapping(null)
      setBoneMappingRestored(false)
      setAnimClips([])
      setSelectedAnimation(null)
      setAnimPreview(null)
      setAnimArmTargets(null)
      setAnimArmExtension(0)
      setCheckedAnimations(new Set())

      const t = stats?.tool || {}
      const rows = []
      if (rigSkeleton?.jointCount != null) rows.push({ label: 'Bones', value: rigSkeleton.jointCount })
      else if (t.bones != null) rows.push({ label: 'Bones', value: t.bones })
      rows.push({ label: 'Bone names', value: autoRigOptions.rename_bones })
      rows.push({ label: 'Texture preserved', value: autoRigOptions.use_transfer ? 'Yes' : 'No' })
      if (autoRigOptions.use_postprocess) rows.push({ label: 'Postprocess', value: 'Voxel skin' })
      // `blobOnly` marks the case where the rig exists ONLY in the service's GLB:
      // the toolbar saves the editor's mesh, which does not have it, so the result
      // card has to offer its own save/download. Adopted rigs need neither.
      setAutoRigResult({ rows, blobOnly: !adopted })
      setFeedback(keptForTexture
        ? 'Auto Rig complete — the rigged mesh came back without UVs, so your textured mesh was kept as it is. Save or download the result to keep the rig; bone editing needs a rig the editor can adopt.'
        : 'Auto Rig complete.')
    } catch (err) {
      console.error('Auto Rig failed:', err)
      setError(err?.message || 'Auto Rig failed.')
    } finally {
      setAutoRigRunning(false)
      setAutoRigProgress(null)
    }
  }, [geometry, autoRigRunning, autoRigOptions, texturableMesh, applyGeometryUpdate, adoptRiggedTexturable, resetAnimEdits])

  const handleDismissRigResult = useCallback(() => {
    setAutoRigResult(null)
  }, [])

  // ── Bone editing (Skeleton panel → Edit) ─────────────────────────────────
  // Auto Rig gets joints wrong often enough — a shoulder inside the chest, a
  // knee above the kneecap, a fistful of weightless `Extra_*` bones — that the
  // rig needs correcting by hand rather than re-rolling the generator.

  // Editable only when both halves of the rig are present: the bone graph AND
  // the per-vertex weights that address it.
  const rigEditable = !!rigRef.current?.rigScene && geometryHasSkin(geometry)

  const rigInfluence = useMemo(
    () => {
      // rigRevision is the signal that the bone graph changed under the ref.
      const rig = rigRevision >= 0 ? rigRef.current : null
      // Weight painting reports the selected bone's share as well, so it is
      // computed for both rig sessions rather than for bone editing alone.
      return (rigEditing || weightPainting) && rig ? computeRigInfluence(rig, geometry) : null
    },
    [rigEditing, weightPainting, rigRevision, geometry],
  )

  const rigUnusedBones = useMemo(
    () => {
      const rig = rigRevision >= 0 ? rigRef.current : null
      if (!rigEditing || !rig || !rigInfluence) return []
      // A bone the user just added carries no weight by definition — offering to
      // sweep it away as junk seconds later would be absurd.
      const added = rigAddedBonesRef.current
      return findUnusedBones(rig, geometry, rigInfluence)
        .filter(index => !added.has(rig.boneNames[index]))
    },
    [rigEditing, rigRevision, rigInfluence, geometry],
  )

  // Cached retargets are keyed by the target skeleton, so any bone edit stales
  // them. A rename or a deletion also breaks the name-based bone mapping itself.
  const invalidateAnimationTarget = useCallback((mappingToo) => {
    animTargetRef.current = null
    retargetedClipsRef.current.clear()
    resetAnimEdits()
    setAnimPreview(null)
    setSelectedAnimation(null)
    if (mappingToo) {
      setAnimMapping(null)
      setBoneMappingRestored(false)
      setAnimClips([])
      setAnimArmTargets(null)
      setAnimArmExtension(0)
      setCheckedAnimations(new Set())
    }
  }, [resetAnimEdits])

  const pushRigSnapshot = useCallback(() => {
    const snapshot = snapshotRig(rigRef.current, geometry)
    if (!snapshot) return false
    const stack = rigUndoStackRef.current
    stack.push(snapshot)
    while (stack.length > 20) stack.shift()
    rigRedoStackRef.current = []
    setRigCanUndo(true)
    setRigCanRedo(false)
    return true
  }, [geometry])
  pushRigSnapshotRef.current = pushRigSnapshot

  // Refresh the overlay from the mutated bone graph and record the edit.
  const commitRigEdit = useCallback((message, { mappingToo = false, counted = true } = {}) => {
    const rig = rigRef.current
    if (!rig?.rigScene) return
    setSkeleton(extractSkeletonFromObject(rig.rigScene))
    setRigRevision(current => current + 1)
    if (counted) {
      rigEditCountRef.current += 1
      setRigEditDirty(true)
    }
    invalidateAnimationTarget(mappingToo)
    if (message) setFeedback(message)
  }, [invalidateAnimationTarget])
  commitRigEditRef.current = commitRigEdit

  // `live` moves come from the gizmo mid-drag: apply them to the bones so the
  // overlay tracks the handle, but don't record an edit until the drag ends.
  const handleRigBoneMove = useCallback((index, position, { live = false } = {}) => {
    const rig = rigRef.current
    if (!rig || index == null) return
    const moved = moveRigBone(
      rig,
      index,
      { x: position[0], y: position[1], z: position[2] },
      { moveChildren: rigMoveChildren },
    )
    if (!moved) return
    if (live) {
      setSkeleton(extractSkeletonFromObject(rig.rigScene))
      return
    }
    commitRigEdit(`Moved ${rig.boneNames[index] || 'bone'}.`)
  }, [rigMoveChildren, commitRigEdit])

  const handleRigBoneRename = useCallback((index, name) => {
    const rig = rigRef.current
    const current = rig?.boneNames?.[index]
    if (!rig || !name?.trim() || name.trim() === current) return
    if (!pushRigSnapshot()) return
    const applied = renameRigBone(rig, index, name)
    if (!applied) {
      rigUndoStackRef.current.pop()
      setRigCanUndo(rigUndoStackRef.current.length > 0)
      return
    }
    commitRigEdit(`Renamed ${current} to ${applied}.`, { mappingToo: true })
  }, [pushRigSnapshot, commitRigEdit])

  const handleRigBoneDelete = useCallback((indices) => {
    const rig = rigRef.current
    const list = (Array.isArray(indices) ? indices : [indices]).filter(i => i != null)
    if (!rig || !list.length) return
    if (!pushRigSnapshot()) return

    const result = deleteRigBones(rig, geometry, list)
    if (!result.removed) {
      rigUndoStackRef.current.pop()
      setRigCanUndo(rigUndoStackRef.current.length > 0)
      setError(result.blocked.length
        ? `${result.blocked.join(', ')} is a root bone — the rig hangs off it, so it can't be deleted.`
        : 'That bone could not be deleted.')
      return
    }

    if (result.geometry !== geometry) {
      // The weights moved to the parent bones; the rig undo stack owns the
      // rollback, so this must not push a second entry onto the modeling one.
      applyGeometryUpdate(result.geometry, [], { pushUndo: false })
    }
    setSelectedBone(null)
    commitRigEdit(
      result.removed === 1
        ? `Deleted ${result.removedNames[0]} — its weights moved to its parent.`
        : `Deleted ${result.removed} bones — their weights moved to their parents.`,
      { mappingToo: true },
    )
  }, [geometry, pushRigSnapshot, applyGeometryUpdate, commitRigEdit])

  const handleRigRemoveUnused = useCallback(() => {
    if (rigUnusedBones.length) handleRigBoneDelete(rigUnusedBones)
  }, [rigUnusedBones, handleRigBoneDelete])

  // Add a child under a bone and select it, so the gizmo is already on the new
  // joint and placing it is the next drag. It arrives with no influence — see
  // handleRigTakeWeights for giving it some.
  const handleRigAddChild = useCallback((index) => {
    const rig = rigRef.current
    if (!rig) return
    if (!pushRigSnapshot()) return
    const added = addChildBone(rig, index)
    if (!added || added.index < 0) {
      rigUndoStackRef.current.pop()
      setRigCanUndo(rigUndoStackRef.current.length > 0)
      setError('That bone could not be given a child.')
      return
    }
    rigAddedBonesRef.current.add(added.name)
    setSelectedBone(added.index)
    commitRigEdit(`Added ${added.name} — drag the gizmo to place it.`, { mappingToo: true })
  }, [pushRigSnapshot, commitRigEdit])

  const handleRigTakeWeights = useCallback((index) => {
    const rig = rigRef.current
    if (!rig) return
    if (!pushRigSnapshot()) return
    const result = takeWeightsFromParent(rig, geometry, index)
    if (!result.moved) {
      rigUndoStackRef.current.pop()
      setRigCanUndo(rigUndoStackRef.current.length > 0)
      setError(result.reason || 'No weights could be transferred to this bone.')
      return
    }
    applyGeometryUpdate(result.geometry, [], { pushUndo: false })
    commitRigEdit(`${rig.boneNames[index]} now moves ${result.moved} vertices, taken from its parent.`)
  }, [geometry, pushRigSnapshot, applyGeometryUpdate, commitRigEdit])

  // Undo/redo swap the current rig with a stored one — the geometry's weights
  // travel in the same snapshot, so the pair can never drift apart.
  const stepRigHistory = useCallback((fromStack, toStack, setFromEnabled, setToEnabled, delta) => {
    const snapshot = fromStack.current.pop()
    if (!snapshot) {
      setFromEnabled(false)
      return
    }
    const current = snapshotRig(rigRef.current, geometry)
    const restored = restoreRigSnapshot(snapshot, geometry)
    if (!restored) return
    if (current) toStack.current.push(current)

    // Keep the selection when the restored rig has the same bones: undoing a
    // brush stroke would otherwise deselect the bone being painted and blank the
    // heatmap mid-correction. Only a rename/add/delete really invalidates it.
    const sameBones = current?.rigScene
      && rigRef.current?.boneNames?.length === restored.rig.boneNames.length
      && rigRef.current.boneNames.every((name, i) => name === restored.rig.boneNames[i])

    rigRef.current = restored.rig
    if (restored.geometry !== geometry) applyGeometryUpdate(restored.geometry, [], { pushUndo: false })
    if (!sameBones) setSelectedBone(null)
    setFromEnabled(fromStack.current.length > 0)
    setToEnabled(true)
    rigEditCountRef.current = Math.max(0, rigEditCountRef.current + delta)
    setRigEditDirty(rigEditCountRef.current > 0)
    commitRigEdit(null, { mappingToo: true, counted: false })
  }, [geometry, applyGeometryUpdate, commitRigEdit])

  const handleRigUndo = useCallback(() => {
    stepRigHistory(rigUndoStackRef, rigRedoStackRef, setRigCanUndo, setRigCanRedo, -1)
  }, [stepRigHistory])

  const handleRigRedo = useCallback(() => {
    stepRigHistory(rigRedoStackRef, rigUndoStackRef, setRigCanRedo, setRigCanUndo, 1)
  }, [stepRigHistory])

  const handleRigRevert = useCallback(() => {
    const baseline = rigBaselineRef.current
    const restored = baseline ? restoreRigSnapshot(baseline, geometry) : null
    if (!restored) return
    rigRef.current = restored.rig
    if (restored.geometry !== geometry) applyGeometryUpdate(restored.geometry, [], { pushUndo: false })
    rigUndoStackRef.current = []
    rigRedoStackRef.current = []
    rigEditCountRef.current = 0
    rigAddedBonesRef.current.clear()
    setRigCanUndo(false)
    setRigCanRedo(false)
    setRigEditDirty(false)
    setSelectedBone(null)
    commitRigEdit('Skeleton reverted to how it was before editing.', { mappingToo: true, counted: false })
  }, [geometry, applyGeometryUpdate, commitRigEdit])

  // Moving bones and painting weights are two views of one rig-editing session:
  // they share the undo stack, the dirty flag and the Revert baseline, so a
  // stroke and a moved joint undo in the order they happened. Only the entry into
  // that session is shared here — the two are mutually exclusive on screen, so
  // whichever you switch to keeps the history the other one started.
  const beginRigSession = useCallback(() => {
    rigBaselineRef.current = snapshotRig(rigRef.current, geometry)
    rigUndoStackRef.current = []
    rigRedoStackRef.current = []
    rigEditCountRef.current = 0
    rigAddedBonesRef.current.clear()
    setRigCanUndo(false)
    setRigCanRedo(false)
    setRigEditDirty(false)
  }, [geometry])

  const handleToggleRigEdit = useCallback(() => {
    setRigEditing(prev => {
      const next = !prev
      // Entering with no session running: this rig is what Revert goes back to.
      if (next && !weightPainting) beginRigSession()
      return next
    })
    // The bone gizmo and the brush would otherwise fight over the same drag.
    setWeightPainting(false)
  }, [beginRigSession, weightPainting])

  const handleToggleWeightPaint = useCallback((next) => {
    setWeightPainting(prev => {
      const value = next == null ? !prev : !!next
      if (value && !rigEditing) beginRigSession()
      return value
    })
    setRigEditing(false)
    cancelWeightStroke()
    setWeightCursor(null)
  }, [beginRigSession, cancelWeightStroke, rigEditing])

  // Fill / Clear: the whole bone at once, for wiping an influence Auto Rig got
  // badly wrong before repainting it. One snapshot, one commit — same contract as
  // a stroke, so they interleave in the same history.
  const applyWeightFill = useCallback((value) => {
    if (weightBoneSkel < 0 || !geometryHasSkin(geometry)) return
    if (!pushRigSnapshotRef.current?.()) return
    const changed = fillBoneWeight(geometry, weightBoneSkel, value, weightNormalize, weightFallbackSkel)
    if (!changed) {
      rigUndoStackRef.current.pop()
      setRigCanUndo(rigUndoStackRef.current.length > 0)
      setFeedback(value > 0 ? 'This bone already covers the whole mesh.' : 'This bone moves nothing already.')
      return
    }
    refreshWeightHeatmap()
    const name = rigRef.current?.boneNames?.[selectedBone] || 'bone'
    commitRigEditRef.current?.(value > 0
      ? `${name} now moves the whole mesh (${changed} vertices).`
      : `Cleared ${name} from ${changed} vertices — its share went back to the other bones.`)
  }, [geometry, refreshWeightHeatmap, selectedBone, weightBoneSkel, weightFallbackSkel, weightNormalize])

  // The heatmap is drawn on a geometry of its own that SHARES position, normal
  // and index with the editable one and owns nothing but the colours.
  //
  // The `color` attribute deliberately does not go on `geometry` itself: it is
  // carried through the editable pipeline (see the attribute whitelist in
  // utils/meshEditor.js), so it would be written into every saved GLB as COLOR_0
  // and tint the mesh in every engine it was opened in afterwards.
  const weightPaintGeometry = useMemo(() => {
    const position = geometry?.attributes?.position
    if (!weightPainting || !position) return null

    const display = new THREE.BufferGeometry()
    display.setAttribute('position', position)
    if (geometry.attributes.normal) display.setAttribute('normal', geometry.attributes.normal)
    if (geometry.index) display.setIndex(geometry.index)

    // Colour it HERE, not in the effect below. React renders twice under
    // StrictMode and commits the second pass, so an effect that fills
    // the colours in afterwards can be writing into the copy that was thrown
    // away — which showed up as a mesh painted solid black. Built
    // coloured, the attribute is right in whichever pass survives, and the
    // effect only has to keep it up to date.
    const values = readBoneWeights(geometry, weightBoneSkelRef.current)
    const colors = new THREE.BufferAttribute(new Float32Array(position.count * 3), 3)
    writeWeightColors(colors.array, values)
    display.setAttribute('color', colors)

    weightValuesRef.current = values
    return display
  }, [weightPainting, geometry])

  // Assigned during render, so it always holds whichever geometry React last
  // produced — which is the one it commits.
  weightPaintGeometryRef.current = weightPaintGeometry

  // Dispose the PREVIOUS container when a new one replaces it, rather than in a
  // cleanup. Two reasons, both of which bit:
  //   * StrictMode runs every effect's cleanup once on mount, so a cleanup that
  //     disposes `weightPaintGeometry` would tear down the geometry that is
  //     still on screen;
  //   * a cleanup running after the memo had already published the replacement
  //     would tear down state the new geometry depends on.
  // Nothing is disposed on unmount, and the shared attributes are detached
  // before the container goes: BufferGeometry.dispose() frees the GPU buffer of
  // every attribute it holds, which for position/normal/index are the editable
  // geometry's own and still in use.
  const previousWeightGeometryRef = useRef(null)
  useEffect(() => {
    const previous = previousWeightGeometryRef.current
    if (previous && previous !== weightPaintGeometry) {
      previous.deleteAttribute('position')
      previous.deleteAttribute('normal')
      previous.setIndex(null)
      previous.dispose()
    }
    previousWeightGeometryRef.current = weightPaintGeometry
  }, [weightPaintGeometry])

  // Full recolour whenever the bone, the mesh or the weights change wholesale:
  // entering the mode, switching bone, undo/redo, Fill/Clear. A brush dab takes
  // the per-vertex path inside applyWeightStamp instead.
  useEffect(() => {
    if (weightPaintGeometry) refreshWeightHeatmap()
  }, [weightPaintGeometry, refreshWeightHeatmap, rigRevision])

  // Leaving Auto Rig, losing the rig, or an animation preview taking over the
  // viewport all mean there is nothing to paint on — drop the mode rather than
  // leave a brush armed over a mesh it can no longer edit.
  useEffect(() => {
    if (!weightPainting) return
    if (activeMenu !== 'autorig' || !rigEditable || animPreview) {
      cancelWeightStroke()
      setWeightCursor(null)
      setWeightPainting(false)
    }
  }, [weightPainting, activeMenu, rigEditable, animPreview, cancelWeightStroke])

  // Everything the Weight Painting section of the Auto Rig panel draws from.
  // Undo / Redo / Revert are the rig handlers unchanged — one session covers
  // bone edits and brush strokes alike.
  const weightPaintProps = useMemo(() => {
    const boneName = selectedBone != null ? (skeleton?.names?.[selectedBone] || null) : null
    // The vertex count is not decoration: a bone showing a share but moving no
    // vertices would mean the overlay→skeleton mapping had drifted, and a bone
    // moving thousands while the mesh renders flat means the fault is in the
    // display instead. Worth being able to tell those apart at a glance.
    let boneShare = null
    if (boneName && rigInfluence?.hasSkin) {
      const weight = rigInfluence.weights[selectedBone] || 0
      const moved = rigInfluence.counts[selectedBone] || 0
      const pct = rigInfluence.total > 0 ? (weight / rigInfluence.total) * 100 : 0
      const share = pct <= 0 ? '0%' : `${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%`
      boneShare = `${share} of the mesh, ${moved} ${moved === 1 ? 'vertex' : 'vertices'}`
    }

    return {
      available: rigEditable,
      active: weightPainting,
      onToggle: handleToggleWeightPaint,
      boneName,
      boneShare,
      fallbackName: weightFallbackSkel >= 0 && selectedBone != null
        ? (skeleton?.names?.[skeleton?.parents?.[selectedBone]] || null)
        : null,
      brush: weightBrush,
      onBrushChange: setWeightBrush,
      size: weightSize,
      sizeRange: weightSizeRange,
      onSizeChange: setWeightSize,
      strength: weightStrength,
      onStrengthChange: setWeightStrength,
      hardness: weightHardness,
      onHardnessChange: setWeightHardness,
      target: weightTarget,
      onTargetChange: setWeightTarget,
      frontOnly: weightFrontOnly,
      onFrontOnlyChange: setWeightFrontOnly,
      connectedOnly: weightConnectedOnly,
      onConnectedOnlyChange: setWeightConnectedOnly,
      normalize: weightNormalize,
      onNormalizeChange: setWeightNormalize,
      onFill: () => applyWeightFill(1),
      onClear: () => applyWeightFill(0),
      canUndo: rigCanUndo,
      canRedo: rigCanRedo,
      onUndo: handleRigUndo,
      onRedo: handleRigRedo,
      onRevert: handleRigRevert,
      dirty: rigEditDirty,
    }
  }, [
    applyWeightFill, handleRigRedo, handleRigRevert, handleRigUndo, handleToggleWeightPaint,
    rigCanRedo, rigCanUndo, rigEditDirty, rigEditable, rigInfluence, selectedBone, skeleton,
    weightBrush, weightConnectedOnly, weightFallbackSkel, weightFrontOnly, weightHardness, weightNormalize,
    weightPainting, weightSize, weightSizeRange, weightStrength, weightTarget,
  ])

  const handleRigGizmoDragStart = useCallback(() => {
    rigGizmoDragRef.current = true
    pushRigSnapshot()
  }, [pushRigSnapshot])

  const handleRigGizmoDrag = useCallback((position) => {
    handleRigBoneMove(selectedBone, [position.x, position.y, position.z], { live: true })
  }, [handleRigBoneMove, selectedBone])

  // Typed into the panel's X/Y/Z fields — one snapshot per committed value,
  // where a gizmo drag snapshots once at the start of the drag instead.
  const handleRigBonePosition = useCallback((index, position) => {
    if (!pushRigSnapshot()) return
    handleRigBoneMove(index, position)
  }, [pushRigSnapshot, handleRigBoneMove])

  const handleRigGizmoDragEnd = useCallback((position) => {
    rigGizmoDragRef.current = false
    handleRigBoneMove(selectedBone, [position.x, position.y, position.z])
  }, [handleRigBoneMove, selectedBone])

  // --- Animations: load the user's rigged mesh as an animatable skinned scene ---
  // Prefer the mesh as it currently stands — rig edits included — then the
  // freshly-rigged blob, then the mesh's source URL. Retargeting onto the
  // service's original blob would animate the skeleton the user just corrected.
  //
  // Reached through a ref because the exporter is defined further down the
  // component (it needs the texturable mesh), and a direct call here would read
  // it before initialisation.
  const buildRiggedResultBlobRef = useRef(null)
  const ensureAnimTargetScene = useCallback(async () => {
    if (animTargetRef.current) return animTargetRef.current
    const buildCurrent = buildRiggedResultBlobRef.current
    const riggedBlob = buildCurrent ? await buildCurrent() : riggedBlobRef.current
    const riggedBuffer = riggedBlob ? await riggedBlob.arrayBuffer() : null
    const target = await loadTargetScene({ riggedBuffer, modelUrl })
    animTargetRef.current = target
    return target
  }, [modelUrl])

  // --- Bone mappings that live on the mesh ---------------------------------
  // Mapping a source skeleton onto a rig is careful, fiddly work, and it stays
  // valid for as long as the rig does — so it is stored in the asset's metadata
  // and read back here, rather than redone from scratch every time the mesh is
  // opened to add another animation.

  // Read once per asset. The mesh-editor save route carries metadata onto every
  // new version, so a mapping made on one version is still on the next.
  const hydratedBoneMappingsForRef = useRef(null)
  useEffect(() => {
    const hasAsset = Number.isFinite(numericAssetId) && numericAssetId > 0
    const key = hasAsset ? `asset:${numericAssetId}` : (filePath ? `path:${filePath}` : '')
    if (!key) {
      storedBoneMappingsRef.current = null
      setStoredBoneMappings(null)
      setBoneMappingsDirty(false)
      return undefined
    }
    // The context's functions are rebuilt on every provider render, so the guard
    // — not the dependency list — is what makes this run once per mesh.
    if (hydratedBoneMappingsForRef.current === key) return undefined
    hydratedBoneMappingsForRef.current = key

    let cancelled = false
    let settled = false
    ;(async () => {
      try {
        const record = await getAssetRecord({
          assetId: hasAsset ? numericAssetId : null,
          filePath,
          type: 'mesh',
        })
        settled = true
        if (cancelled) return
        const raw = record?.metadata
        const metadata = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {})
        const mappings = metadata?.boneMappings && typeof metadata.boneMappings === 'object'
          ? metadata.boneMappings
          : null
        storedBoneMappingsRef.current = mappings
        setStoredBoneMappings(mappings)
        setBoneMappingsDirty(false)
      } catch (err) {
        // Not being able to read them is not a reason to stop: the tab still
        // works, it just starts from an unmapped skeleton.
        settled = true
        console.warn('Could not read the bone mappings saved with this mesh:', err)
      }
    })()
    // StrictMode mounts, tears down and mounts again. Without RELEASING the guard
    // here, that sequence loses the read entirely: the first run starts the fetch
    // and is then cancelled, and the second run skips because the guard already
    // names this mesh — so the mapping silently never arrives, which is exactly
    // how this shipped broken.
    return () => {
      cancelled = true
      if (!settled) hydratedBoneMappingsForRef.current = null
    }
  }, [numericAssetId, filePath, getAssetRecord])

  // Which key a mapping is filed under: the animation SOURCE it belongs to.
  const mappingStorageKey = useCallback((referenceId) => {
    if (!referenceId) return null
    // Custom animations key by the RIG they were authored on, not by the clip, so
    // mapping one maps every animation saved off the same skeleton.
    if (referenceId === CUSTOM_SOURCE_ID) {
      return customRigKeyRef.current ? customMappingKey(customRigKeyRef.current) : null
    }
    // MoCap has no mapping to remember: the service is conditioned on this rig and
    // returns our own bone names, so the mapping is computed, not authored — and
    // it is re-filtered live by the "what the capture drives" toggles.
    if (referenceId === MOCAP_SOURCE_ID) return null
    return referenceId
  }, [])

  const rememberBoneMapping = useCallback((referenceId, mapping) => {
    const key = mappingStorageKey(referenceId)
    if (!key || !mapping || !Object.keys(mapping).length) return
    const next = { ...(storedBoneMappingsRef.current || {}), [key]: mapping }
    storedBoneMappingsRef.current = next
    setStoredBoneMappings(next)
    // Nothing has written it to the mesh yet — that is what Save does.
    setBoneMappingsDirty(true)
  }, [mappingStorageKey])

  // A stored mapping is only worth restoring if it still addresses THIS rig and
  // THIS source: bones get renamed, deleted and re-rigged under it. Pairs that no
  // longer resolve are dropped, and a mapping that lost more than half of itself
  // is treated as belonging to a different skeleton — restoring a shredded one
  // would animate a handful of bones and look like a bug, where an empty mapping
  // at least says plainly that the bones need mapping.
  const restoreBoneMapping = useCallback((referenceId, sourceNames, targetNames) => {
    const key = mappingStorageKey(referenceId)
    const stored = key ? storedBoneMappingsRef.current?.[key] : null
    if (!stored) return null
    const targets = new Set(targetNames || [])
    const sources = new Set(sourceNames || [])
    const usable = {}
    for (const [target, source] of Object.entries(stored)) {
      if (targets.has(target) && sources.has(source)) usable[target] = source
    }
    const kept = Object.keys(usable).length
    return kept && kept * 2 >= Object.keys(stored).length ? usable : null
  }, [mappingStorageKey])

  // Put a mapping into play: the arm controls and the clip list both hang off it.
  const applyAnimMapping = useCallback((mapping, source) => {
    setAnimMapping(mapping)
    setAnimArmTargets(findUpperArmTargets(mapping))
    setAnimClips((source?.clips || []).map(c => ({ name: c.name })))
  }, [])

  const handleSelectAnimReference = useCallback(async (referenceId) => {
    setAnimReferenceId(referenceId)
    setAnimMapping(null)
    setBoneMappingRestored(false)
    setBoneMapSkeletons(null)
    setAnimClips([])
    setSelectedAnimation(null)
    setAnimPreview(null)
    setAnimError(null)
    setCheckedAnimations(new Set())
    animSourceRef.current = null
    customRigKeyRef.current = null
    retargetedClipsRef.current.clear()
    resetAnimEdits()
    if (!referenceId) return
    setAnimLoading(true)
    try {
      const [source] = await Promise.all([loadReferenceScene(referenceId), ensureAnimTargetScene()])
      animSourceRef.current = source
      // The mesh remembers how this reference was mapped onto it last time, so
      // picking it again goes straight to the clip list instead of the modal.
      const restored = restoreBoneMapping(referenceId, source.boneNames, animTargetRef.current?.boneNames)
      if (restored) applyAnimMapping(restored, source)
      setBoneMappingRestored(!!restored)
    } catch (err) {
      console.error('Failed to load animation reference:', err)
      setAnimError(err?.message || 'Failed to load the animation reference.')
      setAnimReferenceId('')
    } finally {
      setAnimLoading(false)
    }
  }, [ensureAnimTargetScene, resetAnimEdits, restoreBoneMapping, applyAnimMapping])

  // `referenceIdOverride` exists because of a stale-closure trap: the Kimodo tab
  // calls ensureKimodoSource() (which setAnimReferenceId's to 'kimodo') and then
  // this, in the same tick. The `animReferenceId` captured in THIS render is
  // still the old value, so the guard below used to bail on the first click and
  // only work on the second. Callers that just changed the reference pass it in.
  const handleOpenBoneMapping = useCallback(async (referenceIdOverride = null) => {
    const referenceId = referenceIdOverride || animReferenceId
    if (!referenceId) return
    setAnimError(null)
    // Reference + target were loaded on selection, but re-ensure in case of a
    // fresh rig since then.
    if (!animSourceRef.current || !animTargetRef.current) {
      setAnimLoading(true)
      try {
        if (!animSourceRef.current && referenceId === CUSTOM_SOURCE_ID) {
          // Its skeleton lives in the stored document, so there is nothing to
          // reload here — the animation has to be picked first.
          setAnimError('Pick a saved animation first — its skeleton is what gets mapped.')
          setAnimLoading(false)
          return
        }
        if (!animSourceRef.current) {
          animSourceRef.current = referenceId === KIMODO_SOURCE_ID
            ? await loadKimodoSkeletonSource()
            : await loadReferenceScene(referenceId)
        }
        await ensureAnimTargetScene()
      } catch (err) {
        console.error('Failed to prepare bone mapping:', err)
        setAnimError(err?.message || 'Failed to prepare bone mapping.')
        setAnimLoading(false)
        return
      }
      setAnimLoading(false)
    }

    // Build the plain skeleton data (joints/segments/names) that feeds the modal's
    // two 3D bone views. Source prefers the clean skeleton-only rig GLB (same bone
    // names as the animation GLB, no skinned mesh); falls back to the loaded
    // reference scene. Target comes from the user's loaded rigged scene.
    let source = null
    // Kimodo has no rig GLB — its source scene IS a bare armature parsed from the
    // service's rest-pose BVH, so go straight to the fallback below.
    // A custom animation is in the same position: its skeleton is the one stored
    // in its document, and there is no separate rig file for it either.
    if (referenceId !== KIMODO_SOURCE_ID && referenceId !== CUSTOM_SOURCE_ID) {
      try {
        const rig = await loadReferenceRigScene(referenceId)
        source = extractSkeletonFromObject(rig.scene)
      } catch (err) {
        console.warn('Rig GLB unavailable, using the animation scene skeleton:', err)
      }
    }
    if (!source && animSourceRef.current?.scene) source = extractSkeletonFromObject(animSourceRef.current.scene)
    // Show only what can actually be mapped. Kimodo's scene carries all 77 SOMA
    // joints because the FK chain needs them, but boneNames is the 23 the model
    // animates — leaving the other 54 in the 3D view made the picture disagree
    // with the list next to it, which reads as a bug rather than a restriction.
    if (source && animSourceRef.current?.boneNames?.length) {
      source = filterSkeleton(source, animSourceRef.current.boneNames) || source
    }
    const target = animTargetRef.current?.scene ? extractSkeletonFromObject(animTargetRef.current.scene) : null
    setBoneMapSkeletons({ source, target })

    setShowBoneMapping(true)
  }, [animReferenceId, ensureAnimTargetScene])

  const handleAutoMapBones = useCallback(() => {
    const source = animSourceRef.current
    const target = animTargetRef.current
    if (!source || !target) return {}
    // A custom animation gets the identity-first matcher: it usually came off a
    // rig named exactly like this one, where an exact name beats the heuristic.
    if (animReferenceId === CUSTOM_SOURCE_ID) return mapCustomBones(source.boneNames, target.boneNames)
    return autoMapBones(source.boneNames, target.boneNames, animReferenceId)
  }, [animReferenceId])

  const handleSaveBoneMapping = useCallback((mapping) => {
    // Stored on the mesh (written out by the next save), so the next session
    // that opens it can retarget straight away.
    rememberBoneMapping(animReferenceId, mapping)
    setBoneMappingRestored(false)
    setAnimMapping(mapping)
    setAnimArmTargets(findUpperArmTargets(mapping))
    // The user has now seen and accepted the mapping, so stop calling it automatic.
    setKimodoAutoMapped(false)
    setCustomAutoMapped(false)
    setShowBoneMapping(false)
    const clips = animSourceRef.current?.clips || []
    setAnimClips(clips.map(c => ({ name: c.name })))
    setSelectedAnimation(null)
    setAnimPreview(null)
    // A re-map invalidates every retargeted clip (they were baked against the old
    // mapping) and any pending Save selection — hand edits included: they were made
    // on top of the old mapping's bake.
    retargetedClipsRef.current.clear()
    resetAnimEdits()
    setCheckedAnimations(new Set())
  }, [resetAnimEdits, rememberBoneMapping, animReferenceId])

  // Retarget a reference clip onto the target skeleton, memoised by clip name so
  // playback and Save reuse the same bake. Returns the THREE.AnimationClip.
  // `matchRestPose` and `inPlace` are parameters rather than read from state so a
  // toggle can rebake with its new value without waiting for the state update to
  // land. Both invalidate every cached bake, so their toggles clear the cache.
  const getRetargetedClip = useCallback(async (
    clipName, matchRestPose = animMatchRestPose, inPlace = animInPlace,
    mappingOverride = null,
  ) => {
    // `mappingOverride` is here for the same reason matchRestPose and inPlace
    // are parameters: a toggle that changes the MAPPING (the MoCap "what the
    // capture drives" chains) must rebake with its new value, and setState has
    // not landed yet when it calls. Reading animMapping from the closure would
    // rebake with the previous set — visibly one toggle behind.
    const activeMapping = mappingOverride || animMapping
    // A hand-edited clip is authoritative and is never rebaked behind the user's
    // back: it lives outside the bake cache, so it survives every clear a bake
    // toggle triggers. Only Revert (or a rig/mapping change) gives it back.
    const edited = editedClipsRef.current.get(clipName)
    if (edited) return edited
    const cached = retargetedClipsRef.current.get(clipName)
    if (cached) return cached
    const source = animSourceRef.current
    const target = animTargetRef.current
    if (!source || !target || !activeMapping) return null
    const clip = source.clips.find(c => c.name === clipName)
    if (!clip) return null
    // Let the spinner paint before the (synchronous) frame-by-frame bake.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    // In-place is a post-process on the SOURCE clip, upstream of the retarget: the
    // retargeter reads the source hips' world position each frame, so stripping the
    // travel here is all it takes for it to be gone from the hip track it writes —
    // and from the animated GLB, which is baked from these same clips. `source.clips`
    // keeps the travelling original, so turning the toggle back off restores it.
    const sourceClip = inPlace ? makeClipInPlace(clip, source.hipName) : clip
    const retargeted = retargetAnimationClip({
      targetScene: target.scene,
      targetSkinnedMesh: target.skinnedMesh,
      sourceScene: source.scene,
      sourceSkinnedMesh: source.skinnedMesh,
      clip: sourceClip,
      mapping: activeMapping,
      matchRestPose,
    })
    // Hold the fingers in a fixed pose. Only useful for Kimodo, whose clips carry
    // no finger motion at all — withHandPose leaves alone any finger a clip does
    // animate, so applying it to a library clip is harmless.
    const posed = withHandPose(retargeted, {
      targetScene: target.scene,
      targetSkinnedMesh: target.skinnedMesh,
      mapping: activeMapping,
      curl: {
        left: handCurl.left / 100,
        right: handCurl.right / 100,
        leftThumb: handCurl.leftThumb / 100,
        rightThumb: handCurl.rightThumb / 100,
        thumbAxis: handCurl.thumbAxis,
        thumbFlip: handCurl.thumbFlip,
      },
    })
    retargetedClipsRef.current.set(clipName, posed)
    return posed
  }, [animMapping, animMatchRestPose, animInPlace, handCurl])

  // Bake a clip and put it on screen. Shared by clicking a clip and by the
  // rest-pose / in-place toggles, which have to rebuild whatever is already playing.
  const showRetargetedClip = useCallback(async (clipName, matchRestPose, inPlace, mappingOverride = null) => {
    const target = animTargetRef.current
    if (!animSourceRef.current || !target || !(mappingOverride || animMapping)) return
    setAnimRetargeting(clipName)
    setAnimError(null)
    try {
      const retargeted = await getRetargetedClip(clipName, matchRestPose, inPlace, mappingOverride)
      if (!retargeted) throw new Error('Animation clip not found.')
      setAnimPreview({
        scene: target.scene,
        skinnedMesh: target.skinnedMesh,
        clip: retargeted,
        // Matching the rest pose moves the mesh (closed legs make a character
        // taller), so the bake remeasures the floor offset for the pose it used.
        floorOffset: retargeted.userData?.floorOffset ?? target.floorOffset ?? 0,
      })
    } catch (err) {
      console.error('Failed to retarget animation:', err)
      setAnimError(err?.message || 'Failed to retarget the animation.')
      setSelectedAnimation(null)
      setAnimPreview(null)
    } finally {
      setAnimRetargeting(null)
    }
  }, [animMapping, getRetargetedClip])

  const handleSelectAnimation = useCallback(async (clipName) => {
    // Toggle off if the same clip is clicked again.
    if (selectedAnimation === clipName) {
      setSelectedAnimation(null)
      setAnimPreview(null)
      return
    }
    if (!animSourceRef.current || !animTargetRef.current || !animMapping) return
    setSelectedAnimation(clipName)
    await showRetargetedClip(clipName, animMatchRestPose)
  }, [selectedAnimation, animMapping, animMatchRestPose, showRetargetedClip])

  // The hand pose is baked into each clip, so every cached bake is stale.
  const handleHandCurlChange = useCallback((side, value) => {
    setHandCurl(prev => ({ ...prev, [side]: value }))
    retargetedClipsRef.current.clear()
  }, [])

  // Rebake whatever is playing once the slider settles, so the curl is visible
  // without having to re-click the clip. Deferred to pointer-up by the panel.
  const handleHandCurlCommit = useCallback(() => {
    if (selectedAnimation) void showRetargetedClip(selectedAnimation, animMatchRestPose)
  }, [selectedAnimation, animMatchRestPose, showRetargetedClip])

  // Every cached bake was measured against the old rest pose, so they all go.
  const handleToggleMatchRestPose = useCallback(() => {
    const next = !animMatchRestPose
    setAnimMatchRestPose(next)
    retargetedClipsRef.current.clear()
    if (selectedAnimation) void showRetargetedClip(selectedAnimation, next)
  }, [animMatchRestPose, selectedAnimation, showRetargetedClip])

  // The travel is stripped during the bake, so every cached bake is stale too —
  // and, unlike the generation flag this replaced, flipping it back restores the
  // travel: the source clips were never modified.
  const handleToggleInPlace = useCallback(() => {
    const next = !animInPlace
    setAnimInPlace(next)
    retargetedClipsRef.current.clear()
    if (selectedAnimation) void showRetargetedClip(selectedAnimation, animMatchRestPose, next)
  }, [animInPlace, animMatchRestPose, selectedAnimation, showRetargetedClip])

  // --- Animation edit dock ---------------------------------------------------

  // Everything the dock needs about the clip on screen: the frame grid and one row
  // per animated bone. Recomputed only when the clip OBJECT changes — value edits
  // mutate it in place and are picked up through `animEditRevision` instead.
  const animEditDescription = useMemo(
    () => (animPreview?.clip ? describeClip(animPreview.clip) : null),
    [animPreview?.clip],
  )

  // Every bone of the rig being animated, in hierarchy order — NOT only the ones
  // the clip drives. The reference a clip was retargeted from rarely covers a whole
  // rig (a tail, an ear, Auto Rig's leftover `extra_*` bones map to nothing), and
  // those bones were unreachable while the dock listed the clip's tracks alone.
  // Read off the skeleton the mixer is playing, which is what a track name has to
  // resolve against.
  const animAllBones = useMemo(
    () => animPreview?.skinnedMesh?.skeleton?.bones?.map(b => b.name) || [],
    [animPreview],
  )


  // Single source of truth for "the dock is on screen": the canvas shell shrinks by
  // exactly the dock's height, so if this and the dock's own render condition ever
  // disagreed the column would overflow the page — which is the bug that put the
  // dock here in the first place.
  const animEditDocked = activeMenu === 'autorig' && animEditOpen && !!animPreview?.clip && !!animEditDescription

  // The skeleton (and its bone labels) is only ever information for rigging, and it
  // draws through the surface — in Sculpting or Painting it is a bright cage over
  // whatever you are working on. So it lives with its mode: the toggle stays where
  // the user left it, but nothing outside Auto Rig (its Animations / Kimodo / MoCap
  // tabs included) draws it.
  const skeletonVisible = showSkeleton && activeMenu === 'autorig'

  // Clamp the frame into the new clip's range rather than resetting to 0, so
  // stepping through one clip and switching to another keeps you roughly in place.
  useEffect(() => {
    if (!animEditDescription) return
    setAnimEditFrame(f => Math.max(0, Math.min(animEditDescription.frameCount - 1, f)))
  }, [animEditDescription])

  // Default the dock's bone to the hips (the one bone that always carries both
  // tracks), and keep it valid when the clip changes.
  useEffect(() => {
    const bones = animEditDescription?.bones
    if (!bones?.length) return
    setAnimEditBone(prev => (prev && bones.some(b => b.boneName === prev)
      ? prev
      : (bones.find(b => b.position)?.boneName || bones[0].boneName)))
  }, [animEditDescription])

  // Bone selection is shared with the skeleton tree and the viewport: picking a
  // bone on the mesh selects it in the dock too.
  useEffect(() => {
    if (selectedBone == null) return
    const name = skeleton?.names?.[selectedBone]
    if (!name) return
    if (animEditDescription?.bones?.some(b => b.boneName === name)) setAnimEditBone(name)
  }, [selectedBone, skeleton, animEditDescription])

  const handleAnimEditSelectBone = useCallback((boneName) => {
    setAnimEditBone(boneName)
    const index = skeleton?.names?.indexOf(boneName)
    if (index != null && index >= 0) setSelectedBone(index)
  }, [skeleton])

  const historyFor = useCallback((clipName) => {
    let history = animEditHistoryRef.current.get(clipName)
    if (!history) {
      history = { undo: [], redo: [] }
      animEditHistoryRef.current.set(clipName, history)
    }
    return history
  }, [])

  const syncAnimEditCounts = useCallback((clipName) => {
    const history = animEditHistoryRef.current.get(clipName)
    setAnimEditUndoCount(history?.undo.length || 0)
    setAnimEditRedoCount(history?.redo.length || 0)
  }, [])

  useEffect(() => { syncAnimEditCounts(selectedAnimation) }, [selectedAnimation, syncAnimEditCounts])

  // Opening the dock pauses the preview: the point is to hold ONE pose while you
  // correct it. Closing hands playback back.
  const handleLiveJoints = useCallback((names, positions) => {
    liveJointsRef.current = { names, positions }
  }, [])

  // A new clip (or none) means the last frame's joints describe a mesh that is no
  // longer on screen — the picker must not hit-test them while waiting for a frame.
  useEffect(() => { liveJointsRef.current = null }, [animPreview])

  useEffect(() => { animClipRef.current = animPreview?.clip || null }, [animPreview])

  const handleToggleAnimEdit = useCallback(() => {
    setAnimEditOpen(prev => {
      setAnimPlaying(prev)
      // Opening the dock means picking bones off the mesh, which is impossible when
      // they are not drawn. The checkbox still governs from here on.
      if (!prev) setShowSkeleton(true)
      return !prev
    })
  }, [])

  // Free playback stopped wherever it stopped; convert that to a frame so the dock
  // resumes from the pose on screen instead of the last scrubbed frame.
  const handleAnimPausedAt = useCallback((time) => {
    const description = animEditDescription
    if (!description) return
    const frame = Math.round((Number(time) || 0) * description.fps)
    setAnimEditFrame(Math.max(0, Math.min(description.frameCount - 1, frame)))
  }, [animEditDescription])

  // One value edit: mutate the live clip, mark it hand-edited, remember how to put
  // it back. The mesh updates on the next frame — a paused action keeps re-applying
  // the clip's values, so nothing has to be rebuilt.
  const handleAnimEditValue = useCallback((trackName, nextXYZ) => {
    const clipName = selectedAnimation
    const clip = animPreview?.clip
    if (!clipName || !clip || animPlaying) return
    const result = applyFrameEdit(clip, trackName, animEditFrame, nextXYZ, {
      scope: animEditScope, span: animEditSpan,
    })
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    history.undo.push({ trackName, before: result.before, after: result.after })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, animPreview, animPlaying, animEditFrame, animEditScope, animEditSpan,
    historyFor, syncAnimEditCounts])

  // Add / insert / delete / trim frames. Unlike a value edit this changes the track
  // LENGTHS, so the arrays cannot be written in place: a new clip is built and swapped
  // into the preview, which rebuilds the mixer's action (AnimatedMeshPreview restores
  // the playhead afterwards, so the swap is invisible). History therefore holds whole
  // clips for these — tens of KB each, against ~2 KB for a value edit.
  const handleAnimFrameOperation = useCallback((operation) => {
    const clipName = selectedAnimation
    const clip = animPreview?.clip
    if (!clipName || !clip || animPlaying) return
    const result = applyFrameOperation(clip, operation, animEditFrame)
    if (!result) return
    editedClipsRef.current.set(clipName, result.clip)
    // The bake cache would otherwise keep the pre-edit object alive for nothing —
    // `getRetargetedClip` reads the edited map first either way.
    retargetedClipsRef.current.delete(clipName)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    history.undo.push({ kind: 'clip', before: clip, after: result.clip })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimPreview(prev => (prev ? { ...prev, clip: result.clip } : prev))
    setAnimEditFrame(result.frame)
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, animPreview, animPlaying, animEditFrame, historyFor, syncAnimEditCounts])

  // Copy the whole frame — every animated bone's rotation plus the hip position — so
  // it can be pasted onto another frame (of this clip or another). The pose is a
  // snapshot: editing the source frame afterwards does not change what was copied.
  const handleAnimCopyPose = useCallback(() => {
    const clip = animPreview?.clip
    if (!clip || animPlaying) return
    const pose = copyFramePose(clip, animEditFrame)
    if (!pose) return
    animPoseRef.current = pose
    setAnimPoseLabel({ frame: pose.frame, clipName: selectedAnimation, bones: pose.tracks.length })
  }, [animPreview, animPlaying, animEditFrame, selectedAnimation])

  // Paste it onto the current frame. In place, like a value edit — the tracks keep
  // their length, so nothing has to be rebuilt. Honours "Apply to": at falloff the
  // neighbours are blended towards the pose so it arrives without a pop, which is
  // exactly what closing a loop wants.
  const handleAnimPastePose = useCallback(() => {
    const clipName = selectedAnimation
    const clip = animPreview?.clip
    const pose = animPoseRef.current
    if (!clipName || !clip || !pose || animPlaying) return
    const result = pasteFramePose(clip, pose, animEditFrame, {
      scope: animEditScope, span: animEditSpan,
    })
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    // One undo entry for the whole paste: a pose spans every animated bone, and
    // undoing it a track at a time would leave the mesh in a pose that never existed.
    history.undo.push({ kind: 'tracks', entries: result.entries })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, animPreview, animPlaying, animEditFrame, animEditScope, animEditSpan,
    historyFor, syncAnimEditCounts])

  // The live bone the gizmo edits: the dock's selection, resolved against the skeleton
  // actually being played (not the rest-pose snapshot the tree is built from).
  const animGizmoBone = useMemo(() => {
    if (!animEditOpen || animPlaying || !animPreview?.skinnedMesh) return null
    const name = selectedBone != null ? skeleton?.names?.[selectedBone] : animEditBone
    if (!name) return null
    return animPreview.skinnedMesh.skeleton.getBoneByName(name) || null
  }, [animEditOpen, animPlaying, animPreview, selectedBone, skeleton, animEditBone])

  // A drag begins: work out which track it writes to, create a position track if the
  // bone has none (every key at the rest position, so nothing moves until the drag
  // does), and snapshot the track for a single undo entry at the end.
  //
  // The clip is swapped through `animClipRef` synchronously as well as through state:
  // the drag's own events arrive before React has committed the new preview, and they
  // must write to the clip that now carries the new track.
  const handleGizmoDragStart = useCallback((mode) => {
    const clipName = selectedAnimation
    const bone = animGizmoBone
    let clip = animClipRef.current
    if (!clipName || !clip || !bone) return
    const description = describeClip(clip)
    const row = description?.bones.find(b => b.boneName === bone.name)
    // A bone with no tracks at all has no row; only a LOCKED row is refused.
    if (row && !row.editable) return

    let trackName = mode === 'translate' ? row?.position : row?.rotation
    if (!trackName) {
      // The bone's current local transform is its rest one — the mixer only writes
      // what a track drives — so the new track holds the pose the clip already
      // shows, and the drag about to happen is the first thing that changes it.
      const created = mode === 'translate'
        ? ensurePositionTrack(clip, bone.name, bone.position.toArray())
        : ensureRotationTrack(clip, bone.name, bone.quaternion.toArray())
      if (!created) return
      clip = created.clip
      trackName = created.trackName
      animClipRef.current = clip
      editedClipsRef.current.set(clipName, clip)
      retargetedClipsRef.current.delete(clipName)
      setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
      setAnimPreview(prev => (prev ? { ...prev, clip } : prev))
      setAnimEditRevision(r => r + 1)
    }

    if (!trackName) return
    const track = clip.tracks.find(t => t.name === trackName)
    if (!track) return
    animGizmoDragRef.current = { clipName, trackName, before: Float32Array.from(track.values) }
  }, [selectedAnimation, animGizmoBone])

  // Each drag event: the proxy's WORLD transform, converted into the bone's own space
  // (what the track stores), written at the current frame with the usual falloff. No
  // history entry — the whole drag becomes one at drag end.
  const handleGizmoDrag = useCallback((proxy, mode) => {
    const drag = animGizmoDragRef.current
    const clip = animClipRef.current
    const bone = animGizmoBone
    if (!drag || !clip || !bone?.parent) return
    const options = { scope: animEditScope, span: animEditSpan }
    if (mode === 'translate') {
      // A track's position is local to the PARENT bone, so undo the parent's full
      // world transform — not just its rotation.
      const local = proxy.position.clone().applyMatrix4(
        gizmoMatrixRef.current.copy(bone.parent.matrixWorld).invert())
      if (!applyFramePosition(clip, drag.trackName, animEditFrame, local.toArray(), options)) return
    } else {
      const parentWorld = bone.parent.getWorldQuaternion(gizmoQuatRef.current).invert()
      const local = parentWorld.multiply(proxy.quaternion)
      if (!applyFrameRotation(clip, drag.trackName, animEditFrame, local.toArray(), options)) return
    }
    setAnimEditedClips(prev => (prev.has(drag.clipName) ? prev : new Set(prev).add(drag.clipName)))
    editedClipsRef.current.set(drag.clipName, clip)
    setAnimEditRevision(r => r + 1)
  }, [animGizmoBone, animEditFrame, animEditScope, animEditSpan])

  // One undo entry for the whole drag, and only if it actually moved something.
  const handleGizmoDragEnd = useCallback(() => {
    const drag = animGizmoDragRef.current
    animGizmoDragRef.current = null
    const clip = animClipRef.current
    if (!drag || !clip) return
    const track = clip.tracks.find(t => t.name === drag.trackName)
    if (!track || track.values.length !== drag.before.length) return
    let changed = false
    for (let i = 0; i < track.values.length; i++) {
      if (Math.abs(track.values[i] - drag.before[i]) > 1e-7) { changed = true; break }
    }
    if (!changed) return
    const history = historyFor(drag.clipName)
    history.undo.push({ kind: 'track', trackName: drag.trackName, before: drag.before, after: Float32Array.from(track.values) })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(drag.clipName)
  }, [historyFor, syncAnimEditCounts])

  // Give the selected bone a position track without dragging anything, so its
  // Position fields can be typed into. Not recorded in history: every key is the rest
  // position, so this changes nothing until an edit does.
  const handleAnimAddPositionTrack = useCallback(() => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    const bone = animGizmoBone
    if (!clipName || !clip || !bone) return
    const created = ensurePositionTrack(clip, bone.name, bone.position.toArray())
    if (!created) return
    animClipRef.current = created.clip
    editedClipsRef.current.set(clipName, created.clip)
    retargetedClipsRef.current.delete(clipName)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    setAnimPreview(prev => (prev ? { ...prev, clip: created.clip } : prev))
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, animGizmoBone])

  // Bring a bone the clip does not animate into it: a rotation track whose every
  // key is the bone's rest orientation. Nothing moves until an edit does — this
  // only gives the fields and the gizmo something to write to.
  //
  // `bone.quaternion` IS the rest orientation for such a bone: the mixer only ever
  // writes the properties a track drives, and the retarget leaves the skeleton in
  // its bind pose. (Same reasoning as `bone.position` for a position track.)
  //
  // Not recorded in history for the same reason as the position track: it changes
  // no pose. What it does change is the clip OBJECT, so the preview and the drag's
  // own ref are swapped synchronously.
  const handleAnimAddBone = useCallback((boneName) => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    const bone = animPreview?.skinnedMesh?.skeleton?.getBoneByName?.(boneName)
    if (!clipName || !clip || !bone) return
    const created = ensureRotationTrack(clip, boneName, bone.quaternion.toArray())
    if (!created) return
    animClipRef.current = created.clip
    editedClipsRef.current.set(clipName, created.clip)
    retargetedClipsRef.current.delete(clipName)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    setAnimPreview(prev => (prev ? { ...prev, clip: created.clip } : prev))
    setAnimEditBone(boneName)
    setAnimEditRevision(r => r + 1)
    setFeedback(`${boneName} is now part of this animation — pose it with the gizmo or the fields.`)
  }, [selectedAnimation, animPreview])

  // Clear one track's value at this frame: the frame takes the interpolation of its
  // neighbours, which is what deleting its key would look like without taking the
  // track off the frame grid.
  const handleAnimClearFrameValue = useCallback((trackName) => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    if (!clipName || !clip || animPlaying) return
    const result = clearFrameValue(clip, trackName, animEditFrame)
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    history.undo.push({ kind: 'track', trackName, before: result.before, after: result.after })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, animPlaying, animEditFrame, historyFor, syncAnimEditCounts])

  // The dopesheet's two rectangle operations. Both rewrite whole tracks in place —
  // the clip object the mixer is already playing — so the mesh shows the result on
  // the next frame with nothing to rebuild, and both land as ONE undo entry: half a
  // shifted block is a pose that never existed.
  const handleAnimDeleteRange = useCallback((trackNames, from, to) => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    if (!clipName || !clip || animPlaying || !trackNames?.length) return
    const result = flattenFrameRange(clip, trackNames, from, to)
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    history.undo.push({ kind: 'tracks', entries: result.entries })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
    const span = result.to - result.from + 1
    setFeedback(`Deleted ${span} frame${span === 1 ? '' : 's'} of keys on ${result.entries.length} track${result.entries.length === 1 ? '' : 's'} — they now interpolate across the gap.`)
  }, [selectedAnimation, animPlaying, historyFor, syncAnimEditCounts])

  const handleAnimShiftRange = useCallback((trackNames, from, to, delta) => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    if (!clipName || !clip || animPlaying || !trackNames?.length || !delta) return
    const result = shiftFrameRange(clip, trackNames, from, to, delta)
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    history.undo.push({ kind: 'tracks', entries: result.entries })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, animPlaying, historyFor, syncAnimEditCounts])

  // Stop the clip animating one bone entirely — the whole track flattened to the
  // bone's rest pose, rather than clearing rotation and position frame by frame.
  //
  // The rest pose is read off the live skeleton with `skeleton.pose()`, which is
  // the only place it exists (the clip carries poses, not the bind pose). Posing
  // the skeleton is safe here even mid-preview: the mixer re-applies the clip on
  // the very next frame, and the one bone it no longer drives is exactly the one
  // that should now be standing at rest.
  const handleAnimClearBone = useCallback((boneName) => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    if (!clipName || !clip || animPlaying || !boneName) return

    let rest = null
    const skeleton = animPreview?.skinnedMesh?.skeleton
    const bone = skeleton?.getBoneByName?.(boneName)
    if (bone) {
      skeleton.pose()
      rest = { rotation: bone.quaternion.toArray(), position: bone.position.toArray() }
    }

    const result = clearBoneAnimation(clip, boneName, rest)
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    // One entry for the bone, not one per track: undoing a cleared bone half way
    // would leave it rotating in place with its position pinned, or the reverse.
    history.undo.push({ kind: 'tracks', entries: result.entries })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
    setFeedback(`Cleared ${boneName}'s animation — it now holds its rest pose for the whole clip.`)
  }, [selectedAnimation, animPlaying, animPreview, historyFor, syncAnimEditCounts])

  // Make the clip loop without a hitch: the last frame becomes the value halfway
  // between the penultimate and the first, so the step the wrap produces matches the
  // step before it. Tracks whose seam gap is real motion (a travelling hip, a turn)
  // are left alone — see smoothLoopSeam.
  const handleAnimSmoothLoop = useCallback(() => {
    const clipName = selectedAnimation
    const clip = animClipRef.current
    if (!clipName || !clip || animPlaying) return
    const result = smoothLoopSeam(clip, { span: animSeamFrames })
    if (!result) return
    editedClipsRef.current.set(clipName, clip)
    setAnimEditedClips(prev => (prev.has(clipName) ? prev : new Set(prev).add(clipName)))
    const history = historyFor(clipName)
    // One entry: it touches every animated bone, and undoing it a track at a time
    // would leave the seam half-fixed.
    history.undo.push({ kind: 'tracks', entries: result.entries })
    if (history.undo.length > ANIM_EDIT_HISTORY_LIMIT) history.undo.shift()
    history.redo.length = 0
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
    // Park on the frame that changed, so the fix is visible rather than theoretical.
    const description = describeClip(clip)
    if (description) setAnimEditFrame(description.frameCount - 1)
  }, [selectedAnimation, animPlaying, animSeamFrames, historyFor, syncAnimEditCounts])

  const stepAnimEditHistory = useCallback((direction) => {
    const clipName = selectedAnimation
    const clip = clipName ? editedClipsRef.current.get(clipName) : null
    if (!clip) return
    const history = historyFor(clipName)
    const from = direction === 'undo' ? history.undo : history.redo
    const to = direction === 'undo' ? history.redo : history.undo
    const op = from.pop()
    if (!op) return
    if (op.kind === 'clip') {
      // A whole-clip swap: a frame was added, inserted, deleted or trimmed.
      const target = direction === 'undo' ? op.before : op.after
      editedClipsRef.current.set(clipName, target)
      retargetedClipsRef.current.delete(clipName)
      setAnimPreview(prev => (prev ? { ...prev, clip: target } : prev))
    } else if (op.kind === 'tracks') {
      // A pasted pose: every track it touched, restored together.
      for (const entry of op.entries) {
        restoreTrackValues(clip, entry.trackName, direction === 'undo' ? entry.before : entry.after)
      }
    } else {
      restoreTrackValues(clip, op.trackName, direction === 'undo' ? op.before : op.after)
    }
    to.push(op)
    syncAnimEditCounts(clipName)
    setAnimEditRevision(r => r + 1)
  }, [selectedAnimation, historyFor, syncAnimEditCounts])

  // Hand the clip back to the bake: drop the edit, drop the cached bake, re-run it
  // with whatever the bake settings are NOW (which is the only honest meaning of
  // "revert" once the rest-pose or in-place toggle has moved since the edit).
  const handleAnimRevertEdits = useCallback(async () => {
    const clipName = selectedAnimation
    if (!clipName || !editedClipsRef.current.has(clipName)) return
    editedClipsRef.current.delete(clipName)
    retargetedClipsRef.current.delete(clipName)
    animEditHistoryRef.current.delete(clipName)
    syncAnimEditCounts(clipName)
    setAnimEditedClips(prev => {
      if (!prev.has(clipName)) return prev
      const next = new Set(prev)
      next.delete(clipName)
      return next
    })
    setAnimEditRevision(r => r + 1)
    await showRetargetedClip(clipName, animMatchRestPose, animInPlace)
  }, [selectedAnimation, syncAnimEditCounts, showRetargetedClip, animMatchRestPose, animInPlace])

  const handleToggleAnimationChecked = useCallback((clipName) => {
    setCheckedAnimations(prev => {
      const next = new Set(prev)
      if (next.has(clipName)) next.delete(clipName)
      else next.add(clipName)
      return next
    })
  }, [])

  const handleSaveAnimations = useCallback(async () => {
    const names = animClips.map(c => c.name).filter(n => checkedAnimations.has(n))
    const target = animTargetRef.current
    if (!names.length || !target || animSaving) return
    try {
      setAnimSaving(true)
      setAnimError(null)
      setError('')
      setFeedback(`Baking ${names.length} animation${names.length === 1 ? '' : 's'}…`)
      const clips = []
      for (const name of names) {
        const clip = await getRetargetedClip(name)
        if (clip) clips.push(clip)
      }
      if (!clips.length) throw new Error('None of the selected animations could be retargeted.')
      setFeedback('Saving animated mesh…')
      const blob = await exportAnimatedGlb({ scene: target.scene, clips })
      const baseName = (meshName || 'mesh').trim() || 'mesh'
      const meshFile = new File([blob], `${baseName}-animated.glb`, { type: 'model/gltf-binary' })
      await saveMeshEdit({
        assetId: Number.isFinite(numericAssetId) && numericAssetId > 0 ? numericAssetId : null,
        filePath,
        name: `${baseName} (animated)`,
        saveMode: 'version',
        meshFile,
        // Whatever bone mappings this session made ride along in the asset's
        // metadata, so the version that comes out is ready to animate again.
        boneMappings: storedBoneMappingsRef.current,
      })
      setBoneMappingsDirty(false)
      setFeedback(`Saved mesh with ${clips.length} animation${clips.length === 1 ? '' : 's'} as a new version.`)
    } catch (err) {
      console.error('Failed to save animated mesh:', err)
      setAnimError(err?.message || 'Failed to save the animated mesh.')
    } finally {
      setAnimSaving(false)
    }
  }, [animClips, checkedAnimations, animSaving, getRetargetedClip, meshName, numericAssetId, filePath, saveMeshEdit])

  // --- Kimodo: take over the source-rig slot, then generate clips into it ---

  // Put the SOMA-77 skeleton in the source slot, replacing whatever reference was
  // there. Cheap: the service builds the rest pose from the skeleton asset alone,
  // so this does not load the checkpoint or the text encoder.
  const ensureKimodoSource = useCallback(async () => {
    if (animReferenceId === KIMODO_SOURCE_ID && animSourceRef.current) return animSourceRef.current
    // Switching source rigs invalidates the mapping and every bake made against it.
    setAnimMapping(null)
    setBoneMappingRestored(false)
    setBoneMapSkeletons(null)
    setAnimClips([])
    setSelectedAnimation(null)
    setAnimPreview(null)
    setCheckedAnimations(new Set())
    setKimodoAutoMapped(false)
    retargetedClipsRef.current.clear()
    resetAnimEdits()
    const source = await loadKimodoSkeletonSource()
    animSourceRef.current = source
    setAnimReferenceId(KIMODO_SOURCE_ID)
    return source
  }, [animReferenceId, resetAnimEdits])

  const handleKimodoOpenMapping = useCallback(async () => {
    setKimodoError(null)
    setAnimLoading(true)
    try {
      await ensureKimodoSource()
      await ensureAnimTargetScene()
    } catch (err) {
      console.error('Failed to prepare the Kimodo skeleton:', err)
      setKimodoError(err?.message || 'Failed to load the Kimodo skeleton.')
      setAnimLoading(false)
      return
    }
    setAnimLoading(false)
    await handleOpenBoneMapping(KIMODO_SOURCE_ID)
  }, [ensureKimodoSource, ensureAnimTargetScene, handleOpenBoneMapping])

  const handleKimodoGenerate = useCallback(async () => {
    if (kimodoRunning) return
    setKimodoRunning(true)
    setKimodoError(null)
    setKimodoProgress(null)
    try {
      const source = await ensureKimodoSource()
      const target = await ensureAnimTargetScene()

      // Map the bones automatically if this is the first generation. Without a
      // mapping the clip cannot be retargeted OR previewed, so generating first
      // used to produce a completed request and a visibly empty panel. The exact
      // SOMA->Mixamo table makes auto-mapping reliable for rigs Auto Rig
      // produced; the user can still refine it in the modal.
      let mapping = animMapping
      if (!mapping) {
        // A mapping the user made for Kimodo on an earlier visit is stored on
        // the mesh; prefer it over guessing again.
        mapping = restoreBoneMapping(KIMODO_SOURCE_ID, source.boneNames, target.boneNames)
        if (mapping) {
          setAnimMapping(mapping)
          setAnimArmTargets(findUpperArmTargets(mapping))
          setKimodoAutoMapped(false)
        }
      }
      if (!mapping) {
        mapping = autoMapBones(source.boneNames, target.boneNames, KIMODO_SOURCE_ID)
        if (Object.keys(mapping).length) {
          setAnimMapping(mapping)
          setAnimArmTargets(findUpperArmTargets(mapping))
          setKimodoAutoMapped(true)
        } else {
          mapping = null
        }
      }

      // Name clips by prompt, numbered — the same prompt twice is a different
      // take, and the clip name is the retarget cache key. No in-place marker in
      // the name: the clip travels, and playing it on the spot is a bake option
      // that can be flipped at any time.
      kimodoCounterRef.current += 1
      const label = kimodoPrompt.trim().replace(/\s+/g, ' ').slice(0, 48)
      const name = `${kimodoCounterRef.current}. ${label}`

      const { clip, bvh } = await generateMotionClip({
        prompt: kimodoPrompt,
        duration: kimodoDuration,
        name,
        onProgress: setKimodoProgress,
      })

      // Persist before anything else can go wrong. A generation is minutes of
      // GPU time; losing it to a retarget failure — or to the user navigating
      // away — is not acceptable, and the BVH is the mesh-independent artifact
      // worth keeping. A save failure must NOT fail the generation, though: the
      // clip is already in hand and usable.
      // Stored as generated, i.e. travelling: in-place is applied when the clip is
      // baked onto a mesh, so the saved motion stays usable both ways.
      saveMotion({ name, prompt: kimodoPrompt, bvh })
        .then(saved => setMotionLibrary(prev => [saved, ...prev]))
        .catch(err => {
          console.error('Could not save the generated motion:', err)
          setMotionLibError(err?.message || 'The motion was generated but could not be saved.')
        })

      source.clips = [...(source.clips || []), clip]
      setAnimClips(source.clips.map(c => ({ name: c.name })))

      // Auto-play only when the mapping was ALREADY in state before this call.
      // A mapping created a moment ago is not visible to showRetargetedClip yet
      // (it reads animMapping through its own closure), so the bake would silently
      // no-op. In that case the clip still lands in the gallery and plays on click.
      if (animMapping) {
        setSelectedAnimation(name)
        await showRetargetedClip(name, animMatchRestPose)
      }
    } catch (err) {
      console.error('Motion generation failed:', err)
      setKimodoError(err?.message || 'Motion generation failed.')
    } finally {
      setKimodoRunning(false)
      setKimodoProgress(null)
    }
  }, [kimodoRunning, kimodoPrompt, kimodoDuration, ensureKimodoSource,
    ensureAnimTargetScene, animMapping, animMatchRestPose, showRetargetedClip, restoreBoneMapping])

  // --- Saved motion library -------------------------------------------------
  // Generations are persisted server-side as BVH, so they survive leaving the
  // page and can be retargeted onto a different mesh later. Applying one costs a
  // fetch and a retarget: the Kimodo service is not involved at all.

  const refreshMotionLibrary = useCallback(async () => {
    setMotionLibLoading(true)
    try {
      setMotionLibrary(await listSavedMotions())
      setMotionLibError(null)
    } catch (err) {
      console.error('Could not load the motion library:', err)
      setMotionLibError(err?.message || 'Could not load the saved motions.')
    } finally {
      setMotionLibLoading(false)
    }
  }, [])

  // Load the catalogue once the Kimodo tab has taken the source slot. It is a
  // few hundred bytes per motion and no BVH, so this is cheap — but there is no
  // reason to fetch it for someone who never opens the tab.
  useEffect(() => {
    if (animReferenceId === KIMODO_SOURCE_ID) refreshMotionLibrary()
  }, [animReferenceId, refreshMotionLibrary])

  // Put saved motions into the current session's clip list, exactly where a
  // fresh generation would land. Takes a LIST: the picker applies a whole
  // selection, and one motion is just a list of one.
  const handleApplySavedMotions = useCallback(async motions => {
    const list = (Array.isArray(motions) ? motions : [motions]).filter(Boolean)
    if (!list.length || motionLibBusy) return
    setMotionLibBusy(true)
    setMotionLibProgress({ done: 0, total: list.length })
    setKimodoError(null)
    try {
      const source = await ensureKimodoSource()
      await ensureAnimTargetScene()

      // Names are the retarget cache key, so a motion applied twice in one
      // session must not collide with its earlier copy — nor with another in the
      // same batch, which is why `taken` is updated inside the loop.
      const taken = new Set((source.clips || []).map(c => c.name))
      const added = []
      for (const [index, motion] of list.entries()) {
        setMotionLibBusyId(motion.id)
        setMotionLibProgress({ done: index, total: list.length })
        let name = motion.name
        for (let n = 2; taken.has(name); n += 1) name = `${motion.name} (${n})`
        taken.add(name)
        added.push(await loadSavedMotionClip({ ...motion, name }))
      }

      source.clips = [...(source.clips || []), ...added]
      setAnimClips(source.clips.map(c => ({ name: c.name })))

      // Only the LAST one is retargeted and played. Baking all of them up front
      // would make applying a selection of twenty cost twenty retargets for
      // nineteen results nobody asked to see; the rest bake on click, as usual.
      const last = added[added.length - 1]
      if (animMapping && last) {
        setSelectedAnimation(last.name)
        await showRetargetedClip(last.name, animMatchRestPose)
      }
      setMotionLibOpen(false)
    } catch (err) {
      console.error('Could not apply the saved motion:', err)
      setKimodoError(err?.message || 'Could not apply that motion.')
    } finally {
      setMotionLibBusy(false)
      setMotionLibBusyId(null)
      setMotionLibProgress(null)
    }
  }, [motionLibBusy, ensureKimodoSource, ensureAnimTargetScene, animMapping,
    animMatchRestPose, showRetargetedClip])

  // Deletes STORED motions, not this session's clips: a clip already applied
  // keeps working until the page is left, which is the behaviour that does not
  // yank something out from under a preview that is mid-play.
  //
  // Each delete is independent, so one failure does not strand the rest — the
  // ones that went are removed from the list and the failure is reported.
  const handleDeleteSavedMotions = useCallback(async motions => {
    const list = (Array.isArray(motions) ? motions : [motions]).filter(Boolean)
    if (!list.length || motionLibBusy) return
    setMotionLibBusy(true)
    const removed = []
    const failures = []
    try {
      for (const motion of list) {
        setMotionLibBusyId(motion.id)
        try {
          await deleteSavedMotion(motion.id)
          removed.push(motion.id)
        } catch (err) {
          console.error('Could not delete the saved motion:', err)
          failures.push(motion.name)
        }
      }
      if (removed.length) {
        const gone = new Set(removed)
        setMotionLibrary(prev => prev.filter(m => !gone.has(m.id)))
      }
      setMotionLibError(failures.length
        ? `Could not delete: ${failures.join(', ')}.`
        : null)
    } finally {
      setMotionLibBusy(false)
      setMotionLibBusyId(null)
    }
  }, [motionLibBusy])

  // --- Custom animations (hand-edited clips, reusable on any mesh) ----------
  // A clip corrected in the animation dock is saved together with the skeleton it
  // was authored on, which turns it into a proper animation SOURCE — so applying
  // one runs the same pipeline as a reference species or a Kimodo generation: it
  // takes the source-rig slot, gets a bone mapping, and is retargeted from there.

  const refreshCustomAnimations = useCallback(async () => {
    setCustomLibLoading(true)
    try {
      setCustomAnimations(await listCustomAnimations())
      setCustomLibError(null)
    } catch (err) {
      console.error('Could not load the custom animations:', err)
      setCustomLibError(err?.message || 'Could not load your saved animations.')
    } finally {
      setCustomLibLoading(false)
    }
  }, [])

  // Fetched when the tab is first opened: catalogue rows only (no clip data), and
  // there is no reason to pay for it in a session that never opens the tab.
  const customLibraryLoadedRef = useRef(false)
  const handleCustomTabOpen = useCallback(() => {
    if (customLibraryLoadedRef.current) return
    customLibraryLoadedRef.current = true
    void refreshCustomAnimations()
  }, [refreshCustomAnimations])

  // Put saved animations on the open mesh.
  //
  // Takes a LIST because the picker applies a selection, and one animation is a
  // list of one. Three things this has to get right:
  //
  // 1. An animation authored on the SAME rig as the one already in the source slot
  //    is added beside the clips that are there, mapping and all — a set of
  //    animations off one character is the normal case, and re-mapping between each
  //    of them would be absurd. A different rig replaces the slot, exactly as
  //    picking another reference does.
  // 2. The slot holds ONE skeleton, so a selection spanning two rigs cannot all be
  //    applied. The first one's rig wins and the rest are reported by name rather
  //    than silently dropped.
  // 3. Only the LAST clip is retargeted and played: baking twenty up front would
  //    cost twenty retargets for nineteen results nobody asked to see. The others
  //    bake on click, as everywhere else.
  const handleApplyCustomAnimations = useCallback(async (rows) => {
    const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean)
    if (!list.length || customApplying) return
    setCustomApplying(true)
    setCustomLibError(null)
    setAnimError(null)
    try {
      const target = await ensureAnimTargetScene()
      const added = []
      const skipped = []
      let source = animSourceRef.current
      let mapping = animReferenceId === CUSTOM_SOURCE_ID ? animMapping : null
      let rigKey = animReferenceId === CUSTOM_SOURCE_ID ? customRigKeyRef.current : null
      let taken = new Set(rigKey && source ? (source.clips || []).map(c => c.name) : [])

      for (const row of list) {
        setCustomBusyId(row.id)
        const stored = await fetchCustomAnimationDocument(row.id)

        // Clip names are the retarget cache key, so the same animation applied
        // twice in one session must not collide with its earlier copy.
        let name = row.name
        for (let n = 2; taken.has(name); n += 1) name = `${row.name} (${n})`

        const sameRig = !!rigKey && !!source && rigKey === stored.rigKey
        if (sameRig) {
          source.clips = [...(source.clips || []), customClipFromDocument(stored, name)]
        } else if (!added.length) {
          // The FIRST one always gets the slot, whatever is in it: picking an
          // animation is an instruction, not a suggestion. Only the ones after it
          // can collide with the rig it just installed.
          source = customSourceFromDocument(stored, name)
          animSourceRef.current = source
          customRigKeyRef.current = source.rigKey
          rigKey = source.rigKey
          setAnimReferenceId(CUSTOM_SOURCE_ID)
          setBoneMapSkeletons(null)
          setSelectedAnimation(null)
          setAnimPreview(null)
          setCheckedAnimations(new Set())
          retargetedClipsRef.current.clear()
          resetAnimEdits()

          // Mapping, in order of confidence: what this mesh already stored for this
          // rig, then a name-for-name match — the usual case for an animation off a
          // rig named by the same Auto Rig pass, and for a Mixamo-named pack on a
          // Mixamo-named rig.
          mapping = restoreBoneMapping(CUSTOM_SOURCE_ID, source.boneNames, target.boneNames)
          setCustomAutoMapped(false)
          setBoneMappingRestored(!!mapping)
          if (!mapping) {
            const auto = mapCustomBones(source.boneNames, target.boneNames)
            if (Object.keys(auto).length) {
              mapping = auto
              setCustomAutoMapped(true)
            }
          }
          setAnimMapping(mapping || null)
          setAnimArmTargets(mapping ? findUpperArmTargets(mapping) : null)
          // The old slot's clip names went with it, so nothing can collide yet.
          taken = new Set()
        } else {
          // A different skeleton from the one in the slot: it would need its own
          // mapping, and there is only one slot.
          skipped.push(row.name)
          continue
        }

        taken.add(name)
        added.push(name)
      }

      if (added.length) {
        setAnimClips((source.clips || []).map(c => ({ name: c.name })))
        setCustomLibOpen(false)
      }
      setCustomLibError(skipped.length
        ? `${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} made on a different skeleton — apply ${skipped.length === 1 ? 'it' : 'them'} on their own, since a mesh can only be mapped to one source rig at a time.`
        : null)

      // A mapping created a moment ago is invisible to showRetargetedClip through
      // its own closure, so it is handed over explicitly (Kimodo's trap exactly).
      const last = added[added.length - 1]
      if (mapping && last) {
        setSelectedAnimation(last)
        await showRetargetedClip(last, animMatchRestPose, animInPlace, mapping)
      }
    } catch (err) {
      console.error('Could not apply the custom animation:', err)
      setCustomLibError(err?.message || 'Could not apply that animation.')
    } finally {
      setCustomApplying(false)
      setCustomBusyId(null)
    }
  }, [customApplying, animReferenceId, animMapping, ensureAnimTargetScene,
    resetAnimEdits, restoreBoneMapping, showRetargetedClip, animMatchRestPose, animInPlace])

  // --- importing animation files -------------------------------------------
  // Read the picked files and show what they contain; nothing is written yet. A
  // pack FBX with fifty takes should not silently become fifty library rows, and
  // this is also where a file carrying no skeleton is caught.
  const handleParseAnimationFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setCustomImporting(true)
    setCustomLibError(null)
    try {
      const results = []
      const failures = []
      // Names must be unique across the whole batch, not just within a file: twenty
      // Mixamo downloads are twenty files each holding one clip called "mixamo.com",
      // and the clip name is what the library row is called.
      const taken = new Set(customAnimations.map(a => a.name))
      for (const file of files) {
        try {
          const parsed = await parseAnimationFile(file)
          for (const clip of parsed.clips) {
            let name = clip.name
            for (let n = 2; taken.has(name); n += 1) name = `${clip.name} (${n})`
            taken.add(name)
            clip.name = name
          }
          results.push(parsed)
        } catch (err) {
          console.error('Could not read the animation file:', err)
          failures.push(err?.message || file.name)
        }
      }
      customParsedRef.current = results
      setCustomParsed(results.length ? {
        fileName: files.length === 1 ? files[0].name : `${results.length} of ${files.length} files`,
        boneNames: results[0].boneNames,
        clips: results.flatMap(r => r.clips.map(c => ({
          name: c.name, duration: c.duration, frameCount: c.frameCount,
        }))),
      } : null)
      setCustomLibError(failures.length ? failures.join(' ') : null)
    } finally {
      setCustomImporting(false)
    }
  }, [customAnimations])

  // Write the picked clips to the library. Each one is stored with the skeleton its
  // file carried, which is what makes it retargetable onto any mesh later.
  const handleImportParsedClips = useCallback(async (names) => {
    const picked = names?.length ? names : null
    const parsedFiles = customParsedRef.current
    if (!parsedFiles.length) return
    setCustomImporting(true)
    setCustomLibError(null)
    try {
      const documents = parsedFiles.flatMap(parsed => buildImportedDocuments(parsed, picked))
      const saved = []
      const failures = []
      for (const [index, entry] of documents.entries()) {
        setCustomImportProgress({ done: index, total: documents.length })
        try {
          saved.push(await saveCustomAnimation(entry))
        } catch (err) {
          console.error('Could not import an animation:', err)
          failures.push(entry.name)
        }
      }
      customLibraryLoadedRef.current = true
      if (saved.length) setCustomAnimations(prev => [...saved.reverse(), ...prev])
      customParsedRef.current = []
      setCustomParsed(null)
      setCustomLibError(failures.length ? `Could not import: ${failures.join(', ')}.` : null)
      if (saved.length) {
        setFeedback(`Imported ${saved.length} animation${saved.length === 1 ? '' : 's'} — apply them to any rigged mesh.`)
      }
    } finally {
      setCustomImporting(false)
      setCustomImportProgress(null)
    }
  }, [])

  const handleCancelImport = useCallback(() => {
    customParsedRef.current = []
    setCustomParsed(null)
  }, [])

  const handleCustomOpenMapping = useCallback(() => {
    if (!animSourceRef.current || animReferenceId !== CUSTOM_SOURCE_ID) {
      setCustomLibError('Pick a saved animation first — its skeleton is what gets mapped.')
      return
    }
    setCustomLibError(null)
    void handleOpenBoneMapping(CUSTOM_SOURCE_ID)
  }, [animReferenceId, handleOpenBoneMapping])

  // Save the clip that is on screen — hand edits and all — as a reusable
  // animation. What makes it reusable is the second half of the document: the rig
  // it is playing on goes with it, because the retarget measures every frame
  // against that rig's rest pose.
  const handleSaveEditedAnimation = useCallback(async (name) => {
    const clip = animPreview?.clip
    const target = animTargetRef.current
    if (!clip || !target || customSavingClip) return
    setCustomSavingClip(true)
    setCustomLibError(null)
    try {
      const stored = buildCustomAnimationDocument({
        clip,
        scene: target.scene,
        fps: describeClip(clip)?.fps || 30,
      })
      const saved = await saveCustomAnimation({
        name: String(name || '').trim() || clip.name,
        document: stored,
        sourceMesh: meshName || '',
        sourceClip: clip.name,
      })
      customLibraryLoadedRef.current = true
      setCustomAnimations(prev => [saved, ...prev.filter(a => a.id !== saved.id)])
      setCustomSavedNotice(saved.name)
      setFeedback(`Saved “${saved.name}” to your custom animations.`)
    } catch (err) {
      console.error('Could not save the edited animation:', err)
      setCustomLibError(err?.message || 'Could not save that animation.')
      setAnimError(err?.message || 'Could not save that animation.')
    } finally {
      setCustomSavingClip(false)
    }
  }, [animPreview, customSavingClip, meshName])

  const handleRenameCustomAnimation = useCallback(async (animationId, name) => {
    try {
      const renamed = await renameCustomAnimation(animationId, name)
      setCustomAnimations(prev => prev.map(a => (a.id === renamed.id ? renamed : a)))
    } catch (err) {
      console.error('Could not rename the custom animation:', err)
      setCustomLibError(err?.message || 'Could not rename that animation.')
    }
  }, [])

  // Deletes STORED animations, not this session's clips: one already applied keeps
  // playing until the page is left, which is the behaviour that does not yank
  // something out from under a preview mid-play.
  //
  // Each delete is independent, so one failure does not strand the rest.
  const handleDeleteCustomAnimations = useCallback(async (rows) => {
    const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean)
    if (!list.length) return
    const removed = []
    const failures = []
    for (const row of list) {
      setCustomBusyId(row.id)
      try {
        await deleteCustomAnimation(row.id)
        removed.push(row.id)
      } catch (err) {
        console.error('Could not delete the custom animation:', err)
        failures.push(row.name)
      }
    }
    setCustomBusyId(null)
    if (removed.length) {
      const gone = new Set(removed)
      setCustomAnimations(prev => prev.filter(a => !gone.has(a.id)))
    }
    setCustomLibError(failures.length ? `Could not delete: ${failures.join(', ')}.` : null)
  }, [])


  // What the Auto Rig panel reports about the bone mappings this mesh carries.
  // Named per source, because "3 mappings" says nothing: what the user wants to
  // know is whether the reference they are about to pick is already mapped.
  const boneMappingSummary = useMemo(() => {
    const keys = Object.keys(storedBoneMappings || {})
    const labels = keys.map(key => {
      if (key === KIMODO_SOURCE_ID) return 'Kimodo'
      if (key.startsWith(`${CUSTOM_SOURCE_ID}:`)) return 'Custom animations'
      return getReference(key)?.label || key
    })
    // Several custom rigs collapse to one label; show it once. While a mapping is
    // only in memory the list stays empty — the dirty warning speaks instead.
    return { labels: boneMappingsDirty ? [] : [...new Set(labels)], dirty: boneMappingsDirty }
  }, [storedBoneMappings, boneMappingsDirty])


  // Bundle for the SkeletonPanel Custom tab.
  const customPanelProps = useMemo(() => ({
    onOpen: handleCustomTabOpen,
    animations: customAnimations,
    loading: customLibLoading,
    error: customLibError,
    applying: customApplying,
    // The library is a POPUP, not a list in the panel — the same call the Kimodo
    // tab makes, and for the same reason twice over: this column already carries
    // the mapping step and the clip gallery, and an imported pack is dozens of
    // rows that need search and multi-select.
    onOpenLibrary: () => { setCustomLibOpen(true); refreshCustomAnimations() },
    onOpenMapping: handleCustomOpenMapping,
    ownsSource: animReferenceId === CUSTOM_SOURCE_ID,
    autoMapped: customAutoMapped,
    mappingRestored: boneMappingRestored,
    savedNotice: customSavedNotice,
    onDismissSaved: () => setCustomSavedNotice(null),
  }), [handleCustomTabOpen, customAnimations, customLibLoading, customLibError,
    customApplying, refreshCustomAnimations, handleCustomOpenMapping, animReferenceId,
    customAutoMapped, boneMappingRestored, customSavedNotice])

  // Bundle for the SkeletonPanel Kimodo tab.
  // --- Auto Rig → MoCap (video-to-motion) -----------------------------------
  // Like Kimodo, this shares the Animations pipeline rather than duplicating it:
  // the captured clip lands in the same gallery, is previewed by the same code
  // and saved by the same button.
  //
  // Unlike Kimodo, there is no bone-mapping step for the user. MoCapAnything is
  // conditioned on the target rig, so the BVH comes back on THIS mesh's bone
  // names — the mapping is the identity, computed rather than authored. What
  // replaces it is a per-rig PREPARE step: the rig has to be baked (skeleton,
  // joint-name embeddings, a reference pose, a rendered view) before any video
  // can drive it. That is minutes of Blender, cached by mesh content hash.
  const [mocapRigId, setMocapRigId] = useState(null)
  const [mocapPrepared, setMocapPrepared] = useState(false)
  const [mocapPreparedJoints, setMocapPreparedJoints] = useState(0)
  // Which of the twelve yaws the bake conditioned on (see pipeline.reference_view).
  // Surfaced because it is the one bake decision that changes the RESULT rather
  // than the speed: a quadruped conditioned on its front view captures badly.
  const [mocapPreparedView, setMocapPreparedView] = useState('')
  const [mocapPreparing, setMocapPreparing] = useState(false)
  const [mocapPrepareProgress, setMocapPrepareProgress] = useState(null)
  const [mocapRunning, setMocapRunning] = useState(false)
  const [mocapProgress, setMocapProgress] = useState(null)
  const [mocapError, setMocapError] = useState(null)
  const [mocapServiceError, setMocapServiceError] = useState(null)
  const [mocapVideo, setMocapVideo] = useState(null)
  // Length is held as the typed STRING: clamping it to the model's window while
  // the user is still typing would fight the keyboard (a "1" on the way to "12"
  // would snap up to the minimum). The clamp happens when the capture runs.
  const [mocapSeconds, setMocapSeconds] = useState(String(MOCAP_DEFAULT_SECONDS))
  // Measured off the chosen file, because seconds only become frames — the unit
  // the service caps — at the video's own rate. Null until measured, or when the
  // browser will not tell us.
  const [mocapVideoFps, setMocapVideoFps] = useState(null)
  const [mocapVideoDuration, setMocapVideoDuration] = useState(null)
  // Measuring the rate means watching frames play, so it takes about a second.
  // Tracked so the panel can say "reading it" instead of "could not read it".
  const [mocapVideoProbing, setMocapVideoProbing] = useState(false)
  const [mocapLastStats, setMocapLastStats] = useState(null)
  // The bake is keyed by the SKELETON. Editing bones after preparing changes that
  // key, so the bake on disk no longer describes this rig — compared on every
  // render rather than tracked, so it cannot drift out of sync with the mesh.
  const [mocapPreparedKey, setMocapPreparedKey] = useState('')
  // Every chain is driven by default; the user switches off what should hold
  // still. See MOCAP_BONE_GROUPS for why this is a mapping filter and not a
  // capture setting.
  const [mocapDrive, setMocapDrive] = useState(() => new Set(MOCAP_BONE_GROUPS.map(g => g.id)))
  const mocapCounterRef = useRef(0)
  const mocapCurrentKey = useMemo(() => mocapRigKey(skeleton), [skeleton])
  const mocapStale = !!mocapPreparedKey && !!mocapCurrentKey && mocapCurrentKey !== mocapPreparedKey

  // Ask the service whether THIS exact mesh is already baked. Cheap (a hash, no
  // GPU), so the tab can open in the right state instead of making the user
  // press Prepare to find out.
  const refreshMocapRigState = useCallback(async () => {
    if (!skeleton) return
    try {
      const blob = await buildRiggedResultBlobRef.current?.({ bindPose: true })
      if (!blob) return
      const info = await inspectMocapRig(blob, mocapCurrentKey)
      setMocapRigId(info.rig_id || null)
      setMocapPrepared(!!info.prepared)
      setMocapPreparedJoints(info.info?.joints || 0)
      setMocapPreparedView(info.info?.ref_view || '')
      setMocapPreparedKey(info.prepared ? mocapCurrentKey : '')
      setMocapServiceError(null)
    } catch (err) {
      console.error('Could not check the MoCap rig state:', err)
      setMocapServiceError(err?.message || 'Could not reach the video-to-motion service.')
    }
  }, [skeleton, mocapCurrentKey])

  const handleMocapPrepare = useCallback(async () => {
    if (mocapPreparing || mocapRunning) return
    setMocapPreparing(true)
    setMocapError(null)
    setMocapServiceError(null)
    setMocapPrepareProgress(null)
    try {
      const blob = await buildRiggedResultBlobRef.current?.({ bindPose: true })
      if (!blob) throw new Error('There is no rigged mesh to prepare.')
      const info = await prepareMocapRig({
        meshBlob: blob,
        rigName: (meshName || 'rig').trim() || 'rig',
        rigKey: mocapCurrentKey,
        onProgress: setMocapPrepareProgress,
      })
      // A re-prepare after a skeleton edit produces a NEW rig id, leaving the
      // previous bake (a few hundred MB) orphaned on disk with nothing able to
      // reach it again. Drop it rather than accumulate one per edit. Failure is
      // ignored: a leftover cache directory must not fail the prepare.
      const supersededId = mocapRigId
      setMocapRigId(info.rig_id)
      setMocapPrepared(true)
      setMocapPreparedJoints(info.joints || 0)
      setMocapPreparedView(info.ref_view || '')
      setMocapPreparedKey(mocapCurrentKey)
      if (supersededId && supersededId !== info.rig_id) {
        forgetMocapRig(supersededId).catch(err =>
          console.warn('Could not remove the superseded MoCap bake:', err))
      }
    } catch (err) {
      console.error('Preparing the rig for MoCap failed:', err)
      setMocapError(err?.message || 'Preparing the rig failed.')
    } finally {
      setMocapPreparing(false)
      setMocapPrepareProgress(null)
    }
  }, [mocapPreparing, mocapRunning, meshName, mocapCurrentKey, mocapRigId])

  // Put the captured BVH's skeleton in the source-rig slot. Unlike Kimodo's
  // (a fixed SOMA rest pose fetched up front) this skeleton IS the result, so it
  // can only be installed once a capture exists.
  const installMocapSource = useCallback(source => {
    setAnimMapping(null)
    setBoneMappingRestored(false)
    setBoneMapSkeletons(null)
    setAnimClips([])
    setSelectedAnimation(null)
    setAnimPreview(null)
    setCheckedAnimations(new Set())
    retargetedClipsRef.current.clear()
    resetAnimEdits()
    // Rest-pose matching OFF for captures. It exists to stop a reference rig's
    // stance leaking into the mesh, but here the source IS this mesh's skeleton,
    // so there is no stance to reconcile — and the source rest pose comes from
    // the bake, which yawed the rig to face +Z. Matching against it imposes the
    // bake's stance on the mesh and then makes retargetAnimationClip recompute
    // floorOffset from that posed bounding box, which lifts the character off
    // the ground. The toggle is still there if a rig ever needs it.
    setAnimMatchRestPose(false)
    animSourceRef.current = source
    setAnimReferenceId(MOCAP_SOURCE_ID)
    return source
  }, [resetAnimEdits])

  // Picking a video is what makes the length field concrete: measure the clip's
  // frame rate (and duration) so the estimate below the field describes THIS
  // file instead of an assumed rate. The token guards against a slow measurement
  // for a file the user has already replaced.
  const mocapVideoTokenRef = useRef(0)
  const handleMocapVideoChange = useCallback(file => {
    const token = mocapVideoTokenRef.current + 1
    mocapVideoTokenRef.current = token
    setMocapVideo(file || null)
    setMocapVideoFps(null)
    setMocapVideoDuration(null)
    setMocapVideoProbing(!!file)
    if (!file) return
    void detectVideoFps(file).then(({ fps, duration }) => {
      if (mocapVideoTokenRef.current !== token) return
      setMocapVideoFps(fps || null)
      setMocapVideoDuration(duration || null)
      setMocapVideoProbing(false)
    })
  }, [])

  // Everything the length field needs to explain itself: the frames the typed
  // seconds come to, what that costs in VRAM, and the two ways the capture can
  // end up shorter than asked (the model's 301-frame window, or a shorter clip).
  const mocapCapture = useMemo(() => {
    const fps = mocapVideoFps || MOCAP_ASSUMED_FPS
    const seconds = Number(mocapSeconds)
    const valid = Number.isFinite(seconds) && seconds > 0
    const frames = mocapFramesForSeconds(valid ? seconds : MOCAP_DEFAULT_SECONDS, fps)
    const maxSeconds = mocapMaxSeconds(fps)
    const minSeconds = MOCAP_MIN_FRAMES / fps
    return {
      seconds: mocapSeconds,
      valid,
      frames,
      fps,
      fpsKnown: !!mocapVideoFps,
      probing: mocapVideoProbing,
      vram: estimateMocapVram(frames),
      minFrames: MOCAP_MIN_FRAMES,
      maxFrames: MOCAP_MAX_FRAMES,
      minSeconds,
      maxSeconds,
      // Only set when the request actually left the model's window, so the panel
      // does not have to re-derive the comparison to know whether to mention it.
      cappedSeconds: valid && seconds > maxSeconds ? maxSeconds : null,
      flooredSeconds: valid && seconds < minSeconds ? minSeconds : null,
      effectiveSeconds: frames / fps,
      videoSeconds: mocapVideoDuration,
    }
  }, [mocapSeconds, mocapVideoFps, mocapVideoDuration, mocapVideoProbing])

  const handleMocapGenerate = useCallback(async () => {
    if (mocapRunning || !mocapVideo || !mocapRigId) return
    setMocapRunning(true)
    setMocapError(null)
    setMocapProgress(null)
    try {
      const target = await ensureAnimTargetScene()

      mocapCounterRef.current += 1
      const label = (mocapVideo.name || 'capture').replace(/\.[^.]+$/, '').slice(0, 40)
      const name = `${mocapCounterRef.current}. ${label}`

      const { clip, source, bvh, stats } = await generateMocapClip({
        videoFile: mocapVideo,
        rigId: mocapRigId,
        maxFrames: mocapCapture.frames,
        name,
        onProgress: setMocapProgress,
      })
      setMocapLastStats(stats)

      // The capture is minutes of GPU time and the BVH is the mesh-independent
      // artifact worth keeping, so persist before anything else can fail. A save
      // failure must not fail the capture: the clip is already in hand.
      // `source` matters on the way back out: the stored BVH is raw, and only a
      // MoCap row may have its root tilt corrected when it is re-applied.
      saveMotion({
        name,
        prompt: `Video: ${mocapVideo.name || 'clip'}`,
        bvh,
        source: MOTION_SOURCE_MOCAP,
      })
        .then(saved => setMotionLibrary(prev => [saved, ...prev]))
        .catch(err => {
          console.error('Could not save the captured motion:', err)
          setMotionLibError(err?.message || 'The motion was captured but could not be saved.')
        })

      installMocapSource(source)

      // Identity mapping: the service returned OUR bone names. Bones the target
      // does not have are dropped rather than guessed.
      const mapping = mocapIdentityMapping(source.boneNames, target.boneNames, mocapDrive)
      if (!Object.keys(mapping).length) {
        throw new Error(Object.keys(mocapIdentityMapping(source.boneNames, target.boneNames)).length
          ? 'Every bone chain is switched off — turn at least one back on.'
          : 'The captured skeleton does not match this mesh. Prepare the rig again.')
      }
      setAnimMapping(mapping)
      setAnimArmTargets(findUpperArmTargets(mapping))

      source.clips = [...(source.clips || []), clip]
      setAnimClips(source.clips.map(c => ({ name: c.name })))
      setSelectedAnimation(name)
      // Deliberately NOT auto-played. showRetargetedClip reads animMapping
      // through its own closure, and the mapping was created a moment ago in
      // this same call — so the bake would silently no-op. The clip is in the
      // gallery and plays on click, which is what the Kimodo tab does for the
      // identical reason on its first generation.
    } catch (err) {
      console.error('Video to motion failed:', err)
      setMocapError(err?.message || 'Capturing the motion failed.')
    } finally {
      setMocapRunning(false)
      setMocapProgress(null)
    }
  }, [mocapRunning, mocapVideo, mocapRigId, mocapCapture, mocapDrive,
    ensureAnimTargetScene, installMocapSource])

  const kimodoPanelProps = useMemo(() => ({
    prompt: kimodoPrompt,
    onPromptChange: setKimodoPrompt,
    duration: kimodoDuration,
    onDurationChange: setKimodoDuration,
    segments: Math.max(1, countPromptSegments(kimodoPrompt)),
    running: kimodoRunning,
    progress: kimodoProgress,
    error: kimodoError,
    loading: animLoading,
    onGenerate: handleKimodoGenerate,
    onOpenMapping: handleKimodoOpenMapping,
    // Whether the shared source-rig slot currently belongs to Kimodo — drives
    // whether the tab shows its clips or warns that mapping will take the slot.
    ownsMapping: animReferenceId === KIMODO_SOURCE_ID,
    autoMapped: kimodoAutoMapped,
    handCurl,
    onHandCurlChange: handleHandCurlChange,
    onHandCurlCommit: handleHandCurlCommit,
    onHandCurlReset: () => {
      setHandCurl(prev => ({ ...prev, left: 0, right: 0, leftThumb: 0, rightThumb: 0 }))
      retargetedClipsRef.current.clear()
    },
    library: {
      items: motionLibrary,
      loading: motionLibLoading,
      error: motionLibError,
      // Refreshed on open as well as on tab entry: another session (or another
      // window on the same project) may have generated something since.
      onOpen: () => { setMotionLibOpen(true); refreshMotionLibrary() },
    },
  }), [kimodoPrompt, kimodoDuration, kimodoRunning, kimodoProgress, kimodoError,
    animLoading, handleKimodoGenerate, handleKimodoOpenMapping, animReferenceId, kimodoAutoMapped,
    handCurl, handleHandCurlChange, handleHandCurlCommit,
    motionLibrary, motionLibLoading, motionLibError, refreshMotionLibrary])

  // Re-map an existing capture rather than making the user re-shoot.
  //
  // The new set is computed OUTSIDE setMocapDrive: a state updater has to be
  // pure, and the retarget below is very much a side effect. It is also handed
  // to showRetargetedClip explicitly — setAnimMapping has not landed yet, and
  // the bake reads the mapping from its own closure, so without that the clip
  // rebakes with the PREVIOUS set and every toggle appears one step behind.
  const handleMocapDriveToggle = useCallback(groupId => {
    const next = new Set(mocapDrive)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    setMocapDrive(next)

    const source = animSourceRef.current
    const target = animTargetRef.current
    if (animReferenceId !== MOCAP_SOURCE_ID || !source || !target) return

    const mapping = mocapIdentityMapping(source.boneNames, target.boneNames, next)
    if (!Object.keys(mapping).length) return   // everything off: keep the last good bake
    setAnimMapping(mapping)
    setAnimArmTargets(findUpperArmTargets(mapping))
    // Cached bakes were made against the old mapping.
    retargetedClipsRef.current.clear()
    if (selectedAnimation) {
      void showRetargetedClip(selectedAnimation, false, undefined, mapping)
    }
  }, [mocapDrive, animReferenceId, selectedAnimation, showRetargetedClip])

  const mocapPanelProps = useMemo(() => ({
    onOpen: refreshMocapRigState,
    rigId: mocapRigId,
    prepared: mocapPrepared,
    preparedJoints: mocapPreparedJoints,
    preparedView: mocapPreparedView,
    canPrepare: !!skeleton,
    staleRig: mocapStale,
    preparing: mocapPreparing,
    prepareProgress: mocapPrepareProgress,
    onPrepare: handleMocapPrepare,
    hasVideo: !!mocapVideo,
    videoName: mocapVideo?.name || '',
    onVideoChange: handleMocapVideoChange,
    capture: mocapCapture,
    onSecondsChange: setMocapSeconds,
    boneGroups: MOCAP_BONE_GROUPS,
    drive: mocapDrive,
    onDriveToggle: handleMocapDriveToggle,
    canFilter: animReferenceId === MOCAP_SOURCE_ID,
    // Same shared state as the Kimodo tab: withHandPose is applied downstream in
    // getRetargetedClip for every source, so both tabs drive one finger pose.
    handCurl,
    onHandCurlChange: handleHandCurlChange,
    onHandCurlCommit: handleHandCurlCommit,
    onHandCurlReset: () => {
      setHandCurl(prev => ({ ...prev, left: 0, right: 0, leftThumb: 0, rightThumb: 0 }))
      retargetedClipsRef.current.clear()
    },
    running: mocapRunning,
    progress: mocapProgress,
    error: mocapError,
    serviceError: mocapServiceError,
    lastStats: mocapLastStats,
    onGenerate: handleMocapGenerate,
  }), [refreshMocapRigState, mocapRigId, mocapPrepared, mocapPreparedJoints, mocapPreparedView, skeleton, mocapStale,
    mocapPreparing, mocapPrepareProgress, handleMocapPrepare, mocapVideo,
    handleMocapVideoChange, mocapCapture,
    mocapRunning, mocapProgress, mocapError, mocapServiceError,
    mocapLastStats, handleMocapGenerate, mocapDrive, handleMocapDriveToggle,
    animReferenceId, handCurl, handleHandCurlChange, handleHandCurlCommit])

  // Bundle for the SkeletonPanel Animations tab.
  const animationPanelProps = useMemo(() => ({
    referenceId: animReferenceId,
    // Kimodo and the reference library share one source-rig slot, so the
    // Animations tab has to be able to say when Kimodo is holding it — otherwise
    // it would silently list generated clips under a blank reference dropdown.
    ownedByKimodo: animReferenceId === KIMODO_SOURCE_ID,
    // Same for a custom animation: it takes the same single source slot, and a
    // blank reference dropdown over someone else's clips reads as a bug.
    ownedByCustom: animReferenceId === CUSTOM_SOURCE_ID,
    onSelectReference: handleSelectAnimReference,
    onOpenMapping: handleOpenBoneMapping,
    hasMapping: !!animMapping,
    mappingRestored: boneMappingRestored,
    clips: animClips,
    selectedAnimation,
    onSelectAnimation: handleSelectAnimation,
    retargeting: animRetargeting,
    loading: animLoading,
    error: animError,
    alignFloor: animAlignFloor,
    onToggleAlignFloor: () => setAnimAlignFloor(v => !v),
    matchRestPose: animMatchRestPose,
    onToggleMatchRestPose: handleToggleMatchRestPose,
    inPlace: animInPlace,
    onToggleInPlace: handleToggleInPlace,
    editOpen: animEditOpen,
    onToggleEdit: handleToggleAnimEdit,
    editedClips: animEditedClips,
    armExtension: animArmExtension,
    onArmExtensionChange: setAnimArmExtension,
    canAdjustArms: !!(animArmTargets && (animArmTargets.left.length || animArmTargets.right.length)),
    checkedAnimations,
    onToggleChecked: handleToggleAnimationChecked,
    saving: animSaving,
    onSave: handleSaveAnimations,
  }), [animReferenceId, handleSelectAnimReference, handleOpenBoneMapping, animMapping, boneMappingRestored, animClips,
    selectedAnimation, handleSelectAnimation, animRetargeting, animLoading, animError, animAlignFloor,
    animMatchRestPose, handleToggleMatchRestPose, animInPlace, handleToggleInPlace,
    animEditOpen, handleToggleAnimEdit, animEditedClips,
    animArmExtension, animArmTargets, checkedAnimations, handleToggleAnimationChecked, animSaving, handleSaveAnimations])

  // On-demand watertight check for the Auto Retopo panel. The position-welded
  // edge scan can take a moment on dense meshes, so it runs behind a button with
  // a loading state rather than automatically. A double rAF lets the spinner
  // paint before the synchronous scan blocks the main thread.
  const handleCheckWatertight = useCallback(() => {
    if (!geometry || watertightChecking) return
    setWatertightChecking(true)
    setWatertightResult(null)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          setWatertightResult(getGeometryWatertight(geometry))
        } catch (err) {
          console.error('Watertight check failed:', err)
          setWatertightResult(null)
        } finally {
          setWatertightChecking(false)
        }
      })
    })
  }, [geometry, watertightChecking])

  const setRepairOption = useCallback((key, value) => {
    setRepairOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  // Targeted non-manifold / topology repair via the Python mesh-tools service:
  // weld → drop duplicate/degenerate faces → resolve non-manifold edges → close
  // small holes. Runs the same round-trip as Auto Retopo (undoable via Keep/
  // Revert) and reports before/after non-manifold + boundary edge counts.
  const handleCleanNonManifold = useCallback(() => {
    runMeshTool(runRepairService, repairOptions, {
      setRunning: setRepairRunning,
      setResult: setRepairResult,
      setProgress: setRepairProgress,
      label: 'Repair',
      requiresService: 'meshtools',
      // The UV-preserving repair returns the same UV layout it was given, so the
      // painted texture can be carried straight onto the result. Without it the
      // UVs are gone and a carried-over texture would map to nothing, so the
      // blank-canvas reset is the honest outcome.
      preserveTexture: repairOptions.preserve_uv,
      buildRows: stats => {
        const t = stats?.tool || {}
        const before = t.before || {}
        const after = t.after || {}
        const rows = []
        if (before.non_manifold_edges != null && after.non_manifold_edges != null) {
          rows.push({ label: 'Non-manifold edges', value: `${before.non_manifold_edges} → ${after.non_manifold_edges}` })
        }
        if (before.boundary_edges != null && after.boundary_edges != null) {
          rows.push({ label: 'Open edges', value: `${before.boundary_edges} → ${after.boundary_edges}` })
        }
        if (t.removed_faces != null) rows.push({ label: 'Faces removed', value: t.removed_faces })
        if (t.detached_faces) rows.push({ label: 'Faces detached', value: t.detached_faces })
        if (t.filled_faces) rows.push({ label: 'Holes closed', value: t.filled_faces })
        rows.push({ label: 'UVs / texture', value: t.uv_preserved ? 'Preserved' : 'Discarded' })
        if (after.watertight != null) rows.push({ label: 'Watertight', value: after.watertight ? 'Yes' : 'No' })
        return rows
      },
    })
  }, [runMeshTool, repairOptions])

  // Any geometry change (edits, Auto Retopo, revert…) invalidates a prior result,
  // so clear it and let the user re-check against the new topology. The
  // Game-Ready report goes with it: a stale green checklist is worse than none.
  useEffect(() => {
    setWatertightResult(null)
    setGameReadyReport(null)
  }, [geometryRevision])
  const setOptimizeOption = useCallback((key, value) => {
    setOptimizeOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  // ── Bake ─────────────────────────────────────────────────────────────────

  // Returns the new entry's id so callers can select it. Snapshots taken behind
  // the user's back only auto-select when nothing is chosen yet; a file the user
  // picked deliberately becomes the selection.
  const rememberBakeSource = useCallback((blob, label, faces) => {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    // Timestamped because a longer list makes repeats likely — three runs of the
    // same tool would otherwise be three identically-labelled entries.
    const at = new Date().toLocaleTimeString()
    setBakeSources(prev => [{ id, label, faces, blob, at }, ...prev].slice(0, MAX_BAKE_SOURCES))
    setBakeSourceId(current => current || id)
    return id
  }, [])

  const setBakeOption = useCallback((key, value) => {
    setBakeOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  // Pull a library mesh in as the bake source. `showEdits` means versions are
  // selectable too, which is the common case here: the high-poly is usually an
  // earlier version of the very mesh being edited. A version carries `filePath`
  // rather than `filename`, hence the two-way resolve.
  const handleBakeSourceAsset = useCallback(async (asset) => {
    if (!asset) return
    const url = buildAssetUrl(asset)
    if (!url) {
      setError('That asset has no file on disk.')
      return
    }
    setBakeSourceLoading(true)
    setError('')
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Could not load ${asset.name || 'the asset'}.`)
      }
      const blob = await response.blob()
      // Give it a real filename: the service picks its loader from the extension,
      // so a nameless Blob would be rejected as an unsupported format.
      const fileName = (asset.filePath || asset.filename || 'high.glb').split('/').pop()
      const named = new File([blob], fileName, { type: blob.type || 'model/gltf-binary' })
      setBakeSourceId(rememberBakeSource(named, asset.name || fileName, null))
      setFeedback(`Bake source set to ${asset.name || fileName}.`)
    } catch (err) {
      console.error('Loading the bake source asset failed:', err)
      setError(err?.message || 'Could not load that asset.')
    } finally {
      setBakeSourceLoading(false)
    }
  }, [rememberBakeSource])

  const handleRunBake = useCallback(async () => {
    const source = bakeSources.find(entry => entry.id === bakeSourceId) || bakeSources[0]
    if (!geometry || bakeRunning || !source) {
      return
    }
    if (!geometry.attributes?.uv?.count) {
      setError('The mesh has no UVs, so there is nowhere to bake to. Run Auto UV first.')
      return
    }
    // Having UVs is not the same as having usable ones. A bake writes each
    // triangle wherever the layout says it goes, so if two surfaces claim the
    // same texels the bake reproduces that faithfully and the mesh comes back a
    // kaleidoscope — which is exactly what simplifying past the seam floor
    // leaves behind. The bake cannot fix it and costs minutes finding out, so
    // stop here and name the fix.
    const uvHealth = measureUvHealth(new THREE.Mesh(geometry))
    if (uvsAreBroken(uvHealth)) {
      setError(`The UV layout is unusable — the atlas is written ${uvHealth.atlasWrites.toFixed(0)}x over, so several surfaces share the same texels and a bake would reproduce that rather than fix it. Run Auto UV to rebuild the UVs, then bake.`)
      return
    }
    setBakeRunning(true)
    setBakedMaps(null)
    setError('')
    setBakeProgress({ stage: 'start', frac: 0, message: 'Bake starting…' })
    try {
      await ensureDesktopService('meshtools')
      // The low-poly target is the mesh as it stands; the rig is irrelevant to a
      // bake, so it is left out to keep the upload small.
      const lowBuffer = await exportGeometryToGlb(geometry)
      const { maps, stats } = await bakeMaps(
        new Blob([lowBuffer], { type: 'model/gltf-binary' }),
        source.blob,
        {
          options: bakeOptions,
          fileName: 'low.glb',
          sourceName: source.blob.name || 'high.glb',
          onProgress: evt => setBakeProgress(evt),
        },
      )
      const decoded = {}
      for (const [name, blob] of Object.entries(maps)) {
        decoded[name] = { blob, url: URL.createObjectURL(blob) }
      }
      setBakedMaps({ maps: decoded, stats })
      setFeedback(`Baked ${Object.keys(decoded).length} map${Object.keys(decoded).length === 1 ? '' : 's'} at ${stats?.resolution || bakeOptions.resolution}px.`)
    } catch (err) {
      console.error('Bake failed:', err)
      setError(err?.message || 'The bake failed.')
    } finally {
      setBakeRunning(false)
      setBakeProgress(null)
    }
  }, [geometry, bakeRunning, bakeSources, bakeSourceId, bakeOptions])

  // Put the baked maps on the mesh. Normal and AO are channels the editor does
  // not otherwise own, so they attach straight to the material. A base-colour
  // transfer instead goes into the paint canvas, which IS the editor's base
  // colour — that is what gives a retopologised mesh its texture back.
  const handleApplyBakedMaps = useCallback(async () => {
    if (!bakedMaps?.maps) return
    const { maps } = bakedMaps
    const applied = []

    const loadTexture = url => new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, resolve, undefined, reject)
    })

    const loadImage = url => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = url
    })

    // Applying the base colour can REPLACE the texturable mesh (see below), so the
    // root the material channels attach to is read from here rather than captured.
    let target = texturableMesh

    const forEachTargetMaterial = (fn) => {
      target?.root?.traverse(child => {
        if (!child.isMesh) return
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        materials.forEach(material => {
          if (!material) return
          fn(material)
          material.needsUpdate = true
        })
      })
    }

    // Assign to every material on the display root, and remember it so the export
    // paths can reattach it to whatever material they build.
    const assign = (slot, texture, tweak = null) => {
      appliedMapsRef.current[slot] = texture
      forEachTargetMaterial(material => {
        material[slot] = texture
        tweak?.(material)
      })
    }

    const prepare = async (url) => {
      const texture = await loadTexture(url)
      texture.colorSpace = THREE.NoColorSpace // data, not colour
      texture.flipY = false // glTF convention, matching the loader's textures
      texture.channel = 0 // aoMap would otherwise be read from uv1
      texture.needsUpdate = true
      return texture
    }

    try {
      // Base colour goes first: when the bake is finer than the paint canvas the
      // canvas has to grow, which rebuilds the texturable mesh — and anything
      // attached to the old root before that would be thrown away with it. The
      // canvas defaults to 1024 while the bake defaults to 2048, so this used to
      // discard three quarters of the pixels the bake had just spent minutes on,
      // while normal/ORM (which attach as textures, not through the canvas) kept
      // their full resolution.
      //
      // Growing it is only safe because entering any non-painting mode flattens
      // and clears the paint layers, so there are no layer canvases at the old
      // size left to reconcile.
      if (maps.base_color && target?.textureCanvas) {
        const image = await loadImage(maps.base_color.url)
        const canvas = target.textureCanvas

        if (image.width > canvas.width || image.height > canvas.height) {
          const grown = document.createElement('canvas')
          grown.width = image.width
          grown.height = image.height
          grown.getContext('2d').drawImage(image, 0, 0)
          const { object } = buildTexturedMeshObject({
            root: target.root,
            textureKey: target.textureKey,
            textureCanvas: grown,
            textureConfig: target.textureConfig,
          })
          const loaded = await loadTexturableMeshFromRoot(object, {
            url: modelUrl,
            blankTextureSize: image.width,
          })
          if (loaded?.textureCanvas) {
            target = {
              ...loaded,
              maskCanvas: Object.assign(document.createElement('canvas'), {
                width: loaded.textureCanvas.width,
                height: loaded.textureCanvas.height,
              }),
            }
            applied.push(`base colour at ${image.width}px`)
          }
        }

        // Same size as the canvas, or the rebuild above did not take: draw into the
        // canvas we already have.
        if (target === texturableMesh) {
          const context = canvas.getContext('2d')
          context.save()
          context.globalCompositeOperation = 'source-over'
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          context.restore()
          updateCanvasTexture(displayTextureRef.current)
          applied.push('base colour')
        }

        // The bake reads Base Color *after* the source's baseColorFactor, so the
        // factor is already in these pixels — a tint left on the target material
        // would apply it a second time. (The export path resets it for exactly
        // this reason; see applyBakedMapsToMaterial in utils/meshExport.js.)
        forEachTargetMaterial(material => material.color?.setRGB?.(1, 1, 1))
      }

      if (maps.normal) {
        assign('normalMap', await prepare(maps.normal.url))
        applied.push('normal')
      }

      // Prefer the packed ORM: one texture object across all three slots is the
      // glTF layout, and it is what lets GLTFExporter skip recompositing the
      // channels (it early-returns when metalnessMap === roughnessMap).
      const ormChannels = bakedMaps.stats?.orm_channels || []
      if (maps.orm && ormChannels.length) {
        const texture = await prepare(maps.orm.url)
        // A *Map is multiplied by its scalar factor, and the editor's placeholder
        // material carries roughness 0.62 / metalness 0.08 — leaving those would
        // scale the baked values down. glTF sets the factors to 1 when a texture
        // is present, so match that.
        if (ormChannels.includes('ao')) assign('aoMap', texture)
        if (ormChannels.includes('roughness')) assign('roughnessMap', texture, m => { m.roughness = 1 })
        if (ormChannels.includes('metallic')) assign('metalnessMap', texture, m => { m.metalness = 1 })
        applied.push(`packed ${ormChannels.join('/')}`)
      } else {
        // Fewer than two channels baked — bind them individually.
        if (maps.ao) { assign('aoMap', await prepare(maps.ao.url)); applied.push('ao') }
        if (maps.roughness) {
          assign('roughnessMap', await prepare(maps.roughness.url), m => { m.roughness = 1 })
          applied.push('roughness')
        }
        if (maps.metallic) {
          assign('metalnessMap', await prepare(maps.metallic.url), m => { m.metalness = 1 })
          applied.push('metallic')
        }
      }

      // Remount the textured display so the new material channels take effect.
      // Swapping the texturable mesh does that on its own (the effect watching it
      // rebuilds the display texture and bumps the revision), and it also rebuilds
      // the paint targets for the new canvas size.
      if (target !== texturableMesh) {
        setTexturableMesh(target)
      } else {
        setTextureRevision(rev => rev + 1)
      }
      setFeedback(applied.length
        ? `Applied ${applied.join(' + ')} to the mesh.`
        : 'Nothing to apply.')
    } catch (err) {
      console.error('Applying baked maps failed:', err)
      setError(err?.message || 'Could not apply the baked maps.')
    }
  }, [bakedMaps, texturableMesh, modelUrl])

  // ── LOD chain ────────────────────────────────────────────────────────────
  const lodRatios = useMemo(() => defaultLodRatios(lodLevels), [lodLevels])

  // Build every level and report its real triangle count. Only the geometry is
  // sent: gltfpack would otherwise re-encode the embedded texture once per level,
  // which costs seconds and megabytes to produce numbers that do not depend on it.
  const handleGenerateLods = useCallback(async () => {
    if (!geometry || lodGenerating) {
      return
    }
    setLodGenerating(true)
    setError('')
    setLodProgress({ stage: 'start', frac: 0, message: 'Preparing mesh…' })
    try {
      // Send the rig along: gltfpack carries JOINTS_0/WEIGHTS_0 through
      // simplification, so an LOD of a rigged mesh keeps its weights and stays
      // applicable without dropping the skeleton. Without this the levels would
      // come back static and applying one would silently un-rig the mesh.
      const rig = geometryHasSkin(geometry) ? rigRef.current : null
      const glbBuffer = await exportGeometryToGlb(geometry, rig)
      const sourceBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' })
      const chain = await generateLods(sourceBlob, {
        ratios: lodRatios,
        allowSeamBreaking: !!optimizeOptions.allow_seam_breaking,
        // Every level is built with the same simplifier settings the Optimize
        // section shows, so the chain and a single run cannot disagree.
        simplify: optimizeOptions,
        fileName: 'mesh.glb',
        onProgress: evt => setLodProgress(evt),
      })
      const sourceFaces = geometryFaceCount(geometry)
      // The service sends no payload for the passthrough level — it *is* what we
      // uploaded. Hand it the blob we already hold so LOD0 can be applied like
      // any other level, which is how you get back to the original mesh after
      // trying a coarser one.
      setLodChain(chain.map(lod => (lod.passthrough
        ? { ...lod, blob: sourceBlob, triangles: sourceFaces }
        : lod)))
      setLodSourceFaces(sourceFaces)
      const limited = chain.filter(lod => lod.seamLimited).length
      setFeedback(limited
        ? `LOD chain ready — ${limited} level${limited === 1 ? '' : 's'} stopped early to protect the UVs.`
        : `LOD chain ready — ${chain.length} levels.`)
    } catch (err) {
      console.error('LOD generation failed:', err)
      setError(err?.message || 'LOD generation failed.')
      setLodChain([])
    } finally {
      setLodGenerating(false)
      setLodProgress(null)
    }
  }, [geometry, lodGenerating, lodRatios, optimizeOptions])

  // Swap the mesh for one of the generated levels. Routed through runMeshTool so
  // it behaves exactly like Optimize does — undo entry, texture carried over,
  // Keep/Revert banner — with the already-built blob standing in for the service.
  const handleApplyLod = useCallback((level) => {
    const lod = lodChain.find(entry => entry.level === level)
    if (!lod?.blob) {
      return
    }
    runMeshTool(async () => ({ blob: lod.blob, stats: null, previewUrl: null }), {}, {
      setRunning: setOptimizeRunning,
      setResult: setOptimizeResult,
      setProgress: setOptimizeProgress,
      label: lod.passthrough ? 'Restore LOD0' : `Apply LOD${level}`,
      preserveTexture: true,
      buildRows: (_stats, nextGeometry) => [
        { label: 'Level', value: `LOD${level}${lod.passthrough ? ' (original)' : ''}` },
        { label: 'Target ratio', value: `${Math.round(lod.ratio * 100)}%` },
        { label: 'Faces', value: `${lodSourceFaces.toLocaleString()} → ${geometryFaceCount(nextGeometry).toLocaleString()}` },
      ],
    })
  }, [lodChain, lodSourceFaces, runMeshTool])

  const handleRevertMeshTool = useCallback((clearResult) => {
    handleModelingUndo()
    // Restore the texture/UVs that were live before the tool ran. Changing the
    // texturable-mesh identity also re-runs the display effects, so the textured
    // preview refreshes immediately (previously it only updated after switching
    // modes, since the geometry undo alone doesn't remount <TexturedMesh>).
    if (preToolTexturableRef.current) {
      setTexturableMesh(preToolTexturableRef.current)
      preToolTexturableRef.current = null
    }
    clearResult(null)
  }, [handleModelingUndo])

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

  // Build the in-memory THREE.Object3D for the export dialog. Mirrors the save
  // logic: prefer the fully textured mesh, otherwise the edited geometry with a
  // neutral material.
  const getExportObject = useCallback(() => {
    if (!geometry) {
      throw new Error('No mesh is available to export.')
    }

    const canExportTextured = !!(
      texturableMesh?.root
      && texturableMesh?.textureCanvas
      && geometry?.attributes?.uv?.count
    )

    // Same rule as saving: reattach the skeleton when the weights survived, so
    // the Export dialog (and everything downstream of it — FBX presets, LOD
    // levels, the Game-Ready check) sees a rigged mesh rather than a baked one.
    const rig = geometryHasSkin(geometry) ? rigRef.current : null

    if (canExportTextured) {
      const { object } = buildTexturedMeshObject({
        root: texturableMesh.root,
        textureKey: texturableMesh.textureKey,
        textureCanvas: texturableMesh.textureCanvas,
        textureConfig: texturableMesh.textureConfig
      })
      if (rig) {
        let texturedMaterial = null
        object.traverse(child => {
          if (!texturedMaterial && child.isMesh) {
            texturedMaterial = Array.isArray(child.material) ? child.material[0] : child.material
          }
        })
        const rigged = buildRiggedObject(rig, geometry.clone(), texturedMaterial)
        if (rigged) return rigged
      }
      return object
    }

    // White rather than the viewport placeholder tint — this becomes
    // baseColorFactor in the exported file and would multiply the real colour.
    const material = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.08, roughness: 0.62 })
    // Carry any baked maps onto the fallback material too. The textured path gets
    // them for free (they live on the root's cloned materials); this branch builds
    // a material from scratch and would otherwise drop them.
    Object.entries(appliedMapsRef.current).forEach(([slot, texture]) => {
      if (texture) material[slot] = texture
    })
    material.needsUpdate = true
    if (rig) {
      const rigged = buildRiggedObject(rig, geometry.clone(), material)
      if (rigged) return rigged
    }
    return new THREE.Mesh(geometry.clone(), material)
  }, [geometry, texturableMesh])

  // The rigged GLB for the Auto Rig result card. Built from the LIVE rig, not
  // from the service's blob: once a bone has been moved or deleted that blob is
  // a stale copy of the skeleton, and saving it would quietly throw the
  // corrections away. The blob remains the fallback for the case where adopting
  // the result failed and there is no editable rig to export.
  // `bindPose` forces the skeleton to its rest pose for the export. Off by
  // default because Save / Download should write the mesh as the user is looking
  // at it; the MoCap bake asks for it on, because what it wants is the RIG, and
  // the skeleton on screen may be showing an imported animation's first frame or
  // a clip mid-preview (see withBindPose).
  const buildRiggedResultBlob = useCallback(async ({ bindPose = false } = {}) => {
    // When the last result could not be adopted, the service blob *is* the rig:
    // `rigRef` is then either empty or still describes the mesh as it was before
    // that run, and exporting it would save the wrong skeleton.
    if (riggedBlobRef.current && !rigResultAdoptedRef.current) return riggedBlobRef.current
    if (geometryHasSkin(geometry) && rigRef.current) {
      const target = getExportObject()
      const restore = bindPose ? withBindPose(target) : null
      try {
        const files = await exportObject3D(target, { format: 'glb', baseName: 'rigged' })
        if (files?.[0]?.blob) return files[0].blob
      } finally {
        restore?.()
      }
    }
    return riggedBlobRef.current
  }, [geometry, getExportObject])

  // Published for ensureAnimTargetScene, which runs above this definition.
  useEffect(() => {
    buildRiggedResultBlobRef.current = buildRiggedResultBlob
  }, [buildRiggedResultBlob])

  const handleSaveRiggedResult = useCallback(async () => {
    if (autoRigSaving) return
    try {
      setAutoRigSaving(true)
      setError('')
      setFeedback('Saving rigged mesh…')
      const blob = await buildRiggedResultBlob()
      if (!blob) throw new Error('There is no rigged mesh to save.')
      const baseName = (meshName || 'mesh').trim() || 'mesh'
      const meshFile = new File([blob], `${baseName}-rigged.glb`, { type: 'model/gltf-binary' })
      await saveMeshEdit({
        assetId: Number.isFinite(numericAssetId) && numericAssetId > 0 ? numericAssetId : null,
        filePath,
        name: `${baseName} (rigged)`,
        saveMode: 'version',
        meshFile,
        // Whatever bone mappings this session made ride along in the asset's
        // metadata, so the version that comes out is ready to animate again.
        boneMappings: storedBoneMappingsRef.current,
      })
      setRigEditDirty(false)
      setBoneMappingsDirty(false)
      setFeedback('Rigged mesh saved as a new version.')
    } catch (err) {
      console.error('Failed to save rigged mesh:', err)
      setError(err?.message || 'Failed to save the rigged mesh.')
    } finally {
      setAutoRigSaving(false)
    }
  }, [autoRigSaving, meshName, numericAssetId, filePath, saveMeshEdit, buildRiggedResultBlob])

  const handleDownloadRiggedResult = useCallback(async () => {
    try {
      const blob = await buildRiggedResultBlob()
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${(meshName || 'mesh').trim() || 'mesh'}-rigged.glb`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      console.error('Failed to export the rigged mesh:', err)
      setError(err?.message || 'Failed to export the rigged mesh.')
    }
  }, [meshName, buildRiggedResultBlob])

  // ── Game-Ready check ─────────────────────────────────────────────────────
  const setGameReadyOption = useCallback((key, value) => {
    setGameReadyOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  // Analyses the *export* object rather than the raw geometry: the material and
  // texture counts are only meaningful on the mesh as it would actually ship, and
  // exportGeometryToGlb would hand the service a bare, material-free buffer.
  const handleRunGameReady = useCallback(async () => {
    if (!geometry || gameReadyRunning) {
      return
    }
    setGameReadyRunning(true)
    setError('')
    setFeedback('Running the Game-Ready check…')
    try {
      await ensureDesktopService('meshtools')
      const object = getExportObject()
      const files = await exportObject3D(object, { format: 'glb', baseName: 'inspect' })
      const report = await runInspectService(files[0].blob, {
        options: gameReadyOptions,
        fileName: 'inspect.glb',
      })
      setGameReadyReport(report)
      const failed = report?.summary?.fail || 0
      const warned = report?.summary?.warn || 0
      setFeedback(failed
        ? `Game-Ready check: ${failed} blocking issue${failed === 1 ? '' : 's'}.`
        : warned
          ? `Game-Ready check: ready, with ${warned} warning${warned === 1 ? '' : 's'}.`
          : 'Game-Ready check: everything passed.')
    } catch (err) {
      console.error('Game-Ready check failed:', err)
      setError(err?.message || 'The Game-Ready check failed.')
      setGameReadyReport(null)
    } finally {
      setGameReadyRunning(false)
    }
  }, [geometry, gameReadyRunning, gameReadyOptions, getExportObject])

  // ── Smart Segmentation ───────────────────────────────────────────────────
  // Analyze runs once on the Python service and returns a whole hierarchy of
  // parts. Everything below that — the Parts slider especially — replays that
  // hierarchy locally, so it costs a union-find over ~3000 proxy regions and no
  // round trip. That is why none of it is gated on `segmentRunning`.
  const setSegmentOption = useCallback((key, value) => {
    setSegmentOptions(prev => ({ ...prev, [key]: value }))
  }, [])

  const segmentLabels = useMemo(
    () => (segmentation ? computeSegmentLabels(segmentation, segmentParts, segmentOverrides) : null),
    [segmentation, segmentParts, segmentOverrides]
  )

  const segmentPalette = useMemo(
    () => (segmentLabels ? segmentPaletteFor(segmentLabels.labels, segmentLabels.count) : null),
    [segmentLabels]
  )

  const segmentPartSizes = useMemo(
    () => (segmentLabels ? partFaceCounts(segmentLabels.labels, segmentLabels.count) : null),
    [segmentLabels]
  )

  // Read by the display-geometry memo below, which must NOT depend on the labels
  // themselves: it would then rebuild three full-mesh arrays on every step of the
  // Parts slider, where only the colours actually changed.
  const segmentLabelsRef = useRef(null)
  const segmentPaletteRef = useRef(null)
  const segmentDisplayGeometryRef = useRef(null)
  segmentLabelsRef.current = segmentLabels
  segmentPaletteRef.current = segmentPalette
  segmentTargetFaceRef.current = segmentTargetFace
  segmentToolRef.current = segmentTool
  segmentationRef.current = segmentation

  // ── Smart Segmentation: hand corrections ─────────────────────────────────
  // Read by the pointer callbacks, which fire far more often than React renders
  // and must always see the live arrays rather than a captured closure.
  segmentOverridesRef.current = segmentOverrides

  // Publish a change. The arrays were already mutated in place; this only hands
  // React a new object identity so the label memo re-runs.
  const bumpSegmentOverrides = useCallback(() => {
    setSegmentOverrides(prev => (prev ? { ...prev } : prev))
  }, [])

  // One overrides record per analysis. A fresh Analyze throws the corrections
  // away with it — they are keyed by face index into a hierarchy that no longer
  // exists, and silently re-applying them to a different one is worse than
  // losing them.
  useEffect(() => {
    if (!segmentation) {
      setSegmentOverrides(null)
      setSegmentTool('none')
      setSegmentTargetFace(-1)
      setSegmentMergePicks([])
      segmentUndoStackRef.current = []
      setSegmentCanUndo(false)
      return
    }
    setSegmentOverrides(createSegmentOverrides(segmentation.faceCount))
    setSegmentTargetFace(-1)
    setSegmentMergePicks([])
    segmentUndoStackRef.current = []
    setSegmentCanUndo(false)
    segmentBrushFacesRef.current = new Int32Array(segmentation.faceCount)
    segmentTouchedRef.current = new Uint8Array(segmentation.faceCount)
  }, [segmentation])

  // Leaving the mode disarms whatever tool was live, so a stray click in another
  // mode cannot paint or re-focus.
  useEffect(() => {
    if (activeMenu !== 'segmentation') {
      setSegmentTool('none')
      setSegmentCursor(null)
    }
  }, [activeMenu])

  const segmentPendingSplits = useMemo(() => (
    segmentation && segmentOverrides?.focusMask
      ? countSegmentPendingSplits(segmentation, segmentParts, segmentOverrides)
      : 0
  ), [segmentation, segmentParts, segmentOverrides])

  const segmentPaintedFaces = useMemo(
    () => countPaintedFaces(segmentOverrides),
    [segmentOverrides]
  )

  // The part being picked, drawn in the accent colour. Merge shows every part
  // gathered so far; focus shows the region the Parts slider is cutting into;
  // the brush shows where strokes are landing.
  const segmentHighlight = useMemo(() => {
    if (!segmentLabels || !segmentation) return null
    if (segmentTool === 'merge') {
      if (!segmentMergePicks.length) return null
      const mask = new Uint8Array(segmentLabels.labels.length)
      const picked = new Set(segmentMergePicks.map(face => segmentLabels.labels[face]))
      for (let f = 0; f < mask.length; f += 1) if (picked.has(segmentLabels.labels[f])) mask[f] = 1
      return { mask, dimOthers: true }
    }
    if (segmentOverrides?.focusMask) {
      const mask = new Uint8Array(segmentLabels.labels.length)
      for (let f = 0; f < mask.length; f += 1) mask[f] = segmentOverrides.focusMask[segmentation.mapping[f]]
      return { mask, dimOthers: false }
    }
    if (segmentTool === 'brush' && segmentTargetFace >= 0) {
      const mask = facesOfPart(segmentLabels.labels, segmentTargetFace)
      return mask ? { mask, dimOthers: false } : null
    }
    return null
  }, [segmentLabels, segmentation, segmentTool, segmentMergePicks, segmentTargetFace, segmentOverrides])

  const segmentBrushCursorPixelRadius = useCallback((worldHitPoint, canvasHeight) => {
    const camera = cameraRef.current
    if (!camera || !worldHitPoint) return 24
    const distance = camera.position.distanceTo(worldHitPoint)
    const worldHeightAtDistance = viewWorldHeightAt(camera, distance)
    if (worldHeightAtDistance <= 0) return 24
    return Math.max(4, (segmentBrushSize / worldHeightAtDistance) * canvasHeight)
  }, [segmentBrushSize])

  // One brush dab. Writes the override, then repaints only the faces it moved —
  // see recolorSegmentFaces for why a stroke never goes through the label
  // pipeline. `segmentLabels.labels` is mutated in step with it so the two do
  // not drift mid-stroke; the memo recomputes the same thing on pointer-up.
  const applySegmentDab = useCallback((hit, erase) => {
    const overrides = segmentOverridesRef.current
    const stroke = segmentStrokeRef.current
    const labels = segmentLabelsRef.current
    const palette = segmentPaletteRef.current
    const display = segmentDisplayGeometryRef.current
    const camera = cameraRef.current
    const faces = segmentBrushFacesRef.current
    const target = segmentTargetFaceRef.current
    if (!overrides || !stroke || !labels || !palette || !camera || !faces || !geometry) return

    // The raycast mesh is identity-positioned (see ensureSculptMesh), so the
    // world-space view direction is already the object-space one the geometric
    // face normals inside queryBrushFaces are compared against.
    const direction = hit.worldPoint.clone().sub(camera.position).normalize()
    const found = queryBrushFaces(geometry, hit.point, segmentBrushSize, direction, faces)
    if (!found) return

    const before = stroke.indices.length
    const changed = applyBrushFaces(overrides, faces, found, target, erase,
      segmentTouchedRef.current, stroke)
    if (!changed) return

    const moved = stroke.indices.slice(before)
    const targetLabel = labels.base[target]
    for (const face of moved) labels.labels[face] = erase ? labels.base[face] : targetLabel
    recolorSegmentFaces(display, moved, moved.length, labels.labels, palette)
  }, [geometry, segmentBrushSize])

  const beginSegmentStroke = useCallback(() => {
    segmentTouchedRef.current?.fill(0)
    segmentStrokeRef.current = { indices: [], previous: [], pointerId: -1 }
  }, [])

  const endSegmentStroke = useCallback(() => {
    const stroke = segmentStrokeRef.current
    segmentStrokeRef.current = null
    if (!stroke?.indices.length) return
    const stack = segmentUndoStackRef.current
    stack.push(stroke)
    while (stack.length > 20) stack.shift()
    setSegmentCanUndo(true)
    bumpSegmentOverrides()
    setFeedback(`Reassigned ${stroke.indices.length} face${stroke.indices.length === 1 ? '' : 's'}.`)
  }, [bumpSegmentOverrides])

  const handleSegmentUndo = useCallback(() => {
    const overrides = segmentOverridesRef.current
    const stroke = segmentUndoStackRef.current.pop()
    if (!overrides || !stroke) {
      setSegmentCanUndo(false)
      return
    }
    const restored = undoBrushStroke(overrides, stroke)
    setSegmentCanUndo(segmentUndoStackRef.current.length > 0)
    bumpSegmentOverrides()
    setFeedback(`Undid a stroke of ${restored} face${restored === 1 ? '' : 's'}.`)
  }, [bumpSegmentOverrides])

  const handleSegmentClearPaint = useCallback(() => {
    const overrides = segmentOverridesRef.current
    if (!overrides) return
    const cleared = clearSegmentPaint(overrides)
    segmentUndoStackRef.current = []
    setSegmentCanUndo(false)
    bumpSegmentOverrides()
    setFeedback(cleared ? `Cleared ${cleared} brushed faces.` : 'Nothing was brushed.')
  }, [bumpSegmentOverrides])

  const handleSegmentToolChange = useCallback((tool) => {
    setSegmentTool(current => {
      const next = current === tool ? 'none' : tool
      if (next !== 'merge') setSegmentMergePicks([])
      return next
    })
    setSegmentCursor(null)
  }, [])

  const handleSegmentApplyMerge = useCallback(() => {
    const overrides = segmentOverridesRef.current
    if (!overrides || !segmentation || segmentMergePicks.length < 2) return
    const added = addSegmentMerge(segmentation, overrides, segmentMergePicks)
    setSegmentMergePicks([])
    bumpSegmentOverrides()
    setFeedback(added
      ? `Fused ${added + 1} parts into one.`
      : 'Those faces are already in the same part.')
  }, [segmentation, segmentMergePicks, bumpSegmentOverrides])

  const handleSegmentResetMerges = useCallback(() => {
    const overrides = segmentOverridesRef.current
    if (!overrides) return
    const removed = resetSegmentMerges(overrides)
    setSegmentMergePicks([])
    bumpSegmentOverrides()
    setFeedback(removed ? 'Manual merges cleared.' : 'There were no manual merges.')
  }, [bumpSegmentOverrides])

  const handleSegmentApplyFocus = useCallback(() => {
    const overrides = segmentOverridesRef.current
    if (!overrides || !segmentation) return
    const applied = applySegmentFocus(segmentation, segmentParts, overrides)
    if (!applied) {
      setError('Raise Parts first — there is nothing to apply.')
      return
    }
    setError('')
    bumpSegmentOverrides()
    setFeedback(`Applied ${applied} cut${applied === 1 ? '' : 's'} — pick another part to split.`)
  }, [segmentation, segmentParts, bumpSegmentOverrides])

  const handleSegmentClearFocus = useCallback(() => {
    const overrides = segmentOverridesRef.current
    if (!overrides || !clearSegmentFocus(overrides)) return
    // Back to the pinned level, so the proposed-but-discarded cuts do not linger
    // on the slider as a part count the mesh no longer has.
    if (overrides.anchorK) setSegmentParts(overrides.anchorK)
    bumpSegmentOverrides()
    setFeedback('Focus cleared.')
  }, [bumpSegmentOverrides])

  const handleSegmentResetSplits = useCallback(() => {
    const overrides = segmentOverridesRef.current
    if (!overrides) return
    const removed = resetSegmentSplits(overrides)
    bumpSegmentOverrides()
    setFeedback(removed ? 'All per-part splits cleared.' : 'There were no applied splits.')
  }, [bumpSegmentOverrides])

  // Every segmentation pick goes through here: the merge gather, the focus open,
  // and the brush's target. One raycast, one place to keep the rules.
  const handleSegmentPick = useCallback((faceIndex) => {
    const overrides = segmentOverridesRef.current
    const labels = segmentLabelsRef.current
    if (!overrides || !labels || !segmentation) return

    if (segmentTool === 'merge') {
      const label = labels.labels[faceIndex]
      setSegmentMergePicks(current => (
        current.some(face => labels.labels[face] === label)
          ? current.filter(face => labels.labels[face] !== label)
          : [...current, faceIndex]
      ))
      return
    }

    if (segmentTool === 'focus') {
      const total = openSegmentFocus(segmentation, segmentParts, overrides, faceIndex)
      if (total === null) {
        setError('That part is too small to split further.')
        return
      }
      setError('')
      // Start the slider at the real part count, so each step up is one more cut
      // inside the chosen region rather than a jump to somewhere unrelated.
      setSegmentParts(total)
      setSegmentTool('none')
      bumpSegmentOverrides()
      setFeedback('Splitting that part only — raise Parts to cut inside it.')
      return
    }

    setSegmentTargetFace(faceIndex)
    setFeedback('Target part set — drag to sweep faces into it, Ctrl+drag to release them.')
  }, [segmentTool, segmentation, segmentParts, bumpSegmentOverrides])

  // Published after every callback above exists. Assigned during render rather
  // than in an effect so a pointer event in the same commit already sees the
  // current versions.
  segmentActionsRef.current = {
    pick: handleSegmentPick,
    dab: applySegmentDab,
    beginStroke: beginSegmentStroke,
    endStroke: endSegmentStroke,
    cursorRadius: segmentBrushCursorPixelRadius,
  }

  // The part colours are drawn on a display-only geometry of their own — see
  // createSegmentDisplayGeometry for why it is non-indexed, and why the colours
  // never go on the editable geometry. Coloured HERE rather than in the effect
  // below for the same reason weightPaintGeometry is: under StrictMode React
  // renders twice and commits the second pass, so an effect that fills the
  // colours in afterwards can be writing into the copy that was thrown away.
  const segmentDisplayGeometry = useMemo(() => {
    if (activeMenu !== 'segmentation' || !segmentation || !geometry) return null
    const display = createSegmentDisplayGeometry(geometry)
    if (display && segmentLabelsRef.current && segmentPaletteRef.current) {
      writeSegmentColors(display, segmentLabelsRef.current.labels, segmentPaletteRef.current)
    }
    
    return display
  }, [activeMenu, segmentation, geometry])

  segmentDisplayGeometryRef.current = segmentDisplayGeometry

  // Recolour on every slider step. Touches the colour array and its upload flag,
  // nothing else.
  useEffect(() => {
    if (segmentDisplayGeometry && segmentLabels && segmentPalette) {
      writeSegmentColors(segmentDisplayGeometry, segmentLabels.labels, segmentPalette, {
        highlight: segmentHighlight?.mask || null,
        dimOthers: segmentHighlight?.dimOthers !== false,
      })
    }
  }, [segmentDisplayGeometry, segmentLabels, segmentPalette, segmentHighlight])

  const segmentExplodeDirections = useMemo(() => (
    segmentDisplayGeometry && segmentLabels
      ? computeExplodeDirections(segmentDisplayGeometry, segmentLabels.labels, segmentLabels.count)
      : null
  ), [segmentDisplayGeometry, segmentLabels])

  useEffect(() => {
    if (!segmentDisplayGeometry || !segmentLabels) return
    applySegmentExplode(segmentDisplayGeometry, segmentLabels.labels,
      segmentExplodeDirections, segmentExplode)
  }, [segmentDisplayGeometry, segmentLabels, segmentExplodeDirections, segmentExplode])

  // The pickers all raycast the UNEXPLODED editable mesh, so once the parts have
  // moved the cursor no longer lands where it looks like it does. Disarm rather
  // than let a click reassign a face the user never aimed at.
  useEffect(() => {
    if (segmentExplode > 0) {
      setSegmentTool('none')
      setSegmentCursor(null)
    }
  }, [segmentExplode])

  // A fresh analysis puts the model back together.
  useEffect(() => {
    setSegmentExplode(0)
  }, [segmentation])

  // Dispose the PREVIOUS container when a new one replaces it rather than in a
  // cleanup — StrictMode runs every effect cleanup once on mount, which would
  // tear down the geometry still on screen. Unlike weightPaintGeometry this one
  // owns all of its attributes, so a plain dispose is right.
  const previousSegmentGeometryRef = useRef(null)
  useEffect(() => {
    const previous = previousSegmentGeometryRef.current
    if (previous && previous !== segmentDisplayGeometry) previous.dispose()
    previousSegmentGeometryRef.current = segmentDisplayGeometry
  }, [segmentDisplayGeometry])

  // Every array the service returned is indexed by face number, so an edit that
  // changes the triangle count invalidates all of it. Drop the analysis rather
  // than paint the mesh with labels that no longer describe it.
  useEffect(() => {
    if (!segmentation) return
    if (geometryFaceCount(geometry) !== segmentation.faceCount) {
      setSegmentation(null)
      setSegmentProgress(null)
    }
  }, [geometry, segmentation])

  const handleRunSegment = useCallback(async () => {
    if (!geometry || segmentRunning) return
    setSegmentRunning(true)
    setSegmentProgress({ stage: 'start', frac: 0, message: 'Smart Segmentation starting…' })
    setError('')
    setFeedback('Analyzing the mesh…')
    try {
      await ensureDesktopService('meshtools')
      // The EDITABLE geometry, deliberately not getExportObject(). Every array
      // that comes back is indexed by triangle number, and that only lines up
      // because this exports the index buffer as it stands and the service loads
      // it with process=False. An export object may merge, split by material or
      // reorder, and the labels would then land on the wrong triangles with no
      // symptom beyond a segmentation that looks subtly scrambled.
      const glbBuffer = await exportGeometryToGlb(geometry)
      const meshBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' })
      const result = await runSegmentService(meshBlob, {
        options: segmentOptions,
        fileName: 'segment.glb',
        onProgress: evt => setSegmentProgress(evt),
      })

      const localFaces = geometryFaceCount(geometry)
      if (result.faceCount !== localFaces) {
        throw new Error(
          `The service segmented ${result.faceCount.toLocaleString()} faces but the editor has `
          + `${localFaces.toLocaleString()}. The part labels would land on the wrong triangles, `
          + 'so the result was discarded.'
        )
      }

      setSegmentation(result)
      if (result.suggestedParts) setSegmentParts(result.suggestedParts)
      setFeedback(result.escapeRatio > 0.35
        ? `Analyzed ${result.proxyFaceCount.toLocaleString()} proxy faces — the mesh is open, so thickness is unreliable.`
        : `Analyzed ${result.proxyFaceCount.toLocaleString()} proxy faces. Drag Parts to choose the split.`)
    } catch (err) {
      console.error('Smart Segmentation failed:', err)
      setError(err?.message || 'Smart Segmentation failed.')
    } finally {
      setSegmentRunning(false)
      setSegmentProgress(null)
    }
  }, [geometry, segmentRunning, segmentOptions])

  const handleAutoSegmentParts = useCallback(() => {
    const suggested = segmentation?.suggestedParts
    if (!suggested) return
    setSegmentParts(suggested)
    setFeedback(`Jumped to ${suggested} parts — the largest jump in merge cost.`)
  }, [segmentation])

  const handleClearSegmentation = useCallback(() => {
    setSegmentation(null)
    setSegmentProgress(null)
    setFeedback('Segmentation cleared.')
  }, [])

  const handleExportSegmentParts = useCallback(async () => {
    if (!geometry || !segmentLabels || !segmentPalette || segmentExporting) return
    setSegmentExporting(true)
    setError('')
    try {
      const baseName = (meshName || 'mesh').trim() || 'mesh'
      const parts = buildPartGeometries(geometry, segmentLabels.labels, segmentLabels.count, {
        minFaces: segmentMinPartFaces,
      })
      if (!parts.length) {
        throw new Error('Every part is below the minimum face count — lower it, or use fewer parts.')
      }
      const blob = await exportPartsToGlb(parts, segmentPalette, baseName)
      // The part geometries only existed to be written into the GLB.
      parts.forEach(part => part.geometry.dispose())

      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${baseName}-parts.glb`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setFeedback(`Exported ${parts.length} part${parts.length === 1 ? '' : 's'}.`)
    } catch (err) {
      console.error('Failed to export the segmented parts:', err)
      setError(err?.message || 'Failed to export the segmented parts.')
    } finally {
      setSegmentExporting(false)
    }
  }, [geometry, segmentLabels, segmentPalette, segmentMinPartFaces, segmentExporting, meshName])

  // What the viewport is actually showing. Segmentation and weight painting each
  // override the PBR / Albedo / Sculpt choice for as long as they are on —
  // including the lights, since the standard 1.25 ambient flattens both a weight
  // ramp and a part palette into a bright wash.
  //
  // Declared HERE, below both display geometries, rather than up beside
  // weightPaintGeometry where it used to live: `segmentDisplayGeometry` is
  // defined in this section, so reading it from up there is a temporal dead zone
  // and throws on every render.
  const viewportDisplayMode = segmentDisplayGeometry
    ? 'segments'
    : weightPaintGeometry ? 'weights' : displayMode

  // Move the mesh's pivot to where an engine expects it. 'ground_pivot' drops the
  // mesh onto Y=0 centred on X/Z (a prop that snaps to the floor when placed);
  // 'centre_pivot' puts the bbox centre on the origin (so the asset rotates about
  // itself). Pure client-side translation of the editable geometry — no service
  // round trip — and it goes through applyGeometryUpdate, so Ctrl+Z undoes it.
  const handleMovePivot = useCallback((mode) => {
    if (!geometry) {
      return
    }
    const next = geometry.clone()
    next.computeBoundingBox()
    const box = next.boundingBox
    if (!box) {
      return
    }

    const offsetX = -(box.min.x + box.max.x) / 2
    const offsetZ = -(box.min.z + box.max.z) / 2
    const offsetY = mode === 'ground_pivot' ? -box.min.y : -(box.min.y + box.max.y) / 2

    if (Math.abs(offsetX) < 1e-9 && Math.abs(offsetY) < 1e-9 && Math.abs(offsetZ) < 1e-9) {
      next.dispose?.()
      setFeedback('The pivot is already in place.')
      return
    }

    next.translate(offsetX, offsetY, offsetZ)
    next.computeBoundingBox()
    next.computeBoundingSphere()
    applyGeometryUpdate(next, [], { pushUndo: true })

    // Move the rig with the mesh. Neither the captured bones nor the overlay
    // follow the geometry on their own — the bones are a separate scene graph and
    // the overlay is baked world-space arrays.
    //
    // When there IS a captured rig it becomes the single source of truth: the
    // bones move, and the overlay is re-derived from them. Keeping two copies in
    // step by translating both invites exactly the drift this is fixing.
    if (rigRef.current) {
      translateRig(rigRef.current, offsetX, offsetY, offsetZ)
      try {
        setSkeleton(extractSkeletonFromObject(rigRef.current.rigScene))
      } catch (err) {
        console.warn('Could not re-derive the skeleton overlay after moving the pivot:', err)
        setSkeleton(prev => (prev ? translateSkeleton(prev, offsetX, offsetY, offsetZ) : prev))
      }
    } else {
      // No captured rig (e.g. the skeleton came from an in-session Auto Rig):
      // the overlay arrays are all there is, so shift them directly.
      setSkeleton(prev => (prev ? translateSkeleton(prev, offsetX, offsetY, offsetZ) : prev))
    }
    // Show the user the check going green rather than making them re-run it. The
    // re-check has to wait for the new geometry to land in state — see the
    // geometryRevision effect below.
    pendingGameReadyRecheckRef.current = true
    setFeedback(mode === 'ground_pivot'
      ? 'Pivot moved to the ground at the origin.'
      : 'Pivot centred on the origin.')
  }, [geometry, applyGeometryUpdate])

  // A finding's fix button either jumps to the mode that resolves it (Repair has
  // no mode of its own — its controls live inside the Auto Retopo panel) or, for
  // the parameterless corrections, applies the fix directly.
  const handleGameReadyFix = useCallback((fix) => {
    if (fix === 'ground_pivot' || fix === 'centre_pivot') {
      handleMovePivot(fix)
      return
    }
    setActiveMenu(fix === 'repair' ? 'autoretopo' : fix)
  }, [handleMovePivot])

  // Re-run the check after a fix that edits the mesh. It cannot be called inline:
  // handleRunGameReady reads `geometry` from its closure, which still holds the
  // pre-fix mesh until React commits the update — so it would re-measure the mesh
  // we just changed and report the same warning.
  useEffect(() => {
    if (!pendingGameReadyRecheckRef.current) {
      return
    }
    pendingGameReadyRecheckRef.current = false
    handleRunGameReady()
  }, [geometryRevision, handleRunGameReady])

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
      // Reattach the rig when the geometry still carries its weights. The
      // display root is deliberately un-skinned, so neither export path can find
      // the skeleton on its own — it is threaded through explicitly.
      const rig = geometryHasSkin(geometry) ? rigRef.current : null
      const meshBinary = canExportTextured
        ? await exportTexturedMeshToGlb({
          root: texturableMesh.root,
          textureKey: texturableMesh.textureKey,
          textureCanvas: texturableMesh.textureCanvas,
          textureConfig: texturableMesh.textureConfig,
          rig,
          geometry
        })
        : await exportGeometryToGlb(geometry, rig)
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
        meshFile,
        // The mapping is part of what makes a mesh animatable, so it is saved
        // with it — by every save, not only the ones made from the Auto Rig tab.
        boneMappings: storedBoneMappingsRef.current
      })

      try {
        const savedAssetUrl = savedAsset?.filename ? assetUrl(savedAsset.filename) : ''
        // `cache: 'reload'` because a "replace" save keeps the asset's URL: the
        // browser still holds the pre-save mesh for it, and a thumbnail rendered
        // from those bytes would show the mesh as it was before the edit.
        const response = savedAssetUrl ? await fetch(savedAssetUrl, { cache: 'reload' }) : null
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
        const savedUrl = savedFilename ? assetUrl(savedFilename) : modelUrl

        nextSearchParams.set('assetId', String(savedAsset.id))
        nextSearchParams.set('filePath', savedAsset.filePath || '')
        nextSearchParams.set('url', savedUrl)
        nextSearchParams.set('name', savedAsset.name || meshName)

        navigate(`/mesh-editor?${nextSearchParams.toString()}`, { replace: true })
      }

      setBoneMappingsDirty(false)
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
    projectionUvOccupancyRef.current = null
    projectionSurfacePositionsRef.current = null
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
          `feather:${effectiveMaskFeather}`,
          // Occlusion/visibility behaviour version. Bump this whenever the bake's
          // cullBackfaces / minFacing / bias change, so cached layer bakes are
          // invalidated and re-baked with the new visibility rules (otherwise a
          // re-apply silently reuses the stale canvas).
          `occl:v3-cull-occ`
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
          let gpuBaked = false
          // ── GPU UV-space bake (analysis Steps 1–3): depth-map occlusion +
          //    parallel projective texturing. Hard-edged output (no UV feather,
          //    no screen-space seam smear) → fixes occlusion, speed and the leak.
          //    Slots straight into the existing layer composite below.
          if (USE_GPU_PROJECTION_BAKE) {
            try {
              const maskCanvasGpu = createProjectionCropMaskCanvasFromPatch(patchCanvas, effectiveCropBorder)
              const gpu = await bakeViewToTextureGPU({
                root: texturableMesh.root,
                textureKey: texturableMesh.textureKey,
                textureConfig: texturableMesh.textureConfig,
                camera: projectionCamera,
                viewImage: patchCanvas,
                maskImage: maskCanvasGpu,
                textureWidth: texW,
                textureHeight: texH,
                // Steep cosine (α≈6, per the analysis) makes the best-facing view
                // dominate, so a later view (e.g. top) does not contaminate texels a
                // better-facing earlier view (e.g. front) already owns. The composite's
                // border feather still gives a smooth cross-fade where two views see a
                // surface equally well. minFacing rejects extreme-grazing texels (where
                // the projector only samples its silhouette/background → black matte
                // lines) so they never enter this view's coverage.
                alpha: 6,
                viewOpacity: 1,
                // Cull back faces. With culling OFF the shader uses abs(ndotv), so a
                // face whose normal points away from the projector is treated as
                // well-facing and is rejected only by depth occlusion. At silhouettes
                // / folds the back face is the first (only) surface the projector ray
                // hits, so depth can't reject it and the front view leaks onto the
                // back (scattered speckles on the far side). Culling discards anything
                // with ndotv <= minFacing — the correct projection-painting rule.
                cullBackfaces: true,
                minFacing: 0.12,
                minMaskAlpha: 0.12
              })
              if (projectionRebuildTokenRef.current !== rebuildToken) {
                return
              }
              if (gpu && gpu.canvas) {
                const coverageMask = gpu.coverageMask
                const ownershipMask = new Uint8Array(texW * texH)
                for (let i = 0; i < ownershipMask.length; i += 1) {
                  // Mirror the CPU minAlpha:112 'confident core' using GPU cosine
                  // confidence (0.44 ≈ 112/255).
                  ownershipMask[i] = gpu.confidenceMap[i] >= 0.44 ? 1 : 0
                }
                const sharedSeamMask = new Uint8Array(texW * texH) // Step 0: empty
                layerData.bakedCanvas = gpu.canvas
                layerData.bakeSignature = bakeSignature
                layerData.coverageMask = coverageMask
                layerData.ownershipMask = ownershipMask
                layerData.sharedSeamMask = sharedSeamMask
                layerData.confidenceMap = gpu.confidenceMap
                if (gpu.uvOccupancyMask && gpu.uvOccupancyMask.length === texW * texH) {
                  projectionUvOccupancyRef.current = gpu.uvOccupancyMask
                }
                accumulateStats = { occlusionModeUsed: `gpu:${gpu.occlusionModeUsed}`, appliedSamples: gpu.coveredTexels || 0 }
                finalizeStats = { appliedPixels: 0 }
                gpuBaked = true
              }
            } catch (gpuErr) {
              if (typeof console !== 'undefined') {
                console.warn('[Projection] GPU bake failed, using CPU fallback:', gpuErr)
              }
            }
          }

          if (!gpuBaked) {
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
            // Drives the view-space seam radius (croppable border width).
            blendPixels: effectiveBlendPixels,
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
            // Cull back faces (matches the GPU path). At silhouettes/folds the back
            // face is the first raycast hit, so occlusion alone can't reject it and
            // the front projection leaks onto the far side.
            cullBackfaces: true,
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
          // Seams are the projection's croppable view-space border (outer
          // silhouette + self-occlusion edges), computed during the bake from
          // screen-space coverage rather than the UV layout. AND with the final
          // coverage so seams only mark texels that actually ended up covered
          // after gap-fill / edge-bleed.
          const viewSeamMask = accumulateStats?.viewSeamMask
          const sharedSeamMask = new Uint8Array(texW * texH)
          if (PROJECTION_USE_SCREEN_SEAM_MASK && viewSeamMask && viewSeamMask.length === texW * texH) {
            for (let i = 0; i < sharedSeamMask.length; i += 1) {
              if (coverageMask[i] && viewSeamMask[i]) {
                sharedSeamMask[i] = 1
              }
            }
          }
          const confidenceMap = buildProjectionConfidenceMap(accumulatedWeight, coverageMask, alphaBytes)

          layerData.bakedCanvas = bakedCanvas
          layerData.bakeSignature = bakeSignature
          layerData.coverageMask = coverageMask
          layerData.ownershipMask = ownershipMask
          layerData.sharedSeamMask = sharedSeamMask
          layerData.confidenceMap = confidenceMap
          }
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

          let snapshot = {
            pixelData: bakedImage.data,
            coverageMask: layerCoverage,
            ownershipMask: layerOwnership,
            sharedSeamMask: layerSharedSeam,
            confidenceMap: layerConfidence,
            opacity: layerOpacity,
            opacitySeams: layerOpacitySeams,
            blendMode: layerBlendMode,
            blendPixels: effectiveBlendPixels
          }
          // Gate the layer by its user-drawn mask (if any): the view is applied only
          // where the mask is painted; elsewhere lower layers / the base show through.
          const maskAlpha = refreshLayerMaskAlpha(layerData)
          if (maskAlpha) {
            snapshot = gateProjectionSnapshotByMask(snapshot, maskAlpha)
          }
          layerSnapshots.push(snapshot)
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

      // Per-view gain compensation (Brown–Lowe): align each projection's overall
      // tone to the others using their overlap colours, so views ComfyUI generated
      // with different lighting/tint don't leave a visible colour step at the seam.
      // Solved across all visible layers; identity for a single layer.
      let viewGains = null
      if (PROJECTION_GAIN_COMPENSATION && layerSnapshots.length > 1) {
        try {
          viewGains = solveViewGains(
            layerSnapshots.map(l => l.pixelData),
            layerSnapshots.map(l => l.coverageMask),
            texW,
            texH,
            // Only let head-on co-visible texels inform the solve, so the grazing
            // wrap-around "overlap" between opposite-facing views (whose colours
            // genuinely differ) can no longer drive a whole-view tint.
            { perViewConfidence: layerSnapshots.map(l => l.confidenceMap) }
          )
          // Gain compensation only equalises the views UP TO A GLOBAL SCALE — the
          // shared brightness target is pinned only by a weak prior, so adding a
          // darker view can drag every gain below 1 and darken the whole mesh.
          // Anchor the reference: pin layer 0 (the owner) to gain 1 and express the
          // rest relative to it, so the owner keeps its brightness and the scale
          // cannot drift. Re-clamp to keep a single view from blowing out.
          if (viewGains && viewGains.length > 1) {
            const ref = viewGains[0]
            for (let ch = 0; ch < 3; ch += 1) {
              const r = ref[ch]
              if (Math.abs(r) <= 1e-3) {
                continue
              }
              for (let k = 0; k < viewGains.length; k += 1) {
                // Tight clamp (matches solveViewGains): mild exposure correction only,
                // never wide enough to flip a hue when re-expressed relative to layer 0.
                viewGains[k][ch] = Math.max(0.82, Math.min(1.22, viewGains[k][ch] / r))
              }
            }
          }
        } catch (gainErr) {
          if (typeof console !== 'undefined') {
            console.warn('[Projection] gain compensation failed, using identity:', gainErr)
          }
          viewGains = null
        }
      }

      // Cache the solved gains so the live (mask-drawing) compose reuses them and
      // the colours stay stable while painting, instead of snapping to identity.
      projectionViewGainsRef.current = viewGains

      const keepingBaseTexture = Boolean(baseSnapshot && baseSnapshot.width === texW && baseSnapshot.height === texH)
      const surfacePositions = keepingBaseTexture ? getProjectionSurfacePositions(texW, texH) : null
      resolveProjectionLayersIntoImageData(composedData, layerSnapshots, texW, texH, viewGains, projectionUvOccupancyRef.current, keepingBaseTexture, surfacePositions)
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
  }, [texturableMesh, getProjectionSurfacePositions])

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

  // Leaving Projection mode cancels any in-progress mask drawing.
  useEffect(() => {
    if (activeMenu !== 'projection' && projectionMaskEditLayerId) {
      projectionMaskStrokeRef.current = null
      setProjectionMaskEditLayerId(null)
    }
  }, [activeMenu, projectionMaskEditLayerId])

  const handleUpdateProjectionLayer = useCallback((id, updates) => {
    setProjectionLayers(current => current.map(layer => layer.id === id ? { ...layer, ...updates } : layer))
  }, [])

  const handleDeleteProjectionLayer = useCallback((id) => {
    projectionLayerDataRef.current.delete(id)
    setProjectionMaskEditLayerId(current => (current === id ? null : current))
    setProjectionLayers(current => current.filter(layer => layer.id !== id))
  }, [])

  // Enter mask-drawing mode for a layer (or toggle it off if already active).
  const handleToggleProjectionMaskDraw = useCallback((layerId) => {
    setProjectionMaskEditLayerId(current => {
      if (current === layerId) {
        return null
      }
      ensureLayerMaskCanvas(layerId)
      return layerId
    })
  }, [ensureLayerMaskCanvas])

  const handleExitProjectionMaskDraw = useCallback(() => {
    projectionMaskStrokeRef.current = null
    setProjectionMaskEditLayerId(null)
  }, [])

  // Clear a layer's mask → the layer applies its whole view again (default). Runs
  // asynchronously (animated veil + blocked UI) like a released stroke, since the
  // re-compose is the same expensive operation.
  const handleClearProjectionLayerMask = useCallback((layerId) => {
    if (maskApplyingRef.current) {
      return
    }
    applyProjectionMaskAsync(layerId, projectionLayers, () => {
      const layerData = projectionLayerDataRef.current.get(layerId)
      if (layerData?.maskCanvas) {
        const ctx = layerData.maskCanvas.getContext('2d')
        ctx.clearRect(0, 0, layerData.maskCanvas.width, layerData.maskCanvas.height)
        layerData.maskDirty = true
        layerData.maskHasPixels = false
        layerData.maskAlpha = null
      }
    })
  }, [applyProjectionMaskAsync, projectionLayers])

  // Fill a layer's mask opaque everywhere → the whole view applies again, but now
  // the user can erase small parts instead of having to paint the mask over the
  // entire mesh just to keep a small region clear.
  const handleFillProjectionLayerMask = useCallback((layerId) => {
    if (maskApplyingRef.current) {
      return
    }
    const canvas = ensureLayerMaskCanvas(layerId)
    const layerData = projectionLayerDataRef.current.get(layerId)
    if (!canvas || !layerData) {
      return
    }
    applyProjectionMaskAsync(layerId, projectionLayers, () => {
      const ctx = canvas.getContext('2d')
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      layerData.maskDirty = true
      layerData.maskHasPixels = true
      layerData.maskAlpha = null
    })
  }, [applyProjectionMaskAsync, ensureLayerMaskCanvas, projectionLayers])

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
    projectionViewGainsRef.current = null
    setProjectionMaskEditLayerId(null)
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
        setFeedback('Smoothing silhouette seams...')
        const seamBase = postProcFillHolesEnabled ? 0.9 : 0
        const seamShare = 1 - seamBase
        setProjectionRebuildProgress(seamBase)
        await applySeamPostProcessing(
          textureCanvas,
          snapshots,
          postProcSeamThreshold,
          postProcBlurRadius,
          postProcStrength,
          texturableMesh,
          p => setProjectionRebuildProgress(seamBase + p * seamShare)
        )
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
      setComfyRunCancelling(false)
      comfyRunCancellingRef.current = false
      comfyRunCancelRequestedRef.current = false
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

        // Erode a 0/255 alpha mask inward by `radius` pixels (separable min
        // filter). A texel survives only if every texel within the radius is
        // also set, so the boundary band shrinks uniformly.
        const erodeBinaryAlpha = (src, w, h, radius) => {
          if (radius <= 0) return src
          const tmp = new Uint8Array(src.length)
          for (let y = 0; y < h; y += 1) {
            const row = y * w
            for (let x = 0; x < w; x += 1) {
              const x0 = x - radius < 0 ? 0 : x - radius
              const x1 = x + radius >= w ? w - 1 : x + radius
              let keep = 255
              for (let xx = x0; xx <= x1; xx += 1) {
                if (src[row + xx] === 0) { keep = 0; break }
              }
              tmp[row + x] = keep
            }
          }
          const out = new Uint8Array(src.length)
          for (let x = 0; x < w; x += 1) {
            for (let y = 0; y < h; y += 1) {
              const y0 = y - radius < 0 ? 0 : y - radius
              const y1 = y + radius >= h ? h - 1 : y + radius
              let keep = 255
              for (let yy = y0; yy <= y1; yy += 1) {
                if (tmp[yy * w + x] === 0) { keep = 0; break }
              }
              out[y * w + x] = keep
            }
          }
          return out
        }

        // The covered/uncovered seams and the mesh silhouette carry a thin white
        // fringe in the textured render — the render's edge anti-aliasing plus
        // the light, still-untextured base texels exposed right at the boundary.
        // The screen-space coverage mask keeps a slightly oversized region, so
        // that fringe survives a plain threshold. Trim it by eroding the alpha
        // inward a few pixels; ComfyUI re-inpaints the shaved border anyway.
        const seamFringeErodePx = Math.max(2, Math.round(sendResolution / 340))

        // Threshold the mask render's brightness against the dark scene background
        // (#0b0d12 ≈ 11) so off-mesh and the inverse-classified surface both
        // become fully transparent, then erode to drop the white seam fringe.
        const composeMaskedView = (maskRenderCanvas) => {
          const composedCanvas = document.createElement('canvas')
          composedCanvas.width = sendResolution
          composedCanvas.height = sendResolution
          const composedCtx = composedCanvas.getContext('2d')
          composedCtx.drawImage(texturedViewCanvas, 0, 0)
          const composed = composedCtx.getImageData(0, 0, sendResolution, sendResolution)
          const maskPixels = maskRenderCanvas.getContext('2d').getImageData(0, 0, sendResolution, sendResolution).data
          const pixelCount = sendResolution * sendResolution
          // Start from a tight threshold so the anti-aliased mask edge is already
          // excluded before erosion shrinks the band further.
          const alpha = new Uint8Array(pixelCount)
          for (let p = 0; p < pixelCount; p += 1) {
            alpha[p] = maskPixels[p * 4] > 96 ? 255 : 0
          }
          const eroded = erodeBinaryAlpha(alpha, sendResolution, sendResolution, seamFringeErodePx)
          for (let p = 0; p < pixelCount; p += 1) {
            composed.data[p * 4 + 3] = eroded[p]
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
      setComfyRunPromptId(promptId)
      const stopProgress = subscribeToComfyWorkflowProgress(promptId, {
        onMessage: payload => {
          const detail = payload?.detail || payload?.currentNodeLabel
          if (detail && !comfyRunCancellingRef.current) {
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
          hasMask: false,
          sendResolution
        }
      ]))

      if (projectId && nodeId) {
        await updateProjectNode(Number(projectId), Number(nodeId), {
          metadata: { lastAction: 'mesh-editor-projection' }
        })
      }

      setFeedback(`${layerName} added to the projection stack.`)
      if (projectionSetAsDefault && await saveWorkflowDefaults(updateComfyWorkflow, selectedProjectionWorkflow, projectionWorkflowInputs)) {
        try {
          setComfyWorkflows(await getComfyWorkflows())
        } catch (refreshErr) {
          console.error('Failed to refresh ComfyUI workflows:', refreshErr)
        }
      }
    } catch (projectionError) {
      // A run the user stopped is not a failure: no error banner, no notification.
      if (projectionError?.cancelled) {
        setFeedback('Workflow cancelled.')
      } else {
        const failureMessage = projectionError?.message || 'Failed to project workflow result to texture.'
        setError(failureMessage)
        setFeedback('')
        addNotification({
          title: 'Projection failed',
          message: failureMessage,
          source: 'ComfyUI',
          tone: 'error'
        })
      }
    } finally {
      setProjecting(false)
      setComfyRunPromptId(null)
      setComfyRunCancelling(false)
      comfyRunCancellingRef.current = false
      comfyRunCancelRequestedRef.current = false
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
    projectionSetAsDefault,
    projecting,
    getComfyWorkflows,
    runComfyWorkflow,
    selectedProjectionWorkflow,
    subscribeToComfyWorkflowProgress,
    texturableMesh,
    updateComfyWorkflow,
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
      setComfyRunCancelling(false);
      comfyRunCancellingRef.current = false;
      comfyRunCancelRequestedRef.current = false;

      // Pre‑upload static images (assets / local files) to ComfyUI once
      const staticFiles = {};
      for (const { paramId, config } of staticImageParams) {
        let file = null;
        if (config.type === 'asset') {
          // Build asset URL
          const url = config.filePath ? assetUrl(config.filePath.replace(/^data\/assets\//, '')) : null;
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
        // Cancelled between views (while the previous patch was being baked):
        // end the pass here instead of sending the next view to ComfyUI.
        if (comfyRunCancelRequestedRef.current) {
          const cancelledError = new Error('Workflow cancelled');
          cancelledError.cancelled = true;
          throw cancelledError;
        }

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

        setComfyRunPromptId(viewPromptId);

        const stopProgress = subscribeToComfyWorkflowProgress(viewPromptId, {
          onMessage: payload => {
            const detail = payload?.detail || payload?.currentNodeLabel;
            if (detail && !comfyRunCancellingRef.current) setFeedback(`${detail}${viewLabel}`);
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

        // GPU fast path: replace the per-texel CPU raycast bake with the GPU
        // UV-space bake (depth-map occlusion). viewPatchCanvas already holds the
        // base texture, so the hard-edged, covered-only GPU result is drawn over it
        // — matching finalizeProjectedPatch's project-over-base behaviour.
        let viewGpuBaked = false
        if (USE_GPU_PROJECTION_BAKE) {
          try {
            // The GPU projector covers the full camera frustum and has no bbox
            // parameter (unlike the CPU accumulateProjectedPatch, which takes
            // `bbox: viewBbox`). The inpaint result only covers the cropped
            // viewBbox region, so re-expand it onto a full screen-space canvas at
            // the crop's original position before baking — otherwise the crop is
            // stretched across the whole view and the painted zone samples the
            // wrong pixels, producing the washed-out/white patch. viewScreenMask
            // is already full screen-space (its alpha carries the painted zone).
            const gpuViewCanvas = document.createElement('canvas');
            gpuViewCanvas.width = screenW;
            gpuViewCanvas.height = screenH;
            gpuViewCanvas.getContext('2d').drawImage(
              patchImage,
              viewBbox.x,
              viewBbox.y,
              viewBbox.width,
              viewBbox.height
            );
            const gpu = await bakeViewToTextureGPU({
              root: texturableMesh.root,
              textureKey: texturableMesh.textureKey,
              textureConfig: texturableMesh.textureConfig,
              camera: viewCamera,
              viewImage: gpuViewCanvas,
              maskImage: viewScreenMask,
              textureWidth,
              textureHeight,
              alpha: 6,
              viewOpacity: 1,
              // Cull back faces — see the rebuild path above. Without this the
              // front projection leaks onto back-facing geometry at silhouettes
              // and folds, which depth occlusion alone cannot reject.
              cullBackfaces: true,
              minFacing: 0.12,
              minMaskAlpha: 0.12
            });
            if (gpu && gpu.canvas) {
              setFeedback(`Reprojecting${viewLabel}… 100%`);
              viewPatchContext.drawImage(gpu.canvas, 0, 0);
              viewGpuBaked = true;
            }
          } catch (gpuErr) {
            if (typeof console !== 'undefined') {
              console.warn('[Projection] GPU reproject failed, using CPU fallback:', gpuErr);
            }
          }
        }

        if (!viewGpuBaked) {
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
        }

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
      if (textureSetAsDefault && await saveWorkflowDefaults(updateComfyWorkflow, selectedTextureWorkflow, textureWorkflowInputs)) {
        try {
          setComfyWorkflows(await getComfyWorkflows())
        } catch (refreshErr) {
          console.error('Failed to refresh ComfyUI workflows:', refreshErr)
        }
      }
    } catch (textureError) {
      // Cancelling a view aborts the whole multi-view pass: the rejection lands
      // here, so no later view is captured or sent.
      if (textureError?.cancelled) {
        setFeedback('Workflow cancelled.');
      } else {
        const failureMessage = textureError.message || 'Failed to regenerate the mesh texture.'
        setError(failureMessage);
        setFeedback('');
        addNotification({
          title: 'Mesh edit failed',
          message: failureMessage,
          source: 'ComfyUI',
          tone: 'error'
        })
      }
    } finally {
      setTexturing(false);
      setComfyRunPromptId(null);
      setComfyRunCancelling(false);
      comfyRunCancellingRef.current = false;
      comfyRunCancelRequestedRef.current = false;
    }
  }, [
    cropPadding, featherRadius, meshName, multiViewCount, nodeId,
    patchNoise, patchSharpness, patchSaturation, projectionOpacities,
    projectId, runComfyWorkflow, selectedTextureWorkflow,
    subscribeToComfyWorkflowProgress, texturableMesh,
    textureWorkflowInputs, textureSetAsDefault, texturing, updateProjectNode,
    updateComfyWorkflow, getComfyWorkflows,
    updateMaskOverlay, imageParamSources, addNotification
  ]);

  // Stop the ComfyUI run in flight (Texturing or Projection). The run itself
  // ends through its own cancellation — the pending call rejects with
  // `cancelled` — so a cancel ComfyUI refuses leaves the run going rather than
  // pretending it stopped.
  const handleCancelComfyRun = useCallback(async () => {
    if (!comfyRunPromptId || comfyRunCancelling) {
      return
    }

    setComfyRunCancelling(true)
    comfyRunCancellingRef.current = true
    comfyRunCancelRequestedRef.current = true
    setFeedback('Cancelling…')

    try {
      await cancelComfyWorkflow(comfyRunPromptId)
    } catch (cancelError) {
      setComfyRunCancelling(false)
      comfyRunCancellingRef.current = false
      comfyRunCancelRequestedRef.current = false
      setFeedback(cancelError.message || 'Failed to cancel the workflow.')
    }
  }, [cancelComfyWorkflow, comfyRunCancelling, comfyRunPromptId])

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
                <button type="button" className="mesh-editor-btn mesh-editor-btn--secondary" onClick={() => setShowExport(true)} disabled={!geometry}>Export</button>
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
                  className="mesh-editor-btn mesh-editor-btn--ghost"
                  onClick={cycleDisplayMode}
                  aria-label={`Display mode: ${displayMode}`}
                  title="Cycle PBR, Albedo, and Sculpt viewport shading"
                >
                  {displayMode === 'pbr'
                    ? 'PBR'
                    : displayMode === 'albedo'
                      ? 'Albedo'
                      : 'Sculpt'}
                </button>
                <button
                  type="button"
                  className={`mesh-editor-btn ${orthographic ? 'mesh-editor-btn--secondary' : 'mesh-editor-btn--ghost'}`}
                  onClick={() => setOrthographic(current => !current)}
                  aria-pressed={orthographic}
                  disabled={cameraLockedToPerspective}
                  title={cameraLockedToPerspective
                    ? 'Texturing and Projection project through the viewport camera, which only works in perspective.'
                    : 'Switch the viewport between a perspective and an orthographic projection'}
                >
                  {orthographic ? 'Orthographic' : 'Perspective'}
                </button>
                {displayMode === 'sculpt' && (
                  <button
                    type="button"
                    className={`mesh-editor-btn ${showWireframe ? 'mesh-editor-btn--secondary' : 'mesh-editor-btn--ghost'}`}
                    onClick={() => setShowWireframe(current => !current)}
                    aria-pressed={showWireframe}
                    title={showWireframe ? 'Hide wireframe overlay' : 'Show wireframe overlay'}
                  >
                    {showWireframe ? 'Wireframe: On' : 'Wireframe: Off'}
                  </button>
                )}
              </div>
            </div>
            <div className="mesh-editor-toolbar__stats">
              <span>{stats.vertices} vertices</span>
              <span>{stats.faces} faces</span>
            </div>
          </div>

          {/* Always rendered (even when empty) so its presence never toggles the
              `.mesh-editor-feedback ~ .mesh-editor-workspace` sibling rules. Those
              rules resize the canvas shell; if the div appeared only when a message
              arrives (e.g. on ComfyUI send), the WebGL surface would resize mid-flow
              and shift an already-painted projection mask out of alignment. */}
          <div
            className={`mesh-editor-feedback ${error ? 'mesh-editor-feedback--error' : 'mesh-editor-feedback--success'}`}
            role="status"
            aria-live="polite"
          >
            {(error || feedback) && (
              <>
                <span className="material-symbols-outlined">{error ? 'error' : 'check_circle'}</span>
                <span>{error || feedback}</span>
              </>
            )}
          </div>

          <div className={`mesh-editor-workspace ${
            (activeMenu === 'painting' || activeMenu === 'projection')
              ? 'mesh-editor-workspace--with-layers'
              : (activeMenu === 'autorig' && skeleton)
                ? 'mesh-editor-workspace--with-skeleton'
                : ''
          }`}>
            <aside className="mesh-editor-sidebar">
              <div className="mesh-editor-panel mesh-editor-panel--compact">
                <ToolModeMenu
                  activeMenu={activeMenu}
                  onSelect={setActiveMenu}
                  textureModesSupported={textureModesSupported}
                  textureModesDisabledReason={textureModesDisabledReason}
                />

                <div className="mesh-editor-panel__tools-body">
                  {texturableMesh?.isBlank && (
                    <div className="mesh-editor-panel__section">
                      <span className="mesh-editor-panel__section-title">Base texture</span>
                      <div className="mesh-editor-workflow-field">
                        <span>Resolution</span>
                        <select
                          className="mesh-editor-panel__input mesh-editor-panel__select"
                          value={String(blankTextureSize)}
                          onChange={event => handleBlankTextureSizeChange(Number(event.target.value))}
                        >
                          {[512, 1024, 2048, 4096].map(n => (
                            <option key={n} value={String(n)}>{n} × {n}</option>
                          ))}
                        </select>
                      </div>
                      <span className="mesh-editor-panel__hint">
                        This mesh has UVs but no texture yet — painting/texturing/projection
                        start from a blank {blankTextureSize}×{blankTextureSize} canvas.
                      </span>
                    </div>
                  )}

                  {activeMenu === 'modeling' ? (
                    <ModelingToolsPanel {...{
                      selectionMode, setSelectionMode, resetSelection,
                      modelingCanUndo, modelingCanRedo, handleModelingUndo, handleModelingRedo,
                      handleDelete, deleteDisabled, handleSmooth, smoothDisabled,
                      handleMerge, mergeDisabled, handleSubdivide, subdivideDisabled,
                      handleBridge, bridgeDisabled, handleFillHole, fillDisabled
                    }} />
                  ) : activeMenu === 'boolean' ? (
                    <BooleanToolsPanel {...{
                      booleanBrushSource, setBooleanBrushSource, booleanBrushAsset, setBooleanBrushAsset,
                      booleanBrushFile, setBooleanBrushFile, setShowBooleanBrushSelector,
                      booleanBrushFileInputRef, hasBooleanBrushMask: !!booleanBrushMaskRef.current,
                      booleanOperation, setBooleanOperation, booleanPlaceMode, setBooleanPlaceMode,
                      booleanStampBasis, setBooleanStampBasis, booleanStampSize, setBooleanStampSize,
                      booleanStampDepth, setBooleanStampDepth, booleanTessellation, setBooleanTessellation,
                      booleanStampRotation, setBooleanStampRotation, booleanStampOffset, setBooleanStampOffset,
                      booleanStampNudgeX, setBooleanStampNudgeX, booleanStampNudgeY, setBooleanStampNudgeY,
                      booleanStampLocalGeometry, booleanStampMatrix,
                      handleApplyBoolean, handleClearBooleanStamp, stats
                    }} />
                  ) : activeMenu === 'texturing' ? (
                    <TexturingToolsPanel {...{
                      brushSize, setBrushSize, cropPadding, setCropPadding,
                      featherRadius, setFeatherRadius, multiViewCount, setMultiViewCount,
                      texturingUnavailableReason, pendingPatch, texturing, handleClearTextureMask,
                      textureWorkflowId, setTextureWorkflowId, comfyLoading, texturingWorkflows,
                      selectedTextureWorkflow, imageParamSources, handleImageParamSourceChange,
                      setPendingAssetParamId, setPendingAssetSelectorMode, setShowAssetSelector,
                      textureWorkflowParameters, textureWorkflowInputs, handleTextureWorkflowInputChange,
                      projectionOpacities, setProjectionOpacities, patchNoise, setPatchNoise,
                      patchSharpness, setPatchSharpness, patchSaturation, setPatchSaturation,
                      handleApplyPatch, handleCancelPatch, handleRunTextureWorkflow, texturingReady,
                      textureSetAsDefault, setTextureSetAsDefault,
                      canCancelComfyRun: Boolean(texturing && comfyRunPromptId),
                      comfyRunCancelling, handleCancelComfyRun
                    }} />
                  ) : activeMenu === 'projection' ? (
                    <ProjectionToolsPanel {...{
                      projectionTextureSize, setProjectionTextureSize, projectionStarted, projecting,
                      projectionKeepTexture, projectionViewResolution, setProjectionViewResolution,
                      projectionBlendPixels, setProjectionBlendPixels, texturingUnavailableReason,
                      projectionRebuilding, handleStartProjectionSession, handleRunProjectionWorkflow,
                      projectionReady, comfyLoading, projectionWorkflowId, setProjectionWorkflowId,
                      projectionWorkflows, selectedProjectionWorkflow, projectionImageParamSources,
                      handleProjectionImageParamSourceChange, setPendingAssetParamId,
                      setPendingAssetSelectorMode, setShowAssetSelector, projectionWorkflowParameters,
                      projectionWorkflowInputs, setProjectionWorkflowInputs,
                      projectionSetAsDefault, setProjectionSetAsDefault,
                      canCancelComfyRun: Boolean(projecting && comfyRunPromptId),
                      comfyRunCancelling, handleCancelComfyRun
                    }} />
                  ) : activeMenu === 'autouv' ? (
                    <AutoUvToolsPanel {...{
                      options: autoUvOptions, setOption: setAutoUvOption,
                      running: autoUvRunning, result: autoUvResult, progress: autoUvProgress,
                      onRun: handleRunAutoUv,
                      onKeepResult: () => setAutoUvResult(null),
                      onRevertResult: () => handleRevertMeshTool(setAutoUvResult),
                      disabled: !geometry
                    }} />
                  ) : activeMenu === 'autoretopo' ? (
                    <AutoRetopoToolsPanel {...{
                      options: autoRetopoOptions, setOption: setAutoRetopoOption,
                      running: autoRetopoRunning, result: autoRetopoResult, progress: autoRetopoProgress,
                      watertight: watertightResult,
                      watertightChecking,
                      onCheckWatertight: handleCheckWatertight,
                      onCleanNonManifold: handleCleanNonManifold,
                      repairOptions, setRepairOption,
                      repairRunning, repairResult, repairProgress,
                      onKeepRepairResult: () => setRepairResult(null),
                      onRevertRepairResult: () => handleRevertMeshTool(setRepairResult),
                      onRun: handleRunAutoRetopo,
                      onKeepResult: () => setAutoRetopoResult(null),
                      onRevertResult: () => handleRevertMeshTool(setAutoRetopoResult),
                      disabled: !geometry
                    }} />
                  ) : activeMenu === 'autorig' ? (
                    <AutoRigToolsPanel {...{
                      options: autoRigOptions, setOption: setAutoRigOption,
                      running: autoRigRunning, progress: autoRigProgress, result: autoRigResult,
                      onRun: handleRunAutoRig,
                      onSaveResult: handleSaveRiggedResult,
                      onDownloadResult: handleDownloadRiggedResult,
                      onDismissResult: handleDismissRigResult,
                      saving: autoRigSaving,
                      hasSkeleton: !!skeleton,
                      showSkeleton,
                      onToggleSkeleton: setShowSkeleton,
                      showBoneNames,
                      onToggleBoneNames: setShowBoneNames,
                      rigPreserved: !!rigRef.current && geometryHasSkin(geometry),
                      rigBoneCount: rigRef.current?.boneCount || 0,
                      rigDropped,
                      rigEdited: rigEditDirty,
                      boneMappings: boneMappingSummary,
                      weightPaint: weightPaintProps,
                      disabled: !geometry
                    }} />
                  ) : activeMenu === 'optimize' ? (
                    <OptimizeToolsPanel {...{
                      options: optimizeOptions, setOption: setOptimizeOption,
                      currentFaces: stats.faces,
                      running: optimizeRunning, result: optimizeResult, progress: optimizeProgress,
                      onRun: handleRunOptimize,
                      onKeepResult: () => setOptimizeResult(null),
                      onRevertResult: () => handleRevertMeshTool(setOptimizeResult),
                      lodLevels, onLodLevelsChange: setLodLevels, lodRatios,
                      lodChain, lodSourceFaces, lodGenerating, lodProgress,
                      onGenerateLods: handleGenerateLods,
                      onApplyLod: handleApplyLod,
                      disabled: !geometry
                    }} />
                  ) : activeMenu === 'bake' ? (
                    <BakeToolsPanel {...{
                      options: bakeOptions, setOption: setBakeOption,
                      sources: bakeSources, sourceId: bakeSourceId, onSourceChange: setBakeSourceId,
                      onPickAsset: () => setShowBakeSourceSelector(true),
                      loadingSource: bakeSourceLoading,
                      running: bakeRunning, progress: bakeProgress, result: bakedMaps,
                      onRun: handleRunBake,
                      onApply: handleApplyBakedMaps,
                      hasUvs: !!geometry?.attributes?.uv?.count,
                      disabled: !geometry
                    }} />
                  ) : activeMenu === 'segmentation' ? (
                    <SegmentationToolsPanel {...{
                      options: segmentOptions, setOption: setSegmentOption,
                      running: segmentRunning, progress: segmentProgress,
                      analysis: segmentation,
                      parts: segmentParts, onPartsChange: setSegmentParts,
                      partCount: segmentLabels?.visibleCount || 0,
                      partSizes: segmentPartSizes,
                      minPartFaces: segmentMinPartFaces,
                      onMinPartFacesChange: setSegmentMinPartFaces,
                      onRun: handleRunSegment,
                      onAuto: handleAutoSegmentParts,
                      onExport: handleExportSegmentParts,
                      exporting: segmentExporting,
                      onClear: handleClearSegmentation,
                      tool: segmentTool,
                      onToolChange: handleSegmentToolChange,
                      targetFace: segmentTargetFace,
                      targetLabel: segmentTargetFace >= 0 ? segmentLabels?.labels?.[segmentTargetFace] : -1,
                      palette: segmentPalette,
                      brushSize: segmentBrushSize,
                      brushSizeRange: segmentBrushSizeRange,
                      onBrushSizeChange: setSegmentBrushSize,
                      paintedFaces: segmentPaintedFaces,
                      canUndo: segmentCanUndo,
                      onUndo: handleSegmentUndo,
                      onClearPaint: handleSegmentClearPaint,
                      mergePicks: segmentMergePicks.length,
                      onApplyMerge: handleSegmentApplyMerge,
                      onResetMerges: handleSegmentResetMerges,
                      mergeCount: segmentOverrides?.mergePairs?.length || 0,
                      focused: !!segmentOverrides?.focusMask,
                      pendingSplits: segmentPendingSplits,
                      appliedSplits: segmentOverrides?.skipMerges?.size || 0,
                      pinnedLevel: segmentOverrides?.anchorK || 0,
                      explode: segmentExplode,
                      onExplodeChange: setSegmentExplode,
                      onApplyFocus: handleSegmentApplyFocus,
                      onClearFocus: handleSegmentClearFocus,
                      onResetSplits: handleSegmentResetSplits,
                      disabled: !geometry
                    }} />
                  ) : activeMenu === 'gameready' ? (
                    <GameReadyPanel {...{
                      options: gameReadyOptions, setOption: setGameReadyOption,
                      running: gameReadyRunning, report: gameReadyReport,
                      onRun: handleRunGameReady,
                      onFix: handleGameReadyFix,
                      disabled: !geometry
                    }} />
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
                    <PaintingToolsPanel {...{
                      paintMode, setPaintMode, selectedLayerId,
                      paintBrushSource, setPaintBrushSource, paintBrushAsset, setShowBrushSelector,
                      paintBrushFileInputRef, paintBrushFile, handlePaintBrushFileChange,
                      paintBrushSize, setPaintBrushSize, paintOpacity, setPaintOpacity,
                      paintFlow, setPaintFlow, paintHardness, setPaintHardness,
                      paintRotation, setPaintRotation, paintBlendMode, setPaintBlendMode,
                      PAINT_BLEND_MODES, paintColor, setPaintColor, paintLayers, handleClearAllLayers
                    }} />
                  )}
                </div>
              </div>
            </aside>

            {/* Viewport column: the 3D canvas plus whatever docks under it. The
                canvas shell has a fixed, viewport-derived height, so anything sharing
                this column has to take its height OUT of the canvas — see
                `--mesh-editor-anim-dock-height`. */}
            <div className="mesh-editor-viewport">
              <div
                ref={canvasShellRef}
                className={`mesh-editor-canvas-shell ${(activeMenu === 'texturing' || activeMenu === 'painting' || activeMenu === 'projection') ? 'mesh-editor-canvas-shell--texturing' : ''} ${animEditDocked ? 'mesh-editor-canvas-shell--docked' : ''}`}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerCancel}
                onPointerLeave={() => { setPaintCursorPos(null); setSculptCursor(null); setWeightCursor(null); setSegmentCursor(null); if (projectionMaskCursorRef.current) projectionMaskCursorRef.current.style.display = 'none'; }}
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
                      <ViewportCameras orthographic={orthographic} />
                      <ambientLight intensity={viewportDisplayMode === 'sculpt' ? 0.42 : (viewportDisplayMode === 'weights' || viewportDisplayMode === 'segments') ? 0.55 : 1.25} />
                      <directionalLight
                        position={viewportDisplayMode === 'sculpt' ? [5, 7, 4] : [5, 7, 9]}
                        intensity={viewportDisplayMode === 'sculpt' ? 2.2 : (viewportDisplayMode === 'weights' || viewportDisplayMode === 'segments') ? 1.1 : 2}
                        castShadow={showShadows}
                        shadow-mapSize-width={2048}
                        shadow-mapSize-height={2048}
                        shadow-bias={-0.00015}
                        shadow-normalBias={0.04}
                        shadow-camera-near={0.5}
                        shadow-camera-far={120}
                      />
                      <directionalLight
                        position={displayMode === 'sculpt' ? [-4, 2, -5] : [-5, 3, -4]}
                        intensity={displayMode === 'sculpt' ? 0.7 : 0.6}
                        color={displayMode === 'sculpt' ? '#ffffff' : '#8ff5ff'}
                      />
                      {activeMenu === 'autorig' && animPreview ? (
                        <AnimatedMeshPreview
                          object={animPreview.scene}
                          mixerRoot={animPreview.skinnedMesh}
                          clip={animPreview.clip}
                          // The dock owns the clock while it is open: paused and held at
                          // one frame unless the user asks for playback.
                          playing={!animEditOpen || animPlaying}
                          time={animEditOpen && !animPlaying ? frameTime(animEditDescription, animEditFrame) : null}
                          onPausedAt={handleAnimPausedAt}
                          alignFloor={animAlignFloor}
                          floorOffset={animPreview.floorOffset}
                          armExtension={animArmExtension}
                          armTargets={animArmTargets}
                        />
                      ) : (activeMenu === 'texturing' || activeMenu === 'painting' || activeMenu === 'projection' || activeMenu === 'optimize' || activeMenu === 'bake') && texturableMesh?.root && displayTextureRef.current && (activeMenu !== 'texturing' || maskTextureRef.current) ? (
                        <TexturedMesh
                          key={textureRevision}
                          root={texturableMesh.root}
                          textureKey={texturableMesh.textureKey}
                          displayTexture={displayTextureRef.current}
                          showShadows={showShadows}
                          displayMode={displayMode}
                          showWireframe={showWireframe}
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
                          geometry={segmentDisplayGeometry || weightPaintGeometry || geometry}
                          selectedFaceIndices={activeMenu === 'modeling' ? selectedFaceIndices : []}
                          selectedVertexIndices={activeMenu === 'modeling' ? selectedVertexIndices : []}
                          showShadows={showShadows}
                          displayMode={viewportDisplayMode}
                          showWireframe={showWireframe}
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
                      <SkeletonOverlay
                        skeleton={skeleton}
                        visible={skeletonVisible && !animPreview}
                        selectedBone={selectedBone}
                        showNames={showBoneNames}
                      />
                      {/* The animated counterpart. A SIBLING of AnimatedMeshPreview, never
                          a child: the preview wraps its scene in the floor-offset group,
                          and this reads world positions that already include it. */}
                      {/* Move/rotate the selected bone straight in the scene. Only while
                          the dock is open and paused: the drag edits ONE frame, and the
                          frame is only meaningful when the clock is stopped. */}
                      {animGizmoBone && (
                        <AnimationBoneGizmo
                          bone={animGizmoBone}
                          mode={animEditGizmoMode}
                          onDragStart={handleGizmoDragStart}
                          onDrag={handleGizmoDrag}
                          onDragEnd={handleGizmoDragEnd}
                        />
                      )}
                      {animPreview?.skinnedMesh && (
                        <AnimatedSkeletonOverlay
                          root={animPreview.scene}
                          skinnedMesh={animPreview.skinnedMesh}
                          visible={skeletonVisible}
                          showNames={showBoneNames}
                          // `selectedBone` first: it is what the last click set, dock
                          // included, so clicking a bone the clip does not animate (a
                          // finger) highlights THAT bone instead of leaving the marker
                          // on whatever the dock still lists.
                          selectedName={selectedBone != null ? skeleton?.names?.[selectedBone] : animEditBone}
                          onJoints={handleLiveJoints}
                        />
                      )}
                      {rigEditing && rigEditable && skeletonVisible && !animPreview && (
                        <BoneTransformGizmo
                          skeleton={skeleton}
                          boneIndex={selectedBone}
                          onDragStart={handleRigGizmoDragStart}
                          onDrag={handleRigGizmoDrag}
                          onDragEnd={handleRigGizmoDragEnd}
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
                        controlsEnabled={orbitEnabled}
                        allowPan={activeMenu !== 'projection' || !!projectionMaskEditLayerId}
                        lockToCenter={activeMenu === 'projection' && !projectionMaskEditLayerId}
                      />
                      {orbitEnabled && <ViewGizmo geometry={geometry} />}
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
                {activeMenu === 'segmentation' && segmentTool === 'brush' && segmentCursor && (
                  <div
                    className="mesh-editor-paint-cursor mesh-editor-weight-cursor"
                    style={{
                      left: segmentCursor.x,
                      top: segmentCursor.y,
                      width: segmentCursor.pixelRadius * 2,
                      height: segmentCursor.pixelRadius * 2
                    }}
                  />
                )}
                {activeMenu === 'autorig' && weightPainting && weightCursor && (
                  <div
                    className="mesh-editor-paint-cursor mesh-editor-weight-cursor"
                    style={{
                      left: weightCursor.x,
                      top: weightCursor.y,
                      width: weightCursor.pixelRadius * 2,
                      height: weightCursor.pixelRadius * 2
                    }}
                  />
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
                {activeMenu === 'projection' && projectionMaskEditLayerId && (
                  <div
                    ref={projectionMaskCursorRef}
                    className="mesh-editor-paint-cursor"
                    style={{
                      left: 0,
                      top: 0,
                      width: projectionMaskBrushSize,
                      height: projectionMaskBrushSize,
                      display: 'none'
                    }}
                  />
                )}
                {/* Animated veil shown while a released mask stroke (or a Clear/Fill) is
                    being applied. Drawing/clearing is blocked until it disappears. */}
                {activeMenu === 'projection' && maskApplying && (
                  <div className="mesh-editor-mask-applying">
                    <div className="mesh-editor-mask-applying__badge">
                      <span className="material-symbols-outlined">brush</span>
                      <span>Applying mask…</span>
                    </div>
                  </div>
                )}
                {/* Source image ComfyUI returned for the layer being masked — shown in
                    the bottom-left so the user can reference it while drawing the mask. */}
                {(() => {
                  if (activeMenu !== 'projection' || !projectionMaskEditLayerId) {
                    return null
                  }
                  const layerData = projectionLayerDataRef.current.get(projectionMaskEditLayerId)
                  const sourceUrl = layerData?.generatedAsset ? buildAssetUrl(layerData.generatedAsset) : null
                  if (!sourceUrl) {
                    return null
                  }
                  return (
                    <div className="mesh-editor-projection-source-preview">
                      <span className="mesh-editor-projection-source-preview__label">ComfyUI image</span>
                      <img src={sourceUrl} alt="ComfyUI projection source" />
                    </div>
                  )
                })()}
              </div>

              {/* Under the 3D view, inside the CANVAS column — not a sibling of the
                  workspace grid. The grid is already as tall as the page (the canvas
                  shell is clamped to ~100vh), so anything after it lands below the
                  fold of a page that does not scroll. Here the canvas gives up the
                  height instead, via `--mesh-editor-anim-dock-height`. */}
              {animEditDocked && (
                <AnimationEditPanel
                  clipName={selectedAnimation}
                  description={animEditDescription}
                  clip={animPreview.clip}
                  revision={animEditRevision}
                  frame={animEditFrame}
                  onFrameChange={setAnimEditFrame}
                  playing={animPlaying}
                  onTogglePlay={() => setAnimPlaying(p => !p)}
                  selectedBone={animEditBone}
                  onSelectBone={handleAnimEditSelectBone}
                  scope={animEditScope}
                  onScopeChange={setAnimEditScope}
                  span={animEditSpan}
                  onSpanChange={setAnimEditSpan}
                  onEdit={handleAnimEditValue}
                  onClearValue={handleAnimClearFrameValue}
                  onClearBone={handleAnimClearBone}
                  onDeleteRange={handleAnimDeleteRange}
                  onShiftRange={handleAnimShiftRange}
                  allBones={animAllBones}
                  onAddBone={handleAnimAddBone}
                  onFrameOperation={handleAnimFrameOperation}
                  onSmoothLoop={handleAnimSmoothLoop}
                  seamFrames={animSeamFrames}
                  onSeamFramesChange={setAnimSeamFrames}
                  gizmoMode={animEditGizmoMode}
                  onAddPositionTrack={handleAnimAddPositionTrack}
                  canAddPositionTrack={!!animGizmoBone}
                  onGizmoModeChange={setAnimEditGizmoMode}
                  onCopyPose={handleAnimCopyPose}
                  onPastePose={handleAnimPastePose}
                  copiedPose={animPoseLabel}
                  edited={animEditedClips.has(selectedAnimation)}
                  onRevert={handleAnimRevertEdits}
                  canUndo={animEditUndoCount > 0}
                  canRedo={animEditRedoCount > 0}
                  onUndo={() => stepAnimEditHistory('undo')}
                  onRedo={() => stepAnimEditHistory('redo')}
                  onSaveCustom={handleSaveEditedAnimation}
                  savingCustom={customSavingClip}
                  onClose={handleToggleAnimEdit}
                />
              )}
            </div>

            {activeMenu === 'autorig' && skeleton && (
              <SkeletonPanel
                skeleton={skeleton}
                selectedBone={selectedBone}
                onSelectBone={setSelectedBone}
                animation={animationPanelProps}
                kimodo={kimodoPanelProps}
                mocap={mocapPanelProps}
                custom={customPanelProps}
                edit={{
                  available: rigEditable,
                  active: rigEditing && rigEditable,
                  onToggle: handleToggleRigEdit,
                  influence: rigInfluence,
                  unusedCount: rigUnusedBones.length,
                  onRemoveUnused: handleRigRemoveUnused,
                  onRename: handleRigBoneRename,
                  onDelete: handleRigBoneDelete,
                  onMove: handleRigBonePosition,
                  onAddChild: handleRigAddChild,
                  onTakeWeights: handleRigTakeWeights,
                  moveChildren: rigMoveChildren,
                  onToggleMoveChildren: () => setRigMoveChildren(prev => !prev),
                  canUndo: rigCanUndo,
                  canRedo: rigCanRedo,
                  onUndo: handleRigUndo,
                  onRedo: handleRigRedo,
                  onRevert: handleRigRevert,
                  dirty: rigEditDirty,
                }}
              />
            )}

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

                          {/* Per-layer mask: apply this view only where painted on the mesh. */}
                          <div className="mesh-editor-layer-card__btn-row">
                            <button
                              type="button"
                              className={`mesh-editor-btn ${projectionMaskEditLayerId === layer.id ? 'mesh-editor-btn--primary' : 'mesh-editor-btn--ghost'}`}
                              onClick={() => handleToggleProjectionMaskDraw(layer.id)}
                              disabled={projectionRebuilding || maskApplying}
                              title="Paint a mask on the mesh; the view is applied only where you draw"
                            >
                              <span className="material-symbols-outlined">brush</span>
                              <span>{projectionMaskEditLayerId === layer.id ? 'Drawing…' : 'Draw Mask'}</span>
                            </button>
                            <button
                              type="button"
                              className="mesh-editor-btn mesh-editor-btn--ghost"
                              onClick={() => handleClearProjectionLayerMask(layer.id)}
                              disabled={projectionRebuilding || maskApplying || !layer.hasMask}
                              title="Remove the mask so the whole view is applied again"
                            >
                              <span className="material-symbols-outlined">layers_clear</span>
                              <span>Clear Mask</span>
                            </button>
                          </div>

                          {projectionMaskEditLayerId === layer.id && (
                            <>
                              <div className="mesh-editor-layer-card__row">
                                <span>Draw size</span>
                                <input
                                  type="range" min="4" max="256" step="1"
                                  value={projectionMaskBrushSize}
                                  onChange={e => setProjectionMaskBrushSize(Number(e.target.value))}
                                />
                                <strong>{projectionMaskBrushSize}px</strong>
                              </div>
                              <div className="mesh-editor-layer-card__btn-row">
                                <button
                                  type="button"
                                  className={`mesh-editor-btn ${projectionMaskErase ? 'mesh-editor-btn--primary' : 'mesh-editor-btn--ghost'}`}
                                  onClick={() => setProjectionMaskErase(value => !value)}
                                  disabled={maskApplying}
                                  title="Toggle erase: subtract from the mask to keep the view everywhere except the erased parts"
                                >
                                  <span className="material-symbols-outlined">{projectionMaskErase ? 'ink_eraser' : 'edit'}</span>
                                  <span>{projectionMaskErase ? 'Erasing' : 'Erase'}</span>
                                </button>
                                <button
                                  type="button"
                                  className="mesh-editor-btn mesh-editor-btn--ghost"
                                  onClick={() => handleFillProjectionLayerMask(layer.id)}
                                  disabled={projectionRebuilding || maskApplying}
                                  title="Fill the mask over the whole mesh, then erase only the parts you want to remove"
                                >
                                  <span className="material-symbols-outlined">format_color_fill</span>
                                  <span>Fill Mesh</span>
                                </button>
                                <button
                                  type="button"
                                  className="mesh-editor-btn mesh-editor-btn--secondary"
                                  onClick={handleExitProjectionMaskDraw}
                                >
                                  <span className="material-symbols-outlined">close</span>
                                  <span>Exit</span>
                                </button>
                              </div>
                              <div className="mesh-editor-layer-card__dirty-note">
                                Left-drag on the mesh to {projectionMaskErase ? 'erase' : 'draw'} the mask. Middle-drag orbits, right-drag pans, scroll to zoom — move in close to reach tricky spots (this never changes the projected views).
                              </div>
                            </>
                          )}

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
                        <p className="post-proc-panel__hint">
                          Blends the colour step where two views meet on the 3D surface
                          (silhouette seams). Works in world space, so it never smears
                          across UV-atlas seams.
                        </p>
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
      {showBoneMapping && animSourceRef.current && animTargetRef.current && (
        <BoneMappingModal
          referenceLabel={animReferenceId === KIMODO_SOURCE_ID
            ? 'Kimodo'
            : animReferenceId === CUSTOM_SOURCE_ID
              ? 'Custom animation'
              : (getReference(animReferenceId)?.label || 'Reference')}
          sourceBones={animSourceRef.current.boneNames}
          targetBones={animTargetRef.current.boneNames}
          sourceSkeleton={boneMapSkeletons?.source}
          targetSkeleton={boneMapSkeletons?.target}
          initialMapping={animMapping}
          onAutoMap={handleAutoMapBones}
          onSave={handleSaveBoneMapping}
          onClose={() => setShowBoneMapping(false)}
        />
      )}
      {customLibOpen && (
        <AnimationLibraryModal
          animations={customAnimations}
          loading={customLibLoading}
          error={customLibError}
          busy={customApplying || customImporting}
          busyId={customBusyId}
          importing={customImporting}
          importProgress={customImportProgress}
          parsed={customParsed}
          onParseFiles={handleParseAnimationFiles}
          onImport={handleImportParsedClips}
          onCancelImport={handleCancelImport}
          onApply={handleApplyCustomAnimations}
          onRename={handleRenameCustomAnimation}
          onDelete={handleDeleteCustomAnimations}
          onClose={() => setCustomLibOpen(false)}
        />
      )}

      {motionLibOpen && (
        <MotionLibraryModal
          motions={motionLibrary}
          loading={motionLibLoading}
          error={motionLibError}
          busy={motionLibBusy}
          busyId={motionLibBusyId}
          progress={motionLibProgress}
          // Without a bone mapping a clip cannot be retargeted, so applying one
          // would silently do nothing. Say why instead of failing quietly.
          applyDisabled={!animMapping}
          applyDisabledReason="Map Kimodo’s bones to your mesh first, then apply a motion."
          onApply={handleApplySavedMotions}
          onDelete={handleDeleteSavedMotions}
          onClose={() => setMotionLibOpen(false)}
        />
      )}
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
      {showBakeSourceSelector && (
        <AssetSelectorModal
          assetType="mesh"
          onSelect={(asset) => {
            setShowBakeSourceSelector(false)
            handleBakeSourceAsset(asset)
          }}
          onClose={() => setShowBakeSourceSelector(false)}
          showEdits
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
      {showExport && (
        <ExportMeshDialog
          getObject3D={getExportObject}
          defaultName={meshName || 'mesh'}
          onClose={() => setShowExport(false)}
        />
      )}
      <Footer />
    </div>
  )
}
