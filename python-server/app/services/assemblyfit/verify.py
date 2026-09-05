"""Self-verifying checks over the synthetic fit cases.

Run with `python -m app.services.assemblyfit --verify`.

These exist because "looks right in the viewport" is not a test. Each case
asserts a property that can be computed exactly, so a regression in conform()
fails here instead of showing up as a melted piece someone has to notice.

They live in the package, not in a scratch script, precisely so they survive.
"""
from __future__ import annotations

import numpy as np
import trimesh

from ..autoretopo.project import make_surface_query
from .config import FitConfig
from .pipeline import fit_assembly
from .rigid import rigid_fit, umeyama
from .warp import coplanarity, warp


def _radii(positions):
    return np.linalg.norm(positions, axis=1)


def _sphere_pair(piece_radius, body_radius=1.0, piece_subdiv=4):
    return (trimesh.creation.icosphere(subdivisions=4, radius=body_radius),
            trimesh.creation.icosphere(subdivisions=piece_subdiv, radius=piece_radius))


def check_shrinkwrap_reaches_offset():
    """Shrinkwrap onto a sphere is exactly measurable: every vertex must end up
    at body_radius + offset, whichever side it started on."""
    offset = 0.02
    results = []
    for piece_radius in (1.3, 0.6):
        body, piece = _sphere_pair(piece_radius)
        # lock_vertical / preserve_centroid off: this checks the PROJECTION
        # maths. Those two deliberately constrain the result away from an exact
        # projection, and they get their own check below.
        positions, _ = fit_assembly(piece, body, FitConfig(
            stages=('shrinkwrap',), offset=offset, iterations=14, device='cpu',
            max_distance_ratio=None, lock_vertical=False, preserve_centroid=False,
            field_centres=0))
        radii = _radii(positions)
        error = float(np.abs(radii - (1.0 + offset)).max())
        results.append((piece_radius, error, float(radii.mean())))
        assert error < 0.01, (
            f'shrinkwrap from r={piece_radius} left vertices {error:.4f} off the '
            f'target radius {1.0 + offset}')
    return results


def check_shrinkwrap_preserves_topology():
    """Vertex count and order are the contract the client relies on."""
    body, piece = _sphere_pair(1.3)
    positions, stats = fit_assembly(piece, body, FitConfig(
        stages=('shrinkwrap', 'penetration'), device='cpu'))
    assert len(positions) == len(piece.vertices), 'vertex count changed'
    assert stats['piece_faces'] == len(piece.faces), 'face count changed'
    # Same ORDER, not merely the same count: a reordering would silently
    # scramble UVs when the client applies these positions to its geometry.
    fitted = trimesh.Trimesh(positions, piece.faces, process=False)
    assert fitted.faces.shape == piece.faces.shape
    return len(positions)


def check_penetration_leaves_outside_alone():
    """The scope distinction, which is the whole reason plate armour does not
    melt: with scope='inside', vertices that are already clear must not move.

    The penetration is a CONTIGUOUS DENT, because that is what a real one looks
    like — a pauldron's inner corner pressed into a deltoid is tens of adjacent
    vertices, not one.

    A single isolated vertex buried on its own is deliberately NOT rescued: the
    displacement field is smoothed over the mesh graph, so a lone vertex whose
    neighbours all sit clear is pulled back toward them and escapes only slowly.
    That is the spike guard working as intended — pushing one vertex out while
    its neighbours stay put would produce exactly the needle the guard exists to
    prevent. A lone buried vertex is a mesh defect for /meshes/repair, not a
    fitting problem.
    """
    body = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
    piece = trimesh.creation.icosphere(subdivisions=4, radius=1.5)
    vertices = np.asarray(piece.vertices, dtype=np.float64).copy()

    # Press the +X cap of the shell inward so it sits well inside the body.
    dent = vertices[:, 0] > 1.2
    assert dent.sum() > 20, 'the fixture should dent a contiguous patch'
    vertices[dent] *= 0.35
    piece = trimesh.Trimesh(vertices, piece.faces, process=False)
    before = vertices.copy()

    positions, stats = fit_assembly(piece, body, FitConfig(
        stages=('penetration',), offset=0.01, device='cpu', max_distance_ratio=None))

    moved = np.linalg.norm(positions - before, axis=1)
    assert moved[dent].mean() > 0.3, (
        f'the dented patch barely moved (mean {moved[dent].mean():.4f})')
    assert stats['penetrating_after'] == 0, (
        f"{stats['penetrating_after']} vertices still penetrate after the push")

    # The far side of the shell — well clear, and beyond the smoothing's reach
    # from the dent — must be untouched. This is the property that keeps a rigid
    # piece rigid.
    far = before[:, 0] < -0.5
    assert moved[far].max() < 1e-9, (
        f'scope="inside" moved {int(np.count_nonzero(moved[far] > 1e-9))} vertices '
        f'on the far side (max {moved[far].max():.6f})')

    return {'dent_vertices': int(dent.sum()),
            'dent_mean_move': round(float(moved[dent].mean()), 4),
            'far_max_move': float(moved[far].max()),
            'penetrating': f"{stats['penetrating_before']} -> {stats['penetrating_after']}"}


