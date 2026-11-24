"""Shape skeleton - the curve skeleton (medial axis) of a mesh, as a graph.

Rigging any creature starts with knowing where its limbs ARE: every leg, arm,
tail, horn and tentacle is a tube, and the centre line of each tube is where its
bones belong. An LLM cannot read that off a picture with any precision; this
module measures it, so the AI only has to say what each line is ("branch 3 is
the front left leg").

Method (robust to the non-manifold, self-intersecting soups AI generators emit):
  1. Surface-voxelize (the memory-bounded lattice from Auto Retopo's shell),
     close cracks, flood-fill the interior -> a solid. If the fill fails (an open
     mesh leaks), close harder and try again.
  2. Smooth it through a signed distance field: blur, re-threshold. Surface
     noise is what grows spurious skeleton twigs; this removes most of it.
  3. Thin the solid to one-voxel curves (Lee's 3D thinning, scikit-image) and
     read the inside distance (EDT) along them = the local tube radius.
  4. Turn voxels into a graph: endpoints, junction CLUSTERS (thinning leaves
     knots of junction voxels, not single ones), and the voxel paths between.
  5. Prune spurs. A twig grown by a surface bump ends just under the surface:
     it reaches no further than the junction's own radius. A real limb sticks
     OUT of the body. `protrusion = length + tip radius - junction radius`
     measures exactly that, so the rule needs no scale guess.
  6. Merge pass-through nodes, smooth the paths, convert to model units.

Cycles are kept (an arm resting on a hip makes one); the caller decides where
to cut them, because only it knows what is a body and what is a limb.
"""
from __future__ import annotations

import time

import numpy as np
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

from .autoretopo.gpu import resolve_backend
from .autoretopo.shell import bounded_surface_voxelize

