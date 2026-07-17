import { z } from 'zod';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { toolHandler, createProgressReporter, withAssetUrls, findProjectAsset } from '../client.js';

// Local mesh services behind the Node proxy. auto_uv/auto_retopo/repair/
// convert_fbx run on the Python mesh-tools service (:8200), auto_rig on the
// rigging service (:8300), optimize on the bundled gltfpack binary.
const OPERATIONS = {
  auto_uv: { path: '/meshes/auto-uv', sse: true },
  auto_retopo: { path: '/meshes/auto-retopo', sse: true },
  repair: { path: '/meshes/repair', sse: true },
  convert_fbx: { path: '/meshes/convert', sse: true, format: 'fbx' },
  auto_rig: { path: '/meshes/rig', sse: true },
  optimize: { path: '/meshes/optimize', sse: false }
};

// Typed option shapes for the parameter-heavy tools. These mirror the Python
// service's Pydantic models 1:1 (python-server/app/schemas.py) — same keys,
// ranges, and defaults — so an MCP client sees every knob with its bounds and
// default instead of an opaque options blob. Keep them in sync with schemas.py
// and the panel defaults in src/pages/MeshEditorPage.jsx.
const AUTO_UV_OPTIONS = {
  // segmentation
  max_cone_deg: z.number().min(1).max(180).default(50).describe('Normal-cone cap (deg). Higher = fewer, more distorted charts.'),
  sharp_weight: z.number().min(0).max(1).default(0.35).describe('How strongly sharp edges attract seams.'),
  min_faces: z.number().int().min(1).max(100000).default(20).describe('Charts smaller than this are dissolved into neighbours.'),
  min_area_frac: z.number().min(0).max(1).default(0.004).describe('Min chart area as a fraction of total surface area.'),
  fold_cap_deg: z.number().min(1).max(180).default(88).describe('Dihedral fold cap that forces a seam.'),
  // refinement (LSCM-validated chart merge)
  refine: z.boolean().default(true).describe('Run the LSCM-validated chart-merge pass (off = faster, more charts).'),
  refine_target_faces: z.number().int().min(1).max(100000).default(80).describe('Charts below this face count are merge candidates.'),
  refine_ad_thresh: z.number().min(1).max(10).default(1.32).describe('Max angle-distortion ratio a merge may introduce.'),
  // parameterization
  method: z.enum(['auto', 'lscm', 'arap', 'planar']).default('auto').describe('Per-chart flattening method.'),
  arap_iters: z.number().int().min(0).max(100).default(4).describe('As-rigid-as-possible iterations (0 = LSCM/planar only).'),
  // packing
  resolution: z.number().int().min(64).max(8192).default(1024).describe('Atlas resolution used to size padding (px). Typical values: 256/512/1024/2048/4096/8192.'),
  padding_texels: z.number().int().min(0).max(64).default(4).describe('Inter-island padding in texels.'),
  // topology repair
  weld: z.boolean().default(true).describe('Proximity-weld coincident verts before unwrapping (stitches shattered shells).'),
  weld_tol_frac: z.number().min(0).max(1).default(0.1).describe('Weld tolerance as a fraction of median edge length.')
};

