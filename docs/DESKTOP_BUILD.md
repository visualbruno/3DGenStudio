# Desktop builds (Windows / macOS / Linux)

3D Gen Studio can be packaged as a downloadable desktop app using **Electron**
and **electron-builder**. The desktop app wraps the existing stack: the
Electron main process starts the Node/Express backend and the Python mesh-tools
service as child processes, then opens a window pointed at the local backend
(which serves the built UI + API on one port).

## What the app includes and what it does not

| Bundled in the installer | Provided by the user's machine |
| --- | --- |
| The UI (Vite build), Node/Express backend, and Electron's own Node runtime | **Python 3.10+** (used to create the mesh-tools venv on first launch) |
| The Python mesh-tools source + requirements | **ComfyUI** and its models (external, GPU-heavy — configured by URL) |
| Example ComfyUI workflows, wiki, tools | Cloud API keys (Tencent / Tripo / Hitem3D), entered in the app |

> The **Python service** uses the "require Python" model: on first launch the
> app finds a system Python, creates a virtualenv under the user's data folder,
> and installs `python-server/requirements.txt`, plus Auto Retopo's GPU
> acceleration when an NVIDIA GPU is present: CuPy for the shell stage
> (`cupy-cuda13x` on Windows, `cupy-cuda12x` on Linux, with NVRTC + cuBLAS as pip
> wheels) and `warp-lang` for the projection stage. This first run takes
> a few minutes; Auto UV / Auto Retopo are unavailable until it finishes. If no
> Python 3 is found, the rest of the app still works — only mesh-tools are off.
>
> **ComfyUI is not bundled** (models are many GB and GPU-specific). The desktop
> app points at the user's existing ComfyUI server, same as the web version.

## Data location

The backend keys its `data/` directory off the working directory. In the
desktop app that is set to the per-user data folder:

- Windows: `%APPDATA%\3DGenStudio`
- macOS: `~/Library/Application Support/3DGenStudio`
- Linux: `~/.config/3DGenStudio`

(Set by `app.setName('3DGenStudio')` in `electron/main.cjs`.)

Logs (`desktop.log`, `backend.log`, `python.log`) live in the `logs/`
subfolder there. Override the data root with `GENSTUDIO_DATA_ROOT`.

## Building locally

Prerequisites: Node 20+, and platform native-build tools for the `sqlite3`
rebuild (VS Build Tools on Windows, Xcode Command Line Tools on macOS,
`build-essential` + `python3` on Linux).

```bash
npm install
npm run dist        # build for the current OS → release/
# or target one platform explicitly:
npm run dist:win
npm run dist:mac    # must run on macOS
npm run dist:linux
npm run dist:dir    # unpacked build for quick testing (no installer)
```

`npm run electron:dev` builds the UI and launches the app without packaging —
useful for iterating on the shell.

Outputs land in `release/`:
- Windows: NSIS installer `.exe` + portable `.exe`
- macOS: `.dmg` + `.zip` (**arm64 / Apple Silicon only** — see below)
- Linux: `.AppImage` + `.deb`

### Cross-platform note

Windows and Linux installers can be built from their respective OSes (or CI).
**macOS `.dmg` must be built on macOS** (local Mac or a macOS CI runner).

### macOS is Apple Silicon only

The Intel (`x64`) macOS target was removed. The Mesh Tools service requires
`bpy>=5.0` (`python-server/requirements.txt`) for the GLB→FBX engine export, and
Blender 5.x dropped macOS Intel support — there is no `macosx … x86_64` wheel to
install. An Intel build therefore installs and launches correctly, then crashes
while provisioning its Python venv, which is a worse experience than not offering
the download at all.

Consequences to keep in mind:

- **Intel Macs are unsupported**, including macOS VMs on Intel/AMD PC hardware —
  an arm64 bundle cannot run there at all (Rosetta translates x86 → arm, not the
  reverse). Testing the packaged app needs real Apple Silicon, or an
  Apple-Silicon-hosted VM.
- The `release/mac/` output directory no longer appears; only `release/mac-arm64/`.
  The CI diagnose loop already globs both, so nothing there needs changing.

Restoring Intel builds means putting `x64` back in `mac.target[].arch` in
`electron-builder.yml` — worth doing only if `bpy` ships x86_64 wheels again.

## Building in CI

Four workflows, all sharing one build recipe:

| Workflow | Trigger | Builds |
| --- | --- | --- |
| `desktop-build.yml` — *Desktop build · all platforms* | `v*` tag push, or manual | all three |
| `desktop-build-windows.yml` — *· Windows* | manual only | NSIS + portable `.exe` |
| `desktop-build-macos.yml` — *· macOS* | manual only | `.dmg` + `.zip`, arm64 only |
| `desktop-build-linux.yml` — *· Linux* | manual only | `.AppImage` + `.deb` |

Run a single platform from the Actions tab → pick the workflow → **Run
workflow** → choose a branch. Installers are uploaded as build artifacts
(`3dgenstudio-windows` / `-macos` / `-linux`); nothing is published to Releases.

The build steps themselves live once, in `desktop-build-platform.yml` — a
reusable workflow (`workflow_call`) that the other four call with a runner label
and an npm script. **Edit the steps there**, not in the four callers.

