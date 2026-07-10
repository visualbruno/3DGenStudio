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
> and installs `python-server/requirements.txt` (CPU-only). This first run takes
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
- macOS: `.dmg` + `.zip` (x64 + arm64)
- Linux: `.AppImage` + `.deb`

### Cross-platform note

Windows and Linux installers can be built from their respective OSes (or CI).
**macOS `.dmg` must be built on macOS** (local Mac or a macOS CI runner).

## Building all platforms in CI

`.github/workflows/desktop-build.yml` runs a matrix across
`windows-latest`, `macos-latest`, and `ubuntu-latest`. Trigger it by pushing a
`v*` tag or running it manually from the Actions tab; installers are uploaded as
build artifacts.

## Code signing (recommended for a clean install)

Unsigned builds work but show "unknown developer" warnings.

- **macOS**: enroll in the Apple Developer Program ($99/yr), then set
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID` (uncomment them in the workflow) to sign + notarize.
- **Windows**: an Authenticode certificate avoids SmartScreen warnings.

## Auto-update (optional, later)

electron-builder integrates with `electron-updater`. Uncomment the `publish:`
block in `electron-builder.yml` (GitHub provider) to publish releases and wire
in auto-updates — this pairs with the existing `version.json` flow.
