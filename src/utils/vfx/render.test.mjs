// Checks for the render layer: instance layout, the buffer write, the depth
// sort, the material family and the built-in sprite.
//
//     node src/utils/vfx/render.test.mjs
//
// three.js constructs geometries, materials and interleaved buffers perfectly
// well under plain `node` - only WebGLRenderer needs a context. So everything
// up to the actual draw call is testable here, and that is worth doing because
// the render layer's failure mode is uniquely bad: a wrong offset does not
// error, it makes every particle read its neighbour's size as its colour, and
// the result looks like a shader bug rather than the bookkeeping mistake it is.
//
// KNOWN GAP, and it is a real one: nothing here proves anything about the
// PIXELS. A swapped colour channel, an inverted V, a blend factor that is
// subtly wrong, ACES desaturating a bright core more than expected - all of
// those pass every check below. They need eyes on a frame, and the plan calls
// for exactly that: the VFX preview side by side with the assembly viewport.
// What this file guarantees is that the data reaching the GPU is the data the
// simulation produced, and that the shader declares the attributes the
// geometry actually provides.
import { compileVfxGraph } from '../../../vfx/compile.js';
import { buildInstanceLayout } from '../../../vfx/ir.js';
import { VFX_TEMPLATES, templateById } from './templates.js';
import { createBatch, createBatches, disposeBatch, writeBatch } from './batch.js';
import { buildVertexShader, createParticleMaterial } from './materials.js';
import { getDefaultSprite } from './assets.js';
import { sortIndicesByValue } from './sort.js';
import { createVfxRuntime, step } from './system.js';
import { aliveCount, liveParticleBounds } from '../vfxThumbnail.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

function buildTemplate(id) {
  const template = templateById(id);
  const { ir, diagnostics } = compileVfxGraph(template.build());
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`${id} has compile errors: ${errors.map((d) => d.code).join(' ')}`);
  return ir;
}

// ---------------------------------------------------------------------------
// 1. The layout table
// ---------------------------------------------------------------------------
{
  const plain = buildInstanceLayout({
    mode: 'billboard',
    attributes: ['position', 'size', 'color'],
    smoothing: false,
  });
  check('a plain billboard pays for nothing extra', plain.stride === 8,
    `stride ${plain.stride}: ${plain.fields.map((f) => f.name).join(' ')}`);

  const stretched = buildInstanceLayout({
    mode: 'stretched',
    attributes: ['position', 'size', 'color', 'velocity'],
  });
  check('a stretched billboard carries velocity', stretched.stride === 11
    && stretched.fields.some((f) => f.name === 'iVelocity'), `stride ${stretched.stride}`);

  // Velocity is requested by the mode but the system has none: the field must
  // be dropped rather than declared, because a shader that references an
  // attribute the geometry lacks reads silent zeros in WebGL rather than
  // erroring - so the streak would point in a fixed direction and look like a
  // shader bug.
  const missing = buildInstanceLayout({
    mode: 'stretched',
    attributes: ['position', 'size', 'color'],
  });
  check('  and drops it when the system has none', missing.stride === 8, `stride ${missing.stride}`);
}

{
  const layout = buildInstanceLayout({
    mode: 'billboard',
    attributes: ['position', 'size', 'color', 'velocity', 'rotation', 'flipbookFrame'],
    smoothing: true,
  });
  let offset = 0;
  const packed = layout.fields.every((field) => {
    const ok = field.offset === offset;
    offset += field.size;
    return ok;
  });
  check('fields are packed with no gaps', packed && offset === layout.stride,
    `stride ${layout.stride}`);

  const fromPool = layout.fields.every((field) => typeof field.from === 'string' && field.from.length > 0);
  check('  and every field names its pool attribute', fromPool,
    layout.fields.map((f) => `${f.name}<-${f.from}`).join(' '));
}

// ---------------------------------------------------------------------------
// 2. The shader declares exactly what the geometry provides
// ---------------------------------------------------------------------------
{
  // The desync this guards against: a shader that declares iVelocity when the
  // layout omitted it compiles fine and reads zeros.
  const layout = buildInstanceLayout({ mode: 'billboard', attributes: ['position', 'size', 'color'] });
  const source = buildVertexShader(layout);
  check('no velocity attribute without a velocity field', !source.includes('attribute vec3 iVelocity;'));

  const withVelocity = buildInstanceLayout({
    mode: 'stretched',
    attributes: ['position', 'size', 'color', 'velocity'],
  });
  check('  and one when there is', buildVertexShader(withVelocity).includes('attribute vec3 iVelocity;'));

  const declared = buildVertexShader(withVelocity)
    .split('\n')
    .filter((line) => line.startsWith('attribute'))
    .length;
  // iPos, iSize, iColor, iVelocity - and position/uv come from the geometry
  // through three's own prefix, not from here.
  check('  declaring one attribute per field', declared === withVelocity.fields.length,
    `${declared} declarations for ${withVelocity.fields.length} fields`);
}

