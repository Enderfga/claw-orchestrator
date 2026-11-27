/**
 * Council — Multi-agent collaboration engine
 *
 * Ported from three-minds and adapted to use SessionManager + ISession
 * directly (no HTTP/SSE to external services).
 *
 * Key patterns:
 * - Git worktree isolation per agent
 * - Two-phase protocol: planning round → execution rounds
 * - Consensus voting: all agents vote YES to complete
 * - Parallel execution via Promise.allSettled
 * - Engine-agnostic: agents can use Claude, Codex, or any ISession engine
 */

import { defaultEngine } from './clawo-config.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { withoutServerCredential } from './kernel/secrets.js';
import { changedFilesSince } from './verify/baseline.js';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CouncilConfig,
  type CouncilSession,
  type AgentResponse,
  type AgentPersona,
  type CouncilEvent,
  type CouncilHistoryEntry,
  type CouncilRoundResult,
  type CouncilReviewResult,
  type CouncilAcceptResult,
  type CouncilRejectResult,
  type CouncilChangedFile,
  type CouncilFileChange,
  type EngineType,
  type SessionConfig,
  type SessionInfo,
  type SendOptions,
  type SendResult,
} from './types.js';
import { parseConsensusWithSource, stripConsensusTags, hasConsensusMarker } from './consensus.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MIN_TASK_LENGTH,
  INTER_ROUND_DELAY_MS,
  EMPTY_RESPONSE_MAX_RETRIES,
  EMPTY_RESPONSE_RETRY_DELAY_MS,
  MIN_COMPLETE_RESPONSE_LENGTH,
  FOLLOWUP_MAX_RETRIES,
  HISTORY_PREVIEW_CHARS,
  SUMMARY_PREVIEW_CHARS,
  SUMMARY_SHORT_CHARS,
  COMPACT_CONTEXT_CHARS,
  DEFAULT_MAX_TURNS_PER_AGENT,
  GIT_CMD_TIMEOUT_MS,
  WORKTREE_CMD_TIMEOUT_MS,
  FOLLOWUP_TIMEOUT_MS,
  DEFAULT_MAX_ROUNDS,
} from './constants.js';
import { type Logger, createConsoleLogger } from './logger.js';
import { mapBounded } from './concurrency.js';
import { fenceForumText } from './kernel/forum.js';

// Forward-declare SessionManager to avoid circular imports at the type level.
// The actual instance is injected via constructor.
interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
  /** Optional so lightweight fakes stay valid; without it every agent starts at once. */
  freeSessionSlots?(): number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Git Utilities ──────────────────────────────────────────────────────────

/**
 * The worktrees this council created, as git itself reports them.
 *
 * Both callers used to select with `wtPath.includes('council')`, which is a
 * substring test against an absolute path — so a user's own worktree at
 * `~/council-notes` matched while council's real one at `.worktrees/agent-A`
 * did not. On the cleanup path that meant `git worktree remove --force` ran on
 * the user's uncommitted work and never on ours (measured on a scratch repo).
 * `setupWorktrees` only ever creates `{projectDir}/.worktrees/{agent}`, so
 * containment under that directory is the actual predicate.
 *
 * `--porcelain` because the human-readable format is whitespace-separated and
 * `split(/\s+/)[0]` truncates any path containing a space.
 */
export async function councilWorktreePaths(projectDir: string): Promise<string[]> {
  const listed = await spawnAsync('git', ['-C', projectDir, 'worktree', 'list', '--porcelain'], {
    timeout: GIT_CMD_TIMEOUT_MS,
  }).catch(() => ({ stdout: '', stderr: '' }));
  // `git worktree list` reports real paths, so a projectDir reached through a
  // symlink (every macOS temp dir is one) would never match a textual prefix.
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const self = real(projectDir);
  const root = path.join(self, '.worktrees') + path.sep;
  return listed.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => real(l.slice('worktree '.length).trim()))
    .filter((p) => p && p !== self && (p + path.sep).startsWith(root));
}

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      // Council's git calls run the project repository's hooks: never with the
      // server's credential.
      env: withoutServerCredential(process.env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('spawn timeout'));
        }, opts.timeout)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      else resolve({ stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

const VALID_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Whether the council commits a seat's changes for it (`commitSeatWork`).
 *
 * A worktree keeps its git metadata outside itself: the repository's common
 * directory and the worktree's own (`<common>/worktrees/<name>`). Codex's
 * workspace-write sandbox (its default) lets a session write only under its
 * writable roots, so a Codex seat's `git commit` fails there (measured with
 * Codex 0.172.0's macOS sandbox).
 *
 * The seat is not given those directories instead, as extra writable roots:
 * git trusts what is in them, and the council's git commands, and the user's,
 * run outside the sandbox. With the common directory a seat plants a hook or a
 * `core.fsmonitor` in its config. With its worktree's own directory, which
 * every commit writes (the index, `COMMIT_EDITMSG`), it repoints `commondir` at
 * a config of its own, removes it so that directory becomes a repository with
 * its own config, or writes a `config.worktree` when the repository has
 * `extensions.worktreeConfig`; the next git command in the worktree runs what it
 * wrote (each measured). No narrower set of directories lets a seat commit.
 *
 * Seats on the other engines commit themselves: Claude Code, OpenCode, ACP and
 * custom engines run under no sandbox clawo sets; grok, Cursor and agy are
 * sandboxed only when asked, and how each treats git metadata there is not
 * measured.
 */
function councilCommitsForSeat(engine: EngineType, sandboxMode: AgentPersona['sandboxMode']): boolean {
  return (
    (engine === 'codex' || engine === 'codex-app') &&
    sandboxMode !== 'read-only' &&
    sandboxMode !== 'danger-full-access'
  );
}

/** How long the council's `git add` / `git commit` of a seat's worktree may take. */
const SEAT_COMMIT_TIMEOUT_MS = 60_000;

/**
 * Git, as the council runs it in a seat's worktree: not inside a submodule (git
 * there runs under the submodule's own config, which the seat can write), with
 * no fsmonitor and no hooks.
 */
function seatGit(wtDir: string, args: string[], timeout = GIT_CMD_TIMEOUT_MS): Promise<{ stdout: string }> {
  return spawnAsync(
    'git',
    [
      '-C',
      wtDir,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'diff.ignoreSubmodules=all',
      '-c',
      'submodule.recurse=false',
      ...args,
    ],
    { timeout },
  );
}

/** The paths of a worktree's index entries that are gitlinks (submodules). */
async function indexGitlinks(wtDir: string): Promise<Set<string>> {
  const out = await seatGit(wtDir, ['ls-files', '-s', '-z']);
  const links = new Set<string>();
  for (const entry of out.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab > 0 && entry.startsWith('160000 ')) links.add(entry.slice(tab + 1));
  }
  return links;
}

/**
 * Commit everything a seat changed in its worktree to its branch. True when
 * there was something to commit.
 *
 * `git add` looks inside each submodule by running `git status` there, which
 * `diff.ignoreSubmodules` does not stop, so the gitlinks already in the index
 * are kept out of it; and a repository the seat made inside its worktree, which
 * `git add` stages as a new gitlink, is taken out of the index again.
 */
async function commitSeatWork(wtDir: string, agentName: string, round: number): Promise<boolean> {
  const links = await indexGitlinks(wtDir);
  // --ignore-errors: a file git cannot index (a socket, say) does not stop the rest.
  await seatGit(
    wtDir,
    ['add', '-A', '--ignore-errors', '--', '.', ...[...links].map((p) => `:(exclude,literal)${p}`)],
    SEAT_COMMIT_TIMEOUT_MS,
  ).catch(() => undefined);
  const made = [...(await indexGitlinks(wtDir))].filter((p) => !links.has(p));
  if (made.length) await seatGit(wtDir, ['update-index', '--force-remove', '--', ...made]);
  const staged = await seatGit(wtDir, ['diff', '--cached', '--quiet']).then(
    () => false,
    () => true,
  );
  if (!staged) return false;
  await seatGit(
    wtDir,
    ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', `council(${agentName}): round ${round}`],
    SEAT_COMMIT_TIMEOUT_MS,
  );
  return true;
}

/** Best-effort cleanup of already-created worktrees when a batch creation fails */
async function cleanupCreatedWorktrees(
  worktreeMap: Map<string, string>,
  projectDir: string,
  logger?: Logger,
): Promise<void> {
  const log = logger || createConsoleLogger('Council');
  for (const [createdAgent, createdPath] of worktreeMap) {
    await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', createdPath], {
      timeout: GIT_CMD_TIMEOUT_MS,
    }).catch((err) => {
      log.error(`Failed to cleanup worktree for ${createdAgent}:`, (err as Error).message);
    });
  }
}

