// Build a Unity particle effect from a 3D Gen Studio VFX IR.
//
// WHY SHURIKEN AND NOT VFX GRAPH, which is what the plan originally assumed.
// Phase 0 measured it (../../Spikes/):
//
//   - VFX Graph's graph model - VFXGraph, VFXContext, VFXBlock, VFXModel - is
//     `internal`. A plugin CANNOT author a graph. It can only bind exposed
//     properties on a template somebody drew by hand, which caps structural
//     fidelity at whatever that template has slots for: a fixed number of
//     systems, a fixed number of burst slots, a fixed renderer per system.
//   - Shuriken's modules are all public and writable, and every one of them
//     survives a prefab save. A burst list of ANY length, curves with their
//     tangents, gradients with separate colour and alpha rails, every emitter
//     shape the catalog uses, forces, noise, collision, spin, sub-emitters,
//     billboard/stretched/mesh rendering and sorting.
//
// So Shuriken carries strictly more of the IR across, needs no hand-authored
// assets, and works under Built-in, URP and HDRP alike because it is not tied
// to a render pipeline. VFX Graph remains worth a second backend for effects
// that need GPU counts, and it needs templates before it can exist.
//
// READS `srcBlockType`, NOT `kernel`. The IR carries both: the kernel is the
// lowered form the app's own runtime dispatches, and srcBlockType is the block
// the author placed. Mapping from the authored type is what lets this file say
// "your Point Attractor became nothing" instead of guessing at a lowered
// kernel's intent.
using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace GenStudio3D.VfxImport
{
    public sealed class VfxShurikenBuilder
    {
        private readonly VfxJson _ir;
        private readonly VfxImportReport _report;

        // The system being built, pre-scanned. An Initialize block has to know
        // what the Update stage will do - see DragDecayCurve.
        private float _systemLifetime = 1f;
        private float _systemDrag;

        private readonly Func<int, Texture2D> _texture;
        private readonly Func<int, Mesh> _mesh;
        private readonly Func<string, Texture2D, Material> _material;
        private readonly Func<Texture2D> _defaultSprite;
        private readonly Func<Mesh> _defaultMesh;

        public VfxShurikenBuilder(
            VfxJson ir,
            VfxImportReport report,
            Func<int, Texture2D> textureForAsset,
            Func<int, Mesh> meshForAsset,
            Func<string, Texture2D, Material> materialForBlendAndTexture,
            Func<Texture2D> defaultSprite = null,
            Func<Mesh> defaultMesh = null)
        {
            _ir = ir;
            _report = report;
            _texture = textureForAsset;
            _mesh = meshForAsset;
            _material = materialForBlendAndTexture;
            _defaultSprite = defaultSprite;
            _defaultMesh = defaultMesh;
        }

        /// <summary>
        /// Build the effect under a single root GameObject, one child
        /// ParticleSystem per IR system.
        ///
        /// ONE CHILD PER SYSTEM rather than one flat system with sub-emitters:
        /// the IR's systems are independent, each with its own capacity,
        /// schedule and renderer, and Shuriken's sub-emitter slots are for
        /// parent-child spawning - which is what ir.events describes and is
        /// wired separately.
        /// </summary>
        public GameObject Build(string effectName)
        {
            var root = new GameObject(string.IsNullOrEmpty(effectName) ? "VfxEffect" : effectName);
            var effect = _ir["effect"];
            var byId = new Dictionary<string, ParticleSystem>();

            foreach (var system in _ir["systems"].Items)
            {
                var name = system["name"].AsString("System");
                var child = new GameObject(name);
                child.transform.SetParent(root.transform, false);
                var ps = child.AddComponent<ParticleSystem>();
                // Stopped before it is configured: a ParticleSystem starts
                // playing the moment it exists, and a half-built one emitting
                // into the scene view during import is noise at best.
                ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

                BuildSystem(ps, system, effect);
                byId[system["id"].AsString()] = ps;
            }

            WireEvents(byId);
            return root;
        }

        // ------------------------------------------------------------------
        // One system
        // ------------------------------------------------------------------
        private void BuildSystem(ParticleSystem ps, VfxJson system, VfxJson effect)
        {
            var name = system["name"].AsString("System");
            var main = ps.main;

            // PRE-SCANNED, because update.drag builds its decay curve over the
            // particle's lifetime and setLifetime lives in the Initialize
            // stage, which has not been walked yet when Update is converted.
            _systemLifetime = 1f;
            _systemDrag = 0f;
            foreach (var block in system["init"].Items)
            {
                if (block["srcBlockType"].AsString() == "initialize.setLifetime")
                {
                    var life = Binding(block, "lifetime");
                    _systemLifetime = Mathf.Max(0.01f, life.IsRandom ? life.High : life.Constant);
                }
            }
            // The vortex needs the system's drag to work out the terminal
            // speed its force settles at, and drag is an Update block that has
            // not been walked yet when the vortex is converted.
            foreach (var block in system["update"].Items)
            {
                if (block["srcBlockType"].AsString() == "update.drag")
                {
                    _systemDrag = Mathf.Max(0f, Binding(block, "drag").Constant);
                }
            }

            main.duration = Mathf.Max(0.01f, effect["duration"].AsFloat(2f));
            main.loop = effect["loop"].AsBool(true);
            main.maxParticles = Mathf.Max(1, system["capacity"].AsInt(1000));
            main.playOnAwake = true;
            // The IR's seed per system, into Unity's own seed field. Spike 4:
            // this makes an imported effect reproducible IN UNITY. It will not
            // match the app's per-particle numbers - Unity's RNG is not PCG32 -
            // and the contract promises statistical conformance, not identity.
            ps.useAutoRandomSeed = false;
            ps.randomSeed = unchecked((uint)(effect["seed"].AsInt(0) + system["seedOffset"].AsInt(0)));

            var space = system["space"].AsString(effect["simulationSpace"].AsString("local"));
            main.simulationSpace = space == "world"
                ? ParticleSystemSimulationSpace.World
                : ParticleSystemSimulationSpace.Local;

            // Defaults the IR always overrides below, set to something inert so
            // a system missing a block does not inherit Unity's own defaults -
            // Shuriken ships with a 5-second lifetime and gravity off, neither
            // of which is what an unspecified IR value means.
            main.startLifetime = new ParticleSystem.MinMaxCurve(1f);
            main.startSize = new ParticleSystem.MinMaxCurve(0.1f);
            main.startSpeed = new ParticleSystem.MinMaxCurve(0f);
            main.startColor = new ParticleSystem.MinMaxGradient(Color.white);
            main.startRotation = new ParticleSystem.MinMaxCurve(0f);
            main.gravityModifier = new ParticleSystem.MinMaxCurve(0f);

            BuildSpawn(ps, system, effect, name);

            // SKIP THE INJECTED KERNELS. `init.snapshot`, `age.advance` and
            // `integrate.semiImplicit` are placed by the compiler, not by the
            // author - they carry no `srcBlockType` - and Shuriken does ageing
            // and integration itself. Reported as dropped, they filled every
            // import with three nameless failures that nobody could act on.
            foreach (var block in system["init"].Items)
            {
                if (block["srcBlockType"].AsString().Length == 0) continue;
                ApplyInit(ps, block, name);
            }
            foreach (var block in system["update"].Items)
            {
                if (block["srcBlockType"].AsString().Length == 0) continue;
                ApplyUpdate(ps, block, name);
            }

            var output = system["outputs"][0];
            if (!output.IsNull) ApplyOutput(ps, output, name);
        }

        // ------------------------------------------------------------------
        // Spawning: rate, bursts and the timeline's clips
        // ------------------------------------------------------------------
        private void BuildSpawn(ParticleSystem ps, VfxJson system, VfxJson effect, string name)
        {
            var emission = ps.emission;
            emission.enabled = true;
            emission.rateOverTime = new ParticleSystem.MinMaxCurve(0f);

            var rate = 0f;
            var burstCount = 0f;
            foreach (var block in system["spawn"].Items)
            {
                var type = block["srcBlockType"].AsString();
                if (type == "spawn.rate") rate = Binding(block, "rate").Constant;
                else if (type == "spawn.burst") burstCount = Binding(block, "count").Constant;
            }

            var fixedDt = Mathf.Max(1e-5f, effect["fixedDt"].AsFloat(1f / 60f));
            var duration = Mathf.Max(0.01f, ps.main.duration);
            var clips = new List<Clip>();
            foreach (var clip in system["schedule"]["clips"].Items)
            {
                clips.Add(new Clip
                {
                    // atStep, not at: the app snaps clip times to whole
                    // simulation steps so scheduling is deterministic, and the
                    // step count is the authoritative number.
                    At = clip["atStep"].AsInt(0) * fixedDt,
                    // THE RULE, from the runtime (emitter.js anyWindowOpen):
                    // durationSteps <= 0 means the window stays open FOREVER
                    // from `at`. It does NOT mean an instantaneous clip - the
                    // default clip every effect gets is exactly this, so
                    // reading it as a zero-length window made every unscheduled
                    // effect emit nothing.
                    Seconds = clip["durationSteps"].AsInt(0) * fixedDt,
                    OpenEnded = clip["durationSteps"].AsInt(0) <= 0 || clip["loop"].AsBool(false),
                    Loop = clip["loop"].AsBool(false),
                });
            }
            if (clips.Count == 0) clips.Add(new Clip { At = 0f, Seconds = 0f, OpenEnded = true });

            // --- bursts ------------------------------------------------------
            // A burst fires when a window OPENS (emitter.js windowOpensOn), and
            // a looping clip re-opens every durationSteps - which is exactly
            // Unity's Burst(time, count, cycleCount, repeatInterval).
            if (burstCount > 0f)
            {
                var bursts = new List<ParticleSystem.Burst>();
                foreach (var clip in clips)
                {
                    var count = (short)Mathf.Clamp(Mathf.RoundToInt(burstCount), 0, short.MaxValue);
                    if (clip.Loop && clip.Seconds > 0f)
                    {
                        // cycleCount 0 is Unity's "repeat forever".
                        bursts.Add(new ParticleSystem.Burst(clip.At, count, count, 0, clip.Seconds));
                    }
                    else
                    {
                        bursts.Add(new ParticleSystem.Burst(clip.At, count));
                    }
                }
                emission.SetBursts(bursts.ToArray());
                _report.Native(name, "spawn.burst",
                    $"{bursts.Count} burst(s) of {burstCount:F0}");
            }

            // --- rate --------------------------------------------------------
            if (rate <= 0f) return;

            // ONE OPEN-ENDED CLIP AT ZERO is the common case - the default
            // schedule - and it is a plain constant rate. So is a single clip
            // that happens to span the whole duration: gating it would build a
            // two-key curve that is on for all of it, which is the same effect
            // written less clearly and one more thing to go wrong.
            if (clips.Count == 1 && clips[0].At <= 1e-4f
                && (clips[0].OpenEnded || clips[0].Seconds >= duration - 1e-4f))
            {
                emission.rateOverTime = new ParticleSystem.MinMaxCurve(rate);
                _report.Native(name, "spawn.rate", rate.ToString("F0") + "/s");
                return;
            }

            // ONE OPEN-ENDED CLIP LATER also maps natively: Unity has a start
            // delay on the main module.
            if (clips.Count == 1 && clips[0].OpenEnded)
            {
                var main = ps.main;
                main.startDelay = new ParticleSystem.MinMaxCurve(clips[0].At);
                emission.rateOverTime = new ParticleSystem.MinMaxCurve(rate);
                _report.Native(name, "spawn.rate",
                    $"{rate:F0}/s after a {clips[0].At:F2}s delay");
                return;
            }

            // ANYTHING ELSE IS A RATE CURVE OVER THE SYSTEM'S DURATION, which
            // is what rateOverTime's curve mode is: normalised 0..1 across
            // main.duration. Stepped keys make each window a hard on/off, so N
            // separate spawn windows survive natively - no burst approximation
            // and no template slot to run out of, which is the thing VFX Graph
            // could not have done.
            emission.rateOverTime = new ParticleSystem.MinMaxCurve(rate, BuildRateGate(clips, duration));
            _report.Native(name, "spawn.rate",
                $"{rate:F0}/s gated by a {clips.Count}-window curve");
        }

        internal struct Clip
        {
            public float At;
            public float Seconds;
            public bool OpenEnded;
            public bool Loop;
        }

        /// <summary>
        /// The on/off curve that gates a rate by the timeline's clips.
        ///
        /// Normalised 0..1 across the system's duration, which is what
        /// rateOverTime's curve mode means. Stepped keys make each window a
        /// hard on/off, so N separate spawn windows survive natively - no burst
        /// approximation and no template slot to run out of, which is the thing
        /// VFX Graph could not have done.
        ///
        /// Internal so it can be tested without building a whole bundle: this
        /// is where an effect silently stopped emitting, and the failure was
        /// invisible from the outside - the report said "70/s gated by a
        /// 1-window curve" while the curve was flat zero.
        /// </summary>
        internal static AnimationCurve BuildRateGate(IReadOnlyList<Clip> clips, float duration)
        {
            var safeDuration = Mathf.Max(0.01f, duration);
            var curve = new AnimationCurve();
            // Off before the first window opens.
            AddStep(curve, 0f, 0f);
            foreach (var clip in clips)
            {
                AddStep(curve, Mathf.Clamp01(clip.At / safeDuration), 1f);
                if (!clip.OpenEnded)
                {
                    AddStep(curve, Mathf.Clamp01((clip.At + clip.Seconds) / safeDuration), 0f);
                }
            }
            return curve;
        }

        /// <summary>
        /// A per-particle random between two values, as TWO FLAT CURVES.
        ///
        /// NOT `new MinMaxCurve(min, max)`, which is the obvious spelling and
        /// is the two-CONSTANT mode. On velocityOverLifetime that mode yields
        /// exactly ZERO - measured: a stem given a constant 12 climbed to
        /// 10.39m, and the same stem given the range 9-15 climbed to 0.00m, with
        /// and without a speed modifier. The prefab looks right either way, so
        /// there is nothing to see in the inspector: minMaxState 3, minScalar 9,
        /// scalar 15, and no motion.
        ///
        /// Two flat curves with a multiplier of 1 carry the same per-particle
        /// draw and do move. The multiplier is 1 rather than derived from the
        /// ends because a symmetric range would derive zero and silently kill
        /// the velocity a second way.
        ///
        /// ALWAYS TWO CURVES, even for a degenerate range where a plain
        /// constant would be simpler and read better. A 3D module keeps ONE
        /// curve mode for x, y and z together, so returning Constant for the
        /// zero axes of an upward velocity - which is every straight-up
        /// emitter - puts x and z in Constant mode and y in TwoCurves, and
        /// Unity resolves the disagreement by evaluating y as ZERO. That is
        /// the whole stem: authored to rise at 9-15 m/s, serialized with all
        /// the right numbers, and standing perfectly still.
        /// </summary>
        internal static ParticleSystem.MinMaxCurve Ranged(float lo, float hi)
        {
            var low = Mathf.Min(lo, hi);
            var high = Mathf.Max(lo, hi);

            var lowCurve = new AnimationCurve();
            lowCurve.AddKey(0f, low);
            lowCurve.AddKey(1f, low);
            var highCurve = new AnimationCurve();
            highCurve.AddKey(0f, high);
            highCurve.AddKey(1f, high);
            return new ParticleSystem.MinMaxCurve(1f, lowCurve, highCurve);
        }

        /// <summary>
        /// How an initial velocity fades under drag, over a particle's life.
        ///
        /// WHY THIS EXISTS. Shuriken has no "fire along this arbitrary vector"
        /// on the start module, so an authored start velocity becomes Velocity
        /// over Lifetime - and Unity's Velocity over Lifetime is an IMPOSED
        /// velocity, re-applied every frame. Unity's drag damps the particle's
        /// own velocity and cannot touch it. So a constant curve means the
        /// particle travels at full speed for its entire life and never slows.
        ///
        /// MEASURED ON A REAL EFFECT: a nuclear blast's stem starts at 12 m/s
        /// with drag 1.1 and a lifetime of 2.6s. The app's stem tops out at
        /// 12.8m - exactly reaching the mushroom cap at 11.5m. Unity's reached
        /// 33.8m, smearing the same particles over nearly three times the
        /// height, so the column went thin and the cap appeared to float
        /// detached above it. Nothing looked broken; it looked badly authored.
        ///
        /// An exponential fits it exactly: with linear drag, v(t) = v0*e^(-kt),
        /// and the distance travelled integrates to the same trajectory the
        /// preview produces.
        ///
        /// The curve is over NORMALIZED life, so a particle whose lifetime is
        /// shorter than the system's longest decays a little too slowly. That
        /// is a second-order error next to the one it fixes.
        /// </summary>
        internal static AnimationCurve DragDecayCurve(float drag, float lifetime)
        {
            var curve = new AnimationCurve();
            if (drag <= 0f)
            {
                // No drag means no decay, which is what a flat curve already
                // said - and is exactly right rather than an approximation.
                curve.AddKey(0f, 1f);
                curve.AddKey(1f, 1f);
                return curve;
            }
            // 24 SAMPLES, SQUARE-SPACED. An exponential does nearly all of its
            // falling in the first fraction of the curve, and the more drag
            // there is the earlier that happens - so uniform samples resolve
            // the flat tail beautifully and miss the part that matters. At
            // drag 7 the uniform 12-sample version overshot the analytic
            // distance by 47%; square spacing puts most of the keys where the
            // curve is actually bending and brings that inside a few percent,
            // at the cost of a dozen keyframes nobody pays for at runtime.
            const int Samples = 24;
            for (var i = 0; i <= Samples; i++)
            {
                var u = i / (float)Samples;
                u *= u;
                curve.AddKey(u, Mathf.Exp(-drag * u * lifetime));
            }
            for (var i = 0; i < curve.length; i++) curve.SmoothTangents(i, 0f);
            return curve;
        }

        /// <summary>
        /// How fast a sustained force actually pushes a particle, over its life.
        ///
        /// THE MIRROR OF DragDecayCurve. That one carries a velocity the
        /// particle was BORN with, which drag bleeds away: v = v0*e^(-kt).
        /// This one carries a force applied CONTINUOUSLY, which drag brings to
        /// a terminal speed instead: v = (a/k)(1 - e^(-kt)).
        ///
        /// Getting the difference wrong is visible in both directions. A
        /// constant a/k from birth makes the cloud jump outward the instant it
        /// spawns, because the real particle needs about 1/k seconds to get up
        /// to speed. Treating it as a decaying velocity - which is what
        /// speedModifier does - makes it stop almost immediately, and a
        /// mushroom cap that should keep widening for its whole life freezes at
        /// the radius it was born with.
        ///
        /// With no drag the force just accelerates: v = a*t, and the curve is
        /// the straight line that says so.
        /// </summary>
        internal static AnimationCurve ForceRampCurve(float accel, float drag, float lifetime)
        {
            var curve = new AnimationCurve();
            const int Samples = 24;
            if (drag <= 0f)
            {
                curve.AddKey(0f, 0f);
                curve.AddKey(1f, accel * lifetime);
                return curve;
            }
            var terminal = accel / drag;
            for (var i = 0; i <= Samples; i++)
            {
                var u = i / (float)Samples;
                u *= u;
                curve.AddKey(u, terminal * (1f - Mathf.Exp(-drag * u * lifetime)));
            }
            for (var i = 0; i < curve.length; i++) curve.SmoothTangents(i, 0f);
            return curve;
        }

        /// <summary>
        /// A key that holds its value until the next one.
        ///
        /// Infinite tangents are how Unity spells "stepped". Without them the
        /// rate ramps between windows and particles trickle out during what is
        /// supposed to be silence.
        /// </summary>
        internal static void AddStep(AnimationCurve curve, float time, float value)
        {
            var key = new Keyframe(time, value, float.PositiveInfinity, float.PositiveInfinity);

            // ADDKEY SILENTLY DOES NOTHING WHEN A KEY ALREADY EXISTS AT THAT
            // TIME. It returns -1 and leaves the curve alone - no exception, no
            // warning - and that one line of Unity behaviour turned every
            // scheduled effect into a system that emitted nothing.
            //
            // The curve starts with a closing key at t=0, because a rate curve
            // has to be off before the first window opens. A clip that starts
            // at zero - which is most of them - then tries to OPEN at t=0 too,
            // that key is dropped, and what is left is a curve of nothing but
            // zeros. Rate over Time reads 70 with a flat line at 0, which looks
            // like the rate was imported and the emitter is broken, rather than
            // like the gate never opened.
            //
            // When two steps land on the same instant the LATER one is the
            // state from that instant onward, so it replaces rather than being
            // discarded.
            for (var i = 0; i < curve.length; i++)
            {
                if (!Mathf.Approximately(curve[i].time, time)) continue;
                curve.MoveKey(i, key);
                return;
            }
            curve.AddKey(key);
        }

        // ------------------------------------------------------------------
        // Initialize
        // ------------------------------------------------------------------
        private void ApplyInit(ParticleSystem ps, VfxJson block, string name)
        {
            var type = block["srcBlockType"].AsString();
            var main = ps.main;
            var shape = ps.shape;

            switch (type)
            {
                case "initialize.setLifetime":
                    main.startLifetime = Curve(block, "lifetime");
                    _report.Native(name, type);
                    return;

                case "initialize.setSize":
                    main.startSize = Curve(block, "size");
                    _report.Native(name, type);
                    return;

                case "initialize.setColor":
                    main.startColor = new ParticleSystem.MinMaxGradient(
                        VfxConvert.Colour(Binding(block, "color").Vector));
                    _report.Native(name, type);
                    return;

                case "initialize.setRotation":
                    // Radians in the IR, degrees in Unity.
                    var rotation = Curve(block, "rotation");
                    main.startRotation = Scale(rotation, Mathf.Rad2Deg);
                    _report.Native(name, type);
                    return;

                case "initialize.positionSphere":
                {
                    shape.enabled = true;
                    var surface = block["modes"]["fill"].AsString("volume") == "surface";
                    shape.shapeType = surface
                        ? ParticleSystemShapeType.SphereShell
                        : ParticleSystemShapeType.Sphere;
                    shape.radius = Mathf.Max(0.0001f, Binding(block, "radius").Constant);
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = VfxConvert.Euler(Binding(block, "rotation").Vector);
                    _report.Native(name, type, shape.shapeType.ToString());
                    return;
                }

                case "initialize.positionCone":
                {
                    shape.enabled = true;
                    shape.shapeType = ParticleSystemShapeType.ConeVolume;
                    shape.angle = Binding(block, "angle").Constant;
                    shape.radius = Mathf.Max(0.0001f, Binding(block, "radius").Constant);
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = ShapeRotation(block);
                    // The cone block carries its own speed, unlike the other
                    // shapes - it is an emitter and a velocity in one.
                    var speed = Curve(block, "speed");
                    if (speed.constant > 0f || speed.constantMax > 0f) main.startSpeed = speed;
                    _report.Native(name, type, "ConeVolume");
                    return;
                }

                case "initialize.positionBox":
                    shape.enabled = true;
                    shape.shapeType = ParticleSystemShapeType.Box;
                    shape.scale = VfxConvert.Vector(Binding(block, "size").Vector);
                    // A box's extent is not a direction: mirroring it would
                    // negate a size, so the magnitude is taken.
                    shape.scale = new Vector3(
                        Mathf.Abs(shape.scale.x), Mathf.Abs(shape.scale.y), Mathf.Abs(shape.scale.z));
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = VfxConvert.Euler(Binding(block, "rotation").Vector);
                    _report.Native(name, type);
                    return;

                case "initialize.positionCircle":
                {
                    shape.enabled = true;
                    shape.shapeType = ParticleSystemShapeType.Circle;
                    var circleRadius = Mathf.Max(0.0001f, Binding(block, "radius").Constant);
                    shape.radius = circleRadius;
                    // THE IR'S `thickness` IS A BAND WIDTH IN METRES, not a
                    // fraction. The kernel reads `inner = max(0, radius -
                    // thickness)` (shape.position.circle in kernels.js), so a
                    // radius of 2 with a thickness of 0.5 is a ring from 1.5 to
                    // 2. Unity's radiusThickness is the fraction of the radius
                    // the band covers, so the conversion is a DIVISION that was
                    // missing: Clamp01(0.5) called that same ring 1.0 to 2.0,
                    // twice as wide as authored, and Clamp01 quietly flattened
                    // every thickness above 1 - which is most of them, since a
                    // filled disc is spelled thickness == radius.
                    shape.radiusThickness = Mathf.Clamp01(
                        Binding(block, "thickness").Constant / circleRadius);
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = ShapeRotation(block);
                    _report.Native(name, type,
                        "ring " + (shape.radiusThickness >= 0.999f
                            ? "filled"
                            : $"{circleRadius * (1f - shape.radiusThickness):F2}-{circleRadius:F2}"));
                    return;
                }

                case "initialize.positionPoint":
                {
                    shape.enabled = true;
                    var jitter = Binding(block, "jitter").Constant;
                    shape.shapeType = ParticleSystemShapeType.Sphere;
                    shape.radius = Mathf.Max(0.0001f, jitter);
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    _report.Native(name, type, jitter > 0 ? "sphere of " + jitter.ToString("F3") : "point");
                    return;
                }

                case "initialize.positionMesh":
                {
                    shape.enabled = true;
                    shape.shapeType = block["modes"]["sampling"].AsString("surface") == "vertex"
                        ? ParticleSystemShapeType.Mesh
                        : ParticleSystemShapeType.Mesh;
                    shape.meshShapeType = block["modes"]["sampling"].AsString("surface") == "vertex"
                        ? ParticleSystemMeshShapeType.Vertex
                        : ParticleSystemMeshShapeType.Triangle;
                    var mesh = MeshFor(block, "mesh");
                    if (mesh != null) shape.mesh = mesh;
                    else _report.Dropped(name, type, "the bundle has no mesh for this slot");
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = VfxConvert.Euler(Binding(block, "rotation").Vector);
                    if (mesh != null) _report.Native(name, type, shape.meshShapeType.ToString());
                    return;
                }

                case "initialize.velocityRadial":
                    // Shuriken emits along the shape's normal, so a radial
                    // speed IS startSpeed. Exactly native.
                    main.startSpeed = Curve(block, "speed");
                    _report.Native(name, type);
                    return;

                case "initialize.velocityDirection":
                {
                    // Shuriken has no "fire along this arbitrary vector" on the
                    // start module; velocityOverLifetime in local space is the
                    // closest thing and applies continuously rather than once.
                    var velocity = ps.velocityOverLifetime;
                    velocity.enabled = true;
                    velocity.space = ParticleSystemSimulationSpace.Local;
                    var direction = VfxConvert.Vector(Binding(block, "direction").Vector).normalized;
                    var bound = Binding(block, "speed");
                    // RAW, NOT PRE-FADED. The decay used to be baked into these
                    // three curves, because Unity's drag was believed unable to
                    // touch an imposed velocity. It can: update.drag now writes
                    // velocityOverLifetime.speedModifier, which scales this
                    // velocity too - measured. Baking it here as well applied
                    // the same drag twice and left the stem at 5.4m when it had
                    // to reach the cap at 11.5m.
                    //
                    // THE RANGE SURVIVES, which it did not: Binding().Constant
                    // collapses a random to its midpoint, so a stem authored to
                    // rise at 9-15 m/s launched every particle at exactly 12 -
                    // one rigid column of identical speeds where the preview
                    // has a ragged one.
                    var lo = bound.IsRandom ? bound.Low : bound.Constant;
                    var hi = bound.IsRandom ? bound.High : bound.Constant;
                    velocity.x = Ranged(direction.x * lo, direction.x * hi);
                    velocity.y = Ranged(direction.y * lo, direction.y * hi);
                    velocity.z = Ranged(direction.z * lo, direction.z * hi);
                    _report.Approximated(name, type,
                        "became a velocity over life - imposed every frame rather than set once at "
                        + "birth, and this system's drag fades it through speedModifier; the "
                        + "spread is not carried");
                    return;
                }

                case "initialize.velocityRandom":
                {
                    var velocity = ps.velocityOverLifetime;
                    velocity.enabled = true;
                    velocity.space = ParticleSystemSimulationSpace.Local;
                    var lo = VfxConvert.Vector(Binding(block, "min").Vector);
                    var hi = VfxConvert.Vector(Binding(block, "max").Vector);
                    // Raw, like the directional case: update.drag's
                    // speedModifier is what fades these, and baking a decay in
                    // here as well would apply the same drag twice.
                    velocity.x = Ranged(lo.x, hi.x);
                    velocity.y = Ranged(lo.y, hi.y);
                    velocity.z = Ranged(lo.z, hi.z);
                    _report.Approximated(name, type,
                        "became a random velocity over life; it is drawn per particle but "
                        + "re-applied every frame rather than set once at birth, so gravity reads "
                        + "slightly differently");
                    return;
                }

                case "initialize.inheritVelocity":
                {
                    var inherit = ps.inheritVelocity;
                    inherit.enabled = true;
                    inherit.mode = ParticleSystemInheritVelocityMode.Initial;
                    inherit.curve = new ParticleSystem.MinMaxCurve(Binding(block, "scale").Constant);
                    _report.Native(name, type);
                    return;
                }

                case "initialize.setFlipbookFrame":
                    // Handled by the texture sheet module, which the output
                    // block configures. A random start frame is its own toggle.
                    _report.Native(name, type, "start frame randomised by the sheet module");
                    return;

                case "initialize.positionCurve":
                {
                    // Shuriken has no spline shape - the full list is Sphere,
                    // Cone, Box, Circle, Donut, Mesh and their shells, and none
                    // of them bends. The straight chord through the end points
                    // is the closest honest stand-in, and saying so matters:
                    // for an effect whose whole shape IS the curve, baking a
                    // sprite sheet carries it across where this cannot.
                    shape.enabled = true;
                    shape.shapeType = ParticleSystemShapeType.Box;
                    // The path is block data, not bindings - `points` in the IR
                    // - and it is any length, so the chord runs from the first
                    // point to the last.
                    var path = block["points"];
                    var from = VfxConvert.Vector(path[0]);
                    var to = VfxConvert.Vector(path[Math.Max(0, path.Count - 1)]);
                    var girth = Mathf.Max(0.001f, Binding(block, "thickness").Constant);
                    shape.position = (from + to) * 0.5f;
                    shape.scale = new Vector3((to - from).magnitude, girth, girth);
                    var chord = (to - from).normalized;
                    if (chord.sqrMagnitude > 0f)
                    {
                        shape.rotation = Quaternion.FromToRotation(Vector3.right, chord).eulerAngles;
                    }
                    _report.Approximated(name, type,
                        "Shuriken has no spline emitter; the curve became the straight chord "
                        + "between its end points, so the bend is lost. Bake a sprite sheet if "
                        + "the shape of the path is the point of the effect");
                    return;
                }

                case "initialize.positionLine":
                    _report.Approximated(name, type,
                        "Shuriken has no line emitter; became a thin box along the segment");
                    shape.enabled = true;
                    shape.shapeType = ParticleSystemShapeType.Box;
                    var start = VfxConvert.Vector(Binding(block, "start").Vector);
                    var end = VfxConvert.Vector(Binding(block, "end").Vector);
                    var thickness = Mathf.Max(0.001f, Binding(block, "thickness").Constant);
                    shape.position = (start + end) * 0.5f;
                    shape.scale = new Vector3((end - start).magnitude, thickness, thickness);
                    // Aim the box's long axis down the segment.
                    var along = (end - start).normalized;
                    if (along.sqrMagnitude > 0f)
                    {
                        shape.rotation = Quaternion.FromToRotation(Vector3.right, along).eulerAngles;
                    }
                    return;

                default:
                    _report.Dropped(name, type, "no Shuriken equivalent in this importer");
                    return;
            }
        }

        /// <summary>
        /// A shape's rotation, with Unity's own default orientation corrected.
        ///
        /// THE TWO ENGINES POINT THEIR SHAPES DIFFERENT WAYS, and nothing in
        /// the IR says so because within the app there is nothing to say.
        ///
        ///   - The app's Circle lies in the XZ plane, normal +Y: a ring ON THE
        ///     GROUND. kernels.js says so outright - "XZ rather than XY because
        ///     Y is up everywhere else in this runtime" - and its Rotation of
        ///     (90,0,0) is documented as the way to stand one up against a wall.
        ///   - The app's Cone sprays up +Y from a mouth in XZ.
        ///   - UNITY'S Circle lies in XY and its Cone fires along +Z. Both are
        ///     the shape's local forward, which is how every Shuriken emitter
        ///     is built.
        ///
        /// So an IR rotation of zero - by far the most common case - was
        /// imported as a ring standing VERTICALLY. On this nuclear blast that
        /// silently broke three systems at once: the shockwave expanded in a
        /// vertical disc instead of racing outward along the ground, the ground
        /// dust rose in a wall instead of spreading into a skirt, and the stem
        /// was emitted from a vertical slot. Measured: the shockwave's
        /// particles were climbing to y=2.4 with no horizontal spread at all.
        ///
        /// Nothing LOOKED broken - there were particles, they moved, the
        /// colours were right - which is exactly the "nearly right" failure the
        /// report is built to prevent, and it was invisible to it because the
        /// block imported natively.
        ///
        /// -90 about X takes Unity's +Z forward onto +Y. The IR's own rotation
        /// composes on the OUTSIDE, because it is expressed in the app's frame
        /// and so applies after the frames have been reconciled.
        /// </summary>
        private Vector3 ShapeRotation(VfxJson block)
        {
            var authored = Quaternion.Euler(VfxConvert.Euler(Binding(block, "rotation").Vector));
            return (authored * Quaternion.Euler(-90f, 0f, 0f)).eulerAngles;
        }

        // ------------------------------------------------------------------
        // Update
        // ------------------------------------------------------------------
        private void ApplyUpdate(ParticleSystem ps, VfxJson block, string name)
        {
            var type = block["srcBlockType"].AsString();
            var main = ps.main;

            switch (type)
            {
                case "update.gravity":
                {
                    var gravity = VfxConvert.Vector(Binding(block, "gravity").Vector);
                    // Unity's gravityModifier is a MULTIPLE of Physics.gravity,
                    // which points down. A purely vertical IR gravity maps to it
                    // exactly - including a NEGATIVE multiplier for buoyancy,
                    // which is how the fire presets rise.
                    if (Mathf.Abs(gravity.x) < 1e-4f && Mathf.Abs(gravity.z) < 1e-4f)
                    {
                        main.gravityModifier = new ParticleSystem.MinMaxCurve(
                            gravity.y / Physics.gravity.y);
                        _report.Native(name, type, "gravityModifier " + (gravity.y / Physics.gravity.y).ToString("F2"));
                    }
                    else
                    {
                        var force = ps.forceOverLifetime;
                        force.enabled = true;
                        force.space = ParticleSystemSimulationSpace.World;
                        force.x = new ParticleSystem.MinMaxCurve(gravity.x);
                        force.y = new ParticleSystem.MinMaxCurve(gravity.y);
                        force.z = new ParticleSystem.MinMaxCurve(gravity.z);
                        _report.Native(name, type, "force over lifetime (not axis-aligned)");
                    }
                    return;
                }

                case "update.drag":
                {
                    // NOT limitVelocityOverLifetime.drag, which is the obvious
                    // field and cannot express this. MEASURED, with a one
                    // particle probe at a known speed and coefficient:
                    //
                    //   multiplyDragByParticleVelocity ON  -> 1/v is linear in
                    //     t, i.e. dv/dt = -k*v^2. QUADRATIC.
                    //   multiplyDragByParticleVelocity OFF -> v falls by k m/s
                    //     every second. CONSTANT deceleration.
                    //
                    // The app's is `accel -= velocity * k` (kernels.js
                    // 'force.drag') - dv/dt = -k*v, LINEAR - and Shuriken's
                    // drag has no setting for it. The error is not subtle: a
                    // shockwave at 25 m/s with k=7 should travel 3.6m, the
                    // quadratic setting moved it 0.01m and the constant one
                    // 35.9m. One stopped dead, the other never stopped.
                    //
                    // speedModifier IS linear drag, because it is not a force
                    // at all - it multiplies the particle's speed by a curve,
                    // so a curve of exp(-k*t) integrates to exactly the
                    // trajectory the preview produces. Measured against the
                    // analytic distance it lands within a few percent, and it
                    // scales an IMPOSED velocityOverLifetime too - which is the
                    // property that lets one mechanism serve radial starts,
                    // directional starts and vortices alike.
                    var vol = ps.velocityOverLifetime;
                    vol.enabled = true;
                    vol.speedModifier = new ParticleSystem.MinMaxCurve(
                        1f, DragDecayCurve(Binding(block, "drag").Constant, _systemLifetime));
                    _report.Native(name, type, "velocityOverLifetime.speedModifier (linear drag)");
                    return;
                }

                case "update.turbulence":
                {
                    var noise = ps.noise;
                    noise.enabled = true;
                    noise.strength = new ParticleSystem.MinMaxCurve(Binding(block, "strength").Constant);
                    noise.frequency = Mathf.Max(0.0001f, Binding(block, "frequency").Constant);
                    noise.quality = ParticleSystemNoiseQuality.Medium;
                    noise.damping = false;
                    _report.Approximated(name, type,
                        "became the noise module: Unity's noise is value noise, not the "
                        + "divergence-free curl noise the preview uses, so the motion differs in "
                        + "character even at the same strength");
                    return;
                }

                case "update.sizeOverLife":
                {
                    var size = ps.sizeOverLifetime;
                    size.enabled = true;
                    size.size = Curve(block, "scale");
                    _report.Native(name, type);
                    return;
                }

                case "update.colorOverLife":
                {
                    var colour = ps.colorOverLifetime;
                    colour.enabled = true;
                    colour.color = GradientBinding(block, "color", name);
                    _report.Native(name, type);
                    return;
                }

                case "update.spin":
                {
                    var rotation = ps.rotationOverLifetime;
                    rotation.enabled = true;
                    rotation.z = Scale(Curve(block, "speed"), Mathf.Rad2Deg);
                    _report.Native(name, type);
                    return;
                }

                case "update.speedLimit":
                {
                    var limit = ps.limitVelocityOverLifetime;
                    limit.enabled = true;
                    limit.limit = new ParticleSystem.MinMaxCurve(Binding(block, "speed").Constant);
                    // Fully dampened, which is what a hard speed cap means: the
                    // app's kernel clamps the magnitude outright rather than
                    // easing towards the cap. Without this the limit is stored
                    // and ignored - see update.drag.
                    limit.dampen = 1f;
                    _report.Native(name, type);
                    return;
                }

                case "update.vortex":
                {
                    // SHURIKEN'S ORBITAL VELOCITY PINS THE RADIUS, and that one
                    // fact decides this whole mapping. It is not a force, it is
                    // a rigid rotation: whatever the particle's radius is when
                    // the orbit takes hold, that is the radius it keeps.
                    // Measured on the mushroom cap, whose vortex exists to push
                    // particles OUT - every orbital rate tried froze the mean
                    // radius (4.5 -> 1.4, 2.25 -> 1.9) while the preview's grew
                    // from 1.2 to 3.4, and the cap stayed a ball instead of
                    // flattening into a cap. Switching the orbit off and
                    // letting the radial channel work reproduced the growth.
                    //
                    // THE PREVIEW'S VORTEX IS TWO FORCES (kernels.js
                    // 'force.vortex'): a tangential acceleration proportional
                    // to radius, and a constant radial one of `inward`. With
                    // drag k the radial one settles at a terminal speed of
                    // inward/k, reached as v(t) = (a/k)(1 - e^-kt) - so the
                    // radial channel gets that curve rather than a constant,
                    // which is also what stops the cloud jumping outward at
                    // birth.
                    var velocity = ps.velocityOverLifetime;
                    velocity.enabled = true;
                    var axis = VfxConvert.Vector(Binding(block, "axis").Vector).normalized;
                    var strength = Binding(block, "strength").Constant;
                    var centre = VfxConvert.Vector(Binding(block, "position").Vector);
                    var inward = Binding(block, "inward").Constant;

                    velocity.orbitalOffsetX = new ParticleSystem.MinMaxCurve(centre.x);
                    velocity.orbitalOffsetY = new ParticleSystem.MinMaxCurve(centre.y);
                    velocity.orbitalOffsetZ = new ParticleSystem.MinMaxCurve(centre.z);
                    velocity.radial = new ParticleSystem.MinMaxCurve(
                        1f, ForceRampCurve(-inward, _systemDrag, _systemLifetime));

                    // WHICH WAY THE VORTEX PUSHES DECIDES WHETHER THE SWIRL
                    // SURVIVES, because Unity cannot have both the swirl and
                    // the spread.
                    //
                    //   inward > 0 - the author is PULLING particles in, so a
                    //     rotation that holds them at a radius is close to what
                    //     they asked for. The swirl is the point; keep it.
                    //   inward <= 0 - the author is pushing them OUT, and an
                    //     orbit would cancel exactly the motion the block was
                    //     placed for. The spread is the point; drop the orbit.
                    if (inward > 0f)
                    {
                        // strength/drag, not strength: the preview's tangential
                        // term is an ACCELERATION proportional to radius, so
                        // with drag it settles at an angular rate of
                        // strength/drag. Feeding the raw strength in as an
                        // angular rate spins the effect far too fast.
                        var rate = _systemDrag > 0f ? strength / _systemDrag : strength;
                        velocity.orbitalX = new ParticleSystem.MinMaxCurve(axis.x * rate);
                        velocity.orbitalY = new ParticleSystem.MinMaxCurve(axis.y * rate);
                        velocity.orbitalZ = new ParticleSystem.MinMaxCurve(axis.z * rate);
                        _report.Approximated(name, type,
                            $"became orbital velocity at {rate:F2} rad/s (the preview's tangential "
                            + "force divided by this system's drag, which is the rate it settles "
                            + "at) plus an inward radial velocity. Unity's orbit is a rigid "
                            + "rotation, so particles hold their radius instead of spiralling");
                    }
                    else
                    {
                        _report.Approximated(name, type,
                            "became an outward radial velocity, and the swirl is NOT carried. "
                            + "Shuriken has no force-based vortex: orbital velocity is a rigid "
                            + "rotation that PINS each particle's radius, and a "
                            + "ParticleSystemForceField pulls them inward instead - both were "
                            + "measured, and both cancel the outward push this block exists to "
                            + "apply. What is left is the radial force alone, so the cloud still "
                            + "widens but reaches roughly HALF the preview's radius: the preview "
                            + "spreads because the tangential force keeps feeding a spiral, and "
                            + "an imposed velocity cannot, since this system's drag damps it. "
                            + "Lower this system's drag on the imported prefab to widen it");
                    }
                    return;
                }

                case "update.collidePlane":
                {
                    var collision = ps.collision;
                    collision.enabled = true;
                    collision.type = ParticleSystemCollisionType.Planes;
                    collision.bounce = new ParticleSystem.MinMaxCurve(Binding(block, "bounce").Constant);
                    collision.dampen = new ParticleSystem.MinMaxCurve(Binding(block, "friction").Constant);
                    // The plane itself is a Transform reference Shuriken cannot
                    // invent, so the importer makes one at the IR's height.
                    var height = Binding(block, "height").Constant;
                    var plane = new GameObject("CollisionPlane");
                    plane.transform.SetParent(ps.transform, false);
                    plane.transform.localPosition = new Vector3(0f, height, 0f);
                    collision.SetPlane(0, plane.transform);
                    _report.Native(name, type, "plane at y=" + height.ToString("F2"));
                    return;
                }

                case "update.collideSphere":
                case "update.collideBox":
                    _report.Approximated(name, type,
                        "Shuriken collides with scene colliders or planes, not with an implicit "
                        + "shape; enable World collision and put a collider there");
                    return;

                case "update.attractor":
                    _report.Dropped(name, type,
                        "no Shuriken module attracts toward a point; a Particle Force Field "
                        + "component or a custom script is the closest option");
                    return;

                case "update.killOnBounds":
                {
                    // THE TRIGGER MODULE IS AN EXACT MATCH, which the previous
                    // "Shuriken kills on lifetime only" gave up on too early.
                    // `outside = Kill` against a box collider is precisely the
                    // kernel in src/utils/vfx/kernels.js ('kill.bounds'): a box
                    // centred on the system's origin with half-extents of
                    // size/2, killing anything past it.
                    //
                    // It is worth the collider. Dropping this on the nuclear
                    // blast let its debris keep flying: the preview culls a
                    // chip once it passes 8m, Unity's kept going to 25m, and
                    // the effect grew a halo of specks streaking off into the
                    // distance long after the blast was over. It also blew up
                    // the effect's bounds, which is what every auto-framing
                    // camera and culling volume reads.
                    var size = VfxConvert.Vector(Binding(block, "size").Vector);
                    size = new Vector3(
                        Mathf.Max(0.01f, Mathf.Abs(size.x)),
                        Mathf.Max(0.01f, Mathf.Abs(size.y)),
                        Mathf.Max(0.01f, Mathf.Abs(size.z)));

                    var box = new GameObject("KillBounds");
                    box.transform.SetParent(ps.transform, false);
                    var collider = box.AddComponent<BoxCollider>();
                    collider.size = size;
                    // A TRIGGER, not a solid. The particle trigger module reads
                    // the volume either way, but a solid box of this size
                    // dropped into the user's scene would block their character
                    // controller - a side effect of importing a VFX that nobody
                    // would connect to the import.
                    collider.isTrigger = true;

                    var trigger = ps.trigger;
                    trigger.enabled = true;
                    trigger.SetCollider(0, collider);
                    trigger.outside = ParticleSystemOverlapAction.Kill;
                    trigger.inside = ParticleSystemOverlapAction.Ignore;
                    trigger.enter = ParticleSystemOverlapAction.Ignore;
                    trigger.exit = ParticleSystemOverlapAction.Ignore;
                    _report.Native(name, type,
                        $"trigger module, killing outside a {size.x:F0}x{size.y:F0}x{size.z:F0} box");
                    return;
                }

                case "update.flipbook":
                    // Configured by the output's tile counts; this block only
                    // says how to play it.
                    _report.Native(name, type, "played by the texture sheet module");
                    return;

                default:
                    _report.Dropped(name, type, "no Shuriken equivalent in this importer");
                    return;
            }
        }

        // ------------------------------------------------------------------
        // Output: renderer, material, flipbook
        // ------------------------------------------------------------------
        private void ApplyOutput(ParticleSystem ps, VfxJson output, string name)
        {
            var renderer = ps.GetComponent<ParticleSystemRenderer>();
            var mode = output["mode"].AsString("billboard");

            switch (mode)
            {
                case "stretched":
                    renderer.renderMode = ParticleSystemRenderMode.Stretch;
                    renderer.lengthScale = 2f;
                    renderer.velocityScale = 0.1f;
                    _report.Native(name, "output.mode", "Stretch");
                    break;
                case "mesh":
                    renderer.renderMode = ParticleSystemRenderMode.Mesh;
                    _report.Native(name, "output.mode", "Mesh");
                    break;
                case "point":
                    // Unity has no point mode; the app's own point mode is a
                    // unit quad too, so a small billboard is the same thing.
                    renderer.renderMode = ParticleSystemRenderMode.Billboard;
                    _report.Approximated(name, "output.mode", "point became a small billboard");
                    break;
                case "trail":
                    renderer.renderMode = ParticleSystemRenderMode.Stretch;
                    _report.Approximated(name, "output.mode",
                        "trail became a stretched billboard, which is what the app's preview does too");
                    break;
                default:
                    renderer.renderMode = ParticleSystemRenderMode.Billboard;
                    _report.Native(name, "output.mode", "Billboard");
                    break;
            }

            var sort = output["sort"].AsString("none");
            renderer.sortMode = sort == "depth"
                ? ParticleSystemSortMode.Distance
                : ParticleSystemSortMode.None;

            // THE TEXTURE IS RESOLVED BEFORE THE MATERIAL, and that ordering is
            // the fix for two separate bugs.
            //
            // One: the material cache is keyed on the blend mode AND the
            // texture. It used to be keyed on the blend alone, and the texture
            // was then written onto whatever material came back - so two
            // systems sharing a blend but not a texture fought over one
            // material and the last one imported won.
            //
            // Two: a system with NO texture block at all never reached the
            // assignment, so its material kept a null _BaseMap - and URP's
            // particle shader samples that as WHITE, drawing a full opaque
            // quad. On an additive blend that is a solid bright square, which
            // is what a nuclear blast's flash, fireball and shockwave all
            // became. See VfxBuiltins: the app has never drawn an untextured
            // particle, and neither should this.
            VfxJson textureBlock = null;
            VfxJson meshBlock = null;
            foreach (var block in output["blocks"].Items)
            {
                var type = block["srcBlockType"].AsString();
                if (type == "output.setMainTexture") textureBlock = block;
                else if (type == "output.setMesh") meshBlock = block;
            }

            var texture = textureBlock == null ? null : TextureFor(textureBlock, "texture");
            var textureIsAuthored = texture != null;
            if (texture == null) texture = _defaultSprite?.Invoke();

            var blend = output["blend"].AsString("additive");
            var material = _material?.Invoke(blend, texture);
            if (material != null)
            {
                renderer.sharedMaterial = material;
                _report.Native(name, "output.blend", blend + " -> " + material.shader.name);
            }
            else
            {
                _report.Dropped(name, "output.blend", "no particle shader found for " + blend);
            }

            if (textureIsAuthored)
            {
                _report.Native(name, "output.setMainTexture", texture.name);
            }
            else if (texture != null)
            {
                // NATIVE, not approximated: drawing an untextured particle with
                // a built-in soft blob is what the app itself does - see the
                // header of src/utils/vfx/assets.js, where it is a deliberate
                // product decision rather than a fallback. Matching it IS
                // fidelity; a hard quad is the divergence.
                _report.Native(name,
                    textureBlock == null ? "output.texture" : "output.setMainTexture",
                    textureBlock == null
                        ? "no texture set, so the built-in soft sprite is used - the same "
                          + "stand-in the app's preview draws"
                        : "the bundle has no texture for this slot, so the built-in soft sprite "
                          + "is used - the same stand-in the app's preview draws");
            }

            if (mode == "mesh")
            {
                // A MESH RENDERER WITH NO MESH DRAWS UNITY'S FALLBACK QUAD, not
                // nothing, so this slot can never be left empty. It used to
                // switch the renderer off instead, which made the system vanish
                // outright - a nuclear blast imported with its entire debris
                // burst missing, and "not drawn" in a report nobody reads at
                // that point.
                //
                // The app resolves the same gap with a built-in tetrahedron
                // (getDefaultParticleMesh), for the same reason it has a
                // built-in sprite, so using one here matches the preview rather
                // than inventing a third behaviour.
                var mesh = meshBlock == null ? null : MeshFor(meshBlock, "mesh");
                if (mesh != null)
                {
                    renderer.mesh = mesh;
                    _report.Native(name, "output.setMesh", mesh.name);
                }
                else
                {
                    var fallback = _defaultMesh?.Invoke();
                    if (fallback != null)
                    {
                        renderer.mesh = fallback;
                        _report.Approximated(name, "output.setMesh",
                            "the bundle has no mesh for this slot, so the built-in tetrahedron is "
                            + "used - the same stand-in the app's preview draws. Assign the real "
                            + "model on this system's renderer to replace it. (Unity has no glTF "
                            + "importer; add com.unity.cloud.gltfast or export the mesh as FBX.)");
                    }
                    else
                    {
                        renderer.enabled = false;
                        _report.Dropped(name, "output.setMesh",
                            "the bundle has no mesh for this slot and no stand-in was available, "
                            + "so this system is not drawn");
                    }
                }
            }

            var tiles = output["tiles"].AsFloats();
            if (tiles.Length >= 2 && (tiles[0] > 1f || tiles[1] > 1f))
            {
                var sheet = ps.textureSheetAnimation;
                sheet.enabled = true;
                sheet.numTilesX = Mathf.Max(1, (int)tiles[0]);
                sheet.numTilesY = Mathf.Max(1, (int)tiles[1]);
                sheet.animation = ParticleSystemAnimationType.WholeSheet;
                sheet.timeMode = ParticleSystemAnimationTimeMode.Lifetime;
                _report.Native(name, "output.flipbook", $"{sheet.numTilesX}x{sheet.numTilesY}");
            }
        }

        // ------------------------------------------------------------------
        // Sub-emitters
        // ------------------------------------------------------------------
        private void WireEvents(Dictionary<string, ParticleSystem> byId)
        {
            // THE IR DOES NOT HANG LISTENERS OFF THE CHANNEL. `ir.eventChannels`
            // is a flat list of {sourceSystemId, trigger} - one entry per
            // (source, trigger) pair - and every listening SYSTEM carries
            // `listen: {channel, trigger, probability}` whose `channel` indexes
            // that list. Reading channel["listeners"] found a key that has
            // never existed, so the loop body never ran and NOT ONE sub-emitter
            // was wired. Every impact system then kept only the timeline burst
            // the spawn pass gave it, which fires once at t=0 at the effect
            // origin - "one impact at the centre and no others", with the
            // import report showing no sub-emitter lines to say so.
            var channels = new List<VfxJson>(_ir["eventChannels"].Items);

            foreach (var system in _ir["systems"].Items)
            {
                if (!system.Has("listen")) continue;
                var listen = system["listen"];

                var index = listen["channel"].AsInt(-1);
                if (index < 0 || index >= channels.Count) continue;
                var channel = channels[index];

                if (!byId.TryGetValue(channel["sourceSystemId"].AsString(), out var source)) continue;
                if (!byId.TryGetValue(system["id"].AsString(), out var child)) continue;

                // The trigger keeps the DOCUMENT'S spelling - onPlay, onDeath,
                // onCollide. Comparing against "death" matched nothing, so even
                // a correctly found listener would have been wired as a Birth
                // sub-emitter and fired at the wrong moment.
                var trigger = listen["trigger"].AsString(channel["trigger"].AsString());
                var type = trigger == "onDeath"
                    ? ParticleSystemSubEmitterType.Death
                    : trigger == "onCollide"
                        ? ParticleSystemSubEmitterType.Collision
                        : ParticleSystemSubEmitterType.Birth;

                // Unity drives a sub-emitter from its parent and requires it to
                // be a child of the system that spawns it; built flat under the
                // root, they are siblings. The local transform is identity on
                // both, so re-parenting moves nothing.
                child.transform.SetParent(source.transform, false);

                // DO NOT touch playOnAwake here. Unity already clears it on a
                // system it accepts as a sub-emitter, and once the child is
                // parented the property is hierarchy-wide: writing it on the
                // child lands on the ROOT of the particle hierarchy, which is
                // the source system - so an explicit `false` here switched
                // Meteors itself off and the effect played nothing at all.
                // The child's emission BURSTS stay untouched either way: that
                // burst is what Unity emits when the trigger fires, so clearing
                // it would spawn nothing per impact.
                var subs = source.subEmitters;
                subs.enabled = true;
                subs.AddSubEmitter(child, type, ParticleSystemSubEmitterProperties.InheritNothing);
                var probability = Mathf.Clamp01(listen["probability"].AsFloat(1f));
                if (probability < 1f)
                {
                    subs.SetSubEmitterEmitProbability(subs.subEmittersCount - 1, probability);
                }
                _report.Native(source.name, "sub-emitter",
                    $"{trigger} -> {child.name}"
                    + (probability < 1f ? $" at {probability:P0} of events" : ""));
            }
        }

        // ------------------------------------------------------------------
        // Bindings
        // ------------------------------------------------------------------
        private struct Bound
        {
            public float Constant;
            public float Low;
            public float High;
            public bool IsRandom;
            public float[] Vector;
            public VfxJson Curve;
            public VfxJson Gradient;
            public float Scale;
        }

        /// <summary>
        /// Read one binding into something Unity can take.
        ///
        /// The IR's binding is polymorphic on `src`. A CONST resolves through
        /// `ir.constants`, a RANDOM through two of them, and a CURVE or
        /// GRADIENT through `ir.tables[index].authored` - which is the only
        /// route from a binding to the authored keys, and is why the exporter
        /// carries them on the table.
        ///
        /// A UNIFORM or REGISTER binding has no static value at all: it is a
        /// blackboard property or a wired operator chain, and there is nothing
        /// to write into a Shuriken module. Those come back as zero and the
        /// caller reports them.
        /// </summary>
        private Bound Binding(VfxJson block, string prop)
        {
            var bound = new Bound { Scale = 1f, Vector = new float[3] };
            foreach (var binding in block["bindings"].Items)
            {
                if (binding["prop"].AsString() != prop) continue;

                var width = Mathf.Max(1, binding["width"].AsInt(1));
                switch (binding["src"].AsString())
                {
                    case "const":
                    {
                        var at = binding["index"].AsInt(0);
                        bound.Constant = ConstantAt(at);
                        bound.Vector = ConstantsAt(at, width);
                        return bound;
                    }
                    case "random":
                    {
                        var lo = binding["loIndex"].AsInt(0);
                        var hi = binding["hiIndex"].AsInt(0);
                        bound.IsRandom = true;
                        bound.Low = ConstantAt(lo);
                        bound.High = ConstantAt(hi);
                        bound.Constant = (bound.Low + bound.High) * 0.5f;
                        bound.Vector = ConstantsAt(lo, width);
                        return bound;
                    }
                    case "curve":
                        bound.Curve = _ir["tables"][binding["index"].AsInt(0)]["authored"];
                        bound.Scale = binding["scale"].AsFloat(1f);
                        return bound;
                    case "gradient":
                        bound.Gradient = _ir["tables"][binding["index"].AsInt(0)]["authored"];
                        return bound;
                    default:
                        return bound;
                }
            }
            return bound;
        }

        private float ConstantAt(int index)
        {
            var constants = _ir["constants"];
            return index >= 0 && index < constants.Count ? constants[index].AsFloat() : 0f;
        }

        private float[] ConstantsAt(int index, int width)
        {
            var result = new float[Mathf.Max(3, width)];
            for (var i = 0; i < width; i++) result[i] = ConstantAt(index + i);
            return result;
        }

        /// <summary>A binding as a MinMaxCurve, whichever mode it is in.</summary>
        private ParticleSystem.MinMaxCurve Curve(VfxJson block, string prop)
        {
            var bound = Binding(block, prop);
            if (!bound.Curve.IsNull())
            {
                return new ParticleSystem.MinMaxCurve(bound.Scale, VfxConvert.Curve(bound.Curve));
            }
            if (bound.IsRandom)
            {
                return new ParticleSystem.MinMaxCurve(
                    Mathf.Min(bound.Low, bound.High), Mathf.Max(bound.Low, bound.High));
            }
            return new ParticleSystem.MinMaxCurve(bound.Constant);
        }

        private ParticleSystem.MinMaxGradient GradientBinding(VfxJson block, string prop, string name)
        {
            var bound = Binding(block, prop);
            if (!bound.Gradient.IsNull())
            {
                var gradient = VfxConvert.GradientFrom(bound.Gradient, out var peak);
                if (peak > 1.01f)
                {
                    // NOT A LOSS, which is what this used to claim. Unity's
                    // Gradient keys are float Colors and a saved prefab really
                    // does carry `key0: {r: 3, ...}` - verified in a written
                    // prefab, not assumed - so the intensity survives the fold
                    // intact and there is nothing to route through emission.
                    //
                    // What does NOT survive is the TONEMAPPER. The app renders
                    // through ACES Filmic (see the header of VfxViewport.jsx,
                    // where it is deliberate), so a 16x core rolls off into a
                    // soft white bloom. URP tonemaps only when a Volume says
                    // to, and the default profile ships with Tonemapping set to
                    // None - so the same 16x core CLIPS to a flat white slab.
                    // Reported as native with the scene requirement attached,
                    // because the fidelity gap is in the scene, not the import.
                    _report.Native(name, "gradient HDR",
                        $"a key at {peak:F1}x intensity was carried across intact");
                    // NO PEAK VALUE IN THIS STRING, deliberately: the list
                    // deduplicates on the text, and a six-system effect whose
                    // gradients peak at 16x, 9x, 5x, 3x, 2.3x and 2x wrote the
                    // same paragraph six times over. Which system is how hot is
                    // already on its own Native line above; the requirement is
                    // one thing to go and switch on, so it is said once.
                    _report.SceneRequirement(
                        "TONE MAPPING. This effect authors colour above 1.0. The app previews "
                        + "through ACES Filmic, which rolls a hot core off into a soft glow; URP "
                        + "tone maps only when a Volume says to, and the default profile ships "
                        + "with Tonemapping set to None - so the same core clips to a flat white "
                        + "slab. Set Tonemapping to ACES on a Volume covering the effect (or on "
                        + "the project's default volume profile) and tick HDR on the camera and "
                        + "the URP asset.");
                }
                var dropped = VfxConvert.GradientKeysDropped(bound.Gradient);
                if (dropped > 0)
                {
                    _report.Approximated(name, "gradient keys",
                        $"{dropped} key(s) past Unity's limit of 8 per rail were dropped");
                }
                return new ParticleSystem.MinMaxGradient(gradient);
            }
            return new ParticleSystem.MinMaxGradient(VfxConvert.Colour(bound.Vector));
        }

        private static ParticleSystem.MinMaxCurve Scale(ParticleSystem.MinMaxCurve curve, float factor)
        {
            switch (curve.mode)
            {
                case ParticleSystemCurveMode.Constant:
                    return new ParticleSystem.MinMaxCurve(curve.constant * factor);
                case ParticleSystemCurveMode.TwoConstants:
                    return new ParticleSystem.MinMaxCurve(curve.constantMin * factor, curve.constantMax * factor);
                case ParticleSystemCurveMode.Curve:
                    return new ParticleSystem.MinMaxCurve(curve.curveMultiplier * factor, curve.curve);
                default:
                    return curve;
            }
        }

        private Texture2D TextureFor(VfxJson block, string prop)
        {
            var slot = block["assetSlots"][prop].AsInt(-1);
            if (slot < 0) return null;
            var asset = _ir["assets"][slot];
            return asset.IsNull ? null : _texture?.Invoke(asset["assetId"].AsInt(-1));
        }

        private Mesh MeshFor(VfxJson block, string prop)
        {
            var slot = block["assetSlots"][prop].AsInt(-1);
            if (slot < 0) return null;
            var asset = _ir["assets"][slot];
            return asset.IsNull ? null : _mesh?.Invoke(asset["assetId"].AsInt(-1));
        }
    }

    internal static class VfxJsonExtensions
    {
        /// <summary>
        /// A null check that reads the right way round at the call site.
        /// `bound.Curve` is a VfxJson that may be the Null singleton, and
        /// `!bound.Curve.IsNull()` says what it means where `bound.Curve !=
        /// null` would be true for the singleton and wrong.
        /// </summary>
        public static bool IsNull(this VfxJson value) => value == null || value.IsNull;
    }
}
