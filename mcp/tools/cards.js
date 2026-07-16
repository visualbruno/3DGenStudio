import { z } from 'zod';
import { toolHandler } from '../client.js';

// Kanban columns are fixed (seeded in storage.js). Accept names, map to ids.
const KANBAN_COLUMNS = {
  'images': 1,
  'image edit': 2,
  'mesh gen': 3,
  'mesh edit': 4,
  'texturing': 5,
  'rigging': 6
};

function resolveColumnId(column) {
  if (typeof column === 'number') return column;
  const id = KANBAN_COLUMNS[String(column || '').trim().toLowerCase()];
  if (!id) {
    throw new Error(`Unknown kanban column "${column}". Valid columns: Images, Image Edit, Mesh Gen, Mesh Edit, Texturing, Rigging.`);
  }
  return id;
}

export function registerCardTools(server, { api, notifyMutation }) {
  server.registerTool('list_cards', {
    title: 'List cards',
    description: 'List every card of a project. Kanban cards carry kanbanColumnId (1=Images, 2=Image Edit, 3=Mesh Gen, 4=Mesh Edit, 5=Texturing, 6=Rigging) and position; graph nodes appear here too with a non-null nodeTypeId (use get_graph for the graph view).',
    inputSchema: { projectId: z.number().int() },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => api.apiJson('GET', '/cards', { query: { projectId } })));

  server.registerTool('move_card', {
    title: 'Move kanban card',
    description: 'Move a kanban card to a column ("Images", "Image Edit", "Mesh Gen", "Mesh Edit", "Texturing", "Rigging") at the given position (0-based).',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.number().int().describe('Card id (from list_cards)'),
      column: z.string().describe('Target column name'),
      position: z.number().int().min(0).describe('0-based position inside the column')
    }
  }, toolHandler(async ({ projectId, cardId, column, position }) => {
    const result = await api.apiJson('PUT', '/cards/move', {
      body: { projectId, cardId, kanbanColumnId: resolveColumnId(column), position }
    });
    notifyMutation(projectId);
    return result;
  }));

  server.registerTool('delete_card', {
    title: 'Delete card',
    description: 'PERMANENTLY delete a card from a project (its linked assets remain).',
    inputSchema: { projectId: z.number().int(), cardId: z.number().int() },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ projectId, cardId }) => {
    await api.apiJson('DELETE', `/cards/${cardId}`, { query: { projectId } });
    notifyMutation(projectId);
    return { deleted: true, cardId };
  }));

  server.registerTool('list_card_attributes', {
    title: 'List card attributes',
    description: 'List custom attributes attached to a project\'s cards, plus the available attribute types (1=Text, 2=Number).',
    inputSchema: { projectId: z.number().int() },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => {
    const [attributes, types] = await Promise.all([
      api.apiJson('GET', '/card-attributes', { query: { projectId } }),
      api.apiJson('GET', '/card-attributes/types')
    ]);
    return { attributes, types };
  }));

  server.registerTool('create_card_attribute', {
    title: 'Create card attribute',
    description: 'Add a custom attribute to a card. attributeTypeId: 1=Text, 2=Number.',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.number().int(),
      attributeTypeId: z.number().int().describe('1=Text, 2=Number'),
      value: z.string().default('').describe('Attribute value (string; numbers as text)')
    }
  }, toolHandler(async ({ projectId, cardId, attributeTypeId, value }) => {
    const attribute = await api.apiJson('POST', '/card-attributes', {
      body: { projectId, cardId, attributeTypeId, attributeValue: value }
    });
    notifyMutation(projectId);
    return attribute;
  }));

  server.registerTool('update_card_attribute', {
    title: 'Update card attribute',
    description: 'Update a card attribute (identified by cardId + position from list_card_attributes).',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.number().int(),
      position: z.number().int(),
      attributeTypeId: z.number().int().optional(),
      value: z.string().optional()
    }
  }, toolHandler(async ({ projectId, cardId, position, attributeTypeId, value }) => {
    const attribute = await api.apiJson('PUT', `/card-attributes/${cardId}/${position}`, {
      body: {
        projectId,
        ...(attributeTypeId !== undefined ? { attributeTypeId } : {}),
        ...(value !== undefined ? { attributeValue: value } : {})
      }
    });
    notifyMutation(projectId);
    return attribute;
  }));

  server.registerTool('delete_card_attribute', {
    title: 'Delete card attribute',
    description: 'Delete a card attribute (identified by cardId + position).',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.number().int(),
      position: z.number().int()
    },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ projectId, cardId, position }) => {
    await api.apiJson('DELETE', `/card-attributes/${cardId}/${position}`, { query: { projectId } });
    notifyMutation(projectId);
    return { deleted: true, cardId, position };
  }));
}
