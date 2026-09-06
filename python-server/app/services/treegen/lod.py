"""Phase 5 -- LOD levels regenerated from the skeleton.

A tree is the worst possible input for a general mesh simplifier. Decimation
works by collapsing edges that barely change the surface, and a canopy is
thousands of disconnected alpha-tested quads: there are no edges to collapse
that do not delete whole leaves, and the silhouette -- the only thing that
matters at distance -- is exactly what goes first. Running gltfpack over a tree
gives holes in the canopy and a trunk that keeps its full ring count.

Regenerating instead is both cheaper and better, because the skeleton is still
in memory and every knob that controls density is already a parameter:

    radial segments   fewer sides per branch
    branch order      whole twig generations dropped
    leaf budget       fewer cards, each proportionally larger

The one rule is that THE SKELETON NEVER CHANGES between levels. Re-running
colonization with lighter settings would grow a different tree, and swapping one
tree for a different tree at a distance threshold is the most visible popping
there is. Every level here is a different *skin* over identical branch centre
lines.
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np

from .skeleton import TreeSkeleton, _build_chains, _build_children
from .spec import TreeSpec

# Per-level scaling, applied as factor**level so a chain of any length is smooth.
#
# CARD_SCALE and the card size are tied together on purpose: card area grows as
# the square of its width, so to keep the canopy covering the same silhouette
# with fewer cards the width must scale as 1/sqrt(count). Anything else and the
# tree visibly thins out (or fattens) as levels swap -- which is the popping the
# whole exercise is meant to avoid. See `_leaf_size_scale`.
RADIAL_SCALE = 0.55
CARD_SCALE = 0.42
SPACING_SCALE = 1.7


def _leaf_size_scale(level: int) -> float:
    """Card width growth that preserves total canopy coverage.

    total area ~ count * width^2, and count scales by CARD_SCALE**level, so
    width must scale by CARD_SCALE**(-level/2) to hold the product constant.
    """
    return float(CARD_SCALE ** (-0.5 * level))


def cull_skeleton(skeleton: TreeSkeleton, max_order: int) -> TreeSkeleton:
    """Drop every node above `max_order`, keeping the rest bit-identical.

    Positions, radii and arc lengths are carried over untouched rather than
    re-solved: a branch that exists at two levels must be in the same place and
    the same thickness in both, or it visibly jumps when the levels swap.
    """
    if len(skeleton.positions) == 0:
        return skeleton
    keep = skeleton.order <= int(max_order)
    if bool(keep.all()):
        return skeleton
    keep[0] = True  # the root always survives

    remap = -np.ones(len(keep), dtype=np.int32)
    remap[keep] = np.arange(int(keep.sum()), dtype=np.int32)
    parents = np.where(skeleton.parents >= 0, remap[np.maximum(skeleton.parents, 0)], -1).astype(np.int32)[keep]

    positions = skeleton.positions[keep]
    order = skeleton.order[keep]
    children = _build_children(parents)
    chains, chain_of_node = _build_chains(parents, children, order)

    return TreeSkeleton(
        positions=positions,
        parents=parents,
        radii=skeleton.radii[keep],
        order=order,
        arclength=skeleton.arclength[keep],
        chains=chains,
        chain_of_node=chain_of_node,
        children=children,
        attractors_used=skeleton.attractors_used,
        iterations=skeleton.iterations,
    )


def lod_spec(spec: TreeSpec, level: int, skeleton_max_order: int | None = None) -> TreeSpec:
    """The same tree, described more cheaply. Level 0 returns the spec unchanged.

    `skeleton_max_order` is the order the tree ACTUALLY reached. Culling against
    the spec's nominal `max_order` instead is a silent no-op: that field is a
    ceiling (8 by default) and a real oak only reaches 5, so every level would
    ask to keep more branches than exist and drop nothing at all.
    """
    if level <= 0:
        return spec

    coarse = spec.model_copy(deep=True)

    radial_factor = RADIAL_SCALE ** level
    coarse.bark.radial_max = max(
        int(round(spec.bark.radial_max * radial_factor)), spec.bark.radial_min)
    # Twigs are already at the floor, so the only way to cheapen them further is
    # to remove them -- which the order cull below does.
    coarse.bark.radial_min = max(3, min(spec.bark.radial_min, coarse.bark.radial_max))
    # A boolean union costs a second and produces geometry no distant viewer can
    # resolve; distance levels always take the free path.
    coarse.bark.junction_mode = "sink"

    ceiling = int(skeleton_max_order if skeleton_max_order is not None else spec.branching.max_order)
    cull_order = max(1, ceiling - level)
    coarse.branching.max_order = cull_order

    card_factor = CARD_SCALE ** level
    coarse.foliage.max_cards = max(int(round(spec.foliage.max_cards * card_factor)), 8)
    coarse.foliage.size_ratio = min(spec.foliage.size_ratio * _leaf_size_scale(level), 0.5)
    coarse.foliage.spacing_ratio = min(spec.foliage.spacing_ratio * (SPACING_SCALE ** level), 0.5)
    # Fewer, bigger cards per cluster: at distance a 5-card fan and a 2-card
    # cross are the same handful of pixels.
    coarse.foliage.cluster_cards = max(2, int(round(spec.foliage.cluster_cards * (0.7 ** level))))

    # Two filters would otherwise strip the canopy off a culled tree, which is
    # far more visible than any triangle count:
    #
    #  - leaves only grow on branches at or above `min_order`, so culling below
    #    that number leaves a bare skeleton;
    #  - leaves only grow on branches THINNER than `max_radius_ratio`, and the
    #    twigs that qualified are exactly the ones the cull removed, so the
    #    survivors are all too thick to carry any.
    coarse.foliage.min_order = min(spec.foliage.min_order, cull_order)
    coarse.foliage.max_radius_ratio = min(spec.foliage.max_radius_ratio * (2.0 ** level), 0.2)

    coarse.output.lods = 0  # a level never generates its own chain
    return coarse


def lod_levels(spec: TreeSpec) -> list[int]:
    """The level indices a spec asks for, LOD0 first."""
    return list(range(int(spec.output.lods) + 1))


def describe_level(level: int, spec: TreeSpec) -> dict:
    """What a level changed, for the stats payload."""
    return {
        "level": level,
        "radial_max": spec.bark.radial_max,
        "max_order": spec.branching.max_order,
        "max_cards": spec.foliage.max_cards,
        "leaf_size_ratio": round(spec.foliage.size_ratio, 5),
    }


__all__ = ["cull_skeleton", "lod_spec", "lod_levels", "describe_level", "replace"]
