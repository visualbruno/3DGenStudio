import { z } from 'zod';
import { Buffer } from 'node:buffer';
import { toolHandler, createProgressReporter, withAssetUrls } from '../client.js';
import { applyAssetTags, tagsInput } from '../assetTags.js';

// Procedural tree generation, served by the Python mesh-tools service (:8200).
//
// The contract worth understanding before using these: THE TREE IS THE SPEC. A
// ~2KB seeded JSON document regenerates the mesh exactly, so the useful loop is
// generate -> read the spec back -> adjust -> generate again, never "edit the
// mesh". Every result returns the resolved spec including the seed actually
// used, and `save_tree_spec_to_asset` metadata carries it, so any tree can be
// reproduced or re-rolled later without keeping the GLB around.

// Only the parameters worth exposing to an automated caller. The full TreeSpec
// has ~40 fields; a client that needs them can pass `spec` wholesale, and the
// service validates it. These mirror python-server/app/services/treegen/spec.py.
const TREE_OVERRIDES = {
  height: z.number().min(0.02).max(500).optional().describe('Trunk base to crown top, in metres. Every other size is a ratio of this.'),
  crown: z.object({
    shape: z.enum(['ellipsoid', 'sphere', 'hemisphere', 'cone', 'inverted_cone', 'cylinder', 'umbrella', 'custom']).optional()
      .describe('Envelope the branches fill. This is what makes a species readable at a glance.'),
    radius_ratio: z.number().min(0.02).max(3).optional().describe('Crown radius / height.'),
    base_ratio: z.number().min(0).max(0.95).optional().describe('Where the crown starts / height. 0 gives a bush with no clear trunk.'),
    shell_bias: z.number().min(-1).max(1).optional().describe('+1 packs growth into the outer canopy, -1 into the core.')
  }).optional(),
  skeleton: z.object({
    attractors: z.number().int().min(16).max(60000).optional().describe('Attraction points sampled in the crown. Drives branch density and most of the cost.'),
    randomness: z.number().min(0).max(1.5).optional().describe('Per-step direction jitter.'),
    tropism: z.tuple([z.number(), z.number(), z.number()]).optional()
      .describe('Constant growth bias. +Y reaches for light, -Y weeps — this one value is most of what separates an oak from a willow.')
  }).optional(),
  branching: z.object({
    trunk_radius_ratio: z.number().min(0.002).max(0.5).optional().describe('Trunk radius / height.'),
    radius_exponent: z.number().min(1.2).max(4).optional().describe("da Vinci's rule exponent. Lower gives finer twigs."),
    root_flare: z.number().min(0).max(4).optional().describe('Buttress swelling at the base.'),
    max_order: z.number().int().min(1).max(16).optional().describe('Branches deeper than this are culled.')
  }).optional(),
  bark: z.object({
    junction_mode: z.enum(['sink', 'clean']).optional()
      .describe("'sink' (default) is free and hides seams under the texture. 'clean' boolean-unions every branch into one watertight solid — for printing or physics — at ~1s and re-derived UVs."),
    radial_max: z.number().int().min(3).max(64).optional().describe('Radial segments on the trunk.'),
    uv_tile: z.number().min(0.01).max(100).optional().describe('World length mapping to one bark texture tile.')
  }).optional(),
  foliage: z.object({
    enabled: z.boolean().optional(),
    max_cards: z.number().int().min(0).max(200000).optional().describe('Hard cap on leaf cards. Enforced by thinning placements evenly, never by truncating one side.'),
    size_ratio: z.number().min(0.001).max(0.5).optional().describe('Leaf card width / height.'),
    mode: z.enum(['cards', 'clusters']).optional().describe("'clusters' bakes a fan of cards per placement — the only mode that scales."),
    align_ratio: z.number().min(0).max(1).optional().describe('0 = leaf sticking out sideways, 1 = frond running along the branch. Palms need this near 1.')
  }).optional(),
  output: z.object({
    wind_colors: z.boolean().optional().describe('Bake wind data into vertex colours (R branch phase, G stiffness, B leaf flutter, A hierarchy weight). Off by default: glTF treats vertex colour as a base-colour multiplier, so enabling it makes the tree render as a green trunk with confetti foliage in any ordinary viewer. Enable it only for an engine wind shader that reads vertex colour as data.'),
    engine: z.enum(['generic', 'unity', 'unreal', 'godot']).optional().describe('Axis and unit convention.')
  }).optional()
};

