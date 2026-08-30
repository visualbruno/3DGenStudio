// Reference animation library (mesh2motion, MIT) support for the mesh-editor
// Auto Rig → Animations feature.
//
// Each "reference" is a species whose skinned GLB(s) carry a source skeleton and
// a set of animation clips authored for it (resources/animations/*.glb), plus a
// folder of mp4 previews (resources/animpreviews/<dir>/dark_<clip>.mp4). To play
// one of those clips on the user's rigged mesh we:
//   1. load the reference scene (source skeleton + clips),
//   2. map the source bones to the user's mesh bones (auto + manual),
//   3. bake each clip from the source skeleton onto the target skeleton with the
//      hand-rolled retarget below (NOT three's SkeletonUtils.retargetClip), then
//      play the result on the target SkinnedMesh.
import { AnimationClip, AnimationMixer, Box3, Matrix4, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { resourceUrl } from '../config'

// The reference species. `glbs` are loaded and their clips concatenated; for
// "human" the base + addon skeletons are identical so one mapping covers both.
export const ANIMATION_REFERENCES = [
  { id: 'human', label: 'Human', dir: 'human', glbs: ['human-base-animations.glb', 'human-addon-animations.glb'] },
  { id: 'bird', label: 'Bird', dir: 'bird', glbs: ['bird-animations.glb'] },
  { id: 'dragon', label: 'Dragon', dir: 'dragon', glbs: ['dragon-animations.glb'] },
  { id: 'fox', label: 'Fox', dir: 'fox', glbs: ['fox-animations.glb'] },
  { id: 'horse', label: 'Horse', dir: 'horse', glbs: ['horse-animations.glb'] },
  { id: 'kaiju', label: 'Kaiju', dir: 'kaiju', glbs: ['kaiju-animations.glb'] },
  { id: 'shark', label: 'Shark', dir: 'shark', glbs: ['shark-animations.glb'] },
  { id: 'snake', label: 'Snake', dir: 'snake', glbs: ['snake-animations.glb'] },
  { id: 'spider', label: 'Spider', dir: 'spider', glbs: ['spider-animations.glb'] },
]

export function getReference(referenceId) {
  return ANIMATION_REFERENCES.find(r => r.id === referenceId) || null
}

// mp4 preview URL for a clip of a reference (files are prefixed with "dark_").
export function animationPreviewUrl(referenceId, clipName) {
  const ref = getReference(referenceId)
  if (!ref) return null
  return resourceUrl(`animpreviews/${ref.dir}/dark_${clipName}.mp4`)
}

const gltfLoader = new GLTFLoader()

function loadGlbFromUrl(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, resolve, undefined, err =>
      reject(err instanceof Error ? err : new Error(`Failed to load ${url}`)))
  })
}

function loadGlbFromBuffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(arrayBuffer, '', resolve, err =>
      reject(err instanceof Error ? err : new Error('Failed to parse GLB buffer.')))
  })
}

function findSkinnedMesh(root) {
  let found = null
  root.traverse(child => {
    if (!found && child.isSkinnedMesh && child.skeleton?.bones?.length) found = child
  })
  return found
}

// Load a reference species: its source SkinnedMesh (skeleton) + all clips.
// Returns { scene, skinnedMesh, boneNames, clips: [{ name }], hipName }.
export async function loadReferenceScene(referenceId) {
  const ref = getReference(referenceId)
  if (!ref) throw new Error(`Unknown animation reference: ${referenceId}`)

  let scene = null
  let skinnedMesh = null
  const clips = []
  for (const file of ref.glbs) {
    const gltf = await loadGlbFromUrl(resourceUrl(`animations/${file}`))
    if (!scene) {
      scene = gltf.scene
      skinnedMesh = findSkinnedMesh(gltf.scene)
    }
    for (const clip of gltf.animations || []) clips.push(clip)
  }
  if (!skinnedMesh) throw new Error(`No skinned mesh found in ${ref.label} reference.`)

  scene.updateMatrixWorld(true)
  const boneNames = skinnedMesh.skeleton.bones.map(b => b.name)
  const hipName = detectHipBone(boneNames)

  // De-duplicate clip names (base + addon never collide, but be safe).
  const seen = new Set()
  const uniqueClips = []
  for (const clip of clips) {
    if (seen.has(clip.name)) continue
    seen.add(clip.name)
    uniqueClips.push(clip)
  }
  uniqueClips.sort((a, b) => a.name.localeCompare(b.name))

  return {
    scene,
    skinnedMesh,
    boneNames,
    hipName,
    clips: uniqueClips,           // THREE.AnimationClip[]
  }
}

