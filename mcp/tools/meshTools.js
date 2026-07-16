import { z } from 'zod';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { toolHandler, createProgressReporter, withAssetUrls } from '../client.js';

// Local mesh services behind the Node proxy. auto_uv/auto_retopo/repair/
// convert_fbx run on the Python mesh-tools service (:8200), auto_rig on the
// rigging service (:8300), optimize on the bundled gltfpack binary.
const OPERATIONS = {
  auto_uv: { path: '/meshes/auto-uv', sse: true },
  auto_retopo: { path: '/meshes/auto-retopo', sse: true },
  repair: { path: '/meshes/repair', sse: true },
  convert_fbx: { path: '/meshes/convert', sse: true, format: 'fbx' },
  auto_rig: { path: '/meshes/rig', sse: true },
  optimize: { path: '/meshes/optimize', sse: false }
};

async function findProjectAsset(api, projectId, assetId) {
  const assets = await api.apiJson('GET', '/assets', { query: { projectId } });
  const flat = [];
  const visit = asset => {
    if (!asset) return;
    flat.push(asset);
    for (const key of ['edits', 'versions', 'children']) {
      if (Array.isArray(asset[key])) asset[key].forEach(visit);
    }
  };
  (Array.isArray(assets) ? assets : []).forEach(visit);
  const asset = flat.find(a => Number(a?.id) === Number(assetId));
  if (!asset) throw new Error(`Asset ${assetId} not found in project ${projectId} (use list_assets to find valid ids).`);
  if (!asset.filename && !asset.filePath) throw new Error(`Asset ${assetId} has no stored file.`);
  return asset;
}

export function registerMeshToolTools(server, { api, notifyMutation }) {
  server.registerTool('run_mesh_tool', {
    title: 'Run mesh tool',
    description: 'Run a local mesh-processing tool on a project mesh asset and save the result. Operations: auto_uv (UV unwrap), auto_retopo (retopology), repair (fix non-manifold geometry), auto_rig (skeleton + skin weights via the rigging service), optimize (gltfpack simplification; options.simplify_ratio 0..1), convert_fbx (GLB→FBX via headless Blender; requires targetFolder, options.preset unity|unreal|generic). Requires the Python mesh-tools service (auto_uv/auto_retopo/repair/convert_fbx) or rigging service (auto_rig) to be running — in the desktop app start them from Settings. Results save as a new version of the asset by default.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int().describe('Mesh asset id (from list_assets)'),
      operation: z.enum(['auto_uv', 'auto_retopo', 'repair', 'auto_rig', 'optimize', 'convert_fbx']),
      options: z.record(z.string(), z.any()).default({}).describe('Operation options (e.g. {simplify_ratio: 0.5} for optimize, {preset: "unity"} for convert_fbx)'),
      saveMode: z.enum(['version', 'replace']).default('version').describe('Save the processed mesh as a new version (default) or replace the asset file'),
      name: z.string().optional().describe('Name for the saved result'),
      targetFolder: z.string().optional().describe('convert_fbx only: absolute folder to write the .fbx file into')
    }
  }, toolHandler(async (args, extra) => {
    const { projectId, assetId, operation, options = {}, saveMode = 'version', name, targetFolder } = args;
    const op = OPERATIONS[operation];
    const reportProgress = createProgressReporter(extra);

    const asset = await findProjectAsset(api, projectId, assetId);
    await reportProgress(5, 100, `Loaded ${asset.name || 'mesh'} — running ${operation}`);
    const assetFile = asset.filename || asset.filePath;
    const meshBuffer = await api.fetchAssetBuffer(assetFile);

    const form = new FormData();
    const fileName = path.basename(String(assetFile)) || 'mesh.glb';
    form.append('meshFile', new Blob([meshBuffer], { type: 'model/gltf-binary' }), fileName);
    form.append('options', JSON.stringify(options));

    let resultBuffer;
    let stats;
    let outFormat = 'glb';

    if (op.sse) {
      form.append('format', op.format || 'glb');
      const done = await api.apiFormSse(op.path, form, evt => {
        const frac = Number(evt?.frac);
        reportProgress(
          Number.isFinite(frac) ? Math.round(5 + frac * 85) : 50,
          100,
          evt?.message || evt?.stage || `Running ${operation}`
        );
      });
      resultBuffer = Buffer.from(done.mesh_b64, 'base64');
      stats = done.stats || null;
      outFormat = done.format || op.format || 'glb';
    } else {
      const done = await api.apiForm('POST', op.path, form);
      resultBuffer = Buffer.from(done.mesh_b64, 'base64');
      stats = done.stats || null;
    }

    await reportProgress(92, 100, 'Saving result');

    // FBX conversion is an export, not an editable asset — write it to disk.
    if (operation === 'convert_fbx') {
      if (!targetFolder) throw new Error('convert_fbx requires targetFolder (absolute folder to write the .fbx into).');
      const exportForm = new FormData();
      const fbxName = `${(name || asset.name || 'mesh').replace(/\.[^.]*$/, '')}.fbx`;
      exportForm.append('folder', targetFolder);
      exportForm.append('files', new Blob([resultBuffer]), fbxName);
      const written = await api.apiForm('POST', '/export/mesh', exportForm);
      await reportProgress(100, 100, 'FBX written');
      return { operation, stats, ...written };
    }

    const saveForm = new FormData();
    saveForm.append('assetId', String(asset.id));
    saveForm.append('filePath', '');
    saveForm.append('name', name || `${asset.name || 'Mesh'} (${operation.replace(/_/g, ' ')})`);
    saveForm.append('saveMode', saveMode);
    saveForm.append('meshFile', new Blob([resultBuffer], { type: 'model/gltf-binary' }), `mesh.${outFormat}`);
    const savedAsset = await api.apiForm('POST', '/meshes/editor/save', saveForm);

    notifyMutation(projectId);
    await reportProgress(100, 100, 'Done');
    return { operation, stats, savedAsset: withAssetUrls(api, savedAsset) };
  }));

  server.registerTool('export_mesh', {
    title: 'Export mesh file',
    description: 'Copy a project mesh asset\'s file (GLB passthrough) into an absolute folder on this machine. For engine FBX exports (Unity/Unreal) use run_mesh_tool with operation "convert_fbx" instead.',
    inputSchema: {
      projectId: z.number().int(),
      assetId: z.number().int(),
      folder: z.string().min(1).describe('Absolute output folder'),
      fileName: z.string().optional().describe('Output file name (defaults to the asset\'s stored file name)')
    }
  }, toolHandler(async ({ projectId, assetId, folder, fileName }) => {
    const asset = await findProjectAsset(api, projectId, assetId);
    const assetFile = asset.filename || asset.filePath;
    const buffer = await api.fetchAssetBuffer(assetFile);
    const form = new FormData();
    form.append('folder', folder);
    form.append('files', new Blob([buffer]), fileName || path.basename(String(assetFile)) || 'mesh.glb');
    return api.apiForm('POST', '/export/mesh', form);
  }));
}
