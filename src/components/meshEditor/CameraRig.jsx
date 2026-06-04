import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function CameraRig({ geometry, frameKey, onCameraReady, controlsEnabled = true, allowPan = true, lockToCenter = false }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const lastFramedKeyRef = useRef(null)

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

    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    const radius = Math.max(sphere?.radius || 1, 1)
    const center = sphere?.center || new THREE.Vector3()
    const distance = radius * 2.6
    const minDistance = Math.max(radius * 0.0025, 0.0005)
    const maxDistance = Math.max(radius * 24, 24)

    camera.position.set(center.x + distance, center.y + distance * 0.65, center.z + distance)

    Object.assign(camera, {
      near: Math.max(radius * 0.00005, 0.0001),
      far: Math.max(radius * 80, 4000)
    })
    camera.lookAt(center)
    camera.updateProjectionMatrix()

    if (controlsRef.current) {
      controlsRef.current.minDistance = minDistance
      controlsRef.current.maxDistance = maxDistance
      controlsRef.current.target.copy(center)
      controlsRef.current.update()
    }
  }, [camera, geometry, frameKey])

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
