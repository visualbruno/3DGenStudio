"""Phase 5 -- octahedral impostors.

At real forest distances a tree is a few dozen pixels, and even LOD3 is tens of
thousands of triangles spent on something smaller than a thumbnail. An impostor
replaces the geometry with a quad and a grid of pre-rendered views: the shader
picks the views nearest the current camera direction and blends them, so the
billboard turns convincingly as you walk around it. That is what makes a forest
of thousands of trees affordable.

Two decisions worth stating.

*Hemi-octahedral, not full octahedral.* A tree is rooted to the ground and never
viewed from below, so spending half the atlas on views nobody sees would halve
the resolution of the ones they do.

*Rendered by area-weighted splatting, not scanline rasterization.* The whole
bake is 64 views of a ~100k-triangle mesh, and a per-triangle Python loop over
6.4M triangle-views takes minutes. Instead every triangle is sampled at a rate
proportional to its projected area and the samples are scattered into the
framebuffer with a depth test -- a few million points, all in vectorized numpy,
in about a second. At the resolution an impostor tile actually gets (128px), the
difference from true rasterization is not visible; what matters is coverage and
silhouette, and splatting gets both right.

This deliberately does NOT use Blender: the bake has to work wherever the
service runs, and bpy is a heavyweight optional dependency that is not always
installed.
"""
from __future__ import annotations

import io

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial

# Samples per pixel of projected area.
#
# This is a supersampling rate, not just a coverage rate: every sample that wins
# the depth test contributes to its pixel's average, so raising it antialiases as
# well as filling holes. At 3 the atlas came out measurably noisier than the leaf
# texture it sampled (12.3 vs 8.1 mean neighbour difference) because each pixel
# was one point sample of a high-frequency texture. 5 samples per unit of
# triangle area works out to ~14 per atlas pixel once overdraw is counted, which
# measures at or below the source texture's own noise.
SAMPLES_PER_PIXEL = 5.0
# One, not two. A tree is mostly sub-pixel triangles at impostor resolution, so
# the floor is what most of them get -- and with ~200k triangles a floor of 2
# adds 400k samples per view that buy nothing, doubling the bake.
MIN_SAMPLES_PER_TRIANGLE = 1
MAX_SAMPLES_PER_TRIANGLE = 65536

# Depth window, as a fraction of the model radius, within which samples count as
# "the same surface" and are averaged together. Without a window only the single
# nearest sample survives and there is nothing to average -- but it has to stay
# tight enough that the canopy behind does not bleed through.
DEPTH_SLAB = 0.004


def hemi_octahedral_directions(grid: int) -> np.ndarray:
    """Unit view directions for a grid x grid hemi-octahedral atlas.

    Cell centres are used rather than corners, so the sampled directions are the
    ones a shader decoding the same mapping will land on.
    """
    axis = (np.arange(grid) + 0.5) / grid
    u, v = np.meshgrid(axis, axis, indexing="xy")
    a = 2.0 * u - 1.0
    b = 2.0 * v - 1.0
    x = (a + b) * 0.5
    z = (b - a) * 0.5
    y = 1.0 - np.abs(x) - np.abs(z)
    directions = np.stack([x, y, z], axis=-1).reshape(-1, 3)
    return directions / np.maximum(np.linalg.norm(directions, axis=1, keepdims=True), 1e-9)


def _basis(direction):
    """Camera basis looking at the origin FROM `direction`."""
    forward = -direction / max(np.linalg.norm(direction), 1e-9)
    world_up = np.array([0.0, 1.0, 0.0])
    if abs(float(forward @ world_up)) > 0.999:
        world_up = np.array([0.0, 0.0, 1.0])
    right = np.cross(forward, world_up)
    right /= max(np.linalg.norm(right), 1e-9)
    up = np.cross(right, forward)
    return right, up, forward


