"""Flatten a PBR mesh into ONE lit albedo texture (headless Blender).

Runs `bpy` in ISOLATION, exactly like bake_worker.py and for the same reasons:
invoked as a subprocess by app/services/bake.py
(`python flatten_worker.py --mesh mesh.glb --outdir dir --options o.json`).

What it is for: a mobile target that cannot afford a PBR shader, but loses most
of the asset's look when it keeps only the original base colour. Normal maps,
AO, roughness and metalness all stop existing on an unlit (or Lambert) shader,
so their contribution is baked INTO the colour instead, under a neutral studio
light that never produces a view-dependent highlight.

The mesh arrives with TWO UV sets. UV0 is the source's own, which every source
texture keeps sampling through; the second (index `atlas_uv`) is a single
non-overlapping atlas the client packed over every mesh and material. The bake
writes through that second set, so every object of the scene lands in one image.
This is NOT a selected-to-active bake: the target and the source are the same
geometry, so there is nothing to cast rays between, and baking an object onto
itself cannot miss, cannot hit a neighbouring layer, and needs no cage.

Lighting is where the design lives — see LIGHTING below.

Protocol: progress/result JSON lines on stdout prefixed with GENSTUDIO_EVT.
Exit codes: 0 ok, 2 bake error, 3 validation failed, 4 bpy missing.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

# The directory of this script is sys.path[0] when it runs as a subprocess, so
# the sibling worker's helpers import directly. It has no import-time side
# effects: everything bpy-related happens inside functions.
from bake_worker import SENTINEL, _erode, emit, fail, hidden_from_render, rasterize_uv_layout

# ── Lighting ────────────────────────────────────────────────────────────────
# Two things a baked look must never contain are a specular HIGHLIGHT and a
# hard SHADOW: the first belongs to one view direction and would be stuck on the
# surface for every other one, the second to one light direction and would fight
# whatever the game lights the mesh with. What is left is a studio: a soft dome
# that is brighter overhead than underfoot, optionally with one SHADOWLESS key.
#
# Measured on Cycles, not assumed (a white Lambert plane, 64 spp):
#   * a uniform world of radiance 1 bakes white as exactly 1.0, in every
#     orientation — so the dome's colour IS the fraction of albedo that survives;
#   * a sun of strength 1 adds ~1/pi (0.306 measured) to a surface facing it;
#   * a METAL (metallic 1, red) under that uniform world bakes as its own base
#     colour through the glossy lobe. That is the whole reason GLOSSY stays in the
#     pass filter: drop it, and every metal flattens to black — a metal has no
#     diffuse lobe to catch light with.
#   * a key light with `visible_glossy = False` adds NOTHING to that metal, so the
#     key can shape the diffuse surfaces without ever painting a highlight.
#
# The dome is a gradient over world Z (glTF's up, after the importer's Y-up to
# Z-up turn) from `ground` straight down to `sky` straight up. Averaged with the
# cosine weighting a surface actually integrates, a face pointing up sees
# ground + 0.83 (sky - ground), a vertical face the midpoint, and a face pointing
# down ground + 0.17 (sky - ground).
#
# `key` is the sun's contribution, in albedo units, on a surface facing it. It
# arrives from above, in front and a little to the left (glTF's front, +Z, is
# Blender's -Y), 35 degrees off vertical: a top face gets 0.82 of it, the front
# 0.50, the left 0.29 and the back and underside none.
#
# The key casts NO shadow. A 30-degree "soft" sun was tried first and still laid
# a crisp wedge across a building's main roof from the gable in front of it:
# softness is an angle, so at building scale the penumbra is a few pixels. What
# the key is for is shape — which way a surface faces — and N.L gives that on
# its own; the contact darkening a flattened asset does want comes from the dome,
# whose occlusion is soft at any scale because it arrives from every direction.
#
# Resulting fraction of albedo (before occlusion), top / front / back / bottom:
#   studio  1.04 / 0.79 / 0.60 / 0.47  — for UNLIT shaders: the bake is the light
#   soft    0.96 / 0.88 / 0.88 / 0.79  — for SIMPLE LIT shaders: occlusion and a
#           gentle top-down fill only, because the game's own light supplies the
#           direction and a baked one would double it
LIGHTING = {
    "studio": {"sky": 0.8, "ground": 0.4, "key": 0.38},
    "soft": {"sky": 1.0, "ground": 0.75, "key": 0.0},
}
KEY_ROTATION_DEG = (35.0, 0.0, -30.0)  # Euler XYZ; the sun shines down its local -Z
SUN_UNIT = 1.0 / math.pi  # albedo fraction added per unit of sun strength

# Why not COMBINED: it darkens every island's edge texels. Measured on an
# AI-textured Taj Mahal: COMBINED's outermost texel ring came out 22% darker
# than the ring three texels in, while the source texture's edge ring matched
# its interior to 0.3% — a dark line along every UV seam once the texture is
# filtered. The separate DIFFUSE COLOR and DIFFUSE DIRECT+INDIRECT passes are
# each clean there (0.98 / 0.97), and their product reproduces COMBINED exactly
# away from the edges (0.4249 against 0.4248 over island interiors), which is
# the compositing identity Cycles itself documents:
#     combined = diff_col * diff_light + gloss_col * gloss_light
#                + trans_col * trans_light + emit
# Dividing COMBINED by a coverage bake recovered only half of the loss, so the
# darkening is not just samples missing the triangle; the decomposition is
# what fixes it. It costs ~25% more time, because the colour passes need only
# a few samples. GLOSSY stays: without it every metal flattens to black.
LIT_PASSES = [
    # (bake type, role, label)
    ("DIFFUSE", "colour", "diffuse colour"),
    ("DIFFUSE", "light", "diffuse light"),
    ("GLOSSY", "colour", "reflection colour"),
    ("GLOSSY", "light", "reflection light"),
    ("TRANSMISSION", "colour", "transmission colour"),
    ("TRANSMISSION", "light", "transmission light"),
    ("EMIT", "emit", "emission"),
]
COLOUR_SAMPLES = 8
TRANSMISSION_INPUTS = ("Transmission Weight", "Transmission")
EMISSION_INPUTS = ("Emission Strength",)


# Soft clip: linear up to the knee, then an exponential shoulder that reaches 1
# asymptotically. A white albedo under the studio's top light lands a little
# above 1, and a hard clip there would flatten every bright top surface into one
# featureless value — exactly the detail this bake exists to keep.
TONE_KNEE = 0.8


def setup_world(scene, preset: dict) -> None:
    import bpy

    world = bpy.data.worlds.new("FlattenStudio")
    scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background = nodes.get("Background") or nodes.new("ShaderNodeBackground")
    output = nodes.get("World Output") or nodes.new("ShaderNodeOutputWorld")

    # Generated coordinates on a world shader are the ray DIRECTION, so Z is how
    # far up the dome a sample looks: -1 underfoot, +1 overhead.
    coords = nodes.new("ShaderNodeTexCoord")
    split = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = -1.0
    ramp.inputs["From Max"].default_value = 1.0
    ramp.inputs["To Min"].default_value = float(preset["ground"])
    ramp.inputs["To Max"].default_value = float(preset["sky"])
    links.new(coords.outputs["Generated"], split.inputs["Vector"])
    links.new(split.outputs["Z"], ramp.inputs["Value"])
    # A float into a colour socket broadcasts across RGB: a neutral grey dome.
    links.new(ramp.outputs["Result"], background.inputs["Color"])
    background.inputs["Strength"].default_value = 1.0
    links.new(background.outputs["Background"], output.inputs["Surface"])


def setup_key(scene, preset: dict) -> None:
    import bpy

    if preset["key"] <= 0:
        return
    data = bpy.data.lights.new("FlattenKey", "SUN")
    data.energy = float(preset["key"]) / SUN_UNIT
    # Shading only, never a cast shadow — see the LIGHTING notes. Measured: a
    # plane under a blocker bakes 0.02 in the blocker's shadow with shadows on,
    # 0.80 (the unshadowed value) with them off.
    data.use_shadow = False
    # Belt and braces with the object flag below; not every version has both.
    if hasattr(data, "specular_factor"):
        data.specular_factor = 0.0
    key = bpy.data.objects.new("FlattenKey", data)
    scene.collection.objects.link(key)
    key.rotation_euler = tuple(math.radians(v) for v in KEY_ROTATION_DEG)
    # Diffuse only. This is what keeps a key light from ever baking a highlight.
    key.visible_glossy = False


def tone_map(linear, exposure: float):
    """Scene-linear RGB -> display-ready 0..1 values (still linear)."""
    import numpy as np

    x = np.maximum(linear * (2.0 ** exposure), 0.0)
    head = 1.0 - TONE_KNEE
    shoulder = TONE_KNEE + head * (1.0 - np.exp(-(x - TONE_KNEE) / head))
    return np.where(x <= TONE_KNEE, x, shoulder)


def linear_to_srgb(x):
    import numpy as np

    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def materials_use(objects, input_names) -> bool:
    """Does any Principled BSDF drive one of these inputs above zero (or by a graph)?

    Used to skip the transmission and emission bakes on the many assets that have
    neither — each is a full bake pass for a channel that would come back black.
    """
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            for node in material.node_tree.nodes:
                if node.type != "BSDF_PRINCIPLED":
                    continue
                for name in input_names:
                    socket = node.inputs.get(name)
                    if socket is None:
                        continue
                    if socket.is_linked:
                        return True
                    try:
                        if float(socket.default_value) > 0.0:
                            return True
                    except TypeError:
                        pass
    return False


def dilate_from_hits(rgb, alpha, layout):
    """Give every texel the bake did not write the colour of the nearest one it did.

    Returns (straight_rgb, alpha, baked_mask), all full-image.

    **The seam this fixes.** Blender bakes a texel only when its CENTRE falls
    inside a triangle, while the rasterised layout (and the sampler at render
    time) also touches the texels an island edge merely crosses. Measured on an
    AI-textured Taj Mahal at 1024px: 36% of the outermost texel ring of every
    island was never written, and that ring came out 35% darker than the ring
    beside it. Blender's own margin (8px) was meant to cover those texels and did
    not cleanly, and the gutter fill skipped them because they count as
    "inside". Bilinear filtering reads that ring at every island border. (The
    other half of that seam — the texels the bake DID write coming out dark — is
    COMBINED's, and is why the lit colour is assembled from LIT_PASSES.)

    So the bake runs with no margin at all and this does the job from the one
    signal that cannot lie — whether the bake wrote the texel:

      * The diffuse COLOUR pass writes alpha > 0 on every texel it bakes and
        leaves the clear value (0) everywhere else. The one ambiguity is a cut-out whose material
        alpha is genuinely 0; those only matter deep inside an island, where the
        layout already proves the texel was baked, hence the eroded layout below.
      * COLOUR comes from texels that were baked AND are visible (alpha above one
        8-bit step), un-premultiplied — the colour passes premultiply by the
        material alpha (measured: blue at alpha 0.3 came back as 0.29 blue, alpha
        0.30) while the light passes do not, and glTF base colour is straight. Everything else, cut-out holes included, takes the
        nearest visible colour, which is also what stops a mask's edge from
        filtering to black.
      * ALPHA comes from baked texels only; unbaked ones take the nearest baked
        alpha, so an opaque island stays opaque right to its edge and a cut-out
        stays cut out.

    Filling the whole image rather than a margin also covers every mip level:
    there is no black left anywhere for a coarse mip to average in.
    """
    import numpy as np
    from scipy.ndimage import distance_transform_edt

    interior = _erode(layout.copy(), 1)
    baked = (alpha > 0.0) | interior
    visible = baked & (alpha > (1.0 / 255.0))
    if not visible.any():
        fail(2, "The lit bake wrote no visible texels — the mesh may be fully transparent.")

    straight = np.where(visible[..., None], rgb / np.maximum(alpha[..., None], 1e-6), 0.0)
    _, (cy, cx) = distance_transform_edt(~visible, return_indices=True)
    straight = straight[cy, cx]

    _, (ay, ax) = distance_transform_edt(~baked, return_indices=True)
    alpha = np.where(baked, alpha, alpha[ay, ax])
    return straight, alpha, baked


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--options", required=True)
    args = parser.parse_args()

    options = json.loads(Path(args.options).read_text(encoding="utf-8"))
    resolution = int(options.get("resolution", 2048))
    atlas_uv = int(options.get("atlas_uv", 1))
    lighting = str(options.get("lighting", "studio"))
    preset = LIGHTING.get(lighting)
    if preset is None:
        fail(3, f"Unknown lighting preset '{lighting}'.")
    exposure = float(options.get("exposure", 0.0))

    try:
        import bpy
        import numpy as np
        from PIL import Image
    except Exception as exc:  # noqa: BLE001
        fail(4, f"Blender (bpy) is not available on the mesh-tools service: {exc}")

    emit("scene", 0.05, "Preparing the studio…")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    emit("import", 0.1, "Importing the mesh…")
    before = set(bpy.data.objects)
    # TEMPERANCE for the reason bake_worker.import_glb gives: the default bone
    # heuristic creates a hidden Icosphere widget mesh that fails the bake.
    bpy.ops.import_scene.gltf(filepath=args.mesh, bone_heuristic="TEMPERANCE")
    imported = [o for o in bpy.data.objects if o not in before]
    objects = [o for o in imported if o.type == "MESH" and not hidden_from_render(o)]
    if not objects:
        fail(3, "The file contains no mesh to flatten.")

    # A rigged import comes in posed on its first animation frame. Lighting a
    # raised arm and shipping it at rest would bake the arm's shadow onto a
    # torso it no longer covers, so every armature is put back to its rest pose —
    # the pose the UVs and the exported mesh are both in.
    for obj in imported:
        if obj.type == "ARMATURE":
            obj.data.pose_position = "REST"

    atlas_name = "FlattenAtlas"
    for obj in objects:
        layers = obj.data.uv_layers
        if len(layers) <= atlas_uv:
            fail(3, f"Mesh '{obj.name}' has no atlas UV set (TEXCOORD_{atlas_uv}). "
                    "Every mesh must carry the packed atlas before it can be flattened.")
        # One name across every object, because the bake takes a single UV-set
        # name for the whole selection.
        layers[atlas_uv].name = atlas_name
        # The source textures sample the render-active set when no UV Map node
        # says otherwise (measured: an unconnected Image Texture follows it, not
        # the UI-active one). It must stay the source's own, or every texture
        # would be looked up through the atlas and come back scrambled.
        layers[0].active_render = True
        # Invisible to GLOSSY rays only: a metal then reflects the neutral dome
        # and nothing else. Left visible, a metal part bakes a mirror image of
        # whatever sits next to it (measured: a dark blob on a metal sphere where
        # it faced a cube), and that is precisely a view-dependent reflection
        # frozen into the texture. Diffuse, shadow and occlusion rays still see it.
        obj.visible_glossy = False
    bpy.context.view_layer.update()

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(options.get("samples", 64))
    # Enough bounces for light to reach into a cavity, not enough to cost much:
    # a studio bake is dominated by the first diffuse bounce off the dome.
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 4
    # Leaf cards and other cut-outs stack; each layer is one transparent bounce.
    scene.cycles.transparent_max_bounces = 16
    # Fireflies in a baked texture never average out the way they do across
    # frames of a render — clamp the indirect ones hard.
    scene.cycles.sample_clamp_indirect = 4.0

    setup_world(scene, preset)
    setup_key(scene, preset)

    # Float, so the tone curve below sees the real scene-linear values instead of
    # whatever an 8-bit sRGB write clipped them to.
    image = bpy.data.images.new("flatten_albedo", width=resolution, height=resolution,
                                alpha=True, float_buffer=True)
    image.alpha_mode = "STRAIGHT"

    # Every material of every object needs the SAME image as its active node:
    # that is how several objects bake into one atlas.
    fallback = None
    seen = set()
    for obj in objects:
        if not obj.material_slots or all(slot.material is None for slot in obj.material_slots):
            if fallback is None:
                # glTF's default material is a white-ish dielectric; bake it as one
                # rather than refusing a mesh that simply never named a material.
                fallback = bpy.data.materials.new("FlattenDefault")
                fallback.use_nodes = True
            obj.data.materials.clear()
            obj.data.materials.append(fallback)
        for slot in obj.material_slots:
            material = slot.material
            if material is None or material.name in seen:
                continue
            seen.add(material.name)
            material.use_nodes = True
            node = material.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = image
            material.node_tree.nodes.active = node

    bake = scene.render.bake
    bake.use_selected_to_active = False
    # NO Blender margin: dilation is done below, from texels known to be baked.
    # See dilate_from_hits for why Blender's own cannot be trusted here.
    bake.margin = 0
    bake.use_clear = True

    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]

    samples = scene.cycles.samples
    # The lit colour is assembled from separate colour and light passes rather
    # than baked as COMBINED — see LIT_PASSES for why. Transmission and emission
    # are only baked when some material actually uses them.
    passes = [entry for entry in LIT_PASSES
              if entry[0] in ("DIFFUSE", "GLOSSY")
              or (entry[0] == "TRANSMISSION" and materials_use(objects, TRANSMISSION_INPUTS))
              or (entry[0] == "EMIT" and materials_use(objects, EMISSION_INPUTS))]

    def run_pass(index, kind, pass_filter, pass_samples, label):
        scene.cycles.samples = pass_samples
        emit("bake", 0.2 + 0.68 * index / len(passes),
             f"Baking {label} ({pass_samples} samples, {resolution}px) — pass {index + 1} of {len(passes)}…")
        kwargs = {"type": kind, "uv_layer": atlas_name, "use_clear": True, "margin": 0}
        if pass_filter:
            kwargs["pass_filter"] = pass_filter
        try:
            bpy.ops.object.bake(**kwargs)
        except Exception as exc:  # noqa: BLE001
            fail(2, f"The lit bake failed ({label}): {exc}")
        pixels = np.empty(resolution * resolution * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        # Blender stores rows bottom-up; a PNG is top-down.
        return pixels.reshape(resolution, resolution, 4)[::-1].astype(np.float64)

    rgb = np.zeros((resolution, resolution, 3), dtype=np.float64)
    alpha = None
    colour = None
    for index, (kind, role, label) in enumerate(passes):
        if role == "colour":
            # Colour passes only need enough samples to antialias the texture.
            colour = run_pass(index, kind, {"COLOR"}, min(samples, COLOUR_SAMPLES), label)
            if kind == "DIFFUSE":
                # The hit mask and the material alpha, in one channel: 0 on every
                # texel the bake did not write, the material's alpha elsewhere.
                alpha = np.clip(colour[..., 3], 0.0, 1.0)
        elif role == "light":
            light = run_pass(index, kind, {"DIRECT", "INDIRECT"}, samples, label)
            # Colour passes come back premultiplied by the material alpha, light
            # passes do not, so the product is premultiplied — undone below.
            rgb += colour[..., :3] * light[..., :3]
        else:
            rgb += run_pass(index, kind, None, min(samples, COLOUR_SAMPLES), label)[..., :3]
    scene.cycles.samples = samples

    layout = rasterize_uv_layout(objects, resolution, resolution, layer_name=atlas_name)
    if layout is None:
        fail(2, "The atlas UV set could not be read back after baking.")

    emit("dilate", 0.93, "Filling island edges and gutters…")
    rgb, alpha, baked = dilate_from_hits(rgb, alpha, layout)

    exposed = np.maximum(rgb * (2.0 ** exposure), 0.0)
    clipped = float((exposed[baked].max(axis=-1) > 1.0).mean()) if baked.any() else 0.0
    display = linear_to_srgb(tone_map(rgb, exposure))

    # Alpha only survives when the source actually had some. A fully opaque
    # material bakes alpha 1 on every texel it writes; anything below that is a
    # cut-out or a blend the flattened material has to reproduce. Judged only on
    # texels the bake demonstrably wrote (alpha > 0): the eroded layout also
    # vouches for a few corner texels it never reached, and counting those read
    # an opaque two-object test scene as translucent. A real cut-out always
    # leaves partial values along its edges, so it is still caught.
    written_alpha = alpha[baked & (alpha > 0.0)]
    translucent = float((written_alpha < 0.996).mean()) if written_alpha.size else 0.0
    has_alpha = translucent > 0.0005

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    rgb8 = np.round(display * 255.0).astype(np.uint8)
    if has_alpha:
        alpha8 = np.round(alpha * 255.0).astype(np.uint8)
        Image.fromarray(np.dstack([rgb8, alpha8]), mode="RGBA").save(outdir / "albedo.png")
    else:
        Image.fromarray(rgb8, mode="RGB").save(outdir / "albedo.png")
    written = {"albedo": "albedo.png"}
    bpy.data.images.remove(image)
    gutter_filled = {"albedo": round(float((~baked).mean()), 4)}

    emit("done", 1.0, "Flatten complete.")
    stats = {
        "maps": written,
        "resolution": resolution,
        "objects": len(objects),
        "faces": int(sum(len(o.data.polygons) for o in objects)),
        "samples": scene.cycles.samples,
        "lighting": lighting,
        "exposure": exposure,
        "has_alpha": has_alpha,
        # Share of the atlas's texels that were over 1.0 before the soft clip. A
        # large figure means the exposure is too high for this material.
        "clipped_frac": round(clipped, 4),
        "layout_frac": round(float(layout.mean()), 4),
        "gutter_filled": gutter_filled,
    }
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': True, 'stats': stats})}", flush=True)


if __name__ == "__main__":
    main()
