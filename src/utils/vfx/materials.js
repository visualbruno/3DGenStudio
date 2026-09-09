// The particle material family: one ShaderMaterial, with the render mode and
// the blend mode selected by #define.
//
// WHY A CUSTOM SHADER AND NOT MeshBasicMaterial + onBeforeCompile. A billboard
// needs a full custom vertex stage - the quad corner has to be offset in view
// space by the instance's size, and a stretched billboard has to be oriented
// along view-space velocity. Patching three's shader chunks to do that means
// fighting its material system for the whole vertex stage, and the headers of
// src/utils/gpuTextureBake.js and src/utils/assemblyAtlasBake.js already record
// what that costs in this codebase.
//
// WHY ShaderMaterial AND NOT RawShaderMaterial. Tone mapping. three injects the
// TONE_MAPPING define from `material.toneMapped ? renderer.toneMapping : none`,
// and the `tonemapping_fragment` / `colorspace_fragment` chunks are available by
// #include only in a ShaderMaterial. A RawShaderMaterial would silently skip
// both, so particles would bypass ACES and the sRGB encode while every other
// viewport in the app applies them - which is precisely the mismatch the
// tone-mapping decision exists to avoid.
//
// PREMULTIPLICATION, AND THE DOUBLE-MULTIPLY TRAP. This is the classic way
// additive particles go wrong, and it is worth spelling out because the obvious
// reading of "premultiply in the shader" produces it.
//
//   three's AdditiveBlending is (SrcAlpha, One), so the GPU ALREADY multiplies
//   the fragment's rgb by its alpha. A shader that also outputs rgb * a gets
//   alpha squared: a fade to 25% opacity dims to 6%, so the tail of every
//   additive effect vanishes early and the fade reads as too fast.
//
// So the rule here is explicit per mode rather than uniform:
//
//   additive       straight colour  + AdditiveBlending (SrcAlpha, One)
//   alpha          straight colour  + NormalBlending   (SrcAlpha, 1-SrcAlpha)
//   premultiplied  rgb * a          + CustomBlending   (One, 1-SrcAlpha)
//   opaque         straight colour  + no blending, depth write on
//
// Only the premultiplied path defines PREMULTIPLY. That mode exists because it
// is the one that lets a single texture hold both additive glow and alpha smoke
// - a texel with rgb above zero and alpha at zero is pure light, and a texel
// with rgb equal to alpha is opaque - which is how a real explosion sheet is
// authored. Unity calls it Premultiply, Niagara AlphaComposite.

import {
  AdditiveBlending,
  CustomBlending,
  DoubleSide,
  FrontSide,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
} from 'three';

/**
 * Render modes this file implements.
 *
 * `trail` is deliberately ABSENT and falls back to a billboard, with an
 * I_TRAIL_UNSUPPORTED diagnostic saying so. A real trail records a history of
 * positions per particle and builds a triangle strip from it, which is a
 * different geometry path rather than another shader define - one instance per
 * particle cannot express a ribbon with eight segments without eight position
 * attributes, and that is sixteen vertex attributes in total, at the floor
 * WebGL2 guarantees. A dense stream of stretched billboards is what the Trail
 * template uses instead, and its card says as much.
 */
export const RENDER_MODE = Object.freeze({
  BILLBOARD: 'billboard',
  STRETCHED: 'stretched',
  POINT: 'point',
  MESH: 'mesh',
});

const VERTEX_HEAD = /* glsl */`
attribute vec3 iPos;
attribute float iSize;
attribute vec4 iColor;
`;

// The instance attributes that are conditional. Declared from the layout table
// rather than always, so a shader never references an attribute the geometry
// does not provide - which in WebGL is not an error, it is a silent zero.
const OPTIONAL_ATTRS = {
  iVelocity: 'attribute vec3 iVelocity;',
  iRotation: 'attribute float iRotation;',
  iTile: 'attribute float iTile;',
};

