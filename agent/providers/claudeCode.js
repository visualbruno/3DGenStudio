// Claude Code - the user's own installed, logged-in CLI (their Claude
// SUBSCRIPTION, no API key). It runs the agent loop itself and calls this
// app's MCP server, limited to the animation tools.
//
// Launch flags (checked against `claude --help`, 2.1.x):
//   -p --output-format stream-json --verbose   headless, one JSON event a line
//   --mcp-config <file> --strict-mcp-config    ONLY our server (not the user's
//                                              other MCP servers / connectors)
//   --tools ""                                 no built-in tools: no shell, no
//                                              file edits - it can only animate
//   --allowedTools mcp__genstudio
//   --permission-mode dontAsk                  allowed tools run, nothing prompts
//   --setting-sources ""                       ignore the user's hooks/settings
//   --append-system-prompt-file <file>         our brief
//   --resume <session>                         follow-up messages
// The run id rides in an HTTP header on the MCP connection, so the tools can
// mirror previews and new versions into this run's stream.
//
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the child's
// environment: with either set, Claude Code bills the API instead of the
// subscription this provider exists for.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { launch, killTree, runDirectory } from '../executable.js';
import { summarizeToolResult, interpretToolResult } from '../tools.js';

const PREFIX = 'mcp__genstudio__';

export async function runClaudeCode({ cli, model, system, runId, baseUrl, resumeId, userText, emit, signal }) {
  const dir = runDirectory(runId);
  const mcpPath = path.join(dir, 'mcp.json');
  const systemPath = path.join(dir, 'system.txt');
  fs.writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      genstudio: {
        type: 'http',
        url: `${baseUrl.replace(/\/+$/, '')}/mcp?tools=animation`,
        headers: { 'x-genstudio-agent-run': runId }
      }
    }
  }));
  fs.writeFileSync(systemPath, system);

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpPath, '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__genstudio',
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--append-system-prompt-file', systemPath
  ];
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', resumeId);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  let sessionId = resumeId || null;
  let sawResult = false;
  const toolNames = new Map();
  const { child, done } = launch(cli, args, {
    cwd: dir,
    env,
    stdin: userText,
    onLine(line) {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'system' && ev.subtype === 'init') {
        const mine = (ev.mcp_servers || []).find(s => s.name === 'genstudio');
        if (mine && mine.status && !['connected', 'pending'].includes(mine.status)) {
          emit({ type: 'note', text: `Claude Code could not connect to the app's tools (MCP status: ${mine.status}).` });
        }
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content || []) {
          if (block.type === 'text' && block.text) { emit({ type: 'text', delta: block.text }); emit({ type: 'turn_end' }); }
          else if (block.type === 'thinking' && block.thinking) emit({ type: 'note', text: block.thinking });
          else if (block.type === 'tool_use') {
            const name = String(block.name || '').replace(PREFIX, '');
            toolNames.set(block.id, name);
            emit({ type: 'tool', id: block.id, name, input: block.input });
          }
        }
      } else if (ev.type === 'user') {
        const content = ev.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== 'tool_result') continue;
          const name = toolNames.get(block.tool_use_id) || 'tool';
          const parts = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : (block.content || []);
          // Images and new versions arrive through the run's artifact channel
          // (the MCP tools post them), so only the summary is taken here.
          const interpreted = interpretToolResult(name, { content: parts.filter(p => p.type === 'text'), isError: Boolean(block.is_error) });
          emit({ type: 'tool_result', id: block.tool_use_id, name, isError: interpreted.isError, summary: summarizeToolResult(name, interpreted) });
        }
      } else if (ev.type === 'result') {
        sawResult = true;
        emit({
          type: 'usage',
          inputTokens: ev.usage?.input_tokens,
          cacheReadTokens: ev.usage?.cache_read_input_tokens,
          cacheWriteTokens: ev.usage?.cache_creation_input_tokens,
          outputTokens: ev.usage?.output_tokens,
          costUsd: ev.total_cost_usd,
          subscription: true
        });
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
          emit({ type: 'error', message: `Claude Code stopped: ${ev.result || ev.subtype}` });
        }
      }
    }
  });
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort, { once: true });
  const { code, stderr } = await done;
  signal.removeEventListener('abort', onAbort);
  if (!signal.aborted && code !== 0 && !sawResult) {
    const hint = /login|auth|credential/i.test(stderr) ? ' Run `claude` once in a terminal and log in.' : '';
    throw new Error(`Claude Code exited with code ${code}: ${stderr.trim().slice(0, 400) || 'no output'}.${hint}`);
  }
  return { resumeId: sessionId };
}
