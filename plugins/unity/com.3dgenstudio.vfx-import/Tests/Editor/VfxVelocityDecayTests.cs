// Drag has to bleed a velocity away the way the preview does, and a random
// velocity has to actually move.
//
// WHY THIS FILE EXISTS. The app's drag is `accel -= velocity * k` (kernels.js
// 'force.drag') - linear in speed, blind to particle size - and NOTHING in
// Shuriken's drag reproduces it. Measured with a single-particle probe:
//
//   limitVelocityOverLifetime.drag, multiplyDragByParticleVelocity ON
//     -> 1/v is linear in t. QUADRATIC. A shockwave at 25 m/s with k=7 that
//        should travel 3.6m travelled 0.01m: stopped dead.
//   the same, multiplyDragByParticleVelocity OFF
//     -> v falls by k m/s per second. CONSTANT deceleration. The same
//        shockwave travelled 35.9m: never stopped.
//
// velocityOverLifetime.speedModifier is the one that works, because it is not
// a force - it scales the particle's speed by a curve, so exp(-k*t) integrates
// to exactly the preview's trajectory. DragDecayCurve builds that curve, and
// these tests pin its shape.
//
// MEASURED ON A REAL EFFECT: a nuclear blast's stem rises at 9-15 m/s with drag
// 1.1 and a 2.6s life. The app's stem tops out at 12.8m, exactly reaching the
// mushroom cap at 11.5m. Undamped, Unity's reached 31m - nearly three times as
// far - so the column stretched thin and the cap floated detached above it.
// Nothing about it looked like a bug; it looked like the effect had been
// authored badly.
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
        public void HeavyDragStillTracksTheCurveNearBirth()
        {
            // THE SAMPLING TRAP. An exponential does nearly all of its falling
            // in the first fraction of the curve, and the more drag there is
            // the earlier that happens. Twelve UNIFORM samples resolved the
            // flat tail beautifully and missed the bend, overshooting the
            // analytic distance by 47% at drag 7; the keys are square-spaced so
            // most of them land where the curve is actually moving.
            const float Drag = 7f;
            const float Life = 0.7f;
            var curve = VfxShurikenBuilder.DragDecayCurve(Drag, Life);

            foreach (var u in new[] { 0.02f, 0.05f, 0.1f, 0.2f, 0.5f })
            {
                var expected = Mathf.Exp(-Drag * u * Life);
                Assert.AreEqual(expected, curve.Evaluate(u), 0.02f,
                    $"at {u:F2} of life a heavily dragged particle should be at {expected:F3}");
            }
        }

        [Test]
        public void TheStemReachesTheCapRatherThanOvershooting()
        {
            // THE REPORTED BUG, as arithmetic. Integrating the imposed velocity
            // over the particle's life gives the height it reaches; the
            // undamped curve overshot by 2.6x and the decaying one lands on the
            // preview's own answer.
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

        [Test]
        public void ASustainedForceRampsUpToTerminalSpeedRatherThanStartingThere()
        {
            // THE MIRROR OF THE DECAY CURVE, and the distinction the mushroom
            // cap turns on: a launch velocity starts at full speed and bleeds
            // away, a FORCE starts at nothing and builds to a terminal speed it
            // then holds for the rest of the particle's life. Using the wrong
            // one of the two froze the cap at the radius it was born with.
            const float Accel = 1f;
            const float Drag = 2f;
            const float Life = 3.6f;
            var curve = VfxShurikenBuilder.ForceRampCurve(Accel, Drag, Life);

            Assert.AreEqual(0f, curve.Evaluate(0f), 1e-3f, "a force has done nothing at birth");
            foreach (var u in new[] { 0.05f, 0.1f, 0.25f, 0.5f, 1f })
            {
                var expected = (Accel / Drag) * (1f - Mathf.Exp(-Drag * u * Life));
                Assert.AreEqual(expected, curve.Evaluate(u), 0.02f,
                    $"at {u:F2} of life the force should have reached {expected:F3} m/s");
            }
            Assert.AreEqual(Accel / Drag, curve.Evaluate(1f), 0.02f,
                "and it should be holding the terminal speed by the end, not falling off it");
        }

        [Test]
        public void AForceWithNoDragJustKeepsAccelerating()
        {
            // No drag means no terminal speed: v = a*t, all the way out.
            var curve = VfxShurikenBuilder.ForceRampCurve(2f, 0f, 3f);
            Assert.AreEqual(0f, curve.Evaluate(0f), 1e-3f);
            Assert.AreEqual(6f, curve.Evaluate(1f), 1e-3f, "2 m/s^2 for 3s is 6 m/s");
        }

        [Test]
        public void ARangedVelocityCarriesBothEnds()
        {
            var ranged = VfxShurikenBuilder.Ranged(9f, 15f);
            Assert.AreEqual(9f, ranged.Evaluate(0.5f, 0f), 1e-3f, "the low end");
            Assert.AreEqual(15f, ranged.Evaluate(0.5f, 1f), 1e-3f, "the high end");
            Assert.AreEqual(12f, ranged.Evaluate(0.5f, 0.5f), 1e-3f, "halfway between");
        }

        [Test]
        public void ARangedVelocityIsOrderedWhicheverWayItIsGiven()
        {
            var backwards = VfxShurikenBuilder.Ranged(15f, 9f);
            Assert.AreEqual(9f, backwards.Evaluate(0.5f, 0f), 1e-3f);
            Assert.AreEqual(15f, backwards.Evaluate(0.5f, 1f), 1e-3f);
        }

        [Test]
        public void EveryAxisOfARangedVelocitySharesOneCurveMode()
        {
            // THE TRAP THAT STOPPED THE STEM DEAD, and it is invisible in the
            // inspector. A 3D module keeps ONE curve mode for x, y and z
            // together. A straight-up velocity has zero on x and z, so
            // returning a plain Constant for a degenerate range - which reads
            // as the obvious simplification - put x and z in Constant mode and
            // y in TwoCurves. Unity resolves the disagreement by evaluating y
            // as ZERO: the prefab serialises all the right numbers and the
            // particles do not move at all.
            var zero = VfxShurikenBuilder.Ranged(0f, 0f);
            var up = VfxShurikenBuilder.Ranged(9f, 15f);

            Assert.AreEqual(up.mode, zero.mode,
                "a degenerate range must use the same MinMaxCurve mode as a real one, or the "
                + "axes of a single velocity disagree and Unity zeroes the ones that differ");
            Assert.AreEqual(0f, zero.Evaluate(0.5f, 0f), 1e-4f, "and it still has to mean zero");
            Assert.AreEqual(0f, zero.Evaluate(0.5f, 1f), 1e-4f);
        }
    }
}
