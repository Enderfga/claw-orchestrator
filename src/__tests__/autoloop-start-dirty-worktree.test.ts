/**
 * Real-git preflight for autoloopStart: refuse a dirty worktree before the
 * run directory or Planner session exists. Non-repository workspaces still start.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ISession,
  SessionConfig,
  SessionStats,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
  EffortLevel,
} from '../types.js';

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  startCalled = 0;

  get isReady() {
    return true;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return false;
  }

  async start(): Promise<this> {
    this.startCalled++;
    this.sessionId = `mock-session-${Date.now()}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(
    _message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (options?.waitForComplete === false) return { requestId: 1, sent: true };
    return { text: 'ok', event: { type: 'result', result: 'done' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: 0,
      turnsSucceeded: 0,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: true,
      startTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      contextPercent: 0,
      retries: 0,
      sessionId: this.sessionId,
      uptime: 0,
    };
  }
  getHistory(): Array<{ time: string; type: string; event: unknown }> {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'mock',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: '', event: { type: 'result' } };
  }
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(_level: EffortLevel): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

const TEST_WF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-wf-'));
process.env.CLAWO_WF_DIR = TEST_WF_DIR;
process.env.CLAWO_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-sessions-'));

const { SessionManager } = await import('../session-manager.js');
const { runDir } = await import('../kernel/store.js');

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

/** Repo root with committed content; workspace is a nested subdirectory. */
function createNestedWorkspaceRepo(workspaceParts = ['nested', 'pkg']): { repoRoot: string; workspace: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-nested-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# root\n');
  const workspace = path.join(repoRoot, ...workspaceParts);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app.txt'), 'committed nested\n');
  execFileSync('git', ['add', 'README.md', [...workspaceParts, 'app.txt'].join('/')], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'pipe' });
  return { repoRoot, workspace };
}

function porcelain(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' });
}

