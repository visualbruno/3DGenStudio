// Emitter shapes, as something the viewport can draw a wireframe of.
//
// WHY THIS EXISTS: "where do these particles come from?" is the first question
// a shape emitter raises and the hardest to answer from the result. A sphere
// and a box of the right size look identical once the particles have moved a
// metre, an offset emitter looks like an effect placed wrong, and a rotated one
// looks like a bug. Drawing the shape answers all three at once.
//
// PURE, AND SEPARATE FROM THE COMPONENT, for the reason a gizmo lives or dies
// by: IT HAS TO AGREE WITH THE KERNEL. A wireframe sphere drawn where the
// particles are not is worse than no wireframe - it turns a question into a
// false answer. Keeping the derivation here means a test can assert that what
// the gizmo describes is what the shape kernel was given, rather than that it
// looks plausible on screen.
//
// THREE FACTS IT LEANS ON, all of them properties of the document format:
//
//   1. EVERY VALUE MODE KEEPS A USABLE LITERAL `v` (see vfx/value.js). A radius
//      that is random-between-two, driven by a curve or wired from an operator
//      still has a representative number, so the gizmo can draw SOMETHING for
//      every shape rather than giving up on the interesting ones.
//   2. A DISABLED BLOCK STILL EXISTS. It is skipped here, because the particles
//      it would have placed are not there either.
//   3. THE LAST POSITION BLOCK IN THE STACK WINS. Blocks run in order and each
//      one WRITES position rather than accumulating, so a stage holding two
//      shapes emits from the second. Drawing both would show a shape no
//      particle uses.

import { CONTEXT_KIND } from '../../../vfx/doc.js';

/** Shape blocks, and how to read each one's geometry. */
const SHAPES = {
  'initialize.positionPoint': (props) => ({
    kind: 'point',
    radius: num(props.jitter, 0),
  }),
  'initialize.positionSphere': (props, block) => ({
    kind: 'sphere',
    radius: num(props.radius, 0.5),
    hollow: block.modes?.fill === 'surface',
  }),
  'initialize.positionBox': (props) => ({
    kind: 'box',
    size: vec(props.size, [1, 1, 1]),
  }),
  'initialize.positionCircle': (props) => ({
    kind: 'circle',
    radius: num(props.radius, 1),
    // The band the kernel fills, so a ring reads as a ring rather than a disc.
    inner: Math.max(0, num(props.radius, 1) - num(props.thickness, 0)),
  }),
  'initialize.positionCone': (props) => ({
    kind: 'cone',
    radius: num(props.radius, 0.1),
    // Degrees, as authored. The HEIGHT is the drawing's own choice - the kernel
    // has none, it emits from the mouth along a direction - so the component
    // picks one and the descriptor does not pretend to know it.
    angle: num(props.angle, 25),
  }),
  'initialize.positionLine': (props) => ({
    kind: 'line',
    start: vec(props.start, [-0.5, 0, 0]),
    end: vec(props.end, [0.5, 0, 0]),
    radius: num(props.thickness, 0),
  }),
  'initialize.positionMesh': (props) => ({
    kind: 'mesh',
    scale: num(props.scale, 1),
    // The SLOT KEY, not an asset id - blocks never hold ids. The caller
    // resolves it through doc.references, the same as everything else.
    slot: typeof props.mesh?.v === 'string' ? props.mesh.v : '',
  }),
};

/**
 * A drawable description of every system's emitter shape.
 *
 * @param {Object} doc a normalised document
 * @returns {Array<Object>} one entry per system that has a shape block:
 *   `{ systemId, systemName, blockId, offset, rotation, ...shape }`
 */
export function emitterGizmos(doc) {
  const out = [];
  for (const system of doc.systems || []) {
    for (const context of system.contexts || []) {
      if (context.kind !== CONTEXT_KIND.INITIALIZE) continue;
      // LAST WINS - see fact 3. Walked backwards so the search stops at it.
      for (let i = context.blocks.length - 1; i >= 0; i -= 1) {
        const block = context.blocks[i];
        if (block.enabled === false) continue;
        const read = SHAPES[block.type];
        if (!read) continue;
        out.push({
          systemId: system.id,
          systemName: system.name || '',
          blockId: block.id,
          // Point and Line carry no transform - they are defined by explicit
          // coordinates - so `offset` doubles as Point's position and both
          // default to nothing.
          offset: vec(block.props?.offset, [0, 0, 0]),
          rotation: vec(block.props?.rotation, [0, 0, 0]),
          ...read(block.props || {}, block),
        });
        break;
      }
    }
  }
  return out;
}

/**
 * The asset id behind a mesh gizmo's slot, or null.
 *
 * Split out so the viewport does not have to know how references are shaped,
 * and so this file stays free of asset plumbing.
 *
 * @param {Object} doc
 * @param {string} slot
 * @returns {number|null}
 */
export function gizmoMeshAssetId(doc, slot) {
  const entry = slot ? doc.references?.[slot] : null;
  const match = /^asset:(\d+)$/.exec(String(entry?.ref || ''));
  return match ? Number(match[1]) : null;
}

// --- reading a VfxValue -----------------------------------------------------
//
// Only ever the literal. See fact 1: every mode keeps one, so this needs no
// knowledge of curves, gradients, ranges or registers - and a gizmo that tried
// to evaluate a curve would be claiming a precision it does not have anyway,
// since the value differs per particle.

function num(value, fallback) {
  const v = Array.isArray(value?.v) ? value.v[0] : value?.v;
  return Number.isFinite(v) ? v : fallback;
}

function vec(value, fallback) {
  const v = value?.v;
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => Number.isFinite(n))) {
    return [v[0], v[1], v[2]];
  }
  // A scalar written into a vec3 slot broadcasts, exactly as a binding does.
  if (Number.isFinite(v)) return [v, v, v];
  return fallback;
}
