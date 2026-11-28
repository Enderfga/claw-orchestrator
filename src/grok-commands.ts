/**
 * Grok Build's slash commands, as the one-shot wrapper sees them.
 *
 * `grok -p` handles a leading `/name` three ways (1.0.92, measured):
 *
 *  1. The shell built-ins (`/compact`, `/session-info`, `/goal status`, …)
 *     answer locally, free, in about two seconds; their `end` line carries no
 *     usage.
 *  2. Skills and workflows run as model turns.
 *  3. Pager built-ins — the TUI's own commands (`/help`, `/model`, `/btw`,
 *     `/rewind`, …) — are not handled at all: they reach the model as plain text
 *     and cost a turn in which it improvises.
 *
 * And some shell built-ins cannot do their job in a process that exits after
 * the turn: a workflow launch (`/deep-research <query>`, `/workflow <name>`,
 * `/<workflow>`) is stopped by the exit, and `/loop` schedules a job that dies
 * with the process. Those run on the long-lived ACP route (`grok agent stdio`,
 * the `grok` preset), where a finished run reports back as an engine turn.
 */

import type { EngineCommand } from './types.js';

/**
 * The shell built-ins of grok's print mode, with grok's own descriptions and
 * argument hints (ACP `available_commands_update`, 1.0.92).
 */
export const GROK_SHELL_COMMANDS: readonly EngineCommand[] = [
  {
    name: 'compact',
    description: 'Compress conversation history to save context window',
    source: 'builtin',
    // Runs in the send chain: it rewrites the conversation the next turn reads.
    startsTurn: true,
  },
  {
    name: 'always-approve',
    description: 'Toggle always-approve mode (skip all permission prompts)',
    source: 'builtin',
    args: 'on|off',
    startsTurn: false,
  },
  {
    name: 'context',
    description:
      'Show context window usage and session stats. Its breakdown renders only in the TUI: headless grok answers it with an empty reply (use session-info)',
    source: 'builtin',
    startsTurn: false,
    needsHuman: true,
  },
  { name: 'hooks-trust', description: 'Trust this project for hook execution', source: 'builtin', startsTurn: false },
  { name: 'hooks-list', description: 'Show hooks loaded in this session', source: 'builtin', startsTurn: false },
  {
    name: 'hooks-add',
    description: 'Add a custom hook file or directory',
    source: 'builtin',
    args: 'path to hook file or directory',
    startsTurn: false,
  },
  {
    name: 'hooks-remove',
    description: 'Remove a custom hook file or directory path',
    source: 'builtin',
    args: 'path to hook file or directory',
    startsTurn: false,
  },
  { name: 'hooks-untrust', description: 'Remove trust for the current project', source: 'builtin', startsTurn: false },
  {
    name: 'plugins',
    description: 'Manage plugins (list, reload, trust, add, remove)',
    source: 'builtin',
    args: 'list | reload | trust <path> | add <path> | remove <path>',
    startsTurn: false,
  },
  {
    name: 'reload-plugins',
    description: 'Reload plugins from disk (alias for /plugins reload)',
    source: 'builtin',
    startsTurn: false,
  },
  {
    name: 'session-info',
    description: 'Show session details (model, turns, context usage)',
    source: 'builtin',
    startsTurn: false,
  },
  {
    name: 'feedback',
    description:
      "Send feedback about the current session to xAI. Not sent from clawo: bare it opens a form, and with text it sends the session to xAI at once; use grok's TUI",
    source: 'builtin',
    args: 'feedback text',
    startsTurn: false,
    needsHuman: true,
  },
  {
    name: 'deep-research',
    description:
      'Research with bounded parallel agents, cross-check evidence, and write a cited report. A background workflow: runs on the grok ACP preset, not in a one-shot session',
    source: 'builtin',
    args: '<query>',
    startsTurn: true,
  },
  {
    name: 'workflow',
    description:
      'Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save). A launch runs in the background: on the grok ACP preset, not in a one-shot session',
    source: 'builtin',
    args: '<name> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [name]',
    startsTurn: true,
  },
  {
    name: 'goal',
    description: "Set, manage, or check an autonomous goal (grok's own goal loop; see also nativeGoal)",
    source: 'builtin',
    args: '<objective> [--budget <tokens>] | status | pause | resume | clear',
    startsTurn: true,
  },
  {
    name: 'loop',
    description:
      'Run a prompt on a recurring interval. The job lives in the grok process: runs on the grok ACP preset, not in a one-shot session',
    source: 'builtin',
    args: '[interval] <prompt>',
    startsTurn: true,
  },
];

