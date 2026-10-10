// Batch stage ACTIONS — what a stage runs.
//
// A stage used to be a ComfyUI workflow and nothing else. It is now an action:
// a ComfyUI workflow, or one of the Mesh Editor's own tools (Optimize, Auto UV,
// Auto Rig, Transfer Rig, Bake) or the Export dialog's Flatten, which run in the
// backend without ComfyUI.
//
// Every built-in action DESCRIBES ITSELF AS A WORKFLOW — `parameters` with a
// valueType and a default, `outputs` with a valueType. That is the whole trick:
// the binding model (manual / variable / earlier stage), validation, default
// seeding and result parenting in document.js were all written against that
// shape, so an Optimize stage's "Target face count" can be bound to a number
// variable, and a Bake stage's two meshes to two earlier stages, with no second
// copy of any of those rules. Only the runner has to know the difference.
//
// Browser-safe and dependency-free, like document.js (which re-exports this):
// the page, the backend runner and the MCP tools all read these descriptors.
// The Node-side execution lives in actionRunner.js.
//
// The defaults mirror the Mesh Editor panels (DEFAULT_SIMPLIFY_OPTIONS,
// DEFAULT_AUTO_UV_OPTIONS, DEFAULT_AUTO_RIG_OPTIONS and DEFAULT_BAKE_OPTIONS in
// src/utils/meshTools.js), which cannot be imported here because that module is
// browser code. The Auto UV list also mirrors AutoUvOptions in
// python-server/app/schemas.py: a field added there needs adding here.

export const BATCH_ACTION_COMFYUI = 'comfyui'
export const BATCH_ACTION_OPTIMIZE = 'optimize'
export const BATCH_ACTION_AUTORETOPO = 'autoretopo'
export const BATCH_ACTION_AUTOUV = 'autouv'
export const BATCH_ACTION_AUTORIG = 'autorig'
export const BATCH_ACTION_TRANSFER_RIG = 'transferrig'
export const BATCH_ACTION_BAKE = 'bake'
export const BATCH_ACTION_FLATTEN = 'flatten'

// Picker order.
export const BATCH_ACTIONS = [BATCH_ACTION_COMFYUI, BATCH_ACTION_OPTIMIZE, BATCH_ACTION_AUTORETOPO, BATCH_ACTION_AUTOUV, BATCH_ACTION_AUTORIG, BATCH_ACTION_TRANSFER_RIG, BATCH_ACTION_BAKE, BATCH_ACTION_FLATTEN]

export const BATCH_ACTION_LABELS = {
  [BATCH_ACTION_COMFYUI]: 'ComfyUI Workflow',
  [BATCH_ACTION_OPTIMIZE]: 'Optimize',
  [BATCH_ACTION_AUTORETOPO]: 'Auto Retopo',
  [BATCH_ACTION_AUTOUV]: 'Auto UV',
  [BATCH_ACTION_AUTORIG]: 'Auto Rig',
  [BATCH_ACTION_TRANSFER_RIG]: 'Transfer Rig',
  [BATCH_ACTION_BAKE]: 'Bake',
  [BATCH_ACTION_FLATTEN]: 'Flatten to Albedo'
}

// A stage written before actions existed has no field and is a ComfyUI stage.
export function normalizeBatchAction(value) {
  return BATCH_ACTIONS.includes(value) ? value : BATCH_ACTION_COMFYUI
}

export function isBuiltInBatchAction(action) {
  return normalizeBatchAction(action) !== BATCH_ACTION_COMFYUI
}

const AUTO_RIG_BONE_NAMES = [
  { value: 'mixamo', label: 'Mixamo' },
  { value: 'ue5', label: 'Unreal Engine 5' },
  { value: 'bird', label: 'Bird (mesh2motion)' },
  { value: 'dragon', label: 'Dragon (mesh2motion)' },
  { value: 'fox', label: 'Fox (mesh2motion)' },
  { value: 'horse', label: 'Horse (mesh2motion)' },
  { value: 'kaiju', label: 'Kaiju (mesh2motion)' },
  { value: 'shark', label: 'Shark (mesh2motion)' },
  { value: 'snake', label: 'Snake (mesh2motion)' },
  { value: 'spider', label: 'Spider (mesh2motion)' },
  { value: 'original', label: 'Keep model names' }
]

