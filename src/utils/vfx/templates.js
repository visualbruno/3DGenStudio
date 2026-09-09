// Starter effects: ready-made graphs an author opens and tweaks.
//
// This is the single biggest lever on "make VFX easy". Nobody learns a particle
// system from an empty board - they learn it by opening something that already
// works and changing one number at a time until they understand what each one
// does. So a template is not demo content, it is the primary on-ramp, and every
// one of them has to compile with zero warnings: a template that trips a
// diagnostic is a bug in the template, not a lesson.
//
// `teaches` is what the gallery shows under each card. Naming the technique is
// the difference between "here is a nice explosion" and "here is how staged
// timing works", and the second one is what makes the next effect easier.
//
// THREE FOR NOW, twelve by the time the gallery ships - fire, smoke, explosion,
// muzzle flash, sparks, magic, portal, rain, snow, dust, blood, trail. These
// three are the ones that between them exercise every part of the renderer:
// additive stretched billboards, alpha-blended depth-sorted billboards, and a
// multi-system effect with timeline clips.

import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc } from '../../../vfx/doc.js'
import { CURVE_PRESETS } from '../../../vfx/curve.js'
import { GRADIENT_PRESETS } from '../../../vfx/gradient.js'
import { constValue, curveValue, gradientValue, randomValue } from '../../../vfx/value.js'

const curve = (id, options) => curveValue(CURVE_PRESETS.find(p => p.id === id).build(), options)
const ramp = id => gradientValue(GRADIENT_PRESETS.find(p => p.id === id).build())

let counter = 0
const block = (type, props = {}, modes) => {
  counter += 1
  const entry = { id: `b-${counter.toString(36)}`, type, enabled: true, props }
  if (modes) entry.modes = modes
  return entry
}

// Assemble a system from per-stage stacks. The Output's params carry the render
// state; its blocks carry the texture slot.
function makeSystem(spec) {
  counter += 1
  const tag = counter.toString(36)
  const contexts = [
    { id: `c-spawn-${tag}`, kind: CONTEXT_KIND.SPAWN, blocks: spec.spawn || [], params: {} },
    { id: `c-init-${tag}`, kind: CONTEXT_KIND.INITIALIZE, blocks: spec.init || [], params: {} },
    { id: `c-update-${tag}`, kind: CONTEXT_KIND.UPDATE, blocks: spec.update || [], params: {} },
    {
      id: `c-out-${tag}`,
      kind: CONTEXT_KIND.OUTPUT,
      blocks: spec.outputBlocks || [],
      params: spec.output,
    },
  ]
  return {
    id: `sys-${tag}`,
    name: spec.name,
    enabled: true,
    capacity: spec.capacity,
    simulationSpace: 'inherit',
    contexts,
    schedule: spec.clips ? { clips: spec.clips } : undefined,
  }
}

