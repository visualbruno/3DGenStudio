import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import { createAssetEditRecord, getProjectAssetById } from './storage.js';
import fs from 'fs/promises';
import {
  ASSETS_DIR,
  DATA_DIR,
  DEFAULT_SETTINGS,
  WORKFLOW_ASSETS_DIR,
  THUMBNAIL_ASSETS_DIR,
  createProject,
  createLibraryAsset,
  createCardAttribute,
  createProjectAsset,
  createTask,
  createWorkflowRecord,
  deleteCardAttribute,
  deleteAssetById,
  deleteLibraryAssetByFilePath,
  deleteProjectById,
  findLibraryAssetByFilePath,
  getAssetDirectory,
  listAttributeTypes,
  listProjectCardAttributes,
  getProjectById,
  getSettings,
  getWorkflowRecordById,
  initializeStorage,
  listLibraryAssetsByType,
  listProjectAssets,
  listProjectTasks,
  listProjects,
  listWorkflowRecords,
  moveCard,
  renameLibraryAssetByFilePath,
  saveSettings,
  toAbsoluteStoragePath,
  toStoredAssetPath,
  toStoredThumbnailPath,
  updateCardAttribute,
  updateWorkflowRecord
} from './storage.js';

const app = express();
const PORT = 3001;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);

console.log('DEBUG: DATA_DIR is', DATA_DIR);
console.log('DEBUG: DB_FILE is', path.join(DATA_DIR, 'app.db'));

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/assets', express.static(ASSETS_DIR));

// Multer Config for Asset Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const destinationDir = getAssetDirectory(req.body.type || inferAssetTypeFromFilename(file.originalname));
    fs.mkdir(destinationDir, { recursive: true })
      .then(() => cb(null, destinationDir))
      .catch(err => cb(err));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

app.get('/api/library/comfy-workflows', async (req, res) => {
  try {
    const workflowRecords = await listWorkflowRecords();
    const workflows = (await Promise.all(workflowRecords.map(async record => {
      try {
        return await buildWorkflowResponse(record);
      } catch (err) {
        console.warn(`Skipping invalid workflow ${record?.id}:`, err.message);
        return null;
      }
    }))).filter(Boolean);

    res.json(workflows);
  } catch (err) {
    console.error('Failed to list ComfyUI workflows:', err);
    res.status(500).json({ error: 'Failed to list ComfyUI workflows' });
  }
});

app.post('/api/library/comfy-workflows/inspect', async (req, res) => {
  try {
    const { workflowJson } = req.body;
    const parsed = parseComfyWorkflow(workflowJson);
    res.json(parsed);
  } catch (err) {
    console.error('Failed to inspect ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to inspect workflow JSON' });
  }
});

app.post('/api/library/comfy-workflows', async (req, res) => {
  try {
    const { name, workflowJson, parameters = [], outputs = [] } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'A workflow name is required' });
    }

    const parsed = parseComfyWorkflow(workflowJson);
    const availableParameters = new Map(parsed.inputs.map(input => [input.id, input]));
    const availableOutputs = new Map(parsed.outputs.map(output => [output.nodeId, output]));

    const selectedParameters = parameters.map(parameter => {
      const sourceParameter = availableParameters.get(parameter.id);
      if (!sourceParameter) {
        throw new Error(`Unknown workflow parameter: ${parameter.id}`);
      }

      return {
        ...sourceParameter,
        name: sanitizeDisplayName(parameter.name || sourceParameter.name, sourceParameter.name),
        valueType: normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(sourceParameter))
      };
    });

    const selectedOutputs = outputs.map(output => {
      const outputId = String(output.nodeId || output.id);
      const sourceOutput = availableOutputs.get(outputId);
      if (!sourceOutput) {
        throw new Error(`Unknown workflow output: ${outputId}`);
      }

      return {
        ...sourceOutput,
        name: sanitizeDisplayName(output.name || sourceOutput.nodeTitle, sourceOutput.nodeTitle),
        valueType: normalizeComfyValueType(output.valueType, getDefaultComfyValueType(sourceOutput, true))
      };
    });

    if (selectedOutputs.length === 0) {
      return res.status(400).json({ error: 'Select at least one output node to save images from' });
    }

    const filePath = await saveWorkflowFile(name, workflowJson);
    const workflowRecord = await createWorkflowRecord({
      name: sanitizeDisplayName(name, 'Workflow'),
      filePath,
      parameters: selectedParameters,
      outputs: selectedOutputs
    });

    res.status(201).json(await buildWorkflowResponse(workflowRecord));
  } catch (err) {
    console.error('Failed to save ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to save ComfyUI workflow' });
  }
});