const VERTEX_BODY = /* glsl */`
uniform float uAlphaDt;
uniform float uStretch;
uniform float uPointScale;
uniform vec2 uTiles;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec3 world = iPos;

  #ifdef USE_SMOOTHING
    // Sub-step extrapolation. The simulation runs at a fixed 60Hz; on a faster
    // display this carries each particle forward by the fraction of a step the
    // clock is into, which removes the judder without a second position buffer -
    // and position is the biggest attribute there is.
    world += iVelocity * uAlphaDt;
  #endif

  #ifdef MODE_MESH
    // REAL GEOMETRY, NOT A BILLBOARD. The position attribute is the mesh's own
    // vertex here, so
    // it is scaled by the particle's size, rotated, and translated into world
    // space - the opposite of the billboard path, which ignores the vertex's
    // world orientation entirely and offsets in VIEW space to face the camera.
    //
    // Rotation is about Y. A single float cannot describe an arbitrary
    // orientation, and Y is the axis that reads as "tumbling" for debris
    // standing on a floor; a full quaternion per particle would be four more
    // floats in the instance buffer for every effect, including the vast
    // majority that draw billboards.
    vec3 local = position * iSize;
    #ifdef USE_ROTATION
      float ms = sin(iRotation);
      float mc = cos(iRotation);
      local = vec3(local.x * mc - local.z * ms, local.y, local.x * ms + local.z * mc);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world + local, 1.0);
    vUv = uv;
    vColor = iColor;
    return;
  #endif

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  vec2 corner = position.xy;

  #ifdef USE_ROTATION
    float s = sin(iRotation);
    float c = cos(iRotation);
    corner = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  #endif

  #ifdef MODE_STRETCHED
    // Orient the quad along velocity in VIEW space, so the streak follows the
    // apparent motion rather than the world axis. Transformed as a direction
    // (w = 0) through modelViewMatrix so the effect's own transform applies.
    vec3 vView = (modelViewMatrix * vec4(iVelocity, 0.0)).xyz;
    float speed = length(vView.xy);
    // The epsilon matters: a particle at rest has no direction, and normalising
    // a zero vector gives NaN, which propagates to gl_Position and makes the
    // whole quad disappear rather than merely pointing the wrong way.
    vec2 dir = speed > 1e-5 ? vView.xy / speed : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float len = iSize * (1.0 + speed * uStretch);
    mv.xy += dir * (corner.y * len) + perp * (corner.x * iSize);
  #elif defined(MODE_POINT)
    // A POINT holds its size on screen however far away it is, which is the
    // one thing that distinguishes it from a billboard - it is for star
    // fields, dust seen at a distance, and data-like markers that must stay
    // legible rather than dwindling.
    //
    // Multiplying the view-space offset by -mv.z cancels the perspective
    // division that follows, so the quad ends up the same number of pixels
    // across at any depth. The reference distance keeps the size property
    // meaning roughly
    // what it means for a billboard at a metre away, rather than becoming a
    // separate unit the author has to relearn.
    //
    // Clamped away from zero because a particle level with the camera plane
    // has -mv.z of zero, and dividing the world by that puts the quad at
    // infinity - which in practice makes it swallow the screen for one frame.
    mv.xy += corner * iSize * max(0.05, -mv.z) * uPointScale;
  #else
    // Billboard: offsetting in view space is what makes the quad face the
    // camera, with no per-particle matrix and no CPU work.
    mv.xy += corner * iSize;
  #endif

  gl_Position = projectionMatrix * mv;

  #ifdef USE_FLIPBOOK
    // The atlas cell for this particle's frame.
    //
    // COMPUTED IN THE VERTEX STAGE, not the fragment stage: the frame is
    // per-particle, so it is constant across the quad, and doing it per pixel
    // would repeat the same division for every fragment of every particle.
    //
    // Rows count DOWNWARD from the top, because that is how every sprite sheet
    // an artist will hand you is laid out, while GL's V axis runs upward. The
    // subtraction is that flip; getting it wrong plays the sheet bottom-to-top,
    // which for an explosion looks like it is imploding.
    float frames = max(1.0, uTiles.x * uTiles.y);
    float frame = floor(mod(iTile, frames));
    float column = mod(frame, uTiles.x);
    float row = floor(frame / uTiles.x);
    vec2 cell = vec2(1.0) / uTiles;
    vUv = vec2(
      (column + uv.x) * cell.x,
      1.0 - (row + 1.0 - uv.y) * cell.y
    );
  #else
    vUv = uv;
  #endif

  vColor = iColor;
}
`;

