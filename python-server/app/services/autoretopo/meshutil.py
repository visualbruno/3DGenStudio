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


def fix_winding_fast(mesh) -> int:
    """Vectorized drop-in for `trimesh.repair.fix_winding`. Returns faces flipped.

    trimesh walks a networkx BFS and does a few small numpy calls PER FACE PAIR:
    142 s of a 169 s Auto Retopo run on a 981k-face AI mesh (2026-11-24). Same
    algorithm here, done with whole-array ops:

      1. for every manifold edge (shared by exactly 2 faces, as trimesh's
         face_adjacency), `same[k]` = the two faces traverse it in the SAME
         direction, i.e. one of them must flip relative to the other;
      2. BFS spanning forest of the face-adjacency graph (scipy), rooted at the
         face trimesh would start from - the first face of each component in
         face_adjacency order - so the root keeps its winding, like trimesh;
      3. flip[f] = XOR of `same` along the tree path to the root, by pointer
         doubling (log2(depth) vector passes, no Python loop over faces).

    On orientable components the result is identical to trimesh's (the winding
    is unique once the root is fixed). On non-orientable soup the two may pick
    different tree edges, so they can disagree there - neither is "right".
    """
    from scipy.sparse.csgraph import breadth_first_order

    if mesh.is_winding_consistent:
        return 0
    faces = np.asarray(mesh.faces)
    adj = np.asarray(mesh.face_adjacency, np.int64)          # (m, 2)
    if len(adj) == 0:
        return 0
    shared = np.asarray(mesh.face_adjacency_edges, np.int64)  # (m, 2), sorted (u < v)
    nf = len(faces)

    def _dir(face_idx):
        # +1 if the face traverses shared edge u->v, -1 if v->u
        f = faces[face_idx]
        u, v = shared[:, 0:1], shared[:, 1:2]
        fwd = ((f == u) & (np.roll(f, -1, axis=1) == v)).any(axis=1)
        return fwd
    same = _dir(adj[:, 0]) == _dir(adj[:, 1])                 # needs a relative flip

    # trimesh's BFS root per component = first face of it in face_adjacency.ravel()
    g = coo_matrix((np.ones(len(adj), np.int8), (adj[:, 0], adj[:, 1])), shape=(nf, nf))
    _, comp = connected_components(g, directed=False)
    flat = adj.ravel()
    _, first = np.unique(comp[flat], return_index=True)
    roots = flat[np.sort(first)]

    # one BFS over every component: a virtual node nf links to every root
    rows = np.concatenate([adj[:, 0], np.full(len(roots), nf)])
    cols = np.concatenate([adj[:, 1], roots])
    G = coo_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(nf + 1, nf + 1)).tocsr()
    _, pred = breadth_first_order(G, nf, directed=False, return_predecessors=True)

    # relative flip of each tree edge (child, pred[child]), looked up by edge key
    key = np.minimum(adj[:, 0], adj[:, 1]) * (nf + 1) + np.maximum(adj[:, 0], adj[:, 1])
    order = np.argsort(key)
    key, same_sorted = key[order], same[order]
    child = np.where(pred[:nf] >= 0)[0]
    parent = pred[child]
    x = np.zeros(nf + 1, bool)
    nonroot = parent != nf
    c, p = child[nonroot], parent[nonroot]
    ck = np.minimum(c, p) * (nf + 1) + np.maximum(c, p)
    x[c] = same_sorted[np.searchsorted(key, ck)]

    # pointer doubling: accumulate XOR up to the virtual root
    P = np.full(nf + 1, nf, np.int64)
    P[child] = parent
    while True:
        done = P == nf
        if done.all():
            break
        x = x ^ np.where(done, False, x[P])
        P = np.where(done, P, P[P])
    flip = x[:nf]
    n = int(flip.sum())
    if n:
        f = faces.copy()
        f[flip] = f[flip][:, ::-1]
        mesh.faces = f
    return n


def fix_normals_fast(mesh):
    """`mesh.fix_normals()` with the vectorized winding pass (see fix_winding_fast);
    the per-body inversion check is trimesh's own."""
    from trimesh import repair
    fix_winding_fast(mesh)
    repair.fix_inversion(mesh, multibody=mesh.body_count > 1)
    return mesh


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
