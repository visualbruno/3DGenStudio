"""Orchestrator: TreeSpec -> GLB scene.

Bark and foliage stay as two separate geometries with two materials, which is
not an aesthetic choice: foliage is alpha-tested, and merging it into the trunk
would drag the whole tree into the transparent pass and cost more than the draw
call it saved.

This is also where the AI hook lands. Structure is procedural and surface is
generative -- a species prompt produces the tileable bark and the leaf atlas,
and the same TreeSpec then wears them. Procedural structure plus generative
surface is the combination that nothing else ships; the geometry side of it is
just "accept two PNGs and wire them to the right material".
"""
from __future__ import annotations

import time

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial

from .bark import build_bark
from .crown import build_crown, sample_attractors
from .foliage import build_foliage
from .junctions import clean_junctions
from .impostor import bake_impostor
from .lod import cull_skeleton, describe_level, lod_levels, lod_spec
from .skeleton import build_skeleton
from .textures import decode_image, resolve_leaf_atlas
from .spec import TreeSpec

# Fallbacks when no generated texture is supplied. Chosen to read as bark/leaf
# under neutral lighting so an untextured preview is still legible.
_BARK_COLOR = [0.36, 0.27, 0.20, 1.0]
_LEAF_COLOR = [0.24, 0.42, 0.16, 1.0]

_ENGINE_DEFAULTS = {
    # (up_axis, scale). Unreal works in centimetres; the rest in metres.
    "generic": ("y", 1.0),
    "unity": ("y", 1.0),
    "unreal": ("z", 100.0),
    "godot": ("y", 1.0),
}



def _make_geometry(vertices, faces, normals, uvs, wind, material, wind_colors: bool):
    """One Trimesh with explicit normals, analytic UVs and the wind COLOR_0 channel."""
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False, validate=False)

    visual = trimesh.visual.TextureVisuals(uv=np.asarray(uvs, dtype=np.float64), material=material)
    if wind_colors and len(wind) == len(vertices):
        # glTF COLOR_0 as normalized uint8. trimesh only exports this alongside a
        # TextureVisuals when it is set as the `color` vertex attribute -- setting
        # `vertex_colors` instead would replace the TextureVisuals wholesale and
        # take the UVs with it.
        visual.vertex_attributes["color"] = np.clip(
            np.asarray(wind, dtype=np.float64) * 255.0, 0, 255).astype(np.uint8)
    mesh.visual = visual

    # Assign last: trimesh caches normals, and anything that touches topology
    # after this point (it must not) would ship stale ones.
    mesh.vertex_normals = np.asarray(normals, dtype=np.float64)
    return mesh


def _orient(scene: trimesh.Scene, spec: TreeSpec) -> trimesh.Scene:
    """Apply the engine's axis convention and unit scale. Pivot stays at the trunk base."""
    up_axis, scale = _ENGINE_DEFAULTS.get(spec.output.engine, ("y", 1.0))
    if spec.output.engine == "generic":
        up_axis, scale = spec.output.up_axis, spec.output.scale

    transform = np.eye(4)
    if up_axis == "z":
        # Y-up -> Z-up: the mesh is built Y-up, and glTF is Y-up by spec, so this
        # is only for pipelines that want the DCC convention baked in.
        transform = trimesh.transformations.rotation_matrix(np.pi / 2.0, [1, 0, 0])
    if scale != 1.0:
        transform = np.diag([scale, scale, scale, 1.0]) @ transform
    if not np.allclose(transform, np.eye(4)):
        scene.apply_transform(transform)
    return scene


