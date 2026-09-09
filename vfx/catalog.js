// The block and operator catalog: what an author can put in a stack, what
// properties each thing has, and how every one of them maps onto Unity VFX
// Graph and Unreal Niagara.
//
// This file is the product. The runtime is replaceable and the UI is
// replaceable, but the catalog is the vocabulary an effect is written in, and
// changing it after effects exist in the wild is the expensive kind of change.
//
// FOUR RULES, all of which exist because of a specific failure.
//
// 1. THE CATALOG IS THE INTERSECTION OF WHAT WE, UNITY AND NIAGARA CAN ALL DO.
//    A block that only the preview can express means either the importer lies
//    about it or the effect breaks on the way into the engine. So every entry
//    carries `engines: { unity, unreal }` with one of 'native' | 'approx' |
//    'none', and catalog.test.mjs FAILS if any entry omits them. Author-time
//    warnings, not import-time surprises.
//
// 2. THE UI IS GENERIC OVER THIS DATA. The palette, the block row, the
//    parameters panel, the mode switches and the badges all read these
//    definitions. Adding a block is a catalog entry plus a kernel - never a
//    React change. That is what makes "is it easy to add a new node type?" a
//    yes, and it is why `label`, `blurb`, `teach`, `hint` and `presets` are
//    part of the data rather than strings hard-coded in a component.
//
// 3. EVERY BLOCK EXPLAINS ITSELF IN PLAIN LANGUAGE. The audience is a game
//    developer who has never authored a particle effect. `blurb` is what the
//    palette shows; `teach` is the sentence that stops them making the mistake
//    this block invites. "Add Gravity" needs no explanation; "Set Lifetime"
//    absolutely does, because everything measured "over life" is measured
//    against it.
//
// 4. `modes` ARE NOT PROPERTIES. A mode picks a code path - a shape, a blend,
//    a space - so the compiler branches on it at compile time and the
//    importers map it straight onto an engine enum. Putting it in `props`
//    would force the compiler to unwrap a VfxValue just to discover which
//    kernel to emit, and would let an author wire a curve into something that
//    cannot vary.

import { CONTEXT_KIND } from './doc.js';
import { VALUE_DOMAIN } from './value.js';

/**
 * Which side of the integrator an Update block runs on.
 *
 * ALMOST EVERYTHING IS `BEFORE`: a force accumulates into the acceleration and
 * integration turns that into motion, so a force has to run first.
 *
 * `AFTER` exists because two kinds of block are meaningless before it, and the
 * closed-form runtime checks caught both:
 *
 *   - a COLLISION needs the position integration produced. Run before, it
 *     corrects a penetration that has not happened yet, integration then moves
 *     the particle through the floor, and with a low bounce it never climbs
 *     back out - it settles exactly g*dt^2 BELOW the plane, jittering, which
 *     reads as the collision being broken rather than as inelastic.
 *   - a SPEED CLAMP run before integration clamps last frame's velocity and
 *     then integration adds this frame's acceleration on top, so the cap is
 *     applied and immediately exceeded. Every particle was over the limit.
 *
 * This is not an author-facing choice. It is a fact about what the block does,
 * so the catalog states it and the compiler places the block accordingly.
 */
export const BLOCK_STAGE = Object.freeze({
  BEFORE: 'beforeIntegrate',
  AFTER: 'afterIntegrate',
});

/** How faithfully a block survives the trip into an engine. */
export const ENGINE_SUPPORT = Object.freeze({
  /** A direct equivalent exists; parameters map one to one. */
  NATIVE: 'native',
  /** Something close exists, with different semantics worth warning about. */
  APPROX: 'approx',
  /** No equivalent. The importer will drop it and say so. */
  NONE: 'none',
});

/**
 * What can make a system emit, beyond its own timeline clips.
 *
 * A REGISTRY, NOT AN ENUM, and that is the whole point of the extensibility
 * claim in this file's header. Each entry declares its `payload` - the
 * attributes the event carries from the particle that raised it - and that
 * declaration is what lets a child system inherit exactly the right fields
 * without anything special-casing the trigger. Adding "on leaving a volume" is
 * an entry here plus a push at the point the volume test already runs.
 *
 * WHY THE SOURCE IS A SYSTEM AND NOT A BLOCK. An event is raised by a
 * PARTICLE - it dies, it hits something - and particles belong to systems. Both
 * engines model it the same way: Unity's GPU Events hang off an output context,
 * Niagara's Event Handlers name a source emitter.
 */
export const EVENT_TRIGGERS = Object.freeze({
  onPlay: {
    id: 'onPlay',
    label: 'the effect plays',
    source: 'effect',
    payload: [],
    blurb: 'Emits on the effect\'s own timeline, which is the default.',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  onDeath: {
    id: 'onDeath',
    label: 'a particle dies',
    source: 'system',
    // Position and velocity are what a death event is FOR: a spark that
    // becomes a puff of smoke has to appear where the spark was, moving the
    // way it was moving. The seed travels too, so the child's randoms are
    // reproducible from the parent's identity rather than from a counter.
    payload: ['position', 'velocity', 'seed'],
    blurb: 'Emits wherever a particle of another system ends its life.',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: GPU Event (Trigger On Die). Niagara: Death Event Handler.',
    },
  },
  onCollide: {
    id: 'onCollide',
    label: 'a particle hits something',
    source: 'system',
    payload: ['position', 'velocity', 'seed'],
    blurb: 'Emits at the point where a particle of another system collides.',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: GPU Event on a Collide block. Niagara: Collision Event Handler.',
    },
  },
});

/** Property value types a block property can declare. */
export const PROP_TYPE = Object.freeze({
  FLOAT: 'float',
  INT: 'int',
  BOOL: 'bool',
  VEC3: 'vec3',
  COLOR: 'color',
  TEXTURE: 'texture',
  MESH: 'mesh',
});

// How many numeric channels each property type occupies in the pool and in the
// instanced buffer. Asset slots are strings, not numbers, hence 0.
const TYPE_CHANNELS = Object.freeze({
  [PROP_TYPE.FLOAT]: 1,
  [PROP_TYPE.INT]: 1,
  [PROP_TYPE.BOOL]: 1,
  [PROP_TYPE.VEC3]: 3,
  [PROP_TYPE.COLOR]: 4,
  [PROP_TYPE.TEXTURE]: 0,
  [PROP_TYPE.MESH]: 0,
});

/**
 * Channel width of a property type.
 * @param {string} type
 * @returns {number}
 */
export function propChannels(type) {
  return TYPE_CHANNELS[type] ?? 1;
}

// Shorthand for the value modes a property offers in the inspector. Spelled
// out per property rather than derived from the type, because the right answer
// is about meaning, not arithmetic: a spawn RATE may be a curve over effect
// time but must never be a curve over particle life (a rate is not a
// per-particle quantity), and a texture slot has no numeric modes at all.
const M = Object.freeze({
  SCALAR: ['const', 'random', 'curve'],
  SCALAR_FIXED: ['const', 'random'],
  VECTOR: ['const', 'random'],
  COLOR: ['const', 'random', 'gradient'],
  ASSET: ['const'],
  FLAG: ['const'],
});

