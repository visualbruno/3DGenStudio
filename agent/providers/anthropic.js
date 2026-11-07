// Claude through the Messages API (an API key; billed per token).
//
// A manual streaming tool loop (client.beta.messages.stream + finalMessage),
// per the Claude API guidance:
//  * the whole assistant content is appended every turn (thinking blocks
//    included) and history is append-only, so preserved thinking stays valid;
//  * stop on `refusal` and on `max_tokens` with a pending tool call - a
//    truncated tool input can still parse - and never run that turn's tools;
//  * tool failures go back as is_error tool_results, never dropped; every
//    result of one turn goes back in ONE user message;
//  * tool inputs are validated by the MCP server's own zod schemas, so a
//    malformed input comes back as an error result the model can correct;
//  * top-level automatic prompt caching - the tool catalog alone is ~11k
//    tokens and identical on every request;
//  * server-side refusal fallbacks ("default") on the models that take them;
//  * adaptive thinking with display "updates", so the model's progress notes
//    between tool calls reach the transcript instead of an empty pause.
import Anthropic from '@anthropic-ai/sdk';

const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const UPDATES_MODELS = new Set(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);

export async function runAnthropic({ apiKey, model, effort, system, session, history, userText, emit, signal, maxTurns = 40 }) {
  if (!apiKey) throw new Error('No Anthropic API key. Add one in Settings > AI Agent, or pick Claude Code to use your subscription.');
  const client = new Anthropic({ apiKey });
  const tools = session.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    eager_input_streaming: true
  }));
  const messages = [...history, { role: 'user', content: userText }];
  const betas = [];
  const extra = {};
  if (FALLBACK_MODELS.has(model)) { betas.push('server-side-fallback-2026-07-01'); extra.fallbacks = 'default'; }
  const thinking = { type: 'adaptive' };
  if (UPDATES_MODELS.has(model)) { betas.push('thinking-display-updates-2026-08-18'); thinking.display = 'updates'; }

  let jsonRetries = 0;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal.aborted) break;
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32000,
      system: `${system}\n\n${session.instructions}`,
      tools,
      messages,
      thinking,
      output_config: { effort: effort || 'medium' },
      cache_control: { type: 'ephemeral' },
      ...(betas.length ? { betas } : {}),
      ...extra
    }, { signal });
    stream.on('text', delta => emit({ type: 'text', delta }));

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw describeError(err);
      continue; // an unparseable streamed tool input: re-issue the turn
    }

    messages.push({ role: 'assistant', content: message.content });
    for (const block of message.content) {
      if (block.type === 'thinking' && block.thinking) emit({ type: 'note', text: block.thinking });
      if (block.type === 'fallback') emit({ type: 'note', text: `${block.from?.model} declined; continued on ${block.to?.model}.` });
    }
    emit({ type: 'turn_end' });
    if (message.usage) {
      emit({
        type: 'usage',
        inputTokens: message.usage.input_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens || 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens || 0,
        outputTokens: message.usage.output_tokens
      });
    }

    if (message.stop_reason === 'refusal') {
      emit({ type: 'note', text: `The model declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.` });
      break;
    }
    if (message.stop_reason === 'pause_turn') continue;
    const toolUses = message.content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) break;
    if (message.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens in the middle of a tool call.');

    const results = [];
    for (const use of toolUses) {
      if (signal.aborted) break;
      const outcome = await session.runTool(use.id, use.name, use.input);
      const content = [];
      for (const block of outcome.result?.content || []) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType || 'image/png', data: block.data } });
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: content.length ? content : [{ type: 'text', text: '(no output)' }], ...(outcome.result?.isError ? { is_error: true } : {}) });
    }
    if (signal.aborted) break;
    messages.push({ role: 'user', content: results });
  }
  return { history: messages };
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('The Anthropic API key was rejected (401). Check it in Settings > AI Agent.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Anthropic rate limit reached (429) - wait a moment and try again.');
  if (err instanceof Anthropic.BadRequestError) return new Error(`Anthropic rejected the request (400): ${err.message}`);
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}