/** Set up git worktrees — one isolated directory per agent */
async function setupWorktrees(
  projectDir: string,
  agents: AgentPersona[],
  logger?: Logger,
): Promise<Map<string, string>> {
  const log = logger || createConsoleLogger('Council');
  const worktreeMap = new Map<string, string>();

  // Validate agent names before using them in git branch names
  for (const agent of agents) {
    if (!VALID_AGENT_NAME.test(agent.name)) {
      throw new Error(`Invalid agent name '${agent.name}': must match /^[a-zA-Z0-9_-]+$/`);
    }
  }

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Ensure git repo
  const isGit = await spawnAsync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], { timeout: GIT_CMD_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!isGit) {
    await spawnAsync('git', ['-C', projectDir, 'init'], { timeout: GIT_CMD_TIMEOUT_MS });
  }

  // Commits here (and the agents' own, in the worktrees) need an identity. Only
  // a missing one is filled in: `.git/config` belongs to the user and outlives
  // the council, so an identity they configured at any level is left alone.
  for (const [key, value] of [
    ['user.email', 'council@openclaw'],
    ['user.name', 'Council'],
  ]) {
    const configured = await spawnAsync('git', ['-C', projectDir, 'config', '--get', key], {
      timeout: GIT_CMD_TIMEOUT_MS,
    })
      .then((r) => r.stdout.trim().length > 0)
      .catch(() => false);
    if (configured) continue;
    await spawnAsync('git', ['-C', projectDir, 'config', '--local', key, value], {
      timeout: GIT_CMD_TIMEOUT_MS,
    }).catch((err) => {
      log.error(`Failed to set git ${key}:`, err.message);
    });
  }

  // Ensure at least one commit
  const hasCommit = await spawnAsync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { timeout: GIT_CMD_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!hasCommit) {
    await spawnAsync('git', ['-C', projectDir, 'add', '-A'], { timeout: GIT_CMD_TIMEOUT_MS }).catch((err) => {
      log.error('Failed to git add:', err.message);
    });
    await spawnAsync('git', ['-C', projectDir, 'commit', '--allow-empty', '-m', 'council: initial'], {
      timeout: GIT_CMD_TIMEOUT_MS,
    });
  }

  // Create worktree per agent
  for (const agent of agents) {
    const wtDir = path.join(projectDir, '.worktrees', agent.name);
    const branch = `council/${agent.name}`;

    if (fs.existsSync(wtDir)) {
      // A seat of an earlier council wrote this worktree: git runs here as in a seat's (`seatGit`).
      const isValid = await seatGit(wtDir, ['rev-parse', '--git-dir'])
        .then(() => true)
        .catch(() => false);
      if (isValid) {
        // Warn: hard reset discards uncommitted changes from any previous run
        const dirty = await seatGit(wtDir, ['status', '--porcelain'])
          .then((r) => r.stdout.trim().length > 0)
          .catch(() => false);
        if (dirty) {
          log.warn(`Worktree ${wtDir} has uncommitted changes — discarding via hard reset`);
        }
        try {
          await seatGit(wtDir, ['checkout', branch]);
          await seatGit(wtDir, ['reset', '--hard', 'HEAD']);
          worktreeMap.set(agent.name, wtDir);
          continue;
        } catch (err) {
          log.error(`Failed to reuse worktree ${wtDir} for branch ${branch}:`, (err as Error).message);
          // Fall through to re-create the worktree below
        }
      }
      await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtDir], {
        timeout: GIT_CMD_TIMEOUT_MS,
      }).catch((err) => {
        log.error(`Failed to remove worktree ${wtDir}:`, err.message);
      });
    }

    await spawnAsync('git', ['-C', projectDir, 'branch', '-D', branch], { timeout: GIT_CMD_TIMEOUT_MS }).catch(
      (err) => {
        log.error(`Failed to delete branch ${branch}:`, err.message);
      },
    );
    try {
      await spawnAsync('git', ['-C', projectDir, 'worktree', 'add', wtDir, '-b', branch], {
        timeout: WORKTREE_CMD_TIMEOUT_MS,
      });
    } catch (err) {
      await cleanupCreatedWorktrees(worktreeMap, projectDir, log);
      throw new Error(`Failed to create worktree for ${agent.name} at ${wtDir}: ${(err as Error).message}`);
    }

    if (!fs.existsSync(wtDir)) {
      await cleanupCreatedWorktrees(worktreeMap, projectDir, log);
      throw new Error(`Worktree directory not created: ${wtDir}`);
    }
    worktreeMap.set(agent.name, wtDir);
  }

  return worktreeMap;
}

