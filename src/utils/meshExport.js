import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { API_BASE } from '../config'

// kind 'local'  — serialized in the browser with three.js exporters. GLB is
// special-cased by the export dialog: a .glb source asset is copied
// byte-for-byte (rig, animations and textures untouched) instead of being
// round-tripped through three.js; it imports natively into Blender.
// kind 'preset' — engine-targeted FBX exports (Unity/Unreal/generic). FBX has
// no three.js exporter, so those go through the mesh-tools service, which runs
// headless Blender to convert a GLB into an engine-tuned FBX (skeleton + one
// animation take per clip). Presets are only offered when exporting from a
// mesh URL (asset library preview) — the mesh editor exports raw geometry.
export const EXPORT_FORMATS = [
  {
    value: 'glb', label: 'GLB — single file, textures embedded', extension: 'glb', multiFile: false, kind: 'local',
    hint: 'Includes the rig and every animation clip; GLB source assets are copied byte-for-byte for perfect fidelity. Imports natively into Blender (File > Import > glTF 2.0). Note: Blender’s importer may add an "Icosphere" bone-widget object — viewport dressing created at import time, not part of the file (set Bone Dir to "Temperance" to avoid it).'
  },
  {
    value: 'unity', label: 'Unity — FBX (rig + animation takes)', extension: 'fbx', multiFile: false,
    kind: 'preset', preset: 'unity', requiresService: true,
    hint: 'Drop the .fbx into Assets. Textures are embedded — use Materials > Extract Textures. Pick the rig type under Rig (Humanoid may need Enforce T-Pose); each clip appears as a separate take.'
  },
  {
    value: 'unreal', label: 'Unreal Engine — FBX (cm, rig + takes)', extension: 'fbx', multiFile: false,
    kind: 'preset', preset: 'unreal', requiresService: true,
    hint: 'Import as Skeletal Mesh with "Import Animations" enabled. The file is exported in centimeters at scale 1 — no unit conversion needed.'
  },
  {
    value: 'fbx', label: 'FBX — generic (rig + animation takes)', extension: 'fbx', multiFile: false,
    kind: 'preset', preset: 'generic', requiresService: true,
    hint: 'Neutral FBX (meters, Y-up) with the skeleton and one take per animation clip. Suitable for Godot, Maya, 3ds Max and other DCC tools.'
  },
  {
    value: 'obj', label: 'OBJ — geometry + .mtl + PBR textures', extension: 'obj', multiFile: true, kind: 'local',
    hint: 'OBJ saves geometry, materials and textures as separate files named after the mesh (e.g. mesh.obj, mesh.mtl, mesh_albedo.png). PBR materials are carried through the MTL extension — roughness (map_Pr), metallic (map_Pm), normal (norm) and AO (map_Ka); glTF meshes that pack occlusion/roughness/metalness into one texture are split into a greyscale file per channel. Import into Blender with File > Import > Wavefront (.obj).'
  },
  { value: 'ply', label: 'PLY — geometry only', extension: 'ply', multiFile: false, kind: 'local' },
  { value: 'stl', label: 'STL — geometry only', extension: 'stl', multiFile: false, kind: 'local' }
]

function defaultMaterial() {
  // White, not the viewport's placeholder tint: this colour lands in the exported
  // file as baseColorFactor, where it would multiply the mesh's real colour.
  return new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.08, roughness: 0.62 })
}

function getExtensionFromUrl(url) {
  const clean = String(url || '').split('?')[0].split('#')[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot).toLowerCase() : ''
}

// True when the URL points at a binary glTF — those sources can be exported
// byte-for-byte (or fed to the FBX converter) without a lossy three.js
// round-trip.
export function isGlbUrl(url) {
  return getExtensionFromUrl(url) === '.glb'
}

function loadWithLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject)
  })
}

// Strip any extension and reduce the name to a filesystem-safe base used for
// the mesh file and every companion (materials, textures) derived from it.
export function sanitizeBaseName(name) {
  const withoutExt = String(name || 'mesh').trim().replace(/\.[^./\\]+$/, '')
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'mesh'
}

