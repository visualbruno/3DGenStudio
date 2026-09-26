// Flatten a PBR mesh into ONE lit albedo texture, for shaders that cannot
// afford PBR (mobile unlit / Lambert).
//
// ---- What survives, and what cannot ------------------------------------------
//
// An unlit shader shows one texture and nothing else, so every other channel of
// the source — normal detail, occlusion, roughness, metalness — has to be baked
// INTO that texture or it is lost. The bake runs in headless Blender (see
// python-server/app/tools/flatten_worker.py) under a neutral studio light. What
// it deliberately leaves out is anything that belongs to ONE view or ONE light:
// specular highlights and hard shadows. A highlight baked into a texture sits on
// the surface for every camera angle, which is the "reflecting light" look a
// flattened asset must not have.
//
// ---- Why the atlas is built HERE -------------------------------------------------
//
// One texture needs one non-overlapping UV layout across every mesh and material.
// Auto UV would give one, but it runs on a merged trimesh and hands back new
// geometry — the skeleton, skin weights, morphs and clips of a rigged asset do
// not survive that trip. Repacking the islands the mesh already has, in the
// browser, changes nothing but a UV channel, so a rigged character comes out of
// the flatten still rigged. The packer is the Mesh Assembly one (assemblyAtlas.js).
//
// The atlas travels to Blender as an EXTRA UV set (TEXCOORD_1 normally): the
// source textures keep sampling through their own UV0 while the bake writes
// through the atlas, which is how several materials land in one image with no
// ray casting at all — the target and the source are the same surface.
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { extractIslands, planAtlas } from './assemblyAtlas'
import { exportObject3D, loadGlbBlob, measureUvHealth, textureFromBlob } from './meshExport'
import { flattenBake } from './meshTools'

// Target shaders the flatten is made for. The lighting preset each one bakes
// with is the whole difference between them — see LIGHTING in flatten_worker.py.
export const FLATTEN_SHADERS = [
  {
    value: 'unlit',
    lighting: 'studio',
    label: 'Unlit — studio lighting baked in',
    hint: 'Soft dome plus a gentle top key light. The texture is the only light the mesh gets, '
      + 'so it carries the shape. Exported GLBs use KHR_materials_unlit.',
  },
  {
    value: 'lit',
    lighting: 'soft',
    label: 'Simple lit — occlusion and soft fill only',
    hint: 'Contact shadows and a mild top-down fill, no key light: your game\'s own light supplies '
      + 'the direction, and a baked one would double it. Exported as a rough, non-metal material.',
  },
]

export const DEFAULT_FLATTEN_OPTIONS = {
  shader: 'unlit',
  resolution: 2048,
  samples: 64,
  exposure: 0,
}

// A layout already this clean is kept as it is: an AI-generated mesh arrives
// with one material and one packed unwrap, and repacking that would only move
// the artist's islands around for no gain. Measured healthy layouts sit at
// 1.01-1.24x (see UV_ATLAS_WRITES_BROKEN in meshExport.js); two materials that
// each fill their own 0..1 square read ~2x, which is exactly what must repack.
const KEEP_LAYOUT_MAX_WRITES = 1.3
const UV_RANGE_EPSILON = 1e-3

// Triangles that have no usable UVs (no UV set at all, or an island collapsed to
// a point — a flat-colour part) get one tiny island EACH, because there is no
// layout to keep. Past this many that stops being a few buttons and becomes a
// whole mesh in confetti, and Auto UV is the honest answer.
const MAX_UNMAPPED_TRIANGLES = 20000

// Relative density clamp between meshes. Each mesh keeps the texel density its
// own textures gave it, so a 2K face stays sharper than a 1K boot — but a tiled
// wall mapped in metres would otherwise claim the whole atlas.
const DENSITY_CLAMP = 4

// Share of the atlas the islands' own UV area is sized to before packing. Their
// bounding boxes and padding take the rest; aiming higher only makes the packer
// step down (by 0.85 per attempt) until it fits.
const ATLAS_FILL_TARGET = 0.6

