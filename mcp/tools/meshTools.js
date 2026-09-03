import { z } from 'zod';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { toolHandler, createProgressReporter, withAssetUrls, findProjectAsset } from '../client.js';

// Local mesh services behind the Node proxy. auto_uv/auto_retopo/repair/
// convert_fbx/collision/bake run on the Python mesh-tools service (:8200),
// auto_rig on the rigging service (:8300), and optimize/lods/pivot in the Node
// backend itself (gltfpack binary / in-process glTF edit).
const OPERATIONS = {
  auto_uv: { path: '/meshes/auto-uv', sse: true },
  auto_retopo: { path: '/meshes/auto-retopo', sse: true },
  repair: { path: '/meshes/repair', sse: true },
  convert_fbx: { path: '/meshes/convert', sse: true, format: 'fbx' },
  auto_rig: { path: '/meshes/rig', sse: true },
  optimize: { path: '/meshes/optimize', sse: false },
  pivot: { path: '/meshes/pivot', sse: false }
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

// Mirrors RepairOptions in python-server/app/schemas.py.
const REPAIR_OPTIONS = {
  method: z.enum(['remove', 'split']).default('remove').describe("How to resolve non-manifold edges. 'remove' deletes the offending faces (small holes can then be closed); 'split' detaches the sheets, keeping all faces but leaving boundary edges."),
  preserve_uv: z.boolean().default(true).describe('Repair surgically so UVs (and therefore the texture) survive: only the faces forming the defect are touched. Turn off to fall back to the pymeshlab rebuild, which is more aggressive on badly broken meshes but welds across UV seams and DISCARDS ALL UVs.'),
  close_holes: z.boolean().default(true).describe('Close the small holes that face removal opens (also runs a trimesh fill pass).'),
  max_hole_size: z.number().int().min(0).max(5000).default(30).describe('Largest hole (in boundary edges) to close; bigger openings are left intact.'),
  weld: z.boolean().default(true).describe('Weld coincident vertices by position before repairing. Ignored when preserve_uv is on — welding is what destroys UV seams.')
};

// Mirrors ConvertOptions in python-server/app/schemas.py.
const CONVERT_OPTIONS = {
  preset: z.enum(['unity', 'unreal', 'generic']).default('generic').describe("Target engine. 'unity'/'generic' write a meters file with scale-1 transforms; 'unreal' bakes the scene to centimetres."),
  unreal_scale_mode: z.enum(['bake', 'units']).default('bake').describe("Unreal only. 'bake' rescales mesh/armature/animation data x100 to native centimetres; 'units' keeps metres and relies on UE's 'Convert Scene Unit' import option."),
  bake_fps: z.number().int().min(1).max(120).default(30).describe('Frame rate animation takes are baked at.'),
  anim_simplify: z.number().min(0).max(10).default(1).describe('Baked curve simplification (0 = lossless, larger = smaller files).')
};

// Mirrors DEFAULT_AUTO_RIG_OPTIONS / AutoRigParameterFields in the frontend —
// the rigging service is a separate stack (SkinTokens/TokenRig) with no shared
// schema file, so the panel's ranges are the contract.
const AUTO_RIG_OPTIONS = {
  rename_bones: z.enum(['mixamo', 'ue5', 'bird', 'dragon', 'fox', 'horse', 'kaiju', 'shark', 'snake', 'spider', 'original']).default('mixamo').describe('Rename the generated bones to a standard convention for retargeting. "mixamo"/"ue5" are humanoid; the animal names match the mesh2motion reference rigs the Animations tab retargets from, so pick the one for the creature you modelled.'),
  use_transfer: z.boolean().default(true).describe('Transfer the rig onto the ORIGINAL mesh, keeping its texture and scale. Recommended — with this off the result is the service\'s own remeshed proxy.'),
  use_postprocess: z.boolean().default(false).describe('Voxel-skin postprocess: clean up skin weights to reduce bleed across disconnected parts.'),
  keep_loaded: z.boolean().default(true).describe('Keep the rig model in (GPU) memory for fast repeat rigs.'),
  top_k: z.number().int().min(1).max(200).default(5).describe('Top-k sampling for the bone-token model.'),
  top_p: z.number().min(0.1).max(1).default(0.95).describe('Nucleus (top-p) sampling.'),
  temperature: z.number().min(0.1).max(2).default(1).describe('Sampling temperature.'),
  repetition_penalty: z.number().min(0.5).max(3).default(2).describe('Repetition penalty.'),
  num_beams: z.number().int().min(1).max(20).default(10).describe('Beam-search width.')
};

// gltfpack (meshoptimizer) simplification. Runs in the Node backend, not the
// Python service. Two separate things stop a mesh short of simplify_ratio and
// they want different fixes: simplify_error (the surface-deviation cap, and the
// one that binds first on most meshes) is free to raise, while
// allow_seam_breaking reaches the target by welding attribute seams, which
// reassigns normals and UVs and needs a re-bake or re-unwrap afterwards.
const OPTIMIZE_OPTIONS = {
  simplify_ratio: z.number().min(0.01).max(1).default(0.5).describe('Target fraction of the original triangle count (0.5 = half). 1 leaves the mesh untouched.'),
  simplify_error: z.number().min(0.001).max(1).default(0.05).describe("How far the simplifier may move the surface, as a fraction of the mesh size (gltfpack's -se). This is normally what caps a reduction, NOT the UV seams: raising it reaches the target while leaving normals and UVs untouched, so try it before allow_seam_breaking. gltfpack's own default is 0.01; this defaults to 0.05. Values near 1 can collapse the mesh entirely, which is refused rather than saved."),
  allow_seam_breaking: z.boolean().default(false).describe('Let the simplifier weld vertices sitting on an attribute (UV or normal) seam. Off (default) preserves the mapping and the hard edges but caps how far a seam-heavy mesh can reduce — check stats.seam_limited. On reaches the target but reassigns UVs and normals, so re-unwrap or re-bake afterwards.'),
  permissive: z.boolean().default(false).describe("gltfpack's -sp: collapse across attribute discontinuities while still choosing by quality. Measured as a no-op on every mesh tested, so it is offered but not relied on. Only applies when allow_seam_breaking is on."),
  aggressive: z.boolean().optional().describe("gltfpack's -sa: hit the ratio regardless of quality. The only thing that breaks a genuine seam floor, and the most destructive — it rebuilds the vertex set, so hard edges smooth over and the texture scrambles. Defaults to following allow_seam_breaking; set false to keep shading intact and accept a coarser mesh."),
  lock_border: z.boolean().default(false).describe('Pin vertices on an open edge so a mesh that is one piece of a larger set does not pull away from its neighbours at the shared edge. Costs some reduction.')
};

// Mirrors InspectOptions in python-server/app/schemas.py. These budgets are what
// turn a raw measurement into pass/warn/fail — a hero prop and a background rock
// disagree about every one of them.
const INSPECT_OPTIONS = {
  tri_budget: z.number().int().min(1).max(100_000_000).default(50_000).describe('Triangle budget. Over it warns; 2x over fails.'),
  texture_resolution: z.number().int().min(16).max(16384).default(2048).describe('Atlas resolution texel density is measured against (px).'),
  max_material_count: z.number().int().min(1).max(1000).default(4).describe('Material count above which the asset costs extra draw calls.'),
  uv_overlap_grid: z.number().int().min(64).max(4096).default(512).describe('Raster grid used to estimate UV island overlap (px).'),
  uv_scan_max_faces: z.number().int().min(1000).max(2_000_000).default(60_000).describe('Face cap for the UV overlap raster; bigger meshes are sampled.'),
  max_extent: z.number().gt(0).default(50).describe('Largest bbox dimension expected, in metres (bigger suggests a cm/mm unit mix-up).'),
  min_extent: z.number().gt(0).default(0.01).describe('Smallest bbox dimension expected, in metres.'),
  expect_ground_pivot: z.boolean().default(false).describe('Check that the mesh sits on Y=0 with its pivot at the origin (props/characters). Fix a failure with move_mesh_pivot.')
};

// Mirrors BakeOptions in python-server/app/schemas.py.
const BAKE_OPTIONS = {
  maps: z.array(z.enum(['normal', 'ao', 'base_color', 'roughness', 'metallic'])).min(1).default(['normal', 'ao']).describe("Which passes to bake. 'normal' carries the lost silhouette detail, 'ao' the contact shadow, 'base_color' transfers the source texture, and 'roughness'/'metallic' resample the source's PBR channels onto the new UVs. When two or more of ao/roughness/metallic are baked they are ALSO returned packed into one R/G/B 'orm' texture, which is the form glTF expects."),
  resolution: z.number().int().min(64).max(8192).default(2048).describe('Output map resolution (px). Cost scales with the square of this.'),
  samples: z.number().int().min(1).max(512).default(8).describe('Cycles samples. Only the AO pass is noisy enough to need more than a few.'),
  cage_extrusion: z.number().min(0).max(10).default(0).describe('How far to push the ray origins out along the low-poly normals, in metres. Too small misses detail that sticks out; too large catches surfaces from the other side. 0 scales it to the mesh (2% of its bbox diagonal), which is right far more often than any fixed distance.'),
  max_ray_distance: z.number().min(0).max(10).default(0).describe('Ray length limit in metres (0 = unlimited).'),
  margin: z.number().int().min(0).max(64).default(8).describe('Texels of island dilation, so filtering cannot sample the empty gutter and bleed seams into the surface.'),
  align_source: z.boolean().default(true).describe('Re-centre the source onto the target when the two are the same object at the same scale but sit at different pivots. A bake casts rays from the target onto the source, so an offset source returns BLANK texels wherever the two stop overlapping — and one pivot move between producing the target and picking the source is enough to cause it. Sources at a different scale are never moved; that case is reported in stats.alignment instead.'),
  require_overlap: z.number().min(0).max(1).default(0.5).describe("Refuse the bake when, after alignment, the source covers less than this fraction of the target's smallest axis. Fails in seconds instead of spending minutes of ray casting to return blank maps. 0 disables the check.")
};

// Mirrors CollisionOptions in python-server/app/schemas.py.
const COLLISION_OPTIONS = {
  method: z.enum(['convex_hull', 'decomposition', 'box', 'sphere']).default('convex_hull').describe("Hull strategy. 'convex_hull'/'box'/'sphere' are single primitives and instantaneous; 'decomposition' runs CoACD to approximate a concave shape with several convex parts — the shape an engine actually wants for anything with a cavity — but costs tens of seconds regardless of triangle count."),
  max_hulls: z.number().int().min(1).max(256).default(16).describe('Upper bound on parts produced by the decomposition.'),
  threshold: z.number().min(0.01).max(1).default(0.25).describe('CoACD concavity threshold. Lower = more parts, tighter fit, much slower.'),
  input_faces: z.number().int().min(0).max(1_000_000).default(1000).describe('Decimate the mesh to this many faces before decomposing. A collider needs volume, not surface detail (0 disables).'),
  max_hull_vertices: z.number().int().min(4).max(255).default(64).describe('Per-hull vertex budget — the limit physics engines actually impose (PhysX caps at 255).'),
  resolution: z.number().int().min(100).max(10000).default(1000).describe("CoACD sampling resolution (CoACD's own default is 2000)."),
  mcts_nodes: z.number().int().min(2).max(40).default(6).describe("CoACD search width (CoACD's own default is 20)."),
  mcts_iterations: z.number().int().min(10).max(500).default(40).describe("CoACD search iterations (CoACD's own default is 150)."),
  mcts_max_depth: z.number().int().min(1).max(7).default(2).describe("CoACD search depth (CoACD's own default is 3)."),
  preprocess_resolution: z.number().int().min(20).max(200).default(50).describe('CoACD manifold preprocessing resolution.'),
  seed: z.number().int().min(0).default(0).describe('RNG seed for reproducible decompositions.')
};

// ---------------------------------------------------------------------------
// Shared plumbing

// Fetch a project mesh asset's bytes plus the name to send them under.
async function loadMeshAsset(api, projectId, assetId) {
  const asset = await findProjectAsset(api, projectId, assetId);
  const assetFile = asset.filename || asset.filePath;
  const buffer = await api.fetchAssetBuffer(assetFile);
  return { asset, buffer, fileName: path.basename(String(assetFile)) || 'mesh.glb' };
}

function meshBlob(buffer) {
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

// Save a mesh buffer as a new version of (or a replacement for) an existing asset.
async function saveMeshVersion(api, asset, buffer, { saveMode = 'version', name, format = 'glb' } = {}) {
  const form = new FormData();
  form.append('assetId', String(asset.id));
  form.append('filePath', '');
  form.append('name', name || asset.name || 'Mesh');
  form.append('saveMode', saveMode);
  form.append('meshFile', meshBlob(buffer), `mesh.${format}`);
  return api.apiForm('POST', '/meshes/editor/save', form);
}

// Save a buffer as a brand-new project asset. Used where the result is a
// SIBLING of the source rather than a newer take on it — collision hulls and
// baked texture maps are their own assets, not versions of the render mesh.
async function saveNewAsset(api, projectId, buffer, { fileName, name, type, mime }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), fileName);
  form.append('projectId', String(projectId));
  form.append('type', type);
  if (name) form.append('name', name);
  form.append('metadata', JSON.stringify({}));
  return api.apiForm('POST', '/assets/upload', form);
}

