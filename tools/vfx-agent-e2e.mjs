// Can an agent author a VFX effect through the MCP tools, using nothing but
// what those tools report?
//
// THIS IS A CAPABILITY CHECK, NOT A UNIT TEST. It asks the question a user asked
// directly - "check that an AI can generate a VFX with all available functions
// and parameters" - and it answers it the only honest way: by discovering the
// catalog through the tools, composing a document from what they said, and
// compiling it.
//
// IT FOUND TWO REAL GAPS THE FIRST TIME IT WAS RUN, both of which are fixed and
// both of which this file now guards:
//
//   1. NO DISCOVERY. There was no way to learn what blocks exist. get_vfx_graph
//      shows what an effect USES, so an agent could only ever recombine blocks
//      some existing effect already happened to use - a catalog of 35 blocks
//      reachable only through whichever handful the templates touch.
//
//   2. SILENT ACCEPTANCE OF NONSENSE, which was the worse one. Unknown block
//      TYPES were reported, but unknown property NAMES, invalid mode values and
//      invalid Output params were accepted without a word: the lowering walks
//      the catalog's property list, so a property the catalog does not define is
//      never visited. A line emitter given `from`/`to` instead of `start`/`end`
//      compiled CLEAN and silently drew a one-metre default line where a
//      four-metre beam was asked for. A human cannot produce that - the
//      inspector only offers real properties - so nothing had ever checked.
//
// HOW TO RUN. Needs a server with its own data directory; it creates one asset.
//
//     mkdir /tmp/vfxagent && cd /tmp/vfxagent
//     PORT=3410 node /path/to/3DGenStudio/server.js &
//     node /path/to/3DGenStudio/tools/vfx-agent-e2e.mjs
//
const BASE = process.env.MCP_BASE || 'http://127.0.0.1:3410';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(56)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
};

let nextId = 1;
async function call(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(line.slice(6));
  if (payload.error) throw new Error(`${name}: ${payload.error.message}`);
  const content = payload.result?.content?.[0]?.text;
  if (payload.result?.isError) throw new Error(`${name}: ${content}`);
  return JSON.parse(content);
}

// --- 1. discovery -----------------------------------------------------------
const catalog = await call('describe_vfx_catalog', {});
check('the catalog is discoverable at all', catalog.counts?.blocks > 30,
  `${catalog.counts?.blocks} blocks, ${catalog.counts?.operators} operators`);
check('  every block names the stages it runs in',
  catalog.blocks.every((b) => Array.isArray(b.contexts) && b.contexts.length > 0));
check('  and its real property names, with types and defaults',
  catalog.blocks.every((b) => b.props.every(
    (p) => p.name && p.type && p.default !== undefined && Array.isArray(p.modes),
  )));
check('  the Output stage exposes its params and their valid values',
  catalog.contexts.find((c) => c.kind === 'output').params
    .find((p) => p.name === 'blend').options.includes('premultiplied'));
// The one param whose values come from the document rather than the catalog.
// Reported as an empty list, which reads as "nothing is valid" unless the
// caller is told where the values come from - and that param IS the sub-emitter
// wiring, so leaving it unexplained puts the whole feature out of reach.
check('  and a document-sourced param says so rather than looking empty',
  catalog.contexts.find((c) => c.kind === 'event').params
    .find((p) => p.name === 'source').optionsFrom === 'systems');

const filtered = await call('describe_vfx_catalog', { context: 'initialize', search: 'line' });
check('the catalog can be narrowed', filtered.blocks.length === 1
  && filtered.blocks[0].id === 'initialize.positionLine',
filtered.blocks.map((b) => b.id).join(' '));
check('  reporting the block choices, not just the properties',
  filtered.blocks[0].choices.find((c) => c.name === 'placement').options.join(',') === 'random,even,spacing');

// --- 2. nonsense is reported, not swallowed --------------------------------
//
// Every mistake below is one an agent actually made on its first attempt.
const wrong = await call('compile_vfx_graph', {
  graph: {
    kind: 'vfx-graph',
    format: 1,
    name: 'Wrong',
    systems: [{
      name: 'Beam',
      capacity: 256,
      contexts: [
        { kind: 'spawn', blocks: [{ type: 'spawn.rate', props: { rate: { mode: 'const', v: 60 } } }] },
        {
          kind: 'initialize',
          blocks: [
            { type: 'initialize.setLifetime', props: { lifetime: { mode: 'const', v: 1 } } },
            {
              type: 'initialize.positionLine',
              props: {
                from: { mode: 'const', v: [-2, 0, 0] },
                to: { mode: 'const', v: [2, 0, 0] },
              },
              modes: { placement: 'sequential' },
            },
            { type: 'initialize.setGlow', props: { glow: { mode: 'const', v: 2 } } },
          ],
        },
        { kind: 'output', params: { mode: 'sparks', blend: 'add' }, blocks: [] },
      ],
    }],
  },
});
const codes = wrong.summary.diagnostics.map((d) => d.code);
const has = (code) => codes.filter((c) => c === code).length;
check('an invented block type is reported', has('E_UNKNOWN_BLOCK') === 1, codes.join(' '));
check('an invented property is reported, once each', has('W_UNKNOWN_PROP') === 2,
  `${has('W_UNKNOWN_PROP')} of 2`);