// ─── Prompt Building ────────────────────────────────────────────────────────

/** A reply that says something: not empty, and not only the engine's "[Agent completed …]" stand-in. */
function isSubstantive(content: string): boolean {
  return content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim().length > 0;
}

/**
 * The entries of a round prompt's history block, from the responses so far:
 * each substantive reply, its consensus tag removed, with the seat's vote.
 */
export function councilHistoryEntries(responses: AgentResponse[]): CouncilHistoryEntry[] {
  // Filter out empty responses so they don't pollute the collaboration history
  return responses
    .filter((resp) => isSubstantive(resp.content))
    .map((resp) => ({
      agent: resp.agent,
      round: resp.round,
      report: stripConsensusTags(resp.content),
      consensus: resp.consensus,
    }));
}

/**
 * The history block of a round prompt: each report's tail (the report and the
 * vote are at the end), grouped by round. The envelopes agents are handed forum
 * posts in are fenced, so a seat that quotes another's reply does not post its
 * blocks again.
 */
export function renderCouncilHistory(entries: CouncilHistoryEntry[]): string {
  if (entries.length === 0) return '';
  // Build history with tail-first truncation (preserve reports and votes)
  let history = '\n\n## Previous Collaboration History\n\n';
  let currentRound = 0;
  for (const entry of entries) {
    if (entry.round !== currentRound) {
      currentRound = entry.round;
      history += `### Round ${currentRound}\n\n`;
    }
    const clean = entry.report;
    const preview = clean.length > HISTORY_PREVIEW_CHARS ? '...' + clean.slice(-HISTORY_PREVIEW_CHARS) : clean;
    history += `**${entry.agent}** (${entry.consensus ? 'YES — agree to finish' : 'NO — continue'}):\n${fenceForumText(preview)}\n\n`;
  }
  return history;
}

function buildAgentPrompt(
  agent: AgentPersona,
  task: string,
  round: number,
  history: string,
  allAgents: AgentPersona[],
): string {
  const otherAgents = allAgents.filter((a) => a.name !== agent.name);

  if (round === 1) {
    return `# Round 1 — Planning Round

## Task
${task}

## Your Partners
${otherAgents.map((a) => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## Rules: Planning Only — No Code

This is Round 1, a **pure planning round**. All members work independently in parallel to create plan.md.

**What you must do (in order, complete quickly):**
1. \`git log --oneline -5\` to check current state
2. If the project is empty (only initial commit), **no research needed** — write the plan directly from the task description
3. If the project has existing code, quickly check the file structure in your workspace (one \`ls\` only), then write the plan
4. Create \`plan.md\` (with task checklist, phase breakdown, claim status) and merge into main
5. If another member's plan.md already exists on main, merge your improvements into it

**What you must never do:**
- Do not write any business code
- Do not repeatedly ls / glob / find to explore directories
- Do not read any files outside your workspace
- Do not spend more than 2-3 minutes on this round

## Consensus Vote

At the **end** of your response, you must vote:
- \`[CONSENSUS: NO]\` — normal for Round 1 (execution still needed after planning)
- \`[CONSENSUS: YES]\` — only if the task is extremely simple

Start writing plan.md now!`;
  }

  return `# Round ${round} — Execution Round

## Task
${task}

## Your Partners
${otherAgents.map((a) => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## Your Work

plan.md was created by all members in Round 1. Now execute according to plan:

1. **Check current state** — pull main, read plan.md, understand latest progress
2. **Claim and execute tasks** — pick unclaimed tasks from plan.md, write code, modify files, run tests
3. **Review others' work** — if other members have output, review and suggest improvements or fix directly
4. **Report results** — briefly describe what you did

## Consensus Vote

At the **end** of your response, you must vote (pick one):

- \`[CONSENSUS: YES]\` — task complete, quality meets standards, ready to finish
- \`[CONSENSUS: NO]\` — still work to do or issues to resolve

Collaboration ends **only when all members vote YES**.

Start working!`;
}

/**
 * The package this module belongs to: the nearest directory above it holding a
 * package.json. A fixed `..` is right from `src/` but lands on `dist/` from the
 * built `dist/src/`, which would leave the package root itself unguarded.
 */
export function programRoot(moduleFile: string = fileURLToPath(import.meta.url)): string {
  let dir = path.dirname(moduleFile);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(path.dirname(moduleFile), '..');
    dir = parent;
  }
}

/** Resolve the path to configs/ relative to this module (works from both src/ and dist/) */
function resolveConfigPath(filename: string): string {
  const filePath = fileURLToPath(import.meta.url);
  const dir = path.dirname(filePath);
  const candidates = [path.join(dir, '..', 'configs', filename), path.join(dir, '..', '..', 'configs', filename)];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // fallback — will error on read
}

/**
 * The seat's charter: identity, workspace, collaboration protocol.
 *
 * It reaches every engine through `appendSystemPrompt` — natively on Claude and
 * grok, as the top of the first message on the others. It used to be split, with
 * identity and the workspace boundary written to `<worktree>/.claude/CLAUDE.md`,
 * a file only Claude Code reads and one an agent's `git add -A` could commit into
 * the user's project.
 */
function buildSystemPrompt(
  agent: AgentPersona,
  allAgents: AgentPersona[],
  worktreePath: string,
  projectDir: string,
  forum = false,
  committedForSeat = false,
): string {
  const otherAgents = allAgents.filter((a) => a.name !== agent.name);
  const otherBranches = otherAgents.map((a) => `\`council/${a.name}\``).join(', ');

  const templatePath = resolveConfigPath('council-system-prompt.md');
  const template = fs.readFileSync(templatePath, 'utf-8');

  // Seats on a run forum post their reviews there, where the reviewed seat is
  // told of them; without one, reviews are files in the project.
  const reviewRules = forum
    ? '* **Structured feedback**: Post each review on the team forum (its commands are at the top of your round prompt), answering the round report you reviewed: `WIN: approve @<name> — <what you checked>` or `FAIL @<name>: request changes — <what must change>`. Do not write review files.\n' +
      '* **Review criteria**: Give a clear approve (`WIN`) or request changes (`FAIL`) with specific reasons; an approve counts as `[APPROVE]` below.'
    : '* **Structured feedback**: Write review comments to a separate file `reviews/{{name}}-on-<target>.md` — do not mix them into your own feedback file.\n' +
      '* **Review criteria**: Give a clear `[APPROVE]` or `[REQUEST_CHANGES]` with specific reasons.';

  // A seat whose sandbox keeps git's metadata out of reach (`councilCommitsForSeat`).
  const commits = committedForSeat
    ? "\n\n# Commits\n\nYour sandbox keeps git's metadata read-only, so `git commit` fails for you. Leave your changes in `{{workDir}}`: when your turn ends they are committed to `council/{{name}}` for you, where the other members can merge them."
    : '';

  return (template + commits)
    .replace(/\{\{reviewRules\}\}/g, reviewRules)
    .replace(/\{\{emoji\}\}/g, agent.emoji)
    .replace(/\{\{name\}\}/g, agent.name)
    .replace(/\{\{persona\}\}/g, agent.persona)
    .replace(/\{\{workDir\}\}/g, worktreePath)
    .replace(/\{\{projectDir\}\}/g, projectDir)
    .replace(/\{\{otherBranches\}\}/g, otherBranches);
}

