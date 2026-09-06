"""TreeSpec -- the tree *is* the spec, the mesh is a derived output.

A TreeSpec is ~2KB of JSON that regenerates its mesh bit-for-bit from a single
seed. That is the whole point of the design: re-rolling a seed, tweaking one
slider, or diffing two presets never costs a mesh round-trip, and the thing
worth storing as an asset is the spec, not the multi-MB GLB it happens to
produce.

Everything that can affect geometry lives here. Nothing in the generator reads a
global, a clock, or an unseeded RNG -- see `rng.py`.

Versioning: `version` is bumped whenever a field's *meaning* changes (not when
one is added with a back-compatible default). `migrate()` upgrades older specs
so a preset saved a year ago still opens.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SPEC_VERSION = 2

CrownShape = Literal[
    "ellipsoid",      # generic deciduous
    "sphere",
    "hemisphere",     # broad, flat-bottomed canopy
    "cone",           # conifer: wide base, narrow top
    "inverted_cone",  # vase / elm
    "cylinder",       # columnar poplar
    "umbrella",       # palm: a thin shell near the top only
    "custom",         # user mesh (crown.custom_mesh_b64)
]


class CrownSpec(BaseModel):
    """The envelope attraction points are sampled inside.

    All sizes are ratios of the tree's total `height` so a spec is scale-free --
    changing `height` alone gives the same tree, bigger.
    """

    shape: CrownShape = Field(default="ellipsoid", description="Envelope the crown fills.")
    radius_ratio: float = Field(default=0.42, ge=0.02, le=3.0,
                                description="Crown horizontal radius / tree height.")
    base_ratio: float = Field(default=0.30, ge=0.0, le=0.95,
                              description="Height where the crown starts / tree height (trunk clear length).")
    top_ratio: float = Field(default=1.0, ge=0.05, le=1.0,
                             description="Height where the crown ends / tree height.")
    offset_x: float = Field(default=0.0, ge=-1.0, le=1.0, description="Crown centre X offset / height (lean).")
    offset_z: float = Field(default=0.0, ge=-1.0, le=1.0, description="Crown centre Z offset / height.")
    shell_bias: float = Field(default=0.0, ge=-1.0, le=1.0,
                              description="+1 packs attractors near the envelope surface (dense outer canopy), "
                                          "-1 packs them at the centre, 0 = uniform by volume.")
    shell_thickness: float = Field(default=0.35, ge=0.05, le=1.0,
                                   description="For 'umbrella': fraction of the radius the shell occupies.")
    custom_mesh_b64: str | None = Field(default=None,
                                        description="Base64 GLB/OBJ used as the envelope when shape='custom'. "
                                                    "Scaled into the crown box; sampling uses its containment test.")


class SkeletonSpec(BaseModel):
    """Space colonization (Runions 2007) parameters.

    Distances are ratios, resolved against the crown radius (attraction, step)
    or the step size (kill) -- so the same numbers behave identically at any tree
    height. Weber-Penn was rejected here on purpose: it is parameter-heavy and
    its output reads as CG. Colonization gets competition for light for free.
    """

    attractors: int = Field(default=3500, ge=16, le=60000,
                            description="Attraction points sampled in the crown. Drives branch density.")
    attraction_ratio: float = Field(default=0.30, ge=0.05, le=6.0,
                                    description="Attraction distance / crown radius. Larger = smoother, "
                                                "longer-reaching branches.")
    kill_ratio: float = Field(default=1.40, ge=0.3, le=8.0,
                              description="Kill distance / step size. Larger = sparser, cleaner branching.")
    step_ratio: float = Field(default=0.035, ge=0.005, le=0.6,
                              description="Growth step / crown radius. Smaller = finer, slower.")
    max_iterations: int = Field(default=1500, ge=8, le=4000,
                                description="Hard cap on colonization iterations.")
    max_nodes: int = Field(default=60000, ge=64, le=1000000,
                           description="Hard cap on skeleton nodes. The real guard on generation time.")
    stall_iterations: int = Field(default=12, ge=2, le=200,
                                  description="Stop after this many iterations that kill no attractor "
                                              "(escapes the symmetric-attractor deadlock).")
    tropism: tuple[float, float, float] = Field(
        default=(0.0, 0.22, 0.0),
        description="Constant direction added at every step. +Y reaches for light, -Y weeps.")
    randomness: float = Field(default=0.10, ge=0.0, le=1.5,
                              description="Per-step direction jitter (seeded).")
    trunk_wobble: float = Field(default=0.05, ge=0.0, le=1.0,
                                description="Lateral drift of the trunk while it climbs to the crown.")
    trunk_lean: tuple[float, float] = Field(default=(0.0, 0.0),
                                            description="Constant XZ lean applied to the trunk climb.")
    smoothing: int = Field(default=2, ge=0, le=12,
                           description="Laplacian passes over each branch chain (kills the zig-zag of raw steps).")
    min_chain_nodes: int = Field(default=2, ge=1, le=32,
                                 description="Chains shorter than this are pruned as orphan tips.")


class BranchingSpec(BaseModel):
    """Radius model. Murray / da Vinci: r_parent^n = sum(r_child^n)."""

    radius_exponent: float = Field(default=2.2, ge=1.2, le=4.0,
                                   description="n in r_parent^n = sum(r_child^n). 2 = area-preserving, 3 = fat trunk. Also the twig-thickness lever: tip radius ~ trunk * tips^(-1/n), so LOWER n gives finer twigs.")
    trunk_radius_ratio: float = Field(default=0.020, ge=0.002, le=0.5,
                                      description="Trunk radius at the base / tree height. Radii are solved by the "
                                                  "exponent law and then scaled so the root matches this.")
    tip_radius_ratio: float = Field(default=0.0007, ge=0.0, le=0.1,
                                    description="Minimum (tip) radius / tree height. Clamps twigs off zero.")
    root_flare: float = Field(default=0.65, ge=0.0, le=4.0,
                              description="Extra radius at the very base (buttress). 0 disables.")
    root_flare_ratio: float = Field(default=0.05, ge=0.0, le=0.5,
                                    description="Arc length over which the flare falls off / tree height.")
    max_order: int = Field(default=8, ge=1, le=16,
                           description="Branches above this order are culled (an LOD lever too).")


class BarkSpec(BaseModel):
    """Swept generalized cylinders -- not SDF + marching cubes.

    Marching cubes would destroy the analytic UVs, cost an order of magnitude
    more, and lose every twig thinner than a voxel. The price is that junctions
    are not booleaned; see `junction_mode`.
    """

    radial_min: int = Field(default=3, ge=3, le=32, description="Radial segments on the thinnest twigs.")
    radial_max: int = Field(default=16, ge=3, le=64, description="Radial segments on the trunk.")
    radial_falloff: float = Field(default=0.40, ge=0.05, le=2.0,
                                  description="Exponent mapping radius -> segment count. Lower = twigs keep more.")
    junction_mode: Literal["sink", "clean"] = Field(
        default="sink",
        description="'sink' extends the child's first ring to the parent centreline and caps it -- the bark texture "
                    "hides the seam and it is ~free. 'clean' additionally welds + repairs for a watertight result.")
    junction_flare: float = Field(default=1.30, ge=1.0, le=3.0,
                                  description="Radius multiplier at the sunk socket ring (the swelling at a fork).")
    uv_mode: Literal["normalized", "world"] = Field(
        default="normalized",
        description="'normalized': u = theta/2pi (perfect tiling; bark stretches on the trunk). "
                    "'world': u = theta*r/tile (uniform texel density; u leaves [0,1]).")
    uv_tile: float = Field(default=0.55, ge=0.01, le=100.0,
                           description="World length that maps to one V tile of the bark texture.")
    cap_tips: bool = Field(default=True, description="Cone-cap branch tips (a hemisphere reads as a blob).")
    split_radius_ratio: float = Field(default=0.25, ge=0.0, le=1.0,
                                      description="Chains thinner than this fraction of the trunk radius become the "
                                                  "'branches' material when a separate branch texture is supplied. "
                                                  "Ignored otherwise -- without a branch texture the whole tree stays "
                                                  "one material and one draw call.")


class FoliageSpec(BaseModel):
    """Leaf cards. Clusters are the default because single cards do not scale.

    A 40k-leaf tree at 2 tris per card is unusable in an engine; the budget and
    the cluster mode are enforced from the first version rather than bolted on
    as an optimization later.
    """

    enabled: bool = True
    mode: Literal["cards", "clusters"] = Field(default="clusters",
                                               description="'clusters' bakes a 3-5 card fan as one placement.")
    max_cards: int = Field(default=6000, ge=0, le=200000,
                           description="Hard cap on emitted cards. Placements above it are thinned deterministically.")
    cluster_cards: int = Field(default=4, ge=2, le=8, description="Cards per cluster in 'clusters' mode.")
    cluster_spread: float = Field(default=0.45, ge=0.0, le=2.0, description="Fan spread inside a cluster.")
    min_order: int = Field(default=2, ge=0, le=16, description="Only branches at/above this order carry leaves.")
    max_radius_ratio: float = Field(default=0.30, ge=0.0, le=4.0,
                                    description="Only branches thinner than this fraction of the TRUNK radius carry "
                                                "leaves, so leaves never sprout from the trunk itself. Measured "
                                                "against the trunk rather than the tree's height because branch "
                                                "radii all scale with the trunk: a height-relative threshold silently "
                                                "gets stricter as the trunk thickens, until almost nothing qualifies.")
    spacing_ratio: float = Field(default=0.035, ge=0.002, le=0.5,
                                 description="Distance between placements along a branch / tree height.")
    size_ratio: float = Field(default=0.030, ge=0.001, le=0.5, description="Card width / tree height.")
    aspect: float = Field(default=1.15, ge=0.1, le=8.0, description="Card height / width.")
    align_ratio: float = Field(default=0.0, ge=0.0, le=1.0,
                               description="Blend the card's growth direction from radial (0, a leaf sticking out "
                                           "of the branch) toward the branch tangent (1, a frond running along it). "
                                           "Palms and conifer needle sprays need this; broadleaves do not.")
    droop_deg: float = Field(default=22.0, ge=-90.0, le=90.0, description="Downward pitch of each card.")
    tilt_jitter_deg: float = Field(default=25.0, ge=0.0, le=180.0, description="Random per-card tilt.")
    size_jitter: float = Field(default=0.25, ge=0.0, le=1.0, description="Random per-card size variation.")
    phyllotaxis_deg: float = Field(default=137.507764, ge=0.0, le=360.0,
                                   description="Angle advanced per placement around the branch (golden angle).")
    spherical_normals: float = Field(default=1.0, ge=0.0, le=1.0,
                                     description="Blend leaf-card normals toward (leaf - crown centre). The single "
                                                 "biggest visual win: flat card normals read as dead cardboard.")
    atlas_cols: int = Field(default=2, ge=1, le=16, description="Leaf atlas grid columns.")
    atlas_rows: int = Field(default=2, ge=1, le=16, description="Leaf atlas grid rows.")
    atlas_tiles: int = Field(default=0, ge=0, le=256,
                             description="How many of the grid's cells actually hold a leaf. 0 means all of them. "
                                         "Set automatically when an atlas is composed from a list of images: three "
                                         "leaves need a 2x2 grid, which leaves one cell empty, and a card that "
                                         "sampled that cell would alpha-test away and punch a hole in the canopy.")
    double_sided: bool = Field(default=True, description="Emit both windings so cards are lit from behind too.")
    auto_orient_leaves: bool = Field(default=True,
                                     description="Find each leaf image's stem and rotate it so the stem is at the "
                                                 "top, which is where a card attaches to its branch. Generated "
                                                 "cut-outs come out at arbitrary angles, and without this a leaf can "
                                                 "hang from its tip or sideways. Turn it off for a hand-authored "
                                                 "atlas that is already laid out correctly.")


class OutputSpec(BaseModel):
    wind_colors: bool = Field(default=False,
                              description="Bake wind data into COLOR_0: R branch phase, G stiffness, "
                                          "B leaf flutter phase, A hierarchy weight. OFF by default because "
                                          "glTF defines COLOR_0 as a MULTIPLIER on base colour, so a "
                                          "spec-compliant viewer paints the tree with it -- bark reads green "
                                          "(B is always 0) and foliage reads as random confetti. Turn it on "
                                          "when the target is an engine wind shader that samples vertex "
                                          "colour as data, and expect the model to look wrong anywhere else.")
    up_axis: Literal["y", "z"] = Field(default="y", description="Export up axis (glTF is Y-up; Z suits DCC flows).")
    scale: float = Field(default=1.0, gt=0.0, le=1000.0, description="Uniform export scale (100 = metres -> cm).")
    engine: Literal["generic", "unity", "unreal", "godot"] = Field(
        default="generic", description="Convenience preset for up_axis / scale.")
    lods: int = Field(default=0, ge=0, le=4,
                      description="Extra LOD levels, each regenerated from the SAME skeleton so branches never "
                                  "move between levels. 0 = LOD0 only.")
    impostor: bool = Field(default=False,
                           description="Bake a hemi-octahedral impostor: a grid of pre-rendered views plus a quad, "
                                       "for the distance at which even the cheapest mesh is wasted. Needs an "
                                       "impostor shader engine-side to sample view-dependently.")
    impostor_grid: int = Field(default=8, ge=2, le=16,
                               description="Views per axis. 8 = 64 views, the usual quality/size trade.")
    impostor_tile: int = Field(default=128, ge=32, le=512,
                               description="Pixels per view. grid x tile is the atlas size, so 8 x 128 = 1024px. "
                                           "Cost grows with the ATLAS area, so doubling this quadruples the bake.")
    impostor_samples: float = Field(default=5.0, ge=1.0, le=32.0,
                                    description="Supersamples per pixel of projected triangle area. Every sample that "
                                                "wins the depth test is averaged into its pixel, so this is the "
                                                "antialiasing control as well as the coverage one: too low and the "
                                                "atlas comes out noisier than the leaf texture it was baked from. "
                                                "Cost is linear in it.")


class TreeSpec(BaseModel):
    """The complete, deterministic description of one tree."""

    version: int = Field(default=SPEC_VERSION)
    name: str = Field(default="Tree", max_length=120)
    preset: str | None = Field(default=None, description="Preset this spec was forked from (provenance only).")
    seed: int = Field(default=1337, ge=0, le=2147483647)
    height: float = Field(default=8.0, gt=0.01, le=500.0, description="Trunk base to crown top, in output units.")

    crown: CrownSpec = Field(default_factory=CrownSpec)
    skeleton: SkeletonSpec = Field(default_factory=SkeletonSpec)
    branching: BranchingSpec = Field(default_factory=BranchingSpec)
    bark: BarkSpec = Field(default_factory=BarkSpec)
    foliage: FoliageSpec = Field(default_factory=FoliageSpec)
    output: OutputSpec = Field(default_factory=OutputSpec)

    # ----- derived absolute sizes (every generator stage reads these) -----
    @property
    def crown_radius(self) -> float:
        return self.crown.radius_ratio * self.height

    @property
    def crown_base(self) -> float:
        return self.crown.base_ratio * self.height

    @property
    def crown_top(self) -> float:
        return max(self.crown.top_ratio * self.height, self.crown_base + 1e-4)

    @property
    def step_size(self) -> float:
        return max(self.skeleton.step_ratio * self.crown_radius, 1e-5)

    @property
    def attraction_distance(self) -> float:
        return max(self.skeleton.attraction_ratio * self.crown_radius, self.step_size * 1.05)

    @property
    def kill_distance(self) -> float:
        return max(self.skeleton.kill_ratio * self.step_size, 1e-6)


def migrate(data: dict) -> dict:
    """Upgrade a stored spec dict to the current SPEC_VERSION."""
    data = dict(data or {})
    version = int(data.get("version") or SPEC_VERSION)
    if version > SPEC_VERSION:
        raise ValueError(
            f"This tree spec was written by a newer build (spec v{version}, this one reads v{SPEC_VERSION})."
        )
    if version < 2:
        # v1 measured foliage.max_radius_ratio against the tree's HEIGHT; v2
        # measures it against the trunk radius. Both describe the same absolute
        # threshold, so the conversion is exact:
        #     threshold = old * height = new * (trunk_radius_ratio * height)
        #  => new = old / trunk_radius_ratio
        foliage = data.get("foliage")
        branching = data.get("branching") or {}
        if isinstance(foliage, dict) and "max_radius_ratio" in foliage:
            trunk = float(branching.get("trunk_radius_ratio") or 0.020)
            if trunk > 0:
                foliage["max_radius_ratio"] = min(float(foliage["max_radius_ratio"]) / trunk, 4.0)

    data["version"] = SPEC_VERSION
    return data


def parse_spec(data: dict) -> TreeSpec:
    return TreeSpec(**migrate(data))
