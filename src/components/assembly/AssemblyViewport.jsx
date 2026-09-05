// The assembly viewport: N independently-placed meshes in one scene.
//
// Everything camera-related is reused unchanged from the mesh editor —
// ViewportCameras, CameraRig and ViewGizmo — by feeding them a throwaway
// 8-corner geometry spanning the whole assembly's bounds (boundsProxyGeometry).
// Each of those three takes a single `geometry` and calls
// computeBoundingSphere() on it, so a proxy over the union box gives correct
// load framing, orbit clamps, ortho zoom clamps and view-cube double-click fit
// across many meshes without touching any of their code.
import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import * as THREE from 'three'
import CameraRig from '../meshEditor/CameraRig'
import ViewportCameras from '../meshEditor/ViewportCameras'
import ViewGizmo from '../meshEditor/ViewGizmo'
import AssemblyPieceMesh from './AssemblyPieceMesh'
import AssemblyGizmo from './AssemblyGizmo'
import LandmarkMarkers from './LandmarkMarkers'
import { boundsProxyGeometry, composePieceMatrix } from '../../utils/assemblyGeometry'
import { getVisiblePieces } from '../../utils/assemblyHelpers'

const IDENTITY = new THREE.Matrix4()

/**
 * Where to draw a fitted preview: how far its piece has moved SINCE the fit.
 *
 * The preview's vertices are world positions from the moment it was produced,
 * so the placement is already inside them — drawing it under the placement
 * again would apply it twice. Identity is right only while the piece has not
 * moved, which is exactly the assumption that used to strand a fitted piece
 * behind its own gizmo.
 */
function previewMatrix(piece, preview) {
  if (!preview.placementAtFit) return IDENTITY   // pre-existing preview: as before
  return composePieceMatrix(piece, new THREE.Matrix4())
    .multiply(preview.placementAtFit.clone().invert())
}

// Publishes the viewport's OrbitControls to the page.
//
// CameraRig's OrbitControls is `makeDefault`, so R3F puts it on `state.controls`
// — this just forwards it out. The page needs it for a true fit: moving the
// camera without also moving the orbit TARGET leaves the view snapping back on
// the next drag.
function ControlsBridge({ onReady }) {
  const controls = useThree(state => state.controls)
  useEffect(() => { onReady?.(controls || null) }, [controls, onReady])
  return null
}

