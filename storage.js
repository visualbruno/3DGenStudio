import path from 'path';
import fs from 'fs/promises';
import sqlite3 from 'sqlite3';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const DB_FILE = path.join(DATA_DIR, 'app.db');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
export const IMAGE_ASSETS_DIR = path.join(ASSETS_DIR, 'images');
export const MESH_ASSETS_DIR = path.join(ASSETS_DIR, 'meshes');
export const THUMBNAIL_ASSETS_DIR = path.join(ASSETS_DIR, 'thumbnails');
export const WORKFLOW_ASSETS_DIR = path.join(ASSETS_DIR, 'workflows');

const sqlite = sqlite3.verbose();
const DATA_ASSETS_PREFIX = 'data/assets/';
const KANBAN_COLUMNS = [
  { id: 1, name: 'Images', position: 0 },
  { id: 2, name: 'Image Edit', position: 1 },
  { id: 3, name: 'Mesh Gen', position: 2 },
  { id: 4, name: 'Mesh Edit', position: 3 },
  { id: 5, name: 'Texturing', position: 4 }
];
const ASSET_TYPES = [
  { id: 1, name: 'Image' },
  { id: 2, name: 'Mesh' },
  { id: 3, name: 'Workflow' }
];

export const DEFAULT_SETTINGS = {
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
};

let dbPromise;

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite.Database(filename, err => {
      if (err) {
        reject(err);
        return;
      }

      resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row ?? null);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows ?? []);
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, err => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

function parseJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapProjectRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    preset: row.preset || '',
    createdAt: row.creationDate,
    status: row.status || 'active'
  };
}

function mapTaskRow(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name || `Task_${row.id}`,
    progress: row.progress ?? 0,
    status: row.status || 'processing',
    metadata: parseJson(row.metadata, {}),
    createdAt: row.creationDate
  };
}

function mapAssetRow(row) {
  const metadata = parseJson(row.metadata, {});
  const filename = toAssetUrlPath(row.filePath);
  const thumbnail = row.thumbnail ? toAssetUrlPath(row.thumbnail) : null;

  if (row.cardId) {
    metadata.cardId = row.clientKey || String(row.cardId);
  }

  return {
    id: row.id,
    projectId: row.projectId,
    type: String(row.assetTypeName || '').toLowerCase(),
    name: row.name,
    filePath: row.filePath,
    filename,
    thumbnailPath: row.thumbnail || null,
    thumbnail,
    metadata,
    createdAt: row.creationDate
  };
}

function normalizeAssetTypeName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = initializeStorage();
  }

  return dbPromise;
}

