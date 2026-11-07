import { z } from 'zod';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { findProjectAsset, createProgressReporter } from '../client.js';
import {
  openRig, renderRigViews, previewSpec, previewStoredClip, previewPose, bakeSpec, deleteClip,
  summarizeDescription, inspectRig, listClipsInJson, listClips, VIEWS
} from '../../animation/index.js';

// "Animate with AI": let an agent animate ANY rigged mesh - robots, monsters,
// spiders, dragons - not just humanoids.
//
// THE CONTRACT. The agent never writes bone quaternions. It (1) reads the rig
// as a BODY (describe_rig: chains like leg_front_L / tail / wing_R, a facing,
// a size), (2) writes a SPEC - sparse keyframes of body-relative controls
// ("leg_front_L": {"forward": 25}, "tail.*": {"left": 40}, root, IK targets) -
// and (3) LOOKS at it (preview_animation renders a filmstrip and measures foot
// sliding, floor penetration, pops) before save_animation bakes it into the
// GLB. Everything runs in the Node backend: no GPU, no service.
//
// Rig corrections (facing, chain names, which bones are feet) live in the
// asset's metadata as a rig profile (annotate_rig) and survive saves.

const CONTROL_FIELDS = {
  forward: z.number().optional().describe('Swing the bone tip toward the body\'s FRONT (deg; negative = back).'),
  up: z.number().optional().describe('Swing the tip UP (deg; negative = down).'),
  left: z.number().optional().describe('Swing the tip toward the body\'s LEFT (deg; negative = right).'),
  out: z.number().optional().describe('Swing the tip AWAY from the mid line (deg) - the same value mirrors on _L and _R chains.'),
  turn: z.number().optional().describe('Rotate about the body\'s up axis at this joint (deg; positive = toward its left). Heads, spines.'),
  pitch: z.number().optional().describe('Rotate about the body\'s side axis (deg; positive = nose/tip up).'),
  roll: z.number().optional().describe('Rotate about the body\'s forward axis (deg; positive = its left side up).'),
  twist: z.number().optional().describe('Rotate about the bone\'s own axis (deg).')
};
// passthrough, so an unknown control reaches normalizeSpec and is REPORTED
// (zod would otherwise strip it silently and the agent never learns).
const CONTROLS = z.object(CONTROL_FIELDS).passthrough();
const OFFSET = z.object({
  forward: z.number().optional(),
  up: z.number().optional(),
  left: z.number().optional()
});
const ROOT = z.object({
  forward: z.number().optional().describe('Move the whole body forward (model units, metres).'),
  up: z.number().optional().describe('Raise the whole body (model units).'),
  left: z.number().optional().describe('Move the whole body to its left (model units).'),
  turn: z.number().optional().describe('Turn the whole body toward its left (deg).'),
  pitch: z.number().optional().describe('Tilt the whole body nose-up (deg), about the skeleton root.'),
  roll: z.number().optional().describe('Roll the whole body, left side up (deg).')
});
const POSE = z.record(z.string(), CONTROLS).describe(
  'Pose targets -> controls. A target is a chain label from describe_rig ("leg_front_L" swings the WHOLE chain from its base), '
  + '"chain.*" (spread the angle over every bone of the chain - curls a tail, arches a spine), "chain[i]" (one bone; 0 = base, -1 = tip) '
  + 'or an exact bone name. All angles are RELATIVE TO REST and inherited down the hierarchy.'
);
const IK = z.record(z.string(), OFFSET).describe(
  'Chain label -> where its TIP goes, as an offset (model units, body axes) from the tip\'s REST position, FIXED IN THE WORLD. '
  + 'A chain listed in any key is solved on every frame, so {} plants a foot while the root moves. Knees keep their rest bend direction.'
);
const KEY = z.object({
  time: z.number().min(0).describe('Seconds from the start.'),
  pose: POSE.optional(),
  root: ROOT.optional(),
  ik: IK.optional()
}).passthrough();
const SPEC = z.object({
  name: z.string().min(1).max(80).describe('Clip name, e.g. "walk", "attack", "idle". Saving replaces a clip of the same name.'),
  duration: z.number().positive().max(60).describe('Seconds.'),
  fps: z.number().int().min(1).max(120).default(30).optional(),
  loop: z.boolean().default(false).optional().describe('Wrap the motion so the end flows into the start (cycles: walk, idle, flap).'),
  interpolation: z.enum(['smooth', 'linear']).default('smooth').optional(),
  description: z.string().max(500).optional(),
  keys: z.array(KEY).min(1).describe('Sparse keyframes: each key lists only what is set at that time; every (target, control) is interpolated over the keys that mention it, and stays at rest if none do.')
});

