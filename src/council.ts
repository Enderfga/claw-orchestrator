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

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
  type CouncilReviewResult,
  type CouncilAcceptResult,
  type CouncilRejectResult,
  type CouncilChangedFile,
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
  GIT_LOG_DEPTH,
  DEFAULT_MAX_ROUNDS,
} from './constants.js';
import { type Logger, createConsoleLogger } from './logger.js';

// Forward-declare SessionManager to avoid circular imports at the type level.
// The actual instance is injected via constructor.
interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Git Utilities ──────────────────────────────────────────────────────────

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
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

  // Git user config
  await spawnAsync('git', ['-C', projectDir, 'config', '--local', 'user.email', 'council@openclaw'], {
    timeout: GIT_CMD_TIMEOUT_MS,
  }).catch((err) => {
    log.error('Failed to set git user.email:', err.message);
  });
  await spawnAsync('git', ['-C', projectDir, 'config', '--local', 'user.name', 'Council'], {
    timeout: GIT_CMD_TIMEOUT_MS,
  }).catch((err) => {
    log.error('Failed to set git user.name:', err.message);
  });

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
      const isValid = await spawnAsync('git', ['-C', wtDir, 'rev-parse', '--git-dir'], { timeout: GIT_CMD_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      if (isValid) {
        // Warn: hard reset discards uncommitted changes from any previous run
        const dirty = await spawnAsync('git', ['-C', wtDir, 'status', '--porcelain'], { timeout: GIT_CMD_TIMEOUT_MS })
          .then((r) => r.stdout.trim().length > 0)
          .catch(() => false);
        if (dirty) {
          log.warn(`Worktree ${wtDir} has uncommitted changes — discarding via hard reset`);
        }
        try {
          await spawnAsync('git', ['-C', wtDir, 'checkout', branch], { timeout: GIT_CMD_TIMEOUT_MS });
          await spawnAsync('git', ['-C', wtDir, 'reset', '--hard', 'HEAD'], { timeout: GIT_CMD_TIMEOUT_MS });
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

  // Write CLAUDE.md constraints in each worktree
  for (const agent of agents) {
    const wtDir = worktreeMap.get(agent.name);
    if (wtDir) writeWorktreeClaudeMd(wtDir, agent.name, agent.emoji, projectDir);
  }

  return worktreeMap;
}

function writeWorktreeClaudeMd(wtDir: string, agentName: string, emoji: string, projectDir: string) {
  const claudeDir = path.join(wtDir, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const content = `# ${emoji} ${agentName}

> This file is auto-generated by the system and takes priority over all conversation context.

## Identity

You are **${emoji} ${agentName}**.
Your working branch: \`council/${agentName}\`
Your working directory: \`${wtDir}\`

Only tasks marked \`[Claimed: council/${agentName}]\` in plan.md belong to you.

## Workspace Boundary

Only operate within \`${wtDir}\` and \`${projectDir}\`.
Never access: \`~/\`, \`/Users/\`, \`~/.openclaw/\`, or any path outside your workspace.

## Efficiency Rules

- Complete Round 1 within 2-3 minutes — planning only
- Empty projects: write the plan directly, no exploration needed
- One \`ls\` is enough — never scan repeatedly
`;
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), content);
}

// ─── Prompt Building ────────────────────────────────────────────────────────

function buildAgentPrompt(
  agent: AgentPersona,
  task: string,
  round: number,
  previousResponses: AgentResponse[],
  allAgents: AgentPersona[],
): string {
  const otherAgents = allAgents.filter((a) => a.name !== agent.name);

  // Build history with tail-first truncation (preserve reports and votes)
  let history = '';
  // Filter out empty responses so they don't pollute the collaboration history
  const substantiveResponses = previousResponses.filter((resp) => {
    const stripped = resp.content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
    return stripped.length > 0;
  });

  if (substantiveResponses.length > 0) {
    history = '\n\n## Previous Collaboration History\n\n';
    let currentRound = 0;
    for (const resp of substantiveResponses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        history += `### Round ${currentRound}\n\n`;
      }
      const clean = stripConsensusTags(resp.content);
      const preview = clean.length > HISTORY_PREVIEW_CHARS ? '...' + clean.slice(-HISTORY_PREVIEW_CHARS) : clean;
      history += `**${resp.agent}** (${resp.consensus ? 'YES — agree to finish' : 'NO — continue'}):\n${preview}\n\n`;
    }
  }

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

function buildSystemPrompt(agent: AgentPersona, allAgents: AgentPersona[], worktreePath: string): string {
  const otherAgents = allAgents.filter((a) => a.name !== agent.name);
  const otherBranches = otherAgents.map((a) => `\`council/${a.name}\``).join(', ');

  const templatePath = resolveConfigPath('council-system-prompt.md');
  const template = fs.readFileSync(templatePath, 'utf-8');

  return template
    .replace(/\{\{emoji\}\}/g, agent.emoji)
    .replace(/\{\{name\}\}/g, agent.name)
    .replace(/\{\{persona\}\}/g, agent.persona)
    .replace(/\{\{workDir\}\}/g, worktreePath)
    .replace(/\{\{otherBranches\}\}/g, otherBranches);
}

// ─── Council Engine ─────────────────────────────────────────────────────────

export class Council extends EventEmitter {
  private config: CouncilConfig;
  private manager: SessionManagerLike;
  private agentTimeoutMs: number;
  private _aborted = false;
  private _activeSessions = new Set<string>();
  private _session: CouncilSession | null = null;
  private _pendingInjection: string | null = null;
  private logger: Logger;

  constructor(config: CouncilConfig, manager: SessionManagerLike, logger?: Logger) {
    super();
    this.config = config;
    this.manager = manager;
    this.agentTimeoutMs = config.agentTimeoutMs || DEFAULT_AGENT_TIMEOUT_MS;
    this.logger = logger || createConsoleLogger('Council');
  }

  getSession(): CouncilSession | undefined {
    return this._session ?? undefined;
  }

  injectMessage(message: string): void {
    this._pendingInjection = message;
  }

  abort(): void {
    this._aborted = true;
    for (const name of this._activeSessions) {
      this.manager.stopSession(name).catch(() => {});
    }
    this._activeSessions.clear();
  }

  private emitEvent(event: Omit<CouncilEvent, 'timestamp'>) {
    const full: CouncilEvent = { ...event, timestamp: new Date().toISOString() };
    this.emit('council-event', full);
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

    const sessionName = `council-${sessionId.slice(0, 8)}-${agent.name}-r${round}`;
    this._activeSessions.add(sessionName);

    let content = '';
    try {
      for (let attempt = 0; attempt <= EMPTY_RESPONSE_MAX_RETRIES; attempt++) {
        if (this._aborted) throw new Error('Council aborted');
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
        const engine: EngineType = agent.engine || 'claude';
        await this.manager.startSession({
          name: sessionName,
          cwd: workDir,
          engine,
          model: agent.model,
          baseUrl: agent.baseUrl,
          permissionMode: agent.permissionMode ?? this.config.defaultPermissionMode ?? 'bypassPermissions',
          appendSystemPrompt: systemPrompt,
          maxTurns: this.config.maxTurnsPerAgent || DEFAULT_MAX_TURNS_PER_AGENT,
          maxBudgetUsd: this.config.maxBudgetUsd,
          customEngine: agent.customEngine,
          effort: agent.effort,
          ultracode: agent.ultracode,
        });

        // Send the prompt and wait for completion
        const result = await this.manager.sendMessage(sessionName, prompt, {
          timeout: this.agentTimeoutMs,
          onChunk: (chunk: string) => {
            this.emitEvent({ type: 'agent-chunk', sessionId, round, agent: agent.name, content: chunk });
          },
        });

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
      if (!this._aborted && strippedContent.length < MIN_COMPLETE_RESPONSE_LENGTH && !hasConsensusMarker(content)) {
        for (let i = 0; i < FOLLOWUP_MAX_RETRIES; i++) {
          if (this._aborted) break;
          try {
            const followup = await this.manager.sendMessage(
              sessionName,
              'Stop all tool calls. Output your complete report now, including your consensus vote [CONSENSUS: YES] or [CONSENSUS: NO].',
              { timeout: FOLLOWUP_TIMEOUT_MS },
            );
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
      // Stop session — fire-and-forget
      this.manager.stopSession(sessionName).catch(() => {});
      this._activeSessions.delete(sessionName);
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
      id: randomUUID(),
      task: task.trim(),
      config: this.config,
      responses: [],
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
    const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

    this.logger.info('Worktrees:');
    for (const [name, wtPath] of worktreeMap) {
      this.logger.info(`  ${name}: ${wtPath}`);
    }

    try {
      for (let round = 1; round <= this.config.maxRounds; round++) {
        if (this._aborted) break;

        this.logger.info(`Round ${round} (${this.config.agents.length} agents parallel)`);
        this.emitEvent({ type: 'round-start', sessionId: session.id, round });

        // Check for user injection
        const injection = this._pendingInjection;
        this._pendingInjection = null;

        // Build prompts for all agents
        const agentTasks = this.config.agents.map((agent) => {
          const workDir = worktreeMap.get(agent.name) || this.config.projectDir;
          let prompt = buildAgentPrompt(agent, trimmedTask, round, session.responses, this.config.agents);
          if (injection) {
            prompt += `\n\n## User Injection\n\n${injection}`;
          }
          const systemPrompt = buildSystemPrompt(agent, this.config.agents, workDir);
          return { agent, prompt, systemPrompt, workDir };
        });

        // Execute all agents in parallel
        const results = await Promise.allSettled(
          agentTasks.map(({ agent, prompt, systemPrompt, workDir }) =>
            this.runSingleAgent(agent, prompt, systemPrompt, workDir, round, session.id),
          ),
        );

        // Collect results
        const roundVotes: boolean[] = [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const agent = this.config.agents[i];
          if (result.status === 'fulfilled') {
            roundVotes.push(result.value.consensus);
            session.responses.push(result.value);
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

      if (this._aborted) {
        session.status = 'error';
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
    const worktrees = await spawnAsync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
      timeout: GIT_CMD_TIMEOUT_MS,
    })
      .then((r) => {
        const lines = r.stdout.split('\n');
        return lines.filter((l) => l.startsWith('worktree ')).map((l) => l.replace('worktree ', '').trim());
      })
      .catch(() => [] as string[]);
    // Filter to only council worktrees (not the main worktree)
    const councilWorktrees = worktrees.filter((w) => w.includes('council') || w.includes('.worktrees'));

    // Check plan.md
    const planPath = path.join(dir, 'plan.md');
    const planExists = fs.existsSync(planPath);
    const planContent = planExists ? fs.readFileSync(planPath, 'utf-8') : undefined;

    // Check reviews/
    const reviewsDir = path.join(dir, 'reviews');
    const reviews = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).filter((f) => f.endsWith('.md')) : [];

    // Diff stat: find changed files compared to initial state
    const changedFiles: CouncilChangedFile[] = [];
    try {
      // Ensure git history is available before diffing
      await spawnAsync('git', ['-C', dir, 'log', '--oneline', '--all', `-${GIT_LOG_DEPTH}`], {
        timeout: GIT_CMD_TIMEOUT_MS,
      });
      // Get diff stat from recent history (rough heuristic)
      const diffResult = await spawnAsync('git', ['-C', dir, 'diff', '--stat', '--numstat', 'HEAD~20', 'HEAD', '--'], {
        timeout: WORKTREE_CMD_TIMEOUT_MS,
      }).catch(() => ({ stdout: '', stderr: '' }));

      if (diffResult.stdout.trim()) {
        for (const line of diffResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const insertions = parseInt(parts[0], 10) || 0;
            const deletions = parseInt(parts[1], 10) || 0;
            const file = parts[2];
            if (file && !file.startsWith('-')) {
              changedFiles.push({ file, status: 'clean', insertions, deletions });
            }
          }
        }
      }

      // If no numstat, try a simpler approach
      if (changedFiles.length === 0) {
        const nameOnly = await spawnAsync('git', ['-C', dir, 'diff', '--name-only', 'HEAD~10', 'HEAD', '--'], {
          timeout: GIT_CMD_TIMEOUT_MS,
        }).catch(() => ({ stdout: '', stderr: '' }));
        for (const file of nameOnly.stdout.trim().split('\n').filter(Boolean)) {
          changedFiles.push({ file, status: 'clean', insertions: 0, deletions: 0 });
        }
      }
    } catch {
      // Git diff failed — possibly shallow history; skip file listing
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
      const wtListResult = await spawnAsync('git', ['-C', projectDir, 'worktree', 'list'], {
        timeout: GIT_CMD_TIMEOUT_MS,
      }).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      for (const line of wtListResult.stdout.split('\n')) {
        const wtPath = line.split(/\s+/)[0];
        if (wtPath && wtPath.includes('council')) {
          // Safety: never remove the project dir itself
          if (path.resolve(wtPath) === path.resolve(projectDir)) continue;
          await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtPath], {
            timeout: WORKTREE_CMD_TIMEOUT_MS,
          }).catch((err) => this.logger.error(`Failed to remove worktree ${wtPath}:`, err.message));
          result.worktreesRemoved.push(wtPath);
        }
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
