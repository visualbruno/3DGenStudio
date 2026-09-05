// The landmark pairs, drawn in the viewport.
//
// Two spheres per pair, one colour per side, joined by a line. The line is what
// makes the pair legible: two loose dots say nothing about which body point an
// armour point was matched to, and a mismatched pair is the single most likely
// reason a warp comes out wrong.
//
// Drawn with depthTest off so a pair on the far side of the body still reads —
// the alternative is the user re-placing points they already placed because
// they cannot see them.
import { useMemo } from 'react'
import * as THREE from 'three'
import { composePieceMatrix } from '../../utils/assemblyGeometry'

// Radius is derived from the scene, never hardcoded. EditorMesh uses a fixed
// 0.001, which is invisible on a 100-unit mesh and a boulder on a 0.02-unit one.
const RADIUS_FRACTION = 0.012

const BASE_COLOUR = '#4fc3f7'
const PIECE_COLOUR = '#ffb74d'
const PENDING_COLOUR = '#81c784'

function toWorld(landmark, piece) {
  if (!landmark) return null
  // Stored in the mesh's OWN local space, so the current placement is applied
  // here rather than baked in when the point was picked — which is exactly what
  // lets a piece be moved after its landmarks are placed.
  return new THREE.Vector3(...landmark.point)
    .applyMatrix4(composePieceMatrix(piece, new THREE.Matrix4()))
}

export default function LandmarkMarkers({
  base, piece, pendingBase, hoveredPairId, diagonal,
}) {
  const radius = Math.max((diagonal || 1) * RADIUS_FRACTION, 1e-4)

  const pairs = useMemo(() => {
    if (!base || !piece) return []
    return (piece.landmarks || []).map((pair, index) => ({
      id: pair.id,
      index: index + 1,
      base: toWorld(pair.base, base),
      piece: toWorld(pair.piece, piece),
    }))
  }, [base, piece])

  const pending = useMemo(
    () => (pendingBase && base ? toWorld(pendingBase, base) : null),
    [pendingBase, base])

  if (!pairs.length && !pending) return null

  return (
    <group>
      {pairs.map(pair => {
        const highlighted = pair.id === hoveredPairId
        const scale = highlighted ? 1.6 : 1
        return (
          <group key={pair.id}>
            {pair.base && (
              <mesh position={pair.base}>
                <sphereGeometry args={[radius * scale, 16, 12]} />
                <meshBasicMaterial color={BASE_COLOUR} depthTest={false} transparent opacity={0.95} />
              </mesh>
            )}
            {pair.piece && (
              <mesh position={pair.piece}>
                <sphereGeometry args={[radius * scale, 16, 12]} />
                <meshBasicMaterial color={PIECE_COLOUR} depthTest={false} transparent opacity={0.95} />
              </mesh>
            )}
            {pair.base && pair.piece && (
              <Link from={pair.base} to={pair.piece} highlighted={highlighted} />
            )}
          </group>
        )
      })}

      {/* The half-placed pair: one point down, waiting for its partner. */}
      {pending && (
        <mesh position={pending}>
          <sphereGeometry args={[radius * 1.4, 16, 12]} />
          <meshBasicMaterial color={PENDING_COLOUR} depthTest={false} transparent opacity={0.95} />
        </mesh>
      )}
    </group>
  )
}

function Link({ from, to, highlighted }) {
  // Rebuilt when either end moves. Cheap — two points — and a mutable
  // BufferGeometry shared across renders would need manual disposal anyway.
  const geometry = useMemo(
    () => new THREE.BufferGeometry().setFromPoints([from, to]),
    [from, to])
  return (
    <line>
      <primitive object={geometry} attach="geometry" />
      <lineBasicMaterial
        color={highlighted ? '#ffffff' : PIECE_COLOUR}
        depthTest={false}
        transparent
        opacity={highlighted ? 1 : 0.6}
      />
    </line>
  )
}
