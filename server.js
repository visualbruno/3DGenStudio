import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import { createAssetEditRecord, resolveProjectImageSource, resolveProjectMeshSource } from './storage.js';
import fs from 'fs/promises';
import si from 'systeminformation';
import { exec } from 'child_process';
import util from 'util';
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
  clearCardProcessingState,
  deleteCardAttribute,
  deleteAssetEditByFilePath,
  deleteAssetById,
  deleteProjectConnection,
  deleteProjectNode,
  deleteLibraryAssetByFilePath,
  deleteProjectById,
  findLibraryAssetByFilePath,
  getAssetDirectory,
  listAttributeTypes,
  listProjectConnections,
  listProjectCards,
  listProjectCardAttributes,
  listProjectNodes,
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
  createProjectConnection,
  createProjectNode,
  createAssetVersion,
  findAssetByFilePath,
  getAssetRecordById,
  renameLibraryAssetByFilePath,
  replaceAssetFileById,
  renameAssetEditByFilePath,
  saveSettings,
  toAssetUrlPath,
  setCardProcessingState,
  toAbsoluteStoragePath,
  toStoredAssetPath,
  toStoredThumbnailPath,
  updateAssetThumbnail,
  updateCardAttribute,
  updateProjectNode,
  updateProjectNodePosition,
  updateWorkflowRecord
} from './storage.js';

const app = express();
const PORT = 3001;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);
const comfyProgressSubscribers = new Map();
const comfyProgressSnapshots = new Map();

console.log('DEBUG: DATA_DIR is', DATA_DIR);
console.log('DEBUG: DB_FILE is', path.join(DATA_DIR, 'app.db'));

// Middleware
app.use(cors());
app.use('/api/meshes/editor/save', express.json({ limit: '50mb' }));
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

app.delete('/api/assets/library/edits', async (req, res) => {
  try {
    const { filePath } = req.query;

    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const result = await deleteAssetEditByFilePath(String(filePath));

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Edit not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete asset edit:', err);
    res.status(500).json({ error: err.message || 'Failed to delete asset edit' });
  }
});

