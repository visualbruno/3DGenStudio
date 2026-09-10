// Phase 0 spikes for the 3D Gen Studio VFX importer.
//
// These answer the questions docs/VFX_PLUGINS.md marks as *assumed*, and the
// plan says the answers dictate the IR - so they run BEFORE the importer is
// written rather than after it is half built on a guess.
//
// It writes JSON to spike-results.json at the project root and never depends on
// the console log, because a batch-mode log interleaves with a hundred lines of
// package resolution and asset import.
//
//   unity run C:/Git/VfxImportSpike -- -executeMethod VfxImportSpike.Run
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.VFX;

public static class VfxImportSpike
{
    // A deliberately tiny JSON writer. Newtonsoft is not guaranteed present and
    // JsonUtility cannot serialise a dictionary, and the shape here is three
    // levels deep - so hand-writing it is less code than working around either.
    private sealed class Json
    {
        private readonly StringBuilder _sb = new StringBuilder();
        private int _depth;
        private bool _first = true;

        public Json Obj(string key = null)
        {
            Comma();
            if (key != null) _sb.Append('"').Append(key).Append("\": ");
            _sb.Append("{\n");
            _depth++;
            _first = true;
            return this;
        }

        public Json End(bool array = false)
        {
            _depth--;
            _sb.Append('\n').Append(new string(' ', _depth * 2)).Append(array ? ']' : '}');
            _first = false;
            return this;
        }

        public Json Arr(string key)
        {
            Comma();
            _sb.Append('"').Append(key).Append("\": [\n");
            _depth++;
            _first = true;
            return this;
        }

        public Json Str(string key, string value)
        {
            Comma();
            _sb.Append('"').Append(key).Append("\": ").Append(Quote(value));
            return this;
        }

        public Json Bool(string key, bool value)
        {
            Comma();
            _sb.Append('"').Append(key).Append("\": ").Append(value ? "true" : "false");
            return this;
        }

        public Json Num(string key, double value)
        {
            Comma();
            _sb.Append('"').Append(key).Append("\": ")
               .Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return this;
        }

        public Json Item(string value)
        {
            Comma();
            _sb.Append(Quote(value));
            return this;
        }

        private void Comma()
        {
            if (!_first) _sb.Append(",\n");
            _first = false;
            _sb.Append(new string(' ', _depth * 2));
        }

        private static string Quote(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"")
                               .Replace("\n", "\\n").Replace("\r", "") + "\"";
        }

