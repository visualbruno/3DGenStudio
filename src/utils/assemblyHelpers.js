// The Mesh Assembly document model: pure functions over plain JSON, no React
// and no three.js. The server stores this blob verbatim (see the MeshAssemblies
// table), so this file is the only definition of its shape — the same division
// of labour src/utils/batchHelpers.js has with BatchConfigs.
//
// Two invariants worth knowing before changing anything here:
//
//  1. Placement is stored as TRS (position / rotation-as-Euler / scale), never
//     as a matrix. The numeric panel, the mirror tools and gizmo snapping all
//     operate on TRS, and a matrix decomposed and recomposed each render loses
//     the exact Euler the user typed — a rotation has several equivalent Euler
//     representations, and `Matrix4.decompose` does not promise to return the
//     one that went in. The matrix is DERIVED, by composePieceMatrix.
//
//  2. Fitted geometry is NEVER in this document. A fit result is megabytes and
//     stateJson is a TEXT column; the document carries only `fit` status/stats
//     and, once explicitly saved, `fittedVersionAssetId`. Same rule as
//     BatchConfigs ("Results are not stored here").

export const ASSEMBLY_DOC_VERSION = 1

// Rotation lives in the document in RADIANS (three.js's unit, so composing a
// matrix needs no conversion); the UI converts for display. Keeping the
// conversion at the edge means a round trip through the panel is lossless.
export const DEG = Math.PI / 180

let pieceCounter = 0

// Document-local id. Deliberately not the asset id: the same mesh can appear
// twice in one assembly (a left and a right boot from one asset), so a piece
// needs an identity of its own.
function nextPieceId() {
  pieceCounter += 1
  return `p-${Date.now().toString(36)}-${pieceCounter.toString(36)}`
}

// ---------------------------------------------------------------------------
// Material classes
// ---------------------------------------------------------------------------
// A material class is a PRESET that writes fitStages + fitOptions, not a
// separate mode the fit has to branch on. Touching any individual knob flips
// the piece to 'custom', so the document is always the single source of truth
// and the panel never holds hidden state.
//
// Both classes currently run the PENETRATION push only, differing in how much
// clearance they leave. That is not the original design — conforming was meant
// to reshape soft pieces — and the reason is measured, not theoretical:
//
// On a real 6.5k-vertex armour, conforming loses 75% of the piece's thickness
// (distance-spread 0.084 -> 0.020), flattens one axis (0.335 -> 0.207), inverts
// 7.6% of its faces, and leaves MORE clipping than it started with (162 -> 1227
// penetrating vertices). A garment is a shell with two surfaces, and every
// cheap way of moving one without the other has failed so far: per-vertex
// projection collapses it, graph smoothing stretches it, and a spline field
// (which fixes the synthetic case) still squashes a piece much wider than the
// body it wraps.
//
// So conform stays available as an explicit, warned opt-in rather than a
// default that quietly ruins the piece. See python-server/app/services/
// assemblyfit/conform.py and check_thickness_is_preserved in verify.py.
export const MATERIAL_CLASSES = ['rigid', 'soft', 'custom']

export const MATERIAL_CLASS_LABELS = {
  rigid: 'Rigid / Plate',
  soft: 'Soft / Cloth',
  custom: 'Custom',
}

export const MATERIAL_CLASS_PRESETS = {
  rigid: {
    stages: { shrinkwrap: false, penetration: true },
    options: { offset: 0.006, smooth_rounds: 1, step_clamp: 0.35 },
  },
  soft: {
    stages: { shrinkwrap: false, penetration: true },
    options: { offset: 0.002, smooth_rounds: 3, step_clamp: 0.6 },
  },
}

