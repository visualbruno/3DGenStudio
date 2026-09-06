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


def compose_leaf_atlas(images: list, cols: int | None = None, rows: int | None = None):
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

    if not cols or not rows or cols * rows < len(frames):
        cols, rows = choose_grid(len(frames))

    # One cell size for the whole atlas, driven by the largest input but capped.
    longest = max(max(frame.size) for frame in frames)
    tile = int(min(max(longest, MIN_TILE), MAX_TILE))

    atlas = Image.new("RGBA", (cols * tile, rows * tile), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        scale = min(tile / frame.width, tile / frame.height)
        size = (max(int(round(frame.width * scale)), 1), max(int(round(frame.height * scale)), 1))
        fitted = frame.resize(size, Image.LANCZOS)
        column, row = index % cols, index // cols
        offset = (column * tile + (tile - size[0]) // 2,
                  row * tile + (tile - size[1]) // 2)
        atlas.paste(fitted, offset)

    return _to_png_bytes(atlas), int(cols), int(rows), tile


def resolve_leaf_atlas(atlas_payload=None, image_payloads=None, cols=None, rows=None):
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
        png, cols, rows, _tile = compose_leaf_atlas(frames, cols, rows)
        return decode_image(png, "composed leaf atlas"), cols, rows, len(frames)

    atlas = decode_image(atlas_payload, "leaf atlas")
    if atlas is None:
        return None, cols, rows, 0
    # A pre-made atlas carries its own grid, and every cell is assumed filled --
    # the caller laid it out, so they know.
    return atlas, cols, rows, (cols or 1) * (rows or 1)
