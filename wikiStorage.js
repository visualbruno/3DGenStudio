import path from 'path';
import process from 'process';
import fs from 'fs/promises';
import { existsSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────
// File-based wiki store. Lives in a git-tracked folder so the documentation
// ships with the app (unlike data/, which is per-user and gitignored).
//   wiki/manifest.json   — flat list of pages (the tree is derived from parentId)
//   wiki/content/<id>.md — one Markdown file per page
//   wiki/media/          — screenshots and videos referenced by the pages
// ─────────────────────────────────────────────────────────────────────────

export const WIKI_DIR = path.join(process.cwd(), 'wiki');
export const WIKI_CONTENT_DIR = path.join(WIKI_DIR, 'content');
export const WIKI_MEDIA_DIR = path.join(WIKI_DIR, 'media');
const WIKI_MANIFEST = path.join(WIKI_DIR, 'manifest.json');

const WIKI_SEED_TREE = [
  {
    title: 'Getting Started',
    icon: 'rocket_launch',
    content: `# Welcome to 3D Gen Studio

This is your living documentation hub. Use it to capture workflows, tips, and reference notes — with **text, screenshots, and videos** all in one place.

## How to use this Wiki

- Browse pages from the tree on the left.
- Click **Edit** to change a page. The editor uses simple Markdown.
- Use the toolbar to **insert a screenshot or video** — files upload automatically and the embed is dropped in for you.
- Use **+ New Page** to add your own topics, nested anywhere you like.

> 💡 **Tip:** Paste an image directly into the editor, or drag a file onto it — it uploads and embeds instantly.

### Adding a screenshot

\`\`\`
![Caption text](paste-or-upload-an-image)
\`\`\`

### Adding a video

\`\`\`
<video src="upload-a-video" controls></video>
\`\`\`

Happy documenting!`
  },
  {
    title: 'Projects',
    icon: 'folder_special',
    content: `# Projects

A **Project** is a self-contained workspace that bundles everything for one creation: its Kanban board, its node Graph, and its linked assets.

Each project gives you two complementary views of the same work:

- **[Kanban board]** — a stage-by-stage pipeline of cards.
- **[Graph page]** — a node-based view of how assets flow into one another.

> 📸 _Add a screenshot of the Projects gallery here._`,
    children: [
      {
        title: 'Kanban Board',
        icon: 'view_kanban',
        content: `# Kanban Board

The Kanban board organizes a project's work into five pipeline columns. Drag cards between columns as they progress.

## Columns

| Column | Purpose |
| --- | --- |
| **Images** | Source and generated images |
| **Image Edit** | Edited / refined images |
| **Mesh Gen** | Meshes generated from images |
| **Mesh Edit** | Meshes being modeled or refined |
| **Texturing** | Meshes in texturing |

> 📸 _Screenshot of the board with cards in each column._

> 🎬 _Short clip of dragging a card from Images → Mesh Gen._`
      },
      {
        title: 'Graph Page',
        icon: 'account_tree',
        content: `# Graph Page

The Graph page is a node-based canvas where you wire assets and values together to describe how a result is produced.

## Node Types

- **Image** — an image asset.
- **Mesh** — a 3D mesh asset.
- **Image Compare** — side-by-side comparison of two images.
- **Number** — a numeric value.
- **Text** — a text value (e.g. a prompt).
- **Boolean** — a true/false toggle.

> 📸 _Screenshot of a small example graph._`
      }
    ]
  },
  {
    title: 'Assets',
    icon: 'inventory_2',
    content: `# Assets

The Assets Library is your central store of reusable files. Import once, reuse across every project.

Sections:

- **Images** — bitmaps you generate, edit, or import.
- **Meshes** — 3D models and their versions.
- **Brushes** — paint brushes, including imported \`.abr\` sets.
- **Workflows** — saved ComfyUI graphs with exposed inputs/outputs.`,
    children: [
      {
        title: 'Images',
        icon: 'image',
        content: `# Images

Import bitmap images, browse them, and open them in the **Image Editor**. Each image can keep a history of edits.

> 📸 _Screenshot of the Images grid._`
      },
      {
        title: 'Meshes',
        icon: 'deployed_code',
        content: `# Meshes

3D meshes (\`.glb\`, \`.gltf\`, \`.obj\`, \`.fbx\`, \`.stl\`, \`.ply\`) with thumbnail previews and versioning. Open any mesh in the **Mesh Editor**.

> 📸 _Screenshot of a mesh thumbnail and its versions._`
      },
      {
        title: 'Brushes',
        icon: 'brush',
        content: `# Brushes

Reusable paint brushes used by the editors. Import Photoshop \`.abr\` brush sets — each sample becomes a brush variant.

> 📸 _Screenshot of the brush gallery._`
      },
      {
        title: 'Workflows',
        icon: 'schema',
        content: `# Workflows

Import a **ComfyUI** workflow JSON, then choose which nodes become editable **parameters** and which nodes are saved as **outputs**. Saved workflows can be run from the editors and the Kanban pipeline.

> 🎬 _Clip of importing a workflow and selecting inputs/outputs._`
      }
    ]
  },
  {
    title: 'Editors',
    icon: 'edit_square',
    content: `# Editors

Two dedicated editors let you refine assets directly inside the studio:

- **[Image Editor]** — crop, adjust, paint, and AI-edit images.
- **[Mesh Editor]** — model, texture, paint, project, displace, and sculpt meshes.`,
    children: [
      {
        title: 'Image Editor',
        icon: 'photo_filter',
        content: `# Image Editor

A full raster editor for refining images.

## Features

- **Crop** — trim to a region or aspect ratio.
- **Resize** — change pixel dimensions.
- **Levels / Contrast / Saturation** — tonal and color adjustments.
- **Blur / Sharpen** — soften or enhance detail.
- **Shadow Remover** — GPU-accelerated shadow removal.
- **Paint** — freehand painting with a **Brush** or **Image Brush**.
- **AI** — paint a **Mask** and run a **ComfyUI** workflow on the selection.

> 📸 _Screenshot of the editor with the tool panel._

> 🎬 _Clip of the Shadow Remover before/after._`
      },
      {
        title: 'Mesh Editor',
        icon: 'view_in_ar',
        content: `# Mesh Editor

Work on 3D meshes with a stack of complementary tools.

## Tools

- **Modeling** — edit geometry.
- **Texturing** — generate textures with **ComfyUI**.
- **Painting** — paint directly on the surface with a **Brush**.
- **Projection** — project imagery onto the mesh with **ComfyUI**.
- **Displace** — displace geometry using a **Brush**.
- **Sculpting** — sculpt the surface with a **Brush**.

> 🎬 _Clip of projecting a texture onto a mesh._`
      }
    ]
  },
  {
    title: 'Settings',
    icon: 'settings',
    content: `# Settings

Configure the services that power generation and editing.

- **[APIs]** — keys and endpoints for image/mesh generation providers.
- **[ComfyUI]** — connection to your local or remote ComfyUI server.`,
    children: [
      {
        title: 'APIs',
        icon: 'vpn_key',
        content: `# APIs

Store API keys and endpoints for the providers you use (image generation, mesh generation, and more). Keys are saved locally with your app data.

> 📸 _Screenshot of the APIs settings tab._`
      },
      {
        title: 'ComfyUI',
        icon: 'lan',
        content: `# ComfyUI

Point the studio at your **ComfyUI** server. Once connected, imported workflows can run from the editors and the Kanban pipeline.

> 📸 _Screenshot of the ComfyUI connection settings._`
      }
    ]
  }
];

async function ensureDirs() {
  await fs.mkdir(WIKI_CONTENT_DIR, { recursive: true });
  await fs.mkdir(WIKI_MEDIA_DIR, { recursive: true });
}

export function wikiManifestExists() {
  return existsSync(WIKI_MANIFEST);
}

async function readManifest() {
  try {
    const raw = await fs.readFile(WIKI_MANIFEST, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.pages) ? data : { pages: [] };
  } catch {
    return { pages: [] };
  }
}

async function writeManifest(manifest) {
  await ensureDirs();
  await fs.writeFile(WIKI_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function contentPath(id) {
  return path.join(WIKI_CONTENT_DIR, `${id}.md`);
}

async function readContent(id) {
  try {
    return await fs.readFile(contentPath(id), 'utf8');
  } catch {
    return '';
  }
}

async function writeContent(id, content) {
  await ensureDirs();
  await fs.writeFile(contentPath(id), content ?? '', 'utf8');
}

async function removeContent(id) {
  try {
    await fs.unlink(contentPath(id));
  } catch {
    // already gone — ignore
  }
}

function nextId(pages) {
  return pages.reduce((max, page) => Math.max(max, Number(page.id) || 0), 0) + 1;
}

function normalizeParentId(parentId) {
  if (parentId === null || parentId === undefined || parentId === '') return null;
  return Number(parentId);
}

export async function listWikiPages() {
  const { pages } = await readManifest();
  return pages
    .slice()
    .sort((a, b) => (a.position - b.position) || (a.id - b.id))
    .map(page => ({
      id: page.id,
      parentId: page.parentId ?? null,
      title: page.title,
      icon: page.icon || null,
      position: page.position ?? 0,
      updatedAt: page.updatedAt
    }));
}

export async function getWikiPage(id) {
  const { pages } = await readManifest();
  const page = pages.find(item => Number(item.id) === Number(id));
  if (!page) return null;
  return {
    id: page.id,
    parentId: page.parentId ?? null,
    title: page.title,
    icon: page.icon || null,
    position: page.position ?? 0,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    content: await readContent(page.id)
  };
}

export async function createWikiPage({ parentId = null, title, icon = null, content = '' } = {}) {
  const manifest = await readManifest();
  const targetParentId = normalizeParentId(parentId);
  const id = nextId(manifest.pages);
  const position = manifest.pages
    .filter(page => (page.parentId ?? null) === targetParentId)
    .reduce((max, page) => Math.max(max, page.position ?? 0), -1) + 1;
  const timestamp = Date.now();
  const page = {
    id,
    parentId: targetParentId,
    title: String(title || '').trim() || 'Untitled',
    icon: icon || null,
    position,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  manifest.pages.push(page);
  await writeManifest(manifest);
  await writeContent(id, content || '');
  return { ...page, content: content || '' };
}

export async function updateWikiPage(id, fields = {}) {
  const manifest = await readManifest();
  const page = manifest.pages.find(item => Number(item.id) === Number(id));
  if (!page) return null;

  if (fields.title !== undefined) page.title = String(fields.title).trim() || 'Untitled';
  if (fields.icon !== undefined) page.icon = fields.icon || null;
  page.updatedAt = Date.now();

  await writeManifest(manifest);
  if (fields.content !== undefined) await writeContent(id, String(fields.content));
  return await getWikiPage(id);
}

export async function deleteWikiPage(id) {
  const manifest = await readManifest();
  if (!manifest.pages.some(page => Number(page.id) === Number(id))) {
    return { status: 'not-found' };
  }

  // Collect the page and all of its descendants.
  const toDelete = new Set([Number(id)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of manifest.pages) {
      if (page.parentId != null && toDelete.has(Number(page.parentId)) && !toDelete.has(Number(page.id))) {
        toDelete.add(Number(page.id));
        changed = true;
      }
    }
  }

  manifest.pages = manifest.pages.filter(page => !toDelete.has(Number(page.id)));
  await writeManifest(manifest);
  for (const deletedId of toDelete) {
    await removeContent(deletedId);
  }
  return { status: 'deleted' };
}

export async function moveWikiPage(id, { parentId, position } = {}) {
  const manifest = await readManifest();
  const page = manifest.pages.find(item => Number(item.id) === Number(id));
  if (!page) return null;

  const targetParentId = parentId === undefined ? (page.parentId ?? null) : normalizeParentId(parentId);

  // Guard against moving a page into itself or one of its descendants.
  if (targetParentId !== null) {
    const byId = new Map(manifest.pages.map(item => [Number(item.id), item]));
    let cursor = targetParentId;
    while (cursor !== null && cursor !== undefined) {
      if (Number(cursor) === Number(id)) {
        throw new Error('Cannot move a page into itself or its descendants');
      }
      const parent = byId.get(Number(cursor));
      cursor = parent ? (parent.parentId ?? null) : null;
    }
  }

  const siblingIds = manifest.pages
    .filter(item => (item.parentId ?? null) === targetParentId && Number(item.id) !== Number(id))
    .sort((a, b) => (a.position - b.position) || (a.id - b.id))
    .map(item => Number(item.id));

  const requestedIndex = Number.isFinite(Number(position)) ? Number(position) : siblingIds.length;
  const insertIndex = Math.max(0, Math.min(requestedIndex, siblingIds.length));
  siblingIds.splice(insertIndex, 0, Number(id));

  const timestamp = Date.now();
  siblingIds.forEach((siblingId, index) => {
    const sibling = manifest.pages.find(item => Number(item.id) === siblingId);
    if (!sibling) return;
    if (siblingId === Number(id)) {
      sibling.parentId = targetParentId;
      sibling.position = index;
      sibling.updatedAt = timestamp;
    } else {
      sibling.position = index;
    }
  });

  await writeManifest(manifest);
  return await getWikiPage(id);
}

async function writeSeedNode(manifest, node, parentId, position, timestamp, idRef) {
  const id = idRef.next;
  idRef.next += 1;
  manifest.pages.push({
    id,
    parentId,
    title: node.title,
    icon: node.icon || null,
    position,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await writeContent(id, node.content || '');
  const children = node.children || [];
  for (let index = 0; index < children.length; index += 1) {
    await writeSeedNode(manifest, children[index], id, index, timestamp, idRef);
  }
}

export async function seedWikiFiles() {
  await ensureDirs();
  const manifest = { pages: [] };
  const timestamp = Date.now();
  const idRef = { next: 1 };
  for (let index = 0; index < WIKI_SEED_TREE.length; index += 1) {
    await writeSeedNode(manifest, WIKI_SEED_TREE[index], null, index, timestamp, idRef);
  }
  await writeManifest(manifest);
}

// One-time import used when migrating an existing database-backed wiki into
// the new folder. `fullPages` is the array returned by the old DB getters,
// each entry carrying { id, parentId, title, icon, position, content, ... }.
export async function importWikiPages(fullPages) {
  await ensureDirs();
  const manifest = { pages: [] };
  for (const page of fullPages) {
    manifest.pages.push({
      id: Number(page.id),
      parentId: page.parentId == null ? null : Number(page.parentId),
      title: page.title,
      icon: page.icon || null,
      position: page.position ?? 0,
      createdAt: page.createdAt || Date.now(),
      updatedAt: page.updatedAt || Date.now()
    });
    await writeContent(Number(page.id), page.content || '');
  }
  await writeManifest(manifest);
}
