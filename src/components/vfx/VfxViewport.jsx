// The VFX preview canvas.
//
// Camera behaviour is reused unchanged from the mesh editor - CameraRig,
// ViewportCameras, ViewGizmo - by handing them a throwaway bounds-proxy
// geometry, exactly as TreeViewport does. An effect has no mesh to frame, so
// the proxy is what gives the framing code something with a bounding sphere.
//
// TONE MAPPING IS LEFT ALONE, and that is the deliberate decision the plan
// flagged for verification here. R3F 9 defaults to ACES Filmic plus an sRGB
// output encode, and nothing in src/ overrides either on a visible canvas -
// the mesh editor, the assembly workspace and the trees page all render through
// them. Setting `flat` on this canvas would make particles bypass both, so an
// author would tune an effect that looks different the moment it is used
// anywhere else in the app; and since Unity HDRP/URP and Unreal both tonemap
// too, it would also be wrong in the engines. The desaturation that ACES causes
// on a bright additive core is real, and the answer to it is HDR colour - the
// gradient editor accepts values above 1 - not removing the tonemapper.
//
// frameloop is left at the default "always". It is load-bearing on the other
// viewports in this app, and a particle preview needs a continuous clock
// anyway; when paused, VfxSystemView's useFrame does almost nothing.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import * as THREE from 'three'
import CameraRig from '../meshEditor/CameraRig'
import ViewportCameras from '../meshEditor/ViewportCameras'
import ViewGizmo from '../meshEditor/ViewGizmo'
import VfxSystemView from './VfxSystemView'

// Eight corners spanning the effect's bounds, purely so CameraRig has something
// to frame. Never rendered.
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

// A 1.8m capsule and a 1m cube, for scale. Authoring at the wrong scale is the
// single most common thing to discover only after importing into an engine, and
// a human-sized silhouette next to the effect prevents it for free.
function ScaleReference({ show }) {
  const geometry = useMemo(() => new THREE.CapsuleGeometry(0.25, 1.3, 6, 12), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  if (!show) return null
  return (
    <group>
      <mesh geometry={geometry} position={[1.4, 0.9, 0]}>
        <meshBasicMaterial color="#2f333a" wireframe />
      </mesh>
      <mesh position={[-1.4, 0.5, 0]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#2f333a" wireframe />
      </mesh>
    </group>
  )
}

export default function VfxViewport({
  runtime,
  batches,
  playing = true,
  statsRef = null,
  orthographic = false,
  showGrid = true,
  showScale = false,
  bounds = null,
  frameKey = 0,
}) {
  // A context loss has to be survivable rather than fatal: preventDefault on
  // the lost event is what makes the browser restore it, and bumping this key
  // remounts the Canvas under the new renderer. The particle meshes live above
  // this component so they survive the remount - see useVfxRuntime.
  const [contextRevision, setContextRevision] = useState(0)

  const proxy = useMemo(
    () => boundsProxy(bounds?.min || [-2, 0, -2], bounds?.max || [2, 3, 2]),
    [bounds],
  )
  const proxyRef = useRef(proxy)
  useEffect(() => {
    const previous = proxyRef.current
    proxyRef.current = proxy
    if (previous && previous !== proxy) previous.dispose()
  }, [proxy])
  useEffect(() => () => proxyRef.current?.dispose?.(), [])

  return (
    <Canvas
      key={contextRevision}
      className="vfx-viewport__canvas"
      dpr={[1, 2]}
      shadows={false}
      // Debounced so dragging a splitter does not call setSize every frame.
      resize={{ offsetSize: true, debounce: { scroll: 50, resize: 80 } }}
      gl={{ powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        const canvas = gl.domElement
        canvas.addEventListener('webglcontextlost', event => {
          event.preventDefault()
          console.warn('VFX preview: WebGL context lost - awaiting restore.')
        }, false)
        canvas.addEventListener('webglcontextrestored', () => {
          console.warn('VFX preview: WebGL context restored.')
          setContextRevision(revision => revision + 1)
        }, false)
      }}
    >
      <ViewportCameras orthographic={orthographic} />
      <CameraRig geometry={proxy} frameKey={frameKey} />

      {/* Particles are unlit - their colour comes from the gradient, not from
          the scene - so these lights exist only for the scale reference. */}
      <ambientLight intensity={0.9} />
      <directionalLight position={[4, 8, 6]} intensity={0.6} />

      {showGrid && (
        <Grid
          infiniteGrid
          fadeDistance={60}
          cellColor="#47484A"
          sectionColor="#AC89FF"
          sectionThickness={1.5}
          sectionSize={10}
        />
      )}

      <ScaleReference show={showScale} />

      <VfxSystemView
        runtime={runtime}
        batches={batches}
        playing={playing}
        statsRef={statsRef}
      />

      {/* Rendered last: GizmoHelper takes the render loop at priority 1, so
          everything at the default priority - including the buffer writes - has
          already run by the time it draws. */}
      <ViewGizmo />
    </Canvas>
  )
}
