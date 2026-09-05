"""Landmark warp: correct proportions the other stages structurally cannot.

Every other stage is either a similarity transform (rigid) or a smooth pull
toward the body's surface (shrinkwrap, penetration). Neither can fix a piece
whose PROPORTIONS are wrong -- a cuirass built for a long torso on a short one,
sleeves cut for different arm lengths. A similarity transform has 7 degrees of
freedom and cannot stretch one axis without the others; a surface pull has no
idea which part of the piece belongs on which part of the body.

A landmark warp does, because the user tells it: pairs of points, one on the
body and one on the piece, meaning "this goes here". A thin-plate spline is the
standard interpolant for that -- it is the 3D deformation that passes exactly
through every pair while bending as little as possible everywhere else, which is
precisely the property wanted when the pairs are sparse and hand-placed.

scipy's RBFInterpolator provides it, and scipy is already a dependency. No new
package, no new service.

---- Why it is last, and off by default --------------------------------------

Its quality is entirely the user's click accuracy, and a thin-plate spline
extrapolates without bound: place two landmarks a centimetre apart that should
be a metre apart and the piece is destroyed, silently and spectacularly. Three
guards are therefore not optional:

  * at least 4 pairs, not coplanar -- below that the spline is under-determined
    and the solve is meaningless rather than merely bad;
  * a distance FALLOFF, so the deformation fades to identity away from the
    landmarks instead of running off;
  * an AMPLIFICATION cap: no vertex may travel much further than the furthest
    the landmarks actually asked for.

That last one replaced a cap measured as a fraction of the BODY's diagonal,
which sounds equivalent and is not. Reported from a real session: four pairs on
a boot, each asking for at most 0.065 of movement, produced vertex moves of
0.336 and stretched the piece from 0.27 deep to 0.75 -- and the cap never fired,
because 0.25 x the body diagonal was 0.45 on a piece only 0.53 across. The
damage scale that matters is the PIECE and the size of the correction being
requested, never the body.

The falloff replaced an earlier scheme that pinned the corners of a generous
bounding box to themselves. That bounded the extrapolation, but it also fought
the affine part of the spline -- and the affine part IS the global stretch that
makes this stage worth having. Measured on a known 1.45x/0.72x stretch sampled
at 12 pairs, corner anchors reproduced it only to 0.28 units; scaling the
displacement by distance instead reproduces it to 0.005 and still holds distant
geometry still.
"""
from __future__ import annotations

import numpy as np
from scipy.interpolate import RBFInterpolator


# Below this the spline is under-determined: a thin-plate spline in 3D needs a
# non-degenerate affine part, which four non-coplanar points is the minimum for.
MIN_PAIRS = 4


def coplanarity(points):
    """How flat a point set is: the smallest singular value over the largest.

    Zero means exactly coplanar. Used to reject a landmark set that cannot
    determine a 3D deformation -- four points around one shoulder are four
    points on a plane, and the spline through them is arbitrary in the direction
    they do not span.
    """
    points = np.asarray(points, dtype=np.float64)
    if len(points) < 4:
        return 0.0
    centred = points - points.mean(axis=0)
    singular = np.linalg.svd(centred, compute_uv=False)
    if singular[0] <= 1e-18:
        return 0.0
    return float(singular[-1] / singular[0])


def _falloff(vertices, landmarks, start_ratio, end_ratio):
    """1 near the landmarks, 0 far from them, smooth in between.

    Applied to the DISPLACEMENT rather than to the control points, so inside the
    landmarked region the spline is untouched -- including its affine part,
    which is what expresses a global stretch. Pinning far-away control points
    instead would have damped that stretch everywhere.

    The radii scale with the landmark cloud itself, so the same settings behave
    the same on a gauntlet and on a full body suit.
    """
    centre = landmarks.mean(axis=0)
    radius = float(np.linalg.norm(landmarks - centre, axis=1).max())
    if radius <= 1e-12:
        return np.ones(len(vertices))

    start = radius * float(start_ratio)
    end = max(radius * float(end_ratio), start + 1e-9)

    # Distance to the NEAREST landmark, not to the centroid: a piece landmarked
    # along a limb is long and thin, and measuring from the centroid would fade
    # out its own ends.
    from scipy.spatial import cKDTree
    distance, _ = cKDTree(landmarks).query(vertices, k=1)

    t = np.clip((distance - start) / (end - start), 0.0, 1.0)
    return 1.0 - (t * t * (3.0 - 2.0 * t))      # smoothstep


