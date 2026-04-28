import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

if (THREE.BufferGeometry.prototype.computeBoundsTree !== computeBoundsTree) {
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
}

if (THREE.BufferGeometry.prototype.disposeBoundsTree !== disposeBoundsTree) {
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
}

if (THREE.Mesh.prototype.raycast !== acceleratedRaycast) {
  THREE.Mesh.prototype.raycast = acceleratedRaycast
}

function invalidateGeometryAnalysis(geometry) {
  if (!geometry?.userData) {
    return
  }

  delete geometry.userData.meshEditorBoundaryCache
}

function finalizeGeometry(geometry, { rebuildBoundsTree = true } = {}) {
  if (!geometry) {
    return geometry
  }

  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals()
  }

  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  invalidateGeometryAnalysis(geometry)

  if (rebuildBoundsTree && geometry.computeBoundsTree) {
    geometry.disposeBoundsTree?.()
    geometry.computeBoundsTree()
  }

  return geometry
}

function markAttributeUpdateRange(attribute, startComponent, componentCount) {
  if (!attribute || componentCount <= 0) {
    return
  }

  if (typeof attribute.clearUpdateRanges === 'function') {
    attribute.clearUpdateRanges()
  }

  if (typeof attribute.addUpdateRange === 'function') {
    attribute.addUpdateRange(startComponent, componentCount)
  } else if (attribute.updateRange) {
    attribute.updateRange.offset = startComponent
    attribute.updateRange.count = componentCount
  }

  attribute.needsUpdate = true
}

function buildVertexFaceMap(indices = []) {
  const vertexFaces = new Map()

  const addFace = (vertexIndex, faceIndex) => {
    if (!vertexFaces.has(vertexIndex)) {
      vertexFaces.set(vertexIndex, [])
    }

    vertexFaces.get(vertexIndex).push(faceIndex)
  }

  for (let faceIndex = 0; faceIndex < indices.length / 3; faceIndex += 1) {
    addFace(indices[faceIndex * 3], faceIndex)
    addFace(indices[faceIndex * 3 + 1], faceIndex)
    addFace(indices[faceIndex * 3 + 2], faceIndex)
  }

  return vertexFaces
}

function recomputeVertexNormalsLocally(geometry, changedVertexIndices = []) {
  if (!geometry?.index || changedVertexIndices.length === 0) {
    return
  }

  const positionAttribute = geometry.attributes.position
  let normalAttribute = geometry.attributes.normal

  if (!positionAttribute) {
    return
  }

  if (!normalAttribute || normalAttribute.count !== positionAttribute.count) {
    normalAttribute = new THREE.BufferAttribute(new Float32Array(positionAttribute.count * 3), 3)
    geometry.setAttribute('normal', normalAttribute)
    geometry.computeVertexNormals()
    return
  }

  const indices = geometry.index.array
  const positions = positionAttribute.array
  const normals = normalAttribute.array
  const vertexFaces = buildVertexFaceMap(indices)
  const affectedFaces = new Set()
  const affectedVertices = new Set()

  changedVertexIndices.forEach(vertexIndex => {
    ;(vertexFaces.get(vertexIndex) || []).forEach(faceIndex => {
      affectedFaces.add(faceIndex)
      affectedVertices.add(indices[faceIndex * 3])
      affectedVertices.add(indices[faceIndex * 3 + 1])
      affectedVertices.add(indices[faceIndex * 3 + 2])
    })
  })

  affectedVertices.forEach(vertexIndex => {
    const offset = vertexIndex * 3
    normals[offset] = 0
    normals[offset + 1] = 0
    normals[offset + 2] = 0
  })

  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const faceNormal = new THREE.Vector3()

  affectedFaces.forEach(faceIndex => {
    const a = indices[faceIndex * 3]
    const b = indices[faceIndex * 3 + 1]
    const c = indices[faceIndex * 3 + 2]
    const aOffset = a * 3
    const bOffset = b * 3
    const cOffset = c * 3

    ab.set(
      positions[bOffset] - positions[aOffset],
      positions[bOffset + 1] - positions[aOffset + 1],
      positions[bOffset + 2] - positions[aOffset + 2]
    )
    ac.set(
      positions[cOffset] - positions[aOffset],
      positions[cOffset + 1] - positions[aOffset + 1],
      positions[cOffset + 2] - positions[aOffset + 2]
    )

    faceNormal.crossVectors(ab, ac)

    normals[aOffset] += faceNormal.x
    normals[aOffset + 1] += faceNormal.y
    normals[aOffset + 2] += faceNormal.z
    normals[bOffset] += faceNormal.x
    normals[bOffset + 1] += faceNormal.y
    normals[bOffset + 2] += faceNormal.z
    normals[cOffset] += faceNormal.x
    normals[cOffset + 1] += faceNormal.y
    normals[cOffset + 2] += faceNormal.z
  })

  const vertexNormal = new THREE.Vector3()
  let minVertexIndex = Number.POSITIVE_INFINITY
  let maxVertexIndex = Number.NEGATIVE_INFINITY

  affectedVertices.forEach(vertexIndex => {
    const offset = vertexIndex * 3
    vertexNormal.set(normals[offset], normals[offset + 1], normals[offset + 2]).normalize()
    normals[offset] = Number.isFinite(vertexNormal.x) ? vertexNormal.x : 0
    normals[offset + 1] = Number.isFinite(vertexNormal.y) ? vertexNormal.y : 0
    normals[offset + 2] = Number.isFinite(vertexNormal.z) ? vertexNormal.z : 0
    minVertexIndex = Math.min(minVertexIndex, vertexIndex)
    maxVertexIndex = Math.max(maxVertexIndex, vertexIndex)
  })

  if (Number.isFinite(minVertexIndex) && Number.isFinite(maxVertexIndex)) {
    markAttributeUpdateRange(normalAttribute, minVertexIndex * 3, (maxVertexIndex - minVertexIndex + 1) * 3)
  } else {
    normalAttribute.needsUpdate = true
  }
}

