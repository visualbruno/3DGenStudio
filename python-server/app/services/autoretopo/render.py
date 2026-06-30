"""Dependency-light software renderer: z-buffered flat shading + wireframe overlay.
Pure numpy + scikit-image line drawing. Works headless (no OpenGL)."""
import numpy as np
from skimage.draw import line_aa


def _look_at(cam, target, up=(0, 1, 0)):
    f = target - cam
    f = f / (np.linalg.norm(f) + 1e-12)
    up = np.asarray(up, float)
    r = np.cross(f, up); r /= (np.linalg.norm(r) + 1e-12)
    u = np.cross(r, f)
    R = np.stack([r, u, -f], axis=0)
    return R


def render_mesh(verts, faces, azim=35.0, elev=20.0, res=900, zoom=1.0,
                mode="shaded", bg=1.0, line_color=(0.10, 0.10, 0.12),
                face_color=(0.62, 0.66, 0.72), light_dir=(0.3, 0.6, 0.7)):
    """Render a triangle mesh. mode in {'shaded','wire','shaded_wire'}.
    Returns HxWx3 float image in [0,1]."""
    V = np.asarray(verts, float).copy()
    F = np.asarray(faces, int)
    c = 0.5 * (V.min(0) + V.max(0))
    V -= c
    radius = np.linalg.norm(V, axis=1).max() + 1e-9

    a, e = np.radians(azim), np.radians(elev)
    cam_dir = np.array([np.cos(e) * np.sin(a), np.sin(e), np.cos(e) * np.cos(a)])
    cam = cam_dir * radius * 3.0
    R = _look_at(cam, np.zeros(3))
    Vc = (V - cam) @ R.T                      # camera space (-z forward)
    z = -Vc[:, 2]
    fov_scale = (res * 0.5 * zoom) * (3.0)    # orth-ish framing scaled to radius
    s = fov_scale / radius
    xs = Vc[:, 0] * s / (z / (radius * 3.0))  # mild perspective
    ys = Vc[:, 1] * s / (z / (radius * 3.0))
    px = (res * 0.5 + xs)
    py = (res * 0.5 - ys)

    img = np.ones((res, res, 3), float) * bg
    zbuf = np.full((res, res), np.inf)

    # face depth + normals (camera space) for shading & back-face cull
    p0, p1, p2 = Vc[F[:, 0]], Vc[F[:, 1]], Vc[F[:, 2]]
    n = np.cross(p1 - p0, p2 - p0)
    nlen = np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    n = n / nlen
    L = np.asarray(light_dir, float); L /= np.linalg.norm(L)
    shade = np.clip(np.abs(n @ L), 0.0, 1.0) * 0.75 + 0.25
    fc = np.asarray(face_color, float)

    fz = z[F].mean(1)
    order = np.argsort(-fz)  # far to near (painter) for fill

    sx, sy = px[F], py[F]    # (nf,3)

    if mode in ("shaded", "shaded_wire"):
        # scanline-ish: rasterize each triangle with a bounding-box test (vectorized per-tri)
        for fi in order:
            x0, x1, x2 = sx[fi]; y0, y1, y2 = sy[fi]
            minx = int(max(0, np.floor(min(x0, x1, x2)))); maxx = int(min(res - 1, np.ceil(max(x0, x1, x2))))
            miny = int(max(0, np.floor(min(y0, y1, y2)))); maxy = int(min(res - 1, np.ceil(max(y0, y1, y2))))
            if minx > maxx or miny > maxy:
                continue
            xx, yy = np.meshgrid(np.arange(minx, maxx + 1), np.arange(miny, maxy + 1))
            d = ((y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2))
            if abs(d) < 1e-9:
                continue
            wa = ((y1 - y2) * (xx - x2) + (x2 - x1) * (yy - y2)) / d
            wb = ((y2 - y0) * (xx - x2) + (x0 - x2) * (yy - y2)) / d
            wc = 1 - wa - wb
            inside = (wa >= -1e-4) & (wb >= -1e-4) & (wc >= -1e-4)
            if not inside.any():
                continue
            yI, xI = yy[inside], xx[inside]
            zval = float(fz[fi])
            better = zval < zbuf[yI, xI]
            yb, xb = yI[better], xI[better]
            zbuf[yb, xb] = zval
            img[yb, xb] = fc * shade[fi]

    if mode in ("wire", "shaded_wire"):
        # draw front-facing edges; in pure-wire mode keep bg
        ec = np.asarray(line_color, float)
        camN = -Vc[F].mean(1)
        front = (n * (camN / (np.linalg.norm(camN, axis=1, keepdims=True) + 1e-12))).sum(1) > -0.15
        alpha_base = 0.9 if mode == "wire" else 0.55
        seen = set()
        for fi in np.argsort(fz):  # near to far so near edges drawn last (on top)
            if not front[fi]:
                continue
            tri = F[fi]
            for a_, b_ in ((0, 1), (1, 2), (2, 0)):
                ia, ib = tri[a_], tri[b_]
                key = (ia, ib) if ia < ib else (ib, ia)
                if key in seen:
                    continue
                seen.add(key)
                rr, cc_, val = line_aa(int(py[ia]), int(px[ia]), int(py[ib]), int(px[ib]))
                ok = (rr >= 0) & (rr < res) & (cc_ >= 0) & (cc_ < res)
                rr, cc_, val = rr[ok], cc_[ok], val[ok]
                al = (val * alpha_base)[:, None]
                img[rr, cc_] = img[rr, cc_] * (1 - al) + ec * al
    return np.clip(img, 0, 1)


def panel(views, labels, path, ncols=None, title=None, pad=10, label_h=34):
    """Stack a grid of rendered images with labels into one PNG."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    n = len(views)
    ncols = ncols or n
    nrows = int(np.ceil(n / ncols))
    fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 3.6, nrows * 3.8))
    axes = np.atleast_1d(axes).ravel()
    for i, ax in enumerate(axes):
        if i < n:
            ax.imshow(views[i]); ax.set_title(labels[i], fontsize=11)
        ax.axis("off")
    if title:
        fig.suptitle(title, fontsize=14, fontweight="bold")
    fig.tight_layout()
    fig.savefig(path, dpi=110, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path
