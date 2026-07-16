// Streamable-HTTP mount for the MCP server (stateless mode).
//
// Each POST /mcp request gets a fresh McpServer + transport — all real state
// lives in the app's database, so no session bookkeeping is needed, and
// progress notifications still stream on the POST response's SSE leg.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './index.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function mountMcp(app, { baseUrl, getSettings, notifyMutation }) {
  const handler = async (req, res) => {
    try {
      const settings = await getSettings().catch(() => null);
      const mcpSettings = settings?.mcp || {};

      if (mcpSettings.enabled === false) {
        return res.status(404).json({ error: 'MCP server is disabled in Settings' });
      }

      const token = String(mcpSettings.token || '');
      if (token) {
        if (req.headers.authorization !== `Bearer ${token}`) {
          return res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized: invalid or missing bearer token' },
            id: null
          });
        }
      } else if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) {
        // Without a token, only local clients may connect (the server binds
        // all interfaces). Set settings.mcp.token to allow remote access.
        return res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Forbidden: remote access requires a bearer token (settings.mcp.token)' },
          id: null
        });
      }

      if (req.method !== 'POST') {
        // Stateless mode: no server-initiated GET stream, no DELETE sessions.
        res.setHeader('Allow', 'POST');
        return res.status(405).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed (stateless MCP endpoint — use POST)' },
          id: null
        });
      }

      const server = buildMcpServer({ baseUrl, notifyMutation });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      // The app's global express.json() already parsed the body — pass it in.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  };

  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
