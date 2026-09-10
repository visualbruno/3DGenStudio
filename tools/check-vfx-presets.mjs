// Every shipped VFX preset loads, validates and compiles cleanly.
//
//     node tools/check-vfx-presets.mjs
//
// THE PRESETS ARE HAND-EDITABLE BY DESIGN - that is the whole point of storing
// them as files the running app can write - so nothing stops a saved edit, a
// merge or a text editor from leaving one that does not compile. A broken
// preset is uniquely nasty because the person who opens it did not write it:
// they see warnings they did not cause on an effect that is supposed to be a
// worked example, and conclude the tool is broken.
//
// So this checks what the seeder checks, but against what is actually on disk
// rather than against the builders that produced it once.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compileVfxGraph } from '../vfx/compile.js';
import { normalizeVfxDoc } from '../vfx/doc.js';
import {
  PRESET_CATEGORIES,
  PRESET_ID_PATTERN,
  normalizePreset,
  validatePreset,
} from '../vfx/preset.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'resources', 'vfx', 'presets');
const PACK = path.join(ROOT, 'resources', 'vfx', 'assets');

let failures = 0;
const fail = (id, message) => {
  console.error(`  FAIL  ${id}: ${message}`);
  failures += 1;
};

const files = (await readdir(DIR).catch(() => [])).filter((name) => name.endsWith('.json'));
if (files.length === 0) {
  console.error(`No presets found in ${DIR}. Run: node tools/seed-vfx-presets.mjs`);
  process.exit(1);
}

const seen = new Set();
const categories = new Map();
const tags = new Map();
const packUsage = new Map();

for (const file of files.sort()) {
  const stem = file.slice(0, -5);
  let preset;
  try {
    preset = normalizePreset(JSON.parse(await readFile(path.join(DIR, file), 'utf8')), stem);
  } catch (err) {
    fail(stem, `unreadable: ${err.message}`);
    continue;
  }

  // The filename IS the id everywhere else - the URL, the thumbnail, the delete
  // route - so a file whose contents disagree would be addressable under one
  // name and self-describe as another.
  if (preset.id !== stem) fail(stem, `id "${preset.id}" does not match the filename`);
  if (!PRESET_ID_PATTERN.test(preset.id)) fail(stem, 'id is not a safe filename/URL segment');
  if (seen.has(preset.id)) fail(stem, 'duplicate id');
  seen.add(preset.id);

  const problems = validatePreset(preset);
  if (problems.length) fail(stem, problems.join(' '));

  // A card with no description is a card that teaches nothing, which defeats
  // the library. Cheap to check, and easy to forget when adding one by hand.
  if (!preset.description) fail(stem, 'no description');
  if (!preset.tags.length) fail(stem, 'no tags');
  if (!PRESET_CATEGORIES.includes(preset.category)) {
    fail(stem, `category "${preset.category}" is not one of the known categories`);
  }

  try {
    const { diagnostics } = compileVfxGraph(normalizeVfxDoc(preset.doc), { assetIndex: new Set() });
    const bad = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warn');
    if (bad.length) {
      fail(stem, `${bad.length} diagnostic(s): ${bad.map((d) => `${d.severity[0].toUpperCase()}:${d.code}`).join(' ')}`);
    }
  } catch (err) {
    fail(stem, `does not compile: ${err.message}`);
  }

  // A DECLARATION NAMING A FILE THE PACK DOES NOT HAVE installs nothing and
  // wires nothing: the effect opens drawing with the built-in blob and the only
  // clue is an info diagnostic. This is the check that keeps the two directories
  // in step, and it is why the pack ships beside the presets.
  for (const need of preset.assets) {
    if (!existsSync(path.join(PACK, need.file))) {
      fail(stem, `declares "${need.file}", which is not in resources/vfx/assets/`);
    }
    packUsage.set(need.file, (packUsage.get(need.file) || 0) + 1);
  }

  categories.set(preset.category, (categories.get(preset.category) || 0) + 1);
  for (const tag of preset.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
}

console.log(`${files.length} presets checked\n`);
for (const category of PRESET_CATEGORIES) {
  console.log(`  ${String(categories.get(category) || 0).padStart(3)}  ${category}`);
}
console.log(`\n  tags: ${[...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}(${n})`).join(' ')}`);

// Unused pack files are not an error - the author may be staging one for a
// preset not yet written - but an unused one is usually a typo in a
// declaration that the existence check above did not catch because BOTH
// names happened to exist.
const packFiles = (await readdir(PACK).catch(() => [])).filter((f) => !f.startsWith('.'));
const unused = packFiles.filter((file) => !packUsage.has(file));
console.log(`\n  pack: ${packFiles.length} files, ${packUsage.size} used`
  + (unused.length ? `, unused: ${unused.join(' ')}` : ''));

if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log('\nall presets are valid and compile with no errors or warnings');
