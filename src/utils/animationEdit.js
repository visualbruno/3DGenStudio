// Frame-level editing of a RETARGETED animation clip (Auto Rig → Animation edit
// dock). Pure functions over a THREE.AnimationClip: nothing here touches React,
// the mixer or the scene.
//
// What is being edited, and why it works the way it does:
//
// `retargetAnimationClip` bakes on a UNIFORM GRID — one key on every frame at
// ~30 fps (`frameCount = round(duration * fps) + 1`), one QuaternionKeyframeTrack
// per mapped bone plus one hip `.position` track, all sharing the same `times`
// array. So a frame IS an index: frame f of a quaternion track lives at
// `values[f * 4 … f * 4 + 3]`. No key search, no resampling.
//
// That density is also why a single-frame edit is NOT what you usually want: its
// neighbours are 33 ms away, so a lone edited frame reads as a pop rather than a
// correction. Hence `scope`: an edit is a DELTA (target minus what the frame
// currently holds) applied to the frame and, with a cosine falloff, to its
// neighbours — or to the whole clip when the pose is wrong throughout. Editing one
// frame in isolation stays available for deliberate spikes.
//
// Rotations are edited as Euler degrees because that is the only readable form of
// a quaternion, and written back as a delta quaternion premultiplied onto each
// affected key — never as re-composed Euler per frame, which would throw away the
// bake's continuity and flip axes wherever the Euler decomposition jumps.
import { AnimationClip, Euler, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

export const EDIT_SCOPES = [
  { value: 'falloff', label: 'Falloff' },
  { value: 'frame', label: 'This frame' },
  { value: 'clip', label: 'Whole clip' },
]
export const DEFAULT_EDIT_SCOPE = 'falloff'
// Below these, an edit is discarded as "no change". Not arbitrary: the fields show
// a rounded number, so committing the value on screen asks for a delta of up to a
// few 1e-4 units — and a quaternion read out of a float32 track, decomposed to
// Euler and recomposed, differs from itself by ~0.016°. Both are invisible, and
// recording them would mark a clip hand-edited (and so no longer rebakeable) for
// pressing Enter.
const MIN_ROTATION_DELTA_DEG = 0.02
const MIN_POSITION_DELTA = 1e-6
export const DEFAULT_EDIT_SPAN = 8      // frames either side, ~0.27s at 30fps
export const MAX_EDIT_SPAN = 120

// Scratch objects: these functions run per keystroke over every frame of a track.
const _q = new Quaternion()
const _qTarget = new Quaternion()
const _qDelta = new Quaternion()
const _qStep = new Quaternion()
const _euler = new Euler()

// ".bones[Hips].position" / "Hips.quaternion" → { boneName, kind }.
// Playback tracks use the ".bones[...]" form (the mixer resolves them against the
// SkinnedMesh); the plain form is what BVH/glTF clips carry.
export function parseTrackName(name) {
  const m = /^(?:\.bones\[(.+?)\]|(.+?))\.(quaternion|position)$/.exec(name || '')
  if (!m) return null
  return { boneName: m[1] ?? m[2], kind: m[3] }
}

// Describe a clip for the edit dock: the frame grid, plus one row per animated
// bone carrying whichever of its tracks exist.
//
// `editable` is per bone and means "this bone's tracks sit on the clip's frame
// grid". Generated tracks do not: `withHandPose` appends 2-key constant tracks for
// the finger bones, and those are rebuilt from the Hand-curl sliders on every
// bake, so an edit to one would be silently discarded. They are listed (so their
// absence is not a mystery) and locked.
export function describeClip(clip) {
  if (!clip?.tracks?.length) return null

  // The grid is the longest track's timeline — every retargeted track shares it.
  let grid = null
  for (const track of clip.tracks) {
    if (!grid || track.times.length > grid.length) grid = track.times
  }
  const frameCount = grid ? grid.length : 0
  if (frameCount < 2) return null
  const duration = clip.duration || grid[frameCount - 1] || 0
  const fps = duration > 0 ? (frameCount - 1) / duration : 30

  const byBone = new Map()
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name)
    if (!parsed) continue
    let row = byBone.get(parsed.boneName)
    if (!row) {
      // Track order out of the retargeter is a parent-first traversal of the
      // target skeleton, so insertion order is already hierarchy order.
      row = { boneName: parsed.boneName, rotation: null, position: null, editable: true, keyCount: 0 }
      byBone.set(parsed.boneName, row)
    }
    if (parsed.kind === 'quaternion') row.rotation = track.name
    else row.position = track.name
    row.keyCount = Math.max(row.keyCount, track.times.length)
    if (track.times.length !== frameCount) row.editable = false
  }

  return { fps, frameCount, duration, times: grid, bones: [...byBone.values()] }
}

