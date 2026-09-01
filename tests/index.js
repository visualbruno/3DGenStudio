import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

const originalCwd = process.cwd()
const originalNow = Date.now
const testRoot = mkdtempSync(path.join(tmpdir(), '3dgen-project-thumbnails-'))

process.chdir(testRoot)
let now = 1_700_000_000_000
Date.now = () => now++

const storage = await import(`../storage.js?thumbnail-test=${now}`)

async function addAsset(projectId, type, name, thumbnailPath, createdAt) {
  return storage.createProjectAsset({
    projectId,
    type,
    name,
    filePath: `data/assets/${type.toLowerCase()}s/${name}`,
    thumbnailPath,
    createdAt,
    detached: true
  })
}

test('listProjects uses mesh thumbnails with an image fallback', async (t) => {
  t.after(() => {
    Date.now = originalNow
    process.chdir(originalCwd)
  })

  const meshProject = await storage.createProject({ name: 'Mesh preferred' })
  await addAsset(meshProject.id, 'Mesh', 'older-mesh.glb', 'data/assets/thumbnails/mesh.webp', 100)
  await addAsset(meshProject.id, 'Image', 'newer-image.png', 'data/assets/thumbnails/newer-image.webp', 300)

  const imageProject = await storage.createProject({ name: 'Images only' })
  await addAsset(imageProject.id, 'Image', 'older-image.png', 'data/assets/thumbnails/older-image.webp', 100)
  await addAsset(imageProject.id, 'Image', 'newest-image.png', 'data/assets/thumbnails/newest-image.webp', 200)

  const emptyProject = await storage.createProject({ name: 'No assets' })
  const projects = await storage.listProjects()
  const byId = new Map(projects.map(project => [project.id, project]))

  await t.test('keeps mesh thumbnail when a newer image exists', () => {
    assert.equal(byId.get(meshProject.id)?.thumbnail, 'thumbnails/mesh.webp')
  })

  await t.test('uses newest image thumbnail when no mesh exists', () => {
    assert.equal(byId.get(imageProject.id)?.thumbnail, 'thumbnails/newest-image.webp')
  })

  await t.test('returns null when no thumbnail assets exist', () => {
    assert.equal(byId.get(emptyProject.id)?.thumbnail, null)
  })
})