// Load any supported mesh URL into a THREE.Object3D (with materials/textures
// when the format carries them). Used by callers that only hold a URL.
export async function loadObject3DFromUrl(url) {
  const extension = getExtensionFromUrl(url)

  if (extension === '.glb' || extension === '.gltf') {
    const gltf = await loadWithLoader(new GLTFLoader(), url)
    const scene = gltf.scene || (Array.isArray(gltf.scenes) ? gltf.scenes[0] : null)
    if (!scene) {
      throw new Error('The glTF file did not contain a scene to export.')
    }
    // Carry the clips on the object (FBXLoader's convention) so exportGlb can
    // hand them to GLTFExporter — otherwise animated assets re-export silently
    // stripped of their animations.
    scene.animations = Array.isArray(gltf.animations) ? gltf.animations : []
    return scene
  }

  if (extension === '.obj') {
    return await loadWithLoader(new OBJLoader(), url)
  }

  if (extension === '.fbx') {
    return await loadWithLoader(new FBXLoader(), url)
  }

  if (extension === '.stl') {
    const geometry = await loadWithLoader(new STLLoader(), url)
    return new THREE.Mesh(geometry, defaultMaterial())
  }

  if (extension === '.ply') {
    const geometry = await loadWithLoader(new PLYLoader(), url)
    if (!geometry.attributes.normal) {
      geometry.computeVertexNormals()
    }
    return new THREE.Mesh(geometry, defaultMaterial())
  }

  throw new Error('Unsupported mesh format')
}

// glTF packs occlusion/roughness/metalness into a single RGB texture, and
// three.js samples one channel per material slot (.r = ao, .g = roughness,
// .b = metalness). MTL's PBR extension instead expects a standalone greyscale
// map per slot, so exports extract the channel the renderer actually reads.
// Greyscale sources come through unchanged (r === g === b), so extracting is
// always safe — no need to detect whether a map is packed.
const TEXTURE_CHANNEL_OFFSET = { r: 0, g: 1, b: 2 }

// Rasterize a THREE.Texture's image into a PNG blob. Handles HTMLImageElement,
// HTMLCanvasElement and ImageBitmap sources (canvas.drawImage accepts all).
// Pass `channel` to broadcast one channel across RGB instead of copying it
// verbatim.
async function textureToPngBlob(texture, channel = null) {
  const image = texture?.image
  if (!image) {
    return null
  }

  const width = image.width || image.videoWidth || 0
  const height = image.height || image.videoHeight || 0
  if (!width || !height) {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }

  try {
    context.drawImage(image, 0, 0, width, height)
  } catch (error) {
    console.warn('Failed to rasterize texture for export:', error)
    return null
  }

  if (channel) {
    const offset = TEXTURE_CHANNEL_OFFSET[channel]
    try {
      const imageData = context.getImageData(0, 0, width, height)
      const { data } = imageData
      for (let i = 0; i < data.length; i += 4) {
        const value = data[i + offset]
        data[i] = value
        data[i + 1] = value
        data[i + 2] = value
        data[i + 3] = 255
      }
      context.putImageData(imageData, 0, 0)
    } catch (error) {
      // Tainted canvas (cross-origin texture). Writing a packed ORM map as-is
      // would have the importer read colour data as a roughness value, so drop
      // the map rather than export something wrong.
      console.warn('Failed to extract texture channel for export:', error)
      return null
    }
  }

  return await new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'))
}

function exportGlb(object, base) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      object,
      result => {
        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('Failed to export the mesh as a binary GLB file.'))
          return
        }
        resolve([{ filename: `${base}.glb`, blob: new Blob([result], { type: 'model/gltf-binary' }) }])
      },
      error => reject(error instanceof Error ? error : new Error('Failed to export the mesh as GLB.')),
      // Loader-produced clips are already node-name-addressed, so they need no
      // track renaming here — the `.bones[...]` rewrite in animationLibrary.js
      // exists only for the retargeter's mixer-bound clips.
      { binary: true, onlyVisible: false, animations: object.animations || [] }
    )
  })
}

function exportPly(object, base) {
  return new Promise((resolve, reject) => {
    try {
      new PLYExporter().parse(
        object,
        result => {
          if (!result) {
            reject(new Error('Failed to export the mesh as PLY. It may contain no geometry.'))
            return
          }
          resolve([{ filename: `${base}.ply`, blob: new Blob([result], { type: 'application/octet-stream' }) }])
        },
        { binary: true }
      )
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to export the mesh as PLY.'))
    }
  })
}

