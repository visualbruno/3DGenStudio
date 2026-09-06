// Laying every piece's UVs out into one shared atlas (or a few).
//
// The layout half of "merge the assembly into one mesh with one texture". It is
// deliberately pure — plain typed arrays in, plain typed arrays out, no
// three.js, no GPU — because it is the part with real algorithmic content and
// it should be testable without a browser. The baking half lives next door in
// assemblyAtlasBake.js.
//
// ---- Why repack, and not re-unwrap -------------------------------------------
//
// The app already has an unwrapper (Auto UV), and calling it on the merged mesh
// would be one line. It is the wrong tool here for two reasons:
//
//   * every piece already HAS a good unwrap, made for its own texture. Throwing
//     that away invents new seams in exchange for nothing;
//   * a fresh unwrap changes the parameterisation, which changes the tangent
//     frame, which invalidates every tangent-space normal map. Repacking only
//     TRANSLATES and UNIFORMLY SCALES an island, and neither changes the
//     direction of dP/du — so tangent-space normals transfer verbatim, with no
//     re-basis and no correction shader.
//
// That last point is why island rotation is OFF by default. A 90° rotation
// would rotate the tangent frame with it and every normal map would need its xy
// counter-rotated — a subtle, easy-to-get-backwards correction. It was measured
// first: on a real five-piece assembly, rotation changed the packing fill by
// nothing at all (69.4% either way at 4K, 88.3% either way at 2K), because with
// thousands of small islands the skyline finds a good spot regardless of
// orientation. Paying a correctness risk for zero space would be a bad trade.
//
// ---- Islands are just index-connected components ------------------------------
//
// A glTF exporter splits a vertex wherever the UV seams, so two triangles on
// opposite sides of a seam do not share vertex indices. Connectivity over the
// INDEX buffer is therefore already UV connectivity — no UV comparison needed,
// and no epsilon to tune.
//
// ---- Preserving texel density is preserving pixel footprint -------------------
//
// The usual formulation involves areas and square roots. It is simpler than
// that: an island that occupies (w x h) of a piece's 0..1 UV space covers
// (w*texSize, h*texSize) PIXELS of that piece's texture. Give it the same number
// of pixels in the atlas and its density is unchanged, whatever the piece's
// original texture size was. So a 2K armour's islands are simply bigger boxes
// than a 1K boot's, and the packer needs no notion of density at all.

/** Connected components of faces over shared vertex indices. */
export function extractIslands(indices, vertexCount) {
  const parent = new Uint32Array(vertexCount)
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i

  const find = x => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) { const next = parent[x]; parent[x] = root; x = next }
    return root
  }
  const union = (a, b) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  const faces = indices.length / 3
  for (let f = 0; f < faces; f += 1) {
    const a = indices[f * 3]; const b = indices[f * 3 + 1]; const c = indices[f * 3 + 2]
    union(a, b); union(b, c)
  }

  // Group faces by the root of their first corner.
  const byRoot = new Map()
  for (let f = 0; f < faces; f += 1) {
    const root = find(indices[f * 3])
    let list = byRoot.get(root)
    if (!list) { list = []; byRoot.set(root, list) }
    list.push(f)
  }
  return [...byRoot.values()]
}


/** The 0..1 UV bounds of a set of faces. */
function islandBounds(indices, uv, faceList) {
  let minU = Infinity; let minV = Infinity
  let maxU = -Infinity; let maxV = -Infinity
  for (const f of faceList) {
    for (let k = 0; k < 3; k += 1) {
      const v = indices[f * 3 + k]
      const u = uv[v * 2]; const w = uv[v * 2 + 1]
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (w < minV) minV = w
      if (w > maxV) maxV = w
    }
  }
  return { minU, minV, width: maxU - minU, height: maxV - minV }
}


/**
 * Skyline (bottom-left) bin packer, in TEXELS.
 *
 * Same algorithm as the Python autouv packer this app already uses for Auto UV
 * (services/autouv/pack.py): boxes tallest-first, each placed at the lowest
 * left-most spot the skyline allows, rotated 90° when that wastes less height.
 * Reimplemented rather than called because the bake that consumes the result is
 * necessarily client-side — the textures are in the browser — and a round trip
 * for UV data alone would add a protocol and a failure mode to something that
 * takes milliseconds here.
 *
 * Unlike that one, this packs into a FIXED bin and reports what did not fit,
 * because the whole point is deciding how many atlases are needed.
 */
