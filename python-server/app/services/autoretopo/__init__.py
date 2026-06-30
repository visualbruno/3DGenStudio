"""autoretopo - automatic retopology for low-poly meshes.

Generates a clean, watertight, silhouette-following topology layer over a messy
(often AI-generated) input mesh, without manual work.
"""
from .config import RetopoConfig
from .pipeline import AutoRetopo, RetopoResult

__all__ = ["AutoRetopo", "RetopoResult", "RetopoConfig"]
__version__ = "0.1.0"
