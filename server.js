import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import { createAssetEditRecord, createBrushChildRecord, resolveProjectImageSource, resolveProjectMeshSource } from './storage.js';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import process from 'node:process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import si from 'systeminformation';
import tencentcloudSdk from 'tencentcloud-sdk-nodejs-intl-en';
import {
  ASSETS_DIR,
  DATA_DIR,
  DEFAULT_SETTINGS,
  WORKFLOW_ASSETS_DIR,
  WIKI_ASSETS_DIR,
  THUMBNAIL_ASSETS_DIR,
  createProject,
  updateProject,
  buildProjectExport,
  importProjectExport,
  createLibraryAsset,
  createCardAttribute,
  createProjectAsset,
  createTask,
  createWorkflowRecord,
  clearCardProcessingState,
  clearStaleProcessingCards,
  deleteCard,
  deleteCardAttribute,
  deleteAssetEditByFilePath,
  deleteAssetVersionByFilePath,
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
  listWikiPages as dbListWikiPages,
  getWikiPage as dbGetWikiPage,
  moveCard,
  createProjectConnection,
  createProjectNode,
  createAssetVersion,
  findAssetByFilePath,
  getAssetRecordById,
  getPaintDocumentByAssetId,
  upsertPaintDocument,
  PAINT_DOCS_DIR,
  toStoredPaintDocPath,
  getPaintDocSubdir,
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
import {
  WIKI_MEDIA_DIR,
  wikiManifestExists,
  listWikiPages,
  getWikiPage,
  createWikiPage,
  updateWikiPage,
  deleteWikiPage,
  moveWikiPage,
  seedWikiFiles,
  importWikiPages
} from './wikiStorage.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Last-resort safety net: a single dropped stream or stray async error should
// never take the whole server down (which forced a full restart before). Log
// and keep serving; individual requests still fail on their own if broken.
process.on('uncaughtException', err => {
  console.error('Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection (server kept alive):', reason);
});

// Build the externally-reachable base URL ("http://host:port") from the
// incoming request so generated asset/media URLs point back at whatever host
// and port the client actually used to reach us — works on another machine or
// another port without baking "localhost" into responses.
function getRequestBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);
const comfyProgressSubscribers = new Map();
const comfyProgressSnapshots = new Map();
// Subscribers to the multiplexed progress stream — a single connection that
// receives progress for every promptId. This keeps a handful of concurrent
// workflows from exhausting the browser's ~6 connection-per-origin cap.
const comfyProgressGlobalSubscribers = new Set();
const TENCENT_MESH_GENERATION_API_ID = 'tencent_meshgeneration';
const TENCENT_HUNYUAN_ENDPOINT = 'hunyuan.intl.tencentcloudapi.com';
const TENCENT_HUNYUAN_VERSION = '2023-09-01';
const TENCENT_REGIONS = new Set(['ap-singapore', 'eu-frankfurt', 'na-siliconvalley']);
const TENCENT_MODEL_VERSIONS = new Set(['3.0', '3.1']);
const TENCENT_GENERATION_TYPES = new Set(['Normal', 'LowPoly', 'Geometry']);
const TENCENT_POLYGON_TYPES = new Set(['triangle', 'quadrilaterial']);
const TRIPO_MESH_GENERATION_API_ID = 'tripo_meshgeneration';
const TRIPO_API_BASE_URL = 'https://openapi.tripo3d.ai/v3';
const TRIPO_MODEL_VERSIONS = new Set(['v2.0-20240919', 'v2.5-20250123', 'v3.0-20250812', 'v3.1-20260211', 'Turbo-v1.0-20250506', 'P1-20260311']);
const TRIPO_TEXTURE_ALIGNMENT_OPTIONS = new Set(['original_image', 'geometry']);
const TRIPO_TEXTURE_QUALITY_OPTIONS = new Set(['standard', 'detailed']);
const TRIPO_ORIENTATION_OPTIONS = new Set(['default', 'align_image']);
const TRIPO_GEOMETRY_QUALITY_OPTIONS = new Set(['standard', 'detailed']);
const TRIPO_RUNNING_STATUSES = new Set(['queued', 'running']);
const TRIPO_SUCCESS_STATUS = 'success';
const TRIPO_FAILURE_STATUSES = new Set(['failed', 'banned', 'expired', 'cancelled', 'unknown']);
const HITEM_MESH_GENERATION_API_ID = 'hitem_meshgeneration';
const HITEM_API_BASE_URL = 'https://api.hitem3d.ai/open-api/v1';
const HITEM_MODEL_VERSIONS = new Set(['hitem3dv1.5', 'hitem3dv2.0', 'hitem3dv2.1']);
// Allowed resolution enum values per model (v2.1 differs from v1.5/v2.0).
const HITEM_RESOLUTIONS_BY_MODEL = {
  'hitem3dv1.5': new Set(['512', '1024', '1536', '1536pro']),
  'hitem3dv2.0': new Set(['512', '1024', '1536', '1536pro']),
  'hitem3dv2.1': new Set(['1536fast', '1536pro'])
};
const HITEM_REQUEST_TYPES = new Set([1, 3]); // 1 = Mesh Only, 3 = Textured Mesh
const HITEM_FACE_MIN = 100000;
const HITEM_FACE_MAX = 2000000;
const HITEM_FORMAT_GLB = 2; // GLB output (never surfaced in the UI)
const HITEM_RUNNING_STATUSES = new Set(['processing', 'queued', 'queueing', 'pending', 'running', 'waiting']);
const HITEM_SUCCESS_STATUS = 'success';
const HITEM_FAILURE_STATUSES = new Set(['failed', 'error', 'fail']);

console.log('DEBUG: DATA_DIR is', DATA_DIR);
console.log('DEBUG: DB_FILE is', path.join(DATA_DIR, 'app.db'));

// Middleware
app.use(cors());
app.use('/api/meshes/editor/save', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '10mb' }));
app.use('/assets', express.static(ASSETS_DIR));
app.use('/wiki-media', express.static(WIKI_MEDIA_DIR));

// Serve the production frontend build (vite build → dist/) from the same
// origin as the API, so a single `node server.js` can host the whole app on
// any machine/port. In development the Vite dev server is used instead, so
// dist/ is absent and this is skipped.
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const HAS_DIST = existsSync(DIST_DIR);
if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
}

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

app.delete('/api/assets/library/versions', async (req, res) => {
  try {
    const { filePath, force } = req.query;

    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const result = await deleteAssetVersionByFilePath(String(filePath), {
      force: String(force || '').toLowerCase() === 'true'
    });

    if (result.status === 'linked') {
      return res.status(409).json({
        error: 'Mesh version is linked to a project',
        projectId: result.projectId,
        projectName: result.projectName || null
      });
    }

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Mesh version not found' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete mesh version:', err);
    res.status(500).json({ error: err.message || 'Failed to delete mesh version' });
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
    const { name, parameters = [], outputs = [], workflowJson } = req.body;
    const existingWorkflowRecord = await getWorkflowRecordById(Number(req.params.id));

    if (!existingWorkflowRecord) {
      return res.status(404).json({ error: 'ComfyUI workflow not found' });
    }

    const existingWorkflow = await buildWorkflowResponse(existingWorkflowRecord);

    // When a new graph is supplied (overwriting an existing workflow with an
    // imported .3dgw bundle), validate the parameters/outputs against the NEW
    // graph and persist it; otherwise keep the existing graph and only update
    // its configuration.
    const replacingGraph = workflowJson !== undefined && workflowJson !== null;
    const parsedGraph = replacingGraph ? parseComfyWorkflow(workflowJson) : null;
    const availableInputsSource = replacingGraph ? parsedGraph.inputs : (existingWorkflow.availableInputs || []);
    const availableOutputsSource = replacingGraph ? parsedGraph.outputs : (existingWorkflow.availableOutputs || []);
    const availableParameters = new Map(availableInputsSource.map(input => [input.id, input]));
    const availableOutputs = new Map(availableOutputsSource.map(output => [output.nodeId, output]));
    const existingParameters = new Map((existingWorkflow.parameters || []).map(parameter => [parameter.id, parameter]));

    const nextParameters = parameters.map(parameter => {
      const sourceParameter = availableParameters.get(parameter.id);
      if (!sourceParameter) {
        throw new Error(`Unknown workflow parameter: ${parameter.id}`);
      }

      const storedParameter = existingParameters.get(parameter.id);
      // Persist the saved default: prefer an incoming defaultValue (e.g. "Set as default"),
      // otherwise keep any previously stored default, and finally fall back to the workflow file value.
      let defaultValue;
      if (Object.prototype.hasOwnProperty.call(parameter, 'defaultValue')) {
        defaultValue = coerceComfyParameterValue(sourceParameter, parameter.defaultValue);
      } else if (storedParameter && storedParameter.defaultValue !== undefined) {
        defaultValue = cloneSerializable(storedParameter.defaultValue);
      } else {
        defaultValue = cloneSerializable(sourceParameter.defaultValue);
      }

      return {
        ...sourceParameter,
        name: sanitizeDisplayName(parameter.name || sourceParameter.name, sourceParameter.name),
        valueType: normalizeComfyValueType(parameter.valueType, getDefaultComfyValueType(sourceParameter)),
        defaultValue
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

    // Persist the new graph to disk (and remember the old file for cleanup)
    // only once the configuration above has validated successfully.
    let nextFilePath;
    if (replacingGraph) {
      nextFilePath = await saveWorkflowFile(name || existingWorkflow.name, workflowJson);
    }

    const nextWorkflow = await updateWorkflowRecord(existingWorkflow.id, {
      name: sanitizeDisplayName(name || existingWorkflow.name, existingWorkflow.name),
      parameters: nextParameters,
      outputs: nextOutputs,
      ...(replacingGraph ? { filePath: nextFilePath } : {})
    });

    // Drop the superseded graph file now that the record points at the new one.
    if (replacingGraph && existingWorkflowRecord.filePath && existingWorkflowRecord.filePath !== nextFilePath) {
      try {
        await fs.unlink(toAbsoluteStoragePath(existingWorkflowRecord.filePath));
      } catch (cleanupErr) {
        console.warn('Failed to remove superseded workflow file:', cleanupErr);
      }
    }

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
const paintDocumentUpload = multer({ storage: multer.memoryStorage() });
const wikiMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 * 1024 } });

const WIKI_MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
  '.mp4', '.webm', '.ogg', '.mov', '.m4v'
]);

function buildWikiPageTree(pages) {
  const byId = new Map(pages.map(page => [page.id, { ...page, children: [] }]));
  const roots = [];
  for (const page of byId.values()) {
    if (page.parentId !== null && page.parentId !== undefined && byId.has(page.parentId)) {
      byId.get(page.parentId).children.push(page);
    } else {
      roots.push(page);
    }
  }
  const sortNodes = nodes => {
    nodes.sort((a, b) => (a.position - b.position) || (a.id - b.id));
    nodes.forEach(node => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

// ── Wiki ──────────────────────────────────────────────────────────────────
// Author mode is unlocked only when the gitignored `.wiki-author` marker file
// exists at the project root. Checked live so it can be toggled without a
// restart. Read-only installations (end users) never have this file.
const WIKI_AUTHOR_FLAG = path.join(process.cwd(), '.wiki-author');

function isWikiAuthorMode() {
  return existsSync(WIKI_AUTHOR_FLAG);
}

function requireWikiAuthor(req, res, next) {
  if (!isWikiAuthorMode()) {
    return res.status(403).json({ error: 'The Wiki is read-only on this installation.' });
  }
  next();
}

app.get('/api/wiki/config', (req, res) => {
  res.json({ authorMode: isWikiAuthorMode() });
});

app.get('/api/wiki/pages', async (req, res) => {
  try {
    const pages = await listWikiPages();
    res.json({ pages, tree: buildWikiPageTree(pages) });
  } catch (err) {
    console.error('Failed to list wiki pages:', err);
    res.status(500).json({ error: err.message || 'Failed to list wiki pages' });
  }
});

app.get('/api/wiki/pages/:id', async (req, res) => {
  try {
    const page = await getWikiPage(req.params.id);
    if (!page) {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.json(page);
  } catch (err) {
    console.error('Failed to load wiki page:', err);
    res.status(500).json({ error: err.message || 'Failed to load wiki page' });
  }
});

app.post('/api/wiki/pages', requireWikiAuthor, async (req, res) => {
  try {
    const { parentId = null, title, icon = null, content = '' } = req.body || {};
    const page = await createWikiPage({ parentId, title, icon, content });
    res.status(201).json(page);
  } catch (err) {
    console.error('Failed to create wiki page:', err);
    res.status(400).json({ error: err.message || 'Failed to create wiki page' });
  }
});

app.put('/api/wiki/pages/:id', requireWikiAuthor, async (req, res) => {
  try {
    const { title, icon, content } = req.body || {};
    const page = await updateWikiPage(req.params.id, { title, icon, content });
    if (!page) {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.json(page);
  } catch (err) {
    console.error('Failed to update wiki page:', err);
    res.status(400).json({ error: err.message || 'Failed to update wiki page' });
  }
});

app.put('/api/wiki/pages/:id/move', requireWikiAuthor, async (req, res) => {
  try {
    const { parentId, position } = req.body || {};
    const page = await moveWikiPage(req.params.id, { parentId, position });
    if (!page) {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.json(page);
  } catch (err) {
    console.error('Failed to move wiki page:', err);
    res.status(400).json({ error: err.message || 'Failed to move wiki page' });
  }
});

app.delete('/api/wiki/pages/:id', requireWikiAuthor, async (req, res) => {
  try {
    const result = await deleteWikiPage(req.params.id);
    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Wiki page not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete wiki page:', err);
    res.status(500).json({ error: err.message || 'Failed to delete wiki page' });
  }
});

app.post('/api/wiki/media', requireWikiAuthor, wikiMediaUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const extension = path.extname(req.file.originalname).toLowerCase();
    if (!WIKI_MEDIA_EXTENSIONS.has(extension)) {
      return res.status(400).json({ error: `Unsupported file type: ${extension || 'unknown'}` });
    }

    await fs.mkdir(WIKI_MEDIA_DIR, { recursive: true });
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    await fs.writeFile(path.join(WIKI_MEDIA_DIR, uniqueName), req.file.buffer);

    const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.m4v'].includes(extension);
    res.status(201).json({
      url: `${getRequestBaseUrl(req)}/wiki-media/${encodeURIComponent(uniqueName)}`,
      kind: isVideo ? 'video' : 'image',
      name: req.file.originalname
    });
  } catch (err) {
    console.error('Failed to upload wiki media:', err);
    res.status(500).json({ error: err.message || 'Failed to upload wiki media' });
  }
});

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
      tencentcloud: {
        secretId: '',
        secretKey: '',
        meshGeneration: {
          models: {
            meshgeneration: {
              name: 'Hunyuan3D Pro',
              model: 'meshgeneration'
            }
          }
        }
      },
      tripoai: {
        apiKey: '',
        meshGeneration: {
          models: {
            meshgeneration: {
              name: 'Tripo AI',
              model: 'meshgeneration'
            }
          }
        }
      },
      hitem3d: {
        accessKey: '',
        secretKey: '',
        accessToken: ''
      },
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
  startedAt = Date.now(),
  ...processingMetadata
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
      name,
      progressPercent: Number.isFinite(progressPercent) ? Math.max(0, Math.min(100, Math.round(progressPercent))) : null,
      detail,
      currentNodeLabel,
      promptId,
      source,
      operationType,
      workflowId,
      workflowName,
      startedAt,
      updatedAt: Date.now(),
      ...processingMetadata
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

function buildMeshToolsBaseUrl(settings = {}) {
  const meshSettings = settings?.apis?.meshtools || {};
  const rawUrl = String(meshSettings.url || 'http://127.0.0.1').trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const parsedUrl = new URL(normalizedUrl);
  const port = String(meshSettings.port || parsedUrl.port || '8200').trim();

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

  const serialized = `data: ${JSON.stringify(message)}\n\n`;

  for (const response of getComfyProgressSubscribers(key)) {
    response.write(serialized);
  }

  for (const response of comfyProgressGlobalSubscribers) {
    response.write(serialized);
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

function subscribeToAllComfyProgress(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  comfyProgressGlobalSubscribers.add(res);

  // Replay the latest snapshot for every in-flight prompt so a freshly opened
  // (or reconnected) stream immediately catches up on current state.
  for (const snapshot of comfyProgressSnapshots.values()) {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    comfyProgressGlobalSubscribers.delete(res);
  });
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
  const orderedNodeIds = preferredNodeIds.length > 0
    ? preferredNodeIds.filter(nodeId => historyRecord?.outputs?.[nodeId])
    : Object.keys(historyRecord?.outputs || {});

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

function isTencentMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === TENCENT_MESH_GENERATION_API_ID;
}

function getTencentCloudConfig(settings = {}) {
  const providerSettings = settings?.apis?.tencentcloud || {};

  return {
    secretId: String(providerSettings.secretId || '').trim(),
    secretKey: String(providerSettings.secretKey || '').trim(),
    meshGeneration: {
      models: {
        meshgeneration: {
          name: providerSettings?.meshGeneration?.models?.meshgeneration?.name || 'Hunyuan3D Pro',
          model: providerSettings?.meshGeneration?.models?.meshgeneration?.model || 'meshgeneration'
        }
      }
    }
  };
}

function isTripoMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === TRIPO_MESH_GENERATION_API_ID;
}

function getTripoAiConfig(settings = {}) {
  const providerSettings = settings?.apis?.tripoai || {};

  return {
    apiKey: String(providerSettings.apiKey || '').trim(),
    meshGeneration: {
      models: {
        meshgeneration: {
          name: providerSettings?.meshGeneration?.models?.meshgeneration?.name || 'Tripo AI',
          model: providerSettings?.meshGeneration?.models?.meshgeneration?.model || 'meshgeneration'
        }
      }
    }
  };
}

function normalizeTripoBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === 'true') return true;
    if (normalizedValue === 'false') return false;
  }

  return Boolean(value);
}

function normalizeTripoNullableInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.round(numericValue) : fallback;
}