// Write files into an absolute folder on the host machine. /export/mesh is
// content-agnostic — it takes any buffers — so LOD chains, hull GLBs, and baked
// PNGs all go out through it.
async function writeFilesToFolder(api, folder, files) {
  const form = new FormData();
  form.append('folder', folder);
  for (const file of files) {
    form.append('files', new Blob([file.buffer]), file.name);
  }
  return api.apiForm('POST', '/export/mesh', form);
}

function baseNameOf(asset) {
  return String(asset?.name || 'Mesh').replace(/\.[^.]*$/, '');
}

// Core runner shared by run_mesh_tool and the typed per-operation tools: load
// the asset, run the operation (SSE-streamed or synchronous), and save the
// result as a new version (or replace / write FBX to disk).
async function runMeshOperation(api, notifyMutation, args, extra) {
  const { projectId, assetId, operation, options = {}, saveMode = 'version', name, targetFolder } = args;
  const op = OPERATIONS[operation];
  const reportProgress = createProgressReporter(extra);

  const { asset, buffer: meshBuffer, fileName } = await loadMeshAsset(api, projectId, assetId);
  await reportProgress(5, 100, `Loaded ${asset.name || 'mesh'} — running ${operation}`);

  const form = new FormData();
  form.append('meshFile', meshBlob(meshBuffer), fileName);
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
    const fbxName = `${(name || asset.name || 'mesh').replace(/\.[^.]*$/, '')}.fbx`;
    const written = await writeFilesToFolder(api, targetFolder, [{ buffer: resultBuffer, name: fbxName }]);
    await reportProgress(100, 100, 'FBX written');
    return { operation, stats, ...written };
  }

  // The pivot is already where it was asked to be: the backend echoed the input
  // bytes, so saving a byte-identical "new version" would be noise.
  if (operation === 'pivot' && stats && stats.moved === false) {
    await reportProgress(100, 100, 'Pivot already in place');
    return { operation, stats, savedAsset: null, note: 'The pivot was already in place, so no new version was saved.' };
  }

  const savedAsset = await saveMeshVersion(api, asset, resultBuffer, {
    saveMode,
    name: name || `${asset.name || 'Mesh'} (${operation.replace(/_/g, ' ')})`,
    format: outFormat
  });

  notifyMutation(projectId);
  await reportProgress(100, 100, 'Done');
  return { operation, stats, savedAsset: withAssetUrls(api, savedAsset) };
}

