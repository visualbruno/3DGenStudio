// Mesh Assembly workspace.
//
// Fit AI-generated garments (armour, boots, gauntlets, a helm) onto a base
// body. Each was generated from its own prompt, so nothing shares a scale or
// proportions; this page is where they get placed and then adapted to fit.
//
// GLOBAL, not project-scoped: an assembly is a character, and its pieces
// routinely come from different projects — a body generated in one wearing
// armour generated in another is the normal case. Hence /assembly with no
// projectId, a Header nav link rather than a project-scoped button, and the
// MeshAssemblies table sitting beside Motions and CustomAnimations.
//
// This file is a SHELL on purpose: the document lives in useAssemblyDocument,
// the loaded meshes in useAssemblyScene, picking in useAssemblyPicking, and the
// scene in AssemblyViewport. The thing being avoided is MeshEditorPage.jsx,
// which is 12,190 lines because everything went inline.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import AssetSelectorModal from '../components/AssetSelectorModal'
import AssemblySwitcher from '../components/assembly/AssemblySwitcher'
import AssemblyPieceList from '../components/assembly/AssemblyPieceList'
import AssemblyViewport from '../components/assembly/AssemblyViewport'
import AssemblyViewportToolbar from '../components/assembly/AssemblyViewportToolbar'
import AssemblyTransformPanel from '../components/assembly/AssemblyTransformPanel'
import AssemblyFitPanel from '../components/assembly/AssemblyFitPanel'
import AssemblySaveDialog from '../components/assembly/AssemblySaveDialog'
import useAssemblyDocument from '../hooks/useAssemblyDocument'
import useAssemblyScene from '../hooks/useAssemblyScene'
import useAssemblyPicking from '../hooks/useAssemblyPicking'
import useAssemblyAlignment from '../hooks/useAssemblyAlignment'
import useAssemblyFitRun from '../hooks/useAssemblyFitRun'
import useAssemblySculpt from '../hooks/useAssemblySculpt'
import useAssemblySave from '../hooks/useAssemblySave'
import { useProjects } from '../context/ProjectContext'
import { getBasePiece, getGarmentPieces, getVisiblePieces } from '../utils/assemblyHelpers'
import { pieceHasEdit } from '../utils/assemblyExport'
import { boundsProxyGeometry, boxDiagonal, pieceWorldBox } from '../utils/assemblyGeometry'
import { fitCameraToSphere, meshFittingSphere } from '../utils/cameraFraming'
import './AssemblyPage.css'

const SAVE_LABELS = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
}

