"""End-to-end unwrap orchestrator."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from .mesh import Mesh
from . import segment as _seg
from . import param as _param
from . import postprocess as _post
from . import pack as _pack
from . import weld as _weld


@dataclass
class UnwrapResult:
    vertices: np.ndarray          # (Vn,3) output positions (seam-duplicated)
    faces: np.ndarray             # (F,3) indices into vertices
    uv: np.ndarray                # (Vn,2) in [0,1]
    face_chart: np.ndarray        # (F,) chart id per face
    stats: dict = field(default_factory=dict)


def unwrap(
    mesh: Mesh,
    max_cone_deg: float = 50.0,
    sharp_weight: float = 0.35,
    min_faces: int = 20,
    min_area_frac: float = 0.004,
    fold_cap_deg: float = 88.0,
    refine: bool = True,
    refine_target_faces: int = 80,
    refine_ad_thresh: float = 1.32,
    resolution: int = 1024,
    padding_texels: int = 4,
    method: str = "auto",
    arap_iters: int = 4,
    weld: bool = True,
    weld_tol_frac: float = 0.1,
    progress=None,
    verbose: bool = True,
) -> UnwrapResult:
    t0 = time.time()

    def report(stage, frac):
        if progress is not None:
            progress(stage, float(frac))

    # ---- topology repair: weld coincident-but-unshared vertices -------------
    # The hard floor on chart count is the number of connected components, so a
    # mesh shattered into hundreds of shells (AI/scan output) is forced to
    # hundreds of charts regardless of how good the parameterisation is. Welding
    # by true distance stitches those shells back into a few components; on
    # already-clean meshes it is a no-op. See autouv.weld.
    comps_before = int(len(np.unique(mesh.components)))
    weld_info = None
    report("weld", 0.0)
    if weld:
        nv, nf, weld_info = _weld.proximity_weld(
            mesh.vertices, mesh.faces, tol_frac=weld_tol_frac
        )
        if weld_info["verts_after"] != weld_info["verts_before"]:
            mesh = Mesh(nv, nf)
    comps_after = int(len(np.unique(mesh.components)))
    if verbose and weld:
        print(f"[weld] {comps_before} -> {comps_after} components "
              f"({weld_info['verts_before']}->{weld_info['verts_after']} verts, "
              f"tol={weld_info['tol']:.5f})")
    report("weld", 1.0)

    labels = _seg.segment(
        mesh,
        max_cone_deg=max_cone_deg,
        sharp_weight=sharp_weight,
        min_faces=min_faces,
        min_area_frac=min_area_frac,
        fold_cap_deg=fold_cap_deg,
    )
    if verbose:
        print(f"[segment] {int(labels.max()) + 1} charts in "
              f"{time.time() - t0:.2f}s")
    report("segment", 1.0)
    if refine:
        labels = _seg.refine_merge(
            mesh, labels,
            target_faces=refine_target_faces,
            ad_thresh=refine_ad_thresh,
            progress=lambda p: report("refine", p),
        )
    n_charts = int(labels.max()) + 1
    t_seg = time.time()
    if verbose and refine:
        print(f"[refine]  -> {n_charts} charts (total seg {t_seg - t0:.2f}s)")

    faces = mesh.faces
    verts = mesh.vertices

    islands = []          # per-chart uv (local)
    island_uniq = []      # per-chart global vertex ids
    island_faces = []     # per-chart local faces
    island_area3d = []    # per-chart surface area
    angle_ds, area_ds, flips, methods = [], [], [], []

    for c in range(n_charts):
        fids = np.nonzero(labels == c)[0]
        uv, uniq, lf, info = _param.parameterize_chart(
            verts, faces, fids, method=method, arap_iters=arap_iters
        )
        report("parameterize", (c + 1) / n_charts)
        uv = _post.align_island(uv)
        islands.append(uv)
        island_uniq.append(uniq)
        island_faces.append(lf)
        island_area3d.append(float(mesh.face_areas[fids].sum()))
        angle_ds.append(info["angle_d"])
        area_ds.append(info["area_d"])
        flips.append(info["flips"])
        methods.append(info["method"])

    t_param = time.time()
    if verbose:
        print(f"[param] {n_charts} charts in {t_param - t_seg:.2f}s")

    islands = _post.normalize_texel_density(islands, island_faces, island_area3d)
    packed, fill = _pack.pack(
        islands, resolution=resolution, padding_texels=padding_texels
    )
    t_pack = time.time()
    if verbose:
        print(f"[pack] fill={fill:.2%} in {t_pack - t_param:.2f}s")

    # ---- assemble output mesh (duplicate vertices per chart for seam UVs) ----
    out_v = []
    out_uv = []
    out_f = []
    out_fc = []
    voff = 0
    for c in range(n_charts):
        uniq = island_uniq[c]
        lf = island_faces[c]
        uv = packed[c]
        out_v.append(verts[uniq])
        out_uv.append(uv)
        out_f.append(lf + voff)
        out_fc.append(np.full(len(lf), c))
        voff += len(uniq)

    out_v = np.concatenate(out_v, axis=0)
    out_uv = np.concatenate(out_uv, axis=0)
    out_f = np.concatenate(out_f, axis=0)
    out_fc = np.concatenate(out_fc, axis=0)

    total_flips = int(np.sum(flips))
    stats = {
        "n_faces": int(mesh.n_faces),
        "n_charts": n_charts,
        "components_before_weld": comps_before,
        "components_after_weld": comps_after,
        "fill_ratio": float(fill),
        "flipped_triangles": total_flips,
        "mean_angle_distortion": float(np.average(
            angle_ds, weights=island_area3d)),
        "mean_area_distortion": float(np.average(
            area_ds, weights=island_area3d)),
        "method_counts": {m: int(methods.count(m)) for m in set(methods)},
        "time_seconds": round(time.time() - t0, 3),
        "time_breakdown": {
            "segment": round(t_seg - t0, 3),
            "parameterize": round(t_param - t_seg, 3),
            "pack": round(t_pack - t_param, 3),
        },
    }
    return UnwrapResult(out_v, out_f, out_uv, out_fc, stats)