// Load a reference species' clean skeleton-only rig (resources/rigs/rig-<dir>.glb)
// for the bone-mapping 3D preview. These share the exact bone names of the
// species' animation GLB but carry no skinned mesh, so they render as a tidy
// armature. Returns { scene }; callers extract the skeleton from it.
export async function loadReferenceRigScene(referenceId) {
  const ref = getReference(referenceId)
  if (!ref) throw new Error(`Unknown animation reference: ${referenceId}`)
  const gltf = await loadGlbFromUrl(resourceUrl(`rigs/rig-${ref.dir}.glb`))
  gltf.scene.updateMatrixWorld(true)
  return { scene: gltf.scene }
}

// Load the user's rigged mesh as an animatable SkinnedMesh. Prefers the freshly
// generated rig blob; falls back to (re)loading the mesh's source URL.
export async function loadTargetScene({ riggedBuffer, modelUrl }) {
  let gltf = null
  if (riggedBuffer) {
    gltf = await loadGlbFromBuffer(riggedBuffer)
  } else if (modelUrl) {
    gltf = await loadGlbFromUrl(modelUrl)
  } else {
    throw new Error('No rigged mesh available to animate.')
  }
  const skinnedMesh = findSkinnedMesh(gltf.scene)
  if (!skinnedMesh) throw new Error('The current mesh is not skinned (no bones to animate).')
  skinnedMesh.skeleton.pose()
  gltf.scene.updateMatrixWorld(true)
  return {
    scene: gltf.scene,
    skinnedMesh,
    boneNames: skinnedMesh.skeleton.bones.map(b => b.name),
    // One-time "auto-align to floor" offset for the rest pose — see poseFloorOffset.
    floorOffset: poseFloorOffset(gltf.scene),
  }
}

// How far to lift a skinned scene so the lowest point of the pose it is CURRENTLY
// standing in sits on y=0 (the grid). Used as a constant during playback — NOT a
// per-frame foot lock — so animations keep their natural motion (jumps leave the
// ground, crouches lower, etc.).
//
// SkinnedMesh.boundingBox accounts for the posed bones, but three computes it
// once and caches it, so it has to be cleared or we would measure whichever pose
// it happened to see first (the bind pose) instead of the current one.
function poseFloorOffset(scene) {
  scene.updateMatrixWorld(true)
  scene.traverse(o => { if (o.isSkinnedMesh) o.boundingBox = null })
  const box = new Box3().setFromObject(scene)
  return Number.isFinite(box.min.y) ? -box.min.y : 0
}

// ---- Bone-name matching (Auto-Map) ----

// Normalise a bone name to a comparable token: lowercased, prefixes stripped,
// separators removed, side + common synonyms folded to canonical tokens.
const SYNONYMS = [
  [/upperarm|shoulder(?!blade)/g, 'arm'],
  [/lowerarm|forearm/g, 'forearm'],
  [/clavicle|collar/g, 'shoulder'],
  [/upleg|thigh|upperleg/g, 'upleg'],
  [/lowerleg|calf|shin/g, 'leg'],
  [/pelvis|hips|hip/g, 'hips'],
  [/spine0|spine1|spine2|spine3/g, 'spine'],
  [/foot|ankle/g, 'foot'],
  [/toebase|toe|ball/g, 'toe'],
  [/forefinger/g, 'index'],
]

function normalizeBoneName(name) {
  let s = String(name || '').toLowerCase()
  // Strip common rig prefixes.
  s = s.replace(/^mixamorig[:_]?/, '')
  // Extract side (l/r) before stripping separators.
  let side = ''
  if (/(^|[._-])(l|left)([._-]|\d|$)/.test(s)) side = 'l'
  else if (/(^|[._-])(r|right)([._-]|\d|$)/.test(s)) side = 'r'
  // Remove side tokens, separators, "leaf"/"tip"/"end" suffixes and digits.
  s = s
    .replace(/(^|[._-])(left|right)([._-]|$)/g, '$1$3')
    .replace(/(^|[._-])(l|r)([._-]|$)/g, '$1$3')
    .replace(/leaf|_tip|\.tip|tip|_end/g, '')
    .replace(/[._\-\s]/g, '')
  for (const [re, to] of SYNONYMS) s = s.replace(re, to)
  s = s.replace(/\d+/g, '')
  return { token: s, side }
}