def check_max_distance_guard():
    """A piece beyond max_distance must be left completely alone -- this is what
    stops a cape hem or a helmet plume being sucked onto the torso."""
    body = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    piece = trimesh.creation.box(extents=(0.2, 0.2, 0.2))
    piece.apply_translation((6.0, 0.0, 0.0))
    before = np.asarray(piece.vertices).copy()
    positions, _ = fit_assembly(piece, body, FitConfig(
        stages=('shrinkwrap',), device='cpu', max_distance_ratio=0.25))
    moved = float(np.linalg.norm(positions - before, axis=1).max())
    assert moved < 1e-12, f'a far-away piece moved by {moved}'
    return moved


def check_no_flipped_faces():
    """A fit that inverts the surface is worse than no fit. Any flip on a smooth
    synthetic case means the step clamp or the field smoothing has regressed."""
    reports = {}
    for radius in (1.3, 0.6):
        body, piece = _sphere_pair(radius)
        _, stats = fit_assembly(piece, body, FitConfig(
            stages=('shrinkwrap', 'penetration'), device='cpu',
            max_distance_ratio=None))
        flipped = stats['flipped_faces']
        reports[radius] = flipped
        assert flipped == 0, f'r={radius} produced {flipped} flipped faces'
    return reports


def check_offset_is_respected():
    """The clearance is the point of the offset: after fitting, nothing should
    be deeper than a hair inside the body."""
    body, piece = _sphere_pair(1.3)
    _, stats = fit_assembly(piece, body, FitConfig(
        stages=('shrinkwrap', 'penetration'), offset=0.05, iterations=14,
        device='cpu', max_distance_ratio=None, lock_vertical=False,
        preserve_centroid=False, field_centres=0))
    assert stats['penetrating_after'] == 0, (
        f"{stats['penetrating_after']} vertices still penetrate")
    assert stats['min_clearance_after'] > 0.0, (
        f"closest approach is {stats['min_clearance_after']:.5f}, expected positive")
    return {'min_clearance': stats['min_clearance_after'],
            'penetrating_after': stats['penetrating_after']}


