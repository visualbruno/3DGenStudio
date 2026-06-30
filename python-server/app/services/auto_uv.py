"""Auto UV unwrap — bridges the FastAPI route to the bundled `autouv` package.

The route hands us a loaded trimesh.Trimesh; we run autouv.unwrap on its
geometry and hand back a trimesh.Trimesh that carries the new UV channel, plus
the unwrap stats dict for the UI.
"""
from __future__ import annotations

import os
import tempfile

import numpy as np
import trimesh

from ..config import WORK_DIR
from ..schemas import AutoUvOptions
from . import autouv


def _render_uv_preview(result) -> bytes | None:
    """Render the packed UV atlas to a PNG and return its bytes (None on failure).

    autouv.render_uv writes to a path, so we go through a temp file in WORK_DIR.
    Failures (e.g. matplotlib missing) are non-fatal — the unwrap still succeeds.
    """
    path = None
    try:
        fd, path = tempfile.mkstemp(suffix=".png", dir=str(WORK_DIR))
        os.close(fd)
        autouv.render_uv(result, path, size=512)
        with open(path, "rb") as f:
            return f.read()
    except Exception:  # noqa: BLE001 — preview is best-effort
        return None
    finally:
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass


def run_auto_uv(mesh: trimesh.Trimesh, options: AutoUvOptions) -> tuple[trimesh.Trimesh, dict, bytes | None]:
    src = autouv.Mesh(np.asarray(mesh.vertices), np.asarray(mesh.faces))

    result = autouv.unwrap(
        src,
        max_cone_deg=options.max_cone_deg,
        sharp_weight=options.sharp_weight,
        min_faces=options.min_faces,
        min_area_frac=options.min_area_frac,
        fold_cap_deg=options.fold_cap_deg,
        refine=options.refine,
        refine_target_faces=options.refine_target_faces,
        refine_ad_thresh=options.refine_ad_thresh,
        resolution=options.resolution,
        padding_texels=options.padding_texels,
        method=options.method,
        arap_iters=options.arap_iters,
        weld=options.weld,
        weld_tol_frac=options.weld_tol_frac,
        verbose=False,
    )

    # Build a GLB-ready mesh with the new vertex UV channel (seam-split geometry).
    out = trimesh.Trimesh(vertices=result.vertices, faces=result.faces, process=False)
    out.visual = trimesh.visual.TextureVisuals(
        uv=np.asarray(result.uv),
        material=trimesh.visual.material.PBRMaterial(name="autouv"),
    )
    return out, dict(result.stats), _render_uv_preview(result)