function normalizeTripoMeshGenerationInput({
  prompt,
  hasImageSource = false,
  modelVersion,
  modelSeed,
  enableImageAutofix,
  faceLimit,
  texture,
  pbr,
  textureSeed,
  textureAlignment,
  textureQuality,
  autoSize,
  orientation,
  quad,
  smartLowPoly,
  generateParts,
  exportUv,
  geometryQuality
} = {}) {
  const trimmedPrompt = String(prompt || '').trim();
  const hasPrompt = Boolean(trimmedPrompt);

  const normalizedModelVersion = TRIPO_MODEL_VERSIONS.has(String(modelVersion || '').trim())
    ? String(modelVersion || '').trim()
    : 'v2.5-20250123';
  const normalizedModelSeed = normalizeTripoNullableInteger(modelSeed, null);
  const normalizedEnableImageAutofix = normalizeTripoBoolean(enableImageAutofix, false);
  const normalizedFaceLimit = normalizeTripoNullableInteger(faceLimit, null);
  const normalizedTexture = normalizeTripoBoolean(texture, true);
  const normalizedPbr = normalizeTripoBoolean(pbr, true);
  const normalizedTextureSeed = normalizeTripoNullableInteger(textureSeed, null);
  const normalizedTextureAlignment = TRIPO_TEXTURE_ALIGNMENT_OPTIONS.has(String(textureAlignment || '').trim())
    ? String(textureAlignment || '').trim()
    : 'original_image';
  const normalizedTextureQuality = TRIPO_TEXTURE_QUALITY_OPTIONS.has(String(textureQuality || '').trim())
    ? String(textureQuality || '').trim()
    : 'standard';
  const normalizedAutoSize = normalizeTripoBoolean(autoSize, false);
  const normalizedOrientation = TRIPO_ORIENTATION_OPTIONS.has(String(orientation || '').trim())
    ? String(orientation || '').trim()
    : 'default';
  const normalizedQuad = normalizeTripoBoolean(quad, false);
  const normalizedSmartLowPoly = normalizeTripoBoolean(smartLowPoly, false);
  const normalizedGenerateParts = normalizeTripoBoolean(generateParts, false);
  const normalizedExportUv = normalizeTripoBoolean(exportUv, true);
  const normalizedGeometryQuality = TRIPO_GEOMETRY_QUALITY_OPTIONS.has(String(geometryQuality || '').trim())
    ? String(geometryQuality || '').trim()
    : 'standard';
  const isP1Model = normalizedModelVersion === 'P1-20260311';
  const effectiveEnableImageAutofix = isP1Model ? false : normalizedEnableImageAutofix;
  const effectiveTextureAlignment = isP1Model ? 'original_image' : normalizedTextureAlignment;
  const effectiveOrientation = isP1Model ? 'default' : normalizedOrientation;
  const effectiveQuad = isP1Model ? false : normalizedQuad;
  const effectiveSmartLowPoly = isP1Model ? false : normalizedSmartLowPoly;
  const effectiveGenerateParts = isP1Model ? false : normalizedGenerateParts;
  const effectiveGeometryQuality = isP1Model ? 'standard' : normalizedGeometryQuality;

  if (hasPrompt === hasImageSource) {
    throw new Error('Provide either a prompt or an image input for Tripo AI mesh generation');
  }

  if (normalizedFaceLimit !== null && normalizedFaceLimit < 1000) {
    throw new Error('Tripo AI face_limit must be at least 1000 when provided');
  }

  if (effectiveGenerateParts && (normalizedTexture || normalizedPbr || effectiveQuad)) {
    throw new Error('Tripo AI generate_parts is not compatible with texture=true, pbr=true, or quad=true');
  }

  const supportsGeometryQuality = normalizedModelVersion === 'v3.0-20250812'
    || normalizedModelVersion === 'v3.1-20260211';

  return {
    trimmedPrompt,
    hasPrompt,
    hasImageSource,
    normalizedModelVersion,
    normalizedModelSeed,
    normalizedEnableImageAutofix: effectiveEnableImageAutofix,
    normalizedFaceLimit,
    normalizedTexture,
    normalizedPbr,
    normalizedTextureSeed,
    normalizedTextureAlignment: effectiveTextureAlignment,
    normalizedTextureQuality,
    normalizedAutoSize,
    normalizedOrientation: effectiveOrientation,
    normalizedQuad: effectiveQuad,
    normalizedSmartLowPoly: effectiveSmartLowPoly,
    normalizedGenerateParts: effectiveGenerateParts,
    normalizedExportUv,
    normalizedGeometryQuality: effectiveGeometryQuality,
    supportsGeometryQuality,
    isP1Model
  };
}

