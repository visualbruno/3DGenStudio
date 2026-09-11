# 3D Gen Studio VFX Import (Unreal)

Imports a VFX bundle exported from 3D Gen Studio and builds a **Niagara system**
from it — real emitters and module stacks, not parameters bound onto a template.

Editor-only. Nothing ships in a packaged game.

> **Status: working, with gaps.** The IR → Niagara mapping is written and
> verified against a real exported bundle: emitter state, spawn rate and bursts,
> lifetime, size, colour, mass, rotation, the shape emitters, velocity, the
> forces, colour-over-life, size-over-life, the floor plane, kill volumes — and
> the **curve/spline emitter**, which Unreal carries better than Unity does.
> **Textures and meshes are not imported yet**, so an imported effect has the
> right motion and a default material; the report says so every time.

## Requirements

| | |
|---|---|
| Unreal Engine | **5.8** (built and verified against 5.8.2) |
| Compiler | Visual Studio 2022 with the **Game development with C++** workload |
| .NET | Whatever UnrealBuildTool needs; a current .NET SDK is enough |

**Why a compiler is needed, when the Unity plugin needs none.** Unity compiles
C# inside the Editor, so a plugin is just files. Unreal plugins that contain C++
are native modules and must be built by MSVC before the editor can load them.
This plugin *has* to be C++: the API that can author a Niagara system,
`UNiagaraExternalEditUtilities`, carries no `UFUNCTION` macros, so it is
unreachable from Blueprint and Python — see `../Spikes/`.

## Install

### 1. Copy it into the project

```
<YourProject>/
  YourProject.uproject
  Plugins/
    VfxImport/            <- copy plugins/unreal/VfxImport here
      VfxImport.uplugin
      Source/
```

Create the `Plugins` folder if the project has none. This is a **project
plugin**: only this project sees it. (The alternative, an *engine* plugin under
`Engine/Plugins/Marketplace/`, makes it available to every project but means
writing into the engine install and redoing it on every engine update.)

### 2. Make sure the project can build C++

A Blueprint-only project has no `Source/` folder and no build target, so there is
nothing for the plugin's module to be built alongside. Two ways to fix that:

- **In the editor:** *Tools → New C++ Class…*, pick `None`, and let it create
  the class. That generates `Source/` and turns the project into a code project.
  Delete the class afterwards if you like — the `Source/` scaffolding is what
  matters.
- **By hand:** add `Source/<Project>.Target.cs`, `Source/<Project>Editor.Target.cs`
  and a minimal module, which is what the spike project does.

If the project is already a C++ project, skip this.

### 3. Build

Opening the project will notice the new module and offer to rebuild — accept,
and that is usually all you need.

To build explicitly instead (and to see real errors when it fails):

```bat
"C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" ^
  YourProjectEditor Win64 Development ^
  -Project="C:\path\to\YourProject.uproject" -WaitMutex
```

The target name is the project name with `Editor` appended. From Git Bash, set
`MSYS_NO_PATHCONV=1` first or the `/Game/...` style arguments get rewritten into
Windows paths.

### 4. Confirm it loaded

Open the project and check *Edit → Plugins → FX* for **3D Gen Studio VFX
Import**. It declares `"EnabledByDefault": true`, so it should already be on.

The log line `LogVfxImport: VfxImportEditor loaded` appears at startup.

Headlessly:

```bat
"C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" ^
  "C:\path\to\YourProject.uproject" -run=VfxImport -unattended -nosplash -nopause -stdout
```

## Importing an effect

In the editor: **Tools → 3D Gen Studio → Import VFX Bundle…**, pick the folder
the export wrote (the one holding `manifest.json`), and the system lands in
`/Game/ImportedVfx`. A dialog gives the counts; the full report is in the Output
Log under `LogVfxImport`.

From the command line, which is what a build step wants:

```bat
UnrealEditor-Cmd.exe "C:\path\to\YourProject.uproject" ^
  -run=VfxImport -bundle="C:\path\to\Bundles\Magic Bolt" ^
  -path=/Game/ImportedVfx -report=import.txt ^
  -unattended -nosplash -nopause -stdout
```

Exit code 0 means the system was built and saved. Re-importing over an existing
asset overwrites it in place.

### Read the report

Every block lands in exactly one of three buckets, and they mean what they say:

| | |
|---|---|
| **NATIVE** | Niagara does this, the same way the preview does. |
| **APPROXIMATED** | something survived, but not exactly — the note says how it differs and what to do about it. |
| **DROPPED** | nothing survived, and the note says what to do instead. |