/**
 * @typedef {Object} VfxPropDef
 * @property {string} type one of PROP_TYPE
 * @property {*} default
 * @property {string} label
 * @property {string} [unit]
 * @property {number} [min] soft lower bound for the inspector and for derived
 *   random ranges - not a hard clamp on what the author may type
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} modes value modes offered
 * @property {string} [domain] which axis a curve on this property runs along -
 *   a VALUE_DOMAIN. Defaults to LIFE (particle age). NOT the author's choice:
 *   it is a fact about what the property means, so it is declared here and
 *   setValueMode applies it. A spawn rate is a property of the emitter and has
 *   no particle whose age could be read, so it declares TIME.
 * @property {boolean} [basic] shown when the panel is not in Advanced mode
 * @property {boolean} [hot] shown inline on the node's block row
 * @property {string} [hint] per-property help, inline for basic properties
 * @property {Array<{label: string, value: *}>} [presets]
 */

/**
 * @typedef {Object} VfxBlockDef
 * @property {string} id catalog key, also the block's `type` in a document
 * @property {string} label
 * @property {string[]} contexts which context kinds accept it
 * @property {string} category grouping in the palette
 * @property {boolean} beginner offered at the 'guided' disclosure level
 * @property {string} blurb one line, always visible in the palette
 * @property {string} teach the sentence that prevents this block's classic
 *   mistake; shown in the hover card
 * @property {Object<string, VfxPropDef>} props
 * @property {Object<string, {options: string[], default: string, label: string,
 *   hint?: string}>} [modes]
 * @property {string} kernel the IR kernel this lowers to
 * @property {string} [stage] a BLOCK_STAGE; Update blocks only. Defaults to
 *   BEFORE. See BLOCK_STAGE for why the two cases exist.
 * @property {{unity: string, unreal: string, note?: string}} engines
 * @property {string[]} attributes particle attributes this block reads or writes
 */

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------
// Ordered by context, then by how early an author meets them.

