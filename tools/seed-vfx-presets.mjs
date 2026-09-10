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
import { PRESET_SEED } from './vfx-preset-seed.mjs';

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
    const doc = entry.build();
    const preset = normalizePreset({
      format: PRESET_FORMAT,
      id: entry.id,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      teaches: entry.teaches,
      tags: entry.tags,
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
    console.log(`  write  ${entry.id}  [${preset.category}]  ${preset.tags.join(' ')}`);
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
