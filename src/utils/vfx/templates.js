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
// TWELVE, and the list is deliberate rather than a round number: fire, smoke,
// explosion, muzzle flash, sparks, magic, portal, rain, snow, dust, blood,
// trail. Between them they exercise every part of the renderer that exists -
// additive and alpha blending, stretched and plain billboards, depth sorting,
// multi-system timeline staging, floor collision, vortices, attractors and
// bounded emission - and each one is the shortest honest demonstration of the
// technique its card names.
//
// "TRAIL" IS A STRETCHED-BILLBOARD RIBBON, not a true trail renderer. A real
// trail records a history of positions per particle and builds a strip from it,
// which needs an attribute the pool does not carry and a geometry path the
// renderer does not have. A dense stream of stretched billboards along a path
// reads as a trail at speed and is what ships until that renderer exists; the
// card says as much rather than implying otherwise.

import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc } from '../../../vfx/doc.js'
import { CURVE_PRESETS } from '../../../vfx/curve.js'
import { GRADIENT_PRESETS } from '../../../vfx/gradient.js'
import { constValue, curveValue, gradientValue, randomValue } from '../../../vfx/value.js'

// Both throw with the id when a preset does not exist. Without that, a typo in
// a template surfaced as "cannot read properties of undefined (reading
// 'build')" from inside a builder, with nothing to say which preset or which
// template - and every template is built at module load by the gallery.
const findPreset = (list, id, kind) => {
  const preset = list.find(entry => entry.id === id)
  if (!preset) throw new Error(`VFX template: no ${kind} preset "${id}"`)
  return preset.build()
}
export const curve = (id, options) => curveValue(findPreset(CURVE_PRESETS, id, 'curve'), options)
export const ramp = id => gradientValue(findPreset(GRADIENT_PRESETS, id, 'gradient'))

let counter = 0
// EXPORTED FOR THE PRESET SEEDER (tools/vfx-preset-seed.mjs), which authors the
// rest of the library in the same vocabulary. One DSL, so a preset written
// today and a template written in phase 8 cannot drift into two dialects.
export const block = (type, props = {}, modes, points) => {
  counter += 1
  const entry = { id: `b-${counter.toString(36)}`, type, enabled: true, props }
  if (modes) entry.modes = modes
  // A path is block data rather than a property - see the `points` note in
  // vfx/catalog.js - so it cannot travel in `props` with the rest.
  if (points) entry.points = points
  return entry
}