export function frameTime(description, frame) {
  if (!description) return 0
  const clamped = Math.max(0, Math.min(description.frameCount - 1, Math.round(frame) || 0))
  return description.times[clamped] ?? 0
}

function findTrack(clip, trackName) {
  return clip?.tracks?.find(t => t.name === trackName) || null
}

// The three numbers to show for one track at one frame: Euler degrees for a
// rotation, raw units for a position.
export function readFrameValues(clip, trackName, frame) {
  const track = findTrack(clip, trackName)
  if (!track) return null
  const parsed = parseTrackName(trackName)
  if (!parsed) return null
  const f = Math.max(0, Math.min(track.times.length - 1, Math.round(frame) || 0))
  if (parsed.kind === 'quaternion') {
    _q.fromArray(track.values, f * 4)
    _euler.setFromQuaternion(_q, 'XYZ')
    return [_euler.x * RAD2DEG, _euler.y * RAD2DEG, _euler.z * RAD2DEG]
  }
  const o = f * 3
  return [track.values[o], track.values[o + 1], track.values[o + 2]]
}

// Cosine falloff: 1 at the edited frame, 0 at ±span, smooth in between (no
// derivative jump at the seam, unlike a linear ramp).
function editWeight(distance, scope, span) {
  if (scope === 'clip') return 1
  if (scope === 'frame') return distance === 0 ? 1 : 0
  if (distance === 0) return 1
  if (distance >= span) return 0
  return 0.5 * (1 + Math.cos((Math.PI * distance) / span))
}

// Apply an edit and return { before, after } snapshots of the whole track's values
// for the undo stack (a few KB per op — a 4s rotation track is 121 × 4 floats).
// Returns null when there is nothing to do: unknown track, off-grid track, or a
// value that already matches.
export function applyFrameEdit(clip, trackName, frame, nextXYZ, {
  scope = DEFAULT_EDIT_SCOPE, span = DEFAULT_EDIT_SPAN,
} = {}) {
  const track = findTrack(clip, trackName)
  const parsed = parseTrackName(trackName)
  if (!track || !parsed) return null
  const stride = parsed.kind === 'quaternion' ? 4 : 3
  const n = Math.floor(track.values.length / stride)
  if (n < 1) return null
  const f = Math.max(0, Math.min(n - 1, Math.round(frame) || 0))
  // `span` is not clamped here: this function only composes the target and hands the
  // write (and the clamping) to applyFrameRotation / applyFramePosition.

  // null/undefined means "leave this axis alone" — and must be checked BEFORE the
  // Number() cast, since Number(null) is 0, i.e. a silent "drive this axis to zero".
  const target = [0, 1, 2].map(i => {
    const raw = nextXYZ?.[i]
    if (raw === null || raw === undefined || raw === '') return null
    const v = Number(raw)
    return Number.isFinite(v) ? v : null
  })
  if (target.every(v => v === null)) return null

  if (parsed.kind === 'quaternion') {
    _q.fromArray(track.values, f * 4)
    const current = new Euler().setFromQuaternion(_q, 'XYZ')
    _euler.set(
      (target[0] ?? current.x * RAD2DEG) * DEG2RAD,
      (target[1] ?? current.y * RAD2DEG) * DEG2RAD,
      (target[2] ?? current.z * RAD2DEG) * DEG2RAD,
      'XYZ',
    )
    return applyFrameRotation(clip, trackName, f, _qTarget.setFromEuler(_euler).toArray(), { scope, span })
  }
  const o = f * 3
  const vector = [0, 1, 2].map(a => (target[a] === null ? track.values[o + a] : target[a]))
  return applyFramePosition(clip, trackName, f, vector, { scope, span })
}

