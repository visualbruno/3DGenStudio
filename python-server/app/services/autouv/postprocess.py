"""Per-chart post-processing: straighten and normalise texel density.

* PCA-align: rotate each island so its dominant axis is horizontal. Artists do
  this by hand because axis-aligned, roughly-rectangular islands pack tighter
  and make texture painting predictable.
* Texel density: scale every island by a single global factor so that
  ``uv_area / surface_area`` is identical across charts -- no island ends up
  blurrier than its neighbours.
"""
from __future__ import annotations

import numpy as np


def align_island(uv):
    """Rotate UVs so the principal axis is horizontal; return rotated copy."""
    c = uv.mean(axis=0)
    X = uv - c
    if len(X) < 2:
        return uv.copy()
    cov = X.T @ X
    w, V = np.linalg.eigh(cov)
    axis = V[:, np.argmax(w)]           # principal direction
    angle = np.arctan2(axis[1], axis[0])
    ca, sa = np.cos(-angle), np.sin(-angle)
    R = np.array([[ca, -sa], [sa, ca]])
    out = X @ R.T
    # keep islands "wide" (w >= h) for tidy shelf packing
    w_ext = np.ptp(out[:, 0])
    h_ext = np.ptp(out[:, 1])
    if h_ext > w_ext:
        out = out[:, ::-1].copy()
    # move to positive quadrant
    out -= out.min(axis=0)
    return out


def uv_area(uv, faces):
    """True UV area = sum of triangle areas in parameter space."""
    Q = uv[faces]
    a = (Q[:, 1, 0] - Q[:, 0, 0]) * (Q[:, 2, 1] - Q[:, 0, 1]) - \
        (Q[:, 2, 0] - Q[:, 0, 0]) * (Q[:, 1, 1] - Q[:, 0, 1])
    return float(np.abs(a).sum() * 0.5)


def normalize_texel_density(islands, faces_list, areas3d):
    """Scale every island so uv_area / surface_area is the same constant.

    The constant is irrelevant (packing rescales the whole atlas afterwards);
    what matters is that the *ratio* is uniform, i.e. identical texel density.
    """
    out = []
    for uv, faces, a3 in zip(islands, faces_list, areas3d):
        ua = uv_area(uv, faces)
        # want uv_area_new / a3 == 1  ->  scale^2 * ua / a3 == 1
        s = np.sqrt(max(a3, 1e-12) / max(ua, 1e-12))
        scaled = uv * s
        scaled -= scaled.min(axis=0)
        out.append(scaled)
    return out
