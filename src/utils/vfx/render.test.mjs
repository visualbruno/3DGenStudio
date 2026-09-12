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
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { paintSheet } from '../../../tools/vfx-asset-writers.mjs';
import {
  decodePng,
  downscaleRgba,
  encodePng,
  matteOnCheckerboard,
} from '../../../vfx/png.js';
import {
  boundsOfEmitters,
  cameraPlacement,
  drawnRadius,
  focusBounds,
  frameBounds,
} from '../../../vfx/preview.js';
import { compileVfxGraph } from '../../../vfx/compile.js';
import { normalizeVfxDoc } from '../../../vfx/doc.js';
import * as edits from './edits.js';
import { buildInstanceLayout } from '../../../vfx/ir.js';
import { VFX_TEMPLATES, templateById } from './templates.js';
import { createBatch, createBatches, disposeBatch, writeBatch } from './batch.js';
import { buildVertexShader, createParticleMaterial } from './materials.js';
import { MAX_SHEET_PIXELS, planSpriteSheet } from './spriteSheet.js';
import { getDefaultSprite } from './assets.js';
import { sortIndicesByValue } from './sort.js';
import { createVfxRuntime, installMeshSamplers, step } from './system.js';
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


  // ADDITIVE NEEDS AN OPAQUE DESTINATION, and the destination is the thing to
  // check - not these factors.
  //
  // A transparent canvas is composited as PREMULTIPLIED alpha, where a colour
  // channel may not exceed the alpha it is premultiplied by; browsers clamp
  // when it does. There is no pair of blend factors that survives that. With
  // the preset's (SrcAlpha, One) on the alpha channel, a sprite with no alpha
  // channel drove the canvas alpha to 1 across the whole quad while adding no
  // colour, so its black background became an opaque BLACK BOX over the page
  // backdrop. Setting the alpha factors to (Zero, One) instead left alpha at 0,
  // and the compositor clamped the glow away - the particles then showed up
  // ONLY where a grid line had already written alpha, drawing the effect as a
  // crosshatch.
  //
  // Both were observed on the same effect, which is what makes the pair of them
  // the proof: the fix is an opaque render target, asserted in source.test.mjs
  // against VfxViewport, and vfxThumbnail.js has always had one.
  check('additive uses three’s preset, unmodified',
    additive.blending === THREE.AdditiveBlending, String(additive.blending));
  check('  with no hand-set alpha factors to go stale',
    additive.blendSrcAlpha === null && additive.blendDstAlpha === null,
    `${additive.blendSrcAlpha}/${additive.blendDstAlpha}`);

  // The other modes own the alpha channel legitimately: alpha blending
  // composites by coverage, and an opaque particle is opaque.
  check('alpha blending still composites by coverage',
    alpha.blending === THREE.NormalBlending);
  check('  and premultiplied uses (One, 1-SrcAlpha)',
    premultiplied.blendSrc === THREE.OneFactor
    && premultiplied.blendDst === THREE.OneMinusSrcAlphaFactor);

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
// 4b. What the two modes that are NOT a plain textured quad actually draw
// ---------------------------------------------------------------------------
// Both of these shipped wrong, and neither was catchable by the sections above:
// they check that a shader declares what the layout provides, not that the
// geometry it builds points the way the artwork expects.
{
  // A STRETCHED BILLBOARD ELONGATES ALONG U.
  //
  // Streak sprites are authored lying on their side, long in U - this repo's own
  // spark-streak.png is - because that is what Unity's Stretched Billboard and
  // Niagara's velocity-aligned sprite both expect, and the Unity importer maps
  // this mode onto exactly that. Putting the length on corner.y instead drew
  // straight-down rain as horizontal dashes.
  const layout = buildInstanceLayout({
    mode: 'stretched',
    attributes: ['position', 'size', 'color', 'velocity'],
  });
  const source = buildVertexShader(layout);
  const stretch = source.slice(source.indexOf('#ifdef MODE_STRETCHED'));
  check('a stretched quad takes its length from corner.x',
    stretch.includes('dir * (corner.x * len)'),
    stretch.includes('dir * (corner.y * len)') ? 'still elongating along V' : 'ok');
  check('  and its width from corner.y',
    stretch.includes('perp * (corner.y * iSize)'));

  // A MESH WITH NO TEXTURE OF ITS OWN BINDS NO MAP.
  //
  // The fragment shader multiplies by the map, so falling back to the built-in
  // soft blob painted a radial fade across the model's own UVs - under alpha
  // blending that made Debris Burst's chunks all but transparent. A quad still
  // gets the blob, which is the whole point of section 4.
  const irOf = (mode, withTexture) => ({
    systems: [{
      capacity: 8,
      outputs: [{
        batchKey: `k-${mode}-${withTexture}`,
        mode,
        blend: 'alpha',
        sort: 'none',
        contextId: 'c',
        instanceLayout: buildInstanceLayout({ mode, attributes: ['position', 'size', 'color'] }),
        blocks: withTexture
          ? [{ kernel: 'output.texture', assetSlots: { texture: 0 } }]
          : [],
      }],
    }],
    assets: [{ assetId: 1, kind: 'image' }],
  });
  const emitters = [{ pool: { count: 0, planes: {}, widths: {} } }];
  const batchOf = (mode, withTexture) => createBatches(
    irOf(mode, withTexture), emitters, { textures: new Map() },
  )[0];

  const bareMesh = batchOf('mesh', false);
  check('an untextured mesh output binds no map',
    !('USE_MAP' in bareMesh.material.defines) && bareMesh.material.uniforms.uMap.value === null,
    JSON.stringify(Object.keys(bareMesh.material.defines)));

  const bareQuad = batchOf('billboard', false);
  check('  while an untextured billboard still gets the built-in sprite',
    'USE_MAP' in bareQuad.material.defines
    && bareQuad.material.uniforms.uMap.value === getDefaultSprite());

  disposeBatch(bareMesh);
  disposeBatch(bareQuad);
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

// ---------------------------------------------------------------------------
// 9. The starter library
// ---------------------------------------------------------------------------
//
// THE PHASE-8 SUCCESS CRITERION: every template opens with zero warnings. A
// template that trips a diagnostic is a bug in the template, not a lesson - it
// is the first thing an author ever sees, and one that arrives complaining
// teaches them that the diagnostics strip is noise.
{
  const rows = [];
  const dirty = [];
  const empty = [];
  const threw = [];

  for (const template of VFX_TEMPLATES) {
    let result;
    try {
      // No assetIndex: a template must be self-sufficient, because it opens
      // before the author has chosen any textures. Anything referencing an
      // asset id would report a dangling reference here.
      result = compileVfxGraph(template.build(), { assetIndex: new Set() });
    } catch (error) {
      threw.push(`${template.id}: ${error.message}`);
      continue;
    }
    const loud = result.diagnostics.filter((d) => d.severity !== 'info');
    if (loud.length > 0) dirty.push(`${template.id}: ${loud.map((d) => d.code).join(',')}`);

    // And it has to actually draw something - a clean compile of an effect that
    // emits nothing would pass every check above.
    const runtime = createVfxRuntime(result.ir);
    // Long enough for the latest clip in the staged templates to have opened.
    for (let i = 0; i < 45; i += 1) step(runtime);
    const batches = createBatches(result.ir, runtime.emitters, {});
    let drawn = 0;
    for (const batch of batches) drawn += writeBatch(batch, { x: 0, y: 0, z: -1 });
    if (drawn === 0) empty.push(template.id);
    for (const batch of batches) disposeBatch(batch);
    rows.push(`${template.id}:${drawn}`);
  }

  check('every template builds', threw.length === 0, threw.join('; '));
  check('  with no errors and no warnings', dirty.length === 0, dirty.join('; '));
  check('  and draws something within 45 steps', empty.length === 0, empty.join(', '));
  // At least the twelve the plan names, and the count is REPORTED rather than
  // asserted exactly - pinning it to a number means every new template is a
  // test failure, which trains the next person to edit the assertion without
  // reading it.
  check(`  (${VFX_TEMPLATES.length} templates, instances drawn at step 45)`,
    VFX_TEMPLATES.length >= 12, rows.join(' '));

  // Each card claims to teach something. An empty `teaches` list, or a
  // duplicate id, is the kind of thing that survives review and then shows up
  // in the gallery.
  const ids = new Set();
  const flawed = [];
  for (const template of VFX_TEMPLATES) {
    if (ids.has(template.id)) flawed.push(`duplicate id ${template.id}`);
    ids.add(template.id);
    if (!template.name || !template.blurb) flawed.push(`${template.id}: missing name or blurb`);
    if (!Array.isArray(template.teaches) || template.teaches.length === 0) {
      flawed.push(`${template.id}: teaches nothing`);
    }
    if (!template.category) flawed.push(`${template.id}: no category`);
  }
  check('every card names itself and what it teaches', flawed.length === 0, flawed.join('; '));

  // build() must return a FRESH document each call, or opening a template
  // twice would share mutable state and editing one copy would change the
  // other.
  const first = templateById('explosion').build();
  const second = templateById('explosion').build();
  check('build() returns a fresh document each call', first !== second
    && first.systems[0] !== second.systems[0]);
}

// ---------------------------------------------------------------------------
console.log('\n--- The emitter rotation is three.js Euler XYZ ---');
// ---------------------------------------------------------------------------
//
// PINNED AGAINST three ITSELF, not against arithmetic re-derived here - which
// would only be the same mistake written twice.
//
// The shape transform used to build R = Rz * Ry * Rx while its comment claimed
// it matched three.js's 'XYZ'. It did not, and the error is invisible in
// exactly the case anyone checks by hand: for a rotation about ONE axis the two
// orders agree, and every preset on the property is single-axis. Two axes at
// once and the emitter pointed somewhere the particles did not.
//
// It matters beyond taste now: the emitter gizmo hands these same three numbers
// to an Object3D and expects the wireframe to land on the particles.
{
  // A direct comparison of the two constructions, since the kernel's helper is
  // module-private. Written the way three writes it, then checked against three.
  const kernelMatrix = (x, y, z) => {
    const cx = Math.cos(x);
    const sx = Math.sin(x);
    const cy = Math.cos(y);
    const sy = Math.sin(y);
    const cz = Math.cos(z);
    const sz = Math.sin(z);
    return [
      cy * cz, -cy * sz, sy,
      cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
      sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
    ];
  };

  // The formula above is a COPY of the kernel's, so on its own it proves
  // nothing. This is what makes it bite: the same numbers, taken from the
  // shipped source rather than from this file.
  const source = await readFile(new URL('./kernels.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function eulerMatrix'));
  const lines = [
    'm[0] = cy * cz;', 'm[1] = -cy * sz;', 'm[2] = sy;',
    'm[3] = cx * sz + sx * sy * cz;', 'm[4] = cx * cz - sx * sy * sz;', 'm[5] = -sx * cy;',
    'm[6] = sx * sz - cx * sy * cz;', 'm[7] = sx * cz + cx * sy * sz;', 'm[8] = cx * cy;',
  ];
  const missing = lines.filter((line) => !body.includes(line));
  check('the shipped eulerMatrix is the one checked below', missing.length === 0,
    missing.join(' '));

  let worst = 0;
  let worstAt = '';
  for (let i = 0; i < 64; i += 1) {
    // Deterministic angles rather than random ones, so a failure is reproducible.
    const x = ((i * 37) % 360 - 180) * Math.PI / 180;
    const y = ((i * 91) % 360 - 180) * Math.PI / 180;
    const z = ((i * 143) % 360 - 180) * Math.PI / 180;
    const mine = kernelMatrix(x, y, z);
    const e = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(x, y, z, 'XYZ')).elements;
    // three is column-major: row r, column c is elements[c * 4 + r].
    const theirs = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
    for (let k = 0; k < 9; k += 1) {
      const diff = Math.abs(theirs[k] - mine[k]);
      if (diff > worst) {
        worst = diff;
        worstAt = `(${(x * 180 / Math.PI).toFixed(0)}, ${(y * 180 / Math.PI).toFixed(0)}, ${(z * 180 / Math.PI).toFixed(0)})`;
      }
    }
  }
  check('it matches three.js XYZ at every angle tried', worst < 1e-12,
    `worst ${worst.toExponential(2)} at ${worstAt}`);

  // And the guard is not vacuous: the ORDER it replaced must fail this.
  const oldOrder = (x, y, z) => {
    const cx = Math.cos(x);
    const sx = Math.sin(x);
    const cy = Math.cos(y);
    const sy = Math.sin(y);
    const cz = Math.cos(z);
    const sz = Math.sin(z);
    return [
      cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
      cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
      -sy, sx * cy, cx * cy,
    ];
  };
  const e = new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(0.7, -1.1, 0.4, 'XYZ')).elements;
  const theirs = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  const old = oldOrder(0.7, -1.1, 0.4);
  check('  and the order it replaced would NOT',
    Math.max(...old.map((v, k) => Math.abs(v - theirs[k]))) > 0.1);

  // Single-axis is the case that hid it: identical either way, which is why no
  // preset and no hand check ever caught it.
  const single = oldOrder(1.2, 0, 0);
  const now = kernelMatrix(1.2, 0, 0);
  check('  while a single-axis rotation is identical in both, which is why it hid',
    Math.max(...single.map((v, k) => Math.abs(v - now[k]))) < 1e-12);
}

