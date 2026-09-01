### species_fps_memory.py ###
import argparse
import os
import pickle
import numpy as np
import matplotlib.pyplot as plt
from tqdm import tqdm
from utils import bvh as BVH  # MOCAP_ABS_IMPORT: run as a script, not a package member
from utils.common import parent_to_kinematic_tree


# =========================================================
# BVH / skeleton utils
# =========================================================
def get_species_bvh_path(
    species_name,
    zoo_root="./datasets/zoo1030/bvh_pose",
):
    for root, _, files in os.walk(zoo_root):
        dir_name = os.path.basename(root)
        for f in files:
            if f.endswith(".bvh") and dir_name.startswith(species_name + "#"):
                return os.path.join(root, f)
    return None


def get_kinematic_tree(
    species_name,
    joint_num,
    zoo_root="./datasets/zoo1030/bvh_pose",
):
    bvh_path = get_species_bvh_path(species_name, zoo_root=zoo_root)

    if bvh_path is None:
        print(f"[WARN] No BVH file found for {species_name}; falling back to sequential connectivity.")
        ktree = [[i, i + 1] for i in range(joint_num - 1)]
        return ktree, None

    anim, _, _ = BVH.load(bvh_path)
    ktree = parent_to_kinematic_tree(anim.parents)
    ktree = [chain for chain in ktree if np.all(np.array(chain) < joint_num)]

    if len(ktree) == 0:
        print(f"[WARN] BVH kinematic chain does not match joint count; falling back to sequential connectivity.")
        ktree = [[i, i + 1] for i in range(joint_num - 1)]

    print(f"[INFO] Using skeleton: {bvh_path}, joint_num={joint_num}, valid_chains={len(ktree)}")
    return ktree, bvh_path


# =========================================================
# Plot utils
# =========================================================
def plot_pose_on_axis(
    ax,
    joints,
    ktree,
    title="pose",
    azim=60,
    elev=15,
    lims=None,
    point_size=7,
    line_width=1.2,
):
    assert joints.ndim == 2 and joints.shape[1] == 3, f"joints shape should be (J,3), got {joints.shape}"

    if lims is None:
        xyz_min, xyz_max = joints.min(0), joints.max(0)
        max_range = max((xyz_max - xyz_min).max() / 2, 1e-6)
        center = (xyz_max + xyz_min) / 2
        lims = [
            (center[0] - max_range, center[0] + max_range),
            (center[1] - max_range, center[1] + max_range),
            (center[2] - max_range, center[2] + max_range),
        ]

    ax.set_xlim(*lims[0])
    ax.set_ylim(*lims[1])
    ax.set_zlim(*lims[2])
    ax.view_init(elev=elev, azim=azim)
    ax.set_title(title, fontsize=7)

    ax.scatter(joints[:, 0], joints[:, 1], joints[:, 2], s=point_size, c="red", alpha=0.9)

    for chain in ktree:
        c = np.array(chain, dtype=np.int64)
        ax.plot(joints[c, 0], joints[c, 1], joints[c, 2], lw=line_width, color="red", alpha=0.9)

    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])
    ax.set_xlabel("")
    ax.set_ylabel("")
    ax.set_zlabel("")