app.put('/api/library/comfy-workflows/:id', async (req, res) => {
  try {
    const { name, parameters = [], outputs = [] } = req.body;
    const existingWorkflowRecord = await getWorkflowRecordById(Number(req.params.id));

    if (!existingWorkflowRecord) {
      return res.status(404).json({ error: 'ComfyUI workflow not found' });
    }

    const existingWorkflow = await buildWorkflowResponse(existingWorkflowRecord);
    const availableParameters = new Map((existingWorkflow.availableInputs || []).map(input => [input.id, input]));
    const availableOutputs = new Map((existingWorkflow.availableOutputs || []).map(output => [output.nodeId, output]));

    const nextParameters = parameters.map(parameter => {
      const sourceParameter = availableParameters.get(parameter.id);
      if (!sourceParameter) {
        throw new Error(`Unknown workflow parameter: ${parameter.id}`);
      }

      return {
        ...sourceParameter,
        name: sanitizeDisplayName(parameter.name || sourceParameter.name, sourceParameter.name),
        valueType: normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(sourceParameter))
      };
    });

    const nextOutputs = outputs.map(output => {
      const outputId = String(output.nodeId || output.id);
      const sourceOutput = availableOutputs.get(outputId);
      if (!sourceOutput) {
        throw new Error(`Unknown workflow output: ${outputId}`);
      }

      return {
        ...sourceOutput,
        name: sanitizeDisplayName(output.name || sourceOutput.nodeTitle, sourceOutput.nodeTitle),
        valueType: normalizeComfyValueType(output.valueType, getDefaultComfyValueType(sourceOutput, true))
      };
    });

    if (nextOutputs.length === 0) {
      return res.status(400).json({ error: 'Select at least one output node to save images from' });
    }

    const nextWorkflow = await updateWorkflowRecord(existingWorkflow.id, {
      name: sanitizeDisplayName(name || existingWorkflow.name, existingWorkflow.name),
      parameters: nextParameters,
      outputs: nextOutputs
    });

    res.json(await buildWorkflowResponse(nextWorkflow));
  } catch (err) {
    console.error('Failed to update ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to update ComfyUI workflow' });
  }
});
const upload = multer({ storage });
const workflowExecutionUpload = multer({ storage: multer.memoryStorage() });
const libraryImportUpload = multer({ storage: multer.memoryStorage() });

const INITIAL_SCHEMA = {
  projects: [
    {
      id: 1,
      name: 'Cyberpunk_District_V1',
      description: 'High-fidelity urban environment with neon-lit architecture.',
      preset: 'Photorealistic ArchViz',
      createdAt: Date.now(),
      status: 'active'
    }
  ],
  assets: [],
  tasks: [],
  settings: {
    profile: {
      name: 'User',
      avatar: null
    },
    apis: {
      google: {
        apiKey: '',
        imageGeneration: {
          headerName: 'x-goog-api-key',
          payloadTemplate: {
            contents: [
              {
                parts: [
                  { text: '{prompt}' }
                ]
              }
            ],
			generationConfig: {
			  responseModalities: ['Image']
			}
          },
          models: {
            nanobana: {
              name: 'Nanobanana',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent'
            },
            nanobana_pro: {
              name: 'Nanobanana Pro',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent'
            },
            nanobana_2: {
              name: 'Nanobanana 2',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent'
            }
          }
        }
      },
      openai: { apiKey: '' },
      comfyui: {
        path: '',
        url: 'http://127.0.0.1',
        port: '8188'
      },
      custom: []
    }
  },
  library: {
    comfyWorkflows: []
  }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeDisplayName(value = '', fallback = 'Workflow') {
  const normalized = String(value)
    .trim()
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  return normalized || fallback;
}

function inferComfyParameterType(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value) || isPlainObject(value)) return 'json';
  return 'string';
}

function getDefaultComfyValueType(item, isOutput = false) {
  if (isOutput) return 'image';
  return item?.type === 'number' ? 'number' : 'string';
}

function normalizeComfyValueType(value, fallback = 'string') {
  return ['string', 'number', 'image', 'video'].includes(value) ? value : fallback;
}

function getComfyNodeLabel(nodeId, node = {}) {
  return sanitizeDisplayName(node._meta?.title || node.title || node.class_type || `Node ${nodeId}`, `Node ${nodeId}`);
}

function parseComfyWorkflow(workflowJson) {
  if (!isPlainObject(workflowJson) || Object.keys(workflowJson).length === 0) {
    throw new Error('The workflow JSON is empty or invalid');
  }

  const nodes = Object.entries(workflowJson)
    .filter(([, node]) => isPlainObject(node))
    .map(([nodeId, node]) => [String(nodeId), node]);

  if (nodes.length === 0) {
    throw new Error('The workflow JSON does not contain any nodes');
  }

  const referencedNodeIds = new Set();

  for (const [, node] of nodes) {
    for (const value of Object.values(node.inputs || {})) {
      if (Array.isArray(value) && value.length >= 2 && (typeof value[0] === 'string' || typeof value[0] === 'number')) {
        referencedNodeIds.add(String(value[0]));
      }
    }
  }

  const inputs = [];

  for (const [nodeId, node] of nodes) {
    const nodeLabel = getComfyNodeLabel(nodeId, node);

    for (const [inputKey, value] of Object.entries(node.inputs || {})) {
      const isNodeReference = Array.isArray(value) && value.length >= 2 && (typeof value[0] === 'string' || typeof value[0] === 'number');
      if (isNodeReference || value === null || value === undefined) continue;

      const type = inferComfyParameterType(value);
      if (!['string', 'number', 'boolean', 'json'].includes(type)) continue;

      inputs.push({
        id: `${nodeId}.${inputKey}`,
        nodeId,
        inputKey,
        nodeTitle: nodeLabel,
        classType: node.class_type || 'Unknown',
        name: sanitizeDisplayName(`${nodeLabel} ${inputKey}`, inputKey),
        label: `${nodeLabel} • ${inputKey}`,
        type,
        defaultValue: cloneSerializable(value)
      });
    }
  }

  const outputs = nodes
    .filter(([nodeId]) => !referencedNodeIds.has(nodeId))
    .map(([nodeId, node]) => ({
      id: nodeId,
      nodeId,
      nodeTitle: getComfyNodeLabel(nodeId, node),
      classType: node.class_type || 'Unknown',
      label: `${getComfyNodeLabel(nodeId, node)} • ${node.class_type || 'Output'}`
    }));

  return { inputs, outputs };
}