def check_unwelded_seams_stay_closed():
    """The case the internal welding exists for.

    The client sends a piece as its submeshes concatenated and NOT welded, so
    coincident vertices appear twice — once per side of a UV seam or submesh
    boundary. Two things must hold:

      * the seam must not be TORN OPEN: duplicated vertices have to receive
        identical displacement, or the fit rips a visible crack along it;
      * the result must be as good as the welded case, because the smoothing
        runs on the welded view rather than on a mesh full of holes.
    """
    body = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
    welded = trimesh.creation.icosphere(subdivisions=4, radius=1.4)

    # Split it into a triangle soup: every triangle gets its own three vertices,
    # so every single edge is a "seam". A harsher version of what the client
    # actually sends, and it exercises the same code path.
    faces = np.asarray(welded.faces)
    soup_vertices = np.asarray(welded.vertices, dtype=np.float64)[faces.reshape(-1)]
    soup_faces = np.arange(len(soup_vertices)).reshape(-1, 3)
    soup = trimesh.Trimesh(soup_vertices, soup_faces, process=False)

    config = FitConfig(stages=('shrinkwrap',), offset=0.02, device='cpu',
                       max_distance_ratio=None, lock_vertical=False,
                       preserve_centroid=False, field_centres=0)
    soup_positions, soup_stats = fit_assembly(soup, body, config)
    welded_positions, _ = fit_assembly(welded, body, config)

    assert soup_stats['stages']['shrinkwrap']['welded_vertices'] == len(welded.vertices), (
        f"welding recovered {soup_stats['stages']['shrinkwrap']['welded_vertices']} groups, "
        f'expected {len(welded.vertices)}')

    # Coincident inputs must land on coincident outputs — no torn seams.
    from .conform import weld_map
    inverse, groups = weld_map(soup_vertices)
    spread = 0.0
    for group in range(groups):
        members = soup_positions[inverse == group]
        if len(members) > 1:
            spread = max(spread, float(np.linalg.norm(members - members[0], axis=1).max()))
    assert spread < 1e-9, f'the seam was torn open by {spread:.3e}'

    # And it should conform just as well as the already-welded mesh.
    soup_error = float(np.abs(np.linalg.norm(soup_positions, axis=1) - 1.02).max())
    welded_error = float(np.abs(np.linalg.norm(welded_positions, axis=1) - 1.02).max())
    assert soup_error < 0.01, f'the unwelded mesh conformed poorly ({soup_error:.4f} off)'
    return {'input_verts': len(soup_vertices), 'welded_groups': groups,
            'seam_spread': spread, 'soup_error': round(soup_error, 5),
            'welded_error': round(welded_error, 5)}


def check_thickness_is_preserved():
    """A garment is a SHELL with two surfaces, and conforming must not flatten it.

    This is the check that was missing when the first version shipped: projecting
    every vertex onto the body pulls the outer surface down onto the inner one,
    the piece's thickness goes to zero, and the result reads as the armour having
    been fused onto the skin rather than worn.

    The fixture is a thick spherical shell — two concentric surfaces, exactly the
    topology of a breastplate. After conforming, the spread of distances from the
    body must still be about the shell's thickness.
    """
    body = trimesh.creation.icosphere(subdivisions=4, radius=1.0)

    # A shell around the body: inner surface at 1.25, outer at 1.45. Its faces
    # are inverted on the inner sphere so both surfaces face outward from the
    # shell's own material, as a real modelled garment does.
    inner = trimesh.creation.icosphere(subdivisions=3, radius=1.25)
    outer = trimesh.creation.icosphere(subdivisions=3, radius=1.45)
    inner.invert()
    shell = trimesh.util.concatenate([inner, outer])
    thickness = 0.20

    positions, stats = fit_assembly(shell, body, FitConfig(
        stages=('shrinkwrap',), offset=0.02, device='cpu', max_distance_ratio=None))

    radii = np.linalg.norm(positions, axis=1)
    kept = float(np.percentile(radii, 97) - np.percentile(radii, 3))
    assert kept > thickness * 0.6, (
        f'the shell collapsed: thickness {thickness:.3f} -> {kept:.3f}. Conforming '
        f'must be driven by the inner surface and carry the outer one, not project '
        f'both onto the body.')

    # And the inner surface should actually have reached the offset, or it has
    # preserved thickness by simply doing nothing.
    assert radii.min() < 1.0 + 0.02 + thickness * 0.5, (
        f'the inner surface never reached the body (closest radius {radii.min():.3f})')

    return {'thickness': round(kept, 4), 'target': thickness,
            'inner_radius': round(float(radii.min()), 4),
            'outer_radius': round(float(radii.max()), 4),
            'flipped': stats['flipped_faces']}


# ---- rigid seating -----------------------------------------------------------
#
# Self-verifying by construction: build a garment that already sits correctly on
# a body, displace it by a KNOWN similarity transform, and ask whether the stage
# puts it back. Nothing here depends on a fixture file or on a human looking at
# a render.



def _similarity(scale, axis, degrees, translation):
    m = np.eye(4)
    m[:3, :3] = scale * trimesh.transformations.rotation_matrix(
        np.radians(degrees), axis)[:3, :3]
    m[:3, 3] = translation
    return m



