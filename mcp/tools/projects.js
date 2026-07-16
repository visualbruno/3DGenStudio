import { z } from 'zod';
import { toolHandler } from '../client.js';

export function registerProjectTools(server, { api, notifyMutation }) {
  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'List every 3D Gen Studio project (id, name, description, preset "graph" or kanban, creation date, status).',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => api.apiJson('GET', '/projects')));

  server.registerTool('get_project', {
    title: 'Get project',
    description: 'Get one project by id, including its preset (graph vs kanban board) and saved graph viewport.',
    inputSchema: { projectId: z.number().int().describe('Project id') },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => api.apiJson('GET', `/projects/${projectId}`)));

  server.registerTool('create_project', {
    title: 'Create project',
    description: 'Create a new project. preset "graph" creates a node-graph project (Graph page); "kanban" creates a pipeline board with the fixed columns Images, Image Edit, Mesh Gen, Mesh Edit, Texturing, Rigging.',
    inputSchema: {
      name: z.string().min(1).describe('Project name'),
      description: z.string().optional().describe('Optional project description'),
      preset: z.enum(['graph', 'kanban']).default('graph').describe('Project type: node graph or kanban board')
    }
  }, toolHandler(async ({ name, description, preset }) => {
    // The UI stores presets in title case ('Graph' / 'Kanban') and keys its
    // preview images by that exact string — match it.
    const project = await api.apiJson('POST', '/projects', {
      body: { name, description: description || '', preset: preset === 'kanban' ? 'Kanban' : 'Graph' }
    });
    notifyMutation(project?.id);
    return project;
  }));

  server.registerTool('update_project', {
    title: 'Update project',
    description: 'Update a project\'s name, description, or status.',
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional()
    }
  }, toolHandler(async ({ projectId, ...updates }) => {
    const body = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update (name, description, status).');
    const project = await api.apiJson('PUT', `/projects/${projectId}`, { body });
    notifyMutation(projectId);
    return project;
  }));

  server.registerTool('delete_project', {
    title: 'Delete project',
    description: 'PERMANENTLY delete a project. Set confirm=true to proceed. With deleteAssets=true the project\'s asset files are removed from disk as well.',
    inputSchema: {
      projectId: z.number().int(),
      confirm: z.boolean().describe('Must be true — confirms the permanent deletion'),
      deleteAssets: z.boolean().default(false).describe('Also delete the project\'s asset files from disk')
    },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ projectId, confirm, deleteAssets }) => {
    if (confirm !== true) throw new Error('Refusing to delete: pass confirm=true to permanently delete this project.');
    await api.apiJson('DELETE', `/projects/${projectId}`, { query: deleteAssets ? { deleteAssets: 'true' } : {} });
    notifyMutation(projectId);
    return { deleted: true, projectId };
  }));

  server.registerTool('export_project', {
    title: 'Export project',
    description: 'Export a project as a portable .3dgp bundle folder (manifest + all asset files) under the given absolute destination folder. Returns the created bundle path.',
    inputSchema: {
      projectId: z.number().int(),
      folder: z.string().min(1).describe('Absolute destination folder on this machine (a subfolder named after the project is created inside it)'),
      name: z.string().optional().describe('Optional bundle name override')
    }
  }, toolHandler(async ({ projectId, folder, name }) =>
    api.apiJson('POST', `/projects/${projectId}/export`, { body: { folder, name: name || '' } })
  ));

  server.registerTool('import_project', {
    title: 'Import project',
    description: 'Import a project from a previously exported bundle folder (must contain exactly one .3dgp manifest). Returns the created project.',
    inputSchema: {
      folder: z.string().min(1).describe('Absolute path of the exported bundle folder'),
      name: z.string().optional().describe('Optional name for the imported project')
    }
  }, toolHandler(async ({ folder, name }) => {
    const project = await api.apiJson('POST', '/projects/import', { body: { folder, name: name || '' } });
    notifyMutation(project?.id);
    return project;
  }));
}
