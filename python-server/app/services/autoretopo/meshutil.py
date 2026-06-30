"""Memory-bounded mesh utilities.

`trimesh.Trimesh.split(only_watertight=False)` builds a *separate submesh object for
every connected component*. On a fragmented AI mesh (the 200k-face warriors have
~2000 components) that allocates thousands of vertex/face copies and can blow past
17 GB. We only ever needed (a) the number of components and (b) the largest one, so
these helpers compute both from the edge graph with scipy - O(faces) memory, no
submesh copies.
"""
from __future__ import annotations
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def _labels(faces, n_verts):
    F = np.asarray(faces)
    e = np.sort(F[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    g = coo_matrix((np.ones(len(e), np.int8), (e[:, 0], e[:, 1])),
                   shape=(n_verts, n_verts))
    n, labels = connected_components(g, directed=False)
    return n, labels


def num_components(vertices, faces) -> int:
    """Connected-component count without materialising any submesh."""
    if len(faces) == 0:
        return 0
    n, _ = _labels(faces, len(vertices))
    return int(n)


def largest_component(vertices, faces):
    """Return (V, F) of the largest connected component, via a boolean face mask
    (no per-component Trimesh objects)."""
    V = np.asarray(vertices)
    F = np.asarray(faces)
    if len(F) == 0:
        return V, F
    n, labels = _labels(F, len(V))
    if n <= 1:
        return V, F
    face_label = labels[F[:, 0]]                      # face is connected -> one label
    keep_label = np.bincount(face_label).argmax()
    fmask = face_label == keep_label
    Fk = F[fmask]
    used = np.unique(Fk)
    remap = np.full(len(V), -1, np.int64)
    remap[used] = np.arange(len(used))
    return np.ascontiguousarray(V[used]), np.ascontiguousarray(remap[Fk])
