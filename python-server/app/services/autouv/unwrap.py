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


def _corner_normals(mesh, pre_weld_faces, weld_info, source_normals,
                    preserve_normals, normal_smooth_deg):
    """Resolve one normal per face corner, plus a label saying where it came from.

    Returns ``(corner_group, group_normal, source)``: ``corner_group`` is (F, 3)
    group ids per face corner and ``group_normal`` is (G, 3) unit normals, so a
    corner's normal is ``group_normal[corner_group[f, k]]``. Corners sharing a
    group id are interchangeable, which is what the assembly step keys on.

    **Preferring the input's own normals is the whole point.** Auto UV changes the
    UV layout, not the shape, so it must not change shading either -- and no angle
    heuristic can reconstruct what an artist (or a decimator) authored. Decimated
    organic meshes are the case that proves it: a simplified head measures a
    90th-percentile dihedral around 55 degrees over a surface that is genuinely
    smooth, so any fixed smoothing angle in the usual range shatters it into
    facets while the untouched original renders smooth.

    Carrying them through is exact rather than approximate: the weld maps say
    which input vertex sits behind each welded face corner, so a corner keeps its
    input normal unchanged. Corners are then grouped by normal *value*, which is a
    property of the input geometry alone -- charts never enter into it, so the
    result is automatically continuous across a UV seam, while an authored hard
    edge stays hard because its two sides carry different values.

    Falls back to `Mesh.corner_groups` (dihedral-angle smoothing groups) when the
    input carried no normals, or when the caller asks for a recompute.
    """
    if preserve_normals and source_normals is not None:
        cn = _input_corner_normals(mesh, pre_weld_faces, weld_info, source_normals)
        if cn is not None:
            # Group by normal value. Quantising to a fine grid folds together
            # copies that are equal bar float noise; a pair that straddles a
            # bucket edge merely costs one extra output vertex carrying its own
            # near-identical normal, so the failure mode is harmless.
            flat = cn.reshape(-1, 3)
            q = np.round(flat * 10000.0).astype(np.int64)
            _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
            inv = np.asarray(inv).ravel()
            return inv.reshape(-1, 3), flat[first], "input"

    return (*mesh.corner_groups(normal_smooth_deg), "recomputed")


def _input_corner_normals(mesh, pre_weld_faces, weld_info, source_normals):
    """(F, 3, 3) unit normals per welded face corner, taken from the input mesh.

    None only when the array cannot be lined up with the geometry at all (wrong
    shape, or an index past the end), or when so much of it is degenerate that it
    is not worth trusting -- the caller then falls back to recomputing.

    A handful of zero-length input normals is normal and NOT a reason to discard
    the rest: any vertex whose incident face normals happen to cancel comes out
    zero, and real meshes have a few. Those corners alone fall back to their own
    face normal. (Bailing globally on the first bad corner is a trap worth
    naming: on the reported head mesh exactly 4 corners out of 16836 were
    degenerate, which was enough to throw away every good normal in the file.)
    """
    src = np.asarray(source_normals, dtype=np.float64)
    faces = np.asarray(pre_weld_faces)
    if src.ndim != 2 or src.shape[1] != 3:
        return None

    # Which input vertex is behind each welded face corner. Welding relabels and
    # drops faces but never reorders their corners, so face_index is enough.
    corner_vert = faces[weld_info["face_index"]] if weld_info is not None else faces
    if corner_vert.shape != mesh.faces.shape:
        return None
    if corner_vert.size == 0 or int(corner_vert.max()) >= len(src):
        return None

    cn = src[corner_vert]
    ln = np.linalg.norm(cn, axis=2, keepdims=True)
    bad = ln[..., 0] <= 1e-12
    if bad.mean() > 0.5:  # the channel is junk, not merely imperfect
        return None
    if bad.any():
        # Substitute the corner's own face normal, the best local estimate.
        fn = mesh.face_normals[np.nonzero(bad)[0]]
        cn = cn.copy()
        cn[bad] = fn
        ln = np.linalg.norm(cn, axis=2, keepdims=True)
        ln[ln <= 1e-12] = 1.0
    return cn / ln


