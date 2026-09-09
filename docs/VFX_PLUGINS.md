# The Unity and Unreal importer plugins

Specified here; **not built**. This document is what a plugin author needs
before starting, and what the IR was designed against.

Both are **importers**. They read a bundle and build engine assets from
pre-authored templates plus parameter binding. Neither synthesises a graph node
by node. Effekseer (MIT) is the precedent for this whole split.

The direction of the work is **inward**: this app produces a bundle, and
engine-side plugins consume it. Nothing here generates engine-native assets.

## Read this first

- [VFX_EXPORT_BUNDLE.md](VFX_EXPORT_BUNDLE.md) — what you receive.
- [VFX_IR.md](VFX_IR.md) — what you parse. **Not the graph.**
- [VFX_ENGINE_MAPPING.md](VFX_ENGINE_MAPPING.md) — generated; what maps and what
  does not. Regenerate with `node tools/gen-vfx-mapping.mjs`.

## Unity: templates plus exposed properties

Unity can only set **exposed** properties on a `.vfx` from an Editor script. It
cannot build a VFX Graph programmatically in any supported way.

So the plugin ships hand-authored `.vfx` **templates**, one per archetype tier,
copies one per imported effect, and binds:

- exposed properties (floats, vectors, colours, curves, gradients, textures,
  meshes),
- the textures and meshes from the bundle, imported as Unity assets first,
- baked curve LUTs where a curve cannot be set directly.

Tier selection is a **set-cover** problem over `ir.systems[].*[].kernel`: pick
the smallest template whose capabilities are a superset of what the effect uses.
That is why the IR lists kernels by name rather than by opaque index.

## Unreal: emitter inheritance plus User Parameters

Niagara supports emitter inheritance and User Parameters, so the plugin ships
**parent emitters** and generates a System that inherits from them and
overrides. This is a better fit than Unity's and needs fewer tiers.

A Niagara caveat with no equivalent on the Unity side: several location modules
(splines especially) read from a **scene component**, which a bundle cannot
carry. Those import as baked values.

## Five spikes that constrain the IR

These were meant to run before the IR was frozen. **They have not been run.**
Anything below marked *assumed* is a risk that lands on the first plugin.

1. **Which Unity exposed-property types can an Editor script actually set?**
   *Assumed: all of them.* If only `Texture` works, every curve must bake to a
   LUT and the IR must declare its sample count — it does (`tables[].n`), so the
   IR survives either answer.
2. **How many template tiers are really needed?** Requires walking real effects'
   kernel sets. The IR exposes them by name for exactly this.
3. **Coordinate and unit convention.** Recommended: metres, Y-up,
   right-handed; the plugin converts. `mcp/tools/tree.js` already has an
   `engine: 'unity' | 'unreal' | 'godot'` axis vocabulary to reuse.
4. **What determinism to promise.** Answered, in VFX_IR.md: statistical
   conformance, checked against a shipped JSON fixture. Do not promise more.
5. **Are burst lists and spawn-loop timing settable from an Editor script in
   both engines?** *Assumed: yes.* This is the one the timeline feature depends
   on: it decides whether clip timing survives as native spawn timing or has to
   be baked into duplicated spawn contexts. `ir.systems[].schedule` is already
   in whole simulation steps either way.

## Where the plugins live

`plugins/` as a sibling root directory. It is excluded from both build
allowlists automatically — `electron-builder.yml` lists what ships, and the
Dockerfile copies named directories — so adding it needs no build changes. Do
not put plugin code under `src/` or `vfx/`.

## What a plugin must refuse

- A `bundleFormat` outside its supported range.
- An `ir.irFormat` outside its supported range.

Half-importing a bundle you do not fully understand produces an effect that
looks nearly right, which is worse than an error. Report the version and stop.

## What a plugin must report rather than drop

Every entry in `manifest.engineGaps` (when the bundle was targeted) or every
non-`native` row in `manifest.engineMapping` that the effect actually uses.
Compatibility is already surfaced at **author** time — every block carries its
flags in the editor and setting a target raises a diagnostic — so an import
should confirm what the author already saw, never surprise them.

The known gaps today, from the generated table: Niagara has no direct equivalent
for curl-noise turbulence, a point attractor, a speed limit or a line emitter
(all four import as approximations), and no free-form expression graph inside a
module, so a wired operator chain imports as a baked constant or a User
Parameter. Unity takes everything in the catalog natively.
