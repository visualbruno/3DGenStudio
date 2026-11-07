// Workspace → Texture module.
//
// Three ways to texture the selected mesh:
//   - Single Image:    a ComfyUI workflow taking the mesh + one image;
//   - Multiple Images: a ComfyUI workflow taking the mesh + several views;
//   - Bake:            transfer the texture of a HIGH-poly mesh onto it — the
//                      Mesh Editor's Blender bake, or a ComfyUI workflow taking
//                      two meshes (e.g. "HighPoly to LowPoly Texturing").
// Workflows are classified by their input / output types, like the Image and
// Mesh modules; the result is always saved as a version of the selected mesh.
// Pure (no browser imports): the built-in bake runs from workspaceBake.js.
import { getParameterValueType } from './workspaceImage.js'
import { describeViews } from './workspaceMesh.js'

function typesOf(workflow) {
  return (workflow?.parameters || []).map(getParameterValueType)
}

function count(types, type) {
  return types.filter(entry => entry === type).length
}

function outputsMesh(workflow) {
  return (workflow?.outputs || []).some(output => (output.valueType || 'image') === 'mesh')
}

function nameOf(parameter) {
  return String(parameter?.name || '').trim()
}

// A workflow that changes the SURFACE colour, not the shape: "Refine Mesh"
// workflows also take a mesh + an image and return a mesh, but rebuild the
// geometry. Told apart by the word "textur" in the workflow or a parameter.
function isTexturing(workflow) {
  return /textur/i.test(String(workflow?.name || ''))
    || (workflow?.parameters || []).some(parameter => /textur/i.test(nameOf(parameter)))
}

export function isSingleImageTextureWorkflow(workflow) {
  const types = typesOf(workflow)
  return outputsMesh(workflow) && !types.includes('video')
    && count(types, 'mesh') === 1 && count(types, 'image') === 1 && isTexturing(workflow)
}

export function isMultiImageTextureWorkflow(workflow) {
  const types = typesOf(workflow)
  return outputsMesh(workflow) && !types.includes('video')
    && count(types, 'mesh') === 1 && count(types, 'image') >= 2 && isTexturing(workflow)
}

export function isBakeWorkflow(workflow) {
  const types = typesOf(workflow)
  return outputsMesh(workflow) && !types.includes('video')
    && count(types, 'mesh') === 2 && count(types, 'image') === 0
}

export function textureWorkflowLabel(workflow) {
  const name = String(workflow?.name || '').trim()
  const stripped = name
    .replace(/^texture\s+mesh(\s+multiview)?\s+with\s+/i, '')
    .replace(/^highpoly\s+to\s+lowpoly\s+texturing\s+with\s+/i, '')
    .replace(/\s+-\s+/g, ' · ')
    .trim()
  return stripped || name || `Workflow ${workflow?.id ?? ''}`.trim()
}

export function filterTextureWorkflows(workflows = [], tab) {
  const test = tab === 'multi' ? isMultiImageTextureWorkflow
    : tab === 'bake' ? isBakeWorkflow
      : isSingleImageTextureWorkflow
  return workflows
    .filter(test)
    .sort((a, b) => textureWorkflowLabel(a).localeCompare(textureWorkflowLabel(b), undefined, { sensitivity: 'base' }))
}

export function resolveTextureRoles(workflow) {
  const parameters = workflow?.parameters || []
  const meshes = parameters.filter(p => getParameterValueType(p) === 'mesh')
  const images = parameters.filter(p => getParameterValueType(p) === 'image')
  const numbers = parameters.filter(p => getParameterValueType(p) === 'number')

  // Bake workflows: which mesh input is the high poly (the detail source) and
  // which the low poly (the one being textured), by name; else in order.
  const high = meshes.find(p => /high/i.test(nameOf(p))) || null
  const low = meshes.find(p => /low/i.test(nameOf(p)) && p !== high) || null
  const bakeHigh = meshes.length === 2 ? (high || meshes[0]) : null
  const bakeLow = meshes.length === 2 ? (low || meshes.find(p => p !== bakeHigh)) : null

  const textureSize = numbers.find(p => /texture\s*(size|resolution)/i.test(nameOf(p))) || null
  const seed = numbers.find(p => /seed/i.test(nameOf(p))) || null

  const claimed = new Set([...meshes, ...images, textureSize, seed].filter(Boolean))
  const advanced = parameters.filter(p => !claimed.has(p) && !['image', 'video', 'mesh'].includes(getParameterValueType(p)))

  return {
    mesh: meshes.length === 1 ? meshes[0] : null,
    bakeHigh,
    bakeLow,
    image: images[0] || null,
    views: describeViews(images),
    textureSize,
    seed,
    advanced
  }
}

export const TEXTURE_SIZE_PRESETS = [1024, 2048, 4096, 8192]