async function uploadTripoImageAndGetToken(apiKey, imageBuffer, inputFilePath = '') {
  if (!apiKey) {
    throw new Error('Tripo AI API Key is required');
  }

  if (!imageBuffer) {
    throw new Error('Tripo AI image upload requires an input image');
  }

  const extension = path.extname(String(inputFilePath || '')).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  const uploadFilename = path.basename(inputFilePath || `input${extension || '.png'}`);
  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer], { type: mimeType }), uploadFilename);

  console.log('[TripoAI][UploadFile] request payload:', JSON.stringify({
    filename: uploadFilename,
    mimeType,
    sizeBytes: imageBuffer.length
  }, null, 2));

  const response = await fetch(`${TRIPO_API_BASE_URL}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  const responseBody = await response.json().catch(() => ({}));
  console.log('[TripoAI][UploadFile] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 0) {
    throw new Error(responseBody?.message || responseBody?.msg || 'Failed to upload source image to Tripo AI');
  }

  const fileToken = String(responseBody?.data?.file_token || '').trim();

  if (!fileToken) {
    throw new Error('Tripo AI image upload succeeded but file_token was missing');
  }

  return fileToken;
}

async function submitTripoMeshGenerationTask(settings, {
  prompt = '',
  imageBuffer = null,
  inputFilePath = '',
  modelVersion,
  modelSeed,
  enableImageAutofix,
  faceLimit,
  texture,
  pbr,
  textureSeed,
  textureAlignment,
  textureQuality,
  autoSize,
  orientation,
  quad,
  smartLowPoly,
  generateParts,
  exportUv,
  geometryQuality
} = {}) {
  const providerConfig = getTripoAiConfig(settings);
  if (!providerConfig.apiKey) {
    throw new Error('Tripo AI API Key is required');
  }

  const validatedInput = normalizeTripoMeshGenerationInput({
    prompt,
    hasImageSource: Boolean(imageBuffer),
    modelVersion,
    modelSeed,
    enableImageAutofix,
    faceLimit,
    texture,
    pbr,
    textureSeed,
    textureAlignment,
    textureQuality,
    autoSize,
    orientation,
    quad,
    smartLowPoly,
    generateParts,
    exportUv,
    geometryQuality
  });

  let fileToken = null;
  if (validatedInput.hasImageSource) {
    fileToken = await uploadTripoImageAndGetToken(providerConfig.apiKey, imageBuffer, inputFilePath);
  }

  const taskPayload = {
    type: validatedInput.hasImageSource ? 'image_to_model' : 'text_to_model',
    model_version: validatedInput.normalizedModelVersion,
    texture: validatedInput.normalizedTexture,
    pbr: validatedInput.normalizedPbr,
    texture_quality: validatedInput.normalizedTextureQuality,
    auto_size: validatedInput.normalizedAutoSize,
    export_uv: validatedInput.normalizedExportUv
  };

  if (!validatedInput.isP1Model) {
    taskPayload.enable_image_autofix = validatedInput.normalizedEnableImageAutofix;
    taskPayload.texture_alignment = validatedInput.normalizedTextureAlignment;
    taskPayload.orientation = validatedInput.normalizedOrientation;
    taskPayload.quad = validatedInput.normalizedQuad;
    taskPayload.smart_low_poly = validatedInput.normalizedSmartLowPoly;
    taskPayload.generate_parts = validatedInput.normalizedGenerateParts;
  }

  if (validatedInput.hasImageSource) {
    taskPayload.file = {
      type: path.extname(String(inputFilePath || '')).toLowerCase().includes('jpg') ? 'jpg' : 'png',
      file_token: fileToken
    };
  } else {
    taskPayload.prompt = validatedInput.trimmedPrompt;
  }

  if (validatedInput.normalizedModelSeed !== null) taskPayload.model_seed = validatedInput.normalizedModelSeed;
  if (validatedInput.normalizedFaceLimit !== null) taskPayload.face_limit = validatedInput.normalizedFaceLimit;
  if (validatedInput.normalizedTextureSeed !== null) taskPayload.texture_seed = validatedInput.normalizedTextureSeed;
  if (!validatedInput.isP1Model && validatedInput.supportsGeometryQuality) {
    taskPayload.geometry_quality = validatedInput.normalizedGeometryQuality;
  }

  // v3 routes text vs image generation to separate endpoints (v2 used a single
  // /task endpoint discriminated by the `type` field).
  const submitEndpoint = validatedInput.hasImageSource
    ? `${TRIPO_API_BASE_URL}/generation/image-to-model`
    : `${TRIPO_API_BASE_URL}/generation/text-to-model`;

  console.log('[TripoAI][SubmitTask] request payload:', JSON.stringify(createTripoDebugPayload(taskPayload), null, 2));

  const response = await fetch(submitEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(taskPayload)
  });

  const responseBody = await response.json().catch(() => ({}));
  console.log('[TripoAI][SubmitTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 0) {
    throw new Error(responseBody?.message || responseBody?.msg || 'Tripo AI task submission failed');
  }

  const taskId = String(responseBody?.data?.task_id || '').trim();
  if (!taskId) {
    console.error('[TripoAI][SubmitTask] missing task_id in response payload:', JSON.stringify(responseBody || {}, null, 2));
    throw new Error('Tripo AI task submission succeeded but task_id was missing');
  }

  return {
    taskId,
    fileToken,
    requestPayload: taskPayload,
    validatedInput
  };
}

async function queryTripoMeshGenerationTask(settings, { taskId } = {}) {
  const providerConfig = getTripoAiConfig(settings);
  if (!providerConfig.apiKey) {
    throw new Error('Tripo AI API Key is required');
  }

  console.log('[TripoAI][QueryTask] request payload:', JSON.stringify({
    taskId: String(taskId || '').trim()
  }, null, 2));

  const response = await fetch(`${TRIPO_API_BASE_URL}/tasks/${encodeURIComponent(String(taskId || '').trim())}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${providerConfig.apiKey}`
    }
  });

  const responseBody = await response.json().catch(() => ({}));
  console.log('[TripoAI][QueryTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 0) {
    throw new Error(responseBody?.message || responseBody?.msg || 'Failed to query Tripo AI task status');
  }

  const taskData = responseBody?.data || {};
  const status = String(taskData.status || '').trim().toLowerCase() || 'unknown';

  const normalizedTaskResult = {
    taskId: String(taskData.task_id || taskId || '').trim(),
    status,
    progress: Number(taskData.progress),
    errorMessage: String(taskData.error_message || '').trim(),
    output: isPlainObject(taskData.output) ? taskData.output : {}
  };

  console.log('[TripoAI][QueryTask] parsed result:', JSON.stringify(normalizedTaskResult, null, 2));

  return normalizedTaskResult;
}

async function downloadTripoMeshResult(output = {}) {
  // v3 returns a single `model_url`; the older v2 fields are kept as fallbacks.
  const modelUrlV3 = String(output?.model_url || '').trim();
  const pbrModelUrl = String(output?.pbr_model || '').trim();
  const modelUrl = String(output?.model || '').trim();
  const baseModelUrl = String(output?.base_model || '').trim();
  const selectedUrl = modelUrlV3 || pbrModelUrl || modelUrl || baseModelUrl;

  if (!selectedUrl) {
    throw new Error('Tripo AI task succeeded but no model URL was returned');
  }

  const response = await fetch(selectedUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Tripo AI mesh result (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(getFilenameFromUrl(selectedUrl, '')).replace('.', '') || getExtensionFromContentType(contentType, 'glb');
  const filename = getFilenameFromUrl(selectedUrl, `generated_mesh.${extension}`);

  return {
    url: selectedUrl,
    contentType,
    extension,
    filename,
    buffer,
    isPbr: Boolean(pbrModelUrl)
  };
}

function isHitemMeshGenerationApi(selectedApi = '') {
  return String(selectedApi || '').trim() === HITEM_MESH_GENERATION_API_ID;
}

function getHitem3dConfig(settings = {}) {
  const providerSettings = settings?.apis?.hitem3d || {};

  return {
    accessKey: String(providerSettings.accessKey || '').trim(),
    secretKey: String(providerSettings.secretKey || '').trim(),
    accessToken: String(providerSettings.accessToken || '').trim()
  };
}

// Requests a fresh Hitem3D access token from the Access/Secret key pair and
// persists it back onto the settings so subsequent calls can reuse it. The
// docs do not mention an expiry, so we cache it and only re-request on demand
// (e.g. when a request returns an authentication error).
async function requestHitem3dAccessToken(providerConfig) {
  if (!providerConfig.accessKey || !providerConfig.secretKey) {
    throw new Error('Hitem3D Access Key and Secret Key are required');
  }

  const authValue = Buffer.from(`${providerConfig.accessKey}:${providerConfig.secretKey}`).toString('base64');

  const response = await fetch(`${HITEM_API_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authValue}`,
      'Content-Type': 'application/json'
    }
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok || Number(responseBody?.code) !== 200) {
    throw new Error(responseBody?.msg || responseBody?.message || 'Failed to obtain Hitem3D access token');
  }

  const accessToken = String(responseBody?.data?.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('Hitem3D authentication succeeded but no access token was returned');
  }

  return accessToken;
}

// Returns a usable Hitem3D access token, persisting a freshly minted one back
// onto the settings record. Pass `forceRefresh` to bypass the cached token
// (used when a downstream request rejects the cached token as unauthorized).
async function getHitem3dAccessToken(settings, { forceRefresh = false } = {}) {
  const providerConfig = getHitem3dConfig(settings);

  if (!forceRefresh && providerConfig.accessToken) {
    return providerConfig.accessToken;
  }

  const accessToken = await requestHitem3dAccessToken(providerConfig);

  try {
    const latestSettings = await getSettings();
    await saveSettings({
      ...latestSettings,
      apis: {
        ...latestSettings?.apis,
        hitem3d: {
          ...latestSettings?.apis?.hitem3d,
          accessToken
        }
      }
    });
  } catch (persistErr) {
    console.warn('Failed to persist Hitem3D access token:', persistErr.message);
  }

  return accessToken;
}

// Detects whether a Hitem3D response indicates the access token is bad/expired,
// so the caller can mint a fresh token and retry. Hitem wraps most responses in
// HTTP 200 with a body `code`/`msg`, so besides HTTP 401/403 and body code
// 401/403 we also match token/auth-related messages (e.g. "invalid token",
// "token expired", "unauthorized").
function isHitemAuthError(response, responseBody) {
  const code = Number(responseBody?.code);
  if (response?.status === 401 || response?.status === 403 || code === 401 || code === 403) {
    return true;
  }

  const message = String(responseBody?.msg || responseBody?.message || '').toLowerCase();
  if (!message) {
    return false;
  }

  return message.includes('token')
    || message.includes('unauthorized')
    || message.includes('unauthenticated')
    || message.includes('invalid credential')
    || message.includes('expired');
}

function normalizeHitemMeshGenerationInput({
  hasImageSource = false,
  model,
  resolution,
  requestType,
  face,
  pbr
} = {}) {
  const normalizedModel = HITEM_MODEL_VERSIONS.has(String(model || '').trim())
    ? String(model || '').trim()
    : 'hitem3dv2.1';

  const allowedResolutions = HITEM_RESOLUTIONS_BY_MODEL[normalizedModel] || HITEM_RESOLUTIONS_BY_MODEL['hitem3dv2.1'];
  const requestedResolution = String(resolution || '').trim();
  const normalizedResolution = allowedResolutions.has(requestedResolution)
    ? requestedResolution
    : (normalizedModel === 'hitem3dv2.1' ? '1536pro' : '1024');

  const requestedType = Number(requestType);
  const normalizedRequestType = HITEM_REQUEST_TYPES.has(requestedType) ? requestedType : 3;

  const requestedFace = Number(face);
  const normalizedFace = Number.isFinite(requestedFace)
    ? Math.max(HITEM_FACE_MIN, Math.min(HITEM_FACE_MAX, Math.round(requestedFace)))
    : 300000;

  const normalizedPbr = normalizeTripoBoolean(pbr, false) ? 1 : 0;

  if (!hasImageSource) {
    throw new Error('Hitem3D requires an image input for mesh generation');
  }

  return {
    normalizedModel,
    normalizedResolution,
    normalizedRequestType,
    normalizedFace,
    normalizedPbr
  };
}

async function submitHitemMeshGenerationTask(settings, {
  imageBuffer = null,
  inputFilePath = '',
  model,
  resolution,
  requestType,
  face,
  pbr
} = {}) {
  const providerConfig = getHitem3dConfig(settings);
  if (!providerConfig.accessKey || !providerConfig.secretKey) {
    throw new Error('Hitem3D Access Key and Secret Key are required');
  }

  const validatedInput = normalizeHitemMeshGenerationInput({
    hasImageSource: Boolean(imageBuffer),
    model,
    resolution,
    requestType,
    face,
    pbr
  });

  const extension = path.extname(String(inputFilePath || '')).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  const uploadFilename = path.basename(inputFilePath || `input${extension || '.png'}`);

  const buildFormData = () => {
    const formData = new FormData();
    formData.append('request_type', String(validatedInput.normalizedRequestType));
    formData.append('model', validatedInput.normalizedModel);
    formData.append('resolution', validatedInput.normalizedResolution);
    formData.append('pbr', String(validatedInput.normalizedPbr));
    formData.append('face', String(validatedInput.normalizedFace));
    formData.append('format', String(HITEM_FORMAT_GLB));
    formData.append('images', new Blob([imageBuffer], { type: mimeType }), uploadFilename);
    return formData;
  };

  console.log('[Hitem3D][SubmitTask] request payload:', JSON.stringify({
    model: validatedInput.normalizedModel,
    resolution: validatedInput.normalizedResolution,
    request_type: validatedInput.normalizedRequestType,
    pbr: validatedInput.normalizedPbr,
    face: validatedInput.normalizedFace,
    format: HITEM_FORMAT_GLB,
    filename: uploadFilename
  }, null, 2));

  const performSubmit = async (accessToken) => {
    const response = await fetch(`${HITEM_API_BASE_URL}/submit-task`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: buildFormData()
    });
    const responseBody = await response.json().catch(() => ({}));
    return { response, responseBody };
  };

  let accessToken = await getHitem3dAccessToken(settings);
  let { response, responseBody } = await performSubmit(accessToken);

  // The cached token may have expired; refresh once and retry on auth errors.
  if (isHitemAuthError(response, responseBody)) {
    accessToken = await getHitem3dAccessToken(settings, { forceRefresh: true });
    ({ response, responseBody } = await performSubmit(accessToken));
  }

  console.log('[Hitem3D][SubmitTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 200) {
    throw new Error(responseBody?.msg || responseBody?.message || 'Hitem3D task submission failed');
  }

  const taskId = String(responseBody?.data?.task_id || '').trim();
  if (!taskId) {
    console.error('[Hitem3D][SubmitTask] missing task_id in response payload:', JSON.stringify(responseBody || {}, null, 2));
    throw new Error('Hitem3D task submission succeeded but task_id was missing');
  }

  return {
    taskId,
    validatedInput
  };
}

async function queryHitemMeshGenerationTask(settings, { taskId } = {}) {
  const providerConfig = getHitem3dConfig(settings);
  if (!providerConfig.accessKey || !providerConfig.secretKey) {
    throw new Error('Hitem3D Access Key and Secret Key are required');
  }

  const trimmedTaskId = String(taskId || '').trim();

  console.log('[Hitem3D][QueryTask] request payload:', JSON.stringify({ taskId: trimmedTaskId }, null, 2));

  const performQuery = async (accessToken) => {
    const response = await fetch(`${HITEM_API_BASE_URL}/query-task?task_id=${encodeURIComponent(trimmedTaskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const responseBody = await response.json().catch(() => ({}));
    return { response, responseBody };
  };

  let accessToken = await getHitem3dAccessToken(settings);
  let { response, responseBody } = await performQuery(accessToken);

  if (isHitemAuthError(response, responseBody)) {
    accessToken = await getHitem3dAccessToken(settings, { forceRefresh: true });
    ({ response, responseBody } = await performQuery(accessToken));
  }

  console.log('[Hitem3D][QueryTask] raw response:', JSON.stringify(responseBody || {}, null, 2));

  if (!response.ok || Number(responseBody?.code) !== 200) {
    throw new Error(responseBody?.msg || responseBody?.message || 'Failed to query Hitem3D task status');
  }

  const taskData = responseBody?.data || {};
  const status = String(taskData.state || '').trim().toLowerCase() || 'unknown';

  const normalizedTaskResult = {
    taskId: String(taskData.task_id || trimmedTaskId || '').trim(),
    status,
    url: String(taskData.url || '').trim(),
    coverUrl: String(taskData.cover_url || '').trim()
  };

  console.log('[Hitem3D][QueryTask] parsed result:', JSON.stringify(normalizedTaskResult, null, 2));

  return normalizedTaskResult;
}

async function downloadHitemMeshResult(taskResult = {}) {
  const selectedUrl = String(taskResult?.url || '').trim();

  if (!selectedUrl) {
    throw new Error('Hitem3D task succeeded but no model URL was returned');
  }

  const response = await fetch(selectedUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Hitem3D mesh result (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(getFilenameFromUrl(selectedUrl, '')).replace('.', '') || getExtensionFromContentType(contentType, 'glb');
  const filename = getFilenameFromUrl(selectedUrl, `generated_mesh.${extension}`);

  return {
    url: selectedUrl,
    contentType,
    extension,
    filename,
    buffer,
    previewImageUrl: String(taskResult?.coverUrl || '').trim() || null
  };
}

function normalizeTencentBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === 'true') return true;
    if (normalizedValue === 'false') return false;
  }

  return Boolean(value);
}

function normalizeTencentFaceCount(value, fallback = 500000) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.round(numericValue) : fallback;
}

function normalizeTencentMeshGenerationInput({
  prompt,
  hasImageSource = false,
  region,
  modelVersion,
  enablePBR,
  faceCount,
  generationType,
  polygonType
} = {}) {
  const trimmedPrompt = String(prompt || '').trim();
  const hasPrompt = Boolean(trimmedPrompt);
  const regionValue = String(region || '').trim();
  const normalizedRegion = TENCENT_REGIONS.has(regionValue) ? regionValue : null;
  const normalizedModelVersion = TENCENT_MODEL_VERSIONS.has(String(modelVersion || '').trim())
    ? String(modelVersion || '').trim()
    : '3.0';
  const normalizedGenerationType = TENCENT_GENERATION_TYPES.has(String(generationType || '').trim())
    ? String(generationType || '').trim()
    : 'Normal';
  const normalizedPolygonType = TENCENT_POLYGON_TYPES.has(String(polygonType || '').trim())
    ? String(polygonType || '').trim()
    : 'triangle';
  const normalizedFaceCount = normalizeTencentFaceCount(faceCount);
  const normalizedEnablePBR = normalizeTencentBoolean(enablePBR, false);

  if (!normalizedRegion) {
    throw new Error('Tencent Cloud region must be ap-singapore, eu-frankfurt, or na-siliconvalley');
  }

  if (hasPrompt === hasImageSource) {
    throw new Error('Provide either a prompt or an image input for Tencent Cloud mesh generation');
  }

  if (normalizedFaceCount < 3000 || normalizedFaceCount > 1500000) {
    throw new Error('Tencent Cloud FaceCount must be between 3000 and 1500000');
  }

  if (normalizedGenerationType === 'LowPoly' && normalizedModelVersion !== '3.0') {
    throw new Error('Tencent Cloud LowPoly generation is only available with model 3.0');
  }

  return {
    trimmedPrompt,
    normalizedRegion,
    normalizedModelVersion,
    normalizedEnablePBR,
    normalizedFaceCount,
    normalizedGenerationType,
    normalizedPolygonType,
    hasPrompt,
    hasImageSource
  };
}

function createTencentCloudClient({ secretId, secretKey, region }) {
  if (!secretId || !secretKey) {
    throw new Error('Tencent Cloud Secret Id and Secret Key are required');
  }

  const tencentcloud = tencentcloudSdk?.default || tencentcloudSdk;
  const { Credential, ClientProfile, HttpProfile, CommonClient } = tencentcloud.common;
  const HunyuanClient = tencentcloud?.hunyuan?.v20230901?.Client;
  const credential = new Credential(secretId, secretKey);
  const httpProfile = new HttpProfile();
  httpProfile.endpoint = TENCENT_HUNYUAN_ENDPOINT;
  const clientProfile = new ClientProfile();
  clientProfile.httpProfile = httpProfile;
  // Large payload requests (for example ImageBase64) must use the TC3 signature flow.
  clientProfile.signMethod = 'TC3-HMAC-SHA256';

  if (typeof HunyuanClient === 'function') {
    return new HunyuanClient(credential, region, clientProfile);
  }

  return new CommonClient(TENCENT_HUNYUAN_ENDPOINT, TENCENT_HUNYUAN_VERSION, credential, region, clientProfile);
}

async function requestTencentCloud(client, action, params) {
  return await new Promise((resolve, reject) => {
    if (typeof client?.[action] === 'function') {
      client[action](params, (err, response) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(response || {});
      });
      return;
    }

    client.request(action, params, (err, response) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(response || {});
    });
  });
}

function createTencentDebugPayload(params = {}) {
  const safePayload = { ...params };

  if (typeof safePayload.ImageBase64 === 'string') {
    safePayload.ImageBase64 = `[base64:${safePayload.ImageBase64.length} chars redacted]`;
  }

  return safePayload;
}

function createTripoDebugPayload(params = {}) {
  const safePayload = JSON.parse(JSON.stringify(params || {}));

  if (safePayload?.file?.file_token) {
    const token = String(safePayload.file.file_token);
    safePayload.file.file_token = `[token:${token.length} chars redacted]`;
  }

  return safePayload;
}

function getTencentCloudResponsePayload(response) {
  if (response && typeof response === 'object') {
    if (response.Response && typeof response.Response === 'object') {
      return response.Response;
    }

    return response;
  }

  return {};
}

async function submitTencentCloudMeshGenerationJob(settings, {
  region,
  modelVersion = '3.0',
  prompt = '',
  imageBuffer = null,
  enablePBR = false,
  faceCount = 500000,
  generationType = 'Normal',
  polygonType = 'triangle'
} = {}) {
  const providerConfig = getTencentCloudConfig(settings);
  const client = createTencentCloudClient({
    secretId: providerConfig.secretId,
    secretKey: providerConfig.secretKey,
    region
  });
  const params = {
    Model: modelVersion,
    EnablePBR: Boolean(enablePBR),
    FaceCount: faceCount,
    GenerateType: generationType
  };

  if (prompt) {
    params.Prompt = prompt;
  }

  if (imageBuffer) {
    params.ImageBase64 = imageBuffer.toString('base64');
  }

  if (generationType === 'LowPoly') {
    params.PolygonType = polygonType;
  }

  console.log('[TencentCloud][SubmitHunyuanTo3DProJob] request params:', JSON.stringify(createTencentDebugPayload(params), null, 2));

  const response = await requestTencentCloud(client, 'SubmitHunyuanTo3DProJob', params);
  console.log('[TencentCloud][SubmitHunyuanTo3DProJob] raw response:', JSON.stringify(response || {}, null, 2));
  const payload = getTencentCloudResponsePayload(response);

  if (!payload.JobId) {
    console.error('[TencentCloud][SubmitHunyuanTo3DProJob] missing JobId in payload:', JSON.stringify(payload, null, 2));
    throw new Error(payload.ErrorMessage || 'Tencent Cloud mesh generation did not return a job id');
  }

  return {
    jobId: String(payload.JobId),
    requestId: payload.RequestId || null
  };
}

async function queryTencentCloudMeshGenerationJob(settings, { region, jobId } = {}) {
  const providerConfig = getTencentCloudConfig(settings);
  const client = createTencentCloudClient({
    secretId: providerConfig.secretId,
    secretKey: providerConfig.secretKey,
    region
  });
  const response = await requestTencentCloud(client, 'QueryHunyuanTo3DProJob', {
    JobId: String(jobId || '').trim()
  });
  const payload = getTencentCloudResponsePayload(response);

  return {
    requestId: payload.RequestId || null,
    status: String(payload.Status || '').trim() || 'WAIT',
    errorCode: String(payload.ErrorCode || '').trim(),
    errorMessage: String(payload.ErrorMessage || '').trim(),
    resultFiles: Array.isArray(payload.ResultFile3Ds) ? payload.ResultFile3Ds : []
  };
}

