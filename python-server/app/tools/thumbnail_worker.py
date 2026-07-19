"""GLB -> PNG thumbnail worker (headless Blender).

Runs `bpy` in ISOLATION: invoked as a subprocess by app/services/mesh_thumbnail.py
(`python thumbnail_worker.py --input in.glb --output out.png`). Never import this
module from the service — bpy is not thread-safe, holds ~1GB RSS once imported,
and a crash inside Blender must not take the API down.

Why a server-side render at all: mesh thumbnails are normally rendered in the
browser (src/utils/meshThumbnail.js, WebGL). Meshes created without a browser
(ComfyUI workflows / external-API generation driven over MCP) never get one, so
the app shows an empty image. This renders one headlessly instead.

Engine choice: Cycles on the CPU. Cycles needs no GL/display context, so it
renders reliably headless on every platform (EEVEE/Workbench depend on an
OpenGL context that is often absent on servers). Low samples keep a 512px frame
to ~1-3s. The framing/lighting mirrors the client renderer so thumbnails look
consistent: dark background, a 3/4 camera, key + fill + rim lights.

Protocol: progress/result JSON lines on stdout prefixed with GENSTUDIO_EVT (bpy
prints its own "Info:" noise, the parent ignores non-matching lines).
Exit codes: 0 ok, 2 render error, 4 bpy missing.
"""
from __future__ import annotations

import argparse
import json
import math
import sys

SENTINEL = "GENSTUDIO_EVT "  # keep in sync with app/services/mesh_thumbnail.py

RESOLUTION = 512
SAMPLES = 24
CAMERA_FOV_DEG = 35.0
# Camera direction (Blender is Z-up; the glTF importer puts model front toward
# -Y). A 3/4 view from front-right-above, matching the client's angle.
CAMERA_DIR = (0.9, -1.0, 0.7)
# Neutral world colour used only for soft ambient fill (never shown — the film
# is transparent). Blender colour inputs are linear.
AMBIENT_COLOR = (0.09, 0.095, 0.11)


def emit(obj: dict) -> None:
    sys.stdout.write(SENTINEL + json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def progress(stage: str, frac: float, message: str = "") -> None:
    emit({"type": "progress", "stage": stage, "frac": round(float(frac), 4), "message": message})


def fail(error: str, code: int) -> None:
    emit({"type": "result", "ok": False, "error": error})
    sys.exit(code)


def _scene_bounds(objects):
    """World-space (min, max) corners over every mesh object's bounding box."""
    from mathutils import Vector

    lo = Vector((math.inf, math.inf, math.inf))
    hi = Vector((-math.inf, -math.inf, -math.inf))
    found = False
    for obj in objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, world.x), min(lo.y, world.y), min(lo.z, world.z)))
            hi = Vector((max(hi.x, world.x), max(hi.y, world.y), max(hi.z, world.z)))
    if not found:
        return None
    return lo, hi


def _add_sun(name, direction, energy):
    import bpy
    from mathutils import Vector

    data = bpy.data.lights.new(name=name, type="SUN")
    data.energy = energy
    obj = bpy.data.objects.new(name=name, object_data=data)
    bpy.context.scene.collection.objects.link(obj)
    # A sun's rays travel along its local -Z; aim that at `direction`.
    obj.rotation_euler = Vector(direction).normalized().to_track_quat("-Z", "Y").to_euler()
    return obj


def render(input_path: str, output_path: str) -> None:
    import bpy
    from mathutils import Vector

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    progress("import", 0.2, "Importing GLB…")
    # TEMPERANCE: the default bone heuristic spawns an Icosphere widget mesh for
    # rigged meshes that would pollute the framing; TEMPERANCE only orients bones.
    bpy.ops.import_scene.gltf(filepath=input_path, bone_heuristic="TEMPERANCE")

    objects = list(scene.objects)
    bounds = _scene_bounds(objects)
    if bounds is None:
        raise RuntimeError("The GLB contains no mesh geometry to render.")
    lo, hi = bounds
    center = (lo + hi) * 0.5
    size = hi - lo
    max_dim = max(size.x, size.y, size.z, 1e-4)

    progress("camera", 0.4, "Framing camera…")
    cam_data = bpy.data.cameras.new("thumb_cam")
    cam_data.angle = math.radians(CAMERA_FOV_DEG)
    cam_obj = bpy.data.objects.new("thumb_cam", cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    direction = Vector(CAMERA_DIR).normalized()
    distance = max_dim * 2.2
    cam_obj.location = center + direction * distance
    # Camera looks down its local -Z with +Y up.
    cam_obj.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()

    # Lights: a soft ambient world plus key/fill/rim suns (mirrors the client's
    # ambient + key + rim setup).
    world = bpy.data.worlds.new("thumb_world")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (*AMBIENT_COLOR, 1.0)
        bg.inputs[1].default_value = 1.1  # ambient strength
    _add_sun("key", (-0.5, 0.8, -1.0), 4.0)
    _add_sun("fill", (0.9, 0.4, -0.6), 1.6)
    _add_sun("rim", (0.4, -0.9, 0.5), 2.2)

    progress("render", 0.6, "Rendering thumbnail…")
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.resolution_x = RESOLUTION
    scene.render.resolution_y = RESOLUTION
    scene.render.resolution_percentage = 100
    # Transparent background (RGBA): the model composites cleanly over the app's
    # dark cards, and it avoids the version-specific Blender compositor API. The
    # world stays bright for ambient fill but is not shown.
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = output_path
    # Match the client's plain-sRGB output: Blender's default AgX/Filmic view
    # transform lifts darks and shifts colours. "Standard" keeps colours
    # as-authored so thumbnails look like the in-app WebGL renders.
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError:  # build may name it differently — non-fatal
        pass
    bpy.ops.render.render(write_still=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Source .glb path")
    parser.add_argument("--output", required=True, help="Destination .png path")
    args = parser.parse_args()

    try:
        import bpy  # noqa: F401 — probe only; used inside render()
    except ImportError as exc:
        fail(f"bpy is not installed in this environment: {exc}", 4)

    try:
        render(args.input, args.output)
    except Exception as exc:  # noqa: BLE001 — everything must surface to the parent
        import traceback

        traceback.print_exc()
        fail(f"{type(exc).__name__}: {exc}", 2)
    else:
        emit({"type": "result", "ok": True})


if __name__ == "__main__":
    main()
