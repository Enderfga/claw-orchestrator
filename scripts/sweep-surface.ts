/**
 * The pure half of the weekly sweep's surface checks: parsing what an engine
 * declares (options, slash commands, RPC methods) and matching it against the
 * decisions recorded in scripts/sweep-reviewed.json. No process spawning and no
 * file access here, so every rule can be tested on captured text.
 */

// ─── Option declarations ────────────────────────────────────────────────────

/**
 * A commander flags string: `--name`, `-x, --name <value>`, `--a, --b [v]`.
 * Anything else passed to a constructor (an error message that starts with
 * `--max-budget-usd must be …`) is not an option declaration.
 */
const FLAGS_STRING = /^(?:-[A-Za-z0-9]+, )*--[A-Za-z][\w-]*(?:, --[A-Za-z][\w-]*)*(?: [<[].*)?$/;

/**
 * Every option declared in a commander program's source, keyed by long flag,
 * with its help text: `.option("…", "…")`, `.requiredOption(…)` and
 * `.addOption(new Option("…", "…"))` under any minified class name. Hidden
 * options (`.hideHelp()`) are declared the same way, which is the point — they
 * never reach --help.
 */
export function declaredOptions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:\.(?:option|requiredOption)|new [\w$.]+)\(\s*"(-[^"]*)"\s*(?:,\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2)?/g;
  for (const m of src.matchAll(re)) {
    const flags = m[1];
    if (!FLAGS_STRING.test(flags)) continue;
    const names = flags.replace(/ [<[].*$/, '').match(/--[A-Za-z][\w-]*/g) ?? [];
    for (const name of names) if (!out.has(name)) out.set(name, m[3] ?? '');
  }
  return out;
}

/**
 * The source of one commander program: from its anchor up to the first
 * `.command(`, where the subcommands (and their own options) begin. `text`
 * starts at the anchor.
 */
export function programRegion(text: string): string {
  const end = text.indexOf('.command(');
  return end < 0 ? text : text.slice(0, end);
}

/**
 * Whether a scan found the program it was aimed at: most of what --help lists
 * must be among the declarations. A moved anchor finds some other command's
 * options, or none, and both read like "nothing hidden" — which is how a
 * detector goes blind without anyone noticing.
 */
export function scanCovers(declared: Set<string>, helpFlags: Set<string>): boolean {
  const listed = [...helpFlags].filter((f) => f !== '--help' && f !== '--version');
  if (declared.size === 0 || listed.length === 0) return false;
  return listed.filter((f) => declared.has(f)).length / listed.length >= 0.5;
}

// ─── Slash commands and RPC methods ─────────────────────────────────────────

/** A command an engine lists, and the other names it answers to. */
export interface ListedCommand {
  name: string;
  aliases?: string[];
}

function aliasesOf(c: { aliases?: unknown }): Pick<ListedCommand, 'aliases'> {
  const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string' && !!a) : [];
  return aliases.length ? { aliases } : {};
}

/**
 * Claude's `initialize` control response: the built-in commands (`builtin:
 * true`), with their aliases. The user's skills, plugins and commands carry no
 * `builtin` flag.
 */
export function claudeBuiltinCommands(response: unknown): ListedCommand[] {
  const commands = (response as { commands?: unknown })?.commands;
  if (!Array.isArray(commands)) return [];
  return commands
    .filter(
      (c): c is { name: string; builtin: true; aliases?: unknown } => typeof c?.name === 'string' && c.builtin === true,
    )
    .map((c) => ({ name: c.name, ...aliasesOf(c) }));
}

/**
 * agy `-p /help` and `-p /skills` results: the print-mode commands with their
 * aliases, and the skills agy ships (`builtin: true`; the user's, the
 * workspace's and plugins' skills are `builtin: false`).
 */
export function agyCommands(help: unknown, skills: unknown): ListedCommand[] {
  const data = (r: unknown) => (r as { command?: { data?: Record<string, unknown> } })?.command?.data;
  const out: ListedCommand[] = [];
  const cmds = data(help)?.commands;
  if (Array.isArray(cmds))
    for (const c of cmds) if (typeof c?.name === 'string') out.push({ name: c.name, ...aliasesOf(c) });
  const sk = data(skills)?.skills;
  if (Array.isArray(sk))
    for (const s of sk) if (typeof s?.name === 'string' && s.builtin === true) out.push({ name: s.name });
  return out;
}

