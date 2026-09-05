"""Make a garment follow the body's silhouette.

This is the stage that answers "the armour does not fit". Everything before it
places the piece rigidly; this is where individual vertices move.

Shrinkwrap and penetration-push are ONE operation with different scope:

  * scope="all"     -- every vertex is pulled to sit `offset` off the body.
                       Makes the piece take on the body's shape. Right for
                       cloth, chainmail, anything skin-tight.
  * scope="inside"  -- only vertices that are inside the body (or closer than
                       the offset) are moved. Resolves clipping and leaves the
                       rest of the shape alone. Right for plate armour, where
                       conforming the whole shell would melt it.

Method, per iteration, following the hard-won recipe in
app/services/autoretopo/project.py (read its module docstring -- it records the
failure modes this shape exists to avoid):

  1. closest point on the body for every vertex;
  2. a SIGNED distance from that, its sign voted over the mesh graph;
  3. displacement along the BODY's normal to bring the signed distance to
     `offset`, masked by scope;
  4. clamp how far a vertex may outrun its NEIGHBOURS, so one bad
     correspondence cannot throw a single vertex across the model;
  5. Laplacian-smooth the DISPLACEMENT FIELD -- not the positions -- and apply.

Two deliberate departures from project.py, both because a garment is not a
freshly remeshed shell:

  * NO tangential relaxation. Sliding vertices along the surface is harmless
    after a remesh, but a garment's UVs are attached to its vertices, so any
    tangential motion drags its texture across the surface ("swimming").
  * displacement is along the body's NORMAL rather than straight to the closest
    point. The two agree on smooth surfaces and differ at creases, where moving
    to the closest point has a tangential component -- the same texture-swim
    problem in miniature.

VERTEX COUNT AND ORDER NEVER CHANGE. That is the contract the whole feature
rests on: the client applies only the returned positions onto its own geometry,
so UVs, materials, submesh structure and skinning never leave the browser. All
graph work therefore happens on an internally WELDED view of the mesh (see
weld_map) and is scattered back -- the incoming vertex order is never disturbed.
"""
from __future__ import annotations

import numpy as np
import trimesh
from scipy.interpolate import RBFInterpolator

from ..autoretopo.project import csr, lap_smooth, vertex_adjacency, vertex_edge_length
from .shell import pair_outer_to_inner, rebuild_outer


def weld_map(vertices, tolerance=1e-5):
    """Group coincident vertices. Returns (inverse, group_count).

    `inverse[i]` is the group of original vertex i, so a per-group quantity
    scatters back with `values[inverse]`.

    This exists because the client sends the piece with its submeshes simply
    concatenated and NOT welded -- it has to, because the returned positions are
    applied straight back onto its own geometry, and any reordering would
    scramble that mapping and with it the UVs.

    But every graph operation here needs real connectivity: on an unwelded mesh
    each UV seam and submesh boundary is a topological hole, so the
    displacement-field smoothing has nothing to smooth across and silently
    degenerates into no smoothing at all -- which is exactly the zigzag and
    spike behaviour the smoothing exists to prevent.

    Note `np.unique` SORTS, so `inverse` is a permutation even when nothing
    actually merges. Every consumer must therefore be consistently in group
    space or vertex space; mixing the two reads a vertex's value against some
    unrelated vertex's neighbours.
    """
    quantized = np.round(np.asarray(vertices, dtype=np.float64) / tolerance).astype(np.int64)
    _, inverse = np.unique(quantized, axis=0, return_inverse=True)
    inverse = np.asarray(inverse).ravel()
    return inverse, (int(inverse.max()) + 1 if inverse.size else 0)


def smooth_field(positions, values, centre_indices, smoothing):
    """Re-express a per-vertex displacement field as a SMOOTH function of space.

    A thin-plate-spline is fitted through the field's values at a few hundred
    sample points and then evaluated at every vertex. The result is
    low-frequency in 3D by construction, and that single property is what makes
    a garment survive being conformed:

      * a garment is a shell with an inner and an outer surface, spatially
        adjacent but geodesically far apart -- to walk between them you go all
        the way around the rim;
      * so projecting each vertex independently pulls the outer surface down
        onto the inner one and the thickness collapses to zero. That is what
        "the armour fused onto the body" was;
      * smoothing over the mesh GRAPH cannot fix it: there is no short path
        between the surfaces, so one moves and the other stays and the shell
        stretches instead;
      * even a k-nearest-neighbour spatial average is not enough on a dense
        shell, because a vertex's k nearest neighbours are mostly on its OWN
        surface.

    A spline fitted over sparse centres has no such failure mode: two points a
    few millimetres apart receive almost the same displacement whatever the
    topology between them, so inner and outer travel together.

    The trade is deliberate: the fit reproduces the body's broad silhouette
    rather than its every wrinkle. Exact clearance is the penetration stage's
    job, not this one's.
    """
    if not len(centre_indices):
        return values
    spline = RBFInterpolator(
        positions[centre_indices], values[centre_indices],
        kernel='thin_plate_spline', smoothing=smoothing, degree=1,
    )
    return spline(positions)


