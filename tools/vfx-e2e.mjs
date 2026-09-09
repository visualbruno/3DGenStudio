// Phase 5 end-to-end: the round trip the plan specifies, against a real server.
//
//   Save -> the card has a thumbnail -> reopen by id -> the graph is identical
//   -> DELETE A BLOCK, save, reload -> the block is gone.
//
// That last step is the one that matters. It is the only way to see the
// metadata-merge trap: replaceAssetFileById MERGES the metadata column rather
// than replacing it, so a document stored there could never lose a key and a
// deleted block would come back. It is the whole reason the graph is a file.
//
// HOW TO RUN. Needs a server with its own data directory, because it creates
// and deletes assets:
//
//     mkdir /tmp/vfx && cd /tmp/vfx
//     PORT=3399 node /path/to/3DGenStudio/server.js &
//     node /path/to/3DGenStudio/tools/vfx-e2e.mjs
//
// Not part of the `node vfx/*.test.mjs` sweep for that reason - those run
// headless with no server and no database.
const BASE = process.env.VFX_E2E_BASE || 'http://127.0.0.1:3399';
const API = `${BASE}/api`;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
};

const { normalizeVfxDoc, vfxSignature, collectVfxAssetRefs } = await import('file:///C:/Git/3DGenStudio/vfx/doc.js');
const { VFX_TEMPLATES } = await import('file:///C:/Git/3DGenStudio/src/utils/vfx/templates.js');

// A 1x1 PNG, to stand in for the thumbnail the browser would render.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function docToFile(doc, name) {
  return new File([JSON.stringify(doc, null, 2)], `${name}.vfx.json`, { type: 'application/json' });
}

function digest(doc) {
  const refs = collectVfxAssetRefs(doc);
  const blockCount = doc.systems.reduce((t, s) => t + s.contexts.reduce((u, c) => u + c.blocks.length, 0), 0);
  return {
    source: 'VFX EDITOR',
    kind: 'vfx-graph',
    format: doc.format,
    duration: doc.effect.duration,
    looping: doc.effect.loop,
    systemCount: doc.systems.length,
    blockCount,
    textureRefs: refs.textureRefs,
    meshRefs: refs.meshRefs,
  };
}

// --- 1. Create -------------------------------------------------------------
const template = VFX_TEMPLATES.find(t => t.id === 'muzzleFlash');
let doc = normalizeVfxDoc(template.build());
doc.references = { tex_spark: { kind: 'image', ref: 'asset:4242', name: 'spark.png', colorSpace: 'srgb' } };
doc = normalizeVfxDoc(doc);

const blocksBefore = doc.systems.reduce((t, s) => t + s.contexts.reduce((u, c) => u + c.blocks.length, 0), 0);

const createForm = new FormData();
createForm.append('file', docToFile(doc, 'E2E_Muzzle_Flash'));
createForm.append('type', 'vfx');
createForm.append('name', 'E2E Muzzle Flash');
createForm.append('metadata', JSON.stringify(digest(doc)));

let response = await fetch(`${API}/assets/library-upload`, { method: 'POST', body: createForm });
const created = await response.json().catch(() => ({}));
check('library-upload accepts type=vfx', response.ok && created?.id, created?.error || `id ${created?.id}`);
if (!created?.id) process.exit(1);
const assetId = created.id;

// THE SILENT ONE. getAssetSubdirectory falling through to 'images' does not
// error, so looking at the stored path is the only way to catch it.
check('the file lands in data/assets/vfx',
  String(created.filePath || created.filename || '').includes('assets/vfx/'),
  created.filePath || created.filename);

// --- 2. Thumbnail ----------------------------------------------------------
const thumbForm = new FormData();
thumbForm.append('thumbnail', new File([PNG_1PX], 'thumb.png', { type: 'image/png' }));
response = await fetch(`${API}/assets/${assetId}/thumbnail`, { method: 'POST', body: thumbForm });
check('the thumbnail route accepts it', response.ok, String(response.status));

// --- 3. It appears in the library, under the `vfx` key ---------------------
response = await fetch(`${API}/assets/library`);
const library = await response.json();
const row = (library.vfx || []).find(a => String(a.id).replace('library:', '') === String(assetId));
check('/api/assets/library exposes a vfx key', Array.isArray(library.vfx), `${(library.vfx || []).length} effects`);
check('  containing the new effect', Boolean(row), row?.name);
check('  with a thumbnail url', Boolean(row?.thumbnailUrl), row?.thumbnailUrl ? 'present' : 'missing');
// NOTE: the metadata digest is deliberately NOT checked on the listing row.
// listLibraryAssetsByType does not project the metadata column, so it is not
// there - the real consumers are /assets/record, project export/import and MCP.

