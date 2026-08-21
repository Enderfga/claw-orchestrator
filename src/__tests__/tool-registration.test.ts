import { describe, it, expect } from 'vitest';
import plugin from '../index.js';
import { ENGINE_TYPES } from '../types.js';
import type { PluginConfig, PermissionMode, EffortLevel } from '../types.js';

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface RegisteredRoute {
  path: string;
}

function collectRegistration(): { tools: RegisteredTool[]; routes: RegisteredRoute[] } {
  const tools: RegisteredTool[] = [];
  const routes: RegisteredRoute[] = [];
  // Minimal stub PluginAPI — just enough to capture registration calls.
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: { name: string; description: string; parameters: Record<string, unknown> }) => {
      tools.push({ name: def.name, description: def.description, parameters: def.parameters });
    },
    on: () => {},
    registerHttpRoute: (def: { path: string }) => {
      routes.push({ path: def.path });
    },
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return { tools, routes };
}

const CANONICAL_RENAMED_TOOLS = [
  'session_start',
  'session_send',
  'session_stop',
  'session_list',
  'sessions_overview',
  'coding_session_status',
  'session_grep',
  'session_compact',
  'coding_agents_list',
  'team_list',
  'team_send',
  'session_update_tools',
  'session_switch_model',
  'project_purge',
  'session_send_to',
  'session_inbox',
  'session_deliver_inbox',
];

const UNCHANGED_TOOLS = [
  'codex_resume',
  'codex_review',
  'codex_goal_set',
  'codex_goal_get',
  'codex_goal_pause',
  'codex_goal_resume',
  'codex_goal_clear',
  'council_start',
  'council_status',
  'council_abort',
  'council_inject',
  'council_review',
  'council_accept',
  'council_reject',
  'ultraplan_start',
  'ultraplan_status',
  'ultrareview_start',
  'ultrareview_status',
];