check('an invalid mode value is reported', has('W_UNKNOWN_MODE') === 1);
check('invalid Output params are reported, both', has('W_UNKNOWN_PARAM') === 2,
  `${has('W_UNKNOWN_PARAM')} of 2`);
// THE REPAIR SIGNAL. Being told a name is wrong is useless without being told
// what the right ones are - that is the difference between a loop that
// converges and one that guesses again.
const propDiag = wrong.summary.diagnostics.find((d) => d.code === 'W_UNKNOWN_PROP');
check('  and the hint names the properties the block DOES have',
  ['start', 'end', 'thickness'].every((n) => propDiag.hint.includes(n)), propDiag.hint);
check('  so the whole thing fails loudly rather than drawing the wrong effect',
  wrong.ok === false);

// --- 3. author a real effect from what the tools said ----------------------
//
// Three systems, three different emitter shapes including two added after the
// catalog tool existed, a curve, a gradient, two burst clips and a stretched
// output. Nothing here was read from the source.
const key = (id) => catalog.blocks.find((b) => b.id === id);
check('every block this effect uses is in the catalog',
  ['initialize.positionCircle', 'initialize.positionPoint', 'initialize.positionLine',
    'update.sizeOverLife', 'update.colorOverLife', 'output.setMainTexture']
    .every((id) => Boolean(key(id))));