// Descriptor fields beyond the workflow shape: `action`, `kanbanColumn` (where the
// result card lands), `desktopService` (which on-demand service the desktop app
// has to start first — see getStageDesktopServices for the conditional one),
// `parentParameterId` (see findParentAssetForStage), `keepsSurface` (the
// action moves no vertex, so a Bake's default high poly looks past it — see
// createStageDefaultBindings) and `producesRig` (the result always has a
// skeleton: what a Transfer Rig's source defaults to, and what its target must
// not be).

// Parameter helpers. `label` is the hint line under the field, `name` the
// field's title — the same split a ComfyUI workflow parameter uses.
const mesh = (id, name, label, extra = {}) => ({ id, name, label, valueType: 'mesh', ...extra })
const number = (id, name, defaultValue, label, range = {}) => ({ id, name, label, valueType: 'number', type: 'number', defaultValue, ...range })
const toggle = (id, name, defaultValue, label) => ({ id, name, label, valueType: 'boolean', type: 'boolean', defaultValue })
const choice = (id, name, defaultValue, label, options) => ({
  id,
  name,
  label,
  valueType: 'string',
  type: 'string',
  defaultValue,
  enums: options.map(option => option.value),
  options
})

// Optimize's switch for re-unwrapping a result whose seams the aggressive pass
// broke. Named here because the runner and the service check read it too.
export const OPTIMIZE_REUNWRAP_PARAMETER = 'auto_uv_if_broken'

// The map checkboxes of the Bake panel, one boolean each so a group can switch
// a pass on or off through a variable like any other value.
export const BAKE_MAP_PARAMETERS = {
  normal: 'bake_normal',
  ao: 'bake_ao',
  base_color: 'bake_base_color',
  roughness: 'bake_roughness',
  metallic: 'bake_metallic'
}

// Flatten's target shaders and the lighting preset each one bakes with — the
// FLATTEN_SHADERS list in src/utils/meshFlatten.js, which the Export dialog
// offers, and LIGHTING in python-server/app/tools/flatten_worker.py.
export const FLATTEN_SHADER_LIGHTING = { unlit: 'studio', lit: 'soft' }