function selectTencentPreferredResultFile(resultFiles = []) {
  const normalizedFiles = Array.isArray(resultFiles) ? resultFiles.filter(Boolean) : [];
  if (normalizedFiles.length === 0) {
    return null;
  }

  const glbFile = normalizedFiles.find((entry) => String(entry?.Type || '').toUpperCase() === 'GLB');
  if (glbFile?.Url) {
    return glbFile;
  }

  const objFile = normalizedFiles.find((entry) => String(entry?.Type || '').toUpperCase() === 'OBJ');
  if (objFile?.Url) {
    return objFile;
  }

  const firstFileWithUrl = normalizedFiles.find((entry) => entry?.Url);
  return firstFileWithUrl || normalizedFiles[0];
}

async function downloadTencentCloudResultFiles(resultFiles = []) {
  const resultFile = selectTencentPreferredResultFile(resultFiles);
  if (!resultFile?.Url) {
    return [];
  }

  const response = await fetch(resultFile.Url);
  if (!response.ok) {
    throw new Error(`Failed to download Tencent Cloud mesh result (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(getFilenameFromUrl(resultFile.Url, '')).replace('.', '') || getExtensionFromContentType(contentType, 'glb');
  const filename = getFilenameFromUrl(resultFile.Url, `generated_mesh.${extension}`);

  return [{
    buffer,
    contentType,
    filename,
    previewImageUrl: resultFile.PreviewImageUrl || '',
    resultType: resultFile.Type || ''
  }];
}

async function saveGeneratedMeshAssets({
  projectId,
  name,
  cardId = null,
  provider = 'API',
  prompt = '',
  metadata = {},
  downloadedFiles = [],
  parentAssetId = null
} = {}) {
  const savedAssets = [];
  const normalizedParentAssetId = Number(parentAssetId) || null;

  for (const [index, downloadedFile] of downloadedFiles.entries()) {
    const extension = path.extname(downloadedFile.filename).replace('.', '') || getExtensionFromContentType(downloadedFile.contentType, 'glb');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${index}.${extension}`;
    const storedFilePath = toStoredAssetPath('mesh', filename);
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, downloadedFile.buffer);

    const assetPayload = {
      type: 'mesh',
      name: downloadedFiles.length > 1 ? `${name} ${index + 1}` : name,
      filePath: storedFilePath,
      metadata: {
        format: extension.toUpperCase(),
        source: provider,
        provider,
        prompt,
        cardId,
        previewImageUrl: downloadedFile.previewImageUrl || null,
        resultType: downloadedFile.resultType || null,
        ...metadata
      },
      createdAt: Date.now() + index
    };

    // When the mesh was edited from a connected mesh, save it as a version (child)
    // of that mesh instead of creating a new root asset.
    savedAssets.push(normalizedParentAssetId
      ? await createAssetVersion({ assetId: normalizedParentAssetId, ...assetPayload, inheritThumbnail: false })
      : await createProjectAsset({ projectId: Number(projectId), ...assetPayload }));
  }

  return savedAssets;
}

function getTencentJobRuntimeLabel(jobStatus = 'WAIT') {
  if (jobStatus === 'RUN') {
    return 'Tencent Cloud job is running';
  }

  if (jobStatus === 'WAIT') {
    return 'Tencent Cloud job is queued';
  }

  if (jobStatus === 'DONE') {
    return 'Tencent Cloud job finished';
  }

  return 'Tencent Cloud job failed';
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
  const orderedNodeIds = preferredNodeIds.length > 0
    ? preferredNodeIds.filter(nodeId => historyRecord?.outputs?.[nodeId])
    : Object.keys(historyRecord?.outputs || {});
  const files = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    const selectedOutput = selectedOutputsByNodeId.get(String(nodeId));
    const expectedType = normalizeComfyValueType(selectedOutput?.valueType, getDefaultComfyValueType(selectedOutput, true));

    // String/text outputs are collected separately by getComfyHistoryTexts.
    if (expectedType === 'string') {
      continue;
    }

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

    // The result was produced from an existing source mesh, so save it as a
    // version (child) of that mesh instead of creating a new root asset.
    const savedAsset = await createAssetVersion({
      assetId: sourceAsset.id,
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
      createdAt: Date.now(),
      // The generated geometry differs from the parent, so render its own thumbnail.
      inheritThumbnail: false
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

function collectComfyOutputStrings(value, collected) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      collected.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectComfyOutputStrings(entry, collected);
    }
    return;
  }

  if (value && typeof value === 'object') {
    // ComfyUI text nodes commonly expose their result under a `text` key.
    if (typeof value.text === 'string') {
      collectComfyOutputStrings(value.text, collected);
      return;
    }
    if (Array.isArray(value.text)) {
      collectComfyOutputStrings(value.text, collected);
      return;
    }
    if (typeof value.string === 'string') {
      collectComfyOutputStrings(value.string, collected);
      return;
    }
  }
}