def build_level_scene(spec, skeleton, crown_centre, textures, emit=None, progress_base=0.58,
                      progress_span=0.34):
    """Skin one skeleton into a scene. The whole mesh stage, minus the growing.

    Split out of `generate_tree` so an LOD chain can call it once per level
    against the SAME skeleton -- which is the property the whole LOD approach
    rests on (see lod.py).

    `textures` is (trunk_image, branch_image, leaf_image).
    """
    trunk_image, branch_image, leaf_image = textures
    split_branches = branch_image is not None
    rng = np.random.default_rng(int(spec.seed))

    def report(frac, message):
        if emit is not None:
            emit("mesh", progress_base + progress_span * frac, message)

    report(0.0, "Sweeping bark")
    bark_groups, bark_stats = build_bark(
        spec, skeleton,
        on_progress=lambda frac: report(0.55 * frac, "Sweeping bark"),
        split_branches=split_branches,
    )
    if not bark_groups:
        raise ValueError("The skeleton produced no bark geometry.")

    if spec.bark.junction_mode == "clean":
        report(0.6, "Welding junctions")
        cleaned = {}
        for name, (vertices, faces, _normals, _uvs, _wind) in bark_groups.items():
            v, f, n, uv, w, junction_stats = clean_junctions(
                spec, skeleton, vertices, faces,
                on_progress=lambda frac, message: report(0.6 + 0.1 * frac, message),
            )
            cleaned[name] = (v, f, n, uv, w)
            bark_stats = {**bark_stats, **junction_stats}
        bark_groups = cleaned
        bark_stats["vertices"] = int(sum(len(g[0]) for g in bark_groups.values()))
        bark_stats["faces"] = int(sum(len(g[1]) for g in bark_groups.values()))

    report(0.75, "Placing foliage")
    leaf_vertices, leaf_faces, leaf_normals, leaf_uvs, leaf_wind, leaf_stats = build_foliage(
        spec, skeleton, crown_centre, rng)

    report(0.9, "Assembling")
    scene = trimesh.Scene()
    group_textures = {"trunk": trunk_image, "branches": branch_image or trunk_image}
    group_names = {"trunk": "Tree_Trunk" if split_branches else "Tree_Bark",
                   "branches": "Tree_Branches"}
    for name, (vertices, faces, normals, uvs, wind) in bark_groups.items():
        material = PBRMaterial(
            name=f"Tree{name.capitalize()}",
            baseColorFactor=_BARK_COLOR,
            baseColorTexture=group_textures.get(name),
            roughnessFactor=0.92,
            metallicFactor=0.0,
        )
        node_name = group_names[name]
        scene.add_geometry(
            _make_geometry(vertices, faces, normals, uvs, wind, material, spec.output.wind_colors),
            geom_name=node_name, node_name=node_name,
        )

    if len(leaf_faces):
        leaf_material = PBRMaterial(
            name="TreeFoliage",
            baseColorFactor=_LEAF_COLOR,
            baseColorTexture=leaf_image,
            roughnessFactor=0.75,
            metallicFactor=0.0,
            # MASK, not BLEND: alpha-tested foliage sorts correctly against
            # itself, which blended foliage never does.
            alphaMode="MASK" if leaf_image else "OPAQUE",
            alphaCutoff=0.5,
            doubleSided=bool(spec.foliage.double_sided),
        )
        scene.add_geometry(
            _make_geometry(leaf_vertices, leaf_faces, leaf_normals, leaf_uvs, leaf_wind,
                           leaf_material, spec.output.wind_colors),
            geom_name="Tree_Foliage", node_name="Tree_Foliage",
        )

    _orient(scene, spec)
    totals = {
        "vertices": int(bark_stats["vertices"] + len(leaf_vertices)),
        "faces": int(bark_stats["faces"] + len(leaf_faces)),
        "draw_calls": len(scene.geometry),
    }
    return scene, {"bark": bark_stats, "foliage": leaf_stats, "totals": totals}


