"""Command-line interface.

    python -m app.services.treegen --preset oak --seed 7 -o oak.glb
    python -m app.services.treegen --spec my_tree.json -o tree.glb
    python -m app.services.treegen --preset pine --seed 3 --set height=22 --set foliage.max_cards=4000
    python -m app.services.treegen --list
    python -m app.services.treegen --preset oak --dump-spec
    python -m app.services.treegen --all -o out_dir/          # every preset, for eyeballing

Note it is `-m app.services.treegen`, not `-m treegen`: the package lives under
app/services/. autouv and assemblyfit have the same constraint.

This calls the SAME generate_tree() the HTTP route calls, so nothing here is
CLI-only and the two cannot drift.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import resolve_spec
from .build import generate_tree, preview_skeleton
from .presets import preset_names


def _coerce(text: str):
    """Parse a --set value as JSON, falling back to the raw string."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _apply_dotted(target: dict, dotted: str, value) -> None:
    """`--set foliage.max_cards=4000` -> {'foliage': {'max_cards': 4000}}."""
    parts = dotted.split(".")
    node = target
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.services.treegen",
        description="Procedural tree generator (space colonization -> swept bark -> foliage cards).",
    )
    source = parser.add_argument_group("tree source")
    source.add_argument("--preset", help=f"Species preset: {', '.join(preset_names())}")
    source.add_argument("--spec", type=Path, help="Path to a TreeSpec JSON file.")
    source.add_argument("--seed", type=int, help="Override the spec's seed (the re-roll lever).")
    source.add_argument("--set", action="append", default=[], metavar="PATH=VALUE",
                        help="Dotted override, repeatable. e.g. --set crown.radius_ratio=0.6")

    output = parser.add_argument_group("output")
    output.add_argument("-o", "--out", type=Path, help="Output .glb path (or a directory with --all).")
    output.add_argument("--bark-texture", type=Path, help="PNG used as the bark base colour (tileable).")
    output.add_argument("--leaf-atlas", type=Path, help="PNG leaf atlas with alpha.")
    output.add_argument("--dump-spec", action="store_true", help="Print the resolved spec JSON and exit.")
    output.add_argument("--preview", action="store_true",
                        help="Run the skeleton-only preview path and print its stats.")
    output.add_argument("--stats", action="store_true", help="Print the generation stats JSON.")

    parser.add_argument("--list", action="store_true", help="List the available presets and exit.")
    parser.add_argument("--verify", action="store_true",
                        help="Run the golden-seed / invariant / determinism / budget checks.")
    parser.add_argument("--update-golden", action="store_true",
                        help="Print refreshed golden values instead of asserting them.")
    parser.add_argument("--all", action="store_true",
                        help="Generate every preset into the -o directory (a contact sheet for eyeballing).")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.list:
        for name in preset_names():
            print(name)
        return 0

    if args.verify or args.update_golden:
        from .verify import run as run_verify

        targets = [args.preset] if args.preset else None
        result, updated = run_verify(targets, update_golden=args.update_golden)
        if args.update_golden:
            print(json.dumps(updated, indent=2))
            return 0
        for line in result.notes:
            print(line)
        print(f"\n{result.passed} checks passed, {len(result.failed)} failed")
        for failure in result.failed:
            print(f"  FAIL  {failure}")
        return 0 if result.ok else 1

    overrides: dict = {}
    for assignment in args.set:
        if "=" not in assignment:
            print(f"--set expects PATH=VALUE, got {assignment!r}", file=sys.stderr)
            return 2
        path, _, raw = assignment.partition("=")
        _apply_dotted(overrides, path.strip(), _coerce(raw.strip()))

    if args.all:
        if not args.out:
            print("--all needs -o pointing at a directory.", file=sys.stderr)
            return 2
        args.out.mkdir(parents=True, exist_ok=True)
        for name in preset_names():
            spec = resolve_spec(preset=name, seed=args.seed, overrides=overrides)
            result = generate_tree(spec)
            target = args.out / f"{name}.glb"
            target.write_bytes(result["glb"])
            totals = result["stats"]["totals"]
            print(f"{name:10s} {totals['faces']:7d} tris  {result['stats']['seconds']:5.2f}s  -> {target}")
        return 0

    spec_data = None
    if args.spec:
        spec_data = json.loads(args.spec.read_text(encoding="utf-8"))
    spec = resolve_spec(spec=spec_data, preset=args.preset, seed=args.seed, overrides=overrides)

    if args.dump_spec:
        print(json.dumps(spec.model_dump(mode="json"), indent=2))
        return 0

    if args.preview:
        print(json.dumps(preview_skeleton(spec)["stats"], indent=2))
        return 0

    bark = args.bark_texture.read_bytes() if args.bark_texture else None
    atlas = args.leaf_atlas.read_bytes() if args.leaf_atlas else None

    def report(stage, frac, message):
        print(f"  [{frac * 100:5.1f}%] {stage:9s} {message}", file=sys.stderr)

    result = generate_tree(spec, bark_texture=bark, leaf_atlas=atlas, on_progress=report)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(result["glb"])
        print(f"Wrote {args.out} ({len(result['glb']) / 1024:.0f} KB)")
    if args.stats or not args.out:
        print(json.dumps(result["stats"], indent=2))
    return 0
