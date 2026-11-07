// Workspace → Image module: how an arbitrary installed ComfyUI workflow is
// driven by the module's few friendly controls (prompt, size, number of images).
//
// Workflows are not curated. A workflow is offered for "generate" when it
// outputs an image and takes no file input, and for "edit" when it outputs an
// image and takes at least one image (and nothing but images and scalars). Each
// friendly control is then mapped onto whichever parameter plays that role,
// found by its NAME — the setup.json workflows are consistent about these
// ("Prompt", "Width"/"Height", "Image Resolution", "Number of Images to
// Generate", "Seed"). A role the workflow does not have simply hides its
// control; every parameter no role claimed is shown under "Advanced".

const FILE_TYPES = ['image', 'video', 'mesh']

export const ASPECT_RATIOS = [
  { id: '1:1', w: 1, h: 1 },
  { id: '16:9', w: 16, h: 9 },
  { id: '9:16', w: 9, h: 16 },
  { id: '4:3', w: 4, h: 3 },
  { id: '3:4', w: 3, h: 4 }
]

// Long-side sizes in pixels.
export const SIZE_PRESETS = [
  { value: 512, label: '512' },
  { value: 768, label: '768' },
  { value: 1024, label: '1K' },
  { value: 1536, label: '1.5K' },
  { value: 2048, label: '2K' }
]

export const IMAGE_COUNTS = [1, 2, 3, 4]

export function getParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

function outputTypes(workflow) {
  return (workflow?.outputs || []).map(output => output.valueType || 'image')
}

function inputTypes(workflow) {
  return (workflow?.parameters || []).map(getParameterValueType)
}

export function isImageGenerationWorkflow(workflow) {
  const inputs = inputTypes(workflow)
  return outputTypes(workflow).includes('image')
    && !inputs.some(type => FILE_TYPES.includes(type))
    && inputs.includes('string')
}

export function isImageEditWorkflow(workflow) {
  const inputs = inputTypes(workflow)
  return outputTypes(workflow).includes('image')
    && inputs.includes('image')
    && inputs.every(type => ['image', 'string', 'number', 'boolean'].includes(type))
}

// Mesh Projection workflows take an image but need a render of a mesh (its
// position pass / textured view) beside it. That belongs to the Texture module,
// not to editing a picture, so they are left out of the Image edit list.
const MESH_RENDER_INPUT = /^(position image|textured view)$/i

function needsMeshRender(workflow) {
  return (workflow?.parameters || []).some(parameter =>
    getParameterValueType(parameter) === 'image' && MESH_RENDER_INPUT.test(String(parameter.name || '').trim()))
}

export function filterWorkflowsForMode(workflows = [], mode) {
  const test = mode === 'edit'
    ? workflow => isImageEditWorkflow(workflow) && !needsMeshRender(workflow)
    : isImageGenerationWorkflow
  return workflows
    .filter(test)
    .sort((a, b) => workflowLabel(a).localeCompare(workflowLabel(b), undefined, { sensitivity: 'base' }))
}

// "Gen Image with Flux2Klein9B" reads as "Flux2Klein9B" in a list that is
// already titled Generate / Edit.
export function workflowLabel(workflow) {
  const name = String(workflow?.name || '').trim()
  const stripped = name.replace(/^(gen(erate)?|edit)\s+image\s+(with\s+)?/i, '').trim()
  return stripped || name || `Workflow ${workflow?.id ?? ''}`.trim()
}

function nameOf(parameter) {
  return String(parameter?.name || parameter?.label || '').trim()
}

function findParam(parameters, valueType, pattern, exclude = []) {
  return parameters.find(parameter => getParameterValueType(parameter) === valueType
    && pattern.test(nameOf(parameter))
    && !exclude.includes(parameter)) || null
}

