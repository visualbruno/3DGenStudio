import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolHandler, withAssetUrls } from '../client.js';

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