def _min_self_thickness(vertices, faces, sample_indices):
    """Smallest distance from a sampled vertex to the OPPOSITE side of the same
    piece -- i.e. how thin the shell has become anywhere.

    Each sample is cast inward along its own normal; the first thing it hits is
    the other surface. Subsampled because this runs every iteration and only the
    MINIMUM is wanted, which a few hundred rays locate perfectly well.
    """
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    normals = np.asarray(mesh.vertex_normals)[sample_indices]
    origins = vertices[sample_indices] - normals * 1e-6
    try:
        hits, ray_ids, _ = mesh.ray.intersects_location(origins, -normals, multiple_hits=False)
    except Exception:  # noqa: BLE001 - a guard must never fail the fit
        return np.inf
    if not len(ray_ids):
        return np.inf
    return float(np.linalg.norm(hits - origins[ray_ids], axis=1).min())


# Below this share of vertices facing the body, a piece is treated as having no
# inner surface at all (a solid shape, or a one-sided sheet) and the whole thing
# is driven. There is no wall thickness to protect in that case.
SINGLE_SURFACE_FRACTION = 0.12


def _face_normals(vertices, faces):
    return np.asarray(trimesh.Trimesh(vertices, faces, process=False).face_normals)


def _vertex_normals(vertices, faces):
    """The PIECE's own outward normals, used to tell its inner surface from its
    outer one. See the `drive` mask in conform()."""
    return np.asarray(trimesh.Trimesh(vertices, faces, process=False).vertex_normals)


def raw_signed_distance(points, closest, face_ids, body_face_normals):
    """Unvoted signed distance to the body: negative inside, positive outside.

    The sign is the dot product of (point - closest) with the body's face normal
    there. Exact on a watertight surface, and NOISY on the marching-cubes and
    splat-derived meshes this app actually produces: near a crease or a
    self-intersection the closest triangle can face almost anywhere, so isolated
    vertices get the wrong sign and are then pushed the wrong way, which shows
    up as spikes. `vote_signs` is the fix; this function stays raw so the vote
    can happen in group space.
    """
    delta = points - closest
    distance = np.linalg.norm(delta, axis=1)
    outward = np.einsum('ij,ij->i', delta, body_face_normals[face_ids])
    return np.where(outward >= 0.0, 1.0, -1.0) * distance, distance


def vote_signs(group_signed, idx, ptr, deg, rounds=2):
    """Smooth the SIGN of a signed-distance field over the mesh graph.

    A genuinely inside region agrees with itself and survives; an isolated
    misread is outvoted by its neighbours. Blended rather than replaced outright
    because a hard vote on a coarse mesh erases narrow-but-real penetrations
    (a strap under a shoulder plate).

    Must be given GROUP-space values and the group adjacency -- see weld_map.
    """
    voted = group_signed
    for _ in range(int(rounds)):
        summed = np.add.reduceat(voted[idx], ptr[:-1], axis=0) / deg
        voted = 0.5 * voted + 0.5 * summed
    return np.where(voted >= 0.0, 1.0, -1.0)


