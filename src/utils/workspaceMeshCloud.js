// Workspace → Mesh module: the cloud mesh APIs (Tripo AI, Hitem3D, Tencent
// Cloud Hunyuan3D). Each is described as data — its controls, defaults and how
// they become the /api/meshes/generate body — so the panel renders them all with
// one set of Workspace fields.
//
// These APIs are asynchronous: /api/meshes/generate answers with a task / job
// id, and /api/meshes/generate/<provider>/result is polled until the mesh is
// ready (see useWorkspaceCloudTasks).

export const CLOUD_MESH_MODELS = [
  {
    id: 'tripo',
    api: 'tripo_meshgeneration',
    label: 'Tripo AI',
    provider: 'Tripo AI',
    tabs: ['single', 'multiview'],
    resultPath: '/meshes/generate/tripo/result',
    hasKey: settings => Boolean(String(settings?.apis?.tripoai?.apiKey || '').trim()),
    keyHint: 'Tripo AI API key'
  },
  {
    id: 'hitem',
    api: 'hitem_meshgeneration',
    label: 'Hitem3D',
    provider: 'Hitem3D',
    tabs: ['single', 'multiview'],
    resultPath: '/meshes/generate/hitem/result',
    hasKey: settings => Boolean(String(settings?.apis?.hitem3d?.accessKey || '').trim()
      && String(settings?.apis?.hitem3d?.secretKey || '').trim()),
    keyHint: 'Hitem3D Access Key and Secret Key'
  },
  {
    id: 'tencent',
    api: 'tencent_meshgeneration',
    label: 'Hunyuan3D Pro (Tencent Cloud)',
    provider: 'Tencent Cloud',
    tabs: ['single'],
    resultPath: '/meshes/generate/tencent/result',
    hasKey: settings => Boolean(String(settings?.apis?.tencentcloud?.secretId || '').trim()
      && String(settings?.apis?.tencentcloud?.secretKey || '').trim()),
    keyHint: 'Tencent Cloud Secret Id and Secret Key'
  }
]

const CLOUD_VALUE_PREFIX = 'api:'

export function cloudMeshValue(model) {
  return `${CLOUD_VALUE_PREFIX}${model.id}`
}

export function findCloudMeshModel(value) {
  const text = String(value || '')
  if (!text.startsWith(CLOUD_VALUE_PREFIX)) return null
  return CLOUD_MESH_MODELS.find(model => model.id === text.slice(CLOUD_VALUE_PREFIX.length)) || null
}

export function cloudMeshModelsForTab(tab) {
  return CLOUD_MESH_MODELS.filter(model => model.tabs.includes(tab))
}

const TRIPO_P_SERIES = ['P1-20260311', 'P2-20260801']

function isTripoPSeries(options) {
  return TRIPO_P_SERIES.includes(options?.modelVersion)
}

const HITEM_RESOLUTIONS = {
  'hitem3dv1.5': ['512', '1024', '1536', '1536pro'],
  'hitem3dv2.0': ['512', '1024', '1536', '1536pro'],
  'hitem3dv2.1': ['1536fast', '1536pro'],
  'hi3dv3.0': ['2048quality', '2048master']
}

// The first options every provider starts from.
export const CLOUD_MESH_DEFAULTS = {
  tripo: {
    modelVersion: 'v3.1-20260211',
    faces: null, // adaptive
    texture: true,
    pbr: true,
    textureQuality: 'standard',
    geometryQuality: 'standard',
    textureAlignment: 'original_image',
    orientation: 'default',
    smartLowPoly: false,
    quad: false,
    autoSize: false,
    enableImageAutofix: false,
    exportUv: true
  },
  hitem: {
    hitemModel: 'hitem3dv2.1',
    hitemResolution: '1536pro',
    faces: 300000,
    texture: true,
    pbr: false
  },
  tencent: {
    region: 'eu-frankfurt',
    modelVersion: '3.0',
    generationType: 'Normal',
    polygonType: 'triangle',
    faces: 500000,
    pbr: false
  }
}

