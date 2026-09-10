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
  applyPresetAssets,
  groupPresets,
  normalizePreset,
  presetAssetName,
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
  check('  and the message says what to do instead',
    refErrors.join(' ').includes('asset pack'), refErrors.join(' '));

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


// ---------------------------------------------------------------------------
console.log('\n--- Bundled assets a preset needs ---');
// ---------------------------------------------------------------------------
//
// A preset that wants a flame texture cannot store `asset:41` - that is a row
// in the authoring machine's database. It declares a FILE in the pack instead,
// and opening the preset installs that file here and rewrites the slot to
// whatever id it got. A filename in a directory the app owns is
// install-independent in the way a database id is not.
{
  const withNeed = (extra = {}) => normalizePreset({
    id: 'flamey',
    name: 'Flamey',
    category: 'Fire & Smoke',
    description: 'x',
    tags: ['looping'],
    assets: [{ slot: 'tex_b3_texture', file: 'flame-wisp.png', kind: 'image', name: 'Flame Wisp' }],
    doc: {
      systems: [{ id: 's1', contexts: [] }],
      references: { tex_b3_texture: { kind: 'image', ref: '', name: '', colorSpace: 'srgb' } },
    },
    ...extra,
  });

  const preset = withNeed();
  check('a declared asset survives normalisation',
    preset.assets.length === 1 && preset.assets[0].file === 'flame-wisp.png');
  check('  and a preset that declares none gets an empty list',
    normalizePreset({ id: 'x' }, 'x').assets.length === 0);
  check('  with the display name defaulting to the filename stem',
    normalizePreset({ assets: [{ slot: 's', file: 'spark-streak.png' }] }, 'x')
      .assets[0].name === 'spark-streak');
  // Dedup is by NAME, because the library listing does not project metadata -
  // so there is nowhere to hide a marker. The prefix stops an unprefixed
  // "Flame Wisp" from silently adopting an asset the user happened to own.
  check('installed assets get a prefixed name', presetAssetName(preset.assets[0]) === 'VFX Flame Wisp');

  check('a preset declaring a bundled asset validates',
    validatePreset(preset).length === 0, validatePreset(preset).join(' '));

  // The filename becomes a path under resources/vfx/assets/, so it is matched
  // against a pattern rather than escaped.
  const badFiles = ['../../secret.png', 'no-extension', 'flame.exe', '/abs/flame.png', ''];
  check('a bundled filename that is really a path is refused',
    badFiles.every((file) => validatePreset(withNeed({
      assets: [{ slot: 'tex_b3_texture', file }],
    })).length > 0),
    badFiles.filter((file) => validatePreset(withNeed({
      assets: [{ slot: 'tex_b3_texture', file }],
    })).length === 0).join(' ') || 'none slipped through');
  check('  while ordinary image and mesh names pass',
    ['flame-wisp.png', 'rock_chip.glb', 'Smoke.WEBP'].every((file) => validatePreset(withNeed({
      assets: [{ slot: 'tex_b3_texture', file }],
    })).length === 0));

  // A DECLARATION FOR A SLOT THE EFFECT DOES NOT HAVE would install the file
  // and wire it to nothing: the effect draws with the blob and nothing says
  // why. Caught at save rather than discovered on open.
  check('a declaration for a slot the effect lacks is refused',
    validatePreset(withNeed({
      assets: [{ slot: 'tex_nonexistent', file: 'flame-wisp.png' }],
    })).length > 0);

  // Storing an id is still refused - that is the whole rule.
  const stored = withNeed({
    doc: {
      systems: [{ id: 's1', contexts: [] }],
      references: { tex_b3_texture: { kind: 'image', ref: 'asset:41' } },
    },
  });
  check('storing an asset id is still refused', validatePreset(stored).length > 0);
  check('  and the message points at the asset pack',
    validatePreset(stored).join(' ').includes('asset pack'));
}

// ---------------------------------------------------------------------------
console.log('\n--- Rewriting slots to local ids ---');
// ---------------------------------------------------------------------------
{
  const doc = {
    systems: [{ id: 's1', contexts: [] }],
    references: {
      tex_main: { kind: 'image', ref: '', name: '', colorSpace: 'srgb' },
      mesh_chip: { kind: 'mesh', ref: '', name: '', colorSpace: 'srgb' },
    },
  };
  const needs = [
    { slot: 'tex_main', file: 'flame.png', kind: 'image', name: 'Flame' },
    { slot: 'mesh_chip', file: 'chip.glb', kind: 'mesh', name: 'Rock Chip' },
  ];

  const both = applyPresetAssets(doc, needs, new Map([['flame.png', 118], ['chip.glb', 119]]));
  check('every slot is pointed at its installed id',
    both.doc.references.tex_main.ref === 'asset:118'
    && both.doc.references.mesh_chip.ref === 'asset:119',
    `${both.doc.references.tex_main.ref} ${both.doc.references.mesh_chip.ref}`);
  check('  nothing is left unresolved', both.missing.length === 0);
  // The bundled name travels, so the params panel names the texture instead of
  // showing a bare id.
  check('  and the slot carries the asset name', both.doc.references.tex_main.name === 'Flame');
  // The rest of the slot - kind, colour space - is the AUTHOR's, not ours.
  check('  while the rest of the slot is untouched',
    both.doc.references.tex_main.colorSpace === 'srgb'
    && both.doc.references.mesh_chip.kind === 'mesh');
  check('  and the original document is not mutated', doc.references.tex_main.ref === '');

  // A FAILED INSTALL IS REPORTED, NOT SWALLOWED. An unresolved slot draws with
  // the built-in blob, which looks identical to a preset nobody gave a texture
  // to - and a correct fallback with no report is indistinguishable from a
  // broken feature.
  const partial = applyPresetAssets(doc, needs, new Map([['flame.png', 118]]));
  check('an asset that did not install is reported',
    partial.missing.length === 1 && partial.missing[0].file === 'chip.glb',
    partial.missing.map((need) => need.file).join(' '));
  check('  while the one that did still gets wired',
    partial.doc.references.tex_main.ref === 'asset:118');

  // A slot the document does not have cannot be wired, and saying so is how an
  // authoring mistake gets found.
  check('a declaration for an absent slot is reported',
    applyPresetAssets(doc, [{ slot: 'nope', file: 'flame.png' }], new Map([['flame.png', 1]]))
      .missing.length === 1);

  // Junk ids must not become `asset:NaN`, which would compile to a dangling
  // reference and a diagnostic nobody could act on.
  for (const bad of [undefined, null, 0, -3, NaN, 'x']) {
    const result = applyPresetAssets(doc, needs, new Map([['flame.png', bad]]));
    check(`  an id of ${String(bad)} is treated as a failed install`,
      result.missing.some((need) => need.file === 'flame.png')
      && result.doc.references.tex_main.ref === '');
  }

  check('a preset with no declarations passes through untouched',
    applyPresetAssets(doc, [], new Map()).doc === doc);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