def plot_pose_grid_4x8(
    poses,
    species_name,
    save_path,
    titles=None,
    azim=60,
    elev=15,
    zoo_root="./datasets/zoo1030/bvh",
):
    """
    Plot up to 32 poses in a fixed 4x8 grid.
    poses: (N, J, 3), N <= 32
    """
    assert poses.ndim == 3 and poses.shape[-1] == 3, f"poses should be (N,J,3), got {poses.shape}"

    N, J, _ = poses.shape
    assert N <= 32, f"this function plots at most 32 panels, got N={N}"

    ktree, bvh_path = get_kinematic_tree(species_name, J, zoo_root=zoo_root)

    xyz_min = poses.min(axis=(0, 1))
    xyz_max = poses.max(axis=(0, 1))
    max_range = max((xyz_max - xyz_min).max() / 2, 1e-6)
    center = (xyz_max + xyz_min) / 2
    lims = [
        (center[0] - max_range, center[0] + max_range),
        (center[1] - max_range, center[1] + max_range),
        (center[2] - max_range, center[2] + max_range),
    ]

    nrows, ncols = 4, 8
    fig = plt.figure(figsize=(3.2 * ncols, 3.2 * nrows))

    for i in range(nrows * ncols):
        ax = fig.add_subplot(nrows, ncols, i + 1, projection="3d")
        if i < N:
            title = titles[i] if titles is not None else f"rank={i}"
            plot_pose_on_axis(
                ax=ax,
                joints=poses[i],
                ktree=ktree,
                title=title,
                azim=azim,
                elev=elev,
                lims=lims,
                point_size=7,
                line_width=1.2,
            )
        else:
            ax.axis("off")

    fig.suptitle(
        f"{species_name} FPS memory (4x8, N={N})"
        + (f"\nBVH: {os.path.basename(bvh_path)}" if bvh_path else ""),
        fontsize=14
    )

    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    plt.tight_layout(rect=[0, 0, 1, 0.95])
    plt.savefig(save_path, dpi=200)
    plt.close(fig)
    print(f"[DONE] Saved grid PNG → {save_path}")


# =========================================================
# Data loading
# =========================================================
def load_species_scale(scale_cache_path, species_name):
    assert os.path.isfile(scale_cache_path), f"scale cache not found: {scale_cache_path}"
    with open(scale_cache_path, "rb") as f:
        scale_dict = pickle.load(f)

    assert species_name in scale_dict, f"{species_name} not found in scale cache"

    item = scale_dict[species_name]
    if isinstance(item, dict):
        global_scale = item["global_scale"]
        bbox_center = item.get("bbox_center", None)
    else:
        global_scale = item
        bbox_center = None

    print(f"[INFO] species={species_name}, global_scale={global_scale}, bbox_center={bbox_center}")
    return float(global_scale), bbox_center


def find_species_npz_files(bvh_pose_root, species_name):
    matched_dirs = []
    npz_files = []

    for name in sorted(os.listdir(bvh_pose_root)):
        full_path = os.path.join(bvh_pose_root, name)
        if not os.path.isdir(full_path):
            continue
        if name.startswith(species_name + "#"):
            matched_dirs.append(full_path)

    for seq_dir in matched_dirs:
        for fname in sorted(os.listdir(seq_dir)):
            if fname.endswith(".npz"):  # for y all
            # if fname == "y0.npz":   # for y0 only
                npz_files.append(os.path.join(seq_dir, fname))

    print(f"[INFO] matched seq dirs: {len(matched_dirs)}")
    for d in matched_dirs:
        print(f"    {os.path.basename(d)}")
    print(f"[INFO] total npz files: {len(npz_files)}")

    return matched_dirs, npz_files


def load_species_all_frames(npz_files, global_scale, downsample=1):
    """
    position = (position - position[:, 0:1, :]) / global_scale
    """
    rot_list = []
    pose_list = []

    for npz_path in tqdm(npz_files, desc="loading npz"):
        data = np.load(npz_path, mmap_mode="r")

        if "position" not in data or "rot6d" not in data:
            print(f"[WARN] skip {npz_path}, missing position/rot6d")
            data.close()
            continue

        position = data["position"].astype(np.float32)   # (F, J, 3)
        rot6d = data["rot6d"].astype(np.float32)         # (F, J, 6)

        F = min(len(position), len(rot6d))
        position = position[:F]
        rot6d = rot6d[:F]

        if downsample > 1:
            position = position[::downsample]
            rot6d = rot6d[::downsample]

        position = (position - position[:, 0:1, :]) / global_scale

        F2, J = position.shape[:2]
        rot_list.append(rot6d.reshape(F2, J * 6))
        pose_list.append(position)

        data.close()

    assert len(rot_list) > 0, "No valid npz loaded"

    rot_flat = np.concatenate(rot_list, axis=0)      # (N, J*6)
    pose_flat = np.concatenate(pose_list, axis=0)    # (N, J, 3)

    print(f"[INFO] rot_flat shape  = {rot_flat.shape}")
    print(f"[INFO] pose_flat shape = {pose_flat.shape}")
    return rot_flat, pose_flat


