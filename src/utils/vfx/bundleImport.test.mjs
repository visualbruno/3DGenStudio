// Installing an export bundle into a library.
//
//     node src/utils/vfx/bundleImport.test.mjs
//
// vfx/bundle.test.mjs covers the FORMAT - what a manifest must say and which
// slots get emptied. This covers the INSTALL, and the reason it can is that
// `saveEffect` and `uploadAssets` arrive as arguments: nothing here reaches for
// src/config.js, so node can load the module.
//
// The check worth the whole file is "the upload response is matched by name".
// /api/assets/library/import runs its files through Promise.all and pushes
// results as they finish, so the response order is whatever the filesystem felt
// like - and an importer that trusted the index would wire the smoke texture to
// the spark slot on a machine fast enough to reorder them. That is a bug with
// no error message and no crash: the effect imports, plays, and looks wrong.
import {
  importVfxBundle,
  indexBundleFiles,
  readVfxBundle,
  uploadFilename,
} from './bundleImport.js';
import { VFX_BUNDLE_FORMAT } from '../../../vfx/bundle.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(60)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

async function rejects(label, promise, fragment) {
  try {
    await promise;
    check(label, false, 'did not reject');
  } catch (err) {
    const ok = String(err.message).includes(fragment);
    check(label, ok, ok ? '' : err.message);
  }
}

/** A File as a directory input hands it over: bytes plus a relative path. */
function pick(relPath, contents = 'x') {
  const file = new File([contents], relPath.split('/').pop());
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath });
  return file;
}

const DOC = {
  formatVersion: 1,
  name: 'Ember Burst',
  systems: [{ id: 'sys_1', name: 'Embers', contexts: [] }],
  references: {
    tex_spark: { kind: 'image', ref: 'asset:41', name: 'Spark', colorSpace: 'srgb' },
    tex_smoke: { kind: 'image', ref: 'asset:42', name: 'Smoke', colorSpace: 'srgb' },
    mesh_shard: { kind: 'mesh', ref: 'asset:52', name: 'Shard', colorSpace: 'srgb' },
    tex_gone: { kind: 'image', ref: 'asset:99', name: 'Deleted', colorSpace: 'srgb' },
  },
};

const MANIFEST = {
  bundleFormat: VFX_BUNDLE_FORMAT,
  appVersion: '1.5.0',
  exportedAt: 1757000000000,
  asset: { id: 7, name: 'Ember Burst', file: 'vfx/Ember_Burst.vfx.json', thumbnail: 'vfx/ember.png' },
  graph: DOC,
  references: [
    { slot: 'tex_spark', kind: 'image', ref: 'asset:41', name: 'Spark', assetName: 'spark.png', file: 'assets/images/1787-41.png' },
    { slot: 'tex_smoke', kind: 'image', ref: 'asset:42', name: 'Smoke', assetName: 'smoke.png', file: 'assets/images/1787-42.png' },
    { slot: 'mesh_shard', kind: 'mesh', ref: 'asset:52', name: 'Shard', assetName: 'shard.glb', file: 'assets/meshes/1787-52.glb' },
    { slot: 'tex_gone', kind: 'image', ref: 'asset:99', name: 'Deleted', file: null },
  ],
  warnings: [{ code: 'MISSING_ASSET', severity: 'warn', message: 'The image slot "tex_gone" points at an asset that is not in this library.' }],
};

const bundleFolder = (root = 'Ember_Burst', manifest = MANIFEST) => [
  pick(`${root}/manifest.json`, JSON.stringify(manifest)),
  pick(`${root}/vfx/Ember_Burst.vfx.json`, JSON.stringify(DOC)),
  pick(`${root}/vfx/ember.png`, 'thumbnail-bytes'),
  pick(`${root}/assets/images/1787-41.png`, 'spark-bytes'),
  pick(`${root}/assets/images/1787-42.png`, 'smoke-bytes'),
  pick(`${root}/assets/meshes/1787-52.glb`, 'shard-bytes'),
  // The importer plugin travels with a bundle when asked for. It must be
  // ignored rather than uploaded.
  pick(`${root}/UnityImporter/com.3dgenstudio.vfx-import/package.json`, '{}'),
];

// --- locating the bundle ---------------------------------------------------

{
  const { root, files } = indexBundleFiles(bundleFolder());
  check('the bundle root is found', root === 'Ember_Burst/');
  check('paths are relative to it', files.has('assets/images/1787-41.png'));
  check('the importer folder is indexed, not dropped', files.has('UnityImporter/com.3dgenstudio.vfx-import/package.json'));
}

