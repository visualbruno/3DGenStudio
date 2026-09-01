import path from 'path';
import process from 'process';
import fs from 'fs/promises';
// The SQL engine lives behind db/index.js: SQLite for a desktop install,
// PostgreSQL when GENSTUDIO_DATABASE_URL is set for a shared server. Every
// query below is written once and runs on both -- see db/postgres.js for the
// three translations that make that true.
import {
  openDatabase,
  closeDatabase,
  run,
  get,
  all,
  exec,
  tableExists,
  columnExists,
  withTransaction,
  withKeyLock,
  isUniqueViolation,
  selectedDialect
} from './db/index.js';

// Re-exported so server.js can report which engine is in use without importing
// the db layer itself: storage.js stays the single door onto the database.
export { selectedDialect };

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
// Generated motion clips (Kimodo), as BVH text. Not under a project — see the
// Motions table for why.
export const MOTION_ASSETS_DIR = path.join(ASSETS_DIR, 'motions');

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
  { id: 7, name: 'Image Compare' },
  { id: 8, name: 'Rig Mesh' }
];

export const DEFAULT_SETTINGS = {
  profile: {
    name: 'User',
    avatar: null
  },
  initialSetupComplete: false,
  create: {
    mode: 'advanced',
    autoRun: false,
    defaults: {
      templateId: null,
      imageEngineId: null,
      meshEngineId: null,
      cutoutEngine: 'auto',
      views: 'turntable',
      cleanEngine: 'auto',
      refineEngine: 'off',
      textureEngine: 'auto',
      rig: 'auto'
    }
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
      // Optional override for where models live, when it's not "{path}/models"
      // (e.g. models are shared across ComfyUI installs via extra_model_paths.yaml).
      modelsPath: '',
      url: 'http://127.0.0.1',
      port: '8188',
      // Desktop app: true when this ComfyUI was installed BY the app (into the
      // per-user data dir) and is therefore ours to start, stop and upgrade.
      // False/absent means the user runs their own — the app only talks to it.
      managed: false,
      // Desktop app: start the managed ComfyUI at launch. Default off — it is a
      // heavy process and most sessions start on demand instead.
      autoStart: false
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
    motiontools: {
      url: 'http://127.0.0.1',
      port: '8400',
      // Where the motion service keeps the weights it downloads: the 1.1 GB
      // Kimodo checkpoint and the ~16 GB Llama-3 text-encoder base. Empty means
      // the default folder inside the app's data dir (desktop) or
      // thirdparty/kimodo/checkpoints (running from source). Set it to move 17 GB
      // onto a drive that has room for it.
      modelsPath: '',
      // Desktop app: start the motion service at launch. Default off — the text
      // encoder alone is ~16 GB of RAM once a prompt has been encoded.
      autoStart: false
    },
    mocaptools: {
      url: 'http://127.0.0.1',
      port: '8401',
      // Where the video-to-motion service keeps its ~460 MB checkpoint. Empty
      // means the default folder inside the app's data dir (desktop) or
      // thirdparty/mocapanything/MocapAnything/checkpoints (from source).
      modelsPath: '',
      // Desktop app: start the video-to-motion service at launch. Default off —
      // a capture peaks around 10 GB of VRAM, which would sit next to rigging.
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

// Normalises a viewer id into "filter, or don't".
//
// Callers pass null for the two cases that see everything: a desktop install
// (no accounts exist) and an administrator. Everyone else gets their own rows
// plus the unowned ones. Keeping the decision here means a listing cannot
// accidentally forget the NULL case and hide legacy data.
export function ownerScope(viewerId) {
  const id = Number(viewerId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// SQL fragment + params for scoping a query, so the filter is written once.
function ownerFilter(viewerId, column) {
  const id = ownerScope(viewerId);
  return id === null
    ? { clause: '', params: [] }
    : { clause: ` AND (${column} IS NULL OR ${column} = ?)`, params: [id] };
}

function mapProjectRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    preset: row.preset || '',
    createdAt: row.creationDate,
    status: row.status || 'active',
    graphViewport: parseJson(row.graphViewport, null),
    ownerId: row.ownerId ?? null,
    // Joined in so the Projects page can label a card without a second request
    // per project. Null for unowned projects and on desktop installs.
    ownerName: row.ownerName || null
  };
}

function mapChildAssetRow(row) {
  const metadata = parseJson(row.metadata, {});
  const thumbnail = row.thumbnail ? toAssetUrlPath(row.thumbnail) : null;

  return {
    id: row.id,
    parentId: row.parentId ?? null,
    parentProjectId: row.parentProjectId ?? null,
    projectIds: Array.isArray(row.projectIds) ? row.projectIds : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
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
    projectId: row.projectId ?? null,
    // Every project this asset is linked to (Assets_Projects is many-to-many);
    // `projectId` above is just the one this view was resolved for.
    projectIds: Array.isArray(row.projectIds)
      ? row.projectIds
      : (row.projectId != null ? [row.projectId] : []),
    parentId: row.parentId ?? null,
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

// One-time backfill for databases created before Assets_Projects existed:
// project membership used to be derived as Assets -> Cards_Assets -> Cards.projectId,
// and child assets (image edits / mesh versions) had no link of their own — they
// inherited their root's project implicitly. Reproduce both here so nothing that
// was visible in a project before the upgrade disappears after it.
async function backfillAssetProjectLinks(db) {
  await run(
    db,
    `INSERT INTO Assets_Projects (assetId, projectId, addedAt)
     SELECT DISTINCT ca.assetId, c.projectId, COALESCE(a.creationDate, 0)
     FROM Cards_Assets ca
     JOIN Cards c ON c.id = ca.cardId
     JOIN Assets a ON a.id = ca.assetId
     WHERE c.projectId IS NOT NULL
     ON CONFLICT DO NOTHING`
  );

  // Propagate every link down the full parentId tree, so edits/versions land in
  // the same project(s) their root was in. Done level by level rather than with a
  // recursive CTE: the seed set is the very table being inserted into, and
  // reading a table while writing it is exactly the case a plain loop makes safe.
  let inserted = 0;
  let guard = 0;
  do {
    const result = await run(
      db,
      `INSERT INTO Assets_Projects (assetId, projectId, addedAt)
       SELECT child.id, ap.projectId, COALESCE(child.creationDate, 0)
       FROM Assets child
       JOIN Assets_Projects ap ON ap.assetId = child.parentId
       WHERE child.parentId IS NOT NULL
       ON CONFLICT DO NOTHING`
    );
    inserted = result?.changes ?? 0;
    guard += 1;
  } while (inserted > 0 && guard < 100);

  const linked = await get(db, 'SELECT COUNT(*) AS total FROM Assets_Projects');
  console.log(`Assets_Projects backfill complete: ${linked?.total ?? 0} asset/project links.`);

  // The "board-assets" container cards existed only to carry Cards_Assets rows
  // for assets that must belong to a project without appearing on the Kanban
  // board. Their links have just been copied into Assets_Projects, so the cards
  // themselves are now dead weight — drop them (Cards_Assets cascades).
  const removed = await run(
    db,
    `DELETE FROM Cards
     WHERE clientKey = 'board-assets'
       AND kanbanColumnId IS NULL
       AND nodeTypeId IS NULL`
  );
  if (removed?.changes) {
    console.log(`Removed ${removed.changes} legacy detached container card(s).`);
  }
}

// --- Asset <-> project membership -------------------------------------------
// Every write that makes an asset part of a project funnels through these, so
// Assets_Projects can never drift from what the rest of the code believes.

async function linkAssetToProject(db, assetId, projectId, { cascadeChildren = false } = {}) {
  const normalizedAssetId = Number(assetId);
  const normalizedProjectId = Number(projectId);

  if (!Number.isFinite(normalizedAssetId) || !Number.isFinite(normalizedProjectId)) {
    return;
  }

  await run(
    db,
    'INSERT INTO Assets_Projects (assetId, projectId, addedAt) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [normalizedAssetId, normalizedProjectId, Date.now()]
  );

  if (!cascadeChildren) return;

  const children = await all(db, 'SELECT id FROM Assets WHERE parentId = ?', [normalizedAssetId]);
  for (const child of children) {
    await linkAssetToProject(db, child.id, normalizedProjectId, { cascadeChildren: true });
  }
}

async function unlinkAssetFromProject(db, assetId, projectId, { cascadeChildren = true } = {}) {
  const normalizedAssetId = Number(assetId);
  const normalizedProjectId = Number(projectId);

  if (!Number.isFinite(normalizedAssetId) || !Number.isFinite(normalizedProjectId)) {
    return;
  }

  await run(
    db,
    'DELETE FROM Assets_Projects WHERE assetId = ? AND projectId = ?',
    [normalizedAssetId, normalizedProjectId]
  );

  if (!cascadeChildren) return;

  const children = await all(db, 'SELECT id FROM Assets WHERE parentId = ?', [normalizedAssetId]);
  for (const child of children) {
    await unlinkAssetFromProject(db, child.id, normalizedProjectId, { cascadeChildren: true });
  }
}

// Copy every project a source asset belongs to onto a freshly created child, so
// a new edit/version is immediately part of the same project(s) as its parent.
async function inheritProjectLinks(db, fromAssetId, toAssetId) {
  await run(
    db,
    `INSERT INTO Assets_Projects (assetId, projectId, addedAt)
     SELECT ?, projectId, ? FROM Assets_Projects WHERE assetId = ?
     ON CONFLICT DO NOTHING`,
    [Number(toAssetId), Date.now(), Number(fromAssetId)]
  );
}

export async function listAssetProjectIds(assetId) {
  const db = await getDb();
  const rows = await all(
    db,
    'SELECT projectId FROM Assets_Projects WHERE assetId = ? ORDER BY projectId ASC',
    [Number(assetId)]
  );

  return rows.map(row => row.projectId);
}

// Batch variant used by the listings: assetId -> [projectId, …].
async function listProjectIdsByAssetIds(db, assetIds = []) {
  const uniqueIds = [...new Set(assetIds.map(Number).filter(Number.isFinite))];
  const byAssetId = new Map();

  if (uniqueIds.length === 0) {
    return byAssetId;
  }

  const rows = await all(
    db,
    `SELECT assetId, projectId FROM Assets_Projects
     WHERE assetId IN (${uniqueIds.map(() => '?').join(', ')})
     ORDER BY projectId ASC`,
    uniqueIds
  );

  for (const row of rows) {
    if (!byAssetId.has(row.assetId)) {
      byAssetId.set(row.assetId, []);
    }
    byAssetId.get(row.assetId).push(row.projectId);
  }

  return byAssetId;
}

export async function isAssetInProject(projectId, assetId) {
  const db = await getDb();
  const row = await get(
    db,
    'SELECT 1 FROM Assets_Projects WHERE assetId = ? AND projectId = ? LIMIT 1',
    [Number(assetId), Number(projectId)]
  );

  return Boolean(row);
}

// Attach an EXISTING asset (root, edit or version) to a project without going
// through a card. This is the operation the old model could not express.
export async function linkExistingAssetToProject(projectId, assetId, { cascadeChildren = false } = {}) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const asset = await getAssetRecordById(assetId);

  if (!asset) {
    throw new Error('Asset not found');
  }

  const db = await getDb();
  await linkAssetToProject(db, asset.id, normalizedProjectId, { cascadeChildren });

  return await getAssetViewById(asset.id, { projectId: normalizedProjectId });
}

export async function unlinkAssetFromProjectById(projectId, assetId, { cascadeChildren = true } = {}) {
  const normalizedProjectId = Number(projectId);
  const asset = await getAssetRecordById(assetId);

  if (!asset) {
    return { status: 'not-found' };
  }

  const db = await getDb();
  await unlinkAssetFromProject(db, asset.id, normalizedProjectId, { cascadeChildren });

  // Placement follows membership: an asset that is no longer part of the project
  // must not stay on one of its cards/nodes either.
  const links = await all(
    db,
    `SELECT ca.cardId
     FROM Cards_Assets ca JOIN Cards c ON c.id = ca.cardId
     WHERE ca.assetId = ? AND c.projectId = ?`,
    [asset.id, normalizedProjectId]
  );

  if (links.length > 0) {
    await run(
      db,
      `DELETE FROM Cards_Assets
       WHERE assetId = ? AND cardId IN (${links.map(() => '?').join(', ')})`,
      [asset.id, ...links.map(link => link.cardId)]
    );

    for (const link of links) {
      await normalizeCardAssetPositions(db, link.cardId);
    }

    await deleteCardsIfEmpty(db, links.map(link => link.cardId));
  }

  return { status: 'unlinked', remainingProjectIds: await listAssetProjectIds(asset.id) };
}

// ---------------------------------------------------------------------------
// Asset tags (Assets_Tags)
// ---------------------------------------------------------------------------

// Longest tag we store. Long enough for "hand painted stylized", short enough
// that a tag stays a label and never becomes a description.
const MAX_TAG_LENGTH = 48;
// Per-asset ceiling, so a runaway caller cannot bury an asset under hundreds of
// tags and make the library filter useless.
const MAX_TAGS_PER_ASSET = 50;

// Tags are compared and stored in one canonical form: trimmed, inner whitespace
// collapsed, lower-cased. Without this "Sci-Fi", "sci-fi " and "sci  fi" would
// all be distinct primary keys and the tag list would fill with near-duplicates.
export function normalizeTagValue(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return text.slice(0, MAX_TAG_LENGTH).trim();
}

// Normalize a whole list, dropping empties and duplicates while preserving the
// order the caller gave (first occurrence wins), then cap it.
export function normalizeTagList(values = []) {
  const seen = new Set();
  const tags = [];

  for (const value of Array.isArray(values) ? values : [values]) {
    const tag = normalizeTagValue(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS_PER_ASSET) break;
  }

  return tags;
}

// Batch variant used by the listings: assetId -> [tag, …].
async function listTagsByAssetIds(db, assetIds = []) {
  const uniqueIds = [...new Set(assetIds.map(Number).filter(Number.isFinite))];
  const byAssetId = new Map();

  if (uniqueIds.length === 0) {
    return byAssetId;
  }

  const rows = await all(
    db,
    `SELECT assetId, tag FROM Assets_Tags
     WHERE assetId IN (${uniqueIds.map(() => '?').join(', ')})
     ORDER BY tag ASC`,
    uniqueIds
  );

  for (const row of rows) {
    if (!byAssetId.has(row.assetId)) {
      byAssetId.set(row.assetId, []);
    }
    byAssetId.get(row.assetId).push(row.tag);
  }

  return byAssetId;
}

export async function listAssetTags(assetId) {
  const db = await getDb();
  const rows = await all(
    db,
    'SELECT tag FROM Assets_Tags WHERE assetId = ? ORDER BY tag ASC',
    [Number(assetId)]
  );

  return rows.map(row => row.tag);
}

// Replace an asset's whole tag set. The UI edits tags as a list, so a single
// "here is the new set" call keeps add/remove/reorder from needing three routes.
export async function setAssetTags(assetId, tags = []) {
  const asset = await getAssetRecordById(assetId);

  if (!asset) {
    return { status: 'not-found' };
  }

  const db = await getDb();
  const normalized = normalizeTagList(tags);
  const addedAt = Date.now();

  await run(db, 'DELETE FROM Assets_Tags WHERE assetId = ?', [asset.id]);

  for (const tag of normalized) {
    await run(
      db,
      'INSERT INTO Assets_Tags (assetId, tag, addedAt) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [asset.id, tag, addedAt]
    );
  }

  return { status: 'ok', assetId: asset.id, tags: normalized };
}

// Add without disturbing what is already there (used by importers/automation
// that only know the tags they want to contribute).
export async function addAssetTags(assetId, tags = []) {
  const asset = await getAssetRecordById(assetId);

  if (!asset) {
    return { status: 'not-found' };
  }

  const db = await getDb();
  const addedAt = Date.now();

  for (const tag of normalizeTagList(tags)) {
    await run(
      db,
      'INSERT INTO Assets_Tags (assetId, tag, addedAt) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [asset.id, tag, addedAt]
    );
  }

  return { status: 'ok', assetId: asset.id, tags: await listAssetTags(asset.id) };
}

export async function removeAssetTag(assetId, tag) {
  const db = await getDb();
  await run(
    db,
    'DELETE FROM Assets_Tags WHERE assetId = ? AND tag = ?',
    [Number(assetId), normalizeTagValue(tag)]
  );

  return { status: 'ok', tags: await listAssetTags(assetId) };
}

// The whole known vocabulary with usage counts, for the filter dropdown and the
// tag-input suggestions. Optionally scoped to one asset type so the Images
// section never suggests a tag that only meshes use.
export async function listAllAssetTags({ type = null, viewerId = null } = {}) {
  const db = await getDb();
  const params = [];
  const scope = ownerFilter(viewerId, 'a.ownerId');

  // The Assets join is unconditional once a scope is in play: without it the
  // vocabulary would list tag names taken from other users' assets, which is a
  // small leak but still a leak.
  const needsAssetJoin = Boolean(type) || scope.clause !== '';
  const joinClause = needsAssetJoin
    ? `JOIN Assets a ON a.id = t.assetId
       JOIN AssetTypes at ON at.id = a.assetTypeId
       `
    : '';

  const conditions = [];
  if (type) {
    conditions.push('at.name = ?');
    params.push(normalizeAssetTypeName(type));
  }
  if (scope.clause) {
    // ownerFilter returns a leading " AND ..."; this is the first condition
    // when there is no type filter, so strip it and let the join do the rest.
    conditions.push(scope.clause.replace(/^ AND /, ''));
    params.push(...scope.params);
  }

  const rows = await all(
    db,
    `SELECT t.tag AS tag, COUNT(*) AS count
     FROM Assets_Tags t
     ${joinClause}${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     GROUP BY t.tag
     ORDER BY count DESC, t.tag ASC`,
    params
  );

  return rows.map(row => ({ tag: row.tag, count: row.count }));
}

// Tag search: every asset carrying the wanted tags, newest first. `matchAll`
// mirrors the Assets page filter (an asset must carry EVERY selected tag);
// pass false for a union search ("anything sci-fi or fantasy"). `type` and
// `projectId` narrow the same way the page's sections and project filter do.
export async function findAssetsByTags(tags = [], { matchAll = true, type = null, projectId = null, limit = 200, viewerId = null } = {}) {
  const wantedTags = normalizeTagList(tags);

  if (wantedTags.length === 0) {
    return [];
  }

  const db = await getDb();
  const params = [...wantedTags];
  let whereClause = `WHERE t.tag IN (${wantedTags.map(() => '?').join(', ')})`;

  if (type) {
    whereClause += ' AND at.name = ?';
    params.push(normalizeAssetTypeName(type));
  }

  if (projectId !== null && projectId !== undefined) {
    whereClause += ` AND EXISTS (
         SELECT 1 FROM Assets_Projects ap
         WHERE ap.assetId = a.id AND ap.projectId = ?
       )`;
    params.push(Number(projectId));
  }

  const tagScope = ownerFilter(viewerId, 'a.ownerId');
  whereClause += tagScope.clause;
  params.push(...tagScope.params);

  // Count the DISTINCT matched tags per asset so "match all" is a HAVING check
  // rather than N queries intersected in JS.
  const havingClause = matchAll ? 'HAVING COUNT(DISTINCT t.tag) = ?' : '';
  if (matchAll) {
    params.push(wantedTags.length);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  params.push(safeLimit);

  const rows = await all(
    db,
    `SELECT a.id, a.parentId, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            a.width, a.height,
            at.name AS assetTypeName
     FROM Assets_Tags t
     JOIN Assets a ON a.id = t.assetId
     JOIN AssetTypes at ON at.id = a.assetTypeId
     ${whereClause}
     GROUP BY a.id
     ${havingClause}
     ORDER BY a.creationDate DESC, a.id DESC
     LIMIT ?`,
    params
  );

  const projectIdsByAssetId = await listProjectIdsByAssetIds(db, rows.map(row => row.id));
  const tagsByAssetId = await listTagsByAssetIds(db, rows.map(row => row.id));

  return rows.map(row => {
    const assetTags = tagsByAssetId.get(row.id) || [];

    return {
      ...mapAssetRow({
        ...row,
        projectIds: projectIdsByAssetId.get(row.id) || []
      }),
      tags: assetTags,
      // Which of the searched tags this asset actually carries — useful when
      // matchAll is off and the caller wants to rank the union result.
      matchedTags: wantedTags.filter(tag => assetTags.includes(tag)),
      // A child asset (image edit / mesh version) is tagged independently of its
      // root, so say which one this is instead of making the caller infer it.
      isChild: row.parentId != null
    };
  });
}

function groupChildAssetsByParentFilePath(rows = [], baseUrl = null) {
  return rows.reduce((accumulator, row) => {
    if (!accumulator[row.parentFilePath]) {
      accumulator[row.parentFilePath] = [];
    }

    const childAsset = mapChildAssetRow(row);
    // Nullish, not truthy: an EMPTY baseUrl is a real value meaning "mint
    // relative URLs", which is what getRequestBaseUrl() returns for a request
    // arriving through a local gateway. Treating '' as "no base" left every
    // edit and version with no url at all — a broken <img> for image edits and
    // a placeholder tile for mesh versions.
    const childWithUrl = baseUrl != null
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

  const rows = await all(
    db,
    `SELECT child.id, child.parentId, child.name, child.filePath, child.creationDate, child.metadata, child.thumbnail,
            child.width, child.height,
            parent.filePath AS parentFilePath,
            (
              SELECT ap.projectId
              FROM Assets_Projects ap
              WHERE ap.assetId = parent.id
              ORDER BY ap.addedAt DESC NULLS LAST, ap.projectId DESC NULLS LAST
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

  // A child carries its own project links now, so the Assets page can group and
  // filter an edit/version by the project it was attached to — not only by the
  // project its root happens to sit in.
  const projectIdsByAssetId = await listProjectIdsByAssetIds(db, rows.map(row => row.id));
  const tagsByAssetId = await listTagsByAssetIds(db, rows.map(row => row.id));

  return rows.map(row => ({
    ...row,
    projectIds: projectIdsByAssetId.get(row.id) || [],
    tags: tagsByAssetId.get(row.id) || []
  }));
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
    'INSERT INTO Settings (id, json) VALUES (1, ?) ON CONFLICT DO NOTHING',
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

  const probe = await openDatabase({ file: DB_FILE });
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
        await run(db, 'INSERT INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, 0) ON CONFLICT DO NOTHING', [newCardId, node.assetId]);
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
        'INSERT INTO Connections (sourceCardId, targetCardId, inputId, outputId) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
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

// The SQLite schema, and the source of truth for both engines: PostgreSQL runs
// db/schema.pg.sql, which tools/gen-pg-schema.mjs generates from exactly this
// text. Regenerate after changing anything here, or the two engines drift and
// the difference only shows up on whichever deployment nobody tested.
const SQLITE_SCHEMA = `
    -- ownerId on Projects and Assets: on a shared server everything belongs to
    -- the user who made it, and nobody sees anyone else's -- administrators
    -- excepted, who see everything.
    --
    -- NULL means unowned and stays visible to everyone. That covers every row on
    -- a single-user desktop install (no accounts exist to own anything, and the
    -- behaviour there must be exactly as before) and any row written before
    -- ownership existed.
    CREATE TABLE IF NOT EXISTS Projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      preset TEXT,
      creationDate INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      ownerId INTEGER
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
      -- Who created or imported this. See Projects.ownerId for the full rules;
      -- an edit or version inherits its parent's owner so a chain never splits
      -- between two libraries.
      ownerId INTEGER,
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
      -- Which user imported this workflow. A workflow is written against one
      -- person's ComfyUI -- their models, their node packs -- so on a shared
      -- server everyone gets their own library rather than one global set that
      -- the next import replaces.
      --
      -- NULL means unowned, and stays visible to everyone. That is every
      -- workflow on a single-user desktop install, where there are no accounts
      -- to own anything and the behaviour must be exactly as before.
      ownerId INTEGER,
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );

    -- Multi-user server mode. Absent/empty in a single-user desktop install,
    -- where no authentication is applied at all. passwordHash is a self-describing
    -- scrypt string (see auth.js) so the cost parameters can be raised later
    -- without invalidating existing rows. login is compared case-insensitively
    -- via COLLATE NOCASE so "Bruno" and "bruno" cannot both be registered.
    CREATE TABLE IF NOT EXISTS Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      displayName TEXT,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      avatar TEXT,
      createdAt INTEGER NOT NULL,
      lastLoginAt INTEGER,
      disabled INTEGER NOT NULL DEFAULT 0
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

    -- Batch Processing config. One per project (a "Batch" preset project holds a
    -- single batch definition, reached straight from the workspace). stateJson is
    -- the whole document: declared variables, the value groups that each become
    -- one iteration, and the ordered workflow stages with their parameter
    -- bindings. Results are not stored here — each one becomes a normal Card with
    -- its asset, exactly like a Kanban/Graph generation.
    CREATE TABLE IF NOT EXISTS BatchConfigs (
      projectId INTEGER PRIMARY KEY,
      stateJson TEXT NOT NULL DEFAULT '{}',
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY(projectId) REFERENCES Projects(id) ON DELETE CASCADE
    );

    -- Asset <-> project membership. THE source of truth for "which project does
    -- this asset belong to". Cards_Assets is now only about PLACEMENT (which
    -- kanban card / graph node displays the asset), never about ownership.
    -- Every asset gets its own row, children (image edits / mesh versions)
    -- included — membership is never inherited through parentId at read time,
    -- so an edit can be linked to a project its root does not belong to.
    CREATE TABLE IF NOT EXISTS Assets_Projects (
      assetId INTEGER NOT NULL,
      projectId INTEGER NOT NULL,
      addedAt INTEGER NOT NULL,
      PRIMARY KEY(assetId, projectId),
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE CASCADE,
      FOREIGN KEY(projectId) REFERENCES Projects(id) ON DELETE CASCADE
    );

    -- Generated motions (Mesh Editor -> Auto Rig -> Kimodo). The BVH itself is a
    -- few hundred KB of text and lives on disk under assets/motions; this table is
    -- the catalogue.
    --
    -- NOT project-scoped, deliberately. A motion is "a person throws a punch" —
    -- it describes a body, not a project's content, and the point of keeping it is
    -- to retarget it onto ANY rigged mesh later. Same reasoning as the bundled
    -- mesh2motion reference clips, which are also global.
    --
    -- Why the BVH and not the retargeted result: retargeting bakes in one target
    -- rig's bone mapping and rest pose. The BVH is the mesh-independent artifact,
    -- and re-running the retarget on load is milliseconds.
    CREATE TABLE IF NOT EXISTS Motions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      -- Seconds of motion, read back out of the BVH rather than taken from the
      -- request: a multi-sentence prompt generates one segment per sentence, so
      -- what was asked for and what came back routinely differ.
      duration REAL NOT NULL DEFAULT 0,
      frameCount INTEGER NOT NULL DEFAULT 0,
      fps REAL NOT NULL DEFAULT 0,
      inPlace INTEGER NOT NULL DEFAULT 0,
      seed INTEGER,
      filePath TEXT NOT NULL,
      -- Which generator produced it. Only 'kimodo' today; recorded so a second
      -- source can share the library without the rows becoming ambiguous.
      source TEXT NOT NULL DEFAULT 'kimodo',
      createdAt INTEGER NOT NULL
    );

    -- Free-form labels an asset can be filtered by in the library. Many tags per
    -- asset, many assets per tag, and no separate tag registry: the vocabulary is
    -- whatever rows exist here, so a tag disappears once nothing carries it.
    -- Tags are stored already normalized (lower-cased, whitespace-collapsed) by
    -- normalizeTagValue, which is what makes (assetId, tag) a meaningful primary
    -- key -- "Sci Fi" and "sci fi" are the same tag, not two rows.
    CREATE TABLE IF NOT EXISTS Assets_Tags (
      assetId INTEGER NOT NULL,
      tag TEXT NOT NULL,
      addedAt INTEGER NOT NULL,
      PRIMARY KEY(assetId, tag),
      FOREIGN KEY(assetId) REFERENCES Assets(id) ON DELETE CASCADE
    );
`;

// Refuses to start a PostgreSQL server that has no data while a populated
// SQLite file is sitting right there.
//
// The failure this prevents: an existing deployment adds a database service,
// restarts, and the app comes up perfectly healthy and completely empty. Every
// project looks deleted. Nothing is actually lost -- app.db is untouched -- but
// there is no way to tell that from the UI, and the natural next move is to
// start recreating work by hand.
async function guardAgainstUnmigratedData(db) {
  if (db.dialect !== 'postgres') return;
  if (process.env.GENSTUDIO_ALLOW_EMPTY_DATABASE === '1') return;

  const legacyExists = await fs.access(DB_FILE).then(() => true).catch(() => false);
  if (!legacyExists) return;

  const projects = await get(db, 'SELECT COUNT(*) AS total FROM Projects');
  if (Number(projects?.total ?? 0) > 0) return;

  throw new Error(
    `The PostgreSQL database is empty, but ${DB_FILE} still holds data.\n\n` +
    '   Refusing to start, because an empty workspace is indistinguishable from\n' +
    '   losing everything. Migrate the existing data first:\n\n' +
    '     node tools/migrate-sqlite-to-postgres.mjs --from ./data/app.db --to $GENSTUDIO_DATABASE_URL\n\n' +
    '   If the empty database is intentional, set GENSTUDIO_ALLOW_EMPTY_DATABASE=1.'
  );
}

async function createSchema(db) {
  if (db.dialect === 'postgres') {
    // Read rather than inlined so there is one generated artifact to inspect,
    // diff and hand to psql. It has to travel with the app: see the Dockerfile
    // COPY list, .dockerignore and electron-builder.yml.
    const schemaFile = new URL('./db/schema.pg.sql', import.meta.url);
    await exec(db, await fs.readFile(schemaFile, 'utf8'));
    return;
  }

  await exec(db, SQLITE_SCHEMA);
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
  await fs.mkdir(MOTION_ASSETS_DIR, { recursive: true });

  // Back up the DB before the one-time Nodes→Cards migration touches it. That
  // migration only ever applies to a SQLite file that predates the unified Cards
  // model; a PostgreSQL database is created fresh from the current schema or
  // filled by tools/migrate-sqlite-to-postgres.mjs, so it cannot be in that state.
  if (selectedDialect() === 'sqlite') {
    await backupLegacyDbIfNeeded();
  }

  // Connection pragmas (SQLite) and the connectivity check (PostgreSQL) both
  // happen inside the driver, because they have nothing in common beyond when
  // they run.
  const db = await openDatabase({ file: DB_FILE });

  // Migrate the legacy split schema (Nodes/Connections/KanbanColumns) into the
  // unified Cards model BEFORE the CREATE TABLE IF NOT EXISTS block, so the
  // new-schema statements don't create empty tables alongside the legacy ones
  // (e.g. a fresh Columns table beside the still-named KanbanColumns).
  await migrateNodesIntoCards(db);

  // Captured BEFORE the CREATE TABLE block below so we can tell a database that
  // predates Assets_Projects (needs the one-time backfill) from one that already
  // has it (where a re-backfill would resurrect links the user has since removed).
  const hadAssetProjectsTable = await tableExists(db, 'Assets_Projects');

  await createSchema(db);

  // Before ANY write. Seeding the reference tables first would leave rows behind
  // on a start that is about to be refused, and the migration tool would then
  // see a non-empty target and refuse in turn.
  await guardAgainstUnmigratedData(db);

  await run(db, 'CREATE INDEX IF NOT EXISTS idx_wikipages_parentId ON WikiPages(parentId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_boards_projectId ON Boards(projectId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_projects_projectId ON Assets_Projects(projectId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_tags_tag ON Assets_Tags(tag)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_motions_createdAt ON Motions(createdAt)');

  // Columns added after the fact, each probed rather than versioned. A fresh
  // PostgreSQL schema already has all of them, so every branch here is simply
  // false there -- the cost is one information_schema lookup per column at
  // startup, which is not worth a schema_version table to avoid.
  const addColumnIfMissing = async (table, column, definition) => {
    if (await columnExists(db, table, column)) return;
    await run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  await addColumnIfMissing('Assets', 'thumbnail', 'TEXT');
  await addColumnIfMissing('Assets', 'width', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('Assets', 'height', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('Assets', 'parentId', 'INTEGER');
  await addColumnIfMissing('Assets', 'ownerId', 'INTEGER');
  await addColumnIfMissing('WorkflowConfigs', 'ownerId', 'INTEGER');
  await addColumnIfMissing('Projects', 'graphViewport', 'TEXT');
  await addColumnIfMissing('Projects', 'ownerId', 'INTEGER');

  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_parentId ON Assets(parentId)');
  // Every scoped listing filters on these, so they are read on nearly every request.
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_ownerId ON Assets(ownerId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_projects_ownerId ON Projects(ownerId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cards_projectId ON Cards(projectId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_connections_sourceCardId ON Connections(sourceCardId)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_connections_targetCardId ON Connections(targetCardId)');

  // Deleting an asset row does not delete its bytes: several rows can legitimately
  // share one filePath (a mesh-editor save overwrites the source .glb in place, and
  // versions inherit paths), so the delete paths ask "does any surviving row still
  // point at this file?" before fs.rm. Without these two that probe is a full scan of
  // Assets, once per deleted path, inside a loop.
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_filePath ON Assets(filePath)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_assets_thumbnail ON Assets(thumbnail)');
  // PRIMARY KEY(cardId, assetId) already covers cardId but not assetId, and the
  // assetId foreign key is ON DELETE RESTRICT - so every asset deletion scans this
  // table looking for referrers.
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_cards_assets_assetId ON Cards_Assets(assetId)');

  await migrateLegacyAssetEditsToAssets(db);

  if (await tableExists(db, 'Assets_Edits')) {
    await run(db, 'DROP TABLE Assets_Edits');
  }

  if (!hadAssetProjectsTable) {
    await backfillAssetProjectLinks(db);
  }

  await backfillBatchInputAssetLinks(db);

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

// Retries an allocate-then-insert when someone else claimed the same key first.
//
// Every allocator below reads MAX(position) + 1 and then inserts against a
// UNIQUE constraint. Under SQLite that could never race: the whole process
// shared one connection, so the read and the insert could not be interleaved
// with another request. A PostgreSQL pool runs requests genuinely in parallel,
// so two people adding a card to the same column at the same moment now pick
// the same position and one of them loses. Re-reading and retrying is correct
// and cheap; the alternative is locking a whole column per insert.
//
// A conflict that is NOT a race -- a genuinely duplicate clientKey, say -- will
// simply fail every attempt and surface as it did before.
async function withUniqueRetry(label, attempt, attempts = 5) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isUniqueViolation(err) || tries >= attempts) throw err;
      console.warn(`[db] ${label}: unique conflict on attempt ${tries}, retrying`);
    }
  }
}

// Takes the handle rather than fetching one: this runs inside withKeyLock, and
// asking the pool for another connection while holding one is how a pool
// deadlocks itself.
async function getNextCardPosition(db, projectId, kanbanColumnId) {
  const row = await get(
    db,
    'SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM Cards WHERE projectId = ? AND kanbanColumnId = ?',
    [projectId, kanbanColumnId]
  );

  return row?.nextPosition ?? 0;
}

async function getNextCardAttributePosition(db, cardId) {
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

async function getNextCardAssetPosition(db, cardId) {
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

  const clientKey = externalCardId && !/^\d+$/.test(String(externalCardId)) ? String(externalCardId) : null;
  const metadata = JSON.stringify(values.metadata || {});
  // The position has to be re-read on each attempt: that is the value another
  // request just took, and reusing the stale one would fail identically forever.
  const result = await withUniqueRetry('ensureCard', () =>
    // One column at a time: the position is derived from the rows already in it,
    // so two callers must not be inside this window together.
    withKeyLock(db, `card:${normalizedProjectId}:${kanbanColumnId}`, async tx => {
      const position = await getNextCardPosition(tx, normalizedProjectId, kanbanColumnId);
      return run(
        tx,
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
    }));

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

// Takes an explicit db so it can run inside a caller's transaction. On a
// PostgreSQL pool, fetching its own handle would put these writes on another
// connection, outside the transaction that is reordering the column.
async function normalizeCardPositions(db, projectId, kanbanColumnId) {
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

async function normalizeCardAssetPositions(db, cardId) {
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

async function normalizeCardAttributePositions(db, cardId) {
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

async function insertAsset({ name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), parentId = null, ownerId = null }) {
  const db = await getDb();
  const assetTypeId = await getAssetTypeIdByName(type);

  // An edit or version belongs to whoever owns the asset it came from, not to
  // whoever happened to run the job. Otherwise a chain would split across two
  // libraries and half of it would vanish from its owner's view.
  let resolvedOwnerId = ownerScope(ownerId);
  if (parentId) {
    const parent = await get(db, 'SELECT ownerId FROM Assets WHERE id = ?', [Number(parentId)]);
    if (parent) resolvedOwnerId = parent.ownerId ?? null;
  }

  const result = await run(
    db,
    'INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail, width, height, parentId, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      name,
      toStoredAssetPath(type, filePath),
      assetTypeId,
      createdAt,
      JSON.stringify(metadata),
      thumbnailPath ? toStoredThumbnailPath(thumbnailPath) : null,
      Number(width) || 0,
      Number(height) || 0,
      parentId ? Number(parentId) : null,
      resolvedOwnerId
    ]
  );

  return result.lastID;
}

// The owner of one asset, for routes that must decide before acting.
export async function getAssetOwnerId(assetId) {
  const db = await getDb();
  const row = await get(db, 'SELECT ownerId FROM Assets WHERE id = ?', [Number(assetId)]);
  return row ? (row.ownerId ?? null) : undefined;   // undefined = no such asset
}

// Project membership comes from Assets_Projects; the card join only supplies
// PLACEMENT (which card/column shows the asset) and is scoped to the resolved
// project so an asset shared by two projects never reports the other's card.
async function getAssetViewById(assetId, { projectId = null } = {}) {
  const db = await getDb();
  const normalizedAssetId = Number(assetId);

  const projectIds = (await all(
    db,
    'SELECT projectId FROM Assets_Projects WHERE assetId = ? ORDER BY addedAt ASC, projectId ASC',
    [normalizedAssetId]
  )).map(row => row.projectId);

  const requestedProjectId = projectId != null ? Number(projectId) : null;
  const resolvedProjectId = requestedProjectId != null && projectIds.includes(requestedProjectId)
    ? requestedProjectId
    : (projectIds[0] ?? null);

  const row = await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail,
            a.width, a.height, a.parentId,
            at.name AS assetTypeName,
            c.id AS cardId, c.clientKey, c.name AS cardName, c.kanbanColumnId,
            kc.name AS kanbanColumnName, c.position AS cardPosition,
            ca.position AS assetPosition
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN Cards_Assets ca ON ca.assetId = a.id
     -- CAST, not a bare placeholder: in "? IS NULL" PostgreSQL has nothing to
     -- infer a type from and refuses the whole statement with 42P18. CAST(... AS
     -- BIGINT) is understood by both engines, unlike the ::bigint shorthand.
     LEFT JOIN Cards c ON c.id = ca.cardId AND (CAST(? AS BIGINT) IS NULL OR c.projectId = ?)
     LEFT JOIN Columns kc ON kc.id = c.kanbanColumnId
     WHERE a.id = ?
     ORDER BY (c.id IS NULL) ASC, ca.position ASC
     LIMIT 1`,
    [resolvedProjectId, resolvedProjectId, normalizedAssetId]
  );

  return row ? mapAssetRow({ ...row, projectId: resolvedProjectId, projectIds }) : null;
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

export async function createAssetVersion({ assetId, name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), inheritThumbnail = true, projectId = null }) {
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

  // A version is a first-class member of every project the asset it was derived
  // from belongs to — both the immediate source (which may itself be a version
  // linked somewhere its root is not) and the root it gets parented to.
  const db = await getDb();
  await inheritProjectLinks(db, sourceAsset.id, nextAssetId);
  await inheritProjectLinks(db, rootAsset.id, nextAssetId);
  if (projectId != null) {
    await linkAssetToProject(db, nextAssetId, projectId);
  }

  return await getAssetViewById(nextAssetId, { projectId });
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

// Membership is a direct Assets_Projects lookup, so this now resolves child
// assets (image edits / mesh versions) too — they carry their own project link
// instead of borrowing their root's card.
export async function getProjectAssetById(projectId, assetId) {
  if (!(await isAssetInProject(projectId, assetId))) {
    return null;
  }

  return await getAssetViewById(assetId, { projectId });
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

// Resolve an image/mesh input source by asset id, accepting EITHER a root asset
// OR a child edit/version — both carry their own Assets_Projects link, so this
// is a single membership check. The root fallback below only exists for rows
// that predate the backfill (a child whose own link is missing but whose root
// is in the project).
async function resolveProjectAssetSourceById(projectId, assetId, typeName) {
  const expectedType = typeName.toLowerCase();

  const record = await getAssetRecordById(assetId);
  if (!record || String(record.assetTypeName || '').toLowerCase() !== expectedType) {
    return null;
  }

  if (!(await isAssetInProject(projectId, record.id))) {
    const root = record.parentId ? await getRootAssetById(record.id) : null;
    if (!root || !(await isAssetInProject(projectId, root.id))) {
      return null;
    }
  }

  if (record.parentId == null) {
    const view = await getAssetViewById(record.id, { projectId });
    return {
      asset: view || { id: record.id, type: expectedType, name: record.name, filePath: record.filePath },
      inputFilePath: record.filePath,
      inputFilename: toAssetUrlPath(record.filePath),
      inputName: record.name,
      isEdit: false,
      editId: null
    };
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

// Resolve an "edit:<storedFilePath>" reference inside a project. The edit (or its
// root) must be a member of the project; the returned `asset` is the root, so a
// result produced from this input is saved as a version/edit of that root.
async function resolveProjectEditSourceByFilePath(db, projectId, editFilePath, typeName) {
  const child = await get(
    db,
    `SELECT child.id, child.parentId, child.name, child.filePath, child.width, child.height, child.metadata
     FROM Assets child
     JOIN AssetTypes childType ON childType.id = child.assetTypeId
     WHERE child.filePath = ? AND child.parentId IS NOT NULL AND childType.name = ?
     ORDER BY child.creationDate DESC, child.id DESC
     LIMIT 1`,
    [editFilePath, typeName]
  );

  if (!child) {
    return null;
  }

  const belongs = await isAssetInProject(projectId, child.id)
    || await isAssetInProject(projectId, child.parentId);
  if (!belongs) {
    return null;
  }

  const rootAsset = await getRootAssetById(child.parentId);
  const assetView = rootAsset ? await getAssetViewById(rootAsset.id, { projectId }) : null;
  const expectedType = typeName.toLowerCase();
  const editMetadata = parseJson(child.metadata, {});

  return {
    asset: assetView && assetView.type === expectedType
      ? assetView
      : {
        id: rootAsset?.id ?? child.parentId,
        type: expectedType,
        name: rootAsset?.name || child.name || '',
        filePath: rootAsset?.filePath || child.filePath
      },
    inputFilePath: child.filePath,
    inputFilename: toAssetUrlPath(child.filePath),
    inputName: child.name || `${expectedType === 'mesh' ? 'Version' : 'Edit'} ${editMetadata?.editId || child.id}`,
    width: child.width ?? 0,
    height: child.height ?? 0,
    isEdit: true,
    editId: editMetadata?.editId || null
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

    return await resolveProjectEditSourceByFilePath(db, projectId, editFilePath, 'Image')
      || await resolveEditSourceByFilePath(db, editFilePath, 'Image');
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
    // Make the project a member, exactly as the root branches below do. Without
    // this an edit / version picked into a project is referenced but not owned
    // by it, so it is invisible to anything that works from membership — most
    // visibly the exporter, which would leave the reference dangling in the
    // bundle and silently point the import back at the original file.
    await linkAssetToProject(db, editRow.id, normalizedProjectId);
    return { sourceReference: `edit:${stored}`, isEdit: true };
  }

  // 2. A root asset with this file already linked to the project → reference by id.
  const projectRoot = await get(
    db,
    `SELECT a.id FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     JOIN Assets_Projects ap ON ap.assetId = a.id
     WHERE a.filePath = ? AND a.parentId IS NULL AND at.name = ? AND ap.projectId = ?
     LIMIT 1`,
    [stored, normalizedType, normalizedProjectId]
  );
  if (projectRoot) {
    return { sourceReference: `asset:${projectRoot.id}`, isEdit: false };
  }

  // 3. Library root not in this project → make it a member. When the row already
  // exists we just add the link; only a file with no Assets row at all needs a
  // new record. (Before Assets_Projects this had to clone the asset row onto a
  // detached card, which left duplicate Assets rows sharing one filePath.)
  const libraryAsset = await findLibraryAssetByFilePath(lowerType, stored);
  if (libraryAsset) {
    await linkAssetToProject(db, libraryAsset.id, normalizedProjectId);
    return { sourceReference: `asset:${libraryAsset.id}`, isEdit: false, attached: true };
  }

  const attached = await createProjectAsset({
    projectId: normalizedProjectId,
    type: lowerType,
    name: stored.split('/').pop(),
    filePath: stored,
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

    return await resolveProjectEditSourceByFilePath(db, projectId, editFilePath, 'Mesh')
      || await resolveEditSourceByFilePath(db, editFilePath, 'Mesh');
  }

  const assetId = typeof parsedReference === 'string' && parsedReference.startsWith('asset:')
    ? Number(parsedReference.slice(6))
    : Number(parsedReference);

  if (!assetId) {
    return null;
  }

  return await resolveProjectAssetSourceById(projectId, assetId, 'Mesh');
}

export async function listProjects(viewerId = null) {
  const db = await getDb();
  const { clause, params } = ownerFilter(viewerId, 'p.ownerId');
  const rows = await all(
    db,
    `SELECT p.*, COALESCE(u.displayName, u.login) AS ownerName
     FROM Projects p
     LEFT JOIN Users u ON u.id = p.ownerId
     WHERE 1 = 1${clause}
     ORDER BY p.creationDate DESC, p.id DESC`,
    params
  );
  if (rows.length === 0) {
    return [];
  }

  // Card art is the newest finished mesh, falling back to the newest image for
  // a project that has not reached the mesh stage yet. Scoped to the projects
  // this viewer can already see, so a shared deployment does not scan every
  // other tenant's assets. Rows arrive oldest-first, so each Map write keeps
  // the newest thumbnail-bearing asset.
  const projectIds = rows.map(row => row.id);
  const thumbnailRows = await all(
    db,
    `SELECT ap.projectId, t.name AS assetTypeName, a.thumbnail
     FROM Assets_Projects ap
     JOIN Assets a ON a.id = ap.assetId
     JOIN AssetTypes t ON t.id = a.assetTypeId
     WHERE ap.projectId IN (${projectIds.map(() => '?').join(', ')})
       AND t.name IN ('Mesh', 'Image')
       AND a.thumbnail IS NOT NULL AND a.thumbnail != ''
     ORDER BY a.creationDate ASC, a.id ASC`,
    projectIds
  );

  const latestMeshThumbnailByProjectId = new Map();
  const latestImageThumbnailByProjectId = new Map();
  for (const row of thumbnailRows) {
    const byProjectId = row.assetTypeName === 'Mesh'
      ? latestMeshThumbnailByProjectId
      : latestImageThumbnailByProjectId;
    byProjectId.set(row.projectId, row.thumbnail);
  }

  return rows.map(row => {
    const thumbnail = latestMeshThumbnailByProjectId.get(row.id)
      ?? latestImageThumbnailByProjectId.get(row.id)
      ?? null;
    return {
      ...mapProjectRow(row),
      thumbnail: thumbnail ? toAssetUrlPath(thumbnail) : null
    };
  });
}

export async function createProject(projectData = {}) {
  const db = await getDb();

  // A project id is a millisecond timestamp rather than a sequence, so two
  // projects created in the same millisecond collide on the primary key.
  // allocateProjectId probes for a free one; the retry is what covers the gap
  // between that probe and the insert, which only exists once requests really
  // run in parallel.
  return withUniqueRetry('createProject', () =>
    // Serialised, because probing for a free id and then inserting it is only
    // meaningful if no one else is doing the same thing in between. Retrying
    // alone is not enough: everyone who loses re-probes the same millisecond and
    // collides again, so the conflicts multiply with the number of callers.
    withKeyLock(db, 'projectId', async tx => {
      const project = {
        id: await allocateProjectId(tx),
        name: projectData.name || 'Untitled Project',
        description: projectData.description || '',
        preset: projectData.preset || '',
        createdAt: Date.now(),
        status: projectData.status || 'active',
        ownerId: ownerScope(projectData.ownerId)
      };

      await run(
        tx,
        'INSERT INTO Projects (id, name, description, preset, creationDate, status, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [project.id, project.name, project.description, project.preset, project.createdAt, project.status, project.ownerId]
      );

      return project;
    }));
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

// Deliberately unscoped: it returns ownerId and lets the caller decide, so a
// route can answer "that project is Bruno's" instead of "no such project".
export async function getProjectById(projectId) {
  const db = await getDb();
  const row = await get(
    db,
    `SELECT p.*, COALESCE(u.displayName, u.login) AS ownerName
     FROM Projects p
     LEFT JOIN Users u ON u.id = p.ownerId
     WHERE p.id = ?`,
    [projectId]
  );
  return row ? mapProjectRow(row) : null;
}

export async function deleteProjectById(projectId, { deleteAssets = false } = {}) {
  const db = await getDb();

  let candidateAssetIds = [];
  if (deleteAssets) {
    const projectAssetRows = await all(
      db,
      'SELECT DISTINCT assetId FROM Assets_Projects WHERE projectId = ?',
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

  // The Projects row is gone, so its Assets_Projects rows cascaded with it: an
  // asset with no membership left belonged to this project only and can go.
  const eligibleRows = await all(
    db,
    `SELECT a.id, a.filePath, a.thumbnail
     FROM Assets a
     WHERE a.id IN (${placeholders})
       AND a.assetTypeId NOT IN (
             SELECT id FROM AssetTypes WHERE name IN ('Workflow', 'Brush')
           )
       AND NOT EXISTS (SELECT 1 FROM Assets_Projects WHERE Assets_Projects.assetId = a.id)
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
     ORDER BY c.position ASC NULLS FIRST`,
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
     ORDER BY c.kanbanColumnId ASC NULLS FIRST, c.position ASC NULLS FIRST, c.creationDate ASC NULLS FIRST, c.id ASC NULLS FIRST`,
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
    // Placing an asset on a node makes it part of that node's project.
    await linkAssetToProject(db, Number(assetId), owner.projectId);

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
        await normalizeCardAssetPositions(db, cid);
      }
      await deleteCardsIfEmpty(db, affected);
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

// Repair membership for images/meshes a batch already points at. Picking one now
// links it (resolveEditableSourceReference / createProjectAsset both do), but
// picks made before that fix left the asset referenced-but-not-owned, so it was
// invisible to everything that works from Assets_Projects — the exporter most of
// all. Idempotent: linkAssetToProject inserts ON CONFLICT DO NOTHING, so this is a
// once every reference is already linked.
async function backfillBatchInputAssetLinks(db) {
  const rows = await all(db, 'SELECT projectId, stateJson FROM BatchConfigs');
  let linked = 0;

  for (const row of rows) {
    const config = parseJson(row.stateJson, null);
    for (const group of config?.groups || []) {
      for (const value of Object.values(group?.values || {})) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.source) {
          continue;
        }

        const source = String(value.source);
        const assetMatch = source.match(/^asset:(\d+)$/);
        const editMatch = assetMatch ? null : source.match(/^edit:([\s\S]+)$/);

        let assetId = null;
        if (assetMatch) {
          const exists = await get(db, 'SELECT id FROM Assets WHERE id = ?', [Number(assetMatch[1])]);
          assetId = exists ? exists.id : null;
        } else if (editMatch) {
          const found = await get(db, 'SELECT id FROM Assets WHERE filePath = ? LIMIT 1', [editMatch[1].replace(/\\/g, '/')]);
          assetId = found ? found.id : null;
        }

        if (assetId == null) {
          continue;
        }

        const already = await get(
          db,
          'SELECT 1 AS found FROM Assets_Projects WHERE assetId = ? AND projectId = ?',
          [assetId, row.projectId]
        );
        if (already) {
          continue;
        }

        await linkAssetToProject(db, assetId, row.projectId);
        linked += 1;
      }
    }
  }

  if (linked > 0) {
    console.log(`Batch input assets: linked ${linked} image/mesh parameter${linked === 1 ? '' : 's'} to their project.`);
  }
}

// ---------------------------------------------------------------------------
// Batch Processing
// ---------------------------------------------------------------------------

// Point a card at one existing asset, replacing whatever it held.
//
// A batch result may be an image edit or a mesh version, and those are created
// by createAssetEditRecord / createAssetVersion, which deliberately do not
// create a Cards_Assets row ("shows up in the project without needing a card").
// The batch does want a card per result, so it links the asset here after the
// run instead.
export async function setCardAssetLink(projectId, cardKey, assetId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const card = await resolveProjectCard(normalizedProjectId, cardKey);

  if (!card) {
    throw new Error('Card not found');
  }

  const asset = await getAssetRecordById(Number(assetId));
  if (!asset) {
    throw new Error('Asset not found');
  }

  const db = await getDb();
  await run(db, 'DELETE FROM Cards_Assets WHERE cardId = ?', [card.id]);
  await run(
    db,
    'INSERT INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, 0)',
    [card.id, Number(assetId)]
  );
  await linkAssetToProject(db, Number(assetId), normalizedProjectId);

  return await getAssetViewById(Number(assetId), { projectId: normalizedProjectId });
}

// One config row per project. The document shape is owned by the client
// (src/utils/batchHelpers.js); storage only round-trips it as JSON. Results are
// not stored here — each one becomes a normal Card carrying its asset.

export async function getProjectBatchConfig(projectId) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const row = await get(
    db,
    'SELECT stateJson, updatedAt FROM BatchConfigs WHERE projectId = ?',
    [normalizedProjectId]
  );

  return {
    projectId: normalizedProjectId,
    state: row ? parseJson(row.stateJson, null) : null,
    updatedAt: row?.updatedAt ?? null
  };
}

export async function saveProjectBatchConfig(projectId, state) {
  const normalizedProjectId = await ensureProjectExists(projectId);
  const db = await getDb();
  const updatedAt = Date.now();

  await run(
    db,
    `INSERT INTO BatchConfigs (projectId, stateJson, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(projectId) DO UPDATE SET stateJson = excluded.stateJson, updatedAt = excluded.updatedAt`,
    [normalizedProjectId, JSON.stringify(state ?? {}), updatedAt]
  );

  return { projectId: normalizedProjectId, state: state ?? {}, updatedAt };
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

// ---------------------------------------------------------------------------
// Motion library (generated animations)
// ---------------------------------------------------------------------------

function mapMotionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    duration: Number(row.duration) || 0,
    frameCount: Number(row.frameCount) || 0,
    fps: Number(row.fps) || 0,
    inPlace: !!row.inPlace,
    seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
    source: row.source || 'kimodo',
    createdAt: Number(row.createdAt) || 0,
  };
}

// Frame count and frame time come straight out of the BVH header. Reading them
// here rather than trusting the client keeps the catalogue honest about what is
// actually in the file — and the duration a caller asked for is often not the
// duration it got, because one prompt sentence generates one segment.
function readBvhTiming(bvhText) {
  const frames = /^\s*Frames:\s*(\d+)/mi.exec(bvhText);
  const frameTime = /^\s*Frame\s+Time:\s*([0-9.eE+-]+)/mi.exec(bvhText);
  const frameCount = frames ? Number(frames[1]) : 0;
  const seconds = frameTime ? Number(frameTime[1]) : 0;
  return {
    frameCount: Number.isFinite(frameCount) ? frameCount : 0,
    fps: seconds > 0 ? 1 / seconds : 0,
    duration: Number.isFinite(frameCount) && seconds > 0 ? frameCount * seconds : 0,
  };
}

function motionFilePath(fileName) {
  return path.join(MOTION_ASSETS_DIR, fileName);
}

export async function listMotions() {
  const db = await getDb();
  const rows = await all(db, 'SELECT * FROM Motions ORDER BY createdAt DESC, id DESC');
  return rows.map(mapMotionRow);
}

export async function getMotionById(motionId) {
  const db = await getDb();
  const row = await get(db, 'SELECT * FROM Motions WHERE id = ?', [Number(motionId)]);
  return row ? mapMotionRow(row) : null;
}

// The BVH text for a saved motion, or null when the row or its file is gone.
// A missing file is reported rather than thrown: the row surviving its file is
// recoverable (delete it), and a 404 says that far more clearly than a 500.
export async function readMotionBvh(motionId) {
  const db = await getDb();
  const row = await get(db, 'SELECT filePath FROM Motions WHERE id = ?', [Number(motionId)]);
  if (!row) return null;
  try {
    return await fs.readFile(motionFilePath(row.filePath), 'utf8');
  } catch {
    return null;
  }
}

export async function createMotion({
  name,
  prompt,
  bvh,
  inPlace = false,
  seed = null,
  source = 'kimodo',
} = {}) {
  const text = String(bvh || '');
  if (!text.trim()) throw new Error('A motion needs its BVH content.');
  const promptText = String(prompt || '').trim();
  if (!promptText) throw new Error('A motion needs the prompt it came from.');

  await fs.mkdir(MOTION_ASSETS_DIR, { recursive: true });
  const timing = readBvhTiming(text);

  // The row is written first so the file can be named after its id: no collision
  // is possible, and an orphaned file is identifiable at a glance. filePath is
  // filled in immediately after, and the row is removed if the write fails —
  // a catalogue entry pointing at nothing is worse than no entry.
  const db = await getDb();
  const now = Date.now();
  const result = await run(
    db,
    `INSERT INTO Motions (name, prompt, duration, frameCount, fps, inPlace, seed, filePath, source, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
    [
      String(name || '').trim() || promptText.slice(0, 60),
      promptText,
      timing.duration,
      timing.frameCount,
      timing.fps,
      inPlace ? 1 : 0,
      Number.isFinite(Number(seed)) && seed !== null ? Number(seed) : null,
      String(source || 'kimodo'),
      now,
    ]
  );

  const fileName = `motion-${result.lastID}.bvh`;
  try {
    await fs.writeFile(motionFilePath(fileName), text, 'utf8');
  } catch (error) {
    await run(db, 'DELETE FROM Motions WHERE id = ?', [result.lastID]);
    throw error;
  }
  await run(db, 'UPDATE Motions SET filePath = ? WHERE id = ?', [fileName, result.lastID]);

  return await getMotionById(result.lastID);
}

export async function renameMotion(motionId, name) {
  const db = await getDb();
  const trimmed = String(name || '').trim();
  if (!trimmed) return await getMotionById(motionId);
  await run(db, 'UPDATE Motions SET name = ? WHERE id = ?', [trimmed, Number(motionId)]);
  return await getMotionById(motionId);
}

export async function deleteMotion(motionId) {
  const db = await getDb();
  const row = await get(db, 'SELECT filePath FROM Motions WHERE id = ?', [Number(motionId)]);
  if (!row) return { status: 'not-found' };

  await run(db, 'DELETE FROM Motions WHERE id = ?', [Number(motionId)]);
  // The row is the catalogue; a file left behind after it is gone is invisible
  // dead weight, but failing the delete over it would strand the row instead.
  if (row.filePath) {
    try { await fs.unlink(motionFilePath(row.filePath)); } catch { /* already gone */ }
  }
  return { status: 'deleted' };
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

// Driven by Assets_Projects, so an asset belongs to a project whether or not it
// has anywhere to sit on the board. Cards supply placement only, and the card
// join is scoped to the same project so an asset shared across projects never
// reports another project's card.
//
// Children (image edits / mesh versions) are normally returned nested in each
// root's `children` array rather than as rows of their own. The exception is a
// child linked to a project its root is NOT in — there is no root row to nest it
// under, so it surfaces as a top-level row (with parentId set). Pass
// includeChildren to get every linked child as a row regardless.
export async function listProjectAssets(projectId = null, { includeChildren = false, viewerId = null } = {}) {
  const db = await getDb();
  const params = [];
  let whereClause = `WHERE at.name IN ('Image', 'Mesh')`;

  const assetScope = ownerFilter(viewerId, 'a.ownerId');
  whereClause += assetScope.clause;
  params.push(...assetScope.params);

  if (projectId !== null && projectId !== undefined) {
    whereClause += ' AND ap.projectId = ?';
    params.push(Number(projectId));
  }

  if (!includeChildren) {
    whereClause += `
       AND (
         a.parentId IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM Assets_Projects rootLink
           WHERE rootLink.assetId = a.parentId AND rootLink.projectId = ap.projectId
         )
       )`;
  }

  const rows = await all(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate, a.metadata, a.thumbnail, a.width, a.height, a.parentId,
            at.name AS assetTypeName,
            ap.projectId,
            c.id AS cardId, c.clientKey, c.name AS cardName, c.status AS cardStatus, c.progress AS cardProgress,
            c.metadata AS cardMetadata, c.kanbanColumnId, kc.name AS kanbanColumnName, c.position AS cardPosition,
            ca.position AS assetPosition
     FROM Assets_Projects ap
     JOIN Assets a ON a.id = ap.assetId
     JOIN AssetTypes at ON at.id = a.assetTypeId
     -- At most ONE placement row per (asset, project): pick this project's first
     -- card, otherwise the asset has no card and every card column stays NULL.
     -- The Kanban board is responsible for hiding card-less assets from columns.
     LEFT JOIN Cards_Assets ca ON ca.assetId = a.id AND ca.cardId = (
       SELECT innerCa.cardId
       FROM Cards_Assets innerCa
       JOIN Cards innerCard ON innerCard.id = innerCa.cardId
       WHERE innerCa.assetId = a.id AND innerCard.projectId = ap.projectId
       ORDER BY innerCa.position ASC, innerCa.cardId ASC
       LIMIT 1
     )
     LEFT JOIN Cards c ON c.id = ca.cardId
     LEFT JOIN Columns kc ON kc.id = c.kanbanColumnId
     ${whereClause}
     ORDER BY c.kanbanColumnId ASC NULLS FIRST, c.position ASC NULLS FIRST, ca.position ASC NULLS FIRST, a.creationDate DESC NULLS LAST, a.id DESC NULLS LAST`,
    params
  );

  const projectIdsByAssetId = await listProjectIdsByAssetIds(db, rows.map(row => row.id));

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
        thumbnail: row.thumbnail || canonicalAsset?.thumbnail || null,
        projectIds: projectIdsByAssetId.get(row.id) || (row.projectId != null ? [row.projectId] : [])
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
  const position = await withUniqueRetry('createCardAttribute', () =>
    withKeyLock(db, `cardAttribute:${card.id}`, async tx => {
      const next = await getNextCardAttributePosition(tx, card.id);
      await run(
        tx,
        'INSERT INTO Cards_Attributes (cardId, position, attributeTypeId, attributeValue) VALUES (?, ?, ?, ?)',
        [card.id, next, attributeType.id, attributeValue]
      );
      return next;
    }));

  return await getCardAttributeView(card.id, position);
}

export async function createAssetEditRecord({ assetId, editId, name = '', filePath, width = 0, height = 0, createdAt = Date.now(), projectId = null }) {
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

  // An edit belongs to the same project(s) as the image it was made from, so it
  // shows up in that project without needing a card of its own.
  const db = await getDb();
  await inheritProjectLinks(db, Number(assetId), childAssetId);
  await inheritProjectLinks(db, parentAsset.id, childAssetId);
  if (projectId != null) {
    await linkAssetToProject(db, childAssetId, projectId);
  }

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
  await normalizeCardAttributePositions(db, card.id);

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
  await normalizeCardPositions(db, normalizedProjectId, card.kanbanColumnId);

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

  // Reordering a column rewrites every position in it, and UNIQUE(projectId,
  // kanbanColumnId, position) means a half-applied reorder is not a valid state
  // to leave behind. withTransaction hands back a handle bound to one
  // connection -- on a PostgreSQL pool, BEGIN on the pool itself would open the
  // transaction on one connection and run the body on others.
  await withTransaction(db, async tx => {
    await normalizeCardPositions(tx, projectId, card.kanbanColumnId);
    if (card.kanbanColumnId !== kanbanColumnId) {
      await normalizeCardPositions(tx, projectId, kanbanColumnId);
    }

    const currentCard = await get(
      tx,
      'SELECT id, clientKey, kanbanColumnId, position FROM Cards WHERE id = ? AND projectId = ?',
      [card.id, projectId]
    );

    const destinationCountRow = await get(
      tx,
      `SELECT COUNT(*) AS total
       FROM Cards
       WHERE projectId = ? AND kanbanColumnId = ? AND id != ?`,
      [projectId, kanbanColumnId, card.id]
    );
    const maxDestinationPosition = destinationCountRow?.total ?? 0;
    const nextPosition = Math.max(0, Math.min(Number(position) || 0, maxDestinationPosition));

    const sourceCards = await all(
      tx,
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

      await applyCardOrder(tx, orderedCards);
    } else {
      await run(
        tx,
        'UPDATE Cards SET position = ? WHERE id = ?',
        [-(1000000 + currentCard.id), currentCard.id]
      );

      const destinationCards = await all(
        tx,
        `SELECT id
         FROM Cards
         WHERE projectId = ? AND kanbanColumnId = ? AND id != ?
         ORDER BY position ASC, creationDate ASC, id ASC`,
        [projectId, kanbanColumnId, card.id]
      );

      await applyCardOrder(tx, sourceCards.map(sourceCard => ({
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

      await applyCardOrder(tx, orderedDestinationCards);
    }

    await normalizeCardPositions(tx, projectId, currentCard.kanbanColumnId);
    await normalizeCardPositions(tx, projectId, kanbanColumnId);
  });

  return await resolveProjectCard(projectId, externalCardId);
}

export async function createProjectAsset({ projectId, type, name, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), detached = false, ownerId = null }) {
  const normalizedProjectId = await ensureProjectExists(projectId);

  // `detached` means "part of the project, but with no place on the Kanban
  // board" (Brainstorming Board generations). That used to require a fake
  // column-less container card to hang a Cards_Assets row on; membership now
  // lives in Assets_Projects, so a detached asset simply gets no card at all.
  const card = detached
    ? null
    : await ensureCard(normalizedProjectId, 'Images', metadata.cardId, {
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
    createdAt,
    // Everything inside a project belongs to whoever owns the PROJECT, not to
    // whoever happened to create it. An administrator adding an asset to
    // Bruno's project is acting on Bruno's behalf; stamping it to the admin
    // would leave Bruno with an asset in his own project that he cannot see,
    // because the listings scope by asset owner. `ownerId` is only a fallback
    // for a project that has no owner.
    ownerId: (await get(await getDb(), 'SELECT ownerId FROM Projects WHERE id = ?', [normalizedProjectId]))?.ownerId ?? ownerId ?? null
  });
  const db = await getDb();

  await linkAssetToProject(db, assetId, normalizedProjectId);

  if (card) {
    await withUniqueRetry('createProjectAsset', () =>
      withKeyLock(db, `cardAsset:${card.id}`, async tx => {
        const position = await getNextCardAssetPosition(tx, card.id);
        await run(
          tx,
          'INSERT INTO Cards_Assets (cardId, assetId, position) VALUES (?, ?, ?)',
          [card.id, assetId, position]
        );
      }));
  }

  return await getAssetViewById(assetId, { projectId: normalizedProjectId });
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

export async function createLibraryAsset({ name, type, filePath, thumbnailPath = null, width = 0, height = 0, metadata = {}, createdAt = Date.now(), ownerId = null }) {
  const assetId = await insertAsset({
    name,
    type,
    filePath,
    thumbnailPath,
    width,
    height,
    metadata,
    createdAt,
    ownerId
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
     ORDER BY a.creationDate DESC, a.id DESC
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
            EXISTS (SELECT 1 FROM Assets_Projects ap WHERE ap.assetId = a.id) AS isLinked
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
     ORDER BY a.creationDate DESC, a.id DESC
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
  // 0. The version's own project membership — the direct answer. The probes
  //    below are heuristics kept for references that live only in card/node
  //    state (a selected source that was never attached as an asset).
  const membership = await get(
    db,
    `SELECT ap.projectId, p.name AS projectName
     FROM Assets_Projects ap
     LEFT JOIN Projects p ON p.id = ap.projectId
     WHERE ap.assetId = ?
     ORDER BY ap.addedAt DESC NULLS LAST, ap.projectId DESC NULLS LAST
     LIMIT 1`,
    [versionId]
  );
  if (membership) return membership;

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
  await run(db, 'DELETE FROM Assets_Projects WHERE assetId = ?', [version.id]);

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
  // Protected when the asset itself OR any of its edits/versions belongs to a
  // project — deleting the root file would break the whole tree.
  const linkedProject = await get(
    db,
    `SELECT ap.projectId, p.name AS projectName
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     JOIN Assets_Projects ap ON ap.assetId = a.id OR ap.assetId IN (
       SELECT child.id FROM Assets child WHERE child.parentId = a.id
     )
     LEFT JOIN Projects p ON p.id = ap.projectId
     WHERE at.name = ?
       AND a.parentId IS NULL
       AND a.filePath = ?
     ORDER BY ap.addedAt DESC NULLS LAST, ap.projectId DESC NULLS LAST
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
    await normalizeCardAssetPositions(db, cardId);
  }

  await deleteCardsIfEmpty(db, affectedCardIds);

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

async function deleteCardsIfEmpty(db, cardIds = []) {
  const uniqueCardIds = [...new Set(cardIds.filter(cardId => Number.isInteger(cardId)))];

  if (uniqueCardIds.length === 0) {
    return;
  }

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
    await normalizeCardPositions(db, card.projectId, card.kanbanColumnId);
  }
}

// Removing an asset that still belongs to a project only detaches it (the file
// and the library record survive); a project-less asset is deleted for real.
// Pass projectId to detach from ONE project and leave the others alone.
export async function deleteAssetById(assetId, { projectId = null } = {}) {
  const db = await getDb();
  const asset = await get(db, 'SELECT id FROM Assets WHERE id = ?', [assetId]);

  if (!asset) {
    return { status: 'not-found' };
  }

  if (projectId != null) {
    return await unlinkAssetFromProjectById(projectId, assetId);
  }

  const memberships = await all(db, 'SELECT projectId FROM Assets_Projects WHERE assetId = ?', [assetId]);
  const links = await all(db, 'SELECT cardId FROM Cards_Assets WHERE assetId = ?', [assetId]);

  if (memberships.length > 0 || links.length > 0) {
    for (const membership of memberships) {
      await unlinkAssetFromProject(db, assetId, membership.projectId, { cascadeChildren: true });
    }

    if (links.length > 0) {
      await run(db, 'DELETE FROM Cards_Assets WHERE assetId = ?', [assetId]);
      for (const link of links) {
        await normalizeCardAssetPositions(db, link.cardId);
      }
      await deleteCardsIfEmpty(db, links.map(link => link.cardId));
    }

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

// ---------------------------------------------------------------------------
// Users (multi-user server mode)
//
// Rows are only ever created in server mode; a desktop install leaves the table
// empty and applies no authentication. Every function here returns the "view"
// shape (no passwordHash) except findUserByLogin, which the login flow needs in
// order to verify a password — keep that asymmetry, it is the whole reason the
// hash does not leak into API responses by accident.
// ---------------------------------------------------------------------------

export const USER_ROLES = ['admin', 'user', 'viewer'];

export function normalizeUserRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  return USER_ROLES.includes(normalized) ? normalized : 'user';
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    login: row.login,
    displayName: row.displayName || row.login,
    role: row.role,
    avatar: row.avatar || null,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt || null,
    disabled: row.disabled === 1
  };
}

export async function countUsers() {
  const db = await getDb();
  const row = await get(db, 'SELECT COUNT(*) AS total FROM Users');
  return Number(row?.total) || 0;
}

export async function listUsers() {
  const db = await getDb();
  // lower() rather than COLLATE NOCASE: PostgreSQL has no such collation, and the
  // two agree on the ASCII logins this accepts. The Users table is tiny, so the
  // unindexed sort on SQLite costs nothing.
  const rows = await all(db, 'SELECT * FROM Users ORDER BY lower(login)');
  return rows.map(mapUserRow);
}

export async function getUserById(userId) {
  const db = await getDb();
  return mapUserRow(await get(db, 'SELECT * FROM Users WHERE id = ?', [Number(userId)]));
}

// The only function that exposes passwordHash. Used by the login flow alone.
export async function findUserByLogin(login) {
  const db = await getDb();
  const row = await get(db, 'SELECT * FROM Users WHERE lower(login) = lower(?)', [String(login || '').trim()]);
  if (!row) return null;
  return { ...mapUserRow(row), passwordHash: row.passwordHash };
}

export async function createUser({ login, passwordHash, displayName = '', role = 'user', avatar = null, createdAt = Date.now() }) {
  const normalizedLogin = String(login || '').trim();
  if (!normalizedLogin) throw new Error('login is required');
  if (!passwordHash) throw new Error('passwordHash is required');

  const db = await getDb();
  try {
    const result = await run(
      db,
      'INSERT INTO Users (login, displayName, passwordHash, role, avatar, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [normalizedLogin, String(displayName || '').trim() || normalizedLogin, passwordHash, normalizeUserRole(role), avatar, createdAt]
    );
    return await getUserById(result.lastID);
  } catch (err) {
    // a unique violation from the case-insensitive login index.
    if (String(err?.message || '').includes('UNIQUE')) throw new Error('A user with that login already exists');
    throw err;
  }
}

export async function updateUser(userId, updates = {}) {
  const db = await getDb();
  const existing = await getUserById(userId);
  if (!existing) return null;

  const fields = [];
  const values = [];
  if (updates.displayName !== undefined) { fields.push('displayName = ?'); values.push(String(updates.displayName || '').trim() || existing.login); }
  if (updates.role !== undefined) { fields.push('role = ?'); values.push(normalizeUserRole(updates.role)); }
  if (updates.avatar !== undefined) { fields.push('avatar = ?'); values.push(updates.avatar || null); }
  if (updates.disabled !== undefined) { fields.push('disabled = ?'); values.push(updates.disabled ? 1 : 0); }
  if (updates.passwordHash !== undefined) { fields.push('passwordHash = ?'); values.push(updates.passwordHash); }
  if (fields.length === 0) return existing;

  values.push(Number(userId));
  await run(db, `UPDATE Users SET ${fields.join(', ')} WHERE id = ?`, values);
  return await getUserById(userId);
}

export async function recordUserLogin(userId, at = Date.now()) {
  const db = await getDb();
  await run(db, 'UPDATE Users SET lastLoginAt = ? WHERE id = ?', [at, Number(userId)]);
}

export async function deleteUserById(userId) {
  const db = await getDb();
  const existing = await getUserById(userId);
  if (!existing) return false;
  await run(db, 'DELETE FROM Users WHERE id = ?', [Number(userId)]);
  return true;
}

// `viewerId` scopes the library to one user on a shared server. Pass null (a
// desktop install, where there are no accounts) and nothing is filtered, so the
// single-user behaviour is unchanged. Unowned workflows stay visible to
// everyone: they predate per-user libraries and belong to no one to hide them
// from.
export async function listWorkflowRecords(viewerId = null) {
  const db = await getDb();
  const numericViewerId = Number(viewerId);
  const scoped = Number.isFinite(numericViewerId) && numericViewerId > 0;

  return await all(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate,
            wc.parametersJson, wc.outputsJson, wc.ownerId
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN WorkflowConfigs wc ON wc.assetId = a.id
     WHERE at.name = 'Workflow'
       ${scoped ? 'AND (wc.ownerId IS NULL OR wc.ownerId = ?)' : ''}
     ORDER BY a.creationDate DESC, a.id DESC`,
    scoped ? [numericViewerId] : []
  );
}

// Deliberately NOT scoped: it returns `ownerId` and lets the caller decide.
// A route that 404s another user's workflow cannot tell them why, and "no such
// workflow" reads as data loss when the real answer is "that one is Bruno's".
export async function getWorkflowRecordById(workflowId) {
  const db = await getDb();
  return await get(
    db,
    `SELECT a.id, a.name, a.filePath, a.creationDate,
            wc.parametersJson, wc.outputsJson, wc.ownerId
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     LEFT JOIN WorkflowConfigs wc ON wc.assetId = a.id
     WHERE at.name = 'Workflow' AND a.id = ?`,
    [workflowId]
  );
}

export async function createWorkflowRecord({ name, filePath, parameters = [], outputs = [], ownerId = null }) {
  const assetId = await insertAsset({
    name,
    type: 'workflow',
    filePath,
    metadata: {},
    createdAt: Date.now()
  });
  const db = await getDb();

  const numericOwnerId = Number(ownerId);
  await run(
    db,
    'INSERT INTO WorkflowConfigs (assetId, parametersJson, outputsJson, ownerId) VALUES (?, ?, ?, ?)',
    [
      assetId,
      JSON.stringify(parameters),
      JSON.stringify(outputs),
      Number.isFinite(numericOwnerId) && numericOwnerId > 0 ? numericOwnerId : null
    ]
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
  // ownerId is deliberately absent from the DO UPDATE list: editing a workflow
  // must never move it to another user's library.
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

export async function listLibraryAssetsByType(type, baseUrl, viewerId = null) {
  const db = await getDb();
  const assetDirectory = getAssetDirectory(type);
  await fs.mkdir(assetDirectory, { recursive: true });
  const scope = ownerFilter(viewerId, 'a.ownerId');
  const rows = await all(
    db,
     `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate
     FROM Assets a
     JOIN AssetTypes at ON at.id = a.assetTypeId
     WHERE at.name = ?
       AND a.parentId IS NULL${scope.clause}
     ORDER BY a.creationDate DESC, a.id DESC`,
    [normalizeAssetTypeName(type), ...scope.params]
  );

  const candidateStoredPaths = [...new Set(rows.map(row => row.filePath).filter(Boolean))];

  const canonicalAssetRows = candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT a.id, a.name, a.filePath, a.thumbnail, a.width, a.height, a.creationDate,
              (
                SELECT ap.projectId
                FROM Assets_Projects ap
                WHERE ap.assetId = a.id
                ORDER BY ap.addedAt DESC NULLS LAST, ap.projectId DESC NULLS LAST
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
  // A root also counts as belonging to a project when one of its edits/versions
  // is linked there — otherwise attaching an edit to a project would leave the
  // Assets page with nothing to show, since it lists roots.
  const projectLinkRows = candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT DISTINCT a.filePath, ap.projectId
       FROM Assets a
       JOIN AssetTypes at ON at.id = a.assetTypeId
       JOIN Assets_Projects ap ON ap.assetId = a.id OR ap.assetId IN (
         SELECT child.id FROM Assets child WHERE child.parentId = a.id
       )
       WHERE at.name = ?
         AND a.parentId IS NULL
         AND a.filePath IN (${candidateStoredPaths.map(() => '?').join(', ')})
       ORDER BY ap.projectId`,
      [normalizeAssetTypeName(type), ...candidateStoredPaths]
    )
    : [];

  // Tags of the root assets, keyed by file path so they merge the same way the
  // rows do (the listing dedupes roots by path, not by id).
  const tagRows = candidateStoredPaths.length > 0
    ? await all(
      db,
      `SELECT DISTINCT a.filePath, t.tag
       FROM Assets a
       JOIN AssetTypes at ON at.id = a.assetTypeId
       JOIN Assets_Tags t ON t.assetId = a.id
       WHERE at.name = ?
         AND a.parentId IS NULL
         AND a.filePath IN (${candidateStoredPaths.map(() => '?').join(', ')})
       ORDER BY t.tag ASC`,
      [normalizeAssetTypeName(type), ...candidateStoredPaths]
    )
    : [];

  const tagsByFilePath = tagRows.reduce((accumulator, row) => {
    if (!accumulator[row.filePath]) {
      accumulator[row.filePath] = [];
    }

    if (!accumulator[row.filePath].includes(row.tag)) {
      accumulator[row.filePath].push(row.tag);
    }

    return accumulator;
  }, {});

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
      // The real Assets.id behind the `library:` display id, so callers that
      // write per-asset data (tags) don't have to parse the prefixed one.
      assetId: canonicalAsset?.id ?? row.id,
      name: canonicalAsset?.name || row.name,
      filename,
      filePath: row.filePath,
      projectId: canonicalAsset?.projectId ?? null,
      projectIds: projectIdsByFilePath[row.filePath] || [],
      tags: tagsByFilePath[row.filePath] || [],
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

// 2 added `projectAssetRefIds` (explicit Assets_Projects membership). Version 1
// bundles are still importable — their membership is derived from card links.
export const PROJECT_EXPORT_SCHEMA_VERSION = 2;
const SUPPORTED_PROJECT_EXPORT_SCHEMA_VERSIONS = [1, 2];

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

// Every asset a batch's groups point at, added to the export's seed set.
// collectAssetIdsFromValue only understands `asset:<id>`; a batch variable may
// just as well hold `edit:<filePath>` (an edit or a version), which has to be
// looked up by path. Seeding from the document itself means a referenced file
// travels with the bundle even if project membership was never recorded — which
// is the difference between an import that owns its inputs and one that silently
// points back at the exporter's originals.
async function collectBatchConfigAssetIds(db, config, out) {
  const editPaths = new Set();

  const walk = (value) => {
    if (typeof value === 'string') {
      const assetMatch = value.match(/^asset:(\d+)$/);
      if (assetMatch) {
        out.add(Number(assetMatch[1]));
        return;
      }
      const editMatch = value.match(/^edit:([\s\S]+)$/);
      if (editMatch) {
        editPaths.add(editMatch[1].replace(/\\/g, '/'));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };

  walk(config);

  for (const filePath of editPaths) {
    const row = await get(db, 'SELECT id FROM Assets WHERE filePath = ? LIMIT 1', [filePath]);
    if (row) {
      out.add(row.id);
    }
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
  const presetKey = String(project.preset || '').toLowerCase();
  const mode = presetKey === 'graph' ? 'graph' : presetKey === 'batch' ? 'batch' : 'kanban';
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
       WHERE sourceCardId IN (${placeholders}) AND targetCardId IN (${placeholders})
       -- The full primary key, so a bundle exported twice is byte-identical and
       -- two engines agree. Without it the row order is whatever the plan chose.
       ORDER BY sourceCardId ASC, targetCardId ASC, inputId ASC, outputId ASC`,
      [...nodeIds, ...nodeIds]
    );
  }

  // Kanban / backing cards only (node-cards are exported as `nodes` above).
  const cards = await all(
    db,
    `SELECT c.*, kc.name AS columnName
     FROM Cards c JOIN Columns kc ON kc.id = c.kanbanColumnId
     WHERE c.projectId = ? AND c.nodeTypeId IS NULL
     ORDER BY c.kanbanColumnId ASC NULLS FIRST, c.position ASC NULLS FIRST, c.id ASC NULLS FIRST`,
    [project.id]
  );
  cards.forEach(card => collectAssetIdsFromValue(parseJson(card.metadata, {}), seedAssetIds));

  const cardAssetRows = await all(
    db,
    `SELECT DISTINCT ca.assetId AS assetId
     FROM Cards_Assets ca JOIN Cards c ON c.id = ca.cardId
     WHERE c.projectId = ?
     ORDER BY ca.assetId ASC`,
    [project.id]
  );
  cardAssetRows.forEach(row => seedAssetIds.add(row.assetId));

  // Project membership itself — the authoritative set, and a superset of the
  // card links above (which are kept as a seed so a bundle exported from a
  // half-migrated database still carries everything).
  const memberAssetRows = await all(
    db,
    'SELECT assetId FROM Assets_Projects WHERE projectId = ? ORDER BY assetId ASC',
    [project.id]
  );
  memberAssetRows.forEach(row => seedAssetIds.add(row.assetId));

  // Batch Processing recipe (variables / groups / stages). Absent for other
  // presets, and absent from bundles written before Batch existed — the import
  // side treats it as optional. Without it a Batch bundle would carry only the
  // generated results and lose the whole configuration that produced them.
  const batchConfigRow = await get(db, 'SELECT stateJson FROM BatchConfigs WHERE projectId = ?', [project.id]);
  const batchConfig = batchConfigRow ? parseJson(batchConfigRow.stateJson, null) : null;
  if (batchConfig) {
    await collectBatchConfigAssetIds(db, batchConfig, seedAssetIds);
  }

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
  // `storagePath` is the DB-relative path ("data/assets/meshes/x.glb"); `source`
  // is that resolved against this machine. A remote-connected install exports
  // the plan produced here but fetches the bytes over HTTP, so it needs the
  // former — an absolute path on the server's disk means nothing to it.
  const addFile = (storagePath, dest) => {
    if (!storagePath || !dest || seenDest.has(dest)) return;
    seenDest.add(dest);
    files.push({ source: toAbsoluteStoragePath(storagePath), storagePath, dest });
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
    addFile(row.filePath, relPath);

    let thumbnailRelPath = null;
    if (row.thumbnail) {
      const thumbBase = path.basename(row.thumbnail);
      thumbnailRelPath = `assets/thumbnails/${thumbBase}`;
      addFile(row.thumbnail, thumbnailRelPath);
    }

    // Paint document (base + layer textures live under paintdocs/<assetId>/).
    let paintDoc = null;
    const doc = await getPaintDocumentByAssetId(assetId);
    if (doc) {
      const paintRel = (storedPath) => {
        if (!storedPath) return null;
        const rel = `assets/paintdocs/${row.id}/${path.basename(storedPath)}`;
        addFile(storedPath, rel);
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

    // Tags travel with the asset. Additive field: a bundle written before tags
    // existed simply has none, and an older app ignores it -- no version bump.
    const tags = await listAssetTags(row.id);

    assets.push({
      refId: row.id,
      name: row.name,
      tags,
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
    batchConfig,
    assets,
    // Asset <-> project membership (schemaVersion 2+). Independent of cards, so
    // detached assets and edits/versions attached straight to the project travel
    // with the bundle. v1 bundles have no such list and fall back to card links.
    projectAssetRefIds: memberAssetRows
      .map(row => row.assetId)
      .filter(assetId => collectedIds.has(assetId)),
    cards: cards.map(card => ({
      refKey: card.id,
      // A batch result card is addressed by a self-describing clientKey, which
      // is the only thing tying it back to its cell in the results grid. Carry
      // it so an imported batch still shows its results.
      clientKey: card.clientKey || null,
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

// A batch's image/mesh variable stores its asset as a reference AND caches that
// asset's numeric id, name and thumbnail so the group card can draw a chip
// without another round trip. remapReferencesDeep only rewrites the reference
// string, which would leave the cached fields pointing at the EXPORTER's asset —
// a different asset here, or none at all. Recompute them from the reference the
// remap just fixed.
async function repairBatchAssetValues(db, config, projectId) {
  for (const group of config?.groups || []) {
    for (const [variableId, value] of Object.entries(group?.values || {})) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.source) {
        continue;
      }

      const source = String(value.source);
      const assetMatch = source.match(/^asset:(\d+)$/);
      const editMatch = assetMatch ? null : source.match(/^edit:([\s\S]+)$/);

      let row = null;
      if (assetMatch) {
        row = await get(db, 'SELECT id, name, filePath, thumbnail FROM Assets WHERE id = ?', [Number(assetMatch[1])]);
      } else if (editMatch) {
        row = await get(db, 'SELECT id, name, filePath, thumbnail FROM Assets WHERE filePath = ?', [editMatch[1]]);
      }

      if (!row) {
        // The asset did not travel with the bundle. Clear the cache so the chip
        // reads as unresolved instead of showing someone else's picture.
        group.values[variableId] = { ...value, assetId: null, thumbnail: null };
        continue;
      }

      // The imported project must OWN what its batch points at, whatever the
      // exporter's membership records looked like — an `edit:` reference is
      // resolved by path, so it would otherwise resolve fine while the project
      // showed none of its own inputs.
      await linkAssetToProject(db, row.id, projectId);

      group.values[variableId] = {
        ...value,
        assetId: row.id,
        name: row.name || value.name || '',
        // A mesh with no rendered thumbnail draws an icon; pointing an <img> at
        // the .glb itself would just be a broken image.
        thumbnail: row.thumbnail
          ? toAssetUrlPath(row.thumbnail)
          : (String(value.type || '') === 'mesh' ? null : toAssetUrlPath(row.filePath))
      };
    }
  }

  return config;
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
export async function importProjectExport(manifest, bundleDir, { name, ownerId = null } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('The .3dgp file is empty or invalid.');
  }
  if (!SUPPORTED_PROJECT_EXPORT_SCHEMA_VERSIONS.includes(Number(manifest.schemaVersion))) {
    throw new Error(`Unsupported .3dgp version: ${manifest.schemaVersion}`);
  }

  const pool = await getDb();
  const proj = manifest.project || {};
  const projectName = String(name || proj.name || 'Imported Project').trim() || 'Imported Project';

  // An import inserts rows AND copies files, and a half-imported project is
  // worse than no import at all -- so this cannot be split. The handle passed in
  // shadows the outer pool deliberately: on PostgreSQL it owns one connection for
  // the whole body, which is the only way BEGIN and the writes land together.
  return withTransaction(pool, async db => {
    const newProjectId = await allocateProjectId(db);
    const createdAt = Date.now();
    const importOwnerId = ownerScope(ownerId);
    await run(
      db,
      'INSERT INTO Projects (id, name, description, preset, creationDate, status, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newProjectId, projectName, proj.description || '', proj.preset || '', createdAt, proj.status || 'active', importOwnerId]
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
        'INSERT INTO Assets (name, filePath, assetTypeId, creationDate, metadata, thumbnail, width, height, parentId, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          asset.name || 'Asset',
          newStoredPath,
          assetTypeId,
          Date.now(),
          JSON.stringify(asset.metadata || {}),
          thumbnailStored,
          Number(asset.width) || 0,
          Number(asset.height) || 0,
          parentNewId,
          importOwnerId
        ]
      );
      const newId = result.lastID;
      assetIdMap.set(asset.refId, newId);
      if (asset.originalFilePath) {
        editPathMap.set(String(asset.originalFilePath).replace(/\\/g, '/'), newStoredPath);
      }
      insertedAssets.push({ newId, metadata: asset.metadata || {} });

      // Tags (absent from pre-tag bundles, hence the guard).
      for (const tag of normalizeTagList(asset.tags || [])) {
        await run(
          db,
          'INSERT INTO Assets_Tags (assetId, tag, addedAt) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          [newId, tag, createdAt]
        );
      }

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

    // Batch Processing recipe. Optional: only Batch projects carry one, and
    // bundles written before Batch existed have none. Written here rather than
    // with the project row because an image/mesh variable holds an `asset:` /
    // `edit:` reference per group, which is only meaningful once the imported
    // assets have their new ids.
    if (manifest.batchConfig && typeof manifest.batchConfig === 'object') {
      const batchConfig = await repairBatchAssetValues(
        db,
        remapReferencesDeep(manifest.batchConfig, assetIdMap, editPathMap),
        newProjectId
      );
      await run(
        db,
        'INSERT INTO BatchConfigs (projectId, stateJson, updatedAt) VALUES (?, ?, ?)',
        [newProjectId, JSON.stringify(batchConfig), createdAt]
      );
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
        // Client keys are otherwise dropped on import, since they are only
        // meaningful to whoever minted them. A batch result key is the exception:
        // it encodes the run/group/stage the card belongs to, and the results
        // grid finds the card by it. Unique per project, so a fresh project id
        // cannot collide.
        const importedClientKey = String(card.clientKey || '').startsWith('batch:')
          ? card.clientKey
          : null;
        const result = await run(
          db,
          `INSERT INTO Cards (projectId, kanbanColumnId, clientKey, name, position, creationDate, status, progress, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newProjectId,
            columnId,
            importedClientKey,
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
          `INSERT INTO Connections (sourceCardId, targetCardId, inputId, outputId) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [sourceId, targetId, conn.inputId, conn.outputId]
        );
      }
    }

    // --- Phase E: asset <-> project membership (Assets_Projects) ---
    {
      const now = Date.now();

      for (const refId of manifest.projectAssetRefIds || []) {
        const newAssetId = assetIdMap.get(refId);
        if (newAssetId == null) continue;
        await linkAssetToProject(db, newAssetId, newProjectId);
      }

      // Anything placed on a card or node is a member too — this is also what
      // gives v1 bundles (no projectAssetRefIds) their membership.
      await run(
        db,
        `INSERT INTO Assets_Projects (assetId, projectId, addedAt)
         SELECT DISTINCT ca.assetId, c.projectId, ?
         FROM Cards_Assets ca JOIN Cards c ON c.id = ca.cardId
         WHERE c.projectId = ?
         ON CONFLICT DO NOTHING`,
        [now, newProjectId]
      );

      // v1 had no per-child links: an edit/version belonged to whatever project
      // its root did. Reproduce that so nothing goes missing on import. v2
      // bundles carry each child's membership explicitly, so leave them alone.
      if (Number(manifest.schemaVersion) === 1) {
        let inserted = 0;
        let guard = 0;
        do {
          const result = await run(
            db,
            `INSERT INTO Assets_Projects (assetId, projectId, addedAt)
             SELECT child.id, ap.projectId, ?
             FROM Assets child
             JOIN Assets_Projects ap ON ap.assetId = child.parentId
             WHERE ap.projectId = ? AND child.parentId IS NOT NULL
             ON CONFLICT DO NOTHING`,
            [now, newProjectId]
          );
          inserted = result?.changes ?? 0;
          guard += 1;
        } while (inserted > 0 && guard < 100);
      }
    }

    return mapProjectRow(await get(db, 'SELECT * FROM Projects WHERE id = ?', [newProjectId]));
  });
}
