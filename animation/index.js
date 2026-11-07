// "Animate with AI" - the operations an agent performs, independent of how it
// is connected. The MCP tools (mcp/tools/animation.js) are a thin shell over
// these, and the planned in-app agent will call the same functions in-process.
//
// Pure Node + three: no DOM, no GPU, no services. A whole describe -> preview
// -> save loop runs on any machine the backend runs on.
import { loadRig, skinPositions, computeNodeWorlds } from './gltfRig.js';
import { describeRig, chainColours } from './analyze.js';
import { inspectRig } from './inspect.js';
import { createPoseContext, buildPose } from './pose.js';
import { normalizeSpec, compileSpec, analyzeMotion } from './compile.js';
import { writeClip, removeClip, listClips, listClipsInJson, clipSampler } from './glbAnimation.js';
import { viewBasis, viewExtent, renderTile, composeGrid, PALETTE } from './render.js';
import * as THREE from 'three';
import { mapRigs, createRetarget, MOTION_LIBRARY } from './retarget.js';
import { buildLibraryDocument } from './library.js';

export { MOTION_LIBRARY, buildLibraryDocument };

export { normalizeSpec, listClips, listClipsInJson, inspectRig };

export const VIEWS = ['front', 'back', 'left', 'right', 'three_quarter', 'three_quarter_back', 'top'];
export const COLOUR_NAMES = [
  'red', 'blue', 'green', 'yellow', 'purple', 'cyan', 'orange', 'pink',
  'lime', 'periwinkle', 'tan', 'mint', 'pale yellow', 'brown', 'maroon', 'dark green'
];

/** Parse a GLB and analyse its rig. */
export function openRig(buffer, profile = null) {
  const rig = loadRig(buffer);
  const description = describeRig(rig, profile);
  return { rig, description };
}

function skeletonSegments(rig, pose, description, colourByChain = true) {
  const worlds = computeNodeWorlds(rig, pose);
  const pos = rig.joints.map(j => new THREE.Vector3().setFromMatrixPosition(worlds[j.node]));
  const labels = description.chains.map(c => c.label);
  const segs = [];
  for (const j of rig.joints) {
    if (j.parent < 0) continue;
    const a = pos[j.parent];
    const b = pos[j.index];
    let colour = [255, 170, 40];
    if (colourByChain) {
      const i = labels.indexOf(description.jointChain[j.index]);
      const c = PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
      colour = [Math.round(255 * Math.min(1, c[0] * 1.15)), Math.round(255 * Math.min(1, c[1] * 1.15)), Math.round(255 * Math.min(1, c[2] * 1.15))];
    }
    segs.push([a.x, a.y, a.z, b.x, b.y, b.z, colour]);
  }
  return segs;
}

function groundPointOf(description) {
  return [description.origin[0], description.size.groundY, description.origin[2]];
}

/**
 * The rig at rest, each chain in its own colour, from several views - the
 * image that lets an agent check the labels before posing anything.
 */
export function renderRigViews(rig, description, { views = ['front', 'left', 'three_quarter', 'top'], size = 320, skeleton = false } = {}) {
  const { colours, legend } = chainColours(rig, description, PALETTE);
  const positions = rig.geometry.positions;
  const segs = skeleton ? skeletonSegments(rig, null, description) : null;
  const tiles = views.map((view) => {
    const basis = viewBasis(description.frame.vectors, view);
    const extent = viewExtent(basis, [positions]);
    return renderTile({
      positions, indices: rig.geometry.indices, vertexColours: colours, basis, extent, size,
      segments: segs, groundPoint: groundPointOf(description), label: view.replace(/_/g, ' '),
      decimate: rig.geometry.previewDecimation
    });
  });
  const { png } = composeGrid(tiles, Math.min(4, tiles.length));
  return {
    png,
    legend: legend.map((entry, i) => ({ chain: entry.label, colour: COLOUR_NAMES[i % COLOUR_NAMES.length] }))
  };
}

function pickFrames(count, total) {
  const n = Math.max(1, Math.min(count, total));
  if (n === 1) return [0];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(Math.round((i * (total - 1)) / (n - 1)));
  return [...new Set(out)];
}