try {
  indexBundleFiles([pick('Some_Folder/notes.txt')]);
  check('a folder with no manifest is refused', false, 'did not throw');
} catch (err) {
  check('a folder with no manifest is refused', /no manifest\.json/.test(err.message), err.message);
}

try {
  indexBundleFiles([...bundleFolder('Exports/Ember'), ...bundleFolder('Exports/Frost')]);
  check('a folder of several bundles is refused', false, 'did not throw');
} catch (err) {
  check('a folder of several bundles is refused', /2 exported effects/.test(err.message), err.message);
}

// --- reading ---------------------------------------------------------------

const bundle = await readVfxBundle(bundleFolder());
check('the effect name comes from the manifest', bundle.name === 'Ember Burst');
check('the thumbnail file is located', bundle.thumbnail?.name === 'ember.png');
check('the summary counts what will be installed', bundle.summary.textures === 2 && bundle.summary.meshes === 1);
check("the export's own warnings travel", bundle.warnings.length === 1);
check('nothing is reported missing from a complete folder', bundle.missingFiles.length === 0);

{
  // The embedded graph is preferred, but a bundle trimmed to just the file
  // still imports.
  const trimmed = { ...MANIFEST, graph: null };
  const read = await readVfxBundle(bundleFolder('Ember_Burst', trimmed));
  check('the vfx/ file is the fallback graph', read.doc.systems[0].name === 'Embers');

  const gutted = bundleFolder('Ember_Burst', trimmed).filter(
    file => !file.webkitRelativePath.endsWith('.vfx.json')
  );
  await rejects('a manifest pointing at a missing graph is refused', readVfxBundle(gutted), 'not in the folder');
}

{
  const short = bundleFolder().filter(file => !file.webkitRelativePath.endsWith('1787-42.png'));
  const read = await readVfxBundle(short);
  check(
    'a file the manifest promised but the folder lacks is reported',
    read.missingFiles.length === 1 && read.missingFiles[0].slot === 'tex_smoke'
  );
}

// --- filenames -------------------------------------------------------------

{
  const taken = new Set();
  check(
    'an upload is named after the exporting library, not the storage file',
    uploadFilename({ name: 'spark.png', file: 'assets/images/1787-41.png' }, taken) === 'spark.png'
  );
  check(
    'a clash within one batch is made unique',
    uploadFilename({ name: 'spark.png', file: 'assets/images/1787-99.png' }, taken) === 'spark-2.png'
  );
  check(
    'the extension comes from the BUNDLE path, not the name',
    uploadFilename({ name: 'shard', file: 'assets/meshes/1787-52.glb' }, new Set()) === 'shard.glb'
  );
  check(
    'a hostile name is reduced to something a filesystem takes',
    uploadFilename({ name: '../../etc/passwd', file: 'a/b.png' }, new Set()) === 'etc_passwd.png'
  );
  check(
    'an empty name falls back to the bundle filename',
    uploadFilename({ name: '', file: 'assets/images/1787-41.png' }, new Set()) === '1787-41.png'
  );
}

// --- installing ------------------------------------------------------------

/**
 * A library that answers like the real routes, including the part that bites:
 * `imported` comes back in COMPLETION order, so this reverses it.
 */
function fakeLibrary({ existing = {}, failNamed = null } = {}) {
  const calls = [];
  let nextId = 500;
  return {
    calls,
    listLibrary: async () => existing,
    uploadAssets: async (assets, options) => {
      calls.push({ type: options?.assetType, names: assets.map(a => a.file.name) });
      const imported = [];
      const skipped = [];
      for (const asset of assets) {
        if (failNamed && asset.file.name === failNamed) {
          skipped.push({ name: asset.file.name, reason: 'Not a VFX graph' });
          continue;
        }
        nextId += 1;
        imported.push({ id: nextId, name: asset.file.name, type: options?.assetType });
      }
      return { imported: imported.reverse(), skipped };
    },
    saved: [],
  };
}

