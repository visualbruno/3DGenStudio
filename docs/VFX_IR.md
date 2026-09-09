# The VFX IR

The contract. Flat, index-based, engine-agnostic — produced by
`compileVfxGraph(doc)` in `vfx/compile.js`, and consumed by three things that
must not disagree:

```
  VFX Graph JSON  (authoring)
        │  compile
        ▼
  VFX IR  ──▶ the preview runtime (src/utils/vfx/)
          ──▶ the Unity importer plugin
          ──▶ the Unreal importer plugin
```

Defined in `vfx/ir.js`. `VFX_IR_FORMAT` is bumped whenever a change would make
an existing plugin **misread** a bundle.

## Five guarantees

1. **It is plain JSON.** No typed arrays, no `NaN`, no `undefined`, no class
   instances. A `Float32Array` looks like an array right up until
   `JSON.stringify` turns it into an object with numeric keys, and `NaN` becomes
   `null` and then a silent zero on the far side of a language boundary. There
   is a test that walks every fixture's IR asserting this.

2. **Everything is referenced by index.** Constants, tables, assets, registers
   and uniforms are flat arrays; a binding names a slot in one of them. No
   pointers to share, no names to collide.

3. **Order is meaningful and stable.** Blocks run in the order listed; systems
   are ordered so a parent steps before any child that listens to its events.
   The same document compiles to a byte-identical IR twice.

4. **Attributes are per-effect, not a fixed struct.** `system.attributes` lists
   only what some block in *that* system touches. A simple spark needs ~15
   floats per particle; one with rotation, flipbook and custom data needs 21.
   Not allocating the rest is a free cut on a bandwidth-bound loop, and it is a
   compile-time decision so the runtime never branches on it.

5. **Every binding has the same shape.** Whether the author typed a number,
   dragged a curve, set a random range or wired an operator, a kernel reads its
   input through one `VfxIrBinding`. That collapse is what keeps the kernel
   catalog small and each kernel monomorphic.

## Shape

```jsonc
{
  "irFormat": 1,
  "graphHash": "…",          // identity; the runtime rebuilds when it changes
  "effect": { "seed": 12345, "duration": 2, "loop": false, "fixedDt": 0.0166, "capacity": 65536 },

  "constants": [ 9.8, 0.5, ... ],        // every folded literal, deduplicated
  "tables":    [ { "kind": "curve", "n": 65, "data": [ ... ], "min": 0, "max": 1 } ],
  "assets":    [ { "slot": "tex_spark", "kind": "image", "ref": "asset:412",
                   "assetId": 412, "colorSpace": "srgb", "flipY": true } ],
  "uniforms":  [ { "name": "Intensity", "offset": 0, "width": 1 } ],
  "eventChannels": [ ... ],

  "systems": [{
    "id": 0, "name": "Sparks", "capacity": 2048, "seedOffset": 1,
    "attributes": [ { "name": "position", "width": 3, "offset": 0 }, ... ],
    "schedule": [ { "startStep": 0, "endStep": 24, "loop": false } ],   // SNAPPED TO STEPS
    "spawn":  [ { "kernel": "spawn.rate", "bindings": [ ... ] } ],
    "init":   [ ... ],
    "update": [ ... ],
    "outputs":[ { "mode": "billboard", "blend": "additive", "instanceLayout": { ... } } ],
    "peakParticles": 140, "peakExact": true
  }]
}
```

### A block

```jsonc
{
  "kernel": "shape.position.sphere",   // what the runtime dispatches on
  "srcBlockId": "blk-…",               // back-reference for diagnostics only
  "srcBlockType": "initialize.positionSphere",
  "modes":      { "fill": "surface" },
  "bindings":   [ { "prop": "radius", "src": "const", "index": 3, "width": 1 } ],
  "assetSlots": { "mesh": 0 },         // index into ir.assets, or -1
  "pre":        [ ... ],               // operator ops to evaluate first
  "attributes": [ "position" ],
  "stage":      "before"               // Update blocks only; "after" runs post-integration
}
```

### Binding sources

| `src` | Extra fields | Meaning |
|---|---|---|
| `const` | `index` | `constants[index]`, `width` channels |
| `random` | `loIndex`, `hiIndex` | drawn per particle between two constants |
| `curve` | `table`, `scale` | `tables[table]` sampled at normalised age |
| `gradient` | `table` | four channels of colour over life |
| `register` | `reg` | an operator's output, evaluated by `pre` |
| `uniform` | `offset` | a blackboard property |

`srcWidth` is present when a narrow source feeds a wide property: a scalar wired
into a vec3 **broadcasts**. Without it the vec3 read `regs[0..2]` — one real
value and two belonging to unrelated operators — so gravity wired from a `7`
became `(7, 0, 0)`.

## Curves are baked *and* authored

`tables` holds `Float32Array(65)` samples (2ⁿ+1, so the endpoints are exact
samples), raised to 257 where peak curvature demands it — **adaptive on
curvature, not key count**, since a 3-key curve can have a sharper corner than a
12-key one. Tables are content-addressed, so two blocks sharing a curve share one
table.

The IR carries **both** the baked tables (for the preview, and for a host that
cannot rebuild a curve) and the authored keys (for the importer plugins, which
can). They are produced together from one source so they cannot drift.

## The schedule is in whole steps

`schedule[].startStep` / `endStep` are integers, not seconds. Clip times snap to
`fixedDt` multiples at compile time so scheduling is deterministic and a preview
cannot disagree with an export about when a burst fires.

## What the IR does NOT promise

**Bit-identical particles.** Unity and Niagara each have their own RNG and
neither lets us inject PCG32, so a spark that goes left in the preview may go
right in an engine.

What travels exactly: topology, block order, every curve and gradient key,
constants, shapes, blend modes, clip timing, and *which* properties are random
over *which* range. Seeds travel too, so an engine's own result is reproducible
even though it differs from the preview's.

The contract is **statistical conformance**: matching spawn counts, lifetime
distributions, colour ramps and bounds. Do not promise more in a plugin's
documentation than this section does.

## Determinism inside this app

The preview *is* bit-reproducible, and deliberately so.
`particleSeed = pcgHash2(effectSeed ^ seedOffset, globalSpawnIndex)` — a hash of
a counter, not a walk. A particle's randoms depend on *which* particle it is,
not on how many were alive when it was born, which makes the simulation
invariant to spawn ordering and to float wobble in the accumulator. Per-particle
draws use `pcgAt(particleSeed, slot)` where `slot` is hashed from
`(blockId, prop)` at compile time, so inserting a block never shifts another
block's numbers.