export interface AcpCommand {
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

/** Scopes that belong to the user's machine (their skills, plugins, project), not to the engine. */
const USER_SCOPES = new Set(['user', 'project', 'local', 'workspace', 'plugin', 'team']);

/** Whether `file` is `dir` or lies below it. */
export function isUnder(file: string, dir: string): boolean {
  const root = dir.replace(/[\\/]+$/, '');
  return file === root || file.startsWith(`${root}/`) || file.startsWith(`${root}\\`);
}

/**
 * grok's ACP `available_commands_update`: built-ins carry no `_meta`, skills
 * carry `_meta.scope` (`bundled`, `user`) and `_meta.path`, workflows
 * `_meta.workflowSource` and `_meta.workflowPath`. A command is grok's own when
 * its scope is not the user's and, given `ownDirs` (the grok home the listing
 * ran on, where grok unpacks what it ships), its file lies in one of them: a
 * Claude plugin's skill that grok imports is scoped `user` with a path under
 * ~/.claude/plugins, and a file outside grok's home is the machine's whatever
 * scope it reports. A bundled skill whose bare name collides with a user skill
 * is advertised as `bundled:<name>`, so the bare name is what gets reviewed.
 */
export function grokEngineCommands(commands: AcpCommand[], ownDirs: string[] = []): string[] {
  const out: string[] = [];
  for (const c of commands) {
    const meta = c._meta ?? {};
    const scope = typeof meta.scope === 'string' ? meta.scope : undefined;
    const workflow = typeof meta.workflowSource === 'string' ? meta.workflowSource : undefined;
    if ((scope && USER_SCOPES.has(scope)) || (workflow && USER_SCOPES.has(workflow))) continue;
    const file = [meta.path, meta.workflowPath].find((p): p is string => typeof p === 'string' && p !== '');
    if (file && ownDirs.length && !ownDirs.some((d) => isUnder(file, d))) continue;
    out.push(typeof meta.bareName === 'string' && meta.bareName ? meta.bareName : c.name);
  }
  return out;
}

/**
 * Cursor's ACP `available_commands_update`: the source is the parenthesised
 * suffix of the description. `(user skill)`, `(project skill)`, `(user)`,
 * `(project)` and `(team)` are the user's, the workspace's and the team's;
 * `(skill)` is one from a plugin or another agent's skill directory (2026.11.22).
 * `(builtin skill)`, `(global)` (the commands Cursor's server sends every
 * account) and no marker (a built-in command) are Cursor's own. Only those
 * markers are dropped, so a new one shows up for review rather than vanishing.
 */
export function cursorEngineCommands(commands: AcpCommand[]): string[] {
  const userMarkers = new Set(['user', 'project', 'team', 'user skill', 'project skill', 'skill']);
  return commands
    .filter((c) => {
      const marker = c.description?.match(/\(([^()]*)\)\s*$/)?.[1]?.trim();
      return !(marker && userMarkers.has(marker));
    })
    .map((c) => c.name);
}

/**
 * The environment OpenCode's command listing runs in. `/api/command` names no
 * source, so the user's and the project's commands are kept out by isolation:
 * a config home of the listing's own (`XDG_CONFIG_HOME`), an empty working
 * directory, and none of the variables that add configuration — each of
 * `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` put the user's commands
 * in the list (2.4.2, measured), and `OPENCODE_CONFIG` names a config file.
 */
export function opencodeListingEnv(
  base: Readonly<Record<string, string | undefined>>,
  dirs: { configHome: string; cwd: string },
  password: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('OPENCODE_CONFIG')) env[k] = v;
  return { ...env, OPENCODE_PASSWORD: password, XDG_CONFIG_HOME: dirs.configHome, PWD: dirs.cwd };
}

/** The method names of the codex app-server's `ClientRequest` JSON schema. */
export function codexRpcMethods(schema: unknown): string[] {
  const variants = (schema as { oneOf?: unknown[] })?.oneOf;
  if (!Array.isArray(variants)) return [];
  const out: string[] = [];
  for (const v of variants) {
    const method = (v as { properties?: { method?: { enum?: unknown[]; const?: unknown } } })?.properties?.method;
    for (const m of method?.enum ?? (method?.const !== undefined ? [method.const] : []))
      if (typeof m === 'string') out.push(m);
  }
  return out;
}

// ─── Review matching ────────────────────────────────────────────────────────

/**
 * The decision recorded for a name. An exact key wins; otherwise the longest
 * key ending in `*` whose prefix the name starts with (`fs/*` covers every
 * `fs/` method), so a namespace that is skipped as a whole takes one line.
 */
export function decisionFor(name: string, reviewed: Record<string, string>): string | undefined {
  if (Object.prototype.hasOwnProperty.call(reviewed, name)) return reviewed[name];
  let best: string | undefined;
  for (const key of Object.keys(reviewed)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (name.startsWith(prefix) && (!best || key.length > best.length)) best = key;
  }
  return best ? reviewed[best] : undefined;
}

