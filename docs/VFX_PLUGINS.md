# The Unity and Unreal importer plugins

**Both are built and verified** against real exported bundles: Unity against
Unity 6000.6.0f1, Unreal against UE 5.8.2. This document is what a plugin author
needs before starting, and what the IR was designed against. Everything measured
rather than recalled has its spike script and raw output committed under
`plugins/unity/Spikes/` and `plugins/unreal/Spikes/`.

Both are **importers**: they read a bundle and build engine assets. The
direction differs, and the difference is forced by the engines rather than
chosen.

- **Unity builds a Shuriken particle system**, module by module, because
  Shuriken's modules are all public and writable. VFX Graph's graph model is
  `internal` and cannot be authored from script at all.
- **Unreal builds a Niagara system structurally** — real emitters, real module
  stacks, real module inputs — through `UNiagaraExternalEditUtilities`. The plan
  assumed this would have to be template-binding the way Unity's VFX Graph
  forces; it does not, which is why an imported effect opens as something an
  author can edit rather than as a black box with knobs.

Neither synthesises shader code. Effekseer (MIT) is the precedent for the split.

The direction of the work is **inward**: this app produces a bundle, and
engine-side plugins consume it. Nothing here generates engine-native assets.

## Read this first

- [VFX_EXPORT_BUNDLE.md](VFX_EXPORT_BUNDLE.md) — what you receive.
- [VFX_IR.md](VFX_IR.md) — what you parse. **Not the graph.**
- [VFX_ENGINE_MAPPING.md](VFX_ENGINE_MAPPING.md) — generated; what maps and what
  does not. Regenerate with `node tools/gen-vfx-mapping.mjs`.

## Unity: the Shuriken Particle System — BUILT

`plugins/unity/com.3dgenstudio.vfx-import/`, a UPM package. Verified end to end
against Unity 6000.6.0f1 + URP 17.6.0: two real bundles exported from the app
and imported into prefabs in batch mode. Evidence in `plugins/unity/Spikes/`.

**It targets Shuriken, the built-in Particle System — not Visual Effect Graph.**
That reverses what this document originally specified, and the reversal was
forced by measurement:

1. **VFX Graph cannot be authored from a script.** `VFXGraph`, `VFXContext`,
   `VFXBlock` and `VFXModel` are all `internal`, and there is no public
   asset-creation API. A plugin can only bind *exposed properties* on a graph
   somebody drew by hand.
2. **No shipped template exposes anything to bind.** All seven `.vfx` files in
   the package's own `Editor/Templates` — `Empty`, `Firework`, `Head_Trail`,
   `Minimal_System`, `Simple_Burst`, `Simple_Loop`, `Simple_Trail` — report
   **zero** exposed properties. So a VFX Graph backend does not start from a
   stock template; it starts from an empty graph that must be drawn *and* have
   every property exposed deliberately, per tier.
3. **Shuriken can be built entirely from script**, and every module survives a
   prefab save: burst lists of any length, `AnimationCurve`s with tangents,
   `Gradient`s with separate colour and alpha rails, all the emitter shapes the
   catalog uses, forces, noise, collision, spin, sub-emitters, render modes and
   sorting.
4. **Shuriken reaches every platform.** It is CPU-simulated, so no compute
   shaders and no SSBOs. VFX Graph's own requirements page states it needs both,
   that it **"does not support Open GL ES"**, and that on URP it **is not out of
   preview and "only supports some of the platforms that URP supports"** — so
   VFX Graph is effectively desktop and console, while Shuriken also covers
   mobile, WebGL and low-end hardware.

A VFX Graph backend therefore stays **deferred, not rejected**: it would add GPU
particle counts on desktop and console, and the honest cost is a set of
hand-authored templates (one per renderer mode x blend mode, since blend is a
graph *setting* and cannot be an exposed property) plus a validator that checks
each template exposes the contract's property names. Nothing in the IR blocks
it; the work is asset authoring, which is a human's.

### What the importer does

One prefab per bundle, one `ParticleSystem` per IR system. It reads
`srcBlockType` rather than the lowered `kernel`, so it can name the author's own
block when reporting a gap. Every import writes a `.import-report.txt` beside
the prefab listing what came across natively, what was approximated and with
what mechanism, and what was dropped.

Notable mappings, all measured rather than assumed:

- The timeline's clips become a **rate curve over the system duration** with
  stepped keys, so N spawn windows survive natively — no burst approximation and
  no template slot to run out of. `durationSteps <= 0` means the window stays
  open forever, which is what the runtime's `anyWindowOpen` does.
- Buoyancy — the fire presets' upward gravity — becomes a **negative**
  `gravityModifier`, exactly.
- Compiler-injected kernels (`init.snapshot`, `age.advance`,
  `integrate.semiImplicit`) carry no `srcBlockType` and are skipped; Shuriken
  ages and integrates itself.

## Unreal: a Niagara system built module by module

**No templates and no inheritance.** `UNiagaraExternalEditUtilities` can create
a system, add emitters from a stock template, add modules to their stacks, and
set any module input — including data interfaces, dynamic inputs and static
switches. So each IR system becomes one emitter cloned from Niagara's `Minimal`
template and then filled in. It is C++ only: that header carries zero
`UFUNCTION` macros, so Python and Blueprint cannot reach it despite the class
deriving from `UBlueprintFunctionLibrary`.

Two engine behaviours decide whether the mapping works at all, both measured
and both silent when got wrong — see `plugins/unreal/Spikes/probe-niagara-schema-5.8.2.txt`:

1. **Enum entries must be resolved by display name at runtime.** Niagara's mode
   enums are user-defined assets whose internal entry names are
   `NewEnumerator0`, `NewEnumerator1`… **and the numbering does not follow the
   display order** — in `ENiagara_SizeScaleMode`, "Uniform" is `NewEnumerator3`.
