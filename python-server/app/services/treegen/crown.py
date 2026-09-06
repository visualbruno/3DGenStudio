"""Crown envelopes and seeded attraction-point sampling.

The envelope is what gives a species its silhouette -- a cone reads as a
conifer before a single branch is drawn -- so it is the first thing the
generator resolves and the only thing the colonization loop knows about the
crown.

Sampling is Poisson-disc *thinned*, not pure random: clumped attractors make
colonization grow a few fat branches into the clump and leave holes elsewhere,
which is exactly the "CG tree" look the whole approach is meant to avoid.
Bridson's algorithm does not fit an arbitrary envelope cheaply, so this does
dart-throwing into a uniform pool followed by a grid-accelerated min-distance
pass -- same result, no dependency, and deterministic under a seeded RNG.
"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass

import numpy as np

from .spec import TreeSpec


@dataclass
class Crown:
    """A resolved crown envelope in world space (Y up, base at y=0)."""

    centre: np.ndarray      # (3,) centre of the envelope box
    radius: float           # horizontal half-extent
    bottom: float           # world Y of the envelope floor
    top: float              # world Y of the envelope ceiling
    contains: object        # callable: (N,3) -> (N,) bool

    @property
    def half_height(self) -> float:
        return max((self.top - self.bottom) * 0.5, 1e-6)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        lo = np.array([self.centre[0] - self.radius, self.bottom, self.centre[2] - self.radius])
        hi = np.array([self.centre[0] + self.radius, self.top, self.centre[2] + self.radius])
        return lo, hi


def _normalized(points: np.ndarray, crown_centre: np.ndarray, radius: float, half_height: float) -> np.ndarray:
    """Map world points into the unit box of the envelope: x,z in [-1,1], y in [-1,1]."""
    out = np.empty_like(points)
    out[:, 0] = (points[:, 0] - crown_centre[0]) / radius
    out[:, 1] = (points[:, 1] - crown_centre[1]) / half_height
    out[:, 2] = (points[:, 2] - crown_centre[2]) / radius
    return out


def _load_custom_envelope(spec: TreeSpec, centre, radius, bottom, top):
    """Fit a user mesh into the crown box and use its containment test.

    This is the one place LSCM-style generality is worth it: the user hands over
    any shape (a topiary, a game silhouette) and the branches fill it.
    """
    import trimesh

    raw = base64.b64decode(spec.crown.custom_mesh_b64 or "")
    if not raw:
        raise ValueError("crown.shape is 'custom' but no custom_mesh_b64 was supplied.")

    # The payload can be any format trimesh sniffs; try GLB first (what the UI
    # sends), then let trimesh guess.
    try:
        loaded = trimesh.load(io.BytesIO(raw), file_type="glb", process=False)
    except Exception:  # noqa: BLE001 -- fall through to the generic sniffing path
        loaded = trimesh.load(io.BytesIO(raw), process=False)
    if isinstance(loaded, trimesh.Scene):
        if not loaded.geometry:
            raise ValueError("The custom crown mesh contains no geometry.")
        loaded = trimesh.util.concatenate(tuple(loaded.geometry.values()))

    mesh = loaded.copy()
    lo, hi = mesh.bounds
    size = np.maximum(hi - lo, 1e-9)
    target = np.array([2.0 * radius, top - bottom, 2.0 * radius])
    factor = float(np.min(target / size))  # uniform: a stretched envelope reads as a stretched tree
    mesh.apply_translation(-(lo + hi) * 0.5)
    mesh.apply_scale(factor)
    mesh.apply_translation([centre[0], (bottom + top) * 0.5, centre[2]])

    def contains(points: np.ndarray) -> np.ndarray:
        if len(points) == 0:
            return np.zeros(0, dtype=bool)
        return mesh.contains(points)

    return contains


def build_crown(spec: TreeSpec) -> Crown:
    """Resolve the spec's crown into an envelope with a containment test."""
    radius = max(spec.crown_radius, 1e-4)
    bottom = spec.crown_base
    top = spec.crown_top
    centre = np.array([
        spec.crown.offset_x * spec.height,
        (bottom + top) * 0.5,
        spec.crown.offset_z * spec.height,
    ], dtype=np.float64)
    half_height = max((top - bottom) * 0.5, 1e-6)
    shape = spec.crown.shape

    if shape == "custom":
        contains = _load_custom_envelope(spec, centre, radius, bottom, top)
        return Crown(centre=centre, radius=radius, bottom=bottom, top=top, contains=contains)

    def contains(points: np.ndarray) -> np.ndarray:
        if len(points) == 0:
            return np.zeros(0, dtype=bool)
        n = _normalized(np.asarray(points, dtype=np.float64), centre, radius, half_height)
        x, y, z = n[:, 0], n[:, 1], n[:, 2]
        rad2 = x * x + z * z
        inside_box = (y >= -1.0) & (y <= 1.0)

        if shape in ("ellipsoid", "sphere"):
            return rad2 + y * y <= 1.0
        if shape == "hemisphere":
            # Flat floor, domed top: the classic broad canopy.
            t = (y + 1.0) * 0.5  # 0 at floor, 1 at ceiling
            return inside_box & (rad2 <= np.maximum(1.0 - t * t, 0.0))
        if shape == "cone":
            t = (y + 1.0) * 0.5
            return inside_box & (rad2 <= np.maximum(1.0 - t, 0.0) ** 2)
        if shape == "inverted_cone":
            t = (y + 1.0) * 0.5
            return inside_box & (rad2 <= np.maximum(t, 0.0) ** 2)
        if shape == "cylinder":
            return inside_box & (rad2 <= 1.0)
        if shape == "umbrella":
            # A shell near the top only: palms carry fronds in a crest, not a
            # solid volume, and filling the volume gives a bushy blob instead.
            thickness = float(spec.crown.shell_thickness)
            r = np.sqrt(rad2)
            dome = np.sqrt(np.maximum(1.0 - rad2, 0.0))  # unit dome height at this radius
            return inside_box & (r <= 1.0) & (y >= dome - thickness * 2.0) & (y <= dome + 1e-6)
        # Unknown shape: behave like the box so generation never hard-fails.
        return inside_box & (rad2 <= 1.0)

    return Crown(centre=centre, radius=radius, bottom=bottom, top=top, contains=contains)