function textureChannelsInUse(object) {
  const channels = new Set()
  object.traverse(child => {
    if (!child.isMesh) return
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!material) continue
      for (const value of Object.values(material)) {
        if (value?.isTexture) channels.add(value.channel || 0)
      }
    }
  })
  return channels
}

// Largest texture dimension the mesh's materials carry, or 0 when none do.
function materialTexturePixels(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  let pixels = 0
  for (const material of materials) {
    const image = material?.map?.image
    if (!image) continue
    const repeat = Math.max(Math.abs(material.map.repeat?.x || 1), Math.abs(material.map.repeat?.y || 1))
    pixels = Math.max(pixels, Math.max(image.width || 0, image.height || 0) * repeat)
  }
  return pixels
}

// A plain Float32 copy of a (possibly quantized or interleaved) attribute.
// getX/getY denormalise; the packer reads `.array` directly, which would not.
function floatUvs(attribute, count) {
  const out = new Float32Array(count * 2)
  if (!attribute) return out
  for (let i = 0; i < count; i += 1) {
    out[i * 2] = attribute.getX(i)
    out[i * 2 + 1] = attribute.getY(i)
  }
  return out
}

// Rebuild an attribute as a plain BufferAttribute holding `sources.length` more
// vertices, each a copy of the source vertex it names.
function appendVertexCopies(attribute, sources) {
  const size = attribute.itemSize
  const count = attribute.count
  const Ctor = attribute.array.constructor
  const out = new Ctor((count + sources.length) * size)
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < size; c += 1) out[i * size + c] = attribute.getComponent(i, c)
  }
  sources.forEach((src, k) => {
    for (let c = 0; c < size; c += 1) out[(count + k) * size + c] = attribute.getComponent(src, c)
  })
  return new THREE.BufferAttribute(out, size, attribute.normalized)
}

// World-space area and UV-space area of a set of faces.
function faceAreas(position, uv, indices, faces, matrix) {
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3()
  let world = 0
  let texture = 0
  for (const f of faces) {
    const i0 = indices[f * 3]; const i1 = indices[f * 3 + 1]; const i2 = indices[f * 3 + 2]
    a.fromBufferAttribute(position, i0).applyMatrix4(matrix)
    b.fromBufferAttribute(position, i1).applyMatrix4(matrix)
    c.fromBufferAttribute(position, i2).applyMatrix4(matrix)
    world += b.sub(a).cross(c.sub(a)).length() * 0.5
    texture += Math.abs(
      (uv[i1 * 2] - uv[i0 * 2]) * (uv[i2 * 2 + 1] - uv[i0 * 2 + 1])
      - (uv[i2 * 2] - uv[i0 * 2]) * (uv[i1 * 2 + 1] - uv[i0 * 2 + 1])) * 0.5
  }
  return { world, texture }
}

