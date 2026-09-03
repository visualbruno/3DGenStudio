"""Mesh container and topology helpers for the AutoUV pipeline.

We keep this dependency-light: only numpy is required here. Loading/saving GLB
lives in io.py (which uses trimesh). Everything the unwrapper needs about the
connectivity of the mesh is computed once and cached on the Mesh object.
"""
from __future__ import annotations

import numpy as np


class Mesh:
    """A triangle mesh with cached topology.

    Attributes
    ----------
    vertices : (V, 3) float64
    faces    : (F, 3) int32
    """

    def __init__(self, vertices: np.ndarray, faces: np.ndarray):
        self.vertices = np.asarray(vertices, dtype=np.float64)
        self.faces = np.asarray(faces, dtype=np.int64)
        self._face_normals = None
        self._face_areas = None
        self._corner_groups = None
        self._corner_groups_key = None
        self._adjacency = None          # (E,2) face pairs sharing an edge
        self._adjacency_edges = None     # (E,2) the shared vertex pair
        self._adjacency_angle = None     # (E,) dihedral angle in radians
        self._components = None          # per-face component id

    # ------------------------------------------------------------------ basic
    @property
    def n_faces(self) -> int:
        return len(self.faces)

    @property
    def face_normals(self) -> np.ndarray:
        if self._face_normals is None:
            v = self.vertices[self.faces]
            n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
            ln = np.linalg.norm(n, axis=1, keepdims=True)
            ln[ln == 0] = 1.0
            self._face_normals = n / ln
        return self._face_normals

    @property
    def face_areas(self) -> np.ndarray:
        if self._face_areas is None:
            v = self.vertices[self.faces]
            cr = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
            self._face_areas = 0.5 * np.linalg.norm(cr, axis=1)
        return self._face_areas

    def corner_groups(self, smooth_angle_deg: float = 60.0):
        """Group face corners into smoothing groups on *this* topology.

        Returns ``(labels, normals)`` where ``labels`` is (F, 3) -- a group id per
        face corner, in face-corner order -- and ``normals`` is (G, 3), one unit
        normal per group.

        Two things have to be true at once, and computing normals per *vertex
        index* after the unwrapper splits vertices along seams cannot deliver
        either:

        * Across a UV seam, shading must be continuous. A seam is a texturing
          artifact, not a crease, so both copies of a seam vertex must average
          the same set of faces. Averaging after the split gives each copy only
          its own chart's faces, which reads as a hard crease tracing every chart
          boundary (worse the coarser the mesh: ~13 deg on a 320-face sphere
          against ~2 deg at 20k).
        * Across a genuinely sharp edge, shading must stay hard. Averaging
          everything at a vertex instead rounds a cube's corners into a blob.

        So two corners at the same vertex share a group only when a chain of
        edges below ``smooth_angle_deg`` connects their faces. A smooth surface
        puts every corner at a vertex in one group (seams vanish); a 90-degree
        edge keeps them apart (the edge stays hard). Grouping is a property of
        the geometry alone -- charts do not enter into it, which is exactly why
        the result is continuous across a seam.

        Weighting is the raw cross-product magnitude (twice the triangle area),
        matching three.js `computeVertexNormals` so the viewer and the service
        agree on what "smooth" means where nothing is sharp.
        """
        key = float(smooth_angle_deg)
        if self._corner_groups is not None and self._corner_groups_key == key:
            return self._corner_groups

        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components

        faces = self.faces
        n_faces = len(faces)
        v = self.vertices[faces]
        # Unnormalised: |cross| == 2 * area, so summing these is the area weighting.
        cross = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])

        # One node per face corner; node id == face * 3 + slot.
        n_nodes = n_faces * 3
        smooth = self.adjacency_angle < np.radians(key)
        pairs = self.adjacency[smooth]
        shared = self.adjacency_edges[smooth]

        rows, cols = [], []
        for end_i in range(2):  # a shared edge joins its two faces at both endpoints
            vid = shared[:, end_i]
            fa, fb = pairs[:, 0], pairs[:, 1]
            # Which slot of each face holds this vertex (it is always present).
            ka = np.argmax(faces[fa] == vid[:, None], axis=1)
            kb = np.argmax(faces[fb] == vid[:, None], axis=1)
            rows.append(fa * 3 + ka)
            cols.append(fb * 3 + kb)

        if rows and len(rows[0]):
            r = np.concatenate(rows)
            c = np.concatenate(cols)
            g = coo_matrix((np.ones(len(r)), (r, c)), shape=(n_nodes, n_nodes))
            n_groups, labels = connected_components(g + g.T, directed=False)
        else:
            n_groups, labels = n_nodes, np.arange(n_nodes)

        node_face = np.arange(n_nodes) // 3
        acc = np.zeros((n_groups, 3))
        np.add.at(acc, labels, cross[node_face])
        ln = np.linalg.norm(acc, axis=1, keepdims=True)
        ln[ln == 0] = 1.0

        self._corner_groups = (labels.reshape(n_faces, 3), acc / ln)
        self._corner_groups_key = key
        return self._corner_groups

    # ----------------------------------------------------------- adjacency
    def _build_adjacency(self):
        """Build face adjacency over shared edges plus dihedral angles."""
        faces = self.faces
        # For every face, its three undirected edges (sorted vertex pair).
        e0 = faces[:, [0, 1]]
        e1 = faces[:, [1, 2]]
        e2 = faces[:, [2, 0]]
        edges = np.concatenate([e0, e1, e2], axis=0)
        edges_sorted = np.sort(edges, axis=1)
        face_of_edge = np.tile(np.arange(len(faces)), 3)

        # Group identical edges. An interior manifold edge is shared by 2 faces.
        order = np.lexsort((edges_sorted[:, 1], edges_sorted[:, 0]))
        es = edges_sorted[order]
        fo = face_of_edge[order]

        same = np.all(es[1:] == es[:-1], axis=1)
        # indices i where es[i]==es[i+1] -> a shared edge between fo[i],fo[i+1]
        idx = np.nonzero(same)[0]
        fa = fo[idx]
        fb = fo[idx + 1]
        shared_edges = es[idx]

        normals = self.face_normals
        dots = np.einsum("ij,ij->i", normals[fa], normals[fb])
        dots = np.clip(dots, -1.0, 1.0)
        ang = np.arccos(dots)

        self._adjacency = np.stack([fa, fb], axis=1)
        self._adjacency_edges = shared_edges
        self._adjacency_angle = ang

    @property
    def adjacency(self) -> np.ndarray:
        if self._adjacency is None:
            self._build_adjacency()
        return self._adjacency

    @property
    def adjacency_edges(self) -> np.ndarray:
        if self._adjacency_edges is None:
            self._build_adjacency()
        return self._adjacency_edges

    @property
    def adjacency_angle(self) -> np.ndarray:
        if self._adjacency_angle is None:
            self._build_adjacency()
        return self._adjacency_angle

    # --------------------------------------------------------- components
    @property
    def components(self) -> np.ndarray:
        """Connected-component id per face (over the adjacency graph)."""
        if self._components is None:
            from scipy.sparse import csr_matrix
            from scipy.sparse.csgraph import connected_components

            adj = self.adjacency
            n = self.n_faces
            if len(adj) == 0:
                self._components = np.arange(n)
            else:
                data = np.ones(len(adj))
                g = csr_matrix(
                    (data, (adj[:, 0], adj[:, 1])), shape=(n, n)
                )
                g = g + g.T
                _, labels = connected_components(g, directed=False)
                self._components = labels
        return self._components