function buildComfyUiBaseUrl(settings = {}) {
  const comfySettings = settings?.apis?.comfyui || {};
  const rawUrl = String(comfySettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(comfySettings.port || parsedUrl.port || '8188').trim();

  parsedUrl.port = port;
  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().replace(/\/$/, '');
}

function coerceComfyParameterValue(parameter, providedValue) {
  if (providedValue === undefined) return cloneSerializable(parameter.defaultValue);

  switch (parameter.type) {
    case 'number': {
      const numericValue = Number(providedValue);
      return Number.isFinite(numericValue) ? numericValue : Number(parameter.defaultValue || 0);
    }
    case 'boolean':
      if (typeof providedValue === 'boolean') return providedValue;
      if (typeof providedValue === 'string') return providedValue.toLowerCase() === 'true';
      return Boolean(providedValue);
    case 'json':
      if (typeof providedValue === 'string') {
        return JSON.parse(providedValue);
      }
      return cloneSerializable(providedValue);
    case 'string':
    default:
      return String(providedValue);
  }
}

function applyComfyParametersToWorkflow(workflowJson, parameters = [], values = {}) {
  const nextWorkflow = cloneSerializable(workflowJson);

  for (const parameter of parameters) {
    const node = nextWorkflow?.[parameter.nodeId];

    if (!node?.inputs || !(parameter.inputKey in node.inputs)) {
      throw new Error(`Workflow parameter ${parameter.label || parameter.id} is no longer valid`);
    }

    node.inputs[parameter.inputKey] = coerceComfyParameterValue(parameter, values[parameter.id]);
  }

  return nextWorkflow;
}

async function sleep(ms) {
  return await new Promise(resolve => setTimeout(resolve, ms));
}

async function queueComfyPrompt(baseUrl, workflowJson) {
  const clientId = randomUUID();
  const promptId = randomUUID();
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: workflowJson,
      client_id: clientId,
      prompt_id: promptId
    })
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(responseBody?.error?.message || responseBody?.error || 'Failed to queue ComfyUI workflow');
  }

  return {
    clientId,
    promptId: responseBody?.prompt_id || promptId
  };
}

async function waitForComfyHistory(baseUrl, promptId, maxAttempts = 180) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${baseUrl}/history/${promptId}`);
    const history = await response.json().catch(() => ({}));
    const promptHistory = history?.[promptId];

    if (response.ok && promptHistory?.outputs && Object.keys(promptHistory.outputs).length > 0) {
      return promptHistory;
    }

    await sleep(1000);
  }

  throw new Error('ComfyUI workflow timed out before producing outputs');
}

function getComfyHistoryImages(historyRecord, selectedOutputs = []) {
  const preferredNodeIds = selectedOutputs.map(output => String(output.nodeId || output.id));
  const orderedNodeIds = [
    ...preferredNodeIds,
    ...Object.keys(historyRecord?.outputs || {}).filter(nodeId => !preferredNodeIds.includes(String(nodeId)))
  ];

  const images = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    if (!nodeOutput?.images?.length) continue;

    for (const image of nodeOutput.images) {
      images.push({ nodeId, ...image });
    }
  }

  return images;
}

async function downloadComfyImage(baseUrl, image) {
  const viewUrl = new URL(`${baseUrl}/view`);
  viewUrl.searchParams.set('filename', image.filename);
  viewUrl.searchParams.set('subfolder', image.subfolder || '');
  viewUrl.searchParams.set('type', image.type || 'output');

  const response = await fetch(viewUrl);
  if (!response.ok) {
    throw new Error('Failed to download ComfyUI output image');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'image/png';

  return {
    buffer,
    contentType
  };
}

async function uploadComfyInputFile(baseUrl, file) {
  const formData = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });

  formData.append('image', blob, file.originalname);
  formData.append('overwrite', 'true');

  const response = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(responseBody?.error || 'Failed to upload reference file to ComfyUI');
  }

  return responseBody?.name || file.originalname;
}

function mergeDeep(defaultValue, currentValue) {
  if (Array.isArray(defaultValue)) {
    return Array.isArray(currentValue) ? currentValue : defaultValue;
  }

  if (!isPlainObject(defaultValue)) {
    return currentValue === undefined ? defaultValue : currentValue;
  }

  const result = { ...defaultValue };

  if (!isPlainObject(currentValue)) {
    return result;
  }

  for (const [key, value] of Object.entries(currentValue)) {
    result[key] = key in defaultValue ? mergeDeep(defaultValue[key], value) : value;
  }

  return result;
}

function replacePromptPlaceholder(value, prompt) {
  if (Array.isArray(value)) {
    return value.map(item => replacePromptPlaceholder(item, prompt));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, replacePromptPlaceholder(nestedValue, prompt)])
    );
  }

  if (typeof value === 'string') {
    return value.replaceAll('{prompt}', prompt);
  }

  return value;
}

function replaceTemplatePlaceholders(value, replacements) {
  if (Array.isArray(value)) {
    return value.map(item => replaceTemplatePlaceholders(item, replacements));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, replaceTemplatePlaceholders(nestedValue, replacements)])
    );
  }

  if (typeof value === 'string') {
    return Object.entries(replacements).reduce(
      (result, [placeholder, replacement]) => result.replaceAll(`{${placeholder}}`, replacement),
      value
    );
  }

  return value;
}

function getExtensionFromMimeType(mimeType = 'image/png') {
  const mimeMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp'
  };

  return mimeMap[mimeType] || 'png';
}

function createGeneratedImageName(prompt, extension) {
  const baseName = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${baseName || 'generated_image'}.${extension}`;
}

