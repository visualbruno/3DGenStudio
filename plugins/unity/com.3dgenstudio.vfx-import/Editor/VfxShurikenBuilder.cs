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
        private float _systemDrag;
        private float _systemLifetime = 1f;
        private readonly Func<int, Texture2D> _texture;
        private readonly Func<int, Mesh> _mesh;
        private readonly Func<string, Material> _material;

        public VfxShurikenBuilder(
            VfxJson ir,
            VfxImportReport report,
            Func<int, Texture2D> textureForAsset,
            Func<int, Mesh> meshForAsset,
            Func<string, Material> materialForBlend)
        {
            _ir = ir;
            _report = report;
            _texture = textureForAsset;
            _mesh = meshForAsset;
            _material = materialForBlend;
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

            // PRE-SCANNED, because an Initialize block needs to know what the
            // Update stage does. Specifically: a start velocity has to be told
            // how fast drag will bleed it away, and drag lives in a block that
            // has not been visited yet when the velocity block is converted.
            _systemDrag = 0f;
            _systemLifetime = 1f;
            foreach (var block in system["update"].Items)
            {
                if (block["srcBlockType"].AsString() == "update.drag")
                {
                    _systemDrag = Mathf.Max(0f, Binding(block, "drag").Constant);
                }
            }
            foreach (var block in system["init"].Items)
            {
                if (block["srcBlockType"].AsString() == "initialize.setLifetime")
                {
                    var life = Binding(block, "lifetime");
                    _systemLifetime = Mathf.Max(0.01f, life.IsRandom ? life.High : life.Constant);
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
        /// A random-between-two velocity that decays with the system's drag.
        ///
        /// Unity's two-CONSTANT mode draws once per particle and then holds the
        /// value forever; two CURVES draw once per particle and then follow the
        /// shape. Same randomness, and it actually slows down.
        /// </summary>
        private ParticleSystem.MinMaxCurve RangedDecay(float lo, float hi)
        {
            var low = Mathf.Min(lo, hi);
            var high = Mathf.Max(lo, hi);
            var shape = DragDecayCurve(_systemDrag, _systemLifetime);
            var lowCurve = new AnimationCurve();
            var highCurve = new AnimationCurve();
            foreach (var key in shape.keys)
            {
                lowCurve.AddKey(key.time, key.value * low);
                highCurve.AddKey(key.time, key.value * high);
            }
            // Multiplier 1: the curves already carry the magnitudes, and a
            // multiplier of zero - which a symmetric range would produce if it
            // were derived from the ends - would silently zero the velocity.
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
            const int Samples = 12;
            for (var i = 0; i <= Samples; i++)
            {
                var u = i / (float)Samples;
                curve.AddKey(u, Mathf.Exp(-drag * u * lifetime));
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
                    shape.rotation = VfxConvert.Euler(Binding(block, "rotation").Vector);
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
                    shape.enabled = true;
                    shape.shapeType = ParticleSystemShapeType.Circle;
                    shape.radius = Mathf.Max(0.0001f, Binding(block, "radius").Constant);
                    // The IR's `thickness` is 1 for a filled disc and 0 for a
                    // rim; Unity's radiusThickness is the same convention.
                    shape.radiusThickness = Mathf.Clamp01(Binding(block, "thickness").Constant);
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = VfxConvert.Euler(Binding(block, "rotation").Vector);
                    _report.Native(name, type);
                    return;

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
                    var speed = Binding(block, "speed").Constant;
                    // FADED BY THE SYSTEM'S OWN DRAG rather than held constant -
                    // see DragDecayCurve for what a constant one did to a
                    // mushroom cloud.
                    var decay = DragDecayCurve(_systemDrag, _systemLifetime);
                    velocity.x = new ParticleSystem.MinMaxCurve(direction.x * speed, decay);
                    velocity.y = new ParticleSystem.MinMaxCurve(direction.y * speed, decay);
                    velocity.z = new ParticleSystem.MinMaxCurve(direction.z * speed, decay);
                    _report.Approximated(name, type,
                        _systemDrag > 0f
                            ? $"became a velocity over life, faded by this system's drag ({_systemDrag:F2}) "
                              + "so it slows the way the preview does; the spread is not carried"
                            : "became a constant velocity over life - correct here, since this system "
                              + "has no drag to slow it - but the spread is not carried");
                    return;
                }

                case "initialize.velocityRandom":
                {
                    var velocity = ps.velocityOverLifetime;
                    velocity.enabled = true;
                    velocity.space = ParticleSystemSimulationSpace.Local;
                    var lo = VfxConvert.Vector(Binding(block, "min").Vector);
                    var hi = VfxConvert.Vector(Binding(block, "max").Vector);
                    // TWO CURVES, NOT TWO CONSTANTS, for the same reason the
                    // directional case needs one: Unity re-imposes this
                    // velocity every frame and its drag cannot touch it, so a
                    // constant travels at full speed forever. A pair of decay
                    // curves keeps the per-particle random draw AND slows it.
                    velocity.x = RangedDecay(lo.x, hi.x);
                    velocity.y = RangedDecay(lo.y, hi.y);
                    velocity.z = RangedDecay(lo.z, hi.z);
                    _report.Approximated(name, type,
                        _systemDrag > 0f
                            ? $"became a random velocity over life, faded by this system's drag "
                              + $"({_systemDrag:F2}); it is drawn per particle but re-applied every "
                              + "frame, so gravity reads slightly differently"
                            : "became a random velocity over life; it is re-applied every frame "
                              + "rather than drawn once at birth, so gravity reads slightly "
                              + "differently");
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
                    var limit = ps.limitVelocityOverLifetime;
                    limit.enabled = true;
                    limit.drag = new ParticleSystem.MinMaxCurve(Binding(block, "drag").Constant);
                    limit.dampen = 0f;
                    _report.Native(name, type, "limitVelocityOverLifetime.drag");
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
                    _report.Native(name, type);
                    return;
                }

                case "update.vortex":
                {
                    // Shuriken's orbital velocity is a rotation about the
                    // system's own axes through an offset - which is what a
                    // vortex is, as long as its axis is one of them.
                    var velocity = ps.velocityOverLifetime;
                    velocity.enabled = true;
                    var axis = VfxConvert.Vector(Binding(block, "axis").Vector).normalized;
                    var strength = Binding(block, "strength").Constant;
                    var centre = VfxConvert.Vector(Binding(block, "position").Vector);
                    velocity.orbitalX = new ParticleSystem.MinMaxCurve(axis.x * strength);
                    velocity.orbitalY = new ParticleSystem.MinMaxCurve(axis.y * strength);
                    velocity.orbitalZ = new ParticleSystem.MinMaxCurve(axis.z * strength);
                    velocity.orbitalOffsetX = new ParticleSystem.MinMaxCurve(centre.x);
                    velocity.orbitalOffsetY = new ParticleSystem.MinMaxCurve(centre.y);
                    velocity.orbitalOffsetZ = new ParticleSystem.MinMaxCurve(centre.z);
                    velocity.radial = new ParticleSystem.MinMaxCurve(-Binding(block, "inward").Constant);
                    _report.Approximated(name, type,
                        "became orbital velocity: the swirl is right but Unity's orbit is a fixed "
                        + "angular rate rather than a force, so it does not fall off with distance");
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
                    _report.Dropped(name, type,
                        "Shuriken kills on lifetime only; the effect will keep particles that the "
                        + "preview culls, so raise maxParticles or shorten the lifetime");
                    return;

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

            var blend = output["blend"].AsString("additive");
            var material = _material?.Invoke(blend);
            if (material != null)
            {
                renderer.sharedMaterial = material;
                _report.Native(name, "output.blend", blend + " -> " + material.shader.name);
            }
            else
            {
                _report.Dropped(name, "output.blend", "no particle shader found for " + blend);
            }

            // The texture and the mesh come off the output's blocks.
            foreach (var block in output["blocks"].Items)
            {
                var type = block["srcBlockType"].AsString();
                if (type == "output.setMainTexture")
                {
                    var texture = TextureFor(block, "texture");
                    if (texture != null && material != null)
                    {
                        // _BaseMap on URP's particle shaders, _MainTex on the
                        // built-in ones. Setting both is cheaper than deciding
                        // which pipeline is active, and an unknown property is
                        // a no-op rather than an error.
                        if (material.HasProperty("_BaseMap")) material.SetTexture("_BaseMap", texture);
                        if (material.HasProperty("_MainTex")) material.SetTexture("_MainTex", texture);
                        _report.Native(name, type, texture.name);
                    }
                    else if (texture == null)
                    {
                        _report.Dropped(name, type, "the bundle has no texture for this slot");
                    }
                }
                else if (type == "output.setMesh")
                {
                    var mesh = MeshFor(block, "mesh");
                    if (mesh != null)
                    {
                        renderer.mesh = mesh;
                        _report.Native(name, type, mesh.name);
                    }
                    else
                    {
                        // A MESH RENDERER WITH NO MESH DRAWS UNITY'S FALLBACK,
                        // not nothing - a hard-edged quad wearing whatever
                        // material the system asked for. On a debris burst with
                        // an opaque material that is a scatter of solid squares
                        // sitting in the middle of the effect, and it reads as
                        // a broken importer rather than as a missing asset.
                        //
                        // Switched off instead. The drop is already reported;
                        // absence matches the report, and corruption does not.
                        renderer.enabled = false;
                        _report.Dropped(name, type,
                            "the bundle has no mesh for this slot, so this system is not drawn - "
                            + "assign a mesh to its renderer and re-enable it. (Unity has no glTF "
                            + "importer; add com.unity.cloud.gltfast or export the mesh as FBX.)");
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
            foreach (var channel in _ir["eventChannels"].Items)
            {
                var sourceId = channel["sourceSystemId"].AsString();
                var trigger = channel["trigger"].AsString();
                if (!byId.TryGetValue(sourceId, out var source)) continue;

                foreach (var listener in channel["listeners"].Items)
                {
                    var childId = listener["systemId"].AsString(listener.AsString());
                    if (!byId.TryGetValue(childId, out var child)) continue;

                    var subs = source.subEmitters;
                    subs.enabled = true;
                    var type = trigger == "death"
                        ? ParticleSystemSubEmitterType.Death
                        : trigger == "collide"
                            ? ParticleSystemSubEmitterType.Collision
                            : ParticleSystemSubEmitterType.Birth;
                    subs.AddSubEmitter(child, type, ParticleSystemSubEmitterProperties.InheritNothing);
                    _report.Native(source.name, "sub-emitter", $"{trigger} -> {child.name}");
                }
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
                    _report.Approximated(name, "gradient HDR",
                        $"a key at {peak:F1}x intensity was folded into an LDR colour; Unity's "
                        + "Gradient has no HDR channel, so use the material's emission for the glow");
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