function getComfyHistoryTexts(historyRecord, selectedOutputs = []) {
  const selectedOutputsByNodeId = new Map(selectedOutputs.map(output => [String(output.nodeId || output.id), output]));
  const preferredNodeIds = selectedOutputs
    .filter(output => normalizeComfyValueType(output?.valueType, getDefaultComfyValueType(output, true)) === 'string')
    .map(output => String(output.nodeId || output.id));
  const orderedNodeIds = preferredNodeIds.filter(nodeId => historyRecord?.outputs?.[nodeId]);
  const texts = [];

  for (const nodeId of orderedNodeIds) {
    const nodeOutput = historyRecord?.outputs?.[nodeId];
    const selectedOutput = selectedOutputsByNodeId.get(String(nodeId));

    for (const [outputKey, outputValue] of Object.entries(nodeOutput || {})) {
      const collected = [];
      collectComfyOutputStrings(outputValue, collected);

      if (collected.length === 0) {
        continue;
      }

      texts.push({
        nodeId,
        outputKey,
        expectedType: 'string',
        text: collected.join('\n'),
        outputName: selectedOutput?.name || null
      });
    }
  }

  return texts;
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

function getBrushChildStoredFilePath(parentId, extension = 'png') {
  const safeParentFolder = sanitizeAssetFolderName(`brush-${parentId}`) || 'brush';
  return toStoredAssetPath('brush', `brushes/${safeParentFolder}/${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`);
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

// Multiplexed progress stream: a single SSE connection carrying progress for
// every promptId. The client uses this instead of one connection per job so
// running many workflows at once doesn't saturate the browser connection pool.
app.get('/api/comfyui/workflows/events', (req, res) => {
  subscribeToAllComfyProgress(req, res);
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
  let responded = false;
  let backgroundStarted = false;

  try {
    const { projectId, workflowId, cardId, name, parentAssetId } = req.body;
    const normalizedProjectId = Number(projectId);
    const hasProjectId = Number.isFinite(normalizedProjectId) && normalizedProjectId > 0;
    const trimmedName = String(name || '').trim();
    const normalizedParentAssetId = Number(parentAssetId) || null;
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

    // Respond immediately once the prompt is queued so the browser connection
    // isn't held open for the entire (possibly multi-minute) generation. The
    // outputs and terminal status are delivered over the multiplexed progress
    // stream instead of this request's response body.
    responded = true;
    backgroundStarted = true;
    res.status(202).json({
      promptId: executionPromptId,
      clientId: executionClientId,
      status: 'queued'
    });

    // Finalize the run in the background: wait for ComfyUI to finish, download
    // and persist the outputs, then publish the terminal event carrying the
    // generated assets to the client.
    (async () => {
      try {
        await executionMonitor.completion;
        const historyRecord = await waitForComfyHistory(baseUrl, queuedPromptId);
    const workflowFiles = getComfyHistoryFiles(historyRecord, workflow.outputs);
    const workflowTexts = getComfyHistoryTexts(historyRecord, workflow.outputs);

    if (workflowFiles.length === 0 && workflowTexts.length === 0) {
      throw new Error('The ComfyUI workflow finished but no compatible files were returned');
    }

    const imageCardId = persistProcessingCard ? processingCardId : null;
    const baseTimestamp = Date.now();
    const generatedAssets = [];

    for (const [index, workflowText] of workflowTexts.entries()) {
      generatedAssets.push({
        type: 'text',
        name: workflowText.outputName || trimmedName || workflow.name,
        text: workflowText.text,
        metadata: {
          source: 'COMFYUI',
          provider: 'ComfyUI',
          workflowId: workflow.id,
          workflowName: workflow.name,
          promptId: queuedPromptId,
          outputNodeId: workflowText.nodeId,
          outputKey: workflowText.outputKey
        },
        createdAt: baseTimestamp + index,
        outputKey: workflowText.outputKey,
        outputNodeId: workflowText.nodeId,
        expectedType: 'string',
        temporary: true
      });
    }

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
        name: (trimmedName || inferredAssetType === 'mesh')
          ? processingCardName
          : createGeneratedImageName(workflow.name, extension), // honor the user-provided Result name; fall back to a generated name only when none was given
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

        // When a mesh output was edited from a connected mesh, store it as a
        // version (child) of that mesh instead of creating a new root asset.
        const persistedAsset = (normalizedParentAssetId && inferredAssetType === 'mesh')
          ? await createAssetVersion({ assetId: normalizedParentAssetId, ...generatedAssetPayload, inheritThumbnail: false })
          : await createProjectAsset(generatedAssetPayload);
        generatedAssets.push({
          ...persistedAsset,
          url: `${getRequestBaseUrl(req)}/assets/${encodeURI(toAssetUrlPath(storedFilePath))}`,
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

        // Terminal event: `done` + `result` signal the client that the run has
        // fully completed and carry the generated assets it used to receive in
        // the (now non-blocking) POST response body.
        publishComfyProgress(executionPromptId, {
          status: 'completed',
          progressPercent: 100,
          detail: 'ComfyUI workflow completed',
          currentNodeLabel: 'ComfyUI workflow completed',
          done: true,
          result: generatedAssets
        });
      } catch (finalizeErr) {
        console.error('ComfyUI workflow finalization failed:', finalizeErr);
        if (processingProjectId && processingCardId) {
          await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
            columnName: 'Images',
            name: processingCardName,
            status: 'error',
            progressPercent: null,
            detail: finalizeErr.message || 'Failed to execute ComfyUI workflow',
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
        publishComfyProgress(executionPromptId, {
          status: 'error',
          detail: finalizeErr.message || 'Failed to execute ComfyUI workflow',
          currentNodeLabel: 'ComfyUI execution failed',
          done: true
        });
      } finally {
        executionMonitor?.close();
      }
    })();
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
        currentNodeLabel: 'ComfyUI execution failed',
        done: true
      });
    }

    if (!responded) {
      res.status(500).json({ error: err.message || 'Failed to execute ComfyUI workflow' });
    }
  } finally {
    // The background finalizer owns the monitor once it has started; only close
    // here for failures that happen before the response is sent.
    if (!backgroundStarted) {
      executionMonitor?.close();
    }
  }
});

app.post('/api/meshes/generate', async (req, res) => {
  let processingProjectId = null;
  let processingCardId = null;
  let processingCardName = null;
  let processingStartedAt = Date.now();

  try {
    const {
      projectId,
      selectedApi,
      prompt,
      name,
      imageSource,
      cardId,
      region,
      modelVersion,
      enablePBR,
      faceCount,
      generationType,
      polygonType,
      parentAssetId
    } = req.body;
    const normalizedParentAssetId = Number(parentAssetId) || null;
    const trimmedName = String(name || '').trim();
    const trimmedPrompt = String(prompt || '').trim();
    const isTencentMeshApi = isTencentMeshGenerationApi(selectedApi);
    const isTripoMeshApi = isTripoMeshGenerationApi(selectedApi);
    const isHitemMeshApi = isHitemMeshGenerationApi(selectedApi);
    const effectiveImageSource = (isTencentMeshApi || isTripoMeshApi) && trimmedPrompt
      ? ''
      : imageSource;

    if (!projectId || !selectedApi || !trimmedName) {
      return res.status(400).json({ error: 'projectId, selectedApi and name are required' });
    }

    if (!isTencentMeshApi && !isTripoMeshApi && !isHitemMeshApi && !trimmedPrompt) {
      return res.status(400).json({ error: 'prompt is required for mesh generation' });
    }

    if (isHitemMeshApi && !effectiveImageSource) {
      return res.status(400).json({ error: 'Hitem3D requires an image source for mesh generation' });
    }

    if (!isTencentMeshApi && !isTripoMeshApi && !isHitemMeshApi && !String(selectedApi).startsWith('custom_')) {
      return res.status(400).json({ error: 'Mesh generation currently supports custom APIs only' });
    }

    let resolvedSource = null;
    let sourceAsset = null;
    if (effectiveImageSource) {
      resolvedSource = await resolveProjectImageSource(Number(projectId), effectiveImageSource);
      sourceAsset = resolvedSource?.asset;

      if (!resolvedSource || !sourceAsset || sourceAsset.type !== 'image') {
        return res.status(404).json({ error: 'Source image or edit not found' });
      }
    }

    processingProjectId = Number(projectId);
    processingCardId = cardId || sourceAsset?.metadata?.cardId || randomUUID();
    processingCardName = trimmedName;
    processingStartedAt = Date.now();

    const settings = await getSettings();

    if (isTencentMeshApi) {
      const validatedInput = normalizeTencentMeshGenerationInput({
        prompt: trimmedPrompt,
        hasImageSource: Boolean(resolvedSource),
        region,
        modelVersion,
        enablePBR,
        faceCount,
        generationType,
        polygonType
      });
      const sourceFilePath = resolvedSource ? toAbsoluteStoragePath(resolvedSource.inputFilePath) : null;
      const sourceBuffer = sourceFilePath ? await fs.readFile(sourceFilePath) : null;

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Submitting Tencent Cloud mesh generation job',
        currentNodeLabel: 'Waiting for Tencent Cloud job id',
        source: 'Tencent Cloud',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        selectedApi,
        region: validatedInput.normalizedRegion,
        modelVersion: validatedInput.normalizedModelVersion,
        generationType: validatedInput.normalizedGenerationType,
        polygonType: validatedInput.normalizedGenerationType === 'LowPoly' ? validatedInput.normalizedPolygonType : null,
        enablePBR: validatedInput.normalizedEnablePBR,
        faceCount: validatedInput.normalizedFaceCount,
        inputSource: effectiveImageSource || null
      });

      const submittedJob = await submitTencentCloudMeshGenerationJob(settings, {
        region: validatedInput.normalizedRegion,
        modelVersion: validatedInput.normalizedModelVersion,
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : '',
        imageBuffer: sourceBuffer,
        enablePBR: validatedInput.normalizedEnablePBR,
        faceCount: validatedInput.normalizedFaceCount,
        generationType: validatedInput.normalizedGenerationType,
        polygonType: validatedInput.normalizedPolygonType
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Tencent Cloud job submitted. Use GET RESULT to refresh status.',
        currentNodeLabel: getTencentJobRuntimeLabel('WAIT'),
        source: 'Tencent Cloud',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        promptId: submittedJob.jobId,
        selectedApi,
        region: validatedInput.normalizedRegion,
        modelVersion: validatedInput.normalizedModelVersion,
        generationType: validatedInput.normalizedGenerationType,
        polygonType: validatedInput.normalizedGenerationType === 'LowPoly' ? validatedInput.normalizedPolygonType : null,
        enablePBR: validatedInput.normalizedEnablePBR,
        faceCount: validatedInput.normalizedFaceCount,
        jobId: submittedJob.jobId,
        jobStatus: 'WAIT',
        inputSource: effectiveImageSource || null
      });

      return res.status(202).json({
        status: 'queued',
        provider: 'Tencent Cloud',
        selectedApi,
        jobId: submittedJob.jobId,
        requestId: submittedJob.requestId,
        region: validatedInput.normalizedRegion,
        name: trimmedName,
        cardId: processingCardId
      });
    }

    if (isTripoMeshApi) {
      console.log('[TripoAI][GenerateRoute] request summary:', JSON.stringify({
        promptLength: trimmedPrompt.length,
        receivedImageSource: String(imageSource || ''),
        effectiveImageSource: String(effectiveImageSource || ''),
        selectedApi: String(selectedApi || '')
      }, null, 2));

      const sourceFilePath = resolvedSource ? toAbsoluteStoragePath(resolvedSource.inputFilePath) : null;
      const sourceBuffer = sourceFilePath ? await fs.readFile(sourceFilePath) : null;
      const validatedInput = normalizeTripoMeshGenerationInput({
        prompt: trimmedPrompt,
        hasImageSource: Boolean(resolvedSource),
        modelVersion: req.body?.modelVersion,
        modelSeed: req.body?.modelSeed,
        enableImageAutofix: req.body?.enableImageAutofix,
        faceLimit: req.body?.faceLimit,
        texture: req.body?.texture,
        pbr: req.body?.pbr,
        textureSeed: req.body?.textureSeed,
        textureAlignment: req.body?.textureAlignment,
        textureQuality: req.body?.textureQuality,
        autoSize: req.body?.autoSize,
        orientation: req.body?.orientation,
        quad: req.body?.quad,
        smartLowPoly: req.body?.smartLowPoly,
        generateParts: req.body?.generateParts,
        exportUv: req.body?.exportUv,
        geometryQuality: req.body?.geometryQuality
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Uploading image and submitting Tripo AI mesh generation task',
        currentNodeLabel: 'Waiting for Tripo AI task id',
        source: 'Tripo AI',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        selectedApi,
        inputSource: effectiveImageSource || null,
        modelVersion: validatedInput.normalizedModelVersion,
        texture: validatedInput.normalizedTexture,
        pbr: validatedInput.normalizedPbr,
        textureAlignment: validatedInput.normalizedTextureAlignment,
        textureQuality: validatedInput.normalizedTextureQuality,
        orientation: validatedInput.normalizedOrientation,
        quad: validatedInput.normalizedQuad,
        smartLowPoly: validatedInput.normalizedSmartLowPoly,
        generateParts: validatedInput.normalizedGenerateParts,
        exportUv: validatedInput.normalizedExportUv,
        autoSize: validatedInput.normalizedAutoSize,
        geometryQuality: validatedInput.supportsGeometryQuality ? validatedInput.normalizedGeometryQuality : null,
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : ''
      });

      const submittedTask = await submitTripoMeshGenerationTask(settings, {
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : '',
        imageBuffer: sourceBuffer,
        inputFilePath: resolvedSource?.inputFilePath || resolvedSource?.inputFilename || '',
        modelVersion: validatedInput.normalizedModelVersion,
        modelSeed: validatedInput.normalizedModelSeed,
        enableImageAutofix: validatedInput.normalizedEnableImageAutofix,
        faceLimit: validatedInput.normalizedFaceLimit,
        texture: validatedInput.normalizedTexture,
        pbr: validatedInput.normalizedPbr,
        textureSeed: validatedInput.normalizedTextureSeed,
        textureAlignment: validatedInput.normalizedTextureAlignment,
        textureQuality: validatedInput.normalizedTextureQuality,
        autoSize: validatedInput.normalizedAutoSize,
        orientation: validatedInput.normalizedOrientation,
        quad: validatedInput.normalizedQuad,
        smartLowPoly: validatedInput.normalizedSmartLowPoly,
        generateParts: validatedInput.normalizedGenerateParts,
        exportUv: validatedInput.normalizedExportUv,
        geometryQuality: validatedInput.normalizedGeometryQuality
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Tripo AI task submitted. Use GET RESULT to refresh status.',
        currentNodeLabel: 'Tripo AI task is queued',
        source: 'Tripo AI',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        promptId: submittedTask.taskId,
        selectedApi,
        taskId: submittedTask.taskId,
        taskStatus: 'queued',
        inputSource: effectiveImageSource || null,
        modelVersion: validatedInput.normalizedModelVersion,
        texture: validatedInput.normalizedTexture,
        pbr: validatedInput.normalizedPbr,
        textureAlignment: validatedInput.normalizedTextureAlignment,
        textureQuality: validatedInput.normalizedTextureQuality,
        orientation: validatedInput.normalizedOrientation,
        quad: validatedInput.normalizedQuad,
        smartLowPoly: validatedInput.normalizedSmartLowPoly,
        generateParts: validatedInput.normalizedGenerateParts,
        exportUv: validatedInput.normalizedExportUv,
        autoSize: validatedInput.normalizedAutoSize,
        geometryQuality: validatedInput.supportsGeometryQuality ? validatedInput.normalizedGeometryQuality : null,
        prompt: validatedInput.hasPrompt ? validatedInput.trimmedPrompt : ''
      });

      return res.status(202).json({
        status: 'queued',
        provider: 'Tripo AI',
        selectedApi,
        taskId: submittedTask.taskId,
        name: trimmedName,
        cardId: processingCardId,
        canFetchResult: true
      });
    }

    if (isHitemMeshApi) {
      const sourceFilePath = resolvedSource ? toAbsoluteStoragePath(resolvedSource.inputFilePath) : null;
      const sourceBuffer = sourceFilePath ? await fs.readFile(sourceFilePath) : null;
      const validatedInput = normalizeHitemMeshGenerationInput({
        hasImageSource: Boolean(sourceBuffer),
        model: req.body?.hitemModel,
        resolution: req.body?.hitemResolution,
        requestType: req.body?.hitemRequestType,
        face: req.body?.hitemFace,
        pbr: req.body?.hitemPbr
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Submitting Hitem3D mesh generation task',
        currentNodeLabel: 'Waiting for Hitem3D task id',
        source: 'Hitem3D',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        selectedApi,
        inputSource: effectiveImageSource || null,
        hitemModel: validatedInput.normalizedModel,
        hitemResolution: validatedInput.normalizedResolution,
        hitemRequestType: validatedInput.normalizedRequestType,
        hitemFace: validatedInput.normalizedFace,
        hitemPbr: validatedInput.normalizedPbr
      });

      const submittedTask = await submitHitemMeshGenerationTask(settings, {
        imageBuffer: sourceBuffer,
        inputFilePath: resolvedSource?.inputFilePath || resolvedSource?.inputFilename || '',
        model: validatedInput.normalizedModel,
        resolution: validatedInput.normalizedResolution,
        requestType: validatedInput.normalizedRequestType,
        face: validatedInput.normalizedFace,
        pbr: validatedInput.normalizedPbr
      });

      await updateCardProcessingSnapshot(processingProjectId, processingCardId, {
        columnName: 'Mesh Gen',
        name: processingCardName,
        status: 'processing',
        progressPercent: null,
        detail: 'Hitem3D task submitted. Use GET RESULT to refresh status.',
        currentNodeLabel: 'Hitem3D task is queued',
        source: 'Hitem3D',
        operationType: 'mesh-generation',
        startedAt: processingStartedAt,
        promptId: submittedTask.taskId,
        selectedApi,
        taskId: submittedTask.taskId,
        taskStatus: 'processing',
        inputSource: effectiveImageSource || null,
        hitemModel: validatedInput.normalizedModel,
        hitemResolution: validatedInput.normalizedResolution,
        hitemRequestType: validatedInput.normalizedRequestType,
        hitemFace: validatedInput.normalizedFace,
        hitemPbr: validatedInput.normalizedPbr
      });

      return res.status(202).json({
        status: 'queued',
        provider: 'Hitem3D',
        selectedApi,
        taskId: submittedTask.taskId,
        name: trimmedName,
        cardId: processingCardId,
        canFetchResult: true
      });
    }

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

    const meshAssetPayload = {
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
    };

    // When a mesh was connected to the node and used to edit it, save the
    // result as a version (child) of that mesh instead of a new root asset.
    const savedAsset = normalizedParentAssetId
      ? await createAssetVersion({ assetId: normalizedParentAssetId, ...meshAssetPayload, inheritThumbnail: false })
      : await createProjectAsset({ projectId: Number(projectId), ...meshAssetPayload });

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

app.post('/api/meshes/generate/tencent/result', async (req, res) => {
  try {
    const { projectId, jobId, region, name, prompt = '', cardId = null, selectedApi = TENCENT_MESH_GENERATION_API_ID, parentAssetId = null } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !jobId || !region || !trimmedName) {
      return res.status(400).json({ error: 'projectId, jobId, region and name are required' });
    }

    const normalizedRegion = TENCENT_REGIONS.has(String(region || '').trim()) ? String(region || '').trim() : null;
    if (!normalizedRegion) {
      return res.status(400).json({ error: 'Invalid Tencent Cloud region' });
    }

    const settings = await getSettings();
    const jobResult = await queryTencentCloudMeshGenerationJob(settings, {
      region: normalizedRegion,
      jobId
    });

    if (jobResult.status === 'FAIL') {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'error',
          progressPercent: null,
          detail: jobResult.errorMessage || jobResult.errorCode || 'Tencent Cloud mesh generation failed',
          currentNodeLabel: getTencentJobRuntimeLabel('FAIL'),
          source: 'Tencent Cloud',
          operationType: 'mesh-generation',
          selectedApi,
          region: normalizedRegion,
          promptId: String(jobId),
          jobId: String(jobId),
          jobStatus: 'FAIL'
        });
      }

      return res.json({
        status: 'error',
        provider: 'Tencent Cloud',
        selectedApi,
        jobId: String(jobId),
        region: normalizedRegion,
        requestId: jobResult.requestId,
        error: jobResult.errorMessage || jobResult.errorCode || 'Tencent Cloud mesh generation failed'
      });
    }

    if (jobResult.status === 'RUN' || jobResult.status === 'WAIT') {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'processing',
          progressPercent: null,
          detail: `Tencent Cloud job status: ${jobResult.status}`,
          currentNodeLabel: getTencentJobRuntimeLabel(jobResult.status),
          source: 'Tencent Cloud',
          operationType: 'mesh-generation',
          selectedApi,
          region: normalizedRegion,
          promptId: String(jobId),
          jobId: String(jobId),
          jobStatus: jobResult.status
        });
      }

      return res.json({
        status: 'processing',
        provider: 'Tencent Cloud',
        selectedApi,
        jobId: String(jobId),
        region: normalizedRegion,
        requestId: jobResult.requestId,
        jobStatus: jobResult.status,
        canFetchResult: true
      });
    }

    if (jobResult.status !== 'DONE') {
      return res.status(500).json({ error: `Unsupported Tencent Cloud job status: ${jobResult.status}` });
    }

    const downloadedFiles = await downloadTencentCloudResultFiles(jobResult.resultFiles);
    if (downloadedFiles.length === 0) {
      throw new Error('Tencent Cloud job finished but no mesh result files were returned');
    }

    const savedAssets = await saveGeneratedMeshAssets({
      projectId: Number(projectId),
      name: trimmedName,
      cardId,
      provider: 'Tencent Cloud',
      prompt: String(prompt || '').trim(),
      metadata: {
        region: normalizedRegion,
        selectedApi,
        jobId: String(jobId)
      },
      downloadedFiles,
      parentAssetId
    });

    if (cardId) {
      await clearCardProcessingState(Number(projectId), cardId, {
        name: trimmedName
      });
    }

    return res.json({
      status: 'completed',
      provider: 'Tencent Cloud',
      selectedApi,
      jobId: String(jobId),
      region: normalizedRegion,
      requestId: jobResult.requestId,
      jobStatus: 'DONE',
      assets: savedAssets
    });
  } catch (err) {
    console.error('Tencent Cloud mesh generation result query failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Tencent Cloud mesh generation result' });
  }
});

app.post('/api/meshes/generate/tripo/result', async (req, res) => {
  try {
    const { projectId, taskId, name, prompt = '', cardId = null, selectedApi = TRIPO_MESH_GENERATION_API_ID, parentAssetId = null } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !taskId || !trimmedName) {
      return res.status(400).json({ error: 'projectId, taskId and name are required' });
    }

    const settings = await getSettings();
    const taskResult = await queryTripoMeshGenerationTask(settings, { taskId });

    if (TRIPO_FAILURE_STATUSES.has(taskResult.status)) {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'error',
          progressPercent: Number.isFinite(taskResult.progress) ? Math.max(0, Math.min(100, Math.round(taskResult.progress))) : null,
          detail: taskResult.errorMessage || `Tripo AI task failed with status: ${taskResult.status}`,
          currentNodeLabel: 'Tripo AI task failed',
          source: 'Tripo AI',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'error',
        provider: 'Tripo AI',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        error: taskResult.errorMessage || `Tripo AI task failed with status: ${taskResult.status}`
      });
    }

    if (TRIPO_RUNNING_STATUSES.has(taskResult.status)) {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'processing',
          progressPercent: Number.isFinite(taskResult.progress) ? Math.max(0, Math.min(100, Math.round(taskResult.progress))) : null,
          detail: `Tripo AI task status: ${taskResult.status}`,
          currentNodeLabel: taskResult.status === 'running' ? 'Tripo AI task is running' : 'Tripo AI task is queued',
          source: 'Tripo AI',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'processing',
        provider: 'Tripo AI',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        progress: Number.isFinite(taskResult.progress) ? Math.max(0, Math.min(100, Math.round(taskResult.progress))) : null,
        canFetchResult: true
      });
    }

    if (taskResult.status !== TRIPO_SUCCESS_STATUS) {
      return res.status(500).json({ error: `Unsupported Tripo AI task status: ${taskResult.status}` });
    }

    const downloadedFile = await downloadTripoMeshResult(taskResult.output);
    const savedAssets = await saveGeneratedMeshAssets({
      projectId: Number(projectId),
      name: trimmedName,
      cardId,
      provider: 'Tripo AI',
      prompt: String(prompt || '').trim(),
      metadata: {
        selectedApi,
        taskId: String(taskId),
        sourceUrl: downloadedFile.url,
        isPbrModel: downloadedFile.isPbr
      },
      downloadedFiles: [downloadedFile],
      parentAssetId
    });

    if (cardId) {
      await clearCardProcessingState(Number(projectId), cardId, {
        name: trimmedName
      });
    }

    return res.json({
      status: 'completed',
      provider: 'Tripo AI',
      selectedApi,
      taskId: String(taskId),
      taskStatus: TRIPO_SUCCESS_STATUS,
      assets: savedAssets
    });
  } catch (err) {
    console.error('Tripo AI mesh generation result query failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Tripo AI mesh generation result' });
  }
});