const VIEW = z.enum(VIEWS);
const LOCATE = {
  projectId: z.number().int(),
  assetId: z.number().int().describe('Rigged mesh asset id (a mesh version id works too).')
};

async function loadRigged(api, projectId, assetId) {
  const asset = await findProjectAsset(api, projectId, assetId);
  const file = asset.filename || asset.filePath;
  if (!/\.glb$/i.test(String(file))) {
    throw new Error(`Asset ${assetId} is ${path.extname(String(file)) || 'not a file'}; the animation tools read GLB meshes. Convert it first (the Mesh Editor saves GLB).`);
  }
  const buffer = Buffer.from(await api.fetchAssetBuffer(file));
  let profile = null;
  try {
    const record = await api.apiJson('GET', '/assets/record', { query: { assetId } });
    const meta = typeof record?.metadata === 'string' ? JSON.parse(record.metadata || '{}') : (record?.metadata || {});
    profile = meta?.rigProfile || null;
  } catch {
    profile = null;
  }
  const { rig, description } = openRig(buffer, profile);
  return { asset, buffer, profile, rig, description };
}

async function saveVersion(api, asset, buffer, { saveMode = 'version', name } = {}) {
  const form = new FormData();
  form.append('assetId', String(asset.id));
  form.append('filePath', '');
  form.append('name', name || asset.name || 'Mesh');
  form.append('saveMode', saveMode);
  form.append('meshFile', new Blob([buffer], { type: 'model/gltf-binary' }), 'mesh.glb');
  return api.apiForm('POST', '/meshes/editor/save', form);
}

function imageResult(png, payload) {
  return {
    content: [
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(payload, null, 2) }
    ]
  };
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function guarded(fn) {
  return async (args, extra) => {
    try {
      return await fn(args ?? {}, extra);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
    }
  };
}

