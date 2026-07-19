// MCP server for 3D Gen Studio.
//
// Exposes the app's headless capabilities (projects, kanban cards, node graph,
// ComfyUI workflows, AI actions, mesh tools, assets) as MCP tools so any MCP
// client — Claude Desktop/Code, ChatGPT, local LLM stacks — can automate the
// app. Tools call the running backend over loopback HTTP (see client.js).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import path from 'node:path';
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

function readAppVersion() {
  try {
    const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'))?.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readAppVersion();

const SERVER_INSTRUCTIONS = `3D Gen Studio automation server.

Typical flows:
- New pipeline: create_project (preset "graph") -> create_node / connect_nodes to lay out the pipeline -> run_workflow or generate_image / generate_mesh to produce assets.
- IMPORTANT (graph projects): always pass nodeId to run_workflow / generate_image / edit_image / generate_mesh so the results are DISPLAYED on that node. Without nodeId the assets are saved but no node shows them. The first result becomes the node's image/mesh; extra results become new nodes stacked below it.
- IMPORTANT ordering: connect_nodes to wire a node's input asset(s) BEFORE you run_workflow / edit_image / generate_mesh on it. The run reads the node's connected input at execution time — it feeds the workflow/API and decides whether the result is saved as an edit of the connected image / a version of the connected mesh. Running first and connecting afterwards is wrong: the run sees no input, so it uses none and saves a stray new root asset, and the late connection does not re-run or re-parent it. If you got the order wrong, delete the stray result, connect the inputs, then run again.
- ComfyUI: list_workflows for saved workflows and their parameters; import_workflow to add new ones (inspect_workflow first to discover inputs/outputs). run_workflow blocks with progress until the assets are ready. ComfyUI itself must be running (URL in get_settings).
- ComfyUI image/mesh (file) parameters are filled AUTOMATICALLY from the target node's wired inputs (matched by type) — so for a node whose inputs are connected, do NOT pass inputs for file parameters (no need to guess their ids); just connect_nodes then run_workflow with nodeId. Only set a file-parameter input to override a wired input or when nothing is connected. Set inputs only for non-file parameters (string/number/boolean) you want to change.
- When you DO pass an image/mesh (file) parameter in inputs (e.g. in a kanban project with no wiring), the value is just the asset's numeric id — nothing else. The SAME plain id works for a root asset, an edit, or a version (a background-removed image is an edit → pass that edit's own id, found in the children/edits tree from list_assets). Do NOT pass a file path/filename or a {assetId, editId} object; a bare id is correct.
- Parent linkage is AUTOMATIC — do NOT manage parentAssetId yourself. run_workflow saves its output under the source it was derived from (the image/mesh input matching the output type, wired or passed in inputs): an image output becomes an edit of that image, a mesh output a version of that mesh. edit_image already saves an edit of its imageSource, and run_mesh_tool saves a version of its assetId. So a re-texture (image+mesh in, mesh out) versions the input mesh, and a background-removal (image in, image out) edits the input image, with no parentAssetId needed. Only pass parentAssetId to override the inferred parent.
- Mesh processing: run_mesh_tool (auto_uv / auto_retopo / repair / auto_rig / optimize / convert_fbx) works on mesh assets; results save as asset versions.
- Seeing results: use view_asset to LOOK at a generated image (returns the actual image; for meshes it returns the thumbnail when available). Use download_asset to save any asset file to a local folder. Assets also carry direct download URLs in every response.

Note: interactive Mesh Editor sculpting/painting and Image Editor pixel edits are browser-only and not exposed here. If the app UI is open in a browser, it may need a refresh to show changes made through these tools.`;

// Build a fully-registered MCP server instance.
// baseUrl: origin of the running backend (defaults to loopback :3001).
// notifyMutation(projectId): optional hook fired after any mutation so the
// host process can push a refresh signal to open browser UIs.
export function buildMcpServer({ baseUrl, notifyMutation } = {}) {
  const api = createApiClient(baseUrl);
  const server = new McpServer(
    { name: '3d-gen-studio', version: APP_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const ctx = { api, notifyMutation: typeof notifyMutation === 'function' ? notifyMutation : () => {} };

  registerProjectTools(server, ctx);
  registerCardTools(server, ctx);
  registerGraphTools(server, ctx);
  registerWorkflowTools(server, ctx);
  registerActionTools(server, ctx);
  registerMeshToolTools(server, ctx);
  registerAssetTools(server, ctx);
  registerSettingsTools(server, ctx);

  return server;
}
