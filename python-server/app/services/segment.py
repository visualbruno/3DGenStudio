"""Smart Segmentation — split a mesh into meaningful parts.

Shape Diameter Function segmentation. The SDF is an estimate of local *thickness*:
from each face, rays are fired into the volume inside a cone about the inward
normal, and the weighted mean distance to the far wall is how thick the shape is
there. A limb is thin, a torso is thick, and the step between them is where a
human would cut — which is what makes this work on the organic, generator-produced
meshes this editor mostly handles, where curvature alone finds nothing.

Faces are then merged greedily, cheapest pair first, into a full dendrogram. The
cost mixes the thickness difference with the dihedral angle across the shared
edge, biased so that *concave* creases are far more expensive to cut than convex
ridges (the "minima rule" — a boundary belongs in a valley, never over a bulge).

Nothing here decides how many parts you get. The whole merge history is returned
and the client replays it with a union-find to whatever level the Parts slider
asks for, so changing the part count costs no server round trip.

Two conventions this module must not break:

  * Face order is the contract. Element i of `mapping` is triangle i of the GLB
    that was uploaded, which is triangle i of the caller's BufferGeometry index
    buffer. meshio.load_mesh loads with process=False precisely so that holds.
  * Everything is measured on the *proxy* (a decimated copy) except the rays,
    which are cast against the full-resolution mesh so thin details are measured
    on real geometry rather than on a decimated approximation of it.
"""
from __future__ import annotations

import base64
import heapq
import math

import numpy as np
import trimesh

from ..schemas import SegmentOptions

try:  # Already a hard dependency of the service; stay defensive anyway.
    import pymeshlab as ml
except Exception:  # pragma: no cover
    ml = None

try:
    # trimesh picks embreex up on its own; this import only tells us whether it
    # did. It is the difference between 0.4s and 28s on an 11k-face test mesh —
    # a 74x gap that decides whether the rays may hit the full-resolution mesh at
    # all (see _PRECISE_FACE_LIMIT_WITHOUT_EMBREE).
    import embreex  # noqa: F401
    HAS_EMBREE = True
except Exception:  # pragma: no cover
    HAS_EMBREE = False

# Without embreex, trimesh's ray casting is pure numpy and its cost scales with
# the triangle count of whatever is being hit. Above this, casting against the
# full mesh would take minutes, so the rays fall back to the proxy: thin details
# are then measured on decimated geometry, which is a real quality loss but a
# survivable one. The caller is told it happened.
_PRECISE_FACE_LIMIT_WITHOUT_EMBREE = 20_000


# ---------------------------------------------------------------------------
# Proxy
# ---------------------------------------------------------------------------

def _build_proxy(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """Decimate to roughly `target_faces` triangles.

    Everything downstream is superlinear in the face count — the clustering heap
    especially — and the segmentation of a shape does not live in its surface
    detail. Mirrors services/collision.py's _decimate; if pymeshlab is missing,
    the full mesh is used and the analysis is merely slower.
    """
    faces = len(mesh.faces)
    if target_faces <= 0 or faces <= target_faces or ml is None:
        return mesh
    try:
        ms = ml.MeshSet()
        ms.add_mesh(ml.Mesh(np.asarray(mesh.vertices, float), np.asarray(mesh.faces, np.int64)))
        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=int(target_faces), qualitythr=0.3,
            preservenormal=True, optimalplacement=True, autoclean=True)
        mm = ms.current_mesh()
        proxy = trimesh.Trimesh(np.asarray(mm.vertex_matrix()),
                                np.asarray(mm.face_matrix(), np.int64), process=False)
    except Exception:  # noqa: BLE001 — analysing the full mesh still works
        return mesh

    if len(proxy.faces) < 4:
        return mesh
    # Weld: the decimator can leave coincident vertices, and two faces that meet
    # only geometrically are not adjacent in the dual graph — the proxy would
    # fall apart into shells that the MST fallback then has to stitch blindly.
    proxy.merge_vertices()
    return proxy


# ---------------------------------------------------------------------------
# Thickness (SDF)
# ---------------------------------------------------------------------------

