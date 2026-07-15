"""GLB -> FBX conversion worker (headless Blender).

Runs `bpy` in ISOLATION: invoked as a subprocess by app/services/convert_fbx.py
(`python fbx_worker.py --input in.glb --output out.fbx --options opts.json`).
Never import this module from the service — bpy is not thread-safe, holds ~1GB
RSS once imported, and a crash inside Blender must not take the API down.

Presets tailor the FBX for the target engine:
  - unity   : file declared in meters with clean scale-1 transforms
              (FBX_SCALE_UNITS -> Unity "File Scale" = 1).
  - unreal  : the scene is baked to centimeters (x100 on mesh/armature data and
              every location F-curve) and written with FBX_SCALE_NONE, so UE
              imports at the right size with unit bone scales — no reliance on
              the "Convert Scene Unit" import option.
  - generic : same neutral meters export as unity (most interoperable).

Every glTF animation arrives as an NLA track (that is how Blender's importer
stashes clips); the exporter turns each NLA strip into a separate FBX take, so
engines see one clip per animation.

Protocol: progress/result JSON lines on stdout prefixed with GENSTUDIO_EVT
(bpy prints its own "Info:" noise, the parent ignores non-matching lines).
Exit codes: 0 ok, 2 conversion error, 3 validation failed, 4 bpy missing.
"""
from __future__ import annotations

import argparse
import json
import sys

SENTINEL = "GENSTUDIO_EVT "  # keep in sync with app/services/convert_fbx.py

# Shared exporter settings. Axis conversion stays on the export matrix
# (use_space_transform) instead of being baked into vertices:
# bake_space_transform=True is unsafe with skinned meshes — it transforms mesh
# data but not armature/bone animation consistently. The compensating root
# rotation it avoids is absorbed by Unity/Unreal importers anyway.
COMMON_FBX = dict(
    check_existing=False,
    use_selection=False,
    object_types={"ARMATURE", "MESH"},
    use_mesh_modifiers=True,
    mesh_smooth_type="FACE",
    use_tspace=False,  # tangent export fails on generated/disconnected UVs
    add_leaf_bones=False,  # leaf bones pollute Unity/UE skeletons
    primary_bone_axis="Y",
    secondary_bone_axis="X",
    use_armature_deform_only=True,
    armature_nodetype="NULL",
    bake_anim=True,
    bake_anim_use_all_bones=True,
    bake_anim_use_nla_strips=True,  # one take per clip (NLA-stashed by the importer)
    bake_anim_use_all_actions=False,  # True would cross-product junk takes
    bake_anim_force_startend_keying=True,
    bake_anim_step=1.0,
    path_mode="COPY",
    embed_textures=True,
    axis_forward="-Z",
    axis_up="Y",
    use_space_transform=True,
    bake_space_transform=False,
)

METER_SCALE_FBX = dict(  # unity + generic
    apply_unit_scale=True,
    apply_scale_options="FBX_SCALE_UNITS",
    global_scale=1.0,
)

CM_BAKED_FBX = dict(  # unreal, after the x100 bake
    apply_unit_scale=False,
    apply_scale_options="FBX_SCALE_NONE",
    global_scale=1.0,
)


