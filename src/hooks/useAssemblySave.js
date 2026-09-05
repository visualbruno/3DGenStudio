// Writing an assembly out to assets.
//
// The only place in the workspace that makes anything durable. Everything up to
// here — the fit, the brush — edits a preview held in the session, which is
// what makes Discard free and what keeps a loaded asset from ever being mutated
// behind the user's back.
//
// Two outputs, and they use different existing routes for good reasons:
//
//   * a piece VERSION goes through /api/meshes/editor/save, the same path the
//     Mesh Editor uses, so it becomes a child of the original asset, inherits
//     its project links, merges its metadata and shows up under it on the
//     Assets page. Nothing is overwritten.
//   * the MERGED character goes through /api/assets/library-upload, which is
//     new, because the existing upload route requires a projectId and an
//     assembly has no natural owner — its pieces come from different projects.
import { useCallback, useState } from 'react'
import { API_BASE, assetUrl } from '../config'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import { exportMergedAssemblyGlb, exportPieceGlb, pieceHasEdit } from '../utils/assemblyExport'
import { getBasePiece, getVisiblePieces } from '../utils/assemblyHelpers'

export default function useAssemblySave({
  doc,
  meta,
  getEntry,
  previews,
  patchPiece,
  setMerged,
  dropPreview,
  saveMeshEdit,
  uploadAssetThumbnail,
  linkAssetToProject,
  onSaved,
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  /** Regenerate the asset's thumbnail from what was just written. Returns the
   *  stored thumbnail path, or '' when one could not be made. */
  const refreshThumbnail = useCallback(async saved => {
    if (!saved?.id || !saved?.filename) return ''
    try {
      // cache:'reload' because a 'replace' save reuses the filename, and the
      // browser would otherwise thumbnail the previous bytes.
      const response = await fetch(assetUrl(saved.filename), { cache: 'reload' })
      const file = new File([await response.blob()], saved.filename, { type: 'model/gltf-binary' })
      const thumbnail = await createMeshThumbnailFile(file)
      if (!thumbnail) return ''
      const updated = await uploadAssetThumbnail(saved.id, thumbnail)
      return updated?.thumbnailPath || updated?.thumbnail || ''
    } catch (thumbError) {
      // A missing thumbnail is cosmetic. Never lose the save over it.
      console.warn('Could not refresh the asset thumbnail', thumbError)
      return ''
    }
  }, [uploadAssetThumbnail])

  const save = useCallback(async options => {
    setBusy(true)
    setError('')
    setResult(null)
    const versions = []
    const failed = []
    const repoint = []
    let merged = null

    try {
      // ---- edited pieces, one new version each --------------------------
      if (options.saveVersions) {
        const targets = doc.pieces.filter(piece =>
          piece.assetId !== null && pieceHasEdit(previews.get(piece.id)))

        for (let i = 0; i < targets.length; i += 1) {
          const piece = targets[i]
          setProgress(`Saving ${piece.name} (${i + 1}/${targets.length})…`)
          try {
            const file = await exportPieceGlb({
              piece,
              entry: getEntry(piece.id),
              preview: previews.get(piece.id),
            })
            const saved = await saveMeshEdit({
              assetId: piece.assetId,
              filePath: piece.filePath,
              name: options.names?.[piece.id] || piece.name,
              saveMode: 'version',
              meshFile: file,
              source: 'MESH ASSEMBLY',
              metadataExtra: {
                assemblyId: meta?.id ?? null,
                assemblyName: meta?.name ?? null,
                baseAssetId: getBasePiece(doc)?.assetId ?? null,
                materialClass: piece.materialClass,
              },
            })
            const thumbnail = await refreshThumbnail(saved)
            versions.push(saved)

            // Queued, not applied here: re-pointing swaps the piece's asset,
            // which makes the scene dispose its current entry, and dropping the
            // preview disposes that geometry outright. The merged export below
            // still needs both. So the whole switch happens once, at the end.
            repoint.push({
              pieceId: piece.id,
              patch: {
                assetId: saved?.id ?? piece.assetId,
                name: saved?.name || piece.name,
                filePath: saved?.filePath || saved?.filename || piece.filePath,
                // Cleared because buildAssetUrl prefers `url` over filePath, so
                // a stale one would keep loading the mesh we just replaced.
                url: '',
                thumbnail: thumbnail || '',
                fittedVersionAssetId: saved?.id ?? null,
                fit: { status: 'idle', message: '', stats: {}, fittedAt: Date.now() },
              },
            })
          } catch (pieceError) {
            console.error(`Saving ${piece.name} failed`, pieceError)
            failed.push(piece.name)
          }
        }
      }

      // ---- the assembled character as one mesh --------------------------
      if (options.saveMerged) {
        setProgress('Building the assembled mesh…')
        const base = getBasePiece(doc)
        const entries = getVisiblePieces(doc)
          .filter(piece => options.includeBase || piece.id !== base?.id)
          .map(piece => ({
            piece,
            entry: getEntry(piece.id),
            preview: previews.get(piece.id),
          }))
          .filter(entry => entry.entry)

        if (!entries.length) {
          throw new Error('Nothing visible to merge.')
        }

        const file = await exportMergedAssemblyGlb(entries, options.mergedName)
        setProgress('Saving the assembled mesh…')

        const form = new FormData()
        form.append('file', file)
        form.append('type', 'mesh')
        form.append('name', options.mergedName)
        form.append('metadata', JSON.stringify({
          source: 'MESH ASSEMBLY',
          assemblyId: meta?.id ?? null,
          assemblyName: meta?.name ?? null,
          baseAssetId: base?.assetId ?? null,
          pieceAssetIds: entries.map(e => e.piece.assetId).filter(Boolean),
          savedAt: Date.now(),
        }))

        const response = await fetch(`${API_BASE}/assets/library-upload`, {
          method: 'POST', body: form,
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload?.error || 'Could not save the assembled mesh')
        merged = payload

        await refreshThumbnail(payload)
        if (options.projectId && payload?.id) {
          await linkAssetToProject(options.projectId, payload.id, { cascadeChildren: false })
        }
        // The id is the only link back to what was produced, so it is recorded
        // on the document and flushed immediately rather than waiting on the
        // 700ms autosave — a reload in between would lose the reference.
        setMerged({
          assetId: payload?.id ?? null,
          name: options.mergedName,
          savedAt: Date.now(),
        })
        onSaved?.({ merged: payload })
      }

      setResult({ versions, merged, failed })
    } catch (saveError) {
      console.error('Assembly save failed', saveError)
      setError(saveError.message || 'Save failed')
      setResult({ versions, merged, failed })
    } finally {
      // Point each saved piece at the version it produced, so the fit survives
      // leaving the page. Previews are session-only by design — the document
      // stores no geometry — so without this the armour is unfitted again on
      // the next visit, with no way back to the fitted shape that keeps the
      // placement the user set.
      //
      // Correct because the version was written in the piece's OWN local space
      // with the placement divided out (see exportPieceGlb): the same TRS over
      // the new geometry lands in exactly the same world position. Dropping the
      // preview then leaves the reloaded asset — which IS the fitted shape — as
      // the only thing drawn.
      //
      // In `finally` so a failed merge never strands pieces whose versions did
      // save, pointing at meshes they no longer match.
      for (const { pieceId, patch } of repoint) {
        patchPiece(pieceId, patch, { history: false })
        dropPreview(pieceId)
      }
      setBusy(false)
      setProgress('')
    }
  }, [doc, meta, getEntry, previews, patchPiece, setMerged, dropPreview, saveMeshEdit,
      linkAssetToProject, refreshThumbnail, onSaved])

  return { save, busy, progress, error, result, clear: () => { setResult(null); setError('') } }
}
