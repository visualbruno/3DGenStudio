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
| AI actions | `generate_image`, `edit_image`, `generate_mesh`, `generate_mesh_tencent`, `generate_mesh_tripo`, `generate_mesh_hitem`, `get_mesh_result`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` |
| Mesh tools | `auto_uv_mesh`, `auto_retopo_mesh` (fully-typed parameters), `run_mesh_tool` (auto_uv / auto_retopo / repair / auto_rig / optimize / convert_fbx), `export_mesh` |
| Assets | `list_assets`, `list_library_assets`, `view_asset`, `download_asset`, `upload_asset`, `link_asset`, `delete_asset` |
| System | `get_settings` (secrets redacted), `get_system_stats` |

### Displaying results on graph nodes

In graph projects, pass `nodeId` to `run_workflow`, `generate_image`, `edit_image`, or `generate_mesh` to display the results on that node — the first result becomes the node's asset, and additional results become new nodes stacked below it (wired to the same inputs). Without `nodeId` the generated assets are saved to the project but no node displays them.

`run_workflow` saves its output **under the source it was derived from, automatically** — you normally never set `parentAssetId`. The server matches each output to a resolved image/mesh input of the same type (whether that input was wired from the target node in a graph project or passed in `inputs` — so this works the same in **kanban** projects, which have no node wiring): an image output becomes an edit of that source image, a mesh output a version of that source mesh (matching the graph UI). So a re-texture (image + mesh in → mesh out) becomes a version of the input mesh, and a background-removal (image in → image out) an edit of the input image, with nothing extra to pass. Because the server knows the true output type (from the produced file), this holds even when the workflow's declared output type is missing or wrong. Set `parentAssetId` only to override the inferred parent; a parent whose type doesn't match the output type is ignored and a new root asset is created. (`edit_image` likewise saves an edit of its `imageSource`, and `run_mesh_tool` a version of its `assetId`.)

The target node's connected input assets also **auto-fill the workflow's image/mesh parameters**, matched by type (each connected asset used once). A node wired to an image and a mesh feeds a workflow that needs a Source Image + a mesh input without any manual mapping — so for a wired node you should **not** pass `inputs` for file (image/mesh/video) parameters and never need to guess their parameter ids. Set an `inputs` entry for a file parameter only to override a wired input or when nothing is connected; use `inputs` otherwise just for string/number/boolean parameters. Explicit `inputs`/`fileInputs` always take precedence over an auto-filled value.

When you *do* pass an image/mesh parameter in `inputs` (e.g. in a kanban project, which has no wiring), the value is simply the asset's **numeric id** — nothing else. The same plain id works for a root asset, an **edit**, or a **version**: a background-removed image is an edit, so pass that edit's own `id` (from the `children`/`edits` tree in `list_assets`). Do **not** pass a file path or filename, and do **not** pass a `{assetId, editId}` object — a bare id is always correct.

**Connect the input nodes _before_ you run.** `run_workflow`, `edit_image`, and `generate_mesh` read a node's connected input at the moment they execute — the input feeds the workflow/API and determines whether the result is saved as an edit/version. So the correct order is always: (1) `create_node` for the target, (2) `connect_nodes` to wire its input asset(s), then (3) run the workflow or API on that node. Running first and connecting afterwards is wrong: the run sees no input, so it can't use the source image/mesh and saves a stray new root asset instead of an edit/version — and the late connection does **not** re-run or re-parent it. If you ran in the wrong order, delete the stray result, connect the inputs, and run again.

### Parameter-heavy mesh tools

Auto UV and Auto Retopo have many tuning parameters (14 and 20 respectively) that materially change the output. Use the dedicated `auto_uv_mesh` and `auto_retopo_mesh` tools rather than `run_mesh_tool` for these: each declares every parameter in its schema with type, range, default, and description (mirroring the Python service's models), so a client can set exactly what it needs and see the valid bounds. Any subset of options may be set; unset keys fall back to the documented default. For Auto Retopo, the `shell_*` options apply only when `watertight` is `true`. `run_mesh_tool` still accepts `auto_uv`/`auto_retopo` (options ride along as a free-form object) for backward compatibility.

### External mesh-generation providers

Tencent Hunyuan3D, Tripo AI, and Hitem3D each take a different, parameter-heavy option set. Use the dedicated `generate_mesh_tencent`, `generate_mesh_tripo`, and `generate_mesh_hitem` tools: each hardwires its provider and declares every parameter in its `options` schema with type, enum/range, and default (mirroring the backend 1:1), so a client can set exactly what it needs. Provider notes: Tencent `region` is required and `LowPoly` needs model `3.0`; Tripo's `P1` model ignores several options and `generateParts` is incompatible with `texture`/`pbr`/`quad`; Hitem3D requires an `imageSource`. Tencent and Tripo accept either a `prompt` (text-to-3D) or an `imageSource` (image-to-3D). The generic `generate_mesh` still accepts these providers with a free-form `options` object for backward compatibility.

These provider jobs are asynchronous. Unlike the app UI (where you click **Get Result** to poll), the MCP tools poll for you automatically: `generate_mesh*` submits the job and then polls the provider until the mesh is ready, streaming progress, and returns the saved assets — the AI just awaits the call and gets `{status:"completed", assets}`. The mesh is only saved once a poll sees completion, so if a job outlives `timeoutSeconds` (default 1200s) the tool returns `{status:"running", provider, taskId/jobId, region}`; pass those ids to **`get_mesh_result`** to finish and save the job (safe to call repeatedly). Do not re-run generation on timeout — that starts a new job.

Image generation (`generate_image`) is prompt-only by design: OpenAI/Google image parameters (size, quality, aspect ratio) are fixed in each provider's payload template in Settings, not passed per request, so there is nothing extra to set over MCP.

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
| `generate_image`, `edit_image`, `generate_mesh`, `generate_mesh_tencent`, `generate_mesh_tripo`, `generate_mesh_hitem`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` | provider API keys in Settings |
| `auto_uv_mesh`, `auto_retopo_mesh`, `run_mesh_tool` auto_uv / auto_retopo / repair / convert_fbx | Python mesh-tools service (`:8200`) running — the desktop app can start it from Settings |
| `run_mesh_tool` auto_rig | rigging service (`:8300`) running |
| `run_mesh_tool` optimize | nothing extra (bundled gltfpack) |

## Limitations

- The interactive **Mesh Editor** operations (sculpt, modeling, boolean, painting, projection, texture bake) and **Image Editor** pixel operations (crop, filters, shadow remover) run in the browser (WebGL/canvas) and are not exposed over MCP. AI-driven alternatives: ComfyUI workflows (`run_workflow`), prompt-based edits (`edit_image`), and the mesh-tool services.
- If the app UI is open in a browser while an MCP client mutates data, open Graph/Kanban pages refresh automatically via the app event stream; other pages may need a manual refresh.
