"""Auto-Retopo pipeline orchestrator.

    from autoretopo import AutoRetopo, RetopoConfig
    ar = AutoRetopo(RetopoConfig(target_faces=6000))
    result = ar.run("BabyRaptor.glb")
    result.export("baby_retopo.glb")
    print(result.metrics)

Pipeline: ingest -> watertight shell -> field-adaptive remesh -> silhouette
projection -> (optional quad) -> metrics.
"""
from __future__ import annotations
import time
import numpy as np
import trimesh

from .config import RetopoConfig
from . import ingest, shell, remesh, project, metrics, meshutil


class RetopoResult:
    def __init__(self, original, mesh, metrics_dict, timings, config, quad_faces=None):
        self.original = original
        self.mesh = mesh                  # trimesh.Trimesh (triangles)
        self.metrics = metrics_dict
        self.timings = timings
        self.config = config
        self.quad_faces = quad_faces      # list of polygonal faces if quads requested

    def export(self, path: str):
        self.mesh.export(path)
        return path

    @property
    def vertices(self):
        return np.asarray(self.mesh.vertices)

    @property
    def faces(self):
        return np.asarray(self.mesh.faces)


class AutoRetopo:
    def __init__(self, config: RetopoConfig | None = None):
        self.cfg = config or RetopoConfig()

    def _log(self, *a):
        if self.cfg.verbose:
            print(*a, flush=True)

    def run(self, path_or_mesh) -> RetopoResult:
        cfg = self.cfg
        t = {}
        t0 = time.time()

        if isinstance(path_or_mesh, str):
            original = ingest.load_mesh(path_or_mesh)
        else:
            original = ingest.repair(path_or_mesh)
        t["ingest"] = time.time() - t0
        self._log(f"[ingest] {len(original.faces)} faces, "
                  f"{meshutil.num_components(original.vertices, original.faces)} components, "
                  f"watertight={original.is_watertight}")

        # Stage 1: base layer
        t0 = time.time()
        if cfg.watertight:
            res = cfg.shell_resolution
            fitted, peak_mb = shell.fit_resolution_to_budget(original, res, cfg.max_memory_gb)
            if fitted != res:
                self._log(f"[shell] resolution {res} -> {fitted} to fit "
                          f"{cfg.max_memory_gb:.1f} GB budget (est. peak {peak_mb:.0f} MB)")
            V, F = shell.voxel_shell(original, fitted, cfg.shell_close_iter,
                                     cfg.shell_smooth, cfg.shell_samples_per_pitch)
            V, F = shell.largest_component(V, F)
            self._log(f"[shell] {len(F)} faces (watertight base)")
        else:
            V, F = np.asarray(original.vertices), np.asarray(original.faces)
            self._log("[shell] skipped (surface mode)")
        t["shell"] = time.time() - t0

        # Stage 2: clean topology
        t0 = time.time()
        V, F = remesh.isotropic_remesh(
            V, F, cfg.target_faces, adaptive=cfg.adaptive, iters=cfg.remesh_iters,
            feature_deg=cfg.feature_deg, calibrate_passes=cfg.calibrate_passes,
            verbose=cfg.verbose)
        # hit the budget exactly: decimate the (slightly over) adaptive result
        if len(F) > cfg.target_faces * 1.05:
            V, F = remesh.decimate_to_target(V, F, cfg.target_faces)
            self._log(f"[decimate] -> {len(F)} faces (budget {cfg.target_faces})")
        t["remesh"] = time.time() - t0
        self._log(f"[remesh] {len(F)} faces")

        # Stage 3: silhouette projection
        t0 = time.time()
        if cfg.project:
            V = project.project_to_surface(
                V, F, original, iters=cfg.project_iters,
                clamp=cfg.project_clamp, relax_strength=cfg.relax_strength)
        V, F = remesh.finalize_watertight(V, F) if cfg.watertight else remesh.clean_slivers(V, F)
        t["project"] = time.time() - t0

        result_mesh = trimesh.Trimesh(V, F, process=False)
        result_mesh.fix_normals()

        # Stage 4 (optional): quad-dominant conversion
        quad_faces = None
        t0 = time.time()
        if cfg.quads:
            try:
                Vq, quad_faces = remesh.to_quad_dominant(V, F)
                self._log(f"[quad] quad-dominant conversion -> {len(quad_faces)} polys")
            except Exception as e:
                self._log(f"[quad] conversion failed ({e}); keeping triangles")
        t["quad"] = time.time() - t0

        # Stage 5: metrics
        t0 = time.time()
        m = metrics.compute_all(original, result_mesh)
        t["metrics"] = time.time() - t0
        t["total"] = sum(t.values())
        self._log(f"[done] {t['total']:.1f}s | "
                  f"hausdorff={m['fidelity']['hausdorff_pct_diag']:.2f}% diag | "
                  f"well-shaped tris={m['triangle_quality']['pct_well_shaped']:.0f}%")

        return RetopoResult(original, result_mesh, m, t, cfg.to_dict(), quad_faces)