// ---------------------------------------------------------------------------
console.log('\n--- The sprite black point ---');
// ---------------------------------------------------------------------------
//
// ADDITIVE BLENDING ADDS EVERY PIXEL, so a sprite whose background is 0.3/255
// rather than 0 is invisible on one particle and an obvious grey box once sixty
// overlap. A generated flame measured 96% pure #000 with the rest a faint ember
// glow, and that remainder drew the outline of every quad.
{
  const withBlackPoint = (value) => {
    let doc = normalizeVfxDoc(templateById('fire').build());
    const system = doc.systems[0];
    doc = edits.setSystemTexture(doc, system.id, { assetId: 99, name: 'f.png' });
    const output = doc.systems[0].contexts.find((c) => c.kind === 'output');
    const block = output.blocks.find((b) => b.type === 'output.setMainTexture');
    doc = edits.setBlockProp(doc, block.id, 'blackPoint', value);
    const { ir } = compileVfxGraph(doc, { assetIndex: new Set([99]) });
    return ir;
  };

  // THE BUG THAT MADE IT INERT: readConstBinding rounds. It was written for
  // tile and frame counts, where a fraction is meaningless, so 0.02 came back
  // as 0 - which is the value that means "off". The feature did nothing and
  // said nothing.
  check('a fractional black point survives compilation',
    withBlackPoint(0.02).systems[0].outputs[0].blackPoint === 0.02,
    String(withBlackPoint(0.02).systems[0].outputs[0].blackPoint));
  check('  and a small one is not rounded away',
    withBlackPoint(0.005).systems[0].outputs[0].blackPoint === 0.005,
    String(withBlackPoint(0.005).systems[0].outputs[0].blackPoint));
  check('  while zero stays zero', withBlackPoint(0).systems[0].outputs[0].blackPoint === 0);

  // A UNIFORM, SO IT MUST SPLIT THE BATCH. Two outputs sharing a texture but
  // differing here cannot share a draw - one of them would silently render with
  // the other's value, which is the same rule tiles follows.
  const keys = [0, 0.02, 0.06].map((v) => withBlackPoint(v).systems[0].outputs[0].batchKey);
  check('outputs with different black points do not share a draw',
    new Set(keys).size === 3, `${new Set(keys).size} distinct of 3`);

  // And it reaches the material.
  const ir = withBlackPoint(0.02);
  const runtime = createVfxRuntime(ir);
  const batch = createBatches(ir, runtime.emitters, {
    textures: new Map([[99, new THREE.Texture()]]),
  })[0];
  check('  and the material carries it', batch.material.uniforms.uBlackPoint.value === 0.02,
    String(batch.material.uniforms.uBlackPoint.value));
  disposeBatch(batch);

  // The shader maths, evaluated here rather than on a GPU. SUBTRACT AND
  // RENORMALISE, not a hard clamp: clamping alone leaves a visible step at the
  // cutoff, while rescaling pulls the floor down and leaves the peak where it
  // was. That second half is what stops the sprite dimming.
  const apply = (v, bp) => (bp > 0 ? Math.max(v - bp, 0) / (1 - bp) : v);
  check('the black point zeroes a near-black pixel',
    apply(0.004, 0.02) === 0, String(apply(0.004, 0.02)));
  check('  and leaves full white exactly where it was',
    Math.abs(apply(1, 0.02) - 1) < 1e-12, String(apply(1, 0.02)));
  check('  rescaling rather than only clamping',
    // A hard clamp would give 0.48 here; renormalising gives more, which is the
    // difference between a dimmed sprite and one that keeps its brightness.
    apply(0.5, 0.02) > 0.48 + 1e-9, String(apply(0.5, 0.02)));
  check('  and zero is a true no-op', apply(0.004, 0) === 0.004);

  // The shader really contains it, since none of the above executes GLSL.
  const source = await readFile(new URL('./materials.js', import.meta.url), 'utf8');
  check('the fragment shader applies it before the colour multiply',
    source.indexOf('texel.rgb = max(texel.rgb - uBlackPoint') > 0
    && source.indexOf('texel.rgb = max(texel.rgb - uBlackPoint')
      < source.indexOf('vec4 colour = texel * vColor'));
}