The same three buckets as the Unity importer, deliberately: an author exporting
to both engines is comparing two reports, and different wording would read as a
difference in the effect.

## What survives, and what does not

**The curve/spline emitter is the place Unreal beats Unity.** Shuriken has no
bending shape at all, so there the path degrades to the straight chord between
its end points. Niagara holds the whole thing:

- the path becomes a **Vector Curve** data interface — one key per authored
  point, on `Position`, with cubic auto tangents, which *are* Catmull-Rom
  tangents, so the imported curve bends the way the drawn one does;
- keys are timed by **cumulative distance along the path**, not by point index,
  so an even spread is evenly *spaced* rather than evenly *indexed*;
- **Tangent speed** becomes a second vector curve of unit tangents driving Add
  Velocity, so particles both sit on the path and travel along it;
- position and tangent are sampled at the *same* value per particle — the
  normalized execution index, or a hash of the particle id — so a particle never
  appears at one point on the curve and flies off along another;
- and the result is ordinary editable Niagara: open the system and drag the
  curve keys.

The gaps, all of them reported at import time rather than discovered later:

| Not carried | Why, and what to do |
|---|---|
| Textures and meshes | Not imported yet. Import them and assign them to the emitter's material and renderer. |
| Blend mode | In Unreal this is a property of the **material**, not of the renderer. Assign a material with the blend mode you want. |
| Mesh and ribbon renderers | The emitter keeps its sprite renderer. |
| Path thickness | Particles sit exactly on the curve; add a Jitter Position module to scatter them. |
| Fixed spacing along a path | Niagara has no walk-along-at-a-distance mode, so it becomes an even spread. |
| Multiple timeline clips on one track | Emitter State has a single loop delay, so only the first start time survives. Split the track into separate systems. |
| Per-particle exact randomness | Neither engine lets us inject our PCG32. Seeds travel and engine output is reproducible — it just is not the *same* stream. |

## Diagnosing it against a new engine version

The mapping is written against names that were **measured, not guessed** — module
paths, input names, and above all enum entry names. `plugins/unreal/Spikes/probe-niagara-schema-5.8.2.txt`
is that survey, and the `VfxProbe` commandlet is what produced it:

```bat
UnrealEditor-Cmd.exe "YourProject.uproject" -run=VfxProbe -unattended -nosplash -stdout
```

It also has a verify mode, which reads a built asset back off disk and prints
what it actually contains — including the curve keys:

```bat
UnrealEditor-Cmd.exe "YourProject.uproject" -run=VfxProbe ^
  -system=/Game/ImportedVfx/Magic_Bolt -unattended -nosplash -stdout
```

Two traps that survey found, both of which fail *silently* if you get them wrong:

1. **Enum entries are resolved by display name, at runtime.** Niagara's shape,
   lifetime and colour modes are user-defined enums whose internal entry names
   are `NewEnumerator0`, `NewEnumerator1`… **and the numbering does not follow
   the display order** — in `ENiagara_SizeScaleMode`, "Uniform" is
   `NewEnumerator3`. A hard-coded internal name picks the wrong mode quietly.
2. **A static switch does not reveal its inputs until the edit context is
   rebuilt.** Writing `Lifetime Mode = Random` succeeds and reads back correctly,
   and `Lifetime Min` stays hidden — so the next write is refused as "hidden by
   static-switch logic". Waiting for compilation changes nothing; a *new*
   `FNiagaraExternalEditContext` on the same system reveals it immediately. The
   builder rebuilds the context after every enum and every dynamic-input write.

## Distributing it without a compiler

A plugin can ship **precompiled**: build it once, then distribute the resulting
`Binaries/` and `Intermediate/Build/` alongside the source, and the consuming
project needs no C++ toolchain. That is how Marketplace plugins work, and it is
the closest Unreal equivalent to Unity's `.unitypackage`.

The catch is that precompiled binaries are locked to one **engine version** and
one **platform** — a 5.8 Win64 build is useless to someone on 5.7 or on Mac —
so it is a convenience to add per release, not a replacement for shipping the
source.

## Coordinate space

The IR is **right-handed, Y-up, metres**. Unreal is **left-handed, Z-up,
centimetres** — measured, not recalled: `default_gravity_z` reads `-980`.

So every position, velocity, direction and offset needs an **axis swap and a
×100 scale**: `(x, y, z)` becomes `(x, z, y) × 100`. Swapping two axes is what
flips the handedness, and it puts our up-axis onto Unreal's. This is a bigger
conversion than the Unity importer's, which only had to negate Z.