app.put('/api/assets/library/edits', async (req, res) => {
  try {
    const { filePath, name } = req.body;

    if (!filePath || !name?.trim()) {
      return res.status(400).json({ error: 'filePath and name are required' });
    }

    res.json(await renameAssetEditByFilePath(String(filePath), name));
  } catch (err) {
    console.error('Failed to rename asset edit:', err);
    res.status(500).json({ error: err.message || 'Failed to rename asset edit' });
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
const thumbnailUpload = multer({ storage: multer.memoryStorage() });
const meshEditorSaveUpload = multer({ storage: multer.memoryStorage() });

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

async function updateCardProcessingSnapshot(projectId, cardId, {
  columnName = 'Images',
  name = null,
  status = 'processing',
  progressPercent = null,
  detail = '',
  currentNodeLabel = '',
  promptId = null,
  source = 'ComfyUI',
  operationType = 'workflow',
  workflowId = null,
  workflowName = null,
  startedAt = Date.now()
} = {}) {
  if (!projectId || !cardId) {
    return null;
  }

  return await setCardProcessingState(Number(projectId), cardId, {
    columnName,
    name,
    status,
    progress: Number.isFinite(progressPercent) ? Math.max(0, Math.min(100, Math.round(progressPercent))) : null,
    processing: {
      status,
      progressPercent: Number.isFinite(progressPercent) ? Math.max(0, Math.min(100, Math.round(progressPercent))) : null,
      detail,
      currentNodeLabel,
      promptId,
      source,
      operationType,
      workflowId,
      workflowName,
      startedAt,
      updatedAt: Date.now()
    },
    creationDate: startedAt
  });
}

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

function sanitizeFileSegment(value = '', fallback = 'mesh') {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function createMeshEditorFilePath(name = 'mesh') {
  return `data/assets/meshes/${sanitizeFileSegment(name)}-${Date.now()}.glb`;
}

async function resolveEditableMeshAsset({ assetId, filePath }) {
  const numericAssetId = Number(assetId)

  if (Number.isFinite(numericAssetId) && numericAssetId > 0) {
    return await getAssetRecordById(numericAssetId);
  }

  if (!filePath) {
    return null;
  }

  return await findAssetByFilePath('mesh', filePath);
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
  if (item?.type === 'boolean') return 'boolean';
  return item?.type === 'number' ? 'number' : 'string';
}

function normalizeComfyValueType(value, fallback = 'string') {
  return ['string', 'number', 'boolean', 'image', 'video', 'mesh'].includes(value) ? value : fallback;
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

function buildComfyUiWebSocketUrl(baseUrl, clientId) {
  const parsedUrl = new URL(baseUrl);
  const currentPath = parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname.replace(/\/$/, '') : '';

  parsedUrl.protocol = parsedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  parsedUrl.pathname = `${currentPath}/ws`;
  parsedUrl.search = '';
  parsedUrl.hash = '';
  parsedUrl.searchParams.set('clientId', clientId);

  return parsedUrl.toString();
}

function getComfyExecutionNodeIds(workflowJson = {}, selectedOutputs = []) {
  const availableNodeIds = Object.keys(workflowJson || {});

  if (availableNodeIds.length === 0) {
    return new Set();
  }

  const preferredNodeIds = selectedOutputs
    .map(output => String(output?.nodeId || output?.id || ''))
    .filter(nodeId => nodeId && workflowJson?.[nodeId]);
  const reachableNodeIds = new Set();
  const queue = preferredNodeIds.length > 0 ? [...preferredNodeIds] : [...availableNodeIds];

  while (queue.length > 0) {
    const nodeId = String(queue.pop());
    if (!nodeId || reachableNodeIds.has(nodeId) || !workflowJson?.[nodeId]) {
      continue;
    }

    reachableNodeIds.add(nodeId);

    for (const inputValue of Object.values(workflowJson[nodeId]?.inputs || {})) {
      if (Array.isArray(inputValue) && inputValue.length > 0 && workflowJson?.[String(inputValue[0])]) {
        queue.push(String(inputValue[0]));
      }
    }
  }

  return reachableNodeIds.size > 0 ? reachableNodeIds : new Set(availableNodeIds);
}

function getComfyExecutionNodeLabel(workflowJson, nodeId) {
  const node = workflowJson?.[String(nodeId)];
  return node?._meta?.title || node?.title || node?.class_type || `Node ${nodeId}`;
}

function getComfyExecutionProgressPercent(completedNodeCount, totalNodeCount, nodeProgress = 0, isComplete = false) {
  if (isComplete) {
    return 100;
  }

  const safeTotalNodeCount = Math.max(1, Number(totalNodeCount) || 1);
  const safeNodeProgress = Number.isFinite(nodeProgress) ? Math.min(Math.max(nodeProgress, 0), 1) : 0;
  const rawPercent = ((completedNodeCount + safeNodeProgress) / safeTotalNodeCount) * 100;

  return Math.max(0, Math.min(99, Math.round(rawPercent)));
}

function getComfyProgressSubscribers(promptId) {
  const key = String(promptId || '');
  if (!comfyProgressSubscribers.has(key)) {
    comfyProgressSubscribers.set(key, new Set());
  }

  return comfyProgressSubscribers.get(key);
}

function publishComfyProgress(promptId, payload) {
  const key = String(promptId || '');
  const message = {
    promptId: key,
    timestamp: Date.now(),
    ...payload
  };

  comfyProgressSnapshots.set(key, message);

  for (const response of getComfyProgressSubscribers(key)) {
    response.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  if (message.status === 'completed' || message.status === 'error') {
    setTimeout(() => {
      if ((comfyProgressSubscribers.get(key)?.size || 0) === 0) {
        comfyProgressSubscribers.delete(key);
        comfyProgressSnapshots.delete(key);
      }
    }, 60000);
  }
}

function subscribeToComfyProgress(promptId, req, res) {
  const key = String(promptId || '');
  const subscribers = getComfyProgressSubscribers(key);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  subscribers.add(res);

  const snapshot = comfyProgressSnapshots.get(key);
  if (snapshot) {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(res);

    if (subscribers.size === 0 && !comfyProgressSnapshots.has(key)) {
      comfyProgressSubscribers.delete(key);
    }
  });
}

function createComfyExecutionMonitor(baseUrl, { clientId, promptId, workflowJson, selectedOutputs = [], timeout = null, onProgress = null }) {
  const trackedNodeIds = getComfyExecutionNodeIds(workflowJson, selectedOutputs);
  const totalNodeCount = Math.max(1, trackedNodeIds.size || Object.keys(workflowJson || {}).length || 1);
  const wsUrl = buildComfyUiWebSocketUrl(baseUrl, clientId);
  const completedNodes = new Set();
  let currentNodeId = null;
  let currentNodeProgress = 0;
  let socket = null;
  let timer = null;
  let isReady = false;
  let isSettled = false;
  let rejectCompletion = null;

  const normalizeNodeId = (nodeId) => String(nodeId || '');
  const isTrackedNode = (nodeId) => trackedNodeIds.size === 0 || trackedNodeIds.has(normalizeNodeId(nodeId));
  const getCompletedNodeCount = () => completedNodes.size;
  const getProgressPercent = (isComplete = false) => {
    const runningNodeBonus = currentNodeId && !completedNodes.has(currentNodeId) && isTrackedNode(currentNodeId)
      ? currentNodeProgress
      : 0;

    return getComfyExecutionProgressPercent(getCompletedNodeCount(), totalNodeCount, runningNodeBonus, isComplete);
  };
  const markNodeCompleted = (nodeId) => {
    const normalizedNodeId = normalizeNodeId(nodeId);
    if (!normalizedNodeId || !isTrackedNode(normalizedNodeId)) {
      return false;
    }

    completedNodes.add(normalizedNodeId);

    if (currentNodeId === normalizedNodeId) {
      currentNodeProgress = 0;
    }

    return true;
  };
  const publishState = (payload) => {
    const nextPayload = {
      totalNodeCount,
      completedNodeCount: getCompletedNodeCount(),
      progressPercent: getProgressPercent(payload?.status === 'completed'),
      ...payload
    };

    publishComfyProgress(promptId, nextPayload);
    onProgress?.(nextPayload);
  };

  const ready = new Promise((resolve, reject) => {
    socket = new WebSocket(wsUrl);

    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        isSettled = true;
        publishState({
          status: 'error',
          detail: `Job did not complete within ${Math.round(timeout / 1000)}s`,
          currentNodeLabel: 'Timed out'
        });
        socket.close();
        rejectCompletion?.(new Error(`Job did not complete within ${Math.round(timeout / 1000)}s`));
        reject(new Error(`Job did not complete within ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }

    socket.onopen = () => {
      isReady = true;
      publishState({
        status: 'connected',
        detail: `Connected to ComfyUI • ${totalNodeCount} workflow nodes`,
        currentNodeLabel: 'Waiting for execution to start'
      });
      resolve();
    };

    socket.onerror = (error) => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      publishState({
        status: 'error',
        detail: 'Failed to connect to ComfyUI progress stream',
        currentNodeLabel: 'Connection failed'
      });

      rejectCompletion?.(error instanceof Error ? error : new Error('Failed to connect to ComfyUI progress stream'));
      reject(error instanceof Error ? error : new Error('Failed to connect to ComfyUI progress stream'));
    };
  });

  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      let payload;

      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      const messageType = payload?.type;
      const messageData = payload?.data || {};

      if (messageData.prompt_id && String(messageData.prompt_id) !== String(promptId)) {
        return;
      }

      if (messageType === 'execution_cached') {
        for (const nodeId of messageData.nodes || []) {
          markNodeCompleted(nodeId);
        }

        publishState({
          status: 'running',
          detail: `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: 'Using cached nodes'
        });
        return;
      }

      if (messageType === 'executing') {
        const previousNodeId = currentNodeId;
        const nextNodeId = messageData.node ? normalizeNodeId(messageData.node) : null;

        if (previousNodeId && previousNodeId !== nextNodeId) {
          markNodeCompleted(previousNodeId);
        }

        currentNodeId = nextNodeId;
        currentNodeProgress = 0;

        if (!nextNodeId) {
          if (previousNodeId) {
            markNodeCompleted(previousNodeId);
          }

          publishState({
            status: 'running',
            detail: 'Finalizing outputs',
            currentNodeLabel: 'Execution complete',
            progressPercent: Math.max(getProgressPercent(), 99)
          });
          return;
        }

        if (!isTrackedNode(nextNodeId)) {
          return;
        }

        publishState({
          status: 'running',
          detail: `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: `Running ${getComfyExecutionNodeLabel(workflowJson, nextNodeId)}`
        });
        return;
      }

      if (messageType === 'progress') {
        const maxValue = Number(messageData.max) || 0;
        const currentValue = Number(messageData.value) || 0;
        currentNodeProgress = maxValue > 0 ? currentValue / maxValue : 0;

        publishState({
          status: 'running',
          detail: maxValue > 0 ? `Step ${currentValue}/${maxValue}` : `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: currentNodeId ? `Running ${getComfyExecutionNodeLabel(workflowJson, currentNodeId)}` : 'Processing workflow'
        });
        return;
      }

      if (messageType === 'executed' && messageData.node) {
        const executedNodeId = normalizeNodeId(messageData.node);

        if (!markNodeCompleted(executedNodeId)) {
          return;
        }

        publishState({
          status: 'running',
          detail: `Completed ${getCompletedNodeCount()}/${totalNodeCount} workflow nodes`,
          currentNodeLabel: `Completed ${getComfyExecutionNodeLabel(workflowJson, executedNodeId)}`
        });
        return;
      }

      if (messageType === 'execution_success') {
        if (currentNodeId) {
          markNodeCompleted(currentNodeId);
        }

        isSettled = true;

        publishState({
          status: 'completed',
          detail: 'ComfyUI execution completed',
          currentNodeLabel: 'Saving generated image',
          progressPercent: 100
        });

        clearTimeout(timer);
        socket.close();
        resolve();
        return;
      }

      if (messageType === 'execution_error') {
        const errorMessage = messageData.exception_message || 'Unknown ComfyUI error';

        isSettled = true;

        publishState({
          status: 'error',
          detail: errorMessage,
          currentNodeLabel: 'ComfyUI execution failed'
        });

        clearTimeout(timer);
        socket.close();
        reject(new Error(errorMessage));
      }
    };

    socket.onclose = () => {
      clearTimeout(timer);

      if (!isSettled && isReady) {
        isSettled = true;
        publishState({
          status: 'error',
          detail: 'ComfyUI progress stream closed unexpectedly',
          currentNodeLabel: 'Connection closed'
        });
        reject(new Error('ComfyUI progress stream closed unexpectedly'));
      }
    };
  });

  return {
    ready,
    completion,
    close: () => {
      isSettled = true;
      clearTimeout(timer);
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
    }
  };
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

async function queueComfyPrompt(baseUrl, workflowJson, identifiers = {}) {
  const clientId = String(identifiers?.clientId || '').trim() || randomUUID();
  const promptId = String(identifiers?.promptId || '').trim() || randomUUID();
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

function parseJsonTemplate(value, label, fallback = {}) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (isPlainObject(value) || Array.isArray(value)) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function getCustomApiConfig(settings, selectedApi, expectedType = null) {
  const customApiId = String(selectedApi || '').startsWith('custom_')
    ? String(selectedApi).slice(7)
    : '';
  const customApi = (settings?.apis?.custom || []).find(api => String(api?.id) === customApiId);

  if (!customApi) {
    throw new Error('Selected custom API was not found in settings');
  }

  const normalizedType = ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit', 'mesh-texturing'].includes(customApi?.type)
    ? customApi.type
    : 'image-generation';

  if (expectedType && normalizedType !== expectedType) {
    throw new Error(`Selected custom API must be of type ${expectedType}`);
  }

  return {
    ...customApi,
    type: normalizedType
  };
}

function getNestedValue(value, pathExpression = '') {
  return String(pathExpression || '')
    .split('.')
    .filter(Boolean)
    .reduce((currentValue, segment) => currentValue?.[segment], value);
}

function findFirstResponseField(responseBody, paths = []) {
  for (const pathExpression of paths) {
    const value = getNestedValue(responseBody, pathExpression);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return null;
}

function parseDataUri(value = '') {
  const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;

  return {
    mimeType: match[1],
    data: match[2]
  };
}

function getFilenameFromUrl(rawUrl = '', fallback = 'generated_mesh.glb') {
  try {
    const parsedUrl = new URL(String(rawUrl || ''));
    const filename = path.basename(parsedUrl.pathname || '');
    return filename || fallback;
  } catch {
    return fallback;
  }
}

async function extractMeshOutputFromApiResponse(response, responseBody) {
  const contentType = response.headers.get('content-type') || '';

  if (!String(contentType).toLowerCase().includes('application/json')) {
    const extension = getExtensionFromContentType(contentType, 'glb');
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      filename: `generated_mesh.${extension}`,
      contentType
    };
  }

  const base64Value = findFirstResponseField(responseBody, [
    'meshBase64',
    'mesh_base64',
    'base64',
    'data.meshBase64',
    'data.mesh_base64',
    'data.base64',
    'file.base64',
    'output.base64'
  ]);
  const meshUrl = findFirstResponseField(responseBody, [
    'meshUrl',
    'mesh_url',
    'url',
    'fileUrl',
    'downloadUrl',
    'data.meshUrl',
    'data.mesh_url',
    'data.url',
    'file.url',
    'output.url'
  ]);
  const filename = findFirstResponseField(responseBody, [
    'filename',
    'fileName',
    'meshFilename',
    'mesh_filename',
    'data.filename',
    'data.fileName',
    'file.filename',
    'output.filename'
  ]);
  const declaredMimeType = findFirstResponseField(responseBody, [
    'mimeType',
    'contentType',
    'data.mimeType',
    'data.contentType',
    'file.mimeType',
    'output.mimeType'
  ]);

  if (typeof base64Value === 'string' && base64Value.trim()) {
    const parsedDataUri = parseDataUri(base64Value);
    const normalizedBase64 = parsedDataUri?.data || base64Value;
    const mimeType = parsedDataUri?.mimeType || declaredMimeType || 'model/gltf-binary';
    const inferredFilename = filename || `generated_mesh.${getExtensionFromContentType(mimeType, 'glb')}`;

    return {
      buffer: Buffer.from(normalizedBase64, 'base64'),
      filename: inferredFilename,
      contentType: mimeType
    };
  }

  if (typeof meshUrl === 'string' && meshUrl.trim()) {
    const downloadResponse = await fetch(meshUrl);
    if (!downloadResponse.ok) {
      throw new Error('Failed to download generated mesh from custom API response');
    }

    const downloadedContentType = downloadResponse.headers.get('content-type') || declaredMimeType || 'model/gltf-binary';
    return {
      buffer: Buffer.from(await downloadResponse.arrayBuffer()),
      filename: filename || getFilenameFromUrl(meshUrl, `generated_mesh.${getExtensionFromContentType(downloadedContentType, 'glb')}`),
      contentType: downloadedContentType
    };
  }

  throw new Error('Mesh generation API succeeded but no mesh payload was returned');
}

function getComfyHistoryFiles(historyRecord, selectedOutputs = []) {
  const selectedOutputsByNodeId = new Map(selectedOutputs.map(output => [String(output.nodeId || output.id), output]));
  const preferredNodeIds = selectedOutputs.map(output => String(output.nodeId || output.id));
  const orderedNodeIds = [
    ...preferredNodeIds,
    ...Object.keys(historyRecord?.outputs || {}).filter(nodeId => !preferredNodeIds.includes(String(nodeId)))
  ];
  const files = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    const selectedOutput = selectedOutputsByNodeId.get(String(nodeId));
    const expectedType = normalizeComfyValueType(selectedOutput?.valueType, getDefaultComfyValueType(selectedOutput, true));

    for (const [outputKey, outputValue] of Object.entries(nodeOutput || {})) {
      if (!Array.isArray(outputValue)) {
        continue;
      }

      for (const file of outputValue) {
        let normalizedFile = null;

        if (typeof file === 'string' && file.trim()) {
          normalizedFile = {
            filename: path.basename(file.trim()),
            absolutePath: file.trim()
          };
        } else if (file && typeof file === 'object' && file.filename) {
          normalizedFile = file;
        }

        if (!normalizedFile?.filename) {
          continue;
        }

        const inferredType = inferSupportedAssetTypeFromFilename(normalizedFile.filename);
        const normalizedKey = String(outputKey || '').toLowerCase();

        if (expectedType === 'mesh') {
          if (inferredType && inferredType !== 'mesh') continue;
          if (!inferredType && !normalizedKey.includes('mesh') && normalizedKey !== 'result') continue;
        }

        if (expectedType === 'image') {
          if (inferredType && inferredType !== 'image') continue;
          if (!inferredType && !normalizedKey.includes('image')) continue;
        }

        files.push({
          nodeId,
          outputKey,
          expectedType,
          ...normalizedFile
        });

app.post('/api/meshes/texture', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, meshSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh texturing currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectMeshSource(Number(projectId), meshSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'mesh') {
      return res.status(404).json({ error: 'Source mesh not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Texturing',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh texturing request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-texturing',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-texturing');
    const sourceFilePath = toAbsoluteStoragePath(resolvedSource.inputFilePath);
    const sourceBuffer = await fs.readFile(sourceFilePath);
    const meshMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      meshBase64: sourceBuffer.toString('base64'),
      meshMimeType,
      meshFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'mesh.glb')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh texturing request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const storedFilePath = toStoredAssetPath('mesh', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, meshOutput.buffer);

    const savedAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: 'mesh',
      name: trimmedName,
      filePath: storedFilePath,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now()
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh texturing API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Texturing',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh texturing API',
        currentNodeLabel: 'Mesh texturing failed',
        source: 'API',
        operationType: 'mesh-texturing',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh texturing error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh texturing API' });
  }
});
      }
    }
  }

  return files;
}

async function downloadComfyOutputFile(baseUrl, file) {
  if (file.absolutePath && path.isAbsolute(file.absolutePath)) {
    const extension = path.extname(file.filename || file.absolutePath).toLowerCase();
    const contentType = extension === '.glb'
      ? 'model/gltf-binary'
      : extension === '.gltf'
        ? 'model/gltf+json'
        : 'application/octet-stream';

    return {
      buffer: await fs.readFile(file.absolutePath),
      contentType
    };
  }

  const viewUrl = new URL(`${baseUrl}/view`);
  viewUrl.searchParams.set('filename', file.filename);
  viewUrl.searchParams.set('subfolder', file.subfolder || '');
  viewUrl.searchParams.set('type', file.type || 'output');

  const response = await fetch(viewUrl);
  if (!response.ok) {
    throw new Error('Failed to download ComfyUI output file');
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  };
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

function getExtensionFromContentType(contentType = '', fallback = 'bin') {
  const normalized = String(contentType || '').toLowerCase();

  if (normalized.includes('model/gltf-binary')) return 'glb';
  if (normalized.includes('model/gltf+json')) return 'gltf';
  if (normalized.includes('model/obj') || normalized.includes('application/x-tgif')) return 'obj';
  if (normalized.includes('application/octet-stream')) return fallback;
  if (normalized.includes('application/json')) return 'json';

  return fallback;
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

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function getImageDimensionsFromBuffer(buffer, { filename = '', mimeType = '' } = {}) {
  if (!buffer || buffer.length < 10) {
    return { width: 0, height: 0 };
  }

  const extension = path.extname(String(filename || '')).toLowerCase();
  const normalizedMimeType = String(mimeType || '').toLowerCase();

  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    };
  }

  if ((extension === '.bmp' || normalizedMimeType === 'image/bmp') && buffer.length >= 26) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22))
    };
  }

  if ((extension === '.webp' || normalizedMimeType === 'image/webp') && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunkType = buffer.toString('ascii', 12, 16);

    if (chunkType === 'VP8X' && buffer.length >= 30) {
      return {
        width: readUInt24LE(buffer, 24) + 1,
        height: readUInt24LE(buffer, 27) + 1
      };
    }

    if (chunkType === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      };
    }

    if (chunkType === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff
      };
    }
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;

    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }

      const segmentLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);

      if (isStartOfFrame && offset + 8 < buffer.length) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5)
        };
      }

      if (!segmentLength || segmentLength < 2) {
        break;
      }

      offset += 2 + segmentLength;
    }
  }

  return { width: 0, height: 0 };
}