// ---------------------------------------------------------------------------
console.log('\n--- The sprite-sheet plan ---');
// ---------------------------------------------------------------------------
//
// Every arithmetic mistake a sprite sheet can contain is in this function, so
// it is separated from the render and checked against numbers worked out by
// hand rather than against its own output.
{
  const plan = (extra = {}) => planSpriteSheet({
    startFrame: 0, endFrame: 60, columns: 4, rows: 4, cell: 256, ...extra,
  });

  const base = plan();
  check('the grid decides the cell count', base.count === 16);
  check('  and the sheet size', base.width === 1024 && base.height === 1024,
    `${base.width}x${base.height}`);

  // THE LOOP SEAM, and it is the one thing here that is not obvious.
  //
  // A looping flipbook plays cell 15 and then cell 0 again. If cell 15 is the
  // same moment as cell 0 the effect visibly stutters once per cycle. So a loop
  // divides the span by the CELL COUNT - 60/16 = 3.75 - which lands the last
  // cell at frame 56, one step short of 60, and 60 IS frame 0 of the next
  // cycle. A one-shot has no seam and wants the last frame, so it divides by
  // count - 1: 60/15 = 4 exactly, last cell at 60.
  const loop = plan({ loop: true });
  const shot = plan({ loop: false });
  check('a looping effect stops short of the end frame',
    loop.frames[15] === 56, String(loop.frames[15]));
  check('  stepping by count, not count-1', loop.stepFrames === 60 / 16);
  check('a one-shot captures the end frame exactly',
    shot.frames[15] === 60, String(shot.frames[15]));
  check('  stepping by count-1', shot.stepFrames === 4);
  check('both start at the start frame',
    loop.frames[0] === 0 && shot.frames[0] === 0);

  // Ascending, because the renderer walks the simulation FORWARD once and steps
  // to each frame in turn. A frame out of order would be unreachable - the sim
  // cannot be rewound - and the cell would silently get the previous frame.
  const ascending = (list) => list.every((frame, i) => i === 0 || frame >= list[i - 1]);
  check('frames are ascending', ascending(loop.frames) && ascending(shot.frames));

  // A start offset shifts the whole range rather than the step.
  const offset = plan({ startFrame: 30, endFrame: 90, loop: false });
  check('the range can start anywhere',
    offset.frames[0] === 30 && offset.frames[15] === 90,
    `${offset.frames[0]}..${offset.frames[15]}`);
  check('  with the same step as the same-length range at zero',
    offset.stepFrames === shot.stepFrames);

  // A RANGE SHORTER THAN THE GRID. 8 frames into 16 cells means half the cells
  // repeat their neighbour, which looks like the effect stalled - so it is
  // counted and the dialog says so instead of quietly producing it.
  const cramped = plan({ endFrame: 8, loop: false });
  check('too short a range is reported as duplicate cells',
    cramped.duplicates > 0, `${cramped.duplicates} duplicates`);
  check('  and a long enough range has none', shot.duplicates === 0);

  // The cap is not the GPU's - it is what an engine and a phone will take.
  check('an oversized sheet is flagged, not clamped',
    plan({ columns: 32, rows: 32, cell: 512 }).tooLarge === true);
  check('  and a big-but-legal one is not',
    plan({ columns: 16, rows: 16, cell: 512 }).tooLarge === false,
    `${MAX_SHEET_PIXELS} limit`);

  // Degenerate input has to produce something renderable rather than NaN
  // cells: these fields come from number inputs, which hand back '' as NaN the
  // moment the field is cleared mid-edit.
  const junk = planSpriteSheet({
    startFrame: NaN, endFrame: NaN, columns: 0, rows: -3, cell: 'x', loop: false,
  });
  check('junk input still plans something renderable',
    junk.count === 1 && junk.frames.length === 1
    && junk.frames.every(Number.isFinite) && junk.width > 0,
    JSON.stringify({ count: junk.count, frames: junk.frames, w: junk.width }));
  // A single cell must not divide by zero on count - 1.
  check('  including a one-cell sheet', Number.isFinite(junk.stepFrames));

  // An end at or before the start would make every cell one instant.
  const inverted = planSpriteSheet({
    startFrame: 40, endFrame: 10, columns: 2, rows: 1, cell: 64, loop: false,
  });
  check('an end before the start is pushed past it',
    inverted.endFrame > inverted.startFrame,
    `${inverted.startFrame}..${inverted.endFrame}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- The sprite-sheet renderer ---');
// ---------------------------------------------------------------------------
//
// Nothing here draws - WebGLRenderer needs a context - so this checks the two
// decisions in the module that are invisible in a rendered frame and expensive
// to get wrong.
{
  const source = await readFile(new URL('./spriteSheet.js', import.meta.url), 'utf8');

  // STRAIGHT ALPHA. `alpha: true` alone gives a PREMULTIPLIED buffer, and an
  // additive particle is bright rgb at low alpha - exactly the case where the
  // premultiply-then-divide round trip destroys the colour. Both flags, or the
  // transparency the whole feature exists for is unusable.
  check('the renderer asks for a straight-alpha buffer',
    /alpha: true/.test(source) && /premultipliedAlpha: false/.test(source));
  // toBlob reads the buffer in a later task than the renders.
  check('  and a buffer that survives until toBlob',
    /preserveDrawingBuffer: true/.test(source));
  // A scene background is an OPAQUE clear: it would fill the alpha channel and
  // undo all of the above.
  check('  with no scene background to fill the alpha in',
    !/scene\.background\s*=/.test(source));

  // ONE CONTEXT. A renderer per cell is a WebGL context per cell, and an 8x8
  // sheet would ask for sixty-four.
  const renderers = [...source.matchAll(/new THREE\.WebGLRenderer/g)];
  check('exactly one renderer is created for the whole sheet',
    renderers.length === 1, `${renderers.length} found`);
  // Cells are drawn into one buffer, so the clear happens once and autoClear
  // must be off or each cell would wipe the previous fifteen.
  check('  cleared once, with autoClear off',
    /autoClear = false/.test(source) && /renderer\.clear\(\)/.test(source));
  check('  and scissored per cell', /setScissor\(/.test(source) && /setViewport\(/.test(source));

  // CELL ORDER MUST MATCH THE SHADER. materials.js computes column = frame %
  // columns and row = floor(frame / columns), with a V flip that puts row 0 at
  // the TOP of the image - while GL's viewport origin is the bottom-left. Get
  // the flip wrong and a baked explosion implodes when played back.
  check('cells are laid out row-major from the top',
    /const column = index % plan\.columns/.test(source)
    && /const row = Math\.floor\(index \/ plan\.columns\)/.test(source)
    && /plan\.height - \(row \+ 1\) \* plan\.cell/.test(source));

  const materials = await readFile(new URL('./materials.js', import.meta.url), 'utf8');
  check('  which is the order the flipbook shader samples',
    /float column = mod\(frame, uTiles\.x\)/.test(materials)
    && /float row = floor\(frame \/ uTiles\.x\)/.test(materials));

  // The sim cannot be rewound, so the frames are walked forward ONCE. Restarting
  // from zero per cell would be count-squared steps - at 8x8 over 300 frames,
  // about twenty thousand instead of three hundred.
  check('the simulation is walked forward once, not re-run per cell',
    /while \(runtime\.stepIndex < plan\.frames\[index\]\) step\(runtime\)/.test(source));
}


// ---------------------------------------------------------------------------
console.log('\n--- A fresh runtime needs its mesh samplers ---');
// ---------------------------------------------------------------------------
//
// A MESH EMITTER WITH NO SAMPLER DOES NOT FAIL - it spawns every particle at
// the shape's origin (`placeShape(..., 0, 0, 0)` in shape.position.mesh), so
// the system collapses to a point. Silent, and identical to an effect somebody
// just never finished.
//
// The live preview installs samplers in useVfxRuntime and looked right, while
// the sprite-sheet bake and the simulated thumbnail each built their OWN
// runtime and installed nothing. So a mesh-emitted effect baked as a handful of
// particles at the origin, which is the bug the user reported: a 4x4 sheet of
// almost-empty cells for an effect that fills the viewport.
{
  // A cube, big enough that "spread over the surface" and "all at the origin"
  // cannot be confused for one another.
  const side = 4;
  const cube = new THREE.BoxGeometry(side, side, side);
  const meshes = new Map([[77, cube]]);

  let doc = normalizeVfxDoc(templateById('fire').build());
  const system = doc.systems[0];
  const init = system.contexts.find((c) => c.kind === 'initialize');
  // Replace whatever shape the template has with a mesh emitter on asset 77.
  for (const block of init.blocks.filter((b) => b.type.startsWith('initialize.position'))) {
    doc = edits.removeBlock(doc, block.id);
  }
  doc = edits.addBlock(doc, { contextId: init.id, blockType: 'initialize.positionMesh' });
  const meshBlock = doc.systems[0].contexts.find((c) => c.id === init.id).blocks
    .filter((b) => b.type === 'initialize.positionMesh').pop();
  doc = edits.setAssetReference(doc, 'mesh_test', {
    kind: 'mesh', ref: 'asset:77', name: 'Cube', colorSpace: 'srgb',
  });
  doc = edits.setBlockAssetSlot(doc, meshBlock.id, 'mesh', 'mesh_test');

  const { ir } = compileVfxGraph(doc, { assetIndex: new Set([77]) });
  check('the effect compiles with a mesh emitter',
    ir.systems[0].init.some((b) => b.srcBlockType === 'initialize.positionMesh'));

  // How far from the origin do the particles get? A sampler spreads them over
  // the cube's surface; without one they are all exactly at the offset.
  const spread = (install) => {
    const runtime = createVfxRuntime(ir);
    if (install) installMeshSamplers(runtime, meshes);
    for (let i = 0; i < 30; i += 1) step(runtime);
    const emitter = runtime.emitters[0];
    const position = emitter.pool.planes.position;
    let furthest = 0;
    for (let i = 0; i < emitter.pool.count; i += 1) {
      const x = position[i * 3];
      const z = position[i * 3 + 2];
      furthest = Math.max(furthest, Math.hypot(x, z));
    }
    return { furthest, alive: emitter.pool.count };
  };

  const without = spread(false);
  const withSamplers = spread(true);

  check('particles are alive either way', without.alive > 20 && withSamplers.alive > 20,
    `${without.alive} vs ${withSamplers.alive}`);

  // THE BUG, STATED AS A NUMBER. Without a sampler every particle is BORN at
  // the origin, so after thirty frames the cloud has only drifted as far as its
  // own velocity carried it. With one, the particles start spread over a
  // 4-unit cube, so the cloud is wider than the drift by an order of magnitude.
  //
  // Not asserting "exactly zero": these are measured after thirty steps of real
  // simulation, drag and turbulence included, because that is the state a bake
  // actually captures. Spawn-position equality would be a narrower test of a
  // narrower thing.
  check('without a sampler the cloud stays clustered at the origin',
    without.furthest < 0.5, without.furthest.toFixed(3));
  check('installing samplers spreads it over the mesh instead',
    withSamplers.furthest > 1.5, withSamplers.furthest.toFixed(3));
  check('  which is a difference of several times over, not a nuance',
    withSamplers.furthest > without.furthest * 5,
    `${withSamplers.furthest.toFixed(2)} vs ${without.furthest.toFixed(2)}`);

  check('the installer reports what it did', installMeshSamplers(createVfxRuntime(ir), meshes) === 1);
  // Geometry without positions cannot be sampled, and must not throw - a
  // partially loaded glTF is a normal intermediate state.
  check('  and skips geometry it cannot sample',
    installMeshSamplers(createVfxRuntime(ir), new Map([[77, {}], [78, null]])) === 0);
  check('  and tolerates no runtime or no meshes',
    installMeshSamplers(null, meshes) === 0 && installMeshSamplers(createVfxRuntime(ir), null) === 0);

  cube.dispose();

  // Both offscreen capture paths must install them. Checked in the source
  // because neither can run headlessly - they need a WebGL context - and this
  // is precisely the pair that forgot.
  const sheet = await readFile(new URL('./spriteSheet.js', import.meta.url), 'utf8');
  check('the sprite-sheet bake installs samplers',
    /installMeshSamplers\(runtime, meshes\)/.test(sheet));
  const thumb = await readFile(new URL('../vfxThumbnail.js', import.meta.url), 'utf8');
  check('  and so does the simulated thumbnail',
    /installMeshSamplers\(runtime, meshes\)/.test(thumb));
  const hook = await readFile(new URL('../../hooks/useVfxRuntime.js', import.meta.url), 'utf8');
  check('  and the preview uses the same one rather than its own copy',
    /installMeshSamplers\(runtime, result\.meshes\)/.test(hook)
    && !/buildMeshSampler/.test(hook));
}


// --- The bundled flipbook sheet ---------------------------------------------
//
// A FLIPBOOK ATLAS WHOSE CELLS BLEED IS WORSE THAN NO ATLAS. Neighbouring
// frames ghost into each other at distance - it reads as the effect flickering
// rather than as a texture problem, which is the same bug class the renderer's
// ClampToEdge-and-no-mipmaps rule exists to prevent.
//
// THIS PINS AN INVARIANT RATHER THAN GUARDING A BUG THAT HAPPENED. The painter
// is correct today because its supersample offsets sit strictly inside each
// pixel, so no sample can reach a neighbouring cell. That is quiet and easy to
// lose: switching to corner sampling looks like an improvement and breaks it.
// Measured, not assumed - making that change turns the first check below from
// 16 distinct cell values into 45.
{
  console.log('\n--- The flipbook sheet has hard cell edges ---');

  // Each cell painted a flat value equal to its own frame index. Any bleed
  // shows up as a pixel holding a value no cell was painted with.
  const cols = 4;
  const rows = 4;
  const cell = 16;
  const { size, rgba } = paintSheet(cell, cols, rows, (u, v, frame) => {
    const level = (frame + 1) / (cols * rows);
    return [level, level, level, 1];
  });

  check('the sheet is square and the right size', size === cell * cols,
    `${size}px`);

  const levels = new Set();
  for (let i = 0; i < rgba.length; i += 4) levels.add(rgba[i]);
  check('every pixel belongs to exactly one cell', levels.size === cols * rows,
    `${levels.size} distinct values, expected ${cols * rows}`);

  // ROW-MAJOR FROM THE TOP, which is the order the flipbook shader samples in.
  // Getting this backwards plays the animation upside down, and on a smoke
  // puff that is subtle enough to ship.
  const at = (x, y) => rgba[(y * size + x) * 4];
  const topLeft = at(1, 1);
  const topRight = at(size - 2, 1);
  const bottomLeft = at(1, size - 2);
  check('cell 0 is top-left', topLeft === Math.round((1 / 16) * 255), String(topLeft));
  check('  cell 3 is top-right', topRight === Math.round((4 / 16) * 255), String(topRight));
  check('  cell 12 is bottom-left', bottomLeft === Math.round((13 / 16) * 255),
    String(bottomLeft));

  // The pixels either side of an internal boundary are adjacent cells and
  // nothing in between - the direct statement of "no bleed".
  const leftOfSeam = at(cell - 1, cell + 1);
  const rightOfSeam = at(cell, cell + 1);
  check('the pixels either side of a seam are two whole cells',
    leftOfSeam === Math.round((5 / 16) * 255) && rightOfSeam === Math.round((6 / 16) * 255),
    `${leftOfSeam} | ${rightOfSeam}`);

  // A non-square grid is refused rather than silently producing an atlas whose
  // UVs are off by a fraction.
  let refused = false;
  try {
    paintSheet(8, 4, 2, () => [1, 1, 1, 1]);
  } catch {
    refused = true;
  }
  check('a non-square sheet is refused, not quietly wrong', refused);
}


// --- PNG round trip, downscale and matte ------------------------------------
//
// WHY A DECODER EXISTS AT ALL: an agent could not LOOK at a sprite it had just
// wired into an effect. A 1024x1024 RGBA PNG is about a megabyte, base64 adds a
// third, and the transport refuses it - so the sprite went in unseen. Shrinking
// it server-side means decoding it, and this project has no image library.
//
// A DECODER THAT IS SUBTLY WRONG IS WORSE THAN NONE: it would answer "is this
// matte hard-edged" with a plausible wrong picture. So the round trip is exact,
// byte for byte, rather than approximately right.
{
  console.log('\n--- PNG decode, downscale and matte ---');

  // A gradient in every channel, so a swapped or dropped channel cannot pass.
  const size = 16;
  const source = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      source[at] = x * 16;
      source[at + 1] = y * 16;
      source[at + 2] = 255 - x * 16;
      source[at + 3] = (x + y) * 8;
    }
  }

  const round = decodePng(encodePng(size, source));
  check('a PNG round-trips to the same size',
    round?.width === size && round?.height === size,
    `${round?.width}x${round?.height}`);
  let worst = 0;
  for (let i = 0; i < source.length; i += 1) {
    worst = Math.max(worst, Math.abs(round.rgba[i] - source[i]));
  }
  check('  byte for byte, alpha included', worst === 0, `worst delta ${worst}`);

  // Non-square, because the encoder gained a height argument for preview
  // frames and a decoder that assumed square would read them sheared.
  const wide = new Uint8Array(8 * 4 * 4).fill(200);
  const wideRound = decodePng(encodePng(8, wide, 4));
  check('a non-square PNG round-trips too',
    wideRound?.width === 8 && wideRound?.height === 4,
    `${wideRound?.width}x${wideRound?.height}`);

  // DOWNSCALING AVERAGES, it does not sample. Nearest-neighbour on a soft
  // sprite drops the faint outer falloff, which would make a perfectly good
  // sprite look hard-edged in the preview - reporting the very bug this is
  // meant to rule out.
  const soft = { width: 4, height: 1, rgba: new Uint8Array([
    255, 255, 255, 0,
    255, 255, 255, 85,
    255, 255, 255, 170,
    255, 255, 255, 255,
  ]) };
  const half = downscaleRgba(soft, 2);
  check('downscaling averages rather than sampling',
    half.rgba[3] > 30 && half.rgba[3] < 60 && half.rgba[7] > 195 && half.rgba[7] < 225,
    `alphas ${half.rgba[3]}, ${half.rgba[7]}`);
  check('  and leaves a small image alone',
    downscaleRgba(soft, 64).scale === 1);

  // COLOUR IS WEIGHTED BY ALPHA. Clear pixels around a sprite are usually
  // black, and an unweighted mean drags the soft edge toward them - the classic
  // dark halo.
  const halo = { width: 2, height: 1, rgba: new Uint8Array([
    0, 0, 0, 0,        // clear black
    255, 255, 255, 255, // solid white
  ]) };
  const merged = downscaleRgba(halo, 1);
  check('a transparent neighbour does not darken the result',
    merged.rgba[0] === 255, `r=${merged.rgba[0]}`);

  // The checkerboard has to be VISIBLE where the image is clear and ABSENT
  // where it is solid, or it is decoration rather than information.
  const matted = matteOnCheckerboard({ width: 16, height: 16, rgba: source }, 4);
  const opaque = [];
  for (let i = 3; i < matted.length; i += 4) opaque.push(matted[i]);
  check('the matte is fully opaque', opaque.every((a) => a === 255));
  const clearPixel = matteOnCheckerboard(
    { width: 2, height: 1, rgba: new Uint8Array([0, 0, 0, 0, 9, 9, 9, 255]) }, 1,
  );
  check('  showing the checker through a clear pixel', clearPixel[0] > 100,
    String(clearPixel[0]));
  check('  and nothing through a solid one', clearPixel[4] === 9, String(clearPixel[4]));

  // REFUSED, NOT GUESSED. A shape this decoder does not read returns null so
  // the caller can say why rather than showing a plausible wrong image.
  check('a non-PNG is refused', decodePng(Buffer.from('not a png at all')) === null);
  check('  and so is a truncated one', decodePng(encodePng(size, source).subarray(0, 30)) === null);
}


// --- What to frame on -------------------------------------------------------
//
// THE BOX THAT IS CORRECT FOR CULLING IS THE WRONG ONE FOR A CAMERA, and that
// is the whole reason there are two. Reported from a nuclear blast: eighty
// debris specks thrown at thirty metres a second dragged the total bounding box
// open by tens of metres, so framing on it shrank the mushroom cloud - the
// thing anyone is looking at - to a third of the cell.
{
  console.log('\n--- The focus box ignores outliers, the total box does not ---');

  const emitterOf = (particles, output = { mode: 'billboard' }) => [{
    pool: {
      count: particles.length,
      planes: {
        position: Float32Array.from(particles.flatMap((p) => p.p)),
        size: Float32Array.from(particles.map((p) => p.s)),
        color: Float32Array.from(particles.flatMap((p) => [1, 1, 1, p.a ?? 1])),
        velocity: Float32Array.from(particles.flatMap((p) => p.v || [0, 0, 0])),
      },
    },
    irSystem: { outputs: [output] },
  }];

  // A DRAWN PARTICLE REACHES FURTHER THAN size/2. The quad's corners are at
  // +/-0.5 and the shader scales them by size, so a corner is size*sqrt(2)/2
  // out - 41% further. Under-reporting clips the very particles that define
  // the silhouette.
  check('a billboard is measured to its corner, not its edge',
    Math.abs(drawnRadius(2, 0, 'billboard') - Math.SQRT2) < 1e-6,
    drawnRadius(2, 0, 'billboard').toFixed(4));
  check('  a stretched one grows along its velocity',
    drawnRadius(1, 10, 'stretched', 1) > 5 && drawnRadius(1, 0, 'stretched', 1) < 1,
    `${drawnRadius(1, 10, 'stretched', 1).toFixed(2)} fast vs ${drawnRadius(1, 0, 'stretched', 1).toFixed(2)} still`);
  check('  and a mesh to its cube corner',
    Math.abs(drawnRadius(2, 0, 'mesh') - Math.sqrt(3)) < 1e-6,
    drawnRadius(2, 0, 'mesh').toFixed(4));

  // THE REPORTED CASE.
  const mass = Array.from({ length: 60 }, (_, i) => ({
    p: [Math.cos(i) * 0.8, 1 + Math.sin(i) * 0.8, Math.sin(i * 2) * 0.8], s: 1.4, a: 0.9,
  }));
  const debris = Array.from({ length: 80 }, (_, i) => ({
    p: [Math.cos(i) * 18, 3 + i * 0.05, Math.sin(i) * 18], s: 0.05, a: 1,
  }));
  const blast = emitterOf([...mass, ...debris]);

  const total = boundsOfEmitters(blast);
  const focus = focusBounds(blast);
  const spanOf = (b) => b.max[0] - b.min[0];

  check('the total box contains the debris', spanOf(total) > 30, spanOf(total).toFixed(1));
  check('  and the focus box does not', spanOf(focus) < 6, spanOf(focus).toFixed(1));
  check('  so the subject is several times larger on screen',
    spanOf(total) / spanOf(focus) > 4,
    `${(spanOf(total) / spanOf(focus)).toFixed(1)}x`);

  // WEIGHT, NOT COUNT, and this is the part a plain percentile gets backwards.
  // Two hundred dust motes that ARE the effect must survive the trim, even
  // though they outnumber everything; eighty specks that merely fly far must
  // not. The difference is screen area times opacity, not headcount.
  const dust = Array.from({ length: 200 }, (_, i) => ({
    p: [Math.cos(i * 0.7) * 6, 1, Math.sin(i * 0.7) * 6], s: 0.9, a: 0.8,
  }));
  const cloud = focusBounds(emitterOf(dust));
  check('a wide cloud of many real particles is kept', spanOf(cloud) > 10,
    spanOf(cloud).toFixed(1));

  // A fully transparent particle is not visually part of anything, so it must
  // not drag the frame open - which is what correctly ignores fade tails.
  const withGhosts = focusBounds(emitterOf([
    ...mass,
    ...Array.from({ length: 40 }, (_, i) => ({ p: [i + 20, 0, 0], s: 3, a: 0 })),
  ]));
  check('invisible particles do not widen the frame', spanOf(withGhosts) < 6,
    spanOf(withGhosts).toFixed(1));

  // Degenerate inputs answer rather than throwing or returning a point.
  check('nothing alive returns null', focusBounds([]) === null);
  const single = focusBounds(emitterOf([{ p: [0, 0, 0], s: 1, a: 1 }]));
  check('a single particle still has extent', spanOf(single) > 1, spanOf(single).toFixed(2));
  // Every particle transparent: weight cannot decide anything, so it falls back
  // to the honest total rather than collapsing.
  const allClear = focusBounds(emitterOf([
    { p: [-5, 0, 0], s: 1, a: 0 }, { p: [5, 0, 0], s: 1, a: 0 },
  ]));
  check('  and an all-transparent effect falls back to the total box',
    spanOf(allClear) > 9, spanOf(allClear).toFixed(2));

  // The two camera paths must agree, or a sprite sheet and a headless preview
  // of one effect are framed differently for no reason anyone could find.
  const place = cameraPlacement([-1, -1, -1], [1, 1, 1]);
  const camera = frameBounds([-1, -1, -1], [1, 1, 1]);
  check('both camera paths place the eye identically',
    JSON.stringify(place.eye) === JSON.stringify(camera.eye), JSON.stringify(place.eye));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