const BLOCK_LIST = [
  // --- Spawn ----------------------------------------------------------------
  {
    id: 'spawn.rate',
    label: 'Spawn Rate',
    contexts: [CONTEXT_KIND.SPAWN],
    category: 'Emission',
    beginner: true,
    blurb: 'Emits particles continuously, at a steady number per second.',
    teach: 'Rate times the longest lifetime is how many particles exist at once. That product is what has to fit in the capacity, and it is the usual reason particles stop appearing.',
    props: {
      rate: {
        type: PROP_TYPE.FLOAT,
        default: 50,
        label: 'Rate',
        unit: '/s',
        min: 0,
        max: 10000,
        step: 1,
        // Over effect time, deliberately not over life: a spawn rate is a
        // property of the emitter, and a particle's age is meaningless here.
        // Declared rather than only asserted in a comment - see `domain` on
        // VfxPropDef. Without it the value carried domain 'life', the runtime
        // sampled effect time anyway (readSpawnScalar has no particle to ask),
        // and the curve editor labelled the axis "particle age" - three places
        // disagreeing about one number.
        modes: ['const', 'random', 'curve'],
        domain: VALUE_DOMAIN.TIME,
        basic: true,
        hot: true,
        hint: 'Particles emitted every second while the emitter is active.',
        presets: [
          { label: 'Sparse (10)', value: 10 },
          { label: 'Steady (50)', value: 50 },
          { label: 'Dense (500)', value: 500 },
        ],
      },
    },
    kernel: 'spawn.rate',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Constant Spawn Rate. Niagara: Spawn Rate module.',
    },
    attributes: [],
  },
  {
    id: 'spawn.burst',
    label: 'Spawn Burst',
    contexts: [CONTEXT_KIND.SPAWN],
    category: 'Emission',
    beginner: true,
    blurb: 'Emits a batch of particles all at once.',
    teach: 'Bursts are what impacts are made of. A burst is instantaneous, so its particles all share a birth time - randomise their lifetime or they will also all die together, which reads as a machine rather than an explosion.',
    props: {
      count: {
        type: PROP_TYPE.INT,
        default: 20,
        label: 'Count',
        min: 1,
        max: 10000,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'How many particles the burst emits.',
      },
    },
    kernel: 'spawn.burst',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Single Burst. Niagara: Spawn Burst Instantaneous.',
    },
    attributes: [],
  },

  // --- Initialize -----------------------------------------------------------
  {
    id: 'initialize.setLifetime',
    label: 'Set Lifetime',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Lifetime & Size',
    beginner: true,
    blurb: 'How long each particle lives before it disappears.',
    teach: 'Everything measured "over life" is measured against this, so doubling it stretches every fade and every size ramp with it. Without this block particles never die, the pool fills, and emission silently stops.',
    props: {
      lifetime: {
        type: PROP_TYPE.FLOAT,
        default: 1.5,
        label: 'Lifetime',
        unit: 's',
        min: 0.02,
        max: 60,
        step: 0.01,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Randomise this. A cloud where every puff dies at the same instant reads as a machine.',
        presets: [
          { label: 'Spark (0.35s)', value: 0.35 },
          { label: 'Flash (0.15s)', value: 0.15 },
          { label: 'Smoke (4s)', value: 4 },
        ],
      },
    },
    kernel: 'attr.set',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Set Lifetime. Niagara: Initialize Particle > Lifetime.',
    },
    attributes: ['lifetime'],
  },
  {
    id: 'initialize.setSize',
    label: 'Set Size',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Lifetime & Size',
    beginner: true,
    blurb: 'How big each particle starts, in metres.',
    teach: 'Sizes are in world metres, so a 0.1 particle is ten centimetres across. Authoring at the wrong scale is the most common thing to discover only after importing into an engine.',
    props: {
      size: {
        type: PROP_TYPE.FLOAT,
        default: 0.25,
        label: 'Size',
        unit: 'm',
        min: 0,
        max: 100,
        step: 0.01,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Diameter in metres. A human is about 1.8 tall for reference.',
        presets: [
          { label: 'Spark (0.05m)', value: 0.05 },
          { label: 'Ember (0.15m)', value: 0.15 },
          { label: 'Smoke puff (1.5m)', value: 1.5 },
        ],
      },
    },
    kernel: 'attr.set',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
    attributes: ['size'],
  },
  {
    id: 'initialize.setColor',
    label: 'Set Colour',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Colour & Opacity',
    beginner: true,
    blurb: 'The colour and opacity each particle starts with.',
    teach: 'Brightness above 1 is allowed and is how a glowing core blows out through the tonemapper. If the effect uses Additive blending, this colour is added as light - a dark colour adds almost nothing.',
    props: {
      color: {
        type: PROP_TYPE.COLOR,
        default: [1, 1, 1, 1],
        label: 'Colour',
        modes: M.COLOR,
        basic: true,
        hot: true,
        hint: 'Opacity is the fourth channel. Use Colour Over Life to fade.',
      },
    },
    kernel: 'attr.set',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
    attributes: ['color'],
  },
  {
    id: 'initialize.positionSphere',
    label: 'Position: Sphere',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Shape',
    beginner: true,
    blurb: 'Places particles inside or on the surface of a sphere.',
    teach: 'Surface gives a hollow shell, which reads as a shockwave; Volume fills the sphere and reads as a cloud. Radius is in metres.',
    props: {
      radius: {
        type: PROP_TYPE.FLOAT,
        default: 0.5,
        label: 'Radius',
        unit: 'm',
        min: 0,
        max: 100,
        step: 0.01,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
      },
    },
    modes: {
      fill: {
        options: ['volume', 'surface'],
        default: 'volume',
        label: 'Fill',
        hint: 'Surface makes a hollow shell; Volume fills it.',
      },
    },
    kernel: 'shape.position.sphere',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Position (Sphere). Niagara: Sphere Location.',
    },
    attributes: ['position'],
  },
  {
    id: 'initialize.positionCone',
    label: 'Cone Emitter',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Shape',
    beginner: true,
    blurb: 'Sprays particles out of a cone pointing up the Y axis.',
    teach: 'A cone is the shape behind muzzle flashes, jets and sprays. This sets both where a particle starts AND which way it travels, so it replaces Velocity: Random rather than pairing with it - Spread is what makes the difference between a tight jet and a wide spray.',
    props: {
      angle: {
        type: PROP_TYPE.FLOAT,
        default: 25,
        label: 'Spread',
        unit: 'deg',
        min: 0,
        max: 180,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Half-angle of the cone. 0 is a straight line, 90 is a flat disc.',
        presets: [
          { label: 'Tight jet (5)', value: 5 },
          { label: 'Muzzle flash (25)', value: 25 },
          { label: 'Wide spray (60)', value: 60 },
        ],
      },
      radius: {
        type: PROP_TYPE.FLOAT,
        default: 0.1,
        label: 'Base radius',
        unit: 'm',
        min: 0,
        max: 100,
        step: 0.01,
        modes: M.SCALAR_FIXED,
        basic: true,
        hint: 'How wide the mouth of the cone is. 0 emits from a single point.',
      },
      speed: {
        type: PROP_TYPE.FLOAT,
        default: 3,
        label: 'Speed',
        unit: 'm/s',
        min: 0,
        max: 200,
        step: 0.1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'How fast particles leave the cone. Randomise it so they spread out along their path instead of moving as a sheet.',
      },
    },
    kernel: 'shape.cone',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Position (Cone) plus Set Velocity from Direction. Niagara: Cone Location, which sets position and velocity in one module exactly as this does.',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'initialize.velocityRandom',
    label: 'Velocity: Random',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Motion',
    beginner: true,
    blurb: 'Gives each particle a random starting velocity, in metres per second.',
    teach: 'Velocity is metres per second, so 2 moves a particle two metres in one second - check it against the particle lifetime. Symmetric bounds like -2 to 2 spray outwards; asymmetric bounds bias a direction.',
    props: {
      min: {
        type: PROP_TYPE.VEC3,
        default: [-1, 1, -1],
        label: 'Minimum',
        unit: 'm/s',
        modes: M.VECTOR,
        basic: true,
      },
      max: {
        type: PROP_TYPE.VEC3,
        default: [1, 3, 1],
        label: 'Maximum',
        unit: 'm/s',
        modes: M.VECTOR,
        basic: true,
      },
    },
    kernel: 'vel.random',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Set Velocity Random. Niagara: Add Velocity.',
    },
    attributes: ['velocity'],
  },

  // --- Update ---------------------------------------------------------------
  {
    id: 'update.gravity',
    label: 'Add Gravity',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Motion',
    beginner: true,
    blurb: 'Pulls every particle downward, a little more each frame.',
    teach: 'Real gravity is -9.8, which is strong: sparks fall out of frame fast. Embers and smoke usually want a fraction of it, or a small positive value so they rise.',
    props: {
      gravity: {
        type: PROP_TYPE.VEC3,
        default: [0, -9.8, 0],
        label: 'Gravity',
        unit: 'm/s2',
        modes: M.VECTOR,
        basic: true,
        hot: true,
        presets: [
          { label: 'Earth', value: [0, -9.8, 0] },
          { label: 'Moon', value: [0, -1.62, 0] },
          { label: 'Gentle drift', value: [0, -0.5, 0] },
          { label: 'Rising smoke', value: [0, 0.8, 0] },
          { label: 'None', value: [0, 0, 0] },
        ],
      },
    },
    kernel: 'force.add',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Gravity. Niagara: Gravity Force.',
    },
    attributes: ['velocity'],
  },
  {
    id: 'update.drag',
    label: 'Add Drag',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Motion',
    beginner: true,
    blurb: 'Slows particles down over time, as if through air.',
    teach: 'Drag is what makes a burst decelerate instead of flying off at a constant speed, and it is usually the difference between sparks that look like sparks and sparks that look like bullets.',
    props: {
      drag: {
        type: PROP_TYPE.FLOAT,
        default: 1.5,
        label: 'Drag',
        min: 0,
        max: 50,
        step: 0.1,
        modes: M.SCALAR,
        basic: true,
        hot: true,
        hint: 'Higher slows faster. Around 1 is air; 10 is thick smoke.',
        presets: [
          { label: 'Air (1)', value: 1 },
          { label: 'Thick (8)', value: 8 },
        ],
      },
    },
    kernel: 'force.drag',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Linear Drag. Niagara: Drag.',
    },
    attributes: ['velocity'],
  },
  {
    id: 'update.turbulence',
    label: 'Add Turbulence',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Motion',
    beginner: false,
    blurb: 'Pushes particles around with a swirling noise field.',
    teach: 'Turbulence is what stops smoke looking like it is on rails. Keep the strength low - it is a nudge, not a wind. This is the most expensive block in the catalog, so watch the simulation time in the preview.',
    props: {
      strength: {
        type: PROP_TYPE.FLOAT,
        default: 1,
        label: 'Strength',
        unit: 'm/s2',
        min: 0,
        max: 50,
        step: 0.1,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
      frequency: {
        type: PROP_TYPE.FLOAT,
        default: 0.6,
        label: 'Frequency',
        min: 0.01,
        max: 10,
        step: 0.01,
        modes: M.SCALAR_FIXED,
        basic: true,
        hint: 'How tight the swirls are. Low is broad and lazy, high is busy.',
      },
    },
    kernel: 'force.curlNoise',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.APPROX,
      note: 'Unity: Turbulence. Niagara: Curl Noise Force, whose amplitude and frequency are scaled differently - the motion will be similar but not identical.',
    },
    attributes: ['velocity'],
  },
  {
    id: 'update.sizeOverLife',
    label: 'Size Over Life',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Lifetime & Size',
    beginner: true,
    blurb: 'Scales each particle as it ages, following a curve.',
    teach: 'This multiplies the starting size rather than replacing it, so the curve runs 0 to 1 and Set Size decides how big that is. Growing then shrinking is what makes a puff read as a puff.',
    props: {
      scale: {
        type: PROP_TYPE.FLOAT,
        default: 1,
        label: 'Scale over life',
        min: 0,
        max: 10,
        step: 0.01,
        // Curve is the point of this block, so it is offered first - but a
        // constant is still legal and means "uniformly bigger".
        modes: ['curve', 'const', 'random'],
        basic: true,
        hot: true,
        hint: 'A multiplier on the starting size. 1 means unchanged.',
      },
    },
    kernel: 'attr.overLife',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Set Size over Life. Niagara: Scale Sprite Size with a float curve.',
    },
    attributes: ['size', 'age', 'lifetime'],
  },
  {
    id: 'update.colorOverLife',
    label: 'Colour Over Life',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Colour & Opacity',
    beginner: true,
    blurb: 'Changes colour and opacity as each particle ages.',
    teach: 'This is where fading happens, and almost every effect needs it: a particle that vanishes at full opacity pops out of existence. End the alpha ramp at 0. Like Size Over Life this MULTIPLIES the starting colour, so leaving Set Colour at white shows the ramp exactly as authored, and tinting it per particle gives each one its own version of the same ramp.',
    props: {
      color: {
        type: PROP_TYPE.COLOR,
        default: [1, 1, 1, 1],
        label: 'Colour over life',
        modes: ['gradient', 'const'],
        basic: true,
        hot: true,
        hint: 'The alpha rail is the fade. Start and end it at 0 for smoke.',
      },
    },
    kernel: 'color.overLife',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Set Color over Life. Niagara: Color module with a colour curve.',
    },
    attributes: ['color', 'age', 'lifetime'],
  },
  {
    id: 'initialize.positionBox',
    label: 'Position in Box',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Shape',
    beginner: true,
    blurb: 'Scatters particles through a rectangular volume.',
    teach: 'The workhorse for weather and atmosphere: a wide, flat box above the camera is rain or snow, and a room-sized one is dust. The box is centred on the effect, so changing its size does not move it.',
    props: {
      size: {
        type: PROP_TYPE.VEC3,
        default: [4, 4, 4],
        label: 'Size',
        unit: 'm',
        min: 0,
        max: 200,
        step: 0.1,
        modes: M.VECTOR,
        basic: true,
        hot: true,
        hint: 'The full width, height and depth - not the half-extents.',
      },
    },
    kernel: 'shape.position.box',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Position (AABox). Niagara: Box Location.',
    },
    attributes: ['position'],
  },
  {
    id: 'initialize.positionCircle',
    label: 'Position in Circle',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Shape',
    beginner: true,
    blurb: 'Scatters particles around a flat circle or ring.',
    teach: 'A ring on the ground reads as a shockwave or a summoning circle; set the thickness to less than the radius for a ring, or to the radius for a filled disc. It lies in the XZ plane, so it is flat on the floor.',
    props: {
      radius: {
        type: PROP_TYPE.FLOAT,
        default: 1,
        label: 'Radius',
        unit: 'm',
        min: 0,
        max: 100,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
      thickness: {
        type: PROP_TYPE.FLOAT,
        default: 0.1,
        label: 'Thickness',
        unit: 'm',
        min: 0,
        max: 100,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hint: 'How far inwards from the radius particles may sit. Set it to the radius for a filled disc.',
      },
    },
    kernel: 'shape.position.circle',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Position (Circle). Niagara: Cylinder/Ring Location.',
    },
    attributes: ['position'],
  },
  {
    id: 'initialize.velocityRadial',
    label: 'Velocity Outward',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Motion',
    beginner: true,
    blurb: 'Sends each particle away from the centre.',
    teach: 'This is what an explosion is: a burst, a shape to spread them out, then this. It reads the position, so it has to sit BELOW the shape block - above it, every particle is still at the origin and gets a random direction instead.',
    props: {
      speed: {
        type: PROP_TYPE.FLOAT,
        default: 4,
        label: 'Speed',
        unit: 'm/s',
        min: 0,
        max: 200,
        step: 0.1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Randomise this to stop the whole burst arriving as one shell.',
      },
    },
    kernel: 'vel.radial',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Velocity from Direction & Speed (Direction = position). Niagara: Add Velocity in Cone / radial.',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'initialize.velocityDirection',
    label: 'Velocity in Direction',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Motion',
    beginner: true,
    blurb: 'Sends every particle the same way, with some spread.',
    teach: 'Rain, snow and jets. Spread is the half-angle of a cone around the direction: 0 is a perfectly parallel stream, 180 is every direction at once.',
    props: {
      direction: {
        type: PROP_TYPE.VEC3,
        default: [0, -1, 0],
        label: 'Direction',
        min: -1,
        max: 1,
        step: 0.05,
        modes: M.VECTOR,
        basic: true,
        hot: true,
        hint: 'Does not need to be a unit vector - only its direction is used.',
      },
      speed: {
        type: PROP_TYPE.FLOAT,
        default: 6,
        label: 'Speed',
        unit: 'm/s',
        min: 0,
        max: 200,
        step: 0.1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
      },
      spread: {
        type: PROP_TYPE.FLOAT,
        default: 5,
        label: 'Spread',
        unit: 'deg',
        min: 0,
        max: 180,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hint: 'A few degrees is enough to stop a stream looking like a solid rod.',
      },
    },
    kernel: 'vel.direction',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Velocity from Direction & Speed. Niagara: Add Velocity in Cone.',
    },
    attributes: ['velocity'],
  },
  {
    id: 'initialize.inheritVelocity',
    label: 'Inherit Velocity',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Motion',
    beginner: false,
    blurb: 'Keeps some of the velocity of the particle that spawned this one.',
    teach: 'Only meaningful in a sub-emitter. A fraction around 0.2 is what makes a trail read as being dragged along rather than as a line of dots hanging in the air; 1 makes the child continue exactly, and a negative value throws it back the way the parent came.',
    props: {
      scale: {
        type: PROP_TYPE.FLOAT,
        default: 0.25,
        label: 'Fraction',
        min: -2,
        max: 2,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
    },
    kernel: 'vel.inherit',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Inherit Source Velocity. Niagara: the event payload is read directly.',
    },
    attributes: ['velocity'],
  },
  {
    id: 'initialize.setRotation',
    label: 'Set Rotation',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Appearance',
    beginner: false,
    blurb: 'The angle each particle starts at.',
    teach: 'Randomise this on anything using a recognisable sprite. Identical unrotated copies of one texture read instantly as a repeated stamp, and a random start angle is the cheapest fix there is.',
    props: {
      rotation: {
        type: PROP_TYPE.FLOAT,
        default: 0,
        label: 'Rotation',
        unit: 'deg',
        min: -180,
        max: 180,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Set this to Random -180 to 180 to break up a repeated sprite.',
      },
    },
    kernel: 'attr.set',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
    attributes: ['rotation'],
  },
  {
    id: 'update.spin',
    label: 'Spin',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Motion',
    beginner: false,
    blurb: 'Turns each particle as it travels.',
    teach: 'Randomise the speed between a negative and a positive number, or every particle spins the same way and the whole effect appears to rotate as one sheet.',
    props: {
      speed: {
        type: PROP_TYPE.FLOAT,
        default: 45,
        label: 'Speed',
        unit: 'deg/s',
        min: -720,
        max: 720,
        step: 5,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
    },
    kernel: 'rot.spin',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
    attributes: ['rotation'],
  },
  {
    id: 'update.attractor',
    label: 'Attract to Point',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: false,
    blurb: 'Pulls particles towards a point, or pushes them away.',
    teach: 'A negative strength pushes instead of pulling. The falloff is gentle near the centre on purpose - a true inverse-square would be infinite there and send the particle to infinity in one frame.',
    props: {
      position: {
        type: PROP_TYPE.VEC3,
        default: [0, 1, 0],
        label: 'Point',
        unit: 'm',
        min: -50,
        max: 50,
        step: 0.1,
        modes: M.VECTOR,
        basic: true,
        hot: true,
      },
      strength: {
        type: PROP_TYPE.FLOAT,
        default: 6,
        label: 'Strength',
        unit: 'm/s2',
        min: -200,
        max: 200,
        step: 0.5,
        modes: M.SCALAR,
        basic: true,
        hot: true,
        hint: 'Negative pushes away.',
      },
      radius: {
        type: PROP_TYPE.FLOAT,
        default: 2,
        label: 'Falloff',
        unit: 'm',
        min: 0.01,
        max: 100,
        step: 0.1,
        modes: M.SCALAR_FIXED,
        hint: 'Beyond this distance the pull drops off quickly.',
      },
    },
    kernel: 'force.attract',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.APPROX,
      note: 'Niagara has Point Attraction Force, but its falloff curve differs - the shape is the same, the exact strength at a given distance is not.',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'update.vortex',
    label: 'Vortex',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: false,
    blurb: 'Swirls particles around an axis.',
    teach: 'A vortex needs both halves: the swirl makes them rotate, and the inward pull is what stops them spiralling out of the effect within a second. Turn the pull off and you get a widening spiral, which is occasionally what you want.',
    props: {
      position: {
        type: PROP_TYPE.VEC3,
        default: [0, 0, 0],
        label: 'Centre',
        unit: 'm',
        min: -50,
        max: 50,
        step: 0.1,
        modes: M.VECTOR,
        basic: true,
      },
      axis: {
        type: PROP_TYPE.VEC3,
        default: [0, 1, 0],
        label: 'Axis',
        min: -1,
        max: 1,
        step: 0.05,
        modes: M.VECTOR,
        basic: true,
        hint: 'Up for a whirlpool or a portal; sideways for a rolling wave.',
      },
      strength: {
        type: PROP_TYPE.FLOAT,
        default: 4,
        label: 'Swirl',
        min: -100,
        max: 100,
        step: 0.5,
        modes: M.SCALAR,
        basic: true,
        hot: true,
        hint: 'Negative swirls the other way.',
      },
      inward: {
        type: PROP_TYPE.FLOAT,
        default: 1,
        label: 'Pull in',
        unit: 'm/s2',
        min: -50,
        max: 50,
        step: 0.1,
        modes: M.SCALAR,
        basic: true,
      },
    },
    kernel: 'force.vortex',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Vortex Force. Niagara: Vortex Force.',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'update.speedLimit',
    label: 'Speed Limit',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: false,
    blurb: 'Caps how fast a particle can travel.',
    teach: 'The safety net for stacked forces. Gravity plus a vortex plus turbulence can accelerate a particle off screen in half a second; a limit keeps the effect where you put it without weakening any of the forces.',
    props: {
      speed: {
        type: PROP_TYPE.FLOAT,
        default: 10,
        label: 'Maximum',
        unit: 'm/s',
        min: 0,
        max: 500,
        step: 0.5,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
    },
    kernel: 'vel.limit',
    // After integration, or it clamps the previous frame's velocity and this
    // frame's acceleration immediately puts it back over. See BLOCK_STAGE.
    stage: BLOCK_STAGE.AFTER,
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.APPROX,
      note: 'Niagara has no single speed clamp; the importer builds one from a Scale Velocity with a curve.',
    },
    attributes: ['velocity'],
  },
  {
    id: 'update.collidePlane',
    label: 'Collide with Floor',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: true,
    blurb: 'Bounces particles off a horizontal plane.',
    teach: 'What makes debris, blood and sparks read as being in a place rather than in mid-air. Bounce 0 makes them stick, 1 makes them bounce forever; friction slows the sideways slide on each hit.',
    props: {
      height: {
        type: PROP_TYPE.FLOAT,
        default: 0,
        label: 'Height',
        unit: 'm',
        min: -50,
        max: 50,
        step: 0.05,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
      },
      bounce: {
        type: PROP_TYPE.FLOAT,
        default: 0.3,
        label: 'Bounce',
        min: 0,
        max: 1,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hot: true,
        hint: 'How much speed survives a hit. 0 sticks, 1 never settles.',
      },
      friction: {
        type: PROP_TYPE.FLOAT,
        default: 0.2,
        label: 'Friction',
        min: 0,
        max: 1,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hint: 'How much sideways speed is lost on each hit.',
      },
    },
    kernel: 'collide.plane',
    // After integration: a collision has to test the position the particle
    // actually moved to. See BLOCK_STAGE.
    stage: BLOCK_STAGE.AFTER,
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Collide with Plane. Niagara: Collision (Plane).',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'update.collideSphere',
    label: 'Collide with Sphere',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: false,
    blurb: 'Bounces particles off a sphere, or keeps them inside one.',
    teach: 'Outside makes the sphere an obstacle - a rock, a shield, a character. Inside makes it a container, which is how you keep an effect from escaping its own volume without shortening every lifetime.',
    props: {
      position: {
        type: PROP_TYPE.VEC3,
        default: [0, 0, 0],
        label: 'Centre',
        unit: 'm',
        min: -50,
        max: 50,
        step: 0.1,
        modes: M.VECTOR,
        basic: true,
      },
      radius: {
        type: PROP_TYPE.FLOAT,
        default: 1,
        label: 'Radius',
        unit: 'm',
        min: 0.01,
        max: 100,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
      bounce: {
        type: PROP_TYPE.FLOAT,
        default: 0.3,
        label: 'Bounce',
        min: 0,
        max: 1,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
      friction: {
        type: PROP_TYPE.FLOAT,
        default: 0.2,
        label: 'Friction',
        min: 0,
        max: 1,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
      },
    },
    modes: {
      side: {
        options: ['outside', 'inside'],
        default: 'outside',
        label: 'Collide on',
        hint: 'Outside keeps particles out of the sphere. Inside keeps them in.',
      },
    },
    kernel: 'collide.sphere',
    stage: BLOCK_STAGE.AFTER,
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Collide with Sphere. Niagara: Collision (Analytical, sphere).',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'update.collideBox',
    label: 'Collide with Box',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: false,
    blurb: 'Bounces particles off a box, or keeps them inside one.',
    teach: 'Inside is the useful one most of the time: a room-sized box keeps dust, smoke or magic within the space it belongs to. The contact face is whichever the particle actually crossed, so a hit near an edge leaves the way it came in.',
    props: {
      position: {
        type: PROP_TYPE.VEC3,
        default: [0, 0, 0],
        label: 'Centre',
        unit: 'm',
        min: -50,
        max: 50,
        step: 0.1,
        modes: M.VECTOR,
        basic: true,
      },
      size: {
        type: PROP_TYPE.VEC3,
        default: [4, 4, 4],
        label: 'Size',
        unit: 'm',
        min: 0.02,
        max: 200,
        step: 0.1,
        modes: M.VECTOR,
        basic: true,
        hot: true,
        hint: 'Full width, height and depth.',
      },
      bounce: {
        type: PROP_TYPE.FLOAT,
        default: 0.3,
        label: 'Bounce',
        min: 0,
        max: 1,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
        hot: true,
      },
      friction: {
        type: PROP_TYPE.FLOAT,
        default: 0.2,
        label: 'Friction',
        min: 0,
        max: 1,
        step: 0.05,
        modes: M.SCALAR,
        basic: true,
      },
    },
    modes: {
      side: {
        options: ['outside', 'inside'],
        default: 'inside',
        label: 'Collide on',
        hint: 'Inside keeps particles within the box. Outside makes it an obstacle.',
      },
    },
    kernel: 'collide.box',
    stage: BLOCK_STAGE.AFTER,
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Collide with AABox. Niagara: Collision (Analytical, box).',
    },
    attributes: ['position', 'velocity'],
  },
  {
    id: 'update.killOnBounds',
    label: 'Kill Outside Box',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Forces',
    beginner: false,
    blurb: 'Removes particles that leave a volume.',
    teach: 'This is how a rain or snow effect stays cheap: give the particles a long lifetime so they fall the whole way, and let this collect them at the floor instead of raising the capacity to hold the ones you cannot see.',
    props: {
      size: {
        type: PROP_TYPE.VEC3,
        default: [20, 20, 20],
        label: 'Size',
        unit: 'm',
        min: 0.1,
        max: 500,
        step: 0.5,
        modes: M.VECTOR,
        basic: true,
        hot: true,
        hint: 'Full width, height and depth, centred on the effect.',
      },
    },
    kernel: 'kill.bounds',
    // After integration, so a particle is collected on the frame it leaves
    // rather than on the one after.
    stage: BLOCK_STAGE.AFTER,
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Kill (AABox). Niagara: Kill Particles In Volume.',
    },
    attributes: ['position', 'age', 'lifetime'],
  },
  {
    id: 'initialize.setFlipbookFrame',
    label: 'Set Sprite Frame',
    contexts: [CONTEXT_KIND.INITIALIZE],
    category: 'Appearance',
    beginner: false,
    blurb: 'Which frame of a sprite sheet each particle starts on.',
    teach: 'Randomise this on a looping sheet - smoke, fire, water - so the particles are not all showing the same frame at the same moment, which reads as a single flickering sheet rather than as a cloud.',
    props: {
      flipbookFrame: {
        type: PROP_TYPE.FLOAT,
        default: 0,
        label: 'Frame',
        min: 0,
        max: 256,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Set to Random 0 to (frames - 1) to break up a looping sheet.',
      },
    },
    kernel: 'attr.set',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
    attributes: ['flipbookFrame'],
  },
  {
    id: 'update.flipbook',
    label: 'Play Sprite Sheet',
    contexts: [CONTEXT_KIND.UPDATE],
    category: 'Appearance',
    beginner: true,
    blurb: 'Steps through the frames of a sprite sheet.',
    teach: 'Set the frame count to the number of cells in the sheet, and set the same columns and rows on the Sprite Sheet block in the Output - the two have to agree or the animation plays parts of neighbouring frames.',
    props: {
      frames: {
        type: PROP_TYPE.INT,
        default: 16,
        label: 'Frames',
        min: 1,
        max: 256,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'How many cells the sheet actually contains - often fewer than columns times rows.',
      },
      rate: {
        type: PROP_TYPE.FLOAT,
        default: 24,
        label: 'Frames per second',
        min: 0,
        max: 120,
        step: 1,
        modes: M.SCALAR,
        hint: 'Only used when the timing is "rate".',
      },
    },
    modes: {
      timing: {
        options: ['life', 'rate'],
        default: 'life',
        label: 'Timing',
        hint: 'Life plays the sheet exactly once, however long the particle lives - right for an explosion or a puff. Rate plays at a fixed speed and loops - right for a torch.',
      },
    },
    kernel: 'flipbook.advance',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Flipbook Player / Set Tex Index. Niagara: SubUV Animation.',
    },
    attributes: ['flipbookFrame', 'age', 'lifetime'],
  },

  // --- Output ---------------------------------------------------------------
  {
    id: 'output.setFlipbook',
    label: 'Sprite Sheet',
    contexts: [CONTEXT_KIND.OUTPUT],
    category: 'Appearance',
    beginner: false,
    blurb: 'Tells the renderer how the texture is divided into frames.',
    teach: 'This is the LAYOUT of the sheet; Play Sprite Sheet in the Update stage is what advances through it. Both are needed - the layout alone shows frame 0 for ever, and the player alone has nothing to divide.',
    props: {
      columns: {
        type: PROP_TYPE.INT,
        default: 4,
        label: 'Columns',
        min: 1,
        max: 32,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
      },
      rows: {
        type: PROP_TYPE.INT,
        default: 4,
        label: 'Rows',
        min: 1,
        max: 32,
        step: 1,
        modes: M.SCALAR_FIXED,
        basic: true,
        hot: true,
        hint: 'Rows count downward from the top of the image, as an artist lays a sheet out.',
      },
    },
    kernel: 'output.flipbook',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Flipbook size on the output. Niagara: SubUV Texture rows/columns.',
    },
    attributes: [],
  },
  {
    id: 'output.setMesh',
    label: 'Particle Mesh',
    contexts: [CONTEXT_KIND.OUTPUT],
    category: 'Appearance',
    beginner: false,
    blurb: 'Draws each particle as a 3D model instead of a flat sprite.',
    teach: 'Set the Output "Render as" to Mesh as well, or this is ignored and you get billboards. Mesh particles cost real triangles - a hundred pieces of debris at a thousand triangles each is a hundred thousand, so keep the model small.',
    props: {
      mesh: {
        type: PROP_TYPE.MESH,
        default: '',
        label: 'Mesh',
        modes: M.ASSET,
        basic: true,
        hot: true,
        hint: 'A mesh asset from the library. It is centred and scaled to fit, so the particle size means the same thing whatever units it was modelled in. Leave empty for a built-in chip of debris.',
      },
    },
    kernel: 'output.mesh',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Unity: Output Particle Mesh. Niagara: Mesh Renderer.',
    },
    attributes: [],
  },
  {
    id: 'output.setMainTexture',
    label: 'Sprite Texture',
    contexts: [CONTEXT_KIND.OUTPUT],
    category: 'Appearance',
    beginner: true,
    blurb: 'The image drawn for each particle.',
    teach: 'A soft round blob covers most cases. With Additive blending the texture is added as light, so its black areas are invisible and it needs no alpha channel; with Alpha blending the alpha channel is what shapes it.',
    props: {
      texture: {
        type: PROP_TYPE.TEXTURE,
        default: '',
        label: 'Texture',
        modes: M.ASSET,
        basic: true,
        hot: true,
        hint: 'An image asset from the library. Leave empty to draw plain quads.',
      },
    },
    kernel: 'output.texture',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'Bound as the output material main texture in both engines.',
    },
    attributes: [],
  },
];