function refitSpatialIndex(geometry) {
  if (!geometry) {
    return
  }

  if (geometry.boundsTree?.refit) {
    geometry.boundsTree.refit()
    return
  }

  geometry.computeBoundsTree?.()
}

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
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  const root = object?.scene || object

  if (!root) {
    throw new Error('No mesh data found')
  }

  root.updateMatrixWorld(true)

  const geometries = []
  let meshCount = 0
  let sourceVertexCount = 0
  root.traverse(child => {
    if (!child.isMesh || !child.geometry?.attributes?.position) {
      return
    }

    meshCount += 1
    sourceVertexCount += child.geometry.attributes.position.count
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

  console.log('[meshEditor] createMergedGeometryFromObject', {
    meshCount,
    sourceVertexCount,
    mergedVertexCount: mergedGeometry?.attributes?.position?.count || 0,
    weldedVertexCount: weldedGeometry?.attributes?.position?.count || 0,
    elapsedMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10
  })

  return finalizeGeometry(weldedGeometry)
}

export function loadEditableGeometryFromObject(object) {
  const geometry = createMergedGeometryFromObject(object)
  const { positions, indices } = compactMeshData(geometryToMeshData(geometry))
  return createIndexedGeometry(positions, indices)
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
  return finalizeGeometry(geometry)
}

function createIndexBuffer(indices = [], vertexCount = 0) {
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array
  return new THREE.BufferAttribute(new IndexArray(indices), 1)
}

function replaceGeometryData(geometry, positions = [], indices = []) {
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(createIndexBuffer(indices, positions.length / 3))
  geometry.deleteAttribute('normal')
  geometry.computeVertexNormals()
  return finalizeGeometry(geometry)
}

function computeLoopNormal(loop = [], positions = []) {
  const normal = new THREE.Vector3()

  for (let index = 0; index < loop.length; index += 1) {
    const currentOffset = loop[index] * 3
    const nextOffset = loop[(index + 1) % loop.length] * 3
    const currentX = positions[currentOffset]
    const currentY = positions[currentOffset + 1]
    const currentZ = positions[currentOffset + 2]
    const nextX = positions[nextOffset]
    const nextY = positions[nextOffset + 1]
    const nextZ = positions[nextOffset + 2]

    normal.x += (currentY - nextY) * (currentZ + nextZ)
    normal.y += (currentZ - nextZ) * (currentX + nextX)
    normal.z += (currentX - nextX) * (currentY + nextY)
  }

  return normal.normalize()
}

function projectLoopToPlane(loop = [], positions = [], dominantAxis = 'z') {
  return loop.map(vertexIndex => {
    const offset = vertexIndex * 3
    const x = positions[offset]
    const y = positions[offset + 1]
    const z = positions[offset + 2]

    if (dominantAxis === 'x') {
      return new THREE.Vector2(y, z)
    }

    if (dominantAxis === 'y') {
      return new THREE.Vector2(x, z)
    }

    return new THREE.Vector2(x, y)
  })
}

function getTriangleOrientation(indices, positions, expectedNormal) {
  const aOffset = indices[0] * 3
  const bOffset = indices[1] * 3
  const cOffset = indices[2] * 3
  const ab = new THREE.Vector3(
    positions[bOffset] - positions[aOffset],
    positions[bOffset + 1] - positions[aOffset + 1],
    positions[bOffset + 2] - positions[aOffset + 2]
  )
  const ac = new THREE.Vector3(
    positions[cOffset] - positions[aOffset],
    positions[cOffset + 1] - positions[aOffset + 1],
    positions[cOffset + 2] - positions[aOffset + 2]
  )

  return ab.cross(ac).dot(expectedNormal)
}

function triangulateHoleLoop(loop = [], positions = []) {
  if (loop.length < 3) {
    return []
  }

  const loopNormal = computeLoopNormal(loop, positions)

  if (!Number.isFinite(loopNormal.lengthSq()) || loopNormal.lengthSq() === 0) {
    return []
  }

  const absNormal = {
    x: Math.abs(loopNormal.x),
    y: Math.abs(loopNormal.y),
    z: Math.abs(loopNormal.z)
  }

  const dominantAxis = absNormal.x > absNormal.y && absNormal.x > absNormal.z
    ? 'x'
    : absNormal.y > absNormal.z
      ? 'y'
      : 'z'

  const projectedLoop = projectLoopToPlane(loop, positions, dominantAxis)
  const triangles = THREE.ShapeUtils.triangulateShape(projectedLoop, [])

  if (!Array.isArray(triangles) || triangles.length === 0) {
    return []
  }

  return triangles
    .map(([aIndex, bIndex, cIndex]) => {
      const triangle = [loop[aIndex], loop[bIndex], loop[cIndex]]

      if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[2] === triangle[0]) {
        return null
      }

      if (getTriangleOrientation(triangle, positions, loopNormal) < 0) {
        return [triangle[0], triangle[2], triangle[1]]
      }

      return triangle
    })
    .filter(Boolean)
}

