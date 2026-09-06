"""Phase 8 -- tuned species presets.

Presets are what make the generator feel finished. Space colonization has ~25
meaningful parameters and raw sliders over them read as a tech demo: the user
gets a plausible tree only by accident. A preset carries that complexity so the
default interaction loop is "pick a species, re-roll the seed", with the sliders
there for the people who want them.

Each entry is a sparse override of TreeSpec defaults -- only what actually
differs from a generic deciduous tree, so a change to a default propagates.
They are plain dicts on purpose: this is exactly the JSON a user forks into
their own preset asset.
"""
from __future__ import annotations

import copy

from .spec import TreeSpec

PRESETS: dict[str, dict] = {
    "oak": {
        "name": "Oak",
        "height": 9.0,
        "crown": {"shape": "ellipsoid", "radius_ratio": 0.46, "base_ratio": 0.30, "shell_bias": 0.25},
        "skeleton": {"attractors": 4000, "step_ratio": 0.034, "randomness": 0.16, "tropism": (0.0, 0.16, 0.0),
                     "trunk_wobble": 0.07},
        "branching": {"trunk_radius_ratio": 0.026, "radius_exponent": 2.3, "root_flare": 0.8},
        "foliage": {"size_ratio": 0.030, "aspect": 1.1, "max_cards": 7000, "droop_deg": 18.0},
    },
    "pine": {
        "name": "Pine",
        "height": 14.0,
        # A conifer is its silhouette. The cone envelope does most of the work;
        # the downward tropism gives the branches their characteristic droop
        # while the trunk still runs straight to the top.
        "crown": {"shape": "cone", "radius_ratio": 0.22, "base_ratio": 0.12},
        "skeleton": {"attractors": 5000, "step_ratio": 0.045, "attraction_ratio": 0.55,
                     "randomness": 0.06, "tropism": (0.0, -0.10, 0.0), "trunk_wobble": 0.02},
        "branching": {"trunk_radius_ratio": 0.014, "radius_exponent": 2.6, "root_flare": 0.5,
                      "max_order": 5},
        "foliage": {"size_ratio": 0.020, "aspect": 2.4, "align_ratio": 0.45, "cluster_cards": 5,
                    "max_cards": 12000, "droop_deg": 35.0, "spacing_ratio": 0.016, "min_order": 1},
    },
    "birch": {
        "name": "Birch",
        "height": 12.0,
        "crown": {"shape": "ellipsoid", "radius_ratio": 0.26, "base_ratio": 0.38, "shell_bias": 0.3},
        "skeleton": {"attractors": 3000, "step_ratio": 0.040, "randomness": 0.13,
                     "tropism": (0.0, 0.05, 0.0), "trunk_wobble": 0.04},
        "branching": {"trunk_radius_ratio": 0.011, "radius_exponent": 2.0, "root_flare": 0.25},
        "foliage": {"size_ratio": 0.018, "aspect": 1.0, "max_cards": 6000, "droop_deg": 40.0,
                    "spacing_ratio": 0.022},
    },
    "palm": {
        "name": "Palm",
        "height": 11.0,
        # The umbrella shell is the whole trick: fill the crown as a volume and
        # a palm comes out as a bush on a stick.
        "crown": {"shape": "umbrella", "radius_ratio": 0.34, "base_ratio": 0.74, "shell_thickness": 0.22},
        "skeleton": {"attractors": 900, "step_ratio": 0.070, "attraction_ratio": 0.8,
                     "randomness": 0.05, "tropism": (0.0, -0.20, 0.0), "trunk_wobble": 0.06,
                     "smoothing": 4},
        "branching": {"trunk_radius_ratio": 0.014, "radius_exponent": 3.0, "root_flare": 0.35,
                      "max_order": 2},
        "foliage": {"size_ratio": 0.055, "aspect": 6.0, "align_ratio": 0.9, "cluster_cards": 2,
                    "cluster_spread": 0.12, "max_cards": 900, "droop_deg": 12.0,
                    "spacing_ratio": 0.130, "min_order": 1, "tilt_jitter_deg": 10.0},
    },
    "willow": {
        "name": "Weeping Willow",
        "height": 10.0,
        # Negative tropism is the entire species: branches that reach downward
        # instead of for the light.
        "crown": {"shape": "hemisphere", "radius_ratio": 0.52, "base_ratio": 0.34},
        "skeleton": {"attractors": 4500, "step_ratio": 0.032, "randomness": 0.10,
                     "tropism": (0.0, -0.55, 0.0), "smoothing": 4},
        "branching": {"trunk_radius_ratio": 0.024, "radius_exponent": 2.1, "root_flare": 0.7},
        "foliage": {"size_ratio": 0.020, "aspect": 2.6, "max_cards": 9000, "droop_deg": 62.0,
                    "spacing_ratio": 0.020, "tilt_jitter_deg": 15.0},
    },
    "dead": {
        "name": "Dead Tree",
        "height": 8.0,
        "crown": {"shape": "inverted_cone", "radius_ratio": 0.40, "base_ratio": 0.26},
        "skeleton": {"attractors": 1800, "step_ratio": 0.055, "randomness": 0.30,
                     "tropism": (0.0, 0.10, 0.0), "trunk_wobble": 0.14, "smoothing": 1},
        "branching": {"trunk_radius_ratio": 0.024, "radius_exponent": 2.5, "root_flare": 1.0,
                      "max_order": 5},
        "foliage": {"enabled": False},
    },
    "bonsai": {
        "name": "Bonsai",
        "height": 0.55,
        "crown": {"shape": "hemisphere", "radius_ratio": 0.62, "base_ratio": 0.34,
                  "offset_x": 0.10, "shell_bias": 0.5},
        "skeleton": {"attractors": 1400, "step_ratio": 0.050, "randomness": 0.32,
                     "tropism": (0.06, 0.05, 0.0), "trunk_wobble": 0.22, "trunk_lean": (0.30, 0.0),
                     "smoothing": 4},
        "branching": {"trunk_radius_ratio": 0.075, "radius_exponent": 2.7, "root_flare": 1.4,
                      "root_flare_ratio": 0.12},
        "foliage": {"size_ratio": 0.055, "cluster_cards": 5, "max_cards": 2500, "droop_deg": 8.0,
                    "spacing_ratio": 0.048, "min_order": 1},
    },
    "bush": {
        "name": "Bush",
        "height": 1.4,
        # base_ratio 0 = no clear trunk: the crown starts at the ground and the
        # colonization branches from the very first node.
        "crown": {"shape": "hemisphere", "radius_ratio": 0.75, "base_ratio": 0.02, "shell_bias": 0.35},
        "skeleton": {"attractors": 2200, "step_ratio": 0.055, "randomness": 0.20,
                     "tropism": (0.0, 0.20, 0.0), "trunk_wobble": 0.0},
        "branching": {"trunk_radius_ratio": 0.030, "radius_exponent": 2.0, "root_flare": 0.3,
                      "max_order": 6},
        "foliage": {"size_ratio": 0.070, "max_cards": 5000, "spacing_ratio": 0.055, "min_order": 1},
    },
    "sapling": {
        "name": "Sapling",
        "height": 1.8,
        "crown": {"shape": "ellipsoid", "radius_ratio": 0.36, "base_ratio": 0.28},
        "skeleton": {"attractors": 500, "step_ratio": 0.070, "randomness": 0.14,
                     "tropism": (0.0, 0.28, 0.0), "trunk_wobble": 0.05},
        "branching": {"trunk_radius_ratio": 0.020, "radius_exponent": 2.0, "root_flare": 0.2,
                      "max_order": 4},
        "foliage": {"size_ratio": 0.105, "cluster_cards": 3, "max_cards": 800,
                    "spacing_ratio": 0.090, "min_order": 1},
    },
    "poplar": {
        "name": "Lombardy Poplar",
        "height": 16.0,
        "crown": {"shape": "cylinder", "radius_ratio": 0.13, "base_ratio": 0.10},
        "skeleton": {"attractors": 4000, "step_ratio": 0.075, "attraction_ratio": 0.9,
                     "randomness": 0.08, "tropism": (0.0, 0.85, 0.0), "trunk_wobble": 0.02},
        "branching": {"trunk_radius_ratio": 0.013, "radius_exponent": 2.2, "root_flare": 0.4},
        "foliage": {"size_ratio": 0.016, "max_cards": 9000, "spacing_ratio": 0.018, "droop_deg": 12.0},
    },
}