async function seedReferenceTables(db) {
  for (const column of KANBAN_COLUMNS) {
    await run(
      db,
      `INSERT INTO KanbanColumns (id, name, position)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = excluded.position`,
      [column.id, column.name, column.position]
    );
  }

  for (const assetType of ASSET_TYPES) {
    await run(
      db,
      `INSERT INTO AssetTypes (id, name)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      [assetType.id, assetType.name]
    );
  }

  await run(
    db,
    'INSERT OR IGNORE INTO Settings (id, json) VALUES (1, ?)',
    [JSON.stringify(DEFAULT_SETTINGS)]
  );
}

export async function initializeStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.mkdir(IMAGE_ASSETS_DIR, { recursive: true });
  await fs.mkdir(MESH_ASSETS_DIR, { recursive: true });
  await fs.mkdir(THUMBNAIL_ASSETS_DIR, { recursive: true });
  await fs.mkdir(WORKFLOW_ASSETS_DIR, { recursive: true });

  const db = await openDatabase(DB_FILE);
  await exec(db, 'PRAGMA foreign_keys = ON');
  await exec(
    db,
    `
    CREATE TABLE IF NOT EXISTS Projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      preset TEXT,
      creationDate INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS KanbanColumns (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS Cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      kanbanColumnId INTEGER NOT NULL,
      clientKey TEXT,
      name TEXT,
      position INTEGER NOT NULL,
      creationDate INTEGER NOT NULL,
      status TEXT,
      progress INTEGER,
      metadata TEXT,
      FOREIGN KEY(projectId) REFERENCES Projects(id) ON DELETE CASCADE,
      FOREIGN KEY(kanbanColumnId) REFERENCES KanbanColumns(id),
      UNIQUE(projectId, kanbanColumnId, position),
      UNIQUE(projectId, clientKey)
    );

    CREATE TABLE IF NOT EXISTS AssetTypes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS Assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      filePath TEXT NOT NULL,
      assetTypeId INTEGER NOT NULL,
      creationDate INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY(assetTypeId) REFERENCES AssetTypes(id)
    );

    CREATE TABLE IF NOT EXISTS Cards_Assets (
      cardId INTEGER NOT NULL,
      assetId INTEGER NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(cardId, assetId),
      FOREIGN KEY(cardId) REFERENCES Cards(id) ON DELETE CASCADE,
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE RESTRICT,
      UNIQUE(cardId, position)
    );

    CREATE TABLE IF NOT EXISTS WorkflowConfigs (
      assetId INTEGER PRIMARY KEY,
      parametersJson TEXT NOT NULL DEFAULT '[]',
      outputsJson TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    `
  );

  const assetColumns = await all(db, 'PRAGMA table_info(Assets)');
  if (!assetColumns.some(column => column.name === 'thumbnail')) {
    await run(db, 'ALTER TABLE Assets ADD COLUMN thumbnail TEXT');
  }

  await seedReferenceTables(db);
  return db;
}

export function getAssetDirectory(type = 'image') {
  if (type === 'mesh') return MESH_ASSETS_DIR;
  if (type === 'workflow') return WORKFLOW_ASSETS_DIR;
  return IMAGE_ASSETS_DIR;
}

export function getAssetSubdirectory(type = 'image') {
  if (type === 'mesh') return 'meshes';
  if (type === 'workflow') return 'workflows';
  return 'images';
}

export function toStoredAssetPath(type, filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalizedPath) return normalizedPath;
  if (normalizedPath.startsWith(DATA_ASSETS_PREFIX)) return normalizedPath;

  const subdirectory = getAssetSubdirectory(type);
  if (normalizedPath.startsWith(`${subdirectory}/`)) {
    return `${DATA_ASSETS_PREFIX}${normalizedPath}`;
  }

  if (normalizedPath.startsWith('assets/')) {
    return `data/${normalizedPath}`;
  }

  return `${DATA_ASSETS_PREFIX}${subdirectory}/${path.basename(normalizedPath)}`;
}

export function toStoredThumbnailPath(filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalizedPath) return normalizedPath;
  if (normalizedPath.startsWith(DATA_ASSETS_PREFIX)) return normalizedPath;

  if (normalizedPath.startsWith('thumbnails/')) {
    return `${DATA_ASSETS_PREFIX}${normalizedPath}`;
  }

  return `${DATA_ASSETS_PREFIX}thumbnails/${path.basename(normalizedPath)}`;
}

export function toAssetUrlPath(filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');
  if (normalizedPath.startsWith(DATA_ASSETS_PREFIX)) {
    return normalizedPath.slice(DATA_ASSETS_PREFIX.length);
  }

  if (normalizedPath.startsWith('assets/')) {
    return normalizedPath.slice('assets/'.length);
  }

  return normalizedPath;
}

export function toAbsoluteStoragePath(filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalizedPath) return normalizedPath;
  return path.join(process.cwd(), normalizedPath);
}

async function getKanbanColumnIdByName(name) {
  const db = await getDb();
  const row = await get(db, 'SELECT id FROM KanbanColumns WHERE name = ?', [name]);
  if (!row) {
    throw new Error(`Unknown Kanban column: ${name}`);
  }

  return row.id;
}

async function getAssetTypeIdByName(name) {
  const db = await getDb();
  const normalizedName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  const row = await get(db, 'SELECT id FROM AssetTypes WHERE name = ?', [normalizedName]);
  if (!row) {
    throw new Error(`Unknown asset type: ${name}`);
  }

  return row.id;
}

async function getNextCardPosition(projectId, kanbanColumnId) {
  const db = await getDb();
  const row = await get(
    db,
    'SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM Cards WHERE projectId = ? AND kanbanColumnId = ?',
    [projectId, kanbanColumnId]
  );

  return row?.nextPosition ?? 0;
}

async function getNextCardAssetPosition(cardId) {
  const db = await getDb();
  const row = await get(
    db,
    'SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM Cards_Assets WHERE cardId = ?',
    [cardId]
  );

  return row?.nextPosition ?? 0;
}

async function resolveCard(projectId, kanbanColumnId, externalCardId = null) {
  if (!externalCardId) return null;

  const db = await getDb();
  const externalCardIdString = String(externalCardId);
  const numericCardId = Number(externalCardIdString);

  if (Number.isInteger(numericCardId) && String(numericCardId) === externalCardIdString) {
    return await get(
      db,
      'SELECT id, clientKey FROM Cards WHERE id = ? AND projectId = ? AND kanbanColumnId = ?',
      [numericCardId, projectId, kanbanColumnId]
    );
  }

  return await get(
    db,
    'SELECT id, clientKey FROM Cards WHERE clientKey = ? AND projectId = ? AND kanbanColumnId = ?',
    [externalCardIdString, projectId, kanbanColumnId]
  );
}

async function ensureCard(projectId, columnName, externalCardId = null, values = {}) {
  const db = await getDb();
  const kanbanColumnId = await getKanbanColumnIdByName(columnName);
  const existingCard = await resolveCard(projectId, kanbanColumnId, externalCardId);

  if (existingCard) {
    return existingCard;
  }

  const position = await getNextCardPosition(projectId, kanbanColumnId);
  const clientKey = externalCardId && !/^\d+$/.test(String(externalCardId)) ? String(externalCardId) : null;
  const metadata = JSON.stringify(values.metadata || {});
  const result = await run(
    db,
    `INSERT INTO Cards (projectId, kanbanColumnId, clientKey, name, position, creationDate, status, progress, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      kanbanColumnId,
      clientKey,
      values.name || null,
      position,
      values.creationDate || Date.now(),
      values.status || null,
      values.progress ?? null,
      metadata
    ]
  );

  return {
    id: result.lastID,
    clientKey
  };
}

async function insertAsset({ name, type, filePath, thumbnailPath = null, metadata = {}, createdAt = Date.now() }) {
  const db = await getDb();
  const assetTypeId = await getAssetTypeIdByName(type);
  const result = await run(
    db,
    'INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail) VALUES (?, ?, ?, ?, ?, ?)',
    [
      name,
      toStoredAssetPath(type, filePath),
      assetTypeId,
      createdAt,
      JSON.stringify(metadata),
      thumbnailPath ? toStoredThumbnailPath(thumbnailPath) : null
    ]
  );

  return result.lastID;
}

async function getAssetViewById(assetId) {
  const db = await getDb();
  const row = await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            at.name AS assetTypeName,
            c.projectId, c.id AS cardId, c.clientKey
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN Cards_Assets ca ON ca.assetId = a.id
     LEFT JOIN Cards c ON c.id = ca.cardId
     WHERE a.id = ?
     ORDER BY ca.position ASC
     LIMIT 1`,
    [assetId]
  );

  return row ? mapAssetRow(row) : null;
}

export async function listProjects() {
  const db = await getDb();
  const rows = await all(db, 'SELECT * FROM Projects ORDER BY creationDate DESC');
  return rows.map(mapProjectRow);
}

export async function createProject(projectData = {}) {
  const db = await getDb();
  const project = {
    id: Date.now(),
    name: projectData.name || 'Untitled Project',
    description: projectData.description || '',
    preset: projectData.preset || '',
    createdAt: Date.now(),
    status: projectData.status || 'active'
  };

  await run(
    db,
    'INSERT INTO Projects (id, name, description, preset, creationDate, status) VALUES (?, ?, ?, ?, ?, ?)',
    [project.id, project.name, project.description, project.preset, project.createdAt, project.status]
  );

  return project;
}

export async function getProjectById(projectId) {
  const db = await getDb();
  const row = await get(db, 'SELECT * FROM Projects WHERE id = ?', [projectId]);
  return row ? mapProjectRow(row) : null;
}

export async function deleteProjectById(projectId) {
  const db = await getDb();
  await run(db, 'DELETE FROM Projects WHERE id = ?', [projectId]);
  await run(
    db,
    `DELETE FROM Assets
     WHERE assetTypeId != (SELECT id FROM AssetTypes WHERE name = 'Workflow')
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets WHERE Cards_Assets.assetId = Assets.id)`
  );
}

export async function listProjectTasks(projectId) {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT c.*
     FROM Cards c
     JOIN KanbanColumns kc ON kc.id = c.kanbanColumnId
     WHERE c.projectId = ? AND kc.name = 'Mesh Gen'
     ORDER BY c.position ASC`,
    [projectId]
  );

  return rows.map(mapTaskRow);
}