function triangulateHoleLoopFallback(loop = []) {
  const triangles = []

  for (let index = 1; index < loop.length - 1; index += 1) {
    triangles.push([loop[0], loop[index], loop[index + 1]])
  }

  return triangles
}

function getVertexDistanceSquared(positions = [], leftVertexIndex, rightVertexIndex) {
  const leftOffset = leftVertexIndex * 3
  const rightOffset = rightVertexIndex * 3
  const dx = positions[leftOffset] - positions[rightOffset]
  const dy = positions[leftOffset + 1] - positions[rightOffset + 1]
  const dz = positions[leftOffset + 2] - positions[rightOffset + 2]
  return dx * dx + dy * dy + dz * dz
}

function orientTriangleToNormal(triangle = [], positions = [], normal = new THREE.Vector3(0, 0, 1)) {
  if (triangle.length !== 3) {
    return triangle
  }

  return getTriangleOrientation(triangle, positions, normal) < 0
    ? [triangle[0], triangle[2], triangle[1]]
    : triangle
}

function getSelectedBoundaryGroups(loop = [], selectedVertexSet = new Set()) {
  if (loop.length === 0) {
    return []
  }

  const groups = []

  for (let index = 0; index < loop.length; index += 1) {
    const vertexIndex = loop[index]
    if (!selectedVertexSet.has(vertexIndex)) {
      continue
    }

    const previousVertex = loop[(index - 1 + loop.length) % loop.length]
    if (selectedVertexSet.has(previousVertex)) {
      continue
    }

    const group = []
    let cursor = index

    while (selectedVertexSet.has(loop[cursor])) {
      group.push(loop[cursor])
      cursor = (cursor + 1) % loop.length
      if (cursor === index) {
        break
      }
    }

    groups.push(group)
  }

  return groups
}

