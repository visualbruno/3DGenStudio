"""Stage 2 - clean topology via field-adaptive isotropic remeshing.

Isotropic explicit remeshing (split/collapse/flip/smooth + reproject) turns the
dense marching-cubes shell into evenly-spaced, near-equilateral triangles. With
`adaptive=True` the target edge length is modulated by local curvature, so spikes,
claws and the head get more resolution while flat areas (belly, flanks) stay light
- the hallmark of good low-poly topology.

Because adaptive density makes the final face count hard to predict from a single
edge-length, we run a short calibration loop: estimate L from the area budget, then
rescale L by sqrt(actual/target) and remesh again. Two passes land within a few
percent of the requested budget on typical meshes.

If a `quadriflow` binary is on PATH it can be used instead (field-aligned pure-quad
output); otherwise we optionally post-process tris into quad-dominant topology with
MeshLab's curvature-aware pairing.
"""
from __future__ import annotations
import shutil, subprocess, tempfile, os
import numpy as np
import trimesh
import pymeshlab as ml


def _edge_len_for_faces(V, F, target_faces):
    area = float(trimesh.Trimesh(V, F, process=False).area)
    return float(np.sqrt(4.0 * area / (max(1, target_faces) * np.sqrt(3.0))))


def isotropic_remesh(V, F, target_faces, adaptive=True, iters=10,
                     feature_deg=30.0, calibrate_passes=2, verbose=False):
    """Remesh to ~target_faces. Each calibration pass remeshes the *same source*
    with a corrected edge length (n ~ 1/L^2), and we keep the pass closest to the
    budget so adaptive density can't make us drift."""
    L = _edge_len_for_faces(V, F, target_faces)
    Vsrc, Fsrc = np.asarray(V, float), np.asarray(F, np.int64)
    best = None
    for p in range(1 + max(0, calibrate_passes)):
        ms = ml.MeshSet()
        ms.add_mesh(ml.Mesh(Vsrc, Fsrc))
        ms.meshing_isotropic_explicit_remeshing(
            iterations=int(iters), adaptive=bool(adaptive),
            targetlen=ml.PureValue(L), featuredeg=float(feature_deg),
            checksurfdist=False)
        mm = ms.current_mesh()
        Vc, Fc = np.asarray(mm.vertex_matrix()), np.asarray(mm.face_matrix())
        n = len(Fc)
        if verbose:
            print(f"    remesh pass {p}: L={L:.5f} -> {n} faces")
        if n == 0:
            break
        err = abs(n - target_faces) / float(target_faces)
        if best is None or err < best[0]:
            best = (err, Vc, Fc)
        if err < 0.05 or p == calibrate_passes:
            break
        L *= np.sqrt(n / float(target_faces))   # bigger edges -> fewer faces
    _, Vb, Fb = best
    return np.ascontiguousarray(Vb), np.ascontiguousarray(Fb.astype(np.int64))


def decimate_to_target(V, F, target_faces, preserve_boundary=True):
    """Quadric edge-collapse decimation to an exact face budget.

    Adaptive remeshing nails edge flow but lands a little above the budget (it keeps
    a curvature-driven density floor on features). A single quality-quadric pass
    brings the count down to the exact target while preserving the silhouette; the
    subsequent projection/relax stage re-regularises the triangles.
    """
    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(np.asarray(V, float), np.asarray(F, np.int64)))
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=int(target_faces),
        qualitythr=0.5, preserveboundary=bool(preserve_boundary),
        preservenormal=True, preservetopology=True, optimalplacement=True,
        planarquadric=True, autoclean=True)
    mm = ms.current_mesh()
    return np.ascontiguousarray(mm.vertex_matrix()), \
        np.ascontiguousarray(mm.face_matrix().astype(np.int64))


def finalize_watertight(V, F, close_holes=200):
    """Clean up after decimation + projection while preserving connectivity.

    Projection never changes topology, so the mesh arrives as one component. We only
    drop exactly-degenerate (zero-area) faces and weld, then - if a few boundary edges
    appeared - seal them by *adding* faces (close_holes). We deliberately do NOT run
    face-removing non-manifold repair: on multi-part figures (a warrior + weapon +
    shield) it cuts thin bridges and shatters the single shell into many pieces.
    """
    import trimesh as _tm
    m = _tm.Trimesh(np.asarray(V, float), np.asarray(F, np.int64), process=False)
    m.update_faces(m.nondegenerate_faces())
    m.merge_vertices()
    m.remove_unreferenced_vertices()
    if m.is_watertight:
        return np.ascontiguousarray(m.vertices), np.ascontiguousarray(m.faces.astype(np.int64))

    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(np.asarray(m.vertices, float), np.asarray(m.faces, np.int64)))
    try:
        ms.meshing_close_holes(maxholesize=int(close_holes), selfintersection=False)
    except Exception:
        pass
    mm = ms.current_mesh()
    return np.ascontiguousarray(mm.vertex_matrix()), \
        np.ascontiguousarray(mm.face_matrix().astype(np.int64))


def clean_slivers(V, F, min_quality=0.02):
    """Drop degenerate / extreme-sliver faces and unreferenced vertices."""
    import trimesh as _tm
    m = _tm.Trimesh(np.asarray(V, float), np.asarray(F, np.int64), process=False)
    tri = m.triangles
    e0 = np.linalg.norm(tri[:, 1] - tri[:, 0], axis=1)
    e1 = np.linalg.norm(tri[:, 2] - tri[:, 1], axis=1)
    e2 = np.linalg.norm(tri[:, 0] - tri[:, 2], axis=1)
    longest = np.maximum.reduce([e0, e1, e2]) + 1e-12
    quality = (2.0 * m.area_faces) / (longest * longest)   # ~ height/base, 0 == degenerate
    keep = quality > min_quality
    m.update_faces(keep)
    m.remove_unreferenced_vertices()
    return np.ascontiguousarray(m.vertices), np.ascontiguousarray(m.faces.astype(np.int64))


def to_quad_dominant(V, F):
    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(np.asarray(V, float), np.asarray(F, np.int64)))
    # align edges to curvature first, then pair triangles into quads
    try:
        ms.meshing_edge_flip_by_curvature_optimization(iterations=2)
    except Exception:
        pass
    ms.meshing_tri_to_quad_by_smart_triangle_pairing()
    mm = ms.current_mesh()
    # pymeshlab stores quads as two coplanar tris with a face-flag; expose polygonal
    # faces if available, else return the (quad-paired) triangle matrix.
    try:
        polys = mm.polygonal_face_list()
        return np.asarray(mm.vertex_matrix()), polys
    except Exception:
        return np.asarray(mm.vertex_matrix()), np.asarray(mm.face_matrix())


def quadriflow_available():
    return shutil.which("quadriflow") is not None


def quadriflow_remesh(V, F, target_faces):
    """Optional: use an external QuadriFlow binary for field-aligned pure quads."""
    if not quadriflow_available():
        raise RuntimeError("quadriflow binary not found on PATH")
    with tempfile.TemporaryDirectory() as d:
        inp, out = os.path.join(d, "in.obj"), os.path.join(d, "out.obj")
        trimesh.Trimesh(V, F, process=False).export(inp)
        subprocess.run(["quadriflow", "-i", inp, "-o", out,
                        "-f", str(int(target_faces))], check=True)
        m = trimesh.load(out, process=False)
    return np.asarray(m.vertices), np.asarray(m.faces)
