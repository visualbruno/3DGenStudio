import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg'

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

  if (!geometry.index && geometry.attributes?.position?.count) {
    const vertexCount = geometry.attributes.position.count
    const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array
    const indices = new IndexArray(vertexCount)
    for (let index = 0; index < vertexCount; index += 1) {
      indices[index] = index
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
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

// Rebuild an attribute as a plain, de-interleaved, non-normalized Float32 array.
// Reading via getX/…/getW denormalizes normalized integer attributes and resolves
// interleaved buffers, so the resulting attribute holds real float values.
function toFloat32Attribute(attribute) {
  const { itemSize, count } = attribute
  const array = new Float32Array(count * itemSize)
  const getters = ['getX', 'getY', 'getZ', 'getW']
  for (let i = 0; i < count; i += 1) {
    for (let component = 0; component < itemSize; component += 1) {
      array[i * itemSize + component] = attribute[getters[component]](i)
    }
  }
  return new THREE.BufferAttribute(array, itemSize)
}

// gltfpack (and other exporters) store vertex data with KHR_mesh_quantization:
// attributes become normalized integers whose real scale lives in the node
// transform, and are often interleaved. THREE renders these correctly, but
// reading the raw typed array or calling applyMatrix4 on a still-`normalized`
// integer attribute corrupts the geometry — applyMatrix4 writes float world
// coordinates back into the int array while the normalized flag stays set,
// collapsing the whole mesh to a speck (it then loads without error but is
// invisible in the editor). Convert everything we read to plain Float32 first.
function dequantizeGeometryAttributes(geometry) {
  const names = ['position', 'normal', 'tangent', 'uv', 'uv1', 'uv2', 'color']
  names.forEach(name => {
    const attribute = geometry.attributes[name]
    if (!attribute) {
      return
    }
    if (attribute.isInterleavedBufferAttribute || attribute.normalized || !(attribute.array instanceof Float32Array)) {
      geometry.setAttribute(name, toFloat32Attribute(attribute))
    }
  })
  return geometry
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
    dequantizeGeometryAttributes(geometry)
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

  return finalizeGeometry(weldedGeometry)
}

export function loadEditableGeometryFromObject(object) {
  const geometry = createMergedGeometryFromObject(object)
  const { positions, indices, uvs } = compactMeshData(geometryToMeshData(geometry))
  return createIndexedGeometry(positions, indices, uvs)
}

// Parse an in-memory GLB (ArrayBuffer) into an editable BufferGeometry without
// going through a URL. Used for results returned by the Python mesh-tools
// service (Auto UV / Auto Retopo), which arrive as binary blobs with no
// file extension for the URL-based loaders to key off.
export function loadEditableGeometryFromGlbBuffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      new GLTFLoader().parse(
        arrayBuffer,
        '',
        gltf => {
          const scene = gltf?.scene || (Array.isArray(gltf?.scenes) ? gltf.scenes[0] : null)
          if (!scene) {
            reject(new Error('The returned mesh did not contain a scene.'))
            return
          }
          try {
            resolve(loadEditableGeometryFromObject(scene))
          } catch (err) {
            reject(err instanceof Error ? err : new Error('Failed to read the returned mesh geometry.'))
          }
        },
        error => reject(error instanceof Error ? error : new Error('Failed to parse the returned GLB mesh.')),
      )
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to parse the returned GLB mesh.'))
    }
  })
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

function createIndexedGeometry(positions = [], indices = [], uvs = null) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))

  if (Array.isArray(uvs) && uvs.length === (positions.length / 3) * 2) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  }

  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return finalizeGeometry(geometry)
}

function createIndexBuffer(indices = [], vertexCount = 0) {
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array
  return new THREE.BufferAttribute(new IndexArray(indices), 1)
}

function replaceGeometryData(geometry, positions = [], indices = [], uvs = null) {
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))

  if (Array.isArray(uvs) && uvs.length === (positions.length / 3) * 2) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2))
  } else {
    geometry.deleteAttribute('uv')
  }

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
    return { positions: [], indices: [], uvs: null }
  }

  const positions = Array.from(geometry.attributes.position.array)
  const indices = geometry.index
    ? Array.from(geometry.index.array)
    : Array.from({ length: positions.length / 3 }, (_, index) => index)
  const uvAttribute = geometry.attributes.uv
  const uvs = uvAttribute?.array?.length === (positions.length / 3) * 2
    ? Array.from(uvAttribute.array)
    : null

  return { positions, indices, uvs }
}

