// Smart Segmentation: turning the analysis the Python service returns into parts.
//
// The service (python-server/app/services/segment.py) never decides how many
// parts there are. It returns the whole merge hierarchy — every pair of proxy
// regions that was fused, cheapest first — and everything in this file replays
// that history to a chosen level. Replaying is a union-find over ~3000 entries,
// so the Parts slider is instant and offline: no round trip, no recompute.
//
// ── Three index spaces, do not mix them ────────────────────────────────────
//   proxy face   an index into the decimated analysis mesh. What `history`
//                refers to. Only ever seen inside this module.
//   original face  a triangle of the editable geometry: face i is index buffer
//                entries [3i, 3i+1, 3i+2]. What `mapping` is keyed by, and the
//                only space the rest of the editor should ever see.
//   label        a part number, 0..count-1, assigned in order of first
//                appearance. NOT stable across a change of part count — which
//                is why the later correction tools must store face references
//                rather than label numbers.
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { createCanvasTexture } from './meshTexturing'

// ---------------------------------------------------------------------------
// Replaying the hierarchy
// ---------------------------------------------------------------------------

// A union-find over `size` elements with path compression. Without the
// compression the deepest chains make a slider drag quadratic on a mesh with
// many shells.
function makeUnionFind(size) {
  const parent = new Int32Array(size)
  for (let i = 0; i < size; i += 1) parent[i] = i
  const find = x => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  return { parent, find }
}

// Proxy-face labels after replaying the hierarchy down to `k` regions, leaving
// out the merges named in `skips`.
//
// Skipping is what "split one part only" is made of: the level stays pinned, so
// every region outside the one being worked on comes out bit-for-bit identical,
// and undoing a merge can only split the region it belonged to.
function replayProxy(history, n, k, skips) {
  const { parent, find } = makeUnionFind(n)
  const available = history.length >> 1
  const merges = Math.min(Math.max(0, n - Math.max(1, k)), available)
  for (let i = 0; i < merges; i += 1) {
    if (skips && skips.has(i)) continue
    const a = find(history[i * 2])
    const b = find(history[i * 2 + 1])
    if (a !== b) parent[b] = a
  }

  const dense = new Int32Array(n).fill(-1)
  const labels = new Int32Array(n)
  let count = 0
  for (let i = 0; i < n; i += 1) {
    const root = find(i)
    if (dense[root] < 0) {
      dense[root] = count
      count += 1
    }
    labels[i] = dense[root]
  }
  return { labels, count }
}

// Fuse the regions the user picked by hand.
//
// A merge is recorded as a pair of PROXY FACES, never as a pair of label
// numbers: labels are reassigned every time the part count changes, so a merge
// stored by label silently attaches itself to whatever part inherits that number
// next. A face index never changes, so the merge survives every later operation.
function applyProxyMerges(proxy, mergePairs) {
  if (!mergePairs?.length) return proxy
  const { parent, find } = makeUnionFind(proxy.count)
  const n = proxy.labels.length
  let changed = false
  for (const [a, b] of mergePairs) {
    if (a < 0 || b < 0 || a >= n || b >= n) continue
    const ra = find(proxy.labels[a])
    const rb = find(proxy.labels[b])
    if (ra !== rb) {
      parent[rb] = ra
      changed = true
    }
  }
  if (!changed) return proxy

  const dense = new Int32Array(proxy.count).fill(-1)
  let count = 0
  const remap = new Int32Array(proxy.count)
  for (let i = 0; i < proxy.count; i += 1) {
    const root = find(i)
    if (dense[root] < 0) {
      dense[root] = count
      count += 1
    }
    remap[i] = dense[root]
  }
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i += 1) labels[i] = remap[proxy.labels[i]]
  return { labels, count }
}

// The merges the current state is leaving out: the ones already baked in by an
// applied split, plus the ones the Parts slider is proposing inside the focused
// region but has not committed yet.
function collectSkips(segmentation, k, overrides) {
  const temp = focusTempSkips(segmentation, k, overrides)
  const perm = overrides?.skipMerges
  if (!temp?.size) return perm?.size ? perm : null
  if (!perm?.size) return temp
  const union = new Set(perm)
  for (const i of temp) union.add(i)
  return union
}