// ─── Council Engine ─────────────────────────────────────────────────────────

export class Council extends EventEmitter {
  private config: CouncilConfig;
  private manager: SessionManagerLike;
  private agentTimeoutMs: number;
  private _aborted = false;

  private _stopped(): boolean {
    return this._aborted || this.config.signal?.aborted === true;
  }
  private _activeSessions = new Set<string>();
  private _session: CouncilSession | null = null;
  /** Messages for every seat's next round prompt, in the order they came. */
  private _pendingInjections: string[] = [];
  /** Worktrees created for the current run — used to clean up on abort/error
   *  (a successful run keeps them on disk for the user to review/accept). */
  private _worktreeMap = new Map<string, string>();
  /** The worktree of each seat whose changes the council commits for it (`councilCommitsForSeat`). */
  private _seatCommits = new Map<string, string>();
  private logger: Logger;

  constructor(config: CouncilConfig, manager: SessionManagerLike, logger?: Logger) {
    super();
    this.config = config;
    this.manager = manager;
    this.agentTimeoutMs = config.agentTimeoutMs || DEFAULT_AGENT_TIMEOUT_MS;
    this.logger = logger || createConsoleLogger('Council');
  }

  /**
   * Adopt a session that was reconstructed from the durable run record.
   *
   * `review` / `accept` / `reject` act on the git state a finished council left
   * behind — branches, worktrees, plan.md — not on live agents, so they work
   * from a rebuilt session. This is what lets them run after a restart, which
   * the in-memory registry made impossible.
   */
  /** Add one send's cost to the council's total. */
  private _charge(result: SendResult): void {
    if (this._session && result.usage) this._session.costUsd = (this._session.costUsd ?? 0) + result.usage.costUsd;
  }

  adoptSession(session: CouncilSession): void {
    this._session = session;
  }

  getSession(): CouncilSession | undefined {
    return this._session ?? undefined;
  }

  /** Add a message to every seat's next round prompt. Messages are kept in order; none replaces another. */
  injectMessage(message: string): void {
    this._pendingInjections.push(message);
  }

  abort(): void {
    this._aborted = true;
    for (const name of this._activeSessions) {
      this.manager.stopSession(name).catch(() => {});
    }
    this._activeSessions.clear();
    // Discard the run's worktrees — an aborted run has nothing to review.
    // Best-effort here: abort() is synchronous, and run() cleans up again on
    // its way out for the case where this fired before setup had finished.
    void this._discardWorktrees();
  }

  /**
   * Remove the worktrees this run created, once. Clearing the map before the
   * await is what makes a second caller a no-op rather than a double remove.
   */
  private async _discardWorktrees(): Promise<void> {
    if (this._worktreeMap.size === 0) return;
    const map = new Map(this._worktreeMap);
    this._worktreeMap.clear();
    await cleanupCreatedWorktrees(map, this.config.projectDir, this.logger).catch(() => {});
  }

  private emitEvent(event: Omit<CouncilEvent, 'timestamp'>) {
    const full: CouncilEvent = { ...event, timestamp: new Date().toISOString() };
    this.emit('council-event', full);
  }

  /** The history entries the config's hook gives for this round; undefined without one, or when it fails. */
  private _historyEntries(round: number, responses: AgentResponse[]): CouncilHistoryEntry[] | undefined {
    if (!this.config.history) return undefined;
    try {
      return this.config.history(round, responses);
    } catch (err) {
      this.logger.warn?.(`[council] round ${round}: history from the forum failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** The messages the config's hook has for one seat this round. */
  private _takeInjections(round: number, agent: string): string[] {
    if (!this.config.takeInjections) return [];
    try {
      return this.config.takeInjections(round, agent).filter((m) => m.trim().length > 0);
    } catch (err) {
      this.logger.warn?.(
        `[council] ${agent} round ${round}: the user's messages were not read: ${(err as Error).message}`,
      );
      return [];
    }
  }

  // ─── Single Agent Execution ───────────────────────────────────────────