/** Aliases grok's print mode answers like the built-in they name. */
const SHELL_ALIASES: Readonly<Record<string, string>> = { status: 'session-info', info: 'session-info' };

/**
 * The pager built-ins: TUI commands headless grok sends to the model as text.
 * Each maps to what to use from clawo instead ('' when nothing takes its place).
 * From grok's 04-slash-commands.md (1.0.92), aliases included.
 */
export const GROK_PAGER_COMMANDS: Readonly<Record<string, string>> = {
  help: 'session_command list, which shows what this session can run',
  new: 'start a new session (session_start)',
  clear: 'start a new session (session_start)',
  resume: 'resume by id with resumeSessionId on session_start',
  dashboard: '',
  'agents-dashboard': '',
  sessions: 'session_list',
  fork: 'forkSession on session_start',
  rewind: '',
  undo: '',
  copy: '',
  export: 'run `grok export <session-id>` in a shell',
  quit: 'session_stop',
  exit: 'session_stop',
  home: '',
  welcome: '',
  delete: '',
  rename: '',
  title: '',
  model: 'session_switch_model, or model on session_send for one turn',
  models: '',
  effort: 'effort on session_start or session_send',
  'context-window': '',
  'auto-review': "permissionMode 'auto' on session_start",
  multiline: '',
  history: '',
  'compact-mode': '',
  density: '',
  'vim-mode': '',
  'edit-prompt': '',
  minimal: '',
  fullscreen: '',
  full: '',
  plan: "plan on session_send, or permissionMode 'plan' on session_start",
  'view-plan': '',
  'show-plan': '',
  'plan-view': '',
  memory: '',
  mem: '',
  flush: '',
  dream: '',
  remember: '',
  hooks: 'session_command hooks-list',
  marketplace: '',
  skills: 'session_command list',
  imagine: 'session_command bundled:imagine',
  'imagine-video': '',
  workflows: 'session_command list',
  theme: '',
  t: '',
  btw: 'session_aside',
  mcps: '',
  connectors: '',
  doctor: '',
  'release-notes': '',
  changelog: '',
  docs: '',
  howto: '',
  guides: '',
  tutorial: '',
  tour: '',
  onboarding: '',
  'import-claude': '',
  'config-agents': 'agent or agents on session_start',
  agents: 'agent or agents on session_start',
  personas: 'agent on session_start',
  login: '',
  logout: '',
  usage: 'engine_quota, or `grok usage <session-id>` in a shell',
  cost: 'engine_quota, or `grok usage <session-id>` in a shell',
  privacy: '',
  settings: '',
  config: '',
  preferences: '',
  prefs: '',
  timestamps: '',
};

/** The pager built-ins as listed commands: each needs grok's TUI. */
export function grokPagerCommands(): EngineCommand[] {
  return Object.entries(GROK_PAGER_COMMANDS).map(([name, instead]) => ({
    name,
    description: `A grok TUI command; headless grok sends it to the model as text${instead ? `. Use ${instead}` : ''}`,
    source: 'builtin',
    startsTurn: false,
    needsHuman: true,
  }));
}

/**
 * `/name args` as grok reads a command: the first word is `/` and a name made
 * of letters, digits and `-`, optionally qualified (`user:docs`). A first word
 * that holds another `/` (`/tmp/x.log`) or is shaped otherwise (`/README.md`,
 * `/fix_issue`) is sent as typed, so it is not a command.
 */
export function parseGrokCommand(message: string): { name: string; args: string } | undefined {
  const m = /^\s*\/([A-Za-z0-9][A-Za-z0-9-]*(?::[A-Za-z0-9][A-Za-z0-9-]*)?)(?=\s|$)([\s\S]*)$/.exec(message);
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), args: m[2].trim() };
}

/** The shell built-in `name` names, aliases resolved; undefined for any other name. */
export function grokShellCommand(name: string): EngineCommand | undefined {
  const canonical = SHELL_ALIASES[name] ?? name;
  return GROK_SHELL_COMMANDS.find((c) => c.name === canonical);
}

