# The VFX export bundle

What `GET /api/assets/:id/vfx-export-plan` returns, and what an importer plugin is
expected to do with it.

## It is a plan, not an archive

```
GET /api/assets/42/vfx-export-plan?engineTarget=unity&appVersion=3.3.1

{
  "manifest": { ... },
  "files": [
    { "storagePath": "data/assets/vfx/1699-abc.json", "dest": "vfx/1699-abc.json" },
    { "storagePath": "data/assets/images/1699-def.png", "dest": "assets/images/1699-def.png" }
  ]
}
```

There is no zip library in this repo, and `.3dgp` project export already works
this way. The caller writes `manifest.json` itself and fetches each file's bytes
over HTTP:

```
GET /assets/<storagePath with the leading "data/" removed>
```

`source` — the absolute path on the server's disk — is deliberately **stripped
by the route**. A remote-connected install runs the same code against a shared
server, where an absolute path means nothing; fetching by `storagePath` works in
both modes with no branch.

`dest` is where the file belongs *inside the bundle*, so a caller that does
build an archive gets a stable layout: `vfx/` for the graph and its thumbnail,
`assets/images/` and `assets/meshes/` for what it references.

## Two routes, and the suffix is load-bearing

| Route | Runs | Does |
|---|---|---|
| `GET /api/assets/:id/vfx-export-plan` | Where the **database** is | Builds the manifest and the file list. Writes nothing. |
| `POST /api/assets/:id/vfx-export` | Where the **user** is | Writes the bundle to a folder: `{ folder, name?, engineTarget? }`. |

They are two paths rather than a GET and a POST on one because `serverMode.js`
classifies routes **by path, not by method**. In remote mode the plan has to be
fetched from the shared server while the files have to land on the machine the
user is sitting at; a single path could only be all-local or all-remote. The
project export learned this first — forwarded, a Windows folder like
`C:\Travaux` is not an absolute path on Linux, and a POSIX-looking one would
have silently written inside the container.

`POST` answers `{ folder, name, fileCount, warnings }`. Copy failures are
per-file warnings, not a failed export: one unreadable texture must not cost the
author the other nine files and the manifest.

## The manifest

| Field | What it is |
|---|---|
| `bundleFormat` | Bumped when a change would make an existing plugin **misread** a bundle. Refuse what you do not understand. |
| `appVersion` | Whatever the caller passed. Provenance only. |
| `exportedAt` | Epoch milliseconds. |
| `engineTarget` | `"unity"`, `"unreal"` or `null` if the caller did not say. |
| `asset` | `{ id, name, file, thumbnail }` — `file` and `thumbnail` are `dest` paths. |
| `graph` | The authoring document. **Provenance and round-tripping, not import.** |
| `ir` | The compiled IR. **This is what a plugin reads.** |
| `stats` | Peak particles, draw calls, bytes per particle, per-engine support. |
| `engineMapping` | The whole compatibility table, generated from the catalog. |
| `engineGaps` | Only what `engineTarget` cannot take intact. `null` when untargeted. |
| `references` | Every asset slot: `{ slot, kind, ref, name, colorSpace, file }`. `file` is `null` for a slot with no asset behind it. |
| `warnings` | Missing assets, plus every compile diagnostic above info severity. |

## Read the IR, not the graph

This is the one decision worth stating plainly, because getting it wrong doubles
the work and then triples it.

The graph is what an author edits. The **IR** is what the compiler produces
*after* operator topological sort, frequency classification, curve baking,
capacity solving and validation. If each plugin parsed the raw graph, that
compiler would be reimplemented twice more — once in C# and once in C++ — and
any divergence between the three would mean Unity and Unreal disagreeing about
the same effect, with this app's preview as a third opinion.

`ir.irFormat` is versioned separately from `bundleFormat`. A plugin declares the
range it supports and **refuses** anything outside it. Half-importing an IR you
do not understand produces an effect that looks nearly right, which is worse
than an error.

## A missing reference is a warning

A half-authored effect is the normal case — an author exports to check something
in-engine long before every texture is final — so a dangling slot produces:

