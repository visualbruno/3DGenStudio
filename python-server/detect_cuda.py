"""Detect an NVIDIA GPU + its CUDA version and print the matching CuPy wheel.

Used by run.bat during first-time setup to auto-install GPU acceleration. Prints
the pip package name (e.g. ``cupy-cuda13x``) to stdout when an NVIDIA GPU is
found, and nothing when there isn't — so the caller can branch on empty output.
Diagnostics go to stderr. Relies only on the standard library + ``nvidia-smi``.

Override the choice with the ``MESHTOOLS_CUPY_PACKAGE`` environment variable
(e.g. set it to ``cupy-cuda12x`` to force a specific wheel).
"""
from __future__ import annotations
import os
import re
import shutil
import subprocess
import sys

# CuPy publishes one wheel per CUDA major line. Its wheels bundle the CUDA
# runtime, so they only require a driver new enough for that major — a wheel for
# an older major still runs on a newer driver.
_WHEELS = {11: "cupy-cuda11x", 12: "cupy-cuda12x", 13: "cupy-cuda13x"}


def cuda_major() -> int | None:
    """Return the CUDA major version reported by nvidia-smi, or None."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return None
    # Matches both classic "CUDA Version: 12.4" and newer "CUDA UMD Version: 13.3".
    m = re.search(r"CUDA(?:\s+\w+)?\s+Version:\s*(\d+)\.(\d+)", out)
    return int(m.group(1)) if m else None


def wheel_for_major(major: int) -> str:
    pkg = _WHEELS.get(major)
    if pkg:
        return pkg
    known = sorted(_WHEELS)
    if major > known[-1]:
        # Newer driver than we know about: newest wheel is forward-compatible.
        print(f"[detect_cuda] CUDA {major}.x newer than known wheels; "
              f"using {_WHEELS[known[-1]]}.", file=sys.stderr)
        return _WHEELS[known[-1]]
    # Older than anything we ship a mapping for.
    print(f"[detect_cuda] CUDA {major}.x older than supported CuPy wheels; "
          f"trying {_WHEELS[known[0]]} (may not work).", file=sys.stderr)
    return _WHEELS[known[0]]


def main() -> None:
    override = os.environ.get("MESHTOOLS_CUPY_PACKAGE")
    if override:
        print(override.strip())
        return
    major = cuda_major()
    if major is None:
        # No NVIDIA GPU / driver -> print nothing; caller does a CPU-only install.
        print("[detect_cuda] No NVIDIA GPU detected (nvidia-smi absent or no CUDA "
              "version reported).", file=sys.stderr)
        return
    print(wheel_for_major(major))


if __name__ == "__main__":
    main()