function exportStl(object, base) {
  const result = new STLExporter().parse(object, { binary: true })
  return [{ filename: `${base}.stl`, blob: new Blob([result], { type: 'model/stl' }) }]
}

// OBJExporter only emits geometry (+ `usemtl` when a material is named), so we
// generate the companion .mtl ourselves and rasterize each referenced texture.
// All companions are named after the mesh base name, e.g. dwarf.obj /
// dwarf.mtl / dwarf_albedo.png / dwarf_normal.png / dwarf_roughness.png.
// Standard materials additionally emit the MTL PBR extension keywords
// (Pr/Pm/map_Pr/map_Pm), which Blender, Substance and most modern DCC
// importers read; legacy viewers fall back to Kd/Ks/Ns and ignore the rest.
// Pick a material's primary texture to decide UV orientation.
function getPrimaryMap(material) {
  if (!material) return null
  if (Array.isArray(material)) {
    return material.map(getPrimaryMap).find(Boolean) || null
  }
  return material.map || material.emissiveMap || material.normalMap || null
}

async function exportObj(object, base) {
  // Clone the object with independent geometries and materials so we can flip
  // UVs and rename materials without mutating the live scene. Object3D.clone()
  // shares geometry/material by reference, so we replace them explicitly.
  const exportRoot = object.clone(true)
  exportRoot.updateMatrixWorld(true)

  const materialMap = new Map() // original material -> cloned material (deduped)
  const materialList = []

  exportRoot.traverse(child => {
    if (!child.isMesh || !child.geometry) {
      return
    }

    // glTF/three textures use a top-left UV origin (map.flipY === false) while
    // the OBJ format uses bottom-left, so the V coordinate must be flipped.
    // OBJ-sourced textures (flipY === true) are already bottom-left and must
    // not be flipped, so we round-trip correctly.
    const primaryMap = getPrimaryMap(child.material)
    const shouldFlipV = primaryMap ? primaryMap.flipY === false : true

    const geometry = child.geometry.clone()
    const uv = geometry.getAttribute('uv')
    if (uv && shouldFlipV) {
      for (let i = 0; i < uv.count; i += 1) {
        uv.setY(i, 1 - uv.getY(i))
      }
      uv.needsUpdate = true
    }
    // Some generated meshes (e.g. raw GLB assets) ship without normals, while
    // the mesh editor always computes them. Compute them here when missing so
    // OBJ exports are consistent (and smooth-shaded) regardless of the source.
    if (!geometry.getAttribute('normal') && geometry.getAttribute('position')) {
      geometry.computeVertexNormals()
    }
    child.geometry = geometry

    const remapMaterial = material => {
      if (!material) {
        return material
      }
      if (!materialMap.has(material)) {
        const cloned = material.clone?.() || material
        materialMap.set(material, cloned)
        materialList.push(cloned)
      }
      return materialMap.get(material)
    }
    child.material = Array.isArray(child.material)
      ? child.material.map(remapMaterial)
      : remapMaterial(child.material)
  })

  const singleMaterial = materialList.length <= 1
  // Assign deterministic names so OBJExporter's `usemtl` lines match the .mtl.
  materialList.forEach((material, index) => {
    material.name = singleMaterial ? base : `${base}_mat${index + 1}`
  })

  const objText = new OBJExporter().parse(exportRoot)
  const textureFiles = []
  const mtlLines = ['# Exported by 3DGenStudio', '']

  for (const material of materialList) {
    const materialName = material.name || base
    const texturePrefix = singleMaterial ? base : materialName

    // Rasterize the maps up front: whether an AO map survives decides the Ka
    // (ambient) value written below, so the scalars can't be emitted first.
    const mapLines = []
    const addMap = async (texture, suffix, keywords, channel = null) => {
      const blob = texture ? await textureToPngBlob(texture, channel) : null
      if (!blob) {
        return false
      }
      const filename = `${texturePrefix}_${suffix}.png`
      textureFiles.push({ filename, blob })
      keywords.forEach(keyword => mapLines.push(`${keyword} ${filename}`))
      return true
    }

    await addMap(material.map, 'albedo', ['map_Kd'])
    // `norm` is the PBR-extension keyword; `map_Bump` repeats it for importers
    // that predate the extension.
    await addMap(material.normalMap, 'normal', ['norm', 'map_Bump'])
    await addMap(material.emissiveMap, 'emissive', ['map_Ke'])
    await addMap(material.roughnessMap, 'roughness', ['map_Pr'], 'g')
    await addMap(material.metalnessMap, 'metallic', ['map_Pm'], 'b')
    // OBJ carries a single UV set, so an AO map bound to a second UV channel
    // would be sampled against the wrong coordinates — skip it in that case.
    const baseChannel = material.map?.channel ?? 0
    const aoMap = material.aoMap && (material.aoMap.channel ?? 0) === baseChannel ? material.aoMap : null
    const hasAoMap = await addMap(aoMap, 'ao', ['map_Ka'], 'r')

    // Phong/Basic materials carry neither, and must keep the legacy-only
    // output they had before — the PBR keywords would just add noise there.
    const isPbr = typeof material.roughness === 'number' || typeof material.metalness === 'number'
    const roughness = typeof material.roughness === 'number' ? material.roughness : 1
    const metalness = typeof material.metalness === 'number' ? material.metalness : 0

    mtlLines.push(`newmtl ${materialName}`)
    const color = material.color && material.color.isColor ? material.color : null
    mtlLines.push(color
      ? `Kd ${color.r.toFixed(6)} ${color.g.toFixed(6)} ${color.b.toFixed(6)}`
      : 'Kd 0.800000 0.800000 0.800000')
    // Ambient stays black unless an AO map is present, in which case Ka is the
    // multiplier that map modulates.
    mtlLines.push(hasAoMap ? 'Ka 1.000000 1.000000 1.000000' : 'Ka 0.000000 0.000000 0.000000')
    // 0.5 grey is the dielectric specular a Principled BSDF assumes, and what
    // Blender's OBJ importer reads back into its Specular input. Metals take
    // their specular tint from the base colour via Pm, so this stays neutral.
    mtlLines.push(isPbr ? 'Ks 0.500000 0.500000 0.500000' : 'Ks 0.000000 0.000000 0.000000')
    if (isPbr) {
      // Legacy specular exponent, mirroring the roughness = 1 - sqrt(Ns / 1000)
      // conversion importers apply, so viewers that only understand Ns still
      // land on the right shininess.
      mtlLines.push(`Ns ${((1 - roughness) * (1 - roughness) * 1000).toFixed(6)}`)
    }
    const opacity = typeof material.opacity === 'number' ? material.opacity : 1
    mtlLines.push(`d ${opacity.toFixed(6)}`)
    mtlLines.push('illum 2')
    if (isPbr) {
      mtlLines.push(`Pr ${roughness.toFixed(6)}`)
      mtlLines.push(`Pm ${metalness.toFixed(6)}`)
    }
    const emissive = material.emissive && material.emissive.isColor ? material.emissive : null
    if (emissive && (emissive.r || emissive.g || emissive.b)) {
      const intensity = typeof material.emissiveIntensity === 'number' ? material.emissiveIntensity : 1
      mtlLines.push(
        `Ke ${(emissive.r * intensity).toFixed(6)} ${(emissive.g * intensity).toFixed(6)} ${(emissive.b * intensity).toFixed(6)}`
      )
    }
    mtlLines.push(...mapLines)

    mtlLines.push('')
  }

  const hasMaterials = materialList.length > 0
  const mtlFilename = `${base}.mtl`
  const objBody = hasMaterials ? `mtllib ${mtlFilename}\n${objText}` : objText

  const files = [{ filename: `${base}.obj`, blob: new Blob([objBody], { type: 'text/plain' }) }]
  if (hasMaterials) {
    files.push({ filename: mtlFilename, blob: new Blob([mtlLines.join('\n')], { type: 'text/plain' }) })
  }
  files.push(...textureFiles)
  return files
}

