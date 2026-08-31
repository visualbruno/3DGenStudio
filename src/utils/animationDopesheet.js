// What a dopesheet row should DRAW for a retargeted clip.
//
// The honest fact about these clips (see animationEdit.js): `retargetAnimationClip`
// bakes on a uniform grid — one key on every frame of every animated track. So a
// Unity-style "diamond where a key exists" sheet would be a solid wall of diamonds
// on every animated bone, which tells you nothing beyond "this bone is animated".
//
// What is actually worth seeing is MOTION: the frames where a bone's value changes
// from the frame before it. That turns the wall into runs — "the left arm only does
// something between frames 20 and 50" — which is the question the sheet exists to
// answer. `mode: 'keys'` is still available and draws the literal keys.
//
// Off-grid tracks (the 2-key constant finger tracks `withHandPose` appends) have
// nothing to diff, so they always draw their real, sparse keys and are marked
// locked — the same tracks `describeClip` reports as `editable: false`.
import { parseTrackName } from './animationEdit'

// Thresholds for "this frame is different from the one before it". Both are above
// the noise floor of a float32 track and far below anything visible: 0.15° of
// rotation, and 1e-4 units of translation on a mesh a couple of units tall.
export const ACTIVE_ROTATION_DEG = 0.15
export const ACTIVE_POSITION_EPS = 1e-4

const ACTIVE_DOT = Math.cos((ACTIVE_ROTATION_DEG * Math.PI) / 360)   // half-angle

// Per-track: where the value changes, and whether the track moves at all.
//
// `active[f]` is 1 when frame f is part of a moving span — it differs from f-1 OR
// from f+1. Marking only "differs from the previous frame" would leave the first
// frame of a movement blank, so a run would appear to start one frame late.
function analyseTrack(track, kind, frameCount) {
  const stride = kind === 'quaternion' ? 4 : 3
  const n = Math.floor(track.values.length / stride)
  const onGrid = n === frameCount && frameCount > 1

  if (!onGrid) {
    // Sparse / off-grid: no frame-to-frame diff to take. Its keys are the truth.
    return { kind, stride, onGrid: false, keyCount: track.times.length, active: null, moving: false }
  }

  const values = track.values
  const changed = new Uint8Array(n)
  for (let f = 1; f < n; f++) {
    if (kind === 'quaternion') {
      const i = f * 4
      const j = i - 4
      const dot = Math.abs(
        values[i] * values[j] + values[i + 1] * values[j + 1] +
        values[i + 2] * values[j + 2] + values[i + 3] * values[j + 3],
      )
      if (dot < ACTIVE_DOT) changed[f] = 1
    } else {
      const i = f * 3
      const j = i - 3
      if (Math.abs(values[i] - values[j]) > ACTIVE_POSITION_EPS ||
          Math.abs(values[i + 1] - values[j + 1]) > ACTIVE_POSITION_EPS ||
          Math.abs(values[i + 2] - values[j + 2]) > ACTIVE_POSITION_EPS) changed[f] = 1
    }
  }

  const active = new Uint8Array(n)
  let moving = false
  for (let f = 0; f < n; f++) {
    if (changed[f] || (f + 1 < n && changed[f + 1])) { active[f] = 1; moving = true }
  }
  return { kind, stride, onGrid: true, keyCount: n, active, moving }
}

// Frames that carry a literal key, for an off-grid track. The grid is uniform, so
// nearest-frame is just a division — no key search.
function keyFrames(track, description) {
  const { frameCount, duration } = description
  const dt = frameCount > 1 ? duration / (frameCount - 1) : 0
  const marks = new Uint8Array(frameCount)
  if (dt <= 0) return marks
  for (const t of track.times) {
    const f = Math.round(t / dt)
    if (f >= 0 && f < frameCount) marks[f] = 1
  }
  return marks
}

// One pass over the clip: an entry per track, plus a per-bone union so a collapsed
// bone row can be drawn without touching its tracks again.
//
// Cheap enough to redo whenever the clip revision moves (a few hundred thousand
// float compares), which is what keeps the sheet honest during an edit.
export function buildDopesheet(clip, description) {
  if (!clip?.tracks?.length || !description) return null
  const { frameCount } = description

  const tracks = new Map()
  const bones = new Map()
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name)
    if (!parsed) continue
    const entry = analyseTrack(track, parsed.kind, frameCount)
    entry.trackName = track.name
    entry.boneName = parsed.boneName
    entry.keys = entry.onGrid ? null : keyFrames(track, description)
    tracks.set(track.name, entry)

    let bone = bones.get(parsed.boneName)
    if (!bone) {
      bone = { boneName: parsed.boneName, active: new Uint8Array(frameCount), keys: null, moving: false, locked: false }
      bones.set(parsed.boneName, bone)
    }
    if (entry.active) {
      for (let f = 0; f < frameCount; f++) if (entry.active[f]) bone.active[f] = 1
      bone.moving = bone.moving || entry.moving
    }
    if (entry.keys) {
      if (!bone.keys) bone.keys = new Uint8Array(frameCount)
      for (let f = 0; f < frameCount; f++) if (entry.keys[f]) bone.keys[f] = 1
      bone.locked = true
    }
  }

  return { frameCount, tracks, bones }
}

// Contiguous runs of 1s, as [start, end] pairs (end inclusive). The sheet draws a
// run as one shape when the zoom is too tight for per-frame diamonds.
export function activeRuns(mask, from = 0, to = mask ? mask.length - 1 : 0) {
  if (!mask) return []
  const runs = []
  let start = -1
  const end = Math.min(to, mask.length - 1)
  for (let f = Math.max(0, from); f <= end; f++) {
    if (mask[f]) { if (start < 0) start = f }
    else if (start >= 0) { runs.push([start, f - 1]); start = -1 }
  }
  if (start >= 0) runs.push([start, end])
  return runs
}
