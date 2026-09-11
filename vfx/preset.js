// The VFX preset library: ready-made effects an author opens and tweaks.
//
// A PRESET IS DATA, NOT CODE, and that is the whole point of this module. The
// twelve starter effects that came before were JavaScript builder functions
// compiled into the bundle, which meant adding an effect was a code change, a
// rebuild and a release. Presets are JSON files under `resources/vfx/presets/`,
// so adding one is dropping a file, and editing one is a request the running
// app can serve.
//
// ONE FILE PER PRESET, FLAT, KEYED BY ID. Category is a field rather than a
// directory: re-filing an effect from "Impacts" to "Explosions" is then an edit
// and not a file move, and a preset can never be in two places or in none.
// There is deliberately NO manifest listing the files - the directory IS the
// index, so a manifest cannot drift out of step with what is on disk.
//
// NO ASSET IDS, BUT ASSETS ARE ALLOWED. `asset:41` is a row in the authoring
// machine's database; on an installation that has never seen that library it
// means nothing, or worse, somebody else's image - and the author can never see
// the breakage, because their library DOES contain 41. That is the trap tree
// presets shipped with.
//
// So a stored preset's references are always EMPTY, and what it needs is
// declared instead: `assets: [{ slot, file, kind, name }]`, where `file` names a
// file shipped in `resources/vfx/assets/`. A FILENAME IN A DIRECTORY THE APP
// OWNS is install-independent in the way a database id is not.
//
// Opening the preset installs those files into the local library (reusing what
// is already there) and rewrites the refs to whatever ids they got here - see
// `applyPresetAssets`. The effect that lands on the board is therefore an
// utterly ordinary document with ordinary asset ids, which is the point: the
// compiler, the runtime, the export bundle, the MCP tools and the eventual
// engine plugins all keep working, and the author can edit the texture like any
// other asset. The alternative - keeping the reference symbolic forever - would
// mean teaching every consumer of the IR a second kind of asset key, including
// two engine plugins that do not exist yet.
//
// This module is pure and lives in `vfx/` because BOTH sides need it: the
// server validates on write, and the browser normalises what it reads.

/** Bumped only when the on-disk shape changes in a way readers must know about. */
export const PRESET_FORMAT = 1;

/**
 * The category order shown in the dialog's rail.
 *
 * ORDERED, NOT ALPHABETICAL, and roughly by how likely a newcomer is to want
 * one: the first thing most people build is a fire or a hit, and nobody's first
 * effect is an interface flourish. A preset whose category is not in this list
 * still lists - it sorts to the end under its own heading - because a category
 * typo must not hide an effect.
 */
export const PRESET_CATEGORIES = Object.freeze([
  'Fire & Smoke',
  'Impacts & Hits',
  'Explosions',
  'Magic & Energy',
  'Weather',
  'Environment',
  'Liquids',
  'Sci-Fi & Tech',
  'Trails & Projectiles',
  'Creatures & Organic',
  'UI & Feedback',
]);

/**
 * Tags with a known meaning, used to build the filter chips.
 *
 * Tags are FREE-FORM on a preset - an unknown one still shows and still
 * filters, it simply gets no curated label - because a vocabulary that rejects
 * new words stops being used. What this table buys is grouping and wording in
 * the filter bar, so `one-shot` reads as "Plays once" to someone who has never
 * met the term.
 */
export const PRESET_TAGS = Object.freeze({
  // How it behaves in a scene. The first question anyone asks of an effect.
  looping: { label: 'Loops', group: 'Behaviour' },
  'one-shot': { label: 'Plays once', group: 'Behaviour' },
  staged: { label: 'Staged timing', group: 'Behaviour' },

  // How much of the machinery it uses. Shown so a newcomer can start somewhere
  // they can actually read.
  beginner: { label: 'Beginner', group: 'Level' },
  intermediate: { label: 'Intermediate', group: 'Level' },
  advanced: { label: 'Advanced', group: 'Level' },

  // What it demonstrates.
  additive: { label: 'Additive', group: 'Technique' },
  alpha: { label: 'Alpha blended', group: 'Technique' },
  stretched: { label: 'Stretched', group: 'Technique' },
  mesh: { label: 'Mesh particles', group: 'Technique' },
  collision: { label: 'Collision', group: 'Technique' },
  turbulence: { label: 'Turbulence', group: 'Technique' },
  attractor: { label: 'Attractor', group: 'Technique' },
  vortex: { label: 'Vortex', group: 'Technique' },
  'sub-emitter': { label: 'Sub-emitters', group: 'Technique' },
  flipbook: { label: 'Flipbook', group: 'Technique' },
});

