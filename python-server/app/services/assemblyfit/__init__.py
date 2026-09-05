"""Assembly fitting: adapt an AI-generated garment to an AI-generated body.

Bundled as a package with its own CLI, the same shape as services/autouv and
services/autoretopo, so each stage can be run and graded from the terminal
without the browser or the HTTP layer:

    python -m app.services.assemblyfit body.glb armor.glb -o fitted.glb

The pipeline never changes the piece's vertex count or order. See conform.py.
"""
from .config import FitConfig
from .pipeline import fit_assembly

__all__ = ['FitConfig', 'fit_assembly']
