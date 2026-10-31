import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import plugin from '../index.js';
import { SessionManager } from '../session-manager.js';
import { ENGINE_TYPES, EFFORT_LEVELS } from '../types.js';
import { __rejectCustomEngineOverHttpForTest as rejectCustomEngineOverHttp } from '../embedded-server.js';
import { TOOL_ANNOTATIONS } from '../mcp-annotations.js';
import type { PluginConfig, PermissionMode, EffortLevel, ProxyConfig } from '../types.js';

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface RegisteredRoute {
  path: string;
}

interface RegisteredService {
  stop: () => void;
}

function collectRegistration(pluginConfig: Record<string, unknown> = {}): {
  tools: RegisteredTool[];
  routes: RegisteredRoute[];
  services: RegisteredService[];
} {
  const tools: RegisteredTool[] = [];
  const routes: RegisteredRoute[] = [];
  const services: RegisteredService[] = [];
  // Minimal stub PluginAPI — just enough to capture registration calls.
  const fakeApi = {
    pluginConfig,
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: RegisteredTool) => {
      tools.push(def);
    },
    on: () => {},
    registerHttpRoute: (def: { path: string }) => {
      routes.push({ path: def.path });
    },
    registerService: (def: RegisteredService) => {
      services.push(def);
    },
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return { tools, routes, services };
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

  // Both reach SessionConfig through the handler's spread, but a host that builds
  // calls from the declared schema never sends a field the schema does not name.
  it('declares restricted and ignoreUserConfig on session_start', () => {
    const properties = (byName.get('session_start')!.parameters.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.restricted?.type).toBe('boolean');
    expect(properties.ignoreUserConfig?.type).toBe('boolean');
  });

  it('declares the other SessionConfig fields session_start honours', () => {
    const properties = (byName.get('session_start')!.parameters.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    // `restricted` keeps the command-running tools that `tools` names.
    expect(properties.tools).toMatchObject({ type: ['string', 'array'], items: { type: 'string' } });
    expect(properties.addDir).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(properties.pluginUrl).toMatchObject({ type: ['string', 'array'], items: { type: 'string' } });
    expect(properties.launcher).toMatchObject({ type: 'array', items: { type: 'string' } });
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
      // Every engine but acp: a role cannot name the ACP agent an acp engine starts.
      expect(properties[`${role}_engine`]?.enum).toEqual(ENGINE_TYPES.filter((e) => e !== 'acp'));
      expect(properties[`${role}_model`]?.type).toBe('string');
      expect(properties[`${role}_effort`]?.enum).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto']);
      expect(properties[`${role}_custom_engine`]?.type).toBe('object');
      expect(properties[`${role}_custom_engine`]?.required).toEqual(['name', 'bin', 'args']);
    }
  });

  it('declares exact Autoloop timeout bounds/defaults and forwards the snake_case values once', async () => {
    const registration = collectRegistration();
    const tool = registration.tools.find((candidate) => candidate.name === 'autoloop_start');
    expect(tool).toBeDefined();
    const properties = (tool!.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;

    expect(properties.send_timeout_ms).toMatchObject({
      type: 'number',
      default: 600_000,
      minimum: 5_000,
      maximum: 7_200_000,
    });
    expect(properties.activity_lease_ms).toMatchObject({
      type: 'number',
      default: 1_800_000,
      minimum: 60_000,
      maximum: 7_200_000,
    });
    expect(properties.autoloop_hard_timeout_ms).toMatchObject({
      type: 'number',
      default: 86_400_000,
      minimum: 600_000,
      maximum: 259_200_000,
    });
    for (const field of ['send_timeout_ms', 'activity_lease_ms', 'autoloop_hard_timeout_ms']) {
      expect(properties[field].description).toEqual(expect.any(String));
      expect(String(properties[field].description).length).toBeGreaterThan(20);
    }

    const start = vi.spyOn(SessionManager.prototype, 'autoloopStart').mockResolvedValue({
      runId: 'tool-timeouts',
      plannerSession: 'autoloop-tool-timeouts-planner',
      state: {} as never,
    });
    // The handler canonicalises the workspace, and on macOS `/tmp` is a symlink
    // to `/private/tmp` — so a literal `/tmp` here fails the round-trip on every
    // Mac while passing on the Linux runner. Start from the resolved path.
    const workspace = fs.realpathSync(os.tmpdir());
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    try {
      await tool!.execute('timeout-contract', {
        run_id: 'tool-timeouts',
        workspace,
        send_timeout_ms: 7_200_000,
        activity_lease_ms: 60_000,
        autoloop_hard_timeout_ms: 259_200_000,
        planner_effort: 'high',
        coder_effort: 'ultra',
        reviewer_effort: 'low',
      });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'tool-timeouts',
          workspace,
          sendTimeoutMs: 7_200_000,
          activityLeaseMs: 60_000,
          autoloopHardTimeoutMs: 259_200_000,
          plannerEffort: 'high',
          coderEffort: 'ultra',
          reviewerEffort: 'low',
        }),
      );
    } finally {
      registration.services[0]?.stop();
      start.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
    }
  });

  it('rejects malformed tool timeout values before invoking autoloopStart', async () => {
    const registration = collectRegistration();
    const tool = registration.tools.find((candidate) => candidate.name === 'autoloop_start')!;
    const start = vi
      .spyOn(SessionManager.prototype, 'autoloopStart')
      .mockRejectedValue(new Error('autoloopStart must not be reached'));

    try {
      for (const invalid of [
        { send_timeout_ms: 4_999 },
        { send_timeout_ms: 7_200_001 },
        { send_timeout_ms: Number.POSITIVE_INFINITY },
        { activity_lease_ms: 59_999 },
        { activity_lease_ms: '1800000' },
        { autoloop_hard_timeout_ms: 599_999 },
        { autoloop_hard_timeout_ms: Number.NaN },
      ]) {
        await expect(
          tool.execute('invalid-timeout', { run_id: 'invalid-timeout', workspace: '/tmp', ...invalid }),
        ).rejects.toThrow(/must be a finite number in the inclusive range/);
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      registration.services[0]?.stop();
      start.mockRestore();
    }
  });

  it('registers the v4.2.0 tools (codex app-server RPCs, claude_agents_list, fan-out)', () => {
    const NEW_4_2_0_TOOLS = [
      'codex_interrupt',
      'codex_steer',
      'codex_fork',
      'codex_rollback',
      'codex_models',
      'codex_thread_list',
      'claude_agents_list',
      'fanout_start',
      'fanout_status',
      'fanout_abort',
    ];
    for (const name of NEW_4_2_0_TOOLS) {
      expect(byName.has(name), `missing v4.2.0 tool: ${name}`).toBe(true);
    }
  });

  it('exposes the full reasoning-effort domain for fanout and workflow agents', () => {
    const expected = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto'];
    const propertiesOf = (toolName: string) =>
      (byName.get(toolName)!.parameters as { properties: Record<string, unknown> }).properties;
    const itemProperties = (value: unknown) =>
      (value as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;

    const fanout = propertiesOf('fanout_start');
    const workflow = propertiesOf('workflow_start');

    expect(itemProperties(fanout.agents).effort.enum).toEqual(expected);
    expect(itemProperties(workflow.agents).effort.enum).toEqual(expected);
    expect(itemProperties(workflow.reviewers).effort.enum).toEqual(expected);
  });

  it('exposes persona as role instructions on fanout agents without changing prompt', () => {
    const properties = (
      byName.get('fanout_start')!.parameters as {
        properties: {
          agents: {
            items: {
              properties: Record<string, { type?: string; description?: string }>;
            };
          };
        };
      }
    ).properties.agents.items.properties;

    expect(properties.persona).toMatchObject({
      type: 'string',
      description: expect.stringMatching(/role.*shared task/i),
    });
    expect(properties.prompt).toMatchObject({
      type: 'string',
      description: expect.stringMatching(/replace.*shared task/i),
    });
  });

  it('exposes permissionMode and sandboxMode on fanout_start agents with session_start enums', () => {
    const sessionProps = (byName.get('session_start')!.parameters.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const fanoutProps = (
      byName.get('fanout_start')!.parameters as {
        properties: {
          agents: {
            items: {
              properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
            };
          };
        };
      }
    ).properties.agents.items.properties;

    expect(fanoutProps.permissionMode?.enum).toEqual(sessionProps.permissionMode?.enum);
    expect(fanoutProps.sandboxMode?.enum).toEqual(sessionProps.sandboxMode?.enum);

    const agentsDescription = String(
      (byName.get('fanout_start')!.parameters as { properties: { agents: { description?: string } } }).properties.agents
        .description,
    );
    const permissionDescription = String(fanoutProps.permissionMode?.description ?? '');
    const sandboxDescription = String(fanoutProps.sandboxMode?.description ?? '');

    // Wording must track session_start per-engine handling — not Claude-only plan
    // claims or a universal engine-agnostic sandbox guarantee.
    expect(permissionDescription).toMatch(/session_start/i);
    expect(permissionDescription).toMatch(/engine/i);
    expect(permissionDescription).not.toMatch(/plan binds Claude only/i);
    expect(sandboxDescription).toMatch(/session_start/i);
    expect(sandboxDescription).toMatch(/read-only/i);
    expect(sandboxDescription).toMatch(/per-engine|same values/i);
    expect(sandboxDescription).not.toMatch(/engine-agnostic/i);
    expect(agentsDescription).toMatch(/permissionMode/i);
    expect(agentsDescription).toMatch(/sandboxMode/i);
    expect(agentsDescription).toMatch(/read-only/i);
    expect(agentsDescription).toMatch(/sandboxMode uses the same values and per-engine behavior as session_start/i);
    expect(agentsDescription).not.toMatch(/plan binds Claude only/i);
    expect(agentsDescription).not.toMatch(/sandboxMode is engine-agnostic/i);
  });

  it('fanout_start execute forwards per-agent permissionMode and sandboxMode', async () => {
    const registration = collectRegistration();
    const tool = registration.tools.find((candidate) => candidate.name === 'fanout_start');
    expect(tool).toBeDefined();
    const start = vi.spyOn(SessionManager.prototype, 'fanoutStart').mockResolvedValue({
      id: 'fanout-perm',
      status: 'running',
      results: [],
    } as never);
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    const projectDir = fs.realpathSync(os.tmpdir());
    try {
      await tool!.execute('fanout-perm-contract', {
        task: 'answer once',
        projectDir,
        agents: [
          {
            name: 'ro',
            engine: 'codex',
            permissionMode: 'plan',
            sandboxMode: 'read-only',
          },
        ],
      });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'answer once',
          projectDir,
          agents: [
            expect.objectContaining({
              name: 'ro',
              engine: 'codex',
              permissionMode: 'plan',
              sandboxMode: 'read-only',
            }),
          ],
        }),
      );
    } finally {
      registration.services[0]?.stop();
      start.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
    }
  });

  it('lets every surface that offers engine acp name the ACP agent, and no other surface offer it', () => {
    type Props = Record<string, { type?: string; enum?: string[]; items?: { properties?: Props; enum?: string[] } }>;
    const props = (name: string) => (byName.get(name)!.parameters.properties ?? {}) as Props;
    const items = (name: string, field: string) => props(name)[field]!.items!.properties!;

    expect(props('session_handoff').acpAgent).toBeDefined();
    expect(items('fanout_start', 'agents').acpAgent).toMatchObject({ type: 'string' });
    expect(props('fanout_start').synthesisAcpAgent).toMatchObject({ type: 'string' });
    expect(items('council_start', 'agents').acpAgent).toMatchObject({ type: 'string' });
    expect(items('workflow_start', 'agents').acpAgent).toMatchObject({ type: 'string' });
    expect(items('workflow_start', 'reviewers').acpAgent).toMatchObject({ type: 'string' });
    expect((props('workflow_start').implementer as unknown as { properties: Props }).properties.acpAgent).toBeDefined();

    expect(props('ultrareview_start').engines!.items!.enum).not.toContain('acp');
    for (const role of ['planner_engine', 'coder_engine', 'reviewer_engine']) {
      expect(props('autoloop_start')[role]!.enum, role).not.toContain('acp');
    }
  });

  // These three reach `_createSession`, which expands a string through
  // resolveCustomEngine. A host that validates arguments against the schema
  // refuses `customEngine: "zcode"` when the schema says object only.
  it('accepts a preset id or an inline config for customEngine where a preset id is resolved', () => {
    type Schema = { type?: string; oneOf?: Schema[]; required?: string[]; items?: { properties?: Props } };
    type Props = Record<string, Schema>;
    const props = (name: string) => (byName.get(name)!.parameters.properties ?? {}) as Props;
    const branches = (s: Schema) => s.oneOf ?? [s];

    for (const [where, schema] of [
      ['session_start', props('session_start').customEngine],
      ['session_handoff', props('session_handoff').customEngine],
      ['council_start agents', props('council_start').agents!.items!.properties!.customEngine],
    ] as const) {
      expect(
        branches(schema!).some((b) => b.type === 'string'),
        where,
      ).toBe(true);
      expect(branches(schema!).find((b) => b.type === 'object')?.required, where).toEqual(['name', 'bin', 'args']);
    }
  });

  // Both lists come from disk — the resume registry and the durable run store —
  // so a process that has run no other tool yet still has them to report.
  it('session_list and autoloop_list report persisted state on a fresh process', async () => {
    // One registration each: the first call through either one starts its manager.
    const forSessions = collectRegistration();
    const forLoops = collectRegistration();
    const tool = (registration: typeof forSessions, name: string) => registration.tools.find((t) => t.name === name)!;
    const persisted = vi
      .spyOn(SessionManager.prototype, 'listPersistedSessions')
      .mockReturnValue([{ name: 'kept' }] as never);
    const runs = vi.spyOn(SessionManager.prototype, 'autoloopList').mockReturnValue([{ runId: 'loop-1' }] as never);
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    try {
      expect(await tool(forSessions, 'session_list').execute('l', {})).toMatchObject({
        details: { ok: true, sessions: [], persisted: [{ name: 'kept' }] },
      });
      expect(await tool(forLoops, 'autoloop_list').execute('a', {})).toMatchObject({
        details: { ok: true, runs: [{ runId: 'loop-1' }] },
      });
    } finally {
      forSessions.services[0]?.stop();
      forLoops.services[0]?.stop();
      persisted.mockRestore();
      runs.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
    }
  });

  // A pass the tree moved away from ends `unverified`, which otherwise reads as
  // "no contract was declared"; the reason is what tells the two apart.
  it('workflow_status reports why the outcome is what it is, and the verdict in force', async () => {
    const registration = collectRegistration();
    const reason = 'evidence ev-1 passed, but the working tree changed afterwards';
    const verdict = { node: 'verify', evidenceId: 'ev-1', treeFingerprint: 'abc', sideEffectSeq: 2 };
    const status = vi.spyOn(SessionManager.prototype, 'workflowStatus').mockReturnValue({
      runId: 'wf-1',
      workflow: 'solve',
      state: 'completed',
      outcome: 'unverified',
      outcomeReason: reason,
      verdict,
      nodes: {},
    } as never);
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    try {
      const result = await registration.tools
        .find((t) => t.name === 'workflow_status')!
        .execute('s', { runId: 'wf-1' });
      expect(result).toMatchObject({ details: { outcome: 'unverified', outcomeReason: reason, verdict } });
    } finally {
      registration.services[0]?.stop();
      status.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
    }
  });

  it('session_handoff and fanout_start forward the ACP agent they are given', async () => {
    const registration = collectRegistration();
    const tool = (name: string) => registration.tools.find((t) => t.name === name)!;
    const handoff = vi
      .spyOn(SessionManager.prototype, 'handoffSession')
      .mockResolvedValue({ name: 'b', engine: 'acp' } as never);
    const fanout = vi
      .spyOn(SessionManager.prototype, 'fanoutStart')
      .mockResolvedValue({ id: 'f', status: 'running', results: [] } as never);
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    try {
      await tool('session_handoff').execute('h', { name: 'a', engine: 'acp', acpAgent: 'kimi-code' });
      expect(handoff).toHaveBeenCalledWith('a', expect.objectContaining({ engine: 'acp', acpAgent: 'kimi-code' }));

      await tool('fanout_start').execute('f', {
        task: 't',
        projectDir: fs.realpathSync(os.tmpdir()),
        agents: [{ name: 'k', engine: 'acp', acpAgent: 'kimi-code' }],
        synthesize: true,
        synthesisEngine: 'acp',
        synthesisAcpAgent: 'dsh',
      });
      expect(fanout).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [expect.objectContaining({ acpAgent: 'kimi-code' })],
          synthesisEngine: 'acp',
          synthesisAcpAgent: 'dsh',
        }),
      );
    } finally {
      registration.services[0]?.stop();
      handoff.mockRestore();
      fanout.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
    }
  });

  it('forwards maxRounds to the council template of workflow_start', async () => {
    const registration = collectRegistration();
    const tool = registration.tools.find((candidate) => candidate.name === 'workflow_start')!;
    const properties = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
    expect(properties.maxRounds?.type).toBe('number');

    const start = vi
      .spyOn(SessionManager.prototype, 'workflowStart')
      .mockResolvedValue({ runId: 'r', workflow: 'council', state: 'pending', nodes: {} } as never);
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    try {
      await tool.execute('council-rounds', {
        template: 'council',
        task: 'do the thing',
        agents: [{ name: 'a' }, { name: 'b' }],
        maxRounds: 3,
      });
      const spec = start.mock.calls[0][0] as { nodes: Array<{ maxRounds?: number }> };
      expect(spec.nodes[0].maxRounds).toBe(3);
    } finally {
      registration.services[0]?.stop();
      start.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
    }
  });

  it('council_abort reports ok: false when nothing was running to abort', async () => {
    const registration = collectRegistration();
    const tool = registration.tools.find((candidate) => candidate.name === 'council_abort')!;
    const abort = vi
      .spyOn(SessionManager.prototype, 'councilAbort')
      .mockReturnValueOnce({ aborted: false, state: 'completed', reason: 'not running in this process' })
      .mockReturnValueOnce({ aborted: true });
    const previousNoServer = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    const details = async (id: string) => ((await tool.execute(id, { id })) as { details: unknown }).details;
    try {
      expect(await details('c1')).toEqual({
        ok: false,
        aborted: false,
        state: 'completed',
        error: 'not running in this process',
      });
      expect(await details('c2')).toEqual({ ok: true, aborted: true });
    } finally {
      registration.services[0]?.stop();
      abort.mockRestore();
      if (previousNoServer === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previousNoServer;
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
    // The runtime list rather than a copy, which falls behind when a level is added.
    const effortLevels: readonly EffortLevel[] = EFFORT_LEVELS;

    expect([...(manifest.configSchema.properties.defaultPermissionMode.enum ?? [])].sort()).toEqual(
      [...permissionModes].sort(),
    );
    expect([...(manifest.configSchema.properties.defaultEffort.enum ?? [])].sort()).toEqual([...effortLevels].sort());
  });

  // The host fills declared defaults into the config before register() sees it,
  // so a `proxy` block that leaves `enabled` out arrives carrying the manifest's
  // default. That has to do what no `proxy` block at all does, or adding any
  // other proxy key would switch the routes off.
  it('declares the proxy default the plugin applies, and only the proxy fields it reads', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '../../openclaw.plugin.json'), 'utf8')) as {
      configSchema: { properties: { proxy: { properties: Record<string, { default?: unknown }> } } };
    };
    const declared = manifest.configSchema.properties.proxy.properties;
    const routesWith = (pluginConfig: Record<string, unknown>) =>
      collectRegistration(pluginConfig)
        .routes.map((r) => r.path)
        .sort();

    expect(routesWith({ proxy: { enabled: declared.enabled?.default } })).toEqual(routesWith({}));

    const read: Record<keyof ProxyConfig, true> = { enabled: true };
    expect(Object.keys(declared).sort()).toEqual(Object.keys(read).sort());
  });

  // A host echoes the tool list back inside its request, so every schema this
  // plugin registers ends up as request-body content. Several of them describe
  // custom-engine properties — `session_start.customEngine`,
  // `autoloop_start.{planner,coder,reviewer}_custom_engine`, and
  // `council_start.agents.items.properties.customEngine`, which sits deeper and
  // behind an array. The HTTP guard used to match any object under such a key,
  // so it rejected the whole request and every tool-bearing turn through
  // `/v1/chat/completions` returned 400. Checked against the real registry
  // rather than a fixture, so a tool added later is covered too.
  it('does not let the HTTP custom-engine guard reject its own tool schemas', () => {
    const registration = collectRegistration();
    try {
      const asHostToolList = {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: registration.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      };

      expect(registration.tools.length).toBeGreaterThan(70);
      expect(rejectCustomEngineOverHttp(asHostToolList)).toBeNull();
    } finally {
      registration.services[0]?.stop();
    }
  });
});

