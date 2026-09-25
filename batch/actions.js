// Batch stage ACTIONS — what a stage runs.
//
// A stage used to be a ComfyUI workflow and nothing else. It is now an action:
// a ComfyUI workflow, or one of the Mesh Editor's own tools (Optimize, Auto Rig,
// Bake), which run in the backend without ComfyUI.
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
// DEFAULT_AUTO_RIG_OPTIONS and DEFAULT_BAKE_OPTIONS in src/utils/meshTools.js),
// which cannot be imported here because that module is browser code.

export const BATCH_ACTION_COMFYUI = 'comfyui'
export const BATCH_ACTION_OPTIMIZE = 'optimize'
export const BATCH_ACTION_AUTORIG = 'autorig'
export const BATCH_ACTION_BAKE = 'bake'

// Picker order.
export const BATCH_ACTIONS = [BATCH_ACTION_COMFYUI, BATCH_ACTION_OPTIMIZE, BATCH_ACTION_AUTORIG, BATCH_ACTION_BAKE]

export const BATCH_ACTION_LABELS = {
  [BATCH_ACTION_COMFYUI]: 'ComfyUI Workflow',
  [BATCH_ACTION_OPTIMIZE]: 'Optimize',
  [BATCH_ACTION_AUTORIG]: 'Auto Rig',
  [BATCH_ACTION_BAKE]: 'Bake'
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
// has to start first) and `parentParameterId` (see findParentAssetForStage).

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

// The map checkboxes of the Bake panel, one boolean each so a group can switch
// a pass on or off through a variable like any other value.
export const BAKE_MAP_PARAMETERS = {
  normal: 'bake_normal',
  ao: 'bake_ao',
  base_color: 'bake_base_color',
  roughness: 'bake_roughness',
  metallic: 'bake_metallic'
}

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
        'gltfpack -sa. Only applies when seams may break: reaches the target by rebuilding the vertex set, so hard edges smooth over and the texture scrambles.')
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
  }
}

export function getBatchActionDescriptor(action) {
  return ACTION_DESCRIPTORS[normalizeBatchAction(action)] || null
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
