// Rebuild plugins/unity/3dgenstudio-vfx-import.unitypackage.
//
//     node tools/pack-unity-plugin.mjs <a Unity project path> [--unity <Unity.exe>]
//
// REQUIRES UNITY, which is why this is not part of `npm run dist`. A
// .unitypackage carries .meta files, GUIDs and a specific tar layout that only
// the editor produces; a zip of the same files is not the same thing and will
// not import.
//
// The project you point at is scratch space - the plugin is staged into its
// Assets/ folder and removed again. It must NOT have the package installed in
// its Packages/ folder: that is a GUID collision, and Unity resolves it by
// reassigning every GUID, which produces a package that DUPLICATES every script
// on re-import rather than updating it. The editor-side tool refuses in that
// case rather than writing a broken package, and verifies each GUID against its
// committed .meta before exporting.
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { hashSources } from './check-unity-plugin.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_DIR = path.join(ROOT, 'plugins', 'unity', 'com.3dgenstudio.vfx-import');
const TOOL = path.join(ROOT, 'plugins', 'unity', 'Tools', 'VfxPluginPackager.cs');
const OUTPUT = path.join(ROOT, 'plugins', 'unity', '3dgenstudio-vfx-import.unitypackage');

const args = process.argv.slice(2);
const project = args.find((arg) => !arg.startsWith('--'));
const unityAt = args.indexOf('--unity');
const unity = unityAt >= 0 ? args[unityAt + 1] : 'unity';

if (!project || !existsSync(project)) {
  console.error('Usage: node tools/pack-unity-plugin.mjs <a Unity project path> [--unity <exe>]');
  process.exit(2);
}
if (existsSync(path.join(project, 'Packages', 'com.3dgenstudio.vfx-import'))) {
  console.error(
    `${project} has the package installed under Packages/.\n`
    + 'Remove it first: staging a copy into Assets/ collides with its GUIDs and Unity '
    + 'reassigns every one, producing a package that duplicates files on re-import.');
  process.exit(1);
}

const editorDir = path.join(project, 'Assets', 'Editor');
const installedTool = path.join(editorDir, 'VfxPluginPackager.cs');
await mkdir(editorDir, { recursive: true });
await copyFile(TOOL, installedTool);

// `--unity` IS THE EDITOR BINARY, not a launcher, and on Windows that is what
// a Unity Hub install leaves on disk:
//
//     C:/Program Files/Unity/Hub/Editor/<version>/Editor/Unity.exe
//
// An earlier version of this script passed `run <project> --timeout ...`, which
// is a launcher's vocabulary and which no editor understands - it had simply
// never been run, because the drift check is what usually tells you to rebuild
// and the rebuild is rare.
//
// AND NO SHELL. `shell: true` concatenates the arguments into one command line,
// so the space in "Program Files" split the executable in two and cmd reported
// a missing 'C:/Program' - the default install path of the very tool this
// script exists to drive.
const run = () => new Promise((resolve) => {
  const child = spawn(unity, [
    '-batchmode', '-nographics', '-quit',
    '-projectPath', project,
    '-executeMethod', 'VfxPluginPackager.Run',
    '-sourceDir', PACKAGE_DIR,
    '-output', OUTPUT,
    '-logFile', path.join(project, 'pack-unity-plugin.log'),
  ], { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`Could not run ${unity}: ${error.message}`);
    console.error('Point --unity at the editor binary, e.g. '
      + '"C:/Program Files/Unity/Hub/Editor/<version>/Editor/Unity.exe"');
    resolve(1);
  });
  child.on('exit', resolve);
});

const code = await run();
await rm(installedTool, { force: true });
await rm(installedTool + '.meta', { force: true });

if (code !== 0) {
  console.error(`\nUnity exited ${code}. See ${path.join(project, 'pack-unity-plugin.log')}`);
  process.exit(1);
}

// The stamp the drift check compares against, written only after a successful
// build so a failed run cannot leave the two agreeing about nothing.
const hash = await hashSources(PACKAGE_DIR);
await writeFile(`${OUTPUT}.sources.sha256`, hash + '\n', 'utf8');
const size = (await readFile(OUTPUT)).length;
console.log(`\nWrote ${OUTPUT} (${size} bytes), sources ${hash.slice(0, 12)}`);
