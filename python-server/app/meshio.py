"""Mesh load/export helpers built on trimesh.

The editor speaks GLB natively, so GLB is the default exchange format. OBJ is
also accepted on input. Keep all format knowledge in this module so the route
handlers and services stay format-agnostic.
"""
from __future__ import annotations

import io
from pathlib import Path

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
