// A small, self-contained 3D skeleton viewer used inside the Bone-mapping modal
// so you can rotate a rig and click its bones to see where each one is (helpful
// when a bone's name alone doesn't tell you which limb it drives).
//
// IMPORTANT: it renders from the PLAIN data returned by
// `extractSkeletonFromObject` (joints/segments/names), NOT the live THREE scene.
// The reference/target scenes are shared objects also used for retargeting and
// preview — dropping them into another <Canvas> via <primitive> would reparent
// them and break those flows. Rebuilding the bones as our own geometry (like
// SkeletonOverlay does) keeps the source objects untouched.
import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'

const BONE_COLOR = '#6c8cff'
const JOINT_COLOR = '#c9d4ff'
const MAPPED_COLOR = '#5ad19a'
const SELECTED_COLOR = '#8ff5ff'

// Bounds (center + radius) of the skeleton's joints, for camera framing.
function computeBounds(joints) {
  const box = new THREE.Box3()
  const p = new THREE.Vector3()
  for (let i = 0; i < joints.length; i += 3) {
    box.expandByPoint(p.set(joints[i], joints[i + 1], joints[i + 2]))
  }
  if (box.isEmpty()) return { center: [0, 0, 0], radius: 1 }
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.getSize(p).length() * 0.5, 1e-3)
  return { center: [center.x, center.y, center.z], radius }
}

function Scene({ skeleton, selectedBone, mappedBones, onSelectBone }) {
  const { center, radius } = useMemo(() => computeBounds(skeleton.joints), [skeleton])

  const lineGeometry = useMemo(() => {
    if (!skeleton.segments?.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(skeleton.segments, 3))
    return geo
  }, [skeleton])

  const jointRadius = Math.max(radius * 0.025, 1e-4)
  const hitRadius = Math.max(radius * 0.06, jointRadius * 2)

  // Camera framed from the front, a little above center.
  const dist = radius * 2.6
  const camPos = [center[0], center[1] + radius * 0.15, center[2] + dist]

  const selectedIndex = selectedBone == null
    ? -1
    : skeleton.names.findIndex(n => n === selectedBone)

  return (
    <>
      <PerspectiveCamera makeDefault position={camPos} fov={40} near={radius * 0.01} far={radius * 40} />
      <OrbitControls target={center} enablePan={false} makeDefault />
      <ambientLight intensity={0.9} />

      {lineGeometry && (
        <lineSegments geometry={lineGeometry}>
          <lineBasicMaterial color={BONE_COLOR} transparent opacity={0.85} />
        </lineSegments>
      )}

      {skeleton.names.map((name, i) => {
        const x = skeleton.joints[i * 3]
        const y = skeleton.joints[i * 3 + 1]
        const z = skeleton.joints[i * 3 + 2]
        const isSelected = i === selectedIndex
        const isMapped = mappedBones?.has(name)
        const color = isSelected ? SELECTED_COLOR : isMapped ? MAPPED_COLOR : JOINT_COLOR
        return (
          <group key={`${name}_${i}`} position={[x, y, z]}>
            {/* Visible joint dot */}
            <mesh>
              <sphereGeometry args={[isSelected ? jointRadius * 1.7 : jointRadius, 12, 12]} />
              <meshBasicMaterial color={color} />
            </mesh>
            {/* Larger invisible hit target so small joints are easy to click */}
            <mesh
              onClick={e => { e.stopPropagation(); onSelectBone(name) }}
              onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'pointer' }}
              onPointerOut={() => { document.body.style.cursor = '' }}
            >
              <sphereGeometry args={[hitRadius, 8, 8]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            {isSelected && (
              <Html center zIndexRange={[20, 0]} className="mesh-editor-bonemap-view__label-anchor">
                <div className="mesh-editor-bonemap-view__label">{name}</div>
              </Html>
            )}
          </group>
        )
      })}
    </>
  )
}

export default function BoneSkeletonView({
  title,
  skeleton,
  selectedBone = null,
  mappedBones = null,
  onSelectBone,
  onBackgroundClick,
}) {
  const hasBones = skeleton && skeleton.names?.length
  return (
    <div className="mesh-editor-bonemap-view">
      <div className="mesh-editor-bonemap-view__head">
        <span className="mesh-editor-bonemap-view__title">{title}</span>
        <span className="mesh-editor-bonemap-view__selected">
          {selectedBone || 'Click / hover a bone'}
        </span>
      </div>
      <div className="mesh-editor-bonemap-view__canvas">
        {hasBones ? (
          <Canvas
            dpr={[1, 2]}
            gl={{ antialias: true, alpha: true }}
            frameloop="demand"
            onPointerMissed={() => onBackgroundClick?.()}
          >
            <Scene
              skeleton={skeleton}
              selectedBone={selectedBone}
              mappedBones={mappedBones}
              onSelectBone={onSelectBone}
            />
          </Canvas>
        ) : (
          <div className="mesh-editor-bonemap-view__empty">No skeleton</div>
        )}
      </div>
    </div>
  )
}