function sparks() {
  const doc = createEmptyVfxDoc({ name: 'Sparks' })
  doc.effect.duration = 1.6
  doc.effect.loop = true
  doc.effect.capacity = 2048
  doc.systems = [makeSystem({
    name: 'Sparks',
    capacity: 512,
    spawn: [block('spawn.burst', { count: constValue(140) })],
    init: [
      // Randomised, because a burst is instantaneous - without this every
      // spark would also die at the same instant, which reads as a machine.
      block('initialize.setLifetime', { lifetime: randomValue(0.3, 0.85) }),
      block('initialize.setSize', { size: randomValue(0.02, 0.05) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      block('initialize.positionSphere', { radius: constValue(0.06) }, { fill: 'volume' }),
      block('initialize.velocityRandom', {
        min: constValue([-4, -0.5, -4]),
        max: constValue([4, 6, 4]),
      }),
    ],
    update: [
      block('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
      // Drag is what makes a burst decelerate instead of flying off at
      // constant speed - the difference between sparks and bullets.
      block('update.drag', { drag: constValue(1.4) }),
      block('update.colorOverLife', { color: ramp('ember') }),
    ],
    output: { mode: 'stretched', blend: 'additive', sort: 'none' },
  })]
  return normalizeVfxDoc(doc)
}

function smoke() {
  const doc = createEmptyVfxDoc({ name: 'Smoke' })
  doc.effect.duration = 4
  doc.effect.loop = true
  doc.effect.capacity = 2048
  doc.systems = [makeSystem({
    name: 'Smoke',
    capacity: 1024,
    spawn: [block('spawn.rate', { rate: constValue(45) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(2.2, 3.6) }),
      block('initialize.setSize', { size: randomValue(0.5, 0.9) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      block('initialize.positionSphere', { radius: constValue(0.25) }, { fill: 'volume' }),
      block('initialize.velocityRandom', {
        min: constValue([-0.25, 0.5, -0.25]),
        max: constValue([0.25, 1.1, 0.25]),
      }),
    ],
    update: [
      // A little positive gravity, so it rises rather than falls.
      block('update.gravity', { gravity: constValue([0, 0.45, 0]) }),
      block('update.drag', { drag: constValue(1.1) }),
      // Turbulence is what stops it looking like it is on rails.
      block('update.turbulence', { strength: constValue(0.55), frequency: constValue(0.45) }),
      block('update.sizeOverLife', { scale: curve('rampUp', { scale: 2.4 }) }),
      block('update.colorOverLife', { color: ramp('smoke') }),
    ],
    // Alpha blended and depth sorted: smoke should occlude what is behind it,
    // and unlike additive, alpha blending is not order-independent.
    output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
  })]
  return normalizeVfxDoc(doc)
}

function muzzleFlash() {
  const doc = createEmptyVfxDoc({ name: 'Muzzle Flash' })
  doc.effect.duration = 1.2
  doc.effect.loop = true
  doc.effect.capacity = 1024
  doc.systems = [
    makeSystem({
      name: 'Flash',
      capacity: 16,
      clips: [{ at: 0, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(3) })],
      init: [
        block('initialize.setLifetime', { lifetime: constValue(0.09) }),
        block('initialize.setSize', { size: randomValue(0.7, 1.1) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      ],
      update: [
        // Bright instantly, then gone - that shape is what a flash IS.
        block('update.sizeOverLife', { scale: curve('spike', { scale: 1.6 }) }),
        block('update.colorOverLife', { color: ramp('fire') }),
      ],
      output: { mode: 'billboard', blend: 'additive', sort: 'none' },
    }),
    makeSystem({
      name: 'Sparks',
      capacity: 256,
      // Two frames after the flash. Staged timing is what makes an impact read
      // as one event rather than as several things happening at once.
      clips: [{ at: 0.03, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(45) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.15, 0.4) }),
        block('initialize.setSize', { size: randomValue(0.015, 0.035) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        // A cone sets position AND direction, so Spread is what turns a tight
        // jet into a wide spray.
        block('initialize.positionCone', {
          angle: constValue(22),
          radius: constValue(0.04),
          speed: randomValue(5, 11),
        }),
      ],
      update: [
        block('update.gravity', { gravity: constValue([0, -6, 0]) }),
        block('update.drag', { drag: constValue(2.4) }),
        block('update.colorOverLife', { color: ramp('ember') }),
      ],
      output: { mode: 'stretched', blend: 'additive', sort: 'none' },
    }),
    makeSystem({
      name: 'Smoke',
      capacity: 256,
      clips: [{ at: 0.05, duration: 0.25, loop: false }],
      spawn: [block('spawn.rate', { rate: constValue(90) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.6, 1.1) }),
        block('initialize.setSize', { size: randomValue(0.2, 0.4) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionCone', {
          angle: constValue(35),
          radius: constValue(0.06),
          speed: randomValue(1, 2.5),
        }),
      ],
      update: [
        block('update.drag', { drag: constValue(3.2) }),
        block('update.sizeOverLife', { scale: curve('rampUp', { scale: 2.2 }) }),
        block('update.colorOverLife', { color: ramp('smoke') }),
      ],
      output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
    }),
  ]
  return normalizeVfxDoc(doc)
}

/**
 * The starter library. `build` returns a fresh document every call, so opening
 * a template twice never shares mutable state between the two.
 */
export const VFX_TEMPLATES = Object.freeze([
  {
    id: 'sparks',
    name: 'Sparks',
    category: 'Impacts & Hits',
    blurb: 'A burst of hot streaks that fall and cool. One draw call.',
    teaches: ['Bursts and randomised lifetime', 'Stretched billboards', 'Gravity and drag'],
    build: sparks,
  },
  {
    id: 'smoke',
    name: 'Smoke',
    category: 'Smoke & Dust',
    blurb: 'A rising, swelling plume that thins as it goes.',
    teaches: ['Rate emission', 'Alpha blending with depth sorting', 'Turbulence', 'Size over life'],
    build: smoke,
  },
  {
    id: 'muzzleFlash',
    name: 'Muzzle Flash',
    category: 'Impacts & Hits',
    blurb: 'A flash, then sparks, then a puff of smoke - three systems on a timeline.',
    teaches: ['Staged timing with clips', 'Cone emitters', 'Combining additive and alpha in one effect'],
    build: muzzleFlash,
  },
])

/**
 * @param {string} id
 * @returns {Object|null}
 */
export function templateById(id) {
  return VFX_TEMPLATES.find(template => template.id === id) || null
}