/** A preset id: lowercase, safe as a filename and as a URL segment. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** A bundled asset filename: a plain name in resources/vfx/assets/, no path. */
export const PRESET_ASSET_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,60}\.(png|jpg|jpeg|webp|glb|gltf)$/i;

/** Which library asset type a declared need installs as. */
export const PRESET_ASSET_KINDS = Object.freeze(['image', 'mesh']);

const str = (value) => (typeof value === 'string' ? value.trim() : '');

function normalizeAssetNeed(input) {
  const source = input && typeof input === 'object' ? input : {};
  const file = str(source.file);
  return {
    // The reference slot in the document this file fills. Slots are named after
    // the block that owns them (see setSystemTexture), so they are stable
    // across a save and a reload.
    slot: str(source.slot),
    file,
    kind: PRESET_ASSET_KINDS.includes(source.kind) ? source.kind : 'image',
    // The display name it is installed under. This IS the dedup key - the
    // library listing does not project the metadata column (recorded in
    // vfxApi.js), so there is nowhere to hide a marker, and dedup by name is
    // what /api/setup/install-workflows already does.
    name: str(source.name) || file.replace(/\.[^.]+$/, ''),
  };
}

/**
 * The display name a bundled pack file installs under.
 *
 * THE TWO INSTALL PATHS MUST AGREE ON THIS. A preset carries its own `name` for
 * each asset it needs, and every one of them is the title-cased file stem -
 * "spark-streak.png" is "Spark Streak". Anything installing a pack file WITHOUT
 * a preset in hand - the MCP tools do exactly that - has to derive the same
 * string, because dedup is by name: derive it differently and the same file
 * lands in the library twice, once per path, and a preset opened afterwards
 * picks whichever it finds first.
 *
 * @param {string} file a pack filename, e.g. "smoke-roll-4x4.png"
 * @returns {string} e.g. "Smoke Roll 4x4"
 */
