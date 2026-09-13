# 3D Gen Studio — MCP Server

3D Gen Studio ships an [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server so any AI — Claude Desktop/Code, ChatGPT, local LLM stacks — can automate the app: create projects, build node graphs, run ComfyUI workflows, generate images and meshes, run the whole mesh finishing pipeline (auto UV, retopo, repair, rig, optimize, LOD, bake, collision, pivot, Game-Ready check), and export/import projects.

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

The stdio bridge requires the app to be running. It finds the backend in this order:

1. `GENSTUDIO_URL` — an explicit override, e.g. a backend on another machine.
2. `PORT` — loopback on that port.
3. `<data dir>/runtime.json` — written by the backend on startup with the port it
   actually bound. The desktop app moves the backend off 3001 when something else
   holds it, so this is what makes the bridge follow it. Searched under
   `GENSTUDIO_DATA_ROOT`, the current directory, and the app-data directory
   (`%APPDATA%/3DGenStudio`, `~/Library/Application Support/3DGenStudio`,
   `~/.config/3DGenStudio`).
4. `http://127.0.0.1:3001` as a last resort.

Alternatively, without a checkout: `npx mcp-remote http://localhost:3001/mcp` as the command.

### VS Code (GitHub Copilot)

Requires VS Code 1.102+ with the GitHub Copilot and GitHub Copilot Chat extensions; MCP tools are used from Copilot **Agent mode**. Fastest path: Command Palette → **MCP: Add Server…** → **HTTP** → `http://localhost:3001/mcp` → name it `3d-gen-studio`.

Or add a workspace `.vscode/mcp.json` (VS Code uses the `servers` key, not `mcpServers`):

```json
{
  "servers": {
    "3d-gen-studio": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Start it via the CodeLens in that file (or the MCP view), then open Copilot Chat, switch to **Agent** mode, and select the 3D Gen Studio tools in the tools (🔧) picker. For a token-protected/remote endpoint, add a header and prompt for the token:

```json
{
  "servers": {
    "3d-gen-studio": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer ${input:genstudio-token}" }
    }
  },
  "inputs": [
    { "id": "genstudio-token", "type": "promptString", "description": "3D Gen Studio MCP token", "password": true }
  ]
}
```

A `stdio` server (`"type": "stdio"`, `"command": "node"`, `"args": ["C:/Git/3DGenStudio/mcp/stdio.js"]`) also works and requires the app to be running.

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
| Mesh tools | `auto_uv_mesh`, `auto_retopo_mesh`, `repair_mesh`, `auto_rig_mesh`, `optimize_mesh`, `convert_mesh_fbx` (all fully-typed), `run_mesh_tool` (the same operations, untyped), `export_mesh` |
| Mesh finishing | `inspect_mesh` (Game-Ready check), `bake_mesh_maps`, `generate_lods`, `generate_collision`, `move_mesh_pivot`, `transfer_rig` |
| Assets | `list_assets`, `list_library_assets`, `view_asset`, `download_asset`, `upload_asset`, `link_asset`, `unlink_asset`, `delete_asset` |
| Asset tags | `list_asset_tags`, `tag_asset`, `find_assets_by_tags` |
| Asset library | `import_library_assets`, `rename_library_asset`, `delete_library_asset` |
| System | `get_settings` (secrets redacted), `update_settings`, `get_system_stats` |

### Context cost and loading only the groups you need

An MCP client injects the **whole tool catalog into the model's system prompt on every request**, before the model reads your message. All 67 tools cost ~91 KB of JSON plus ~5 KB of server instructions — roughly **26,500 tokens per session**, whether or not a single tool is called. That is why even asking a model "are you connected to 3d-gen-studio?" appears to consume ~26k tokens: the question is ~10 tokens, the connection is the rest.

Clients that load tool schemas lazily (Claude Code fetches them on demand) pay almost nothing. For clients that load everything eagerly — most local LLM stacks — load only the groups you need, either with the `--tools` flag or the `MCP_TOOLS` environment variable:

```jsonc
{
  "mcpServers": {
    "3d-gen-studio": {
      "command": "node",
      "args": ["C:/Git/3DGenStudio/mcp/stdio.js", "--tools=projects,graph,workflows,assets"]
    }
  }
}
```

```jsonc
// equivalent, for clients that pass env through
"args": ["C:/Git/3DGenStudio/mcp/stdio.js"],
"env": { "MCP_TOOLS": "projects,graph,workflows,assets" }
```

**Prefer `--tools`.** Clients differ in whether they forward `env` to a spawned stdio server, but every client passes `args`. `--tools` wins over `MCP_TOOLS` when both are set.

Two forms are accepted, comma- or space-separated:

- **include** — `projects,graph,workflows` loads exactly those groups
- **exclude** — `-mesh,-actions` loads everything except those

Unset, empty, or `all` loads every group, so nothing changes for an existing config. Unknown names are ignored with a warning on stderr rather than failing. Group names: `projects`, `cards`, `graph`, `workflows`, `actions`, `mesh`, `assets`, `settings`.

| Selector | Tools | Catalog | Saved |
|---|---|---|---|
| *(unset)* / `all` | 67 | ~25,200 tokens | — |
| `-mesh` | 54 | ~15,700 | 38% |
| `-mesh,-actions` | 44 | ~10,300 | 59% |
| `projects,graph,workflows,assets` | 34 | ~8,600 | 66% |
| `projects,mesh,assets` | 34 | ~14,200 | 44% |
| `projects,cards,assets` | 28 | ~5,800 | 77% |
| `projects,settings` | 10 | ~1,600 | 94% |

The server instructions are assembled to match, so dropping a group also drops its guidance, and the model is told which groups were left out — it reports them as "not exposed in this session" rather than claiming the app can't do it.

Over the HTTP endpoint the same selector is available per request as `POST /mcp?tools=graph,workflows`, or as `settings.mcp.tools` for a persistent default.

The heaviest groups are `mesh` (~8,900 tokens across 13 tools) and `actions` (~5,400 across 10) — both are parameter-dense by design, since each tool documents its full option set with ranges and defaults.

#### Tool *results* cost context too

The catalog is a fixed per-session cost; a tool's **return value** is a per-call cost, and it can be much larger. `list_workflows` is the worst offender: returned in full, a 42-workflow library is ~382 KB / **~106,000 tokens** — more than three times a 32K context, from one call.

It is therefore **tiered**, and defaults to the cheapest tier:

| Call | Returns | Tokens |
|---|---|---|
| `list_workflows()` | id, name, parameter/output counts for every workflow | ~1,600 |
| `list_workflows({name: "BiRefNet"})` | + the parameters and outputs needed to run it | ~380 |
| `list_workflows({detail: "full"})` | full parameters for the entire library | ~11,800 |
| `list_workflows({name: …, detail: "inputs"})` | + every candidate node input, for `update_workflow` | ~5,500 |

`name` (a case-insensitive substring) and `workflowId` imply `detail: "full"`, since asking for a specific workflow means you intend to run it. An explicit `detail` always wins.

The 82% that used to dominate the response was `availableInputs` — every literal node input in the graph, which only matters when *reconfiguring* a workflow's parameter selection. That is now behind `detail: "inputs"`. The remaining parameter records are trimmed to the fields a caller actually uses: `id` (what `run_workflow`'s `inputs` keys on), `name`, `valueType`, `defaultValue`, and `enums`. The redundant `nodeId`/`inputKey`/`nodeTitle`/`classType`/`label`/`type` fields are dropped — all are derivable from or duplicated by those.

#### LM Studio

LM Studio follows Cursor's `mcp.json` notation (`~/.lmstudio/mcp.json`) and loads every tool of every enabled server eagerly, so the full catalog lands in each request. It has **no per-tool toggle** — the chips under the chat box switch whole servers on and off — so `--tools` is the only way to trim the catalog. Two things to check when the context bar looks full:

- **Use the `args` form above.** It does not depend on `env` being forwarded.
- **Raise the model's context length.** LM Studio pins a load-time `contextLength` per model that is often far below what the model supports (its own default is commonly 32,768 against a 256K-capable model). It is in the model's load settings, and costs RAM/VRAM.

### Displaying results on graph nodes

In graph projects, pass `nodeId` to `run_workflow`, `generate_image`, `edit_image`, or `generate_mesh` to display the results on that node — the first result becomes the node's asset, and additional results become new nodes stacked below it (wired to the same inputs). Without `nodeId` the generated assets are saved to the project but no node displays them.

`run_workflow` saves its output **under the source it was derived from, automatically** — you normally never set `parentAssetId`. The server matches each output to a resolved image/mesh input of the same type (whether that input was wired from the target node in a graph project or passed in `inputs` — so this works the same in **kanban** projects, which have no node wiring): an image output becomes an edit of that source image, a mesh output a version of that source mesh (matching the graph UI). So a re-texture (image + mesh in → mesh out) becomes a version of the input mesh, and a background-removal (image in → image out) an edit of the input image, with nothing extra to pass. Because the server knows the true output type (from the produced file), this holds even when the workflow's declared output type is missing or wrong. Set `parentAssetId` only to override the inferred parent; a parent whose type doesn't match the output type is ignored and a new root asset is created. (`edit_image` likewise saves an edit of its `imageSource`, and `run_mesh_tool` a version of its `assetId`.)

The target node's connected input assets also **auto-fill the workflow's image/mesh parameters**, matched by type (each connected asset used once). A node wired to an image and a mesh feeds a workflow that needs a Source Image + a mesh input without any manual mapping — so for a wired node you should **not** pass `inputs` for file (image/mesh/video) parameters and never need to guess their parameter ids. Set an `inputs` entry for a file parameter only to override a wired input or when nothing is connected; use `inputs` otherwise just for string/number/boolean parameters. Explicit `inputs`/`fileInputs` always take precedence over an auto-filled value.

When you *do* pass an image/mesh parameter in `inputs` (e.g. in a kanban project, which has no wiring), the value is simply the asset's **numeric id** — nothing else. The same plain id works for a root asset, an **edit**, or a **version**: a background-removed image is an edit, so pass that edit's own `id` (from the `children`/`edits` tree in `list_assets`). Do **not** pass a file path or filename, and do **not** pass a `{assetId, editId}` object — a bare id is always correct.

**Connect the input nodes _before_ you run.** `run_workflow`, `edit_image`, and `generate_mesh` read a node's connected input at the moment they execute — the input feeds the workflow/API and determines whether the result is saved as an edit/version. So the correct order is always: (1) `create_node` for the target, (2) `connect_nodes` to wire its input asset(s), then (3) run the workflow or API on that node. Running first and connecting afterwards is wrong: the run sees no input, so it can't use the source image/mesh and saves a stray new root asset instead of an edit/version — and the late connection does **not** re-run or re-parent it. If you ran in the wrong order, delete the stray result, connect the inputs, and run again.

### Small and local models (LM Studio, Ollama, …)

`run_workflow`'s `inputs` is the one free-form map in the API — a flat parameter id -> bare value — and it is where a small model's output goes wrong. The server repairs what it can rather than rejecting the run, and reports each repair in the response's `warnings`:

- **Chat-template tokens leaking into the JSON.** A locally served model regularly emits its own quote/special tokens inside a key, so `6.text` arrives as `<|"|>6.text<|"|>` (or with stray backslashes/quotes). Any `<|…|>` marker and non-id character around a key is stripped before the lookup, and the same markers are stripped from string values so they never reach a ComfyUI prompt.
- **A near-miss id.** Wrong case (`6.TEXT`), the bare input key without its node id (`text`), or the parameter's display name (`Seed`) resolves to the real id **when the match is unambiguous**. Two parameters could answer to `text`, so that key is an error, not a guess.
- **A wrapped value.** `{"6.text": {"value": "a red robot"}}` or a one-element array is unwrapped to the bare value.

A key that still matches nothing is an error listing the workflow's real parameter ids — and, when template tokens were detected, an explicit note that the keys arrived wrapped. Left unrepaired this is a **retry loop**: the model is certain it copied the id correctly, so it re-issues the identical call forever.

### Parameter-heavy mesh tools

Every mesh operation has a dedicated tool that declares each parameter in its schema with type, range, default, and description (mirroring the Python service's Pydantic models 1:1), so a client can set exactly what it needs and see the valid bounds: `auto_uv_mesh` (14 parameters), `auto_retopo_mesh` (20), `repair_mesh`, `auto_rig_mesh`, `optimize_mesh`, `convert_mesh_fbx`, `inspect_mesh`, `bake_mesh_maps`, `generate_collision`, `generate_lods`, `move_mesh_pivot`, `transfer_rig`. Any subset of options may be set; unset keys fall back to the documented default. For Auto Retopo, the `shell_*` options apply only when `watertight` is `true`. `run_mesh_tool` still accepts every operation with a free-form options object for backward compatibility, but prefer the typed tools.

### The finishing pipeline

`inspect_mesh` is the entry point: it grades a mesh against engine-readiness budgets (triangles, UVs, texel density, materials, scale, manifoldness, pivot) and never modifies it. Each finding carries a `status` (`pass`/`warn`/`fail`/`info`) and, where one exists, a `fixTool` naming the MCP tool that resolves it — `repair_mesh`, `auto_uv_mesh`, `auto_retopo_mesh`, `optimize_mesh`, or `move_mesh_pivot` (with `fixArgs` carrying the pivot mode). A typical run:

1. `inspect_mesh` — see what's wrong.
2. `repair_mesh` — non-manifold edges, degenerate/duplicate faces.
3. `auto_retopo_mesh` or `optimize_mesh` / `generate_lods` — hit the triangle budget.
4. `auto_uv_mesh` — missing or overlapping UVs (required before baking).
5. `bake_mesh_maps` — bake the **original** high-poly onto the reduced mesh so the lost detail comes back as a normal/AO map.
6. `move_mesh_pivot` — drop the pivot to the ground (or the bbox centre).
7. `generate_collision`, then `convert_mesh_fbx` or `export_mesh`.
8. `inspect_mesh` again to confirm.

Where results are saved differs by tool, deliberately: most save a **new version** of the source mesh, but `generate_collision` and `bake_mesh_maps` save **separate assets** (a collider is a sibling of the render mesh, not a newer take on it, and baked maps are images). `generate_lods` saves one version per reduced level, skipping a ratio of `1` since that level is the source itself. `move_mesh_pivot` saves nothing when the pivot is already in place and says so in the response. `transfer_rig` saves a new version of the TARGET (the mesh being rigged), never of the source it copied from.

**Rigging a reduced mesh.** Steps 3 and 4 rebuild the topology, which destroys any skin weights the mesh had — the result saves as a static mesh even if the original was rigged. `transfer_rig` is the repair: it copies the skeleton and weights off the pre-reduction version (or any rigged version of the same character) by sampling the nearest point on its surface. It needs no GPU and no service, and because it reuses the *existing* skeleton it keeps the bone names, hand corrections and saved bone mappings that `auto_rig_mesh` would throw away by generating a new one. The two meshes have to be the same character in the same space; a source at a different pivot is re-centred automatically, one at a different scale is refused. Check `far_sample_fraction` in the response — much above `0.05` means the surfaces do not really match.

**The UV-seam trap.** gltfpack (behind `optimize_mesh` and `generate_lods`) will not collapse a vertex that sits on a UV seam, so a heavily-seamed textured mesh can barely reduce at all no matter what `simplify_ratio` you ask for. Always read `stats.achieved_ratio` and `stats.seam_limited` rather than assuming the request was met; setting `allow_seam_breaking: true` reaches the target but distorts the UVs, so re-unwrap or re-bake afterwards.

**Baking returns maps, not a textured mesh.** `bake_mesh_maps` saves the baked PNGs as project image assets (and optionally writes them to a folder). Attaching them to the mesh's material is a Mesh Editor operation that runs in the browser, so over MCP use the maps as workflow inputs or wire them up in the engine.

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

### Tags

Tags are the free-form labels the Assets page filters by, and they work the same over MCP. They belong to a single asset record, so a root asset, an image **edit** and a mesh **version** each carry their own set — pass the child id from `list_assets` to tag an edit or a version.

- **`list_asset_tags`** — with `assetId`, the tags of that one asset; without it, the whole vocabulary in use with a count per tag (optionally scoped to one `type`). Read the vocabulary before inventing a tag, so `sci-fi` doesn't gain a `scifi` twin.
- **`tag_asset`** — `add` and/or `remove` edit the tags in place, leaving the rest alone; `tags` replaces the whole set (`tags: []` clears it). Renaming a tag on an asset is one call: `remove` the old, `add` the new. `remove` is applied after `add`, so passing the same tag to both leaves it off. Returns the resulting list.
- **`find_assets_by_tags`** — searches every project and the library at once, newest first. By default an asset must carry **every** tag given (the narrowing the Assets page filter does); `matchAll: false` makes it "any of these". Narrow further with `type` and/or `projectId`. Each hit carries its full tag list, `matchedTags`, the projects it is linked to, and a download URL.

Tags are normalized server-side — trimmed, whitespace-collapsed, lower-cased, 48 chars max, 50 per asset — so `"Sci-Fi"`, `"sci-fi "` and `"SCI-FI"` are one tag. Punctuation is left alone, though: `sci-fi` and `sci fi` remain two different tags. A tag always comes back in its canonical form, which is what a later search has to match.

#### Tagging at generation time

Every tool that **saves** a generated asset takes the same optional `tags` list, applied the moment the result is saved: `generate_image`, `edit_image`, `generate_mesh` (and `generate_mesh_tencent` / `_tripo` / `_hitem`), `get_mesh_result`, `edit_mesh`, `texture_mesh`, `rig_mesh_api`, `run_workflow`, `get_run_status`, and `generate_tree`. This is what keeps a generated asset findable without a second round trip, which an automated caller routinely forgets to make — a mesh generated and never tagged is a mesh nobody finds again.

The result then carries `taggedAssets: [{ assetId, tags }]` — the resulting tag list per saved asset, read back from the server, so the canonical form is visible immediately. `tags` is additive (the same rule as `tag_asset`'s `add`), so it never clears a tag an earlier step set; use `tag_asset` to remove or replace.

Two behaviours worth knowing:

- **Tagging cannot fail a generation.** Tags are applied by a separate request after the save, so it can fail on its own — but throwing then would report a successful, minutes-long generation as a failed tool call, and the caller would retry the *generation*. Instead the result comes back intact with a `tagWarnings` entry naming the asset id and the error; `tag_asset` fixes it up.
- **A timed-out job has not been tagged**, because nothing has been saved yet. `generate_mesh*` and `run_workflow` echo the `tags` back in their `{status: "running"}` payload — pass them to the `get_mesh_result` / `get_run_status` call that finishes the job. (This is why `get_run_status` is no longer marked read-only.)

`edit_image` tags its `savedEdits`, never the source image it was derived from — its response also carries the source's `assetId`, and tagging that would label the input.

## Requirements per capability

| Capability | Needs |
|---|---|
| Projects / cards / graph / assets / export / import | just the app running |
| `run_workflow`, ComfyUI-based edits | ComfyUI running (URL in Settings, default `127.0.0.1:8188`) |
| `generate_image`, `edit_image`, `generate_mesh`, `generate_mesh_tencent`, `generate_mesh_tripo`, `generate_mesh_hitem`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` | provider API keys in Settings |
| `auto_uv_mesh`, `auto_retopo_mesh`, `repair_mesh`, `convert_mesh_fbx`, `inspect_mesh`, `bake_mesh_maps`, `generate_collision` | Python mesh-tools service (`:8200`) running — the desktop app can start it from Settings |
| `auto_rig_mesh` | rigging service (`:8300`) running |
| `optimize_mesh`, `generate_lods` | nothing extra (bundled gltfpack) |
| `move_mesh_pivot`, `transfer_rig` | nothing extra (runs in the app backend) |

## Limitations

- The **Mesh Editor** modes that run in the browser (WebGL/canvas) are not exposed over MCP: sculpting, modeling, displace/boolean, painting, projection, applying baked maps to a material, and animation retargeting (Auto Rig -> Animations). **Image Editor** pixel operations (crop, filters, shadow remover) are browser-only too. AI-driven alternatives: ComfyUI workflows (`run_workflow`), prompt-based edits (`edit_image`), and the mesh-tool services. Note that *running* a bake is available (`bake_mesh_maps`) — only applying the result to a material is not.
- `update_settings` refuses to write any field whose key looks like an API key, secret, token, password, or credential. Reads are redacted, so a client that round-tripped a settings object would otherwise overwrite a real key with the redaction placeholder. Set credentials (including `mcp.token`) in the app's Settings dialog or with a direct `POST /api/settings`.
- Not yet exposed: Brainstorming Boards, Batch project configuration, the Wiki, and tasks.
- If the app UI is open in a browser while an MCP client mutates data, open Graph/Kanban pages refresh automatically via the app event stream; other pages may need a manual refresh.
