import { z } from 'zod';
import { toolHandler } from '../client.js';
import { normalizeVfxDoc, vfxSignature, vfxAssetDigest } from '../../vfx/doc.js';
import { compileVfxGraph } from '../../vfx/compile.js';

// Particle effects: the /vfx editor's documents, reachable from an agent.
//
// THE CONTRACT WORTH UNDERSTANDING BEFORE USING THESE, because it decides which
// tool to reach for:
//
//   THE GRAPH IS THE ASSET. A `Vfx` asset is a ~40KB JSON document stored as a
//   FILE, not as rows. It describes systems, each holding contexts (Event ->
//   Spawn -> Initialize -> Update -> Output), each holding an ordered stack of
//   blocks. Reading it, changing it and writing it back is the whole loop.
//
//   IT REFERENCES OTHER ASSETS BY SLOT, NEVER BY ID. A block points at
//   'tex_spark'; `references` maps that key to `asset:<id>`. One table to walk,
//   one place to remap on import, and a lost texture degrades to a reportable
//   dangling KEY rather than a dangling id. Never write an asset id into a
//   block property - write a slot key and add the slot to `references`.
//
//   COMPILE BEFORE YOU SAVE. compile_vfx_graph is pure and fast and tells you
//   what an author would see in the diagnostics strip: capacity overflow with
//   the arithmetic spelled out, a missing Output, a spawn rate that cannot be
//   met, a block in a stage that cannot run it. Saving a graph that does not
//   compile is allowed - a half-authored effect is normal - but shipping one
//   without looking is how an agent leaves an effect that draws nothing.
//
//   EFFECTS ARE LIBRARY-GLOBAL, like tree presets and brushes. They are not
//   project-scoped, because an effect routinely references textures from
//   several projects. So there is no projectId anywhere here, and
//   GET /api/assets?projectId= deliberately does not list them.

const GRAPH_SHAPE = z.record(z.string(), z.any());

/** Summarise a graph the way the editor's diagnostics strip does. */
function summarise(doc, compiled) {
  const systems = doc.systems.map((system) => ({
    name: system.name,
    capacity: system.capacity,
    contexts: system.contexts.map((context) => ({
      kind: context.kind,
      blocks: context.blocks.map((block) => block.type),
    })),
    clips: (system.schedule?.clips || []).map((clip) => ({
      at: clip.at, duration: clip.duration, loop: Boolean(clip.loop),
    })),
  }));
  return {
    name: doc.name || '',
    duration: doc.effect.duration,
    loop: Boolean(doc.effect.loop),
    seed: doc.effect.seed,
    signature: vfxSignature(doc),
    systems,
    operators: doc.operators.map((node) => ({ id: node.id, type: node.type })),
    references: Object.entries(doc.references || {}).map(([slot, entry]) => ({
      slot, kind: entry.kind, ref: entry.ref, name: entry.name || '',
    })),
    stats: compiled ? compiled.stats : null,
    diagnostics: compiled
      ? compiled.diagnostics.map((d) => ({
        code: d.code, severity: d.severity, message: d.message, hint: d.hint || '',
      }))
      : null,
  };
}

/**
 * Fetch a VFX asset's record and its graph file.
 *
 * TWO REQUESTS, and the reason is worth stating: the library listing does NOT
 * project the metadata column, and /assets/record returns the RAW row - so
 * `metadata` there is a JSON string, not an object. The graph itself is never
 * in either; it is a file, fetched by path.
 */
async function loadGraph(api, assetId) {
  const record = await api.apiJson('GET', '/assets/record', { query: { assetId } });
  if (!record?.filePath) throw new Error(`Asset ${assetId} has no file. Is it a VFX effect?`);
  // assetUrl, not a hand-built path: a record carries `filePath`
  // ("data/assets/vfx/x.json") while a listing row carries `filename`
  // ("vfx/x.json"), and that helper is the one place that accepts either.
  const response = await fetch(api.assetUrl(record.filePath));
  if (!response.ok) throw new Error(`Could not read the effect file (HTTP ${response.status})`);
  const raw = await response.json();
  return { record, doc: normalizeVfxDoc(raw) };
}