// Which parameter plays each friendly role. Pure: depends on names/types only.
export function resolveWorkflowRoles(workflow) {
  const parameters = workflow?.parameters || []
  const strings = parameters.filter(p => getParameterValueType(p) === 'string')

  const prompt = strings.find(p => /prompt/i.test(nameOf(p)) && !/negative|enhancer/i.test(nameOf(p)))
    || strings.find(p => !Array.isArray(p.enums) || p.enums.length === 0)
    || null

  const width = findParam(parameters, 'number', /^(image\s+)?width$/i)
  const height = findParam(parameters, 'number', /^(image\s+)?height$/i)
  const megapixels = findParam(parameters, 'number', /(m(e|a)ga\s*pixels?|m\s*pixels?)/i)
  const edge = findParam(parameters, 'number', /^(image\s+)?(resolution|size)$|scale\s+to\s+max\s*dim/i)
  const count = findParam(parameters, 'number', /number\s+of\s+images|batch\s+size|^num(ber)?\s+images$/i)
  const seed = findParam(parameters, 'number', /seed/i)

  const images = parameters.filter(p => getParameterValueType(p) === 'image')
  const sourceImage = images.find(p => /source|input/i.test(nameOf(p))) || images[0] || null
  const extraImages = images.filter(p => p !== sourceImage)

  let sizeMode = null
  if (width && height) sizeMode = 'wh'
  else if (edge) sizeMode = 'edge'
  else if (megapixels) sizeMode = 'mp'

  const claimed = new Set([
    prompt, count, sourceImage, ...extraImages,
    ...(sizeMode === 'wh' ? [width, height] : []),
    ...(sizeMode === 'edge' ? [edge] : []),
    ...(sizeMode === 'mp' ? [megapixels] : [])
  ].filter(Boolean))

  const advanced = parameters.filter(p => !claimed.has(p) && !FILE_TYPES.includes(getParameterValueType(p)))

  return { prompt, width, height, edge, megapixels, count, seed, sourceImage, extraImages, sizeMode, advanced }
}

function nearest(values, target) {
  return values.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), values[0])
}

function snapToEnum(parameter, value) {
  const enums = (parameter?.enums || []).map(Number).filter(Number.isFinite)
  return enums.length ? nearest(enums, value) : value
}

function roundTo(value, step) {
  return Math.max(step, Math.round(value / step) * step)
}

// Width/height for a long side and an aspect ratio, on a 16px grid (latent
// models want multiples of 8 or 16).
export function dimensionsFor(size, aspect) {
  const ratio = aspect && aspect.w > 0 && aspect.h > 0 ? aspect.w / aspect.h : 1
  if (ratio >= 1) {
    return { width: roundTo(size, 16), height: roundTo(size / ratio, 16) }
  }
  return { width: roundTo(size * ratio, 16), height: roundTo(size, 16) }
}

// The parameter values the size controls stand for.
export function sizeParameterValues(roles, { size, aspect }) {
  const values = {}
  if (roles.sizeMode === 'wh') {
    const { width, height } = dimensionsFor(size, aspect)
    values[roles.width.id] = snapToEnum(roles.width, width)
    values[roles.height.id] = snapToEnum(roles.height, height)
  } else if (roles.sizeMode === 'edge') {
    values[roles.edge.id] = snapToEnum(roles.edge, size)
  } else if (roles.sizeMode === 'mp') {
    const { width, height } = dimensionsFor(size, aspect)
    values[roles.megapixels.id] = snapToEnum(roles.megapixels, Math.round((width * height) / 1e4) / 100)
  }
  return values
}

// Scalar defaults for every parameter (files start empty).
export function defaultParameterValues(workflow) {
  const values = {}
  for (const parameter of workflow?.parameters || []) {
    const valueType = getParameterValueType(parameter)
    if (FILE_TYPES.includes(valueType)) continue
    values[parameter.id] = valueType === 'boolean'
      ? Boolean(parameter.defaultValue ?? false)
      : (parameter.defaultValue ?? '')
  }
  return values
}

export function randomSeed() {
  return Math.floor(Math.random() * 4294967295)
}

