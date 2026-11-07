// The animation tools for the API providers, served IN-PROCESS: the same MCP
// server external agents talk to, connected through an in-memory transport.
// Schemas, validation, descriptions and behaviour are therefore identical for
// Claude Code, Codex, the Claude API and OpenAI-compatible models - there is
// one implementation of every tool, not one per provider.
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer, buildInstructions } from '../mcp/index.js';

export const AGENT_TOOL_GROUPS = ['animation'];

/**
 * Open an in-process tool session. Returns { tools, instructions, call, close }.
 * `tools`: [{ name, description, inputSchema }]. `call(name, args)` resolves
 * to the MCP result: { content: [{type:'text'|'image', ...}], isError }.
 */
export async function openToolSession({ baseUrl, notifyMutation }) {
  const server = buildMcpServer({ baseUrl, notifyMutation, groups: AGENT_TOOL_GROUPS.join(',') });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'genstudio-animate-agent', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return {
    tools: tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema })),
    instructions: buildInstructions(AGENT_TOOL_GROUPS),
    async call(name, args) {
      try {
        return await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 15 * 60 * 1000 });
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
      }
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}

/** What a tool result means for the Workspace: preview images and a new version. */
export function interpretToolResult(name, result) {
  const images = [];
  let data = null;
  let text = '';
  for (const block of result?.content || []) {
    if (block.type === 'image') images.push({ data: block.data, mimeType: block.mimeType || 'image/png' });
    else if (block.type === 'text') {
      text += block.text;
      try { data = JSON.parse(block.text); } catch { /* not JSON */ }
    }
  }
  let asset = null;
  if (data && !result?.isError && data.assetId && data.sourceAssetId && data.assetId !== data.sourceAssetId) {
    asset = { assetId: data.assetId, sourceAssetId: data.sourceAssetId, clip: data.clip || null, tool: name };
  }
  return { images, data, text, asset, isError: Boolean(result?.isError) };
}

/** One readable line for the transcript. */
export function summarizeToolResult(name, interpreted) {
  if (interpreted.isError) return interpreted.text.slice(0, 400);
  const d = interpreted.data;
  if (!d) return interpreted.text.slice(0, 200);
  if (name === 'describe_rig') return `${d.bodyPlan}; ${d.chains?.length || 0} chains; ${d.clips?.length || 0} clips`;
  if (name === 'inspect_rig') return `${d.verdict}; ${d.issues?.length || 0} issues`;
  if (name === 'preview_animation') {
    const notes = d.checks?.notes || [];
    return notes.length ? notes.slice(0, 2).join(' ') : (d.clip ? `${d.clip}: no problems found` : 'preview');
  }
  if (name === 'save_animation') return `saved "${d.clip}" (${d.duration}s) as version ${d.assetId}`;
  if (d.assetId && d.sourceAssetId) return `new version ${d.assetId}`;
  return '';
}
