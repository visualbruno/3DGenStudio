// Import animation FILES into the custom-animation library: FBX packs bought on a
// marketplace (Unity Asset Store, Mixamo, ActorCore…), animated GLBs, or BVH.
//
// This is the same idea as saving a hand-edited clip, from the other end. A clip
// on its own is not reusable — the retargeter measures every frame as a delta from
// the SOURCE rig's rest pose — so what gets stored is the clip PLUS the skeleton
// the file carries. From there an imported animation is indistinguishable from one
// saved out of the editor: it becomes a source rig, gets a bone mapping onto your
// mesh, and is retargeted by the same code as a bundled reference clip.
//
// Nothing about the retarget is FBX-specific, so the whole job here is:
//   file bytes -> { scene with bones, [AnimationClip] } -> customAnimations documents.
import { AnimationClip, Box3, Group, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { buildCustomAnimationDocument } from './customAnimations'

// What the file picker accepts. FBX is the format marketplace animation packs ship
// in; GLB covers anything exported from Blender; BVH is the mocap interchange.
export const ANIMATION_IMPORT_ACCEPT = '.fbx,.glb,.gltf,.bvh'

const fbxLoader = new FBXLoader()
const gltfLoader = new GLTFLoader()
const bvhLoader = new BVHLoader()

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || '').trim())
  return match ? match[1].toLowerCase() : ''
}

function collectBones(root) {
  const bones = []
  root.traverse(o => { if (o.isBone) bones.push(o) })
  return bones
}

// A BVH is a skeleton and one clip, with no scene around them — the bones need a
// root to hang off before their world matrices exist.
//
// `skeleton.calculateInverses()` is NOT optional: BVHLoader sets bone.position and
// never updates world matrices, so the Skeleton it hands back computed every bind
// inverse from an identity matrixWorld. Left alone, `Skeleton.pose()` — which both
// the snapshot below and the retargeter call — collapses the rig onto the origin.
// (The Kimodo source hit exactly this; see motionGen.js.)
function bvhToScene(text) {
  const { skeleton, clip } = bvhLoader.parse(text)
  const root = skeleton?.bones?.[0]
  if (!root) throw new Error('That BVH has no skeleton.')
  const scene = new Group()
  scene.name = 'imported-bvh'
  scene.add(root)
  scene.updateMatrixWorld(true)
  skeleton.calculateInverses()
  return { scene, clips: clip ? [clip] : [] }
}

function parseGlb(buffer) {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(buffer, '', gltf => resolve({ scene: gltf.scene, clips: gltf.animations || [] }),
      err => reject(err instanceof Error ? err : new Error('That glTF could not be read.')))
  })
}

// How much better the alternative orientation has to be before three's own
// (spec-compliant) choice is overruled. Small, because the two scores are far
// apart whenever the question has an answer at all.
const UPRIGHT_MARGIN = 0.15

// "Is this rig standing up?", as a number to minimise.
//
// Two things are true of every character rig and of nothing lying on its back: it
// is authored ON the origin (the lowest bone sits at y≈0, because that is the
// ground the animator posed it on), and its up axis is not its thinnest extent —
// a T-posed human is 173 wide, 161 tall and 18 deep.
function uprightScore(root) {
  root.updateMatrixWorld(true)
  const box = new Box3()
  const point = new Vector3()
  root.traverse(o => { if (o.isBone) box.expandByPoint(o.getWorldPosition(point)) })
  if (!Number.isFinite(box.min.y)) return Number.POSITIVE_INFINITY
  const size = box.getSize(new Vector3())
  const groundGap = Math.abs(box.min.y) / (size.y || 1e-6)
  const upIsThinnest = size.y <= size.x && size.y <= size.z ? 1 : 0
  return groundGap + upIsThinnest
}

// FBX files declare their up axis in GlobalSettings, and FBXLoader believes them:
// `UpAxis: 2` earns the scene a -90° X rotation. Plenty of real files lie. The
// marketplace pack that prompted this says Z-up with `OriginalUpAxis: -1` while its
// data is plainly Y-up — 161cm tall and 18cm deep once the rotation is undone — so
// the loader lays the character on its back.
//
// That is not cosmetic. The retargeter scales hip translation by
// `targetHipHeight / sourceHipHeight`, and a rig on its back has a hip height of
// ~1.7cm instead of ~98cm: a 60x multiplier that throws the mesh into the sky.
// Rest-pose matching then aligns every limb to a frame that is 90° wrong.
//
// So the loader's claim is checked rather than trusted, and only overruled when
// standing the rig up is clearly better. Returns true when it was straightened.
function straightenFbxScene(group) {
  const rotation = group.rotation
  // Only the loader's own Z-up correction is in question; anything else is the
  // file's own transform and none of our business.
  if (Math.abs(rotation.x + Math.PI / 2) > 1e-6 || rotation.y !== 0 || rotation.z !== 0) return false

  const kept = uprightScore(group)
  rotation.set(0, 0, 0)
  const undone = uprightScore(group)
  if (undone + UPRIGHT_MARGIN < kept) return true

  rotation.set(-Math.PI / 2, 0, 0)
  group.updateMatrixWorld(true)
  return false
}


