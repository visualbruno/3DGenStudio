"""Render a packed UV atlas to a PNG, in the style of the reference images:
coloured islands with a thin wireframe, on a square canvas with the [0,1] border.
"""
from __future__ import annotations

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection, LineCollection


def _chart_colors(n):
    rng = np.random.default_rng(7)
    cols = []
    for i in range(n):
        h = (i * 0.61803398875) % 1.0
        s = 0.45 + 0.2 * rng.random()
        v = 0.80 + 0.15 * rng.random()
        cols.append(_hsv(h, s, v))
    return cols


def _hsv(h, s, v):
    import colorsys
    return colorsys.hsv_to_rgb(h, s, v)


def render_uv(result, path, size=860, show_stats=True):
    uv = result.uv
    faces = result.faces
    fc = result.face_chart
    n_charts = int(fc.max()) + 1
    colors = _chart_colors(n_charts)

    fig = plt.figure(figsize=(size / 100, size / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(-0.02, 1.02)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_facecolor("#3b3b3b")
    fig.patch.set_facecolor("#3b3b3b")

    # filled triangles coloured per chart
    tri = uv[faces]                                   # (F,3,2)
    poly = PolyCollection(tri, facecolors=[colors[c] for c in fc],
                          edgecolors="none", alpha=0.85, linewidths=0)
    ax.add_collection(poly)

    # wireframe
    segs = []
    for t in tri:
        segs += [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]
    lc = LineCollection(segs, colors="#101010", linewidths=0.35, alpha=0.7)
    ax.add_collection(lc)

    # unit-square border
    ax.add_collection(LineCollection(
        [[(0, 0), (1, 0)], [(1, 0), (1, 1)], [(1, 1), (0, 1)], [(0, 1), (0, 0)]],
        colors="#888888", linewidths=1.0))

    if show_stats:
        s = result.stats
        txt = (f"charts: {s['n_charts']}   faces: {s['n_faces']}\n"
               f"fill: {s['fill_ratio']:.1%}   flips: {s['flipped_triangles']}\n"
               f"angle dist: {s['mean_angle_distortion']:.3f}   "
               f"area dist: {s['mean_area_distortion']:.3f}")
        ax.text(0.015, 0.985, txt, va="top", ha="left", fontsize=9,
                family="monospace", color="#f0f0f0",
                bbox=dict(boxstyle="round,pad=0.4", fc="#000000aa", ec="none"))

    fig.savefig(path, facecolor=fig.get_facecolor())
    plt.close(fig)
    return path
