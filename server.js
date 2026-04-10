import express from 'express';
import cors from 'cors';
import multer from 'multer';
import process from 'process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Buffer } from 'buffer';
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
app.use(express.json());
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
const upload = multer({ storage });

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
      custom: []
    }
  }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
