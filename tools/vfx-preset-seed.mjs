// The authored content of the VFX preset library.
//
// READ tools/seed-vfx-presets.mjs FIRST. This file is the SOURCE the library is
// seeded from, once. After that the JSON under resources/vfx/presets/ is
// authoritative and is what the app serves and the author edits - so changing a
// number here does nothing to an installed library, by design.
//
// Two kinds of entry:
//
//   - The twelve original templates, which appear as metadata only. Their
//     graphs come from src/utils/vfx/templates.js unchanged, because they were
//     built and verified in phase 8 and re-authoring them would risk losing
//     something for no gain. What they gain here is a category, a description
//     and tags - the things a browsable library needs and a hard-coded gallery
//     did not.
//   - Everything else, authored below in the same DSL.
//
// EVERY PRESET MUST COMPILE WITH ZERO ERRORS AND ZERO WARNINGS. The seeder
// enforces it. The rule from phase 8 stands: a starter effect that trips a
// diagnostic is a bug in the preset, because the person who opens it has no way
// to know they did not cause it.
//
// The traps that actually bite when authoring these, all learned by tripping
// them: additive blending with a dark colour ramp (W_ADDITIVE_DARK - a dark
// ramp adds almost nothing, so it reads as broken); spawn rate times lifetime
// exceeding capacity (W_CAPACITY); and a size or alpha that reaches zero for
// the whole life rather than at the end of it.
import { createEmptyVfxDoc, normalizeVfxDoc } from '../vfx/doc.js';
import { constValue, randomValue } from '../vfx/value.js';
import { block, makeSystem, curve, ramp } from '../src/utils/vfx/templates.js';

/**
 * Assemble a document from systems. Duration and capacity are stated per preset
 * rather than defaulted, because both are visible in the editor and a wrong one
 * teaches the wrong lesson.
 */
const effect = (name, options, systems) => {
  const doc = createEmptyVfxDoc({ name });
  doc.effect.duration = options.duration;
  doc.effect.loop = options.loop !== false;
  doc.effect.capacity = options.capacity;
  doc.systems = systems;
  return normalizeVfxDoc(doc);
};

// ── Recipes ────────────────────────────────────────────────────────────────
// Families that genuinely share a shape. Anything with a character of its own
// is written out in full below rather than squeezed through a parameter.

/**
 * Weather: a volume of particles above the viewer, falling and killed at the
 * edges of that volume.
 *
 * KILL OUTSIDE BOX RATHER THAN MORE CAPACITY is the lesson, and it is the one
 * that makes weather affordable: a drop that has fallen past the floor costs
 * exactly as much as one you can see until something removes it.
 */
const weather = ({
  name, rate, lifetime, size, box, velocity, spread, drag, ramp: rampId, mode, blend, capacity,
  turbulence, spin,
}) => makeSystem({
  name,
  capacity,
  spawn: [block('spawn.rate', { rate: constValue(rate) })],
  init: [
    block('initialize.setLifetime', { lifetime: constValue(lifetime) }),
    block('initialize.setSize', { size: randomValue(size[0], size[1]) }),
    block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    block('initialize.positionBox', { size: constValue(box), offset: constValue([0, box[1] / 2, 0]) }),
    block('initialize.velocityDirection', {
      direction: constValue(velocity),
      speed: randomValue(spread[0], spread[1]),
      spread: constValue(0.05),
    }),
  ],
  update: [
    ...(drag ? [block('update.drag', { drag: constValue(drag) })] : []),
    ...(turbulence
      ? [block('update.turbulence', {
        strength: constValue(turbulence[0]),
        frequency: constValue(turbulence[1]),
      })]
      : []),
    ...(spin ? [block('update.spin', { speed: randomValue(-spin, spin) })] : []),
    block('update.colorOverLife', { color: ramp(rampId) }),
    block('update.killOnBounds', { size: constValue(box) }),
  ],
  output: { mode, blend, sort: 'none' },
});

/**
 * A one-shot burst of glowing motes: pickups, level-ups, small magic hits.
 * Additive, bright, and gone in under a second.
 */
const sparkle = ({ name, count, lifetime, size, speed, rampId, capacity, gravity, mode }) => makeSystem({
  name,
  capacity,
  spawn: [block('spawn.burst', { count: constValue(count) })],
  init: [
    block('initialize.setLifetime', { lifetime: randomValue(lifetime[0], lifetime[1]) }),
    block('initialize.setSize', { size: randomValue(size[0], size[1]) }),
    block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    block('initialize.positionSphere', { radius: constValue(0.12) }, { fill: 'volume' }),
    block('initialize.velocityRadial', { speed: randomValue(speed[0], speed[1]) }),
  ],
  update: [
    ...(gravity ? [block('update.gravity', { gravity: constValue([0, gravity, 0]) })] : []),
    block('update.drag', { drag: constValue(2.2) }),
    block('update.sizeOverLife', { scale: curve('rampDown') }),
    block('update.colorOverLife', { color: ramp(rampId) }),
  ],
  output: { mode: mode || 'billboard', blend: 'additive', sort: 'none' },
});

/**
 * A rising column of soft alpha-blended puffs: smoke, steam, ash, dust.
 *
 * DEPTH SORTED, because alpha blending is order dependent - two puffs drawn in
 * the wrong order show a hard edge where one should be behind the other.
 */
const plume = ({
  name, rate, lifetime, size, radius, rise, rampId, capacity, turbulence, grow,
}) => makeSystem({
  name,
  capacity,
  spawn: [block('spawn.rate', { rate: constValue(rate) })],
  init: [
    block('initialize.setLifetime', { lifetime: randomValue(lifetime[0], lifetime[1]) }),
    block('initialize.setSize', { size: randomValue(size[0], size[1]) }),
    block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    block('initialize.positionCircle', { radius: constValue(radius), thickness: constValue(1) }),
    block('initialize.velocityDirection', {
      direction: constValue([0, 1, 0]),
      speed: randomValue(rise[0], rise[1]),
      spread: constValue(0.18),
    }),
    block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
  ],
  update: [
    block('update.turbulence', {
      strength: constValue(turbulence?.[0] ?? 0.5),
      frequency: constValue(turbulence?.[1] ?? 0.4),
    }),
    block('update.drag', { drag: constValue(0.7) }),
    block('update.sizeOverLife', { scale: curve('rampUp', { scale: grow ?? 2.4 }) }),
    block('update.colorOverLife', { color: ramp(rampId) }),
  ],
  output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
});