def _cone_directions(count: int, cone_deg: float):
    """`count` directions spread over a cone of `cone_deg`, plus each one's angle
    off the axis. Fibonacci spiral, so the samples stay even at any count."""
    half = math.radians(cone_deg) * 0.5
    cos_half = math.cos(half)
    golden = math.pi * (3.0 - math.sqrt(5.0))
    index = np.arange(count, dtype=np.float64)
    ct = 1.0 - (1.0 - cos_half) * ((index + 0.5) / count)
    st = np.sqrt(np.maximum(0.0, 1.0 - ct * ct))
    phi = index * golden
    dirs = np.stack([st * np.cos(phi), st * np.sin(phi), ct], axis=1)
    return dirs, np.arccos(np.clip(ct, -1.0, 1.0))


def _compute_sdf(source: trimesh.Trimesh, proxy: trimesh.Trimesh,
                 centers, normals, options: SegmentOptions, scale: float, progress=None):
    """Shape Diameter Function per proxy face, normalised to 0..1.

    Rays are cast against `source` (the full-resolution mesh) so a thin fin is
    measured as thin, and their origins are snapped onto that surface first — a
    proxy face centre can sit a visible distance off the real surface after
    decimation, which biases every distance measured from it.
    """
    ray_count = int(options.sdf_rays)
    inward = -normals

    # An orthonormal frame per face to orient the cone. The helper axis is picked
    # away from the normal so the cross product never degenerates.
    helper = np.zeros_like(inward)
    flat = np.abs(inward[:, 2]) < 0.9
    helper[flat] = (0.0, 0.0, 1.0)
    helper[~flat] = (1.0, 0.0, 0.0)
    tangent = np.cross(helper, inward)
    tangent /= np.maximum(np.linalg.norm(tangent, axis=1), 1e-16)[:, None]
    bitangent = np.cross(inward, tangent)

    base, base_angle = _cone_directions(ray_count, float(options.sdf_cone))
    dirs = (base[None, :, 0, None] * tangent[:, None, :]
            + base[None, :, 1, None] * bitangent[:, None, :]
            + base[None, :, 2, None] * inward[:, None, :])
    # Rays near the axis measure the thickness; rays near the rim graze it.
    weights = 1.0 / (base_angle + 0.15)

    nf = len(centers)
    eps = scale * 1e-5
    max_dist = scale * 3.0

    precise = bool(options.precise) and len(source.faces) != len(proxy.faces)
    degraded = precise and not HAS_EMBREE and len(source.faces) > _PRECISE_FACE_LIMIT_WITHOUT_EMBREE
    if degraded:
        precise = False

    if precise:
        try:
            origins = np.asarray(trimesh.proximity.closest_point(source, centers)[0], dtype=np.float64)
        except Exception:  # noqa: BLE001 — the proxy centres are a usable fallback
            origins = centers.copy()
    else:
        source = proxy
        origins = centers.copy()
    origins = origins + inward * eps

    ray_origins = np.repeat(origins, ray_count, axis=0)
    ray_dirs = dirs.reshape(-1, 3)

    if progress:
        progress("sdf", 0.2, f"Measuring thickness with {nf * ray_count:,} rays…")

    locations, index_ray, index_tri = source.ray.intersects_location(
        ray_origins, ray_dirs, multiple_hits=False)

    sdf = np.zeros(nf, dtype=np.float64)
    valid = np.zeros(nf, dtype=bool)
    escaped = nf * ray_count

    if len(index_ray):
        delta = locations - ray_origins[index_ray]
        dist = np.sqrt(np.einsum("ij,ij->i", delta, delta))
        # A ray that leaves through a face turned AWAY from it never crossed the
        # interior — it grazed a fold, and that distance is not a thickness.
        hit_normals = source.face_normals[index_tri]
        facing = np.einsum("ij,ij->i", hit_normals, ray_dirs[index_ray]) > 0.0
        keep = facing & (dist > eps * 2.0) & (dist <= max_dist)
        index_ray, dist = index_ray[keep], dist[keep]
        escaped = nf * ray_count - int(keep.sum())

        face_of_ray = index_ray // ray_count
        weight_of_ray = weights[index_ray % ray_count]

        order = np.argsort(face_of_ray, kind="stable")
        face_of_ray, dist, weight_of_ray = face_of_ray[order], dist[order], weight_of_ray[order]
        counts = np.bincount(face_of_ray, minlength=nf)
        bounds = np.zeros(nf + 1, dtype=np.int64)
        np.cumsum(counts, out=bounds[1:])

        for fi in np.flatnonzero(counts):
            lo, hi = bounds[fi], bounds[fi + 1]
            d, w = dist[lo:hi], weight_of_ray[lo:hi]
            # Drop the outliers before averaging: a few rays always slip through a
            # crack or catch a fold, and one wild distance drags the mean far more
            # than the many good ones pull it back.
            if len(d) > 3:
                median, deviation = np.median(d), np.std(d)
                if deviation > 1e-12:
                    inliers = np.abs(d - median) <= deviation
                    if inliers.sum() >= 2:
                        d, w = d[inliers], w[inliers]
            sdf[fi] = float(np.sum(d * w) / np.sum(w))
            valid[fi] = True

    escape_ratio = escaped / float(max(1, nf * ray_count))
    ray_target = "mesh" if precise else "proxy"
    if not valid.any():
        return np.zeros(nf, dtype=np.float64), escape_ratio, ray_target, degraded

    sdf[~valid] = float(np.median(sdf[valid]))
    lo, hi = sdf.min(), sdf.max()
    if hi - lo < 1e-12:
        return np.zeros(nf, dtype=np.float64), escape_ratio, ray_target, degraded

    # Log-normalise: thickness reads multiplicatively, so a 2mm-vs-4mm step should
    # weigh as much as 20mm-vs-40mm. On a linear scale one thick torso compresses
    # every distinction among the limbs into nothing.
    alpha = float(options.sdf_alpha)
    norm = (sdf - lo) / (hi - lo)
    return np.log(norm * alpha + 1.0) / math.log(alpha + 1.0), escape_ratio, ray_target, degraded


