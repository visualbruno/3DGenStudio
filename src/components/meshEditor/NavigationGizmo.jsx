import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import './NavigationGizmo.css'

// Face labels map to world axes (matching the camera views in CameraRig):
// front = +Z, back = -Z, right = +X, left = -X, top = +Y, bottom = -Y.
const CUBE_FACES = [
  { view: 'front', axis: 'z', label: 'Front', transform: 'translateZ(39px)' },
  { view: 'back', axis: 'z', label: 'Back', transform: 'rotateY(180deg) translateZ(39px)' },
  { view: 'right', axis: 'x', label: 'Right', transform: 'rotateY(90deg) translateZ(39px)' },
  { view: 'left', axis: 'x', label: 'Left', transform: 'rotateY(-90deg) translateZ(39px)' },
  { view: 'top', axis: 'y', label: 'Top', transform: 'rotateX(90deg) translateZ(39px)' },
  { view: 'bottom', axis: 'y', label: 'Bottom', transform: 'rotateX(-90deg) translateZ(39px)' }
]

const DRAG_CLICK_THRESHOLD_PX = 4

// HTML overlay gizmo in the top-right of the mesh-editor viewport. The cube
// rotates to mirror the camera's orientation (inverse world rotation), so the
// face matching the current view always points toward the viewer. Dragging
// the cube orbits the camera; a click (no movement) snaps to the pressed face.
export default function NavigationGizmo({ apiRef }) {
  const cubeRef = useRef(null)
  const sceneRef = useRef(null)
  const containerRef = useRef(null)
  const dragRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let raf = 0
    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()

    const loop = () => {
      const camera = apiRef?.current?.camera
      if (camera && cubeRef.current) {
        quaternion.copy(camera.quaternion).invert()
        matrix.makeRotationFromQuaternion(quaternion)
        const e = matrix.elements
        // CSS 3D uses a Y-down coordinate system while three.js is Y-up, so the
        // Y row/column of the rotation matrix must be mirrored when written to
        // matrix3d — otherwise the cube's pitch inverts while yaw stays correct.
        const values = [
          e[0], -e[1], e[2], e[3],
          -e[4], e[5], -e[6], e[7],
          e[8], -e[9], e[10], e[11],
          e[12], -e[13], e[14], e[15]
        ]
        cubeRef.current.style.transform = `matrix3d(${values.join(',')})`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [apiRef])

  // Match OrbitControls' sensitivity: a drag across the full viewport height
  // spans a full revolution.
  const getViewportHeight = () =>
    containerRef.current?.parentElement?.clientHeight || window.innerHeight || 1

  const handlePointerDown = event => {
    event.stopPropagation()
    const faceButton = event.target.closest('.navigation-gizmo__face')
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      view: faceButton?.dataset.view || null
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
  }

  const handlePointerMove = event => {
    event.stopPropagation()
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - drag.lastX
    const deltaY = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY

    if (!drag.moved && (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)) > DRAG_CLICK_THRESHOLD_PX) {
      drag.moved = true
    }

    if (drag.moved) {
      apiRef?.current?.rotateByDrag?.(deltaX, deltaY, getViewportHeight())
    }
  }

  const handlePointerEnd = event => {
    event.stopPropagation()
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    setDragging(false)
    // A press without significant movement is a click → snap to that face.
    if (!drag.moved && drag.view) {
      apiRef?.current?.setAxisView?.(drag.view)
    }
  }

  return (
    <div
      ref={containerRef}
      className="navigation-gizmo"
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      <div
        ref={sceneRef}
        className="navigation-gizmo__scene"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
      >
        <div
          ref={cubeRef}
          className={`navigation-gizmo__cube${dragging ? ' navigation-gizmo__cube--dragging' : ''}`}
        >
          {CUBE_FACES.map(face => (
            <button
              key={face.view}
              type="button"
              className={`navigation-gizmo__face navigation-gizmo__face--${face.axis}`}
              data-view={face.view}
              style={{ transform: face.transform }}
              title={`Snap view: ${face.label}`}
            >
              <span className="navigation-gizmo__face-label">{face.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}