// Face-count chips per provider (and per Tripo series): every value is inside
// the range that provider accepts. `null` = let the provider decide.
export function cloudFacePresets(model, options) {
  if (model.id === 'tripo') {
    if (options?.modelVersion === 'P1-20260311') return [null, 2000, 5000, 10000, 20000]
    if (options?.modelVersion === 'P2-20260801') return [null, 5000, 10000, 25000, 50000]
    return [null, 10000, 50000, 200000, 500000]
  }
  if (model.id === 'hitem') return [100000, 300000, 500000, 1000000, 2000000]
  return [50000, 100000, 300000, 500000, 1000000]
}

export function cloudFaceRange(model, options) {
  if (model.id === 'tripo') {
    if (options?.modelVersion === 'P1-20260311') return { min: 50, max: 20000 }
    if (options?.modelVersion === 'P2-20260801') return { min: 48, max: 50000 }
    return { min: 1000, max: 1500000 }
  }
  if (model.id === 'hitem') return { min: 100000, max: 2000000 }
  return { min: 3000, max: 1500000 }
}

// Whether the provider takes a seed, and whether it has a texture on/off.
export function cloudSupports(model, options) {
  return {
    seed: model.id === 'tripo',
    texture: model.id !== 'tencent',
    pbr: model.id !== 'hitem' || options?.hitemModel !== 'hitem3dv1.5'
  }
}

// The provider-specific settings, shown as Workspace fields. Each entry:
// { key, label, kind: 'select' | 'switch', options?, show?(options, tab) }.
export function cloudMeshFields(model, options, tab) {
  if (model.id === 'tripo') {
    const pSeries = isTripoPSeries(options)
    return {
      main: [
        {
          key: 'modelVersion',
          label: 'Model',
          kind: 'select',
          options: [
            { value: 'v3.1-20260211', label: 'v3.1 — best quality' },
            { value: 'v3.0-20250812', label: 'v3.0' },
            { value: 'P1-20260311', label: 'P1 — low poly, clean topology' },
            { value: 'P2-20260801', label: 'P2 — low poly, quads' }
          ]
        }
      ],
      advanced: [
        { key: 'textureQuality', label: 'Texture Quality', kind: 'select', options: ['standard', 'detailed', 'extreme'] },
        ...(pSeries ? [] : [
          { key: 'geometryQuality', label: 'Geometry Quality', kind: 'select', options: ['standard', 'detailed'] },
          { key: 'smartLowPoly', label: 'Smart Low Poly', kind: 'switch' },
          { key: 'quad', label: 'Quad Mesh', kind: 'switch' },
          { key: 'textureAlignment', label: 'Texture Alignment', kind: 'select', options: ['original_image', 'geometry'] },
          { key: 'orientation', label: 'Orientation', kind: 'select', options: ['default', 'align_image'] },
          ...(tab === 'single' ? [{ key: 'enableImageAutofix', label: 'Image Autofix', kind: 'switch' }] : [])
        ]),
        { key: 'autoSize', label: 'Real-world Size (metres)', kind: 'switch' },
        { key: 'exportUv', label: 'Export UVs', kind: 'switch' }
      ]
    }
  }

  if (model.id === 'hitem') {
    const resolutions = HITEM_RESOLUTIONS[options?.hitemModel] || HITEM_RESOLUTIONS['hitem3dv2.1']
    return {
      main: [
        {
          key: 'hitemModel',
          label: 'Model',
          kind: 'select',
          options: [
            { value: 'hi3dv3.0', label: 'Hi3D v3.0' },
            { value: 'hitem3dv2.1', label: 'Hitem3D v2.1' },
            { value: 'hitem3dv2.0', label: 'Hitem3D v2.0' },
            { value: 'hitem3dv1.5', label: 'Hitem3D v1.5' }
          ]
        },
        { key: 'hitemResolution', label: 'Resolution', kind: 'select', options: resolutions }
      ],
      advanced: []
    }
  }

  return {
    main: [
      { key: 'modelVersion', label: 'Model', kind: 'select', options: ['3.0', '3.1'] },
      {
        key: 'generationType',
        label: 'Generation Type',
        kind: 'select',
        options: [
          { value: 'Normal', label: 'Textured' },
          { value: 'Geometry', label: 'Geometry only' },
          ...(options?.modelVersion === '3.0' ? [{ value: 'LowPoly', label: 'Low Poly' }] : [])
        ]
      },
      ...(options?.generationType === 'LowPoly'
        ? [{ key: 'polygonType', label: 'Polygons', kind: 'select', options: [{ value: 'triangle', label: 'Triangles' }, { value: 'quadrilaterial', label: 'Quads' }] }]
        : [])
    ],
    advanced: [
      { key: 'region', label: 'Region', kind: 'select', options: ['eu-frankfurt', 'ap-singapore', 'na-siliconvalley'] }
    ]
  }
}