// Rotate a bone to an absolute target quaternion at one frame. Shared by the Euler
// fields and by the viewport gizmo, which has a world-space quaternion in hand and no
// reason to round-trip it through Euler angles.
//
// The write is a DELTA premultiplied onto each affected key — `target * current-inv`,
// scaled by the falloff weight — so the neighbouring frames keep their own motion,
// shifted, instead of collapsing towards one pose. (A pasted pose is the other case:
// absolute, see pasteFramePose.)
export function applyFrameRotation(clip, trackName, frame, quaternion, {
  scope = DEFAULT_EDIT_SCOPE, span = DEFAULT_EDIT_SPAN,
} = {}) {
  const track = findTrack(clip, trackName)
  if (!track || !quaternion || quaternion.length < 4) return null
  const n = Math.floor(track.values.length / 4)
  if (n < 1) return null
  const f = Math.max(0, Math.min(n - 1, Math.round(frame) || 0))
  const reach = Math.max(1, Math.round(span) || 1)

  const before = Float32Array.from(track.values)
  _q.fromArray(track.values, f * 4)
  _qTarget.fromArray(quaternion).normalize()
  // Normalize before measuring OR applying: `Quaternion.invert()` is a conjugate, so
  // a key that came back from float32 storage a hair off unit length turns into a
  // delta that is a hair off unit SCALE — and its `w` then reads as ~0.026 degrees of
  // rotation that is not there, which would defeat the no-op check below.
  _qDelta.copy(_qTarget).multiply(_q.invert()).normalize()
  const deltaDeg = 2 * Math.acos(Math.min(1, Math.abs(_qDelta.w))) * RAD2DEG
  if (deltaDeg < MIN_ROTATION_DELTA_DEG) return null

  for (let i = 0; i < n; i++) {
    const w = editWeight(Math.abs(i - f), scope, reach)
    if (w <= 0) continue
    _qStep.identity().slerp(_qDelta, w)
    _q.fromArray(track.values, i * 4).premultiply(_qStep).normalize()
    _q.toArray(track.values, i * 4)
  }
  return { before, after: Float32Array.from(track.values) }
}

// Move a bone to an absolute target position (in the track's own space, i.e. local to
// the parent bone) at one frame. Same delta-with-falloff rule as the rotation.
export function applyFramePosition(clip, trackName, frame, vector, {
  scope = DEFAULT_EDIT_SCOPE, span = DEFAULT_EDIT_SPAN,
} = {}) {
  const track = findTrack(clip, trackName)
  if (!track || !vector || vector.length < 3) return null
  const n = Math.floor(track.values.length / 3)
  if (n < 1) return null
  const f = Math.max(0, Math.min(n - 1, Math.round(frame) || 0))
  const reach = Math.max(1, Math.round(span) || 1)

  const before = Float32Array.from(track.values)
  const o = f * 3
  const delta = [0, 1, 2].map(a => vector[a] - track.values[o + a])
  if (delta.every(d => Math.abs(d) < MIN_POSITION_DELTA)) return null

  for (let i = 0; i < n; i++) {
    const w = editWeight(Math.abs(i - f), scope, reach)
    if (w <= 0) continue
    for (let a = 0; a < 3; a++) track.values[i * 3 + a] += delta[a] * w
  }
  return { before, after: Float32Array.from(track.values) }
}

// Give a bone a position track it does not have, so it can be MOVED and not only
// rotated. Every key holds the bone's rest position, so the clip plays identically
// until something edits it — and the clip is REBUILT rather than mutated, because the
// mixer binds a clip's tracks once and would never see an appended one.
//
// The name follows whatever convention the bone's existing track uses instead of
// assuming ".bones[Name].": a clip parsed from BVH or glTF uses the bare "Name." form.
export function ensurePositionTrack(clip, boneName, restPosition) {
  return ensureTrack(clip, boneName, 'position', restPosition)
}

// The same for a ROTATION track, which is what makes a bone the clip does not
// animate at all editable: the reference the clip was retargeted from had nothing
// to map onto it (a tail, an ear, Auto Rig's leftover `extra_*` bones), so the
// retarget wrote no track and the bone cannot be posed until one exists.
//
// Every key is the bone's rest orientation, so adding one changes nothing on
// screen — it only gives the dock and the gizmo something to write to.
export function ensureRotationTrack(clip, boneName, restQuaternion) {
  return ensureTrack(clip, boneName, 'rotation', restQuaternion)
}

