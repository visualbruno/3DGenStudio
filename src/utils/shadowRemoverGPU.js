import * as THREE from 'three'

const VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Key algorithm changes from previous version:
//
// 1. Removed pow(shadowMask, 2.2) — applying display gamma to a blend mask is incorrect.
//    It suppressed the effect on moderate shadows (pow(0.5,2.2)≈0.22) and had no
//    photographic rationale. Threshold + softness already control selectivity.
//
// 2. Fixed double-mask bug — the old code applied effectiveMask both inside
//    targetLuminance and in the final mix(), squaring its influence on edge pixels.
//    The gamma-lift approach encodes the mask directly in the exponent, so there
//    is no separate blend step.
//
// 3. Replaced additive lift with a gamma-curve lift: pow(rgb, liftGamma), where
//    liftGamma = 1 - effectiveMask * uStrength * 0.6. This is how Lightroom/
//    Photoshop Shadows sliders work. It lifts deep shadows heavily, midtones
//    gently, and highlights not at all — matching photographic expectations.
//    It also eliminates the extreme liftRatio problem near luminance≈0.
//
// 4. Added noise floor guard: smoothstep(0.005, 0.025, luminance) softly prevents
//    the effect from amplifying sensor noise in near-black pixels.
//
// 5. Replaced the 8% desaturation (neutralize) with a uWarmth parameter. Real
//    photographic shadows have a cool (sky-lit) blue cast. A warmth slider lets
//    you correct that at the same time as lifting, which is the standard workflow.
//
// 6. Added early-exit for near-transparent pixels.

const FRAGMENT_SHADER = `
uniform sampler2D tDiffuse;
uniform float uStrength;
uniform float uThreshold;
uniform float uSoftness;
uniform float uMidtoneProtection;
uniform float uWarmth;
varying vec2 vUv;

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);

  // Skip fully transparent pixels — no visible effect, avoids unnecessary work
  if (texel.a < 0.004) {
    gl_FragColor = texel;
    return;
  }

  float luminance = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));

  // Shadow mask: 1.0 in deep shadows, 0.0 in highlights
  float shadowStart = max(0.0, uThreshold - uSoftness);
  float shadowEnd = min(1.0, uThreshold + uSoftness * 1.35);
  float shadowMask = 1.0 - smoothstep(shadowStart, shadowEnd, luminance);

  // Noise floor: smoothly fade out the effect below ~2% luminance so sensor
  // noise in near-black regions is not amplified by the lift
  float noiseGuard = smoothstep(0.005, 0.025, luminance);
  shadowMask *= noiseGuard;

  // Midtone / highlight protection: prevents the lift from bleeding into brighter areas
  float protectStart = mix(0.18, 0.42, uMidtoneProtection);
  float protectEnd = mix(0.48, 0.82, uMidtoneProtection);
  float highlightGuard = smoothstep(protectStart, protectEnd, luminance);
  float effectiveMask = shadowMask * (1.0 - highlightGuard);

  // Photographic gamma-curve lift.
  // liftGamma encodes both where (effectiveMask) and how much (uStrength) to lift.
  // At effectiveMask=0: gamma=1.0, no change.
  // At effectiveMask=1, uStrength=1: gamma=0.4, strong perceptual lift.
  float liftGamma = 1.0 - effectiveMask * uStrength * 0.6;
  vec3 lifted = pow(clamp(texel.rgb, 0.0001, 1.0), vec3(liftGamma));

  // Warmth correction for lifted shadows.
  // Positive uWarmth: reduce cool (blue) cast — common in sky-lit outdoor shadows.
  // Negative uWarmth: push shadows cooler (artistic / indoor use).
  float warmthShift = effectiveMask * uStrength * uWarmth * 0.12;
  lifted.r = clamp(lifted.r + warmthShift, 0.0, 1.0);
  lifted.b = clamp(lifted.b - warmthShift, 0.0, 1.0);

  gl_FragColor = vec4(clamp(lifted, 0.0, 1.0), texel.a);
}
`

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1
  }
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function cloneCanvas(sourceCanvas) {
  if (!sourceCanvas) return null
  const cloned = createCanvas(sourceCanvas.width, sourceCanvas.height)
  cloned.getContext('2d').drawImage(sourceCanvas, 0, 0)
  return cloned
}

function normalizeSettings(settings = {}) {
  return {
    strength: clamp((Number(settings.strength) || 0) / 100, 0, 1),
    threshold: clamp((Number(settings.threshold) || 0) / 100, 0, 1),
    softness: clamp((Number(settings.softness) || 0) / 100, 0.01, 1),
    midtoneProtection: clamp((Number(settings.midtoneProtection) || 0) / 100, 0, 1),
    warmth: clamp((Number(settings.warmth) || 0) / 100, -1, 1)
  }
}

