// A minimal ZIP writer, store-only (no compression).
//
// Why not a library: the one thing the app needs to zip is a handful of GLBs,
// which are already compact binary — DEFLATE would spend CPU to save a few
// percent. Store-only is the whole format minus the compressor: a local header
// per file, a central directory, and an end-of-central-directory record. That
// is small enough to own outright rather than take a dependency and a bundle
// entry for.
//
// Produces a standard archive that Explorer, Finder, unzip and Python's zipfile
// all read. Deliberately NOT Zip64: the 4GB limits below are far beyond any
// plausible use here, and supporting them would double the size of this file.

// CRC-32 (IEEE 802.3), table-driven. The table is built once on first use —
// computing it eagerly at module load would cost every page that imports this,
// including the ones that never zip anything.
let crcTable = null

function getCrcTable() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c >>> 0
  }
  return crcTable
}

function crc32(bytes) {
  const table = getCrcTable()
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ZIP stores timestamps as MS-DOS date/time: a 1980-epoch packed pair. Anything
// before 1980 is unrepresentable, hence the clamp.
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function toBytes(content) {
  if (content instanceof Uint8Array) return content
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  return new TextEncoder().encode(String(content))
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{name: string, data: Uint8Array|ArrayBuffer|string}>} files
 * @returns {Blob} the archive, ready to hand to a download link
 */
export function createZip(files, { modified = new Date() } = {}) {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(modified)

  const locals = []
  const centrals = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const data = toBytes(file.data)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034B50, true)   // local file header signature
    localView.setUint16(4, 20, true)           // version needed (2.0)
    // Bit 11 marks the name as UTF-8, which is what makes non-ASCII filenames
    // extract correctly rather than as mojibake.
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)            // method 0 = stored
    localView.setUint16(10, time, true)
    localView.setUint16(12, date, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true) // compressed size
    localView.setUint32(22, data.length, true) // uncompressed size
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)           // extra field length
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014B50, true) // central directory signature
    centralView.setUint16(4, 20, true)         // version made by
    centralView.setUint16(6, 20, true)         // version needed
    centralView.setUint16(8, 0x0800, true)     // UTF-8 name
    centralView.setUint16(10, 0, true)         // stored
    centralView.setUint16(12, time, true)
    centralView.setUint16(14, date, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, 0, true)         // extra
    centralView.setUint16(32, 0, true)         // comment
    centralView.setUint16(34, 0, true)         // disk number
    centralView.setUint16(36, 0, true)         // internal attributes
    centralView.setUint32(38, 0, true)         // external attributes
    centralView.setUint32(42, offset, true)    // offset of the local header
    central.set(nameBytes, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054B50, true)       // end of central directory
  endView.setUint16(8, files.length, true)     // entries on this disk
  endView.setUint16(10, files.length, true)    // entries total
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)          // central directory offset

  return new Blob([...locals, ...centrals, end], { type: 'application/zip' })
}