// Per-face part labels at a part count of `k`, with the manual corrections in
// `overrides` applied on top.
//
// Order matters and mirrors the reference: replay the hierarchy, fuse the manual
// merges, expand onto the original faces, then lay the brush strokes over the
// result. Paint goes last because it is an override of the final answer, not an
// input to it.
//
// The dense relabelling happens AFTER expansion, not before: decimation can
// leave a proxy region that no original face is closest to, and counting those
// would report parts that are nowhere on screen and leave gaps in the palette.
export function computeSegmentLabels(segmentation, k, overrides = null) {
  const { history, mapping, proxyFaceCount, faceCount } = segmentation
  // Once a split has been applied the global level is pinned: raising Parts from
  // then on may only add cuts inside the focused region, never re-cut the model.
  const level = overrides?.anchorK ?? k
  const proxy = applyProxyMerges(
    replayProxy(history, proxyFaceCount, level, collectSkips(segmentation, k, overrides)),
    overrides?.mergePairs
  )

  const dense = new Int32Array(proxy.count).fill(-1)
  const base = new Int32Array(faceCount)
  let count = 0
  for (let f = 0; f < faceCount; f += 1) {
    const region = proxy.labels[mapping[f]]
    if (dense[region] < 0) {
      dense[region] = count
      count += 1
    }
    base[f] = dense[region]
  }

  const labels = applyPaintRef(base, overrides?.paintRef)
  // `base` and `labels` deliberately share one numbering, and it is NOT closed up
  // after painting. Painting a part out of existence leaves an unused slot, which
  // costs a palette entry that is never drawn — and buys the brush its
  // incremental repaint: mid-stroke a face can be moved with
  // `labels[f] = base[target]` and erased with `labels[f] = base[f]`, with no
  // renumbering to keep the two arrays in step through.
  return { labels, base, count, visibleCount: countVisible(labels, count) }
}

function countVisible(labels, count) {
  const seen = new Uint8Array(count)
  let visible = 0
  for (let f = 0; f < labels.length; f += 1) {
    if (!seen[labels[f]]) {
      seen[labels[f]] = 1
      visible += 1
    }
  }
  return visible
}

// Reassign brushed faces to whatever part their REFERENCE FACE is in.
//
// Storing a reference face rather than a label id is what lets a stroke survive
// a change of part count, a manual merge, or a re-analysis: the target is
// resolved against the labels that exist at the moment it is applied. Reads come
// from `base`, never from the output, so a stroke laid over another stroke still
// resolves to the underlying part instead of chaining.
function applyPaintRef(base, paintRef) {
  if (!paintRef) return base
  let out = null
  for (let f = 0; f < base.length; f += 1) {
    const reference = paintRef[f]
    if (reference < 0 || reference >= base.length) continue
    if (base[f] === base[reference]) continue
    if (!out) out = base.slice()
    out[f] = base[reference]
  }
  return out || base
}

export function partFaceCounts(labels, count) {
  const totals = new Int32Array(Math.max(count, 1))
  for (let i = 0; i < labels.length; i += 1) totals[labels[i]] += 1
  return totals
}

// ---------------------------------------------------------------------------
// Manual corrections
// ---------------------------------------------------------------------------
//
// Three ways to fix a segmentation the analysis got wrong, and one rule they all
// obey: an override is stored as a FACE REFERENCE, never as a label number.
// Labels are reassigned whenever the part count changes, so an override stored
// by label silently reattaches itself to whichever part inherits that number
// next — which is how hand corrections used to vanish the moment anything else
// moved. A face index never changes.
//
//   brush    paintRef[face] = a face inside the part it should belong to
//   merge    mergePairs = pairs of proxy faces whose regions are fused
//   split    skipMerges = hierarchy merges undone inside one focused region
//
// The object is mutated in place (the arrays are per-face and copying one per
// dab would stall the brush); `revision` is what React watches.

export function createSegmentOverrides(faceCount) {
  return {
    paintRef: new Int32Array(faceCount).fill(-1),
    mergePairs: [],
    skipMerges: new Set(),
    // Pinned global level. Set the first time a region is focused, and never
    // moved again: from then on the Parts slider only ever adds cuts inside the
    // focus, so every other part on screen stays exactly as it is.
    anchorK: null,
    focusMask: null,   // Uint8Array over proxy faces
    focusTotal: 0,
    revision: 0,
  }
}

export function segmentOverridesEmpty(overrides) {
  return !overrides
    || (!overrides.mergePairs.length
      && !overrides.skipMerges.size
      && overrides.focusMask === null
      && countPaintedFaces(overrides) === 0)
}

export function countPaintedFaces(overrides) {
  const ref = overrides?.paintRef
  if (!ref) return 0
  let total = 0
  for (let f = 0; f < ref.length; f += 1) if (ref[f] >= 0) total += 1
  return total
}

// ── Brush ──────────────────────────────────────────────────────────────────