// Track NAMES follow whatever convention the clip already uses: a playback clip
// binds through the SkinnedMesh's skeleton (".bones[Name].quaternion"), while a
// source clip binds against scene nodes ("Name.quaternion"). Copying the shape off
// an existing track is what keeps a clip readable by whichever of the two is
// playing it — guessing one would produce a track the mixer silently ignores.
function trackNameFor(clip, boneName, kind) {
  const property = kind === 'rotation' ? 'quaternion' : 'position'
  const sample = clip?.tracks?.[0]?.name || ''
  return sample.startsWith('.bones[')
    ? `.bones[${boneName}].${property}`
    : `${boneName}.${property}`
}

// Shared by both: build a constant track on the clip's own frame grid and return a
// NEW clip carrying it. The clip has to be rebuilt rather than mutated because the
// mixer binds a clip's tracks once and never notices an appended one.
function ensureTrack(clip, boneName, kind, restValue) {
  const stride = kind === 'rotation' ? 4 : 3
  const description = describeClip(clip)
  if (!description || !boneName || restValue?.length !== stride) return null

  const row = description.bones.find(b => b.boneName === boneName)
  // Already has one, or the bone is off-grid (hand-curl tracks, rebuilt per bake).
  if (row && (row[kind] || !row.editable)) return null

  // Share the grid's `times` array, as every baked track does.
  const grid = clip.tracks.find(t => t.times.length === description.frameCount)
  if (!grid) return null

  const values = new Float32Array(description.frameCount * stride)
  for (let i = 0; i < description.frameCount; i++) {
    for (let a = 0; a < stride; a++) values[i * stride + a] = restValue[a]
  }
  const trackName = trackNameFor(clip, boneName, kind)
  const track = kind === 'rotation'
    ? new QuaternionKeyframeTrack(trackName, grid.times, values)
    : new VectorKeyframeTrack(trackName, grid.times, values)

  const out = new AnimationClip(clip.name, clip.duration, [...clip.tracks, track])
  out.userData = { ...(clip.userData || {}) }
  return { clip: out, trackName }
}

// Put a snapshot back (undo / redo). In place, so the clip object stays the one
// the mixer is already playing.
export function restoreTrackValues(clip, trackName, snapshot) {
  const track = findTrack(clip, trackName)
  if (!track || !snapshot || track.values.length !== snapshot.length) return false
  track.values.set(snapshot)
  return true
}

// --- Structural edits: adding, inserting and deleting FRAMES ----------------
// All of them are one primitive: rebuild the clip so that its frame `i` takes its
// values from old frame `order[i]`. Duplicates in `order` insert, gaps delete, and
// a shorter `order` trims — one code path to get right instead of four.
//
// The frame GRID is preserved, not the duration: `dt` stays what the bake used
// (~1/30s), so the clip simply becomes shorter or longer and playback speed never
// changes. That is what makes this usable for looping — trim the tail until the last
// pose meets the first, and the cycle still runs at the speed it was generated at.
//
// Tracks that are not on the grid (the 2-key finger tracks `withHandPose` appends)
// cannot be re-indexed frame by frame, so their keys are rescaled to the new
// duration instead — otherwise a trimmed clip would hold the hand pose past its end,
// or drop it early.

export const MIN_CLIP_FRAMES = 2   // three needs two keys to interpolate a track

function clipGrid(clip) {
  const description = describeClip(clip)
  if (!description) return null
  const dt = description.frameCount > 1 ? description.duration / (description.frameCount - 1) : 0
  return dt > 0 ? { ...description, dt } : null
}