2. **A static switch does not reveal the inputs it governs until the edit
   context is rebuilt.** The write succeeds and reads back correctly; the
   revealed inputs stay hidden, so the next twenty writes are refused. Waiting
   for compilation does nothing. A new `FNiagaraExternalEditContext` on the same
   system fixes it.

The old caveat in this document — that a spline emitter must read from a scene
component a bundle cannot carry — **was wrong, and the curve emitter is where
Unreal now beats Unity.** A path does not need a level spline: it becomes a
**Vector Curve data interface** living inside the asset, keyed by cumulative
distance along the path, sampled per particle on `Position`. Tangent speed
becomes a second curve of unit tangents driving Add Velocity, sampled at the
*same* per-particle value, so a particle sits on the path and travels along it.
Shuriken has no bending shape at all, so the same block degrades there to the
straight chord between its end points.

## Five spikes that constrain the IR

**Run 2026-09-10 against Unity 6000.6.0f1 + URP 17.6.0 + Visual Effect Graph
17.6.0.** The script and its raw output are committed at
`plugins/unity/Spikes/` so the answers can be re-measured against a future
Unity rather than trusted from this document.

1. **Which Unity exposed-property types can an Editor script actually set?**
   **ANSWERED: all of them, including curves and gradients.** `VisualEffect`
   exposes `SetFloat`, `SetInt`, `SetUInt`, `SetBool`, `SetVector2/3/4`,
   `SetMatrix4x4`, `SetTexture`, `SetMesh`, `SetSkinnedMeshRenderer`,
   `SetGraphicsBuffer` and - the two that mattered - **`SetAnimationCurve` and
   `SetGradient`**, each in both string and int-id overloads.

   So **nothing has to be baked to a LUT.** An authored Hermite key maps
   field-for-field onto a Unity `Keyframe`, which is why the IR keeps the
   authored curves and gradients beside the baked tables: the tables are for the
   preview, and the plugin reads the keys. The `tables[].n` sample count stays in
   the IR for Niagara and for any future target that cannot take a curve, but
   Unity does not need it.

2. **How many template tiers are really needed?** **Constrained by spike 5, not
   by op coverage.** Since a graph cannot be built from script (below), a tier is
   a pre-authored `.vfx` and the tier count is driven by *structure* an effect
   needs and a property cannot express: the number of systems, the renderer per
   system, and the number of burst slots. Op coverage is not the axis - every
   force in the catalog is native to VFX Graph.

3. **Coordinate and unit convention.** **MEASURED, and it is the one finding
   with a consequence for the exporter.** `Vector3.Cross(right, up)` returns
   `(0, 0, 1)`, so Unity is **left-handed**, Y-up, with gravity `-9.81` on Y and
   one unit to the metre.

   Our IR is three.js's convention: **right-handed**, Y-up, metres. Same up
   axis, same unit, *opposite handedness* - so the importer must **negate Z** on
   every position, velocity, direction and offset it binds, and negate the X and
   Y components of any euler rotation. This is not a preference to be settled
   later; an effect imported without it is mirrored, which on anything with a
   vortex or a directional emitter is visibly wrong and on a sphere emitter is
   invisibly wrong. Record it once, in the plugin's conversion helper, and never
   inline it.

4. **What determinism to promise.** **Answered, and now with the mechanism to
   back it.** `VisualEffect` carries `startSeed` and `resetSeedOnPlay`, so the
   IR's per-system seed travels into Unity's own seed field and an imported
   effect is reproducible *in Unity*. It still will not match this editor's
   per-particle numbers - Unity's RNG is not PCG32 - so the promise stays what
   VFX_IR.md says: **statistical conformance**, checked against a shipped
   fixture. Do not promise more.

5. **Are burst lists and spawn-loop timing settable from an Editor script?**
   **ANSWERED, and this is the constraining finding: a graph's STRUCTURE cannot
   be authored from script.** `VFXGraph`, `VFXContext`, `VFXBlock` and
   `VFXModel` are all `internal` in `Unity.VisualEffectGraph.Editor`, and there
   is no public asset-creation utility.

   So the plan's "pre-authored templates plus parameter binding" is **required,
   not merely preferred** - a plugin that tried to synthesise a graph node by
   node would have to use reflection against internal types and would break on
   any package update.

   What that means for the timeline: a burst *list* is graph structure, so its
   LENGTH is fixed by the template. Clip timing survives as **exposed properties
   on a template with N burst slots** - each slot a delay and a count, both
   settable via `SetFloat`/`SetInt` - plus the runtime levers `playRate`,
   `Play`, `Stop`, `SendEvent` and `Reinit`, all of which are public. An effect
   whose schedule needs more clips than the widest template has slots is a
   reportable gap, not a silent truncation.

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

The known gaps today, from the generated table. **Neither engine takes
everything**, and the earlier claim in this document that Unity did was wrong.

- **Unreal** approximates turbulence (Curl Noise Force is the same kind of
  noise, scaled differently), the point attractor (same shape of falloff,
  different strength at a given distance) and the speed limit (the clamp lives
  inside Solve Forces and Velocity rather than in its own module). It has no
  free-form expression graph inside a module, so a wired operator chain imports
  as a baked constant or a User Parameter.
- **Unity** approximates the line and curve emitters (Shuriken has no shape that
  bends, so both become boxes or chords), turbulence (its noise module is value
  noise, not curl noise, so the motion swirls differently at the same strength),
  random velocity, and any gradient that is HDR or has more than eight keys per
  rail, because `Gradient` is LDR and capped.

The two engines are furthest apart on the **curve emitter**: native in Unreal,
a straight chord in Unity.
