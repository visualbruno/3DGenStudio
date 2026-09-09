# The VFX graph document

The authoring format: what a `.vfx.json` file contains, and the three shapes in
it that carry real weight. This is the document the editor edits, the MCP tools
read and write, and the compiler consumes. It is **not** what an importer plugin
reads — see [VFX_EXPORT_BUNDLE.md](VFX_EXPORT_BUNDLE.md).

Defined in `vfx/doc.js`. `normalizeVfxDoc(doc)` is the only way to construct
one: it fills defaults, migrates older formats, and re-derives everything
derivable. Every mutator in `src/utils/vfx/edits.js` runs it.

## Shape

```jsonc
{
  "format": 1,
  "kind": "vfx-graph",
  "name": "Explosion",
  "savedAt": 1699999999999,

  "effect": {
    "seed": 12345,          // the effect's identity; particle seeds hash from it
    "duration": 2.0,        // seconds; 0 means "runs until stopped"
    "loop": false,
    "fixedDt": 0.016666,    // the simulation step everything snaps to
    "capacity": 65536,      // hard ceiling; never grown at runtime
    "bounds": [ ... ],
    "simulationSpace": "local",
    "prewarm": 0
  },

  "systems": [{
    "id": "sys-...", "name": "Sparks", "capacity": 2048,
    "simulationSpace": "local", "seedOffset": 1,
    "schedule": { "clips": [{ "id": "clip-...", "at": 0, "duration": 0.4, "loop": false }] },
    "contexts": [{
      "id": "ctx-...", "kind": "initialize",
      "params": { },                  // context settings (Output's blend, sort, mode)
      "blocks": [{
        "id": "blk-...", "type": "initialize.setLifetime", "enabled": true,
        "props": { "lifetime": { "mode": "random", "a": 0.3, "b": 0.9, "v": 0.6 } },
        "modes": { }                  // per-block enum choices, e.g. a sphere's fill
      }]
    }]
  }],

  "events": [ ... ],        // effect-scoped event wiring (sub-emitters)
  "operators": [ ... ],     // small value nodes wired into block properties
  "edges": [ ... ],         // AUTHORITATIVE wiring
  "exposed": [ ... ],       // the blackboard
  "references": { "tex_spark": { "kind": "image", "ref": "asset:412", "name": "spark.png", "colorSpace": "srgb" } },
  "layout": { "nodes": { }, "notes": [ ] }
}
```

## The three shapes that carry weight

### 1. Asset references are slot keys, resolved through one table

A block property holds `"tex_spark"`. `references` maps that to
`asset:<id>`. Never the other way round.

One place for the bundle builder to walk, one place for project import to remap,
and a lost texture degrades to a reportable dangling **key** rather than a
dangling id.

**Every ref is the string `asset:<id>`, held in arrays** in the metadata digest
(`vfxAssetDigest` in `vfx/doc.js`). That exact shape is what
`collectAssetIdsFromValue` matches and `remapReferencesDeep` rewrites in
`storage.js` — so a VFX effect's dependencies travel inside a `.3dgp` and get
renumbered on import with **zero changes to either walker**. Tree presets store
bare numbers, which neither walker can see, and therefore ship silently broken
across installations. That is the cautionary tale, not the model.

### 2. `layout` is never read by the compiler

`vfxSignature(doc)` — the recompile trigger — omits `layout` and `savedAt`.

Dragging a node, tidying the board or typing a sticky note therefore **cannot**
restart the simulation. An author writing a sentence about an explosion while it
plays is the case this protects.

### 3. `edges` is authoritative; `mode: "link"` mirrors it

React Flow needs an edge list, so `edges` is the truth. A property whose value
mode is `"link"` is a one-directional *mirror* of that, so a property row can
say "wired from Curve #3" without scanning every edge on every render.

`normalizeVfxDoc` re-derives every link from `edges`, so edges always win. No UI
code writes `mode = "link"` directly.

## `VfxValue`: one union for every property

Every block property supports the same modes, defined in `vfx/value.js`:

| mode | payload | means |
|---|---|---|
| `const` | `v` | a fixed value |
| `random` | `a`, `b` | drawn once per particle, between two values |
| `curve` | `curve` | evaluated over the particle's normalised life |
| `gradient` | `gradient` | colour over life; separate colour and alpha keys |
| `link` | (mirrors `edges`) | driven by an operator node |
| `exposed` | `exposed` | a blackboard property a host can set |

Two decisions matter:

**Every mode keeps a usable literal `v`.** Flip a property from curve back to
constant, delete the operator an edge pointed at, or open an effect whose
exposed property was renamed — it still evaluates to something sensible.
`setValueMode` preserves what it can (derives `v` from the curve at t=0, `a`/`b`
from `v`). Non-destructive mode switching is what makes an author trust the
switch.

**Curves are Hermite keys** (`{t, v, inTangent, outTangent, interp}`), not Bezier
segments, because both export targets are Hermite — Unity's `Keyframe` and
Niagara's `FRichCurveKey` — so import is a field rename rather than a conversion
the two plugins could disagree about.

**Gradients keep separate colour and alpha key lists**, because Unity's
`Gradient` does and a merged list cannot round-trip. Gradient RGB is **linear
and may exceed 1.0**: additive particles want HDR.

## Contexts

Five kinds, in this order: `event` → `spawn` → `initialize` → `update` →
`output`. A system may have at most one of each except `output`.

The order is not stored — it is derived from the kind, so an illegal ordering is
unrepresentable rather than merely rejected.

## Editing it

- **From code:** `src/utils/vfx/edits.js` — ~50 pure mutators, each
  `doc -> doc`, each running `normalizeVfxDoc`.
- **From an agent:** the `get_vfx_graph` / `compile_vfx_graph` /
  `save_vfx_graph` MCP tools.
- **By hand:** valid, and `normalizeVfxDoc` will fill in the rest — but compile
  it before saving, or the first thing you learn will be from an empty viewport.
