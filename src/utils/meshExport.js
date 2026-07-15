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

// kind 'local'  — serialized in the browser with three.js exporters.
// kind 'preset' — engine-targeted exports (Blender/Unity/Unreal). FBX has no
// three.js exporter, so those go through the mesh-tools service, which runs
// headless Blender to convert a GLB into an engine-tuned FBX (skeleton + one
// animation take per clip). Presets are only offered when exporting from a
// mesh URL (asset library preview) — the mesh editor exports raw geometry.
export const EXPORT_FORMATS = [
  { value: 'glb', label: 'GLB — single file, textures embedded', extension: 'glb', multiFile: false, kind: 'local' },
  {
    value: 'blender', label: 'Blender — GLB (rig + animations)', extension: 'glb', multiFile: false,
    kind: 'preset', preset: 'blender', requiresService: false,
    hint: 'Blender imports GLB natively (File > Import > glTF 2.0) with the skeleton and every animation clip. GLB source assets are copied byte-for-byte for perfect fidelity.'
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
    value: 'obj', label: 'OBJ — geometry + .mtl + textures', extension: 'obj', multiFile: true, kind: 'local',
    hint: 'OBJ saves geometry, materials and textures as separate files named after the mesh (e.g. mesh.obj, mesh.mtl, mesh_albedo.png).'
  },
  { value: 'ply', label: 'PLY — geometry only', extension: 'ply', multiFile: false, kind: 'local' },
  { value: 'stl', label: 'STL — geometry only', extension: 'stl', multiFile: false, kind: 'local' }
]

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({ color: '#cfd8ff', metalness: 0.08, roughness: 0.62 })
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

// Rasterize a THREE.Texture's image into a PNG blob. Handles HTMLImageElement,
// HTMLCanvasElement and ImageBitmap sources (canvas.drawImage accepts all).
async function textureToPngBlob(texture) {
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
// dwarf.mtl / dwarf_albedo.png / dwarf_normal.png.
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

    mtlLines.push(`newmtl ${materialName}`)
    const color = material.color && material.color.isColor ? material.color : null
    mtlLines.push(color
      ? `Kd ${color.r.toFixed(6)} ${color.g.toFixed(6)} ${color.b.toFixed(6)}`
      : 'Kd 0.800000 0.800000 0.800000')
    mtlLines.push('Ka 0.000000 0.000000 0.000000')
    mtlLines.push('Ks 0.000000 0.000000 0.000000')
    const opacity = typeof material.opacity === 'number' ? material.opacity : 1
    mtlLines.push(`d ${opacity.toFixed(6)}`)
    mtlLines.push('illum 2')

    const albedoBlob = material.map ? await textureToPngBlob(material.map) : null
    if (albedoBlob) {
      const filename = `${texturePrefix}_albedo.png`
      textureFiles.push({ filename, blob: albedoBlob })
      mtlLines.push(`map_Kd ${filename}`)
    }

    const normalBlob = material.normalMap ? await textureToPngBlob(material.normalMap) : null
    if (normalBlob) {
      const filename = `${texturePrefix}_normal.png`
      textureFiles.push({ filename, blob: normalBlob })
      mtlLines.push(`norm ${filename}`)
      mtlLines.push(`map_Bump ${filename}`)
    }

    const emissiveBlob = material.emissiveMap ? await textureToPngBlob(material.emissiveMap) : null
    if (emissiveBlob) {
      const filename = `${texturePrefix}_emissive.png`
      textureFiles.push({ filename, blob: emissiveBlob })
      mtlLines.push(`map_Ke ${filename}`)
    }

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
