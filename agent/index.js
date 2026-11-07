// "Animate with AI" agent runner - the in-app side of the animation tools.
//
// Five providers, two billing models, one contract:
//   anthropic   Claude Messages API              API key, per-token
//   openai      OpenAI Chat Completions          API key, per-token
//   compatible  any OpenAI-compatible server     (LM Studio, Ollama...) free/local
//   claude_code the user's Claude Code CLI       subscription, no key
//   codex       the user's Codex CLI             subscription, no key
// The API providers run the tool loop HERE against the in-process MCP server;
// the CLI providers run their own loop against /mcp (Claude Code, HTTP) or the
// stdio bridge (Codex). Either way the tools are the same implementation.
//
// A RUN is one user message; a CONVERSATION is the thread of runs. Events a
// run emits (all JSON):
//   start {runId, conversationId, provider, model}
//   text {delta}  turn_end  note {text}
//   tool {id, name, input}  tool_result {id, name, isError, summary}
//   image {data, mimeType, tool}  asset {assetId, sourceAssetId, clip, tool}
//   usage {...}  error {message}  done {conversationId, assetId}
// Images and new versions from the CLI providers arrive out-of-band through
// postArtifact (the MCP tools post them, tagged with the run id).
import { randomUUID } from 'node:crypto';
import { systemPrompt } from './prompt.js';
import { openToolSession, interpretToolResult, summarizeToolResult } from './tools.js';
import { findCli } from './executable.js';
import { runAnthropic } from './providers/anthropic.js';
import { runOpenAI } from './providers/openai.js';
import { runClaudeCode } from './providers/claudeCode.js';
import { runCodex } from './providers/codex.js';

export const PROVIDERS = [
  { id: 'claude_code', label: 'Claude Code', billing: 'subscription', kind: 'cli' },
  { id: 'codex', label: 'OpenAI Codex', billing: 'subscription', kind: 'cli' },
  { id: 'anthropic', label: 'Claude API', billing: 'api', kind: 'api', defaultModel: 'claude-opus-5-5' },
  { id: 'openai', label: 'OpenAI API', billing: 'api', kind: 'api' },
  { id: 'compatible', label: 'OpenAI-compatible (local)', billing: 'api', kind: 'api' }
];

/** Which providers can run right now, and why not. */
export async function providerStatus(settings) {
  const agent = settings?.agent || {};
  const apis = settings?.apis || {};
  const out = [];
  for (const p of PROVIDERS) {
    let available = false;
    let detail = '';
    if (p.id === 'claude_code' || p.id === 'codex') {
      const cli = await findCli(p.id === 'claude_code' ? 'claude' : 'codex', p.id === 'claude_code' ? agent.claudePath : agent.codexPath);
      available = Boolean(cli.path && cli.version);
      detail = available ? cli.version : (cli.error || 'not found');
    } else if (p.id === 'anthropic') {
      available = Boolean(apis.anthropic?.apiKey);
      detail = available ? 'API key set' : 'No Anthropic API key in Settings';
    } else if (p.id === 'openai') {
      available = Boolean(apis.openai?.apiKey) && Boolean(agent.models?.openai);
      detail = !apis.openai?.apiKey ? 'No OpenAI API key in Settings' : (!agent.models?.openai ? 'Choose a model in Settings' : 'API key set');
    } else if (p.id === 'compatible') {
      available = Boolean(agent.compatible?.baseUrl) && Boolean(agent.models?.compatible);
      detail = available ? agent.compatible.baseUrl : 'Set the server URL and model in Settings';
    }
    out.push({ ...p, available, detail, model: agent.models?.[p.id] || p.defaultModel || '' });
  }
  return { providers: out, selected: agent.provider || 'claude_code' };
}

// ---- conversations and runs ---------------------------------------------------

const conversations = new Map(); // id -> { provider, history, resumeId, assetId, touched }
const runs = new Map(); // runId -> { emit, controller }
const CONVERSATION_TTL = 24 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, c] of conversations) if (now - c.touched > CONVERSATION_TTL) conversations.delete(id);
}

