// Seed resources/vfx/presets/ from the in-code effect builders.
//
//     node tools/seed-vfx-presets.mjs [--force] [--only <id>]
//
// A ONE-SHOT TOOL, AND DELIBERATELY NOT PART OF ANY BUILD. Once a preset is on
// disk the JSON is the source of truth: it is what the app serves, what the
// author edits through the dialog, and what a later release ships. Re-running
// this would throw those edits away, so it REFUSES to overwrite an existing
// file unless asked twice, in writing, with --force.
//
// That is the opposite of tools/gen-vfx-mapping.mjs, which regenerates a
// document that must never diverge from the catalog and therefore runs in the
// dist chain. The difference is which copy is authoritative: there, the code;
// here, the file.
//
// Every preset is COMPILED before it is written. A starter effect that trips a
// diagnostic is a bug in the preset, not a lesson - somebody opens it, sees a
// warning they did not cause, and concludes the tool is broken.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compileVfxGraph } from '../vfx/compile.js';
import { PRESET_FORMAT, normalizePreset, validatePreset } from '../vfx/preset.js';
import { VFX_TEMPLATES } from '../src/utils/vfx/templates.js';
import * as edits from '../src/utils/vfx/edits.js';
import { PRESET_SEED, PRESET_PACK } from './vfx-preset-seed.mjs';

/** Titlecase a pack filename: flame-wisp.png -> Flame Wisp. */
const packName = (file) => file
  .replace(/\.[^.]+$/, '')
  .split(/[-_]/)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(' ');

/**
 * Wire a preset's systems to the bundled sprites and chips PRESET_PACK names.
 *
 * GOES THROUGH THE EDITOR'S OWN MUTATORS, then blanks the ref. `setSystemTexture`
 * is what the asset picker calls, so a seeded preset ends up shaped exactly
 * like one an author wired by hand - the slot naming, the block placement and
 * the reference entry all come from the same code path rather than from a
 * second, parallel guess about the format.
 *
 * The ref is then EMPTIED, which is the format's rule: a stored preset names a
 * FILE and never an asset id, because an id from this machine means nothing on
 * anyone else's. Opening the preset fills it in.
 *
 * @returns {{doc: Object, assets: Object[]}}
 */
function attachPackAssets(doc, spec) {
  let next = doc;
  const assets = [];

  for (const entry of spec || []) {
    const system = next.systems.find((candidate) => candidate.name === entry.system);
    if (!system) throw new Error(`no system named "${entry.system}" to give ${entry.file} to`);
    const name = packName(entry.file);

    if (entry.mesh) {
      // A mesh output needs the renderer switched too, or the chip is set and
      // ignored and the effect still draws billboards.
      const output = system.contexts.find((context) => context.kind === 'output');
      next = edits.setContextParam(next, output.id, 'mode', 'mesh');
      next = edits.addBlock(next, { contextId: output.id, blockType: 'output.setMesh' });
      const block = next.systems.find((candidate) => candidate.id === system.id).contexts
        .find((context) => context.id === output.id).blocks
        .filter((candidate) => candidate.type === 'output.setMesh').pop();
      const slot = `mesh_${block.id}_mesh`;
      next = edits.setAssetReference(next, slot, { kind: 'mesh', ref: '', name, colorSpace: 'srgb' });
      next = edits.setBlockAssetSlot(next, block.id, 'mesh', slot);
      assets.push({ slot, file: entry.file, kind: 'mesh', name });
      continue;
    }

    // A placeholder id, immediately blanked below: setSystemTexture refuses a
    // non-numeric one, and reusing it is cheaper than duplicating its logic.
    next = edits.setSystemTexture(next, system.id, { assetId: 1, kind: 'image', name });
    const slot = Object.keys(next.references)
      .find((key) => next.references[key].ref === 'asset:1');
    if (!slot) throw new Error(`setSystemTexture did not register a slot for ${entry.file}`);
    next = edits.setAssetReference(next, slot, { ...next.references[slot], ref: '' });
    assets.push({ slot, file: entry.file, kind: 'image', name });
  }

  return { doc: next, assets };
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'resources', 'vfx', 'presets');

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;

let written = 0;
let skipped = 0;
let failed = 0;

await mkdir(OUT_DIR, { recursive: true });

// The twelve original templates keep their graphs verbatim; the seed table adds
// the description, tags and category the card needs. Everything after them is
// authored in the seed table itself.
const entries = [
  ...VFX_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    teaches: template.teaches,
    description: template.blurb,
    build: template.build,
    ...(PRESET_SEED[template.id] || {}),
  })),
  ...Object.entries(PRESET_SEED)
    .filter(([id]) => !VFX_TEMPLATES.some((template) => template.id === id))
    .map(([id, seed]) => ({ id, ...seed })),
];

for (const entry of entries) {
  if (only && entry.id !== only) continue;
  const file = path.join(OUT_DIR, `${entry.id}.json`);

  if (existsSync(file) && !force) {
    // Not an error: this is the normal state once the library exists. Saying so
    // per preset is what makes a re-run obviously harmless.
    console.log(`  skip   ${entry.id} (already on disk; --force to overwrite)`);
    skipped += 1;
    continue;
  }

  try {
    if (typeof entry.build !== 'function') throw new Error('no build() for this preset');
    const built = entry.build();
    const { doc, assets } = attachPackAssets(built, PRESET_PACK[entry.id] || []);
    const preset = normalizePreset({
      format: PRESET_FORMAT,
      id: entry.id,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      teaches: entry.teaches,
      tags: entry.tags,
      assets,
      doc,
    }, entry.id);

    const problems = validatePreset(preset);
    if (problems.length) throw new Error(problems.join(' '));

    const { diagnostics } = compileVfxGraph(preset.doc, { assetIndex: new Set() });
    const bad = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warn');
    if (bad.length) {
      throw new Error(`${bad.length} diagnostic(s): ${bad.map((d) => d.code).join(', ')}`);
    }

    const { updatedAt, hasThumbnail, ...onDisk } = preset;
    await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
    const pack = preset.assets.map((need) => need.file).join(' ');
    console.log(`  write  ${entry.id.padEnd(16)} [${preset.category}]  ${pack || '(built-in sprite)'}`);
    written += 1;
  } catch (err) {
    console.error(`  FAIL   ${entry.id}: ${err.message}`);
    failed += 1;
  }
}

console.log(`\n${written} written, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);

// Keep the reader honest about what is NOT checked here: nothing renders these,
// so a preset can compile cleanly and still look like nothing at all. That is a
// human step, and the thumbnails are where it gets caught.
await readFile(path.join(ROOT, 'package.json'), 'utf8');
