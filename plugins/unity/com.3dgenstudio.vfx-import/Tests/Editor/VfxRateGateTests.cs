// The rate gate: the curve that turns a timeline clip into Shuriken emission.
//
// WHY THIS FILE EXISTS. An imported effect emitted nothing. The import report
// said "70/s gated by a 1-window curve", the Emission module showed Rate over
// Time = 70, and the curve under it was a flat line at zero - so everything an
// author could see said the rate had imported, and no particle ever appeared.
//
// The cause was one line of Unity behaviour: AnimationCurve.AddKey SILENTLY
// DOES NOTHING when a key already exists at that time. It returns -1, raises
// nothing, and leaves the curve alone. The gate seeds a closing key at t=0
// because a rate has to be off before the first window opens; a clip starting
// at zero - which is most of them, and every preset - then tried to OPEN at
// t=0, that key was dropped, and what survived was zeros.
//
// Nothing on the JavaScript side can reach this: it is C#, and the behaviour
// being guarded belongs to Unity. So it is tested here, where it lives.
using System.Collections.Generic;
using GenStudio3D.VfxImport;
using NUnit.Framework;
using UnityEngine;

namespace GenStudio3D.VfxImport.Tests
{
    public class VfxRateGateTests
    {
        private static float ValueAt(AnimationCurve curve, float time)
        {
            return curve.Evaluate(time);
        }

        [Test]
        public void AddStep_ReplacesAKeyAtTheSameTime()
        {
            var curve = new AnimationCurve();
            VfxShurikenBuilder.AddStep(curve, 0f, 0f);
            VfxShurikenBuilder.AddStep(curve, 0f, 1f);

            Assert.AreEqual(1, curve.length, "a second step at the same time must not add a key");
            Assert.AreEqual(1f, curve[0].value, 1e-4f,
                "the later step is the state from that instant on, so it must win");
        }

        [Test]
        public void AddStep_KeepsStepping()
        {
            var curve = new AnimationCurve();
            VfxShurikenBuilder.AddStep(curve, 0f, 1f);
            VfxShurikenBuilder.AddStep(curve, 0.5f, 0f);

            // Halfway between the keys the rate must still be FULL, not half.
            // A ramp here trickles particles out through what is meant to be
            // silence, which reads as the emitter leaking rather than as the
            // curve interpolating.
            Assert.AreEqual(1f, ValueAt(curve, 0.25f), 1e-3f);
            Assert.AreEqual(0f, ValueAt(curve, 0.75f), 1e-3f);
        }

        [Test]
        public void AClipStartingAtZeroIsOpenAtZero()
        {
            // THE REPORTED BUG, as the exported Fire effect had it: one clip at
            // t=0 lasting 2.133s of a 3s effect.
            var clips = new List<VfxShurikenBuilder.Clip>
            {
                new VfxShurikenBuilder.Clip { At = 0f, Seconds = 2.1333f, OpenEnded = false },
            };
            var curve = VfxShurikenBuilder.BuildRateGate(clips, 3f);

            Assert.AreEqual(1f, ValueAt(curve, 0f), 1e-3f,
                "a clip that starts at zero has to be emitting at zero");
            Assert.AreEqual(1f, ValueAt(curve, 0.5f), 1e-3f, "and through its window");
            Assert.AreEqual(0f, ValueAt(curve, 0.9f), 1e-3f, "and silent after it closes");
        }

        [Test]
        public void ALaterClipIsSilentBeforeItOpens()
        {
            var clips = new List<VfxShurikenBuilder.Clip>
            {
                new VfxShurikenBuilder.Clip { At = 1f, Seconds = 1f, OpenEnded = false },
            };
            var curve = VfxShurikenBuilder.BuildRateGate(clips, 4f);

            Assert.AreEqual(0f, ValueAt(curve, 0.1f), 1e-3f);
            Assert.AreEqual(1f, ValueAt(curve, 0.3f), 1e-3f);
            Assert.AreEqual(0f, ValueAt(curve, 0.6f), 1e-3f);
        }

        [Test]
        public void SeveralWindowsOnOneTrackAllSurvive()
        {
            // The case the whole curve approach exists for: N spawn windows on
            // one track, which a burst list cannot express and a VFX Graph
            // template would run out of slots for.
            var clips = new List<VfxShurikenBuilder.Clip>
            {
                new VfxShurikenBuilder.Clip { At = 0f, Seconds = 1f, OpenEnded = false },
                new VfxShurikenBuilder.Clip { At = 2f, Seconds = 1f, OpenEnded = false },
            };
            var curve = VfxShurikenBuilder.BuildRateGate(clips, 4f);

            Assert.AreEqual(1f, ValueAt(curve, 0.1f), 1e-3f, "first window open");
            Assert.AreEqual(0f, ValueAt(curve, 0.375f), 1e-3f, "gap between them");
            Assert.AreEqual(1f, ValueAt(curve, 0.6f), 1e-3f, "second window open");
            Assert.AreEqual(0f, ValueAt(curve, 0.9f), 1e-3f, "silent after the last");
        }

        [Test]
        public void NoGateIsEverFlatZero()
        {
            // The property that was actually violated, stated directly: a gate
            // built for ANY clip must be emitting somewhere, or the effect is
            // silent and the report is lying about it.
            var cases = new[]
            {
                new VfxShurikenBuilder.Clip { At = 0f, Seconds = 0.5f, OpenEnded = false },
                new VfxShurikenBuilder.Clip { At = 0f, Seconds = 3f, OpenEnded = false },
                new VfxShurikenBuilder.Clip { At = 0.25f, Seconds = 0.1f, OpenEnded = false },
                new VfxShurikenBuilder.Clip { At = 0f, Seconds = 0f, OpenEnded = true },
                new VfxShurikenBuilder.Clip { At = 2.9f, Seconds = 0.5f, OpenEnded = false },
            };

            foreach (var clip in cases)
            {
                var curve = VfxShurikenBuilder.BuildRateGate(
                    new List<VfxShurikenBuilder.Clip> { clip }, 3f);

                var peak = 0f;
                for (var t = 0f; t <= 1f; t += 0.01f)
                {
                    peak = Mathf.Max(peak, ValueAt(curve, t));
                }
                Assert.Greater(peak, 0.5f,
                    $"a clip at {clip.At}s for {clip.Seconds}s produced a gate that never opens");
            }
        }
    }
}
