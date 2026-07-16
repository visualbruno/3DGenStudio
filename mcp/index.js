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
- ComfyUI: list_workflows for saved workflows and their parameters; import_workflow to add new ones (inspect_workflow first to discover inputs/outputs). run_workflow blocks with progress until the assets are ready. ComfyUI itself must be running (URL in get_settings).
- Mesh processing: run_mesh_tool (auto_uv / auto_retopo / repair / auto_rig / optimize / convert_fbx) works on mesh assets; results save as asset versions.
- Assets carry direct download URLs in every response.

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
