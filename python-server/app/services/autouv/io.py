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


def save_glb(path, vertices, faces, uv):
    """Write a GLB with a vertex UV channel and a checker material."""
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.visual = trimesh.visual.TextureVisuals(
        uv=np.asarray(uv),
        material=trimesh.visual.material.PBRMaterial(name="autouv"),
    )
    mesh.export(path)
    return path
