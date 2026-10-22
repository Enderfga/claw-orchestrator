#!/usr/bin/env node
/**
 * clawo-mcp over streamable HTTP, bound to a Tailscale address only.
 *
 *   CLAWO_MCP_HOST=100.x.y.z CLAWO_MCP_PORT=18798 CLAWO_MCP_TOKEN=... node dist/bin/mcp-http.js
 *
 * Refuses 0.0.0.0, loopback, and public addresses. Requires a bearer token of
 * at least 32 characters. CLAWO_MCP_TOOLS defaults to the workflow/council
 * allowlist in src/mcp/http-policy.ts so a remote caller is not handed every tool.
 * *_start handlers still run resource-gate.sh (see src/mcp/resource-gate.ts).
 */
import http from 'node:http';
import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { assertTailnetHost, bearerOk, DEFAULT_TAILNET_TOOLS } from '../src/mcp/http-policy.js';

process.env.CLAWO_NO_EMBEDDED_SERVER ??= '1';
process.env.CLAWO_MCP_TOOLS ??= DEFAULT_TAILNET_TOOLS;

const host = process.env.CLAWO_MCP_HOST ?? '';
const port = Number(process.env.CLAWO_MCP_PORT ?? '18798');
const token = process.env.CLAWO_MCP_TOKEN ?? '';

assertTailnetHost(host);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CLAWO_MCP_PORT must be an integer port');
}
if (token.length < 32) {
  throw new Error('CLAWO_MCP_TOKEN is required and must be at least 32 characters');
}

const { default: plugin } = await import('../src/index.js');

type AgentToolResult = { content: Array<{ type: string; text?: string }>; details: unknown };
type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<AgentToolResult>;
};

const captured: ToolDef[] = [];
plugin.register({
  pluginConfig: {},
  logger: {
    info: (...args: unknown[]) => console.error('[clawo-mcp-http]', ...args),
    warn: (...args: unknown[]) => console.error('[clawo-mcp-http]', ...args),
    error: (...args: unknown[]) => console.error('[clawo-mcp-http]', ...args),
  },
  registerTool: (def: ToolDef) => {
    captured.push(def);
  },
  on: () => {},
  registerHttpRoute: () => {},
  registerService: () => {},
} as unknown as Parameters<typeof plugin.register>[0]);

const allow = new Set(
  (process.env.CLAWO_MCP_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const tools = captured.filter((t) => allow.has(t.name));
if (tools.length === 0) {
  throw new Error('CLAWO_MCP_TOOLS matched no tools');
}

function pkgVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function newSession(): { server: Server; transport: StreamableHTTPServerTransport } {
  const server = new Server({ name: 'claw-orchestrator', version: pkgVersion() }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.execute(`mcp-${Date.now()}`, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: result.content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text' as const, text: msg }] };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  return { server, transport };
}

const listener = http.createServer((req, res) => {
  if (!bearerOk(req.headers.authorization, token)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  const { server, transport } = newSession();
  void server
    .connect(transport)
    .then(() => transport.handleRequest(req, res))
    .catch((err) => {
      console.error('[clawo-mcp-http]', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('error');
      }
    })
    .finally(() => {
      void transport.close();
      void server.close();
    });
});

listener.listen(port, host, () => {
  console.error(`[clawo-mcp-http] listening on http://${host}:${port}/mcp tools=${tools.map((t) => t.name).join(',')}`);
});