  private async runSingleAgent(
    agent: AgentPersona,
    prompt: string,
    systemPrompt: string,
    workDir: string,
    round: number,
    sessionId: string,
  ): Promise<AgentResponse> {
    this.emitEvent({ type: 'agent-start', sessionId, round, agent: agent.name });

    // Full run id — truncating to 8 chars made every manager id share `council-`.
    const sessionName = `${sessionId}-${agent.name}-r${round}`;
    this._activeSessions.add(sessionName);

    let content = '';
    // The message the seat is sent: its round prompt, after the preface (its forum brief).
    let message: string | undefined;
    let leave: (() => void) | undefined;
    const relay = (text: string): void => {
      try {
        this.config.onAgentText?.(agent.name, text, round);
      } catch (err) {
        this.logger.warn?.(`[council] ${agent.name} round ${round}: ${(err as Error).message}`);
      }
    };
    try {
      for (let attempt = 0; attempt <= EMPTY_RESPONSE_MAX_RETRIES; attempt++) {
        if (this._stopped()) throw new Error('Council aborted');
        if (attempt > 0) {
          this.emitEvent({
            type: 'agent-chunk',
            sessionId,
            round,
            agent: agent.name,
            content: `\n[Empty response, retry ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES}]\n`,
          });
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
        }

        // Start a session for this agent
        const engine: EngineType = agent.engine || defaultEngine();
        await this.manager.startSession({
          name: sessionName,
          cwd: workDir,
          engine,
          model: agent.model,
          baseUrl: agent.baseUrl,
          permissionMode: agent.permissionMode ?? this.config.defaultPermissionMode ?? 'bypassPermissions',
          ...(agent.sandboxMode === undefined ? {} : { sandboxMode: agent.sandboxMode }),
          appendSystemPrompt: systemPrompt,
          maxTurns: this.config.maxTurnsPerAgent || DEFAULT_MAX_TURNS_PER_AGENT,
          maxBudgetUsd: this.config.maxBudgetUsd,
          customEngine: agent.customEngine,
          ...(agent.acpAgent === undefined ? {} : { acpAgent: agent.acpAgent }),
          effort: agent.effort,
          ultracode: agent.ultracode,
          // The run's own session: its messages go through the run's forum.
          ...(this.config.runId ? { ownerRunId: this.config.runId } : {}),
        });

        if (message === undefined) {
          // On the forum for the length of its round; the brief is read once it is on.
          leave = this.config.onAgentSession?.(agent.name, sessionName, round, workDir);
          const preface = this.config.agentPreface?.(agent.name, round);
          message = preface ? `${preface}\n\n---\n\n${prompt}` : prompt;
        }

        // Send the prompt and wait for completion
        let streamed = '';
        const result = await this.manager.sendMessage(sessionName, message, {
          timeout: this.agentTimeoutMs,
          parentRunId: sessionId,
          onChunk: (chunk: string) => {
            this.emitEvent({ type: 'agent-chunk', sessionId, round, agent: agent.name, content: chunk });
            streamed += chunk;
            relay(streamed);
          },
        });
        this._charge(result);
        if (result.output) relay(result.output);

        content = result.output;

        // Check if response is substantive
        const stripped = content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
        if (stripped.length > 0 || hasConsensusMarker(content)) break;

        if (attempt === EMPTY_RESPONSE_MAX_RETRIES) {
          this.logger.info(`${agent.name}: empty after ${EMPTY_RESPONSE_MAX_RETRIES} retries`);
        }
      }

      // Follow-up if response is too short and has no consensus marker
      const strippedContent = content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
      if (!this._stopped() && strippedContent.length < MIN_COMPLETE_RESPONSE_LENGTH && !hasConsensusMarker(content)) {
        for (let i = 0; i < FOLLOWUP_MAX_RETRIES; i++) {
          if (this._stopped()) break;
          try {
            const followup = await this.manager.sendMessage(
              sessionName,
              'Stop all tool calls. Output your complete report now, including your consensus vote [CONSENSUS: YES] or [CONSENSUS: NO].',
              { timeout: FOLLOWUP_TIMEOUT_MS, parentRunId: sessionId },
            );
            this._charge(followup);
            if (followup.output) relay(followup.output);
            if (followup.output.trim().length > 0) {
              content = followup.output;
              if (hasConsensusMarker(content) || content.length >= MIN_COMPLETE_RESPONSE_LENGTH) break;
            }
          } catch {
            break;
          }
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
        }
      }
    } finally {
      try {
        leave?.();
      } catch {
        // Leaving the forum is bookkeeping; the round's result stands.
      }
      // Stop session — fire-and-forget
      this.manager.stopSession(sessionName).catch(() => {});
      this._activeSessions.delete(sessionName);
      const wt = this._seatCommits.get(agent.name);
      if (wt && !this._stopped()) {
        await commitSeatWork(wt, agent.name, round).catch((err: Error) =>
          this.logger.warn?.(`[council] ${agent.name} round ${round}: its changes were not committed: ${err.message}`),
        );
      }
    }

    const { vote: consensus, source: consensusSource } = parseConsensusWithSource(content);
    if (consensusSource !== 'strict') {
      // Loose-variant or absent vote — surface it so degraded consensus
      // detection is visible (e.g. an agent that forgot the [CONSENSUS: …] tag).
      this.logger.warn?.(
        `[council] ${agent.name} round ${round}: consensus from '${consensusSource}' (not the strict [CONSENSUS: YES/NO] tag) → ${consensus ? 'YES' : 'NO'}`,
      );
    }
    const response: AgentResponse = {
      agent: agent.name,
      round,
      content,
      consensus,
      sessionKey: sessionName,
      timestamp: new Date().toISOString(),
    };

    this.emitEvent({ type: 'agent-complete', sessionId, round, agent: agent.name, content, consensus });
    return response;
  }

  // ─── Initialisation (synchronous — returns handle immediately) ──────

  init(task: string): CouncilSession {
    if (!task || task.trim().length < MIN_TASK_LENGTH) {
      throw new Error(`Task description too short (min ${MIN_TASK_LENGTH} chars)`);
    }

    const session: CouncilSession = {
      id: this.config.runId ?? randomUUID(),
      task: task.trim(),
      config: this.config,
      // A resumed council keeps the rounds it already ran.
      responses: [...(this.config.previousResponses ?? [])],
      status: 'running',
      startTime: new Date().toISOString(),
    };
    this._session = session;
    return session;
  }

  // ─── Main Orchestration Loop ──────────────────────────────────────────

