import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { getFaceSelectionGeometry, getVertexSelectionPositions } from '../../utils/meshEditor'

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function EditorMesh({
  geometry,
  selectedFaceIndices,
  selectedVertexIndices,
  showShadows = false,
  displayMode = 'pbr',
  showWireframe = false,
  }) {
  const faceSelectionGeometry = useMemo(() => getFaceSelectionGeometry(geometry, selectedFaceIndices), [geometry, selectedFaceIndices])
  const selectedVertexPositions = useMemo(() => getVertexSelectionPositions(geometry, selectedVertexIndices), [geometry, selectedVertexIndices])
  const selectedVertexVectors = useMemo(() => {
    const vectors = []

    for (let index = 0; index < selectedVertexPositions.length; index += 3) {
      vectors.push([
        selectedVertexPositions[index],
        selectedVertexPositions[index + 1],
        selectedVertexPositions[index + 2]
      ])
    }

    return vectors
  }, [selectedVertexPositions])

  useEffect(() => () => faceSelectionGeometry?.dispose?.(), [faceSelectionGeometry])

  return (
    <group>
      <mesh
        geometry={geometry}
        castShadow={showShadows}
        receiveShadow={showShadows}
      >
        {/* Each branch carries a `key`. Without one React sees the same
            `meshStandardMaterial` element in the same slot and UPDATES the live
            material instead of building a new one — which silently breaks
            `vertexColors`, because that is a shader-compile flag and assigning
            it to an already-compiled material does nothing without
            `needsUpdate`. The weight heatmap rendered as a plain white mesh
            until these keys existed. */}
        {displayMode === 'albedo' ? (
          <meshBasicMaterial key="albedo" color="#d5d5d5" />
        ) : displayMode === 'weights' ? (
          // Weight-paint heatmap: the ramp arrives as a `color` attribute on a
          // display-only geometry (see weightPaintGeometry in MeshEditorPage).
          // Lit, so the form still reads, but rough and non-metallic so the
          // colour shown is as close to the stored weight as shading allows.
          <meshStandardMaterial key="weights" vertexColors color="#ffffff" roughness={0.95} metalness={0} />
        ) : displayMode === 'segments' ? (
          // Smart Segmentation: one flat colour per part, arriving as a `color`
          // attribute on a non-indexed display geometry (see
          // createSegmentDisplayGeometry). Lit only enough that the silhouette
          // still reads — the job here is telling two adjacent parts apart, and
          // shading gradients across a part actively work against that.
          <meshStandardMaterial key="segments" vertexColors color="#ffffff" roughness={1} metalness={0} />
        ) : displayMode === 'sculpt' ? (
          <meshStandardMaterial
            key="sculpt"
            color="#8b8b8b"
            roughness={0.82}
            metalness={0}
            flatShading={false}
          />
        ) : (
          <meshStandardMaterial
            key="pbr"
            color="#cfd8ff"
            metalness={0.08}
            roughness={0.62}
          />
        )}
      </mesh>
      {showWireframe && (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            color="#ffffff"
            wireframe
            transparent
            opacity={0.36}
            depthWrite={false}
          />
        </mesh>
      )}
      {selectedFaceIndices.length > 0 && faceSelectionGeometry?.attributes?.position?.count > 0 && (
        <mesh geometry={faceSelectionGeometry}>
          <meshBasicMaterial color="#ff9a62" transparent opacity={0.68} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {selectedVertexVectors.length > 0 && (
        <group>
          {selectedVertexVectors.map(([x, y, z], index) => (
            <mesh key={`${x}-${y}-${z}-${index}`} position={[x, y, z]}>
              <sphereGeometry args={[0.001, 8, 8]} />
              <meshBasicMaterial color="#8ff5ff" depthTest={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  )
}