export function registerMeshToolTools(server, { api, notifyMutation }) {
  const meshTarget = {
    projectId: z.number().int(),
    assetId: z.number().int().describe('Mesh asset id (from list_assets)')
  };
  const saveFields = {
    saveMode: z.enum(['version', 'replace']).default('version').describe('Save the result as a new version (default) or replace the asset file'),
    name: z.string().optional().describe('Name for the saved result')
  };

  server.registerTool('run_mesh_tool', {
    title: 'Run mesh tool',
    description: 'Run a local mesh-processing tool on a project mesh asset and save the result. Operations: auto_uv (UV unwrap), auto_retopo (retopology), repair (fix non-manifold geometry), auto_rig (skeleton + skin weights), optimize (gltfpack simplification), convert_fbx (GLB→FBX via headless Blender; requires targetFolder), pivot (move the pivot to the ground or the bbox centre). NOTE: every one of these has a dedicated tool that documents and validates its options — auto_uv_mesh, auto_retopo_mesh, repair_mesh, auto_rig_mesh, optimize_mesh, convert_mesh_fbx, move_mesh_pivot — prefer those. Here the options ride along as a free-form object and unset keys fall back to service defaults. Requires the Python mesh-tools service (auto_uv/auto_retopo/repair/convert_fbx) or rigging service (auto_rig) to be running — in the desktop app start them from Settings. Results save as a new version of the asset by default.',
    inputSchema: {
      ...meshTarget,
      operation: z.enum(['auto_uv', 'auto_retopo', 'repair', 'auto_rig', 'optimize', 'convert_fbx', 'pivot']),
      options: z.record(z.string(), z.any()).default({}).describe('Operation options (e.g. {simplify_ratio: 0.5} for optimize, {preset: "unity"} for convert_fbx, {mode: "ground_pivot"} for pivot). See the dedicated tools for the full option list of each.'),
      ...saveFields,
      targetFolder: z.string().optional().describe('convert_fbx only: absolute folder to write the .fbx file into')
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, args, extra)));

  server.registerTool('auto_uv_mesh', {
    title: 'Auto UV unwrap',
    description: 'UV-unwrap a project mesh asset with the Python mesh-tools service (:8200) and save the result as a new version. Every autouv.unwrap() parameter is exposed under `options` with its range and default — set the ones you need; omitted keys use the documented default. Streams progress. Requires the Python mesh-tools service running (start it from Settings in the desktop app).',
    inputSchema: {
      ...meshTarget,
      options: z.object(AUTO_UV_OPTIONS).default({}).describe('Auto UV unwrap parameters. Any subset may be set; unset keys use their default.'),
      ...saveFields
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'auto_uv' }, extra)));

  server.registerTool('auto_retopo_mesh', {
    title: 'Auto retopology',
    description: 'Rebuild clean topology on a project mesh asset with the Python mesh-tools service (:8200) and save the result as a new version. Every autoretopo.RetopoConfig field is exposed under `options` with its range and default — set the ones you need; omitted keys use the documented default. The shell_* options apply only when watertight=true. Streams progress. Requires the Python mesh-tools service running (start it from Settings in the desktop app). Retopology DELETES the surface detail it smooths away — follow it with bake_mesh_maps against the original mesh to capture that detail as a normal map.',
    inputSchema: {
      ...meshTarget,
      options: z.object(AUTO_RETOPO_OPTIONS).default({}).describe('Auto retopology parameters. Any subset may be set; unset keys use their default.'),
      ...saveFields
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'auto_retopo' }, extra)));

  server.registerTool('repair_mesh', {
    title: 'Repair mesh topology',
    description: 'Fix non-manifold geometry on a project mesh asset with the Python mesh-tools service (:8200) — weld coincident verts, drop duplicate/degenerate faces, then remove or split the offending faces and optionally seal the small holes that opens. Targeted cleanup that does NOT rebuild the topology (use auto_retopo_mesh for that). Keep preserve_uv on to save the texture mapping. Streams progress; saves as a new version.',
    inputSchema: {
      ...meshTarget,
      options: z.object(REPAIR_OPTIONS).default({}).describe('Repair parameters. Any subset may be set; unset keys use their default.'),
      ...saveFields
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'repair' }, extra)));

  server.registerTool('auto_rig_mesh', {
    title: 'Auto rig',
    description: 'Generate a skeleton and skin weights for a project mesh asset with the rigging service (SkinTokens/TokenRig, :8300) and save the rigged mesh as a new version. Works best on a single connected humanoid/creature in a roughly A- or T-pose. Keep rename_bones on "mixamo" if the rig will drive retargeted animations. Streams progress. Requires the rigging service running (start it from Settings in the desktop app) — it needs a GPU/ML stack, so it is a heavier dependency than the mesh-tools service.',
    inputSchema: {
      ...meshTarget,
      options: z.object(AUTO_RIG_OPTIONS).default({}).describe('Auto Rig parameters. Any subset may be set; unset keys use their default.'),
      ...saveFields
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'auto_rig' }, extra)));

  server.registerTool('optimize_mesh', {
    title: 'Optimize / simplify mesh',
    description: 'Simplify a project mesh asset with the bundled gltfpack (meshoptimizer) binary and save the result as a new version. Runs in the app backend, so it needs no Python service. IMPORTANT: the requested ratio is often NOT met — always read stats.seam_limited and stats.achieved_ratio rather than assuming it was. When it falls short, raise simplify_error first (it is the cap that binds on most meshes, and it costs nothing in normals or UVs); only reach for allow_seam_breaking if the mesh still will not budge, because that welds attribute seams and reassigns both UVs and normals. To simplify AND keep the look, bake_mesh_maps the original detail onto the result afterwards. For a whole LOD chain use generate_lods instead.',
    inputSchema: {
      ...meshTarget,
      options: z.object(OPTIMIZE_OPTIONS).default({}).describe('Simplification parameters.'),
      ...saveFields
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'optimize' }, extra)));

  server.registerTool('convert_mesh_fbx', {
    title: 'Convert mesh to FBX',
    description: 'Convert a project mesh asset to FBX with headless Blender (Python mesh-tools service) and write it into an absolute folder on this machine. Preserves the skeleton and writes one animation take per clip. The preset tunes the file for the target engine\'s import pipeline. This is an EXPORT — the FBX is written to disk, not saved back as an asset. For a plain GLB copy use export_mesh.',
    inputSchema: {
      ...meshTarget,
      targetFolder: z.string().min(1).describe('Absolute folder to write the .fbx into'),
      options: z.object(CONVERT_OPTIONS).default({}).describe('FBX conversion parameters.'),
      name: z.string().optional().describe('Base name for the .fbx (defaults to the asset name)')
    }
  }, toolHandler((args, extra) => runMeshOperation(api, notifyMutation, { ...args, operation: 'convert_fbx' }, extra)));

  server.registerTool('move_mesh_pivot', {
    title: 'Move mesh pivot',
    description: 'Move a project mesh asset\'s pivot to where an engine expects it, and save the result as a new version. "ground_pivot" drops the mesh onto Y=0 centred on X/Z — a prop that snaps to the floor when placed; "centre_pivot" puts the bounding-box centre on the origin, so the asset rotates about itself. This is the fix for an inspect_mesh pivot failure. Runs in the app backend with no service dependency, and edits the glTF node graph only, so skins, animations, and textures are preserved and any rig moves with the mesh. When the pivot is already in place nothing is saved and the response says so.',
    inputSchema: {
      ...meshTarget,
      mode: z.enum(['ground_pivot', 'centre_pivot']).default('ground_pivot').describe('Where to put the pivot: on the ground under the mesh, or at the bounding-box centre.'),
      ...saveFields
    }
  }, toolHandler((args, extra) => runMeshOperation(
    api,
    notifyMutation,
    { ...args, operation: 'pivot', options: { mode: args.mode || 'ground_pivot' } },
    extra
  )));

  server.registerTool('inspect_mesh', {
    title: 'Game-Ready check',
    description: 'Check a project mesh asset against engine-readiness budgets and return the report — triangle count, UV coverage and overlap, texel density, material/draw-call count, scale sanity, non-manifold geometry, and pivot placement. READ-ONLY: it never modifies the mesh. Each finding carries a pass/warn/fail status and, where one exists, the tool that fixes it (repair_mesh, auto_uv_mesh, auto_retopo_mesh, optimize_mesh, move_mesh_pivot). Set expect_ground_pivot for props and characters. Requires the Python mesh-tools service running.',
    inputSchema: {
      ...meshTarget,
      options: z.object(INSPECT_OPTIONS).default({}).describe('Budgets the check grades against. Any subset may be set; unset keys use their default.')
    },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId, assetId, options = {} }) => {
    const { asset, buffer, fileName } = await loadMeshAsset(api, projectId, assetId);
    const form = new FormData();
    form.append('meshFile', meshBlob(buffer), fileName);
    form.append('options', JSON.stringify(options));
    const report = await api.apiForm('POST', '/meshes/inspect', form);

    // The service names each fix by the Mesh Editor mode that resolves it —
    // which an MCP client cannot act on. Translate to the tool that does the
    // same job here, so the report is directly executable.
    const FIX_TOOLS = {
      optimize: { tool: 'optimize_mesh' },
      repair: { tool: 'repair_mesh' },
      autoretopo: { tool: 'auto_retopo_mesh' },
      autouv: { tool: 'auto_uv_mesh' },
      ground_pivot: { tool: 'move_mesh_pivot', args: { mode: 'ground_pivot' } },
      centre_pivot: { tool: 'move_mesh_pivot', args: { mode: 'centre_pivot' } }
    };
    const checks = (report.checks || []).map(check => {
      const mapped = check.fix ? FIX_TOOLS[check.fix] : null;
      return mapped ? { ...check, fixTool: mapped.tool, ...(mapped.args ? { fixArgs: mapped.args } : {}) } : check;
    });

    return { assetId: asset.id, assetName: asset.name, ...report, checks };
  }));

  server.registerTool('bake_mesh_maps', {
    title: 'Bake high-to-low texture maps',
    description: 'Bake a high-poly mesh\'s detail onto a low-poly one and save the resulting texture maps as project IMAGE assets. This is what makes auto_retopo_mesh and optimize_mesh non-destructive: on their own they return clean topology with the detail deleted, and baking captures that detail as a normal map so the low-poly still reads as the high-poly. The low-poly target MUST have UVs — run auto_uv_mesh first if inspect_mesh reports none. When two or more of ao/roughness/metallic are baked, a packed "orm" texture is returned as well (the layout glTF expects). Streams progress; a 2048px bake takes minutes. Requires the Python mesh-tools service running. ALWAYS read stats.coverage — it is the fraction of the target\'s UV layout the rays actually reached, and a bake that hit a fraction of the mesh still returns a full set of plausible-looking PNGs with the rest blank. Anything below ~0.95 means the source does not match the target (check stats.alignment) or the cage extrusion is too small for detail that sticks out. NOTE: this returns the MAPS — attaching them to the mesh\'s material is a Mesh Editor (browser) operation, so over MCP use them as workflow inputs or wire them up in the engine.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int().describe('Low-poly mesh asset id — the bake TARGET, which must have UVs'),
      sourceAssetId: z.number().int().describe('High-poly mesh asset id — the detail SOURCE that is sampled'),
      options: z.object(BAKE_OPTIONS).default({}).describe('Bake parameters. Any subset may be set; unset keys use their default.'),
      save: z.boolean().default(true).describe('Save each baked map as a project image asset.'),
      targetFolder: z.string().optional().describe('Also write the baked PNGs into this absolute folder.')
    }
  }, toolHandler(async ({ projectId, assetId, sourceAssetId, options = {}, save = true, targetFolder }, extra) => {
    const reportProgress = createProgressReporter(extra);
    const low = await loadMeshAsset(api, projectId, assetId);
    const high = await loadMeshAsset(api, projectId, sourceAssetId);
    await reportProgress(5, 100, `Baking ${high.asset.name || 'high-poly'} onto ${low.asset.name || 'low-poly'}`);

    const form = new FormData();
    form.append('meshFile', meshBlob(low.buffer), low.fileName);
    form.append('sourceFile', meshBlob(high.buffer), high.fileName);
    form.append('options', JSON.stringify(options));

    const done = await api.apiFormSse('/meshes/bake', form, evt => {
      const frac = Number(evt?.frac);
      reportProgress(
        Number.isFinite(frac) ? Math.round(5 + frac * 85) : 50,
        100,
        evt?.message || evt?.stage || 'Baking'
      );
    });

    const base = baseNameOf(low.asset);
    const maps = Object.entries(done.maps || {}).map(([map, base64]) => ({
      map,
      buffer: Buffer.from(base64, 'base64'),
      fileName: `${base}_${map}.png`
    }));
    if (!maps.length) throw new Error('The bake returned no maps.');

    await reportProgress(92, 100, `Saving ${maps.length} map(s)`);

    const savedAssets = [];
    if (save) {
      for (const item of maps) {
        const saved = await saveNewAsset(api, projectId, item.buffer, {
          fileName: item.fileName,
          name: `${base} (${item.map})`,
          type: 'image',
          mime: 'image/png'
        });
        savedAssets.push(withAssetUrls(api, saved));
      }
      notifyMutation(projectId);
    }

    const written = targetFolder
      ? await writeFilesToFolder(api, targetFolder, maps.map(item => ({ buffer: item.buffer, name: item.fileName })))
      : null;

    await reportProgress(100, 100, 'Done');
    return {
      bakedMaps: maps.map(item => ({ map: item.map, bytes: item.buffer.length })),
      stats: done.stats?.tool || done.stats || null,
      savedAssets,
      written
    };
  }));

  server.registerTool('generate_lods', {
    title: 'Generate LOD chain',
    description: 'Build a level-of-detail chain from a project mesh asset with the bundled gltfpack binary. Each level is simplified from the ORIGINAL mesh, not from the level above it — chaining compounds the error. Ratios are ordered LOD0 → LODn; a ratio of 1 means "the source untouched", so the conventional chain starts with 1. Levels are saved as versions of the asset named "<name> LOD<n>" and/or written to a folder. The same caveats as optimize_mesh apply: read seam_limited on each level, and raise simplify_error before allow_seam_breaking. Runs in the app backend, so no Python service is needed. To keep the silhouette readable at distance, bake_mesh_maps each reduced level against the original.',
    inputSchema: {
      ...meshTarget,
      ratios: z.array(z.number().min(0.01).max(1)).min(1).max(8).default([1, 0.5, 0.25, 0.12]).describe('Triangle-count fractions, ordered LOD0 → LODn. At most 8 levels.'),
      simplify_error: z.number().min(0.001).max(1).default(0.05).describe("Surface-deviation cap (gltfpack's -se), applied to every level. Usually the reason a level stops short of its ratio; raising it reaches the target without touching normals or UVs."),
      allow_seam_breaking: z.boolean().default(false).describe('Let the simplifier weld attribute-seam vertices. Off preserves the texture mapping and the hard edges but caps how far a seam-heavy mesh can reduce.'),
      permissive: z.boolean().default(false).describe("gltfpack's -sp. Only applies when allow_seam_breaking is on; measured as a no-op on every mesh tested."),
      aggressive: z.boolean().optional().describe("gltfpack's -sa, the destructive pass that rebuilds the vertex set. Defaults to following allow_seam_breaking; set false to protect shading and accept coarser levels."),
      lock_border: z.boolean().default(false).describe('Pin open-edge vertices so levels do not pull away from neighbouring meshes.'),
      save: z.boolean().default(true).describe('Save each reduced level as a new version of the asset.'),
      targetFolder: z.string().optional().describe('Also write the chain as <name>_LOD<n>.glb into this absolute folder.')
    }
  }, toolHandler(async ({
    projectId, assetId, ratios,
    allow_seam_breaking: allowSeamBreaking = false,
    simplify_error: simplifyError = 0.05,
    permissive = false,
    aggressive,
    lock_border: lockBorder = false,
    save = true, targetFolder
  }, extra) => {
    const reportProgress = createProgressReporter(extra);
    const { asset, buffer, fileName } = await loadMeshAsset(api, projectId, assetId);
    await reportProgress(10, 100, `Generating ${ratios.length} LOD levels`);

    const form = new FormData();
    form.append('meshFile', meshBlob(buffer), fileName);
    form.append('options', JSON.stringify({
      ratios,
      allow_seam_breaking: allowSeamBreaking,
      simplify_error: simplifyError,
      permissive,
      // Left out when unset so the backend keeps following the seam permission,
      // which is what callers written against the old schema expect.
      ...(aggressive == null ? {} : { aggressive }),
      lock_border: lockBorder
    }));
    const done = await api.apiForm('POST', '/meshes/lods', form);

    const base = baseNameOf(asset);
    // A passthrough level carries no mesh: the backend skips gltfpack for ratio 1
    // and returns null rather than echoing bytes the caller already uploaded.
    const levels = (done.lods || []).map(lod => ({
      ...lod,
      buffer: lod.mesh_b64 ? Buffer.from(lod.mesh_b64, 'base64') : buffer,
      fileName: `${base}_LOD${lod.level}.glb`
    }));

    await reportProgress(80, 100, 'Saving levels');

    const savedAssets = [];
    if (save) {
      for (const level of levels) {
        if (level.passthrough) continue; // LOD0 is the asset itself
        const saved = await saveMeshVersion(api, asset, level.buffer, {
          saveMode: 'version',
          name: `${base} LOD${level.level}`
        });
        savedAssets.push(withAssetUrls(api, saved));
      }
      notifyMutation(projectId);
    }

    const written = targetFolder
      ? await writeFilesToFolder(api, targetFolder, levels.map(level => ({ buffer: level.buffer, name: level.fileName })))
      : null;

    await reportProgress(100, 100, 'Done');
    return {
      levels: levels.map(({ level, ratio, triangles, achieved_ratio, seam_limited, seams_broken, passthrough }) => ({
        level, ratio, triangles, achieved_ratio, seam_limited, seams_broken, passthrough
      })),
      savedAssets,
      written
    };
  }));

  server.registerTool('generate_collision', {
    title: 'Generate collision hulls',
    description: 'Generate convex collision hulls for a project mesh asset with the Python mesh-tools service and save them as a SEPARATE mesh asset (a collider is a sibling of the render mesh, not a new version of it). Returns a GLB scene with one node per hull. "convex_hull", "box", and "sphere" are instantaneous single primitives; "decomposition" runs CoACD to approximate a concave shape with several convex parts — the right answer for anything with a cavity, but it costs tens of seconds regardless of triangle count. Engine-specific hull naming (Unreal UCX) happens at export time in the app, not here. Streams progress.',
    inputSchema: {
      ...meshTarget,
      options: z.object(COLLISION_OPTIONS).default({}).describe('Collision parameters. Any subset may be set; unset keys use their default.'),
      save: z.boolean().default(true).describe('Save the hulls as a new project mesh asset named "<name> (collision)".'),
      targetFolder: z.string().optional().describe('Also write the hull GLB into this absolute folder.')
    }
  }, toolHandler(async ({ projectId, assetId, options = {}, save = true, targetFolder }, extra) => {
    const reportProgress = createProgressReporter(extra);
    const { asset, buffer, fileName } = await loadMeshAsset(api, projectId, assetId);
    await reportProgress(5, 100, `Generating collision for ${asset.name || 'mesh'}`);

    const form = new FormData();
    form.append('meshFile', meshBlob(buffer), fileName);
    form.append('options', JSON.stringify(options));
    form.append('format', 'glb');

    const done = await api.apiFormSse('/meshes/collision', form, evt => {
      const frac = Number(evt?.frac);
      reportProgress(
        Number.isFinite(frac) ? Math.round(5 + frac * 85) : 50,
        100,
        evt?.message || evt?.stage || 'Generating collision hulls'
      );
    });

    const hullBuffer = Buffer.from(done.mesh_b64, 'base64');
    const base = baseNameOf(asset);
    const hullFileName = `${base}_collision.glb`;

    await reportProgress(92, 100, 'Saving hulls');

    let savedAsset = null;
    if (save) {
      savedAsset = withAssetUrls(api, await saveNewAsset(api, projectId, hullBuffer, {
        fileName: hullFileName,
        name: `${base} (collision)`,
        type: 'mesh',
        mime: 'model/gltf-binary'
      }));
      notifyMutation(projectId);
    }

    const written = targetFolder
      ? await writeFilesToFolder(api, targetFolder, [{ buffer: hullBuffer, name: hullFileName }])
      : null;

    await reportProgress(100, 100, 'Done');
    return { stats: done.stats || null, savedAsset, written };
  }));

  server.registerTool('export_mesh', {
    title: 'Export mesh file',
    description: 'Copy a project mesh asset\'s file (GLB passthrough) into an absolute folder on this machine. For engine FBX exports (Unity/Unreal) use convert_mesh_fbx instead; for a LOD chain or collision hulls, pass targetFolder to generate_lods / generate_collision.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int(),
      folder: z.string().min(1).describe('Absolute output folder'),
      fileName: z.string().optional().describe('Output file name (defaults to the asset\'s stored file name)')
    }
  }, toolHandler(async ({ projectId, assetId, folder, fileName }) => {
    const { buffer, fileName: storedName } = await loadMeshAsset(api, projectId, assetId);
    return writeFilesToFolder(api, folder, [{ buffer, name: fileName || storedName }]);
  }));
}
