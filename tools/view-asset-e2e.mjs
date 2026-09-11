// End-to-end for view_asset's inline preview, against a RUNNING server.
//
//     npm run dev      (or any server on :3001)
//     node tools/view-asset-e2e.mjs
//
// WHAT IT GUARDS. A sprite too big to send used to come back as an opaque
// transport failure: the file was 1.03 MB, base64 made it ~1.4 MB, and the
// tool's own guard was set at 3.5 MB of RAW bytes so it could never fire first.
// An agent wired a matted sprite into an effect having never seen it. The reply
// is now shrunk to fit and, when the image has transparency, composited over a
// checkerboard so the SHAPE OF THE ALPHA is visible - which is what anyone
// checking a matte is actually looking at.
//
// Ids are DISCOVERED, not hard-coded: a probe that only runs on the machine it
// was written on stops being run at all.
import fs from 'node:fs';
import { createApiClient } from '../mcp/client.js';
import { registerAssetTools } from '../mcp/tools/assets.js';

const handlers = new Map();
const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
const api = createApiClient('http://127.0.0.1:3001');
registerAssetTools(server, { api, notifyMutation: () => {} });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(54)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
};

const projects = await api.apiJson('GET', '/projects');
const projectId = (Array.isArray(projects) ? projects : projects.projects || [])[0]?.id;
if (!projectId) {
  console.log('no projects in this library - nothing to probe');
  process.exit(0);
}

const assets = await api.apiJson('GET', '/assets', { query: { projectId } });
const rows = Array.isArray(assets) ? assets : assets.assets || [];
let target = null;
for (const asset of rows) {
  const file = asset.filename || asset.filePath || '';
  if (!/\.png$/i.test(file)) continue;
  const pixels = (asset.width || 0) * (asset.height || 0);
  if (pixels > (target?.width || 0) * (target?.height || 0)) target = asset;
}
if (!target) {
  console.log('no PNG assets in the first project - nothing to probe');
  process.exit(0);
}
console.log(`probing asset ${target.id} "${target.name}" ${target.width}x${target.height}\n`);

const res = await handlers.get('view_asset')({ projectId, assetId: target.id });
const image = res.content.find((c) => c.type === 'image');
const text = res.content.find((c) => c.type === 'text');

check('the sprite comes back as an image', Boolean(image), JSON.stringify(res).slice(0, 120));
if (image) {
  // THE POINT OF THE WHOLE CHANGE: whatever else happens, the reply fits.
  check('  inside the transport cap', image.data.length < 900 * 1024,
    `${(image.data.length / 1024).toFixed(0)}KB base64`);
  check('  as real PNG bytes',
    Buffer.from(image.data, 'base64').subarray(1, 4).toString('ascii') === 'PNG');
}

// SHRINKING IS CONDITIONAL, so it is asserted conditionally. An image that
// already fits is sent untouched, and a probe demanding "Shown at" from every
// asset would fail on a perfectly good reply - a test lying about a bug rather
// than finding one. (This is what the first version of this file got wrong.)
const wasShrunk = /Shown at \d+x\d+/.test(text?.text || '');
console.log(`  (this one ${wasShrunk ? 'needed' : 'did not need'} shrinking)`);
if (wasShrunk) {
  check('  and it says what it did, and from what size',
    /Shown at \d+x\d+ \(the full image is \d+x\d+\)/.test(text.text),
    text.text.split('\n')[0]);
}

// An explicit size ALWAYS resizes, so the resize path is exercised on every
// install rather than only where an asset happens to be huge.
const sized = await handlers.get('view_asset')({ projectId, assetId: target.id, maxWidth: 128 });
const sizedImage = sized.content.find((c) => c.type === 'image');
const sizedText = sized.content.find((c) => c.type === 'text')?.text || '';

check('an explicit maxWidth is honoured', /Shown at 128x\d+/.test(sizedText),
  sizedText.split('\n')[0]);
check('  and the reply is far smaller', sizedImage.data.length < 60 * 1024,
  `${(sizedImage.data.length / 1024).toFixed(0)}KB`);

// Transparency is the thing being inspected, so it has to be visible AND
// labelled - otherwise the checks read as part of the artwork.
if (/checkerboard/i.test(sizedText)) {
  check('  the checkerboard is declared as not being the artwork',
    /checkerboard is NOT part of the image/i.test(sizedText));
  check('  with the alpha profile as numbers',
    /"alpha":\{"clear":[\d.]+,"soft":[\d.]+,"solid":[\d.]+\}/.test(sizedText),
    sizedText.match(/"alpha":\{[^}]*\}/)?.[0]);
} else {
  console.log('  (no transparency in this one, so no checkerboard)');
}

const flat = await handlers.get('view_asset')({
  projectId, assetId: target.id, maxWidth: 96, alpha: 'off',
});
check('alpha:off skips the checkerboard',
  !/checkerboard/i.test(flat.content.find((c) => c.type === 'text')?.text || ''));

fs.writeFileSync(new URL('../view-asset-probe.png', import.meta.url),
  Buffer.from(sizedImage.data, 'base64'));

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