// Direct Mesh2Motion(source) → Mixamo(target) name table, from mesh2motion's
// MixamoMapper (MIT). Used verbatim when the human reference is mapped onto a
// mixamo-named skeleton (what our rigging service emits with rename_bones:mixamo)
// — an exact mapping beats the fuzzy heuristic there.
const MESH2MOTION_TO_MIXAMO = {
  pelvis: 'mixamorigHips', spine_01: 'mixamorigSpine', spine_02: 'mixamorigSpine1',
  spine_03: 'mixamorigSpine2', neck_01: 'mixamorigNeck', head: 'mixamorigHead',
  head_leaf: 'mixamorigHeadTop_End',
  clavicle_l: 'mixamorigLeftShoulder', upperarm_l: 'mixamorigLeftArm',
  lowerarm_l: 'mixamorigLeftForeArm', hand_l: 'mixamorigLeftHand',
  clavicle_r: 'mixamorigRightShoulder', upperarm_r: 'mixamorigRightArm',
  lowerarm_r: 'mixamorigRightForeArm', hand_r: 'mixamorigRightHand',
  thigh_l: 'mixamorigLeftUpLeg', calf_l: 'mixamorigLeftLeg', foot_l: 'mixamorigLeftFoot',
  ball_l: 'mixamorigLeftToeBase', ball_leaf_l: 'mixamorigLeftToe_End',
  thigh_r: 'mixamorigRightUpLeg', calf_r: 'mixamorigRightLeg', foot_r: 'mixamorigRightFoot',
  ball_r: 'mixamorigRightToeBase', ball_leaf_r: 'mixamorigRightToe_End',
  thumb_01_l: 'mixamorigLeftHandThumb1', thumb_02_l: 'mixamorigLeftHandThumb2',
  thumb_03_l: 'mixamorigLeftHandThumb3', thumb_04_leaf_l: 'mixamorigLeftHandThumb4',
  index_01_l: 'mixamorigLeftHandIndex1', index_02_l: 'mixamorigLeftHandIndex2',
  index_03_l: 'mixamorigLeftHandIndex3', index_04_leaf_l: 'mixamorigLeftHandIndex4',
  middle_01_l: 'mixamorigLeftHandMiddle1', middle_02_l: 'mixamorigLeftHandMiddle2',
  middle_03_l: 'mixamorigLeftHandMiddle3', middle_04_leaf_l: 'mixamorigLeftHandMiddle4',
  ring_01_l: 'mixamorigLeftHandRing1', ring_02_l: 'mixamorigLeftHandRing2',
  ring_03_l: 'mixamorigLeftHandRing3', ring_04_leaf_l: 'mixamorigLeftHandRing4',
  pinky_01_l: 'mixamorigLeftHandPinky1', pinky_02_l: 'mixamorigLeftHandPinky2',
  pinky_03_l: 'mixamorigLeftHandPinky3', pinky_04_leaf_l: 'mixamorigLeftHandPinky4',
  thumb_01_r: 'mixamorigRightHandThumb1', thumb_02_r: 'mixamorigRightHandThumb2',
  thumb_03_r: 'mixamorigRightHandThumb3', thumb_04_leaf_r: 'mixamorigRightHandThumb4',
  index_01_r: 'mixamorigRightHandIndex1', index_02_r: 'mixamorigRightHandIndex2',
  index_03_r: 'mixamorigRightHandIndex3', index_04_leaf_r: 'mixamorigRightHandIndex4',
  middle_01_r: 'mixamorigRightHandMiddle1', middle_02_r: 'mixamorigRightHandMiddle2',
  middle_03_r: 'mixamorigRightHandMiddle3', middle_04_leaf_r: 'mixamorigRightHandMiddle4',
  ring_01_r: 'mixamorigRightHandRing1', ring_02_r: 'mixamorigRightHandRing2',
  ring_03_r: 'mixamorigRightHandRing3', ring_04_leaf_r: 'mixamorigRightHandRing4',
  pinky_01_r: 'mixamorigRightHandPinky1', pinky_02_r: 'mixamorigRightHandPinky2',
  pinky_03_r: 'mixamorigRightHandPinky3', pinky_04_leaf_r: 'mixamorigRightHandPinky4',
}

// Direct SOMA-77(Kimodo) → Mixamo table.
//
// Not a nicety — a correctness fix. SOMA calls the THIGH "LeftLeg" and the shin
// "LeftShin"; Mixamo calls the thigh "LeftUpLeg" and the SHIN "LeftLeg". Name
// matching alone therefore pairs SOMA's thigh with Mixamo's shin: an exact token
// hit, and completely wrong, folding every walk cycle at the knee. The
// Chest→Spine2 and Spine1/Spine2 off-by-one are the same trap, quieter.
//
// Only the 23 body joints Kimodo actually drives are listed. Its checkpoint
// denoises the 30-joint SOMA skeleton and expands to 77 for output, filling the
// finger chains from a fixed relaxed-hand pose — mapping those would drag the
// target's fingers into that pose and hold them there for the whole clip.
const KIMODO_TO_MIXAMO = {
  Hips: 'mixamorigHips',
  Spine1: 'mixamorigSpine', Spine2: 'mixamorigSpine1', Chest: 'mixamorigSpine2',
  // Kimodo has a two-bone neck, Mixamo has one: Neck1 carries it and Neck2 is
  // left unmapped so the head does not receive that rotation twice.
  Neck1: 'mixamorigNeck', Head: 'mixamorigHead',
  LeftShoulder: 'mixamorigLeftShoulder', LeftArm: 'mixamorigLeftArm',
  LeftForeArm: 'mixamorigLeftForeArm', LeftHand: 'mixamorigLeftHand',
  RightShoulder: 'mixamorigRightShoulder', RightArm: 'mixamorigRightArm',
  RightForeArm: 'mixamorigRightForeArm', RightHand: 'mixamorigRightHand',
  LeftLeg: 'mixamorigLeftUpLeg', LeftShin: 'mixamorigLeftLeg',
  LeftFoot: 'mixamorigLeftFoot', LeftToeBase: 'mixamorigLeftToeBase',
  RightLeg: 'mixamorigRightUpLeg', RightShin: 'mixamorigRightLeg',
  RightFoot: 'mixamorigRightFoot', RightToeBase: 'mixamorigRightToeBase',
}

