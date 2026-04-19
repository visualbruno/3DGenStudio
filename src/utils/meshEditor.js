import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

function getExtensionFromUrl(url = '') {
  const sanitizedUrl = String(url).split('?')[0].toLowerCase()
  const match = sanitizedUrl.match(/\.[^.]+$/)
  return match?.[0] || ''
}

function loadWithLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject)
  })
}

function createMergedGeometryFromObject(object) {
  const root = object?.scene || object

  if (!root) {
    throw new Error('No mesh data found')
  }

  root.updateMatrixWorld(true)

  const geometries = []
  root.traverse(child => {
    if (!child.isMesh || !child.geometry?.attributes?.position) {
      return
    }

    const geometry = child.geometry.clone()
    geometry.applyMatrix4(child.matrixWorld)
    geometries.push(geometry.index ? geometry.toNonIndexed() : geometry)
  })

  if (geometries.length === 0) {
    throw new Error('No editable mesh geometry found')
  }

  const mergedGeometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false)
  const weldedGeometry = mergeVertices(mergedGeometry, 1e-5)

  if (!weldedGeometry.attributes.normal) {
    weldedGeometry.computeVertexNormals()
  }

  weldedGeometry.computeBoundingBox()
  weldedGeometry.computeBoundingSphere()
  return weldedGeometry
}

async function loadGeometryFromUrl(url) {
  const extension = getExtensionFromUrl(url)

  if (extension === '.glb' || extension === '.gltf') {
    return createMergedGeometryFromObject(await loadWithLoader(new GLTFLoader(), url))
  }

  if (extension === '.obj') {
    return createMergedGeometryFromObject(await loadWithLoader(new OBJLoader(), url))
  }

  if (extension === '.fbx') {
    return createMergedGeometryFromObject(await loadWithLoader(new FBXLoader(), url))
  }

  if (extension === '.stl') {
    return createMergedGeometryFromObject(new THREE.Mesh(await loadWithLoader(new STLLoader(), url)))
  }

  if (extension === '.ply') {
    return createMergedGeometryFromObject(new THREE.Mesh(await loadWithLoader(new PLYLoader(), url)))
  }

  throw new Error('Unsupported mesh format')
}

function createIndexedGeometry(positions = [], indices = []) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function geometryToMeshData(geometry) {
  if (!geometry?.attributes?.position) {
    return { positions: [], indices: [] }
  }

  const positions = Array.from(geometry.attributes.position.array)
  const indices = geometry.index
    ? Array.from(geometry.index.array)
    : Array.from({ length: positions.length / 3 }, (_, index) => index)

  return { positions, indices }
}

function compactMeshData({ positions = [], indices = [] }) {
  const usedVertices = [...new Set(indices)]
  const nextPositions = []
  const remap = new Map()

  usedVertices.forEach((vertexIndex, nextIndex) => {
    remap.set(vertexIndex, nextIndex)
    nextPositions.push(
      positions[vertexIndex * 3],
      positions[vertexIndex * 3 + 1],
      positions[vertexIndex * 3 + 2]
    )
  })

  const nextIndices = []
  for (let index = 0; index < indices.length; index += 3) {
    const a = remap.get(indices[index])
    const b = remap.get(indices[index + 1])
    const c = remap.get(indices[index + 2])

    if (a === undefined || b === undefined || c === undefined) {
      continue
    }

    if (a === b || b === c || c === a) {
      continue
    }

    nextIndices.push(a, b, c)
  }

  return { positions: nextPositions, indices: nextIndices }
}

function getFace(meshData, faceIndex) {
  const offset = faceIndex * 3
  return meshData.indices.slice(offset, offset + 3)
}

function buildNeighborMap(indices = []) {
  const neighbors = new Map()

  const connect = (from, to) => {
    if (!neighbors.has(from)) {
      neighbors.set(from, new Set())
    }

    neighbors.get(from).add(to)
  }

  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]
    const b = indices[index + 1]
    const c = indices[index + 2]

    connect(a, b)
    connect(a, c)
    connect(b, a)
    connect(b, c)
    connect(c, a)
    connect(c, b)
  }

  return neighbors
}

