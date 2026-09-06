// MCP server for 3D Gen Studio.
//
// Exposes the app's headless capabilities (projects, kanban cards, node graph,
// ComfyUI workflows, AI actions, mesh tools, assets) as MCP tools so any MCP
// client — Claude Desktop/Code, ChatGPT, local LLM stacks — can automate the
// app. Tools call the running backend over loopback HTTP (see client.js).
//
// Context cost: a client injects the WHOLE tool catalog into the model's system
// prompt on every request, before it reads the user's message. The full 67-tool
// catalog is ~91 KB of JSON (~25k tokens) plus ~5 KB of instructions. Clients
// that load tool schemas lazily pay almost nothing; the rest pay it per session.
// For those, TOOL_GROUPS below lets a client load only the groups it needs —
// see resolveGroups(). Instructions are assembled to match (buildInstructions),
// so dropping a group drops its guidance too.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createApiClient } from './client.js';
import { registerProjectTools } from './tools/projects.js';
import { registerCardTools } from './tools/cards.js';
import { registerGraphTools } from './tools/graph.js';
import { registerWorkflowTools } from './tools/workflows.js';
import { registerActionTools } from './tools/actions.js';
import { registerMeshToolTools } from './tools/meshTools.js';
import { registerAssetTools } from './tools/assets.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerTreeTools } from './tools/tree.js';