function skylinePack(boxes, binSize, allowRotation = true) {
  const skyline = [[0, 0, binSize]]           // [x, topY, width]
  const placed = []
  const overflow = []

  const levelFor = (start, width) => {
    let x = skyline[start][0]
    let remaining = width
    let y = 0
    for (let i = start; i < skyline.length && remaining > 0; i += 1) {
      y = Math.max(y, skyline[i][1])
      remaining -= skyline[i][2]
    }
    return remaining > 0 ? null : { x, y }
  }

  const addAt = (x, y, w, h) => {
    // Replace the covered span with one segment at the new height.
    const next = []
    let cursor = 0
    for (const segment of skyline) {
      const [sx, sy, sw] = segment
      if (sx + sw <= x || sx >= x + w) { next.push(segment); continue }
      if (sx < x) next.push([sx, sy, x - sx])
      if (sx + sw > x + w) next.push([x + w, sy, sx + sw - (x + w)])
      cursor = 1
    }
    if (cursor) next.push([x, y + h, w])
    next.sort((a, b) => a[0] - b[0])
    // Merge equal-height neighbours so the skyline does not fragment forever.
    skyline.length = 0
    for (const segment of next) {
      const last = skyline[skyline.length - 1]
      if (last && last[1] === segment[1] && last[0] + last[2] === segment[0]) {
        last[2] += segment[2]
      } else skyline.push(segment)
    }
  }

  const order = boxes.map((b, i) => i).sort((a, b) =>
    Math.max(boxes[b].w, boxes[b].h) - Math.max(boxes[a].w, boxes[a].h))

  for (const index of order) {
    const box = boxes[index]
    let best = null
    for (const rotated of (allowRotation ? [false, true] : [false])) {
      const w = rotated ? box.h : box.w
      const h = rotated ? box.w : box.h
      if (w > binSize || h > binSize) continue
      // EVERY start position, not the first that fits. Stopping at the first
      // is a first-fit packer wearing a best-fit costume, and it cost roughly
      // half the atlas: measured on a real assembly, fill went from 38% to the
      // 70-80% this algorithm is supposed to reach.
      for (let start = 0; start < skyline.length; start += 1) {
        if (skyline[start][0] + w > binSize) break
        const spot = levelFor(start, w)
        if (!spot || spot.y + h > binSize) continue
        if (!best || spot.y < best.y || (spot.y === best.y && spot.x < best.x)) {
          best = { x: spot.x, y: spot.y, w, h, rotated, index }
        }
      }
    }
    if (best) { addAt(best.x, best.y, best.w, best.h); placed.push(best) }
    else overflow.push(index)
  }
  return { placed, overflow }
}


/**
 * Plan the atlas layout for a set of pieces.
 *
 * `pieces` are `{ id, indices, uv, vertexCount, textureSize }`. Returns the new
 * UVs per piece, which atlas each piece's islands landed in, and the stats the
 * UI needs to explain the outcome.
 *
 * `maxAtlases` is the user's cap. When the islands genuinely need more space
 * than that allows, everything is scaled down by ONE global factor and repacked
 * — a uniform loss of sharpness rather than some pieces silently losing more
 * than others.
 */
