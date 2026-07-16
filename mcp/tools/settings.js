import { toolHandler } from '../client.js';

const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|credential|authorization)/i;

// Recursively replace secret-looking string values so API keys configured in
// Settings never leave the machine through an MCP client.
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) && typeof item === 'string' && item.length > 0
        ? '***redacted***'
        : redactSecrets(item);
    }
    return out;
  }
  return value;
}

export function registerSettingsTools(server, { api }) {
  server.registerTool('get_settings', {
    title: 'Get settings (redacted)',
    description: 'Read the app settings — which AI providers and custom APIs are configured (their ids for selectedApi), service URLs (ComfyUI, mesh tools, rigging), and preferences. All API keys and secrets are redacted.',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => redactSecrets(await api.apiJson('GET', '/settings'))));

  server.registerTool('get_system_stats', {
    title: 'Get system stats',
    description: 'Live CPU, RAM, and GPU usage of the machine running 3D Gen Studio.',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => api.apiJson('GET', '/system/stats')));
}