def _flatten_scene(scene: trimesh.Scene):
    """Scene -> flat sample-able arrays, keeping UVs and textures SEPARATE.

    The tempting shortcut is to resolve each vertex's texture colour here, once,
    and interpolate the result. For opaque surfaces that is fine. For an
    alpha-tested leaf card it is catastrophic: a card is a quad whose four
    vertices land on the four CORNERS of its atlas tile, and a leaf cut-out is
    transparent at the corners. Every vertex therefore reads alpha 0, the alpha
    test discards the whole canopy, and the impostor comes out as bare branches.

    So the texture stays unsampled until there is a real interior point to
    sample it at -- see `_sample_textures`.
    """
    positions, normals, uvs, colours, alphas, texture_ids = [], [], [], [], [], []
    faces = []
    textures: list = []
    offset = 0

    for geometry in scene.geometry.values():
        vertices = np.asarray(geometry.vertices, dtype=np.float64)
        if len(vertices) == 0:
            continue
        face = np.asarray(geometry.faces, dtype=np.int64)

        material = getattr(geometry.visual, "material", None)
        base = np.asarray(getattr(material, "baseColorFactor", None)
                          if material is not None else None, dtype=np.float64)
        if base.shape != (4,):
            base = np.array([0.5, 0.5, 0.5, 1.0])
        if base.max() > 1.5:      # trimesh may hand these back as 0-255
            base = base / 255.0

        texture = getattr(material, "baseColorTexture", None) if material is not None else None
        uv = getattr(geometry.visual, "uv", None)
        texture_id = -1
        if texture is not None and uv is not None and len(uv) == len(vertices):
            image = np.asarray(texture.convert("RGBA"), dtype=np.float32) / np.float32(255.0)
            textures.append(image)
            texture_id = len(textures) - 1
            # The scene holds UVs in trimesh's bottom-left-origin convention so
            # that the glTF writer's flip lands them right way up in the GLB
            # (see _make_geometry). Sampling here indexes the texture by row,
            # which is top-left-origin, so flip back -- otherwise every leaf
            # card reads the mirrored tile and lands on transparent pixels.
            uv_array = np.asarray(uv, dtype=np.float64).copy()
            uv_array[:, 1] = 1.0 - uv_array[:, 1]
        else:
            uv_array = np.zeros((len(vertices), 2))

        positions.append(vertices)
        normals.append(np.asarray(geometry.vertex_normals, dtype=np.float64))
        uvs.append(uv_array)
        colours.append(np.tile(base[:3], (len(vertices), 1)))
        alphas.append(np.full(len(vertices), base[3]))
        texture_ids.append(np.full(len(vertices), texture_id, dtype=np.int64))
        faces.append(face + offset)
        offset += len(vertices)

    if not positions:
        raise ValueError("The scene has no geometry to bake an impostor from.")

    return {
        "positions": np.concatenate(positions),
        "faces": np.concatenate(faces).astype(np.int64),
        "normals": np.concatenate(normals),
        "uvs": np.concatenate(uvs).astype(np.float32),
        "colours": np.concatenate(colours).astype(np.float32),
        "alphas": np.concatenate(alphas).astype(np.float32),
        "texture_ids": np.concatenate(texture_ids),
        "textures": textures,
    }


def _sample_textures(mesh, sample_uv, sample_texture_id, colour, alpha):
    """Multiply in the texture at each SAMPLE's own uv, grouped by texture.

    One fancy-index lookup per distinct texture (there are two or three in a
    tree), so this stays vectorized no matter how many million samples there are.
    """
    for texture_id, image in enumerate(mesh["textures"]):
        picked = sample_texture_id == texture_id
        if not np.any(picked):
            continue
        height, width = image.shape[:2]
        # glTF: v runs downward from the top-left, and the wrap is REPEAT.
        # Bilinear, not nearest. A leaf atlas is high-frequency, and point-sampling
        # it makes neighbouring impostor pixels disagree wildly for no reason
        # other than which texel each landed on.
        #
        # Indexed through a FLAT view of the image: `image[y, x]` on a 3-D array
        # builds an intermediate index per axis, and at several million samples
        # that costs more than the interpolation it feeds.
        flat_image = image.reshape(-1, 4)
        u = np.mod(sample_uv[picked, 0], 1.0) * (width - 1)
        v = np.mod(sample_uv[picked, 1], 1.0) * (height - 1)
        x0 = u.astype(np.int32)
        y0 = v.astype(np.int32)
        x1 = np.minimum(x0 + 1, width - 1)
        y1 = np.minimum(y0 + 1, height - 1)
        fx = (u - x0).astype(np.float32)[:, None]
        fy = (v - y0).astype(np.float32)[:, None]
        row0 = y0 * width
        row1 = y1 * width
        texel = (flat_image[row0 + x0] * (1 - fx) * (1 - fy)
                 + flat_image[row0 + x1] * fx * (1 - fy)
                 + flat_image[row1 + x0] * (1 - fx) * fy
                 + flat_image[row1 + x1] * fx * fy)
        colour[picked] *= texel[:, :3]
        alpha[picked] *= texel[:, 3]
    return colour, alpha