// Give every face that has no usable UVs a private, flat island of its own.
//
// The packer skips an island with no UV extent, which would leave its vertices at
// (0,0) of the atlas and sample whatever colour happens to land there. Those
// faces are split off onto their own vertices (copied with every attribute, skin
// and morphs included) and laid flat in their own plane, in metres scaled to the
// rest of the mesh's UV density so they pack at a sensible size.
function mapUnmappedFaces(geometry, uv, matrix) {
  const position = geometry.getAttribute('position')
  const indices = geometry.getIndex().array
  const islands = extractIslands(indices, position.count)

  const unmapped = []
  const mapped = []
  for (const faces of islands) {
    let minU = Infinity; let minV = Infinity; let maxU = -Infinity; let maxV = -Infinity
    for (const f of faces) {
      for (let k = 0; k < 3; k += 1) {
        const v = indices[f * 3 + k]
        minU = Math.min(minU, uv[v * 2]); maxU = Math.max(maxU, uv[v * 2])
        minV = Math.min(minV, uv[v * 2 + 1]); maxV = Math.max(maxV, uv[v * 2 + 1])
      }
    }
    // Either axis collapsed means no area to sample, not just a thin island.
    if (!((maxU - minU) > 1e-7 && (maxV - minV) > 1e-7)) unmapped.push(...faces)
    else mapped.push(...faces)
  }
  if (!unmapped.length) return { geometry, uv, unmapped: 0 }

  // UV units per metre of the faces that ARE mapped, so the new islands match.
  const { world, texture } = faceAreas(position, uv, indices, mapped, matrix)
  const uvPerMetre = world > 0 && texture > 0 ? Math.sqrt(texture / world) : 1

  const sources = []
  const newIndex = Array.from(indices)
  for (const f of unmapped) {
    for (let k = 0; k < 3; k += 1) {
      newIndex[f * 3 + k] = position.count + sources.length
      sources.push(indices[f * 3 + k])
    }
  }

  const out = new THREE.BufferGeometry()
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    out.setAttribute(name, appendVertexCopies(attribute, sources))
  }
  for (const [name, list] of Object.entries(geometry.morphAttributes)) {
    out.morphAttributes[name] = list.map(attribute => appendVertexCopies(attribute, sources))
  }
  out.morphTargetsRelative = geometry.morphTargetsRelative
  for (const group of geometry.groups) out.addGroup(group.start, group.count, group.materialIndex)
  out.setIndex(newIndex)

  const total = position.count + sources.length
  const newUv = new Float32Array(total * 2)
  newUv.set(uv)
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3()
  const e1 = new THREE.Vector3(); const e2 = new THREE.Vector3(); const n = new THREE.Vector3()
  for (let t = 0; t < unmapped.length; t += 1) {
    const base = position.count + t * 3
    a.fromBufferAttribute(position, sources[t * 3]).applyMatrix4(matrix)
    b.fromBufferAttribute(position, sources[t * 3 + 1]).applyMatrix4(matrix)
    c.fromBufferAttribute(position, sources[t * 3 + 2]).applyMatrix4(matrix)
    e1.subVectors(b, a)
    const length = e1.length()
    e1.normalize()
    n.crossVectors(e1, e2.subVectors(c, a))
    e2.crossVectors(n.normalize(), e1)
    const cu = c.clone().sub(a).dot(e1)
    const cv = c.clone().sub(a).dot(e2)
    // Kept away from zero area so the packer never skips it: a sliver still has
    // to own at least a texel or it would sample its neighbour.
    newUv[base * 2] = 0; newUv[base * 2 + 1] = 0
    newUv[(base + 1) * 2] = Math.max(length, 1e-4) * uvPerMetre; newUv[(base + 1) * 2 + 1] = 0
    newUv[(base + 2) * 2] = cu * uvPerMetre
    newUv[(base + 2) * 2 + 1] = Math.max(Math.abs(cv), 1e-4) * uvPerMetre
  }
  geometry.dispose()
  return { geometry: out, uv: newUv, unmapped: unmapped.length }
}

/**
 * Write one packed, non-overlapping atlas over every mesh of `object`, into an
 * extra UV channel. Mutates `object` (geometry is cloned per mesh first, so
 * nothing shared with a caller's scene is touched).
 *
 * Returns `{ channel, repacked, islands, fill, unmapped }`: `channel` is the uvN
 * index the atlas lives in, `repacked` false when the source layout was already
 * clean enough to reuse.
 */