  async run(task?: string): Promise<CouncilSession> {
    // Allow run(task) as shorthand for init(task) + run()
    if (task && !this._session) this.init(task);
    const session = this._session;
    if (!session) throw new Error('Council not initialised — call init() first');
    const trimmedTask = session.task;

    // Safety check: prevent council from running inside the program's own directory
    const moduleRoot = programRoot();
    const resolvedProjectDir = path.resolve(this.config.projectDir);
    const rel = path.relative(moduleRoot, resolvedProjectDir);
    const isInside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (isInside) {
      throw new Error(
        `SAFETY: projectDir (${resolvedProjectDir}) is inside program root (${moduleRoot}). Refusing to start council.`,
      );
    }

    if (this.config.agents.length === 0) {
      throw new Error('Council requires at least one agent');
    }
    this.logger.info(`Starting: ${this.config.agents.length} agents, max ${this.config.maxRounds} rounds`);
    this.logger.info(`Task: ${trimmedTask}`);
    this.logger.info(`Dir: ${this.config.projectDir}`);
    this.logger.warn('Agents run with permissionMode=bypassPermissions for autonomous execution');
    this.emitEvent({ type: 'session-start', sessionId: session.id, task: trimmedTask });

    // Set up git worktrees
    let worktreeMap: Map<string, string>;
    try {
      worktreeMap = await setupWorktrees(this.config.projectDir, this.config.agents, this.logger);
    } catch (err) {
      session.status = 'error';
      session.endTime = new Date().toISOString();
      throw err;
    }

    this._worktreeMap = worktreeMap;
    this.logger.info('Worktrees:');
    for (const [name, wtPath] of worktreeMap) {
      this.logger.info(`  ${name}: ${wtPath}`);
    }
    this._seatCommits.clear();
    for (const agent of this.config.agents) {
      const wtPath = worktreeMap.get(agent.name);
      if (wtPath && councilCommitsForSeat(agent.engine || defaultEngine(), agent.sandboxMode)) {
        this._seatCommits.set(agent.name, wtPath);
      }
    }

    // A resumed council carries on after the last round it finished; one whose
    // last round was all YES has nothing left to run.
    const ranRounds = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    if (ranRounds > 0) {
      const last = session.responses.filter((r) => r.round === ranRounds);
      const agreed = last.length === this.config.agents.length && last.every((r) => r.consensus);
      this.logger.info(`Resuming after round ${ranRounds}${agreed ? ' (consensus already reached)' : ''}`);
      if (agreed) session.status = 'awaiting_user';
    }

    try {
      for (let round = ranRounds + 1; round <= this.config.maxRounds; round++) {
        if (this._stopped() || session.status !== 'running') break;

        this.logger.info(`Round ${round} (${this.config.agents.length} agents parallel)`);
        this.emitEvent({ type: 'round-start', sessionId: session.id, round });

        // The user's messages since the last round: the ones injected here, and
        // the ones the run hands this seat (its forum's user posts and steers).
        const injected = this._pendingInjections.splice(0);
        const history = renderCouncilHistory(
          this._historyEntries(round, session.responses) ?? councilHistoryEntries(session.responses),
        );

        // Build prompts for all agents
        const agentTasks = this.config.agents.map((agent) => {
          const workDir = worktreeMap.get(agent.name) || this.config.projectDir;
          let prompt = buildAgentPrompt(agent, trimmedTask, round, history, this.config.agents);
          const injection = [...injected, ...this._takeInjections(round, agent.name)].join('\n\n');
          if (injection) {
            prompt += `\n\n## User Injection\n\n${injection}`;
          }
          const systemPrompt = buildSystemPrompt(
            agent,
            this.config.agents,
            workDir,
            this.config.projectDir,
            this.config.forum === true,
            this._seatCommits.has(agent.name),
          );
          return { agent, prompt, systemPrompt, workDir };
        });

        // Execute the agents in parallel, no more at once than there are session slots.
        const results = await mapBounded(
          agentTasks,
          this.manager.freeSessionSlots?.() ?? agentTasks.length,
          ({ agent, prompt, systemPrompt, workDir }): Promise<PromiseSettledResult<AgentResponse>> =>
            this.runSingleAgent(agent, prompt, systemPrompt, workDir, round, session.id).then(
              (value) => ({ status: 'fulfilled', value }),
              (reason: unknown) => ({ status: 'rejected', reason }),
            ),
        );

        // Collect results
        const roundVotes: boolean[] = [];
        const roundResults: CouncilRoundResult[] = [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const agent = this.config.agents[i];
          if (result.status === 'fulfilled') {
            roundVotes.push(result.value.consensus);
            session.responses.push(result.value);
            roundResults.push({ agent: agent.name, response: result.value });
          } else {
            const errMsg = (result.reason as Error)?.message || 'Unknown error';
            this.logger.error(`${agent.name} failed: ${errMsg}`);
            this.emitEvent({ type: 'error', sessionId: session.id, round, agent: agent.name, error: errMsg });
            roundVotes.push(false);
            session.responses.push({
              agent: agent.name,
              round,
              content: `Error: ${errMsg}`,
              consensus: false,
              sessionKey: '',
              timestamp: new Date().toISOString(),
            });
            roundResults.push({ agent: agent.name, error: errMsg });
          }
        }

        // The round's reports go out (on the run forum, for a kernel run). The
        // votes are counted from the replies above, never from what was posted.
        if (this.config.onRoundEnd) {
          try {
            await this.config.onRoundEnd(round, roundResults);
          } catch (err) {
            this.logger.warn?.(
              `[council] round ${round}: the round reports were not posted: ${(err as Error).message}`,
            );
          }
        }

        const allYes = roundVotes.length === this.config.agents.length && roundVotes.every((v) => v);
        this.emitEvent({ type: 'round-end', sessionId: session.id, round, status: allYes ? 'consensus' : 'continue' });

        if (allYes) {
          this.logger.info(`Consensus reached at round ${round}`);
          session.status = 'awaiting_user';
          break;
        } else {
          const yesCount = roundVotes.filter((v) => v).length;
          this.logger.info(`Votes: ${yesCount}/${this.config.agents.length} YES`);
        }

        if (round < this.config.maxRounds) {
          await sleep(INTER_ROUND_DELAY_MS);
        }
      }

      if (this._stopped()) {
        session.status = 'error';
      }
      // Worktrees go only on an explicit abort. A kernel timeout stops this attempt
      // through the signal while a retry of the same node may already be running
      // in the same `.worktrees/<agent>` paths, so discarding them here would pull
      // the tree out from under it.
      if (this._aborted) {
        // An abort that lands while setupWorktrees is still running finds an
        // empty `_worktreeMap` — it is not assigned until setup returns — so
        // abort() skips its own cleanup, setup then completes and creates every
        // worktree, and this loop breaks on the next line without throwing.
        // The catch below is the only other place cleanup runs, and a normal
        // return never reaches it. Cleaning here covers both that race and the
        // ordinary break-on-abort; if abort() already cleaned up, the map is
        // empty and this is a no-op.
        await this._discardWorktrees();
      } else if (session.status === 'running') {
        session.status = 'max_rounds';
        this.logger.info(`Max rounds (${this.config.maxRounds}) reached`);
      }

      session.endTime = new Date().toISOString();
      session.compactContext = this.generateCompactContext(session);
      session.finalSummary = this.generateSummary(session);
      this.saveTranscript(session);

      this.emitEvent({ type: 'complete', sessionId: session.id, status: session.status });
      return session;
    } catch (err) {
      session.status = 'error';
      session.endTime = new Date().toISOString();
      this.emitEvent({ type: 'error', sessionId: session.id, error: (err as Error).message });
      // The run failed — there is nothing to review, so don't orphan the
      // worktrees on disk. (Successful runs keep them for the accept flow.)
      await this._discardWorktrees();
      throw err;
    }
  }

  // ─── Summary & Transcript ─────────────────────────────────────────────

  private generateSummary(session: CouncilSession): string {
    const maxRound = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    const statusText =
      session.status === 'awaiting_user' || session.status === 'consensus' ? 'Consensus reached' : 'Max rounds reached';
    const lines = [
      `# Council Summary\n`,
      `- **Task**: ${session.task}`,
      `- **Status**: ${statusText}`,
      `- **Rounds**: ${maxRound}`,
      `- **Directory**: ${session.config.projectDir}\n`,
      `## Final Agent Status\n`,
    ];
    const lastResponses = session.responses.filter((r) => r.round === maxRound);
    for (const resp of lastResponses) {
      const agent = session.config.agents.find((a) => a.name === resp.agent);
      const emoji = agent?.emoji || '';
      const clean = stripConsensusTags(resp.content);
      const preview = clean.slice(0, SUMMARY_SHORT_CHARS) + (clean.length > SUMMARY_SHORT_CHARS ? '...' : '');
      lines.push(`### ${emoji} ${resp.agent}`);
      lines.push(`- Vote: ${resp.consensus ? 'YES' : 'NO'}`);
      lines.push(`- Summary:\n${preview}\n`);
    }
    return lines.join('\n');
  }