// Faces whose centre lies within `radius` of `point` and that face the camera.
//
// Runs off the geometry's existing three-mesh-bvh tree rather than a spatial
// grid of its own: the tree is already built and refit for sculpting, and a dab
// only descends the nodes the brush sphere actually touches.
//
// Back-facing triangles are dropped so a dab on a thin limb does not also paint
// the other side of it, which is the single most common way a stroke does
// visible damage you cannot see.
export function queryBrushFaces(geometry, point, radius, viewDirection, out) {
  const tree = geometry?.boundsTree
  const index = geometry?.index
  const position = geometry?.attributes?.position
  if (!tree || !index || !position) return 0

  const positions = position.array
  const indices = index.array
  const radiusSq = radius * radius
  const px = point.x
  const py = point.y
  const pz = point.z
  const vx = viewDirection?.x ?? 0
  const vy = viewDirection?.y ?? 0
  const vz = viewDirection?.z ?? 0
  const cull = !!viewDirection
  let found = 0

  tree.shapecast({
    intersectsBounds: box => (
      // Squared distance from the brush centre to the node's box.
      ((px < box.min.x ? (box.min.x - px) ** 2 : px > box.max.x ? (px - box.max.x) ** 2 : 0)
        + (py < box.min.y ? (box.min.y - py) ** 2 : py > box.max.y ? (py - box.max.y) ** 2 : 0)
        + (pz < box.min.z ? (box.min.z - pz) ** 2 : pz > box.max.z ? (pz - box.max.z) ** 2 : 0)
      ) <= radiusSq
    ),
    intersectsTriangle: (_triangle, triangleIndex) => {
      const a = indices[triangleIndex * 3] * 3
      const b = indices[triangleIndex * 3 + 1] * 3
      const c = indices[triangleIndex * 3 + 2] * 3
      const cx = (positions[a] + positions[b] + positions[c]) / 3
      const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3
      const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3
      const dx = cx - px
      const dy = cy - py
      const dz = cz - pz
      if (dx * dx + dy * dy + dz * dz > radiusSq) return false
      if (cull) {
        // Geometric normal from the winding — cheaper than reading the vertex
        // normals and correct for a per-face test.
        const e1x = positions[b] - positions[a]
        const e1y = positions[b + 1] - positions[a + 1]
        const e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a]
        const e2y = positions[c + 1] - positions[a + 1]
        const e2z = positions[c + 2] - positions[a + 2]
        const nx = e1y * e2z - e1z * e2y
        const ny = e1z * e2x - e1x * e2z
        const nz = e1x * e2y - e1y * e2x
        if (nx * vx + ny * vy + nz * vz >= 0) return false
      }
      if (found < out.length) {
        out[found] = triangleIndex
        found += 1
      }
      return false  // never stop early: we want every face in range
    },
  })
  return found
}

// Assign or clear a set of faces, returning the stroke record needed to undo it.
//
// Only the faces that actually change are recorded, and only the first time a
// stroke touches them — `touched` is the stroke's own scratch buffer, so holding
// the brush still does not grow the undo entry.
export function applyBrushFaces(overrides, faces, count, targetFace, erase, touched, stroke) {
  const ref = overrides.paintRef
  let changed = 0
  for (let i = 0; i < count; i += 1) {
    const face = faces[i]
    const next = erase ? -1 : targetFace
    if (ref[face] === next) continue
    if (!touched[face]) {
      touched[face] = 1
      stroke.indices.push(face)
      stroke.previous.push(ref[face])
    }
    ref[face] = next
    changed += 1
  }
  if (changed) overrides.revision += 1
  return changed
}

export function undoBrushStroke(overrides, stroke) {
  if (!stroke?.indices?.length) return 0
  const ref = overrides.paintRef
  for (let i = 0; i < stroke.indices.length; i += 1) ref[stroke.indices[i]] = stroke.previous[i]
  overrides.revision += 1
  return stroke.indices.length
}

export function clearSegmentPaint(overrides) {
  const cleared = countPaintedFaces(overrides)
  overrides.paintRef.fill(-1)
  overrides.revision += 1
  return cleared
}

// ── Manual merge ───────────────────────────────────────────────────────────

// Fuse the parts the given faces belong to. Recorded in proxy space, which is
// where the region ids the merge has to survive actually live.
export function addSegmentMerge(segmentation, overrides, faceIndices) {
  const proxies = []
  for (const face of faceIndices) {
    if (face < 0 || face >= segmentation.faceCount) continue
    proxies.push(segmentation.mapping[face])
  }
  if (proxies.length < 2) return 0
  for (let i = 1; i < proxies.length; i += 1) overrides.mergePairs.push([proxies[0], proxies[i]])
  overrides.revision += 1
  return proxies.length - 1
}

export function resetSegmentMerges(overrides) {
  const removed = overrides.mergePairs.length
  overrides.mergePairs = []
  overrides.revision += 1
  return removed
}

// ── Split one part only ────────────────────────────────────────────────────

