// Reading an /api/assets/library listing: ids, and the edits hanging off a root.
//
// PURE ON PURPOSE, and split out of vfxApi.js for one reason: that module
// imports src/config.js, which reads `import.meta.env` and therefore cannot be
// imported by a node test at all. The two functions here are where the bugs
// live, so they had to be somewhere testable.
//
// THE TWO AWKWARD FACTS ABOUT A LIBRARY LISTING, both of which have already
// been got wrong by hand at more than one call site:
//
//   1. A ROOT'S id IS THE STRING `library:<n>`; A CHILD'S IS A BARE NUMBER.
//      `listLibraryAssetsByType` mints the prefixed form for roots (it also
//      exposes the unprefixed `assetId` beside it) while `mapChildAssetRow`
//      returns `row.id` untouched. Anything parsing an id itself has to accept
//      both, and code that does `String(id).replace('library:', '')` happens to
//      work only because replace on a bare number is a no-op.
//   2. AN EDIT OR A VERSION IS ITS OWN `Assets` ROW, with its own id and its own
//      file - it is not a variant of the parent's file. So a graph can reference
//      one with the same `asset:<id>` string it uses for a root, and project
//      export/import carries it with no extra work. But an index built from
//      roots alone resolves an edit to NOTHING, which looks exactly like a
//      deleted asset: the reference is intact and the texture never appears.

/**
 * The numeric id behind an asset, an id string, or a `library:<id>` handle.
 *
 * Returns null rather than NaN for anything unrecognised, so a caller can test
 * it with `== null` instead of remembering Number.isFinite.
 *
 * @param {Object|string|number|null} asset
 * @returns {number|null}
 */
export function vfxAssetId(asset) {
  if (asset == null) return null
  if (typeof asset === 'number') return Number.isFinite(asset) ? asset : null
  if (typeof asset === 'object') return vfxAssetId(asset.id ?? asset.assetId ?? null)
  const match = /^(?:library:)?(\d+)$/.exec(String(asset).trim())
  return match ? Number(match[1]) : null
}

/**
 * Index library rows by the asset id a graph would reference.
 *
 * Descends into `children` (aliased as `edits` by the server) so an edit or a
 * version resolves like any other asset - see fact 2 in the header.
 *
 * @param {Array<Object>} rows rows from /api/assets/library, of any type
 * @returns {Map<number, Object>}
 */
export function indexLibraryAssets(rows) {
  const byId = new Map()
  for (const row of rows || []) {
    const id = vfxAssetId(row)
    if (id != null) byId.set(id, row)
    for (const child of row?.children || row?.edits || []) {
      const childId = vfxAssetId(child)
      if (childId != null) byId.set(childId, child)
    }
  }
  return byId
}
