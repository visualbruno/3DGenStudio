import { Canvas, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import {
  deleteSelectedFaces,
  deleteSelectedVertices,
  exportGeometryToObj,
  fillHoleLoops,
  geometryFaceCount,
  getClosestVertexIndex,
  getFaceSelectionGeometry,
  getSelectedHoleLoops,
  getVertexSelectionPositions,
  loadEditableGeometryFromUrl,
  mergeSelectedVertices,
  smoothSelectedVertices,
  subdivideSelectedFaces
} from '../utils/meshEditor'
import './MeshEditorPage.css'

function getRectangleBounds(startPoint, endPoint) {
  return {
    left: Math.min(startPoint.x, endPoint.x),
    right: Math.max(startPoint.x, endPoint.x),
    top: Math.min(startPoint.y, endPoint.y),
    bottom: Math.max(startPoint.y, endPoint.y)
  }
}

function CameraRig({ geometry, onCameraReady }) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const boundsRef = useRef({ minDistance: 0.001, maxDistance: 100 })

  useEffect(() => {
    onCameraReady?.(camera)
  }, [camera, onCameraReady])

  useEffect(() => {
    if (!geometry) {
      return
    }

    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    const radius = Math.max(sphere?.radius || 1, 1)
    const center = sphere?.center || new THREE.Vector3()
    const distance = radius * 2.6
    const minDistance = Math.max(radius * 0.0025, 0.0005)
    const maxDistance = Math.max(radius * 24, 24)

    boundsRef.current = { minDistance, maxDistance }

    camera.position.set(center.x + distance, center.y + distance * 0.65, center.z + distance)
    camera.near = Math.max(radius * 0.00005, 0.0001)
    camera.far = Math.max(radius * 80, 4000)
    camera.lookAt(center)
    camera.updateProjectionMatrix()

    if (controlsRef.current) {
      controlsRef.current.minDistance = minDistance
      controlsRef.current.maxDistance = maxDistance
      controlsRef.current.target.copy(center)
      controlsRef.current.update()
    }
  }, [camera, geometry])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      minDistance={boundsRef.current.minDistance}
      maxDistance={boundsRef.current.maxDistance}
      mouseButtons={{
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.PAN
      }}
    />
  )
}

