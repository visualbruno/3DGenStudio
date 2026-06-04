import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { getFaceSelectionGeometry, getVertexSelectionPositions } from '../../utils/meshEditor'

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function EditorMesh({ geometry, selectedFaceIndices, selectedVertexIndices, showShadows = false, showAlbedo = false }) {
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
      <mesh geometry={geometry} castShadow={showShadows} receiveShadow={showShadows}>
        {showAlbedo
          ? <meshBasicMaterial color="#a9b6ff" />
          : <meshStandardMaterial color="#a9b6ff" metalness={0.08} roughness={0.62} />}
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.36} />
      </mesh>
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
