"""Procedural tree generation: TreeSpec -> skeleton -> bark + foliage -> GLB.

Bundled as a package with its own CLI, the same shape as services/autouv and
services/assemblyfit, so each stage can be run and graded from the terminal
without the browser or the HTTP layer:

    python -m app.services.treegen --preset oak --seed 7 -o oak.glb
    python -m app.services.treegen --list

The design commitment is that the *spec* is the asset and the mesh is a derived
output: ~2KB of seeded JSON regenerates the tree exactly, so re-rolls, parameter
tweaks and preset diffs never cost a mesh round-trip. See spec.py.

Pipeline order (each module is one phase of the plan):
    crown.py     envelope + Poisson-thinned attraction points
    skeleton.py  space colonization, branch orders, pipe-model radii
    bark.py      swept generalized cylinders, RMF frames, analytic UVs
    foliage.py   phyllotactic leaf clusters with spherical normals
    build.py     scene assembly, materials, wind vertex colours, GLB export
    presets.py   tuned species
"""
from .build import coarsen, generate_tree, preview_skeleton
from .presets import PRESETS, build_preset_spec, preset_catalog, preset_names
from .spec import SPEC_VERSION, TreeSpec, parse_spec

__all__ = [
    "SPEC_VERSION",
    "TreeSpec",
    "parse_spec",
    "generate_tree",
    "preview_skeleton",
    "coarsen",
    "PRESETS",
    "build_preset_spec",
    "preset_catalog",
    "preset_names",
    "resolve_spec",
]


def resolve_spec(spec: dict | None = None, preset: str | None = None,
                 seed: int | None = None, overrides: dict | None = None) -> TreeSpec:
    """Turn any of the accepted request shapes into one concrete TreeSpec.

    Callers send either a full spec (the stored asset) or a preset name (the
    picker), optionally with a seed to re-roll and a sparse override patch from
    the slider panel. Resolving all three here keeps the route, the CLI and the
    MCP tool honest about precedence: overrides beat the base, and an explicit
    seed beats both.
    """
    from .presets import _deep_merge

    if preset:
        return build_preset_spec(preset, seed=seed, overrides=overrides)
    if spec:
        merged = _deep_merge(dict(spec), overrides or {})
        if seed is not None:
            merged["seed"] = int(seed)
        return parse_spec(merged)
    return build_preset_spec("oak", seed=seed, overrides=overrides)
