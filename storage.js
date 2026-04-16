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
const ATTRIBUTE_TYPES = [
  { id: 1, name: 'Text' },
  { id: 2, name: 'Number' }
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
      openai: {
        apiKey: '',
        imageGeneration: {
          url: 'https://api.openai.com/v1/images/generations',
          headers: {
            Authorization: 'Bearer {apiKey}'
          },
          payloadTemplate: {
            model: 'gpt-image-1.5',
            prompt: '{prompt}',
            n: 1,
            size: '1024x1024'
          },
          models: {
            openai_gpt_image_1: {
              name: 'gpt-image-1',
              model: 'gpt-image-1'
            },
            openai_gpt_image_1_5: {
              name: 'gpt-image-1.5',
              model: 'gpt-image-1.5'
            }
          },
          responseMapping: {
            imageBase64Field: 'data[0].b64_json',
            createdField: 'created',
            usageField: 'usage'
          }
        },
        imageEdit: {
          url: 'https://api.openai.com/v1/images/edits',
          headers: {
            Authorization: 'Bearer {apiKey}'
          },
          payloadTemplate: {
            model: 'gpt-image-1.5',
            prompt: '{prompt}',
            size: '1024x1024'
          },
          models: {
            openai_gpt_image_1: {
              name: 'gpt-image-1',
              model: 'gpt-image-1'
            },
            openai_gpt_image_1_5: {
              name: 'gpt-image-1.5',
              model: 'gpt-image-1.5'
            }
          },
          responseMapping: {
            imageBase64Field: 'data[0].b64_json',
            createdField: 'created',
            usageField: 'usage'
          }
        }
      },
    comfyui: {
      path: '',
      url: 'http://127.0.0.1',
      port: '8188'
    },
    custom: []
  }
};

const DEFAULT_CUSTOM_API_TYPE = 'image-generation';

function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE;
}

function normalizeSettingsValue(settings = DEFAULT_SETTINGS) {
  return {
    ...settings,
    apis: {
      ...settings?.apis,
      custom: (settings?.apis?.custom || []).map(api => ({
        ...api,
        type: normalizeCustomApiType(api?.type)
      }))
    }
  };
}

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeWithDefaults(defaultValue, currentValue) {
  if (!isPlainObject(defaultValue) || !isPlainObject(currentValue)) {
    return currentValue === undefined ? defaultValue : currentValue;
  }

  const merged = { ...defaultValue };

  for (const [key, value] of Object.entries(currentValue)) {
    merged[key] = key in defaultValue
      ? mergeWithDefaults(defaultValue[key], value)
      : value;
  }

  return merged;
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

function mapProjectCardRow(row) {
  const metadata = parseJson(row.metadata, {});
  const processing = isPlainObject(metadata?.processing) ? metadata.processing : null;

  return {
    id: row.clientKey || String(row.id),
    cardDbId: row.id,
    projectId: row.projectId,
    name: row.name || '',
    kanbanColumnId: row.kanbanColumnId ?? null,
    kanbanColumnName: row.kanbanColumnName || null,
    position: row.position ?? 0,
    status: row.status || null,
    progress: row.progress ?? null,
    metadata,
    processing,
    createdAt: row.creationDate
  };
}

function mapAssetRow(row) {
  const metadata = parseJson(row.metadata, {});
  const cardMetadata = parseJson(row.cardMetadata, {});
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
    width: row.width ?? 0,
    height: row.height ?? 0,
    thumbnailPath: row.thumbnail || null,
    thumbnail,
    cardDbId: row.cardId ?? null,
    cardKey: row.cardId ? (row.clientKey || String(row.cardId)) : null,
    cardName: row.cardName || '',
    kanbanColumnId: row.kanbanColumnId ?? null,
    kanbanColumnName: row.kanbanColumnName || null,
    cardPosition: row.cardPosition ?? null,
    assetPosition: row.assetPosition ?? null,
    cardStatus: row.cardStatus || null,
    cardProgress: row.cardProgress ?? null,
    cardMetadata,
    processing: isPlainObject(cardMetadata?.processing) ? cardMetadata.processing : null,
    metadata,
    createdAt: row.creationDate
  };
}

