// Baking every piece's textures into the shared atlas, and merging the geometry.
//
// The other half of the single-texture merge; assemblyAtlas.js plans the layout.
//
// ---- This is a UV→UV transfer, not a spatial bake -----------------------------
//
// The app already has a bake (`/api/meshes/bake`) that transfers maps between
// two meshes by ray casting. It is the wrong tool here, and knowing why is what
// makes this cheap: merging does not change topology. Every output triangle IS
// an input triangle, so its original UV and source texture are known exactly.
// There is nothing to search for.
//
// So each triangle is simply rasterised at its NEW atlas UV while sampling its
// OLD texture at its OLD UV. No rays, no proximity, no misprojection, and the
// result is exact rather than resampled-through-space.
//
// ---- Colour space: sample linear, store encoded --------------------------------
//
// A plain ShaderMaterial and texture2D looks like it copies bytes, and for
// linear data (roughness, metalness, normals) it does. For BASE COLOUR it does
// not: three uploads an sRGB-tagged texture with an SRGB8_ALPHA8 internal
// format, so the hardware DECODES it on sample and the shader receives linear
// values. Writing those into an 8-bit target and then tagging the result sRGB
// makes the renderer decode a second time, and the whole asset comes out
// visibly dark — which is exactly how it presented.
//
// So the shader re-encodes with the sRGB transfer function on the way out, for
// sources that were sRGB and only those. The round trip is then the identity
// (bar 8-bit rounding), and each slot keeps the colour space it came in with.
import * as THREE from 'three'

// The map slots carried across, and what to write where a piece has no such map.
// The fallback matters: leaving those texels black would make an unmapped piece
// perfectly rough or fully occluded rather than neutral.
export const ATLAS_SLOTS = [
  { key: 'map', fallback: [255, 255, 255, 255], srgb: true },
  { key: 'normalMap', fallback: [128, 128, 255, 255], srgb: false },
  { key: 'roughnessMap', fallback: [255, 255, 255, 255], srgb: false },
  { key: 'metalnessMap', fallback: [255, 255, 255, 255], srgb: false },
  { key: 'emissiveMap', fallback: [0, 0, 0, 255], srgb: true },
  { key: 'aoMap', fallback: [255, 255, 255, 255], srgb: false },
]

const VERTEX = /* glsl */`
  attribute vec2 aOldUv;
  attribute vec2 aNewUv;
  varying vec2 vOldUv;
  void main() {
    vOldUv = aOldUv;
    // The whole trick: the triangle is placed by its ATLAS uv, so the
    // rasteriser fills exactly the texels it will own.
    gl_Position = vec4(aNewUv * 2.0 - 1.0, 0.0, 1.0);
  }
`

const FRAGMENT = /* glsl */`
  uniform sampler2D uMap;
  uniform vec4 uFallback;
  uniform float uHasMap;
  uniform float uEncodeSRGB;
  varying vec2 vOldUv;

  vec3 linearToSRGB(vec3 c) {
    vec3 low = c * 12.92;
    vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, step(c, vec3(0.0031308)));
  }

  void main() {
    // texture2D, never a colour-managed fetch: see the header.
    vec4 sampled = texture2D(uMap, vOldUv);
    // The hardware already decoded an sRGB source; put it back so the stored
    // bytes match what came in. Linear sources skip this untouched.
    vec3 rgb = mix(sampled.rgb, linearToSRGB(sampled.rgb), uEncodeSRGB);
    // Alpha is COVERAGE here, not opacity — 1 wherever a triangle drew. The
    // source's own alpha must not come through: these textures are 75%
    // transparent in their unused regions, and carrying that into the atlas
    // both darkens the copy and destroys the mask the gutter fill depends on.
    gl_FragColor = vec4(mix(uFallback.rgb, rgb, uHasMap), 1.0);
  }
`

// Grows valid texels outward to fill the gutter between islands. Without it,
// bilinear filtering and mipmaps pull the background in at every island edge —
// the classic dark seam.
const DILATE_FRAGMENT = /* glsl */`
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec4 centre = texture2D(uSource, vUv);
    if (centre.a > 0.0) { gl_FragColor = centre; return; }
    vec4 sum = vec4(0.0);
    float count = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec4 s = texture2D(uSource, vUv + vec2(float(x), float(y)) * uTexel);
        if (s.a > 0.0) { sum += s; count += 1.0; }
      }
    }
    gl_FragColor = count > 0.0 ? vec4(sum.rgb / count, 1.0) : vec4(0.0);
  }
`

