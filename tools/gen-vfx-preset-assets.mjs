// Generate the VFX preset asset pack into resources/vfx/assets/.
//
//     node tools/gen-vfx-preset-assets.mjs [--force]
//
// These are the sprites and debris chips the shipped presets draw with. They
// are GENERATED rather than hand-painted so that they are reproducible, reviewable
// as code, and free of any licensing question - and because a particle sprite is
// a radial falloff with a curve on it, which is a formula, not an illustration.
//
// EVERY SPRITE IS BLACK-BACKGROUNDED AND ALPHA-CORRECT AT ONCE. rgb carries the
// light and alpha carries the coverage, with rgb going to zero wherever alpha
// does. That is what makes one file work under BOTH blend modes: additive reads
// the rgb and ignores the alpha, alpha blending reads both. A sprite with a
// white background and a shaped alpha would be unusable additively, and one
// with shaped rgb and no alpha unusable for smoke.
//
// Like the preset seeder, this refuses to overwrite without --force: the pack
// ships with the app and the author may have replaced a file by hand.
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { encodeGlb, encodePng, facetedMesh, paint } from './vfx-asset-writers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'resources', 'vfx', 'assets');
const force = process.argv.includes('--force');

const SIZE = 256;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};

// A tileable-enough value noise, for the sprites that need a broken edge rather
// than a perfect circle. Deterministic: the pack must regenerate identically.
const hash2 = (x, y) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
};
const noise2 = (x, y) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
};
const fbm = (x, y) => (
  noise2(x, y) * 0.55 + noise2(x * 2.1, y * 2.1) * 0.29 + noise2(x * 4.3, y * 4.3) * 0.16
);

/** Premultiply-free grey: one value used for rgb and alpha together. */
const mono = (value) => {
  const v = clamp01(value);
  return [v, v, v, v];
};

// --- the sprites -------------------------------------------------------------