function alignBridgeChains(chainA = [], chainB = [], positions = []) {
  const directScore = getVertexDistanceSquared(positions, chainA[0], chainB[0])
    + getVertexDistanceSquared(positions, chainA[chainA.length - 1], chainB[chainB.length - 1])
  const reversed = [...chainB].reverse()
  const reversedScore = getVertexDistanceSquared(positions, chainA[0], reversed[0])
    + getVertexDistanceSquared(positions, chainA[chainA.length - 1], reversed[reversed.length - 1])

  return reversedScore < directScore ? reversed : chainB
}

function buildBridgeTriangles(chainA = [], chainB = [], positions = [], normal = new THREE.Vector3(0, 0, 1)) {
  const triangles = []
  let leftIndex = 0
  let rightIndex = 0

  while (leftIndex < chainA.length - 1 || rightIndex < chainB.length - 1) {
    let triangle = null

    if (leftIndex === chainA.length - 1) {
      triangle = [chainA[leftIndex], chainB[rightIndex], chainB[rightIndex + 1]]
      rightIndex += 1
    } else if (rightIndex === chainB.length - 1) {
      triangle = [chainA[leftIndex], chainA[leftIndex + 1], chainB[rightIndex]]
      leftIndex += 1
    } else {
      const advanceLeftScore = getVertexDistanceSquared(positions, chainA[leftIndex + 1], chainB[rightIndex])
      const advanceRightScore = getVertexDistanceSquared(positions, chainA[leftIndex], chainB[rightIndex + 1])

      if (advanceLeftScore <= advanceRightScore) {
        triangle = [chainA[leftIndex], chainA[leftIndex + 1], chainB[rightIndex]]
        leftIndex += 1
      } else {
        triangle = [chainA[leftIndex], chainB[rightIndex], chainB[rightIndex + 1]]
        rightIndex += 1
      }
    }

    if (triangle[0] !== triangle[1] && triangle[1] !== triangle[2] && triangle[2] !== triangle[0]) {
      triangles.push(orientTriangleToNormal(triangle, positions, normal))
    }
  }

  return triangles
}

function getBridgeAndFillCandidate(geometry, selectedVertexIndices = []) {
  if (!geometry?.index || selectedVertexIndices.length < 4) {
    return null
  }

  const selectedVertexSet = new Set(selectedVertexIndices)
  const { loops } = getOrCreateBoundaryCache(geometry)
  let bestCandidate = null

  loops.forEach(loop => {
    const groups = getSelectedBoundaryGroups(loop, selectedVertexSet)
      .filter(group => group.length >= 2)

    if (groups.length !== 2) {
      return
    }

    const score = groups[0].length + groups[1].length
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {
        loop,
        groups,
        score
      }
    }
  })

  return bestCandidate
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

