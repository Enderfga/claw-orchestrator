#!/usr/bin/env node
/**
 * claw-orchestrator MCP server
 *
 * Exposes the orchestrator's tool surface over the Model Context Protocol
 * (stdio transport). Drop into any MCP-compatible host (Hermes Agent, Claude
 * Desktop, Cursor, Cline, Continue, Zed, Windsurf, Goose, …) by adding it
 * to that host's MCP server config.
 *
 * Implementation: feed `plugin.register()` a capturing PluginAPI shim, then
 * translate each captured tool into MCP `tools/list` + `tools/call`. This
 * keeps a single tool definition site (`src/index.ts`) shared between the
 * OpenClaw plugin entry and the MCP entry — no schema drift between them.
 *
 * Stdout is reserved for the MCP protocol — every log line goes to stderr.
 *
 * Environment variables read at startup:
 *   CLAWO_MCP_TOOLS         comma-separated allowlist of tool names. Unlisted
 *                            tools are not exposed. Useful when the host has a
 *                            tight tool budget (default: expose everything).
 *   CLAWO_NO_EMBEDDED_SERVER set automatically; suppresses the plugin's HTTP
 *                            control-plane (port 18796) which is dead weight
 *                            for MCP-only deployments.
 */
import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// The plugin lazily starts EmbeddedServer on first tool call unless this is
// set. Set before importing so the env is seen on the very first invocation.
process.env.CLAWO_NO_EMBEDDED_SERVER ??= '1';

const { default: plugin } = await import('../src/index.js');

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

type Annotation = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

// Hand-curated hints. MCP hosts surface these to the model so it can pick
// safer tools first (Hermes / Cursor / Claude Desktop all read them).
//
//   readOnly      — does not mutate workspace, sessions, files, or branches
//   destructive   — irreversible side-effects (delete worktree, drop branch, kill process)
//   openWorld     — touches things outside the local machine (model APIs)
const ANNOTATIONS: Record<string, Annotation> = {
  // pure reads
  session_list: { readOnlyHint: true, idempotentHint: true },
  sessions_overview: { readOnlyHint: true, idempotentHint: true },
  coding_session_status: { readOnlyHint: true, idempotentHint: true },
  session_grep: { readOnlyHint: true, idempotentHint: true },
  session_inbox: { readOnlyHint: true, idempotentHint: true },
  coding_agents_list: { readOnlyHint: true, idempotentHint: true },
  team_list: { readOnlyHint: true, idempotentHint: true },
  council_status: { readOnlyHint: true, idempotentHint: true },
  council_review: { readOnlyHint: true, idempotentHint: true },
  ultraplan_status: { readOnlyHint: true, idempotentHint: true },
  ultrareview_status: { readOnlyHint: true, idempotentHint: true },
  autoloop_status: { readOnlyHint: true, idempotentHint: true },
  autoloop_list: { readOnlyHint: true, idempotentHint: true },
  codex_goal_get: { readOnlyHint: true, idempotentHint: true },
  // destructive
  session_stop: { destructiveHint: true },
  council_abort: { destructiveHint: true },
  council_accept: { destructiveHint: true },
  council_reject: { destructiveHint: true },
  autoloop_stop: { destructiveHint: true },
  project_purge: { destructiveHint: true },
  // mutating + open-world (call external model APIs)
  session_start: { openWorldHint: true },
  session_send: { openWorldHint: true },
  team_send: { openWorldHint: true },
  session_send_to: { openWorldHint: true },
  session_deliver_inbox: { openWorldHint: true },
  council_start: { openWorldHint: true },
  council_inject: { openWorldHint: true },
  ultraplan_start: { openWorldHint: true },
  ultrareview_start: { openWorldHint: true },
  autoloop_start: { openWorldHint: true },
  autoloop_chat: { openWorldHint: true },
  autoloop_reset_agent: {},
  codex_resume: { openWorldHint: true },
  codex_review: { openWorldHint: true },
  codex_goal_set: { openWorldHint: true },
  codex_goal_pause: {},
  codex_goal_resume: { openWorldHint: true },
  codex_goal_clear: {},
  session_compact: { openWorldHint: true },
  session_update_tools: {},
  session_switch_model: {},
};

const log = {
  info: (...args: unknown[]) => console.error('[clawo-mcp]', ...args),
  warn: (...args: unknown[]) => console.error('[clawo-mcp]', ...args),
  error: (...args: unknown[]) => console.error('[clawo-mcp]', ...args),
};

const captured: ToolDef[] = [];

const shim = {
  pluginConfig: {},
  logger: log,
  registerTool: (def: ToolDef) => {
    captured.push(def);
  },
  on: () => {},
  registerHttpRoute: () => {},
  registerService: () => {},
};

plugin.register(shim as unknown as Parameters<typeof plugin.register>[0]);

const allowlist = (process.env.CLAWO_MCP_TOOLS ?? '').trim();
const allowed = allowlist
  ? new Set(
      allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

const tools = allowed ? captured.filter((t) => allowed.has(t.name)) : captured;

if (allowed && tools.length === 0) {
  log.warn(`CLAWO_MCP_TOOLS filter matched 0 tools. Captured: ${captured.map((t) => t.name).join(', ')}`);
}

/**
 * The version reported to the MCP host.
 *
 * `npm_package_version` is only set for a process npm itself started, and an MCP
 * host spawns this binary directly — so that variable is never present here and
 * the literal fallback was what every host had been told since it was written.
 * Read the package's own manifest instead, the way `bin/cli.ts` does.
 */
function pkgVersion(): string {
  try {
    // From dist/bin/mcp-server.js, package.json sits two levels up.
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const PKG_VERSION = pkgVersion();

const server = new Server({ name: 'claw-orchestrator', version: PKG_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
    ...(ANNOTATIONS[t.name] ? { annotations: ANNOTATIONS[t.name] } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.execute(`mcp-${Date.now()}`, (req.params.arguments ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: msg }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

log.info(`mcp server ready — exposing ${tools.length} of ${captured.length} tools over stdio`);
