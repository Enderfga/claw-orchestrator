/**
 * Codex's commands, as clawo runs them.
 *
 * Codex parses its slash commands in the TUI only: `codex exec` and the
 * app-server's `turn/start` hand `/status` or `/goal …` to the model as plain
 * text (measured on 0.172.0). Each command a headless client can use has an
 * app-server RPC of its own, so both Codex engines take commands through
 * `runCommand` (`commandStyle: 'rpc'`) and never as message text. `codex-app`
 * sends the RPCs on its own app-server; `codex` (exec) on a short-lived one
 * (`codex-app-client.ts`).
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { CommandOutcome, EngineCommand, EngineQuota, EngineType, QuotaWindow } from './types.js';
import type { CodexRpc } from './codex-app-client.js';

/**
 * Codex's `/init` prompt, as the 0.172.0 binary embeds it
 * (`tui/assets/prompt_for_init_command.md`); the TUI submits it as a user message.
 */
export const CODEX_INIT_PROMPT = [
  'Generate a file named AGENTS.md that serves as a contributor guide for this repository.',
  'Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.',
  'Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.',
  'Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.',
  '',
  'Document Requirements',
  '',
  '- Title the document "Repository Guidelines".',
  '- Use Markdown headings (#, ##, etc.) for structure.',
  '- Keep the document concise. 200-400 words is optimal.',
  '- Keep explanations short, direct, and specific to this repository.',
  '- Provide examples where helpful (commands, directory paths, naming patterns).',
  '- Maintain a professional, instructional tone.',
  '',
  'Recommended Sections',
  '',
  'Project Structure & Module Organization',
  '',
  '- Outline the project structure, including where the source code, tests, and assets are located.',
  '',
  'Build, Test, and Development Commands',
  '',
  '- List key commands for building, testing, and running locally (e.g., npm test, make build).',
  '- Briefly explain what each command does.',
  '',
  'Coding Style & Naming Conventions',
  '',
  '- Specify indentation rules, language-specific style preferences, and naming patterns.',
  '- Include any formatting or linting tools used.',
  '',
  'Testing Guidelines',
  '',
  '- Identify testing frameworks and coverage requirements.',
  '- State test naming conventions and how to run tests.',
  '',
  'Commit & Pull Request Guidelines',
  '',
  '- Summarize commit message conventions found in the project’s Git history.',
  '- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).',
  '',
  '(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.',
].join('\n');

type CodexEngine = 'codex' | 'codex-app';

interface BuiltinSpec extends EngineCommand {
  /** The engines that run it; both when absent. */
  only?: CodexEngine;
  /** Needs the session's thread loaded (after the first turn on `codex`). */
  thread?: boolean;
  /** Reads the stored thread: needs its id (after the first turn on `codex`), not the thread loaded. */
  stored?: boolean;
  /** Listed only on a `danger-full-access` session. */
  unsandboxed?: boolean;
}

const BUILTINS: BuiltinSpec[] = [
  // Info commands: no turn, nothing added to the conversation.
  {
    name: 'status',
    source: 'rpc',
    startsTurn: false,
    description: "The account's sign-in kind, plan and rate-limit windows",
  },
  {
    name: 'usage',
    source: 'rpc',
    startsTurn: false,
    description: "The account's token usage: lifetime and the last days",
  },
  {
    name: 'model',
    source: 'rpc',
    startsTurn: false,
    description: 'The models and their reasoning efforts (switch with session_switch_model)',
  },
  {
    name: 'mcp',
    source: 'rpc',
    startsTurn: false,
    args: '[reload]',
    description: "MCP servers: status, auth and tool count; 'reload' (codex-app) rereads their configuration",
  },
  {
    name: 'skills',
    source: 'rpc',
    startsTurn: false,
    args: '[roots <dir>...]',
    description: "Skills for the session directory: name, scope, enabled; 'roots' (codex-app) adds skill directories",
  },
  { name: 'hooks', source: 'rpc', startsTurn: false, description: 'Configured hooks' },
  { name: 'plugins', source: 'rpc', startsTurn: false, description: 'Installed plugins' },
  { name: 'apps', source: 'rpc', startsTurn: false, description: 'Installed apps (connectors)' },
  {
    name: 'experimental',
    source: 'rpc',
    startsTurn: false,
    description: 'Feature flags: stage and whether each is on',
  },
  { name: 'permissions', source: 'rpc', startsTurn: false, description: 'Permission profiles' },
  {
    name: 'config',
    source: 'rpc',
    startsTurn: false,
    description: 'The effective configuration: model, provider, sandbox and feature keys',
  },
  {
    name: 'memories',
    source: 'rpc',
    startsTurn: false,
    args: '[on|off|summary]',
    description:
      "Memory status; 'on' or 'off' sets whether this thread uses and writes memories, 'summary' shows the thread's",
  },
  {
    name: 'rename',
    source: 'rpc',
    startsTurn: false,
    thread: true,
    args: '<name>',
    description: "Set the thread's name",
  },
  {
    name: 'ps',
    source: 'rpc',
    startsTurn: false,
    thread: true,
    only: 'codex-app',
    description: "The thread's background terminals",
  },
  {
    name: 'stop',
    source: 'rpc',
    startsTurn: false,
    thread: true,
    only: 'codex-app',
    args: '[<processId>]',
    description: "Stop the thread's background terminals, or the one named",
  },
  { name: 'rollout', source: 'rpc', startsTurn: false, description: "The path of the thread's rollout file" },
  {
    name: 'thread',
    source: 'rpc',
    startsTurn: false,
    stored: true,
    description:
      "The thread's metadata: name, status, model, directory, Git, rollout; on codex-app also the threads loaded with it",
  },
  {
    name: 'items',
    source: 'rpc',
    startsTurn: false,
    stored: true,
    args: '[<turnId> [<itemId>...]]',
    description: "The thread's last items, a turn's items, or the items named: messages, commands, edits, tool calls",
  },
  {
    name: 'search',
    source: 'rpc',
    startsTurn: false,
    stored: true,
    args: '<text>',
    description: "Where the text occurs in the thread's messages",
  },
  {
    name: 'threads',
    source: 'rpc',
    startsTurn: false,
    args: '<text>',
    description: 'Full-text search of the local Codex history: thread id, name and the matching snippet',
  },
  {
    name: 'modes',
    source: 'rpc',
    startsTurn: false,
    description: 'Collaboration mode presets (plan mode runs with plan: true or turnCommand /plan)',
  },
  {
    name: 'providers',
    source: 'rpc',
    startsTurn: false,
    description: "Model providers, the default, and the current one's image generation and web search",
  },
  {
    name: 'requirements',
    source: 'rpc',
    startsTurn: false,
    description: 'Requirements an administrator set: allowed sandbox modes, approval policies, features',
  },
  {
    name: 'exec',
    source: 'rpc',
    startsTurn: false,
    args: '<command>',
    description: "Run a shell command in the session's sandbox and directory; no model turn",
  },
  {
    name: 'queue',
    source: 'rpc',
    startsTurn: false,
    thread: true,
    only: 'codex-app',
    args: '[add <text> | delete <id> | update <id> <text> | reorder <id>... | start [<id>]]',
    description: "The thread's message queue: each runs as the next turn once the thread is idle, as an engine turn",
  },
  {
    name: 'turn',
    source: 'rpc',
    startsTurn: false,
    thread: true,
    only: 'codex-app',
    args: 'model=<id> effort=<level> summary=<auto|concise|detailed|none>',
    description:
      "Change the running turn's model, effort or reasoning summary; later turns keep the session's (needs codexFeatures step_model_switching)",
  },
  {
    name: 'diff',
    source: 'rpc',
    startsTurn: false,
    only: 'codex-app',
    description: "The last turn's working-tree diff, as codex reported it",
  },
  // In the send chain: each changes the conversation, or runs a turn.
  {
    name: 'compact',
    source: 'rpc',
    startsTurn: true,
    thread: true,
    description: "Compact the thread's context (not billed as a turn)",
  },
  {
    name: 'review',
    source: 'rpc',
    startsTurn: true,
    thread: true,
    args: '[uncommitted | base <branch> | commit <sha> | <instructions>]',
    description: 'Review code on the thread (review/start): uncommitted changes by default',
  },
  {
    name: 'init',
    source: 'rpc',
    startsTurn: true,
    description: 'Write an AGENTS.md contributor guide (Codex’s /init prompt)',
  },
  {
    name: 'implement',
    source: 'rpc',
    startsTurn: true,
    thread: true,
    only: 'codex-app',
    args: '<plan markdown | plan file>',
    description: "Put an approved plan in the thread's context and run Codex's 'Implement the plan.' turn",
  },
  {
    name: 'inject',
    source: 'rpc',
    startsTurn: true,
    thread: true,
    args: '<text>',
    description: "Add a user message to the thread's history without starting a turn",
  },
  {
    name: 'shell',
    source: 'rpc',
    startsTurn: true,
    thread: true,
    unsandboxed: true,
    args: '<command>',
    description: "Run a shell command on the thread (the TUI's !cmd); it runs unsandboxed",
  },
];