const ACTION_DESCRIPTORS = {
  [BATCH_ACTION_OPTIMIZE]: {
    id: `action:${BATCH_ACTION_OPTIMIZE}`,
    action: BATCH_ACTION_OPTIMIZE,
    name: 'Optimize',
    description: 'Simplifies the mesh with gltfpack (meshoptimizer) down to a target face count, in the backend — no ComfyUI and no Python service. The result is saved as a new version of the input mesh.',
    kanbanColumn: 'Mesh Edit',
    // gltfpack runs inside the backend itself: no service to start.
    desktopService: null,
    parentParameterId: 'mesh',
    outputs: [{ name: 'Mesh', valueType: 'mesh' }],
    parameters: [
      mesh('mesh', 'Mesh', 'The mesh to simplify'),
      number('target_faces', 'Target face count', 5000,
        'Triangles to simplify down to. A mesh already at or below it is left as it is.',
        { min: 1, step: 1 }),
      number('simplify_error', 'Error budget (%)', 5,
        'How far the simplifier may move the surface. This, not the UV seams, is usually what stops a mesh short of its target — raising it reaches the target without touching normals or UVs. gltfpack’s own default is 1%.',
        { min: 0.1, max: 50, step: 0.1 }),
      toggle('simplify_update', 'Optimize vertex positions', false,
        'Move the surviving vertices closer to the original surface (gltfpack -sv). Same triangle count, a better-looking mesh.'),
      toggle('lock_border', 'Lock border vertices', false,
        'Pin vertices on an open edge so a mesh that is one piece of a set does not pull away from its neighbours. Costs some reduction.'),
      toggle('allow_seam_breaking', 'Allow attribute seams to break', false,
        'Weld across UV and normal seams to pass a seam floor — at the cost of the texture and of every hard edge. Raise the error budget first.'),
      toggle('permissive', 'Permissive collapses', false,
        'gltfpack -sp. Only applies when seams may break; measured as a no-op on every mesh tested.'),
      toggle('aggressive', 'Aggressive pass (last resort)', true,
        'gltfpack -sa. Only applies when seams may break: reaches the target by rebuilding the vertex set, so hard edges smooth over and the texture scrambles.'),
      toggle(OPTIMIZE_REUNWRAP_PARAMETER, 'Re-unwrap UVs if seams break', true,
        'When the aggressive pass actually ran, give the result fresh UVs with Auto UV (default settings) so a later Bake has a clean layout to bake onto. The old texture no longer applies either way — bake the base colour from the source to bring it back. Needs the Mesh Tools service, and drops a rig: rig after this stage, not before.')
    ]
  },

  [BATCH_ACTION_AUTORETOPO]: {
    id: `action:${BATCH_ACTION_AUTORETOPO}`,
    action: BATCH_ACTION_AUTORETOPO,
    name: 'Auto Retopo',
    description: 'Rebuilds clean, evenly-spaced topology with the Mesh Tools service, exactly as the Mesh Editor’s Auto Retopo does: a watertight voxel shell, then curvature-adaptive isotropic remeshing down to a face budget, then projection back onto the original surface. Unlike Optimize (which decimates the mesh you give it) this throws the old topology away, so it fixes non-manifold and multi-component ComfyUI output that Optimize can only work around. The result is geometry only — no UVs, no texture, no rig — so put Auto UV, then Bake, then a rig after it. Saved as a new version of the input mesh.',
    kanbanColumn: 'Mesh Edit',
    desktopService: 'meshtools',
    parentParameterId: 'mesh',
    // No keepsSurface: every vertex moves. A later Bake treating this result as
    // its low poly is exactly right, so it must not look past it for a high poly.
    outputs: [{ name: 'Mesh', valueType: 'mesh' }],
    parameters: [
      mesh('mesh', 'Mesh', 'The mesh to retopologize'),
      // Target
      number('target_faces', 'Target face count', 6000,
        'Approximate triangle budget of the result. Unlike Optimize this is a rebuild, so it is hit closely rather than being capped by seams.',
        { min: 50, max: 5000000, step: 1 }),
      toggle('quads', 'Quad-dominant', false,
        'Convert to quad-dominant. Reported in the stats only — the saved GLB is triangles either way, because glTF has no quads.'),
      // Watertight shell
      toggle('watertight', 'Watertight shell', true,
        'Build a unified voxel shell first (robust: closes holes and merges disconnected parts). Turn off to remesh the surface directly and stay closer to the original, which needs input that is already clean.'),
      number('shell_resolution', 'Shell resolution', 256,
        'Voxel grid cells along the longest axis. Raise it for small detail, at the cost of memory and time.',
        { min: 16, max: 1024, step: 8 }),
      number('shell_close_iter', 'Close iterations', 1,
        'Morphological closing passes that bridge cracks in non-watertight input.', { min: 0, max: 20, step: 1 }),
      number('shell_smooth', 'Smooth (sigma)', 0.4,
        'SDF blur in voxels. The default suits characters, creatures and vegetation, where the blur mostly costs small detail (pointed hats, fingers, thin branches) because the remesh and projection stages already remove most ripple. Raise it toward 1.4 for buildings and hard-surface models, where flat walls are what voxel staircase shows on.',
        { min: 0, max: 5, step: 0.05 }),
      number('shell_taubin', 'Taubin polish', 10,
        'Taubin smoothing steps on the dense shell (0 disables).', { min: 0, max: 100, step: 1 }),
      number('shell_samples_per_pitch', 'Samples / pitch', 2,
        'Surface sampling density; 2 or more guarantees gap-free voxel coverage.', { min: 1, max: 8, step: 0.5 }),
      number('max_memory_gb', 'Max memory (GB)', 4,
        'Auto-lower the shell resolution to fit this budget (0 disables). Worth keeping on in a batch, where one oversized mesh would otherwise stall the whole run.',
        { min: 0, max: 128, step: 0.5 }),
      // Remesh
      toggle('adaptive', 'Curvature-adaptive', true, 'Spend more faces where the surface bends'),
      number('remesh_iters', 'Remesh iterations', 10, 'Isotropic remesh passes', { min: 1, max: 100, step: 1 }),
      number('feature_deg', 'Feature angle (°)', 30, 'Crease angle preserved as a feature', { min: 0, max: 180, step: 1 }),
      number('calibrate_passes', 'Calibrate passes', 1, 'Rough edge-length correction passes', { min: 0, max: 10, step: 1 }),
      // Feature preservation
      toggle('preserve_features', 'Preserve features', false,
        'Hard-surface mode: keep sharp creases crisp and skip smoothing/projection. For architecture and props, not characters.'),
      number('feature_angle', 'Hard-edge angle (°)', 25,
        'Crease angle treated as a hard edge when Preserve features is on', { min: 0, max: 180, step: 1 }),
      // Projection
      toggle('project', 'Project to surface', true, 'Pull the remesh back onto the original surface'),
      number('project_iters', 'Projection iterations', 10, '', { min: 0, max: 100, step: 1 }),
      number('project_clamp', 'Move clamp', 1.5,
        'Max per-vertex move as a multiple of local edge length', { min: 0, max: 10, step: 0.1 }),
      number('relax_strength', 'Relax strength', 0.4,
        'Tangential relaxation factor per iteration', { min: 0, max: 1, step: 0.05 }),
      // Compute
      choice('device', 'Device', 'auto', 'The shell and projection stages run on an NVIDIA GPU when one is available; the remesh stage is always CPU.', [
        { value: 'auto', label: 'Auto (GPU if NVIDIA)' },
        { value: 'cpu', label: 'CPU' },
        { value: 'cuda', label: 'CUDA (NVIDIA GPU)' }
      ]),
      number('seed', 'Seed', 0, 'RNG seed for reproducibility', { min: 0, step: 1 })
    ]
  },

  [BATCH_ACTION_AUTOUV]: {
    id: `action:${BATCH_ACTION_AUTOUV}`,
    action: BATCH_ACTION_AUTOUV,
    name: 'Auto UV',
    description: 'Unwraps new UVs with the Mesh Tools service, exactly as the Mesh Editor’s Auto UV does. Use it before a Bake when the mesh has no UVs or broken ones — a ComfyUI mesh without UVs, or an Optimize whose aggressive pass scrambled them. The result carries a plain material (the old texture no longer fits the new layout) and no rig, so bake after it and rig after that. Saved as a new version of the input mesh.',
    kanbanColumn: 'Mesh Edit',
    desktopService: 'meshtools',
    parentParameterId: 'mesh',
    keepsSurface: true,
    outputs: [{ name: 'Mesh', valueType: 'mesh' }],
    parameters: [
      mesh('mesh', 'Mesh', 'The mesh to unwrap'),
      // Segmentation
      number('max_cone_deg', 'Normal-cone cap (°)', 50, 'Higher = fewer, more distorted charts', { min: 1, max: 180, step: 1 }),
      number('sharp_weight', 'Sharp-edge weight', 0.35, 'How strongly sharp edges attract seams', { min: 0, max: 1, step: 0.01 }),
      number('fold_cap_deg', 'Fold cap (°)', 88, 'Dihedral fold angle that forces a seam', { min: 1, max: 180, step: 1 }),
      number('min_faces', 'Min faces / chart', 20, 'Charts smaller than this are dissolved into neighbours', { min: 1, max: 100000, step: 1 }),
      number('min_area_frac', 'Min area fraction', 0.004, 'Min chart area as a fraction of total surface area', { min: 0, max: 1, step: 0.001 }),
      // Refinement
      toggle('refine', 'Validated merge pass', true, 'LSCM-validated chart merge (off = faster, more charts)'),
      number('refine_target_faces', 'Merge below faces', 80, 'Charts below this face count are merge candidates', { min: 1, max: 100000, step: 1 }),
      number('refine_ad_thresh', 'Merge distortion cap', 1.32, 'Max angle-distortion ratio a merge may introduce', { min: 1, max: 10, step: 0.01 }),
      // Seam placement
      toggle('hide_seams', 'Hide seams', true, 'Price seams by visibility (occlusion + concavity) so they move into creases and hidden places'),
      number('hide_strength', 'Hide strength', 1, 'How much more a seam costs on open surface than in a hidden crease', { min: 0, max: 4, step: 0.1 }),
      toggle('refine_borders', 'Move borders to creases', true, 'Re-route every chart border along the cheapest nearby path: shorter, straighter, on sharp or hidden edges'),
      number('border_rings', 'Border reach (rings)', 4, 'How many face rings either side of a border it may move', { min: 1, max: 16, step: 1 }),
      // Parameterization
      choice('method', 'Method', 'auto', 'Per-chart flattening method', [
        { value: 'auto', label: 'Auto' },
        { value: 'lscm', label: 'LSCM' },
        { value: 'arap', label: 'ARAP' },
        { value: 'planar', label: 'Planar' }
      ]),
      number('arap_iters', 'ARAP iterations', 4, '0 disables ARAP (LSCM/planar only)', { min: 0, max: 100, step: 1 }),
      toggle('ensure_disks', 'Cut non-disk charts', true, 'Open tubes, closed shells and handled charts with the cheapest cut so they flatten without folding'),
      // Packing
      {
        ...number('resolution', 'Atlas resolution', 1024, 'Sizes the padding between islands — set it to the resolution the Bake will use, or islands bleed into each other at that size.'),
        enums: [256, 512, 1024, 2048, 4096, 8192]
      },
      number('padding_texels', 'Padding (texels)', 4, 'Inter-island padding at the atlas resolution', { min: 0, max: 64, step: 1 }),
      // Topology repair
      toggle('weld', 'Proximity weld', true, 'Weld coincident verts before unwrapping (stitches shattered shells)'),
      number('weld_tol_frac', 'Weld tolerance', 0.1, 'As a fraction of median edge length', { min: 0, max: 1, step: 0.01 }),
      // Shading
      toggle('preserve_normals', 'Preserve normals', true, 'Carry the mesh’s own vertex normals through the unwrap, so shading is unchanged'),
      number('normal_smooth_deg', 'Smoothing angle (°)', 180, 'Used when normals are rebuilt (none in the file, or Preserve off): edges sharper than this stay hard. 180 = fully smooth', { min: 0, max: 180, step: 1 })
    ]
  },

  [BATCH_ACTION_AUTORIG]: {
    id: `action:${BATCH_ACTION_AUTORIG}`,
    action: BATCH_ACTION_AUTORIG,
    name: 'Auto Rig',
    description: 'Generates a skeleton and skin weights with the SkinTokens rigging service (Settings → Rigging, NVIDIA GPU). The rigged mesh is saved as a new version of the input mesh.',
    kanbanColumn: 'Rigging',
    desktopService: 'rigging',
    parentParameterId: 'mesh',
    producesRig: true,
    outputs: [{ name: 'Rigged mesh', valueType: 'mesh' }],
    parameters: [
      mesh('mesh', 'Mesh', 'The mesh to rig — a single character, facing the front view'),
      choice('rename_bones', 'Bone names', 'mixamo',
        'Rename the generated bones to a standard convention for retargeting', AUTO_RIG_BONE_NAMES),
      toggle('use_transfer', 'Preserve texture & scale', true,
        'Transfer the rig onto your original mesh (keeps its texture and scale). Recommended — leave on.'),
      toggle('use_postprocess', 'Voxel-skin postprocess', false,
        'Clean up skin weights with a voxel pass to reduce bleed across disconnected parts'),
      toggle('keep_loaded', 'Keep model loaded in memory', true,
        'Keep the rig model in GPU memory between cells — a batch rigs many meshes in a row, so leave this on.'),
      number('top_k', 'Top-k', 5, 'Top-k sampling', { min: 1, max: 200, step: 1 }),
      number('top_p', 'Top-p', 0.95, 'Nucleus (top-p) sampling', { min: 0.1, max: 1, step: 0.01 }),
      number('temperature', 'Temperature', 0.7, 'Sampling temperature', { min: 0.1, max: 2, step: 0.1 }),
      number('repetition_penalty', 'Repetition penalty', 1.1,
        'Kept almost off on purpose: a real penalty is what makes a rig come back without fingers', { min: 0.5, max: 3, step: 0.1 }),
      number('num_beams', 'Beams', 15, 'Beam-search width', { min: 1, max: 20, step: 1 }),
      number('length_penalty', 'Length penalty', 2,
        'Above 1.0 favours skeletons with MORE bones — raise it when rigs stop short of the fingers or the tail', { min: 0.5, max: 3, step: 0.05 })
    ]
  },

  [BATCH_ACTION_TRANSFER_RIG]: {
    id: `action:${BATCH_ACTION_TRANSFER_RIG}`,
    action: BATCH_ACTION_TRANSFER_RIG,
    name: 'Transfer Rig',
    description: 'Copies the skeleton and skin weights of an already-rigged mesh onto this one, exactly as the Mesh Editor’s “Transfer Rig From Mesh” does — typically the high poly’s Auto Rig onto the optimized, baked low poly, so every version shares one skeleton. Runs in the backend: no service and no GPU. Animation clips are not copied. Saved as a new version of the target mesh.',
    kanbanColumn: 'Rigging',
    // The transfer runs inside the backend itself: no service to start.
    desktopService: null,
    parentParameterId: 'mesh',
    // It adds a skeleton and weights and moves no vertex.
    keepsSurface: true,
    producesRig: true,
    outputs: [{ name: 'Rigged mesh', valueType: 'mesh' }],
    parameters: [
      mesh('mesh', 'Mesh (target)', 'The mesh to rig. It must not have a skeleton yet — an Auto UV, or an Optimize that re-unwrapped, drops one; a plain Optimize or a Bake keeps it.'),
      // Seeded from the nearest earlier stage that produces a rig, not from a
      // fixed distance back: the chain between the rig and this stage varies.
      mesh('rig_source', 'Rigged mesh (source)', 'The mesh whose skeleton and weights are copied — usually an Auto Rig stage, or a rigged library mesh. It must be the same shape in the same place; a uniform difference in scale is corrected.', { defaultUpstreamRig: true }),
      number('smooth_iters', 'Weight smoothing', 2,
        'Averaging passes over the transferred weights. Softens the hard line a sparse mesh picks up where the nearest source point flips from one bone to another; too many wash small parts toward one bone.',
        { min: 0, max: 4, step: 1 })
    ]
  },

  [BATCH_ACTION_BAKE]: {
    id: `action:${BATCH_ACTION_BAKE}`,
    action: BATCH_ACTION_BAKE,
    name: 'Bake',
    description: 'Bakes the high-poly mesh’s detail onto the low-poly mesh’s UVs with headless Blender (Mesh Tools service), then applies the maps to the low-poly’s material. The textured low-poly is saved as a new version of it.',
    kanbanColumn: 'Texturing',
    desktopService: 'meshtools',
    // The result is the LOW-poly with maps on it, so that is what it is filed
    // under — never the high-poly, even though both are meshes.
    parentParameterId: 'low_poly',
    outputs: [{ name: 'Baked mesh', valueType: 'mesh' }],
    parameters: [
      // Seeded from the stage right before this one: the usual chain is
      // generate -> optimize/retopo -> bake, where the reduced mesh comes last…
      mesh('low_poly', 'Low poly (target)', 'The mesh the maps are baked onto — it must have UVs', { defaultUpstreamOffset: 1 }),
      // …and the detailed one the stage before that.
      mesh('high_poly', 'High poly (source)', 'The mesh whose detail is captured', { defaultUpstreamOffset: 2 }),
      toggle(BAKE_MAP_PARAMETERS.normal, 'Normal map', true, 'Tangent-space normal — the lost surface detail'),
      toggle(BAKE_MAP_PARAMETERS.ao, 'Ambient occlusion', true, 'Contact shadow'),
      toggle(BAKE_MAP_PARAMETERS.base_color, 'Base colour', false, 'Transfer the high poly’s texture onto the low poly’s UVs'),
      toggle(BAKE_MAP_PARAMETERS.roughness, 'Roughness', false, 'Resample the source’s roughness'),
      toggle(BAKE_MAP_PARAMETERS.metallic, 'Metallic', false, 'Resample the source’s metallic'),
      {
        ...number('resolution', 'Resolution', 2048, 'Map size in pixels. Cost scales with the square of this.'),
        enums: [512, 1024, 2048, 4096]
      },
      number('samples', 'Samples', 8, 'Only the AO pass is noisy enough to need more than a few', { min: 1, max: 512, step: 1 }),
      number('cage_extrusion', 'Cage extrusion (m)', 0,
        'How far the rays start outside the surface. 0 scales it to the mesh (2% of its bounding-box diagonal), which is right far more often than any fixed distance.',
        { min: 0, max: 10, step: 0.005 }),
      number('margin', 'Margin (texels)', 8, 'Dilates the baked islands so filtering cannot bleed the empty gutter into seams', { min: 0, max: 64, step: 1 }),
      toggle('align_source', 'Align source to mesh', true,
        'Re-centre (and uniformly rescale) a high poly that sits elsewhere, so the rays find it'),
      toggle('require_overlap', 'Refuse a source that does not overlap', true,
        'Stop in seconds rather than spend minutes returning blank maps')
    ]
  },

  [BATCH_ACTION_FLATTEN]: {
    id: `action:${BATCH_ACTION_FLATTEN}`,
    action: BATCH_ACTION_FLATTEN,
    name: 'Flatten to Albedo',
    description: 'The Export dialog’s “Flatten to one lit albedo (mobile)”, as a stage: bakes every material’s whole look — normal detail, occlusion, roughness, metal — into ONE colour texture under a neutral studio light, and gives the mesh one material that uses it. Specular highlights and cast shadows are left out on purpose. The existing UV islands are repacked into one atlas rather than re-unwrapped, so a rig, its skin weights and its animation clips come through unchanged. Runs a lit Cycles bake on the Mesh Tools service. Saved as a new version of the input mesh.',
    kanbanColumn: 'Texturing',
    desktopService: 'meshtools',
    parentParameterId: 'mesh',
    // Only a UV set, the materials and (for faces with no UVs) copies of
    // existing vertices change: a Bake after it still sees the same shape.
    keepsSurface: true,
    outputs: [{ name: 'Flattened mesh', valueType: 'mesh' }],
    parameters: [
      mesh('mesh', 'Mesh', 'The mesh to flatten. Most of it needs UVs — put an Auto UV stage first for a mesh that has none'),
      choice('shader', 'Target shader', 'unlit',
        'Unlit bakes a soft dome and a gentle top key light, since the texture is the only light the mesh gets, and saves the material unlit (KHR_materials_unlit). Simple lit bakes occlusion and a soft fill only — the game’s own light supplies the direction — and saves a rough, non-metal material.',
        [
          { value: 'unlit', label: 'Unlit — studio lighting baked in' },
          { value: 'lit', label: 'Simple lit — occlusion and soft fill only' }
        ]),
      {
        ...number('resolution', 'Resolution', 2048, 'Albedo size in pixels. Cost scales with the square of this.'),
        enums: [512, 1024, 2048, 4096]
      },
      {
        ...number('samples', 'Samples', 64, 'Cycles samples per texel. 16 is a preview; raise it if cavities look grainy.'),
        enums: [16, 32, 64, 128, 256]
      },
      number('exposure', 'Exposure (stops)', 0,
        'Applied before the highlight roll-off. Lower it if the result looks washed out.',
        { min: -3, max: 3, step: 0.25 })
    ]
  }
}

