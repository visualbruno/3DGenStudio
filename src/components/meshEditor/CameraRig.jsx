import { useCallback, useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

// Blender-style viewport shortcuts:
//   Numpad 1        Front / Back view (toggle)
//   Numpad 3        Right / Left view (toggle)
//   Numpad 7        Top / Bottom view (toggle)
//   Numpad 0        Perspective / orthographic toggle
//   Numpad .        Re-frame the mesh to fit the viewport
const AXIS_VIEWS = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0),
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0)
}

const RESET_FOV = 50

// Small breathing room so the fitted mesh never clips right at the viewport
// edge while still filling nearly all of it.
const FRAME_FIT_MARGIN = 1.02

function isTypingTarget(target) {
  return target && (
    target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.isContentEditable
  )
}

// Switch an in-place camera between the perspective and orthographic camera
// prototypes so updateProjectionMatrix() uses the right math. The instance
// carries both property sets (position/quaternion on Camera, fov/aspect and
// left/right/top/bottom as own props), so only the prototype swap is needed.
function setProjectionType(camera, isOrthographic) {
  const prototype = isOrthographic
    ? THREE.OrthographicCamera.prototype
    : THREE.PerspectiveCamera.prototype
  if (Object.getPrototypeOf(camera) !== prototype) {
    Object.setPrototypeOf(camera, prototype)
  }
  camera.isOrthographicCamera = isOrthographic
  camera.isPerspectiveCamera = !isOrthographic
}

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function CameraRig({ geometry, frameKey, onCameraReady, controlsEnabled = true, allowPan = true, lockToCenter = false, onViewportReady = null }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const lastFramedKeyRef = useRef(null)
  const geometryRef = useRef(geometry)
  const frameRetryTimerRef = useRef(null)
  const frameRetryCountRef = useRef(0)
  const frameCameraRef = useRef(null)

  useEffect(() => {
    geometryRef.current = geometry
  }, [geometry])

  // Frame the whole mesh to fill the viewport. Works for both projections:
  // perspective moves the camera so the bounding sphere's silhouette fits the
  // tighter of the vertical/horizontal half-FOV, orthographic sizes the
  // frustum to the sphere. The current viewing direction is preserved so the
  // camera only dollies in/out (and re-centers) to fit.
  const frameCamera = useCallback(() => {
    const currentGeometry = geometryRef.current
    const controls = controlsRef.current
    if (!currentGeometry || !controls) {
      return
    }

    currentGeometry.computeBoundingSphere()
    const sphere = currentGeometry.boundingSphere
    // On the initial frame the geometry's positions may not be populated yet
    // (radius 0), so retry briefly instead of framing a degenerate mesh.
    if (!sphere || sphere.radius <= 0) {
      if (frameRetryCountRef.current < 30) {
        frameRetryCountRef.current += 1
        window.clearTimeout(frameRetryTimerRef.current)
        frameRetryTimerRef.current = window.setTimeout(() => {
          frameCameraRef.current?.()
        }, 100)
      }
      return
    }
    frameRetryCountRef.current = 0

    // Tiny floor only (keeps sub-millimetre meshes visible); a full 1.0-unit
    // clamp made small meshes frame as if they were radius 1.0 — the camera
    // sat ~2.99 away and the model looked tiny. The retry above already
    // covers the truly degenerate (radius 0) case.
    const radius = Math.max(sphere.radius, 1e-4)
    const center = sphere.center || new THREE.Vector3()
    const aspect = camera.aspect || 1

    if (camera.isOrthographicCamera) {
      const halfHeight = radius * FRAME_FIT_MARGIN
      const halfWidth = halfHeight * aspect
      Object.assign(camera, {
        left: -halfWidth,
        right: halfWidth,
        top: halfHeight,
        bottom: -halfHeight,
        zoom: 1
      })
    } else {
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov) / 2
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect)
      const tightestHalfFov = Math.min(verticalHalfFov, horizontalHalfFov)
      const distance = (radius * FRAME_FIT_MARGIN) / Math.sin(tightestHalfFov)

      const direction = new THREE.Vector3().subVectors(camera.position, controls.target)
      if (direction.lengthSq() < 1e-12) {
        direction.set(0, 0, 1)
      } else {
        direction.normalize()
      }
      camera.position.copy(center).addScaledVector(direction, distance)
      camera.lookAt(center)
    }

    Object.assign(camera, {
      near: Math.max(radius * 0.00005, 0.0001),
      far: Math.max(radius * 80, 4000)
    })
    camera.updateProjectionMatrix()

    controls.minDistance = Math.max(radius * 0.0025, 0.0005)
    controls.maxDistance = Math.max(radius * 24, 24)
    controls.target.copy(center)
    controls.update()
  }, [camera])

  // Keep a ref in sync so the retry timer inside frameCamera can re-invoke it
  // without a self-reference (TDZ) in the callback's own initializer.
  useEffect(() => {
    frameCameraRef.current = frameCamera
  }, [frameCamera])

  useEffect(() => () => {
    window.clearTimeout(frameRetryTimerRef.current)
  }, [])

  // Snap to an axis-aligned view, keeping the current distance from the orbit
  // target so the zoom level is preserved.
  const setAxisView = useCallback((axis) => {
    const controls = controlsRef.current
    if (!controls) {
      return
    }
    const target = controls.target
    const currentDistance = Math.max(camera.position.distanceTo(target), 0.0001)
    camera.position.copy(target).addScaledVector(AXIS_VIEWS[axis], currentDistance)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    controls.update()
  }, [camera])

  // Which axis-aligned view the camera is currently looking along (front/back
  // for ±Z, right/left for ±X, top/bottom for ±Y), using the dominant axis of
  // the view direction.
  const dominantAxisOf = useCallback((direction) => {
    const absX = Math.abs(direction.x)
    const absY = Math.abs(direction.y)
    const absZ = Math.abs(direction.z)
    if (absZ >= absX && absZ >= absY) {
      return direction.z > 0 ? 'front' : 'back'
    }
    if (absX >= absY) {
      return direction.x > 0 ? 'right' : 'left'
    }
    return direction.y > 0 ? 'top' : 'bottom'
  }, [])

  // Pressing the numpad view key again flips to the opposite axis view: if the
  // camera is already looking along the primary axis it goes to the opposite,
  // otherwise it snaps to the primary axis.
  const toggleAxisView = useCallback((primary, opposite) => {
    const controls = controlsRef.current
    if (!controls) {
      return
    }
    const direction = new THREE.Vector3().subVectors(camera.position, controls.target)
    const current = direction.lengthSq() < 1e-12 ? primary : dominantAxisOf(direction)
    setAxisView(current === primary ? opposite : primary)
  }, [camera, dominantAxisOf, setAxisView])

  // Toggle between perspective and orthographic projection, preserving the
  // visible framing as closely as possible.
  const toggleProjection = useCallback(() => {
    const controls = controlsRef.current
    if (!controls) {
      return
    }
    const target = controls.target
    const viewDirection = new THREE.Vector3().subVectors(camera.position, target)
    const aspect = camera.aspect || 1

    if (camera.isPerspectiveCamera) {
      const distance = Math.max(viewDirection.length(), 0.0001)
      const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360)
      Object.assign(camera, {
        left: (-height * aspect) / 2,
        right: (height * aspect) / 2,
        top: height / 2,
        bottom: -height / 2,
        zoom: 1
      })
      setProjectionType(camera, true)
    } else {
      // OrbitControls dollies an orthographic camera via zoom, so divide it
      // back out to recover the effective on-screen height.
      const effectiveHeight = (camera.top - camera.bottom) / (camera.zoom || 1)
      const distance = effectiveHeight / (2 * Math.tan((RESET_FOV * Math.PI) / 360))
      camera.position.copy(target).addScaledVector(viewDirection.normalize(), distance)
      Object.assign(camera, {
        fov: RESET_FOV,
        zoom: 1
      })
      setProjectionType(camera, false)
    }
    camera.updateProjectionMatrix()
    controls.update()
  }, [camera])

  useEffect(() => {
    const onKey = (event) => {
      if (isTypingTarget(event.target)) {
        return
      }
      const { code } = event
      const ctrl = event.ctrlKey || event.metaKey
      const alt = event.altKey

      if (code === 'NumpadDecimal' && !ctrl && !alt) {
        event.preventDefault()
        frameCamera()
        return
      }

      if (!/^Numpad\d$/.test(code) || ctrl || alt) {
        return
      }
      event.preventDefault()

      if (code === 'Numpad0') {
        toggleProjection()
        return
      }

      const axisPair = {
        Numpad1: ['front', 'back'],
        Numpad3: ['right', 'left'],
        Numpad7: ['top', 'bottom']
      }[code]
      if (axisPair) {
        toggleAxisView(axisPair[0], axisPair[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [frameCamera, toggleAxisView, toggleProjection])

  // Orbit the camera around the current target from a pointer drag on the
  // navigation gizmo, matching OrbitControls' rotate feel and sensitivity
  // (a full viewport-width drag ≈ one full revolution).
  const rotateByDrag = useCallback((deltaX, deltaY, viewportHeight) => {
    const controls = controlsRef.current
    if (!controls) {
      return
    }
    const target = controls.target
    const offset = new THREE.Vector3().subVectors(camera.position, target)
    const spherical = new THREE.Spherical().setFromVector3(offset)
    const angle = (2 * Math.PI) / Math.max(viewportHeight || 1, 1)
    spherical.theta -= deltaX * angle
    spherical.phi -= deltaY * angle
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.0001, Math.PI - 0.0001)
    offset.setFromSpherical(spherical)
    camera.position.copy(target).add(offset)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    controls.update()
  }, [camera])

  useEffect(() => {
    onViewportReady?.({ camera, setAxisView, frameCamera, toggleProjection, rotateByDrag })
    return () => onViewportReady?.(null)
  }, [onViewportReady, camera, setAxisView, frameCamera, toggleProjection, rotateByDrag])

  useEffect(() => {
    onCameraReady?.(camera)
  }, [camera, onCameraReady])

  useEffect(() => {
    if (!geometry) {
      return
    }
    // Re-frame only when the frameKey changes (i.e. a new mesh was loaded).
    // Topology edits (delete / merge / subdivide / fill / undo) keep the same
    // frameKey so the camera doesn't snap back to its initial framing.
    if (lastFramedKeyRef.current === frameKey) {
      return
    }
    lastFramedKeyRef.current = frameKey
    frameCamera()
  }, [camera, frameKey, frameCamera, geometry])

  useEffect(() => {
    if (!lockToCenter || !geometry || !controlsRef.current) {
      return
    }

    geometry.computeBoundingSphere()
    const center = geometry.boundingSphere?.center || new THREE.Vector3()
    controlsRef.current.target.copy(center)
    camera.lookAt(center)
    controlsRef.current.update()
  }, [camera, geometry, lockToCenter])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={controlsEnabled}
      enableDamping
      enablePan={allowPan}
      minDistance={0.001}
      maxDistance={100}
      mouseButtons={{
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: allowPan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
      }}
    />
  )
}