/** Workflow verbs that answer at once, with no run started. */
const WORKFLOW_LOCAL_VERBS = /^(?:runs|list|help|pause|resume|stop|save)(?:\s|$)/i;

/** Arguments of `/goal` that answer at once: everything but an objective and `resume`. */
const GOAL_LOCAL_ARGS = /^(?:status|pause|clear)?$/i;

/**
 * True when grok answers `/<name> <args>` itself, with no model call: an info
 * command, safe to run beside a turn's bookkeeping and never a turn.
 */
export function grokCommandIsLocal(name: string, args: string): boolean {
  const cmd = grokShellCommand(name);
  if (!cmd) return false;
  switch (cmd.name) {
    case 'goal':
      return GOAL_LOCAL_ARGS.test(args.trim());
    case 'workflow':
      return !args.trim() || WORKFLOW_LOCAL_VERBS.test(args.trim());
    case 'deep-research':
      // Bare, it answers with a usage line.
      return !args.trim();
    case 'compact':
    case 'loop':
    case 'feedback':
      return false;
    default:
      return true;
  }
}

/** Where a background command goes instead of a one-shot session. */
const ACP_ROUTE = "grok's long-lived ACP route (engine 'acp', acpAgent 'grok')";

/**
 * Why a one-shot grok session refuses `message`, or undefined when it may be
 * sent. `workflows` names the workflows the session can launch by their own
 * slash name (`/learn-traces`).
 */
export function grokCommandRefusal(message: string, workflows: ReadonlySet<string> = new Set()): string | undefined {
  const cmd = parseGrokCommand(message);
  if (!cmd) return undefined;
  const { name, args } = cmd;
  if (name in GROK_PAGER_COMMANDS) {
    const instead = GROK_PAGER_COMMANDS[name];
    return (
      `/${name} is a grok TUI command: headless grok does not run it and would send it to the model as text, ` +
      `costing a turn.${instead ? ` Use ${instead}.` : ' clawo has nothing in its place.'}`
    );
  }
  if (name === 'loop') {
    return (
      "/loop schedules its job inside the grok process, and a one-shot grok session's process exits after the turn, " +
      `which ends the job. Use clawo's own scheduling (autoloop, an outer cron), or run it on ${ACP_ROUTE}, ` +
      'where each fire comes back as an engine turn.'
    );
  }
  if (name === 'feedback') {
    return "/feedback sends this session to xAI; clawo does not send it. Use grok's TUI.";
  }
  if (name === 'context') {
    return '/context renders its breakdown only in the TUI; headless grok answers it with an empty reply. Use /session-info.';
  }
  const workflowLaunch =
    (name === 'deep-research' && !!args) ||
    (name === 'workflow' && !!args && !WORKFLOW_LOCAL_VERBS.test(args)) ||
    workflows.has(name);
  if (workflowLaunch) {
    return (
      `/${name}${name === 'workflow' ? ` ${args.split(/\s+/)[0]}` : ''} runs a workflow in the background, which cannot ` +
      `finish in a one-shot grok session: the process exits after the launch reply and stops the run. Run it on ${ACP_ROUTE}, ` +
      'where the finished run reports back as an engine turn.'
    );
  }
  return undefined;
}

/** One entry of grok's ACP `_x.ai/commands/list`. */
interface GrokAcpCommand {
  name?: unknown;
  description?: unknown;
  input?: { hint?: unknown } | null;
  _meta?: { workflowSource?: unknown; pluginName?: unknown; scope?: unknown } | null;
}

/**
 * The skills and workflows in grok's ACP `_x.ai/commands/list` result, as
 * listed commands. Built-ins are left to the tables above, which carry what
 * clawo knows about each. `workflows` collects the workflow names.
 */