function formatImageResolution(width, height) {
  if (!width || !height) {
    return 'Unknown';
  }

  return `${width} x ${height}`;
}

function sanitizeAssetFolderName(value = 'image') {
  return String(value)
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function getImageEditStoredFilePath(sourceAsset, editId, extension) {
  const sourcePath = sourceAsset.filePath || sourceAsset.filename || sourceAsset.name || 'image';
  const sourceName = sanitizeAssetFolderName(path.basename(sourcePath, path.extname(sourcePath))) || 'image';
  return toStoredAssetPath('image', `images/${sourceName}/${editId}/${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`);
}

function collectInlineImageParts(responseBody) {
  return responseBody?.candidates
    ?.flatMap(candidate => candidate?.content?.parts || [])
    ?.map(part => part?.inlineData)
    ?.filter(part => part?.data) || [];
}

async function saveImageEdits({ sourceAsset, editId, name = '', imageOutputs = [] }) {
  const savedEdits = [];

  for (const [index, imageOutput] of imageOutputs.entries()) {
    const extension = imageOutput.extension || getExtensionFromMimeType(imageOutput.mimeType);
    const storedFilePath = getImageEditStoredFilePath(sourceAsset, editId, extension);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);
    const createdAt = Date.now() + index;
    const { width, height } = getImageDimensionsFromBuffer(imageOutput.buffer, {
      filename: `image.${extension}`,
      mimeType: imageOutput.mimeType
    });

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, imageOutput.buffer);

    savedEdits.push(await createAssetEditRecord({
      assetId: sourceAsset.id,
      editId,
      name,
      filePath: storedFilePath,
      width,
      height,
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

app.get('/api/comfyui/workflows/progress/:promptId', (req, res) => {
  subscribeToComfyProgress(req.params.promptId, req, res);
});

app.post('/api/comfyui/workflows/run', workflowExecutionUpload.any(), async (req, res) => {
  let executionMonitor = null;
  let processingCardId = null;
  let processingProjectId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();
  let processingWorkflowId = null;
  let processingWorkflowName = null;
  let executionPromptId = null;

  try {
    const { projectId, workflowId, cardId, name } = req.body;
    const normalizedProjectId = Number(projectId);
    const hasProjectId = Number.isFinite(normalizedProjectId) && normalizedProjectId > 0;
    const trimmedName = String(name || '').trim();
    const inputValues = JSON.parse(req.body.inputValues || '{}');
    const persistProcessingCard = String(req.body.persistProcessingCard || '').toLowerCase() !== 'false';
    const persistGeneratedAssets = String(req.body.persistGeneratedAssets || '').toLowerCase() !== 'false';

    if (!workflowId) {
      return res.status(400).json({ error: 'workflowId is required' });
    }

    if (!hasProjectId && (persistProcessingCard || persistGeneratedAssets)) {
      return res.status(400).json({ error: 'projectId is required when persisting workflow results' });
    }

    const workflowRecord = await getWorkflowRecordById(Number(workflowId));
    const workflow = workflowRecord ? await buildWorkflowResponse(workflowRecord) : null;

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    processingProjectId = hasProjectId ? normalizedProjectId : null;
    processingCardId = persistProcessingCard ? (cardId || randomUUID()) : null;
    processingCardName = trimmedName || workflow.name;
    processingWorkflowId = workflow.id;
    processingWorkflowName = workflow.name;

    const settings = await getSettings();
    const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
    const uploadedFiles = new Map((req.files || []).map(file => [file.fieldname, file]));
    const resolvedInputs = { ...inputValues };

    for (const parameter of workflow.parameters || []) {
      const parameterValueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter));
      if (!['image', 'video', 'mesh'].includes(parameterValueType)) continue;

      const fileMarker = inputValues?.[parameter.id];
      const fieldName = fileMarker?.__fileField;
      const uploadedFile = uploadedFiles.get(fieldName);

      if (uploadedFile) {
        resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, uploadedFile);
        continue;
      }

      if (['image', 'mesh'].includes(parameterValueType)) {
        if (!hasProjectId) {
          throw new Error(`A project-linked reference is required for ${parameter.name}`);
        }

        const sourceReference = isPlainObject(fileMarker)
          ? (fileMarker.source || fileMarker.filePath || fileMarker.assetId)
          : fileMarker;
        const resolvedSource = parameterValueType === 'mesh'
            ? await resolveProjectMeshSource(normalizedProjectId, sourceReference)
            : await resolveProjectImageSource(normalizedProjectId, sourceReference);

        if (!resolvedSource?.asset || resolvedSource.asset.type !== parameterValueType) {
          throw new Error(`A reference file is required for ${parameter.name}`);
        }

        const inputBuffer = await fs.readFile(toAbsoluteStoragePath(resolvedSource.inputFilePath));
        resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, {
          buffer: inputBuffer,
          mimetype: getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName),
          originalname: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName)
        });
        continue;
      }

      throw new Error(`A reference file is required for ${parameter.name}`);
    }

    const promptWorkflow = applyComfyParametersToWorkflow(workflow.workflowJson, workflow.parameters, resolvedInputs);
    const executionClientId = String(req.body.clientId || '').trim() || randomUUID();
    executionPromptId = String(req.body.promptId || '').trim() || randomUUID();
    processingStartedAt = Date.now();

    if (persistProcessingCard) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Images',
        name: processingCardName,
        status: 'processing',
        progressPercent: 0,
        detail: 'Preparing ComfyUI workflow',
        currentNodeLabel: 'Waiting for ComfyUI execution to start',
        promptId: executionPromptId,
        source: 'ComfyUI',
        operationType: 'workflow',
        workflowId: processingWorkflowId,
        workflowName: processingWorkflowName,
        startedAt: processingStartedAt
      });
    }

    executionMonitor = createComfyExecutionMonitor(baseUrl, {
      clientId: executionClientId,
      promptId: executionPromptId,
      workflowJson: promptWorkflow,
      selectedOutputs: workflow.outputs,
      onProgress: (payload) => {
        if (!persistProcessingCard) {
          return;
        }

        updateCardProcessingSnapshot(processingProjectId, processingCardId, {
          columnName: 'Images',
          name: processingCardName,
          status: payload?.status === 'error' ? 'error' : 'processing',
          progressPercent: payload?.progressPercent,
          detail: payload?.detail || 'Running ComfyUI workflow',
          currentNodeLabel: payload?.currentNodeLabel || '',
          promptId: executionPromptId,
          source: 'ComfyUI',
          operationType: 'workflow',
          workflowId: processingWorkflowId,
          workflowName: processingWorkflowName,
          startedAt: processingStartedAt
        }).catch(err => {
          console.warn('Failed to persist ComfyUI workflow progress:', err.message);
        });
      }
    });

    await executionMonitor.ready;
    publishComfyProgress(executionPromptId, {
      status: 'queued',
      progressPercent: 0,
      detail: 'Queueing ComfyUI workflow',
      currentNodeLabel: workflow.name
    });

    const { promptId: queuedPromptId } = await queueComfyPrompt(baseUrl, promptWorkflow, {
      clientId: executionClientId,
      promptId: executionPromptId
    });
    await executionMonitor.completion;
    const historyRecord = await waitForComfyHistory(baseUrl, queuedPromptId);
    const workflowFiles = getComfyHistoryFiles(historyRecord, workflow.outputs);

    if (workflowFiles.length === 0) {
      return res.status(502).json({ error: 'The ComfyUI workflow finished but no compatible files were returned' });
    }

    const imageCardId = persistProcessingCard ? processingCardId : null;
    const baseTimestamp = Date.now();
    const generatedAssets = [];

    for (const [index, workflowFile] of workflowFiles.entries()) {
      const downloadedFile = await downloadComfyOutputFile(baseUrl, workflowFile);
      const inferredAssetType = inferSupportedAssetTypeFromFilename(workflowFile.filename) || workflowFile.expectedType || 'image';
      const fallbackExtension = inferredAssetType === 'mesh'
        ? getExtensionFromContentType(downloadedFile.contentType, 'glb')
        : getExtensionFromMimeType(downloadedFile.contentType);
      const extension = path.extname(workflowFile.filename).replace('.', '') || fallbackExtension;
      const dimensions = inferredAssetType === 'image'
        ? getImageDimensionsFromBuffer(downloadedFile.buffer, {
            filename: workflowFile.filename,
            mimeType: downloadedFile.contentType
          })
        : { width: 0, height: 0 };
      const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
      const storedFilePath = toStoredAssetPath(inferredAssetType, filename);

      const generatedAssetPayload = {
        projectId: normalizedProjectId,
        type: inferredAssetType,
        name: inferredAssetType === 'mesh'
          ? processingCardName
          : createGeneratedImageName(workflow.name, extension),
        filePath: storedFilePath,
        width: dimensions.width,
        height: dimensions.height,
        metadata: {
          resolution: inferredAssetType === 'image' ? formatImageResolution(dimensions.width, dimensions.height) : 'Unknown',
          format: extension.toUpperCase(),
          source: 'COMFYUI',
          provider: 'ComfyUI',
          workflowId: workflow.id,
          workflowName: workflow.name,
          promptId: queuedPromptId,
          outputNodeId: workflowFile.nodeId,
          outputFilename: workflowFile.filename,
          savedOutputs: workflowFiles.length,
          ...(imageCardId ? { cardId: imageCardId } : {})
        },
        createdAt: baseTimestamp + index
      };

      if (persistGeneratedAssets) {
        const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

        await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
        await fs.writeFile(absoluteFilePath, downloadedFile.buffer);

        const persistedAsset = await createProjectAsset(generatedAssetPayload);
        generatedAssets.push({
          ...persistedAsset,
          url: `http://localhost:${PORT}/assets/${encodeURI(toAssetUrlPath(storedFilePath))}`,
          outputKey: workflowFile.outputKey,
          outputNodeId: workflowFile.nodeId,
          expectedType: workflowFile.expectedType,
          temporary: false
        });
        continue;
      }

      generatedAssets.push({
        type: generatedAssetPayload.type,
        name: generatedAssetPayload.name,
        filename: workflowFile.filename,
        filePath: workflowFile.filename,
        url: `data:${downloadedFile.contentType};base64,${downloadedFile.buffer.toString('base64')}`,
        width: generatedAssetPayload.width,
        height: generatedAssetPayload.height,
        metadata: generatedAssetPayload.metadata,
        createdAt: generatedAssetPayload.createdAt,
        outputKey: workflowFile.outputKey,
        outputNodeId: workflowFile.nodeId,
        expectedType: workflowFile.expectedType,
        temporary: true
      });
    }

    if (persistProcessingCard) {
      await clearCardProcessingState(processingProjectId, processingCardId, {
        name: processingCardName
      });
    }

    res.status(201).json(generatedAssets);
  } catch (err) {
    console.error('ComfyUI workflow execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Images',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to execute ComfyUI workflow',
        currentNodeLabel: 'ComfyUI execution failed',
        promptId: executionPromptId,
        source: 'ComfyUI',
        operationType: 'workflow',
        workflowId: processingWorkflowId,
        workflowName: processingWorkflowName,
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist ComfyUI workflow error state:', persistErr.message);
      });
    }
    const failedPromptId = String(req.body?.promptId || '').trim();
    if (failedPromptId) {
      publishComfyProgress(failedPromptId, {
        status: 'error',
        detail: err.message || 'Failed to execute ComfyUI workflow',
        currentNodeLabel: 'ComfyUI execution failed'
      });
    }

    res.status(500).json({ error: err.message || 'Failed to execute ComfyUI workflow' });
  } finally {
    executionMonitor?.close();
  }
});

