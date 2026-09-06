"""Self-verifying checks for the tree generator.

    python -m app.services.treegen --verify
    python -m app.services.treegen --verify --preset oak

The whole generator is deterministic, which makes it unusually cheap to test:
a seed pins the output exactly, so "did this refactor change the mesh?" is a
byte comparison rather than a judgement call. These checks live in the package
(next to assemblyfit's verify.py) rather than in a separate test tree because
the service ships without a test runner -- the CLI *is* the harness.

Four families, matching what can actually go wrong:

  golden       fixed seed -> counts and bounds inside a tolerance band. Catches
               "the tree changed" for any change that was supposed to be a
               refactor.
  invariants   properties that must hold for EVERY tree at any parameters: no
               NaNs, radii that never grow toward a tip, every branch connected
               to the trunk, UVs in range, foliage inside its budget.
  determinism  the same seed twice, byte for byte -- the claim the whole
               spec-as-asset design rests on.
  budget       generation time and triangle counts per preset.
"""
from __future__ import annotations

import time

import numpy as np
import trimesh

from .build import generate_tree, generate_tree_lods, preview_skeleton
from .crown import build_crown, sample_attractors
from .lod import cull_skeleton
from .presets import build_preset_spec, preset_names
from .skeleton import build_skeleton
from .spec import TreeSpec

# Golden expectations for `--preset X --seed 7`. Tolerances are wide on purpose:
# these guard against a stage silently breaking (a tenfold jump, an empty mesh),
# not against the last digit of a float. Refresh with --verify --update-golden
# after an INTENTIONAL change, and say so in the commit.
GOLDEN: dict[str, dict] = {
    "oak": {"nodes": 6486, "chains": 929, "faces": 121310, "height": 9.0},
    "pine": {"nodes": 5360, "chains": 752, "faces": 124158, "height": 14.0},
    "palm": {"nodes": 429, "chains": 50, "faces": 11240, "height": 11.0},
    "dead": {"nodes": 1701, "chains": 247, "faces": 33360, "height": 8.0},
}
GOLDEN_TOLERANCE = 0.05      # 5% drift allowed on counts
BUDGET_SECONDS = 2.0         # a default tree must build inside this
GOLDEN_SEED = 7


class Result:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: list[str] = []
        self.notes: list[str] = []

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        if ok:
            self.passed += 1
        else:
            self.failed.append(f"{label}{(' -- ' + detail) if detail else ''}")
        return ok

    def note(self, text: str) -> None:
        self.notes.append(text)

    @property
    def ok(self) -> bool:
        return not self.failed


