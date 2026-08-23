/**
 * Runtime invariants — the harness that does NOT stub node executors.
 *
 * Every other test in this suite that exercises a mode replaces the kernel's
 * executor with a fake and then asserts on the spec that reached it. That
 * proves the spec's shape and nothing else, and it is how five real defects
 * shipped with 1203 tests green: the fan-out adapter dropped every per-agent
 * field, so an ultrareview that carefully built `permissionMode: 'plan'` and a
 * bespoke prompt per reviewer handed the session neither — every reviewer got
 * the shared task under `bypassPermissions`. A read-only review that can write.
 *
 * So this file goes the whole way down: real public API → real kernel → real
 * node executor → real Council/Fanout → a fake `ISession`. The only thing that
 * is not real is the engine subprocess, and the fake records exactly what it was
 * asked to do so the assertions can be about behaviour rather than intent.
 *
 * Rule for this file: never call `setExecutor`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import type { ISession, SessionConfig } from '../types.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-inv-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAWO_WF_DIR = path.join(HOME, 'wf');
const { SessionManager } = await import('../session-manager.js');
type SessionManager = InstanceType<typeof SessionManager>;

/** What a session was actually asked to do. */
interface Observed {
  config: Partial<SessionConfig>;
  messages: string[];
}

let observed: Observed[] = [];
let mgr: SessionManager;
let wfDir: string;

/**
 * A fake engine session.
 *
 * It records its config and every message, and — critically for the read-only
 * assertions — writes to the working directory when its permission mode allows
 * it to. That turns "was the flag forwarded" into "did the agent get to write",
 * which is the question that actually matters.
 */
class FakeSession extends EventEmitter implements Partial<ISession> {
  sessionId = `fake-${Math.random().toString(36).slice(2, 8)}`;
  private stats = {
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
  };
  constructor(private readonly config: Partial<SessionConfig>) {
    super();
  }
  async start(): Promise<unknown> {
    return this;
  }
  async send(message: string): Promise<{ output: string; events: never[] }> {
    this.stats.turns++;
    this.stats.turnsSucceeded++;
    const record = observed.find((o) => o.config.name === this.config.name);
    record?.messages.push(message);
    // An agent that is allowed to write, writes. `plan` must not be able to.
    if (this.config.permissionMode !== 'plan' && this.config.cwd) {
      try {
        fs.appendFileSync(path.join(this.config.cwd, 'AGENT-WROTE-HERE.txt'), `${this.config.name}\n`);
      } catch {
        /* directory may be gone */
      }
    }
    return { output: `[${this.config.name}] ok\n[CONSENSUS: YES]`, events: [] };
  }
  stop(): void {}
  getStats(): typeof this.stats {
    return { ...this.stats };
  }
  getCost(): { totalCostUsd: number; totalUsd: number } {
    return { totalCostUsd: 0, totalUsd: 0 };
  }
  getHistory(): never[] {
    return [];
  }
  isReady(): boolean {
    return true;
  }
}

function makeManager(): SessionManager {
  const m = new SessionManager({ logger: { info() {}, warn() {}, error() {}, debug() {} } as never });
  // The one seam: no real engine subprocess. Everything above it — startSession,
  // the kernel, the node executors, Council and Fanout — is production code.
  (m as unknown as { _createSession: (engine: string, c: Partial<SessionConfig>) => ISession })._createSession = (
    _engine,
    config,
  ) => {
    observed.push({ config, messages: [] });
    return new FakeSession(config) as unknown as ISession;
  };
  return m;
}

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-inv-repo-'));
  const git = (...a: string[]): void => {
    execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  return dir;
}

