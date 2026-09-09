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

// The emitter shapes, in wireframe.
//
// "Where do these come from?" is the first question a shape emitter raises and
// the hardest to answer from the result: a sphere and a box of the same size
// look identical once the particles have moved a metre, an offset emitter looks
// like an effect placed wrong, and a rotated one looks like a bug.
//
// THE ROTATION IS HANDED STRAIGHT TO THE GROUP, and that is only safe because
// the kernel's own matrix is three.js Euler XYZ - it was Rz*Ry*Rx until the day
// this was written, which would have put every multi-axis gizmo somewhere the
// particles are not. Pinned against three itself in render.test.mjs.
//
// GEOMETRY IS BUILT PER DESCRIPTOR AND DISPOSED, rather than shared: the shapes
// change as the author types, and nothing in this repo leaves GPU buffers to
// R3F's auto-dispose.
// A stable empty, so a viewport with no gizmos does not re-render on identity.
const EMPTY_GIZMOS = Object.freeze([])
const GIZMO_COLOR = '#4f8cf5'

function EmitterGizmo({ gizmo, meshes }) {
  const geometry = useMemo(() => {
    switch (gizmo.kind) {
      case 'sphere':
        return new THREE.SphereGeometry(Math.max(0.001, gizmo.radius), 16, 12)
      case 'box':
        return new THREE.BoxGeometry(
          Math.max(0.001, gizmo.size[0]),
          Math.max(0.001, gizmo.size[1]),
          Math.max(0.001, gizmo.size[2]),
        )
      case 'circle':
        // A flat RING in XZ, matching the kernel: a torus would imply a volume
        // the emitter does not fill, and a disc would hide the inner radius.
        // Rotated -90 about X because RingGeometry is built in XY.
        return new THREE.RingGeometry(
          Math.max(0, gizmo.inner), Math.max(0.001, gizmo.radius), 32, 1,
        ).rotateX(-Math.PI / 2)
      case 'cone': {
        // The kernel emits from a disc of `radius` at y=0 and fires into a cone
        // of half-angle `angle`. The HEIGHT is this drawing's own invention -
        // there is no height in the document - so it is derived from the angle
        // at a fixed reach, which keeps a wide cone from looking like a narrow
        // one that happens to be short.
        const reach = 1
        const half = Math.max(0.001, Math.tan(gizmo.angle * Math.PI / 180) * reach)
        return new THREE.ConeGeometry(gizmo.radius + half, reach, 20, 1, true)
          .translate(0, reach / 2, 0)
      }
      case 'line': {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(
          [...gizmo.start, ...gizmo.end], 3,
        ))
        return g
      }
      case 'point':
        // A jitter of zero is a true point, which cannot be drawn - so it gets
        // a small fixed marker rather than nothing at all.
        return new THREE.SphereGeometry(Math.max(0.02, gizmo.radius), 10, 8)
      case 'mesh':
        return null
      default:
        return null
    }
  }, [gizmo])

  useEffect(() => () => geometry?.dispose(), [geometry])

  // A mesh emitter draws the ACTUAL model when it has loaded, which is the only
  // honest gizmo for it - a bounding box would say nothing about where on the
  // surface particles appear. Before it loads there is nothing to draw, which
  // matches what the emitter is doing.
  const meshGeometry = gizmo.kind === 'mesh'
    ? meshes?.get(gizmoAssetIdOf(gizmo)) || null
    : null

  const position = gizmo.kind === 'line' ? [0, 0, 0] : gizmo.offset
  const rotation = useMemo(() => [
    gizmo.rotation[0] * Math.PI / 180,
    gizmo.rotation[1] * Math.PI / 180,
    gizmo.rotation[2] * Math.PI / 180,
  ], [gizmo.rotation])

  if (gizmo.kind === 'line') {
    return (
      <line geometry={geometry}>
        <lineBasicMaterial color={GIZMO_COLOR} transparent opacity={0.7} />
      </line>
    )
  }

  if (meshGeometry) {
    return (
      <mesh
        geometry={meshGeometry}
        position={position}
        rotation={rotation}
        scale={gizmo.scale}
      >
        <meshBasicMaterial color={GIZMO_COLOR} wireframe transparent opacity={0.35} />
      </mesh>
    )
  }

  if (!geometry) return null
  return (
    <mesh geometry={geometry} position={position} rotation={rotation}>
      <meshBasicMaterial color={GIZMO_COLOR} wireframe transparent opacity={0.5} />
    </mesh>
  )
}

// Stashed on the descriptor by the page, which is the only place that can
// resolve a slot key through doc.references.
function gizmoAssetIdOf(gizmo) {
  return gizmo.assetId ?? -1
}

function EmitterGizmos({ show, gizmos, meshes }) {
  if (!show) return null
  return (
    <group>
      {gizmos.map(gizmo => (
        <EmitterGizmo key={gizmo.blockId} gizmo={gizmo} meshes={meshes} />
      ))}
    </group>
  )
}

export default function VfxViewport({
  runtime,
  batches,
  playing = true,
  timescale = 1,
  statsRef = null,
  onCamera = null,
  orthographic = false,
  showGrid = true,
  showScale = false,
  showEmitters = false,
  gizmos = EMPTY_GIZMOS,
  meshes = null,
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
      <EmitterGizmos show={showEmitters} gizmos={gizmos} meshes={meshes} />

      <VfxSystemView
        runtime={runtime}
        batches={batches}
        playing={playing}
        timescale={timescale}
        statsRef={statsRef}
        onCamera={onCamera}
      />

      {/* Rendered last: GizmoHelper takes the render loop at priority 1, so
          everything at the default priority - including the buffer writes - has
          already run by the time it draws. */}
      <ViewGizmo />
    </Canvas>
  )
}
