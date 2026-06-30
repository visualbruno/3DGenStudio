"""Chart segmentation.

The single most important stage for *beautiful* low-poly UVs. The goal is the
opposite of what xatlas does by default: produce **as few charts as possible**
while keeping each chart near-developable (low distortion) and placing seams on
natural creases.

Algorithm: greedy agglomerative region merging with an *exact* normal-cone
constraint.

  * Start with one chart per face.
  * Repeatedly merge the cheapest adjacent chart pair, where
        cost = angle(meanNormalA, meanNormalB) + sharp_weight * sharpest_shared_edge
  * A merge is only *allowed* if the merged chart's normal-cone half-angle stays
    below ``max_cone`` (this is the quality dial: bigger cone -> fewer charts,
    more distortion). Bounding the normal cone bounds the Gaussian curvature
    inside the chart, which bounds the flattening distortion.
  * Finally, slivers (charts with too few faces or too little area) are folded
    into a neighbour that keeps the merged cone smallest, to eliminate the
    few-triangle islands that plague bottom-up methods.

The normal cone half-angle is the **exact** maximum angle between the chart's
area-weighted mean normal and any member face normal -- *not* a cumulative
upper bound. An earlier version accumulated ``cone + angle(mean_shift)`` on
every merge; that triangle-inequality bound inflates without limit and rejects
legal merges, stranding hundreds of tiny charts. Here we keep a cheap upper
bound only as a fast-accept test and fall back to the exact cone (a single
vectorised dot product over the chart's faces) whenever the bound is close to
the cap.
"""
from __future__ import annotations

import heapq
import numpy as np

from .mesh import Mesh


class _Chart:
    __slots__ = ("faces", "area", "nsum", "mean", "cone", "version", "alive")

    def __init__(self, face, area, normal):
        self.faces = [face]
        self.area = float(area)
        self.nsum = normal * area          # area-weighted normal accumulator
        self.mean = normal.copy()          # unit mean normal
        self.cone = 0.0                    # EXACT half-angle of normal cone (rad)
        self.version = 0
        self.alive = True


def _angle(a, b):
    return float(np.arccos(np.clip(np.dot(a, b), -1.0, 1.0)))