function readAppVersion() {
  try {
    const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'))?.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readAppVersion();

// Selectable tool groups, with the approximate tools/list cost of each in chars
// (~3.6 chars per token) so a client can budget its context. The cost figures
// are documentation, not logic — refresh them when tools are added or reworded.
const TOOL_GROUPS = {
  projects: { register: registerProjectTools, cost: 4035 },
  cards: { register: registerCardTools, cost: 4437 },
  graph: { register: registerGraphTools, cost: 5266 },
  workflows: { register: registerWorkflowTools, cost: 8957 },
  actions: { register: registerActionTools, cost: 19385 },
  mesh: { register: registerMeshToolTools, cost: 31972 },
  tree: { register: registerTreeTools, cost: 6200 },
  assets: { register: registerAssetTools, cost: 12542 },
  settings: { register: registerSettingsTools, cost: 1684 }
};

const GROUP_NAMES = Object.keys(TOOL_GROUPS);

// Aliases so a client may use the source-file name it sees in the docs.
const GROUP_ALIASES = {
  meshtools: 'mesh', meshtool: 'mesh', project: 'projects', card: 'cards',
  asset: 'assets', workflow: 'workflows', action: 'actions', setting: 'settings',
  trees: 'tree', treegen: 'tree'
};

function normalizeGroup(raw) {
  const key = String(raw).trim().toLowerCase();
  return GROUP_ALIASES[key] || (GROUP_NAMES.includes(key) ? key : null);
}

// Turn a group selector into the ordered list of groups to register.
//
// Accepts a comma/space-separated string or an array, in two forms:
//   include — "projects,graph,workflows"  -> exactly those groups
//   exclude — "-mesh,-actions"            -> everything EXCEPT those
// Mixing both applies the includes first, then subtracts the excludes. Empty,
// absent or "all" means every group, so no working client changes behaviour by
// upgrading.
//
// Unknown names are warned about on stderr and skipped rather than thrown: a
// typo in a client config should not take the server down. A selector that
// resolves to nothing falls back to all groups for the same reason.
export function resolveGroups(selector) {
  const terms = (Array.isArray(selector) ? selector : String(selector ?? '').split(/[,\s]+/))
    .map(term => String(term).trim())
    .filter(Boolean);

  if (terms.length === 0 || terms.some(term => term.toLowerCase() === 'all')) return [...GROUP_NAMES];

  const includes = [];
  const excludes = new Set();
  const unknown = [];

  for (const term of terms) {
    const negated = term.startsWith('-') || term.startsWith('!');
    const name = normalizeGroup(negated ? term.slice(1) : term);
    if (!name) { unknown.push(term); continue; }
    if (negated) excludes.add(name); else includes.push(name);
  }

  if (unknown.length > 0) {
    console.error(`[mcp] ignoring unknown tool group(s): ${unknown.join(', ')}. Valid groups: ${GROUP_NAMES.join(', ')}`);
  }

  // With no positive terms the selector means "everything, minus the excludes".
  const base = includes.length > 0 ? includes : GROUP_NAMES;
  const selected = GROUP_NAMES.filter(name => base.includes(name) && !excludes.has(name));

  if (selected.length === 0) {
    console.error('[mcp] tool-group selector matched no groups — loading all groups instead.');
    return [...GROUP_NAMES];
  }
  return selected;
}

// Server instructions, split so each block ships only when the tools it talks
// about are loaded. `groups` lists every group that must be present for the
// block to be worth its bytes.
const INSTRUCTION_BLOCKS = [
  {
    groups: ['projects', 'graph'],
    text: '- New pipeline: create_project (preset "graph") -> create_node / connect_nodes to lay out the pipeline -> run_workflow or generate_image / generate_mesh to produce assets.'
  },
  {
    groups: ['graph'],
    text: '- IMPORTANT (graph projects): always pass nodeId to run_workflow / generate_image / edit_image / generate_mesh so the results are DISPLAYED on that node. Without nodeId the assets are saved but no node shows them. The first result becomes the node\'s image/mesh; extra results become new nodes stacked below it.'
  },
  {
    groups: ['graph'],
    text: '- IMPORTANT ordering: connect_nodes to wire a node\'s input asset(s) BEFORE you run_workflow / edit_image / generate_mesh on it. The run reads the node\'s connected input at execution time — it feeds the workflow/API and decides whether the result is saved as an edit of the connected image / a version of the connected mesh. Running first and connecting afterwards is wrong: the run sees no input, so it uses none and saves a stray new root asset, and the late connection does not re-run or re-parent it. If you got the order wrong, delete the stray result, connect the inputs, then run again.'
  },
  {
    groups: ['workflows'],
    text: '- run_workflow inputs is a FLAT map of parameter id -> BARE value: {"6.text": "a red robot", "7.noise_seed": 42}. Never wrap a value in an object or an array — {"6.text": {"value": "a red robot"}} is wrong. Parameter ids come from list_workflows and look like "<nodeId>.<inputKey>"; pass them exactly, and only for the parameters you want to change (an omitted parameter keeps its saved default). An unknown id or a wrapped value is rejected with an error listing the workflow\'s real parameter ids.'
  },
  {
    groups: ['workflows'],
    text: '- ComfyUI: list_workflows returns a COMPACT SUMMARY (id, name, parameter counts) — the library is far too large to return in full. Find the one you want, then call list_workflows again with its name (or workflowId) to get the parameters run_workflow needs. Do not ask for detail:"full" across the whole library. import_workflow adds new ones (inspect_workflow first to discover inputs/outputs). run_workflow blocks with progress until the assets are ready. ComfyUI itself must be running (URL in get_settings).'
  },
  {
    groups: ['workflows', 'graph'],
    text: '- ComfyUI image/mesh (file) parameters are filled AUTOMATICALLY from the target node\'s wired inputs (matched by type) — so for a node whose inputs are connected, do NOT pass inputs for file parameters (no need to guess their ids); just connect_nodes then run_workflow with nodeId. Only set a file-parameter input to override a wired input or when nothing is connected. Set inputs only for non-file parameters (string/number/boolean) you want to change.'
  },
  {
    groups: ['workflows'],
    text: '- When you DO pass an image/mesh (file) parameter in inputs (e.g. in a kanban project with no wiring), the value is just the asset\'s numeric id — nothing else. The SAME plain id works for a root asset, an edit, or a version (a background-removed image is an edit → pass that edit\'s own id, found in the children/edits tree from list_assets). Do NOT pass a file path/filename or a {assetId, editId} object; a bare id is correct.'
  },
  {
    groups: ['workflows', 'actions'],
    text: '- Parent linkage is AUTOMATIC — do NOT manage parentAssetId yourself. run_workflow saves its output under the source it was derived from (the image/mesh input matching the output type, wired or passed in inputs): an image output becomes an edit of that image, a mesh output a version of that mesh. edit_image already saves an edit of its imageSource, and run_mesh_tool saves a version of its assetId. So a re-texture (image+mesh in, mesh out) versions the input mesh, and a background-removal (image in, image out) edits the input image, with no parentAssetId needed. Only pass parentAssetId to override the inferred parent.'
  },
  {
    groups: ['mesh'],
    text: '- Mesh processing: every Mesh Editor mode with a service behind it has its own tool, each documenting its full option set — auto_uv_mesh, auto_retopo_mesh, repair_mesh, auto_rig_mesh, optimize_mesh, generate_lods, bake_mesh_maps, generate_collision, move_mesh_pivot, inspect_mesh, convert_mesh_fbx. run_mesh_tool is the untyped fallback for the same operations. Results save as new versions of the mesh asset, except collision hulls and baked maps, which are saved as separate assets.'
  },
  {
    groups: ['mesh'],
    text: '- Finishing a mesh for an engine: inspect_mesh FIRST — it grades triangles, UVs, texel density, materials, scale, manifoldness, and pivot, and each finding names the tool that fixes it. Typical order: repair_mesh (bad topology) -> auto_retopo_mesh or optimize_mesh (triangle budget) -> auto_uv_mesh (missing/overlapping UVs) -> bake_mesh_maps against the ORIGINAL high-poly (put the lost detail back as a normal map) -> move_mesh_pivot -> generate_lods / generate_collision -> convert_mesh_fbx or export_mesh. Re-run inspect_mesh at the end to confirm.'
  },
  {
    groups: ['mesh'],
    text: '- Simplification caveat: gltfpack (optimize_mesh, generate_lods) will not collapse vertices on a UV seam, so a textured mesh can barely reduce until allow_seam_breaking is on. Always read stats.achieved_ratio and stats.seam_limited instead of assuming the requested ratio was met.'
  },
  {
    groups: ['assets'],
    text: '- Asset tags: free-form labels for finding assets later. list_asset_tags (no assetId) shows the vocabulary in use with counts — read it before inventing a tag; tag_asset adds/removes/replaces the tags of one asset (root asset, image edit or mesh version); find_assets_by_tags searches the whole library across projects (every tag must match unless matchAll=false). Tags are normalized server-side (trimmed, whitespace-collapsed, lower-cased), so "Sci-Fi" and "sci-fi " are the same tag — but "sci-fi" and "sci fi" are not.'
  },
  {
    groups: ['assets'],
    text: '- Seeing results: use view_asset to LOOK at a generated image (returns the actual image; for meshes it returns the thumbnail when available). Use download_asset to save any asset file to a local folder. Assets also carry direct download URLs in every response.'
  },
  {
    groups: ['tree'],
    text: '- Procedural trees: list_tree_presets -> preview_tree_skeleton (fast, no mesh) to settle the shape -> generate_tree to build and save it. The tree IS its spec: a seeded ~2KB document reproduces the mesh exactly, so vary `seed` for variations and patch `overrides` for changes, rather than trying to edit the resulting mesh. Trees are not project-scoped; omit projectId to save to the global library.'
  }
];

const INSTRUCTIONS_HEADER = '3D Gen Studio automation server.\n\nTypical flows:';

const INSTRUCTIONS_FOOTER = 'Note: the interactive Mesh Editor modes that run in the browser — sculpting, modeling, displace, painting, projection, and APPLYING baked maps to a material — are not exposed here, and neither are Image Editor pixel edits. Running a bake IS available (bake_mesh_maps); it returns the maps as image assets. Animation retargeting (the Auto Rig > Animations tab) is browser-only too. If the app UI is open in a browser, it may need a refresh to show changes made through these tools.';

// Assemble instructions for the loaded groups, naming what was left out so a
// model reports a missing tool group as "not exposed here" rather than
// concluding the app cannot do it at all.
export function buildInstructions(groups) {
  const loaded = new Set(groups);
  const bullets = INSTRUCTION_BLOCKS
    .filter(block => block.groups.every(group => loaded.has(group)))
    .map(block => block.text);

  const omitted = GROUP_NAMES.filter(name => !loaded.has(name));
  // Header and bullets are one block (no blank line between them), then a blank
  // line before each following block.
  const parts = [[INSTRUCTIONS_HEADER, ...bullets].join('\n'), INSTRUCTIONS_FOOTER];
  if (omitted.length > 0) {
    parts.push(`Tool groups not loaded in this session: ${omitted.join(', ')}. Those capabilities exist in the app but are not exposed right now — say so rather than reporting them as impossible.`);
  }
  return parts.filter(Boolean).join('\n\n');
}

// Build a fully-registered MCP server instance.
// baseUrl: origin of the running backend (defaults to loopback :3001).
// notifyMutation(projectId): optional hook fired after any mutation so the
//   host process can push a refresh signal to open browser UIs.
// groups: tool-group selector (see resolveGroups). Defaults to the MCP_TOOLS
//   env var, and to every group when that is unset.
export function buildMcpServer({ baseUrl, notifyMutation, groups } = {}) {
  const api = createApiClient(baseUrl);
  const selected = resolveGroups(groups ?? process.env.MCP_TOOLS);
  const server = new McpServer(
    { name: '3d-gen-studio', version: APP_VERSION },
    { instructions: buildInstructions(selected) }
  );

  const ctx = { api, notifyMutation: typeof notifyMutation === 'function' ? notifyMutation : () => {} };

  for (const name of selected) TOOL_GROUPS[name].register(server, ctx);

  return server;
}

export { GROUP_NAMES, TOOL_GROUPS };