// ---------------------------------------------------------------------------
// Context parameter definitions
// ---------------------------------------------------------------------------
// Context params are settings on the context itself rather than blocks in its
// stack, which mirrors how VFX Graph splits an Output context's render state
// from the blocks inside it.

export const CONTEXT_DEFS = Object.freeze({
  [CONTEXT_KIND.EVENT]: {
    label: 'Event',
    icon: 'bolt',
    blurb: 'Decides what makes this system emit.',
    flowNote: 'Without one, the system emits on its own timeline clips.',
    params: {
      trigger: {
        options: Object.keys(EVENT_TRIGGERS),
        default: 'onPlay',
        label: 'Emit when',
        hint: 'On play uses this system\'s own clips. The others make it a sub-emitter: it emits wherever a particle of another system dies or collides, which is how one impact becomes a spark, a puff and a decal.',
      },
      source: {
        // The option list is the effect's OWN systems, so it cannot be a static
        // list here. `optionsFrom` is read by the parameters panel and the
        // context node, which is what keeps them generic over the catalog
        // rather than special-casing the Event kind.
        optionsFrom: 'systems',
        options: [],
        default: '',
        label: 'Watching',
        hint: 'Which system\'s particles raise the event.',
      },
      probability: {
        options: ['1', '0.5', '0.25', '0.1'],
        default: '1',
        label: 'Chance',
        hint: 'The fraction of events that actually emit. 0.25 on a thousand dying sparks gives about 250 puffs instead of a thousand.',
      },
    },
  },
  [CONTEXT_KIND.SPAWN]: {
    label: 'Spawn',
    icon: 'schedule',
    blurb: 'Decides how many particles are born, and when.',
    flowNote: 'Runs every frame while the emitter is active.',
    params: {},
  },
  [CONTEXT_KIND.INITIALIZE]: {
    label: 'Initialize',
    icon: 'auto_awesome',
    blurb: 'Sets up each particle at the moment it is born.',
    flowNote: 'Runs once per particle, at birth.',
    params: {},
  },
  [CONTEXT_KIND.UPDATE]: {
    label: 'Update',
    icon: 'refresh',
    blurb: 'Changes particles as they age.',
    flowNote: 'Runs every frame, for every living particle.',
    params: {
      integrator: {
        options: ['semiImplicit', 'euler'],
        default: 'semiImplicit',
        label: 'Integrator',
        hint: 'Semi-implicit is stabler with strong drag. Leave it alone unless particles are jittering.',
      },
    },
  },
  [CONTEXT_KIND.OUTPUT]: {
    label: 'Output',
    icon: 'grid_view',
    blurb: 'Draws the particles.',
    flowNote: 'Runs every frame, once per living particle.',
    params: {
      mode: {
        options: ['billboard', 'stretched', 'mesh', 'trail', 'point'],
        default: 'billboard',
        label: 'Render as',
        hint: 'Billboard always faces the camera. Stretched points along velocity, which is what makes sparks look fast.',
      },
      blend: {
        options: ['additive', 'alpha', 'premultiplied', 'opaque'],
        default: 'additive',
        label: 'Blending',
        hint: 'Additive adds light and suits fire, sparks and magic. Alpha suits smoke and anything that should block what is behind it.',
      },
      sort: {
        options: ['none', 'depth', 'age'],
        default: 'none',
        label: 'Sorting',
        hint: 'Additive blending does not need sorting. Alpha blending usually does.',
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------
// Deliberately few. Curves, gradients and random ranges are property MODES,
// not nodes, so the overwhelming majority of authoring involves no wiring at
// all - which is the single biggest ease-of-use decision in the feature. An
// operator earns its place only when a value has to be SHARED between
// properties or computed from something a mode cannot reach.

const OPERATOR_LIST = [
  {
    id: 'op.constant',
    label: 'Value',
    category: 'Input',
    beginner: true,
    blurb: 'A number you can wire into several properties at once.',
    teach: 'Use this when two properties must stay in step - wire one Value into both and there is only one number to change.',
    props: {
      value: { type: PROP_TYPE.FLOAT, default: 1, label: 'Value', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'const',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.multiply',
    label: 'Multiply',
    category: 'Math',
    beginner: false,
    blurb: 'Multiplies two values together.',
    teach: 'Handy for scaling a shared value per property: one Value node feeding two Multiplies lets each property take a different fraction of it.',
    props: {
      a: { type: PROP_TYPE.FLOAT, default: 1, label: 'A', modes: M.SCALAR_FIXED, basic: true },
      b: { type: PROP_TYPE.FLOAT, default: 1, label: 'B', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.time',
    label: 'Effect Time',
    category: 'Input',
    beginner: false,
    blurb: 'Seconds since the effect started playing.',
    teach: 'Changes once per frame for the whole effect, not per particle - so it can drive a spawn rate but cannot describe something that varies between particles.',
    props: {},
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'perFrame',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.getAttribute',
    label: 'Particle Attribute',
    category: 'Input',
    beginner: false,
    blurb: 'Reads a value off the particle being processed.',
    teach: 'This is a per-particle value, so it can only feed properties that are themselves per-particle. Wiring it into a spawn rate is not meaningful and the compiler will say so.',
    props: {},
    modes: {
      attribute: {
        options: ['age', 'normalizedAge', 'lifetime', 'speed', 'size'],
        default: 'normalizedAge',
        label: 'Attribute',
      },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'perParticle',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.add',
    label: 'Add',
    category: 'Math',
    beginner: false,
    blurb: 'Adds two values together.',
    teach: 'Use this to offset a shared value - one Value node plus a different number per property.',
    props: {
      a: { type: PROP_TYPE.FLOAT, default: 0, label: 'A', modes: M.SCALAR_FIXED, basic: true },
      b: { type: PROP_TYPE.FLOAT, default: 0, label: 'B', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.subtract',
    label: 'Subtract',
    category: 'Math',
    beginner: false,
    blurb: 'Subtracts the second value from the first.',
    teach: 'Order matters here, unlike Add and Multiply: A minus B.',
    props: {
      a: { type: PROP_TYPE.FLOAT, default: 0, label: 'A', modes: M.SCALAR_FIXED, basic: true },
      b: { type: PROP_TYPE.FLOAT, default: 0, label: 'B', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.divide',
    label: 'Divide',
    category: 'Math',
    beginner: false,
    blurb: 'Divides the first value by the second.',
    teach: 'Dividing by zero gives zero here rather than infinity - an infinity in a particle position turns the whole system to NaN a frame later, which is far harder to find than a property reading zero.',
    props: {
      a: { type: PROP_TYPE.FLOAT, default: 1, label: 'A', modes: M.SCALAR_FIXED, basic: true },
      b: { type: PROP_TYPE.FLOAT, default: 1, label: 'B', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.lerp',
    label: 'Blend',
    category: 'Math',
    beginner: false,
    blurb: 'Blends between two values.',
    teach: 'At 0 you get A, at 1 you get B, and halfway you get the average. Wire the amount from something that changes to cross-fade between two settings.',
    props: {
      a: { type: PROP_TYPE.FLOAT, default: 0, label: 'From', modes: M.SCALAR_FIXED, basic: true },
      b: { type: PROP_TYPE.FLOAT, default: 1, label: 'To', modes: M.SCALAR_FIXED, basic: true },
      t: { type: PROP_TYPE.FLOAT, default: 0.5, label: 'Amount', min: 0, max: 1, step: 0.01, modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.clamp',
    label: 'Clamp',
    category: 'Math',
    beginner: false,
    blurb: 'Keeps a value between a low and a high bound.',
    teach: 'The safety net for a wired value: clamp a spawn rate and no amount of driving it from elsewhere can ask for more particles than the capacity holds.',
    props: {
      value: { type: PROP_TYPE.FLOAT, default: 0, label: 'Value', modes: M.SCALAR_FIXED, basic: true },
      min: { type: PROP_TYPE.FLOAT, default: 0, label: 'Lowest', modes: M.SCALAR_FIXED, basic: true },
      max: { type: PROP_TYPE.FLOAT, default: 1, label: 'Highest', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.remap',
    label: 'Remap',
    category: 'Math',
    beginner: false,
    blurb: 'Rescales a value from one range into another.',
    teach: 'The usual way to make one source drive something with a different scale - turn 0..1 into 200..800 without arithmetic. The result is clamped to the output range.',
    props: {
      value: { type: PROP_TYPE.FLOAT, default: 0, label: 'Value', modes: M.SCALAR_FIXED, basic: true },
      inMin: { type: PROP_TYPE.FLOAT, default: 0, label: 'From low', modes: M.SCALAR_FIXED, basic: true },
      inMax: { type: PROP_TYPE.FLOAT, default: 1, label: 'From high', modes: M.SCALAR_FIXED, basic: true },
      outMin: { type: PROP_TYPE.FLOAT, default: 0, label: 'To low', modes: M.SCALAR_FIXED, basic: true },
      outMax: { type: PROP_TYPE.FLOAT, default: 1, label: 'To high', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
  {
    id: 'op.random',
    label: 'Random Per Frame',
    category: 'Input',
    beginner: false,
    blurb: 'A new number every frame, shared by every particle born that frame.',
    teach: 'Not the same as a Random property mode: this draws ONCE per frame, so every particle born in that frame gets the same number. Use the property mode when you want each particle to differ.',
    props: {
      min: { type: PROP_TYPE.FLOAT, default: 0, label: 'Lowest', modes: M.SCALAR_FIXED, basic: true },
      max: { type: PROP_TYPE.FLOAT, default: 1, label: 'Highest', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'perFrame',
    engines: {
      unity: ENGINE_SUPPORT.NATIVE,
      unreal: ENGINE_SUPPORT.NATIVE,
      note: 'The value differs from this preview: neither engine lets us inject our own generator. The structure of the randomness survives, the exact numbers do not.',
    },
  },
  {
    id: 'op.sine',
    label: 'Oscillate',
    category: 'Math',
    beginner: false,
    blurb: 'A value that swings smoothly between -1 and 1.',
    teach: 'Wire Effect Time into this for a pulse. One full swing per unit of input, so multiply the time first to change the rate.',
    props: {
      phase: { type: PROP_TYPE.FLOAT, default: 0, label: 'Phase', modes: M.SCALAR_FIXED, basic: true },
    },
    outputs: { out: PROP_TYPE.FLOAT },
    freq: 'inherit',
    engines: { unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE },
  },
];

// ---------------------------------------------------------------------------
// Indexed access
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<VfxBlockDef>} */
export const BLOCKS = Object.freeze(BLOCK_LIST.map((b) => Object.freeze(b)));

/** @type {ReadonlyArray<Object>} */
export const OPERATORS = Object.freeze(OPERATOR_LIST.map((o) => Object.freeze(o)));

const BLOCK_BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));
const OPERATOR_BY_ID = new Map(OPERATORS.map((o) => [o.id, o]));

/**
 * The catalog object the compiler and the UI both consult. Passed explicitly
 * rather than imported directly at the point of use, so a test can substitute
 * a smaller or deliberately broken catalog - which is how the 'no engine
 * support' path gets exercised without shipping a block nobody wants.
 */
export const CATALOG = Object.freeze({
  blocks: BLOCKS,
  operators: OPERATORS,
  contexts: CONTEXT_DEFS,
  block: (id) => BLOCK_BY_ID.get(id) || null,
  operator: (id) => OPERATOR_BY_ID.get(id) || null,
});

/**
 * Build a catalog from explicit lists. Only the tests use this; production
 * code uses CATALOG.
 *
 * @param {{blocks?: Array<Object>, operators?: Array<Object>}} parts
 * @returns {typeof CATALOG}
 */
export function makeCatalog(parts = {}) {
  const blocks = parts.blocks || BLOCKS;
  const operators = parts.operators || OPERATORS;
  const blockMap = new Map(blocks.map((b) => [b.id, b]));
  const operatorMap = new Map(operators.map((o) => [o.id, o]));
  return Object.freeze({
    blocks,
    operators,
    contexts: CONTEXT_DEFS,
    block: (id) => blockMap.get(id) || null,
    operator: (id) => operatorMap.get(id) || null,
  });
}

/**
 * Default property values for a block type, as a document-ready props object.
 * Used when the palette adds a block, so a freshly added block is immediately
 * doing something sensible rather than sitting at zero.
 *
 * @param {Object} def a block or operator definition
 * @returns {Object<string, *>}
 */
export function defaultProps(def) {
  const props = {};
  for (const [name, prop] of Object.entries(def.props || {})) {
    props[name] = Array.isArray(prop.default) ? prop.default.slice() : prop.default;
  }
  return props;
}

/**
 * Default mode selections for a block type.
 * @param {Object} def
 * @returns {Object<string, string>}
 */
export function defaultModes(def) {
  const modes = {};
  for (const [name, mode] of Object.entries(def.modes || {})) modes[name] = mode.default;
  return modes;
}

/**
 * Default params for a context kind.
 * @param {string} kind
 * @returns {Object<string, string>}
 */
export function defaultContextParams(kind) {
  const def = CONTEXT_DEFS[kind];
  if (!def) return {};
  const params = {};
  for (const [name, param] of Object.entries(def.params || {})) params[name] = param.default;
  return params;
}

/**
 * Worst engine support across a set of definitions, which is what the
 * compatibility badge on a whole effect shows.
 *
 * @param {Array<Object>} defs
 * @param {'unity'|'unreal'} target
 * @returns {string} an ENGINE_SUPPORT value
 */
export function worstEngineSupport(defs, target) {
  let worst = ENGINE_SUPPORT.NATIVE;
  for (const def of defs) {
    const support = def?.engines?.[target];
    if (support === ENGINE_SUPPORT.NONE) return ENGINE_SUPPORT.NONE;
    if (support === ENGINE_SUPPORT.APPROX) worst = ENGINE_SUPPORT.APPROX;
  }
  return worst;
}
