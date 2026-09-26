"""High-to-low poly texture bake — subprocess driver for app/tools/bake_worker.py.

The worker owns the actual Blender (bpy) work; this module only provisions a job
directory, spawns the worker with the venv's own interpreter, relays its
sentinel-prefixed progress lines, and returns the baked PNGs.

bpy stays OUT of this process on purpose: it is not thread-safe, keeps ~1GB RSS
once imported, and a Blender crash must not take the API down. Bakes are
serialized with a semaphore for the same reason (each subprocess peaks 1-2GB, and
a Cycles bake is CPU-saturating on its own).
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

from ..config import BAKE_TIMEOUT_S, WORK_DIR
from ..schemas import BakeOptions, FlattenOptions

SENTINEL = "GENSTUDIO_EVT "  # keep in sync with app/tools/bake_worker.py

_WORKER = Path(__file__).resolve().parents[1] / "tools" / "bake_worker.py"
_FLATTEN_WORKER = Path(__file__).resolve().parents[1] / "tools" / "flatten_worker.py"

_bake_lock = threading.Semaphore(1)


def run_bake(low_glb: bytes, high_glb: bytes, opts: BakeOptions,
             progress) -> tuple[dict[str, bytes], dict]:
    """Bake `high_glb`'s detail onto `low_glb`'s UVs.

    Returns ({map_name: png_bytes}, worker_stats); raises on failure.
    `progress(stage, frac, message)` is called for each worker progress event.
    """
    job_dir = WORK_DIR / f"bake-{uuid4().hex}"
    job_dir.mkdir(parents=True)
    try:
        low_path = job_dir / "low.glb"
        low_path.write_bytes(low_glb)
        high_path = job_dir / "high.glb"
        high_path.write_bytes(high_glb)
        out_dir = job_dir / "maps"
        opt_path = job_dir / "options.json"
        opt_path.write_text(opts.model_dump_json(), encoding="utf-8")

        with _bake_lock:
            result = _run_worker(_WORKER, [
                "--low", str(low_path),
                "--high", str(high_path),
                "--outdir", str(out_dir),
                "--options", str(opt_path),
            ], progress)

        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "Bake failed.")

        stats = result.get("stats") or {}
        images: dict[str, bytes] = {}
        for name, filename in (stats.get("maps") or {}).items():
            path = out_dir / filename
            if path.exists():
                images[name] = path.read_bytes()
        if not images:
            raise RuntimeError("The bake worker reported success but produced no images.")
        return images, stats
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def run_flatten(mesh_glb: bytes, opts: FlattenOptions,
                progress) -> tuple[dict[str, bytes], dict]:
    """Bake `mesh_glb`'s full PBR look, under studio light, into one albedo.

    The mesh must carry the packed atlas as a second UV set (see
    tools/flatten_worker.py). Returns ({"albedo": png_bytes}, worker_stats).
    Shares the bake semaphore: it is the same Cycles workload, and two of them at
    once would only make both slower.
    """
    job_dir = WORK_DIR / f"flatten-{uuid4().hex}"
    job_dir.mkdir(parents=True)
    try:
        mesh_path = job_dir / "mesh.glb"
        mesh_path.write_bytes(mesh_glb)
        out_dir = job_dir / "maps"
        opt_path = job_dir / "options.json"
        opt_path.write_text(opts.model_dump_json(), encoding="utf-8")

        with _bake_lock:
            result = _run_worker(_FLATTEN_WORKER, [
                "--mesh", str(mesh_path),
                "--outdir", str(out_dir),
                "--options", str(opt_path),
            ], progress)

        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "Flatten failed.")

        stats = result.get("stats") or {}
        images: dict[str, bytes] = {}
        for name, filename in (stats.get("maps") or {}).items():
            path = out_dir / filename
            if path.exists():
                images[name] = path.read_bytes()
        if "albedo" not in images:
            raise RuntimeError("The flatten worker reported success but produced no albedo.")
        return images, stats
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _run_worker(worker: Path, worker_args: list[str], progress) -> dict:
    proc = subprocess.Popen(
        [sys.executable, str(worker), *worker_args],
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

    watchdog = threading.Timer(BAKE_TIMEOUT_S, _expire)
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
                progress(event.get("stage", "bake"), event.get("frac", 0.0), event.get("message", ""))
            elif event.get("type") == "result":
                result = event
        proc.wait()
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.kill()

    if timed_out.is_set():
        raise RuntimeError(f"Bake timed out after {BAKE_TIMEOUT_S}s. Try a lower resolution or fewer samples.")
    if result is None:
        detail = f" Last output: {' | '.join(tail)}" if tail else ""
        raise RuntimeError(f"The bake worker exited without returning a result.{detail}")
    return result
