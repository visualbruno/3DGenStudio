// CPU rasteriser for rig and animation previews - the AI's eyes.
//
// Same lesson as vfxPreview.js: an agent that can only read numbers authors
// blind. This draws the skinned mesh (flat shaded, z-buffered, orthographic)
// with an optional skeleton overlay and a ground line, and tiles several
// moments into one filmstrip so a whole motion fits in one image.
//
// Orthographic on purpose: the AI compares poses across frames, and a
// perspective camera makes the same pose look different depending on where it
// sits in the frame. Flat shading on purpose: it shows silhouette and folds,
// which is what reads at 256 px, and needs no normals from the file.
import { encodePng } from '../vfx/png.js';

const BG = [24, 26, 30];
const GROUND = [70, 120, 70];
const BASE_COLOUR = [0.78, 0.8, 0.86];

// 3x5 pixel font: enough for frame labels ("12  0.40s") and view names.
const GLYPHS = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111', '.': '000000000000010', s: '000011010001110',
  ' ': '000000000000000', '-': '000000111000000', f: '011010111010010', '#': '101111101111101',
  a: '000111001111111', b: '100100111101111', c: '000111100100111', d: '001001111101111',
  e: '111101111100111', g: '111101111001111', h: '100100111101101', i: '010000010010010',
  k: '100101110101101', l: '010010010010011', m: '000111111101101', n: '000110101101101',
  o: '000111101101111', p: '111101111100100', q: '111101111001001', r: '000111100100100',
  t: '010111010010011', u: '000101101101111', v: '000101101101010', w: '000101101111111',
  x: '000101010101101', y: '101101111001111', z: '000111010100111', ':': '000010000010000',
  '/': '001001010100100', '(': '010100100100010', ')': '010001001001010', '%': '101001010100101',
  '+': '000010111010000', '=': '000111000111000', _: '000000000000111'
};

function drawText(img, width, height, text, x0, y0, scale = 2, colour = [235, 235, 235]) {
  let x = x0;
  for (const ch of String(text).toLowerCase()) {
    const glyph = GLYPHS[ch] || GLYPHS[' '];
    for (let gy = 0; gy < 5; gy += 1) {
      for (let gx = 0; gx < 3; gx += 1) {
        if (glyph[gy * 3 + gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = x + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const o = (py * width + px) * 4;
            img[o] = colour[0]; img[o + 1] = colour[1]; img[o + 2] = colour[2]; img[o + 3] = 255;
          }
        }
      }
    }
    x += 4 * scale;
  }
}

/**
 * Camera basis for a named view in the rig's body frame.
 * `frame` = { forward, up, left } unit arrays. Returns { right, up, toward }
 * where `toward` points from the subject to the camera.
 */
export function viewBasis(frame, view = 'three_quarter') {
  const F = frame.forward, U = frame.up, L = frame.left;
  const add = (a, b, ka = 1, kb = 1) => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
  const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let toward;
  let up = U;
  switch (view) {
    case 'front': toward = F; break;
    case 'back': toward = F.map(v => -v); break;
    case 'left': toward = L; break; // the subject's left side
    case 'right': toward = L.map(v => -v); break;
    case 'top': toward = U; up = F; break;
    case 'three_quarter_back': toward = norm(add(add(F, L, -0.7, 0.7), U, 1, 0.45)); break;
    case 'three_quarter':
    default: toward = norm(add(add(F, L, 0.7, 0.7), U, 1, 0.45)); break;
  }
  toward = norm(toward);
  let right = norm(cross(up, toward));
  const trueUp = norm(cross(toward, right));
  return { right, up: trueUp, toward };
}

/** Project world points to view (right, up, depth) for a basis. */
function project(basis, x, y, z) {
  const { right, up, toward } = basis;
  return [
    x * right[0] + y * right[1] + z * right[2],
    x * up[0] + y * up[1] + z * up[2],
    x * toward[0] + y * toward[1] + z * toward[2]
  ];
}