def check_umeyama_recovers_a_known_transform():
    """The closed form itself, before any geometry is involved."""
    rng = np.random.default_rng(7)
    points = rng.normal(size=(200, 3))
    for truth in (_similarity(2.5, [0, 1, 0], 30, [1.0, -2.0, 0.5]),
                  _similarity(0.4, [1, 1, 0], 110, [-3.0, 0.2, 4.0]),
                  _similarity(1.0, [0, 0, 1], 75, [0, 0, 0])):
        moved = points @ truth[:3, :3].T + truth[:3, 3]
        scale, rotation, translation = umeyama(points, moved)
        got = np.eye(4)
        got[:3, :3] = scale * rotation
        got[:3, 3] = translation
        error = float(np.abs(got - truth).max())
        assert error < 1e-9, 'umeyama off by {:.2e}'.format(error)

    # A reflection must never be produced, even where one would fit better.
    _, rotation, _ = umeyama(points, points * [-1, 1, 1])
    determinant = float(np.linalg.det(rotation))
    assert determinant > 0.99, 'umeyama produced a reflection'
    return 'exact to 1e-9, never reflects'






def _upright(radius, height, centre_y, sections=48, capped=True):
    """A Y-axis cylinder centred at `centre_y`. Rotate first, THEN translate."""
    mesh = trimesh.creation.cylinder(radius=radius, height=height, sections=sections)
    if not capped:
        # Open-ended. A capped cuirass buries its end discs inside the torso
        # permanently, and no rigid move can ever clear those -- a fixture with
        # caps measures the cap, not the stage.
        keep = np.abs(mesh.triangles_center[:, 2]) < height / 2 * 0.98
        mesh = trimesh.Trimesh(mesh.vertices, mesh.faces[keep], process=False)
        mesh.remove_unreferenced_vertices()
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    mesh.apply_translation([0, centre_y, 0])
    return mesh


def _torso():
    """A body with its pivot on the ground, like a rigged human."""
    body = _upright(0.16, 1.7, 0.85)
    body = trimesh.Trimesh(body.vertices, body.faces, process=True)
    body.fix_normals()
    return body


def _cuirass(inner_radius, height=0.45, centre_y=1.05, thickness=0.02):
    """A shell AROUND the waist: an inner and an outer wall with air between."""
    shell = trimesh.util.concatenate([
        _upright(inner_radius, height, centre_y, capped=False),
        _upright(inner_radius + thickness, height, centre_y, capped=False),
    ])
    return trimesh.Trimesh(shell.vertices, shell.faces, process=False)


def _clipping(points, body, query):
    """How many of `points` are inside the body."""
    closest, ids = query.on_surface(points)
    outward = np.einsum('ij,ij->i', points - closest, np.asarray(body.face_normals)[ids])
    return int(np.count_nonzero(outward < 0))


def _seat_piece(body, piece_vertices, piece_faces, **kw):
    query = make_surface_query(body, 'cpu')
    try:
        matrix, stats = rigid_fit(piece_vertices, piece_faces, body, query,
                                  offset=0.006, iterations=15, **kw)
        before = _clipping(piece_vertices, body, query)
        seated = piece_vertices @ matrix[:3, :3].T + matrix[:3, 3]
        after = _clipping(seated, body, query)
    finally:
        if hasattr(query, 'free'):
            query.free()
    return matrix, stats, before, after


def check_rigid_leaves_a_clearanced_piece_alone():
    """THE regression test for the bug this stage shipped with.

    A cuirass has air inside it by definition. The first version's objective was
    "put the lining at the clearance offset", which asked it to become
    skin-tight, so it shrank by exactly the clearance it was built with --
    5 / 12 / 24 / 33 percent for clearances of 0.005 / 0.02 / 0.05 / 0.10 -- and
    on a real armour that read as the piece collapsing into the middle of the
    body the instant Fit was pressed.

    Nothing here is clipping, so the only correct answer is to do nothing.
    """
    body = _torso()
    for clearance in (0.01, 0.02, 0.05, 0.10, 0.20):
        piece = _cuirass(0.16 + clearance)
        matrix, stats, _before, _after = _seat_piece(
            body, np.asarray(piece.vertices), np.asarray(piece.faces))
        assert stats['kept_identity'], \
            'moved a clearanced piece (clearance {:.3f}, scale {:.3f})'.format(
                clearance, stats['scale'])
        assert float(np.abs(matrix - np.eye(4)).max()) < 1e-12, \
            'clearance {:.3f} produced a non-identity transform'.format(clearance)

    # A piece slightly TIGHTER than the requested clearance should be nudged out
    # to reach it -- by about the shortfall, and nothing like the clearance. The
    # old objective shrank this case by 5%; the right answer grows it by ~0.6%.
    tight = _cuirass(0.16 + 0.005)      # 0.001 short of the 0.006 offset
    _m, stats, _b, _a = _seat_piece(body, np.asarray(tight.vertices),
                                    np.asarray(tight.faces))
    assert stats['scale'] >= 1.0, \
        'a slightly tight piece was SHRUNK to {:.4f}x'.format(stats['scale'])
    assert stats['scale'] < 1.02, \
        'a 0.001 shortfall moved the piece {:.4f}x'.format(stats['scale'])
    return 'untouched from 0.01 to 0.20; a 0.001 shortfall grows only 0.6%'


