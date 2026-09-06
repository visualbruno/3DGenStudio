// The tree generator viewport.
//
// Two things are drawn here and only ever one at a time: the skeleton preview
// (branch polylines, refreshed while a slider moves) and the committed mesh.
// That split is the whole interaction model — scrubbing a slider must never
// wait on a 1-second mesh build, so the cheap thing is live and the expensive
// thing is explicit.
//
// Camera behaviour is reused unchanged from the mesh editor (CameraRig,
// ViewportCameras, ViewGizmo) by handing them a throwaway proxy geometry that
// spans the tree's bounds — the same trick the assembly viewport uses.
import { useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import * as THREE from 'three'
import CameraRig from '../meshEditor/CameraRig'
import ViewportCameras from '../meshEditor/ViewportCameras'
import ViewGizmo from '../meshEditor/ViewGizmo'

// An 8-corner box spanning the tree, purely so CameraRig has something with a
// bounding sphere to frame. Never rendered.
function boundsProxy(min, max) {
  const geometry = new THREE.BufferGeometry()
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0,
    x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1,
  ], 3))
  return geometry
}

// The skeleton as one LineSegments: a few thousand branch polylines are far too
// many to be separate objects, and one merged buffer draws in a single call.
function SkeletonLines({ polylines }) {
  const geometry = useMemo(() => {
    const points = []
    for (const line of polylines) {
      for (let i = 0; i < line.length - 1; i += 1) {
        points.push(line[i][0], line[i][1], line[i][2])
        points.push(line[i + 1][0], line[i + 1][1], line[i + 1][2])
      }
    }
    const buffer = new THREE.BufferGeometry()
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    return buffer
  }, [polylines])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#6b503a" />
    </lineSegments>
  )
}

export default function TreeViewport({
  polylines = null,
  meshObject = null,
  bounds = null,
  frameKey = 0,
  orthographic = false,
  showGrid = true,
  onCameraReady,
}) {
  // Rebuilt only when the bounds actually change, and disposed when replaced —
  // it is a real GPU buffer, small but not free, and a live preview churns it.
  const boundsKey = bounds ? `${bounds.min}|${bounds.max}` : 'empty'
  const proxy = useMemo(
    () => boundsProxy(bounds?.min || [-1, 0, -1], bounds?.max || [1, 2, 1]),
    [boundsKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const proxyRef = useRef(proxy)
  useEffect(() => {
    const previous = proxyRef.current
    proxyRef.current = proxy
    if (previous && previous !== proxy) previous.dispose()
  }, [proxy])
  useEffect(() => () => proxyRef.current?.dispose?.(), [])

  const gridSize = Math.max(
    (bounds?.max?.[1] || 8) * 1.5,
    2,
  )

  return (
    <Canvas className="treegen__canvas" dpr={[1, 2]} shadows={false}>
      <ViewportCameras orthographic={orthographic} />
      <CameraRig geometry={proxy} frameKey={frameKey} onCameraReady={onCameraReady} />

      <ambientLight intensity={0.75} />
      <directionalLight position={[4, 9, 6]} intensity={1.5} />
      <directionalLight position={[-5, 3, -4]} intensity={0.4} />

      {showGrid && (
        <Grid
          args={[gridSize, gridSize]}
          cellSize={gridSize / 20}
          sectionSize={gridSize / 4}
          cellColor="#3b3f45"
          sectionColor="#565c66"
          fadeDistance={gridSize * 3}
          infiniteGrid
          followCamera={false}
        />
      )}

      {meshObject
        ? <primitive object={meshObject} />
        : polylines && <SkeletonLines polylines={polylines} />}

      <ViewGizmo />
    </Canvas>
  )
}