/**
 * The 2D extent a set of point clouds covers in a view - used once for a whole
 * filmstrip so every frame shares one framing and motion reads as motion.
 */
export function viewExtent(basis, clouds, extraPoints = []) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const visit = (x, y, z) => {
    const [px, py] = project(basis, x, y, z);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  };
  for (const cloud of clouds) {
    const stride = Math.max(1, Math.floor(cloud.length / 3 / 20000));
    for (let i = 0; i < cloud.length / 3; i += stride) visit(cloud[i * 3], cloud[i * 3 + 1], cloud[i * 3 + 2]);
  }
  for (const p of extraPoints) visit(p[0], p[1], p[2]);
  if (!Number.isFinite(minX)) return { cx: 0, cy: 0, half: 1 };
  const half = Math.max(maxX - minX, maxY - minY) * 0.5 * 1.08 || 1;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, half };
}

/**
 * Draw one frame into an RGBA tile.
 *
 * positions: skinned world positions (Float32Array), indices: triangles,
 * vertexColours: optional Float32Array rgb 0..1 per vertex, segments: optional
 * [[ax,ay,az,bx,by,bz,[r,g,b]]] drawn on top (skeleton), extent: from viewExtent.
 */
export function renderTile({
  positions, indices, vertexColours = null, basis, extent, size = 320,
  segments = null, groundPoint = null, showGround = true, label = '', decimate = 1
}) {
  const width = size;
  const height = size;
  const img = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    img[i * 4] = BG[0]; img[i * 4 + 1] = BG[1]; img[i * 4 + 2] = BG[2]; img[i * 4 + 3] = 255;
  }
  const depth = new Float32Array(width * height).fill(-Infinity);
  const scale = (size * 0.5) / extent.half;
  const toScreen = (p) => [
    (p[0] - extent.cx) * scale + width / 2,
    height / 2 - (p[1] - extent.cy) * scale,
    p[2]
  ];

  // Ground: the row where the ground plane passes under the subject. In a
  // tilted view the plane is an area, so this marks the contact line through
  // the subject's centre - what a reader checks feet against.
  // Only in level views: in a tilted one the plane is an area, and a line
  // through its middle has the near feet "below the floor".
  if (showGround && groundPoint && Math.abs(basis.toward[1]) < 0.2) {
    const row = Math.round(toScreen(project(basis, groundPoint[0], groundPoint[1], groundPoint[2]))[1]);
    if (row >= 0 && row < height) {
      for (let x = 0; x < width; x += 1) {
        const o = (row * width + x) * 4;
        img[o] = GROUND[0]; img[o + 1] = GROUND[1]; img[o + 2] = GROUND[2];
      }
    }
  }

  // Light: from camera-upper-left, so flat shading separates facing planes.
  const light = [-0.35, 0.55, 0.76];
  const ln = Math.hypot(light[0], light[1], light[2]);
  const lx = light[0] / ln, ly = light[1] / ln, lz = light[2] / ln;

  const proj = new Float32Array((positions.length / 3) * 3);
  for (let v = 0; v < positions.length / 3; v += 1) {
    const p = project(basis, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    const s = toScreen(p);
    proj[v * 3] = s[0]; proj[v * 3 + 1] = s[1]; proj[v * 3 + 2] = s[2];
  }

  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t += decimate) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    const ax = proj[ia * 3], ay = proj[ia * 3 + 1], az = proj[ia * 3 + 2];
    const bx = proj[ib * 3], by = proj[ib * 3 + 1], bz = proj[ib * 3 + 2];
    const cx = proj[ic * 3], cy = proj[ic * 3 + 1], cz = proj[ic * 3 + 2];
    // View-space normal from screen-space edges (y flipped) for shading.
    const e1x = bx - ax, e1y = -(by - ay), e1z = bz - az;
    const e2x = cx - ax, e2y = -(cy - ay), e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0)) continue;
    nx /= nl; ny /= nl; nz /= nl;
    // Two-sided: generated meshes are not reliably wound.
    const shade = 0.28 + 0.72 * Math.abs(nx * lx + ny * ly + nz * lz);

    let r = BASE_COLOUR[0], g = BASE_COLOUR[1], bcol = BASE_COLOUR[2];
    if (vertexColours) {
      r = (vertexColours[ia * 3] + vertexColours[ib * 3] + vertexColours[ic * 3]) / 3;
      g = (vertexColours[ia * 3 + 1] + vertexColours[ib * 3 + 1] + vertexColours[ic * 3 + 1]) / 3;
      bcol = (vertexColours[ia * 3 + 2] + vertexColours[ib * 3 + 2] + vertexColours[ic * 3 + 2]) / 3;
    }
    const R = Math.min(255, r * shade * 255), G = Math.min(255, g * shade * 255), B = Math.min(255, bcol * shade * 255);

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const di = y * width + x;
        if (z <= depth[di]) continue;
        depth[di] = z;
        const o = di * 4;
        img[o] = R; img[o + 1] = G; img[o + 2] = B;
      }
    }
  }

  if (segments) {
    for (const seg of segments) {
      const a = toScreen(project(basis, seg[0], seg[1], seg[2]));
      const b = toScreen(project(basis, seg[3], seg[4], seg[5]));
      drawLine(img, width, height, a[0], a[1], b[0], b[1], seg[6] || [255, 170, 40]);
      drawDot(img, width, height, a[0], a[1], seg[6] || [255, 170, 40]);
    }
  }

  if (label) drawText(img, width, height, label, 6, 6, 2);
  return { img, width, height };
}

