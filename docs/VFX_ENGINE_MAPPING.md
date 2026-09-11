# VFX engine mapping

**Generated from `vfx/catalog.js` by `tools/gen-vfx-mapping.mjs`. Do not edit.**
Run `node tools/gen-vfx-mapping.mjs` after changing a catalog entry, or
`npm run check:vfx` to find out that you have not.

IR format: **1**. Targets: **Unity VFX Graph** and **Unreal Niagara**.

`yes` means a direct equivalent exists and parameters map one to one.
`approx` means something close exists with different semantics, and the
importer reports it. `NO` means no equivalent: the importer drops it and
says so. Compatibility is surfaced at **author** time - every block and
operator carries these flags in the editor, and setting a target raises a
real diagnostic - so nothing here should be a surprise at import time.

## Coverage

| Engine | Native | Approximate | Unsupported |
|---|---|---|---|
| Unity VFX Graph | 45 | 3 | 0 |
| Unreal Niagara | 45 | 3 | 0 |

## What survives, and what does not

The contract is **Statistical conformance: matching spawn counts, lifetime distributions, colour ramps, shapes and bounds.**

Surviving exactly:

- Graph topology: which systems exist, and which contexts each one has.
- Block order within every context stack.
- Every authored curve and gradient key, including tangents and interpolation mode - Hermite keys map field for field onto Unity Keyframes and Niagara FRichCurveKeys.
- Every constant, and the LOW and HIGH ends of every random range.
- Emitter shapes and their offsets and rotations.
- Blend modes, sort modes, render modes and flipbook layouts.
- Clip timing, as native spawn delays, loop durations and burst times.
- Blackboard properties, as Unity exposed properties and Niagara User Parameters.
- Seeds - so an engine reproduces its own result exactly, run after run.

Not surviving:

- Exact per-particle numbers. Each engine has its own RNG and neither accepts an injected one, so individual particles differ.
- Frame-exact positions, for the same reason plus a different integrator.
- Anything marked APPROX or NONE in the tables below - the importer reports each one rather than silently dropping it.

## Blocks

### Spawn

| Block | id | Unity | Unreal | Notes |
|---|---|---|---|---|
| Spawn Rate | `spawn.rate` | yes | yes | Unity: Constant Spawn Rate. Niagara: Spawn Rate module. |
| Spawn Burst | `spawn.burst` | yes | yes | Unity: Single Burst. Niagara: Spawn Burst Instantaneous. |

### Initialize

