// OpenAI Codex CLI - the user's own installed, logged-in CLI (their ChatGPT
// SUBSCRIPTION, no API key). It runs the agent loop and calls this app's tools
// through the stdio MCP bridge (mcp/stdio.js), limited to the animation group.
//
// NOT VERIFIED against a real Codex install (none on the build machine). The
// flags follow the published `codex exec` reference: --json (one JSONL event a
// line), --skip-git-repo-check, --sandbox read-only, -c key=value config
// overrides (mcp_servers.<id>.command/args/env), -m model, prompt from stdin
// with "-", and `codex exec resume <thread_id>` for follow-ups. The parser
// accepts both the current event names (thread.started, item.completed with
// item.type agent_message / mcp_tool_call / reasoning, turn.completed,
// turn.failed) and the pre-0.44 ones (item_type, assistant_message), and
// ignores anything it does not know.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launch, killTree, runDirectory } from '../executable.js';

const STDIO_BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp', 'stdio.js');
const toml = s => `"${String(s).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;

export async function runCodex({ cli, model, system, runId, baseUrl, resumeId, userText, emit, signal }) {
  const dir = runDirectory(runId);
  const electron = Boolean(process.versions.electron);
  const envTable = [
    `GENSTUDIO_AGENT_RUN=${toml(runId)}`,
    `GENSTUDIO_URL=${toml(baseUrl)}`,
    ...(electron ? ['ELECTRON_RUN_AS_NODE="1"'] : [])
  ].join(',');
  const overrides = [
    `mcp_servers.genstudio.command=${toml(process.execPath)}`,
    `mcp_servers.genstudio.args=[${toml(STDIO_BRIDGE)},"--tools=animation"]`,
    `mcp_servers.genstudio.env={${envTable}}`,
    'approval_policy="never"'
  ];
  const args = ['exec'];
  if (resumeId) args.push('resume', resumeId);
  args.push('--json', '--skip-git-repo-check', '--sandbox', 'read-only');
  for (const o of overrides) args.push('-c', o);
  if (model) args.push('-m', model);
  args.push('-');
  // Codex has no system-prompt flag: the brief opens the FIRST message; a
  // resumed thread already carries it.
  const prompt = resumeId ? userText : `${system}\n\n---\n\nUser request: ${userText}`;

  let threadId = resumeId || null;
  let sawTurnEnd = false;
  const { child, done } = launch(cli, args, {
    cwd: dir,
    env: { ...process.env },
    stdin: prompt,
    onLine(line) {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const type = ev.type || ev.msg?.type;
      if (type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
      else if (type === 'item.started' || type === 'item.completed') {
        const item = ev.item || {};
        const kind = item.type || item.item_type;
        if (type === 'item.completed' && (kind === 'agent_message' || kind === 'assistant_message') && item.text) {
          emit({ type: 'text', delta: item.text });
          emit({ type: 'turn_end' });
        } else if (type === 'item.completed' && kind === 'reasoning' && item.text) {
          emit({ type: 'note', text: item.text });
        } else if (kind === 'mcp_tool_call') {
          const name = item.tool || item.name || 'tool';
          if (type === 'item.started') emit({ type: 'tool', id: item.id, name, input: item.arguments ?? null });
          else emit({ type: 'tool_result', id: item.id, name, isError: item.status === 'failed' || Boolean(item.error), summary: item.error?.message || '' });
        }
      } else if (type === 'turn.completed') {
        sawTurnEnd = true;
        emit({ type: 'usage', inputTokens: ev.usage?.input_tokens, cacheReadTokens: ev.usage?.cached_input_tokens, outputTokens: ev.usage?.output_tokens, subscription: true });
      } else if (type === 'turn.failed' || type === 'error') {
        sawTurnEnd = true;
        emit({ type: 'error', message: `Codex: ${ev.error?.message || ev.message || JSON.stringify(ev.error || ev).slice(0, 300)}` });
      }
    }
  });
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort, { once: true });
  const { code, stderr } = await done;
  signal.removeEventListener('abort', onAbort);
  if (!signal.aborted && code !== 0 && !sawTurnEnd) {
    const hint = /login|auth/i.test(stderr) ? ' Run `codex login` once in a terminal.' : '';
    throw new Error(`Codex exited with code ${code}: ${stderr.trim().slice(0, 400) || 'no output'}.${hint}`);
  }
  return { resumeId: threadId };
}
