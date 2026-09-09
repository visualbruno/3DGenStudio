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
