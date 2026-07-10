"""Optional CUDA acceleration for the grid-based shell stage.

The watertight-shell stage (surface voxelization, morphological closing, the
Euclidean distance-transform signed-distance field and its Gaussian blur) is
embarrassingly-parallel dense-array work that maps 1:1 onto CuPy and
`cupyx.scipy.ndimage`. This module resolves a *backend* — an array module (`xp`)
plus an ndimage module (`ndi`) — from a device request, falling back to
NumPy/SciPy whenever CuPy is missing or no NVIDIA GPU is present.

Everything else in the pipeline (marching cubes, and all the pymeshlab
remesh/decimate/quad work) stays on the CPU: those algorithms have no CUDA
drop-in, so the shell stage is the only place a GPU helps here.

Nothing imports CuPy at module load: the import is attempted lazily and cached,
so the service runs unchanged on machines without a CUDA toolkit and never pays
the import cost when running on CPU.
"""
from __future__ import annotations
import numpy as np
from scipy import ndimage as _cpu_ndi

# Cache: (cupy_module, cupyx_ndimage_module) once a GPU is confirmed usable,
# False once we've probed and found none. None means "not probed yet".
_gpu = None

# Cache for the (separate, optional) NVIDIA Warp runtime used by the projection
# stage's GPU closest-point queries. Same tri-state convention as `_gpu`.
_warp = None


def _probe_gpu():
    global _gpu
    if _gpu is not None:
        return _gpu
    try:
        import cupy as cp
        from cupyx.scipy import ndimage as cndi
        if cp.cuda.runtime.getDeviceCount() < 1:
            _gpu = False
            return _gpu
        # Touch the device so a driver/toolkit mismatch surfaces here (at probe
        # time) rather than deep inside a run.
        cp.zeros(1, dtype=cp.float32).sum()
        _gpu = (cp, cndi)
    except Exception:
        _gpu = False
    return _gpu


def cuda_available() -> bool:
    """True when CuPy is importable and at least one NVIDIA CUDA device works."""
    return bool(_probe_gpu())


def gpu_name() -> str | None:
    g = _probe_gpu()
    if not g:
        return None
    cp = g[0]
    try:
        name = cp.cuda.runtime.getDeviceProperties(0)["name"]
        return name.decode() if isinstance(name, (bytes, bytearray)) else str(name)
    except Exception:
        return "CUDA device"


def _probe_warp():
    """Lazily import NVIDIA Warp and confirm a usable CUDA device.

    Warp is a distinct optional dependency from CuPy (it powers the projection
    stage's GPU closest-point queries, not the shell grid ops), so it gets its
    own probe. Never imported at module load.
    """
    global _warp
    if _warp is not None:
        return _warp
    try:
        import warp as wp
        # Suppress the init banner. Warp >= 1.x renamed `config.quiet` to a log
        # level; set whichever the installed version exposes.
        try:
            wp.config.log_level = wp.LOG_WARNING
        except Exception:
            try:
                wp.config.quiet = True
            except Exception:
                pass
        wp.init()
        if wp.get_cuda_device_count() < 1:
            _warp = False
            return _warp
        _warp = wp
    except Exception:
        _warp = False
    return _warp


def warp_cuda_available() -> bool:
    """True when NVIDIA Warp is importable and a CUDA device is present."""
    return bool(_probe_warp())


def free_gpu_memory():
    """Release cached device memory held by the GPU backends back to the driver.

    Both CuPy and Warp keep freed device blocks in an internal pool for reuse, so
    in a long-running server the GPU footprint of each Auto Retopo run stays
    resident (and ratchets up to the largest run's peak) — visible in nvidia-smi
    as memory that "never clears". Call this once per run, after the result is
    back on the host.

    Uses the cached probe results only (never triggers a probe), so it is a cheap
    no-op on CPU-only installs or runs that never touched the GPU.
    """
    g, w = _gpu, _warp
    if not g and not w:
        return
    import gc
    # Drop any now-unreferenced Warp meshes/arrays (their finalizers free the
    # device buffers) before asking the pools to release blocks.
    gc.collect()
    if g:
        try:
            cp = g[0]
            cp.get_default_memory_pool().free_all_blocks()
            cp.get_default_pinned_memory_pool().free_all_blocks()
        except Exception:
            pass
    if w:
        try:
            w.synchronize()
        except Exception:
            pass


class Backend:
    """A resolved compute backend: `.xp` (array module) + `.ndi` (ndimage)."""

    def __init__(self, xp, ndi, on_gpu: bool, name: str):
        self.xp = xp
        self.ndi = ndi
        self.on_gpu = on_gpu
        self.name = name

    def asarray(self, a):
        return self.xp.asarray(a)

    def tonumpy(self, a):
        """Bring an array back to host memory regardless of backend."""
        if self.on_gpu:
            return self.xp.asnumpy(a)
        return np.asarray(a)


def resolve_backend(device: str = "auto") -> Backend:
    """Pick a compute backend from a device request.

    device:
      "auto" — GPU when an NVIDIA CUDA device and CuPy are both available,
               otherwise CPU (the default; never raises).
      "cuda" — GPU; raises RuntimeError if unavailable (explicit user choice).
      "cpu"  — always NumPy/SciPy.
    """
    device = (device or "auto").lower()
    if device == "cpu":
        return Backend(np, _cpu_ndi, False, "CPU")

    g = _probe_gpu()
    if g:
        cp, cndi = g
        return Backend(cp, cndi, True, gpu_name() or "CUDA")

    if device == "cuda":
        raise RuntimeError(
            "CUDA device requested but unavailable. Install the optional CuPy "
            "wheel matching your CUDA toolkit (e.g. `pip install cupy-cuda12x`) "
            "and ensure an NVIDIA GPU is present.")
    return Backend(np, _cpu_ndi, False, "CPU")