def generate_tree(spec: TreeSpec, bark_texture=None, leaf_atlas=None,
                  branch_texture=None, leaf_images=None, on_progress=None) -> dict:
    """Build the full tree. Returns {scene, glb, stats}.

    Textures are optional and independent:
      bark_texture    tileable colour for the trunk (and for branches unless
                      `branch_texture` is given)
      branch_texture  a separate colour for the thin wood; supplying it splits
                      the bark into two materials, so it costs a draw call and
                      is only done when asked for
      leaf_images     a LIST of leaf cut-outs, composed into an atlas here --
                      what a person actually has
      leaf_atlas      a ready-made atlas, for callers that already built one

    Each accepts raw bytes, base64, or a data: URL.

    `on_progress(stage, frac, message)` mirrors the SSE contract the other mesh
    tools use, so the route handler can forward it unchanged.
    """
    def emit(stage, frac, message=""):
        if on_progress is not None:
            on_progress(stage, frac, message)

    started = time.time()
    # One generator for the whole build. Every stage draws from it in a fixed
    # order, which is what makes the same seed give the same tree.
    rng = np.random.default_rng(int(spec.seed))

    emit("crown", 0.02, "Sampling the crown envelope")
    crown = build_crown(spec)
    attractors = sample_attractors(spec, crown, rng)
    if len(attractors) == 0:
        raise ValueError("The crown envelope produced no attraction points -- check its shape and radius.")

    emit("skeleton", 0.10, "Growing branches")
    skeleton = build_skeleton(
        spec, crown, attractors, rng,
        on_progress=lambda frac, nodes: emit("skeleton", 0.10 + 0.45 * frac, f"Growing branches ({nodes} nodes)"),
    )
    skeleton_time = time.time() - started

    # Decode the textures first: a bad image should fail before a second of
    # geometry work, not after it.
    trunk_image = decode_image(bark_texture, "bark texture")
    branch_image = decode_image(branch_texture, "branch texture")
    leaf_image, atlas_cols, atlas_rows, atlas_tiles = resolve_leaf_atlas(
        leaf_atlas, leaf_images, spec.foliage.atlas_cols, spec.foliage.atlas_rows)
    # The composed grid is authoritative -- the cards must index the atlas that
    # was actually baked, not the one the spec happened to say.
    spec = spec.model_copy(deep=True)
    spec.foliage.atlas_cols = int(atlas_cols or spec.foliage.atlas_cols)
    spec.foliage.atlas_rows = int(atlas_rows or spec.foliage.atlas_rows)
    spec.foliage.atlas_tiles = int(atlas_tiles or spec.foliage.atlas_tiles)
    split_branches = branch_image is not None

    emit("mesh", 0.58, "Building the mesh")
    scene, level_stats = build_level_scene(
        spec, skeleton, np.asarray(crown.centre, dtype=np.float64),
        (trunk_image, branch_image, leaf_image), emit=emit,
    )
    bark_stats = level_stats["bark"]
    leaf_stats = level_stats["foliage"]

    glb = scene.export(file_type="glb")
    elapsed = time.time() - started

    stats = {
        "seed": int(spec.seed),
        "height": float(spec.height),
        "skeleton": {
            "nodes": int(skeleton.node_count),
            "chains": int(len(skeleton.chains)),
            "max_order": int(skeleton.max_order),
            "iterations": int(skeleton.iterations),
            "attractors": int(len(attractors)),
            "attractors_used": int(skeleton.attractors_used),
            "seconds": round(skeleton_time, 3),
        },
        "bark": bark_stats,
        "foliage": leaf_stats,
        "totals": level_stats["totals"],
        "textures": {
            "trunk": bool(trunk_image),
            "branches": bool(branch_image),
            "leaves": bool(leaf_image),
            "atlas_grid": [spec.foliage.atlas_cols, spec.foliage.atlas_rows],
            "atlas_tiles": int(spec.foliage.atlas_tiles or spec.foliage.atlas_cols * spec.foliage.atlas_rows),
        },
        "seconds": round(elapsed, 3),
    }

    emit("complete", 1.0, "Tree complete")
    return {"scene": scene, "glb": glb, "stats": stats, "skeleton": skeleton}