export async function createTask(projectId, taskData = {}) {
  const card = await ensureCard(projectId, 'Mesh Gen', null, {
    name: taskData.name || null,
    creationDate: Date.now(),
    status: 'processing',
    progress: 0,
    metadata: taskData.metadata || {}
  });

  const db = await getDb();
  const row = await get(db, 'SELECT * FROM Cards WHERE id = ?', [card.id]);
  return mapTaskRow(row);
}

export async function listProjectAssets(projectId = null) {
  const db = await getDb();
  const params = [];
  let whereClause = `WHERE at.name IN ('Image', 'Mesh')`;

  if (projectId !== null && projectId !== undefined) {
    whereClause += ' AND c.projectId = ?';
    params.push(projectId);
  }

  const rows = await all(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            at.name AS assetTypeName,
            c.projectId, c.id AS cardId, c.clientKey,
            ca.position AS assetPosition
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     JOIN Cards_Assets ca ON ca.assetId = a.id
     JOIN Cards c ON c.id = ca.cardId
     ${whereClause}
     ORDER BY c.creationDate DESC, ca.position ASC, a.creationDate DESC`,
    params
  );

  return rows.map(mapAssetRow);
}

export async function createProjectAsset({ projectId, type, name, filePath, thumbnailPath = null, metadata = {}, createdAt = Date.now() }) {
  const card = await ensureCard(projectId, 'Images', metadata.cardId, {
    creationDate: createdAt
  });
  const assetId = await insertAsset({
    name,
    type,
    filePath,
    thumbnailPath,
    metadata,
    createdAt
  });
  const db = await getDb();
  const position = await getNextCardAssetPosition(card.id);

  await run(
    db,
    'INSERT INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, ?)',
    [card.id, assetId, position]
  );

  return await getAssetViewById(assetId);
}

export async function createLibraryAsset({ name, type, filePath, thumbnailPath = null, metadata = {}, createdAt = Date.now() }) {
  const assetId = await insertAsset({
    name,
    type,
    filePath,
    thumbnailPath,
    metadata,
    createdAt
  });

  return await getAssetViewById(assetId);
}

export async function findLibraryAssetByFilePath(type, filePath) {
  const db = await getDb();
  return await get(
    db,
    `SELECT a.id, a.thumbnail
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND a.filePath = ?
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets ca WHERE ca.assetId = a.id)
     ORDER BY a.creationDate DESC
     LIMIT 1`,
    [normalizeAssetTypeName(type), toStoredAssetPath(type, filePath)]
  );
}

async function deleteCardsIfEmpty(cardIds = []) {
  const uniqueCardIds = [...new Set(cardIds.filter(cardId => Number.isInteger(cardId)))];

  if (uniqueCardIds.length === 0) {
    return;
  }

  const db = await getDb();
  const placeholders = uniqueCardIds.map(() => '?').join(', ');

  await run(
    db,
    `DELETE FROM Cards
     WHERE id IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets WHERE Cards_Assets.cardId = Cards.id)`,
    uniqueCardIds
  );
}

export async function deleteAssetById(assetId) {
  const db = await getDb();
  const asset = await get(db, 'SELECT id FROM Assets WHERE id = ?', [assetId]);

  if (!asset) {
    return { status: 'not-found' };
  }

  const links = await all(db, 'SELECT cardId FROM Cards_Assets WHERE assetId = ?', [assetId]);
  if (links.length > 0) {
    await run(db, 'DELETE FROM Cards_Assets WHERE assetId = ?', [assetId]);
    await deleteCardsIfEmpty(links.map(link => link.cardId));
    return { status: 'unlinked' };
  }

  await run(db, 'DELETE FROM Assets WHERE id = ?', [assetId]);
  return { status: 'deleted' };
}

export async function getSettings() {
  const db = await getDb();
  const row = await get(db, 'SELECT json FROM Settings WHERE id = 1');
  return parseJson(row?.json, DEFAULT_SETTINGS);
}

export async function saveSettings(settings) {
  const db = await getDb();
  await run(db, 'INSERT INTO Settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', [JSON.stringify(settings)]);
  return settings;
}

export async function listWorkflowRecords() {
  const db = await getDb();
  return await all(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate,
            wc.parametersJson, wc.outputsJson
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN WorkflowConfigs wc ON wc.assetId = a.id
     WHERE at.name = 'Workflow'
     ORDER BY a.creationDate DESC`
  );
}