```json
{ "code": "MISSING_ASSET", "severity": "warn", "slot": "tex_spark",
  "ref": "asset:412",
  "message": "The image slot \"tex_spark\" points at an asset that is not in this library..." }
```

and the export **still succeeds**, without that file. An *empty* slot (the
author has not chosen anything yet) is not a warning at all: it appears in
`references` with `file: null`, because the effect draws with a built-in
stand-in and reporting it would make every new effect export shouting about work
in progress.

An unreadable or unparseable graph file is different, and fails with a 500: that
is not a degraded bundle, it is an empty one.

## Asset slots

Blocks never reference an asset id. They reference a **slot key**, and
`references` resolves it:

```json
"references": [
  { "slot": "tex_spark", "kind": "image", "ref": "asset:412",
    "name": "spark.png", "colorSpace": "srgb",
    "file": "assets/images/1699-def.png", "assetName": "Spark" }
]
```

One table to walk when building a bundle, one place to remap on import, and a
lost texture degrades to a reportable dangling *key* rather than a dangling id.

`colorSpace` is recorded at compile time from the asset's origin, never guessed:
base colour and emissive are `srgb`, masks and noise are `linear`. A plugin that
guesses will be wrong for one of the two.

## Errors

| Status | When |
|---|---|
| 400 | The id is not a number, the asset is not a `Vfx` asset, or `engineTarget` is not `unity`/`unreal`. |
| 404 | No asset with that id. |
| 500 | The graph file could not be read or parsed. |

## Reading a bundle back

The Assets page's **VFX → Import Bundle** button reads a folder written by
`POST /api/assets/:id/vfx-export` and installs it here: its textures and meshes
become library assets, and the effect is saved pointing at *their* ids.

**The browser does this, not the server, and there is no import route.** Export
has to be server-side because a browser cannot write a folder of files; reading
one is the opposite problem — a directory input hands the page every byte
already. A server route would have to read the *user's* disk while writing the
*shared* database, which is the split `serverMode.js` special-cases for project
import (a staging upload, a second route, two classifier entries). Doing it in
the page costs none of that and works unchanged in local, Electron and
Docker-server installs.

| Piece | Where |
|---|---|
| The format: manifest gate, needs list, reference remap | `vfx/bundle.js` (pure) |
| The install: locate the folder, upload, save | `src/utils/vfx/bundleImport.js` |
| The dialog | `src/components/vfx/VfxImportDialog.jsx` |

### A slot the bundle could not supply is emptied

This is the whole reason the remap is a tested function rather than a loop in a
component. `asset:412` is a row in the **exporting** machine's database. On the
importing machine 412 is either nothing or, far worse, an unrelated image — and
whoever imported it can never see the breakage, because their library really
does contain a 412.

So every slot is rewritten. One whose file was installed points at the new local
id; one whose file did not ship (`file: null`, the `MISSING_ASSET` case above),
failed to upload, or is not in the manifest at all is set to `ref: ""`. An empty
ref is what an unfilled slot looks like everywhere else: the effect opens, draws
with the built-in stand-in, and the diagnostics say a sprite is missing. The
import reports each one rather than leaving it to be discovered.

### Reuse is by kind and name stem

A re-import adopts what is already here instead of adding a second copy. The
match drops the extension — the exporting library's display name is whatever the
author typed (`Spark`), while the name it lands under here is the file it
arrived as (`Spark.png`), because `/api/assets/library/import` names an asset
after its file. It is scoped by kind, so a `flame.png` cannot be adopted as the
mesh a `flame.glb` slot wants. The dialog's **Reuse library assets with the same
name** checkbox turns it off.

### Verified across two installations

`tools/vfx-bundle-import-e2e.mjs` exports from one server and imports into
another with a separate data directory, then reads the saved graph file back and
checks it names the *importing* install's id. One installation cannot prove
this: the imported ids coincide with the exported ones and the check passes
either way. It is the sibling of `tools/vfx-export-e2e.mjs`, which asks the same
question of a `.3dgp` project bundle — where the remap happens on the server
instead (the Phase B remap in `storage.js`).

Both routes still exist and are for different jobs: a `.3dgp` carries a whole
project, a VFX bundle carries one effect and is also what an engine plugin
reads.
