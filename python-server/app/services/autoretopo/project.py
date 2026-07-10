"""Stage 3 - silhouette projection via a smoothed displacement field.

The shell+remesh result has clean topology but rides slightly off the true surface.
We pull it onto the *original* surface while keeping topology and watertightness
intact (connectivity never changes).

Why not plain closest-point snapping: in concave creases (cloth folds, around a
belt) the nearest-point direction is discontinuous - adjacent vertices snap to
opposite walls of the crease, imprinting zigzag noise; and on thin double-sided
geometry (a robe, a cape) the nearest point can lie on the far side, punching
dents. Both artifacts scale with the face budget, which is why high-poly retopo
looked "weird" while low-poly hid it.

Method, per iteration:
  1. closest-point query against the original;
  2. normal-consistency guard: drop moves whose target surface faces away from the
     vertex (fixes thin-geometry punch-through);
  3. Laplacian-smooth the *displacement field* over the mesh graph (a few rounds)
     and apply it. Smoothing the field kills the zigzag while low-frequency
     conformance accumulates over iterations, so the mesh settles into fold
     valleys without imprinting crease-wall flip-flop.
Finally one normal-direction micro-snap (tightly clamped, lightly smoothed)
firms up creases without reintroducing noise.

All graph ops are vectorized with reduceat over a CSR-style adjacency.
"""
from __future__ import annotations
import numpy as np
import trimesh

from . import gpu


class _TrimeshSurfaceQuery:
    """CPU closest-point query wrapper matching WarpSurfaceQuery's 2-tuple return
    (drops trimesh's distance term, which this stage does not use)."""

    def __init__(self, target_mesh):
        self._pq = trimesh.proximity.ProximityQuery(target_mesh)

    def on_surface(self, pts):
        closest, _dist, tid = self._pq.on_surface(pts)
        return np.asarray(closest), np.asarray(tid)


def _make_surface_query(target_mesh, device):
    """Build a closest-point query, GPU-accelerated (NVIDIA Warp) when the device
    request allows and a Warp+CUDA runtime is present; CPU (trimesh) otherwise.

    Both backends expose `.on_surface(pts) -> (closest_points, face_ids)`.
    """
    if device != "cpu" and gpu.warp_cuda_available():
        try:
            from .warp_proximity import WarpSurfaceQuery
            return WarpSurfaceQuery(target_mesh)
        except Exception:
            pass   # fall back to CPU if Warp construction/compile fails
    return _TrimeshSurfaceQuery(target_mesh)


def _vertex_adjacency(n_verts, F):
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e = np.vstack([e, e[:, ::-1]])
    nbr = [[] for _ in range(n_verts)]
    for a, b in e:
        nbr[a].append(b)
    return [np.unique(np.asarray(n, int)) for n in nbr]


def _csr(adjacency):
    idx = np.concatenate(adjacency) if adjacency else np.zeros(0, int)
    ptr = np.cumsum([0] + [len(a) for a in adjacency])
    deg = np.diff(ptr).astype(float)
    return idx, ptr, np.maximum(deg, 1.0)


def _vertex_edge_length(V, F):
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    d = np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1)
    s = np.zeros(len(V)); c = np.zeros(len(V))
    np.add.at(s, e[:, 0], d); np.add.at(s, e[:, 1], d)
    np.add.at(c, e[:, 0], 1.0); np.add.at(c, e[:, 1], 1.0)
    return s / np.maximum(c, 1.0)


def _lap_smooth(D, idx, ptr, deg, rounds, alpha=0.7):
    for _ in range(int(rounds)):
        S = np.add.reduceat(D[idx], ptr[:-1], axis=0)
        D = (1.0 - alpha) * D + alpha * (S / deg[:, None])
    return D


def project_to_surface(V, F, target_mesh, iters=8, clamp=1.5, relax_strength=0.4,
                       field_smooth_rounds=3, final_snap_clamp=0.4, device="auto"):
    """Project (V,F) onto target_mesh.

    Per iteration: (1) tangential relaxation - slide each vertex toward its
    neighbours' centroid within the tangent plane, which regularises triangle
    shape (especially after quadric decimation) without denting the form;
    (2) closest-point displacement with a normal-consistency guard, Laplacian-
    smoothed as a field before applying (kills crease zigzag and thin-geometry
    punch-through). A final clamped normal-only micro-snap firms up creases.
    `clamp` is kept for API compatibility."""
    pq = _make_surface_query(target_mesh, device)
    try:
        return _project(pq, V, F, target_mesh, iters, relax_strength,
                        field_smooth_rounds, final_snap_clamp)
    finally:
        # Release the (GPU) BVH as soon as projection is done, regardless of how
        # we exit, so it doesn't linger until the next garbage-collection cycle.
        if hasattr(pq, "free"):
            pq.free()


def _project(pq, V, F, target_mesh, iters, relax_strength,
             field_smooth_rounds, final_snap_clamp):
    tgt_fn = np.asarray(target_mesh.face_normals)
    adjacency = _vertex_adjacency(len(V), F)
    idx, ptr, deg = _csr(adjacency)
    Vc = np.asarray(V, float).copy()

    for _ in range(int(iters)):
        normals = trimesh.Trimesh(Vc, F, process=False).vertex_normals
        # tangential relax (vectorized)
        if relax_strength:
            centroid = np.add.reduceat(Vc[idx], ptr[:-1], axis=0) / deg[:, None]
            d = centroid - Vc
            d -= normals * np.sum(d * normals, axis=1)[:, None]
            Vc = Vc + relax_strength * d
        # smoothed displacement toward the original surface
        closest, tid = pq.on_surface(Vc)
        D = closest - Vc
        agree = np.sum(normals * tgt_fn[tid], axis=1) >= 0.0
        D *= agree[:, None]
        D = _lap_smooth(D, idx, ptr, deg, field_smooth_rounds)
        Vc = Vc + D

    if final_snap_clamp:
        normals = trimesh.Trimesh(Vc, F, process=False).vertex_normals
        closest, tid = pq.on_surface(Vc)
        D = closest - Vc
        agree = np.sum(normals * tgt_fn[tid], axis=1) >= 0.0
        D *= agree[:, None]
        dn = np.sum(D * normals, axis=1)                 # normal (depth) component
        el = _vertex_edge_length(Vc, F)
        dn = np.clip(dn, -final_snap_clamp * el, final_snap_clamp * el)
        Dn = _lap_smooth(dn[:, None] * normals, idx, ptr, deg, 1)
        Vc = Vc + Dn
    return np.ascontiguousarray(Vc)