/** Every file the run store wrote for a run, as text. */
function runFiles(runId: string): string[] {
  const dir = path.join(wfDir, runId);
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

beforeEach(() => {
  observed = [];
  wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-inv-wf-'));
  process.env.CLAWO_WF_DIR = wfDir;
  mgr = makeManager();
});

afterEach(async () => {
  await mgr.shutdown();
  fs.rmSync(wfDir, { recursive: true, force: true });
});

// ─── 1. Every legacy field reaches the session ──────────────────────────────

describe('the legacy API contract survives the adapter', () => {
  it('fan-out delivers each agent its own prompt, engine, model, and permission mode', async () => {
    const cwd = gitRepo();
    const fan = await mgr.fanoutStart({
      task: 'SHARED TASK',
      projectDir: cwd,
      agents: [
        { name: 'alpha', engine: 'codex', model: 'm-alpha', prompt: 'ALPHA PROMPT', permissionMode: 'plan' },
        { name: 'beta', engine: 'claude', model: 'm-beta', prompt: 'BETA PROMPT' },
      ],
      maxTurnsPerAgent: 7,
      maxBudgetUsd: 1.25,
    });
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(fan.id);

    const alpha = observed.find((o) => o.config.name?.endsWith('-alpha'))!;
    const beta = observed.find((o) => o.config.name?.endsWith('-beta'))!;

    expect(alpha.config).toMatchObject({ engine: 'codex', model: 'm-alpha', permissionMode: 'plan' });
    expect(beta.config).toMatchObject({ engine: 'claude', model: 'm-beta' });
    expect(alpha.config.maxTurns).toBe(7);
    expect(alpha.config.maxBudgetUsd).toBe(1.25);
    // The per-agent prompt, not the shared task.
    expect(alpha.messages[0]).toBe('ALPHA PROMPT');
    expect(beta.messages[0]).toBe('BETA PROMPT');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('council delivers persona, engine, model, effort, and budget', { timeout: 60_000 }, async () => {
    const cwd = gitRepo();
    const council = await mgr.councilStart('build it', {
      agents: [{ name: 'arch', emoji: '', persona: 'ARCH PERSONA', engine: 'codex', model: 'm1', effort: 'high' }],
      maxRounds: 1,
      projectDir: cwd,
      maxTurnsPerAgent: 9,
      maxBudgetUsd: 2.5,
    });
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(council.id);

    const arch = observed.find((o) => o.config.name?.includes('arch'))!;
    expect(arch.config).toMatchObject({ engine: 'codex', model: 'm1', effort: 'high' });
    expect(arch.config.maxTurns).toBe(9);
    expect(arch.config.maxBudgetUsd).toBe(2.5);
    // The persona reaches the agent through its system prompt, not the message.
    expect(String(arch.config.appendSystemPrompt ?? '')).toContain('ARCH PERSONA');

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── 2. Read-only really is read-only ───────────────────────────────────────

describe('ultrareview is read-only', () => {
  it('gives every reviewer its own specialist prompt, not the shared task', async () => {
    const cwd = gitRepo();
    const review = await mgr.ultrareviewStart(cwd, { agentCount: 3 });
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(review.id);

    const reviewers = observed.filter((o) => !o.config.name?.endsWith('-synthesis'));
    expect(reviewers.length).toBe(3);
    const firstLines = reviewers.map((r) => r.messages[0]?.split('\n')[0]);
    expect(new Set(firstLines).size).toBe(3);
    expect(firstLines.some((l) => /security expert/i.test(l ?? ''))).toBe(true);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('does not let a reviewer write to the code it is reviewing', async () => {
    // Adversarial: the fake session writes a file whenever its permission mode
    // allows it. If `plan` stops reaching the session, this file appears.
    const cwd = gitRepo();
    const review = await mgr.ultrareviewStart(cwd, { agentCount: 2 });
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(review.id);

    const reviewers = observed.filter((o) => !o.config.name?.endsWith('-synthesis'));
    expect(reviewers.every((r) => r.config.permissionMode === 'plan')).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'AGENT-WROTE-HERE.txt'))).toBe(false);

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── 3. Secrets never reach disk ────────────────────────────────────────────

describe('credentials stay in memory', () => {
  const SECRET = 'sk-do-not-persist-me';

  it('keeps a fan-out agent custom-engine config out of every run file', async () => {
    const cwd = gitRepo();
    const fan = await mgr.fanoutStart({
      task: 't',
      projectDir: cwd,
      agents: [
        {
          name: 'a',
          engine: 'custom',
          customEngine: { name: 'c', bin: 'c', args: {}, env: { API_TOKEN: SECRET } } as never,
        },
      ],
    });
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(fan.id);

    // It reached the session…
    expect(observed[0].config.customEngine).toMatchObject({ env: { API_TOKEN: SECRET } });
    // …and none of the run's files.
    for (const body of runFiles(fan.id)) expect(body).not.toContain(SECRET);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('keeps an autoloop custom-engine config out of spec.json', async () => {
    await mgr
      .autoloopStart({
        runId: 'secret-autoloop',
        workspace: os.tmpdir(),
        plannerEngine: 'custom',
        plannerCustomEngine: { name: 'p', bin: 'p', args: {}, env: { API_TOKEN: SECRET } } as never,
      })
      .catch(() => undefined);
    for (const body of runFiles('secret-autoloop')) expect(body).not.toContain(SECRET);
  });
});

// ─── 4. Cancel never becomes completed ──────────────────────────────────────

describe('cancellation', () => {
  it('a cancelled run is cancelled, whatever the node returned', async () => {
    const cwd = gitRepo();
    const fan = await mgr.fanoutStart({ task: 't', projectDir: cwd, agents: [{ name: 'a' }, { name: 'b' }] });
    mgr.fanoutAbort(fan.id);
    const done = (await (mgr as unknown as { kernel: { wait(id: string): Promise<{ state: string }> } }).kernel.wait(
      fan.id,
    ))!;
    expect(done.state).toBe('cancelled');
    expect(done.state).not.toBe('completed');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── 5. A verdict expires when the tree moves under it ──────────────────────

describe('verification barrier', () => {
  it('expires when a file that was ALREADY dirty is changed again', async () => {
    // The case the first fix missed: `git status --porcelain` reports a file's
    // state, not its bytes, so a file already `M` before the checks and
    // rewritten afterwards produced an identical digest.
    const cwd = gitRepo();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'DIRTY BEFORE VERIFY\n');

    const record = await mgr.workflowStart(
      {
        name: 'barrier',
        cwd,
        nodes: [
          { id: 'verify', kind: 'verifier', contract: 'run' },
          { id: 'after', kind: 'agent', prompt: 'edit the same file again', cwd },
        ],
      },
      { cwd, contract: { checks: [{ type: 'command', cmd: 'true' }] } },
    );
    const done = (await (
      mgr as unknown as { kernel: { wait(id: string): Promise<{ outcome: string; outcomeReason?: string }> } }
    ).kernel.wait(record.runId))!;

    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('DIRTY BEFORE VERIFY\n');
    // The agent node wrote its marker file, so the tree moved after the checks.
    expect(fs.existsSync(path.join(cwd, 'AGENT-WROTE-HERE.txt'))).toBe(true);
    expect(done.outcome).toBe('unverified');
    expect(done.outcomeReason).toMatch(/changed afterwards/);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('refuses a contract with nothing recognisable rather than silently not checking', async () => {
    await expect(
      mgr.workflowStart(
        { name: 'x', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'go' }] },
        { contract: { checks: [{ type: 'nonsense' }] } },
      ),
    ).rejects.toThrow(/no recognised checks/);
  });
});

// ─── 6. Malformed workflows are refused before they run ─────────────────────

describe('spec validation', () => {
  const start = (nodes: unknown[], extra: Record<string, unknown> = {}) =>
    mgr.workflowStart({ name: 'v', cwd: os.tmpdir(), nodes, ...extra } as never);

  it('rejects duplicate node ids', async () => {
    await expect(
      start([
        { id: 'a', kind: 'agent', prompt: 'x' },
        { id: 'a', kind: 'agent', prompt: 'y' },
      ]),
    ).rejects.toThrow(/duplicate node id/);
  });

  it('rejects a next that points nowhere', async () => {
    await expect(start([{ id: 'a', kind: 'agent', prompt: 'x', next: 'ghost' }])).rejects.toThrow(/unknown node/);
  });

  it('rejects a router target that points nowhere', async () => {
    await expect(
      start([{ id: 'r', kind: 'router', routes: [{ when: { type: 'always' }, to: 'ghost' }] }]),
    ).rejects.toThrow(/unknown node/);
  });

  it('rejects nonsense retry and visit bounds', async () => {
    await expect(start([{ id: 'a', kind: 'agent', prompt: 'x', retry: { max: -1 } }])).rejects.toThrow(/retry.max/);
    await expect(start([{ id: 'a', kind: 'agent', prompt: 'x' }], { maxNodeVisits: 0 })).rejects.toThrow(
      /maxNodeVisits/,
    );
  });

  it('rejects an empty workflow', async () => {
    await expect(start([])).rejects.toThrow(/no nodes/);
  });
});

// ─── 7. Crash recovery, with a real process death ───────────────────────────

describe('crash recovery', () => {
  const DIST = path.resolve('dist/src');

  /** Run a snippet in a real child node process. */
  function child(src: string, opts: { detached?: boolean } = {}): ReturnType<typeof spawn> {
    return spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, CLAWO_WF_DIR: wfDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: opts.detached,
    });
  }

  it('resumes after SIGKILL without re-running a node that already succeeded', async () => {
    const marker = path.join(wfDir, 'side-effects.log');
    const src = `
      const fs = await import('node:fs');
      const { RunKernel } = await import(${JSON.stringify(`${DIST}/kernel/engine.js`)});
      const k = new RunKernel({ nodeTimeoutMs: 60000 });
      k.setExecutor('agent', async (node) => {
        fs.appendFileSync(${JSON.stringify(marker)}, node.id + String.fromCharCode(10));
        if (node.id === 'second') { console.log('READY'); await new Promise(() => {}); }
        return { ok: true };
      });
      await k.start({
        name: 'crash', cwd: ${JSON.stringify(os.tmpdir())},
        nodes: [
          { id: 'first',  kind: 'agent', prompt: 'a' },
          { id: 'second', kind: 'agent', prompt: 'b' },
          { id: 'third',  kind: 'agent', prompt: 'c' },
        ],
      }, { runId: 'crash-run' });
      await new Promise(() => {});
    `;
    const proc = child(src);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('child never reached the second node')), 25_000);
      proc.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('READY')) {
          clearTimeout(t);
          resolve();
        }
      });
      proc.stderr!.on('data', (d: Buffer) => reject(new Error(`child stderr: ${d.toString().slice(0, 400)}`)));
      proc.on('error', reject);
    });
    proc.kill('SIGKILL');
    await new Promise((r) => proc.on('exit', r));

    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['first', 'second']);

    // Resume in THIS process. `first` already succeeded and must not run again;
    // `second` was in flight and is retried, because a half-finished node left
    // no result to trust.
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 10_000 });
    const ran: string[] = [];
    kernel.setExecutor('agent', async (node) => {
      ran.push(node.id);
      return { ok: true };
    });
    await kernel.resume('crash-run');
    const done = await kernel.wait('crash-run');

    expect(ran).toEqual(['second', 'third']);
    expect(done!.state).toBe('completed');
  }, 60_000);

  it('refuses a second owner while one is alive', async () => {
    const src = `
      const { RunKernel } = await import(${JSON.stringify(`${DIST}/kernel/engine.js`)});
      const k = new RunKernel({ nodeTimeoutMs: 60000 });
      k.setExecutor('agent', async () => { console.log('READY'); await new Promise(() => {}); });
      await k.start({ name: 'owned', cwd: ${JSON.stringify(os.tmpdir())},
        nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] }, { runId: 'owned-run' });
      await new Promise(() => {});
    `;
    const proc = child(src);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('child never started')), 25_000);
        proc.stdout!.on('data', (d: Buffer) => {
          if (d.toString().includes('READY')) {
            clearTimeout(t);
            resolve();
          }
        });
        proc.on('error', reject);
      });

      const { RunKernel } = await import('../kernel/engine.js');
      const kernel = new RunKernel();
      kernel.setExecutor('agent', async () => ({ ok: true }));
      // Two owners executing the same nodes would mean every side effect twice.
      await expect(kernel.resume('owned-run')).rejects.toThrow(/owned by pid/);
    } finally {
      proc.kill('SIGKILL');
      await new Promise((r) => proc.on('exit', r));
    }
  }, 60_000);

  it('lets the next process take over once the owner is gone', async () => {
    const { acquireLease, leaseIsStale, readLease } = await import('../kernel/store.js');
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async () => ({ ok: true }));
    const rec = await kernel.start({
      name: 'takeover',
      cwd: os.tmpdir(),
      nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }],
    });
    await kernel.wait(rec.runId);

    // A lease from a pid that cannot exist is stale immediately — the owner is
    // demonstrably gone, so the run should not wait out the TTL.
    const { atomicWriteJson, runDir } = await import('../kernel/store.js');
    atomicWriteJson(path.join(runDir(rec.runId), 'lease.json'), {
      pid: 2 ** 30,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
    });
    expect(leaseIsStale(readLease(rec.runId))).toBe(true);
    expect(() => acquireLease(rec.runId)).not.toThrow();
  });
});