// --- 4. Reopen by id -------------------------------------------------------
response = await fetch(`${API}/assets/record?assetId=${assetId}`);
const record = await response.json();
check('assets/record resolves it by id', response.ok && Boolean(record?.filePath), record?.filePath);
// This route returns the RAW row, so metadata is a JSON string rather than an
// object - it does not pass through mapAssetRow like the listings do.
// getVfxAssetRecord in src/utils/vfxApi.js normalises that for app code.
const recordMeta = typeof record?.metadata === 'string' ? JSON.parse(record.metadata) : (record?.metadata || {});
check('  and carries the digest', recordMeta.kind === 'vfx-graph', recordMeta.kind);
// The 'asset:<id>' string form is what makes storage.js's export walker find it.
check('  as asset:<id> strings, not bare numbers',
  recordMeta.textureRefs?.[0] === 'asset:4242',
  String(recordMeta.textureRefs?.[0]));

const fileUrl = `${BASE}/assets/${String(record.filePath).replace(/^data\/assets\//, '')}`;
response = await fetch(fileUrl, { cache: 'reload' });
check('  and the bytes are served', response.ok, String(response.status));
const reopened = normalizeVfxDoc(await response.json());
check('the reopened graph is identical', vfxSignature(reopened) === vfxSignature(doc));

// --- 5. THE ONE THAT MATTERS: delete a block, save, reload ----------------
const target = reopened.systems[0].contexts.find(c => c.blocks.length > 0);
const removed = target.blocks.pop();
const afterDelete = normalizeVfxDoc(reopened);
const blocksAfter = afterDelete.systems.reduce((t, s) => t + s.contexts.reduce((u, c) => u + c.blocks.length, 0), 0);

const replaceForm = new FormData();
replaceForm.append('file', docToFile(afterDelete, 'E2E_Muzzle_Flash'));
replaceForm.append('payload', JSON.stringify({
  name: 'E2E Muzzle Flash',
  type: 'vfx',
  metadata: digest(afterDelete),
}));
response = await fetch(`${API}/assets/${assetId}/replace`, { method: 'POST', body: replaceForm });
const replaced = await response.json().catch(() => ({}));
check('replace saves in place', response.ok, replaced?.error || `id ${replaced?.id}`);
check('  keeping the same id', String(replaced?.id).replace('library:', '') === String(assetId));

// /replace commits a freshly staged upload, so the asset's filePath CHANGES
// even though its id does not. Re-reading the record is mandatory - reusing the
// old URL serves the previous version and looks exactly like a save that did
// not take.
response = await fetch(`${API}/assets/record?assetId=${assetId}`);
const recordAfter = await response.json();
check('  but assigning a new filePath',
  recordAfter.filePath !== record.filePath,
  `${String(record.filePath).split('/').pop()} -> ${String(recordAfter.filePath).split('/').pop()}`);

const fileUrlAfter = `${BASE}/assets/${String(recordAfter.filePath).replace(/^data\/assets\//, '')}`;
response = await fetch(fileUrlAfter, { cache: 'reload' });
const afterReload = normalizeVfxDoc(await response.json());
const reloadedBlocks = afterReload.systems.reduce((t, s) => t + s.contexts.reduce((u, c) => u + c.blocks.length, 0), 0);
check('THE BLOCK IS GONE after save and reload',
  reloadedBlocks === blocksAfter && reloadedBlocks === blocksBefore - 1,
  `${blocksBefore} -> ${blocksAfter} -> ${reloadedBlocks} (removed ${removed.type})`);
check('  and the whole graph matches', vfxSignature(afterReload) === vfxSignature(afterDelete));

// --- 6. The export bundle --------------------------------------------------
//
// THE PHASE-9 GATE: "export lists exactly the right files". Not "lists some
// files" - a bundle that quietly omits a texture produces an effect that
// imports clean and renders wrong, and a bundle that over-collects drags an
// unrelated library across the wire.
//
// Both reference states are exercised, because they are handled differently on
// purpose: a resolvable reference ships its bytes, a DANGLING one warns and the
// export still succeeds. Refusing to export a half-authored effect would make
// the feature useless at exactly the moment it is most useful - checking
// something in-engine before every texture is final.

// A real image asset, so one slot can resolve. The effect currently points at
// asset:4242, which does not exist.
const imageForm = new FormData();
imageForm.append('file', new File([PNG_1PX], 'e2e-spark.png', { type: 'image/png' }));
imageForm.append('type', 'image');
imageForm.append('name', 'E2E Spark');
response = await fetch(`${API}/assets/library-upload`, { method: 'POST', body: imageForm });
const image = await response.json().catch(() => ({}));
check('an image asset was created to reference', response.ok && image?.id, image?.error || `id ${image?.id}`);
const imageId = Number(String(image?.id || '').replace('library:', ''));