| Block | id | Unity | Unreal | Notes |
|---|---|---|---|---|
| Set Lifetime | `initialize.setLifetime` | yes | yes | Unity: Set Lifetime. Niagara: Initialize Particle > Lifetime. |
| Set Size | `initialize.setSize` | yes | yes |  |
| Set Colour | `initialize.setColor` | yes | yes |  |
| Position: Sphere | `initialize.positionSphere` | yes | yes | Unity: Position (Sphere). Niagara: Sphere Location. |
| Cone Emitter | `initialize.positionCone` | yes | yes | Unity: Position (Cone) plus Set Velocity from Direction. Niagara: Cone Location, which sets position and velocity in one module exactly as this does. |
| Velocity: Random | `initialize.velocityRandom` | yes | yes | Unity: Set Velocity Random. Niagara: Add Velocity. |
| Position in Box | `initialize.positionBox` | yes | yes | Unity: Position (AABox). Niagara: Box Location. |
| Position in Circle | `initialize.positionCircle` | yes | yes | Unity: Position (Circle). Niagara: Cylinder/Ring Location. |
| Position: Point | `initialize.positionPoint` | yes | yes | Unity: Set Position (plus Position (Sphere) for the jitter). Niagara: Add Position / Sphere Location with a small radius. |
| Position: Line | `initialize.positionLine` | approx | yes | Shuriken has no line shape, so the Unity importer lays a thin box along the segment - the right span, but particles scatter across its girth rather than sitting on the line. Unreal takes it exactly: a line is a two-point path, so it goes down the same road as the Curve emitter and becomes a Vector Curve on Position. Fixed spacing is the one mode neither engine reproduces; it becomes an even spread. |
| Position: Curve | `initialize.positionCurve` | approx | yes | The two engines are furthest apart on this block. Unity's shape module has no curve at all - the full list is Sphere, Cone, Box, Circle, Donut and Mesh, none of which bends - so the importer approximates the path with the straight chord through its end points and says so; bake a sprite sheet if the bend itself is the point. Unreal carries it whole: the path becomes a Vector Curve data interface keyed by distance along the curve, sampled per particle, and Tangent speed becomes a second curve of unit tangents driving Add Velocity - so particles both sit on the path and travel it. Thickness is the one part Niagara does not take; add a Jitter Position module to scatter them around the line. |
| Position: Mesh | `initialize.positionMesh` | yes | yes | Unity: Position (Mesh), which offers the same Surface/Vertex choice. Niagara: Static Mesh Location, which needs the mesh assigned on the emitter as well. Asset slots: mesh (mesh). |
| Velocity Outward | `initialize.velocityRadial` | yes | yes | Unity: Velocity from Direction & Speed (Direction = position). Niagara: Add Velocity in Cone / radial. |
| Velocity in Direction | `initialize.velocityDirection` | yes | yes | Unity: Velocity from Direction & Speed. Niagara: Add Velocity in Cone. |
| Inherit Velocity | `initialize.inheritVelocity` | yes | yes | Unity: Inherit Source Velocity. Niagara: the event payload is read directly. |
| Set Rotation | `initialize.setRotation` | yes | yes |  |
| Set Sprite Frame | `initialize.setFlipbookFrame` | yes | yes |  |

### Update

| Block | id | Unity | Unreal | Notes |
|---|---|---|---|---|
| Add Gravity | `update.gravity` | yes | yes | Unity: Gravity. Niagara: Gravity Force. |
| Add Drag | `update.drag` | yes | yes | Unity: Linear Drag. Niagara: Drag. |
| Add Turbulence | `update.turbulence` | approx | approx | Unreal is the closer of the two here: Niagara's Curl Noise Force is curl noise, the same divergence-free field this preview uses, so the CHARACTER of the motion matches and only the amplitude and frequency scaling differ. Unity's noise module is VALUE noise, which swirls differently at the same strength - the importer says so rather than letting it pass as an exact match. |
| Size Over Life | `update.sizeOverLife` | yes | yes | Unity: Set Size over Life. Niagara: Scale Sprite Size with a float curve. |
| Colour Over Life | `update.colorOverLife` | yes | yes | Unity: Set Color over Life. Niagara: Color module with a colour curve. |
| Spin | `update.spin` | yes | yes |  |
| Attract to Point | `update.attractor` | yes | approx | Niagara has Point Attraction Force, but its falloff curve differs - the shape is the same, the exact strength at a given distance is not. |
| Vortex | `update.vortex` | yes | yes | Unity: Vortex Force. Niagara: Vortex Force. |
| Speed Limit | `update.speedLimit` | yes | approx | Niagara clamps speed INSIDE Solve Forces and Velocity rather than as its own module, so the importer reports the value to set on that module's Speed Limit instead of adding anything. Clamping anywhere else would clamp last frame's velocity while this frame's acceleration immediately exceeds it again. |
| Collide with Floor | `update.collidePlane` | yes | yes | Unity: Collide with Plane. Niagara: Collision (Plane). |
| Collide with Sphere | `update.collideSphere` | yes | yes | Unity: Collide with Sphere. Niagara: Collision (Analytical, sphere). |
| Collide with Box | `update.collideBox` | yes | yes | Unity: Collide with AABox. Niagara: Collision (Analytical, box). |
| Kill Outside Box | `update.killOnBounds` | yes | yes | Unity: Kill (AABox). Niagara: Kill Particles In Volume. |
| Play Sprite Sheet | `update.flipbook` | yes | yes | Unity: Flipbook Player / Set Tex Index. Niagara: SubUV Animation. |

