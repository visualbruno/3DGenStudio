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
// NO ASSET REFERENCES. A preset ships with the application and is opened on
// installations that have never seen the author's library, where `asset:41`
// means either nothing or, worse, somebody else's image. Every preset therefore
// draws with the built-in sprite, and `validatePreset` REJECTS one carrying a
// reference rather than letting it travel and resolve to a stranger's texture.
// This is the same trap tree presets shipped with, recorded in the feature plan.
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

const str = (value) => (typeof value === 'string' ? value.trim() : '');

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
  // actively wrong, anywhere else.
  const references = preset.doc?.references;
  if (references && Object.values(references).some((entry) => entry && entry.ref)) {
    errors.push(
      'A preset cannot reference library assets - their ids mean nothing on another '
      + 'installation. Clear the Sprite Texture so it uses the built-in sprite.',
    );
  }
  return errors;
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