// The merges the Parts slider is proposing inside the focused region, not yet
// committed. Exported for the label pipeline above; the UI goes through
// countSegmentPendingSplits.
export function focusTempSkips(segmentation, k, overrides) {
  if (!overrides?.focusMask) return null
  const extra = Math.max(0, Math.trunc(k) - overrides.focusTotal)
  if (extra <= 0) return null

  const { history, proxyFaceCount } = segmentation
  const level = overrides.anchorK ?? k
  const base = applyProxyMerges(
    replayProxy(history, proxyFaceCount, level, overrides.skipMerges),
    overrides.mergePairs
  )

  const inside = new Set()
  for (let p = 0; p < proxyFaceCount; p += 1) {
    if (overrides.focusMask[p]) inside.add(base.labels[p])
  }

  // Candidates are the merges with BOTH sides inside the focus. Undoing one can
  // therefore only ever split the focused region — nothing outside it can move.
  const available = history.length >> 1
  const window = Math.min(Math.max(0, proxyFaceCount - level), available)
  const candidates = []
  for (let i = 0; i < window; i += 1) {
    if (overrides.skipMerges.has(i)) continue
    if (inside.has(base.labels[history[i * 2]]) && inside.has(base.labels[history[i * 2 + 1]])) {
      candidates.push(i)
    }
  }
  // The LAST ones in history order: merges are recorded cheapest-first, so these
  // are the most expensive joins inside the region — the seams a human would cut.
  return new Set(candidates.slice(-extra))
}

export function countSegmentPendingSplits(segmentation, k, overrides) {
  return focusTempSkips(segmentation, k, overrides)?.size || 0
}

// Focus the part containing `faceIndex`. Returns the part count the Parts slider
// should jump to, which is also the level the hierarchy is now pinned at.
//
// Pinned at the RAW replay level (before manual merges), not at the part count on
// screen. Two different numbers live here and mixing them up re-cuts the whole
// model: merges reduce the visible count, but the hierarchy still has to be
// replayed at the level those merged regions came from.
export function openSegmentFocus(segmentation, k, overrides, faceIndex) {
  const { history, mapping, proxyFaceCount, faceCount } = segmentation
  if (faceIndex < 0 || faceIndex >= faceCount) return null

  const level = overrides.anchorK ?? k
  const raw = replayProxy(history, proxyFaceCount, level, collectSkips(segmentation, k, overrides))
  const merged = applyProxyMerges(raw, overrides.mergePairs)

  const label = merged.labels[mapping[faceIndex]]
  const mask = new Uint8Array(proxyFaceCount)
  let regionFaces = 0
  for (let p = 0; p < proxyFaceCount; p += 1) {
    if (merged.labels[p] === label) {
      mask[p] = 1
      regionFaces += 1
    }
  }
  if (regionFaces < 2) return null

  if (overrides.anchorK === null) overrides.anchorK = raw.count
  overrides.focusMask = mask
  overrides.focusTotal = raw.count
  overrides.revision += 1
  return raw.count
}

// Bake the proposed cuts in, so the next part can be worked on in turn.
export function applySegmentFocus(segmentation, k, overrides) {
  const temp = focusTempSkips(segmentation, k, overrides)
  if (!temp?.size) return 0
  for (const i of temp) overrides.skipMerges.add(i)
  overrides.focusMask = null
  overrides.focusTotal = 0
  overrides.revision += 1
  return temp.size
}

export function clearSegmentFocus(overrides) {
  if (!overrides.focusMask) return false
  overrides.focusMask = null
  overrides.focusTotal = 0
  overrides.revision += 1
  return true
}

export function resetSegmentSplits(overrides) {
  const removed = overrides.skipMerges.size
  overrides.skipMerges = new Set()
  overrides.anchorK = null
  overrides.focusMask = null
  overrides.focusTotal = 0
  overrides.revision += 1
  return removed
}