// Resolve image assets by id from the GLOBAL library.
//
// There is no GET /api/assets/:id — the listing is the lookup. Trees are not
// project-scoped, so the library listing is also the right place to search:
// a bark texture from one project and a leaf atlas from another is the normal
// case. The listing is fetched ONCE and reused, because a tree can reference
// six images and re-listing 150 assets per texture would be absurd.
async function makeAssetResolver(api) {
  let cache = null;
  return async function resolve(assetId) {
    if (!assetId) return null;
    if (!cache) {
      const library = await api.apiJson('GET', '/assets/library');
      cache = [];
      const visit = asset => {
        if (!asset) return;
        cache.push(asset);
        for (const key of ['edits', 'versions', 'children']) {
          if (Array.isArray(asset[key])) asset[key].forEach(visit);
        }
      };
      for (const group of Object.values(library || {})) {
        if (Array.isArray(group)) group.forEach(visit);
      }
    }
    // Library rows carry the real numeric id as `assetId` next to a prefixed
    // "library:<id>" display id, so match on whichever is present.
    const asset = cache.find(a => Number(a?.assetId) === Number(assetId)
      || String(a?.id) === String(assetId));
    if (!asset) throw new Error(`Image asset ${assetId} not found (use list_assets to find valid ids).`);
    // `filename` is relative to the /assets mount; `filePath` is storage-prefixed.
    // fetchAssetBuffer strips the prefix, but prefer the one that needs no fixing.
    const file = asset.filename || asset.filePath;
    if (!file) throw new Error(`Image asset ${assetId} has no stored file.`);
    const buffer = await api.fetchAssetBuffer(file);
    return buffer.toString('base64');
  };
}

async function saveTreeAsset(api, { projectId, buffer, name, spec, stats }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'model/gltf-binary' }), `${name}.glb`);
  form.append('type', 'mesh');
  form.append('name', name);
  // The spec rides in the asset metadata: that is what makes the saved mesh
  // reproducible and re-rollable rather than a dead end.
  form.append('metadata', JSON.stringify({
    source: 'TREE GENERATOR',
    treeSpec: spec,
    specVersion: spec?.version ?? null,
    preset: spec?.preset ?? null,
    stats: stats ?? null,
    savedAt: Date.now()
  }));

  if (projectId) {
    form.append('projectId', String(projectId));
    return api.apiForm('POST', '/assets/upload', form);
  }
  // No project: the tree generator is a global workspace, so an unowned tree is
  // a normal outcome rather than an error.
  return api.apiForm('POST', '/assets/library-upload', form);
}

