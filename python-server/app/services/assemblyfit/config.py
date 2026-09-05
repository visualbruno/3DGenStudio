"""Fit configuration.

A dataclass rather than the Pydantic model, so the CLI and the pipeline share
one definition that does not depend on FastAPI. app/schemas.py mirrors it for
the HTTP surface -- keep the two in step.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FitConfig:
    # Which stages run, in this order. 'shrinkwrap' conforms the whole piece;
    # 'penetration' only fixes what is inside. Running both is normal for cloth:
    # shrinkwrap does the shaping, penetration cleans up what it left behind.
    stages: tuple = ('shrinkwrap', 'penetration')

    # Clearance between the garment and the body, in world units. Not zero: a
    # garment sitting exactly ON the surface z-fights with it, and any later
    # animation pushes it through immediately.
    offset: float = 0.004

    # A BUDGET, not a cost: conform() exits as soon as nothing needs to move
    # more than `tolerance` x offset, so a generous default is nearly free and
    # covers a piece that starts a long way from the body.
    iterations: int = 20
    # Convergence: stop when the largest step still being taken is under this
    # fraction of the mean edge length.
    tolerance: float = 0.02

    # Rounds of sign voting on the inside/outside test. Load-bearing on the
    # non-watertight meshes this app produces -- see raw_signed_distance.
    vote_rounds: int = 2

    smooth_rounds: int = 2
    # How hard the displacement field is pulled toward its neighbourhood mean.
    # Lower than autoretopo's 0.7 on purpose -- see the note in conform().
    smooth_alpha: float = 0.45

    # Per-iteration move limit, as a fraction of each vertex's own edge length.
    # The spike guard -- see conform().
    step_clamp: float = 0.5

    # Keep a conformed piece WHERE THE USER PLACED IT. The body's normal points
    # upward across the shoulders and collarbones, so an unconstrained conform
    # slides a breastplate up the torso and onto the neck; and any residual mean
    # displacement drifts the piece bodily. Conform stages only -- the
    # penetration push must stay free to move vertices out.
    # How low-frequency the conform field is. THIS is what preserves a
    # garment's thickness: a spatial average moves a shell's inner and outer
    # surfaces together, where a graph average moves only one. Larger =
    # broader, gentler conform.
    field_centres: int = 400
    field_smoothing: float = 1.0

    # Scales every step. A PARTIAL conform is often what looks right: the
    # piece takes on the body's shape without being pulled tight into its
    # concavities, where triangles start inverting.
    strength: float = 1.0

    # Stop and keep the last good state once this fraction of faces has
    # turned inside out. Nothing recovers an inverted triangle.
    flip_abort_frac: float = 0.01

    # Stop before the piece's own inner and outer surfaces meet. Where they
    # touch, the renderer cannot order them and the lining flickers through
    # the outside -- which reads as a texture bug but is geometry. In world
    # units; 0 disables the guard.
    min_thickness: float = 0.0

    # Rebuild the outer surface from the conformed inner one at the thickness
    # measured before the fit (shell.py). It does preserve thickness better
    # (-18% vs -32% on a real armour) but is OFF by default because on a mesh
    # that already self-intersects it makes the visible symptom worse: on a
    # 9.5k-vertex armour with 1002 self-occluding points BEFORE any fit, the
    # rebuild took that to 4114 against the field's 1588. Reconstructing each
    # outer vertex independently cannot produce a coherent surface when the
    # shell it is measured from is already broken.
    rebuild_shell: bool = False

    lock_vertical: bool = True
    preserve_centroid: bool = True

    # Vertices further than this from the body are left alone, as a multiple of
    # the BODY's bounding-box diagonal. Keeps a cape's hem or a plume from being
    # sucked onto the torso. None disables the limit.
    max_distance_ratio: float | None = 0.25

    # Decimate the body to at most this many faces before using it as the
    # proximity target. The closest-point query dominates the runtime and is
    # insensitive to fine detail at these offsets, so this is nearly free
    # accuracy-wise and a large speedup on a 500k-face AI body. 0 disables.
    body_face_budget: int = 60000

    # 'auto' uses the NVIDIA Warp GPU BVH when a CUDA runtime is present and
    # falls back to trimesh; 'cpu' forces the CPU path.
    device: str = 'auto'

    verbose: bool = False

    stats: dict = field(default_factory=dict)
