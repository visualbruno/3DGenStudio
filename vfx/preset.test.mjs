// The preset format: normalisation, the write gate, grouping and search.
//
//     node vfx/preset.test.mjs
//
// The interesting checks here are the two that guard against shipping a broken
// library rather than against a coding mistake: a preset carrying an ASSET
// REFERENCE (which means nothing on another installation), and the read path
// staying total in the face of a hand-edited file. Both are failure modes the
// author cannot see from their own machine, where the assets exist and the file
// was written by the app.
import {
  PRESET_CATEGORIES,
  PRESET_FORMAT,
  PRESET_ID_PATTERN,
  PRESET_TAGS,
  groupPresets,
  normalizePreset,
  presetMatches,
  presetSummary,
  validatePreset,
} from './preset.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(58)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const docWith = (extra = {}) => ({ systems: [{ id: 's1', contexts: [] }], ...extra });
const preset = (extra = {}) => normalizePreset({
  id: 'my-preset',
  name: 'My Preset',
  category: 'Weather',
  description: 'Something.',
  tags: ['looping'],
  doc: docWith(),
  ...extra,
});

// ---------------------------------------------------------------------------
console.log('\n--- Normalising what is on disk ---');
// ---------------------------------------------------------------------------
{
  // TOTAL, AND NEVER THROWS. These files are hand-editable by design, and a
  // library that refuses to list because one file lost a field is worse than
  // one that lists it with an empty description.
  const empty = normalizePreset(null, 'from-filename');
  check('a null preset still normalises', empty.id === 'from-filename');
  check('  and takes its name from the filename', empty.name === 'from-filename');
  check('  with a format', empty.format === PRESET_FORMAT);
  check('  and empty collections rather than undefined',
    Array.isArray(empty.tags) && Array.isArray(empty.teaches) && empty.doc === null);

  check('junk types do not survive as junk',
    normalizePreset({ tags: 'looping', teaches: 7 }, 'x').tags.length === 0);
  check('  and duplicate tags collapse',
    normalizePreset({ tags: ['a', 'a', ' a ', 'b'] }, 'x').tags.join(',') === 'a,b');
  check('whitespace is trimmed off the name',
    normalizePreset({ name: '  Sparks  ' }, 'x').name === 'Sparks');

  // The summary is what the dialog lists, and the documents are what make the
  // listing expensive - a staged explosion is tens of kilobytes of blocks.
  const summary = presetSummary(preset());
  check('the summary drops the document', !('doc' in summary));
  check('  but keeps the system count', summary.systemCount === 1);
}

// ---------------------------------------------------------------------------
console.log('\n--- What may be written ---');
// ---------------------------------------------------------------------------
{
  check('a complete preset validates', validatePreset(preset()).length === 0);

  // The id becomes a FILENAME and a URL segment. Both matter.
  const badIds = ['', 'a', 'Has Capitals', 'has space', 'has/slash', '../escape', 'a'.repeat(60)];
  check('bad ids are all refused',
    badIds.every((id) => validatePreset(preset({ id })).length > 0),
    badIds.filter((id) => validatePreset(preset({ id })).length === 0).join(' ') || 'none slipped through');
  check('  and the pattern agrees with itself',
    PRESET_ID_PATTERN.test('muzzle-flash') && !PRESET_ID_PATTERN.test('muzzleFlash'));

  check('a preset with no document is refused',
    validatePreset(preset({ doc: null })).length > 0);
  check('  as is one with no systems',
    validatePreset(preset({ doc: { systems: [] } })).length > 0);
  // A NAME IS DERIVED, NOT REQUIRED. normalizePreset falls back to the id and
  // then to the filename, so a hand-edited file that lost its name still lists
  // under something a person can click rather than vanishing.
  check('  while a missing name is filled in from the id',
    normalizePreset({ id: 'ash-fall', doc: docWith() }, 'x').name === 'ash-fall');
  check('  so it never blocks a save',
    validatePreset(preset({ name: '' })).length === 0);

  // THE ONE THAT ONLY BITES SOMEBODY ELSE. `asset:41` is a row in the author's
  // database. On any other installation it is a different image or no image at
  // all, so a preset that ships one is either broken or quietly wearing a
  // stranger's texture - and the author, whose library does contain 41, can
  // never see it. This is the trap tree presets shipped with.
  const withRef = preset({
    doc: docWith({ references: { tex_main: { kind: 'texture', ref: 'asset:41' } } }),
  });
  const refErrors = validatePreset(withRef);
  check('a preset referencing a library asset is refused', refErrors.length > 0);
  check('  and the message says what to do about it',
    refErrors.join(' ').includes('Sprite Texture'), refErrors.join(' '));

  // An EMPTY slot is not a reference - it is the normal state of a preset, and
  // refusing it would make every preset unsaveable.
  check('an empty reference slot is fine',
    validatePreset(preset({ doc: docWith({ references: { tex_main: { kind: 'texture', ref: '' } } }) }))
      .length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n--- Grouping and search ---');
// ---------------------------------------------------------------------------
{
  const library = [
    presetSummary(preset({ id: 'b', name: 'Blizzard', category: 'Weather', tags: ['looping'] })),
    presetSummary(preset({ id: 'a', name: 'Ash Fall', category: 'Weather', tags: ['looping'] })),
    presetSummary(preset({ id: 'f', name: 'Fire', category: 'Fire & Smoke', tags: ['additive'] })),
    presetSummary(preset({ id: 'z', name: 'Zed', category: 'Nonsense Category', tags: [] })),
  ];
  const groups = groupPresets(library);

  check('presets group by category', groups.length === 3);
  // Fire & Smoke leads PRESET_CATEGORIES because it is what most people come
  // here to make; the rail order is a product decision, not alphabetical.
  check('  in the catalog’s order, not alphabetically',
    groups[0].category === 'Fire & Smoke' && groups[1].category === 'Weather',
    groups.map((g) => g.category).join(' | '));
  // A typo must not push the real categories down the rail.
  check('  with an unknown category sorted last',
    groups[2].category === 'Nonsense Category');
  check('  and names sorted within a group',
    groups[1].presets.map((p) => p.name).join(',') === 'Ash Fall,Blizzard');

  check('an empty query matches everything',
    library.every((entry) => presetMatches(entry, '')));
  check('search finds a name', presetMatches(library[0], 'blizz'));
  // An experienced author searches for a technique, which is a tag - not a
  // name. If search only read names those presets would be unfindable.
  check('  and a tag', presetMatches(library[2], 'additive'));
  check('  and a category', presetMatches(library[2], 'smoke'));
  // Every word, so a second word narrows rather than widens.
  check('  requiring every word', !presetMatches(library[2], 'fire blizzard'));
  check('  and matching nothing when nothing matches',
    !presetMatches(library[0], 'xyzzy'));
}

// ---------------------------------------------------------------------------
console.log('\n--- The vocabularies ---');
// ---------------------------------------------------------------------------
{
  check('categories are unique',
    new Set(PRESET_CATEGORIES).size === PRESET_CATEGORIES.length);
  check('every known tag has a label and a group',
    Object.values(PRESET_TAGS).every((entry) => entry.label && entry.group));
  // Tags are free-form on purpose: a vocabulary that rejects new words stops
  // being used. The table only supplies wording for the filter bar.
  check('an unknown tag survives normalisation',
    normalizePreset({ tags: ['brand-new-idea'] }, 'x').tags[0] === 'brand-new-idea');
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
