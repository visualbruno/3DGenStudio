"""Command-line interface.

    python -m autoretopo input.glb -o out.glb --faces 6000
    python -m autoretopo in.glb -o out.glb --faces 4000 --no-watertight --quads
    python -m autoretopo in.glb -o out.glb --compare compare.png   # render a comparison
"""
from __future__ import annotations
import argparse, json, sys
import numpy as np

from .config import RetopoConfig
from .pipeline import AutoRetopo


def build_parser():
    p = argparse.ArgumentParser(
        "autoretopo", description="Automatic retopology for low-poly meshes.")
    p.add_argument("input", help="input mesh (glb/gltf/obj/ply/stl)")
    p.add_argument("-o", "--output", default="retopo.glb", help="output mesh path")
    p.add_argument("--faces", type=int, default=6000, help="target face budget")
    p.add_argument("--shell-res", type=int, default=256, help="voxel grid resolution")
    p.add_argument("--shell-smooth", type=float, default=0.6, help="occupancy blur sigma")
    p.add_argument("--max-memory", type=float, default=4.0,
                   help="GB budget; auto-lowers shell resolution to fit (0 disables)")
    p.add_argument("--no-watertight", action="store_true",
                   help="remesh the surface directly (keeps open boundaries)")
    p.add_argument("--no-adaptive", action="store_true", help="uniform density")
    p.add_argument("--no-project", action="store_true", help="skip silhouette projection")
    p.add_argument("--clamp", type=float, default=1.5, help="projection move clamp (x edge length)")
    p.add_argument("--quads", action="store_true", help="convert to quad-dominant")
    p.add_argument("--compare", metavar="PNG", help="write a wireframe/shaded comparison image")
    p.add_argument("--metrics", metavar="JSON", help="write metrics to a JSON file")
    p.add_argument("-q", "--quiet", action="store_true")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    cfg = RetopoConfig(
        target_faces=args.faces, shell_resolution=args.shell_res,
        shell_smooth=args.shell_smooth, watertight=not args.no_watertight,
        adaptive=not args.no_adaptive, project=not args.no_project,
        project_clamp=args.clamp, quads=args.quads, max_memory_gb=args.max_memory,
        verbose=not args.quiet)

    result = AutoRetopo(cfg).run(args.input)
    result.export(args.output)
    if not args.quiet:
        print(f"\nwrote {args.output}")

    if args.compare:
        from . import render
        o, r = result.original, result.mesh
        Vo, Fo = np.asarray(o.vertices), np.asarray(o.faces)
        Vr, Fr = np.asarray(r.vertices), np.asarray(r.faces)
        imgs = [render.render_mesh(Vo, Fo, mode="wire", zoom=0.8),
                render.render_mesh(Vr, Fr, mode="wire", zoom=0.8),
                render.render_mesh(Vo, Fo, mode="shaded", zoom=0.8),
                render.render_mesh(Vr, Fr, mode="shaded", zoom=0.8)]
        render.panel(imgs, [f"input ({len(Fo)})", f"retopo ({len(Fr)})",
                            "input shaded", "retopo shaded"],
                     args.compare, ncols=2, title="Auto-Retopo comparison")
        if not args.quiet:
            print(f"wrote {args.compare}")

    if args.metrics:
        with open(args.metrics, "w") as f:
            json.dump({"metrics": result.metrics, "timings": result.timings,
                       "config": result.config}, f, indent=2)
    if not args.quiet:
        print(json.dumps(result.metrics, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