const AUTO_RETOPO_OPTIONS = {
  // target
  target_faces: z.number().int().min(50).max(5_000_000).default(6000).describe('Approximate face budget of the output.'),
  quads: z.boolean().default(false).describe('Convert the final mesh to quad-dominant (reported in metrics; GLB stays triangulated).'),
  // base generation (watertight shell)
  watertight: z.boolean().default(true).describe('Build a unified voxel shell (robust to messy input) vs. remesh the surface directly (keeps open boundaries).'),
  shell_resolution: z.number().int().min(16).max(1024).default(256).describe('Voxel grid cells along the longest bbox axis (watertight only).'),
  shell_close_iter: z.number().int().min(0).max(20).default(1).describe('Morphological closing iterations to bridge cracks (watertight only).'),
  shell_smooth: z.number().min(0).max(5).default(1.4).describe('Gaussian sigma (voxels) on the SDF; kills voxel ripple, lower = crisper (watertight only).'),
  shell_taubin: z.number().int().min(0).max(100).default(10).describe('Taubin polish steps on the dense shell, 0 disables (watertight only).'),
  shell_samples_per_pitch: z.number().min(1).max(8).default(2).describe('Surface sampling density; >=2 guarantees gap-free voxel coverage (watertight only).'),
  max_memory_gb: z.number().min(0).max(128).default(4).describe('Auto-lower shell resolution to fit this budget, 0 disables (watertight only).'),
  // clean topology (field-adaptive isotropic remeshing)
  adaptive: z.boolean().default(true).describe('Curvature-adaptive density (more faces where the surface bends).'),
  remesh_iters: z.number().int().min(1).max(100).default(10).describe('Isotropic remesh iterations.'),
  feature_deg: z.number().min(0).max(180).default(30).describe('Crease angle preserved as a feature.'),
  calibrate_passes: z.number().int().min(0).max(10).default(1).describe('Rough edge-length correction passes.'),
  // hard-surface / detail preservation
  preserve_features: z.boolean().default(false).describe('Hard-surface mode: keep sharp creases crisp, skip smoothing/projection.'),
  feature_angle: z.number().min(0).max(180).default(25).describe('Crease angle (deg) treated as a hard edge when preserve_features is on.'),
  // silhouette projection
  project: z.boolean().default(true).describe('Project the remesh back onto the original surface.'),
  project_iters: z.number().int().min(0).max(100).default(10).describe('Projection iterations.'),
  project_clamp: z.number().min(0).max(10).default(1.5).describe('Max per-vertex move as a multiple of local edge length.'),
  relax_strength: z.number().min(0).max(1).default(0.4).describe('Tangential relaxation factor per iteration.'),
  // compute backend (shell stage only)
  device: z.enum(['auto', 'cpu', 'cuda']).default('auto').describe("Shell-stage compute backend: 'auto' uses an NVIDIA GPU (CuPy) when available and falls back to CPU; 'cpu' forces CPU; 'cuda' forces GPU (errors if unavailable). Other stages always run on CPU."),
  // misc
  seed: z.number().int().min(0).default(0).describe('RNG seed for reproducibility.')
};

// Core runner shared by run_mesh_tool and the typed auto_uv_mesh/auto_retopo_mesh
// tools: load the asset, run the operation (SSE-streamed or synchronous), and
// save the result as a new version (or replace / write FBX to disk).
async function runMeshOperation(api, notifyMutation, args, extra) {
  const { projectId, assetId, operation, options = {}, saveMode = 'version', name, targetFolder } = args;
  const op = OPERATIONS[operation];
  const reportProgress = createProgressReporter(extra);

  const asset = await findProjectAsset(api, projectId, assetId);
  await reportProgress(5, 100, `Loaded ${asset.name || 'mesh'} — running ${operation}`);
  const assetFile = asset.filename || asset.filePath;
  const meshBuffer = await api.fetchAssetBuffer(assetFile);

  const form = new FormData();
  const fileName = path.basename(String(assetFile)) || 'mesh.glb';
  form.append('meshFile', new Blob([meshBuffer], { type: 'model/gltf-binary' }), fileName);
  form.append('options', JSON.stringify(options));

  let resultBuffer;
  let stats;
  let outFormat = 'glb';

  if (op.sse) {
    form.append('format', op.format || 'glb');
    const done = await api.apiFormSse(op.path, form, evt => {
      const frac = Number(evt?.frac);
      reportProgress(
        Number.isFinite(frac) ? Math.round(5 + frac * 85) : 50,
        100,
        evt?.message || evt?.stage || `Running ${operation}`
      );
    });
    resultBuffer = Buffer.from(done.mesh_b64, 'base64');
    stats = done.stats || null;
    outFormat = done.format || op.format || 'glb';
  } else {
    const done = await api.apiForm('POST', op.path, form);
    resultBuffer = Buffer.from(done.mesh_b64, 'base64');
    stats = done.stats || null;
  }

  await reportProgress(92, 100, 'Saving result');

  // FBX conversion is an export, not an editable asset — write it to disk.
  if (operation === 'convert_fbx') {
    if (!targetFolder) throw new Error('convert_fbx requires targetFolder (absolute folder to write the .fbx into).');
    const exportForm = new FormData();
    const fbxName = `${(name || asset.name || 'mesh').replace(/\.[^.]*$/, '')}.fbx`;
    exportForm.append('folder', targetFolder);
    exportForm.append('files', new Blob([resultBuffer]), fbxName);
    const written = await api.apiForm('POST', '/export/mesh', exportForm);
    await reportProgress(100, 100, 'FBX written');
    return { operation, stats, ...written };
  }

  const saveForm = new FormData();
  saveForm.append('assetId', String(asset.id));
  saveForm.append('filePath', '');
  saveForm.append('name', name || `${asset.name || 'Mesh'} (${operation.replace(/_/g, ' ')})`);
  saveForm.append('saveMode', saveMode);
  saveForm.append('meshFile', new Blob([resultBuffer], { type: 'model/gltf-binary' }), `mesh.${outFormat}`);
  const savedAsset = await api.apiForm('POST', '/meshes/editor/save', saveForm);

  notifyMutation(projectId);
  await reportProgress(100, 100, 'Done');
  return { operation, stats, savedAsset: withAssetUrls(api, savedAsset) };
}

