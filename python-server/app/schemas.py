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

    # --- shading ---
    preserve_normals: bool = Field(default=True,
                                   description="Carry the input mesh's own vertex normals through the unwrap, so "
                                               "shading is unchanged. Turn off to rebuild them from the geometry.")
    normal_smooth_deg: float = Field(default=180.0, ge=0.0, le=180.0,
                                     description="Smoothing angle used only when normals are rebuilt (no input "
                                                 "normals, or preserve off): edges sharper than this stay hard. "
                                                 "180 = fully smooth, 0 = fully faceted.")


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
    preserve_uv: bool = Field(
        default=True,
        description="Repair surgically so UVs (and therefore the texture) survive: "
                    "only the faces forming the defect are touched, and vertices "
                    "keep their indices. Turn off to fall back to the pymeshlab "
                    "rebuild, which is more aggressive on badly broken meshes but "
                    "welds across UV seams and discards all UVs.")
    close_holes: bool = Field(default=True,
                              description="Close the small holes that face removal opens (also runs a trimesh fill pass).")
    max_hole_size: int = Field(default=30, ge=0, le=5000,
                               description="Largest hole (in boundary edges) to close; bigger openings are left intact.")
    weld: bool = Field(default=True,
                       description="Weld coincident vertices by position before repairing (matches the editor's check). "
                                   "Ignored when preserve_uv is on — that path welds only as an analysis view and "
                                   "never writes the merge back, since welding is what destroys UV seams.")


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


class BakeOptions(BaseModel):
    """Options for the high-to-low texture bake (`/meshes/bake`).

    This is what makes Auto Retopo and Optimize non-destructive: on their own they
    return clean topology with the detail deleted, and baking captures that detail
    as a normal map so the low-poly mesh still reads as the high-poly one.
    """

    maps: list[Literal["normal", "ao", "base_color", "roughness", "metallic"]] = Field(
        default=["normal", "ao"],
        description="Which passes to bake. 'normal' carries the lost silhouette detail, "
                    "'ao' the contact shadow, 'base_color' transfers the source texture, "
                    "and 'roughness'/'metallic' resample the source's PBR channels onto the "
                    "new UVs. When two or more of ao/roughness/metallic are baked they are "
                    "also returned packed into one R/G/B 'orm' texture, which is the form "
                    "glTF expects.")
    resolution: int = Field(default=2048, ge=64, le=8192,
                            description="Output map resolution (px). Cost scales with the square of this.")
    samples: int = Field(default=8, ge=1, le=512,
                         description="Cycles samples. Only the AO pass is noisy enough to need more than a few.")
    cage_extrusion: float = Field(default=0.0, ge=0.0, le=10.0,
                                  description="How far to push the ray origins out along the low-poly normals, "
                                              "in metres. Too small misses detail that sticks out; too large "
                                              "catches surfaces from the other side of the mesh. 0 scales it to "
                                              "the mesh (2% of its bounding-box diagonal), which is right far "
                                              "more often than any fixed distance.")
    max_ray_distance: float = Field(default=0.0, ge=0.0, le=10.0,
                                    description="Ray length limit in metres (0 = unlimited).")
    margin: int = Field(default=8, ge=0, le=64,
                        description="Texels of island dilation, so filtering cannot sample the empty gutter "
                                    "and bleed seams into the surface.")
    align_source: bool = Field(default=True,
                               description="Re-centre the source onto the target when the two are the same "
                                           "object at the same scale but different pivots. A bake is ray "
                                           "casting, so an offset source returns blank texels wherever the "
                                           "two stop overlapping — and moving a pivot between picking the "
                                           "source and baking is enough to cause it. Sources at a different "
                                           "scale are never moved; that case is reported instead.")
    require_overlap: float = Field(default=0.5, ge=0.0, le=1.0,
                                   description="Refuse the bake when, after alignment, the source covers less "
                                               "than this fraction of the target's smallest axis. Fails in "
                                               "seconds instead of spending minutes of ray casting to return "
                                               "blank maps. 0 disables the check.")


class InspectOptions(BaseModel):
    """Options for the Game-Ready check (`/meshes/inspect`).

    The check is read-only: it never modifies or returns a mesh, only a report.
    The budgets below are what turns a raw measurement into a pass/warn/fail, so
    they are exposed to the UI rather than hard-coded — a hero prop and a
    background rock have very different definitions of "too many triangles".
    """

    tri_budget: int = Field(default=50_000, ge=1, le=100_000_000,
                            description="Triangle budget. Over it warns; 2x over fails.")
    texture_resolution: int = Field(default=2048, ge=16, le=16384,
                                    description="Atlas resolution texel density is measured against (px).")
    max_material_count: int = Field(default=4, ge=1, le=1000,
                                    description="Material count above which the asset costs extra draw calls.")
    uv_overlap_grid: int = Field(default=512, ge=64, le=4096,
                                 description="Raster grid used to estimate UV island overlap (px).")
    uv_scan_max_faces: int = Field(default=60_000, ge=1000, le=2_000_000,
                                   description="Face cap for the UV overlap raster; bigger meshes are sampled.")
    max_extent: float = Field(default=50.0, gt=0.0,
                              description="Largest bbox dimension expected, in metres (bigger suggests a cm/mm unit mix-up).")
    min_extent: float = Field(default=0.01, gt=0.0,
                              description="Smallest bbox dimension expected, in metres.")
    expect_ground_pivot: bool = Field(default=False,
                                      description="Check that the mesh sits on Y=0 with its pivot at the origin (props/characters).")


