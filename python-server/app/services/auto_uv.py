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


# autouv.unwrap reports a per-stage fraction (each 0..1). Map each stage into a
# slice of the global [0,1] bar, with a human-readable label for the UI.
_UV_STAGE_RANGES = {
    "weld": (0.00, 0.08),
    "segment": (0.08, 0.22),
    "refine": (0.22, 0.45),
    "parameterize": (0.45, 0.95),
}
_UV_STAGE_LABELS = {
    "weld": "Welding vertices",
    "segment": "Segmenting charts",
    "refine": "Refining charts",
    "parameterize": "Flattening charts",
}


def run_auto_uv(mesh: trimesh.Trimesh, options: AutoUvOptions, progress=None,
                source_normals=None) -> tuple[trimesh.Trimesh, dict, bytes | None]:
    src = autouv.Mesh(np.asarray(mesh.vertices), np.asarray(mesh.faces))

    unwrap_progress = None
    if progress is not None:
        def unwrap_progress(stage, frac):  # noqa: F811
            lo, hi = _UV_STAGE_RANGES.get(stage, (0.95, 0.98))
            g = lo + (hi - lo) * max(0.0, min(1.0, float(frac)))
            progress(stage, g, _UV_STAGE_LABELS.get(stage, stage))

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
        normal_smooth_deg=options.normal_smooth_deg,
        source_normals=source_normals,
        preserve_normals=options.preserve_normals,
        progress=unwrap_progress,
        verbose=False,
    )

    if progress is not None:
        progress("render", 0.97, "Rendering UV preview")

    # Build a GLB-ready mesh with the new vertex UV channel (seam-split geometry).
    #
    # The normals matter as much as the UVs here. Unwrapping duplicates every
    # vertex on a chart boundary, and trimesh only writes a glTF NORMAL accessor
    # when vertex_normals is already populated -- so omitting them ships geometry
    # with POSITION/TEXCOORD_0 only, and every consumer (our viewer, the mesh
    # editor, Unreal) recomputes normals per *index*. Each copy of a seam vertex
    # then averages just its own chart's faces, which reads as a hard shading
    # crease tracing every chart boundary. It scales with curvature x triangle
    # size, so it is invisible on dense input and obvious on simplified meshes.
    # result.normals carries the input mesh's own normals through the split, so
    # the unwrap leaves shading exactly as it found it.
    out = trimesh.Trimesh(
        vertices=result.vertices,
        faces=result.faces,
        vertex_normals=result.normals,
        process=False,
    )
    out.visual = trimesh.visual.TextureVisuals(
        uv=np.asarray(result.uv),
        material=trimesh.visual.material.PBRMaterial(name="autouv"),
    )
    return out, dict(result.stats), _render_uv_preview(result)