export function registerVfxTools(server, { api, notifyMutation }) {
  server.registerTool('list_vfx_assets', {
    title: 'List VFX effects',
    description: 'List every particle effect in the global library, with its systems, duration and the asset slots it references. Effects are library-global rather than project-scoped, so there is no projectId: one effect routinely uses textures from several projects. Use get_vfx_graph for the full document of one of them.',
    inputSchema: {
      search: z.string().optional().describe('Case-insensitive substring of the effect name.'),
    },
  }, toolHandler(async ({ search }) => {
    const library = await api.apiJson('GET', '/assets/library');
    const needle = String(search || '').trim().toLowerCase();
    const rows = (library.vfx || []).filter(
      (row) => !needle || String(row.name || '').toLowerCase().includes(needle),
    );
    return {
      count: rows.length,
      effects: rows.map((row) => ({
        assetId: row.assetId ?? Number(String(row.id).replace('library:', '')),
        name: row.name,
        filePath: row.filePath,
        thumbnailUrl: row.thumbnailUrl || null,
      })),
    };
  }));

  server.registerTool('get_vfx_graph', {
    title: 'Read a VFX effect',
    description: 'Read one effect\'s complete graph document, plus a summary of its systems, its asset slots and the diagnostics it currently produces. This is the document to patch and pass back to save_vfx_graph. Blocks reference textures and meshes by SLOT KEY (e.g. "tex_spark"), resolved through the `references` table - never by asset id.',
    inputSchema: {
      assetId: z.number().int().positive().describe('The Vfx asset id, from list_vfx_assets.'),
      includeGraph: z.boolean().default(true).describe('Set false for just the summary and diagnostics, when the full ~40KB document is not needed.'),
    },
  }, toolHandler(async ({ assetId, includeGraph }) => {
    const { record, doc } = await loadGraph(api, assetId);
    const compiled = compileVfxGraph(doc);
    return {
      assetId,
      name: record.name || doc.name || '',
      filePath: record.filePath,
      summary: summarise(doc, compiled),
      graph: includeGraph ? doc : undefined,
    };
  }));

  server.registerTool('compile_vfx_graph', {
    title: 'Compile a VFX graph',
    description: 'Compile a graph document WITHOUT saving it, and return the diagnostics, the statistics (peak particles, draw calls, per-engine support) and optionally the IR. Pure and fast. Use it before save_vfx_graph: it reports exactly what the editor\'s diagnostics strip would show an author - capacity overflow with the arithmetic, a missing Output, a block in a stage that cannot run it, a value that varies faster than its stage allows.',
    inputSchema: {
      graph: GRAPH_SHAPE.optional().describe('A graph document. Omit it and pass assetId to compile a saved effect instead.'),
      assetId: z.number().int().positive().optional().describe('Compile the saved effect with this id.'),
      engineTarget: z.enum(['unity', 'unreal']).optional().describe('Also report which blocks will not survive export to this engine.'),
      includeIr: z.boolean().default(false).describe('Return the compiled IR. Large - only useful when inspecting what an importer plugin would receive.'),
    },
  }, toolHandler(async ({ graph, assetId, engineTarget, includeIr }) => {
    if (!graph && !assetId) throw new Error('Pass either `graph` or `assetId`.');
    const doc = graph ? normalizeVfxDoc(graph) : (await loadGraph(api, assetId)).doc;
    const compiled = compileVfxGraph(doc, { engineTarget: engineTarget || null });
    return {
      ok: !compiled.diagnostics.some((d) => d.severity === 'error'),
      summary: summarise(doc, compiled),
      ir: includeIr ? compiled.ir : undefined,
    };
  }));

  server.registerTool('save_vfx_graph', {
    title: 'Save a VFX effect',
    description: 'Create a new effect or overwrite an existing one. Pass assetId to save in place (the id and any deep links survive); omit it to create a new library effect. The document is normalised and its reference digest is written to the asset metadata, so project export carries its textures. NOTE: this does not render a thumbnail - only the editor can, since that needs a GPU - so a new effect shows a placeholder card until someone opens and saves it there. Compile first with compile_vfx_graph unless you mean to save something unfinished.',
    inputSchema: {
      graph: GRAPH_SHAPE.describe('The complete graph document. Read one with get_vfx_graph, patch it, pass it back.'),
      name: z.string().min(1).max(200).optional().describe('Effect name. Defaults to the graph\'s own name.'),
      assetId: z.number().int().positive().optional().describe('Overwrite this effect. Omit to create a new one.'),
    },
  }, toolHandler(async ({ graph, name, assetId }) => {
    const doc = normalizeVfxDoc({ ...graph, ...(name ? { name } : {}) });
    const safeName = String(name || doc.name || 'Effect').trim() || 'Effect';
    // THE SAME DIGEST THE EDITOR WRITES, from the same function. An
    // agent-saved effect and a human-saved one must be indistinguishable to the
    // Assets page and to project export, or an effect's textures would travel
    // inside a .3dgp only when a human happened to save it last.
    const metadata = vfxAssetDigest(doc, { source: 'MCP' });

    const body = JSON.stringify(doc, null, 2);
    const file = new File([body], `${safeName.replace(/[^\w.-]+/g, '_')}.vfx.json`, {
      type: 'application/json',
    });

    const form = new FormData();
    form.append('file', file);
    let saved;
    if (assetId) {
      // The replace dialect: ONE `payload` JSON part. library-upload takes loose
      // fields instead, and getting the two the wrong way round produces a 400
      // that says nothing useful - see the header of src/utils/vfxApi.js.
      form.append('payload', JSON.stringify({ name: safeName, type: 'vfx', metadata }));
      saved = await api.apiForm('POST', `/assets/${assetId}/replace`, form);
    } else {
      form.append('type', 'vfx');
      form.append('name', safeName);
      form.append('metadata', JSON.stringify(metadata));
      saved = await api.apiForm('POST', '/assets/library-upload', form);
    }
    notifyMutation?.('assets');

    const compiled = compileVfxGraph(doc);
    return {
      assetId: Number(String(saved?.id ?? assetId).replace('library:', '')),
      name: safeName,
      filePath: saved?.filePath || null,
      created: !assetId,
      diagnostics: compiled.diagnostics.map((d) => ({
        code: d.code, severity: d.severity, message: d.message,
      })),
    };
  }));

  server.registerTool('export_vfx_bundle', {
    title: 'Export a VFX bundle',
    description: 'Build the engine export bundle for one effect: the manifest (graph, compiled IR, engine mapping table, resolved references, warnings) plus the list of files an importer needs. A PLAN, not an archive - each file is listed by storagePath, and the caller fetches the bytes over HTTP, which is what makes this work against a shared server. Unity and Unreal importer plugins read the IR, not the graph. A missing texture is a warning and the export still succeeds, because a half-authored effect is the normal case.',
    inputSchema: {
      assetId: z.number().int().positive().describe('The Vfx asset id.'),
      engineTarget: z.enum(['unity', 'unreal']).optional().describe('Also list exactly what this engine cannot take intact, instead of the whole compatibility table.'),
      includeManifest: z.boolean().default(false).describe('Return the full manifest. It embeds the graph AND the IR AND the mapping table, so it is large - the default returns the file list, the warnings and the summary only.'),
    },
  }, toolHandler(async ({ assetId, engineTarget, includeManifest }) => {
    const bundle = await api.apiJson('GET', `/assets/${assetId}/vfx-export-plan`, {
      query: engineTarget ? { engineTarget } : {},
    });
    const manifest = bundle?.manifest || {};
    return {
      assetId,
      bundleFormat: manifest.bundleFormat,
      irFormat: manifest.ir?.irFormat,
      effect: manifest.asset,
      files: bundle.files || [],
      references: manifest.references || [],
      warnings: manifest.warnings || [],
      engineTarget: manifest.engineTarget || null,
      engineGaps: manifest.engineGaps || null,
      stats: manifest.stats || null,
      manifest: includeManifest ? manifest : undefined,
    };
  }));
}