// Serialize an Object3D into one or more files for the requested format.
// Returns [{ filename, blob }]. OBJ may return several files (obj/mtl/textures).
export async function exportObject3D(object, { format, baseName }) {
  if (!object) {
    throw new Error('No mesh is available to export.')
  }

  const base = sanitizeBaseName(baseName)
  const fmt = String(format || 'glb').toLowerCase()

  if (fmt === 'glb') return await exportGlb(object, base)
  if (fmt === 'ply') return await exportPly(object, base)
  if (fmt === 'stl') return exportStl(object, base)
  if (fmt === 'obj') return await exportObj(object, base)

  throw new Error(`Unsupported export format: ${format}`)
}

// Load a GLB Blob into an Object3D. Same job as loadObject3DFromUrl, for the
// in-memory blobs the LOD and collision services hand back — an object URL keeps
// GLTFLoader on its normal path (it resolves buffer views relative to the URL)
// and is revoked as soon as parsing finishes.
export async function loadGlbBlob(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const gltf = await loadWithLoader(new GLTFLoader(), url)
    const scene = gltf.scene || (Array.isArray(gltf.scenes) ? gltf.scenes[0] : null)
    if (!scene) {
      throw new Error('The generated glTF contained no scene.')
    }
    scene.animations = Array.isArray(gltf.animations) ? gltf.animations : []
    return scene
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Suffix a base name with its LOD level, e.g. "crate" + 2 -> "crate_LOD2".
// Unity's LODGroup and Unreal's auto-LOD import both key off this convention.
export function lodFileName(baseName, level) {
  return `${sanitizeBaseName(baseName)}_LOD${level}`
}

// Does this object carry the TEXCOORD_0 a bake needs to land on? gltfpack keeps
// UVs through simplification (-kv), so an LOD level is bakeable whenever its
// source was — but a UV-less mesh has nowhere for the maps to go, and finding
// that out after a multi-minute Blender bake is the wrong time.
export function object3DHasUvs(object) {
  let found = false
  object.traverse(child => {
    if (!found && child.isMesh && child.geometry?.attributes?.uv?.count) {
      found = true
    }
  })
  return found
}

// How many times over the used atlas may be written before the layout counts as
// unusable rather than merely untidy.
//
// Measured, and measured twice — the first attempt gated on the fraction of
// contested texels and was wrong. That statistic scales with how much of a
// layout is island *border*, which is negligible on a dense mesh and large on a
// sparse one, so it read a perfectly good 756-triangle unwrap as 18% contested
// while a 37.9k-triangle mesh read 1%. Raising the raster to 1024 moved it to
// 18.4%, which is what ruled out a rasterizing artefact: the overlap was real,
// just harmless. A threshold that separates those two cannot exist.
//
// Total written area over union area has no such bias — it asks how many times
// the atlas is painted, which is exactly the thing a bake cannot survive:
//
//   healthy 37.9k source ........ 1.01x
//   healthy 9.2k seam-preserving  1.01x
//   healthy 756 Auto UV output .. 1.24x
//   gltfpack -sa at 758 tris .... 39.6x
//
// Identical at raster 256, 512 and 1024, so it is a property of the layout and
// not of the measurement. 4x sits ~3x above the worst healthy case and ~10x
// below the broken one.
export const UV_ATLAS_WRITES_BROKEN = 4

// One place decides, because the export dialog and the mesh editor must agree on
// what "broken" means. A mesh with no UVs at all counts as broken here: for the
// callers that ask this question, the answer to both is the same unwrap.
export function uvsAreBroken(health) {
  return !health?.uvs || health.atlasWrites > UV_ATLAS_WRITES_BROKEN
}

// Is this object's UV layout still usable as a bake target?
//
// A bake writes each triangle's appearance to wherever that triangle sits in the
// atlas. If several surfaces claim the same texels the bake cannot satisfy them
// all, and the result is the kaleidoscope the aggressive simplifier leaves behind
// — the bake did its job, the layout it was given was the problem.
//
// `atlasWrites` is the figure to read and the only one gated on (see
// UV_ATLAS_WRITES_BROKEN): total UV triangle area over the area actually covered,
// i.e. how many times over the atlas gets painted. `overlap` and `spread` are
// reported because they are cheap and informative, but neither is trustworthy as
// a threshold — overlap in particular moves with mesh density.
//
// The union area comes from a raster, as it does in the Python inspect service and
// for the same reason: exact triangle-triangle area is far more work for an answer
// that agrees to within a texel. 256 is ample, and unlike the overlap fraction the
// ratio does not shift with it. Runs in ~3-35ms on meshes up to 38k triangles,
// which is nothing beside the Blender bake it protects.
export function measureUvHealth(object, { grid = 256 } = {}) {
  const hits = new Uint16Array(grid * grid)
  const densities = []
  let uvs = false
  let triangles = 0
  let writtenArea = 0

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()

  object.updateMatrixWorld(true)
  object.traverse(child => {
    const geometry = child.isMesh ? child.geometry : null
    const position = geometry?.attributes?.position
    const uv = geometry?.attributes?.uv
    if (!position?.count || !uv?.count) return
    uvs = true

    const index = geometry.index
    const count = index ? index.count : position.count
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = index ? index.getX(t) : t
      const i1 = index ? index.getX(t + 1) : t + 1
      const i2 = index ? index.getX(t + 2) : t + 2

      // World space, so a scaled node cannot skew the density figure.
      a.fromBufferAttribute(position, i0).applyMatrix4(child.matrixWorld)
      b.fromBufferAttribute(position, i1).applyMatrix4(child.matrixWorld)
      c.fromBufferAttribute(position, i2).applyMatrix4(child.matrixWorld)
      const area3d = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5

      const u0 = uv.getX(i0), v0 = uv.getY(i0)
      const u1 = uv.getX(i1), v1 = uv.getY(i1)
      const u2 = uv.getX(i2), v2 = uv.getY(i2)
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)

      triangles += 1
      // |det| / 2 is this triangle's footprint in UV space. Summed over the mesh
      // and divided by the union below, it says how many times the atlas is
      // written — the one number that separates a scrambled layout from a sparse
      // but valid one.
      const uvArea = Math.abs(det) * 0.5
      writtenArea += uvArea
      if (area3d > 1e-12 && uvArea > 1e-16) {
        densities.push(Math.sqrt(uvArea / area3d))
      }
      if (Math.abs(det) < 1e-20) continue

      // Mark every texel whose centre falls inside this UV triangle.
      const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * grid))
      const maxX = Math.min(grid - 1, Math.ceil(Math.max(u0, u1, u2) * grid))
      const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2) * grid))
      const maxY = Math.min(grid - 1, Math.ceil(Math.max(v0, v1, v2) * grid))
      for (let py = minY; py <= maxY; py += 1) {
        const y = (py + 0.5) / grid
        for (let px = minX; px <= maxX; px += 1) {
          const x = (px + 0.5) / grid
          const w0 = ((x - u0) * (v2 - v0) - (u2 - u0) * (y - v0)) / det
          const w1 = ((u1 - u0) * (y - v0) - (x - u0) * (v1 - v0)) / det
          if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) {
            const at = py * grid + px
            if (hits[at] < 65535) hits[at] += 1
          }
        }
      }
    }
  })

  if (!uvs) return { uvs: false, atlasWrites: 0, overlap: 0, spread: 0, triangles: 0 }

  let covered = 0
  let contested = 0
  for (let i = 0; i < hits.length; i += 1) {
    if (hits[i] > 0) covered += 1
    if (hits[i] > 1) contested += 1
  }
  densities.sort((x, y) => x - y)
  const at = q => densities[Math.min(densities.length - 1, Math.max(0, Math.round(q * (densities.length - 1))))] || 0
  const low = at(0.05)

  // Union of the covered atlas, from the raster. A sliver counts whole texels, so
  // this runs slightly high, which pushes atlasWrites slightly low — erring
  // towards calling a layout healthy rather than condemning a good one.
  const unionArea = covered / (grid * grid)

  return {
    uvs: true,
    triangles,
    atlasWrites: unionArea > 0 ? writtenArea / unionArea : 0,
    // Both reported, neither gated on. Overlap scales with mesh density (see
    // UV_ATLAS_WRITES_BROKEN); spread just tracks atlasWrites at a distance.
    overlap: covered ? contested / covered : 0,
    spread: low > 0 ? at(0.95) / low : 0,
  }
}

