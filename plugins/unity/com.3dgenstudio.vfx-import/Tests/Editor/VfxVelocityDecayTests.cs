// An imposed velocity has to fade the way drag makes it fade.
//
// WHY THIS FILE EXISTS. Shuriken has no "fire along this arbitrary vector" on
// the start module, so an authored start velocity becomes Velocity over
// Lifetime - and Unity's Velocity over Lifetime is an IMPOSED velocity,
// re-applied every frame, which Unity's own drag cannot touch. A constant curve
// therefore means the particle travels at full speed for its whole life.
//
// MEASURED ON A REAL EFFECT, not imagined: a nuclear blast's stem starts at
// 12 m/s with drag 1.1 and a 2.6s life. The app's stem tops out at 12.8m,
// exactly reaching the mushroom cap at 11.5m. Unity's reached 33.8m - nearly
// three times as far - so the column stretched thin and the cap appeared to
// float detached above it. Nothing about it looked like a bug; it looked like
// the effect had been authored badly.
using GenStudio3D.VfxImport;
using NUnit.Framework;
using UnityEngine;

namespace GenStudio3D.VfxImport.Tests
{
    public class VfxVelocityDecayTests
    {
        [Test]
        public void NoDragMeansNoDecay()
        {
            // Not an approximation: with no drag the preview does not slow the
            // particle either, so a flat curve is exactly right.
            var curve = VfxShurikenBuilder.DragDecayCurve(0f, 3f);
            Assert.AreEqual(1f, curve.Evaluate(0f), 1e-4f);
            Assert.AreEqual(1f, curve.Evaluate(0.5f), 1e-4f);
            Assert.AreEqual(1f, curve.Evaluate(1f), 1e-4f);
        }

        [Test]
        public void DragDecaysExponentially()
        {
            const float Drag = 1.1f;
            const float Life = 2.6f;
            var curve = VfxShurikenBuilder.DragDecayCurve(Drag, Life);

            Assert.AreEqual(1f, curve.Evaluate(0f), 1e-3f, "full speed at birth");
            foreach (var u in new[] { 0.25f, 0.5f, 0.75f, 1f })
            {
                var expected = Mathf.Exp(-Drag * u * Life);
                Assert.AreEqual(expected, curve.Evaluate(u), 0.02f,
                    $"at {u:F2} of life the velocity should be {expected:F3} of its original");
            }
        }

        [Test]
        public void TheStemReachesTheCapRatherThanOvershooting()
        {
            // THE REPORTED BUG, as arithmetic. Integrating the imposed velocity
            // over the particle's life gives the height it reaches; the constant
            // curve overshot by 2.6x and the decaying one lands on the preview's
            // own answer.
            const float Speed = 12f;
            const float Drag = 1.1f;
            const float Buoyancy = 1.6f;
            const float Life = 2.6f;
            const float Step = 1f / 600f;

            var curve = VfxShurikenBuilder.DragDecayCurve(Drag, Life);

            float preview = 0f, previewV = Speed;
            float constantHeight = 0f, decayedHeight = 0f, gravityV = 0f;
            for (var t = 0f; t < Life; t += Step)
            {
                previewV += (Buoyancy - Drag * previewV) * Step;
                preview += previewV * Step;

                gravityV += (Buoyancy - Drag * gravityV) * Step;
                constantHeight += (Speed + gravityV) * Step;
                decayedHeight += (Speed * curve.Evaluate(t / Life) + gravityV) * Step;
            }

            Assert.Greater(constantHeight, preview * 2f,
                "a constant imposed velocity should overshoot badly - if it does not, "
                + "this test is no longer measuring the bug it was written for");
            Assert.AreEqual(preview, decayedHeight, preview * 0.1f,
                $"the decayed velocity should land within 10% of the preview's {preview:F1}m, "
                + $"got {decayedHeight:F1}m");
        }
    }
}