function buildHoleLoops(meshData, removedFaceIndices = []) {
  const removedSet = new Set(removedFaceIndices)
  const boundaryEdges = new Map()

  const addBoundaryEdge = (start, end) => {
    const key = `${start}:${end}`
    const reverseKey = `${end}:${start}`

    if (boundaryEdges.has(reverseKey)) {
      boundaryEdges.delete(reverseKey)
      return
    }

    boundaryEdges.set(key, { start, end })
  }

  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    if (!removedSet.has(faceIndex)) {
      continue
    }

    const [a, b, c] = getFace(meshData, faceIndex)
    addBoundaryEdge(a, b)
    addBoundaryEdge(b, c)
    addBoundaryEdge(c, a)
  }

  const loops = []
  const remainingEdges = [...boundaryEdges.values()]

  while (remainingEdges.length > 0) {
    const currentEdge = remainingEdges.shift()
    const loop = [currentEdge.start, currentEdge.end]
    let cursor = currentEdge.end
    let closed = cursor === loop[0]

    while (!closed) {
      const nextIndex = remainingEdges.findIndex(edge => edge.start === cursor)
      if (nextIndex === -1) {
        break
      }

      const nextEdge = remainingEdges.splice(nextIndex, 1)[0]
      loop.push(nextEdge.end)
      cursor = nextEdge.end
      closed = cursor === loop[0]
    }

    if (loop[loop.length - 1] === loop[0]) {
      loop.pop()
    }

    if (loop.length >= 3) {
      loops.push(loop)
    }
  }

  return loops
}

function getBoundaryEdgeRecords(meshData) {
  const edgeRecords = new Map()

  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    const [a, b, c] = getFace(meshData, faceIndex)

    ;[[a, b], [b, c], [c, a]].forEach(([start, end]) => {
      const key = start < end ? `${start}:${end}` : `${end}:${start}`
      const existingRecord = edgeRecords.get(key)

      if (existingRecord) {
        existingRecord.count += 1
        existingRecord.faceIndices.push(faceIndex)
        return
      }

      edgeRecords.set(key, {
        key,
        vertices: [start, end],
        count: 1,
        faceIndices: [faceIndex]
      })
    })
  }

  return [...edgeRecords.values()].filter(record => record.count === 1)
}

function buildLoopsFromBoundaryEdges(boundaryEdges = []) {
  const adjacency = new Map()
  const visitedEdges = new Set()

  const addNeighbor = (from, to) => {
    if (!adjacency.has(from)) {
      adjacency.set(from, new Set())
    }

    adjacency.get(from).add(to)
  }

  boundaryEdges.forEach(edge => {
    const [a, b] = edge.vertices
    addNeighbor(a, b)
    addNeighbor(b, a)
  })

  const loops = []

  boundaryEdges.forEach(edge => {
    if (visitedEdges.has(edge.key)) {
      return
    }

    const [startVertex, nextVertex] = edge.vertices
    const loop = [startVertex]
    let previousVertex = startVertex
    let currentVertex = nextVertex
    let closed = false

    visitedEdges.add(edge.key)

    while (true) {
      loop.push(currentVertex)

      const neighbors = [...(adjacency.get(currentVertex) || [])].filter(vertex => vertex !== previousVertex)
      const nextCandidate = neighbors.find(vertex => {
        const key = currentVertex < vertex ? `${currentVertex}:${vertex}` : `${vertex}:${currentVertex}`
        return !visitedEdges.has(key)
      })

      if (!nextCandidate) {
        closed = currentVertex === startVertex
        break
      }

      const nextKey = currentVertex < nextCandidate ? `${currentVertex}:${nextCandidate}` : `${nextCandidate}:${currentVertex}`
      visitedEdges.add(nextKey)
      previousVertex = currentVertex
      currentVertex = nextCandidate

      if (currentVertex === startVertex) {
        closed = true
        break
      }
    }

    if (!closed) {
      return
    }

    if (loop[loop.length - 1] === loop[0]) {
      loop.pop()
    }

    const normalizedLoop = [...new Set(loop)]
    if (normalizedLoop.length >= 3) {
      loops.push(normalizedLoop)
    }
  })

  return loops
}

export function getGeometryHoleLoops(geometry) {
  const meshData = geometryToMeshData(geometry)

  if (meshData.indices.length === 0) {
    return []
  }

  return buildLoopsFromBoundaryEdges(getBoundaryEdgeRecords(meshData))
}

export function getSelectedHoleLoops(geometry, { selectionMode = 'face', selectedFaceIndices = [], selectedVertexIndices = [] } = {}) {
  const meshData = geometryToMeshData(geometry)

  if (meshData.indices.length === 0) {
    return []
  }

  const boundaryEdges = getBoundaryEdgeRecords(meshData)
  const loops = buildLoopsFromBoundaryEdges(boundaryEdges)

  if (selectionMode === 'vertex') {
    const selectedVertexSet = new Set(selectedVertexIndices)
    return loops.filter(loop => loop.some(vertexIndex => selectedVertexSet.has(vertexIndex)))
  }

  const boundaryEdgeMap = new Map(boundaryEdges.map(edge => [edge.key, edge]))
  const selectedFaceSet = new Set(selectedFaceIndices)

  return loops.filter(loop => loop.some((vertexIndex, index) => {
    const nextVertex = loop[(index + 1) % loop.length]
    const edgeKey = vertexIndex < nextVertex ? `${vertexIndex}:${nextVertex}` : `${nextVertex}:${vertexIndex}`
    const edge = boundaryEdgeMap.get(edgeKey)
    return edge?.faceIndices?.some(faceIndex => selectedFaceSet.has(faceIndex))
  }))
}

