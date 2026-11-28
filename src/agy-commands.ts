/**
 * Antigravity's slash commands, as a print-mode (`agy -p`) session can run them.
 *
 * agy reads a `-p` value that starts with `/` as a command or a skill (1.1.9+).
 * Measured on 1.5.18–1.5.19, print mode has three kinds:
 *
 *  - Info commands (`/help`, `/usage`, `/skills`, …) answer without a model turn:
 *    a `command_result` event, then a `result` with `num_turns: 0`, no `init`
 *    event, an empty `conversation_id`, zero usage, a tab-separated `response`
 *    (which may be empty) and the structured answer under `command.data`. `/help`
 *    lists exactly these. They take no arguments, except `/plugin list` (a bare
 *    `/plugin` opens an interactive manager and is refused).
 *  - System commands (`/goal`, `/compact`, `/boost`, `/teamwork`, …) and skills
 *    start a model turn: `init.expanded_commands` names each one that ran, with
 *    its type (`system` or `skill`). The list of system commands is not in `/help`;
 *    agy's ACP server advertises it (`available_commands_update`).
 *  - Interactive-only commands (`/clear`, `/resume`, `/btw`, …) are refused at no
 *    cost: a `result` with status ERROR, `num_turns: 0`, and an error naming the
 *    flag that replaces them.
 *
 * A `/word` that is none of these reaches the model as text (a paid turn with no
 * `expanded_commands`).
 */

import type { EngineCommand } from './types.js';

/** A command that starts a model turn, as agy's ACP server lists them (1.5.18). */
export const AGY_SYSTEM_COMMANDS: readonly EngineCommand[] = [
  {
    name: 'goal',
    source: 'builtin',
    startsTurn: true,
    args: '<objective>',
    description:
      'Run until the objective is completely finished: agy re-prompts the agent itself until it ends a reply with <!-- GOAL_COMPLETE -->.',
  },
  {
    name: 'compact',
    source: 'builtin',
    startsTurn: true,
    description: 'Summarize the conversation to free up the context window.',
  },
  {
    name: 'plan',
    source: 'builtin',
    startsTurn: true,
    args: '<task>',
    description: 'Write a plan for the task and stop for approval; the next message approves it.',
  },
  {
    name: 'boost',
    source: 'builtin',
    startsTurn: true,
    args: '<task>',
    description: 'Run the task through the Boost multi-agent orchestrator.',
  },
  {
    name: 'teamwork',
    source: 'builtin',
    startsTurn: true,
    args: '<task>',
    description:
      'Hand the task to a team of agents. clawo adds [skip-interview], since print mode cannot answer the interview.',
  },
  {
    name: 'schedule',
    source: 'builtin',
    startsTurn: true,
    args: '<instruction>',
    description: 'Run an instruction on a timer within the turn (the run waits for it, up to the turn timeout).',
  },
  {
    name: 'browser',
    source: 'builtin',
    startsTurn: true,
    args: '<task>',
    description: 'Hand a web task to the browser agent.',
  },
  {
    name: 'learn',
    source: 'builtin',
    startsTurn: true,
    description: 'Save lessons from the conversation as rules or skills (it may edit user-global rule files).',
  },
  {
    name: 'grill-me',
    source: 'builtin',
    startsTurn: true,
    needsHuman: true,
    args: '<plan>',
    description: 'Interview the user before planning; print mode skips the questions.',
  },
];

/**
 * The info commands print mode answers without a turn, as `/help` lists them
 * (1.5.19), with the argument each needs when it needs one.
 */
const AGY_INFO_COMMANDS: ReadonlyArray<{ name: string; description: string; args?: string; aliases?: string[] }> = [
  { name: 'agents', description: 'List available custom agents' },
  { name: 'changelog', description: 'Show release notes and changes' },
  { name: 'config', description: 'Show the settings', aliases: ['settings'] },
  { name: 'credits', description: 'Show remaining G1 credits' },
  { name: 'effort', description: 'Show the reasoning effort the session runs at' },
  { name: 'help', description: 'Show the commands print mode answers' },
  { name: 'hooks', description: 'List hook configurations' },
  { name: 'model', description: 'Show the model the session runs on' },
  { name: 'permissions', description: 'List tool permission rules' },
  { name: 'plugin', description: 'List plugins', args: 'list' },
  { name: 'skills', description: 'List available skills' },
  { name: 'usage', description: 'Show model quota usage', aliases: ['quota'] },
];

