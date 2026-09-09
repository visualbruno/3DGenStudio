// Textures for the particle materials, and the built-in sprite.
//
// THERE IS ALWAYS A SPRITE. An effect with no texture chosen draws with a
// built-in soft radial blob rather than with hard-edged squares. That is a
// deliberate product choice for an audience who has never authored a particle
// effect: the very first thing they see after adding a Spawn block should look
// like an effect, not like a bug. The catalog's own teach line for the texture
// slot says a soft round blob covers most cases - so shipping one as the
// default is just agreeing with the advice.
//
// The default is generated NUMERICALLY, not drawn on a canvas. A DataTexture
// built from an array works in a browser, in a headless test and in the
// thumbnail renderer alike, whereas a canvas needs a DOM and would make this
// module untestable under `node`.
//
// COLOUR SPACE follows the rule the rest of the app follows - see the
// ATLAS_SLOTS table in src/utils/assemblyAtlasBake.js and the war story in the
// header of src/utils/gpuTextureBake.js. A particle's base colour is sRGB;
// anything used as data would be NoColorSpace. The IR records which, per asset,
// at compile time rather than leaving the shader to guess.
//
// flipY LIKEWISE COMES FROM THE IR. An image from the library follows the
// canvas convention (flipY true); a texture pulled off a loaded glTF material
// follows the glTF one (flipY false). Getting it wrong flips the sprite
// vertically, which on a symmetrical blob is invisible and on a flipbook or a
// directional streak is not - so it is recorded rather than assumed.

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  TetrahedronGeometry,
  TextureLoader,
  UnsignedByteType,
} from 'three';

const DEFAULT_SPRITE_SIZE = 64;

let defaultSprite = null;

/**
 * The built-in soft sprite: white, with a smooth radial alpha falloff.
 *
 * Premultiplied-friendly by construction - rgb stays white and only alpha
 * falls off - so it reads correctly under every blend mode the catalog offers.
 * A linear falloff would show a visible edge where it reaches zero, so the
 * profile is smoothstep, which lands on zero with zero gradient.
 *
 * @returns {DataTexture}
 */
export function getDefaultSprite() {
  if (defaultSprite) return defaultSprite;

  const size = DEFAULT_SPRITE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = centre;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / radius;
      const dy = (y - centre) / radius;
      const distance = Math.sqrt(dx * dx + dy * dy);
      // smoothstep from the edge inwards, clamped: 1 at the centre, 0 at the rim.
      const t = Math.min(1, Math.max(0, 1 - distance));
      const alpha = t * t * (3 - 2 * t);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(alpha * 255);
    }
  }

  defaultSprite = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  defaultSprite.colorSpace = SRGBColorSpace;
  defaultSprite.wrapS = ClampToEdgeWrapping;
  defaultSprite.wrapT = ClampToEdgeWrapping;
  defaultSprite.magFilter = LinearFilter;
  defaultSprite.minFilter = LinearFilter;
  // No mipmaps on a 64px blob: they buy nothing at this size, and for a
  // flipbook atlas they would bleed neighbouring frames at distance - the same
  // class of bug the JFA gutter fill in assemblyAtlasBake.js exists to prevent.
  defaultSprite.generateMipmaps = false;
  defaultSprite.needsUpdate = true;
  defaultSprite.name = 'vfx-default-sprite';
  return defaultSprite;
}

/**
 * Apply the conventions an IR asset entry records.
 *
 * @param {import('three').Texture} texture
 * @param {Object} asset an entry from ir.assets
 * @param {{mipmaps?: boolean}} [options]
 */
export function configureVfxTexture(texture, asset, options = {}) {
  texture.colorSpace = asset.colorSpace === 'linear' ? NoColorSpace : SRGBColorSpace;
  texture.flipY = Boolean(asset.flipY);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  const wantMipmaps = options.mipmaps !== false;
  texture.generateMipmaps = wantMipmaps;
  texture.minFilter = wantMipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.needsUpdate = true;
}

/**
 * Load every texture an IR references.
 *
 * Resolution is injected rather than done here: the IR carries an asset id, and
 * turning that into a URL needs the asset record, which is the page's business
 * (and does not exist at all until the asset type lands). Keeping it out means
 * this module has no opinion about where assets come from and stays testable.
 *
 * A failed load resolves to the built-in sprite rather than rejecting. An
 * effect whose texture was deleted should still play - the compiler already
 * raises W_MISSING_ASSET for it, and a preview that refuses to run teaches the
 * author nothing they cannot already read in the warning strip.
 *
 * @param {Object} ir
 * @param {{resolveUrl?: (asset: Object) => string|null}} [options]
 * @returns {Promise<{textures: Map<number, import('three').Texture>, failed: number[]}>}
 */
export async function loadVfxTextures(ir, options = {}) {
  const resolveUrl = options.resolveUrl;
  const textures = new Map();
  const failed = [];
  const images = ir.assets.filter((asset) => asset.kind === 'image');
  if (images.length === 0 || !resolveUrl) return { textures, failed };

  const loader = new TextureLoader();
  await Promise.all(images.map(async (asset) => {
    const url = resolveUrl(asset);
    if (!url) {
      failed.push(asset.assetId);
      return;
    }
    try {
      const texture = await loader.loadAsync(url);
      configureVfxTexture(texture, asset);
      textures.set(asset.assetId, texture);
    } catch {
      failed.push(asset.assetId);
    }
  }));

  return { textures, failed };
}

let defaultMesh = null;

