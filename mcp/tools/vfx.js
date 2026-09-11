import { z } from 'zod';
import { jsonResult, toolHandler } from '../client.js';
import { normalizeVfxDoc, vfxSignature, vfxAssetDigest } from '../../vfx/doc.js';
import { compileVfxGraph } from '../../vfx/compile.js';
import { CATALOG } from '../../vfx/catalog.js';
import { VFX_IR_FORMAT } from '../../vfx/ir.js';
import {
  indexInstalledPackAssets,
  packAssetDisplayName,
  presetAssetName,
} from '../../vfx/preset.js';
import { Buffer } from 'node:buffer';

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
  server.registerTool('describe_vfx_catalog', {
    title: 'Describe the VFX catalog',
    description: 'Every block, operator, context and property this build offers, with types, defaults, ranges, the value modes each property accepts and the per-engine export support. READ THIS BEFORE WRITING A GRAPH. Without it the only way to learn a block type is to read an effect that already uses one, so you can never reach a block no existing effect happens to use - and a block type, property name, mode value or Output setting that is not in this list is reported by compile_vfx_graph and then IGNORED at run time, which produces an effect that looks nearly right. A param carrying `optionsFrom` draws its values from the document instead of this list - `optionsFrom: "systems"` means the value is a system id from the graph you are writing.',
    inputSchema: {
      context: z.enum(['event', 'spawn', 'initialize', 'update', 'output']).optional()
        .describe('Only blocks that run in this stage.'),
      search: z.string().optional().describe('Case-insensitive substring of the id, label or blurb.'),
      include: z.enum(['blocks', 'operators', 'contexts', 'all']).default('all')
        .describe('Narrow the reply. The full catalog is large.'),
      detail: z.enum(['summary', 'full']).default('full')
        .describe('"summary" is id, label and blurb only - enough to choose a block, then ask again for that one.'),
    },
  }, toolHandler(({ context, search, include, detail }) => {
    const needle = String(search || '').trim().toLowerCase();
    const matches = (def) => !needle || [def.id, def.label, def.blurb]
      .some((text) => String(text || '').toLowerCase().includes(needle));

    const propOf = ([name, def]) => ({
      name,
      type: def.type,
      default: def.default,
      ...(def.unit ? { unit: def.unit } : {}),
      ...(Number.isFinite(def.min) ? { min: def.min } : {}),
      ...(Number.isFinite(def.max) ? { max: def.max } : {}),
      // Which VfxValue modes this property accepts. Writing `{mode:'curve'}`
      // into a property that only offers const and random is the other easy way
      // to produce a document that does not do what it says.
      modes: [...(def.modes || [])],
      ...(def.hint ? { hint: def.hint } : {}),
    });

    const blockOf = (def) => (detail === 'summary'
      ? { id: def.id, label: def.label, contexts: [...def.contexts], blurb: def.blurb }
      : {
        id: def.id,
        label: def.label,
        contexts: [...def.contexts],
        category: def.category,
        blurb: def.blurb,
        teach: def.teach,
        props: Object.entries(def.props).map(propOf),
        // The block's enum choices, which live in `modes` on the BLOCK and are
        // a different thing from a property's value modes above.
        choices: Object.entries(def.modes || {}).map(([name, m]) => ({
          name, options: [...m.options], default: m.default, hint: m.hint || '',
        })),
        attributes: [...(def.attributes || [])],
        engines: { ...def.engines },
      });

    const blocks = CATALOG.blocks
      .filter((def) => (!context || def.contexts.includes(context)) && matches(def))
      .map(blockOf);
    const operators = CATALOG.operators.filter(matches).map((def) => (detail === 'summary'
      ? { id: def.id, label: def.label, blurb: def.blurb }
      : {
        id: def.id,
        label: def.label,
        blurb: def.blurb,
        props: Object.entries(def.props || {}).map(propOf),
        outputs: def.outputs,
        freq: def.freq,
        engines: { ...def.engines },
      }));

    const contexts = Object.entries(CATALOG.contexts).map(([kind, def]) => ({
      kind,
      label: def.label,
      blurb: def.blurb,
      // HOW TO ACTUALLY BUILD A SUB-EMITTER, on the context that needs it.
      //
      // The document has a top-level `events: []` array AND an `event` context
      // kind, and only the second one does anything - the array is carried into
      // the IR and read by nothing. An agent that found both had no way to tell
      // which to populate and skipped sub-emitters entirely, so its debris had
      // no trails. `optionsFrom` below explains where `source` gets its values;
      // this explains the shape.
      ...(kind === 'event' ? {
        howTo: 'Give the CHILD system an `event` context as its first context, before `spawn`. '
          + 'Set params {trigger, source, probability}: `trigger` is onDeath or onCollide, '
          + '`source` is the id of the PARENT system in this same document, and `probability` '
          + 'is 0..1. The child then spawns wherever the parent particle was. Leave the '
          + 'top-level `events: []` array alone - it is vestigial and nothing reads it. '
          + 'The "firework" preset is a worked example: read it with get_vfx_graph.',
      } : {}),
      // The Output stage's settings are the ones most often got wrong, because
      // they are context PARAMS rather than blocks and are easy to miss.
      params: Object.entries(def.params || {}).map(([name, p]) => ({
        name,
        options: [...(p.options || [])],
        default: p.default,
        label: p.label,
        ...(p.hint ? { hint: p.hint } : {}),
        // A param whose options come from the DOCUMENT rather than the catalog.
        // The Event stage's `source` is the only one today, and it reports an
        // empty option list - which reads as "no valid values" unless the
        // caller is told where the values actually come from. That is precisely
        // the sub-emitter wiring, so leaving it unexplained puts the whole
        // feature out of an agent's reach.
        ...(p.optionsFrom ? { optionsFrom: p.optionsFrom } : {}),
      })),
    }));

    return {
      irFormat: VFX_IR_FORMAT,
      ...(include === 'all' || include === 'blocks' ? { blocks } : {}),
      ...(include === 'all' || include === 'operators' ? { operators } : {}),
      ...(include === 'all' || include === 'contexts' ? { contexts } : {}),
      counts: { blocks: CATALOG.blocks.length, operators: CATALOG.operators.length },
    };
  }));

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

  // -------------------------------------------------------------------------
  // Sprites
  //
  // THE PACK WAS UNREACHABLE FROM HERE, and that is a sharper problem than the
  // library simply being thin. Nine sprites ship with the app - a soft glow, a
  // ring, a streak, a smoke puff, a flame wisp and more - but they install
  // LAZILY, when someone OPENS a preset that names one. An agent authoring from
  // scratch never triggers that, so it sees whatever the user happened to open
  // and concludes there is one texture in the world. Every output then falls
  // back to the built-in blob: fine for fire, wrong for a shockwave ring.
  //
  // These two tools are the install-on-open path, made explicit.
  // -------------------------------------------------------------------------

  server.registerTool('list_vfx_sprites', {
    title: 'List the bundled VFX sprite pack',
    description: 'The sprites and debris meshes that ship with the app, ready to use as particle textures. '
      + 'These are NOT in the asset library until something installs them - call install_vfx_sprite to get an '
      + 'asset id you can reference. Says which are already installed.',
    annotations: { readOnlyHint: true },
  }, toolHandler(async () => {
    const [pack, library] = await Promise.all([
      api.apiJson('GET', '/vfx/preset-assets'),
      api.apiJson('GET', '/assets/library'),
    ]);
    const installed = indexInstalledPackAssets([
      ...(library?.images || []),
      ...(library?.meshes || []),
    ]);
    return {
      assets: (pack?.assets || []).map((entry) => {
        const id = installed.get(presetAssetName({ name: packAssetDisplayName(entry.file) })) ?? null;
        return {
          file: entry.file,
          kind: entry.kind,
          bytes: entry.bytes,
          installed: id !== null,
          ...(id !== null ? { assetId: id, ref: `asset:${id}` } : {}),
        };
      }),
      howTo: 'install_vfx_sprite turns one of these into a library asset, then set_vfx_texture points a '
        + 'graph slot at it. Installing twice is safe - the second call finds the first copy.',
    };
  }));

  server.registerTool('install_vfx_sprite', {
    title: 'Install a bundled sprite into the library',
    description: 'Copy one bundled sprite or debris mesh into the asset library and return its asset id. '
      + 'Idempotent: if it is already there the existing id comes back and nothing is uploaded. '
      + 'This is the same thing that happens when a human opens a preset that uses the file.',
    inputSchema: {
      file: z.string().min(1).describe('A `file` value from list_vfx_sprites, e.g. "ring.png".'),
    },
  }, toolHandler(async ({ file }) => {
    const pack = await api.apiJson('GET', '/vfx/preset-assets');
    const entry = (pack?.assets || []).find((a) => a.file === file);
    if (!entry) {
      return {
        error: `The pack has no file "${file}".`,
        available: (pack?.assets || []).map((a) => a.file),
      };
    }

    // DEDUP BY NAME, because the library listing does not project metadata -
    // there is nowhere to put a content hash a listing could match on. The
    // `VFX ` prefix is what stops an asset the user happens to own with the
    // same name being silently adopted. Same rule as the editor's own install.
    // Derived exactly as a preset declares it - see packAssetDisplayName.
    const name = presetAssetName({ name: packAssetDisplayName(file) });
    const library = await api.apiJson('GET', '/assets/library');
    const existing = indexInstalledPackAssets([
      ...(library?.images || []),
      ...(library?.meshes || []),
    ]).get(name);
    if (existing != null) {
      return { assetId: existing, ref: `asset:${existing}`, name, kind: entry.kind, installed: false };
    }

    // Straight off the static mount, the way the browser reads it - no route.
    const res = await fetch(`${api.base}/resources/vfx/assets/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error(`Could not read the bundled file "${file}" (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: entry.kind === 'mesh' ? 'model/gltf-binary' : 'image/png' }), file);
    form.append('type', entry.kind);
    form.append('name', name);
    const saved = await api.apiForm('POST', '/assets/library-upload', form);
    const assetId = Number(String(saved?.id ?? '').replace('library:', ''));
    notifyMutation?.('assets');
    return { assetId, ref: `asset:${assetId}`, name, kind: entry.kind, installed: true };
  }));

  server.registerTool('set_vfx_texture', {
    title: 'Point a VFX texture slot at an asset',
    description: 'Wire an image or mesh asset into a graph, and return the patched graph to pass on to '
      + 'save_vfx_graph. THIS IS TWO COUPLED EDITS and doing one of them is the common mistake: the block '
      + 'property holds a SLOT KEY (a short name you choose, never an asset id), and the document\'s '
      + '`references` table maps that key to `asset:<id>`. A block pointing at a slot the table lacks draws '
      + 'the built-in blob and says so only as a warning.',
    inputSchema: {
      graph: GRAPH_SHAPE.describe('The document to patch. Read one with get_vfx_graph.'),
      slot: z.string().min(1).max(64).describe('The slot key, e.g. "tex_smoke". Blocks refer to this name.'),
      assetId: z.number().int().positive().describe('The library asset to point it at (install_vfx_sprite returns one).'),
      kind: z.enum(['image', 'mesh']).default('image'),
      colorSpace: z.enum(['srgb', 'linear']).default('srgb')
        .describe('srgb for anything that is a colour; linear for a mask, a noise field or a LUT.'),
      blockId: z.string().optional()
        .describe('Also point this block\'s texture/mesh property at the slot. Omit if the blocks already name it.'),
      prop: z.string().optional().describe('Which property on that block (default: the block\'s only asset property).'),
    },
  }, toolHandler(async ({ graph, slot, assetId, kind, colorSpace, blockId, prop }) => {
    // A MISSING ASSET IS AN ANSWER, NOT A CRASH. The record route replies with a
    // plain-text 404, so letting it throw hands the caller a parse error where
    // "there is no asset 999" would have told them what to do.
    let record = null;
    try {
      record = await api.apiJson('GET', '/assets/record', { query: { assetId } });
    } catch {
      record = null;
    }
    if (!record || !record.id) {
      return {
        error: `No asset ${assetId} in this library.`,
        hint: 'list_library_assets finds ids; install_vfx_sprite returns one for a bundled sprite.',
      };
    }

    const doc = normalizeVfxDoc(graph);
    const references = { ...(doc.references || {}) };
    references[slot] = {
      kind,
      ref: `asset:${Number(assetId)}`,
      name: record.name || '',
      colorSpace,
    };

    let pointed = null;
    if (blockId) {
      for (const system of doc.systems) {
        for (const context of system.contexts) {
          for (const block of context.blocks) {
            if (block.id !== blockId) continue;
            const def = CATALOG.block(block.type);
            const assetProps = Object.entries(def?.props || {})
              .filter(([, p]) => p.type === 'texture' || p.type === 'mesh')
              .map(([name]) => name);
            const target = prop || assetProps[0];
            if (!target) {
              return {
                error: `Block "${blockId}" (${block.type}) has no texture or mesh property.`,
              };
            }
            block.props = { ...block.props, [target]: { mode: 'const', v: slot } };
            pointed = { blockId, prop: target };
          }
        }
      }
      if (!pointed) return { error: `No block "${blockId}" in this graph.` };
    }

    const patched = normalizeVfxDoc({ ...doc, references });
    const compiled = compileVfxGraph(patched);
    return {
      graph: patched,
      slot,
      ref: references[slot].ref,
      pointedAt: pointed,
      // The point of returning these: a slot wired to nothing still compiles,
      // and the warning is the only thing that says so.
      diagnostics: compiled.diagnostics
        .filter((d) => d.severity !== 'info')
        .map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
      next: 'Pass `graph` to save_vfx_graph.',
    };
  }));

  // -------------------------------------------------------------------------
  // Seeing it
  //
  // THE GAP EVERY OTHER TOOL LEFT OPEN. Authoring worked end to end and every
  // step reported numbers, and no number answers "does this look like an
  // explosion". An effect that can only be measured can only be guessed at.
  // -------------------------------------------------------------------------
  server.registerTool('render_vfx_preview', {
    title: 'Render a VFX effect to images',
    description: 'SEE an effect: simulates it and returns PNG frames, so you can judge what you built instead of '
      + 'inferring it from particle counts. Defaults to four moments across the effect, because a one-shot is empty '
      + 'at t=0 and empty again at the end. '
      + 'Pass filmstrip:true to get TWELVE moments tiled into one image instead - the closest thing to watching it '
      + 'play, and the right choice for judging MOTION (does the debris arc, does the smoke roll) rather than a pose. '
      + 'NOT THE EDITOR VIEWPORT: no textures (every particle draws as a soft blob), no mesh particles, no trails - '
      + 'so an effect whose SPRITE is the point looks plainer here. Tone mapping does match, so HDR colours clip the '
      + 'same way they will on screen. Framing follows the effect\'s boundsMode: "auto" works it out from the live '
      + 'particles, "manual" uses the document\'s boundsMin/boundsMax verbatim.',
    inputSchema: {
      graph: GRAPH_SHAPE.optional().describe('The document to render. Omit and pass assetId to render a saved effect.'),
      assetId: z.number().int().positive().optional().describe('Render a saved effect instead of a document.'),
      filmstrip: z.boolean().optional()
        .describe('Tile the moments into ONE image (a 4-wide grid) instead of returning separate frames. '
          + 'Use it to judge motion: twelve frames in one picture beats four scattered stills.'),
      times: z.array(z.number().min(0)).max(16).optional()
        .describe('Seconds to capture at. Default: four moments across the effect, or twelve with filmstrip.'),
      width: z.number().int().min(64).max(1280).optional().describe('Default 480.'),
      height: z.number().int().min(64).max(1280).optional().describe('Default 270.'),
      azimuth: z.number().optional().describe('Camera angle around the effect, degrees. Default 35.'),
      elevation: z.number().optional().describe('Camera height, degrees. Default 18.'),
      distance: z.number().min(0.5).max(20).optional()
        .describe('Multiple of the effect radius. Default 2.6 - raise it if the effect fills the frame.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({
    graph, assetId, times, width, height, azimuth, elevation, distance, filmstrip,
  } = {}) => {
    try {
      let doc = graph;
      if (!doc) {
        if (!assetId) {
          return jsonResult({ error: 'Pass either `graph` or `assetId`.' });
        }
        const record = await api.apiJson('GET', '/assets/record', { query: { assetId } });
        const file = await fetch(api.assetUrl(record?.filePath));
        if (!file.ok) return jsonResult({ error: `Could not read effect ${assetId}.` });
        doc = await file.json();
      }

      const view = {};
      if (Number.isFinite(azimuth)) view.azimuth = azimuth;
      if (Number.isFinite(elevation)) view.elevation = elevation;
      if (Number.isFinite(distance)) view.distance = distance;

      const result = await api.apiJson('POST', '/vfx/preview', {
        body: { graph: doc, times, width, height, view, filmstrip },
      });

      if (result.error) return jsonResult(result);

      // THE NUMBERS TRAVEL WITH THE PICTURES. "0 drawn, 400 clipped" and
      // "0 drawn, 0 clipped" look identical as a black frame and are different
      // bugs: the first is framing or scale, the second means nothing is being
      // emitted at all.
      const content = [{
        type: 'text',
        text: JSON.stringify({
          stats: result.stats,
          frames: result.frames.map((f) => ({
            time: f.time, alive: f.alive, drawn: f.drawn, clipped: f.clipped,
          })),
          diagnostics: result.diagnostics,
          ...(result.frames.every((f) => f.drawn === 0)
            ? {
              nothingDrawn: 'No particle reached the frame. If `clipped` is high the camera framing or the '
                + 'particle sizes are wrong; if it is zero, nothing is being emitted - check the spawn rate '
                + 'and that a clip covers these times.',
            }
            : {}),
        }, null, 2),
      }];
      if (result.filmstrip) {
        content[0].text = JSON.stringify({
          ...JSON.parse(content[0].text),
          filmstrip: {
            grid: `${result.filmstrip.cols}x${result.filmstrip.rows}`,
            // WHICH CELL IS WHICH MOMENT. Without this the strip is twelve
            // unlabelled pictures and the times below cannot be matched to
            // them - reading left to right, top to bottom.
            order: 'left to right, top to bottom',
            times: result.filmstrip.times,
          },
        }, null, 2);
        content.push({ type: 'image', data: result.filmstrip.png, mimeType: 'image/png' });
      } else {
        for (const frame of result.frames) {
          content.push({ type: 'image', data: frame.png, mimeType: 'image/png' });
        }
      }
      return { content };
    } catch (error) {
      return jsonResult({ error: error?.message || 'Failed to render a preview' });
    }
  });

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
