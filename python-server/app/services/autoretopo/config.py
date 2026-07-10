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
    shell_smooth: float = 1.4         # gaussian sigma (voxels) on the signed-distance field; kills voxel ripple
    shell_taubin: int = 10            # Taubin polish steps on the dense shell (0 disables)
    shell_samples_per_pitch: float = 2.0  # surface sampling density (>=2 guarantees gap-free voxel coverage)
    max_memory_gb: float = 4.0        # auto-lower shell_resolution so the voxel grid fits this budget

    # --- clean topology (field-adaptive isotropic remeshing) ---
    adaptive: bool = True             # curvature-adaptive density (more faces where the surface bends)
    remesh_iters: int = 10
    feature_deg: float = 30.0         # crease angle preserved as a feature
    calibrate_passes: int = 1         # rough edge-length correction; decimation sets exact count

    # --- hard-surface / architectural detail preservation ---
    preserve_features: bool = False   # keep sharp creases crisp, don't smooth structural edges
    feature_angle: float = 25.0       # crease angle (deg) treated as a hard edge when preserve_features
    work_face_cap: int = 120000       # pre-decimate inputs larger than this so remeshing stays fast/robust

    # --- silhouette projection ("follow the original surface") ---
    project: bool = True
    project_iters: int = 10
    project_clamp: float = 1.5        # max per-vertex move as a multiple of local edge length
    relax_strength: float = 0.4       # tangential relaxation factor per iteration (0..1)

    # --- compute backend (shell stage only) ---
    device: str = "auto"              # "auto": GPU if an NVIDIA CUDA device + CuPy are
                                      # present, else CPU. "cpu" forces CPU; "cuda" forces
                                      # GPU (errors if unavailable). Only the watertight
                                      # shell stage is GPU-accelerated; everything else is CPU.

    # --- misc ---
    seed: int = 0
    verbose: bool = True

    def to_dict(self):
        return asdict(self)
