#!/usr/bin/env node
// stdio entry point for MCP clients that spawn a process (e.g. Claude Desktop
// local servers). It is a thin bridge: tools still call the RUNNING 3D Gen
// Studio backend over loopback HTTP — this process never opens the database.
//
// Usage: node mcp/stdio.js        (app must be running, default :3001)
//        GENSTUDIO_URL=http://localhost:3001 node mcp/stdio.js
import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './index.js';

const baseUrl = (process.env.GENSTUDIO_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/+$/, '');

try {
  const res = await fetch(`${baseUrl}/api/projects`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`3D Gen Studio is not reachable at ${baseUrl} (${err?.message || err}).`);
  console.error('Start the app first (npm run dev, or launch the desktop app), then retry.');
  process.exit(1);
}

const server = buildMcpServer({ baseUrl });
await server.connect(new StdioServerTransport());