def generate_tree_lods(spec: TreeSpec, bark_texture=None, leaf_atlas=None,
                       branch_texture=None, leaf_images=None, on_progress=None) -> dict:
    """Generate the whole LOD chain from ONE skeleton.

    Returns {levels: [{level, glb, stats}], skeleton, seconds}.

    The skeleton is grown once and every level is a different skin over it, so
    the branches sit in identical places at every distance. Regrowing per level
    would be both slower and worse -- a different tree at each threshold is the
    most visible popping there is. See lod.py.
    """
    def emit(stage, frac, message=""):
        if on_progress is not None:
            on_progress(stage, frac, message)

    started = time.time()
    rng = np.random.default_rng(int(spec.seed))

    emit("crown", 0.02, "Sampling the crown envelope")
    crown = build_crown(spec)
    attractors = sample_attractors(spec, crown, rng)
    if len(attractors) == 0:
        raise ValueError("The crown envelope produced no attraction points -- check its shape and radius.")

    trunk_image = decode_image(bark_texture, "bark texture")
    branch_image = decode_image(branch_texture, "branch texture")
    leaf_image, atlas_cols, atlas_rows, atlas_tiles = resolve_leaf_atlas(
        leaf_atlas, leaf_images, spec.foliage.atlas_cols, spec.foliage.atlas_rows)

    base = spec.model_copy(deep=True)
    base.foliage.atlas_cols = int(atlas_cols or base.foliage.atlas_cols)
    base.foliage.atlas_rows = int(atlas_rows or base.foliage.atlas_rows)
    base.foliage.atlas_tiles = int(atlas_tiles or base.foliage.atlas_tiles)

    emit("skeleton", 0.08, "Growing branches")
    skeleton = build_skeleton(
        base, crown, attractors, rng,
        on_progress=lambda frac, nodes: emit("skeleton", 0.08 + 0.22 * frac,
                                             f"Growing branches ({nodes} nodes)"),
    )
    crown_centre = np.asarray(crown.centre, dtype=np.float64)
    textures = (trunk_image, branch_image, leaf_image)

    indices = lod_levels(base)
    span = 0.65 / max(len(indices), 1)
    levels = []
    for position, level in enumerate(indices):
        level_spec = lod_spec(base, level, skeleton_max_order=skeleton.max_order)
        # Culling is applied to the BUILT skeleton, never by regrowing it: the
        # surviving branches keep their exact positions and radii.
        level_skeleton = cull_skeleton(skeleton, level_spec.branching.max_order)
        emit("mesh", 0.30 + span * position, f"Building LOD{level}")
        scene, level_stats = build_level_scene(
            level_spec, level_skeleton, crown_centre, textures,
        )
        levels.append({
            "level": level,
            "scene": scene,
            "glb": scene.export(file_type="glb"),
            "stats": {**level_stats, "settings": describe_level(level, level_spec)},
        })

    impostor = None
    if base.output.impostor:
        emit("impostor", 0.95, "Baking impostor views")
        # Baked from LOD0, the FULL-detail tree.
        #
        # Baking from the cheapest level to save time is the obvious move and it
        # is wrong: the impostor replaces the geometry entirely at distance, so
        # its silhouette IS the tree there, and a coarse level's thinned canopy
        # gets frozen into the atlas permanently. Measured side by side, LOD0
        # covers 19.6% of the atlas against 10.2% from the last level -- a full
        # crown against a scraggly one -- for about two extra seconds.
        impostor = bake_impostor(
            levels[0]["scene"],
            grid=int(base.output.impostor_grid),
            tile=int(base.output.impostor_tile),
            seed=int(base.seed),
            samples_per_pixel=float(base.output.impostor_samples),
            on_progress=lambda frac, message: emit("impostor", 0.95 + 0.05 * frac, message),
        )

    elapsed = time.time() - started
    emit("complete", 1.0, f"{len(levels)} LOD levels complete")
    return {
        "levels": levels,
        "impostor": impostor,
        "skeleton": skeleton,
        "spec": base,
        "seconds": round(elapsed, 3),
        "skeleton_stats": {
            "nodes": int(skeleton.node_count),
            "chains": int(len(skeleton.chains)),
            "max_order": int(skeleton.max_order),
            "attractors": int(len(attractors)),
        },
    }


def coarsen(spec: TreeSpec, quality: float) -> TreeSpec:
    """A cheaper spec that grows the same *shape* at lower resolution.

    Attractor count scales with quality and the step grows to match, keeping
    roughly the same branch layout while cutting the node count -- so the
    preview reads as the same tree even though it is not the same mesh.
    """
    quality = float(np.clip(quality, 0.02, 1.0))
    if quality >= 0.999:
        return spec
    coarse = spec.model_copy(deep=True)
    coarse.skeleton.attractors = max(int(spec.skeleton.attractors * quality), 24)
    # Node spacing scales as the cube root of the density change; anything else
    # and the preview grows a visibly different number of branches.
    coarse.skeleton.step_ratio = min(spec.skeleton.step_ratio / (quality ** (1.0 / 3.0)), 0.6)
    coarse.skeleton.smoothing = min(spec.skeleton.smoothing, 1)
    return coarse


def preview_skeleton(spec: TreeSpec, quality: float = 0.2) -> dict:
    """Skeleton polylines only -- the payload behind live slider scrubbing.

    Deliberately skips every mesh stage: the point is to answer while a slider is
    still moving, so the UI can redraw the branch structure continuously and
    build the real mesh only on commit. At full quality the skeleton alone is
    ~0.5s, which is a lifetime under a drag, hence the coarsening: the default
    0.2 measures ~85ms for a default oak. Pass quality=1.0 for a preview that
    matches the final mesh exactly.
    """
    started = time.time()
    working = coarsen(spec, quality)
    rng = np.random.default_rng(int(working.seed))
    crown = build_crown(working)
    attractors = sample_attractors(working, crown, rng)
    if len(attractors) == 0:
        raise ValueError("The crown envelope produced no attraction points -- check its shape and radius.")
    skeleton = build_skeleton(working, crown, attractors, rng)

    return {
        "polylines": skeleton.polylines(),
        "radii": [skeleton.radii[c].tolist() for c in skeleton.chains],
        "bounds": {
            "min": skeleton.positions.min(axis=0).tolist(),
            "max": skeleton.positions.max(axis=0).tolist(),
        },
        "stats": {
            "nodes": int(skeleton.node_count),
            "chains": int(len(skeleton.chains)),
            "max_order": int(skeleton.max_order),
            "attractors": int(len(attractors)),
            "quality": round(float(quality), 3),
            "seconds": round(time.time() - started, 3),
        },
    }
