"""Per-chart flattening.

Three methods, best-of kept per chart:

* **LSCM** (Levy et al. 2002): minimises *angle* distortion, needs two pinned
  vertices. Conformal, so it preserves angles at the cost of *area* — a large
  chart spanning curvature comes out with uneven texel density.

* **ARAP** (Liu et al. 2008, "A Local/Global Approach to Mesh Parameterization"):
  minimises deviation from a *rigid* (isometric) map, so it balances angle *and*
  area distortion. It needs an initial flattening to start from; we seed it with
  the LSCM result (or planar) and run a few local/global iterations. This is what
  flattens the area distortion that LSCM leaves on the larger islands the weld +
  merge passes now produce.

* **planar**: orthographic projection onto the chart's best-fit plane. Always
  succeeds; the only sane answer for closed charts with no boundary (LSCM
  degenerate) and a very good one for near-flat charts.

For each chart we compute the viable candidates and keep whichever has the
lowest combined (angle + area) distortion with no flips.
"""
from __future__ import annotations

import numpy as np
from scipy.sparse import coo_matrix, csc_matrix
from scipy.sparse.linalg import spsolve, splu


# --------------------------------------------------------------------- helpers
def _chart_local(vertices, faces, face_ids):
    """Extract a chart as a compact (V',3) / (F',3) local mesh."""
    f = faces[face_ids]
    uniq, inv = np.unique(f.reshape(-1), return_inverse=True)
    local_faces = inv.reshape(-1, 3)
    local_verts = vertices[uniq]
    return local_verts, local_faces, uniq


def _boundary_vertices(local_faces, n_verts):
    """Indices of vertices lying on the chart boundary (open edges)."""
    e = np.concatenate([local_faces[:, [0, 1]],
                        local_faces[:, [1, 2]],
                        local_faces[:, [2, 0]]], axis=0)
    es = np.sort(e, axis=1)
    # an edge is on the boundary if it occurs exactly once
    uniq, counts = np.unique(es, axis=0, return_counts=True)
    bedges = uniq[counts == 1]
    if len(bedges) == 0:
        return np.array([], dtype=np.int64)
    return np.unique(bedges.reshape(-1))


def _triangle_local_coords(p0, p1, p2):
    """Isometrically flatten one triangle into 2D local coordinates."""
    e1 = p1 - p0
    len1 = np.linalg.norm(e1)
    if len1 < 1e-12:
        return None
    x_axis = e1 / len1
    e2 = p2 - p0
    proj = np.dot(e2, x_axis)
    perp = e2 - proj * x_axis
    h = np.linalg.norm(perp)
    # (x,y) of the three corners
    return np.array([[0.0, 0.0], [len1, 0.0], [proj, h]])


# ------------------------------------------------------------------------ LSCM
def lscm(local_verts, local_faces):
    """Solve LSCM. Returns (uv, ok)."""
    n = len(local_verts)
    bnd = _boundary_vertices(local_faces, n)
    if len(bnd) < 2:
        return None, False  # closed chart -> degenerate for LSCM

    # pin the two most distant boundary vertices
    bpos = local_verts[bnd]
    c = bpos.mean(axis=0)
    far = bnd[np.argmax(np.linalg.norm(bpos - c, axis=1))]
    far_pos = local_verts[far]
    p1 = bnd[np.argmax(np.linalg.norm(local_verts[bnd] - far_pos, axis=1))]
    p0 = far
    if p0 == p1:
        return None, False

    rows, cols, vals = [], [], []
    nt = len(local_faces)
    for t, (i, j, k) in enumerate(local_faces):
        loc = _triangle_local_coords(local_verts[i], local_verts[j],
                                     local_verts[k])
        if loc is None:
            continue
        (x0, y0), (x1, y1), (x2, y2) = loc
        # W = opposite edge of each vertex, as a complex number a + i b
        W = np.array([
            (x2 - x1) + 1j * (y2 - y1),
            (x0 - x2) + 1j * (y0 - y2),
            (x1 - x0) + 1j * (y1 - y0),
        ])
        area2 = abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0))
        w = 1.0 / np.sqrt(area2 + 1e-12)
        idx = (i, j, k)
        r_real = 2 * t
        r_imag = 2 * t + 1
        for vtx, Wv in zip(idx, W):
            a, b = w * Wv.real, w * Wv.imag
            # Real:  a*u - b*v
            rows += [r_real, r_real]
            cols += [vtx, n + vtx]
            vals += [a, -b]
            # Imag:  b*u + a*v
            rows += [r_imag, r_imag]
            cols += [vtx, n + vtx]
            vals += [b, a]

    M = coo_matrix((vals, (rows, cols)), shape=(2 * nt, 2 * n)).tocsc()

    pinned = np.array([p0, n + p0, p1, n + p1])
    pin_val = np.array([0.0, 0.0, 1.0, 0.0])  # p0->(0,0), p1->(1,0)
    free = np.setdiff1d(np.arange(2 * n), pinned)

    Mf = M[:, free]
    Mp = M[:, pinned]
    rhs = -Mp.dot(pin_val)
    A = (Mf.T @ Mf).tocsc()
    bvec = Mf.T @ rhs
    try:
        xf = spsolve(A, bvec)
    except Exception:
        return None, False
    if not np.all(np.isfinite(xf)):
        return None, False

    x = np.zeros(2 * n)
    x[free] = xf
    x[pinned] = pin_val
    uv = np.stack([x[:n], x[n:]], axis=1)
    return uv, True