function inferAssetTypeFromFilename(filename = '') {
  const supportedType = inferSupportedAssetTypeFromFilename(filename);

  if (supportedType) return supportedType;

  return 'image';
}

function inferSupportedAssetTypeFromFilename(filename = '') {
  const extension = path.extname(filename).toLowerCase();

  if (MESH_EXTENSIONS.has(extension)) return 'mesh';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';

  return null;
}

function createLibraryImportFilename(originalName = 'asset') {
  const extension = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, extension)
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${baseName || 'asset'}-${randomUUID().slice(0, 8)}${extension}`;
}

function createLibraryThumbnailFilename(originalName = 'asset') {
  const baseName = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${baseName || 'asset'}-thumbnail-${randomUUID().slice(0, 8)}.png`;
}

function getMimeTypeFromFilename(filename = '') {
  const extension = path.extname(filename).toLowerCase();

  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.bmp') return 'image/bmp';

  return 'image/png';
}

function sanitizeAssetFolderName(value = 'image') {
  return String(value)
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function getImageEditStoredFilePath(sourceAsset, editId, extension) {
  const sourceName = sanitizeAssetFolderName(path.basename(sourceAsset.name || sourceAsset.filename || sourceAsset.filePath, path.extname(sourceAsset.name || sourceAsset.filename || sourceAsset.filePath))) || 'image';
  return toStoredAssetPath('image', `images/${sourceName}/${editId}/${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`);
}

function collectInlineImageParts(responseBody) {
  return responseBody?.candidates
    ?.flatMap(candidate => candidate?.content?.parts || [])
    ?.map(part => part?.inlineData)
    ?.filter(part => part?.data) || [];
}

async function saveImageEdits({ sourceAsset, editId, imageOutputs = [] }) {
  const savedEdits = [];

  for (const [index, imageOutput] of imageOutputs.entries()) {
    const extension = imageOutput.extension || getExtensionFromMimeType(imageOutput.mimeType);
    const storedFilePath = getImageEditStoredFilePath(sourceAsset, editId, extension);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);
    const createdAt = Date.now() + index;

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, imageOutput.buffer);

    savedEdits.push(await createAssetEditRecord({
      assetId: sourceAsset.id,
      editId,
      filePath: storedFilePath,
      createdAt
    }));
  }

  return savedEdits;
}

async function loadWorkflowJson(filePath) {
  const workflowContent = await fs.readFile(toAbsoluteStoragePath(filePath), 'utf-8');
  return JSON.parse(workflowContent);
}

async function buildWorkflowResponse(record) {
  if (!record) return null;

  const workflowJson = await loadWorkflowJson(record.filePath);
  const parsedWorkflow = parseComfyWorkflow(workflowJson);

  return {
    id: record.id,
    name: record.name,
    filePath: record.filePath,
    workflowJson,
    availableInputs: parsedWorkflow.inputs,
    availableOutputs: parsedWorkflow.outputs,
    parameters: JSON.parse(record.parametersJson || '[]'),
    outputs: JSON.parse(record.outputsJson || '[]'),
    createdAt: record.creationDate
  };
}

