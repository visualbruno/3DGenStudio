"""Split a piece into its connected shells.

AI-generated armour is very rarely one surface. A chest piece arrives as a
breastplate plus a dozen rivets, a strap and two pauldrons, all in one mesh with
no connectivity between them. Two stages care:

  * `rigid` can seat each shell on its own, which is the only way a multi-part
    plate set lands correctly when its parts are individually mis-placed;
  * the stats are worth reporting either way — "14 shells" explains a result
    that otherwise looks arbitrary.

Connectivity is computed over WELDED vertices. A glTF exporter splits a vertex
wherever the UV or normal seams, so a single continuous surface routinely
arrives as thousands of index-disjoint fragments; splitting on raw indices would
report a shell per triangle and make per-shell fitting nonsense.
"""
from __future__ import annotations

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def split_shells(vertices, faces, groups=None, min_faces=1):
    """Label every vertex with the connected shell it belongs to.

    `groups` is the welded-vertex map from conform.weld_map — passing the one
    already computed avoids welding twice, and guarantees both agree about what
    is connected.

    Returns (labels, shells) where `labels` is one shell index per VERTEX and
    `shells` lists each shell's vertex indices, largest first. Shells under
    `min_faces` faces are merged into the nearest larger one by centroid, so a
    stray rivet never becomes a fit target of its own.
    """
    n = len(vertices)
    if n == 0 or len(faces) == 0:
        return np.zeros(n, dtype=np.int64), []

    keys = np.arange(n) if groups is None else np.asarray(groups)

    # Edges in GROUP space: two vertices are connected when a triangle joins the
    # welded points they belong to.
    a = np.concatenate([keys[faces[:, 0]], keys[faces[:, 1]], keys[faces[:, 2]]])
    b = np.concatenate([keys[faces[:, 1]], keys[faces[:, 2]], keys[faces[:, 0]]])
    size = int(keys.max()) + 1 if n else 0
    graph = coo_matrix((np.ones(len(a), dtype=np.int8), (a, b)), shape=(size, size))

    count, group_labels = connected_components(graph, directed=False)
    labels = group_labels[keys]

    if count <= 1:
        return np.zeros(n, dtype=np.int64), [np.arange(n)]

    # Order by size so shell 0 is always the main body of the piece.
    members = [np.flatnonzero(labels == i) for i in range(count)]
    face_counts = np.zeros(count, dtype=np.int64)
    face_labels = labels[faces[:, 0]]
    for label in face_labels:
        face_counts[label] += 1

    order = np.argsort([-len(m) for m in members])
    remap = np.zeros(count, dtype=np.int64)
    for rank, original in enumerate(order):
        remap[original] = rank
    labels = remap[labels]
    members = [members[i] for i in order]
    face_counts = face_counts[order]

    if min_faces > 1 and len(members) > 1:
        labels, members = _absorb_small(vertices, labels, members, face_counts, min_faces)

    return labels, members


def _absorb_small(vertices, labels, members, face_counts, min_faces):
    """Fold shells below the face threshold into the nearest big one.

    Nearest by centroid, which is what a rivet's owner looks like in practice.
    Nothing is deleted — every vertex keeps a label, so the caller can still
    move all of them.
    """
    keep = [i for i in range(len(members)) if face_counts[i] >= min_faces]
    if not keep or len(keep) == len(members):
        return labels, members

    centroids = np.array([vertices[members[i]].mean(axis=0) for i in keep])
    for i in range(len(members)):
        if i in keep:
            continue
        centre = vertices[members[i]].mean(axis=0)
        nearest = keep[int(np.argmin(np.linalg.norm(centroids - centre, axis=1)))]
        labels[members[i]] = nearest

    # Re-index so the labels stay contiguous.
    remap = {original: rank for rank, original in enumerate(keep)}
    labels = np.array([remap[label] for label in labels], dtype=np.int64)
    return labels, [np.flatnonzero(labels == rank) for rank in range(len(keep))]