export function packAssetDisplayName(file) {
  return String(file || '')
    .replace(/\.[^.]+$/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The display name a bundled file is installed under.
 *
 * PREFIXED, deliberately. Dedup is by name, so an unprefixed "Flame Wisp" would
 * silently adopt any asset the user happened to have called that - and the
 * prefix also makes the installed set recognisable and sortable in the library
 * grid, which matters once a dozen of them are in there.
 *
 * @param {Object} need a normalized asset need, or `{name}` from
 *   packAssetDisplayName when installing a pack file without a preset
 * @returns {string}
 */
export function presetAssetName(need) {
  return `VFX ${need.name}`;
}

/**
 * Coerce anything read off disk into the shape the rest of the code expects.
 *
 * Total, and never throws: a preset with a missing field is still openable, and
 * a library that refuses to list because one file is malformed is worse than
 * one that lists it with an empty description. `validatePreset` is where a
 * WRITE is refused - this is the read path.
 *
 * @param {any} input
 * @param {string} [fallbackId] the filename's stem, when the file omits its id
 * @returns {Object} a normalized preset
 */
export function normalizePreset(input, fallbackId = '') {
  const source = input && typeof input === 'object' ? input : {};
  const tags = Array.isArray(source.tags)
    ? [...new Set(source.tags.map(str).filter(Boolean))]
    : [];
  return {
    format: Number(source.format) || PRESET_FORMAT,
    id: str(source.id) || str(fallbackId),
    name: str(source.name) || str(source.id) || str(fallbackId) || 'Untitled',
    category: str(source.category) || 'Environment',
    description: str(source.description),
    // Kept from the old template cards: naming the technique is the difference
    // between "here is a nice explosion" and "here is how staged timing works".
    teaches: Array.isArray(source.teaches) ? source.teaches.map(str).filter(Boolean) : [],
    tags,
    // What this preset needs from the bundled asset pack. Absent means nothing,
    // which is why adding this did not need a format bump: an older reader
    // ignores it and opens an effect drawing with the built-in sprite.
    // EVERY declared entry is kept, even a malformed one. Dropping it here
    // would be worse than carrying it: a discarded declaration means the effect
    // opens without its texture and nothing anywhere says why, whereas a kept
    // one is refused by validatePreset on save and reported by
    // applyPresetAssets on open.
    assets: Array.isArray(source.assets) ? source.assets.map(normalizeAssetNeed) : [],
    doc: source.doc && typeof source.doc === 'object' ? source.doc : null,
    // Written by the server from the filesystem, never authored by hand.
    updatedAt: str(source.updatedAt),
    hasThumbnail: Boolean(source.hasThumbnail),
  };
}

/**
 * The listing form: everything the dialog needs to draw a card, minus the
 * graph itself.
 *
 * The docs dominate the payload - a staged explosion is tens of kilobytes of
 * blocks - and the dialog needs none of it until something is clicked. Sixty
 * presets list in a few kilobytes this way instead of a megabyte.
 *
 * @param {Object} preset a normalized preset
 * @returns {Object}
 */
export function presetSummary(preset) {
  const { doc, ...rest } = preset;
  return { ...rest, systemCount: Array.isArray(doc?.systems) ? doc.systems.length : 0 };
}

/**
 * Check a preset before it is written to disk.
 *
 * @param {Object} preset
 * @returns {string[]} the reasons it cannot be saved; empty means it can
 */
export function validatePreset(preset) {
  const errors = [];
  if (!PRESET_ID_PATTERN.test(preset.id || '')) {
    errors.push('The id must be lowercase letters, digits and dashes, 2-49 characters.');
  }
  // NO CHECK FOR A MISSING NAME, deliberately: normalizePreset derives one from
  // the id and then from the filename, so by the time anything gets here a name
  // always exists. A check that can never fire is worse than no check - it
  // reads as coverage. The UI is where an empty name is refused, and a
  // hand-edited file with no name lists under its id rather than not at all.
  if (!preset.doc || !Array.isArray(preset.doc.systems) || preset.doc.systems.length === 0) {
    errors.push('The preset needs an effect with at least one system.');
  }
  // See the header: an asset id from the authoring machine is meaningless, or
  // actively wrong, anywhere else. The stored form is always id-free; what the
  // effect needs is declared in `assets` and resolved when it is opened.
  const references = preset.doc?.references;
  if (references && Object.values(references).some((entry) => entry && entry.ref)) {
    errors.push(
      'A preset cannot store library asset ids - they mean nothing on another '
      + 'installation. Add the image or mesh to the preset asset pack instead, '
      + 'which is what the Save dialog offers to do.',
    );
  }

  for (const need of preset.assets || []) {
    // A need with no slot can never be wired to anything, so it would install
    // a file and quietly achieve nothing.
    if (!need.slot) {
      errors.push(`The bundled asset "${need.file || '(unnamed)'}" does not say which slot it fills.`);
    }
    if (!PRESET_ASSET_FILE_PATTERN.test(need.file)) {
      errors.push(`"${need.file}" is not a valid bundled asset filename.`);
    }
    // A declaration pointing at a slot the document does not have would install
    // the file and then wire it to nothing - the effect would draw with the
    // blob and nothing would say why.
    if (references && !references[need.slot]) {
      errors.push(`The preset declares asset "${need.file}" for slot "${need.slot}", which the effect does not have.`);
    }
  }
  return errors;
}

/**
 * Index a library listing by the display name preset assets are installed under.
 *
 * LIVES HERE, NOT IN THE BROWSER MODULE THAT USES IT, for a mundane reason: the
 * browser module imports `config.js`, which reads `import.meta.env` and
 * therefore cannot be loaded under plain node - so anything testable has to sit
 * on this side of that line. src/utils/vfx/library.js exists for the same
 * reason. It is also the right home on the merits: dedup by name is part of the
 * format's contract, and `presetAssetName` is right above.
 *
 * ONLY PREFIXED ROWS COUNT. A user's own asset that happens to be called "Flame
 * Wisp" must not be adopted as though it came from the pack, or every fire
 * preset would quietly start drawing with whatever that is.
 *
 * @param {Array<Object>} rows library listing rows
 * @returns {Map<string, number>} display name to asset id
 */
export function indexInstalledPackAssets(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const name = str(row?.name).trim();
    if (!name.startsWith('VFX ')) continue;
    // The listing answers with either a bare id or a "library:<id>" handle
    // depending on the type - see the notes in vfxApi.js.
    const id = Number(String(row.id).replace('library:', ''));
    if (!Number.isFinite(id)) continue;
    // LOWEST WINS. Two rows with one name means a previous install raced or the
    // author duplicated one; taking the lower id keeps a preset opening the same
    // way every time instead of alternating between copies.
    const existing = byName.get(name);
    if (existing === undefined || id < existing) byName.set(name, id);
  }
  return byName;
}

/**
 * Point a preset's reference slots at the library ids its bundled files got
 * when they were installed here.
 *
 * This is the whole install-independence mechanism in one function: the stored
 * preset says "slot tex_b3_texture wants flame-wisp.png", the caller installs
 * that file and reports back "flame-wisp.png became asset 118", and this turns
 * the pair into `ref: "asset:118"`.
 *
 * IT REPORTS WHAT IT COULD NOT DO. A slot left empty because its file failed to
 * install produces an effect that silently draws with the built-in blob, which
 * looks exactly like a preset nobody bothered to give a texture - and this
 * project has been bitten repeatedly by a correct fallback with no report. So
 * the unresolved needs come back beside the document and the caller says so.
 *
 * @param {Object} doc the preset's document
 * @param {Object[]} assets normalized asset needs
 * @param {Map<string, number>|Object} idsByFile bundled filename to library id
 * @returns {{doc: Object, missing: Object[]}}
 */
export function applyPresetAssets(doc, assets, idsByFile) {
  const needs = Array.isArray(assets) ? assets : [];
  if (needs.length === 0 || !doc) return { doc, missing: [] };

  const lookup = (file) => (idsByFile instanceof Map ? idsByFile.get(file) : idsByFile?.[file]);
  const references = { ...(doc.references || {}) };
  const missing = [];
  let changed = false;

  for (const need of needs) {
    const id = Number(lookup(need.file));
    const slot = references[need.slot];
    if (!Number.isFinite(id) || id <= 0 || !slot) {
      missing.push(need);
      continue;
    }
    references[need.slot] = {
      ...slot,
      ref: `asset:${id}`,
      // The bundled name, so the params panel and the diagnostics name the
      // texture rather than showing an id.
      name: need.name || slot.name || '',
    };
    changed = true;
  }

  return { doc: changed ? { ...doc, references } : doc, missing };
}

/**
 * Group summaries for display: category order first, then name within a group.
 *
 * @param {Object[]} summaries
 * @returns {{category: string, presets: Object[]}[]}
 */
export function groupPresets(summaries) {
  const groups = new Map();
  for (const preset of summaries) {
    const key = preset.category || 'Environment';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(preset);
  }
  const rank = (category) => {
    const at = PRESET_CATEGORIES.indexOf(category);
    // An unlisted category sorts after every known one rather than to the
    // front, where a typo would push real categories down the rail.
    return at < 0 ? PRESET_CATEGORIES.length : at;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, presets]) => ({
      category,
      presets: presets.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * Does a preset match a free-text query?
 *
 * Name, description, tags and category all count, because a newcomer searches
 * for "smoke" and an experienced author searches for "vortex" - and the second
 * one is a tag, not a name.
 *
 * @param {Object} preset
 * @param {string} query
 * @returns {boolean}
 */
export function presetMatches(preset, query) {
  const needle = str(query).toLowerCase();
  if (!needle) return true;
  const haystack = [
    preset.name,
    preset.description,
    preset.category,
    ...(preset.tags || []),
    ...(preset.teaches || []),
  ].join(' ').toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}
