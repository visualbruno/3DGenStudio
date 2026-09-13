// The VFX export bundle, read back.
//
// THE MIRROR OF buildVfxExport (storage.js). That function turns one saved
// effect into a folder - `manifest.json`, the graph under `vfx/`, every texture
// and mesh under `assets/` - and this module is what turns that folder back
// into an effect in somebody else's library.
//
// THE SAME PROBLEM PRESETS HAVE, AND THE SAME ANSWER. `asset:41` is a row in
// the exporting machine's database. On the importing machine 41 is either
// nothing or, far worse, an unrelated image - and the importer can never see
// that breakage, because their library really does contain a 41. So the bundle
// does not carry ids that mean anything here: it carries FILES, and importing
// installs those files and rewrites every slot to whatever ids they got in this
// library. What lands in the library afterwards is an utterly ordinary document
// with ordinary local ids, which is the point - the compiler, the runtime, the
// exporter and the engine plugins all keep working unchanged.
//
// A SLOT WHOSE FILE IS NOT IN THE BUNDLE IS EMPTIED, NOT LEFT ALONE. That is
// the single most important line in this module. Export records a reference
// with `file: null` when the asset had already been deleted from the source
// library (it warns, MISSING_ASSET, and ships the bundle anyway - a
// half-authored effect is the normal case). Carrying that slot's original
// `asset:41` across would point the imported effect at a stranger's texture,
// silently and undetectably. An EMPTY ref is what an unfilled slot looks like
// everywhere else in the system: the effect opens, draws with the built-in
// stand-in, and the diagnostics say a sprite is missing.
//
// PURE, AND IN vfx/ RATHER THAN src/utils/, for the reason vfx/index.js gives:
// the browser drives the import (it is the side that can read a folder the user
// picked and POST the bytes), but the server validates a graph it is handed,
// and neither may own the format. It is also what makes it testable with plain
// `node vfx/bundle.test.mjs`.

/**
 * Bumped when a change would make an existing importer plugin MISREAD a bundle.
 * A plugin - and this importer - declares the range it supports and must refuse
 * anything outside it rather than half-importing, the same contract
 * VFX_IR_FORMAT states for the IR inside.
 *
 * Defined here rather than in storage.js so the writer and the reader of a
 * bundle cannot drift apart; storage.js re-exports it.
 */
export const VFX_BUNDLE_FORMAT = 1;

/** The lowest bundle format this importer still understands. */
export const VFX_BUNDLE_MIN_FORMAT = 1;

const ASSET_REF = /^asset:(\d+)$/;

const str = (value) => (typeof value === 'string' ? value : '');

/** A bundle path, in the one spelling a lookup can match on. */
export function normalizeBundlePath(value) {
  return str(value).replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

/**
 * An error a human should read verbatim.
 *
 * Every refusal in this module is something the person who picked the folder
 * can act on - wrong folder, a newer app wrote it, the file is damaged - so the
 * message is the whole product and a generic "import failed" would be useless.
 */
export class VfxBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VfxBundleError';
  }
}

/**
 * Parse and check a `manifest.json`.
 *
 * WHAT IS ACTUALLY REQUIRED IS SMALL, on purpose: the format marker and a
 * graph. Everything else a manifest carries - the IR, the stats, the engine
 * mapping, the warnings - is for an ENGINE plugin, and refusing a bundle for a
 * missing `stats` block would reject bundles this importer could read perfectly
 * well. The IR in particular is deliberately ignored: it is a compiled artefact
 * and this side recompiles from the graph, so trusting it would be trusting a
 * cache over its source.
 *
 * @param {string|Object} input the file's text, or an already-parsed object
 * @returns {Object} the manifest
 */
