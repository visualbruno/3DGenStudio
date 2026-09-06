"""Optional watertight junction resolution (`bark.junction_mode = 'clean'`).

The default 'sink' mode does not boolean anything: child branches start inside
the parent's hull and the bark texture hides the intersection. That is the right
default -- it is free, it keeps the analytic UVs exactly, and for a rendered
tree nobody can tell.

Some callers genuinely need a closed surface though (3D printing, CSG, physics
cooking, volume queries), and this is that path. It turned out to be far cheaper
than the plan assumed: the tubes are already closed volumes individually, so
manifold3d unions ~900 of them in about half a second. The old wisdom that
booleans on a tree are a multi-week sinkhole was about mesh-boolean libraries
that no longer represent the state of the art.

What it costs is the UVs. A boolean rewrites the topology, so the swept
parameterization is gone and has to be re-derived -- which this module does by
projecting each result vertex back onto the nearest skeleton node's frame, then
splitting the triangles that straddle the u wrap.
"""
from __future__ import annotations

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from .bark import _branch_phase, _tangents, rotation_minimizing_frames
from .skeleton import TreeSkeleton
from .spec import TreeSpec

_EPS = 1e-12
_TWO_PI = 2.0 * np.pi


def _node_frames(skeleton: TreeSkeleton):
    """Per-node tangent and reference vector, taken from each chain's RMF.

    Nodes shared between chains (a fork node belongs to its parent chain and
    starts each child chain) are written more than once; last write wins, which
    is fine -- the frames only set the u origin, and any consistent choice does.
    """
    count = len(skeleton.positions)
    tangent = np.tile(np.array([0.0, 1.0, 0.0]), (count, 1))
    reference = np.tile(np.array([1.0, 0.0, 0.0]), (count, 1))

    for chain in skeleton.chains:
        if len(chain) < 2:
            continue
        points = skeleton.positions[chain]
        chain_tangents = _tangents(points)
        chain_reference = rotation_minimizing_frames(points, chain_tangents)
        tangent[chain] = chain_tangents
        reference[chain] = chain_reference

    return tangent, reference


def _split_uv_seam(vertices, faces, uvs, normals, wind):
    """Duplicate the vertices of triangles that straddle the u wrap.

    A cylindrical projection puts u=0.99 and u=0.01 either side of the seam; a
    triangle spanning both interpolates backwards across the entire texture and
    renders as a smeared band. The fix is the standard one: for each straddling
    face, give it its own copies of the low-u vertices shifted by +1.
    """
    if len(faces) == 0:
        return vertices, faces, uvs, normals, wind

    u = uvs[:, 0]
    face_u = u[faces]
    straddles = (face_u.max(axis=1) - face_u.min(axis=1)) > 0.5
    if not np.any(straddles):
        return vertices, faces, uvs, normals, wind

    faces = faces.copy()
    extra_vertices, extra_uvs, extra_normals, extra_wind = [], [], [], []
    next_index = len(vertices)
    # Cache per (vertex, shifted) so a vertex shared by several straddling faces
    # is duplicated once rather than once per face.
    duplicate: dict[int, int] = {}

    for face_index in np.flatnonzero(straddles):
        for corner in range(3):
            vertex = int(faces[face_index, corner])
            if u[vertex] >= 0.5:
                continue
            existing = duplicate.get(vertex)
            if existing is None:
                extra_vertices.append(vertices[vertex])
                extra_uvs.append([u[vertex] + 1.0, uvs[vertex, 1]])
                extra_normals.append(normals[vertex])
                extra_wind.append(wind[vertex])
                existing = next_index
                duplicate[vertex] = existing
                next_index += 1
            faces[face_index, corner] = existing

    vertices = np.concatenate([vertices, np.asarray(extra_vertices)], axis=0)
    uvs = np.concatenate([uvs, np.asarray(extra_uvs)], axis=0)
    normals = np.concatenate([normals, np.asarray(extra_normals)], axis=0)
    wind = np.concatenate([wind, np.asarray(extra_wind)], axis=0)
    return vertices, faces, uvs, normals, wind