/** Codex's own slash commands that clawo offers another way, and where. */
export const CODEX_COMMAND_HOMES: Readonly<Record<string, string>> = {
  goal: 'codex_goal_set / codex_goal_get (codex-app), or a workflow goal node',
  plan: 'session_send with plan: true, or turnCommand "/plan"',
  fork: 'codex_fork (codex-app), or session_start with resumeSessionId and forkSession',
  side: 'session_aside',
  recap: 'session_aside',
  agents: 'effort "ultra" (sub-agents are on by default)',
  subagents: 'effort "ultra" (sub-agents are on by default)',
  new: 'session_start',
  clear: 'session_start',
  resume: 'session_start with resumeSessionId',
  undo: 'session_rewind',
  rollback: 'session_rewind or codex_rollback',
};

export interface CodexCommandContext {
  engine: CodexEngine;
  /** The sandbox mode the session runs in; `shell` is listed only on `danger-full-access`. */
  sandboxMode?: string;
}

/** The built-in commands a session on `ctx.engine` can run. */
export function codexBuiltinCommands(ctx: CodexCommandContext): EngineCommand[] {
  return BUILTINS.filter(
    (c) => (!c.only || c.only === ctx.engine) && (!c.unsandboxed || ctx.sandboxMode === 'danger-full-access'),
  ).map(({ name, description, source, args, startsTurn }) => ({
    name,
    source,
    startsTurn,
    ...(description ? { description } : {}),
    ...(args ? { args } : {}),
  }));
}

/**
 * The session's `turnCommand` as Codex takes it: `/plan` puts every turn in
 * plan mode, a skill name invokes that skill with every message. Throws for
 * anything else, before a process starts.
 */
export function codexTurnCommand(turnCommand: string | undefined): { plan: true } | { skill: string } | undefined {
  const cmd = turnCommand?.trim().replace(/^[/$]/, '').trim();
  if (!cmd) return undefined;
  if (cmd === 'plan') return { plan: true };
  if (/^[A-Za-z0-9_.:-]+$/.test(cmd) && !BUILTINS.some((b) => b.name === cmd)) return { skill: cmd };
  throw new Error(
    `turnCommand on Codex is /plan or the name of a skill, not '${turnCommand}': ` +
      'Codex takes no other command in a message',
  );
}

/** Whether `name` is a built-in that needs the thread loaded. */
export function codexCommandNeedsThread(name: string): boolean {
  return BUILTINS.some((c) => c.name === name && c.thread);
}

/** Whether `name` is a built-in that reads the stored thread (its id, not the thread loaded). */
export function codexCommandReadsStoredThread(name: string): boolean {
  return BUILTINS.some((c) => c.name === name && c.stored);
}

/** The error for a command clawo cannot run on Codex. */
export function unknownCodexCommand(name: string, engine: EngineType): Error {
  const home = CODEX_COMMAND_HOMES[name];
  const other = BUILTINS.find((c) => c.name === name && c.only && c.only !== engine)?.only;
  if (other) {
    return new Error(
      `/${name} runs on ${other} only: it needs the thread on a running app-server. session_command list ` +
        'shows the ones that can run',
    );
  }
  return new Error(
    home
      ? `/${name} is not a command clawo runs on ${engine}; use ${home}`
      : `/${name} is not a command clawo can run on ${engine}: Codex parses slash commands in its TUI only, ` +
          'and this one has no app-server RPC. session_command list shows the ones that can run',
  );
}

