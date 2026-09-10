// Import a 3D Gen Studio VFX bundle: read it, build it, save a prefab, report.
//
// A bundle is a folder the app wrote:
//
//   manifest.json          everything - versions, the compiled IR, the
//                          authoring graph, the engine mapping, the reference
//                          table and the exporter's warnings
//   assets/images/*        the textures the effect references
//   assets/meshes/*        the models it references
//   assets/vfx/*           the effect's own graph file
//
// ONE MANIFEST, NOT AN ir.json. The IR is `manifest.ir`; this importer was
// first written against a guessed layout with a separate ir.json and separate
// textures/ and meshes/ folders, and none of that exists. Read the exporter
// (storage.js buildVfxExportPlan) rather than assuming the obvious layout.
//
// IT READS THE IR, NOT THE GRAPH, which is the plan's central rule: the IR is
// what the compiler produces after operator sorting, frequency classification
// and curve baking, so a plugin that read the graph would have to reimplement
// that compiler in C# - and any divergence would mean Unity and Unreal
// disagreeing about the same effect.
//
// IT REFUSES A VERSION IT DOES NOT KNOW rather than half-importing. An effect
// that looks nearly right is worse than an error, because nobody goes looking.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GenStudio3D.VfxImport
{
    public static class VfxBundleImporter
    {
        /// <summary>Bundle formats this importer understands.</summary>
        public const int MinBundleFormat = 1;
        public const int MaxBundleFormat = 1;

        /// <summary>IR formats this importer understands.</summary>
        public const int MinIrFormat = 1;
        public const int MaxIrFormat = 1;

        public sealed class Result
        {
            public GameObject Prefab;
            public string PrefabPath;
            public VfxImportReport Report;
        }

        /// <summary>
        /// Import a bundle folder into a destination folder under Assets/.
        /// </summary>
        public static Result Import(string bundleFolder, string destinationFolder)
        {
            var report = new VfxImportReport();

            var manifestPath = Path.Combine(bundleFolder, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                report.Error($"no manifest.json in {bundleFolder}");
                return new Result { Report = report };
            }

            VfxJson manifest;
            try { manifest = VfxJson.Parse(File.ReadAllText(manifestPath)); }
            catch (Exception error)
            {
                report.Error("manifest.json is not readable: " + error.Message);
                return new Result { Report = report };
            }

            var ir = manifest["ir"];
            if (ir.IsNull)
            {
                report.Error("manifest.json has no `ir` - is this a VFX bundle?");
                return new Result { Report = report };
            }

            if (!CheckVersions(manifest, ir, report)) return new Result { Report = report };
            if (!VfxConvert.CanConvertSpace(ir["space"], out var spaceReason))
            {
                report.Error(spaceReason);
                return new Result { Report = report };
            }

            // What the app already told the author, repeated here so the import
            // confirms rather than surprises. See VFX_PLUGINS.md.
            foreach (var warning in manifest["warnings"].Items)
            {
                // {code, severity, message} objects, not strings. The exporter
                // already dropped info-level diagnostics, so everything here is
                // a genuine fidelity note.
                report.Approximated(null,
                    warning["code"].AsString("exporter warning"),
                    warning["message"].AsString(warning.AsString()));
            }
            foreach (var gap in manifest["engineGaps"].Items)
            {
                report.Approximated(null, "engine gap",
                    gap["block"].AsString(gap.AsString()) + " " + gap["note"].AsString());
            }

            Directory.CreateDirectory(destinationFolder);
            var effectName = SanitiseName(
                manifest["asset"]["name"].AsString(ir["effect"]["name"].AsString("VfxEffect")));

            // THE REFERENCE TABLE IS THE JOIN. Each entry is
            // {slot, kind, ref: "asset:<id>", file: "assets/images/x.png"} - so
            // the id a block's slot resolves to reaches a file through here, and
            // guessing from filenames is unnecessary.
            var imported = ImportReferencedFiles(bundleFolder, destinationFolder, manifest, report);
            var textures = new Dictionary<int, Texture2D>();
            var meshes = new Dictionary<int, Mesh>();
            foreach (var pair in imported)
            {
                if (pair.Value is Texture2D texture) textures[pair.Key] = texture;
                else if (pair.Value is Mesh mesh) meshes[pair.Key] = mesh;
                else if (pair.Value is GameObject model)
                {
                    // A .glb imports as a GameObject hierarchy; the particle
                    // renderer wants the Mesh inside it.
                    var filter = model.GetComponentInChildren<MeshFilter>();
                    if (filter != null && filter.sharedMesh != null) meshes[pair.Key] = filter.sharedMesh;
                }
            }
            var materials = new Dictionary<string, Material>();

            var builder = new VfxShurikenBuilder(
                ir,
                report,
                assetId => textures.TryGetValue(assetId, out var texture) ? texture : null,
                assetId => meshes.TryGetValue(assetId, out var mesh) ? mesh : null,
                blend => MaterialFor(blend, effectName, destinationFolder, materials, report));

            var root = builder.Build(effectName);

            var prefabPath = AssetDatabase.GenerateUniqueAssetPath(
                Path.Combine(destinationFolder, effectName + ".prefab").Replace('\\', '/'));
            var prefab = PrefabUtility.SaveAsPrefabAsset(root, prefabPath, out var saved);
            UnityEngine.Object.DestroyImmediate(root);

            if (!saved)
            {
                report.Error("the prefab could not be saved to " + prefabPath);
                return new Result { Report = report };
            }

            // The report goes next to the prefab, not only to the console: a
            // batch import of twenty effects scrolls the console away, and the
            // question "what did this one approximate?" is asked weeks later.
            File.WriteAllText(Path.Combine(destinationFolder, effectName + ".import-report.txt"),
                report.ToText());

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            return new Result { Prefab = prefab, PrefabPath = prefabPath, Report = report };
        }

        private static bool CheckVersions(VfxJson manifest, VfxJson ir, VfxImportReport report)
        {
            var bundleFormat = manifest["bundleFormat"].AsInt(1);
            if (bundleFormat < MinBundleFormat || bundleFormat > MaxBundleFormat)
            {
                report.Error($"bundleFormat {bundleFormat} is outside the supported range "
                           + $"{MinBundleFormat}-{MaxBundleFormat}; update this importer");
                return false;
            }

            var irFormat = ir["irFormat"].AsInt(0);
            if (irFormat < MinIrFormat || irFormat > MaxIrFormat)
            {
                report.Error($"irFormat {irFormat} is outside the supported range "
                           + $"{MinIrFormat}-{MaxIrFormat}; update this importer");
                return false;
            }
            return true;
        }

        /// <summary>
        /// Copy every file the bundle references into the project, indexed by
        /// the asset id a block's slot resolves to.
        ///
        /// DRIVEN BY manifest.references, not by walking the assets folder.
        /// Each entry carries the slot, the kind, the `asset:<id>` ref and
        /// the file's path inside the bundle - so the id is joined to the file
        /// by the exporter rather than guessed from a filename here. An entry
        /// with NO file is a slot the author never filled, which the exporter
        /// records deliberately rather than warning about, so it is not an
        /// error here either.
        /// </summary>
        private static Dictionary<int, UnityEngine.Object> ImportReferencedFiles(
            string bundleFolder, string destinationFolder, VfxJson manifest, VfxImportReport report)
        {
            var result = new Dictionary<int, UnityEngine.Object>();

            foreach (var reference in manifest["references"].Items)
            {
                var file = reference["file"].AsString();
                var refText = reference["ref"].AsString();
                var kind = reference["kind"].AsString("image");

                if (string.IsNullOrEmpty(file))
                {
                    // No file: either the slot is empty (normal - the effect
                    // draws with a built-in stand-in) or the asset was missing
                    // from the library, which the exporter already warned about.
                    continue;
                }

                var assetId = ParseAssetRef(refText);
                if (assetId < 0)
                {
                    report.Dropped(null, kind + " " + file,
                        $"the reference \"{refText}\" is not an asset id this importer understands");
                    continue;
                }

                var source = Path.Combine(bundleFolder, file.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(source))
                {
                    report.Dropped(null, kind + " " + file,
                        "the manifest lists this file but the bundle does not contain it");
                    continue;
                }

                // Flattened into one folder per kind, keeping the basename: the
                // bundle's own nesting is an export detail, and a project folder
                // mirroring it would be three levels deep for no benefit.
                var target = Path.Combine(destinationFolder, kind == "mesh" ? "Meshes" : "Textures");
                Directory.CreateDirectory(target);
                var destination = Path.Combine(target, Path.GetFileName(file));
                File.Copy(source, destination, true);

                var projectPath = ToProjectPath(destination);
                AssetDatabase.ImportAsset(projectPath, ImportAssetOptions.ForceSynchronousImport);

                var loaded = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(projectPath);
                if (loaded == null)
                {
                    report.Dropped(null, kind + " " + Path.GetFileName(file),
                        "Unity could not import this file");
                    continue;
                }

                // UNITY HAS NO BUILT-IN glTF IMPORTER, and this is the trap the
                // first end-to-end import fell into: a .glb copies in fine and
                // loads as a DefaultAsset - not null, so nothing looks wrong -
                // and then no mesh block can find a Mesh in it. The effect
                // imports "successfully" with its mesh emitter silently empty.
                if (loaded is DefaultAsset)
                {
                    var extension = Path.GetExtension(file).ToLowerInvariant();
                    var advice = extension == ".glb" || extension == ".gltf"
                        ? "Unity has no built-in glTF importer - add com.unity.cloud.gltfast (or "
                          + "UnityGLTF) to the project and import again, or convert the mesh to FBX "
                          + "before exporting"
                        : "Unity does not recognise this file type";
                    report.Dropped(null, kind + " " + Path.GetFileName(file), advice);
                    continue;
                }

                result[assetId] = loaded;
                report.Native(null, kind, Path.GetFileName(file) + " -> asset " + assetId);
            }

            return result;
        }

        /// <summary>The id in an `asset:<id>` reference, or -1.</summary>
        private static int ParseAssetRef(string reference)
        {
            const string prefix = "asset:";
            if (string.IsNullOrEmpty(reference) || !reference.StartsWith(prefix, StringComparison.Ordinal))
            {
                return -1;
            }
            return int.TryParse(reference.Substring(prefix.Length), out var id) ? id : -1;
        }

        /// <summary>
        /// A particle material for a blend mode, created once per import.
        ///
        /// URP's particle shader first, the built-in one second. Neither is
        /// guaranteed: a project on HDRP has different shaders again, and one
        /// with neither package installed has none - so a missing shader is
        /// reported and the effect imports without a material rather than
        /// failing the whole import.
        /// </summary>
        private static Material MaterialFor(
            string blend, string effectName, string destinationFolder,
            Dictionary<string, Material> cache, VfxImportReport report)
        {
            if (cache.TryGetValue(blend, out var existing)) return existing;

            var shader = Shader.Find("Universal Render Pipeline/Particles/Unlit")
                      ?? Shader.Find("Particles/Standard Unlit")
                      ?? Shader.Find("Mobile/Particles/Additive")
                      ?? Shader.Find("Sprites/Default");
            if (shader == null)
            {
                report.Dropped(null, "material", "no particle shader is available in this project");
                cache[blend] = null;
                return null;
            }

            var material = new Material(shader) { name = effectName + "_" + blend };

            // URP's Unlit particle shader spells its blending as _Surface (0
            // opaque, 1 transparent) plus _Blend (0 alpha, 1 premultiply, 2
            // additive, 3 multiply). Setting a property the shader does not
            // have is a silent no-op, so the built-in path is unaffected.
            if (material.HasProperty("_Surface")) material.SetFloat("_Surface", blend == "opaque" ? 0f : 1f);
            if (material.HasProperty("_Blend"))
            {
                material.SetFloat("_Blend", blend == "additive" ? 2f
                    : blend == "premultiplied" ? 1f
                    : 0f);
            }
            // The keyword has to follow the float or the shader keeps compiling
            // the opaque variant and the effect renders as solid quads.
            if (blend != "opaque")
            {
                material.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            }
            if (blend == "additive")
            {
                material.EnableKeyword("_ALPHAPREMULTIPLY_ON");
                material.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                material.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.One);
                material.SetFloat("_ZWrite", 0f);
            }

            var path = AssetDatabase.GenerateUniqueAssetPath(
                Path.Combine(destinationFolder, material.name + ".mat").Replace('\\', '/'));
            AssetDatabase.CreateAsset(material, path);
            cache[blend] = material;
            return material;
        }

        private static string ToProjectPath(string absolute)
        {
            var full = Path.GetFullPath(absolute).Replace('\\', '/');
            var root = Path.GetFullPath(Application.dataPath).Replace('\\', '/');
            return full.StartsWith(root, StringComparison.OrdinalIgnoreCase)
                ? "Assets" + full.Substring(root.Length)
                : full;
        }

        private static string SanitiseName(string name)
        {
            var invalid = Path.GetInvalidFileNameChars();
            var clean = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
            return string.IsNullOrEmpty(clean) ? "VfxEffect" : clean;
        }
    }
}
