# 3D Gen Studio VFX Import (Unity)

Imports a VFX bundle exported from 3D Gen Studio and builds a Unity particle
effect from it: one prefab, one `ParticleSystem` per system in the effect, with
the textures, meshes and materials it needs.

Editor-only. Nothing ships in a player build.

## Install

Copy `com.3dgenstudio.vfx-import/` into your project's `Packages/` folder, or add it
by path from the Package Manager (**+ → Add package from disk…**).

Requires Unity 6000.0 or newer. It has **no render-pipeline requirement** —
Shuriken works under Built-in, URP and HDRP alike — though the material it
creates looks for URP's particle shader first and falls back to the built-in
ones.

## Use

**Assets → Import VFX Bundle…**, then pick the folder the app wrote (the one
containing `manifest.json`). The effect lands in
`Assets/ImportedVfx/<bundle>/`, with a `.import-report.txt` beside the prefab
saying exactly what came across natively, what was approximated and what could
not be carried at all.

## Why Shuriken and not VFX Graph

This was measured, not assumed — see `../Spikes/`, which runs against your own
Unity install and writes its answers to disk.

**VFX Graph's graph model is `internal`.** `VFXGraph`, `VFXContext`, `VFXBlock`
and `VFXModel` cannot be touched by a plugin, and there is no public
asset-creation API. A VFX Graph importer can therefore only *bind exposed
properties on a template a human drew by hand*, which caps structural fidelity
at whatever that template has slots for: a fixed number of systems, a fixed
number of bursts, one renderer per system.

**Shuriken's modules are all public, writable, and survive a prefab save.** A
burst list of any length, curves with their tangents, gradients with separate
colour and alpha rails, every emitter shape the catalog uses, forces, noise,
collision, spin, sub-emitters, billboard/stretched/mesh rendering and sorting.

So Shuriken carries strictly more of the effect across and needs no
hand-authored assets. A VFX Graph backend is still worth having for effects that
need GPU particle counts; it needs templates before it can exist.

## Platform reach

A second reason Shuriken wins, and it was not the deciding one but it matters
more in practice than the first: **Shuriken runs everywhere Unity runs.** It is
CPU-simulated, so it needs no compute shaders and no SSBOs, and it works under
Built-in, URP and HDRP alike.

Visual Effect Graph does not. From its own package documentation
(`com.unity.visualeffectgraph`, Documentation~/System-Requirements.md):

- it requires **compute shader** support and **SSBO** support;
- **"The Visual Effect Graph does not support Open GL ES"** - which rules out a
  large share of Android devices and builds;
- and on URP specifically it **"isn't out of preview ... which means it only
  supports some of the platforms that URP supports."**

WebGL follows from the compute requirement: there are no compute shaders there.

So an effect imported through this plugin ships on mobile, on WebGL and on
low-end hardware. A VFX Graph backend would be a desktop-and-console feature.

## Coordinate space

The IR is **right-handed**, Y-up, metres. **Unity is left-handed** — measured,
not recalled: `Vector3.Cross(right, up)` returns `(0, 0, 1)`.

Same up axis, same unit, opposite handedness, so every position, velocity,
direction and offset has its **Z negated**, and euler rotations have X and Y
negated. That lives in `VfxConvert` and nowhere else. Skipping it mirrors the
effect — obvious on a vortex, invisible on a sphere emitter, which is the
combination that ships broken.

The importer reads `ir.space` and **refuses** a bundle in a space it does not
recognise rather than importing it wrongly.

## What it refuses

- A `bundleFormat` or `irFormat` outside its supported range.
- A coordinate space it cannot convert.

Half-importing a bundle you do not fully understand produces an effect that
looks nearly right, which is worse than an error.

## Known gaps

| Feature | Status |
|---|---|
| Point attractor | **Dropped.** No Shuriken module attracts toward a point. |
| Kill on bounds | **Dropped.** Shuriken kills on lifetime only. |
| Sphere / box collision | **Approximated.** Shuriken collides with scene colliders or planes, not implicit shapes. |
| Curl-noise turbulence | **Approximated.** Unity's noise module is value noise, so the motion differs in character. |
| Vortex | **Approximated.** Becomes orbital velocity: right swirl, but a fixed angular rate rather than a force, so no falloff with distance. |
| Directional / random start velocity | **Approximated.** Becomes velocity-over-life, re-applied per frame rather than drawn once at birth. |
| HDR gradient keys | **Approximated.** Unity's `Gradient` is LDR; intensity is folded into the colour. Use material emission for the glow. |
| Gradients past 8 keys per rail | **Approximated.** Unity's hard limit; the excess is dropped and reported. |
| `.glb` meshes | **Dropped** unless a glTF importer is installed. Unity has no built-in one — add `com.unity.cloud.gltfast` or UnityGLTF, or export the mesh as FBX. |

Every one of these is reported per import, by name. Compatibility is already
surfaced at *author* time in the app, so an import confirms what the author
already saw rather than surprising them.