def warp(vertices, piece_points, body_points, *,
         body_diagonal=None,
         smoothing=0.0,
         max_amplification=2.0,
         max_move_ratio=0.15,
         clamp_abort_frac=0.25,
         min_coplanarity=1e-3,
         falloff_start=2.0,
         falloff_end=4.0,
         progress=None):
    """Deform `vertices` so each piece landmark lands on its body landmark.

    Returns (positions, stats). Vertex count and order are untouched, as the
    endpoint's wire contract requires.

    Raises ValueError when the landmark set cannot support a warp. That is
    deliberate and preferred over a silent no-op: the user placed those points
    by hand and needs to know they were not usable.
    """
    V = np.asarray(vertices, dtype=np.float64)
    source = np.asarray(piece_points, dtype=np.float64)
    target = np.asarray(body_points, dtype=np.float64)

    if len(source) != len(target):
        raise ValueError('Every landmark needs both a body point and a piece point.')
    if len(source) < MIN_PAIRS:
        raise ValueError(
            f'The warp needs at least {MIN_PAIRS} landmark pairs; {len(source)} placed.')

    flatness = coplanarity(source)
    if flatness < min_coplanarity:
        raise ValueError(
            'The landmarks are almost coplanar, so they cannot describe a 3D '
            'deformation. Spread them around the piece — front and back, not all '
            'on one face.')

    if progress:
        progress(0.2)

    # Thin-plate spline: the minimum-bending interpolant through every pair.
    # `smoothing` > 0 relaxes exact interpolation, which is what to reach for
    # when the landmarks are slightly inconsistent with each other.
    spline = RBFInterpolator(source, target, kernel='thin_plate_spline',
                             smoothing=float(smoothing))

    if progress:
        progress(0.5)

    # Scale the displacement by distance from the landmarks, so geometry the
    # user said nothing about keeps the placement they gave it.
    weight = _falloff(V, source, falloff_start, falloff_end)
    moved = V + (np.asarray(spline(V), dtype=np.float64) - V) * weight[:, None]

    if progress:
        progress(0.9)

    # The circuit breaker, and the reason a bad landmark set produces a merely
    # imperfect piece instead of a destroyed one.
    #
    # Two caps, whichever is tighter:
    #
    #   * AMPLIFICATION -- a vertex may not travel much further than the
    #     furthest any landmark actually asked for. This is the one that
    #     catches an ill-conditioned set, because the symptom there is
    #     precisely a huge response to a small request;
    #   * the piece's OWN size, so a set that asks for a large move cannot turn
    #     the piece inside out achieving it.
    delta = moved - V
    distance = np.linalg.norm(delta, axis=1)

    requested = float(np.linalg.norm(target - source, axis=1).max()) if len(source) else 0.0
    piece_diagonal = float(np.linalg.norm(V.max(axis=0) - V.min(axis=0))) if len(V) else 0.0

    caps = []
    if max_amplification:
        caps.append(float(max_amplification) * requested)
    if max_move_ratio:
        caps.append(float(max_move_ratio) * piece_diagonal)
    limit = min(caps) if caps else None

    amplification = float(distance.max() / requested) if requested > 1e-12 else 0.0

    clamped = 0
    if limit is not None and limit > 0 and np.any(distance > limit):
        over = distance > limit
        clamped = int(np.count_nonzero(over))
        delta[over] *= (limit / distance[over])[:, None]
        moved = V + delta
        distance = np.linalg.norm(delta, axis=1)
    elif limit is not None and limit <= 0:
        # Every pair asks for nothing and the piece has no size: nothing to do.
        moved = V.copy()
        distance = np.zeros(len(V))

    # Measured on the WARPED positions, not on the raw spline: the falloff is
    # part of the deformation, so a landmark sitting where the falloff has begun
    # genuinely does not reach its target, and the report should say so.
    landmark_result = source + (np.asarray(spline(source)) - source) *         _falloff(source, source, falloff_start, falloff_end)[:, None]
    residual = np.linalg.norm(landmark_result - target, axis=1)

    # When most of the piece is only being held in shape by the safety net, the
    # deformation is not the one the user asked for -- it is whatever the spline
    # did, trimmed. Refusing beats handing back a mangled piece and a green
    # tick, and the number is the diagnosis: an amplification of 5 means the
    # landmarks were too clustered or too flat to determine a 3D warp.
    #
    # Same circuit-breaker shape as flip_abort_frac in conform.py.
    if clamp_abort_frac and len(V) and clamped > clamp_abort_frac * len(V):
        raise ValueError(
            'These landmarks do not determine a usable warp: the spline wanted to move '
            'the piece {:.0f}x further than any pair asked for, and {:.0f}% of it had to '
            'be held back. Add more pairs and spread them around the piece in all three '
            'directions -- front and back, not just along its length.'
            .format(amplification, 100.0 * clamped / len(V)))

    stats = {
        'pairs': int(len(source)),
        'coplanarity': flatness,
        'landmark_rms': float(np.sqrt(np.mean(residual ** 2))) if len(residual) else 0.0,
        'landmark_max': float(residual.max()) if len(residual) else 0.0,
        'max_move': float(distance.max()) if len(distance) else 0.0,
        'mean_move': float(distance.mean()) if len(distance) else 0.0,
        'clamped_vertices': clamped,
        'faded_vertices': int(np.count_nonzero(weight < 0.99)),
        # How much further the spline wanted to move things than any landmark
        # asked for. The single number that says whether the landmark set was
        # well conditioned: near 1 is healthy, 5 is the boot that got destroyed.
        'amplification': amplification,
        'requested_max': requested,
        'piece_diagonal': piece_diagonal,
    }
    if progress:
        progress(1.0)
    return moved, stats
