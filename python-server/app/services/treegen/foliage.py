"""Phase 3 -- foliage cards.

Three things decide whether foliage reads as a tree or as a pile of cardboard:

*Normals, not shape.* A leaf card's true geometric normal is the card's own
plane, which means every leaf on one side of the tree is lit identically and the
canopy flattens into a decal. Overwriting the normals with the direction from
the crown centre outward -- "spherical normals" -- makes the canopy shade like
the rounded volume it is meant to represent. This is the single biggest visual
win in the whole generator and it costs one normalize per vertex.

*Clusters, not cards.* A leaf-per-node tree is 40k cards and unusable. A cluster
is a small fan of cards baked as one placement: from any angle it reads as a
volume of leaves, for a fraction of the placements. It is the default and the
budget is a hard cap, both from day one rather than as a later optimization.

*Phyllotaxis, not random.* Leaves advance by the golden angle around the branch,
which is both what real plants do and what stops the eye finding rows.
"""
from __future__ import annotations

import numpy as np

from .bark import _branch_phase, _tangents, rotation_minimizing_frames
from .skeleton import TreeSkeleton
from .spec import TreeSpec

_EPS = 1e-12


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, _EPS)


def _rotate(axis: np.ndarray, angle: np.ndarray, vector: np.ndarray) -> np.ndarray:
    """Rodrigues rotation with a per-row axis and per-row angle."""
    axis = _unit(axis)
    cos = np.cos(angle)[:, None]
    sin = np.sin(angle)[:, None]
    dot = np.sum(axis * vector, axis=1)[:, None]
    return _unit(vector * cos + np.cross(axis, vector) * sin + axis * dot * (1.0 - cos))


def _collect_placements(spec: TreeSpec, skeleton: TreeSkeleton):
    """Walk every eligible chain and drop placements at even arc-length spacing.

    Returns parallel arrays: position, branch tangent, radial reference (the
    phyllotaxis zero angle), host chain index, and stiffness at the host node.
    """
    spacing = max(spec.foliage.spacing_ratio * spec.height, 1e-4)
    # Relative to the AUTHORED trunk radius, not the height and not radii[0]:
    # radii[0] carries the root flare, which would make the threshold wander
    # with a cosmetic setting that has nothing to do with where leaves grow.
    trunk_radius = max(spec.branching.trunk_radius_ratio * spec.height, 1e-9)
    max_radius = spec.foliage.max_radius_ratio * trunk_radius
    min_order = int(spec.foliage.min_order)
    golden = np.radians(float(spec.foliage.phyllotaxis_deg))
    max_arclength = float(skeleton.arclength.max()) if len(skeleton.arclength) else 1.0

    positions, tangents, references, chain_ids, stiffness, radii = [], [], [], [], [], []
    angle_counter = 0

    for chain_index, chain in enumerate(skeleton.chains):
        if len(chain) < 2:
            continue
        # A chain's order is the order of its own nodes; chain[0] is the parent
        # fork, which belongs to the parent branch, so read chain[1].
        if int(skeleton.order[int(chain[1])]) < min_order:
            continue

        nodes = chain[1:] if int(skeleton.parents[int(chain[0])]) >= 0 else chain
        if len(nodes) < 2:
            continue

        points = skeleton.positions[nodes]
        node_radii = skeleton.radii[nodes]
        if float(node_radii.min()) > max_radius:
            continue

        chain_tangents = _tangents(points)
        chain_reference = rotation_minimizing_frames(points, chain_tangents)
        chain_binormal = np.cross(chain_tangents, chain_reference)

        segment_lengths = np.linalg.norm(np.diff(points, axis=0), axis=1)
        cumulative = np.concatenate([[0.0], np.cumsum(segment_lengths)])
        total = float(cumulative[-1])
        if total < spacing * 0.5:
            continue

        samples = np.arange(spacing * 0.5, total, spacing)
        if samples.size == 0:
            continue

        # Interpolate everything to the sample positions in one shot.
        upper = np.searchsorted(cumulative, samples).clip(1, len(cumulative) - 1)
        lower = upper - 1
        span = np.maximum(cumulative[upper] - cumulative[lower], _EPS)
        t = ((samples - cumulative[lower]) / span)[:, None]

        sample_points = points[lower] * (1 - t) + points[upper] * t
        sample_radii = (node_radii[lower] * (1 - t[:, 0]) + node_radii[upper] * t[:, 0])
        sample_tangents = _unit(chain_tangents[lower] * (1 - t) + chain_tangents[upper] * t)
        sample_reference = chain_reference[lower]
        sample_binormal = chain_binormal[lower]

        keep = sample_radii <= max_radius
        if not np.any(keep):
            continue

        # Phyllotaxis: the angle keeps advancing across the whole tree, not per
        # branch, so neighbouring branches do not all start their spiral at the
        # same place and produce visible rows.
        angles = (angle_counter + np.arange(len(samples))) * golden
        angle_counter += len(samples)
        radial = (sample_reference * np.cos(angles)[:, None]
                  + sample_binormal * np.sin(angles)[:, None])

        positions.append(sample_points[keep])
        tangents.append(sample_tangents[keep])
        references.append(_unit(radial[keep]))
        radii.append(sample_radii[keep])
        chain_ids.append(np.full(int(keep.sum()), chain_index, dtype=np.int64))
        stiffness.append(1.0 - np.clip(
            (skeleton.arclength[nodes][lower][keep]) / max(max_arclength, _EPS), 0.0, 1.0))

    if not positions:
        empty = np.zeros((0, 3))
        return empty, empty, empty, np.zeros(0), np.zeros(0, dtype=np.int64), np.zeros(0)

    return (np.concatenate(positions), np.concatenate(tangents), np.concatenate(references),
            np.concatenate(radii), np.concatenate(chain_ids), np.concatenate(stiffness))


