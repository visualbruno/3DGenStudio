// Loopback HTTP client for the MCP layer.
//
// Every MCP tool talks to the running 3D Gen Studio backend through its own
// REST API (the exact contract the React frontend uses) instead of importing
// storage.js directly. This keeps SQLite behind a single process and reuses
// the existing route handlers unchanged, so the MCP layer stays a thin shell.
import { Buffer } from 'node:buffer';

export function createApiClient(baseUrl) {
  const base = String(baseUrl || 'http://127.0.0.1:3001').replace(/\/+$/, '');

  async function parseJsonResponse(res, fallbackMessage) {
    if (res.status === 204) return { ok: true };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `${fallbackMessage} (HTTP ${res.status})`);
    }
    return data;
  }

  async function apiJson(method, apiPath, { body, query } = {}) {
    const url = new URL(`${base}/api${apiPath}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return parseJsonResponse(res, `${method} /api${apiPath} failed`);
  }

  async function apiForm(method, apiPath, formData) {
    const res = await fetch(`${base}/api${apiPath}`, { method, body: formData });
    return parseJsonResponse(res, `${method} /api${apiPath} failed`);
  }

  // Parse an SSE byte stream, invoking onData for each `data:` JSON payload.
  // Heartbeat comments (`: keep-alive`) and malformed frames are skipped.
  async function readSseStream(stream, onData) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleEvent = raw => {
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onData(JSON.parse(line.slice(5).trim()));
        } catch {
          // Non-JSON data frame — ignore.
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        handleEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    if (buffer.trim()) handleEvent(buffer);
  }

  // POST multipart to an endpoint that answers with an SSE stream (the mesh
  // tool proxies). onProgress receives every `progress` event; resolves with
  // the terminal `done` event; throws on an `error` event.
  async function apiFormSse(apiPath, formData, onProgress) {
    const res = await fetch(`${base}/api${apiPath}`, { method: 'POST', body: formData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = data?.detail ? `: ${JSON.stringify(data.detail)}` : '';
      throw new Error((data?.error || `POST /api${apiPath} failed (HTTP ${res.status})`) + detail);
    }

    let doneEvent = null;
    let errorEvent = null;
    await readSseStream(res.body, evt => {
      if (evt?.type === 'progress') onProgress?.(evt);
      else if (evt?.type === 'done') doneEvent = evt;
      else if (evt?.type === 'error') errorEvent = evt;
    });

    if (errorEvent) throw new Error(errorEvent.detail || 'The mesh tool reported an error.');
    if (!doneEvent) throw new Error('The mesh tool finished without returning a result.');
    return doneEvent;
  }

  // Subscribe to a long-lived SSE endpoint. Events are delivered to onData
  // until close() is called or the stream ends (onEnd fires on unexpected end).
  function subscribeSse(apiPath, onData, { onEnd } = {}) {
    const controller = new AbortController();
    (async () => {
      const res = await fetch(`${base}/api${apiPath}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`SSE /api${apiPath} failed (HTTP ${res.status})`);
      await readSseStream(res.body, onData);
      throw new Error(`SSE /api${apiPath} ended unexpectedly`);
    })().catch(err => {
      if (!controller.signal.aborted) onEnd?.(err);
    });
    return { close: () => controller.abort() };
  }

  // Public URL for a stored asset file. Asset records carry both `filePath`
  // ("data/assets/meshes/x.glb", storage-prefixed) and `filename`
  // ("meshes/x.glb", relative to the served assets dir) — accept either.
  function assetUrl(filePath) {
    const relative = String(filePath || '').replace(/^\/+/, '').replace(/^data\/assets\//, '');
    return `${base}/assets/${relative}`;
  }

  // Download a stored asset file as a Buffer.
  async function fetchAssetBuffer(filePath) {
    const res = await fetch(assetUrl(filePath));
    if (!res.ok) throw new Error(`Failed to read asset file "${filePath}" (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  return { base, apiJson, apiForm, apiFormSse, subscribeSse, assetUrl, fetchAssetBuffer };
}

// ---------------------------------------------------------------------------
// Tool plumbing shared by every tools/*.js module.

export function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }] };
}

// Wrap a tool implementation: resolve to a JSON text result, surface thrown
// errors as MCP tool errors (isError) instead of protocol-level failures.
export function toolHandler(fn) {
  return async (args, extra) => {
    try {
      return jsonResult(await fn(args ?? {}, extra));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
    }
  };
}

// Progress reporter bound to the caller's progressToken (no-op when the client
// didn't request progress). progress/total follow MCP semantics.
export function createProgressReporter(extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) {
    return async () => {};
  }
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined && total !== null ? { total } : {}),
          ...(message ? { message } : {})
        }
      });
    } catch {
      // Client disconnected or transport closed — progress is best-effort.
    }
  };
}

// Locate an asset anywhere in a project's asset tree (top-level assets plus
// nested edits/versions/children). Throws with a hint when the id is unknown.
export async function findProjectAsset(api, projectId, assetId) {
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

// Attach a public URL to an asset record (and its nested edits/versions when
// present) so MCP clients can download files without base64 round-trips.
export function withAssetUrls(api, asset) {
  if (!asset || typeof asset !== 'object') return asset;
  const out = { ...asset };
  const file = out.filename || out.filePath;
  if (file) out.url = api.assetUrl(file);
  if (out.thumbnail) out.thumbnailUrl = api.assetUrl(out.thumbnail);
  for (const key of ['edits', 'versions', 'children']) {
    if (Array.isArray(out[key])) out[key] = out[key].map(item => withAssetUrls(api, item));
  }
  return out;
}