export async function loadEditableGeometryFromUrl(url) {
  const geometry = await loadGeometryFromUrl(url)
  const { positions, indices } = compactMeshData(geometryToMeshData(geometry))
  return createIndexedGeometry(positions, indices)
}

export function geometryFaceCount(geometry) {
  return geometry?.index ? geometry.index.count / 3 : 0
}

export function deleteSelectedFaces(geometry, selectedFaceIndices = []) {
  const meshData = geometryToMeshData(geometry)
  const removedFaces = new Set(selectedFaceIndices)
  const nextIndices = []

  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    if (removedFaces.has(faceIndex)) {
      continue
    }

    nextIndices.push(...getFace(meshData, faceIndex))
  }

  const holeLoops = buildHoleLoops(meshData, selectedFaceIndices)
  const compacted = compactMeshData({ positions: meshData.positions, indices: nextIndices })

  return {
    geometry: createIndexedGeometry(compacted.positions, compacted.indices),
    holeLoops
  }
}

export function deleteSelectedVertices(geometry, selectedVertexIndices = []) {
  const meshData = geometryToMeshData(geometry)
  const removedVertices = new Set(selectedVertexIndices)
  const facesToDelete = []

  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    const [a, b, c] = getFace(meshData, faceIndex)

    if (removedVertices.has(a) || removedVertices.has(b) || removedVertices.has(c)) {
      facesToDelete.push(faceIndex)
    }
  }

  return deleteSelectedFaces(geometry, facesToDelete)
}

export function smoothSelectedVertices(geometry, selectedVertexIndices = [], strength = 0.45) {
  const meshData = geometryToMeshData(geometry)
  const nextPositions = [...meshData.positions]
  const neighbors = buildNeighborMap(meshData.indices)

  selectedVertexIndices.forEach(vertexIndex => {
    const adjacent = [...(neighbors.get(vertexIndex) || [])]
    if (adjacent.length === 0) {
      return
    }

    const average = new THREE.Vector3()
    adjacent.forEach(neighborIndex => {
      average.add(new THREE.Vector3(
        meshData.positions[neighborIndex * 3],
        meshData.positions[neighborIndex * 3 + 1],
        meshData.positions[neighborIndex * 3 + 2]
      ))
    })
    average.multiplyScalar(1 / adjacent.length)

    const current = new THREE.Vector3(
      meshData.positions[vertexIndex * 3],
      meshData.positions[vertexIndex * 3 + 1],
      meshData.positions[vertexIndex * 3 + 2]
    ).lerp(average, strength)

    nextPositions[vertexIndex * 3] = current.x
    nextPositions[vertexIndex * 3 + 1] = current.y
    nextPositions[vertexIndex * 3 + 2] = current.z
  })

  return createIndexedGeometry(nextPositions, meshData.indices)
}

export function mergeSelectedVertices(geometry, selectedVertexIndices = []) {
  if (selectedVertexIndices.length < 2) {
    return geometry.clone()
  }

  const meshData = geometryToMeshData(geometry)
  const nextPositions = [...meshData.positions]
  const selectedSet = new Set(selectedVertexIndices)
  const keepVertex = selectedVertexIndices[0]
  const centroid = new THREE.Vector3()

  selectedVertexIndices.forEach(vertexIndex => {
    centroid.add(new THREE.Vector3(
      meshData.positions[vertexIndex * 3],
      meshData.positions[vertexIndex * 3 + 1],
      meshData.positions[vertexIndex * 3 + 2]
    ))
  })
  centroid.multiplyScalar(1 / selectedVertexIndices.length)

  nextPositions[keepVertex * 3] = centroid.x
  nextPositions[keepVertex * 3 + 1] = centroid.y
  nextPositions[keepVertex * 3 + 2] = centroid.z

  const nextIndices = meshData.indices.map(vertexIndex => (selectedSet.has(vertexIndex) ? keepVertex : vertexIndex))
  const compacted = compactMeshData({ positions: nextPositions, indices: nextIndices })
  return createIndexedGeometry(compacted.positions, compacted.indices)
}

