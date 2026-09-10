// Converting the IR's values into Unity's.
//
// EVERYTHING THAT CROSSES THE HANDEDNESS BOUNDARY GOES THROUGH HERE, and that
// is the whole reason this file exists rather than the conversions being inline
// at each call site.
//
// Measured in Phase 0 (see ../../Spikes/): `Vector3.Cross(right, up)` returns
// (0, 0, 1) in Unity, so **Unity is LEFT-handed**. The IR declares itself
// right-handed, Y-up, metres (`ir.space`). Same up axis, same unit, opposite
// handedness - so every position, velocity, direction and offset needs its Z
// negated, and an euler rotation needs its X and Y negated.
//
// Skipping it mirrors the effect. That is obvious on a vortex or a directional
// emitter and INVISIBLE on a sphere emitter, which is the combination that
// ships broken - so it is one function, used everywhere, and the importer
// refuses a bundle whose declared space it does not recognise rather than
// guessing.
using System;
using System.Collections.Generic;
using UnityEngine;

namespace GenStudio3D.VfxImport
{
    public static class VfxConvert
    {
        /// <summary>The only space this importer knows how to convert from.</summary>
        public const string ExpectedHandedness = "right";
        public const string ExpectedUp = "Y";
        public const string ExpectedUnit = "metre";

        /// <summary>
        /// Is this a space we can convert? Returns the reason when not.
        ///
        /// A bundle from a future exporter that changed convention must be
        /// REFUSED, not imported with the old conversion - a silently mirrored
        /// or rescaled effect is worse than an error.
        /// </summary>
        public static bool CanConvertSpace(VfxJson space, out string reason)
        {
            // An older bundle predates `ir.space`. It was right-handed Y-up
            // metres, which is what this converter assumes, so an absent field
            // is the expected value rather than an unknown one.
            if (space == null || space.IsNull)
            {
                reason = null;
                return true;
            }

            var handedness = space["handedness"].AsString(ExpectedHandedness);
            var up = space["up"].AsString(ExpectedUp);
            var unit = space["unit"].AsString(ExpectedUnit);

            if (handedness != ExpectedHandedness || up != ExpectedUp || unit != ExpectedUnit)
            {
                reason = $"the bundle is in {handedness}-handed {up}-up {unit} space, "
                       + $"and this importer only converts {ExpectedHandedness}-handed "
                       + $"{ExpectedUp}-up {ExpectedUnit} space";
                return false;
            }

            reason = null;
            return true;
        }

        /// <summary>A point or a direction, handedness flipped.</summary>
        public static Vector3 Vector(float[] xyz)
        {
            if (xyz == null || xyz.Length < 3) return Vector3.zero;
            return new Vector3(xyz[0], xyz[1], -xyz[2]);
        }

        public static Vector3 Vector(VfxJson value) => Vector(value.AsFloats());

        /// <summary>
        /// Euler degrees, handedness flipped.
        ///
        /// A rotation is not a vector: mirroring the space negates the sense of
        /// rotation about the two axes that lie IN the mirror plane, and leaves
        /// the one perpendicular to it alone. Flipping Z the way a position is
        /// flipped would tilt every emitter the wrong way.
        /// </summary>
        public static Vector3 Euler(float[] xyz)
        {
            if (xyz == null || xyz.Length < 3) return Vector3.zero;
            return new Vector3(-xyz[0], -xyz[1], xyz[2]);
        }

        public static Vector3 Euler(VfxJson value) => Euler(value.AsFloats());

        /// <summary>
        /// A colour. NOT flipped, obviously - but it does carry HDR values above
        /// one, which is deliberate: the IR's gradients are linear and may
        /// exceed 1 so an additive core can blow out through the tonemapper.
        /// Clamping here would flatten every bright effect.
        /// </summary>
        public static Color Colour(float[] rgba)
        {
            if (rgba == null) return Color.white;
            return new Color(
                rgba.Length > 0 ? rgba[0] : 1f,
                rgba.Length > 1 ? rgba[1] : 1f,
                rgba.Length > 2 ? rgba[2] : 1f,
                rgba.Length > 3 ? rgba[3] : 1f);
        }

