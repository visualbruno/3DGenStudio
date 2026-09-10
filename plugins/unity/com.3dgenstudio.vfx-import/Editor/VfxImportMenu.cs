// The menu entry: Assets > Import VFX Bundle...
//
// A folder picker and a result dialog, deliberately. There is no settings
// window because there is nothing worth configuring - the bundle says what the
// effect is, and every choice this importer makes it makes because the IR or
// the engine forces it. A window full of options nobody understands is how an
// importer becomes something people avoid.
using System.IO;
using UnityEditor;
using UnityEngine;

namespace GenStudio3D.VfxImport
{
    public static class VfxImportMenu
    {
        private const string LastFolderKey = "GenStudio3D.VfxImport.LastBundleFolder";

        [MenuItem("Assets/Import VFX Bundle...", false, 20)]
        public static void ImportBundle()
        {
            var last = EditorPrefs.GetString(LastFolderKey, "");
            var folder = EditorUtility.OpenFolderPanel(
                "Choose the exported VFX bundle folder", last, "");
            if (string.IsNullOrEmpty(folder)) return;
            EditorPrefs.SetString(LastFolderKey, folder);

            if (!File.Exists(Path.Combine(folder, "ir.json")))
            {
                EditorUtility.DisplayDialog(
                    "Not a VFX bundle",
                    $"{folder} has no ir.json in it.\n\nChoose the folder the app wrote, the one "
                    + "containing manifest.json and ir.json.",
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
