// End-to-end for the server-side VFX preview renderer.
//
//     node tools/vfx-preview-e2e.mjs
//
// Mounts the route on its own port rather than talking to a running server, so
// it needs no database, no dev server and no GPU - and can be run while
// somebody is working in the app.
//
// THE BLANK-FRAME CHECKS ARE THE ONES THAT MATTER. A black image plus "ok" is
// the failure this whole feature exists to prevent, and there are three ways to
// produce one that have to be told apart: an empty document, an effect that
// does not compile, and an effect that genuinely emits nothing.
import express from 'express';
import fs from 'node:fs';
import { renderVfxFrames } from '../vfxPreview.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.post('/api/vfx/preview', async (req, res) => {
  try {
    const { graph, ...options } = req.body || {};
    if (!graph || typeof graph !== 'object') {
      return res.status(400).json({ error: 'Pass the effect document as `graph`.' });
    }
    const result = await renderVfxFrames(graph, options);
    res.json({
      ...result,
      frames: result.frames.map((f) => ({
        time: f.time, alive: f.alive, drawn: f.drawn, clipped: f.clipped,
        png: f.png.toString('base64'),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(3199);
const post = async (body) => {
  const res = await fetch('http://127.0.0.1:3199/api/vfx/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
};

const p = JSON.parse(fs.readFileSync(new URL('../resources/vfx/presets/explosion.json', import.meta.url), 'utf8'));

const ok = await post({ graph: p.doc, width: 320, height: 180 });
check('the route renders an effect', ok.status === 200 && ok.body.frames?.length === 4,
  `HTTP ${ok.status}, ${ok.body.frames?.length} frames`);
check('  and particles reach the frame', ok.body.frames.some((f) => f.drawn > 0),
  ok.body.frames.map((f) => f.drawn).join('/'));
check('  as real PNG bytes', ok.body.frames.every((f) => {
  const head = Buffer.from(f.png, 'base64').subarray(0, 8);
  return head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG';
}));
check('  at the size asked for', ok.body.stats.width === 320 && ok.body.stats.height === 180);

const timed = await post({ graph: p.doc, times: [0.5], width: 128, height: 128 });
check('an explicit time gives exactly that frame',
  timed.body.frames.length === 1 && Math.abs(timed.body.frames[0].time - 0.5) < 0.05,
  JSON.stringify(timed.body.frames.map((f) => f.time)));

const noGraph = await post({});
check('a missing graph is a 400, not a crash', noGraph.status === 400, noGraph.body.error);

// A BLANK FRAME PLUS "ok" IS THE FAILURE THIS WHOLE FEATURE EXISTS TO PREVENT.
// Two ways to get one, and they must be told apart from each other and from an
// effect that genuinely emits nothing.

// 1. Nothing in the document. This COMPILES CLEANLY - there is nothing to
// complain about - so it has to be caught before anything is drawn.
const empty = await post({ graph: { format: 1, kind: 'vfx-graph', systems: [] } });
check('an effect with no systems says so instead of drawing nothing',
  empty.body.frames.length === 0 && /no systems/i.test(empty.body.error || ''),
  empty.body.error);

// 2. A system that cannot compile. Same rule, different reason.
const broken = await post({
  graph: {
    format: 1,
    kind: 'vfx-graph',
    systems: [{ name: 'Broken', contexts: [{ kind: 'output', blocks: [], params: {} }] }],
  },
});
check('an effect that cannot compile says so too',
  broken.body.frames.length === 0 && typeof broken.body.error === 'string',
  broken.body.error);
check('  and names what is wrong',
  broken.body.diagnostics.some((d) => d.severity === 'error'),
  broken.body.diagnostics.map((d) => d.code).join(' '));

// Oversized requests are clamped rather than accepted: this is a preview.
const huge = await post({ graph: p.doc, width: 9000, height: 9000, times: [0.3] });
check('an absurd size is clamped', huge.body.stats.width <= 1280 && huge.body.stats.height <= 1280,
  `${huge.body.stats.width}x${huge.body.stats.height}`);

server.close();
console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
