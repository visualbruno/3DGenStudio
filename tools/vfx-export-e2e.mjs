// The cross-install check: does an exported VFX effect still point at its own
// textures after being imported somewhere else?
//
// This is the failure the remap in storage.js Phase B exists to prevent, and it
// is the easiest thing in the whole feature to ship broken, because it fails
// SILENTLY and only in a SECOND installation. Tree presets ship broken in
// exactly this way today: they store bare numeric asset ids, which
// collectAssetIdsFromValue cannot see, so a tree in a .3dgp does not bring its
// bark texture and its ids point at the exporting machine's numbering.
//
// Two servers, two data directories, one bundle passed between them.
//
// HOW TO RUN. Needs TWO servers with separate data directories:
//
//     mkdir -p /tmp/a /tmp/b
//     (cd /tmp/a && PORT=3399 node /path/to/server.js &)
//     (cd /tmp/b && PORT=3397 node /path/to/server.js &)
//     VFX_BUNDLE=/abs/path/to/an/empty/dir node tools/vfx-export-e2e.mjs
//
// The two data directories are the point: with one installation the imported
// ids coincide with the exported ones and the remap check proves nothing.
const A = process.env.VFX_A || 'http://127.0.0.1:3399';
const B = process.env.VFX_B || 'http://127.0.0.1:3397';
const BUNDLE = process.env.VFX_BUNDLE;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(54)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
};

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const json = async (url, options) => {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
};
const numericId = value => Number(String(value).replace('library:', ''));

// --- Seed installation B first ---------------------------------------------
// Without this B is empty, so the imported texture is handed id 1 - the same id
// it had on A - and the remap check passes while proving nothing. Making the
// numbering genuinely differ is the whole point of testing across installs.
for (let i = 0; i < 3; i += 1) {
  const filler = new FormData();
  filler.append('file', new File([PNG_1PX], `filler${i}.png`, { type: 'image/png' }));
  filler.append('type', 'image');
  filler.append('name', `Filler ${i}`);
  await fetch(`${B}/api/assets/library-upload`, { method: 'POST', body: filler });
}
console.log("  (seeded B with 3 assets so its ids cannot coincide)");

// --- On installation A -----------------------------------------------------
const imageForm = new FormData();
imageForm.append('file', new File([PNG_1PX], 'spark.png', { type: 'image/png' }));
imageForm.append('type', 'image');
imageForm.append('name', 'Spark');
let result = await json(`${A}/api/assets/library-upload`, { method: 'POST', body: imageForm });
check('A: created the texture', result.ok, `id ${result.payload?.id}`);
const imageId = numericId(result.payload.id);

// A graph that references it, in the canonical 'asset:<id>' string form.
const doc = {
  format: 1,
  kind: 'vfx-graph',
  name: 'Portable Effect',
  effect: { seed: 7, duration: 1, loop: true, fixedDt: 1 / 60, capacity: 256 },
  systems: [{
    name: 'S', capacity: 64,
    contexts: [
      { kind: 'spawn', blocks: [{ id: 'b1', type: 'spawn.burst', enabled: true, props: { count: 5 } }] },
      { kind: 'initialize', blocks: [{ id: 'b2', type: 'initialize.setLifetime', enabled: true, props: { lifetime: 1 } }] },
      { kind: 'output', blocks: [{ id: 'b3', type: 'output.setMainTexture', enabled: true, props: { texture: 'tex_spark' } }], params: {} },
    ],
  }],
  references: { tex_spark: { kind: 'image', ref: `asset:${imageId}`, name: 'spark.png', colorSpace: 'srgb' } },
};

const vfxForm = new FormData();
vfxForm.append('file', new File([JSON.stringify(doc, null, 2)], 'portable.vfx.json', { type: 'application/json' }));
vfxForm.append('type', 'vfx');
vfxForm.append('name', 'Portable Effect');
// The digest, in the same 'asset:<id>' array form - this is what the export
// walker actually finds.
vfxForm.append('metadata', JSON.stringify({
  kind: 'vfx-graph', format: 1, textureRefs: [`asset:${imageId}`], meshRefs: [],
}));
result = await json(`${A}/api/assets/library-upload`, { method: 'POST', body: vfxForm });
check('A: created the effect', result.ok, `id ${result.payload?.id}`);
const vfxId = numericId(result.payload.id);

result = await json(`${A}/api/projects`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Export Source', preset: 'Kanban' }),
});
check('A: created a project', result.ok, `id ${result.payload?.id}`);
const projectId = result.payload.id;

// Linked by assetId, not by filename: the filename branch mints a NEW project
// asset rather than linking the existing one.
for (const [label, id] of [['effect', vfxId], ['texture', imageId]]) {
  result = await json(`${A}/api/projects/${projectId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: id }),
  });
  check(`A: linked the ${label}`, result.ok, String(result.status));
}

result = await json(`${A}/api/projects/${projectId}/export`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: BUNDLE }),
});
check('A: exported the project', result.ok, result.payload?.error || result.payload?.folder || '');
const exportedTo = result.payload?.folder || result.payload?.path || BUNDLE;

// --- On installation B -----------------------------------------------------
result = await json(`${B}/api/projects/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: exportedTo, name: 'Imported' }),
});
check('B: imported the project', result.ok, result.payload?.error || `project ${result.payload?.id}`);

const library = (await json(`${B}/api/assets/library`)).payload;
const importedVfx = (library.vfx || []).find(a => a.name === 'Portable Effect');
const importedImage = (library.images || []).find(a => a.name === 'Spark');
check('B: the effect arrived', Boolean(importedVfx), importedVfx?.name);
// If the texture did not travel, the export walker never saw the reference -
// which is the tree-preset bug.
check('B: the texture travelled with it', Boolean(importedImage), importedImage?.name);

if (importedVfx && importedImage) {
  const newImageId = numericId(importedImage.id);
  const fileUrl = `${B}/assets/${String(importedVfx.filePath || importedVfx.filename).replace(/^data\/assets\//, '')}`;
  const graph = await (await fetch(fileUrl, { cache: 'reload' })).json();
  const ref = graph?.references?.tex_spark?.ref;

  check('B: ids were renumbered on this install', newImageId !== imageId, `${imageId} -> ${newImageId}`);
  // THE CHECK. Without the Phase B file rewrite this still says the exporting
  // machine's id, and the effect silently draws with whatever asset happens to
  // hold that number here.
  check('B: THE GRAPH FILE POINTS AT THE NEW ID', ref === `asset:${newImageId}`,
    `${ref} (expected asset:${newImageId})`);

  const record = (await json(`${B}/api/assets/record?assetId=${numericId(importedVfx.id)}`)).payload;
  const meta = typeof record?.metadata === 'string' ? JSON.parse(record.metadata) : record?.metadata || {};
  check('B: and so does the metadata digest', meta.textureRefs?.[0] === `asset:${newImageId}`,
    String(meta.textureRefs?.[0]));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
