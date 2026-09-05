"""Find the base-body faces that armour hides, so they can be deleted.

A fully-armoured character carries a whole body's worth of triangles nobody will
ever see. Removing them is free polygon budget -- but only if "never seen" is
established honestly.

---- Why ray visibility, and not an inside/outside test ------------------------

The tempting formulation is "is this body face inside the garment's volume",
via signed distance or a winding number. This codebase has already learned not
to trust that: the meshes it deals with come from marching cubes and splat
conversion and are routinely NOT watertight, which is the entire reason
assemblyfit/conform.py carries median-sign-vote machinery instead of calling
trimesh.contains.

Ray visibility asks the question actually being asked -- can you see it -- and
does not care whether anything is watertight. It also handles the cases an
inside/outside test gets wrong for free: chainmail's holes let rays escape, so
those faces are kept; a loose cape occludes almost nothing, so almost nothing is
deleted.

---- What counts as a blocker ------------------------------------------------

Only GARMENT geometry. Body-on-body hits are deliberately ignored, because
"hidden by the body itself" describes the armpits and the crotch: invisible at
rest and very visible the moment the character moves. Same reasoning drives the
erosion pass below, and the pose sampling described in `pose_samples`.

---- What comes back ----------------------------------------------------------

A per-face mask, not a mesh. Deleting faces changes the vertex count, so a mesh
round trip would break the positions-only contract every other assembly route
relies on -- and, more decisively, the base is usually RIGGED, and trimesh
cannot carry skinIndex/skinWeight through a load at all. The client applies the
mask to its own geometry and keeps every attribute.
"""
from __future__ import annotations

import base64
import time

import numpy as np
import trimesh

from .assemblyfit.conform import weld_map


def _hemisphere_directions(count, generator):
    """Cosine-weighted directions in the +Z hemisphere.

    Cosine-weighted rather than uniform because visibility is what an observer
    sees, and grazing directions contribute proportionally less of the surface's
    apparent area. It also concentrates samples where occlusion actually decides
    the answer.
    """
    samples = generator.random((count, 2))
    radius = np.sqrt(samples[:, 0])
    theta = 2.0 * np.pi * samples[:, 1]
    z = np.sqrt(np.maximum(0.0, 1.0 - samples[:, 0]))
    return np.stack([radius * np.cos(theta), radius * np.sin(theta), z], axis=1)


def _basis_from_normal(normals):
    """An orthonormal frame per normal, for orienting the hemisphere samples."""
    # Pick a helper axis that is never parallel to the normal.
    helper = np.tile(np.array([0.0, 0.0, 1.0]), (len(normals), 1))
    parallel = np.abs(normals[:, 2]) > 0.9
    helper[parallel] = np.array([1.0, 0.0, 0.0])

    tangent = np.cross(helper, normals)
    tangent /= np.maximum(np.linalg.norm(tangent, axis=1, keepdims=True), 1e-12)
    bitangent = np.cross(normals, tangent)
    return tangent, bitangent


def _face_adjacency(vertices, faces):
    """Face pairs sharing an edge, computed over WELDED vertices.

    The client sends the body as its submeshes concatenated and unwelded, so on
    raw indices every UV seam is a topological cut and the mesh looks like
    thousands of disconnected fragments. Eroding across that would do nothing at
    the seams -- exactly where a hole is most visible.
    """
    groups, _count = weld_map(vertices)
    welded = groups[faces]

    edges = np.vstack([welded[:, [0, 1]], welded[:, [1, 2]], welded[:, [2, 0]]])
    edges = np.sort(edges, axis=1)
    face_ids = np.tile(np.arange(len(faces)), 3)

    order = np.lexsort((edges[:, 1], edges[:, 0]))
    edges = edges[order]
    face_ids = face_ids[order]

    same = np.all(edges[1:] == edges[:-1], axis=1)
    return np.stack([face_ids[:-1][same], face_ids[1:][same]], axis=1)


def _erode(hidden, adjacency, rings):
    """Un-hide any hidden face touching a visible one, `rings` times over.

    The safety margin. It costs a little of the saving and buys the boundary
    some slack against everything this test cannot see coming: the garment
    shifting against the skin when the character is posed, alpha-cut edges, and
    the plain fact that a hole at the edge of a coverage region is far more
    noticeable than one in the middle.
    """
    if not rings or not len(adjacency):
        return hidden
    result = hidden.copy()
    for _ in range(int(rings)):
        a, b = adjacency[:, 0], adjacency[:, 1]
        # A hidden face adjacent to a visible one becomes visible.
        exposed = np.zeros(len(result), dtype=bool)
        exposed[a[~result[b]]] = True
        exposed[b[~result[a]]] = True
        nxt = result & ~exposed
        if np.array_equal(nxt, result):
            break
        result = nxt
    return result