@dataclass
class UnwrapResult:
    vertices: np.ndarray          # (Vn,3) output positions (seam-duplicated)
    faces: np.ndarray             # (F,3) indices into vertices
    uv: np.ndarray                # (Vn,2) in [0,1]
    face_chart: np.ndarray        # (F,) chart id per face
    normals: np.ndarray = None    # (Vn,3) normals sampled before the seam split
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
    normal_smooth_deg: float = 180.0,
    source_normals=None,
    preserve_normals: bool = True,
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
    pre_weld_faces = mesh.faces          # needed to trace corners back to input verts
    welded = False
    report("weld", 0.0)
    if weld:
        nv, nf, weld_info = _weld.proximity_weld(
            mesh.vertices, mesh.faces, tol_frac=weld_tol_frac
        )
        if weld_info["verts_after"] != weld_info["verts_before"]:
            mesh = Mesh(nv, nf)
            welded = True
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
    # Per-face-corner normals, resolved on the welded topology -- i.e. *before* the
    # seam split below -- so both copies of a seam vertex get the same value and
    # the two sides of every chart boundary shade identically.
    corner_group, group_normal, normal_source = _corner_normals(
        mesh, pre_weld_faces, weld_info if welded else None,
        source_normals, preserve_normals, normal_smooth_deg,
    )

    islands = []          # per-chart uv (local)
    island_uniq = []      # per-chart global vertex ids
    island_faces = []     # per-chart local faces
    island_fids = []      # per-chart global face ids (row-aligned to island_faces)
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
        island_fids.append(fids)
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
    out_n = []
    out_uv = []
    out_f = []
    out_fc = []
    voff = 0
    for c in range(n_charts):
        uniq = island_uniq[c]
        lf = island_faces[c]
        uv = packed[c]

        # An output vertex is one (chart vertex, smoothing group) pair, not just
        # one chart vertex. Splitting only per chart would be enough for a smooth
        # mesh, but a sharp edge running *inside* a chart puts corners from
        # several smoothing groups on the same chart vertex, and collapsing those
        # to one normal re-rounds the edge (a 2-chart cube comes out as a blob).
        # The extra copies are co-located and share the chart vertex's UV, so the
        # UV layout, the face count and the packing are all untouched -- only the
        # vertex count grows, and only where the mesh really is creased.
        #
        # _chart_local builds lf row-aligned to fids, so lf[i, k] and
        # corner_group[fids[i], k] describe the same corner.
        cg = corner_group[island_fids[c]]                      # (Fc, 3) group ids
        corner_key = np.stack([lf.reshape(-1), cg.reshape(-1)], axis=1)
        key_uniq, key_inv = np.unique(corner_key, axis=0, return_inverse=True)
        # numpy >= 2.0 shapes return_inverse after the input when axis is given;
        # flatten so the reshape below is version-independent.
        key_inv = np.asarray(key_inv).ravel()
        local_of_key = key_uniq[:, 0]                           # -> chart vertex
        group_of_key = key_uniq[:, 1]                           # -> smoothing group

        out_v.append(verts[uniq[local_of_key]])
        out_n.append(group_normal[group_of_key])
        out_uv.append(uv[local_of_key])
        out_f.append(key_inv.reshape(-1, 3) + voff)
        out_fc.append(np.full(len(lf), c))
        voff += len(key_uniq)

    out_v = np.concatenate(out_v, axis=0)
    out_n = np.concatenate(out_n, axis=0)
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
        "normal_source": normal_source,
        "time_seconds": round(time.time() - t0, 3),
        "time_breakdown": {
            "segment": round(t_seg - t0, 3),
            "parameterize": round(t_param - t_seg, 3),
            "pack": round(t_pack - t_param, 3),
        },
    }
    return UnwrapResult(out_v, out_f, out_uv, out_fc, out_n, stats)