# ---------------------------------------------------------------------------
# Dual graph
# ---------------------------------------------------------------------------

def _build_pairs(vertices, faces, centers, normals, convex_eta: float) -> dict:
    """Dual-graph edges: {(faceA, faceB): [shared length, angular cost]}.

    The concave/convex asymmetry lives here. A concave edge (the faces fold
    towards each other) carries its full angular cost; a convex one is scaled by
    `convex_eta`, which is small. Since clustering merges the CHEAPEST pair first,
    expensive edges survive longest — so the boundaries left standing are the
    concave creases, which is exactly where a part boundary belongs.
    """
    edge_map: dict[tuple[int, int], list[int]] = {}
    for fi in range(len(faces)):
        a, b, c = faces[fi]
        for u, v in ((a, b), (b, c), (c, a)):
            key = (u, v) if u < v else (v, u)
            slot = edge_map.get(key)
            if slot is None:
                edge_map[key] = [fi, -1]
            elif slot[1] == -1:
                slot[1] = fi

    pairs: dict[tuple[int, int], list[float]] = {}
    for (u, v), (f1, f2) in edge_map.items():
        if f2 == -1:
            continue
        length = float(np.linalg.norm(vertices[u] - vertices[v]))
        if length <= 0.0:
            continue
        n1, n2 = normals[f1], normals[f2]
        concave = float(np.dot(n1, centers[f2] - centers[f1])) > 0.0
        cos_angle = float(np.clip(np.dot(n1, n2), -1.0, 1.0))
        angle = (1.0 if concave else convex_eta) * (1.0 - cos_angle)
        key = (f1, f2) if f1 < f2 else (f2, f1)
        slot = pairs.get(key)
        if slot is None:
            pairs[key] = [length, angle * length]
        else:
            slot[0] += length
            slot[1] += angle * length
    return pairs