def check_rigid_resolves_clipping():
    """What the stage is FOR: a piece that clips must clip less afterwards."""
    body = _torso()
    good = _cuirass(0.16 + 0.05)
    V, F = np.asarray(good.vertices), np.asarray(good.faces)

    _m, _s, before, after = _seat_piece(body, V + [0.12, 0, 0], F)
    assert after < before * 0.75, 'shoved sideways: clipping {} -> {}'.format(before, after)

    tilt = trimesh.transformations.rotation_matrix(np.radians(18), [0, 0, 1],
                                                   point=[0, 1.05, 0])
    _m, _s, before, after = _seat_piece(body, V @ tilt[:3, :3].T + tilt[:3, 3], F)
    assert after < before * 0.75, 'tilted: clipping {} -> {}'.format(before, after)

    # Too small clips all the way round, so growing it is the fix -- the one
    # sizing case the stage does handle.
    small = _cuirass(0.16 - 0.03)
    _m, stats, before, after = _seat_piece(body, np.asarray(small.vertices),
                                           np.asarray(small.faces))
    assert after < before * 0.6, 'too small: clipping {} -> {}'.format(before, after)
    assert stats['scale'] > 1.05, 'too small was not grown ({:.3f}x)'.format(stats['scale'])
    return 'shove, tilt and undersize all reduced'


def check_rigid_ignores_a_floating_piece():
    """A too-LARGE piece is left exactly where the user put it.

    Documented as a limit rather than fixed: every objective that pulls a
    floating piece inward also pulls a correctly-clearanced one inward, and
    there is no local measurement that separates the two. Gross sizing is Fit
    to region's job.
    """
    body = _torso()
    big = _cuirass(0.16 + 0.35)
    matrix, stats, _before, _after = _seat_piece(
        body, np.asarray(big.vertices), np.asarray(big.faces))
    assert stats['kept_identity'], 'a floating piece was moved'
    assert float(np.abs(matrix - np.eye(4)).max()) < 1e-12
    return 'left alone, by design'


def check_rigid_scale_rail_holds():
    """A piece that clips everywhere must still not be resized without limit."""
    body = _torso()
    tiny = _cuirass(0.02, height=0.45, centre_y=1.05, thickness=0.004)
    _m, stats, _before, _after = _seat_piece(
        body, np.asarray(tiny.vertices), np.asarray(tiny.faces), scale_limit=1.5)
    assert 1 / 1.5 - 1e-6 <= stats['scale'] <= 1.5 + 1e-6, \
        'scale {:.3f} escaped the 1.5x rail'.format(stats['scale'])

    small = _cuirass(0.16 - 0.03)
    _m, fixed, _b, _a = _seat_piece(body, np.asarray(small.vertices),
                                    np.asarray(small.faces), allow_scale=False)
    assert abs(fixed['scale'] - 1.0) < 1e-6, \
        'allow_scale=False resized by {:.4f}'.format(fixed['scale'])
    return 'rail holds at {:.3f}, allow_scale=False holds 1.000'.format(stats['scale'])