app.post('/api/meshes/generate', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, imageSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh generation currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectImageSource(Number(projectId), imageSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'image') {
      return res.status(404).json({ error: 'Source image or edit not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Mesh Gen',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh generation request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-generation',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-generation');
    const sourceFilePath = toAbsoluteStoragePath(resolvedSource.inputFilePath);
    const sourceBuffer = await fs.readFile(sourceFilePath);
    const imageMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      imageBase64: sourceBuffer.toString('base64'),
      imageMimeType,
      imageFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'image.png')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh generation request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const storedFilePath = toStoredAssetPath('mesh', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, meshOutput.buffer);

    const savedAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: 'mesh',
      name: trimmedName,
      filePath: storedFilePath,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now()
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh generation API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh generation API',
        currentNodeLabel: 'Mesh generation failed',
        source: 'API',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh generation error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh generation API' });
  }
});

app.post('/api/meshes/edit', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, meshSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh edit currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectMeshSource(Number(projectId), meshSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'mesh') {
      return res.status(404).json({ error: 'Source mesh not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Mesh Edit',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh edit request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-edit',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-edit');
    const sourceFilePath = toAbsoluteStoragePath(resolvedSource.inputFilePath);
    const sourceBuffer = await fs.readFile(sourceFilePath);
    const meshMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      meshBase64: sourceBuffer.toString('base64'),
      meshMimeType,
      meshFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'mesh.glb')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh edit request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const storedFilePath = toStoredAssetPath('mesh', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, meshOutput.buffer);

    const savedAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: 'mesh',
      name: trimmedName,
      filePath: storedFilePath,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now()
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh edit API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Edit',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh edit API',
        currentNodeLabel: 'Mesh edit failed',
        source: 'API',
        operationType: 'mesh-edit',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh edit error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh edit API' });
  }
});

