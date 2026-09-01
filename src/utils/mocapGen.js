// Video-to-motion (MoCapAnything V2) support for the mesh-editor Auto Rig panel.
//
// The service (thirdparty/mocapanything/mocap_server.py) turns a video of a
// moving subject into a BVH clip. What makes this different from Kimodo is WHOSE
// skeleton comes back: MoCapAnything is conditioned on the target rig, so the
// BVH carries the user's OWN joint names, hierarchy and rest offsets. There is
// no cross-skeleton table to write and no mapping for the user to get wrong —
// the bone map is the identity.
//
// It still goes through `retargetAnimationClip` rather than binding the clip
// straight onto the mesh, for one reason: the per-rig bake yaws the character to
// face +Z, so the BVH's rest pose can differ from the mesh's by that yaw.
// Retargeting measures both rest poses and cancels it; direct binding would
// silently rotate the character. Reusing that path also means the preview,
// the frame editor and Save-as-version work unchanged.
//
// Two-step by nature, and the UI has to show it: a video can only drive a rig
// that has been BAKED first (skeleton topology, joint-name embeddings, a
// reference pose, a rendered view). The bake needs Blender, takes minutes, and
// is cached by mesh content hash — once per rig, not once per clip.
import { Group, Quaternion } from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { API_BASE } from '../config'
import { detectHipBone } from './animationLibrary'
import { readSseStream } from './meshTools'

// MoCap occupies the same single "source rig" slot as a mesh2motion reference or
// Kimodo, so it needs an id that cannot collide with either.
export const MOCAP_SOURCE_ID = 'mocap'

// The model runs one forward pass over the whole clip with no chunking, so VRAM
// scales with length: ~2 GB of weights plus ~16 MiB per frame (measured), and
// the upstream code caps the sequence at 301 frames and silently truncates past
// it. Exposed so the panel can hold the user's chosen length inside what the
// model accepts, rather than letting a long clip OOM or truncate unannounced.
export const MOCAP_MAX_FRAMES = 301
export const MOCAP_MIN_FRAMES = 32

// What the user asks for is a LENGTH; what the service takes is a frame count.
// The two are only related by the video's own frame rate, because the pipeline
// extracts every frame of the clip (no resampling) and then keeps the first
// `maxFrames` of them. So seconds cannot be converted without the video —
// `detectVideoFps` measures it, and this is what stands in until then.
export const MOCAP_ASSUMED_FPS = 30
export const MOCAP_DEFAULT_SECONDS = 5

// Reserved VRAM against capture length, measured on the shipped checkpoint:
// 6.5 GB at 100 frames, 9 GB at 200, 10.5 GB at 301. Not a formula because the
// curve is not one — it is one forward pass over the whole clip, and the growth
// per frame flattens as the attention buffers stop being the peak. Between the
// anchors it interpolates; below 100 it follows the first segment's slope down
// to the floor, which is the weights plus the DINOv2/T5 encoders — resident
// whatever the length.
const MOCAP_VRAM_ANCHORS = [[100, 6.5], [200, 9.0], [301, 10.5]]
const MOCAP_VRAM_FLOOR = 4.5

// Estimated peak VRAM, in GB, for a capture of `frames` frames.
export function estimateMocapVram(frames) {
  const f = Number(frames) || 0
  let i = 0
  while (i < MOCAP_VRAM_ANCHORS.length - 2 && f > MOCAP_VRAM_ANCHORS[i + 1][0]) i += 1
  const [f0, g0] = MOCAP_VRAM_ANCHORS[i]
  const [f1, g1] = MOCAP_VRAM_ANCHORS[i + 1]
  return Math.max(MOCAP_VRAM_FLOOR, g0 + (f - f0) * ((g1 - g0) / (f1 - f0)))
}

// Seconds -> the frame count to send, clamped to what the model accepts. The
// clamp is here rather than in the field so the user can type freely (and see
// what the cap costs them) instead of having the value snatched mid-keystroke.
export function mocapFramesForSeconds(seconds, fps = MOCAP_ASSUMED_FPS) {
  const rate = Number(fps) > 0 ? Number(fps) : MOCAP_ASSUMED_FPS
  const frames = Math.round((Number(seconds) || 0) * rate)
  return Math.max(MOCAP_MIN_FRAMES, Math.min(MOCAP_MAX_FRAMES, frames))
}