PRESET_ORDER = ["oak", "pine", "birch", "poplar", "willow", "palm", "bush", "bonsai", "sapling", "dead"]


def preset_names() -> list[str]:
    return [name for name in PRESET_ORDER if name in PRESETS]


def _deep_merge(base: dict, override: dict) -> dict:
    """Merge nested override dicts without dropping sibling keys."""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def build_preset_spec(name: str, seed: int | None = None, overrides: dict | None = None) -> TreeSpec:
    """Resolve a preset name (plus optional seed / overrides) into a full TreeSpec."""
    key = (name or "").strip().lower()
    if key not in PRESETS:
        raise ValueError(f"Unknown tree preset '{name}'. Available: {', '.join(preset_names())}")

    data = _deep_merge(PRESETS[key], overrides or {})
    data["preset"] = key
    if seed is not None:
        data["seed"] = int(seed)
    return TreeSpec(**data)


def preset_catalog() -> list[dict]:
    """Preset metadata for the UI picker -- name, label and the headline params."""
    catalog = []
    for key in preset_names():
        spec = build_preset_spec(key)
        catalog.append({
            "id": key,
            "label": spec.name,
            "height": spec.height,
            "crown": spec.crown.shape,
            "foliage": spec.foliage.enabled,
            "spec": spec.model_dump(mode="json"),
        })
    return catalog