// ── The asset pack ─────────────────────────────────────────────────────────
//
// Which sprite (or chip) each preset draws with, as a TABLE rather than as
// edits inside fifty-three builders. Applied by `attachPackAssets` below, which
// goes through the same mutator the editor's own asset picker uses - so a
// seeded preset is shaped exactly like one an author wired by hand.
//
// The slot is registered with an EMPTY ref and the FILE is declared in the
// preset's `assets` list. That is the whole install-independence trick: the
// stored preset names a file in a directory the app owns, and opening it
// installs that file here and rewrites the slot to whatever id it got. See the
// header of vfx/preset.js.
//
// A `mesh` entry also switches that Output to the mesh renderer, because a
// rock chip drawn as a billboard is a grey square.
export const PRESET_PACK = {
  // Fire and smoke: the wisp for flame, the puff for anything that billows.
  fire: [{ system: 'Flame', file: 'flame-wisp.png' }],
  torch: [{ system: 'Flame', file: 'flame-wisp.png' }],
  campfire: [
    { system: 'Flame', file: 'flame-wisp.png' },
    { system: 'Embers', file: 'soft-glow.png' },
    { system: 'Smoke', file: 'smoke-puff.png' },
  ],
  smoke: [{ system: 'Smoke', file: 'smoke-puff.png' }],
  'black-smoke': [{ system: 'Smoke', file: 'smoke-puff.png' }],
  'steam-vent': [{ system: 'Steam', file: 'smoke-puff.png' }],
  'ember-drift': [{ system: 'Embers', file: 'soft-glow.png' }],

  // Impacts: streaks for sparks, the flare for the pop, the puff for dust.
  sparks: [{ system: 'Sparks', file: 'spark-streak.png' }],
  ricochet: [
    { system: 'Flash', file: 'hard-flare.png' },
    { system: 'Sparks', file: 'spark-streak.png' },
  ],
  'metal-grind': [{ system: 'Sparks', file: 'spark-streak.png' }],
  'hit-flash': [
    { system: 'Flash', file: 'hard-flare.png' },
    { system: 'Streaks', file: 'spark-streak.png' },
  ],
  'impact-dust': [{ system: 'Dust', file: 'smoke-puff.png' }],
  blood: [{ system: 'Spray', file: 'soft-glow.png' }],

  // Explosions.
  explosion: [{ system: 'Fireball', file: 'smoke-puff.png' }],
  grenade: [
    { system: 'Fireball', file: 'smoke-puff.png' },
    { system: 'Fragments', file: 'stone-shard.glb', mesh: true },
    { system: 'Smoke', file: 'smoke-puff.png' },
  ],
  shockwave: [{ system: 'Ring', file: 'ring.png' }],
  'debris-burst': [{ system: 'Debris', file: 'rock-chip.glb', mesh: true }],
  firework: [{ system: 'Shell', file: 'soft-glow.png' }],

  // Magic and energy.
  magic: [{ system: 'Motes', file: 'star-four.png' }],
  portal: [{ system: 'Ring', file: 'soft-glow.png' }],
  'heal-aura': [{ system: 'Motes', file: 'star-four.png' }],
  'arcane-shield': [{ system: 'Shell', file: 'soft-glow.png' }],
  'soul-wisps': [{ system: 'Wisps', file: 'flame-wisp.png' }],
  'energy-burst': [
    { system: 'Core', file: 'soft-glow.png' },
    { system: 'Streaks', file: 'spark-streak.png' },
  ],
  'lightning-motes': [{ system: 'Motes', file: 'spark-streak.png' }],
  'magic-bolt': [
    { system: 'Bolt', file: 'spark-streak.png' },
    { system: 'Motes', file: 'soft-glow.png' },
  ],

  // Weather.
  rain: [{ system: 'Rain', file: 'spark-streak.png' }],
  'heavy-rain': [{ system: 'Rain', file: 'spark-streak.png' }],
  snow: [{ system: 'Snow', file: 'soft-glow.png' }],
  blizzard: [{ system: 'Snow', file: 'soft-glow.png' }],
  'falling-leaves': [{ system: 'Leaves', file: 'shard.png' }],

  // Environment.
  dust: [{ system: 'Motes', file: 'dust-mote.png' }],
  pollen: [{ system: 'Pollen', file: 'dust-mote.png' }],
  fireflies: [{ system: 'Flies', file: 'soft-glow.png' }],
  'ash-fall': [{ system: 'Ash', file: 'dust-mote.png' }],
  'waterfall-mist': [{ system: 'Mist', file: 'smoke-puff.png' }],

  // Liquids.
  'water-splash': [{ system: 'Droplets', file: 'spark-streak.png' }],
  fountain: [{ system: 'Water', file: 'spark-streak.png' }],
  'lava-bubbles': [{ system: 'Bubbles', file: 'soft-glow.png' }],

  // Sci-fi.
  thruster: [{ system: 'Plume', file: 'soft-glow.png' }],
  'warp-streaks': [{ system: 'Streaks', file: 'spark-streak.png' }],
  'hologram-motes': [{ system: 'Motes', file: 'star-four.png' }],
  'electric-arc': [{ system: 'Arc', file: 'spark-streak.png' }],

  // Trails.
  trail: [{ system: 'Ribbon', file: 'spark-streak.png' }],
  'rocket-trail': [
    { system: 'Flame', file: 'flame-wisp.png' },
    { system: 'Smoke', file: 'smoke-puff.png' },
  ],
  comet: [
    { system: 'Head', file: 'soft-glow.png' },
    { system: 'Tail', file: 'spark-streak.png' },
  ],
  'arrow-streak': [{ system: 'Streak', file: 'spark-streak.png' }],

  // Organic.
  'spore-cloud': [{ system: 'Spores', file: 'smoke-puff.png' }],
  'fly-swarm': [{ system: 'Flies', file: 'dust-mote.png' }],

  // Interface.
  'pickup-sparkle': [{ system: 'Sparkle', file: 'star-four.png' }],
  'level-up': [
    { system: 'Column', file: 'spark-streak.png' },
    { system: 'Ring', file: 'ring.png' },
  ],
  confetti: [{ system: 'Confetti', file: 'plank.glb', mesh: true }],
  'coin-shower': [{ system: 'Coins', file: 'coin.glb', mesh: true }],
};

// ── The library ────────────────────────────────────────────────────────────

// The magic bolt's arc, shared by its two systems so the beads ride exactly
// the path the bolt occupies. A path is any length now, so this is a plain
// array rather than four properties - and sharing it is the point: authoring
// the same curve twice is how the two systems drift apart.
const BOLT_PATH = [
  [-1.4, 0, 0],
  [-0.5, 1, 0.3],
  [0.5, 1, -0.3],
  [1.4, 0, 0],
];