        /// <summary>
        /// An IR curve's authored keys as a Unity AnimationCurve.
        ///
        /// FIELD FOR FIELD, which is the payoff of the IR storing Hermite keys
        /// rather than Bezier segments: `{t, v, inTangent, outTangent}` is
        /// exactly Unity's `Keyframe`, so nothing is resampled and nothing is
        /// approximated. Spike 1 confirmed Unity takes a real AnimationCurve,
        /// so the baked table beside these keys is for the app's preview and is
        /// not read here at all.
        /// </summary>
        public static AnimationCurve Curve(VfxJson authored)
        {
            var keys = new List<Keyframe>();
            foreach (var key in authored["keys"].Items)
            {
                var frame = new Keyframe(
                    key["t"].AsFloat(),
                    key["v"].AsFloat(),
                    key["inTangent"].AsFloat(),
                    key["outTangent"].AsFloat());

                // `stepped` has no tangent equivalent - it is a mode. Unity
                // spells it as a constant weighting on both sides.
                if (key["interp"].AsString() == "stepped")
                {
                    frame.inTangent = float.PositiveInfinity;
                    frame.outTangent = float.PositiveInfinity;
                }
                keys.Add(frame);
            }

            // A curve with no keys evaluates to zero everywhere, which for a
            // size-over-life means an invisible effect. A flat one at 1 is the
            // honest neutral.
            if (keys.Count == 0) return AnimationCurve.Constant(0f, 1f, 1f);
            return new AnimationCurve(keys.ToArray());
        }

        /// <summary>
        /// An IR gradient's authored keys as a Unity Gradient.
        ///
        /// SEPARATE COLOUR AND ALPHA KEY LISTS both ways - which is why the IR
        /// stores them apart. A merged list cannot round-trip through Unity's
        /// Gradient, and spike 6 confirmed both lists survive a prefab save.
        ///
        /// The HDR intensity the IR carries per colour key has nowhere to go:
        /// Unity's GradientColorKey is an LDR Color. It is folded into the
        /// colour here and the overflow is reported by the caller, because a
        /// silently clamped 4.2x core is exactly the "looks nearly right"
        /// failure an import must not produce quietly.
        /// </summary>
        public static Gradient GradientFrom(VfxJson authored, out float peakIntensity)
        {
            var colourKeys = new List<GradientColorKey>();
            var alphaKeys = new List<GradientAlphaKey>();
            peakIntensity = 1f;

            foreach (var key in authored["colorKeys"].Items)
            {
                var intensity = key["intensity"].AsFloat(1f);
                if (intensity > peakIntensity) peakIntensity = intensity;
                var colour = HexColour(key["hex"].AsString("#ffffff"));
                colourKeys.Add(new GradientColorKey(colour * intensity, Mathf.Clamp01(key["t"].AsFloat())));
            }

            foreach (var key in authored["alphaKeys"].Items)
            {
                alphaKeys.Add(new GradientAlphaKey(
                    Mathf.Clamp01(key["a"].AsFloat(1f)),
                    Mathf.Clamp01(key["t"].AsFloat())));
            }

            if (colourKeys.Count == 0) colourKeys.Add(new GradientColorKey(Color.white, 0f));
            if (alphaKeys.Count == 0) alphaKeys.Add(new GradientAlphaKey(1f, 0f));

            // Unity caps a Gradient at 8 keys per rail and SILENTLY TRUNCATES
            // past that, so the excess is dropped here where the caller can
            // report it instead.
            var gradient = new Gradient();
            gradient.SetKeys(
                colourKeys.GetRange(0, Mathf.Min(8, colourKeys.Count)).ToArray(),
                alphaKeys.GetRange(0, Mathf.Min(8, alphaKeys.Count)).ToArray());
            return gradient;
        }

        /// <summary>How many keys a rail would lose to Unity's cap of 8.</summary>
        public static int GradientKeysDropped(VfxJson authored)
        {
            var colours = 0;
            foreach (var _ in authored["colorKeys"].Items) colours++;
            var alphas = 0;
            foreach (var _ in authored["alphaKeys"].Items) alphas++;
            return Math.Max(0, colours - 8) + Math.Max(0, alphas - 8);
        }

        private static Color HexColour(string hex)
        {
            if (string.IsNullOrEmpty(hex)) return Color.white;
            if (hex[0] == '#') hex = hex.Substring(1);
            if (hex.Length < 6) return Color.white;
            try
            {
                var r = Convert.ToInt32(hex.Substring(0, 2), 16) / 255f;
                var g = Convert.ToInt32(hex.Substring(2, 2), 16) / 255f;
                var b = Convert.ToInt32(hex.Substring(4, 2), 16) / 255f;
                // sRGB in the file, linear in the engine: Unity's Color is
                // linear when the project is (and URP always is), so a hex read
                // straight in would be visibly washed out.
                return new Color(r, g, b).linear;
            }
            catch (Exception)
            {
                return Color.white;
            }
        }
    }
}