def check_invariants(result: Result, spec: TreeSpec, label: str) -> None:
    """Properties that must hold for every tree, whatever the parameters."""
    rng = np.random.default_rng(int(spec.seed))
    crown = build_crown(spec)
    attractors = sample_attractors(spec, crown, rng)
    skeleton = build_skeleton(spec, crown, attractors, rng)

    result.check(np.isfinite(skeleton.positions).all(), f"{label}: skeleton positions finite")
    result.check(np.isfinite(skeleton.radii).all() and (skeleton.radii > 0).all(),
                 f"{label}: radii finite and positive")

    # Every node reaches the root by walking parents -- a branch floating free of
    # the trunk is the failure mode of the order-culling pass.
    parents = skeleton.parents
    result.check(int(parents[0]) == -1, f"{label}: node 0 is the root")
    orphans = int(np.sum(parents[1:] < 0))
    result.check(orphans == 0, f"{label}: no orphan nodes", f"{orphans} orphans")
    result.check(bool(np.all(parents[1:] < np.arange(1, len(parents)))),
                 f"{label}: parents precede children")

    # Radius never grows toward a tip. The tip clamp can make a child EQUAL to
    # its parent, so this is <=, not <.
    child = np.arange(1, len(skeleton.radii))
    grew = skeleton.radii[child] > skeleton.radii[parents[child].astype(np.int64)] + 1e-9
    result.check(not np.any(grew), f"{label}: radii never increase toward a tip",
                 f"{int(grew.sum())} nodes grow")

    # Arc length is monotone down the tree, which bark V-tiling and wind
    # stiffness both assume.
    shrank = skeleton.arclength[child] < skeleton.arclength[parents[child].astype(np.int64)] - 1e-9
    result.check(not np.any(shrank), f"{label}: arc length monotone from the root")

    built = generate_tree(spec)
    scene = built["scene"]
    bark = scene.geometry.get("Tree_Bark")
    result.check(bark is not None and len(bark.faces) > 0, f"{label}: bark geometry emitted")
    if bark is None:
        return

    vertices = np.asarray(bark.vertices)
    result.check(np.isfinite(vertices).all(), f"{label}: no NaN bark vertices")
    result.check(np.isfinite(np.asarray(bark.visual.uv)).all(), f"{label}: no NaN bark UVs")

    uv = np.asarray(bark.visual.uv)
    if spec.bark.uv_mode == "normalized" and spec.bark.junction_mode == "sink":
        # The clean path re-derives UVs and shifts seam duplicates past 1 by
        # design, so the [0,1] claim only holds for the swept parameterization.
        in_range = float(uv[:, 0].min()) >= -1e-9 and float(uv[:, 0].max()) <= 1.0 + 1e-9
        result.check(in_range, f"{label}: bark u in [0,1]",
                     f"u range [{uv[:, 0].min():.3f}, {uv[:, 0].max():.3f}]")

    normals = np.asarray(bark.vertex_normals)
    unit = np.abs(np.linalg.norm(normals, axis=1) - 1.0).max()
    result.check(unit < 1e-6, f"{label}: bark normals unit length", f"max error {unit:.2e}")

    mesh = trimesh.Trimesh(vertices, np.asarray(bark.faces), process=False)
    degenerate = int((mesh.area_faces < 1e-16).sum())
    result.check(degenerate == 0, f"{label}: no degenerate bark triangles", f"{degenerate} found")

    # The pivot is the trunk base at the origin: engines place a tree by its
    # foot, and a tree whose origin floats is unusable in a scatter tool.
    lowest = float(vertices[:, 1].min())
    result.check(abs(lowest) < 0.05 * spec.height, f"{label}: pivot at the trunk base",
                 f"lowest vertex y={lowest:.3f}")

    foliage = scene.geometry.get("Tree_Foliage")
    if spec.foliage.enabled and foliage is not None:
        cards = built["stats"]["foliage"]["cards"]
        result.check(cards <= spec.foliage.max_cards, f"{label}: foliage inside its budget",
                     f"{cards} > {spec.foliage.max_cards}")
        leaf_normals = np.asarray(foliage.vertex_normals)
        unit = np.abs(np.linalg.norm(leaf_normals, axis=1) - 1.0).max()
        result.check(unit < 1e-6, f"{label}: foliage normals unit length")
    elif not spec.foliage.enabled:
        result.check(foliage is None, f"{label}: foliage disabled emits no foliage geometry")

    if spec.bark.junction_mode == "clean":
        welded = mesh.copy()
        welded.merge_vertices()
        result.check(welded.is_watertight, f"{label}: clean junctions are watertight")


