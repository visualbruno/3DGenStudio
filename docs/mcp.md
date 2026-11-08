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
| Kanban cards | `list_cards`, `create_card`, `move_card`, `delete_card`, `list_card_attributes`, `create_card_attribute`, `update_card_attribute`, `delete_card_attribute` |
| Graph | `get_graph`, `create_node`, `update_node`, `move_node`, `delete_node`, `connect_nodes`, `disconnect_nodes` |
| Batch projects | `get_batch`, `update_batch`, `add_batch_groups`, `update_batch_group`, `remove_batch_groups`, `run_batch` |
| ComfyUI workflows | `list_workflows`, `inspect_workflow`, `import_workflow`, `update_workflow`, `run_workflow`, `get_run_status` |
| AI actions | `generate_image`, `edit_image`, `generate_mesh`, `generate_mesh_tencent`, `generate_mesh_tripo`, `generate_mesh_hitem`, `get_mesh_result`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` |
| Mesh tools | `auto_uv_mesh`, `auto_retopo_mesh`, `repair_mesh`, `auto_rig_mesh`, `optimize_mesh`, `convert_mesh_fbx` (all fully-typed), `run_mesh_tool` (the same operations, untyped), `export_mesh` |
| Mesh finishing | `inspect_mesh` (Game-Ready check), `bake_mesh_maps`, `generate_lods`, `generate_collision`, `move_mesh_pivot`, `transfer_rig` |
| Assets | `list_assets`, `list_library_assets`, `view_asset`, `download_asset`, `upload_asset`, `link_asset`, `unlink_asset`, `delete_asset` |
| Asset tags | `list_asset_tags`, `tag_asset`, `find_assets_by_tags` |
| Asset library | `import_library_assets`, `rename_library_asset`, `delete_library_asset` |
| Procedural trees | `list_tree_presets`, `preview_tree_skeleton`, `generate_tree` |
| Particle effects | `describe_vfx_catalog`, `list_vfx_assets`, `get_vfx_graph`, `compile_vfx_graph`, `list_vfx_sprites`, `install_vfx_sprite`, `set_vfx_texture`, `render_vfx_preview`, `save_vfx_graph`, `export_vfx_bundle` |
| Buildings | `describe_building_catalog`, `list_buildings`, `get_building`, `compile_building`, `create_building_graph`, `list_building_styles`, `apply_building_style`, `set_building_reference`, `add_building_wing`, `save_building` |
| Animation (any rigged mesh) | `describe_rig`, `inspect_rig`, `annotate_rig`, `preview_animation`, `save_animation`, `list_animations`, `delete_animation`, `list_motion_library`, `publish_animation`; rig prep: `rebind_weights`, `rename_bones`, `add_bone`, `split_bone`, `rig_rigid_parts` |
| System | `get_settings` (secrets redacted), `update_settings`, `get_system_stats` |

### Context cost and loading only the groups you need

An MCP client injects the **whole tool catalog into the model's system prompt on every request**, before the model reads your message. All 112 tools cost ~201 KB of JSON plus ~5 KB of server instructions — roughly **57,100 tokens per session**, whether or not a single tool is called. That is why even asking a model "are you connected to 3d-gen-studio?" appears to consume ~57k tokens: the question is ~10 tokens, the connection is the rest.

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

Unset, empty, or `all` loads every group, so nothing changes for an existing config. Unknown names are ignored with a warning on stderr rather than failing. Group names: `projects`, `cards`, `graph`, `batch`, `workflows`, `actions`, `mesh`, `tree`, `vfx`, `building`, `animation`, `assets`, `settings`.

| Selector | Tools | Catalog | Saved |
|---|---|---|---|
| *(unset)* / `all` | 112 | ~55,700 tokens | — |
| `-mesh` | 98 | ~43,400 | 22% |
| `-mesh,-actions` | 88 | ~36,900 | 34% |
| `projects,graph,workflows,assets` | 34 | ~9,400 | 83% |
| `projects,mesh,assets` | 35 | ~17,400 | 69% |
| `projects,cards,assets` | 29 | ~6,700 | 88% |
| `projects,settings` | 10 | ~1,600 | 97% |

The server instructions are assembled to match, so dropping a group also drops its guidance, and the model is told which groups were left out — it reports them as "not exposed in this session" rather than claiming the app can't do it.

Over the HTTP endpoint the same selector is available per request as `POST /mcp?tools=graph,workflows`, or as `settings.mcp.tools` for a persistent default.

The heaviest groups are `mesh` (~12,300 tokens across 14 tools), `animation` (~11,400 across 14), `actions` (~6,500 across 10), `assets` (~3,900 across 14) and `tree` (~3,500 across 3) — the parameter-dense ones, since each tool documents its full option set with ranges and defaults. `batch` is ~3,800 across 6 tools, because a batch's whole vocabulary — variables, groups, stages, bindings — has to be explained somewhere and `get_batch` is where an agent reads it back. `building` is ~3,500 across 10, and `vfx` ~3,300 across 10, lighter per tool than their scope suggests because both push their vocabulary into a `describe_*` tool the caller fetches once instead of into every schema.

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

### Batch projects

A **Batch** project is a grid, not a graph. `variables` are declared once, each `group` is one **row** of values for them, and `stages` are a linear chain run once per row — ComfyUI workflows, or the Mesh Editor's own tools (`optimize`, `autouv`, `autorig`, `bake`), each saving a new version of its input mesh — so 4 groups x 3 stages is 12 generations, each saved as an ordinary result card in the project. Six tools cover it:

| Tool | What it does |
|---|---|
| `get_batch` | The whole recipe: variables, group rows, the stage chain with every parameter's source and value, the problems that would block a run, and the results already produced |
| `update_batch` | Writes it. Each section you pass (`variables` / `groups` / `stages`) **replaces that whole section**; a section you omit is untouched |
| `add_batch_groups` | Appends (or inserts at a position) one or more rows, leaving the existing ones untouched |
| `update_batch_group` | Edits one row in place: rename it, and/or merge in new values (`null` / `""` clears one) |
| `remove_batch_groups` | Removes rows by position or name; the other rows keep their results. The removed rows' cards and assets stay in the project |
| `run_batch` | Runs the grid, one generation per cell, streaming progress |

**Sources, not ids.** A stage parameter is fed by one of three things, written the same way in both directions: `"manual"` (the stage's own value), `"variable:<name>"` (the current row supplies it), or `"stage:<n>"` (the output of an earlier stage, 1-based, strictly earlier — which is why a batch chain can never contain a cycle). The document's internal ids never appear: variables are named and stages and groups are positions.

**Image/mesh parameters cannot be typed in.** Bind them to an earlier stage, or to an image/mesh variable whose groups pick assets by id (`update_batch` links each picked asset to the project for you, which a run requires). That is what lets a first stage run over a list of meshes you already have.

**A stage name is a template.** `"{{character}} - {{resolution}}px"` is resolved per row and becomes the result's name, so a result carries the values that produced it.

**Rows and stages keep their identity.** A result card's key embeds the group and the stage it came from, so `update_batch` keeps their ids wherever it can: a row is matched to the existing one by **name** (falling back to its position when it was renamed), so removing or inserting a row through `update_batch` does not shift the other rows' results onto each other; a stage left at the same position keeps the results already sitting in its cells, and a stage keeps its manual values and bindings while its workflow is unchanged. Changing a stage's workflow re-seeds it from that workflow's defaults, because the old values were keyed to parameter ids that no longer exist.

**Running is resumable.** `run_batch` **continues** by default: a cell that already produced an asset is kept and reused as the input for the stages after it, so a stopped, failed or half-finished grid picks up where it left off. `mode: "restart"` regenerates instead, and `groups` / `stages` narrow the walk to some rows or some steps — a filtered restart is how you regenerate a single cell without touching the rest. Long grids are budgeted (`maxSeconds`): when the budget runs out the tool returns what finished, and calling it again carries on.

`executionOrder` decides how the grid is walked: `"group"` finishes one row through every stage before the next row, `"stage"` runs one stage across every row first. The results are identical — the difference is how often ComfyUI has to swap models.

### Animating any rigged mesh ("Animate with AI")

Humanoids are well served by motion libraries and text-to-motion models; robots, monsters, spiders and dragons are not, because every creature's skeleton is different. The `animation` group lets an agent animate **any** rigged mesh by working the way an animator does, and nothing in it writes a bone rotation directly:

1. **Read the rig as a body** — `describe_rig` works out the body plan (quadruped, 8-legged, winged…), the facing, the size, and labels the skeleton as **chains** (`spine`, `neck`, `head`, `tail`, `leg_front_L`, `wing_R`, …) from its *geometry*, not its bone names, so it works on Auto Rig output, hand-made rigs and anything in between. It returns an image with each chain in its own colour. `inspect_rig` checks the rig first (floor/pivot, facing, unweighted vertices, weights leaking across the body, limbs that do not mirror, bone names that contradict where the bone sits) and names the tool that fixes each issue. `annotate_rig` corrects a wrong facing or label and stores it on the asset.
2. **Write a spec** — sparse keyframes of body-relative controls, relative to rest:

   ```json
   { "name": "wag", "duration": 1.0, "loop": true,
     "keys": [
       { "time": 0,   "pose": { "tail.*": { "left": 40 }, "head": { "turn": 15 } } },
       { "time": 0.5, "pose": { "tail.*": { "left": -40 }, "head": { "turn": -15 } },
         "root": { "up": 0.02 } } ] }
   ```

   `forward` / `up` / `left` / `out` swing a chain's tip that way (degrees; `out` = away from the mid line, so one value mirrors on `_L` and `_R`), `turn` / `pitch` / `roll` rotate about the body's axes, `twist` about the bone. `"leg_front_L"` swings the whole limb from its base, `"tail.*"` spreads the angle over the chain (a curl), `"tail[2]"` is one bone. `root` moves and turns the whole body (pitch/roll pivot at the hips). `ik` places a chain's tip as an offset from its rest position, fixed in the world — `{}` plants a foot while the body moves; feet keep their orientation, knees keep their rest bend direction.
   **Layers** describe cycles instead of keying them, and are added on top of the keys every frame:

   ```json
   { "name": "trot", "duration": 0.8, "loop": true,
     "layers": [
       { "type": "gait", "pattern": "trot", "bob": 0.015 },
       { "type": "wave", "chain": "tail", "control": "up", "amplitude": 6, "cycles": 2 },
       { "type": "spring", "chain": "tail", "stiffness": 0.2 } ] }
   ```

   `gait` steps any number of legs with feet planted by IK: `pattern` walk / trot / pace / bound / gallop for four legs, alternate / tripod for six or eight, wave for a metachronal crawl (auto picks by leg count). Stride defaults to what every leg can comfortably reach, and the body crouches automatically so no leg works at full extension (that is an IK singularity, and it pops). `travel: "in_place"` loops on the spot, while `"forward"` advances the root (a root-motion clip). `wave` sends a travelling wave down a chain (slither, tail wag, tentacles), `oscillate` swings one control periodically (wing flaps with `shape: "flap"`, breathing, `root.up` for hops), `noise` adds smooth loop-safe idle fidget, and `spring` makes a chain lag and overshoot behind the motion. Every layer can be windowed with `start` / `end` / `fade`. On a looping clip, whole-number `cycles` keep the seam closed. Chains always run parent → child, so a wave travels away from the body.
3. **Look before saving** — `preview_animation` renders a filmstrip (or, with `pose`, one pose from several views) on the CPU and measures what an animator checks by eye: floor penetration, feet sliding on contact chains (and recognises an in-place treadmill cycle, reporting the root-motion speed), frame-to-frame pops, the loop seam. Single-key channels that hold a value for the whole clip are flagged.
4. **Save** — `save_animation` bakes the clip into the GLB (a new version by default; other clips are kept) and stores the spec inside it, so `list_animations` with a clip name returns the spec for the next edit. `delete_animation` removes one clip.

5. **Reuse existing motion**: give the spec a `base`, either `{"library": "fox", "clip": "Walk"}` (`list_motion_library` lists the bundled mesh2motion species and clips) or `{"assetId": 123, "clip": "Run"}`. That clip is **retargeted by body chains**: `leg_front_L` drives `leg_front_L`, a tail drives a tail, and when labels differ the pairing falls back to kind + side + order (a spider's four leg pairs onto a fox's two). Bones inside a chain are matched by relative position, so names and bone counts do not need to agree. Limbs and tails are swung onto the source's rest directions first (`matchRestPose`), the body is shifted to touch the floor (`groundAlign`), and `chainMap` / `boneMap` override the pairing. Keys and layers add on top, for example a fox walk with a tail `wave` layer. `publish_animation` saves any stored clip to the app's custom animation library, where the Mesh Editor's Custom tab can apply it to other meshes.

**Preparing a rig.** `inspect_rig` also bend-tests every limb, neck and tail joint (45 degrees, and a twist on limbs) and flags triangles that stretch or fold. Its thresholds are calibrated so that the hand-made reference rigs pass. The fixes run in the backend:
- `rebind_weights` either smooths the existing weights, or rebuilds them from the skeleton: each vertex goes to the nearest bones it can see, never to a limb on the other side of the body, and is then smoothed. On an Auto Rig horse the rebuilt weights deformed better than the originals.
- `rename_bones` applies `semantic` names (`tail_3`), `mixamo` names for humanoids, or your own map. Stored specs, the rig profile and saved bone mappings are renamed too.
- `add_bone` adds a child bone that takes over the vertices beyond it.
- `split_bone` turns one bone into a bendable chain.

**Robots and other rigid meshes.** `rig_rigid_parts` rigs an *unrigged* mesh with no learned weights. It finds the parts either from the mesh's separate pieces (`islands`) or, for a fused mesh, from Smart Segmentation (`segment`, which needs the mesh-tools service). Parts that touch are linked, with the biggest part as the root and each part hanging from the neighbour it touches most. Joints sit at the contact points, and each vertex is weighted 1.0 to its part. The tool returns the part tree so you can correct it with `reparent`.

Everything runs in the app backend (`animation/` at the repo root): no GPU, no Python service. Previews are flat-shaded silhouettes — enough to judge motion, not materials.

### Small and local models (LM Studio, Ollama, …)

`run_workflow`'s `inputs` is the one free-form map in the API — a flat parameter id -> bare value — and it is where a small model's output goes wrong. The server repairs what it can rather than rejecting the run, and reports each repair in the response's `warnings`:

- **Chat-template tokens leaking into the JSON.** A locally served model regularly emits its own quote/special tokens inside a key, so `6.text` arrives as `<|"|>6.text<|"|>` (or with stray backslashes/quotes). Any `<|…|>` marker and non-id character around a key is stripped before the lookup, and the same markers are stripped from string values so they never reach a ComfyUI prompt.
- **A near-miss id.** Wrong case (`6.TEXT`), the bare input key without its node id (`text`), or the parameter's display name (`Seed`) resolves to the real id **when the match is unambiguous**. Two parameters could answer to `text`, so that key is an error, not a guess.
- **A wrapped value.** `{"6.text": {"value": "a red robot"}}` or a one-element array is unwrapped to the bare value.

A key that still matches nothing is an error listing the workflow's real parameter ids — and, when template tokens were detected, an explicit note that the keys arrived wrapped. Left unrepaired this is a **retry loop**: the model is certain it copied the id correctly, so it re-issues the identical call forever.

### Parameter-heavy mesh tools

Every mesh operation has a dedicated tool that declares each parameter in its schema with type, range, default, and description (mirroring the Python service's Pydantic models 1:1), so a client can set exactly what it needs and see the valid bounds: `auto_uv_mesh` (31 parameters), `auto_retopo_mesh` (20), `repair_mesh`, `auto_rig_mesh`, `optimize_mesh`, `convert_mesh_fbx`, `inspect_mesh`, `bake_mesh_maps`, `generate_collision`, `generate_lods`, `move_mesh_pivot`, `transfer_rig`. Any subset of options may be set; unset keys fall back to the documented default. For Auto Retopo, the `shell_*` options apply only when `watertight` is `true`. `run_mesh_tool` still accepts every operation with a free-form options object for backward compatibility, but prefer the typed tools.

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

**Rigging a reduced mesh.** Steps 3 and 4 rebuild the topology, which destroys any skin weights the mesh had — the result saves as a static mesh even if the original was rigged. `transfer_rig` is the repair: it copies the skeleton and weights off the pre-reduction version (or any rigged version of the same character) by sampling the nearest point on its surface. It needs no GPU and no service, and because it reuses the *existing* skeleton it keeps the bone names, hand corrections and saved bone mappings that `auto_rig_mesh` would throw away by generating a new one. The two meshes have to be the same character; a source at a different pivot is re-centred automatically, and one that is uniformly larger or smaller — the same character simplified or re-exported in other units by an external tool — is scaled onto the target too, skeleton included, with `rescaled_by` reporting the factor. Only a source whose axes differ by *different* factors (two different shapes, not two units) is refused. Check `far_sample_fraction` in the response — much above `0.05` means the surfaces do not really match.

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
| `run_batch` | ComfyUI running for workflow stages; the Python mesh-tools service for `autouv` and `bake` stages (and for `optimize` when it re-unwraps broken UVs); the rigging service for `autorig` |
| `generate_image`, `edit_image`, `generate_mesh`, `generate_mesh_tencent`, `generate_mesh_tripo`, `generate_mesh_hitem`, `edit_mesh`, `texture_mesh`, `rig_mesh_api` | provider API keys in Settings |
| `auto_uv_mesh`, `auto_retopo_mesh`, `repair_mesh`, `convert_mesh_fbx`, `inspect_mesh`, `bake_mesh_maps`, `generate_collision` | Python mesh-tools service (`:8200`) running — the desktop app can start it from Settings |
| `auto_rig_mesh` | rigging service (`:8300`) running |
| `optimize_mesh`, `generate_lods` | nothing extra (bundled gltfpack) |
| `move_mesh_pivot`, `transfer_rig` | nothing extra (runs in the app backend) |
| `describe_rig`, `inspect_rig`, `annotate_rig`, `preview_animation`, `save_animation`, `list_animations`, `delete_animation` | nothing extra (runs in the app backend); the mesh must be a rigged GLB |
| `rig_rigid_parts` with `method: "segment"` | Python mesh-tools service (`:8200`); `islands` needs nothing extra |

## Limitations

- The **Mesh Editor** modes that run in the browser (WebGL/canvas) are not exposed over MCP: sculpting, modeling, displace/boolean, painting, projection, applying baked maps to a material, and animation retargeting (Auto Rig -> Animations). Authoring *new* animations on any rigged mesh is available through the animation group. **Image Editor** pixel operations (crop, filters, shadow remover) are browser-only too. AI-driven alternatives: ComfyUI workflows (`run_workflow`), prompt-based edits (`edit_image`), and the mesh-tool services. Note that *running* a bake is available (`bake_mesh_maps`) — only applying the result to a material is not.
- `update_settings` refuses to write any field whose key looks like an API key, secret, token, password, or credential. Reads are redacted, so a client that round-tripped a settings object would otherwise overwrite a real key with the redaction placeholder. Set credentials (including `mcp.token`) in the app's Settings dialog or with a direct `POST /api/settings`.
- Not yet exposed: Brainstorming Boards, the Wiki, and tasks.
- If the app UI is open in a browser while an MCP client mutates data, open Graph/Kanban pages refresh automatically via the app event stream; other pages may need a manual refresh.