// ---------------------------------------------------------------------------
// 3. Blend state, and the double-multiply trap
// ---------------------------------------------------------------------------
{
  const layout = buildInstanceLayout({ mode: 'billboard', attributes: ['position', 'size', 'color'] });
  const make = (blend) => createParticleMaterial({ layout, blend, texture: getDefaultSprite() });

  const additive = make('additive');
  const alpha = make('alpha');
  const premultiplied = make('premultiplied');
  const opaque = make('opaque');

  // THE TRAP. three's AdditiveBlending is (SrcAlpha, One), so the GPU already
  // multiplies rgb by alpha. A shader that also premultiplied would square the
  // alpha, and a fade to 25% opacity would dim to 6% - the tail of every
  // additive effect vanishing early. Only the premultiplied mode may define it.
  check('additive does NOT premultiply in the shader',
    !('PREMULTIPLY' in additive.defines) && !('PREMULTIPLY' in alpha.defines));
  check('  while the premultiplied mode does', 'PREMULTIPLY' in premultiplied.defines);

  check('transparency and depth write follow the mode',
    additive.transparent && !additive.depthWrite
    && alpha.transparent && !alpha.depthWrite
    && !opaque.transparent && opaque.depthWrite);
  // Depth TEST stays on for additive: solid geometry in front should hide a
  // particle, even though the particle must not occlude the one behind it.
  check('  with depth test on throughout', [additive, alpha, premultiplied, opaque].every((m) => m.depthTest));

  for (const material of [additive, alpha, premultiplied, opaque]) material.dispose();
}

{
  const layout = buildInstanceLayout({ mode: 'billboard', attributes: ['position', 'size', 'color'] });
  // Tone mapping on by default is the decision the plan asked to be verified:
  // three injects TONE_MAPPING from material.toneMapped, so false here would
  // silently bypass ACES and the sRGB encode that every other viewport applies.
  const on = createParticleMaterial({ layout, texture: getDefaultSprite() });
  const off = createParticleMaterial({ layout, texture: getDefaultSprite(), toneMapped: false });
  check('tone mapping is on by default', on.toneMapped === true && off.toneMapped === false);
  check('  and the shader includes three chunks for it',
    on.fragmentShader.includes('#include <tonemapping_fragment>')
    && on.fragmentShader.includes('#include <colorspace_fragment>'));
  on.dispose();
  off.dispose();
}

{
  const layout = buildInstanceLayout({ mode: 'billboard', attributes: ['position', 'size', 'color'] });
  const untextured = createParticleMaterial({ layout, texture: null });
  const textured = createParticleMaterial({ layout, texture: getDefaultSprite() });
  check('USE_MAP tracks whether there is a texture',
    !('USE_MAP' in untextured.defines) && 'USE_MAP' in textured.defines);
  untextured.dispose();
  textured.dispose();
}

// ---------------------------------------------------------------------------
// 4. The built-in sprite
// ---------------------------------------------------------------------------
{
  const sprite = getDefaultSprite();
  const { data, width, height } = sprite.image;
  const at = (x, y) => data[(y * width + x) * 4 + 3];
  const centre = at(width >> 1, height >> 1);
  const corner = at(0, 0);
  const edge = at(width >> 1, 0);

  check('the sprite is opaque at the centre and clear at the rim',
    centre > 250 && corner === 0 && edge === 0,
    `centre ${centre}, corner ${corner}, edge ${edge}`);

  // White rgb with only alpha falling off is what makes it read correctly under
  // every blend mode - a coloured falloff would tint additive particles.
  let white = true;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) white = false;
  }
  check('  with white rgb throughout', white);

  // Monotonic falloff: a visible ring would show as a hard edge on every
  // particle in the app.
  let monotonic = true;
  for (let x = width >> 1; x < width - 1; x += 1) {
    if (at(x + 1, height >> 1) > at(x, height >> 1)) monotonic = false;
  }
  check('  and a monotonic falloff', monotonic);
  check('  no mipmaps, so a future atlas cannot bleed frames', sprite.generateMipmaps === false);
  check('  same instance every call', getDefaultSprite() === sprite);
  check(`  ${width}x${height}`, width === 64 && height === 64);
}

