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
from .conform import conform, weld_map
from .config import FitConfig
from .rigid import rigid_fit
from .shells import split_shells
from .warp import warp

# Progress slices, so a multi-stage run reports one monotonic 0..1 rather than
# restarting per stage. Same approach as _UV_STAGE_RANGES in services/auto_uv.py.
_STAGE_RANGES = {
    'prep': (0.00, 0.08),
    'rigid': (0.08, 0.28),
    'warp': (0.28, 0.44),
    'shrinkwrap': (0.44, 0.68),
    'penetration': (0.68, 0.96),
    'finalize': (0.96, 1.00),
}

_STAGE_LABELS = {
    'prep': 'Preparing meshes',
    'rigid': 'Seating the piece',
    'warp': 'Matching the landmarks',
    'shrinkwrap': 'Conforming to the body',
    'penetration': 'Resolving interpenetration',
    'finalize': 'Finalizing',
}

# Pipeline ORDER, not just a membership test: rigid places the piece, the warp
# corrects its proportions, and only then is it worth conforming and pushing out.
_KNOWN_STAGES = ('rigid', 'warp', 'shrinkwrap', 'penetration')


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


def _run_rigid(V, F, target, query, config, stats, max_distance, emit):
    """Seat the piece, whole or shell by shell, and record the transform.

    The transform is reported as well as applied. A rigid fit is a PLACEMENT,
    not a deformation, so the client folds it into the piece's own transform
    where the user can still see and edit it — a piece that has only been
    seated is not an edited mesh and should not become one.

    Per-shell runs produce several transforms and therefore no single one to
    hand back; `transform` is then null and the caller falls back to positions.
    """
    common = dict(
        offset=config.offset,
        allow_scale=config.rigid_allow_scale,
        scale_limit=config.rigid_scale_limit,
        iterations=config.rigid_iterations,
        trim_fraction=config.rigid_trim,
        anchor_pull=config.rigid_anchor_pull,
        move_penalty=config.rigid_move_penalty,
        try_identity=config.rigid_try_identity,
    )

    if not config.rigid_per_shell:
        matrix, rigid_stats = rigid_fit(V, F, target, query, progress=lambda f: emit('rigid', f),
                                        **common)
        stats['transform'] = [float(x) for x in matrix.reshape(-1)]
        rigid_stats['shells'] = 1
        return V @ matrix[:3, :3].T + matrix[:3, 3], rigid_stats

    # Per shell. Each is solved against the same body, on its own vertices, and
    # a shell whose solve fails simply keeps the placement it had.
    groups, _count = weld_map(V)     # groups[i] = the welded group of vertex i
    labels, members = split_shells(V, F, groups, min_faces=config.rigid_shell_min_faces)
    moved = V.copy()
    per_shell = []

    for index, vertex_ids in enumerate(members):
        emit('rigid', index / max(len(members), 1))
        # A shell's own faces, re-indexed into its own vertex numbering.
        mask = np.zeros(len(V), bool)
        mask[vertex_ids] = True
        shell_faces = F[mask[F].all(axis=1)]
        if len(shell_faces) < 4:
            continue
        remap = np.full(len(V), -1, dtype=np.int64)
        remap[vertex_ids] = np.arange(len(vertex_ids))

        matrix, shell_stats = rigid_fit(V[vertex_ids], remap[shell_faces], target, query, **common)
        moved[vertex_ids] = V[vertex_ids] @ matrix[:3, :3].T + matrix[:3, 3]
        shell_stats['vertices'] = int(len(vertex_ids))
        per_shell.append(shell_stats)

    # No single transform describes several shells moving independently.
    stats['transform'] = None
    return moved, {
        'shells': len(members),
        'per_shell': per_shell,
        'scale': float(np.median([s['scale'] for s in per_shell])) if per_shell else 1.0,
        'residual_mean': float(np.mean([s.get('residual_mean', 0.0) for s in per_shell]))
                         if per_shell else 0.0,
        'pairs_kept': int(sum(s.get('pairs_kept', 0) for s in per_shell)),
        'kept_identity': all(s.get('kept_identity') for s in per_shell) if per_shell else True,
    }


