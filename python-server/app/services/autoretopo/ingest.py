"""Stage 0 - ingest & repair.

Loads any trimesh-supported file (glb/gltf/obj/ply/stl...), flattens a scene to a
single mesh, welds coincident vertices, drops degenerate/duplicate faces and
fixes winding. The cleaned mesh is the *projection target* for later stages; we
deliberately do NOT try to make it watertight here, because the watertight shell
stage is far more robust to the fragmented "triangle soup" that AI generators emit.
"""
from __future__ import annotations
import numpy as np
import trimesh


def load_mesh(path: str) -> trimesh.Trimesh:
    scene = trimesh.load(path, force="scene")
    geoms = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh) and len(g.faces)]
    if not geoms:
        raise ValueError(f"No triangle geometry found in {path}")
    mesh = trimesh.util.concatenate(geoms) if len(geoms) > 1 else geoms[0].copy()
    return repair(mesh)


def repair(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    mesh = mesh.copy()
    mesh.merge_vertices()                 # weld coincident verts (closes unwelded cracks)
    mesh.remove_duplicate_faces() if hasattr(mesh, "remove_duplicate_faces") else None
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    try:
        mesh.fix_normals()                # consistent winding where possible
    except Exception:
        pass
    return mesh


def mesh_stats(mesh: trimesh.Trimesh) -> dict:
    from .meshutil import num_components
    return {
        "vertices": int(len(mesh.vertices)),
        "faces": int(len(mesh.faces)),
        "components": int(num_components(mesh.vertices, mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "bbox_diagonal": float(np.linalg.norm(mesh.extents)),
        "extents": [float(x) for x in mesh.extents],
    }
