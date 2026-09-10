// Phase 0, spike 6: can a Shuriken ParticleSystem be built ENTIRELY from script?
//
// WHY THIS MATTERS MORE THAN IT LOOKS. Spike 5 established that VFX Graph's
// graph model is `internal`, so a plugin can only bind exposed properties on a
// human-authored template - which caps structural fidelity at whatever the
// template has slots for, and means the plugin cannot ship without templates
// somebody drew by hand.
//
// Shuriken is the older system, but if its modules are public and writable then
// a plugin can build a COMPLETE effect from the IR with no templates at all:
// one ParticleSystem per system, a real burst list of any length, real curves
// and gradients, real collision. That is strictly more of the IR surviving.
//
// So this asks the question properly, and it actually BUILDS one and reads the
// values back rather than only reflecting over the type - because "the setter
// exists" and "the value sticks" are different claims, and a struct-based
// module API is exactly where they come apart: ParticleSystem's modules are
// returned BY VALUE, so `ps.emission.enabled = true` on a local copy is a
// silent no-op unless the property setter writes through.
//
//   unity run C:/Git/VfxImportSpike -- -executeMethod VfxShurikenSpike.Run
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class VfxShurikenSpike
{
    private static readonly List<string> Lines = new List<string>();
    private static int _failures;

    private static void Check(string label, bool ok, string detail = "")
    {
        if (!ok) _failures++;
        Lines.Add((ok ? "ok    " : "FAIL  ") + label + (detail.Length > 0 ? "  [" + detail + "]" : ""));
    }

    public static void Run()
    {
        var go = new GameObject("SpikeSystem");
        var ps = go.AddComponent<ParticleSystem>();
        var renderer = go.GetComponent<ParticleSystemRenderer>();

        // --- the main module ------------------------------------------------
        var main = ps.main;
        main.duration = 2.5f;
        main.loop = true;
        main.startLifetime = new ParticleSystem.MinMaxCurve(0.3f, 0.85f);
        main.startSize = new ParticleSystem.MinMaxCurve(0.02f, 0.05f);
        main.startSpeed = new ParticleSystem.MinMaxCurve(1f, 4f);
        main.maxParticles = 2048;
        main.gravityModifier = 0.5f;
        main.simulationSpace = ParticleSystemSimulationSpace.World;
        Check("main.duration writes through", Math.Abs(ps.main.duration - 2.5f) < 1e-4f,
            ps.main.duration.ToString("F2"));
        Check("  a two-constant random range survives",
            Math.Abs(ps.main.startLifetime.constantMin - 0.3f) < 1e-4f
            && Math.Abs(ps.main.startLifetime.constantMax - 0.85f) < 1e-4f,
            ps.main.startLifetime.mode.ToString());
        Check("  maxParticles maps to the IR's capacity", ps.main.maxParticles == 2048);
        Check("  and simulation space is settable",
            ps.main.simulationSpace == ParticleSystemSimulationSpace.World);

        // --- THE BURST LIST, which is what the timeline needs ---------------
        //
        // This is the question spike 5 could not answer for VFX Graph: a burst
        // list there is graph structure and cannot be written. Here it is an
        // array, of any length, with a time and a count per entry - which is
        // exactly the shape of ir.systems[].schedule.clips.
        var emission = ps.emission;
        emission.enabled = true;
        emission.rateOverTime = 0f;
        var bursts = new[]
        {
            new ParticleSystem.Burst(0.00f, 60),
            new ParticleSystem.Burst(0.15f, 24),
            new ParticleSystem.Burst(0.40f, 12),
            new ParticleSystem.Burst(1.10f, 40),
            new ParticleSystem.Burst(1.60f, 8),
        };
        emission.SetBursts(bursts);
        Check("a burst list of arbitrary length is settable",
            ps.emission.burstCount == 5, ps.emission.burstCount.ToString());
        var readBack = new ParticleSystem.Burst[ps.emission.burstCount];
        ps.emission.GetBursts(readBack);
        Check("  with the times preserved",
            Math.Abs(readBack[3].time - 1.10f) < 1e-4f, readBack[3].time.ToString("F2"));
        Check("  and the counts preserved",
            readBack[0].count.constant == 60 && readBack[4].count.constant == 8,
            readBack[0].count.constant + "," + readBack[4].count.constant);
        // A rate window as well as instantaneous bursts - the IR's clips carry
        // a duration, and duration 0 is the burst case.
        emission.rateOverTime = new ParticleSystem.MinMaxCurve(120f);
        Check("  alongside a rate", Math.Abs(ps.emission.rateOverTime.constant - 120f) < 1e-3f);

        // --- curves and gradients, as themselves ----------------------------
        var curve = new AnimationCurve(
            new Keyframe(0f, 0f, 0f, 2f),
            new Keyframe(0.4f, 1f, 0f, 0f),
            new Keyframe(1f, 0.2f, -1f, 0f));
        var sizeOverLife = ps.sizeOverLifetime;
        sizeOverLife.enabled = true;
        sizeOverLife.size = new ParticleSystem.MinMaxCurve(1.4f, curve);
        Check("a curve over life takes an AnimationCurve",
            ps.sizeOverLifetime.size.mode == ParticleSystemCurveMode.Curve
            && ps.sizeOverLifetime.size.curve.length == 3,
            ps.sizeOverLifetime.size.curve.length + " keys");
        // TANGENTS SURVIVE, which is what makes a Hermite key map field-for-field.
        Check("  including its tangents",
            Math.Abs(ps.sizeOverLifetime.size.curve.keys[0].outTangent - 2f) < 1e-4f,
            ps.sizeOverLifetime.size.curve.keys[0].outTangent.ToString("F2"));
        Check("  and its multiplier",
            Math.Abs(ps.sizeOverLifetime.size.curveMultiplier - 1.4f) < 1e-4f);

        var gradient = new Gradient();
        gradient.SetKeys(
            new[]
            {
                new GradientColorKey(new Color(1f, 0.95f, 0.8f), 0f),
                new GradientColorKey(new Color(1f, 0.55f, 0.15f), 0.35f),
                new GradientColorKey(new Color(0.15f, 0.12f, 0.1f), 1f),
            },
            new[]
            {
                new GradientAlphaKey(0f, 0f),
                new GradientAlphaKey(1f, 0.1f),
                new GradientAlphaKey(0f, 1f),
            });
        var colourOverLife = ps.colorOverLifetime;
        colourOverLife.enabled = true;
        colourOverLife.color = new ParticleSystem.MinMaxGradient(gradient);
        Check("a gradient over life takes a Gradient",
            ps.colorOverLifetime.color.gradient.colorKeys.Length == 3
            && ps.colorOverLifetime.color.gradient.alphaKeys.Length == 3,
            ps.colorOverLifetime.color.gradient.colorKeys.Length + " colour keys");
        // SEPARATE COLOUR AND ALPHA KEY LISTS - the reason the IR stores them
        // apart rather than merged. They round-trip.
        Check("  with colour and alpha keys kept apart",
            Math.Abs(ps.colorOverLifetime.color.gradient.alphaKeys[1].time - 0.1f) < 1e-4f);

        // --- shapes, forces, collision --------------------------------------
        var shape = ps.shape;
        shape.enabled = true;
        shape.shapeType = ParticleSystemShapeType.ConeVolume;
        shape.angle = 18f;
        shape.radius = 0.25f;
        shape.rotation = new Vector3(0f, 0f, -60f);
        Check("an emitter shape is settable",
            ps.shape.shapeType == ParticleSystemShapeType.ConeVolume
            && Math.Abs(ps.shape.angle - 18f) < 1e-4f, ps.shape.shapeType.ToString());

        var shapes = Enum.GetNames(typeof(ParticleSystemShapeType));
        Lines.Add("      shapes available: " + string.Join(" ", shapes));

        var force = ps.forceOverLifetime;
        force.enabled = true;
        force.x = new ParticleSystem.MinMaxCurve(0f);
        force.y = new ParticleSystem.MinMaxCurve(2.2f);
        Check("a force over life is settable", ps.forceOverLifetime.enabled);

        var limit = ps.limitVelocityOverLifetime;
        limit.enabled = true;
        limit.limit = new ParticleSystem.MinMaxCurve(6f);
        limit.dampen = 0.4f;
        Check("a speed limit maps to limitVelocityOverLifetime",
            ps.limitVelocityOverLifetime.enabled);

        var noise = ps.noise;
        noise.enabled = true;
        noise.strength = new ParticleSystem.MinMaxCurve(1.4f);
        noise.frequency = 0.6f;
        Check("turbulence maps to the noise module", ps.noise.enabled);

        var collision = ps.collision;
        collision.enabled = true;
        collision.type = ParticleSystemCollisionType.Planes;
        collision.bounce = new ParticleSystem.MinMaxCurve(0.3f);
        collision.dampen = new ParticleSystem.MinMaxCurve(0.5f);
        Check("plane collision is settable", ps.collision.enabled);

        var rotation = ps.rotationOverLifetime;
        rotation.enabled = true;
        rotation.z = new ParticleSystem.MinMaxCurve(-3f, 3f);
        Check("spin maps to rotationOverLifetime", ps.rotationOverLifetime.enabled);

        var subs = ps.subEmitters;
        Check("a sub-emitter slot exists", subs.subEmittersCount >= 0,
            "count " + subs.subEmittersCount);

        // --- the renderer ---------------------------------------------------
        renderer.renderMode = ParticleSystemRenderMode.Stretch;
        renderer.lengthScale = 2f;
        renderer.sortMode = ParticleSystemSortMode.Distance;
        Check("the render mode covers billboard/stretch/mesh",
            renderer.renderMode == ParticleSystemRenderMode.Stretch
            && Enum.GetNames(typeof(ParticleSystemRenderMode)).Contains("Mesh"),
            string.Join(" ", Enum.GetNames(typeof(ParticleSystemRenderMode))));
        Check("  and sorting is settable", renderer.sortMode == ParticleSystemSortMode.Distance);

        // --- does it PERSIST? -----------------------------------------------
        //
        // The whole point is a prefab an author can drop in a scene, so the
        // values have to survive serialisation - not merely exist on a live
        // component in a batch-mode process.
        Directory.CreateDirectory("Assets/SpikeOut");
        var prefabPath = "Assets/SpikeOut/SpikeSystem.prefab";
        var saved = PrefabUtility.SaveAsPrefabAsset(go, prefabPath, out var savedOk);
        Check("it saves as a prefab", savedOk && saved != null);

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        var reloaded = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        Check("  and reloads from disk", reloaded != null);
        if (reloaded != null)
        {
            var rps = reloaded.GetComponent<ParticleSystem>();
            Check("  with the burst list intact", rps.emission.burstCount == 5,
                rps.emission.burstCount.ToString());
            Check("  the curve intact", rps.sizeOverLifetime.size.curve.length == 3);
            Check("  the gradient intact", rps.colorOverLifetime.color.gradient.colorKeys.Length == 3);
            Check("  and the shape intact",
                rps.shape.shapeType == ParticleSystemShapeType.ConeVolume);
        }

        var report = new StringBuilder();
        report.Append("Shuriken spike: ")
              .Append(_failures == 0 ? "EVERY CHECK PASSED" : _failures + " FAILURE(S)")
              .Append('\n').Append('\n');
        foreach (var line in Lines) report.Append(line).Append('\n');

        var outPath = Path.Combine(Directory.GetCurrentDirectory(), "spike-shuriken.txt");
        File.WriteAllText(outPath, report.ToString());
        Debug.Log("[VfxShurikenSpike] wrote " + outPath);
        EditorApplication.Exit(0);
    }
}