def check_lods(result: Result) -> None:
    """The LOD chain, and the property the whole approach rests on."""
    spec = build_preset_spec("oak", seed=GOLDEN_SEED)
    spec.output.lods = 3
    spec.output.impostor = True
    spec.output.impostor_grid = 4      # 16 views is plenty to prove the mapping
    spec.output.impostor_tile = 64
    built = generate_tree_lods(spec)

    levels = built["levels"]
    result.check(len(levels) == 4, "lods: a level per requested step", f"got {len(levels)}")

    faces = [level["stats"]["totals"]["faces"] for level in levels]
    result.check(all(a > b for a, b in zip(faces, faces[1:])),
                 "lods: every level is cheaper than the one before", f"{faces}")
    result.check(faces[-1] < faces[0] * 0.5,
                 "lods: the last level is at least half off", f"{faces[0]} -> {faces[-1]}")

    # The load-bearing property. A branch present at two levels MUST be in the
    # same place with the same thickness, or the levels visibly swap one tree
    # for a different one.
    skeleton = built["skeleton"]
    for drop in (1, 2):
        culled = cull_skeleton(skeleton, skeleton.max_order - drop)
        keep = skeleton.order <= skeleton.max_order - drop
        result.check(np.allclose(culled.positions, skeleton.positions[keep]),
                     f"lods: culling by {drop} moves no surviving branch")
        result.check(np.allclose(culled.radii, skeleton.radii[keep]),
                     f"lods: culling by {drop} rethickens no surviving branch")
        result.check(bool((culled.parents[1:] >= 0).all()),
                     f"lods: culling by {drop} orphans nothing")

    # Culling removes exactly the twigs that leaves grow on, so a level that
    # silently lost its canopy is the easy mistake here.
    for level in levels:
        cards = level["stats"]["foliage"].get("cards", 0)
        result.check(cards > 0, f"lods: LOD{level['level']} keeps a canopy", f"{cards} cards")

    impostor = built.get("impostor")
    result.check(impostor is not None, "impostor: baked when requested")
    if impostor:
        meta = impostor["meta"]
        result.check(meta["views"] == 16, "impostor: one view per grid cell", f"{meta['views']}")
        result.check(meta["atlas"] == [4 * 64, 4 * 64], "impostor: atlas is grid x tile", f"{meta['atlas']}")
        # Coverage is the real test: an all-transparent atlas means the alpha
        # test ate everything, and an opaque one means it ate nothing.
        result.check(0.02 < meta["coverage"] < 0.9, "impostor: atlas has plausible coverage",
                     f"{meta['coverage']:.3f}")
        result.check(len(impostor["albedo_png"]) > 0 and len(impostor["normal_png"]) > 0,
                     "impostor: albedo and normal atlases written")

    # Regression: an ALPHA leaf atlas must still reach the impostor.
    #
    # The bug this guards was invisible to every check above, because the trunk
    # alone cleared the coverage floor. Resolving texture colour per VERTEX puts
    # every leaf card's four corners on the transparent corners of its atlas
    # tile, so alpha reads 0, the alpha test eats the whole canopy, and the
    # impostor comes out as bare branches.
    #
    # Coverage cannot detect that: leaves sit OVER the branches, so losing them
    # barely changes how much of the atlas is filled (measured: 17.8% with a
    # canopy against 17.7% without). What distinguishes them is the colour, so
    # the leaves are painted a marker no bark texture can produce and the test
    # simply asks whether that colour survived the bake.
    from io import BytesIO

    from PIL import Image

    from .impostor import bake_impostor

    tile_px = 64
    leaf = np.zeros((tile_px, tile_px, 4), np.uint8)
    yy, xx = np.mgrid[0:tile_px, 0:tile_px]
    inside = ((yy - tile_px / 2) ** 2 + (xx - tile_px / 2) ** 2) <= (tile_px * 0.42) ** 2
    leaf[..., 0] = 255
    leaf[..., 2] = 255                              # magenta
    leaf[..., 3] = inside.astype(np.uint8) * 255    # opaque centre, clear corners
    buffer = BytesIO()
    Image.fromarray(leaf, "RGBA").save(buffer, format="PNG")

    leafy = build_preset_spec("sapling", seed=GOLDEN_SEED)
    # The leaf material tints the atlas, so neutralise it: the marker has to
    # arrive unmixed for the test to mean what it says.
    leafy.foliage.size_ratio = 0.12
    baked = bake_impostor(
        generate_tree(leafy, leaf_images=[buffer.getvalue()])["scene"],
        grid=3, tile=48, seed=GOLDEN_SEED)
    pixels = np.asarray(Image.open(BytesIO(baked["albedo_png"])), dtype=np.float64) / 255.0
    opaque = pixels[..., 3] > 0.5
    rgb = pixels[..., :3][opaque]
    # Magenta-ish: blue clearly above green. Bark is brown, so it never is.
    marker = float(((rgb[:, 2] > rgb[:, 1] + 0.05).mean()) if len(rgb) else 0.0)
    result.check(marker > 0.2, "impostor: an alpha leaf atlas still reaches the atlas",
                 f"only {marker * 100:.1f}% of opaque pixels came from foliage")

    # The hemisphere mapping must never look up from below the ground.
    from .impostor import hemi_octahedral_directions
    directions = hemi_octahedral_directions(8)
    result.check(bool((directions[:, 1] >= 0).all()), "impostor: every view is above the horizon")
    result.check(np.allclose(np.linalg.norm(directions, axis=1), 1.0),
                 "impostor: view directions are unit length")
    result.note(f"  lods     {' -> '.join(f'{value:,}' for value in faces)} tris")