const SPRITES = [
  {
    file: 'soft-glow.png',
    name: 'Soft Glow',
    note: 'The workhorse. A gaussian-ish falloff with no hard edge anywhere, which is what stops a cloud of them looking like a pile of discs.',
    shade: (u, v) => mono(Math.exp(-3.2 * (u * u + v * v)) - 0.04),
  },
  {
    file: 'hard-flare.png',
    name: 'Hard Flare',
    note: 'A bright core that falls off fast. For flashes and impact pops, where the eye wants a definite centre.',
    shade: (u, v) => {
      const r = Math.hypot(u, v);
      const core = Math.exp(-14 * r * r);
      const halo = Math.exp(-3 * r * r) * 0.35;
      return mono(core + halo - 0.03);
    },
  },
  {
    file: 'flame-wisp.png',
    name: 'Flame Wisp',
    note: 'A teardrop, wide at the base and tapering upward, so a rising particle reads as a tongue of flame rather than a ball.',
    shade: (u, v) => {
      // v runs downward in image space, so the taper is at negative v.
      const height = (v + 1) / 2;          // 0 at top, 1 at bottom
      const width = 0.16 + 0.62 * height * height;
      const wobble = (fbm(u * 2.5 + 8, height * 3.5) - 0.5) * 0.16 * (1 - height);
      const across = Math.abs(u + wobble) / width;
      const body = smoothstep(1, 0.15, across);
      const ends = smoothstep(0, 0.16, height) * smoothstep(1.02, 0.62, height);
      return mono(body * ends - 0.02);
    },
  },
  {
    file: 'smoke-puff.png',
    name: 'Smoke Puff',
    note: 'A soft blob with a broken, noisy edge. The noise is the whole point: a circular puff repeated sixty times reads as bubbles.',
    shade: (u, v) => {
      const r = Math.hypot(u, v);
      const angle = Math.atan2(v, u);
      const edge = 0.62 + (fbm(Math.cos(angle) * 2.2 + 4, Math.sin(angle) * 2.2 + 4) - 0.5) * 0.42;
      const body = smoothstep(edge, edge * 0.25, r);
      const grain = 0.82 + fbm(u * 3.1 + 11, v * 3.1 + 11) * 0.36;
      return mono(body * grain - 0.02);
    },
  },
  {
    file: 'spark-streak.png',
    name: 'Spark Streak',
    note: 'A thin horizontal line with a hot middle. Meant for the stretched billboard, whose long axis is the direction of travel.',
    shade: (u, v) => {
      const across = smoothstep(0.5, 0, Math.abs(v) / 0.14);
      const along = smoothstep(1.05, 0.2, Math.abs(u));
      const core = Math.exp(-9 * u * u) * 0.5;
      return mono((across * along + core * across) - 0.02);
    },
  },
  {
    file: 'ring.png',
    name: 'Ring',
    note: 'A soft annulus, for shockwaves and expanding pulses where the middle has to stay empty.',
    shade: (u, v) => {
      const r = Math.hypot(u, v);
      return mono(Math.exp(-46 * (r - 0.62) * (r - 0.62)) - 0.03);
    },
  },
  {
    file: 'star-four.png',
    name: 'Four-Point Star',
    note: 'A cross-shaped twinkle. For pickups, sparkles and anything that wants to read as a highlight rather than a blob.',
    shade: (u, v) => {
      const r = Math.hypot(u, v);
      const arms = Math.max(
        Math.exp(-70 * v * v) * smoothstep(1.05, 0.1, Math.abs(u)),
        Math.exp(-70 * u * u) * smoothstep(1.05, 0.1, Math.abs(v)),
      );
      const core = Math.exp(-26 * r * r);
      return mono(Math.max(arms * 0.85, core) - 0.03);
    },
  },
  {
    file: 'dust-mote.png',
    name: 'Dust Mote',
    note: 'A small, faint, slightly irregular speck. Deliberately dim - ambient dust that reads as bright is snow.',
    shade: (u, v) => {
      const r = Math.hypot(u, v);
      const lumps = 0.72 + (fbm(u * 1.8 + 21, v * 1.8 + 21) - 0.5) * 0.5;
      return mono(smoothstep(0.72 * lumps, 0.1, r) * 0.8 - 0.03);
    },
  },
  {
    file: 'shard.png',
    name: 'Shard',
    note: 'A hard-edged sliver for debris and glass, where a soft round particle looks like a bubble.',
    shade: (u, v) => {
      // A tapered quadrilateral, sharp at both ends.
      const along = (v + 1) / 2;
      const width = 0.36 * Math.sin(Math.PI * clamp01(along)) ** 0.6;
      const across = Math.abs(u * 0.8 + (along - 0.5) * 0.35) / (width || 1e-6);
      return mono(smoothstep(1, 0.82, across) * smoothstep(0, 0.04, along) - 0.02);
    },
  },
];

// --- the chips ---------------------------------------------------------------
//
// Low-poly on purpose: these are drawn at a few pixels across, tumbling, in
// batches of hundreds. Silhouette is all that survives, so anything past a
// dozen facets is triangles nobody will ever see.

const jitter = (seed) => (index) => 0.72 + hash2(seed * 13.7 + index, seed * 7.1) * 0.56;

/** An irregular convex lump: a subdivided octahedron with the radii kicked. */
function lump(seed, squash = [1, 1, 1]) {
  const wobble = jitter(seed);
  const points = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  ].map((point, index) => {
    const scale = wobble(index);
    return [point[0] * scale * squash[0], point[1] * scale * squash[1], point[2] * scale * squash[2]];
  });
  const [top, bottom, px, nx, pz, nz] = points;
  return facetedMesh([
    [top, pz, px], [top, px, nz], [top, nz, nx], [top, nx, pz],
    [bottom, px, pz], [bottom, nz, px], [bottom, nx, nz], [bottom, pz, nx],
  ], `lump-${seed}`);
}

