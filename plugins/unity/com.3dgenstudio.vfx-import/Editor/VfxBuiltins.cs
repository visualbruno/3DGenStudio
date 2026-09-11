// The stand-ins an effect draws with when it names no texture or no mesh.
//
// WHY THIS FILE EXISTS AT ALL. The app has never drawn an untextured particle:
// src/utils/vfx/assets.js generates a soft radial blob and a small tetrahedron,
// and its header is explicit that this is a product decision rather than a
// convenience - the first thing an author sees after adding a Spawn block
// should look like an effect, not like a bug. The importer had no equivalent,
// so the two renderers disagreed in the worst possible place:
//
//   - No texture: URP's particle shader samples a null _BaseMap as WHITE, so
//     every particle drew as a full opaque quad. On an alpha blend that is a
//     grey card; on an ADDITIVE blend it is a solid bright square. A nuclear
//     blast whose flash, fireball and shockwave all left the texture slot empty
//     - which is normal, they are meant to be plain glows - imported as three
//     stacks of glowing rectangles. The preview showed soft light.
//   - No mesh: the importer switched the renderer off, so the system vanished.
//     The preview showed a tetrahedron chip per particle.
//
// GENERATED, NOT SHIPPED AS FILES. A .png and a .asset committed in the package
// would need .meta files with pinned GUIDs (see VfxPluginPackager for how much
// that machinery costs), would be duplicated into every import folder anyway,
// and could drift from the app's generator without anything noticing. Building
// them from the same arithmetic the app uses keeps one source of truth: if
// assets.js changes its falloff, the change to make here is visible.
//
// WRITTEN INTO THE IMPORT FOLDER, not into a shared Assets/Editor cache,
// because an import folder is the unit a user deletes. A stand-in living
// somewhere else would outlive the effect that needed it.
using System.IO;
using UnityEditor;
using UnityEngine;

namespace GenStudio3D.VfxImport
{
    public static class VfxBuiltins
    {
        public const string SpriteFileName = "VfxDefaultSprite.png";
        public const string MeshFileName = "VfxDefaultParticleMesh.asset";

        /// <summary>Matches DEFAULT_SPRITE_SIZE in src/utils/vfx/assets.js.</summary>
        private const int SpriteSize = 64;

        /// <summary>Matches getDefaultParticleMesh: TetrahedronGeometry(0.6).</summary>
        private const float MeshRadius = 0.6f;

        /// <summary>
        /// The built-in soft sprite: white, with a smooth radial alpha falloff.
        ///
        /// The same arithmetic as getDefaultSprite - smoothstep from the rim
        /// inwards, so the edge lands on zero with zero gradient. A linear
        /// falloff shows a visible ring where it reaches zero, which on a
        /// hundred overlapping additive quads reads as a lattice.
        ///
        /// RGB stays white at every alpha, which is what makes one sprite
        /// correct under all four blend modes: nothing here is premultiplied,
        /// so the additive path adds alpha-weighted white and the alpha path
        /// composites it, exactly as the preview's shader does.
        /// </summary>
        public static Texture2D CreateSprite(string destinationFolder, VfxImportReport report)
        {
            var folder = Path.Combine(destinationFolder, "Textures");
            Directory.CreateDirectory(folder);
            var path = ToProjectPath(Path.Combine(folder, SpriteFileName));

            var existing = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (existing != null) return existing;

            var pixels = new Color32[SpriteSize * SpriteSize];
            var centre = (SpriteSize - 1) / 2f;
            var radius = centre;
            for (var y = 0; y < SpriteSize; y++)
            {
                for (var x = 0; x < SpriteSize; x++)
                {
                    var dx = (x - centre) / radius;
                    var dy = (y - centre) / radius;
                    var distance = Mathf.Sqrt(dx * dx + dy * dy);
                    var t = Mathf.Clamp01(1f - distance);
                    var alpha = t * t * (3f - 2f * t);
                    pixels[y * SpriteSize + x] =
                        new Color32(255, 255, 255, (byte)Mathf.RoundToInt(alpha * 255f));
                }
            }

            // A REAL PNG ON DISK, not a Texture2D created with CreateAsset. A
            // generated Texture2D asset has no TextureImporter, so it carries
            // no sRGB flag, no wrap mode and no filter mode that survives a
            // reimport - and a particle atlas that silently turns Repeat is a
            // tiled sprite on every quad.
            var texture = new Texture2D(SpriteSize, SpriteSize, TextureFormat.RGBA32, false, false);
            texture.SetPixels32(pixels);
            texture.Apply();
            File.WriteAllBytes(Path.Combine(folder, SpriteFileName), texture.EncodeToPNG());
            Object.DestroyImmediate(texture);

            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer != null)
            {
                importer.textureType = TextureImporterType.Default;
                importer.sRGBTexture = true;
                importer.alphaSource = TextureImporterAlphaSource.FromInput;
                importer.alphaIsTransparency = true;
                importer.wrapMode = TextureWrapMode.Clamp;
                importer.filterMode = FilterMode.Bilinear;
                // No mipmaps, following assets.js: they buy nothing on a 64px
                // blob and would bleed neighbouring cells on a flipbook atlas.
                importer.mipmapEnabled = false;
                importer.SaveAndReimport();
            }

