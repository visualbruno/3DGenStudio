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

## Cross-installation imports

A bundle is for engines. Moving an effect between two installations of this app
goes through `.3dgp` project export instead, which carries the effect *and*
renumbers its `asset:<id>` references on import — see the Phase B remap in
`storage.js`. That remap is verified by `tools/vfx-export-e2e.mjs`, which runs
two servers with separate data directories, because with one installation the
imported ids coincide with the exported ones and the check proves nothing.