// Faces of the part containing `faceIndex` — the highlight the pickers draw.
export function facesOfPart(labels, faceIndex) {
  if (faceIndex < 0 || faceIndex >= labels.length) return null
  const label = labels[faceIndex]
  const mask = new Uint8Array(labels.length)
  for (let f = 0; f < labels.length; f += 1) mask[f] = labels[f] === label ? 1 : 0
  return mask
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

// A colour per part, keyed by the LOWEST face index the part contains rather
// than by its position in the list.
//
// That indirection is the whole point: label numbers are reassigned every time
// the part count changes, so a palette indexed by label would reshuffle every
// colour on screen each time the slider moved a single step. Keyed by a face
// index — which never changes — splitting one part leaves every other part the
// colour it already had, and the eye can actually follow what happened.
export function paletteFor(labels, count) {
  const total = Math.max(count, 1)
  const first = new Int32Array(total).fill(-1)
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]
    if (first[label] < 0) first[label] = i
  }

  const palette = new Float32Array(total * 3)
  for (let i = 0; i < total; i += 1) {
    // Knuth's multiplicative hash — scatters neighbouring face indices into
    // unrelated hues, so adjacent parts never come out near-identical.
    const seed = Math.imul(Math.max(first[i], 0), 2654435761) >>> 0
    const hue = (seed & 0xffff) / 65535
    const saturation = 0.55 + 0.3 * (((seed >>> 16) & 3) / 3)
    const value = 0.72 + 0.28 * ((seed >>> 18) & 1)
    const color = new THREE.Color().setHSL(hue, Math.min(saturation, 1), Math.min(value, 1) * 0.5 + 0.25)
    palette[i * 3] = color.r
    palette[i * 3 + 1] = color.g
    palette[i * 3 + 2] = color.b
  }
  return palette
}

// ---------------------------------------------------------------------------
// Display geometry
// ---------------------------------------------------------------------------

// A display-only copy of the mesh with one colour per triangle.
//
// NON-INDEXED on purpose. Vertex colours interpolate across a triangle, so on
// the shared (indexed) geometry every part boundary would render as a gradient
// smeared over the neighbouring triangles instead of a hard edge — and a
// segmentation you cannot see the edges of is useless. Three vertices per face
// costs roughly 9 floats a triangle (about 22 MB at 200k faces) and buys a crisp
// boundary plus a colour write that is a straight run over the array.
//
// It also deliberately does not put a `color` attribute on the editable geometry
// itself: that one is carried through the export pipeline and would be written
// into every saved GLB as COLOR_0, tinting the mesh in every engine afterwards.
// Same reasoning as weightPaintGeometry in MeshEditorPage.
export function createSegmentDisplayGeometry(geometry) {
  const index = geometry?.index
  const position = geometry?.attributes?.position
  if (!index || !position) return null

  const faceCount = Math.floor(index.count / 3)
  if (faceCount < 1) return null

  const indices = index.array
  const source = position.array
  const sourceNormals = geometry.attributes.normal?.array || null

  const positions = new Float32Array(faceCount * 9)
  const normals = new Float32Array(faceCount * 9)
  const colors = new Float32Array(faceCount * 9)

  for (let f = 0; f < faceCount; f += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const v = indices[f * 3 + corner] * 3
      const out = f * 9 + corner * 3
      positions[out] = source[v]
      positions[out + 1] = source[v + 1]
      positions[out + 2] = source[v + 2]
      if (sourceNormals) {
        normals[out] = sourceNormals[v]
        normals[out + 1] = sourceNormals[v + 1]
        normals[out + 2] = sourceNormals[v + 2]
      }
    }
  }

  const display = new THREE.BufferGeometry()
  // The home positions, kept so the explode slider always displaces from rest
  // rather than from wherever the last amount left things — otherwise dragging
  // the slider compounds and the parts drift away for good.
  display.userData.basePositions = positions.slice()
  display.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  display.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  display.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (!sourceNormals) display.computeVertexNormals()
  display.computeBoundingBox()
  display.computeBoundingSphere()
  // Kept so the explode slider can widen the bounds arithmetically instead of
  // re-measuring three quarters of a million vertices on every step.
  display.userData.restBounds = {
    box: display.boundingBox.clone(),
    sphere: display.boundingSphere.clone(),
  }
  return display
}

// The accent a picked part is drawn in — the same yellow the reference uses,
// chosen because no generated palette colour comes near it.
const HIGHLIGHT_COLOR = [1.0, 0.82, 0.25]
// How far the rest of the mesh is knocked back while something is picked.
const DIM_FACTOR = 0.3

function faceColor(colors, face, r, g, b) {
  const out = face * 9
  for (let corner = 0; corner < 3; corner += 1) {
    colors[out + corner * 3] = r
    colors[out + corner * 3 + 1] = g
    colors[out + corner * 3 + 2] = b
  }
}

// Repaint the display geometry in place. Called on every slider step, so it
// touches nothing but the colour array and its upload flag.
//
// `highlight` is a per-face mask of the part being picked. `dimOthers` says
// whether the rest of the mesh is knocked back: true while picking a part to
// merge or split (the pick is the only thing that matters), false while the
// brush is armed (you need to read the parts you are correcting, and the target
// only has to be identifiable).
export function writeSegmentColors(displayGeometry, labels, palette, { highlight = null, dimOthers = true } = {}) {
  const attribute = displayGeometry?.attributes?.color
  if (!attribute) return
  const colors = attribute.array
  const faceCount = Math.min(labels.length, Math.floor(colors.length / 9))
  const scale = highlight && dimOthers ? DIM_FACTOR : 1
  for (let f = 0; f < faceCount; f += 1) {
    if (highlight?.[f]) {
      faceColor(colors, f, HIGHLIGHT_COLOR[0], HIGHLIGHT_COLOR[1], HIGHLIGHT_COLOR[2])
      continue
    }
    const p = labels[f] * 3
    faceColor(colors, f, palette[p] * scale, palette[p + 1] * scale, palette[p + 2] * scale)
  }
  attribute.needsUpdate = true
}