def conform(vertices, faces, body_mesh, surface_query, *,
            scope='all',
            offset=0.002,
            iterations=20,
            smooth_rounds=2,
            smooth_alpha=0.45,
            step_clamp=0.5,
            tolerance=0.02,
            vote_rounds=2,
            max_distance=None,
            rebuild_shell=True,
            lock_vertical=True,
            preserve_centroid=True,
            field_centres=400,
            field_smoothing=1.0,
            strength=1.0,
            flip_abort_frac=0.01,
            min_thickness=0.0,
            thickness_sample_cap=600,
            progress=None):
    """Move `vertices` so they sit `offset` off `body_mesh`. Returns (V, stats).

    `max_distance` leaves anything further than that from the body untouched,
    which is what stops a cape's trailing edge or a helmet plume being sucked
    onto the torso. None means no limit.

    `tolerance` is the convergence test, as a fraction of the mean edge length:
    the loop exits once the largest step it is still taking is smaller than
    that, so `iterations` is a budget rather than a fixed cost.

    `field_centres` / `field_smoothing` control how low-frequency the conform
    field is. This is what preserves a garment's thickness -- see smooth_field.
    Fewer centres or more smoothing means a broader, gentler conform that
    follows the body's silhouette without chasing its every wrinkle.

    `strength` scales every step, so 0.5 conforms half as far. A partial conform
    is often what actually looks right: it takes on the body's shape without
    being pulled tight into its concavities.

    `flip_abort_frac` stops the fit and keeps the last good state once more than
    that fraction of faces has turned inside out. Nothing recovers an inverted
    triangle, so stopping early beats reporting the damage afterwards.

    `min_thickness` does the same for the piece's own two surfaces meeting,
    which is what makes a lining flicker through the outside. 0 disables it.

    `lock_vertical` and `preserve_centroid` keep a conformed piece WHERE THE
    USER PUT IT: the first stops it sliding along the body's vertical normals
    (up the chest and onto the neck), the second removes any net translation.
    Both apply to conforming only -- the penetration push has to be free to move
    vertices wherever they need to go, or it cannot clear the body.
    """
    V = np.asarray(vertices, dtype=np.float64).copy()
    F = np.asarray(faces)
    body_normals = _face_normals(body_mesh.vertices, body_mesh.faces)

    # Axis mask applied to the conform displacement. Y is world up.
    lock_axes = (np.array([1.0, 0.0, 1.0]) if (lock_vertical and scope != 'inside')
                 else None)
    preserve_centroid = preserve_centroid and scope != 'inside'

    # ---- group space -------------------------------------------------------
    inverse, group_count = weld_map(V)
    group_size = np.bincount(inverse, minlength=group_count).astype(np.float64)
    group_faces = inverse[F]
    idx, ptr, deg = csr(vertex_adjacency(group_count, group_faces))

    def to_groups(values):
        """Average a per-vertex quantity over each welded group."""
        if values.ndim == 1:
            return np.bincount(inverse, weights=values, minlength=group_count) / group_size
        summed = np.stack([
            np.bincount(inverse, weights=values[:, axis], minlength=group_count)
            for axis in range(values.shape[1])
        ], axis=1)
        return summed / group_size[:, None]

    def signed_now(points):
        """Signed distance per VERTEX, with its sign voted in group space.

        The two spaces are kept explicit here because mixing them is silent: the
        arrays have the same length whenever nothing merges, so a vertex-space
        value indexed by the group adjacency does not crash — it just votes
        against unrelated neighbours, and the penetration count quietly changes.
        """
        closest, face_ids = surface_query.on_surface(points)
        raw, distance = raw_signed_distance(points, closest, face_ids, body_normals)
        sign = vote_signs(to_groups(raw), idx, ptr, deg, vote_rounds)[inverse]
        return sign * distance, distance, body_normals[face_ids]

    original = V.copy()
    normals_before = _face_normals(V, F)

    signed, _, _ = signed_now(V)
    inside_before = int(np.count_nonzero(signed < 0))
    # Clamped at zero: this is PENETRATION depth, so a piece entirely outside
    # the body has depth 0, not the negative of its clearance.
    depth_before = float(max(0.0, -signed.min())) if signed.size else 0.0

    group_edge_length = vertex_edge_length(to_groups(V), group_faces)
    mean_edge = max(float(group_edge_length.mean()), 1e-9)



    # Pair the outer surface to the inner one BEFORE anything moves — the
    # thickness has to be measured on the shell as the user placed it.
    pairing = None
    if rebuild_shell and scope != 'inside':
        closest0, ids0 = surface_query.on_surface(V)
        raw0, _ = raw_signed_distance(V, closest0, ids0, body_normals)
        sign0 = vote_signs(to_groups(raw0), idx, ptr, deg, vote_rounds)[inverse]
        n0 = _vertex_normals(V, F)
        inner0 = (np.einsum('ij,ij->i', n0, body_normals[ids0]) < 0.0) | (sign0 * np.linalg.norm(V - closest0, axis=1) < 0.0)
        if np.count_nonzero(inner0) >= SINGLE_SURFACE_FRACTION * len(V):
            pairing = pair_outer_to_inner(V, F, inner0)

    iterations_run = 0
    converged = False
    aborted_on_flips = False
    step_scale = 1.0     # halved by the back-off below

    # Sampled once: only the MINIMUM thickness matters, and a few hundred rays
    # find it. Skipped entirely for the penetration scope, which barely moves
    # anything and cannot compress the shell.
    thickness_samples = None
    if min_thickness > 0 and scope != 'inside' and len(V) > 8:
        stride = max(1, len(V) // int(thickness_sample_cap))
        thickness_samples = np.arange(0, len(V), stride)

    for iteration in range(int(iterations)):
        iterations_run = iteration + 1
        if progress:
            progress(iteration / max(iterations, 1))

        signed, distance, normal = signed_now(V)

        # How far along the body's normal each vertex must travel to sit at the
        # offset. Positive = outward.
        delta = offset - signed

        reach = np.ones(len(V), dtype=bool) if max_distance is None else distance <= max_distance

        if scope == 'inside':
            # Only fix what is actually wrong: inside, or closer than the
            # offset. Everything else keeps the shape the user aligned.
            drive = (signed < offset) & reach
        else:
            # CONFORM, volumetrically: the field is driven by the piece's INNER
            # surface and every vertex is carried by it.
            #
            # This is the whole difference between a fit that works and one that
            # destroys the piece, and it took three failures to see it:
            #
            #   * drive EVERY vertex and project each independently -> the outer
            #     surface lands on the inner one and thickness goes to zero;
            #   * drive every vertex and SMOOTH -> the inner surface wants to
            #     move far, the outer only a little, and smoothing gives both
            #     the average. Thickness is not collapsed but it is steadily
            #     averaged away (0.0755 -> 0.052 on a real armour), and where
            #     the wall gets thin enough the lining pushes through the
            #     outside and renders as brown patches.
            #   * drive only the inner surface and let a SPACE field carry the
            #     rest -> the outer wall inherits the displacement of the inner
            #     wall a few millimetres away, so the shell moves as a solid and
            #     keeps its thickness. That is what a cage/volumetric deform
            #     does, and smooth_field is the cage.
            #
            # A vertex is on the inner surface when its own outward normal
            # opposes the body's normal there — it faces the body. Anything
            # penetrating counts too: it has to come out whichever way it faces.
            piece_normals = _vertex_normals(V, F)
            inner = (np.einsum('ij,ij->i', piece_normals, normal) < 0.0) | (signed < 0.0)

            # A piece with no lining — a solid closed shape, or a single-sided
            # sheet facing away — has no inner surface to drive from, and the
            # test above then selects almost nothing and the fit does nothing at
            # all. There is no thickness to protect in that case, so drive
            # everything. Without this the solid-sphere fixture silently stopped
            # conforming, which is how the earlier version lost its inner test.
            if np.count_nonzero(inner) < SINGLE_SURFACE_FRACTION * len(V):
                inner = np.ones(len(V), dtype=bool)

            drive = inner & reach

        delta = delta * drive

        # ---- group space ---------------------------------------------------
        group_positions = to_groups(V)
        group_delta = to_groups(delta)
        group_drive = to_groups(drive.astype(np.float64)) > 0.5
        group_normal = to_groups(normal)
        # Averaging unit vectors shortens them wherever a group straddles a
        # crease; renormalise or the step silently shrinks there.
        lengths = np.linalg.norm(group_normal, axis=1)
        group_normal = group_normal / np.maximum(lengths, 1e-12)[:, None]

        # The spike guard: a vertex may outrun its NEIGHBOURS by at most
        # `step_clamp` edge lengths. It deliberately does NOT cap absolute
        # motion -- an earlier version did, and that throttled the whole field,
        # so a piece needing to travel a few edge lengths silently fell short of
        # the body however good the maths was. Uniform motion is exactly what
        # should be fast; only local DISAGREEMENT is dangerous, because that is
        # what a bad correspondence looks like.
        local_mean = lap_smooth(group_delta[:, None].copy(), idx, ptr, deg, 1)[:, 0]
        limit = step_clamp * group_edge_length
        group_delta = local_mean + np.clip(group_delta - local_mean, -limit, limit)

        group_displacement = group_delta[:, None] * group_normal

        if lock_axes is not None:
            # Zero the displacement on the locked world axes.
            #
            # Vertical is locked by default for conforming, because the body's
            # normal points UPWARD across the shoulders, the collarbones and the
            # top of the chest -- so an unconstrained conform slides a
            # breastplate up the torso and onto the neck. The user placed the
            # piece at a height on purpose; the fit's job is to reshape its
            # cross-section, not to decide where it sits.
            group_displacement = group_displacement * lock_axes

        if scope != 'inside':
            # THIS is what keeps a garment's thickness: smooth the displacement
            # field SPATIALLY, over each vertex's spatial neighbours, not over
            # the mesh graph.
            #
            # A garment is a shell with an inner and an outer surface. Those two
            # surfaces are spatially adjacent (a few millimetres apart) but
            # geodesically FAR -- to walk from one to the other you go all the
            # way around the rim. So:
            #
            #   * projecting each vertex independently pulls the outer surface
            #     down onto the inner one and the thickness collapses to zero.
            #     That is what "the armour fused onto the body" was.
            #   * smoothing over the GRAPH cannot fix it: there is no short path
            #     between the surfaces, so the inner one moves and the outer one
            #     stays, and the shell stretches instead (38 flipped faces in
            #     the shell fixture).
            #
            # A spatial average makes the field low-frequency in SPACE, so
            # inner and outer receive nearly the same displacement and travel
            # together. It also means the fit reproduces the body's broad shape
            # rather than its every wrinkle, which is what "follow the
            # silhouette" actually means.
            # Spline centres come from the DRIVEN groups only — the inner
            # surface. Including the outer wall would fit the spline through
            # its zeros and drag the field back down, which is the averaging
            # that ate the thickness. Strided rather than random so a re-run of
            # the same fit gives the same answer.
            driven_groups = np.flatnonzero(group_drive)
            if field_centres > 0 and len(driven_groups) > int(field_centres):
                stride = max(1, len(driven_groups) // int(field_centres))
                centres = driven_groups[::stride]
            else:
                centres = driven_groups

            group_displacement = smooth_field(
                group_positions, group_displacement, centres, field_smoothing)

            if lock_axes is not None:
                # Zero the displacement on the locked world axes, AFTER
                # smoothing so the lock cannot be smeared back in.
                #
                # Vertical is locked by default because the body's normal points
                # UPWARD across the shoulders, collarbones and the top of the
                # chest, so an unconstrained conform slides a breastplate up the
                # torso and onto the neck. The user chose the height on purpose;
                # the fit's job is to reshape the cross-section, not to decide
                # where the piece sits.
                group_displacement = group_displacement * lock_axes

            if preserve_centroid:
                # Remove any net translation, so conforming cannot drift the
                # piece bodily off the placement the user chose. Local shape
                # change is untouched -- only the mean is removed.
                moving = group_displacement[group_drive]
                if len(moving):
                    group_displacement -= moving.mean(axis=0)

        # Smooth the FIELD, not the positions. Smoothing positions shrinks the
        # garment; smoothing the displacement kills crease-to-crease zigzag
        # while low-frequency conformance still accumulates over iterations.
        #
        # `alpha` matters more than it looks: at project.py's 0.7 the field is
        # pulled hard toward the neighbourhood mean, which is right for a dense
        # noisy field but wrong for a SPARSE one. Under scope="inside" only the
        # penetrating vertices carry displacement, so their neighbours' zeros
        # drag them back and an isolated penetration escapes at a fraction of
        # its required step per round. A gentler alpha keeps the anti-zigzag
        # benefit without stalling those.
        group_displacement = lap_smooth(group_displacement, idx, ptr, deg,
                                        smooth_rounds, alpha=smooth_alpha)

        # Scattering the GROUP displacement means coincident vertices move
        # identically, so a UV seam or submesh boundary cannot be torn open by
        # the fit: the two sides were welded for the maths and stay together.
        candidate = V + group_displacement[inverse] * strength * step_scale

        # Back off rather than wreck the surface.
        #
        # A conform tightens the piece into the body's concavities -- armpits,
        # under a belt -- and past a point the triangles there turn inside out.
        # Nothing recovers an inverted triangle, so a step that causes too many
        # is rejected and RETRIED at half size, which is an ordinary line
        # search. Simply aborting (an earlier version) was too blunt: at full
        # strength the very first step trips the limit, so the fit gave up
        # having changed nothing and "Fit" looked like it did nothing at all.
        # Backing off instead lets it travel as far as it safely can.
        reject = False
        if flip_abort_frac > 0 and len(F):
            flipped_now = np.count_nonzero(np.einsum(
                'ij,ij->i', normals_before, _face_normals(candidate, F)) < 0.0)
            reject = flipped_now > flip_abort_frac * len(F)

        # And back off before the piece's own two surfaces meet.
        #
        # A garment is a thin shell, and conforming pulls it INWARD: the tube's
        # circumference shortens, and because tangential sliding is forbidden
        # (it would drag the UVs) the material has nowhere to go but into
        # buckling and thinning. Past a point the inner and outer surfaces touch,
        # and where they do the renderer cannot decide which is in front -- the
        # lining flickers through the outside. Users report that as a texture or
        # mipmap bug; it is geometry.
        #
        # This cannot be tuned away with a smoother field (measured: contact
        # count barely moves across field settings), because it is a volume
        # problem rather than a smoothness one. Detecting it and stopping is the
        # honest mitigation until the deform is volumetric.
        if not reject and min_thickness > 0 and thickness_samples is not None:
            if _min_self_thickness(candidate, F, thickness_samples) < min_thickness:
                reject = True

        if reject:
            step_scale *= 0.5
            if step_scale < 0.02:
                aborted_on_flips = True
                break
            continue    # same iteration, smaller step; V is unchanged

        displacement = candidate - V
        V = candidate

        # Stop once the step actually being TAKEN is negligible.
        #
        # Measured on the step rather than the residual `delta`, deliberately:
        # the residual cannot settle to zero, because in a concave crease (an
        # armpit) the closest-point field is genuinely inconsistent and `delta`
        # oscillates forever while the step it produces still shrinks.
        step = float(np.linalg.norm(displacement, axis=1).max()) if len(displacement) else 0.0
        if step <= tolerance * mean_edge:
            converged = True
            break

    # Restore the wall. A space warp cannot contract a surface and keep its
    # thickness (see shell.py), so the outer surface is REBUILT from the
    # conformed inner one at the thickness measured before the fit.
    rebuilt = rebuild_outer(V, pairing) if pairing else 0

    signed_after, _, _ = signed_now(V)

    # Faces whose normal reversed. This is the number that says whether the
    # result is usable: a handful is cosmetic, a large fraction means the fit
    # turned the surface inside out and it should be rejected, not shipped.
    normals_after = _face_normals(V, F)
    flipped = int(np.count_nonzero(
        np.einsum('ij,ij->i', normals_before, normals_after) < 0.0))

    # How many sampled points now have the piece's opposite surface within
    # z-fighting range. This is what makes a lining flicker through the outside,
    # and it is measured even when the guard is off so the UI can NAME it --
    # otherwise it looks like a texture or mipmap bug and gets chased there.
    self_contact = None
    if scope != 'inside' and len(V) > 8:
        stride = max(1, len(V) // 600)
        samples = np.arange(0, len(V), stride)
        before_min = _min_self_thickness(original, F, samples)
        after_min = _min_self_thickness(V, F, samples)
        self_contact = {
            'min_shell_thickness_before': None if before_min == np.inf else before_min,
            'min_shell_thickness_after': None if after_min == np.inf else after_min,
            'touching': bool(after_min < 1e-4),
        }

    moved = np.linalg.norm(V - original, axis=1)
    stats = {
        'scope': scope,
        'offset': float(offset),
        'driven_fraction': float(np.count_nonzero(drive) / max(len(V), 1)),
        'shell_rebuilt_vertices': int(rebuilt),
        'lock_vertical': bool(lock_axes is not None),
        'preserve_centroid': bool(preserve_centroid),
        'iterations_run': int(iterations_run),
        'iteration_budget': int(iterations),
        'converged': bool(converged),
        'stopped_on_inversion': bool(aborted_on_flips),
        'min_thickness_limit': float(min_thickness),
        'self_contact': self_contact,
        'strength': float(strength),
        'final_step_scale': float(step_scale),
        'vertices': int(len(V)),
        'welded_vertices': int(group_count),
        'moved_vertices': int(np.count_nonzero(moved > 1e-9)),
        'max_move': float(moved.max()) if moved.size else 0.0,
        'mean_move': float(moved.mean()) if moved.size else 0.0,
        'penetrating_before': inside_before,
        'penetrating_after': int(np.count_nonzero(signed_after < 0)),
        'max_depth_before': depth_before,
        'max_depth_after': float(max(0.0, -signed_after.min())) if signed_after.size else 0.0,
        # Signed closest approach: negative means still penetrating, positive is
        # the tightest clearance anywhere. A different question from "how deep".
        'min_clearance_after': float(signed_after.min()) if signed_after.size else 0.0,
        'flipped_faces': flipped,
        'face_count': int(len(F)),
    }
    return np.ascontiguousarray(V), stats
