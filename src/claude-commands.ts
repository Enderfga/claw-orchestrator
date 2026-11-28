/**
 * Claude Code's commands as `session_command` lists and runs them, and the
 * readings clawo takes from its stream-json control requests: the account's
 * quota and the context breakdown.
 *
 * A Claude session takes two kinds of command:
 *   - its slash commands, skills and custom commands, sent as the message
 *     `/name args` (the list comes from the `initialize` control request, or the
 *     names in `system/init` when that fails);
 *   - control requests clawo names as commands (`CLAUDE_CONTROL_COMMANDS`), for
 *     what the CLI only offers as a control: MCP server status and reconnect,
 *     the plan file, background tasks, live ultracode.
 */

import type { ContextBreakdown, EngineCommand, EngineQuota, QuotaWindow } from './types.js';

/**
 * Built-in commands that need a person in a terminal or a browser: a terminal
 * screen, a setup wizard, or an account grant. `doctor` fixes the user's own
 * installation; `focus` answers "isn't available here yet" headless.
 */
const CLAUDE_NEEDS_HUMAN = new Set([
  'focus',
  'doctor',
  'import',
  'usage-credits',
  'extra-usage',
  'design',
  'design-consent',
  'design-revoke',
  'auto-mode-setup',
]);

/**
 * Commands `session_command` refuses because they write a settings file of the
 * user's: `/config` the user settings, `/output-style <style>` the project's
 * `.claude/settings.local.json`. Each names the session option that does the
 * same for the session alone. Sent as a plain message they still reach the CLI.
 */
export const CLAUDE_REFUSED_COMMANDS: Record<string, { withArgsOnly: boolean; why: string }> = {
  config: {
    withArgsOnly: false,
    why: "/config writes the user's Claude Code settings file; pass `settings` at session start instead",
  },
  'output-style': {
    withArgsOnly: true,
    why: "/output-style <style> writes the project's .claude/settings.local.json; start the session with `outputStyle` instead",
  },
};