// The same thigh/shin collision bites the FUZZY matcher on any non-Mixamo target,
// not just Mixamo ones: normalizeBoneName folds both "shin" and "leg" to the token
// "leg", so SOMA's LeftLeg and LeftShin become indistinguishable and whichever is
// tried first wins the target's thigh. These aliases are what the matcher sees
// INSTEAD of the raw SOMA names; the mapping it returns still refers to the real
// bones.
const KIMODO_FUZZY_ALIASES = {
  LeftLeg: 'LeftUpLeg', RightLeg: 'RightUpLeg',
  LeftShin: 'LeftLowerLeg', RightShin: 'RightLowerLeg',
  Chest: 'Spine3', Neck1: 'Neck', Neck2: 'Neck2',
}

// Exact source→Mixamo tables, keyed by reference id. Applied before the fuzzy
// heuristic when the target is a mixamo-named skeleton (what our rigging service
// emits with rename_bones:mixamo), because an exact mapping beats guessing.
const EXACT_TO_MIXAMO = {
  human: MESH2MOTION_TO_MIXAMO,
  kimodo: KIMODO_TO_MIXAMO,
}

// Per-reference name aliases used only while fuzzy-matching.
const FUZZY_ALIASES = {
  kimodo: KIMODO_FUZZY_ALIASES,
}

// Auto-map source bones onto target bones. Returns { [targetBoneName]: sourceBoneName }.
// When an exact source→Mixamo table exists for `referenceId` and the target is a
// mixamo-named skeleton, that table is applied first, then the fuzzy heuristic
// fills any remaining unmapped target bones.
export function autoMapBones(sourceNames, targetNames, referenceId = null) {
  const aliases = FUZZY_ALIASES[referenceId] || null
  // Match on the alias, but always return the REAL bone name.
  const sources = sourceNames.map(name => ({ name, ...normalizeBoneName(aliases?.[name] || name) }))
  const mapping = {}
  const usedSource = new Set()

  const targetIsMixamo = targetNames.some(n => n.toLowerCase().includes('mixamorig'))
  const exactTable = EXACT_TO_MIXAMO[referenceId]
  if (exactTable && targetIsMixamo) {
    const sourceSet = new Set(sourceNames)
    const targetSet = new Set(targetNames)
    for (const [srcName, tgtName] of Object.entries(exactTable)) {
      if (sourceSet.has(srcName) && targetSet.has(tgtName)) {
        mapping[tgtName] = srcName
        usedSource.add(srcName)
      }
    }
  }

  for (const targetName of targetNames) {
    if (mapping[targetName]) continue
    const t = normalizeBoneName(targetName)
    if (!t.token) continue
    let best = null
    let bestScore = 0
    for (const s of sources) {
      if (usedSource.has(s.name)) continue
      if (!s.token) continue
      // Sides must not conflict (empty side matches either).
      if (s.side && t.side && s.side !== t.side) continue
      let score = 0
      if (s.token === t.token) score = 100
      else if (s.token.includes(t.token) || t.token.includes(s.token)) score = 60
      else continue
      if (s.side && s.side === t.side) score += 10
      if (score > bestScore) { bestScore = score; best = s }
    }
    if (best) {
      mapping[targetName] = best.name
      usedSource.add(best.name)
    }
  }
  return mapping
}

// Pick the source hip/root bone name from a list of bone names.
export function detectHipBone(boneNames) {
  const lowered = boneNames.map(n => ({ n, l: n.toLowerCase() }))
  return (
    lowered.find(b => /pelvis|hips$|^hips/.test(b.l))?.n ||
    lowered.find(b => /hip/.test(b.l))?.n ||
    lowered.find(b => /root/.test(b.l))?.n ||
    boneNames[0] ||
    'hips'
  )
}

