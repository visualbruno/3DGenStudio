import express from 'express';
import cors from 'cors';
import multer from 'multer';
import process from 'process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const IMAGE_ASSETS_DIR = path.join(ASSETS_DIR, 'images');
const MESH_ASSETS_DIR = path.join(ASSETS_DIR, 'meshes');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);

console.log('DEBUG: DATA_DIR is', DATA_DIR);
console.log('DEBUG: DB_FILE is', DB_FILE);

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
    const db = await readDb();
    res.json(db.library?.comfyWorkflows || []);
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

    const db = await readDb();
    const workflowRecord = {
      id: Date.now(),
      name: sanitizeDisplayName(name, 'Workflow'),
      workflowJson: cloneSerializable(workflowJson),
      availableInputs: parsed.inputs,
      availableOutputs: parsed.outputs,
      parameters: selectedParameters,
      outputs: selectedOutputs,
      createdAt: Date.now()
    };

    db.library = db.library || { comfyWorkflows: [] };
    db.library.comfyWorkflows = db.library.comfyWorkflows || [];
    db.library.comfyWorkflows.push(workflowRecord);
    await writeDb(db);

    res.status(201).json(workflowRecord);
  } catch (err) {
    console.error('Failed to save ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to save ComfyUI workflow' });
  }
});

app.put('/api/library/comfy-workflows/:id', async (req, res) => {
  try {
    const { name, parameters = [], outputs = [] } = req.body;
    const db = await readDb();
    const workflowIndex = (db.library?.comfyWorkflows || []).findIndex(item => item.id == req.params.id);

    if (workflowIndex === -1) {
      return res.status(404).json({ error: 'ComfyUI workflow not found' });
    }

    const existingWorkflow = db.library.comfyWorkflows[workflowIndex];
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

    const nextWorkflow = {
      ...existingWorkflow,
      name: sanitizeDisplayName(name || existingWorkflow.name, existingWorkflow.name),
      parameters: nextParameters,
      outputs: nextOutputs,
      updatedAt: Date.now()
    };

    db.library.comfyWorkflows[workflowIndex] = nextWorkflow;
    await writeDb(db);

    res.json(nextWorkflow);
  } catch (err) {
    console.error('Failed to update ComfyUI workflow:', err);
    res.status(400).json({ error: err.message || 'Failed to update ComfyUI workflow' });
  }
});
const upload = multer({ storage });
const workflowExecutionUpload = multer({ storage: multer.memoryStorage() });

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

function getAssetSubdirectory(type = 'image') {
  return type === 'mesh' ? 'meshes' : 'images';
}

function getAssetDirectory(type = 'image') {
  return type === 'mesh' ? MESH_ASSETS_DIR : IMAGE_ASSETS_DIR;
}

function normalizeAssetFilename(type, filename) {
  if (!filename) return filename;

  const normalizedFilename = filename.replace(/\\/g, '/');
  if (normalizedFilename.startsWith('images/') || normalizedFilename.startsWith('meshes/')) {
    return normalizedFilename;
  }

  return `${getAssetSubdirectory(type)}/${path.basename(normalizedFilename)}`;
}

function inferAssetTypeFromFilename(filename = '') {
  const extension = path.extname(filename).toLowerCase();

  if (MESH_EXTENSIONS.has(extension)) return 'mesh';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';

  return 'image';
}

async function listLibraryAssetsByType(type) {
  const subdirectory = getAssetSubdirectory(type);
  const assetDirectory = getAssetDirectory(type);
  const entries = await fs.readdir(assetDirectory, { withFileTypes: true });

  return entries
    .filter(entry => entry.isFile())
    .sort((left, right) => right.name.localeCompare(left.name))
    .map(entry => {
      const filename = `${subdirectory}/${entry.name}`;
      return {
        id: `${type}:${entry.name}`,
        name: entry.name,
        filename,
        type,
        extension: path.extname(entry.name).replace('.', '').toUpperCase() || type.toUpperCase(),
        url: `http://localhost:${PORT}/assets/${encodeURI(filename)}`
      };
    });
}

async function migrateLooseAssetsIntoSubfolders() {
  const entries = await fs.readdir(ASSETS_DIR, { withFileTypes: true });
  let changed = false;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const sourcePath = path.join(ASSETS_DIR, entry.name);
    const type = inferAssetTypeFromFilename(entry.name);
    const targetPath = path.join(getAssetDirectory(type), entry.name);

    if (!existsSync(targetPath)) {
      await fs.rename(sourcePath, targetPath);
      changed = true;
    }
  }

  return changed;
}

async function migrateAssetStorage(db) {
  let changed = await migrateLooseAssetsIntoSubfolders();

  for (const asset of db.assets || []) {
    if (!asset.filename) continue;

    const assetType = asset.type || inferAssetTypeFromFilename(asset.filename);
    const normalizedFilename = asset.filename.replace(/\\/g, '/');
    const targetFilename = normalizeAssetFilename(assetType, normalizedFilename);

    if (normalizedFilename !== targetFilename) {
      const sourcePath = path.join(ASSETS_DIR, normalizedFilename);
      const targetPath = path.join(ASSETS_DIR, targetFilename);

      if (existsSync(sourcePath) && !existsSync(targetPath)) {
        await fs.rename(sourcePath, targetPath);
      }

      asset.filename = targetFilename;
      changed = true;
    }
  }

  return changed;
}

