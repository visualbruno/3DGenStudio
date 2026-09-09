// One draw call: an instanced quad, the interleaved instance buffer, and the
// per-frame pass that fills it from the pool.
//
// THE WRITE LOOP IS GENERATED FROM THE LAYOUT TABLE, not hand-written per
// field. buildInstanceLayout in vfx/ir.js decides the stride and the offsets,
// the shader declares its attributes from the same table (see
// materials.js), and the copy below walks it. That is the whole point of
// having the table: an offset wrong by one float does not error, it makes every
// particle read its neighbour's size as its colour, and the result looks like a
// shader bug rather than the bookkeeping mistake it is.
//
// ONE INTERLEAVED BUFFER, not one attribute buffer per field. The write is then
// a single sequential pass over memory and the GPU does one fetch per instance
// rather than one per attribute. It also means one bufferSubData instead of
// four.
//
// THE QUAD IS SHARED AND MODULE-LEVEL. Every batch in every effect draws the
// same unit quad; four vertices and six indices uploaded once is worth more
// than the clarity of giving each batch its own.
//
// POINT MODE USES THE SAME QUAD, deliberately, rather than THREE.Points.
// gl_PointSize caps vary by driver - some cap at 63px - and a Point has no
// rotation and no non-uniform size, so it would be a second code path for a
// worse result. The repo's only existing THREE.Points uses are the two bone
// overlays, where those limits do not bite.

import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
} from 'three';
import { getDefaultParticleMesh, getDefaultSprite } from './assets.js';
import { createParticleMaterial, updateParticleMaterial } from './materials.js';
import { sortIndicesByDepth } from './sort.js';

// A unit quad centred on the origin, in the XY plane. The vertex shader offsets
// these corners in view space, so the geometry itself never rotates.
let sharedQuad = null;

function getSharedQuad() {
  if (sharedQuad) return sharedQuad;
  const position = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const index = new Uint16Array([0, 1, 2, 0, 2, 3]);
  sharedQuad = { position, uv, index };
  return sharedQuad;
}

/**
 * @typedef {Object} VfxBatch
 * @property {Mesh} mesh
 * @property {InstancedBufferGeometry} geometry
 * @property {import('three').ShaderMaterial} material
 * @property {Float32Array} data the interleaved instance data
 * @property {InstancedInterleavedBuffer} buffer
 * @property {Object} layout
 * @property {Array<Object>} sources which emitters feed this batch
 */

/**
 * Build a batch for one Output.
 *
 * @param {Object} spec
 * @param {Object} spec.output an entry from irSystem.outputs
 * @param {Array<Object>} spec.sources emitters whose particles this draws
 * @param {number} spec.capacity total instances to make room for
 * @param {import('three').Texture|null} [spec.texture]
 * @param {number} [spec.intensity]
 * @param {boolean} [spec.toneMapped]
 * @returns {VfxBatch}
 */