function headSha(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function createManager(): SessionManager {
  const mgr = new SessionManager({
    claudeBin: 'mock-claude',
    maxConcurrentSessions: 5,
    sessionTtlMinutes: 120,
    defaultPermissionMode: 'acceptEdits',
    defaultEffort: 'auto',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any)._createSession = (_engine: string, _config: SessionConfig): ISession => new MockSession();
  return mgr;
}

function plannerSessionName(runId: string): string {
  return `autoloop-${runId}-planner`;
}

function assertRejectedBeforeSideEffects(mgr: SessionManager, runId: string, err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/uncommitted changes/i);
  expect(fs.existsSync(runDir(runId))).toBe(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(false);
  expect(mgr.getAutoloop(runId)).toBeUndefined();
}

describe('autoloopStart dirty worktree preflight', () => {
  let mgr: SessionManager;
  const repos: string[] = [];

  beforeEach(() => {
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  afterEach(async () => {
    await mgr.shutdown();
    for (const dir of repos.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unstaged tracked dirt before runDir or Planner session, leaving tree unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const dirtyPath = path.join(workspace, 'README.md');
    const dirtyBytes = '# dirty unstaged\n';
    fs.writeFileSync(dirtyPath, dirtyBytes);
    const beforePorcelain = porcelain(workspace);
    const beforeHead = headSha(workspace);
    expect(beforePorcelain.trim()).not.toBe('');

    const runId = 'dirty-unstaged';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
    expect(fs.readFileSync(dirtyPath, 'utf8')).toBe(dirtyBytes);
    expect(porcelain(workspace)).toBe(beforePorcelain);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('rejects staged tracked dirt before runDir or Planner session, leaving tree unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const dirtyPath = path.join(workspace, 'README.md');
    const dirtyBytes = '# dirty staged\n';
    fs.writeFileSync(dirtyPath, dirtyBytes);
    execFileSync('git', ['add', 'README.md'], { cwd: workspace, stdio: 'pipe' });
    const beforePorcelain = porcelain(workspace);
    const beforeHead = headSha(workspace);
    expect(beforePorcelain.trim()).not.toBe('');

    const runId = 'dirty-staged';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
    expect(fs.readFileSync(dirtyPath, 'utf8')).toBe(dirtyBytes);
    expect(porcelain(workspace)).toBe(beforePorcelain);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('rejects untracked dirt before runDir or Planner session, leaving tree unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const dirtyPath = path.join(workspace, 'untracked.txt');
    const dirtyBytes = 'brand new\n';
    fs.writeFileSync(dirtyPath, dirtyBytes);
    const beforePorcelain = porcelain(workspace);
    const beforeHead = headSha(workspace);
    expect(beforePorcelain.trim()).not.toBe('');

    const runId = 'dirty-untracked';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
    expect(fs.readFileSync(dirtyPath, 'utf8')).toBe(dirtyBytes);
    expect(porcelain(workspace)).toBe(beforePorcelain);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('rejects untracked dirt even when status.showUntrackedFiles=no hides porcelain', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: workspace, stdio: 'pipe' });
    const dirtyPath = path.join(workspace, 'untracked.txt');
    const dirtyBytes = 'hidden by showUntrackedFiles=no\n';
    fs.writeFileSync(dirtyPath, dirtyBytes);

    // Plain porcelain is empty under this setting; ls-files still sees the file.
    expect(porcelain(workspace).trim()).toBe('');
    const others = execFileSync('git', ['-C', workspace, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
    });
    expect(others).toContain('untracked.txt');

    const beforePorcelain = porcelain(workspace);
    const beforeHead = headSha(workspace);

    const runId = 'dirty-untracked-hidden';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
    expect(fs.readFileSync(dirtyPath, 'utf8')).toBe(dirtyBytes);
    expect(porcelain(workspace)).toBe(beforePorcelain);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('rejects when porcelain listing exceeds execFileSync maxBuffer (ENOBUFS)', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const bulk = path.join(workspace, 'bulk');
    fs.mkdirSync(bulk);
    // ~6000 long names → >1 MiB porcelain (Node default maxBuffer), matching the
    // reviewer case (~1344000 status bytes). Leave the files in place after reject.
    const pad = 'x'.repeat(200);
    for (let i = 0; i < 6000; i++) {
      fs.writeFileSync(path.join(bulk, `${pad}-${String(i).padStart(5, '0')}`), '');
    }

    let statusBytes = 0;
    try {
      const out = execFileSync('git', ['-C', workspace, 'status', '--porcelain', '--untracked-files=all'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      statusBytes = Buffer.byteLength(out, 'utf8');
    } catch (err) {
      const e = err as { code?: string; stdout?: string };
      expect(e.code).toBe('ENOBUFS');
      statusBytes = Buffer.byteLength(e.stdout ?? '', 'utf8');
    }
    expect(statusBytes).toBeGreaterThan(1024 * 1024);

    const beforeHead = headSha(workspace);
    const sample = path.join(bulk, `${pad}-00000`);
    expect(fs.existsSync(sample)).toBe(true);

    const runId = 'dirty-oversize-porcelain';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
    expect(fs.existsSync(sample)).toBe(true);
    expect(headSha(workspace)).toBe(beforeHead);
  }, 60_000);

  it('rejects when git status fails without producing porcelain output', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    fs.writeFileSync(path.join(workspace, '.git', 'index'), 'corrupt index\n');

    const runId = 'status-failure';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects when a worktree .git file points to missing repository metadata', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    fs.renameSync(path.join(workspace, '.git'), path.join(workspace, '.git-real'));
    fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: missing-gitdir\n');

    const runId = 'broken-gitdir-link';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects submodule dirt hidden by repository status configuration', async () => {
    const workspace = createTempRepo();
    const submoduleSource = createTempRepo();
    repos.push(workspace, submoduleSource);
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'dep'], {
      cwd: workspace,
      stdio: 'pipe',
    });
    execFileSync('git', ['commit', '-am', 'add submodule'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['config', 'submodule.dep.ignore', 'all'], { cwd: workspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(workspace, 'dep', 'README.md'), '# dirty submodule\n');

    const hidden = execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1'], { encoding: 'utf8' });
    expect(hidden).toBe('');
    const forced = execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1', '--ignore-submodules=none'], {
      encoding: 'utf8',
    });
    expect(forced).toContain('dep');

    const runId = 'dirty-hidden-submodule';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects a dirty submodule inside a marked ledger', async () => {
    const workspace = createTempRepo();
    const submoduleSource = createTempRepo();
    repos.push(workspace, submoduleSource);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, 'goal.json'), '{"scalar":null}\n');
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'tasks/prev-run/dep'],
      { cwd: workspace, stdio: 'pipe' },
    );
    execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ledger with submodule'], { cwd: workspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(ledgerDir, 'dep', 'README.md'), '# dirty ledger submodule\n');

    const zStatus = execFileSync(
      'git',
      ['-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      { encoding: 'utf8' },
    );
    expect(zStatus).toContain(' M tasks/prev-run/dep');

    const runId = 'dirty-ledger-submodule';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('starts on a clean temp repo and creates the Planner session', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    expect(porcelain(workspace).trim()).toBe('');

    const runId = 'clean-start';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(true);
  });

  it('does not refuse a non-repository workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-norepo-'));
    repos.push(workspace);
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'not a git repo\n');

    const runId = 'norepo-start';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
  });

  it.skipIf(!fs.existsSync('/dev/shm'))(
    'does not refuse a non-repository workspace at a filesystem discovery boundary',
    async () => {
      const workspace = fs.mkdtempSync('/dev/shm/clawo-dirty-start-norepo-');
      repos.push(workspace);
      fs.writeFileSync(path.join(workspace, 'notes.txt'), 'not a git repo\n');

      let statusStderr = '';
      try {
        execFileSync('git', ['-C', workspace, 'status'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, LC_ALL: 'C' },
        });
      } catch (err) {
        const stderr = (err as { stderr?: string | Buffer }).stderr;
        statusStderr = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
      }
      expect(statusStderr).toContain('Stopping at filesystem boundary');

      const runId = 'norepo-filesystem-boundary';
      const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
      expect(result.runId).toBe(runId);
      expect(result.plannerSession).toBe(plannerSessionName(runId));
      expect(fs.existsSync(runDir(runId))).toBe(true);
    },
  );

  it('allows a second start when the only dirt is an untracked previous-run ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const goalPath = path.join(workspace, 'tasks', 'prev-run', 'goal.json');
    const verdictPath = path.join(workspace, 'tasks', 'prev-run', 'iter', '0', 'verdict.json');
    fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
    const goalBytes = '{"scalar":null}\n';
    const verdictBytes = '{"verdict":"accept"}\n';
    fs.writeFileSync(goalPath, goalBytes);
    fs.writeFileSync(verdictPath, verdictBytes);
    const beforeHead = headSha(workspace);

    const runId = 'second-start';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(true);
    expect(fs.readFileSync(goalPath, 'utf8')).toBe(goalBytes);
    expect(fs.readFileSync(verdictPath, 'utf8')).toBe(verdictBytes);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('allows a second start when the ledger id contains a space and a double quote', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerId = 'run "1"';
    const goalPath = path.join(workspace, 'tasks', ledgerId, 'goal.json');
    const decisionsPath = path.join(workspace, 'tasks', ledgerId, 'decisions.jsonl');
    fs.mkdirSync(path.dirname(goalPath), { recursive: true });
    fs.writeFileSync(goalPath, '{"scalar":null}\n');
    fs.writeFileSync(decisionsPath, '{}\n');

    const runId = 'second-start-quoted';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(true);
  });

  it('rejects a file directly under tasks with no id', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const dirtyPath = path.join(workspace, 'tasks', 'notes.txt');
    fs.mkdirSync(path.dirname(dirtyPath), { recursive: true });
    fs.writeFileSync(dirtyPath, 'no id\n');

    const runId = 'tasks-no-id';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects tasks dirt with no goal.json marker', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const dirtyPath = path.join(workspace, 'tasks', 'no-marker', 'notes.txt');
    fs.mkdirSync(path.dirname(dirtyPath), { recursive: true });
    fs.writeFileSync(dirtyPath, 'no marker\n');

    const runId = 'tasks-no-marker';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects a ledger plus a dirty README', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const goalPath = path.join(workspace, 'tasks', 'prev-run', 'goal.json');
    fs.mkdirSync(path.dirname(goalPath), { recursive: true });
    fs.writeFileSync(goalPath, '{"scalar":null}\n');
    fs.writeFileSync(path.join(workspace, 'README.md'), '# dirty with ledger\n');

    const runId = 'ledger-plus-readme';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('allows a second start when a committed ledger has appended decisions.jsonl and chat.jsonl', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(path.join(ledgerDir, 'iter', '0'), { recursive: true });
    const goalPath = path.join(ledgerDir, 'goal.json');
    const decisionsPath = path.join(ledgerDir, 'decisions.jsonl');
    const chatPath = path.join(ledgerDir, 'chat.jsonl');
    const goalBytes = '{"scalar":null}\n';
    const decisionsCommitted = '{"type":"iter_complete","iter":0}\n';
    const chatCommitted = '{"role":"planner","text":"done"}\n';
    fs.writeFileSync(goalPath, goalBytes);
    fs.writeFileSync(decisionsPath, decisionsCommitted);
    fs.writeFileSync(chatPath, chatCommitted);
    // Iteration commit uses `git add -A`, so the ledger is tracked.
    execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'autoloop/iter-0: coder'], { cwd: workspace, stdio: 'pipe' });
    // Post-commit appends leave index-clean worktree mods (` M`), not `??`.
    const decisionsAppended = '{"type":"run_complete"}\n';
    const chatAppended = '{"role":"system","text":"terminated"}\n';
    fs.appendFileSync(decisionsPath, decisionsAppended);
    fs.appendFileSync(chatPath, chatAppended);
    const verdictPath = path.join(ledgerDir, 'iter', '0', 'verdict.json');
    const verdictBytes = '{"verdict":"accept"}\n';
    fs.writeFileSync(verdictPath, verdictBytes);

    const zStatus = execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    expect(zStatus).toContain(' M tasks/prev-run/decisions.jsonl');
    expect(zStatus).toContain(' M tasks/prev-run/chat.jsonl');
    expect(zStatus).toContain('?? tasks/prev-run/iter/0/verdict.json');
    const beforeHead = headSha(workspace);

    const runId = 'second-start-committed-ledger';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(true);
    expect(fs.readFileSync(goalPath, 'utf8')).toBe(goalBytes);
    expect(fs.readFileSync(decisionsPath, 'utf8')).toBe(decisionsCommitted + decisionsAppended);
    expect(fs.readFileSync(chatPath, 'utf8')).toBe(chatCommitted + chatAppended);
    expect(fs.readFileSync(verdictPath, 'utf8')).toBe(verdictBytes);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('rejects a deleted tracked file inside a marked ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const goalPath = path.join(ledgerDir, 'goal.json');
    const keepPath = path.join(ledgerDir, 'keep.txt');
    fs.writeFileSync(goalPath, '{"scalar":null}\n');
    fs.writeFileSync(keepPath, 'keep\n');
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ledger'], { cwd: workspace, stdio: 'pipe' });
    fs.unlinkSync(keepPath);

    const runId = 'ledger-deleted-tracked';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects a staged modification of a tracked file inside a marked ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const goalPath = path.join(ledgerDir, 'goal.json');
    const keepPath = path.join(ledgerDir, 'keep.txt');
    fs.writeFileSync(goalPath, '{"scalar":null}\n');
    fs.writeFileSync(keepPath, 'keep\n');
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ledger'], { cwd: workspace, stdio: 'pipe' });
    fs.writeFileSync(keepPath, 'keep staged\n');
    execFileSync('git', ['add', keepPath], { cwd: workspace, stdio: 'pipe' });

    const runId = 'ledger-staged-tracked';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects a staged file inside a marked ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, 'goal.json'), '{"scalar":null}\n');
    const stagedPath = path.join(ledgerDir, 'staged.txt');
    fs.writeFileSync(stagedPath, 'staged\n');
    execFileSync('git', ['add', stagedPath], { cwd: workspace, stdio: 'pipe' });

    const runId = 'ledger-staged';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects a rename out of a marked ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const goalPath = path.join(ledgerDir, 'goal.json');
    const keepPath = path.join(ledgerDir, 'keep.txt');
    fs.writeFileSync(goalPath, '{"scalar":null}\n');
    fs.writeFileSync(keepPath, 'keep\n');
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ledger'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['mv', keepPath, path.join(workspace, 'moved.txt')], {
      cwd: workspace,
      stdio: 'pipe',
    });

    const runId = 'ledger-rename-out';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('rejects a rename that stays inside a marked ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerDir = path.join(workspace, 'tasks', 'prev-run');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const goalPath = path.join(ledgerDir, 'goal.json');
    const keepPath = path.join(ledgerDir, 'keep.txt');
    fs.writeFileSync(goalPath, '{"scalar":null}\n');
    fs.writeFileSync(keepPath, 'keep\n');
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ledger'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['mv', keepPath, path.join(ledgerDir, 'renamed.txt')], {
      cwd: workspace,
      stdio: 'pipe',
    });

    const runId = 'ledger-rename-in';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });

  it('allows a second start when workspace is a nested repo subdirectory with only an untracked ledger', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo();
    repos.push(repoRoot);
    const goalPath = path.join(workspace, 'tasks', 'prev-run', 'goal.json');
    const decisionsPath = path.join(workspace, 'tasks', 'prev-run', 'decisions.jsonl');
    fs.mkdirSync(path.dirname(goalPath), { recursive: true });
    const goalBytes = '{"scalar":null}\n';
    const decisionsBytes = '{}\n';
    fs.writeFileSync(goalPath, goalBytes);
    fs.writeFileSync(decisionsPath, decisionsBytes);

    // Porcelain from a nested workspace is repo-root-relative (prefix + tasks/...).
    const zStatus = execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    expect(zStatus).toContain('nested/pkg/tasks/prev-run/goal.json');
    const prefix = execFileSync('git', ['-C', workspace, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
    }).trim();
    expect(prefix).toBe('nested/pkg/');
    const beforeHead = headSha(repoRoot);

    const runId = 'second-start-nested';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(true);
    expect(fs.readFileSync(goalPath, 'utf8')).toBe(goalBytes);
    expect(fs.readFileSync(decisionsPath, 'utf8')).toBe(decisionsBytes);
    expect(headSha(repoRoot)).toBe(beforeHead);
  });

  it('allows a nested workspace whose valid path component starts with two dots', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo(['..cache', 'pkg']);
    repos.push(repoRoot);
    const goalPath = path.join(workspace, 'tasks', 'prev-run', 'goal.json');
    fs.mkdirSync(path.dirname(goalPath), { recursive: true });
    fs.writeFileSync(goalPath, '{"scalar":null}\n');

    const prefix = execFileSync('git', ['-C', workspace, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
    }).trim();
    expect(prefix).toBe('..cache/pkg/');

    const runId = 'second-start-two-dot-component';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(result.plannerSession).toBe(plannerSessionName(runId));
    expect(fs.existsSync(runDir(runId))).toBe(true);
  });

  it('rejects untracked ledger-like dirt elsewhere in the repo when workspace is nested', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo();
    repos.push(repoRoot);
    const siblingLedger = path.join(repoRoot, 'other', 'tasks', 'prev-run', 'goal.json');
    fs.mkdirSync(path.dirname(siblingLedger), { recursive: true });
    fs.writeFileSync(siblingLedger, '{"scalar":null}\n');
    fs.writeFileSync(path.join(path.dirname(siblingLedger), 'decisions.jsonl'), '{}\n');

    const runId = 'sibling-ledger-reject';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
  });
});