# =========================================================
# FPS
# =========================================================
def farthest_point_sampling(feat_flat, n_select, start_idx=0):
    """
    feat_flat: (N, D)
    Each round picks the point whose nearest-neighbor distance to the
    already-selected set is the largest.
    """
    N = feat_flat.shape[0]
    n_select = min(n_select, N)
    assert 0 <= start_idx < N, f"start_idx out of range: {start_idx}, N={N}"

    selected = [start_idx]

    diff = feat_flat - feat_flat[start_idx:start_idx + 1]
    min_dist2 = np.sum(diff * diff, axis=1)

    for _ in tqdm(range(1, n_select), desc="fps"):
        next_idx = int(np.argmax(min_dist2))
        selected.append(next_idx)

        diff = feat_flat - feat_flat[next_idx:next_idx + 1]
        dist2 = np.sum(diff * diff, axis=1)
        min_dist2 = np.minimum(min_dist2, dist2)

    return np.array(selected, dtype=np.int64)


# =========================================================
# Species scan helpers
# =========================================================
def list_all_species_from_bvh_pose_root(bvh_pose_root):
    """
    Extract every species_name from the subdirectory names under bvh_pose_root.
    For example:
      Tyranno#001  -> Tyranno
      Raptor#abc   -> Raptor
    """
    species_set = set()

    for name in sorted(os.listdir(bvh_pose_root)):
        full_path = os.path.join(bvh_pose_root, name)
        if not os.path.isdir(full_path):
            continue

        if "#" in name:
            species_name = name.split("#")[0]
            if len(species_name) > 0:
                species_set.add(species_name)

    species_list = sorted(species_set)
    print(f"[INFO] found {len(species_list)} species in {bvh_pose_root}")
    for s in species_list:
        print(f"    {s}")
    return species_list


def clear_existing_fps_pkls(save_root, n_select=32):
    os.makedirs(save_root, exist_ok=True)

    for mode_name in ["rot", "pose", "both"]:
        pkl_path = os.path.join(save_root, f"fps_select_by_{mode_name}_{n_select}.pkl")
        if os.path.isfile(pkl_path):
            os.remove(pkl_path)
            print(f"[INFO] removed old pkl: {pkl_path}")


# =========================================================
# Save helpers
# =========================================================
def save_single_mode_result(
    species_name,
    mode_name,
    selected_rot6d,
    selected_pose,
    save_root,
    n_select=32,
):
    """
    mode_name in {"rot", "pose", "both"}

    pkl:
      ./debug_species_fps_memory/fps_select_by_{mode}_32.pkl
      One aggregate pkl per mode, keyed by species.

    png:
      ./debug_species_fps_memory/images/{species}_fps_select_by_{mode}_32.png
    """
    assert mode_name in ["rot", "pose", "both"]

    os.makedirs(save_root, exist_ok=True)
    image_root = os.path.join(save_root, "images")
    os.makedirs(image_root, exist_ok=True)

    pkl_path = os.path.join(
        save_root,
        f"fps_select_by_{mode_name}_{n_select}.pkl"
    )
    png_path = os.path.join(
        image_root,
        f"{species_name}_fps_select_by_{mode_name}_{n_select}.png"
    )

    if os.path.isfile(pkl_path):
        with open(pkl_path, "rb") as f:
            all_species_dict = pickle.load(f)
        if not isinstance(all_species_dict, dict):
            print(f"[WARN] existing pkl is not dict, reset: {pkl_path}")
            all_species_dict = {}
    else:
        all_species_dict = {}

    all_species_dict[species_name] = {
        "rot6d": selected_rot6d.astype(np.float32),
        "pose_normed": selected_pose.astype(np.float32),
    }

    with open(pkl_path, "wb") as f:
        pickle.dump(all_species_dict, f)

    titles = [f"rank={i}" for i in range(len(selected_pose))]
    plot_pose_grid_4x8(
        poses=selected_pose,
        species_name=species_name,
        save_path=png_path,
        titles=titles,
    )

    print(f"[DONE] updated {mode_name} dict -> {pkl_path}")
    print(f"[DONE] saved   {mode_name} png  -> {png_path}")
    print(f"[INFO] current species count in {os.path.basename(pkl_path)}: {len(all_species_dict)}")


