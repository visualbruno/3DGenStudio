import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

// A minimal PNG encoder.
//
// WHY HAND-ROLLED. There is no image library in this project's dependencies -
// no sharp, no pngjs, no canvas - and `zlib` is a node builtin, so this file
// has none either. It does exactly one thing: 8-bit RGBA, non-interlaced, no
// filtering. It is not a general-purpose encoder and should not grow into one;
// if more is ever needed, that is the moment to take a dependency.
//
// IT LIVES IN vfx/ BECAUSE TWO SHIPPED THINGS NEED IT: the preset asset
// generator in tools/, and vfx/preview.js, which renders effects on the server
// where there is no canvas to encode with. vfx/ is the shared, pure, packaged
// layer, so it is the only place both can import from without one of them
// reaching sideways into the other.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

/**
 * Encode straight-alpha RGBA bytes as a PNG.
 *
 * STRAIGHT ALPHA, NOT PREMULTIPLIED - which is what PNG stores and what the
 * texture loader expects. A sprite premultiplied on the way in would be
 * multiplied by its alpha a second time by the additive blend and the soft edge
 * of every particle would vanish.
 *
 * @param {number} width
 * @param {Uint8Array} rgba width*height*4 bytes
 * @param {number} [height] defaults to `width`, i.e. a square
 * @returns {Buffer}
 */
export function encodePng(width, rgba, height = width) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // 8 bits per channel
  header[9] = 6;   // colour type 6: truecolour with alpha
  header[10] = 0;  // deflate
  header[11] = 0;  // adaptive filtering
  header[12] = 0;  // no interlace

  // One filter byte per scanline. Filter 0 (None) throughout: these sprites are
  // smooth gradients that deflate well regardless, and None keeps the writer
  // trivially correct.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- decoding ----------------------------------------------------------------
//
// WHY THERE IS A DECODER HERE AT ALL. An agent could not LOOK at a sprite it had
// just wired into an effect: a 1024x1024 RGBA PNG is about a megabyte, base64
// inflates that by a third, and the result is refused by the transport before
// any code here gets a say. The answer is to shrink the image server-side,
// which means decoding it, and there is no image library in this project.
//
// DELIBERATELY PARTIAL. 8-bit, non-interlaced, colour types 0/2/3/4/6 - which
// is everything this app writes and the overwhelming majority of real PNGs.
// 16-bit and Adam7 return null rather than guessing, and the caller falls back
// to telling the truth about why it cannot show the picture. A decoder that
// half-reads an unusual file would produce a plausible wrong image, which is
// worse than no image.

const BYTES_PER_PIXEL = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode a PNG to straight-alpha RGBA.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {{width: number, height: number, rgba: Uint8Array}|null} null when
 *   the file is a shape this decoder does not read
 */
export function decodePng(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;

  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    at += 12 + length; // length + type + data + crc

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colourType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (depth !== 8 || interlace !== 0 || !BYTES_PER_PIXEL[colourType]) return null;
  if (!width || !height || idat.length === 0) return null;
  if (colourType === 3 && !palette) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const channels = BYTES_PER_PIXEL[colourType];
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  // Un-filter in place, row by row. Each row's filter byte says how it was
  // encoded relative to the pixel left of it and the row above.
  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i];
      const a = i >= channels ? lines[dst + i - channels] : 0;
      const b = y > 0 ? lines[up + i] : 0;
      const c = y > 0 && i >= channels ? lines[up + i - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: return null;
      }
      lines[dst + i] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const at4 = i * 4;
    const atN = i * channels;
    if (colourType === 6) {
      rgba[at4] = lines[atN];
      rgba[at4 + 1] = lines[atN + 1];
      rgba[at4 + 2] = lines[atN + 2];
      rgba[at4 + 3] = lines[atN + 3];
    } else if (colourType === 2) {
      rgba[at4] = lines[atN];
      rgba[at4 + 1] = lines[atN + 1];
      rgba[at4 + 2] = lines[atN + 2];
      rgba[at4 + 3] = 255;
    } else if (colourType === 0) {
      const g = lines[atN];
      rgba[at4] = g; rgba[at4 + 1] = g; rgba[at4 + 2] = g; rgba[at4 + 3] = 255;
    } else if (colourType === 4) {
      const g = lines[atN];
      rgba[at4] = g; rgba[at4 + 1] = g; rgba[at4 + 2] = g;
      rgba[at4 + 3] = lines[atN + 1];
    } else {
      const index = lines[atN];
      rgba[at4] = palette[index * 3] ?? 0;
      rgba[at4 + 1] = palette[index * 3 + 1] ?? 0;
      rgba[at4 + 2] = palette[index * 3 + 2] ?? 0;
      rgba[at4 + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Box-filter downscale.
 *
 * AVERAGED, NOT SAMPLED. Nearest-neighbour on a soft particle sprite drops the
 * faint outer falloff entirely - which would make a perfectly good sprite look
 * hard-edged in the preview, and hard edges are exactly what somebody shrinking
 * a sprite is usually checking for. Getting that wrong would make this tool
 * report the bug it exists to rule out.
 *
 * @param {{width: number, height: number, rgba: Uint8Array}} image
 * @param {number} maxSide longest edge of the result
 * @returns {{width: number, height: number, rgba: Uint8Array, scale: number}}
 */
export function downscaleRgba(image, maxSide) {
  const factor = Math.max(image.width, image.height) / Math.max(1, maxSide);
  if (factor <= 1) return { ...image, scale: 1 };

  const width = Math.max(1, Math.round(image.width / factor));
  const height = Math.max(1, Math.round(image.height / factor));
  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));

      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * image.width + sx) * 4;
          const alpha = image.rgba[at + 3];
          // COLOUR WEIGHTED BY ALPHA. Averaging the colour of transparent
          // pixels in is how a shrunken sprite picks up a dark halo: the fully
          // clear pixels around a sprite are usually black, and an unweighted
          // mean drags the soft edge towards them.
          r += image.rgba[at] * alpha;
          g += image.rgba[at + 1] * alpha;
          b += image.rgba[at + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const at = (y * width + x) * 4;
      const weight = a || 1;
      out[at] = Math.round(r / weight);
      out[at + 1] = Math.round(g / weight);
      out[at + 2] = Math.round(b / weight);
      out[at + 3] = Math.round(a / n);
    }
  }
  return { width, height, rgba: out, scale: 1 / factor };
}

/**
 * Composite straight-alpha RGBA over a checkerboard.
 *
 * BECAUSE ALPHA IS USUALLY THE QUESTION. A particle sprite is mostly
 * transparent, and every viewer flattens it onto something - usually black,
 * which is indistinguishable from the sprite BEING black. Somebody checking
 * whether a matte came out hard-edged or clipped the wispy parts cannot tell
 * from that. A checkerboard shows the shape of the alpha directly: a hard cut
 * reads as a crisp boundary against the squares, a soft falloff as the squares
 * fading through.
 *
 * @param {{width: number, height: number, rgba: Uint8Array}} image
 * @param {number} [square] checker size in pixels
 * @returns {Uint8Array} opaque RGBA
 */
export function matteOnCheckerboard(image, square = 8) {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      const light = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      const base = light ? 153 : 102;
      const a = image.rgba[at + 3] / 255;
      out[at] = Math.round(image.rgba[at] * a + base * (1 - a));
      out[at + 1] = Math.round(image.rgba[at + 1] * a + base * (1 - a));
      out[at + 2] = Math.round(image.rgba[at + 2] * a + base * (1 - a));
      out[at + 3] = 255;
    }
  }
  return out;
}