function plot(img, width, height, x, y, c) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const o = (y * width + x) * 4;
  img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; img[o + 3] = 255;
}

function drawLine(img, width, height, x0, y0, x1, y1, c) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    plot(img, width, height, x, y, c);
    plot(img, width, height, x + 1, y, c);
  }
}

function drawDot(img, width, height, x, y, c) {
  const cx = Math.round(x), cy = Math.round(y);
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) plot(img, width, height, cx + dx, cy + dy, c);
}

/** Tile RGBA tiles (all the same size) into a grid and encode as PNG. */
export function composeGrid(tiles, columns) {
  if (!tiles.length) throw new Error('Nothing to compose.');
  const tw = tiles[0].width, th = tiles[0].height;
  const cols = Math.max(1, Math.min(columns, tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const gap = 2;
  const width = cols * tw + (cols - 1) * gap;
  const height = rows * th + (rows - 1) * gap;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) { out[i * 4] = 60; out[i * 4 + 1] = 60; out[i * 4 + 2] = 66; out[i * 4 + 3] = 255; }
  tiles.forEach((tile, i) => {
    const ox = (i % cols) * (tw + gap);
    const oy = Math.floor(i / cols) * (th + gap);
    for (let y = 0; y < th; y += 1) {
      out.set(tile.img.subarray(y * tw * 4, (y + 1) * tw * 4), ((oy + y) * width + ox) * 4);
    }
  });
  return { png: encodePng(width, out, height), width, height };
}

/** Distinct, readable colours for chain labelling. */
export const PALETTE = [
  [0.95, 0.35, 0.3], [0.3, 0.6, 0.95], [0.35, 0.85, 0.4], [0.98, 0.78, 0.25],
  [0.75, 0.45, 0.95], [0.25, 0.85, 0.85], [0.98, 0.55, 0.15], [0.9, 0.4, 0.7],
  [0.6, 0.8, 0.2], [0.55, 0.55, 0.95], [0.85, 0.65, 0.5], [0.4, 0.95, 0.7],
  [0.95, 0.95, 0.5], [0.5, 0.3, 0.2], [0.7, 0.2, 0.4], [0.2, 0.45, 0.35]
];