def _poisson_thin(points: np.ndarray, min_dist: float, target: int) -> np.ndarray:
    """Greedy min-distance thinning over a uniform grid.

    O(n) with a dict of occupied cells: each candidate only compares against the
    27 neighbouring cells, and a cell of side `min_dist` holds at most one
    accepted point.
    """
    if len(points) == 0 or min_dist <= 0:
        return points[:target]

    cell = min_dist
    grid: dict[tuple[int, int, int], np.ndarray] = {}
    accepted: list[np.ndarray] = []
    min_sq = min_dist * min_dist
    neighbourhood = [(dx, dy, dz)
                     for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)]

    for p in points:
        key = (int(np.floor(p[0] / cell)), int(np.floor(p[1] / cell)), int(np.floor(p[2] / cell)))
        clash = False
        for dx, dy, dz in neighbourhood:
            other = grid.get((key[0] + dx, key[1] + dy, key[2] + dz))
            if other is not None:
                d = p - other
                if d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < min_sq:
                    clash = True
                    break
        if clash:
            continue
        grid[key] = p
        accepted.append(p)
        if len(accepted) >= target:
            break

    return np.asarray(accepted, dtype=np.float64) if accepted else points[:1]


def sample_attractors(spec: TreeSpec, crown: Crown, rng: np.random.Generator) -> np.ndarray:
    """Sample `spec.skeleton.attractors` Poisson-ish points inside the envelope.

    Returns fewer than requested when the envelope is too small to hold them at
    the implied spacing -- which is the correct behaviour: the tree just grows
    fewer branches rather than clumping them.
    """
    target = int(spec.skeleton.attractors)
    if target <= 0:
        return np.zeros((0, 3), dtype=np.float64)

    lo, hi = crown.bounds()
    box_volume = float(np.prod(np.maximum(hi - lo, 1e-9)))

    # Oversample the box, keep what lands inside, then thin. 4x is the knee:
    # thinning is a Python loop over the pool, so a larger pool buys very little
    # blue-noise quality for a linear slice of the generation budget.
    pool: list[np.ndarray] = []
    kept = 0
    tried = 0
    attempts = 0
    want_pool = target * 4
    while kept < want_pool and attempts < 24:
        batch = rng.uniform(lo, hi, size=(max(want_pool - kept, 1024), 3))
        tried += len(batch)
        inside = batch[crown.contains(batch)]
        if len(inside):
            pool.append(inside)
            kept += len(inside)
        attempts += 1
        if len(inside) == 0 and attempts >= 4:
            break  # a degenerate envelope; stop burning cycles
    if not pool:
        return np.zeros((0, 3), dtype=np.float64)

    points = np.concatenate(pool, axis=0)
    # Measured before the density bias thins it further -- this is the envelope's
    # share of its own bounding box, not the survival rate of the bias.
    inside_fraction = min(max(kept / max(tried, 1), 1e-3), 1.0)

    # Density bias: push points toward the shell (+) or the core (-). Applied as
    # a rejection over the normalized radial coordinate so it composes with any
    # envelope shape.
    bias = float(spec.crown.shell_bias)
    if abs(bias) > 1e-4:
        n = _normalized(points, crown.centre, crown.radius, crown.half_height)
        t = np.clip(np.linalg.norm(n, axis=1), 0.0, 1.0)  # 0 = centre, 1 = shell
        weight = t ** (3.0 * bias) if bias > 0 else (1.0 - t) ** (-3.0 * bias)
        weight = np.clip(weight, 1e-6, 1.0)
        points = points[rng.random(len(points)) < weight]
        if len(points) == 0:
            points = np.concatenate(pool, axis=0)

    rng.shuffle(points)

    # Spacing implied by packing `target` points into the sampled volume. The
    # 0.75 factor keeps thinning from starving the target on a tight envelope.
    envelope_volume = box_volume * inside_fraction
    min_dist = 0.75 * (envelope_volume / max(target, 1)) ** (1.0 / 3.0)

    return _poisson_thin(points, min_dist, target)