### Output

| Block | id | Unity | Unreal | Notes |
|---|---|---|---|---|
| Sprite Sheet | `output.setFlipbook` | yes | yes | Unity: Flipbook size on the output. Niagara: SubUV Texture rows/columns. |
| Particle Mesh | `output.setMesh` | yes | yes | Unity: Output Particle Mesh. Niagara: Mesh Renderer. Asset slots: mesh (mesh). |
| Sprite Texture | `output.setMainTexture` | yes | yes | Bound as the output material main texture in both engines. Asset slots: texture (texture). |

## Operators

| Operator | id | Unity | Unreal | Notes |
|---|---|---|---|---|
| Value | `op.constant` | yes | yes |  |
| Multiply | `op.multiply` | yes | yes |  |
| Effect Time | `op.time` | yes | yes |  |
| Particle Attribute | `op.getAttribute` | yes | yes |  |
| Add | `op.add` | yes | yes |  |
| Subtract | `op.subtract` | yes | yes |  |
| Divide | `op.divide` | yes | yes |  |
| Blend | `op.lerp` | yes | yes |  |
| Clamp | `op.clamp` | yes | yes |  |
| Remap | `op.remap` | yes | yes |  |
| Random Per Frame | `op.random` | yes | yes | The value differs from this preview: neither engine lets us inject our own generator. The structure of the randomness survives, the exact numbers do not. |
| Oscillate | `op.sine` | yes | yes |  |

## Event triggers

Each trigger declares the **payload** it carries, which is what lets a
child system inherit the right attributes without special-casing.

| Trigger | id | Payload | Unity | Unreal | Notes |
|---|---|---|---|---|---|
| the effect plays | `onPlay` | - | yes | yes |  |
| a particle dies | `onDeath` | position, velocity, seed | yes | yes | Unity: GPU Event (Trigger On Die). Niagara: Death Event Handler. |
| a particle hits something | `onCollide` | position, velocity, seed | yes | yes | Unity: GPU Event on a Collide block. Niagara: Collision Event Handler. |

## Property value modes

Every block property supports these, so the answer is the same wherever
the mode is offered.

| Mode | Unity | Unreal | Notes |
|---|---|---|---|
| Constant | yes | yes | A plain value on the block. |
| Random between two | yes | yes | Unity: Random Number with a per-particle seed. Niagara: Uniform Ranged Float/Vector. |
| Curve over life | yes | yes | Hermite keys transfer field for field. The IR also carries a baked table for hosts that cannot rebuild a curve. |
| Gradient over life | yes | yes | Colour and alpha keys stay in SEPARATE lists, because Unity's Gradient does and a merged list cannot round-trip. |
| Wired from an operator | yes | approx | Unity: an operator subgraph. Niagara has no free-form expression graph in a module, so a chain imports as a baked constant or a User Parameter unless the plugin ships a matching module. |
| Blackboard property | yes | yes | Unity exposed property; Niagara User Parameter. The only thing a host can change without a recompile. |

## Render modes

| Mode | Unity | Unreal | Notes |
|---|---|---|---|
| `billboard` | yes | yes | Unity: Output Particle Quad. Niagara: Sprite Renderer. |
| `stretched` | yes | yes | Unity: Output Particle Quad with Orient Along Velocity. Niagara: Sprite Renderer, Alignment = Velocity. |
| `mesh` | yes | yes | Unity: Output Particle Mesh. Niagara: Mesh Renderer. |
| `trail` | yes | yes | Unity: Output Particle Strip. Niagara: Ribbon Renderer. NOT drawn by this app's preview - it reports I_TRAIL_UNSUPPORTED and draws stretched billboards instead, so the value is authored blind. |
| `point` | yes | yes | Both draw it as a constant-screen-size quad, as the preview does. |