export function registerMeshToolTools(server, { api, notifyMutation }) {
  server.registerTool('run_mesh_tool', {
    title: 'Run mesh tool',
    description: 'Run a local mesh-processing tool on a project mesh asset and save the result. Operations: auto_uv (UV unwrap), auto_retopo (retopology), repair (fix non-manifold geometry), auto_rig (skeleton + skin weights via the rigging service), optimize (gltfpack simplification; options.simplify_ratio 0..1), convert_fbx (GLB→FBX via headless Blender; requires targetFolder, options.preset unity|unreal|generic). NOTE: auto_uv and auto_retopo have many parameters — prefer the dedicated auto_uv_mesh and auto_retopo_mesh tools, which document and validate every option; here their options ride along as a free-form object and unset keys fall back to service defaults. Requires the Python mesh-tools service (auto_uv/auto_retopo/repair/convert_fbx) or rigging service (auto_rig) to be running — in the desktop app start them from Settings. Results save as a new version of the asset by default.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int().describe('Mesh asset id (from list_assets)'),
      operation: z.enum(['auto_uv', 'auto_retopo', 'repair', 'auto_rig', 'optimize', 'convert_fbx']),
      options: z.record(z.string(), z.any()).default({}).describe('Operation options (e.g. {simplify_ratio: 0.5} for optimize, {preset: "unity"} for convert_fbx). For auto_uv/auto_retopo see the dedicated tools for the full option list.'),
      saveMode: z.enum(['version', 'replace']).default('version').describe('Save the processed mesh as a new version (default) or replace the asset file'),
      name: z.string().optional().describe('Name for the saved result'),
      targetFolder: z.string().optional().describe('convert_fbx only: absolute folder to write the .fbx file into')
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, args, extra)));

  server.registerTool('auto_uv_mesh', {
    title: 'Auto UV unwrap',
    description: 'UV-unwrap a project mesh asset with the Python mesh-tools service (:8200) and save the result as a new version. Every autouv.unwrap() parameter is exposed under `options` with its range and default — set the ones you need; omitted keys use the documented default. Streams progress. Requires the Python mesh-tools service running (start it from Settings in the desktop app).',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int().describe('Mesh asset id (from list_assets)'),
      options: z.object(AUTO_UV_OPTIONS).default({}).describe('Auto UV unwrap parameters. Any subset may be set; unset keys use their default.'),
      saveMode: z.enum(['version', 'replace']).default('version').describe('Save as a new version (default) or replace the asset file'),
      name: z.string().optional().describe('Name for the saved result')
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'auto_uv' }, extra)));

  server.registerTool('auto_retopo_mesh', {
    title: 'Auto retopology',
    description: 'Rebuild clean topology on a project mesh asset with the Python mesh-tools service (:8200) and save the result as a new version. Every autoretopo.RetopoConfig field is exposed under `options` with its range and default — set the ones you need; omitted keys use the documented default. The shell_* options apply only when watertight=true. Streams progress. Requires the Python mesh-tools service running (start it from Settings in the desktop app).',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int().describe('Mesh asset id (from list_assets)'),
      options: z.object(AUTO_RETOPO_OPTIONS).default({}).describe('Auto retopology parameters. Any subset may be set; unset keys use their default.'),
      saveMode: z.enum(['version', 'replace']).default('version').describe('Save as a new version (default) or replace the asset file'),
      name: z.string().optional().describe('Name for the saved result')
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'auto_retopo' }, extra)));

  server.registerTool('export_mesh', {
    title: 'Export mesh file',
    description: 'Copy a project mesh asset\'s file (GLB passthrough) into an absolute folder on this machine. For engine FBX exports (Unity/Unreal) use run_mesh_tool with operation "convert_fbx" instead.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int(),
      folder: z.string().min(1).describe('Absolute output folder'),
      fileName: z.string().optional().describe('Output file name (defaults to the asset\'s stored file name)')
    }
  }, toolHandler(async ({ projectId, assetId, folder, fileName }) => {
    const asset = await findProjectAsset(api, projectId, assetId);
    const assetFile = asset.filename || asset.filePath;
    const buffer = await api.fetchAssetBuffer(assetFile);
    const form = new FormData();
    form.append('folder', folder);
    form.append('files', new Blob([buffer]), fileName || path.basename(String(assetFile)) || 'mesh.glb');
    return api.apiForm('POST', '/export/mesh', form);
  }));
}
