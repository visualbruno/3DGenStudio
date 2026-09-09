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

// --- 6. Rename, then delete ------------------------------------------------
// The CURRENT filename, not the one from before the replace.
const filename = String(recordAfter.filePath).replace(/^data\/assets\//, '');
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
