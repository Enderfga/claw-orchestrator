/**
 * Council super-task adapter.
 *
 * Wraps the existing Council class (src/council.ts) for ultraapp's purpose:
 * given an AppSpec, prepare a fresh git project dir, run a council session
 * inside it, and return the consensus codebase path on success.
 *
 * The "projectDir" given to Council is a brand-new empty git repo — NOT the
 * claw-orchestrator repo. Council creates its own git worktrees inside that
 * project dir and merges to its main branch. After consensus, we copy the
 * main HEAD into versions/v1/codebase as the buildable artifact.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARCHITECTURAL_CONVENTIONS } from './conventions.js';
import type { AppSpec } from './spec.js';
import type { CouncilSession, CouncilConfig } from '../types.js';

interface SessionManagerLike {
  startSession(c: {
    name?: string;
    engine?: string;
    model?: string;
    cwd?: string;
    systemPrompt?: string;
    permissionMode?: string;
  }): Promise<{ name: string }>;
  sendMessage(name: string, msg: string): Promise<{ output: string }>;
  stopSession(name: string): Promise<void>;
}

export interface CouncilSynthArgs {
  spec: AppSpec;
  runId: string;
  /** Per-run dir under ~/.claw-orchestrator/ultraapps/<runId>/. Adapter creates
      `<runDir>/council-project/` (fresh git repo) and `<runDir>/versions/v1/codebase/`. */
  runDir: string;
  sessionManager: SessionManagerLike;
  /** Set by the kernel. A cancelled build, or one past its node timeout, opens no further round. */
  signal?: { aborted: boolean };
  /** Injectable for tests. In production, defaults to running the real Council. */
  councilRun?: (cfg: CouncilConfig, sm: SessionManagerLike, task: string) => Promise<CouncilSession>;
}

export interface CouncilSynthResult {
  ok: boolean;
  worktreePath?: string;
  reason?: string;
  rounds: number;
}

export function composeCouncilPrompt(spec: AppSpec): string {
  return `
You are one of three Claude Opus agents collaborating to build a complete web
application from an AppSpec. Each agent works in its own git worktree and
merges to the shared 'main' branch. Convergence is by 3-way YES vote.

# AppSpec

\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

The slug is "${spec.meta.name}" — use it for container name, BASE_PATH, and
all routing.

# Architectural conventions (NON-NEGOTIABLE)

${ARCHITECTURAL_CONVENTIONS}

# Voting

Refer to the voting protocol in section 5 of the conventions above. Vote
[CONSENSUS: YES] only when (a) every AppSpec field is implemented, (b) every
architectural convention is met, (c) "npm run build && npm test && docker
build . && npm run smoke" all pass green in your worktree, AND (d) you have
personally executed the §7g frontend gate by capturing Chrome headless
screenshots at BOTH 1440×900 and 375×812 and visually inspecting the PNGs
— not by reading source code or meta tags. A green smoke test with a
bare-bones UI, or a UI that overflows on mobile, is still a NO vote.
`.trim();
}

export async function runCouncilSynth(args: CouncilSynthArgs): Promise<CouncilSynthResult> {
  const projectDir = path.join(args.runDir, 'council-project');
  await initFreshGitRepo(projectDir);

  const cfg = { ...buildCouncilConfig(projectDir, args.spec.meta.name), signal: args.signal };
  const task = composeCouncilPrompt(args.spec);
  const runner = args.councilRun ?? defaultCouncilRun;

  let session: CouncilSession;
  try {
    session = await runner(cfg, args.sessionManager, task);
  } catch (e) {
    return { ok: false, reason: `council threw: ${(e as Error).message}`, rounds: 0 };
  }

  const rounds = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;

  // Council's lifecycle on success is: round-with-all-YES → status='awaiting_user'
  // (waiting for the human-review tools council_review/council_accept). For
  // ultraapp the human-review step is unwanted — once consensus is reached the
  // codebase is shipped automatically. So both 'consensus' and 'awaiting_user'
  // (and 'accepted', for symmetry if a caller has already accepted) count as
  // success.
  const successStatuses = new Set(['consensus', 'awaiting_user', 'accepted']);
  if (!successStatuses.has(session.status)) {
    if (session.status === 'max_rounds') {
      return {
        ok: false,
        reason: `council reached max rounds (${rounds}) without consensus`,
        rounds,
      };
    }
    return { ok: false, reason: `council ended in status '${session.status}'`, rounds };
  }

  // Snapshot main HEAD into versions/v1/codebase
  const codebaseDir = path.join(args.runDir, 'versions', 'v1', 'codebase');
  await snapshotMainBranch(projectDir, codebaseDir);
  return { ok: true, worktreePath: codebaseDir, rounds };
}