function reorderClipFrames(clip, order) {
  const grid = clipGrid(clip)
  if (!grid || order.length < MIN_CLIP_FRAMES) return null
  const newCount = order.length
  const newDuration = (newCount - 1) * grid.dt
  const times = new Float32Array(newCount)
  for (let i = 0; i < newCount; i++) times[i] = i * grid.dt

  const tracks = clip.tracks.map(track => {
    const keys = track.times.length
    const stride = Math.round(track.values.length / keys)
    if (keys !== grid.frameCount) {
      // Off-grid: keep the keys, move them proportionally into the new duration.
      const clone = track.clone()
      const factor = grid.duration > 0 ? newDuration / grid.duration : 1
      clone.times = Float32Array.from(track.times, t => t * factor)
      return clone
    }
    const values = new Float32Array(newCount * stride)
    for (let i = 0; i < newCount; i++) {
      const src = order[i] * stride
      for (let k = 0; k < stride; k++) values[i * stride + k] = track.values[src + k]
    }
    // Same constructor, so quaternion tracks keep their slerp interpolation. Every
    // on-grid track shares the one `times` array, exactly as the bake writes them.
    return new track.constructor(track.name, times, values)
  })

  const out = new AnimationClip(clip.name, newDuration, tracks)
  out.userData = { ...(clip.userData || {}) }
  return out
}

const range = (from, to) => {
  const out = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

// Every operation returns { clip, frame } — the new clip and where the playhead
// should land — or null when it would not change anything (or would leave the clip
// with fewer than two frames).
export function applyFrameOperation(clip, operation, frame) {
  const grid = clipGrid(clip)
  if (!grid) return null
  const n = grid.frameCount
  const at = Math.max(0, Math.min(n - 1, Math.round(frame) || 0))

  switch (operation) {
    // A copy of this frame becomes the next one, so the pose is held a frame longer.
    case 'insert': {
      const next = reorderClipFrames(clip, [...range(0, at), at, ...range(at + 1, n - 1)])
      return next ? { clip: next, frame: at + 1 } : null
    }
    // A copy of the LAST frame, appended. Handy for closing a loop: append, then
    // edit the appended frame to match frame 0.
    case 'append': {
      const next = reorderClipFrames(clip, [...range(0, n - 1), n - 1])
      return next ? { clip: next, frame: n } : null
    }
    case 'delete': {
      if (n <= MIN_CLIP_FRAMES) return null
      const next = reorderClipFrames(clip, range(0, n - 1).filter(i => i !== at))
      return next ? { clip: next, frame: Math.min(at, n - 2) } : null
    }
    // Trims: what actually makes a generated clip loop, since the fix is usually
    // "the cycle ends 12 frames after it should".
    case 'trimBefore': {
      if (at === 0 || n - at < MIN_CLIP_FRAMES) return null
      const next = reorderClipFrames(clip, range(at, n - 1))
      return next ? { clip: next, frame: 0 } : null
    }
    case 'trimAfter': {
      if (at === n - 1 || at + 1 < MIN_CLIP_FRAMES) return null
      const next = reorderClipFrames(clip, range(0, at))
      return next ? { clip: next, frame: at } : null
    }
    default:
      return null
  }
}

// --- Copy / paste a whole frame's pose -------------------------------------
// A pose is every ON-GRID track's value at one frame: the bones' rotations plus the
// hip position. The generated finger tracks are left out on purpose — they are two
// constant keys rebuilt from the Hand-curl sliders on every bake, so pasting them
// would be writing to something that gets overwritten.
//
// Tracks are matched by NAME on paste, so a pose copied from one clip can be pasted
// into another (they are retargeted onto the same rig); anything the target does not
// have is skipped and counted rather than failing the paste.
//
// Unlike a value edit, which applies a DELTA so the neighbouring frames keep their
// own motion, a paste applies the pose ABSOLUTELY: with a falloff, the neighbours are
// blended TOWARDS it (slerp/lerp by the same cosine weights), which is what makes a
// pasted pose arrive without a pop. At weight 1 the frame is exactly the pose — so
// "This frame" pastes it verbatim, and "Whole clip" freezes every frame to it.

export function copyFramePose(clip, frame) {
  const grid = clipGrid(clip)
  if (!grid) return null
  const at = Math.max(0, Math.min(grid.frameCount - 1, Math.round(frame) || 0))
  const tracks = []
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name)
    if (!parsed || track.times.length !== grid.frameCount) continue
    const stride = parsed.kind === 'quaternion' ? 4 : 3
    tracks.push({
      name: track.name,
      kind: parsed.kind,
      values: track.values.slice(at * stride, at * stride + stride),
    })
  }
  return tracks.length ? { frame: at, tracks } : null
}