describe('plugin tool registration', () => {
  const { tools, routes } = collectRegistration();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const routePaths = new Set(routes.map((r) => r.path));

  it('registers all canonical engine-neutral tool names', () => {
    for (const name of CANONICAL_RENAMED_TOOLS) {
      expect(byName.has(name), `missing canonical tool: ${name}`).toBe(true);
    }
  });

  it('does not register deprecated engine-coupled aliases', () => {
    // v3.0 aliases (claude_session_*, claude_team_*, etc.) were removed in v3.1.
    // The `claude_goal_*` family (4.1.0+) and `claude_agents_list` (4.2.0+) are
    // allowed because they wrap genuinely Claude-CLI-specific subcommands and
    // mirror the existing `codex_*` naming.
    const allowedClaudeTools = new Set([
      'claude_goal_set',
      'claude_goal_clear',
      'claude_goal_status',
      'claude_agents_list',
    ]);
    for (const tool of tools) {
      if (allowedClaudeTools.has(tool.name)) continue;
      expect(tool.name.startsWith('claude_'), `deprecated alias still registered: ${tool.name}`).toBe(false);
    }
  });

  it('keeps codex_*, council_*, ultra* tool names unchanged', () => {
    for (const name of UNCHANGED_TOOLS) {
      expect(byName.has(name), `missing unchanged tool: ${name}`).toBe(true);
    }
  });

  it('keeps the legacy proxy route as a compatibility alias', () => {
    expect(routePaths.has('/v1/claw-orchestrator-proxy')).toBe(true);
    expect(routePaths.has('/v1/claude-code-proxy')).toBe(true);
  });

  it('registers the full ultraapp MCP tool surface (read + write)', () => {
    const ULTRAAPP_TOOLS = [
      // read
      'ultraapp_list',
      'ultraapp_get',
      'ultraapp_status',
      // write
      'ultraapp_new',
      'ultraapp_answer',
      'ultraapp_add_file',
      'ultraapp_spec_edit',
      'ultraapp_build_start',
      'ultraapp_build_cancel',
      'ultraapp_feedback',
      'ultraapp_promote_version',
      'ultraapp_start_container',
      'ultraapp_stop_container',
      'ultraapp_delete',
    ];
    for (const name of ULTRAAPP_TOOLS) {
      expect(byName.has(name), `missing ultraapp tool: ${name}`).toBe(true);
    }
  });

  it('exposes sandboxMode on session_start for cross-engine read-only sessions', () => {
    const tool = byName.get('session_start');
    expect(tool).toBeDefined();
    const properties = (tool!.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
    expect(properties.sandboxMode?.enum).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
  });

  it('exposes independent role engines and trusted custom configs on autoloop_start', () => {
    const tool = byName.get('autoloop_start');
    expect(tool).toBeDefined();
    expect(tool!.description).not.toContain('persistent Planner (Claude Opus by default)');
    const properties = (tool!.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;

    for (const role of ['planner', 'coder', 'reviewer'] as const) {
      expect(properties[`${role}_engine`]?.enum).toEqual(ENGINE_TYPES);
      expect(properties[`${role}_model`]?.type).toBe('string');
      expect(properties[`${role}_custom_engine`]?.type).toBe('object');
      expect(properties[`${role}_custom_engine`]?.required).toEqual(['name', 'bin', 'args']);
    }
  });

  it('registers the v4.2.0 tools (codex app-server RPCs, claude_agents_list, fan-out)', () => {
    const NEW_4_2_0_TOOLS = [
      'codex_interrupt',
      'codex_steer',
      'codex_fork',
      'codex_rollback',
      'codex_models',
      'codex_threads',
      'claude_agents_list',
      'fanout_start',
      'fanout_status',
      'fanout_abort',
    ];
    for (const name of NEW_4_2_0_TOOLS) {
      expect(byName.has(name), `missing v4.2.0 tool: ${name}`).toBe(true);
    }
  });
});

// The OpenClaw plugin manifest declares the tool contract separately from the
// code that registers them, so the two drift silently: six `autoloop_*` tools
// were registered for releases without ever being declared, and three files
// quoted three different tool counts (69 registered, 65 in the README, 63 in the
// manifest and CLAUDE.md). A host that trusts the manifest simply never sees the
// undeclared tools. Parity is cheap to assert, so assert it rather than relying
// on remembering the convention.
describe('openclaw.plugin.json parity', () => {
  it('declares exactly the tools the plugin registers', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '../../openclaw.plugin.json'), 'utf8')) as {
      contracts: { tools: string[] };
    };

    const registered = collectRegistration().tools.map((t) => t.name);
    const declared = manifest.contracts.tools;

    // Sorted comparison, so the failure message names the offending tools
    // rather than reporting an opaque count mismatch.
    expect([...declared].sort()).toEqual([...registered].sort());
  });

  it('registers no duplicate tool names', () => {
    const names = collectRegistration().tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // The tool contract was asserted above while `configSchema` was not, and it
  // drifted the same way for the same reason: `pricingOverrides` was a real
  // PluginConfig field the manifest never declared, and two enums went stale
  // against their types. Values matter as much as keys here — the host validates
  // config against this schema and refuses to load the plugin when it fails, so
  // a missing enum member is not cosmetic: `defaultPermissionMode: 'manual'`,
  // the name current CLIs use, could not be configured at all.
  it('declares exactly the PluginConfig fields, with matching enums', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '../../openclaw.plugin.json'), 'utf8')) as {
      configSchema: { properties: Record<string, { enum?: string[] }> };
    };

    // Exhaustive by construction: adding a PluginConfig field without adding it
    // here is a compile error, so this list cannot silently fall behind.
    const expected: Record<keyof PluginConfig, true> = {
      claudeBin: true,
      defaultModel: true,
      defaultPermissionMode: true,
      defaultEffort: true,
      maxConcurrentSessions: true,
      sessionTtlMinutes: true,
      proxy: true,
      pricingOverrides: true,
    };

    expect(Object.keys(manifest.configSchema.properties).sort()).toEqual(Object.keys(expected).sort());

    // The enums are the values a host will reject config against, so compare
    // them to the unions they mirror rather than trusting them to keep up.
    const permissionModes: PermissionMode[] = [
      'acceptEdits',
      'bypassPermissions',
      'default',
      'manual',
      'dontAsk',
      'plan',
      'auto',
    ];
    const effortLevels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

    expect([...(manifest.configSchema.properties.defaultPermissionMode.enum ?? [])].sort()).toEqual(
      [...permissionModes].sort(),
    );
    expect([...(manifest.configSchema.properties.defaultEffort.enum ?? [])].sort()).toEqual([...effortLevels].sort());
  });
});
