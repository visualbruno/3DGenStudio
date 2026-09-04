// Translate / rotate / scale gizmo for the selected assembly piece.
//
// Forked from meshEditor/BoneTransformGizmo.jsx rather than generalising it:
// that one is hard-wired to mode="translate", reads a flat Float array of joint
// positions, and reports back only a position. Adding modes and full TRS to it
// would change the code path Auto Rig's bone editing depends on. The repo
// already forks this component per use — AnimationBoneGizmo.jsx is the same
// pattern.
//
// The proxy Object3D is inherited from that original and is still the right
// shape here, for a different reason: the piece's own group is driven by an
// explicit `matrix` with matrixAutoUpdate={false} (that is what lets N pieces
// hold independent placements), so TransformControls writing to its
// position/quaternion/scale would be ignored. It drives a stand-in instead, and
// the document is what actually moves.
//
// This works at all only because CameraRig's OrbitControls is `makeDefault` —
// which is how drei's TransformControls knows to suspend orbiting mid-drag — and
// because the editor leaves the LEFT mouse button unbound (CameraRig.jsx:110-114)
// for exactly this kind of tool. If anything ever binds LEFT to orbit, every
// gizmo in the app breaks.
import { useEffect, useMemo, useRef } from 'react'
import { TransformControls } from '@react-three/drei'
import * as THREE from 'three'

const _euler = new THREE.Euler()

export default function AssemblyGizmo({
  piece,
  mode = 'translate',
  space = 'world',
  snapTranslate = 0,
  snapRotateDeg = 0,
  snapScale = 0,
  onDragStart,
  onDrag,
  onDragEnd,
}) {
  const proxy = useMemo(() => new THREE.Object3D(), [])
  const draggingRef = useRef(false)

  // The proxy carries the piece's TRS, deliberately WITHOUT its mirrorX. Mirror
  // is a fixed flag on the piece, not something the gizmo should be able to drag
  // out of — and folding it in here would feed a negative determinant back
  // through decompose(), which normalises the sign onto an arbitrary axis.
  const [px, py, pz] = piece?.position || [0, 0, 0]
  const [rx, ry, rz] = piece?.rotation || [0, 0, 0]
  const [sx, sy, sz] = piece?.scale || [1, 1, 1]

  // Follow the piece — a new selection, an undo, a numeric field, Fit to region.
  // Skipped mid-drag: the transform is then coming FROM the gizmo, and writing
  // it back would fight the very drag that produced it.
  useEffect(() => {
    if (draggingRef.current) return
    proxy.position.set(px, py, pz)
    proxy.rotation.set(rx, ry, rz, 'XYZ')
    proxy.scale.set(sx, sy, sz)
    proxy.updateMatrixWorld(true)
  }, [proxy, px, py, pz, rx, ry, rz, sx, sy, sz])

  const readProxy = () => {
    _euler.setFromQuaternion(proxy.quaternion, 'XYZ')
    return {
      position: [proxy.position.x, proxy.position.y, proxy.position.z],
      rotation: [_euler.x, _euler.y, _euler.z],
      scale: [proxy.scale.x, proxy.scale.y, proxy.scale.z],
    }
  }

  if (!piece || piece.locked) return null

  return (
    <>
      <primitive object={proxy} />
      <TransformControls
        object={proxy}
        mode={mode}
        // three forces local space for scale regardless of what is passed; the
        // toolbar disables the space toggle in scale mode so the UI does not
        // claim otherwise.
        space={mode === 'scale' ? 'local' : space}
        size={0.8}
        // Snapping is built into three's TransformControls, so the whole feature
        // is three numbers in the document and no maths of our own. `null` (not
        // 0) is what disables it.
        translationSnap={snapTranslate > 0 ? snapTranslate : null}
        rotationSnap={snapRotateDeg > 0 ? THREE.MathUtils.degToRad(snapRotateDeg) : null}
        scaleSnap={snapScale > 0 ? snapScale : null}
        onMouseDown={() => {
          draggingRef.current = true
          onDragStart?.()
        }}
        onObjectChange={() => {
          // Every frame of the drag, with history suppressed — one undo entry
          // per gesture, not per frame. The commit happens on mouse-up.
          if (draggingRef.current) onDrag?.(readProxy())
        }}
        onMouseUp={() => {
          draggingRef.current = false
          onDragEnd?.(readProxy())
        }}
      />
    </>
  )
}