export const PRESET_SEED = {
  // ---- The twelve originals: metadata only, graphs untouched ---------------
  sparks: {
    category: 'Impacts & Hits',
    tags: ['one-shot', 'beginner', 'additive', 'stretched'],
  },
  smoke: {
    category: 'Fire & Smoke',
    tags: ['looping', 'beginner', 'alpha', 'turbulence'],
  },
  muzzleFlash: {
    // Renamed on the way in: preset ids are lowercase-with-dashes because they
    // are filenames and URL segments, and the template's camelCase is neither.
    id: 'muzzle-flash',
    category: 'Impacts & Hits',
    tags: ['one-shot', 'intermediate', 'staged', 'additive', 'alpha'],
  },
  fire: {
    category: 'Fire & Smoke',
    tags: ['looping', 'beginner', 'additive'],
  },
  explosion: {
    category: 'Explosions',
    tags: ['one-shot', 'advanced', 'staged', 'collision', 'additive', 'alpha'],
  },
  magic: {
    category: 'Magic & Energy',
    tags: ['looping', 'intermediate', 'attractor', 'additive'],
  },
  portal: {
    category: 'Magic & Energy',
    tags: ['looping', 'intermediate', 'vortex', 'additive'],
  },
  rain: {
    category: 'Weather',
    tags: ['looping', 'beginner', 'stretched', 'alpha'],
  },
  snow: {
    category: 'Weather',
    tags: ['looping', 'beginner', 'alpha', 'turbulence'],
  },
  dust: {
    category: 'Environment',
    tags: ['looping', 'beginner', 'alpha', 'turbulence'],
  },
  blood: {
    category: 'Impacts & Hits',
    tags: ['one-shot', 'intermediate', 'collision', 'alpha'],
  },
  firework: {
    category: 'Explosions',
    tags: ['one-shot', 'advanced', 'sub-emitter', 'additive'],
  },
  trail: {
    category: 'Trails & Projectiles',
    tags: ['looping', 'intermediate', 'stretched', 'vortex', 'additive'],
  },

  // ---- Fire & Smoke --------------------------------------------------------
  campfire: {
    name: 'Campfire',
    category: 'Fire & Smoke',
    description: 'A low flame over logs, with embers lifting off it and a thin smoke thread.',
    teaches: ['Three systems reading as one object', 'Buoyancy as upward gravity', 'Embers as a second, sparser system'],
    tags: ['looping', 'intermediate', 'additive', 'alpha'],
    build: () => effect('Campfire', { duration: 4, capacity: 3072 }, [
      makeSystem({
        name: 'Flame',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(90) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.5, 0.9) }),
          block('initialize.setSize', { size: randomValue(0.18, 0.3) }),
          block('initialize.setColor', { color: constValue([1.6, 0.9, 0.35, 1]) }),
          block('initialize.positionCircle', { radius: constValue(0.22), thickness: constValue(1) }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, 2.2, 0]) }),
          block('update.turbulence', { strength: constValue(1.1), frequency: constValue(1.4) }),
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.2 }) }),
          block('update.colorOverLife', { color: ramp('fire') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Embers',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(14) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.2, 2.4) }),
          block('initialize.setSize', { size: randomValue(0.015, 0.035) }),
          block('initialize.setColor', { color: constValue([2, 0.8, 0.2, 1]) }),
          block('initialize.positionCircle', { radius: constValue(0.25), thickness: constValue(1) }),
          block('initialize.velocityRandom', { min: constValue([-0.4, 1.2, -0.4]), max: constValue([0.4, 2.4, 0.4]) }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(0.9), frequency: constValue(0.8) }),
          block('update.drag', { drag: constValue(0.5) }),
          block('update.colorOverLife', { color: ramp('ember') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      plume({
        name: 'Smoke', rate: 18, lifetime: [1.8, 3], size: [0.25, 0.45],
        radius: 0.18, rise: [0.8, 1.4], rampId: 'smoke', capacity: 128, grow: 2.8,
      }),
    ]),
  },

  torch: {
    name: 'Torch',
    category: 'Fire & Smoke',
    description: 'A small handheld flame that leans and flickers. Cheap enough to put on every wall.',
    teaches: ['A whole effect in one system', 'Turbulence as flicker', 'Keeping a looping effect under 200 particles'],
    tags: ['looping', 'beginner', 'additive'],
    build: () => effect('Torch', { duration: 2, capacity: 512 }, [
      makeSystem({
        name: 'Flame',
        capacity: 192,
        spawn: [block('spawn.rate', { rate: constValue(70) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.35, 0.6) }),
          block('initialize.setSize', { size: randomValue(0.1, 0.16) }),
          block('initialize.setColor', { color: constValue([1.8, 1, 0.4, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.05) }, { fill: 'volume' }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, 3.2, 0]) }),
          block('update.turbulence', { strength: constValue(1.6), frequency: constValue(2.2) }),
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.1 }) }),
          block('update.colorOverLife', { color: ramp('fire') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'steam-vent': {
    name: 'Steam Vent',
    category: 'Fire & Smoke',
    description: 'A pressurised jet of white steam that spreads and thins as it slows.',
    teaches: ['A narrow cone as a jet', 'Drag turning a jet into a cloud', 'Alpha blending on a light effect'],
    tags: ['looping', 'beginner', 'alpha'],
    build: () => effect('Steam Vent', { duration: 3, capacity: 1024 }, [
      makeSystem({
        name: 'Steam',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(120) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.9, 1.6) }),
          block('initialize.setSize', { size: randomValue(0.12, 0.22) }),
          block('initialize.setColor', { color: constValue([1, 1, 1, 0.5]) }),
          block('initialize.positionCone', {
            angle: constValue(12), radius: constValue(0.06), speed: randomValue(4, 6),
          }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.drag', { drag: constValue(2.4) }),
          block('update.turbulence', { strength: constValue(0.7), frequency: constValue(0.9) }),
          block('update.sizeOverLife', { scale: curve('rampUp', { scale: 3 }) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
      }),
    ]),
  },

  'ember-drift': {
    name: 'Ember Drift',
    category: 'Fire & Smoke',
    description: 'Slow orange embers rising through the air long after the fire has gone.',
    teaches: ['Long lifetimes at a low rate', 'Turbulence as the only force', 'Ambient effects cost almost nothing'],
    tags: ['looping', 'beginner', 'additive', 'turbulence'],
    build: () => effect('Ember Drift', { duration: 6, capacity: 512 }, [
      makeSystem({
        name: 'Embers',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(24) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(3, 5.5) }),
          block('initialize.setSize', { size: randomValue(0.012, 0.03) }),
          block('initialize.setColor', { color: constValue([2.2, 0.9, 0.25, 1]) }),
          block('initialize.positionBox', { size: constValue([4, 0.4, 4]) }),
          block('initialize.velocityRandom', { min: constValue([-0.2, 0.3, -0.2]), max: constValue([0.2, 0.9, 0.2]) }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(0.5), frequency: constValue(0.35) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'black-smoke': {
    name: 'Black Smoke',
    category: 'Fire & Smoke',
    description: 'The heavy oily column that comes off burning fuel. Slower and darker than ordinary smoke.',
    teaches: ['Why dark smoke must be alpha and never additive', 'Depth sorting', 'Size over life as billowing'],
    tags: ['looping', 'intermediate', 'alpha', 'turbulence'],
    build: () => effect('Black Smoke', { duration: 6, capacity: 1024 }, [
      plume({
        name: 'Smoke', rate: 40, lifetime: [3, 5], size: [0.5, 0.9],
        radius: 0.35, rise: [1.2, 2], rampId: 'smoke', capacity: 512,
        turbulence: [0.8, 0.35], grow: 3.2,
      }),
    ]),
  },

  // ---- Impacts & Hits ------------------------------------------------------
  'impact-dust': {
    name: 'Impact Dust',
    category: 'Impacts & Hits',
    description: 'The ring of dust kicked outward where something heavy lands.',
    teaches: ['Outward velocity from a flat circle', 'Drag stopping a ring in place', 'One-shot timing'],
    tags: ['one-shot', 'beginner', 'alpha'],
    build: () => effect('Impact Dust', { duration: 1.6, loop: false, capacity: 512 }, [
      makeSystem({
        name: 'Dust',
        capacity: 256,
        spawn: [block('spawn.burst', { count: constValue(60) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.6, 1.2) }),
          block('initialize.setSize', { size: randomValue(0.15, 0.3) }),
          block('initialize.setColor', { color: constValue([1, 0.95, 0.85, 0.6]) }),
          block('initialize.positionCircle', { radius: constValue(0.3), thickness: constValue(0.4) }),
          block('initialize.velocityRadial', { speed: randomValue(1.6, 3.2) }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.drag', { drag: constValue(3.2) }),
          block('update.gravity', { gravity: constValue([0, 0.4, 0]) }),
          block('update.sizeOverLife', { scale: curve('rampUp', { scale: 2.2 }) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
      }),
    ]),
  },

  ricochet: {
    name: 'Ricochet',
    category: 'Impacts & Hits',
    description: 'A tight cone of sparks thrown back off a hard surface, with one bright flash.',
    teaches: ['Cones as directional impacts', 'A flash system that lives for two frames', 'Stretched billboards follow velocity'],
    tags: ['one-shot', 'intermediate', 'additive', 'stretched'],
    build: () => effect('Ricochet', { duration: 1, loop: false, capacity: 512 }, [
      makeSystem({
        name: 'Flash',
        capacity: 8,
        spawn: [block('spawn.burst', { count: constValue(1) })],
        init: [
          block('initialize.setLifetime', { lifetime: constValue(0.07) }),
          block('initialize.setSize', { size: constValue(0.55) }),
          block('initialize.setColor', { color: constValue([3, 2.4, 1.4, 1]) }),
          block('initialize.positionPoint', {}),
        ],
        update: [block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1 }) })],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Sparks',
        capacity: 256,
        spawn: [block('spawn.burst', { count: constValue(45) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.2, 0.55) }),
          block('initialize.setSize', { size: randomValue(0.015, 0.035) }),
          block('initialize.setColor', { color: constValue([2, 1.2, 0.5, 1]) }),
          block('initialize.positionCone', {
            angle: constValue(38), radius: constValue(0.02), speed: randomValue(3.5, 7),
          }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
          block('update.drag', { drag: constValue(1.2) }),
          block('update.colorOverLife', { color: ramp('ember') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'metal-grind': {
    name: 'Metal Grind',
    category: 'Impacts & Hits',
    description: 'A continuous shower of sparks off a grinding wheel or a dragged blade.',
    teaches: ['A looping hit rather than a one-shot', 'Floor collision with low bounce', 'Rate emission from a point'],
    tags: ['looping', 'intermediate', 'additive', 'stretched', 'collision'],
    build: () => effect('Metal Grind', { duration: 2, capacity: 1024 }, [
      makeSystem({
        name: 'Sparks',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(220) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.35, 0.8) }),
          block('initialize.setSize', { size: randomValue(0.012, 0.028) }),
          block('initialize.setColor', { color: constValue([2.4, 1.6, 0.7, 1]) }),
          block('initialize.positionPoint', { offset: constValue([0, 0.6, 0]), jitter: constValue(0.03) }),
          block('initialize.positionCone', {
            angle: constValue(25), radius: constValue(0.01), speed: randomValue(4, 8),
            rotation: constValue([0, 0, -60]),
          }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.25), friction: constValue(0.4) }),
          block('update.colorOverLife', { color: ramp('ember') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'hit-flash': {
    name: 'Hit Flash',
    category: 'Impacts & Hits',
    description: 'The single bright pop that sells a hit. Two systems, forty particles, one frame of impact.',
    teaches: ['How short a flash should be', 'A radial streak burst', 'Reading HDR colour above 1'],
    tags: ['one-shot', 'beginner', 'additive'],
    build: () => effect('Hit Flash', { duration: 0.8, loop: false, capacity: 256 }, [
      makeSystem({
        name: 'Flash',
        capacity: 8,
        spawn: [block('spawn.burst', { count: constValue(1) })],
        init: [
          block('initialize.setLifetime', { lifetime: constValue(0.12) }),
          block('initialize.setSize', { size: constValue(0.9) }),
          block('initialize.setColor', { color: constValue([3, 2.6, 2, 1]) }),
          block('initialize.positionPoint', {}),
        ],
        update: [block('update.sizeOverLife', { scale: curve('spike', { scale: 1.4 }) })],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      sparkle({
        name: 'Streaks', count: 26, lifetime: [0.14, 0.3], size: [0.03, 0.06],
        speed: [5, 9], rampId: 'fadeOut', capacity: 64, mode: 'stretched',
      }),
    ]),
  },

  // ---- Explosions ----------------------------------------------------------
  grenade: {
    name: 'Grenade',
    category: 'Explosions',
    description: 'A compact blast: flash, a dirty smoke ball and fragments that skitter along the floor.',
    teaches: ['Staged clips on three tracks', 'Fragments that survive the fireball', 'Bounce and friction on a floor plane'],
    tags: ['one-shot', 'advanced', 'staged', 'collision', 'additive', 'alpha'],
    build: () => effect('Grenade', { duration: 3, loop: false, capacity: 4096 }, [
      makeSystem({
        name: 'Fireball',
        capacity: 256,
        clips: [{ id: 'clip-gren-1', at: 0, duration: 0, loop: false }],
        spawn: [block('spawn.burst', { count: constValue(70) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.25, 0.55) }),
          block('initialize.setSize', { size: randomValue(0.4, 0.8) }),
          block('initialize.setColor', { color: constValue([2.4, 1.3, 0.5, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.25) }, { fill: 'volume' }),
          block('initialize.velocityRadial', { speed: randomValue(2, 5) }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.drag', { drag: constValue(4) }),
          block('update.sizeOverLife', { scale: curve('rampUp', { scale: 1.8 }) }),
          block('update.colorOverLife', { color: ramp('fire') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Fragments',
        capacity: 256,
        clips: [{ id: 'clip-gren-2', at: 0, duration: 0, loop: false }],
        spawn: [block('spawn.burst', { count: constValue(90) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1, 2.2) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.05) }),
          block('initialize.setColor', { color: constValue([0.5, 0.45, 0.42, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.15) }, { fill: 'volume' }),
          block('initialize.velocityRadial', { speed: randomValue(5, 12) }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -12, 0]) }),
          block('update.drag', { drag: constValue(0.4) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.35), friction: constValue(0.55) }),
          block('update.spin', { speed: randomValue(-14, 14) }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'none' },
      }),
      makeSystem({
        name: 'Smoke',
        capacity: 512,
        clips: [{ id: 'clip-gren-3', at: 0.1, duration: 1.2, loop: false }],
        spawn: [block('spawn.rate', { rate: constValue(90) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.4, 2.6) }),
          block('initialize.setSize', { size: randomValue(0.4, 0.75) }),
          block('initialize.setColor', { color: constValue([1, 1, 1, 0.75]) }),
          block('initialize.positionSphere', { radius: constValue(0.4) }, { fill: 'volume' }),
          block('initialize.velocityRadial', { speed: randomValue(0.6, 2) }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.drag', { drag: constValue(1.6) }),
          block('update.gravity', { gravity: constValue([0, 0.7, 0]) }),
          block('update.turbulence', { strength: constValue(0.6), frequency: constValue(0.4) }),
          block('update.sizeOverLife', { scale: curve('rampUp', { scale: 2.6 }) }),
          block('update.colorOverLife', { color: ramp('smoke') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
      }),
    ]),
  },

  shockwave: {
    name: 'Shockwave',
    category: 'Explosions',
    description: 'A flat ring of compressed air racing outward along the ground.',
    teaches: ['A thin circle emitter as a ring', 'Outward velocity in one plane', 'How a hard stop reads as a wave front'],
    tags: ['one-shot', 'beginner', 'additive'],
    build: () => effect('Shockwave', { duration: 1.4, loop: false, capacity: 512 }, [
      makeSystem({
        name: 'Ring',
        capacity: 256,
        spawn: [block('spawn.burst', { count: constValue(120) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.4, 0.6) }),
          block('initialize.setSize', { size: randomValue(0.12, 0.2) }),
          block('initialize.setColor', { color: constValue([1.6, 1.7, 2, 1]) }),
          block('initialize.positionCircle', { radius: constValue(0.35), thickness: constValue(0.05) }),
          block('initialize.velocityRadial', { speed: randomValue(7, 9) }),
        ],
        update: [
          block('update.drag', { drag: constValue(5.5) }),
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.6 }) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'debris-burst': {
    name: 'Debris Burst',
    category: 'Explosions',
    description: 'Chunks of masonry thrown out and left lying on the floor where they stop.',
    teaches: ['Friction high enough that debris settles', 'Spin on tumbling fragments', 'Long lifetimes so the result persists'],
    tags: ['one-shot', 'intermediate', 'collision', 'alpha'],
    build: () => effect('Debris Burst', { duration: 4, loop: false, capacity: 1024 }, [
      makeSystem({
        name: 'Debris',
        capacity: 512,
        spawn: [block('spawn.burst', { count: constValue(140) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(2.5, 3.8) }),
          block('initialize.setSize', { size: randomValue(0.03, 0.09) }),
          block('initialize.setColor', { color: constValue([0.62, 0.58, 0.54, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.3) }, { fill: 'volume' }),
          block('initialize.velocityRandom', { min: constValue([-6, 2, -6]), max: constValue([6, 9, 6]) }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -14, 0]) }),
          block('update.spin', { speed: randomValue(-10, 10) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.28), friction: constValue(0.75) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'none' },
      }),
    ]),
  },

  // ---- Magic & Energy ------------------------------------------------------
  'heal-aura': {
    name: 'Heal Aura',
    category: 'Magic & Energy',
    description: 'Soft green motes rising around a character, the standard restore-health cue.',
    teaches: ['Rising motes from a ring', 'Fade in and out with one curve', 'Why healing effects read best in green'],
    tags: ['looping', 'beginner', 'additive'],
    build: () => effect('Heal Aura', { duration: 3, capacity: 1024 }, [
      makeSystem({
        name: 'Motes',
        capacity: 384,
        spawn: [block('spawn.rate', { rate: constValue(110) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.2, 2) }),
          block('initialize.setSize', { size: randomValue(0.04, 0.09) }),
          block('initialize.setColor', { color: constValue([0.5, 2.2, 0.9, 1]) }),
          block('initialize.positionCircle', { radius: constValue(0.5), thickness: constValue(0.35) }),
          block('initialize.velocityRandom', { min: constValue([-0.15, 0.8, -0.15]), max: constValue([0.15, 1.8, 0.15]) }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(0.35), frequency: constValue(0.9) }),
          block('update.sizeOverLife', { scale: curve('bell', { scale: 1.3 }) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'arcane-shield': {
    name: 'Arcane Shield',
    category: 'Magic & Energy',
    description: 'A hollow sphere of light around the caster, held in place by an inward pull.',
    teaches: ['Surface fill for a hollow shell', 'Sphere collision from the inside', 'An attractor that holds rather than pulls'],
    tags: ['looping', 'advanced', 'additive', 'attractor', 'collision'],
    build: () => effect('Arcane Shield', { duration: 4, capacity: 1024 }, [
      makeSystem({
        name: 'Shell',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(160) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.6, 2.6) }),
          block('initialize.setSize', { size: randomValue(0.05, 0.1) }),
          block('initialize.setColor', { color: constValue([0.9, 1.2, 2.4, 1]) }),
          block('initialize.positionSphere', { radius: constValue(1) }, { fill: 'surface' }),
          block('initialize.velocityRandom', { min: constValue([-0.3, -0.3, -0.3]), max: constValue([0.3, 0.3, 0.3]) }),
        ],
        update: [
          block('update.vortex', {
            position: constValue([0, 0, 0]), axis: constValue([0, 1, 0]),
            strength: constValue(1.6), inward: constValue(0),
          }),
          block('update.collideSphere', {
            position: constValue([0, 0, 0]), radius: constValue(1),
            bounce: constValue(0.6), friction: constValue(0.1),
          }, { side: 'inside' }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'soul-wisps': {
    name: 'Soul Wisps',
    category: 'Magic & Energy',
    description: 'Pale wisps circling slowly upward, for spirits, necromancy and haunted places.',
    teaches: ['A slow vortex as an orbit', 'Speed limits keeping an orbit stable', 'Long lifetimes with few particles'],
    tags: ['looping', 'intermediate', 'additive', 'vortex'],
    build: () => effect('Soul Wisps', { duration: 6, capacity: 512 }, [
      makeSystem({
        name: 'Wisps',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(30) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(4, 6) }),
          block('initialize.setSize', { size: randomValue(0.06, 0.14) }),
          block('initialize.setColor', { color: constValue([0.7, 1.6, 1.5, 1]) }),
          block('initialize.positionCircle', { radius: constValue(1.1), thickness: constValue(0.5) }),
          block('initialize.velocityRandom', { min: constValue([-0.1, 0.2, -0.1]), max: constValue([0.1, 0.5, 0.1]) }),
        ],
        update: [
          block('update.vortex', {
            position: constValue([0, 0, 0]), axis: constValue([0, 1, 0]),
            strength: constValue(2.2), inward: constValue(0.35),
          }),
          block('update.speedLimit', { speed: constValue(1.6) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'energy-burst': {
    name: 'Energy Burst',
    category: 'Magic & Energy',
    description: 'A violet detonation of light with streaks flung out of it.',
    teaches: ['Two systems from one burst', 'Stretched streaks against round cores', 'HDR violet through the tonemapper'],
    tags: ['one-shot', 'beginner', 'additive'],
    build: () => effect('Energy Burst', { duration: 1.5, loop: false, capacity: 1024 }, [
      sparkle({
        name: 'Core', count: 50, lifetime: [0.3, 0.6], size: [0.12, 0.28],
        speed: [1.5, 3.5], rampId: 'magic', capacity: 256,
      }),
      sparkle({
        name: 'Streaks', count: 60, lifetime: [0.25, 0.5], size: [0.03, 0.07],
        speed: [6, 11], rampId: 'magic', capacity: 256, mode: 'stretched',
      }),
    ]),
  },

  'magic-bolt': {
    name: 'Magic Bolt',
    category: 'Magic & Energy',
    description: 'A bolt of energy arcing along a curved path, with motes running the length of it.',
    teaches: [
      'The Curve emitter: four points that the path passes through',
      'Tangent speed, which makes particles flow along a path rather than sit on it',
      'Spacing measured in metres of arc, so an even stream stays even through a bend',
    ],
    tags: ['looping', 'intermediate', 'additive', 'stretched'],
    build: () => effect('Magic Bolt', { duration: 2, capacity: 1024 }, [
      makeSystem({
        name: 'Bolt',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(320) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.3, 0.55) }),
          block('initialize.setSize', { size: randomValue(0.03, 0.07) }),
          block('initialize.setColor', { color: constValue([1.2, 1.4, 2.6, 1]) }),
          // The points are ON the curve, so this is a bolt that leaves low,
          // arcs up over the middle and comes down again.
          block('initialize.positionCurve', {
            thickness: constValue(0.05),
            // Along the path, which is what turns a curved scattering into
            // something that reads as travelling.
            tangentSpeed: constValue(2.5),
          }, { placement: 'random' }, BOLT_PATH),
        ],
        update: [
          block('update.turbulence', { strength: constValue(1.4), frequency: constValue(2.6) }),
          block('update.drag', { drag: constValue(1.2) }),
          block('update.colorOverLife', { color: ramp('electric') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Motes',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(60) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.6, 1.1) }),
          block('initialize.setSize', { size: randomValue(0.05, 0.11) }),
          block('initialize.setColor', { color: constValue([1.6, 1.8, 3, 1]) }),
          // Evenly spaced along the same path: a row of beads travelling it.
          block('initialize.positionCurve', {
            spacing: constValue(0.35),
            tangentSpeed: constValue(1.2),
          }, { placement: 'spacing' }, BOLT_PATH),
        ],
        update: [
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.2 }) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'lightning-motes': {
    name: 'Lightning Motes',
    category: 'Magic & Energy',
    description: 'Crackling blue-white specks jittering around a charged object.',
    teaches: ['High-frequency turbulence as electrical jitter', 'Very short lifetimes at a high rate', 'The electric ramp'],
    tags: ['looping', 'intermediate', 'additive', 'turbulence'],
    build: () => effect('Lightning Motes', { duration: 2, capacity: 1024 }, [
      makeSystem({
        name: 'Motes',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(300) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.12, 0.3) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.05) }),
          block('initialize.setColor', { color: constValue([1.4, 1.8, 2.8, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.55) }, { fill: 'surface' }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(9), frequency: constValue(5.5) }),
          block('update.colorOverLife', { color: ramp('electric') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  // ---- Weather -------------------------------------------------------------
  'heavy-rain': {
    name: 'Heavy Rain',
    category: 'Weather',
    description: 'A dense downpour with long stretched drops. The storm version of Rain.',
    teaches: ['What rate a storm actually needs', 'Stretched billboards at speed', 'Bounding the volume instead of the count'],
    tags: ['looping', 'intermediate', 'stretched', 'alpha'],
    build: () => effect('Heavy Rain', { duration: 3, capacity: 4096 }, [
      weather({
        name: 'Rain', rate: 900, lifetime: 1.5, size: [0.012, 0.022],
        box: [10, 9, 10], velocity: [0, -1, 0], spread: [12, 16],
        ramp: 'fadeOut', mode: 'stretched', blend: 'alpha', capacity: 2048,
      }),
    ]),
  },

  blizzard: {
    name: 'Blizzard',
    category: 'Weather',
    description: 'Snow driven sideways by wind, thick enough to lose the horizon in.',
    teaches: ['A slanted direction as wind', 'Turbulence on top of a direction', 'Reading density from the alive counter'],
    tags: ['looping', 'intermediate', 'alpha', 'turbulence'],
    build: () => effect('Blizzard', { duration: 4, capacity: 4096 }, [
      weather({
        name: 'Snow', rate: 700, lifetime: 3.2, size: [0.03, 0.07],
        box: [12, 8, 12], velocity: [-0.7, -1, 0.2], spread: [3.5, 5],
        ramp: 'fadeInOut', mode: 'billboard', blend: 'alpha', capacity: 2560,
        drag: 0.6, turbulence: [1.4, 0.5], spin: 3,
      }),
    ]),
  },

  'falling-leaves': {
    name: 'Falling Leaves',
    category: 'Weather',
    description: 'Autumn leaves tumbling down through still air, spinning as they go.',
    teaches: ['Spin plus drag reading as air resistance', 'Slow weather at a low rate', 'Warm colour without additive'],
    tags: ['looping', 'beginner', 'alpha'],
    build: () => effect('Falling Leaves', { duration: 6, capacity: 1024 }, [
      weather({
        name: 'Leaves', rate: 45, lifetime: 5.5, size: [0.07, 0.14],
        box: [8, 6, 8], velocity: [0.15, -1, 0.1], spread: [0.8, 1.3],
        ramp: 'fadeInOut', mode: 'billboard', blend: 'alpha', capacity: 512,
        drag: 1.1, turbulence: [0.8, 0.35], spin: 5,
      }),
    ]),
  },

  // ---- Environment ---------------------------------------------------------
  fireflies: {
    name: 'Fireflies',
    category: 'Environment',
    description: 'Warm points of light blinking on and off across a clearing at dusk.',
    teaches: ['Fade in and out as blinking', 'Very low rates for ambience', 'Wandering with turbulence alone'],
    tags: ['looping', 'beginner', 'additive', 'turbulence'],
    build: () => effect('Fireflies', { duration: 8, capacity: 512 }, [
      makeSystem({
        name: 'Flies',
        capacity: 192,
        spawn: [block('spawn.rate', { rate: constValue(26) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(4, 7) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.045) }),
          block('initialize.setColor', { color: constValue([2.4, 2, 0.6, 1]) }),
          block('initialize.positionBox', { size: constValue([8, 2.5, 8]), offset: constValue([0, 1.2, 0]) }),
          block('initialize.velocityRandom', { min: constValue([-0.3, -0.2, -0.3]), max: constValue([0.3, 0.2, 0.3]) }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(0.6), frequency: constValue(0.5) }),
          block('update.drag', { drag: constValue(0.9) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  pollen: {
    name: 'Pollen',
    category: 'Environment',
    description: 'Fine bright specks drifting through a shaft of sunlight.',
    teaches: ['Ambient detail at almost no cost', 'Drift without gravity', 'Small sizes still read when they are bright'],
    tags: ['looping', 'beginner', 'additive', 'turbulence'],
    build: () => effect('Pollen', { duration: 8, capacity: 512 }, [
      makeSystem({
        name: 'Pollen',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(35) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(5, 7) }),
          block('initialize.setSize', { size: randomValue(0.008, 0.018) }),
          block('initialize.setColor', { color: constValue([1.8, 1.7, 1.2, 1]) }),
          block('initialize.positionBox', { size: constValue([5, 4, 5]), offset: constValue([0, 2, 0]) }),
          block('initialize.velocityRandom', { min: constValue([-0.12, -0.1, -0.12]), max: constValue([0.12, 0.14, 0.12]) }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(0.28), frequency: constValue(0.25) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'ash-fall': {
    name: 'Ash Fall',
    category: 'Environment',
    description: 'Grey flakes settling out of the sky after something burned.',
    teaches: ['Weather that is not water', 'Terminal velocity through drag', 'Muted colour on an alpha effect'],
    tags: ['looping', 'beginner', 'alpha'],
    build: () => effect('Ash Fall', { duration: 6, capacity: 2048 }, [
      weather({
        name: 'Ash', rate: 220, lifetime: 4.5, size: [0.02, 0.05],
        box: [10, 7, 10], velocity: [0.1, -1, 0.05], spread: [0.9, 1.5],
        ramp: 'smoke', mode: 'billboard', blend: 'alpha', capacity: 1280,
        drag: 1.4, turbulence: [0.6, 0.3], spin: 2,
      }),
    ]),
  },

  'waterfall-mist': {
    name: 'Waterfall Mist',
    category: 'Environment',
    description: 'The cloud of spray that hangs at the foot of falling water.',
    teaches: ['A wide low emitter', 'Upward drift against gravity', 'Mist as very soft alpha'],
    tags: ['looping', 'intermediate', 'alpha', 'turbulence'],
    build: () => effect('Waterfall Mist', { duration: 5, capacity: 1024 }, [
      plume({
        name: 'Mist', rate: 90, lifetime: [1.6, 3], size: [0.3, 0.6],
        radius: 1.2, rise: [0.5, 1.2], rampId: 'fadeInOut', capacity: 512,
        turbulence: [0.9, 0.3], grow: 2.6,
      }),
    ]),
  },

  // ---- Liquids -------------------------------------------------------------
  'water-splash': {
    name: 'Water Splash',
    category: 'Liquids',
    description: 'A crown of droplets thrown up where something enters water, falling back down.',
    teaches: ['A cone burst plus gravity as a splash', 'Collision returning droplets to the surface', 'Stretched drops in flight'],
    tags: ['one-shot', 'intermediate', 'collision', 'alpha', 'stretched'],
    build: () => effect('Water Splash', { duration: 2, loop: false, capacity: 1024 }, [
      makeSystem({
        name: 'Droplets',
        capacity: 512,
        spawn: [block('spawn.burst', { count: constValue(110) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.7, 1.4) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.055) }),
          block('initialize.setColor', { color: constValue([0.75, 0.9, 1, 0.85]) }),
          block('initialize.positionCircle', { radius: constValue(0.25), thickness: constValue(0.6) }),
          block('initialize.positionCone', {
            angle: constValue(35), radius: constValue(0.2), speed: randomValue(3, 6),
          }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -11, 0]) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.2), friction: constValue(0.6) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'stretched', blend: 'alpha', sort: 'none' },
      }),
    ]),
  },

  fountain: {
    name: 'Fountain',
    category: 'Liquids',
    description: 'A continuous jet of water arcing up and falling back into its basin.',
    teaches: ['Rate emission through a cone', 'A parabola from gravity alone', 'Collision as the basin surface'],
    tags: ['looping', 'beginner', 'collision', 'alpha'],
    build: () => effect('Fountain', { duration: 4, capacity: 2048 }, [
      makeSystem({
        name: 'Water',
        capacity: 1024,
        spawn: [block('spawn.rate', { rate: constValue(320) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.4, 2.2) }),
          block('initialize.setSize', { size: randomValue(0.025, 0.06) }),
          block('initialize.setColor', { color: constValue([0.8, 0.92, 1, 0.9]) }),
          block('initialize.positionCone', {
            angle: constValue(14), radius: constValue(0.08), speed: randomValue(5.5, 7),
          }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.15), friction: constValue(0.7) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'stretched', blend: 'alpha', sort: 'none' },
      }),
    ]),
  },

  'lava-bubbles': {
    name: 'Lava Bubbles',
    category: 'Liquids',
    description: 'Slow molten blisters swelling and bursting on the surface of a lava pool.',
    teaches: ['Very slow rise as viscosity', 'Size over life as swelling', 'Additive orange over a dark surface'],
    tags: ['looping', 'beginner', 'additive'],
    build: () => effect('Lava Bubbles', { duration: 5, capacity: 512 }, [
      makeSystem({
        name: 'Bubbles',
        capacity: 192,
        spawn: [block('spawn.rate', { rate: constValue(18) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.6, 3) }),
          block('initialize.setSize', { size: randomValue(0.1, 0.24) }),
          block('initialize.setColor', { color: constValue([2.4, 0.8, 0.15, 1]) }),
          block('initialize.positionCircle', { radius: constValue(1.4), thickness: constValue(1) }),
          block('initialize.velocityRandom', { min: constValue([-0.05, 0.1, -0.05]), max: constValue([0.05, 0.3, 0.05]) }),
        ],
        update: [
          block('update.sizeOverLife', { scale: curve('bell', { scale: 1.8 }) }),
          block('update.colorOverLife', { color: ramp('fire') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  // ---- Sci-Fi & Tech -------------------------------------------------------
  thruster: {
    name: 'Thruster',
    category: 'Sci-Fi & Tech',
    description: 'The blue-white plume out of an engine bell, hottest at the throat.',
    teaches: ['A cone pointed backwards', 'Colour cooling along the plume', 'Short lifetimes keeping a plume tight'],
    tags: ['looping', 'beginner', 'additive'],
    build: () => effect('Thruster', { duration: 2, capacity: 1024 }, [
      makeSystem({
        name: 'Plume',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(400) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.18, 0.4) }),
          block('initialize.setSize', { size: randomValue(0.07, 0.16) }),
          block('initialize.setColor', { color: constValue([1.4, 1.9, 3, 1]) }),
          block('initialize.positionCone', {
            angle: constValue(9), radius: constValue(0.1), speed: randomValue(7, 10),
            rotation: constValue([180, 0, 0]),
          }),
        ],
        update: [
          block('update.drag', { drag: constValue(2.2) }),
          block('update.sizeOverLife', { scale: curve('rampUp', { scale: 1.9 }) }),
          block('update.colorOverLife', { color: ramp('electric') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'warp-streaks': {
    name: 'Warp Streaks',
    category: 'Sci-Fi & Tech',
    description: 'Stars smeared into lines rushing past the camera at speed.',
    teaches: ['Stretched billboards as motion blur', 'A box volume around the viewer', 'Killing on bounds to recycle'],
    tags: ['looping', 'intermediate', 'stretched', 'additive'],
    build: () => effect('Warp Streaks', { duration: 3, capacity: 2048 }, [
      weather({
        name: 'Streaks', rate: 420, lifetime: 1.2, size: [0.02, 0.05],
        box: [8, 8, 16], velocity: [0, 0, 1], spread: [22, 30],
        ramp: 'fadeInOut', mode: 'stretched', blend: 'additive', capacity: 1024,
      }),
    ]),
  },

  'hologram-motes': {
    name: 'Hologram Motes',
    category: 'Sci-Fi & Tech',
    description: 'Cyan specks scanning up a projected volume, for holograms and materialisation.',
    teaches: ['A box emitter as a projection volume', 'Upward drift as a scan', 'Cool colour with no gravity'],
    tags: ['looping', 'beginner', 'additive'],
    build: () => effect('Hologram Motes', { duration: 3, capacity: 1024 }, [
      makeSystem({
        name: 'Motes',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(200) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1, 2) }),
          block('initialize.setSize', { size: randomValue(0.015, 0.04) }),
          block('initialize.setColor', { color: constValue([0.6, 2, 2.4, 1]) }),
          block('initialize.positionBox', { size: constValue([1.2, 2, 1.2]), offset: constValue([0, 1, 0]) }),
          block('initialize.velocityDirection', {
            direction: constValue([0, 1, 0]), speed: randomValue(0.4, 1), spread: constValue(0.1),
          }),
        ],
        update: [
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'electric-arc': {
    name: 'Electric Arc',
    category: 'Sci-Fi & Tech',
    description: 'Current jumping along a line between two terminals.',
    teaches: ['The Line emitter and even placement', 'Turbulence as arc wander', 'Short lives making a path look alive'],
    tags: ['looping', 'intermediate', 'additive', 'turbulence'],
    build: () => effect('Electric Arc', { duration: 2, capacity: 1024 }, [
      makeSystem({
        name: 'Arc',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(420) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.08, 0.2) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.05) }),
          block('initialize.setColor', { color: constValue([1.6, 2, 3, 1]) }),
          block('initialize.positionLine', {
            start: constValue([-1.2, 0.4, 0]), end: constValue([1.2, 0.4, 0]),
            thickness: constValue(0.06),
          }, { placement: 'random' }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(7), frequency: constValue(3.5) }),
          block('update.colorOverLife', { color: ramp('electric') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  // ---- Trails & Projectiles ------------------------------------------------
  'rocket-trail': {
    name: 'Rocket Trail',
    category: 'Trails & Projectiles',
    description: 'Fire at the nozzle fading back into a smoke tail behind a missile.',
    teaches: ['Two systems making one tail', 'Fire in front of smoke', 'Why the smoke must outlive the flame'],
    tags: ['looping', 'intermediate', 'additive', 'alpha'],
    build: () => effect('Rocket Trail', { duration: 3, capacity: 2048 }, [
      makeSystem({
        name: 'Flame',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(220) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.15, 0.3) }),
          block('initialize.setSize', { size: randomValue(0.08, 0.16) }),
          block('initialize.setColor', { color: constValue([2.2, 1.1, 0.4, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.05) }, { fill: 'volume' }),
        ],
        update: [
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.2 }) }),
          block('update.colorOverLife', { color: ramp('fire') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Smoke',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(140) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.4, 2.4) }),
          block('initialize.setSize', { size: randomValue(0.1, 0.22) }),
          block('initialize.setColor', { color: constValue([1, 1, 1, 0.6]) }),
          block('initialize.positionSphere', { radius: constValue(0.07) }, { fill: 'volume' }),
          block('initialize.setRotation', { rotation: randomValue(-3.14, 3.14) }),
        ],
        update: [
          block('update.turbulence', { strength: constValue(0.5), frequency: constValue(0.5) }),
          block('update.sizeOverLife', { scale: curve('rampUp', { scale: 3 }) }),
          block('update.colorOverLife', { color: ramp('smoke') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
      }),
    ]),
  },

  comet: {
    name: 'Comet',
    category: 'Trails & Projectiles',
    description: 'A bright head dragging a cold tail of sparks behind it.',
    teaches: ['A dense core with a sparse tail', 'Drag spreading a tail out', 'Two ramps on one silhouette'],
    tags: ['looping', 'beginner', 'additive', 'stretched'],
    build: () => effect('Comet', { duration: 3, capacity: 1024 }, [
      makeSystem({
        name: 'Head',
        capacity: 128,
        spawn: [block('spawn.rate', { rate: constValue(160) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.2, 0.35) }),
          block('initialize.setSize', { size: randomValue(0.12, 0.2) }),
          block('initialize.setColor', { color: constValue([1.6, 2, 2.6, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.06) }, { fill: 'volume' }),
        ],
        update: [
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.1 }) }),
          block('update.colorOverLife', { color: ramp('ice') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Tail',
        capacity: 512,
        spawn: [block('spawn.rate', { rate: constValue(260) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.6, 1.4) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.05) }),
          block('initialize.setColor', { color: constValue([1.2, 1.6, 2.4, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.1) }, { fill: 'volume' }),
          block('initialize.velocityRandom', { min: constValue([-0.6, -0.6, -0.6]), max: constValue([0.6, 0.6, 0.6]) }),
        ],
        update: [
          block('update.drag', { drag: constValue(1.1) }),
          block('update.colorOverLife', { color: ramp('ice') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  'arrow-streak': {
    name: 'Arrow Streak',
    category: 'Trails & Projectiles',
    description: 'A thin fading ribbon behind a fast arrow or a thrown blade.',
    teaches: ['The cheapest possible trail', 'A single system with no forces', 'How lifetime sets a trail’s length'],
    tags: ['looping', 'beginner', 'additive', 'stretched'],
    build: () => effect('Arrow Streak', { duration: 2, capacity: 512 }, [
      makeSystem({
        name: 'Streak',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(300) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.15, 0.35) }),
          block('initialize.setSize', { size: randomValue(0.02, 0.045) }),
          block('initialize.setColor', { color: constValue([1.6, 1.5, 1.2, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.03) }, { fill: 'volume' }),
        ],
        update: [
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1 }) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  // ---- Creatures & Organic -------------------------------------------------
  'spore-cloud': {
    name: 'Spore Cloud',
    category: 'Creatures & Organic',
    description: 'A slow green haze of spores hanging where something burst open.',
    teaches: ['The toxic ramp', 'Near-zero gravity as suspension', 'Wide soft particles at a low count'],
    tags: ['looping', 'beginner', 'alpha', 'turbulence'],
    build: () => effect('Spore Cloud', { duration: 5, capacity: 1024 }, [
      plume({
        name: 'Spores', rate: 55, lifetime: [2.5, 4], size: [0.2, 0.4],
        radius: 0.6, rise: [0.1, 0.4], rampId: 'toxic', capacity: 384,
        turbulence: [0.7, 0.3], grow: 2,
      }),
    ]),
  },

  'fly-swarm': {
    name: 'Fly Swarm',
    category: 'Creatures & Organic',
    description: 'A knot of insects circling a fixed point, never quite settling.',
    teaches: ['An attractor as a leash', 'Turbulence fighting the attractor', 'A speed limit stopping orbital runaway'],
    tags: ['looping', 'advanced', 'attractor', 'alpha', 'turbulence'],
    build: () => effect('Fly Swarm', { duration: 5, capacity: 512 }, [
      makeSystem({
        name: 'Flies',
        capacity: 256,
        spawn: [block('spawn.rate', { rate: constValue(50) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(3, 5) }),
          block('initialize.setSize', { size: randomValue(0.015, 0.03) }),
          block('initialize.setColor', { color: constValue([0.15, 0.14, 0.12, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.6) }, { fill: 'volume' }),
          block('initialize.velocityRandom', { min: constValue([-1, -1, -1]), max: constValue([1, 1, 1]) }),
        ],
        update: [
          block('update.attractor', {
            position: constValue([0, 1, 0]), strength: constValue(6), radius: constValue(2.5),
          }),
          block('update.turbulence', { strength: constValue(4), frequency: constValue(2.4) }),
          block('update.speedLimit', { speed: constValue(2.2) }),
          block('update.colorOverLife', { color: ramp('fadeInOut') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'none' },
      }),
    ]),
  },

  // ---- UI & Feedback -------------------------------------------------------
  'pickup-sparkle': {
    name: 'Pickup Sparkle',
    category: 'UI & Feedback',
    description: 'The little gold twinkle that says an item was collected.',
    teaches: ['How brief a feedback effect should be', 'A burst with no forces', 'Size over life doing all the work'],
    tags: ['one-shot', 'beginner', 'additive'],
    build: () => effect('Pickup Sparkle', { duration: 1, loop: false, capacity: 256 }, [
      sparkle({
        name: 'Sparkle', count: 24, lifetime: [0.3, 0.6], size: [0.04, 0.1],
        speed: [1, 2.4], rampId: 'ember', capacity: 64, gravity: 1.2,
      }),
    ]),
  },

  'level-up': {
    name: 'Level Up',
    category: 'UI & Feedback',
    description: 'A column of light rushing upward past the character, with a ring at the base.',
    teaches: ['Two systems as one celebration', 'Upward velocity from a ring', 'Staged clips for a short sequence'],
    tags: ['one-shot', 'intermediate', 'staged', 'additive'],
    build: () => effect('Level Up', { duration: 2, loop: false, capacity: 1024 }, [
      makeSystem({
        name: 'Column',
        capacity: 512,
        clips: [{ id: 'clip-lvl-1', at: 0, duration: 0.9, loop: false }],
        spawn: [block('spawn.rate', { rate: constValue(300) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.5, 1) }),
          block('initialize.setSize', { size: randomValue(0.05, 0.12) }),
          block('initialize.setColor', { color: constValue([2.2, 1.9, 0.9, 1]) }),
          block('initialize.positionCircle', { radius: constValue(0.5), thickness: constValue(0.3) }),
          block('initialize.velocityDirection', {
            direction: constValue([0, 1, 0]), speed: randomValue(3, 5.5), spread: constValue(0.06),
          }),
        ],
        update: [
          block('update.drag', { drag: constValue(0.8) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'stretched', blend: 'additive', sort: 'none' },
      }),
      makeSystem({
        name: 'Ring',
        capacity: 256,
        clips: [{ id: 'clip-lvl-2', at: 0, duration: 0, loop: false }],
        spawn: [block('spawn.burst', { count: constValue(80) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(0.4, 0.7) }),
          block('initialize.setSize', { size: randomValue(0.08, 0.16) }),
          block('initialize.setColor', { color: constValue([2.4, 2, 1, 1]) }),
          block('initialize.positionCircle', { radius: constValue(0.4), thickness: constValue(0.1) }),
          block('initialize.velocityRadial', { speed: randomValue(2.5, 4) }),
        ],
        update: [
          block('update.drag', { drag: constValue(4) }),
          block('update.sizeOverLife', { scale: curve('rampDown', { scale: 1.3 }) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'billboard', blend: 'additive', sort: 'none' },
      }),
    ]),
  },

  confetti: {
    name: 'Confetti',
    category: 'UI & Feedback',
    description: 'Paper squares fired upward that tumble down and land on the floor.',
    teaches: ['Spin as tumbling paper', 'Alpha blending for opaque flat pieces', 'Collision so the celebration settles'],
    tags: ['one-shot', 'intermediate', 'collision', 'alpha'],
    build: () => effect('Confetti', { duration: 4, loop: false, capacity: 1024 }, [
      makeSystem({
        name: 'Confetti',
        capacity: 512,
        spawn: [block('spawn.burst', { count: constValue(180) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(2.5, 3.8) }),
          block('initialize.setSize', { size: randomValue(0.04, 0.09) }),
          block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.2) }, { fill: 'volume' }),
          block('initialize.velocityRandom', { min: constValue([-3, 5, -3]), max: constValue([3, 9, 3]) }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -7, 0]) }),
          block('update.drag', { drag: constValue(1.3) }),
          block('update.spin', { speed: randomValue(-12, 12) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.1), friction: constValue(0.85) }),
          block('update.colorOverLife', { color: ramp('rainbow') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'none' },
      }),
    ]),
  },

  'coin-shower': {
    name: 'Coin Shower',
    category: 'UI & Feedback',
    description: 'Gold coins spraying up and clattering down, for loot and rewards.',
    teaches: ['Heavy gravity reading as weight', 'Bounce and friction tuned to settle fast', 'Warm colour without additive'],
    tags: ['one-shot', 'beginner', 'collision', 'alpha'],
    build: () => effect('Coin Shower', { duration: 3, loop: false, capacity: 512 }, [
      makeSystem({
        name: 'Coins',
        capacity: 256,
        spawn: [block('spawn.burst', { count: constValue(70) })],
        init: [
          block('initialize.setLifetime', { lifetime: randomValue(1.8, 2.8) }),
          block('initialize.setSize', { size: randomValue(0.05, 0.09) }),
          block('initialize.setColor', { color: constValue([1.5, 1.15, 0.35, 1]) }),
          block('initialize.positionSphere', { radius: constValue(0.15) }, { fill: 'volume' }),
          block('initialize.velocityRandom', { min: constValue([-2.5, 4, -2.5]), max: constValue([2.5, 7.5, 2.5]) }),
        ],
        update: [
          block('update.gravity', { gravity: constValue([0, -16, 0]) }),
          block('update.spin', { speed: randomValue(-18, 18) }),
          block('update.collidePlane', { height: constValue(0), bounce: constValue(0.4), friction: constValue(0.6) }),
          block('update.colorOverLife', { color: ramp('fadeOut') }),
        ],
        output: { mode: 'billboard', blend: 'alpha', sort: 'none' },
      }),
    ]),
  },
};
