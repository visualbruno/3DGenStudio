"""Texture handling: leaf-atlas composition and material image decoding.

The generator asks for a leaf *atlas* -- one image holding a grid of leaf cutouts
that cards index into at random. That is the right thing for the renderer and the
wrong thing to ask a person for, because nobody has an atlas lying around; they
have a handful of leaf PNGs. So this module builds the atlas from a list of
images, picks the grid, and reports the dimensions back so the spec's
`atlas_cols`/`atlas_rows` always match what was actually baked.

Alpha is the whole point of a leaf image, so everything here works in RGBA and
refuses to flatten it.
"""
from __future__ import annotations

import base64
import io
import math

import numpy as np

# A tile bigger than this is downscaled: a 4x4 atlas of 2K leaves is a 8K texture
# nothing needs, and foliage is sampled at a few pixels per card on screen.
MAX_TILE = 512
MIN_TILE = 32


def decode_image(payload: bytes | str | None, label: str = "image"):
    """Decode PNG/JPEG bytes (or base64, or a data: URL) into an RGBA PIL image."""
    if not payload:
        return None
    from PIL import Image

    if isinstance(payload, str):
        text = payload
        if text.startswith("data:"):
            _, _, text = text.partition(",")
        try:
            payload = base64.b64decode(text, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{label} is not valid base64.") from exc

    try:
        image = Image.open(io.BytesIO(payload))
        image.load()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{label} could not be read as an image.") from exc
    return image


def _to_png_bytes(image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def find_leaf_stem(image):
    """Locate a leaf's stem and which way it points. Returns (attachment, blade centre) or None.

    A generated leaf cut-out can be at any angle with its stalk anywhere, so the
    atlas cannot assume the stem is where the renderer needs it. This finds it
    geometrically.

    The stem is the most SLENDER protrusion, not the longest one. Morphological
    opening with a disc removes everything thinner than the disc, leaving the
    blade; what it removed is the stalk plus the leaf's own pointed tip and its
    serrated edges. Picking the piece furthest from the blade is the obvious rule
    and it is wrong -- on a lanceolate leaf the tip reaches further than the
    stalk does. Slenderness separates them cleanly: measured across real
    generated leaves the stalk scores 9-12 and a tip scores 2-5, because a tip
    tapers out of the blade while a stalk is thin along its whole length.

    Colour looks like it should help (stalks read as pale) and does not: one
    tested leaf had a stalk darker than its own blade.
    """
    from scipy import ndimage

    alpha = np.asarray(image.convert("RGBA"))[..., 3] > 127
    if not alpha.any():
        return None
    height, width = alpha.shape

    radius = max(3, int(round(min(height, width) * 0.035)))
    grid_y, grid_x = np.mgrid[-radius:radius + 1, -radius:radius + 1]
    disc = (grid_x ** 2 + grid_y ** 2) <= radius * radius
    blade = ndimage.binary_opening(alpha, disc)
    if not blade.any():
        return None

    blade_y, blade_x = np.nonzero(blade)
    blade_centre = np.array([blade_x.mean(), blade_y.mean()])

    residual = ndimage.binary_opening(alpha & ~blade, np.ones((2, 2)))
    labels, count = ndimage.label(residual)
    if count == 0:
        return None

    best = None
    best_score = 0.0
    minimum_area = max(alpha.sum() * 0.001, 20)
    for index in range(1, count + 1):
        component = labels == index
        area = int(component.sum())
        if area < minimum_area:
            continue
        ys, xs = np.nonzero(component)
        points = np.stack([xs, ys], axis=1).astype(np.float64)
        centred = points - points.mean(axis=0)
        _, _, basis = np.linalg.svd(centred, full_matrices=False)
        along = centred @ basis[0]
        length = float(along.max() - along.min())
        # length / mean thickness, where thickness = area / length.
        score = (length * length) / max(area, 1)
        if score > best_score:
            best_score = score
            best = points

    # Below about 3 the "protrusion" is a serration or a lobe, not a stalk.
    if best is None or best_score < 3.0:
        return None
    attachment = best[np.argmax(np.linalg.norm(best - blade_centre, axis=1))]
    return attachment, blade_centre


def detect_leaf_pivot(image):
    """Detected attachment point as normalized {x, y}, or None.

    Seeds the pivot the UI shows so the user is correcting a guess rather than
    starting from nothing. The detector is right most of the time and wrong in
    ways that are obvious on sight, which is exactly the shape of thing that
    should be editable rather than trusted.
    """
    found = find_leaf_stem(image)
    if found is None:
        return None
    attachment, _blade = found
    width, height = image.size
    return {"x": float(np.clip(attachment[0] / max(width - 1, 1), 0.0, 1.0)),
            "y": float(np.clip(attachment[1] / max(height - 1, 1), 0.0, 1.0))}


def place_leaf_by_pivot(image, pivot, tile):
    """Rotate and frame a leaf so its pivot sits at the TOP-CENTRE of a tile.

    The pivot is the point that attaches to the branch, and a card samples the
    top edge of its tile there, so this is where the two conventions meet.

    Only a POINT is needed, not a direction: the leaf hangs away from its own
    attachment, so the direction is simply pivot -> the blade's centre of mass.
    Asking a user to drag an angle as well would be asking for something already
    implied by the click.
    """
    from PIL import Image

    rgba = image.convert("RGBA")
    width, height = rgba.size
    anchor = np.array([float(pivot["x"]) * (width - 1), float(pivot["y"]) * (height - 1)])

    alpha = np.asarray(rgba)[..., 3] > 127
    if not alpha.any():
        return rgba
    ys, xs = np.nonzero(alpha)
    centroid = np.array([xs.mean(), ys.mean()])

    direction = centroid - anchor
    if np.linalg.norm(direction) < 1e-6:
        direction = np.array([0.0, 1.0])
    # Turn so the blade hangs straight DOWN from the pivot. `angle` is the
    # clockwise offset of that direction from down; PIL rotates counter-
    # clockwise, hence the sign.
    angle = float(np.degrees(np.arctan2(direction[0], direction[1])))

    # Rotate about the pivot, not the image centre, so the pivot's position is
    # known exactly afterwards instead of having to be tracked through the
    # transform.
    padding = int(np.ceil(np.hypot(width, height)))
    canvas = Image.new("RGBA", (padding * 2, padding * 2), (0, 0, 0, 0))
    canvas.paste(rgba, (padding - int(round(anchor[0])), padding - int(round(anchor[1]))), rgba)
    rotated = canvas.rotate(-angle, resample=Image.BICUBIC, center=(padding, padding))

    # Frame it: the pivot at top-centre, wide enough for the widest part of the
    # leaf and tall enough for all of it.
    turned = np.asarray(rotated)[..., 3] > 127
    if not turned.any():
        return rgba
    ys, xs = np.nonzero(turned)
    half_width = max(int(np.abs(xs - padding).max()), 1)
    depth = max(int(ys.max() - padding), 1)
    size = max(half_width * 2, depth, 8)
    box = (padding - size // 2, padding, padding - size // 2 + size, padding + size)
    framed = rotated.crop(box)
    return framed.resize((tile, tile), Image.LANCZOS)


def orient_leaf(image):
    """Rotate a leaf so its stem points UP, which is where the card attaches.

    The generator's cards sample the top edge of a tile at the branch and the
    bottom edge at the free tip (see foliage.py). Rotating here means that
    convention holds for any input, however the image happened to be framed.
    """
    from PIL import Image

    found = find_leaf_stem(image)
    if found is None:
        return image, None
    attachment, blade_centre = found

    # Angle of the blade -> stem direction, measured from straight up in image
    # space (y grows downward, so "up" is -y).
    direction = attachment - blade_centre
    if np.linalg.norm(direction) < 1e-6:
        return image, None
    angle = np.degrees(np.arctan2(direction[0], -direction[1]))

    # `angle` is the stem's CLOCKWISE offset from straight up, and PIL rotates
    # counter-clockwise, so the correction is +angle. (Negating it puts the stem
    # 90 degrees off, and a leaf whose stem already points roughly down still
    # lands correctly either way -- which is exactly how the sign error survives
    # a spot check on one image.)
    #
    # expand=True so the corners are not clipped; the transparent margin is
    # trimmed by the bounding-box crop that follows.
    rotated = image.convert("RGBA").rotate(angle, resample=Image.BICUBIC, expand=True)
    box = rotated.getbbox()
    if box:
        rotated = rotated.crop(box)
    return rotated, float(angle)


def choose_grid(count: int) -> tuple[int, int]:
    """Pick the squarest grid that holds `count` tiles.

    Squarest rather than a fixed 2x2: a wasted tile is a leaf card that samples
    empty pixels and renders as a hole in the canopy, so the grid has to fit the
    images the user actually gave.
    """
    count = max(int(count), 1)
    cols = max(int(math.ceil(math.sqrt(count))), 1)
    rows = max(int(math.ceil(count / cols)), 1)
    return cols, rows


def compose_leaf_atlas(images: list, cols: int | None = None, rows: int | None = None,
                       auto_orient: bool = True, pivots: list | None = None):
    """Lay leaf images out on a grid. Returns (png_bytes, cols, rows, tile_px).

    Each image is fitted into its cell preserving aspect ratio and centred, on a
    fully transparent background. Stretching leaves to fill a square cell is the
    obvious shortcut and it is visibly wrong -- a long willow leaf comes out as a
    blob.
    """
    from PIL import Image

    frames = [image.convert("RGBA") for image in images if image is not None]
    if not frames:
        raise ValueError("No leaf images to compose into an atlas.")

    # An explicit pivot always wins over the detector: it is the user telling us
    # where the stem is, which is the whole point of letting them place it.
    pivots = list(pivots or [])
    pivots += [None] * (len(frames) - len(pivots))

    # Orient BEFORE measuring the cell size: rotating changes the bounding box,
    # and fitting to the pre-rotation size would leave every leaf smaller than
    # its cell.
    oriented = 0
    placed = 0
    rotated_frames = []
    for frame, pivot in zip(frames, pivots):
        if pivot and "x" in pivot and "y" in pivot:
            placed += 1
            rotated_frames.append(frame)   # framed per-pivot below, at tile size
            continue
        if auto_orient:
            turned, angle = orient_leaf(frame)
            if angle is not None:
                oriented += 1
            rotated_frames.append(turned)
        else:
            rotated_frames.append(frame)
    frames = rotated_frames

    if not cols or not rows or cols * rows < len(frames):
        cols, rows = choose_grid(len(frames))

    # One cell size for the whole atlas, driven by the largest input but capped.
    longest = max(max(frame.size) for frame in frames)
    tile = int(min(max(longest, MIN_TILE), MAX_TILE))

    atlas = Image.new("RGBA", (cols * tile, rows * tile), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        column, row = index % cols, index // cols
        pivot = pivots[index] if index < len(pivots) else None
        if pivot and "x" in pivot and "y" in pivot:
            # Already square and tile-sized, with the pivot at the top-centre.
            atlas.paste(place_leaf_by_pivot(frame, pivot, tile), (column * tile, row * tile))
            continue
        scale = min(tile / frame.width, tile / frame.height)
        size = (max(int(round(frame.width * scale)), 1), max(int(round(frame.height * scale)), 1))
        fitted = frame.resize(size, Image.LANCZOS)
        offset = (column * tile + (tile - size[0]) // 2,
                  row * tile + (tile - size[1]) // 2)
        atlas.paste(fitted, offset)

    return _to_png_bytes(atlas), int(cols), int(rows), tile, {"pivoted": placed, "auto_oriented": oriented}


def resolve_leaf_atlas(atlas_payload=None, image_payloads=None, cols=None, rows=None,
                       auto_orient=True, pivots=None):
    """Turn whatever the caller supplied into (image, cols, rows, tiles).

    `tiles` is how many cells actually hold a leaf, which is not cols*rows when
    the count is not a perfect grid -- three leaves fill three cells of a 2x2.

    Accepts a ready-made atlas, or a list of individual leaf images to compose.
    A single image is a legitimate 1x1 atlas -- every card then draws the same
    leaf, which is exactly right for a conifer needle sprig.
    """
    payloads = [p for p in (image_payloads or []) if p]
    if payloads:
        frames = [decode_image(p, f"leaf image {i + 1}") for i, p in enumerate(payloads)]
        png, cols, rows, _tile, placement = compose_leaf_atlas(frames, cols, rows, auto_orient, pivots)
        return decode_image(png, "composed leaf atlas"), cols, rows, len(frames), placement

    atlas = decode_image(atlas_payload, "leaf atlas")
    if atlas is None:
        return None, cols, rows, 0, {"pivoted": 0, "auto_oriented": 0}
    # A pre-made atlas carries its own grid, and every cell is assumed filled --
    # the caller laid it out, so they know.
    return atlas, cols, rows, (cols or 1) * (rows or 1), {"pivoted": 0, "auto_oriented": 0}