/** Fixed generic refusal from run-local ledger isolation (no path/runId/stderr). */
const LEDGER_ISOLATION_ERROR = 'Autoloop could not isolate the run ledger from Git';

function assertLedgerNotIgnored(workspace: string, runId: string): void {
  let ignored = false;
  try {
    execFileSync('git', ['-C', workspace, 'check-ignore', '-q', '--', `tasks/${runId}/chat.jsonl`], {
      stdio: 'pipe',
      env: { ...process.env, LC_ALL: 'C' },
    });
    ignored = true;
  } catch {
    ignored = false;
  }
  expect(ignored).toBe(false);
}

function porcelainUntrackedAll(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
}

function addDryRun(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'add', '-A', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
}

function listDirSorted(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        walk(rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (st.isSymbolicLink()) {
      out.set(rel, `symlink:${fs.readlinkSync(abs)}`);
      return;
    }
    out.set(rel, fs.readFileSync(abs, 'utf8'));
  };
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) walk(name);
  }
  return out;
}

describe('run ledger: isolation via tasks/<runId>/.gitignore', () => {
  let mgr: SessionManager;
  const repos: string[] = [];

  beforeEach(() => {
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  afterEach(async () => {
    await mgr.shutdown();
    for (const dir of repos.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R1: clean start + chat leaves porcelain empty and add -A dry-run skips tasks/', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-r1';
    assertLedgerNotIgnored(workspace, runId);
    const beforeHead = headSha(workspace);

    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    await mgr.autoloopChat(runId, 'hello ledger');

    expect(fs.existsSync(path.join(workspace, 'tasks', runId, 'chat.jsonl'))).toBe(true);
    expect(porcelainUntrackedAll(workspace).trim()).toBe('');
    expect(addDryRun(workspace)).not.toMatch(/(^|\s)tasks\//);
    expect(headSha(workspace)).toBe(beforeHead);
  });

  it('R2: second run id starts after first ledger wrote chat; both ignored; README unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const readmePath = path.join(workspace, 'README.md');
    const readmeBytes = fs.readFileSync(readmePath, 'utf8');
    const runA = 'ledger-r2-a';
    const runB = 'ledger-r2-b';
    assertLedgerNotIgnored(workspace, runA);
    assertLedgerNotIgnored(workspace, runB);

    await mgr.autoloopStart({ runId: runA, workspace, plannerEngine: 'codex' });
    await mgr.autoloopChat(runA, 'first run chat');
    expect(fs.existsSync(path.join(workspace, 'tasks', runA, 'chat.jsonl'))).toBe(true);

    const resultB = await mgr.autoloopStart({ runId: runB, workspace, plannerEngine: 'codex' });
    expect(resultB.runId).toBe(runB);
    await mgr.autoloopChat(runB, 'second run chat');

    expect(porcelainUntrackedAll(workspace).trim()).toBe('');
    expect(addDryRun(workspace)).not.toMatch(/(^|\s)tasks\//);
    expect(fs.readFileSync(readmePath, 'utf8')).toBe(readmeBytes);
  });

  it('R3: committed tracked file under tasks/<id>/ refuses; no Planner; tracked bytes unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-r3';
    const trackedPath = path.join(workspace, 'tasks', runId, 'keep.txt');
    fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
    const trackedBytes = 'tracked keep\n';
    fs.writeFileSync(trackedPath, trackedBytes);
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'tracked ledger'], { cwd: workspace, stdio: 'pipe' });
    expect(porcelain(workspace).trim()).toBe('');
    assertLedgerNotIgnored(workspace, runId);

    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(LEDGER_ISOLATION_ERROR);
    expect(fs.existsSync(runDir(runId))).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(runId))).toBe(false);
    expect(mgr.getAutoloop(runId)).toBeUndefined();
    expect(fs.readFileSync(trackedPath, 'utf8')).toBe(trackedBytes);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId, '.gitignore'))).toBe(false);
  });

  it('R4: partial self-ignoring .gitignore (.gitignore\\n) refuses; bytes unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-r4';
    const ignorePath = path.join(workspace, 'tasks', runId, '.gitignore');
    fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
    const partialBytes = '.gitignore\n';
    fs.writeFileSync(ignorePath, partialBytes);
    expect(porcelainUntrackedAll(workspace).trim()).toBe('');
    assertLedgerNotIgnored(workspace, runId);

    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(LEDGER_ISOLATION_ERROR);
    expect(fs.readFileSync(ignorePath, 'utf8')).toBe(partialBytes);
    expect(fs.existsSync(runDir(runId))).toBe(false);
    expect(mgr.getAutoloop(runId)).toBeUndefined();
  });

  it('R5: committed symlink tasks → outside dir refuses; outside listing/bytes unchanged', async () => {
    const workspace = createTempRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ledger-r5-outside-'));
    repos.push(workspace, outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside sentinel\n');
    const beforeOutside = snapshotTree(outside);
    const beforeListing = listDirSorted(outside);

    const tasksLink = path.join(workspace, 'tasks');
    fs.symlinkSync(outside, tasksLink);
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'tasks symlink'], { cwd: workspace, stdio: 'pipe' });
    expect(porcelain(workspace).trim()).toBe('');

    const runId = 'ledger-r5';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(LEDGER_ISOLATION_ERROR);
    expect(listDirSorted(outside)).toEqual(beforeListing);
    expect(snapshotTree(outside)).toEqual(beforeOutside);
    expect(fs.existsSync(path.join(outside, runId))).toBe(false);
    expect(fs.existsSync(path.join(outside, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'chat.jsonl'))).toBe(false);
    expect(fs.existsSync(runDir(runId))).toBe(false);
    expect(mgr.getAutoloop(runId)).toBeUndefined();
  });

  it('guard: dirty-tree refusal still fires and creates no ledger', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), '# still dirty\n');
    const runId = 'ledger-guard-dirty';
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, runId, thrown);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('guard: non-Git start is unchanged', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ledger-guard-norepo-'));
    repos.push(workspace);
    const runId = 'ledger-guard-norepo';
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(fs.existsSync(runDir(runId))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId, '.gitignore'))).toBe(false);
  });

  it('guard: nested workspace start leaves ledger ignored', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo();
    repos.push(repoRoot);
    const runId = 'ledger-guard-nested';
    assertLedgerNotIgnored(workspace, runId);
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    await mgr.autoloopChat(runId, 'nested chat');
    expect(porcelainUntrackedAll(workspace).trim()).toBe('');
    expect(addDryRun(workspace)).not.toMatch(/tasks\//);
  });

  it('guard: linked git worktree start leaves ledger ignored', async () => {
    const main = createTempRepo();
    repos.push(main);
    const worktree = path.join(os.tmpdir(), `clawo-ledger-wt-${Date.now()}`);
    execFileSync('git', ['-C', main, 'worktree', 'add', worktree, 'HEAD'], { stdio: 'pipe' });
    repos.push(worktree);
    const runId = 'ledger-guard-worktree';
    assertLedgerNotIgnored(worktree, runId);
    await mgr.autoloopStart({ runId, workspace: worktree, plannerEngine: 'codex' });
    await mgr.autoloopChat(runId, 'worktree chat');
    expect(porcelainUntrackedAll(worktree).trim()).toBe('');
    expect(addDryRun(worktree)).not.toMatch(/tasks\//);
  });

  it('guard: info/exclude, root .gitignore and core.excludesFile unchanged after start', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const rootIgnore = path.join(workspace, '.gitignore');
    fs.writeFileSync(rootIgnore, 'node_modules/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'root ignore'], { cwd: workspace, stdio: 'pipe' });
    const excludePath = execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
    }).trim();
    const excludeAbs = path.isAbsolute(excludePath) ? excludePath : path.join(workspace, excludePath);
    fs.mkdirSync(path.dirname(excludeAbs), { recursive: true });
    const excludeBytes = '# keep exclude\n';
    fs.writeFileSync(excludeAbs, excludeBytes);
    const externalExcludes = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-excludes-file-'));
    repos.push(externalExcludes);
    const excludesFile = path.join(externalExcludes, 'excludes');
    const excludesBytes = '*.tmp\n';
    fs.writeFileSync(excludesFile, excludesBytes);
    execFileSync('git', ['config', 'core.excludesFile', excludesFile], { cwd: workspace, stdio: 'pipe' });
    const rootIgnoreBytes = fs.readFileSync(rootIgnore, 'utf8');
    const runId = 'ledger-guard-shared-ignore';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(fs.readFileSync(excludeAbs, 'utf8')).toBe(excludeBytes);
    expect(fs.readFileSync(rootIgnore, 'utf8')).toBe(rootIgnoreBytes);
    expect(fs.readFileSync(excludesFile, 'utf8')).toBe(excludesBytes);
    expect(
      execFileSync('git', ['-C', workspace, 'config', '--get', 'core.excludesFile'], { encoding: 'utf8' }).trim(),
    ).toBe(excludesFile);
  });

  it('guard: existing *, *\\n or *\\r\\n .gitignore is accepted and bytes preserved', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const cases: Array<{ runId: string; bytes: string }> = [
      { runId: 'ledger-guard-star', bytes: '*' },
      { runId: 'ledger-guard-star-lf', bytes: '*\n' },
      { runId: 'ledger-guard-star-crlf', bytes: '*\r\n' },
    ];
    for (const { runId, bytes } of cases) {
      const ignorePath = path.join(workspace, 'tasks', runId, '.gitignore');
      fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
      fs.writeFileSync(ignorePath, bytes);
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
      expect(fs.readFileSync(ignorePath, 'utf8')).toBe(bytes);
      await mgr.autoloopChat(runId, `chat ${runId}`);
      expect(porcelainUntrackedAll(workspace).trim()).toBe('');
    }
  });

  it('guard: same-id retry after Planner start failure keeps retained *\\n .gitignore', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-guard-retry';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any)._createSession = (): ISession => {
      const mock = new MockSession();
      mock.start = async () => {
        throw new Error('planner startup failed');
      };
      return mock;
    };
    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      'planner startup failed',
    );
    const ignorePath = path.join(workspace, 'tasks', runId, '.gitignore');
    expect(fs.readFileSync(ignorePath, 'utf8')).toBe('*\n');
    expect(fs.existsSync(runDir(runId))).toBe(false);

    mgr = createManager();
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(fs.readFileSync(ignorePath, 'utf8')).toBe('*\n');
    expect(fs.existsSync(runDir(runId))).toBe(true);
  });

  it('guard: isolation error equals fixed constant with no runId, path or stderr', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-guard-err-msg';
    const trackedPath = path.join(workspace, 'tasks', runId, 'keep.txt');
    fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
    fs.writeFileSync(trackedPath, 'x\n');
    execFileSync('git', ['add', 'tasks'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'tracked'], { cwd: workspace, stdio: 'pipe' });

    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toBe(LEDGER_ISOLATION_ERROR);
    expect(msg).not.toContain(runId);
    expect(msg).not.toContain(workspace);
    expect(msg).not.toContain('keep.txt');
    expect(msg).not.toMatch(/fatal:|error:/i);
  });
});

