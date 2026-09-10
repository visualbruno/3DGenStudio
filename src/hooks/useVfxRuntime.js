// Owns the VFX runtime and its GPU objects, at PAGE level - deliberately above
// the <Canvas>, not inside it.
//
// That placement is the whole reason this hook exists, and the argument is the
// one written in the header of src/hooks/useAssemblyScene.js: R3F reconciles
// <primitive object={...}> on object identity, so re-rendering with the same
// Object3D does not remount it or re-upload its GPU buffers. Because these
// meshes belong to the page rather than to the Canvas, a `key={contextRevision}`
// remount after a WebGL context loss re-mounts the SAME meshes under the new
// renderer - and, more importantly, the CPU simulation state is untouched, so
// the effect CONTINUES instead of restarting. An effect that jumped back to
// frame zero every time a driver hiccuped would be maddening to tune.
//
// TWO MEMOS, NOT ONE, and the split is the point. The runtime is keyed on the
// graph hash alone; the batches are keyed on the runtime AND the textures. So
// when textures finish loading, only the batches are rebuilt - the simulation
// is mid-flight and the author is watching it, and restarting the effect the
// moment its textures arrived would look like a stutter with no cause.
//
// Construction happens during render rather than in an effect. Building a
// runtime is synchronous and touches no DOM, so there is nothing to defer, and
// deriving it means React never has to re-render to catch up with itself.
// Disposal is the part that belongs in an effect, keyed on the value it owns.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createBatches, disposeBatch } from '../utils/vfx/batch.js'
import {
  disposeVfxMeshes,
  disposeVfxTextures,
  loadVfxMeshes,
  loadVfxTextures,
} from '../utils/vfx/assets.js'
import { createVfxRuntime, installMeshSamplers } from '../utils/vfx/system.js'

// Shared empties, so an effect with no assets keeps a STABLE identity and the
// batches memo below does not rebuild every render.
const NO_TEXTURES = new Map()
const NO_FAILURES = Object.freeze([])
const NO_MESHES = new Map()

/**
 * @param {Object} options
 * @param {Object|null} options.ir compiled IR, or null
 * @param {(asset: Object) => string|null} [options.resolveUrl] asset id -> URL
 * @param {boolean} [options.profile] per-kernel timing
 * @param {boolean} [options.toneMapped]
 * @returns {{runtime: Object|null, batches: Array<Object>,
 *   textures: Map<number, Object>, meshes: Map<number, Object>}}
 */