// ---------------------------------------------------------------------------
// 5. The buffer write carries the simulation's data
// ---------------------------------------------------------------------------
{
  const ir = buildTemplate('sparks');
  const runtime = createVfxRuntime(ir);
  for (let i = 0; i < 10; i += 1) step(runtime);

  const batches = createBatches(ir, runtime.emitters, {});
  check('one batch for a one-output effect', batches.length === 1, `${batches.length} batches`);

  const batch = batches[0];
  const written = writeBatch(batch, { x: 0, y: 0, z: -1 });
  const pool = runtime.emitters[0].pool;
  check('every live particle is written', written === pool.count, `${written} of ${pool.count}`);
  check('  and instanceCount matches', batch.geometry.instanceCount === written);

  // THE CASE THIS FILE EXISTS FOR. Every field of every instance must equal the
  // pool value it came from. An offset wrong by one float passes a count check
  // and fails this.
  let worst = 0;
  let compared = 0;
  const stride = batch.layout.stride;
  for (const field of batch.layout.fields) {
    const plane = pool.planes[field.from];
    for (let i = 0; i < written; i += 1) {
      for (let c = 0; c < field.size; c += 1) {
        const got = batch.data[i * stride + field.offset + c];
        const want = plane[i * field.size + c];
        worst = Math.max(worst, Math.abs(got - want));
        compared += 1;
      }
    }
  }
  check('instance data matches the pool field for field', worst === 0 && compared > 500,
    `${compared} values compared, worst delta ${worst}`);

  // Only the live range is uploaded: at 10% of capacity that is 10% of the
  // bytes on the biggest per-frame transfer in the renderer.
  const ranges = batch.buffer.updateRanges;
  check('only the live range is uploaded',
    ranges.length === 1 && ranges[0].start === 0 && ranges[0].count === written * stride,
    `count ${ranges[0]?.count} of ${batch.data.length}`);

  for (const b of batches) disposeBatch(b);
}

{
  // An effect whose particle count exceeds the batch must clamp rather than
  // write past the end of the array.
  const ir = buildTemplate('sparks');
  const runtime = createVfxRuntime(ir);
  for (let i = 0; i < 5; i += 1) step(runtime);
  const batch = createBatch({
    output: ir.systems[0].outputs[0],
    sources: runtime.emitters,
    capacity: 4,
  });
  // createBatch rounds capacity up to a multiple of 256, so asking for 4 slots
  // does not produce a batch smaller than the particle count. Shrink it
  // directly instead - the clamp reads batch.instances, so this exercises the
  // real branch rather than a contrived capacity.
  batch.instances = 8;
  const written = writeBatch(batch, { x: 0, y: 0, z: -1 });
  check('the write clamps to the batch size', written === 8 && written < runtime.emitters[0].pool.count,
    `${written} of ${runtime.emitters[0].pool.count} particles into ${batch.instances} slots`);
  disposeBatch(batch);
}

{
  // Three systems with three different material states must not be merged.
  const ir = buildTemplate('muzzleFlash');
  const runtime = createVfxRuntime(ir);
  const batches = createBatches(ir, runtime.emitters, {});
  check('distinct material state means distinct batches', batches.length === 3, `${batches.length} batches`);

  // And a batch with no texture of its own still gets the built-in sprite, so
  // nothing ever draws an untextured square.
  const allTextured = batches.every((b) => b.material.uniforms.uMap.value !== null);
  check('  every batch has a sprite bound', allTextured);
  for (const b of batches) disposeBatch(b);
}

// ---------------------------------------------------------------------------
// 6. The depth sort
// ---------------------------------------------------------------------------
{
  // Against a comparison sort, on values that straddle zero - which is where
  // the float-bits trick earns its keep, since a negative float's bit pattern
  // orders backwards as an unsigned integer.
  const values = new Float32Array(2000);
  let seed = 12345;
  for (let i = 0; i < values.length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    values[i] = ((seed >>> 8) / 0x1000000) * 200 - 100;
  }
  const got = sortIndicesByValue(values);
  const want = Array.from({ length: values.length }, (_, i) => i)
    .sort((a, b) => values[a] - values[b]);

  let ordered = true;
  for (let i = 1; i < got.length; i += 1) {
    if (values[got[i]] < values[got[i - 1]]) ordered = false;
  }
  check('the radix sort orders across zero', ordered);
  check('  agreeing with a comparison sort',
    want.every((index, i) => near(values[index], values[got[i]])));
}

{
  const values = new Float32Array([5, 5, 5, 5]);
  const order = sortIndicesByValue(values);
  // Every key sharing a digit means every pass is skippable; the result must
  // still be a valid permutation rather than an empty or duplicated one.
  check('identical keys still yield a permutation',
    new Set(order).size === 4 && order.length === 4, Array.from(order).join(','));
}

