// Reading an export bundle back.
//
//     node vfx/bundle.test.mjs
//
// The check that matters most here is the one for a FOREIGN ID SURVIVING THE
// IMPORT. Everything else in this module is shape-checking a manifest, which
// fails loudly; a slot that quietly keeps `asset:41` produces an effect that
// draws somebody else's texture and never says a word about it - and the person
// who imported it cannot tell, because on their machine 41 does exist.
import {
  VFX_BUNDLE_FORMAT,
  VfxBundleError,
  applyBundleAssets,
  bundleAssetNeeds,
  bundleEffectName,
  bundleGraphSource,
  bundleThumbnailPath,
  bundleWarnings,
  normalizeBundlePath,
  parseBundleManifest,
  summarizeBundle,
} from './bundle.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(58)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

function throws(label, fn, fragment) {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (err) {
    const ok = err instanceof VfxBundleError && String(err.message).includes(fragment);
    check(label, ok, ok ? '' : err.message);
  }
}

const docWith = (references) => ({ systems: [{ id: 's1', contexts: [] }], references });

const manifest = (extra = {}) => ({
  bundleFormat: VFX_BUNDLE_FORMAT,
  appVersion: '1.5.0',
  exportedAt: 1757000000000,
  asset: { id: 7, name: 'Ember Burst', file: 'vfx/Ember_Burst.vfx.json', thumbnail: 'vfx/ember.png' },
  graph: docWith({}),
  references: [],
  warnings: [],
  ...extra,
});

// --- the manifest gate -----------------------------------------------------

check('a well-formed manifest parses', parseBundleManifest(manifest()).asset.id === 7);
check('text parses too', parseBundleManifest(JSON.stringify(manifest())).asset.name === 'Ember Burst');

throws('damaged JSON is refused', () => parseBundleManifest('{ nope'), 'not valid JSON');
throws('a non-object is refused', () => parseBundleManifest('[]'), 'does not describe');
throws(
  'a manifest with no bundleFormat is refused',
  () => parseBundleManifest({ asset: { file: 'vfx/a.json' } }),
  'no bundleFormat'
);
throws(
  'a newer bundle is refused rather than half-read',
  () => parseBundleManifest(manifest({ bundleFormat: VFX_BUNDLE_FORMAT + 1 })),
  'newer version'
);
throws(
  'a manifest with neither graph nor file is refused',
  () => parseBundleManifest(manifest({ graph: null, asset: { name: 'x' } })),
  'carries no effect'
);
check(
  'a manifest with only a vfx/ file is accepted',
  bundleGraphSource(parseBundleManifest(manifest({ graph: null }))).file === 'vfx/Ember_Burst.vfx.json'
);

check('backslashes normalise', normalizeBundlePath('assets\\images\\a.png') === 'assets/images/a.png');
check('a leading ./ is dropped', normalizeBundlePath('./manifest.json') === 'manifest.json');
check('the effect name comes back', bundleEffectName(manifest()) === 'Ember Burst');
check('the thumbnail path comes back', bundleThumbnailPath(manifest()) === 'vfx/ember.png');

// --- the needs list --------------------------------------------------------

const references = [
  { slot: 'tex_a', kind: 'image', ref: 'asset:41', name: 'Spark', assetName: 'spark.png', file: 'assets/images/1787-41.png' },
  { slot: 'tex_b', kind: 'image', ref: 'asset:41', name: 'Spark again', assetName: 'spark.png', file: 'assets/images/1787-41.png' },
  { slot: 'mesh_a', kind: 'mesh', ref: 'asset:52', name: 'Shard', assetName: 'shard.glb', file: 'assets/meshes/1787-52.glb' },
  // Exported after the source asset was deleted: recorded, warned about, and
  // shipped with no file.
  { slot: 'tex_gone', kind: 'image', ref: 'asset:99', name: 'Deleted', file: null },
  // Never filled in by the author.
  { slot: 'tex_empty', kind: 'image', ref: '', name: '', file: null },
];

const needs = bundleAssetNeeds(manifest({ references }));
check('every reference becomes a need', needs.length === 5);
check('the asset name wins over the slot label', needs[0].name === 'spark.png');
check('the slot label is the fallback', needs[3].name === 'Deleted');
check('two slots may name one file', needs[0].file === needs[1].file);
check('a mesh keeps its kind', needs[2].kind === 'mesh');
check('an unknown kind falls back to image', bundleAssetNeeds(manifest({
  references: [{ slot: 's', kind: 'audio', file: 'assets/x.wav' }],
}))[0].kind === 'image');
check('hadRef distinguishes deleted from never-chosen', needs[3].hadRef === true && needs[4].hadRef === false);