// The longest capture the model can take from a video at this frame rate.
export function mocapMaxSeconds(fps = MOCAP_ASSUMED_FPS) {
  const rate = Number(fps) > 0 ? Number(fps) : MOCAP_ASSUMED_FPS
  return MOCAP_MAX_FRAMES / rate
}

// Frame rates worth snapping a measurement to. A median over a handful of
// samples lands a hair off the real rate (29.97 reads as 30.03), and showing
// "29.7 fps" would look like a property of the file rather than of our sampling.
const MOCAP_STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 120]

function medianFps(mediaTimes) {
  const gaps = []
  for (let i = 1; i < mediaTimes.length; i += 1) {
    const gap = mediaTimes[i] - mediaTimes[i - 1]
    // A callback can fire twice for one presented frame; a zero gap is not a rate.
    if (gap > 1e-4) gaps.push(gap)
  }
  if (gaps.length < 3) return null
  gaps.sort((a, b) => a - b)
  const raw = 1 / gaps[Math.floor(gaps.length / 2)]
  if (!Number.isFinite(raw) || raw <= 0) return null
  const standard = MOCAP_STANDARD_FPS.find(f => Math.abs(f - raw) / f < 0.04)
  return standard || Math.round(raw * 100) / 100
}

// Measure a video's frame rate and duration in the browser.
//
// There is no fps on HTMLVideoElement, and the container does not have to carry
// one either, so the only honest way to get it is to watch frames arrive: play
// the opening moments muted and take the median gap between presented frames.
// Costs about a second and never throws — a null fps means "assume the default
// and say so", which is strictly better than silently promising a length the
// clip will not deliver.
export async function detectVideoFps(file, { samples = 16, timeoutMs = 6000 } = {}) {
  if (!file || typeof document === 'undefined') return { fps: null, duration: null }

  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')) }, timeoutMs)
      const ok = () => { cleanup(); resolve() }
      const fail = () => { cleanup(); reject(new Error('unreadable')) }
      function cleanup() {
        clearTimeout(timer)
        video.removeEventListener('loadedmetadata', ok)
        video.removeEventListener('error', fail)
      }
      video.addEventListener('loadedmetadata', ok)
      video.addEventListener('error', fail)
    })

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
    if (typeof video.requestVideoFrameCallback !== 'function') return { fps: null, duration }

    const times = []
    const fps = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(medianFps(times)), timeoutMs)
      const finish = value => { clearTimeout(timer); resolve(value) }
      const onFrame = (_now, meta) => {
        times.push(meta.mediaTime)
        if (times.length > samples) { finish(medianFps(times)); return }
        video.requestVideoFrameCallback(onFrame)
      }
      video.requestVideoFrameCallback(onFrame)
      // Muted playback is allowed without a gesture; if it is refused anyway,
      // no frames are ever presented, so give up rather than wait out the timer.
      video.play().catch(() => finish(null))
    })
    return { fps, duration }
  } catch {
    return { fps: null, duration: null }
  } finally {
    try { video.pause() } catch { /* already torn down */ }
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

// NOTE: unlike the mesh/rigging/motion services, this one is not yet managed by
// the desktop app (electron/main.cjs provisions a venv per service, and MoCap
// needs its own plus a MoCapAnything checkout). Until that exists the service is
// started by hand, so there is no ensureDesktopService() call here — a missing
// service surfaces as a plain "could not reach" error from the proxy, which is
// accurate, rather than as a failed auto-start.
const MOCAP_BASE = `${API_BASE}/mocap`

// --- BVH -> the shapes the retargeter expects --------------------------------

const bvhLoader = new BVHLoader()

// Same construction as motionGen's Kimodo source, and for the same reason:
// BVHLoader never updates world matrices, so a Skeleton built from its bones
// computes every bind inverse from an identity matrix. That makes Skeleton.pose()
// collapse the rig onto the origin and turns the retarget into garbage.
// Recomputing the inverses once the hierarchy has real world matrices is what
// makes pose() restore the BVH rest pose.
function bvhToSource(bvhText) {
  const { skeleton, clip } = bvhLoader.parse(bvhText)
  const root = skeleton.bones[0]
  if (!root) throw new Error('The generated motion has no skeleton.')

  const scene = new Group()
  scene.name = 'mocap-source'
  scene.add(root)
  scene.updateMatrixWorld(true)
  skeleton.calculateInverses()

  // Unlike Kimodo there is no subset to filter down to: every bone in this BVH
  // is a bone of the user's own rig, and the model drove all of them.
  const boneNames = skeleton.bones.map(b => b.name)

  // No clips. Kimodo's source BVH is a REST POSE, so the clip the loader builds
  // from it is a throwaway; ours is the capture itself, so keeping it here would
  // put the same motion in the gallery twice — once under BVHLoader's default
  // name ("animation") and once under the name we give it.
  void clip
  return {
    scene,
    skinnedMesh: { skeleton },
    boneNames,
    hipName: detectHipBone(boneNames),
    clips: [],
  }
}

// Keep the root bone's HEADING and throw away its TILT.
//
// The model puts the character's whole global orientation on the root bone, and
// it gets that orientation wrong in a specific, measurable way. On a boar walking
// in profile the root came back with a rotation of 90.7 deg +/- 4.3, which splits
// into two very different parts:
//
//   heading (yaw about Y) : +78 deg, near-constant
//   tilt (everything else): +44 deg, near-constant
//
// The heading is legitimate — it is how far the animal in the video is turned
// from the reference view the rig was baked against (head-on), so a profile clip
// SHOULD read ~90 deg. The tilt is pure error: it pitches the character nose-down
// through the floor, and because every other bone hangs off the root it takes the
// entire mesh with it. That is the "it rotated the whole mesh around the Hips"
// failure — and it hides the fact that the rest of the capture is fine. Measured
// on the same clip, with the root's rotation cancelled, every other bone sits
// within 5 deg of its rest direction and the legs carry 255 deg of real walk.
//
// So: reduce the root to its twist about +Y (the w and y components of the
// quaternion, which is exactly the yaw), then subtract the first frame's heading
// so the character starts facing its own forward instead of at an angle inherited
// from where the reference camera happened to be. Genuine turning DURING the clip
// survives, because only the constant part is removed.
//
// Verified on LTX_2.5_t2v_00002: tilt 44.07 -> 0.00 deg, head height -0.89 ->
// -0.31 (rest pose is -0.30), lowest foot -1.25 -> -0.99 (rest is -0.94).
function uprightRootRotation(clip, rootName) {
  // BVHLoader names its tracks after the NODE ("Hips.quaternion"). The
  // ".bones[Hips].quaternion" form is what retargetAnimationClip writes for
  // playback against a SkinnedMesh, so accept either and this keeps working
  // wherever it is called from.
  const track = clip.tracks.find(t =>
    t.name === `${rootName}.quaternion` || t.name === `.bones[${rootName}].quaternion`)
  if (!track) return 0

  const q = new Quaternion()
  const first = new Quaternion()
  const count = Math.floor(track.values.length / 4)
  let maxTilt = 0

  for (let i = 0; i < count; i += 1) {
    q.fromArray(track.values, i * 4)

    // How far this rotation tips the character, reported so the caller can say
    // whether it actually did anything.
    const up = 1 - 2 * (q.x * q.x + q.z * q.z)      // (q * +Y).y
    maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, Math.max(-1, up))))

    // Twist about +Y. A 180 deg rotation about an axis in the XZ plane leaves
    // w and y both zero and has no meaningful heading — fall back to identity
    // rather than normalising a zero vector.
    const n = Math.hypot(q.w, q.y)
    if (n < 1e-6) q.set(0, 0, 0, 1)
    else q.set(0, q.y / n, 0, q.w / n)

    if (i === 0) first.copy(q).invert()
    q.premultiply(first).normalize()
    q.toArray(track.values, i * 4)
  }
  return (maxTilt * 180) / Math.PI
}