{
  const library = fakeLibrary();
  const saveEffect = async (spec) => { library.saved.push(spec); return { id: 900, name: spec.name }; };
  const steps = [];
  const result = await importVfxBundle(bundle, {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect,
    onProgress: step => steps.push(step),
  });

  const refs = library.saved[0].doc.references;
  const idFor = (name) => {
    const call = library.calls.find(c => c.names.includes(name));
    return 500 + call.names.indexOf(name) + 1 + library.calls.slice(0, library.calls.indexOf(call))
      .reduce((sum, c) => sum + c.names.length, 0);
  };

  check('the effect was saved once', library.saved.length === 1);
  check('under the bundle name', library.saved[0].name === 'Ember Burst');
  check('with the bundle thumbnail', library.saved[0].thumbnail?.name === 'ember.png');

  // THE ONE THAT MATTERS: the response came back reversed, so a by-index match
  // would have swapped spark and smoke.
  check(
    'spark is wired to the id spark.png actually got',
    refs.tex_spark.ref === `asset:${idFor('spark.png')}`,
    `${refs.tex_spark.ref} vs asset:${idFor('spark.png')}`
  );
  check(
    'smoke is wired to the id smoke.png actually got',
    refs.tex_smoke.ref === `asset:${idFor('smoke.png')}`,
    `${refs.tex_smoke.ref} vs asset:${idFor('smoke.png')}`
  );
  check('the mesh slot is wired too', /^asset:\d+$/.test(refs.mesh_shard.ref));
  check('and no slot kept an exporting-machine id', ![41, 42, 52, 99].some(
    id => Object.values(refs).some(entry => entry.ref === `asset:${id}`)
  ));
  check('the slot the bundle could not supply is empty', refs.tex_gone.ref === '');

  check('images and meshes upload as separate typed batches', library.calls.length === 2);
  check('with the right types', library.calls.map(c => c.type).sort().join(',') === 'image,mesh');
  check('three assets installed', result.installed.length === 3);
  check('nothing reused', result.reused.length === 0);
  check('the empty slot is reported', result.missing.length === 1 && result.missing[0].slot === 'tex_gone');
  check('progress was reported once per file', steps.length === 3 && steps[2].done === 3 && steps[2].total === 3);
}

{
  // Re-importing the same bundle: the sprites are already here by name.
  const library = fakeLibrary({
    existing: {
      images: [{ id: 'library:120', name: 'spark.png' }, { id: 'library:121', name: 'SMOKE.PNG' }],
      meshes: [],
      vfx: [],
    },
  });
  const result = await importVfxBundle(bundle, {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 901 }; },
  });
  const refs = library.saved[0].doc.references;
  check('an existing asset is reused rather than duplicated', refs.tex_spark.ref === 'asset:120');
  check('the name match is case-insensitive', refs.tex_smoke.ref === 'asset:121');
  check('only the mesh was uploaded', library.calls.length === 1 && library.calls[0].type === 'mesh');
  check('and both reuses are reported', result.reused.length === 2 && result.installed.length === 1);
}

{
  // Reuse off: everything is uploaded, even what is already here.
  const library = fakeLibrary({
    existing: { images: [{ id: 'library:120', name: 'spark.png' }], meshes: [], vfx: [] },
  });
  await importVfxBundle(bundle, {
    reuseExisting: false,
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 902 }; },
  });
  check('with reuse off nothing is adopted', library.saved[0].doc.references.tex_spark.ref !== 'asset:120');
}

{
  // Children of a root count: a sprite is very often an edit.
  const library = fakeLibrary({
    existing: {
      images: [{ id: 'library:200', name: 'source.png', children: [{ id: 205, name: 'spark.png' }] }],
      meshes: [],
      vfx: [],
    },
  });
  await importVfxBundle(bundle, {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 903 }; },
  });
  check('an EDIT is a valid reuse target', library.saved[0].doc.references.tex_spark.ref === 'asset:205');
}

{
  // One rejected file must not cost the other two, and must not leave its slot
  // pointing anywhere.
  const library = fakeLibrary({ failNamed: 'smoke.png' });
  const result = await importVfxBundle(bundle, {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 904 }; },
  });
  const refs = library.saved[0].doc.references;
  check('a rejected upload still saves the effect', library.saved.length === 1);
  check('the other slots are wired', /^asset:\d+$/.test(refs.tex_spark.ref) && /^asset:\d+$/.test(refs.mesh_shard.ref));
  check('the rejected slot is EMPTY, not left on 42', refs.tex_smoke.ref === '');
  check(
    "and the library's reason is carried through",
    result.failed.length === 1 && /Not a VFX graph/.test(result.failed[0].error),
    JSON.stringify(result.failed)
  );
}

{
  // A whole batch that threw - the network went away mid-import.
  const library = fakeLibrary();
  const result = await importVfxBundle(bundle, {
    uploadAssets: async () => { throw new Error('Failed to fetch'); },
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 905 }; },
  });
  check('a failed batch fails only its own files', result.failed.length === 3);
  check('and the effect still lands, texture-less', library.saved.length === 1);
  check(
    'with every slot empty rather than foreign',
    Object.values(library.saved[0].doc.references).every(entry => entry.ref === '')
  );
}