describe('workflow autoloop node fresh-start boundary', () => {
  let mgr: SessionManager;
  const repos: string[] = [];

  beforeEach(() => {
    fs.rmSync(TEST_WF_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_WF_DIR, { recursive: true });
    mgr = createManager();
  });

  afterEach(async () => {
    await mgr.shutdown();
    for (const dir of repos.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function waitUntil(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timeout: ${label}`);
  }

  function autoloopWorkflowSpec(
    workspace: string,
    ledgerId: string,
    extra: { retry?: { max: number; backoffMs?: number }; configExtras?: Record<string, unknown> } = {},
  ) {
    return {
      name: 'wf-autoloop-fresh',
      cwd: workspace,
      nodes: [
        {
          id: 'loop',
          kind: 'autoloop' as const,
          workspace,
          ...(extra.retry ? { retry: extra.retry } : {}),
          config: {
            runId: ledgerId,
            workspace,
            plannerEngine: 'codex',
            ...(extra.configExtras ?? {}),
          },
        },
      ],
    };
  }

  // W1 dirty: unstaged README + untracked-file variant
  it('W1: dirty workflowStart fails with uncommitted changes; no Planner, no tasks/, tree unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const readmePath = path.join(workspace, 'README.md');
    const beforeHead = headSha(workspace);
    const beforeReadme = fs.readFileSync(readmePath, 'utf8');
    const beforePorcelain = porcelainUntrackedAll(workspace);

    // Variant A: unstaged tracked dirt
    fs.writeFileSync(readmePath, '# dirty unstaged\n');
    const workflowRunId = 'wf-w1-unstaged';
    const ledgerId = 'ledger-w1-unstaged';
    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerId), {
      runId: workflowRunId,
      cwd: workspace,
    });
    await waitUntil(() => {
      const rec = mgr.workflowStatus(workflowRunId);
      return rec.state === 'failed' || rec.nodes.loop?.state === 'failed';
    }, 'W1 unstaged fail');
    const failedA = mgr.workflowStatus(workflowRunId);
    expect(failedA.state).toBe('failed');
    expect(failedA.nodes.loop.state).toBe('failed');
    expect(failedA.nodes.loop.error ?? failedA.error ?? '').toMatch(/uncommitted changes/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(ledgerId))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'tasks'))).toBe(false);
    expect(fs.readFileSync(readmePath, 'utf8')).toBe('# dirty unstaged\n');
    expect(headSha(workspace)).toBe(beforeHead);

    // Variant B: untracked file (restore README first)
    fs.writeFileSync(readmePath, beforeReadme);
    fs.writeFileSync(path.join(workspace, 'extra-untracked.txt'), 'nope\n');
    const workflowRunIdB = 'wf-w1-untracked';
    const ledgerIdB = 'ledger-w1-untracked';
    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerIdB), {
      runId: workflowRunIdB,
      cwd: workspace,
    });
    await waitUntil(() => {
      const rec = mgr.workflowStatus(workflowRunIdB);
      return rec.state === 'failed' || rec.nodes.loop?.state === 'failed';
    }, 'W1 untracked fail');
    const failedB = mgr.workflowStatus(workflowRunIdB);
    expect(failedB.state).toBe('failed');
    expect(failedB.nodes.loop.state).toBe('failed');
    expect(failedB.nodes.loop.error ?? failedB.error ?? '').toMatch(/uncommitted changes/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(ledgerIdB))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'tasks', ledgerIdB))).toBe(false);
    expect(headSha(workspace)).toBe(beforeHead);
    expect(porcelainUntrackedAll(workspace)).toContain('extra-untracked.txt');
    void beforePorcelain;
  });

  // W2 clean: ignore file exists before MockSession.start; porcelain empty; identity is ledger id
  it('W2: clean workflowStart creates ledger .gitignore before Planner start; workflow run id not used', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const workflowRunId = 'wf-w2-workflow';
    const ledgerId = 'ledger-w2-ledger';
    const ignorePath = path.join(workspace, 'tasks', ledgerId, '.gitignore');
    const rootIgnore = path.join(workspace, '.gitignore');
    fs.writeFileSync(rootIgnore, 'node_modules/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'root ignore'], { cwd: workspace, stdio: 'pipe' });
    const rootIgnoreBytes = fs.readFileSync(rootIgnore, 'utf8');
    const excludePath = execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
    }).trim();
    const excludeAbs = path.isAbsolute(excludePath) ? excludePath : path.join(workspace, excludePath);
    fs.mkdirSync(path.dirname(excludeAbs), { recursive: true });
    const excludeBytes = '# keep\n';
    fs.writeFileSync(excludeAbs, excludeBytes);
    const externalExcludes = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-w2-excludes-'));
    repos.push(externalExcludes);
    const excludesFile = path.join(externalExcludes, 'excludes');
    const excludesBytes = '*.tmp\n';
    fs.writeFileSync(excludesFile, excludesBytes);
    execFileSync('git', ['config', 'core.excludesFile', excludesFile], { cwd: workspace, stdio: 'pipe' });

    let sawIgnoreAtStart = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any)._createSession = (_engine: string, _config: SessionConfig): ISession => {
      const mock = new MockSession();
      const orig = mock.start.bind(mock);
      mock.start = async () => {
        if (fs.existsSync(ignorePath) && fs.readFileSync(ignorePath, 'utf8') === '*\n') {
          sawIgnoreAtStart = true;
        }
        return orig();
      };
      return mock;
    };

    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerId), {
      runId: workflowRunId,
      cwd: workspace,
    });
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(ledgerId));
    }, 'W2 planner ready');

    expect(sawIgnoreAtStart).toBe(true);
    expect(fs.readFileSync(ignorePath, 'utf8')).toBe('*\n');
    expect(porcelainUntrackedAll(workspace).trim()).toBe('');
    for (const probe of [
      `tasks/${ledgerId}/.gitignore`,
      `tasks/${ledgerId}/chat.jsonl`,
      `tasks/${ledgerId}/decisions.jsonl`,
      `tasks/${ledgerId}/iter/0/verdict.json`,
    ]) {
      execFileSync('git', ['-C', workspace, 'check-ignore', '-q', '--', probe], {
        stdio: 'pipe',
        env: { ...process.env, LC_ALL: 'C' },
      });
    }
    expect(addDryRun(workspace)).not.toMatch(/(^|\s)tasks\//);
    expect(fs.readFileSync(rootIgnore, 'utf8')).toBe(rootIgnoreBytes);
    expect(fs.readFileSync(excludeAbs, 'utf8')).toBe(excludeBytes);
    expect(fs.readFileSync(excludesFile, 'utf8')).toBe(excludesBytes);
    expect(fs.existsSync(path.join(workspace, 'tasks', workflowRunId))).toBe(false);
  });

  // W3 second start with different ledger id
  it('W3: second workflowStart with different ledger id keeps both ignored and porcelain empty', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const ledgerA = 'ledger-w3-a';
    const ledgerB = 'ledger-w3-b';
    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerA), {
      runId: 'wf-w3-a',
      cwd: workspace,
    });
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(ledgerA));
    }, 'W3a planner');
    fs.writeFileSync(path.join(workspace, 'tasks', ledgerA, 'chat.jsonl'), '{"t":1}\n');

    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerB), {
      runId: 'wf-w3-b',
      cwd: workspace,
    });
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(ledgerB));
    }, 'W3b planner');

    expect(fs.existsSync(path.join(workspace, 'tasks', ledgerA, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'tasks', ledgerB, '.gitignore'))).toBe(true);
    expect(porcelainUntrackedAll(workspace).trim()).toBe('');
  });

  // W4 Git + invalid config.runId
  it('W4: invalid config.runId on Git workflowStart fails with fixed isolation error only', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const beforeListing = listDirSorted(workspace);
    const beforeTree = snapshotTree(workspace);
    const workflowRunId = 'wf-w4-valid';
    const badLedger = '../escape';
    await mgr.workflowStart(autoloopWorkflowSpec(workspace, badLedger), {
      runId: workflowRunId,
      cwd: workspace,
    });
    await waitUntil(() => {
      const rec = mgr.workflowStatus(workflowRunId);
      return rec.state === 'failed' || rec.nodes.loop?.state === 'failed';
    }, 'W4 fail');
    const failed = mgr.workflowStatus(workflowRunId);
    const err = failed.nodes.loop.error ?? failed.error ?? '';
    expect(err).toBe(LEDGER_ISOLATION_ERROR);
    expect(err).not.toContain(badLedger);
    expect(err).not.toContain(workspace);
    expect(err).not.toMatch(/fatal:|error:/i);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(badLedger))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'escape'))).toBe(false);
    expect(listDirSorted(workspace)).toEqual(beforeListing);
    expect(snapshotTree(workspace)).toEqual(beforeTree);
  });

  // W5 non-Git control
  it('W5: non-Git workflowStart starts Planner and creates no .gitignore', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-w5-norepo-'));
    repos.push(workspace);
    const ledgerId = 'ledger-w5';
    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerId), {
      runId: 'wf-w5',
      cwd: workspace,
    });
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(ledgerId));
    }, 'W5 planner');
    expect(fs.existsSync(path.join(workspace, 'tasks', ledgerId, '.gitignore'))).toBe(false);
  });

  // W6 resume control (workflow): seed via store createAndAcquire/commit (invariants.test.ts:1703
  // precedent) — deterministic in-process non-terminal record with visits>=1; avoids SIGKILL child.
  it('W6: workflowResume with visits>=1 skips boundary; dirt and .gitignore untouched', async () => {
    const { acquireLease, commit, createAndAcquire, releaseLease } = await import('../kernel/store.js');
    const workspace = createTempRepo();
    repos.push(workspace);
    const workflowRunId = 'wf-w6-resume';
    const ledgerId = 'ledger-w6';
    const ignorePath = path.join(workspace, 'tasks', ledgerId, '.gitignore');
    fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
    fs.writeFileSync(ignorePath, '*\n');
    const ignoreStatBefore = fs.statSync(ignorePath);
    const ignoreBytesBefore = fs.readFileSync(ignorePath, 'utf8');

    const spec = autoloopWorkflowSpec(workspace, ledgerId);
    releaseLease(createAndAcquire(workflowRunId, spec as never, 'w6-seed'));
    const fixture = acquireLease(workflowRunId, 'w6-fixture');
    commit(fixture, {
      record: {
        runId: workflowRunId,
        workflow: 'wf-autoloop-fresh',
        spec,
        state: 'running',
        outcome: 'unverified',
        cwd: workspace,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: {
          loop: { id: 'loop', kind: 'autoloop', state: 'running', attempts: 1, visits: 1 },
        },
      } as never,
    });
    releaseLease(fixture);

    fs.writeFileSync(path.join(workspace, 'README.md'), '# dirt during resume\n');
    const dirtBytes = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');

    await mgr.workflowResume(workflowRunId);
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(ledgerId));
    }, 'W6 planner');

    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(dirtBytes);
    expect(fs.existsSync(ignorePath)).toBe(true);
    expect(fs.readFileSync(ignorePath, 'utf8')).toBe(ignoreBytesBefore);
    const ignoreStatAfter = fs.statSync(ignorePath);
    expect(ignoreStatAfter.ino).toBe(ignoreStatBefore.ino);
    expect(ignoreStatAfter.mtimeMs).toBe(ignoreStatBefore.mtimeMs);

    // Deleted .gitignore is not recreated on a further resume seed
    await mgr.shutdown();
    mgr = createManager();
    fs.rmSync(ignorePath, { force: true });
    expect(fs.existsSync(ignorePath)).toBe(false);
    const workflowRunId2 = 'wf-w6-resume-deleted';
    releaseLease(createAndAcquire(workflowRunId2, spec as never, 'w6-seed2'));
    const fixture2 = acquireLease(workflowRunId2, 'w6-fixture2');
    commit(fixture2, {
      record: {
        runId: workflowRunId2,
        workflow: 'wf-autoloop-fresh',
        spec,
        state: 'running',
        outcome: 'unverified',
        cwd: workspace,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: {
          loop: { id: 'loop', kind: 'autoloop', state: 'running', attempts: 1, visits: 1 },
        },
      } as never,
    });
    releaseLease(fixture2);
    await mgr.workflowResume(workflowRunId2);
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(ledgerId));
    }, 'W6b planner');
    expect(fs.existsSync(ignorePath)).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(dirtBytes);
  });

  // W7 resume control (direct)
  it('W7: autoloopResume after dirty + deleted .gitignore starts Planner without recreating ignore', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'direct-w7';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    const ignorePath = path.join(workspace, 'tasks', runId, '.gitignore');
    await mgr.autoloopStop(runId, 'w7-stop');
    await waitUntil(() => {
      try {
        const st = mgr.workflowStatus(runId).state;
        return st === 'completed' || st === 'cancelled' || st === 'failed';
      } catch {
        return false;
      }
    }, 'W7 stop terminal');

    fs.writeFileSync(path.join(workspace, 'README.md'), '# w7 dirt\n');
    const dirtBytes = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
    // Delete if present (PR head creates it; 5221a89 may not). Resume must not create one.
    fs.rmSync(ignorePath, { force: true });

    await mgr.autoloopResume(runId);
    await waitUntil(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mgr as any).sessions.has(plannerSessionName(runId));
    }, 'W7 planner after resume');
    expect(fs.existsSync(ignorePath)).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(dirtBytes);
  });

  // W8 dirty + retry
  it('W8: dirty node with retry max 1 refuses both attempts; zero Planner sessions', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), '# w8 dirty\n');
    const ledgerId = 'ledger-w8';
    const workflowRunId = 'wf-w8';
    await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerId, { retry: { max: 1, backoffMs: 1 } }), {
      runId: workflowRunId,
      cwd: workspace,
    });
    await waitUntil(() => mgr.workflowStatus(workflowRunId).state === 'failed', 'W8 fail');
    const failed = mgr.workflowStatus(workflowRunId);
    expect(failed.state).toBe('failed');
    expect(failed.nodes.loop.state).toBe('failed');
    expect(failed.nodes.loop.error ?? '').toMatch(/uncommitted changes/);
    expect(failed.nodes.loop.attempts).toBeGreaterThanOrEqual(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).sessions.has(plannerSessionName(ledgerId))).toBe(false);
  });

  // W9 config marker cannot disable fresh boundary
  it('W9: dirty node still refused when spec.config carries _freshStart: false', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), '# w9 dirty\n');
    for (const [suffix, extras] of [
      ['false', { _freshStart: false }],
      ['zero', { _freshStart: 0 }],
      ['str', { freshStart: false }],
      ['nested', { _freshStart: 'false' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const ledgerId = `ledger-w9-${suffix}`;
      const workflowRunId = `wf-w9-${suffix}`;
      await mgr.workflowStart(autoloopWorkflowSpec(workspace, ledgerId, { configExtras: extras }), {
        runId: workflowRunId,
        cwd: workspace,
      });
      await waitUntil(() => mgr.workflowStatus(workflowRunId).state === 'failed', `W9 ${suffix} fail`);
      const failed = mgr.workflowStatus(workflowRunId);
      expect(failed.nodes.loop.error ?? '').toMatch(/uncommitted changes/);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((mgr as any).sessions.has(plannerSessionName(ledgerId))).toBe(false);
    }
  });

  // Resume must ignore an injected `_freshStart: true` from spec.config or secrets:
  // the kernel-computed flag wins LAST. Reuses W6 store-seed (visits>=1, non-terminal).
  it('resume override: workflowResume ignores _freshStart:true from config and secrets on a dirty tree', async () => {
    const { acquireLease, commit, createAndAcquire, releaseLease } = await import('../kernel/store.js');

    const waitPlannerOrFail = async (
      workflowRunId: string,
      ledgerId: string,
      ignorePath: string,
      ignoreMode: 'existing' | 'deleted',
      timeoutMs = 8_000,
    ): Promise<void> => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const rec = mgr.workflowStatus(workflowRunId);
        const node = rec.nodes.loop;
        if (rec.state === 'failed' || node?.state === 'failed') {
          const detail = `run.state=${rec.state} run.error=${JSON.stringify(rec.error)} node.state=${node?.state} node.error=${JSON.stringify(node?.error)}`;
          expect(rec.state, detail).not.toBe('failed');
          expect(node?.state, detail).not.toBe('failed');
        }
        if (ignoreMode === 'deleted' && fs.existsSync(ignorePath)) {
          expect(fs.existsSync(ignorePath), 'gitignore recreated on resume').toBe(false);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((mgr as any).sessions.has(plannerSessionName(ledgerId))) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`timeout waiting for Planner after resume of ${workflowRunId}`);
    };

    const runCase = async (opts: {
      workflowRunId: string;
      ledgerId: string;
      via: 'config' | 'secrets';
      ignoreMode: 'existing' | 'deleted';
    }) => {
      const workspace = createTempRepo();
      repos.push(workspace);
      const ignorePath = path.join(workspace, 'tasks', opts.ledgerId, '.gitignore');
      fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
      fs.writeFileSync(ignorePath, '*\n');
      const ignoreStatBefore = opts.ignoreMode === 'existing' ? fs.statSync(ignorePath) : null;
      const ignoreBytesBefore = opts.ignoreMode === 'existing' ? fs.readFileSync(ignorePath, 'utf8') : null;
      if (opts.ignoreMode === 'deleted') {
        fs.rmSync(ignorePath, { force: true });
        expect(fs.existsSync(ignorePath)).toBe(false);
      }

      const configExtras = opts.via === 'config' ? { _freshStart: true } : {};
      const spec = autoloopWorkflowSpec(workspace, opts.ledgerId, { configExtras });
      releaseLease(createAndAcquire(opts.workflowRunId, spec as never, `seed-${opts.workflowRunId}`));
      const fixture = acquireLease(opts.workflowRunId, `fix-${opts.workflowRunId}`);
      commit(fixture, {
        record: {
          runId: opts.workflowRunId,
          workflow: 'wf-autoloop-fresh',
          spec,
          state: 'running',
          outcome: 'unverified',
          cwd: workspace,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          nodes: {
            loop: { id: 'loop', kind: 'autoloop', state: 'running', attempts: 1, visits: 1 },
          },
        } as never,
      });
      releaseLease(fixture);

      fs.writeFileSync(path.join(workspace, 'README.md'), `# dirt ${opts.workflowRunId}\n`);
      const dirtBytes = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
      const porcelainBefore = porcelainUntrackedAll(workspace);

      const resumeSecrets = opts.via === 'secrets' ? { _freshStart: true } : undefined;
      await mgr.workflowResume(opts.workflowRunId, resumeSecrets ? { secrets: resumeSecrets } : {});
      await waitPlannerOrFail(opts.workflowRunId, opts.ledgerId, ignorePath, opts.ignoreMode);

      expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe(dirtBytes);
      expect(porcelainUntrackedAll(workspace)).toBe(porcelainBefore);
      if (opts.ignoreMode === 'deleted') {
        expect(fs.existsSync(ignorePath)).toBe(false);
      } else {
        expect(fs.readFileSync(ignorePath, 'utf8')).toBe(ignoreBytesBefore);
        const after = fs.statSync(ignorePath);
        expect(after.ino).toBe(ignoreStatBefore!.ino);
        expect(after.mtimeMs).toBe(ignoreStatBefore!.mtimeMs);
      }

      await mgr.shutdown();
      mgr = createManager();
    };

    await runCase({
      workflowRunId: 'wf-resume-override-config',
      ledgerId: 'ledger-resume-override-config',
      via: 'config',
      ignoreMode: 'existing',
    });
    await runCase({
      workflowRunId: 'wf-resume-override-secrets',
      ledgerId: 'ledger-resume-override-secrets',
      via: 'secrets',
      ignoreMode: 'deleted',
    });
  }, 20_000);
});