# ------------------------------------------------------------------- planar
def planar(local_verts, local_faces):
    """Project onto the area-weighted mean-normal plane.

    Projecting along the surface normal guarantees no triangle flips as long as
    every face normal stays within 90 degrees of the mean -- which is exactly
    the invariant the bounded-cone segmentation maintains. In-plane axes are
    aligned to the chart's principal direction for a tidy result.
    """
    v = local_verts[local_faces]
    fn = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    a = np.linalg.norm(fn, axis=1, keepdims=True)
    n = (fn).sum(axis=0)
    nn = np.linalg.norm(n)
    if nn < 1e-12:
        n = np.array([0.0, 0.0, 1.0])
    else:
        n = n / nn
    # build an in-plane basis
    ref = np.array([1.0, 0.0, 0.0]) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    t1 = np.cross(n, ref)
    t1 /= max(np.linalg.norm(t1), 1e-12)
    t2 = np.cross(n, t1)
    c = local_verts.mean(axis=0)
    X = local_verts - c
    uv = np.stack([X @ t1, X @ t2], axis=1)
    return uv


# --------------------------------------------------------------------- ARAP
def _flatten_triangles(local_verts, local_faces):
    """Isometric 2D coords + corner cotangents for every triangle (vectorised).

    Returns (P, cot, area) where P is (F,3,2) the isometrically flattened corners,
    cot is (F,3) the cotangent of the angle at corner 0/1/2, and area is (F,).
    """
    v = local_verts[local_faces]                      # (F,3,3)
    e1 = v[:, 1] - v[:, 0]
    e2 = v[:, 2] - v[:, 0]
    len1 = np.linalg.norm(e1, axis=1)
    len1 = np.where(len1 < 1e-12, 1e-12, len1)
    x_axis = e1 / len1[:, None]
    proj = np.einsum("ij,ij->i", e2, x_axis)
    perp = e2 - proj[:, None] * x_axis
    h = np.linalg.norm(perp, axis=1)
    P = np.zeros((len(local_faces), 3, 2))
    P[:, 1, 0] = len1
    P[:, 2, 0] = proj
    P[:, 2, 1] = h
    area = 0.5 * len1 * h                              # = 0.5 * base * height

    # cotangent of the angle at each corner, from the flattened coords
    p0, p1, p2 = P[:, 0], P[:, 1], P[:, 2]
    twoA = np.where(2.0 * area < 1e-12, 1e-12, 2.0 * area)
    cot = np.empty((len(local_faces), 3))
    cot[:, 0] = np.einsum("ij,ij->i", p1 - p0, p2 - p0) / twoA   # angle at 0
    cot[:, 1] = np.einsum("ij,ij->i", p0 - p1, p2 - p1) / twoA   # angle at 1
    cot[:, 2] = np.einsum("ij,ij->i", p0 - p2, p1 - p2) / twoA   # angle at 2
    return P, cot, area