def segment(
    mesh: Mesh,
    max_cone_deg: float = 50.0,
    sharp_weight: float = 0.35,
    min_faces: int = 20,
    min_area_frac: float = 0.004,
    fold_cap_deg: float = 88.0,
) -> np.ndarray:
    """Return an int array of length ``n_faces`` giving a chart id per face."""
    F = mesh.n_faces
    normals = mesh.face_normals
    areas = mesh.face_areas
    adj = mesh.adjacency
    adj_ang = mesh.adjacency_angle
    max_cone = np.radians(max_cone_deg)
    total_area = float(areas.sum())
    min_area = min_area_frac * total_area

    charts = {i: _Chart(i, areas[i], normals[i]) for i in range(F)}
    face_chart = np.arange(F)

    # adjacency between charts: chart_id -> {neighbour: sharpest shared edge ang}
    nbr = [dict() for _ in range(F)]
    for (fa, fb), ang in zip(adj, adj_ang):
        ca, cb = int(fa), int(fb)
        nbr[ca][cb] = max(nbr[ca].get(cb, 0.0), ang)
        nbr[cb][ca] = max(nbr[cb].get(ca, 0.0), ang)

    def merge_cost(a, b):
        ca, cb = charts[a], charts[b]
        sharp = nbr[a].get(b, 0.0)
        return _angle(ca.mean, cb.mean) + sharp_weight * sharp

    def exact_cone(faces, mean):
        """Exact normal-cone half-angle: max angle(mean, face_normal)."""
        d = normals[faces] @ mean
        return float(np.arccos(np.clip(d.min(), -1.0, 1.0)))

    def try_merge(a, b):
        """Return (cone, mean, nsum, faces) if merge is legal, else None.

        Uses a cheap cumulative upper bound as a fast accept; only computes the
        exact cone when the bound is over the cap (the bound never under-states
        the true cone, so bound <= cap guarantees exact <= cap).
        """
        ca, cb = charts[a], charts[b]
        nsum = ca.nsum + cb.nsum
        n = np.linalg.norm(nsum)
        if n < 1e-12:                       # opposing normals -> reject
            return None
        mean = nsum / n
        bound = max(ca.cone + _angle(mean, ca.mean),
                    cb.cone + _angle(mean, cb.mean))
        if bound <= max_cone:
            faces = ca.faces + cb.faces
            return bound, mean, nsum, faces  # bound is a safe (slightly loose) cone
        # bound exceeds cap: check the exact cone before rejecting
        faces = ca.faces + cb.faces
        cone = exact_cone(faces, mean)
        if cone <= max_cone:
            return cone, mean, nsum, faces
        return None

    # priority queue of (cost, a, b, va, vb)
    heap = []
    for a in range(F):
        for b in nbr[a]:
            if a < b:
                heapq.heappush(heap, (merge_cost(a, b), a, b,
                                      charts[a].version, charts[b].version))

    def push_pair(a, b):
        heapq.heappush(heap, (merge_cost(a, b), a, b,
                              charts[a].version, charts[b].version))

    # -------------------------------------------------- main merge loop
    while heap:
        cost, a, b, va, vb = heapq.heappop(heap)
        ca = charts.get(a)
        cb = charts.get(b)
        if ca is None or cb is None or not ca.alive or not cb.alive:
            continue
        if ca.version != va or cb.version != vb:
            continue  # stale entry
        res = try_merge(a, b)
        if res is None:
            continue  # would bend too much; leave the seam here
        cone, mean, nsum, faces = res

        # merge b into a
        ca.faces = faces
        for f in cb.faces:
            face_chart[f] = a
        ca.area += cb.area
        ca.nsum = nsum
        ca.mean = mean
        # store the EXACT cone so future bounds stay tight
        ca.cone = exact_cone(faces, mean)
        ca.version += 1
        cb.alive = False

        # rewire neighbours of b onto a
        for c, sharp in nbr[b].items():
            if c == a:
                continue
            if charts[c].alive:
                nbr[a][c] = max(nbr[a].get(c, 0.0), sharp)
                nbr[c][a] = max(nbr[c].get(a, 0.0), sharp)
                nbr[c].pop(b, None)
        nbr[a].pop(b, None)
        charts.pop(b, None)

        for c in nbr[a]:
            if charts[c].alive:
                push_pair(a, c)

    # -------------------------------------------------- sliver cleanup
    # Collapse the long tail of tiny charts: a noisy organic mesh leaves many
    # few-triangle slivers in crevices (typically a large *count* but a tiny
    # fraction of the surface area). Fold every chart below ``min_faces`` /
    # ``min_area`` into the neighbour that keeps the merged normal cone
    # smallest, refusing only when even the best choice would fold the chart
    # past flat (cone > ``fold_cap``), which would create UV overlaps. We
    # iterate to a fixpoint so chains of slivers coalesce.
    cleanup_cap = np.radians(fold_cap_deg)

    def cone_if_merged(a, b):
        ca, cb = charts[a], charts[b]
        nsum = ca.nsum + cb.nsum
        n = np.linalg.norm(nsum)
        if n < 1e-12:
            return np.pi, None, None
        mean = nsum / n
        cone = exact_cone(ca.faces + cb.faces, mean)
        return cone, mean, nsum

    changed = True
    while changed:
        changed = False
        for cid in list(charts.keys()):
            ch = charts.get(cid)
            if ch is None or not ch.alive:
                continue
            if len(ch.faces) >= min_faces and ch.area >= min_area:
                continue
            cands = [c for c in nbr[cid] if charts.get(c) and charts[c].alive]
            if not cands:
                continue
            scored = []
            for c in cands:
                cone, mean, nsum = cone_if_merged(cid, c)
                if mean is None:
                    continue
                scored.append((cone, merge_cost(cid, c), c, mean, nsum))
            if not scored:
                continue
            scored.sort(key=lambda x: (x[0], x[1]))
            cone, _, best, mean, nsum = scored[0]
            if cone > cleanup_cap:
                continue  # leave this sliver alone rather than fold a chart
            cb_, ca_ = charts[cid], charts[best]
            ca_.faces = ca_.faces + cb_.faces
            for f in cb_.faces:
                face_chart[f] = best
            ca_.area += cb_.area
            ca_.nsum = nsum
            ca_.mean = mean
            ca_.cone = cone
            ca_.version += 1
            cb_.alive = False
            for c, sharp in nbr[cid].items():
                if c == best or not (charts.get(c) and charts[c].alive):
                    continue
                nbr[best][c] = max(nbr[best].get(c, 0.0), sharp)
                nbr[c][best] = max(nbr[c].get(best, 0.0), sharp)
                nbr[c].pop(cid, None)
            nbr[best].pop(cid, None)
            charts.pop(cid, None)
            changed = True

    # -------------------------------------------------- relabel 0..K-1
    _, labels = np.unique(face_chart, return_inverse=True)
    return labels.astype(np.int64)