// ─── 8. The boundary holds under the cases that broke it ────────────────────

describe('single owner, enforced', () => {
  it('two racers cannot both acquire — one is refused, not made a co-owner', async () => {
    const { acquireLease, createRunDir } = await import('../kernel/store.js');
    createRunDir('race-run', { name: 'x', nodes: [] } as never);
    const first = acquireLease('race-run');
    // A different live pid, so this is a genuine second claimant.
    const { atomicWriteJson, runDir } = await import('../kernel/store.js');
    atomicWriteJson(path.join(runDir('race-run'), 'lease.json'), { ...first, pid: 1 });
    expect(() => acquireLease('race-run')).toThrow(/owned by pid 1/);
  });

  it('does not declare a live local owner stale for going quiet', async () => {
    // A run executing one long node makes no checkpoints. Judging it dead for
    // that reason is precisely how two owners end up running the same work.
    const { leaseIsStale } = await import('../kernel/store.js');
    expect(
      leaseIsStale({
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
        renewedAt: new Date(Date.now() - 3_600_000).toISOString(),
        fence: 1,
      }),
    ).toBe(false);
  });

  it('bumps the fence on takeover so the previous holder can tell it lost', async () => {
    const { acquireLease, createRunDir, holdsLease, atomicWriteJson, runDir } = await import('../kernel/store.js');
    createRunDir('fence-run', { name: 'x', nodes: [] } as never);
    const mine = acquireLease('fence-run');
    expect(holdsLease('fence-run', mine.fence)).toBe(true);

    // Someone else takes over.
    atomicWriteJson(path.join(runDir('fence-run'), 'lease.json'), {
      ...mine,
      pid: 1,
      fence: mine.fence + 1,
    });
    expect(holdsLease('fence-run', mine.fence)).toBe(false);
  });

  it('polling resume on a finished run does not mint a lease nobody releases', async () => {
    const { readLease } = await import('../kernel/store.js');
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async () => ({ ok: true }));
    const rec = await kernel.start({
      name: 'poll',
      cwd: os.tmpdir(),
      nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }],
    });
    await kernel.wait(rec.runId);
    expect(readLease(rec.runId)).toBeUndefined();
    await kernel.resume(rec.runId);
    expect(readLease(rec.runId)).toBeUndefined();
  });
});