export function prepareFlattenAtlas(object, { resolution = 2048 } = {}) {
  object.updateMatrixWorld(true)
  const meshes = []
  object.traverse(child => {
    if (child.isMesh && child.geometry?.getAttribute('position')?.count) meshes.push(child)
  })
  if (!meshes.length) throw new Error('There is no mesh to flatten.')

  // The atlas goes in the first UV channel no source texture reads from.
  const used = textureChannelsInUse(object)
  let channel = 1
  while (used.has(channel)) channel += 1
  if (channel > 3) throw new Error('Every UV channel is already in use by a texture; nothing is free for the atlas.')
  const atlasName = `uv${channel}`

  // Two meshes sharing one geometry would share one set of texels, and they sit
  // in different light — each gets its own copy.
  for (const mesh of meshes) mesh.geometry = mesh.geometry.clone()

  const health = measureUvHealth(object)
  let inRange = health.uvs
  for (const mesh of meshes) {
    const uv = mesh.geometry.getAttribute('uv')
    if (!uv) { inRange = false; break }
    for (let i = 0; i < uv.count && inRange; i += 1) {
      const u = uv.getX(i); const v = uv.getY(i)
      if (u < -UV_RANGE_EPSILON || u > 1 + UV_RANGE_EPSILON || v < -UV_RANGE_EPSILON || v > 1 + UV_RANGE_EPSILON) inRange = false
    }
  }

  const setAtlas = (geometry, array) => {
    // Channels below the atlas must exist for glTF to index it; fill any gap
    // with a copy of UV0 (they are only placeholders — no texture reads them).
    for (let k = 1; k < channel; k += 1) {
      if (!geometry.getAttribute(`uv${k}`)) geometry.setAttribute(`uv${k}`, geometry.getAttribute('uv').clone())
    }
    geometry.setAttribute(atlasName, new THREE.BufferAttribute(array, 2))
  }

  if (inRange && health.atlasWrites > 0 && health.atlasWrites <= KEEP_LAYOUT_MAX_WRITES) {
    for (const mesh of meshes) {
      const geometry = mesh.geometry
      setAtlas(geometry, floatUvs(geometry.getAttribute('uv'), geometry.getAttribute('position').count))
    }
    return { channel, repacked: false, islands: null, fill: null, unmapped: 0, atlasWrites: health.atlasWrites }
  }

  // ---- repack ----------------------------------------------------------------
  const pieces = []
  let unmappedTotal = 0
  meshes.forEach((mesh, index) => {
    let geometry = mesh.geometry
    // An island is a connected component of the INDEX buffer, so a non-indexed
    // mesh would be one island per triangle. Welding on every attribute keeps
    // real seams and hard edges split and recovers everything else.
    if (!geometry.getIndex()) {
      const welded = mergeVertices(geometry)
      if (welded !== geometry) geometry.dispose()
      geometry = welded
      if (!geometry.getIndex()) {
        const n = geometry.getAttribute('position').count
        geometry.setIndex(Array.from({ length: n }, (_, i) => i))
      }
    }
    const count = geometry.getAttribute('position').count
    let uv = floatUvs(geometry.getAttribute('uv'), count)
    const mapped = mapUnmappedFaces(geometry, uv, mesh.matrixWorld)
    geometry = mapped.geometry
    uv = mapped.uv
    unmappedTotal += mapped.unmapped
    mesh.geometry = geometry

    const indices = geometry.getIndex().array
    const faces = Array.from({ length: indices.length / 3 }, (_, i) => i)
    const { world, texture } = faceAreas(geometry.getAttribute('position'), uv, indices, faces, mesh.matrixWorld)
    pieces.push({
      id: String(index),
      mesh,
      indices,
      uv,
      vertexCount: geometry.getAttribute('position').count,
      texturePixels: materialTexturePixels(mesh),
      world,
      texture,
    })
  })
  if (unmappedTotal > MAX_UNMAPPED_TRIANGLES) {
    throw new Error(`${unmappedTotal.toLocaleString()} triangles have no usable UVs, which is too many to lay out one `
      + 'by one. Run Auto UV on this mesh first (Mesh Editor), then export again.')
  }

  // Texel density, in pixels per metre, of each mesh as its own textures have it.
  // Untextured meshes take the median of the textured ones, and every mesh is
  // clamped around it so no single one can starve the rest.
  const density = piece => (piece.texturePixels && piece.world > 0 && piece.texture > 0
    ? piece.texturePixels * Math.sqrt(piece.texture / piece.world)
    : 0)
  const densities = pieces.map(density).filter(d => d > 0).sort((x, y) => x - y)
  const median = densities.length ? densities[Math.floor(densities.length / 2)] : 1024
  for (const piece of pieces) {
    const own = density(piece) || median
    const clamped = Math.min(median * DENSITY_CLAMP, Math.max(median / DENSITY_CLAMP, own))
    // Back to pixels per UV unit, which is what the packer sizes islands by.
    piece.textureSize = piece.world > 0 && piece.texture > 0
      ? clamped * Math.sqrt(piece.world / piece.texture)
      : 1024
  }

  // Then scaled, all together, to FILL the atlas. The densities above are only
  // relative: the packer never scales an island up (Mesh Assembly must not
  // invent pixels a source never had), so a mesh whose textures are 256px would
  // otherwise occupy a corner of a 2048 atlas. Here every texel is a new lit
  // sample, and the resolution picked is the resolution that should be used.
  // Sized against the islands' true UV area; their bounding boxes waste some
  // on top, which the packer's own step-down absorbs.
  const texelArea = pieces.reduce((sum, piece) => sum + piece.texture * piece.textureSize ** 2, 0)
  if (texelArea > 0) {
    const fit = Math.sqrt((resolution * resolution * ATLAS_FILL_TARGET) / texelArea)
    for (const piece of pieces) piece.textureSize *= fit
  }

  // Padding in texels on each side of an island: 4 px gaps at 2K, scaled with it.
  // Kept tight on purpose. A building of 7k islands at 4 px a side left 18% of a
  // 2048 atlas holding actual surface — padding was most of every small box.
  // Mip bleed is the gutter fill's job, not the gap's.
  const padding = Math.max(2, Math.round(resolution / 1024))
  const plan = planAtlas(pieces, { size: resolution, maxAtlases: 1, padding, allowRotation: true })
  if (!plan) throw new Error('The UV islands could not be packed into one atlas.')

  for (const piece of pieces) setAtlas(piece.mesh.geometry, plan.uvByPiece.get(piece.id))
  return {
    channel,
    repacked: true,
    islands: plan.islandCount,
    fill: plan.fill,
    unmapped: unmappedTotal,
    atlasWrites: health.atlasWrites,
  }
}