def arap(local_verts, local_faces, uv_init, iters=4):
    """Refine an initial UV toward an as-rigid-as-possible map.

    Local/global iteration: (local) fit the best rotation per triangle between
    the flattened reference and the current UV; (global) re-solve vertex
    positions for those rotations through a cotangent-Laplacian system whose
    factorisation is reused across iterations. Returns (uv, ok).
    """
    n = len(local_verts)
    if n < 3 or len(local_faces) < 1:
        return None, False
    P, cot, area = _flatten_triangles(local_verts, local_faces)

    # the three within-triangle edges (a,b) and the cotangent weighting each:
    # edge (0,1) is opposite corner 2, etc.
    E = [(0, 1, 2), (1, 2, 0), (2, 0, 1)]
    ai = np.concatenate([local_faces[:, a] for a, _, _ in E])
    bi = np.concatenate([local_faces[:, b] for _, b, _ in E])
    w = np.concatenate([cot[:, c] for _, _, c in E])     # (3F,)
    # reference edge vectors P[a]-P[b] for each edge (3F,2)
    dP = np.concatenate([P[:, a] - P[:, b] for a, b, _ in E], axis=0)

    # cotangent Laplacian A (constant across iterations) -------------------
    rows = np.concatenate([ai, bi, ai, bi])
    cols = np.concatenate([ai, bi, bi, ai])
    data = np.concatenate([w, w, -w, -w])
    A = coo_matrix((data, (rows, cols)), shape=(n, n)).tolil()
    # pin vertex 0 to remove the translational null space
    A[0, :] = 0.0
    A[0, 0] = 1.0
    try:
        lu = splu(csc_matrix(A))
    except Exception:
        return None, False

    nf = len(local_faces)
    uv = uv_init.astype(np.float64).copy()
    fa = local_faces                                     # (F,3)

    for _ in range(max(1, iters)):
        # ---- local step: best rotation per triangle (batched 2x2 SVD) -----
        # S_t = sum_edges w * du * dx^T  (du = current uv diff, dx = ref diff)
        du = np.concatenate([uv[fa[:, a]] - uv[fa[:, b]] for a, b, _ in E], axis=0)
        we = w[:, None]
        # accumulate per-triangle 2x2 covariance
        S = np.zeros((nf, 2, 2))
        contrib = (we * du)[:, :, None] * dP[:, None, :]  # (3F,2,2)
        for k in range(3):
            S += contrib[k * nf:(k + 1) * nf]
        U, _, Vt = np.linalg.svd(S)
        R = np.matmul(U, Vt)                              # (F,2,2)
        det = np.linalg.det(R)
        flip = det < 0
        if np.any(flip):                                  # enforce proper rotation
            U[flip, :, -1] *= -1.0
            R = np.matmul(U, Vt)

        # ---- global step: solve A uv = rhs --------------------------------
        # rhs[a] += w * R_t dx ; rhs[b] -= w * R_t dx
        Rt_per_edge = np.concatenate([R, R, R], axis=0)   # (3F,2,2)
        rot_dP = np.einsum("eij,ej->ei", Rt_per_edge, dP) * w[:, None]
        rhs = np.zeros((n, 2))
        np.add.at(rhs, ai, rot_dP)
        np.add.at(rhs, bi, -rot_dP)
        rhs[0] = uv_init[0]                               # match the pin
        try:
            uv = np.stack([lu.solve(rhs[:, 0]), lu.solve(rhs[:, 1])], axis=1)
        except Exception:
            return None, False
        if not np.all(np.isfinite(uv)):
            return None, False
    return uv, True


