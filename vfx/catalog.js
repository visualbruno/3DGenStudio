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

/** How faithfully a block survives the trip into an engine. */
export const ENGINE_SUPPORT = Object.freeze({
  /** A direct equivalent exists; parameters map one to one. */
  NATIVE: 'native',
  /** Something close exists, with different semantics worth warning about. */
  APPROX: 'approx',
  /** No equivalent. The importer will drop it and say so. */
  NONE: 'none',
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
        modes: ['const', 'random', 'curve'],
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

  // --- Output ---------------------------------------------------------------
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
    blurb: 'Starts or stops emission.',
    flowNote: 'Fires once, when the effect plays.',
    params: {},
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
