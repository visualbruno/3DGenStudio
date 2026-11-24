"""CuPy port of the projection stage's per-iteration loop (project._project).

Until 2026-11-24 only the closest-point query ran on the GPU (Warp): 0.08 s of
each ~1.3 s iteration at 1M faces. The rest - angle-weighted vertex normals, the
neighbour-centroid relax, three Laplacian rounds on the displacement field - was
NumPy, so "Projecting to surface (GPU)" spent ~95% of its time on the CPU
(28 s of a 1M-face run). This module runs that whole loop on the device:

  * neighbour sums (np.add.reduceat over the CSR adjacency) -> one CSR sparse
    matrix-vector product with the same idx/ptr arrays;
  * trimesh's weighted_vertex_normals (Thuerrner-Wuethrich corner-angle
    weights, faces with a degenerate normal skipped, degenerate triangles'
    angles zeroed, result unitized) -> scatter-add of angle * face normal;
  * the closest-point query stays the existing Warp BVH query. Its points take a
    host round trip (a few MB per iteration, ~ms) instead of a CuPy<->Warp
    stream handoff, which keeps the two runtimes' streams from racing.

Float64 throughout so it tracks the CPU path to rounding error (summation order
differs). Same arguments, same result contract: returns a host (n, 3) array.
"""
from __future__ import annotations
import numpy as np

_MERGE_TOL = 1e-8      # trimesh.tol.merge: triangles.angles zeroes a face with any angle below it
_UNIT_EPS = 1e-12      # below this length a vector unitizes to zero (trimesh.util.unitize)


def _unitize(cp, X):
    n = cp.sqrt((X * X).sum(axis=1))
    ok = n > _UNIT_EPS
    return cp.where(ok[:, None], X / cp.where(ok, n, 1.0)[:, None], 0.0)


class _GpuMesh:
    """Device-resident topology for one (V, F) mesh: faces, CSR adjacency, edges."""

    def __init__(self, cp, csp, F, idx, ptr, deg, n):
        self.cp = cp
        self.n = n
        self.F = cp.asarray(F, dtype=cp.int64)
        self.Fr = self.F.ravel()
        data = cp.ones(len(idx), dtype=cp.float64)
        self.A = csp.csr_matrix((data, cp.asarray(idx, cp.int64), cp.asarray(ptr, cp.int64)),
                                shape=(n, n))
        self.deg = cp.asarray(deg, dtype=cp.float64)
        e = cp.concatenate([self.F[:, [0, 1]], self.F[:, [1, 2]], self.F[:, [2, 0]]])
        self.e0, self.e1 = e[:, 0], e[:, 1]

    def nbr_sum(self, X):
        return self.A @ X

    def vertex_normals(self, V):
        cp = self.cp
        a, b, c = V[self.F[:, 0]], V[self.F[:, 1]], V[self.F[:, 2]]
        fn = _unitize(cp, cp.cross(b - a, c - a))
        u = _unitize(cp, b - a)
        v = _unitize(cp, c - a)
        w = _unitize(cp, c - b)
        ang = cp.empty((len(a), 3), dtype=cp.float64)
        ang[:, 0] = cp.arccos(cp.clip((u * v).sum(1), -1.0, 1.0))
        ang[:, 1] = cp.arccos(cp.clip((-u * w).sum(1), -1.0, 1.0))
        ang[:, 2] = np.pi - ang[:, 0] - ang[:, 1]
        ang[(ang < _MERGE_TOL).any(axis=1)] = 0.0
        ang[(fn * fn).sum(1) <= 0.5] = 0.0            # weighted_vertex_normals' face_ok
        contrib = (ang[:, :, None] * fn[:, None, :]).reshape(-1, 3)
        summed = cp.zeros((self.n, 3), dtype=cp.float64)
        import cupyx
        cupyx.scatter_add(summed, self.Fr, contrib)
        return _unitize(cp, summed)

    def lap_smooth(self, D, rounds, alpha=0.7):
        for _ in range(int(rounds)):
            D = (1.0 - alpha) * D + alpha * (self.nbr_sum(D) / self.deg[:, None])
        return D

    def edge_length(self, V):
        cp = self.cp
        import cupyx
        d = cp.sqrt(((V[self.e0] - V[self.e1]) ** 2).sum(1))
        s = cp.zeros(self.n, cp.float64)
        c = cp.zeros(self.n, cp.float64)
        cupyx.scatter_add(s, self.e0, d); cupyx.scatter_add(s, self.e1, d)
        cupyx.scatter_add(c, self.e0, 1.0); cupyx.scatter_add(c, self.e1, 1.0)
        return s / cp.maximum(c, 1.0)


def project_loop(cp, csp, pq, V, F, tgt_fn, idx, ptr, deg, iters, relax_strength,
                 field_smooth_rounds, final_snap_clamp):
    """Device twin of project._project's loop. `pq` is any surface query with
    `.on_surface(host_pts) -> (host_closest, host_face_ids)`."""
    g = _GpuMesh(cp, csp, F, idx, ptr, deg, len(V))
    tfn = cp.asarray(tgt_fn, dtype=cp.float64)
    Vc = cp.asarray(V, dtype=cp.float64)

    def pull(Vc, normals):
        closest, tid = pq.on_surface(cp.asnumpy(Vc))
        D = cp.asarray(closest, dtype=cp.float64) - Vc
        agree = (normals * tfn[cp.asarray(tid)]).sum(1) >= 0.0
        return D * agree[:, None]

    for _ in range(int(iters)):
        normals = g.vertex_normals(Vc)
        if relax_strength:
            centroid = g.nbr_sum(Vc) / g.deg[:, None]
            d = centroid - Vc
            d -= normals * (d * normals).sum(1)[:, None]
            Vc = Vc + relax_strength * d
        D = g.lap_smooth(pull(Vc, normals), field_smooth_rounds)
        Vc = Vc + D

    if final_snap_clamp:
        normals = g.vertex_normals(Vc)
        D = pull(Vc, normals)
        dn = (D * normals).sum(1)
        el = g.edge_length(Vc)
        dn = cp.clip(dn, -final_snap_clamp * el, final_snap_clamp * el)
        Vc = Vc + g.lap_smooth(dn[:, None] * normals, 1)
    return np.ascontiguousarray(cp.asnumpy(Vc))