def refine_merge(
    mesh: Mesh,
    labels: np.ndarray,
    target_faces: int = 80,
    ad_thresh: float = 1.32,
    min_packfill: float = 0.30,
    union_cap: int = 4000,
    max_passes: int = 6,
    progress=None,
) -> np.ndarray:
    """Merge adjacent charts validated by the *actual* flattening.

    The cone constraint in :func:`segment` is a conservative proxy: it bounds
    distortion locally but, on a noisy organic mesh, leaves a long tail of small
    charts that *could* in fact be flattened together without overlap. This
    pass repeatedly tries to merge each small chart into a neighbour, accepting
    the merge only when the union actually parameterises **flip-free** and below
    a distortion threshold. It optimises the true objective (no UV overlaps, low
    distortion, few charts) instead of the proxy, and is the main reason the
    final atlas has a handful of large islands rather than hundreds of slivers.

    ``target_faces`` is the size below which a chart is considered "small" and
    worth trying to absorb. Larger -> fewer, larger islands (slower).
    """
    from . import param as _param  # local import: param has no segment dep

    V = mesh.vertices
    Fc = mesh.faces
    areas = mesh.face_areas
    adj = mesh.adjacency
    labels = labels.copy()
    cache: dict[tuple, tuple] = {}

    def quality(faces_tuple):
        cached = cache.get(faces_tuple)
        if cached is not None:
            return cached
        fid = np.asarray(faces_tuple, dtype=np.int64)
        uv, _, lf, info = _param.parameterize_chart(V, Fc, fid)
        # compactness = how much of the UV bounding box the island actually
        # fills. Spindly / branchy islands (low pack-fill) waste atlas space and
        # look ugly, so we track it and refuse merges that create them.
        ext = uv.max(axis=0) - uv.min(axis=0)
        bbox = float(ext[0] * ext[1])
        e0 = uv[lf[:, 1]] - uv[lf[:, 0]]
        e1 = uv[lf[:, 2]] - uv[lf[:, 0]]
        uv_area = 0.5 * float(np.abs(e0[:, 0] * e1[:, 1] - e0[:, 1] * e1[:, 0]).sum())
        packfill = uv_area / bbox if bbox > 1e-12 else 0.0
        cache[faces_tuple] = (info["flips"], info["angle_d"], packfill)
        return cache[faces_tuple]

    for _pass in range(max_passes):
        if progress is not None:
            progress(_pass / max_passes)
        chart_faces: dict[int, list] = {}
        for f, l in enumerate(labels):
            chart_faces.setdefault(int(l), []).append(f)
        cadj: dict[int, set] = {c: set() for c in chart_faces}
        for fa, fb in adj:
            la, lb = int(labels[fa]), int(labels[fb])
            if la != lb:
                cadj[la].add(lb)
                cadj[lb].add(la)

        dead: set[int] = set()
        merged = 0
        # smallest charts first -- they are the slivers we most want gone
        for c in sorted(chart_faces, key=lambda k: len(chart_faces[k])):
            if c in dead or len(chart_faces[c]) >= target_faces:
                continue
            best = None
            for nb in cadj[c]:
                if nb in dead:
                    continue
                union = chart_faces[c] + chart_faces[nb]
                if len(union) > union_cap:
                    continue
                fl, ad, pf = quality(tuple(sorted(union)))
                if fl == 0 and ad < ad_thresh and pf >= min_packfill:
                    # prefer the neighbour that yields the most compact island
                    if best is None or pf > best[1]:
                        best = (nb, pf, union)
            if best is not None:
                nb, _, union = best
                for f in chart_faces[nb]:
                    labels[f] = c
                chart_faces[c] = union
                cadj[c] |= cadj[nb]
                cadj[c].discard(c)
                dead.add(nb)
                merged += 1
        if merged == 0:
            break

    if progress is not None:
        progress(1.0)
    _, labels = np.unique(labels, return_inverse=True)
    return labels.astype(np.int64)
