// OpenAI and any OpenAI-COMPATIBLE server (LM Studio, Ollama, vLLM, llama.cpp
// server...) through Chat Completions - the one endpoint every compatible
// server implements. API key = token billing (or free, for a local model).
//
// Tool results are text-only in Chat Completions, so preview images are sent
// right after the tool messages as a user message with image parts - for
// models that can see (setting `images`); a text-only local model gets the
// numbers alone, which the tools are written to make sufficient.

function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

export async function runOpenAI({ baseUrl, apiKey, model, system, session, history, userText, emit, signal, images = true, maxTurns = 40 }) {
  if (!model) throw new Error('No model set for this provider. Choose one in Settings > AI Agent.');
  const url = `${String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const tools = session.tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: cleanSchema(t.inputSchema) }
  }));
  const messages = history.length
    ? [...history, { role: 'user', content: userText }]
    : [{ role: 'system', content: `${system}\n\n${session.instructions}` }, { role: 'user', content: userText }];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal.aborted) break;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
        signal
      });
    } catch (err) {
      if (signal.aborted) break;
      throw new Error(`Could not reach ${url}: ${err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error?.message || JSON.stringify(body).slice(0, 300);
      if (res.status === 401) throw new Error(`The API key was rejected (401): ${detail}`);
      if (res.status === 429) throw new Error(`Rate limited (429): ${detail}`);
      throw new Error(`${url} returned ${res.status}: ${detail}`);
    }
    const choice = body.choices?.[0];
    const msg = choice?.message || { role: 'assistant', content: '' };
    messages.push(msg);
    if (msg.content) emit({ type: 'text', delta: msg.content });
    emit({ type: 'turn_end' });
    if (body.usage) emit({ type: 'usage', inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens });

    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    const pictures = [];
    for (const call of calls) {
      if (signal.aborted) break;
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: the arguments were not valid JSON. Send the call again with valid JSON.' });
        continue;
      }
      const outcome = await session.runTool(call.id, call.function?.name, args);
      const text = (outcome.result?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '(no output)';
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.result?.isError ? `Error: ${text}` : text });
      for (const b of outcome.result?.content || []) if (b.type === 'image') pictures.push({ name: call.function?.name, b });
    }
    if (signal.aborted) break;
    if (images && pictures.length) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Images returned by ${[...new Set(pictures.map(p => p.name))].join(', ')}:` },
          ...pictures.map(p => ({ type: 'image_url', image_url: { url: `data:${p.b.mimeType || 'image/png'};base64,${p.b.data}` } }))
        ]
      });
    }
  }
  return { history: messages };
}