function mapCardAttributeRow(row) {
  return {
    cardDbId: row.cardId,
    cardId: row.clientKey || String(row.cardId),
    position: row.position,
    attributeTypeId: row.attributeTypeId,
    attributeTypeName: row.attributeTypeName,
    attributeValue: row.attributeValue ?? ''
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

  for (const attributeType of ATTRIBUTE_TYPES) {
    await run(
      db,
      `INSERT INTO Attributes (id, name)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      [attributeType.id, attributeType.name]
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

    CREATE TABLE IF NOT EXISTS Attributes (
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
      thumbnail TEXT,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS Cards_Attributes (
      cardId INTEGER NOT NULL,
      position INTEGER NOT NULL,
      attributeTypeId INTEGER NOT NULL,
      attributeValue TEXT,
      PRIMARY KEY(cardId, position),
      FOREIGN KEY(cardId) REFERENCES Cards(id) ON DELETE CASCADE,
      FOREIGN KEY(attributeTypeId) REFERENCES Attributes(id),
      UNIQUE(cardId, position)
    );

    CREATE TABLE IF NOT EXISTS Assets_Edits (
      assetId INTEGER NOT NULL,
      editId TEXT NOT NULL,
      name TEXT,
      filePath TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      creationDate INTEGER NOT NULL,
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE CASCADE
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
  if (!assetColumns.some(column => column.name === 'width')) {
    await run(db, 'ALTER TABLE Assets ADD COLUMN width INTEGER NOT NULL DEFAULT 0');
  }
  if (!assetColumns.some(column => column.name === 'height')) {
    await run(db, 'ALTER TABLE Assets ADD COLUMN height INTEGER NOT NULL DEFAULT 0');
  }

  const assetEditColumns = await all(db, 'PRAGMA table_info(Assets_Edits)');
  if (!assetEditColumns.some(column => column.name === 'name')) {
    await run(db, 'ALTER TABLE Assets_Edits ADD COLUMN name TEXT');
  }
  if (!assetEditColumns.some(column => column.name === 'width')) {
    await run(db, 'ALTER TABLE Assets_Edits ADD COLUMN width INTEGER NOT NULL DEFAULT 0');
  }
  if (!assetEditColumns.some(column => column.name === 'height')) {
    await run(db, 'ALTER TABLE Assets_Edits ADD COLUMN height INTEGER NOT NULL DEFAULT 0');
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

async function ensureProjectExists(projectId) {
  const normalizedProjectId = Number(projectId);

  if (!Number.isInteger(normalizedProjectId) || normalizedProjectId <= 0) {
    throw new Error('A valid projectId is required');
  }

  const db = await getDb();
  const project = await get(db, 'SELECT id FROM Projects WHERE id = ?', [normalizedProjectId]);

  if (!project) {
    throw new Error(`Project not found: ${normalizedProjectId}`);
  }

  return normalizedProjectId;
}

async function getAttributeTypeById(attributeTypeId) {
  const db = await getDb();
  return await get(db, 'SELECT id, name FROM Attributes WHERE id = ?', [attributeTypeId]);
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

async function getNextCardAttributePosition(cardId) {
  const db = await getDb();
  const row = await get(
    db,
    'SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM Cards_Attributes WHERE cardId = ?',
    [cardId]
  );

  return row?.nextPosition ?? 0;
}

async function resolveProjectCard(projectId, externalCardId = null) {
  if (!externalCardId) return null;

  const db = await getDb();
  const externalCardIdString = String(externalCardId);
  const numericCardId = Number(externalCardIdString);

  if (Number.isInteger(numericCardId) && String(numericCardId) === externalCardIdString) {
    return await get(
      db,
      'SELECT id, clientKey, projectId, kanbanColumnId, position FROM Cards WHERE id = ? AND projectId = ?',
      [numericCardId, projectId]
    );
  }

  return await get(
    db,
    'SELECT id, clientKey, projectId, kanbanColumnId, position FROM Cards WHERE clientKey = ? AND projectId = ?',
    [externalCardIdString, projectId]
  );
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
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const existingCard = await resolveProjectCard(normalizedProjectId, externalCardId);

  if (existingCard) {
    return existingCard;
  }

  const kanbanColumnId = await getKanbanColumnIdByName(columnName);

  const position = await getNextCardPosition(normalizedProjectId, kanbanColumnId);
  const clientKey = externalCardId && !/^\d+$/.test(String(externalCardId)) ? String(externalCardId) : null;
  const metadata = JSON.stringify(values.metadata || {});
  const result = await run(
    db,
    `INSERT INTO Cards (projectId, kanbanColumnId, clientKey, name, position, creationDate, status, progress, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedProjectId,
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

async function getCardRow(projectId, externalCardId) {
  const card = await resolveProjectCard(projectId, externalCardId);
  if (!card) {
    return null;
  }

  const db = await getDb();
  return await get(
    db,
    `SELECT c.*, kc.name AS kanbanColumnName
     FROM Cards c
     JOIN KanbanColumns kc ON kc.id = c.kanbanColumnId
     WHERE c.id = ? AND c.projectId = ?`,
    [card.id, projectId]
  );
}

function buildNextCardMetadata(existingMetadata = {}, processing = null) {
  const nextMetadata = isPlainObject(existingMetadata) ? { ...existingMetadata } : {};

  if (processing && isPlainObject(processing)) {
    nextMetadata.processing = processing;
    return nextMetadata;
  }

  delete nextMetadata.processing;
  return nextMetadata;
}

async function normalizeCardPositions(projectId, kanbanColumnId) {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT id
     FROM Cards
     WHERE projectId = ? AND kanbanColumnId = ?
     ORDER BY position ASC, creationDate ASC, id ASC`,
    [projectId, kanbanColumnId]
  );

  for (let index = 0; index < rows.length; index += 1) {
    await run(db, 'UPDATE Cards SET position = ? WHERE id = ?', [-(index + 1), rows[index].id]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    await run(db, 'UPDATE Cards SET position = ? WHERE id = ?', [index, rows[index].id]);
  }
}

async function applyCardOrder(db, orderedCards = []) {
  for (let index = 0; index < orderedCards.length; index += 1) {
    const card = orderedCards[index];
    await run(db, 'UPDATE Cards SET kanbanColumnId = ?, position = ? WHERE id = ?', [card.kanbanColumnId, -(index + 1), card.id]);
  }

  for (let index = 0; index < orderedCards.length; index += 1) {
    const card = orderedCards[index];
    await run(db, 'UPDATE Cards SET kanbanColumnId = ?, position = ? WHERE id = ?', [card.kanbanColumnId, index, card.id]);
  }
}

async function normalizeCardAssetPositions(cardId) {
  const db = await getDb();
  const rows = await all(
    db,
    'SELECT assetId FROM Cards_Assets WHERE cardId = ? ORDER BY position ASC, assetId ASC',
    [cardId]
  );

  for (let index = 0; index < rows.length; index += 1) {
    await run(db, 'UPDATE Cards_Assets SET position = ? WHERE cardId = ? AND assetId = ?', [-(index + 1), cardId, rows[index].assetId]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    await run(db, 'UPDATE Cards_Assets SET position = ? WHERE cardId = ? AND assetId = ?', [index, cardId, rows[index].assetId]);
  }
}

async function normalizeCardAttributePositions(cardId) {
  const db = await getDb();
  const rows = await all(
    db,
    'SELECT position FROM Cards_Attributes WHERE cardId = ? ORDER BY position ASC',
    [cardId]
  );

  for (let index = 0; index < rows.length; index += 1) {
    await run(db, 'UPDATE Cards_Attributes SET position = ? WHERE cardId = ? AND position = ?', [-(index + 1), cardId, rows[index].position]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    await run(db, 'UPDATE Cards_Attributes SET position = ? WHERE cardId = ? AND position = ?', [index, cardId, -(index + 1)]);
  }
}

async function getCardAttributeView(cardId, position) {
  const db = await getDb();
  const row = await get(
    db,
    `SELECT ca.cardId, c.clientKey, ca.position, ca.attributeTypeId, ca.attributeValue, a.name AS attributeTypeName
     FROM Cards_Attributes ca
     JOIN Cards c ON c.id = ca.cardId
     JOIN Attributes a ON a.id = ca.attributeTypeId
     WHERE ca.cardId = ? AND ca.position = ?`,
    [cardId, position]
  );

  return row ? mapCardAttributeRow(row) : null;
}

async function insertAsset({ name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now() }) {
  const db = await getDb();
  const assetTypeId = await getAssetTypeIdByName(type);
  const result = await run(
    db,
    'INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      name,
      toStoredAssetPath(type, filePath),
      assetTypeId,
      createdAt,
      JSON.stringify(metadata),
      thumbnailPath ? toStoredThumbnailPath(thumbnailPath) : null,
      Number(width) || 0,
      Number(height) || 0
    ]
  );

  return result.lastID;
}

async function getAssetViewById(assetId) {
  const db = await getDb();
  const row = await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            a.width, a.height,
            at.name AS assetTypeName,
            c.projectId, c.id AS cardId, c.clientKey, c.kanbanColumnId, kc.name AS kanbanColumnName, c.position AS cardPosition,
            ca.position AS assetPosition
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN Cards_Assets ca ON ca.assetId = a.id
     LEFT JOIN Cards c ON c.id = ca.cardId
      LEFT JOIN KanbanColumns kc ON kc.id = c.kanbanColumnId
     WHERE a.id = ?
     ORDER BY ca.position ASC
     LIMIT 1`,
    [assetId]
  );

  return row ? mapAssetRow(row) : null;
}

export async function getProjectAssetById(projectId, assetId) {
  const asset = await getAssetViewById(assetId);
  if (!asset || Number(asset.projectId) !== Number(projectId)) {
    return null;
  }

  return asset;
}

export async function resolveProjectImageSource(projectId, sourceReference) {
  const parsedReference = typeof sourceReference === 'string'
    ? sourceReference
    : (sourceReference?.source || sourceReference?.filePath || sourceReference?.assetId || '');

  if (typeof parsedReference === 'string' && parsedReference.startsWith('edit:')) {
    const editFilePath = parsedReference.slice(5);
    const db = await getDb();
    const row = await get(
      db,
       `SELECT projectAsset.id AS assetId, c.projectId, projectAsset.name AS assetName, projectAsset.filePath AS assetFilePath,
              ae.editId, ae.name AS editName, ae.filePath AS editFilePath, ae.width AS editWidth, ae.height AS editHeight, ae.creationDate
       FROM Assets_Edits ae
       JOIN Assets sourceAsset ON sourceAsset.id = ae.assetId
       JOIN Assets projectAsset ON projectAsset.filePath = sourceAsset.filePath
         AND projectAsset.assetTypeId = sourceAsset.assetTypeId
       JOIN Cards_Assets ca ON ca.assetId = projectAsset.id
       JOIN Cards c ON c.id = ca.cardId
       JOIN AssetTypes at ON at.id = sourceAsset.assetTypeId
       WHERE c.projectId = ? AND ae.filePath = ? AND at.name = 'Image'
       ORDER BY c.creationDate DESC, projectAsset.creationDate DESC, projectAsset.id DESC
       LIMIT 1`,
      [projectId, editFilePath]
    );

    if (!row) {
      return null;
    }

    const asset = await getProjectAssetById(projectId, row.assetId);
    if (!asset) {
      return null;
    }

    return {
      asset,
      inputFilePath: row.editFilePath,
      inputFilename: toAssetUrlPath(row.editFilePath),
      inputName: row.editName || `Edit ${row.editId}`,
      width: row.editWidth ?? 0,
      height: row.editHeight ?? 0,
      isEdit: true,
      editId: row.editId
    };
  }

  const assetId = typeof parsedReference === 'string' && parsedReference.startsWith('asset:')
    ? Number(parsedReference.slice(6))
    : Number(parsedReference);

  if (!assetId) {
    return null;
  }

  const asset = await getProjectAssetById(projectId, assetId);
  if (!asset || asset.type !== 'image') {
    return null;
  }

  return {
    asset,
    inputFilePath: asset.filePath,
    inputFilename: asset.filename,
    inputName: asset.name,
    isEdit: false,
    editId: null
  };
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

export async function listProjectCards(projectId) {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT c.*, kc.name AS kanbanColumnName
     FROM Cards c
     JOIN KanbanColumns kc ON kc.id = c.kanbanColumnId
     WHERE c.projectId = ?
     ORDER BY c.kanbanColumnId ASC, c.position ASC, c.creationDate ASC, c.id ASC`,
    [projectId]
  );

  return rows.map(mapProjectCardRow);
}

export async function setCardProcessingState(projectId, externalCardId, {
  columnName = 'Images',
  name = null,
  status = 'processing',
  progress = null,
  processing = null,
  creationDate = Date.now()
} = {}) {
  const card = await ensureCard(projectId, columnName, externalCardId, {
    name,
    status,
    progress,
    metadata: buildNextCardMetadata({}, processing),
    creationDate
  });
  const existingRow = await getCardRow(projectId, card.clientKey || card.id);
  if (!existingRow) {
    throw new Error('Card not found');
  }

  const nextMetadata = buildNextCardMetadata(parseJson(existingRow.metadata, {}), processing);
  const db = await getDb();

  await run(
    db,
    `UPDATE Cards
     SET name = ?, status = ?, progress = ?, metadata = ?
     WHERE id = ? AND projectId = ?`,
    [
      name ?? existingRow.name ?? null,
      status,
      progress,
      JSON.stringify(nextMetadata),
      existingRow.id,
      projectId
    ]
  );

  return mapProjectCardRow(await getCardRow(projectId, card.clientKey || card.id));
}

export async function clearCardProcessingState(projectId, externalCardId, {
  name,
  status = null,
  progress = null
} = {}) {
  const existingRow = await getCardRow(projectId, externalCardId);
  if (!existingRow) {
    return null;
  }

  const nextMetadata = buildNextCardMetadata(parseJson(existingRow.metadata, {}), null);
  const db = await getDb();

  await run(
    db,
    `UPDATE Cards
     SET name = ?, status = ?, progress = ?, metadata = ?
     WHERE id = ? AND projectId = ?`,
    [
      name ?? existingRow.name ?? null,
      status,
      progress,
      JSON.stringify(nextMetadata),
      existingRow.id,
      projectId
    ]
  );

  return mapProjectCardRow(await getCardRow(projectId, externalCardId));
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
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail, a.width, a.height,
            at.name AS assetTypeName,
            c.projectId, c.id AS cardId, c.clientKey, c.name AS cardName, c.status AS cardStatus, c.progress AS cardProgress,
            c.metadata AS cardMetadata, c.kanbanColumnId, kc.name AS kanbanColumnName, c.position AS cardPosition,
            ca.position AS assetPosition
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     JOIN Cards_Assets ca ON ca.assetId = a.id
     JOIN Cards c ON c.id = ca.cardId
     JOIN KanbanColumns kc ON kc.id = c.kanbanColumnId
     ${whereClause}
     ORDER BY c.kanbanColumnId ASC, c.position ASC, ca.position ASC, a.creationDate DESC`,
    params
  );

  const assetFilePaths = [...new Set(rows.map(row => row.filePath).filter(Boolean))];

  const canonicalAssetRows = assetFilePaths.length > 0
    ? await all(
      db,
      `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate, at.name AS assetTypeName
       FROM Assets a
       JOIN AssetTypes at ON at.id = a.assetTypeId
       WHERE at.name IN ('Image', 'Mesh')
         AND a.filePath IN (${assetFilePaths.map(() => '?').join(', ')})
       ORDER BY a.creationDate DESC, a.id DESC`,
      assetFilePaths
    )
    : [];

  const canonicalAssetsByKey = canonicalAssetRows.reduce((accumulator, row) => {
    const key = `${row.assetTypeName}:${row.filePath}`;

    if (!accumulator[key]) {
      accumulator[key] = row;
    }

    return accumulator;
  }, {});

  const imageFilePaths = rows
    .filter(row => String(row.assetTypeName || '').toLowerCase() === 'image')
    .map(row => row.filePath)
    .filter(Boolean);

  const uniqueImageFilePaths = [...new Set(imageFilePaths)];

  const editRows = uniqueImageFilePaths.length > 0
    ? await all(
      db,
      `SELECT source.filePath AS sourceFilePath, ae.editId, ae.name, ae.filePath, ae.width, ae.height, ae.creationDate
       FROM Assets_Edits ae
       JOIN Assets source ON source.id = ae.assetId
       JOIN AssetTypes at ON at.id = source.assetTypeId
       WHERE at.name = 'Image'
         AND source.filePath IN (${uniqueImageFilePaths.map(() => '?').join(', ')})
       ORDER BY ae.creationDate ASC`,
      uniqueImageFilePaths
    )
    : [];

  const editsByFilePath = editRows.reduce((accumulator, row) => {
    if (!accumulator[row.sourceFilePath]) {
      accumulator[row.sourceFilePath] = [];
    }

    if (!accumulator[row.sourceFilePath].some(edit => edit.filePath === row.filePath)) {
      accumulator[row.sourceFilePath].push({
        id: `edit:${row.filePath}`,
        editId: row.editId,
        name: row.name || '',
        filePath: row.filePath,
        filename: toAssetUrlPath(row.filePath),
        width: row.width ?? 0,
        height: row.height ?? 0,
        createdAt: row.creationDate,
        isEdit: true
      });
    }

    return accumulator;
  }, {});

  return rows.map(row => {
    const canonicalAsset = canonicalAssetsByKey[`${row.assetTypeName}:${row.filePath}`];
    const assetEdits = editsByFilePath[row.filePath] || [];

    return {
      ...mapAssetRow({
        ...row,
        name: canonicalAsset?.name || row.name,
        thumbnail: row.thumbnail || canonicalAsset?.thumbnail || null
      }),
      edits: assetEdits,
      editCount: assetEdits.length
    };
  });
}

export async function listAttributeTypes() {
  const db = await getDb();
  return await all(db, 'SELECT id, name FROM Attributes ORDER BY id ASC');
}

export async function listProjectCardAttributes(projectId) {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT ca.cardId, c.clientKey, ca.position, ca.attributeTypeId, ca.attributeValue, a.name AS attributeTypeName
     FROM Cards_Attributes ca
     JOIN Cards c ON c.id = ca.cardId
     JOIN Attributes a ON a.id = ca.attributeTypeId
     WHERE c.projectId = ?
     ORDER BY c.id ASC, ca.position ASC`,
    [projectId]
  );

  return rows.map(mapCardAttributeRow);
}

export async function createCardAttribute(projectId, externalCardId, { attributeTypeId, attributeValue = '' }) {
  const card = await resolveProjectCard(projectId, externalCardId);
  if (!card) {
    throw new Error('Card not found');
  }

  const attributeType = await getAttributeTypeById(Number(attributeTypeId));
  if (!attributeType) {
    throw new Error('Attribute type not found');
  }

  const db = await getDb();
  const position = await getNextCardAttributePosition(card.id);
  await run(
    db,
    'INSERT INTO Cards_Attributes (cardId, position, attributeTypeId, attributeValue) VALUES (?, ?, ?, ?)',
    [card.id, position, attributeType.id, attributeValue]
  );

  return await getCardAttributeView(card.id, position);
}

export async function createAssetEditRecord({ assetId, editId, name = '', filePath, width = 0, height = 0, createdAt = Date.now() }) {
  const db = await getDb();
  await run(
    db,
    'INSERT INTO Assets_Edits (assetId, editId, name, filePath, width, height, creationDate) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [assetId, editId, String(name || '').trim(), toStoredAssetPath('image', filePath), Number(width) || 0, Number(height) || 0, createdAt]
  );

  return {
    assetId,
    editId,
    name: String(name || '').trim(),
    filePath: toStoredAssetPath('image', filePath),
    width: Number(width) || 0,
    height: Number(height) || 0,
    creationDate: createdAt
  };
}

export async function updateCardAttribute(projectId, externalCardId, position, { attributeTypeId, attributeValue }) {
  const card = await resolveProjectCard(projectId, externalCardId);
  if (!card) {
    throw new Error('Card not found');
  }

  const db = await getDb();
  const existing = await get(
    db,
    'SELECT cardId, position, attributeTypeId, attributeValue FROM Cards_Attributes WHERE cardId = ? AND position = ?',
    [card.id, position]
  );

  if (!existing) {
    throw new Error('Card attribute not found');
  }

  let nextAttributeTypeId = existing.attributeTypeId;
  if (attributeTypeId !== undefined) {
    const attributeType = await getAttributeTypeById(Number(attributeTypeId));
    if (!attributeType) {
      throw new Error('Attribute type not found');
    }
    nextAttributeTypeId = attributeType.id;
  }

  await run(
    db,
    `UPDATE Cards_Attributes
     SET attributeTypeId = ?, attributeValue = ?
     WHERE cardId = ? AND position = ?`,
    [nextAttributeTypeId, attributeValue ?? existing.attributeValue ?? '', card.id, position]
  );

  return await getCardAttributeView(card.id, position);
}

export async function deleteCardAttribute(projectId, externalCardId, position) {
  const card = await resolveProjectCard(projectId, externalCardId);
  if (!card) {
    throw new Error('Card not found');
  }

  const db = await getDb();
  const existing = await get(
    db,
    'SELECT cardId, position FROM Cards_Attributes WHERE cardId = ? AND position = ?',
    [card.id, position]
  );

  if (!existing) {
    return { status: 'not-found' };
  }

  await run(db, 'DELETE FROM Cards_Attributes WHERE cardId = ? AND position = ?', [card.id, position]);
  await normalizeCardAttributePositions(card.id);

  return { status: 'deleted' };
}

export async function moveCard(projectId, externalCardId, kanbanColumnId, position) {
  const db = await getDb();
  const card = await resolveProjectCard(projectId, externalCardId);

  if (!card) {
    throw new Error('Card not found');
  }

  const targetColumn = await get(db, 'SELECT id, name FROM KanbanColumns WHERE id = ?', [kanbanColumnId]);
  if (!targetColumn) {
    throw new Error('Kanban column not found');
  }

  await exec(db, 'BEGIN TRANSACTION');

  try {
    await normalizeCardPositions(projectId, card.kanbanColumnId);
    if (card.kanbanColumnId !== kanbanColumnId) {
      await normalizeCardPositions(projectId, kanbanColumnId);
    }

    const currentCard = await get(
      db,
      'SELECT id, clientKey, kanbanColumnId, position FROM Cards WHERE id = ? AND projectId = ?',
      [card.id, projectId]
    );

    const destinationCountRow = await get(
      db,
      `SELECT COUNT(*) AS total
       FROM Cards
       WHERE projectId = ? AND kanbanColumnId = ? AND id != ?`,
      [projectId, kanbanColumnId, card.id]
    );
    const maxDestinationPosition = destinationCountRow?.total ?? 0;
    const nextPosition = Math.max(0, Math.min(Number(position) || 0, maxDestinationPosition));

    const sourceCards = await all(
      db,
      `SELECT id
       FROM Cards
       WHERE projectId = ? AND kanbanColumnId = ? AND id != ?
       ORDER BY position ASC, creationDate ASC, id ASC`,
      [projectId, currentCard.kanbanColumnId, card.id]
    );

    if (currentCard.kanbanColumnId === kanbanColumnId) {
      const orderedCards = sourceCards.map(sourceCard => ({
        id: sourceCard.id,
        kanbanColumnId
      }));

      orderedCards.splice(nextPosition, 0, {
        id: currentCard.id,
        kanbanColumnId
      });

      await applyCardOrder(db, orderedCards);
    } else {
      await run(
        db,
        'UPDATE Cards SET position = ? WHERE id = ?',
        [-(1000000 + currentCard.id), currentCard.id]
      );

      const destinationCards = await all(
        db,
        `SELECT id
         FROM Cards
         WHERE projectId = ? AND kanbanColumnId = ? AND id != ?
         ORDER BY position ASC, creationDate ASC, id ASC`,
        [projectId, kanbanColumnId, card.id]
      );

      await applyCardOrder(db, sourceCards.map(sourceCard => ({
        id: sourceCard.id,
        kanbanColumnId: currentCard.kanbanColumnId
      })));

      const orderedDestinationCards = destinationCards.map(destinationCard => ({
        id: destinationCard.id,
        kanbanColumnId
      }));

      orderedDestinationCards.splice(nextPosition, 0, {
        id: currentCard.id,
        kanbanColumnId
      });

      await applyCardOrder(db, orderedDestinationCards);
    }

    await normalizeCardPositions(projectId, currentCard.kanbanColumnId);
    await normalizeCardPositions(projectId, kanbanColumnId);
    await exec(db, 'COMMIT');
  } catch (err) {
    await exec(db, 'ROLLBACK').catch(() => null);
    throw err;
  }

  return await resolveProjectCard(projectId, externalCardId);
}

export async function createProjectAsset({ projectId, type, name, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now() }) {
  const card = await ensureCard(projectId, 'Images', metadata.cardId, {
    creationDate: createdAt
  });
  const assetId = await insertAsset({
    name,
    type,
    filePath,
    thumbnailPath,
    width,
    height,
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

export async function updateAssetThumbnail(assetId, thumbnailPath) {
  const db = await getDb();

  await run(
    db,
    'UPDATE Assets SET thumbnail = ? WHERE id = ?',
    [thumbnailPath ? toStoredThumbnailPath(thumbnailPath) : null, Number(assetId)]
  );

  return await getAssetViewById(Number(assetId));
}

export async function createLibraryAsset({ name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now() }) {
  const assetId = await insertAsset({
    name,
    type,
    filePath,
    thumbnailPath,
    width,
    height,
    metadata,
    createdAt
  });

  return await getAssetViewById(assetId);
}

export async function findLibraryAssetByFilePath(type, filePath) {
  const db = await getDb();
  return await get(
    db,
    `SELECT a.id, a.thumbnail, a.width, a.height
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

export async function renameLibraryAssetByFilePath(type, filePath, name) {
  const db = await getDb();
  const normalizedType = normalizeAssetTypeName(type);
  const storedFilePath = toStoredAssetPath(type, filePath);
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    throw new Error('A name is required');
  }

  const matchingAssets = await all(
    db,
      `SELECT a.id, a.thumbnail, a.width, a.height,
            EXISTS (SELECT 1 FROM Cards_Assets ca WHERE ca.assetId = a.id) AS isLinked
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
        AND a.filePath = ?
     ORDER BY a.creationDate DESC, a.id DESC`,
    [normalizedType, storedFilePath]
  );

  if (matchingAssets.length > 0) {
    await run(
      db,
      `UPDATE Assets
       SET name = ?
       WHERE id IN (${matchingAssets.map(() => '?').join(', ')})`,
      [trimmedName, ...matchingAssets.map(asset => asset.id)]
    );

    const unlinkedAssets = matchingAssets.filter(asset => !asset.isLinked);
    const retainedAsset = unlinkedAssets[0] || matchingAssets[0];

    for (const asset of unlinkedAssets.slice(1)) {
      await run(db, 'DELETE FROM Assets WHERE id = ?', [asset.id]);
    }

    return {
      id: `library:${retainedAsset.id}`,
      name: trimmedName,
      filePath: storedFilePath,
      thumbnailPath: retainedAsset.thumbnail || null,
      width: retainedAsset.width ?? 0,
      height: retainedAsset.height ?? 0,
      created: false
    };
  }

  const existingAsset = await get(
    db,
    `SELECT a.thumbnail, a.width, a.height
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND a.filePath = ?
     ORDER BY a.creationDate DESC
     LIMIT 1`,
    [normalizedType, storedFilePath]
  );

  const createdAsset = await createLibraryAsset({
    name: trimmedName,
    type,
    filePath: storedFilePath,
    thumbnailPath: existingAsset?.thumbnail || null,
    width: existingAsset?.width ?? 0,
    height: existingAsset?.height ?? 0,
    metadata: {
      source: 'LIBRARY RENAME'
    },
    createdAt: Date.now()
  });

  return {
    ...createdAsset,
    created: true
  };
}

export async function renameAssetEditByFilePath(filePath, name) {
  const db = await getDb();
  const storedFilePath = toStoredAssetPath('image', filePath);
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    throw new Error('A name is required');
  }

  const existingEdit = await get(
    db,
    `SELECT assetId, editId, filePath, creationDate
     FROM Assets_Edits
     WHERE filePath = ?
     LIMIT 1`,
    [storedFilePath]
  );

  if (!existingEdit) {
    throw new Error('Edit not found');
  }

  await run(db, 'UPDATE Assets_Edits SET name = ? WHERE filePath = ?', [trimmedName, storedFilePath]);

  return {
    assetId: existingEdit.assetId,
    editId: existingEdit.editId,
    name: trimmedName,
    filePath: existingEdit.filePath,
    creationDate: existingEdit.creationDate
  };
}

export async function deleteAssetEditByFilePath(filePath) {
  const db = await getDb();
  const storedFilePath = toStoredAssetPath('image', filePath);
  const existingEdit = await get(
    db,
    `SELECT assetId, editId, filePath
     FROM Assets_Edits
     WHERE filePath = ?
     LIMIT 1`,
    [storedFilePath]
  );

  if (!existingEdit) {
    return { status: 'not-found' };
  }

  await run(db, 'DELETE FROM Assets_Edits WHERE filePath = ?', [storedFilePath]);

  const absoluteEditFilePath = toAbsoluteStoragePath(existingEdit.filePath);
  await fs.rm(absoluteEditFilePath, { force: true }).catch(() => null);
  await fs.rmdir(path.dirname(absoluteEditFilePath)).catch(() => null);

  return {
    status: 'deleted',
    assetId: existingEdit.assetId,
    editId: existingEdit.editId,
    filePath: existingEdit.filePath
  };
}

export async function deleteLibraryAssetByFilePath(type, filePath) {
  const db = await getDb();
  const storedFilePath = toStoredAssetPath(type, filePath);
  const normalizedType = normalizeAssetTypeName(type);
  const linkedProject = await get(
    db,
    `SELECT c.projectId, p.name AS projectName
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     JOIN Cards_Assets ca ON ca.assetId = a.id
     JOIN Cards c ON c.id = ca.cardId
     LEFT JOIN Projects p ON p.id = c.projectId
     WHERE at.name = ?
       AND a.filePath = ?
     ORDER BY c.creationDate DESC
     LIMIT 1`,
    [normalizedType, storedFilePath]
  );

  if (linkedProject) {
    return {
      status: 'linked',
      projectId: linkedProject.projectId,
      projectName: linkedProject.projectName || null
    };
  }

  const assets = await all(
    db,
    `SELECT a.id, a.thumbnail
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND a.filePath = ?`,
    [normalizedType, storedFilePath]
  );

  if (assets.length === 0) {
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);
    await fs.rm(absoluteFilePath, { force: true }).catch(() => null);
    return { status: 'deleted' };
  }

  const editFileRows = normalizedType === 'Image'
    ? await all(
      db,
      `SELECT DISTINCT editId, filePath
       FROM Assets_Edits
       WHERE assetId IN (${assets.map(() => '?').join(', ')})`,
      assets.map(asset => asset.id)
    )
    : [];

  for (const asset of assets) {
    await run(db, 'DELETE FROM Assets WHERE id = ?', [asset.id]);
  }

  await fs.rm(toAbsoluteStoragePath(storedFilePath), { force: true }).catch(() => null);

  for (const asset of assets) {
    if (asset.thumbnail) {
      await fs.rm(toAbsoluteStoragePath(asset.thumbnail), { force: true }).catch(() => null);
    }
  }

  for (const editFileRow of editFileRows) {
    const absoluteEditFilePath = toAbsoluteStoragePath(editFileRow.filePath);
    await fs.rm(path.dirname(absoluteEditFilePath), { recursive: true, force: true }).catch(() => null);
  }

  return { status: 'deleted' };
}

async function deleteCardsIfEmpty(cardIds = []) {
  const uniqueCardIds = [...new Set(cardIds.filter(cardId => Number.isInteger(cardId)))];

  if (uniqueCardIds.length === 0) {
    return;
  }

  const db = await getDb();
  const placeholders = uniqueCardIds.map(() => '?').join(', ');
  const cardsToDelete = await all(
    db,
    `SELECT id, projectId, kanbanColumnId
     FROM Cards
     WHERE id IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets WHERE Cards_Assets.cardId = Cards.id)`,
    uniqueCardIds
  );

  await run(
    db,
    `DELETE FROM Cards
     WHERE id IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets WHERE Cards_Assets.cardId = Cards.id)`,
    uniqueCardIds
  );

  const affectedColumns = new Map();
  for (const card of cardsToDelete) {
    affectedColumns.set(`${card.projectId}:${card.kanbanColumnId}`, card);
  }

  for (const card of affectedColumns.values()) {
    await normalizeCardPositions(card.projectId, card.kanbanColumnId);
  }
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
    for (const link of links) {
      await normalizeCardAssetPositions(link.cardId);
    }
    await deleteCardsIfEmpty(links.map(link => link.cardId));
    return { status: 'unlinked' };
  }

  await run(db, 'DELETE FROM Assets WHERE id = ?', [assetId]);
  return { status: 'deleted' };
}

export async function getSettings() {
  const db = await getDb();
  const row = await get(db, 'SELECT json FROM Settings WHERE id = 1');
  return normalizeSettingsValue(mergeWithDefaults(DEFAULT_SETTINGS, parseJson(row?.json, DEFAULT_SETTINGS)));
}

export async function saveSettings(settings) {
  const db = await getDb();
  const normalizedSettings = normalizeSettingsValue(settings);
  await run(db, 'INSERT INTO Settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', [JSON.stringify(normalizedSettings)]);
  return normalizedSettings;
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
  const fileEntries = entries.filter(entry => entry.isFile());
  const rows = await all(
    db,
     `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets ca WHERE ca.assetId = a.id)
     ORDER BY a.creationDate DESC`,
    [normalizeAssetTypeName(type)]
  );

  const candidateStoredPaths = [
    ...new Set([
      ...rows.map(row => row.filePath),
      ...fileEntries.map(entry => toStoredAssetPath(type, `${subdirectory}/${entry.name}`))
    ])
  ];

  const canonicalAssetRows = candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate
       FROM Assets a
       JOIN AssetTypes at ON at.id = a.assetTypeId
       WHERE at.name = ?
         AND a.filePath IN (${candidateStoredPaths.map(() => '?').join(', ')})
       ORDER BY a.creationDate DESC, a.id DESC`,
      [normalizeAssetTypeName(type), ...candidateStoredPaths]
    )
    : [];

  const canonicalAssetsByFilePath = canonicalAssetRows.reduce((accumulator, row) => {
    if (!accumulator[row.filePath]) {
      accumulator[row.filePath] = row;
    }

    return accumulator;
  }, {});

  const editRows = type === 'image' && candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT source.filePath AS sourceFilePath, ae.editId, ae.name, ae.filePath, ae.width, ae.height, ae.creationDate
       FROM Assets_Edits ae
       JOIN Assets source ON source.id = ae.assetId
       JOIN AssetTypes at ON at.id = source.assetTypeId
       WHERE at.name = ?
         AND source.filePath IN (${candidateStoredPaths.map(() => '?').join(', ')})
       ORDER BY ae.creationDate ASC`,
      [normalizeAssetTypeName(type), ...candidateStoredPaths]
    )
    : [];

  const editsBySourceFilePath = editRows.reduce((accumulator, row) => {
    if (!accumulator[row.sourceFilePath]) {
      accumulator[row.sourceFilePath] = [];
    }

    const filename = toAssetUrlPath(row.filePath);
    if (!accumulator[row.sourceFilePath].some(edit => edit.filePath === row.filePath)) {
      accumulator[row.sourceFilePath].push({
        editId: row.editId,
        name: row.name || '',
        filePath: row.filePath,
        filename,
        width: row.width ?? 0,
        height: row.height ?? 0,
        createdAt: row.creationDate,
        url: `http://localhost:${port}/assets/${encodeURI(filename)}`
      });
    }

    return accumulator;
  }, {});

  const dbAssets = rows.reduce((accumulator, row) => {
    const filename = toAssetUrlPath(row.filePath);
    const existingAsset = accumulator.find(asset => asset.filename === filename);
    const assetEdits = editsBySourceFilePath[row.filePath] || [];

    if (existingAsset) {
      const mergedEdits = [...existingAsset.edits, ...assetEdits].reduce((mergedAccumulator, edit) => {
        if (!mergedAccumulator.some(existingEdit => existingEdit.filePath === edit.filePath)) {
          mergedAccumulator.push(edit);
        }

        return mergedAccumulator;
      }, []);

      existingAsset.edits = mergedEdits.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
      existingAsset.editCount = existingAsset.edits.length;
      return accumulator;
    }

    const canonicalAsset = canonicalAssetsByFilePath[row.filePath];
    const thumbnailPath = row.thumbnail || canonicalAsset?.thumbnail || null;
    const thumbnailFilename = thumbnailPath ? toAssetUrlPath(thumbnailPath) : null;

    accumulator.push({
      id: `library:${row.id}`,
      name: canonicalAsset?.name || row.name,
      filename,
      filePath: row.filePath,
      type,
      extension: path.extname(filename).replace('.', '').toUpperCase() || type.toUpperCase(),
      url: `http://localhost:${port}/assets/${encodeURI(filename)}`,
      width: canonicalAsset?.width ?? row.width ?? 0,
      height: canonicalAsset?.height ?? row.height ?? 0,
      thumbnailPath,
      thumbnailUrl: thumbnailFilename ? `http://localhost:${port}/assets/${encodeURI(thumbnailFilename)}` : null,
      edits: assetEdits,
      editCount: assetEdits.length
    });

    return accumulator;
  }, []);

  const knownFilenames = new Set(dbAssets.map(asset => asset.filename));

  const fileAssets = fileEntries
    .filter(entry => !knownFilenames.has(`${subdirectory}/${entry.name}`))
    .sort((left, right) => right.name.localeCompare(left.name))
    .map(entry => {
      const filename = `${subdirectory}/${entry.name}`;
      const storedFilePath = toStoredAssetPath(type, filename);
      const assetEdits = editsBySourceFilePath[storedFilePath] || [];
      const canonicalAsset = canonicalAssetsByFilePath[storedFilePath];
      const thumbnailFilename = canonicalAsset?.thumbnail ? toAssetUrlPath(canonicalAsset.thumbnail) : null;

      return {
        id: `file:${type}:${entry.name}`,
        name: canonicalAsset?.name || entry.name,
        filename,
        filePath: storedFilePath,
        type,
        extension: path.extname(entry.name).replace('.', '').toUpperCase() || type.toUpperCase(),
        url: `http://localhost:${port}/assets/${encodeURI(filename)}`,
        width: canonicalAsset?.width ?? 0,
        height: canonicalAsset?.height ?? 0,
        thumbnailPath: canonicalAsset?.thumbnail || null,
        thumbnailUrl: thumbnailFilename ? `http://localhost:${port}/assets/${encodeURI(thumbnailFilename)}` : null,
        edits: assetEdits,
        editCount: assetEdits.length
      };
    });

  return [...dbAssets, ...fileAssets];
}