// CPU fallback — exact mirror of the GLSL shader above
function applyShadowRemoverCpu(sourceCanvas, settings) {
  const normalized = normalizeSettings(settings)
  if (normalized.strength <= 0) {
    return cloneCanvas(sourceCanvas)
  }

  const outputCanvas = createCanvas(sourceCanvas.width, sourceCanvas.height)
  const context = outputCanvas.getContext('2d')
  context.drawImage(sourceCanvas, 0, 0)

  const imageData = context.getImageData(0, 0, outputCanvas.width, outputCanvas.height)
  const data = imageData.data

  const shadowStart = Math.max(0, normalized.threshold - normalized.softness)
  const shadowEnd = Math.min(1, normalized.threshold + normalized.softness * 1.35)
  const protectStart = 0.18 + (0.42 - 0.18) * normalized.midtoneProtection
  const protectEnd = 0.48 + (0.82 - 0.48) * normalized.midtoneProtection

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]
    // Mirror the shader's early-exit for near-transparent pixels (< ~1/255 ≈ 0.004)
    if (alpha < 1) {
      continue
    }

    const red = data[index] / 255
    const green = data[index + 1] / 255
    const blue = data[index + 2] / 255
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722

    // Shadow mask — same as GLSL, no pow(2.2) bias
    let shadowMask = 1 - smoothstep(shadowStart, shadowEnd, luminance)

    // Noise floor guard
    const noiseGuard = smoothstep(0.005, 0.025, luminance)
    shadowMask *= noiseGuard

    // Midtone / highlight protection
    const highlightGuard = smoothstep(protectStart, protectEnd, luminance)
    const effectiveMask = shadowMask * (1 - highlightGuard)

    // Gamma-curve lift
    const liftGamma = 1 - effectiveMask * normalized.strength * 0.6
    const safe = Math.max

    let nextRed = Math.pow(clamp(red, 0.0001, 1), liftGamma)
    let nextGreen = Math.pow(clamp(green, 0.0001, 1), liftGamma)
    let nextBlue = Math.pow(clamp(blue, 0.0001, 1), liftGamma)

    // Warmth correction
    const warmthShift = effectiveMask * normalized.strength * normalized.warmth * 0.12
    nextRed = clamp(nextRed + warmthShift, 0, 1)
    nextBlue = clamp(nextBlue - warmthShift, 0, 1)

    data[index] = Math.round(clamp(nextRed, 0, 1) * 255)
    data[index + 1] = Math.round(clamp(nextGreen, 0, 1) * 255)
    data[index + 2] = Math.round(clamp(nextBlue, 0, 1) * 255)
  }

  context.putImageData(imageData, 0, 0)
  return outputCanvas
}

class ShadowRemoverRenderer {
  constructor() {
    const canvas = document.createElement('canvas')
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      canvas,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true
    })
    this.renderer.setPixelRatio(1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: 0 },
        uThreshold: { value: 0.5 },
        uSoftness: { value: 0.2 },
        uMidtoneProtection: { value: 0.5 },
        uWarmth: { value: 0 }
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false
    })

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.scene.add(this.mesh)
    this.width = 0
    this.height = 0
  }

  render(sourceCanvas, settings) {
    if (!sourceCanvas?.width || !sourceCanvas?.height) {
      return null
    }

    if (this.width !== sourceCanvas.width || this.height !== sourceCanvas.height) {
      this.width = sourceCanvas.width
      this.height = sourceCanvas.height
      this.renderer.setSize(this.width, this.height, false)
    }

    const normalized = normalizeSettings(settings)
    if (normalized.strength <= 0) {
      return cloneCanvas(sourceCanvas)
    }

    const texture = new THREE.CanvasTexture(sourceCanvas)
    texture.colorSpace = THREE.NoColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter

    this.material.uniforms.tDiffuse.value = texture
    this.material.uniforms.uStrength.value = normalized.strength
    this.material.uniforms.uThreshold.value = normalized.threshold
    this.material.uniforms.uSoftness.value = normalized.softness
    this.material.uniforms.uMidtoneProtection.value = normalized.midtoneProtection
    this.material.uniforms.uWarmth.value = normalized.warmth

    this.renderer.render(this.scene, this.camera)

    const outputCanvas = createCanvas(this.width, this.height)
    outputCanvas.getContext('2d').drawImage(this.renderer.domElement, 0, 0, this.width, this.height)

    texture.dispose()
    this.material.uniforms.tDiffuse.value = null
    return outputCanvas
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.renderer.dispose()
  }
}

let rendererInstance = null

function getRenderer() {
  if (!rendererInstance) {
    rendererInstance = new ShadowRemoverRenderer()
  }

  return rendererInstance
}

export function applyShadowRemoverToCanvas(sourceCanvas, settings) {
  if (!sourceCanvas) {
    return { canvas: null, mode: 'gpu', fallbackReason: '' }
  }

  const normalized = normalizeSettings(settings)
  if (normalized.strength <= 0) {
    return { canvas: cloneCanvas(sourceCanvas), mode: 'bypass', fallbackReason: '' }
  }

  try {
    const renderer = getRenderer()
    const canvas = renderer.render(sourceCanvas, settings)
    if (canvas) {
      return { canvas, mode: 'gpu', fallbackReason: '' }
    }
  } catch (error) {
    const canvas = applyShadowRemoverCpu(sourceCanvas, settings)
    return {
      canvas,
      mode: 'cpu',
      fallbackReason: error instanceof Error ? error.message : 'WebGL initialization failed.'
    }
  }

  return { canvas: applyShadowRemoverCpu(sourceCanvas, settings), mode: 'cpu', fallbackReason: 'GPU rendering returned no output.' }
}

export function disposeShadowRemoverRenderer() {
  rendererInstance?.dispose()
  rendererInstance = null
}
