// Running a built-in batch action (Optimize / Auto UV / Auto Rig / Transfer Rig /
// Bake / Flatten) for one cell.
//
// NODE ONLY — unlike actions.js and document.js, which the page imports too.
// Shared by the backend batch loop (runner.js) and the MCP run_batch tool, which
// is why it talks to the app through the loopback client rather than calling
// server internals: in gateway mode that same client reaches the shared server
// for the library, while the mesh routes stay local.
//
// A ComfyUI cell's result card is created by the server as a side effect of the
// run (the cardId it is handed is a clientKey). Nothing like that exists on the
// mesh routes, so a cell here creates its own card AFTER the result is saved —
// a failed cell leaves no empty card behind — and the caller then links the
// asset to it exactly as it does for a ComfyUI result.
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { findProjectAsset } from '../mcp/client.js';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import {
  BATCH_ACTION_AUTORETOPO,
  BATCH_ACTION_AUTORIG,
  BATCH_ACTION_AUTOUV,
  BATCH_ACTION_BAKE,
  BATCH_ACTION_FLATTEN,
  BATCH_ACTION_OPTIMIZE,
  BATCH_ACTION_TRANSFER_RIG,
  FLATTEN_SHADER_LIGHTING,
  OPTIMIZE_REUNWRAP_PARAMETER,
  describeBakeMapProblem,
  getAutoRetopoActionOptions,
  getAutoUvActionOptions,
  getBakeActionMaps,
  getBatchActionDescriptor
} from './actions.js';
import { prepareFlattenGlb } from './flatten.js';

// Below this the bake reached too little of the UV layout to be what was meant —
// the same line the Mesh Editor draws (BAKE_COVERAGE_COMPLETE).
const BAKE_COVERAGE_WARNING = 0.95;

// Share of the used texture area painted by more than one triangle. Those texels
// hold one triangle's bake and show it on the other, so a layout past this is
// worth saying out loud before anyone bakes onto it. A flip count cannot see
// this — the 2-3.5% overlaps the Auto UV overhaul found all had zero flips.
const UV_OVERLAP_WARNING = 0.01;

// Share of the flatten's atlas the packed islands occupy, below which the
// albedo is mostly empty (see runFlatten).
const FLATTEN_FILL_WARNING = 0.2;