def check_rigid_never_changes_the_mesh():
    """A seating is a PLACEMENT.

    Every distance inside the piece must survive it up to one uniform scale --
    that is the entire reason plate goes through this stage instead of the
    conform, so it is worth asserting rather than trusting. Run on a piece that
    genuinely moves, or the check passes on an identity transform and proves
    nothing.
    """
    body = _torso()
    small = _cuirass(0.16 - 0.03)
    V, F = np.asarray(small.vertices), np.asarray(small.faces)
    matrix, stats, _before, _after = _seat_piece(body, V, F)
    assert not stats['kept_identity'], 'fixture did not move; the check proves nothing'
    seated = V @ matrix[:3, :3].T + matrix[:3, 3]

    rng = np.random.default_rng(3)
    a = rng.integers(0, len(V), 400)
    b = rng.integers(0, len(V), 400)
    before = np.linalg.norm(V[a] - V[b], axis=1)
    after = np.linalg.norm(seated[a] - seated[b], axis=1)
    usable = before > 1e-9
    ratio = after[usable] / before[usable]
    spread = float(ratio.max() - ratio.min())
    assert spread < 1e-6, 'the piece was deformed: spread {:.2e}'.format(spread)
    return 'rigid to {:.1e}, uniform scale {:.4f}'.format(spread, ratio.mean())


def check_warp_recovers_a_known_deformation():
    """Apply a known stretch, sample landmarks from it, and warp it back.

    The self-verifying case: if the spline is right, feeding it pairs taken from
    a deformation it did not see must reproduce that deformation everywhere, not
    just at the pairs.

    Asserted as CONVERGENCE rather than against a fixed tolerance. A thin-plate
    spline through n samples of a nonlinear deformation carries real
    interpolation error between them -- 0.17 at 6 pairs, 0.0003 at 200 on this
    fixture -- so any single threshold is either a tautology or a fixture
    detail. What must hold is that it lands its own landmarks exactly and gets
    steadily better as more are placed, which is also the behaviour to promise
    the user.
    """
    rng = np.random.default_rng(11)
    piece = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    V = np.asarray(piece.vertices)

    # A non-uniform stretch plus a bend -- exactly the class of thing a
    # similarity transform cannot express, which is why this stage exists.
    def truth(points):
        out = points * [1.45, 0.72, 1.0]
        out[:, 0] += 0.18 * out[:, 1] ** 2
        return out

    errors = []
    for count in (6, 24, 96):
        sample = rng.choice(len(V), count, replace=False)
        moved, stats = warp(V, V[sample], truth(V[sample]), body_diagonal=4.0,
                            max_move_ratio=1.0)
        assert stats['landmark_rms'] < 1e-9,             '{} pairs: the spline missed its own landmarks by {:.2e}'.format(
                count, stats['landmark_rms'])
        errors.append(float(np.abs(moved - truth(V)).max()))

    assert errors[0] > errors[1] > errors[2],         'error did not fall as landmarks were added: {}'.format(
            [round(e, 4) for e in errors])
    assert errors[-1] < 0.01,         '96 pairs still off by {:.4f}'.format(errors[-1])
    return 'landmarks exact; error {:.3f} -> {:.3f} -> {:.4f} for 6/24/96 pairs'.format(*errors)


def check_warp_rejects_unusable_landmarks():
    """Too few, or all on one plane: an error, never a silent no-op.

    The user placed those points by hand. Quietly doing nothing with them is the
    worst available outcome.
    """
    piece = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    V = np.asarray(piece.vertices)

    for count in (0, 1, 3):
        try:
            warp(V, V[:count], V[:count] + 0.1, body_diagonal=4.0)
        except ValueError:
            pass
        else:
            raise AssertionError('{} pairs was accepted'.format(count))

    # Six points on a plane cannot determine a 3D deformation.
    flat = np.array([[x, 0.0, z] for x in (-1.0, 0.0, 1.0) for z in (-1.0, 1.0)])
    try:
        warp(V, flat, flat + [0.0, 0.2, 0.0], body_diagonal=4.0)
    except ValueError:
        pass
    else:
        raise AssertionError('a coplanar landmark set was accepted')
    assert coplanarity(flat) < 1e-9
    return 'rejects 0/1/3 pairs and coplanar sets'


