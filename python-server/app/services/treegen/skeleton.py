"""Phase 1 -- skeleton generation by space colonization (Runions et al. 2007).

The loop is small; the value is in what surrounds it. Attractors compete for the
nearest node, so branches thin out where another branch already got the light --
that competition is what makes the result read as grown rather than authored,
and it is the reason this was chosen over Weber-Penn/Sapling.

Output is a `TreeSkeleton`: flat parallel arrays plus a decomposition into
*chains* (a chain = one continuous branch from its fork to its tip). Everything
downstream -- bark sweeping, foliage placement, wind data, LOD culling -- is
expressed per chain, so this is the only module that thinks in nodes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from .crown import Crown
from .spec import TreeSpec

_EPS = 1e-12


def _normalize_rows(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, _EPS)


@dataclass
class TreeSkeleton:
    """Flat node arrays plus the branch-chain decomposition."""

    positions: np.ndarray          # (N,3) float64
    parents: np.ndarray            # (N,)  int32, -1 for the root
    radii: np.ndarray              # (N,)  float64
    order: np.ndarray              # (N,)  int32, trunk = 0
    arclength: np.ndarray          # (N,)  float64, from the root
    chains: list[np.ndarray]       # each an int array of node indices, root-to-tip
    chain_of_node: np.ndarray      # (N,)  int32, index into `chains`
    children: list[list[int]] = field(default_factory=list)
    attractors_used: int = 0
    iterations: int = 0

    @property
    def node_count(self) -> int:
        return len(self.positions)

    @property
    def max_order(self) -> int:
        return int(self.order.max()) if len(self.order) else 0

    def polylines(self) -> list[list[list[float]]]:
        """Chains as plain nested lists -- the /tree/preview payload."""
        return [self.positions[c].tolist() for c in self.chains]


def _grow_trunk(spec: TreeSpec, crown: Crown, attractors: np.ndarray,
                rng: np.random.Generator) -> tuple[list[np.ndarray], list[int]]:
    """Climb straight up from the origin until the crown is in reach.

    Without this the colonization would start branching at ground level and the
    tree would have no trunk at all -- the classic first-run failure of a naive
    space-colonization implementation.
    """
    step = spec.step_size
    positions = [np.zeros(3, dtype=np.float64)]
    parents = [-1]

    lean = np.array([spec.skeleton.trunk_lean[0], 0.0, spec.skeleton.trunk_lean[1]], dtype=np.float64)
    wobble = float(spec.skeleton.trunk_wobble)
    drift = np.zeros(3, dtype=np.float64)

    # Cap the climb: a crown that no attractor ever reaches must not spin here.
    max_steps = int(np.ceil(spec.crown_top / step)) + 8
    tree = cKDTree(attractors) if len(attractors) else None

    for _ in range(max_steps):
        head = positions[-1]
        if tree is not None:
            distance, _ = tree.query(head, k=1)
            if distance <= spec.attraction_distance:
                break
        elif head[1] >= spec.crown_base:
            break

        if wobble > 0.0:
            drift = drift * 0.85 + rng.normal(0.0, wobble, 3) * np.array([1.0, 0.0, 1.0])
        direction = _normalize_rows(np.array([0.0, 1.0, 0.0]) + lean + drift * 0.5)
        positions.append(head + direction * step)
        parents.append(len(positions) - 2)

    return positions, parents


def colonize(spec: TreeSpec, crown: Crown, attractors: np.ndarray,
             rng: np.random.Generator, on_progress=None) -> tuple[np.ndarray, np.ndarray, int, int]:
    """The colonization loop proper. Returns (positions, parents, iterations, consumed)."""
    positions, parents = _grow_trunk(spec, crown, attractors, rng)

    live = np.ones(len(attractors), dtype=bool)
    step = spec.step_size
    attraction = spec.attraction_distance
    kill = spec.kill_distance
    tropism = np.asarray(spec.skeleton.tropism, dtype=np.float64)
    randomness = float(spec.skeleton.randomness)
    max_iterations = int(spec.skeleton.max_iterations)

    total_attractors = int(live.sum())
    max_nodes = int(spec.skeleton.max_nodes)
    # A node that has just noticed an attractor needs attraction/step iterations
    # to walk into kill range, and it kills nothing on the way. A flat stall
    # limit therefore misfires during spin-up -- the trunk climbs, nothing dies,
    # and the loop aborts with a bare pole and zero attractors consumed. The
    # limit has to be measured in *traversal time*, with the spec value as
    # margin on top.
    travel = int(np.ceil(attraction / max(step, _EPS)))
    stall_limit = max(int(spec.skeleton.stall_iterations), travel + 4)
    previous_live = total_attractors
    stalled = 0
    iterations = 0

    for iteration in range(max_iterations):
        iterations = iteration + 1
        live_idx = np.flatnonzero(live)
        if live_idx.size == 0:
            break
        if len(positions) >= max_nodes:
            break

        node_array = np.asarray(positions, dtype=np.float64)
        tree = cKDTree(node_array)

        # Each *attractor* votes for exactly one node -- its nearest within the
        # attraction radius. (Querying the other way round, nodes -> attractors,
        # is the common mistake: it makes every node grow every iteration and
        # the competition disappears.)
        distances, nearest = tree.query(attractors[live_idx], k=1,
                                        distance_upper_bound=attraction)
        reachable = np.isfinite(distances)
        if not np.any(reachable):
            break

        voters = live_idx[reachable]
        targets = nearest[reachable]

        pull = _normalize_rows(attractors[voters] - node_array[targets])

        # Sum the votes per node without a Python loop: np.add.at over the
        # target index is the whole grouping step.
        accum = np.zeros_like(node_array)
        np.add.at(accum, targets, pull)

        grow_nodes = np.unique(targets)
        # Normalize BEFORE jittering. The accumulated pull of two attractors
        # sitting symmetrically either side of a node very nearly cancels, so
        # jitter scaled by its magnitude would be ~zero -- and that is exactly
        # the configuration that deadlocks: the node grows along the bisector
        # forever, reaching neither attractor and regenerating the same symmetry
        # in its child. Unit-scale jitter is what breaks it.
        directions = _normalize_rows(accum[grow_nodes])
        if randomness > 0.0:
            directions = _normalize_rows(directions + rng.normal(0.0, randomness, directions.shape))
        directions = _normalize_rows(directions + tropism)

        new_positions = node_array[grow_nodes] + directions * step
        positions.extend(new_positions)
        parents.extend(grow_nodes.tolist())

        # Kill attractors the new growth has reached. Only the new nodes can
        # have changed anything, so query against those alone.
        new_tree = cKDTree(new_positions)
        still_live = np.flatnonzero(live)
        hit = new_tree.query_ball_point(attractors[still_live], r=kill, return_length=True)
        live[still_live[np.asarray(hit) > 0]] = False

        # Stall guard. Symmetry-breaking jitter makes the classic deadlock rare
        # but not impossible (randomness can be dialled to 0, and an attractor
        # can sit just outside every reachable node's kill radius). Without this
        # the loop happily burns every remaining iteration adding nodes that
        # kill nothing -- the difference between a 0.5s tree and a 20s one.
        remaining = int(live.sum())
        stalled = stalled + 1 if remaining >= previous_live else 0
        previous_live = remaining
        if stalled >= stall_limit:
            break

        if on_progress is not None and (iteration % 8 == 0):
            consumed = total_attractors - int(live.sum())
            on_progress(min(consumed / max(total_attractors, 1), 1.0), len(positions))

    consumed = total_attractors - int(live.sum())
    return (np.asarray(positions, dtype=np.float64),
            np.asarray(parents, dtype=np.int32),
            iterations,
            consumed)


def _build_children(parents: np.ndarray) -> list[list[int]]:
    children: list[list[int]] = [[] for _ in range(len(parents))]
    for node, parent in enumerate(parents):
        if parent >= 0:
            children[int(parent)].append(node)
    return children


def _prune(positions: np.ndarray, parents: np.ndarray, min_chain_nodes: int) -> tuple[np.ndarray, np.ndarray]:
    """Drop tip nodes that never became a real branch.

    Colonization always leaves a fringe of one-step stubs where an attractor was
    killed on the same iteration it was reached. They are invisible as geometry
    but each one still forces a whole swept tube, a cap, and a junction socket.
    """
    if min_chain_nodes <= 1:
        return positions, parents

    keep = np.ones(len(positions), dtype=bool)
    for _ in range(max(min_chain_nodes - 1, 1)):
        children = [[] for _ in range(len(positions))]
        for node, parent in enumerate(parents):
            if parent >= 0 and keep[node] and keep[parent]:
                children[int(parent)].append(node)
        # A leaf whose parent still has other children is a stub worth dropping;
        # a leaf that is the sole continuation is the actual tip of a branch.
        leaves = [n for n in range(len(positions))
                  if keep[n] and parents[n] >= 0 and not children[n]]
        dropped = False
        for leaf in leaves:
            siblings = children[int(parents[leaf])]
            if len(siblings) > 1:
                keep[leaf] = False
                siblings.remove(leaf)
                dropped = True
        if not dropped:
            break

    if keep.all():
        return positions, parents

    remap = -np.ones(len(positions), dtype=np.int32)
    remap[keep] = np.arange(int(keep.sum()), dtype=np.int32)
    new_parents = np.where(parents >= 0, remap[np.maximum(parents, 0)], -1).astype(np.int32)
    return positions[keep], new_parents[keep]


def _assign_orders(positions: np.ndarray, parents: np.ndarray,
                   children: list[list[int]]) -> np.ndarray:
    """Trunk = 0; at every fork the straightest child continues, the rest step up.

    "Straightest" rather than "thickest" because radii are not solved yet -- and
    direction continuity is what a viewer actually reads as the same branch.
    """
    order = np.zeros(len(positions), dtype=np.int32)
    incoming = np.zeros((len(positions), 3), dtype=np.float64)
    incoming[0] = np.array([0.0, 1.0, 0.0])

    stack = [0]
    while stack:
        node = stack.pop()
        kids = children[node]
        if not kids:
            continue
        directions = _normalize_rows(positions[kids] - positions[node])
        incoming[kids] = directions
        if len(kids) == 1:
            order[kids[0]] = order[node]
        else:
            alignment = directions @ incoming[node]
            straightest = int(np.argmax(alignment))
            for i, kid in enumerate(kids):
                order[kid] = order[node] if i == straightest else order[node] + 1
        stack.extend(kids)
    return order


def _build_chains(parents: np.ndarray, children: list[list[int]],
                  order: np.ndarray) -> tuple[list[np.ndarray], np.ndarray]:
    """Split the node tree into branch chains, each starting at a fork.

    A chain carries its parent node as its first element when it is not the
    trunk: the bark sweep needs that anchor to sink the junction socket into the
    parent, and the alternative (looking the parent up later) is how the
    junction ends up in the wrong place.
    """
    chains: list[np.ndarray] = []
    chain_of_node = -np.ones(len(parents), dtype=np.int32)

    # Roots of chains: node 0, plus every child whose order stepped up.
    starts = [0]
    for node in range(len(parents)):
        parent = int(parents[node])
        if parent >= 0 and order[node] != order[parent]:
            starts.append(node)

    for start in starts:
        walk = [start]
        node = start
        while True:
            kids = children[node]
            continuation = [k for k in kids if order[k] == order[node]]
            if not continuation:
                break
            node = continuation[0]
            walk.append(node)
        index = len(chains)
        for n in walk:
            chain_of_node[n] = index
        parent = int(parents[start])
        full = ([parent] + walk) if (parent >= 0) else walk
        chains.append(np.asarray(full, dtype=np.int32))

    return chains, chain_of_node


def _smooth_chains(positions: np.ndarray, chains: list[np.ndarray], passes: int) -> np.ndarray:
    """Laplacian-smooth chain interiors. Fork nodes are pinned so gaps cannot open."""
    if passes <= 0:
        return positions
    pinned = np.zeros(len(positions), dtype=bool)
    for chain in chains:
        if len(chain):
            pinned[chain[0]] = True
            pinned[chain[-1]] = True
    out = positions.copy()
    for _ in range(passes):
        updated = out.copy()
        for chain in chains:
            if len(chain) < 3:
                continue
            interior = chain[1:-1]
            movable = ~pinned[interior]
            if not np.any(movable):
                continue
            average = 0.5 * (out[chain[:-2]] + out[chain[2:]])
            updated[interior[movable]] = (0.5 * out[interior[movable]]
                                          + 0.5 * average[movable])
        out = updated
    return out


def _solve_radii(spec: TreeSpec, positions: np.ndarray, parents: np.ndarray,
                 arclength: np.ndarray) -> np.ndarray:
    """da Vinci / Murray in its pipe-model form: r ~ (downstream length)^(1/n).

    The textbook statement of the law, r_parent^n = sum(r_child^n) applied over
    the node tree, has a flaw that is obvious the moment you render it: it only
    changes the radius *at a fork*. A branch that runs twenty nodes without
    forking keeps one constant radius the whole way and then stops dead, and the
    tree comes out clubby -- thick blunt sticks instead of tapering branches.

    Weighting each node by the total length of the subtree hanging off it fixes
    that without abandoning the law, because it *is* the law: at a fork with two
    equal subtrees the parent gets (2L)^(1/n) = 2^(1/n) * r_child, exactly what
    the summation gives. It just also interpolates correctly in between, since
    the downstream length falls steadily as you walk toward a tip.

    Absolute size is set afterwards: solving bottom-up from a fixed tip radius
    makes the trunk radius emergent and wildly seed-dependent, which is unusable
    behind a slider. The law sets the proportions, `trunk_radius_ratio` sets the
    scale.
    """
    n = float(spec.branching.radius_exponent)
    tip = max(spec.branching.tip_radius_ratio * spec.height, 1e-9)

    # Length of the segment feeding each node, then accumulated down the tree.
    weight = np.zeros(len(positions), dtype=np.float64)
    weight[1:] = np.linalg.norm(positions[1:] - positions[parents[1:].astype(np.int64)], axis=1)
    # Reverse topological order: parents always have a lower index than their
    # children here (nodes are appended after the node they grew from), so a
    # descending index walk is already a valid post-order.
    for node in range(len(positions) - 1, 0, -1):
        weight[int(parents[node])] += weight[node]

    root_weight = float(weight[0])
    radii = (weight / max(root_weight, _EPS)) ** (1.0 / n)

    # Clamp to the absolute tip radius only AFTER scaling. Doing it before is
    # the trap: the scale factor is >1, so it multiplies the clamp too and every
    # twig comes out finger-thick.
    radii = radii * (spec.branching.trunk_radius_ratio * spec.height)
    radii = np.maximum(radii, tip)

    flare = float(spec.branching.root_flare)
    flare_length = spec.branching.root_flare_ratio * spec.height
    if flare > 0.0 and flare_length > _EPS:
        t = np.clip(1.0 - arclength / flare_length, 0.0, 1.0)
        radii = radii * (1.0 + flare * t * t)

    return radii


def _cull_order(positions, parents, order, max_order):
    """Drop everything above `max_order` -- also the LOD1/LOD2 branch lever."""
    keep = order <= max_order
    if keep.all():
        return positions, parents, order
    keep[0] = True
    remap = -np.ones(len(positions), dtype=np.int32)
    remap[keep] = np.arange(int(keep.sum()), dtype=np.int32)
    new_parents = np.where(parents >= 0, remap[np.maximum(parents, 0)], -1).astype(np.int32)
    # A kept node whose parent was culled would be orphaned. Order is monotone
    # down the tree, so this cannot happen -- but it is a one-line check and the
    # failure mode (a branch floating free of the trunk) is hard to spot later.
    orphan = (new_parents < 0) & keep
    orphan[0] = False
    if np.any(orphan):
        raise RuntimeError("Order culling orphaned a node; the order assignment is not monotone.")
    return positions[keep], new_parents[keep], order[keep]


def build_skeleton(spec: TreeSpec, crown: Crown, attractors: np.ndarray,
                   rng: np.random.Generator, on_progress=None) -> TreeSkeleton:
    """Full Phase-1 pipeline: colonize -> prune -> order -> chains -> smooth -> radii."""
    positions, parents, iterations, consumed = colonize(spec, crown, attractors, rng, on_progress)

    positions, parents = _prune(positions, parents, int(spec.skeleton.min_chain_nodes))
    children = _build_children(parents)
    order = _assign_orders(positions, parents, children)

    positions, parents, order = _cull_order(positions, parents, order, int(spec.branching.max_order))
    children = _build_children(parents)

    chains, chain_of_node = _build_chains(parents, children, order)
    positions = _smooth_chains(positions, chains, int(spec.skeleton.smoothing))

    # Arc length has to be measured on the smoothed polyline -- bark V-tiling and
    # wind stiffness both read it, and both look wrong against pre-smoothing
    # lengths on a heavily smoothed tree.
    arclength = np.zeros(len(positions), dtype=np.float64)
    for node in range(1, len(positions)):
        parent = int(parents[node])
        arclength[node] = arclength[parent] + float(np.linalg.norm(positions[node] - positions[parent]))

    radii = _solve_radii(spec, positions, parents, arclength)

    return TreeSkeleton(
        positions=positions,
        parents=parents,
        radii=radii,
        order=order,
        arclength=arclength,
        chains=chains,
        chain_of_node=chain_of_node,
        children=children,
        attractors_used=int(consumed),
        iterations=int(iterations),
    )