app.post('/api/meshes/generate/hitem/result', async (req, res) => {
  try {
    const { projectId, taskId, name, prompt = '', cardId = null, selectedApi = HITEM_MESH_GENERATION_API_ID, parentAssetId = null } = req.body;
    const trimmedName = String(name || '').trim();

    if (!projectId || !taskId || !trimmedName) {
      return res.status(400).json({ error: 'projectId, taskId and name are required' });
    }

    const settings = await getSettings();
    const taskResult = await queryHitemMeshGenerationTask(settings, { taskId });

    if (HITEM_FAILURE_STATUSES.has(taskResult.status)) {
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'error',
          progressPercent: null,
          detail: `Hitem3D task failed with status: ${taskResult.status}`,
          currentNodeLabel: 'Hitem3D task failed',
          source: 'Hitem3D',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'error',
        provider: 'Hitem3D',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        error: `Hitem3D task failed with status: ${taskResult.status}`
      });
    }

    if (taskResult.status !== HITEM_SUCCESS_STATUS) {
      // Any non-success, non-failure state is treated as still-processing.
      if (projectId && cardId) {
        await updateCardProcessingSnapshot(Number(projectId), cardId, {
          columnName: 'Mesh Gen',
          name: trimmedName,
          status: 'processing',
          progressPercent: null,
          detail: `Hitem3D task status: ${taskResult.status}`,
          currentNodeLabel: 'Hitem3D task is running',
          source: 'Hitem3D',
          operationType: 'mesh-generation',
          selectedApi,
          promptId: String(taskId),
          taskId: String(taskId),
          taskStatus: taskResult.status
        });
      }

      return res.json({
        status: 'processing',
        provider: 'Hitem3D',
        selectedApi,
        taskId: String(taskId),
        taskStatus: taskResult.status,
        canFetchResult: true
      });
    }

    const downloadedFile = await downloadHitemMeshResult(taskResult);
    const savedAssets = await saveGeneratedMeshAssets({
      projectId: Number(projectId),
      name: trimmedName,
      cardId,
      provider: 'Hitem3D',
      prompt: String(prompt || '').trim(),
      metadata: {
        selectedApi,
        taskId: String(taskId),
        sourceUrl: downloadedFile.url
      },
      downloadedFiles: [downloadedFile],
      parentAssetId
    });

    if (cardId) {
      await clearCardProcessingState(Number(projectId), cardId, {
        name: trimmedName
      });
    }

    return res.json({
      status: 'completed',
      provider: 'Hitem3D',
      selectedApi,
      taskId: String(taskId),
      taskStatus: HITEM_SUCCESS_STATUS,
      assets: savedAssets
    });
  } catch (err) {
    console.error('Hitem3D mesh generation result query failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Hitem3D mesh generation result' });
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

    // The result was produced from an existing source mesh, so save it as a
    // version (child) of that mesh instead of creating a new root asset.
    const savedAsset = await createAssetVersion({
      assetId: sourceAsset.id,
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
      createdAt: Date.now(),
      // The generated geometry differs from the parent, so render its own thumbnail.
      inheritThumbnail: false
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

    // The result was produced from an existing source mesh, so save it as a
    // version (child) of that mesh instead of creating a new root asset.
    const savedAsset = await createAssetVersion({
      assetId: sourceAsset.id,
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
      createdAt: Date.now(),
      // The generated geometry differs from the parent, so render its own thumbnail.
      inheritThumbnail: false
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

app.put('/api/projects/:id', async (req, res) => {
  try {
    const updated = await updateProject(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: 'Project not found' });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const deleteAssets = req.query.deleteAssets === 'true';
    await deleteProjectById(Number(req.params.id), { deleteAssets });
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Deletion failed' });
  }
});

// Turn a filesystem-unsafe name into a folder base name (letters, digits,
// spaces, dot, dash, underscore) so it can name the export folder + .3dgp file.
function sanitizeProjectExportName(name, fallback = 'project') {
  // eslint-disable-next-line no-control-regex -- intentionally strips control chars (illegal in filenames)
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?* -]+/g, '_').replace(/\.+$/, '').trim();
  return cleaned || fallback;
}

async function readAppVersion() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'version.json'), 'utf8');
    return JSON.parse(raw)?.version || '';
  } catch {
    return '';
  }
}

// Export a project as a self-contained .3dgp bundle folder under `folder`.
app.post('/api/projects/:id/export', async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
    const requestedName = typeof req.body?.name === 'string' ? req.body.name : '';

    if (!folder) {
      return res.status(400).json({ error: 'A destination folder is required.' });
    }
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'The destination folder must be an absolute path.' });
    }

    const { manifest, files } = await buildProjectExport(projectId, { appVersion: await readAppVersion() });
    const bundleName = sanitizeProjectExportName(requestedName || manifest.project.name, 'project');
    const bundleDir = path.join(path.resolve(folder), bundleName);

    await fs.mkdir(bundleDir, { recursive: true });

    let copied = 0;
    for (const file of files) {
      const destination = path.join(bundleDir, file.dest);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fs.copyFile(file.source, destination);
        copied += 1;
      } catch (copyErr) {
        console.warn(`Failed to copy export file ${file.source}:`, copyErr.message);
      }
    }

    await fs.writeFile(path.join(bundleDir, `${bundleName}.3dgp`), JSON.stringify(manifest, null, 2), 'utf8');

    res.status(201).json({
      folder: bundleDir,
      name: bundleName,
      assetCount: manifest.assets.length,
      fileCount: copied
    });
  } catch (err) {
    console.error('Failed to export project:', err);
    const message = err.code === 'EACCES'
      ? 'Access to the destination folder is denied.'
      : (err.message || 'Failed to export project');
    res.status(err.message === 'Project not found' ? 404 : 500).json({ error: message });
  }
});

// Import a project from a previously exported bundle folder (contains a .3dgp).
app.post('/api/projects/import', async (req, res) => {
  try {
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (!folder) {
      return res.status(400).json({ error: 'A source folder is required.' });
    }
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'The source folder must be an absolute path.' });
    }

    const bundleDir = path.resolve(folder);
    const stats = await fs.stat(bundleDir).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      return res.status(400).json({ error: 'The selected path is not a folder.' });
    }

    const entries = await fs.readdir(bundleDir);
    const manifestFiles = entries.filter(entry => entry.toLowerCase().endsWith('.3dgp'));
    if (manifestFiles.length === 0) {
      return res.status(400).json({ error: 'No .3dgp file was found in the selected folder.' });
    }
    if (manifestFiles.length > 1) {
      return res.status(400).json({ error: 'The selected folder contains more than one .3dgp file.' });
    }

    const manifestRaw = await fs.readFile(path.join(bundleDir, manifestFiles[0]), 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      return res.status(400).json({ error: 'The .3dgp file is not valid JSON.' });
    }

    const project = await importProjectExport(manifest, bundleDir, { name });
    res.status(201).json(project);
  } catch (err) {
    console.error('Failed to import project:', err);
    res.status(500).json({ error: err.message || 'Failed to import project' });
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
      listLibraryAssetsByType('image', getRequestBaseUrl(req)),
      listLibraryAssetsByType('mesh', getRequestBaseUrl(req)),
      listLibraryAssetsByType('brush', getRequestBaseUrl(req))
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

      const createdAsset = await createLibraryAsset({
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
        id: createdAsset?.id ?? null,
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

// -------------------------------------------------------------------------
// Brush child assets — import additional brush PNGs as children of a parent brush
// -------------------------------------------------------------------------

app.post('/api/assets/library/brush-edits', libraryImportUpload.any(), async (req, res) => {
  try {
    const parentId = parseInt(String(req.body?.parentId || ''), 10);
    if (!parentId || isNaN(parentId)) {
      return res.status(400).json({ error: 'parentId is required and must be a valid asset id' });
    }

    const files = (req.files || []).filter(f => f.fieldname === 'files');
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const imported = [];
    const skipped = [];

    await Promise.all(files.map(async (file) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (extension !== '.png') {
        skipped.push({ name: file.originalname, reason: 'Brush edits must be PNG files' });
        return;
      }

      const storedFilePath = getBrushChildStoredFilePath(parentId, 'png');
      const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);
      const filename = toAssetUrlPath(storedFilePath);
      const dimensions = getImageDimensionsFromBuffer(file.buffer, { filename: file.originalname, mimeType: file.mimetype });

      await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
      await fs.writeFile(absoluteFilePath, file.buffer);

      const childRecord = await createBrushChildRecord({
        parentAssetId: parentId,
        name: file.originalname.replace(/\.png$/i, ''),
        filePath: storedFilePath,
        width: dimensions.width,
        height: dimensions.height,
        createdAt: Date.now()
      });

      imported.push({
        id: childRecord.id,
        name: childRecord.name,
        filename,
        parentId: childRecord.parentId
      });
    }));

    if (imported.length === 0 && skipped.length > 0) {
      return res.status(400).json({
        error: 'No brush edits were imported',
        imported,
        skipped
      });
    }

    res.status(201).json({ imported, skipped });
  } catch (err) {
    console.error('Failed to import brush edits:', err);
    res.status(500).json({ error: err.message || 'Failed to import brush edits' });
  }
});

// -------------------------------------------------------------------------
// Paint documents — sidecar layer data for painted meshes
// -------------------------------------------------------------------------

function buildPaintDocumentResponse(doc, assetId, baseUrl) {
  if (!doc) return null;
  const baseTextureUrl = doc.baseFilePath
    ? `${baseUrl}/assets/${encodeURI(doc.baseFilePath.replace(/^data\/assets\//, ''))}`
    : null;
  return {
    assetId,
    textureWidth: doc.textureWidth,
    textureHeight: doc.textureHeight,
    base: doc.baseFilePath ? { filePath: doc.baseFilePath, url: baseTextureUrl } : null,
    layers: (doc.layers || []).map(layer => ({
      ...layer,
      url: layer.filePath
        ? `${baseUrl}/assets/${encodeURI(layer.filePath.replace(/^data\/assets\//, ''))}`
        : null
    })),
    updatedAt: doc.updatedAt
  };
}

app.get('/api/assets/:assetId/paint-document', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid assetId' });
    }

    const doc = await getPaintDocumentByAssetId(assetId);
    if (!doc) {
      return res.status(404).json({ error: 'Paint document not found' });
    }

    res.json(buildPaintDocumentResponse(doc, assetId, getRequestBaseUrl(req)));
  } catch (err) {
    console.error('Failed to load paint document:', err);
    res.status(500).json({ error: err.message || 'Failed to load paint document' });
  }
});

app.put('/api/assets/:assetId/paint-document', paintDocumentUpload.any(), async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid assetId' });
    }

    const asset = await getAssetRecordById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    let metadata;
    try {
      metadata = JSON.parse(req.body?.metadata || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid metadata JSON' });
    }

    const textureWidth = Number(metadata.textureWidth) || 0;
    const textureHeight = Number(metadata.textureHeight) || 0;
    const incomingLayers = Array.isArray(metadata.layers) ? metadata.layers : [];

    const multipartFiles = req.files || [];
    const baseFile = multipartFiles.find(file => file.fieldname === 'base') || null;
    const layerFilesById = new Map(
      multipartFiles
        .filter(file => file.fieldname.startsWith('layer:'))
        .map(file => [file.fieldname.slice('layer:'.length), file])
    );

    const docDir = getPaintDocSubdir(assetId);
    await fs.mkdir(docDir, { recursive: true });

    // Existing record (so we can keep file paths for layers that weren't re-uploaded).
    const existing = await getPaintDocumentByAssetId(assetId);
    const existingLayerByFile = new Map();
    (existing?.layers || []).forEach(layer => {
      if (layer.filePath) existingLayerByFile.set(layer.id, layer.filePath);
    });

    // Write base texture if provided.
    let baseFilePath = existing?.baseFilePath || null;
    if (baseFile) {
      const baseFilename = 'base.png';
      await fs.writeFile(path.join(docDir, baseFilename), baseFile.buffer);
      baseFilePath = toStoredPaintDocPath(assetId, baseFilename);
    }

    // Write each layer file (if uploaded), then build the persisted layer list.
    const persistedLayers = [];
    const keptFilenames = new Set();
    if (baseFilePath) keptFilenames.add(path.basename(baseFilePath));

    for (const layer of incomingLayers) {
      if (!layer || typeof layer.id !== 'string') continue;
      const safeId = layer.id.replace(/[^a-zA-Z0-9._-]/g, '_');
      let filePath = existingLayerByFile.get(layer.id) || null;
      const file = layerFilesById.get(layer.id);

      if (file) {
        const filename = `${safeId}.png`;
        await fs.writeFile(path.join(docDir, filename), file.buffer);
        filePath = toStoredPaintDocPath(assetId, filename);
      }

      if (!filePath) continue; // no file for this layer — skip

      keptFilenames.add(path.basename(filePath));
      persistedLayers.push({
        id: layer.id,
        name: typeof layer.name === 'string' ? layer.name : '',
        opacity: Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1,
        blendMode: typeof layer.blendMode === 'string' ? layer.blendMode : 'source-over',
        color: typeof layer.color === 'string' ? layer.color : '#ffffff',
        visible: layer.visible !== false,
        filePath
      });
    }

    // Clean up orphan files (layers that were removed by the client).
    try {
      const entries = await fs.readdir(docDir);
      await Promise.all(entries.map(async name => {
        if (keptFilenames.has(name)) return;
        try {
          await fs.unlink(path.join(docDir, name));
        } catch (cleanupErr) {
          if (cleanupErr?.code !== 'ENOENT') {
            console.warn(`Failed to remove orphan paint file ${name}:`, cleanupErr);
          }
        }
      }));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn('Failed to inspect paint document dir for cleanup:', err);
      }
    }

    const saved = await upsertPaintDocument({
      assetId,
      baseFilePath,
      textureWidth,
      textureHeight,
      layers: persistedLayers
    });

    res.status(200).json(buildPaintDocumentResponse(saved, assetId, getRequestBaseUrl(req)));
  } catch (err) {
    console.error('Failed to save paint document:', err);
    res.status(500).json({ error: err.message || 'Failed to save paint document' });
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

// Enumerate available Windows drive roots (C:\, D:\, ...) by probing letters.
async function listWindowsDriveRoots() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      await fs.access(root);
      drives.push(root);
    } catch {
      // Drive letter not mounted; skip it.
    }
  }
  return drives;
}

function isWindowsDriveRoot(targetPath) {
  return /^[A-Za-z]:[\\/]?$/.test(targetPath);
}

// Browse directories on the host so the export dialog can pick an output
// folder. With no `path`, returns the drive list on Windows (or `/` elsewhere).
app.get('/api/filesystem/folders', async (req, res) => {
  try {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const isWindows = process.platform === 'win32';
    const home = os.homedir();
    const drives = isWindows ? await listWindowsDriveRoots() : [];

    // Empty path on Windows => show the list of drives as the top level.
    if (!requestedPath && isWindows) {
      return res.json({
        path: '',
        parent: null,
        separator: path.sep,
        home,
        drives,
        entries: drives.map(drive => ({ name: drive, path: drive, isDirectory: true }))
      });
    }

    const resolvedPath = path.resolve(requestedPath || (isWindows ? home : '/'));
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'The selected path is not a folder.' });
    }

    const dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const entries = dirEntries
      .filter(entry => {
        try {
          return entry.isDirectory();
        } catch {
          return false;
        }
      })
      .map(entry => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
        isDirectory: true
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Up from a drive root returns to the drive list on Windows; otherwise the
    // parent directory, or null when already at the filesystem root.
    let parent = path.dirname(resolvedPath);
    if (isWindows && isWindowsDriveRoot(resolvedPath)) {
      parent = '';
    } else if (parent === resolvedPath) {
      parent = null;
    }

    res.json({
      path: resolvedPath,
      parent,
      separator: path.sep,
      home,
      drives,
      entries
    });
  } catch (err) {
    console.error('Failed to browse folders:', err);
    const message = err.code === 'EACCES'
      ? 'Access to this folder is denied.'
      : err.code === 'ENOENT'
        ? 'That folder does not exist.'
        : (err.message || 'Failed to browse folders');
    res.status(400).json({ error: message });
  }
});