def fit_assembly(piece_mesh, body_mesh, config: FitConfig = None, progress=None):
    """Fit `piece_mesh` onto `body_mesh`.

    Returns (positions, stats). `positions` is an (n, 3) float array in the SAME
    vertex order as the input piece -- the caller relies on that to apply the
    result onto its own geometry without touching UVs or materials.
    """
    config = config or FitConfig()
    # `transform` is the rigid stage's output and stays None otherwise, so the
    # client can always read it without checking which stages ran.
    stats = {'timings': {}, 'stages': {}, 'transform': None}

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
            if stage not in _KNOWN_STAGES:
                raise ValueError(f'Unknown fit stage: {stage!r}')

            started = time.perf_counter()
            emit(stage, 0.0)

            if stage == 'warp':
                if not config.landmarks:
                    raise ValueError(
                        'The landmark warp needs at least 4 landmark pairs. Place them '
                        'in the Landmarks panel, or turn the stage off.')
                piece_points = np.array([pair['piece'] for pair in config.landmarks],
                                        dtype=np.float64)
                body_points = np.array([pair['body'] for pair in config.landmarks],
                                       dtype=np.float64)
                V, stage_stats = warp(
                    V, piece_points, body_points,
                    body_diagonal=body_diagonal,
                    smoothing=config.warp_smoothing,
                    max_amplification=config.warp_max_amplification,
                    max_move_ratio=config.warp_max_move_ratio,
                    clamp_abort_frac=config.warp_clamp_abort_frac,
                    progress=lambda fraction: emit('warp', fraction),
                )
                stats['stages'][stage] = stage_stats
                stats['timings'][stage] = time.perf_counter() - started
                if config.verbose:
                    print(f'  {stage}: {stage_stats}')
                continue

            if stage == 'rigid':
                V, stage_stats = _run_rigid(V, F, target, query, config, stats,
                                            max_distance, emit)
                stats['stages'][stage] = stage_stats
                stats['timings'][stage] = time.perf_counter() - started
                if config.verbose:
                    print(f'  {stage}: {stage_stats}')
                continue

            scope = 'all' if stage == 'shrinkwrap' else 'inside'

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
    # The penetration numbers come from the DEFORM stages: a rigid pass reports
    # seating, not clipping, and reading its stats here would report zeros and
    # make a successful snap look like a fit that did nothing.
    deform = [name for name in config.stages if name in ('shrinkwrap', 'penetration')]
    last = stats['stages'][deform[-1]] if deform else {}
    first = stats['stages'][deform[0]] if deform else {}
    stats['penetrating_before'] = first.get('penetrating_before', 0)
    stats['penetrating_after'] = last.get('penetrating_after', 0)
    stats['max_depth_before'] = first.get('max_depth_before', 0.0)
    stats['max_depth_after'] = last.get('max_depth_after', 0.0)
    stats['flipped_faces'] = last.get('flipped_faces', 0)
    stats['min_clearance_after'] = last.get('min_clearance_after', 0.0)
    rigid_stats = stats['stages'].get('rigid')
    if rigid_stats:
        stats['rigid'] = rigid_stats
    stats['converged'] = all(stats['stages'][name].get('converged', False) for name in deform)         if deform else True
    stats['stopped_on_inversion'] = any(s.get('stopped_on_inversion', False)
                                        for s in stats['stages'].values())
    contact = next((s.get('self_contact') for s in stats['stages'].values()
                    if s.get('self_contact')), None)
    stats['self_contact'] = contact
    stats['surfaces_touching'] = bool(contact and contact.get('touching'))
    stats['max_move'] = max((s.get('max_move', 0.0) for s in stats['stages'].values()),
                            default=0.0)

    return V, stats
