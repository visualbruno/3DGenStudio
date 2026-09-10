// Export the importer as a .unitypackage.
//
// AssetDatabase.ExportPackage only walks paths under Assets/, and the plugin
// lives in Packages/ - so it is staged into Assets/ first, WITH the .meta files
// committed alongside the source.
//
// THE GUIDS ARE THE WHOLE POINT AND THEY ARE EASY TO LOSE. A .unitypackage
// carries a GUID per asset; if a rebuild assigns new ones, a user importing an
// update gets a SECOND copy of every script rather than an overwrite, and a
// duplicate-class compile error. The first build of this tool did exactly that
// and looked fine - 13 assets, sensible paths, plausible size - because the
// package was ALSO installed under Packages/, so staging a copy into Assets/
// was a GUID collision and Unity silently reassigned every one.
//
// Hence two rules, both enforced below rather than documented and hoped for:
// the package must NOT be installed while packaging, and every staged asset's
// GUID is compared against its committed .meta before the export is written.
//
//   unity run <project> -- -executeMethod VfxPluginPackager.Run -sourceDir <abs path>
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

public static class VfxPluginPackager
{
    private const string Installed = "Packages/com.3dgenstudio.vfx-import";
    private const string Staged = "Assets/3DGenStudioVfxImport";

    public static void Run()
    {
        var sourceDir = ArgumentValue("-sourceDir");
        var outputPath = ArgumentValue("-output")
            ?? Path.Combine(Directory.GetCurrentDirectory(), "3dgenstudio-vfx-import.unitypackage");

        if (string.IsNullOrEmpty(sourceDir) || !Directory.Exists(sourceDir))
        {
            Fail("pass -sourceDir <absolute path to the package folder>");
            return;
        }

        // The collision that silently broke the first build.
        if (Directory.Exists(Path.GetFullPath(Installed)))
        {
            Fail($"{Installed} is installed in this project. Staging a copy into Assets/ would "
                 + "collide with its GUIDs and Unity would reassign every one, so remove the "
                 + "package from Packages/ before packaging.");
            return;
        }

        var stagedDir = Path.GetFullPath(Staged);
        if (Directory.Exists(stagedDir)) Directory.Delete(stagedDir, true);
        CopyTree(sourceDir, stagedDir);

        // The package manifest is a UPM concept; under Assets/ it is dead
        // weight that would only confuse whoever reads the folder.
        foreach (var stray in new[] { "package.json", "package.json.meta" })
        {
            var path = Path.Combine(stagedDir, stray);
            if (File.Exists(path)) File.Delete(path);
        }

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

        if (!GuidsSurvived(sourceDir, out var complaint))
        {
            Cleanup(stagedDir);
            Fail(complaint);
            return;
        }

#pragma warning disable CS0618
        // Obsolete in 6.6 in favour of UnityEditor.AssetPackage.Package.Export,
        // which does not exist in 6000.0 - the version this package declares
        // support for. A dev-only tool warning is the cheaper trade.
        AssetDatabase.ExportPackage(Staged, outputPath, ExportPackageOptions.Recurse);
#pragma warning restore CS0618

        var info = new FileInfo(outputPath);
        Debug.Log($"[VfxPluginPackager] wrote {outputPath} ({info.Length} bytes), GUIDs verified");

        Cleanup(stagedDir);
        EditorApplication.Exit(0);
    }

    /// <summary>
    /// Every staged asset must keep the GUID its committed .meta declares.
    /// </summary>
    private static bool GuidsSurvived(string sourceDir, out string complaint)
    {
        var mismatches = new List<string>();
        foreach (var meta in Directory.GetFiles(sourceDir, "*.meta", SearchOption.AllDirectories))
        {
            var relative = meta.Substring(sourceDir.Length).TrimStart('\\', '/').Replace('\\', '/');
            if (relative.StartsWith("package.json")) continue;

            var declared = Regex.Match(File.ReadAllText(meta), @"guid: ([0-9a-f]+)");
            if (!declared.Success) continue;

            var assetPath = Staged + "/" + relative.Substring(0, relative.Length - ".meta".Length);
            var actual = AssetDatabase.AssetPathToGUID(assetPath);
            if (actual != declared.Groups[1].Value)
            {
                mismatches.Add($"{assetPath}: staged as {actual}, committed as {declared.Groups[1].Value}");
            }
        }

        complaint = mismatches.Count == 0
            ? null
            : "the staged copy did not keep its committed GUIDs, so this package would duplicate "
              + "files on re-import instead of updating them:\n  " + string.Join("\n  ", mismatches);
        return mismatches.Count == 0;
    }

    private static void Cleanup(string stagedDir)
    {
        if (Directory.Exists(stagedDir)) Directory.Delete(stagedDir, true);
        var stagedMeta = stagedDir + ".meta";
        if (File.Exists(stagedMeta)) File.Delete(stagedMeta);
        AssetDatabase.Refresh();
    }

    private static void Fail(string message)
    {
        Debug.LogError("[VfxPluginPackager] " + message);
        EditorApplication.Exit(1);
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

    private static void CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.GetFiles(from))
        {
            File.Copy(file, Path.Combine(to, Path.GetFileName(file)), true);
        }
        foreach (var dir in Directory.GetDirectories(from))
        {
            CopyTree(dir, Path.Combine(to, Path.GetFileName(dir)));
        }
    }
}
