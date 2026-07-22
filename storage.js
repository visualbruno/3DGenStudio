import path from 'path';
import process from 'process';
import fs from 'fs/promises';
import sqlite3 from 'sqlite3';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const DB_FILE = path.join(DATA_DIR, 'app.db');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
export const IMAGE_ASSETS_DIR = path.join(ASSETS_DIR, 'images');
export const MESH_ASSETS_DIR = path.join(ASSETS_DIR, 'meshes');
export const THUMBNAIL_ASSETS_DIR = path.join(ASSETS_DIR, 'thumbnails');
export const WORKFLOW_ASSETS_DIR = path.join(ASSETS_DIR, 'workflows');
export const BRUSH_ASSETS_DIR = path.join(ASSETS_DIR, 'brushes');
export const PAINT_DOCS_DIR = path.join(ASSETS_DIR, 'paintdocs');
export const WIKI_ASSETS_DIR = path.join(ASSETS_DIR, 'wiki');

const sqlite = sqlite3.verbose();
const DATA_ASSETS_PREFIX = 'data/assets/';
const KANBAN_COLUMNS = [
  { id: 1, name: 'Images', position: 0 },
  { id: 2, name: 'Image Edit', position: 1 },
  { id: 3, name: 'Mesh Gen', position: 2 },
  { id: 4, name: 'Mesh Edit', position: 3 },
  { id: 5, name: 'Texturing', position: 4 },
  { id: 6, name: 'Rigging', position: 5 }
];
const ASSET_TYPES = [
  { id: 1, name: 'Image' },
  { id: 2, name: 'Mesh' },
  { id: 3, name: 'Workflow' },
  { id: 4, name: 'Brush' }
];
const ATTRIBUTE_TYPES = [
  { id: 1, name: 'Text' },
  { id: 2, name: 'Number' }
];
const NODE_TYPES = [
  { id: 1, name: 'Image' },
  { id: 3, name: 'Mesh' },
  { id: 4, name: 'Number' },
  { id: 5, name: 'Text' },
  { id: 6, name: 'Boolean' },
  { id: 7, name: 'Image Compare' }
];

export const DEFAULT_SETTINGS = {
  profile: {
    name: 'User',
    avatar: null
  },
  initialSetupComplete: false,
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
            },
            openai_gpt_image_2: {
              name: 'gpt-image-2',
              model: 'gpt-image-2'
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
            },
            openai_gpt_image_2: {
              name: 'gpt-image-2',
              model: 'gpt-image-2'
            }
          },
          responseMapping: {
            imageBase64Field: 'data[0].b64_json',
            createdField: 'created',
            usageField: 'usage'
          }
        }
      },
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
    meshtools: {
      url: 'http://127.0.0.1',
      port: '8200',
      // Desktop app: start this service automatically at launch (default off —
      // services otherwise start on demand or from Settings).
      autoStart: true
    },
    rigtools: {
      url: 'http://127.0.0.1',
      port: '8300',
      // Desktop app: start the rigging service at launch. Default off — it pins
      // ~14GB of GPU memory for the whole session.
      autoStart: false
    },
    custom: []
  },
  // MCP automation endpoint (POST /mcp on the backend). With no token set,
  // only loopback clients may connect; a token allows remote MCP clients.
  mcp: {
    enabled: true,
    token: ''
  }
};

const DEFAULT_CUSTOM_API_TYPE = 'image-generation';

function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit'].includes(type)
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

function mapGraphNodeRow(row) {
  const metadata = parseJson(row.metadata, {});
  const filename = row.assetFilePath ? toAssetUrlPath(row.assetFilePath) : null;
  const thumbnail = row.assetThumbnail ? toAssetUrlPath(row.assetThumbnail) : null;
  const assetMetadata = parseJson(row.assetMetadata, {});

  return {
    id: row.id,
    projectId: row.projectId,
    nodeTypeId: row.nodeTypeId,
    nodeTypeName: row.nodeTypeName || '',
    name: row.name || '',
    xPos: row.xPos ?? 0,
    yPos: row.yPos ?? 0,
    status: row.status || null,
    progress: row.progress ?? null,
    metadata,
    assetId: row.assetId ?? null,
    asset: row.assetId ? {
      id: row.assetId,
      name: row.assetName || '',
      filePath: row.assetFilePath,
      filename,
      width: row.assetWidth ?? 0,
      height: row.assetHeight ?? 0,
      thumbnailPath: row.assetThumbnail || null,
      thumbnail,
      type: String(row.assetTypeName || '').toLowerCase(),
      parentId: row.assetParentId ?? null,
      metadata: assetMetadata,
      createdAt: row.assetCreationDate ?? null
    } : null,
    createdAt: row.creationDate
  };
}

function mapGraphConnectionRow(row) {
  return {
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    inputId: row.inputId || 'image-input',
    outputId: row.outputId || 'image-output'
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

function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close(err => (err ? reject(err) : resolve()));
  });
}

async function tableExists(db, tableName) {
  const row = await get(
    db,
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table' AND name = ?`,
    [tableName]
  );

  return Boolean(row);
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
    status: row.status || 'active',
    graphViewport: parseJson(row.graphViewport, null)
  };
}

