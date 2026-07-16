# 3D Gen Studio — MCP Server

3D Gen Studio ships an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server so any AI — Claude Desktop/Code, ChatGPT, local LLM stacks — can automate the app: create projects, build node graphs, run ComfyUI workflows, generate images and meshes, run mesh tools (auto UV, retopo, repair, rig, optimize), and export/import projects.

## Endpoint

The MCP server is part of the app backend. Start the app (dev: `npm run dev`, or launch the desktop app) and the endpoint is live at:

```
http://localhost:3001/mcp        (Streamable HTTP, stateless)
```

No extra process is needed — it ships with the backend in both dev and the packaged desktop app.

### Security

- **Local by default** — without a token, only clients on the same machine may connect.
- **Remote access** — set a bearer token in settings (`mcp.token`); remote clients must send `Authorization: Bearer <token>`.
- **Disable** — set `mcp.enabled` to `false` in settings; the endpoint then returns 404.

Settings live in the app database and can be changed via `POST /api/settings` with `{"mcp": {"enabled": true, "token": "..."}}` (or the Settings UI once exposed there).

## Client setup

### Claude Code

```sh
claude mcp add --transport http 3d-gen-studio http://localhost:3001/mcp
```

### Claude Desktop

Add a custom connector (Settings → Connectors) with URL `http://localhost:3001/mcp`, or use the stdio bridge in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "3d-gen-studio": {
      "command": "node",
      "args": ["C:/Git/3DGenStudio/mcp/stdio.js"]
    }
  }
}
```

The stdio bridge requires the app to be running; it talks to `http://127.0.0.1:3001` (override with the `GENSTUDIO_URL` env var).

Alternatively, without a checkout: `npx mcp-remote http://localhost:3001/mcp` as the command.

### ChatGPT (developer mode) / other clients

Any client that supports Streamable HTTP MCP servers can connect to `http://localhost:3001/mcp` (remote clients need the bearer token, see Security).

### MCP Inspector (debugging)

```sh
npx @modelcontextprotocol/inspector
```

Connect with transport "Streamable HTTP" to `http://localhost:3001/mcp`.

## Tools

| Group | Tools |
|---|---|
| Projects | `list_projects`, `get_project`, `create_project`, `update_project`, `delete_project`, `export_project`, `import_project` |
| Kanban cards | `list_cards`, `move_card`, `delete_card`, `list_card_attributes`, `create_card_attribute`, `update_card_attribute`, `delete_card_attribute` |
| Graph | `get_graph`, `create_node`, `update_node`, `move_node`, `delete_node`, `connect_nodes`, `disconnect_nodes` |
| ComfyUI workflows | `list_workflows`, `inspect_workflow`, `import_workflow`, `update_workflow`, `run_workflow`, `get_run_status` |
| AI actions | `generate_image`, `edit_image`, `generate_mesh`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` |
| Mesh tools | `run_mesh_tool` (auto_uv / auto_retopo / repair / auto_rig / optimize / convert_fbx), `export_mesh` |
| Assets | `list_assets`, `list_library_assets`, `view_asset`, `download_asset`, `upload_asset`, `link_asset`, `delete_asset` |
| System | `get_settings` (secrets redacted), `get_system_stats` |

### Displaying results on graph nodes

In graph projects, pass `nodeId` to `run_workflow`, `generate_image`, `edit_image`, or `generate_mesh` to display the results on that node — the first result becomes the node's asset, and additional results become new nodes stacked below it (wired to the same inputs). Without `nodeId` the generated assets are saved to the project but no node displays them.

### Long-running operations

`run_workflow`, `generate_mesh`, and `run_mesh_tool` block until the result is ready and stream MCP progress notifications. If a run outlives the tool's `timeoutSeconds`, it keeps running in the background and the tool returns a `promptId`/job info to poll (`get_run_status` for ComfyUI runs; `list_assets`/`list_cards` otherwise).

### Files and assets

- `view_asset` returns the **actual image** as MCP image content, so the AI can visually inspect generated images (for meshes it returns the thumbnail preview when one exists). Inline viewing is capped at ~3.5 MB per image.
- `download_asset` writes any asset file (image/mesh/workflow) to an absolute folder on the machine running the app.
- Asset listings and results otherwise carry direct download URLs (`http://localhost:3001/assets/...`); local files are passed into tools by absolute path (`upload_asset`, `import_workflow filePath`, `run_workflow fileInputs`), and exports write to absolute folders.

## Requirements per capability

| Capability | Needs |
|---|---|
| Projects / cards / graph / assets / export / import | just the app running |
| `run_workflow`, ComfyUI-based edits | ComfyUI running (URL in Settings, default `127.0.0.1:8188`) |
| `generate_image`, `edit_image`, `generate_mesh`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` | provider API keys in Settings |
| `run_mesh_tool` auto_uv / auto_retopo / repair / convert_fbx | Python mesh-tools service (`:8200`) running — the desktop app can start it from Settings |
| `run_mesh_tool` auto_rig | rigging service (`:8300`) running |
| `run_mesh_tool` optimize | nothing extra (bundled gltfpack) |

## Limitations

- The interactive **Mesh Editor** operations (sculpt, modeling, boolean, painting, projection, texture bake) and **Image Editor** pixel operations (crop, filters, shadow remover) run in the browser (WebGL/canvas) and are not exposed over MCP. AI-driven alternatives: ComfyUI workflows (`run_workflow`), prompt-based edits (`edit_image`), and the mesh-tool services.
- If the app UI is open in a browser while an MCP client mutates data, open Graph/Kanban pages refresh automatically via the app event stream; other pages may need a manual refresh.