function getBoundaryEdgeRecords(indices = []) {
  const edgeRecords = new Map()

  for (let faceIndex = 0; faceIndex < indices.length / 3; faceIndex += 1) {
    const a = indices[faceIndex * 3]
    const b = indices[faceIndex * 3 + 1]
    const c = indices[faceIndex * 3 + 2]

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

function getOrCreateBoundaryCache(geometry) {
  if (!geometry?.index) {
    return { boundaryEdges: [], loops: [], boundaryEdgeMap: new Map() }
  }

  if (geometry.userData?.meshEditorBoundaryCache) {
    return geometry.userData.meshEditorBoundaryCache
  }

  const boundaryEdges = getBoundaryEdgeRecords(geometry.index.array)
  const cache = {
    boundaryEdges,
    loops: buildLoopsFromBoundaryEdges(boundaryEdges),
    boundaryEdgeMap: new Map(boundaryEdges.map(edge => [edge.key, edge]))
  }

  geometry.userData.meshEditorBoundaryCache = cache
  return cache
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
  if (!geometry?.index?.count) {
    return []
  }

  return getOrCreateBoundaryCache(geometry).loops
}

export function getSelectedHoleLoops(geometry, { selectionMode = 'face', selectedFaceIndices = [], selectedVertexIndices = [] } = {}) {
  if (!geometry?.index?.count) {
    return []
  }

  const { boundaryEdgeMap, loops } = getOrCreateBoundaryCache(geometry)

  if (selectionMode === 'vertex') {
    const selectedVertexSet = new Set(selectedVertexIndices)
    return loops.filter(loop => loop.some(vertexIndex => selectedVertexSet.has(vertexIndex)))
  }

  const selectedFaceSet = new Set(selectedFaceIndices)

  return loops.filter(loop => loop.some((vertexIndex, index) => {
    const nextVertex = loop[(index + 1) % loop.length]
    const edgeKey = vertexIndex < nextVertex ? `${vertexIndex}:${nextVertex}` : `${nextVertex}:${vertexIndex}`
    const edge = boundaryEdgeMap.get(edgeKey)
    return edge?.faceIndices?.some(faceIndex => selectedFaceSet.has(faceIndex))
  }))
}

export async function loadEditableGeometryFromUrl(url) {
  const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  console.log('[meshEditor] loadEditableGeometryFromUrl:start', { url })
  const geometry = await loadGeometryFromUrl(url)
  const geometryLoadedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  const indexedGeometry = loadEditableGeometryFromObject(geometry)
  const compactedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  console.log('[meshEditor] loadEditableGeometryFromUrl:done', {
    url,
    loadMs: Math.round((geometryLoadedAt - startedAt) * 10) / 10,
    compactMs: Math.round((compactedAt - geometryLoadedAt) * 10) / 10,
    totalMs: Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt) * 10) / 10,
    vertexCount: indexedGeometry?.attributes?.position?.count || 0,
    faceCount: indexedGeometry?.index?.count ? indexedGeometry.index.count / 3 : 0
  })
  return indexedGeometry
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
  if (!geometry?.attributes?.position || !geometry?.index || selectedVertexIndices.length === 0) {
    return geometry?.clone?.() || geometry
  }

  const positionAttribute = geometry.attributes.position
  const positions = positionAttribute.array
  const indices = geometry.index.array
  const neighbors = buildNeighborMap(indices)
  let minVertexIndex = Number.POSITIVE_INFINITY
  let maxVertexIndex = Number.NEGATIVE_INFINITY

  selectedVertexIndices.forEach(vertexIndex => {
    const adjacent = [...(neighbors.get(vertexIndex) || [])]
    if (adjacent.length === 0) {
      return
    }

    const average = new THREE.Vector3()
    adjacent.forEach(neighborIndex => {
      average.add(new THREE.Vector3(
        positions[neighborIndex * 3],
        positions[neighborIndex * 3 + 1],
        positions[neighborIndex * 3 + 2]
      ))
    })
    average.multiplyScalar(1 / adjacent.length)

    const current = new THREE.Vector3(
      positions[vertexIndex * 3],
      positions[vertexIndex * 3 + 1],
      positions[vertexIndex * 3 + 2]
    ).lerp(average, strength)

    positions[vertexIndex * 3] = current.x
    positions[vertexIndex * 3 + 1] = current.y
    positions[vertexIndex * 3 + 2] = current.z
    minVertexIndex = Math.min(minVertexIndex, vertexIndex)
    maxVertexIndex = Math.max(maxVertexIndex, vertexIndex)
  })

  if (Number.isFinite(minVertexIndex) && Number.isFinite(maxVertexIndex)) {
    markAttributeUpdateRange(positionAttribute, minVertexIndex * 3, (maxVertexIndex - minVertexIndex + 1) * 3)
  } else {
    positionAttribute.needsUpdate = true
  }

  recomputeVertexNormalsLocally(geometry, selectedVertexIndices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  refitSpatialIndex(geometry)
  return geometry
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
  const nextIndices = [...meshData.indices]

  holeLoops.forEach(loop => {
    if (!Array.isArray(loop) || loop.length < 3) {
      return
    }

    const triangles = triangulateHoleLoop(loop, meshData.positions)
    const safeTriangles = triangles.length > 0 ? triangles : triangulateHoleLoopFallback(loop)
    safeTriangles.forEach(triangle => nextIndices.push(...triangle))
  })

  return replaceGeometryData(geometry, meshData.positions, nextIndices)
}

export function bridgeSelectedHoleSegments(geometry, selectedVertexIndices = []) {
  const candidate = getBridgeAndFillCandidate(geometry, selectedVertexIndices)
  if (!candidate) {
    return {
      geometry,
      applied: false,
      holeLoops: []
    }
  }

  const meshData = geometryToMeshData(geometry)
  const loopNormal = computeLoopNormal(candidate.loop, meshData.positions)
  const chainA = candidate.groups[0]
  const chainB = alignBridgeChains(candidate.groups[0], candidate.groups[1], meshData.positions)
  const bridgeTriangles = buildBridgeTriangles(chainA, chainB, meshData.positions, loopNormal)

  if (bridgeTriangles.length === 0) {
    return {
      geometry,
      applied: false,
      holeLoops: []
    }
  }

  const nextIndices = [...meshData.indices]
  bridgeTriangles.forEach(triangle => nextIndices.push(...triangle))
  replaceGeometryData(geometry, meshData.positions, nextIndices)

  return {
    geometry,
    applied: true,
    holeLoops: getSelectedHoleLoops(geometry, {
      selectionMode: 'vertex',
      selectedVertexIndices
    })
  }
}

export function bridgeAndFillSelectedHole(geometry, selectedVertexIndices = []) {
  const bridgeResult = bridgeSelectedHoleSegments(geometry, selectedVertexIndices)
  if (!bridgeResult.applied) {
    return {
      geometry,
      applied: false
    }
  }

  const reducedLoops = bridgeResult.holeLoops

  if (reducedLoops.length > 0) {
    fillHoleLoops(geometry, reducedLoops)
  }

  return {
    geometry,
    applied: true
  }
}

export function getFaceSelectionGeometry(geometry, selectedFaceIndices = []) {
  if (!geometry?.attributes?.position || !geometry?.index || selectedFaceIndices.length === 0) {
    return new THREE.BufferGeometry()
  }

  const sourcePositions = geometry.attributes.position.array
  const indices = geometry.index.array
  const positions = new Float32Array(selectedFaceIndices.length * 9)
  let writeOffset = 0

  selectedFaceIndices.forEach(faceIndex => {
    const faceOffset = faceIndex * 3

    for (let cornerIndex = 0; cornerIndex < 3; cornerIndex += 1) {
      const vertexIndex = indices[faceOffset + cornerIndex] * 3
      positions[writeOffset] = sourcePositions[vertexIndex]
      positions[writeOffset + 1] = sourcePositions[vertexIndex + 1]
      positions[writeOffset + 2] = sourcePositions[vertexIndex + 2]
      writeOffset += 3
    }
  })

  const selectionGeometry = new THREE.BufferGeometry()
  selectionGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  selectionGeometry.computeVertexNormals()
  return selectionGeometry
}

export function getVertexSelectionPositions(geometry, selectedVertexIndices = []) {
  const positionAttribute = geometry?.attributes?.position
  if (!positionAttribute) {
    return []
  }

  const sourcePositions = positionAttribute.array
  const positions = new Float32Array(selectedVertexIndices.length * 3)

  selectedVertexIndices.forEach((vertexIndex, selectionIndex) => {
    const sourceOffset = vertexIndex * 3
    const targetOffset = selectionIndex * 3
    positions[targetOffset] = sourcePositions[sourceOffset]
    positions[targetOffset + 1] = sourcePositions[sourceOffset + 1]
    positions[targetOffset + 2] = sourcePositions[sourceOffset + 2]
  })

  return positions
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
    const dx = positionAttribute.getX(vertexIndex) - point.x
    const dy = positionAttribute.getY(vertexIndex) - point.y
    const dz = positionAttribute.getZ(vertexIndex) - point.z
    const distance = dx * dx + dy * dy + dz * dz
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

export function exportGeometryToGlb(geometry) {
  return new Promise((resolve, reject) => {
    if (!geometry) {
      reject(new Error('Geometry is required to export a GLB mesh.'))
      return
    }

    const exporter = new GLTFExporter()
    const exportMesh = new THREE.Mesh(
      geometry.clone(),
      new THREE.MeshStandardMaterial({ color: '#cfd8ff', metalness: 0.08, roughness: 0.62 })
    )
    exportMesh.name = 'MeshEditorResult'

    exporter.parse(
      exportMesh,
      result => {
        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('Failed to export the mesh as a binary GLB file.'))
          return
        }

        resolve(result)
      },
      error => {
        reject(error instanceof Error ? error : new Error('Failed to export the mesh as GLB.'))
      },
      {
        binary: true,
        onlyVisible: false
      }
    )
  })
}