// Assemble a system from per-stage stacks. The Output's params carry the render
// state; its blocks carry the texture slot.
export function makeSystem(spec) {
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

function fire() {
  const doc = createEmptyVfxDoc({ name: 'Fire' })
  doc.effect.duration = 3
  doc.effect.loop = true
  doc.effect.capacity = 2048
  doc.systems = [makeSystem({
    name: 'Flame',
    capacity: 512,
    spawn: [block('spawn.rate', { rate: constValue(70) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(0.7, 1.3) }),
      block('initialize.setSize', { size: randomValue(0.28, 0.5) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      // A narrow disc at the base rather than a sphere: a flame is anchored to
      // something burning, and a spherical source makes it look like it is
      // floating.
      block('initialize.positionCircle', {
        radius: constValue(0.22),
        thickness: constValue(0.22),
      }),
      block('initialize.velocityDirection', {
        direction: constValue([0, 1, 0]),
        speed: randomValue(1.1, 2),
        spread: constValue(14),
      }),
      block('initialize.setRotation', { rotation: randomValue(-180, 180) }),
    ],
    update: [
      // Buoyancy: hot gas accelerates upward, which is what gives a flame its
      // characteristic narrowing rather than a straight column.
      block('update.gravity', { gravity: constValue([0, 1.6, 0]) }),
      block('update.drag', { drag: constValue(1.8) }),
      block('update.turbulence', { strength: constValue(1.1), frequency: constValue(1.3) }),
      block('update.sizeOverLife', { scale: curve('easeOut', { scale: 1.4 }) }),
      block('update.colorOverLife', { color: ramp('fire') }),
    ],
    output: { mode: 'billboard', blend: 'additive', sort: 'none' },
  })]
  return normalizeVfxDoc(doc)
}

function explosion() {
  const doc = createEmptyVfxDoc({ name: 'Explosion' })
  doc.effect.duration = 2.4
  doc.effect.loop = true
  doc.effect.capacity = 4096
  doc.systems = [
    makeSystem({
      name: 'Fireball',
      capacity: 256,
      clips: [{ at: 0, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(60) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.35, 0.7) }),
        block('initialize.setSize', { size: randomValue(0.5, 1.1) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionSphere', { radius: constValue(0.35) }, { fill: 'volume' }),
        // The shape spreads them, then Velocity Outward turns that spread into
        // motion. This pair IS an explosion, and the order matters - outward
        // velocity reads the position, so it has to come after the shape.
        block('initialize.velocityRadial', { speed: randomValue(2.5, 6) }),
        block('initialize.setRotation', { rotation: randomValue(-180, 180) }),
      ],
      update: [
        block('update.drag', { drag: constValue(3.2) }),
        block('update.gravity', { gravity: constValue([0, 1.2, 0]) }),
        block('update.sizeOverLife', { scale: curve('easeOut', { scale: 2.2 }) }),
        block('update.colorOverLife', { color: ramp('fire') }),
      ],
      output: { mode: 'billboard', blend: 'additive', sort: 'none' },
    }),
    makeSystem({
      name: 'Debris',
      capacity: 512,
      clips: [{ at: 0.02, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(90) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.8, 1.8) }),
        block('initialize.setSize', { size: randomValue(0.02, 0.06) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionSphere', { radius: constValue(0.2) }, { fill: 'volume' }),
        block('initialize.velocityRadial', { speed: randomValue(5, 13) }),
      ],
      update: [
        block('update.gravity', { gravity: constValue([0, -12, 0]) }),
        block('update.drag', { drag: constValue(0.9) }),
        // The floor is what makes the debris land somewhere rather than fall
        // through the world.
        block('update.collidePlane', {
          height: constValue(0),
          bounce: constValue(0.35),
          friction: constValue(0.4),
        }),
        block('update.colorOverLife', { color: ramp('ember') }),
      ],
      output: { mode: 'stretched', blend: 'additive', sort: 'none' },
    }),
    makeSystem({
      name: 'Smoke',
      capacity: 768,
      clips: [{ at: 0.08, duration: 0.7, loop: false }],
      spawn: [block('spawn.rate', { rate: constValue(120) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(1.4, 2.2) }),
        block('initialize.setSize', { size: randomValue(0.5, 1) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionSphere', { radius: constValue(0.5) }, { fill: 'volume' }),
        block('initialize.velocityRadial', { speed: randomValue(1, 3) }),
        block('initialize.setRotation', { rotation: randomValue(-180, 180) }),
      ],
      update: [
        block('update.gravity', { gravity: constValue([0, 0.7, 0]) }),
        block('update.drag', { drag: constValue(1.6) }),
        block('update.turbulence', { strength: constValue(0.5), frequency: constValue(0.4) }),
        block('update.spin', { speed: randomValue(-40, 40) }),
        block('update.sizeOverLife', { scale: curve('rampUp', { scale: 2.6 }) }),
        block('update.colorOverLife', { color: ramp('smoke') }),
      ],
      output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
    }),
  ]
  return normalizeVfxDoc(doc)
}

function magic() {
  const doc = createEmptyVfxDoc({ name: 'Magic' })
  doc.effect.duration = 3
  doc.effect.loop = true
  doc.effect.capacity = 2048
  doc.systems = [makeSystem({
    name: 'Motes',
    capacity: 768,
    spawn: [block('spawn.rate', { rate: constValue(110) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(1.2, 2.4) }),
      block('initialize.setSize', { size: randomValue(0.04, 0.1) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      block('initialize.positionSphere', { radius: constValue(1.1) }, { fill: 'surface' }),
      block('initialize.velocityRandom', {
        min: constValue([-0.4, -0.4, -0.4]),
        max: constValue([0.4, 0.4, 0.4]),
      }),
    ],
    update: [
      // Drawn towards a point above the centre, which is what makes the motes
      // gather rather than drift - the reading an audience gets as "gathering
      // power".
      block('update.attractor', {
        position: constValue([0, 1, 0]),
        strength: constValue(3.2),
        radius: constValue(1.6),
      }),
      block('update.turbulence', { strength: constValue(0.8), frequency: constValue(1.1) }),
      block('update.speedLimit', { speed: constValue(2.6) }),
      block('update.sizeOverLife', { scale: curve('bell', { scale: 1.5 }) }),
      block('update.colorOverLife', { color: ramp('magic') }),
    ],
    output: { mode: 'billboard', blend: 'additive', sort: 'none' },
  })]
  return normalizeVfxDoc(doc)
}

function portal() {
  const doc = createEmptyVfxDoc({ name: 'Portal' })
  doc.effect.duration = 3
  doc.effect.loop = true
  doc.effect.capacity = 3072
  doc.systems = [
    makeSystem({
      name: 'Ring',
      capacity: 1024,
      spawn: [block('spawn.rate', { rate: constValue(200) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.8, 1.6) }),
        block('initialize.setSize', { size: randomValue(0.05, 0.12) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        // A thin ring is the whole silhouette of a portal, so the thickness is
        // small relative to the radius.
        block('initialize.positionCircle', {
          radius: constValue(1.2),
          thickness: constValue(0.14),
        }),
      ],
      update: [
        // The vortex is what makes a ring of particles read as a portal rather
        // than as a ring of particles: the swirl rotates them and the inward
        // pull keeps them on the ring.
        block('update.vortex', {
          position: constValue([0, 0, 0]),
          axis: constValue([0, 1, 0]),
          strength: constValue(2.6),
          inward: constValue(1.4),
        }),
        block('update.speedLimit', { speed: constValue(3.4) }),
        block('update.sizeOverLife', { scale: curve('bell', { scale: 1.3 }) }),
        block('update.colorOverLife', { color: ramp('magic') }),
      ],
      output: { mode: 'billboard', blend: 'additive', sort: 'none' },
    }),
    makeSystem({
      name: 'Core',
      capacity: 256,
      spawn: [block('spawn.rate', { rate: constValue(40) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.5, 1) }),
        block('initialize.setSize', { size: randomValue(0.6, 1.1) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionCircle', {
          radius: constValue(0.8),
          thickness: constValue(0.8),
        }),
        block('initialize.setRotation', { rotation: randomValue(-180, 180) }),
      ],
      update: [
        block('update.spin', { speed: randomValue(-60, 60) }),
        block('update.sizeOverLife', { scale: curve('bell', { scale: 1.2 }) }),
        block('update.colorOverLife', { color: ramp('electric') }),
      ],
      output: { mode: 'billboard', blend: 'additive', sort: 'none' },
    }),
  ]
  return normalizeVfxDoc(doc)
}

function rain() {
  const doc = createEmptyVfxDoc({ name: 'Rain' })
  doc.effect.duration = 2
  doc.effect.loop = true
  doc.effect.capacity = 4096
  doc.systems = [makeSystem({
    name: 'Rain',
    capacity: 2048,
    spawn: [block('spawn.rate', { rate: constValue(900) })],
    init: [
      // Long enough to fall the whole way and no longer. At 13 m/s a drop
      // crosses the 12m box in under a second, and Kill Outside Box collects it
      // at the floor - so the lifetime is a ceiling, never reached.
      //
      // It is 1.2s rather than a generous 3s because the capacity diagnostic
      // reasons about rate TIMES lifetime, and it cannot know about the kill
      // box: 900/s for 3s asks for 2700 particles against a 2048 capacity and
      // the template shipped with a warning. The warning was right about the
      // arithmetic; the lifetime was the thing that was wrong.
      block('initialize.setLifetime', { lifetime: constValue(1.2) }),
      block('initialize.setSize', { size: randomValue(0.012, 0.022) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      // A flat slab well above the ground: weather is a volume the camera sits
      // inside, not a source it looks at.
      block('initialize.positionBox', { size: constValue([14, 0.5, 14]) }),
      block('initialize.velocityDirection', {
        direction: constValue([0.12, -1, 0]),
        speed: randomValue(11, 15),
        spread: constValue(2),
      }),
    ],
    update: [
      block('update.gravity', { gravity: constValue([0, -6, 0]) }),
      block('update.killOnBounds', { size: constValue([30, 12, 30]) }),
      block('update.colorOverLife', { color: ramp('ice') }),
    ],
    // Stretched, because a raindrop at 13 m/s covers a fifth of a metre per
    // frame - drawn as a round dot it reads as hail.
    output: { mode: 'stretched', blend: 'alpha', sort: 'none' },
  })]
  // Above the origin, so the slab is overhead and the box catches them at the
  // floor.
  doc.effect.boundsMin = [-16, -7, -16]
  doc.effect.boundsMax = [16, 7, 16]
  return normalizeVfxDoc(doc)
}

function snow() {
  const doc = createEmptyVfxDoc({ name: 'Snow' })
  doc.effect.duration = 4
  doc.effect.loop = true
  doc.effect.capacity = 4096
  doc.systems = [makeSystem({
    name: 'Snow',
    capacity: 2048,
    spawn: [block('spawn.rate', { rate: constValue(320) })],
    init: [
      block('initialize.setLifetime', { lifetime: constValue(6) }),
      block('initialize.setSize', { size: randomValue(0.03, 0.07) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      block('initialize.positionBox', { size: constValue([14, 0.5, 14]) }),
      block('initialize.velocityDirection', {
        direction: constValue([0, -1, 0]),
        speed: randomValue(0.5, 0.9),
        spread: constValue(18),
      }),
      block('initialize.setRotation', { rotation: randomValue(-180, 180) }),
    ],
    update: [
      // Almost no gravity and a lot of drag: a snowflake reaches its terminal
      // velocity within a few centimetres, so it drifts rather than falls.
      block('update.gravity', { gravity: constValue([0, -0.4, 0]) }),
      block('update.drag', { drag: constValue(1.2) }),
      block('update.turbulence', { strength: constValue(0.45), frequency: constValue(0.3) }),
      block('update.spin', { speed: randomValue(-50, 50) }),
      block('update.killOnBounds', { size: constValue([30, 12, 30]) }),
    ],
    output: { mode: 'billboard', blend: 'alpha', sort: 'none' },
  })]
  doc.effect.boundsMin = [-16, -7, -16]
  doc.effect.boundsMax = [16, 7, 16]
  return normalizeVfxDoc(doc)
}

function dust() {
  const doc = createEmptyVfxDoc({ name: 'Dust Motes' })
  doc.effect.duration = 6
  doc.effect.loop = true
  doc.effect.capacity = 1024
  doc.systems = [makeSystem({
    name: 'Motes',
    capacity: 512,
    spawn: [block('spawn.rate', { rate: constValue(60) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(4, 7) }),
      block('initialize.setSize', { size: randomValue(0.008, 0.02) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      // A room-sized box the camera sits inside. Ambient dust is the cheapest
      // way to make an interior feel like it has air in it.
      block('initialize.positionBox', { size: constValue([6, 3, 6]) }),
      block('initialize.velocityRandom', {
        min: constValue([-0.05, -0.03, -0.05]),
        max: constValue([0.05, 0.03, 0.05]),
      }),
    ],
    update: [
      // Turbulence and nothing else: dust has no ballistic motion at all, it
      // just follows the air.
      block('update.turbulence', { strength: constValue(0.09), frequency: constValue(0.18) }),
      block('update.speedLimit', { speed: constValue(0.16) }),
      // Fade in and out, so a mote appearing is never a pop.
      block('update.sizeOverLife', { scale: curve('bell', { scale: 1 }) }),
    ],
    output: { mode: 'billboard', blend: 'additive', sort: 'none' },
  })]
  return normalizeVfxDoc(doc)
}

function blood() {
  const doc = createEmptyVfxDoc({ name: 'Blood Hit' })
  doc.effect.duration = 1.8
  doc.effect.loop = true
  doc.effect.capacity = 1024
  doc.systems = [
    makeSystem({
      name: 'Spray',
      capacity: 256,
      clips: [{ at: 0, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(70) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.6, 1.4) }),
        block('initialize.setSize', { size: randomValue(0.02, 0.07) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionSphere', { radius: constValue(0.08) }, { fill: 'volume' }),
        block('initialize.velocityDirection', {
          direction: constValue([0, 0.4, 1]),
          speed: randomValue(3, 7),
          spread: constValue(38),
        }),
      ],
      update: [
        block('update.gravity', { gravity: constValue([0, -14, 0]) }),
        block('update.drag', { drag: constValue(0.6) }),
        // Sticks rather than bounces: a low bounce and high friction is what
        // makes a droplet land and stay, which is what sells the floor.
        block('update.collidePlane', {
          height: constValue(0),
          bounce: constValue(0.05),
          friction: constValue(0.9),
        }),
        block('update.colorOverLife', { color: ramp('blood') }),
      ],
      // Alpha, not additive: blood absorbs light. Additive would make it glow,
      // which is the classic mistake this template exists to pre-empt.
      output: { mode: 'stretched', blend: 'alpha', sort: 'depth' },
    }),
    makeSystem({
      name: 'Mist',
      capacity: 128,
      clips: [{ at: 0, duration: 0.12, loop: false }],
      spawn: [block('spawn.rate', { rate: constValue(160) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.3, 0.6) }),
        block('initialize.setSize', { size: randomValue(0.12, 0.28) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionSphere', { radius: constValue(0.12) }, { fill: 'volume' }),
        block('initialize.velocityDirection', {
          direction: constValue([0, 0.2, 1]),
          speed: randomValue(0.8, 2),
          spread: constValue(50),
        }),
      ],
      update: [
        block('update.drag', { drag: constValue(3.4) }),
        block('update.sizeOverLife', { scale: curve('rampUp', { scale: 1.8 }) }),
        block('update.colorOverLife', { color: ramp('blood') }),
      ],
      output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
    }),
  ]
  return normalizeVfxDoc(doc)
}

function trail() {
  const doc = createEmptyVfxDoc({ name: 'Trail' })
  doc.effect.duration = 2
  doc.effect.loop = true
  doc.effect.capacity = 2048
  doc.systems = [
    makeSystem({
      name: 'Ribbon',
      capacity: 1024,
      // A dense stream of short-lived stretched billboards. NOT a true trail
      // renderer - see the note in this file's header - but at this rate the
      // quads overlap and read as a continuous ribbon.
      spawn: [block('spawn.rate', { rate: constValue(400) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.25, 0.45) }),
        block('initialize.setSize', { size: randomValue(0.05, 0.09) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionCircle', {
          radius: constValue(1),
          thickness: constValue(0.02),
        }),
        block('initialize.velocityDirection', {
          direction: constValue([0, 0.15, 0]),
          speed: randomValue(0.1, 0.3),
          spread: constValue(20),
        }),
      ],
      update: [
        // A gentle vortex sweeps the emission point around the ring, which is
        // what gives the ribbon its curve.
        block('update.vortex', {
          position: constValue([0, 0, 0]),
          axis: constValue([0, 1, 0]),
          strength: constValue(3.4),
          inward: constValue(0.4),
        }),
        block('update.drag', { drag: constValue(1.2) }),
        block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1 }) }),
        block('update.colorOverLife', { color: ramp('electric') }),
      ],
      output: { mode: 'stretched', blend: 'additive', sort: 'none' },
    }),
    makeSystem({
      name: 'Sparkle',
      capacity: 256,
      spawn: [block('spawn.rate', { rate: constValue(60) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.4, 0.9) }),
        block('initialize.setSize', { size: randomValue(0.02, 0.05) }),
        block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        block('initialize.positionCircle', {
          radius: constValue(1),
          thickness: constValue(0.1),
        }),
        block('initialize.velocityRandom', {
          min: constValue([-0.5, -0.2, -0.5]),
          max: constValue([0.5, 0.6, 0.5]),
        }),
      ],
      update: [
        block('update.drag', { drag: constValue(1.6) }),
        block('update.sizeOverLife', { scale: curve('bell', { scale: 1.2 }) }),
        block('update.colorOverLife', { color: ramp('magic') }),
      ],
      output: { mode: 'billboard', blend: 'additive', sort: 'none' },
    }),
  ]
  return normalizeVfxDoc(doc)
}

function firework() {
  const doc = createEmptyVfxDoc({ name: 'Firework' })
  doc.effect.duration = 3.2
  doc.effect.loop = true
  doc.effect.capacity = 4096

  // The shell, whose DEATH is the event everything else hangs off. Built first
  // so the systems below can name its id.
  const shell = makeSystem({
    name: 'Shell',
    capacity: 32,
    clips: [{ at: 0, duration: 0, loop: false }],
    spawn: [block('spawn.burst', { count: constValue(1) })],
    init: [
      // One second up, then it dies - and the death is the burst.
      block('initialize.setLifetime', { lifetime: constValue(1) }),
      block('initialize.setSize', { size: constValue(0.12) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      block('initialize.velocityDirection', {
        direction: constValue([0.1, 1, 0]),
        speed: constValue(9),
        spread: constValue(2),
      }),
    ],
    update: [
      block('update.gravity', { gravity: constValue([0, -4.5, 0]) }),
      block('update.drag', { drag: constValue(0.6) }),
      block('update.colorOverLife', { color: ramp('ember') }),
    ],
    output: { mode: 'stretched', blend: 'additive', sort: 'none' },
  })

  const stars = makeSystem({
    name: 'Stars',
    capacity: 512,
    // No clips of its own: a sub-emitter's timing IS the event. Its Spawn
    // burst count is how many stars each shell produces.
    spawn: [block('spawn.burst', { count: constValue(90) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(0.8, 1.6) }),
      block('initialize.setSize', { size: randomValue(0.03, 0.07) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      // NO POSITION BLOCK. The event has already placed the star where the
      // shell died, and a shape block here would overwrite that and put the
      // whole burst back at the origin - which is the single easiest way to
      // get a sub-emitter wrong.
      block('initialize.velocityRadial', { speed: randomValue(3, 6.5) }),
      // A little of the shell's momentum, so the burst drifts the way the
      // shell was travelling rather than expanding from a dead stop.
      block('initialize.inheritVelocity', { scale: constValue(0.35) }),
    ],
    update: [
      block('update.gravity', { gravity: constValue([0, -3.2, 0]) }),
      block('update.drag', { drag: constValue(1.1) }),
      block('update.colorOverLife', { color: ramp('rainbow') }),
    ],
    output: { mode: 'stretched', blend: 'additive', sort: 'none' },
  })
  stars.contexts = [
    {
      id: 'c-evt-stars',
      kind: CONTEXT_KIND.EVENT,
      blocks: [],
      params: { trigger: 'onDeath', source: shell.id, probability: '1' },
    },
    ...stars.contexts,
  ]

  const embers = makeSystem({
    name: 'Embers',
    capacity: 1024,
    spawn: [block('spawn.burst', { count: constValue(2) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(0.5, 1.2) }),
      block('initialize.setSize', { size: randomValue(0.015, 0.035) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      block('initialize.inheritVelocity', { scale: constValue(0.15) }),
    ],
    update: [
      block('update.gravity', { gravity: constValue([0, -2.2, 0]) }),
      block('update.drag', { drag: constValue(1.6) }),
      block('update.colorOverLife', { color: ramp('ember') }),
    ],
    output: { mode: 'billboard', blend: 'additive', sort: 'none' },
  })
  embers.contexts = [
    {
      id: 'c-evt-embers',
      kind: CONTEXT_KIND.EVENT,
      blocks: [],
      // A THIRD level, and the chance is what keeps the count sane: 90 stars
      // each making 2 embers is 180, and at 0.4 it is about 72. Without the
      // chance every level multiplies, which is exactly why the depth limit
      // exists.
      params: { trigger: 'onDeath', source: stars.id, probability: '0.5' },
    },
    ...embers.contexts,
  ]

  doc.systems = [shell, stars, embers]
  doc.effect.boundsMin = [-8, -1, -8]
  doc.effect.boundsMax = [8, 12, 8]
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
  {
    id: 'fire',
    name: 'Fire',
    category: 'Fire & Smoke',
    blurb: 'A flame anchored to a disc, rising and narrowing as it cools.',
    teaches: ['Upward gravity as buoyancy', 'Circle emitters', 'HDR colour over life', 'Random start rotation'],
    build: fire,
  },
  {
    id: 'explosion',
    name: 'Explosion',
    category: 'Impacts & Hits',
    blurb: 'Fireball, debris that lands on the floor, then a smoke column. Three staged systems.',
    teaches: ['Shape plus Velocity Outward', 'Floor collision', 'Staged timing', 'Block order matters'],
    build: explosion,
  },
  {
    id: 'magic',
    name: 'Magic Gather',
    category: 'Magic & Energy',
    blurb: 'Motes drawn in towards a point, held by a speed limit.',
    teaches: ['Point attractors', 'Speed limits as a safety net', 'Surface emission'],
    build: magic,
  },
  {
    id: 'portal',
    name: 'Portal',
    category: 'Magic & Energy',
    blurb: 'A swirling ring around a glowing core.',
    teaches: ['Vortex forces', 'Ring emitters', 'Two systems sharing one silhouette'],
    build: portal,
  },
  {
    id: 'rain',
    name: 'Rain',
    category: 'Weather',
    blurb: 'A falling slab of stretched drops, collected at the floor.',
    teaches: ['Box emitters as a volume', 'Directional velocity', 'Kill Outside Box instead of more capacity'],
    build: rain,
  },
  {
    id: 'snow',
    name: 'Snow',
    category: 'Weather',
    blurb: 'Slow drifting flakes that tumble as they fall.',
    teaches: ['Drag as terminal velocity', 'Spin', 'Turbulence for drift'],
    build: snow,
  },
  {
    id: 'dust',
    name: 'Dust Motes',
    category: 'Smoke & Dust',
    blurb: 'Ambient specks hanging in the air of a room.',
    teaches: ['Turbulence with no other force', 'Fading in and out with a hump curve', 'Long lifetimes at a low rate'],
    build: dust,
  },
  {
    id: 'blood',
    name: 'Blood Hit',
    category: 'Impacts & Hits',
    blurb: 'A directional spray that sticks where it lands, with a mist puff.',
    teaches: ['Alpha rather than additive for dark fluids', 'Sticky collision', 'Directional spread'],
    build: blood,
  },
  {
    id: 'firework',
    name: 'Firework',
    category: 'Magic & Energy',
    blurb: 'A shell that rises and bursts into stars, which themselves trail embers.',
    teaches: [
      'Sub-emitters: one system emitting where another\'s particles die',
      'Three levels deep, and why the chance setting matters',
      'Inheriting the parent\'s velocity',
      'Why a sub-emitter must NOT have a position block',
    ],
    build: firework,
  },
  {
    id: 'trail',
    name: 'Trail',
    category: 'Magic & Energy',
    blurb: 'A swept ribbon of stretched quads with sparkles. Not a true trail renderer - see the notes.',
    teaches: ['Dense stretched billboards as a ribbon', 'Vortex sweep', 'What a real trail renderer would add'],
    build: trail,
  },
])

/**
 * @param {string} id
 * @returns {Object|null}
 */
export function templateById(id) {
  return VFX_TEMPLATES.find(template => template.id === id) || null
}