// --- In-place conversion ----------------------------------------------------
// How much of the hip track counts as "locomotion" rather than gait. Two boxcar
// passes of this length keep ~96% of a 1 Hz weight shift (a walk cycle) and all of
// a run's, while still tracking the travel: measured against synthetic walk, run
// and 0->3 m/s ramp tracks, a shorter 0.6s window throws away a fifth of the walk
// sway and a longer 1.2s one leaves ~13cm of residual sliding under hard
// acceleration. Net travel is removed exactly regardless (see the padding below).
const IN_PLACE_WINDOW_SECONDS = 0.8

// Boxcar smoothing with ODD (antisymmetric) padding at both ends: the window is
// reflected THROUGH the end sample instead of clamped to it, so the boundary keeps
// its slope. A clamped window flattens the smoothed curve over the last half
// window — and travel the smoother fails to see is travel the conversion below
// fails to remove, i.e. a clip that still slides at its start and end.
function smoothSeries(values, halfWindow) {
  const n = values.length
  if (!n || halfWindow < 1) return Array.from(values)
  const at = i => {
    if (i < 0) return 2 * values[0] - values[Math.min(n - 1, -i)]
    if (i >= n) return 2 * values[n - 1] - values[Math.max(0, 2 * n - 2 - i)]
    return values[i]
  }
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = -halfWindow; k <= halfWindow; k++) sum += at(i + k)
    out[i] = sum / (2 * halfWindow + 1)
  }
  return out
}

// The bone a position track drives, for both track-naming conventions in play:
// "Hips.position" (BVHLoader, and what GLTFExporter wants) and
// ".bones[Hips].position" (what the mixer binds against a SkinnedMesh).
function positionTrackBone(name) {
  const m = /^(?:\.bones\[(.+?)\]|(.+?))\.position$/.exec(name || '')
  return m ? (m[1] ?? m[2]) : null
}

// Strip locomotion from a clip's hip track so the motion plays on the spot.
// Returns a NEW clip (the original keeps its travel) or the clip unchanged when
// there is no hip position track to work on.
//
// This is deliberately a post-process rather than a generation option: the stored
// motion always travels, and the in-place version is derived at bake time — so the
// toggle is reversible and applies to motions generated long before it was ticked.
//
// The naive conversion pins the hips to a constant X/Z, which also flattens the
// side-to-side weight shift and forward lean that make a walk read as a walk — the
// character slides its feet under a rigid pelvis. So only the LOW-FREQUENCY part
// of the horizontal track is removed: smoothing it estimates the locomotion, and
// subtracting that estimate's DRIFT from its first sample leaves the per-step sway
// on top of a stationary root.
//
// Vertical motion and every rotation are untouched: jumps still leave the ground,
// crouches still lower the body, and "turns left" still turns — on the spot.
export function makeClipInPlace(clip, hipName) {
  if (!clip?.tracks?.length) return clip
  const wanted = String(hipName || '').toLowerCase()
  const positionTracks = clip.tracks.filter(t => positionTrackBone(t.name))
  const track = positionTracks.find(t => positionTrackBone(t.name).toLowerCase() === wanted)
    // A BVH carries exactly one position track, on its root — so when the hip name
    // does not match (a renamed rig), the only candidate is still the right one.
    || (positionTracks.length === 1 ? positionTracks[0] : null)
  if (!track) return clip

  const n = Math.floor(track.values.length / 3)
  if (n < 3) return clip
  const span = track.times[n - 1] - track.times[0]
  const fps = span > 0 ? (n - 1) / span : 30
  const halfWindow = Math.max(1, Math.round((IN_PLACE_WINDOW_SECONDS * fps) / 2))

  const tracks = clip.tracks.map(t => t.clone())
  const target = tracks[clip.tracks.indexOf(track)]
  for (const axis of [0, 2]) {  // X and Z; Y (height) is left alone
    const series = new Array(n)
    for (let i = 0; i < n; i++) series[i] = target.values[i * 3 + axis]
    // Two boxcar passes ≈ a triangular window: the same cutoff, far less ripple.
    const smooth = smoothSeries(smoothSeries(series, halfWindow), halfWindow)
    const base = smooth[0]
    for (let i = 0; i < n; i++) target.values[i * 3 + axis] = series[i] - (smooth[i] - base)
  }

  const converted = new AnimationClip(clip.name, clip.duration, tracks)
  converted.userData = { ...(clip.userData || {}), inPlace: true }
  return converted
}

// Bones of `bone`'s subtree that are mapped and have no mapped bone between them
// and `bone` — i.e. where its chain continues. Descends through unmapped bones so
// an intermediate helper/twist bone does not break a chain.
function nearestMappedDescendants(bone, mapping) {
  const out = []
  const walk = node => {
    for (const child of node.children) {
      if (!child.isBone) continue
      if (mapping[child.name]) out.push(child)
      else walk(child)
    }
  }
  walk(bone)
  return out
}