# =========================================================
# Per-species main
# =========================================================
def select_species_fps_memory(
    species_name,
    bvh_pose_root="./datasets/zoo1030/bvh_pose",
    scale_cache_path="./datasets/zoo1030/__mesh2pose1002_species_scale_cache.pkl",
    save_root="./species_fps_memory_y0",
    n_select=32,
    downsample=1,
    start_idx=0,
    both_pose_weight=1.0,
):
    """
    Three FPS variants:
      1) by_rot  : rot_flat
      2) by_pose : pose_flat.reshape(N, J*3)
      3) by_both : concat(rot_flat, both_pose_weight * pose_flat_flat)
    """
    assert n_select == 32, f"n_select is hard-pinned to 32, got {n_select}"

    global_scale, _ = load_species_scale(scale_cache_path, species_name)
    _, npz_files = find_species_npz_files(bvh_pose_root, species_name)
    assert len(npz_files) > 0, f"No npz found for species {species_name}"

    rot_flat, pose_flat = load_species_all_frames(
        npz_files=npz_files,
        global_scale=global_scale,
        downsample=downsample,
    )

    N = rot_flat.shape[0]
    pose_vec = pose_flat.reshape(N, -1).astype(np.float32)
    rot_vec = rot_flat.astype(np.float32)
    both_vec = np.concatenate(
        [rot_vec, both_pose_weight * pose_vec],
        axis=1
    ).astype(np.float32)

    # -------------------------
    # by rot
    # -------------------------
    idx_rot = farthest_point_sampling(
        feat_flat=rot_vec,
        n_select=n_select,
        start_idx=start_idx,
    )
    sel_rot_rot6d = rot_flat[idx_rot].reshape(len(idx_rot), -1, 6)
    sel_rot_pose = pose_flat[idx_rot]

    save_single_mode_result(
        species_name=species_name,
        mode_name="rot",
        selected_rot6d=sel_rot_rot6d,
        selected_pose=sel_rot_pose,
        save_root=save_root,
        n_select=n_select,
    )

    # -------------------------
    # by pose
    # -------------------------
    idx_pose = farthest_point_sampling(
        feat_flat=pose_vec,
        n_select=n_select,
        start_idx=start_idx,
    )
    sel_pose_rot6d = rot_flat[idx_pose].reshape(len(idx_pose), -1, 6)
    sel_pose_pose = pose_flat[idx_pose]

    save_single_mode_result(
        species_name=species_name,
        mode_name="pose",
        selected_rot6d=sel_pose_rot6d,
        selected_pose=sel_pose_pose,
        save_root=save_root,
        n_select=n_select,
    )

    # -------------------------
    # by both
    # -------------------------
    idx_both = farthest_point_sampling(
        feat_flat=both_vec,
        n_select=n_select,
        start_idx=start_idx,
    )
    sel_both_rot6d = rot_flat[idx_both].reshape(len(idx_both), -1, 6)
    sel_both_pose = pose_flat[idx_both]

    save_single_mode_result(
        species_name=species_name,
        mode_name="both",
        selected_rot6d=sel_both_rot6d,
        selected_pose=sel_both_pose,
        save_root=save_root,
        n_select=n_select,
    )

    print(f"[DONE] species={species_name} all FPS memory saved under: {save_root}")


