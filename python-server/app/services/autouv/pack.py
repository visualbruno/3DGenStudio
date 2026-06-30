"""Atlas packing.

A *skyline* (bottom-left) bin packer. Each island is reduced to its (padded)
bounding box; boxes are placed tallest-first at the lowest, left-most spot the
skyline allows, optionally rotated 90 degrees when that wastes less vertical
space. This packs the irregular islands that come out of a low-poly unwrap far
more tightly than fixed shelves (typically 80-90% bbox coverage vs ~60% for
shelves), which matters because wasted atlas space is wasted texture memory.

Everything is finally scaled by a single global factor into the unit square, so
the uniform texel density set in :mod:`postprocess` is preserved.

Padding is expressed in texels for a target resolution -- this is what prevents
mip/bilinear bleed between islands at low texture resolutions.
"""
from __future__ import annotations

import numpy as np


def _skyline_pack(boxes, bin_w):
    """Place [w, h] boxes (already padded). Returns placements, used_w, used_h.

    placements[i] = (x, y, rotated). Skyline = list of [x, top_y, width].
    """
    skyline = [[0.0, 0.0, bin_w]]
    placements = {}

    def level_for(start, w):
        """Lowest y at which a span of width w starting at segment ``start`` fits."""
        x0 = skyline[start][0]
        if x0 + w > bin_w + 1e-9:
            return None
        rem, y, i = w, 0.0, start
        while rem > 1e-12:
            if i >= len(skyline):
                return None
            y = max(y, skyline[i][1])
            rem -= skyline[i][2]
            i += 1
        return y

    def add_at(x, y, w, h):
        """Insert a box of width w at x and raise the skyline to y + h."""
        new_top = y + h
        out = []
        placed = False
        x_end = x + w
        for seg in skyline:
            sx, sy, sw = seg
            sx_end = sx + sw
            if sx_end <= x + 1e-12 or sx >= x_end - 1e-12:
                out.append(seg)                      # untouched
                continue
            # trim left remainder
            if sx < x - 1e-12:
                out.append([sx, sy, x - sx])
            if not placed:
                out.append([x, new_top, w])
                placed = True
            # trim right remainder
            if sx_end > x_end + 1e-12:
                out.append([x_end, sy, sx_end - x_end])
        # merge adjacent segments at equal height
        merged = [out[0]]
        for seg in out[1:]:
            if abs(seg[1] - merged[-1][1]) < 1e-12:
                merged[-1][2] += seg[2]
            else:
                merged.append(seg)
        skyline[:] = merged

    order = sorted(range(len(boxes)), key=lambda b: (-boxes[b][2], -boxes[b][1]))
    used_w = used_h = 0.0
    for bi in order:
        _, w, h, _ = boxes[bi]
        best = None  # (top_y, x, rotated, w, h)
        for rot, (cw, ch) in enumerate(((w, h), (h, w))):
            for start in range(len(skyline)):
                x = skyline[start][0]
                y = level_for(start, cw)
                if y is None:
                    continue
                key = (y + ch, x)
                if best is None or key < (best[0], best[1]):
                    best = (y + ch, x, rot, cw, ch, y)
        if best is None:                              # forced overflow (rare)
            x, y = 0.0, max((s[1] for s in skyline), default=0.0)
            cw, ch, rot = w, h, 0
            add_at(x, y, cw, ch)
        else:
            _, x, rot, cw, ch, y = best
            add_at(x, y, cw, ch)
        placements[bi] = (x, y, bool(rot))
        used_w = max(used_w, x + cw)
        used_h = max(used_h, y + ch)
    return placements, used_w, used_h


def pack(islands, resolution=1024, padding_texels=4):
    """Pack a list of (V,2) islands into ``[0,1]^2``.

    Returns ``(packed_islands, fill_ratio)`` where ``fill_ratio`` is the share of
    the unit square covered by island bounding boxes.
    """
    pad = padding_texels / float(resolution)

    boxes = []
    for i, uv in enumerate(islands):
        mn = uv.min(axis=0)
        ext = uv.max(axis=0) - mn
        boxes.append([i, float(ext[0]) + pad, float(ext[1]) + pad, mn])

    total_area = sum(b[1] * b[2] for b in boxes)
    # aim a bit denser than square; skyline usually realises ~85%
    bin_w = np.sqrt(total_area / 0.85)
    # never make the bin narrower than the widest single box
    bin_w = max(bin_w, max(b[1] for b in boxes))

    placements, used_w, used_h = _skyline_pack(boxes, bin_w)
    scale = 1.0 / max(used_w, used_h, 1e-9)

    packed = [None] * len(islands)
    used = 0.0
    for bi in range(len(islands)):
        i, w, h, mn = boxes[bi]
        ox, oy, rot = placements[bi]
        uv = islands[bi] - mn
        if rot:                                    # rotate 90 degrees
            uv = np.column_stack((uv[:, 1], (w - pad) - uv[:, 0]))
        uv = uv * scale
        uv[:, 0] += (ox + pad * 0.5) * scale
        uv[:, 1] += (oy + pad * 0.5) * scale
        packed[bi] = uv
        used += ((w - pad) * scale) * ((h - pad) * scale)

    return packed, float(used)