export function registerAnimationTools(server, { api, notifyMutation }) {
  server.registerTool('describe_rig', {
    title: 'Describe a rig as a body',
    description: 'Read a rigged mesh as a BODY you can animate: its body plan (quadruped, 8-legged, winged...), facing (forward/up/left axes), size, and CHAINS - '
      + 'labelled bone groups like spine, neck, head, tail, leg_front_L, wing_R, with mirror partners and which ones touch the ground. '
      + 'Labels come from GEOMETRY, not bone names, so they work on any rig. Returns an image with each chain in its own colour (legend in the text) - '
      + 'CHECK IT before posing: if a label or the facing is wrong, fix it with annotate_rig. Chain labels are the targets a spec poses. '
      + 'Also lists the clips already in the file. Read-only.',
    inputSchema: {
      ...LOCATE,
      bones: z.boolean().default(false).optional().describe('Also list every bone (name, parent, chain, position). Bigger; only when you need single bones.'),
      image: z.boolean().default(true).optional().describe('Return the colour-coded views.'),
      views: z.array(VIEW).max(4).optional().describe('Views for the image (default front, left, three_quarter, top). "left" = seen from the creature\'s left side.'),
      skeleton: z.boolean().default(false).optional().describe('Draw the bones over the mesh.')
    },
    annotations: { readOnlyHint: true }
  }, guarded(async ({ projectId, assetId, bones = false, image = true, views, skeleton = false }) => {
    const { asset, rig, description, profile } = await loadRigged(api, projectId, assetId);
    const payload = {
      assetId: asset.id,
      assetName: asset.name,
      ...summarizeDescription(description, { bones }),
      clips: listClipsInJson(rig.json).map(c => ({ name: c.name, duration: c.duration, fromSpec: c.hasSpec })),
      rigProfile: profile,
      mesh: { vertices: rig.geometry.vertexCount, triangles: rig.geometry.triangleCount, bones: rig.joints.length }
    };
    if (!image) return textResult(payload);
    const rendered = renderRigViews(rig, description, { views: views && views.length ? views : undefined, skeleton });
    payload.legend = rendered.legend;
    return imageResult(rendered.png, payload);
  }));

  server.registerTool('inspect_rig', {
    title: 'Check a rig before animating',
    description: 'Quality-check a rigged mesh BEFORE animating it: floor/pivot placement, facing, unit scale, unweighted vertices, weights leaking across the body '
      + '(a leg pulling the other leg), left/right limbs that do not mirror at rest, bone names that contradict where the bone sits, helper bones. '
      + 'Each issue has a severity and, when one exists, the tool that fixes it (fixTool/fixArgs). Read-only.',
    inputSchema: LOCATE,
    annotations: { readOnlyHint: true }
  }, guarded(async ({ projectId, assetId }) => {
    const { asset, rig, description } = await loadRigged(api, projectId, assetId);
    const report = inspectRig(rig, description);
    return textResult({ assetId: asset.id, assetName: asset.name, bodyPlan: description.bodyPlan, ...report });
  }));

  server.registerTool('annotate_rig', {
    title: 'Correct the rig analysis',
    description: 'Correct what describe_rig worked out, without re-rigging: the facing, chain labels, which chain a bone belongs to, which chains touch the ground. '
      + 'Stored on the asset (metadata.rigProfile) and carried onto later versions; every animation tool reads it. Fields you omit keep their stored value '
      + 'unless replace is true. Returns the corrected chain list.',
    inputSchema: {
      ...LOCATE,
      forward: z.enum(['+z', '-z', '+x', '-x']).optional().describe('The direction the creature faces, when the automatic guess is wrong.'),
      chainRenames: z.record(z.string(), z.string()).optional().describe('Automatic label -> your label, e.g. {"appendage_1": "jaw", "leg_1_L": "pincer_L"}. Keys are the AUTOMATIC labels.'),
      boneChains: z.record(z.string(), z.string()).optional().describe('Bone name -> chain label, to move single bones into another (or a new) chain.'),
      contacts: z.array(z.string()).optional().describe('Chain labels that touch the ground (used for foot-slide checks). Default: every chain detected as a leg.'),
      notes: z.string().max(2000).optional().describe('Free notes about this rig for the next session (e.g. "the jaw is chain head[1]").'),
      replace: z.boolean().default(false).optional().describe('Replace the whole stored profile instead of merging into it. Pass replace:true with nothing else to clear it.')
    }
  }, guarded(async ({ projectId, assetId, forward, chainRenames, boneChains, contacts, notes, replace = false }) => {
    const { asset, profile } = await loadRigged(api, projectId, assetId);
    const base = replace ? {} : { ...(profile || {}) };
    if (forward !== undefined) base.forward = forward;
    if (chainRenames) base.chainRenames = { ...(base.chainRenames || {}), ...chainRenames };
    if (boneChains) base.boneChains = { ...(base.boneChains || {}), ...boneChains };
    if (contacts) base.contacts = contacts;
    if (notes !== undefined) base.notes = notes;
    const saved = await api.apiJson('PUT', `/assets/${asset.id}/rig-profile`, { body: { rigProfile: base } });
    notifyMutation(projectId);
    const { description } = await loadRigged(api, projectId, assetId);
    return textResult({
      assetId: asset.id,
      rigProfile: saved.rigProfile,
      bodyPlan: description.bodyPlan,
      frame: { forward: description.frame.forward, left: description.frame.left },
      chains: description.chains.map(c => ({ label: c.label, kind: c.kind, side: c.side, bones: c.bones.length, ...(c.contact ? { contact: true } : {}) }))
    });
  }));

  server.registerTool('preview_animation', {
    title: 'Preview a pose or an animation',
    description: 'SEE motion before saving it. Give ONE of: `spec` (an animation spec - compiled and rendered as a filmstrip, with motion checks: '
      + 'floor penetration, foot sliding on contact chains, frame-to-frame pops, loop seam), `pose` (one static pose, rendered from several views - '
      + 'the fastest way to check what a control does), or `clip` (the name of a clip already stored in the mesh). Nothing is saved. '
      + 'Iterate here, then save_animation with the same spec.',
    inputSchema: {
      ...LOCATE,
      spec: SPEC.optional(),
      pose: z.object({ pose: POSE.optional(), root: ROOT.optional(), ik: IK.optional() }).optional()
        .describe('A single pose: the same {pose, root, ik} a spec key holds, without time.'),
      clip: z.string().optional().describe('Name of a clip already in the mesh (see describe_rig clips).'),
      frames: z.number().int().min(1).max(16).default(8).optional().describe('Moments to show, evenly spread from start to end.'),
      views: z.array(VIEW).min(1).max(3).optional().describe('Default: ["left"] for motion, ["front","left","three_quarter"] for a pose. Several views make a row per view.'),
      size: z.number().int().min(128).max(512).default(256).optional().describe('Pixel size of each frame.'),
      skeleton: z.boolean().default(false).optional().describe('Draw the bones (coloured by chain) over the mesh.')
    },
    annotations: { readOnlyHint: true }
  }, guarded(async ({ projectId, assetId, spec, pose, clip, frames = 8, views, size = 256, skeleton = false }, extra) => {
    const given = [spec, pose, clip].filter(v => v !== undefined && v !== null).length;
    if (given !== 1) throw new Error('Give exactly one of spec, pose or clip.');
    const reportProgress = createProgressReporter(extra);
    const { asset, rig, description } = await loadRigged(api, projectId, assetId);
    await reportProgress(30, 100, 'Rendering');
    if (pose) {
      const r = previewPose(rig, description, pose, { views: views && views.length ? views : undefined, size: Math.min(size * 1.2, 512) | 0, skeleton });
      return imageResult(r.png, { assetId: asset.id, warnings: r.warnings, ik: r.ik || undefined });
    }
    const options = { frames, views: views && views.length ? views : ['left'], size, skeleton };
    if (clip) {
      const r = previewStoredClip(rig, description, clip, options);
      return imageResult(r.png, { assetId: asset.id, clip, duration: r.duration, framesShownAt: r.frames });
    }
    const r = previewSpec(rig, description, spec, options);
    return imageResult(r.png, {
      assetId: asset.id,
      clip: r.spec.name,
      duration: r.spec.duration,
      framesShownAt: r.frames,
      checks: r.analysis,
      warnings: r.warnings
    });
  }));

  server.registerTool('save_animation', {
    title: 'Bake an animation into the mesh',
    description: 'Compile a spec and save it INTO the mesh as an animation clip (glTF animation, plays in the Mesh Editor, Blender, Unity, Unreal). '
      + 'A clip with the same name is replaced; other clips are kept. The spec is stored with the clip, so list_animations can return it for later edits. '
      + 'Saves a new VERSION of the mesh by default. Returns the motion checks - preview_animation first.',
    inputSchema: {
      ...LOCATE,
      spec: SPEC,
      saveMode: z.enum(['version', 'replace']).default('version').optional().describe('"version" (default) adds a new version; "replace" overwrites this asset\'s file.'),
      name: z.string().optional().describe('Display name for the saved version (default: the asset\'s name).')
    }
  }, guarded(async ({ projectId, assetId, spec, saveMode = 'version', name }, extra) => {
    const reportProgress = createProgressReporter(extra);
    const { asset, buffer, rig, description } = await loadRigged(api, projectId, assetId);
    await reportProgress(30, 100, 'Compiling');
    const baked = bakeSpec(buffer, rig, description, spec);
    await reportProgress(70, 100, 'Saving');
    const saved = await saveVersion(api, asset, baked.buffer, { saveMode, name });
    notifyMutation(projectId);
    return textResult({
      sourceAssetId: asset.id,
      assetId: saved?.id ?? saved?.asset?.id ?? asset.id,
      saveMode,
      clip: baked.spec.name,
      duration: baked.spec.duration,
      clips: listClips(baked.buffer).map(c => c.name),
      checks: baked.analysis,
      warnings: baked.warnings
    });
  }));

  server.registerTool('list_animations', {
    title: 'List the animations in a mesh',
    description: 'List the clips stored in a mesh (name, duration, whether it was made from a spec). Pass `name` to get that clip\'s full SPEC back - '
      + 'edit it and save_animation again to change the motion. Clips without a spec (imported or retargeted) can be previewed but not edited as a spec.',
    inputSchema: {
      ...LOCATE,
      name: z.string().optional().describe('Return the full spec of this clip.')
    },
    annotations: { readOnlyHint: true }
  }, guarded(async ({ projectId, assetId, name }) => {
    const { asset, rig } = await loadRigged(api, projectId, assetId);
    const clips = listClipsInJson(rig.json);
    if (name) {
      const clip = clips.find(c => c.name === name);
      if (!clip) throw new Error(`No clip named "${name}". This mesh has: ${clips.map(c => c.name).join(', ') || 'none'}.`);
      return textResult({ assetId: asset.id, name: clip.name, duration: clip.duration, spec: clip.spec, note: clip.spec ? undefined : 'This clip was not made from a spec (imported or retargeted), so there is no spec to edit.' });
    }
    return textResult({ assetId: asset.id, clips: clips.map(c => ({ name: c.name, duration: c.duration, fromSpec: c.hasSpec, channels: c.channels })) });
  }));

  server.registerTool('delete_animation', {
    title: 'Remove an animation from a mesh',
    description: 'Remove one clip from a mesh, keeping the others. Saves a new version by default.',
    inputSchema: {
      ...LOCATE,
      name: z.string().describe('Clip to remove.'),
      saveMode: z.enum(['version', 'replace']).default('version').optional()
    },
    annotations: { destructiveHint: true }
  }, guarded(async ({ projectId, assetId, name, saveMode = 'version' }) => {
    const { asset, buffer } = await loadRigged(api, projectId, assetId);
    const { buffer: out, removed } = deleteClip(buffer, name);
    if (!removed) throw new Error(`No clip named "${name}" in this mesh.`);
    const saved = await saveVersion(api, asset, out, { saveMode });
    notifyMutation(projectId);
    return textResult({ sourceAssetId: asset.id, assetId: saved?.id ?? asset.id, removed: name, clips: listClips(out).map(c => c.name) });
  }));
}
