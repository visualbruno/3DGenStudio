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
RADIAL_SCALE = 0.55
CARD_SCALE = 0.42
SPACING_SCALE = 1.2

# How much of the branch-order range survives each level.
#
# Subtracting a fixed 1 per level looks reasonable and fails on exactly the trees
# that need LODs most. How deep a skeleton goes is a property of the tree, not a
# constant: a sparse oak reaches order 5, a densely branched one reaches 12. On
# the latter, dropping one order of twelve removes almost no branches -- measured,
# LOD3 to LOD4 changed the bark triangle count by +2%, so the two levels were
# indistinguishable. Scaling the surviving depth instead cuts proportionally
# whatever the tree's depth turns out to be.
ORDER_SCALE = 0.6

# Card width growth, and the cap on it.
#
# The tempting rule is to preserve total card AREA: coverage goes as
# count * width^2 and the budget scales by CARD_SCALE**level, so width should
# scale by CARD_SCALE**(-level/2). Measured, that is wrong twice over.
#
# It over-compensates, because the budget is not the only thing thinning the
# canopy -- wider leaf spacing and the branch-order cull each remove placements
# too, and all three compound. And it over-corrects into a worse artefact: past
# roughly 2x, a card stops reading as a leaf and reads as a slab, and because a
# card grows outward from the branch it is anchored to, the crown visibly
# inflates. At the old rule LOD4 cards were 5.7x wide, the crown swelled to 113%
# of LOD0 by LOD3, and only 56 cards survived.
#
# A gentler exponent with a hard cap measures better on every axis at the same
# triangle cost: 218 cards instead of 56 at LOD4, and the crown holds within a
# few percent of LOD0 all the way down.
LEAF_SIZE_EXPONENT = 0.30
MAX_LEAF_GROWTH = 2.0


def _leaf_size_scale(level: int) -> float:
    """Card width growth for a level, capped. See MAX_LEAF_GROWTH."""
    return float(min(CARD_SCALE ** (-LEAF_SIZE_EXPONENT * level), MAX_LEAF_GROWTH))


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
    # Proportional, with the fixed subtraction as a floor so a shallow tree still
    # loses at least one generation per level.
    cull_order = max(1, min(ceiling - level, int(round(ceiling * ORDER_SCALE ** level))))
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
