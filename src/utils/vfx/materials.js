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
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
} from 'three';

/** Render modes this file implements. Others fall back to a billboard. */
export const RENDER_MODE = Object.freeze({
  BILLBOARD: 'billboard',
  STRETCHED: 'stretched',
  POINT: 'point',
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
  #else
    // Billboard: offsetting in view space is what makes the quad face the
    // camera, with no per-particle matrix and no CPU work.
    mv.xy += corner * iSize;
  #endif

  gl_Position = projectionMatrix * mv;
  vUv = uv;
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
  } = spec;

  const has = new Set(layout.fields.map((f) => f.name));
  const defines = {};
  if (mode === RENDER_MODE.STRETCHED && has.has('iVelocity')) defines.MODE_STRETCHED = '';
  if (smoothing && has.has('iVelocity')) defines.USE_SMOOTHING = '';
  if (has.has('iRotation')) defines.USE_ROTATION = '';
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
    },
    depthTest: true,
    // Particles are flat quads with no meaningful facing, and a billboard
    // offset in view space can end up wound either way depending on the
    // camera. Culling would make some of them vanish from certain angles.
    side: DoubleSide,
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