def find_hidden_faces(body_mesh, occluder_mesh, *,
                      rays=16,
                      max_distance_ratio=0.08,
                      ray_length_ratio=2.0,
                      erode_rings=1,
                      offset_ratio=1e-4,
                      device='auto',
                      seed=7,
                      progress=None):
    """Which faces of `body_mesh` are completely hidden by `occluder_mesh`.

    Both meshes must already be in ONE SHARED WORLD SPACE, as everywhere else in
    the assembly pipeline.

    Returns (mask, stats). `mask[i]` is True for a face that should be deleted.
    """
    started = time.perf_counter()
    V = np.asarray(body_mesh.vertices, dtype=np.float64)
    F = np.asarray(body_mesh.faces)
    stats = {'faces_total': int(len(F)), 'candidates': 0, 'hidden_raw': 0,
             'hidden': 0, 'rays': int(rays)}

    if not len(F) or not len(occluder_mesh.faces):
        return np.zeros(len(F), dtype=bool), stats

    diagonal = float(np.linalg.norm(body_mesh.bounds[1] - body_mesh.bounds[0]))
    centroids = V[F].mean(axis=1)
    normals = np.asarray(body_mesh.face_normals)

    # ---- 1. prune by bounding box ----------------------------------------
    # A BOX, not a distance. The obvious prune is "faces within D of the
    # armour", but a closest-point query over a whole body costs more than the
    # thing it is protecting: measured on a 196k-face body, the CPU proximity
    # query took 15.0s while casting rays for EVERY face takes about 0.4s at
    # embree's ~8M rays/s. So the cheap test is the right one, and the rays do
    # the rest.
    if progress:
        progress(0.05, 'Finding covered areas')
    margin = max_distance_ratio * diagonal
    low = np.asarray(occluder_mesh.bounds[0]) - margin
    high = np.asarray(occluder_mesh.bounds[1]) + margin
    candidates = np.flatnonzero(
        np.all((centroids >= low) & (centroids <= high), axis=1))
    stats['candidates'] = int(len(candidates))
    if not len(candidates):
        stats['seconds'] = time.perf_counter() - started
        return np.zeros(len(F), dtype=bool), stats

    # ---- 2. cast ---------------------------------------------------------
    generator = np.random.default_rng(seed)
    local = _hemisphere_directions(rays, generator)
    tangent, bitangent = _basis_from_normal(normals[candidates])

    origins = centroids[candidates] + normals[candidates] * (offset_ratio * diagonal)
    reach = ray_length_ratio * diagonal

    blocked = np.zeros(len(candidates), dtype=np.int32)
    for index in range(rays):
        if progress:
            progress(0.1 + 0.8 * (index / rays), f'Casting rays {index + 1}/{rays}')
        direction = (tangent * local[index, 0]
                     + bitangent * local[index, 1]
                     + normals[candidates] * local[index, 2])
        direction /= np.maximum(np.linalg.norm(direction, axis=1, keepdims=True), 1e-12)
        hit = occluder_mesh.ray.intersects_any(origins, direction)
        blocked += hit.astype(np.int32)

    # Every ray blocked, or the face is visible from somewhere.
    hidden = np.zeros(len(F), dtype=bool)
    hidden[candidates] = blocked >= rays
    stats['hidden_raw'] = int(hidden.sum())
    stats['reach'] = reach

    # ---- 3. erode --------------------------------------------------------
    if progress:
        progress(0.95, 'Keeping a margin')
    hidden = _erode(hidden, _face_adjacency(V, F), erode_rings)

    stats['hidden'] = int(hidden.sum())
    stats['kept'] = int(len(F) - hidden.sum())
    stats['percent'] = round(100.0 * hidden.sum() / max(len(F), 1), 2)
    stats['seconds'] = time.perf_counter() - started
    return hidden, stats


def run_hidden_faces(body_mesh, occluder_mesh, options, progress=None):
    """Route bridge: run the search and build the terminal `done` payload.

    Carries a MASK, not geometry — one byte per face of the body as uploaded, in
    the same face order. See the module header for why it cannot be a mesh.
    """
    def emit(frac, message=''):
        if progress:
            progress('hidden', frac, message)

    mask, stats = find_hidden_faces(
        body_mesh, occluder_mesh,
        rays=options.rays,
        max_distance_ratio=options.max_distance_ratio,
        erode_rings=options.erode_rings,
        device=options.device,
        progress=emit,
    )
    emit(1.0, 'Done')
    return {
        'format': 'face_mask',
        'mask_b64': base64.b64encode(mask.astype(np.uint8).tobytes()).decode('ascii'),
        'count': int(len(mask)),
        'stats': stats,
    }