export default function AssemblyPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const assemblyId = searchParams.get('assemblyId')

  const [showSettings, setShowSettings] = useState(false)
  const [showMeshPicker, setShowMeshPicker] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [contextRevision, setContextRevision] = useState(0)

  const shellRef = useRef(null)
  const cameraRef = useRef(null)
  const controlsRef = useRef(null)

  const setAssemblyId = useCallback(id => {
    setSearchParams(id ? { assemblyId: String(id) } : {}, { replace: true })
  }, [setSearchParams])

  const {
    assemblies, meta, doc, ready, loading, loadError, saveStatus,
    canUndo, canRedo, undo, redo,
    addPieces, patchPiece, setMerged, duplicatePiece, removePiece, setBase, reorderPieces, patchSettings,
    setMaterialClass,
    createNewAssembly, renameCurrentAssembly, deleteCurrentAssembly, selectAssembly,
  } = useAssemblyDocument({ assemblyId, onAssemblyIdChange: setAssemblyId })

  const {
    entries, loadErrors, loadedPieceIds, getEntry, getVisibleBounds,
  } = useAssemblyScene(doc)
  const {
    handleSelectPointerDown, gizmoDraggingRef,
  } = useAssemblyPicking({ shellRef, cameraRef, entries, doc })

  // Declared before the fit run so it can be told when a preview's buffers are
  // about to go away — a sculpt undo entry pointing at a disposed geometry
  // would write into freed memory.
  const sculptHistoryRef = useRef(null)
  const notifyPreviewReplaced = useCallback(preview => {
    sculptHistoryRef.current?.(preview)
  }, [])
  const fit = useAssemblyFitRun({
    assemblyId, doc, entries, getEntry, patchPiece, gizmoDraggingRef,
    onPreviewReplaced: notifyPreviewReplaced,
  })
  const fitEnsurePreview = fit.ensurePreview

  // Everything durable happens here — see useAssemblySave's header. It needs
  // ProjectContext only as a caller of three existing writes; no new context
  // members were added for the assembly workspace.
  const { projects, saveMeshEdit, uploadAssetThumbnail, linkAssetToProject } = useProjects()
  const assemblySave = useAssemblySave({
    doc,
    meta,
    getEntry,
    previews: fit.previews,
    patchPiece,
    setMerged,
    dropPreview: fit.dropPreview,
    saveMeshEdit,
    uploadAssetThumbnail,
    linkAssetToProject,
  })

  const base = getBasePiece(doc)
  const garments = getGarmentPieces(doc)
  const visiblePieces = getVisiblePieces(doc)
  const selectedPiece = doc.pieces.find(piece => piece.id === doc.settings.selectedPieceId) || null
  const selectedEntry = selectedPiece ? getEntry(selectedPiece.id) : null

  // Sculpt mode needs no prior selection: you sculpt whatever you click, and
  // the click also selects it so the panels follow. Requiring a selection first
  // meant the brush button sat disabled with nothing explaining why.
  const sculptEnabled = !!doc.settings.sculptMode

  // What is under the brush. Raycasts the piece as it is DRAWN — the preview
  // when one is showing, the loaded mesh otherwise — then hands back that
  // piece's preview to edit, creating one if this is its first stroke.
  const resolveSculptTarget = raycaster => {
    let best = null
    for (const piece of getVisiblePieces(doc)) {
      if (piece.locked) continue
      const drawn = fit.showFitted.has(piece.id)
        ? fit.previews.get(piece.id)
        : getEntry(piece.id)
      if (!drawn?.root) continue
      const hits = raycaster.intersectObject(drawn.root, true)
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        best = { piece, distance: hits[0].distance, point: hits[0].point }
      }
    }
    if (!best) return null

    const entry = fitEnsurePreview(best.piece.id)
    if (!entry) return null
    if (doc.settings.selectedPieceId !== best.piece.id) {
      patchSettings({ selectedPieceId: best.piece.id })
    }
    return { entry, point: best.point }
  }

  const sculpt = useAssemblySculpt({
    shellRef,
    cameraRef,
    resolveTarget: resolveSculptTarget,
    onEdited: fit.persistPiece,
    enabled: sculptEnabled,
    radiusPixels: doc.settings.sculptRadius ?? 80,
    strength: doc.settings.sculptStrength ?? 1,
  })

  // Assigned in an effect, not during render: a render can be discarded or
  // replayed, and the fit run reads this ref from async callbacks.
  useEffect(() => {
    sculptHistoryRef.current = sculpt.forgetHistoryFor
  }, [sculpt.forgetHistoryFor])

  // Which pieces are LOADED — not merely present in the document. The camera
  // re-frames when a mesh finishes loading (its bounds are new information), but
  // must NOT re-frame when a piece is merely moved, or every gizmo drag would
  // yank the camera back. So this key tracks membership, never placement.
  const loadedKey = loadedPieceIds.join(',')

  // Scoped to what is actually SHOWN, so isolating a piece reports that piece's
  // verts. Summing every loaded entry made the readout say "1 mesh" beside the
  // vertex total for two.
  const visibleVertexCount = visiblePieces.reduce(
    (sum, piece) => sum + (getEntry(piece.id)?.vertexCount || 0), 0,
  )

  // Placement changes DO move the bounds, which is what keeps the orbit and zoom
  // clamps honest as pieces are scaled — it just does not re-frame.
  //
  // Keyed on `doc` rather than the derived `visiblePieces` array, which is a new
  // array identity on every render and would defeat the memo entirely.
  const bounds = useMemo(
    () => getVisibleBounds(getVisiblePieces(doc)),
    [getVisibleBounds, doc],
  )

  // Numeric-field increment scaled to the assembly, so a 0.02-unit piece and a
  // 200-unit body both get a usable step. A fixed step would be unusable on one
  // or the other, and AI meshes span both extremes.
  const positionStep = useMemo(() => {
    const diagonal = boxDiagonal(bounds)
    return diagonal > 0 ? Math.max(diagonal / 200, 1e-5) : 0.01
  }, [bounds])

  // Selected piece size relative to the base — the number that makes "this
  // armour is 2% of the body" obvious instead of something to discover by
  // zooming around.
  const scaleRatio = useMemo(() => {
    const selected = doc.pieces.find(piece => piece.id === doc.settings.selectedPieceId)
    if (!selected || !base || selected.id === base.id) return null
    const selectedEntry = getEntry(selected.id)
    const baseEntry = getEntry(base.id)
    if (!selectedEntry || !baseEntry) return null
    const baseDiagonal = boxDiagonal(pieceWorldBox(baseEntry, base))
    if (!(baseDiagonal > 0)) return null
    return boxDiagonal(pieceWorldBox(selectedEntry, selected)) / baseDiagonal
  }, [doc, base, getEntry])

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) for history, and bare G / R / S
  // for the gizmo mode, which is what anyone arriving from Blender will try.
  // All of it is ignored while a text field has focus, so typing a name or a
  // numeric value keeps native editing and does not switch tools mid-word.
  useEffect(() => {
    const onKeyDown = event => {
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return

      const key = event.key.toLowerCase()

      if (event.ctrlKey || event.metaKey) {
        if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo() }
        else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); redo() }
        return
      }
      if (event.altKey || event.shiftKey) return

      const mode = key === 'g' ? 'translate' : key === 'r' ? 'rotate' : key === 's' ? 'scale' : null
      if (mode) {
        event.preventDefault()
        patchSettings({ gizmoMode: mode })
      } else if (key === 'escape' && doc.settings.isolatedPieceId) {
        patchSettings({ isolatedPieceId: null })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, patchSettings, doc.settings.isolatedPieceId])

  const handleAddMeshes = useCallback(picked => {
    addPieces(picked)
    setShowMeshPicker(false)
  }, [addPieces])

  // While sculpting, the pointer belongs to the brush: a drag must not also
  // re-select whatever it passes over. Orbit is unaffected — it lives on the
  // middle and right buttons (CameraRig leaves LEFT unbound).
  const handlePointerDown = useCallback(event => {
    // Only the 3D view picks. The toolbar and every other overlay live INSIDE
    // this shell, so their clicks bubble here too — and a click on a button is
    // a raycast that hits nothing, which used to read as "clicked empty space"
    // and clear the selection. Pressing Rotate or Scale therefore deselected
    // the very piece it was about to act on.
    //
    // Testing for the canvas rather than excluding the toolbar by class covers
    // every overlay added later for free. Only pointerDOWN is guarded: a stroke
    // that starts on the canvas and releases over the toolbar must still end.
    if (!(event.target instanceof HTMLCanvasElement)) return

    if (sculpt.onPointerDown(event)) return
    if (sculptEnabled) return
    handleSelectPointerDown(event, pieceId => patchSettings({ selectedPieceId: pieceId }))
  }, [sculpt, sculptEnabled, handleSelectPointerDown, patchSettings])

  const {
    commit: commitToSelected,
    fitToRegion, moveToRegion, dropToSurface, mirror, duplicate, reset,
    copyTransform, pasteTransform, clipboardFilled,
    onGizmoDragStart, onGizmoDrag, onGizmoDragEnd,
  } = useAssemblyAlignment({
    base, selectedPiece, selectedEntry, getEntry, patchPiece, duplicatePiece, gizmoDraggingRef,
    onPlacementCommitted: fit.rebasePreview,
  })


  // "Frame everything" is the FIT, not the load framing.
  //
  // cameraFraming.js keeps those deliberately separate: the load framing sits
  // back at ~3.8 bounding-sphere radii to leave room to work in, while a fit
  // fills the viewport. Bumping frameKey would re-run the LOAD framing, which
  // reads as the camera pulling away — so this calls fitCameraToSphere directly,
  // exactly as the view cube's double-click does, and the two now agree.
  //
  // Passing `controls` is what makes it stick: it moves the orbit target onto
  // the new centre, without which the view snaps back on the next drag.
  const handleFrameAll = useCallback(() => {
    const camera = cameraRef.current
    if (!camera || !bounds || bounds.isEmpty()) return
    const proxy = boundsProxyGeometry(bounds)
    const sphere = meshFittingSphere(proxy)
    if (sphere) fitCameraToSphere(camera, controlsRef.current, sphere)
    proxy.dispose()
  }, [bounds])

  const loadErrorList = Object.entries(loadErrors)

  return (
    <div className="assembly-page">
      <Header
        title={meta?.name || 'Mesh Assembly'}
        centerTitle
        onSettingsClick={() => setShowSettings(true)}
      />

      <div className="assembly-page__toolbar">
        <AssemblySwitcher
          assemblies={assemblies}
          currentId={assemblyId}
          currentName={meta?.name}
          onSelect={selectAssembly}
          onCreate={createNewAssembly}
          onRename={renameCurrentAssembly}
          onDelete={deleteCurrentAssembly}
        />

        <div className="assembly-page__toolbar-spacer" />

        <div className="assembly-page__history">
          <button type="button" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>undo</span>
          </button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>redo</span>
          </button>
        </div>

        <span className={`assembly-page__save assembly-page__save--${saveStatus}`}>
          {SAVE_LABELS[saveStatus]}
        </span>

        {/* The document autosaves; this button is about ASSETS, which never
            change without being asked. Two different meanings of "save", so the
            wording has to carry the difference. */}
        <button
          type="button"
          className="assembly-page__save-btn"
          onClick={() => setShowSaveDialog(true)}
          disabled={!ready || !doc.pieces.length}
          title="Save fitted pieces and the assembled mesh as assets"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>save</span>
          Save as assets
        </button>
      </div>

      {loadError && <div className="assembly-page__error">{loadError}</div>}
      {loadErrorList.length > 0 && (
        <div className="assembly-page__error">
          {loadErrorList.length} mesh{loadErrorList.length === 1 ? '' : 'es'} could not be loaded:{' '}
          {loadErrorList.map(([pieceId, message]) => {
            const piece = doc.pieces.find(p => p.id === pieceId)
            return `${piece?.name || pieceId} (${message})`
          }).join(', ')}
        </div>
      )}

      <div className="assembly-page__workspace">
        <aside className="assembly-page__rail">
          {ready ? (
            <AssemblyPieceList
              doc={doc}
              onAddClick={() => setShowMeshPicker(true)}
              onSelect={id => patchSettings({ selectedPieceId: id })}
              onSetBase={setBase}
              onPatchPiece={patchPiece}
              onRemovePiece={id => {
                // Drop the preview first: that is what removes the piece's
                // stored geometry. Removing the piece alone would leave the
                // file behind until the whole assembly is deleted.
                fit.dropPreview(id)
                removePiece(id)
              }}
              onReorder={reorderPieces}
              onIsolate={id => patchSettings({ isolatedPieceId: id })}
            />
          ) : loading ? (
            <div className="assembly-page__loading">Loading…</div>
          ) : (
            // Reached by deleting the last assembly. Nothing is auto-created
            // here: deleting them all is a deliberate act, and immediately
            // conjuring a replacement would fight the user.
            <div className="assembly-page__loading">
              No assembly selected. Use <strong>New</strong> above to create one.
            </div>
          )}
        </aside>

        <main
          className={`assembly-page__viewport ${sculptEnabled ? 'assembly-page__viewport--sculpt' : ''}`}
          ref={shellRef}
          onPointerDown={handlePointerDown}
          onPointerMove={sculpt.onPointerMove}
          onPointerUp={sculpt.onPointerUp}
          onPointerLeave={() => { sculpt.onPointerUp(); sculpt.onPointerLeave() }}
        >
          {ready && doc.pieces.length > 0 ? (
            <>
              <AssemblyViewport
                doc={doc}
                entries={entries}
                previews={fit.previews}
                showFitted={fit.showFitted}
                bounds={bounds}
                frameKey={loadedKey}
                contextRevision={contextRevision}
                onContextLost={() => setContextRevision(revision => revision + 1)}
                onCameraReady={camera => { cameraRef.current = camera }}
                onControlsReady={controls => { controlsRef.current = controls }}
                selectedPiece={selectedEntry ? selectedPiece : null}
                onGizmoDragStart={onGizmoDragStart}
                onGizmoDrag={onGizmoDrag}
                onGizmoDragEnd={onGizmoDragEnd}
              />
              <AssemblyViewportToolbar
                settings={doc.settings}
                onPatchSettings={patchSettings}
                onFrameAll={handleFrameAll}
                hasSelection={!!selectedPiece}
                sculptEnabled={sculptEnabled}
                canSculptUndo={sculpt.canUndo}
                onSculptUndo={sculpt.undo}
                pieceCount={visiblePieces.length}
                vertexCount={visibleVertexCount}
                scaleRatio={scaleRatio}
              />
              {sculptEnabled && sculpt.cursor && (
                <div
                  className="assembly-page__brush"
                  style={{
                    left: sculpt.cursor.x,
                    top: sculpt.cursor.y,
                    width: sculpt.cursor.radius * 2,
                    height: sculpt.cursor.radius * 2,
                  }}
                />
              )}
              {sculptEnabled && (
                <button
                  type="button"
                  className="assembly-page__sculpt-banner"
                  onClick={() => patchSettings({ sculptMode: false })}
                >
                  Elastic Grab — drag the surface to reshape it · click to exit
                </button>
              )}
              {doc.settings.isolatedPieceId && (
                <button
                  type="button"
                  className="assembly-page__isolate-banner"
                  onClick={() => patchSettings({ isolatedPieceId: null })}
                >
                  Isolated — click to show all
                </button>
              )}
            </>
          ) : (
            <div className="assembly-page__viewport-empty">
              <span className="material-symbols-outlined" style={{ fontSize: '48px' }}>view_in_ar</span>
              <h2>Nothing to show yet</h2>
              {!ready ? (
                <p>Create or select an assembly to begin.</p>
              ) : (
                <p>
                  Add the body mesh first — it becomes the base everything else is
                  fitted to. Pieces can come from any project.
                </p>
              )}
            </div>
          )}
        </main>

        <aside className="assembly-page__panel">
          <AssemblyTransformPanel
            piece={selectedPiece}
            isBase={!!selectedPiece && selectedPiece.id === doc.basePieceId}
            stats={selectedEntry
              ? { vertexCount: selectedEntry.vertexCount, faceCount: selectedEntry.faceCount, hasSkin: selectedEntry.hasSkin }
              : null}
            scaleRatio={scaleRatio}
            worldSize={selectedEntry && selectedPiece
              ? pieceWorldBox(selectedEntry, selectedPiece).getSize(new THREE.Vector3()).toArray()
              : null}
            positionStep={positionStep}
            hasBase={!!base}
            onCommit={commitToSelected}
            onFitToRegion={fitToRegion}
            onMoveToRegion={moveToRegion}
            onDropToSurface={dropToSurface}
            onMirror={mirror}
            onDuplicate={duplicate}
            onReset={reset}
            onCopyTransform={copyTransform}
            onPasteTransform={pasteTransform}
            canPaste={clipboardFilled}
          />

          <AssemblyFitPanel
            piece={selectedPiece}
            isBase={!!selectedPiece && selectedPiece.id === doc.basePieceId}
            hasBase={!!base}
            hasPreview={!!selectedPiece && fit.previews.has(selectedPiece.id)}
            showingFitted={!!selectedPiece && fit.showFitted.has(selectedPiece.id)}
            running={fit.running}
            progress={fit.progress}
            error={fit.error}
            garmentCount={garments.length}
            onClearError={fit.clearError}
            onSetMaterialClass={setMaterialClass}
            onPatchPiece={patchPiece}
            onRun={fit.run}
            onRunAll={() => fit.run(garments.map(piece => piece.id))}
            onCancel={fit.cancel}
            onRevert={fit.revert}
            onToggleFitted={fit.toggleFitted}
          />
        </aside>
      </div>

      <Footer variant="kanban" />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showSaveDialog && (
        <AssemblySaveDialog
          editedPieces={doc.pieces.map(piece => ({
            piece,
            hasEdit: piece.assetId !== null && pieceHasEdit(fit.previews.get(piece.id)),
          }))}
          assemblyName={meta?.name}
          projects={projects}
          busy={assemblySave.busy}
          progress={assemblySave.progress}
          error={assemblySave.error}
          result={assemblySave.result}
          onSave={assemblySave.save}
          onClose={() => { assemblySave.clear(); setShowSaveDialog(false) }}
        />
      )}

      {showMeshPicker && (
        <AssetSelectorModal
          assetType="mesh"
          multiple
          showEdits
          title="Add meshes to the assembly"
          onSelect={handleAddMeshes}
          onClose={() => setShowMeshPicker(false)}
        />
      )}

      {/* Reported for the base only when it is missing, since fitting has no
          target without it. Garment-level problems show on their own rows. */}
      {ready && doc.pieces.length > 0 && !base && (
        <div className="assembly-page__error">This assembly has no base mesh.</div>
      )}
    </div>
  )
}
