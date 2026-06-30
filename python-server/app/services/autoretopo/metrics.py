"""Stage 4 - quality metrics.

Quantifies (a) how faithfully the retopo follows the original silhouette and
(b) how clean the resulting topology is. Distances are reported both in world
units and as a percentage of the bounding-box diagonal so they are scale-free.
"""
from __future__ import annotations
import numpy as np
import trimesh
from scipy.spatial import cKDTree


def _sample(mesh, n):
    pts, fid = trimesh.sample.sample_surface(mesh, n)
    nrm = mesh.face_normals[fid]
    return np.asarray(pts), np.asarray(nrm)


def geometric_fidelity(original, result, n_samples=60000):
    diag = float(np.linalg.norm(original.extents))
    a_pts, a_nrm = _sample(original, n_samples)
    b_pts, b_nrm = _sample(result, n_samples)
    ta, tb = cKDTree(a_pts), cKDTree(b_pts)
    dab, ia = tb.query(a_pts)      # original -> result
    dba, ib = ta.query(b_pts)      # result -> original
    chamfer = float(dab.mean() + dba.mean())
    hausdorff = float(max(dab.max(), dba.max()))
    mean_dist = float(0.5 * (dab.mean() + dba.mean()))
    # normal agreement (result sample vs nearest original sample)
    dot = np.sum(b_nrm * a_nrm[ib], axis=1)
    normal_deg = float(np.degrees(np.arccos(np.clip(np.abs(dot), 0, 1))).mean())
    within = float((dba < 0.01 * diag).mean() * 100.0)   # % within 1% of diag
    return {
        "chamfer": chamfer,
        "chamfer_pct_diag": 100.0 * chamfer / diag,
        "hausdorff": hausdorff,
        "hausdorff_pct_diag": 100.0 * hausdorff / diag,
        "mean_surface_dist": mean_dist,
        "mean_dist_pct_diag": 100.0 * mean_dist / diag,
        "mean_normal_deviation_deg": normal_deg,
        "pct_within_1pct_diag": within,
    }


def triangle_quality(mesh):
    V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    a = V[F[:, 0]]; b = V[F[:, 1]]; c = V[F[:, 2]]
    def ang(p, q, r):
        u = q - p; w = r - p
        u /= (np.linalg.norm(u, axis=1, keepdims=True) + 1e-12)
        w /= (np.linalg.norm(w, axis=1, keepdims=True) + 1e-12)
        return np.degrees(np.arccos(np.clip(np.sum(u * w, axis=1), -1, 1)))
    angs = np.stack([ang(a, b, c), ang(b, c, a), ang(c, a, b)], axis=1)
    minang = angs.min(1)
    # radius-edge aspect ratio: 1.0 == equilateral
    e0 = np.linalg.norm(b - a, axis=1); e1 = np.linalg.norm(c - b, axis=1); e2 = np.linalg.norm(a - c, axis=1)
    s = (e0 + e1 + e2) / 2
    area = np.sqrt(np.maximum(s * (s - e0) * (s - e1) * (s - e2), 1e-20))
    longest = np.maximum.reduce([e0, e1, e2])
    inradius = area / np.maximum(s, 1e-12)
    aspect = longest / (2 * np.sqrt(3) * inradius + 1e-12)   # 1 == equilateral
    return {
        "min_angle_mean_deg": float(minang.mean()),
        "min_angle_p05_deg": float(np.percentile(minang, 5)),
        "pct_well_shaped": float((minang > 30).mean() * 100.0),   # min angle > 30 deg
        "aspect_ratio_median": float(np.median(aspect)),
        "aspect_ratio_mean": float(aspect.mean()),
        "aspect_ratio_p95": float(np.percentile(aspect, 95)),
    }


def topology(mesh):
    from .meshutil import num_components
    V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    val = np.bincount(F.reshape(-1), minlength=len(V)).astype(float)
    nz = val[val > 0]
    # For triangle meshes the ideal interior valence is 6; 5-7 is "regular-ish".
    regular = float(np.mean((nz >= 5) & (nz <= 7)) * 100.0)
    return {
        "vertices": int(len(V)),
        "faces": int(len(F)),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "components": int(num_components(V, F)),
        "euler_number": int(mesh.euler_number),
        "genus": int((2 - mesh.euler_number) // 2) if mesh.is_watertight else None,
        "mean_valence": float(nz.mean()),
        "valence_std": float(nz.std()),
        "pct_valence_5_to_7": regular,
    }


def compute_all(original, result, n_samples=60000):
    return {
        "fidelity": geometric_fidelity(original, result, n_samples),
        "triangle_quality": triangle_quality(result),
        "topology": topology(result),
    }
