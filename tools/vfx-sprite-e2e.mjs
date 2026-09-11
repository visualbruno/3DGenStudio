// End-to-end for the VFX sprite tools, against a RUNNING server.
//
//     npm run dev      (or any server on :3001)
//     node tools/vfx-sprite-e2e.mjs
//
// NOT PART OF THE HEADLESS SUITE, because it needs a database and it WRITES to
// the library - it installs two bundled sprites and leaves them there, which is
// exactly what it is checking. Run it after touching the pack, the install path
// or the reference wiring.
//
// Both bugs this found on its first run were invisible to every headless check:
// presetAssetName takes a NEED and was handed a FILENAME, so every sprite
// installed as "VFX undefined" - and a missing asset threw a JSON parse error
// instead of answering the question.
import { createApiClient } from '../mcp/client.js';
import { registerVfxTools } from '../mcp/tools/vfx.js';

const handlers = new Map();
const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
const api = createApiClient('http://127.0.0.1:3001');
registerVfxTools(server, { api, notifyMutation: () => {} });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(56)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
};
const call = async (name, args) => {
  const res = await handlers.get(name)(args || {});
  return JSON.parse(res.content[0].text);
};

console.log('--- list_vfx_sprites ---');
const listed = await call('list_vfx_sprites');
check('the pack is listed', Array.isArray(listed.assets) && listed.assets.length >= 14,
  `${listed.assets?.length} files`);
check('  including the new flipbook sheet',
  listed.assets.some((a) => a.file === 'smoke-roll-4x4.png'));
check('  and each says whether it is installed',
  listed.assets.every((a) => typeof a.installed === 'boolean'));

console.log('\n--- install_vfx_sprite ---');
const first = await call('install_vfx_sprite', { file: 'ring.png' });
check('a pack sprite installs and returns an id', Number.isFinite(first.assetId),
  JSON.stringify(first));
check('  with an asset: ref ready to use', first.ref === `asset:${first.assetId}`);

// IDEMPOTENT. The editor installs on every preset open, so a second call that
// uploaded again would fill the library with duplicates.
const second = await call('install_vfx_sprite', { file: 'ring.png' });
check('installing twice finds the first copy', second.assetId === first.assetId,
  `${first.assetId} vs ${second.assetId}`);
check('  and says it did not upload', second.installed === false);

// TWO DIFFERENT FILES MUST GET TWO DIFFERENT IDS. This is the check that was
// missing when the first run installed everything as "VFX undefined": the
// same-file idempotency check passed, because the name matched, and so would a
// second DIFFERENT sprite - it would have silently returned the ring's id and
// every effect would have worn the same texture.
const other = await call('install_vfx_sprite', { file: 'spark-streak.png' });
check('a different sprite gets a different id', other.assetId !== first.assetId,
  `${first.assetId} vs ${other.assetId}`);
check('  and a name derived from its own filename', other.name === 'VFX Spark Streak',
  other.name);

const missing = await call('install_vfx_sprite', { file: 'not-a-file.png' });
check('an unknown file is refused with the real list',
  typeof missing.error === 'string' && Array.isArray(missing.available));

console.log('\n--- set_vfx_texture ---');
const templates = await call('list_vfx_assets').catch(() => null);
const graph = {
  format: 1,
  kind: 'vfx-graph',
  name: 'Sprite wiring probe',
  systems: [{
    name: 'S',
    contexts: [
      { kind: 'spawn', blocks: [{ id: 'b1', type: 'spawn.rate', props: { rate: { mode: 'const', v: 50 } } }] },
      { kind: 'initialize', blocks: [
        { id: 'b2', type: 'initialize.setLifetime', props: { lifetime: { mode: 'const', v: 1 } } },
        { id: 'b3', type: 'initialize.setSize', props: { size: { mode: 'const', v: 0.2 } } },
      ] },
      { kind: 'update', blocks: [] },
      { kind: 'output', params: { mode: 'billboard', blend: 'additive', sort: 'none' },
        blocks: [{ id: 'b4', type: 'output.setMainTexture', props: {} }] },
    ],
  }],
};

const wired = await call('set_vfx_texture', {
  graph, slot: 'tex_ring', assetId: first.assetId, blockId: 'b4',
});
check('the slot is written into references',
  wired.graph?.references?.tex_ring?.ref === `asset:${first.assetId}`,
  JSON.stringify(wired.graph?.references));
// THE HALF THAT IS EASY TO FORGET: the block has to name the slot too, or the
// reference sits in the document doing nothing.
check('  and the block now names the slot',
  wired.pointedAt?.blockId === 'b4',
  JSON.stringify(wired.pointedAt));
const out = wired.graph.systems[0].contexts.find((c) => c.kind === 'output');
const texBlock = out.blocks.find((b) => b.id === 'b4');
check('  with the slot key, not the asset id',
  texBlock?.props?.texture?.v === 'tex_ring', JSON.stringify(texBlock?.props));
check('  and nothing in the graph still warns about a missing asset',
  !wired.diagnostics.some((d) => d.code === 'W_MISSING_ASSET'),
  wired.diagnostics.map((d) => d.code).join(' ') || 'clean');

const badAsset = await call('set_vfx_texture', { graph, slot: 's', assetId: 999999 });
check('an asset that does not exist is refused', typeof badAsset.error === 'string',
  badAsset.error);

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
