"""Request option models and response metadata.

Meshes are exchanged as binary file bodies (GLB by default), so these models
describe only the *options* that ride alongside the upload as a JSON form field,
plus the stats we report back in response headers.

The option fields mirror the parameters of the bundled pipelines 1:1:
  - AutoUvOptions      -> autouv.unwrap(...)
  - AutoRetopoOptions  -> autoretopo.RetopoConfig(...)
Defaults match the libraries' own defaults.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class AutoUvOptions(BaseModel):
    """Every parameter accepted by autouv.unwrap()."""

    # --- segmentation ---
    max_cone_deg: float = Field(default=50.0, ge=1.0, le=180.0,
                                description="Normal-cone cap (deg). Higher = fewer, more distorted charts.")
    sharp_weight: float = Field(default=0.35, ge=0.0, le=1.0,
                                description="How strongly sharp edges attract seams.")
    min_faces: int = Field(default=20, ge=1, le=100000,
                           description="Charts smaller than this are dissolved into neighbours.")
    min_area_frac: float = Field(default=0.004, ge=0.0, le=1.0,
                                 description="Min chart area as a fraction of total surface area.")
    fold_cap_deg: float = Field(default=88.0, ge=1.0, le=180.0,
                                description="Dihedral fold cap that forces a seam.")

    # --- refinement (LSCM-validated chart merge) ---
    refine: bool = Field(default=True, description="Run the LSCM-validated merge pass (off = faster, more charts).")
    refine_target_faces: int = Field(default=80, ge=1, le=100000,
                                     description="Charts below this face count are merge candidates.")
    refine_ad_thresh: float = Field(default=1.32, ge=1.0, le=10.0,
                                    description="Max angle-distortion ratio a merge may introduce.")

    # --- parameterization ---
    method: Literal["auto", "lscm", "arap", "planar"] = Field(
        default="auto", description="Per-chart flattening method.")
    arap_iters: int = Field(default=4, ge=0, le=100,
                            description="As-rigid-as-possible iterations (0 = LSCM/planar only).")

    # --- packing ---
    resolution: int = Field(default=1024, ge=64, le=8192,
                            description="Atlas resolution used to size padding (px).")
    padding_texels: int = Field(default=4, ge=0, le=64, description="Inter-island padding in texels.")

    # --- topology repair ---
    weld: bool = Field(default=True, description="Proximity-weld coincident verts before unwrapping.")
    weld_tol_frac: float = Field(default=0.1, ge=0.0, le=1.0,
                                 description="Weld tolerance as a fraction of median edge length.")


class AutoRetopoOptions(BaseModel):
    """Every field of autoretopo.RetopoConfig."""

    # --- target ---
    target_faces: int = Field(default=6000, ge=50, le=5_000_000,
                              description="Approximate face budget of the output.")
    quads: bool = Field(default=False, description="Convert the final mesh to quad-dominant (reported in metrics).")

    # --- base generation (watertight shell) ---
    watertight: bool = Field(default=True,
                             description="Build a unified voxel shell (robust) vs. remesh the surface directly.")
    shell_resolution: int = Field(default=256, ge=16, le=1024,
                                  description="Voxel grid cells along the longest bbox axis.")
    shell_close_iter: int = Field(default=1, ge=0, le=20,
                                  description="Morphological closing iterations to bridge cracks.")
    shell_smooth: float = Field(default=1.4, ge=0.0, le=5.0,
                                description="Gaussian sigma (voxels) on the signed-distance field; kills voxel ripple (lower = crisper).")
    shell_taubin: int = Field(default=10, ge=0, le=100,
                              description="Taubin polish steps on the dense shell (0 disables).")
    shell_samples_per_pitch: float = Field(default=2.0, ge=1.0, le=8.0,
                                           description="Surface sampling density (>=2 = gap-free coverage).")
    max_memory_gb: float = Field(default=4.0, ge=0.0, le=128.0,
                                 description="Auto-lower shell resolution to fit this budget (0 disables).")

    # --- clean topology (field-adaptive isotropic remeshing) ---
    adaptive: bool = Field(default=True, description="Curvature-adaptive density (more faces where it bends).")
    remesh_iters: int = Field(default=10, ge=1, le=100, description="Isotropic remesh iterations.")
    feature_deg: float = Field(default=30.0, ge=0.0, le=180.0, description="Crease angle preserved as a feature.")
    calibrate_passes: int = Field(default=1, ge=0, le=10, description="Rough edge-length correction passes.")

    # --- hard-surface / architectural detail preservation ---
    preserve_features: bool = Field(default=False,
                                    description="Hard-surface mode: keep sharp creases crisp, skip smoothing/projection.")
    feature_angle: float = Field(default=25.0, ge=0.0, le=180.0,
                                 description="Crease angle (deg) treated as a hard edge when preserve_features is on.")

    # --- silhouette projection ---
    project: bool = Field(default=True, description="Project the remesh back onto the original surface.")
    project_iters: int = Field(default=10, ge=0, le=100, description="Projection iterations.")
    project_clamp: float = Field(default=1.5, ge=0.0, le=10.0,
                                 description="Max per-vertex move as a multiple of local edge length.")
    relax_strength: float = Field(default=0.4, ge=0.0, le=1.0,
                                  description="Tangential relaxation factor per iteration.")

    # --- compute backend (shell stage only) ---
    device: Literal["auto", "cpu", "cuda"] = Field(
        default="auto",
        description="Compute backend for the watertight shell stage: 'auto' uses an NVIDIA "
                    "GPU (via CuPy) when available and falls back to CPU; 'cpu' forces CPU; "
                    "'cuda' forces GPU. Other stages always run on CPU.")

    # --- misc ---
    seed: int = Field(default=0, ge=0, description="RNG seed for reproducibility.")


class RepairOptions(BaseModel):
    """Options for the non-manifold / topology repair endpoint.

    Targeted cleanup that resolves non-manifold edges without a full retopo:
    weld coincident verts, drop duplicate/degenerate faces, then either remove
    the offending faces or split the sheets apart, optionally sealing the small
    holes that face removal opens.
    """

    method: Literal["remove", "split"] = Field(
        default="remove",
        description="How to resolve non-manifold edges. 'remove' deletes the "
                    "offending faces (small holes can then be closed); 'split' "
                    "detaches the sheets, keeping all faces but leaving boundary edges.")
    close_holes: bool = Field(default=True,
                              description="Close the small holes that face removal opens (also runs a trimesh fill pass).")
    max_hole_size: int = Field(default=30, ge=0, le=5000,
                               description="Largest hole (in boundary edges) to close; bigger openings are left intact.")
    weld: bool = Field(default=True,
                       description="Weld coincident vertices by position before repairing (matches the editor's check).")


class ConvertOptions(BaseModel):
    """Options for the GLB -> FBX engine-export endpoint (headless Blender).

    Presets tune the FBX for the target engine's import pipeline; see
    app/tools/fbx_worker.py for the exact exporter settings each one maps to.
    """

    preset: Literal["unity", "unreal", "generic"] = Field(
        default="generic",
        description="Target engine. 'unity'/'generic' write a meters file with "
                    "scale-1 transforms; 'unreal' bakes the scene to centimeters.")
    unreal_scale_mode: Literal["bake", "units"] = Field(
        default="bake",
        description="Unreal only. 'bake' rescales mesh/armature/animation data "
                    "x100 to native centimeters; 'units' keeps meters and relies "
                    "on UE's 'Convert Scene Unit' import option.")
    bake_fps: int = Field(default=30, ge=1, le=120,
                          description="Frame rate animation takes are baked at.")
    anim_simplify: float = Field(default=1.0, ge=0.0, le=10.0,
                                 description="Baked curve simplification (0 = lossless, larger = smaller files).")


class MeshStats(BaseModel):
    """Reported back to the caller (also surfaced via response headers)."""

    vertex_count: int
    face_count: int
    has_uv: bool