const DILATE_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`


/** Geometry carrying just the two UV sets, for one piece's slice of an atlas. */
function bakeGeometry(source, newUv, faceList) {
  const oldUv = source.geometry.getAttribute('uv')
  const indices = source.geometry.getIndex()
  const positions = new Float32Array(faceList.length * 9)   // unused, but three wants one
  const aOld = new Float32Array(faceList.length * 6)
  const aNew = new Float32Array(faceList.length * 6)

  let cursor = 0
  for (const face of faceList) {
    for (let k = 0; k < 3; k += 1) {
      const v = indices.getX(face * 3 + k)
      aOld[cursor * 2] = oldUv.getX(v)
      aOld[cursor * 2 + 1] = oldUv.getY(v)
      aNew[cursor * 2] = newUv[v * 2]
      aNew[cursor * 2 + 1] = newUv[v * 2 + 1]
      cursor += 1
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aOldUv', new THREE.BufferAttribute(aOld, 2))
  geometry.setAttribute('aNewUv', new THREE.BufferAttribute(aNew, 2))
  return geometry
}


function renderTargetToCanvas(renderer, target, size) {
  const buffer = new Uint8Array(size * size * 4)
  renderer.readRenderTargetPixels(target, 0, 0, size, size, buffer)

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  const image = context.createImageData(size, size)

  // Copied row-for-row, NOT flipped — and that is the whole subtlety.
  //
  // The bake writes gl_Position.y = v*2-1, so NDC y=-1 (which readPixels
  // returns as row 0) is v=0. glTF also puts v=0 at image row 0, and the
  // exporter only re-flips when texture.flipY is true, which it is not here.
  // So buffer row 0 must land on canvas row 0.
  //
  // "WebGL reads bottom-up, canvas is top-down" is the reflex, and it is the
  // wrong instinct here: it mirrors the atlas vertically. The geometry then
  // still looks perfect while every triangle samples whichever island happens
  // to sit at the mirrored position — a scrambled patchwork of plausible
  // texture fragments, which is exactly how it presented.
  image.data.set(buffer)
  context.putImageData(image, 0, 0)
  return canvas
}


/**
 * Bake every slot for every atlas.
 *
 * `sources` are `{ id, geometry, material }` — the geometry still carrying its
 * ORIGINAL uv. Returns one `{ [slot]: THREE.Texture }` per atlas.
 */
export function bakeAtlases({ renderer, sources, plan, size, dilatePasses = 8, onProgress }) {
  const byId = new Map(sources.map(source => [source.id, source]))
  const camera = new THREE.Camera()
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: DILATE_VERTEX,
      fragmentShader: DILATE_FRAGMENT,
      uniforms: { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,      // same reason as the bake material
    }))
  const quadScene = new THREE.Scene().add(quad)

  // The renderer is the LIVE viewport one, so every piece of state this touches
  // has to go back exactly as it was — a stray clear colour would repaint the
  // user's viewport the next frame.
  const previousTarget = renderer.getRenderTarget()
  const previousClearColor = new THREE.Color()
  renderer.getClearColor(previousClearColor)
  const previousClearAlpha = renderer.getClearAlpha()
  const results = []

  // Which slots any piece actually uses. Baking a slot nothing carries would
  // produce a flat texture the merged material does not need.
  const usedSlots = ATLAS_SLOTS.filter(slot => sources.some(s => s.material?.[slot.key]))

  try {
    plan.placements.forEach((placements, atlasIndex) => {
      const maps = {}
      usedSlots.forEach((slot, slotIndex) => {
        onProgress?.((atlasIndex * usedSlots.length + slotIndex)
          / (plan.placements.length * usedSlots.length), `Baking ${slot.key}`)

        const target = new THREE.WebGLRenderTarget(size, size, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          // Bytes in, bytes out — the shader already wrote exactly what the
          // source stored, so no conversion must happen on the way to the RT.
          colorSpace: THREE.NoColorSpace,
          depthBuffer: false,
        })

        const scene = new THREE.Scene()
        const owned = []
        for (const placement of placements) {
          const source = byId.get(placement.pieceId)
          const newUv = plan.uvByPiece.get(placement.pieceId)
          if (!source || !newUv) continue
          const geometry = bakeGeometry(source, newUv, placement.faceList)
          const map = source.material?.[slot.key] || null
          const material = new THREE.ShaderMaterial({
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            uniforms: {
              uMap: { value: map },
              uHasMap: { value: map ? 1 : 0 },
              uEncodeSRGB: { value: map?.colorSpace === THREE.SRGBColorSpace ? 1 : 0 },
              uFallback: {
                value: new THREE.Vector4(...slot.fallback.map(v => v / 255)),
              },
            },
            depthTest: false,
            depthWrite: false,
            // COPY, never composite. With the default blending each fragment is
            // mixed into the cleared transparent-black target, so anything with
            // source alpha below 1 comes out darkened — which on a texture that
            // is mostly transparent outside its islands is most of the atlas.
            blending: THREE.NoBlending,
            side: THREE.DoubleSide,
          })
          const mesh = new THREE.Mesh(geometry, material)
          mesh.frustumCulled = false
          scene.add(mesh)
          owned.push(geometry, material)
        }

        renderer.setRenderTarget(target)
        renderer.setClearColor(0x000000, 0)
        renderer.clear(true, false, false)
        renderer.render(scene, camera)

        // Gutter fill, ping-ponged. Cheap 3x3 growth rather than a jump flood:
        // the gap between islands is only the packer's padding, so a handful of
        // passes covers it exactly, and the shader is six lines instead of three
        // of them.
        let current = target
        let scratch = null
        if (dilatePasses > 0) {
          scratch = target.clone()
          for (let pass = 0; pass < dilatePasses; pass += 1) {
            const from = current
            const to = from === target ? scratch : target
            quad.material.uniforms.uSource.value = from.texture
            quad.material.uniforms.uTexel.value.set(1 / size, 1 / size)
            renderer.setRenderTarget(to)
            renderer.clear(true, false, false)
            renderer.render(quadScene, camera)
            current = to
          }
        }

        const canvas = renderTargetToCanvas(renderer, current, size)
        const texture = new THREE.CanvasTexture(canvas)
        texture.flipY = false
        texture.colorSpace = slot.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
        texture.needsUpdate = true
        maps[slot.key] = texture

        for (const item of owned) item.dispose()
        target.dispose()
        scratch?.dispose()
      })
      results.push(maps)
    })
  } finally {
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClearColor, previousClearAlpha)
    quad.geometry.dispose()
    quad.material.dispose()
  }
  return results
}


/**
 * One merged geometry per atlas, carrying the new UVs.
 *
 * Split by ATLAS rather than by piece, because an island — not a piece — is
 * what gets assigned a home. A piece whose islands straddle two atlases
 * contributes faces to both, which is exactly why this walks the placements
 * instead of the piece list.
 */
export function buildAtlasedGeometry(sources, plan, atlasIndex) {
  const byId = new Map(sources.map(source => [source.id, source]))
  const placements = plan.placements[atlasIndex] || []

  // Gather the attribute names every contributor shares. A piece missing one
  // the others have would otherwise leave a hole in the merged buffer.
  const contributors = placements
    .map(p => ({ placement: p, source: byId.get(p.pieceId) }))
    .filter(item => item.source)
  if (!contributors.length) return null

  let names = null
  for (const { source } of contributors) {
    const own = new Set(Object.keys(source.geometry.attributes))
    names = names ? new Set([...names].filter(n => own.has(n))) : own
  }
  names.delete('uv')

  let total = 0
  for (const { placement } of contributors) total += placement.faceList.length * 3

  const out = new THREE.BufferGeometry()
  for (const name of names) {
    const sample = contributors[0].source.geometry.getAttribute(name)
    const itemSize = sample.itemSize
    const array = new sample.array.constructor(total * itemSize)
    let cursor = 0
    for (const { placement, source } of contributors) {
      const attribute = source.geometry.getAttribute(name)
      const indices = source.geometry.getIndex()
      for (const face of placement.faceList) {
        for (let k = 0; k < 3; k += 1) {
          const v = indices.getX(face * 3 + k)
          for (let c = 0; c < itemSize; c += 1) {
            array[cursor * itemSize + c] = attribute.getComponent(v, c)
          }
          cursor += 1
        }
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, itemSize, sample.normalized))
  }

  // The new UVs, in the same de-indexed order.
  const uv = new Float32Array(total * 2)
  let cursor = 0
  for (const { placement, source } of contributors) {
    const newUv = plan.uvByPiece.get(placement.pieceId)
    const indices = source.geometry.getIndex()
    for (const face of placement.faceList) {
      for (let k = 0; k < 3; k += 1) {
        const v = indices.getX(face * 3 + k)
        uv[cursor * 2] = newUv[v * 2]
        uv[cursor * 2 + 1] = newUv[v * 2 + 1]
        cursor += 1
      }
    }
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}