def build_foliage(spec: TreeSpec, skeleton: TreeSkeleton, crown_centre: np.ndarray,
                  rng: np.random.Generator):
    """Emit the foliage mesh. Returns (vertices, faces, normals, uvs, wind, stats)."""
    empty = (np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64), np.zeros((0, 3)),
             np.zeros((0, 2)), np.zeros((0, 4)), {"cards": 0, "placements": 0})
    if not spec.foliage.enabled or spec.foliage.max_cards <= 0:
        return empty

    position, tangent, reference, host_radius, chain_id, stiffness = _collect_placements(spec, skeleton)
    if len(position) == 0:
        return empty

    cards_each = int(spec.foliage.cluster_cards) if spec.foliage.mode == "clusters" else 1
    budget = int(spec.foliage.max_cards)
    placements = len(position)
    eligible = placements

    # Enforce the budget by thinning PLACEMENTS, not by truncating the list --
    # truncation would strip the foliage off whichever branches happened to be
    # built last and leave the tree bald on one side.
    max_placements = max(budget // cards_each, 1)
    if placements > max_placements:
        chosen = rng.choice(placements, size=max_placements, replace=False)
        chosen.sort()
        position, tangent, reference = position[chosen], tangent[chosen], reference[chosen]
        host_radius, chain_id, stiffness = host_radius[chosen], chain_id[chosen], stiffness[chosen]
        placements = max_placements

    size = spec.foliage.size_ratio * spec.height
    jitter = float(spec.foliage.size_jitter)
    aspect = float(spec.foliage.aspect)
    droop = np.radians(float(spec.foliage.droop_deg))
    tilt_max = np.radians(float(spec.foliage.tilt_jitter_deg))
    spread = float(spec.foliage.cluster_spread)
    align = float(spec.foliage.align_ratio)

    vertex_blocks, face_blocks, normal_blocks, uv_blocks, wind_blocks = [], [], [], [], []
    offset = 0

    # UV atlas: one random tile per card, inset by half a texel-ish margin so
    # bilinear filtering cannot drag a neighbouring leaf into this one.
    cols, rows = int(spec.foliage.atlas_cols), int(spec.foliage.atlas_rows)
    # Only draw from cells that hold a leaf -- see FoliageSpec.atlas_tiles.
    tile_count = int(spec.foliage.atlas_tiles) or (cols * rows)
    tile_count = max(min(tile_count, cols * rows), 1)
    inset = 0.002
    corner_uv = np.array([[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]])

    for card in range(cards_each):
        n = placements
        # Fan the cluster's cards around the outward axis. An even sweep (rather
        # than random angles) is what makes a 4-card cluster read as a volume
        # from every direction instead of edge-on from one.
        if cards_each > 1:
            fan = np.pi * card / cards_each + rng.uniform(-0.15, 0.15, n)
        else:
            fan = np.zeros(n)

        out = _rotate(tangent, fan, reference)
        # Swing the growth direction toward the branch itself. A leaf card is
        # radial by nature -- it sticks out sideways -- but a palm frond or a
        # conifer needle spray runs *along* its branch, and rendered radially
        # they come out as stubby paddles no matter how the size is tuned.
        if align > 0.0:
            out = _unit(out * (1.0 - align) + tangent * align)
        # Droop: pitch the leaf toward world down, about the axis perpendicular
        # to both the leaf direction and gravity.
        pitch_axis = _unit(np.cross(out, np.array([0.0, 1.0, 0.0])))
        degenerate = np.linalg.norm(np.cross(out, np.array([0.0, 1.0, 0.0])), axis=1) < 1e-6
        pitch_axis[degenerate] = tangent[degenerate]
        out = _rotate(pitch_axis, np.full(n, droop) + rng.uniform(-0.2, 0.2, n), out)

        side = _unit(np.cross(out, tangent))
        flat = np.linalg.norm(np.cross(out, tangent), axis=1) < 1e-6
        side[flat] = _unit(np.cross(out[flat], np.array([[0.0, 0.0, 1.0]])))

        # Random tilt about the leaf's own growth direction: breaks the shared
        # plane a whole branch's leaves would otherwise sit in.
        tilt = rng.uniform(-tilt_max, tilt_max, n)
        side = _rotate(out, tilt, side)

        width = size * (1.0 + rng.uniform(-jitter, jitter, n))[:, None]
        height = width * aspect
        base = position + out * host_radius[:, None] * 0.9
        if cards_each > 1 and spread > 0.0:
            base = base + side * (rng.uniform(-spread, spread, n)[:, None] * size * 0.5)

        half = side * width * 0.5
        corners = np.stack([
            base - half,
            base + half,
            base + half + out * height,
            base - half + out * height,
        ], axis=1).reshape(-1, 3)

        # Spherical normals -- the payoff described in the module docstring.
        card_normal = _unit(np.cross(side, out))
        spherical = _unit(position - crown_centre[None, :])
        blend = float(spec.foliage.spherical_normals)
        shaded = _unit(card_normal * (1.0 - blend) + spherical * blend)
        # Keep the shading normal on the same side as the card's own facing, or
        # half the canopy renders inside-out.
        flip = np.sum(shaded * card_normal, axis=1) < 0.0
        shaded[flip] *= -1.0
        normals = np.repeat(shaded, 4, axis=0)

        tile = rng.integers(0, tile_count, size=n)
        tile_col = (tile % cols)[:, None]
        tile_row = (tile // cols)[:, None]
        uv = np.empty((n, 4, 2))
        uv[:, :, 0] = (tile_col + corner_uv[None, :, 0]) / cols
        uv[:, :, 1] = (tile_row + corner_uv[None, :, 1]) / rows
        uv = uv.reshape(-1, 2)

        quad = np.arange(n)[:, None] * 4
        faces = np.concatenate([
            np.concatenate([quad, quad + 1, quad + 2], axis=1),
            np.concatenate([quad, quad + 2, quad + 3], axis=1),
        ], axis=0)

        if spec.output.wind_colors:
            phase = np.array([_branch_phase(int(c)) for c in chain_id])
            flutter = rng.random(n)
            wind = np.stack([phase, stiffness, flutter, np.ones(n)], axis=1)
            wind_blocks.append(np.repeat(wind, 4, axis=0))

        vertex_blocks.append(corners)
        face_blocks.append(faces + offset)
        normal_blocks.append(normals)
        uv_blocks.append(uv)
        offset += len(corners)

    vertices = np.concatenate(vertex_blocks)
    faces = np.concatenate(face_blocks).astype(np.int64)
    normals = np.concatenate(normal_blocks)
    uvs = np.concatenate(uv_blocks)
    wind = np.concatenate(wind_blocks) if wind_blocks else np.zeros((len(vertices), 4))

    stats = {
        "placements": int(placements),
        "cards": int(placements * cards_each),
        "mode": spec.foliage.mode,
        "budget": budget,
        "budget_hit": bool(placements * cards_each >= budget),
        # Which constraint actually bound. Without this the leaf budget looks
        # broken whenever it is not the binding one: raising it changes nothing
        # and there is no way to tell that spacing or the radius filter is what
        # is holding the count down.
        "limited_by": "budget" if placements * cards_each >= budget else "placements",
        "eligible_placements": int(eligible),
    }
    return vertices, faces, normals, uvs, wind, stats
