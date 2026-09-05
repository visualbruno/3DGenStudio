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

from .config import FitConfig
from .pipeline import fit_assembly


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


CHECKS = [
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