            var loaded = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (loaded == null)
            {
                report.Dropped(null, "built-in sprite", "Unity could not import " + path);
            }
            return loaded;
        }

        /// <summary>
        /// The built-in particle mesh: a small tetrahedron, matching the app's
        /// TetrahedronGeometry(0.6).
        ///
        /// A tetrahedron rather than a cube or a sphere because it is the
        /// cheapest solid that reads as a chip of debris from any angle, and
        /// because its asymmetry makes rotation visible - which a sphere hides.
        ///
        /// NON-INDEXED, four flat faces. The source geometry is indexed with
        /// shared corners, but sharing them would mean one normal per corner
        /// and a chip that looks inflated; the particle shader is unlit anyway,
        /// so the only thing the winding decides is backface culling.
        ///
        /// Z IS NEGATED, like every other vector that crosses into Unity - see
        /// VfxConvert. The index order is then left alone, because mirroring an
        /// axis already reverses the apparent winding, which is exactly what
        /// turns a right-handed counter-clockwise front face into Unity's
        /// left-handed one. Negating z AND reversing the order would cull every
        /// face and draw a hollow shell.
        /// </summary>
        public static Mesh CreateParticleMesh(string destinationFolder, VfxImportReport report)
        {
            var folder = Path.Combine(destinationFolder, "Meshes");
            Directory.CreateDirectory(folder);
            var path = ToProjectPath(Path.Combine(folder, MeshFileName));

            var existing = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (existing != null) return existing;

            // three's TetrahedronGeometry, verbatim: four corners of a cube's
            // alternating diagonal, pushed out to the radius.
            var corners = new[]
            {
                new Vector3(1f, 1f, 1f),
                new Vector3(-1f, -1f, 1f),
                new Vector3(-1f, 1f, -1f),
                new Vector3(1f, -1f, -1f),
            };
            for (var i = 0; i < corners.Length; i++)
            {
                var c = corners[i].normalized * MeshRadius;
                corners[i] = new Vector3(c.x, c.y, -c.z);
            }
            var faces = new[] { 2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1 };

            var vertices = new Vector3[faces.Length];
            var uvs = new Vector2[faces.Length];
            var triangles = new int[faces.Length];
            // UVs sit in the middle of the sprite, where the radial falloff is
            // still fully opaque. A mesh particle normally wears an opaque
            // material and ignores alpha entirely, but an author who switches
            // this system to an alpha blend should get a solid chip rather than
            // a ghost with three transparent corners.
            var faceUvs = new[]
            {
                new Vector2(0.5f, 0.68f),
                new Vector2(0.34f, 0.4f),
                new Vector2(0.66f, 0.4f),
            };
            for (var i = 0; i < faces.Length; i++)
            {
                vertices[i] = corners[faces[i]];
                uvs[i] = faceUvs[i % 3];
                triangles[i] = i;
            }

            var mesh = new Mesh { name = Path.GetFileNameWithoutExtension(MeshFileName) };
            mesh.vertices = vertices;
            mesh.uv = uvs;
            mesh.triangles = triangles;
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();

            AssetDatabase.CreateAsset(mesh, path);
            var loaded = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (loaded == null)
            {
                report.Dropped(null, "built-in mesh", "Unity could not create " + path);
            }
            return loaded;
        }

        private static string ToProjectPath(string absoluteOrRelative)
        {
            var full = Path.GetFullPath(absoluteOrRelative).Replace('\\', '/');
            var root = Path.GetFullPath(Application.dataPath).Replace('\\', '/');
            return full.StartsWith(root, System.StringComparison.OrdinalIgnoreCase)
                ? "Assets" + full.Substring(root.Length)
                : full;
        }
    }
}