function isDescendantOf(bone, ancestor) {
  for (let p = bone.parent; p; p = p.parent) if (p === ancestor) return true
  return false
}

// A correction this large means the two bones are not the same limb — almost
// always a bad mapping. Leave the bone alone rather than wrench it into place.
const MAX_REST_MATCH_ANGLE = (135 * Math.PI) / 180

// Rotate the target's mapped bones so each one POINTS THE SAME WAY as the
// reference bone it is mapped from, and leave the skeleton standing in that pose
// so the retarget below measures its deltas against it.
//
// This is what stops a character whose rest pose has the legs apart from walking
// with the legs apart. The retarget is delta-based (see retargetAnimationClip), so
// the constant srcBind⁻¹·tgtBind offset that makes "source at rest ⇒ target at
// rest" true also carries every rest-pose difference into every frame. Matching
// the bone DIRECTIONS (the swing) cancels exactly that part, while the leftover
// rotation about each bone's own axis (the twist) is deliberately kept — that part
// is the rig's axis convention, and dropping it would corkscrew the limbs.
//
// Only bones with exactly ONE mapped descendant are touched. For a hip, a chest or
// a hand the "bone direction" is ambiguous (spine vs the two legs, neck vs the
// clavicles, five fingers) and picking one child would tilt the whole torso; limb
// chains, where the splay actually lives, are unambiguous.
//
// Returns the number of bones adjusted.
function matchTargetRestPose({ targetBones, mapping, sourceByName }) {
  const srcHead = new Vector3(), srcTail = new Vector3(), srcDir = new Vector3()
  const tgtHead = new Vector3(), tgtTail = new Vector3(), tgtDir = new Vector3()
  const swing = new Quaternion(), boneWorld = new Quaternion(), parentWorldInv = new Quaternion()
  let adjusted = 0

  // `targetBones` is a pre-order traversal, so each bone is corrected after the
  // parent whose own correction moved it.
  for (const tb of targetBones) {
    const sb = sourceByName.get(mapping[tb.name])
    if (!sb) continue
    const children = nearestMappedDescendants(tb, mapping)
    if (children.length !== 1) continue
    const tc = children[0]
    const sc = sourceByName.get(mapping[tc.name])
    // A scrambled mapping can pair a bone with something outside its own chain,
    // making the two directions unrelated. Only trust a genuine parent → child.
    if (!sc || sc === sb || !isDescendantOf(sc, sb)) continue

    tb.getWorldPosition(tgtHead); tc.getWorldPosition(tgtTail)
    sb.getWorldPosition(srcHead); sc.getWorldPosition(srcTail)
    tgtDir.subVectors(tgtTail, tgtHead)
    srcDir.subVectors(srcTail, srcHead)
    if (tgtDir.lengthSq() < 1e-12 || srcDir.lengthSq() < 1e-12) continue
    tgtDir.normalize(); srcDir.normalize()

    const angle = Math.acos(Math.min(1, Math.max(-1, tgtDir.dot(srcDir))))
    if (!(angle > 1e-4)) continue
    if (angle > MAX_REST_MATCH_ANGLE) {
      console.warn(`Rest-pose match: skipped ${tb.name} → ${sb.name}, ${Math.round(angle * 180 / Math.PI)}° apart (mismapped?)`)
      continue
    }

    // World-space swing, pre-multiplied onto the bone's current world rotation,
    // then back to the parent's space as a local rotation.
    swing.setFromUnitVectors(tgtDir, srcDir)
    tb.getWorldQuaternion(boneWorld)
    tb.parent.getWorldQuaternion(parentWorldInv).invert()
    tb.quaternion.copy(parentWorldInv.multiply(swing).multiply(boneWorld)).normalize()
    tb.updateMatrixWorld(true)
    adjusted++
  }
  return adjusted
}

