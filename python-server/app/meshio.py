"""Mesh load/export helpers built on trimesh.

The editor speaks GLB natively, so GLB is the default exchange format. OBJ is
also accepted on input. Keep all format knowledge in this module so the route
handlers and services stay format-agnostic.
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import trimesh

from .schemas import MeshStats

# Extensions we know how to load on input.
SUPPORTED_INPUT_EXTS = {".glb", ".gltf", ".obj", ".ply", ".stl"}


def load_mesh(data: bytes, filename: str) -> trimesh.Trimesh:
    """Load a single mesh from raw bytes.

    Scenes (multi-mesh GLBs) are concatenated into one mesh so downstream tools
    receive a single Trimesh. Adjust if your scripts need the scene graph.
    """
    ext = Path(filename or "mesh.glb").suffix.lower() or ".glb"
    if ext not in SUPPORTED_INPUT_EXTS:
        raise ValueError(f"Unsupported input format '{ext}'. Supported: {sorted(SUPPORTED_INPUT_EXTS)}")

    file_type = ext.lstrip(".")
    loaded = trimesh.load(io.BytesIO(data), file_type=file_type, process=False)

    if isinstance(loaded, trimesh.Scene):
        if len(loaded.geometry) == 0:
            raise ValueError("The uploaded file contains no geometry.")
        loaded = trimesh.util.concatenate(tuple(loaded.geometry.values()))

    if not isinstance(loaded, trimesh.Trimesh):
        raise ValueError("The uploaded file did not resolve to a triangle mesh.")

    return loaded


def load_mesh_vertex_normals(data: bytes, filename: str):
    """The vertex normals the FILE carried, aligned to `load_mesh`'s vertex order.

    None when the file shipped no normals (or any geometry in a multi-mesh file
    lacks them, since a partial channel cannot be aligned).

    Why this is separate from `load_mesh`: trimesh only keeps file normals in its
    cache, and `trimesh.util.concatenate` drops the cache -- so `load_mesh`
    silently loses them even for a single-geometry file. Setting them back onto
    the concatenated mesh is not an option either: a populated `vertex_normals`
    cache is exactly what makes trimesh emit a glTF NORMAL accessor on export, so
    every tool that *changes* topology (repair, retopo) would start shipping
    stale normals. Auto UV asks for them explicitly instead, because it is the
    one tool that preserves the shape and so must preserve the shading.
    """
    ext = Path(filename or "mesh.glb").suffix.lower() or ".glb"
    if ext not in SUPPORTED_INPUT_EXTS:
        return None
    try:
        loaded = trimesh.load(io.BytesIO(data), file_type=ext.lstrip("."), process=False)
    except Exception:  # noqa: BLE001 — load_mesh already reports real load errors
        return None

    geoms = (list(loaded.geometry.values()) if isinstance(loaded, trimesh.Scene)
             else [loaded])
    parts = []
    for geom in geoms:
        if not isinstance(geom, trimesh.Trimesh):
            return None
        # Read the cache directly: touching `.vertex_normals` would *compute*
        # them, which is the opposite of what we are asking.
        cached = geom._cache.cache.get("vertex_normals")
        if cached is None or len(cached) != len(geom.vertices):
            return None
        parts.append(np.asarray(cached, dtype=np.float64))

    return np.concatenate(parts, axis=0) if parts else None


def load_scene(data: bytes, filename: str) -> trimesh.Scene:
    """Load raw bytes as a Scene, preserving the material/node structure.

    `load_mesh` concatenates multi-mesh files into a single Trimesh, which throws
    away exactly the information the Game-Ready check needs to report (how many
    draw calls and textures the asset costs). Use this when that structure
    matters; use `load_mesh` for tools that only care about geometry. A file that
    resolves to a lone mesh is wrapped in a one-geometry Scene so callers always
    get the same type back.
    """
    ext = Path(filename or "mesh.glb").suffix.lower() or ".glb"
    if ext not in SUPPORTED_INPUT_EXTS:
        raise ValueError(f"Unsupported input format '{ext}'. Supported: {sorted(SUPPORTED_INPUT_EXTS)}")

    loaded = trimesh.load(io.BytesIO(data), file_type=ext.lstrip("."), process=False)

    if isinstance(loaded, trimesh.Scene):
        if len(loaded.geometry) == 0:
            raise ValueError("The uploaded file contains no geometry.")
        return loaded

    if not isinstance(loaded, trimesh.Trimesh):
        raise ValueError("The uploaded file did not resolve to a triangle mesh.")

    return trimesh.Scene(loaded)


def scene_to_mesh(scene: trimesh.Scene) -> trimesh.Trimesh:
    """Flatten a Scene into one Trimesh in **world space**.

    Unlike `load_mesh` (which concatenates the raw geometries and so ignores node
    transforms), this applies the scene graph. Inspection reports on the asset as
    an engine would import it, so a mesh parented under a scaled/offset node must
    be measured where it actually lands — otherwise the scale and pivot checks
    read the wrong numbers.
    """
    if len(scene.geometry) == 0:
        raise ValueError("The scene contains no geometry.")
    try:
        dumped = scene.dump(concatenate=True)
        if isinstance(dumped, trimesh.Trimesh):
            return dumped
    except Exception:  # noqa: BLE001 — fall back to the transform-free concatenation
        pass
    return trimesh.util.concatenate(tuple(scene.geometry.values()))


def export_mesh(mesh: trimesh.Trimesh, fmt: str = "glb") -> bytes:
    """Serialize a mesh to bytes in the requested format (default GLB)."""
    fmt = (fmt or "glb").lstrip(".").lower()
    exported = mesh.export(file_type=fmt)
    return exported if isinstance(exported, (bytes, bytearray)) else str(exported).encode("utf-8")


def mesh_stats(mesh: trimesh.Trimesh) -> MeshStats:
    has_uv = bool(getattr(getattr(mesh, "visual", None), "uv", None) is not None)
    return MeshStats(
        vertex_count=int(len(mesh.vertices)),
        face_count=int(len(mesh.faces)),
        has_uv=has_uv,
    )