// Write exported mesh files (mesh + companions) into a user-chosen folder.
// --- Python mesh-tools proxy (Auto UV / Auto Retopo) -------------------------
// The browser uploads a mesh to one of these routes; Node forwards it to the
// configurable Python service (Settings > Mesh Tools) and streams back its
// Server-Sent Events (progress events + a terminal `done` event carrying the
// mesh_b64/stats/preview_b64). Mirrors how the ComfyUI integration proxies
// external compute.
const meshToolsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

async function proxyMeshTool(operationPath, req, res) {
  const meshFile = req.file;
  if (!meshFile?.buffer?.length) {
    return res.status(400).json({ error: 'meshFile is required' });
  }

  const settings = await getSettings();
  const baseUrl = buildMeshToolsBaseUrl(settings);

  const form = new FormData();
  form.append(
    'meshFile',
    new Blob([meshFile.buffer], { type: meshFile.mimetype || 'model/gltf-binary' }),
    meshFile.originalname || 'mesh.glb',
  );
  if (typeof req.body?.options === 'string' && req.body.options.length) {
    form.append('options', req.body.options);
  }
  if (typeof req.body?.format === 'string' && req.body.format.length) {
    form.append('format', req.body.format);
  }

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}${operationPath}`, { method: 'POST', body: form });
  } catch (err) {
    console.error(`Mesh tool proxy (${operationPath}) could not reach the Python service:`, err);
    return res.status(502).json({
      error: `Could not reach the Mesh Tools (Python) service at ${baseUrl}. Is it running?`,
    });
  }

  if (!upstream.ok) {
    // Pre-stream failures (bad options, mesh load) come back as JSON.
    const detail = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({
      error: `Mesh tool failed (${upstream.status})`,
      detail: detail.slice(0, 2000),
    });
  }

  // Stream the Server-Sent Events straight through to the browser.
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!upstream.body) {
    res.end();
    return undefined;
  }

  // Stream the upstream SSE to the browser. An aborted/failed upstream (e.g. the
  // Python service dies, or undici's fetch body timeout fires on a long silent
  // stage) makes this Readable emit 'error'. `.pipe()` does NOT forward source
  // errors, so without this handler the unhandled 'error' would crash the whole
  // Node process — taking every other endpoint (footer /system/stats, etc.) with
  // it. Handle it: log, send a terminal SSE error so the browser stops waiting,
  // and close cleanly.
  const source = Readable.fromWeb(upstream.body);
  source.on('error', err => {
    console.error(`Mesh tool proxy (${operationPath}) upstream stream error:`, err);
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', detail: 'The mesh service connection was lost.' })}\n\n`);
      } catch { /* response already gone */ }
      res.end();
    }
  });
  // If the browser hangs up, stop reading the upstream.
  res.on('close', () => { if (!source.destroyed) source.destroy(); });
  return source.pipe(res);
}

app.post('/api/meshes/auto-uv', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/auto-uv', req, res);
  } catch (err) {
    console.error('Auto UV proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Auto UV failed' });
  }
});

app.post('/api/meshes/auto-retopo', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/auto-retopo', req, res);
  } catch (err) {
    console.error('Auto Retopo proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Auto Retopo failed' });
  }
});

app.post('/api/meshes/repair', meshToolsUpload.single('meshFile'), async (req, res) => {
  try {
    await proxyMeshTool('/meshes/repair', req, res);
  } catch (err) {
    console.error('Repair proxy failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Repair failed' });
  }
});

// --- Mesh optimize (meshoptimizer / gltfpack binary) ------------------------
// Unlike Auto UV / Auto Retopo (which proxy to the Python service), this runs
// the bundled `gltfpack` binary locally. The browser uploads a GLB; we write it
// to a temp file, run gltfpack to simplify it (-si <ratio>), then return the
// simplified GLB as base64. `-noq` disables quantization so the output stays
// plain-float and loads cleanly into the editable geometry pipeline.
const MESHOPTIMIZER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'meshoptimizer');

function resolveGltfpackPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(MESHOPTIMIZER_DIR, 'win', 'gltfpack.exe');
  }
  if (platform === 'linux') {
    return path.join(MESHOPTIMIZER_DIR, 'linux', 'gltfpack');
  }
  if (platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm' : 'intel';
    return path.join(MESHOPTIMIZER_DIR, 'macos', arch, 'gltfpack');
  }
  throw new Error(`Unsupported platform for gltfpack: ${platform}`);
}

app.post('/api/meshes/optimize', meshToolsUpload.single('meshFile'), async (req, res) => {
  const tmpFiles = [];
  try {
    const meshFile = req.file;
    if (!meshFile?.buffer?.length) {
      return res.status(400).json({ error: 'meshFile is required' });
    }

    let options = {};
    if (typeof req.body?.options === 'string' && req.body.options.length) {
      try { options = JSON.parse(req.body.options); } catch { options = {}; }
    }
    let ratio = Number(options.simplify_ratio);
    if (!Number.isFinite(ratio)) ratio = 1;
    ratio = Math.min(1, Math.max(0.001, ratio));

    const binaryPath = resolveGltfpackPath();
    if (!existsSync(binaryPath)) {
      return res.status(500).json({ error: `gltfpack binary not found at ${binaryPath}` });
    }
    // git-checked-out unix binaries may lack the execute bit.
    if (process.platform !== 'win32') {
      try { await fs.chmod(binaryPath, 0o755); } catch { /* best effort */ }
    }

    const id = randomUUID();
    const inputPath = path.join(os.tmpdir(), `meshopt-${id}-in.glb`);
    const outputPath = path.join(os.tmpdir(), `meshopt-${id}-out.glb`);
    tmpFiles.push(inputPath, outputPath);
    await fs.writeFile(inputPath, meshFile.buffer);

    // -kv keeps source vertex attributes (UVs, normals) even when they look
    // "unused" — the editor exports meshes with an untextured placeholder
    // material, so without -kv gltfpack strips TEXCOORD_0 and the reloaded mesh
    // loses its UVs (disabling the texture/paint/projection modes).
    const args = ['-i', inputPath, '-o', outputPath, '-si', String(ratio), '-noq', '-kv'];
    const stderr = await new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, args, { windowsHide: true });
      let err = '';
      proc.stderr.on('data', chunk => { err += chunk.toString(); });
      proc.stdout.on('data', chunk => { err += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve(err);
        else reject(new Error(err.trim() || `gltfpack exited with code ${code}`));
      });
    });

    const outBuffer = await fs.readFile(outputPath);

    // Best-effort: pull the output triangle count from gltfpack's report.
    let triangles = null;
    const triMatch = [...stderr.matchAll(/([\d,]+)\s+triangles/gi)];
    if (triMatch.length) {
      triangles = Number(triMatch[triMatch.length - 1][1].replace(/,/g, ''));
    }

    res.json({
      mesh_b64: outBuffer.toString('base64'),
      stats: { simplify_ratio: ratio, triangles: Number.isFinite(triangles) ? triangles : null },
    });
  } catch (err) {
    console.error('Mesh optimize failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Mesh optimize failed' });
  } finally {
    await Promise.all(tmpFiles.map(f => fs.rm(f, { force: true }).catch(() => {})));
  }
});

app.post('/api/export/mesh', multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } }).array('files'), async (req, res) => {
  try {
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
    const files = Array.isArray(req.files) ? req.files : [];

    if (!folder) {
      return res.status(400).json({ error: 'An output folder is required.' });
    }
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files were provided to export.' });
    }
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'The output folder must be an absolute path.' });
    }

    const resolvedFolder = path.resolve(folder);
    await fs.mkdir(resolvedFolder, { recursive: true });

    const written = [];
    for (const file of files) {
      // Use only the base name to prevent writing outside the chosen folder.
      const safeName = path.basename(file.originalname || 'mesh.bin');
      const destination = path.join(resolvedFolder, safeName);
      await fs.writeFile(destination, file.buffer);
      written.push(safeName);
    }

    res.status(201).json({ folder: resolvedFolder, written });
  } catch (err) {
    console.error('Failed to export mesh files:', err);
    const message = err.code === 'EACCES'
      ? 'Access to the output folder is denied.'
      : (err.message || 'Failed to export mesh files');
    res.status(500).json({ error: message });
  }
});

app.post('/api/assets/image-editor/save', multer({ storage: multer.memoryStorage() }).single('imageFile'), async (req, res) => {
  try {
    const { assetId, saveMode = 'replace', name } = req.body || {};
    const imageFile = req.file;

    if (!imageFile?.buffer?.length) {
      return res.status(400).json({ error: 'imageFile is required' });
    }

    if (!assetId) {
      return res.status(400).json({ error: 'assetId is required' });
    }

    if (!['replace', 'version'].includes(saveMode)) {
      return res.status(400).json({ error: 'saveMode must be replace or version' });
    }

    const sourceAsset = await getAssetRecordById(Number(assetId));
    if (!sourceAsset) {
      return res.status(404).json({ error: 'Image asset not found' });
    }

    if (String(sourceAsset.assetTypeName || '').toLowerCase() !== 'image') {
      return res.status(400).json({ error: 'Selected asset is not an image' });
    }

    const nextName = String(name || '').trim() || sourceAsset.name || 'Image';
    const { width, height } = getImageDimensionsFromBuffer(imageFile.buffer, { filename: 'image.png', mimeType: 'image/png' });

    if (saveMode === 'replace') {
      const storedFilePath = sourceAsset.filePath;
      const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

      await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
      await fs.writeFile(absoluteFilePath, imageFile.buffer);

      const savedAsset = await replaceAssetFileById(sourceAsset.id, {
        name: nextName,
        type: 'image',
        filePath: storedFilePath,
        width,
        height,
        metadata: {
          ...JSON.parse(sourceAsset.metadata || '{}'),
          source: 'IMAGE EDITOR',
          editedAt: Date.now()
        }
      });

      return res.status(200).json(savedAsset);
    }

    // saveMode === 'version': save as new edit child of the root parent
    const editId = `edit-${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const storedFilePath = getImageEditStoredFilePath(sourceAsset, editId, 'png');
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, imageFile.buffer);

    const savedEdit = await createAssetEditRecord({
      assetId: sourceAsset.id,
      editId,
      name: nextName,
      filePath: storedFilePath,
      width,
      height,
      createdAt: Date.now()
    });

    return res.status(201).json(savedEdit);
  } catch (err) {
    console.error('Failed to save image editor result:', err);
    res.status(500).json({ error: err.message || 'Failed to save image editor result' });
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

app.delete('/api/cards/:cardId', async (req, res) => {
  try {
    const projectId = Number(req.query.projectId);

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.json(await deleteCard(projectId, req.params.cardId));
  } catch (err) {
    console.error('Failed to delete card:', err);
    res.status(500).json({ error: err.message || 'Failed to delete card' });
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
      throw new Error('The ComfyUI workflow finished but no images were returned');
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

// si.graphics() on Windows shells out to WMI/PowerShell and can take several
// seconds. Running it per-request (the footer polls every 3s) stacked up slow
// requests and saturated the browser's 6-connections-per-origin limit, stalling
// every other API call. Instead we refresh a cached snapshot in the background
// and serve it instantly.
let cachedSystemStats = null;
let systemStatsRefreshing = false;

async function refreshSystemStats() {
  if (systemStatsRefreshing) return;
  systemStatsRefreshing = true;
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
    }, graphics.controllers[0] || {});

    // 2. Universal Mapping: Check for both 'memoryUsed' (NVIDIA style)
    // and 'vramUsage' (AMD/Standard style)
    const rawVramUsed = gpu.memoryUsed || gpu.vramUsage || 0;
    const rawVramTotal = gpu.memoryTotal || gpu.vram || 0;

    cachedSystemStats = {
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
    };
  } catch (err) {
    console.error('Stats Error:', err);
  } finally {
    systemStatsRefreshing = false;
  }
}

// Kick off the first refresh immediately, then keep it warm in the background.
refreshSystemStats();
setInterval(refreshSystemStats, 5000);

app.get('/api/system/stats', (req, res) => {
  if (!cachedSystemStats) {
    return res.status(503).json({ error: 'Stats not ready yet' });
  }
  res.json(cachedSystemStats);
});

// ─── INITIAL SETUP ───

const SETUP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup');
const SETUP_CONFIG_PATH = path.join(SETUP_DIR, 'setup.json');
const SETUP_TYPE_TO_VALUE_TYPE = { Image: 'image', String: 'string', Number: 'number', Boolean: 'boolean', Mesh: 'mesh', Video: 'video' };
const setupDownloadJobs = new Map();

function getSetupDownloadJob(jobId) {
  if (!setupDownloadJobs.has(jobId)) {
    setupDownloadJobs.set(jobId, { subscribers: new Set(), snapshot: null });
  }
  return setupDownloadJobs.get(jobId);
}

function publishSetupDownloadProgress(jobId, payload) {
  const job = getSetupDownloadJob(jobId);
  const message = { jobId, timestamp: Date.now(), ...payload };
  job.snapshot = message;

  for (const response of job.subscribers) {
    response.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  if (message.status === 'done' || message.status === 'error') {
    setTimeout(() => {
      if (job.subscribers.size === 0) {
        setupDownloadJobs.delete(jobId);
      }
    }, 60000);
  }
}

function subscribeSetupDownload(jobId, req, res) {
  const job = getSetupDownloadJob(jobId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  job.subscribers.add(res);

  if (job.snapshot) {
    res.write(`data: ${JSON.stringify(job.snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.subscribers.delete(res);
  });
}

async function loadSetupConfig() {
  const raw = await fs.readFile(SETUP_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileSizeOrNull(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function resolveComfySubPath(comfyPath, relativePath) {
  const normalizedRelative = String(relativePath || '').replace(/^[/\\]+/, '');
  return path.join(comfyPath, normalizedRelative);
}

async function downloadFileWithProgress(url, destinationPath, onChunk) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  const totalBytes = Number(response.headers.get('content-length')) || 0;
  const tempPath = `${destinationPath}.part`;
  const writeStream = createWriteStream(tempPath);

  let receivedBytes = 0;

  try {
    for await (const chunk of response.body) {
      const writeOk = writeStream.write(chunk);
      if (!writeOk) {
        await new Promise(resolve => writeStream.once('drain', resolve));
      }
      receivedBytes += chunk.length;
      onChunk?.(receivedBytes, totalBytes);
    }

    await new Promise((resolve, reject) => {
      writeStream.end(err => err ? reject(err) : resolve());
    });

    await fs.rename(tempPath, destinationPath);
  } catch (err) {
    writeStream.destroy();
    try { await fs.unlink(tempPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  return { receivedBytes, totalBytes };
}

async function runSetupDownloads(jobId, comfyPath, files) {
  const totalExpectedBytes = files.reduce((sum, file) => sum + (Number(file.expectedBytes) || 0), 0);
  let cumulativeCompletedBytes = 0;

  publishSetupDownloadProgress(jobId, {
    status: 'downloading',
    currentIndex: 0,
    totalFiles: files.length,
    currentFile: files[0]?.fileName || '',
    currentBytes: 0,
    currentTotalBytes: 0,
    currentPercent: 0,
    overallPercent: 0
  });

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const destinationPath = resolveComfySubPath(comfyPath, path.join(file.relativeDir, file.fileName));

    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });

      const existingSize = await fileSizeOrNull(destinationPath);
      if (existingSize !== null && existingSize > 0) {
        cumulativeCompletedBytes += existingSize;
        publishSetupDownloadProgress(jobId, {
          status: 'downloading',
          currentIndex: index,
          totalFiles: files.length,
          currentFile: file.fileName,
          currentBytes: existingSize,
          currentTotalBytes: existingSize,
          currentPercent: 100,
          overallPercent: totalExpectedBytes > 0 ? Math.min(100, Math.round((cumulativeCompletedBytes / totalExpectedBytes) * 100)) : 0,
          skipped: true
        });
        continue;
      }

      let lastEmit = 0;
      let lastReceived = 0;

      const result = await downloadFileWithProgress(file.url, destinationPath, (currentBytes, currentTotalBytes) => {
        const now = Date.now();
        if (now - lastEmit < 200 && currentBytes < currentTotalBytes) {
          return;
        }
        lastEmit = now;
        lastReceived = currentBytes;

        publishSetupDownloadProgress(jobId, {
          status: 'downloading',
          currentIndex: index,
          totalFiles: files.length,
          currentFile: file.fileName,
          currentBytes,
          currentTotalBytes,
          currentPercent: currentTotalBytes > 0 ? Math.round((currentBytes / currentTotalBytes) * 100) : 0,
          overallPercent: totalExpectedBytes > 0 ? Math.min(100, Math.round(((cumulativeCompletedBytes + currentBytes) / totalExpectedBytes) * 100)) : 0
        });
      });

      cumulativeCompletedBytes += Math.max(result.receivedBytes, lastReceived);

      publishSetupDownloadProgress(jobId, {
        status: 'downloading',
        currentIndex: index,
        totalFiles: files.length,
        currentFile: file.fileName,
        currentBytes: result.receivedBytes,
        currentTotalBytes: result.totalBytes || result.receivedBytes,
        currentPercent: 100,
        overallPercent: totalExpectedBytes > 0 ? Math.min(100, Math.round((cumulativeCompletedBytes / totalExpectedBytes) * 100)) : 0
      });
    } catch (err) {
      console.error(`[setup] download failed for ${file.fileName}:`, err);
      publishSetupDownloadProgress(jobId, {
        status: 'error',
        currentIndex: index,
        totalFiles: files.length,
        currentFile: file.fileName,
        error: err.message || String(err)
      });
      return;
    }
  }

  publishSetupDownloadProgress(jobId, {
    status: 'done',
    totalFiles: files.length,
    currentIndex: files.length,
    overallPercent: 100
  });
}

async function deleteExistingWorkflowsByName(name) {
  const normalizedName = sanitizeDisplayName(name, 'Workflow');
  const records = await listWorkflowRecords();
  let deleted = 0;
  for (const record of records) {
    if (sanitizeDisplayName(record.name, 'Workflow') === normalizedName) {
      try {
        await deleteLibraryAssetByFilePath('workflow', record.filePath, { force: true });
        deleted += 1;
      } catch (err) {
        console.warn(`[setup] failed to delete existing workflow ${record.name}:`, err.message);
      }
    }
  }
  return deleted;
}

async function installSetupWorkflow(workflowConfig, diffusionModelFileName = '') {
  if (!workflowConfig?.File) {
    throw new Error('Workflow configuration is missing a File path');
  }

  const absoluteWorkflowPath = path.join(path.dirname(fileURLToPath(import.meta.url)), workflowConfig.File);
  const rawJson = await fs.readFile(absoluteWorkflowPath, 'utf-8');
  const substitutedJson = diffusionModelFileName
    ? rawJson.replaceAll('{diffusion_model}', diffusionModelFileName)
    : rawJson;
  const workflowJson = JSON.parse(substitutedJson);

  const parsedWorkflow = parseComfyWorkflow(workflowJson);
  const availableParameters = new Map(parsedWorkflow.inputs.map(input => [input.id, input]));
  const availableOutputs = new Map(parsedWorkflow.outputs.map(output => [String(output.nodeId), output]));

  const parameters = [];
  for (const inputCfg of workflowConfig.Inputs || []) {
    const parameterId = `${inputCfg.Node}.${inputCfg.Input}`;
    const sourceParameter = availableParameters.get(parameterId);
    if (!sourceParameter) {
      throw new Error(`Workflow "${workflowConfig.Name}": input ${parameterId} not found`);
    }
    parameters.push({
      ...sourceParameter,
      name: sanitizeDisplayName(inputCfg.Name || sourceParameter.name, sourceParameter.name),
      valueType: normalizeComfyValueType(SETUP_TYPE_TO_VALUE_TYPE[inputCfg.Type], getDefaultComfyValueType(sourceParameter))
    });
  }

  const outputs = [];
  for (const outputCfg of workflowConfig.Outputs || []) {
    const outputNodeId = String(outputCfg.Node);
    const sourceOutput = availableOutputs.get(outputNodeId);
    if (!sourceOutput) {
      throw new Error(`Workflow "${workflowConfig.Name}": output node ${outputNodeId} not found`);
    }
    outputs.push({
      ...sourceOutput,
      name: sanitizeDisplayName(outputCfg.Name || sourceOutput.nodeTitle, sourceOutput.nodeTitle),
      valueType: normalizeComfyValueType(SETUP_TYPE_TO_VALUE_TYPE[outputCfg.Type], 'image')
    });
  }

  if (outputs.length === 0) {
    throw new Error(`Workflow "${workflowConfig.Name}" has no outputs configured`);
  }

  const filePath = await saveWorkflowFile(workflowConfig.Name, workflowJson);
  const workflowRecord = await createWorkflowRecord({
    name: sanitizeDisplayName(workflowConfig.Name, 'Workflow'),
    filePath,
    parameters,
    outputs
  });

  return workflowRecord;
}

async function pickFolderNative({ description = 'Select folder', initialPath = '' } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Native folder picker is only available on Windows');
  }

  const safeDescription = String(description).replace(/'/g, "''");
  const safeInitial = String(initialPath || '').replace(/'/g, "''");

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '${safeDescription}'
$dlg.ShowNewFolderButton = $false
if ('${safeInitial}'.Length -gt 0 -and (Test-Path -LiteralPath '${safeInitial}')) {
  $dlg.SelectedPath = '${safeInitial}'
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
try {
  $result = $dlg.ShowDialog($owner)
} finally {
  $owner.Close()
  $owner.Dispose()
}
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
`;

  return await new Promise((resolve, reject) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`));
        return;
      }
      const selected = stdout.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
      resolve(selected);
    });
  });
}