async function saveWorkflowFile(name, workflowJson) {
  await fs.mkdir(WORKFLOW_ASSETS_DIR, { recursive: true });

  const workflowSlug = sanitizeDisplayName(name, 'Workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'workflow';
  const workflowFilename = `${workflowSlug}_${Date.now()}_${Math.round(Math.random() * 1E9)}.json`;
  const workflowFilePath = toStoredAssetPath('workflow', workflowFilename);

  await fs.writeFile(toAbsoluteStoragePath(workflowFilePath), JSON.stringify(workflowJson, null, 2), 'utf-8');

  return workflowFilePath;
}

// ─── API ROUTES ───

app.get('/api/projects', async (req, res) => {
  try {
    res.json(await listProjects());
  } catch {
    res.status(500).json({ error: 'Server read error' });
  }
});

app.post('/api/comfyui/workflows/run', workflowExecutionUpload.any(), async (req, res) => {
  try {
    const { projectId, workflowId, cardId } = req.body;
    const inputValues = JSON.parse(req.body.inputValues || '{}');

    if (!projectId || !workflowId) {
      return res.status(400).json({ error: 'projectId and workflowId are required' });
    }

    const workflowRecord = await getWorkflowRecordById(Number(workflowId));
    const workflow = workflowRecord ? await buildWorkflowResponse(workflowRecord) : null;

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    const settings = await getSettings();
    const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
    const uploadedFiles = new Map((req.files || []).map(file => [file.fieldname, file]));
    const resolvedInputs = { ...inputValues };

    for (const parameter of workflow.parameters || []) {
      const parameterValueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter));
      if (!['image', 'video'].includes(parameterValueType)) continue;

      const fileMarker = inputValues?.[parameter.id];
      const fieldName = fileMarker?.__fileField;
      const uploadedFile = uploadedFiles.get(fieldName);

      if (!uploadedFile) {
        throw new Error(`A reference file is required for ${parameter.name}`);
      }

      resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, uploadedFile);
    }

    const promptWorkflow = applyComfyParametersToWorkflow(workflow.workflowJson, workflow.parameters, resolvedInputs);
    const { promptId } = await queueComfyPrompt(baseUrl, promptWorkflow);
    const historyRecord = await waitForComfyHistory(baseUrl, promptId);
    const workflowImages = getComfyHistoryImages(historyRecord, workflow.outputs);

    if (workflowImages.length === 0) {
      return res.status(502).json({ error: 'The ComfyUI workflow finished but no images were returned' });
    }

    const imageCardId = cardId || randomUUID();
    const baseTimestamp = Date.now();
    const generatedAssets = [];

    for (const [index, workflowImage] of workflowImages.entries()) {
      const downloadedImage = await downloadComfyImage(baseUrl, workflowImage);
      const extension = path.extname(workflowImage.filename).replace('.', '') || getExtensionFromMimeType(downloadedImage.contentType);
      const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
      const storedFilePath = toStoredAssetPath('image', filename);
      const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

      await fs.writeFile(absoluteFilePath, downloadedImage.buffer);

      generatedAssets.push(await createProjectAsset({
        projectId: Number(projectId),
        type: 'image',
        name: createGeneratedImageName(workflow.name, extension),
        filePath: storedFilePath,
        metadata: {
          resolution: 'Unknown',
          format: extension.toUpperCase(),
          source: 'COMFYUI',
          provider: 'ComfyUI',
          workflowId: workflow.id,
          workflowName: workflow.name,
          promptId,
          outputNodeId: workflowImage.nodeId,
          outputFilename: workflowImage.filename,
          savedOutputs: workflowImages.length,
          cardId: imageCardId
        },
        createdAt: baseTimestamp + index
      }));
    }

    res.status(201).json(generatedAssets);
  } catch (err) {
    console.error('ComfyUI workflow execution failed:', err);
    res.status(500).json({ error: err.message || 'Failed to execute ComfyUI workflow' });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    res.status(201).json(await createProject(req.body));
  } catch {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await getProjectById(Number(req.params.id));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await deleteProjectById(Number(req.params.id));
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Deletion failed' });
  }
});

app.get('/api/assets', async (req, res) => {
  const { projectId } = req.query;
  res.json(await listProjectAssets(projectId ? Number(projectId) : null));
});

app.get('/api/assets/library', async (req, res) => {
  try {
    const [images, meshes] = await Promise.all([
      listLibraryAssetsByType('image', PORT),
      listLibraryAssetsByType('mesh', PORT)
    ]);
    res.json({ images, meshes });
  } catch (err) {
    console.error('Failed to list asset library:', err);
    res.status(500).json({ error: 'Failed to list asset library' });
  }
});

app.delete('/api/assets/library', async (req, res) => {
  try {
    const { type, filename } = req.query;

    if (!type || !filename) {
      return res.status(400).json({ error: 'type and filename are required' });
    }

    const result = await deleteLibraryAssetByFilePath(String(type), String(filename));

    if (result.status === 'linked') {
      return res.status(409).json({
        error: 'Asset is linked to a project',
        projectId: result.projectId,
        projectName: result.projectName || null
      });
    }

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete library asset:', err);
    res.status(500).json({ error: 'Failed to delete library asset' });
  }
});

app.put('/api/assets/library', async (req, res) => {
  try {
    const { type, filename, name } = req.body;

    if (!type || !filename || !name?.trim()) {
      return res.status(400).json({ error: 'type, filename and name are required' });
    }

    const storedFilePath = toStoredAssetPath(String(type), String(filename));
    const absoluteAssetPath = toAbsoluteStoragePath(storedFilePath);

    try {
      await fs.access(absoluteAssetPath);
    } catch {
      return res.status(404).json({ error: 'Selected asset file was not found' });
    }

    res.json(await renameLibraryAssetByFilePath(String(type), String(filename), String(name)));
  } catch (err) {
    console.error('Failed to rename library asset:', err);
    res.status(500).json({ error: err.message || 'Failed to rename library asset' });
  }
});

app.post('/api/assets/library/import', libraryImportUpload.any(), async (req, res) => {
  try {
    const multipartFiles = req.files || [];
    const files = multipartFiles.filter(file => file.fieldname === 'files');
    const thumbnailsByIndex = new Map(
      multipartFiles
        .filter(file => file.fieldname.startsWith('thumbnail:'))
        .map(file => [Number(file.fieldname.split(':')[1]), file])
    );

    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const imported = [];
    const skipped = [];

    await Promise.all(files.map(async (file, index) => {
      const assetType = inferSupportedAssetTypeFromFilename(file.originalname);

      if (!assetType) {
        skipped.push({
          name: file.originalname,
          reason: 'Unsupported asset type'
        });
        return;
      }

      const destinationDir = getAssetDirectory(assetType);
      const filename = createLibraryImportFilename(file.originalname);
      const storedFilePath = toStoredAssetPath(assetType, filename);
      const thumbnailFile = thumbnailsByIndex.get(index);
      let thumbnailPath = null;

      await fs.mkdir(destinationDir, { recursive: true });
      await fs.writeFile(path.join(destinationDir, filename), file.buffer);

      if (thumbnailFile) {
        const thumbnailFilename = createLibraryThumbnailFilename(file.originalname);
        thumbnailPath = toStoredThumbnailPath(thumbnailFilename);
        await fs.mkdir(THUMBNAIL_ASSETS_DIR, { recursive: true });
        await fs.writeFile(path.join(THUMBNAIL_ASSETS_DIR, thumbnailFilename), thumbnailFile.buffer);
      }

      await createLibraryAsset({
        name: file.originalname,
        type: assetType,
        filePath: storedFilePath,
        thumbnailPath,
        metadata: {
          source: 'LIBRARY IMPORT'
        },
        createdAt: Date.now()
      });

      imported.push({
        name: file.originalname,
        filename,
        type: assetType,
        thumbnailPath
      });
    }));

    if (imported.length === 0) {
      return res.status(400).json({
        error: 'No supported assets were imported',
        imported,
        skipped
      });
    }

    res.status(201).json({ imported, skipped });
  } catch (err) {
    console.error('Failed to import library assets:', err);
    res.status(500).json({ error: 'Failed to import library assets' });
  }
});