class SegmentOptions(BaseModel):
    """Options for Smart Segmentation (`/meshes/segment`).

    The defaults are the ones to leave alone; they segment a typical character or
    prop sensibly. Reach for `convex_eta` when boundaries cut across a bulge they
    should have gone around, and for the two weights when parts are separated by
    the wrong criterion — thickness (a limb vs. a torso) or creases (a panel line).

    Nothing here sets the part count: the endpoint returns the whole merge
    hierarchy and the client picks a level from it.
    """

    proxy_faces: int = Field(default=3000, ge=200, le=50000,
                             description="Face budget of the analysis proxy. Higher = finer boundaries, "
                                         "much slower clustering.")
    sdf_rays: int = Field(default=20, ge=4, le=128,
                          description="Rays per proxy face used to measure thickness.")
    sdf_cone: float = Field(default=120.0, ge=10.0, le=180.0,
                            description="Spread of the ray cone about the inward normal (deg).")
    sdf_alpha: float = Field(default=4.0, ge=1.0, le=64.0,
                             description="Log-normalisation strength. Higher spreads out the thin end.")
    sdf_smooth: int = Field(default=2, ge=0, le=20,
                            description="Bilateral smoothing passes over the thickness field (0 disables).")
    sdf_sigma: float = Field(default=0.08, gt=0.0, le=1.0,
                             description="How different a neighbour may be and still be smoothed with.")
    convex_eta: float = Field(default=0.12, ge=0.0, le=1.0,
                              description="Cost of cutting across a convex ridge relative to a concave crease. "
                                          "Low keeps boundaries in the valleys; 1.0 ignores the distinction.")
    w_thickness: float = Field(default=1.0, ge=0.0, le=10.0,
                               description="Weight on the thickness difference between two regions.")
    w_concavity: float = Field(default=1.0, ge=0.0, le=10.0,
                               description="Weight on the crease angle along their shared boundary.")
    precise: bool = Field(default=True,
                          description="Cast the thickness rays against the full-resolution mesh rather than the "
                                      "proxy. Slower without embreex installed, and the only way thin details "
                                      "measure as thin.")


class CollisionOptions(BaseModel):
    """Options for collision-hull generation (`/meshes/collision`).

    'convex_hull' is the default because it is instantaneous and never fails, and
    for the many props that are broadly convex it is the right answer.
    'decomposition' runs CoACD to approximate a concave shape with several convex
    parts — the shape an engine actually wants, since a single hull swallows every
    cavity — but it costs tens of seconds regardless of triangle count: the work
    is in its Monte-Carlo search over cut planes, not in the geometry. The search
    parameters below are therefore tuned well below CoACD's own defaults, trading
    fidelity a collider does not need for a wait a user will accept.
    """

    method: Literal["decomposition", "convex_hull", "box", "sphere"] = Field(
        default="convex_hull",
        description="Hull strategy. 'decomposition' = CoACD convex decomposition; the rest are single primitives.")
    max_hulls: int = Field(default=16, ge=1, le=256,
                           description="Upper bound on parts produced by the decomposition.")
    threshold: float = Field(default=0.25, ge=0.01, le=1.0,
                             description="CoACD concavity threshold. Lower = more parts, tighter fit, much slower.")
    input_faces: int = Field(default=1000, ge=0, le=1_000_000,
                             description="Decimate the mesh to this many faces before decomposing. "
                                         "A collider needs volume, not surface detail (0 disables).")
    max_hull_vertices: int = Field(default=64, ge=4, le=255,
                                   description="Per-hull vertex budget — the limit physics engines "
                                               "actually impose (PhysX caps at 255). 0 disables.")
    resolution: int = Field(default=1000, ge=100, le=10000,
                            description="CoACD sampling resolution (its own default is 2000).")
    mcts_nodes: int = Field(default=6, ge=2, le=40,
                            description="CoACD search width (its own default is 20).")
    mcts_iterations: int = Field(default=40, ge=10, le=500,
                                 description="CoACD search iterations (its own default is 150).")
    mcts_max_depth: int = Field(default=2, ge=1, le=7,
                                description="CoACD search depth (its own default is 3).")
    preprocess_resolution: int = Field(default=50, ge=20, le=200,
                                       description="CoACD manifold preprocessing resolution.")
    seed: int = Field(default=0, ge=0, description="RNG seed for reproducible decompositions.")


class MeshStats(BaseModel):
    """Reported back to the caller (also surfaced via response headers)."""

    vertex_count: int
    face_count: int
    has_uv: bool