def clean_junctions(spec: TreeSpec, skeleton: TreeSkeleton, vertices, faces,
                    on_progress=None):
    """Union the swept tubes into one watertight surface and re-derive its UVs.

    Returns (vertices, faces, normals, uvs, wind, stats). Falls back to the input
    unchanged (with `stats['fallback']` set) whenever the boolean is unavailable
    or refuses the input -- a tree that failed to become watertight is still a
    perfectly good tree, and this must never be the difference between getting a
    mesh and getting an error.
    """
    def emit(frac, message):
        if on_progress is not None:
            on_progress(frac, message)

    stats: dict = {"mode": "clean"}
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    # Weld the duplicated UV seam vertices: each tube is a rolled-up sheet until
    # this runs, and manifold3d rejects anything that is not a closed volume.
    mesh.merge_vertices()

    emit(0.1, "Splitting branch components")
    parts = mesh.split(only_watertight=False)
    if len(parts) == 0:
        parts = [mesh]
    solids = [p for p in parts if p.is_volume]
    loose = [p for p in parts if not p.is_volume]
    stats["components"] = int(len(parts))
    stats["non_volume_components"] = int(len(loose))

    if not solids:
        stats["fallback"] = "no closed branch components to union"
        return _reproject(spec, skeleton, vertices, faces, stats)

    emit(0.35, f"Union of {len(solids)} branches")
    try:
        united = trimesh.boolean.union(solids, engine="manifold")
    except Exception as exc:  # noqa: BLE001 -- reported, never fatal
        stats["fallback"] = f"boolean union failed ({type(exc).__name__}: {exc})"
        return _reproject(spec, skeleton, vertices, faces, stats)

    if loose:
        # Open shells cannot take part in a boolean, but dropping them would
        # silently delete branches. Carry them through untouched.
        united = trimesh.util.concatenate([united] + loose)

    # Named for what it measures: the boolean's own result. The mesh handed back
    # is NOT index-level watertight, because the UV seam split below re-splits
    # vertices along the wrap -- exactly as every UV'd cylinder does. Weld by
    # position and it closes.
    stats["union_watertight"] = bool(united.is_watertight)
    stats["faces_before"] = int(len(faces))
    stats["faces_after"] = int(len(united.faces))

    emit(0.75, "Re-deriving UVs")
    return _reproject(spec, skeleton, np.asarray(united.vertices), np.asarray(united.faces), stats)


def _reproject(spec: TreeSpec, skeleton: TreeSkeleton, vertices, faces, stats):
    """Cylindrical UVs, wind data and normals for a mesh with rewritten topology."""
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)

    tangent, reference = _node_frames(skeleton)
    tree = cKDTree(skeleton.positions)
    _, nearest = tree.query(vertices, k=1)
    nearest = np.asarray(nearest, dtype=np.int64)

    offset = vertices - skeleton.positions[nearest]
    node_tangent = tangent[nearest]
    node_reference = reference[nearest]
    node_binormal = np.cross(node_tangent, node_reference)

    along = np.sum(offset * node_tangent, axis=1)
    radial = offset - node_tangent * along[:, None]
    angle = np.arctan2(np.sum(radial * node_binormal, axis=1),
                       np.sum(radial * node_reference, axis=1))

    tile = max(float(spec.bark.uv_tile), 1e-6)
    u = (angle / _TWO_PI) % 1.0
    # Include the along-tangent offset so v stays continuous between nodes
    # instead of stepping at every nearest-node boundary.
    v = (skeleton.arclength[nearest] + along) / tile
    uvs = np.stack([u, v], axis=1)

    max_arclength = float(skeleton.arclength.max()) if len(skeleton.arclength) else 1.0
    max_order = max(int(skeleton.order.max()), 1) if len(skeleton.order) else 1
    if spec.output.wind_colors:
        phase = np.array([_branch_phase(int(c)) for c in skeleton.chain_of_node[nearest]])
        wind = np.stack([
            phase,
            1.0 - np.clip(skeleton.arclength[nearest] / max(max_arclength, _EPS), 0.0, 1.0),
            np.zeros(len(vertices)),
            skeleton.order[nearest] / max_order,
        ], axis=1)
    else:
        wind = np.zeros((len(vertices), 4))

    # Area-weighted smooth normals. The boolean creates real creases where
    # branches meet, and these average across them -- acceptable for a mode
    # whose whole point is a closed solid rather than a beauty render.
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    normals = np.asarray(mesh.vertex_normals, dtype=np.float64)

    vertices, faces, uvs, normals, wind = _split_uv_seam(vertices, faces, uvs, normals, wind)
    stats["vertices"] = int(len(vertices))
    stats["faces"] = int(len(faces))
    return vertices, faces, normals, uvs, wind, stats