export function parseBundleManifest(input) {
  let manifest = input;
  if (typeof input === 'string') {
    try {
      manifest = JSON.parse(input);
    } catch {
      throw new VfxBundleError('manifest.json is not valid JSON. The bundle may be damaged.');
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new VfxBundleError('manifest.json does not describe a VFX bundle.');
  }

  const format = Number(manifest.bundleFormat);
  if (!Number.isFinite(format)) {
    throw new VfxBundleError(
      'That folder has a manifest.json, but it is not a VFX export bundle - it carries no bundleFormat.'
    );
  }
  if (format > VFX_BUNDLE_FORMAT) {
    throw new VfxBundleError(
      `This bundle was written by a newer version of the app (format ${format}; this one reads up to ${VFX_BUNDLE_FORMAT}). Update before importing it.`
    );
  }
  if (format < VFX_BUNDLE_MIN_FORMAT) {
    throw new VfxBundleError(
      `This bundle is in format ${format}, which this version no longer reads.`
    );
  }

  // The graph may live in the manifest or beside it. Both are valid: the
  // manifest embeds it, AND the same bytes are written to vfx/ so the folder
  // is self-describing without the manifest. Only the caller can read a second
  // file, so this reports which it needs rather than fetching it.
  const graph = manifest.graph && typeof manifest.graph === 'object' ? manifest.graph : null;
  const file = normalizeBundlePath(manifest.asset?.file);
  if (!graph && !file) {
    throw new VfxBundleError('The bundle carries no effect - neither an embedded graph nor a vfx/ file.');
  }
  return manifest;
}

/**
 * Where the effect's document is: embedded, or a file to read.
 *
 * @param {Object} manifest
 * @returns {{graph: Object|null, file: string}}
 */
export function bundleGraphSource(manifest) {
  return {
    graph: manifest?.graph && typeof manifest.graph === 'object' ? manifest.graph : null,
    file: normalizeBundlePath(manifest?.asset?.file),
  };
}

/** The effect's name as the exporting library knew it. */
export function bundleEffectName(manifest) {
  return str(manifest?.asset?.name).trim();
}

/** The card image's path inside the bundle, if it shipped one. */
export function bundleThumbnailPath(manifest) {
  return normalizeBundlePath(manifest?.asset?.thumbnail);
}

/**
 * Every file in the bundle that has to be installed into this library, and the
 * slot that wants it.
 *
 * SLOTS WITH NO FILE ARE STILL RETURNED, with `file: ''`. They are exactly the
 * ones that must be EMPTIED rather than carried across (see the module header),
 * and a caller that only saw the installable ones would have no way to know
 * they existed. `applyBundleAssets` is what acts on the distinction.
 *
 * TWO SLOTS CAN NAME ONE FILE. Export dedups by destination path, so an effect
 * using the same sprite in two systems ships one copy - which is why the caller
 * keys its uploads by `file` and not by `slot`, and uploads each file once.
 *
 * @param {Object} manifest
 * @returns {Array<{slot: string, kind: string, file: string, name: string, hadRef: boolean}>}
 */
export function bundleAssetNeeds(manifest) {
  const references = Array.isArray(manifest?.references) ? manifest.references : [];
  const needs = [];
  for (const entry of references) {
    const slot = str(entry?.slot);
    if (!slot) continue;
    needs.push({
      slot,
      kind: entry?.kind === 'mesh' ? 'mesh' : entry?.kind === 'vfx' ? 'vfx' : 'image',
      file: normalizeBundlePath(entry?.file),
      // The ASSET's name first: it is what the exporting library called the
      // file and therefore what a name-match against this library can hit. The
      // slot's display name is the fallback, and it is only a label.
      name: str(entry?.assetName).trim() || str(entry?.name).trim(),
      hadRef: ASSET_REF.test(str(entry?.ref)),
    });
  }
  return needs;
}

/**
 * Point a bundle's document at the ids its files got in THIS library.
 *
 * Close kin to applyPresetAssets, and deliberately not the same function: that
 * one leaves a slot it cannot resolve untouched, which is right for a preset
 * (a preset's refs are already empty - validatePreset refuses any that are
 * not). A bundle's refs are the EXPORTING machine's ids, so leaving one alone
 * is the silent-wrong-texture bug this module exists to prevent. Everything
 * unresolved is cleared.
 *
 * @param {Object} doc a normalized VFX document
 * @param {Array<Object>} needs from bundleAssetNeeds
 * @param {Map<string, number>|Object} idsByFile bundle path to local asset id
 * @returns {{doc: Object, resolved: Object[], missing: Object[]}}
 */
export function applyBundleAssets(doc, needs, idsByFile) {
  const references = { ...(doc?.references || {}) };
  const lookup = (file) => (idsByFile instanceof Map ? idsByFile.get(file) : idsByFile?.[file]);
  const resolved = [];
  const missing = [];

  for (const need of Array.isArray(needs) ? needs : []) {
    const slot = references[need.slot];
    if (!slot) {
      // A manifest naming a slot the document does not have. Nothing to write,
      // and nothing to clear - but worth reporting rather than swallowing,
      // because it means the two halves of the bundle disagree.
      missing.push({ ...need, reason: 'the effect has no such slot' });
      continue;
    }
    const id = Number(lookup(need.file));
    if (need.file && Number.isFinite(id) && id > 0) {
      references[need.slot] = {
        ...slot,
        ref: `asset:${id >>> 0}`,
        name: need.name || slot.name || '',
      };
      resolved.push({ ...need, assetId: id });
      continue;
    }
    references[need.slot] = { ...slot, ref: '' };
    // A SLOT THE AUTHOR NEVER FILLED IS NOT A PROBLEM. It had no ref and no
    // file, it arrives empty and it stays empty - reporting it would mean every
    // effect with a spare texture block imports "with 3 warnings", which is how
    // a warning list stops being read.
    if (!need.file && !need.hadRef) continue;
    missing.push({
      ...need,
      reason: need.file
        ? 'its file could not be added to your library'
        // The export already warned about this one (MISSING_ASSET); repeating
        // it here is what turns a warning buried in the manifest into
        // something the person importing actually sees.
        : 'the bundle shipped without that file',
    });
  }

  // Any slot the manifest never mentioned. It cannot have travelled with a
  // file, so its ref is a foreign id by definition.
  for (const [slot, entry] of Object.entries(references)) {
    if (!ASSET_REF.test(str(entry?.ref))) continue;
    if (resolved.some((need) => need.slot === slot)) continue;
    references[slot] = { ...entry, ref: '' };
    missing.push({
      slot,
      kind: entry?.kind || 'image',
      file: '',
      name: str(entry?.name),
      hadRef: true,
      reason: 'the manifest does not list it',
    });
  }

  return { doc: { ...doc, references }, resolved, missing };
}

/**
 * The warnings the EXPORT recorded, worth repeating to whoever is importing.
 *
 * Infos are dropped by buildVfxExport already; what is left is compile errors
 * and missing assets, and both change what the imported effect will look like.
 *
 * @param {Object} manifest
 * @returns {Array<{code: string, severity: string, message: string}>}
 */
export function bundleWarnings(manifest) {
  const warnings = Array.isArray(manifest?.warnings) ? manifest.warnings : [];
  return warnings
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      code: str(entry.code) || 'WARNING',
      severity: entry.severity === 'error' ? 'error' : 'warn',
      message: str(entry.message),
    }));
}

/**
 * A one-line description of what a picked folder holds, for the dialog to show
 * BEFORE anything is written.
 *
 * @param {Object} manifest
 * @returns {{name: string, textures: number, meshes: number, effects: number,
 *   empty: number, warnings: number, appVersion: string, exportedAt: number}}
 */
export function summarizeBundle(manifest) {
  const needs = bundleAssetNeeds(manifest);
  const withFile = needs.filter((need) => need.file);
  return {
    name: bundleEffectName(manifest),
    textures: withFile.filter((need) => need.kind === 'image').length,
    meshes: withFile.filter((need) => need.kind === 'mesh').length,
    effects: withFile.filter((need) => need.kind === 'vfx').length,
    empty: needs.length - withFile.length,
    warnings: bundleWarnings(manifest).length,
    appVersion: str(manifest?.appVersion),
    exportedAt: Number(manifest?.exportedAt) || 0,
  };
}