// Remembered PER MESH across the swap, so each part keeps the render state it
// had: which faces it culls, and whether it is cut out or blended.
//
// Per mesh, not once for the asset — measured on a timber-framed house whose
// window models were double-sided and whose glass was blended: OR-ing those
// into one material made every wall double-sided and every wall blended, and
// the window reveals the source relied on back-face culling to hide came out as
// boxes standing proud of the facade. Opaque parts must stay opaque (blending
// costs overdraw and sorting on exactly the hardware this is for), and
// single-sided parts must stay single-sided.
function sourceMaterialTraits(object) {
  const traits = new Map()
  object.traverse(child => {
    if (!child.isMesh) return
    const own = { transparent: false, alphaTest: 0, doubleSided: false }
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!material) continue
      if (material.transparent) own.transparent = true
      if (material.alphaTest > 0) own.alphaTest = Math.max(own.alphaTest, material.alphaTest)
      if (material.side === THREE.DoubleSide) own.doubleSided = true
    }
    traits.set(child, own)
  })
  return traits
}

// Swap every mesh onto the flattened albedo: atlas UVs become UV0, the other UV
// channels, vertex colours (already baked in) and tangents (no normal map any
// more) are dropped. Every material samples the SAME texture; there is one per
// distinct render state (side x opaque/cut-out/blended), which for most assets
// is exactly one and never more than a handful.
function applyFlattenedAlbedo(object, texture, { channel, hasAlpha, traits, name }) {
  const variants = new Map()
  const variantFor = own => {
    const alphaTest = hasAlpha && own.alphaTest > 0 ? own.alphaTest : 0
    const transparent = hasAlpha && !alphaTest && own.transparent
    const key = `${own.doubleSided ? 'double' : 'front'}:${alphaTest ? `mask${alphaTest}` : transparent ? 'blend' : 'opaque'}`
    if (!variants.has(key)) {
      const material = new THREE.MeshStandardMaterial({
        name: variants.size ? `${name}_${key.replace(':', '_').replace('.', '')}` : name,
        map: texture,
        color: 0xffffff,
        metalness: 0,
        roughness: 1,
        side: own.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest,
        transparent,
      })
      variants.set(key, material)
    }
    return variants.get(key)
  }
  const fallback = { transparent: false, alphaTest: 0, doubleSided: false }
  object.traverse(child => {
    if (!child.isMesh) return
    const geometry = child.geometry
    const atlas = geometry.getAttribute(`uv${channel}`)
    if (!atlas) return
    geometry.setAttribute('uv', atlas)
    for (let k = 1; k <= 3; k += 1) geometry.deleteAttribute(`uv${k}`)
    geometry.deleteAttribute('color')
    geometry.deleteAttribute('tangent')
    // Groups indexed the source's material array; there is one material now.
    geometry.clearGroups()
    child.material = variantFor(traits.get(child) || fallback)
  })
  return variants.size
}

