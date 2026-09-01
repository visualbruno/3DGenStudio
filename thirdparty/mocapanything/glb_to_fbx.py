"""Blender-side half of the per-rig bake: a rigged GLB -> the two FBX files
MoCapAnything's preprocessing expects.

Run as:  blender --background --factory-startup --python glb_to_fbx.py -- <glb> <outdir> <rigName>

Three things here are load-bearing, each one a silent-failure otherwise:

1. Blender's glTF importer (5.x) injects a stray unparented 42-vertex
   "Icosphere" into EVERY import. Exporting it makes it the character's
   base_mesh.obj downstream, and the render stage then draws a sphere from the
   inside. Unparented meshes are dropped.

2. The rig is pre-oriented so the extracted BVH lands Y-UP. The extraction
   stage maps Blender (x,y,z) -> BVH (z, y, -x); a glTF import is Z-up in
   Blender, so without correction the BVH comes out X-up. Nothing downstream
   can fix that: align_character_face_zplus only ever yaws about Y. Q maps
   Blender +Z (up) -> +Y, which holds for any glTF-sourced rig.

3. Preprocessing needs at least one FBX carrying a MOTION (the reference pose is
   frame 0 of it). A freshly rigged mesh has no animation, so a short procedural
   sequence is generated on the rig's own bones. Frame 0 is the only pose read
   semantically, but the SEQUENCE decides which joints the model is allowed to
   drive at all: anything that never moves in it is marked static and locked.
   Every bone therefore gets a curve — see (3) below.

4. glTF-packed textures are written out as real PNGs. Left packed, the reference
   render comes out magenta and that is what the model gets conditioned on.

Bones are exported without leaf bones: Blender's `*_end` leaves would become
real joints and shift every joint index away from the source rig.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, OUTDIR, RIG = argv[0], argv[1], argv[2]
os.makedirs(OUTDIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not arms:
    print("MOCAP_ERROR no armature in the GLB - the mesh is not rigged")
    sys.exit(1)
arm = arms[0]

# (1) drop importer debris / anything not skinned to the armature
for stray in [o for o in bpy.data.objects if o.type == "MESH" and o.parent is None]:
    print(f"MOCAP_INFO dropped stray mesh {stray.name} ({len(stray.data.vertices)} verts)")
    bpy.data.objects.remove(stray, do_unlink=True)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not meshes:
    print("MOCAP_ERROR no skinned mesh left after dropping unparented objects")
    sys.exit(1)

# (2) pre-orient: Blender +Z (up) -> +Y so the extracted BVH is Y-up
Q = Matrix(((0, 1, 0, 0), (0, 0, 1, 0), (1, 0, 0, 0), (0, 0, 0, 1)))
bpy.context.view_layer.objects.active = arm
arm.matrix_world = Q @ arm.matrix_world
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
for m in meshes:
    m.select_set(True)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)


# (2b) write the textures out as real files.
#
# The glTF importer PACKS images into the session, and export_scene.fbx with
# path_mode="COPY" was supposed to write them into a sibling "<rig>.fbm/" folder.
# It does not — the folder is never created. wm.obj_export downstream then writes
# an mtl whose map_Kd points at that missing file (and at a name with no extension,
# "Image_0"), Blender's renderer cannot load it, and the reference view comes out
# BRIGHT MAGENTA: the missing-texture colour.
#
# That magenta blob is the image the model is conditioned on. Measured on the
# demo's own Coyote rig, our bake produced 4.5 deg of per-bone motion where the
# online demo got 33.7 — so this is not cosmetic, it is the conditioning.
def write_textures():
    written = 0
    for img in list(bpy.data.images):
        # NOT `img.has_data`: a freshly glTF-imported image is packed but its
        # pixels are lazy, so has_data is False while size already reads
        # (1024, 1024). Guarding on it skipped every texture silently.
        if img.type != "IMAGE" or img.size[0] <= 0:
            continue
        target = os.path.join(OUTDIR, f"{bpy.path.clean_name(img.name) or 'texture'}.png")
        try:
            img.filepath_raw = target
            img.file_format = "PNG"
            img.save()
            img.filepath = target
            # Deliberately NOT img.unpack(): it re-derives its own destination
            # through Blender path logic, and with no .blend open that lands a
            # second copy in the CWD (which is the repo). The packed data can stay
            # -- path_mode="ABSOLUTE" below writes img.filepath, which now exists.
            written += 1
        except Exception as exc:                                  # noqa: BLE001
            print(f"MOCAP_INFO could not write texture {img.name}: {exc}")
    print(f"MOCAP_INFO wrote {written} texture(s) of {len(bpy.data.images)}")


write_textures()


def export(path, with_anim):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=False,
        add_leaf_bones=False,
        bake_anim=with_anim,
        bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False,
        bake_anim_simplify_factor=0.0,
        object_types={"ARMATURE", "MESH"},
        # ABSOLUTE, not COPY: the textures are on disk beside this FBX now, and
        # COPY is what silently produced the missing "<rig>.fbm/" reference.
        path_mode="ABSOLUTE",
    )
    print(f"MOCAP_INFO exported {os.path.basename(path)} ({os.path.getsize(path)} bytes)")


export(os.path.join(OUTDIR, f"{RIG}.fbx"), False)

# (3) procedural reference sequence on this rig's own bones. Names are matched
# loosely so it works on non-humanoid rigs too, and every bone gets a curve
# whether it matches or not.
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
FRAMES = 120
# Amplitudes are deliberately modest. Measured on the demo's own Coyote rig:
# scaling this table 1x/2x/4x moves the captured output only 18.7 -> 19.2 -> 20.0
# deg of per-bone motion. What matters is that a joint moves AT ALL (see the
# static mask note below), not how far.
WANT = [
    (("spine", "chest", "torso", "body"), "X", 4.0, 1),
    (("neck", "head"), "X", 3.0, 2),
    (("upperarm", "arm", "shoulder", "wing"), "Z", 9.0, 1),
    (("forearm", "elbow"), "Y", 7.0, 2),
    (("upleg", "thigh", "hip", "leg"), "X", 6.0, 1),
    (("tail",), "Y", 8.0, 1),
]
ical = ("X", "Y", "Z")

# EVERY bone has to move, and that is not a nicety.
#
# build_species_info marks a joint static when its speed never exceeds
# STATIC_EPS across the whole reference sequence, and inference then LOCKS those
# joints — the model may not drive them at all. So this procedural sequence
# decides which joints the capture is even allowed to use.
#
# The keyword table above misses whole limb ends (foot, toe, hand, finger, calf,
# ankle, HorseLink...). On the demo's own Coyote rig that left 20 of 36 joints
# locked, and the joints it locked were the ones carrying most of the real motion:
# the online demo's biggest movers on that rig are R_Foot 133 deg, L_Finger0
# 121 deg, R_Finger0 104 deg — every one of them locked in our bake.
#
# So the table now only chooses each bone's PRIMARY axis and amplitude; anything
# unmatched gets a default, and every bone additionally gets a small out-of-phase
# wobble on its other two axes. Frame 0 is still exactly the rest pose (every
# curve is a sine starting at 0), which is what `ref_idx = 0` reads.
DEFAULT_AMP = 6.0
WOBBLE_AMP = 3.0
tracks = []
for index, pb in enumerate(arm.pose.bones):
    low = pb.name.lower()
    axis, amp, cyc = "X", DEFAULT_AMP, 1
    for keys, want_axis, want_amp, want_cyc in WANT:
        if any(k in low for k in keys):
            axis, amp, cyc = want_axis, want_amp, want_cyc
            break
    side = -1.0 if ("right" in low or low.endswith("_r") or ".r" in low) else 1.0
    # A per-bone phase keeps the pose cloud varied rather than every joint moving
    # in lockstep, which is what the memory bank and the scale cache sample from.
    tracks.append((pb, axis, amp * side, cyc, 0.37 * index))
print(f"MOCAP_INFO animating {len(tracks)} of {len(arm.pose.bones)} bones")

for pb in arm.pose.bones:
    pb.rotation_mode = "XYZ"
for f in range(FRAMES):
    bpy.context.scene.frame_set(f)
    t = f / FRAMES
    for pb, axis, amp, cyc, phase in tracks:
        angles = []
        for a in ical:
            if a == axis:
                angles.append(math.radians(amp) * math.sin(2 * math.pi * cyc * t))
            else:
                angles.append(math.radians(WOBBLE_AMP)
                              * math.sin(2 * math.pi * (cyc + 1) * t + phase)
                              * math.sin(math.pi * t))
        pb.rotation_euler = tuple(angles)
        pb.keyframe_insert(data_path="rotation_euler", frame=f)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.scene.frame_start = 0
bpy.context.scene.frame_end = FRAMES - 1

export(os.path.join(OUTDIR, f"{RIG}-Idle.fbx"), True)

with open(os.path.join(OUTDIR, "_bones.json"), "w", encoding="utf-8") as fh:
    json.dump({"rig": RIG, "bones": [b.name for b in arm.data.bones]}, fh, indent=1)

print("MOCAP_DONE")
