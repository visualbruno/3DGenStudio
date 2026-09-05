"""Bridge between the /meshes/fit route and the bundled assemblyfit package.

Same shape as the other service bridges (auto_uv.py, repair.py): parse options
into the package's own config, run it, and hand back the payload the route
streams. All the algorithm lives in services/assemblyfit/.
"""
from __future__ import annotations

import base64

import numpy as np

from ..schemas import FitOptions
from .assemblyfit import FitConfig, fit_assembly

# Stage slices for the progress bar, so a piece-by-piece run reports one
# monotonic 0..1. The pipeline already emits within these; this only labels.
_STAGE_LABELS = {
    'prep': 'Preparing meshes',
    'rigid': 'Seating the piece',
    'shrinkwrap': 'Conforming to the body',
    'penetration': 'Resolving interpenetration',
    'finalize': 'Finalizing',
}


def run_fit(piece_mesh, body_mesh, options: FitOptions, progress=None):
    """Fit `piece_mesh` onto `body_mesh`.

    Returns the terminal `done` payload. Note it carries POSITIONS, not a mesh:

      {"format": "positions", "positions_b64": ..., "count": n, "stats": {...}}

    That is deliberate and load-bearing. The fit never changes the piece's
    vertex count or order, so the client only needs the new coordinates — it
    overwrites the `position` attribute on a clone of its OWN geometry and
    leaves UVs, materials, submesh structure and skinning entirely untouched.
    Returning a GLB instead would route the piece back through trimesh, whose
    loader concatenates a multi-material mesh into one (see meshio.load_mesh)
    and cannot represent skinning at all — a fitted piece would come back
    materially degraded. It is also far smaller on the wire.
    """
    config = FitConfig(
        stages=tuple(options.stages),
        offset=options.offset,
        iterations=options.iterations,
        tolerance=options.tolerance,
        vote_rounds=options.vote_rounds,
        smooth_rounds=options.smooth_rounds,
        smooth_alpha=options.smooth_alpha,
        step_clamp=options.step_clamp,
        field_centres=options.field_centres,
        field_smoothing=options.field_smoothing,
        strength=options.strength,
        flip_abort_frac=options.flip_abort_frac,
        min_thickness=options.min_thickness,
        rebuild_shell=options.rebuild_shell,
        lock_vertical=options.lock_vertical,
        preserve_centroid=options.preserve_centroid,
        rigid_allow_scale=options.rigid_allow_scale,
        rigid_scale_limit=options.rigid_scale_limit,
        rigid_iterations=options.rigid_iterations,
        rigid_trim=options.rigid_trim,
        rigid_anchor_pull=options.rigid_anchor_pull,
        landmarks=tuple({'piece': pair.piece, 'body': pair.body}
                        for pair in options.landmarks),
        warp_smoothing=options.warp_smoothing,
        warp_max_amplification=options.warp_max_amplification,
        warp_max_move_ratio=options.warp_max_move_ratio,
        warp_clamp_abort_frac=options.warp_clamp_abort_frac,
        rigid_move_penalty=options.rigid_move_penalty,
        rigid_try_identity=options.rigid_try_identity,
        rigid_per_shell=options.rigid_per_shell,
        rigid_shell_min_faces=options.rigid_shell_min_faces,
        max_distance_ratio=options.max_distance_ratio or None,
        body_face_budget=options.body_face_budget,
        device=options.device,
    )

    def emit(stage, fraction, message=''):
        if progress:
            progress(stage, fraction, message or _STAGE_LABELS.get(stage, stage))

    expected = len(piece_mesh.vertices)
    positions, stats = fit_assembly(piece_mesh, body_mesh, config, progress=emit)

    # The contract, asserted rather than assumed. If a future stage ever changes
    # the vertex count, the client would silently apply the wrong coordinates to
    # its geometry and scramble the piece; failing loudly here is far better.
    if len(positions) != expected:
        raise ValueError(
            f'Internal error: the fit changed the vertex count ({expected} -> '
            f'{len(positions)}), which would corrupt the piece.')

    # float32 halves the payload versus float64 and matches the precision of the
    # BufferAttribute it lands in, so nothing is lost.
    packed = np.ascontiguousarray(positions, dtype=np.float32)
    return {
        'format': 'positions',
        'positions_b64': base64.b64encode(packed.tobytes()).decode('ascii'),
        'count': int(expected),
        # The rigid stage's similarity transform, row-major, or null. Positions
        # are always authoritative — this is here so a rigid-ONLY run can be
        # folded into the piece's own placement instead of becoming a mesh edit,
        # which keeps it visible and editable in the transform panel.
        'transform': stats.get('transform'),
        'stats': stats,
    }
