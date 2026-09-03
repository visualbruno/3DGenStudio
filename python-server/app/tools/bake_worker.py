"""High-to-low poly texture bake worker (headless Blender).

Runs `bpy` in ISOLATION: invoked as a subprocess by app/services/bake.py
(`python bake_worker.py --low low.glb --high high.glb --outdir dir --options o.json`).
Never import this module from the service — bpy is not thread-safe, holds ~1GB
RSS once imported, and a crash inside Blender must not take the API down.

This is the step that makes Auto Retopo and Optimize non-destructive. On their
own they hand back clean topology with the detail *deleted*; baking captures that
detail as a normal map (plus AO and a base-colour transfer) so the low-poly mesh
still reads as the high-poly one.

Blender's "selected to active" bake casts rays from the low-poly surface out to
the high-poly one, which is why both meshes are loaded into a single scene and
the low-poly is made active. The low-poly must carry UVs — there is nowhere to
write otherwise.

Protocol: progress/result JSON lines on stdout prefixed with GENSTUDIO_EVT
(bpy prints its own "Info:" noise, the parent ignores non-matching lines).
Exit codes: 0 ok, 2 bake error, 3 validation failed, 4 bpy missing.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SENTINEL = "GENSTUDIO_EVT "  # keep in sync with app/services/bake.py

# name -> (bake pass, colour space, principled input to rewire or None).
#
# Blender has no METALLIC bake pass (its passes are AO, COMBINED, DIFFUSE, EMIT,
# ENVIRONMENT, GLOSSY, NORMAL, POSITION, ROUGHNESS, SHADOW, TRANSMISSION, UV), so
# metallic is captured by temporarily routing the high-poly's Metallic input into
# an Emission shader and baking EMIT. Roughness has a native pass and needs no
# such trick.
#
# Base colour goes through that same rewire rather than through the DIFFUSE pass,
# which looks like the obvious choice and is a trap: DIFFUSE returns the *diffuse
# lobe* albedo, which for a Principled BSDF is base_color * (1 - metallic). A 60%
# metallic source therefore bakes at 40% brightness and a fully metallic one bakes
# pure black — and glTF's default metallicFactor is 1.0, so this also hits meshes
# that simply never wrote the field. EMIT off Base Color is exact at any metallic
# (measured: a 200/140/60 source round-trips byte-for-byte, where DIFFUSE gave
# 144/100/41 at metallic 0.5 and 0/0/0 at metallic 1.0).
#
# Everything except base colour is DATA, not colour, so it is written Non-Color:
# an sRGB-tagged roughness map would come back gamma-encoded and read wrong.
#
# Order matters and is the iteration order below: a rewire replaces the material's
# Surface link, so every pass that reads the real shader (ROUGHNESS) has to run
# before the first rewired one.
BAKE_PASSES = {
    "normal": ("NORMAL", "Non-Color", None),
    "ao": ("AO", "Non-Color", None),
    "roughness": ("ROUGHNESS", "Non-Color", None),
    "base_color": ("EMIT", "sRGB", "Base Color"),
    "metallic": ("EMIT", "Non-Color", "Metallic"),
}

BAKE_ORDER = ["normal", "ao", "roughness", "base_color", "metallic"]

# Passes that bake natively but still map to a Principled input, so the "this came
# from a constant, the map is flat" check applies to them as well.
PROBE_INPUTS = {"roughness": "Roughness"}

# glTF packs occlusion/roughness/metallic into one texture's R/G/B. Producing that
# packed form means three.js can hand it to all three material slots as a single
# object, which is both what the format wants and what lets its exporter skip
# recompositing the channels.
ORM_CHANNELS = ["ao", "roughness", "metallic"]
# Neutral values for channels that were not baked: no occlusion, fully rough,
# non-metal. Only the baked channels are ever read back on the client, so these
# are padding rather than claims about the material.
ORM_NEUTRAL = {"ao": 255, "roughness": 255, "metallic": 0}

# ── Alignment ───────────────────────────────────────────────────────────────
# A "selected to active" bake is PURELY SPATIAL: rays leave the low-poly surface
# and whatever they hit on the high-poly is what gets written. So the two meshes
# have to occupy the same world space, and nothing upstream guarantees that — the
# editor's automatic snapshots share whichever space the mesh was in at the time,
# but a source picked from the asset library arrives in raw file space. Move the
# pivot in between (Game-Ready's "set pivot on the ground" is one click) and the
# source is silently offset by the model's half-height from then on, with no
# symptom until the bake comes back black wherever the two no longer overlap.
#
# Two meshes at the same SCALE whose bounding boxes are merely offset are the same
# object with different pivots, and re-centring the source is unambiguously right.
# Different scales mean we are looking at different objects (or a unit mismatch),
# where a guess would be worse than the honest report — so that case is measured
# and left alone.
ALIGN_SCALE_TOLERANCE = 0.05  # per-axis extent agreement required to re-centre
ALIGN_MIN_OFFSET_FRAC = 0.001  # offsets below this fraction of the diagonal are noise


def emit(stage: str, frac: float, message: str = "") -> None:
    print(f"{SENTINEL}{json.dumps({'type': 'progress', 'stage': stage, 'frac': round(frac, 4), 'message': message})}", flush=True)


def fail(code: int, error: str) -> None:
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': False, 'error': error})}", flush=True)
    sys.exit(code)


def principled_input_is_linked(objects, input_name: str) -> bool:
    """Is a Principled BSDF input driven by a node graph rather than a constant?

    Used by the passes that need no rewiring (roughness has a native bake) so they
    can report a flat result for the same reason the rewired ones do. Without this
    a constant-roughness source would silently produce a flat map with no warning,
    while constant metallic warned — an inconsistency that only shows up as
    surprise later.
    """
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            socket = bsdf.inputs.get(input_name) if bsdf else None
            if socket is not None and socket.is_linked:
                return True
    return False


def rewire_to_emit(objects, input_name: str) -> tuple[bool, bool]:
    """Route a Principled BSDF input into an Emission shader so EMIT can bake it.

    Returns (rewired, driven_by_graph).

    `driven_by_graph` is True when a *texture* (or any node graph) actually drives
    the input on at least one material. When it is only a constant, the bake still
    succeeds but produces a flat map — which is strictly worse than the scalar it
    came from, so the caller reports that rather than pretending the map is useful.

    `rewired` is False when no material had a Principled BSDF to read, which the
    caller has to know about: an EMIT bake against a shader graph we never touched
    comes back black rather than wrong-but-plausible.

    Blender's glTF importer wires metallic/roughness through a Separate Color node
    fed by the packed ORM texture, so the upstream socket here is normally that
    node's B (or G) output. Linking a single float output into Emission's Color
    broadcasts it across RGB, which is exactly what a data bake wants.
    """
    rewired = False
    driven_by_graph = False
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            tree = material.node_tree
            bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
            if not bsdf or not output:
                continue
            socket = bsdf.inputs.get(input_name)
            if socket is None:
                continue

            emission = tree.nodes.new("ShaderNodeEmission")
            if socket.is_linked:
                tree.links.new(socket.links[0].from_socket, emission.inputs["Color"])
                driven_by_graph = True
            else:
                # Scalar inputs (Metallic) broadcast across RGB; Base Color is
                # already a 4-float and is copied straight through.
                raw = socket.default_value
                try:
                    value = float(raw)
                    rgba = (value, value, value, 1.0)
                except TypeError:
                    rgba = (raw[0], raw[1], raw[2], 1.0)
                emission.inputs["Color"].default_value = rgba
            tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
            rewired = True
    return rewired, driven_by_graph


def world_bounds(objects) -> tuple[list, list]:
    """Axis-aligned world-space bounds over a set of objects, as ([min], [max]).

    Read off each object's `bound_box` through its world matrix rather than from
    the vertices: the corners are eight points instead of hundreds of thousands,
    and an axis-aligned box of the transformed corners is exactly what the overlap
    measure below needs.
    """
    from mathutils import Vector

    low = [float("inf")] * 3
    high = [float("-inf")] * 3
    for obj in objects:
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
    return low, high


def box_overlap(target: tuple, source: tuple) -> float:
    """How much of `target`'s box the `source` box covers, as the WORST axis.

    The worst axis rather than the volume ratio, because the volume ratio hides
    exactly the failure this is here to catch: a source offset along one axis only
    still has two axes overlapping perfectly, so its volume ratio stays
    respectable while half the mesh has nothing to sample. Axes whose target
    extent is degenerate (a flat plane) are skipped rather than counted as a
    total miss.
    """
    t_min, t_max = target
    s_min, s_max = source
    scale = max(t_max[axis] - t_min[axis] for axis in range(3))
    worst = 1.0
    for axis in range(3):
        extent = t_max[axis] - t_min[axis]
        if extent <= scale * 1e-4:
            continue
        span = min(t_max[axis], s_max[axis]) - max(t_min[axis], s_min[axis])
        worst = min(worst, max(span, 0.0) / extent)
    return worst


def align_source(low, high_objects) -> dict:
    """Re-centre the high-poly onto the low-poly when the two are the same object.

    Returns a report dict (always), having translated `high_objects` in place when
    it decided to. Centre-to-centre is the estimator rather than min-to-min: the
    low-poly is normally a simplification of the high-poly, and simplification
    shaves the extremities at BOTH ends, so the centres stay put where either end
    of the box drifts. The residual after re-centring is a few thousandths of the
    model — well inside the cage extrusion, which is 2% of the diagonal.
    """
    from mathutils import Matrix, Vector

    target = world_bounds([low])
    source = world_bounds(high_objects)
    t_min, t_max = target
    s_min, s_max = source

    t_extent = [t_max[i] - t_min[i] for i in range(3)]
    s_extent = [s_max[i] - s_min[i] for i in range(3)]
    diagonal = sum(e * e for e in t_extent) ** 0.5

    offset = [((t_min[i] + t_max[i]) - (s_min[i] + s_max[i])) / 2 for i in range(3)]
    distance = sum(o * o for o in offset) ** 0.5

    report = {
        "target_bounds": [t_min, t_max],
        "source_bounds": [s_min, s_max],
        "offset": offset,
        "overlap_before": round(box_overlap(target, source), 4),
    }

    # A scale check has to tolerate the extremities simplification removes, which
    # is what ALIGN_SCALE_TOLERANCE is sized for. Compared against the diagonal
    # rather than each axis's own extent so a thin axis (a 2cm-deep relief on a 2m
    # panel) is not judged by a hair's breadth.
    scale_matches = all(
        abs(t_extent[i] - s_extent[i]) <= ALIGN_SCALE_TOLERANCE * max(diagonal, 1e-9)
        for i in range(3)
    )
    if not scale_matches:
        report["mode"] = "skipped-scale"
        report["overlap"] = report["overlap_before"]
        return report

    if distance <= ALIGN_MIN_OFFSET_FRAC * max(diagonal, 1e-9):
        report["mode"] = "not-needed"
        report["overlap"] = report["overlap_before"]
        return report

    shift = Matrix.Translation(Vector(offset))
    for obj in high_objects:
        # Through matrix_world so a mesh parented under an imported empty moves by
        # the offset in WORLD space, which is the space the offset was measured in.
        obj.matrix_world = shift @ obj.matrix_world
    import bpy
    bpy.context.view_layer.update()

    report["mode"] = "applied"
    report["distance"] = round(distance, 6)
    report["overlap"] = round(box_overlap(target, world_bounds(high_objects)), 4)
    return report


def measure_coverage(low, outdir, written: dict, resolution: int) -> dict | None:
    """What fraction of the UV layout actually received ray hits?

    The one number that tells a good bake from a ruined one, and until now nothing
    computed it: a bake whose rays all miss still exits 0 with a full set of PNGs,
    every texel cleared to transparent black. Against a dark model that is
    invisible — which is precisely how a bake covering an eighth of the mesh got
    applied and saved.

    Measured as (baked texels ∩ UV layout) / (UV layout), where "baked" is the
    alpha channel the bake writes only for texels whose ray HIT and "UV layout" is
    the low-poly's render UV set rasterised at the bake resolution.

    Intersecting with the layout is not optional, and this is the trap: alpha is a
    hit mask ONLY INSIDE the layout. Outside it, margin dilation leaves alpha set
    across essentially the whole gutter (measured: 99.9% of it, 92% of that with no
    colour behind it), so alpha on its own reads as near-total coverage no matter
    how badly the bake went. Inside the layout it is clean — on the misaligned bake
    this was written for, 52.7% of layout texels came back alpha 0 against 43.3%
    carrying colour.

    The threshold is deliberately stricter than the one pack_orm uses. Here a
    partially-dilated edge texel should not count as a hit, because the number's
    whole job is to under-claim rather than over-claim success; pack_orm asks the
    opposite question ("is there definitely nothing here?") and so tests for
    exactly zero, which keeps it from overwriting real colour at island edges.

    Returns None when it cannot be measured — the maps are still perfectly good,
    so this must never be the reason a bake fails.
    """
    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except Exception as exc:  # noqa: BLE001
        print(f"Coverage measurement unavailable ({exc}).", flush=True)
        return None

    source = next((written[name] for name in BAKE_ORDER if name in written), None)
    if not source:
        return None

    try:
        image = Image.open(outdir / source)
        if "A" not in image.getbands():
            return None
        baked = np.asarray(image.getchannel("A"), dtype=np.uint8) > 127

        mesh = low.data
        # Blender bakes into the ACTIVE RENDER uv set, which is not necessarily the
        # one selected in the UI — measuring the other one would be measuring a
        # layout the bake never wrote to.
        uv_layer = next((layer for layer in mesh.uv_layers if layer.active_render), mesh.uv_layers.active)
        if uv_layer is None:
            return None
        # Removed in newer Blender, where the cache is maintained automatically.
        if hasattr(mesh, "calc_loop_triangles"):
            mesh.calc_loop_triangles()

        height, width = baked.shape
        layout = Image.new("1", (width, height), 0)
        draw = ImageDraw.Draw(layout)
        data = uv_layer.data
        # Blender's V runs bottom-up and its PNG writer flips on save, so the saved
        # image's top row is V=1 — hence (1 - v) here. Getting this backwards would
        # measure the layout against a mirror image of itself and report nonsense.
        for triangle in mesh.loop_triangles:
            draw.polygon([
                (data[loop].uv[0] * width, (1.0 - data[loop].uv[1]) * height)
                for loop in triangle.loops
            ], fill=1)
        layout_mask = np.asarray(layout, dtype=bool)

        layout_texels = int(layout_mask.sum())
        if not layout_texels:
            return None
        covered = int((layout_mask & baked).sum())
        return {
            "coverage": round(covered / layout_texels, 4),
            "covered_texels": covered,
            "layout_texels": layout_texels,
            "layout_frac": round(layout_texels / float(width * height), 4),
        }
    except Exception as exc:  # noqa: BLE001
        print(f"Coverage measurement failed ({exc}).", flush=True)
        return None


def pack_orm(written: dict, outdir, resolution: int) -> tuple[str | None, list]:
    """Compose the baked AO/roughness/metallic into one R/G/B texture.

    Returns (filename, channels_actually_baked). Skipped unless at least two of
    the three exist — a single channel is better served by its own map.
    """
    present = [name for name in ORM_CHANNELS if name in written]
    if len(present) < 2:
        return None, present

    try:
        import numpy as np
        from PIL import Image
    except Exception as exc:  # noqa: BLE001 — the individual maps are still returned
        print(f"ORM packing unavailable ({exc}); returning separate maps.", flush=True)
        return None, present

    planes = []
    for name in ORM_CHANNELS:
        if name in written:
            image = Image.open(outdir / written[name])
            if image.size != (resolution, resolution):
                image = image.resize((resolution, resolution), Image.LANCZOS)
            plane = np.asarray(image.convert("L"), dtype=np.uint8)
            # Texels whose ray missed carry the transparent-black clear value, and
            # 0 is a MEANINGFUL number in all three of these channels — fully
            # occluded, mirror-smooth, and (for metallic) the only one where 0 is
            # harmless. Substituting the neutral value keeps a partial bake from
            # ringing the mesh in black shadow and glossy patches; the alpha
            # channel is what says which texels those are. ORM itself stays RGB,
            # as glTF wants, so the mask cannot travel with it.
            if "A" in image.getbands():
                miss = np.asarray(image.getchannel("A"), dtype=np.uint8) == 0
                plane = np.where(miss, ORM_NEUTRAL[name], plane).astype(np.uint8)
            planes.append(plane)
        else:
            planes.append(np.full((resolution, resolution), ORM_NEUTRAL[name], dtype=np.uint8))

    Image.fromarray(np.dstack(planes), mode="RGB").save(outdir / "orm.png")
    return "orm.png", present


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--low", required=True)
    parser.add_argument("--high", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--options", required=True)
    args = parser.parse_args()

    options = json.loads(Path(args.options).read_text(encoding="utf-8"))
    resolution = int(options.get("resolution", 2048))
    maps = [m for m in options.get("maps", ["normal", "ao"]) if m in BAKE_PASSES]
    if not maps:
        fail(3, "No valid bake maps were requested.")

    try:
        import bpy
    except Exception as exc:  # noqa: BLE001
        fail(4, f"Blender (bpy) is not available on the mesh-tools service: {exc}")

    emit("scene", 0.05, "Preparing the scene…")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    def import_glb(path: str) -> list:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]

    emit("import", 0.12, "Importing the low-poly mesh…")
    low_objects = import_glb(args.low)
    if not low_objects:
        fail(3, "The low-poly file contains no mesh.")
    low = low_objects[0]

    if not low.data.uv_layers:
        fail(3, "The low-poly mesh has no UVs. Run Auto UV before baking.")

    emit("import", 0.2, "Importing the high-poly mesh…")
    high_objects = import_glb(args.high)
    if not high_objects:
        fail(3, "The high-poly source file contains no mesh.")

    # Put the two meshes in the same space before anything expensive runs. See the
    # ALIGN_* constants: a bake is ray casting, so an offset source produces black
    # wherever the boxes stop overlapping, and this is the only place that holds
    # both meshes and can tell.
    emit("align", 0.22, "Checking source alignment…")
    if bool(options.get("align_source", True)):
        alignment = align_source(low, high_objects)
    else:
        target, source = world_bounds([low]), world_bounds(high_objects)
        # The bounds go in even here: they are what the refusal below quotes, and
        # an error naming (0,0,0)..(0,0,0) tells the reader nothing.
        alignment = {
            "mode": "disabled",
            "target_bounds": [target[0], target[1]],
            "source_bounds": [source[0], source[1]],
            "overlap": round(box_overlap(target, source), 4),
        }
    if alignment["mode"] == "applied":
        offset = alignment["offset"]
        emit("align", 0.23,
             f"Source re-centred onto the target by ({offset[0]:.3f}, {offset[1]:.3f}, {offset[2]:.3f})m")

    # Pre-flight rather than post-mortem: a bake with nothing to hit costs the same
    # minutes of Cycles time as a good one and then hands back maps that look
    # plausible. Overlap is the honest gate, not matching extents — a source with
    # extra geometry (a plinth the low-poly dropped) has mismatched extents and
    # bakes perfectly well, while a source that only reaches half the target cannot.
    require_overlap = float(options.get("require_overlap", 0.5))
    if require_overlap > 0 and alignment.get("overlap", 1.0) < require_overlap:
        t_min, t_max = alignment.get("target_bounds", ([0, 0, 0], [0, 0, 0]))
        s_min, s_max = alignment.get("source_bounds", ([0, 0, 0], [0, 0, 0]))
        fmt = lambda v: "(" + ", ".join(f"{x:.3f}" for x in v) + ")"  # noqa: E731
        reason = {
            "skipped-scale": "their scales differ too much to re-centre automatically",
            "disabled": "automatic alignment is switched off",
        }.get(alignment["mode"], "re-centring them did not bring them together")
        fail(3,
             "The high-poly source does not overlap the mesh being baked to — "
             f"only {alignment['overlap'] * 100:.0f}% of the target's smallest axis is covered, and {reason}. "
             f"Target bounds {fmt(t_min)}..{fmt(t_max)}, source bounds {fmt(s_min)}..{fmt(s_max)}. "
             "A bake casts rays from the target onto the source, so a source that does not enclose "
             "the target can only return blank texels. Pick the source this mesh was actually derived "
             "from, or move it into the same space as the target.")

    # A bake target needs a material with an image node to write into.
    material = bpy.data.materials.new(name="BakeTarget")
    material.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(material)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(options.get("samples", 8))
    bake = scene.render.bake
    bake.use_selected_to_active = True

    # Cage extrusion is a distance, so a fixed default is only ever right for one
    # mesh size: 5cm is generous on a 1m prop and invisible on a 20m building.
    # 0 means "scale it to this mesh" — 2% of the bounding-box diagonal, which
    # reaches far enough to catch protruding detail without punching through to
    # surfaces on the far side.
    cage = float(options.get("cage_extrusion", 0.0))
    if cage <= 0.0:
        diagonal = max(low.dimensions.x, 1e-6) ** 2 + low.dimensions.y ** 2 + low.dimensions.z ** 2
        cage = 0.02 * (diagonal ** 0.5)
        emit("scene", 0.22, f"Auto cage extrusion: {cage:.4f}m")
    bake.cage_extrusion = cage
    bake.max_ray_distance = float(options.get("max_ray_distance", 0.0))
    # Margin dilates the baked islands outward so mip-mapping and bilinear
    # filtering cannot sample the empty gutter and bleed seams into the surface.
    bake.margin = int(options.get("margin", 8))
    bake.use_clear = True

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    written = {}

    flat_channels = []
    ordered = [name for name in BAKE_ORDER if name in maps]

    for index, map_name in enumerate(ordered):
        pass_type, colorspace, rewire_input = BAKE_PASSES[map_name]
        frac = 0.25 + 0.7 * (index / len(ordered))
        emit("bake", frac, f"Baking {map_name.replace('_', ' ')}…")

        # Either way, a channel whose source is a constant bakes to a flat map,
        # which is strictly worse than the scalar it came from — report it. Base
        # colour is exempt: a constant there is still the colour the mesh should
        # have, and the paint canvas has no other route to receive it.
        if rewire_input:
            rewired, driven = rewire_to_emit(high_objects, rewire_input)
            if not rewired:
                if map_name != "base_color":
                    flat_channels.append(map_name)
                else:
                    # Nothing to rewire, so EMIT would bake black. DIFFUSE is the
                    # only pass that reads an arbitrary shader: it loses metallic
                    # surfaces, but a dark map beats an empty one.
                    pass_type = "DIFFUSE"
            elif not driven and map_name != "base_color":
                flat_channels.append(map_name)
        elif map_name in PROBE_INPUTS:
            if not principled_input_is_linked(high_objects, PROBE_INPUTS[map_name]):
                flat_channels.append(map_name)

        # alpha=True is what turns a miss into something detectable. Blender masks
        # a texel whose ray found no high-poly surface out of the write entirely,
        # so it keeps the clear value — and the clear value is transparent
        # (0,0,0,0) only for an image with an alpha channel; without one it is
        # OPAQUE black, indistinguishable from a surface that is genuinely black.
        # That is what let a bake covering an eighth of this mesh pass for a good
        # one. With alpha, the channel is a per-texel hit mask: measure_coverage
        # counts it, pack_orm substitutes neutral values through it, and the client
        # composites the base colour through it instead of painting misses black.
        image = bpy.data.images.new(f"bake_{map_name}", width=resolution, height=resolution,
                                    alpha=True, float_buffer=False)
        image.alpha_mode = "STRAIGHT"
        image.colorspace_settings.name = colorspace

        node = material.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        material.node_tree.nodes.active = node

        # Selection defines the bake: every high-poly object selected, the
        # low-poly selected *and* active as the destination.
        bpy.ops.object.select_all(action="DESELECT")
        for obj in high_objects:
            obj.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low

        bake_kwargs = {"type": pass_type, "use_clear": True}
        if pass_type == "DIFFUSE":
            # Only the base-colour fallback above reaches this. Without the filter
            # the transfer would bake lighting into the albedo too.
            bake_kwargs["pass_filter"] = {"COLOR"}

        try:
            bpy.ops.object.bake(**bake_kwargs)
        except Exception as exc:  # noqa: BLE001
            fail(2, f"Baking {map_name} failed: {exc}")

        path = outdir / f"{map_name}.png"
        image.filepath_raw = str(path)
        image.file_format = "PNG"
        image.save()
        written[map_name] = path.name

        material.node_tree.nodes.remove(node)
        bpy.data.images.remove(image)

    # Before ORM packing, which reads the alpha this measures and then discards it.
    emit("measure", 0.94, "Measuring coverage…")
    coverage = measure_coverage(low, outdir, written, resolution)

    emit("pack", 0.96, "Packing ORM…")
    orm_name, orm_channels = pack_orm(written, outdir, resolution)
    if orm_name:
        written["orm"] = orm_name

    emit("done", 1.0, "Bake complete.")
    stats = {
        "maps": written,
        "resolution": resolution,
        "low_faces": len(low.data.polygons),
        "high_faces": int(sum(len(o.data.polygons) for o in high_objects)),
        "samples": scene.cycles.samples,
        "cage_extrusion": round(cage, 6),
        # How much of the UV layout the rays actually reached, and what the source
        # had to be moved by to get there. Reported unconditionally: a partial bake
        # is not an error (protruding detail legitimately misses) but it must never
        # again be indistinguishable from a complete one.
        **(coverage or {}),
        "alignment": alignment,
        # Every mesh object past the first in the low-poly file is not baked to.
        # Said out loud rather than dropped silently; the editor only ever uploads
        # one merged mesh, so this is for imported targets.
        "low_objects_ignored": len(low_objects) - 1,
        # Which of the ORM channels carry real baked data, so the client only binds
        # the material slots that were actually measured.
        "orm_channels": orm_channels if orm_name else [],
        # Channels whose source was a constant, not a texture — the map is flat.
        "flat_channels": flat_channels,
    }
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': True, 'stats': stats})}", flush=True)


if __name__ == "__main__":
    main()