function bvhToClip(bvhText, name) {
  const { clip, skeleton } = bvhLoader.parse(bvhText)
  if (!clip) throw new Error('The motion could not be parsed.')
  clip.name = name || 'mocap'

  // Drop the root's POSITION track. MoCapAnything zeroes root translation
  // (utils/npy2bvh.py writes np.zeros), so BVHLoader produces a track whose
  // value is constant and equal to the source rig's rest offset — no motion at
  // all, just an absolute hip height in the baked rig's units. Retargeting that
  // onto the mesh plants its hips at that height and the character floats above
  // the ground. Removing it leaves the mesh standing at its own rest position,
  // which is exactly what an in-place clip should do.
  clip.tracks = clip.tracks.filter(t => !t.name.endsWith('.position'))
  if (!clip.tracks.length) throw new Error('The capture contains no rotation data.')

  // Has to come after the position filter but before the clip leaves here: the
  // retarget is a delta against the source bind pose, so a root fixed on the
  // SOURCE clip is a root fixed on the mesh, the preview, the frame editor and
  // the exported GLB alike.
  const rootName = skeleton?.bones?.[0]?.name
  if (rootName) {
    const tilt = uprightRootRotation(clip, rootName)
    clip.userData = { ...(clip.userData || {}), rootTiltRemoved: Math.round(tilt) }
  }
  return clip
}

