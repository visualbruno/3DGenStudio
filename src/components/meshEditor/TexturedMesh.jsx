import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { getTextureKeyFromMaterial } from '../../utils/meshTexturing'

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function TexturedMesh({ root, textureKey, displayTexture, showShadows = false, showAlbedo = false }) {
  const baseObject = useMemo(() => {
    if (!root || !displayTexture) {
      return null
    }

    const object = root.clone(true)
    const materials = []

    const buildMaterial = sourceMaterial => {
      const isTargetTexture = sourceMaterial && getTextureKeyFromMaterial(sourceMaterial) === textureKey

      if (showAlbedo) {
        const params = {}
        if (sourceMaterial?.color?.isColor) {
          params.color = sourceMaterial.color.clone()
        } else if (sourceMaterial?.color) {
          params.color = new THREE.Color(sourceMaterial.color)
        } else {
          params.color = new THREE.Color('#ffffff')
        }
        const albedoMap = isTargetTexture ? displayTexture : (sourceMaterial?.map || null)
        if (albedoMap) {
          params.map = albedoMap
        }
        if (sourceMaterial?.transparent) {
          params.transparent = true
          params.opacity = sourceMaterial.opacity ?? 1
        }
        if (typeof sourceMaterial?.side === 'number') {
          params.side = sourceMaterial.side
        }
        return new THREE.MeshBasicMaterial(params)
      }

      const nextMaterial = sourceMaterial?.clone?.() || sourceMaterial
      if (nextMaterial && isTargetTexture) {
        nextMaterial.map = displayTexture
        nextMaterial.needsUpdate = true
      }
      return nextMaterial
    }

    object.traverse(child => {
      if (!child.isMesh) {
        return
      }

      child.castShadow = showShadows
      child.receiveShadow = showShadows

      if (Array.isArray(child.material)) {
        child.material = child.material.map(material => {
          const nextMaterial = buildMaterial(material)
          if (nextMaterial) {
            materials.push(nextMaterial)
          }
          return nextMaterial
        })
        return
      }

      const nextMaterial = buildMaterial(child.material)
      child.material = nextMaterial
      if (nextMaterial) {
        materials.push(nextMaterial)
      }
    })

    object.userData.meshEditorMaterials = materials
    return object
  }, [displayTexture, root, showAlbedo, showShadows, textureKey])

  useEffect(() => () => {
    baseObject?.userData?.meshEditorMaterials?.forEach(material => material?.dispose?.())
  }, [baseObject])

  return (
    <group>
      {baseObject && <primitive object={baseObject} />}
    </group>
  )
}
