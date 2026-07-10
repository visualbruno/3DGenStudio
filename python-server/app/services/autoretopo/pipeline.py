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
from . import ingest, shell, remesh, project, metrics, meshutil, gpu


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

    def run(self, path_or_mesh, progress=None) -> RetopoResult:
        cfg = self.cfg
        t = {}

        def report(stage, frac, message=""):
            if progress is not None:
                try:
                    progress(stage, float(frac), message)
                except Exception:
                    pass

        t0 = time.time()

        report("ingest", 0.02, "Loading mesh")
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
        backend = gpu.resolve_backend(cfg.device)   # cached probe; also used for the UI message
        report("shell",
               0.08,
               (f"Building watertight shell ({backend.name})" if cfg.watertight
                else "Preparing surface"))
        if cfg.watertight:
            self._log(f"[shell] backend={backend.name} (device={cfg.device})")
            res = cfg.shell_resolution
            fitted, peak_mb = shell.fit_resolution_to_budget(original, res, cfg.max_memory_gb)
            if fitted != res:
                self._log(f"[shell] resolution {res} -> {fitted} to fit "
                          f"{cfg.max_memory_gb:.1f} GB budget (est. peak {peak_mb:.0f} MB)")
            V, F = shell.voxel_shell(original, fitted, cfg.shell_close_iter,
                                     cfg.shell_smooth, cfg.shell_samples_per_pitch,
                                     taubin_steps=cfg.shell_taubin, device=cfg.device)
            V, F = shell.largest_component(V, F)
            self._log(f"[shell] {len(F)} faces (watertight base)")
        else:
            V, F = np.asarray(original.vertices), np.asarray(original.faces)
            self._log("[shell] skipped (surface mode)")
        t["shell"] = time.time() - t0

        # Stage 2: clean topology
        t0 = time.time()
        report("remesh", 0.38, "Building clean topology")
        # Pre-decimate very large inputs so remeshing stays fast and robust. Only in
        # feature mode (its purpose: huge hard-surface scans); on fragmented organic
        # meshes it chews component boundaries and the remesher then can't coarsen.
        if not cfg.watertight and cfg.preserve_features and len(F) > cfg.work_face_cap:
            V, F = remesh.pre_decimate(V, F, cfg.work_face_cap, verbose=cfg.verbose)
            self._log(f"[pre-decimate] {len(F)} faces")

        feat = cfg.preserve_features
        V, F = remesh.isotropic_remesh(
            V, F, cfg.target_faces, adaptive=cfg.adaptive, iters=cfg.remesh_iters,
            feature_deg=(cfg.feature_angle if feat else cfg.feature_deg),
            calibrate_passes=cfg.calibrate_passes, verbose=cfg.verbose,
            smoothflag=True, reproject=True, checksurfdist=feat, maxsurfdist_pct=1.0)
        # hit the budget exactly: decimate the (slightly over) adaptive result
        if len(F) > cfg.target_faces * 1.05:
            V, F = remesh.decimate_to_target(V, F, cfg.target_faces)
            self._log(f"[decimate] -> {len(F)} faces (budget {cfg.target_faces})")
        t["remesh"] = time.time() - t0
        self._log(f"[remesh] {len(F)} faces")

        # Stage 3: silhouette projection
        # Watertight mode MUST project: the remesher's reprojection targets the shell
        # (its own input), so only this stage pulls the mesh onto the true original
        # surface and removes residual voxel bias. The preserve_features skip applies
        # only in surface mode, where the remesher already reprojects onto the
        # original and a closest-point snap on noisy hard surfaces hurts.
        t0 = time.time()
        do_project = cfg.project and (cfg.watertight or not cfg.preserve_features)
        proj_backend = ("GPU (Warp)" if (do_project and cfg.device != "cpu"
                                         and gpu.warp_cuda_available()) else "CPU")
        report("project", 0.72,
               f"Projecting to surface ({proj_backend})" if do_project else "Projecting to surface")
        if do_project:
            self._log(f"[project] backend={proj_backend}")
            V = project.project_to_surface(
                V, F, original, iters=cfg.project_iters,
                clamp=cfg.project_clamp, relax_strength=cfg.relax_strength,
                device=cfg.device)
        V, F = remesh.finalize_watertight(V, F, verbose=cfg.verbose) if cfg.watertight else remesh.clean_slivers(V, F)
        t["project"] = time.time() - t0

        result_mesh = trimesh.Trimesh(V, F, process=False)
        result_mesh.fix_normals()

        # Stage 4 (optional): quad-dominant conversion
        quad_faces = None
        t0 = time.time()
        if cfg.quads:
            report("quad", 0.90, "Quad-dominant conversion")
            try:
                Vq, quad_faces = remesh.to_quad_dominant(V, F)
                self._log(f"[quad] quad-dominant conversion -> {len(quad_faces)} polys")
            except Exception as e:
                self._log(f"[quad] conversion failed ({e}); keeping triangles")
        t["quad"] = time.time() - t0

        # Stage 5: metrics
        t0 = time.time()
        report("metrics", 0.95, "Computing metrics")
        m = metrics.compute_all(original, result_mesh)
        t["metrics"] = time.time() - t0
        t["total"] = sum(t.values())
        self._log(f"[done] {t['total']:.1f}s | "
                  f"hausdorff={m['fidelity']['hausdorff_pct_diag']:.2f}% diag | "
                  f"well-shaped tris={m['triangle_quality']['pct_well_shaped']:.0f}%")

        return RetopoResult(original, result_mesh, m, t, cfg.to_dict(), quad_faces)