function compactMeshData({ positions = [], indices = [], uvs = null }) {
  const usedVertices = [...new Set(indices)]
  const nextPositions = []
  const nextUvs = Array.isArray(uvs) ? [] : null
  const remap = new Map()

  usedVertices.forEach((vertexIndex, nextIndex) => {
    remap.set(vertexIndex, nextIndex)
    nextPositions.push(
      positions[vertexIndex * 3],
      positions[vertexIndex * 3 + 1],
      positions[vertexIndex * 3 + 2]
    )

    if (nextUvs) {
      nextUvs.push(
        uvs[vertexIndex * 2],
        uvs[vertexIndex * 2 + 1]
      )
    }
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

  return { positions: nextPositions, indices: nextIndices, uvs: nextUvs }
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
  const geometry = await loadGeometryFromUrl(url)
  const indexedGeometry = loadEditableGeometryFromObject(geometry)
  return indexedGeometry
}

export function geometryFaceCount(geometry) {
  return geometry?.index ? geometry.index.count / 3 : 0
}

// Fast client-side watertightness test that mirrors trimesh's `is_watertight`:
// weld vertices by position, then require every edge to be shared by exactly two
// faces (no boundary edges with count 1, no non-manifold edges with count > 2).
//
// The editable geometry is welded with mergeVertices(1e-5), but that also splits
// vertices along normal/UV seams, which would report false boundaries. So we
// re-weld by quantized position only, independent of the index attribute, to
// match how the Python service (trimesh) evaluates topology.
// Weld vertices by quantized position onto a mesh-scaled grid so coincident
// vertices collapse to one canonical id regardless of float noise or the
// normal/UV seams that split the editable index. Returns a per-vertex id array
// indexed like geometry.attributes.position. Shared by the watertight check and
// the non-manifold cleaner so both agree on which corners are the "same point".
function buildCanonicalVertexIds(geometry) {
  const positions = geometry.attributes.position.array
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  const diag = box
    ? Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    : 1
  const tol = Math.max(diag * 1e-6, 1e-9)
  const invTol = 1 / tol

  const canonicalByKey = new Map()
  const vertexCount = positions.length / 3
  const canonicalOfVertex = new Int32Array(vertexCount)
  for (let v = 0; v < vertexCount; v += 1) {
    const kx = Math.round(positions[v * 3] * invTol)
    const ky = Math.round(positions[v * 3 + 1] * invTol)
    const kz = Math.round(positions[v * 3 + 2] * invTol)
    const key = `${kx}:${ky}:${kz}`
    let id = canonicalByKey.get(key)
    if (id === undefined) {
      id = canonicalByKey.size
      canonicalByKey.set(key, id)
    }
    canonicalOfVertex[v] = id
  }
  return canonicalOfVertex
}

export function getGeometryWatertight(geometry) {
  if (!geometry?.index?.count || !geometry.attributes?.position) {
    return null
  }

  const indices = geometry.index.array
  const canonicalOfVertex = buildCanonicalVertexIds(geometry)

  const edgeCounts = new Map()
  const faceCount = indices.length / 3
  for (let f = 0; f < faceCount; f += 1) {
    const a = canonicalOfVertex[indices[f * 3]]
    const b = canonicalOfVertex[indices[f * 3 + 1]]
    const c = canonicalOfVertex[indices[f * 3 + 2]]
    const edges = [[a, b], [b, c], [c, a]]
    for (let e = 0; e < 3; e += 1) {
      const [s, t] = edges[e]
      if (s === t) continue // degenerate edge
      const key = s < t ? `${s}:${t}` : `${t}:${s}`
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1)
    }
  }

  let boundaryEdges = 0
  let nonManifoldEdges = 0
  edgeCounts.forEach(count => {
    if (count === 1) boundaryEdges += 1
    else if (count > 2) nonManifoldEdges += 1
  })

  return {
    watertight: faceCount > 0 && boundaryEdges === 0 && nonManifoldEdges === 0,
    boundaryEdges,
    nonManifoldEdges,
  }
}

function resolveBooleanOperation(operation = 'union') {
  const normalized = String(operation || 'union').toLowerCase()

  if (normalized === 'subtract' || normalized === 'substract' || normalized === 'difference') {
    return SUBTRACTION
  }

  if (normalized === 'intersect' || normalized === 'intersection') {
    return INTERSECTION
  }

  return ADDITION
}

function prepareBooleanGeometry(geometry) {
  if (!geometry?.attributes?.position) {
    return null
  }

  const clone = geometry.clone()
  clone.deleteAttribute?.('normal')
  return finalizeGeometry(clone)
}

export function applyBooleanOperation(baseGeometry, operandGeometry, operation = 'union') {
  if (!baseGeometry?.attributes?.position || !operandGeometry?.attributes?.position) {
    throw new Error('Both base and operand geometries are required for Boolean operations.')
  }

  const preparedBase = prepareBooleanGeometry(baseGeometry)
  const preparedOperand = prepareBooleanGeometry(operandGeometry)
  if (!preparedBase || !preparedOperand) {
    throw new Error('Boolean operation failed because one of the geometries is invalid.')
  }

  const evaluator = new Evaluator()
  const baseBrush = new Brush(preparedBase)
  const operandBrush = new Brush(preparedOperand)
  baseBrush.updateMatrixWorld(true)
  operandBrush.updateMatrixWorld(true)

  const csgOperation = resolveBooleanOperation(operation)
  const resultBrush = evaluator.evaluate(baseBrush, operandBrush, csgOperation)
  const rawResultGeometry = resultBrush?.geometry?.clone?.()

  if (!rawResultGeometry) {
    throw new Error('Boolean operation failed to produce geometry.')
  }

  const resultGeometry = rawResultGeometry.index
    ? rawResultGeometry
    : mergeVertices(rawResultGeometry, 1e-5)

  return finalizeGeometry(resultGeometry)
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
  const compacted = compactMeshData({
    positions: meshData.positions,
    indices: nextIndices,
    uvs: meshData.uvs
  })

  return {
    geometry: createIndexedGeometry(compacted.positions, compacted.indices, compacted.uvs),
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
  const nextUvs = meshData.uvs ? [...meshData.uvs] : null
  const selectedSet = new Set(selectedVertexIndices)
  const keepVertex = selectedVertexIndices[0]
  const centroid = new THREE.Vector3()
  const uvCentroid = new THREE.Vector2()

  selectedVertexIndices.forEach(vertexIndex => {
    centroid.add(new THREE.Vector3(
      meshData.positions[vertexIndex * 3],
      meshData.positions[vertexIndex * 3 + 1],
      meshData.positions[vertexIndex * 3 + 2]
    ))

    if (nextUvs) {
      uvCentroid.add(new THREE.Vector2(
        meshData.uvs[vertexIndex * 2],
        meshData.uvs[vertexIndex * 2 + 1]
      ))
    }
  })
  centroid.multiplyScalar(1 / selectedVertexIndices.length)

  if (nextUvs) {
    uvCentroid.multiplyScalar(1 / selectedVertexIndices.length)
  }

  nextPositions[keepVertex * 3] = centroid.x
  nextPositions[keepVertex * 3 + 1] = centroid.y
  nextPositions[keepVertex * 3 + 2] = centroid.z

  if (nextUvs) {
    nextUvs[keepVertex * 2] = uvCentroid.x
    nextUvs[keepVertex * 2 + 1] = uvCentroid.y
  }

  const nextIndices = meshData.indices.map(vertexIndex => (selectedSet.has(vertexIndex) ? keepVertex : vertexIndex))
  const compacted = compactMeshData({ positions: nextPositions, indices: nextIndices, uvs: nextUvs })
  return createIndexedGeometry(compacted.positions, compacted.indices, compacted.uvs)
}

export function subdivideSelectedFaces(geometry, selectedFaceIndices = []) {
  const meshData = geometryToMeshData(geometry)
  const nextPositions = [...meshData.positions]
  const nextUvs = meshData.uvs ? [...meshData.uvs] : null
  const nextIndices = []

  const selectedFaces = new Set(selectedFaceIndices)
  const midpointCache = new Map()

  // ------------------------------------------------------------
  // Build edge -> faces map
  // ------------------------------------------------------------

  const edgeFaces = new Map()

  const addEdgeFace = (a, b, faceIndex) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`

    if (!edgeFaces.has(key)) {
      edgeFaces.set(key, [])
    }

    edgeFaces.get(key).push(faceIndex)
  }

  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    const [a, b, c] = getFace(meshData, faceIndex)

    addEdgeFace(a, b, faceIndex)
    addEdgeFace(b, c, faceIndex)
    addEdgeFace(c, a, faceIndex)
  }

  // ------------------------------------------------------------
  // Expand selection so neighbor faces sharing subdivided edges
  // are also tessellated.
  // ------------------------------------------------------------

  const expandedFaces = new Set(selectedFaces)

  selectedFaces.forEach(faceIndex => {
    const [a, b, c] = getFace(meshData, faceIndex)

    const edges = [
      [a, b],
      [b, c],
      [c, a]
    ]

    edges.forEach(([v0, v1]) => {
      const key = v0 < v1 ? `${v0}:${v1}` : `${v1}:${v0}`

      const neighbors = edgeFaces.get(key) || []

      neighbors.forEach(neighborFace => {
        expandedFaces.add(neighborFace)
      })
    })
  })

  // ------------------------------------------------------------
  // Shared midpoint creation
  // ------------------------------------------------------------

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

    if (nextUvs) {
      nextUvs.push(
        (meshData.uvs[left * 2] + meshData.uvs[right * 2]) / 2,
        (meshData.uvs[left * 2 + 1] + meshData.uvs[right * 2 + 1]) / 2
      )
    }

    midpointCache.set(key, midpointIndex)
    return midpointIndex
  }

  // ------------------------------------------------------------
  // Subdivide — two passes to prevent T-junctions at the boundary
  // of the expanded region.
  //
  // Pass 1: fully subdivide every expanded face (4 sub-triangles).
  //         This populates midpointCache for ALL edges of those faces,
  //         including their outer edges that touch non-expanded faces.
  //
  // Pass 2: for each non-expanded face, check whether any of its edges
  //         already have a midpoint in the cache (meaning its neighbour
  //         was subdivided in pass 1).  If so, stitch that edge so the
  //         face shares the midpoint vertex instead of leaving a
  //         T-junction that becomes a visible hole after deformation.
  // ------------------------------------------------------------

  // Pass 1 — expanded faces
  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    if (!expandedFaces.has(faceIndex)) {
      continue
    }

    const [a, b, c] = getFace(meshData, faceIndex)

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

  // Pass 2 — non-expanded faces: stitch any edges that border a subdivision
  for (let faceIndex = 0; faceIndex < meshData.indices.length / 3; faceIndex += 1) {
    if (expandedFaces.has(faceIndex)) {
      continue
    }

    const [a, b, c] = getFace(meshData, faceIndex)

    const keyAB = a < b ? `${a}:${b}` : `${b}:${a}`
    const keyBC = b < c ? `${b}:${c}` : `${c}:${b}`
    const keyCA = c < a ? `${c}:${a}` : `${a}:${c}`

    const mAB = midpointCache.get(keyAB)
    const mBC = midpointCache.get(keyBC)
    const mCA = midpointCache.get(keyCA)

    const hasAB = mAB !== undefined
    const hasBC = mBC !== undefined
    const hasCA = mCA !== undefined
    const splitCount = (hasAB ? 1 : 0) + (hasBC ? 1 : 0) + (hasCA ? 1 : 0)

    if (splitCount === 0) {
      // No adjacent subdivisions — keep the triangle as-is
      nextIndices.push(a, b, c)
    } else if (splitCount === 1) {
      // One split edge → 2 triangles (preserves winding order)
      if (hasAB) {
        nextIndices.push(a, mAB, c,  mAB, b, c)
      } else if (hasBC) {
        nextIndices.push(a, b, mBC,  a, mBC, c)
      } else {
        // hasCA: mCA is the midpoint of edge c→a
        nextIndices.push(a, b, mCA,  b, c, mCA)
      }
    } else if (splitCount === 2) {
      // Two split edges → 3 triangles; fan from the unsplit corner
      if (!hasCA) {
        // mAB and mBC present; free corner is c
        nextIndices.push(c, a, mAB,  c, mAB, mBC,  mAB, b, mBC)
      } else if (!hasAB) {
        // mBC and mCA present; free corner is a
        nextIndices.push(a, b, mBC,  a, mBC, mCA,  mBC, c, mCA)
      } else {
        // mCA and mAB present; free corner is b
        nextIndices.push(b, c, mCA,  b, mCA, mAB,  mCA, a, mAB)
      }
    } else {
      // All 3 edges split — full 4-way subdivision (rare at the outer boundary,
      // but handle it correctly to avoid any degenerate geometry)
      nextIndices.push(
        a, mAB, mCA,
        mAB, b, mBC,
        mCA, mBC, c,
        mAB, mBC, mCA
      )
    }
  }

  const compacted = compactMeshData({
    positions: nextPositions,
    indices: nextIndices,
    uvs: nextUvs
  })

  return createIndexedGeometry(compacted.positions, compacted.indices, compacted.uvs)
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

  return replaceGeometryData(geometry, meshData.positions, nextIndices, meshData.uvs)
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
  replaceGeometryData(geometry, meshData.positions, nextIndices, meshData.uvs)

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