/** One command clawo runs as a control request. */
export interface ClaudeControlCommand {
  description: string;
  args?: string;
  /** The control request, from the command's arguments; throws on arguments it cannot take. */
  request(args: string | undefined): { subtype: string; [field: string]: unknown };
  /** The reply text and the structured payload, from the control's response. */
  render(response: unknown): { text: string; data?: unknown };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function requireArg(name: string, args: string | undefined, what: string): string {
  if (!args) throw new Error(`${name} takes ${what}`);
  return args;
}

/**
 * Control requests offered as commands. The names are clawo's, chosen not to
 * collide with the CLI's own slash commands. None writes a settings file; none
 * returns a credential (an MCP server's config, which can carry headers and
 * env, is left out of `mcp-status`).
 */
export const CLAUDE_CONTROL_COMMANDS: Record<string, ClaudeControlCommand> = {
  'mcp-status': {
    description: "The session's MCP servers: status, scope and tools (control request mcp_status)",
    request: () => ({ subtype: 'mcp_status' }),
    render: (r) => {
      const servers = Array.isArray(asRecord(r).mcpServers) ? (asRecord(r).mcpServers as unknown[]) : [];
      const data = servers.map((s) => {
        const o = asRecord(s);
        const tools = Array.isArray(o.tools) ? o.tools.map((t) => asRecord(t).name).filter(Boolean) : undefined;
        return {
          name: o.name,
          status: o.status,
          ...(o.scope !== undefined ? { scope: o.scope } : {}),
          ...(o.transport !== undefined ? { transport: o.transport } : {}),
          ...(o.error !== undefined ? { error: o.error } : {}),
          ...(tools ? { tools } : {}),
        };
      });
      const text = data.length
        ? data.map((s) => `${String(s.name)}: ${String(s.status)}${s.error ? ` (${String(s.error)})` : ''}`).join('\n')
        : 'No MCP servers.';
      return { text, data };
    },
  },
  'mcp-reconnect': {
    description: 'Reconnect a disconnected or failed MCP server (control request mcp_reconnect)',
    args: '<server>',
    request: (args) => ({ subtype: 'mcp_reconnect', serverName: requireArg('mcp-reconnect', args, 'a server name') }),
    render: (r) => ({ text: 'Reconnected.', data: r ?? undefined }),
  },
  'get-plan': {
    description: "The session's current plan-mode plan, without its path being known (control request get_plan)",
    request: () => ({ subtype: 'get_plan' }),
    render: (r) => {
      const o = asRecord(r);
      return {
        text: o.exists && typeof o.content === 'string' ? o.content : 'No plan.',
        data: { exists: !!o.exists, ...(typeof o.path === 'string' ? { path: o.path } : {}) },
      };
    },
  },
  'background-tasks': {
    description: 'Background shells, agents and workflows the session is running (control request background_tasks)',
    request: () => ({ subtype: 'background_tasks' }),
    render: (r) => {
      const o = asRecord(r);
      const tasks = Array.isArray(o.tasks) ? o.tasks : [];
      return { text: tasks.length ? JSON.stringify(tasks) : 'No background tasks.', data: o };
    },
  },
  'stop-task': {
    description: 'Stop a running background task by its id (control request stop_task)',
    args: '<task id>',
    request: (args) => ({ subtype: 'stop_task', task_id: requireArg('stop-task', args, 'a task id') }),
    render: (r) => ({ text: 'Stopped.', data: r ?? undefined }),
  },
  ultracode: {
    description:
      'Turn ultracode (dynamic workflows) on or off for this session, allowing the Workflow tool when on (control request apply_flag_settings)',
    args: 'on|off',
    request: (args) => {
      const v = (args ?? 'on').toLowerCase();
      if (v !== 'on' && v !== 'off') throw new Error(`ultracode takes on or off, not '${args}'`);
      return v === 'on'
        ? { subtype: 'apply_flag_settings', settings: { ultracode: true, permissions: { allow: ['Workflow'] } } }
        : { subtype: 'apply_flag_settings', settings: { ultracode: false } };
    },
    render: () => ({ text: 'Done.' }),
  },
  'applied-settings': {
    description:
      'The model, effort, advisor and ultracode the session runs with now (the `applied` block of control request get_settings; the merged settings, which can hold credentials, are not returned)',
    request: () => ({ subtype: 'get_settings' }),
    render: (r) => {
      const applied = asRecord(asRecord(r).applied);
      return { text: JSON.stringify(applied), data: applied };
    },
  },
  'permission-rules': {
    description: 'The permission rules in force and where each comes from (control request list_permission_rules)',
    request: () => ({ subtype: 'list_permission_rules' }),
    render: (r) => {
      const rules = asRecord(asRecord(r).state).rules;
      const list = Array.isArray(rules)
        ? rules.map((x) => {
            const o = asRecord(x);
            return { behavior: o.behavior, rule: o.rule, source: o.source };
          })
        : [];
      return {
        text:
          list.map((x) => `${String(x.behavior)} ${String(x.rule)} (${String(x.source)})`).join('\n') || 'No rules.',
        data: list,
      };
    },
  },
  'hooks-listing': {
    description: 'The hooks configured for the session, by event (control request get_hooks_listing)',
    request: () => ({ subtype: 'get_hooks_listing' }),
    render: (r) => ({ text: JSON.stringify(asRecord(r).events ?? []), data: r ?? undefined }),
  },
  'export-conversation': {
    description:
      'The conversation as plain text, as the terminal /export writes it (control request export_conversation)',
    request: () => ({ subtype: 'export_conversation' }),
    render: (r) => ({ text: typeof asRecord(r).text === 'string' ? (asRecord(r).text as string) : '' }),
  },
  'workspace-diff': {
    description: 'The diff of the working tree the session is in (control request get_workspace_diff)',
    request: () => ({ subtype: 'get_workspace_diff' }),
    render: (r) => {
      const o = asRecord(r);
      return {
        text: typeof o.diff === 'string' ? o.diff : `No diff${o.noDiffReason ? ` (${String(o.noDiffReason)})` : ''}.`,
        data: o,
      };
    },
  },
};

/** What `system/init` lists, which `initialize` adds descriptions to. */
export interface ClaudeInitLists {
  slashCommands?: string[];
  skills?: string[];
  terminalCommands?: string[];
}

/** The commands of an `initialize` response (or, without one, of `system/init`), and clawo's control commands. */
export function claudeCommandList(initialize: unknown, lists: ClaudeInitLists): EngineCommand[] {
  const skills = new Set(lists.skills ?? []);
  const terminal = new Set(lists.terminalCommands ?? []);
  const fromInit = asRecord(initialize).commands;
  const entries: Array<{ name: string; description?: string; argumentHint?: string; builtin?: boolean }> =
    Array.isArray(fromInit)
      ? fromInit
          .map((c) => asRecord(c))
          .filter((c) => typeof c.name === 'string' && c.name)
          .map((c) => ({
            name: c.name as string,
            ...(typeof c.description === 'string' && c.description ? { description: c.description } : {}),
            ...(typeof c.argumentHint === 'string' && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
            builtin: c.builtin === true,
          }))
      : (lists.slashCommands ?? []).map((name) => ({ name, builtin: !skills.has(name) && !name.includes(':') }));

  const out: EngineCommand[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    // Internal entry points of server-launched sessions.
    if (e.name.startsWith('__') || seen.has(e.name)) continue;
    seen.add(e.name);
    const source: EngineCommand['source'] = e.builtin
      ? 'builtin'
      : e.name.includes(':')
        ? 'plugin'
        : skills.has(e.name) || /\((user|project)\)$/.test(e.description ?? '')
          ? 'skill'
          : 'custom';
    const needsHuman = CLAUDE_NEEDS_HUMAN.has(e.name) || (terminal.has(e.name) && e.name !== 'reload-plugins');
    out.push({
      name: e.name,
      ...(e.description ? { description: e.description } : {}),
      source,
      ...(e.argumentHint ? { args: e.argumentHint } : {}),
      // Sent as a message: one written while a turn runs is folded into that
      // turn, so even a command the CLI answers itself waits its turn.
      startsTurn: true,
      ...(needsHuman ? { needsHuman: true } : {}),
    });
  }
  for (const [name, c] of Object.entries(CLAUDE_CONTROL_COMMANDS)) {
    if (seen.has(name)) continue;
    out.push({
      name,
      description: c.description,
      source: 'rpc',
      ...(c.args ? { args: c.args } : {}),
      startsTurn: false,
    });
  }
  return out;
}

/**
 * Every name a command answers to: the CLI's commands with their aliases
 * (`review` for `code-review`, `cost` for `usage`), and clawo's control
 * commands. A name outside it would reach the model as a message.
 */
export function claudeCommandNames(initialize: unknown, lists: ClaudeInitLists): Set<string> {
  const names = new Set<string>([...(lists.slashCommands ?? []), ...Object.keys(CLAUDE_CONTROL_COMMANDS)]);
  const fromInit = asRecord(initialize).commands;
  if (Array.isArray(fromInit)) {
    for (const c of fromInit) {
      const o = asRecord(c);
      if (typeof o.name === 'string') names.add(o.name);
      if (Array.isArray(o.aliases)) for (const a of o.aliases) if (typeof a === 'string') names.add(a);
    }
  }
  return names;
}

// ─── Quota ──────────────────────────────────────────────────────────────────

/** A utilization as a percentage: the stream reports a fraction (0.31), the usage endpoint may report 31. */
function percent(u: unknown): number | undefined {
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0) return undefined;
  return Math.round((u <= 1 ? u * 100 : u) * 10) / 10;
}

/** A reset time as ISO: epoch seconds (the stream) or a date string (the usage endpoint). */
function isoTime(t: unknown): string | undefined {
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  if (typeof t === 'string' && t && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return undefined;
}

function window(name: string, utilization: unknown, resetsAt: unknown): QuotaWindow | undefined {
  const used = percent(utilization);
  if (used === undefined) return undefined;
  const resets = isoTime(resetsAt);
  return {
    name,
    usedPercent: used,
    remainingPercent: Math.max(0, Math.round((100 - used) * 10) / 10),
    ...(resets ? { resetsAt: resets } : {}),
  };
}

/**
 * The quota a turn's `rate_limit_event` reported: one window per entry of
 * `unifiedWindows` (`five_hour`, `seven_day`, …), measured on 2.1.332 as
 * `{utilization: 0.31, resetsAt: <epoch s>, status}`.
 */
export function quotaFromRateLimit(info: unknown, readAt: string): EngineQuota | undefined {
  const i = asRecord(info);
  const windows: QuotaWindow[] = [];
  for (const [name, w] of Object.entries(asRecord(i.unifiedWindows))) {
    const o = asRecord(w);
    const win = window(name, o.utilization, o.resetsAt ?? o.resets_at);
    if (win) windows.push(win);
  }
  if (!windows.length) {
    const win = window(typeof i.rateLimitType === 'string' ? i.rateLimitType : 'limit', i.utilization, i.resetsAt);
    if (win) windows.push(win);
  }
  if (!windows.length && typeof i.status !== 'string') return undefined;
  return { engine: 'claude', windows, source: 'claude rate_limit_event', readAt, raw: info };
}

/**
 * The quota of a `get_usage` control response, when the login has one
 * (`rate_limits_available`; an API key, Bedrock or Vertex has none, nor does a
 * CLAUDE_CODE_OAUTH_TOKEN without the profile scope).
 */
export function quotaFromUsage(response: unknown, readAt: string): EngineQuota | undefined {
  const r = asRecord(response);
  if (r.rate_limits_available !== true) return undefined;
  const limits = asRecord(r.rate_limits);
  const windows: QuotaWindow[] = [];
  for (const [name, w] of Object.entries(limits)) {
    if (name === 'model_scoped') continue;
    const o = asRecord(w);
    const win = window(name, o.utilization, o.resets_at ?? o.resetsAt);
    if (win) windows.push(win);
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const m of limits.model_scoped) {
      const o = asRecord(m);
      const win = window(`weekly ${String(o.display_name ?? 'model')}`, o.utilization, o.resets_at);
      if (win) windows.push(win);
    }
  }
  if (!windows.length) return undefined;
  const plan = typeof r.subscription_type === 'string' ? r.subscription_type : undefined;
  return { engine: 'claude', ...(plan ? { plan } : {}), windows, source: 'claude get_usage', readAt };
}

// ─── Context ────────────────────────────────────────────────────────────────

/**
 * A `get_context_usage` response as a breakdown: the categories that occupy the
 * context (kind `used`, which sum to `totalTokens`), not the deferred tools, the
 * autocompact buffer or the free space.
 */
export function contextFromUsage(response: unknown): ContextBreakdown | undefined {
  const r = asRecord(response);
  if (typeof r.totalTokens !== 'number') return undefined;
  const categories = Array.isArray(r.categories)
    ? r.categories
        .map((c) => asRecord(c))
        .filter((c) => (c.kind === undefined || c.kind === 'used') && typeof c.tokens === 'number')
        .map((c) => ({ name: String(c.name ?? c.id ?? 'other'), tokens: c.tokens as number }))
    : undefined;
  return {
    totalTokens: r.totalTokens,
    ...(typeof r.maxTokens === 'number' ? { windowTokens: r.maxTokens } : {}),
    ...(categories?.length ? { categories } : {}),
  };
}
