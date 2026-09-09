// The five VFX MCP tools, against a real server.
//
//   compile (no asset) -> save (create) -> list -> read -> save (in place)
//   -> export the bundle -> and errors that are errors rather than empty results.
//
// WHY THIS IS A SEPARATE TOOL and not part of the `node vfx/*.test.mjs` sweep:
// those run headless with no server and no database. Everything here goes over
// HTTP through the real MCP transport, because the interesting failures are at
// the seams - a tool registered but not reachable, a schema the SDK rejects, a
// digest written in a shape the Assets page cannot read.
//
// HOW TO RUN. Needs a server with its own data directory; it creates assets.
//
//     mkdir /tmp/vfxmcp && cd /tmp/vfxmcp
//     PORT=3402 node /path/to/3DGenStudio/server.js &
//     node /path/to/3DGenStudio/tools/vfx-mcp-e2e.mjs
//
const BASE = process.env.MCP_BASE || 'http://127.0.0.1:3402';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(50)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
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

// Relative to this file, so the tool runs from a clone in any directory.
const { VFX_TEMPLATES } = await import(new URL('../src/utils/vfx/templates.js', import.meta.url));
const { normalizeVfxDoc } = await import(new URL('../vfx/doc.js', import.meta.url));

// --- compile, with no asset involved ---------------------------------------
const graph = normalizeVfxDoc(VFX_TEMPLATES.find((t) => t.id === 'sparks').build());
let out = await call('compile_vfx_graph', { graph });
check('compile_vfx_graph accepts a bare document', out.ok === true, JSON.stringify(out.summary?.stats));
check('  and reports no errors for a template',
  !(out.summary.diagnostics || []).some((d) => d.severity === 'error'),
  (out.summary.diagnostics || []).map((d) => d.code).join(' ') || 'clean');
check('  with real statistics', out.summary.stats?.peakParticles > 0,
  `${out.summary.stats?.peakParticles} particles, ${out.summary.stats?.drawCalls} draws`);

out = await call('compile_vfx_graph', { graph, engineTarget: 'unreal' });
check('  and an engine target changes nothing structural', out.ok === true);

// A deliberately broken one: no Initialize stage at all.
const broken = normalizeVfxDoc({
  ...graph,
  systems: [{ ...graph.systems[0], contexts: graph.systems[0].contexts.filter((c) => c.kind !== 'initialize') }],
});
out = await call('compile_vfx_graph', { graph: broken });
check('a broken graph compiles to ok:false', out.ok === false,
  (out.summary.diagnostics || []).map((d) => d.code).join(' '));

// --- save (create) ----------------------------------------------------------
out = await call('save_vfx_graph', { graph, name: 'MCP Sparks' });
check('save_vfx_graph creates an effect', Number.isFinite(out.assetId) && out.created === true,
  `id ${out.assetId}`);
const assetId = out.assetId;

// --- list -------------------------------------------------------------------
out = await call('list_vfx_assets', {});
check('list_vfx_assets finds it', (out.effects || []).some((e) => e.assetId === assetId),
  `${out.count} effects`);
out = await call('list_vfx_assets', { search: 'mcp spar' });
// Every hit matches AND ours is among them - not "exactly one". This tool is
// meant to be rerunnable against a database that already has effects in it,
// and a count assertion would pass once and then fail for ever.
check('  and search narrows by name',
  out.count > 0
  && out.effects.every((e) => e.name.toLowerCase().includes('mcp spar'))
  && out.effects.some((e) => e.assetId === assetId),
  `${out.count} matched`);
out = await call('list_vfx_assets', { search: 'nothing-like-this' });
check('  and a miss returns none', out.count === 0, `${out.count}`);

// --- read -------------------------------------------------------------------
out = await call('get_vfx_graph', { assetId });
check('get_vfx_graph reads it back', Array.isArray(out.graph?.systems), `${out.graph?.systems?.length} systems`);
check('  with a summary of every stage',
  out.summary.systems[0].contexts.length === graph.systems[0].contexts.length,
  `${out.summary.systems[0].contexts.length} contexts`);
check('  and the same signature it was saved with',
  out.summary.signature === (await call('compile_vfx_graph', { graph })).summary.signature);
const withoutGraph = await call('get_vfx_graph', { assetId, includeGraph: false });
check('  includeGraph:false omits the document', withoutGraph.graph === undefined
  && Boolean(withoutGraph.summary));

// --- save (in place) --------------------------------------------------------
const patched = { ...out.graph, effect: { ...out.graph.effect, duration: 3.5 } };
out = await call('save_vfx_graph', { graph: patched, assetId });
check('save_vfx_graph overwrites in place', out.created === false && out.assetId === assetId,
  `id ${out.assetId}`);
out = await call('get_vfx_graph', { assetId, includeGraph: false });
check('  and the change stuck', out.summary.duration === 3.5, String(out.summary.duration));

// --- export -----------------------------------------------------------------
out = await call('export_vfx_bundle', { assetId });
check('export_vfx_bundle answers', out.bundleFormat === 1 && out.irFormat === 1,
  `bundle ${out.bundleFormat} / ir ${out.irFormat}`);
check('  listing the files to fetch', (out.files || []).length >= 1,
  (out.files || []).map((f) => f.dest).join(' '));
check('  with no manifest unless asked', out.manifest === undefined);
const full = await call('export_vfx_bundle', { assetId, includeManifest: true, engineTarget: 'unity' });
check('  and includeManifest returns the whole thing',
  Array.isArray(full.manifest?.ir?.systems) && full.manifest.engineMapping?.blocks?.length > 20,
  `${full.manifest?.engineMapping?.blocks?.length} mapped blocks`);
check('  targeted at the engine asked for', full.engineTarget === 'unity', String(full.engineTarget));

// --- errors are errors, not silent successes --------------------------------
let threw = false;
try { await call('get_vfx_graph', { assetId: 99887766 }); } catch { threw = true; }
check('reading a missing effect throws', threw);
threw = false;
try { await call('compile_vfx_graph', {}); } catch { threw = true; }
check('compiling with neither graph nor assetId throws', threw);

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