  private generateCompactContext(session: CouncilSession): string {
    const maxRound = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    const recent = session.responses.filter((r) => r.round >= maxRound - 1);
    const summaries = recent.map((resp) => {
      const clean = stripConsensusTags(resp.content).replace(/\s+/g, ' ').slice(0, COMPACT_CONTEXT_CHARS);
      return `- [R${resp.round}] ${resp.agent}: ${clean}${clean.length >= COMPACT_CONTEXT_CHARS ? '...' : ''}`;
    });
    return [
      `Task: ${session.task}`,
      `Progress: round ${maxRound} / max ${session.config.maxRounds}`,
      `Status: ${session.status}`,
      'Latest:',
      ...summaries,
    ].join('\n');
  }

  private saveTranscript(session: CouncilSession): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logDir = path.join(process.env.HOME || '/tmp', '.openclaw', 'council-logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const filepath = path.join(logDir, `council-${ts}.md`);

    let content = `# Council Transcript\n\n`;
    content += `- **ID**: ${session.id}\n`;
    content += `- **Time**: ${session.startTime}\n`;
    content += `- **Task**: ${session.task}\n`;
    content += `- **Status**: ${session.status}\n\n---\n\n`;

    let currentRound = 0;
    for (const resp of session.responses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        content += `## Round ${currentRound}\n\n`;
      }
      const agent = session.config.agents.find((a) => a.name === resp.agent);
      content += `### ${agent?.emoji || ''} ${resp.agent}\n\n${resp.content}\n\n`;
    }

