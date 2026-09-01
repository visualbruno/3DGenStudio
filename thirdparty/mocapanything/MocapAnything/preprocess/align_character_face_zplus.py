import argparse
import os
import sys
from glob import glob

import numpy as np
from tqdm import tqdm

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import utils.bvh as BVH
from utils.bvh_tools import (
    face_forward_bvh_with_scale,
    quadruped_character_restpose_alignment,
)


INVERSE_LIST = {
    # "Anaconda",
    "Goat",
    "Jaws",
    "Raptor3",
    "Scorpion",
    "Scorpion-2",
    "Spider",
    # "Tukan",
    "Raptor2",
    "Trex",
}

MANUALLY_DEFINED = {
    "Crab": [1, 0, 0],
    "Deer": [0, 0, -1],
    "Dog": [0, 0, -1],
    "Dog-2": [0, 0, -1],
    "Giantbee": [1, 0, 0],
    "HermitCrab": [1, 0, 0],
    "Parrot": [1, 0, 0],
    "Parrot2": [1, 0, 0],
    "Pirrana": [1, 0, 0],
    "SabreToothTiger": [0, 0, -1],
    "Tyranno": [1, 0, 0],
    "KingCobra": [1, 0, 0],
    "Buffalo": [1, 0, 0],
}


def resolve_front(character_name, ref_dir):
    if character_name in MANUALLY_DEFINED:
        return np.asarray(MANUALLY_DEFINED[character_name], dtype=np.float64)

    if ref_dir:
        ref_path = os.path.join(ref_dir, character_name, "front.npy")
        if os.path.exists(ref_path):
            front = np.load(ref_path).astype(np.float64)
            if character_name in INVERSE_LIST:
                front = -front
            return front

    # Let quadruped_character_restpose_alignment infer and save front.npy.
    # For inverse-list species without an external reference, we apply the
    # inversion after an initial inferred pass in align_one().
    return None


def find_rest_bvh(character_folder):
    preferred = os.path.join(character_folder, "rest.bvh")
    if os.path.exists(preferred):
        return preferred
    candidates = sorted(glob(os.path.join(character_folder, "*.bvh")))
    return candidates[0] if candidates else None


def face_forward_in_place(bvh_path):
    anim, names, frametime = BVH.load(bvh_path)
    face_forward_bvh_with_scale(bvh_path, anim, names, frametime)


# MOCAP_FFS_SCALE_FIX: 0.01 assumes a CENTIMETRE source rig (Truebones). This
# template is what utils/npy2bvh.py builds every output BVH on, so a metre-native
# rig (anything out of glTF) got its motion back on a skeleton 100x too small.
_FFS_SCALE = float(os.environ.get("MOCAP_BVH_SCALE", "0.01"))


def write_ffs_bvh(character_name, target_dir, rest_bvh_path, scale=_FFS_SCALE):
    """Regenerate `{character}_ffs.bvh` from the ALIGNED rest pose.

    extract_character_from_fbx.py already wrote one next to the unaligned rest
    pose, and it gets copied here verbatim — so it has to be rebuilt, or the mesh
    export ends up 90 degrees off from everything else.
    """
    ffs_path = os.path.join(target_dir, f"{character_name}_ffs.bvh")
    anim, names, frametime = BVH.load(rest_bvh_path)
    face_forward_bvh_with_scale(ffs_path, anim, names, frametime, scale)
    return ffs_path


def align_motion_bvhs(character_name, front, motion_root, motion_output_root, skip_existing=True):
    motion_paths = sorted(glob(os.path.join(motion_root, f"{character_name}#*.bvh")))
    os.makedirs(motion_output_root, exist_ok=True)
    done = 0
    skipped = 0
    for motion_bvh in motion_paths:
        out_bvh = os.path.join(motion_output_root, os.path.basename(motion_bvh))
        if skip_existing and os.path.exists(out_bvh):
            skipped += 1
            continue
        quadruped_character_restpose_alignment(motion_bvh, motion_output_root, front=front)
        done += 1
    return done, skipped