export function presetForMaterialClass(materialClass) {
  return MATERIAL_CLASS_PRESETS[materialClass] || MATERIAL_CLASS_PRESETS.soft
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createEmptyAssembly() {
  return {
    version: ASSEMBLY_DOC_VERSION,
    basePieceId: null,
    pieces: [],
    settings: {
      gizmoMode: 'translate',
      gizmoSpace: 'world',
      snapEnabled: false,
      snapTranslate: 0,
      snapRotateDeg: 0,
      snapScale: 0,
      showGrid: true,
      orthographic: false,
      // Manual Elastic Grab, for tidying what the fit leaves behind.
      sculptMode: false,
      sculptRadius: 80,      // screen pixels, like Blender's brush size
      sculptStrength: 1,
      isolatedPieceId: null,
      selectedPieceId: null,
      showFittedGlobal: true,
    },
    merged: { assetId: null, name: '', savedAt: null },
    lastSavedAt: null,
  }
}

// `asset` is a row from the library listing (see AssetSelectorModal): it
// carries assetId/name/filePath/url/thumbnailUrl. Everything but assetId is a
// display cache, reconciled on load — assetId is the canonical reference.
export function createPiece(asset, { role = 'piece' } = {}) {
  const preset = presetForMaterialClass('soft')
  return {
    id: nextPieceId(),
    role,

    assetId: asset?.assetId ?? asset?.id ?? null,
    name: asset?.name || 'Mesh',
    filePath: asset?.filePath || asset?.filename || '',
    url: asset?.url || '',
    thumbnail: asset?.thumbnailUrl || asset?.thumbnailPath || '',

    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    mirrorX: false,

    visible: true,
    opacity: 1,
    locked: false,
    wireframe: false,
    xray: false,

    materialClass: 'soft',
    fitStages: { ...preset.stages },
    fitOptions: { ...preset.options },
    fitRegion: 'whole',
    landmarks: [],
    transferWeights: false,

    fit: { status: 'idle', message: '', stats: {}, fittedAt: null },
    fittedVersionAssetId: null,
  }
}

export function createLandmarkPair() {
  pieceCounter += 1
  return { id: `lm-${Date.now().toString(36)}-${pieceCounter.toString(36)}`, base: null, piece: null }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const vec3 = (value, fallback) => {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback]
  return value.map((n, i) => (Number.isFinite(Number(n)) ? Number(n) : fallback[i]))
}

// A scale of 0 on any axis makes the piece's matrix singular: it collapses to a
// plane, cannot be inverted (so picking and the fit's space conversions break),
// and cannot be recovered by dragging the gizmo back. Clamp the magnitude while
// keeping the sign, which a mirrored piece needs.
const SCALE_EPSILON = 1e-6
const safeScale = value => vec3(value, [1, 1, 1]).map(n => {
  if (Math.abs(n) >= SCALE_EPSILON) return n
  return n < 0 ? -SCALE_EPSILON : SCALE_EPSILON
})

const clamp01 = n => Math.min(1, Math.max(0, Number.isFinite(Number(n)) ? Number(n) : 1))

function normalizeLandmark(point) {
  if (!point) return null
  const index = Number(point.vertexIndex)
  return {
    point: vec3(point.point, [0, 0, 0]),
    vertexIndex: Number.isInteger(index) && index >= 0 ? index : null,
  }
}

function normalizePiece(raw) {
  const materialClass = MATERIAL_CLASSES.includes(raw?.materialClass) ? raw.materialClass : 'soft'
  const preset = presetForMaterialClass(materialClass)
  const assetId = Number(raw?.assetId)

  return {
    id: String(raw?.id || nextPieceId()),
    role: raw?.role === 'base' ? 'base' : 'piece',

    // null means "the asset this piece pointed at is gone" — the row renders as
    // missing rather than silently showing some other mesh. More likely here
    // than elsewhere in the app: an assembly outlives the projects its pieces
    // came from, and nothing cascades a project delete into this document.
    assetId: Number.isInteger(assetId) && assetId > 0 ? assetId : null,
    name: String(raw?.name || 'Mesh'),
    filePath: String(raw?.filePath || ''),
    url: String(raw?.url || ''),
    thumbnail: String(raw?.thumbnail || ''),

    position: vec3(raw?.position, [0, 0, 0]),
    rotation: vec3(raw?.rotation, [0, 0, 0]),
    scale: safeScale(raw?.scale),
    mirrorX: !!raw?.mirrorX,

    visible: raw?.visible !== false,
    opacity: clamp01(raw?.opacity ?? 1),
    locked: !!raw?.locked,
    wireframe: !!raw?.wireframe,
    xray: !!raw?.xray,

    materialClass,
    fitStages: { ...preset.stages, ...(raw?.fitStages || {}) },
    fitOptions: { ...preset.options, ...(raw?.fitOptions || {}) },
    fitRegion: String(raw?.fitRegion || 'whole'),
    landmarks: (Array.isArray(raw?.landmarks) ? raw.landmarks : []).map(pair => ({
      id: String(pair?.id || createLandmarkPair().id),
      base: normalizeLandmark(pair?.base),
      piece: normalizeLandmark(pair?.piece),
    })),
    transferWeights: !!raw?.transferWeights,

    // Fit STATUS is never restored as 'running': a fit lives entirely inside
    // one HTTP request, so a document reloaded mid-fit has no run to attach to
    // and a spinner would hang forever. 'ready' is dropped too — the preview
    // geometry it referred to was never persisted.
    fit: { status: 'idle', message: '', stats: {}, fittedAt: Number(raw?.fit?.fittedAt) || null },
    fittedVersionAssetId: Number(raw?.fittedVersionAssetId) || null,
  }
}

// Accepts anything (null, a legacy shape, a hand-edited blob) and returns a
// document every consumer can rely on. Called on every load, so a field added
// here is retroactively present on old documents without a migration step.
export function normalizeAssembly(raw) {
  const empty = createEmptyAssembly()
  if (!raw || typeof raw !== 'object') return empty

  const pieces = (Array.isArray(raw.pieces) ? raw.pieces : []).map(normalizePiece)

  // Exactly one base, always. Trust basePieceId when it still resolves,
  // otherwise fall back to the first piece flagged 'base', otherwise the first
  // piece — an assembly with pieces but no base has no target to fit against,
  // which every downstream consumer would have to special-case.
  let baseId = pieces.some(p => p.id === raw.basePieceId) ? raw.basePieceId : null
  if (!baseId) baseId = pieces.find(p => p.role === 'base')?.id || pieces[0]?.id || null

  for (const piece of pieces) piece.role = piece.id === baseId ? 'base' : 'piece'

  const settings = { ...empty.settings, ...(raw.settings || {}) }
  // Drop selection/isolation pointing at pieces that no longer exist.
  if (!pieces.some(p => p.id === settings.selectedPieceId)) settings.selectedPieceId = null
  if (!pieces.some(p => p.id === settings.isolatedPieceId)) settings.isolatedPieceId = null

  return {
    version: ASSEMBLY_DOC_VERSION,
    basePieceId: baseId,
    pieces,
    settings,
    merged: { ...empty.merged, ...(raw.merged || {}) },
    lastSavedAt: Number(raw.lastSavedAt) || null,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getBasePiece = doc => doc?.pieces?.find(p => p.id === doc.basePieceId) || null
export const getGarmentPieces = doc => (doc?.pieces || []).filter(p => p.id !== doc.basePieceId)
export const getPiece = (doc, pieceId) => doc?.pieces?.find(p => p.id === pieceId) || null

// Which pieces the viewport should draw, honouring isolate. Isolate always
// keeps the BASE visible alongside the isolated piece: the point of isolating a
// gauntlet is to see how it sits against the body, and hiding the body would
// defeat it.
export function getVisiblePieces(doc) {
  const isolated = doc?.settings?.isolatedPieceId
  return (doc?.pieces || []).filter(piece => {
    if (!piece.visible) return false
    if (!isolated) return true
    return piece.id === isolated || piece.id === doc.basePieceId
  })
}

export const isAssemblyFittable = doc => !!getBasePiece(doc) && getGarmentPieces(doc).length > 0

// A landmark pair only counts once BOTH sides are placed; a half-finished pair
// is shown in the list but must never reach the warp.
export const completeLandmarks = piece =>
  (piece?.landmarks || []).filter(pair => pair.base && pair.piece)

// Thin-plate-spline needs at least 4 non-coplanar pairs to define a 3D warp.
// Checked here so the UI can disable the stage with a real message instead of
// surfacing a Python error.
export const MIN_WARP_LANDMARKS = 4
export const canWarpPiece = piece => completeLandmarks(piece).length >= MIN_WARP_LANDMARKS

// Signature for the autosave's change detector: the parts of the document that
// are worth a write. `lastSavedAt` is excluded on purpose — including it would
// make every save dirty the document again and autosave forever.
export function assemblySignature(doc) {
  if (!doc) return ''
  return JSON.stringify({
    basePieceId: doc.basePieceId,
    pieces: doc.pieces,
    settings: doc.settings,
    merged: doc.merged,
  })
}