app.post('/api/setup/pick-folder', async (req, res) => {
  try {
    const description = String(req.body?.description || 'Select folder').slice(0, 200);
    const initialPath = String(req.body?.initialPath || '').slice(0, 1024);
    const selected = await pickFolderNative({ description, initialPath });
    res.json({ path: selected });
  } catch (err) {
    console.error('Folder picker failed:', err);
    res.status(500).json({ error: err.message || 'Folder picker failed' });
  }
});

app.get('/api/setup/config', async (req, res) => {
  try {
    res.json(await loadSetupConfig());
  } catch (err) {
    console.error('Failed to load setup config:', err);
    res.status(500).json({ error: err.message || 'Failed to load setup config' });
  }
});

app.post('/api/setup/check-comfy-path', async (req, res) => {
  try {
    const comfyPath = String(req.body?.path || '').trim();
    if (!comfyPath) {
      return res.status(400).json({ error: 'A ComfyUI folder path is required' });
    }

    const rootExists = await pathExists(comfyPath);
    if (!rootExists) {
      return res.status(400).json({ error: `Folder does not exist: ${comfyPath}` });
    }

    const modelsDir = path.join(comfyPath, 'models');
    const modelsExist = await pathExists(modelsDir);
    if (!modelsExist) {
      return res.status(400).json({ error: `This does not look like a ComfyUI folder (missing "models" subfolder): ${comfyPath}` });
    }

    const config = await loadSetupConfig();
    const created = [];
    for (const relativePath of Object.values(config.ComfyUIPaths || {})) {
      const target = resolveComfySubPath(comfyPath, relativePath);
      if (!(await pathExists(target))) {
        await fs.mkdir(target, { recursive: true });
        created.push(relativePath);
      }
    }

    res.json({ ok: true, comfyPath, createdSubfolders: created });
  } catch (err) {
    console.error('Failed to validate ComfyUI path:', err);
    res.status(500).json({ error: err.message || 'Failed to validate ComfyUI path' });
  }
});

app.post('/api/setup/check-files', async (req, res) => {
  try {
    const comfyPath = String(req.body?.comfyPath || '').trim();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];

    if (!comfyPath) {
      return res.status(400).json({ error: 'comfyPath is required' });
    }

    const results = [];
    for (const file of files) {
      const absPath = resolveComfySubPath(comfyPath, path.join(file.relativeDir || '', file.fileName || ''));
      const size = await fileSizeOrNull(absPath);
      results.push({
        relativeDir: file.relativeDir || '',
        fileName: file.fileName || '',
        exists: size !== null && size > 0,
        sizeBytes: size
      });
    }

    res.json({ files: results });
  } catch (err) {
    console.error('Failed to check setup files:', err);
    res.status(500).json({ error: err.message || 'Failed to check setup files' });
  }
});

app.post('/api/setup/download', async (req, res) => {
  try {
    const comfyPath = String(req.body?.comfyPath || '').trim();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];

    if (!comfyPath) {
      return res.status(400).json({ error: 'comfyPath is required' });
    }

    if (files.length === 0) {
      const jobId = randomUUID();
      publishSetupDownloadProgress(jobId, { status: 'done', totalFiles: 0, currentIndex: 0, overallPercent: 100 });
      return res.json({ jobId });
    }

    const jobId = randomUUID();
    getSetupDownloadJob(jobId);

    runSetupDownloads(jobId, comfyPath, files).catch(err => {
      console.error('[setup] download job crashed:', err);
      publishSetupDownloadProgress(jobId, { status: 'error', error: err.message || String(err) });
    });

    res.json({ jobId });
  } catch (err) {
    console.error('Failed to start setup downloads:', err);
    res.status(500).json({ error: err.message || 'Failed to start setup downloads' });
  }
});

app.get('/api/setup/download/progress/:jobId', (req, res) => {
  subscribeSetupDownload(req.params.jobId, req, res);
});

app.post('/api/setup/install-workflows', async (req, res) => {
  try {
    const workflows = Array.isArray(req.body?.workflows) ? req.body.workflows : [];
    const overwrite = req.body?.overwrite === true;

    if (workflows.length === 0) {
      return res.json({ installed: [], skipped: [], errors: [] });
    }

    const config = await loadSetupConfig();
    const diffusionByName = new Map((config.DiffusionModels || []).map(model => [model.Name, model]));
    const workflowsByFile = new Map();
    for (const diffusion of config.DiffusionModels || []) {
      for (const workflow of diffusion.Workflows || []) {
        workflowsByFile.set(workflow.File, { workflow, diffusion });
      }
    }
    for (const workflow of config.OtherWorkflows || []) {
      workflowsByFile.set(workflow.File, { workflow, diffusion: null });
    }

    const existingByName = new Map();
    for (const record of await listWorkflowRecords()) {
      existingByName.set(sanitizeDisplayName(record.name, 'Workflow'), record);
    }

    const installed = [];
    const skipped = [];
    const errors = [];

    for (const selection of workflows) {
      const entry = workflowsByFile.get(selection.workflowFile);
      if (!entry) {
        errors.push({ workflowFile: selection.workflowFile, error: 'Unknown workflow' });
        continue;
      }

      const { workflow: workflowConfig, diffusion } = entry;
      const normalizedName = sanitizeDisplayName(workflowConfig.Name, 'Workflow');
      const existing = existingByName.get(normalizedName);

      if (existing && !overwrite) {
        skipped.push({ name: normalizedName, reason: 'already-installed' });
        continue;
      }

      let diffusionFileName = '';
      if (diffusion) {
        const diffusionRecord = selection.diffusionName ? diffusionByName.get(selection.diffusionName) : diffusion;
        const modelEntry = diffusionRecord?.Models?.[selection.modelQuality];
        if (!modelEntry?.FileName) {
          errors.push({ workflow: normalizedName, error: 'Missing diffusion model selection' });
          continue;
        }
        diffusionFileName = modelEntry.FileName;
      }

      try {
        if (existing && overwrite) {
          await deleteExistingWorkflowsByName(normalizedName);
          existingByName.delete(normalizedName);
        }

        const record = await installSetupWorkflow(workflowConfig, diffusionFileName);
        existingByName.set(normalizedName, record);
        installed.push({ id: record.id, name: record.name, overwritten: Boolean(existing) });
      } catch (err) {
        console.error(`[setup] failed to install workflow ${workflowConfig?.Name}:`, err);
        errors.push({ workflow: normalizedName, error: err.message || String(err) });
      }
    }

    res.json({ installed, skipped, errors });
  } catch (err) {
    console.error('Failed to install setup workflows:', err);
    res.status(500).json({ error: err.message || 'Failed to install setup workflows' });
  }
});

// Start server
// Copy any media referenced from the legacy data/assets/wiki location into the
// git-tracked wiki/media folder and rewrite the URLs so docs ship with the app.
async function rewriteAndCopyWikiMedia(content) {
  if (!content) return content;
  const regex = /(?:https?:\/\/[^/\s)]+)?\/assets\/wiki\/([^\s)"'<>]+)/g;
  const matches = [...content.matchAll(regex)];
  let result = content;
  for (const match of matches) {
    const fileName = decodeURIComponent(match[1]);
    try {
      await fs.copyFile(path.join(WIKI_ASSETS_DIR, fileName), path.join(WIKI_MEDIA_DIR, fileName));
    } catch {
      // source missing — leave the reference, nothing to copy
    }
    const newUrl = `http://localhost:${PORT}/wiki-media/${encodeURIComponent(fileName)}`;
    result = result.split(match[0]).join(newUrl);
  }
  return result;
}

async function migrateWikiIfNeeded() {
  if (wikiManifestExists()) return;

  let dbRows = [];
  try {
    dbRows = await dbListWikiPages();
  } catch {
    dbRows = [];
  }

  if (dbRows.length > 0) {
    await fs.mkdir(WIKI_MEDIA_DIR, { recursive: true });
    const fullPages = [];
    for (const row of dbRows) {
      const page = await dbGetWikiPage(row.id);
      if (!page) continue;
      page.content = await rewriteAndCopyWikiMedia(page.content);
      fullPages.push(page);
    }
    await importWikiPages(fullPages);
    console.log(`📚 Migrated ${fullPages.length} wiki page(s) from the database into the wiki/ folder`);
  } else {
    await seedWikiFiles();
    console.log('📚 Seeded the wiki/ folder with default documentation');
  }
}

// SPA fallback: any GET that isn't an API/asset/media route and didn't match a
// static file is a client-side (react-router) route — serve index.html so deep
// links work on a full reload. Registered last so it never shadows real routes.
if (HAS_DIST) {
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (/^\/(api|assets|wiki-media)(\/|$)/.test(req.path)) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

initializeStorage().then(async () => {
  try {
    await migrateWikiIfNeeded();
  } catch (err) {
    console.warn('Failed to prepare wiki documentation folder:', err.message);
  }

  try {
    const cleared = await clearStaleProcessingCards({
      preservedSources: ['Tencent Cloud', 'Tripo AI', 'Hitem3D']
    });
    if (cleared > 0) {
      console.log(`🧹 Cleared ${cleared} stale processing card(s) on startup`);
    }
  } catch (err) {
    console.warn('Failed to clear stale processing cards on startup:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`🚀 3D Gen Studio Backend running at http://localhost:${PORT}`);
    console.log(`📁 Local Workspace: ${DATA_DIR}`);
    if (HAS_DIST) {
      console.log(`🖥️  Serving bundled UI from dist/ — open http://localhost:${PORT}`);
    } else {
      console.log('ℹ️  No dist/ build found — run "npm run build" to serve the UI from this server.');
    }
  });
});