def check_determinism(result: Result, preset: str) -> None:
    """Same seed, same bytes. The claim the spec-as-asset design rests on."""
    spec = build_preset_spec(preset, seed=GOLDEN_SEED)
    first = generate_tree(spec)["glb"]
    second = generate_tree(build_preset_spec(preset, seed=GOLDEN_SEED))["glb"]
    result.check(bytes(first) == bytes(second), f"determinism: {preset} reproduces byte for byte",
                 f"{len(first)} vs {len(second)} bytes")

    other = generate_tree(build_preset_spec(preset, seed=GOLDEN_SEED + 1))["glb"]
    result.check(bytes(first) != bytes(other), f"determinism: {preset} re-rolls on a new seed")


def check_golden(result: Result, preset: str, update: bool) -> dict | None:
    spec = build_preset_spec(preset, seed=GOLDEN_SEED)
    started = time.time()
    built = generate_tree(spec)
    elapsed = time.time() - started

    # Best-of-two when the first run misses. A budget is meant to measure the
    # implementation, and the first generation of a session pays for cold numpy
    # and scipy import paths while the machine is usually also running the app,
    # a browser holding a live WebGL context, and the services. Timing that once
    # and asserting on it makes the suite fail for reasons that have nothing to
    # do with the code -- measured here at 0.95s warm against 1.65s cold for the
    # identical tree.
    if elapsed > BUDGET_SECONDS:
        retry = time.time()
        built = generate_tree(spec)
        elapsed = min(elapsed, time.time() - retry)

    stats = built["stats"]

    actual = {
        "nodes": stats["skeleton"]["nodes"],
        "chains": stats["skeleton"]["chains"],
        "faces": stats["totals"]["faces"],
        "height": stats["height"],
    }
    if update:
        return actual

    expected = GOLDEN.get(preset)
    if expected is None:
        return None
    for key, want in expected.items():
        got = actual[key]
        tolerance = max(abs(want) * GOLDEN_TOLERANCE, 1.0)
        result.check(abs(got - want) <= tolerance, f"golden {preset}.{key}",
                     f"expected ~{want}, got {got}")
    result.check(elapsed <= BUDGET_SECONDS, f"budget: {preset} under {BUDGET_SECONDS}s",
                 f"best of two took {elapsed:.2f}s")
    result.note(f"  {preset:8s} {actual['faces']:7d} tris  {elapsed:5.2f}s")
    return actual


def run(presets: list[str] | None = None, update_golden: bool = False) -> tuple[Result, dict]:
    result = Result()
    targets = presets or list(GOLDEN.keys())
    updated: dict = {}

    for preset in targets:
        actual = check_golden(result, preset, update_golden)
        if actual is not None and update_golden:
            updated[preset] = actual

    if not update_golden:
        for preset in targets:
            check_invariants(result, build_preset_spec(preset, seed=GOLDEN_SEED), preset)

        # Junction modes and a disabled-foliage tree exercise the branches the
        # presets above never reach.
        check_invariants(
            result,
            build_preset_spec("sapling", seed=GOLDEN_SEED, overrides={"bark": {"junction_mode": "clean"}}),
            "sapling+clean")
        check_invariants(
            result,
            build_preset_spec("sapling", seed=GOLDEN_SEED, overrides={"foliage": {"enabled": False}}),
            "sapling+bare")

        check_determinism(result, "sapling")
        check_lods(result)

        # Preview must stay fast enough to drive a slider drag.
        spec = build_preset_spec("oak", seed=GOLDEN_SEED)
        preview_skeleton(spec)  # warm any lazy imports before timing
        started = time.time()
        preview = preview_skeleton(spec)
        preview_seconds = time.time() - started
        result.check(preview_seconds < 0.25, "budget: skeleton preview under 250ms",
                     f"took {preview_seconds * 1000:.0f}ms")
        result.check(len(preview["polylines"]) > 0, "preview returns polylines")
        result.note(f"  preview  {preview['stats']['nodes']:5d} nodes  {preview_seconds * 1000:5.0f}ms")

        # Every shipped preset must at least build.
        for preset in preset_names():
            if preset in targets:
                continue
            try:
                built = generate_tree(build_preset_spec(preset, seed=GOLDEN_SEED))
                result.check(built["stats"]["totals"]["faces"] > 0, f"preset {preset} builds")
            except Exception as exc:  # noqa: BLE001 -- the failure IS the result
                result.check(False, f"preset {preset} builds", f"{type(exc).__name__}: {exc}")

    return result, updated
