// Text-to-motion (NVIDIA Kimodo) support for the mesh-editor Auto Rig panel.
//
// The service (thirdparty/kimodo/motion_server.py) turns a prompt into a BVH clip
// on the 77-joint SOMA skeleton. This module turns that BVH into the same shape
// `loadReferenceScene` produces for the mesh2motion GLB references, so a generated
// motion goes through the EXACT SAME path as a library clip: bone-mapping modal,
// `retargetAnimationClip`, preview, and save-as-version. Nothing about retargeting
// is Kimodo-specific.
//
// Why BVH and not GLB: three's BVHLoader gives us a Skeleton plus an AnimationClip
// whose tracks are already named "BoneName.quaternion" — the same node-name binding
// the glTF path uses — so no conversion, no Blender round-trip, and the payload is
// a few hundred KB of text.
import { Group } from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { API_BASE } from '../config'
import { detectHipBone, uprightRootRotation } from './animationLibrary'
import { ensureDesktopService, readSseStream } from './meshTools'

// Kimodo occupies the same single "source rig" slot as a mesh2motion reference,
// so it needs an id that cannot collide with one.
export const KIMODO_SOURCE_ID = 'kimodo'

// Which generator a saved motion came from — mirrors the Motions.source column.
// The library is shared, and the two sources need different treatment on the way
// back OUT of it (see loadSavedMotionClip), so this has to be recorded at save
// time. 'kimodo' is the default because it is the only value rows written before
// MoCap joined the library can have.
export const MOTION_SOURCE_KIMODO = 'kimodo'
export const MOTION_SOURCE_MOCAP = 'mocap'

// The joints Kimodo ACTUALLY animates. Its checkpoint denoises the compact
// 30-joint SOMA skeleton and expands the result to 77 for output, filling the
// finger chains from a fixed relaxed-hand rest pose — so every bone below the
// wrists is constant. Mapping those would drag the user's fingers into Kimodo's
// relaxed pose and hold them there; leaving them out lets the target rig keep its
// own hands. Jaw and eyes are dropped for the same reason (driven in name only,
// and meaningless on a game rig).
export const KIMODO_BODY_BONES = [
  'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase',
  'RightLeg', 'RightShin', 'RightFoot', 'RightToeBase',
]

// The exact SOMA-77 → Mixamo bone table and the fuzzy-match aliases that go with
// it live in animationLibrary.js, beside the mesh2motion table autoMapBones
// already consults — keeping them together avoids an import cycle and keeps all
// the bone-naming knowledge in one file.

export const KIMODO_MAX_DURATION = 10
export const KIMODO_MIN_DURATION = 0.5

const bvhLoader = new BVHLoader()

// Parse a BVH into the { scene, skinnedMesh, boneNames, hipName } shape the
// retargeter expects.
//
// `skinnedMesh` is a bare { skeleton } stand-in: retargetAnimationClip only ever
// reads `.skeleton` off it, and a BVH has no mesh to skin. The bones go under a
// Group because the retargeter calls `sourceScene.updateMatrixWorld(true)` to
// refresh bone world matrices each sampled frame, and needs a root to call it on.
function bvhToSource(bvhText) {
  const { skeleton, clip } = bvhLoader.parse(bvhText)
  const root = skeleton.bones[0]
  if (!root) throw new Error('The generated motion has no skeleton.')

  const scene = new Group()
  scene.name = 'kimodo-source'
  scene.add(root)
  scene.updateMatrixWorld(true)

  // BVHLoader builds the bones by setting bone.position and never updating world
  // matrices, so `new Skeleton(bones)` computes every bind inverse from an
  // identity matrixWorld. That makes Skeleton.pose() — which the retargeter calls
  // to read both rigs' bind orientations — collapse the whole skeleton onto the
  // origin, silently turning every bind quaternion into identity and the retarget
  // into garbage. Recomputing the inverses now that the hierarchy has real world
  // matrices makes pose() restore the BVH rest pose, which is what it must be.
  skeleton.calculateInverses()

  const allBones = skeleton.bones.map(b => b.name)
  // Only offer the bones Kimodo drives. The skeleton keeps all 77 joints (the
  // FK chain needs them); this is purely what the mapping UI and auto-map see.
  const animated = new Set(KIMODO_BODY_BONES)
  const boneNames = allBones.filter(name => animated.has(name))

  return {
    scene,
    skinnedMesh: { skeleton },
    boneNames: boneNames.length ? boneNames : allBones,
    hipName: detectHipBone(boneNames.length ? boneNames : allBones),
    clips: clip ? [clip] : [],
  }
}