// Repaint only the faces a brush dab moved.
//
// A stroke must not go through the label pipeline per dab: on a 180k-face mesh
// that is a full replay, expand and recolour for every step of the pointer, and
// the brush drops frames. The dab already knows which faces changed, so it
// writes those and nothing else — the same trade the sculpt and weight brushes
// make. The pipeline runs once at the end of the stroke.
export function recolorSegmentFaces(displayGeometry, faces, count, labels, palette) {
  const attribute = displayGeometry?.attributes?.color
  if (!attribute || count < 1) return
  const colors = attribute.array
  const limit = Math.floor(colors.length / 9)
  for (let i = 0; i < count; i += 1) {
    const face = faces[i]
    if (face < 0 || face >= limit) continue
    const p = labels[face] * 3
    faceColor(colors, face, palette[p], palette[p + 1], palette[p + 2])
  }
  attribute.needsUpdate = true
}

// ---------------------------------------------------------------------------
// Explode
// ---------------------------------------------------------------------------

// A displacement vector per part: from the centre of the part centroids out to
// each part's own centroid.
//
// Deliberately NOT normalised. Scaling each part by how far it already sits from
// the middle keeps the model's arrangement legible as it comes apart — an arm
// travels further than a shoulder pad, so the pieces stay recognisable instead
// of landing on a uniform sphere around the origin.
//
// Measured on the display geometry, which is already split per face, so parts
// separate cleanly with no shared vertices to tear.
export function computeExplodeDirections(displayGeometry, labels, count) {
  const base = displayGeometry?.userData?.basePositions
  if (!base || count < 1) return null

  const sums = new Float64Array(count * 3)
  const totals = new Float64Array(count)
  const faceCount = Math.min(labels.length, Math.floor(base.length / 9))
  for (let f = 0; f < faceCount; f += 1) {
    const label = labels[f]
    const at = f * 9
    sums[label * 3] += base[at] + base[at + 3] + base[at + 6]
    sums[label * 3 + 1] += base[at + 1] + base[at + 4] + base[at + 7]
    sums[label * 3 + 2] += base[at + 2] + base[at + 5] + base[at + 8]
    totals[label] += 3
  }

  const directions = new Float32Array(count * 3)
  let live = 0
  const middle = [0, 0, 0]
  for (let i = 0; i < count; i += 1) {
    if (totals[i] < 1) continue
    live += 1
    middle[0] += sums[i * 3] / totals[i]
    middle[1] += sums[i * 3 + 1] / totals[i]
    middle[2] += sums[i * 3 + 2] / totals[i]
  }
  if (!live) return directions
  middle[0] /= live
  middle[1] /= live
  middle[2] /= live

  let span = 1e-6
  for (let i = 0; i < count; i += 1) {
    if (totals[i] < 1) continue
    const x = sums[i * 3] / totals[i] - middle[0]
    const y = sums[i * 3 + 1] / totals[i] - middle[1]
    const z = sums[i * 3 + 2] / totals[i] - middle[2]
    directions[i * 3] = x
    directions[i * 3 + 1] = y
    directions[i * 3 + 2] = z
    span = Math.max(span, Math.hypot(x, y, z))
  }

  // A part centred on the middle has no direction to travel and would sit inside
  // everything else. Fan those out instead, on a stable spiral so a given part
  // always leaves the same way.
  for (let i = 0; i < count; i += 1) {
    if (totals[i] < 1) continue
    const length = Math.hypot(directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2])
    if (length >= span * 1e-3) continue
    const angle = i * 2.4
    const fallback = [Math.cos(angle), Math.sin(angle), 0.35]
    const norm = Math.hypot(fallback[0], fallback[1], fallback[2])
    directions[i * 3] = (fallback[0] / norm) * span * 0.35
    directions[i * 3 + 1] = (fallback[1] / norm) * span * 0.35
    directions[i * 3 + 2] = (fallback[2] / norm) * span * 0.35
  }
  return directions
}