def align_one(
    character_folder,
    output_root,
    motion_root=None,
    motion_output_root=None,
    ref_dir=None,
    skip_existing=True,
):
    character_name = os.path.basename(character_folder.rstrip(os.sep))
    target_dir = os.path.join(output_root, character_name)
    target_bvh = os.path.join(target_dir, "rest.bvh")

    rest_bvh = find_rest_bvh(character_folder)
    if rest_bvh is None:
        raise FileNotFoundError(f"No rest BVH found in {character_folder}")

    os.makedirs(target_dir, exist_ok=True)
    front = resolve_front(character_name, ref_dir)

    character_ready = (
        skip_existing
        and os.path.exists(target_bvh)
        and os.path.exists(os.path.join(target_dir, "base_mesh.obj"))
        and os.path.exists(os.path.join(target_dir, "front.npy"))
    )
    if character_ready:
        front = np.load(os.path.join(target_dir, "front.npy")).astype(np.float64)
        char_status = "SKIP"
    else:
        if front is None and character_name in INVERSE_LIST:
            # Infer once, read front.npy, then rerun with inverted front.
            quadruped_character_restpose_alignment(rest_bvh, target_dir, front=None)
            inferred_front_path = os.path.join(target_dir, "front.npy")
            front = -np.load(inferred_front_path).astype(np.float64)

        quadruped_character_restpose_alignment(rest_bvh, target_dir, front=front)
        front = np.load(os.path.join(target_dir, "front.npy")).astype(np.float64)

        aligned_bvh = os.path.join(target_dir, os.path.basename(rest_bvh))
        if os.path.basename(rest_bvh) != "rest.bvh":
            os.replace(aligned_bvh, target_bvh)
            aligned_bvh = target_bvh
        face_forward_in_place(aligned_bvh)
        write_ffs_bvh(character_name, target_dir, aligned_bvh)
        char_status = "DONE"

    motion_status = ""
    if motion_root and motion_output_root:
        done, skipped = align_motion_bvhs(
            character_name,
            front,
            motion_root,
            motion_output_root,
            skip_existing=skip_existing,
        )
        motion_status = f", motions done={done}, skip={skipped}"
    return f"[{char_status}] {character_name}{motion_status}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input_root", default=os.path.join(os.environ.get("ZOO_ROOT", "zoo"), "characters"))
    parser.add_argument("--output_root", default=os.path.join(os.environ.get("ZOO_ROOT", "zoo"), "characters_face_zplus"))
    parser.add_argument("--motion_root", default=os.path.join(os.environ.get("ZOO_ROOT", "zoo"), "motions"))
    parser.add_argument("--motion_output_root", default=os.path.join(os.environ.get("ZOO_ROOT", "zoo"), "motions_face_zplus"))
    parser.add_argument("--ref_dir", default=os.environ.get("ALIGN_REF_DIR", ""))
    parser.add_argument("--no_skip_existing", action="store_true")
    args = parser.parse_args()

    character_folders = sorted(
        path for path in glob(os.path.join(args.input_root, "*")) if os.path.isdir(path)
    )
    # Optional sharding for parallel runs (obj1k speedup). Env-gated.
    _si = int(os.environ.get('SHARD_IDX', '0'))
    _st = int(os.environ.get('SHARD_TOTAL', '1'))
    if _st > 1:
        character_folders = [d for i, d in enumerate(character_folders) if i % _st == _si]
    print(f"==> Aligning {len(character_folders)} characters to +Z")
    failures = []
    for character_folder in tqdm(character_folders, desc="align_characters"):
        character_name = os.path.basename(character_folder.rstrip(os.sep))
        try:
            print(align_one(
                character_folder,
                args.output_root,
                motion_root=args.motion_root,
                motion_output_root=args.motion_output_root,
                ref_dir=args.ref_dir or None,
                skip_existing=not args.no_skip_existing,
            ))
        except Exception as exc:
            failures.append((character_name, str(exc)))
            print(f"[ERROR] {character_name}: {exc}")

    if failures:
        failed_path = os.path.join(args.output_root, "_align_failed.tsv")
        os.makedirs(args.output_root, exist_ok=True)
        with open(failed_path, "w") as f:
            for character_name, error in failures:
                f.write(f"{character_name}\t{error}\n")
        print(f"[WARN] Alignment failures written to {failed_path}")


if __name__ == "__main__":
    main()