export default function useVfxRuntime({ ir, resolveUrl = null, profile = false, toneMapped = true }) {
  const [textures, setTextures] = useState(NO_TEXTURES)
  // ASSETS THAT DID NOT LOAD, which used to be computed and thrown away.
  //
  // Both loaders have always returned a `failed` list and nothing has ever read
  // it, so a texture that 404s, fails to decode, or cannot be resolved fell
  // back to the built-in sprite in complete silence. Falling back is the right
  // BEHAVIOUR - an effect should still play - but doing it without a word is
  // what made "I assigned a sprite and nothing changed" impossible to diagnose
  // from the screen.
  const [failedAssets, setFailedAssets] = useState(NO_FAILURES)

  const setFailed = useCallback((kind, ids) => {
    setFailedAssets(current => {
      const others = current.filter(entry => entry.kind !== kind)
      const mine = (ids || []).map(assetId => ({ kind, assetId }))
      if (others.length === current.length && mine.length === 0) return current
      const next = [...others, ...mine]
      // Identity matters: this feeds a render, and a fresh empty array on every
      // load would re-render the page for no change.
      return next.length === 0 && current.length === 0 ? current : next
    })
  }, [])
  const [meshes, setMeshes] = useState(NO_MESHES)

  // The graph hash, not the IR object: the compiler is pure, so recompiling an
  // unchanged document yields a new object with the same hash. Keying on
  // identity would rebuild the whole runtime on every unrelated re-render.
  const hash = ir ? ir.graphHash : null

  const runtime = useMemo(
    () => (ir ? createVfxRuntime(ir, { profile }) : null),
    // ir is intentionally absent: hash is its identity for these purposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash, profile],
  )

  const batches = useMemo(
    () => (runtime && ir
      ? createBatches(ir, runtime.emitters, { textures, meshes, toneMapped })
      : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, textures, meshes, toneMapped],
  )

  // Batches own a geometry and a material each. Nothing in this repo relies on
  // R3F auto-dispose for resources it created itself - see the comment on
  // AssemblyPieceMesh.jsx and the reasoning in useAssemblyScene.js.
  useEffect(() => () => {
    for (const batch of batches) disposeBatch(batch)
  }, [batches])

  // KEYED ON THE RESOLVER AS WELL AS THE DOCUMENT, and the second half of that
  // is a bug fix.
  //
  // `resolveUrl` is built from the asset library, which the page fetches
  // asynchronously - so on opening a SAVED effect there is a race, and the
  // document usually wins. The effect then ran with a resolver that could not
  // resolve anything, every asset came back null, `size === 0` took the early
  // return, and nothing ever re-ran it: the library arriving changed
  // `resolveUrl`, which was not a dependency. The effect drew with the built-in
  // sprite until the author touched any property, which recompiled the graph,
  // changed the hash and ran this again - by which time the library was there.
  // "Change a value and it appears" was the symptom.
  //
  // `ir` stays out on purpose: it is a NEW object on every recompile, including
  // ones the hash deliberately ignores (moving a node, editing a note), and
  // keying on it would reload every texture when the board was tidied.
  useEffect(() => {
    if (!ir || !resolveUrl) return undefined
    let cancelled = false
    loadVfxTextures(ir, { resolveUrl }).then(result => {
      // A late resolve for an effect the author has already navigated away
      // from must not touch the current one.
      if (cancelled) return
      setFailed('texture', result.failed)
      if (result.textures.size === 0) return
      setTextures(result.textures)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, resolveUrl])

  // Meshes, in their own effect rather than awaited alongside the textures.
  //
  // A glTF is slower to fetch and parse than a PNG, and batching the two would
  // hold the textures back until the model arrived - so an effect with both
  // would show untextured quads for as long as the mesh took, rather than
  // showing its sprites immediately and swapping in the model when it lands.
  useEffect(() => {
    if (!ir || !resolveUrl) return undefined
    let cancelled = false
    loadVfxMeshes(ir, { resolveUrl }).then(result => {
      if (cancelled) return
      setFailed('mesh', result.failed)
      if (result.meshes.size === 0) return
      setMeshes(result.meshes)
      // THE SAME GEOMETRY SERVES BOTH JOBS. A mesh may be the particle's own
      // model, the shape it spawns over, or both, and loadVfxMeshes has already
      // centred and unit-scaled it - which is what makes the emitter's Scale
      // property mean one metre regardless of how the model was authored.
      // Installed into the live runtime rather than triggering a rebuild: a
      // rebuild would restart the effect every time a mesh finished loading.
      // `runtime` is memoised on the same `hash` this effect is keyed to, so
      // the one in scope is the one these meshes belong to - a later document
      // would have cancelled this callback.
      if (!runtime) return
      // One installer, shared with the sprite-sheet bake and the simulated
      // thumbnail - see installMeshSamplers. This was the original copy, and
      // the other two never having one is what baked mesh emitters as a dot.
      installMeshSamplers(runtime, result.meshes)
    })
    return () => {
      cancelled = true
    }
    // Same three dependencies as the textures above, for the same reason -
    // plus `runtime`, because this effect installs the samplers INTO it and a
    // sampler handed to the previous runtime is a sampler nothing will read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, resolveUrl, runtime])

  useEffect(() => () => {
    if (meshes !== NO_MESHES) disposeVfxMeshes(meshes)
  }, [meshes])

  // Released when they are replaced, and when the page goes away. The built-in
  // sprite is module-owned and disposeVfxTextures skips it - it outlives any
  // one effect, and disposing it would leave the next one untextured.
  useEffect(() => () => {
    if (textures !== NO_TEXTURES) disposeVfxTextures(textures)
  }, [textures])

  return { runtime, batches, textures, meshes, failedAssets }
}
