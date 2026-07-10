# Desktop build resources

electron-builder looks in this directory (`buildResources`) for platform icons.

Currently:
- **Windows** uses `public/3dgenstudio.ico` (configured in `electron-builder.yml`).
- **macOS** and **Linux** fall back to the default Electron icon.

To brand the macOS and Linux builds, add:

- `build/icon.icns` — macOS icon (1024×1024 source recommended).
- `build/icon.png` — Linux icon, **512×512** (electron-builder requires ≥256×256).

Then set `mac.icon: build/icon.icns` and `linux.icon: build/icon.png` in
`electron-builder.yml`. You can generate both from a single PNG with tools like
`electron-icon-builder` or `png2icns`.