function mapChildAssetRow(row) {
  const metadata = parseJson(row.metadata, {});
  const thumbnail = row.thumbnail ? toAssetUrlPath(row.thumbnail) : null;

  return {
    id: row.id,
    parentId: row.parentId ?? null,
    parentProjectId: row.parentProjectId ?? null,
    editId: metadata?.editId || null,
    name: row.name || '',
    filePath: row.filePath,
    filename: toAssetUrlPath(row.filePath),
    width: row.width ?? 0,
    height: row.height ?? 0,
    thumbnailPath: row.thumbnail || null,
    thumbnail,
    metadata,
    createdAt: row.creationDate,
    isEdit: true
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

  // Only surface a Kanban card id here. A graph asset is linked to a node-card
  // (kanbanColumnId IS NULL); exposing that id as metadata.cardId would make the
  // processing-snapshot machinery target the node-card, which has no column and
  // must not be renamed/repurposed. Graph assets keep their own stored cardId.
  if (row.cardId && row.kanbanColumnId != null) {
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

async function migrateLegacyAssetEditsToAssets(db) {
  if (!(await tableExists(db, 'Assets_Edits'))) {
    return;
  }

  const legacyEditRows = await all(
    db,
    `SELECT ae.assetId AS sourceAssetId,
            ae.editId,
            ae.name,
            ae.filePath,
            ae.width,
            ae.height,
            ae.creationDate,
            source.assetTypeId
     FROM Assets_Edits ae
     JOIN Assets source ON source.id = ae.assetId`
  );

  for (const legacyEditRow of legacyEditRows) {
    const existingChildAsset = await get(
      db,
      `SELECT id
       FROM Assets
       WHERE filePath = ? AND parentId IS NOT NULL
       LIMIT 1`,
      [legacyEditRow.filePath]
    );

    if (existingChildAsset) {
      continue;
    }

    await run(
      db,
      `INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail, width, height, parentId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(legacyEditRow.name || '').trim() || `Edit ${legacyEditRow.editId}`,
        legacyEditRow.filePath,
        legacyEditRow.assetTypeId,
        legacyEditRow.creationDate,
        JSON.stringify({
          editId: legacyEditRow.editId,
          migratedFrom: 'Assets_Edits'
        }),
        null,
        Number(legacyEditRow.width) || 0,
        Number(legacyEditRow.height) || 0,
        legacyEditRow.sourceAssetId
      ]
    );
  }
}

function groupChildAssetsByParentFilePath(rows = [], baseUrl = null) {
  return rows.reduce((accumulator, row) => {
    if (!accumulator[row.parentFilePath]) {
      accumulator[row.parentFilePath] = [];
    }

    const childAsset = mapChildAssetRow(row);
    const childWithUrl = baseUrl
      ? {
        ...childAsset,
        url: `${baseUrl}/assets/${encodeURI(childAsset.filename)}`,
        thumbnailUrl: childAsset.thumbnail ? `${baseUrl}/assets/${encodeURI(childAsset.thumbnail)}` : null
      }
      : childAsset;

    if (!accumulator[row.parentFilePath].some(existingChild => existingChild.filePath === childWithUrl.filePath)) {
      accumulator[row.parentFilePath].push(childWithUrl);
    }

    return accumulator;
  }, {});
}

async function listChildAssetsByParentFilePaths(db, parentFilePaths = [], assetTypeName = 'Image') {
  if (parentFilePaths.length === 0) {
    return [];
  }

  return await all(
    db,
    `SELECT child.id, child.parentId, child.name, child.filePath, child.creationDate, child.metadata, child.thumbnail,
            child.width, child.height,
            parent.filePath AS parentFilePath,
            (
              SELECT c.projectId
              FROM Cards_Assets ca
              JOIN Cards c ON c.id = ca.cardId
              WHERE ca.assetId = parent.id
              ORDER BY c.creationDate DESC, c.id DESC
              LIMIT 1
            ) AS parentProjectId
     FROM Assets child
     JOIN Assets parent ON parent.id = child.parentId
     JOIN AssetTypes childType ON childType.id = child.assetTypeId
     JOIN AssetTypes parentType ON parentType.id = parent.assetTypeId
     WHERE child.parentId IS NOT NULL
       AND childType.name = ?
       AND parentType.name = ?
       AND parent.filePath IN (${parentFilePaths.map(() => '?').join(', ')})
     ORDER BY child.creationDate ASC, child.id ASC`,
    [assetTypeName, assetTypeName, ...parentFilePaths]
  );
}

async function getRootAssetById(assetId) {
  const db = await getDb();
  let asset = await get(
    db,
    `SELECT id, parentId, assetTypeId, filePath, name
     FROM Assets
     WHERE id = ?`,
    [Number(assetId)]
  );

  if (!asset) {
    return null;
  }

  if (!asset.parentId) {
    return asset;
  }

  while (asset?.parentId) {
    asset = await get(
      db,
      `SELECT id, parentId, assetTypeId, filePath, name
       FROM Assets
       WHERE id = ?`,
      [asset.parentId]
    );

    if (!asset) {
      return null;
    }
  }

  return asset;
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
      `INSERT INTO Columns (id, name, position)
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

  for (const nodeType of NODE_TYPES) {
    await run(
      db,
      `INSERT INTO NodeTypes (id, name)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      [nodeType.id, nodeType.name]
    );
  }

  await run(
    db,
    'INSERT OR IGNORE INTO Settings (id, json) VALUES (1, ?)',
    [JSON.stringify(DEFAULT_SETTINGS)]
  );
}

async function migrateGraphNodeTypes(db) {
  if (!(await tableExists(db, 'NodeTypes')) || !(await tableExists(db, 'Nodes'))) {
    return;
  }

  const imageEditNodeType = await get(db, 'SELECT id FROM NodeTypes WHERE lower(name) = lower(?)', ['Image Edit']);
  if (imageEditNodeType?.id) {
    await run(db, 'UPDATE Nodes SET nodeTypeId = ? WHERE nodeTypeId = ?', [1, imageEditNodeType.id]);
    await run(db, 'DELETE FROM NodeTypes WHERE id = ?', [imageEditNodeType.id]);
  }

  const meshGenNodeType = await get(db, 'SELECT id FROM NodeTypes WHERE lower(name) = lower(?)', ['Mesh Gen']);
  if (meshGenNodeType?.id) {
    await run(db, 'UPDATE NodeTypes SET name = ? WHERE id = ?', ['Mesh', meshGenNodeType.id]);
  }
}

// Copy data/app.db to a timestamped .bak before the one-time Nodes→Cards
// migration runs, so the pre-unification state is always recoverable. No-op for
// a fresh install or an already-migrated DB (no legacy `Nodes` table).
async function backupLegacyDbIfNeeded() {
  try {
    await fs.access(DB_FILE);
  } catch {
    return; // fresh install, nothing to back up
  }

  const probe = await openDatabase(DB_FILE);
  let isLegacy = false;
  try {
    isLegacy = await tableExists(probe, 'Nodes');
  } finally {
    await closeDatabase(probe).catch(() => {});
  }
  if (!isLegacy) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_FILE}.bak-${stamp}`;
  await fs.copyFile(DB_FILE, backupPath);
  console.log(`📦 Backed up pre-migration database to ${backupPath}`);
}

// One-time migration: fold the legacy Graph tables (Nodes, Connections,
// KanbanColumns) into the unified Cards model. Runs inside a transaction and is
// a no-op once the legacy `Nodes` table is gone. Every graph node becomes a
// Card (nodeTypeId + coordinates), its asset moves to Cards_Assets, connections
// are rebuilt against card ids, and the now-redundant backing "Images" cards
// are pruned.
async function migrateNodesIntoCards(db) {
  if (!(await tableExists(db, 'Nodes'))) {
    return; // already migrated (or fresh DB)
  }

  await exec(db, 'PRAGMA foreign_keys = OFF');
  // Prevent SQLite (>=3.25) from auto-rewriting FK references in other tables
  // when we RENAME during the rebuild (e.g. Cards_Assets → Cards_old).
  await exec(db, 'PRAGMA legacy_alter_table = ON');
  await exec(db, 'BEGIN');
  try {
    // 1. Rename KanbanColumns -> Columns (rows/ids preserved).
    if (await tableExists(db, 'KanbanColumns') && !(await tableExists(db, 'Columns'))) {
      await run(db, 'ALTER TABLE KanbanColumns RENAME TO Columns');
    }

    // 2. Rebuild Cards with the unified schema (nullable kanbanColumnId/position,
    //    new nodeTypeId/xPos/yPos), preserving ids so Cards_Assets/Cards_Attributes
    //    keep pointing at the right rows.
    await run(db, 'ALTER TABLE Cards RENAME TO Cards_old');
    await exec(
      db,
      `CREATE TABLE Cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER NOT NULL,
        kanbanColumnId INTEGER,
        nodeTypeId INTEGER,
        clientKey TEXT,
        name TEXT,
        position INTEGER,
        xPos REAL NOT NULL DEFAULT 0,
        yPos REAL NOT NULL DEFAULT 0,
        creationDate INTEGER NOT NULL,
        status TEXT,
        progress INTEGER,
        metadata TEXT,
        FOREIGN KEY(projectId) REFERENCES Projects(id) ON DELETE CASCADE,
        FOREIGN KEY(kanbanColumnId) REFERENCES Columns(id),
        FOREIGN KEY(nodeTypeId) REFERENCES NodeTypes(id),
        UNIQUE(projectId, kanbanColumnId, position),
        UNIQUE(projectId, clientKey)
      )`
    );
    await run(
      db,
      `INSERT INTO Cards (id, projectId, kanbanColumnId, nodeTypeId, clientKey, name, position, xPos, yPos, creationDate, status, progress, metadata)
       SELECT id, projectId, kanbanColumnId, NULL, clientKey, name, position, 0, 0, creationDate, status, progress, metadata
       FROM Cards_old`
    );
    await run(db, 'DROP TABLE Cards_old');

    // 3. Nodes -> Cards (node-cards). Map old node id -> new card id, and move
    //    each node's asset into Cards_Assets.
    const nodes = await all(db, 'SELECT * FROM Nodes ORDER BY id ASC');
    const nodeToCard = new Map();
    for (const node of nodes) {
      const result = await run(
        db,
        `INSERT INTO Cards (projectId, kanbanColumnId, nodeTypeId, clientKey, name, position, xPos, yPos, creationDate, status, progress, metadata)
         VALUES (?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [node.projectId, node.nodeTypeId, node.name, node.xPos, node.yPos, node.creationDate, node.status, node.progress, node.metadata]
      );
      const newCardId = result.lastID;
      nodeToCard.set(node.id, newCardId);
      if (node.assetId != null) {
        await run(db, 'INSERT OR IGNORE INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, 0)', [newCardId, node.assetId]);
      }
    }

    // 4. Reconcile backing cards: for graph projects, the pre-existing cards were
    //    only there to associate node assets with the project. Drop each backing
    //    Cards_Assets link whose asset is now owned by a node-card, then remove
    //    any backing card left empty. Backing cards whose asset is NOT covered by
    //    a node-card are kept (an off-canvas asset with no node).
    const graphProjects = await all(db, "SELECT id FROM Projects WHERE lower(preset) = 'graph'");
    for (const project of graphProjects) {
      // asset ids now owned by node-cards in this project
      const nodeCardAssets = await all(
        db,
        `SELECT DISTINCT ca.assetId AS assetId
         FROM Cards_Assets ca JOIN Cards c ON c.id = ca.cardId
         WHERE c.projectId = ? AND c.nodeTypeId IS NOT NULL`,
        [project.id]
      );
      const ownedAssetIds = new Set(nodeCardAssets.map(r => r.assetId));

      // backing cards = this project's cards that are NOT node-cards
      const backingCards = await all(
        db,
        'SELECT id FROM Cards WHERE projectId = ? AND nodeTypeId IS NULL',
        [project.id]
      );
      for (const card of backingCards) {
        const links = await all(db, 'SELECT assetId FROM Cards_Assets WHERE cardId = ?', [card.id]);
        for (const link of links) {
          if (ownedAssetIds.has(link.assetId)) {
            await run(db, 'DELETE FROM Cards_Assets WHERE cardId = ? AND assetId = ?', [card.id, link.assetId]);
          }
        }
        const remaining = await get(db, 'SELECT COUNT(*) AS n FROM Cards_Assets WHERE cardId = ?', [card.id]);
        if (!remaining || remaining.n === 0) {
          await run(db, 'DELETE FROM Cards WHERE id = ?', [card.id]);
        }
      }
    }

    // 5. Rebuild Connections against card ids.
    const oldConnections = await all(db, 'SELECT * FROM Connections');
    await run(db, 'ALTER TABLE Connections RENAME TO Connections_old');
    await exec(
      db,
      `CREATE TABLE Connections (
        sourceCardId INTEGER NOT NULL,
        targetCardId INTEGER NOT NULL,
        inputId TEXT NOT NULL,
        outputId TEXT NOT NULL,
        PRIMARY KEY(sourceCardId, targetCardId, inputId, outputId),
        FOREIGN KEY(sourceCardId) REFERENCES Cards(id) ON DELETE CASCADE,
        FOREIGN KEY(targetCardId) REFERENCES Cards(id) ON DELETE CASCADE
      )`
    );
    for (const conn of oldConnections) {
      const sourceCardId = nodeToCard.get(conn.sourceNodeId);
      const targetCardId = nodeToCard.get(conn.targetNodeId);
      if (sourceCardId == null || targetCardId == null) continue;
      await run(
        db,
        'INSERT OR IGNORE INTO Connections (sourceCardId, targetCardId, inputId, outputId) VALUES (?, ?, ?, ?)',
        [sourceCardId, targetCardId, conn.inputId, conn.outputId]
      );
    }
    await run(db, 'DROP TABLE Connections_old');

    // 6. Drop the legacy Nodes table. NodeTypes stays (Cards.nodeTypeId → it).
    await run(db, 'DROP TABLE Nodes');

    await exec(db, 'COMMIT');
    console.log(`✅ Migrated ${nodes.length} graph node(s) into the unified Cards schema`);
  } catch (err) {
    await exec(db, 'ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await exec(db, 'PRAGMA legacy_alter_table = OFF').catch(() => {});
    await exec(db, 'PRAGMA foreign_keys = ON').catch(() => {});
  }
}

export async function initializeStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.mkdir(IMAGE_ASSETS_DIR, { recursive: true });
  await fs.mkdir(MESH_ASSETS_DIR, { recursive: true });
  await fs.mkdir(THUMBNAIL_ASSETS_DIR, { recursive: true });
  await fs.mkdir(WORKFLOW_ASSETS_DIR, { recursive: true });
  await fs.mkdir(BRUSH_ASSETS_DIR, { recursive: true });
  await fs.mkdir(PAINT_DOCS_DIR, { recursive: true });
  await fs.mkdir(WIKI_ASSETS_DIR, { recursive: true });

  // Back up the DB before the one-time Nodes→Cards migration touches it.
  await backupLegacyDbIfNeeded();

  const db = await openDatabase(DB_FILE);
  await exec(db, 'PRAGMA foreign_keys = ON');

  // Migrate the legacy split schema (Nodes/Connections/KanbanColumns) into the
  // unified Cards model BEFORE the CREATE TABLE IF NOT EXISTS block, so the
  // new-schema statements don't create empty tables alongside the legacy ones
  // (e.g. a fresh Columns table beside the still-named KanbanColumns).
  await migrateNodesIntoCards(db);

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

    CREATE TABLE IF NOT EXISTS Columns (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL UNIQUE
    );

    -- Cards is the unified representation for both Kanban cards and Graph nodes.
    -- A card is a Graph node iff nodeTypeId IS NOT NULL (then it carries xPos/yPos
    -- and Connections reference it). A Kanban card has kanbanColumnId + position
    -- and leaves nodeTypeId NULL. kanbanColumnId/position are nullable so graph
    -- node-cards need neither; SQLite treats NULLs as distinct in UNIQUE, so
    -- graph node-cards never collide on (projectId, kanbanColumnId, position).
    CREATE TABLE IF NOT EXISTS Cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      kanbanColumnId INTEGER,
      nodeTypeId INTEGER,
      clientKey TEXT,
      name TEXT,
      position INTEGER,
      xPos REAL NOT NULL DEFAULT 0,
      yPos REAL NOT NULL DEFAULT 0,
      creationDate INTEGER NOT NULL,
      status TEXT,
      progress INTEGER,
      metadata TEXT,
      FOREIGN KEY(projectId) REFERENCES Projects(id) ON DELETE CASCADE,
      FOREIGN KEY(kanbanColumnId) REFERENCES Columns(id),
      FOREIGN KEY(nodeTypeId) REFERENCES NodeTypes(id),
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
      parentId INTEGER,
      FOREIGN KEY(parentId) REFERENCES Assets(id) ON DELETE CASCADE,
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

    CREATE TABLE IF NOT EXISTS NodeTypes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    -- Graph edges. Both endpoints are Cards (node-cards). inputId/outputId are
    -- the React Flow handle ids on the target/source card respectively.
    CREATE TABLE IF NOT EXISTS Connections (
      sourceCardId INTEGER NOT NULL,
      targetCardId INTEGER NOT NULL,
      inputId TEXT NOT NULL,
      outputId TEXT NOT NULL,
      PRIMARY KEY(sourceCardId, targetCardId, inputId, outputId),
      FOREIGN KEY(sourceCardId) REFERENCES Cards(id) ON DELETE CASCADE,
      FOREIGN KEY(targetCardId) REFERENCES Cards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS PaintDocuments (
      assetId INTEGER PRIMARY KEY,
      baseFilePath TEXT,
      textureWidth INTEGER NOT NULL DEFAULT 0,
      textureHeight INTEGER NOT NULL DEFAULT 0,
      layersJson TEXT NOT NULL DEFAULT '[]',
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS WikiPages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parentId INTEGER,
      title TEXT NOT NULL,
      icon TEXT,
      content TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY(parentId) REFERENCES WikiPages(id) ON DELETE CASCADE
    );

    -- Brainstorming Boards: a Figma-like canvas. Many boards per project.
    -- stateJson holds the Excalidraw document (elements + trimmed appState +
    -- imageRefs); image binaries live as normal project Assets on disk.
    CREATE TABLE IF NOT EXISTS Boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      stateJson TEXT,
      thumbnailPath TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY(projectId) REFERENCES Projects(id) ON DELETE CASCADE
    );
    `
  );

  await run(db, 'CREATE INDEX IF NOT EXISTS idx_wikipages_parentId ON WikiPages(parentId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_boards_projectId ON Boards(projectId)');

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

  if (!assetColumns.some(column => column.name === 'parentId')) {
    await run(db, 'ALTER TABLE Assets ADD COLUMN parentId INTEGER');
  }

  const projectColumns = await all(db, 'PRAGMA table_info(Projects)');
  if (!projectColumns.some(column => column.name === 'graphViewport')) {
    await run(db, 'ALTER TABLE Projects ADD COLUMN graphViewport TEXT');
  }

  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_parentId ON Assets(parentId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cards_projectId ON Cards(projectId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_connections_sourceCardId ON Connections(sourceCardId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_connections_targetCardId ON Connections(targetCardId)');

  await migrateLegacyAssetEditsToAssets(db);

  if (await tableExists(db, 'Assets_Edits')) {
    await run(db, 'DROP TABLE Assets_Edits');
  }

  await seedReferenceTables(db);
  await migrateGraphNodeTypes(db);
  return db;
}

export function getAssetDirectory(type = 'image') {
  if (type === 'mesh') return MESH_ASSETS_DIR;
  if (type === 'workflow') return WORKFLOW_ASSETS_DIR;
  if (type === 'brush') return BRUSH_ASSETS_DIR;
  return IMAGE_ASSETS_DIR;
}

export function getAssetSubdirectory(type = 'image') {
  if (type === 'mesh') return 'meshes';
  if (type === 'workflow') return 'workflows';
  if (type === 'brush') return 'brushes';
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
  const row = await get(db, 'SELECT id FROM Columns WHERE name = ?', [name]);
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

async function getNodeTypeById(nodeTypeId) {
  const db = await getDb();
  return await get(db, 'SELECT id, name FROM NodeTypes WHERE id = ?', [Number(nodeTypeId)]);
}

async function getNodeTypeIdByName(name) {
  const db = await getDb();
  const row = await get(db, 'SELECT id FROM NodeTypes WHERE lower(name) = lower(?)', [String(name || '').trim()]);
  if (!row) {
    throw new Error(`Unknown node type: ${name}`);
  }

  return row.id;
}

async function ensureProjectNode(projectId, nodeId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const normalizedNodeId = Number(nodeId);

  if (!Number.isInteger(normalizedNodeId) || normalizedNodeId <= 0) {
    throw new Error('A valid nodeId is required');
  }

  const db = await getDb();
  // A graph node is a Card with a nodeTypeId. Its (single) asset lives in
  // Cards_Assets rather than a column on the row.
  const node = await get(
    db,
    `SELECT c.id, c.projectId, c.nodeTypeId,
            (SELECT ca.assetId FROM Cards_Assets ca WHERE ca.cardId = c.id ORDER BY ca.position ASC LIMIT 1) AS assetId
     FROM Cards c
     WHERE c.id = ? AND c.projectId = ? AND c.nodeTypeId IS NOT NULL`,
    [normalizedNodeId, normalizedProjectId]
  );

  if (!node) {
    throw new Error(`Node not found: ${normalizedNodeId}`);
  }

  return node;
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

async function _resolveCard(projectId, kanbanColumnId, externalCardId = null) {
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
     JOIN Columns kc ON kc.id = c.kanbanColumnId
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

async function insertAsset({ name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), parentId = null }) {
  const db = await getDb();
  const assetTypeId = await getAssetTypeIdByName(type);
  const result = await run(
    db,
    'INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail, width, height, parentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      name,
      toStoredAssetPath(type, filePath),
      assetTypeId,
      createdAt,
      JSON.stringify(metadata),
      thumbnailPath ? toStoredThumbnailPath(thumbnailPath) : null,
      Number(width) || 0,
      Number(height) || 0,
      parentId ? Number(parentId) : null
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
      LEFT JOIN Columns kc ON kc.id = c.kanbanColumnId
     WHERE a.id = ?
     ORDER BY ca.position ASC
     LIMIT 1`,
    [assetId]
  );

  return row ? mapAssetRow(row) : null;
}

export async function getAssetRecordById(assetId) {
  const db = await getDb();
  return await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            a.width, a.height, a.parentId,
            at.name AS assetTypeName
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE a.id = ?
     LIMIT 1`,
    [Number(assetId)]
  );
}

export async function findAssetByFilePath(type, filePath) {
  const db = await getDb();
  return await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            a.width, a.height, a.parentId,
            at.name AS assetTypeName
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND a.filePath = ?
     ORDER BY a.creationDate DESC, a.id DESC
     LIMIT 1`,
    [normalizeAssetTypeName(type), toStoredAssetPath(type, filePath)]
  );
}

export async function createAssetVersion({ assetId, name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), inheritThumbnail = true }) {
  const sourceAsset = await getAssetRecordById(assetId);

  if (!sourceAsset) {
    throw new Error('Source asset not found');
  }

  const rootAsset = await getRootAssetById(sourceAsset.id);

  if (!rootAsset) {
    throw new Error('Source asset not found');
  }

  const nextAssetId = await insertAsset({
    name: String(name || '').trim() || sourceAsset.name,
    type: type || String(sourceAsset.assetTypeName || '').toLowerCase(),
    filePath,
    thumbnailPath: thumbnailPath ?? (inheritThumbnail ? sourceAsset.thumbnail : null) ?? null,
    width: Number(width) || sourceAsset.width || 0,
    height: Number(height) || sourceAsset.height || 0,
    metadata: {
      ...parseJson(sourceAsset.metadata, {}),
      ...metadata
    },
    createdAt,
    parentId: rootAsset.id
  });

  return await getAssetViewById(nextAssetId);
}

export async function replaceAssetFileById(assetId, { name, type, filePath, thumbnailPath, width, height, metadata = {} }) {
  const existingAsset = await getAssetRecordById(assetId);

  if (!existingAsset) {
    throw new Error('Asset not found');
  }

  const nextType = type || String(existingAsset.assetTypeName || '').toLowerCase();
  const nextMetadata = {
    ...parseJson(existingAsset.metadata, {}),
    ...metadata
  };

  const db = await getDb();
  await run(
    db,
    `UPDATE Assets
     SET name = ?,
         filePath = ?,
         metadata = ?,
         thumbnail = ?,
         width = ?,
         height = ?
     WHERE id = ?`,
    [
      String(name || '').trim() || existingAsset.name,
      toStoredAssetPath(nextType, filePath),
      JSON.stringify(nextMetadata),
      thumbnailPath === undefined
        ? existingAsset.thumbnail || null
        : (thumbnailPath ? toStoredThumbnailPath(thumbnailPath) : null),
      Number(width) || 0,
      Number(height) || 0,
      Number(assetId)
    ]
  );

  return await getAssetViewById(Number(assetId));
}

export async function getProjectAssetById(projectId, assetId) {
  const asset = await getAssetViewById(assetId);
  if (!asset || Number(asset.projectId) !== Number(projectId)) {
    return null;
  }

  return asset;
}

// Fall back to resolving an edit/version by its own file when its parent root
// isn't a Kanban card asset in the requested project. The node-graph asset
// library is global, so an Image/Mesh node can legitimately reference an edit
// whose root lives in another project (or was imported straight into the
// library and has no card at all). The primary card-scoped lookup runs first;
// this only fires when that finds nothing, so it never alters resolution for
// edits whose root IS a card asset in the project.
async function resolveEditSourceByFilePath(db, editFilePath, typeName) {
  const editRow = await get(
    db,
    `SELECT child.id AS childId, child.parentId, child.name AS editName,
            child.filePath AS editFilePath, child.width AS editWidth,
            child.height AS editHeight, child.metadata AS editMetadata
     FROM Assets child
     JOIN AssetTypes childType ON childType.id = child.assetTypeId
     WHERE child.filePath = ? AND childType.name = ?
     ORDER BY child.creationDate DESC, child.id DESC
     LIMIT 1`,
    [editFilePath, typeName]
  );

  if (!editRow) {
    return null;
  }

  const rootAsset = await getRootAssetById(editRow.parentId || editRow.childId);
  const assetView = rootAsset ? await getAssetViewById(rootAsset.id) : null;
  const editMetadata = parseJson(editRow.editMetadata, {});
  const expectedType = typeName.toLowerCase();

  return {
    asset: assetView && assetView.type === expectedType
      ? assetView
      : {
        id: rootAsset?.id ?? editRow.parentId ?? editRow.childId,
        type: expectedType,
        name: rootAsset?.name || editRow.editName || '',
        filePath: rootAsset?.filePath || editRow.editFilePath
      },
    inputFilePath: editRow.editFilePath,
    inputFilename: toAssetUrlPath(editRow.editFilePath),
    inputName: editRow.editName || `${expectedType === 'mesh' ? 'Version' : 'Edit'} ${editMetadata?.editId || editRow.childId}`,
    width: editRow.editWidth ?? 0,
    height: editRow.editHeight ?? 0,
    isEdit: true,
    editId: editMetadata?.editId || null
  };
}

// Resolve an image/mesh input source by asset id, accepting EITHER a root/card
// asset OR a child edit/version. A child (an image edit or a mesh version) has no
// Cards_Assets link of its own — only its root does — so getProjectAssetById(id)
// returns null for it; here we accept it as long as its root belongs to the
// project, using the child's own file as the input. This lets callers reference an
// edit/version by its plain asset id, the same way they reference a root asset.
async function resolveProjectAssetSourceById(projectId, assetId, typeName) {
  const expectedType = typeName.toLowerCase();

  const direct = await getProjectAssetById(projectId, assetId);
  if (direct) {
    if (direct.type !== expectedType) {
      return null;
    }
    return {
      asset: direct,
      inputFilePath: direct.filePath,
      inputFilename: direct.filename,
      inputName: direct.name,
      isEdit: false,
      editId: null
    };
  }

  // Not a card-linked asset — try to resolve it as a child edit/version whose
  // root lives in this project.
  const record = await getAssetRecordById(assetId);
  if (!record || !record.parentId || String(record.assetTypeName || '').toLowerCase() !== expectedType) {
    return null;
  }

  const root = await getRootAssetById(assetId);
  const rootInProject = root ? await getProjectAssetById(projectId, root.id) : null;
  if (!rootInProject) {
    return null;
  }

  const metadata = parseJson(record.metadata, {});
  return {
    asset: { id: record.id, type: expectedType, name: record.name, filePath: record.filePath },
    inputFilePath: record.filePath,
    inputFilename: toAssetUrlPath(record.filePath),
    inputName: record.name,
    isEdit: true,
    editId: metadata?.editId || null
  };
}

export async function resolveProjectImageSource(projectId, sourceReference) {
  const parsedReference = typeof sourceReference === 'string'
    ? sourceReference
    : typeof sourceReference === 'number'
      ? String(sourceReference)
      : (sourceReference?.source || sourceReference?.filePath || sourceReference?.assetId || '');

  if (typeof parsedReference === 'string' && parsedReference.startsWith('edit:')) {
    const editFilePath = parsedReference.slice(5);
    const db = await getDb();
    const row = await get(
      db,
       `SELECT projectAsset.id AS assetId, c.projectId, projectAsset.name AS assetName, projectAsset.filePath AS assetFilePath,
              child.name AS editName, child.filePath AS editFilePath, child.width AS editWidth, child.height AS editHeight,
              child.creationDate, child.metadata AS editMetadata
       FROM Assets child
       JOIN Assets sourceAsset ON sourceAsset.id = child.parentId
       JOIN Assets projectAsset ON projectAsset.filePath = sourceAsset.filePath
         AND projectAsset.assetTypeId = sourceAsset.assetTypeId
       JOIN Cards_Assets ca ON ca.assetId = projectAsset.id
       JOIN Cards c ON c.id = ca.cardId
       JOIN AssetTypes sourceType ON sourceType.id = sourceAsset.assetTypeId
       JOIN AssetTypes childType ON childType.id = child.assetTypeId
       WHERE c.projectId = ? AND child.filePath = ? AND sourceType.name = 'Image' AND childType.name = 'Image'
       ORDER BY c.creationDate DESC, projectAsset.creationDate DESC, projectAsset.id DESC
       LIMIT 1`,
      [projectId, editFilePath]
    );

    if (!row) {
      return await resolveEditSourceByFilePath(db, editFilePath, 'Image');
    }

    const asset = await getProjectAssetById(projectId, row.assetId);
    if (!asset) {
      return await resolveEditSourceByFilePath(db, editFilePath, 'Image');
    }

    const editMetadata = parseJson(row.editMetadata, {});

    return {
      asset,
      inputFilePath: row.editFilePath,
      inputFilename: toAssetUrlPath(row.editFilePath),
      inputName: row.editName || `Edit ${editMetadata?.editId || row.assetId}`,
      width: row.editWidth ?? 0,
      height: row.editHeight ?? 0,
      isEdit: true,
      editId: editMetadata?.editId || null
    };
  }

  const assetId = typeof parsedReference === 'string' && parsedReference.startsWith('asset:')
    ? Number(parsedReference.slice(6))
    : Number(parsedReference);

  if (!assetId) {
    return null;
  }

  return await resolveProjectAssetSourceById(projectId, assetId, 'Image');
}

// Given a file (served filename or stored path) chosen as a workflow image/mesh
// input, produce the correct source reference so the OUTPUT is parented to the
// root ancestor and no bogus root asset is created:
//   - an edit/child file  -> "edit:<storedFilePath>" (server parents output to the root)
//   - a root already in this project -> "asset:<id>"
//   - a library root not in this project -> attach detached, then "asset:<newId>"
// This is what the Brainstorming Board uses for "From Assets" / "Selected image".
export async function resolveEditableSourceReference(projectId, type, filePathOrFilename) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const normalizedType = normalizeAssetTypeName(type); // 'Image' | 'Mesh'
  const lowerType = normalizedType.toLowerCase();
  const stored = toStoredAssetPath(lowerType, filePathOrFilename);
  const db = await getDb();

  // 1. The file belongs to an edit/version (child) → reference it as an edit.
  const editRow = await get(
    db,
    `SELECT a.id FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE a.filePath = ? AND a.parentId IS NOT NULL AND at.name = ?
     LIMIT 1`,
    [stored, normalizedType]
  );
  if (editRow) {
    return { sourceReference: `edit:${stored}`, isEdit: true };
  }

  // 2. A root asset with this file already linked to the project → reference by id.
  const projectRoot = await get(
    db,
    `SELECT a.id FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     JOIN Cards_Assets ca ON ca.assetId = a.id
     JOIN Cards c ON c.id = ca.cardId
     WHERE a.filePath = ? AND a.parentId IS NULL AND at.name = ? AND c.projectId = ?
     LIMIT 1`,
    [stored, normalizedType, normalizedProjectId]
  );
  if (projectRoot) {
    return { sourceReference: `asset:${projectRoot.id}`, isEdit: false };
  }

  // 3. Library root not in this project → attach it (detached, no Kanban card).
  const libraryAsset = await findLibraryAssetByFilePath(lowerType, stored);
  const attached = await createProjectAsset({
    projectId: normalizedProjectId,
    type: lowerType,
    name: libraryAsset?.name || stored.split('/').pop(),
    filePath: stored,
    thumbnailPath: libraryAsset?.thumbnail || null,
    width: libraryAsset?.width ?? 0,
    height: libraryAsset?.height ?? 0,
    metadata: { source: 'ASSET LIB' },
    detached: true
  });
  return { sourceReference: `asset:${attached.id}`, isEdit: false, attached: true };
}

export async function resolveProjectMeshSource(projectId, sourceReference) {
  const parsedReference = typeof sourceReference === 'string'
    ? sourceReference
    : typeof sourceReference === 'number'
      ? String(sourceReference)
      : (sourceReference?.source || sourceReference?.filePath || sourceReference?.assetId || '');

  if (typeof parsedReference === 'string' && parsedReference.startsWith('edit:')) {
    const editFilePath = parsedReference.slice(5);
    const db = await getDb();
    const row = await get(
      db,
       `SELECT projectAsset.id AS assetId, c.projectId, projectAsset.name AS assetName, projectAsset.filePath AS assetFilePath,
              child.name AS editName, child.filePath AS editFilePath, child.width AS editWidth, child.height AS editHeight,
              child.creationDate, child.metadata AS editMetadata
       FROM Assets child
       JOIN Assets sourceAsset ON sourceAsset.id = child.parentId
       JOIN Assets projectAsset ON projectAsset.filePath = sourceAsset.filePath
         AND projectAsset.assetTypeId = sourceAsset.assetTypeId
       JOIN Cards_Assets ca ON ca.assetId = projectAsset.id
       JOIN Cards c ON c.id = ca.cardId
       JOIN AssetTypes sourceType ON sourceType.id = sourceAsset.assetTypeId
       JOIN AssetTypes childType ON childType.id = child.assetTypeId
       WHERE c.projectId = ? AND child.filePath = ? AND sourceType.name = 'Mesh' AND childType.name = 'Mesh'
       ORDER BY c.creationDate DESC, projectAsset.creationDate DESC, projectAsset.id DESC
       LIMIT 1`,
      [projectId, editFilePath]
    );

    if (!row) {
      return await resolveEditSourceByFilePath(db, editFilePath, 'Mesh');
    }

    const asset = await getProjectAssetById(projectId, row.assetId);
    if (!asset) {
      return await resolveEditSourceByFilePath(db, editFilePath, 'Mesh');
    }

    const editMetadata = parseJson(row.editMetadata, {});

    return {
      asset,
      inputFilePath: row.editFilePath,
      inputFilename: toAssetUrlPath(row.editFilePath),
      inputName: row.editName || `Version ${editMetadata?.editId || row.assetId}`,
      width: row.editWidth ?? 0,
      height: row.editHeight ?? 0,
      isEdit: true,
      editId: editMetadata?.editId || null
    };
  }

  const assetId = typeof parsedReference === 'string' && parsedReference.startsWith('asset:')
    ? Number(parsedReference.slice(6))
    : Number(parsedReference);

  if (!assetId) {
    return null;
  }

  return await resolveProjectAssetSourceById(projectId, assetId, 'Mesh');
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

export async function updateProject(projectId, updates = {}) {
  const db = await getDb();
  const existing = await get(db, 'SELECT * FROM Projects WHERE id = ?', [projectId]);
  if (!existing) return null;

  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.preset !== undefined) { fields.push('preset = ?'); values.push(updates.preset); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.graphViewport !== undefined) {
    fields.push('graphViewport = ?');
    values.push(updates.graphViewport === null ? null : JSON.stringify(updates.graphViewport));
  }

  if (fields.length > 0) {
    values.push(projectId);
    await run(db, `UPDATE Projects SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  const row = await get(db, 'SELECT * FROM Projects WHERE id = ?', [projectId]);
  return row ? mapProjectRow(row) : null;
}

export async function getProjectById(projectId) {
  const db = await getDb();
  const row = await get(db, 'SELECT * FROM Projects WHERE id = ?', [projectId]);
  return row ? mapProjectRow(row) : null;
}

export async function deleteProjectById(projectId, { deleteAssets = false } = {}) {
  const db = await getDb();

  let candidateAssetIds = [];
  if (deleteAssets) {
    const projectAssetRows = await all(
      db,
      `SELECT DISTINCT ca.assetId AS assetId
       FROM Cards_Assets ca
       JOIN Cards c ON c.id = ca.cardId
       WHERE c.projectId = ?`,
      [projectId]
    );
    const directIds = projectAssetRows.map(row => row.assetId);

    if (directIds.length > 0) {
      const directPlaceholders = directIds.map(() => '?').join(',');
      const siblingRows = await all(
        db,
        `SELECT id FROM Assets
         WHERE filePath IN (SELECT filePath FROM Assets WHERE id IN (${directPlaceholders}))`,
        directIds
      );
      candidateAssetIds = siblingRows.map(row => row.id);
    }
  }

  await run(db, 'DELETE FROM Projects WHERE id = ?', [projectId]);

  if (!deleteAssets || candidateAssetIds.length === 0) return;

  const placeholders = candidateAssetIds.map(() => '?').join(',');

  const eligibleRows = await all(
    db,
    `SELECT a.id, a.filePath, a.thumbnail
     FROM Assets a
     WHERE a.id IN (${placeholders})
       AND a.assetTypeId NOT IN (
             SELECT id FROM AssetTypes WHERE name IN ('Workflow', 'Brush')
           )
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets WHERE Cards_Assets.assetId = a.id)`,
    candidateAssetIds
  );

  if (eligibleRows.length === 0) return;

  const eligibleIds = eligibleRows.map(row => row.id);
  const eligiblePlaceholders = eligibleIds.map(() => '?').join(',');
  const childRows = await all(
    db,
    `SELECT id, filePath, thumbnail FROM Assets WHERE parentId IN (${eligiblePlaceholders})`,
    eligibleIds
  );

  const allDeletedRows = [...eligibleRows, ...childRows];
  const allDeletedIds = allDeletedRows.map(row => row.id);
  const filePathsToCheck = new Set(allDeletedRows.map(row => row.filePath).filter(Boolean));
  const thumbnailsToCheck = new Set(allDeletedRows.map(row => row.thumbnail).filter(Boolean));

  await run(
    db,
    `DELETE FROM Assets WHERE id IN (${eligiblePlaceholders})`,
    eligibleIds
  );

  for (const filePath of filePathsToCheck) {
    const stillReferenced = await get(
      db,
      'SELECT 1 FROM Assets WHERE filePath = ? LIMIT 1',
      [filePath]
    );
    if (!stillReferenced) {
      await fs.rm(toAbsoluteStoragePath(filePath), { force: true }).catch(() => null);
    }
  }

  for (const thumbnail of thumbnailsToCheck) {
    const stillReferenced = await get(
      db,
      'SELECT 1 FROM Assets WHERE thumbnail = ? LIMIT 1',
      [thumbnail]
    );
    if (!stillReferenced) {
      await fs.rm(toAbsoluteStoragePath(thumbnail), { force: true }).catch(() => null);
    }
  }

  for (const id of allDeletedIds) {
    await fs.rm(paintDocSubdirForAsset(id), { recursive: true, force: true }).catch(() => null);
  }
}

export async function listProjectTasks(projectId) {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT c.*
     FROM Cards c
     JOIN Columns kc ON kc.id = c.kanbanColumnId
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
     JOIN Columns kc ON kc.id = c.kanbanColumnId
     WHERE c.projectId = ?
     ORDER BY c.kanbanColumnId ASC, c.position ASC, c.creationDate ASC, c.id ASC`,
    [projectId]
  );

  return rows.map(mapProjectCardRow);
}

// Shared SELECT for a node-card (a Card with nodeTypeId set). Its single asset
// is resolved through Cards_Assets and aliased so mapGraphNodeRow keeps working
// unchanged (it reads row.assetId, row.assetName, …).
const NODE_CARD_SELECT = `
  SELECT c.id, c.projectId, c.nodeTypeId, c.name, c.xPos, c.yPos,
         c.status, c.progress, c.metadata, c.creationDate,
         nt.name AS nodeTypeName,
         a.id AS assetId, a.name AS assetName, a.filePath AS assetFilePath, a.thumbnail AS assetThumbnail,
         a.width AS assetWidth, a.height AS assetHeight, a.creationDate AS assetCreationDate,
         a.parentId AS assetParentId, a.metadata AS assetMetadata,
         at.name AS assetTypeName
  FROM Cards c
  JOIN NodeTypes nt ON nt.id = c.nodeTypeId
  LEFT JOIN Cards_Assets ca ON ca.cardId = c.id
  LEFT JOIN Assets a ON a.id = ca.assetId
  LEFT JOIN AssetTypes at ON at.id = a.assetTypeId
`;

// Set (or clear) the single asset a node-card carries, stored in Cards_Assets.
// When attaching, also absorb any backing "Images" card link that generation
// created for the same asset in this project (a card with nodeTypeId IS NULL),
// pruning it if it becomes empty — so a graph asset ends up associated solely
// with its node-card, never double-linked. Sibling node-cards that share the
// asset are left untouched.
async function setNodeCardAsset(db, cardId, assetId) {
  await run(db, 'DELETE FROM Cards_Assets WHERE cardId = ?', [cardId]);
  if (assetId == null) return;

  const owner = await get(db, 'SELECT projectId FROM Cards WHERE id = ?', [cardId]);
  if (owner) {
    const backingLinks = await all(
      db,
      `SELECT ca.cardId
       FROM Cards_Assets ca JOIN Cards c ON c.id = ca.cardId
       WHERE ca.assetId = ? AND c.projectId = ? AND ca.cardId != ? AND c.nodeTypeId IS NULL`,
      [Number(assetId), owner.projectId, cardId]
    );
    if (backingLinks.length > 0) {
      const affected = [...new Set(backingLinks.map(r => r.cardId))];
      await run(
        db,
        `DELETE FROM Cards_Assets
         WHERE assetId = ? AND cardId IN (${affected.map(() => '?').join(', ')})`,
        [Number(assetId), ...affected]
      );
      for (const cid of affected) {
        await normalizeCardAssetPositions(cid);
      }
      await deleteCardsIfEmpty(affected);
    }
  }

  await run(db, 'INSERT INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, 0)', [cardId, Number(assetId)]);
}

async function getProjectNodeById(projectId, nodeId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const normalizedNodeId = Number(nodeId);
  const db = await getDb();
  const row = await get(
    db,
    `${NODE_CARD_SELECT} WHERE c.projectId = ? AND c.id = ? AND c.nodeTypeId IS NOT NULL`,
    [normalizedProjectId, normalizedNodeId]
  );

  return row ? mapGraphNodeRow(row) : null;
}

export async function listProjectNodes(projectId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const rows = await all(
    db,
    `${NODE_CARD_SELECT}
     WHERE c.projectId = ? AND c.nodeTypeId IS NOT NULL
     ORDER BY c.creationDate ASC, c.id ASC`,
    [normalizedProjectId]
  );

  return rows.map(mapGraphNodeRow);
}

export async function createProjectNode({
  projectId,
  nodeTypeId = null,
  nodeTypeName = '',
  name = '',
  xPos = 0,
  yPos = 0,
  assetId = null,
  status = null,
  progress = null,
  metadata = {},
  createdAt = Date.now()
} = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const resolvedNodeTypeId = nodeTypeId
    ? (await getNodeTypeById(nodeTypeId))?.id
    : await getNodeTypeIdByName(nodeTypeName);

  if (!resolvedNodeTypeId) {
    throw new Error('A valid nodeTypeId or nodeTypeName is required');
  }

  const db = await getDb();
  // A node-card: nodeTypeId + coordinates, no kanban column/position.
  const result = await run(
    db,
    `INSERT INTO Cards (projectId, kanbanColumnId, nodeTypeId, name, position, xPos, yPos, creationDate, status, progress, metadata)
     VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedProjectId,
      resolvedNodeTypeId,
      String(name || '').trim() || null,
      Number(xPos) || 0,
      Number(yPos) || 0,
      createdAt,
      status || null,
      progress ?? null,
      JSON.stringify(metadata || {})
    ]
  );

  if (assetId) {
    await setNodeCardAsset(db, result.lastID, Number(assetId));
  }

  return await getProjectNodeById(normalizedProjectId, result.lastID);
}

export async function updateProjectNodePosition(projectId, nodeId, { xPos = 0, yPos = 0 } = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const node = await ensureProjectNode(normalizedProjectId, nodeId);
  const db = await getDb();

  await run(
    db,
    'UPDATE Cards SET xPos = ?, yPos = ? WHERE id = ? AND projectId = ?',
    [Number(xPos) || 0, Number(yPos) || 0, node.id, normalizedProjectId]
  );

  return await getProjectNodeById(normalizedProjectId, node.id);
}

export async function updateProjectNode(projectId, nodeId, updates = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const node = await ensureProjectNode(normalizedProjectId, nodeId);
  const existingNode = await getProjectNodeById(normalizedProjectId, node.id);
  const db = await getDb();

  if (!existingNode) {
    throw new Error('Node not found');
  }

  const nextMetadata = updates.metadata === undefined
    ? existingNode.metadata
    : {
        ...(isPlainObject(existingNode.metadata) ? existingNode.metadata : {}),
        ...(isPlainObject(updates.metadata) ? updates.metadata : {})
      };

  await run(
    db,
    `UPDATE Cards
     SET name = ?, status = ?, progress = ?, metadata = ?
     WHERE id = ? AND projectId = ?`,
    [
      updates.name ?? existingNode.name ?? null,
      updates.status === undefined ? (existingNode.status ?? null) : updates.status,
      updates.progress === undefined ? (existingNode.progress ?? null) : updates.progress,
      JSON.stringify(nextMetadata || {}),
      node.id,
      normalizedProjectId
    ]
  );

  // The node's asset lives in Cards_Assets. Only touch it when assetId is part
  // of the update, and only when it actually changed.
  if (updates.assetId !== undefined) {
    const nextAssetId = updates.assetId ? Number(updates.assetId) : null;
    if (nextAssetId !== (existingNode.assetId ?? null)) {
      await setNodeCardAsset(db, node.id, nextAssetId);
    }
  }

  return await getProjectNodeById(normalizedProjectId, node.id);
}

export async function deleteProjectNode(projectId, nodeId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const node = await ensureProjectNode(normalizedProjectId, nodeId);
  const db = await getDb();

  // Deleting the card cascades its Cards_Assets link and any Connections.
  await run(db, 'DELETE FROM Cards WHERE id = ? AND projectId = ? AND nodeTypeId IS NOT NULL', [node.id, normalizedProjectId]);

  return { status: 'deleted' };
}

export async function listProjectConnections(projectId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT cn.sourceCardId AS sourceNodeId, cn.targetCardId AS targetNodeId, cn.inputId, cn.outputId
     FROM Connections cn
     JOIN Cards sourceCard ON sourceCard.id = cn.sourceCardId
     JOIN Cards targetCard ON targetCard.id = cn.targetCardId
     WHERE sourceCard.projectId = ? AND targetCard.projectId = ?
     ORDER BY cn.sourceCardId ASC, cn.targetCardId ASC, cn.inputId ASC, cn.outputId ASC`,
    [normalizedProjectId, normalizedProjectId]
  );

  return rows.map(mapGraphConnectionRow);
}

export async function createProjectConnection(projectId, {
  sourceNodeId,
  targetNodeId,
  inputId = 'image-input',
  outputId = 'image-output'
} = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const sourceNode = await ensureProjectNode(normalizedProjectId, sourceNodeId);
  const targetNode = await ensureProjectNode(normalizedProjectId, targetNodeId);

  if (sourceNode.id === targetNode.id) {
    throw new Error('A node cannot connect to itself');
  }

  const db = await getDb();
  await run(
    db,
    `INSERT INTO Connections (sourceCardId, targetCardId, inputId, outputId)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sourceCardId, targetCardId, inputId, outputId) DO NOTHING`,
    [sourceNode.id, targetNode.id, String(inputId || 'image-input'), String(outputId || 'image-output')]
  );

  return {
    sourceNodeId: sourceNode.id,
    targetNodeId: targetNode.id,
    inputId: String(inputId || 'image-input'),
    outputId: String(outputId || 'image-output')
  };
}

export async function deleteProjectConnection(projectId, {
  sourceNodeId,
  targetNodeId,
  inputId = 'image-input',
  outputId = 'image-output'
} = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const result = await run(
    db,
    `DELETE FROM Connections
     WHERE sourceCardId = ? AND targetCardId = ? AND inputId = ? AND outputId = ?
       AND sourceCardId IN (SELECT id FROM Cards WHERE projectId = ?)
       AND targetCardId IN (SELECT id FROM Cards WHERE projectId = ?)`,
    [
      Number(sourceNodeId),
      Number(targetNodeId),
      String(inputId || 'image-input'),
      String(outputId || 'image-output'),
      normalizedProjectId,
      normalizedProjectId
    ]
  );

  return { status: result.changes > 0 ? 'deleted' : 'not-found' };
}

// ---------------------------------------------------------------------------
// Brainstorming Boards
// ---------------------------------------------------------------------------

function mapBoardRow(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    position: row.position ?? 0,
    state: parseJson(row.stateJson, null),
    thumbnailPath: row.thumbnailPath || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listProjectBoards(projectId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const rows = await all(
    db,
    'SELECT * FROM Boards WHERE projectId = ? ORDER BY position ASC, id ASC',
    [normalizedProjectId]
  );

  return rows.map(mapBoardRow);
}

export async function getBoardById(boardId) {
  const db = await getDb();
  const row = await get(db, 'SELECT * FROM Boards WHERE id = ?', [Number(boardId)]);
  return row ? mapBoardRow(row) : null;
}

export async function createBoard({ projectId, name = 'Untitled Board', position = null } = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();

  let nextPosition;
  if (position === null || position === undefined || !Number.isFinite(Number(position))) {
    const row = await get(
      db,
      'SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM Boards WHERE projectId = ?',
      [normalizedProjectId]
    );
    nextPosition = row?.nextPosition ?? 0;
  } else {
    nextPosition = Number(position);
  }

  const now = Date.now();
  const result = await run(
    db,
    'INSERT INTO Boards (projectId, name, position, stateJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    [normalizedProjectId, String(name || '').trim() || 'Untitled Board', nextPosition, null, now, now]
  );

  return await getBoardById(result.lastID);
}

export async function updateBoard(boardId, updates = {}) {
  const db = await getDb();
  const existing = await get(db, 'SELECT * FROM Boards WHERE id = ?', [Number(boardId)]);
  if (!existing) return null;

  const fields = [];
  const values = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(String(updates.name || '').trim() || 'Untitled Board');
  }
  if (updates.position !== undefined) {
    fields.push('position = ?');
    values.push(Number(updates.position) || 0);
  }
  if (updates.state !== undefined) {
    fields.push('stateJson = ?');
    values.push(updates.state === null ? null : JSON.stringify(updates.state));
  }
  if (updates.thumbnailPath !== undefined) {
    fields.push('thumbnailPath = ?');
    values.push(updates.thumbnailPath || null);
  }

  if (fields.length > 0) {
    fields.push('updatedAt = ?');
    values.push(Date.now());
    values.push(Number(boardId));
    await run(db, `UPDATE Boards SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  return await getBoardById(boardId);
}

export async function deleteBoard(boardId) {
  const db = await getDb();
  const result = await run(db, 'DELETE FROM Boards WHERE id = ?', [Number(boardId)]);
  return { status: result.changes > 0 ? 'deleted' : 'not-found' };
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

export async function clearStaleProcessingCards({ preservedSources = [] } = {}) {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT id, projectId, name, metadata FROM Cards WHERE status = 'processing'`
  );

  const preserved = new Set(preservedSources.map(value => String(value).toLowerCase()));
  let clearedCount = 0;

  for (const row of rows) {
    const metadata = parseJson(row.metadata, {});
    // Kanban cards nest the run state under `processing.source`; graph nodes
    // store it flat as `processingSource`. Check both so async provider jobs
    // (Tencent / Tripo / Hitem3D) are preserved across a restart on either page.
    const source = String(metadata?.processing?.source || metadata?.processingSource || '').toLowerCase();

    if (preserved.has(source)) {
      continue;
    }

    const nextMetadata = buildNextCardMetadata(metadata, null);

    await run(
      db,
      `UPDATE Cards SET status = NULL, progress = NULL, metadata = ? WHERE id = ?`,
      [JSON.stringify(nextMetadata), row.id]
    );
    clearedCount += 1;
  }

  return clearedCount;
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
     LEFT JOIN Columns kc ON kc.id = c.kanbanColumnId
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
         AND a.parentId IS NULL
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

  const meshFilePaths = rows
    .filter(row => String(row.assetTypeName || '').toLowerCase() === 'mesh')
    .map(row => row.filePath)
    .filter(Boolean);

  const uniqueMeshFilePaths = [...new Set(meshFilePaths)];

  const imageChildAssetRows = await listChildAssetsByParentFilePaths(db, uniqueImageFilePaths, 'Image');
  const meshChildAssetRows = await listChildAssetsByParentFilePaths(db, uniqueMeshFilePaths, 'Mesh');
  // Image and mesh assets never share a filePath, so a single keyed map is safe.
  const childrenByFilePath = groupChildAssetsByParentFilePath([...imageChildAssetRows, ...meshChildAssetRows]);

  return rows.map(row => {
    const canonicalAsset = canonicalAssetsByKey[`${row.assetTypeName}:${row.filePath}`];
    const assetChildren = childrenByFilePath[row.filePath] || [];

    return {
      ...mapAssetRow({
        ...row,
        name: canonicalAsset?.name || row.name,
        thumbnail: row.thumbnail || canonicalAsset?.thumbnail || null
      }),
      children: assetChildren,
      childCount: assetChildren.length,
      edits: assetChildren,
      editCount: assetChildren.length
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
  const parentAsset = await getRootAssetById(assetId);

  if (!parentAsset) {
    throw new Error('Source asset not found');
  }

  const storedFilePath = toStoredAssetPath('image', filePath);
  const childAssetId = await insertAsset({
    name: String(name || '').trim() || `Edit ${editId}`,
    type: 'image',
    filePath: storedFilePath,
    width,
    height,
    metadata: {
      editId,
      source: 'IMAGE EDIT'
    },
    createdAt,
    parentId: parentAsset.id
  });

  return {
    id: childAssetId,
    assetId: parentAsset.id,
    parentId: parentAsset.id,
    editId,
    name: String(name || '').trim(),
    filePath: storedFilePath,
    width: Number(width) || 0,
    height: Number(height) || 0,
    creationDate: createdAt
  };
}

export async function createBrushChildRecord({ parentAssetId, name = '', filePath, width = 0, height = 0, createdAt = Date.now() }) {
  const parentAsset = await getRootAssetById(parentAssetId);

  if (!parentAsset) {
    throw new Error('Source brush asset not found');
  }

  const storedFilePath = toStoredAssetPath('brush', filePath);
  const childAssetId = await insertAsset({
    name: String(name || '').trim() || 'Brush',
    type: 'brush',
    filePath: storedFilePath,
    width,
    height,
    metadata: {
      source: 'BRUSH IMPORT'
    },
    createdAt,
    parentId: parentAsset.id
  });

  return {
    id: childAssetId,
    parentId: parentAsset.id,
    name: String(name || '').trim(),
    filePath: storedFilePath,
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

export async function deleteCard(projectId, externalCardId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const card = await resolveProjectCard(normalizedProjectId, externalCardId);

  if (!card) {
    return { status: 'not-found' };
  }

  const db = await getDb();
  await run(db, 'DELETE FROM Cards_Assets WHERE cardId = ?', [card.id]);
  await run(db, 'DELETE FROM Cards_Attributes WHERE cardId = ?', [card.id]);
  await run(db, 'DELETE FROM Cards WHERE id = ?', [card.id]);
  await normalizeCardPositions(normalizedProjectId, card.kanbanColumnId);

  return { status: 'deleted' };
}

export async function moveCard(projectId, externalCardId, kanbanColumnId, position) {
  const db = await getDb();
  const card = await resolveProjectCard(projectId, externalCardId);

  if (!card) {
    throw new Error('Card not found');
  }

  const targetColumn = await get(db, 'SELECT id, name FROM Columns WHERE id = ?', [kanbanColumnId]);
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

// A per-project "container" card that holds assets which must be linked to the
// project but must NOT appear on the Kanban board. It has no kanbanColumnId (so
// listProjectCards' INNER JOIN on Columns excludes it) and no nodeTypeId (so the
// graph node listing excludes it too) — yet the library listing still resolves
// the asset's project through it. Used for Brainstorming Board generations.
async function ensureDetachedCard(projectId, clientKey = 'board-assets') {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();

  const existing = await get(
    db,
    'SELECT id, clientKey FROM Cards WHERE projectId = ? AND clientKey = ? AND kanbanColumnId IS NULL AND nodeTypeId IS NULL',
    [normalizedProjectId, clientKey]
  );
  if (existing) {
    return { id: existing.id, clientKey: existing.clientKey };
  }

  const result = await run(
    db,
    `INSERT INTO Cards (projectId, kanbanColumnId, nodeTypeId, clientKey, name, position, creationDate)
     VALUES (?, NULL, NULL, ?, ?, NULL, ?)`,
    [normalizedProjectId, clientKey, 'Board assets', Date.now()]
  );

  return { id: result.lastID, clientKey };
}

export async function createProjectAsset({ projectId, type, name, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), detached = false }) {
  const card = detached
    ? await ensureDetachedCard(projectId)
    : await ensureCard(projectId, 'Images', metadata.cardId, {
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
       AND a.parentId IS NULL
       AND a.filePath = ?
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
       AND a.parentId IS NULL
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
       AND a.parentId IS NULL
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
    `SELECT id, parentId, filePath, creationDate, metadata
     FROM Assets
     WHERE filePath = ?
       AND parentId IS NOT NULL
     LIMIT 1`,
    [storedFilePath]
  );

  if (!existingEdit) {
    throw new Error('Edit not found');
  }

  await run(db, 'UPDATE Assets SET name = ? WHERE filePath = ? AND parentId IS NOT NULL', [trimmedName, storedFilePath]);

  const editMetadata = parseJson(existingEdit.metadata, {});

  return {
    assetId: existingEdit.parentId,
    parentId: existingEdit.parentId,
    editId: editMetadata?.editId || null,
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
    `SELECT id, parentId, filePath, metadata
     FROM Assets
     WHERE filePath = ?
       AND parentId IS NOT NULL
     LIMIT 1`,
    [storedFilePath]
  );

  if (!existingEdit) {
    return { status: 'not-found' };
  }

  await run(db, 'DELETE FROM Assets WHERE filePath = ? AND parentId IS NOT NULL', [storedFilePath]);

  const absoluteEditFilePath = toAbsoluteStoragePath(existingEdit.filePath);
  await fs.rm(absoluteEditFilePath, { force: true }).catch(() => null);
  // NB: never remove path.dirname() here — edit files share the images folder.

  const editMetadata = parseJson(existingEdit.metadata, {});

  return {
    status: 'deleted',
    assetId: existingEdit.parentId,
    parentId: existingEdit.parentId,
    editId: editMetadata?.editId || null,
    filePath: existingEdit.filePath
  };
}

// Escape characters that are wildcards in a SQL LIKE pattern so a filePath
// (which can legitimately contain "_") is matched literally.
function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, char => `\\${char}`);
}

// A mesh version (child asset) can be referenced by a project through either a
// Kanban card or a Graph node — directly (assetId) or as a selected source
// (an "edit:<filePath>" reference held in a card attribute or node metadata).
// Returns the first project found, or null when the version is unlinked.
async function findProjectLinkedToVersion(db, versionId, editReference) {
  // 1. Kanban card with this version selected as a workflow input source.
  const cardAttribute = await get(
    db,
    `SELECT c.projectId, p.name AS projectName
     FROM Cards_Attributes attr
     JOIN Cards c ON c.id = attr.cardId
     LEFT JOIN Projects p ON p.id = c.projectId
     WHERE attr.attributeValue = ?
     ORDER BY c.creationDate DESC, c.id DESC
     LIMIT 1`,
    [editReference]
  );
  if (cardAttribute) return cardAttribute;

  // 2. Kanban card with this version directly attached.
  const cardAsset = await get(
    db,
    `SELECT c.projectId, p.name AS projectName
     FROM Cards_Assets ca
     JOIN Cards c ON c.id = ca.cardId
     LEFT JOIN Projects p ON p.id = c.projectId
     WHERE ca.assetId = ?
     ORDER BY c.creationDate DESC, c.id DESC
     LIMIT 1`,
    [versionId]
  );
  if (cardAsset) return cardAsset;

  // 3. Any card (kanban card or graph node-card) with this version selected as a
  //    source, stored as an "edit:<filePath>" reference in its metadata JSON.
  const cardMetadata = await get(
    db,
    `SELECT c.projectId, p.name AS projectName
     FROM Cards c
     LEFT JOIN Projects p ON p.id = c.projectId
     WHERE c.metadata LIKE ? ESCAPE '\\'
     ORDER BY c.creationDate DESC, c.id DESC
     LIMIT 1`,
    [`%${escapeLikePattern(editReference)}%`]
  );
  if (cardMetadata) return cardMetadata;

  return null;
}

export async function deleteAssetVersionByFilePath(filePath, { force = false } = {}) {
  const db = await getDb();
  const storedFilePath = toStoredAssetPath('mesh', filePath);

  const version = await get(
    db,
    `SELECT id, parentId, filePath, thumbnail
     FROM Assets
     WHERE filePath = ?
       AND parentId IS NOT NULL
     LIMIT 1`,
    [storedFilePath]
  );

  if (!version) {
    return { status: 'not-found' };
  }

  const editReference = `edit:${version.filePath}`;
  const linkedProject = await findProjectLinkedToVersion(db, version.id, editReference);

  if (linkedProject && !force) {
    return {
      status: 'linked',
      projectId: linkedProject.projectId,
      projectName: linkedProject.projectName || null
    };
  }

  // Force delete (or unlinked): detach any project references so cards/nodes
  // don't keep pointing at a file that no longer exists. Node.assetId is
  // ON DELETE SET NULL, so direct graph-node attachments clear when the row goes.
  await run(db, 'DELETE FROM Cards_Attributes WHERE attributeValue = ?', [editReference]);
  await run(db, 'DELETE FROM Cards_Assets WHERE assetId = ?', [version.id]);

  await run(db, 'DELETE FROM Assets WHERE id = ? AND parentId IS NOT NULL', [version.id]);

  // Only the mesh file itself is removed — the thumbnail is typically inherited
  // from (shared with) the parent asset, so deleting it would break the parent.
  const absoluteFilePath = toAbsoluteStoragePath(version.filePath);
  await fs.rm(absoluteFilePath, { force: true }).catch(() => null);

  return { status: 'deleted' };
}

export async function deleteLibraryAssetByFilePath(type, filePath, { force = false } = {}) {
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
       AND a.parentId IS NULL
       AND a.filePath = ?
     ORDER BY c.creationDate DESC
     LIMIT 1`,
    [normalizedType, storedFilePath]
  );

  if (linkedProject && !force) {
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
       AND a.parentId IS NULL
       AND a.filePath = ?`,
    [normalizedType, storedFilePath]
  );

  if (assets.length === 0) {
    const absoluteFilePath = toAbsoluteStoragePath(storedFilePath);
    await fs.rm(absoluteFilePath, { force: true }).catch(() => null);
    return { status: 'deleted' };
  }

  const childAssetRows = normalizedType === 'Image' && assets.length > 0
    ? await all(
      db,
      `SELECT id, filePath
       FROM Assets
       WHERE parentId IN (${assets.map(() => '?').join(', ')})`,
      assets.map(asset => asset.id)
    )
    : [];

  if (childAssetRows.length > 0) {
    await run(
      db,
      `DELETE FROM Cards_Assets
       WHERE assetId IN (${childAssetRows.map(() => '?').join(', ')})`,
      childAssetRows.map(childAsset => childAsset.id)
    );

    await run(
      db,
      `DELETE FROM Assets
       WHERE id IN (${childAssetRows.map(() => '?').join(', ')})`,
      childAssetRows.map(childAsset => childAsset.id)
    );
  }

  const assetIds = assets.map(asset => asset.id);
  const linkedCardRows = assetIds.length > 0
    ? await all(
      db,
      `SELECT cardId, assetId
       FROM Cards_Assets
       WHERE assetId IN (${assetIds.map(() => '?').join(', ')})`,
      assetIds
    )
    : [];

  if (linkedCardRows.length > 0) {
    await run(
      db,
      `DELETE FROM Cards_Assets
       WHERE assetId IN (${assetIds.map(() => '?').join(', ')})`,
      assetIds
    );
  }

  for (const asset of assets) {
    await run(db, 'DELETE FROM Assets WHERE id = ?', [asset.id]);
  }

  const affectedCardIds = [...new Set(linkedCardRows.map(row => row.cardId).filter(cardId => Number.isInteger(cardId)))];
  for (const cardId of affectedCardIds) {
    await normalizeCardAssetPositions(cardId);
  }

  await deleteCardsIfEmpty(affectedCardIds);

  await fs.rm(toAbsoluteStoragePath(storedFilePath), { force: true }).catch(() => null);

  for (const asset of assets) {
    if (asset.thumbnail) {
      await fs.rm(toAbsoluteStoragePath(asset.thumbnail), { force: true }).catch(() => null);
    }
  }

  // Remove each edit's OWN file only — never its directory. Edit files live in
  // the shared data/assets/images folder, so deleting path.dirname() here would
  // recursively wipe every image. Guard on filePath still being referenced by
  // another asset row (edits and sources can share files after attach/link).
  for (const childAssetRow of childAssetRows) {
    if (!childAssetRow.filePath) continue;
    const stillReferenced = await get(db, 'SELECT 1 FROM Assets WHERE filePath = ? LIMIT 1', [childAssetRow.filePath]);
    if (!stillReferenced) {
      await fs.rm(toAbsoluteStoragePath(childAssetRow.filePath), { force: true }).catch(() => null);
    }
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
  // Only prune empty Kanban cards. Graph node-cards (nodeTypeId IS NOT NULL) are
  // valid without any asset (e.g. value nodes) and are removed only explicitly
  // via deleteProjectNode.
  const cardsToDelete = await all(
    db,
    `SELECT id, projectId, kanbanColumnId
     FROM Cards
     WHERE id IN (${placeholders})
       AND nodeTypeId IS NULL
       AND NOT EXISTS (SELECT 1 FROM Cards_Assets WHERE Cards_Assets.cardId = Cards.id)`,
    uniqueCardIds
  );

  await run(
    db,
    `DELETE FROM Cards
     WHERE id IN (${placeholders})
       AND nodeTypeId IS NULL
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

  const deletedRows = await all(
    db,
    'SELECT filePath, thumbnail FROM Assets WHERE id = ? OR parentId = ?',
    [assetId, assetId]
  );

  await run(db, 'DELETE FROM Assets WHERE parentId = ?', [assetId]);
  await run(db, 'DELETE FROM Assets WHERE id = ?', [assetId]);

  const filePathsToCheck = new Set(deletedRows.map(row => row.filePath).filter(Boolean));
  const thumbnailsToCheck = new Set(deletedRows.map(row => row.thumbnail).filter(Boolean));

  for (const filePath of filePathsToCheck) {
    const stillReferenced = await get(db, 'SELECT 1 FROM Assets WHERE filePath = ? LIMIT 1', [filePath]);
    if (!stillReferenced) {
      await fs.rm(toAbsoluteStoragePath(filePath), { force: true }).catch(() => null);
    }
  }

  for (const thumbnail of thumbnailsToCheck) {
    const stillReferenced = await get(db, 'SELECT 1 FROM Assets WHERE thumbnail = ? LIMIT 1', [thumbnail]);
    if (!stillReferenced) {
      await fs.rm(toAbsoluteStoragePath(thumbnail), { force: true }).catch(() => null);
    }
  }

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

export async function updateWorkflowRecord(workflowId, { name, parameters = [], outputs = [], filePath }) {
  const db = await getDb();

  // filePath is only provided when the underlying graph is being replaced
  // (e.g. overwriting an existing workflow with an imported .3dgw bundle).
  if (filePath !== undefined) {
    await run(db, 'UPDATE Assets SET name = ?, filePath = ? WHERE id = ?', [name, filePath, workflowId]);
  } else {
    await run(db, 'UPDATE Assets SET name = ? WHERE id = ?', [name, workflowId]);
  }
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

function mapWikiPageRow(row) {
  return {
    id: row.id,
    parentId: row.parentId ?? null,
    title: row.title,
    icon: row.icon || null,
    content: row.content ?? '',
    position: row.position ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listWikiPages() {
  const db = await getDb();
  const rows = await all(
    db,
    'SELECT id, parentId, title, icon, position, updatedAt FROM WikiPages ORDER BY position, id'
  );
  return rows.map(row => ({
    id: row.id,
    parentId: row.parentId ?? null,
    title: row.title,
    icon: row.icon || null,
    position: row.position ?? 0,
    updatedAt: row.updatedAt
  }));
}

export async function getWikiPage(id) {
  const db = await getDb();
  const row = await get(db, 'SELECT * FROM WikiPages WHERE id = ?', [Number(id)]);
  return row ? mapWikiPageRow(row) : null;
}

export async function listLibraryAssetsByType(type, baseUrl) {
  const db = await getDb();
  const assetDirectory = getAssetDirectory(type);
  await fs.mkdir(assetDirectory, { recursive: true });
  const rows = await all(
    db,
     `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND a.parentId IS NULL
     ORDER BY a.creationDate DESC`,
    [normalizeAssetTypeName(type)]
  );

  const candidateStoredPaths = [...new Set(rows.map(row => row.filePath).filter(Boolean))];

  const canonicalAssetRows = candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate,
              (
                SELECT c.projectId
                FROM Cards_Assets ca
                JOIN Cards c ON c.id = ca.cardId
                WHERE ca.assetId = a.id
                ORDER BY c.creationDate DESC, c.id DESC
                LIMIT 1
              ) AS projectId
       FROM Assets a
       JOIN AssetTypes at ON at.id = a.assetTypeId
       WHERE at.name = ?
         AND a.parentId IS NULL
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

  // Every project an asset is linked to (an asset can belong to several), so the
  // library UI can show it under each project when filtering/grouping by project.
  const projectLinkRows = candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT DISTINCT a.filePath, c.projectId
       FROM Assets a
       JOIN AssetTypes at ON at.id = a.assetTypeId
       JOIN Cards_Assets ca ON ca.assetId = a.id
       JOIN Cards c ON c.id = ca.cardId
       WHERE at.name = ?
         AND a.parentId IS NULL
         AND a.filePath IN (${candidateStoredPaths.map(() => '?').join(', ')})
         AND c.projectId IS NOT NULL
       ORDER BY c.projectId`,
      [normalizeAssetTypeName(type), ...candidateStoredPaths]
    )
    : [];

  const projectIdsByFilePath = projectLinkRows.reduce((accumulator, row) => {
    if (!accumulator[row.filePath]) {
      accumulator[row.filePath] = [];
    }

    if (!accumulator[row.filePath].includes(row.projectId)) {
      accumulator[row.filePath].push(row.projectId);
    }

    return accumulator;
  }, {});

  const childAssetRows = await listChildAssetsByParentFilePaths(db, candidateStoredPaths, normalizeAssetTypeName(type));

  const childrenBySourceFilePath = groupChildAssetsByParentFilePath(childAssetRows, baseUrl);

  const dbAssets = rows.reduce((accumulator, row) => {
    const filename = toAssetUrlPath(row.filePath);
    const existingAsset = accumulator.find(asset => asset.filename === filename);
    const assetChildren = childrenBySourceFilePath[row.filePath] || [];

    if (existingAsset) {
      const mergedChildren = [...existingAsset.children, ...assetChildren].reduce((mergedAccumulator, childAsset) => {
        if (!mergedAccumulator.some(existingChild => existingChild.filePath === childAsset.filePath)) {
          mergedAccumulator.push(childAsset);
        }

        return mergedAccumulator;
      }, []);

      existingAsset.children = mergedChildren.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
      existingAsset.childCount = existingAsset.children.length;
      existingAsset.edits = existingAsset.children;
      existingAsset.editCount = existingAsset.children.length;
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
      projectId: canonicalAsset?.projectId ?? null,
      projectIds: projectIdsByFilePath[row.filePath] || [],
      type,
      extension: path.extname(filename).replace('.', '').toUpperCase() || type.toUpperCase(),
      url: `${baseUrl}/assets/${encodeURI(filename)}`,
      width: canonicalAsset?.width ?? row.width ?? 0,
      height: canonicalAsset?.height ?? row.height ?? 0,
      thumbnailPath,
      thumbnailUrl: thumbnailFilename ? `${baseUrl}/assets/${encodeURI(thumbnailFilename)}` : null,
      children: assetChildren,
      childCount: assetChildren.length,
      edits: assetChildren,
      editCount: assetChildren.length
    });

    return accumulator;
  }, []);

  return dbAssets;
}

// ---------------------------------------------------------------------------
// Paint documents (mesh painting layers persisted as a sidecar)
// ---------------------------------------------------------------------------

function paintDocSubdirForAsset(assetId) {
  return path.join(PAINT_DOCS_DIR, String(assetId));
}

export function getPaintDocSubdir(assetId) {
  return paintDocSubdirForAsset(assetId);
}

export function toStoredPaintDocPath(assetId, filename) {
  return `data/assets/paintdocs/${assetId}/${filename}`;
}

export async function getPaintDocumentByAssetId(assetId) {
  const db = await getDb();
  const row = await get(
    db,
    'SELECT assetId, baseFilePath, textureWidth, textureHeight, layersJson, updatedAt FROM PaintDocuments WHERE assetId = ?',
    [assetId]
  );
  if (!row) return null;

  let layers = [];
  try {
    layers = JSON.parse(row.layersJson || '[]');
    if (!Array.isArray(layers)) layers = [];
  } catch {
    layers = [];
  }

  return {
    assetId: row.assetId,
    baseFilePath: row.baseFilePath || null,
    textureWidth: row.textureWidth || 0,
    textureHeight: row.textureHeight || 0,
    layers,
    updatedAt: row.updatedAt || 0
  };
}

export async function upsertPaintDocument({
  assetId,
  baseFilePath = null,
  textureWidth = 0,
  textureHeight = 0,
  layers = []
}) {
  const db = await getDb();
  const layersJson = JSON.stringify(Array.isArray(layers) ? layers : []);
  const updatedAt = Date.now();

  await run(
    db,
    `INSERT INTO PaintDocuments (assetId, baseFilePath, textureWidth, textureHeight, layersJson, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(assetId) DO UPDATE SET
       baseFilePath = excluded.baseFilePath,
       textureWidth = excluded.textureWidth,
       textureHeight = excluded.textureHeight,
       layersJson = excluded.layersJson,
       updatedAt = excluded.updatedAt`,
    [assetId, baseFilePath, textureWidth, textureHeight, layersJson, updatedAt]
  );

  return await getPaintDocumentByAssetId(assetId);
}

export async function deletePaintDocument(assetId) {
  const db = await getDb();
  await run(db, 'DELETE FROM PaintDocuments WHERE assetId = ?', [assetId]);

  // Best-effort: remove the on-disk directory for this paint document.
  const dir = paintDocSubdirForAsset(assetId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`Failed to remove paint document directory ${dir}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Project import / export (.3dgp bundles)
//
// A .3dgp bundle is a self-contained folder holding a JSON manifest plus copies
// of every asset file the project references (and their sub-assets, thumbnails
// and paint documents). Export gathers the project graph and returns both the
// manifest and a list of files to copy; import replays it into a brand-new
// project, allocating fresh asset IDs/filenames and remapping every reference.
// ---------------------------------------------------------------------------

export const PROJECT_EXPORT_SCHEMA_VERSION = 1;

// Map an AssetTypes.name ("Image", "Mesh", …) to its on-disk subdirectory.
function assetSubdirForTypeName(typeName) {
  return getAssetSubdirectory(String(typeName || 'image').toLowerCase());
}

// Deep-walk parsed metadata collecting every `asset:<id>` reference so exports
// pull in assets that are only referenced from a card/node's metadata (e.g. the
// "last action" params or a Tripo input source), not just its primary link.
function collectAssetIdsFromValue(value, out) {
  if (typeof value === 'string') {
    const match = value.match(/^asset:(\d+)$/);
    if (match) out.add(Number(match[1]));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectAssetIdsFromValue(item, out));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectAssetIdsFromValue(item, out));
  }
}

// Order assets so a parent always precedes its children (needed to remap
// parentId during import). Assets whose parent is absent from the set are
// treated as roots.
function orderAssetsParentFirst(assets) {
  const byRefId = new Map(assets.map(asset => [asset.refId, asset]));
  const ordered = [];
  const visited = new Set();

  const visit = (asset) => {
    if (!asset || visited.has(asset.refId)) return;
    visited.add(asset.refId);
    const parent = asset.parentRefId != null ? byRefId.get(asset.parentRefId) : null;
    if (parent) visit(parent);
    ordered.push(asset);
  };

  assets.forEach(visit);
  return ordered;
}

// Build the export manifest + the list of files to copy for a single project.
// Returns { manifest, files } where files is [{ source: absPath, dest: relPathInBundle }].
export async function buildProjectExport(projectId, { appVersion = '' } = {}) {
  const db = await getDb();
  const project = await get(db, 'SELECT * FROM Projects WHERE id = ?', [Number(projectId)]);
  if (!project) {
    throw new Error('Project not found');
  }

  // `mode` drives which UI the project opens in, but a project's asset↔project
  // association always lives in Cards_Assets (graph projects keep backing
  // "Images" cards per node asset). So we always export cards + card links, and
  // additionally export nodes + connections for graph projects.
  const mode = String(project.preset || '').toLowerCase() === 'graph' ? 'graph' : 'kanban';
  const seedAssetIds = new Set();

  // Graph node-cards (Cards with a nodeTypeId). Each carries its single asset in
  // Cards_Assets, resolved here into a plain `assetId` for the manifest.
  const nodes = await all(
    db,
    `SELECT c.id, c.name, c.xPos, c.yPos, c.status, c.progress, c.metadata, nt.name AS nodeTypeName,
            (SELECT ca.assetId FROM Cards_Assets ca WHERE ca.cardId = c.id ORDER BY ca.position ASC LIMIT 1) AS assetId
     FROM Cards c JOIN NodeTypes nt ON nt.id = c.nodeTypeId
     WHERE c.projectId = ? AND c.nodeTypeId IS NOT NULL
     ORDER BY c.id ASC`,
    [project.id]
  );
  nodes.forEach(node => {
    if (node.assetId != null) seedAssetIds.add(node.assetId);
    collectAssetIdsFromValue(parseJson(node.metadata, {}), seedAssetIds);
  });

  let connections = [];
  const nodeIds = nodes.map(node => node.id);
  if (nodeIds.length) {
    const placeholders = nodeIds.map(() => '?').join(', ');
    connections = await all(
      db,
      `SELECT sourceCardId AS sourceNodeId, targetCardId AS targetNodeId, inputId, outputId
       FROM Connections
       WHERE sourceCardId IN (${placeholders}) AND targetCardId IN (${placeholders})`,
      [...nodeIds, ...nodeIds]
    );
  }

  // Kanban / backing cards only (node-cards are exported as `nodes` above).
  const cards = await all(
    db,
    `SELECT c.*, kc.name AS columnName
     FROM Cards c JOIN Columns kc ON kc.id = c.kanbanColumnId
     WHERE c.projectId = ? AND c.nodeTypeId IS NULL
     ORDER BY c.kanbanColumnId ASC, c.position ASC`,
    [project.id]
  );
  cards.forEach(card => collectAssetIdsFromValue(parseJson(card.metadata, {}), seedAssetIds));

  const cardAssetRows = await all(
    db,
    `SELECT DISTINCT ca.assetId AS assetId
     FROM Cards_Assets ca JOIN Cards c ON c.id = ca.cardId
     WHERE c.projectId = ?`,
    [project.id]
  );
  cardAssetRows.forEach(row => seedAssetIds.add(row.assetId));

  // Expand the seed set: include every ancestor (up the parentId chain) and
  // every descendant so the full version/edit tree travels with the project.
  const collectedIds = new Set();
  const pending = [...seedAssetIds].filter(id => Number.isFinite(Number(id)));

  // Walk up to roots first.
  const withAncestors = new Set();
  for (const id of pending) {
    let current = Number(id);
    let guard = 0;
    while (Number.isFinite(current) && !withAncestors.has(current) && guard < 1000) {
      withAncestors.add(current);
      guard += 1;
      const row = await get(db, 'SELECT parentId FROM Assets WHERE id = ?', [current]);
      current = row && row.parentId != null ? Number(row.parentId) : NaN;
    }
  }

  // Then walk down to collect all descendants.
  let frontier = [...withAncestors];
  frontier.forEach(id => collectedIds.add(id));
  while (frontier.length) {
    const placeholders = frontier.map(() => '?').join(', ');
    const children = await all(
      db,
      `SELECT id FROM Assets WHERE parentId IN (${placeholders})`,
      frontier
    );
    frontier = [];
    for (const child of children) {
      if (!collectedIds.has(child.id)) {
        collectedIds.add(child.id);
        frontier.push(child.id);
      }
    }
  }

  const files = [];
  const seenDest = new Set();
  const addFile = (source, dest) => {
    if (!source || !dest || seenDest.has(dest)) return;
    seenDest.add(dest);
    files.push({ source, dest });
  };

  const assets = [];
  for (const assetId of collectedIds) {
    const row = await get(
      db,
      `SELECT a.*, at.name AS typeName FROM Assets a JOIN AssetTypes at ON at.id = a.assetTypeId WHERE a.id = ?`,
      [assetId]
    );
    if (!row || !row.filePath) continue;

    const subdir = assetSubdirForTypeName(row.typeName);
    const fileBase = path.basename(row.filePath);
    const relPath = `assets/${subdir}/${fileBase}`;
    addFile(toAbsoluteStoragePath(row.filePath), relPath);

    let thumbnailRelPath = null;
    if (row.thumbnail) {
      const thumbBase = path.basename(row.thumbnail);
      thumbnailRelPath = `assets/thumbnails/${thumbBase}`;
      addFile(toAbsoluteStoragePath(row.thumbnail), thumbnailRelPath);
    }

    // Paint document (base + layer textures live under paintdocs/<assetId>/).
    let paintDoc = null;
    const doc = await getPaintDocumentByAssetId(assetId);
    if (doc) {
      const paintRel = (storedPath) => {
        if (!storedPath) return null;
        const rel = `assets/paintdocs/${row.id}/${path.basename(storedPath)}`;
        addFile(toAbsoluteStoragePath(storedPath), rel);
        return rel;
      };
      paintDoc = {
        baseRelPath: paintRel(doc.baseFilePath),
        textureWidth: doc.textureWidth || 0,
        textureHeight: doc.textureHeight || 0,
        layers: (doc.layers || []).map(layer => ({
          id: layer.id,
          name: layer.name || '',
          opacity: Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1,
          blendMode: layer.blendMode || 'source-over',
          color: layer.color || '#ffffff',
          visible: layer.visible !== false,
          relPath: paintRel(layer.filePath)
        }))
      };
    }

    // Workflow config sidecar (parameters/outputs for workflow assets).
    let workflowConfig = null;
    const wc = await get(db, 'SELECT parametersJson, outputsJson FROM WorkflowConfigs WHERE assetId = ?', [assetId]);
    if (wc) {
      workflowConfig = {
        parameters: parseJson(wc.parametersJson, []),
        outputs: parseJson(wc.outputsJson, [])
      };
    }

    assets.push({
      refId: row.id,
      name: row.name,
      typeName: row.typeName,
      subdir,
      relPath,
      thumbnailRelPath,
      originalFilePath: String(row.filePath || '').replace(/\\/g, '/'),
      width: row.width || 0,
      height: row.height || 0,
      metadata: parseJson(row.metadata, {}),
      parentRefId: row.parentId != null ? Number(row.parentId) : null,
      paintDoc,
      workflowConfig
    });
  }

  const manifest = {
    schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
    app: '3DGenStudio',
    appVersion: String(appVersion || ''),
    project: {
      name: project.name,
      description: project.description || '',
      preset: project.preset || '',
      status: project.status || 'active'
    },
    mode,
    assets,
    cards: cards.map(card => ({
      refKey: card.id,
      columnName: card.columnName,
      name: card.name,
      position: card.position,
      status: card.status,
      progress: card.progress,
      metadata: parseJson(card.metadata, {}),
      assetRefIds: [], // filled below
      attributes: []   // filled below
    })),
    nodes: nodes.map(node => ({
      refId: node.id,
      nodeTypeName: node.nodeTypeName,
      name: node.name,
      xPos: node.xPos,
      yPos: node.yPos,
      assetRefId: node.assetId != null ? Number(node.assetId) : null,
      status: node.status,
      progress: node.progress,
      metadata: parseJson(node.metadata, {})
    })),
    connections: connections.map(conn => ({
      sourceRefId: conn.sourceNodeId,
      targetRefId: conn.targetNodeId,
      inputId: conn.inputId,
      outputId: conn.outputId
    }))
  };

  // Fill in each card's asset links + attributes.
  for (const card of manifest.cards) {
    const assetRows = await all(
      db,
      'SELECT assetId, position FROM Cards_Assets WHERE cardId = ? ORDER BY position ASC',
      [card.refKey]
    );
    card.assetRefIds = assetRows
      .filter(r => collectedIds.has(r.assetId))
      .map(r => ({ assetRefId: r.assetId, position: r.position }));

    const attrRows = await all(
      db,
      `SELECT ca.position, ca.attributeValue, a.name AS typeName
       FROM Cards_Attributes ca JOIN Attributes a ON a.id = ca.attributeTypeId
       WHERE ca.cardId = ? ORDER BY ca.position ASC`,
      [card.refKey]
    );
    card.attributes = attrRows.map(r => ({
      position: r.position,
      typeName: r.typeName,
      value: r.attributeValue
    }));
  }

  return { manifest, files };
}

// Replace `asset:<id>` and `edit:<filePath>` references inside a parsed
// metadata value using the maps built during import. Unknown references are
// left untouched so partial bundles degrade gracefully.
function remapReferencesDeep(value, assetIdMap, editPathMap) {
  if (typeof value === 'string') {
    const assetMatch = value.match(/^asset:(\d+)$/);
    if (assetMatch) {
      const mapped = assetIdMap.get(Number(assetMatch[1]));
      return mapped != null ? `asset:${mapped}` : value;
    }
    const editMatch = value.match(/^edit:([\s\S]+)$/);
    if (editMatch) {
      const key = editMatch[1].replace(/\\/g, '/');
      const mapped = editPathMap.get(key);
      return mapped ? `edit:${mapped}` : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => remapReferencesDeep(item, assetIdMap, editPathMap));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = remapReferencesDeep(item, assetIdMap, editPathMap);
    }
    return out;
  }
  return value;
}

// Workflows are per-user library items and are never exported, so an imported
// project must not carry the exporter's workflow references or live run state.
// This strips the transient `processing` block and nulls any `workflowId`
// (a plain number that would otherwise point at an unrelated local asset id)
// while leaving informational history like `lastActionParams`/`workflowName`.
// Returns the cleaned value and whether a `processing` block was removed.
function stripWorkflowState(value) {
  let removedProcessing = false;

  const walk = (val) => {
    if (Array.isArray(val)) {
      return val.map(walk);
    }
    if (val && typeof val === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(val)) {
        if (key === 'processing') {
          removedProcessing = true;
          continue;
        }
        if (key === 'workflowId') {
          out[key] = null;
          continue;
        }
        out[key] = walk(item);
      }
      return out;
    }
    return val;
  };

  return { cleaned: walk(value), removedProcessing };
}

// Allocate a Projects.id that isn't already taken (ids are Date.now()-based).
async function allocateProjectId(db) {
  let candidate = Date.now();
  while (await get(db, 'SELECT 1 FROM Projects WHERE id = ?', [candidate])) {
    candidate += 1;
  }
  return candidate;
}

let importFilenameCounter = 0;
function makeUniqueAssetFilename(originalBasename) {
  importFilenameCounter += 1;
  const safe = String(originalBasename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `imp-${Date.now()}-${importFilenameCounter}-${safe}`;
}

// Recreate a project from a parsed .3dgp manifest + the folder that holds its
// asset files. Runs in a single transaction; everything rolls back on error.
export async function importProjectExport(manifest, bundleDir, { name } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('The .3dgp file is empty or invalid.');
  }
  if (Number(manifest.schemaVersion) !== PROJECT_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported .3dgp version: ${manifest.schemaVersion}`);
  }

  const db = await getDb();
  const proj = manifest.project || {};
  const projectName = String(name || proj.name || 'Imported Project').trim() || 'Imported Project';

  await exec(db, 'BEGIN');
  try {
    const newProjectId = await allocateProjectId(db);
    const createdAt = Date.now();
    await run(
      db,
      'INSERT INTO Projects (id, name, description, preset, creationDate, status) VALUES (?, ?, ?, ?, ?, ?)',
      [newProjectId, projectName, proj.description || '', proj.preset || '', createdAt, proj.status || 'active']
    );

    const assetIdMap = new Map();   // original refId -> new asset id
    const editPathMap = new Map();  // original stored filePath -> new stored filePath
    const insertedAssets = [];      // { newId, metadata } for the post-remap pass

    // --- Phase A: copy files + insert asset rows (raw metadata) ---
    const orderedAssets = orderAssetsParentFirst(manifest.assets || []);
    for (const asset of orderedAssets) {
      const subdir = asset.subdir || assetSubdirForTypeName(asset.typeName);
      const source = path.join(bundleDir, asset.relPath || '');
      try {
        await fs.access(source);
      } catch {
        console.warn(`Skipping asset "${asset.name}" — missing bundle file: ${asset.relPath}`);
        continue;
      }

      const uniqueName = makeUniqueAssetFilename(path.basename(asset.relPath));
      const destDir = path.join(ASSETS_DIR, subdir);
      await fs.mkdir(destDir, { recursive: true });
      await fs.copyFile(source, path.join(destDir, uniqueName));
      const newStoredPath = `${DATA_ASSETS_PREFIX}${subdir}/${uniqueName}`;

      let thumbnailStored = null;
      if (asset.thumbnailRelPath) {
        const thumbSource = path.join(bundleDir, asset.thumbnailRelPath);
        try {
          await fs.access(thumbSource);
          const thumbName = makeUniqueAssetFilename(path.basename(asset.thumbnailRelPath));
          await fs.mkdir(THUMBNAIL_ASSETS_DIR, { recursive: true });
          await fs.copyFile(thumbSource, path.join(THUMBNAIL_ASSETS_DIR, thumbName));
          thumbnailStored = `${DATA_ASSETS_PREFIX}thumbnails/${thumbName}`;
        } catch {
          thumbnailStored = null;
        }
      }

      const parentNewId = asset.parentRefId != null ? (assetIdMap.get(asset.parentRefId) ?? null) : null;
      const assetTypeId = await getAssetTypeIdByName(asset.typeName);
      const result = await run(
        db,
        'INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail, width, height, parentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          asset.name || 'Asset',
          newStoredPath,
          assetTypeId,
          Date.now(),
          JSON.stringify(asset.metadata || {}),
          thumbnailStored,
          Number(asset.width) || 0,
          Number(asset.height) || 0,
          parentNewId
        ]
      );
      const newId = result.lastID;
      assetIdMap.set(asset.refId, newId);
      if (asset.originalFilePath) {
        editPathMap.set(String(asset.originalFilePath).replace(/\\/g, '/'), newStoredPath);
      }
      insertedAssets.push({ newId, metadata: asset.metadata || {} });

      // Paint document.
      if (asset.paintDoc) {
        const docDir = paintDocSubdirForAsset(newId);
        await fs.mkdir(docDir, { recursive: true });
        const copyPaintFile = async (relPath) => {
          if (!relPath) return null;
          const src = path.join(bundleDir, relPath);
          try {
            await fs.access(src);
          } catch {
            return null;
          }
          const base = path.basename(relPath);
          await fs.copyFile(src, path.join(docDir, base));
          return toStoredPaintDocPath(newId, base);
        };

        const baseFilePath = await copyPaintFile(asset.paintDoc.baseRelPath);
        const layers = [];
        for (const layer of asset.paintDoc.layers || []) {
          const filePath = await copyPaintFile(layer.relPath);
          if (!filePath) continue;
          layers.push({
            id: layer.id,
            name: layer.name || '',
            opacity: Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1,
            blendMode: layer.blendMode || 'source-over',
            color: layer.color || '#ffffff',
            visible: layer.visible !== false,
            filePath
          });
        }
        await run(
          db,
          `INSERT INTO PaintDocuments (assetId, baseFilePath, textureWidth, textureHeight, layersJson, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [newId, baseFilePath, asset.paintDoc.textureWidth || 0, asset.paintDoc.textureHeight || 0, JSON.stringify(layers), Date.now()]
        );
      }

      // Workflow config.
      if (asset.workflowConfig) {
        await run(
          db,
          'INSERT INTO WorkflowConfigs (assetId, parametersJson, outputsJson) VALUES (?, ?, ?)',
          [newId, JSON.stringify(asset.workflowConfig.parameters || []), JSON.stringify(asset.workflowConfig.outputs || [])]
        );
      }
    }

    // --- Phase B: maps are complete — remap asset metadata references ---
    for (const entry of insertedAssets) {
      const remapped = remapReferencesDeep(entry.metadata, assetIdMap, editPathMap);
      await run(db, 'UPDATE Assets SET metadata = ? WHERE id = ?', [JSON.stringify(remapped), entry.newId]);
    }

    // --- Phase C: recreate cards + Cards_Assets (the asset↔project links used
    // by the Assets page). Present for both presets: graph projects keep backing
    // cards per node asset, so this must run regardless of mode.
    {
      const columns = await all(db, 'SELECT id, name, position FROM Columns ORDER BY position ASC');
      const columnByName = new Map(columns.map(c => [c.name, c.id]));
      const fallbackColumnId = columns.length ? columns[0].id : null;

      for (const card of manifest.cards || []) {
        const columnId = columnByName.get(card.columnName) ?? fallbackColumnId;
        if (columnId == null) continue;
        const remapped = remapReferencesDeep(card.metadata || {}, assetIdMap, editPathMap);
        const { cleaned: metadata, removedProcessing } = stripWorkflowState(remapped);
        // A card whose live run state was stripped must not stay "processing".
        const cardStatus = removedProcessing ? null : (card.status ?? null);
        const cardProgress = removedProcessing ? null : (card.progress ?? null);
        const result = await run(
          db,
          `INSERT INTO Cards (projectId, kanbanColumnId, clientKey, name, position, creationDate, status, progress, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newProjectId,
            columnId,
            null,
            card.name ?? null,
            Number(card.position) || 0,
            Date.now(),
            cardStatus,
            cardProgress,
            JSON.stringify(metadata)
          ]
        );
        const newCardId = result.lastID;

        for (const link of card.assetRefIds || []) {
          const newAssetId = assetIdMap.get(link.assetRefId);
          if (newAssetId == null) continue;
          await run(
            db,
            'INSERT INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, ?)',
            [newCardId, newAssetId, Number(link.position) || 0]
          );
        }

        for (const attr of card.attributes || []) {
          let attributeTypeId = null;
          try {
            const attrRow = await get(db, 'SELECT id FROM Attributes WHERE name = ?', [attr.typeName]);
            attributeTypeId = attrRow ? attrRow.id : null;
          } catch {
            attributeTypeId = null;
          }
          if (attributeTypeId == null) continue;
          await run(
            db,
            'INSERT INTO Cards_Attributes (cardId, position, attributeTypeId, attributeValue) VALUES (?, ?, ?, ?)',
            [newCardId, Number(attr.position) || 0, attributeTypeId, attr.value ?? null]
          );
        }
      }
    }

    // --- Phase D: recreate graph node-cards + connections (empty for kanban).
    // A node is a Card with a nodeTypeId; its asset lives in Cards_Assets. ---
    {
      const nodeIdMap = new Map();
      for (const node of manifest.nodes || []) {
        const nodeTypeId = await getNodeTypeIdByName(node.nodeTypeName);
        const assetId = node.assetRefId != null ? (assetIdMap.get(node.assetRefId) ?? null) : null;
        const remapped = remapReferencesDeep(node.metadata || {}, assetIdMap, editPathMap);
        const { cleaned: metadata, removedProcessing } = stripWorkflowState(remapped);
        // A node whose live run state was stripped must not stay "processing".
        const nodeStatus = removedProcessing ? null : (node.status ?? null);
        const nodeProgress = removedProcessing ? null : (node.progress ?? null);
        const result = await run(
          db,
          `INSERT INTO Cards (projectId, kanbanColumnId, nodeTypeId, name, position, xPos, yPos, creationDate, status, progress, metadata)
           VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          [
            newProjectId,
            nodeTypeId,
            node.name ?? null,
            Number(node.xPos) || 0,
            Number(node.yPos) || 0,
            Date.now(),
            nodeStatus,
            nodeProgress,
            JSON.stringify(metadata)
          ]
        );
        const newCardId = result.lastID;
        nodeIdMap.set(node.refId, newCardId);
        if (assetId != null) {
          // Absorb any backing-card link Phase C created for the same asset
          // (older .3dgp bundles carry both nodes[] and backing cards[]).
          await setNodeCardAsset(db, newCardId, assetId);
        }
      }

      for (const conn of manifest.connections || []) {
        const sourceId = nodeIdMap.get(conn.sourceRefId);
        const targetId = nodeIdMap.get(conn.targetRefId);
        if (sourceId == null || targetId == null) continue;
        await run(
          db,
          `INSERT OR IGNORE INTO Connections (sourceCardId, targetCardId, inputId, outputId) VALUES (?, ?, ?, ?)`,
          [sourceId, targetId, conn.inputId, conn.outputId]
        );
      }
    }

    await exec(db, 'COMMIT');
    return mapProjectRow(await get(db, 'SELECT * FROM Projects WHERE id = ?', [newProjectId]));
  } catch (err) {
    try {
      await exec(db, 'ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to roll back project import:', rollbackErr);
    }
    throw err;
  }
}