def _smooth_sdf(sdf, pairs, iterations: int, sigma: float):
    """Bilateral smoothing across the dual graph.

    Ray sampling is noisy at 20 rays a face. A plain average would blur the real
    thickness steps too, and those steps are the entire signal — so neighbours are
    weighted down as their value diverges: noise averages away, steps survive.
    """
    if iterations <= 0 or not pairs:
        return sdf
    n = len(sdf)
    count = len(pairs)
    ia = np.fromiter((k[0] for k in pairs), dtype=np.int32, count=count)
    ib = np.fromiter((k[1] for k in pairs), dtype=np.int32, count=count)
    lengths = np.fromiter((v[0] for v in pairs.values()), dtype=np.float64, count=count)
    src = np.concatenate([ia, ib])
    dst = np.concatenate([ib, ia])
    base_w = np.concatenate([lengths, lengths])

    out = sdf.copy()
    inv = 1.0 / max(sigma, 1e-6)
    for _ in range(iterations):
        w = base_w * np.exp(-np.abs(out[src] - out[dst]) * inv)
        num = np.bincount(src, weights=w * out[dst], minlength=n) + out
        den = np.bincount(src, weights=w, minlength=n) + 1.0
        out = num / np.maximum(den, 1e-12)
    return out


# ---------------------------------------------------------------------------
# Hierarchical clustering
# ---------------------------------------------------------------------------

class _RegionGraph:
    """Regions of the proxy under greedy merging, with a lazily-updated heap.

    Merging invalidates every heap entry touching the two regions. Rather than
    find and remove them — which a binary heap cannot do cheaply — each region
    carries a version counter, and a popped entry whose recorded versions no
    longer match is simply discarded.
    """

    def __init__(self, areas, sdf, centers, pairs, w_sdf: float, w_ang: float):
        n = len(areas)
        self.n = n
        self.alive = np.ones(n, dtype=bool)
        self.area = areas.astype(np.float64).copy()
        self.sdf = sdf.astype(np.float64).copy()
        self.cen = centers.astype(np.float64).copy()
        self.version = np.zeros(n, dtype=np.int64)
        self.w_sdf, self.w_ang = w_sdf, w_ang
        self.total_area = max(float(areas.sum()), 1e-12)
        lengths = [v[0] for v in pairs.values()]
        self.mean_len = float(np.mean(lengths)) if lengths else 1.0
        self.nbr: list[dict] = [dict() for _ in range(n)]
        for (a, b), (length, angle) in pairs.items():
            shared = [length, angle]  # ONE list, referenced from both directions
            self.nbr[a][b] = shared
            self.nbr[b][a] = shared

    def cost(self, a: int, b: int) -> float:
        length, angle_sum = self.nbr[a][b]
        angle = angle_sum / max(length, 1e-12)
        d_sdf = abs(self.sdf[a] - self.sdf[b])
        # Small regions merge first (they are noise until proven otherwise), and a
        # long shared boundary is evidence that the two belong together.
        size = math.sqrt(min(self.area[a], self.area[b]) / self.total_area)
        boundary = math.sqrt(max(length / self.mean_len, 1e-6))
        return (self.w_sdf * d_sdf + self.w_ang * angle + 1e-5) * size / boundary

    def merge(self, a: int, b: int) -> None:
        area_a, area_b = self.area[a], self.area[b]
        total = area_a + area_b
        if total > 1e-15:
            self.sdf[a] = (self.sdf[a] * area_a + self.sdf[b] * area_b) / total
            self.cen[a] = (self.cen[a] * area_a + self.cen[b] * area_b) / total
        self.area[a] = total

        na, nb = self.nbr[a], self.nbr[b]
        na.pop(b, None)
        nb.pop(a, None)
        for k, value in nb.items():
            self.nbr[k].pop(b, None)
            if k in na:
                na[k][0] += value[0]
                na[k][1] += value[1]
            else:
                na[k] = [value[0], value[1]]
            self.nbr[k][a] = na[k]
        self.nbr[b] = {}
        self.alive[b] = False
        self.version[a] += 1