class FitOptions(BaseModel):
    """Assembly fit: adapt a garment/armour piece to a base body.

    Mirrors app/services/assemblyfit/config.py -- keep the two in step, along
    with DEFAULT_FIT_OPTIONS in src/utils/assemblyFit.js and the MCP zod block.
    """

    stages: list[Literal["shrinkwrap", "penetration"]] = Field(
        default=["shrinkwrap", "penetration"],
        description="Stages to run, in order. 'shrinkwrap' conforms the whole piece to the "
                    "body's shape; 'penetration' only pushes out what is inside it. Rigid "
                    "pieces (plate armour) should use penetration alone -- conforming the "
                    "whole shell rounds its edges and bows its flats.",
    )
    offset: float = Field(
        default=0.004, ge=0.0, le=1.0,
        description="Clearance to leave between the piece and the body, in world units. "
                    "Not zero: a garment sitting exactly on the surface z-fights with it.",
    )
    iterations: int = Field(
        default=20, ge=1, le=200,
        description="Iteration BUDGET per stage. The loop exits early once it stops moving "
                    "anything meaningfully, so a generous value is nearly free.",
    )
    tolerance: float = Field(
        default=0.02, ge=0.0, le=1.0,
        description="Convergence threshold, as a fraction of the piece's mean edge length.",
    )
    vote_rounds: int = Field(
        default=2, ge=0, le=10,
        description="Rounds of sign voting on the inside/outside test. Load-bearing when the "
                    "body is not watertight, which is the norm for AI-generated meshes.",
    )
    smooth_rounds: int = Field(
        default=2, ge=0, le=20,
        description="Laplacian rounds applied to the displacement FIELD each iteration. "
                    "Removes crease-to-crease zigzag; too much stalls narrow penetrations.",
    )
    smooth_alpha: float = Field(
        default=0.45, ge=0.0, le=1.0,
        description="How hard the displacement field is pulled toward its neighbourhood mean.",
    )
    step_clamp: float = Field(
        default=0.5, ge=0.0, le=10.0,
        description="How far a vertex may outrun its neighbours per iteration, in local edge "
                    "lengths. The spike guard. It does not cap uniform motion.",
    )
    field_centres: int = Field(
        default=400, ge=0, le=5000,
        description="Sample points for the smooth conform field. THIS is what preserves a "
                    "garment's thickness: a spline fitted over sparse centres moves a shell's "
                    "inner and outer surfaces together, where a per-vertex projection collapses "
                    "them onto each other. Fewer centres = broader, gentler conform. 0 disables "
                    "smoothing, which flattens the piece onto the body.",
    )
    field_smoothing: float = Field(
        default=1.0, ge=0.0, le=100.0,
        description="Regularisation on that spline. Higher follows the body more loosely.",
    )
    strength: float = Field(
        default=1.0, ge=0.0, le=1.0,
        description="How far the reshape goes, 0..1. A partial conform often looks better: "
                    "the piece takes the body's shape without being pulled tight into its "
                    "concavities, where triangles start to invert.",
    )
    flip_abort_frac: float = Field(
        default=0.01, ge=0.0, le=1.0,
        description="Stop and keep the last good state once this fraction of faces has "
                    "turned inside out. Nothing recovers an inverted triangle, so stopping "
                    "beats reporting the damage. 0 disables the guard.",
    )
    min_thickness: float = Field(
        default=0.0, ge=0.0, le=1.0,
        description="Stop the reshape before the piece's own inner and outer surfaces get "
                    "closer than this. Where they touch, the lining flickers through the "
                    "outside — it looks like a texture bug but it is geometry. World units; "
                    "0 disables the guard.",
    )
    rebuild_shell: bool = Field(
        default=False,
        description="Rebuild the piece's outer surface from its conformed inner surface at "
                    "the thickness measured beforehand. This is what keeps a garment's wall: "
                    "no smooth deformation can contract a surface and preserve thickness. Off by "
                    "default: on a mesh that already self-intersects it makes the lining show "
                    "through more, not less.",
    )
    lock_vertical: bool = Field(
        default=True,
        description="Keep a conformed piece at the height it was placed. The body's normal "
                    "points upward across the shoulders and collarbones, so without this a "
                    "breastplate slides up the torso and onto the neck.",
    )
    preserve_centroid: bool = Field(
        default=True,
        description="Remove any net translation from the conform, so the piece cannot drift "
                    "bodily off the placement the user chose. Local shape change is untouched.",
    )
    max_distance_ratio: float = Field(
        default=0.25, ge=0.0, le=10.0,
        description="Leave vertices further than this x the body's bounding-box diagonal "
                    "untouched, so a cape hem or helmet plume is not sucked onto the torso. "
                    "0 disables the limit.",
    )
    body_face_budget: int = Field(
        default=60000, ge=0, le=2000000,
        description="Decimate the body to at most this many faces before using it as the "
                    "proximity target. Large speedup, negligible accuracy cost. 0 disables.",
    )
    device: Literal["auto", "cpu"] = Field(
        default="auto",
        description="'auto' uses the NVIDIA Warp GPU closest-point query when available "
                    "(roughly 1000x faster than the CPU path) and falls back to trimesh.",
    )