function renderPoses(rig, description, poses, times, { frames = 8, views = ['left'], size = 256, skeleton = false, columns = 4 } = {}) {
  const chosen = pickFrames(frames, poses.length);
  const clouds = chosen.map(f => skinPositions(rig, poses[f]));
  const tiles = [];
  for (const view of views) {
    const basis = viewBasis(description.frame.vectors, view);
    // One framing for every frame of a view, so motion reads as motion.
    const extent = viewExtent(basis, clouds, [groundPointOf(description)]);
    chosen.forEach((f, i) => {
      tiles.push(renderTile({
        positions: clouds[i], indices: rig.geometry.indices, basis, extent, size,
        segments: skeleton ? skeletonSegments(rig, poses[f], description) : null,
        groundPoint: groundPointOf(description),
        label: `${views.length > 1 ? `${view.replace(/_/g, ' ')} ` : ''}${times[f].toFixed(2)}s`,
        decimate: rig.geometry.previewDecimation
      }));
    });
  }
  // Several views of one moment sit side by side; several moments of several
  // views make one row per view.
  const cols = chosen.length === 1 ? tiles.length : (views.length > 1 ? chosen.length : Math.min(columns, tiles.length));
  return { png: composeGrid(tiles, cols).png, frames: chosen.map(f => Math.round(times[f] * 1000) / 1000) };
}

/** Compile a spec and render a filmstrip of it, with motion checks. */
export function previewSpec(rig, description, rawSpec, options = {}, { base = null } = {}) {
  const { spec, errors, warnings } = normalizeSpec(rawSpec);
  if (errors.length) {
    const err = new Error(`The spec is invalid:\n- ${errors.join('\n- ')}`);
    err.specErrors = errors;
    throw err;
  }
  const ctx = createPoseContext(rig, description);
  const compiled = compileSpec(ctx, spec, { base });
  const analysis = analyzeMotion(ctx, compiled);
  const render = renderPoses(rig, description, compiled.poses, compiled.clip.times, options);
  return { spec, png: render.png, frames: render.frames, analysis, warnings: [...warnings, ...compiled.warnings] };
}

/** Render a filmstrip of a clip already stored in the GLB. */
export function previewStoredClip(rig, description, clipName, options = {}) {
  const clips = listClipsInJson(rig.json);
  const index = clips.findIndex(c => c.name === clipName);
  if (index < 0) throw new Error(`No animation named "${clipName}". This mesh has: ${clips.map(c => c.name).join(', ') || 'none'}.`);
  const sampler = clipSampler(rig, clips[index].index);
  const fps = 30;
  const count = Math.max(2, Math.round(sampler.duration * fps) + 1);
  const times = [];
  const poses = [];
  for (let f = 0; f < count; f += 1) {
    const t = Math.min(sampler.duration, f / fps);
    times.push(t);
    poses.push(sampler.sample(t));
  }
  return { ...renderPoses(rig, description, poses, times, options), duration: Math.round(sampler.duration * 1000) / 1000 };
}

/** One static pose (spec-style targets/root/ik) rendered from several views. */
export function previewPose(rig, description, { pose = {}, root = null, ik = null } = {}, { views = ['front', 'left', 'three_quarter'], size = 300, skeleton = false } = {}) {
  const ctx = createPoseContext(rig, description);
  const result = buildPose(ctx, { targets: pose, root, ik });
  const render = renderPoses(rig, description, [result.pose], [0], { frames: 1, views, size, skeleton, columns: views.length });
  return { png: render.png, warnings: result.warnings, ik: result.ikReport };
}

/**
 * Compile a spec and write it into the GLB as a clip (replacing a clip of the
 * same name). Returns { buffer, spec, analysis, warnings }.
 */
export function bakeSpec(buffer, rig, description, rawSpec, { base = null } = {}) {
  const { spec, errors, warnings } = normalizeSpec(rawSpec);
  if (errors.length) throw new Error(`The spec is invalid:\n- ${errors.join('\n- ')}`);
  const ctx = createPoseContext(rig, description);
  const compiled = compileSpec(ctx, spec, { base });
  const analysis = analyzeMotion(ctx, compiled);
  const out = writeClip(buffer, rig, compiled.clip, { spec });
  return { buffer: out, spec, analysis, warnings: [...warnings, ...compiled.warnings] };
}