def check_warp_decays_to_identity_far_away():
    """A vertex nowhere near any landmark must barely move.

    Without the bbox-corner anchors a thin-plate spline's affine tail carries
    distant geometry off with it -- a cape's hem following a landmark placed on
    the collarbone. This is the check that the anchors are doing their job.
    """
    rng = np.random.default_rng(5)
    near = rng.normal(scale=0.2, size=(200, 3))
    far = np.array([[9.0, 9.0, 9.0], [-9.0, 9.0, -9.0]])
    V = np.vstack([near, far])

    # Landmarks clustered at the origin, asking for a big local move.
    source = rng.normal(scale=0.15, size=(8, 3))
    target = source + [0.5, 0.0, 0.0]
    moved, _stats = warp(V, source, target, body_diagonal=20.0, max_move_ratio=1.0)

    near_move = float(np.linalg.norm(moved[:200] - near, axis=1).mean())
    far_move = float(np.linalg.norm(moved[200:] - far, axis=1).max())
    assert near_move > 0.2, 'the landmarked region barely moved ({:.3f})'.format(near_move)
    assert far_move < near_move * 0.25, \
        'distant geometry moved {:.3f} against {:.3f} nearby'.format(far_move, near_move)
    return 'near {:.3f} vs far {:.3f}'.format(near_move, far_move)


def check_warp_clamp_bounds_the_damage():
    """No vertex may exceed the amplification cap.

    Isolated from the abort by turning that off, so this measures the clamp
    itself rather than the circuit breaker in front of it.
    """
    piece = trimesh.creation.cylinder(radius=0.09, height=0.42, sections=24)
    V = np.asarray(piece.vertices)
    # The ill-conditioned arrangement, which is what actually produces a large
    # response to a small request. A WILDLY inconsistent set does not: its
    # request is huge, so the cap it earns is huge too and nothing is clamped.
    source = np.array([[0.0, 0.0, z] for z in (-0.16, -0.05, 0.05, 0.16)])
    source[:, 0] += np.array([0.004, -0.003, 0.002, -0.004])
    source[:, 1] += np.array([-0.002, 0.003, -0.004, 0.002])
    target = source + np.array([[0.02, 0.01, 0.0], [0.004, 0.0, 0.0],
                                [0.02, -0.01, 0.0], [0.005, 0.0, 0.0]])

    moved, stats = warp(V, source, target, max_amplification=2.0,
                        max_move_ratio=0.0, clamp_abort_frac=0.0)
    limit = 2.0 * stats['requested_max']
    worst = float(np.linalg.norm(moved - V, axis=1).max())
    assert worst <= limit + 1e-9, 'a vertex moved {:.4f}, over the {:.4f} cap'.format(worst, limit)
    assert stats['clamped_vertices'] > 0, 'the clamp never engaged on a runaway set'
    return '{} vertices clamped at {:.3f} (amplification {:.1f}x)'.format(
        stats['clamped_vertices'], limit, stats['amplification'])


def check_warp_refuses_an_ill_conditioned_set():
    """THE regression test for a warp that destroyed a boot.

    Four pairs placed down the length of a tall thin piece, each asking for a
    tiny correction. The set spans 28x less across the piece than along it, so
    the spline's affine part is ill-conditioned: measured on the real case, it
    moved vertices 0.336 when the largest request was 0.065, and stretched the
    piece from 0.27 deep to 0.75.

    Refusing is the point. A heavily-clamped warp is not a good result, it is a
    less-mangled bad one, and returning it with no complaint is how the user
    ends up staring at a mangled boot wondering what they did wrong.
    """
    # A boot-shaped piece: tall, and much thinner than it is long.
    piece = trimesh.creation.cylinder(radius=0.09, height=0.42, sections=24)
    V = np.asarray(piece.vertices)

    # Landmarks strung along the axis, barely spread across it.
    source = np.array([[0.0, 0.0, z] for z in (-0.16, -0.05, 0.05, 0.16)])
    source[:, 0] += np.array([0.004, -0.003, 0.002, -0.004])
    source[:, 1] += np.array([-0.002, 0.003, -0.004, 0.002])
    target = source + np.array([[0.02, 0.01, 0.0], [0.004, 0.0, 0.0],
                                [0.02, -0.01, 0.0], [0.005, 0.0, 0.0]])

    singular = np.linalg.svd(source - source.mean(axis=0), compute_uv=False)
    assert singular[0] / max(singular[-1], 1e-12) > 10, 'fixture is not ill-conditioned'

    try:
        warp(V, source, target)
    except ValueError as error:
        message = str(error)
        assert 'spread' in message, 'the refusal must say what to do about it'
        return 'refused: {}...'.format(message[:58])
    raise AssertionError('an ill-conditioned landmark set was accepted')


