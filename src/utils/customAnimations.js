// Custom animation library: clips the user corrected by hand in the mesh
// editor's animation dock, saved so the work survives the session and can be put
// on ANY other rigged mesh later.
//
// The unit that gets stored is NOT the clip alone. A retargeted clip is a set of
// local rotations for one particular skeleton, and the retargeter measures every
// frame as a delta from the source rig's REST POSE — so a clip without the
// skeleton it was authored on can only ever be replayed on the exact mesh it came
// from. Saving the two together turns a hand-edited clip into a proper animation
// SOURCE, which then travels the same road as a bundled mesh2motion reference or
// a Kimodo generation: bone mapping → retargetAnimationClip → preview → save.
//
// Format (one JSON document per animation):
//   { version, rigKey, fps, frameCount,
//     bones: [{ name, parent, position, quaternion, scale }],
//     clip: <AnimationClip.toJSON, tracks named "BoneName.quaternion"> }
//
// The bones list is a pre-order traversal, so `parent` is always an index that
// has already been seen (-1 for the root). The root carries its WORLD transform
// rather than its local one: bone roots often sit under an armature node with a
// scale or an axis flip, and dropping that would rebuild a skeleton of the wrong
// size — which the retargeter turns into a wrongly scaled hip translation.
import { AnimationClip, Bone, Group, Quaternion, Skeleton, Vector3 } from 'three'
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { API_BASE } from '../config'
import { autoMapBones, detectHipBone, rebindClipForExport } from './animationLibrary'

// Custom animations occupy the same single "source rig" slot as a mesh2motion
// reference, Kimodo or MoCap, so they need an id that cannot collide with one.
export const CUSTOM_SOURCE_ID = 'custom'

const LIBRARY_BASE = `${API_BASE}/animations/library`
const DOCUMENT_VERSION = 1

// Rounding: a hand-edited 10 s clip is a key per bone per frame, and full float
// precision triples the file for motion nobody can see. 6 decimals on a unit
// quaternion is ~1e-4 degrees.
const VALUE_DECIMALS = 6
const TIME_DECIMALS = 5

function round(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(Number(value) * factor) / factor
}