// ─── Sandbox ────────────────────────────────────────────────────────────────

/**
 * The `SandboxPolicy` for a session's sandbox mode, as `command/exec` takes
 * it, with `addDir` writable under workspace-write. Network access stays off,
 * Codex's default for both sandboxed modes. codex-app passes the policy its
 * thread reported instead, which carries the user's own network setting.
 */
export function codexSandboxPolicy(
  mode: string | undefined,
  writableRoots: readonly string[] = [],
): Record<string, unknown> {
  switch (mode || 'workspace-write') {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [...writableRoots],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

/** `command/exec` takes an argv; `exec` runs its text through the platform shell. */
export function codexShellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
}

// ─── Review ─────────────────────────────────────────────────────────────────

/** `review/start`'s target for the command's arguments. */
export function codexReviewTarget(args: string | undefined): Record<string, string> {
  const text = args?.trim() ?? '';
  if (!text || text === 'uncommitted') return { type: 'uncommittedChanges' };
  const [word, ...rest] = text.split(/\s+/);
  const value = rest.join(' ').trim();
  if (word === 'base' && value && !/\s/.test(value)) return { type: 'baseBranch', branch: value };
  if (word === 'commit' && value && /^[0-9a-zA-Z._/^~-]+$/.test(value)) return { type: 'commit', sha: value };
  return { type: 'custom', instructions: text };
}

// ─── Rewind ─────────────────────────────────────────────────────────────────

/**
 * Whether a listed turn starts a conversation turn `thread/revert` can go back
 * to before. Two kinds are not: an inner turn (a review's reviewer, listed with
 * the review turn as its `rootTurnId`), and a turn with no user message (a
 * review, a compaction), which has no persisted start boundary ("turn … does
 * not have a persisted start boundary", 0.172.0). A turn listed without its
 * items is taken as one.
 */
function isUserTurn(turn: { id?: unknown; rootTurnId?: unknown; items?: unknown }): boolean {
  if (typeof turn.rootTurnId === 'string' && turn.rootTurnId && turn.rootTurnId !== turn.id) return false;
  if (!Array.isArray(turn.items)) return true;
  return turn.items.some((i) => (i as { type?: unknown })?.type === 'userMessage');
}

/**
 * Drop the last `numTurns` turns of `threadId`'s conversation: list the newest
 * turns (`thread/turns/list`, newest first, following the cursor), count the
 * ones a user message started, and revert to before the oldest of those
 * (`thread/revert`) — the review and compaction turns after it go with it.
 * Files the dropped turns changed stay changed. Throws, and reverts nothing,
 * when the thread has fewer turns.
 */
export async function revertCodexTurns(rpc: CodexRpc, threadId: string, numTurns: number): Promise<void> {
  if (!Number.isInteger(numTurns) || numTurns < 1) throw new Error('rollback: numTurns must be a positive integer');
  const turnIds: string[] = [];
  let cursor: string | undefined;
  while (turnIds.length < numTurns) {
    const page = (await rpc.request('thread/turns/list', {
      threadId,
      limit: numTurns - turnIds.length,
      sortDirection: 'desc',
      itemsView: 'summary',
      ...(cursor ? { cursor } : {}),
    })) as { data?: Array<{ id?: unknown; rootTurnId?: unknown; items?: unknown }>; nextCursor?: string | null };
    const data = page?.data ?? [];
    turnIds.push(
      ...data
        .filter(isUserTurn)
        .map((t) => t.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    if (!data.length || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (turnIds.length < numTurns) {
    throw new Error(`rollback: the thread has ${turnIds.length} turn(s), fewer than ${numTurns}`);
  }
  await rpc.request('thread/revert', { threadId, beforeTurnId: turnIds[numTurns - 1] });
}

/** The id of `threadId`'s latest turn, or undefined when it has none. */
export async function latestCodexTurnId(rpc: CodexRpc, threadId: string): Promise<string | undefined> {
  const page = (await rpc.request('thread/turns/list', {
    threadId,
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  })) as { data?: Array<{ id?: unknown }> };
  const id = page?.data?.[0]?.id;
  return typeof id === 'string' ? id : undefined;
}

// ─── Quota ──────────────────────────────────────────────────────────────────

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string } | null;
}

function windowName(mins: number | null | undefined, fallback: string): string {
  if (mins === 300) return '5h';
  if (mins === 1440) return 'daily';
  if (mins === 10080) return 'weekly';
  if (typeof mins === 'number' && mins > 0) return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
  return fallback;
}

/** `account/rateLimits/read` as an `EngineQuota`. */
export function codexQuotaFromRateLimits(resp: unknown, engine: EngineType, source: string): EngineQuota | undefined {
  const r = (resp ?? {}) as {
    rateLimits?: RateLimitSnapshot;
    rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
    ordinaryUsageAllowed?: boolean | null;
  };
  const snapshots = r.rateLimitsByLimitId ? Object.values(r.rateLimitsByLimitId) : r.rateLimits ? [r.rateLimits] : [];
  if (!snapshots.length) return undefined;
  const windows: QuotaWindow[] = [];
  for (const s of snapshots) {
    const prefix = s.limitId && s.limitId !== 'codex' ? `${s.limitName || s.limitId} ` : '';
    for (const [slot, w] of [
      ['primary', s.primary],
      ['secondary', s.secondary],
    ] as const) {
      if (!w || typeof w.usedPercent !== 'number') continue;
      windows.push({
        name: `${prefix}${windowName(w.windowDurationMins, slot)}`,
        usedPercent: w.usedPercent,
        remainingPercent: Math.max(0, 100 - w.usedPercent),
        ...(typeof w.resetsAt === 'number' ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
      });
    }
  }
  const plan = snapshots.find((s) => s.planType)?.planType ?? undefined;
  return { engine, ...(plan ? { plan } : {}), windows, source, readAt: new Date().toISOString(), raw: resp };
}

// ─── Skills ─────────────────────────────────────────────────────────────────

export interface CodexSkill {
  name: string;
  description?: string;
  path: string;
  scope?: string;
  enabled: boolean;
}

/** The skills `skills/list` finds for `cwd`. */
export async function listCodexSkills(rpc: CodexRpc, cwd: string | undefined): Promise<CodexSkill[]> {
  const resp = (await rpc.request('skills/list', cwd ? { cwds: [cwd] } : {})) as {
    data?: Array<{ skills?: Array<Record<string, unknown>> }>;
  };
  const seen = new Set<string>();
  const out: CodexSkill[] = [];
  for (const entry of resp?.data ?? []) {
    for (const s of entry.skills ?? []) {
      if (typeof s.name !== 'string' || typeof s.path !== 'string' || seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({
        name: s.name,
        path: s.path,
        enabled: s.enabled !== false,
        ...(typeof s.description === 'string' ? { description: s.description } : {}),
        ...(typeof s.scope === 'string' ? { scope: s.scope } : {}),
      });
    }
  }
  return out;
}

/** The skills as commands; a skill named like a built-in is left out (the built-in wins). */
export function codexSkillCommands(skills: readonly CodexSkill[], builtins: readonly EngineCommand[]): EngineCommand[] {
  const taken = new Set(builtins.map((c) => c.name));
  return skills
    .filter((s) => s.enabled && !taken.has(s.name))
    .map((s) => ({
      name: s.name,
      source: 'skill' as const,
      startsTurn: true,
      args: '[message]',
      ...(s.description ? { description: s.description.slice(0, 200) } : {}),
    }));
}

// ─── Info commands ──────────────────────────────────────────────────────────

/** Config keys `config` reports; nothing that can hold a credential (MCP env, provider headers). */
const CONFIG_KEYS = [
  'model',
  'review_model',
  'model_provider',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_context_window',
  'model_auto_compact_token_limit',
  'plan_mode_reasoning_effort',
  'service_tier',
  'approval_policy',
  'sandbox_mode',
  'profile',
  'web_search',
];

function ok(name: string, text: string, data?: unknown): CommandOutcome {
  return { name, ok: true, text, startedTurn: false, ...(data !== undefined ? { data } : {}) };
}

function lines(items: readonly string[], empty: string): string {
  return items.length ? items.join('\n') : empty;
}

export interface CodexInfoContext {
  engine: CodexEngine;
  cwd?: string;
  /** The session's thread (loaded on `rpc` for the commands that need it); thread commands refuse without it. */
  threadId?: string;
  /** The sandbox `exec` runs in: the policy the thread reported on codex-app, `codexSandboxPolicy` on codex. */
  sandboxPolicy?: Record<string, unknown>;
  /** How long `exec` may run; the command's own timeout. */
  timeoutMs?: number;
}

/** Thread sources the history search and listings cover: clawo's own threads (`vscode`, `exec`) and the user's. */
export const CODEX_LISTED_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'];

/** `<word> <rest>` of a command's arguments; the rest keeps its whitespace. */
function splitArgs(args: string | undefined): { word: string; rest: string } {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(args?.trim() ?? '');
  return m ? { word: m[1], rest: m[2].trim() } : { word: '', rest: '' };
}

function clip(text: string, max = 200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The text of user input items: their text parts, and what else they carry by type. */
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  return input
    .map((i) => {
      const item = i as { type?: unknown; text?: unknown; name?: unknown; path?: unknown };
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (typeof item.name === 'string') return `[${String(item.type)} ${item.name}]`;
      if (typeof item.path === 'string') return `[${String(item.type)} ${item.path}]`;
      return `[${String(item.type)}]`;
    })
    .join(' ');
}

/** One line for a thread item: its type and what it says or did. */
export function codexItemLine(entry: { turnId?: unknown; item?: Record<string, unknown> }): string {
  const item = entry.item ?? {};
  const type = String(item.type ?? 'item');
  let what = '';
  switch (type) {
    case 'userMessage':
      what = inputText(item.content);
      break;
    case 'agentMessage':
    case 'plan':
      what = String(item.text ?? '');
      break;
    case 'reasoning':
      what = Array.isArray(item.summary) ? item.summary.join(' ') : '';
      break;
    case 'commandExecution':
      what = `${String(item.command ?? '')}${typeof item.exitCode === 'number' ? ` → exit ${item.exitCode}` : ''}`;
      break;
    case 'fileChange':
      what = Array.isArray(item.changes)
        ? item.changes.map((c) => String((c as { path?: unknown })?.path ?? '')).join(', ')
        : '';
      break;
    case 'mcpToolCall':
      what = `${String(item.server ?? '')}.${String(item.tool ?? '')} ${String(item.status ?? '')}`;
      break;
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
      what = `${String(item.tool ?? '')} ${String(item.status ?? '')}`;
      break;
    case 'webSearch':
      what = String(item.query ?? '');
      break;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      what = String(item.review ?? '');
      break;
    case 'subAgentActivity':
      what = `${String(item.kind ?? '')} ${String(item.agentPath ?? '')}`;
      break;
  }
  return `${String(entry.turnId ?? '')} ${String(item.id ?? '')} ${type}${what ? `: ${clip(what)}` : ''}`;
}

interface QueuedSubmission {
  id?: string;
  input?: unknown;
}

/** The thread's message queue (`thread/queue/*`): list, add, delete, update, reorder, start. */
async function runCodexQueue(rpc: CodexRpc, threadId: string, args: string | undefined): Promise<CommandOutcome> {
  const { word, rest } = splitArgs(args);
  const usage = 'add <text> | delete <id> | update <id> <text> | reorder <id>... | start [<id>]';
  switch (word) {
    case '':
    case 'list': {
      const resp = (await rpc.request('thread/queue/list', { threadId, limit: 100 })) as {
        data?: QueuedSubmission[];
      };
      const items = (resp?.data ?? []).map((q) => ({ id: String(q.id ?? ''), text: inputText(q.input) }));
      return ok(
        'queue',
        lines(
          items.map((q) => `${q.id}: ${clip(q.text)}`),
          'the queue is empty',
        ),
        items,
      );
    }
    case 'add': {
      if (!rest) throw new Error('/queue add takes the message to queue');
      const resp = (await rpc.request('thread/queue/add', {
        threadId,
        input: [{ type: 'text', text: rest, text_elements: [] }],
        clientUserMessageId: randomUUID(),
      })) as { queuedSubmission?: QueuedSubmission };
      const id = String(resp?.queuedSubmission?.id ?? '');
      return ok(
        'queue',
        `queued ${id}: it runs as the next turn once the thread is idle, and its result arrives as an engine turn`,
        { id },
      );
    }
    case 'delete': {
      if (!rest || /\s/.test(rest)) throw new Error('/queue delete takes one queued message id');
      const resp = (await rpc.request('thread/queue/delete', { threadId, queuedSubmissionId: rest })) as {
        deleted?: boolean;
      };
      const deleted = resp?.deleted === true;
      return {
        name: 'queue',
        ok: deleted,
        text: deleted ? `deleted ${rest}` : `no queued message ${rest}`,
        data: { deleted },
        startedTurn: false,
        ...(deleted ? {} : { error: `no queued message ${rest}` }),
      };
    }
    case 'update': {
      const { word: id, rest: text } = splitArgs(rest);
      if (!id || !text) throw new Error('/queue update takes the queued message id and its new text');
      await rpc.request('thread/queue/update', {
        threadId,
        queuedSubmissionId: id,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      return ok('queue', `updated ${id}`, { id });
    }
    case 'reorder': {
      const ids = rest.split(/\s+/).filter(Boolean);
      if (!ids.length) throw new Error('/queue reorder takes the queued message ids in their new order');
      await rpc.request('thread/queue/reorder', { threadId, queuedSubmissionIds: ids });
      return ok('queue', `queue order: ${ids.join(' ')}`, { order: ids });
    }
    case 'start': {
      if (/\s/.test(rest)) throw new Error('/queue start takes at most one queued message id');
      const resp = (await rpc.request('thread/queue/start', {
        threadId,
        ...(rest ? { queuedSubmissionId: rest } : {}),
      })) as { turn?: { id?: string } };
      const turnId = resp?.turn?.id;
      return ok('queue', `started turn ${turnId ?? '(unnamed)'}; its result arrives as an engine turn`, {
        turnId: turnId ?? null,
      });
    }
    default:
      throw new Error(`/queue takes ${usage}, not '${word}'`);
  }
}

/** A seconds timestamp as ISO, or null. */
function isoSeconds(value: unknown): string | null {
  return typeof value === 'number' && value > 0 ? new Date(value * 1000).toISOString() : null;
}

const ACCOUNT_KINDS: Readonly<Record<string, string>> = {
  apiKey: 'API key',
  chatgpt: 'ChatGPT',
  amazonBedrock: 'Amazon Bedrock',
  gcp: 'Google Cloud',
};

/** How the account signs in (`account/read`), without the address or ids it also returns; undefined when unread. */
async function readCodexAccount(
  rpc: CodexRpc,
): Promise<{ kind: string; plan?: string; workspace?: string } | undefined> {
  try {
    const resp = (await rpc.request('account/read', {})) as {
      account?: { type?: string; planType?: string; workspaceName?: string | null } | null;
      requiresOpenaiAuth?: boolean;
    };
    const a = resp?.account;
    if (!a?.type) return resp?.requiresOpenaiAuth ? { kind: 'not signed in' } : undefined;
    return {
      kind: ACCOUNT_KINDS[a.type] ?? a.type,
      ...(a.planType ? { plan: a.planType } : {}),
      ...(a.workspaceName ? { workspace: a.workspaceName } : {}),
    };
  } catch {
    return undefined;
  }
}

/** `thread/read`, and on codex-app `thread/loaded/list`: what the thread is, where it runs. */
async function threadInfo(rpc: CodexRpc, threadId: string, ctx: CodexInfoContext): Promise<CommandOutcome> {
  const resp = (await rpc.request('thread/read', { threadId, includeTurns: false })) as {
    thread?: Record<string, unknown>;
  };
  const t = resp?.thread ?? {};
  const git = t.gitInfo as { branch?: string | null; sha?: string | null } | null | undefined;
  const info: Record<string, unknown> = {
    id: t.id ?? threadId,
    name: t.name ?? null,
    status: (t.status as { type?: unknown } | undefined)?.type ?? null,
    model: t.model ?? null,
    reasoningEffort: t.reasoningEffort ?? null,
    modelProvider: t.modelProvider ?? null,
    cwd: t.cwd ?? null,
    rollout: t.path ?? null,
    ephemeral: t.ephemeral === true,
    forkedFromId: t.forkedFromId ?? null,
    git: git ? { branch: git.branch ?? null, sha: git.sha ?? null } : null,
    createdAt: isoSeconds(t.createdAt),
    updatedAt: isoSeconds(t.updatedAt),
    cliVersion: t.cliVersion ?? null,
  };
  if (ctx.engine === 'codex-app') {
    const loaded = (await rpc.request('thread/loaded/list', {})) as { data?: unknown[] };
    // The session's own thread and its sub-agents' threads, all on this app-server.
    info.loadedThreads = (loaded?.data ?? []).filter((id): id is string => typeof id === 'string');
  }
  const text = Object.entries(info)
    .filter(([, v]) => v !== null && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
  return ok('thread', text, info);
}

/**
 * `command/exec`: the command through the platform shell, in the session's
 * directory and sandbox, buffered. No thread or turn: nothing reaches the
 * conversation. Codex reports a timeout as exit code 124.
 */
async function runCodexExec(
  rpc: CodexRpc,
  name: string,
  args: string | undefined,
  ctx: CodexInfoContext,
): Promise<CommandOutcome> {
  const command = args?.trim();
  if (!command) throw new Error('/exec takes the command to run');
  const timeoutMs = ctx.timeoutMs ?? 600_000;
  const resp = (await rpc.request(
    'command/exec',
    {
      command: codexShellArgv(command),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      sandboxPolicy: ctx.sandboxPolicy ?? codexSandboxPolicy(undefined),
      timeoutMs,
    },
    timeoutMs + 15_000,
  )) as { exitCode?: number; stdout?: string; stderr?: string };
  const exitCode = typeof resp?.exitCode === 'number' ? resp.exitCode : null;
  const stdout = resp?.stdout ?? '';
  const stderr = resp?.stderr ?? '';
  const succeeded = exitCode === 0;
  const text = stderr ? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}` : stdout;
  const error =
    exitCode === 124
      ? `the command exited with 124, which is also how a timeout (${timeoutMs} ms) is reported`
      : `the command exited with ${exitCode ?? 'no code'}`;
  return {
    name,
    ok: succeeded,
    text,
    data: { exitCode, stdout, stderr },
    startedTurn: false,
    ...(succeeded ? {} : { error }),
  };
}

/**
 * Run an info command over `rpc`. Returns undefined for a name that is not one,
 * so the caller can try its own commands next. Large lists (`plugins`, `apps`,
 * `mcp`) are summarised: the raw responses run to megabytes.
 */
export async function runCodexInfoCommand(
  rpc: CodexRpc,
  name: string,
  args: string | undefined,
  ctx: CodexInfoContext,
): Promise<CommandOutcome | undefined> {
  const needThread = (): string => {
    if (!ctx.threadId) throw new Error(`/${name} needs the session's thread; send a first message`);
    return ctx.threadId;
  };
  switch (name) {
    case 'status': {
      const resp = await rpc.request('account/rateLimits/read', {});
      const account = await readCodexAccount(rpc);
      const quota = codexQuotaFromRateLimits(resp, ctx.engine, 'codex account/rateLimits/read');
      const allowed = (resp as { ordinaryUsageAllowed?: boolean | null })?.ordinaryUsageAllowed;
      const signedIn = account
        ? [`signed in: ${account.kind}${account.workspace ? ` (${account.workspace})` : ''}`]
        : [];
      const text = quota
        ? [
            ...signedIn,
            `plan: ${quota.plan ?? 'unknown'}`,
            ...quota.windows.map(
              (w) => `${w.name}: ${w.usedPercent}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ''}`,
            ),
            ...(allowed === false ? ['ordinary usage is not allowed now'] : []),
          ].join('\n')
        : [...signedIn, 'no rate-limit data (not signed in with ChatGPT?)'].join('\n');
      const data = (quota ?? resp) as Record<string, unknown>;
      return ok(name, text, account && data && typeof data === 'object' ? { ...data, account } : data);
    }
    case 'usage': {
      const resp = (await rpc.request('account/usage/read', {})) as {
        summary?: Record<string, number>;
        dailyUsageBuckets?: Array<{ startDate?: string; tokens?: number }>;
      };
      const days = (resp?.dailyUsageBuckets ?? []).slice(-7);
      const summary = resp?.summary ?? {};
      const text = [
        ...Object.entries(summary).map(([k, v]) => `${k}: ${v}`),
        ...days.map((d) => `${d.startDate}: ${d.tokens} tokens`),
      ];
      return ok(name, lines(text, 'no usage data'), { summary, lastDays: days });
    }
    case 'model': {
      const resp = (await rpc.request('model/list', {})) as { data?: Array<Record<string, unknown>> };
      const models = (resp?.data ?? []).map((m) => ({
        id: String(m.id ?? m.model ?? ''),
        ...(typeof m.displayName === 'string' ? { displayName: m.displayName } : {}),
        ...(m.isDefault === true ? { isDefault: true } : {}),
        efforts: Array.isArray(m.supportedReasoningEfforts)
          ? (m.supportedReasoningEfforts as Array<{ reasoningEffort?: string }>)
              .map((e) => e.reasoningEffort)
              .filter((e): e is string => typeof e === 'string')
          : [],
      }));
      return ok(
        name,
        lines(
          models.map((m) => `${m.id}${m.isDefault ? ' (default)' : ''}: ${m.efforts.join(', ')}`),
          'no models',
        ),
        models,
      );
    }
    case 'mcp': {
      const sub = args?.trim();
      if (sub) {
        if (sub !== 'reload') throw new Error(`/mcp takes 'reload' or nothing, not '${sub}'`);
        if (ctx.engine !== 'codex-app') {
          throw new Error(
            '/mcp reload is for codex-app: each codex exec turn reads the MCP configuration as it starts',
          );
        }
        await rpc.request('config/mcpServer/reload', undefined);
        return ok(name, "the MCP servers' configuration is reloaded; the next turn uses it", {});
      }
      const resp = (await rpc.request('mcpServerStatus/list', {})) as { data?: Array<Record<string, unknown>> };
      const servers = (resp?.data ?? []).map((s) => {
        const tools = s.tools;
        const count = Array.isArray(tools)
          ? tools.length
          : tools && typeof tools === 'object'
            ? Object.keys(tools).length
            : 0;
        return {
          name: String(s.name ?? ''),
          ...(s.runtimeStatus != null ? { status: s.runtimeStatus } : {}),
          ...(s.authStatus != null ? { auth: s.authStatus } : {}),
          tools: count,
          ...(s.toolsError ? { error: String(s.toolsError) } : {}),
        };
      });
      return ok(
        name,
        lines(
          servers.map((s) => `${s.name}: ${s.tools} tools${s.error ? ` (error: ${s.error})` : ''}`),
          'no MCP servers',
        ),
        servers,
      );
    }
    case 'skills': {
      const { word, rest } = splitArgs(args);
      if (word) {
        if (word !== 'roots') throw new Error(`/skills takes 'roots <dir>...' or nothing, not '${word}'`);
        if (ctx.engine !== 'codex-app') {
          throw new Error('/skills roots is for codex-app: each codex exec turn is a process of its own');
        }
        const base = ctx.cwd ?? process.cwd();
        const roots = rest
          .split(/\s+/)
          .filter(Boolean)
          .map((d) => path.resolve(base, d));
        await rpc.request('skills/extraRoots/set', { extraRoots: roots });
        return ok(
          name,
          roots.length
            ? `skills are also read from ${roots.join(', ')} for this session`
            : 'no extra skill directories for this session',
          { extraRoots: roots },
        );
      }
      const skills = await listCodexSkills(rpc, ctx.cwd);
      return ok(
        name,
        lines(
          skills.map((s) => `${s.name}${s.scope ? ` [${s.scope}]` : ''}${s.enabled ? '' : ' (disabled)'}`),
          'no skills',
        ),
        skills.map(({ name: n, scope, enabled, description }) => ({ name: n, scope, enabled, description })),
      );
    }
    case 'hooks': {
      const resp = (await rpc.request('hooks/list', ctx.cwd ? { cwds: [ctx.cwd] } : {})) as {
        data?: Array<{ hooks?: Array<Record<string, unknown>> }>;
      };
      const hooks = (resp?.data ?? []).flatMap((d) =>
        (d.hooks ?? []).map((h) => ({
          event: String(h.eventName ?? ''),
          ...(typeof h.matcher === 'string' ? { matcher: h.matcher } : {}),
          ...(typeof h.command === 'string' ? { command: h.command } : {}),
          ...(typeof h.source === 'string' ? { source: h.source } : {}),
          enabled: h.enabled !== false,
        })),
      );
      return ok(
        name,
        lines(
          hooks.map(
            (h) => `${h.event}${h.matcher ? ` ${h.matcher}` : ''}: ${h.command ?? ''}${h.enabled ? '' : ' (disabled)'}`,
          ),
          'no hooks',
        ),
        hooks,
      );
    }
    case 'plugins': {
      const resp = (await rpc.request('plugin/installed', ctx.cwd ? { cwds: [ctx.cwd] } : {})) as {
        marketplaces?: Array<{ name?: string; plugins?: Array<Record<string, unknown>> }>;
      };
      const plugins = (resp?.marketplaces ?? []).flatMap((m) =>
        (m.plugins ?? []).map((p) => ({
          id: String(p.id ?? p.name ?? ''),
          marketplace: m.name,
          enabled: p.enabled !== false,
          ...(typeof p.version === 'string' ? { version: p.version } : {}),
        })),
      );
      return ok(
        name,
        lines(
          plugins.map((p) => `${p.id}${p.version ? ` ${p.version}` : ''}${p.enabled ? '' : ' (disabled)'}`),
          'no plugins installed',
        ),
        plugins,
      );
    }
    case 'apps': {
      const resp = (await rpc.request('app/installed', ctx.threadId ? { threadId: ctx.threadId } : {})) as {
        apps?: Array<Record<string, unknown>>;
      };
      // 0.172.0: `{ id, runtimeName, enabled, callable }` per app.
      const apps = (resp?.apps ?? []).map((a) => {
        const enabled = typeof a.enabled === 'boolean' ? a.enabled : a.isEnabled;
        return {
          id: String(a.id ?? ''),
          name: String(a.runtimeName ?? a.name ?? a.id ?? ''),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        };
      });
      return ok(
        name,
        lines(
          apps.map((a) => `${a.name}${a.enabled === false ? ' (disabled)' : ''}`),
          'no apps installed',
        ),
        apps,
      );
    }
    case 'experimental': {
      const resp = (await rpc.request('experimentalFeature/list', ctx.threadId ? { threadId: ctx.threadId } : {})) as {
        data?: Array<Record<string, unknown>>;
      };
      const features = (resp?.data ?? []).map((f) => ({
        name: String(f.name ?? ''),
        stage: String(f.stage ?? ''),
        enabled: f.enabled === true,
      }));
      return ok(
        name,
        lines(
          features.map((f) => `${f.name} [${f.stage}]: ${f.enabled ? 'on' : 'off'}`),
          'no features',
        ),
        features,
      );
    }
    case 'permissions': {
      const resp = (await rpc.request('permissionProfile/list', {})) as { data?: Array<Record<string, unknown>> };
      const profiles = (resp?.data ?? []).map((p) => ({ id: String(p.id ?? ''), allowed: p.allowed !== false }));
      return ok(
        name,
        lines(
          profiles.map((p) => `${p.id}${p.allowed ? '' : ' (not allowed)'}`),
          'no profiles',
        ),
        profiles,
      );
    }
    case 'config': {
      const resp = (await rpc.request('config/read', ctx.cwd ? { cwd: ctx.cwd } : {})) as {
        config?: Record<string, unknown>;
      };
      const cfg = resp?.config ?? {};
      const picked: Record<string, unknown> = {};
      for (const key of CONFIG_KEYS) if (cfg[key] !== undefined && cfg[key] !== null) picked[key] = cfg[key];
      if (cfg.features && typeof cfg.features === 'object') picked.features = cfg.features;
      if (cfg.mcp_servers && typeof cfg.mcp_servers === 'object') picked.mcp_servers = Object.keys(cfg.mcp_servers);
      if (cfg.profiles && typeof cfg.profiles === 'object') picked.profiles = Object.keys(cfg.profiles);
      return ok(
        name,
        lines(
          Object.entries(picked).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`),
          'no configuration',
        ),
        picked,
      );
    }
    case 'memories': {
      const mode = args?.trim().toLowerCase();
      if (mode === 'summary') {
        const resp = (await rpc.request('thread/memory/read', { threadId: needThread() })) as {
          summary?: string | null;
        };
        const summary = typeof resp?.summary === 'string' && resp.summary.trim() ? resp.summary : null;
        return ok(name, summary ?? 'no memory summary for this thread (memories off, or none written yet)', {
          summary,
        });
      }
      if (mode) {
        if (mode !== 'on' && mode !== 'off') {
          throw new Error(`/memories takes 'on', 'off' or 'summary', not '${args}'`);
        }
        await rpc.request('thread/memoryMode/set', {
          threadId: needThread(),
          mode: mode === 'on' ? 'enabled' : 'disabled',
        });
        return ok(name, `memories ${mode === 'on' ? 'enabled' : 'disabled'} for this thread`, { mode });
      }
      const status = await rpc.request('memory/status', {});
      return ok(name, JSON.stringify(status), status);
    }
    case 'rename': {
      const title = args?.trim();
      if (!title) throw new Error('/rename takes the new name');
      await rpc.request('thread/name/set', { threadId: needThread(), name: title });
      return ok(name, `thread renamed to "${title}"`, { name: title });
    }
    case 'ps': {
      const resp = (await rpc.request('thread/backgroundTerminals/list', { threadId: needThread() })) as {
        data?: unknown[];
      };
      const terminals = resp?.data ?? [];
      return ok(name, terminals.length ? JSON.stringify(terminals, null, 2) : 'no background terminals', terminals);
    }
    case 'stop': {
      const processId = args?.trim();
      if (processId) {
        const resp = (await rpc.request('thread/backgroundTerminals/terminate', {
          threadId: needThread(),
          processId,
        })) as { terminated?: boolean };
        const terminated = resp?.terminated === true;
        return {
          name,
          ok: terminated,
          text: terminated ? `stopped ${processId}` : `no background terminal ${processId} to stop`,
          data: { terminated },
          startedTurn: false,
          ...(terminated ? {} : { error: `no background terminal ${processId} to stop` }),
        };
      }
      const resp = await rpc.request('thread/backgroundTerminals/clean', { threadId: needThread() });
      return ok(name, 'background terminals stopped', resp);
    }
    case 'thread':
      return threadInfo(rpc, needThread(), ctx);
    case 'items': {
      const threadId = needThread();
      const [turnId, ...itemIds] = (args?.trim() ?? '').split(/\s+/).filter(Boolean);
      let entries: Array<{ turnId?: unknown; item?: Record<string, unknown> }>;
      let more = false;
      if (turnId && itemIds.length) {
        const resp = (await rpc.request('thread/items/read', { threadId, turnId, itemIds })) as {
          data?: typeof entries;
        };
        entries = resp?.data ?? [];
      } else {
        const resp = (await rpc.request(
          'thread/items/list',
          turnId ? { threadId, turnId, limit: 200 } : { threadId, limit: 20, sortDirection: 'desc' },
        )) as { data?: typeof entries; nextCursor?: string | null };
        entries = resp?.data ?? [];
        if (!turnId) entries = [...entries].reverse();
        more = !!resp?.nextCursor;
      }
      const text = lines(entries.map(codexItemLine), 'no items');
      const tail = more ? (turnId ? '\n… the turn has more items' : '\n… earlier items: /items <turnId>') : '';
      return ok(name, text + tail, entries);
    }
    case 'search': {
      const term = args?.trim();
      if (!term) throw new Error('/search takes the text to find in the thread');
      const resp = (await rpc.request('thread/searchOccurrences', {
        threadId: needThread(),
        searchTerm: term,
        limit: 50,
      })) as { data?: Array<{ turnId?: string; itemId?: string; snippet?: string }> };
      const hits = (resp?.data ?? []).map((o) => ({
        turnId: o.turnId ?? '',
        itemId: o.itemId ?? '',
        snippet: o.snippet ?? '',
      }));
      return ok(
        name,
        lines(
          hits.map((h) => `${h.turnId} ${h.itemId}: ${clip(h.snippet)}`),
          `'${term}' does not occur in the thread's messages`,
        ),
        hits,
      );
    }
    case 'threads': {
      const term = args?.trim();
      if (!term) throw new Error('/threads takes the text to search the Codex history for');
      const resp = (await rpc.request('thread/search', {
        searchTerm: term,
        limit: 20,
        sourceKinds: CODEX_LISTED_SOURCE_KINDS,
      })) as { data?: Array<{ thread?: Record<string, unknown>; snippet?: string }> };
      const hits = (resp?.data ?? []).map((r) => ({
        id: String(r.thread?.id ?? ''),
        name: typeof r.thread?.name === 'string' ? r.thread.name : null,
        cwd: typeof r.thread?.cwd === 'string' ? r.thread.cwd : null,
        updatedAt: isoSeconds(r.thread?.updatedAt),
        snippet: r.snippet ?? '',
      }));
      return ok(
        name,
        lines(
          hits.map((h) => `${h.id}${h.name ? ` (${h.name})` : ''}: ${clip(h.snippet)}`),
          `no thread mentions '${term}'`,
        ),
        hits,
      );
    }
    case 'modes': {
      const resp = (await rpc.request('collaborationMode/list', {})) as { data?: Array<Record<string, unknown>> };
      const modes = (resp?.data ?? []).map((m) => ({
        name: String(m.name ?? ''),
        mode: typeof m.mode === 'string' ? m.mode : null,
        model: typeof m.model === 'string' ? m.model : null,
        effort: typeof m.reasoning_effort === 'string' ? m.reasoning_effort : null,
      }));
      return ok(
        name,
        lines(
          modes.map(
            (m) =>
              `${m.name}${m.mode ? ` (${m.mode})` : ''}${m.model ? `, model ${m.model}` : ''}${m.effort ? `, effort ${m.effort}` : ''}`,
          ),
          'no collaboration modes',
        ),
        modes,
      );
    }
    case 'providers': {
      const resp = (await rpc.request('modelProvider/list', {})) as {
        data?: Array<Record<string, unknown>>;
        defaultProviderId?: string;
      };
      const caps = (await rpc.request('modelProvider/capabilities/read', {}).catch(() => undefined)) as
        | { imageGeneration?: boolean; webSearch?: boolean }
        | undefined;
      // Id, name and kind only: a provider's settings can name credential files and gateways.
      const providers = (resp?.data ?? []).map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? p.id ?? ''),
        kind: String((p.settings as { type?: unknown } | undefined)?.type ?? ''),
        default: p.id === resp?.defaultProviderId,
      }));
      const capabilities = caps
        ? { imageGeneration: caps.imageGeneration === true, webSearch: caps.webSearch === true }
        : undefined;
      return ok(
        name,
        [
          ...providers.map((p) => `${p.id}${p.name !== p.id ? ` (${p.name})` : ''}${p.default ? ' [default]' : ''}`),
          ...(capabilities
            ? [
                `current provider: image generation ${capabilities.imageGeneration ? 'yes' : 'no'}, ` +
                  `web search ${capabilities.webSearch ? 'yes' : 'no'}`,
              ]
            : []),
        ].join('\n') || 'no providers',
        { providers, ...(capabilities ? { capabilities } : {}) },
      );
    }
    case 'requirements': {
      const resp = (await rpc.request('configRequirements/read', {})) as {
        requirements?: Record<string, unknown> | null;
      };
      const req = resp?.requirements;
      if (!req) return ok(name, 'no requirements: an administrator restricts nothing', {});
      const picked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(req)) {
        if (value === null || value === undefined) continue;
        // Provider entries can carry gateway settings; their names say enough.
        picked[key] = key === 'modelProviders' && typeof value === 'object' ? Object.keys(value) : value;
      }
      return ok(
        name,
        lines(
          Object.entries(picked).map(
            ([k, v]) => `${k}: ${clip(typeof v === 'object' ? JSON.stringify(v) : String(v), 300)}`,
          ),
          'no requirements: an administrator restricts nothing',
        ),
        picked,
      );
    }
    case 'exec':
      return runCodexExec(rpc, name, args, ctx);
    case 'queue':
      return runCodexQueue(rpc, needThread(), args);
    default:
      return undefined;
  }
}
