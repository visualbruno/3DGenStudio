"""Command-line interface for AutoUV.

Examples
--------
    # Unwrap a mesh, write a UV'd GLB next to it and a layout preview PNG
    python -m autouv unwrap Cave_10K.glb -o Cave_uv.glb --preview layout.png

    # Faster, coarser result (skip the validated-merge refinement)
    python -m autouv unwrap model.glb -o out.glb --no-refine

    # Tune island size / distortion trade-off
    python -m autouv unwrap model.glb -o out.glb --cone 60 --island-faces 120
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import load, save_glb, render_uv, __version__
from .unwrap import unwrap


def _add_unwrap_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("input", help="input mesh (.glb/.gltf/.obj/.ply/.stl)")
    p.add_argument("-o", "--output", help="output GLB with the new UV channel")
    p.add_argument("--preview", help="write a UV-layout preview PNG to this path")
    p.add_argument("--cone", type=float, default=55.0, dest="max_cone_deg",
                   help="normal-cone cap in degrees; higher = fewer, more "
                        "distorted charts (default 55)")
    p.add_argument("--island-faces", type=int, default=80,
                   dest="refine_target_faces",
                   help="charts smaller than this are merge candidates in the "
                        "refinement pass; higher = fewer, larger islands "
                        "(default 80)")
    p.add_argument("--no-refine", action="store_false", dest="refine",
                   help="skip the LSCM-validated merge pass (much faster, "
                        "more charts)")
    p.add_argument("--no-weld", action="store_false", dest="weld",
                   help="skip topology repair (proximity vertex weld). Only "
                        "use this if your mesh is already clean and you want "
                        "to preserve its exact vertex set")
    p.add_argument("--weld-tol", type=float, default=0.1, dest="weld_tol_frac",
                   help="weld tolerance as a fraction of the median edge "
                        "length; vertices closer than this are merged "
                        "(default 0.1)")
    p.add_argument("--arap-iters", type=int, default=4, dest="arap_iters",
                   help="as-rigid-as-possible flattening iterations per chart; "
                        "0 disables ARAP (LSCM/planar only). Higher = lower "
                        "area distortion (default 4)")
    p.add_argument("--resolution", type=int, default=1024,
                   help="target texture resolution used for padding (default 1024)")
    p.add_argument("--padding", type=int, default=4, dest="padding_texels",
                   help="inter-island padding in texels (default 4)")
    p.add_argument("--quiet", action="store_true", help="suppress progress output")


def _cmd_unwrap(args: argparse.Namespace) -> int:
    if not args.output and not args.preview:
        print("nothing to do: pass -o/--output and/or --preview", file=sys.stderr)
        return 2

    t0 = time.time()
    mesh = load(args.input)
    if not args.quiet:
        print(f"loaded {args.input}: {mesh.n_faces} faces", file=sys.stderr)

    # lightweight terminal progress bar (no extra deps)
    _bar = {"stage": ""}

    def _progress(stage, frac):
        if args.quiet:
            return
        if stage != _bar["stage"]:
            _bar["stage"] = stage
        n = int(frac * 30)
        sys.stderr.write(
            f"\r  {stage:<13} [{'#' * n}{'.' * (30 - n)}] {frac * 100:3.0f}%")
        sys.stderr.flush()
        if frac >= 1.0 and stage in ("parameterize",):
            sys.stderr.write("\n")

    result = unwrap(
        mesh,
        max_cone_deg=args.max_cone_deg,
        refine=args.refine,
        refine_target_faces=args.refine_target_faces,
        resolution=args.resolution,
        padding_texels=args.padding_texels,
        weld=args.weld,
        weld_tol_frac=args.weld_tol_frac,
        arap_iters=args.arap_iters,
        progress=None if args.quiet else _progress,
        verbose=not args.quiet,
    )

    if args.output:
        save_glb(args.output, result.vertices, result.faces, result.uv)
        if not args.quiet:
            print(f"wrote {args.output}", file=sys.stderr)
    if args.preview:
        render_uv(result, args.preview)
        if not args.quiet:
            print(f"wrote {args.preview}", file=sys.stderr)

    # machine-readable stats on stdout
    print(json.dumps(result.stats, indent=2))
    if not args.quiet:
        print(f"done in {time.time() - t0:.2f}s", file=sys.stderr)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="autouv", description="Automatic UV unwrapping for low-poly meshes.")
    parser.add_argument("--version", action="version",
                        version=f"autouv {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)
    p_unwrap = sub.add_parser("unwrap", help="unwrap a mesh")
    _add_unwrap_args(p_unwrap)
    p_unwrap.set_defaults(func=_cmd_unwrap)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