const FRAGMENT = /* glsl */`
uniform sampler2D uMap;
uniform float uIntensity;
uniform float uAlphaCutoff;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 texel = vec4(1.0);
  #ifdef USE_MAP
    texel = texture2D(uMap, vUv);
  #endif

  vec4 colour = texel * vColor;
  colour.rgb *= uIntensity;

  #ifdef ALPHA_CLIP
    if (colour.a < uAlphaCutoff) discard;
  #endif

  #ifdef PREMULTIPLY
    colour.rgb *= colour.a;
  #endif

  gl_FragColor = colour;

  // ACES and the sRGB encode, from three's own chunks. Present so particles go
  // through exactly the same tone mapping as every other viewport in the app -
  // see the header. material.toneMapped = false turns the first one off for a
  // UI-space effect that must be the authored colour.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Compose the vertex shader for one layout, declaring exactly the attributes
 * the geometry provides.
 *
 * @param {{fields: Array<{name: string}>}} layout
 * @returns {string}
 */
export function buildVertexShader(layout) {
  const optional = layout.fields
    .map((field) => OPTIONAL_ATTRS[field.name])
    .filter(Boolean)
    .join('\n');
  return `${VERTEX_HEAD}${optional}\n${VERTEX_BODY}`;
}

// Blend state per mode. Separated from the shader so the double-multiply trap
// in the header is decided in exactly one place.
function applyBlend(params, blend) {
  switch (blend) {
    case 'alpha':
      params.blending = NormalBlending;
      params.transparent = true;
      params.depthWrite = false;
      return false;
    case 'premultiplied':
      params.blending = CustomBlending;
      params.blendSrc = OneFactor;
      params.blendDst = OneMinusSrcAlphaFactor;
      params.transparent = true;
      params.depthWrite = false;
      return true;
    case 'opaque':
      params.blending = NormalBlending;
      params.transparent = false;
      params.depthWrite = true;
      return false;
    case 'additive':
    default:
      params.blending = AdditiveBlending;
      params.transparent = true;
      // Depth write off, depth TEST on: an additive particle should be hidden
      // by solid geometry in front of it but must not occlude the particle
      // behind it, or a cloud of them turns into a stack of visible cards.
      params.depthWrite = false;
      return false;
  }
}

/**
 * Build the material for one Output.
 *
 * @param {Object} spec
 * @param {Object} spec.layout the output's instanceLayout from the IR
 * @param {string} spec.mode render mode
 * @param {string} spec.blend blend mode
 * @param {import('three').Texture|null} [spec.texture]
 * @param {number} [spec.intensity] HDR multiplier applied before tone mapping
 * @param {boolean} [spec.toneMapped] false for UI-space effects
 * @param {number} [spec.alphaCutoff] enables ALPHA_CLIP when above zero
 * @param {number} [spec.stretch] how much speed lengthens a stretched billboard
 * @param {boolean} [spec.smoothing]
 * @param {[number, number]} [spec.tiles] atlas columns and rows; enables the
 *   flipbook path when either is above 1
 * @returns {import('three').ShaderMaterial}
 */
export function createParticleMaterial(spec) {
  const {
    layout,
    mode = RENDER_MODE.BILLBOARD,
    blend = 'additive',
    texture = null,
    intensity = 1,
    toneMapped = true,
    alphaCutoff = 0,
    stretch = 0.08,
    smoothing = true,
    tiles = null,
  } = spec;

  const has = new Set(layout.fields.map((f) => f.name));
  const defines = {};
  if (mode === RENDER_MODE.STRETCHED && has.has('iVelocity')) defines.MODE_STRETCHED = '';
  if (mode === RENDER_MODE.MESH) defines.MODE_MESH = '';
  if (mode === RENDER_MODE.POINT) defines.MODE_POINT = '';
  if (smoothing && has.has('iVelocity')) defines.USE_SMOOTHING = '';
  if (has.has('iRotation')) defines.USE_ROTATION = '';
  // Both halves are required: an atlas layout with no iTile attribute would
  // read a frame nobody wrote, and an iTile with no layout has nothing to
  // divide the texture into.
  const columns = tiles && tiles[0] > 0 ? tiles[0] : 1;
  const rows = tiles && tiles[1] > 0 ? tiles[1] : 1;
  const flipbook = has.has('iTile') && (columns > 1 || rows > 1);
  if (flipbook) defines.USE_FLIPBOOK = '';
  if (texture) defines.USE_MAP = '';
  if (alphaCutoff > 0) defines.ALPHA_CLIP = '';

  const params = {
    defines,
    vertexShader: buildVertexShader(layout),
    fragmentShader: FRAGMENT,
    uniforms: {
      uMap: { value: texture },
      uIntensity: { value: intensity },
      uAlphaCutoff: { value: alphaCutoff },
      uAlphaDt: { value: 0 },
      uStretch: { value: stretch },
      // The reciprocal of the distance at which a point matches a billboard of
      // the same size. One metre, so the two modes agree at arm's length and an
      // author switching between them is not also re-picking every size.
      uPointScale: { value: 1 },
      uTiles: { value: new Vector2(columns, rows) },
    },
    depthTest: true,
    // Particles are flat quads with no meaningful facing, and a billboard
    // offset in view space can end up wound either way depending on the
    // camera. Culling would make some of them vanish from certain angles.
    // Billboards are flat quads with no meaningful facing and a view-space
    // offset can wind either way, so culling would make some of them vanish
    // from certain angles. A MESH has real faces and a real winding, so it is
    // culled normally - drawing the back of every triangle would double the
    // fragment cost of every piece of debris for nothing.
    side: mode === RENDER_MODE.MESH ? FrontSide : DoubleSide,
    toneMapped,
  };

  if (applyBlend(params, blend)) params.defines.PREMULTIPLY = '';

  return new ShaderMaterial(params);
}

/**
 * Push per-frame uniforms. Called once per batch per frame, not per particle.
 *
 * @param {import('three').ShaderMaterial} material
 * @param {{alphaDt?: number, intensity?: number}} frame
 */
export function updateParticleMaterial(material, frame) {
  if (frame.alphaDt !== undefined) material.uniforms.uAlphaDt.value = frame.alphaDt;
  if (frame.intensity !== undefined) material.uniforms.uIntensity.value = frame.intensity;
}
