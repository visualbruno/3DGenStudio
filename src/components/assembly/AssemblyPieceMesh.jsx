// One assembly piece in the viewport: its loaded graph, placed by its matrix.
//
// The sibling-group-with-an-explicit-matrix shape is the same one the mesh
// editor's Displace stamp uses (MeshEditorPage.jsx:11303-11330), and it is what
// keeps N pieces independently transformable — the thing the editor's own
// single-geometry pipeline cannot express.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { composePieceMatrix, pieceIsFlipped } from '../../utils/assemblyGeometry'

// Cached per material so display overrides are exactly reversible. Stashed on
// the material itself rather than in a Map keyed by material, because a piece's
// materials are disposed with it and a Map would keep them alive.
function rememberOriginal(material) {
  if (material.userData.assemblyOriginal) return material.userData.assemblyOriginal
  material.userData.assemblyOriginal = {
    transparent: material.transparent,
    opacity: material.opacity,
    depthWrite: material.depthWrite,
    side: material.side,
    wireframe: material.wireframe,
    depthTest: material.depthTest,
  }
  return material.userData.assemblyOriginal
}

const eachMaterial = (meshes, visit) => {
  for (const mesh of meshes) {
    const material = mesh.material
    if (Array.isArray(material)) material.forEach(visit)
    else if (material) visit(material)
  }
}

export default function AssemblyPieceMesh({
  piece,
  entry,
  matrix,          // pass identity for a fitted preview, which comes back in world space
  isSelected,
  showShadows,
}) {
  // A fitted result arrives from the service ALREADY in world space (the piece's
  // placement is baked into the payload sent up), so its preview renders with an
  // identity matrix while the original renders with the placement. Getting these
  // two the wrong way round is the easiest mistake in the feature, hence the
  // explicit prop rather than composing it here unconditionally.
  const placement = useMemo(
    () => matrix || composePieceMatrix(piece, new THREE.Matrix4()),
    [matrix, piece.position, piece.rotation, piece.scale, piece.mirrorX], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const flipped = pieceIsFlipped(piece)

  // Apply the display overrides, and restore them exactly when they go away.
  useEffect(() => {
    const meshes = entry?.meshes
    if (!meshes?.length) return undefined

    const transparent = piece.opacity < 1 || piece.xray

    eachMaterial(meshes, material => {
      const original = rememberOriginal(material)
      material.transparent = transparent || original.transparent
      material.opacity = piece.xray ? Math.min(piece.opacity, 0.28) : piece.opacity
      // A transparent surface that still writes depth hides whatever is behind
      // it — which for an x-rayed body is the entire point of x-raying it.
      material.depthWrite = transparent ? false : original.depthWrite
      material.wireframe = piece.wireframe
      // A mirrored or negatively-scaled piece has inverted winding, so its front
      // faces point away and it renders inside-out with backface culling on.
      material.side = flipped ? THREE.DoubleSide : original.side
      material.needsUpdate = true
    })

    return () => {
      eachMaterial(meshes, material => {
        const original = material.userData.assemblyOriginal
        if (!original) return
        Object.assign(material, original)
        material.needsUpdate = true
      })
    }
  }, [entry, piece.opacity, piece.xray, piece.wireframe, flipped])

  useEffect(() => {
    const meshes = entry?.meshes
    if (!meshes?.length) return
    for (const mesh of meshes) {
      mesh.castShadow = showShadows
      mesh.receiveShadow = showShadows
    }
  }, [entry, showShadows])

  if (!entry?.root) return null

  return (
    <group matrix={placement} matrixAutoUpdate={false}>
      {/* dispose={null} keeps ownership of this graph with useAssemblyScene.
          Without it R3F disposes the geometry and textures on unmount — which
          happens on every WebGL context-loss remount, and would turn a
          recoverable context loss into permanently blank pieces. */}
      <primitive object={entry.root} dispose={null} />

      {isSelected && (
        // A wireframe box rather than an outline pass: no extra render target,
        // no post-processing stack, and it reads correctly through an x-rayed
        // body. Sized from the piece's own local box so it tracks the placement.
        <box3Helper
          args={[entry.localBox, '#8ff5ff']}
          // The selection cue must be visible even when the piece is behind the
          // body, which is most of the time while fitting armour.
          onUpdate={self => { self.material.depthTest = false; self.material.transparent = true }}
        />
      )}
    </group>
  )
}