// Point one slot at the real image and leave a second one dangling.
let bundleDoc = normalizeVfxDoc({
  ...afterDelete,
  references: {
    tex_spark: { kind: 'image', ref: `asset:${imageId}`, name: 'E2E Spark', colorSpace: 'srgb' },
    tex_gone: { kind: 'image', ref: 'asset:999123', name: 'deleted.png', colorSpace: 'srgb' },
  },
});
const bundleForm = new FormData();
// No  here ON PURPOSE: a replace must default to the type the asset
// already has. Sending it would hide the bug this line exists to catch, which
// is that the fallback used to be the FILENAME and then 'image' - so a
// re-saved effect quietly moved into data/assets/images/.
bundleForm.append('payload', JSON.stringify({ name: 'E2E Muzzle Flash', metadata: digest(bundleDoc) }));
bundleForm.append('file', docToFile(bundleDoc, 'E2E_Muzzle_Flash'));
response = await fetch(`${API}/assets/${assetId}/replace`, { method: 'POST', body: bundleForm });
check('  and the effect was saved pointing at it', response.ok, String(response.status));

response = await fetch(`${API}/assets/${assetId}/vfx-export-plan?appVersion=e2e`);
const bundle = await response.json().catch(() => ({}));
check('GET /assets/:id/vfx-export answers', response.ok, bundle?.error || String(response.status));

const manifest = bundle?.manifest || {};
check('  the manifest declares its bundle format', manifest.bundleFormat === 1, String(manifest.bundleFormat));
check('  and the IR format inside it', manifest.ir?.irFormat === 1, String(manifest.ir?.irFormat));
check('  carrying the graph AND the compiled IR',
  Array.isArray(manifest.graph?.systems) && Array.isArray(manifest.ir?.systems),
  `${manifest.graph?.systems?.length} systems / ${manifest.ir?.systems?.length} compiled`);
check('  and the engine mapping table', manifest.engineMapping?.blocks?.length > 20,
  `${manifest.engineMapping?.blocks?.length} blocks`);
check('  generated from the catalog, not written by hand',
  manifest.engineMapping?.generatedFrom === 'vfx/catalog.js', manifest.engineMapping?.generatedFrom);

// EXACTLY the right files: the graph, its thumbnail, and the one texture that
// resolved. Nothing for the dangling slot, and nothing else from the library.
const dests = (bundle.files || []).map(f => f.dest).sort();
check('  and EXACTLY the right files', dests.length === 3, dests.join(' '));
// Matched against the manifest rather than by extension: the server renames an
// upload to a timestamp, so the stored basename has no .vfx infix at all.
check('    the graph itself', dests.includes(manifest.asset?.file), manifest.asset?.file);
check('    its thumbnail', dests.some(d => d.startsWith('vfx/') && d.endsWith('.png')), dests.join(' '));
check('    and the referenced image', dests.some(d => d.startsWith('assets/images/')), dests.join(' '));

// `source` is an absolute path on the server's disk. A remote-connected install
// fetches by storagePath over HTTP, so leaking it would be both useless and a
// disclosure.
check('  with no absolute source path leaked',
  (bundle.files || []).every(f => !('source' in f) && typeof f.storagePath === 'string'),
  JSON.stringify(bundle.files?.[0] || {}));

// The contract the plan states: the caller fetches each file's bytes by
// storagePath. Checked rather than assumed - a plan listing paths that 404 is
// not an export.
let fetched = 0;
for (const file of bundle.files || []) {
  const url = `${BASE}/${String(file.storagePath).replace(/^data\//, '')}`;
  const head = await fetch(url);
  if (head.ok) fetched += 1;
}
check('  and every listed file really fetches',
  fetched === (bundle.files || []).length, `${fetched} of ${(bundle.files || []).length}`);

// The dangling slot: reported, and the export still succeeded.
const missing = (manifest.warnings || []).filter(w => w.code === 'MISSING_ASSET');
check('a dangling reference is reported', missing.length === 1, JSON.stringify(missing.map(w => w.slot)));
check('  naming the slot', missing[0]?.slot === 'tex_gone', missing[0]?.slot);
check('  and the export still succeeded', response.ok);
const resolved = (manifest.references || []).find(r => r.slot === 'tex_spark');
check('  while the resolvable slot carries its file',
  Boolean(resolved?.file) && resolved.file.startsWith('assets/images/'), resolved?.file);