def _cluster(areas, sdf, centers, pairs, w_sdf: float, w_ang: float):
    graph = _RegionGraph(areas, sdf, centers, pairs, w_sdf, w_ang)
    history: list[tuple[int, int]] = []
    costs: list[float] = []
    heap: list[tuple] = []
    counter = 0
    for (a, b) in pairs:
        heapq.heappush(heap, (graph.cost(a, b), counter, a, b, 0, 0))
        counter += 1

    regions = graph.n
    last_cost = 1e-6
    while heap and regions > 1:
        cost, _, a, b, va, vb = heapq.heappop(heap)
        if not graph.alive[a] or not graph.alive[b]:
            continue
        if graph.version[a] != va or graph.version[b] != vb:
            continue
        if b not in graph.nbr[a]:
            continue
        graph.merge(a, b)
        history.append((int(a), int(b)))
        costs.append(float(cost))
        last_cost = max(last_cost, float(cost))
        regions -= 1
        for k in graph.nbr[a]:
            heapq.heappush(heap, (graph.cost(a, k), counter, a, k,
                                  int(graph.version[a]), int(graph.version[k])))
            counter += 1

    shells = regions
    if regions > 1:
        # Disconnected shells share no edge, so the heap can never join them and
        # the Parts slider would bottom out above 1 with no way to say why. A
        # minimum spanning tree over the surviving centroids extends the
        # dendrogram to a single root in one O(R^2) pass, holding no R x R matrix.
        ids = np.flatnonzero(graph.alive)
        r = len(ids)
        cen = graph.cen[ids]
        in_tree = np.zeros(r, dtype=bool)
        best = np.full(r, np.inf)
        best_from = np.zeros(r, dtype=np.int64)
        in_tree[0] = True
        current = 0
        mst = []
        for _ in range(r - 1):
            d = np.linalg.norm(cen - cen[current], axis=1)
            closer = d < best
            best = np.where(closer, d, best)
            best_from = np.where(closer, current, best_from)
            best[in_tree] = np.inf
            nxt = int(np.argmin(best))
            if not np.isfinite(best[nxt]):
                break
            mst.append((float(best[nxt]), int(best_from[nxt]), nxt))
            in_tree[nxt] = True
            current = nxt

        mst.sort()
        parent = list(range(r))

        def find(v: int) -> int:
            while parent[v] != v:
                parent[v] = parent[parent[v]]
                v = parent[v]
            return v

        # Synthetic costs that keep climbing, so the suggested part count never
        # lands on a level that fuses two shells when a real boundary would do.
        synthetic = last_cost
        for _dist, u, v in mst:
            if regions <= 1:
                break
            ru, rv = find(u), find(v)
            if ru == rv:
                continue
            parent[rv] = ru
            history.append((int(ids[ru]), int(ids[rv])))
            synthetic *= 1.06
            costs.append(synthetic)
            regions -= 1

    return history, costs, regions, shells


def _suggest_parts(costs: list[float], n: int, kmin: int = 2, kmax: int = 48):
    """The most natural place to stop merging.

    A part count is a good stopping point when the next merge is much more
    expensive than the last — every merge below it was cheap (those pieces
    belonged together) and the one above it was not.

    Scored on the jump ratio TIMES the absolute cost, not the ratio alone. Deep
    in the tail every merge is cheap, so one anomalously cheap merge down there
    produces a huge ratio out of nothing: on a six-limbed test body the ratio
    alone scored a meaningless break at 48 parts (1.850) a hair above the real
    structural one at 7 (1.835), while the merge being refused cost an order of
    magnitude less. Weighting by the cost asks how much the boundary is actually
    worth keeping, and it picks the real break by 8x.
    """
    if len(costs) < 8:
        return None
    best_k, best_score = None, 0.0
    for k in range(kmin, kmax + 1):
        i = n - k - 1
        if i < 1 or i >= len(costs):
            continue
        previous = costs[i - 1]
        if previous <= 1e-12:
            continue
        score = (costs[i] / previous) * costs[i]
        if score > best_score:
            best_score, best_k = score, k + 1
    return best_k


# ---------------------------------------------------------------------------
# Original -> proxy mapping
# ---------------------------------------------------------------------------