// Returns { entries, applied, skipped } where `entries` are before/after snapshots
// for the undo stack, one per track actually written.
export function pasteFramePose(clip, pose, frame, {
  scope = DEFAULT_EDIT_SCOPE, span = DEFAULT_EDIT_SPAN,
} = {}) {
  const grid = clipGrid(clip)
  if (!grid || !pose?.tracks?.length) return null
  const at = Math.max(0, Math.min(grid.frameCount - 1, Math.round(frame) || 0))
  const reach = Math.max(1, Math.round(span) || 1)
  const entries = []
  let skipped = 0

  for (const source of pose.tracks) {
    const track = findTrack(clip, source.name)
    const parsed = track ? parseTrackName(track.name) : null
    if (!track || !parsed || parsed.kind !== source.kind || track.times.length !== grid.frameCount) {
      skipped += 1
      continue
    }
    const stride = source.kind === 'quaternion' ? 4 : 3
    const n = Math.floor(track.values.length / stride)
    const before = Float32Array.from(track.values)

    if (source.kind === 'quaternion') {
      _qTarget.fromArray(source.values, 0)
      for (let i = 0; i < n; i++) {
        const w = editWeight(Math.abs(i - at), scope, reach)
        if (w <= 0) continue
        _q.fromArray(track.values, i * 4).slerp(_qTarget, w).normalize()
        _q.toArray(track.values, i * 4)
      }
    } else {
      for (let i = 0; i < n; i++) {
        const w = editWeight(Math.abs(i - at), scope, reach)
        if (w <= 0) continue
        for (let a = 0; a < 3; a++) {
          const o = i * 3 + a
          track.values[o] += (source.values[a] - track.values[o]) * w
        }
      }
    }

    const after = Float32Array.from(track.values)
    // Pasting a pose onto the frame it was copied from changes nothing; do not
    // record an undo entry (or mark the clip edited) for it.
    let changed = false
    for (let i = 0; i < after.length; i++) {
      if (Math.abs(after[i] - before[i]) > 1e-7) { changed = true; break }
    }
    if (changed) entries.push({ trackName: track.name, before, after })
  }

  return entries.length ? { entries, applied: entries.length, skipped } : null
}

// --- Clearing one frame's value --------------------------------------------
// "Delete the value at this frame", on a clip where every frame carries a key: the
// key stops asserting its own value and takes the one interpolation between its
// neighbours would give — which is exactly what deleting the key would look like,
// without making the track sparse (a sparse track leaves the frame grid, and with it
// the whole dock's frame-is-an-index model).
//
// At either end there is only one neighbour, so the value becomes that neighbour's.
// Single frame only, whatever the Apply-to scope says: clearing a frame is the one
// operation whose whole point is that it touches nothing else.
export function clearFrameValue(clip, trackName, frame) {
  const track = findTrack(clip, trackName)
  const parsed = parseTrackName(trackName)
  if (!track || !parsed) return null
  const stride = parsed.kind === 'quaternion' ? 4 : 3
  const n = Math.floor(track.values.length / stride)
  if (n < 2) return null
  const f = Math.max(0, Math.min(n - 1, Math.round(frame) || 0))
  const prev = f > 0 ? f - 1 : null
  const next = f < n - 1 ? f + 1 : null
  if (prev === null && next === null) return null

  const before = Float32Array.from(track.values)
  if (parsed.kind === 'quaternion') {
    if (prev === null || next === null) {
      _q.fromArray(track.values, (prev ?? next) * 4)
    } else {
      _q.fromArray(track.values, prev * 4)
      _qTarget.fromArray(track.values, next * 4)
      _q.slerp(_qTarget, 0.5)   // three's slerp takes the shortest path
    }
    _q.normalize().toArray(track.values, f * 4)
  } else {
    for (let a = 0; a < 3; a++) {
      track.values[f * 3 + a] = (prev === null || next === null)
        ? track.values[(prev ?? next) * 3 + a]
        : (track.values[prev * 3 + a] + track.values[next * 3 + a]) / 2
    }
  }

  let changed = false
  for (let i = f * stride; i < (f + 1) * stride; i++) {
    if (Math.abs(track.values[i] - before[i]) > 1e-7) { changed = true; break }
  }
  if (!changed) return null
  return { before, after: Float32Array.from(track.values) }
}

