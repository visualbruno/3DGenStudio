"""Command-line interface.

    python -m app.services.assemblyfit body.glb armor.glb -o fitted.glb
    python -m app.services.assemblyfit body.glb armor.glb --stages penetration
    python -m app.services.assemblyfit body.glb armor.glb --stages rigid,penetration
    python -m app.services.assemblyfit --synthetic sphere_shell --report

Note it is `-m app.services.assemblyfit`, not `-m assemblyfit`: the package
lives under app/services/. autoretopo's CLI has the same constraint.

This calls the SAME fit_assembly() the HTTP route calls, so nothing here is
CLI-only and the two cannot drift.
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import trimesh

from .config import FitConfig
from .pipeline import fit_assembly

# ---------------------------------------------------------------------------
# Synthetic cases
# ---------------------------------------------------------------------------
# Self-verifying fixtures, so the algorithm can be checked without hunting for
# an AI mesh and eyeballing the result. These live here rather than in a scratch
# script because they are the regression suite for every change to conform().


def _synthetic(name):
    if name == 'sphere_shell':
        # A garment that is too big AND intersecting: a sphere of radius 1.3
        # around a body of radius 1. Shrinkwrap should bring every vertex to
        # radius 1 + offset, which is exactly measurable.
        body = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        piece = trimesh.creation.icosphere(subdivisions=4, radius=1.3)
        return body, piece, 'sphere radius 1.3 onto radius 1.0'

    if name == 'sphere_inside':
        # Entirely INSIDE the body: penetration push must move every vertex out.
        body = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        piece = trimesh.creation.icosphere(subdivisions=3, radius=0.6)
        return body, piece, 'sphere radius 0.6 inside radius 1.0'

    if name == 'half_penetrating':
        # Half in, half out — the case that separates the two scopes. A box
        # straddling the body's surface: penetration should move only the
        # submerged half, shrinkwrap should move everything.
        body = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        piece = trimesh.creation.box(extents=(0.6, 0.6, 0.6))
        piece.apply_translation((0.9, 0.0, 0.0))
        return body, piece, 'box straddling the surface'

    if name == 'far_away':
        # Beyond max_distance: must be left completely alone, which is what
        # stops a cape hem or a helmet plume being sucked onto the torso.
        body = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
        piece = trimesh.creation.box(extents=(0.2, 0.2, 0.2))
        piece.apply_translation((6.0, 0.0, 0.0))
        return body, piece, 'piece far from the body'

    raise SystemExit(f'unknown synthetic case: {name}')


def build_parser():
    parser = argparse.ArgumentParser(
        'assemblyfit', description='Fit a garment mesh onto a body mesh.')
    parser.add_argument('body', nargs='?', help='the base/body mesh (glb/gltf/obj/ply/stl)')
    parser.add_argument('piece', nargs='?', help='the garment mesh to fit')
    parser.add_argument('-o', '--output', help='write the fitted piece here')
    parser.add_argument('--synthetic', metavar='CASE',
                        choices=['sphere_shell', 'sphere_inside', 'half_penetrating', 'far_away'],
                        help='use a built-in self-verifying case instead of files')
    parser.add_argument('--stages', default='shrinkwrap,penetration',
                        # 'rigid' seats the piece without deforming it (rigid.py);
                        # 'warp' bends it onto landmark pairs (warp.py).
                        help='comma-separated: rigid, warp, shrinkwrap, penetration')
    parser.add_argument('--landmarks', metavar='JSON',
                        help='landmark pairs for the warp stage: a JSON list of '
                             '{"piece": [x,y,z], "body": [x,y,z]} in world space')
    parser.add_argument('--offset', type=float, default=0.004,
                        help='clearance to leave between piece and body')
    parser.add_argument('--iters', type=int, default=8, help='iterations per stage')
    parser.add_argument('--smooth', type=int, default=3,
                        help='Laplacian rounds applied to the displacement field')
    parser.add_argument('--step-clamp', type=float, default=0.5,
                        help='per-iteration move limit, in local edge lengths')
    parser.add_argument('--max-distance-ratio', type=float, default=0.25,
                        help='ignore vertices further than this x the body diagonal (0 = no limit)')
    parser.add_argument('--body-faces', type=int, default=60000,
                        help='decimate the proximity target to this many faces (0 = off)')
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu'])
    parser.add_argument('--warp-smoothing', type=float, default=0.0,
                        help='0 passes the spline exactly through every landmark')
    parser.add_argument('--warp-max-amplification', type=float, default=2.0,
                        help='cap on warp displacement, x the furthest a pair asked for')
    parser.add_argument('--warp-max-move-ratio', type=float, default=0.15,
                        help="cap on warp displacement, x the PIECE's own diagonal")
    parser.add_argument('--warp-clamp-abort-frac', type=float, default=0.25,
                        help='refuse the warp once this share of the piece is clamped')
    parser.add_argument('--stats', metavar='JSON', help='write the stats dict here')
    parser.add_argument('--verify', action='store_true',
                        help='run the self-verifying property checks (see verify.py)')
    parser.add_argument('--report', action='store_true',
                        help='print the penetration/flip report -- the numbers that say if it worked')
    parser.add_argument('-q', '--quiet', action='store_true')
    return parser


def _load(path):
    loaded = trimesh.load(path, process=False)
    if isinstance(loaded, trimesh.Scene):
        loaded = trimesh.util.concatenate(tuple(loaded.geometry.values()))
    if not isinstance(loaded, trimesh.Trimesh):
        raise SystemExit(f'{path} did not resolve to a triangle mesh')
    return loaded


def _load_landmarks(path):
    """Landmark pairs from a JSON file, for driving the warp headlessly.

    Same shape the HTTP route takes, so a case reproduced from the browser can
    be replayed here without translation.
    """
    if not path:
        return ()
    with open(path, 'r', encoding='utf-8') as handle:
        raw = json.load(handle)
    pairs = []
    for entry in raw:
        pairs.append({'piece': [float(v) for v in entry['piece']],
                      'body': [float(v) for v in entry['body']]})
    return tuple(pairs)


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.verify:
        from .verify import run_all
        print('assemblyfit property checks')
        return 1 if run_all() else 0

    if args.synthetic:
        body, piece, description = _synthetic(args.synthetic)
        if not args.quiet:
            print(f'synthetic: {description}')
    elif args.body and args.piece:
        body, piece = _load(args.body), _load(args.piece)
        description = f'{args.piece} onto {args.body}'
    else:
        raise SystemExit('give BODY and PIECE, or --synthetic CASE')

    config = FitConfig(
        stages=tuple(s.strip() for s in args.stages.split(',') if s.strip()),
        landmarks=_load_landmarks(args.landmarks),
        warp_smoothing=args.warp_smoothing,
        warp_max_amplification=args.warp_max_amplification,
        warp_max_move_ratio=args.warp_max_move_ratio,
        warp_clamp_abort_frac=args.warp_clamp_abort_frac,
        offset=args.offset,
        iterations=args.iters,
        smooth_rounds=args.smooth,
        step_clamp=args.step_clamp,
        max_distance_ratio=args.max_distance_ratio or None,
        body_face_budget=args.body_faces,
        device=args.device,
        verbose=not args.quiet,
    )

    def show(stage, fraction, message):
        if not args.quiet:
            print(f'\r  [{fraction * 100:5.1f}%] {message:<34}', end='', flush=True)

    positions, stats = fit_assembly(piece, body, config, progress=show)
    if not args.quiet:
        print()

    # The contract the client depends on. Asserted here so a regression shows up
    # in the harness rather than as scrambled UVs in the browser.
    assert len(positions) == len(piece.vertices), 'vertex count changed'

    if args.output:
        fitted = trimesh.Trimesh(positions, piece.faces, process=False)
        fitted.export(args.output)
        if not args.quiet:
            print(f'wrote {args.output}')

    if args.stats:
        with open(args.stats, 'w') as handle:
            json.dump(stats, handle, indent=2, default=float)

    if args.report:
        print('\n--- fit report ---')
        print(f"body watertight        : {stats['body_watertight']}"
              f"{'  (inside/outside is approximate)' if not stats['body_watertight'] else ''}")
        print(f"piece vertices         : {stats['piece_vertices']}")
        print(f"proximity target faces : {stats['target_faces']} (of {stats['body_faces']})")
        print(f"penetrating vertices   : {stats['penetrating_before']} -> {stats['penetrating_after']}")
        print(f"max depth              : {stats['max_depth_before']:.5f} -> {stats['max_depth_after']:.5f}")
        # A rigid-only run has no deform stage and therefore no face_count, so
        # this must not index blindly into the last stage's stats.
        deform = [name for name in config.stages if name != 'rigid']
        face_count = stats['stages'][deform[-1]].get('face_count', '?') if deform else '?'
        print(f"flipped faces          : {stats['flipped_faces']} of {face_count}")
        seating = stats['stages'].get('rigid')
        if seating:
            print(f"seating                : scale {seating['scale']:.3f}, "
                  f"rotation {seating['rotation_deg']:.1f} deg, "
                  f"{seating['pairs_kept']}/{seating['pairs_total']} pairs"
                  f"{', kept the original placement' if seating['kept_identity'] else ''}"
                  f"{', size change capped' if seating.get('scale_clamped') else ''}")
        print(f"max vertex move        : {stats['max_move']:.5f}")
        for stage, seconds in stats['timings'].items():
            print(f"  {stage:<20} {seconds:.2f}s")

    if not args.quiet and not args.report:
        print(json.dumps({k: v for k, v in stats.items() if k != 'stages'},
                         indent=2, default=float))
    return 0


if __name__ == '__main__':
    sys.exit(main())
