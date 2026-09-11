// The menu entry: Assets > Import VFX Bundle...
//
// A folder picker and a result dialog, deliberately. There is no settings
// window because there is nothing worth configuring - the bundle says what the
// effect is, and every choice this importer makes it makes because the IR or
// the engine forces it. A window full of options nobody understands is how an
// importer becomes something people avoid.
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace GenStudio3D.VfxImport
{
    public static class VfxImportMenu
    {
        private const string LastFolderKey = "GenStudio3D.VfxImport.LastBundleFolder";

        /// <summary>
        /// Import without the folder picker, for batch mode and CI:
        ///
        ///   unity run &lt;project&gt; -- -executeMethod \
        ///     GenStudio3D.VfxImport.VfxImportMenu.ImportBundleFromCommandLine \
        ///     -vfxBundle &lt;bundle folder&gt; [-vfxDestination Assets/...]
        ///
        /// Exits non-zero on failure so a script can tell. The interactive path
        /// above cannot be reused: OpenFolderPanel blocks forever with no GUI,
        /// and DisplayDialog in -batchmode throws.
        /// </summary>
        public static void ImportBundleFromCommandLine()
        {
            var bundle = ArgumentValue("-vfxBundle");
            if (string.IsNullOrEmpty(bundle) || !File.Exists(Path.Combine(bundle, "manifest.json")))
            {
                Debug.LogError("[VFX Import] pass -vfxBundle <folder holding manifest.json>");
                EditorApplication.Exit(1);
                return;
            }

            var destination = ArgumentValue("-vfxDestination")
                ?? Path.Combine("Assets", "ImportedVfx", new DirectoryInfo(bundle).Name);

            // Replaced, not stacked. The interactive path deliberately lands
            // beside an earlier import so nobody loses hand-edited materials;
            // a scripted reimport of the same effect means "make this current",
            // and twenty ImportedVfx/Nuclear Blast 1..20 folders is what the
            // other behaviour produces in a loop.
            if (Directory.Exists(destination))
            {
                AssetDatabase.DeleteAsset(destination.Replace('\\', '/'));
                AssetDatabase.Refresh();
            }

            var result = VfxBundleImporter.Import(bundle, destination);
            Debug.Log("[VFX Import] " + result.Report.ToText());
            if (result.Report.Failed || result.Prefab == null)
            {
                Debug.LogError("[VFX Import] failed: " + result.Report.Summary());
                EditorApplication.Exit(1);
                return;
            }

            Debug.Log($"[VFX Import] {result.Report.Summary()} -> {result.PrefabPath}");
            EditorApplication.Exit(0);
        }

        private static string ArgumentValue(string flag)
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == flag) return args[i + 1];
            }
            return null;
        }

        [MenuItem("Assets/Import VFX Bundle...", false, 20)]
        public static void ImportBundle()
        {
            var last = EditorPrefs.GetString(LastFolderKey, "");
            var folder = EditorUtility.OpenFolderPanel(
                "Choose the exported VFX bundle folder", last, "");
            if (string.IsNullOrEmpty(folder)) return;
            EditorPrefs.SetString(LastFolderKey, folder);

            // MANIFEST.JSON, NOT ir.json. The bundle has ONE file: the IR is
            // embedded in the manifest as `manifest.ir`. This guard used to
            // demand a separate ir.json, which the exporter has never written -
            // a layout guessed before the first real export existed. The
            // importer itself was rewritten against a real bundle; this check
            // was not, so it refused every correct bundle before the working
            // loader ever ran, and told the author that the file the app DOES
            // write is not enough. A guard stricter than the code it guards is
            // worse than no guard at all.
            if (!File.Exists(Path.Combine(folder, "manifest.json")))
            {
                EditorUtility.DisplayDialog(
                    "Not a VFX bundle",
                    $"{folder} has no manifest.json in it.\n\nChoose the folder the app wrote - "
                    + "the one holding manifest.json, plus an assets folder if the effect uses "
                    + "any textures or meshes.",
                    "OK");
                return;
            }

            // Under Assets/ImportedVfx/<bundle name>, so a second import of the
            // same effect lands beside the first rather than over it.
            var destination = Path.Combine("Assets", "ImportedVfx", new DirectoryInfo(folder).Name);
            var result = VfxBundleImporter.Import(folder, destination);

            if (result.Report.Failed)
            {
                Debug.LogError("[VFX Import] " + result.Report.ToText());
                EditorUtility.DisplayDialog("VFX import failed", result.Report.Summary(), "OK");
                return;
            }

            Debug.Log("[VFX Import] " + result.Report.ToText());
            if (result.Prefab != null)
            {
                Selection.activeObject = result.Prefab;
                EditorGUIUtility.PingObject(result.Prefab);
            }

            // The counts, then where the detail is. An author who sees
            // "approximated 3" wants to know which three, and the console has
            // scrolled by the time they ask.
            EditorUtility.DisplayDialog(
                "VFX imported",
                $"{result.Report.Summary()}\n\n{result.PrefabPath}\n\n"
                + "The full breakdown is in the .import-report.txt beside the prefab.",
                "OK");
        }
    }
}