app.post('/api/assets/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const assetType = req.body.type || inferAssetTypeFromFilename(req.file.originalname);
    const newAsset = await createProjectAsset({
      projectId: Number(req.body.projectId),
      type: assetType,
      name: req.body.name || req.file.originalname,
      filePath: toStoredAssetPath(assetType, req.file.filename),
      metadata: req.body.metadata ? JSON.parse(req.body.metadata) : {},
      createdAt: Date.now()
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Upload recording failed:', err);
    res.status(500).json({ error: 'Upload recording failed' });
  }
});

app.post('/api/assets/link', async (req, res) => {
  try {
    const { projectId, filename, type = 'image', name, metadata } = req.body;

    if (!projectId || !filename) {
      return res.status(400).json({ error: 'projectId and filename are required' });
    }

    const assetType = type || inferAssetTypeFromFilename(filename);
    const storedFilePath = toStoredAssetPath(assetType, filename);
    const absoluteAssetPath = toAbsoluteStoragePath(storedFilePath);

    await fs.access(absoluteAssetPath).catch(() => null);
    try {
      await fs.access(absoluteAssetPath);
    } catch {
      return res.status(404).json({ error: 'Selected asset file was not found' });
    }

    const libraryAsset = await findLibraryAssetByFilePath(assetType, storedFilePath);
    const newAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: assetType,
      name: name || path.basename(storedFilePath),
      filePath: storedFilePath,
      thumbnailPath: libraryAsset?.thumbnail || null,
      metadata: {
        resolution: 'Unknown',
        format: path.extname(storedFilePath).replace('.', '').toUpperCase() || assetType.toUpperCase(),
        source: 'ASSET LIB',
        ...(metadata || {})
      },
      createdAt: Date.now()
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Failed to link existing asset:', err);
    res.status(500).json({ error: 'Failed to attach asset from library' });
  }
});

app.delete('/api/assets/:id', async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    const result = await deleteAssetById(assetId);

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Asset card not found' });
    }

    if (result.status === 'linked') {
      return res.status(409).json({ error: 'Cannot delete an asset while it is linked to a card' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to remove asset card:', err);
    res.status(500).json({ error: 'Failed to remove asset card' });
  }
});

app.put('/api/cards/move', async (req, res) => {
  try {
    const { projectId, cardId, kanbanColumnId, position } = req.body;

    if (!projectId || !cardId || kanbanColumnId === undefined || position === undefined) {
      return res.status(400).json({ error: 'projectId, cardId, kanbanColumnId and position are required' });
    }

    res.json(await moveCard(Number(projectId), cardId, Number(kanbanColumnId), Number(position)));
  } catch (err) {
    console.error('Failed to move card:', err);
    res.status(500).json({ error: err.message || 'Failed to move card' });
  }
});

app.get('/api/card-attributes/types', async (req, res) => {
  try {
    res.json(await listAttributeTypes());
  } catch (err) {
    console.error('Failed to list attribute types:', err);
    res.status(500).json({ error: 'Failed to list attribute types' });
  }
});

app.get('/api/card-attributes', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectCardAttributes(Number(projectId)));
  } catch (err) {
    console.error('Failed to list card attributes:', err);
    res.status(500).json({ error: 'Failed to list card attributes' });
  }
});

app.post('/api/card-attributes', async (req, res) => {
  try {
    const { projectId, cardId, attributeTypeId, attributeValue = '' } = req.body;

    if (!projectId || !cardId || !attributeTypeId) {
      return res.status(400).json({ error: 'projectId, cardId and attributeTypeId are required' });
    }

    const attribute = await createCardAttribute(Number(projectId), cardId, {
      attributeTypeId: Number(attributeTypeId),
      attributeValue
    });

    res.status(201).json(attribute);
  } catch (err) {
    console.error('Failed to create card attribute:', err);
    res.status(500).json({ error: err.message || 'Failed to create card attribute' });
  }
});

app.put('/api/card-attributes/:cardId/:position', async (req, res) => {
  try {
    const { projectId, attributeTypeId, attributeValue } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const attribute = await updateCardAttribute(
      Number(projectId),
      req.params.cardId,
      Number(req.params.position),
      {
        attributeTypeId: attributeTypeId === undefined ? undefined : Number(attributeTypeId),
        attributeValue
      }
    );

    res.json(attribute);
  } catch (err) {
    console.error('Failed to update card attribute:', err);
    res.status(500).json({ error: err.message || 'Failed to update card attribute' });
  }
});