export function registerTreeTools(server, { api, notifyMutation }) {
  const treeSource = {
    preset: z.string().optional().describe("Species preset id from list_tree_presets (e.g. 'oak', 'pine', 'palm'). Omit when passing a full spec."),
    spec: z.record(z.string(), z.any()).optional().describe('A complete TreeSpec object, e.g. one read back from a saved tree asset. Takes precedence over `preset`.'),
    seed: z.number().int().min(0).max(2147483647).optional().describe('Re-roll seed. The same seed and spec always reproduce the same mesh byte for byte.'),
    overrides: z.object(TREE_OVERRIDES).optional().describe('Sparse patch applied over the preset or spec. Only the keys you set change.')
  };

  server.registerTool('list_tree_presets', {
    title: 'List tree presets',
    description: 'List the tuned species presets the procedural tree generator ships (oak, pine, birch, poplar, willow, palm, bush, bonsai, sapling, dead). Each entry carries its complete TreeSpec, so you can read a preset, patch it, and pass it back as `spec`. Requires the Python mesh-tools service (:8200) running.',
    inputSchema: {}
  }, toolHandler(() => api.apiJson('GET', '/tree/presets')));

  server.registerTool('preview_tree_skeleton', {
    title: 'Preview tree skeleton',
    description: 'Grow only the branch skeleton for a tree spec and return its polylines, bounds and counts — no mesh. Answers in ~100ms, so use it to iterate on crown shape, density and tropism cheaply before paying for a full generate. Returns the resolved spec too.',
    inputSchema: {
      ...treeSource,
      quality: z.number().min(0.02).max(1).default(0.2).describe('Skeleton resolution. 0.2 answers in ~100ms and reads as the same tree; 1.0 matches exactly what generate_tree would build.')
    }
  }, toolHandler(args => api.apiJson('POST', '/tree/preview', { body: args })));

  server.registerTool('generate_tree', {
    title: 'Generate a procedural tree',
    description: 'Generate a complete tree mesh (bark + foliage, analytic UVs, optional wind vertex colours) from a species preset or a TreeSpec, and save it as a mesh asset. Pass projectId to add it to a project, or omit it to save to the global library — the tree generator is not project-scoped, because a tree routinely mixes assets from several projects. Deterministic: the same spec and seed always produce the same mesh, so re-rolling `seed` is the intended way to get variations. The saved asset carries the spec in its metadata so it can be regenerated or adjusted later. Streams progress; a default tree takes about a second. Requires the Python mesh-tools service (:8200) running.',
    inputSchema: {
      ...treeSource,
      projectId: z.number().int().optional().describe('Project to add the tree to. Omit to save to the global asset library.'),
      name: z.string().optional().describe('Name for the saved asset. Defaults to the species name and seed.'),
      trunkTextureAssetId: z.number().int().optional().describe('Image asset for the trunk bark, tiled along the branch — e.g. one produced by generate_image from a species prompt. Procedural structure plus generative surface is the point.'),
      branchTextureAssetId: z.number().int().optional().describe('Separate image asset for the thin wood. Supplying it splits the bark into two materials (one extra draw call); omit it and the branches wear the trunk texture.'),
      leafImageAssetIds: z.array(z.number().int()).max(64).optional().describe('Image assets for the leaves, WITH ALPHA. Pass several: they are composed into an atlas and every card picks one at random, so a few variants read as far more. This is the field to use — an atlas is what the renderer wants, not what anyone has.'),
      leafAtlasAssetId: z.number().int().optional().describe('A ready-made leaf atlas, if you already have one laid out on a grid. Ignored when leafImageAssetIds is given.'),
      save: z.boolean().default(true).describe('Set false to generate and report stats without saving an asset.'),
      tags: tagsInput
    }
  }, toolHandler(async (args, extra) => {
    const {
      projectId, name, trunkTextureAssetId, branchTextureAssetId,
      leafImageAssetIds, leafAtlasAssetId, save = true, tags, ...source
    } = args;
    const reportProgress = createProgressReporter(extra);

    const loadTexture = await makeAssetResolver(api);

    // Sequential on purpose: the resolver's listing cache is filled by the first
    // call, and firing them in parallel would have every one of them fetch it.
    const barkTexture = await loadTexture(trunkTextureAssetId);
    const branchTexture = await loadTexture(branchTextureAssetId);
    const leafAtlas = await loadTexture(leafAtlasAssetId);
    const leafImages = [];
    for (const id of leafImageAssetIds || []) leafImages.push(await loadTexture(id));

    await reportProgress(5, 100, 'Growing tree');
    const done = await api.apiJsonSse('/tree/generate', {
      ...source,
      format: 'glb',
      bark_texture_b64: barkTexture,
      branch_texture_b64: branchTexture,
      leaf_images_b64: leafImages.filter(Boolean).length ? leafImages.filter(Boolean) : null,
      leaf_atlas_b64: leafAtlas
    }, evt => {
      const frac = Number(evt?.frac);
      reportProgress(
        Number.isFinite(frac) ? Math.round(5 + frac * 85) : 50,
        100,
        evt?.message || evt?.stage || 'Growing tree'
      );
    });

    const spec = done.spec || null;
    const stats = done.stats?.tool || null;

    if (!save) {
      await reportProgress(100, 100, 'Done');
      return {
        spec,
        stats,
        savedAsset: null,
        note: `save was false, so no asset was written${tags?.length ? ' — and nothing was tagged, because tags belong to a saved asset' : ''}.`
      };
    }

    await reportProgress(92, 100, 'Saving tree');
    const buffer = Buffer.from(done.mesh_b64, 'base64');
    const assetName = name || `${spec?.name || 'Tree'} ${spec?.seed ?? ''}`.trim();
    const savedAsset = await saveTreeAsset(api, { projectId, buffer, name: assetName, spec, stats });

    if (projectId) notifyMutation(projectId);
    await reportProgress(100, 100, 'Done');
    return {
      spec,
      stats,
      savedAsset: withAssetUrls(api, savedAsset),
      ...(await applyAssetTags(api, tags, [savedAsset]))
    };
  }));
}