def emit(obj: dict) -> None:
    sys.stdout.write(SENTINEL + json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def progress(stage: str, frac: float, message: str = "") -> None:
    emit({"type": "progress", "stage": stage, "frac": round(float(frac), 4), "message": message})


def fail(error: str, code: int) -> None:
    emit({"type": "result", "ok": False, "error": error})
    sys.exit(code)


def normalize_nla(objects) -> list[str]:
    """Make the exporter's take collection deterministic.

    The FBX exporter only bakes UNMUTED NLA strips, and depending on the
    Blender version the glTF importer may leave the last clip as a dangling
    active action instead of a stashed track. Unmute everything, stash any
    dangling active action as its own track, and clear active actions so no
    clip layers on top of the strip bakes. Returns the clip (strip) names.
    """
    clip_names: list[str] = []
    for obj in objects:
        ad = obj.animation_data
        if not ad:
            continue
        for track in ad.nla_tracks:
            track.mute = False
            clip_names.extend(strip.name for strip in track.strips)
        action = ad.action
        if action is not None:
            in_nla = any(
                strip.action == action
                for track in ad.nla_tracks
                for strip in track.strips
            )
            if not in_nla:
                track = ad.nla_tracks.new()
                track.name = action.name
                track.strips.new(action.name, int(action.frame_range[0]), action)
                clip_names.append(action.name)
            ad.action = None
    # A clip animating several objects appears once per object — dedupe, keep order.
    return list(dict.fromkeys(clip_names))


def collect_stats(objects, clip_names) -> dict:
    import bpy

    armatures = [o for o in objects if o.type == "ARMATURE"]
    meshes = [o for o in objects if o.type == "MESH"]
    seen_mesh_data = {m.data for m in meshes}
    return {
        "armature_count": len(armatures),
        "bones": sum(len(a.data.bones) for a in armatures),
        "meshes": len(meshes),
        "vertices": sum(len(d.vertices) for d in seen_mesh_data),
        "materials": len([m for m in bpy.data.materials if m.users]),
        "has_uv": any(d.uv_layers for d in seen_mesh_data),
        "clips": clip_names,
    }


def bake_unreal_scale(objects, factor: float = 100.0) -> None:
    """Bake the scene from meters to centimeters at the DATA level.

    Data-level transforms (Mesh.transform / Armature.transform) avoid the
    operator selection/context dance that transform_apply needs headless, and
    sidestep its child parent-inverse compensation (which would leave mesh data
    small behind a scale-100 node — exactly the transform FBX must not carry).
    Skinning stays consistent because in Blender the armature rest pose IS the
    bind pose: scaling mesh and rest bones by the same factor preserves it.
    """
    import bpy
    from mathutils import Matrix

    scale = Matrix.Scale(factor, 4)
    seen_data = set()
    for obj in objects:
        if obj.type in {"MESH", "ARMATURE"} and obj.data not in seen_data:
            seen_data.add(obj.data)
            obj.data.transform(scale)
        obj.location = [component * factor for component in obj.location]
        parent_inverse = obj.matrix_parent_inverse.copy()
        parent_inverse.translation *= factor
        obj.matrix_parent_inverse = parent_inverse

    # Object/data transforms do not touch animation: location F-curves (object
    # and pose-bone hip/root-motion translation) are in now-x100 local units.
    for action in bpy.data.actions:
        for fcurve in _action_fcurves(action):
            if fcurve.data_path == "location" or fcurve.data_path.endswith(".location"):
                for key in fcurve.keyframe_points:
                    key.co.y *= factor
                    key.handle_left.y *= factor
                    key.handle_right.y *= factor


def _action_fcurves(action):
    """All F-curves of an action across bpy versions: Blender 5.x replaced the
    flat Action.fcurves with slotted actions (layers > strips > channelbags)."""
    fcurves = getattr(action, "fcurves", None)
    if fcurves is not None:
        return list(fcurves)
    return [
        fcurve
        for layer in action.layers
        for strip in layer.strips
        if strip.type == "KEYFRAME"
        for channelbag in strip.channelbags
        for fcurve in channelbag.fcurves
    ]


def validate_reimport(path: str, in_stats: dict, clip_names: list[str]) -> dict:
    """Re-import the exported FBX into a fresh scene and assert nothing was lost."""
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, ignore_leaf_bones=True)
    objects = list(bpy.context.scene.objects)
    armatures = [o for o in objects if o.type == "ARMATURE"]
    meshes = [o for o in objects if o.type == "MESH"]
    actions = list(bpy.data.actions)  # FBX importer: one action per take

    if in_stats["armature_count"] and not armatures:
        raise ValidationError("exported FBX contains no armature")
    if clip_names and len(actions) < len(clip_names):
        raise ValidationError(
            f"expected {len(clip_names)} animation take(s), re-import found {len(actions)}"
        )
    if in_stats["meshes"] and not meshes:
        raise ValidationError("exported FBX contains no mesh")
    return {
        "armatures": len(armatures),
        "meshes": len(meshes),
        "actions": sorted(action.name for action in actions),
    }


class ValidationError(RuntimeError):
    pass


def convert(input_path: str, output_path: str, opts: dict) -> dict:
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # Set fps BEFORE import: the glTF importer converts clip times to frames
    # with the scene fps, and the exporter bakes one key per frame.
    scene.render.fps = int(opts.get("bake_fps", 30))
    scene.render.fps_base = 1.0

    progress("import", 0.1, "Importing GLB…")
    bpy.ops.import_scene.gltf(filepath=input_path)

    objects = list(scene.objects)
    clip_names = normalize_nla(objects)
    stats = collect_stats(objects, clip_names)
    progress(
        "import", 0.3,
        f"Imported {stats['armature_count']} armature(s) ({stats['bones']} bones), "
        f"{stats['meshes']} mesh(es), {len(clip_names)} clip(s)",
    )

    preset = opts.get("preset", "generic")
    kwargs = dict(COMMON_FBX)
    kwargs["bake_anim_simplify_factor"] = float(opts.get("anim_simplify", 1.0))
    if preset == "unreal" and opts.get("unreal_scale_mode", "bake") == "bake":
        progress("transform", 0.45, "Baking centimeter scale for Unreal…")
        bake_unreal_scale(objects)
        kwargs.update(CM_BAKED_FBX)
    else:
        kwargs.update(METER_SCALE_FBX)

    progress("export", 0.55, f"Baking {len(clip_names)} animation take(s) to FBX…")
    bpy.ops.export_scene.fbx(filepath=output_path, **kwargs)

    progress("validate", 0.8, "Re-importing FBX to validate…")
    stats["validation"] = validate_reimport(output_path, stats, clip_names)
    stats["preset"] = preset
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Source .glb path")
    parser.add_argument("--output", required=True, help="Destination .fbx path")
    parser.add_argument("--options", required=True, help="Path to an options JSON file")
    args = parser.parse_args()

    with open(args.options, encoding="utf-8") as handle:
        opts = json.load(handle)

    try:
        import bpy  # noqa: F401 — probe only; used inside convert()
    except ImportError as exc:
        fail(f"bpy is not installed in this environment: {exc}", 4)

    try:
        stats = convert(args.input, args.output, opts)
    except ValidationError as exc:
        fail(f"Validation failed: {exc}", 3)
    except Exception as exc:  # noqa: BLE001 — everything must surface to the parent
        import traceback

        traceback.print_exc()
        fail(f"{type(exc).__name__}: {exc}", 2)
    else:
        emit({"type": "result", "ok": True, "stats": stats})


if __name__ == "__main__":
    main()