app.delete('/api/card-attributes/:cardId/:position', async (req, res) => {
  try {
    const projectId = Number(req.query.projectId);

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const result = await deleteCardAttribute(projectId, req.params.cardId, Number(req.params.position));

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Card attribute not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete card attribute:', err);
    res.status(500).json({ error: err.message || 'Failed to delete card attribute' });
  }
});

app.post('/api/image-edits/api', async (req, res) => {
  try {
    const { projectId, assetId, selectedApi, prompt } = req.body;

    if (!projectId || !assetId || !selectedApi || !prompt?.trim()) {
      return res.status(400).json({ error: 'projectId, assetId, selectedApi and prompt are required' });
    }

    const sourceAsset = await getProjectAssetById(Number(projectId), Number(assetId));
    if (!sourceAsset || sourceAsset.type !== 'image') {
      return res.status(404).json({ error: 'Source image asset not found' });
    }

    const settings = await getSettings();
    const googleSettings = settings?.apis?.google;
    const googleGenerationSettings = googleSettings?.imageGeneration;
    const modelConfig = googleGenerationSettings?.models?.[selectedApi];

    if (!modelConfig?.url) {
      return res.status(400).json({ error: `Unsupported image edit API: ${selectedApi}` });
    }

    if (!googleSettings?.apiKey) {
      return res.status(400).json({ error: 'Google API key is not configured in settings' });
    }

    const sourceFilePath = toAbsoluteStoragePath(sourceAsset.filePath);
    const sourceBuffer = await fs.readFile(sourceFilePath);
    const mimeType = getMimeTypeFromFilename(sourceAsset.filePath || sourceAsset.filename || sourceAsset.name);
    const trimmedPrompt = String(prompt).trim();
    const response = await fetch(modelConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [googleGenerationSettings?.headerName || 'x-goog-api-key']: googleSettings.apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: trimmedPrompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: sourceBuffer.toString('base64')
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: '1:1',
            imageSize: '1K'
          }
        }
      })
    });

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Image edit request failed'
      });
    }

    const imageParts = collectInlineImageParts(responseBody);
    if (imageParts.length === 0) {
      return res.status(502).json({ error: 'Image edit succeeded but no image data was returned' });
    }

    const editId = randomUUID();
    const savedEdits = await saveImageEdits({
      sourceAsset,
      editId,
      imageOutputs: imageParts.map(part => ({
        buffer: Buffer.from(part.data, 'base64'),
        mimeType: part.mimeType,
        extension: getExtensionFromMimeType(part.mimeType)
      }))
    });

    res.status(201).json({
      editId,
      assetId: sourceAsset.id,
      savedEdits,
      provider: modelConfig.name
    });
  } catch (err) {
    console.error('Image edit API execution failed:', err);
    res.status(500).json({ error: err.message || 'Failed to run image edit API' });
  }
});

app.post('/api/image-edits/comfy', async (req, res) => {
  try {
    const { projectId, assetId, workflowId, prompt } = req.body;

    if (!projectId || !assetId || !workflowId || !prompt?.trim()) {
      return res.status(400).json({ error: 'projectId, assetId, workflowId and prompt are required' });
    }

    const sourceAsset = await getProjectAssetById(Number(projectId), Number(assetId));
    if (!sourceAsset || sourceAsset.type !== 'image') {
      return res.status(404).json({ error: 'Source image asset not found' });
    }

    const workflowRecord = await getWorkflowRecordById(Number(workflowId));
    const workflow = workflowRecord ? await buildWorkflowResponse(workflowRecord) : null;

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    const imageParameter = (workflow.parameters || []).find(parameter => normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter)) === 'image');
    const stringParameter = (workflow.parameters || []).find(parameter => normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter)) === 'string');

    if (!imageParameter || !stringParameter) {
      return res.status(400).json({ error: 'The selected workflow must expose at least one image input and one string input' });
    }

    const settings = await getSettings();
    const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
    const sourceBuffer = await fs.readFile(toAbsoluteStoragePath(sourceAsset.filePath));
    const uploadedFilename = await uploadComfyInputFile(baseUrl, {
      buffer: sourceBuffer,
      mimetype: getMimeTypeFromFilename(sourceAsset.filePath || sourceAsset.filename || sourceAsset.name),
      originalname: path.basename(sourceAsset.filePath || sourceAsset.filename || sourceAsset.name)
    });

    const promptWorkflow = applyComfyParametersToWorkflow(workflow.workflowJson, workflow.parameters, {
      [imageParameter.id]: uploadedFilename,
      [stringParameter.id]: String(prompt).trim()
    });
    const { promptId } = await queueComfyPrompt(baseUrl, promptWorkflow);
    const historyRecord = await waitForComfyHistory(baseUrl, promptId);
    const workflowImages = getComfyHistoryImages(historyRecord, workflow.outputs);

    if (workflowImages.length === 0) {
      return res.status(502).json({ error: 'The ComfyUI workflow finished but no images were returned' });
    }

    const downloadedImages = await Promise.all(workflowImages.map(async workflowImage => {
      const downloadedImage = await downloadComfyImage(baseUrl, workflowImage);
      return {
        buffer: downloadedImage.buffer,
        mimeType: downloadedImage.contentType,
        extension: path.extname(workflowImage.filename).replace('.', '') || getExtensionFromMimeType(downloadedImage.contentType)
      };
    }));

    const editId = randomUUID();
    const savedEdits = await saveImageEdits({
      sourceAsset,
      editId,
      imageOutputs: downloadedImages
    });

    res.status(201).json({
      editId,
      assetId: sourceAsset.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      promptId,
      savedEdits
    });
  } catch (err) {
    console.error('ComfyUI image edit execution failed:', err);
    res.status(500).json({ error: err.message || 'Failed to run ComfyUI image edit' });
  }
});

