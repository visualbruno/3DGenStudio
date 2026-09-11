import { deflateSync } from 'node:zlib';
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