app.post('/api/meshes/texture', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, meshSource, cardId } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();

    if (!projectId || !selectedApi || !trimmedPrompt || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    if (!String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh texturing currently supports custom APIs only' });
    }

    const resolvedSource = await resolveProjectMeshSource(Number(projectId), meshSource);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'mesh') {
      return res.status(404).json({ error: 'Source mesh not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Texturing',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting mesh texturing request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'mesh-texturing',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const customApi = getCustomApiConfig(settings, selectedApi, 'mesh-texturing');
    const sourceFilePath = toAbsoluteStoragePath(resolvedSource.inputFilePath);
    const sourceBuffer = await fs.readFile(sourceFilePath);
    const meshMimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const replacements = {
      prompt: trimmedPrompt,
      name: trimmedName,
      projectId: String(projectId),
      cardId: String(processingCardId || ''),
      meshBase64: sourceBuffer.toString('base64'),
      meshMimeType,
      meshFilename: path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'mesh.glb')
    };
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...replaceTemplatePlaceholders(parseJsonTemplate(customApi.headers, 'Custom API headers', {}), replacements)
    };
    const requestPayload = replaceTemplatePlaceholders(parseJsonTemplate(customApi.body, 'Custom API body template', {}), replacements);

    const response = await fetch(customApi.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    let responseBody = null;
    const responseContentType = response.headers.get('content-type') || '';
    if (String(responseContentType).toLowerCase().includes('application/json')) {
      responseBody = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: responseBody?.error?.message || responseBody?.error || 'Mesh texturing request failed'
      });
    }

    const meshOutput = await extractMeshOutputFromApiResponse(response, responseBody);
    const extension = path.extname(meshOutput.filename).replace('.', '') || getExtensionFromContentType(meshOutput.contentType, 'glb');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const storedFilePath = toStoredAssetPath('mesh', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, meshOutput.buffer);

    const savedAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: 'mesh',
      name: trimmedName,
      filePath: storedFilePath,
      metadata: {
        format: extension.toUpperCase(),
        source: 'API',
        provider: customApi.name,
        prompt: trimmedPrompt,
        cardId: processingCardId
      },
      createdAt: Date.now()
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(savedAsset);
  } catch (err) {
    console.error('Mesh texturing API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Texturing',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run mesh texturing API',
        currentNodeLabel: 'Mesh texturing failed',
        source: 'API',
        operationType: 'mesh-texturing',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist mesh texturing error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run mesh texturing API' });
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

app.get('/api/cards', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectCards(Number(projectId)));
  } catch (err) {
    console.error('Failed to list project cards:', err);
    res.status(500).json({ error: 'Failed to list project cards' });
  }
});

app.get('/api/graph/nodes', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectNodes(Number(projectId)));
  } catch (err) {
    console.error('Failed to list graph nodes:', err);
    res.status(500).json({ error: err.message || 'Failed to list graph nodes' });
  }
});

app.post('/api/graph/nodes', async (req, res) => {
  try {
    const { projectId, nodeTypeId, nodeTypeName, name, xPos, yPos, assetId, status, progress, metadata } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.status(201).json(await createProjectNode({
      projectId: Number(projectId),
      nodeTypeId: nodeTypeId ? Number(nodeTypeId) : null,
      nodeTypeName,
      name,
      xPos,
      yPos,
      assetId,
      status,
      progress,
      metadata
    }));
  } catch (err) {
    console.error('Failed to create graph node:', err);
    res.status(500).json({ error: err.message || 'Failed to create graph node' });
  }
});

app.put('/api/graph/nodes/:id/position', async (req, res) => {
  try {
    const { projectId, xPos, yPos } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await updateProjectNodePosition(Number(projectId), Number(req.params.id), { xPos, yPos }));
  } catch (err) {
    console.error('Failed to update graph node position:', err);
    res.status(500).json({ error: err.message || 'Failed to update graph node position' });
  }
});

app.put('/api/graph/nodes/:id', async (req, res) => {
  try {
    const { projectId, name, assetId, status, progress, metadata } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await updateProjectNode(Number(projectId), Number(req.params.id), {
      name,
      assetId,
      status,
      progress,
      metadata
    }));
  } catch (err) {
    console.error('Failed to update graph node:', err);
    res.status(500).json({ error: err.message || 'Failed to update graph node' });
  }
});