// Parse a BVH into a named AnimationClip. The skeleton it also yields is
// discarded on purpose: every Kimodo clip uses the same hierarchy and rest
// offsets, so the clip binds by bone name against whichever source scene is
// already loaded — which is what lets a saved motion drop into a session that
// generated its source rig minutes ago, and what keeps the user's bone mapping
// alive across generations.
function bvhToClip(bvhText, name, { upright = false } = {}) {
  const { clip, skeleton } = bvhLoader.parse(bvhText)
  if (!clip) throw new Error('The motion could not be parsed.')
  clip.name = name || 'motion'
  // `upright` is only ever set for a MoCap capture, whose root carries a bogus
  // body tilt. A Kimodo clip's root tilt is real motion ("lie down"), so the
  // default has to be off.
  const rootName = upright ? skeleton?.bones?.[0]?.name : null
  if (rootName) {
    const tilt = uprightRootRotation(clip, rootName)
    clip.userData = { ...(clip.userData || {}), rootTiltRemoved: Math.round(tilt) }
  }
  return clip
}

// The SOMA-77 skeleton standing at rest, so bone mapping can be done before any
// clip exists. Built by the service from the skeleton asset alone — no model load
// — and, crucially, through the same rest-pose path generated clips use, so the
// deltas the retargeter measures line up.
export async function loadKimodoSkeletonSource() {
  // Desktop: the motion service is started on demand, and this is usually the
  // first thing that touches it (opening the Kimodo tab, before any prompt).
  // No-op in the browser, where the service is launched externally.
  await ensureDesktopService('motion')
  const response = await fetch(`${API_BASE}/motions/skeleton`)
  if (!response.ok) {
    let message = `Could not load the Kimodo skeleton (${response.status})`
    try {
      const payload = await response.json()
      message = payload.error || message
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message)
  }
  const { bvh } = await response.json()
  if (!bvh) throw new Error('The motion service returned no skeleton.')
  const source = bvhToSource(bvh)
  // The rest pose is a two-frame placeholder, not something to offer as a clip.
  source.clips = []
  return source
}

export async function fetchMotionServiceHealth() {
  try {
    const response = await fetch(`${API_BASE}/motions/health`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: body.error || `Service returned ${response.status}` }
    return { ok: true, ...body }
  } catch {
    return { ok: false, error: 'Could not reach the motion service.' }
  }
}

