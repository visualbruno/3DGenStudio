"""GLB -> FBX conversion — subprocess driver for app/tools/fbx_worker.py.

The worker owns the actual Blender (bpy) work; this module only provisions a
job directory, spawns the worker with the venv's own interpreter, relays its
sentinel-prefixed progress lines, and returns the FBX bytes + stats.

bpy stays OUT of this process on purpose: it is not thread-safe, keeps ~1GB RSS
once imported, and a Blender crash must not take the API down. Conversions are
serialized with a semaphore for the same reason (each subprocess peaks 1-2GB).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from uuid import uuid4

from ..config import CONVERT_TIMEOUT_S, WORK_DIR
from ..schemas import ConvertOptions

SENTINEL = "GENSTUDIO_EVT "  # keep in sync with app/tools/fbx_worker.py

_WORKER = Path(__file__).resolve().parents[1] / "tools" / "fbx_worker.py"

_convert_lock = threading.Semaphore(1)


def run_convert_fbx(glb_bytes: bytes, opts: ConvertOptions, progress) -> tuple[bytes, dict]:
    """Convert a GLB to FBX. Returns (fbx_bytes, worker_stats); raises on failure.

    `progress(stage, frac, message)` is called for each worker progress event.
    """
    job_dir = WORK_DIR / f"convert-{uuid4().hex}"
    job_dir.mkdir(parents=True)
    try:
        in_path = job_dir / "input.glb"
        in_path.write_bytes(glb_bytes)
        out_path = job_dir / "output.fbx"
        opt_path = job_dir / "options.json"
        opt_path.write_text(opts.model_dump_json(), encoding="utf-8")

        with _convert_lock:
            result = _run_worker(in_path, out_path, opt_path, progress)

        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "FBX conversion failed.")
        if not out_path.exists():
            raise RuntimeError("FBX worker reported success but produced no output file.")
        return out_path.read_bytes(), result.get("stats") or {}
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _run_worker(in_path: Path, out_path: Path, opt_path: Path, progress) -> dict:
    proc = subprocess.Popen(
        [
            sys.executable,
            str(_WORKER),
            "--input", str(in_path),
            "--output", str(out_path),
            "--options", str(opt_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"},
    )

    # Watchdog instead of a read timeout: the stdout iteration below ends when
    # the process dies, so killing it on expiry unblocks the loop too.
    timed_out = threading.Event()

    def _expire():
        timed_out.set()
        proc.kill()

    watchdog = threading.Timer(CONVERT_TIMEOUT_S, _expire)
    watchdog.daemon = True
    watchdog.start()

    result: dict | None = None
    tail: list[str] = []  # last non-protocol lines, for error context
    try:
        for line in proc.stdout:
            if not line.startswith(SENTINEL):
                stripped = line.strip()
                if stripped:
                    tail.append(stripped)
                    del tail[:-8]
                continue
            try:
                event = json.loads(line[len(SENTINEL):])
            except json.JSONDecodeError:
                continue
            if event.get("type") == "progress":
                progress(event.get("stage", "convert"), event.get("frac", 0.0), event.get("message", ""))
            elif event.get("type") == "result":
                result = event
        code = proc.wait()
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.kill()

    if timed_out.is_set():
        raise RuntimeError(f"FBX conversion timed out after {CONVERT_TIMEOUT_S}s.")
    if result is None:
        detail = f" Last output: {' | '.join(tail)}" if tail else ""
        raise RuntimeError(f"FBX worker exited (code {code}) without a result.{detail}")
    return result
