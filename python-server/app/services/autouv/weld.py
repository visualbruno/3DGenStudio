"""Topological repair: proximity vertex welding.

The single biggest cause of "too many charts" is **not** the segmentation -- it
is the *input topology*. A chart grows along shared edges, so it can never span
two geometrically disconnected pieces. On clean meshes that is fine (a cave is
2-4 shells). But meshes from photogrammetry, sculpt-retopo and especially
AI generators (Tripo/Meshy/Rodin) are routinely shattered into hundreds of
shells whose seams are lined with vertices that are *coincident in space but
never welded* -- so the surface that should be one connected sheet is split
into 600-800 components, and the unwrapper is forced to emit one chart per
component no matter how good it is. (On the BabyRaptor sample: 810 components ->
810 charts; every component already collapses to exactly one chart.)

trimesh's default ``merge_vertices`` snaps coordinates to a grid, which misses
pairs straddling a grid boundary and leaves the shells split. This module welds
by *true distance* with a KD-tree + union-find, which reconnects the shells:
on BabyRaptor it takes 810 components -> 3 at a tolerance of one tenth of the
median edge length, while leaving genuinely-clean meshes untouched (Cave 4->4,
Church 2->2).

The tolerance is expressed as a fraction of the **median edge length** so it
scales with the model and is conservative: at 0.1x it only ever merges vertices
that are, for all practical purposes, the same point. Welding never deletes real
geometry -- only the degenerate faces whose corners collapse onto each other are
dropped (a handful, all zero-area).
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components


def median_edge_length(vertices: np.ndarray, faces: np.ndarray) -> float:
    v = vertices[faces]
    e = np.concatenate([
        np.linalg.norm(v[:, 1] - v[:, 0], axis=1),
        np.linalg.norm(v[:, 2] - v[:, 1], axis=1),
        np.linalg.norm(v[:, 0] - v[:, 2], axis=1),
    ])
    e = e[e > 0]
    return float(np.median(e)) if len(e) else 0.0


def proximity_weld(
    vertices: np.ndarray,
    faces: np.ndarray,
    tol_frac: float = 0.1,
    tol_abs: float | None = None,
):
    """Weld vertices closer than ``tol`` into one, by true distance.

    ``tol`` is ``tol_abs`` if given, else ``tol_frac * median_edge_length``.

    Returns ``(new_vertices, new_faces, info)`` where ``info`` carries the vertex
    and face counts before/after so the caller can report what was repaired.
    Degenerate faces (two welded corners coincide) are removed.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    n = len(vertices)
    info = {
        "verts_before": n,
        "faces_before": len(faces),
        "verts_after": n,
        "faces_after": len(faces),
        "tol": 0.0,
    }

    tol = tol_abs if tol_abs is not None else tol_frac * median_edge_length(vertices, faces)
    info["tol"] = float(tol)
    if tol <= 0.0:
        return vertices, faces, info

    tree = cKDTree(vertices)
    pairs = tree.query_pairs(tol, output_type="ndarray")
    if len(pairs) == 0:
        return vertices, faces, info

    # union-find via connected components of the "within tol" graph
    g = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    n_groups, label = connected_components(g + g.T, directed=False)

    # representative position = centroid of each welded group
    new_v = np.zeros((n_groups, 3))
    count = np.zeros(n_groups)
    np.add.at(new_v, label, vertices)
    np.add.at(count, label, 1)
    new_v /= count[:, None]

    new_f = label[faces]
    nondegen = (
        (new_f[:, 0] != new_f[:, 1])
        & (new_f[:, 1] != new_f[:, 2])
        & (new_f[:, 0] != new_f[:, 2])
    )
    new_f = new_f[nondegen]

    info["verts_after"] = int(n_groups)
    info["faces_after"] = int(len(new_f))
    return new_v, new_f, info
