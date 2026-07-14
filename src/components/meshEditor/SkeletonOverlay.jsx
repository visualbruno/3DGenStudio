// Renders a skeleton as an overlay inside the mesh-editor <Canvas>: orange bone
// segments (parent→child) plus a dot at each joint, drawn on top of the mesh so
// the rig is visible through the surface (like a DCC armature view). Fed by the
// plain data from utils/meshEditor.js `extractSkeletonFromObject`.
//
// When a bone is selected (from the Skeleton tree or by clicking it on the mesh)
// it is highlighted with a bright marker and a small floating name label that
// tracks the joint as the camera orbits.
import { useEffect, useMemo } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

const BONE_COLOR = '#f0913c'
const JOINT_COLOR = '#ffd9a0'
const SELECTED_COLOR = '#8ff5ff'

export default function SkeletonOverlay({ skeleton, visible = true, selectedBone = null }) {
  const lineGeometry = useMemo(() => {
    if (!skeleton?.segments?.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(skeleton.segments, 3))
    return geo
  }, [skeleton])

  const jointGeometry = useMemo(() => {
    if (!skeleton?.joints?.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(skeleton.joints, 3))
    return geo
  }, [skeleton])

  // Size joint dots relative to the skeleton's extent so they read on any scale.
  const jointSize = useMemo(() => Math.max((skeleton?.size || 1) * 0.02, 1e-4), [skeleton])
  const markerRadius = useMemo(() => Math.max((skeleton?.size || 1) * 0.018, 1e-4), [skeleton])

  // World position + name of the highlighted joint (if any).
  const selected = useMemo(() => {
    if (selectedBone == null || !skeleton?.joints) return null
    const i = selectedBone
    if (i < 0 || i * 3 + 2 >= skeleton.joints.length) return null
    return {
      position: [skeleton.joints[i * 3], skeleton.joints[i * 3 + 1], skeleton.joints[i * 3 + 2]],
      name: skeleton.names?.[i] || `bone_${i}`,
    }
  }, [selectedBone, skeleton])

  useEffect(() => () => {
    lineGeometry?.dispose()
    jointGeometry?.dispose()
  }, [lineGeometry, jointGeometry])

  if (!visible || (!lineGeometry && !jointGeometry)) return null

  return (
    <group renderOrder={40}>
      {lineGeometry && (
        <lineSegments geometry={lineGeometry} renderOrder={40}>
          <lineBasicMaterial
            color={BONE_COLOR}
            transparent
            opacity={0.95}
            depthTest={false}
            depthWrite={false}
          />
        </lineSegments>
      )}
      {jointGeometry && (
        <points geometry={jointGeometry} renderOrder={41}>
          <pointsMaterial
            color={JOINT_COLOR}
            size={jointSize}
            sizeAttenuation
            transparent
            opacity={1}
            depthTest={false}
            depthWrite={false}
          />
        </points>
      )}
      {selected && (
        <group position={selected.position} renderOrder={42}>
          <mesh renderOrder={42}>
            <sphereGeometry args={[markerRadius, 16, 16]} />
            <meshBasicMaterial
              color={SELECTED_COLOR}
              transparent
              opacity={0.95}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
          <Html center zIndexRange={[20, 0]} className="mesh-editor-bone-label__anchor">
            <div className="mesh-editor-bone-label">{selected.name}</div>
          </Html>
        </group>
      )}
    </group>
  )
}
