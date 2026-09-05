"""Rebuild a garment's outer surface from its conformed inner surface.

This exists because of a limit that cannot be tuned around: A SMOOTH SPACE
DEFORMATION CANNOT CONTRACT A SURFACE AND PRESERVE ITS WALL THICKNESS.

Map a tube's inner wall from radius R to r and any smooth field scales the
neighbourhood by roughly r/R, so a wall of thickness t comes out at t*r/R. That
is true of every space-warp formulation -- a Kelvinlet, an FFD lattice, the
thin-plate spline in conform.py -- and it is why four successive attempts at a
purely field-based conform all thinned the shell:

    per-vertex projection   thickness -> 0      (piece fused onto the body)
    graph smoothing         shell stretched, 121 faces inverted
    spline over all verts   thickness -32%, and the lining pushed through
    spline over the inner
    surface only            conformed well (gap -77%) but STILL -32%

The thickness is not something to protect during the deformation; it has to be
RESTORED afterwards, from a measurement taken before. So:

  1. before conforming, pair every outer vertex with the point on the inner
     surface directly beneath it, and record how far apart they are -- that
     distance IS the local wall thickness;
  2. conform the inner surface only;
  3. put each outer vertex back at its paired point plus that same thickness,
     along the rebuilt inner surface's new normal.

Thickness is then preserved exactly, whatever the inner surface did, and the
lining cannot emerge through the outside because the outside is defined to be
outside it.
"""
from __future__ import annotations

import numpy as np
import trimesh


def pair_outer_to_inner(vertices, faces, inner_mask):
    """Pair each OUTER vertex with the inner surface beneath it.

    Returns None when the piece has no usable two-sided structure -- a solid
    shape, an open sheet, or a shell too broken to ray-cast -- in which case the
    caller should fall back to carrying the outer surface with the field.

    The pairing is a ray along the vertex's own inward normal. Barycentric
    coordinates rather than a nearest vertex, so the reconstruction follows the
    inner surface smoothly instead of snapping to its resolution.
    """
    outer_idx = np.flatnonzero(~inner_mask)
    if not len(outer_idx):
        return None

    # Only faces made entirely of inner vertices form the inner surface. A face
    # spanning both is part of the rim, and pairing to it would tie an outer
    # vertex to the piece's edge.
    inner_faces = faces[inner_mask[faces].all(axis=1)]
    if len(inner_faces) < 4:
        return None

    inner_mesh = trimesh.Trimesh(vertices, inner_faces, process=False)
    normals = np.asarray(trimesh.Trimesh(vertices, faces, process=False).vertex_normals)

    origins = vertices[outer_idx] - normals[outer_idx] * 1e-6
    directions = -normals[outer_idx]
    try:
        hits, ray_ids, tri_ids = inner_mesh.ray.intersects_location(
            origins, directions, multiple_hits=False)
    except Exception:  # noqa: BLE001 - pairing is best-effort
        return None
    if not len(ray_ids):
        return None

    thickness = np.linalg.norm(hits - origins[ray_ids], axis=1)

    # Barycentric coordinates of each hit within its inner triangle, so the
    # paired point can be re-evaluated after the triangle moves.
    tris = inner_faces[tri_ids]
    bary = trimesh.triangles.points_to_barycentric(vertices[tris], hits)

    return {
        'outer_idx': outer_idx[ray_ids],   # the outer vertices that got a pair
        'tri': tris,                       # their inner triangle, as vertex ids
        'bary': bary,
        'thickness': thickness,
    }


def rebuild_outer(vertices, pairing, min_thickness=0.0):
    """Place paired outer vertices at inner + thickness along the new normal.

    `vertices` must already hold the CONFORMED inner surface. Written in place
    for the paired vertices only; everything else is left as the caller put it.
    """
    if not pairing:
        return 0

    tris = pairing['tri']
    corners = vertices[tris]                     # (n, 3, 3)
    bary = pairing['bary'][:, :, None]

    # Where the paired point sits now that its triangle has moved.
    base = (corners * bary).sum(axis=1)

    # The moved triangle's normal, oriented AWAY from the inner surface — the
    # direction the wall should stand off in.
    edge1 = corners[:, 1] - corners[:, 0]
    edge2 = corners[:, 2] - corners[:, 0]
    normal = np.cross(edge1, edge2)
    lengths = np.linalg.norm(normal, axis=1)

    # A degenerate triangle has no usable normal; leave those vertices alone
    # rather than sending them to infinity.
    usable = lengths > 1e-12
    normal[usable] /= lengths[usable][:, None]

    # Point the normal at where the outer vertex currently is, so the wall is
    # rebuilt on the side it was already on regardless of winding.
    outward = vertices[pairing['outer_idx']] - base
    flip = np.einsum('ij,ij->i', normal, outward) < 0
    normal[flip] = -normal[flip]

    thickness = np.maximum(pairing['thickness'], min_thickness)
    rebuilt = base + normal * thickness[:, None]

    vertices[pairing['outer_idx'][usable]] = rebuilt[usable]
    return int(usable.sum())