> The **Run workflow** button only appears for workflows present on the
> **default branch** (`main`). New or renamed workflow files on `dev` stay
> invisible in the Actions tab until merged — a GitHub rule, not a setting.
> Once merged, the dispatch dialog can still target any branch.

## Code signing (recommended for a clean install)

Unsigned builds work but show "unknown developer" warnings.

- **macOS**: enroll in the Apple Developer Program ($99/yr), then set
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID` (uncomment them in the workflow) to sign + notarize.
  Hardened runtime is already configured with `build/entitlements.mac.plist`
  (JIT + library validation off — required, or the signed app cannot load
  sqlite3 or spawn the Python services).
- **Windows**: an Authenticode certificate avoids SmartScreen warnings.

Without a certificate, `build/adhoc-sign.cjs` (an `afterPack` hook) ad-hoc signs
the macOS bundle. See below for why that matters.

## macOS: «"3D Gen Studio" is damaged and can't be opened»

This is **Gatekeeper**, not a corrupt download. It appears when a downloaded
(= quarantined) app has a signature that is missing or does not match its
contents. Note that it is a *hard* refusal — unlike the "unidentified developer"
warning, it offers no way through.

Cause in this project: electron-builder edits `Info.plist` and renames the main
executable, which invalidates the ad-hoc signature the prebuilt Electron
binaries ship with. With no Developer ID present it then skips signing, so the
bundle goes out with a signature that no longer matches. The `afterPack` hook
re-signs ad-hoc to fix exactly that, downgrading the failure to the ordinary
bypassable warning. Notarization is still what removes the warning entirely.

### Telling a user how to get in right now

```sh
xattr -dr com.apple.quarantine "/Applications/3D Gen Studio.app"
open "/Applications/3D Gen Studio.app"
```

If it then crashes or reports "killed", the signature itself is broken and it
needs a local re-sign (requires Xcode Command Line Tools):

```sh
codesign --force --deep --sign - "/Applications/3D Gen Studio.app"
```

### Collecting logs from a Mac you don't have

`tools/mac-diagnose.sh` gathers the whole picture — quarantine attributes,
`codesign` verification, notarization state, the Gatekeeper verdict, arch
slices, syspolicy log and crash reports — into one file to send back:

```sh
bash mac-diagnose.sh --dmg ~/Downloads/3DGenStudio-2.2.0-mac-arm64.dmg
# writes ~/Desktop/3dgenstudio-mac-diagnostics.txt
```

### Reproducing it without any Mac

The `macos-latest` CI runner *is* an Apple Silicon Mac. Run the **Desktop build ·
macOS** workflow: its **Diagnose macOS bundle** step (in
`desktop-build-platform.yml`) runs the same script against the freshly packaged
bundle, including `--quarantine`, which stamps a copy with the
`com.apple.quarantine` attribute a browser download adds and re-runs the
assessment. That reproduces the user-visible verdict (a locally built app is
never quarantined, so it always passes without this). Results are uploaded as
the `mac-diagnostics` artifact.

A macOS VM is the weaker option: it cannot test Apple Silicon builds (the slice
most users need), and running macOS on non-Apple hardware is outside Apple's
licence terms.

### What the log tells you

The script ends with a **Verdict** section that reads the evidence back and
states which dialog a user will actually get. The raw signals behind it:

| Output | Meaning |
| --- | --- |
| `code object is not signed at all` | unsigned build → "damaged" on download |
| `Signature=adhoc` | ad-hoc signed → bypassable warning, no notarization |
| `Authority=Developer ID Application: …` | properly signed |
| `stapler validate` succeeds | notarized → installs with no warning |
| `codesign --verify` fails | bundle modified after signing |
| `lipo -archs` mismatch vs the Mac's chip | wrong download (x64 vs arm64) |
| dmg `shasum` differs from the release | genuinely truncated download |

Two outputs look alarming but are expected on an unnotarized build, and
**neither** causes the "damaged" dead end:

- `spctl --assess: rejected` — spctl rejects anything not notarized. It gives
  the same answer for a valid ad-hoc signature and a broken one, so it can't
  distinguish the two on its own; `codesign --verify` is what does.
- `syspolicy_check`'s *Notary Ticket Missing* (Fatal) and *Adhoc Signed App*
  (Warning) — the same statement in stronger words. Its *Internal Xprotect
  Error* is Apple's own scanner failing on a 21,000-file bundle and is not
  actionable.

The exec test (`--try-launch`) is the one that separates "the kernel refuses
this binary" from "Gatekeeper refuses this app": it runs the app's own Mach-O
via `ELECTRON_RUN_AS_NODE` with `process.exit(0)`, so it exercises the same
signature check and returns immediately. It never launches the GUI — doing that
wedged a CI job for 81 minutes. Every check is time-bounded and the CI step
carries `timeout-minutes: 15` on top.

## Auto-update (optional, later)

electron-builder integrates with `electron-updater`. Uncomment the `publish:`
block in `electron-builder.yml` (GitHub provider) to publish releases and wire
in auto-updates — this pairs with the existing `version.json` flow.