function buildCouncilConfig(projectDir: string, slug: string): CouncilConfig {
  const personaIntro = `You are one of three Claude Opus agents collaborating to build the "${slug}" web app from a detailed AppSpec. You work in your own git worktree and merge to a shared 'main' branch. Convergence is by 3-way YES vote.`;
  return {
    name: `ultraapp-${slug}`,
    projectDir,
    maxRounds: 8,
    agents: [
      {
        name: 'agent-A',
        emoji: '🔵',
        persona: `${personaIntro} You lead with architecture and the framework choice; scaffold the project, define folder layout, set up basic /health and BYOK handling. Bias to forward progress.`,
        engine: 'claude',
        model: 'claude-opus-4-7',
      },
      {
        name: 'agent-B',
        emoji: '🟠',
        persona: `${personaIntro} You implement the pipeline DAG: input ingestion, step execution, output assembly, persistence under /data. You make sure /run, /status, /result wire to real work.`,
        engine: 'claude',
        model: 'claude-opus-4-7',
      },
      {
        name: 'agent-C',
        emoji: '🟢',
        persona: `${personaIntro} You verify and harden: smoke test, Dockerfile multi-stage, base path correctness, ESLint rule for no-server-keys, AND the §7g frontend gate. The §7g gate is binding: you MUST capture Chrome headless screenshots at 1440×900 AND 375×812, open the PNGs, and verify by eye that the rendering matches §7a–§7f at BOTH viewports — particularly that mobile has no horizontal overflow and h1 wraps at word (not letter) boundaries. Reading source code or meta tags is insufficient evidence; only the screenshots count. You vote NO until "npm run build && npm test && docker build . && npm run smoke" all pass green AND your screenshots are publishable. A working but ugly app, or one that overflows on mobile, is a NO vote.`,
        engine: 'claude',
        model: 'claude-opus-4-7',
      },
    ],
    defaultPermissionMode: 'bypassPermissions',
  };
}

async function initFreshGitRepo(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, '.git'))) return;
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'ultraapp@example.local'],
    ['config', 'user.name', 'ultraapp'],
    ['commit', '--allow-empty', '-m', 'init'],
  ]) {
    const r = spawnSync('git', args, { cwd: dir });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  }
}

async function snapshotMainBranch(projectDir: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const r = spawnSync('git', ['-C', projectDir, 'archive', 'main'], { encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git archive failed: ${r.stderr?.toString()}`);
  const t = spawnSync('tar', ['-x', '-C', dest], { input: r.stdout });
  if (t.status !== 0) throw new Error(`tar -x failed: ${t.stderr?.toString()}`);
  // Init dest as its own git repo so fix-on-failure can commit fixes
  spawnSync('git', ['init', '-b', 'main'], { cwd: dest });
  spawnSync('git', ['config', 'user.email', 'ultraapp@example.local'], { cwd: dest });
  spawnSync('git', ['config', 'user.name', 'ultraapp'], { cwd: dest });
  spawnSync('git', ['add', '.'], { cwd: dest });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'consensus snapshot'], { cwd: dest });
}

async function defaultCouncilRun(cfg: CouncilConfig, sm: SessionManagerLike, task: string): Promise<CouncilSession> {
  const { Council } = await import('../council.js');
  const council = new Council(cfg, sm as never);
  return council.run(task);
}