/**
 * The built-in particle mesh: a small tetrahedron.
 *
 * THERE IS ALWAYS A MESH, for the same reason there is always a sprite - an
 * author who switches an Output to Mesh mode before choosing one should see
 * something, not nothing. A tetrahedron rather than a cube or a sphere because
 * it is the cheapest solid that reads as a chip of debris from any angle, and
 * because its asymmetry makes rotation visible, which a sphere would hide.
 *
 * Built numerically so this module stays usable under `node`, like the sprite.
 *
 * @returns {import('three').BufferGeometry}
 */
export function getDefaultParticleMesh() {
  if (defaultMesh) return defaultMesh;
  defaultMesh = new TetrahedronGeometry(0.6);
  // Deleted rather than left: the particle shader declares no normal or
  // tangent, and an attribute the shader never reads is bytes uploaded per
  // instance-set for nothing.
  defaultMesh.deleteAttribute('normal');
  return defaultMesh;
}

/**
 * Load the mesh assets an effect's outputs need.
 *
 * ONE GEOMETRY PER ASSET, merged from every mesh in the file. A glTF is a scene
 * graph and a particle is a single instanced draw, so the parts have to be
 * flattened - and each part's own transform baked in, or a model authored with
 * its wheels positioned by node transforms would draw all of them at the
 * origin.
 *
 * Normalised to a unit size and centred, because the particle's `size`
 * attribute is a multiplier: without it, whether a mesh particle appears at all
 * depends on what units the artist happened to model in, and a size of 1 would
 * mean 1cm for one asset and 100m for another.
 *
 * A failed load resolves to the built-in mesh rather than rejecting, matching
 * loadVfxTextures - the compiler already raises W_MISSING_ASSET.
 *
 * @param {Object} ir
 * @param {{resolveUrl?: (asset: Object) => string|null,
 *          loadGeometry?: (url: string) => Promise<Object>}} [options]
 * @returns {Promise<{meshes: Map<number, Object>, failed: number[]}>}
 */
export async function loadVfxMeshes(ir, options = {}) {
  const resolveUrl = options.resolveUrl;
  const meshes = new Map();
  const failed = [];
  const wanted = ir.assets.filter((asset) => asset.kind === 'mesh');
  if (wanted.length === 0 || !resolveUrl) return { meshes, failed };

  // Injectable, so a test can exercise the normalisation without a GLTFLoader
  // and a network - and so the loader is imported lazily rather than pulled
  // into every bundle that touches this module.
  const load = options.loadGeometry || defaultGeometryLoader();

  await Promise.all(wanted.map(async (asset) => {
    const url = resolveUrl(asset);
    if (!url) {
      failed.push(asset.assetId);
      return;
    }
    try {
      const geometry = await load(url);
      if (!geometry) throw new Error('no geometry');
      meshes.set(asset.assetId, normaliseParticleGeometry(geometry));
    } catch {
      failed.push(asset.assetId);
    }
  }));

  return { meshes, failed };
}

// The real loader, resolved on first use. Dynamic so `node` can import this
// module and call loadVfxMeshes with an injected loader without ever touching
// GLTFLoader, which reaches for DOM APIs at module scope.
function defaultGeometryLoader() {
  return async (url) => {
    const [{ GLTFLoader }, three] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three'),
    ]);
    const gltf = await new GLTFLoader().loadAsync(url);
    const parts = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      // Cloned and baked: the source geometry belongs to the glTF, and applying
      // a transform to it in place would corrupt the cached asset for anything
      // else that loaded the same file.
      const geometry = child.geometry.clone();
      geometry.applyMatrix4(child.matrixWorld);
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'uv') geometry.deleteAttribute(name);
      }
      parts.push(geometry);
    });
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const merged = three.BufferGeometryUtils
      ? three.BufferGeometryUtils.mergeGeometries(parts)
      : (await import('three/examples/jsm/utils/BufferGeometryUtils.js'))
        .mergeGeometries(parts);
    for (const part of parts) part.dispose();
    return merged;
  };
}

/**
 * Centre a geometry on its own bounds and scale it to fit a unit sphere.
 *
 * Exported for the tests: this is the part that decides whether a size of 1
 * means the same thing for every mesh asset, and it is pure.
 *
 * @param {Object} geometry a THREE.BufferGeometry
 * @returns {Object} the same geometry, modified in place
 */
export function normaliseParticleGeometry(geometry) {
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere || !(sphere.radius > 0)) return geometry;
  const position = geometry.attributes.position;
  const { center, radius } = sphere;
  const scale = 0.5 / radius;
  const array = position.array;
  for (let i = 0; i < array.length; i += 3) {
    array[i] = (array[i] - center.x) * scale;
    array[i + 1] = (array[i + 1] - center.y) * scale;
    array[i + 2] = (array[i + 2] - center.z) * scale;
  }
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Release loaded meshes. The built-in one is module-owned, like the sprite.
 * @param {Map<number, Object>} meshes
 */
export function disposeVfxMeshes(meshes) {
  for (const geometry of meshes.values()) {
    if (geometry !== defaultMesh) geometry.dispose();
  }
  meshes.clear();
}

/**
 * Release loaded textures. The built-in sprite is module-owned and is never
 * disposed - it outlives any one effect, and disposing it would leave the next
 * effect drawing untextured squares.
 *
 * @param {Map<number, import('three').Texture>} textures
 */
export function disposeVfxTextures(textures) {
  for (const texture of textures.values()) {
    if (texture !== defaultSprite) texture.dispose();
  }
  textures.clear();
}
