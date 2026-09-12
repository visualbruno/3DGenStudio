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
        // Whether this system is fed by another system's events. A sub-emitter
        // inherits its parent PARTICLE's velocity, which is not what Unity's
        // InheritVelocity module does - see initialize.inheritVelocity.
        private bool _systemIsSubEmitter;

        private readonly Func<int, Texture2D> _texture;
        private readonly Func<int, Mesh> _mesh;
        private readonly Func<string, Texture2D, Material> _material;
        private readonly Func<Texture2D> _defaultSprite;
        private readonly Func<Mesh> _defaultMesh;

        // The system currently being built. BakeOperators samples across the
        // duration, and the line shape needs the spawn rate to work out how fast
        // the emission point has to walk the edge.
        private float _duration = 1f;
        private float _spawnRate;

        // Block+property pairs already reported as flattened, so a value read
        // twice while building one module is still only mentioned once.
        private readonly HashSet<string> _flattened = new HashSet<string>();

        // The flipbook is spread over three blocks - the frame count and timing
        // on update.flipbook, the start frame on initialize.setFlipbookFrame,
        // the sheet layout on output.setFlipbook - but Unity keeps all of it in
        // one module, and the output is applied LAST. So the first two record
        // what they want here and the output consumes it. Before this they were
        // pure report lines that configured nothing, which is why every sheet
        // imported as "play once over lifetime at 30fps, starting at frame 0"
        // no matter what it was authored as.
        private int _flipFrames;
        private float _flipRate;
        private string _flipTiming = "life";
        // Held as the AUTHORED FRAME INDEX, converted at the output where the
        // cell count is known. Unity's startFrame is normalised 0..1 across the
        // sheet, not an index, so passing a frame number straight through got
        // clamped: an authored "start at frame 35" arrived as 0.9999 and an
        // authored 5 would have arrived there too.
        private bool _flipStartSet;
        private bool _flipStartRandom;
        private float _flipStartLow;
        private float _flipStartHigh;

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
            _systemIsSubEmitter = system.Has("listen");
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
            _duration = main.duration;
            _spawnRate = 0f;
            _flipFrames = 0;
            _flipRate = 0f;
            _flipTiming = "life";
            _flipStartSet = false;
            _flipStartRandom = false;
            _flipStartLow = 0f;
            _flipStartHigh = 0f;
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
            // AND THE SHAPE, which the same reasoning covers and which was
            // missed: Unity's default shape module is an ENABLED cone of
            // radius 1, so a system with no position block - every sub-emitter
            // is one, because a position block would overwrite the point it
            // inherits - scattered its particles over a one-metre disc around
            // the spot they were supposed to appear at. In the bench that
            // turned a death burst 2.1m wide into one 8.7m wide. A position
            // block below switches the module back on.
            var defaultShape = ps.shape;
            defaultShape.enabled = false;

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
            VfxJson rateBlock = null;
            foreach (var block in system["spawn"].Items)
            {
                var type = block["srcBlockType"].AsString();
                if (type == "spawn.rate") { rate = Binding(block, "rate").Constant; rateBlock = block; }
                else if (type == "spawn.burst") burstCount = Binding(block, "count").Constant;
            }
            // Kept for the line shape, which has to turn "one step per particle"
            // into Unity's "metres per second". Set here because spawn is built
            // before the Initialize blocks that need it.
            _spawnRate = rate;

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
            // A RATE THAT IS NOT A PLAIN NUMBER - wired to an operator, or a
            // curve over the effect - reads as 0 through Binding().Constant and
            // used to fall straight out of the guard below: the system emitted
            // NOTHING and the report said nothing about it. Unity's rateOverTime
            // is itself a curve over the system's duration, which is exactly
            // what the app evaluates a spawn curve against, so both have a home.
            if (rateBlock != null)
            {
                var bound = Binding(rateBlock, "rate");
                if (bound.IsRegister || !bound.Curve.IsNull() || bound.IsRandom)
                {
                    ApplyVariableRate(ps, rateBlock, bound, clips, duration, name);
                    return;
                }
            }

            if (rate <= 0f)
            {
                if (rateBlock != null)
                {
                    _report.Dropped(name, "spawn.rate",
                        "the rate reads as zero, so this system emits nothing");
                }
                return;
            }

            // ONE OPEN-ENDED CLIP AT ZERO is the common case - the default
            // schedule - and it is a plain constant rate. So is a single clip
            // that happens to span the whole duration: gating it would build a
            // two-key curve that is on for all of it, which is the same effect
            // written less clearly and one more thing to go wrong.
            if (TrivialSchedule(clips, duration))
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
                {
                    var size = Curve(block, "size", name);
                    main.startSize = size;
                    // Already reported as approximated/dropped when it was wired.
                    if (!Binding(block, "size").IsRegister) _report.Native(name, type);
                    return;
                }

                case "initialize.setColor":
                    main.startColor = new ParticleSystem.MinMaxGradient(
                        VfxConvert.Colour(Binding(block, "color").Vector));
                    _report.Native(name, type);
                    return;

                case "initialize.setRotation":
                    // DEGREES IN THE IR, RADIANS IN UNITY - this used to say the
                    // opposite and scale by Rad2Deg, which is the same mistake
                    // backwards and a factor of 3283 out. The IR keeps the
                    // authored degrees (kernels.js rot.set and rot.spin both
                    // multiply by PI/180 themselves), and Unity's SCRIPT api
                    // takes radians even though its Inspector shows degrees -
                    // measured, not assumed: startRotation = 90 reads back as
                    // Particle.rotation 5156.6 degrees, which is 90 * Rad2Deg.
                    //
                    // It hid here because a start angle is periodic: the usual
                    // authoring is a random -180..180, and any angle times 57
                    // is still just some angle. update.spin below is where it
                    // shows, because there the error becomes a rate.
                    var rotation = Curve(block, "rotation");
                    main.startRotation = Scale(rotation, Mathf.Deg2Rad);
                    _report.Native(name, type);
                    return;

                case "initialize.positionSphere":
                {
                    shape.enabled = true;
                    var surface = block["modes"]["fill"].AsString("volume") == "surface";
                    // ALWAYS Sphere, never SphereShell. SphereShell is one of
                    // Unity's deprecated shape types and it IGNORES
                    // shape.position - measured against a Box built the same
                    // way in the same prefab: the box emitted at its offset of
                    // (-3, 0.2, 9) and the shell emitted at the origin, so a
                    // surface-filled sphere placed anywhere but 0,0,0 silently
                    // moved. radiusThickness is the supported way to say the
                    // same thing: 0 is the surface, 1 is the whole volume.
                    shape.shapeType = ParticleSystemShapeType.Sphere;
                    shape.radiusThickness = surface ? 0f : 1f;
                    shape.radius = Mathf.Max(0.0001f, Scalar(block, "radius", name, type));
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = VfxConvert.Euler(Binding(block, "rotation").Vector);
                    _report.Native(name, type, surface ? "Sphere surface" : "Sphere volume");
                    return;
                }

                case "initialize.positionCone":
                {
                    shape.enabled = true;
                    // CONE, NOT ConeVolume. The kernel (shape.cone in
                    // kernels.js) puts the particle on the cone's MOUTH - a
                    // disc of `radius` at the shape's origin - and spends the
                    // angle on the VELOCITY. ConeVolume instead scatters the
                    // position through the cone's body, over `shape.length`,
                    // which nothing here ever set and Unity defaults to 5: the
                    // bench's cone emitted over five metres of axis it was
                    // never given and climbed to y=7.2 where the preview
                    // reached 3.4. Cone is the base-emitting variant, and it is
                    // exactly what the kernel does.
                    shape.shapeType = ParticleSystemShapeType.Cone;
                    // The mouth is a filled disc, not a ring.
                    shape.radiusThickness = 1f;
                    shape.angle = Scalar(block, "angle", name, type);
                    shape.radius = Mathf.Max(0.0001f, Scalar(block, "radius", name, type));
                    shape.position = VfxConvert.Vector(Binding(block, "offset").Vector);
                    shape.rotation = ShapeRotation(block);
                    // The cone block carries its own speed, unlike the other
                    // shapes - it is an emitter and a velocity in one.
                    var speed = Curve(block, "speed");
                    if (speed.constant > 0f || speed.constantMax > 0f) main.startSpeed = speed;
                    _report.Native(name, type, "Cone (emits from the mouth)");
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
                    var circleRadius = Mathf.Max(0.0001f, Scalar(block, "radius", name, type));
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
                        Scalar(block, "thickness", name, type) / circleRadius);
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
                    var jitter = Scalar(block, "jitter", name, type);
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

                    // THE SPREAD, which used to be thrown away entirely. A jet
                    // authored with a 30 degree cone imported as a rigid line:
                    // the bench's system 15 spans x 1.7..4.4 in the preview and
                    // imported spanning 2.8..3.2, a column instead of a plume,
                    // and every fountain-shaped effect lost its shape the same
                    // way.
                    //
                    // Shuriken cannot express a cone here - velocityOverLifetime
                    // is three INDEPENDENT axis curves, so the three random
                    // draws cannot be correlated into one direction. What it can
                    // do, when the axis is a cardinal one (which is what an
                    // author writes: up, forward, down), is put the cone's
                    // lateral reach on the two perpendicular axes as a
                    // per-particle range. That is a square cross-section where
                    // the kernel draws a disc, and the corners reach 1.41x -
                    // but it is the plume, at the right width, instead of a
                    // line. An oblique direction keeps the old behaviour rather
                    // than guessing at a basis.
                    var spread = Mathf.Clamp(Binding(block, "spread").Constant, 0f, 89f);
                    var axis = Cardinal(direction);
                    var spreadCarried = spread > 0.01f && axis >= 0;

                    // MATCHED TO THE KERNEL'S MOMENTS, not to the cone's edge.
                    // vel.direction draws cos(phi) uniformly over the solid
                    // angle and keeps |v| fixed, so the axial component SHRINKS
                    // as the cone widens - at a 80 degree half-angle the mean
                    // particle only carries 0.59 of its speed forward. Leaving
                    // the axis at full speed and adding the lateral beside it
                    // builds a particle moving 1.7x faster than it was
                    // authored to; the bench's wide sub-emitter sprayed twice
                    // as far as the preview. So: the axis takes the mean
                    // cos(phi), and each lateral axis takes the range whose
                    // variance equals the kernel's per-axis variance.
                    var c = Mathf.Cos(spread * Mathf.Deg2Rad);
                    var axial = (1f + c) * 0.5f;
                    var lateralScale = Mathf.Sqrt(Mathf.Max(0f, (2f - c - c * c) * 0.5f));
                    var reach = Mathf.Max(Mathf.Abs(lo), Mathf.Abs(hi)) * lateralScale;

                    var ranges = new ParticleSystem.MinMaxCurve[3];
                    for (var a = 0; a < 3; a++)
                    {
                        var d = a == 0 ? direction.x : a == 1 ? direction.y : direction.z;
                        if (spreadCarried && a != axis) { ranges[a] = Ranged(-reach, reach); continue; }
                        var scale = spreadCarried ? axial : 1f;
                        ranges[a] = Ranged(d * lo * scale, d * hi * scale);
                    }
                    velocity.x = ranges[0];
                    velocity.y = ranges[1];
                    velocity.z = ranges[2];
                    _report.Approximated(name, type,
                        "became a velocity over life - imposed every frame rather than set once at "
                        + "birth, and this system's drag fades it through speedModifier"
                        + (spread <= 0.01f
                            ? ""
                            : spreadCarried
                                ? $"; the {spread:F0} degree spread is carried on the two axes across "
                                  + "the direction, which makes it square rather than round"
                                : $"; the {spread:F0} degree spread is NOT carried - the direction is "
                                  + "not a cardinal axis, and Unity's three velocity curves are drawn "
                                  + "independently, so they cannot be correlated into a cone"));
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
                    // TWO DIFFERENT THINGS WEAR THIS NAME. Unity's
                    // InheritVelocity module inherits the velocity of the
                    // emitter's TRANSFORM - a system carried on a moving object.
                    // The block means that only for a system that spawns on its
                    // own; on a sub-emitter it means the parent PARTICLE's
                    // velocity, which in Unity is a property of the sub-emitter
                    // LINK and is wired in WireEvents.
                    //
                    // Leaving the module on for a sub-emitter was not merely
                    // useless (a prefab standing still has no transform
                    // velocity) - measured on Fire Storm's debris, the module
                    // plus the collision plane teleported the occasional
                    // particle two kilometres away, one stray mesh hanging in
                    // the distance for the rest of its life.
                    if (_systemIsSubEmitter)
                    {
                        // Reported by WireEvents, which is where it lands.
                        return;
                    }
                    var inherit = ps.inheritVelocity;
                    inherit.enabled = true;
                    inherit.mode = ParticleSystemInheritVelocityMode.Initial;
                    inherit.curve = new ParticleSystem.MinMaxCurve(Scalar(block, "scale", name, type));
                    _report.Native(name, type, "from the emitter's transform");
                    return;
                }

                case "initialize.setFlipbookFrame":
                {
                    // The AUTHORED value, not a blanket "randomised": a constant
                    // 0 and a random 0..35 are different effects and both used
                    // to arrive as 0.
                    var frame = Binding(block, "flipbookFrame");
                    _flipStartSet = true;
                    _flipStartRandom = frame.IsRandom;
                    _flipStartLow = frame.IsRandom ? Mathf.Min(frame.Low, frame.High) : frame.Constant;
                    _flipStartHigh = frame.IsRandom ? Mathf.Max(frame.Low, frame.High) : frame.Constant;
                    _report.Native(name, type, frame.IsRandom
                        ? $"start frame random {_flipStartLow:F0}-{_flipStartHigh:F0}"
                        : $"start frame {_flipStartLow:F0}");
                    return;
                }

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
                    var girth = Mathf.Max(0.001f, Scalar(block, "thickness", name, type));
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
                {
                    // SHURIKEN DOES HAVE A LINE: ParticleSystemShapeType
                    // SingleSidedEdge, an edge along the shape's local X of
                    // 2 * radius. This used to lay down a thin BOX instead,
                    // which is the right span but scatters particles randomly
                    // across it - and that threw away the one thing the line's
                    // placement mode is for. A chain authored with "spacing"
                    // arrived in Unity as noise.
                    shape.enabled = true;
                    var start = VfxConvert.Vector(Binding(block, "start").Vector);
                    var end = VfxConvert.Vector(Binding(block, "end").Vector);
                    var segment = end - start;
                    var length = segment.magnitude;

                    shape.shapeType = ParticleSystemShapeType.SingleSidedEdge;
                    shape.radius = Mathf.Max(0.0001f, length * 0.5f);
                    shape.position = (start + end) * 0.5f;
                    if (length > 0f)
                    {
                        shape.rotation = Quaternion
                            .FromToRotation(Vector3.right, segment / length).eulerAngles;
                    }

                    var placement = block["modes"]["placement"].AsString("random");
                    if (placement == "spacing" && length > 0f)
                    {
                        // The app walks the line by GLOBAL SPAWN INDEX: particle
                        // N sits at N * spacing metres, wrapping at the far end
                        // (kernels.js shape.position.line). Unity walks it over
                        // TIME instead, so the speed has to be derived from the
                        // spawn rate: one step of `spacing` per particle, and
                        // `rate` particles a second, is rate * spacing metres a
                        // second - expressed, as Unity wants it, in edges per
                        // second. Spread quantises the edge to the same step so
                        // the particles land ON the slots rather than between
                        // them.
                        var spacing = Mathf.Max(0.0001f, Scalar(block, "spacing", name, type));
                        shape.radiusMode = ParticleSystemShapeMultiModeValue.Loop;
                        // Spread QUANTISES the edge into slots, which sounds
                        // like the right way to land particles on the app's
                        // slots and is not. Unity moves the emission point by
                        // the clock while the app steps it once per particle,
                        // and a rate that does not divide the frame (8/s at
                        // 60fps is a particle every 7.5 frames) then drops two
                        // births into one slot and skips the next - a chain with
                        // a doubled slab and a hole in it. Left continuous, the
                        // same births land a smooth spacing apart, off by only
                        // the frame the emitter rounded to.
                        shape.radiusSpread = 0f;

                        // MEASURED, not read off the docs: the emission point
                        // travels 2 * radiusSpeed METRES a second along the
                        // edge, and that factor does NOT scale with the radius
                        // (checked at radius 7 and 3.5, same step either way).
                        // One step of `spacing` per particle at `rate` particles
                        // a second is spacing * rate metres a second, hence the
                        // half. Treating radiusSpeed as edges-per-second instead
                        // left the point crawling and every particle piled on
                        // the first slot.
                        var metresPerSecond = spacing * (_spawnRate > 0f ? _spawnRate : 1f);
                        shape.radiusSpeed = new ParticleSystem.MinMaxCurve(metresPerSecond * 0.5f);

                        // Unity starts the point at the near end and moves it
                        // continuously, so the first particle - born 1/rate
                        // seconds in - has already travelled exactly one step
                        // and the whole chain sits one slot too far out. The app
                        // puts spawn index 0 ON the start. Shifting the edge back
                        // one step lines the two up.
                        shape.position -= segment / length * spacing;

                        _report.Native(name, type,
                            $"edge, marching {spacing:0.##}m per particle");
                    }
                    else if (placement == "even")
                    {
                        shape.radiusMode = ParticleSystemShapeMultiModeValue.BurstSpread;
                        shape.radiusSpread = 0f;
                        _report.Native(name, type, "edge, one burst spread along it");
                    }
                    else
                    {
                        shape.radiusMode = ParticleSystemShapeMultiModeValue.Random;
                        shape.radiusSpread = 0f;
                        _report.Native(name, type, "edge, scattered along it");
                    }

                    var thickness = Scalar(block, "thickness", name, type);
                    if (thickness > 0.001f)
                    {
                        _report.Approximated(name, type,
                            $"the line's {thickness:0.##}m thickness is not carried - Unity's edge "
                            + "emits exactly on the line");
                    }
                    return;
                }

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
                    // DRAG AND GRAVITY TOGETHER ARE NOT TWO INDEPENDENT
                    // SETTINGS. In the preview they reach a balance: the
                    // acceleration builds speed, the drag takes it away, and
                    // the particle settles at g/k and drifts at that rate for
                    // the rest of its life. Shuriken cannot reproduce that,
                    // because the drag here is speedModifier, which scales the
                    // particle's whole displacement - so the drift does not
                    // settle, it decays to a standstill. The bench's vortex
                    // rises 1.8m in the preview and stalled after 0.2m.
                    //
                    // So the gravity is rescaled to land in the right place:
                    // the multiplier that makes Unity's drift over the mean
                    // lifetime equal the preview's. The two paths still differ
                    // in the middle - the preview's is a straight drift, this
                    // one slows down - but the particle ends where it belongs
                    // instead of hanging in the air. Both integrals are per
                    // unit acceleration, so their ratio is a pure number.
                    var scale = 1f;
                    if (_systemDrag > 1e-4f)
                    {
                        var k = _systemDrag;
                        var t = _systemLifetime;
                        var decay = Mathf.Exp(-k * t);
                        var preview = (t - (1f - decay) / k) / k;
                        var shuriken = 1f / (k * k) - decay * (t / k + 1f / (k * k));
                        if (shuriken > 1e-5f) scale = Mathf.Clamp(preview / shuriken, 1f, 20f);
                    }
                    gravity *= scale;
                    // Unity's gravityModifier is a MULTIPLE of Physics.gravity,
                    // which points down. A purely vertical IR gravity maps to it
                    // exactly - including a NEGATIVE multiplier for buoyancy,
                    // which is how the fire presets rise.
                    if (Mathf.Abs(gravity.x) < 1e-4f && Mathf.Abs(gravity.z) < 1e-4f)
                    {
                        main.gravityModifier = new ParticleSystem.MinMaxCurve(
                            gravity.y / Physics.gravity.y);
                        _report.Native(name, type, "gravityModifier "
                            + (gravity.y / Physics.gravity.y).ToString("F2")
                            + (scale > 1.001f
                                ? $" - scaled {scale:F1}x so the drift against this system's drag "
                                  + "covers the same distance it does in the preview"
                                : ""));
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
                        1f, DragDecayCurve(Scalar(block, "drag", name, type), _systemLifetime));
                    _report.Native(name, type, "velocityOverLifetime.speedModifier (linear drag)");
                    return;
                }

                case "update.turbulence":
                {
                    var noise = ps.noise;
                    noise.enabled = true;
                    noise.strength = new ParticleSystem.MinMaxCurve(Scalar(block, "strength", name, type));
                    noise.frequency = Mathf.Max(0.0001f, Scalar(block, "frequency", name, type));
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
                    // Degrees per second in the IR, radians per second in
                    // Unity's script api - see initialize.setRotation above.
                    // Scaling the wrong way turned an authored 35 deg/s into
                    // 2005 rad/s: about 320 revolutions a second.
                    rotation.z = Scale(Curve(block, "speed"), Mathf.Deg2Rad);
                    _report.Native(name, type);
                    return;
                }

                case "update.speedLimit":
                {
                    var limit = ps.limitVelocityOverLifetime;
                    limit.enabled = true;
                    limit.limit = new ParticleSystem.MinMaxCurve(Scalar(block, "speed", name, type));
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
                    var strength = Scalar(block, "strength", name, type);
                    var centre = VfxConvert.Vector(Binding(block, "position").Vector);
                    var inward = Scalar(block, "inward", name, type);

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
                            + "rotation, so particles hold their radius instead of spiralling - and "
                            + "its radial pull is toward the centre POINT rather than the axis, so "
                            + "a ring of particles held above that point also sinks toward it "
                            + "(measured on the aura's runes: 0.95m down to 0.61m over a life)");
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
                    collision.bounce = new ParticleSystem.MinMaxCurve(Scalar(block, "bounce", name, type));
                    collision.dampen = new ParticleSystem.MinMaxCurve(Scalar(block, "friction", name, type));
                    // The plane itself is a Transform reference Shuriken cannot
                    // invent, so the importer makes one at the IR's height.
                    var height = Scalar(block, "height", name, type);
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
                    // Recorded for the output, which owns Unity's sheet module.
                    _flipFrames = Mathf.RoundToInt(Scalar(block, "frames", name, type));
                    _flipRate = Scalar(block, "rate", name, type);
                    _flipTiming = block["modes"]["timing"].AsString("life");
                    _report.Native(name, type, _flipTiming == "rate"
                        ? $"{_flipFrames} frames at {_flipRate:F0} fps, looping"
                        : $"{_flipFrames} frames once over each particle's life");
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
                    // BILLBOARD, to match the app. materials.js falls a trail
                    // back to a plain billboard and says so with
                    // I_TRAIL_UNSUPPORTED; importing it as Stretch made Unity
                    // disagree with the preview while the report claimed the
                    // two matched. Neither is a trail - but they are now the
                    // same not-a-trail.
                    renderer.renderMode = ParticleSystemRenderMode.Billboard;
                    _report.Approximated(name, "output.mode",
                        "no trail renderer on either side yet, so it became a plain billboard - "
                        + "the same fallback the app's preview makes, so the two agree");
                    break;
                default:
                    renderer.renderMode = ParticleSystemRenderMode.Billboard;
                    _report.Native(name, "output.mode", "Billboard");
                    break;
            }

            var sort = output["sort"].AsString("none");
            // "age" used to fall into the else and become None, silently - the
            // author asked for sorting and got none. Unity's OldestInFront is
            // the same ordering the app means by sorting on age.
            renderer.sortMode = sort == "depth"
                ? ParticleSystemSortMode.Distance
                : sort == "age"
                    ? ParticleSystemSortMode.OldestInFront
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
                var cells = sheet.numTilesX * sheet.numTilesY;
                var detail = $"{sheet.numTilesX}x{sheet.numTilesY}";

                if (_flipStartSet)
                {
                    // Frame index -> Unity's normalised phase.
                    var lo = Mathf.Clamp01(_flipStartLow / cells);
                    var hi = Mathf.Clamp01(_flipStartHigh / cells);
                    sheet.startFrame = _flipStartRandom
                        ? new ParticleSystem.MinMaxCurve(lo, hi)
                        : new ParticleSystem.MinMaxCurve(lo);
                }

                if (_flipTiming == "rate" && _flipRate > 0f)
                {
                    // "Rate" plays at a fixed speed and loops, which is Unity's
                    // FPS time mode. Hardcoding Lifetime made a looping torch
                    // sheet play through exactly once instead, at Unity's
                    // default 30fps rather than the authored rate.
                    sheet.timeMode = ParticleSystemAnimationTimeMode.FPS;
                    sheet.fps = _flipRate;
                    detail += $", {_flipRate:F0} fps looping";
                }
                else
                {
                    sheet.timeMode = ParticleSystemAnimationTimeMode.Lifetime;
                    detail += ", once over life";
                    // A sheet whose frame count is fewer than its cells must
                    // stop early, or it plays the empty remainder of the grid.
                    if (_flipFrames > 0 && _flipFrames < cells)
                    {
                        sheet.frameOverTime = new ParticleSystem.MinMaxCurve(
                            _flipFrames / (float)cells,
                            AnimationCurve.Linear(0f, 0f, 1f, 1f));
                        detail += $", {_flipFrames} of {cells} cells";
                    }
                }
                _report.Native(name, "output.flipbook", detail);
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

                // WHERE initialize.inheritVelocity LANDS, which is nowhere.
                // ParticleSystemSubEmitterProperties carries colour, size,
                // rotation, lifetime and duration - there is no velocity in the
                // list - and the InheritVelocity MODULE is a different feature:
                // it reads the emitter TRANSFORM's velocity, which for a prefab
                // standing still is zero. Enabling it here was worse than
                // useless: the transform velocity is differenced between frames
                // and, stepped from the editor, that difference is nonsense for
                // a frame or two after a restart - Fire Storm's debris had a
                // particle born two kilometres from its impact, sliding on the
                // ground for the rest of its life.
                foreach (var block in system["init"].Items)
                {
                    if (block["srcBlockType"].AsString() != "initialize.inheritVelocity") continue;
                    _report.Dropped(child.name, "initialize.inheritVelocity",
                        $"a sub-emitter cannot carry the parent particle's velocity in Shuriken, so "
                        + $"the authored {Binding(block, "scale").Constant:P0} is lost and the child "
                        + "starts from rest. Give it a velocity of its own if the drift matters");
                }
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
            // An operator-driven property. Without these the `register` source
            // fell through to `default:` and handed back a Bound whose Constant
            // is 0 - so a size wired to an operator imported as size 0 and the
            // system simply never appeared, with nothing in the report saying
            // why. See BakeOperators.
            public bool IsRegister;
            public int Register;
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
                        bound.Constant = Average(VfxConvert.Curve(bound.Curve)) * bound.Scale;
                        Broadcast(ref bound, width);
                        return bound;
                    case "gradient":
                        bound.Gradient = _ir["tables"][binding["index"].AsInt(0)]["authored"];
                        return bound;
                    case "register":
                    {
                        bound.IsRegister = true;
                        bound.Register = binding["index"].AsInt(0);
                        // A FALLBACK VALUE FOR THE SCALAR FIELDS. Callers that
                        // can take a curve go through Curve() and get the baked
                        // chain; the ones that cannot - a shape radius, a noise
                        // frequency, a speed cap - read Constant, and Constant
                        // used to be 0 for every wired property. That is not a
                        // small loss, it is a different effect: a speed LIMIT
                        // of 0 with full dampening froze every particle in the
                        // bench's "All Operators" system on the spot, while the
                        // preview had them flying. The chain's AVERAGE over the
                        // effect is the honest stand-in - wrong in the same way
                        // a constant is always wrong about an animation, rather
                        // than catastrophically wrong about the magnitude.
                        if (BakeOperators(block, bound.Register, out var chain, out _, out _))
                        {
                            bound.Constant = Average(chain);
                            Broadcast(ref bound, width);
                        }
                        return bound;
                    }
                    default:
                        return bound;
                }
            }
            return bound;
        }

        /// <summary>
        /// A binding's representative value, for a Shuriken field that has
        /// nowhere to put a curve. Reports what it flattened, once per
        /// block+property, because "your speed cap is now its average" is the
        /// kind of thing an author has to be told rather than discover.
        /// </summary>
        private float Scalar(VfxJson block, string prop, string name, string type)
        {
            var bound = Binding(block, prop);
            if (bound.IsRegister || !bound.Curve.IsNull())
            {
                var key = name + "/" + type + "/" + prop;
                if (_flattened.Add(key))
                {
                    _report.Approximated(name, type,
                        $"\"{prop}\" is {(bound.IsRegister ? "driven by operators" : "a curve")}, and "
                        + "Unity's field for it takes a single number - flattened to its average "
                        + $"over the effect, {bound.Constant:F3}");
                }
            }
            return bound.Constant;
        }

        /// <summary>The mean of a curve over 0..1. See Scalar.</summary>
        private static float Average(AnimationCurve curve)
        {
            if (curve == null || curve.length == 0) return 0f;
            const int samples = 17;
            var total = 0f;
            for (var i = 0; i < samples; i++) total += curve.Evaluate(i / (float)(samples - 1));
            return total / samples;
        }

        private static void Broadcast(ref Bound bound, int width)
        {
            // The compiler broadcasts a scalar across a vector property, so a
            // wired offset is (v, v, v) and not (v, 0, 0).
            if (width <= 1) return;
            for (var i = 0; i < bound.Vector.Length; i++) bound.Vector[i] = bound.Constant;
        }

        /// <summary>
        /// The index of the axis a unit vector points along, or -1 when it
        /// points somewhere between two of them. See velocityDirection.
        /// </summary>
        private static int Cardinal(Vector3 direction)
        {
            for (var a = 0; a < 3; a++)
            {
                if (Mathf.Abs(Mathf.Abs(direction[a]) - 1f) > 0.001f) continue;
                var other = Mathf.Abs(direction[(a + 1) % 3]) + Mathf.Abs(direction[(a + 2) % 3]);
                if (other < 0.001f) return a;
            }
            return -1;
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
            return Curve(block, prop, null);
        }

        private ParticleSystem.MinMaxCurve Curve(VfxJson block, string prop, string reportAs)
        {
            var bound = Binding(block, prop);
            if (bound.IsRegister)
            {
                if (BakeOperators(block, bound.Register, out var baked, out var why, out var flattened))
                {
                    if (reportAs != null)
                    {
                        _report.Approximated(reportAs, block["srcBlockType"].AsString(),
                            "driven by operators, baked into a curve over the system's duration - "
                            + "exact for anything reading Effect Time, which is what Unity evaluates "
                            + "a start property's curve against"
                            + (flattened ? "; an op.random in the chain is flattened to its average"
                                         : ""));
                    }
                    return new ParticleSystem.MinMaxCurve(1f, baked);
                }
                if (reportAs != null)
                {
                    _report.Dropped(reportAs, block["srcBlockType"].AsString(),
                        "it is driven by operators that cannot be baked into a curve - " + why
                        + "; the property keeps the literal the graph last held");
                }
                // The literal the document kept behind the wire. Better than the
                // zero this used to return, which made the system invisible.
                return new ParticleSystem.MinMaxCurve(bound.Constant);
            }
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

        /// <summary>
        /// A spawn rate that varies: a random range, a curve over the effect, or
        /// an operator chain. Sampled into one rateOverTime curve, multiplied by
        /// the clip gate where the schedule needs one.
        /// </summary>
        private void ApplyVariableRate(ParticleSystem ps, VfxJson block, Bound bound,
            List<Clip> clips, float duration, string name)
        {
            var emission = ps.emission;

            // A plain random range is two constants, which Unity takes directly.
            if (bound.IsRandom && !bound.IsRegister && bound.Curve.IsNull())
            {
                emission.rateOverTime = new ParticleSystem.MinMaxCurve(
                    Mathf.Min(bound.Low, bound.High), Mathf.Max(bound.Low, bound.High));
                _report.Native(name, "spawn.rate", $"{bound.Low:F0}-{bound.High:F0}/s");
                return;
            }

            AnimationCurve source = null;
            var ok = true;
            string why = null;
            var flattened = false;
            if (bound.IsRegister) ok = BakeOperators(block, bound.Register, out source, out why, out flattened);
            else source = VfxConvert.Curve(bound.Curve);

            if (!ok || source == null)
            {
                emission.rateOverTime = new ParticleSystem.MinMaxCurve(Mathf.Max(0f, bound.Constant));
                _report.Dropped(name, "spawn.rate",
                    "it is driven by operators that cannot be baked into a curve - " + why
                    + "; the rate falls back to the literal the graph last held");
                return;
            }

            const int samples = 33;
            var gate = TrivialSchedule(clips, duration) ? null : BuildRateGate(clips, duration);
            var values = new float[samples];
            var peak = 0f;
            for (var i = 0; i < samples; i++)
            {
                var t = i / (float)(samples - 1);
                var v = Mathf.Max(0f, source.Evaluate(t) * (bound.IsRegister ? 1f : bound.Scale));
                if (gate != null) v *= Mathf.Clamp01(gate.Evaluate(t));
                values[i] = v;
                peak = Mathf.Max(peak, v);
            }

            if (peak <= 0f)
            {
                _report.Dropped(name, "spawn.rate", "the rate is zero across the whole duration");
                return;
            }

            var keys = new Keyframe[samples];
            for (var i = 0; i < samples; i++)
            {
                keys[i] = new Keyframe(i / (float)(samples - 1), values[i] / peak);
            }
            emission.rateOverTime = new ParticleSystem.MinMaxCurve(peak, new AnimationCurve(keys));
            var detail = $"varies, peaking at {peak:F0}/s"
                + (bound.IsRegister ? ", baked from operators" : ", from a curve")
                + (gate != null ? $", gated by {clips.Count} window(s)" : "");
            if (flattened)
            {
                _report.Approximated(name, "spawn.rate",
                    detail + "; an op.random in the chain is flattened to its average, "
                    + "so the per-frame jitter is not carried");
            }
            else
            {
                _report.Native(name, "spawn.rate", detail);
            }
        }

        /// <summary>
        /// The schedule that needs no gate: one window, opening at zero, running
        /// to the end. Shared so the constant and varying rate paths agree.
        /// </summary>
        private static bool TrivialSchedule(List<Clip> clips, float duration) =>
            clips.Count == 1 && clips[0].At <= 1e-4f
            && (clips[0].OpenEnded || clips[0].Seconds >= duration - 1e-4f);

        /// <summary>
        /// Bake an operator chain into a curve over the system's duration.
        ///
        /// Shuriken has no operator graph, so this is the only way to carry one
        /// across - but for the common wiring it is not a compromise. Unity
        /// evaluates a START property's curve over the SYSTEM'S DURATION at the
        /// instant a particle is born, and `op.time` is seconds since the effect
        /// started, so the two mean the same thing and the values match sample
        /// for sample.
        ///
        /// The arithmetic mirrors OP_EVALUATORS in kernels.js exactly, including
        /// the parts that are easy to get subtly wrong: remap CLAMPS its
        /// normalised input to 0..1 (so a value past the input range holds at
        /// the far end rather than extrapolating), divide by ~zero yields zero
        /// rather than Infinity, and sine is sin(x * 2pi), not sin(x).
        ///
        /// A chain that reads the PARTICLE rather than the clock - op.random or
        /// op.getAttribute - has no such equivalent, and is reported rather than
        /// quietly flattened to one number.
        /// </summary>
        private bool BakeOperators(VfxJson block, int register, out AnimationCurve curve, out string why,
            out bool randomFlattened)
        {
            curve = null;
            why = null;
            randomFlattened = false;

            var ops = new List<VfxJson>(block["pre"].Items);
            if (ops.Count == 0)
            {
                why = "the IR carries no operator chain for it";
                return false;
            }
            // `random` is flattened to the middle of its range rather than
            // refused. It is per-FRAME noise with no curve equivalent, but
            // returning false here left the caller with nothing usable - a
            // spawn rate wired through one imported as 0 and the system emitted
            // nothing at all, which is far worse than a steady average.
            // `attr` is different: it is per-PARTICLE, so there is no single
            // value to stand in for it.
            randomFlattened = false;
            foreach (var op in ops)
            {
                var kind = op["op"].AsString();
                if (kind == "random") randomFlattened = true;
                if (kind == "attr")
                {
                    why = $"it runs through \"{op["srcType"].AsString()}\", which varies per particle "
                        + "rather than over the effect's time";
                    return false;
                }
            }

            const int samples = 33;
            var duration = Mathf.Max(0.01f, _duration);
            var keys = new Keyframe[samples];
            for (var i = 0; i < samples; i++)
            {
                var t = i / (float)(samples - 1);
                keys[i] = new Keyframe(t, EvaluateOps(ops, register, t * duration));
            }
            curve = new AnimationCurve(keys);
            for (var i = 0; i < samples; i++) curve.SmoothTangents(i, 0f);
            return true;
        }

        /// <summary>Run one operator chain at a given effect time.</summary>
        private float EvaluateOps(List<VfxJson> ops, int register, float time)
        {
            var registers = new Dictionary<int, float>();
            foreach (var op in ops)
            {
                var inputs = new List<float>();
                foreach (var input in op["in"].Items)
                {
                    var index = input["index"].AsInt(0);
                    inputs.Add(input["kind"].AsString() == "register"
                        ? (registers.TryGetValue(index, out var upstream) ? upstream : 0f)
                        : ConstantAt(index));
                }

                float In(int i) => i >= 0 && i < inputs.Count ? inputs[i] : 0f;
                float value;
                switch (op["op"].AsString())
                {
                    case "time": value = time; break;
                    case "const": value = In(0); break;
                    case "add": value = In(0) + In(1); break;
                    case "sub": value = In(0) - In(1); break;
                    case "mul": value = In(0) * In(1); break;
                    case "div": value = Mathf.Abs(In(1)) < 1e-9f ? 0f : In(0) / In(1); break;
                    case "lerp": value = In(0) + (In(1) - In(0)) * In(2); break;
                    case "clamp": value = Mathf.Clamp(In(0), In(1), In(2)); break;
                    case "sin": value = Mathf.Sin(In(0) * 2f * Mathf.PI); break;
                    // The midpoint - see BakeOperators. Per-frame noise has no
                    // curve to bake into, but its average does.
                    case "random": value = (In(0) + In(1)) * 0.5f; break;
                    case "remap":
                    {
                        var span = In(2) - In(1);
                        if (Mathf.Abs(span) < 1e-9f) { value = In(3); break; }
                        var k = Mathf.Clamp01((In(0) - In(1)) / span);
                        value = In(3) + (In(4) - In(3)) * k;
                        break;
                    }
                    default: value = 0f; break;
                }
                registers[op["out"].AsInt(0)] = value;
            }
            return registers.TryGetValue(register, out var result) ? result : 0f;
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