// Identifies the SKELETON a clip was authored on, so an animation saved off one
// rig can recognise another mesh rigged the same way — that is what lets a bone
// mapping made for one custom animation be reused for every other animation from
// the same rig. Order-independent (bone order is an export detail, the set is
// not) and cheap: a 32-bit FNV-1a over the sorted names.
export function customRigKey(boneNames) {
  const joined = [...(boneNames || [])].map(String).sort().join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${boneNames?.length || 0}`
}

// The mesh's stored bone mappings are keyed per source; a custom animation's key
// is its RIG, not its id, so mapping one animation maps every animation that came
// off the same skeleton.
export function customMappingKey(rigKey) {
  return `${CUSTOM_SOURCE_ID}:${rigKey || 'unknown'}`
}

// Map a saved animation's bones onto the open mesh's.
//
// An exact name match wins over the fuzzy heuristic, which is the common case
// here and nowhere else: a custom animation usually comes off a rig produced by
// the same Auto Rig pass as the mesh it is being put on, so the two skeletons
// share their names bone for bone. The heuristic alone would still get most of
// them, and would still occasionally pair "Spine1" with "Spine" while both exist.
export function mapCustomBones(sourceNames, targetNames) {
  const mapping = autoMapBones(sourceNames, targetNames, CUSTOM_SOURCE_ID)
  const sourceSet = new Set(sourceNames)
  const identical = (targetNames || []).filter(name => sourceSet.has(name))
  if (!identical.length) return mapping
  // Claiming a source bone by name frees it from wherever the heuristic had put
  // it — a source bone driving two target bones would animate them in lockstep.
  const claimed = new Set(identical)
  for (const [target, source] of Object.entries(mapping)) {
    if (claimed.has(source) && source !== target) delete mapping[target]
  }
  for (const name of identical) mapping[name] = name
  return mapping
}

// --- serialize --------------------------------------------------------------

// Snapshot a rigged scene's skeleton at its REST pose.
//
// The scene is cloned before posing: the live one is what the viewport preview is
// playing, and putting it back into its bind pose mid-preview would freeze the
// mesh on screen. (Same reasoning as exportAnimatedGlb.)
function snapshotSkeleton(scene) {
  const snapshot = cloneSkinnedScene(scene)
  snapshot.traverse(o => { if (o.isSkinnedMesh) o.skeleton.pose() })
  snapshot.updateMatrixWorld(true)

  const bones = []
  const indexByBone = new Map()
  const position = new Vector3()
  const quaternion = new Quaternion()
  const scale = new Vector3()

  // Pre-order, so a bone's parent always precedes it.
  snapshot.traverse(object => {
    if (!object.isBone) return
    const parent = indexByBone.has(object.parent) ? indexByBone.get(object.parent) : -1
    // The root keeps everything its ancestors contributed (see the header note);
    // every other bone is local to the parent that is being rebuilt with it.
    if (parent < 0) object.matrixWorld.decompose(position, quaternion, scale)
    else { position.copy(object.position); quaternion.copy(object.quaternion); scale.copy(object.scale) }
    indexByBone.set(object, bones.length)
    bones.push({
      name: object.name,
      parent,
      position: position.toArray().map(v => round(v, VALUE_DECIMALS)),
      quaternion: quaternion.toArray().map(v => round(v, VALUE_DECIMALS)),
      scale: scale.toArray().map(v => round(v, VALUE_DECIMALS)),
    })
  })
  return bones
}

function serializeClip(clip) {
  // Node-name tracks ("BoneName.quaternion"), because the rebuilt source scene is
  // a bare bone hierarchy — there is no SkinnedMesh for ".bones[...]" to bind to.
  const json = AnimationClip.toJSON(rebindClipForExport(clip))
  for (const track of json.tracks || []) {
    track.times = Array.from(track.times, t => round(t, TIME_DECIMALS))
    track.values = Array.from(track.values, v => round(v, VALUE_DECIMALS))
  }
  return json
}

// Turn the clip on screen plus the rig it is playing on into a storable document.
// `scene` is the retarget TARGET scene (the user's rigged mesh) — that skeleton is
// the one the clip's rotations are expressed in, so it is the one that has to
// travel with it.
export function buildCustomAnimationDocument({ clip, scene, fps = 30 }) {
  if (!clip) throw new Error('There is no animation to save.')
  if (!scene) throw new Error('The rigged mesh is not loaded, so its skeleton cannot be saved.')

  const bones = snapshotSkeleton(scene)
  if (!bones.length) throw new Error('This mesh has no bones to save the animation against.')

  const frameCount = clip.tracks?.[0]?.times?.length || 0
  return {
    version: DOCUMENT_VERSION,
    rigKey: customRigKey(bones.map(b => b.name)),
    fps,
    frameCount,
    bones,
    clip: serializeClip(clip),
  }
}

// --- deserialize ------------------------------------------------------------

// Rebuild the stored skeleton as a real bone hierarchy under a Group, with the
// same { scene, skinnedMesh, boneNames, hipName, clips } shape loadReferenceScene
// produces — so the retargeter cannot tell a saved animation from a bundled one.
//
// `skinnedMesh` is a bare { skeleton } stand-in for the same reason the Kimodo
// source uses one: retargetAnimationClip only ever reads `.skeleton` off it, and
// there is no mesh here to skin.
function buildSourceScene(bones) {
  const objects = bones.map(entry => {
    const bone = new Bone()
    bone.name = entry.name
    bone.position.fromArray(entry.position || [0, 0, 0])
    bone.quaternion.fromArray(entry.quaternion || [0, 0, 0, 1])
    bone.scale.fromArray(entry.scale || [1, 1, 1])
    return bone
  })

  const scene = new Group()
  scene.name = 'custom-animation-source'
  bones.forEach((entry, index) => {
    const parent = entry.parent >= 0 ? objects[entry.parent] : null
    ;(parent || scene).add(objects[index])
  })
  scene.updateMatrixWorld(true)

  // Bind inverses are computed from the bones' world matrices, which only exist
  // now that the hierarchy is assembled and updated — the same trap the Kimodo
  // BVH source documents: build them too early and Skeleton.pose() collapses the
  // whole rig onto the origin, quietly turning the retarget into garbage.
  const skeleton = new Skeleton(objects)
  skeleton.calculateInverses()
  return { scene, skeleton }
}

// One stored document → an animation source carrying a single clip.
export function customSourceFromDocument(document, clipName) {
  const bones = document?.bones
  if (!Array.isArray(bones) || !bones.length) {
    throw new Error('That animation has no skeleton stored with it.')
  }
  const { scene, skeleton } = buildSourceScene(bones)
  const boneNames = bones.map(b => b.name)
  return {
    scene,
    skinnedMesh: { skeleton },
    boneNames,
    hipName: detectHipBone(boneNames),
    rigKey: document.rigKey || customRigKey(boneNames),
    clips: [customClipFromDocument(document, clipName)],
  }
}

// The clip alone, for adding a second animation to a source that is already
// loaded. Only valid when the two share a rigKey — the clip is bound by bone
// name against whichever source scene is loaded, exactly as a saved Kimodo
// motion is.
export function customClipFromDocument(document, clipName) {
  if (!document?.clip) throw new Error('That animation has no stored animation data.')
  const clip = AnimationClip.parse(document.clip)
  if (clipName) clip.name = clipName
  return clip
}

// --- the library API --------------------------------------------------------

async function libraryJson(response, fallbackMessage) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || fallbackMessage)
  return body
}

export async function listCustomAnimations() {
  const body = await libraryJson(await fetch(LIBRARY_BASE), 'Could not load the saved animations')
  return body.animations || []
}

export async function saveCustomAnimation({ name, document, sourceMesh = '', sourceClip = '' } = {}) {
  const body = await libraryJson(
    await fetch(LIBRARY_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        data: document,
        sourceMesh,
        sourceClip,
        rigKey: document?.rigKey || '',
      }),
    }),
    'Could not save the animation',
  )
  return body.animation
}

export async function renameCustomAnimation(id, name) {
  const body = await libraryJson(
    await fetch(`${LIBRARY_BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    'Could not rename the animation',
  )
  return body.animation
}

export async function deleteCustomAnimation(id) {
  await libraryJson(
    await fetch(`${LIBRARY_BASE}/${id}`, { method: 'DELETE' }),
    'Could not delete the animation',
  )
}

// The stored document. Fetched only when an animation is actually applied: the
// list rows carry none of it, and a document runs to megabytes.
export async function fetchCustomAnimationDocument(id) {
  const body = await libraryJson(
    await fetch(`${LIBRARY_BASE}/${id}/data`),
    'Could not load that animation',
  )
  if (!body.data) throw new Error('That animation has no stored animation data.')
  return body.data
}