// Generate one clip. Returns { clip, stats } where `clip` is a THREE.AnimationClip
// named `name`, ready to be appended to an existing Kimodo source's clip list.
//
// The skeleton parsed out of this BVH is discarded: every generation uses the same
// hierarchy and rest offsets, so the clip binds by bone name against whichever
// source scene is already loaded, and the user's bone mapping survives across
// generations.
//
// Always TRAVELLING: the service can bake the in-place conversion itself, but that
// bakes it into the BVH we then store, making the choice permanent and per-motion.
// `makeClipInPlace` does the same job on the clip at bake time instead, so the
// stored motion stays the canonical travelling one and the toggle is reversible.
export async function generateMotionClip({
  prompt,
  duration = 5,
  seed = null,
  diffusionSteps = 100,
  postprocess = true,
  name,
  onProgress = null,
} = {}) {
  const text = String(prompt || '').trim()
  if (!text) throw new Error('Enter a prompt describing the motion.')

  // Cheap when it is already running, and the only thing that makes "generate"
  // work on a desktop session where the service was never started.
  await ensureDesktopService('motion')

  const response = await fetch(`${API_BASE}/motions/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: text,
      duration: Math.min(KIMODO_MAX_DURATION, Math.max(KIMODO_MIN_DURATION, Number(duration) || 5)),
      in_place: false,
      seed: Number.isFinite(seed) ? seed : null,
      diffusion_steps: Number(diffusionSteps) || 100,
      postprocess: !!postprocess,
    }),
  })

  if (!response.ok) {
    let message = `Motion generation failed (${response.status})`
    try {
      const payload = await response.json()
      message = payload.detail ? `${payload.error}: ${payload.detail}` : (payload.error || message)
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message)
  }

  const data = await readSseStream(response, onProgress)
  if (!data.bvh) throw new Error('The motion service finished without returning a clip.')

  const clip = bvhToClip(data.bvh, name || text.slice(0, 40))

  return { clip, stats: data.stats?.tool || null, bvh: data.bvh }
}

// --- Saved motion library ---------------------------------------------------
// Generated clips are persisted server-side as their BVH (see the Motions table)
// so they outlive the page and can be retargeted onto a different mesh later.
// The library is global rather than per-project: a motion describes a body, not
// a project's content.
//
// None of this touches the Kimodo service — a saved motion is applied without the
// GPU, the checkpoint or the text encoder being involved at all.

const LIBRARY_BASE = `${API_BASE}/motions/library`

async function libraryJson(response, fallback) {
  if (!response.ok) {
    let message = `${fallback} (${response.status})`
    try {
      const payload = await response.json()
      message = payload.error || message
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message)
  }
  return response.json()
}

// Catalogue only — prompt, duration, date. The BVH is fetched on apply.
export async function listSavedMotions() {
  const body = await libraryJson(await fetch(LIBRARY_BASE), 'Could not load the saved motions')
  return body.motions || []
}

// `inPlace` records that the BVH ITSELF was baked in place, which only motions
// saved before the conversion became a bake-time post-process ever are. New saves
// leave it false: the stored motion travels, and in-place is applied on apply.
export async function saveMotion({
  name, prompt, bvh, inPlace = false, seed = null, source = MOTION_SOURCE_KIMODO,
} = {}) {
  const body = await libraryJson(
    await fetch(LIBRARY_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, prompt, bvh, inPlace, seed, source }),
    }),
    'Could not save the motion',
  )
  return body.motion
}

export async function renameSavedMotion(id, name) {
  const body = await libraryJson(
    await fetch(`${LIBRARY_BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    'Could not rename the motion',
  )
  return body.motion
}

export async function deleteSavedMotion(id) {
  await libraryJson(
    await fetch(`${LIBRARY_BASE}/${id}`, { method: 'DELETE' }),
    'Could not delete the motion',
  )
}

// Turn a saved motion back into an AnimationClip, ready to append to the source's
// clip list exactly as a fresh generation would be.
//
// What is stored is the RAW BVH the generator returned, so any correction a fresh
// capture gets has to be re-applied here or a library motion is subtly worse than
// the one the user saved. For MoCap that correction is the root tilt — hence the
// `source` column: it is the only thing that says whether this clip's root
// orientation can be trusted.
export async function loadSavedMotionClip(motion) {
  const body = await libraryJson(
    await fetch(`${LIBRARY_BASE}/${motion.id}/bvh`),
    'Could not load that motion',
  )
  if (!body.bvh) throw new Error('That motion has no stored animation data.')
  return bvhToClip(body.bvh, motion.name, { upright: motion?.source === MOTION_SOURCE_MOCAP })
}

// How many prompt segments (and therefore how many x duration) a prompt is worth.
// Mirrors the service's split so the panel can show the real total up front —
// Kimodo caps a single prompt at 10 s, and chaining sentences is how you get past
// that, which is not obvious from a duration field alone.
export function countPromptSegments(prompt) {
  return String(prompt || '')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean).length
}