// Coerce a typed field value to what the workflow expects (number inputs hand
// back strings while being edited).
export function coerceParameterValue(parameter, value) {
  if (getParameterValueType(parameter) === 'number') {
    if (value === '' || value === null || value === undefined) return value
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  return value
}

// One run = one ComfyUI prompt. When the workflow has its own image-count
// parameter it makes all the images in one prompt; otherwise the count becomes
// that many prompts, each on its own seed so they differ.
export function planSubmissions({ roles, baseInputs, count, seed }) {
  const total = Math.max(1, Math.min(8, Number(count) || 1))
  if (roles.count || total === 1) {
    return [{
      inputs: {
        ...baseInputs,
        ...(roles.count ? { [roles.count.id]: total } : {}),
        ...(roles.seed && seed != null ? { [roles.seed.id]: seed } : {})
      },
      images: roles.count ? total : 1
    }]
  }
  return Array.from({ length: total }, (_, index) => ({
    inputs: {
      ...baseInputs,
      ...(roles.seed && seed != null ? { [roles.seed.id]: (Number(seed) + index) % 4294967296 } : {})
    },
    images: 1
  }))
}

// --- Cloud image APIs -------------------------------------------------------
// The built-in providers of /api/images/generate and /api/image-edits/api (ids
// match IMAGE_API_LIST and the model keys in Settings). `sizes` is the output
// size choice the model accepts; the original Nano Banana (Gemini 2.5 Flash
// Image) has none, and gpt-image derives its size from the aspect ratio.
// Custom APIs from Settings are not listed: neither route implements them.
export const CLOUD_IMAGE_MODELS = [
  { id: 'nanobana', label: 'Nano Banana', provider: 'google', sizes: null },
  { id: 'nanobana_2', label: 'Nano Banana 2', provider: 'google', sizes: ['1K', '2K', '4K'] },
  { id: 'nanobana_pro', label: 'Nano Banana Pro', provider: 'google', sizes: ['1K', '2K', '4K'] },
  { id: 'openai_gpt_image_1', label: 'GPT Image 1', provider: 'openai', sizes: null },
  { id: 'openai_gpt_image_1_5', label: 'GPT Image 1.5', provider: 'openai', sizes: null },
  { id: 'openai_gpt_image_2', label: 'GPT Image 2', provider: 'openai', sizes: null }
]

export const CLOUD_PROVIDER_NAMES = { google: 'Google', openai: 'OpenAI' }

const CLOUD_VALUE_PREFIX = 'api:'

export function cloudModelValue(model) {
  return `${CLOUD_VALUE_PREFIX}${model.id}`
}

export function findCloudModel(value) {
  const text = String(value || '')
  if (!text.startsWith(CLOUD_VALUE_PREFIX)) return null
  return CLOUD_IMAGE_MODELS.find(model => model.id === text.slice(CLOUD_VALUE_PREFIX.length)) || null
}

export function hasCloudApiKey(model, settings) {
  return Boolean(String(settings?.apis?.[model?.provider]?.apiKey || '').trim())
}

// Ratios the cloud APIs accept, for matching a source image's proportions.
const CLOUD_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

export function nearestCloudAspectRatio(width, height) {
  const target = Math.log(Number(width) / Number(height))
  if (!Number.isFinite(target)) return '1:1'
  return CLOUD_ASPECT_RATIOS.reduce((best, id) => {
    const [w, h] = id.split(':').map(Number)
    const [bw, bh] = best.split(':').map(Number)
    return Math.abs(Math.log(w / h) - target) < Math.abs(Math.log(bw / bh) - target) ? id : best
  }, '1:1')
}

// The pixel size gpt-image will return for a ratio (it only has three).
export function openAiSizeLabel(aspectRatio) {
  const [w, h] = String(aspectRatio || '1:1').split(':').map(Number)
  if (!(w > 0) || !(h > 0) || w === h) return '1024 × 1024'
  return w > h ? '1536 × 1024' : '1024 × 1536'
}
