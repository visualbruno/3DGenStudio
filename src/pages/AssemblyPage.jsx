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
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import AssetSelectorModal from '../components/AssetSelectorModal'
import AssemblySwitcher from '../components/assembly/AssemblySwitcher'
import AssemblyPieceList from '../components/assembly/AssemblyPieceList'
import AssemblyViewport from '../components/assembly/AssemblyViewport'
import AssemblyViewportToolbar from '../components/assembly/AssemblyViewportToolbar'
import useAssemblyDocument from '../hooks/useAssemblyDocument'
import useAssemblyScene from '../hooks/useAssemblyScene'
import useAssemblyPicking from '../hooks/useAssemblyPicking'
import { getBasePiece, getVisiblePieces } from '../utils/assemblyHelpers'
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
    addPieces, patchPiece, removePiece, setBase, reorderPieces, patchSettings,
    createNewAssembly, renameCurrentAssembly, deleteCurrentAssembly, selectAssembly,
  } = useAssemblyDocument({ assemblyId, onAssemblyIdChange: setAssemblyId })

  const {
    entries, loadErrors, loadedPieceIds, getEntry, getVisibleBounds,
  } = useAssemblyScene(doc)
  const { handleSelectPointerDown } = useAssemblyPicking({ shellRef, cameraRef, entries, doc })

  const base = getBasePiece(doc)
  const visiblePieces = getVisiblePieces(doc)

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

  // Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) over the document. Ignored while a text
  // field has focus so renaming an assembly keeps native undo.
  useEffect(() => {
    const onKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey)) return
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return

      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo() }
      else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  const handleAddMeshes = useCallback(picked => {
    addPieces(picked)
    setShowMeshPicker(false)
  }, [addPieces])

  const handlePointerDown = useCallback(event => {
    handleSelectPointerDown(event, pieceId => patchSettings({ selectedPieceId: pieceId }))
  }, [handleSelectPointerDown, patchSettings])

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
              onRemovePiece={removePiece}
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

        <main className="assembly-page__viewport" ref={shellRef} onPointerDown={handlePointerDown}>
          {ready && doc.pieces.length > 0 ? (
            <>
              <AssemblyViewport
                doc={doc}
                entries={entries}
                bounds={bounds}
                frameKey={loadedKey}
                contextRevision={contextRevision}
                onContextLost={() => setContextRevision(revision => revision + 1)}
                onCameraReady={camera => { cameraRef.current = camera }}
                onControlsReady={controls => { controlsRef.current = controls }}
              />
              <AssemblyViewportToolbar
                settings={doc.settings}
                onPatchSettings={patchSettings}
                onFrameAll={handleFrameAll}
                pieceCount={visiblePieces.length}
                vertexCount={visibleVertexCount}
                scaleRatio={scaleRatio}
              />
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
      </div>

      <Footer variant="kanban" />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

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