// ── Bake alignment ──────────────────────────────────────────────────────────

// Below this, the source cannot produce a usable bake and the run is refused.
// Kept in step with BakeOptions.require_overlap on the service, which applies the
// same figure to the same measure — this is the client's chance to answer in a
// millisecond instead of after a mesh upload.
export const BAKE_OVERLAP_BROKEN = 0.5
// Coverage at or above this counts as a complete bake. Not 1.0: detail that
// genuinely sticks out past the cage misses a few texels on real meshes, and
// calling that a failure would cry wolf. Well clear of the 0.46 a source offset
// by the model's half-height produced on the bake this was written for.
export const BAKE_COVERAGE_COMPLETE = 0.95
// Per-axis extent agreement (as a fraction of the target's diagonal) within which
// two boxes count as the same object at the same scale. Sized for the extremities
// simplification shaves off, which move the box without changing the object.
const BAKE_SCALE_TOLERANCE = 0.05

// Will this high-poly source actually reach the mesh we want to bake onto?
//
// A bake is ray casting: rays leave the low-poly surface and sample whatever they
// hit on the high-poly. Nothing guarantees the two are in the same space —
// snapshots share whichever space the mesh was in when they were taken, a source
// picked from the library arrives in raw file space, and moving the pivot in
// between (one click in the Game-Ready panel) separates them permanently. The
// bake then returns blank texels wherever the two stop overlapping, which against
// a dark model is invisible until it has been applied and saved.
//
// Reported as the WORST axis, not the volume ratio, because the volume ratio hides
// exactly this: a source offset along one axis still overlaps perfectly on the
// other two, so its volume ratio stays respectable while half the mesh has nothing
// to sample. `aligned` is that same measure after virtually re-centring the source,
// which is what the service will really do — so a source that only needs
// re-centring reports poor `overlap` but perfect `alignedOverlap`, and must not be
// refused. Degenerate axes (a flat plane) are skipped rather than counted as a
// total miss.
export function measureBakeOverlap(targetBox, sourceBox) {
  if (!targetBox || !sourceBox || targetBox.isEmpty() || sourceBox.isEmpty()) return null

  const targetSize = targetBox.getSize(new THREE.Vector3())
  const sourceSize = sourceBox.getSize(new THREE.Vector3())
  const diagonal = targetSize.length()
  const axes = ['x', 'y', 'z']
  const scale = Math.max(targetSize.x, targetSize.y, targetSize.z)

  const worstAxis = (offset) => axes.reduce((worst, axis) => {
    const extent = targetSize[axis]
    if (extent <= scale * 1e-4) return worst
    const span = Math.min(targetBox.max[axis], sourceBox.max[axis] + offset[axis])
      - Math.max(targetBox.min[axis], sourceBox.min[axis] + offset[axis])
    return Math.min(worst, Math.max(span, 0) / extent)
  }, 1)

  const shift = targetBox.getCenter(new THREE.Vector3()).sub(sourceBox.getCenter(new THREE.Vector3()))
  const sameScale = axes.every(axis =>
    Math.abs(targetSize[axis] - sourceSize[axis]) <= BAKE_SCALE_TOLERANCE * Math.max(diagonal, 1e-9))

  return {
    overlap: worstAxis({ x: 0, y: 0, z: 0 }),
    // Only claimed when re-centring is something the service will agree to do:
    // at a different scale it refuses to guess, so promising the alignment here
    // would wave through a bake that comes back empty.
    alignedOverlap: sameScale ? worstAxis(shift) : worstAxis({ x: 0, y: 0, z: 0 }),
    offset: shift,
    distance: shift.length(),
    sameScale,
    diagonal,
  }
}

