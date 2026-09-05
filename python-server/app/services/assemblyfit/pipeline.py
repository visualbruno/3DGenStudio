"""Assembly fit orchestration.

Both meshes arrive ALREADY IN ONE SHARED WORLD SPACE: the client bakes each
piece's placement into the GLB it uploads. Nothing here re-implements TRS or
mirroring, and nothing here needs to. The existing bake endpoint states the same
rule for the same reason (see DEFAULT_BAKE_OPTIONS.align_source in
src/utils/meshTools.js): a proximity query is only meaningful between meshes in
the same space.
"""
from __future__ import annotations

import time

import numpy as np
import trimesh

from ..autoretopo.project import make_surface_query
from .conform import conform
from .config import FitConfig

# Progress slices, so a multi-stage run reports one monotonic 0..1 rather than
# restarting per stage. Same approach as _UV_STAGE_RANGES in services/auto_uv.py.
_STAGE_RANGES = {
    'prep': (0.00, 0.12),
    'shrinkwrap': (0.12, 0.62),
    'penetration': (0.62, 0.96),
    'finalize': (0.96, 1.00),
}

_STAGE_LABELS = {
    'prep': 'Preparing meshes',
    'shrinkwrap': 'Conforming to the body',
    'penetration': 'Resolving interpenetration',
    'finalize': 'Finalizing',
}


def _decimate(mesh, face_budget, verbose=False):
    """Reduce the proximity target's face count.

    The closest-point query dominates the runtime and barely cares about detail
    finer than the offset, so this is a large speedup for almost no accuracy.
    Best-effort: a failure here is not a reason to fail the fit.
    """
    if not face_budget or len(mesh.faces) <= face_budget:
        return mesh
    try:
        reduced = mesh.simplify_quadric_decimation(face_count=face_budget)
        if reduced is not None and len(reduced.faces) > 0:
            if verbose:
                print(f'  body decimated {len(mesh.faces)} -> {len(reduced.faces)} faces')
            return reduced
    except Exception as error:  # noqa: BLE001 - optional optimisation only
        if verbose:
            print(f'  body decimation skipped: {error}')
    return mesh


def fit_assembly(piece_mesh, body_mesh, config: FitConfig = None, progress=None):
    """Fit `piece_mesh` onto `body_mesh`.

    Returns (positions, stats). `positions` is an (n, 3) float array in the SAME
    vertex order as the input piece -- the caller relies on that to apply the
    result onto its own geometry without touching UVs or materials.
    """
    config = config or FitConfig()
    stats = {'timings': {}, 'stages': {}}

    def emit(stage, fraction, message=''):
        if not progress:
            return
        low, high = _STAGE_RANGES.get(stage, (0.0, 1.0))
        progress(stage, low + (high - low) * max(0.0, min(1.0, fraction)),
                 message or _STAGE_LABELS.get(stage, stage))

    # ---- prep --------------------------------------------------------------
    started = time.perf_counter()
    emit('prep', 0.1, 'Measuring meshes')

    V = np.asarray(piece_mesh.vertices, dtype=np.float64)
    F = np.asarray(piece_mesh.faces)
    if len(V) == 0 or len(F) == 0:
        raise ValueError('The piece contains no geometry to fit.')
    if len(body_mesh.faces) == 0:
        raise ValueError('The base mesh contains no geometry to fit against.')

    body_extents = np.asarray(body_mesh.bounds[1]) - np.asarray(body_mesh.bounds[0])
    body_diagonal = float(np.linalg.norm(body_extents))
    piece_extents = np.asarray(piece_mesh.bounds[1]) - np.asarray(piece_mesh.bounds[0])

    # Watertightness decides how much to trust the inside/outside test. Reported
    # rather than repaired: a repair changes the vertex count, which would break
    # the positions-only contract this endpoint is built on.
    watertight = bool(body_mesh.is_watertight)
    stats['body_watertight'] = watertight
    stats['body_faces'] = int(len(body_mesh.faces))
    stats['piece_faces'] = int(len(F))
    stats['piece_vertices'] = int(len(V))
    stats['body_diagonal'] = body_diagonal
    stats['piece_diagonal'] = float(np.linalg.norm(piece_extents))

    emit('prep', 0.6, 'Building the proximity target')
    target = _decimate(body_mesh, config.body_face_budget, config.verbose)
    stats['target_faces'] = int(len(target.faces))

    max_distance = (config.max_distance_ratio * body_diagonal
                    if config.max_distance_ratio else None)

    stats['timings']['prep'] = time.perf_counter() - started

    # ---- conform -----------------------------------------------------------
    # One query object for every stage: building the (GPU) BVH is the expensive
    # part, and the target does not change between stages.
    query = make_surface_query(target, config.device)
    try:
        for stage in config.stages:
            if stage not in ('shrinkwrap', 'penetration'):
                raise ValueError(f'Unknown fit stage: {stage!r}')

            started = time.perf_counter()
            scope = 'all' if stage == 'shrinkwrap' else 'inside'
            emit(stage, 0.0)

            V, stage_stats = conform(
                V, F, target, query,
                scope=scope,
                offset=config.offset,
                iterations=config.iterations,
                smooth_rounds=config.smooth_rounds,
                smooth_alpha=config.smooth_alpha,
                step_clamp=config.step_clamp,
                tolerance=config.tolerance,
                vote_rounds=config.vote_rounds,
                max_distance=max_distance,
                field_centres=config.field_centres,
                field_smoothing=config.field_smoothing,
                strength=config.strength,
                flip_abort_frac=config.flip_abort_frac,
                min_thickness=config.min_thickness,
                rebuild_shell=config.rebuild_shell,
                lock_vertical=config.lock_vertical,
                preserve_centroid=config.preserve_centroid,
                progress=lambda fraction, _stage=stage: emit(_stage, fraction),
            )
            stats['stages'][stage] = stage_stats
            stats['timings'][stage] = time.perf_counter() - started
            if config.verbose:
                print(f'  {stage}: {stage_stats}')
    finally:
        # Release the GPU BVH however we leave, rather than waiting for a
        # garbage-collection cycle. project_to_surface does the same.
        if hasattr(query, 'free'):
            query.free()

    emit('finalize', 1.0, 'Done')

    # Roll the headline numbers up to the top level so the UI does not have to
    # know the stage order to report whether the fit worked.
    last = stats['stages'][config.stages[-1]] if config.stages else {}
    first = stats['stages'][config.stages[0]] if config.stages else {}
    stats['penetrating_before'] = first.get('penetrating_before', 0)
    stats['penetrating_after'] = last.get('penetrating_after', 0)
    stats['max_depth_before'] = first.get('max_depth_before', 0.0)
    stats['max_depth_after'] = last.get('max_depth_after', 0.0)
    stats['flipped_faces'] = last.get('flipped_faces', 0)
    stats['min_clearance_after'] = last.get('min_clearance_after', 0.0)
    stats['converged'] = all(s.get('converged', False) for s in stats['stages'].values())
    stats['stopped_on_inversion'] = any(s.get('stopped_on_inversion', False)
                                        for s in stats['stages'].values())
    contact = next((s.get('self_contact') for s in stats['stages'].values()
                    if s.get('self_contact')), None)
    stats['self_contact'] = contact
    stats['surfaces_touching'] = bool(contact and contact.get('touching'))
    stats['max_move'] = max((s.get('max_move', 0.0) for s in stats['stages'].values()),
                            default=0.0)

    return V, stats
