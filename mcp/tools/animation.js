import { z } from 'zod';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { findProjectAsset, createProgressReporter } from '../client.js';
import {
  openRig, renderRigViews, previewSpec, previewStoredClip, previewPose, bakeSpec, deleteClip,
  summarizeDescription, inspectRig, listClipsInJson, listClips, VIEWS,
  buildBase, buildLibraryDocument, MOTION_LIBRARY
} from '../../animation/index.js';
import { renameBones, namingScheme, addBone, splitBone, smoothWeights, rebuildWeights } from '../../animation/rigEdit.js';
import { deformationTest } from '../../animation/inspect.js';
import { readStaticMesh, soupGlb, islandLabels, labelsFromSegmentation, planRigidRig, buildRigidRig, describePlan } from '../../animation/rigid.js';
import * as THREE from 'three';

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
const NAMES = z.union([z.string(), z.array(z.string())]);
const LAYER = z.object({
  type: z.enum(['gait', 'wave', 'oscillate', 'noise', 'spring']).describe(
    'gait = legs stepping with planted feet (walk cycles, any leg count); wave = travelling wave down a chain (slither, tail wag, tentacle); '
    + 'oscillate = periodic swing of one control (wing flap, breathing, nod); noise = smooth loop-safe fidget (idles); '
    + 'spring = follow-through, the chain lags and overshoots behind the motion (tails, ears, antennae).'),
  // gait
  legs: z.union([z.literal('auto'), z.array(z.string())]).optional().describe('gait: leg chains (default "auto" = every leg describe_rig found).'),
  pattern: z.enum(['auto', 'walk', 'trot', 'pace', 'bound', 'gallop', 'alternate', 'tripod', 'wave']).optional()
    .describe('gait: footfall pattern. auto = alternate for 2 legs, walk for 4, tripod for 6/8, wave otherwise.'),
  phases: z.record(z.string(), z.number()).optional().describe('gait: override when each leg starts its stance (0..1 of the step cycle), per leg chain.'),
  stride: z.number().optional().describe('gait: step length in model units (default: what every leg can comfortably reach).'),
  lift: z.number().optional().describe('gait: foot lift height (default 12% of leg length).'),
  duty: z.number().optional().describe('gait: fraction of the cycle a foot is on the ground (0.2-0.95; walk ~0.65, trot 0.5, gallop 0.4).'),
  travel: z.enum(['in_place', 'forward']).optional().describe('gait: in_place (default, loops on the spot; engines add root motion) or forward (the root advances: a root-motion clip).'),
  bob: z.number().optional().describe('gait: body dip per footfall (model units).'),
  sway: z.number().optional().describe('gait: body roll per cycle (degrees).'),
  // wave / spring
  chain: NAMES.optional().describe('wave / spring: chain label(s).'),
  waves: z.number().optional().describe('wave: how many wavelengths fit along the chain (default 1).'),
  falloff: z.enum(['tip', 'even', 'base']).optional().describe('wave: where the amplitude is largest (default tip).'),
  direction: z.enum(['base_to_tip', 'tip_to_base']).optional().describe('wave: which way crests travel (default base_to_tip).'),
  // oscillate / noise
  target: NAMES.optional().describe('oscillate / noise: pose target(s) - same syntax as a key pose ("wing_L", "spine.*", "tail[0]"); "root" with control root.<control> moves the body.'),
  control: z.string().optional().describe('wave / oscillate: which control (forward, up, left, out, turn, pitch, roll, twist; oscillate also root.up etc.).'),
  controls: z.array(z.string()).optional().describe('noise: controls to jitter (default turn, pitch).'),
  amplitude: z.number().optional().describe('wave: peak degrees per bone; oscillate: peak value; noise: typical degrees.'),
  offset: z.number().optional().describe('oscillate: value the swing is centred on.'),
  shape: z.enum(['sine', 'flap', 'pulse']).optional().describe('oscillate: flap = fast power stroke, slow recovery.'),
  speed: z.number().optional().describe('noise: how busy (whole number of slow cycles per layer).'),
  seed: z.number().optional().describe('noise: variation seed.'),
  stiffness: z.number().optional().describe('spring: 0.02-1, lower = floppier (default 0.25).'),
  damping: z.number().optional().describe('spring: 0-0.95, higher = less overshoot (default 0.3).'),
  // shared
  cycles: z.number().optional().describe('Periodic layers: cycles over the layer (whole numbers keep a loop seamless; default 1).'),
  phase: z.number().optional().describe('wave / oscillate: phase offset as a fraction of a cycle.'),
  weight: z.number().optional().describe('Scale this layer (default 1).'),
  start: z.number().optional().describe('Seconds the layer starts (default 0).'),
  end: z.number().optional().describe('Seconds the layer ends (default the duration).'),
  fade: z.number().optional().describe('Seconds to blend in/out at start/end.')
}).passthrough();
const SPEC = z.object({
  name: z.string().min(1).max(80).describe('Clip name, e.g. "walk", "attack", "idle". Saving replaces a clip of the same name.'),
  duration: z.number().positive().max(60).optional().describe('Seconds. Required unless a base clip is given (then it defaults to the base clip length).'),
  fps: z.number().int().min(1).max(120).default(30).optional(),
  loop: z.boolean().default(false).optional().describe('Wrap the motion so the end flows into the start (cycles: walk, idle, flap).'),
  interpolation: z.enum(['smooth', 'linear']).default('smooth').optional(),
  description: z.string().max(500).optional(),
  keys: z.array(KEY).optional().describe('Sparse keyframes: each key lists only what is set at that time; every (target, control) is interpolated over the keys that mention it, and stays at rest if none do. Optional when layers are given.'),
  base: z.object({
    library: z.string().optional().describe('A motion-library species (list_motion_library): human, fox, horse, bird, dragon, kaiju, shark, snake, spider.'),
    assetId: z.number().int().optional().describe('Or another mesh asset (same project) whose clip to borrow.'),
    clip: z.string().describe('Clip name in that source.'),
    chainMap: z.record(z.string(), z.string()).optional().describe('Target chain -> source chain, where the automatic pairing (same label, else same kind/side/order) is wrong. Map to "" to leave a chain at rest.'),
    boneMap: z.record(z.string(), z.string()).optional().describe('Target bone -> source bone overrides.'),
    matchRestPose: z.boolean().optional().describe('Swing limbs/tails onto the source rest directions first (default true) so a different rest stance does not carry into the motion.'),
    groundAlign: z.boolean().optional().describe('Shift the body so the clip touches the floor (default true).'),
    speed: z.number().optional().describe('Playback rate of the source clip (default 1).'),
    offset: z.number().optional().describe('Seconds into the source clip to start.')
  }).passthrough().optional().describe('RETARGET: play an existing clip from another rig on this one, matched by body chains (works across species), then add keys/layers on top.'),
  layers: z.array(LAYER).optional().describe('Procedural motion ADDED on top of the keys, evaluated every frame. Prefer a gait layer over hand-keyed steps, a wave over keyed tail swings. Keys hold the acting (poses, accents); layers hold the cycles.')
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
  return { asset, buffer, profile, rig, description, metadata: await readMetadata(api, assetId) };
}

async function readMetadata(api, assetId) {
  try {
    const record = await api.apiJson('GET', '/assets/record', { query: { assetId } });
    return typeof record?.metadata === 'string' ? JSON.parse(record.metadata || '{}') : (record?.metadata || {});
  } catch {
    return {};
  }
}

// Save a rig edit as a new version and carry the rig profile across. The
// editor save copies metadata, but a renamed bone must also be renamed in the
// profile and in stored bone mappings, or both silently stop matching.
async function saveRigEdit(api, notifyMutation, projectId, loaded, buffer, { saveMode = 'version', name, rename = null } = {}) {
  const { asset, profile, metadata } = loaded;
  let boneMappings = null;
  let nextProfile = profile;
  if (rename && rename.size) {
    if (metadata?.boneMappings && typeof metadata.boneMappings === 'object') {
      boneMappings = {};
      for (const [source, mapping] of Object.entries(metadata.boneMappings)) {
        boneMappings[source] = Object.fromEntries(Object.entries(mapping || {}).map(([target, src]) => [rename.get(target) || target, src]));
      }
    }
    if (profile?.boneChains) {
      nextProfile = { ...profile, boneChains: Object.fromEntries(Object.entries(profile.boneChains).map(([b, c]) => [rename.get(b) || b, c])) };
    }
  }
  const saved = await saveVersion(api, asset, buffer, { saveMode, name, boneMappings });
  const savedId = saved?.id ?? saved?.asset?.id ?? asset.id;
  if (nextProfile && nextProfile !== profile) {
    await api.apiJson('PUT', `/assets/${savedId}/rig-profile`, { body: { rigProfile: nextProfile } });
  }
  notifyMutation(projectId);
  return savedId;
}

function deformationSummary(rig, description) {
  const d = deformationTest(rig, description);
  return {
    jointsTested: d.tested,
    problems: d.problems.length,
    worst: d.problems.slice(0, 4).map(p => ({ bone: p.bone, chain: p.chain, severity: p.severity }))
  };
}

const SAVE = {
  saveMode: z.enum(['version', 'replace']).default('version').optional().describe('"version" (default) adds a new version; "replace" overwrites this asset\'s file.'),
  name: z.string().optional().describe('Display name for the saved version.')
};

async function saveVersion(api, asset, buffer, { saveMode = 'version', name, boneMappings } = {}) {
  const form = new FormData();
  form.append('assetId', String(asset.id));
  form.append('filePath', '');
  form.append('name', name || asset.name || 'Mesh');
  form.append('saveMode', saveMode);
  if (boneMappings) form.append('boneMappings', JSON.stringify(boneMappings));
  form.append('meshFile', new Blob([buffer], { type: 'model/gltf-binary' }), 'mesh.glb');
  return api.apiForm('POST', '/meshes/editor/save', form);
}

const libraryCache = new Map();
async function loadLibrarySpecies(api, species) {
  const files = MOTION_LIBRARY[species];
  if (!files) throw new Error(`Unknown motion-library species "${species}". Available: ${Object.keys(MOTION_LIBRARY).join(', ')}.`);
  const out = [];
  for (const file of files) {
    if (!libraryCache.has(file)) {
      const res = await fetch(`${api.base}/resources/animations/${file}`);
      if (!res.ok) throw new Error(`Could not load the motion library file ${file} (HTTP ${res.status}).`);
      libraryCache.set(file, openRig(Buffer.from(await res.arrayBuffer())));
    }
    out.push(libraryCache.get(file));
  }
  return out;
}

// Resolve a spec's `base` (retarget source) against the loaded target. Fills
// the spec duration from the base clip when none was given. Returns
// { spec, base: {sample,...} | null, report }.
async function resolveSpecBase(api, projectId, loaded, rawSpec) {
  if (!rawSpec || !rawSpec.base) return { spec: rawSpec, base: null, report: null };
  const b = rawSpec.base;
  let source = null;
  if (b.library) {
    const rigs = await loadLibrarySpecies(api, String(b.library));
    const want = String(b.clip || '').toLowerCase();
    source = rigs.find(r => listClipsInJson(r.rig.json).some(c => c.name.toLowerCase() === want)) || rigs[0];
  } else if (b.assetId) {
    const other = await loadRigged(api, projectId, Number(b.assetId));
    source = { rig: other.rig, description: other.description };
  } else {
    throw new Error('base needs "library" (a species) or "assetId", plus "clip".');
  }
  const built = buildBase({ rig: loaded.rig, description: loaded.description }, source, b, { loop: Boolean(rawSpec.loop) });
  const spec = { ...rawSpec, duration: rawSpec.duration ?? built.duration };
  return { spec, base: built, report: built.report };
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

export function registerAnimationTools(mcpServer, { api, notifyMutation, agentRunId }) {
  // When an in-app "Animate with AI" run drives these tools through a CLI
  // agent (Claude Code over HTTP, Codex over stdio), mirror what the user
  // should SEE - preview images and new versions - into that run's stream.
  // Best effort: a failed mirror never fails the tool.
  const mirror = (payload) => {
    if (!agentRunId) return;
    api.apiJson('POST', `/agent/runs/${agentRunId}/artifacts`, { body: payload }).catch(() => {});
  };
  const server = {
    registerTool(name, def, handler) {
      return mcpServer.registerTool(name, def, async (args, extra) => {
        const result = await handler(args, extra);
        if (agentRunId && result && !result.isError) {
          for (const block of result.content || []) {
            if (block.type === 'image') mirror({ type: 'image', tool: name, data: block.data, mimeType: block.mimeType });
            else if (block.type === 'text') {
              try {
                const data = JSON.parse(block.text);
                if (data?.assetId && data?.sourceAssetId && data.assetId !== data.sourceAssetId) {
                  mirror({ type: 'asset', tool: name, assetId: data.assetId, sourceAssetId: data.sourceAssetId, clip: data.clip || null });
                }
              } catch { /* not JSON */ }
            }
          }
        }
        return result;
      });
    }
  };

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
      + '(a leg pulling the other leg), left/right limbs that do not mirror at rest, bone names that contradict where the bone sits, helper bones, and a '
      + 'DEFORMATION test (each limb/neck/tail joint is bent 45 degrees and limbs twisted; triangles that stretch or fold badly mean the weights are too sharp there). '
      + 'Each issue has a severity and, when one exists, the tool that fixes it (fixTool/fixArgs). Read-only.',
    inputSchema: {
      ...LOCATE,
      deformation: z.boolean().default(true).optional().describe('Run the bend/twist deformation test (a second or so on big meshes).')
    },
    annotations: { readOnlyHint: true }
  }, guarded(async ({ projectId, assetId, deformation = true }) => {
    const { asset, rig, description } = await loadRigged(api, projectId, assetId);
    const report = inspectRig(rig, description, { deformation });
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

  server.registerTool('rig_rigid_parts', {
    title: 'Rig a robot / mechanical mesh by its parts',
    description: 'Build a skeleton for an UNRIGGED mesh made of rigid parts (robots, mechs, turrets, vehicles, armour) - no GPU, no learned weights: every '
      + 'vertex belongs to one part, joints sit where parts touch, the biggest part is the root, each part hangs from the neighbour it touches most. '
      + 'method "islands" uses the mesh\'s separate pieces (how robots are usually modelled; specks under minPart join the part they sit on). '
      + 'method "segment" splits a FUSED mesh with Smart Segmentation (needs the Python mesh-tools service) into `parts` pieces. '
      + 'Returns the part tree (id, parent, size share, pivot) so you can check it; fix wrong parents with reparent {childId: parentId} and run again. '
      + 'Then describe_rig labels it like any rig. For organic creatures use auto_rig_mesh instead. Saves a new version.',
    inputSchema: {
      ...LOCATE,
      method: z.enum(['islands', 'segment']).default('islands').optional(),
      parts: z.number().int().min(2).max(64).optional().describe('segment: how many parts (default: the segmenter\'s suggestion).'),
      minPart: z.number().min(0).max(0.2).optional().describe('Pieces smaller than this share of the surface join their neighbour (default 0.01).'),
      reparent: z.record(z.string(), z.number().int()).optional().describe('Corrections from a previous run: { "<partId>": <parentPartId> }.'),
      names: z.record(z.string(), z.string()).optional().describe('Bone names per part id, e.g. {"0": "body", "3": "arm_upper_L"} (default body / part_<id>).'),
      ...SAVE
    }
  }, guarded(async ({ projectId, assetId, method = 'islands', parts, minPart = 0.01, reparent, names, saveMode = 'version', name }, extra) => {
    const reportProgress = createProgressReporter(extra);
    const asset = await findProjectAsset(api, projectId, assetId);
    const file = asset.filename || asset.filePath;
    if (!/\.glb$/i.test(String(file))) throw new Error('rig_rigid_parts reads GLB meshes.');
    const buffer = Buffer.from(await api.fetchAssetBuffer(file));
    const mesh = readStaticMesh(buffer);
    let labels;
    let segmentNote = null;
    if (method === 'segment') {
      await reportProgress(10, 100, 'Segmenting (mesh-tools service)');
      const form = new FormData();
      form.append('meshFile', new Blob([soupGlb(mesh)], { type: 'model/gltf-binary' }), 'parts.glb');
      form.append('options', JSON.stringify({}));
      const done = await api.apiFormSse('/meshes/segment', form, () => {});
      const decode = (b64) => { const b = Buffer.from(String(b64 || ''), 'base64'); return new Int32Array(b.buffer, b.byteOffset, b.byteLength >> 2); };
      const seg = { history: decode(done.history_b64), mapping: decode(done.mapping_b64), proxyFaceCount: done.proxyFaceCount, faceCount: done.faceCount };
      if (seg.faceCount !== mesh.triCount) throw new Error(`The segmenter saw ${seg.faceCount} faces, the mesh has ${mesh.triCount}; cannot map its parts back.`);
      // `parts` means SIGNIFICANT parts. The merge hierarchy often splits off
      // slivers first (a gun at 6 segments: one piece held 99% of the faces),
      // so raise the level until that many pieces survive the speck filter.
      const want = parts ?? Math.max(3, done.suggestedParts ?? 6);
      const significant = (l) => {
        const counts = new Map();
        for (const x of l) counts.set(x, (counts.get(x) || 0) + 1);
        return [...counts.values()].filter(c => c >= minPart * l.length).length;
      };
      let k = want;
      labels = labelsFromSegmentation(seg, k);
      while (significant(labels) < want && k < seg.proxyFaceCount / 2) {
        k = Math.ceil(k * 1.5);
        labels = labelsFromSegmentation(seg, k);
      }
      segmentNote = { partsRequested: want, segmentLevel: k, significantParts: significant(labels), suggestedParts: done.suggestedParts ?? null };
    } else {
      labels = islandLabels(mesh);
    }
    await reportProgress(50, 100, 'Building the part tree');
    const plan = planRigidRig(mesh, labels, { minPart, reparent: reparent || {} });
    if (plan.parts.length < 2) {
      throw new Error(method === 'islands'
        ? 'The mesh is one piece, so there are no parts to hinge. Use method "segment" (Smart Segmentation) to split it, or auto_rig_mesh for an organic shape.'
        : 'Segmentation produced a single part - ask for more parts.');
    }
    const partNames = names ? Object.fromEntries(Object.entries(names).map(([k2, v]) => [Number(k2), v])) : null;
    const built = buildRigidRig(mesh, plan, { names: partNames });
    await reportProgress(80, 100, 'Saving');
    const saved = await saveVersion(api, asset, built.buffer, { saveMode, name });
    notifyMutation(projectId);
    return textResult({
      sourceAssetId: asset.id,
      assetId: saved?.id ?? saved?.asset?.id ?? asset.id,
      method,
      ...(segmentNote ? { segmentation: segmentNote } : {}),
      parts: describePlan(plan),
      joints: built.joints,
      next: 'describe_rig to see how it reads as a body; reparent / names and run again to correct the tree.'
    });
  }));

  server.registerTool('rename_bones', {
    title: 'Rename the bones of a rig',
    description: 'Rename bones so names match what they are. scheme "semantic" names every bone after its chain (tail_1, leg_front_L_2, head_1) - readable and '
      + 'stable; "mixamo" gives a humanoid biped the Mixamo names (Hips, LeftUpLeg, RightHandIndex1...) so name-based retargeting and engine humanoid setup work; '
      + '"map" applies your own {old: new} map. Stored specs, the rig profile and saved bone mappings are updated to the new names. Saves a new version.',
    inputSchema: {
      ...LOCATE,
      scheme: z.enum(['semantic', 'mixamo', 'map']).describe('Naming scheme.'),
      map: z.record(z.string(), z.string()).optional().describe('scheme "map": old bone name -> new name.'),
      prefix: z.string().optional().describe('scheme "mixamo": name prefix (default "mixamorig:").'),
      ...SAVE
    }
  }, guarded(async ({ projectId, assetId, scheme, map, prefix, saveMode, name }) => {
    const loaded = await loadRigged(api, projectId, assetId);
    const plan = scheme === 'map' ? (map || {}) : namingScheme(loaded.rig, loaded.description, scheme, prefix === undefined ? {} : { prefix });
    if (!Object.keys(plan).length) return textResult({ assetId: loaded.asset.id, renamed: 0, note: 'Every bone already has that name.' });
    const result = renameBones(loaded.buffer, plan);
    const savedId = await saveRigEdit(api, notifyMutation, projectId, loaded, result.buffer, { saveMode, name, rename: new Map(result.renamed) });
    return textResult({ sourceAssetId: loaded.asset.id, assetId: savedId, renamed: result.renamed.length, sample: result.renamed.slice(0, 12).map(([a, b]) => `${a} -> ${b}`) });
  }));

  server.registerTool('add_bone', {
    title: 'Add a bone to a rig',
    description: 'Add a child bone - a tail tip, a jaw, an antenna, a finger the rig is missing. Place it with `position` (offset from the PARENT joint in body axes, '
      + 'model units) or `extend` (continue the parent bone direction by this fraction of its length). With takeWeights (default) the parent hands the new bone '
      + 'the vertices that lie beyond it, blended smoothly, so the bone moves something right away. Chain labels update on the next describe_rig. Saves a new version.',
    inputSchema: {
      ...LOCATE,
      parent: z.string().describe('Exact name of the parent bone (describe_rig with bones:true lists them).'),
      name: z.string().optional().describe('Name for the new bone (default <parent>_child).'),
      position: OFFSET.optional().describe('Offset from the parent joint: {forward, up, left} in model units.'),
      extend: z.number().optional().describe('Continue the parent bone direction by this fraction of its length (e.g. 0.6). Used when position is not given.'),
      takeWeights: z.boolean().default(true).optional(),
      ...SAVE
    }
  }, guarded(async ({ projectId, assetId, parent, name: boneName, position, extend, takeWeights = true, saveMode, name }) => {
    const loaded = await loadRigged(api, projectId, assetId);
    const { rig, description } = loaded;
    const pj = rig.jointByName.get(parent);
    if (pj === undefined) throw new Error(`No bone named "${parent}". describe_rig with bones:true lists them.`);
    const v = description.frame.vectors;
    const restPos = j => new THREE.Vector3().setFromMatrixPosition(rig.inverseBind[j].clone().invert());
    const origin = restPos(pj);
    let target;
    if (position) {
      target = origin.clone()
        .addScaledVector(new THREE.Vector3().fromArray(v.forward), Number(position.forward) || 0)
        .addScaledVector(new THREE.Vector3().fromArray(v.up), Number(position.up) || 0)
        .addScaledVector(new THREE.Vector3().fromArray(v.left), Number(position.left) || 0);
    } else {
      const gp = rig.joints[pj].parent;
      if (gp < 0) throw new Error('The parent is a root bone with no direction to extend - give a position instead.');
      const dir = origin.clone().sub(restPos(gp));
      target = origin.clone().addScaledVector(dir, extend === undefined ? 0.6 : Number(extend));
    }
    if (target.distanceTo(origin) < 1e-6) throw new Error('The new bone would sit on its parent joint - give a position or extend > 0.');
    const result = addBone(loaded.buffer, { parent, name: boneName, position: target, takeWeights });
    const savedId = await saveRigEdit(api, notifyMutation, projectId, loaded, result.buffer, { saveMode, name });
    return textResult({
      sourceAssetId: loaded.asset.id, assetId: savedId, added: result.name, verticesTakenFromParent: result.moved,
      ...(takeWeights && !result.moved ? { note: 'No vertex of the parent lies beyond the new bone, so it moves nothing yet. Place it further out, or rebind_weights mode "rebuild".' } : {})
    });
  }));

  server.registerTool('split_bone', {
    title: 'Split a bone into several',
    description: 'Split one bone into `parts` bones along the line to its child, spreading its weights along them - a one-bone tail or neck becomes a bendable chain. '
      + 'The child keeps its world position (it is re-parented under the last new bone). Saves a new version.',
    inputSchema: {
      ...LOCATE,
      bone: z.string().describe('Exact name of the bone to split.'),
      parts: z.number().int().min(2).max(8).default(2).optional(),
      child: z.string().optional().describe('Which child to split toward when the bone has several (default: the farthest).'),
      ...SAVE
    }
  }, guarded(async ({ projectId, assetId, bone, parts = 2, child, saveMode, name }) => {
    const loaded = await loadRigged(api, projectId, assetId);
    const result = splitBone(loaded.buffer, { bone, parts, child: child ?? null });
    const savedId = await saveRigEdit(api, notifyMutation, projectId, loaded, result.buffer, { saveMode, name });
    return textResult({ sourceAssetId: loaded.asset.id, assetId: savedId, added: result.added, child: result.child, verticesReweighted: result.moved });
  }));

  server.registerTool('rebind_weights', {
    title: 'Fix or rebuild skin weights',
    description: 'Repair the skin weights while keeping the skeleton. mode "smooth" blurs the existing weights over the surface (fixes the pinching/stretching that '
      + 'the inspect_rig deformation test reports; pass bones to limit it). mode "rebuild" recomputes every weight from the bones: each vertex goes to the nearest bones '
      + 'it can see, never to a limb on the other side of the body, then smoothed - use it when weights leak across the body or after add_bone/split_bone. '
      + 'No GPU or service needed. Returns the deformation test before and after. Saves a new version.',
    inputSchema: {
      ...LOCATE,
      mode: z.enum(['smooth', 'rebuild']),
      bones: z.array(z.string()).optional().describe('smooth: only vertices these bones touch.'),
      iterations: z.number().int().min(1).max(20).optional().describe('Smoothing passes (smooth default 3, rebuild default 12).'),
      strength: z.number().min(0.05).max(1).optional().describe('smooth: how far each pass blends toward the neighbours (default 0.5).'),
      exclude: z.array(z.string()).optional().describe('rebuild: bones that must get no weight (helpers, end markers).'),
      ...SAVE
    }
  }, guarded(async ({ projectId, assetId, mode, bones, iterations, strength, exclude, saveMode, name }, extra) => {
    const reportProgress = createProgressReporter(extra);
    const loaded = await loadRigged(api, projectId, assetId);
    const before = deformationSummary(loaded.rig, loaded.description);
    await reportProgress(20, 100, mode === 'rebuild' ? 'Rebuilding weights' : 'Smoothing weights');
    const result = mode === 'smooth'
      ? smoothWeights(loaded.buffer, { iterations: iterations ?? 3, strength: strength ?? 0.5, bones: bones && bones.length ? bones : null })
      : rebuildWeights(loaded.buffer, { smoothing: iterations ?? 12, exclude: exclude || [], description: loaded.description });
    const reopened = openRig(result.buffer, loaded.profile);
    const after = deformationSummary(reopened.rig, reopened.description);
    const leaks = inspectRig(reopened.rig, reopened.description, { deformation: false }).issues.filter(i => i.check === 'weights').map(i => i.message);
    await reportProgress(80, 100, 'Saving');
    const savedId = await saveRigEdit(api, notifyMutation, projectId, loaded, result.buffer, { saveMode, name });
    return textResult({
      sourceAssetId: loaded.asset.id, assetId: savedId, mode,
      deformationBefore: before,
      deformationAfter: after,
      weightIssuesAfter: leaks,
      ...(result.note ? { note: result.note } : {}),
      ...(result.skipped?.length ? { untouchedPrimitives: result.skipped } : {})
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
    const resolved = await resolveSpecBase(api, projectId, { rig, description }, spec);
    const r = previewSpec(rig, description, resolved.spec, options, { base: resolved.base });
    return imageResult(r.png, {
      assetId: asset.id,
      clip: r.spec.name,
      duration: r.spec.duration,
      framesShownAt: r.frames,
      ...(resolved.report ? { retarget: resolved.report } : {}),
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
    const resolved = await resolveSpecBase(api, projectId, { rig, description }, spec);
    const baked = bakeSpec(buffer, rig, description, resolved.spec, { base: resolved.base });
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
      ...(resolved.report ? { retarget: resolved.report } : {}),
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

  server.registerTool('list_motion_library', {
    title: 'List the reference motion library',
    description: 'List the bundled reference clips (mesh2motion, MIT) that a spec can borrow as its `base`: species human, fox, horse, bird, dragon, kaiju, '
      + 'shark, snake, spider, each with its clips and durations, plus the chains its skeleton has (so you can see how it will pair with your rig). '
      + 'Retargeting is by body chains, so a species need not match your creature exactly - a fox walk drives any quadruped, a kaiju clip any big biped with a tail.',
    inputSchema: {
      species: z.string().optional().describe('Only this species (default: all, clip names only).')
    },
    annotations: { readOnlyHint: true }
  }, guarded(async ({ species }) => {
    const names = species ? [species] : Object.keys(MOTION_LIBRARY);
    const out = [];
    for (const name of names) {
      const rigs = await loadLibrarySpecies(api, name);
      const clips = rigs.flatMap(r => listClipsInJson(r.rig.json).map(c => (species ? { name: c.name, duration: c.duration } : c.name)));
      out.push({
        species: name,
        bodyPlan: rigs[0].description.bodyPlan,
        clips,
        ...(species ? { chains: rigs[0].description.chains.filter(c => !['helper', 'extra', 'part'].includes(c.kind)).map(c => c.label) } : {})
      });
    }
    return textResult({ library: out });
  }));

  server.registerTool('publish_animation', {
    title: 'Save a clip to the animation library',
    description: 'Save one clip of a mesh (authored, retargeted or imported) to the app\'s custom animation library, with the skeleton it was made on. It then '
      + 'appears in the Mesh Editor Custom tab and can be applied to any other rigged mesh there. Does not change the mesh.',
    inputSchema: {
      ...LOCATE,
      clip: z.string().describe('Clip name in the mesh (list_animations).'),
      name: z.string().optional().describe('Library name (default: "<mesh> - <clip>").')
    }
  }, guarded(async ({ projectId, assetId, clip, name }) => {
    const { asset, rig } = await loadRigged(api, projectId, assetId);
    const clips = listClipsInJson(rig.json);
    const found = clips.find(c => c.name === clip);
    if (!found) throw new Error(`No clip named "${clip}". This mesh has: ${clips.map(c => c.name).join(', ') || 'none'}.`);
    const doc = buildLibraryDocument(rig, found.index);
    const libraryName = (name || `${asset.name || 'Mesh'} - ${clip}`).slice(0, 120);
    const saved = await api.apiJson('POST', '/animations/library', {
      body: { name: libraryName, data: doc, sourceMesh: asset.name || '', sourceClip: clip, rigKey: doc.rigKey }
    });
    return textResult({ libraryId: saved?.animation?.id, name: libraryName, rigKey: doc.rigKey, bones: doc.bones.length, frames: doc.frameCount });
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
