"""Seat a piece on the body WITHOUT deforming it.

This is the stage that answers the actual complaint: "roughly place the armour,
press Fit, and have it land at the right size in the right place." Every other
stage moves vertices individually, which is exactly wrong for plate — a smoothed
displacement field is a low-frequency deformation, and a flat plate has no
low-frequency detail to spare, so it comes out looking melted. A similarity
transform cannot melt anything: the piece that goes in is the piece that comes
out, at a different size and angle.

---- What it solves for ------------------------------------------------------

Resolving CLIPPING, rigidly. Vertices that are inside the body (or closer to it
than the clearance) get a target on the surface at the offset; every other
vertex is ANCHORED where it already is. The answer is the similarity transform
that best satisfies both — Umeyama's closed form, iterated as ICP because the
correspondences move with the piece.

The anchors are the whole design. Without them the objective is "put the lining
at the clearance offset", which sounds right and is badly wrong: a cuirass has
air inside it by definition, so that asks it to become skin-tight, and it
shrinks by exactly the clearance it was built with. Measured on a tube around a
torso, before the anchors existed:

    clearance 0.005 -> shrank  5%
    clearance 0.02  -> shrank 12%
    clearance 0.05  -> shrank 24%
    clearance 0.10  -> shrank 33%  (hit the scale rail)

On a real armour that reads as the piece collapsing into the middle of the body
the moment Fit is pressed, which is what it did. Anchoring the vertices that are
already fine removes the incentive entirely: a piece that is not clipping has
nothing to solve for and comes back untouched.

---- What it does NOT do -----------------------------------------------------

It does not resize a piece that is merely the wrong size. A too-LARGE piece
floats clear of the body, generates no push targets, and is left exactly where
the user put it — deliberately, because every objective that pulls a floating
piece inward also pulls a correctly-clearanced one inward, and there is no local
measurement that separates the two. A too-SMALL piece clips everywhere, so it
does grow, which is the case worth handling anyway.

Gross sizing belongs to `Fit to region`, which matches EXTENTS rather than
minimising distance and has neither failure. Rigid runs after it and refines.

"""
from __future__ import annotations

import numpy as np
import trimesh

from .conform import SINGLE_SURFACE_FRACTION, raw_signed_distance