        public override string ToString() => _sb.ToString();
    }

    public static void Run()
    {
        var json = new Json();
        json.Obj();
        json.Str("unityVersion", Application.unityVersion);
        json.Str("renderPipeline",
            UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline == null
                ? "built-in"
                : UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.GetType().FullName);

        var vfxAssembly = typeof(VisualEffect).Assembly;
        json.Str("vfxRuntimeAssembly", vfxAssembly.GetName().Name);
        json.Str("vfxPackageVersion", PackageVersion());

        SpikeOne(json);
        SpikeTwoAndFive(json);
        SpikeThree(json);
        json.End();

        var path = Path.Combine(Directory.GetCurrentDirectory(), "spike-results.json");
        File.WriteAllText(path, json.ToString() + "\n");
        Debug.Log("[VfxImportSpike] wrote " + path);
        EditorApplication.Exit(0);
    }

    private static string PackageVersion()
    {
        var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(VisualEffect).Assembly);
        return info == null ? "unknown" : info.version;
    }

    // ---------------------------------------------------------------------
    // SPIKE 1: which exposed-property types can an Editor script actually set?
    //
    // This decides whether curves and gradients travel as themselves or have to
    // be baked to lookup textures. The IR carries both (`tables[].n` alongside
    // the authored keys) so either answer works - but the importer is a very
    // different program depending on which.
    // ---------------------------------------------------------------------
    private static void SpikeOne(Json json)
    {
        json.Obj("spike1_settableTypes");

        // The Set*/Get*/Has* triples on VisualEffect ARE the binding surface: an
        // importer sets exposed properties on a component, so whatever is not
        // here cannot be imported as a property at all.
        var setters = typeof(VisualEffect)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(m => m.Name.StartsWith("Set", StringComparison.Ordinal))
            .Select(m =>
            {
                var ps = m.GetParameters();
                return m.Name + "(" + string.Join(", ", ps.Select(p => p.ParameterType.Name)) + ")";
            })
            .Distinct()
            .OrderBy(name => name)
            .ToList();

        json.Arr("visualEffectSetters");
        foreach (var name in setters) json.Item(name);
        json.End(true);

        // The ones the importer needs by name, so the result is a yes/no per
        // IR feature rather than a list to eyeball.
        var needed = new Dictionary<string, Type[]>
        {
            { "SetFloat", new[] { typeof(string), typeof(float) } },
            { "SetInt", new[] { typeof(string), typeof(int) } },
            { "SetBool", new[] { typeof(string), typeof(bool) } },
            { "SetVector2", new[] { typeof(string), typeof(Vector2) } },
            { "SetVector3", new[] { typeof(string), typeof(Vector3) } },
            { "SetVector4", new[] { typeof(string), typeof(Vector4) } },
            { "SetTexture", new[] { typeof(string), typeof(Texture) } },
            { "SetMesh", new[] { typeof(string), typeof(Mesh) } },
            { "SetAnimationCurve", new[] { typeof(string), typeof(AnimationCurve) } },
            { "SetGradient", new[] { typeof(string), typeof(Gradient) } },
            { "SetMatrix4x4", new[] { typeof(string), typeof(Matrix4x4) } },
        };

        json.Obj("required");
        foreach (var pair in needed.OrderBy(p => p.Key))
        {
            json.Bool(pair.Key, typeof(VisualEffect).GetMethod(pair.Key, pair.Value) != null);
        }
        json.End();

        // CURVES AND GRADIENTS ARE THE WHOLE QUESTION. If these two exist, an
        // authored Hermite curve maps field-for-field onto a Unity Keyframe and
        // nothing has to be baked - which is what the IR was designed to allow.
        json.Bool("curvesTravelAsCurves",
            typeof(VisualEffect).GetMethod("SetAnimationCurve", new[] { typeof(string), typeof(AnimationCurve) }) != null);
        json.Bool("gradientsTravelAsGradients",
            typeof(VisualEffect).GetMethod("SetGradient", new[] { typeof(string), typeof(Gradient) }) != null);

        json.End();
    }

    // ---------------------------------------------------------------------
    // SPIKE 5 (and 2): are spawn timing and burst lists reachable, and can an
    // Editor script author a graph at all - or only bind a pre-made one?
    //
    // This is the one the timeline depends on. If a graph's STRUCTURE can be
    // built from script, clip timing exports natively and there are no template
    // tiers to maintain. If not, the plugin ships pre-authored templates and
    // clip timing is limited to however many burst slots a template exposes -
    // which is exactly what "how many tiers" means.
    // ---------------------------------------------------------------------
    private static void SpikeTwoAndFive(Json json)
    {
        json.Obj("spike5_graphAuthoring");

        // The editor-side VFX assembly, where any graph-construction API lives.
        var editorAssembly = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == "Unity.VisualEffectGraph.Editor");
        json.Bool("editorAssemblyPresent", editorAssembly != null);

        if (editorAssembly != null)
        {
            // Is there a public way to make a new .vfx asset? If this is
            // internal-only, the importer must copy a template instead.
            var utility = editorAssembly.GetType("UnityEditor.VFX.VisualEffectAssetEditorUtility");
            json.Bool("assetEditorUtilityFound", utility != null);
            if (utility != null)
            {
                var create = utility.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                    .Where(m => m.Name.IndexOf("Create", StringComparison.OrdinalIgnoreCase) >= 0)
                    .Select(m => (m.IsPublic ? "public " : "internal ") + m.Name)
                    .Distinct().OrderBy(n => n).ToList();
                json.Arr("createMethods");
                foreach (var name in create) json.Item(name);
                json.End(true);
            }

            // VFXGraph / VFXContext / VFXBlock: the graph model. Public means a
            // plugin can build a graph node by node; internal means templates.
            json.Obj("graphModelVisibility");
            foreach (var typeName in new[]
            {
                "UnityEditor.VFX.VFXGraph",
                "UnityEditor.VFX.VFXContext",
                "UnityEditor.VFX.VFXBlock",
                "UnityEditor.VFX.VFXModel",
                "UnityEditor.VFX.Block.SetAttribute",
            })
            {
                var type = editorAssembly.GetType(typeName);
                json.Str(typeName.Substring(typeName.LastIndexOf('.') + 1),
                    type == null ? "absent" : (type.IsPublic ? "public" : "internal"));
            }
            json.End();

            // How many spawn blocks ship, and are burst counts/delays among
            // their inputs? Names only - enough to plan the templates.
            var spawnerBlocks = editorAssembly.GetTypes()
                .Where(t => t.FullName != null && t.FullName.StartsWith("UnityEditor.VFX.Block", StringComparison.Ordinal))
                .Where(t => t.Name.IndexOf("Spawn", StringComparison.OrdinalIgnoreCase) >= 0
                         || t.Name.IndexOf("Burst", StringComparison.OrdinalIgnoreCase) >= 0)
                .Select(t => t.Name).Distinct().OrderBy(n => n).ToList();
            json.Arr("spawnBlockTypes");
            foreach (var name in spawnerBlocks) json.Item(name);
            json.End(true);
        }

        // Whatever the graph model allows, this is the runtime lever the
        // importer can always reach: play rate and event sending on the
        // component. Clip timing can be driven from these even if the graph's
        // own burst list cannot be written.
        json.Obj("runtimeSpawnControls");
        foreach (var member in new[] { "playRate", "pause", "Play", "Stop", "SendEvent", "Reinit", "startSeed", "resetSeedOnPlay" })
        {
            var found = typeof(VisualEffect).GetMember(member,
                BindingFlags.Public | BindingFlags.Instance).Length > 0;
            json.Bool(member, found);
        }
        json.End();

        json.End();
    }

    // ---------------------------------------------------------------------
    // SPIKE 3: the coordinate and unit convention, measured rather than
    // recalled. The plan recommends metres, Y-up, right-handed with the plugin
    // converting; this records what Unity actually reports so the conversion is
    // written against a fact.
    // ---------------------------------------------------------------------
    private static void SpikeThree(Json json)
    {
        json.Obj("spike3_conventions");
        // Unity is left-handed Y-up with 1 unit = 1 metre by convention; the
        // cross product is the thing that actually proves the handedness.
        var cross = Vector3.Cross(Vector3.right, Vector3.up);
        json.Str("crossRightUp", cross.ToString("F0"));
        json.Str("handedness", Mathf.Approximately(cross.z, 1f) ? "left" : "right");
        json.Num("physicsGravityY", Physics.gravity.y);
        json.End();
    }
}