# 26-neighbourhood offsets.
_OFFSETS = np.array([(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                     if (dx, dy, dz) != (0, 0, 0)], dtype=np.int64)


def _solidify(dense, be, close_iter: int):
    """Close, fill and re-erode the surface voxels. Returns (solid, close_used, interior_ratio)."""
    ndi = be.ndi
    morph = {"brute_force": True} if be.on_gpu else {}
    surface = int(dense.sum())
    best = None
    for close in sorted({close_iter, close_iter + 1, close_iter + 3}):
        s = ndi.binary_dilation(dense, iterations=close, **morph) if close else dense.copy()
        s = ndi.binary_fill_holes(s)
        if close:
            s = ndi.binary_erosion(s, iterations=close, **morph)
        s |= dense
        ratio = (int(s.sum()) - surface) / max(1, surface)
        best = (s, close, ratio)
        # A closed shape holds far more interior than shell; an open one that
        # leaked holds almost none. 0.5 separates the two on every test mesh.
        if ratio > 0.5:
            break
    return best


def _graph_from_skeleton(skel: np.ndarray):
    """Voxel skeleton -> (coords[N,3], neighbours list per voxel)."""
    coords = np.argwhere(skel)
    index = np.full(skel.shape, -1, dtype=np.int32)
    index[coords[:, 0], coords[:, 1], coords[:, 2]] = np.arange(len(coords), dtype=np.int32)
    dims = np.array(skel.shape)
    nbrs = [[] for _ in range(len(coords))]
    for off in _OFFSETS:
        q = coords + off
        ok = np.all((q >= 0) & (q < dims), axis=1)
        idx = np.full(len(coords), -1, dtype=np.int32)
        qq = q[ok]
        idx[ok] = index[qq[:, 0], qq[:, 1], qq[:, 2]]
        for a in np.nonzero(idx >= 0)[0]:
            nbrs[a].append(int(idx[a]))
    return coords, nbrs


class _Graph:
    """Nodes (endpoints / junction clusters) and voxel-path edges, with an
    incremental node -> edges index (the skeleton of a noisy mesh starts with
    thousands of knots, so scanning every edge per query is quadratic)."""

    def __init__(self):
        self.nodes = {}   # id -> {"voxels": [vi...]}
        self.edges = {}   # id -> {"a": node, "b": node, "path": [vi...]}
        self.adj = {}     # node id -> set(edge ids)
        self._next_node = 0
        self._next_edge = 0

    def add_node(self, voxels):
        nid = self._next_node
        self._next_node += 1
        self.nodes[nid] = {"voxels": list(voxels)}
        self.adj[nid] = set()
        return nid

    def add_edge(self, a, b, path):
        eid = self._next_edge
        self._next_edge += 1
        self.edges[eid] = {"a": a, "b": b, "path": list(path)}
        self.adj[a].add(eid)
        self.adj[b].add(eid)
        return eid

    def remove_edge(self, eid):
        e = self.edges.pop(eid)
        self.adj[e["a"]].discard(eid)
        self.adj[e["b"]].discard(eid)

    def remove_node(self, nid):
        for eid in list(self.adj.get(nid, ())):
            self.remove_edge(eid)
        self.nodes.pop(nid, None)
        self.adj.pop(nid, None)

    def incident(self, nid):
        return list(self.adj.get(nid, ()))

    def degree(self, nid):
        # A self loop counts twice, as in graph theory.
        return sum(1 + (self.edges[e]["a"] == self.edges[e]["b"]) for e in self.adj.get(nid, ()))


def _build_graph(coords, nbrs):
    n = len(coords)
    deg = np.array([len(x) for x in nbrs])
    is_node_voxel = deg != 2
    # Junction clusters: union adjacent junction voxels (deg >= 3).
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for v in range(n):
        if deg[v] >= 3:
            for u in nbrs[v]:
                if deg[u] >= 3:
                    ra, rb = find(v), find(u)
                    if ra != rb:
                        parent[rb] = ra
    g = _Graph()
    node_of = np.full(n, -1, dtype=np.int64)
    clusters = {}
    for v in range(n):
        if is_node_voxel[v]:
            clusters.setdefault(find(v) if deg[v] >= 3 else v, []).append(v)
    for members in clusters.values():
        nid = g.add_node(members)
        for v in members:
            node_of[v] = nid
    # Closed loops with no node at all (a ring): seed one node on each.
    seen_interior = np.zeros(n, dtype=bool)
    visited_direct = set()
    for nid, data in list(g.nodes.items()):
        for v in data["voxels"]:
            for u in nbrs[v]:
                if node_of[u] == nid:
                    continue
                if node_of[u] >= 0:
                    key = (min(v, u), max(v, u))
                    if key in visited_direct:
                        continue
                    visited_direct.add(key)
                    g.add_edge(nid, int(node_of[u]), [v, u])
                    continue
                if seen_interior[u]:
                    continue
                path = [v, u]
                prev, cur = v, u
                seen_interior[cur] = True
                while node_of[cur] < 0:
                    nxt = [w for w in nbrs[cur] if w != prev and not (seen_interior[w] and node_of[w] < 0)]
                    # Prefer stepping onto a node voxel when one is adjacent.
                    nodes_next = [w for w in nxt if node_of[w] >= 0]
                    if nodes_next:
                        nxt = nodes_next
                    if not nxt:
                        break
                    prev, cur = cur, nxt[0]
                    path.append(cur)
                    if node_of[cur] < 0:
                        seen_interior[cur] = True
                end = int(node_of[cur]) if node_of[cur] >= 0 else None
                if end is None:
                    end = g.add_node([cur])
                    node_of[cur] = end
                g.add_edge(nid, end, path)
    # Rings that never touched a node.
    for v in range(n):
        if deg[v] == 2 and not seen_interior[v] and node_of[v] < 0:
            nid = g.add_node([v])
            node_of[v] = nid
            path = [v]
            prev, cur = v, nbrs[v][0]
            while cur != v and node_of[cur] < 0:
                seen_interior[cur] = True
                path.append(cur)
                nxt = [w for w in nbrs[cur] if w != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
            path.append(v)
            g.add_edge(nid, nid, path)
    return g


def _path_length(coords, path):
    if len(path) < 2:
        return 0.0
    p = coords[path].astype(np.float64)
    return float(np.linalg.norm(np.diff(p, axis=0), axis=1).sum())


def _merge_passthrough(g: _Graph):
    """Join the two edges of every degree-2 node into one."""
    changed = True
    while changed:
        changed = False
        for nid in list(g.nodes.keys()):
            inc = g.incident(nid)
            if len(inc) != 2 or inc[0] == inc[1]:
                continue
            e1, e2 = g.edges[inc[0]], g.edges[inc[1]]
            if e1["a"] == e1["b"] or e2["a"] == e2["b"]:
                continue
            p1 = e1["path"] if e1["b"] == nid else e1["path"][::-1]
            p2 = e2["path"] if e2["a"] == nid else e2["path"][::-1]
            a = e1["a"] if e1["b"] == nid else e1["b"]
            b = e2["b"] if e2["a"] == nid else e2["a"]
            g.remove_edge(inc[0])
            g.remove_edge(inc[1])
            g.remove_node(nid)
            g.add_edge(a, b, p1 + p2[1:])
            changed = True


def _prune(g: _Graph, coords, radius, min_component: float, spur_ratio: float, spur_min: float):
    """Remove spur twigs (terminal edges that do not stick out of the body)."""
    removed = 0
    node_r = lambda nid: max(radius[v] for v in g.nodes[nid]["voxels"])  # noqa: E731
    changed = True
    while changed:
        changed = False
        _merge_passthrough(g)
        # Drop tiny self loops (knots left inside junction clusters).
        for eid, e in list(g.edges.items()):
            if e["a"] == e["b"] and _path_length(coords, e["path"]) < 2.5 * node_r(e["a"]) + 2:
                g.remove_edge(eid)
                removed += 1
                changed = True
        terminals = []
        for eid, e in g.edges.items():
            da, db = g.degree(e["a"]), g.degree(e["b"])
            if e["a"] == e["b"]:
                continue
            if da == 1 and db >= 3:
                terminals.append((eid, e["a"], e["b"]))
            elif db == 1 and da >= 3:
                terminals.append((eid, e["b"], e["a"]))
        # Shortest first, so that two spurs at one junction do not both survive
        # by propping up its degree.
        terminals.sort(key=lambda t: _path_length(coords, g.edges[t[0]]["path"]))
        for eid, tip, junction in terminals:
            if eid not in g.edges or g.degree(junction) < 3:
                continue
            e = g.edges[eid]
            length = _path_length(coords, e["path"])
            rj = node_r(junction)
            rt = radius[g.nodes[tip]["voxels"][0]]
            protrusion = length + rt - rj
            if protrusion < spur_ratio * rj + spur_min:
                g.remove_edge(eid)
                if not g.incident(tip):
                    g.remove_node(tip)
                removed += 1
                changed = True
    # Isolated nodes and tiny components.
    for nid in list(g.nodes.keys()):
        if not g.incident(nid) and len(g.nodes) > 1:
            g.remove_node(nid)
    comps = _components(g)
    total = sum(_path_length(coords, e["path"]) for e in g.edges.values()) or 1.0
    for comp_nodes, comp_edges in comps:
        clen = sum(_path_length(coords, g.edges[e]["path"]) for e in comp_edges)
        if clen < min_component * total and len(comps) > 1:
            for e in comp_edges:
                if e in g.edges:
                    g.remove_edge(e)
            for nid in comp_nodes:
                g.remove_node(nid)
            removed += 1
    _merge_passthrough(g)
    return removed


def _components(g: _Graph):
    adj = {nid: set() for nid in g.nodes}
    edge_nodes = {}
    for eid, e in g.edges.items():
        adj.setdefault(e["a"], set()).add(e["b"])
        adj.setdefault(e["b"], set()).add(e["a"])
        edge_nodes[eid] = e["a"]
    seen = set()
    out = []
    for start in adj:
        if start in seen:
            continue
        stack = [start]
        comp = set()
        while stack:
            k = stack.pop()
            if k in comp:
                continue
            comp.add(k)
            stack.extend(adj[k] - comp)
        seen |= comp
        out.append((comp, [eid for eid, a in edge_nodes.items() if a in comp]))
    return out


def _sheetness(solid, coords, radius, path, samples: int = 9) -> float:
    """How much MORE solid surrounds an edge than a tube of its radius would.

    ~1 for a limb, tail or tentacle; ~4 (12/pi) for the medial curves of a
    thin SHEET - a robe, a cape, a skirt, a flat carapace - which thinning
    turns into a web of curves with no anatomical meaning. Measured in a cube
    of half-size 3r around points away from the edge's ends (an end sits in a
    junction, where the body it joins would inflate the count)."""
    n = len(path)
    if n < 5:
        return 1.0
    dims = np.array(solid.shape)
    ratios = []
    for k in np.linspace(int(n * 0.2), int(n * 0.8), num=min(samples, n), dtype=int):
        c = coords[path[k]]
        r = max(float(radius[path[k]]), 0.8)
        h = int(np.ceil(3.0 * r))
        lo = np.maximum(c - h, 0)
        hi = np.minimum(c + h + 1, dims)
        count = float(solid[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]].sum())
        ratios.append(count / (np.pi * r * r * (2 * h + 1)))
    return float(np.median(ratios)) if ratios else 1.0


def _smooth(points: np.ndarray, window: int = 2) -> np.ndarray:
    """Moving average that keeps both ends fixed."""
    if len(points) < 3 or window < 1:
        return points
    out = points.copy()
    n = len(points)
    for i in range(1, n - 1):
        w = min(window, i, n - 1 - i)
        out[i] = points[i - w:i + w + 1].mean(axis=0)
    return out


def run_shape_skeleton(mesh, opts, progress=None) -> dict:
    t0 = time.time()

    def emit(frac, message):
        if progress:
            progress({"type": "progress", "stage": "skeleton", "frac": frac, "message": message})

    if len(mesh.faces) == 0:
        raise ValueError("The mesh has no faces.")
    size = float(np.max(mesh.extents))
    if not np.isfinite(size) or size <= 0:
        raise ValueError("The mesh has no extent.")
    pitch = size / int(opts.resolution)
    be = resolve_backend(opts.device)
    emit(0.05, "Voxelizing")
    dense, origin = bounded_surface_voxelize(mesh, pitch, 2.0, backend=be)
    emit(0.25, "Filling the interior")
    solid, close_used, interior_ratio = _solidify(dense, be, int(opts.close_iter))
    del dense
    ndi = be.ndi
    if opts.smooth > 0:
        sdf = ndi.distance_transform_edt(~solid).astype(be.xp.float32)
        sdf -= ndi.distance_transform_edt(solid).astype(be.xp.float32)
        sdf = ndi.gaussian_filter(sdf, float(opts.smooth))
        # A slight positive threshold keeps parts one or two voxels thin
        # (antennae, whiskers) that a symmetric blur would erase.
        solid = sdf < 0.35
        del sdf
    if opts.open_iter:
        # Opening deletes what is thinner than ~2*open_iter voxels: the robes,
        # capes, skirts and fins whose medial curves form webs with no
        # anatomy in them. Tubes (limbs, tails) are thicker and survive; tips
        # thinned away here are restored by the tip extension below.
        opened = ndi.binary_opening(solid, iterations=int(opts.open_iter))
        if int(opened.sum()) > 0.5 * int(solid.sum()):
            solid = opened
        del opened
    radius_field = be.tonumpy(ndi.distance_transform_edt(solid)).astype(np.float32)
    solid_np = be.tonumpy(solid).astype(bool)
    del solid
    emit(0.5, "Thinning to a skeleton")
    skel = skeletonize(solid_np)
    skel = skel.astype(bool)
    voxels = int(solid_np.sum())
    coords, nbrs = _graph_from_skeleton(skel)
    if len(coords) == 0:
        raise RuntimeError("The skeleton came out empty - the mesh may be too thin for this resolution.")
    radius = radius_field[coords[:, 0], coords[:, 1], coords[:, 2]].astype(np.float64)
    del radius_field
    emit(0.7, "Building the graph")
    g = _build_graph(coords, nbrs)
    spurs = _prune(g, coords, radius, float(opts.min_component), float(opts.spur_ratio), float(opts.spur_min))

    # Re-number densely and convert to model units.
    to_world = lambda vox: origin + (vox.astype(np.float64) + 0.5) * pitch  # noqa: E731
    node_ids = {nid: i for i, nid in enumerate(sorted(g.nodes))}
    nodes_out = []
    for nid, data in sorted(g.nodes.items()):
        vox = np.array(data["voxels"])
        p = to_world(coords[vox]).mean(axis=0)
        nodes_out.append({
            "id": node_ids[nid],
            "p": [round(float(x), 5) for x in p],
            "r": round(float(max(radius[v] for v in data["voxels"]) * pitch), 5),
            "degree": int(g.degree(nid)),
        })
    edges_out = []
    min_step = 1.5 * pitch
    for i, (eid, e) in enumerate(sorted(g.edges.items())):
        path = e["path"]
        sheet = _sheetness(solid_np, coords, radius, path)
        pts = to_world(coords[path])
        # Endpoints are the node centres, so paths meet exactly at junctions.
        pts[0] = nodes_out[node_ids[e["a"]]]["p"]
        pts[-1] = nodes_out[node_ids[e["b"]]]["p"]
        pts = _smooth(pts, 2)
        rad = radius[path] * pitch
        keep = [0]
        for k in range(1, len(pts) - 1):
            if np.linalg.norm(pts[k] - pts[keep[-1]]) >= min_step:
                keep.append(k)
        keep.append(len(pts) - 1)
        pts = pts[keep]
        rad = rad[keep]
        length = float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()) if len(pts) > 1 else 0.0
        edges_out.append({
            "id": i,
            "a": node_ids[e["a"]],
            "b": node_ids[e["b"]],
            "length": round(length, 5),
            "points": [[round(float(x), 5) for x in q] for q in pts],
            "radii": [round(float(r), 5) for r in rad],
            "sheet": round(float(sheet), 2),
        })
    # Thinning stops a radius or two short of every tip (and the smoothing
    # rounds tapered tips off), so a leg's skeleton ends above the floor and a
    # horn's short of its point. Extend each tip along its end direction to the
    # farthest surface vertex inside a narrow cylinder around that direction.
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    tree = cKDTree(verts)
    degree_of = {n["id"]: n["degree"] for n in nodes_out}
    extended = 0
    for e in edges_out:
        for at_end in (False, True):
            nid = e["b"] if at_end else e["a"]
            if degree_of.get(nid) != 1 or len(e["points"]) < 2:
                continue
            pts = np.asarray(e["points"] if at_end else e["points"][::-1], dtype=np.float64)
            tip = pts[-1]
            back = pts[max(0, len(pts) - 5)]
            direction = tip - back
            norm = np.linalg.norm(direction)
            if norm < 1e-9:
                continue
            direction /= norm
            r_tip = float(e["radii"][-1] if at_end else e["radii"][0])
            reach = 4.0 * (r_tip + 2.0 * pitch)
            idx = tree.query_ball_point(tip, reach)
            if not idx:
                continue
            rel = verts[idx] - tip
            along = rel @ direction
            lateral = np.linalg.norm(rel - np.outer(along, direction), axis=1)
            ok = (along > 0) & (lateral < 1.5 * (r_tip + 2.0 * pitch))
            if not np.any(ok):
                continue
            t = float(along[ok].max())
            if t < 0.5 * pitch:
                continue
            new_tip = tip + direction * t
            q = [round(float(x), 5) for x in new_tip]
            if at_end:
                e["points"].append(q)
                e["radii"].append(round(0.25 * r_tip, 5))
            else:
                e["points"].insert(0, q)
                e["radii"].insert(0, round(0.25 * r_tip, 5))
            e["length"] = round(e["length"] + t, 5)
            for n in nodes_out:
                if n["id"] == nid:
                    n["p"] = q
            extended += 1

    emit(1.0, "Done")
    return {
        "pitch": pitch,
        "origin": [float(x) for x in origin],
        "size": size,
        "nodes": nodes_out,
        "edges": edges_out,
        "stats": {
            "resolution": int(opts.resolution),
            "solidVoxels": voxels,
            "skeletonVoxels": int(len(coords)),
            "closeIterations": int(close_used),
            "interiorRatio": round(float(interior_ratio), 3),
            "filled": bool(interior_ratio > 0.5),
            "spursRemoved": int(spurs),
            "tipsExtended": int(extended),
            "backend": "gpu" if be.on_gpu else "cpu",
            "seconds": round(time.time() - t0, 2),
        },
    }