app.delete('/api/graph/nodes/:id', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    await deleteProjectNode(Number(projectId), Number(req.params.id));
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete graph node:', err);
    res.status(500).json({ error: err.message || 'Failed to delete graph node' });
  }
});

app.get('/api/graph/connections', async (req, res) => {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await listProjectConnections(Number(projectId)));
  } catch (err) {
    console.error('Failed to list graph connections:', err);
    res.status(500).json({ error: err.message || 'Failed to list graph connections' });
  }
});

app.post('/api/graph/connections', async (req, res) => {
  try {
    const { projectId, sourceNodeId, targetNodeId, inputId, outputId } = req.body;

    if (!projectId || !sourceNodeId || !targetNodeId) {
      return res.status(400).json({ error: 'projectId, sourceNodeId, and targetNodeId are required' });
    }

    res.status(201).json(await createProjectConnection(Number(projectId), {
      sourceNodeId,
      targetNodeId,
      inputId,
      outputId
    }));
  } catch (err) {
    console.error('Failed to create graph connection:', err);
    res.status(500).json({ error: err.message || 'Failed to create graph connection' });
  }
});

app.delete('/api/graph/connections', async (req, res) => {
  try {
    const { projectId, sourceNodeId, targetNodeId, inputId, outputId } = req.query;

    if (!projectId || !sourceNodeId || !targetNodeId) {
      return res.status(400).json({ error: 'projectId, sourceNodeId, and targetNodeId are required' });
    }

    const result = await deleteProjectConnection(Number(projectId), {
      sourceNodeId,
      targetNodeId,
      inputId,
      outputId
    });

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Connection not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete graph connection:', err);
    res.status(500).json({ error: err.message || 'Failed to delete graph connection' });
  }
});

app.get('/api/assets/library', async (req, res) => {
  try {
    const [images, meshes, brushes] = await Promise.all([
      listLibraryAssetsByType('image', PORT),
      listLibraryAssetsByType('mesh', PORT),
      listLibraryAssetsByType('brush', PORT)
    ]);
    res.json({ images, meshes, brushes });
  } catch (err) {
    console.error('Failed to list asset library:', err);
    res.status(500).json({ error: 'Failed to list asset library' });
  }
});

app.delete('/api/assets/library', async (req, res) => {
  try {
    const { type, filename, force } = req.query;

    if (!type || !filename) {
      return res.status(400).json({ error: 'type and filename are required' });
    }

    const result = await deleteLibraryAssetByFilePath(String(type), String(filename), {
      force: String(force || '').toLowerCase() === 'true'
    });

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

    const overrideAssetType = (() => {
      const requested = String(req.query?.assetType || req.body?.assetType || '').toLowerCase();
      return ['image', 'mesh', 'brush'].includes(requested) ? requested : null;
    })();

    await Promise.all(files.map(async (file, index) => {
      let assetType = overrideAssetType;
      if (!assetType) {
        assetType = inferSupportedAssetTypeFromFilename(file.originalname);
      } else if (assetType === 'brush') {
        // Brushes must be PNG images
        const extension = path.extname(file.originalname).toLowerCase();
        if (extension !== '.png') {
          skipped.push({ name: file.originalname, reason: 'Brushes must be PNG files' });
          return;
        }
      }

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
      const dimensions = (assetType === 'image' || assetType === 'brush')
        ? getImageDimensionsFromBuffer(file.buffer, { filename: file.originalname, mimeType: file.mimetype })
        : { width: 0, height: 0 };

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
        width: dimensions.width,
        height: dimensions.height,
        metadata: {
          resolution: (assetType === 'image' || assetType === 'brush') ? formatImageResolution(dimensions.width, dimensions.height) : 'Unknown',
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
    const inputMetadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
    const dimensions = assetType === 'image'
      ? getImageDimensionsFromBuffer(await fs.readFile(req.file.path), { filename: req.file.originalname, mimeType: req.file.mimetype })
      : { width: 0, height: 0 };
    const newAsset = await createProjectAsset({
      projectId: Number(req.body.projectId),
      type: assetType,
      name: req.body.name || req.file.originalname,
      filePath: toStoredAssetPath(assetType, req.file.filename),
      width: dimensions.width,
      height: dimensions.height,
      metadata: {
        ...inputMetadata,
        resolution: assetType === 'image'
          ? formatImageResolution(dimensions.width, dimensions.height)
          : (inputMetadata.resolution || 'Unknown')
      },
      createdAt: Date.now()
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Upload recording failed:', err);
    if (err.message?.startsWith('Project not found:')) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (err.message === 'A valid projectId is required') {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: 'Upload recording failed' });
  }
});

app.post('/api/assets/:id/thumbnail', thumbnailUpload.single('thumbnail'), async (req, res) => {
  try {
    const assetId = Number(req.params.id);

    if (!assetId) {
      return res.status(400).json({ error: 'A valid asset id is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No thumbnail provided' });
    }

    const thumbnailFilename = createLibraryThumbnailFilename(req.file.originalname || `asset-${assetId}.png`);
    const thumbnailPath = toStoredThumbnailPath(thumbnailFilename);
    const absoluteThumbnailPath = toAbsoluteStoragePath(thumbnailPath);

    await fs.mkdir(path.dirname(absoluteThumbnailPath), { recursive: true });
    await fs.writeFile(absoluteThumbnailPath, req.file.buffer);

    const updatedAsset = await updateAssetThumbnail(assetId, thumbnailPath);

    if (!updatedAsset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(updatedAsset);
  } catch (err) {
    console.error('Failed to upload asset thumbnail:', err);
    res.status(500).json({ error: 'Failed to upload asset thumbnail' });
  }
});

app.post('/api/meshes/editor/save', meshEditorSaveUpload.single('meshFile'), async (req, res) => {
  try {
    const { assetId, filePath, name, saveMode = 'replace' } = req.body || {};
    const meshFile = req.file;

    if (!meshFile?.buffer?.length) {
      return res.status(400).json({ error: 'meshFile is required' });
    }

    if (!assetId && !filePath) {
      return res.status(400).json({ error: 'assetId or filePath is required' });
    }

    if (!['replace', 'version'].includes(saveMode)) {
      return res.status(400).json({ error: 'saveMode must be replace or version' });
    }

    const sourceAsset = await resolveEditableMeshAsset({ assetId, filePath });

    if (!sourceAsset) {
      return res.status(404).json({ error: 'Mesh asset not found' });
    }

    if (String(sourceAsset.assetTypeName || '').toLowerCase() !== 'mesh') {
      return res.status(400).json({ error: 'Selected asset is not a mesh' });
    }

    const nextName = sanitizeDisplayName(name || sourceAsset.name, sourceAsset.name || 'Mesh');
    const sourceExtension = path.extname(String(sourceAsset.filePath || '')).toLowerCase();
    const storedMeshPath = saveMode === 'version'
      ? toStoredAssetPath('mesh', createMeshEditorFilePath(nextName))
      : (sourceExtension === '.glb'
          ? toStoredAssetPath('mesh', sourceAsset.filePath)
          : toStoredAssetPath('mesh', createMeshEditorFilePath(nextName)));
    const absoluteMeshPath = toAbsoluteStoragePath(storedMeshPath);

    await fs.mkdir(path.dirname(absoluteMeshPath), { recursive: true });
    await fs.writeFile(absoluteMeshPath, meshFile.buffer);

    const metadata = {
      ...JSON.parse(sourceAsset.metadata || '{}'),
      source: 'MESH EDITOR',
      editedAt: Date.now(),
      savedFromAssetId: sourceAsset.id,
      saveMode
    };

    const savedAsset = saveMode === 'version'
      ? await createAssetVersion({
          assetId: sourceAsset.id,
          name: nextName,
          type: 'mesh',
          filePath: storedMeshPath,
          width: 0,
          height: 0,
          metadata,
          createdAt: Date.now()
        })
      : await replaceAssetFileById(sourceAsset.id, {
          name: nextName,
          type: 'mesh',
          filePath: storedMeshPath,
          width: 0,
          height: 0,
          metadata
        });

    if (saveMode === 'replace' && sourceAsset.filePath && sourceAsset.filePath !== storedMeshPath) {
      await fs.rm(toAbsoluteStoragePath(sourceAsset.filePath), { force: true }).catch(() => null);
    }

    res.status(saveMode === 'version' ? 201 : 200).json(savedAsset);
  } catch (err) {
    console.error('Failed to save mesh editor result:', err);
    res.status(500).json({ error: err.message || 'Failed to save mesh editor result' });
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
      width: libraryAsset?.width ?? 0,
      height: libraryAsset?.height ?? 0,
      metadata: {
        ...(metadata || {}),
        resolution: assetType === 'image'
          ? formatImageResolution(libraryAsset?.width ?? 0, libraryAsset?.height ?? 0)
          : 'Unknown',
        format: path.extname(storedFilePath).replace('.', '').toUpperCase() || assetType.toUpperCase(),
        source: 'ASSET LIB'
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
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, assetId, selectedApi, prompt, name, imageSource } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !selectedApi || !prompt?.trim() || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    const resolvedSource = await resolveProjectImageSource(Number(projectId), imageSource || assetId);
    const sourceAsset = resolvedSource?.asset;
    if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'image') {
      return res.status(404).json({ error: 'Source image or edit not found' });
    }

    processingProjectId = Number(projectId);
    processingCardId = sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Image Edit',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting image edit request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'image-edit',
      startedAt: processingStartedAt
    });

    const settings = await getSettings();
    const googleSettings = settings?.apis?.google;
    const googleGenerationSettings = googleSettings?.imageGeneration;
    const openAiSettings = settings?.apis?.openai;
    const openAiEditSettings = openAiSettings?.imageEdit;

    const sourceFilePath = toAbsoluteStoragePath(resolvedSource.inputFilePath);
    const sourceBuffer = await fs.readFile(sourceFilePath);
    const mimeType = getMimeTypeFromFilename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName);
    const trimmedPrompt = String(prompt).trim();
    let response;
    let responseBody;
    let imageOutputs;
    let providerName;

    if (selectedApi.startsWith('openai')) {
      if (!openAiSettings?.apiKey) {
        return res.status(400).json({ error: 'OpenAI API key is not configured in settings' });
      }

      const modelConfig = openAiEditSettings?.models?.[selectedApi];
      if (!openAiEditSettings?.url || !modelConfig?.model) {
        return res.status(400).json({ error: `Unsupported image edit API: ${selectedApi}` });
      }

      const requestHeaders = replaceTemplatePlaceholders(openAiEditSettings?.headers || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt,
        model: modelConfig.model
      });
      const requestPayload = replaceTemplatePlaceholders(openAiEditSettings?.payloadTemplate || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt,
        model: modelConfig.model
      });
      const formData = new FormData();
      const imageBlob = new Blob([sourceBuffer], { type: mimeType || 'image/png' });

      formData.append('image', imageBlob, path.basename(resolvedSource.inputFilePath || resolvedSource.inputFilename || resolvedSource.inputName || 'image.png'));
      Object.entries(requestPayload || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          formData.append(key, String(value));
        }
      });

      response = await fetch(openAiEditSettings.url, {
        method: 'POST',
        headers: requestHeaders,
        body: formData
      });

      responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          error: responseBody?.error?.message || responseBody?.error || 'Image edit request failed'
        });
      }

      const imageBase64 = responseBody?.data?.[0]?.b64_json;
      if (!imageBase64) {
        return res.status(502).json({ error: 'Image edit succeeded but no image data was returned' });
      }

      imageOutputs = [{
        buffer: Buffer.from(imageBase64, 'base64'),
        mimeType: 'image/png',
        extension: 'png'
      }];
      providerName = modelConfig.name;
    } else {
      const modelConfig = googleGenerationSettings?.models?.[selectedApi];

      if (!modelConfig?.url) {
        return res.status(400).json({ error: `Unsupported image edit API: ${selectedApi}` });
      }

      if (!googleSettings?.apiKey) {
        return res.status(400).json({ error: 'Google API key is not configured in settings' });
      }

      response = await fetch(modelConfig.url, {
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

      responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          error: responseBody?.error?.message || responseBody?.error || 'Image edit request failed'
        });
      }

      const imageParts = collectInlineImageParts(responseBody);
      if (imageParts.length === 0) {
        return res.status(502).json({ error: 'Image edit succeeded but no image data was returned' });
      }

      imageOutputs = imageParts.map(part => ({
        buffer: Buffer.from(part.data, 'base64'),
        mimeType: part.mimeType,
        extension: getExtensionFromMimeType(part.mimeType)
      }));
      providerName = modelConfig.name;
    }

    const editId = randomUUID();
    const savedEdits = await saveImageEdits({
      sourceAsset,
      editId,
      name: trimmedName,
      imageOutputs
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json({
      editId,
      assetId: sourceAsset.id,
      savedEdits,
      provider: providerName
    });
  } catch (err) {
    console.error('Image edit API execution failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Image Edit',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run image edit API',
        currentNodeLabel: 'Image edit failed',
        source: 'API',
        operationType: 'image-edit',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist image edit API error state:', persistErr.message);
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run image edit API' });
  }
});

