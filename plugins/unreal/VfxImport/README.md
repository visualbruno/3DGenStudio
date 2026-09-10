# 3D Gen Studio VFX Import (Unreal)

Imports a VFX bundle exported from 3D Gen Studio and builds a **Niagara system**
from it — real emitters and module stacks, not parameters bound onto a template.

Editor-only. Nothing ships in a packaged game.

> **Status: scaffold.** The plugin currently contains the module and a probe
> commandlet that proves the Niagara authoring API is reachable and works. The
> IR → Niagara mapping is not written yet, so installing it today gives you a
> `VfxImport` commandlet and no menu entry.

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