// Bone chains the capture can be limited to.
//
// This exists because of what the model actually does. It regresses joint
// POSITIONS and then solves rotations anchored on the reference pose, over
// every joint at once, trained on animal and object motion where the whole body
// moves together. It has no notion of "this limb is holding still", so filming
// only your arms still produces small leg motion, and global orientation error
// concentrates in the root — which swings the whole body to place a hand.
//
// Which joints are even ALLOWED to move is fixed at Prepare time (a joint whose
// speed never exceeds STATIC_EPS in the reference is marked static and locked),
// so it cannot be changed per capture. Filtering the mapping can: a chain left
// out is simply not driven and holds its rest pose. Cheap, reversible, and it
// applies to captures already taken.
export const MOCAP_BONE_GROUPS = [
  // The root's TILT is always removed (see uprightRootRotation) — a capture that
  // tips the character over is never what you want. This switch is about the
  // heading that survives that: on, the body turns as the model read it from the
  // video; off, the root is left at rest and only the limbs move.
  { id: 'root', label: 'Body turn', hint: 'The root bone. Off keeps the body from turning at all.' },
  { id: 'spine', label: 'Spine', hint: 'Torso bend and twist.' },
  { id: 'head', label: 'Head & neck', hint: null },
  { id: 'arms', label: 'Arms', hint: null },
  // Always locked by the model in practice, so this switch is a no-op today; it
  // exists because whether a joint MAY move is decided when the rig is prepared,
  // and a different reference could unlock them. Finger POSE comes from the hand
  // curl sliders instead.
  { id: 'hands', label: 'Fingers', hint: 'Not captured — use the Hands sliders below.' },
  { id: 'legs', label: 'Legs', hint: 'Turn off when the subject never moves their legs.' },
  { id: 'feet', label: 'Feet', hint: null },
]

// Order matters, and plain substring tests are used deliberately: rig names are
// concatenated ("mixamorigLeftLeg"), so a word-boundary guard would never fire.
// Fingers must be tested before hands/arms, and feet before legs, or the looser
// test swallows them.
export function mocapBoneGroup(name) {
  const l = String(name || '').toLowerCase()
  if (/index|middle|pinky|ring|thumb|finger/.test(l)) return 'hands'
  if (/toe|ball|ankle|foot/.test(l)) return 'feet'
  if (/upleg|thigh|shin|calf|knee|leg/.test(l)) return 'legs'
  if (/forearm|elbow|shoulder|clavicle|arm|hand|wrist/.test(l)) return 'arms'
  if (/neck|head|skull|jaw|eye/.test(l)) return 'head'
  if (/hips|pelvis|root/.test(l)) return 'root'
  if (/spine|chest|torso|abdomen|belly/.test(l)) return 'spine'
  return 'spine'
}

// The mapping is the identity: the service returned OUR bone names. Anything the
// target does not have is dropped rather than guessed — a bone the bake renamed
// is better left undriven than bound to the wrong joint. `groups`, when given,
// limits it to those chains.
export function mocapIdentityMapping(sourceNames, targetNames, groups = null) {
  const target = new Set(targetNames || [])
  const allowed = groups ? new Set(groups) : null
  const mapping = {}
  for (const name of sourceNames || []) {
    if (!target.has(name)) continue
    if (allowed && !allowed.has(mocapBoneGroup(name))) continue
    mapping[name] = name
  }
  return mapping
}