export function planAtlas(pieces, {
  size = 4096, maxAtlases = 1, padding = 4, allowRotation = false,
} = {}) {
  const islands = []
  for (const piece of pieces) {
    const groups = extractIslands(piece.indices, piece.vertexCount)
    for (const faceList of groups) {
      const bounds = islandBounds(piece.indices, piece.uv, faceList)
      if (!(bounds.width > 0) && !(bounds.height > 0)) continue
      islands.push({
        piece,
        faceList,
        ...bounds,
        // Its footprint in the SOURCE texture, in pixels. Carrying this through
        // is what preserves each piece's own texel density.
        texelW: bounds.width * piece.textureSize,
        texelH: bounds.height * piece.textureSize,
      })
    }
  }
  if (!islands.length) return null

  // Try at full density first, shrinking only if the cap forces it.
  let scale = 1
  let result = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const bins = []
    let remaining = islands.map((island, index) => ({
      index,
      w: island.texelW * scale + padding * 2,
      h: island.texelH * scale + padding * 2,
    }))
    // An island larger than the whole atlas can never be placed; the global
    // scale below is what eventually brings it inside.
    const tooBig = remaining.some(box => box.w > size || box.h > size)

    while (remaining.length && bins.length < maxAtlases && !tooBig) {
      const { placed, overflow } = skylinePack(remaining, size, allowRotation)
      if (!placed.length) break                 // no progress: bail to a rescale
      bins.push(placed.map(p => ({ ...p, island: remaining[p.index].index })))
      remaining = overflow.map(i => remaining[i])
    }

    if (!tooBig && !remaining.length && bins.length) { result = bins; break }
    scale *= 0.85
  }
  if (!result) return null

  // ---- write the new UVs ----------------------------------------------------
  const uvByPiece = new Map()
  const atlasByPiece = new Map()
  for (const piece of pieces) {
    uvByPiece.set(piece.id, new Float32Array(piece.vertexCount * 2))
    atlasByPiece.set(piece.id, new Set())
  }

  let usedTexels = 0
  result.forEach((bin, atlasIndex) => {
    for (const placement of bin) {
      const island = islands[placement.island]
      const target = uvByPiece.get(island.piece.id)
      atlasByPiece.get(island.piece.id).add(atlasIndex)
      usedTexels += placement.w * placement.h

      // Placement is in texels; UVs are 0..1 of the atlas.
      const originU = (placement.x + padding) / size
      const originV = (placement.y + padding) / size
      const spanU = (placement.w - padding * 2) / size
      const spanV = (placement.h - padding * 2) / size

      for (const face of island.faceList) {
        for (let k = 0; k < 3; k += 1) {
          const v = island.piece.indices[face * 3 + k]
          // Normalised position inside the island, 0..1.
          const localU = island.width > 0 ? (island.piece.uv[v * 2] - island.minU) / island.width : 0
          const localV = island.height > 0 ? (island.piece.uv[v * 2 + 1] - island.minV) / island.height : 0
          // A rotated island swaps the axes. Only 90°, never a mirror: a mirror
          // would flip the tangent frame's handedness and turn every normal map
          // inside out.
          const u = placement.rotated ? localV : localU
          const w = placement.rotated ? 1 - localU : localV
          target[v * 2] = originU + u * spanU
          target[v * 2 + 1] = originV + w * spanV
        }
      }
    }
  })

  return {
    uvByPiece,
    atlasByPiece,
    // Which islands (and so which rotations) landed where — the bake needs the
    // rotation to correct tangent-space normals.
    placements: result.map(bin => bin.map(p => ({
      pieceId: islands[p.island].piece.id,
      faceList: islands[p.island].faceList,
      rotated: p.rotated,
    }))),
    atlasCount: result.length,
    scale,
    fill: usedTexels / (result.length * size * size),
    islandCount: islands.length,
  }
}


/**
 * The atlas size and count this set of pieces actually wants.
 *
 * Offered as a recommendation rather than applied silently: the honest answer
 * depends on what the asset is for, and a 4K atlas that the user's target
 * cannot upload is worse than two 2K ones.
 */
export function recommendAtlas(pieces, { maxSize = 4096, fillTarget = 0.75 } = {}) {
  let texels = 0
  for (const piece of pieces) {
    // Whole-texture area is the right estimate here: island bounds are not known
    // until they are extracted, and this only has to size the bin.
    texels += piece.textureSize * piece.textureSize
  }
  const needed = texels / fillTarget
  const oneAtlas = Math.min(maxSize, 2 ** Math.ceil(Math.log2(Math.sqrt(needed))))
  return {
    size: Math.max(1024, oneAtlas),
    atlases: Math.max(1, Math.ceil(needed / (oneAtlas * oneAtlas))),
    megatexels: Math.round(texels / 1e6 * 10) / 10,
  }
}
