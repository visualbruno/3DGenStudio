// The other cross-install check: does an effect exported as an ENGINE BUNDLE
// still point at its own textures after being imported somewhere else?
//
// tools/vfx-export-e2e.mjs asks that question of a .3dgp PROJECT bundle, where
// the remap happens on the server during import. This asks it of the VFX bundle
// written by VfxExportDialog, where the remap happens in the BROWSER - see
// src/utils/vfx/bundleImport.js for why that side owns it.
//
// It is the same failure mode and it is just as silent: `asset:41` is a row in
// the exporting machine's database, and on a second install 41 is either
// nothing or an unrelated image. The importer cannot see the breakage from its
// own machine, because its library really does contain a 41 - which is why this
// needs TWO installations with genuinely different numbering and cannot be
// proved with one.
//
// Not part of the `node vfx/*.test.mjs` sweep, for the reason tools/vfx-e2e.mjs
// gives: those are pure and this one wants two live servers.
//
// HOW TO RUN:
//
//     mkdir -p /tmp/a /tmp/b /tmp/bundle
//     (cd /tmp/a && PORT=3399 node /path/to/server.js &)
//     (cd /tmp/b && PORT=3397 node /path/to/server.js &)
//     VFX_BUNDLE=/tmp/bundle node tools/vfx-bundle-import-e2e.mjs
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readVfxBundle, importVfxBundle } from '../src/utils/vfx/bundleImport.js';
import { serializeVfxDoc, vfxAssetDigest } from '../vfx/doc.js';

const A = process.env.VFX_A || 'http://127.0.0.1:3399';
const B = process.env.VFX_B || 'http://127.0.0.1:3397';
const BUNDLE = process.env.VFX_BUNDLE;

if (!BUNDLE || !path.isAbsolute(BUNDLE)) {
  console.error('Set VFX_BUNDLE to an absolute path to an empty directory.');
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(56)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
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

// --- Seed B, so its numbering cannot coincide with A's ----------------------
for (let i = 0; i < 5; i += 1) {
  const filler = new FormData();
  filler.append('file', new File([PNG_1PX], `filler${i}.png`, { type: 'image/png' }));
  filler.append('type', 'image');
  filler.append('name', `Filler ${i}`);
  await fetch(`${B}/api/assets/library-upload`, { method: 'POST', body: filler });
}
console.log('  (seeded B with 5 assets so its ids cannot coincide)');

// --- On installation A: a texture, an effect that uses it, and a bundle -----
const upload = async (origin, file, type, name) => {
  const form = new FormData();
  form.append('file', file);
  form.append('type', type);
  form.append('name', name);
  return json(`${origin}/api/assets/library-upload`, { method: 'POST', body: form });
};

let result = await upload(A, new File([PNG_1PX], 'spark.png', { type: 'image/png' }), 'image', 'Spark');
check('A: created the texture', result.ok, `id ${result.payload?.id}`);
const imageId = numericId(result.payload.id);

const doc = {
  format: 1,
  kind: 'vfx-graph',
  name: 'Bundled Effect',
  effect: { seed: 7, duration: 1, loop: true, fixedDt: 1 / 60, capacity: 256 },
  systems: [{
    name: 'S',
    capacity: 64,
    contexts: [
      { kind: 'spawn', blocks: [{ id: 'b1', type: 'spawn.burst', enabled: true, props: { count: 5 } }] },
      { kind: 'initialize', blocks: [{ id: 'b2', type: 'initialize.setLifetime', enabled: true, props: { lifetime: 1 } }] },
      { kind: 'output', blocks: [{ id: 'b3', type: 'output.setMainTexture', enabled: true, props: { texture: 'tex_spark' } }], params: {} },
    ],
  }],
  references: { tex_spark: { kind: 'image', ref: `asset:${imageId}`, name: 'spark.png', colorSpace: 'srgb' } },
};

const vfxForm = new FormData();
vfxForm.append('file', new File([JSON.stringify(doc, null, 2)], 'bundled.vfx.json', { type: 'application/json' }));
vfxForm.append('type', 'vfx');
vfxForm.append('name', 'Bundled Effect');
vfxForm.append('metadata', JSON.stringify({
  kind: 'vfx-graph', format: 1, textureRefs: [`asset:${imageId}`], meshRefs: [],
}));
result = await json(`${A}/api/assets/library-upload`, { method: 'POST', body: vfxForm });
check('A: created the effect', result.ok, `id ${result.payload?.id}`);
const vfxId = numericId(result.payload.id);

// A card image, so the bundle has one to carry. Without it `row.thumbnail` is
// null, the export writes no vfx/*.png, and "did the thumbnail travel?" would
// be asking about a file that never existed.
const thumbForm = new FormData();
thumbForm.append('thumbnail', new File([PNG_1PX], 'card.png', { type: 'image/png' }));
result = await json(`${A}/api/assets/${vfxId}/thumbnail`, { method: 'POST', body: thumbForm });
check('A: gave the effect a card image', result.ok, result.payload?.error || '');

result = await json(`${A}/api/assets/${vfxId}/vfx-export`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: BUNDLE, name: 'Bundled Effect' }),
});
check('A: wrote the bundle', result.ok, result.payload?.error || result.payload?.folder || '');
const bundleDir = result.payload?.folder;

