// Workspace → Mesh module: which installed ComfyUI workflows turn images into a
// mesh, and which of their parameters the module's controls stand for.
//
// Same approach as workspaceImage.js: no curation, classification by input /
// output types, roles found by parameter NAME ("Target Face Number", "Texture
// Size", "Seed"). Everything no role claims goes under "Advanced".
import { getParameterValueType } from './workspaceImage.js'

const FILE_TYPES = ['image', 'video', 'mesh']

function inputTypes(workflow) {
  return (workflow?.parameters || []).map(getParameterValueType)
}

function outputsMesh(workflow) {
  return (workflow?.outputs || []).some(output => (output.valueType || 'image') === 'mesh')
}

function imageCount(workflow) {
  return inputTypes(workflow).filter(type => type === 'image').length
}

// Image(s) in, mesh out, and no mesh in (that would be texturing / refining an
// existing mesh, which belong to other modules).
function isImageToMesh(workflow) {
  const types = inputTypes(workflow)
  return outputsMesh(workflow) && !types.includes('mesh') && !types.includes('video') && types.includes('image')
}

export function isSingleImageMeshWorkflow(workflow) {
  return isImageToMesh(workflow) && imageCount(workflow) === 1
}

export function isMultiViewMeshWorkflow(workflow) {
  return isImageToMesh(workflow) && imageCount(workflow) >= 2
}

// "Gen TexturedMesh with Trellis2" reads as "Trellis2 · Textured".
export function meshWorkflowLabel(workflow) {
  const name = String(workflow?.name || '').trim()
  const textured = /textured/i.test(name)
  const withUv = /with uv/i.test(name)
  const engine = (name.match(/\bwith\s+(.+)$/i)?.[1] || name)
    .replace(/\s+with\s+uv$/i, '')
    .trim()
  const kind = textured ? 'Textured' : (withUv ? 'Mesh + UV' : 'Mesh only')
  return engine && engine !== name ? `${engine} · ${kind}` : name || `Workflow ${workflow?.id ?? ''}`.trim()
}

export function filterMeshWorkflows(workflows = [], tab) {
  const test = tab === 'multiview' ? isMultiViewMeshWorkflow : isSingleImageMeshWorkflow
  return workflows
    .filter(test)
    .sort((a, b) => meshWorkflowLabel(a).localeCompare(meshWorkflowLabel(b), undefined, { sensitivity: 'base' }))
}

function nameOf(parameter) {
  return String(parameter?.name || '').trim()
}

// The views of a multi-view workflow. Named ones (Front/Left/Right/Back) are
// keyed by that name and laid out in that order; numbered ones ("First
// Image"…, one workflow even spells it "Thrid") are keyed by position, so the
// images picked survive a switch between workflows of either kind.
const VIEW_NAMES = ['front', 'left', 'right', 'back']

function namedView(parameter) {
  const lower = nameOf(parameter).toLowerCase()
  return VIEW_NAMES.find(view => new RegExp(`\\b${view}\\b`).test(lower)) || null
}

export function describeViews(imageParameters = []) {
  const named = imageParameters.every(parameter => namedView(parameter))
  const views = imageParameters.map((parameter, index) => {
    const view = named ? namedView(parameter) : null
    return {
      parameter,
      key: view || `view${index + 1}`,
      label: view
        ? view.charAt(0).toUpperCase() + view.slice(1)
        : (nameOf(parameter).replace(/\s*image\s*$/i, '') || `View ${index + 1}`)
    }
  })
  return named
    ? views.sort((a, b) => VIEW_NAMES.indexOf(a.key) - VIEW_NAMES.indexOf(b.key))
    : views
}

export function resolveMeshRoles(workflow) {
  const parameters = workflow?.parameters || []
  const numbers = parameters.filter(p => getParameterValueType(p) === 'number')

  const faces = numbers.find(p => /face\s*(number|count)|target\s*faces?|^faces$/i.test(nameOf(p))) || null
  const textureSize = numbers.find(p => /texture\s*(size|resolution)/i.test(nameOf(p))) || null
  const seed = numbers.find(p => /seed/i.test(nameOf(p))) || null

  const images = parameters.filter(p => getParameterValueType(p) === 'image')
  const views = describeViews(images)

  const claimed = new Set([faces, textureSize, seed, ...images].filter(Boolean))
  const advanced = parameters.filter(p => !claimed.has(p) && !FILE_TYPES.includes(getParameterValueType(p)))

  return { faces, textureSize, seed, images, views, advanced }
}

export const FACE_PRESETS = [
  { value: 20000, label: '20K' },
  { value: 50000, label: '50K' },
  { value: 100000, label: '100K' },
  { value: 200000, label: '200K' },
  { value: 500000, label: '500K' }
]

export const TEXTURE_SIZES = [1024, 2048, 4096]

export function snapToEnums(parameter, value) {
  const enums = (parameter?.enums || []).map(Number).filter(Number.isFinite)
  if (!enums.length) return value
  return enums.reduce((best, entry) => (Math.abs(entry - value) < Math.abs(best - value) ? entry : best), enums[0])
}

export function formatFaceCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  if (number >= 1000000) return `${Math.round(number / 100000) / 10}M`
  if (number >= 1000) return `${Math.round(number / 100) / 10}K`
  return String(number)
}
