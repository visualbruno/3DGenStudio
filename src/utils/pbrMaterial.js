// three.js side of the PBR tool: turning the byte maps from pbrFromAlbedo.js
// into textures, putting them on materials the way glTF expects, and taking
// them off again. The maths itself lives in pbrFromAlbedo.js (pure, testable).
import * as THREE from 'three'
import { createCanvasTexture, mapUvToCanvasPoint } from './meshTexturing'
import { extractChannel, rasterizeUvCoverage } from './pbrFromAlbedo'
import { setGltfNormalMap } from './normalMapConvention'

export const PBR_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']


// Put any of { map, normalMap, roughnessMap, metalnessMap, aoMap } on a
// material. The normal map's sign follows normalMapConvention.js. A packed ORM texture goes in all three of its slots as the SAME
// object — that is how GLTFExporter recognises it and writes one
// metallicRoughness texture instead of recompositing. Scalars that multiply a
// map are set to 1, as glTF does when a texture is present (the editor's
// placeholder material carries roughness 0.62 / metalness 0.08, which would
// otherwise scale the maps down).
export function applyPbrMapsToMaterial(material, maps, geometry = null) {
  if (!material || !maps) return material
  if (maps.map) material.map = maps.map
  if (maps.normalMap) setGltfNormalMap(material, maps.normalMap, geometry, 1)
  if (maps.roughnessMap && 'roughnessMap' in material) {
    material.roughnessMap = maps.roughnessMap
    material.roughness = 1
  }
  if (maps.metalnessMap && 'metalnessMap' in material) {
    material.metalnessMap = maps.metalnessMap
    material.metalness = 1
  }
  if (maps.aoMap && 'aoMap' in material) {
    material.aoMap = maps.aoMap
    material.aoMapIntensity = 1
  }
  material.needsUpdate = true
  return material
}

function forEachMeshMaterial(root, fn) {
  root?.traverse(child => {
    if (!child.isMesh) return
    const list = Array.isArray(child.material) ? child.material : [child.material]
    list.forEach(material => { if (material) fn(material, child) })
  })
}

export function applyPbrMapsToRoot(root, maps) {
  forEachMeshMaterial(root, (material, child) => applyPbrMapsToMaterial(material, maps, child.geometry))
}

// Everything applyPbrMapsToMaterial may change, per material, so Revert can
// put it back exactly.
export function snapshotPbrMaterials(root) {
  const entries = []
  forEachMeshMaterial(root, material => {
    entries.push({
      material,
      normalMap: material.normalMap ?? null,
      normalScale: material.normalScale?.clone?.() ?? null,
      roughnessMap: material.roughnessMap ?? null,
      roughness: material.roughness,
      metalnessMap: material.metalnessMap ?? null,
      metalness: material.metalness,
      aoMap: material.aoMap ?? null,
      aoMapIntensity: material.aoMapIntensity,
    })
  })
  return { root, entries }
}

export function restorePbrMaterials(snapshot) {
  snapshot?.entries?.forEach(entry => {
    const { material } = entry
    if ('normalMap' in material) material.normalMap = entry.normalMap
    if (entry.normalScale && material.normalScale) material.normalScale.copy(entry.normalScale)
    if ('roughnessMap' in material) material.roughnessMap = entry.roughnessMap
    if (entry.roughness !== undefined) material.roughness = entry.roughness
    if ('metalnessMap' in material) material.metalnessMap = entry.metalnessMap
    if (entry.metalness !== undefined) material.metalness = entry.metalness
    if ('aoMap' in material) material.aoMap = entry.aoMap
    if (entry.aoMapIntensity !== undefined) material.aoMapIntensity = entry.aoMapIntensity
    material.needsUpdate = true
  })
}

// Which PBR channels the mesh already carries, for the "Applying replaces…"
// warning. Named the way the panel lists them.
export function existingPbrMaps(root) {
  const found = new Set()
  forEachMeshMaterial(root, material => {
    if (material.normalMap) found.add('a normal map')
    if (material.roughnessMap) found.add('a roughness map')
    if (material.metalnessMap) found.add('a metalness map')
    if (material.aoMap) found.add('an AO map')
  })
  return [...found]
}

// A data texture (normal / ORM) laid out exactly like the albedo it was derived
// from — same wrap, UV transform and flipY — but read linearly, not as sRGB.
export function createPbrDataTexture(canvas, textureConfig, name) {
  const texture = createCanvasTexture(canvas, textureConfig)
  texture.colorSpace = THREE.NoColorSpace
  texture.channel = 0
  texture.name = name
  texture.needsUpdate = true
  return texture
}

export function bytesToCanvas(bytes, width, height, canvas = null) {
  const target = canvas || document.createElement('canvas')
  if (target.width !== width) target.width = width
  if (target.height !== height) target.height = height
  target.getContext('2d').putImageData(new ImageData(bytes, width, height), 0, 0)
  return target
}

// Which texels of a `width` x `height` texture some UV triangle of `root`
// covers. Uses the same UV → pixel mapping as painting (wrap, repeat, offset,
// flipY), so the mask lines up with the texture canvas.
export function computeUvCoverage(root, width, height, textureConfig = null) {
  let mask = new Uint8Array(width * height)
  const uv = new THREE.Vector2()
  root?.traverse(child => {
    const attribute = child.isMesh ? child.geometry?.attributes?.uv : null
    if (!attribute?.count) return
    const pixels = new Float32Array(attribute.count * 2)
    for (let i = 0; i < attribute.count; i += 1) {
      uv.set(attribute.getX(i), attribute.getY(i))
      const point = mapUvToCanvasPoint(uv, width, height, textureConfig)
      pixels[i * 2] = point.x
      pixels[i * 2 + 1] = point.y
    }
    mask = rasterizeUvCoverage(pixels, child.geometry.index?.array || null, width, height, mask)
  })
  return mask
}

// A small preview image (data URL) of a canvas.
export function canvasThumbnail(canvas, size = 128) {
  const thumb = document.createElement('canvas')
  const ratio = Math.min(1, size / Math.max(canvas.width, canvas.height))
  thumb.width = Math.max(1, Math.round(canvas.width * ratio))
  thumb.height = Math.max(1, Math.round(canvas.height * ratio))
  const context = thumb.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, thumb.width, thumb.height)
  return thumb.toDataURL('image/png')
}

// The same for a byte map — or for one channel of it, spread to grey, for the
// packed ORM.
export function mapThumbnail(bytes, width, height, channel = null, size = 128) {
  const source = channel === null ? bytes : extractChannel(bytes, channel)
  return canvasThumbnail(bytesToCanvas(source, width, height), size)
}