// Stop a clip animating one bone at all: every key on its tracks takes the bone's
// REST value, so the bone stands where it would if the clip had never touched it.
//
// Why flatten rather than delete the tracks: the dock is built on frame == index,
// and a clip with one track shorter than the rest has no frame grid any more.
// A constant track is also what the user is really asking for — the bone still
// exists, still exports, and the edit is one undo away — whereas a removed track
// would leave the bone frozen at whatever pose the mixer last wrote to it.
//
// `rest` is { rotation: [x,y,z,w], position: [x,y,z] } read off the bind pose by
// the caller (which is the only place that has the skeleton). Either half may be
// missing, in which case that track holds its OWN first frame instead — still a
// bone that does not move, just posed as the clip started.
export function clearBoneAnimation(clip, boneName, rest = null) {
  const description = describeClip(clip)
  const row = description?.bones.find(b => b.boneName === boneName)
  // Off-grid bones (the hand-curl finger tracks) are rebuilt by every bake, so
  // clearing one would be undone by the next toggle.
  if (!row || !row.editable) return null

  const entries = []
  for (const [kind, trackName, stride] of [
    ['rotation', row.rotation, 4],
    ['position', row.position, 3],
  ]) {
    if (!trackName) continue
    const track = findTrack(clip, trackName)
    const n = track ? Math.floor(track.values.length / stride) : 0
    if (!n) continue

    const restValue = rest?.[kind]
    const target = restValue?.length === stride ? restValue : track.values.slice(0, stride)
    const before = Float32Array.from(track.values)
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < stride; a++) track.values[i * stride + a] = target[a]
    }

    let changed = false
    for (let i = 0; i < before.length; i++) {
      if (Math.abs(track.values[i] - before[i]) > 1e-7) { changed = true; break }
    }
    // Already constant: put the exact bytes back so an unchanged track never
    // lands in the history as a no-op entry.
    if (!changed) { track.values.set(before); continue }
    entries.push({ trackName, before, after: Float32Array.from(track.values) })
  }

  return entries.length ? { entries } : null
}


// --- Smoothing the loop seam ------------------------------------------------
// A looping clip plays … f[n-2], f[n-1], then wraps to f[0]. It shakes at the seam
// when that wrap is a bigger step than the clip's own frame-to-frame motion.
//
// Setting the last frame to the midpoint of f[n-2] and f[0] is NOT enough, and it is
// worth being explicit about why: it makes the two steps either side of the wrap
// EQUAL, which fixes a clip that was trimmed near a matching pose, but if f[0] and
// f[n-1] are far apart it just splits one big jump into two equal big jumps. The
// shake survives.
//
// What actually removes it is easing the TAIL into the start pose:
//
//   1. Blend the last `span` frames towards f[0], with a cosine ramp that is 0 at
//      `span` frames back and 1 at the last frame. The clip now approaches its own
//      beginning instead of arriving somewhere else.
//   2. Then pull the last frame back to the midpoint of the (blended) penultimate and
//      f[0], so the wrap step equals the step before it — and so the last frame is not
//      a duplicate of f[0], which would stall the loop for a frame.
//
// The cost is honest and unavoidable: the last `span` frames no longer follow the
// generated motion exactly, they bend towards the start. A bigger span is smoother and
// alters more of the clip. What a single frame cannot do, no setting can.
//
// The one thing NOT blended is TRAVEL. Dragging a walk's forward hip motion towards
// f[0] would slide the character backwards over the tail — so an axis that goes
// somewhere and stays (see axisIsTravel) is left alone and counted in `skipped`.
// Everything that oscillates — every rotation, the body's rise and fall, side-to-side
// sway — is pose, and blends.

// Cosine ramp: 1 at the last frame, 0 `span` frames earlier. One-sided, unlike
// editWeight — there are no frames after the last one to carry half a falloff.
function seamWeight(distance, span) {
  if (distance <= 0) return 1
  if (distance >= span) return 0
  return 0.5 * (1 + Math.cos((Math.PI * distance) / span))
}