// Would a bake against this source be a waste of minutes? Separate from the
// measure for the same reason uvsAreBroken is separate from measureUvHealth: one
// place decides what "too far apart" means.
export function bakeSourceIsMisaligned(fit) {
  return !!fit && fit.alignedOverlap < BAKE_OVERLAP_BROKEN
}

// Load one baked PNG into a texture. Data maps stay in NoColorSpace (they encode
// values, not colour) and only base colour is sRGB; flipY is false throughout to
// match the glTF convention the loader's own textures already use, and channel 0
// stops aoMap being read from the uv1 three.js otherwise defaults it to.
function textureFromBlob(blob, srgb) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    new THREE.TextureLoader().load(
      url,
      texture => {
        URL.revokeObjectURL(url)
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
        texture.flipY = false
        texture.channel = 0
        texture.needsUpdate = true
        resolve(texture)
      },
      undefined,
      error => {
        URL.revokeObjectURL(url)
        reject(error instanceof Error ? error : new Error('Could not read a baked texture.'))
      },
    )
  })
}

// Attach maps from bakeMaps() to every material on `object`, in place. Returns
// the channel names applied, for the caller's summary.
//
// This is the export-side twin of the mesh editor's "Apply to mesh", with one
// deliberate difference: base colour becomes material.map here. The editor draws
// it into its paint canvas because that canvas IS its base colour — an exported
// LOD has no canvas, so the baked albedo has to become the texture itself.
export async function attachBakedMaps(object, maps, { ormChannels = [] } = {}) {
  const applied = []

  const assign = (slot, texture, tweak = null) => {
    object.traverse(child => {
      if (!child.isMesh) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach(material => {
        if (!material) return
        material[slot] = texture
        tweak?.(material)
        material.needsUpdate = true
      })
    })
  }

  if (maps.normal) {
    assign('normalMap', await textureFromBlob(maps.normal, false))
    applied.push('normal')
  }

  // Prefer the packed ORM: one texture object across all three slots is the glTF
  // layout, and it lets GLTFExporter skip recompositing the channels (it early
  // returns when metalnessMap === roughnessMap).
  if (maps.orm && ormChannels.length) {
    const texture = await textureFromBlob(maps.orm, false)
    if (ormChannels.includes('ao')) assign('aoMap', texture)
    // A *Map is multiplied by its scalar factor, so a source material carrying
    // roughness 0.5 would halve every baked value. glTF sets those factors to 1
    // whenever a texture is present — match it.
    if (ormChannels.includes('roughness')) assign('roughnessMap', texture, m => { m.roughness = 1 })
    if (ormChannels.includes('metallic')) assign('metalnessMap', texture, m => { m.metalness = 1 })
    applied.push(`packed ${ormChannels.join('/')}`)
  } else {
    // Fewer than two of ao/roughness/metallic were baked, so no ORM came back.
    if (maps.ao) {
      assign('aoMap', await textureFromBlob(maps.ao, false))
      applied.push('ao')
    }
    if (maps.roughness) {
      assign('roughnessMap', await textureFromBlob(maps.roughness, false), m => { m.roughness = 1 })
      applied.push('roughness')
    }
    if (maps.metallic) {
      assign('metalnessMap', await textureFromBlob(maps.metallic, false), m => { m.metalness = 1 })
      applied.push('metallic')
    }
  }

  if (maps.base_color) {
    // The bake already carries the source's base-colour factor, so a tinted
    // factor left on the material would apply it a second time.
    assign('map', await textureFromBlob(maps.base_color, true), m => { m.color?.setRGB(1, 1, 1) })
    applied.push('base colour')
  }

  return applied
}