export default function AssemblyViewport({
  doc,
  entries,
  previews,
  showFitted,
  bounds,            // THREE.Box3 over the visible, loaded pieces
  landmarkBase,      // the base piece, for drawing the body-side markers
  landmarkPiece,     // the piece whose pairs are being placed, or null
  landmarkPending,   // a body point waiting for its partner
  hoveredPairId,
  frameKey,          // bumped when the piece SET changes, so the camera re-frames
  contextRevision,
  onContextLost,
  onCameraReady,
  onControlsReady,
  selectedPiece,
  onGizmoDragStart,
  onGizmoDrag,
  onGizmoDragEnd,
  showShadows = false,
}) {
  const visiblePieces = getVisiblePieces(doc)
  const boundsKey = bounds && !bounds.isEmpty()
    ? `${bounds.min.toArray()}|${bounds.max.toArray()}`
    : 'empty'

  // Rebuilt only when the bounds actually change, and disposed when replaced —
  // it is a real GPU buffer, small but not free, and this can churn.
  const proxyGeometry = useMemo(() => boundsProxyGeometry(bounds), [boundsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Marker size is derived from the scene, so a 0.02-unit gauntlet and a
  // 200-unit body both get dots you can actually see and click near.
  const boundsDiagonal = bounds && !bounds.isEmpty()
    ? bounds.getSize(new THREE.Vector3()).length()
    : 1
  const proxyRef = useRef(proxyGeometry)
  useEffect(() => {
    const previous = proxyRef.current
    proxyRef.current = proxyGeometry
    if (previous && previous !== proxyGeometry) previous.dispose()
  }, [proxyGeometry])
  useEffect(() => () => proxyRef.current?.dispose(), [])

  const orthographic = !!doc?.settings?.orthographic

  return (
    <Canvas
      key={contextRevision}
      shadows={showShadows ? { type: THREE.PCFSoftShadowMap } : false}
      resize={{ offsetSize: true }}
      style={{ width: '100%', height: '100%' }}
      gl={{ powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        const canvas = gl.domElement
        const handleLost = event => {
          // Preventing the default is what makes the context RECOVERABLE; without
          // it the browser never fires webglcontextrestored.
          event.preventDefault()
          console.warn('WebGL context lost — awaiting restore.')
        }
        const handleRestored = () => {
          console.warn('WebGL context restored — rebuilding assembly scene.')
          onContextLost?.()
        }
        canvas.addEventListener('webglcontextlost', handleLost, false)
        canvas.addEventListener('webglcontextrestored', handleRestored, false)
      }}
    >
      <ViewportCameras orthographic={orthographic} />

      <ambientLight intensity={1.25} />
      <directionalLight
        position={[5, 7, 9]}
        intensity={2}
        castShadow={showShadows}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.00015}
        shadow-normalBias={0.04}
      />
      <directionalLight position={[-5, 3, -4]} intensity={0.6} />

      <group>
        {visiblePieces.map(piece => {
          const preview = showFitted?.has(piece.id) ? previews?.get(piece.id) : null
          const entry = preview || entries.get(piece.id)
          if (!entry) return null
          return (
            <AssemblyPieceMesh
              key={piece.id}
              piece={piece}
              entry={entry}
              // A fitted result comes back ALREADY in world space (the piece's
              // placement was baked into the payload sent up), so the preview
              // draws through the CHANGE in placement since it was fitted,
              // while the original draws with the placement itself. The easiest
              // thing in the feature to get backwards.
              //
              // Usually that delta is identity. It is not while the piece is
              // being dragged — the drag patches the document every frame, and
              // without this the visible fitted mesh would sit still while the
              // hidden original moved out from under the gizmo. The delta is
              // baked into the vertices once the move is committed.
              matrix={preview ? previewMatrix(piece, preview) : undefined}
              isSelected={piece.id === doc.settings.selectedPieceId}
              showShadows={showShadows}
            />
          )
        })}
      </group>

      {doc?.settings?.showGrid && (
        <Grid
          infiniteGrid
          cellSize={1}
          cellThickness={0.6}
          fadeDistance={60}
          cellColor="#47484A"
          sectionColor="#AC89FF"
          sectionThickness={1.5}
          sectionSize={10}
        />
      )}

      {/* Independent of the gizmo: the pairs stay visible while the piece is
          selected, whether or not placing is armed. Drawn with depthTest off so
          a pair on the far side of the body still reads. */}
      <LandmarkMarkers
        base={landmarkBase}
        piece={landmarkPiece}
        pendingBase={landmarkPending}
        hoveredPairId={hoveredPairId}
        diagonal={boundsDiagonal}
      />

      {/* Unmounted while the brush is active. The gizmo's handles sit in front
          of the mesh and swallow the pointer before the brush ever sees it, so
          a stroke that begins on one silently becomes a move, rotate or scale —
          and the piece is deformed relative to a placement that just changed
          under it. Hidden rather than merely ignored: a visible control that
          does nothing is worse than no control. */}
      {selectedPiece && !doc.settings.sculptMode && (
        <AssemblyGizmo
          piece={selectedPiece}
          mode={doc.settings.gizmoMode}
          space={doc.settings.gizmoSpace}
          snapTranslate={doc.settings.snapEnabled ? doc.settings.snapTranslate : 0}
          snapRotateDeg={doc.settings.snapEnabled ? doc.settings.snapRotateDeg : 0}
          snapScale={doc.settings.snapEnabled ? doc.settings.snapScale : 0}
          onDragStart={onGizmoDragStart}
          onDrag={onGizmoDrag}
          onDragEnd={onGizmoDragEnd}
        />
      )}

      <CameraRig
        geometry={proxyGeometry}
        frameKey={frameKey}
        onCameraReady={onCameraReady}
      />
      <ViewGizmo geometry={proxyGeometry} />
      <ControlsBridge onReady={onControlsReady} />
    </Canvas>
  )
}