describe('a verdict never outlives the work', () => {
  it('will not report verified while an abandoned attempt could still write', async () => {
    const cwd = gitRepo();
    const record = await mgr.workflowStart(
      {
        name: 'late-writer',
        cwd,
        nodes: [
          { id: 'verify', kind: 'verifier', contract: 'run' },
          // Abandoned after 10ms; it keeps running and writes much later.
          { id: 'slow', kind: 'agent', prompt: 'x', cwd, timeoutMs: 10, onFailure: 'continue' },
        ],
      },
      { cwd, contract: { checks: [{ type: 'command', cmd: 'true' }] } },
    );
    const done = (await (
      mgr as unknown as { kernel: { wait(id: string): Promise<{ state: string; outcome: string }> } }
    ).kernel.wait(record.runId))!;

    // A timed-out node cannot be killed, so the honest answer is not to vouch.
    expect(done.outcome).not.toBe('verified');
    fs.rmSync(cwd, { recursive: true, force: true });
  }, 30_000);
});

describe('one execution, one identity', () => {
  it('stamps the kernel run id on the ledger, not an engine-private one', async () => {
    const cwd = gitRepo();
    const fan = await mgr.fanoutStart({ task: 't', projectDir: cwd, agents: [{ name: 'a' }] });
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(fan.id);

    // Grouping the ledger by run only works if they are the same id.
    const { rows } = mgr.getRunLedger({ since: '1h', parent: fan.id });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.parent === fan.id)).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('the ultraapp build queue refuses work it does not own', () => {
  it("throws on enqueue rather than running another owner's builds", async () => {
    const { UltraappBuildQueue } = await import('../ultraapp/build.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-inv-q-'));
    try {
      const statePath = path.join(dir, 'q.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify({ pending: [], current: null, owner: { pid: 1, renewedAt: new Date().toISOString() } }),
      );
      const seen: string[] = [];
      const q = new UltraappBuildQueue({
        statePath,
        worker: async (id: string) => {
          seen.push(id);
        },
      });
      expect(q.ownsQueue()).toBe(false);
      // Refusing at construction is not enough if every other entry point runs anyway.
      await expect(q.enqueue('intruder')).rejects.toThrow(/owned by pid 1/);
      expect(seen).toEqual([]);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).owner.pid).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
