/**
 * Real-git preflight for autoloopStart: refuse a dirty worktree before the
 * run directory or Planner session exists. Non-repository workspaces still start.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await mgr.shutdown();
    for (const dir of repos.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function excludePathOf(ws: string): string {
    return path.resolve(
      ws,
      execFileSync('git', ['-C', ws, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
  }

  function commitGitignore(ws: string, body: string): void {
    fs.writeFileSync(path.join(ws, '.gitignore'), body);
    execFileSync('git', ['add', '.gitignore'], { cwd: ws, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'gitignore'], { cwd: ws, stdio: 'pipe' });
  }

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
    expect(afterFirst.subarray(seed.length + 1).includes(Buffer.from('# clawo-pending:', 'utf8'))).toBe(true);
    expect(afterFirst.includes(Buffer.from(`${pattern}\n`, 'utf8'))).toBe(true);

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

  it('fails closed when a committed .gitignore negation defeats ledger exclude', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'negated-ledger';
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    // Preservation-first: mixed-negation preflight must refuse before any exclude mutate.
    const seed = Buffer.from('# keep\n', 'utf8');
    fs.writeFileSync(excludePath, seed);
    fs.writeFileSync(path.join(workspace, '.gitignore'), `!/tasks/${runId}/\n`);
    execFileSync('git', ['add', '.gitignore'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'gitignore negation'], { cwd: workspace, stdio: 'pipe' });
    const preStart = fs.readFileSync(excludePath);

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /could not isolate the run ledger/i,
    );
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
    expect(fs.readFileSync(excludePath).equals(preStart)).toBe(true);
    expect(fs.readFileSync(excludePath).equals(seed)).toBe(true);
  });

  it('negation preflight refuses before creating a missing exclude file', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'negated-no-create';
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    fs.rmSync(excludePath, { force: true });
    expect(fs.existsSync(excludePath)).toBe(false);
    fs.writeFileSync(path.join(workspace, '.gitignore'), `!/tasks/${runId}/\n`);
    execFileSync('git', ['add', '.gitignore'], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'gitignore negation no create'], { cwd: workspace, stdio: 'pipe' });

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /could not isolate the run ledger/i,
    );
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
    // Preservation-first: never create-then-unlink; the exclude stays absent.
    expect(fs.existsSync(excludePath)).toBe(false);
  });

  it('fails closed when show-prefix contains a real newline', async () => {
    const { repoRoot, workspace } = createNestedWorkspaceRepo(['pkg\npart']);
    repos.push(repoRoot);
    const runId = 'ledger-isolate-lf';
    const excludePath = path.resolve(
      workspace,
      execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf8',
      }).trim(),
    );
    const preStart = fs.readFileSync(excludePath);
    const prefix = execFileSync('git', ['-C', workspace, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
    }).replace(/\r?\n$/, '');
    expect(prefix).toContain('\n');

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /multiple exclude lines/i,
    );
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
    expect(fs.readFileSync(excludePath).equals(preStart)).toBe(true);
    expect(fs.readFileSync(excludePath).includes(Buffer.from('\\\n'))).toBe(false);
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

  // --- Preservation-first exclude isolation probes ---

  it('mixed directory negation plus ignored goal.json refuses before any exclude mutate', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'mixed-negation';
    const x = excludePathOf(workspace);
    commitGitignore(workspace, `!/tasks/${runId}/\n/tasks/${runId}/goal.json\n`);
    const seed = fs.readFileSync(x);

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /could not isolate the run ledger/i,
    );
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
    expect(fs.readFileSync(x).equals(seed)).toBe(true);
    expect(fs.existsSync(`${x}.clawo-autoloop.lock`)).toBe(false);
    expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toContain(`!/tasks/${runId}/`);
  });

  it('negation preflight does not open-for-write or create a lock beside exclude', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'negation-no-lock';
    const x = excludePathOf(workspace);
    commitGitignore(workspace, `!/tasks/${runId}/\n`);
    const seed = Buffer.from('# keep\n');
    fs.writeFileSync(x, seed);
    let openedForWrite = false;
    const openOriginal = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      if (String(p) === x) {
        const f = typeof flags === 'number' ? flags : 0;
        if (f & fs.constants.O_RDWR || f & fs.constants.O_WRONLY || f & fs.constants.O_APPEND) {
          openedForWrite = true;
        }
      }
      return (openOriginal as (path: fs.PathLike, flags: unknown, mode?: unknown) => number)(
        p as fs.PathLike,
        flags,
        mode,
      );
    }) as typeof fs.openSync);
    syncBuiltinESMExports();

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /could not isolate the run ledger/i,
    );
    expect(openedForWrite).toBe(false);
    expect(fs.readFileSync(x)).toEqual(seed);
    expect(fs.existsSync(`${x}.clawo-autoloop.lock`)).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('directory negation plus all three sentinels ignored still refuses (plan.md proof)', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'triple-sentinel';
    const x = excludePathOf(workspace);
    commitGitignore(
      workspace,
      [
        `!/tasks/${runId}/`,
        `/tasks/${runId}/goal.json`,
        `/tasks/${runId}/chat.jsonl`,
        `/tasks/${runId}/decisions.jsonl`,
        '',
      ].join('\n'),
    );
    const seed = fs.readFileSync(x);
    const ignoreBytes = fs.readFileSync(path.join(workspace, '.gitignore'));

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /could not isolate the run ledger/i,
    );
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
    expect(fs.readFileSync(x).equals(seed)).toBe(true);
    expect(fs.readFileSync(path.join(workspace, '.gitignore')).equals(ignoreBytes)).toBe(true);

    // Demonstrate the staging hole a finite sentinel check would miss.
    fs.mkdirSync(path.join(workspace, 'tasks', runId, 'iter', '0'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'tasks', runId, 'goal.json'), '{}\n');
    fs.writeFileSync(path.join(workspace, 'tasks', runId, 'chat.jsonl'), '{}\n');
    fs.writeFileSync(path.join(workspace, 'tasks', runId, 'decisions.jsonl'), '{}\n');
    fs.writeFileSync(path.join(workspace, 'tasks', runId, 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(workspace, 'tasks', runId, 'iter', '0', 'verdict.json'), '{}\n');
    fs.appendFileSync(x, `/tasks/${runId}/\n`);
    expect(() =>
      execFileSync('git', ['-C', workspace, 'check-ignore', '-q', path.join('tasks', runId, 'goal.json')], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
    execFileSync('git', ['-C', workspace, 'add', '-A'], { stdio: 'pipe' });
    const staged = execFileSync('git', ['-C', workspace, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
    });
    expect(staged).toMatch(/plan\.md/);
    expect(staged).toMatch(/iter\//);
  });

  it('O_APPEND preserves concurrent raced bytes and non-UTF-8 prefix; no lock file', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'oappend-race';
    const x = excludePathOf(workspace);
    const seed = Buffer.from([0xff, 0xfe, 0x01, 0x0a]); // non-UTF-8 prefix + LF
    fs.writeFileSync(x, seed);
    const raced = Buffer.from('# raced append before our write\n');
    let injected = false;
    const openOriginal = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      const fd = (openOriginal as (path: fs.PathLike, flags: unknown, mode?: unknown) => number)(
        p as fs.PathLike,
        flags,
        mode,
      );
      if (String(p) === x && !injected) {
        injected = true;
        execFileSync(process.execPath, [
          '-e',
          "require('node:fs').appendFileSync(process.argv[1], process.argv[2])",
          x,
          raced.toString(),
        ]);
      }
      return fd;
    }) as typeof fs.openSync);
    syncBuiltinESMExports();

    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(injected).toBe(true);
    const body = fs.readFileSync(x);
    expect(body.subarray(0, seed.length).equals(seed)).toBe(true);
    expect(body.includes(raced)).toBe(true);
    const racedAt = body.indexOf(raced);
    const patternAt = body.indexOf(Buffer.from(`/tasks/${runId}/`));
    expect(racedAt).toBeGreaterThanOrEqual(seed.length);
    expect(patternAt).toBeGreaterThan(racedAt);
    expect(fs.existsSync(`${x}.clawo-autoloop.lock`)).toBe(false);
    const ignoreOut = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', '--', path.join('tasks', runId, 'plan.md')],
      { encoding: 'utf8' },
    );
    expect(ignoreOut).toContain(`/tasks/${runId}/`);
  });

  it('preserves a concurrent append without a trailing LF as an effective ignore rule', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'oappend-race-no-lf';
    const x = excludePathOf(workspace);
    const seed = Buffer.from('# seed\n');
    const racedRule = Buffer.from('/private/');
    fs.writeFileSync(x, seed);

    const openOriginal = fs.openSync.bind(fs);
    const writeOriginal = fs.writeSync.bind(fs);
    let excludeFd: number | undefined;
    let injected = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      const opened = (openOriginal as (...args: unknown[]) => number)(p, flags, mode);
      if (String(p) === x && excludeFd === undefined) excludeFd = opened;
      return opened;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
      if (args[0] === excludeFd && !injected) {
        execFileSync(process.execPath, [
          '-e',
          "require('node:fs').appendFileSync(process.argv[1], process.argv[2])",
          x,
          racedRule.toString(),
        ]);
        injected = true;
      }
      return (writeOriginal as (...inner: unknown[]) => number)(...args);
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();

    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(injected).toBe(true);
    const body = fs.readFileSync(x);
    expect(body.indexOf(racedRule)).toBe(seed.length);

    const privateFile = path.join(workspace, 'private', 'secret.txt');
    fs.mkdirSync(path.dirname(privateFile), { recursive: true });
    fs.writeFileSync(privateFile, 'secret\n');
    expect(() =>
      execFileSync('git', ['-C', workspace, 'check-ignore', '-q', '--', path.join('private', 'secret.txt')], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
    expect(() =>
      execFileSync('git', ['-C', workspace, 'check-ignore', '-q', '--', path.join('tasks', runId, 'plan.md')], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('short write failure leaves only an inert comment and never a broad active rule', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'short-write-partial';
    const x = excludePathOf(workspace);
    const seed = Buffer.from('# original no LF');
    fs.writeFileSync(x, seed);
    const openOriginal = fs.openSync.bind(fs);
    let excludeFd: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      const opened = (openOriginal as (...args: unknown[]) => number)(p, flags, mode);
      if (String(p) === x) excludeFd = opened;
      return opened;
    }) as typeof fs.openSync);
    const writeOriginal = fs.writeSync.bind(fs);
    let writes = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
      if (args[0] === excludeFd) {
        writes++;
        if (writes === 1) {
          const buf = args[1] as Buffer;
          const offset = typeof args[2] === 'number' ? args[2] : 0;
          const length = typeof args[3] === 'number' ? args[3] : buf.length - offset;
          const position = args[4] as number | null | undefined;
          return writeOriginal(
            args[0] as number,
            buf,
            offset,
            Math.min(8, length),
            position === undefined ? null : position,
          );
        }
        throw Object.assign(new Error('ENOSPC on second write'), { code: 'ENOSPC' });
      }
      return (writeOriginal as (...a: unknown[]) => number)(...args);
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /inert partial comment/i,
    );
    expect(writes).toBe(1);
    const body = fs.readFileSync(x);
    expect(body.subarray(0, seed.length).equals(seed)).toBe(true);
    expect(body.subarray(seed.length, seed.length + 2).equals(Buffer.from('\n#'))).toBe(true);
    expect(() =>
      execFileSync('git', ['-C', workspace, 'check-ignore', '-q', 'tasks/unrelated/file'], {
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('accepts an existing broader positive info/exclude rule without mutating it', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'already-covered';
    const x = excludePathOf(workspace);
    const seed = Buffer.from('/tasks/\n');
    fs.writeFileSync(x, seed);

    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(fs.readFileSync(x)).toEqual(seed);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(true);
  });

  it('refuses an existing tracked ledger before claiming whole-ledger isolation', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'tracked-ledger';
    const tracked = path.join(workspace, 'tasks', runId, 'goal.json');
    fs.mkdirSync(path.dirname(tracked), { recursive: true });
    fs.writeFileSync(tracked, '{}\n');
    execFileSync('git', ['add', '--', path.join('tasks', runId, 'goal.json')], { cwd: workspace, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'tracked ledger fixture'], { cwd: workspace, stdio: 'pipe' });

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(/tracked files/i);
    expect(fs.readFileSync(tracked, 'utf8')).toBe('{}\n');
  });

  it('missing-file race: O_EXCL does not overwrite caller-created exclude prefix', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'creation-race';
    const x = excludePathOf(workspace);
    fs.rmSync(x, { force: true });
    const bytes = Buffer.from('# new caller ignore rules\n');
    let injected = false;
    const inject = (): void => {
      if (injected) return;
      injected = true;
      execFileSync(process.execPath, [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        x,
        bytes.toString(),
      ]);
    };
    const lstatOriginal = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, opts?: unknown) => {
      try {
        return (lstatOriginal as (path: fs.PathLike, opts?: unknown) => fs.Stats)(p as fs.PathLike, opts);
      } catch (err) {
        if (String(p) === x) inject();
        throw err;
      }
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();

    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    expect(injected).toBe(true);
    expect(fs.readFileSync(x).subarray(0, bytes.length)).toEqual(bytes);
    expect(fs.readFileSync(x).includes(Buffer.from(`/tasks/${runId}/`))).toBe(true);
  });

  it('dangling exclude symlink is refused without creating or truncating the target', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'dangling-link';
    const x = excludePathOf(workspace);
    const target = path.join(workspace, 'user-owned-output');
    fs.rmSync(x, { force: true });
    fs.symlinkSync(target, x);

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(x).isSymbolicLink()).toBe(true);
  });

  it('opened exclude inode mismatch against prior lstat refuses without mutating caller bytes', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'inode-mismatch';
    const x = excludePathOf(workspace);
    const seed = Buffer.from('# original inode\n');
    fs.writeFileSync(x, seed);
    const replacement = Buffer.from('# replacement inode contents\n');
    let swapped = false;
    const lstatOriginal = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, opts?: unknown) => {
      const st = (lstatOriginal as (path: fs.PathLike, opts?: unknown) => fs.Stats)(p as fs.PathLike, opts);
      if (String(p) === x && !swapped) {
        swapped = true;
        execFileSync(process.execPath, [
          '-e',
          "const fs=require('node:fs');fs.renameSync(process.argv[1],process.argv[1]+'.old');fs.writeFileSync(process.argv[1],process.argv[2])",
          x,
          replacement.toString(),
        ]);
      }
      return st;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /refuse|unsafe|isolate|exclude|inode/i,
    );
    expect(swapped).toBe(true);
    expect(fs.readFileSync(x)).toEqual(replacement);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('injected fstat failure after open closes the exclude fd', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'fstat-close';
    const x = excludePathOf(workspace);
    fs.writeFileSync(x, Buffer.from('# seed\n'));
    const openOriginal = fs.openSync.bind(fs);
    let excludeFd: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      const opened = (openOriginal as (...args: unknown[]) => number)(p, flags, mode);
      if (String(p) === x) excludeFd = opened;
      return opened;
    }) as typeof fs.openSync);
    const closeOriginal = fs.closeSync.bind(fs);
    const closed = new Set<number>();
    vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
      closed.add(fd);
      return closeOriginal(fd);
    }) as typeof fs.closeSync);
    const fstatOriginal = fs.fstatSync.bind(fs);
    let hit = false;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: unknown, opts?: unknown) => {
      if (fd === excludeFd && !hit) {
        hit = true;
        throw Object.assign(new Error('injected fstat failure'), { code: 'EIO' });
      }
      return (fstatOriginal as (fd: number, opts?: unknown) => fs.Stats)(fd as number, opts);
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow();
    expect(hit).toBe(true);
    expect(excludeFd).toBeDefined();
    expect(closed.has(excludeFd!)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('injected read failure after open closes the exclude fd', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'read-close';
    const x = excludePathOf(workspace);
    fs.writeFileSync(x, Buffer.from('# seed with content\n'));
    const openOriginal = fs.openSync.bind(fs);
    let excludeFd: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      const opened = (openOriginal as (...args: unknown[]) => number)(p, flags, mode);
      if (String(p) === x) excludeFd = opened;
      return opened;
    }) as typeof fs.openSync);
    const closeOriginal = fs.closeSync.bind(fs);
    const closed = new Set<number>();
    vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
      closed.add(fd);
      return closeOriginal(fd);
    }) as typeof fs.closeSync);
    const readOriginal = fs.readSync.bind(fs);
    let hit = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: unknown[]) => {
      if (args[0] === excludeFd && !hit) {
        hit = true;
        throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      }
      return (readOriginal as (...a: unknown[]) => number)(...args);
    }) as typeof fs.readSync);
    syncBuiltinESMExports();

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow();
    expect(hit).toBe(true);
    expect(excludeFd).toBeDefined();
    expect(closed.has(excludeFd!)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('never calls ftruncateSync or unlinkSync on the exclude path during failed isolation', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'no-destructive-cleanup';
    const x = excludePathOf(workspace);
    commitGitignore(workspace, `!/tasks/${runId}/\n`);
    const seed = Buffer.from('# original\n');
    fs.writeFileSync(x, seed);
    const openOriginal = fs.openSync.bind(fs);
    const excludeFds = new Set<number>();
    vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, flags: unknown, mode?: unknown) => {
      const opened = (openOriginal as (...args: unknown[]) => number)(p, flags, mode);
      if (String(p) === x) excludeFds.add(opened);
      return opened;
    }) as typeof fs.openSync);
    let truncated = false;
    let unlinked = false;
    const ftruncateOriginal = fs.ftruncateSync.bind(fs);
    vi.spyOn(fs, 'ftruncateSync').mockImplementation(((fd: unknown, len?: unknown) => {
      if (excludeFds.has(fd as number)) truncated = true;
      return ftruncateOriginal(fd as number, len as number | undefined);
    }) as typeof fs.ftruncateSync);
    const unlinkOriginal = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: unknown) => {
      if (String(p) === x) unlinked = true;
      return unlinkOriginal(p as fs.PathLike);
    }) as typeof fs.unlinkSync);
    syncBuiltinESMExports();

    await expect(mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' })).rejects.toThrow(
      /could not isolate the run ledger/i,
    );
    expect(truncated).toBe(false);
    expect(unlinked).toBe(false);
    expect(fs.readFileSync(x)).toEqual(seed);
    expect(fs.existsSync(path.join(workspace, 'tasks', runId))).toBe(false);
  });

  it('retry after partial residue appends a fresh newline+full rule', async () => {
    const workspace = createTempRepo();
    repos.push(workspace);
    const runId = 'retry-residue';
    const x = excludePathOf(workspace);
    const seed = Buffer.from('# seed\n');
    const residue = Buffer.from('#tasks/retry-resi'); // inert incomplete prior attempt
    fs.writeFileSync(x, Buffer.concat([seed, residue]));

    await mgr.autoloopStart({ runId, workspace, plannerEngine: 'codex' });
    const body = fs.readFileSync(x);
    expect(body.subarray(0, seed.length).equals(seed)).toBe(true);
    expect(body.includes(residue)).toBe(true);
    expect(body.includes(Buffer.from(`\n/tasks/${runId}/\n`))).toBe(true);
    const ignoreOut = execFileSync(
      'git',
      ['-C', workspace, 'check-ignore', '-v', '--', path.join('tasks', runId, 'plan.md')],
      { encoding: 'utf8' },
    );
    expect(ignoreOut).toContain(`/tasks/${runId}/`);
  });
});
