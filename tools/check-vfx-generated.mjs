// Fails if docs/VFX_ENGINE_MAPPING.md is out of date with vfx/catalog.js.
//
//     node tools/check-vfx-generated.mjs
//
// The same shape as check-generated-db.mjs, and for the same reason: the file
// fails SILENTLY when stale. A block added to the catalog without regenerating
// leaves a table that an importer-plugin author will read as authoritative, and
// nothing in lint or the test suites looks at a markdown file.
//
// Regenerating in place and comparing is the only honest check - it is exactly
// what a developer would get by running the generator themselves.
//
// Wired into the dist scripts alongside check:packaging and check:db. A build
// that cannot run is better than one that runs wrong; a build that ships a
// wrong mapping table is the same bargain one step removed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// LF-normalised before comparing: .gitattributes checks docs out as CRLF
// wherever core.autocrlf is on, which is every Windows CI runner, and raw byte
// comparison would report a byte-identical file as stale.
const read = (full) => fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');

const GENERATED = [
  { file: 'docs/VFX_ENGINE_MAPPING.md', generator: 'tools/gen-vfx-mapping.mjs' },
];

const before = new Map();
for (const { file, generator } of GENERATED) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.error(`FAIL: ${file} is missing entirely. Generate it with: node ${generator}`);
    process.exit(1);
  }
  before.set(file, read(full));
}

for (const { generator } of GENERATED) {
  execFileSync(process.execPath, [path.join(ROOT, generator)], { cwd: ROOT, stdio: 'pipe' });
}

const stale = [];
for (const { file, generator } of GENERATED) {
  if (read(path.join(ROOT, file)) !== before.get(file)) stale.push({ file, generator });
}

if (stale.length) {
  console.error('FAIL: the generated VFX docs are out of date with vfx/catalog.js.\n');
  for (const { file, generator } of stale) {
    console.error(`  ${file} — regenerate with: node ${generator}`);
  }
  console.error('\nThey have just been regenerated in place; review and commit them.');
  process.exit(1);
}

console.log('docs/VFX_ENGINE_MAPPING.md is up to date with vfx/catalog.js');