export function subdivideSelectedFaces(geometry, selectedFaceIndices = []) {
  const meshData = geometryToMeshData(geometry)
  const nextPositions = [...meshData.positions]
  const nextIndices = []
  const selectedFaces = new Set(selectedFaceIndices)
  const midpointCache = new Map()

  const getMidpointIndex = (left, right) => {
    const key = left < right ? `${left}:${right}` : `${right}:${left}`
    if (midpointCache.has(key)) {
      return midpointCache.get(key)
    }

    const midpointIndex = nextPositions.length / 3
    nextPositions.push(
      (meshData.positions[left * 3] + meshData.positions[right * 3]) / 2,
      (meshData.positions[left * 3 + 1] + meshData.positions[right * 3 + 1]) / 2,
      (meshData.positions[left * 3 + 2] + meshData.positions[right * 3 + 2]) / 2
    )
    midpointCache.set(key, midpointIndex)
    return midpointIndex
  }

  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    const [a, b, c] = getFace(meshData, faceIndex)

    if (!selectedFaces.has(faceIndex)) {
      nextIndices.push(a, b, c)
      continue
    }

    const ab = getMidpointIndex(a, b)
    const bc = getMidpointIndex(b, c)
    const ca = getMidpointIndex(c, a)

    nextIndices.push(
      a, ab, ca,
      ab, b, bc,
      ca, bc, c,
      ab, bc, ca
    )
  }

  return createIndexedGeometry(nextPositions, nextIndices)
}

export function fillHoleLoops(geometry, holeLoops = []) {
  if (!Array.isArray(holeLoops) || holeLoops.length === 0) {
    return geometry.clone()
  }

  const meshData = geometryToMeshData(geometry)
  const nextPositions = [...meshData.positions]
  const nextIndices = [...meshData.indices]

  holeLoops.forEach(loop => {
    if (!Array.isArray(loop) || loop.length < 3) {
      return
    }

    const centroid = new THREE.Vector3()
    loop.forEach(vertexIndex => {
      centroid.add(new THREE.Vector3(
        meshData.positions[vertexIndex * 3],
        meshData.positions[vertexIndex * 3 + 1],
        meshData.positions[vertexIndex * 3 + 2]
      ))
    })
    centroid.multiplyScalar(1 / loop.length)

    const centerIndex = nextPositions.length / 3
    nextPositions.push(centroid.x, centroid.y, centroid.z)

    for (let index = 0; index < loop.length; index += 1) {
      const current = loop[index]
      const next = loop[(index + 1) % loop.length]
      nextIndices.push(current, next, centerIndex)
    }
  })

  return createIndexedGeometry(nextPositions, nextIndices)
}

export function getFaceSelectionGeometry(geometry, selectedFaceIndices = []) {
  const meshData = geometryToMeshData(geometry)
  const positions = []

  selectedFaceIndices.forEach(faceIndex => {
    getFace(meshData, faceIndex).forEach(vertexIndex => {
      positions.push(
        meshData.positions[vertexIndex * 3],
        meshData.positions[vertexIndex * 3 + 1],
        meshData.positions[vertexIndex * 3 + 2]
      )
    })
  })

  const selectionGeometry = new THREE.BufferGeometry()
  selectionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  selectionGeometry.computeVertexNormals()
  return selectionGeometry
}

export function getVertexSelectionPositions(geometry, selectedVertexIndices = []) {
  const positionAttribute = geometry?.attributes?.position
  if (!positionAttribute) {
    return []
  }

  return selectedVertexIndices.flatMap(vertexIndex => [
    positionAttribute.getX(vertexIndex),
    positionAttribute.getY(vertexIndex),
    positionAttribute.getZ(vertexIndex)
  ])
}

export function getClosestVertexIndex(geometry, faceIndex, point) {
  if (!geometry?.index || faceIndex === undefined || faceIndex === null) {
    return null
  }

  const positionAttribute = geometry.attributes.position
  const a = geometry.index.array[faceIndex * 3]
  const b = geometry.index.array[faceIndex * 3 + 1]
  const c = geometry.index.array[faceIndex * 3 + 2]
  const candidates = [a, b, c]

  let closestVertex = null
  let closestDistance = Number.POSITIVE_INFINITY

  candidates.forEach(vertexIndex => {
    const vertex = new THREE.Vector3(
      positionAttribute.getX(vertexIndex),
      positionAttribute.getY(vertexIndex),
      positionAttribute.getZ(vertexIndex)
    )
    const distance = vertex.distanceTo(point)
    if (distance < closestDistance) {
      closestDistance = distance
      closestVertex = vertexIndex
    }
  })

  return closestVertex
}

export function exportGeometryToObj(geometry) {
  const meshData = geometryToMeshData(geometry)
  const lines = ['o MeshEditorResult']

  for (let index = 0; index < meshData.positions.length; index += 3) {
    lines.push(`v ${meshData.positions[index]} ${meshData.positions[index + 1]} ${meshData.positions[index + 2]}`)
  }

  for (let index = 0; index < meshData.indices.length; index += 3) {
    lines.push(`f ${meshData.indices[index] + 1} ${meshData.indices[index + 1] + 1} ${meshData.indices[index + 2] + 1}`)
  }

  return `${lines.join('\n')}\n`
}
