// Is the shipped .unitypackage still made of the plugin sources beside it?
//
//     node tools/check-unity-plugin.mjs
//
// A .unitypackage can only be built BY UNITY - it needs .meta files, stable
// GUIDs and a specific tar layout - so it cannot be regenerated in the normal
// dist chain and is committed as a binary instead. A committed build artifact
// drifts the moment somebody edits a .cs file and forgets, and the failure is
// invisible: the package still imports, it just installs last week's importer.
//
// So the sources are hashed and the hash committed beside the package. This
// check recomputes it, needs no Unity, and runs in `npm run check:vfx`.
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_DIR = path.join(ROOT, 'plugins', 'unity', 'com.3dgenstudio.vfx-import');
const BUNDLE = path.join(ROOT, 'plugins', 'unity', '3dgenstudio-vfx-import.unitypackage');
const STAMP = `${BUNDLE}.sources.sha256`;

/** Every file in the package, hashed with its path so a rename counts. */
export async function hashSources(dir) {
  const files = [];
  const walk = async (current) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(dir);

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(dir, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// Run as a script, not when imported for `hashSources` alone. Guarded against
// argv[1] being absent, which is the case under `node -e`.
if ((process.argv[1] || '').endsWith('check-unity-plugin.mjs')) {
  if (!existsSync(PACKAGE_DIR)) {
    console.error(`No Unity plugin at ${PACKAGE_DIR}`);
    process.exit(1);
  }

  const actual = await hashSources(PACKAGE_DIR);

  if (!existsSync(BUNDLE) || !existsSync(STAMP)) {
    console.error(
      'The Unity plugin has no .unitypackage beside it.\n'
      + '  Build one:  node tools/pack-unity-plugin.mjs <a Unity project path>');
    process.exit(1);
  }

  const stamped = (await readFile(STAMP, 'utf8')).trim();
  if (stamped !== actual) {
    console.error(
      'The Unity plugin sources changed since the .unitypackage was built.\n'
      + `  sources  ${actual}\n`
      + `  package  ${stamped}\n`
      + '  Rebuild: node tools/pack-unity-plugin.mjs <a Unity project path>');
    process.exit(1);
  }

  const size = (await stat(BUNDLE)).size;
  console.log(`Unity plugin: .unitypackage is current (${size} bytes, sources ${actual.slice(0, 12)})`);
}
