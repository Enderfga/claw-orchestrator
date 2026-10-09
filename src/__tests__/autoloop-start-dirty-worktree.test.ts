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

const { SessionManager, autoloopLedgerExcludePattern } = await import('../session-manager.js');
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

  it('hides the new run ledger from porcelain and git add -A via info/exclude', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-isolate-clean';
    const ledgerRel = `tasks/${runId}/`;
    const result = await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(result.runId).toBe(runId);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(true);

    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    const excludeBody = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    expect(excludeBody).toContain(`/${ledgerRel}`);

    // Ledger dir may be empty at start; a real artifact must stay out of status/add.
    const artifact = path.join(workspace, 'tasks', runId, 'goal.json');
    fs.writeFileSync(artifact, '{"scalar":null}\n');
    const afterPorcelain = porcelain(workspace);
    expect(afterPorcelain).not.toContain(ledgerRel);
    expect(afterPorcelain).not.toContain(`tasks/${runId}`);

    execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'pipe' });
    const staged = execFileSync('git', ['-C', workspace, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
    });
    expect(staged).not.toContain(`tasks/${runId}`);

    const checkIgnore = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', path.join('tasks', runId, 'goal.json')],
      { encoding: 'utf8' },
    );
    expect(checkIgnore).toContain('info/exclude');
    expect(checkIgnore).toContain(`/${ledgerRel}`);
  });

  it('writes only the shared git-path exclude for a linked worktree (.git file)', async () => {
    const main = createTempRepo();
    repos.push(main);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-wt-'));
    repos.push(wt);
    execFileSync('git', ['-C', main, 'worktree', 'add', wt, 'HEAD'], { stdio: 'pipe' });
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);

    const runId = 'ledger-isolate-wt';
    await mgr.autoloopStart({ runId, workspace: wt, plannerEngine: 'codex' });

    const wtExclude = path.resolve(
      wt,
      execFileSync('git', ['-C', wt, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    const mainExclude = path.resolve(
      main,
      execFileSync('git', ['-C', main, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    expect(fs.realpathSync(wtExclude)).toBe(fs.realpathSync(mainExclude));
    expect(fs.readFileSync(wtExclude, 'utf8')).toContain(`/tasks/${runId}/`);

    const sibling = path.join(wt, 'tasks', 'sibling-visible', 'notes.txt');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'visible\n');
    const detailed = execFileSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    expect(detailed).toContain('tasks/sibling-visible');
    expect(detailed).not.toContain(`tasks/${runId}`);
  });

  it('anchors the exclude under a nested workspace show-prefix', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo();
    repos.push(repoRoot);
    const runId = 'ledger-isolate-nested';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });

    const expected = autoloopLedgerExcludePattern('nested/pkg/', runId);
    expect(expected).toBe(`/nested/pkg/tasks/${runId}/`);
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    expect(fs.readFileSync(excludePath, 'utf8')).toContain(expected);

    const checkIgnore = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', path.join('tasks', runId, 'goal.json')],
      { encoding: 'utf8' },
    );
    expect(checkIgnore).toContain(expected);

    const porcelainRoot = porcelain(repoRoot);
    expect(porcelainRoot).not.toContain(`nested/pkg/tasks/${runId}`);

    const sibling = path.join(repoRoot, 'other', 'tasks', runId, 'notes.txt');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'outside workspace\n');
    const detailed = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    expect(detailed).toContain(`other/tasks/${runId}`);
  });

  it('escapes a pkg[1] show-prefix so only that ledger is ignored', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo(['nested', 'pkg[1]']);
    repos.push(repoRoot);
    const runId = 'ledger-isolate-bracket';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });

    const expected = autoloopLedgerExcludePattern('nested/pkg[1]/', runId);
    expect(expected).toBe(`/nested/pkg\\[1\\]/tasks/${runId}/`);
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    expect(fs.readFileSync(excludePath, 'utf8')).toContain(expected);

    const checkIgnore = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', path.join('tasks', runId, 'goal.json')],
      { encoding: 'utf8' },
    );
    expect(checkIgnore).toContain(expected);

    const siblingDir = path.join(repoRoot, 'nested', 'pkg1');
    const sibling = path.join(siblingDir, 'tasks', runId, 'goal.json');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, '{"scalar":null}\n');
    let siblingIgnored = true;
    try {
      execFileSync('git', ['-C', siblingDir, 'check-ignore', '-q', path.join('tasks', runId, 'goal.json')], {
        stdio: 'pipe',
      });
    } catch {
      siblingIgnored = false;
    }
    expect(siblingIgnored).toBe(false);
  });

  it('escapes a pkg* show-prefix so a sibling glob match stays visible', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo(['nested', 'pkg*']);
    repos.push(repoRoot);
    const runId = 'ledger-isolate-star';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });

    const expected = autoloopLedgerExcludePattern('nested/pkg*/', runId);
    expect(expected).toBe(`/nested/pkg\\*/tasks/${runId}/`);
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    expect(fs.readFileSync(excludePath, 'utf8')).toContain(expected);

    const checkIgnore = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', path.join('tasks', runId, 'goal.json')],
      { encoding: 'utf8' },
    );
    expect(checkIgnore).toContain(expected);

    const siblingDir = path.join(repoRoot, 'nested', 'pkgOTHER');
    const sibling = path.join(siblingDir, 'tasks', runId, 'goal.json');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, '{"scalar":null}\n');
    let siblingIgnored = true;
    try {
      execFileSync('git', ['-C', siblingDir, 'check-ignore', '-q', path.join('tasks', runId, 'goal.json')], {
        stdio: 'pipe',
      });
    } catch {
      siblingIgnored = false;
    }
    expect(siblingIgnored).toBe(false);
  });

  it('escapes special run ids so check-ignore matches only that ledger', () => {
    // Kernel run ids are [A-Za-z0-9._-]; the exclude helper still escapes the
    // broader segment alphabet the dirty-start ledger exception already allows.
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'run "1"*#![x';
    const pattern = autoloopLedgerExcludePattern('', runId);
    expect(pattern).toBe('/tasks/run\\ "1"\\*\\#\\!\\[x/');

    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    fs.appendFileSync(excludePath, `${pattern}\n`);
    fs.mkdirSync(path.join(workspace, 'tasks', runId), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'tasks', runId, 'goal.json'), '{"scalar":null}\n');
    fs.mkdirSync(path.join(workspace, 'tasks', 'run "1"OTHER'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'tasks', 'run "1"OTHER', 'notes.txt'), 'sibling\n');

    const checkIgnore = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', path.join('tasks', runId, 'goal.json')],
      { encoding: 'utf8' },
    );
    expect(checkIgnore).toContain('info/exclude');
    expect(checkIgnore).toContain(pattern);

    let siblingIgnored = true;
    try {
      execFileSync('git', ['-C', workspace, 'check-ignore', '-q', path.join('tasks', 'run "1"OTHER', 'notes.txt')], {
        stdio: 'pipe',
      });
    } catch {
      siblingIgnored = false;
    }
    expect(siblingIgnored).toBe(false);
    const detailed = execFileSync('git', ['-C', workspace, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    // Porcelain quotes paths that contain spaces/quotes.
    expect(detailed).toMatch(/tasks\/run .*OTHER/);
    expect(detailed).not.toContain(`*#![x`);
  });

  it('preserves seeded exclude bytes, appends one line, and does not duplicate on second setup', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const seed = '# keep-comment\n!important-negation\npartial-line';
    fs.writeFileSync(excludePath, seed);
    expect(seed.endsWith('\n')).toBe(false);

    const runId = 'ledger-isolate-seed';
    const pattern = `/tasks/${runId}/`;
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    const afterFirst = fs.readFileSync(excludePath, 'utf8');
    expect(afterFirst.startsWith(seed)).toBe(true);
    expect(afterFirst).toContain(pattern);
    expect(afterFirst.split('\n').filter((l) => l === pattern)).toHaveLength(1);

    // Pattern already present: a second setup must not duplicate or drop it.
    await mgr.shutdown();
    mgr = createManager();
    const runId2 = 'ledger-isolate-seed-2';
    const pattern2 = `/tasks/${runId2}/`;
    const withPattern2 = afterFirst.endsWith('\n') ? `${afterFirst}${pattern2}\n` : `${afterFirst}\n${pattern2}\n`;
    fs.writeFileSync(excludePath, withPattern2);
    expect(
      fs
        .readFileSync(excludePath, 'utf8')
        .split('\n')
        .filter((l) => l === pattern2),
    ).toHaveLength(1);

    await mgr.autoloopStart({ runId: runId2, workspace, plannerEngine: 'codex' });
    const afterSecond = fs.readFileSync(excludePath, 'utf8');
    expect(afterSecond.startsWith(seed)).toBe(true);
    expect(afterSecond.split('\n').filter((l) => l === pattern)).toHaveLength(1);
    expect(afterSecond.split('\n').filter((l) => l === pattern2)).toHaveLength(1);
  });

  it('appends after non-UTF-8 exclude bytes without rewriting the prefix', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const seed = Buffer.from([0x23, 0x20, 0x62, 0x69, 0x6e, 0xff, 0x21]); // "# bin\xff!" no trailing newline
    fs.writeFileSync(excludePath, seed);

    const runId = 'ledger-isolate-binary';
    const pattern = `/tasks/${runId}/`;
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    const afterFirst = fs.readFileSync(excludePath);
    expect(afterFirst.subarray(0, seed.length).equals(seed)).toBe(true);
    expect(afterFirst[seed.length]).toBe(0x0a);
    expect(afterFirst.subarray(seed.length + 1).equals(Buffer.from(`${pattern}\n`, 'utf8'))).toBe(true);

    await mgr.shutdown();
    mgr = createManager();
    await mgr.autoloopStart({ runId: 'ledger-isolate-binary-2', workspace, plannerEngine: 'codex' });
    const afterSecond = fs.readFileSync(excludePath);
    expect(afterSecond.subarray(0, seed.length).equals(seed)).toBe(true);
    const asLines = afterSecond.toString('latin1').split('\n');
    expect(asLines.filter((l) => l === pattern)).toHaveLength(1);
    expect(asLines.filter((l) => l === '/tasks/ledger-isolate-binary-2/')).toHaveLength(1);
  });

  it('resume leaves exclude unchanged when the ledger pattern is absent', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-isolate-resume-absent';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });

    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    const withoutPattern = Buffer.from('# resume-absent-seed\n');
    fs.writeFileSync(excludePath, withoutPattern);

    await mgr.autoloopStop(runId, 'test-stop');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).kernel.wait(runId);
    await mgr.shutdown();
    mgr = createManager();

    await mgr.autoloopResume(runId);
    expect(fs.readFileSync(excludePath).equals(withoutPattern)).toBe(true);
    expect(fs.readFileSync(excludePath, 'utf8')).not.toContain(`/tasks/${runId}/`);
  });

  it('resume with an unreadable exclude still returns and leaves bytes unchanged', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'ledger-isolate-resume-unreadable';
    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });

    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    const snapshot = fs.readFileSync(excludePath);
    fs.chmodSync(excludePath, 0o000);

    await mgr.autoloopStop(runId, 'test-stop');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).kernel.wait(runId);
    await mgr.shutdown();
    mgr = createManager();

    await expect(mgr.autoloopResume(runId)).resolves.toBeDefined();
    fs.chmodSync(excludePath, 0o644);
    expect(fs.readFileSync(excludePath).equals(snapshot)).toBe(true);
  });

  it('does not mutate info/exclude when dirty start is refused', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    // Absent exclude: refuse must not create the file.
    fs.rmSync(excludePath, { force: true });
    expect(fs.existsSync(excludePath)).toBe(false);

    fs.writeFileSync(path.join(workspace, 'README.md'), '# dirty\n');
    let thrown: unknown;
    try {
      await mgr.autoloopStart({ runId: 'refuse-no-exclude', workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, 'refuse-no-exclude', thrown);
    expect(fs.existsSync(excludePath)).toBe(false);

    const seeded = '# seeded-before-refuse\n';
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, seeded);
    fs.writeFileSync(path.join(workspace, 'untracked.txt'), 'still dirty\n');
    thrown = undefined;
    try {
      await mgr.autoloopStart({ runId: 'refuse-keep-exclude', workspace, plannerEngine: 'codex' });
    } catch (err) {
      thrown = err;
    }
    assertRejectedBeforeSideEffects(mgr, 'refuse-keep-exclude', thrown);
    expect(fs.readFileSync(excludePath, 'utf8')).toBe(seeded);
  });

  it('non-repository start creates neither .git nor an exclude file', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-dirty-start-norepo-exclude-'));
    repos.push(workspace);
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'not a git repo\n');

    await mgr.autoloopStart({ runId: 'norepo-no-exclude', workspace, plannerEngine: 'codex' });
    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.git', 'info', 'exclude'))).toBe(false);
    // Walk for any info/exclude under the workspace.
    const walk = (dir: string): string[] => {
      const found: string[] = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) found.push(...walk(p));
        else if (ent.name === 'exclude' && p.endsWith(`${path.sep}info${path.sep}exclude`)) found.push(p);
      }
      return found;
    };
    expect(walk(workspace)).toEqual([]);
  });
});
