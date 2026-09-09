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

import { useEffect, useMemo, useState } from 'react'
import { createBatches, disposeBatch } from '../utils/vfx/batch.js'
import { disposeVfxTextures, loadVfxTextures } from '../utils/vfx/assets.js'
import { createVfxRuntime } from '../utils/vfx/system.js'

const NO_TEXTURES = new Map()

/**
 * @param {Object} options
 * @param {Object|null} options.ir compiled IR, or null
 * @param {(asset: Object) => string|null} [options.resolveUrl] asset id -> URL
 * @param {boolean} [options.profile] per-kernel timing
 * @param {boolean} [options.toneMapped]
 * @returns {{runtime: Object|null, batches: Array<Object>}}
 */
export default function useVfxRuntime({ ir, resolveUrl = null, profile = false, toneMapped = true }) {
  const [textures, setTextures] = useState(NO_TEXTURES)

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
    () => (runtime && ir ? createBatches(ir, runtime.emitters, { textures, toneMapped }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, textures, toneMapped],
  )

  // Batches own a geometry and a material each. Nothing in this repo relies on
  // R3F auto-dispose for resources it created itself - see the comment on
  // AssemblyPieceMesh.jsx and the reasoning in useAssemblyScene.js.
  useEffect(() => () => {
    for (const batch of batches) disposeBatch(batch)
  }, [batches])

  useEffect(() => {
    if (!ir || !resolveUrl) return undefined
    let cancelled = false
    loadVfxTextures(ir, { resolveUrl }).then(result => {
      // A late resolve for an effect the author has already navigated away
      // from must not touch the current one.
      if (cancelled || result.textures.size === 0) return
      setTextures(result.textures)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash])

  // Released when they are replaced, and when the page goes away. The built-in
  // sprite is module-owned and disposeVfxTextures skips it - it outlives any
  // one effect, and disposing it would leave the next one untextured.
  useEffect(() => () => {
    if (textures !== NO_TEXTURES) disposeVfxTextures(textures)
  }, [textures])

  return { runtime, batches, textures }
}