export function getBatchActionDescriptor(action) {
  return ACTION_DESCRIPTORS[normalizeBatchAction(action)] || null
}

// The service options an action's non-mesh parameters stand for. Resolved
// inputs in, the options object out; an input that is absent falls back to the
// descriptor's default, which is how Optimize's re-unwrap runs Auto UV at its
// defaults. Shared by the two actions that forward a whole options object to a
// Python-service schema, so neither can drift from its descriptor.
function collectActionOptions(action, inputs = {}) {
  const options = {}
  for (const parameter of ACTION_DESCRIPTORS[action].parameters) {
    if (parameter.valueType === 'mesh') continue
    const value = inputs[parameter.id]
    if (parameter.valueType === 'boolean') {
      options[parameter.id] = value === undefined ? parameter.defaultValue : value === true
    } else if (parameter.valueType === 'number') {
      const number = Number(value)
      options[parameter.id] = value === undefined || value === '' || !Number.isFinite(number) ? parameter.defaultValue : number
    } else {
      options[parameter.id] = value === undefined || value === '' ? parameter.defaultValue : String(value)
    }
  }
  return options
}

// As the service's AutoUvOptions reads them.
export function getAutoUvActionOptions(inputs = {}) {
  return collectActionOptions(BATCH_ACTION_AUTOUV, inputs)
}