// Push the parts apart by `amount` times their displacement vector.
//
// Every part moves rigidly, so the normals stay correct and only the positions
// and the bounds need touching.
export function applySegmentExplode(displayGeometry, labels, directions, rawAmount) {
  const attribute = displayGeometry?.attributes?.position
  const base = displayGeometry?.userData?.basePositions
  if (!attribute || !base) return
  // A non-finite amount would write NaN into every position and the mesh would
  // vanish with nothing but a three.js bounding-box warning to say why.
  const amount = Number.isFinite(rawAmount) ? rawAmount : 0
  // Nothing to undo and nothing to do: the labels change on every step of the
  // Parts slider, and rewriting 1.6M floats back to where they already are would
  // put a pointless copy in the middle of a drag.
  if (amount <= 0 && !displayGeometry.userData.explodeAmount) return
  displayGeometry.userData.explodeAmount = amount > 0 ? amount : 0
  const out = attribute.array

  if (!directions || amount <= 0) {
    out.set(base)
  } else {
    const faceCount = Math.min(labels.length, Math.floor(base.length / 9))
    for (let f = 0; f < faceCount; f += 1) {
      const d = labels[f] * 3
      const dx = directions[d] * amount
      const dy = directions[d + 1] * amount
      const dz = directions[d + 2] * amount
      const at = f * 9
      for (let corner = 0; corner < 3; corner += 1) {
        out[at + corner * 3] = base[at + corner * 3] + dx
        out[at + corner * 3 + 1] = base[at + corner * 3 + 1] + dy
        out[at + corner * 3 + 2] = base[at + corner * 3 + 2] + dz
      }
    }
  }

  attribute.needsUpdate = true

  // The parts now reach well outside the original bounds, and without widening
  // them the renderer frustum-culls the ones that flew furthest. Done by
  // arithmetic, not measurement: computeBoundingSphere walks every vertex twice
  // and cost 30 of the 37ms a slider step used to take. No part can travel
  // further than the longest displacement, so padding the rest bounds by that is
  // conservative — it may over-estimate, which only ever means drawing something
  // that was already on screen.
  const rest = displayGeometry.userData.restBounds
  if (!rest) {
    displayGeometry.computeBoundingBox()
    displayGeometry.computeBoundingSphere()
    return
  }
  let reach = 0
  if (directions && amount > 0) {
    for (let i = 0; i < directions.length; i += 3) {
      reach = Math.max(reach, Math.hypot(directions[i], directions[i + 1], directions[i + 2]))
    }
    reach *= amount
  }
  displayGeometry.boundingBox = rest.box.clone().expandByScalar(reach)
  displayGeometry.boundingSphere = rest.sphere.clone()
  displayGeometry.boundingSphere.radius += reach
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// One BufferGeometry per part, each carrying only the faces of that label with
// its vertices compacted down. Parts under `minFaces` are dropped — decimation
// noise leaves a scatter of one-triangle regions that are not parts of anything.
export function buildPartGeometries(geometry, labels, count, { minFaces = 4 } = {}) {
  const index = geometry?.index
  const position = geometry?.attributes?.position
  if (!index || !position) return []

  const indices = index.array
  const source = position.array
  const sourceNormals = geometry.attributes.normal?.array || null
  const sourceUvs = geometry.attributes.uv?.array || null
  const vertexCount = position.count

  const totals = partFaceCounts(labels, count)

  // Bucket the faces by label in one counting-sort pass. Scanning the whole face
  // array once per part instead would be O(parts x faces) — 40 million steps on
  // a 200k-face mesh cut into 200 pieces.
  const offsets = new Int32Array(count + 1)
  for (let f = 0; f < labels.length; f += 1) offsets[labels[f] + 1] += 1
  for (let i = 0; i < count; i += 1) offsets[i + 1] += offsets[i]
  const facesByLabel = new Int32Array(labels.length)
  const cursors = offsets.slice(0, count)
  for (let f = 0; f < labels.length; f += 1) {
    facesByLabel[cursors[labels[f]]] = f
    cursors[labels[f]] += 1
  }

  // Two scratch arrays reused by every part, keyed by a per-part stamp so there
  // is nothing to clear between parts. Allocating them per part would mean one
  // full-mesh allocation per piece.
  const seen = new Int32Array(vertexCount)
  const slot = new Int32Array(vertexCount)
  const parts = []
  let stamp = 0

  for (let label = 0; label < count; label += 1) {
    if (totals[label] < minFaces) continue
    stamp += 1

    const faceTotal = totals[label]
    const partIndices = new Uint32Array(faceTotal * 3)
    const positions = []
    const normals = []
    const uvs = []
    let nextVertex = 0
    let cursor = 0

    for (let i = offsets[label]; i < offsets[label + 1]; i += 1) {
      const f = facesByLabel[i]
      for (let corner = 0; corner < 3; corner += 1) {
        const v = indices[f * 3 + corner]
        if (seen[v] !== stamp) {
          seen[v] = stamp
          slot[v] = nextVertex
          const at = v * 3
          positions.push(source[at], source[at + 1], source[at + 2])
          if (sourceNormals) normals.push(sourceNormals[at], sourceNormals[at + 1], sourceNormals[at + 2])
          if (sourceUvs) uvs.push(sourceUvs[v * 2], sourceUvs[v * 2 + 1])
          nextVertex += 1
        }
        partIndices[cursor] = slot[v]
        cursor += 1
      }
    }

    const partGeometry = new THREE.BufferGeometry()
    partGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    if (sourceNormals) partGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    if (sourceUvs) partGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    partGeometry.setIndex(new THREE.BufferAttribute(partIndices, 1))
    if (!sourceNormals) partGeometry.computeVertexNormals()
    partGeometry.computeBoundingBox()
    partGeometry.computeBoundingSphere()

    parts.push({ label, faceCount: faceTotal, geometry: partGeometry })
  }

  return parts
}
// A GLB scene with one node per part, named `<base>_part_01`, `…_02`, …
// A scene rather than one merged mesh, so the parts stay separable wherever the
// file lands — which is the entire point of having segmented it.
//
// Two looks, and the caller chooses by passing `textureCanvas` or not. Without
// one, each part gets the preview palette colour it is drawn in — which is what
// makes the split readable in any viewer. With one, every part instead shares
// the mesh's own atlas: the part geometries kept their UVs (see
// buildPartGeometries), so there is nothing to re-bake or re-project — the parts
// index the very texels the editor is showing. One material instance across all
// of them, so GLTFExporter embeds the image exactly once however many parts
// there are.
export function exportPartsToGlb(parts, palette, baseName = 'mesh', {
  textureCanvas = null,
  textureConfig = null,
  extraMaps = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!parts?.length) {
      reject(new Error('There are no parts to export.'))
      return
    }

    // Everything this function builds, torn down once the exporter has read it.
    // Deliberately does NOT include the maps in `extraMaps`: those are the
    // page's own textures, still bound to the mesh on screen.
    const owned = []
    const group = new THREE.Group()
    group.name = `${baseName}_parts`

    let sharedMaterial = null
    if (textureCanvas) {
      // Reuse the texturing pipeline's own factory rather than configuring a
      // CanvasTexture here: it carries flipY and the colour space off the
      // texture the mesh was loaded with, and getting either wrong shows up as
      // an upside-down or washed-out albedo.
      const texture = createCanvasTexture(textureCanvas, textureConfig)
      texture.name = 'MeshEditorTexture'
      owned.push(texture)
      // White, not the palette colour: this becomes baseColorFactor and would
      // multiply over every texel. The palette is a preview tint for reading the
      // split on screen, not part of the surface.
      sharedMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: texture,
        metalness: 0.05,
        roughness: 0.7,
      })
      // Baked channels live on the display root's materials, so a material built
      // from scratch here would otherwise drop them.
      Object.entries(extraMaps || {}).forEach(([slot, map]) => {
        if (map) sharedMaterial[slot] = map
      })
      // glTF sets these factors to 1 wherever the matching texture is present —
      // a scalar left at its default would scale every baked value down.
      if (sharedMaterial.roughnessMap) sharedMaterial.roughness = 1
      if (sharedMaterial.metalnessMap) sharedMaterial.metalness = 1
      sharedMaterial.name = `${baseName}_mat`
      sharedMaterial.needsUpdate = true
      owned.push(sharedMaterial)
    }

    parts.forEach((part, order) => {
      const name = `${baseName}_part_${String(order + 1).padStart(2, '0')}`
      // A part with no UVs cannot use the atlas — it would sample one texel for
      // its whole surface. Cannot happen while the caller gates on the editable
      // geometry's UVs, but falling back per part is cheaper than a black piece.
      let material = part.geometry.attributes.uv ? sharedMaterial : null
      if (!material) {
        const p = part.label * 3
        material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(palette[p], palette[p + 1], palette[p + 2]),
          metalness: 0.05,
          roughness: 0.7,
        })
        material.name = `${name}_mat`
        owned.push(material)
      }
      const mesh = new THREE.Mesh(part.geometry, material)
      mesh.name = name
      group.add(mesh)
    })

    const release = () => owned.forEach(item => item.dispose?.())

    new GLTFExporter().parse(
      group,
      result => {
        release()
        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('Failed to export the parts as a binary GLB file.'))
          return
        }
        resolve(new Blob([result], { type: 'model/gltf-binary' }))
      },
      error => {
        release()
        reject(error instanceof Error ? error : new Error('Failed to export the parts as GLB.'))
      },
      { binary: true, onlyVisible: false }
    )
  })
}
