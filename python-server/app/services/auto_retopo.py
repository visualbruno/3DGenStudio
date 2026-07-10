"""Auto Retopology — bridges the FastAPI route to the bundled `autoretopo` package.

AutoRetopo.run() accepts a trimesh.Trimesh directly (it repairs it internally),
so we pass the uploaded mesh straight through and return the retopologized
trimesh.Trimesh plus the metrics/timings for the UI.
"""
from __future__ import annotations

import trimesh

from ..schemas import AutoRetopoOptions
from .autoretopo import AutoRetopo, RetopoConfig
from .autoretopo import gpu


def run_auto_retopo(mesh: trimesh.Trimesh, options: AutoRetopoOptions, progress=None) -> tuple[trimesh.Trimesh, dict, None]:
    cfg = RetopoConfig(
        target_faces=options.target_faces,
        quads=options.quads,
        watertight=options.watertight,
        shell_resolution=options.shell_resolution,
        shell_close_iter=options.shell_close_iter,
        shell_smooth=options.shell_smooth,
        shell_taubin=options.shell_taubin,
        shell_samples_per_pitch=options.shell_samples_per_pitch,
        max_memory_gb=options.max_memory_gb,
        adaptive=options.adaptive,
        remesh_iters=options.remesh_iters,
        feature_deg=options.feature_deg,
        calibrate_passes=options.calibrate_passes,
        preserve_features=options.preserve_features,
        feature_angle=options.feature_angle,
        project=options.project,
        project_iters=options.project_iters,
        project_clamp=options.project_clamp,
        relax_strength=options.relax_strength,
        device=options.device,
        seed=options.seed,
        verbose=False,
    )

    try:
        result = AutoRetopo(cfg).run(mesh, progress=progress)
    finally:
        # Long-running server: hand each run's GPU pool back to the driver so the
        # footprint doesn't accumulate across Auto Retopo requests. Also runs on
        # the error path (e.g. a shell-stage OOM) so a failed run cleans up too.
        gpu.free_gpu_memory()

    stats = {
        "metrics": result.metrics,
        "timings": result.timings,
        "quad_face_count": (len(result.quad_faces) if result.quad_faces is not None else None),
    }
    # result.mesh is a triangle trimesh.Trimesh (GLB is triangles-only; the
    # quad-dominant face list, when requested, is summarized in stats above).
    # No preview image for retopo (third tuple element kept for a uniform contract).
    return result.mesh, stats, None