// Does this axis carry TRAVEL — motion that goes somewhere and stays — rather than a
// pose that oscillates and happens to end out of phase?
//
// The discriminator is net displacement over total path length, not the size of the
// seam gap. A gap-versus-step test (the first attempt) misread a hip's rise and fall
// as travel as soon as the clip ended mid-cycle, and then refused to smooth exactly
// the axis that pops. This ratio is scale-free and says what it means: a walk that
// covers ground scores ~1 (every step adds to the total AND to the displacement),
// while sway or bob scores near 0 (a long path, no net displacement).
//
// A jump that ends a metre higher than it started also scores ~1, and is also left
// alone — correctly: averaging that Y would drop the character mid-air.
const AXIS_TRAVEL_RATIO = 0.5

function axisIsTravel(values, stride, axis, n) {
  let path = 0
  for (let i = 0; i + 1 < n; i++) {
    path += Math.abs(values[(i + 1) * stride + axis] - values[i * stride + axis])
  }
  if (path <= MIN_POSITION_DELTA) return false
  const displacement = Math.abs(values[(n - 1) * stride + axis] - values[axis])
  return displacement / path > AXIS_TRAVEL_RATIO
}

export function smoothLoopSeam(clip, { span = DEFAULT_EDIT_SPAN } = {}) {
  const grid = clipGrid(clip)
  if (!grid) return null
  const n = grid.frameCount
  if (n < 3) return null
  const last = n - 1
  const reach = Math.max(1, Math.min(n - 2, Math.round(span) || 1))

  const entries = []
  let skipped = 0

  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name)
    if (!parsed || track.times.length !== n) continue      // off-grid: constant, no seam
    const values = track.values
    const before = Float32Array.from(values)

    if (parsed.kind === 'quaternion') {
      // Already no worse than a normal frame-to-frame step? Then this bone does not
      // shake at the seam, and blending it would only flatten its tail. This is also
      // what makes a second click a no-op instead of dragging the tail further into
      // the start pose each time.
      let total = 0
      for (let i = 0; i + 1 < n; i++) {
        _q.fromArray(values, i * 4)
        _qTarget.fromArray(values, (i + 1) * 4)
        total += _q.angleTo(_qTarget)
      }
      const meanStep = total / (n - 1)
      _q.fromArray(values, last * 4)
      _qTarget.fromArray(values, 0)
      if (_q.angleTo(_qTarget) <= meanStep) continue

      _qTarget.fromArray(values, 0)                        // f[0], the pose to arrive at
      for (let j = 0; j <= reach; j++) {
        const i = last - j
        if (i < 0) break
        const w = seamWeight(j, reach)
        if (w <= 0) continue
        _q.fromArray(values, i * 4).slerp(_qTarget, w).normalize()
        _q.toArray(values, i * 4)
      }
      // Step 2: halfway between the blended penultimate and f[0].
      _q.fromArray(values, (n - 2) * 4)
      _qTarget.fromArray(values, 0)
      _q.slerp(_qTarget, 0.5).normalize().toArray(values, last * 4)
    } else {
      for (let a = 0; a < 3; a++) {
        if (axisIsTravel(values, 3, a, n)) { skipped += 1; continue }
        const first = values[a]
        // Same "already smooth" test as the rotations, per axis.
        let total = 0
        for (let i = 0; i + 1 < n; i++) total += Math.abs(values[(i + 1) * 3 + a] - values[i * 3 + a])
        const meanStep = total / (n - 1)
        if (Math.abs(first - values[last * 3 + a]) <= Math.max(meanStep, MIN_POSITION_DELTA)) continue
        for (let j = 0; j <= reach; j++) {
          const i = last - j
          if (i < 0) break
          const w = seamWeight(j, reach)
          if (w <= 0) continue
          const o = i * 3 + a
          values[o] += (first - values[o]) * w
        }
        values[last * 3 + a] = (values[(n - 2) * 3 + a] + first) / 2
      }
    }

    let changed = false
    for (let i = 0; i < values.length; i++) {
      if (Math.abs(values[i] - before[i]) > 1e-7) { changed = true; break }
    }
    if (changed) entries.push({ trackName: track.name, before, after: Float32Array.from(values) })
  }

  return entries.length ? { entries, applied: entries.length, skipped } : null
}