# ------------------------------------------------------------- distortion
def distortion(local_verts, local_faces, uv):
    """Mean per-triangle (angle, area) distortion. Lower is better.

    Angle distortion uses a *quasi-conformal* measure 0.5*(s0/s1 + s1/s0) from
    the singular values of the per-triangle Jacobian, clamped so a few folded
    triangles cannot send the average to infinity. A perfect conformal map
    gives 1.0.
    """
    eps = 1e-12
    cap = 50.0
    tot_w = 0.0
    tot = 0.0
    areas3, areas2 = [], []
    for (i, j, k) in local_faces:
        loc = _triangle_local_coords(local_verts[i], local_verts[j],
                                     local_verts[k])
        if loc is None:
            continue
        P = loc
        Q = uv[[i, j, k]]
        a3 = abs((P[1, 0] - P[0, 0]) * (P[2, 1] - P[0, 1]) -
                 (P[2, 0] - P[0, 0]) * (P[1, 1] - P[0, 1])) * 0.5
        a2 = abs((Q[1, 0] - Q[0, 0]) * (Q[2, 1] - Q[0, 1]) -
                 (Q[2, 0] - Q[0, 0]) * (Q[1, 1] - Q[0, 1])) * 0.5
        if a3 < eps:
            continue
        Pm = np.array([P[1] - P[0], P[2] - P[0]]).T
        Qm = np.array([Q[1] - Q[0], Q[2] - Q[0]]).T
        try:
            J = Qm @ np.linalg.inv(Pm)
        except np.linalg.LinAlgError:
            continue
        s = np.linalg.svd(J, compute_uv=False)
        s = np.clip(s, eps, None)
        qc = 0.5 * (s[0] / s[1] + s[1] / s[0])       # >= 1, =1 if conformal
        qc = min(qc, cap)
        tot += a3 * qc
        tot_w += a3
        areas3.append(a3)
        areas2.append(a2)
    if tot_w == 0:
        return cap, cap
    angle_d = tot / tot_w
    areas3 = np.array(areas3)
    areas2 = np.array(areas2)
    if areas2.sum() > 0:
        ratio = areas2 / areas3
        ratio /= (ratio * areas3).sum() / areas3.sum()
        area_d = float(np.sqrt(np.average((ratio - 1.0) ** 2, weights=areas3)))
    else:
        area_d = cap
    return angle_d, area_d


def count_flips(local_faces, uv):
    """Number of triangles whose orientation flipped in UV space."""
    signs = []
    for (i, j, k) in local_faces:
        Q = uv[[i, j, k]]
        s = (Q[1, 0] - Q[0, 0]) * (Q[2, 1] - Q[0, 1]) - \
            (Q[2, 0] - Q[0, 0]) * (Q[1, 1] - Q[0, 1])
        signs.append(s)
    signs = np.array(signs)
    pos = np.sum(signs > 0)
    neg = np.sum(signs < 0)
    return int(min(pos, neg))


def parameterize_chart(vertices, faces, face_ids, method="auto", arap_iters=4):
    """Flatten one chart. Returns (local_uv, uniq_vertex_ids, local_faces, info)."""
    lv, lf, uniq = _chart_local(vertices, faces, face_ids)
    info = {"method": None, "angle_d": None, "area_d": None, "flips": 0}

    candidates = []
    lscm_uv = None
    if method in ("auto", "lscm", "arap"):
        uv, ok = lscm(lv, lf)
        if ok:
            # fix mirrored orientation if the whole chart came out flipped
            if count_flips(lf, uv) > len(lf) // 2:
                uv[:, 1] *= -1.0
            lscm_uv = uv
            if method in ("auto", "lscm"):
                ad, ar = distortion(lv, lf, uv)
                candidates.append(("lscm", uv, ad, ar, count_flips(lf, uv)))
    if method in ("auto", "planar", "arap") or not candidates:
        uv = planar(lv, lf)
        ad, ar = distortion(lv, lf, uv)
        candidates.append(("planar", uv, ad, ar, count_flips(lf, uv)))

    # ARAP: refine the best available initialisation toward an isometric map.
    # Conformal LSCM preserves angles but lets area (texel density) drift on the
    # larger islands; ARAP pulls that back. Seed from LSCM when we have it, else
    # from the planar projection.
    if method in ("auto", "arap") and arap_iters > 0:
        seed = lscm_uv if lscm_uv is not None else candidates[-1][1]
        uv, ok = arap(lv, lf, seed, iters=arap_iters)
        if ok:
            if count_flips(lf, uv) > len(lf) // 2:
                uv[:, 1] *= -1.0
            ad, ar = distortion(lv, lf, uv)
            candidates.append(("arap", uv, ad, ar, count_flips(lf, uv)))

    # choose the candidate with fewest flips, then lowest combined distortion
    def score(c):
        _, _, ad, ar, fl = c
        return (fl, ad + 2.0 * ar)

    name, uv, ad, ar, fl = min(candidates, key=score)
    info.update(method=name, angle_d=float(ad), area_d=float(ar), flips=int(fl))
    return uv, uniq, lf, info
