"""Configuration for the Auto-Retopo pipeline."""
from __future__ import annotations
from dataclasses import dataclass, asdict


@dataclass
class RetopoConfig:
    # --- target ---
    target_faces: int = 6000          # approximate face budget of the output
    quads: bool = False               # convert the final triangle mesh to quad-dominant

    # --- base generation ("the new watertight layer") ---
    watertight: bool = True           # True: build a unified SDF/voxel shell (robust to messy input)
                                      # False: remesh the original surface directly (keeps open boundaries)
    shell_resolution: int = 256       # voxel grid cells along the longest bbox axis (silhouette fidelity)
    shell_close_iter: int = 1         # morphological closing to bridge cracks in non-watertight input
    shell_smooth: float = 0.4         # gaussian sigma (voxels) on the signed-distance field; kills voxel ripple
                                      # 1.4 until 2026-10-09. Measured at 15k faces over 6 meshes (two-way
                                      # Hausdorff vs the source): the blur costs detail and buys almost
                                      # nothing, because the isotropic remesh + projection stages already
                                      # remove voxel ripple. Lowering 1.4 -> 0.4 cut lost detail by 13-33%
                                      # on 5 of 6 (knight -33%, sorcerer -18%, camp -16%, tree -15%,
                                      # warrior -13%) while the "ripple" direction stayed flat (+-0.005).
                                      # The exception is hard-surface architecture: a building got 27%
                                      # WORSE, because flat walls are where voxel staircase actually shows
                                      # and the blur is what removes it. Raise this back toward 1.4 for
                                      # buildings / architecture - it is a slider in the Auto Retopo panel.
    shell_taubin: int = 10            # Taubin polish steps on the dense shell (0 disables)
    shell_samples_per_pitch: float = 2.0  # surface sampling density (>=2 guarantees gap-free voxel coverage)
    max_memory_gb: float = 4.0        # auto-lower shell_resolution so the voxel grid fits this budget

    # --- clean topology (field-adaptive isotropic remeshing) ---
    adaptive: bool = True             # curvature-adaptive density (more faces where the surface bends)
    remesh_iters: int = 10
    feature_deg: float = 30.0         # crease angle preserved as a feature
    calibrate_passes: int = 1         # rough edge-length correction; decimation sets exact count.
                                      # Watertight+adaptive only recalibrates on UNDERSHOOT since
                                      # 2026-11-24 (overshoot recalibration was slow and worse - see
                                      # remesh.isotropic_remesh stop_on_overshoot)

    # --- hard-surface / architectural detail preservation ---
    preserve_features: bool = False   # keep sharp creases crisp, don't smooth structural edges
    feature_angle: float = 25.0       # crease angle (deg) treated as a hard edge when preserve_features
    work_face_cap: int = 120000       # pre-decimate inputs larger than this so remeshing stays fast/robust

    # --- silhouette projection ("follow the original surface") ---
    project: bool = True
    project_iters: int = 10
    relax_strength: float = 0.4       # tangential relaxation factor per iteration (0..1)
                                      # (there was a `project_clamp` here; projection stopped using
                                      # it when it moved to a smoothed displacement field, so it was
                                      # removed on 2026-10-21 rather than left as a dead slider)

    # --- mirror-symmetric output ---
    mirror: str = "off"               # "off" | "auto" | "x" | "y" | "z": keep one half of the result
                                      # and reflect it onto the other ("auto" picks the most symmetric axis)
    mirror_max_cost: float = 10.0     # revert the mirror when it costs more than this % of detail
                                      # (relative rise in mean distance, either direction). Measured
                                      # 2026-10-21 at 10k faces: head/leopard <=1.5%, warrior ~10%,
                                      # an asymmetric anime figure +82% - which is what this catches

    # --- compute backend (shell stage only) ---
    device: str = "auto"              # "auto": GPU if an NVIDIA CUDA device + CuPy are
                                      # present, else CPU. "cpu" forces CPU; "cuda" forces
                                      # GPU (errors if unavailable). The watertight shell
                                      # and projection stages are GPU-accelerated; remesh is CPU.

    # --- misc ---
    seed: int = 0
    verbose: bool = True

    def to_dict(self):
        return asdict(self)