/**
 * Robust DB Sync / Initialization
 * This ensures the data/ folder and db.json exist before any read/write.
 */
async function ensureDb() {
  try {
    // 1. Ensure Directories
    if (!existsSync(DATA_DIR)) await fs.mkdir(DATA_DIR, { recursive: true });
    if (!existsSync(ASSETS_DIR)) await fs.mkdir(ASSETS_DIR, { recursive: true });
    if (!existsSync(IMAGE_ASSETS_DIR)) await fs.mkdir(IMAGE_ASSETS_DIR, { recursive: true });
    if (!existsSync(MESH_ASSETS_DIR)) await fs.mkdir(MESH_ASSETS_DIR, { recursive: true });

    // 2. Ensure DB File
    if (!existsSync(DB_FILE)) {
      console.log('📄 Database file missing. Creating fresh db.json...');
      await fs.writeFile(DB_FILE, JSON.stringify(INITIAL_SCHEMA, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('❌ Storage initialization failed:', err);
  }
}

async function readDb() {
  await ensureDb();
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    const db = JSON.parse(data);
    const mergedDb = mergeDeep(INITIAL_SCHEMA, db);
    const migratedAssets = await migrateAssetStorage(mergedDb);

    if (migratedAssets || JSON.stringify(mergedDb) !== JSON.stringify(db)) {
      await fs.writeFile(DB_FILE, JSON.stringify(mergedDb, null, 2), 'utf-8');
    }

    return mergedDb;
  } catch (err) {
    console.error('⚠️ Failed to read database, falling back to initial schema:', err);
    return INITIAL_SCHEMA;
  }
}

async function writeDb(data) {
  await ensureDb();
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('❌ Failed to write to database:', err);
    throw err;
  }
}

// ─── API ROUTES ───

app.get('/api/projects', async (req, res) => {
  try {
    const db = await readDb();
    res.json(db.projects || []);
  } catch {
    res.status(500).json({ error: 'Server read error' });
  }
});

app.post('/api/comfyui/workflows/run', workflowExecutionUpload.any(), async (req, res) => {
  try {
    const { projectId, workflowId } = req.body;
    const inputValues = JSON.parse(req.body.inputValues || '{}');

    if (!projectId || !workflowId) {
      return res.status(400).json({ error: 'projectId and workflowId are required' });
    }

    const db = await readDb();
    const workflow = (db.library?.comfyWorkflows || []).find(item => item.id == workflowId);

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    const baseUrl = buildComfyUiBaseUrl(db.settings || {});
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

    const primaryImage = workflowImages[0];
    const downloadedImage = await downloadComfyImage(baseUrl, primaryImage);
    const extension = path.extname(primaryImage.filename).replace('.', '') || getExtensionFromMimeType(downloadedImage.contentType);
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const relativeFilename = normalizeAssetFilename('image', filename);
    const filePath = path.join(ASSETS_DIR, relativeFilename);

    await fs.writeFile(filePath, downloadedImage.buffer);

    const newAsset = {
      id: Date.now(),
      projectId: parseInt(projectId),
      type: 'image',
      name: createGeneratedImageName(workflow.name, extension),
      filename: relativeFilename,
      metadata: {
        resolution: 'Unknown',
        format: extension.toUpperCase(),
        source: 'COMFYUI',
        provider: 'ComfyUI',
        workflowId: workflow.id,
        workflowName: workflow.name,
        promptId,
        outputNodeId: primaryImage.nodeId,
        outputFilename: primaryImage.filename,
        savedOutputs: workflowImages.length
      },
      createdAt: Date.now()
    };

    db.assets = db.assets || [];
    db.assets.push(newAsset);
    await writeDb(db);

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('ComfyUI workflow execution failed:', err);
    res.status(500).json({ error: err.message || 'Failed to execute ComfyUI workflow' });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const db = await readDb();
    const newProject = {
      ...req.body,
      id: Date.now(),
      createdAt: Date.now(),
      status: 'active'
    };
    db.projects = db.projects || [];
    db.projects.push(newProject);
    await writeDb(db);
    res.status(201).json(newProject);
  } catch {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const db = await readDb();
    const project = db.projects.find(p => p.id == req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const db = await readDb();
    db.projects = (db.projects || []).filter(p => p.id != req.params.id);
    db.assets = (db.assets || []).filter(a => a.projectId != req.params.id);
    db.tasks = (db.tasks || []).filter(t => t.projectId != req.params.id);
    await writeDb(db);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Deletion failed' });
  }
});

app.get('/api/assets', async (req, res) => {
  const db = await readDb();
  const { projectId } = req.query;
  const list = db.assets || [];
  res.json(projectId ? list.filter(a => a.projectId == projectId) : list);
});

app.get('/api/assets/library', async (req, res) => {
  try {
    await ensureDb();
    const [images, meshes] = await Promise.all([
      listLibraryAssetsByType('image'),
      listLibraryAssetsByType('mesh')
    ]);
    res.json({ images, meshes });
  } catch (err) {
    console.error('Failed to list asset library:', err);
    res.status(500).json({ error: 'Failed to list asset library' });
  }
});

app.post('/api/assets/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const db = await readDb();
    const assetType = req.body.type || inferAssetTypeFromFilename(req.file.originalname);
    const newAsset = {
      id: Date.now(),
      projectId: parseInt(req.body.projectId),
      type: assetType,
      name: req.body.name || req.file.originalname,
      filename: normalizeAssetFilename(assetType, req.file.filename),
      metadata: req.body.metadata ? JSON.parse(req.body.metadata) : {},
      createdAt: Date.now()
    };
    db.assets = db.assets || [];
    db.assets.push(newAsset);
    await writeDb(db);
    res.status(201).json(newAsset);
  } catch {
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
    const normalizedFilename = normalizeAssetFilename(assetType, filename);
    const assetPath = path.join(ASSETS_DIR, normalizedFilename);

    if (!existsSync(assetPath)) {
      return res.status(404).json({ error: 'Selected asset file was not found' });
    }

    const db = await readDb();
    const newAsset = {
      id: Date.now(),
      projectId: parseInt(projectId),
      type: assetType,
      name: name || path.basename(normalizedFilename),
      filename: normalizedFilename,
      metadata: {
        resolution: 'Unknown',
        format: path.extname(normalizedFilename).replace('.', '').toUpperCase() || assetType.toUpperCase(),
        source: 'ASSET LIB',
        ...(metadata || {})
      },
      createdAt: Date.now()
    };

    db.assets = db.assets || [];
    db.assets.push(newAsset);
    await writeDb(db);

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Failed to link existing asset:', err);
    res.status(500).json({ error: 'Failed to attach asset from library' });
  }
});