export function deleteClip(buffer, name) {
  return removeClip(buffer, name);
}

/** describeRig output trimmed for an agent: chains always, bones on request. */
export function summarizeDescription(description, { bones = false } = {}) {
  const out = {
    bodyPlan: description.bodyPlan,
    frame: {
      forward: description.frame.forward,
      up: description.frame.up,
      left: description.frame.left,
      how: `${description.frame.forwardReason}; ${description.frame.headReason}`.replace(/; $/, '')
    },
    size: description.size,
    chains: description.chains.map(c => ({
      label: c.label,
      kind: c.kind,
      side: c.side,
      bones: c.bones,
      attach: c.attach,
      ...(c.mirror ? { mirror: c.mirror } : {}),
      ...(c.contact ? { contact: true } : {}),
      length: c.length,
      tip: c.tip
    })),
    notes: description.notes
  };
  if (bones) {
    out.bones = description.bones.map(b => ({
      name: b.name, parent: b.parent, chain: b.chain, position: b.position, length: b.length,
      weightedVertices: b.weightedVertices, ...(b.mirror ? { mirror: b.mirror } : {})
    }));
    out.positionAxes = 'position = [forward, up, left] in model units from the ground point under the body centre';
  }
  return out;
}

/**
 * Build the retargeted base a spec plays on. `source` is { rig, description }
 * of the rig the clip lives on (a library species or another asset), `base`
 * the spec's base block. Returns { sample, duration, report }.
 */
export function buildBase(target, source, base, { loop = false } = {}) {
  const clips = listClipsInJson(source.rig.json);
  const wanted = String(base.clip).toLowerCase();
  const clip = clips.find(c => c.name === base.clip) || clips.find(c => c.name.toLowerCase() === wanted);
  if (!clip) throw new Error(`The source has no clip "${base.clip}". Its clips: ${clips.map(c => c.name).join(', ')}.`);
  const sampler = clipSampler(source.rig, clip.index);
  const { mapping, chains, unmatched } = mapRigs(source, source.description, target, target.description, base);
  if (!mapping.size) throw new Error('No chain of this rig matches the source rig - pass base.chainMap, e.g. {"leg_1_L": "leg_front_L"}.');
  const speed = base.speed || 1;
  const offset = base.offset || 0;
  const dur = sampler.duration;
  const poseAt = (t) => {
    let st = t * speed + offset;
    st = loop ? (((st % dur) + dur) % dur) : Math.min(dur, Math.max(0, st));
    return sampler.sample(st);
  };
  const rt = createRetarget(source, source.description, target, target.description, mapping, poseAt, { matchRestPose: base.matchRestPose !== false });
  // Floor alignment (default on): proportions differ, so a borrowed gait can
  // float or sink (a fox walk put a horse 7.7 cm in the air). Measure the
  // lowest point over the clip and shift the body so it touches the floor -
  // one constant, the same "auto-align to floor" the editor applies.
  let groundShift = 0;
  if (base.groundAlign !== false) {
    const ctx = createPoseContext(target.rig, target.description);
    const scratch = new Float32Array(target.rig.geometry.positions.length);
    const stride = 3 * Math.max(1, Math.floor(target.rig.geometry.vertexCount / 8000));
    let lowest = Infinity;
    for (let k = 0; k < 12; k += 1) {
      const pose = buildPose(ctx, { base: rt.sample((k / 12) * (dur / speed)) }).pose;
      const pos = skinPositions(target.rig, pose, scratch);
      for (let i = 1; i < pos.length; i += stride) if (pos[i] < lowest) lowest = pos[i];
    }
    if (Number.isFinite(lowest)) {
      groundShift = target.description.size.groundY - lowest;
      rt.setGroundOffset(groundShift);
    }
  }
  return {
    sample: rt.sample,
    duration: Math.round((dur / speed) * 1000) / 1000,
    report: {
      sourceClip: clip.name,
      sourceDuration: Math.round(dur * 1000) / 1000,
      chains,
      unmatchedTargetChains: unmatched,
      mappedBones: mapping.size,
      ...(groundShift ? { floorShift: Math.round(groundShift * 1000) / 1000 } : {}),
      ...rt.report
    }
  };
}