/** A flat slab, for planks and coins. */
function slab(halfX, halfY, halfZ, name) {
  const c = [
    [-halfX, -halfY, -halfZ], [halfX, -halfY, -halfZ], [halfX, halfY, -halfZ], [-halfX, halfY, -halfZ],
    [-halfX, -halfY, halfZ], [halfX, -halfY, halfZ], [halfX, halfY, halfZ], [-halfX, halfY, halfZ],
  ];
  const quad = (a, b, d, e) => [[c[a], c[b], c[d]], [c[a], c[d], c[e]]];
  return facetedMesh([
    ...quad(4, 5, 6, 7), ...quad(1, 0, 3, 2),
    ...quad(0, 4, 7, 3), ...quad(5, 1, 2, 6),
    ...quad(3, 7, 6, 2), ...quad(0, 1, 5, 4),
  ], name);
}

/** A short prism, which at debris scale reads as a coin or a pebble. */
function disc(sides, radius, halfHeight, name) {
  const rim = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    rim.push([Math.cos(angle) * radius, halfHeight, Math.sin(angle) * radius]);
  }
  const triangles = [];
  const topCentre = [0, halfHeight, 0];
  const bottomCentre = [0, -halfHeight, 0];
  for (let i = 0; i < sides; i += 1) {
    const a = rim[i];
    const b = rim[(i + 1) % sides];
    const aLow = [a[0], -halfHeight, a[2]];
    const bLow = [b[0], -halfHeight, b[2]];
    triangles.push([topCentre, a, b]);
    triangles.push([bottomCentre, bLow, aLow]);
    triangles.push([a, aLow, bLow]);
    triangles.push([a, bLow, b]);
  }
  return facetedMesh(triangles, name);
}

const CHIPS = [
  {
    file: 'rock-chip.glb',
    name: 'Rock Chip',
    note: 'An irregular lump. The default piece of debris.',
    build: () => lump(3, [1, 0.82, 0.94]),
  },
  {
    file: 'stone-shard.glb',
    name: 'Stone Shard',
    note: 'Longer and thinner than the chip, so a mixed burst does not look cloned.',
    build: () => lump(11, [0.55, 1.35, 0.6]),
  },
  {
    file: 'plank.glb',
    name: 'Plank',
    note: 'A flat slab for splintered wood and broken crates.',
    build: () => slab(0.62, 0.14, 0.2, 'plank'),
  },
  {
    file: 'coin.glb',
    name: 'Coin',
    note: 'A ten-sided disc. Reads as a coin when it tumbles and catches the light on its face.',
    build: () => disc(10, 0.5, 0.07, 'coin'),
  },
];

// --- write -------------------------------------------------------------------

await mkdir(OUT, { recursive: true });

let written = 0;
let skipped = 0;

const put = async (file, bytes, label) => {
  const target = path.join(OUT, file);
  if (existsSync(target) && !force) {
    console.log(`  skip   ${file} (already on disk; --force to overwrite)`);
    skipped += 1;
    return;
  }
  await writeFile(target, bytes);
  console.log(`  write  ${file.padEnd(20)} ${String(bytes.length).padStart(7)} bytes  ${label}`);
  written += 1;
};

for (const sprite of SPRITES) {
  await put(sprite.file, encodePng(SIZE, paint(SIZE, sprite.shade)), sprite.name);
}
for (const chip of CHIPS) {
  await put(chip.file, encodeGlb(chip.build()), chip.name);
}

console.log(`\n${written} written, ${skipped} skipped`);

// The manifest the preset seeder and the docs read, so the pack's contents are
// described in exactly one place.
export const PRESET_ASSET_PACK = [
  ...SPRITES.map((entry) => ({ ...entry, kind: 'image' })),
  ...CHIPS.map((entry) => ({ ...entry, kind: 'mesh' })),
].map(({ file, name, kind, note }) => ({ file, name, kind, note }));