def umeyama(source, target, allow_scale=True, weights=None):
    """The least-squares similarity transform taking `source` onto `target`.

    Umeyama 1991, with per-point weights. Returns (scale, rotation 3x3,
    translation) — the reflection guard on the determinant is the part
    hand-rolled versions get wrong, and it matters here: without it a symmetric
    piece can be "best fitted" by turning it inside out.

    The weights carry the anchor scheme: vertices that need pushing out are
    worth 1, vertices that are already fine share a smaller total between them.
    Equal weights would let the anchors outvote the correction outright — on a
    real piece they outnumber it by roughly 76 to 1, and the solve then answers
    "do nothing" to every input.
    """
    n = len(source)
    if n < 3:
        return 1.0, np.eye(3), np.zeros(3)

    if weights is None:
        w = np.full(n, 1.0 / n)
    else:
        w = np.asarray(weights, dtype=np.float64)
        total = w.sum()
        if total <= 1e-18:
            return 1.0, np.eye(3), np.zeros(3)
        w = w / total

    mu_source = w @ source
    mu_target = w @ target
    centred_source = source - mu_source
    centred_target = target - mu_target

    covariance = (centred_target * w[:, None]).T @ centred_source
    u, singular, vt = np.linalg.svd(covariance)

    # Force a rotation, never a reflection.
    d = np.ones(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[2] = -1.0
    rotation = u @ np.diag(d) @ vt

    if allow_scale:
        variance = float((w[:, None] * centred_source ** 2).sum())
        scale = float(np.sum(singular * d) / variance) if variance > 1e-18 else 1.0
    else:
        scale = 1.0

    translation = mu_target - scale * (rotation @ mu_source)
    return scale, rotation, translation


def _matrix(scale, rotation, translation):
    m = np.eye(4)
    m[:3, :3] = scale * rotation
    m[:3, 3] = translation
    return m


def _apply(matrix, points):
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def _targets(points, query, body_normals, offset):
    """Where each vertex should be: pushed out, or left exactly where it is.

    The anchor branch is what stops the solve pulling a correctly-clearanced
    piece onto the skin — see the header. `push` is returned so the caller can
    report how much was actually wrong.
    """
    closest, ids = query.on_surface(points)
    signed, _distance = raw_signed_distance(points, closest, ids, body_normals)

    # Inside the body, or nearer to it than the clearance we promised.
    push = signed < offset
    target = points.copy()
    if np.any(push):
        target[push] = closest[push] + body_normals[ids[push]] * offset
    return target, push, signed


def _weights(push, anchor_pull):
    """Solve weights: 1 for a vertex that must move, a shared budget for the rest.

    Distinct from `move_penalty`, which is the ACCEPT criterion. This one only
    shapes the least-squares solve, and wants the two groups roughly balanced so
    the anchors keep the transform sane without silencing the correction.

    The anchors exist to stop the solve inventing a scale change or sliding the
    piece off somewhere unrelated — not to veto motion. Their TOTAL weight is a
    multiple of the pushes' total, so the balance does not change with mesh
    density: the same piece at 5k and 500k vertices seats identically.
    """
    weights = np.where(push, 1.0, 0.0)
    anchors = ~push
    anchor_count = int(np.count_nonzero(anchors))
    push_count = int(np.count_nonzero(push))
    if anchor_count and push_count:
        weights[anchors] = anchor_pull * push_count / anchor_count
    return weights


def _objective(points, original, query, body_normals, offset, move_penalty):
    """What a seating is actually trying to achieve, in one number.

        mean penetration depth  +  move_penalty x mean distance moved

    Both halves are needed. Depth alone is minimised by shrinking the piece
    until it fits inside its own clearance; displacement alone is minimised by
    doing nothing. Together they say "stop the clipping, and do not wander to
    achieve it", which is the whole brief.

    An earlier version scored against targets frozen at the start instead. That
    looked principled and was useless: every anchor moves away from its frozen
    target as soon as the piece moves at all, so the score rose monotonically
    while the ICP was demonstrably fixing the problem (clipping vertices
    192 -> 96), and the result was rejected every time.

    `move_penalty` has to be well under the share of the piece that is clipping,
    and 1.0 is degenerate. Freeing a vertex buried by depth d costs at least d
    of travel, and a translation moves EVERY vertex that far while only the
    buried fraction f gains — so the exchange rate is f, and any penalty at or
    above it means the stage can never justify moving at all.
    """
    closest, ids = query.on_surface(points)
    signed, _distance = raw_signed_distance(points, closest, ids, body_normals)
    depth = float(np.mean(np.maximum(0.0, offset - signed)))
    moved = float(np.mean(np.linalg.norm(points - original, axis=1)))
    return depth + move_penalty * moved, depth


def rigid_fit(vertices, faces, body_mesh, surface_query, *,
              offset=0.004,
              allow_scale=True,
              scale_limit=1.5,
              iterations=12,
              trim_fraction=0.1,
              anchor_pull=1.0,
              move_penalty=0.15,
              try_identity=True,
              tolerance=1e-4,
              progress=None):
    """Find the similarity transform that seats the piece on the body.

    Returns (matrix 4x4, stats). The matrix maps the piece's CURRENT world
    positions to their seated ones — the caller either applies it to the
    vertices (to run further stages) or hands it back so the client can fold it
    into the piece's own transform, which is what keeps a rigid fit an editable
    placement instead of a baked deformation.
    """
    V = np.asarray(vertices, dtype=np.float64)
    F = np.asarray(faces)
    body_normals = np.asarray(body_mesh.face_normals)

    stats = {
        'pairs_total': 0, 'pairs_kept': 0, 'iterations': 0,
        'scale': 1.0, 'rotation_deg': 0.0, 'translation': 0.0,
        'scale_clamped': False, 'kept_identity': False, 'clipping_vertices': 0,
    }
    if len(V) < 3 or len(F) == 0:
        stats['residual_mean'] = 0.0
        stats['residual_before'] = 0.0
        return np.eye(4), stats

    # Every vertex takes part: the ones that are already fine anchor the solve.
    # Restricting this to the lining, as an earlier version did, removed the
    # anchors and let the piece shrink freely.
    _t0, push, _signed = _targets(V, surface_query, body_normals, offset)
    stats['pairs_total'] = int(len(V))
    stats['clipping_vertices'] = int(np.count_nonzero(push))

    score_before, depth_before = _objective(V, V, surface_query, body_normals,
                                            offset, move_penalty)
    stats['residual_before'] = depth_before

    if not np.any(push):
        # Nothing is clipping, so there is nothing for a rigid move to fix.
        # Returning identity here is not a failure — it is the correct answer,
        # and it is what keeps pressing Fit on a good placement a no-op.
        stats.update({'kept_identity': True, 'residual_mean': depth_before,
                      'pairs_kept': 0})
        return np.eye(4), stats

    # The BEST iterate wins, not the last one. ICP here does not converge to a
    # fixed point: each pass finds a little more to push and keeps inflating the
    # piece (scale walked 1.05 -> 1.19 over eight passes on a test cuirass while
    # the clipping it was fixing had already stopped falling). Scoring every
    # iterate and keeping the best turns that from a failure into a stopping
    # rule, and costs one closest-point query per pass.
    total = np.eye(4)
    best_matrix, best_score, best_depth = np.eye(4), score_before, depth_before
    source = V.copy()

    for iteration in range(int(iterations)):
        stats['iterations'] = iteration + 1
        if progress:
            progress(iteration / max(iterations, 1))

        target, push_now, _signed_now = _targets(source, surface_query, body_normals, offset)
        if not np.any(push_now):
            break              # nothing left clipping: the seating is done
        weights = _weights(push_now, anchor_pull)

        # Trim the worst correspondences before solving. One vertex whose
        # nearest body point is across a gap — the far side of an arm, the
        # opposite thigh — otherwise drags the whole solve toward it, and least
        # squares has no other defence against a single bad pair. Only the
        # PUSHED vertices are eligible: an anchor's residual is zero by
        # construction, so trimming by residual would drop every real
        # correspondence first and leave the solve nothing to work from.
        pushed = np.flatnonzero(push_now)
        keep = max(3, int(round(len(pushed) * (1.0 - float(trim_fraction)))))
        if len(pushed) > keep:
            residual = np.linalg.norm(source[pushed] - target[pushed], axis=1)
            weights[pushed[np.argsort(residual)[keep:]]] = 0.0

        scale, rotation, translation = umeyama(source, target, allow_scale, weights)
        step = _matrix(scale, rotation, translation)

        moved = _apply(step, source)
        shift = float(np.max(np.linalg.norm(moved - source, axis=1)))
        source = moved
        total = step @ total

        score, depth = _objective(source, V, surface_query, body_normals,
                                  offset, move_penalty)
        if score < best_score:
            best_matrix, best_score, best_depth = total.copy(), score, depth

        if shift <= tolerance * max(offset, 1e-9) * 10.0:
            break

    total = best_matrix
    stats['pairs_kept'] = int(np.count_nonzero(push))

    # ---- rails ---------------------------------------------------------------
    accumulated = float(np.cbrt(abs(np.linalg.det(total[:3, :3]))))
    if scale_limit and scale_limit > 1.0:
        low, high = 1.0 / float(scale_limit), float(scale_limit)
        if accumulated < low or accumulated > high:
            # Clamp the scale and keep the rotation, rather than throwing the
            # whole solve away: the orientation is usually right even when the
            # correspondences have collapsed onto one body part, and a silently
            # 40x-shrunk piece is the worst possible outcome.
            clamped = min(high, max(low, accumulated))
            rotation_only = total[:3, :3] / max(accumulated, 1e-12)
            centre = V.mean(axis=0)
            total = _matrix(clamped, rotation_only,
                            _apply(total, centre[None])[0] - clamped * (rotation_only @ centre))
            accumulated = clamped
            stats['scale_clamped'] = True

    seated = _apply(total, V)
    error_after, depth_after = _objective(seated, V, surface_query, body_normals,
                                          offset, move_penalty)

    if try_identity and not (error_after < score_before):
        # Leaving the piece alone genuinely fits better. Happens when the user
        # has already placed it well, and on a symmetric shell where ICP has
        # walked into a worse local minimum than the one it started in.
        stats.update({'kept_identity': True, 'residual_mean': depth_before,
                      'scale': 1.0, 'rotation_deg': 0.0, 'translation': 0.0})
        return np.eye(4), stats

    rotation_part = total[:3, :3] / max(accumulated, 1e-12)
    cos_angle = (np.trace(rotation_part) - 1.0) / 2.0
    stats.update({
        'residual_mean': depth_after,
        'scale': accumulated,
        'rotation_deg': float(np.degrees(np.arccos(np.clip(cos_angle, -1.0, 1.0)))),
        'translation': float(np.linalg.norm(total[:3, 3])),
        'improved': bool(error_after < score_before),
    })
    return total, stats
