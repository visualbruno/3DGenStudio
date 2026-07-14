// Reference animation library (mesh2motion, MIT) support for the mesh-editor
// Auto Rig → Animations feature.
//
// Each "reference" is a species whose skinned GLB(s) carry a source skeleton and
// a set of animation clips authored for it (resources/animations/*.glb), plus a
// folder of mp4 previews (resources/animpreviews/<dir>/dark_<clip>.mp4). To play
// one of those clips on the user's rigged mesh we:
//   1. load the reference scene (source skeleton + clips),
//   2. map the source bones to the user's mesh bones (auto + manual),
//   3. retarget each clip from the source skeleton to the target skeleton with
//      three's SkeletonUtils.retargetClip, then play it on the target SkinnedMesh.
import { AnimationClip, AnimationMixer, Box3, Matrix4, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { resourceUrl } from '../config'

// The reference species. `glbs` are loaded and their clips concatenated; for
// "human" the base + addon skeletons are identical so one mapping covers both.
export const ANIMATION_REFERENCES = [
  { id: 'human', label: 'Human', dir: 'human', glbs: ['human-base-animations.glb', 'human-addon-animations.glb'] },
  { id: 'bird', label: 'Bird', dir: 'bird', glbs: ['bird-animations.glb'] },
  { id: 'dragon', label: 'Dragon', dir: 'dragon', glbs: ['dragon-animations.glb'] },
  { id: 'fox', label: 'Fox', dir: 'fox', glbs: ['fox-animations.glb'] },
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
  // One-time "auto-align to floor" offset: how far to lift the rest pose so its
  // lowest point sits on y=0 (the grid). Applied as a constant during playback —
  // NOT a per-frame foot lock — so animations keep their natural motion (jumps
  // leave the ground, crouches lower, etc.).
  const box = new Box3().setFromObject(gltf.scene)
  const floorOffset = Number.isFinite(box.min.y) ? -box.min.y : 0
  return {
    scene: gltf.scene,
    skinnedMesh,
    boneNames: skinnedMesh.skeleton.bones.map(b => b.name),
    floorOffset,
  }
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

// Auto-map source bones onto target bones. Returns { [targetBoneName]: sourceBoneName }.
// When `referenceId` is 'human' and the target is a mixamo-named skeleton, the
// exact Mesh2Motion→Mixamo table is applied first, then the fuzzy heuristic fills
// any remaining unmapped target bones.
export function autoMapBones(sourceNames, targetNames, referenceId = null) {
  const sources = sourceNames.map(name => ({ name, ...normalizeBoneName(name) }))
  const mapping = {}
  const usedSource = new Set()

  const targetIsMixamo = targetNames.some(n => n.toLowerCase().includes('mixamorig'))
  if (referenceId === 'human' && targetIsMixamo) {
    const sourceSet = new Set(sourceNames)
    const targetSet = new Set(targetNames)
    for (const [srcName, tgtName] of Object.entries(MESH2MOTION_TO_MIXAMO)) {
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

// Retarget a source clip onto the target skeleton using a bone map, producing an
// AnimationClip of target-bone quaternion tracks (ready for an AnimationMixer on
// the target SkinnedMesh). `mapping` is { [targetBoneName]: sourceBoneName }.
//
// Uses WORLD-SPACE DELTA retargeting: each source bone's rotation change from its
// own bind pose is applied onto the target bone's bind orientation:
//     desiredWorld = (sourceAnimWorld * sourceBindWorld⁻¹) * targetBindWorld
//     targetLocal  = targetParentAnimWorld⁻¹ * desiredWorld
// At the source's rest pose the delta is identity, so the target stays exactly at
// its own rest — no distortion from differing rig rest poses (unlike copying the
// source's absolute orientations). Playback is in-place (no hip translation).
//
// Both scenes' roots are needed (not just the SkinnedMeshes): bones are siblings
// of the mesh, so only the scene root's updateMatrixWorld() refreshes bone world
// matrices, which the sampling below reads every frame.
export function retargetAnimationClip({
  targetScene, targetSkinnedMesh, sourceScene, sourceSkinnedMesh, clip, mapping, fps = 30,
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
  const tgtBindWorld = new Map()
  targetBones.forEach(b => tgtBindWorld.set(b.name, b.getWorldQuaternion(new Quaternion())))

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
  return new AnimationClip(clip.name, duration, tracks)
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