app.post('/api/image-edits/comfy', async (req, res) => {
  let executionMonitor = null;
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();
  let executionPromptId = null;
  let processingWorkflowId = null;
  let processingWorkflowName = null;

  try {
    const { projectId, assetId, workflowId, prompt, name } = req.body;
    const trimmedName = String(name || '').trim();
    const rawInputValues = isPlainObject(req.body?.inputValues) ? req.body.inputValues : {};

    if (!projectId || !workflowId || !trimmedName) {
      return res.status(400).json({ error: 'projectId, workflowId and name are required' });
    }

    const workflowRecord = await getWorkflowRecordById(Number(workflowId));
    const workflow = workflowRecord ? await buildWorkflowResponse(workflowRecord) : null;

    if (!workflow) {
      return res.status(404).json({ error: 'ComfyUI workflow not found in library' });
    }

    const imageParameters = (workflow.parameters || []).filter(parameter => normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter)) === 'image');

    if (imageParameters.length === 0) {
      return res.status(400).json({ error: 'The selected workflow must expose at least one image input' });
    }

    const firstStringParameterId = (workflow.parameters || []).find(parameter => normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter)) === 'string')?.id;

    const settings = await getSettings();
    const baseUrl = buildComfyUiBaseUrl(settings || DEFAULT_SETTINGS);
    const resolvedInputs = {};
    const referencedImageAssets = [];

    for (const parameter of workflow.parameters || []) {
      const valueType = normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(parameter));
      const providedValue = rawInputValues?.[parameter.id];

      if (valueType === 'image') {
        const sourceReference = isPlainObject(providedValue)
          ? (providedValue.source || providedValue.filePath || providedValue.assetId)
          : providedValue;

        if (!sourceReference) {
          return res.status(400).json({ error: `An image asset is required for ${parameter.name}` });
        }

        const resolvedImageSource = await resolveProjectImageSource(Number(projectId), sourceReference);
        if (!resolvedImageSource?.asset || resolvedImageSource.asset.type !== 'image') {
          return res.status(404).json({ error: `Image source not found for ${parameter.name}` });
        }

        const inputBuffer = await fs.readFile(toAbsoluteStoragePath(resolvedImageSource.inputFilePath));
        resolvedInputs[parameter.id] = await uploadComfyInputFile(baseUrl, {
          buffer: inputBuffer,
          mimetype: getMimeTypeFromFilename(resolvedImageSource.inputFilePath || resolvedImageSource.inputFilename || resolvedImageSource.inputName),
          originalname: path.basename(resolvedImageSource.inputFilePath || resolvedImageSource.inputFilename || resolvedImageSource.inputName)
        });
        referencedImageAssets.push(resolvedImageSource.asset);
        continue;
      }

      if (valueType === 'number') {
        const numericValue = Number(providedValue);
        if (providedValue === '' || providedValue === null || providedValue === undefined || Number.isNaN(numericValue)) {
          return res.status(400).json({ error: `A valid number is required for ${parameter.name}` });
        }

        resolvedInputs[parameter.id] = numericValue;
        continue;
      }

      const stringValue = String(providedValue ?? '').trim() || (parameter.id === firstStringParameterId
        ? String(prompt || '').trim()
        : '');

      if (!stringValue) {
        return res.status(400).json({ error: `A value is required for ${parameter.name}` });
      }

      resolvedInputs[parameter.id] = stringValue;
    }

    const sourceAsset = referencedImageAssets.find(item => item.id === Number(assetId)) || referencedImageAssets[0];
    if (!sourceAsset) {
      return res.status(400).json({ error: 'At least one workflow image input is required' });
    }

    processingProjectId = Number(projectId);
    processingCardId = sourceAsset.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingWorkflowId = workflow.id;
    processingWorkflowName = workflow.name;

    const promptWorkflow = applyComfyParametersToWorkflow(workflow.workflowJson, workflow.parameters, resolvedInputs);
    const executionClientId = String(req.body.clientId || '').trim() || randomUUID();
    executionPromptId = String(req.body.promptId || '').trim() || randomUUID();
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Image Edit',
      name: processingCardName,
      status: 'processing',
      progressPercent: 0,
      detail: 'Preparing ComfyUI image edit',
      currentNodeLabel: 'Waiting for ComfyUI execution to start',
      promptId: executionPromptId,
      source: 'ComfyUI',
      operationType: 'image-edit',
      workflowId: processingWorkflowId,
      workflowName: processingWorkflowName,
      startedAt: processingStartedAt
    });

    executionMonitor = createComfyExecutionMonitor(baseUrl, {
      clientId: executionClientId,
      promptId: executionPromptId,
      workflowJson: promptWorkflow,
      selectedOutputs: workflow.outputs,
      onProgress: (payload) => {
        updateCardProcessingSnapshot(processingProjectId, processingCardId, {
          columnName: 'Image Edit',
          name: processingCardName,
          status: payload?.status === 'error' ? 'error' : 'processing',
          progressPercent: payload?.progressPercent,
          detail: payload?.detail || 'Running ComfyUI image edit',
          currentNodeLabel: payload?.currentNodeLabel || '',
          promptId: executionPromptId,
          source: 'ComfyUI',
          operationType: 'image-edit',
          workflowId: processingWorkflowId,
          workflowName: processingWorkflowName,
          startedAt: processingStartedAt
        }).catch(err => {
          console.warn('Failed to persist ComfyUI image edit progress:', err.message);
        });
      }
    });

    await executionMonitor.ready;
    publishComfyProgress(executionPromptId, {
      status: 'queued',
      progressPercent: 0,
      detail: 'Queueing ComfyUI image edit',
      currentNodeLabel: workflow.name
    });

    const { promptId } = await queueComfyPrompt(baseUrl, promptWorkflow, {
      clientId: executionClientId,
      promptId: executionPromptId
    });
    await executionMonitor.completion;
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
      name: trimmedName,
      imageOutputs: downloadedImages
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
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
    executionMonitor?.close();
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Image Edit',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to run ComfyUI image edit',
        currentNodeLabel: 'ComfyUI image edit failed',
        promptId: executionPromptId,
        source: 'ComfyUI',
        operationType: 'image-edit',
        workflowId: processingWorkflowId,
        workflowName: processingWorkflowName,
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist ComfyUI image edit error state:', persistErr.message);
      });
    }
    const failedPromptId = String(req.body?.promptId || '').trim();
    if (failedPromptId) {
      publishComfyProgress(failedPromptId, {
        status: 'error',
        detail: err.message || 'Failed to run ComfyUI image edit',
        currentNodeLabel: 'ComfyUI image edit failed'
      });
    }
    res.status(500).json({ error: err.message || 'Failed to run ComfyUI image edit' });
  }
});