// Keep dependent options valid after a change (a model switch can remove the
// chosen resolution, or Low Poly).
export function normalizeCloudOptions(model, options) {
  const next = { ...options }
  if (model.id === 'hitem') {
    const resolutions = HITEM_RESOLUTIONS[next.hitemModel] || HITEM_RESOLUTIONS['hitem3dv2.1']
    if (!resolutions.includes(next.hitemResolution)) next.hitemResolution = resolutions[resolutions.length - 1]
  }
  if (model.id === 'tencent' && next.generationType === 'LowPoly' && next.modelVersion !== '3.0') {
    next.generationType = 'Normal'
  }
  if (next.faces != null) {
    const { min, max } = cloudFaceRange(model, next)
    if (next.faces < min || next.faces > max) {
      const presets = cloudFacePresets(model, next)
      next.faces = presets.find(value => value != null && value >= min && value <= max) ?? null
    }
  }
  return next
}

// The /api/meshes/generate body for these options. `views` (multi-view) maps
// front/left/back/right to image source references; `imageSource` is the single
// image's.
export function buildCloudMeshRequest(model, options, { projectId, name, imageSource, views, seed }) {
  const body = {
    projectId,
    selectedApi: model.api,
    name,
    detachedAsset: true,
    ...(views ? { imageViews: views } : { imageSource })
  }

  if (model.id === 'tripo') {
    const pSeries = isTripoPSeries(options)
    return {
      ...body,
      modelVersion: options.modelVersion,
      faceLimit: options.faces ?? '',
      texture: options.texture,
      pbr: options.texture && options.pbr,
      textureQuality: options.textureQuality,
      autoSize: options.autoSize,
      exportUv: options.exportUv,
      modelSeed: seed ?? '',
      ...(pSeries ? {} : {
        geometryQuality: options.geometryQuality,
        smartLowPoly: options.smartLowPoly,
        quad: options.quad,
        textureAlignment: options.textureAlignment,
        orientation: options.orientation,
        enableImageAutofix: views ? false : options.enableImageAutofix
      })
    }
  }

  if (model.id === 'hitem') {
    return {
      ...body,
      hitemModel: options.hitemModel,
      hitemResolution: options.hitemResolution,
      hitemRequestType: options.texture ? 3 : 1,
      hitemFace: options.faces,
      hitemPbr: options.texture && options.pbr
    }
  }

  return {
    ...body,
    region: options.region,
    modelVersion: options.modelVersion,
    generationType: options.generationType,
    polygonType: options.polygonType,
    faceCount: options.faces,
    enablePBR: options.generationType !== 'Geometry' && options.pbr
  }
}

// The task to poll, from the 202 answer of /api/meshes/generate.
export function cloudTaskFromSubmit(model, response, extra = {}) {
  const id = response?.taskId || response?.jobId
  if (!id) throw new Error(`${model.label} did not return a task id`)
  return {
    id: `cloud-${model.id}-${id}`,
    modelId: model.id,
    taskId: response.taskId || null,
    jobId: response.jobId || null,
    region: response.region || null,
    createdAt: Date.now(),
    ...extra
  }
}

// The body of one result query for a tracked task.
export function buildCloudResultRequest(task, projectId) {
  const model = CLOUD_MESH_MODELS.find(entry => entry.id === task.modelId)
  if (!model) return null
  return {
    path: model.resultPath,
    body: {
      projectId,
      name: task.name,
      selectedApi: model.api,
      detachedAsset: true,
      ...(task.jobId ? { jobId: task.jobId, region: task.region } : { taskId: task.taskId })
    }
  }
}

export function formatCloudFaces(value) {
  if (value == null) return 'Auto'
  if (value >= 1000000) return `${Math.round(value / 100000) / 10}M`
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}