function meshBlob(buffer) {
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

// A mesh input as the batch resolved it: `asset:<id>` (an upstream result or a
// picked library asset) or `edit:<filePath>` (a picked edit/version). Returns
// the bytes and what /meshes/editor/save needs to file a version under it.
async function loadMeshInput(api, projectId, reference, label) {
  const text = String(reference || '');
  const idMatch = text.match(/^asset:(\d+)$/);
  if (idMatch) {
    const asset = await findProjectAsset(api, projectId, Number(idMatch[1]));
    const type = String(asset.type || '').toLowerCase();
    if (type && type !== 'mesh') {
      throw new Error(`${label}: "${asset.name || asset.id}" is ${type === 'image' ? 'an' : 'a'} ${type}, not a mesh`);
    }
    const file = asset.filename || asset.filePath;
    return {
      buffer: await api.fetchAssetBuffer(file),
      fileName: path.basename(String(file)) || 'mesh.glb',
      name: asset.name || '',
      saveTarget: { assetId: asset.id }
    };
  }

  const editMatch = text.match(/^edit:(.+)$/);
  if (editMatch) {
    const filePath = editMatch[1];
    return {
      buffer: await api.fetchAssetBuffer(filePath),
      fileName: path.basename(filePath) || 'mesh.glb',
      name: '',
      saveTarget: { filePath }
    };
  }

  throw new Error(`${label}: no mesh to read (got "${text}")`);
}

async function saveMeshVersion(api, target, buffer, name) {
  const form = new FormData();
  form.append('assetId', target.assetId ? String(target.assetId) : '');
  form.append('filePath', target.filePath || '');
  form.append('name', name || 'Mesh');
  form.append('saveMode', 'version');
  form.append('source', 'BATCH');
  form.append('meshFile', meshBlob(buffer), 'mesh.glb');
  return api.apiForm('POST', '/meshes/editor/save', form);
}

// Maps a mesh-tool SSE frame onto the cell's 0-100 progress — the whole cell by
// default, or the slice [from, to] of it when the tool is one step of several.
function progressFrom(onProgress, from = 0, to = 95) {
  return evt => {
    const frac = Number(evt?.frac);
    if (Number.isFinite(frac)) onProgress?.(Math.round(from + Math.min(1, Math.max(0, frac)) * (to - from)), evt?.message || evt?.stage || '');
  };
}

function glbHasSkin(buffer) {
  try {
    return (parseGlb(buffer).json.skins || []).length > 0;
  } catch {
    return false;
  }
}

// One Auto UV pass over a GLB. Shared by the Auto UV action and by Optimize's
// re-unwrap, so the two cannot drift apart on what they send or what they warn.
async function unwrapUvs(api, buffer, fileName, options, onProgress) {
  const form = new FormData();
  form.append('meshFile', meshBlob(buffer), fileName);
  form.append('format', 'glb');
  form.append('options', JSON.stringify(options));
  const done = await api.apiFormSse('/meshes/auto-uv', form, onProgress);
  if (!done.mesh_b64) throw new Error('The Auto UV service returned no mesh');
  const tool = done.stats?.tool || {};

  const warnings = [];
  if (typeof tool.overlap_share === 'number' && tool.overlap_share > UV_OVERLAP_WARNING) {
    warnings.push(`${(tool.overlap_share * 100).toFixed(1)}% of the UV layout is covered by more than one triangle — a bake will show the wrong detail there`);
  }
  if (Number(tool.flipped_triangles) > 0) {
    warnings.push(`${tool.flipped_triangles} triangles are mirrored in UV space`);
  }
  // The service rebuilds the mesh from its vertices and faces, so a skin does
  // not survive the trip. Said here rather than refused: an unwrap before a
  // bake is the point, and the rig belongs after both.
  if (glbHasSkin(buffer)) {
    warnings.push('The rig was dropped — Auto UV returns geometry only, so run Auto Rig after this stage');
  }

  return {
    buffer: Buffer.from(done.mesh_b64, 'base64'),
    stats: {
      charts: tool.n_charts ?? null,
      fill: tool.fill_ratio ?? null,
      overlap: tool.overlap_share ?? null,
      flipped: tool.flipped_triangles ?? null
    },
    warnings
  };
}

// --- the actions -----------------------------------------------------------

async function runOptimize(api, { projectId, inputs, onProgress }) {
  const source = await loadMeshInput(api, projectId, inputs.mesh, 'Mesh');
  onProgress?.(10, 'Simplifying');

  const form = new FormData();
  form.append('meshFile', meshBlob(source.buffer), source.fileName);
  form.append('options', JSON.stringify({
    target_faces: Math.max(1, Math.round(Number(inputs.target_faces) || 1)),
    // The field reads in percent, as it does in the Mesh Editor panel.
    simplify_error: Number(inputs.simplify_error) / 100,
    simplify_update: inputs.simplify_update === true,
    lock_border: inputs.lock_border === true,
    allow_seam_breaking: inputs.allow_seam_breaking === true,
    permissive: inputs.permissive === true,
    aggressive: inputs.aggressive === true
  }));
  const done = await api.apiForm('POST', '/meshes/optimize', form);
  const stats = done.stats || {};
  let buffer = Buffer.from(done.mesh_b64, 'base64');

  const warnings = [];
  if (stats.seam_limited) {
    warnings.push(`Stopped at ${Number(stats.triangles).toLocaleString('en-US')} faces, short of ${Number(inputs.target_faces).toLocaleString('en-US')} — raise the error budget, or allow seams to break`);
  }

  // `seams_broken` means the aggressive pass (-sa) really ran: it rebuilt the
  // vertex set and reassigned UVs, which is exactly what a later Bake cannot
  // work with. This is the only place that knows it happened, which is why the
  // re-unwrap lives here and not only as a stage of its own.
  let uv = null;
  if (stats.seams_broken && inputs[OPTIMIZE_REUNWRAP_PARAMETER] === true) {
    onProgress?.(40, 'Re-unwrapping UVs');
    const unwrapped = await unwrapUvs(api, buffer, source.fileName, getAutoUvActionOptions({}), progressFrom(onProgress, 40, 95));
    buffer = unwrapped.buffer;
    uv = unwrapped.stats;
    warnings.push(`The aggressive pass broke the UV seams, so the result was re-unwrapped (${uv.charts ?? '?'} islands). The old texture no longer fits it — bake the base colour from the source to bring it back`);
    warnings.push(...unwrapped.warnings);
  } else if (stats.seams_broken) {
    warnings.push('The aggressive pass welded attribute seams to reach the target, so the UVs and hard edges are broken — turn on "Re-unwrap UVs if seams break", or add an Auto UV stage, before baking');
  }

  return {
    source,
    buffer,
    stats: {
      inputFaces: stats.input_triangles ?? null,
      faces: stats.triangles ?? null,
      targetFaces: stats.target_faces ?? null,
      achievedRatio: stats.achieved_ratio ?? null,
      ...(uv ? { uv } : {})
    },
    warnings
  };
}

async function runAutoUv(api, { projectId, inputs, onProgress }) {
  const source = await loadMeshInput(api, projectId, inputs.mesh, 'Mesh');
  onProgress?.(5, 'Unwrapping');
  const unwrapped = await unwrapUvs(api, source.buffer, source.fileName, getAutoUvActionOptions(inputs), progressFrom(onProgress, 5, 95));
  return { source, buffer: unwrapped.buffer, stats: unwrapped.stats, warnings: unwrapped.warnings };
}

// Auto Retopo rebuilds the surface from a voxel shell, so the mesh that comes
// back is geometry and nothing else: the service returns a bare trimesh, which
// means no UVs, no material and no skin. Every one of those is warned about
// rather than refused — a retopo before an unwrap and a bake is the whole point
// of putting it in a batch, and the rig belongs after all three.
async function runAutoRetopo(api, { projectId, inputs, onProgress }) {
  const source = await loadMeshInput(api, projectId, inputs.mesh, 'Mesh');
  onProgress?.(5, 'Rebuilding topology');

  const form = new FormData();
  form.append('meshFile', meshBlob(source.buffer), source.fileName);
  form.append('format', 'glb');
  form.append('options', JSON.stringify(getAutoRetopoActionOptions(inputs)));
  const done = await api.apiFormSse('/meshes/auto-retopo', form, progressFrom(onProgress, 5, 95));
  if (!done.mesh_b64) throw new Error('The Auto Retopo service returned no mesh');

  // The route wraps the service's own stats under `tool`, exactly as /meshes/auto-uv
  // does — the metrics live at stats.tool.metrics, not stats.metrics.
  const tool = done.stats?.tool || {};
  const topology = tool.metrics?.topology || {};
  const quality = tool.metrics?.triangle_quality || {};

  const warnings = [];
  // The shell stage closes holes and merges parts, so a result that is still
  // open or in pieces means the input defeated it — worth saying, because the
  // usual fix (raise the shell resolution) is a parameter on this stage.
  if (topology.watertight === false) {
    warnings.push('The result is not watertight — raise the shell resolution or the close iterations');
  }
  if (Number(topology.components) > 1) {
    warnings.push(`The result is in ${topology.components} pieces rather than one`);
  }
  warnings.push('Retopo returns geometry only: the UVs, the texture and any rig are gone — follow this stage with Auto UV, then Bake, then a rig');

  return {
    source,
    buffer: Buffer.from(done.mesh_b64, 'base64'),
    stats: {
      faces: topology.faces ?? null,
      vertices: topology.vertices ?? null,
      watertight: topology.watertight ?? null,
      components: topology.components ?? null,
      well_shaped: quality.pct_well_shaped ?? null,
      quad_faces: tool.quad_face_count ?? null
    },
    warnings
  };
}

async function runAutoRig(api, { projectId, inputs, onProgress }) {
  const source = await loadMeshInput(api, projectId, inputs.mesh, 'Mesh');
  onProgress?.(5, 'Rigging');

  const form = new FormData();
  form.append('meshFile', meshBlob(source.buffer), source.fileName);
  form.append('format', 'glb');
  form.append('options', JSON.stringify({
    rename_bones: String(inputs.rename_bones || 'mixamo'),
    use_transfer: inputs.use_transfer === true,
    use_postprocess: inputs.use_postprocess === true,
    keep_loaded: inputs.keep_loaded === true,
    top_k: Number(inputs.top_k),
    top_p: Number(inputs.top_p),
    temperature: Number(inputs.temperature),
    repetition_penalty: Number(inputs.repetition_penalty),
    num_beams: Number(inputs.num_beams),
    length_penalty: Number(inputs.length_penalty)
  }));
  const done = await api.apiFormSse('/meshes/rig', form, progressFrom(onProgress));
  if (!done.mesh_b64) throw new Error('The rigging service returned no mesh');

  return { source, buffer: Buffer.from(done.mesh_b64, 'base64'), stats: done.stats || null, warnings: [] };
}

// The backend twin of the Mesh Editor's "Transfer Rig From Mesh"
// (meshRigTransfer.js behind /meshes/transfer-rig, the route MCP transfer_rig
// uses too). It edits the target's glTF in place, so its materials, textures and
// UVs come through byte for byte — the right thing to run after a Bake.
async function runTransferRig(api, { projectId, inputs, onProgress }) {
  const target = await loadMeshInput(api, projectId, inputs.mesh, 'Mesh (target)');
  const rig = await loadMeshInput(api, projectId, inputs.rig_source, 'Rigged mesh (source)');
  onProgress?.(10, `Transferring the rig from ${rig.name || 'the source mesh'}`);

  const smoothIters = Number(inputs.smooth_iters);
  const form = new FormData();
  form.append('meshFile', meshBlob(target.buffer), target.fileName);
  form.append('sourceFile', meshBlob(rig.buffer), rig.fileName);
  form.append('options', JSON.stringify({ smooth_iters: Number.isFinite(smoothIters) ? Math.round(smoothIters) : 2 }));
  const done = await api.apiForm('POST', '/meshes/transfer-rig', form);
  if (!done?.mesh_b64) throw new Error(done?.error || 'The rig transfer returned no mesh');
  const stats = done.stats || {};

  const warnings = [];
  if (stats.warning) warnings.push(stats.warning);
  // Rescaling someone's rig silently would be worse than a warning, so it is
  // said with the factor — the same thing the editor shows before its run.
  if (stats.rescaled) {
    warnings.push(`The source was ${(1 / stats.rescaled).toFixed(2)}x the size of the target on every axis, so it and its skeleton were scaled by ${Number(stats.rescaled).toFixed(3)}x and centred onto it`);
  } else if (stats.recentred) {
    warnings.push('The source sat elsewhere, so it and its skeleton were re-centred onto the target before sampling');
  }
  if (stats.farSample) {
    warnings.push(`Some vertices reached ${Math.round(stats.farthestFraction * 100)}% of the mesh’s size for their weights — the source is not the same shape there, so check those parts when posed`);
  }
  const skipped = stats.skippedSourceParts || [];
  if (skipped.length) {
    warnings.push(`${skipped.length} part${skipped.length === 1 ? '' : 's'} of the source (${skipped.join(', ')}) ${skipped.length === 1 ? 'was' : 'were'} skipped for using bones outside its skeleton, so anything only they covered came back unweighted`);
  }
  if (Number(stats.missed) > 0) {
    warnings.push(`${Number(stats.missed).toLocaleString('en-US')} vertices found no source surface and came back unweighted`);
  }
  // The glTF graft copies the skeleton and weights, not the clips — unlike the
  // editor, which carries them on its rig scene.
  let clips = 0;
  try { clips = (parseGlb(rig.buffer).json.animations || []).length; } catch { clips = 0; }
  if (clips > 0) {
    warnings.push(`The source’s ${clips} animation clip${clips === 1 ? ' was' : 's were'} not copied — a batch transfer carries the skeleton and weights only; use the Mesh Editor to bring the clips too`);
  }

  return {
    source: target,
    buffer: Buffer.from(done.mesh_b64, 'base64'),
    stats: {
      bones: stats.bones ?? null,
      vertices: stats.vertices ?? null,
      missed: stats.missed ?? null,
      farthestFraction: stats.farthestFraction ?? null,
      rescaled: stats.rescaled || null
    },
    warnings
  };
}

async function runBake(api, { projectId, inputs, onProgress }) {
  const maps = getBakeActionMaps(inputs);
  const mapProblem = describeBakeMapProblem(maps);
  if (mapProblem) throw new Error(mapProblem);

  const low = await loadMeshInput(api, projectId, inputs.low_poly, 'Low poly');
  const high = await loadMeshInput(api, projectId, inputs.high_poly, 'High poly');
  onProgress?.(5, 'Baking');

  const form = new FormData();
  form.append('meshFile', meshBlob(low.buffer), low.fileName);
  form.append('sourceFile', meshBlob(high.buffer), high.fileName);
  form.append('options', JSON.stringify({
    maps,
    resolution: Number(inputs.resolution),
    samples: Number(inputs.samples),
    cage_extrusion: Number(inputs.cage_extrusion),
    max_ray_distance: 0,
    margin: Number(inputs.margin),
    align_source: inputs.align_source === true,
    // The panel's toggle stands for the service's default threshold.
    require_overlap: inputs.require_overlap === true ? 0.5 : 0
  }));
  const done = await api.apiFormSse('/meshes/bake', form, progressFrom(onProgress));
  const stats = done.stats?.tool || done.stats || {};

  const baked = {};
  for (const [map, base64] of Object.entries(done.maps || {})) {
    baked[map] = Buffer.from(base64, 'base64');
  }
  if (Object.keys(baked).length === 0) throw new Error('The bake returned no maps');

  const { buffer, applied } = applyBakedMapsToGlb(low.buffer, baked, { ormChannels: stats.orm_channels || [] });

  const warnings = [];
  if (typeof stats.coverage === 'number' && stats.coverage < BAKE_COVERAGE_WARNING) {
    warnings.push(`The rays reached only ${Math.round(stats.coverage * 100)}% of the UV layout — is the high poly the mesh the low poly came from?`);
  }
  if (Array.isArray(stats.flat_channels) && stats.flat_channels.length > 0) {
    warnings.push(`${stats.flat_channels.join(' and ')} came from a constant on the source material, so the baked map is flat`);
  }

  return {
    // The result is the low poly with maps on it, so it is filed under that.
    source: low,
    buffer,
    stats: {
      applied,
      coverage: typeof stats.coverage === 'number' ? stats.coverage : null,
      resolution: stats.resolution ?? null
    },
    warnings
  };
}

// The Export dialog's flatten (buildMeshFiles in ExportMeshDialog.jsx), with
// the browser's atlas and material halves done by flatten.js instead. Same
// notes, turned into warnings where they ask for something to be checked.
async function runFlatten(api, { projectId, inputs, onProgress }) {
  const source = await loadMeshInput(api, projectId, inputs.mesh, 'Mesh');
  const shader = Object.hasOwn(FLATTEN_SHADER_LIGHTING, inputs.shader) ? inputs.shader : 'unlit';
  const resolution = Math.round(Number(inputs.resolution)) || 2048;
  const exposure = Number(inputs.exposure);
  const baseName = path.basename(source.fileName, path.extname(source.fileName)) || 'mesh';

  onProgress?.(2, 'Packing one UV atlas across every material');
  const prepared = prepareFlattenGlb(source.buffer, { resolution });

  const form = new FormData();
  form.append('meshFile', meshBlob(prepared.bakeTarget), `${baseName}.glb`);
  form.append('options', JSON.stringify({
    resolution,
    samples: Math.round(Number(inputs.samples)) || 64,
    lighting: FLATTEN_SHADER_LIGHTING[shader],
    exposure: Number.isFinite(exposure) ? Math.min(3, Math.max(-3, exposure)) : 0,
    atlas_uv: prepared.channel
  }));
  const done = await api.apiFormSse('/meshes/flatten', form, progressFrom(onProgress, 5, 93));
  const stats = done.stats?.tool || done.stats || {};
  if (!done.maps?.albedo) throw new Error('The flatten bake returned no albedo');

  onProgress?.(95, 'Applying the flattened albedo');
  const { buffer, materialCount } = prepared.finish(Buffer.from(done.maps.albedo, 'base64'), {
    hasAlpha: !!stats.has_alpha,
    unlit: shader === 'unlit',
    name: baseName
  });

  const { atlas } = prepared;
  const warnings = [];
  // A healthy repack fills 75-90%. Far below that the UVs tile or overlap
  // themselves (mapped in metres, say), so every island's box is huge beside
  // the area it paints and all of them shrank to fit.
  if (atlas.repacked && atlas.fill < FLATTEN_FILL_WARNING) {
    warnings.push(`The UV islands cover only ${Math.round(atlas.fill * 100)}% of the albedo — the layout tiles or overlaps itself, so each island had to shrink to fit. An Auto UV stage first gives it a layout that fills the texture`);
  }
  if (atlas.unmapped) {
    warnings.push(`${atlas.unmapped.toLocaleString('en-US')} triangle${atlas.unmapped === 1 ? '' : 's'} without usable UVs were mapped one by one — an Auto UV stage first gives them a proper layout`);
  }
  // A tenth of the texels at the shoulder of the tone curve means the exposure
  // is washing the brightest parts out.
  if ((stats.clipped_frac || 0) > 0.1) {
    warnings.push(`${Math.round(stats.clipped_frac * 100)}% of the albedo hit the highlight roll-off — lower the exposure if it looks washed out`);
  }

  return {
    source,
    buffer,
    stats: {
      shader,
      resolution,
      repacked: atlas.repacked,
      islands: atlas.islands,
      unmapped: atlas.unmapped,
      materials: materialCount,
      hasAlpha: !!stats.has_alpha
    },
    warnings
  };
}

const RUNNERS = {
  [BATCH_ACTION_OPTIMIZE]: runOptimize,
  [BATCH_ACTION_AUTORETOPO]: runAutoRetopo,
  [BATCH_ACTION_AUTOUV]: runAutoUv,
  [BATCH_ACTION_AUTORIG]: runAutoRig,
  [BATCH_ACTION_TRANSFER_RIG]: runTransferRig,
  [BATCH_ACTION_BAKE]: runBake,
  [BATCH_ACTION_FLATTEN]: runFlatten
};

// Run one cell of a built-in action and save its result.
//
// inputs: parameter id -> value, as resolveStageInputs produced them.
// cardKey: the cell's result-card clientKey; the card is created here.
// onProgress(percent, detail): 0-100 while it runs.
//
// Resolves { asset, stats, warnings } — `asset` shaped like a ComfyUI result
// (id, type, name) so the caller treats both kinds of cell the same way.
export async function executeBatchAction(api, { action, projectId, inputs, name, cardKey, onProgress }) {
  const descriptor = getBatchActionDescriptor(action);
  const run = RUNNERS[descriptor?.action];
  if (!run) throw new Error(`Unknown batch action "${action}"`);

  const outcome = await run(api, { projectId, inputs: inputs || {}, onProgress });

  onProgress?.(97, 'Saving');
  const saved = await saveMeshVersion(api, outcome.source.saveTarget, outcome.buffer, name || outcome.source.name);
  if (!saved?.id) throw new Error(saved?.error || 'The result could not be saved');

  if (cardKey) {
    await api.apiJson('POST', '/cards', {
      body: { projectId, column: descriptor.kanbanColumn || 'Mesh Edit', name: saved.name || name || '', cardId: cardKey }
    });
  }

  return {
    asset: { ...saved, type: saved.type || 'mesh' },
    stats: outcome.stats,
    warnings: outcome.warnings
  };
}

// --- baked maps -> glTF material --------------------------------------------

// The server-side twin of the Mesh Editor's "Apply to mesh" and of
// attachBakedMaps in src/utils/meshExport.js, written against the glTF JSON
// because the backend has no three.js scene to hang textures on. Same rules:
//  * normal -> normalTexture
//  * a packed ORM is preferred, one texture across occlusion and
//    metallicRoughness (glTF reads AO from R, roughness from G, metallic from B)
//  * a factor multiplies its texture, so each factor a baked channel lands on is
//    reset to 1 — otherwise a material at roughness 0.5 halves every value.
//    A channel that was NOT baked keeps its factor; the service fills it with a
//    neutral value (roughness 255, metallic 0), so an unbaked roughness keeps
//    reading its factor and an unbaked metallic reads as non-metal
//  * base colour -> baseColorTexture with a white factor (the bake already
//    carries the source's tint), alpha kept
// Every material the mesh's primitives use gets the maps: a bake writes one UV
// layout, which is what every primitive samples.
//
// Returns { buffer, applied } — the new GLB and the channel names attached.
export function applyBakedMapsToGlb(glbBuffer, maps, { ormChannels = [] } = {}) {
  const { json, bin } = parseGlb(glbBuffer);
  json.buffers = json.buffers || [];
  if (json.buffers.length > 0 && json.buffers[0].uri !== undefined) {
    throw new Error('The low poly keeps its geometry in an external file, so the baked maps cannot be embedded in it');
  }
  if (json.buffers.length === 0) json.buffers.push({ byteLength: 0 });

  const parts = [bin ? Buffer.from(bin) : Buffer.alloc(0)];
  let length = parts[0].length;
  json.bufferViews = json.bufferViews || [];
  json.images = json.images || [];
  json.textures = json.textures || [];
  json.samplers = json.samplers || [];
  json.materials = json.materials || [];

  // Linear + mipmapped, repeating: what three.js and the engines default to.
  const sampler = json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }) - 1;
  const addTexture = (png) => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); length += pad; }
    const view = json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: png.length }) - 1;
    parts.push(png);
    length += png.length;
    const image = json.images.push({ mimeType: 'image/png', bufferView: view }) - 1;
    return json.textures.push({ sampler, source: image }) - 1;
  };

  // Every material a primitive uses. A primitive with none gets one, or there
  // would be nothing to carry its maps.
  const used = new Set();
  let fallbackMaterial = null;
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if (primitive.material === undefined) {
        if (fallbackMaterial === null) {
          fallbackMaterial = json.materials.push({ name: 'Baked', pbrMetallicRoughness: {} }) - 1;
        }
        primitive.material = fallbackMaterial;
      }
      used.add(primitive.material);
    }
  }
  const materials = [...used].map(index => json.materials[index]).filter(Boolean);
  const each = (fn) => materials.forEach(material => {
    material.pbrMetallicRoughness = material.pbrMetallicRoughness || {};
    fn(material, material.pbrMetallicRoughness);
  });

  const applied = [];

  if (maps.normal) {
    const texture = addTexture(maps.normal);
    each(material => { material.normalTexture = { index: texture }; });
    applied.push('normal');
  }

  if (maps.orm && ormChannels.length) {
    const texture = addTexture(maps.orm);
    if (ormChannels.includes('ao')) {
      each(material => { material.occlusionTexture = { index: texture }; });
    }
    if (ormChannels.includes('roughness') || ormChannels.includes('metallic')) {
      each((material, pbr) => {
        pbr.metallicRoughnessTexture = { index: texture };
        if (ormChannels.includes('roughness')) pbr.roughnessFactor = 1;
        if (ormChannels.includes('metallic')) pbr.metallicFactor = 1;
      });
    }
    applied.push(`packed ${ormChannels.join('/')}`);
  } else if (maps.ao) {
    // Grey, so R — the channel glTF reads occlusion from — holds it.
    const texture = addTexture(maps.ao);
    each(material => { material.occlusionTexture = { index: texture }; });
    applied.push('ao');
  }

  if (maps.base_color) {
    const texture = addTexture(maps.base_color);
    each((material, pbr) => {
      const alpha = Array.isArray(pbr.baseColorFactor) ? (pbr.baseColorFactor[3] ?? 1) : 1;
      pbr.baseColorTexture = { index: texture };
      pbr.baseColorFactor = [1, 1, 1, alpha];
    });
    applied.push('base colour');
  }

  const binary = Buffer.concat(parts);
  json.buffers[0].byteLength = binary.length;
  return { buffer: serializeGlb(json, binary), applied };
}