// --- Read the folder back the way a directory input hands it over ----------
// `webkitRelativePath` is the only thing the browser adds that node does not,
// and it is what indexBundleFiles locates the manifest with - so the harness
// reproduces it rather than the importer having a node-shaped code path.
async function pickFolder(root) {
  const picked = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const relative = path
        .join(path.basename(root), path.relative(root, full))
        .replace(/\\/g, '/');
      const file = new File([await fs.readFile(full)], entry.name);
      Object.defineProperty(file, 'webkitRelativePath', { value: relative });
      picked.push(file);
    }
  };
  await walk(root);
  return picked;
}

const selection = await pickFolder(bundleDir);
check('the folder holds a manifest and an assets tree', selection.length >= 3, `${selection.length} files`);

const bundle = await readVfxBundle(selection);
check('the bundle reads', bundle.name === 'Bundled Effect', bundle.name);
check('and names one texture to install', bundle.summary.textures === 1, JSON.stringify(bundle.summary));

// --- On installation B: install it through the real routes ------------------
const imported = await importVfxBundle(bundle, {
  listLibrary: async () => (await json(`${B}/api/assets/library`)).payload,
  uploadAssets: async (assets, options) => {
    const form = new FormData();
    for (const asset of assets) form.append('files', asset.file);
    const response = await json(
      `${B}/api/assets/library/import?assetType=${encodeURIComponent(options.assetType)}`,
      { method: 'POST', body: form },
    );
    if (!response.ok) throw new Error(response.payload?.error || 'upload failed');
    return response.payload;
  },
  // What vfxApi's saveVfxAsset does, against B. Spelled out rather than
  // imported because that module pulls in src/config.js, which reads
  // import.meta.env and cannot be loaded outside Vite.
  saveEffect: async ({ name, doc: graph, thumbnail }) => {
    const { doc: serialized } = serializeVfxDoc(graph, { name });
    const form = new FormData();
    form.append('file', new File(
      [JSON.stringify(serialized, null, 2)],
      `${name.replace(/[^\w.-]+/g, '_')}.vfx.json`,
      { type: 'application/json' },
    ));
    form.append('type', 'vfx');
    form.append('name', name);
    form.append('metadata', JSON.stringify(vfxAssetDigest(serialized, { source: 'VFX BUNDLE IMPORT' })));
    const saved = await json(`${B}/api/assets/library-upload`, { method: 'POST', body: form });
    if (!saved.ok) throw new Error(saved.payload?.error || 'save failed');
    if (thumbnail) {
      const thumbForm = new FormData();
      thumbForm.append('thumbnail', thumbnail);
      await fetch(`${B}/api/assets/${numericId(saved.payload.id)}/thumbnail`, { method: 'POST', body: thumbForm });
    }
    return saved.payload;
  },
});