app.delete('/api/assets/:id', async (req, res) => {
  try {
    const db = await readDb();
    const assetId = Number(req.params.id);
    const assetExists = (db.assets || []).some(asset => asset.id === assetId);

    if (!assetExists) {
      return res.status(404).json({ error: 'Asset card not found' });
    }

    db.assets = (db.assets || []).filter(asset => asset.id !== assetId);
    await writeDb(db);

    res.status(204).end();
  } catch (err) {
    console.error('Failed to remove asset card:', err);
    res.status(500).json({ error: 'Failed to remove asset card' });
  }
});

app.post('/api/images/generate', async (req, res) => {
  try {
    const { projectId, selectedApi, prompt } = req.body;

    if (!projectId || !selectedApi || !prompt?.trim()) {
      return res.status(400).json({ error: 'projectId, selectedApi and prompt are required' });
    }

    const db = await readDb();
    const trimmedPrompt = prompt.trim();
    const googleSettings = db.settings?.apis?.google;
    const googleGenerationSettings = googleSettings?.imageGeneration;
    const openAiSettings = db.settings?.apis?.openai;
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
    const relativeFilename = normalizeAssetFilename('image', filename);
    const filePath = path.join(ASSETS_DIR, relativeFilename);

    await fs.writeFile(filePath, Buffer.from(inlineData.data, 'base64'));

    const newAsset = {
      id: Date.now(),
      projectId: parseInt(projectId),
      type: 'image',
      name: createGeneratedImageName(trimmedPrompt, extension),
      filename: relativeFilename,
      metadata: {
        resolution: 'Unknown',
        format: outputFormat || extension.toUpperCase(),
        source: 'AI GEN',
        provider: providerName,
        modelVersion,
        mimeType: inlineData.mimeType,
        responseId,
        usage: responseBody?.usage || responseBody?.usageMetadata || null
      },
      createdAt: Date.now()
    };

    db.assets = db.assets || [];
    db.assets.push(newAsset);
    await writeDb(db);

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Image generation failed:', err);
    res.status(500).json({ error: 'Failed to generate and save image' });
  }
});

app.get('/api/tasks', async (req, res) => {
  const db = await readDb();
  const { projectId } = req.query;
  const list = db.tasks || [];
  res.json(projectId ? list.filter(t => t.projectId == projectId) : list);
});

app.post('/api/tasks', async (req, res) => {
  try {
    const db = await readDb();
    const newTask = {
      ...req.body,
      id: Date.now(),
      projectId: parseInt(req.body.projectId),
      progress: 0,
      status: 'processing',
      createdAt: Date.now()
    };
    db.tasks = db.tasks || [];
    db.tasks.push(newTask);
    await writeDb(db);
    res.status(201).json(newTask);
  } catch {
    res.status(500).json({ error: 'Task creation failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = await readDb();
    res.json(db.settings || INITIAL_SCHEMA.settings);
  } catch {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const db = await readDb();
    db.settings = mergeDeep(db.settings, req.body);
    await writeDb(db);
    res.json(db.settings);
  } catch {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Start server
ensureDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 3D Gen Studio Backend running at http://localhost:${PORT}`);
    console.log(`📁 Local Workspace: ${DATA_DIR}`);
  });
});