// Retarget a source clip onto the target skeleton using a bone map, producing an
// AnimationClip of target-bone quaternion tracks (ready for an AnimationMixer on
// the target SkinnedMesh). `mapping` is { [targetBoneName]: sourceBoneName }.
//
// Uses WORLD-SPACE DELTA retargeting: each source bone's rotation change from its
// own bind pose is applied onto the target bone's bind orientation:
//     desiredWorld = (sourceAnimWorld * sourceBindWorld⁻¹) * targetBindWorld
//     targetLocal  = targetParentAnimWorld⁻¹ * desiredWorld
// At the source's rest pose the delta is identity, so the target stays exactly at
// whatever rest pose it was measured in. Playback is in-place (no hip translation).
//
// That last property is why `matchRestPose` exists (and defaults on): the delta is
// measured against the target's OWN rest pose, so any difference between the two
// rigs' rest poses survives into every frame — legs modelled apart stay apart for
// the whole walk cycle. matchTargetRestPose first poses the target like the
// reference and measures the deltas from there. Turn it off to keep the mesh's own
// stance (a stylised rig may want that) at the cost of that artefact.
//
// Sets clip.userData.floorOffset: how far to lift the mesh so the rest pose it was
// baked against sits on the grid. Matching the rest pose moves the mesh (closed
// legs make a character taller), which invalidates the offset measured at load.
//
// Both scenes' roots are needed (not just the SkinnedMeshes): bones are siblings
// of the mesh, so only the scene root's updateMatrixWorld() refreshes bone world
// matrices, which the sampling below reads every frame.
export function retargetAnimationClip({
  targetScene, targetSkinnedMesh, sourceScene, sourceSkinnedMesh, clip, mapping, fps = 30,
  matchRestPose = true,
}) {
  const sourceSkeleton = sourceSkinnedMesh.skeleton
  const sourceByName = new Map(sourceSkeleton.bones.map(b => [b.name, b]))

  // Target bones in parent-first order (pre-order traversal).
  const targetBones = []
  targetScene.traverse(o => { if (o.isBone) targetBones.push(o) })

  // Hip bone (drives vertical body motion): the target bone mapped from the
  // source's hip. Its position IS retargeted (scaled) so crouches/pushups lower
  // the body and the feet stay planted — everything else is rotation-only.
  const sourceHipName = detectHipBone(sourceSkeleton.bones.map(b => b.name))
  const hipTargetName = Object.keys(mapping).find(t => mapping[t] === sourceHipName) || null

  // Capture bind-pose world quaternions for both rigs.
  sourceSkeleton.pose(); sourceScene.updateMatrixWorld(true)
  targetSkinnedMesh.skeleton.pose(); targetScene.updateMatrixWorld(true)
  const srcBindWorldInv = new Map()
  sourceSkeleton.bones.forEach(b => srcBindWorldInv.set(b.name, b.getWorldQuaternion(new Quaternion()).invert()))

  // Pose the target like the reference BEFORE reading its bind orientations, so
  // the deltas below are measured against the reference's stance rather than the
  // mesh's own (which would keep the mesh's leg/arm splay through every frame).
  const restMatched = matchRestPose
    ? matchTargetRestPose({ targetBones, mapping, sourceByName })
    : 0
  const tgtBindWorld = new Map()
  targetBones.forEach(b => tgtBindWorld.set(b.name, b.getWorldQuaternion(new Quaternion())))
  // Measured while standing in the pose the clip is baked against — a moved rest
  // pose sits differently on the floor. Null keeps the caller's load-time offset.
  const floorOffset = restMatched > 0 ? poseFloorOffset(targetScene) : null

  // Hip position bind state + size scale (target hip height / source hip height),
  // so the source's hip translation maps to the target's proportions.
  const srcHipBone = sourceByName.get(sourceHipName) || null
  const hipTargetBone = hipTargetName ? targetBones.find(b => b.name === hipTargetName) : null
  const srcHipBindPos = srcHipBone ? srcHipBone.getWorldPosition(new Vector3()) : null
  const tgtHipBindPos = hipTargetBone ? hipTargetBone.getWorldPosition(new Vector3()) : null
  const hipParentBindInv = hipTargetBone ? new Matrix4().copy(hipTargetBone.parent.matrixWorld).invert() : null
  let hipScale = 1
  if (srcHipBindPos && tgtHipBindPos && Math.abs(srcHipBindPos.y) > 1e-6) {
    hipScale = tgtHipBindPos.y / srcHipBindPos.y
  }

  // Only target bones that map to an existing source bone get animated.
  const mapped = targetBones.filter(b => mapping[b.name] && sourceByName.has(mapping[b.name]))

  const duration = clip.duration || 0
  const frameCount = Math.max(2, Math.round(duration * fps) + 1)
  const dt = frameCount > 1 ? duration / (frameCount - 1) : 0
  const times = new Float32Array(frameCount)
  const values = new Map(mapped.map(b => [b.name, new Float32Array(frameCount * 4)]))
  const hipPosValues = hipTargetBone ? new Float32Array(frameCount * 3) : null

  const mixer = new AnimationMixer(sourceScene)
  mixer.clipAction(clip).play()

  const sAnimW = new Quaternion(), deltaW = new Quaternion(), desiredW = new Quaternion(), parentWInv = new Quaternion(), local = new Quaternion()
  const sHipAnim = new Vector3(), hipWorld = new Vector3(), hipLocal = new Vector3()

  for (let f = 0; f < frameCount; f++) {
    const t = f * dt
    times[f] = t
    mixer.setTime(t)
    sourceScene.updateMatrixWorld(true)

    // Start each frame from the target bind pose, then pose mapped bones in
    // parent-first order so each child sees its already-posed parent.
    targetSkinnedMesh.skeleton.pose()
    targetScene.updateMatrixWorld(true)
    for (const tb of mapped) {
      // Hip position: bind + scaled source-hip delta, converted to hip-local.
      if (tb === hipTargetBone) {
        srcHipBone.getWorldPosition(sHipAnim)
        hipWorld.subVectors(sHipAnim, srcHipBindPos).multiplyScalar(hipScale).add(tgtHipBindPos)
        hipLocal.copy(hipWorld).applyMatrix4(hipParentBindInv)
        tb.position.copy(hipLocal)
        hipLocal.toArray(hipPosValues, f * 3)
      }
      const sName = mapping[tb.name]
      sourceByName.get(sName).getWorldQuaternion(sAnimW)
      deltaW.multiplyQuaternions(sAnimW, srcBindWorldInv.get(sName))
      desiredW.multiplyQuaternions(deltaW, tgtBindWorld.get(tb.name))
      tb.parent.getWorldQuaternion(parentWInv).invert()
      local.multiplyQuaternions(parentWInv, desiredW).normalize()
      tb.quaternion.copy(local)
      tb.updateMatrixWorld(true)
      local.toArray(values.get(tb.name), f * 4)
    }
  }

  mixer.stopAllAction()
  mixer.uncacheRoot(sourceScene)
  sourceSkeleton.pose()
  targetSkinnedMesh.skeleton.pose()
  targetScene.updateMatrixWorld(true)

  const tracks = mapped.map(tb =>
    new QuaternionKeyframeTrack(`.bones[${tb.name}].quaternion`, times, values.get(tb.name)))
  if (hipTargetBone && hipPosValues) {
    tracks.push(new VectorKeyframeTrack(`.bones[${hipTargetBone.name}].position`, times, hipPosValues))
  }
  const retargeted = new AnimationClip(clip.name, duration, tracks)
  retargeted.userData = { floorOffset, restMatchedBones: restMatched }
  return retargeted
}