const summary = summarizeBundle(manifest({ references, warnings: [{ code: 'MISSING_ASSET' }] }));
check('the summary counts textures', summary.textures === 2, JSON.stringify(summary));
check('the summary counts meshes', summary.meshes === 1);
check('the summary counts empty slots', summary.empty === 2);
check('the summary counts warnings', summary.warnings === 1);

check('warnings normalise', (() => {
  const list = bundleWarnings(manifest({ warnings: [{ code: 'X', severity: 'error', message: 'm' }, null] }));
  return list.length === 1 && list[0].severity === 'error';
})());

// --- the remap, which is the whole point -----------------------------------

const doc = docWith({
  tex_a: { kind: 'image', ref: 'asset:41', name: 'Spark', colorSpace: 'srgb' },
  tex_b: { kind: 'image', ref: 'asset:41', name: 'Spark again', colorSpace: 'srgb' },
  mesh_a: { kind: 'mesh', ref: 'asset:52', name: 'Shard', colorSpace: 'srgb' },
  tex_gone: { kind: 'image', ref: 'asset:99', name: 'Deleted', colorSpace: 'srgb' },
  tex_empty: { kind: 'image', ref: '', name: '', colorSpace: 'srgb' },
});

const applied = applyBundleAssets(doc, needs, {
  'assets/images/1787-41.png': 300,
  'assets/meshes/1787-52.glb': 301,
});

check('a resolved slot points at the LOCAL id', applied.doc.references.tex_a.ref === 'asset:300');
check('one file serves both slots', applied.doc.references.tex_b.ref === 'asset:300');
check('a mesh slot is remapped too', applied.doc.references.mesh_a.ref === 'asset:301');
check('the resolved name comes from the bundle', applied.doc.references.tex_a.name === 'spark.png');
check('colorSpace survives', applied.doc.references.mesh_a.colorSpace === 'srgb');

// THE ONE THAT MATTERS.
check(
  'a slot whose file did not ship is EMPTIED, not left on 41',
  applied.doc.references.tex_gone.ref === ''
);
check('an already-empty slot stays empty', applied.doc.references.tex_empty.ref === '');
check('resolved reports both textures and the mesh', applied.resolved.length === 3);
check(
  'missing names the unshipped file with a reason',
  applied.missing.length === 1
    && applied.missing[0].slot === 'tex_gone'
    && /shipped without/.test(applied.missing[0].reason),
  JSON.stringify(applied.missing)
);
// An author leaving a texture block empty is not a warning - see applyBundleAssets.
check(
  'a never-filled slot is not reported as missing',
  !applied.missing.some(m => m.slot === 'tex_empty')
);

// A slot the manifest forgot: it can only be holding a foreign id.
const orphaned = applyBundleAssets(
  docWith({ tex_x: { kind: 'image', ref: 'asset:77', name: 'Stray', colorSpace: 'srgb' } }),
  [],
  {}
);
check('a slot the manifest never lists is emptied', orphaned.doc.references.tex_x.ref === '');
check(
  'and is reported',
  orphaned.missing.length === 1 && /does not list it/.test(orphaned.missing[0].reason)
);

// An upload that failed leaves the file out of the id map.
const failed = applyBundleAssets(doc, needs, { 'assets/meshes/1787-52.glb': 301 });
check('a failed upload empties its slot too', failed.doc.references.tex_a.ref === '');
check(
  'and says why',
  failed.missing.some(m => m.slot === 'tex_a' && /could not be added/.test(m.reason))
);

// A manifest naming a slot the document does not have.
const mismatched = applyBundleAssets(docWith({}), needs, { 'assets/images/1787-41.png': 300 });
check(
  'a slot the document lacks is reported, not invented',
  mismatched.resolved.length === 0
    && Object.keys(mismatched.doc.references).length === 0
    && mismatched.missing.every(m => /no such slot/.test(m.reason))
);

check('the input document is not mutated', doc.references.tex_a.ref === 'asset:41');

console.log(failures === 0 ? '\nAll bundle checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
