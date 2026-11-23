import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { getTextureKeyFromMaterial } from '../../utils/meshTexturing'
import { applyPbrMapsToMaterial } from '../../utils/pbrMaterial'

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function TexturedMesh({
  root,
  textureKey,
  displayTexture,
  showShadows = false,
  displayMode = 'pbr',
  showWireframe = false,
  // Display-only material channels layered over the clone (the PBR tool's
  // preview): { map?, normalMap?, roughnessMap?, metalnessMap?, aoMap? }. Never
  // written back to `root`, so a preview cannot leak into a save.
  overrideMaps = null,
  }) {
  const baseObject = useMemo(() => {
    if (!root || !displayTexture) {
      return null
    }

    const object = root.clone(true)
    const materials = []

    const buildMaterial = (sourceMaterial, child) => {
      const isTargetTexture = sourceMaterial && getTextureKeyFromMaterial(sourceMaterial) === textureKey

      if (displayMode === 'albedo') {
        const params = {}
        if (sourceMaterial?.color?.isColor) {
          params.color = sourceMaterial.color.clone()
        } else if (sourceMaterial?.color) {
          params.color = new THREE.Color(sourceMaterial.color)
        } else {
          params.color = new THREE.Color('#ffffff')
        }
        const albedoMap = isTargetTexture ? (overrideMaps?.map || displayTexture) : (sourceMaterial?.map || null)
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

      if (displayMode === 'sculpt') {
        const params = {
          color: new THREE.Color('#6f6f6f'),
          roughness: 0.78,
          metalness: 0,
          wireframe: showWireframe,
        }

        return new THREE.MeshStandardMaterial(params)
      }

      const nextMaterial = sourceMaterial?.clone?.() || sourceMaterial
      if (nextMaterial && isTargetTexture) {
        nextMaterial.map = displayTexture
        if (overrideMaps) applyPbrMapsToMaterial(nextMaterial, overrideMaps, child?.geometry)
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
          const nextMaterial = buildMaterial(material, child)
          if (nextMaterial) {
            materials.push(nextMaterial)
          }
          return nextMaterial
        })
        return
      }

      const nextMaterial = buildMaterial(child.material, child)
      child.material = nextMaterial
      if (nextMaterial) {
        materials.push(nextMaterial)
      }
    })

    object.userData.meshEditorMaterials = materials
    return object
  }, [displayMode, displayTexture, root, showShadows, showWireframe, textureKey, overrideMaps])

  useEffect(() => () => {
    baseObject?.userData?.meshEditorMaterials?.forEach(material => material?.dispose?.())
  }, [baseObject])

  return (
    <group>
      {baseObject && <primitive object={baseObject} />}
    </group>
  )
}