// Rebind a retargeted clip's tracks for glTF export. Playback tracks are named
// ".bones[BoneName].quaternion" (resolved by the mixer against the SkinnedMesh's
// skeleton). GLTFExporter instead resolves tracks against nodes by name, so we
// rewrite them to "BoneName.quaternion" — matching the bone node the exporter
// finds while walking the scene.
//
// Exported because the custom-animation library stores clips in the same
// node-name form: a saved clip is replayed as a SOURCE, and its scene is a bare
// bone hierarchy with no SkinnedMesh for ".bones[...]" to resolve against.
export function rebindClipForExport(clip) {
  const tracks = clip.tracks.map(track => {
    const cloned = track.clone()
    const m = /^\.bones\[(.+?)\]\.(.+)$/.exec(cloned.name)
    if (m) cloned.name = `${m[1]}.${m[2]}`
    return cloned
  })
  return new AnimationClip(clip.name, clip.duration, tracks)
}

// Serialize the user's rigged/target scene to a binary GLB with the given
// retargeted clips embedded as animations. Returns a Blob.
//
// The scene is cloned (SkeletonUtils.clone preserves the skinned-mesh/skeleton/
// bone hierarchy and bone names) and reset to its bind pose before export, so the
// live viewport preview is never disturbed and the exported base transforms are
// the rest pose (the embedded clips drive the motion at playback time).
export function exportAnimatedGlb({ scene, clips }) {
  const exportScene = cloneSkinnedScene(scene)
  exportScene.traverse(o => { if (o.isSkinnedMesh) o.skeleton.pose() })
  exportScene.updateMatrixWorld(true)
  const animations = (clips || []).map(rebindClipForExport)
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      exportScene,
      result => {
        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('Failed to export the animated mesh as a binary GLB.'))
          return
        }
        resolve(new Blob([result], { type: 'model/gltf-binary' }))
      },
      err => reject(err instanceof Error ? err : new Error('Failed to export the animated mesh.')),
      { binary: true, onlyVisible: false, animations }
    )
  })
}

// Target bones that correspond to the left/right UPPER ARM (for the
// Expand/Contract Arms control). Derived from the saved mapping: the source
// upper-arm bones are `upperarm_l` / `upperarm_r` (humanoid references).
export function findUpperArmTargets(mapping) {
  const left = []
  const right = []
  for (const [target, source] of Object.entries(mapping || {})) {
    const s = String(source).toLowerCase()
    if (!s.includes('upperarm') && !(s.includes('arm') && !s.includes('fore') && !s.includes('lower') && !s.includes('hand'))) continue
    if (/_l$|left|lupperarm|upperarml/.test(s) || s.endsWith('l')) left.push(target)
    else if (/_r$|right|rupperarm|upperarmr/.test(s) || s.endsWith('r')) right.push(target)
  }
  return { left, right }
}