export function commandsFromGrokAcpList(result: unknown, workflows?: Set<string>): EngineCommand[] {
  const list = (result as { commands?: unknown } | undefined)?.commands;
  if (!Array.isArray(list)) return [];
  const out: EngineCommand[] = [];
  for (const raw of list as GrokAcpCommand[]) {
    if (typeof raw?.name !== 'string' || !raw.name) continue;
    const name = raw.name.toLowerCase();
    if (grokShellCommand(name) || name in GROK_PAGER_COMMANDS) continue;
    const meta = raw._meta ?? {};
    const hint = typeof raw.input?.hint === 'string' ? raw.input.hint : undefined;
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    if (meta.workflowSource !== undefined) {
      workflows?.add(name);
      out.push({
        name,
        description: `${description ? `${description}. ` : ''}A background workflow: runs on the grok ACP preset, not in a one-shot session`,
        source: meta.workflowSource === 'builtin' ? 'builtin' : 'custom',
        ...(hint ? { args: hint } : {}),
        startsTurn: true,
      });
      continue;
    }
    out.push({
      name,
      ...(description ? { description } : {}),
      source: typeof meta.pluginName === 'string' ? 'plugin' : 'skill',
      ...(hint ? { args: hint } : {}),
      startsTurn: true,
    });
  }
  return out;
}

/** `**Context:** N / M tokens` and `**Turn:** T` in a `/session-info` reply. */
export function parseGrokSessionContext(text: string): { used: number; total: number; turn?: number } | undefined {
  const m = /\*\*Context:\*\*\s*([\d,]+)\s*\/\s*([\d,]+)\s*tokens/i.exec(text);
  if (!m) return undefined;
  const used = Number(m[1].replace(/,/g, ''));
  const total = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(used) || !Number.isFinite(total)) return undefined;
  const turn = /\*\*Turn:\*\*\s*(\d+)/i.exec(text)?.[1];
  return { used, total, ...(turn !== undefined ? { turn: Number(turn) } : {}) };
}

/** A grok goal as `/goal status` or `goal/state.json` describes it. */
export interface GrokGoalState {
  objective: string;
  /** grok's status, lower-case with separators removed: `complete`, `infrapaused`, `userpaused`, … */
  status: string;
  phase?: string;
  tokensUsed?: number;
  elapsedSeconds?: number;
  tokenBudget?: number | null;
  /** What grok said when it paused the goal. */
  pauseMessage?: string;
}

/** A grok status name in one spelling: `InfraPaused`, `infra_paused` → `infrapaused`. */
export function normalizeGrokGoalStatus(status: string): string {
  return status.toLowerCase().replace(/[^a-z]/g, '');
}

/** A `/goal status` reply; `null` when no goal is set, undefined when it is not one. */
export function parseGrokGoalStatus(text: string): GrokGoalState | null | undefined {
  const t = text.trim();
  if (/^no goal (?:is currently )?set/i.test(t)) return null;
  const status = /^Status:\s*([A-Za-z_]+)(?:\s*\|\s*Phase:\s*([A-Za-z_]+))?/im.exec(t);
  if (!status) return undefined;
  const objective = /^Goal:\s*([\s\S]*?)\s*^Status:/im.exec(t)?.[1]?.trim() ?? '';
  const tokens = /^Goal tokens used:\s*([\d,]+)/im.exec(t)?.[1];
  const elapsed = /^Elapsed:\s*(.+)$/im.exec(t)?.[1];
  return {
    objective,
    status: normalizeGrokGoalStatus(status[1]),
    ...(status[2] ? { phase: status[2] } : {}),
    ...(tokens ? { tokensUsed: Number(tokens.replace(/,/g, '')) } : {}),
    ...(elapsed ? { elapsedSeconds: parseElapsed(elapsed) } : {}),
  };
}

/** `2m37s`, `7s`, `1h2m` → seconds. */
function parseElapsed(text: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/g)) {
    matched = true;
    total += Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  }
  return matched ? Math.round(total) : undefined;
}

/** A goal's `goal/state.json`, as grok 1.0.92 writes it. */
export function parseGrokGoalStateFile(raw: unknown): GrokGoalState | undefined {
  const s = raw as Record<string, unknown> | undefined;
  if (!s || typeof s.objective !== 'string' || typeof s.status !== 'string') return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const elapsedMs = num(s.elapsed_ms);
  return {
    objective: s.objective,
    status: normalizeGrokGoalStatus(s.status),
    ...(typeof s.phase === 'string' ? { phase: s.phase } : {}),
    ...(num(s.tokens_used_high_water) !== undefined ? { tokensUsed: num(s.tokens_used_high_water) } : {}),
    ...(elapsedMs !== undefined ? { elapsedSeconds: Math.round(elapsedMs / 1000) } : {}),
    tokenBudget: num(s.token_budget) ?? null,
    ...(typeof s.pause_message === 'string' ? { pauseMessage: s.pause_message } : {}),
  };
}
