"""Runtime configuration for the mesh-processing service.

All values can be overridden with environment variables so the service can run
on a different machine/port than the Node backend — mirroring how ComfyUI is
configured in the main app.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw is not None and raw != "" else default
    except ValueError:
        return default


# Network — uvicorn binds here. 0.0.0.0 makes the service reachable from the
# machine running Node when they are different hosts.
HOST: str = os.environ.get("MESHTOOLS_HOST", "0.0.0.0")
PORT: int = _env_int("MESHTOOLS_PORT", 8200)

# CORS — the Node backend calls this service server-to-server, so the browser
# origin is not strictly required. We still allow the dev origins for the rare
# case of calling the service directly during debugging.
ALLOWED_ORIGINS: list[str] = [
    o.strip()
    for o in os.environ.get(
        "MESHTOOLS_ALLOWED_ORIGINS",
        "http://localhost:5173,http://localhost:3001",
    ).split(",")
    if o.strip()
]

# Upload guard rails.
MAX_UPLOAD_BYTES: int = _env_int("MESHTOOLS_MAX_UPLOAD_BYTES", 512 * 1024 * 1024)

# GLB -> FBX conversion (headless Blender subprocess). Generous default: bpy
# import alone takes seconds and heavy scenes bake many animation takes.
CONVERT_TIMEOUT_S: int = _env_int("MESHTOOLS_CONVERT_TIMEOUT", 600)

# Scratch space for temp files when a tool needs real paths on disk
# (many mesh CLIs/libraries only accept file paths, not in-memory buffers).
WORK_DIR: Path = Path(
    os.environ.get("MESHTOOLS_WORK_DIR", str(Path(tempfile.gettempdir()) / "3dgenstudio-meshtools"))
)
WORK_DIR.mkdir(parents=True, exist_ok=True)
