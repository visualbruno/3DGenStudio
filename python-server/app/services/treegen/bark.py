"""Phase 2 + 4 -- bark geometry by swept generalized cylinders, with analytic UVs.

Two decisions carry this module:

*Rotation-minimizing frames.* A naive Frenet frame flips its normal through
every inflection of a branch, and the sweep twists visibly where it does. The
double-reflection method (Wang et al., "Computation of Rotation Minimizing
Frames", 2008) propagates the frame with two reflections per segment, is exact
to O(h^4), and costs a handful of dot products.

*Analytic cylindrical UVs, not the autouv/LSCM path.* A swept cylinder has a
closed-form parameterization with literally zero distortion: u is the angle, v
is the arc length. Running LSCM over it would be slower, seam it arbitrarily,
and produce a worse result than the exact answer. LSCM stays reserved for the
user's custom crown meshes.

Junctions are deliberately NOT booleaned -- see `_socket_point` and the
`junction_mode` note in spec.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .skeleton import TreeSkeleton
from .spec import TreeSpec

_EPS = 1e-12
_TWO_PI = 2.0 * np.pi


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, _EPS)


def _perpendicular(t: np.ndarray) -> np.ndarray:
    """Any unit vector perpendicular to t, chosen to avoid the degenerate axis."""
    helper = np.array([0.0, 0.0, 1.0]) if abs(t[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    r = np.cross(t, helper)
    n = np.linalg.norm(r)
    if n < 1e-9:
        helper = np.array([0.0, 1.0, 0.0])
        r = np.cross(t, helper)
        n = np.linalg.norm(r)
    return r / max(n, _EPS)


def _tangents(points: np.ndarray) -> np.ndarray:
    """Central-difference tangents along a polyline, unit length."""
    n = len(points)
    if n == 1:
        return np.array([[0.0, 1.0, 0.0]])
    t = np.empty_like(points)
    t[0] = points[1] - points[0]
    t[-1] = points[-1] - points[-2]
    if n > 2:
        t[1:-1] = points[2:] - points[:-2]
    # A duplicated point would give a zero tangent and NaN out the whole chain.
    lengths = np.linalg.norm(t, axis=1)
    degenerate = lengths < 1e-9
    if np.any(degenerate):
        t[degenerate] = np.array([0.0, 1.0, 0.0])
    return _unit(t)


def rotation_minimizing_frames(points: np.ndarray, tangents: np.ndarray) -> np.ndarray:
    """Double-reflection RMF. Returns the reference vector r_i at each point."""
    n = len(points)
    reference = np.empty_like(points)
    reference[0] = _perpendicular(tangents[0])

    for i in range(n - 1):
        v1 = points[i + 1] - points[i]
        c1 = float(v1 @ v1)
        if c1 < 1e-18:
            reference[i + 1] = reference[i]
            continue
        # First reflection: through the plane bisecting the segment.
        r_l = reference[i] - (2.0 / c1) * float(v1 @ reference[i]) * v1
        t_l = tangents[i] - (2.0 / c1) * float(v1 @ tangents[i]) * v1
        # Second reflection: brings t_l onto the next tangent.
        v2 = tangents[i + 1] - t_l
        c2 = float(v2 @ v2)
        if c2 < 1e-18:
            reference[i + 1] = r_l
            continue
        reference[i + 1] = r_l - (2.0 / c2) * float(v2 @ r_l) * v2

    # Re-orthogonalize against the tangent: 200 segments of float error add up.
    reference = reference - tangents * np.sum(reference * tangents, axis=1, keepdims=True)
    return _unit(reference)


@dataclass
class BarkMesh:
    vertices: list = field(default_factory=list)
    faces: list = field(default_factory=list)
    normals: list = field(default_factory=list)
    uvs: list = field(default_factory=list)
    wind: list = field(default_factory=list)     # (N,4) float in 0..1

    def count(self) -> int:
        return sum(len(block) for block in self.vertices)


def _segments_for(spec: TreeSpec, radius: float, trunk_radius: float) -> int:
    """Radial resolution from radius. Twigs at 3 sides, the trunk at radial_max.

    Segment count is constant along a chain (taken from its thickest node) so
    consecutive rings connect with a plain quad strip -- varying it per ring
    would need a stitching step that buys nothing visible on a tapered tube.
    """
    lo, hi = int(spec.bark.radial_min), int(spec.bark.radial_max)
    if hi <= lo:
        return lo
    t = np.clip(radius / max(trunk_radius, _EPS), 0.0, 1.0) ** float(spec.bark.radial_falloff)
    return int(np.clip(round(lo + (hi - lo) * t), lo, hi))


def _socket_point(skeleton: TreeSkeleton, chain: np.ndarray, spec: TreeSpec):
    """Sink a child branch's first ring to the parent centreline.

    This is the whole junction strategy, and it is deliberately not a boolean.
    Booleans on a few thousand forks are minutes of CPU, produce degenerate
    slivers at glancing angles, and destroy the analytic UVs the sweep just
    earned. Instead the child's tube starts *inside* the parent's hull, so the
    surfaces interpenetrate with no visible hole, and the bark texture hides the
    intersection line. The cost is a non-manifold union -- which is why
    `junction_mode='clean'` exists for the callers that need watertight.

    Returns (position, radius) for a ring prepended to the chain, or None for
    the trunk (whose first node is the ground and needs no socket).
    """
    parent = int(chain[0])
    child = int(chain[1])
    parent_pos = skeleton.positions[parent]
    child_pos = skeleton.positions[child]
    direction = child_pos - parent_pos
    length = float(np.linalg.norm(direction))
    if length < 1e-9:
        return None
    direction = direction / length
    # Start half a parent-radius *behind* the parent centreline along the child's
    # own direction: that guarantees the tube crosses the parent hull even where
    # the fork is glancing and the parent is much fatter than the child.
    sink = 0.5 * float(skeleton.radii[parent])
    position = parent_pos - direction * sink
    radius = float(skeleton.radii[child]) * float(spec.bark.junction_flare)
    return position, radius


def _emit_tube(points: np.ndarray, radii: np.ndarray, arclength: np.ndarray,
               segments: int, spec: TreeSpec, cap_start: bool, cap_end: bool):
    """Sweep one chain. Returns (vertices, faces, normals, uvs, ring_index)."""
    tangents = _tangents(points)
    reference = rotation_minimizing_frames(points, tangents)
    binormal = np.cross(tangents, reference)

    # segments + 1 columns: the seam vertex is duplicated so u can run 0 -> 1
    # instead of wrapping back to 0 and smearing the whole texture across the
    # last quad.
    columns = segments + 1
    theta = np.linspace(0.0, _TWO_PI, columns)
    cos_t = np.cos(theta)[None, :, None]
    sin_t = np.sin(theta)[None, :, None]

    radial = reference[:, None, :] * cos_t + binormal[:, None, :] * sin_t   # (R, C, 3)
    vertices = points[:, None, :] + radial * radii[:, None, None]
    normals = radial.reshape(-1, 3)
    vertices = vertices.reshape(-1, 3)

    tile = max(float(spec.bark.uv_tile), 1e-6)
    v_coord = np.repeat(arclength / tile, columns)
    if spec.bark.uv_mode == "world":
        # Uniform texel density: u advances with real circumference, so bark on
        # the trunk is the same scale as bark on a twig (and leaves [0,1]).
        u_coord = (np.repeat(radii, columns) * np.tile(theta, len(points))) / tile
    else:
        u_coord = np.tile(theta / _TWO_PI, len(points))
    uvs = np.stack([u_coord, v_coord], axis=1)

    rings = len(points)
    base = np.arange(rings - 1)[:, None] * columns + np.arange(segments)[None, :]
    a = base
    b = base + 1
    c = base + columns + 1
    d = base + columns
    faces = np.concatenate([
        np.stack([a, b, c], axis=-1).reshape(-1, 3),
        np.stack([a, c, d], axis=-1).reshape(-1, 3),
    ], axis=0)

    extra_vertices = []
    extra_normals = []
    extra_uvs = []
    extra_faces = []
    next_index = len(vertices)

    if cap_start:
        # Flat fan, facing back down the chain. Wound (centre, b, a) so the
        # normal is -t; the usual (centre, a, b) points into the tube.
        centre = points[0]
        extra_vertices.append(centre)
        extra_normals.append(-tangents[0])
        extra_uvs.append([0.5, float(arclength[0] / tile)])
        ring = np.arange(segments)
        extra_faces.append(np.stack([
            np.full(segments, next_index), ring + 1, ring,
        ], axis=-1))
        next_index += 1

    if cap_end and spec.bark.cap_tips:
        # A cone, not a hemisphere: a domed tip reads as a blob on a twig.
        apex = points[-1] + tangents[-1] * radii[-1] * 1.6
        extra_vertices.append(apex)
        extra_normals.append(tangents[-1])
        extra_uvs.append([0.5, float((arclength[-1] + radii[-1] * 1.6) / tile)])
        last = (rings - 1) * columns
        ring = np.arange(segments) + last
        extra_faces.append(np.stack([
            ring, ring + 1, np.full(segments, next_index),
        ], axis=-1))
        next_index += 1

    if extra_vertices:
        vertices = np.concatenate([vertices, np.asarray(extra_vertices, dtype=np.float64)], axis=0)
        normals = np.concatenate([normals, _unit(np.asarray(extra_normals, dtype=np.float64))], axis=0)
        uvs = np.concatenate([uvs, np.asarray(extra_uvs, dtype=np.float64)], axis=0)
        faces = np.concatenate([faces] + extra_faces, axis=0)

    return vertices, faces, normals, uvs


def _branch_phase(chain_index: int) -> float:
    """Stable per-branch phase in [0,1] for the wind R channel.

    A hash, not an RNG draw: it has to be identical for the bark of a branch and
    for every leaf card riding on it, and those are built in different passes.
    """
    x = (chain_index * 2654435761) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 2246822519) & 0xFFFFFFFF
    x ^= x >> 13
    return (x & 0xFFFF) / 65535.0


def build_bark(spec: TreeSpec, skeleton: TreeSkeleton, on_progress=None, split_branches=False):
    """Sweep every chain into bark geometry.

    Returns (groups, stats), where `groups` maps a material name to
    (vertices, faces, normals, uvs, wind_rgba). Normally there is exactly one,
    "trunk"; with `split_branches` the thin chains go to a second group so the
    twigs can wear a different texture from the structural wood. The split is by
    chain, not by face, because a chain's vertices are its own -- splitting after
    the fact would mean remapping every index for nothing.
    """
    trunk_radius = float(skeleton.radii[0])
    split_threshold = float(spec.bark.split_radius_ratio) * trunk_radius
    max_arclength = float(skeleton.arclength.max()) if len(skeleton.arclength) else 1.0
    max_order = max(int(skeleton.order.max()), 1) if len(skeleton.order) else 1

    # One accumulator per material group, each with its own vertex offset.
    buckets: dict[str, dict] = {
        name: {"vertices": [], "faces": [], "normals": [], "uvs": [], "wind": [], "offset": 0}
        for name in (("trunk", "branches") if split_branches else ("trunk",))
    }
    chain_count = len(skeleton.chains)

    for chain_index, chain in enumerate(skeleton.chains):
        if len(chain) < 2:
            continue

        is_trunk = int(skeleton.parents[int(chain[0])]) < 0
        nodes = chain
        points = skeleton.positions[nodes]
        radii = skeleton.radii[nodes].copy()
        arclength = skeleton.arclength[nodes].copy()

        if not is_trunk:
            socket = _socket_point(skeleton, chain, spec)
            if socket is None:
                continue
            socket_pos, socket_radius = socket
            # Drop the parent node itself: the socket replaces it. Keeping both
            # would put a full-parent-radius ring on the child, which is the
            # bulge you see on naive generators.
            points = np.concatenate([[socket_pos], points[1:]], axis=0)
            radii = np.concatenate([[socket_radius], radii[1:]], axis=0)
            arclength = np.concatenate([[arclength[0]], arclength[1:]], axis=0)

        if len(points) < 2:
            continue

        segments = _segments_for(spec, float(radii.max()), trunk_radius)
        vertices, faces, normals, uvs = _emit_tube(
            points, radii, arclength, segments, spec,
            cap_start=True, cap_end=True,
        )

        wind = None
        if spec.output.wind_colors:
            phase = _branch_phase(chain_index)
            stiffness = 1.0 - np.clip(
                np.repeat(arclength, segments + 1) / max(max_arclength, _EPS), 0.0, 1.0)
            # Cap vertices were appended after the ring block; pad the channel
            # rather than recomputing per vertex.
            pad = len(vertices) - len(stiffness)
            if pad > 0:
                stiffness = np.concatenate([stiffness, np.full(pad, stiffness[-1] if len(stiffness) else 1.0)])
            order_weight = float(skeleton.order[int(chain[-1])]) / max_order
            wind = np.stack([
                np.full(len(vertices), phase),
                stiffness,
                np.zeros(len(vertices)),           # B is leaf flutter; bark does not flutter
                np.full(len(vertices), order_weight),
            ], axis=1)

        bucket = buckets["branches"] if (split_branches and float(radii.max()) < split_threshold) else buckets["trunk"]
        bucket["vertices"].append(vertices)
        bucket["faces"].append(faces + bucket["offset"])
        bucket["normals"].append(normals)
        bucket["uvs"].append(uvs)
        if wind is not None:
            bucket["wind"].append(wind)
        bucket["offset"] += len(vertices)

        if on_progress is not None and chain_index % 128 == 0:
            on_progress(chain_index / max(chain_count, 1))

    groups: dict[str, tuple] = {}
    for name, bucket in buckets.items():
        if not bucket["vertices"]:
            continue
        vertices = np.concatenate(bucket["vertices"], axis=0)
        faces = np.concatenate(bucket["faces"], axis=0).astype(np.int64)
        normals = np.concatenate(bucket["normals"], axis=0)
        uvs = np.concatenate(bucket["uvs"], axis=0)
        wind = (np.concatenate(bucket["wind"], axis=0) if bucket["wind"]
                else np.zeros((len(vertices), 4)))
        groups[name] = (vertices, faces, normals, uvs, wind)

    if not groups:
        return {}, {}

    stats = {
        "chains": chain_count,
        "vertices": int(sum(len(g[0]) for g in groups.values())),
        "faces": int(sum(len(g[1]) for g in groups.values())),
        "trunk_radius": trunk_radius,
        "groups": {name: int(len(g[1])) for name, g in groups.items()},
    }
    return groups, stats