/** Forward an artifact posted by an MCP tool (CLI providers) into its run. */
export function postArtifact(runId, payload) {
  const run = runs.get(runId);
  if (!run || !payload || typeof payload !== 'object') return false;
  if (payload.type === 'image' && typeof payload.data === 'string') {
    run.emit({ type: 'image', data: payload.data, mimeType: payload.mimeType || 'image/png', tool: payload.tool || '' });
  } else if (payload.type === 'asset' && payload.assetId) {
    run.onAsset({ assetId: payload.assetId, sourceAssetId: payload.sourceAssetId, clip: payload.clip || null, tool: payload.tool || '' });
  } else {
    return false;
  }
  return true;
}

export function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/**
 * Run one user message. `emit(event)` receives the stream; resolves when the
 * run is over (it never throws - failures become an `error` event).
 */
export async function runAgent({ settings, baseUrl, notifyMutation, projectId, assetId, assetName, message, conversationId, provider, emit }) {
  sweep();
  const agent = settings?.agent || {};
  const providerId = provider || agent.provider || 'claude_code';
  const def = PROVIDERS.find(p => p.id === providerId);
  const runId = randomUUID().replace(/-/g, '').slice(0, 24);
  const controller = new AbortController();
  let conversation = conversationId ? conversations.get(conversationId) : null;
  if (!conversation || conversation.provider !== providerId) {
    conversationId = randomUUID();
    conversation = { provider: providerId, history: [], resumeId: null, touched: Date.now() };
    conversations.set(conversationId, conversation);
  }
  // The Workspace is the source of truth for the current mesh: it follows
  // every new version the agent reports and sends the newest one back.
  let currentAsset = assetId;
  const model = agent.models?.[providerId] || def?.defaultModel || '';

  const onAsset = (a) => {
    currentAsset = a.assetId;
    emit({ type: 'asset', ...a });
  };
  runs.set(runId, { emit, controller, onAsset });
  emit({ type: 'start', runId, conversationId, provider: providerId, model: model || 'default' });

  const brief = systemPrompt({ projectId, assetId: currentAsset, assetName });
  const userText = conversation.history.length || conversation.resumeId
    ? `${message}\n\n(Current mesh asset id: ${currentAsset}.)`
    : message;

  let session = null;
  try {
    if (!def) throw new Error(`Unknown provider "${providerId}".`);
    if (def.kind === 'api') {
      session = await openToolSession({ baseUrl, notifyMutation });
      session.runTool = async (id, name, input) => {
        emit({ type: 'tool', id, name, input });
        const result = await session.call(name, input);
        const interpreted = interpretToolResult(name, result);
        for (const img of interpreted.images) emit({ type: 'image', data: img.data, mimeType: img.mimeType, tool: name });
        if (interpreted.asset) onAsset(interpreted.asset);
        emit({ type: 'tool_result', id, name, isError: interpreted.isError, summary: summarizeToolResult(name, interpreted) });
        return { result };
      };
      const common = { system: brief, session, history: conversation.history, userText, emit, signal: controller.signal, maxTurns: agent.maxTurns || 40 };
      let out;
      if (providerId === 'anthropic') {
        out = await runAnthropic({ ...common, apiKey: settings?.apis?.anthropic?.apiKey, model: model || 'claude-opus-5-5', effort: agent.effort });
      } else if (providerId === 'openai') {
        out = await runOpenAI({ ...common, apiKey: settings?.apis?.openai?.apiKey, model, baseUrl: 'https://api.openai.com/v1' });
      } else {
        out = await runOpenAI({ ...common, apiKey: agent.compatible?.apiKey, model, baseUrl: agent.compatible?.baseUrl, images: agent.compatible?.images !== false });
      }
      conversation.history = out.history;
    } else {
      const cli = await findCli(providerId === 'claude_code' ? 'claude' : 'codex', providerId === 'claude_code' ? agent.claudePath : agent.codexPath);
      if (!cli.path) throw new Error(`${def.label} is not installed (${cli.error}).`);
      const run = providerId === 'claude_code' ? runClaudeCode : runCodex;
      const out = await run({ cli: cli.path, model, system: brief, runId, baseUrl, resumeId: conversation.resumeId, userText, emit, signal: controller.signal });
      conversation.resumeId = out.resumeId || conversation.resumeId;
    }
    if (controller.signal.aborted) emit({ type: 'note', text: 'Stopped.' });
  } catch (err) {
    emit({ type: 'error', message: String(err?.message || err) });
  } finally {
    await session?.close();
    runs.delete(runId);
    conversation.touched = Date.now();
    emit({ type: 'done', conversationId, assetId: currentAsset });
  }
}
