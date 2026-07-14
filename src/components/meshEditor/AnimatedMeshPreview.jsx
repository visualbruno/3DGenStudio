// Plays a retargeted animation clip on the user's rigged mesh inside the
// mesh-editor <Canvas>. Renders the target skinned scene (loaded from the rigged
// GLB) and drives it with an AnimationMixer. Shown in Auto Rig mode while an
// animation is selected, in place of the static EditorMesh.
//
// Auto-align to floor is a ONE-TIME offset (`floorOffset`): the whole rig is
// lifted by a constant so its rest pose sits on the grid. It is NOT a per-frame
// foot lock — animations keep their natural motion (jumps leave the ground,
// crouches lower), driven by the retargeted hip-position track.
//
// Expand/Contract arms is a live post-mixer additive rotation on the upper-arm
// bones about the spread axis (cross of the arm direction and world up), so it
// raises/lowers the arms sideways regardless of the rig's bone orientation.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const _p0 = new THREE.Vector3()
const _p1 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _delta = new THREE.Quaternion()
const _bw = new THREE.Quaternion()
const _pq = new THREE.Quaternion()

export default function AnimatedMeshPreview({
  object, mixerRoot, clip, playing = true, timeScale = 1,
  alignFloor = true, floorOffset = 0, armExtension = 0, armTargets = null,
}) {
  const mixerRef = useRef(null)
  const actionRef = useRef(null)
  const groupRef = useRef(null)

  // Retargeted clips use ".bones[name]" track paths, which the mixer can only
  // resolve against a node that has a `.skeleton` — i.e. the SkinnedMesh, not the
  // wrapping scene. Render the whole scene but drive the SkinnedMesh.
  const root = mixerRoot || object
  const mixer = useMemo(() => (root ? new THREE.AnimationMixer(root) : null), [root])

  // Upper-arm bones (+ their child, for the arm-direction) for the arm control.
  const armBones = useMemo(() => {
    const skeleton = mixerRoot?.skeleton
    if (!skeleton || !armTargets) return []
    const names = [...(armTargets.left || []), ...(armTargets.right || [])]
    return names.map(n => {
      const bone = skeleton.getBoneByName(n)
      if (!bone) return null
      return { bone, child: bone.children.find(c => c.isBone) || null }
    }).filter(Boolean)
  }, [mixerRoot, armTargets])

  useEffect(() => {
    mixerRef.current = mixer
    return () => {
      mixer?.stopAllAction()
      if (mixer && root) mixer.uncacheRoot(root)
    }
  }, [mixer, root])

  useEffect(() => {
    const m = mixerRef.current
    if (!m) return undefined
    m.stopAllAction()
    if (!clip) { actionRef.current = null; return undefined }
    const action = m.clipAction(clip)
    action.reset()
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.clampWhenFinished = false
    action.play()
    actionRef.current = action
    return () => { action.stop(); m.uncacheAction(clip) }
  }, [clip])

  useEffect(() => {
    const action = actionRef.current
    if (action) action.paused = !playing
  }, [playing])
  useEffect(() => {
    if (mixerRef.current) mixerRef.current.timeScale = timeScale
  }, [timeScale])

  useFrame((_, delta) => {
    const m = mixerRef.current
    if (m) m.update(delta)

    // Additive arm expand/contract: rotate each upper arm about the axis
    // perpendicular to the arm and world-up, so positive spreads the arms outward
    // and negative tucks them in — independent of the rig's bone orientation.
    const angle = armExtension / 100
    if (angle && armBones.length) {
      groupRef.current?.updateMatrixWorld(true)
      for (const { bone, child } of armBones) {
        if (!child) continue
        bone.getWorldPosition(_p0)
        child.getWorldPosition(_p1)
        _dir.subVectors(_p1, _p0)
        if (_dir.lengthSq() < 1e-10) continue
        _axis.crossVectors(_dir.normalize(), _up)
        if (_axis.lengthSq() < 1e-10) continue
        _axis.normalize()
        _delta.setFromAxisAngle(_axis, angle)
        bone.getWorldQuaternion(_bw)
        bone.parent.getWorldQuaternion(_pq).invert()
        bone.quaternion.copy(_pq.multiply(_delta.multiply(_bw))).normalize()
        bone.updateMatrixWorld(true)
      }
    }
  })

  if (!object) return null
  return (
    <group ref={groupRef} position={[0, alignFloor ? floorOffset : 0, 0]}>
      <primitive object={object} />
    </group>
  )
}