/** Listed names with no decision and no reference in the engine's source. */
export function unreviewedNames(names: Iterable<string>, reviewed: Record<string, string>, referenced: Set<string>) {
  return [...new Set(names)].filter((n) => !referenced.has(n) && decisionFor(n, reviewed) === undefined).sort();
}

/** Decisions that no longer match anything the engine lists. */
export function staleDecisions(reviewed: Record<string, string>, names: Iterable<string>): string[] {
  const listed = [...new Set(names)];
  return Object.keys(reviewed)
    .filter((key) => (key.endsWith('*') ? !listed.some((n) => n.startsWith(key.slice(0, -1))) : !listed.includes(key)))
    .sort();
}

/**
 * Names recorded as skipped that the engine's source now uses — a decision a
 * later change overtook. Kept apart from stale entries: the name is still
 * listed, only the reason is wrong.
 */
export function contradictedDecisions(reviewed: Record<string, string>, referenced: Set<string>): string[] {
  return Object.entries(reviewed)
    .filter(([key, why]) => !key.endsWith('*') && referenced.has(key) && /^skip\b/i.test(why))
    .map(([key]) => key)
    .sort();
}

/** Which of `names` appear as a quoted literal (`'<prefix><name>'` or `"…"`) in `src`. */
export function quotedIn(src: string, names: Iterable<string>, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    const lit = prefix + n;
    if (src.includes(`'${lit}'`) || src.includes(`"${lit}"`)) out.add(n);
  }
  return out;
}

/**
 * An engine's command decisions, in two maps. `listed` holds the names its
 * listing shows, and a key that matches nothing listed any more is stale.
 * `unlisted` holds the names the listing cannot show — TUI-only commands, and
 * ones the headless list leaves out — whose absence says nothing.
 */
export interface CommandDecisions {
  listed: Record<string, string>;
  unlisted: Record<string, string>;
}

export interface ListingReview {
  /** Listed with no decision under any of its names and not named in the engine's source. */
  unreviewed: string[];
  /** `listed` decisions that match nothing listed, by name or alias. */
  stale: string[];
  /** `unlisted` decisions the listing shows now: they belong under `listed`. */
  nowListed: string[];
  /** Recorded as skipped, yet the engine's source names them. */
  contradicted: string[];
  /**
   * Keys that can never match a listed name: an alias group (`model/models`),
   * a note (`skills (user:*)`), or a name in both maps. `slashInNames` is true
   * where names are paths (codex RPC methods); a slash command holds no `/`.
   */
  malformed: string[];
}

/** An engine's listing against its decisions. A command counts as reviewed when any of its names is. */
export function reviewListing(
  listing: ListedCommand[],
  decisions: CommandDecisions,
  referenced: Set<string>,
  opts: { slashInNames: boolean },
): ListingReview {
  const all = { ...decisions.unlisted, ...decisions.listed };
  const names = (c: ListedCommand) => [c.name, ...(c.aliases ?? [])];
  const known = listing.flatMap(names);
  const unreviewed = new Set<string>();
  for (const c of listing)
    if (!names(c).some((n) => referenced.has(n) || decisionFor(n, all) !== undefined)) unreviewed.add(c.name);
  const unlistedNotShown = new Set(staleDecisions(decisions.unlisted, known));
  const shape = opts.slashInNames ? /[\s()]/ : /[\s()/]/;
  const malformed = [
    ...Object.keys(decisions.listed).filter(
      (k) => shape.test(k) || Object.prototype.hasOwnProperty.call(decisions.unlisted, k),
    ),
    ...Object.keys(decisions.unlisted).filter((k) => shape.test(k)),
  ];
  return {
    unreviewed: [...unreviewed].sort(),
    stale: staleDecisions(decisions.listed, known),
    nowListed: Object.keys(decisions.unlisted)
      .filter((k) => !unlistedNotShown.has(k))
      .sort(),
    contradicted: contradictedDecisions(all, referenced),
    malformed: [...new Set(malformed)].sort(),
  };
}

// ─── Global config writes ───────────────────────────────────────────────────

/**
 * What a run changed in one config file: the top-level keys whose values
 * differ (JSON), or `(content)` when the file is not JSON. Keys matching
 * `volatile` are caches the engine refreshes on every run, whatever the flags
 * (Cursor rewrites `privacyCache` on a plain `-p`). `(created)` / `(deleted)`
 * when the file appeared or went away.
 */
export function configChanges(before: string | null, after: string | null, volatile?: RegExp): string[] {
  if (before === after) return [];
  if (before === null) return ['(created)'];
  if (after === null) return ['(deleted)'];
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return ['(content)'];
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return ['(content)'];
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  return [...new Set([...Object.keys(ao), ...Object.keys(bo)])]
    .filter((k) => !volatile?.test(k) && JSON.stringify(ao[k]) !== JSON.stringify(bo[k]))
    .sort();
}