// A stable identity for "which skeleton is this". The bake is cached against it
// rather than against the GLB bytes: the page re-exports the mesh on every
// check, and glTF export is not guaranteed byte-identical run to run, so a byte
// hash would miss its own cache every time and re-bake a rig already on disk.
// Offsets are rounded because a re-export can differ in the last float bits
// without the skeleton having changed at all.
export function mocapRigKey(skeleton) {
  if (!skeleton?.names?.length) return ''
  const parents = skeleton.parents || []
  const joints = skeleton.joints || null      // flat Float32Array, 3 per bone
  const r = v => (Number(v) || 0).toFixed(3)
  return skeleton.names.map((name, i) => {
    const p = parents[i] ?? -1
    if (!joints) return `${name}:${p}`
    return `${name}:${p}:${r(joints[i * 3])},${r(joints[i * 3 + 1])},${r(joints[i * 3 + 2])}`
  }).join('|')
}

// --- service --------------------------------------------------------------

async function readError(response, fallback) {
  let message = fallback
  try {
    const payload = await response.json()
    message = payload.detail ? `${payload.error}: ${payload.detail}` : (payload.error || message)
  } catch { /* non-JSON body — keep the status message */ }
  return new Error(message)
}

export async function fetchMocapServiceHealth() {
  try {
    const response = await fetch(`${MOCAP_BASE}/health`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, ...payload }
    return { ok: true, ...payload }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not reach the video-to-motion service.' }
  }
}

// Cheap probe: hashes the mesh bytes server-side and says whether that exact rig
// is already baked. No GPU, no Blender. Lets the panel open in the right state
// instead of making the user press Prepare to find out.
export async function inspectMocapRig(meshBlob, rigKey = '') {
  const form = new FormData()
  form.append('meshFile', meshBlob, 'mesh.glb')
  if (rigKey) form.append('rigKey', rigKey)
  const response = await fetch(`${MOCAP_BASE}/inspect`, { method: 'POST', body: form })
  if (!response.ok) throw await readError(response, `Could not check the rig (${response.status})`)
  return response.json()
}

export async function prepareMocapRig({ meshBlob, rigName = 'rig', rigKey = '', onProgress = null } = {}) {
  if (!meshBlob) throw new Error('No rigged mesh to prepare.')
  const form = new FormData()
  form.append('meshFile', meshBlob, 'mesh.glb')
  form.append('rigName', rigName)
  if (rigKey) form.append('rigKey', rigKey)

  const response = await fetch(`${MOCAP_BASE}/prepare`, { method: 'POST', body: form })
  if (!response.ok) throw await readError(response, `Preparing the rig failed (${response.status})`)

  const data = await readSseStream(response, onProgress)
  if (!data.rig_id) throw new Error('The service finished without preparing the rig.')
  return data
}

export async function generateMocapClip({
  videoFile,
  rigId,
  maxFrames = MOCAP_MAX_FRAMES,
  name,
  onProgress = null,
} = {}) {
  if (!videoFile) throw new Error('Choose a video first.')
  if (!rigId) throw new Error('Prepare this rig before generating motion from a video.')
  const form = new FormData()
  form.append('videoFile', videoFile, videoFile.name || 'clip.mp4')
  form.append('rigId', rigId)
  form.append('maxFrames', String(Math.min(MOCAP_MAX_FRAMES, Math.max(MOCAP_MIN_FRAMES, Number(maxFrames) || MOCAP_MAX_FRAMES))))

  const response = await fetch(`${MOCAP_BASE}/generate`, { method: 'POST', body: form })
  if (!response.ok) throw await readError(response, `Video to motion failed (${response.status})`)

  const data = await readSseStream(response, onProgress)
  if (!data.bvh) throw new Error('The service finished without returning a clip.')

  const label = name || (videoFile.name || 'clip').replace(/\.[^.]+$/, '').slice(0, 40)
  const clip = bvhToClip(data.bvh, label)
  return {
    clip,
    source: bvhToSource(data.bvh),
    bvh: data.bvh,
    // Reported alongside the service's own numbers because it is a correction the
    // user cannot otherwise see: a capture that came back tipped over now looks
    // fine, and they should know why rather than assume the model did it right.
    stats: { ...(data.stats || {}), rootTiltRemoved: clip.userData?.rootTiltRemoved ?? 0 },
  }
}

export async function forgetMocapRig(rigId) {
  if (!rigId) return
  await fetch(`${MOCAP_BASE}/rigs/${encodeURIComponent(rigId)}`, { method: 'DELETE' })
}
