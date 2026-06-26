// Pure helpers and config constants for the Kanban board page (KanbanPage).
// Extracted from KanbanPage.jsx — no React, no component state.
import { assetUrl } from '../config'

export const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai_gpt_image_1', name: 'OpenAI · gpt-image-1' },
  { id: 'openai_gpt_image_1_5', name: 'OpenAI · gpt-image-1.5' },
]
export const TENCENT_MESH_GENERATION_API_ID = 'tencent_meshgeneration'
export const TRIPO_MESH_GENERATION_API_ID = 'tripo_meshgeneration'
export const TENCENT_MESH_API_OPTION = { id: TENCENT_MESH_GENERATION_API_ID, name: 'Tencent Cloud · Hunyuan3D Pro' }
export const TRIPO_MESH_API_OPTION = { id: TRIPO_MESH_GENERATION_API_ID, name: 'Tripo AI' }
export const TENCENT_REGION_OPTIONS = ['ap-singapore', 'eu-frankfurt', 'na-siliconvalley']
export const TENCENT_MODEL_VERSION_OPTIONS = ['3.0', '3.1']
export const TENCENT_GENERATION_TYPE_OPTIONS = ['Normal', 'LowPoly', 'Geometry']
export const TENCENT_POLYGON_TYPE_OPTIONS = ['triangle', 'quadrilaterial']
export const TRIPO_MODEL_VERSION_OPTIONS = ['v2.0-20240919', 'v2.5-20250123', 'v3.0-20250812', 'v3.1-20260211', 'Turbo-v1.0-20250506', 'P1-20260311']
export const TRIPO_TEXTURE_ALIGNMENT_OPTIONS = ['original_image', 'geometry']
export const TRIPO_TEXTURE_QUALITY_OPTIONS = ['standard', 'detailed']
export const TRIPO_ORIENTATION_OPTIONS = ['default', 'align_image']
export const TRIPO_GEOMETRY_QUALITY_OPTIONS = ['standard', 'detailed']

export const IMAGE_CARD_COLUMNS = [
  { id: 'images', dbId: 1, icon: 'image', title: 'IMAGES' },
  { id: 'imageedit', dbId: 2, icon: 'photo_filter', title: 'IMAGE EDIT', showAttributes: true, emptyLabel: 'Drag an image card here to edit it' },
  { id: 'meshgen', dbId: 3, icon: 'deployed_code', title: 'MESH GEN', showAttributes: true, emptyLabel: 'Drag an image card here to generate a mesh' },
  { id: 'meshedit', dbId: 4, icon: 'edit_square', title: 'MESH EDIT', showAttributes: true, emptyLabel: 'Drag a mesh card here to edit it' },
  { id: 'texturing', dbId: 5, icon: 'texture', title: 'TEXTURING', showAttributes: true, emptyLabel: 'Drag a mesh card here to texture it' },
]

export const DEFAULT_ATTRIBUTE_TYPE_ID = 1
export const DEFAULT_CUSTOM_API_TYPE = 'image-generation'

export function isFileWorkflowValueType(valueType) {
  return ['image', 'video', 'mesh'].includes(valueType)
}

export function getWorkflowFileInputAccept(valueType) {
  if (valueType === 'video') return 'video/*'
  if (valueType === 'mesh') return '.glb,.gltf,.obj,.fbx,.stl,.ply,.usdz,.usd,.usda,.usdc'
  return 'image/*'
}

export function getWorkflowFileInputIcon(valueType) {
  if (valueType === 'video') return 'video_file'
  if (valueType === 'mesh') return 'deployed_code'
  return 'image'
}

export function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit', 'mesh-texturing'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE
}

export function isTencentMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === TENCENT_MESH_GENERATION_API_ID
}

export function isTripoMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === TRIPO_MESH_GENERATION_API_ID
}

export function canFetchTencentMeshResult(runtimeState) {
  return runtimeState?.source === 'Tencent Cloud'
    && runtimeState?.status === 'processing'
    && ['RUN', 'WAIT'].includes(String(runtimeState?.jobStatus || '').toUpperCase())
    && runtimeState?.jobId
    && runtimeState?.region
}

export function canFetchTripoMeshResult(runtimeState) {
  return runtimeState?.source === 'Tripo AI'
    && runtimeState?.status === 'processing'
    && ['queued', 'running'].includes(String(runtimeState?.taskStatus || '').toLowerCase())
    && runtimeState?.taskId
}

// Default values for the provider-specific mesh generation options
// (Tencent Cloud / Tripo AI). Shared by the per-card action draft and the
// "Add New Mesh" draft so the two stay in sync.
export function getMeshGenApiDefaults() {
  return {
    region: 'eu-frankfurt',
    modelVersion: '3.0',
    enablePBR: false,
    faceCount: 500000,
    generationType: 'Normal',
    polygonType: 'triangle',
    modelSeed: '',
    enableImageAutofix: false,
    faceLimit: '',
    texture: true,
    pbr: true,
    textureSeed: '',
    textureAlignment: 'original_image',
    textureQuality: 'standard',
    autoSize: false,
    orientation: 'default',
    quad: false,
    smartLowPoly: false,
    generateParts: false,
    exportUv: true,
    geometryQuality: 'standard'
  }
}

export function getComfyDraftFromWorkflow(workflow) {
  return {
    mode: 'comfy',
    workflowId: workflow?.id || '',
    inputs: Object.fromEntries(
      (workflow?.parameters || []).map(parameter => {
        const valueType = getWorkflowParameterValueType(parameter)
        return [parameter.id, isFileWorkflowValueType(valueType) ? null : (valueType === 'boolean' ? Boolean(parameter.defaultValue ?? false) : (parameter.defaultValue ?? ''))]
      })
    )
  }
}

export function formatWorkflowDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function getWorkflowParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

export function getAssetChildren(asset) {
  return asset?.children || asset?.edits || []
}

export function createImageCardId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `image-card-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

export function createComfyExecutionId(prefix = 'comfy') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

export function buildMeshEditorPath(asset, projectId, returnTo) {
  const query = new URLSearchParams({
    assetId: String(asset?.id || ''),
    filePath: asset?.filePath || asset?.filename || '',
    url: asset?.filename ? assetUrl(asset.filename) : '',
    name: asset?.name || 'Mesh',
    projectId: projectId ? String(projectId) : '',
    returnTo: returnTo || ''
  })

  return `/mesh-editor?${query.toString()}`
}