{
  const ir = buildTemplate('smoke');
  const runtime = createVfxRuntime(ir);
  for (let i = 0; i < 60; i += 1) step(runtime);
  const batches = createBatches(ir, runtime.emitters, {});
  const batch = batches[0];
  check('the smoke template asks for depth sorting', batch.output.sort === 'depth');

  writeBatch(batch, { x: 0, y: 0, z: -1 });
  const pool = runtime.emitters[0].pool;
  const stride = batch.layout.stride;
  // Back to front along the view direction. With the camera looking down -Z,
  // a far particle has a very negative z and a near one is closer to zero, so
  // far-to-near means written z should be ASCENDING. (This assertion was
  // inverted on the first attempt, which is a fair warning about how easy the
  // sign is to get backwards - see the comment in sort.js.)
  let backToFront = true;
  for (let i = 1; i < batch.written; i += 1) {
    if (batch.data[i * stride + 2] < batch.data[(i - 1) * stride + 2] - 1e-4) backToFront = false;
  }
  check('  and writes back to front', backToFront && batch.written === pool.count,
    `${batch.written} instances`);

  // Sorting reorders the WRITE, never the pool - the simulation's own ordering
  // is what makes it deterministic, and reordering it to please the camera
  // would make the checksum depend on where the camera was.
  const firstSeed = pool.planes.seed[0];
  writeBatch(batch, { x: 1, y: 0, z: 0 });
  check('  without touching the pool', pool.planes.seed[0] === firstSeed);

  for (const b of batches) disposeBatch(b);
}

// ---------------------------------------------------------------------------
// 7. Every template renders
// ---------------------------------------------------------------------------
{
  const rows = [];
  let allDrew = true;
  for (const template of VFX_TEMPLATES) {
    const ir = buildTemplate(template.id);
    const runtime = createVfxRuntime(ir);
    for (let i = 0; i < 30; i += 1) step(runtime);
    const batches = createBatches(ir, runtime.emitters, {});
    let drawn = 0;
    for (const batch of batches) drawn += writeBatch(batch, { x: 0, y: 0, z: -1 });
    if (drawn <= 0) allDrew = false;
    rows.push(`${template.id}:${drawn}/${batches.length}draw`);
    for (const batch of batches) disposeBatch(batch);
  }
  check('every template produces instances to draw', allDrew, rows.join(' '));
}

// ---------------------------------------------------------------------------
// 8. Thumbnail framing
// ---------------------------------------------------------------------------
//
// The RENDER cannot be tested here - it needs a WebGL context - but the two
// decisions that make a card usable are pure, and both of them had a bug.
{
  const ir = buildTemplate('sparks');
  const runtime = createVfxRuntime(ir);

  // This is what makes the simulated fallback fire. Capturing the live frame at
  // t = 0 would save an empty card, and an empty card reads as a broken
  // feature rather than as the author having caught a bad moment.
  check('nothing is alive before the first step', aliveCount(runtime) === 0);

  for (let i = 0; i < 30; i += 1) step(runtime);
  const alive = aliveCount(runtime);
  check('  and particles are alive after 30 steps', alive > 0, String(alive));

  const box = liveParticleBounds(runtime);
  check('  so the framing box is not empty', !box.isEmpty());

  // THE BUG THIS CATCHES: the first version grew the box by EVERY particle's
  // radius in turn, so the box scaled with the particle COUNT rather than with
  // the particle SIZE - a few hundred sparks inflated it by tens of units and
  // framed the effect as a distant speck. Measured against the raw extent of
  // the positions, the padding has to be a couple of particle radii.
  let lo = Infinity;
  let hi = -Infinity;
  let maxSize = 0;
  for (const emitter of runtime.emitters) {
    const { planes, count } = emitter.pool;
    for (let i = 0; i < count; i += 1) {
      const y = planes.position[i * 3 + 1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
      if (planes.size[i] > maxSize) maxSize = planes.size[i];
    }
  }
  const padding = (box.max.y - box.min.y) - (hi - lo);
  check('  padded by the LARGEST radius, not the sum of all of them',
    padding <= maxSize * 2 + 1e-3,
    `padding ${padding.toFixed(4)}, largest particle ${maxSize.toFixed(4)}, ${alive} alive`);

  // The sum-of-radii version passed this one too, so on its own it proves
  // nothing - it is here to stop a fix that pads by too little.
  check('  and it still contains every particle',
    box.min.y <= lo + 1e-6 && box.max.y >= hi - 1e-6);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