app.post('/api/images/generate', async (req, res) => {
  try {
    const { projectId, selectedApi, prompt, cardId } = req.body;

    if (!projectId || !selectedApi || !prompt?.trim()) {
      return res.status(400).json({ error: 'projectId, selectedApi and prompt are required' });
    }

    const settings = await getSettings();
    const trimmedPrompt = prompt.trim();
    const googleSettings = settings?.apis?.google;
    const googleGenerationSettings = googleSettings?.imageGeneration;
    const openAiSettings = settings?.apis?.openai;
    const openAiGenerationSettings = openAiSettings?.imageGeneration;

    let response;
    let responseBody;
    let inlineData;
    let providerName;
    let modelVersion;
    let responseId;
    let outputFormat;

    if (selectedApi === 'openai') {
      if (!openAiSettings?.apiKey) {
        return res.status(400).json({ error: 'OpenAI API key is not configured in settings' });
      }

      const requestHeaders = replaceTemplatePlaceholders(openAiGenerationSettings?.headers || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt
      });
      const requestPayload = replaceTemplatePlaceholders(openAiGenerationSettings?.payloadTemplate, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt
      });

      response = await fetch(openAiGenerationSettings?.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...requestHeaders
        },
        body: JSON.stringify(requestPayload)
      });

      responseBody = await response.json();

      if (!response.ok) {
        console.error('OpenAI image generation failed:', responseBody);
        return res.status(response.status).json({
          error: responseBody?.error?.message || 'Image generation request failed'
        });
      }

      const imageBase64 = responseBody?.data?.[0]?.b64_json;
      if (!imageBase64) {
        return res.status(502).json({ error: 'Image generation succeeded but no image data was returned' });
      }

      inlineData = {
        mimeType: 'image/png',
        data: imageBase64
      };
      providerName = 'OpenAI';
      modelVersion = openAiGenerationSettings?.payloadTemplate?.model || 'gpt-image-1.5';
      responseId = responseBody?.created ? String(responseBody.created) : null;
      outputFormat = 'PNG';
    } else {
      const modelConfig = googleGenerationSettings?.models?.[selectedApi];

      if (!modelConfig?.url) {
        return res.status(400).json({ error: `Unsupported image API: ${selectedApi}` });
      }

      if (!googleSettings?.apiKey) {
        return res.status(400).json({ error: 'Google API key is not configured in settings' });
      }

      const payloadTemplate = googleGenerationSettings?.payloadTemplate;
      const requestPayload = replacePromptPlaceholder(payloadTemplate, trimmedPrompt);
      const headerName = googleGenerationSettings?.headerName || 'x-goog-api-key';

      response = await fetch(modelConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [headerName]: googleSettings.apiKey
        },
        body: JSON.stringify(requestPayload)
      });

      responseBody = await response.json();

      if (!response.ok) {
        console.error('Google image generation failed:', responseBody);
        return res.status(response.status).json({
          error: responseBody?.error?.message || 'Image generation request failed'
        });
      }

      inlineData = responseBody?.candidates
        ?.flatMap(candidate => candidate?.content?.parts || [])
        ?.find(part => part?.inlineData?.data)
        ?.inlineData;

      if (!inlineData?.data) {
        return res.status(502).json({ error: 'Image generation succeeded but no image data was returned' });
      }

      providerName = modelConfig.name;
      modelVersion = responseBody?.modelVersion || null;
      responseId = responseBody?.responseId || null;
      outputFormat = getExtensionFromMimeType(inlineData.mimeType).toUpperCase();
    }

    const extension = getExtensionFromMimeType(inlineData.mimeType);
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const storedFilePath = toStoredAssetPath('image', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.writeFile(absoluteFilePath, Buffer.from(inlineData.data, 'base64'));

    const newAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: 'image',
      name: createGeneratedImageName(trimmedPrompt, extension),
      filePath: storedFilePath,
      metadata: {
        resolution: 'Unknown',
        format: outputFormat || extension.toUpperCase(),
        source: 'AI GEN',
        provider: providerName,
        modelVersion,
        mimeType: inlineData.mimeType,
        responseId,
        usage: responseBody?.usage || responseBody?.usageMetadata || null,
        cardId: cardId || randomUUID()
      },
      createdAt: Date.now()
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Image generation failed:', err);
    res.status(500).json({ error: 'Failed to generate and save image' });
  }
});

app.get('/api/tasks', async (req, res) => {
  const { projectId } = req.query;
  res.json(projectId ? await listProjectTasks(Number(projectId)) : []);
});

app.post('/api/tasks', async (req, res) => {
  try {
    res.status(201).json(await createTask(Number(req.body.projectId), req.body));
  } catch {
    res.status(500).json({ error: 'Task creation failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const currentSettings = await getSettings();
    const nextSettings = mergeDeep(currentSettings || DEFAULT_SETTINGS, req.body);
    res.json(await saveSettings(nextSettings));
  } catch {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Start server
initializeStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 3D Gen Studio Backend running at http://localhost:${PORT}`);
    console.log(`📁 Local Workspace: ${DATA_DIR}`);
  });
});