/**
 * Bake `sourceGlb`'s full PBR look into one albedo and return a GLB whose every
 * mesh uses it. Rig, clips and morphs are carried through untouched.
 *
 * The returned GLB keeps a standard (rough, non-metal) material so that the rest
 * of the export pipeline — LOD bakes, FBX conversion — reads it like any other
 * textured mesh; `toUnlitGlb` turns it unlit for the files that want that.
 */
export async function flattenMeshMaterials(sourceGlb, {
  shader = DEFAULT_FLATTEN_OPTIONS.shader,
  resolution = DEFAULT_FLATTEN_OPTIONS.resolution,
  samples = DEFAULT_FLATTEN_OPTIONS.samples,
  exposure = DEFAULT_FLATTEN_OPTIONS.exposure,
  baseName = 'mesh',
  onProgress = null,
} = {}) {
  const preset = FLATTEN_SHADERS.find(entry => entry.value === shader) || FLATTEN_SHADERS[0]
  onProgress?.({ frac: 0, message: 'Packing one UV atlas across every material…' })

  const scene = await loadGlbBlob(sourceGlb)
  const traits = sourceMaterialTraits(scene)
  const atlas = prepareFlattenAtlas(scene, { resolution })

  // The bake needs the geometry and the source materials, not the clips — an
  // animated import only costs Blender time.
  const clips = scene.animations
  scene.animations = []
  const [target] = await exportObject3D(scene, { format: 'glb', baseName })
  scene.animations = clips

  const { maps, stats } = await flattenBake(target.blob, {
    options: {
      resolution,
      samples,
      lighting: preset.lighting,
      exposure,
      atlas_uv: atlas.channel,
    },
    fileName: `${baseName}.glb`,
    onProgress: evt => onProgress?.({
      frac: 0.1 + 0.85 * (evt.frac ?? 0),
      message: evt.message || 'Baking the lit albedo…',
    }),
  })
  if (!maps.albedo) throw new Error('The flatten bake returned no albedo.')

  onProgress?.({ frac: 0.97, message: 'Applying the flattened albedo…' })
  const texture = await textureFromBlob(maps.albedo, true)
  texture.name = `${baseName}_albedo`
  const materialCount = applyFlattenedAlbedo(scene, texture, {
    channel: atlas.channel,
    hasAlpha: !!stats?.has_alpha,
    traits,
    name: `${baseName}_flat`,
  })
  const [flattened] = await exportObject3D(scene, { format: 'glb', baseName })
  return { blob: flattened.blob, atlas, stats, materialCount }
}

/**
 * Re-export a GLB with every material unlit (KHR_materials_unlit). Only GLB can
 * say "unlit"; FBX and OBJ get the standard material from flattenMeshMaterials,
 * which an engine imports as a plain textured diffuse.
 */
export async function toUnlitGlb(glbBlob, baseName = 'mesh') {
  const scene = await loadGlbBlob(glbBlob)
  const swapped = new Map()
  scene.traverse(child => {
    if (!child.isMesh) return
    const convert = material => {
      if (!material || material.isMeshBasicMaterial) return material
      if (!swapped.has(material)) {
        swapped.set(material, new THREE.MeshBasicMaterial({
          name: material.name,
          map: material.map,
          color: 0xffffff,
          side: material.side,
          transparent: material.transparent,
          alphaTest: material.alphaTest,
        }))
      }
      return swapped.get(material)
    }
    child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material)
  })
  const [file] = await exportObject3D(scene, { format: 'glb', baseName })
  return file.blob
}