// Keep only what a source rig is asked for: the rotation and position of bones that
// actually exist in this file's skeleton.
//
// Scale tracks are dropped on purpose — the retargeter reads the source bones' world
// TRANSFORMS every frame, so an animated scale would stretch the skeleton it is
// measuring against and land as a distorted delta on your mesh. Tracks addressing
// nodes that are not bones (a camera, the armature wrapper, a morph target) are
// dropped for the simpler reason that the rebuilt source is bones and nothing else.
function filterClip(clip, boneNames) {
  const tracks = clip.tracks.filter(track => {
    const match = /^(?:\.bones\[(.+?)\]|(.+?))\.(quaternion|position)$/.exec(track.name)
    return !!match && boneNames.has(match[1] ?? match[2])
  })
  if (!tracks.length) return null
  const out = new AnimationClip(clip.name, clip.duration, tracks)
  out.userData = { ...(clip.userData || {}) }
  return out
}

// Marketplace exports name clips things like "mixamo.com", "Take 001" or "Armature|
// Walk" — none of which identify the motion in a library of two hundred. The file
// name is what the buyer actually recognises, so it becomes the clip name whenever
// the embedded one carries no information; a pack with several real clip names keeps
// them, prefixed by nothing at all.
const MEANINGLESS_CLIP_NAMES = [/^mixamo\.com$/i, /^take\s*\d+$/i, /^animation\s*\d*$/i, /^default$/i, /^unnamed$/i, /^$/]

function clipLabel(clip, fileBaseName, index, total) {
  const raw = String(clip.name || '').split('|').pop().trim()
  const meaningless = MEANINGLESS_CLIP_NAMES.some(re => re.test(raw))
  if (!meaningless) return raw
  return total > 1 ? `${fileBaseName} ${index + 1}` : fileBaseName
}

// Read one file into everything the import UI needs to describe it, without writing
// anything: the caller shows the clips, the user picks, and only then are documents
// built. A pack with fifty takes should not cost fifty documents to look at.
export async function parseAnimationFile(file) {
  const extension = extensionOf(file?.name)
  const baseName = String(file?.name || 'animation').replace(/\.[^.]+$/, '')

  let parsed = null
  // Whether the file lied about its up axis and we stood it back up — the import
  // preview says so, because a rig that needed straightening is worth a second look.
  let straightened = false
  if (extension === 'fbx') {
    // FBXLoader.parse is synchronous and throws on anything it cannot read.
    const group = fbxLoader.parse(await file.arrayBuffer(), '')
    straightened = straightenFbxScene(group)
    parsed = { scene: group, clips: group.animations || [] }
  } else if (extension === 'glb' || extension === 'gltf') {
    parsed = await parseGlb(await file.arrayBuffer())
  } else if (extension === 'bvh') {
    parsed = bvhToScene(await file.text())
  } else {
    throw new Error(`${file?.name || 'That file'} is not an animation file (FBX, GLB, glTF or BVH).`)
  }

  parsed.scene.updateMatrixWorld(true)
  const bones = collectBones(parsed.scene)
  if (!bones.length) throw new Error(`${file.name} carries no skeleton, so there is nothing to retarget.`)
  const boneNames = new Set(bones.map(b => b.name))

  const clips = []
  parsed.clips.forEach((clip, index) => {
    const filtered = filterClip(clip, boneNames)
    if (!filtered || !(filtered.duration > 0)) return
    const frameCount = filtered.tracks.reduce((max, t) => Math.max(max, t.times.length), 0)
    clips.push({
      clip: filtered,
      name: clipLabel(clip, baseName, index, parsed.clips.length),
      duration: filtered.duration,
      frameCount,
      fps: filtered.duration > 0 ? (frameCount - 1) / filtered.duration : 30,
    })
  })
  if (!clips.length) throw new Error(`${file.name} contains no animation this rig can use.`)

  return {
    fileName: file.name,
    scene: parsed.scene,
    boneNames: bones.map(b => b.name),
    straightened,
    clips,
  }
}

// Turn the picked clips into storable documents. The skeleton snapshot is the same
// one a hand-edited clip is saved with, so an imported animation and a saved one are
// the same kind of thing from here on.
export function buildImportedDocuments(parsed, pickedNames = null) {
  const wanted = pickedNames ? new Set(pickedNames) : null
  return parsed.clips
    .filter(entry => !wanted || wanted.has(entry.name))
    .map(entry => ({
      name: entry.name,
      sourceMesh: parsed.fileName,
      sourceClip: entry.clip.name || entry.name,
      document: buildCustomAnimationDocument({
        clip: entry.clip,
        scene: parsed.scene,
        fps: entry.fps || 30,
        // The file's own node transforms, NOT its skin bind pose: the tracks drive
        // the nodes, and a bind pose lives in the file's raw coordinate system —
        // which is a different world from the animation whenever the up axis had
        // to be corrected above. See snapshotSkeleton.
        useBindPose: false,
      }),
    }))
}