/** Names (and aliases) of the commands print mode answers without a turn. */
export const AGY_INFO_COMMAND_NAMES: ReadonlySet<string> = new Set(
  AGY_INFO_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
);

/** The info commands, as `EngineCommand`s. `help` is the list `/help` gives, when read. */
export function agyInfoCommands(help?: unknown): EngineCommand[] {
  const listed = readHelp(help);
  const known = new Map(AGY_INFO_COMMANDS.map((c) => [c.name, c]));
  const names = listed ? listed.map((c) => c.name) : AGY_INFO_COMMANDS.map((c) => c.name);
  return names.map((name) => {
    const ours = known.get(name);
    const theirs = listed?.find((c) => c.name === name);
    return {
      name,
      source: 'builtin' as const,
      startsTurn: false,
      description: ours?.description ?? theirs?.description,
      ...(ours?.args ? { args: ours.args } : {}),
    };
  });
}

function readHelp(help: unknown): Array<{ name: string; description?: string }> | undefined {
  const commands = (help as { commands?: unknown } | undefined)?.commands;
  if (!Array.isArray(commands)) return undefined;
  const out: Array<{ name: string; description?: string }> = [];
  for (const c of commands) {
    const name = (c as { name?: unknown })?.name;
    if (typeof name !== 'string' || !/^[\w:.-]+$/.test(name)) continue;
    const description = (c as { description?: unknown }).description;
    out.push({ name, ...(typeof description === 'string' ? { description } : {}) });
  }
  return out.length ? out : undefined;
}

/**
 * The skills `/skills` lists (`command.data.skills`: name, description, path,
 * builtin, model_invocable), as commands. A skill under a plugin's directory is
 * a plugin's; `swarm` is one, shipped with agy.
 */
export function agySkillCommands(skills: unknown, taken: ReadonlySet<string> = new Set()): EngineCommand[] {
  const list = (skills as { skills?: unknown } | undefined)?.skills;
  if (!Array.isArray(list)) return [];
  const out: EngineCommand[] = [];
  for (const s of list) {
    const name = (s as { name?: unknown })?.name;
    if (typeof name !== 'string' || !/^[\w:.-]+$/.test(name) || taken.has(name)) continue;
    const description = (s as { description?: unknown }).description;
    const skillPath = (s as { path?: unknown }).path;
    const plugin = typeof skillPath === 'string' && /[\\/]plugins?[\\/]|[\\/]skills[\\/]native/.test(skillPath);
    out.push({
      name,
      source: plugin ? 'plugin' : 'skill',
      startsTurn: true,
      ...(typeof description === 'string' ? { description } : {}),
    });
  }
  return out;
}

/** `/teamwork` asks for an interview first unless told to skip it; print mode cannot answer one. */
const SKIP_INTERVIEW = '[skip-interview]';

/**
 * The prompt that runs `command` (without its `/`, possibly with arguments of its
 * own, e.g. `teamwork`) on `text`. `/teamwork` gets `[skip-interview]` unless the
 * command or the text already starts with a bracketed directive.
 */
export function agyCommandPrompt(command: string, text: string | undefined): string {
  const head = command.trim().replace(/^\//, '');
  const body = text?.trim() ?? '';
  const word = head.split(/\s+/)[0];
  const directive = /\[[^\]]*\]/.test(head.slice(word.length)) || body.startsWith('[');
  const skip = word === 'teamwork' && !directive ? ` ${SKIP_INTERVIEW}` : '';
  return `/${head}${skip}${body ? ` ${body}` : ''}`;
}

/**
 * The command a message starts with: its first token, when that is `/word`
 * (`/plugin:skill` included). An absolute path (`/Users/x is broken`) names no
 * command, and agy passes it to the model as written.
 */
export function agyLeadingCommand(message: string): string | undefined {
  const m = /^\/([A-Za-z][\w:.-]*)(?=\s|$)/.exec(message.trimStart());
  return m?.[1];
}