// Merge collision hulls into the render mesh as Unreal-convention UCX nodes.
//
// Unreal only recognises collision that ships INSIDE the same file as the render
// mesh, under a node named `UCX_<RenderMeshName>_##`. So this renames the render
// mesh to the export base name, renames each hull to match, and returns a single
// GLB — which the Unreal preset then converts to FBX like any other source.
//
// Hull materials are dropped: Unreal ignores them, and leaving them in adds
// meaningless material slots to the imported asset.
export async function mergeCollisionForUnreal(sourceGlbBlob, collisionGlbBlob, baseName) {
  const base = sanitizeBaseName(baseName)
  const [source, collision] = await Promise.all([
    loadGlbBlob(sourceGlbBlob),
    loadGlbBlob(collisionGlbBlob),
  ])

  // Name the render mesh — UCX matching is by name, so an unnamed or
  // auto-numbered mesh silently breaks the association.
  let renamed = false
  source.traverse(child => {
    if (!renamed && child.isMesh) {
      child.name = base
      renamed = true
    }
  })

  const hulls = []
  collision.traverse(child => {
    if (child.isMesh) hulls.push(child)
  })
  hulls.forEach((hull, index) => {
    hull.name = `UCX_${base}_${String(index + 1).padStart(2, '0')}`
    // Detach from the collision scene graph but keep world placement.
    hull.updateWorldMatrix(true, false)
    hull.matrix.copy(hull.matrixWorld)
    hull.matrix.decompose(hull.position, hull.quaternion, hull.scale)
    source.add(hull)
  })

  const files = await exportGlb(source, base)
  return { blob: files[0].blob, hullCount: hulls.length }
}

// POST the generated files to the server, which writes them into the
// user-chosen folder on disk.
export async function writeExportedFiles(folder, files) {
  const formData = new FormData()
  formData.append('folder', folder)
  for (const file of files) {
    formData.append('files', file.blob, file.filename)
  }

  const response = await fetch(`${API_BASE}/export/mesh`, { method: 'POST', body: formData })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to write the exported files.')
  }
  return data
}

// Folder browser API used by the export dialog's folder picker.
export async function browseFolders(path) {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await fetch(`${API_BASE}/filesystem/folders${query}`)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to browse folders.')
  }
  return data
}
