// Phase 0, spike 7: can a VFX Graph template be BOUND from script, and does the
// binding survive a prefab save?
//
// Spike 1 proved the setters exist on VisualEffect. That is not the same claim
// as "the value sticks in an asset an author can ship" - a property sheet on a
// component is serialised state, and serialised state is exactly where a
// value-type API quietly loses writes. So this binds a real template and reads
// it back off disk.
//
// It also enumerates what the SHIPPED templates expose, because that decides
// how much work a template author has: if a stock template already exposes a
// spawn rate and a lifetime, our own templates start from one rather than from
// an empty graph.
//
//   unity run <project> -- -executeMethod VfxGraphBindSpike.Run
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.VFX;

public static class VfxGraphBindSpike
{
    private static readonly StringBuilder Out = new StringBuilder();
    private static int _failures;

    private static void Check(string label, bool ok, string detail = "")
    {
        if (!ok) _failures++;
        Out.AppendLine((ok ? "ok    " : "FAIL  ") + label + (detail.Length > 0 ? "  [" + detail + "]" : ""));
    }

    public static void Run()
    {
        // --- what does the API offer for enumerating exposed properties? ----
        var enumerators = typeof(VisualEffectAsset)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic)
            .Where(m => m.Name.IndexOf("Exposed", StringComparison.OrdinalIgnoreCase) >= 0
                     || m.Name.IndexOf("Propert", StringComparison.OrdinalIgnoreCase) >= 0)
            .Select(m => (m.IsPublic ? "public " : "internal ") + m.Name + "("
                + string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name)) + ")")
            .Distinct().OrderBy(n => n).ToList();
        Out.AppendLine("VisualEffectAsset property APIs:");
        foreach (var name in enumerators) Out.AppendLine("    " + name);
        Out.AppendLine();

        // --- copy the shipped templates in and see what they expose ---------
        var templatesDir = Directory
            .GetDirectories(Path.Combine("Library", "PackageCache"), "com.unity.visualeffectgraph@*")
            .Select(d => Path.Combine(d, "Editor", "Templates"))
            .FirstOrDefault(Directory.Exists);
        Check("the package ships .vfx templates", templatesDir != null, templatesDir ?? "not found");
        if (templatesDir == null) { Finish(); return; }

        Directory.CreateDirectory("Assets/VfxGraphSpike");
        var copied = new List<string>();
        foreach (var source in Directory.GetFiles(templatesDir, "*.vfx"))
        {
            var dest = "Assets/VfxGraphSpike/" + Path.GetFileName(source);
            File.Copy(source, dest, true);
            copied.Add(dest);
        }
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        Check("templates import as VisualEffectAssets",
            copied.Count > 0, copied.Count + " copied");

        VisualEffectAsset bindable = null;
        string bindableFloat = null;

        Out.AppendLine();
        Out.AppendLine("Exposed properties of each shipped template:");
        foreach (var path in copied.OrderBy(p => p))
        {
            var asset = AssetDatabase.LoadAssetAtPath<VisualEffectAsset>(path);
            if (asset == null)
            {
                Out.AppendLine("  " + Path.GetFileName(path) + ": DID NOT LOAD");
                continue;
            }

            var properties = new List<VFXExposedProperty>();
            asset.GetExposedProperties(properties);
            Out.AppendLine("  " + Path.GetFileName(path) + ": " + properties.Count + " exposed");
            foreach (var property in properties)
            {
                Out.AppendLine("      " + property.type?.Name + " " + property.name);
                if (bindableFloat == null && property.type == typeof(float))
                {
                    bindable = asset;
                    bindableFloat = property.name;
                }
            }
        }

        // --- bind one, save it, read it back off disk -----------------------
        //
        // THE QUESTION THAT MATTERS. A property set on a live component in a
        // batch process proves nothing about what an author ships.
        if (bindable == null)
        {
            Out.AppendLine();
            Out.AppendLine("NOTE: no shipped template exposes a float, so the persistence half of");
            Out.AppendLine("this spike could not run against a stock asset. That is itself the");
            Out.AppendLine("finding: our templates must expose properties deliberately - a stock");
            Out.AppendLine("graph exposes nothing useful to bind.");
            Finish();
            return;
        }

        var go = new GameObject("BoundEffect");
        var effect = go.AddComponent<VisualEffect>();
        effect.visualEffectAsset = bindable;

        Check("the component accepts the template asset", effect.visualEffectAsset == bindable);
        Check("  and reports the property exists", effect.HasFloat(bindableFloat), bindableFloat);

        effect.SetFloat(bindableFloat, 17.25f);
        Check("  a bound value reads back live",
            Math.Abs(effect.GetFloat(bindableFloat) - 17.25f) < 1e-4f,
            effect.GetFloat(bindableFloat).ToString("F2"));

        Directory.CreateDirectory("Assets/VfxGraphSpike/Out");
        var prefabPath = "Assets/VfxGraphSpike/Out/BoundEffect.prefab";
        PrefabUtility.SaveAsPrefabAsset(go, prefabPath, out var saved);
        Check("it saves as a prefab", saved);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        var reloaded = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        Check("  and reloads", reloaded != null);
        if (reloaded != null)
        {
            var reloadedEffect = reloaded.GetComponent<VisualEffect>();
            Check("  keeping its template", reloadedEffect.visualEffectAsset == bindable);
            // THE ONE THAT DECIDES WHETHER A VFX GRAPH BACKEND IS POSSIBLE.
            Check("  AND KEEPING THE BOUND VALUE",
                Math.Abs(reloadedEffect.GetFloat(bindableFloat) - 17.25f) < 1e-4f,
                reloadedEffect.GetFloat(bindableFloat).ToString("F2"));
        }

        Finish();
    }

    private static void Finish()
    {
        Out.Insert(0, (_failures == 0 ? "EVERY CHECK PASSED" : _failures + " FAILURE(S)") + "\n\n");
        var path = Path.Combine(Directory.GetCurrentDirectory(), "spike-vfxgraph-bind.txt");
        File.WriteAllText(path, Out.ToString());
        Debug.Log("[VfxGraphBindSpike] wrote " + path);
        EditorApplication.Exit(0);
    }
}