def _fill_holes(albedo, normal):
    """Fill single-pixel gaps from their neighbours.

    Even at a high sample rate the splat leaves a scatter of pixels no sample
    happened to land in, and against a dark canopy those read as salt-and-pepper
    speckle. Filling a transparent pixel from its opaque neighbours also gives
    the atlas a one-pixel gutter, so a mipmapped impostor does not pull the empty
    background into the silhouette as it shrinks.
    """
    opaque = albedo[..., 3] > 0.5
    holes = ~opaque
    if not np.any(holes):
        return albedo, normal

    padded_mask = np.pad(opaque, 1).astype(np.float64)
    padded_albedo = np.pad(albedo[..., :3], ((1, 1), (1, 1), (0, 0)))
    padded_normal = np.pad(normal, ((1, 1), (1, 1), (0, 0)))
    height, width = opaque.shape

    count = np.zeros((height, width))
    colour = np.zeros((height, width, 3))
    normals = np.zeros((height, width, 3))
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            if dy == 1 and dx == 1:
                continue
            mask = padded_mask[dy:dy + height, dx:dx + width]
            count += mask
            colour += padded_albedo[dy:dy + height, dx:dx + width] * mask[..., None]
            normals += padded_normal[dy:dy + height, dx:dx + width] * mask[..., None]

    # Only true holes, not the outside edge of the silhouette: filling those
    # would inflate the tree by a pixel on every view.
    fill = holes & (count >= 5)
    if np.any(fill):
        divisor = count[fill][:, None]
        albedo[fill, :3] = colour[fill] / divisor
        albedo[fill, 3] = 1.0
        filled = normals[fill] / divisor
        normal[fill] = filled / np.maximum(np.linalg.norm(filled, axis=1, keepdims=True), 1e-9)
    return albedo, normal