    content += `---\n\n${session.finalSummary || ''}`;
    fs.writeFileSync(filepath, content);
    this.logger.info(`Transcript saved: ${filepath}`);
  }

  // ─── Post-Processing: Review / Accept / Reject ──────────────────────────

  /**
   * Produce a structured review of the council's output.
   * Lists all changed files, branches, worktrees, plan.md status, and agent summaries.
   * Does NOT modify any state — purely informational.
   */
  async review(): Promise<CouncilReviewResult> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised');
    const dir = session.config.projectDir;

    // Gather branches
    const branches = await spawnAsync('git', ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
      timeout: GIT_CMD_TIMEOUT_MS,
    })
      .then((r) =>
        r.stdout
          .trim()
          .split('\n')
          .filter((b) => b.startsWith('council/')),
      )
      .catch(() => [] as string[]);

    // Gather worktrees
    const councilWorktrees = await councilWorktreePaths(dir);

    // Check plan.md
    const planPath = path.join(dir, 'plan.md');
    const planExists = fs.existsSync(planPath);
    const planContent = planExists ? fs.readFileSync(planPath, 'utf-8') : undefined;

    // Check reviews/
    const reviewsDir = path.join(dir, 'reviews');
    const reviews = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).filter((f) => f.endsWith('.md')) : [];

    // What the council changed, measured against where its branches forked.
    //
    // This used to diff `HEAD~20..HEAD` with a `HEAD~10` fallback: a magic
    // window with no relationship to when the council started, which returned
    // nothing at all on a shallow or young history. The merge-base is the actual
    // fork point, and `changedFilesSince` also sees files the agents created,
    // which a plain tracked-file diff cannot.
    let changedFiles: CouncilChangedFile[] = [];
    try {
      const base = await this._reviewBaseline(dir, branches);
      changedFiles = (await changedFilesSince(dir, base)).map((f) => ({
        file: f.path,
        // `status` is a reviewer's judgement and stays undefined until one is made.
        change: f.status === 'untracked' ? 'added' : (f.status as CouncilFileChange),
        insertions: f.insertions,
        deletions: f.deletions,
      }));
    } catch {
      // Not a repo, or git refused — skip the file listing rather than guess.
    }

    // Agent summaries from final round
    const maxRound = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    const lastResponses = session.responses.filter((r) => r.round === maxRound);
    const agentSummaries = lastResponses.map((resp) => {
      const clean = stripConsensusTags(resp.content);
      return {
        agent: resp.agent,
        consensus: resp.consensus,
        preview: clean.slice(0, SUMMARY_PREVIEW_CHARS) + (clean.length > SUMMARY_PREVIEW_CHARS ? '...' : ''),
      };
    });

    // Load reviewer guidance from config
    let reviewerGuidance = '';
    try {
      const guidancePath = resolveConfigPath('council-reviewer-prompt.md');
      reviewerGuidance = fs.readFileSync(guidancePath, 'utf-8');
    } catch {
      reviewerGuidance = 'Reviewer guidance not found. Evaluate the council output independently.';
    }

    return {
      councilId: session.id,
      projectDir: dir,
      status: session.status as 'consensus' | 'max_rounds' | 'error',
      rounds: maxRound,
      planExists,
      planContent,
      changedFiles,
      branches,
      worktrees: councilWorktrees,
      reviews,
      agentSummaries,
      reviewerGuidance,
    };
  }

  /**
   * Internal cleanup helper — removes worktrees, branches, plan.md, and reviews/.
   * Each cleanup step is independently gated by the `options` flags.
   */
  /**
   * Where the council's work started: the merge-base between the current HEAD and
   * the first council branch. Falls back to HEAD (working-tree changes only) when
   * there are no council branches to fork from.
   */
  private async _reviewBaseline(dir: string, branches: string[]): Promise<string> {
    const branch = branches.find((b) => b.startsWith('council/'));
    if (branch) {
      const mergeBase = await spawnAsync('git', ['-C', dir, 'merge-base', 'HEAD', branch], {
        timeout: GIT_CMD_TIMEOUT_MS,
      }).catch(() => ({ stdout: '', stderr: '' }));
      const sha = mergeBase.stdout.trim();
      if (sha) return sha;
    }
    return 'HEAD';
  }

  private async _cleanup(
    projectDir: string,
    options: {
      removeWorktrees?: boolean;
      deleteBranches?: boolean;
      removePlan?: boolean;
      removeReviews?: boolean;
    },
  ): Promise<{
    worktreesRemoved: string[];
    branchesDeleted: string[];
    planDeleted: boolean;
    reviewsDeleted: boolean;
  }> {
    const result = {
      worktreesRemoved: [] as string[],
      branchesDeleted: [] as string[],
      planDeleted: false,
      reviewsDeleted: false,
    };

    // Remove council worktrees
    if (options.removeWorktrees) {
      for (const wtPath of await councilWorktreePaths(projectDir)) {
        const removed = await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtPath], {
          timeout: WORKTREE_CMD_TIMEOUT_MS,
        })
          .then(() => true)
          .catch((err) => {
            this.logger.error(`Failed to remove worktree ${wtPath}:`, err.message);
            return false;
          });
        // Only what was actually removed: the old code pushed unconditionally,
        // so a failed remove still reported the path as cleaned up.
        if (removed) result.worktreesRemoved.push(wtPath);
      }
      // Also remove .worktrees directory if it exists
      const dotWorktrees = path.join(projectDir, '.worktrees');
      if (fs.existsSync(dotWorktrees)) {
        // Remove any remaining worktree dirs via git first
        for (const entry of fs.readdirSync(dotWorktrees)) {
          const wtPath = path.join(dotWorktrees, entry);
          if (fs.statSync(wtPath).isDirectory()) {
            await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtPath], {
              timeout: WORKTREE_CMD_TIMEOUT_MS,
            }).catch(() => {});
            if (!result.worktreesRemoved.includes(wtPath)) result.worktreesRemoved.push(wtPath);
          }
        }
        // Clean up the directory itself if empty
        try {
          fs.rmSync(dotWorktrees, { recursive: true, force: true });
        } catch {
          // May fail if not empty; that's ok
        }
      }
      await spawnAsync('git', ['-C', projectDir, 'worktree', 'prune'], { timeout: GIT_CMD_TIMEOUT_MS }).catch(() => {});
    }

    // Delete council branches
    if (options.deleteBranches) {
      const branchResult = await spawnAsync(
        'git',
        ['-C', projectDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
        { timeout: GIT_CMD_TIMEOUT_MS },
      ).catch(() => ({ stdout: '', stderr: '' }));
      for (const branch of branchResult.stdout.trim().split('\n')) {
        if (branch.startsWith('council/')) {
          await spawnAsync('git', ['-C', projectDir, 'branch', '-D', branch], {
            timeout: GIT_CMD_TIMEOUT_MS,
          }).catch((err) => this.logger.error(`Failed to delete branch ${branch}:`, err.message));
          result.branchesDeleted.push(branch);
        }
      }
    }

    // Remove plan.md
    if (options.removePlan) {
      const planPath = path.join(projectDir, 'plan.md');
      result.planDeleted = fs.existsSync(planPath);
      if (result.planDeleted) fs.unlinkSync(planPath);
    }

    // Remove reviews/
    if (options.removeReviews) {
      const reviewsDir = path.join(projectDir, 'reviews');
      result.reviewsDeleted = fs.existsSync(reviewsDir);
      if (result.reviewsDeleted) fs.rmSync(reviewsDir, { recursive: true, force: true });
    }

    return result;
  }

  /**
   * Accept the council's work: clean up worktrees, branches, plan.md, and reviews/.
   * Should only be called after reviewing via `review()`.
   */
  async accept(): Promise<CouncilAcceptResult> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised');
    const dir = session.config.projectDir;

    // Ensure we're on main
    await spawnAsync('git', ['-C', dir, 'checkout', 'main'], { timeout: GIT_CMD_TIMEOUT_MS }).catch(() =>
      spawnAsync('git', ['-C', dir, 'checkout', 'master'], { timeout: GIT_CMD_TIMEOUT_MS }).catch(() => {}),
    );

    const { worktreesRemoved, branchesDeleted, planDeleted, reviewsDeleted } = await this._cleanup(dir, {
      removeWorktrees: true,
      deleteBranches: true,
      removePlan: true,
      removeReviews: true,
    });

    // Update session status
    session.status = 'accepted';

    this.logger.info(`Accepted: ${branchesDeleted.length} branches, ${worktreesRemoved.length} worktrees cleaned up`);

    return { councilId: session.id, branchesDeleted, worktreesRemoved, planDeleted, reviewsDeleted };
  }

  /**
   * Reject the council's work: rewrite plan.md with feedback.
   * Does NOT delete any worktrees or branches — the council can retry.
   */
  async reject(feedback: string): Promise<CouncilRejectResult> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised');
    const dir = session.config.projectDir;

    const planPath = path.join(dir, 'plan.md');

    // Build rejection plan
    const rejectionPlan = `# Project Plan (REJECTED & RESTARTED)

## Reviewer Feedback
${feedback}

## Previous Status
- **Council ID**: ${session.id}
- **Rounds completed**: ${session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0}
- **Final status**: ${session.status}

## Tasks for Council
_Replace the tasks below with specific actionable items based on the feedback above._

- [ ] Address reviewer feedback
- [ ] Verify all changes compile and pass tests
- [ ] Update plan.md with accurate completion status
`;

    fs.writeFileSync(planPath, rejectionPlan);

    // Commit the rejection plan
    await spawnAsync('git', ['-C', dir, 'add', 'plan.md'], { timeout: GIT_CMD_TIMEOUT_MS }).catch(() => {});
    await spawnAsync('git', ['-C', dir, 'commit', '-m', 'council(reject): rewrite plan.md with reviewer feedback'], {
      timeout: GIT_CMD_TIMEOUT_MS,
    }).catch(() => {});

    // Update session status
    session.status = 'rejected';

    this.logger.info('Rejected: plan.md rewritten with feedback');

    return { councilId: session.id, planRewritten: true, feedback };
  }
}

// ─── Default Config ─────────────────────────────────────────────────────────

export function getDefaultCouncilConfig(projectDir: string): CouncilConfig {
  return {
    name: 'Three Minds Council',
    agents: [
      {
        name: 'Planner',
        emoji: '🔵',
        persona:
          'You are a technical planner. You decompose requirements into actionable plans, define product context and constraints, outline high-level architecture decisions, and deliberately avoid premature implementation details. Your goal is a clear, phased blueprint that other agents can execute against.',
        role: 'gemini',
      },
      {
        name: 'Generator',
        emoji: '🟠',
        persona:
          'You are an implementation engineer. You execute strictly according to plan.md, delivering working code sprint by sprint. You prioritize correctness, shipping velocity, and minimal deviation from the plan. When the plan is ambiguous, you fill gaps conservatively without reinventing requirements.',
        role: 'claude',
      },
      {
        name: 'Evaluator',
        emoji: '🟢',
        persona:
          'You are an independent quality gate. You do not trust that the implementation is correct — you verify it. You validate from real user paths, hunt for broken UX, edge cases, regressions, and inconsistencies. You must give an explicit blocking issue list or a reasoned approval. You are not a polite reviewer; you are the acceptance authority.',
        role: 'gpt',
      },
    ],
    maxRounds: DEFAULT_MAX_ROUNDS,
    projectDir,
  };
}
