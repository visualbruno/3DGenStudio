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


UNDERSHOOT_TOLERANCE = 0.10   # accept a pass up to 10% UNDER the face budget


def isotropic_remesh(V, F, target_faces, adaptive=True, iters=5,
                     feature_deg=30.0, calibrate_passes=2, verbose=False,
                     smoothflag=True, reproject=True, checksurfdist=False,
                     maxsurfdist_pct=1.0, stop_on_overshoot=False,
                     undershoot_tolerance=UNDERSHOOT_TOLERANCE):
    """Remesh to ~target_faces. Each calibration pass remeshes the *same source*
    with a corrected edge length (n ~ 1/L^2), and we keep the pass closest to the
    budget so adaptive density can't make us drift. The edge length is internal:
    it is derived from target_faces and the surface area, and a calibration pass
    changes NOTHING else (same iterations, feature angle, smoothing, source).

    `undershoot_tolerance`: a pass landing at most this fraction UNDER the budget
    is accepted. Decimation cannot add faces, so an undershoot is the one case a
    calibration pass is still needed for - but a full re-remesh to close a small
    gap is expensive: a 1M-face target landed at 911k and the second pass (L
    0.00442 -> 0.00422, 1,009k faces) took 42 s of an 80 s stage, for identical
    fidelity (measured 2026-11-24; user-approved trade: "about 1M" over exact).

    For hard-surface models, set a low `feature_deg` (crease edges below this angle
    are kept sharp), `smoothflag=False` (don't round structural edges) and
    `reproject=True` with `checksurfdist=True` (stay glued to the original surface).

    `stop_on_overshoot`: stop calibrating as soon as a pass lands ABOVE the budget
    and let the caller's decimate_to_target take it the rest of the way. Measured
    2026-11-24 on the watertight shell (bush, tree, camp, warrior, houses; adaptive,
    feature_deg 30): the first pass always overshot (1.2x-10x), because crease edges
    above feature_deg are locked against collapse and set a density floor that
    ignores the target length - doubling L moved bush 102k -> 100k faces. So the
    recalibration pass re-ran the whole remesh on the dense shell (~half the stage)
    for nothing, AND made the result worse: its coarser output gave the decimator
    less detail to keep (warrior chamfer 0.98% -> 0.80%, tree 1.11 -> 0.98, every
    mesh equal or better, well-shaped triangles 72-87% -> 83-95%). Undershoot still
    recalibrates - decimation cannot add faces.
    """
    L = _edge_len_for_faces(V, F, target_faces)
    Vsrc, Fsrc = np.asarray(V, float), np.asarray(F, np.int64)
    best = None
    for p in range(1 + max(0, calibrate_passes)):
        ms = ml.MeshSet()
        ms.add_mesh(ml.Mesh(Vsrc, Fsrc))
        ms.meshing_isotropic_explicit_remeshing(
            iterations=int(iters), adaptive=bool(adaptive),
            targetlen=ml.PureValue(L), featuredeg=float(feature_deg),
            smoothflag=bool(smoothflag), reprojectflag=bool(reproject),
            checksurfdist=bool(checksurfdist),
            maxsurfdist=ml.PercentageValue(float(maxsurfdist_pct)))
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
        if n < target_faces and err <= undershoot_tolerance:
            if verbose:
                print(f"    remesh: {err:.1%} under budget, within tolerance (no recalibration)")
            break
        if stop_on_overshoot and n > target_faces:
            if verbose:
                print("    remesh: over budget, decimation finishes the job (no recalibration)")
            break
        L *= np.sqrt(n / float(target_faces))   # bigger edges -> fewer faces
    _, Vb, Fb = best
    return np.ascontiguousarray(Vb), np.ascontiguousarray(Fb.astype(np.int64))