check('  and the dangling one carries none',
  (manifest.references || []).find(r => r.slot === 'tex_gone')?.file === null);

// An engine target fills in the fidelity gaps for THAT engine only, so a plugin
// author is not left diffing the whole table.
response = await fetch(`${API}/assets/${assetId}/vfx-export-plan?engineTarget=unreal`);
const targeted = (await response.json().catch(() => ({})))?.manifest || {};
check('an engine target is recorded', targeted.engineTarget === 'unreal', String(targeted.engineTarget));
check('  and its gaps are listed', Array.isArray(targeted.engineGaps) && targeted.engineGaps.length > 0,
  `${targeted.engineGaps?.length} gaps`);
check('  while an untargeted bundle lists none', manifest.engineGaps === null, String(manifest.engineGaps));

response = await fetch(`${API}/assets/${assetId}/vfx-export-plan?engineTarget=godot`);
check('an unknown engine target is refused', response.status === 400, String(response.status));

response = await fetch(`${API}/assets/${imageId}/vfx-export-plan`);
check('exporting a non-VFX asset is refused', response.status === 400, String(response.status));

response = await fetch(`${API}/assets/99887766/vfx-export-plan`);
check('exporting a missing asset is a 404', response.status === 404, String(response.status));

// And the WRITING half, which is what a human clicking Export uses. A separate
// route from the plan on purpose - see serverMode.js: the classifier sees the
// path and not the method, and these two halves have to run on different
// machines in remote mode.
const outDir = `${process.env.TEMP || '/tmp'}/vfx-e2e-bundle-${Date.now()}`;
response = await fetch(`${API}/assets/${assetId}/vfx-export`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: outDir, name: 'E2E Bundle' }),
});
const written = await response.json().catch(() => ({}));
check('POST /assets/:id/vfx-export writes a bundle', response.status === 201,
  written?.error || String(response.status));
check('  copying every file it listed', written.fileCount === (bundle.files || []).length,
  `${written.fileCount} of ${(bundle.files || []).length}`);
{
  const fsp = await import('node:fs/promises');
  const manifestOnDisk = await fsp.readFile(`${written.folder}/manifest.json`, 'utf8')
    .then(JSON.parse).catch(() => null);
  check('  and writing manifest.json beside them',
    manifestOnDisk?.bundleFormat === 1, manifestOnDisk ? 'present' : 'missing');
  // Written LAST on purpose, so a copy failure during the export shows up in
  // the manifest the author actually receives.
  check('    with the warnings included',
    Array.isArray(manifestOnDisk?.warnings)
    && manifestOnDisk.warnings.some(w => w.code === 'MISSING_ASSET'),
    JSON.stringify((manifestOnDisk?.warnings || []).map(w => w.code)));
  const entries = await fsp.readdir(`${written.folder}/vfx`).catch(() => []);
  check('  the graph is in the bundle', entries.some(f => f.endsWith('.json')), entries.join(' '));
  await fsp.rm(written.folder, { recursive: true, force: true }).catch(() => null);
}

response = await fetch(`${API}/assets/${assetId}/vfx-export`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: 'not-absolute' }),
});
check('  and a relative folder is refused', response.status === 400, String(response.status));

// Clean up the image; the effect is deleted below.
response = await fetch(
  `${API}/assets/library?type=image&filename=${encodeURIComponent(String(image?.filePath || '').replace(/^data\//, ''))}&force=true`,
  { method: 'DELETE' },
);

// --- 7. Rename, then delete ------------------------------------------------
// RE-READ THE RECORD FIRST. Every /replace assigns a new filePath, and the
// library routes address an asset BY PATH - so a filename captured before an
// intervening save targets a file that no longer exists. Worse, both routes
// answer 200/204 for a path they cannot find, so the only way to notice is that
// the effect is still in the listing afterwards.
response = await fetch(`${API}/assets/record?assetId=${assetId}`);
const recordFinal = await response.json().catch(() => ({}));
const filename = String(recordFinal.filePath || recordAfter.filePath).replace(/^data\/assets\//, '');
response = await fetch(`${API}/assets/library`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'vfx', filename, name: 'E2E Renamed' }),
});
check('rename works through the library route', response.ok, String(response.status));

response = await fetch(`${API}/assets/library?type=vfx&filename=${encodeURIComponent(filename)}`, { method: 'DELETE' });
check('delete works through the library route', response.status === 204 || response.ok, String(response.status));

response = await fetch(`${API}/assets/library`);
const after = await response.json();
check('  and it is gone from the listing',
  !(after.vfx || []).some(a => String(a.id).replace('library:', '') === String(assetId)),
  `${(after.vfx || []).length} effects left`);

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