app.post('/api/images/generate', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const { projectId, selectedApi, prompt, name, cardId } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !selectedApi || !prompt?.trim() || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi, prompt and name are required' });
    }

    const settings = await getSettings();
    const trimmedPrompt = prompt.trim();
    processingProjectId = Number(projectId);
    processingCardId = cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
      columnName: 'Images',
      name: processingCardName,
      status: 'processing',
      progressPercent: null,
      detail: 'Submitting image generation request',
      currentNodeLabel: 'Waiting for API response',
      source: 'API',
      operationType: 'image-generation',
      startedAt: processingStartedAt
    });

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

    if (selectedApi.startsWith('openai')) {
      if (!openAiSettings?.apiKey) {
        return res.status(400).json({ error: 'OpenAI API key is not configured in settings' });
      }

      const openAiModelConfig = openAiGenerationSettings?.models?.[selectedApi];
      if (!openAiGenerationSettings?.url || !openAiModelConfig?.model) {
        return res.status(400).json({ error: `Unsupported image API: ${selectedApi}` });
      }

      const requestHeaders = replaceTemplatePlaceholders(openAiGenerationSettings?.headers || {}, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt
      });
      const requestPayload = replaceTemplatePlaceholders(openAiGenerationSettings?.payloadTemplate, {
        apiKey: openAiSettings.apiKey,
        prompt: trimmedPrompt,
        model: openAiModelConfig.model
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
      modelVersion = openAiModelConfig.model;
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
    const imageBuffer = Buffer.from(inlineData.data, 'base64');
    const dimensions = getImageDimensionsFromBuffer(imageBuffer, {
      filename: `generated.${extension}`,
      mimeType: inlineData.mimeType
    });
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const storedFilePath = toStoredAssetPath('image', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.writeFile(absoluteFilePath, imageBuffer);

    const newAsset = await createProjectAsset({
      projectId: Number(projectId),
      type: 'image',
      name: trimmedName,
      filePath: storedFilePath,
      width: dimensions.width,
      height: dimensions.height,
      metadata: {
        resolution: formatImageResolution(dimensions.width, dimensions.height),
        format: outputFormat || extension.toUpperCase(),
        source: 'AI GEN',
        provider: providerName,
        modelVersion,
        mimeType: inlineData.mimeType,
        responseId,
        usage: responseBody?.usage || responseBody?.usageMetadata || null,
        cardId: processingCardId
      },
      createdAt: Date.now()
    });

    await clearCardProcessingState(processingProjectId, processingCardId, {
      name: processingCardName
    });

    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Image generation failed:', err);
    if (processingProjectId && processingCardId) {
      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Images',
        name: processingCardName,
        status: 'error',
        progressPercent: null,
        detail: err.message || 'Failed to generate image',
        currentNodeLabel: 'Image generation failed',
        source: 'API',
        operationType: 'image-generation',
        startedAt: processingStartedAt
      }).catch(persistErr => {
        console.warn('Failed to persist image generation error state:', persistErr.message);
      });
    }
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

/* app.get('/api/system/stats', async (req, res) => {
  try {
    const [cpu, mem, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.graphics()
    ]);

    // Get the primary GPU controller
    const gpu = graphics.controllers[0] || {};
    
    res.json({
      cpu: Math.round(cpu.currentLoad),
      ram: {
        used: (mem.active / 1024 / 1024 / 1024).toFixed(1),
        total: (mem.total / 1024 / 1024 / 1024).toFixed(1),
        percent: Math.round((mem.active / mem.total) * 100)
      },
      gpu: {
        name: gpu.model || 'N/A',
        utilization: gpu.utilizationGpu || 0,
        vramUsed: gpu.vramUsage ? (gpu.vramUsage / 1024).toFixed(1) : 0,
        vramTotal: gpu.vram ? (gpu.vram / 1024).toFixed(1) : 0
      }
    });
  } catch (err) {
    console.error('System stats error:', err);
    res.status(500).json({ error: 'Failed to fetch system stats' });
  }
}); */

app.get('/api/system/stats', async (req, res) => {
  try {
    const [cpu, mem, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.graphics()
    ]);

    // 1. Better Search: Find the card with the most VRAM (usually the dedicated one)
    // This works regardless of whether it's NVIDIA, AMD, or Intel Arc.
    const gpu = graphics.controllers.reduce((prev, current) => {
      return (current.vram > (prev.vram || 0)) ? current : prev;
    }, graphics.controllers[0]);

    // 2. Universal Mapping: Check for both 'memoryUsed' (NVIDIA style) 
    // and 'vramUsage' (AMD/Standard style)
    const rawVramUsed = gpu.memoryUsed || gpu.vramUsage || 0;
    const rawVramTotal = gpu.memoryTotal || gpu.vram || 0;

    res.json({
      cpu: Math.round(cpu.currentLoad),
      ram: {
        used: (mem.active / (1024 ** 3)).toFixed(1),
        total: (mem.total / (1024 ** 3)).toFixed(1)
      },
      gpu: {
        name: gpu.model,
        vendor: gpu.vendor,
        // Convert to GB, handling the 0 case gracefully
        vramUsed: rawVramUsed > 0 ? (rawVramUsed / 1024).toFixed(1) : "0.0",
        vramTotal: rawVramTotal > 0 ? (rawVramTotal / 1024).toFixed(1) : "0.0",
        utilization: gpu.utilizationGpu || 0 
      }
    });
  } catch (err) {
    console.error('Stats Error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Start server
initializeStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 3D Gen Studio Backend running at http://localhost:${PORT}`);
    console.log(`📁 Local Workspace: ${DATA_DIR}`);
  });
});
