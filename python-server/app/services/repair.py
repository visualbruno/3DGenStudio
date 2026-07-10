"""Topology repair — clean non-manifold edges without a full retopo.

Resolves the non-manifold edges the editor's watertight check reports, targeting
the surface directly instead of rebuilding it like Auto Retopo does:

  1. weld coincident vertices by position (so near-duplicate sheets share verts);
  2. drop duplicate + degenerate faces;
  3. resolve non-manifold edges — either *remove* the offending faces (then the
     small holes that opens can be closed) or *split* the sheets apart (keeps all
     faces, leaves clean boundary loops);
  4. optionally close the resulting small holes (pymeshlab + a trimesh fallback).

The before/after non-manifold and boundary-edge counts are reported so the UI can
show exactly what changed — some meshes (genuine multi-sheet "fins") cannot reach
a perfectly closed result and the honest numbers make that visible.
"""
from __future__ import annotations

from collections import Counter

import numpy as np
import trimesh

from ..schemas import RepairOptions

try:  # pymeshlab is a hard dependency of the service, but stay defensive.
    import pymeshlab as ml
except Exception:  # pragma: no cover
    ml = None


def _topology_counts(vertices, faces) -> dict:
    """Non-manifold + boundary edge counts under a position-weld at diag*1e-6,
    mirroring the editor's client-side getGeometryWatertight so the numbers agree.
    """
    V = np.asarray(vertices, dtype=float)
    F = np.asarray(faces, dtype=np.int64)
    if len(F) == 0:
        return {"non_manifold_edges": 0, "boundary_edges": 0, "faces": 0, "watertight": False}
    diag = float(np.linalg.norm(V.max(axis=0) - V.min(axis=0))) if len(V) else 1.0
    tol = max(diag * 1e-6, 1e-9)
    keys = np.round(V * (1.0 / tol)).astype(np.int64)
    _, canon = np.unique(keys, axis=0, return_inverse=True)
    canon = canon.reshape(-1)
    edge_counts: "Counter" = Counter()
    for f in F:
        a, b, c = int(canon[f[0]]), int(canon[f[1]]), int(canon[f[2]])
        for s, t in ((a, b), (b, c), (c, a)):
            if s == t:
                continue
            edge_counts[(s, t) if s < t else (t, s)] += 1
    non_manifold = sum(1 for n in edge_counts.values() if n > 2)
    boundary = sum(1 for n in edge_counts.values() if n == 1)
    return {
        "non_manifold_edges": int(non_manifold),
        "boundary_edges": int(boundary),
        "faces": int(len(F)),
        "watertight": bool(non_manifold == 0 and boundary == 0),
    }


def _weld(vertices, faces) -> trimesh.Trimesh:
    """Weld coincident vertices regardless of normal/UV splits, drop degenerates."""
    m = trimesh.Trimesh(np.asarray(vertices, float), np.asarray(faces, np.int64), process=False)
    m.merge_vertices(merge_tex=True, merge_norm=True)
    m.update_faces(m.nondegenerate_faces())
    m.remove_unreferenced_vertices()
    return m


def run_repair(mesh: trimesh.Trimesh, options: RepairOptions,
               progress=None) -> tuple[trimesh.Trimesh, dict, None]:
    def emit(stage, frac, msg=""):
        if progress:
            progress(stage, frac, msg)

    if ml is None:
        raise RuntimeError("pymeshlab is not available on the mesh-tools service.")

    emit("analyze", 0.05, "Analyzing topology…")
    before = _topology_counts(mesh.vertices, mesh.faces)

    # 1. Weld coincident vertices so near-duplicate sheets share geometry and
    #    their doubled faces become exact duplicates the next step can drop.
    if options.weld:
        emit("weld", 0.2, "Welding coincident vertices…")
        m = _weld(mesh.vertices, mesh.faces)
    else:
        m = trimesh.Trimesh(np.asarray(mesh.vertices, float),
                            np.asarray(mesh.faces, np.int64), process=False)

    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(np.asarray(m.vertices, float), np.asarray(m.faces, np.int64)))

    # 2. Duplicate / degenerate face + vertex cleanup.
    emit("dedup", 0.4, "Removing duplicate faces…")
    for fn in ("meshing_remove_duplicate_faces", "meshing_remove_duplicate_vertices",
               "meshing_remove_null_faces"):
        filt = getattr(ms, fn, None)
        if filt is not None:
            try:
                filt()
            except Exception:
                pass

    # 3. Resolve non-manifold edges. pymeshlab's method arg is a string in newer
    #    builds and an int in older ones, so try both spellings.
    emit("repair", 0.6, "Repairing non-manifold edges…")
    ml_variants = (({"method": "Remove Faces"}, {"method": 0}) if options.method == "remove"
                   else ({"method": "Split Vertices"}, {"method": 1}))
    edge_filt = getattr(ms, "meshing_repair_non_manifold_edges", None)
    if edge_filt is not None:
        for kwargs in ml_variants:
            try:
                edge_filt(**kwargs)
                break
            except Exception:
                continue
    vert_filt = getattr(ms, "meshing_repair_non_manifold_vertices", None)
    if vert_filt is not None:
        try:
            vert_filt()
        except Exception:
            pass

    # 4. Close the small holes that face removal opens.
    if options.close_holes and options.max_hole_size > 0:
        emit("close", 0.8, "Closing small holes…")
        for selfintersection in (False, True):
            try:
                ms.meshing_close_holes(maxholesize=int(options.max_hole_size),
                                       selfintersection=selfintersection)
            except Exception:
                pass

    try:
        ms.meshing_remove_unreferenced_vertices()
    except Exception:
        pass

    mm = ms.current_mesh()
    out = trimesh.Trimesh(np.asarray(mm.vertex_matrix()),
                          np.asarray(mm.face_matrix(), np.int64), process=False)

    # Final weld + optional trimesh fill to seal any pinholes pymeshlab left.
    out.merge_vertices(merge_tex=True, merge_norm=True)
    out.update_faces(out.nondegenerate_faces())
    if options.close_holes:
        try:
            out.fill_holes()
        except Exception:
            pass
    out.remove_unreferenced_vertices()

    emit("done", 1.0, "Repair complete.")
    after = _topology_counts(out.vertices, out.faces)

    stats = {
        "before": before,
        "after": after,
        "removed_faces": int(before["faces"] - after["faces"]),
        "method": options.method,
    }
    return out, stats, None
