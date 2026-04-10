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

console.log('DEBUG: DATA_DIR is', DATA_DIR);
console.log('DEBUG: DB_FILE is', DB_FILE);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/assets', express.static(ASSETS_DIR));

// Multer Config for Asset Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ASSETS_DIR),
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

/**
 * Robust DB Sync / Initialization
 * This ensures the data/ folder and db.json exist before any read/write.
 */
async function ensureDb() {
  try {
    // 1. Ensure Directories
    if (!existsSync(DATA_DIR)) await fs.mkdir(DATA_DIR, { recursive: true });
    if (!existsSync(ASSETS_DIR)) await fs.mkdir(ASSETS_DIR, { recursive: true });

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

    if (JSON.stringify(mergedDb) !== JSON.stringify(db)) {
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

app.post('/api/assets/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const db = await readDb();
    const newAsset = {
      id: Date.now(),
      projectId: parseInt(req.body.projectId),
      type: req.body.type || 'image',
      name: req.body.name || req.file.originalname,
      filename: req.file.filename,
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

app.post('/api/images/generate', async (req, res) => {
  try {
    const { projectId, selectedApi, prompt } = req.body;

    if (!projectId || !selectedApi || !prompt?.trim()) {
      return res.status(400).json({ error: 'projectId, selectedApi and prompt are required' });
    }

    const db = await readDb();
    const googleSettings = db.settings?.apis?.google;
    const generationSettings = googleSettings?.imageGeneration;
    const modelConfig = generationSettings?.models?.[selectedApi];

    if (!modelConfig?.url) {
      return res.status(400).json({ error: `Unsupported image API: ${selectedApi}` });
    }

    if (!googleSettings?.apiKey) {
      return res.status(400).json({ error: 'Google API key is not configured in settings' });
    }

    const payloadTemplate = generationSettings?.payloadTemplate;
    const requestPayload = replacePromptPlaceholder(payloadTemplate, prompt.trim());
    const headerName = generationSettings?.headerName || 'x-goog-api-key';

    const response = await fetch(modelConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerName]: googleSettings.apiKey
      },
      body: JSON.stringify(requestPayload)
    });

    const responseBody = await response.json();

    if (!response.ok) {
      console.error('Google image generation failed:', responseBody);
      return res.status(response.status).json({
        error: responseBody?.error?.message || 'Image generation request failed'
      });
    }

    const inlineData = responseBody?.candidates
      ?.flatMap(candidate => candidate?.content?.parts || [])
      ?.find(part => part?.inlineData?.data)
      ?.inlineData;

    if (!inlineData?.data) {
      return res.status(502).json({ error: 'Image generation succeeded but no image data was returned' });
    }

    const extension = getExtensionFromMimeType(inlineData.mimeType);
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;
    const filePath = path.join(ASSETS_DIR, filename);

    await fs.writeFile(filePath, Buffer.from(inlineData.data, 'base64'));

    const newAsset = {
      id: Date.now(),
      projectId: parseInt(projectId),
      type: 'image',
      name: createGeneratedImageName(prompt, extension),
      filename,
      metadata: {
        resolution: 'Unknown',
        format: extension.toUpperCase(),
        source: 'AI GEN',
        provider: modelConfig.name,
        modelVersion: responseBody?.modelVersion || null,
        mimeType: inlineData.mimeType,
        responseId: responseBody?.responseId || null
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
