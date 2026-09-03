"""GLB/OBJ I/O via trimesh. Kept separate so the core stays dependency-light."""
from __future__ import annotations

import numpy as np
import trimesh

from .mesh import Mesh


def load(path: str) -> Mesh:
    scene = trimesh.load(path, process=True)
    if isinstance(scene, trimesh.Scene):
        geoms = list(scene.geometry.values())
        if not geoms:
            raise ValueError("no geometry in file")
        # concatenate all geometries into one mesh
        m = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0]
    else:
        m = scene
    return Mesh(np.asarray(m.vertices), np.asarray(m.faces))


def save_glb(path, vertices, faces, uv, normals=None):
    """Write a GLB with a vertex UV channel and a checker material.

    Pass `normals` (the unwrap result's pre-split smooth normals) whenever you
    have them: trimesh only emits a glTF NORMAL accessor when vertex_normals is
    populated, and without one the reader recomputes normals per index, creasing
    every seam-split chart boundary. See autouv.mesh.Mesh.corner_groups.
    """
    mesh = trimesh.Trimesh(
        vertices=vertices, faces=faces, vertex_normals=normals, process=False
    )
    mesh.visual = trimesh.visual.TextureVisuals(
        uv=np.asarray(uv),
        material=trimesh.visual.material.PBRMaterial(name="autouv"),
    )
    mesh.export(path)
    return path