// `clawo-mcp` advertises these to every MCP host. A tool without an entry gets
// the protocol's defaults — not read-only, possibly destructive, open-world — so
// a status poll looks as dangerous as a delete to a host deciding what may run
// unprompted.
describe('MCP tool annotations', () => {
  it('annotate every registered tool, and only registered tools', () => {
    const registered = collectRegistration().tools.map((t) => t.name);
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual([...registered].sort());
  });
});

describe('SDK entry', () => {
  it('exports the session class of every documented engine, and names ACP agents in the plugin description', async () => {
    const sdk: Record<string, unknown> = await import('../index.js');
    const { PersistentAcpSession } = await import('../persistent-acp-session.js');
    const { PersistentCodexAppServerSession } = await import('../persistent-codex-app-session.js');

    expect(sdk.PersistentAcpSession).toBe(PersistentAcpSession);
    expect(sdk.PersistentCodexAppServerSession).toBe(PersistentCodexAppServerSession);
    expect(plugin.description).toContain('any ACP agent');
  });
});

// Feature acceptance for the thin native autoloop_resume facade. Missing
// registration is RED for new exposure — not an existing-manager regression.
describe('native autoloop_resume facade', () => {
  const sampleState = {
    run_id: 'resume-run',
    status: 'planning',
    iter: 0,
    subagents_spawned: false,
    started_at: '2026-10-29T00:00:00.000Z',
    workspace: '/tmp',
    ledger_dir: '/tmp/tasks/resume-run',
    push_log_count: 0,
    status_reason: null,
    consecutive_phase_errors: 0,
    recent_phase_errors: [],
    metric_history: [],
    last_activity_at: 0,
  };

  function withNoEmbeddedServer<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.CLAWO_NO_EMBEDDED_SERVER;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    return fn().finally(() => {
      if (previous === undefined) delete process.env.CLAWO_NO_EMBEDDED_SERVER;
      else process.env.CLAWO_NO_EMBEDDED_SERVER = previous;
    });
  }

  it('public resume help distinguishes live pending no-op from cold reconstruction and conditional pending-ID', async () => {
    const registration = collectRegistration();
    try {
      const tool = registration.tools.find((t) => t.name === 'autoloop_resume');
      expect(tool).toBeDefined();
      const description = tool!.description;
      // Must not present the live send-timeout migration pair as a universal rule.
      expect(description).not.toMatch(
        /A recoverable send-timeout pause requires an explicit send_timeout_ms increase and the matching pending_dispatch_id/i,
      );
      expect(description).toMatch(/live/i);
      expect(description).toMatch(/no-op|unchanged/i);
      expect(description).toMatch(/cold/i);
      expect(description).toMatch(/reconstruct/i);
      expect(description).toMatch(/coexist|when (an |a )?increase.*pending|pending.*increase/i);
      expect(description).toMatch(/timeout-only|without pending/i);

      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const toolsMd = fs.readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../skills/references/tools.md'),
        'utf8',
      );
      const recoveryIdx = toolsMd.indexOf('Recovery is exposed by `autoloop_resume`');
      expect(recoveryIdx).toBeGreaterThan(-1);
      const recoveryBlock = toolsMd.slice(recoveryIdx, toolsMd.indexOf('### `autoloop_resume`', recoveryIdx));
      expect(recoveryBlock).toMatch(/live/i);
      expect(recoveryBlock).toMatch(/no-op|does not clear a pending send timeout/i);
      expect(recoveryBlock).toMatch(/cold/i);
      expect(recoveryBlock).toMatch(/reconstruct/i);
      expect(recoveryBlock).toMatch(/coexist|when (an |a )?increase.*pending|pending.*increase/i);
      expect(recoveryBlock).toMatch(/timeout-only|without pending/i);
      // Unqualified universal claim must not remain as the sole guidance.
      expect(recoveryBlock).not.toMatch(/^A no-option resume does not clear a pending send timeout\.\s*$/m);
    } finally {
      registration.services[0]?.stop();
    }
  });

  it('registers exactly one autoloop_resume with required run_id and optional migration/ref fields, no defaults', () => {
    const registration = collectRegistration();
    try {
      const matches = registration.tools.filter((t) => t.name === 'autoloop_resume');
      expect(matches).toHaveLength(1);
      const tool = matches[0]!;
      const parameters = tool.parameters as {
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
      };
      expect(parameters.required).toEqual(['run_id']);
      const properties = parameters.properties ?? {};
      expect(Object.keys(properties).sort()).toEqual(
        [
          'coderCustomEngineRef',
          'pending_dispatch_id',
          'plannerCustomEngineRef',
          'reviewerCustomEngineRef',
          'run_id',
          'send_timeout_ms',
        ].sort(),
      );
      expect(properties.run_id?.type).toBe('string');
      expect(properties.send_timeout_ms).toMatchObject({
        type: 'number',
        minimum: 5_000,
        maximum: 7_200_000,
      });
      expect(properties.send_timeout_ms).not.toHaveProperty('default');
      expect(properties.pending_dispatch_id?.type).toBe('string');
      expect(properties.pending_dispatch_id).not.toHaveProperty('default');
      for (const ref of ['plannerCustomEngineRef', 'coderCustomEngineRef', 'reviewerCustomEngineRef'] as const) {
        expect(properties[ref]?.type).toBe('string');
        expect(properties[ref]).not.toHaveProperty('default');
      }
      for (const forbidden of [
        'allow_decrease',
        'activity_lease_ms',
        'autoloop_hard_timeout_ms',
        'planner_engine',
        'coder_engine',
        'reviewer_engine',
        'planner_custom_engine',
        'coder_custom_engine',
        'reviewer_custom_engine',
        'restart',
      ]) {
        expect(properties).not.toHaveProperty(forbidden);
      }
    } finally {
      registration.services[0]?.stop();
    }
  });

  it('forwards explicit upper-bound and ordinary timeouts with pending identity once; omission keeps properties absent', async () => {
    await withNoEmbeddedServer(async () => {
      const registration = collectRegistration();
      const tool = registration.tools.find((t) => t.name === 'autoloop_resume');
      expect(tool).toBeDefined();
      const requirements = vi.spyOn(SessionManager.prototype, 'autoloopResumeRequirements');
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume').mockResolvedValue(sampleState as never);
      const workflowResume = vi.spyOn(SessionManager.prototype, 'workflowResume');
      try {
        const upper = await tool!.execute('resume-upper', {
          run_id: 'resume-run',
          send_timeout_ms: 7_200_000,
          pending_dispatch_id: 'dispatch-exact-1',
        });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(resume).toHaveBeenLastCalledWith('resume-run', {
          sendTimeoutMs: 7_200_000,
          pendingDispatchId: 'dispatch-exact-1',
        });
        expect((upper as { details: { ok: boolean; state: unknown } }).details.ok).toBe(true);
        expect((upper as { details: { state: unknown } }).details.state).toBe(sampleState);

        resume.mockClear();
        const ordinary = await tool!.execute('resume-ordinary', {
          run_id: 'resume-run',
          send_timeout_ms: 700_000,
          pending_dispatch_id: 'dispatch-exact-1',
        });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(resume).toHaveBeenLastCalledWith('resume-run', {
          sendTimeoutMs: 700_000,
          pendingDispatchId: 'dispatch-exact-1',
        });
        expect((ordinary as { details: { state: unknown } }).details.state).toBe(sampleState);

        resume.mockClear();
        await tool!.execute('resume-omit', { run_id: 'resume-run' });
        expect(resume).toHaveBeenCalledTimes(1);
        const omitOpts = resume.mock.calls[0]![1] as Record<string, unknown>;
        expect(omitOpts).toEqual({});
        expect(Object.prototype.hasOwnProperty.call(omitOpts, 'sendTimeoutMs')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(omitOpts, 'pendingDispatchId')).toBe(false);
        expect(requirements).not.toHaveBeenCalled();
        expect(workflowResume).not.toHaveBeenCalled();
      } finally {
        registration.services[0]?.stop();
        resume.mockRestore();
        requirements.mockRestore();
        workflowResume.mockRestore();
      }
    });
  });

  it('resolves only explicitly supplied custom-engine refs once and never retries after success or failure', async () => {
    await withNoEmbeddedServer(async () => {
      const registration = collectRegistration();
      const tool = registration.tools.find((t) => t.name === 'autoloop_resume')!;
      const plannerCfg = { name: 'planner-safe', bin: '/opt/planner-safe', args: {} };
      process.env.CLAWO_CUSTOM_ENGINE_PLANNER_SYN = JSON.stringify(plannerCfg);
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume').mockResolvedValue(sampleState as never);
      try {
        const result = await tool.execute('resume-ref', {
          run_id: 'resume-run',
          plannerCustomEngineRef: 'planner-syn',
        });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(resume).toHaveBeenLastCalledWith('resume-run', { plannerCustomEngine: plannerCfg });
        const details = (result as { details: Record<string, unknown> }).details;
        expect(JSON.stringify(details)).not.toContain('/opt/planner-safe');
        expect(JSON.stringify(details)).not.toContain('planner-safe');

        resume.mockRejectedValueOnce(new Error('manager rejected once'));
        await expect(tool.execute('resume-ref-fail', { run_id: 'resume-run' })).rejects.toThrow(
          'Autoloop resume failed',
        );
        expect(resume).toHaveBeenCalledTimes(2);
      } finally {
        delete process.env.CLAWO_CUSTOM_ENGINE_PLANNER_SYN;
        registration.services[0]?.stop();
        resume.mockRestore();
      }
    });
  });

  it('rejects malformed run/ref shapes and manager/sentinel failures with a fixed message and no second call', async () => {
    await withNoEmbeddedServer(async () => {
      const registration = collectRegistration();
      const tool = registration.tools.find((t) => t.name === 'autoloop_resume')!;
      const sentinel = 'SECRET_SENTINEL_DO_NOT_LEAK';
      const resume = vi.spyOn(SessionManager.prototype, 'autoloopResume');

      const assertFixed = async (params: Record<string, unknown>, expectManager = false) => {
        resume.mockClear();
        if (expectManager) {
          const err = new Error(`wrapped ${sentinel}`);
          (err as Error & { cause?: unknown }).cause = new Error(sentinel);
          (err as Error & { details?: unknown }).details = { content: sentinel };
          resume.mockRejectedValueOnce(err);
        }
        let caught: unknown;
        try {
          await tool.execute('resume-neg', params);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('Autoloop resume failed');
        expect((caught as Error).cause).toBeUndefined();
        expect(JSON.stringify(caught)).not.toContain(sentinel);
        expect(String((caught as Error & { details?: unknown }).details ?? '')).not.toContain(sentinel);
        if (expectManager) expect(resume).toHaveBeenCalledTimes(1);
        else expect(resume).not.toHaveBeenCalled();
      };

      try {
        await assertFixed({ run_id: '' });
        await assertFixed({ run_id: 42 as unknown as string });
        await assertFixed({ run_id: 'resume-run', pending_dispatch_id: '' });
        await assertFixed({ run_id: 'resume-run', plannerCustomEngineRef: '' });
        await assertFixed({ run_id: 'resume-run', plannerCustomEngineRef: 'missing-syn-ref' });
        process.env.CLAWO_CUSTOM_ENGINE_BAD_JSON = '{not-json';
        try {
          await assertFixed({ run_id: 'resume-run', plannerCustomEngineRef: 'bad-json' });
        } finally {
          delete process.env.CLAWO_CUSTOM_ENGINE_BAD_JSON;
        }
        await assertFixed({ run_id: 'resume-run', send_timeout_ms: 700_000 }, true);
      } finally {
        registration.services[0]?.stop();
        resume.mockRestore();
      }
    });
  });

  it('keeps workflow_resume mapping on its own route and never invokes it from autoloop_resume', async () => {
    await withNoEmbeddedServer(async () => {
      const registration = collectRegistration();
      const resumeTool = registration.tools.find((t) => t.name === 'autoloop_resume')!;
      const workflowTool = registration.tools.find((t) => t.name === 'workflow_resume')!;
      expect(workflowTool).toBeDefined();
      const workflowParams = workflowTool.parameters as { required?: string[]; properties?: Record<string, unknown> };
      expect(workflowParams.required).toEqual(['runId']);
      expect(workflowParams.properties).toHaveProperty('agentCustomEngineRefs');
      expect(workflowParams.properties).not.toHaveProperty('run_id');

      const autoloopResume = vi
        .spyOn(SessionManager.prototype, 'autoloopResume')
        .mockResolvedValue(sampleState as never);
      const workflowResume = vi.spyOn(SessionManager.prototype, 'workflowResume').mockResolvedValue({
        runId: 'wf-1',
        state: 'running',
        currentNode: 'n1',
      } as never);
      try {
        await resumeTool.execute('al-resume', { run_id: 'resume-run' });
        expect(autoloopResume).toHaveBeenCalledTimes(1);
        expect(workflowResume).not.toHaveBeenCalled();

        await workflowTool.execute('wf-resume', { runId: 'wf-1' });
        expect(workflowResume).toHaveBeenCalledTimes(1);
        expect(workflowResume).toHaveBeenLastCalledWith('wf-1', { secrets: undefined });
        expect(autoloopResume).toHaveBeenCalledTimes(1);
      } finally {
        registration.services[0]?.stop();
        autoloopResume.mockRestore();
        workflowResume.mockRestore();
      }
    });
  });
});