export function createBatch(spec) {
  const {
    output, sources, capacity, texture = null, intensity = 1, toneMapped = true,
  } = spec;
  const layout = output.instanceLayout;

  const geometry = new InstancedBufferGeometry();
  if (spec.meshGeometry) {
    // A MESH OUTPUT, with the source attributes CLONED rather than referenced.
    //
    // Referencing them would be cheaper and would make ownership ambiguous:
    // `geometry.dispose()` tells three to release the GPU buffer for every
    // attribute it holds, so tearing down one batch would drop the buffers
    // behind an asset that other batches are still drawing. They would silently
    // re-upload on the next frame, so the symptom is a stall rather than an
    // error - the hardest kind of shared-resource bug to attribute.
    //
    // A particle mesh is small by definition (its own teach line says so), so
    // a copy per batch is a few kilobytes in exchange for disposeBatch being
    // unconditionally correct.
    for (const [name, attribute] of Object.entries(spec.meshGeometry.attributes)) {
      geometry.setAttribute(name, attribute.clone());
    }
    if (spec.meshGeometry.index) geometry.setIndex(spec.meshGeometry.index.clone());
  } else {
    const quad = getSharedQuad();
    geometry.setAttribute('position', new BufferAttribute(quad.position, 3));
    geometry.setAttribute('uv', new BufferAttribute(quad.uv, 2));
    geometry.setIndex(new BufferAttribute(quad.index, 1));
  }

  // Allocated once at the effect's total capacity and never grown. Growing
  // means recreating a GPU buffer mid-frame, at exactly the moment the effect
  // is most demanding - the same argument the pool makes for its own fixed
  // capacity. Rounded up so a small capacity edit does not change the size.
  const instances = Math.max(1, Math.ceil(capacity / 256) * 256);
  const data = new Float32Array(instances * layout.stride);
  const buffer = new InstancedInterleavedBuffer(data, layout.stride, 1);
  buffer.setUsage(DynamicDrawUsage);

  for (const field of layout.fields) {
    geometry.setAttribute(
      field.name,
      new InterleavedBufferAttribute(buffer, field.size, field.offset),
    );
  }

  // Nothing else knows where the particles are, and a bounding sphere computed
  // from the quad would be a half-metre ball at the origin - so the mesh would
  // be culled the moment the camera looked at the effect rather than at the
  // origin. The runtime could maintain a real bounds, but frustum culling one
  // draw call is not worth the per-frame cost of computing it.
  geometry.boundingSphere = null;

  const material = createParticleMaterial({
    layout,
    mode: output.mode,
    blend: output.blend,
    texture,
    intensity,
    toneMapped,
    // The atlas grid. Part of the batch key too, so every source in this batch
    // agrees about it - two outputs with different layouts cannot share a draw
    // without one of them playing its sheet through the other's grid.
    tiles: output.tiles || null,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  // Additive layers should not fight each other for depth order; renderOrder
  // gives the author a lever that costs nothing.
  mesh.renderOrder = output.renderOrder || 0;

  return {
    output,
    sources,
    layout,
    geometry,
    material,
    mesh,
    data,
    buffer,
    instances,
    // Reused across frames so a sort allocates nothing. Only built when the
    // output actually sorts.
    sortKeys: null,
    sortOrder: null,
    lastSortCamX: 0,
    lastSortCamY: 0,
    lastSortCamZ: 0,
    written: 0,
  };
}

/**
 * Fill the instance buffer from the pools feeding this batch.
 *
 * @param {VfxBatch} batch
 * @param {{x: number, y: number, z: number}} [cameraDir] view direction, for sorting
 * @returns {number} instances written
 */
export function writeBatch(batch, cameraDir) {
  const { data, layout, sources } = batch;
  const stride = layout.stride;
  const fields = layout.fields;
  let write = 0;

  for (const emitter of sources) {
    const pool = emitter.pool;
    const count = Math.min(pool.count, batch.instances - write);
    if (count <= 0) continue;

    // Sorting reorders the WRITE, not the pool: the simulation's own ordering
    // is what makes it deterministic, and reordering the pool to please the
    // camera would make the checksum depend on where the camera was.
    let order = null;
    if (batch.output.sort === 'depth' && cameraDir) {
      order = sortIndicesByDepth(batch, pool, cameraDir);
    }

    for (const field of fields) {
      const plane = pool.planes[field.from];
      if (!plane) continue;
      const size = field.size;
      const base = write * stride + field.offset;
      if (order) {
        for (let i = 0; i < count; i += 1) {
          const from = order[i] * size;
          const to = base + i * stride;
          for (let c = 0; c < size; c += 1) data[to + c] = plane[from + c];
        }
      } else {
        for (let i = 0; i < count; i += 1) {
          const from = i * size;
          const to = base + i * stride;
          for (let c = 0; c < size; c += 1) data[to + c] = plane[from + c];
        }
      }
    }
    write += count;
  }

  batch.written = write;
  batch.geometry.instanceCount = write;
  if (write > 0) {
    // Only the live range is uploaded. A batch at ten percent of capacity sends
    // ten percent of the bytes, which on the biggest per-frame transfer in the
    // renderer is worth the one line.
    batch.buffer.clearUpdateRanges();
    batch.buffer.addUpdateRange(0, write * stride);
    batch.buffer.needsUpdate = true;
  }
  return write;
}

/**
 * Per-frame material state.
 *
 * @param {VfxBatch} batch
 * @param {{alphaDt: number}} frame
 */
export function updateBatch(batch, frame) {
  updateParticleMaterial(batch.material, frame);
}

/**
 * Release everything this batch owns.
 *
 * Explicit, because nothing in this repo relies on R3F auto-dispose for
 * resources it created itself - see the `dispose={null}` comment in
 * src/components/assembly/AssemblyPieceMesh.jsx and the reasoning in
 * src/hooks/useAssemblyScene.js. The shared quad's own arrays are not disposed:
 * they belong to the module, not to any one batch.
 *
 * @param {VfxBatch} batch
 */
export function disposeBatch(batch) {
  batch.geometry.dispose();
  batch.material.dispose();
}

/**
 * Group an IR's outputs into batches, merging the ones that can share a draw.
 *
 * The batch key comes from the compiler and covers render mode, blend, sort and
 * texture slot - the same criterion three.quarks' BatchedRenderer.equals uses,
 * which is the right one. A typical explosion of flash, sparks, smoke and
 * debris collapses from four systems to two or three draws.
 *
 * @param {Object} ir
 * @param {Array<Object>} emitters
 * @param {{textures?: Map<number, import('three').Texture>,
 *          meshes?: Map<number, Object>, toneMapped?: boolean}} [options]
 * @returns {VfxBatch[]}
 */
export function createBatches(ir, emitters, options = {}) {
  const textures = options.textures || new Map();
  const meshes = options.meshes || new Map();
  const groups = new Map();

  ir.systems.forEach((irSystem, index) => {
    const emitter = emitters[index];
    if (!emitter) return;
    for (const output of irSystem.outputs) {
      const existing = groups.get(output.batchKey);
      if (existing) {
        existing.sources.push(emitter);
        existing.capacity += irSystem.capacity;
        continue;
      }
      groups.set(output.batchKey, {
        output,
        sources: [emitter],
        capacity: irSystem.capacity,
      });
    }
  });

  return [...groups.values()].map((group) => {
    // Which asset slot this output's texture block resolved to, and therefore
    // which loaded texture to bind.
    const textureBlock = group.output.blocks.find((b) => b.kernel === 'output.texture');
    const slotIndex = textureBlock?.assetSlots?.texture ?? -1;
    const asset = slotIndex >= 0 ? ir.assets[slotIndex] : null;
    // Always a sprite. An effect with no texture chosen, or whose texture was
    // deleted, draws with the built-in soft blob rather than with hard squares -
    // see the header of assets.js for why that is a product decision and not a
    // convenience.
    const texture = (asset && textures.get(asset.assetId)) || getDefaultSprite();

    // The model, for a mesh output. As with the texture there is ALWAYS one -
    // an author who switches the mode before choosing an asset sees a chip of
    // debris rather than nothing, which is the same argument the built-in
    // sprite makes.
    let meshGeometry = null;
    if (group.output.mode === 'mesh') {
      const meshBlock = group.output.blocks.find((b) => b.kernel === 'output.mesh');
      const meshSlot = meshBlock?.assetSlots?.mesh ?? -1;
      const meshAsset = meshSlot >= 0 ? ir.assets[meshSlot] : null;
      meshGeometry = (meshAsset && meshes.get(meshAsset.assetId)) || getDefaultParticleMesh();
    }

    return createBatch({
      output: group.output,
      sources: group.sources,
      capacity: group.capacity,
      texture,
      meshGeometry,
      toneMapped: options.toneMapped !== false,
    });
  });
}
