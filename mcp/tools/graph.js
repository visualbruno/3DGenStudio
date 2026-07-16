import { z } from 'zod';
import { toolHandler } from '../client.js';

// Node types seeded in storage.js (NODE_TYPES). The friendly enum maps to the
// exact nodeTypeName the backend expects.
const NODE_KINDS = {
  image: 'Image',
  mesh: 'Mesh',
  number: 'Number',
  text: 'Text',
  boolean: 'Boolean',
  image_compare: 'Image Compare'
};

export function registerGraphTools(server, { api, notifyMutation }) {
  server.registerTool('get_graph', {
    title: 'Get graph',
    description: 'Get a graph project\'s full node graph: nodes (with xPos/yPos, nodeTypeName, linked assetId, status, metadata) and connections (sourceNodeId/targetNodeId with React Flow handle ids like "output-0"/"input-0").',
    inputSchema: { projectId: z.number().int() },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => {
    const [nodes, connections] = await Promise.all([
      api.apiJson('GET', '/graph/nodes', { query: { projectId } }),
      api.apiJson('GET', '/graph/connections', { query: { projectId } })
    ]);
    return { nodes, connections };
  }));

  server.registerTool('create_node', {
    title: 'Create graph node',
    description: 'Add a node to a graph project. Kinds: image (holds/generates images and runs ComfyUI/API actions), mesh (mesh generation/editing), number/text/boolean (value nodes feeding workflow parameters), image_compare. Value nodes store their value in metadata as {"outputType":"number|text|boolean","outputValue":<value>}.',
    inputSchema: {
      projectId: z.number().int(),
      kind: z.enum(['image', 'mesh', 'number', 'text', 'boolean', 'image_compare']),
      name: z.string().optional().describe('Node display name'),
      x: z.number().default(0).describe('Canvas X position'),
      y: z.number().default(0).describe('Canvas Y position'),
      assetId: z.number().int().optional().describe('Existing asset to attach to the node'),
      metadata: z.record(z.string(), z.any()).optional().describe('Node metadata JSON (e.g. outputType/outputValue for value nodes)')
    }
  }, toolHandler(async ({ projectId, kind, name, x, y, assetId, metadata }) => {
    const node = await api.apiJson('POST', '/graph/nodes', {
      body: {
        projectId,
        nodeTypeName: NODE_KINDS[kind],
        name: name || NODE_KINDS[kind],
        xPos: x,
        yPos: y,
        ...(assetId !== undefined ? { assetId } : {}),
        ...(metadata !== undefined ? { metadata } : {})
      }
    });
    notifyMutation(projectId);
    return node;
  }));

  server.registerTool('update_node', {
    title: 'Update graph node',
    description: 'Update a graph node\'s name, linked asset, status, progress, or metadata.',
    inputSchema: {
      projectId: z.number().int(),
      nodeId: z.number().int(),
      name: z.string().optional(),
      assetId: z.number().int().nullable().optional(),
      status: z.string().optional(),
      progress: z.number().optional(),
      metadata: z.record(z.string(), z.any()).optional()
    }
  }, toolHandler(async ({ projectId, nodeId, ...updates }) => {
    const body = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
    const node = await api.apiJson('PUT', `/graph/nodes/${nodeId}`, { body: { projectId, ...body } });
    notifyMutation(projectId);
    return node;
  }));

  server.registerTool('move_node', {
    title: 'Move graph node',
    description: 'Move a graph node to a new canvas position.',
    inputSchema: {
      projectId: z.number().int(),
      nodeId: z.number().int(),
      x: z.number(),
      y: z.number()
    }
  }, toolHandler(async ({ projectId, nodeId, x, y }) => {
    const node = await api.apiJson('PUT', `/graph/nodes/${nodeId}/position`, {
      body: { projectId, xPos: x, yPos: y }
    });
    notifyMutation(projectId);
    return node;
  }));

  server.registerTool('delete_node', {
    title: 'Delete graph node',
    description: 'PERMANENTLY delete a graph node (its connections are removed with it; linked assets remain).',
    inputSchema: { projectId: z.number().int(), nodeId: z.number().int() },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ projectId, nodeId }) => {
    await api.apiJson('DELETE', `/graph/nodes/${nodeId}`, { query: { projectId } });
    notifyMutation(projectId);
    return { deleted: true, nodeId };
  }));

  server.registerTool('connect_nodes', {
    title: 'Connect graph nodes',
    description: 'Create an edge from a source node\'s output handle to a target node\'s input handle. Handles default to "output-0"/"input-0"; connector types must be compatible (an image output feeds an image input, a number output feeds a number parameter, etc.).',
    inputSchema: {
      projectId: z.number().int(),
      sourceNodeId: z.number().int(),
      targetNodeId: z.number().int(),
      outputId: z.string().default('output-0').describe('Source handle id'),
      inputId: z.string().default('input-0').describe('Target handle id')
    }
  }, toolHandler(async ({ projectId, sourceNodeId, targetNodeId, outputId, inputId }) => {
    const connection = await api.apiJson('POST', '/graph/connections', {
      body: { projectId, sourceNodeId, targetNodeId, outputId, inputId }
    });
    notifyMutation(projectId);
    return connection;
  }));

  server.registerTool('disconnect_nodes', {
    title: 'Disconnect graph nodes',
    description: 'Remove an edge between two graph nodes (all four identifiers must match the existing connection).',
    inputSchema: {
      projectId: z.number().int(),
      sourceNodeId: z.number().int(),
      targetNodeId: z.number().int(),
      outputId: z.string().default('output-0'),
      inputId: z.string().default('input-0')
    }
  }, toolHandler(async ({ projectId, sourceNodeId, targetNodeId, outputId, inputId }) => {
    await api.apiJson('DELETE', '/graph/connections', {
      query: { projectId, sourceNodeId, targetNodeId, outputId, inputId }
    });
    notifyMutation(projectId);
    return { deleted: true };
  }));
}