def _map_to_proxy(mesh: trimesh.Trimesh, proxy: trimesh.Trimesh, progress=None):
    """For every original face, the proxy triangle its centre is closest to.

    Distance is measured to the triangle SURFACE, not to its centre. On a proxy
    whose triangles are large the two criteria disagree by a whole triangle near a
    region border — which is precisely where the answer has to be right.

    A KD-tree over the proxy centres narrows the field to a few candidates per
    face; the exact point-triangle distance is then evaluated only on those.
    """
    from scipy.spatial import cKDTree

    centers = np.asarray(mesh.triangles_center, dtype=np.float64)
    proxy_centers = np.asarray(proxy.triangles_center, dtype=np.float64)
    n = len(centers)

    k = int(min(8, len(proxy_centers)))
    _, candidates = cKDTree(proxy_centers).query(centers, k=k, workers=-1)
    candidates = np.asarray(candidates, dtype=np.int64).reshape(n, k)

    triangles = np.asarray(proxy.triangles, dtype=np.float64)
    best = np.full(n, np.inf)
    out = candidates[:, 0].astype(np.int32).copy()

    chunk = 200_000
    for start in range(0, n, chunk):
        stop = min(start + chunk, n)
        points = centers[start:stop]
        block_best = best[start:stop]
        block_out = out[start:stop]
        for j in range(k):
            column = candidates[start:stop, j]
            closest = trimesh.triangles.closest_point(triangles[column], points)
            offset = closest - points
            d = np.einsum("ij,ij->i", offset, offset)
            better = d < block_best
            block_best[better] = d[better]
            block_out[better] = column[better].astype(np.int32)
        best[start:stop] = block_best
        out[start:stop] = block_out
        if progress:
            progress("map", 0.75 + 0.2 * (stop / n), f"Mapping {stop:,}/{n:,} faces…")
    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _b64(array, dtype) -> str:
    return base64.b64encode(np.ascontiguousarray(array, dtype=dtype).tobytes()).decode("ascii")


def run_segment(mesh: trimesh.Trimesh, options: SegmentOptions, progress=None) -> dict:
    def emit(stage, frac, message=""):
        if progress:
            progress(stage, frac, message)

    face_count = len(mesh.faces)
    if face_count < 4:
        raise ValueError("The mesh has too few triangles to segment.")

    emit("proxy", 0.05, "Building the analysis proxy…")
    proxy = _build_proxy(mesh, int(options.proxy_faces))
    if len(proxy.faces) < 4:
        raise ValueError("The analysis proxy came out too small to segment.")

    vertices = np.asarray(proxy.vertices, dtype=np.float64)
    faces = np.asarray(proxy.faces, dtype=np.int32)
    centers = np.asarray(proxy.triangles_center, dtype=np.float64)
    normals = np.asarray(proxy.face_normals, dtype=np.float64)
    areas = np.asarray(proxy.area_faces, dtype=np.float64)

    extents = vertices.max(axis=0) - vertices.min(axis=0)
    scale = float(np.linalg.norm(extents))
    if scale < 1e-9:
        raise ValueError("The mesh has no volume to measure.")

    sdf, escape_ratio, ray_target, degraded = _compute_sdf(
        mesh, proxy, centers, normals, options, scale, progress=emit)

    emit("graph", 0.5, "Building the region graph…")
    pairs = _build_pairs(vertices, faces, centers, normals, float(options.convex_eta))
    if not pairs:
        raise ValueError("No face adjacency found — the mesh is all loose triangles.")
    sdf = _smooth_sdf(sdf, pairs, int(options.sdf_smooth), float(options.sdf_sigma))

    emit("cluster", 0.6, f"Merging {len(faces):,} regions…")
    history, costs, remaining, shells = _cluster(
        areas, sdf, centers, pairs, float(options.w_thickness), float(options.w_concavity))

    emit("map", 0.75, f"Mapping {face_count:,} faces onto the proxy…")
    mapping = _map_to_proxy(mesh, proxy, progress=emit)

    emit("done", 1.0, "Segmentation analysis complete.")
    return {
        "faceCount": int(face_count),
        "proxyFaceCount": int(len(faces)),
        "shells": int(shells),
        "minParts": int(max(1, remaining)),
        "escapeRatio": round(float(escape_ratio), 4),
        "rayTarget": ray_target,
        "note": ("Thickness was measured on the decimated proxy: this mesh is too dense to "
                 "ray-cast without the embreex accelerator, which is not installed. Thin "
                 "details may be under-separated.") if degraded else None,
        "suggestedParts": _suggest_parts(costs, len(faces)),
        "history_b64": _b64(np.asarray(history, dtype=np.int32).reshape(-1, 2), np.int32),
        "costs_b64": _b64(np.asarray(costs, dtype=np.float32), np.float32),
        "mapping_b64": _b64(mapping, np.int32),
    }
