// Tagging results at the moment they are generated.
//
// Tags themselves live behind /api/assets/:id/tags (see tools/assets.js). This
// module is what lets a GENERATION tool carry a `tags` input: a generate call
// that takes minutes would otherwise have to be followed by a separate
// tag_asset call per result, and an agent that forgets the second call leaves
// the asset untagged and unfindable.
//
// Applied client-side, after the save, for a deliberate reason: the generation
// routes each save through their own path (root asset / edit / version), and
// threading a tag list through every one of them would touch far more code than
// one PATCH per saved id. The trade-off is that tagging is a separate request,
// so it can fail on its own — which is exactly why a failure here NEVER throws
// (see applyAssetTags).
import { z } from 'zod';

// Mirrors storage.js: MAX_TAGS_PER_ASSET. Rejecting at the schema is friendlier
// than letting the server silently drop the overflow.
const MAX_TAGS = 50;

/**
 * The shared optional `tags` input. Every generation tool spells it the same
 * way so a client learns it once.
 *
 * KEPT SHORT DELIBERATELY. This description is repeated in the tools/list
 * catalog of all 13 tools that carry it, and a client injects that catalog into
 * the model's system prompt on every request (see TOOL_GROUPS in index.js) — a
 * paragraph here costs more context than the whole feature saves. The full
 * rules live once in the server instructions instead.
 */
export const tagsInput = z.array(z.string().min(1)).max(MAX_TAGS).optional()
  .describe('Tags for the generated asset(s), applied as soon as they are saved, so find_assets_by_tags can find them later. Additive, normalized server-side (lower-cased, whitespace-collapsed); list_asset_tags shows the vocabulary already in use. Never fails the generation — a failure comes back as tagWarnings.');

/** Numeric asset ids out of a mixed list of asset records and bare ids. */
function assetIdsOf(assets) {
  const ids = [];
  for (const asset of Array.isArray(assets) ? assets : [assets]) {
    const id = Number(typeof asset === 'object' && asset !== null ? asset.id : asset);
    if (Number.isFinite(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Add `tags` to every saved asset and return the fields to merge into the
 * tool's result: `taggedAssets` (the resulting tag list per asset) and, only
 * when something went wrong, `tagWarnings`.
 *
 * NEVER THROWS. The asset is already generated and saved by the time this
 * runs — often after minutes of provider time — so a tagging failure must not
 * turn a successful generation into a tool error the caller reads as "it did
 * not work" and retries. It is reported instead, and tag_asset fixes it up.
 *
 * Call sites pass the saved assets EXPLICITLY rather than handing over the raw
 * response: some responses carry the id of the asset the result was derived
 * FROM (edit_image returns the source's `assetId` beside its `savedEdits`), and
 * a generic walk of the payload would tag the input.
 */
export async function applyAssetTags(api, tags, assets) {
  if (!Array.isArray(tags) || tags.length === 0) return {};

  const assetIds = assetIdsOf(assets);
  if (assetIds.length === 0) {
    return { tagWarnings: [`Tags ${JSON.stringify(tags)} were not applied: the result carried no saved asset id. Find the asset with list_assets and tag it with tag_asset.`] };
  }

  const taggedAssets = [];
  const tagWarnings = [];
  for (const assetId of assetIds) {
    try {
      const result = await api.apiJson('PATCH', `/assets/${assetId}/tags`, { body: { add: tags } });
      taggedAssets.push({ assetId, tags: result?.tags || [] });
    } catch (err) {
      tagWarnings.push(`Asset ${assetId} was generated and saved, but tagging it failed: ${err?.message || err}. Retry with tag_asset.`);
    }
  }

  return { taggedAssets, ...(tagWarnings.length > 0 ? { tagWarnings } : {}) };
}