function EditorMesh({ geometry, selectedFaceIndices, selectedVertexIndices }) {
  const faceSelectionGeometry = useMemo(() => getFaceSelectionGeometry(geometry, selectedFaceIndices), [geometry, selectedFaceIndices])
  const selectedVertexPositions = useMemo(() => getVertexSelectionPositions(geometry, selectedVertexIndices), [geometry, selectedVertexIndices])
  const selectedVertexVectors = useMemo(() => {
    const vectors = []

    for (let index = 0; index < selectedVertexPositions.length; index += 3) {
      vectors.push([
        selectedVertexPositions[index],
        selectedVertexPositions[index + 1],
        selectedVertexPositions[index + 2]
      ])
    }

    return vectors
  }, [selectedVertexPositions])

  useEffect(() => () => faceSelectionGeometry?.dispose?.(), [faceSelectionGeometry])

  return (
    <group>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#a9b6ff" metalness={0.08} roughness={0.62} />
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.36} />
      </mesh>
      {selectedFaceIndices.length > 0 && faceSelectionGeometry?.attributes?.position?.count > 0 && (
        <mesh geometry={faceSelectionGeometry}>
          <meshBasicMaterial color="#ff9a62" transparent opacity={0.68} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {selectedVertexVectors.length > 0 && (
        <group>
          {selectedVertexVectors.map(([x, y, z], index) => (
            <mesh key={`${x}-${y}-${z}-${index}`} position={[x, y, z]}>
              <sphereGeometry args={[0.001, 8, 8]} />
              <meshBasicMaterial color="#8ff5ff" depthTest={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  )
}

export default function MeshEditorPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { saveMeshEdit, uploadAssetThumbnail, updateProjectNode } = useProjects()

  const [showSettings, setShowSettings] = useState(false)
  const [geometry, setGeometry] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [selectionMode, setSelectionMode] = useState('face')
  const [selectedFaceIndices, setSelectedFaceIndices] = useState([])
  const [selectedVertexIndices, setSelectedVertexIndices] = useState([])
  const [holeLoops, setHoleLoops] = useState([])
  const [meshName, setMeshName] = useState(searchParams.get('name') || 'Mesh')
  const [selectionBox, setSelectionBox] = useState(null)

  const assetId = searchParams.get('assetId') || ''
  const numericAssetId = Number(assetId)
  const filePath = searchParams.get('filePath') || ''
  const modelUrl = searchParams.get('url') || ''
  const projectId = searchParams.get('projectId') || ''
  const nodeId = searchParams.get('nodeId') || ''
  const returnTo = searchParams.get('returnTo') || ''
  const canvasShellRef = useRef(null)
  const cameraRef = useRef(null)
  const dragStateRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    async function loadGeometry() {
      if (!modelUrl) {
        setError('Mesh URL is missing.')
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        setError('')
        const loadedGeometry = await loadEditableGeometryFromUrl(modelUrl)

        if (!cancelled) {
          setGeometry(loadedGeometry)
          setSelectedFaceIndices([])
          setSelectedVertexIndices([])
          setHoleLoops([])
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Failed to load mesh editor')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadGeometry()

    return () => {
      cancelled = true
    }
  }, [modelUrl])

  const stats = useMemo(() => ({
    vertices: geometry?.attributes?.position?.count || 0,
    faces: geometryFaceCount(geometry)
  }), [geometry])
  const availableHoleLoops = useMemo(() => {
    if (!geometry) {
      return []
    }

    return getSelectedHoleLoops(geometry, {
      selectionMode,
      selectedFaceIndices,
      selectedVertexIndices
    })
  }, [geometry, selectedFaceIndices, selectedVertexIndices, selectionMode])

  const resetSelection = useCallback(() => {
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
  }, [])

  const applySelection = useCallback((type, nextSelection, isMultiSelect) => {
    setFeedback('')

    if (type === 'face') {
      setSelectedVertexIndices([])
      setSelectedFaceIndices(current => {
        if (!isMultiSelect) {
          return nextSelection
        }

        const currentSet = new Set(current)
        nextSelection.forEach(index => {
          if (currentSet.has(index)) {
            currentSet.delete(index)
          } else {
            currentSet.add(index)
          }
        })

        return [...currentSet].sort((left, right) => left - right)
      })
      return
    }

    setSelectedFaceIndices([])
    setSelectedVertexIndices(current => {
      if (!isMultiSelect) {
        return nextSelection
      }

      const currentSet = new Set(current)
      nextSelection.forEach(index => {
        if (currentSet.has(index)) {
          currentSet.delete(index)
        } else {
          currentSet.add(index)
        }
      })

      return [...currentSet].sort((left, right) => left - right)
    })
  }, [])

  const createSelectionMesh = useCallback(() => {
    const mesh = new THREE.Mesh(geometry)
    mesh.updateMatrixWorld(true)
    return mesh
  }, [geometry])

  const createRectangleSamplePoints = useCallback((bounds) => {
    const width = Math.max(1, bounds.right - bounds.left)
    const height = Math.max(1, bounds.bottom - bounds.top)
    const maxSamples = 1600
    const step = Math.max(6, Math.ceil(Math.sqrt((width * height) / maxSamples)))
    const points = []

    for (let y = bounds.top; y <= bounds.bottom; y += step) {
      for (let x = bounds.left; x <= bounds.right; x += step) {
        points.push({ x, y })
      }
    }

    points.push(
      { x: bounds.left, y: bounds.top },
      { x: bounds.right, y: bounds.top },
      { x: bounds.left, y: bounds.bottom },
      { x: bounds.right, y: bounds.bottom },
      { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }
    )

    return points
  }, [])

  const selectAtPoint = useCallback((point, isMultiSelect) => {
    if (!geometry || !cameraRef.current || !canvasShellRef.current) {
      return
    }

    const rect = canvasShellRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      return
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2(
      (point.x / rect.width) * 2 - 1,
      -((point.y / rect.height) * 2 - 1)
    )

    raycaster.setFromCamera(pointer, cameraRef.current)

    const mesh = createSelectionMesh()
    const [intersection] = raycaster.intersectObject(mesh, false)

    if (!intersection) {
      if (!isMultiSelect) {
        resetSelection()
      }
      return
    }

    if (selectionMode === 'vertex') {
      const vertexIndex = getClosestVertexIndex(geometry, intersection.faceIndex, intersection.point)
      if (vertexIndex !== null && vertexIndex !== undefined) {
        applySelection('vertex', [vertexIndex], isMultiSelect)
      }
      return
    }

    if (intersection.faceIndex !== undefined && intersection.faceIndex !== null) {
      applySelection('face', [intersection.faceIndex], isMultiSelect)
    }
  }, [applySelection, createSelectionMesh, geometry, resetSelection, selectionMode])

  const selectWithinRectangle = useCallback((startPoint, endPoint, isMultiSelect) => {
    if (!geometry || !cameraRef.current || !canvasShellRef.current) {
      return
    }

    const rect = canvasShellRef.current.getBoundingClientRect()
    const bounds = getRectangleBounds(startPoint, endPoint)
    const raycaster = new THREE.Raycaster()
    const mesh = createSelectionMesh()
    const samplePoints = createRectangleSamplePoints(bounds)

    if (selectionMode === 'vertex') {
      const nextVertices = new Set()

      samplePoints.forEach(samplePoint => {
        const pointer = new THREE.Vector2(
          (samplePoint.x / rect.width) * 2 - 1,
          -((samplePoint.y / rect.height) * 2 - 1)
        )

        raycaster.setFromCamera(pointer, cameraRef.current)
        const [intersection] = raycaster.intersectObject(mesh, false)

        if (!intersection) {
          return
        }

        const vertexIndex = getClosestVertexIndex(geometry, intersection.faceIndex, intersection.point)
        if (vertexIndex !== null && vertexIndex !== undefined) {
          nextVertices.add(vertexIndex)
        }
      })

      applySelection('vertex', [...nextVertices].sort((left, right) => left - right), isMultiSelect)
      return
    }

    const nextFaces = new Set()

    samplePoints.forEach(samplePoint => {
      const pointer = new THREE.Vector2(
        (samplePoint.x / rect.width) * 2 - 1,
        -((samplePoint.y / rect.height) * 2 - 1)
      )

      raycaster.setFromCamera(pointer, cameraRef.current)
      const [intersection] = raycaster.intersectObject(mesh, false)

      if (intersection?.faceIndex !== undefined && intersection.faceIndex !== null) {
        nextFaces.add(intersection.faceIndex)
      }
    })

    applySelection('face', [...nextFaces].sort((left, right) => left - right), isMultiSelect)
  }, [applySelection, createRectangleSamplePoints, createSelectionMesh, geometry, selectionMode])

  const getPointerPosition = useCallback((event) => {
    const rect = canvasShellRef.current?.getBoundingClientRect()

    if (!rect) {
      return null
    }

    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    }
  }, [])

  const handleCanvasPointerDown = useCallback((event) => {
    if (event.button !== 0) {
      return
    }

    const nextPoint = getPointerPosition(event)
    if (!nextPoint) {
      return
    }

    event.preventDefault()

    dragStateRef.current = {
      startPoint: nextPoint,
      shiftKey: event.shiftKey,
      pointerId: event.pointerId,
      isDragging: false
    }

    canvasShellRef.current?.setPointerCapture?.(event.pointerId)
  }, [getPointerPosition])

  const handleCanvasPointerMove = useCallback((event) => {
    if (!dragStateRef.current) {
      return
    }

    const nextPoint = getPointerPosition(event)
    if (!nextPoint) {
      return
    }

    const deltaX = Math.abs(nextPoint.x - dragStateRef.current.startPoint.x)
    const deltaY = Math.abs(nextPoint.y - dragStateRef.current.startPoint.y)
    const isDragging = deltaX >= 4 || deltaY >= 4

    dragStateRef.current.isDragging = isDragging

    if (!isDragging) {
      setSelectionBox(null)
      return
    }

    setSelectionBox({
      startPoint: dragStateRef.current.startPoint,
      endPoint: nextPoint
    })
  }, [getPointerPosition])

  const handleCanvasPointerUp = useCallback((event) => {
    if (!dragStateRef.current || event.button !== 0) {
      return
    }

    const nextPoint = getPointerPosition(event) || dragStateRef.current.startPoint
    const startPoint = dragStateRef.current.startPoint

    if (dragStateRef.current.isDragging) {
      selectWithinRectangle(startPoint, nextPoint, dragStateRef.current.shiftKey)
    } else {
      selectAtPoint(startPoint, dragStateRef.current.shiftKey)
    }

    canvasShellRef.current?.releasePointerCapture?.(dragStateRef.current.pointerId)
    dragStateRef.current = null
    setSelectionBox(null)
  }, [getPointerPosition, selectAtPoint, selectWithinRectangle])

  const handleCanvasPointerCancel = useCallback(() => {
    dragStateRef.current = null
    setSelectionBox(null)
  }, [])

  const applyGeometryUpdate = useCallback((nextGeometry, nextHoleLoops = []) => {
    setGeometry(nextGeometry)
    setHoleLoops(nextHoleLoops)
    setSelectedFaceIndices([])
    setSelectedVertexIndices([])
    setFeedback('Mesh updated.')
  }, [])

  const handleDelete = useCallback(() => {
    if (!geometry) {
      return
    }

    if (selectionMode === 'face') {
      const result = deleteSelectedFaces(geometry, selectedFaceIndices)
      applyGeometryUpdate(result.geometry, result.holeLoops)
      return
    }

    const result = deleteSelectedVertices(geometry, selectedVertexIndices)
    applyGeometryUpdate(result.geometry, result.holeLoops)
  }, [applyGeometryUpdate, geometry, selectedFaceIndices, selectedVertexIndices, selectionMode])

  const handleSmooth = useCallback(() => {
    if (!geometry || selectedVertexIndices.length === 0) {
      return
    }

    applyGeometryUpdate(smoothSelectedVertices(geometry, selectedVertexIndices), [])
  }, [applyGeometryUpdate, geometry, selectedVertexIndices])

  const handleMerge = useCallback(() => {
    if (!geometry || selectedVertexIndices.length < 2) {
      return
    }

    applyGeometryUpdate(mergeSelectedVertices(geometry, selectedVertexIndices), [])
  }, [applyGeometryUpdate, geometry, selectedVertexIndices])

  const handleSubdivide = useCallback(() => {
    if (!geometry || selectedFaceIndices.length === 0) {
      return
    }

    applyGeometryUpdate(subdivideSelectedFaces(geometry, selectedFaceIndices), [])
  }, [applyGeometryUpdate, geometry, selectedFaceIndices])

  const handleFillHole = useCallback(() => {
    if (!geometry || availableHoleLoops.length === 0) {
      return
    }

    applyGeometryUpdate(fillHoleLoops(geometry, availableHoleLoops), [])
  }, [applyGeometryUpdate, availableHoleLoops, geometry])

  const handleSave = useCallback(async (saveMode) => {
    if (!geometry || saving) {
      return
    }

    try {
      setSaving(true)
      setError('')
      setFeedback('Saving mesh...')

      const savedAsset = await saveMeshEdit({
        assetId: Number.isFinite(numericAssetId) && numericAssetId > 0 ? numericAssetId : null,
        filePath,
        name: meshName,
        saveMode,
        objText: exportGeometryToObj(geometry)
      })

      try {
        const assetUrl = savedAsset?.filename ? `http://localhost:3001/assets/${encodeURI(savedAsset.filename)}` : ''
        const response = assetUrl ? await fetch(assetUrl) : null
        if (response?.ok) {
          const blob = await response.blob()
          const meshFile = new File([blob], savedAsset.filename?.split('/').pop() || `${savedAsset.name || 'mesh'}.obj`, {
            type: blob.type || 'application/octet-stream'
          })
          const thumbnailFile = await createMeshThumbnailFile(meshFile)
          if (thumbnailFile) {
            await uploadAssetThumbnail(savedAsset.id, thumbnailFile)
          }
        }
      } catch (thumbnailError) {
        console.warn('Failed to refresh mesh thumbnail:', thumbnailError)
      }

      if (projectId && nodeId) {
        await updateProjectNode(Number(projectId), Number(nodeId), {
          assetId: savedAsset.id,
          name: savedAsset.name,
          status: null,
          progress: null,
          metadata: {
            lastAction: saveMode === 'version' ? 'mesh-editor-version' : 'mesh-editor-save'
          }
        })
      }

      setFeedback(saveMode === 'version' ? 'New mesh version saved.' : 'Mesh saved.')
    } catch (err) {
      setError(err.message || 'Failed to save mesh')
      setFeedback('')
    } finally {
      setSaving(false)
    }
  }, [filePath, geometry, meshName, nodeId, numericAssetId, projectId, saveMeshEdit, saving, updateProjectNode, uploadAssetThumbnail])

  const handleBack = useCallback(() => {
    if (returnTo) {
      navigate(returnTo)
      return
    }

    navigate(-1)
  }, [navigate, returnTo])

  const deleteDisabled = selectionMode === 'face' ? selectedFaceIndices.length === 0 : selectedVertexIndices.length === 0
  const smoothDisabled = selectedVertexIndices.length === 0
  const mergeDisabled = selectedVertexIndices.length < 2
  const subdivideDisabled = selectedFaceIndices.length === 0
  const fillDisabled = availableHoleLoops.length === 0

  return (
    <div className="mesh-editor-layout">
      <Header showSearch onSettingsClick={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="mesh-editor-page">
        <section className="mesh-editor-shell">
          <div className="mesh-editor-toolbar">
            <div className="mesh-editor-toolbar__group">
              <button type="button" className="mesh-editor-toolbar__back" onClick={handleBack}>
                <span className="material-symbols-outlined">arrow_back</span>
                Back
              </button>
              <div className="mesh-editor-toolbar__title-group">
                <h1 className="mesh-editor-page__title font-headline">Mesh Editor</h1>
                <p className="mesh-editor-page__desc">Wireframe selection for vertices and faces with basic topology actions.</p>
              </div>
              <div className="mesh-editor-toolbar__name-field">
                <label className="mesh-editor-panel__label">Mesh name</label>
                <input className="mesh-editor-panel__input" value={meshName} onChange={event => setMeshName(event.target.value)} />
              </div>
            </div>
            <div className="mesh-editor-toolbar__stats">
              <span>{stats.vertices} vertices</span>
              <span>{stats.faces} faces</span>
            </div>
          </div>

          {(error || feedback) && (
            <div className={`mesh-editor-feedback ${error ? 'mesh-editor-feedback--error' : 'mesh-editor-feedback--success'}`}>
              <span className="material-symbols-outlined">{error ? 'error' : 'check_circle'}</span>
              <span>{error || feedback}</span>
            </div>
          )}

          <div className="mesh-editor-workspace">
            <aside className="mesh-editor-sidebar">
              <div className="mesh-editor-panel">
                <span className="mesh-editor-panel__label">Selection</span>
                <div className="mesh-editor-toggle-group">
                  <button
                    type="button"
                    className={`mesh-editor-toggle ${selectionMode === 'face' ? 'mesh-editor-toggle--active' : ''}`}
                    onClick={() => {
                      setSelectionMode('face')
                      resetSelection()
                    }}
                  >
                    Faces
                  </button>
                  <button
                    type="button"
                    className={`mesh-editor-toggle ${selectionMode === 'vertex' ? 'mesh-editor-toggle--active' : ''}`}
                    onClick={() => {
                      setSelectionMode('vertex')
                      resetSelection()
                    }}
                  >
                    Vertices
                  </button>
                </div>
                <span className="mesh-editor-panel__hint">Left mouse drag selects with a rectangle. Shift+drag adds or removes items.</span>
                <span className="mesh-editor-panel__hint">Middle mouse drag rotates the mesh.</span>
              </div>

              <div className="mesh-editor-panel mesh-editor-panel--actions">
                <span className="mesh-editor-panel__label">Actions</span>
                <div className="mesh-editor-actions mesh-editor-actions--column">
                  <button type="button" className="mesh-editor-btn" onClick={handleDelete} disabled={deleteDisabled}>Delete</button>
                  <button type="button" className="mesh-editor-btn" onClick={handleSmooth} disabled={smoothDisabled}>Smooth</button>
                  <button type="button" className="mesh-editor-btn" onClick={handleMerge} disabled={mergeDisabled}>Merge</button>
                  <button type="button" className="mesh-editor-btn" onClick={handleSubdivide} disabled={subdivideDisabled}>Subdivide</button>
                  <button type="button" className="mesh-editor-btn" onClick={handleFillHole} disabled={fillDisabled}>Fill hole</button>
                </div>
              </div>

              <div className="mesh-editor-panel mesh-editor-panel--save">
                <span className="mesh-editor-panel__label">Save</span>
                <div className="mesh-editor-actions mesh-editor-actions--column">
                  <button type="button" className="mesh-editor-btn mesh-editor-btn--primary" onClick={() => handleSave('replace')} disabled={saving || !geometry}>Save mesh</button>
                  <button type="button" className="mesh-editor-btn mesh-editor-btn--secondary" onClick={() => handleSave('version')} disabled={saving || !geometry}>Save as version</button>
                </div>
              </div>
            </aside>

            <div
              ref={canvasShellRef}
              className="mesh-editor-canvas-shell"
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerCancel}
            >
              {loading ? (
                <div className="mesh-editor-empty-state">
                  <span className="material-symbols-outlined mesh-editor-empty-state__icon">progress_activity</span>
                  <span>Loading mesh editor...</span>
                </div>
              ) : geometry ? (
                <>
                  <Canvas shadows={{ type: THREE.PCFShadowMap }} resize={{ offsetSize: true }} style={{ width: '100%', height: '100%' }}>
                    <PerspectiveCamera makeDefault position={[3, 3, 5]} near={0.0001} far={4000} />
                    <ambientLight intensity={1.25} />
                    <directionalLight position={[5, 7, 9]} intensity={2} castShadow />
                    <directionalLight position={[-5, 3, -4]} intensity={0.6} color="#8ff5ff" />
                    <EditorMesh
                      geometry={geometry}
                      selectedFaceIndices={selectedFaceIndices}
                      selectedVertexIndices={selectedVertexIndices}
                    />
                    <Grid
                      infiniteGrid
                      fadeDistance={60}
                      cellColor="#47484A"
                      sectionColor="#AC89FF"
                      sectionThickness={1.5}
                      sectionSize={10}
                    />
                    <CameraRig geometry={geometry} onCameraReady={camera => { cameraRef.current = camera }} />
                  </Canvas>
                  {selectionBox && (
                    <div
                      className="mesh-editor-selection-box"
                      style={{
                        left: Math.min(selectionBox.startPoint.x, selectionBox.endPoint.x),
                        top: Math.min(selectionBox.startPoint.y, selectionBox.endPoint.y),
                        width: Math.max(1, Math.abs(selectionBox.endPoint.x - selectionBox.startPoint.x)),
                        height: Math.max(1, Math.abs(selectionBox.endPoint.y - selectionBox.startPoint.y))
                      }}
                    />
                  )}
                </>
              ) : (
                <div className="mesh-editor-empty-state">
                  <span className="material-symbols-outlined mesh-editor-empty-state__icon">deployed_code_alert</span>
                  <span>Mesh could not be loaded.</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}