check('B: the effect was saved', Boolean(imported.asset?.id), String(imported.asset?.id));
// installed OR reused: the tool is re-runnable, and on a second run B already
// holds the texture from the first. Which of the two it was is pinned by the
// dedicated re-import check at the bottom.
check('B: the texture was resolved', imported.installed.length + imported.reused.length === 1,
  `installed ${imported.installed.length}, reused ${imported.reused.length}`);
check('B: nothing was left unresolved', imported.missing.length === 0, JSON.stringify(imported.missing));
check('B: nothing failed', imported.failed.length === 0, JSON.stringify(imported.failed));

const library = (await json(`${B}/api/assets/library`)).payload;
const importedVfx = (library.vfx || []).find(a => numericId(a.id) === numericId(imported.asset.id));
// "Spark.png", not "Spark": /api/assets/library/import names an asset after the
// file it arrived as, and the bundle importer keeps the extension so the stored
// file still has one. The reuse match below is what makes the two the same
// asset on a second import.
const importedImage = (library.images || []).find(a => /^spark\.png$/i.test(a.name || ''));
check('B: the effect is in the library', Boolean(importedVfx), importedVfx?.name);
check('B: so is its texture', Boolean(importedImage), importedImage?.name);

if (importedVfx && importedImage) {
  const newImageId = numericId(importedImage.id);
  const fileUrl = `${B}/assets/${String(importedVfx.filePath || importedVfx.filename).replace(/^data\/assets\//, '')}`;
  const graph = await (await fetch(fileUrl, { cache: 'reload' })).json();
  const ref = graph?.references?.tex_spark?.ref;

  check('B: ids were renumbered on this install', newImageId !== imageId, `${imageId} -> ${newImageId}`);
  // THE CHECK. Without the remap this still reads A's id, and the effect
  // silently draws with whatever asset happens to hold that number on B.
  check('B: THE GRAPH FILE POINTS AT B\'S ID', ref === `asset:${newImageId}`,
    `${ref} (expected asset:${newImageId})`);

  const record = (await json(`${B}/api/assets/record?assetId=${numericId(importedVfx.id)}`)).payload;
  const meta = typeof record?.metadata === 'string' ? JSON.parse(record.metadata) : record?.metadata || {};
  check('B: and so does the metadata digest', meta.textureRefs?.[0] === `asset:${newImageId}`,
    String(meta.textureRefs?.[0]));
  check('B: the card thumbnail travelled', Boolean(importedVfx.thumbnail || importedVfx.thumbnailPath),
    String(importedVfx.thumbnail || importedVfx.thumbnailPath));
}

// --- Import it a SECOND time: the texture must be adopted, not duplicated ---
const again = await importVfxBundle(await readVfxBundle(selection), {
  name: 'Bundled Effect (copy)',
  listLibrary: async () => (await json(`${B}/api/assets/library`)).payload,
  uploadAssets: async () => { throw new Error('should not upload on a re-import'); },
  saveEffect: async ({ name, doc: graph }) => {
    const { doc: serialized } = serializeVfxDoc(graph, { name });
    const form = new FormData();
    form.append('file', new File([JSON.stringify(serialized)], 'copy.vfx.json', { type: 'application/json' }));
    form.append('type', 'vfx');
    form.append('name', name);
    form.append('metadata', JSON.stringify(vfxAssetDigest(serialized, { source: 'VFX BUNDLE IMPORT' })));
    const saved = await json(`${B}/api/assets/library-upload`, { method: 'POST', body: form });
    if (!saved.ok) throw new Error(saved.payload?.error || 'save failed');
    return saved.payload;
  },
});
check('B: a re-import reuses the texture', again.reused.length === 1 && again.installed.length === 0,
  `reused ${again.reused.length}, installed ${again.installed.length}`);

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
