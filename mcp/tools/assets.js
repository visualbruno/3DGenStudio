import { z } from 'zod';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolHandler, withAssetUrls, findProjectAsset } from '../client.js';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain',
  '.json': 'application/json'
};

// MCP image blocks Claude can actually see. Cap the raw size so the base64
// payload stays under typical model/image limits (~5 MB base64).
const VIEWABLE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_VIEW_BYTES = 3.5 * 1024 * 1024;

function imageMimeOf(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] || null;
}

// Resolve what file a view/download request points at: an image asset's own
// file, or — for meshes — its thumbnail when viewing.
function resolveViewTarget(asset) {
  const file = asset.filename || asset.filePath;
  const mime = imageMimeOf(file);
  if (mime && VIEWABLE_IMAGE_MIME.has(mime)) {
    return { file, mime, note: null };
  }
  if (asset.thumbnail) {
    const thumbMime = imageMimeOf(asset.thumbnail) || 'image/png';
    return {
      file: asset.thumbnail,
      mime: thumbMime,
      note: `This is the thumbnail preview of "${asset.name}" (${String(asset.type || 'asset')}), not the file itself. Use download_asset for the full file.`
    };
  }
  return null;
}

export function registerAssetTools(server, { api, notifyMutation }) {
  server.registerTool('list_assets', {
    title: 'List project assets',
    description: 'List a project\'s assets (images, meshes, workflows) with their version/edit trees and direct download URLs.',
    inputSchema: { projectId: z.number().int() },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => {
    const assets = await api.apiJson('GET', '/assets', { query: { projectId } });
    return (Array.isArray(assets) ? assets : []).map(asset => withAssetUrls(api, asset));
  }));

  server.registerTool('list_library_assets', {
    title: 'List asset library',
    description: 'List the global (project-independent) asset library: images, meshes, brushes, and saved workflows.',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => {
    const assets = await api.apiJson('GET', '/assets/library');
    if (Array.isArray(assets)) return assets.map(asset => withAssetUrls(api, asset));
    if (assets && typeof assets === 'object') {
      return Object.fromEntries(Object.entries(assets).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(asset => withAssetUrls(api, asset)) : value
      ]));
    }
    return assets;
  }));

  server.registerTool('upload_asset', {
    title: 'Upload asset',
    description: 'Upload a local file (image or mesh) into a project as a new asset. The file is read from an absolute path on this machine.',
    inputSchema: {
      projectId: z.number().int(),
      filePath: z.string().min(1).describe('Absolute local path of the file to upload'),
      name: z.string().optional().describe('Asset name (defaults to the file name)'),
      type: z.enum(['image', 'mesh']).optional().describe('Asset type (inferred from the file extension when omitted)'),
      metadata: z.record(z.string(), z.any()).optional()
    }
  }, toolHandler(async ({ projectId, filePath, name, type, metadata }) => {
    const buffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const mime = MIME_BY_EXT[path.extname(fileName).toLowerCase()] || 'application/octet-stream';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), fileName);
    form.append('projectId', String(projectId));
    if (type) form.append('type', type);
    if (name) form.append('name', name);
    form.append('metadata', JSON.stringify(metadata || {}));

    const asset = await api.apiForm('POST', '/assets/upload', form);
    notifyMutation(projectId);
    return withAssetUrls(api, asset);
  }));

  server.registerTool('link_asset', {
    title: 'Link existing asset',
    description: 'Attach an already-stored asset file (by its stored filename) to a project — creates the card/link without re-uploading.',
    inputSchema: {
      projectId: z.number().int(),
      filename: z.string().min(1).describe('Stored asset filename (from list_library_assets)'),
      type: z.enum(['image', 'mesh']).default('image'),
      name: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional()
    }
  }, toolHandler(async ({ projectId, filename, type, name, metadata }) => {
    const asset = await api.apiJson('POST', '/assets/link', {
      body: { projectId, filename, type, ...(name ? { name } : {}), ...(metadata ? { metadata } : {}) }
    });
    notifyMutation(projectId);
    return withAssetUrls(api, asset);
  }));

  server.registerTool('view_asset', {
    title: 'View asset (image)',
    description: 'SEE a project asset: returns the actual image so it can be visually inspected. For image assets returns the image itself; for meshes returns the thumbnail preview when one exists. Use this after generating images to check the results. For raw file access use download_asset.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int().describe('Asset id (from list_assets or a generation result)')
    },
    annotations: { readOnlyHint: true }
  }, async ({ projectId, assetId } = {}) => {
    try {
      const asset = await findProjectAsset(api, projectId, assetId);
      const target = resolveViewTarget(asset);
      if (!target) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Asset ${assetId} ("${asset.name}", type ${asset.type}) has no viewable image or thumbnail. Use download_asset to save the file locally instead.`
          }]
        };
      }

      const buffer = await api.fetchAssetBuffer(target.file);
      if (buffer.length > MAX_VIEW_BYTES) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Asset file is too large to view inline (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Use download_asset to save it locally, or open its URL: ${api.assetUrl(target.file)}`
          }]
        };
      }

      const info = {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        width: asset.width || undefined,
        height: asset.height || undefined,
        url: api.assetUrl(asset.filename || asset.filePath)
      };
      return {
        content: [
          { type: 'image', data: buffer.toString('base64'), mimeType: target.mime },
          { type: 'text', text: (target.note ? `${target.note}\n` : '') + JSON.stringify(info) }
        ]
      };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
    }
  });

  server.registerTool('download_asset', {
    title: 'Download asset to disk',
    description: 'Save a project asset\'s file (image, mesh, or workflow) into an absolute folder on the machine running 3D Gen Studio, so it can be opened or inspected from the filesystem.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int(),
      folder: z.string().min(1).describe('Absolute output folder'),
      fileName: z.string().optional().describe('Output file name (defaults to the asset\'s stored file name)')
    },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId, assetId, folder, fileName }) => {
    const asset = await findProjectAsset(api, projectId, assetId);
    const assetFile = asset.filename || asset.filePath;
    const buffer = await api.fetchAssetBuffer(assetFile);
    // Reuse the server's export endpoint — it writes arbitrary files under an
    // absolute folder with basename sanitization.
    const form = new FormData();
    form.append('folder', folder);
    form.append('files', new Blob([buffer]), fileName || path.basename(String(assetFile)) || `asset-${assetId}`);
    const written = await api.apiForm('POST', '/export/mesh', form);
    return { ...written, sizeBytes: buffer.length, asset: { id: asset.id, name: asset.name, type: asset.type } };
  }));

  server.registerTool('delete_asset', {
    title: 'Delete asset',
    description: 'PERMANENTLY delete an asset from a project. Set confirm=true to proceed.',
    inputSchema: {
      assetId: z.number().int(),
      confirm: z.boolean().describe('Must be true — confirms the permanent deletion')
    },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ assetId, confirm }) => {
    if (confirm !== true) throw new Error('Refusing to delete: pass confirm=true to permanently delete this asset.');
    await api.apiJson('DELETE', `/assets/${assetId}`);
    notifyMutation(null);
    return { deleted: true, assetId };
  }));
}