# =========================================================
# All-species main
# =========================================================
def select_all_species_fps_memory(
    bvh_pose_root="./datasets/zoo1030/bvh_pose",
    scale_cache_path="./datasets/zoo1030/__mesh2pose1002_species_scale_cache.pkl",
    save_root="./debug_species_fps_memory",
    n_select=32,
    downsample=1,
    start_idx=0,
    both_pose_weight=1.0,
    reset_existing_pkl=True,
):
    assert n_select == 32, f"n_select is hard-pinned to 32, got {n_select}"

    species_list = list_all_species_from_bvh_pose_root(bvh_pose_root)
    assert len(species_list) > 0, f"No species found in {bvh_pose_root}"

    if reset_existing_pkl:
        clear_existing_fps_pkls(save_root, n_select=n_select)

    success_list = []
    fail_list = []

    for species_name in tqdm(species_list, desc="all species"):
        print("\n" + "=" * 80)
        print(f"[INFO] processing species: {species_name}")
        print("=" * 80)

        try:
            select_species_fps_memory(
                species_name=species_name,
                bvh_pose_root=bvh_pose_root,
                scale_cache_path=scale_cache_path,
                save_root=save_root,
                n_select=n_select,
                downsample=downsample,
                start_idx=start_idx,
                both_pose_weight=both_pose_weight,
            )
            success_list.append(species_name)

        except Exception as e:
            print(f"[ERROR] failed on species={species_name}: {e}")
            fail_list.append((species_name, str(e)))

    print("\n" + "#" * 100)
    print("[DONE] all species finished")
    print(f"[INFO] success: {len(success_list)}")
    print(f"[INFO] failed : {len(fail_list)}")

    if len(success_list) > 0:
        print("[INFO] success species:")
        for s in success_list:
            print(f"    {s}")

    if len(fail_list) > 0:
        print("[WARN] failed species:")
        for s, err in fail_list:
            print(f"    {s} -> {err}")

    print("#" * 100)

def parse_args():
    parser = argparse.ArgumentParser(
        description="Select all-species FPS memory and save results."
    )

    parser.add_argument(
        "--bvh_pose_root",
        type=str,
        help="Path to the BVH pose root directory.",
        required=True
    )
    parser.add_argument(
        "--scale_cache_path",
        type=str,
        help="Path to the species scale cache pickle file.",
        required=True
    )
    parser.add_argument(
        "--save_root",
        type=str,
        default="./datasets/zoo1030/species_fps_memory_yAll",
        help="Directory to save FPS memory results.",
    )
    parser.add_argument(
        "--n_select",
        type=int,
        default=32,
        help="Number of samples to select.",
    )
    parser.add_argument(
        "--downsample",
        type=int,
        default=2,
        help="Downsample factor.",
    )
    parser.add_argument(
        "--start_idx",
        type=int,
        default=0,
        help="Start index for processing.",
    )
    parser.add_argument(
        "--both_pose_weight",
        type=float,
        default=1.0,
        help="Weight for both-pose selection.",
    )
    parser.add_argument(
        "--reset_existing_pkl",
        action="store_true",
        help="Reset existing pickle files if set.",
    )

    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    select_all_species_fps_memory(
        bvh_pose_root=args.bvh_pose_root,
        scale_cache_path=args.scale_cache_path,
        save_root=args.save_root,
        n_select=args.n_select,
        downsample=args.downsample,
        start_idx=args.start_idx,
        both_pose_weight=args.both_pose_weight,
        reset_existing_pkl=args.reset_existing_pkl,
    )