// As the service's AutoRetopoOptions reads them.
export function getAutoRetopoActionOptions(inputs = {}) {
  return collectActionOptions(BATCH_ACTION_AUTORETOPO, inputs)
}

// Could this boolean be on in some group? A manual value says so outright; a
// variable binding cannot be known until a group is picked, so it counts.
function mightBeOn(stage, parameterId) {
  if (stage?.bindings?.[parameterId]?.source === 'variable') return true
  return stage?.inputs?.[parameterId] === true
}

// The on-demand desktop services a stage needs started before the run. Usually
// the descriptor's own; Optimize needs Mesh Tools only when its re-unwrap could
// actually fire, which takes all three of the switches that lead to it.
export function getStageDesktopServices(stage) {
  const action = normalizeBatchAction(stage?.action)
  const descriptor = getBatchActionDescriptor(action)
  const services = descriptor?.desktopService ? [descriptor.desktopService] : []
  if (action === BATCH_ACTION_OPTIMIZE
    && mightBeOn(stage, 'allow_seam_breaking')
    && mightBeOn(stage, 'aggressive')
    && mightBeOn(stage, OPTIMIZE_REUNWRAP_PARAMETER)) {
    services.push('meshtools')
  }
  return services
}

// The glTF material slots a bake can fill. A lone roughness or metallic map has
// nowhere to go: glTF stores both in ONE texture (G = roughness, B = metallic),
// and a grey single-channel bake would write the same value into both. The
// service only packs them into that texture when two or more of
// AO/roughness/metallic are baked, so a lone one is refused up front.
const ORM_MAPS = ['ao', 'roughness', 'metallic']

export function getBakeActionMaps(inputs) {
  return Object.entries(BAKE_MAP_PARAMETERS)
    .filter(([, parameterId]) => inputs?.[parameterId] === true)
    .map(([map]) => map)
}

export function describeBakeMapProblem(maps) {
  if (!maps || maps.length === 0) {
    return 'Pick at least one map to bake'
  }
  const orm = maps.filter(map => ORM_MAPS.includes(map))
  if (orm.length === 1 && orm[0] !== 'ao') {
    return `${orm[0] === 'roughness' ? 'Roughness' : 'Metallic'} alone cannot be applied to a glTF material — bake it together with AO${orm[0] === 'roughness' ? ' or metallic' : ' or roughness'}, which packs them into the one texture glTF expects`
  }
  return null
}