const portal = {
  kind: 'vfx-graph',
  format: 1,
  name: 'Agent Portal',
  effect: { duration: 3, loop: true, capacity: 8192 },
  systems: [
    {
      name: 'Ring',
      capacity: 2048,
      contexts: [
        { kind: 'spawn', blocks: [{ type: 'spawn.rate', props: { rate: { mode: 'const', v: 400 } } }] },
        {
          kind: 'initialize',
          blocks: [
            { type: 'initialize.setLifetime', props: { lifetime: { mode: 'random', a: 0.6, b: 1.4, v: 1 } } },
            { type: 'initialize.setSize', props: { size: { mode: 'random', a: 0.04, b: 0.12, v: 0.08 } } },
            { type: 'initialize.setColor', props: { color: { mode: 'const', v: [0.6, 0.4, 1, 1] } } },
            {
              type: 'initialize.positionCircle',
              props: {
                radius: { mode: 'const', v: 1.2 },
                thickness: { mode: 'const', v: 0.06 },
                // Standing the flat ring up - the transform's headline case.
                rotation: { mode: 'const', v: [90, 0, 0] },
                offset: { mode: 'const', v: [0, 1.2, 0] },
              },
            },
            { type: 'initialize.velocityRadial', props: { speed: { mode: 'random', a: 0.1, b: 0.5, v: 0.3 } } },
          ],
        },
        {
          kind: 'update',
          blocks: [
            { type: 'update.drag', props: { drag: { mode: 'const', v: 1.5 } } },
            {
              type: 'update.sizeOverLife',
              props: {
                scale: {
                  mode: 'curve', domain: 'life', scale: 1, v: 1,
                  curve: {
                    keys: [
                      { t: 0, v: 0, inTangent: 0, outTangent: 4, interp: 'free' },
                      { t: 0.2, v: 1, inTangent: 0, outTangent: 0, interp: 'free' },
                      { t: 1, v: 0, inTangent: -1.2, outTangent: 0, interp: 'free' },
                    ],
                    preWrap: 'clamp', postWrap: 'clamp',
                  },
                },
              },
            },
            {
              type: 'update.colorOverLife',
              props: {
                color: {
                  mode: 'gradient', domain: 'life', v: [1, 1, 1, 1],
                  gradient: {
                    mode: 'blend',
                    colorKeys: [
                      { t: 0, hex: '#ffffff', intensity: 3 },
                      { t: 0.35, hex: '#8a5cff', intensity: 2 },
                      { t: 1, hex: '#2a1050', intensity: 1 },
                    ],
                    alphaKeys: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 1, a: 0 }],
                  },
                },
              },
            },
          ],
        },
        { kind: 'output', params: { mode: 'billboard', blend: 'additive', sort: 'none' }, blocks: [] },
      ],
    },
    {
      name: 'Motes',
      capacity: 1024,
      contexts: [
        { kind: 'spawn', blocks: [{ type: 'spawn.rate', props: { rate: { mode: 'const', v: 90 } } }] },
        {
          kind: 'initialize',
          blocks: [
            { type: 'initialize.setLifetime', props: { lifetime: { mode: 'random', a: 1.2, b: 2.6, v: 1.9 } } },
            { type: 'initialize.setSize', props: { size: { mode: 'random', a: 0.02, b: 0.06, v: 0.04 } } },
            { type: 'initialize.setColor', props: { color: { mode: 'const', v: [0.75, 0.6, 1, 1] } } },
            {
              type: 'initialize.positionPoint',
              props: { offset: { mode: 'const', v: [0, 0.3, 0] }, jitter: { mode: 'const', v: 1.1 } },
            },
            {
              type: 'initialize.velocityDirection',
              props: {
                direction: { mode: 'const', v: [0, 1, 0] },
                speed: { mode: 'random', a: 0.2, b: 0.7, v: 0.45 },
                spread: { mode: 'const', v: 35 },
              },
            },
          ],
        },
        {
          kind: 'update',
          blocks: [
            { type: 'update.turbulence', props: { strength: { mode: 'const', v: 0.8 }, frequency: { mode: 'const', v: 1.4 } } },
            { type: 'update.drag', props: { drag: { mode: 'const', v: 0.6 } } },
          ],
        },
        { kind: 'output', params: { mode: 'billboard', blend: 'additive', sort: 'none' }, blocks: [] },
      ],
    },
    {
      name: 'Arcs',
      capacity: 512,
      schedule: { clips: [{ at: 0, duration: 0, loop: false }, { at: 1.5, duration: 0, loop: false }] },
      contexts: [
        { kind: 'spawn', blocks: [{ type: 'spawn.burst', props: { count: { mode: 'const', v: 24 } } }] },
        {
          kind: 'initialize',
          blocks: [
            { type: 'initialize.setLifetime', props: { lifetime: { mode: 'const', v: 0.35 } } },
            { type: 'initialize.setSize', props: { size: { mode: 'const', v: 0.05 } } },
            { type: 'initialize.setColor', props: { color: { mode: 'const', v: [1, 1, 1, 1] } } },
            {
              type: 'initialize.positionLine',
              props: {
                start: { mode: 'const', v: [-1.2, 1.2, 0] },
                end: { mode: 'const', v: [1.2, 1.2, 0] },
                thickness: { mode: 'const', v: 0.03 },
                spacing: { mode: 'const', v: 0.1 },
              },
              modes: { placement: 'spacing' },
            },
          ],
        },
        { kind: 'update', blocks: [{ type: 'update.gravity', props: { gravity: { mode: 'const', v: [0, -1.5, 0] } } }] },
        { kind: 'output', params: { mode: 'stretched', blend: 'additive', sort: 'none' }, blocks: [] },
      ],
    },
  ],
};

const built = await call('compile_vfx_graph', { graph: portal });
const noisy = built.summary.diagnostics.filter((d) => d.severity !== 'info');
check('a three-system effect authored from the catalog compiles', built.ok === true,
  built.summary.diagnostics.map((d) => d.code).join(' '));
check('  with no warnings either', noisy.length === 0, noisy.map((d) => d.code).join(' '));
check('  and real numbers behind it',
  built.summary.stats.peakParticles > 100 && built.summary.stats.drawCalls > 0,
  `${built.summary.stats.peakParticles} particles, ${built.summary.stats.drawCalls} draws`);
check('  three systems survived', built.summary.systems.length === 3);
check('  the curve and the gradient both baked',
  built.summary.stats.tableCount >= 2, `${built.summary.stats.tableCount} tables`);
check('  and the second burst clip is on the timeline',
  built.summary.systems.find((s) => s.name === 'Arcs').clips.length === 2);

// --- 4. it round-trips through a save --------------------------------------
const saved = await call('save_vfx_graph', { graph: portal, name: 'Agent Portal' });
check('the effect saves', Number.isFinite(saved.assetId) && saved.created, `id ${saved.assetId}`);
const reopened = await call('get_vfx_graph', { assetId: saved.assetId, includeGraph: false });
check('  and reads back with everything intact',
  reopened.summary.systems.length === 3
  && reopened.summary.duration === 3,
  `${reopened.summary.systems.length} systems, ${reopened.summary.duration}s`);
check('  including the emitter shapes it was given',
  reopened.summary.systems[2].contexts
    .find((c) => c.kind === 'initialize').blocks.includes('initialize.positionLine'));

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