def _render_view(direction, tile, mesh, centre, radius, rng, samples_per_pixel=SAMPLES_PER_PIXEL):
    """One orthographic view, splat-rasterized. Returns (albedo RGBA, normal RGB)."""
    right, up, forward = _basis(direction)
    vertices = mesh["positions"]
    faces = mesh["faces"]
    normals = mesh["normals"]

    local = vertices - centre
    screen_x = (local @ right) / radius
    screen_y = (local @ up) / radius
    depth = local @ forward            # larger = further from the camera

    # Per-triangle projected area in pixels, which sets its sample count. A
    # triangle facing edge-on gets one sample and costs nothing.
    tri = faces
    ax, ay = screen_x[tri[:, 0]], screen_y[tri[:, 0]]
    bx, by = screen_x[tri[:, 1]], screen_y[tri[:, 1]]
    cx, cy = screen_x[tri[:, 2]], screen_y[tri[:, 2]]
    area = np.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5
    pixels = area * (tile * 0.5) ** 2
    counts = np.clip(np.ceil(pixels * samples_per_pixel),
                     MIN_SAMPLES_PER_TRIANGLE, MAX_SAMPLES_PER_TRIANGLE).astype(np.int64)

    index = np.repeat(np.arange(len(tri)), counts)
    total = len(index)
    if total == 0:
        return (np.zeros((tile, tile, 4), np.float32), np.zeros((tile, tile, 3), np.float32))

    # Uniform barycentric sampling of a triangle: the sqrt is what makes the
    # distribution even rather than bunched at one corner.
    r1 = np.sqrt(rng.random(total, dtype=np.float32))
    r2 = rng.random(total, dtype=np.float32)
    w0 = (1.0 - r1)[:, None]
    w1 = (r1 * (1.0 - r2))[:, None]
    w2 = (r1 * r2)[:, None]

    i0, i1, i2 = tri[index, 0], tri[index, 1], tri[index, 2]
    sx = (w0[:, 0] * screen_x[i0] + w1[:, 0] * screen_x[i1] + w2[:, 0] * screen_x[i2])
    sy = (w0[:, 0] * screen_y[i0] + w1[:, 0] * screen_y[i1] + w2[:, 0] * screen_y[i2])
    sz = (w0[:, 0] * depth[i0] + w1[:, 0] * depth[i1] + w2[:, 0] * depth[i2])

    # Colour and alpha are resolved HERE, at interpolated interior points, not
    # per vertex — a leaf card's vertices sit on the transparent corners of its
    # atlas tile, so per-vertex alpha is zero and the canopy vanishes.
    sc = (w0 * mesh["colours"][i0] + w1 * mesh["colours"][i1] + w2 * mesh["colours"][i2])
    sa = (w0[:, 0] * mesh["alphas"][i0] + w1[:, 0] * mesh["alphas"][i1] + w2[:, 0] * mesh["alphas"][i2])
    suv = (w0 * mesh["uvs"][i0] + w1 * mesh["uvs"][i1] + w2 * mesh["uvs"][i2])
    sc, sa = _sample_textures(mesh, suv, mesh["texture_ids"][i0], sc, sa)

    # Alpha test BEFORE the depth buffer. A leaf card is mostly transparent, and
    # letting its empty corners win the depth test would punch holes in whatever
    # is behind them — turning the canopy into a field of opaque squares.
    keep = sa >= 0.5
    if not np.any(keep):
        return (np.zeros((tile, tile, 4), np.float32), np.zeros((tile, tile, 3), np.float32))

    px = np.clip(((sx[keep] * 0.5 + 0.5) * tile).astype(np.int64), 0, tile - 1)
    py = np.clip(((0.5 - sy[keep] * 0.5) * tile).astype(np.int64), 0, tile - 1)
    flat = py * tile + px
    z = sz[keep]

    # Depth resolve, then AVERAGE every sample on the winning surface.
    #
    # Keeping only the single nearest sample makes each pixel one point sample of
    # a high-frequency leaf texture, and the atlas comes out noisier than the
    # texture it was baked from. Accumulating the samples within a depth slab of
    # the nearest one turns the same work into a box filter: supersampling for
    # free, since the samples were already being generated and thrown away.
    zbuffer = np.full(tile * tile, np.inf)
    np.minimum.at(zbuffer, flat, z)
    slab = max(radius * DEPTH_SLAB, 1e-6)
    winners = z <= zbuffer[flat] + slab

    sn = (w0 * normals[i0] + w1 * normals[i1] + w2 * normals[i2])[keep]
    sn = sn / np.maximum(np.linalg.norm(sn, axis=1, keepdims=True), 1e-9)
    # View-space normals: an impostor shader reads them in the frame of the view
    # it sampled, so storing world space would need the decode to know which
    # cell it came from.
    sn = np.stack([sn @ right, sn @ up, -(sn @ forward)], axis=1)

    # Accumulated with bincount rather than np.add.at. They compute the same
    # thing, but ufunc.at is unbuffered and runs several times slower -- which
    # shows at the few million samples a 512px tile generates.
    target = flat[winners]
    pixels_total = tile * tile
    won_colour = sc[keep][winners]
    won_normal = sn[winners]
    colour_sum = np.stack(
        [np.bincount(target, weights=won_colour[:, k], minlength=pixels_total) for k in range(3)], axis=1)
    normal_sum = np.stack(
        [np.bincount(target, weights=won_normal[:, k], minlength=pixels_total) for k in range(3)], axis=1)
    weight = np.bincount(target, minlength=pixels_total).astype(np.float64)

    covered = weight > 0
    divisor = np.maximum(weight, 1.0)[:, None]
    albedo = np.zeros((tile * tile, 4), np.float32)
    albedo[:, :3] = colour_sum / divisor
    albedo[covered, 3] = 1.0
    averaged = normal_sum / divisor
    normal = (averaged / np.maximum(np.linalg.norm(averaged, axis=1, keepdims=True), 1e-9)).astype(np.float32)
    normal[~covered] = 0.0

    return (_fill_holes(albedo.reshape(tile, tile, 4), normal.reshape(tile, tile, 3)))


