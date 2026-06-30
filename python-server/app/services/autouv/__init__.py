"""AutoUV: a low-poly-focused automatic UV unwrapper.

Public API
----------
    from autouv import load, unwrap, save_glb, render_uv
"""
from .mesh import Mesh
from .io import load, save_glb
from .unwrap import unwrap, UnwrapResult
from .render import render_uv

__all__ = ["Mesh", "load", "save_glb", "unwrap", "UnwrapResult", "render_uv"]
__version__ = "0.1.0"