export async function getWorkflowRecordById(workflowId) {
  const db = await getDb();
  return await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate,
            wc.parametersJson, wc.outputsJson
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN WorkflowConfigs wc ON wc.assetId = a.id
     WHERE at.name = 'Workflow' AND a.id = ?`,
    [workflowId]
  );
}

export async function createWorkflowRecord({ name, filePath, parameters = [], outputs = [] }) {
  const assetId = await insertAsset({
    name,
    type: 'workflow',
    filePath,
    metadata: {},
    createdAt: Date.now()
  });
  const db = await getDb();

  await run(
    db,
    'INSERT INTO WorkflowConfigs (assetId, parametersJson, outputsJson) VALUES (?, ?, ?)',
    [assetId, JSON.stringify(parameters), JSON.stringify(outputs)]
  );

  return await getWorkflowRecordById(assetId);
}

export async function updateWorkflowRecord(workflowId, { name, parameters = [], outputs = [] }) {
  const db = await getDb();

  await run(db, 'UPDATE Assets SET name = ? WHERE id = ?', [name, workflowId]);
  await run(
    db,
    `INSERT INTO WorkflowConfigs (assetId, parametersJson, outputsJson)
     VALUES (?, ?, ?)
     ON CONFLICT(assetId) DO UPDATE SET
       parametersJson = excluded.parametersJson,
       outputsJson = excluded.outputsJson`,
    [workflowId, JSON.stringify(parameters), JSON.stringify(outputs)]
  );

  return await getWorkflowRecordById(workflowId);
}

export async function listLibraryAssetsByType(type, port) {
  const db = await getDb();
  const assetDirectory = getAssetDirectory(type);
  const subdirectory = getAssetSubdirectory(type);
  await fs.mkdir(assetDirectory, { recursive: true });
  const entries = await fs.readdir(assetDirectory, { withFileTypes: true });
  const rows = await all(
    db,
    `SELECT a.id, a.name, a.filePath, a.thumbnail, a.creationDate
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets ca WHERE ca.assetId = a.id)
     ORDER BY a.creationDate DESC`,
    [normalizeAssetTypeName(type)]
  );

  const dbAssets = rows.map(row => {
    const filename = toAssetUrlPath(row.filePath);
    const thumbnailFilename = row.thumbnail ? toAssetUrlPath(row.thumbnail) : null;

    return {
      id: `library:${row.id}`,
      name: row.name,
      filename,
      filePath: row.filePath,
      type,
      extension: path.extname(filename).replace('.', '').toUpperCase() || type.toUpperCase(),
      url: `http://localhost:${port}/assets/${encodeURI(filename)}`,
      thumbnailPath: row.thumbnail || null,
      thumbnailUrl: thumbnailFilename ? `http://localhost:${port}/assets/${encodeURI(thumbnailFilename)}` : null
    };
  });

  const knownFilenames = new Set(dbAssets.map(asset => asset.filename));

  const fileAssets = entries
    .filter(entry => entry.isFile())
    .filter(entry => !knownFilenames.has(`${subdirectory}/${entry.name}`))
    .sort((left, right) => right.name.localeCompare(left.name))
    .map(entry => {
      const filename = `${subdirectory}/${entry.name}`;
      return {
        id: `file:${type}:${entry.name}`,
        name: entry.name,
        filename,
        filePath: toStoredAssetPath(type, filename),
        type,
        extension: path.extname(entry.name).replace('.', '').toUpperCase() || type.toUpperCase(),
        url: `http://localhost:${port}/assets/${encodeURI(filename)}`,
        thumbnailPath: null,
        thumbnailUrl: null
      };
    });

  return [...dbAssets, ...fileAssets];
}
