// Running a built-in batch action (Optimize / Auto Rig / Bake) for one cell.
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
  BATCH_ACTION_AUTORIG,
  BATCH_ACTION_BAKE,
  BATCH_ACTION_OPTIMIZE,
  describeBakeMapProblem,
  getBakeActionMaps,
  getBatchActionDescriptor
} from './actions.js';

// Below this the bake reached too little of the UV layout to be what was meant —
// the same line the Mesh Editor draws (BAKE_COVERAGE_COMPLETE).
const BAKE_COVERAGE_WARNING = 0.95;

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

// Maps a mesh-tool SSE frame onto the cell's 0-100 progress.
function progressFrom(onProgress) {
  return evt => {
    const frac = Number(evt?.frac);
    if (Number.isFinite(frac)) onProgress?.(Math.round(Math.min(1, Math.max(0, frac)) * 95), evt?.message || evt?.stage || '');
  };
}

// --- the three actions -----------------------------------------------------

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

  const warnings = [];
  if (stats.seam_limited) {
    warnings.push(`Stopped at ${Number(stats.triangles).toLocaleString('en-US')} faces, short of ${Number(inputs.target_faces).toLocaleString('en-US')} — raise the error budget, or allow seams to break`);
  }
  if (stats.seams_broken) {
    warnings.push('Attribute seams were welded to reach the target — check the texture and the hard edges');
  }

  return {
    source,
    buffer: Buffer.from(done.mesh_b64, 'base64'),
    stats: {
      inputFaces: stats.input_triangles ?? null,
      faces: stats.triangles ?? null,
      targetFaces: stats.target_faces ?? null,
      achievedRatio: stats.achieved_ratio ?? null
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

const RUNNERS = {
  [BATCH_ACTION_OPTIMIZE]: runOptimize,
  [BATCH_ACTION_AUTORIG]: runAutoRig,
  [BATCH_ACTION_BAKE]: runBake
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