def bake_impostor(scene: trimesh.Scene, grid: int = 8, tile: int = 128, seed: int = 0,
                  samples_per_pixel: float = SAMPLES_PER_PIXEL, on_progress=None):
    """Render a hemi-octahedral impostor for `scene`.

    Returns {albedo_png, normal_png, glb, meta}. The GLB is a single quad, sized
    to the tree and UV'd to the atlas cell nearest a level side-on view, so it
    still shows something recognisable in an ordinary glTF viewer. Proper
    view-dependent sampling needs an impostor shader on the engine side — that
    is what `meta` describes.
    """
    mesh = _flatten_scene(scene)
    vertices = mesh["positions"]
    rng = np.random.default_rng(int(seed))

    lower = vertices.min(axis=0)
    upper = vertices.max(axis=0)
    centre = (lower + upper) * 0.5
    radius = float(np.linalg.norm(upper - lower) * 0.5) or 1.0

    directions = hemi_octahedral_directions(grid)
    albedo_atlas = np.zeros((grid * tile, grid * tile, 4), np.float32)
    normal_atlas = np.zeros((grid * tile, grid * tile, 3), np.float32)

    for index, direction in enumerate(directions):
        row, column = divmod(index, grid)
        # Reported per view: a 2048px atlas of a 200k-triangle tree takes the
        # better part of a minute, and a single event at the start leaves the UI
        # looking hung for all of it.
        if on_progress is not None:
            on_progress(index / len(directions), f"Impostor view {index + 1} of {len(directions)}")
        albedo, normal = _render_view(direction, tile, mesh, centre, radius, rng, samples_per_pixel)
        albedo_atlas[row * tile:(row + 1) * tile, column * tile:(column + 1) * tile] = albedo
        normal_atlas[row * tile:(row + 1) * tile, column * tile:(column + 1) * tile] = normal

    from PIL import Image

    def to_png(array, mode):
        image = Image.fromarray(np.clip(array * 255.0, 0, 255).astype(np.uint8), mode)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()

    albedo_png = to_png(albedo_atlas, "RGBA")
    # Normals are stored the usual way, remapped from [-1,1] to [0,1].
    normal_png = to_png(normal_atlas * 0.5 + 0.5, "RGB")

    coverage = float((albedo_atlas[..., 3] > 0).mean())

    # The billboard: a camera-facing quad spanning the tree, standing on the
    # ground rather than centred on it, so it drops in where the mesh was.
    width = float(max(upper[0] - lower[0], upper[2] - lower[2]))
    height = float(upper[1] - lower[1])
    half = max(width, height) * 0.5
    mid_y = float(lower[1]) + height * 0.5
    quad_vertices = np.array([
        [-half, mid_y - half, 0.0],
        [half, mid_y - half, 0.0],
        [half, mid_y + half, 0.0],
        [-half, mid_y + half, 0.0],
    ])
    quad_faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
    # The cell closest to horizontal, which is how a tree is normally seen.
    level = int(np.argmin(np.abs(directions[:, 1])))
    row, column = divmod(level, grid)
    u0, v0 = column / grid, row / grid
    step = 1.0 / grid
    quad_uv = np.array([[u0, v0 + step], [u0 + step, v0 + step], [u0 + step, v0], [u0, v0]])

    material = PBRMaterial(
        name="TreeImpostor",
        baseColorTexture=Image.open(io.BytesIO(albedo_png)),
        alphaMode="MASK",
        alphaCutoff=0.5,
        doubleSided=True,
        roughnessFactor=0.9,
        metallicFactor=0.0,
    )
    quad = trimesh.Trimesh(vertices=quad_vertices, faces=quad_faces, process=False)
    quad.visual = trimesh.visual.TextureVisuals(uv=quad_uv, material=material)
    impostor_scene = trimesh.Scene()
    impostor_scene.add_geometry(quad, geom_name="Tree_Impostor", node_name="Tree_Impostor")

    return {
        "albedo_png": albedo_png,
        "normal_png": normal_png,
        "glb": impostor_scene.export(file_type="glb"),
        "meta": {
            "mapping": "hemi-octahedral",
            "grid": grid,
            "tile": tile,
            "views": int(len(directions)),
            "atlas": [grid * tile, grid * tile],
            "bounds": {"min": lower.tolist(), "max": upper.tolist()},
            "radius": radius,
            "quad": {"width": half * 2.0, "height": half * 2.0, "centre_y": mid_y},
            "coverage": round(coverage, 4),
            "samples_per_pixel": float(samples_per_pixel),
            "normals": "view-space, [-1,1] remapped to [0,1]",
        },
    }
