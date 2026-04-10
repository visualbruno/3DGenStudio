import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
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
      google: { apiKey: '' },
      openai: { apiKey: '' },
      custom: []
    }
  }
};

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
    // Merge with initial schema to ensure all keys exist
    return { ...INITIAL_SCHEMA, ...db };
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
  } catch (err) {
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
  } catch (err) {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const db = await readDb();
    const project = db.projects.find(p => p.id == req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
    res.status(500).json({ error: 'Upload recording failed' });
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
  } catch (err) {
    res.status(500).json({ error: 'Task creation failed' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const db = await readDb();
    res.json(db.settings || INITIAL_SCHEMA.settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const db = await readDb();
    db.settings = { ...db.settings, ...req.body };
    await writeDb(db);
    res.json(db.settings);
  } catch (err) {
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