def pre_decimate(V, F, target_faces, verbose=False):
    """Fast, robust coarse decimation to make a huge input tractable for remeshing.

    A cheap quadric pass (no quality weighting / planar quadric) collapses a
    multi-hundred-k mesh to a working resolution in seconds, without the spikes that
    aggressive options produce on non-manifold triangle soup. Used as a front-end for
    large meshes; the real feature-aware work happens afterwards on the smaller mesh.
    """
    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(np.asarray(V, float), np.asarray(F, np.int64)))
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=int(target_faces), qualitythr=0.3,
        preservenormal=True, optimalplacement=True, autoclean=True)
    mm = ms.current_mesh()
    if verbose:
        print(f"    pre-decimate -> {mm.face_number()} faces")
    return np.ascontiguousarray(mm.vertex_matrix()), \
        np.ascontiguousarray(mm.face_matrix().astype(np.int64))


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
    # Topology preservation can get stuck far above the budget on fragmented
    # multi-component meshes (no more legal collapses). Retry without it; the
    # finalize stage cleans up any local non-manifoldness this introduces.
    if ms.current_mesh().face_number() > target_faces * 1.2:
        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=int(target_faces),
            qualitythr=0.5, preserveboundary=bool(preserve_boundary),
            preservenormal=True, preservetopology=False, optimalplacement=True,
            planarquadric=True, autoclean=True)
    mm = ms.current_mesh()
    return np.ascontiguousarray(mm.vertex_matrix()), \
        np.ascontiguousarray(mm.face_matrix().astype(np.int64))


def finalize_watertight(V, F, close_holes=1000, verbose=False):
    """Clean up after decimation + projection while preserving connectivity.

    The marching-cubes shell is watertight by construction, but two later stages can
    poke small holes in it: decimate_to_target drops `preservetopology` on stubborn
    fragmented meshes (which can leave a non-manifold edge/vertex), and projection can
    fold a tight concave crease (between fingers, say) into a local self-intersection.
    We seal those without shredding the shell:

      1. drop zero-area faces, weld coincident verts, remove orphans;
      2. if already closed -> done;
      3. *split* (never delete) non-manifold edges/vertices so every hole boundary
         becomes a clean manifold loop close_holes can identify. Splitting duplicates
         a vertex but keeps all faces, so - unlike face-removing non-manifold repair -
         it never cuts the thin bridges that hold a multi-part figure (warrior + weapon
         + shield) together as one shell;
      4. close holes by *adding* faces, escalating from refusing self-intersections to
         tolerating them (the crease case above only closes on the tolerant pass);
      5. trimesh fill_holes as a final fallback for anything pymeshlab left open.
    """
    import trimesh as _tm

    def _wrap(v, f):
        m = _tm.Trimesh(np.asarray(v, float), np.asarray(f, np.int64), process=False)
        m.update_faces(m.nondegenerate_faces())
        m.merge_vertices()
        m.remove_unreferenced_vertices()
        return m

    def _boundary_edges(m):
        try:
            _, counts = np.unique(m.edges_sorted, axis=0, return_counts=True)
            return int((counts == 1).sum())
        except Exception:
            return -1

    def _out(m):
        return np.ascontiguousarray(m.vertices), np.ascontiguousarray(m.faces.astype(np.int64))

    m = _wrap(V, F)
    if m.is_watertight:
        return _out(m)
    if verbose:
        print(f"    [finalize] {_boundary_edges(m)} boundary edges before sealing")

    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(np.asarray(m.vertices, float), np.asarray(m.faces, np.int64)))

    # Split (do NOT remove) non-manifold elements so hole boundaries are clean loops.
    # Only the vertex-splitting variants are attempted; we never fall through to the
    # face-removing default.
    for fn, variants in (
        ("meshing_repair_non_manifold_edges", ({"method": "Split Vertices"}, {"method": 1})),
        ("meshing_repair_non_manifold_vertices", ({},)),
    ):
        filt = getattr(ms, fn, None)
        if filt is None:
            continue
        for kwargs in variants:
            try:
                filt(**kwargs)
                break
            except Exception:
                continue

    for selfintersection in (False, True):
        try:
            ms.meshing_close_holes(maxholesize=int(close_holes),
                                   selfintersection=selfintersection)
        except Exception:
            pass

    mm = ms.current_mesh()
    m = _wrap(mm.vertex_matrix(), mm.face_matrix())
    if not m.is_watertight:
        try:
            m.fill_holes()
            m.remove_unreferenced_vertices()
        except Exception:
            pass
    if verbose:
        remaining = _boundary_edges(m)
        print(f"    [finalize] watertight={m.is_watertight}"
              + ("" if m.is_watertight else f", {remaining} boundary edges remain"))
    return _out(m)


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
