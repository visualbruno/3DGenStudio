"""Stage 3 - silhouette projection ("walk the surface, don't just shrinkwrap").

The shell+remesh result has clean topology but rides slightly outside the true
surface and rounds sharp features. We pull it back onto the *original* surface
while keeping the topology and watertightness intact.

Each iteration:
  1. Tangential relaxation: move every vertex toward its neighbours' centroid, but
     remove the component along the vertex normal so the vertex slides *along* the
     surface rather than sinking into it. This is the "Relax" behaviour from manual
     retopo tools - it evens out quad/triangle spacing without denting the form.
  2. Clamped closest-point snap: project each vertex onto the nearest point of the
     original surface, but cap the move at `clamp x local_edge_length`. The clamp is
     what makes this robust on fragmented input: a vertex can never be yanked across
     a gap onto a distant internal shell, which is the classic failure of naive
     shrinkwrap.

Because connectivity never changes, a watertight input stays watertight.
"""
from __future__ import annotations
import numpy as np
import trimesh


def _vertex_adjacency(n_verts, F):
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e = np.vstack([e, e[:, ::-1]])
    nbr = [[] for _ in range(n_verts)]
    for a, b in e:
        nbr[a].append(b)
    return [np.unique(np.asarray(n, int)) for n in nbr]


def _vertex_edge_length(V, F):
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    d = np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1)
    s = np.zeros(len(V)); c = np.zeros(len(V))
    np.add.at(s, e[:, 0], d); np.add.at(s, e[:, 1], d)
    np.add.at(c, e[:, 0], 1.0); np.add.at(c, e[:, 1], 1.0)
    return s / np.maximum(c, 1.0)


def _tangential_relax(V, F, normals, adjacency, strength):
    Q = V.copy()
    for i, nb in enumerate(adjacency):
        if len(nb) == 0:
            continue
        d = V[nb].mean(0) - V[i]
        d = d - normals[i] * np.dot(d, normals[i])   # project onto tangent plane
        Q[i] = V[i] + strength * d
    return Q


def project_to_surface(V, F, target_mesh, iters=10, clamp=1.5, relax_strength=0.4):
    pq = trimesh.proximity.ProximityQuery(target_mesh)
    adjacency = _vertex_adjacency(len(V), F)
    Vc = np.asarray(V, float).copy()
    for _ in range(int(iters)):
        normals = trimesh.Trimesh(Vc, F, process=False).vertex_normals
        Vc = _tangential_relax(Vc, F, normals, adjacency, relax_strength)
        elen = _vertex_edge_length(Vc, F)
        closest, _, _ = pq.on_surface(Vc)
        move = closest - Vc
        mlen = np.linalg.norm(move, axis=1) + 1e-12
        scale = np.minimum(1.0, (clamp * elen) / mlen)
        Vc = Vc + move * scale[:, None]
    return np.ascontiguousarray(Vc)
