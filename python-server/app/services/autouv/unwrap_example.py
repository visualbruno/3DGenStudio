"""Minimal example: unwrap a mesh from a plain Python script.

This is the other half of "one core, two front ends": the exact same
``autouv.unwrap`` that the web server calls, used directly.

    python examples/unwrap_example.py path/to/mesh.glb
"""
import sys

import autouv


def main(path: str) -> None:
    mesh = autouv.load(path)
    print(f"{path}: {mesh.n_faces} faces")

    result = autouv.unwrap(
        mesh,
        max_cone_deg=60,          # curvature cap; higher -> fewer islands
        refine_target_faces=120,   # merge charts smaller than this when it helps
        refine=True,              # LSCM-validated merge (set False for speed)
        padding_texels=1,
        method='auto',
        min_faces=50,
        min_area_frac=0.1,
        refine_ad_thresh=5.0
    )

    s = result.stats
    print(
        f"-> {s['n_charts']} islands, "
        f"{s['flipped_triangles']} flipped triangles, "
        f"angle distortion {s['mean_angle_distortion']:.3f}, "
        f"atlas fill {s['fill_ratio'] * 100:.0f}%"
    )

    autouv.save_glb("unwrapped.glb", result.vertices, result.faces, result.uv)
    autouv.render_uv(result, "uv_layout.png")
    print("wrote unwrapped.glb and uv_layout.png")

    # result.uv is an (n_vertices, 2) array in [0, 1]; result.vertices /
    # result.faces are the (re-indexed, seam-split) geometry that matches it.


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python examples/unwrap_example.py <mesh.glb>")
        raise SystemExit(2)
    main(sys.argv[1])