{
  // A listing that 500s must not stop the import.
  const library = fakeLibrary();
  await importVfxBundle(bundle, {
    uploadAssets: library.uploadAssets,
    listLibrary: async () => { throw new Error('nope'); },
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 906 }; },
  });
  check('a broken library listing just means no reuse', library.saved.length === 1 && library.calls.length === 2);
}

{
  // Two slots on one sprite: export ships one copy, so one upload.
  const shared = {
    ...MANIFEST,
    graph: {
      ...DOC,
      references: {
        tex_a: { kind: 'image', ref: 'asset:41', name: 'Spark', colorSpace: 'srgb' },
        tex_b: { kind: 'image', ref: 'asset:41', name: 'Spark', colorSpace: 'srgb' },
      },
    },
    references: [
      { slot: 'tex_a', kind: 'image', ref: 'asset:41', assetName: 'spark.png', file: 'assets/images/1787-41.png' },
      { slot: 'tex_b', kind: 'image', ref: 'asset:41', assetName: 'spark.png', file: 'assets/images/1787-41.png' },
    ],
  };
  const library = fakeLibrary();
  await importVfxBundle(await readVfxBundle(bundleFolder('Ember_Burst', shared)), {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 907 }; },
  });
  const refs = library.saved[0].doc.references;
  check('a shared sprite uploads once', library.calls[0].names.length === 1);
  check('and both slots point at it', refs.tex_a.ref === refs.tex_b.ref && refs.tex_a.ref !== '');
}

{
  // A bundle with no assets at all.
  const bare = { ...MANIFEST, graph: { ...DOC, references: {} }, references: [], warnings: [] };
  const library = fakeLibrary();
  await importVfxBundle(await readVfxBundle(bundleFolder('Bare', bare)), {
    name: '  Renamed  ',
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 908 }; },
  });
  check('an asset-free bundle uploads nothing', library.calls.length === 0);
  check('and the chosen name is trimmed and used', library.saved[0].name === 'Renamed');
}

{
  // THE RE-IMPORT CASE, and the one a single-install test cannot see. The
  // exporting library called it "Spark"; importing named it after the file it
  // arrived as, "Spark.png". Matched literally those never meet, so the same
  // bundle imported twice left two copies of every texture.
  const library = fakeLibrary({
    existing: { images: [{ id: 'library:130', name: 'Spark.png' }], meshes: [], vfx: [] },
  });
  const named = {
    ...MANIFEST,
    references: MANIFEST.references.map(entry => (
      entry.slot === 'tex_spark' ? { ...entry, assetName: 'Spark' } : entry
    )),
  };
  await importVfxBundle(await readVfxBundle(bundleFolder('Ember_Burst', named)), {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 909 }; },
  });
  check(
    '"Spark" adopts the "Spark.png" already in the library',
    library.saved[0].doc.references.tex_spark.ref === 'asset:130',
    library.saved[0].doc.references.tex_spark.ref
  );
}

{
  // ...but a texture must not be adopted as a mesh once both have lost their
  // extension.
  const library = fakeLibrary({
    existing: { images: [{ id: 'library:140', name: 'shard.png' }], meshes: [], vfx: [] },
  });
  await importVfxBundle(bundle, {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 910 }; },
  });
  check(
    'a same-named image is not adopted for a mesh slot',
    library.saved[0].doc.references.mesh_shard.ref !== 'asset:140'
  );
}

{
  // A bundle whose reference carries no name at all falls back to the file.
  const library = fakeLibrary({
    existing: { images: [{ id: 'library:150', name: '1787-41.png' }], meshes: [], vfx: [] },
  });
  const anonymous = {
    ...MANIFEST,
    references: MANIFEST.references.map(entry => (
      entry.slot === 'tex_spark' ? { ...entry, assetName: '', name: '' } : entry
    )),
  };
  await importVfxBundle(await readVfxBundle(bundleFolder('Ember_Burst', anonymous)), {
    uploadAssets: library.uploadAssets,
    listLibrary: library.listLibrary,
    saveEffect: async (spec) => { library.saved.push(spec); return { id: 911 }; },
  });
  check(
    'an unnamed reference matches on its bundle filename',
    library.saved[0].doc.references.tex_spark.ref === 'asset:150',
    library.saved[0].doc.references.tex_spark.ref
  );
}

console.log(failures === 0 ? '\nAll bundle-import checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