def check_warp_accepts_a_well_spread_set():
    """The other half: spreading the SAME number of pairs must work.

    Without this the abort could pass by refusing everything, and the guidance
    ("spread them out") would be untested folklore.
    """
    piece = trimesh.creation.cylinder(radius=0.09, height=0.42, sections=24)
    V = np.asarray(piece.vertices)
    centre = V.mean(axis=0)

    # Four pairs, but spread over the piece in all three directions.
    # A tetrahedron: the minimal arrangement that actually spans 3D. The obvious
    # "one point per face" quad is coplanar and gets refused, which is the
    # guidance working rather than a bug.
    source = np.array([
        [0.09, 0.0, -0.16], [-0.045, 0.078, -0.16],
        [-0.045, -0.078, -0.16], [0.0, 0.0, 0.19],
    ])
    target = centre + (source - centre) * 0.94      # a modest, coherent squeeze

    moved, stats = warp(V, source, target)
    assert stats['amplification'] < 1.5,         'a well-spread set amplified {:.2f}x'.format(stats['amplification'])
    assert stats['clamped_vertices'] == 0,         '{} vertices clamped on a healthy set'.format(stats['clamped_vertices'])
    ratio = (moved.max(axis=0) - moved.min(axis=0)) / (V.max(axis=0) - V.min(axis=0))
    assert np.all(np.abs(ratio - 0.94) < 0.05),         'the requested squeeze came out as {}'.format(np.round(ratio, 3))
    return 'amplification {:.2f}, squeeze reproduced as {}'.format(
        stats['amplification'], np.round(ratio, 3))


def check_warp_keeps_topology():
    """Vertex count and order are the endpoint's contract."""
    V = np.asarray(trimesh.creation.icosphere(subdivisions=3, radius=1.0).vertices)
    rng = np.random.default_rng(9)
    sample = rng.choice(len(V), 8, replace=False)
    moved, _stats = warp(V, V[sample], V[sample] * 1.2, body_diagonal=4.0)
    assert moved.shape == V.shape, 'shape changed {} -> {}'.format(V.shape, moved.shape)
    return 'shape {} preserved'.format(moved.shape)


CHECKS = [
    ('umeyama recovers a known transform', check_umeyama_recovers_a_known_transform),
    ('rigid leaves a clearanced piece alone', check_rigid_leaves_a_clearanced_piece_alone),
    ('rigid resolves clipping', check_rigid_resolves_clipping),
    ('rigid ignores a floating piece', check_rigid_ignores_a_floating_piece),
    ('rigid scale rail holds', check_rigid_scale_rail_holds),
    ('rigid never changes the mesh', check_rigid_never_changes_the_mesh),
    ('warp recovers a known deformation', check_warp_recovers_a_known_deformation),
    ('warp rejects unusable landmarks', check_warp_rejects_unusable_landmarks),
    ('warp decays to identity far away', check_warp_decays_to_identity_far_away),
    ('warp clamp bounds the damage', check_warp_clamp_bounds_the_damage),
    ('warp refuses an ill-conditioned set', check_warp_refuses_an_ill_conditioned_set),
    ('warp accepts a well-spread set', check_warp_accepts_a_well_spread_set),
    ('warp keeps topology', check_warp_keeps_topology),
    ('shell thickness is preserved', check_thickness_is_preserved),
    ('unwelded seams stay closed', check_unwelded_seams_stay_closed),
    ('shrinkwrap reaches the offset surface', check_shrinkwrap_reaches_offset),
    ('topology is untouched', check_shrinkwrap_preserves_topology),
    ('penetration scope leaves the outside alone', check_penetration_leaves_outside_alone),
    ('max_distance guard holds', check_max_distance_guard),
    ('no faces are flipped', check_no_flipped_faces),
    ('the offset clearance is respected', check_offset_is_respected),
]


def run_all(verbose=True):
    failures = 0
    for label, check in CHECKS:
        try:
            result = check()
            if verbose:
                print(f'  pass  {label}' + (f'  -> {result}' if result is not None else ''))
        except AssertionError as error:
            failures += 1
            print(f'  FAIL  {label}\n        {error}')
        except Exception as error:  # noqa: BLE001 - report, do not mask
            failures += 1
            print(f'  ERROR {label}\n        {type(error).__name__}: {error}')
    print(f'\n{len(CHECKS) - failures}/{len(CHECKS)} checks passed')
    return failures
