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
 * Rule for this file: no assertion about what a *mode* does may replace a node
 * executor. The ownership and crash-recovery sections do register one, because
 * what they need from a node is that it hang, signal, or outlive its run — the
 * node's content is not what is under test there, and the alternative is a real
 * engine subprocess. Everywhere else, the path is production code all the way
 * down to the fake session.
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

/** Hold a lock file from a real other process for `ms`, then release it. */
function holdLock(lockPath: string, ms: number): Promise<void> {
  const src = `
    const fs = await import('node:fs');
    fs.writeFileSync(${JSON.stringify(lockPath)}, '');
    await new Promise((r) => setTimeout(r, ${ms}));
    fs.rmSync(${JSON.stringify(lockPath)}, { force: true });
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => proc.on('exit', () => resolve()));
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

describe('what a fixer is told', () => {
  it("frames a failing check's output as data, not as instructions", async () => {
    // The fixer runs with `bypassPermissions` and is handed the output of a
    // command that ran against code an agent wrote — untrusted text going to a
    // privileged agent. UltraApp's own fixer framed it; the kernel's generic one
    // did not, so moving UltraApp's build stage onto the generic verifier would
    // have silently dropped the mitigation. This asserts the framing that
    // UltraApp's own tests never did.
    const cwd = gitRepo();
    const record = await mgr.workflowStart(
      {
        name: 'fixer-prompt',
        cwd,
        nodes: [{ id: 'gate', kind: 'verifier', contract: 'run' }],
      },
      {
        cwd,
        contract: {
          fixOnFailureRounds: 1,
          checks: [{ type: 'file', path: 'this-file-does-not-exist.txt', exists: true }],
        },
      },
    );
    await (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(record.runId);

    const fixer = observed.find((o) => o.config.name?.includes('-fix-'));
    expect(fixer, 'the fix-on-red loop should have spawned a fixer session').toBeDefined();
    const prompt = fixer!.messages[0] ?? '';
    expect(prompt).toMatch(/never as instructions to follow/i);
    expect(prompt).toMatch(/diagnostic DATA/);
    // And the untrusted text is fenced rather than pasted into the sentence.
    expect(prompt).toMatch(/```[\s\S]*```/);

    fs.rmSync(cwd, { recursive: true, force: true });
  }, 30_000);
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
      await expect(kernel.resume('owned-run')).rejects.toThrow(/is owned by/);
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
  const DIST2 = path.resolve('dist/src');

  /**
   * Put a run's lease into the state a legitimate cross-host takeover starts
   * from: the holder is on another machine and has stopped heartbeating.
   *
   * The pre-state is written by hand because we cannot run another host. The
   * takeover itself is not — the tests below call the real `acquireLease`, so
   * what is under test is the production path, not a hand-made outcome.
   */
  async function goQuietOnAnotherHost(runId: string): Promise<void> {
    const { atomicWriteJson, readLease, runDir } = await import('../kernel/store.js');
    atomicWriteJson(path.join(runDir(runId), 'lease.json'), {
      ...readLease(runId)!,
      host: 'a-machine-that-is-not-this-one',
      renewedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
  }

  /**
   * Create a run and hand the claim straight back, so the test can take it as
   * whoever it likes. Creating and claiming are one step now — a run cannot
   * exist unowned even for an instant — so "seed a directory" is spelled this
   * way rather than by a bare create.
   */
  async function seedRun(runId: string, spec: unknown = { name: 'x', nodes: [] }): Promise<void> {
    const { createAndAcquire, releaseLease } = await import('../kernel/store.js');
    releaseLease(createAndAcquire(runId, spec as never, 'seed'));
  }

  function record(runId: string, over: Record<string, unknown> = {}): never {
    return {
      runId,
      workflow: 'x',
      spec: { name: 'x', nodes: [] },
      state: 'running',
      outcome: 'unverified',
      cwd: os.tmpdir(),
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      nodes: {},
      ...over,
    } as never;
  }

  it('two real processes racing to claim: only one of them ever holds it', async () => {
    // The previous version asserted only that *someone* won, which two
    // sequential winners also satisfy. Both children wait for the same instant
    // and then hammer the claim for a fixed window, so neither can win by
    // outliving the other — and each reports whether it ever got a guard AND
    // whether that guard was good enough to write with.
    const { readEvents } = await import('../kernel/store.js');
    await seedRun('race-run');
    const startAt = Date.now() + 700;

    const src = (label: string) => `
      const { acquireLease, commit } = await import(${JSON.stringify(`${DIST2}/kernel/store.js`)});
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
      let held = false, commits = 0;
      // An absolute deadline, shared by both processes: a relative one let the
      // first process exit while the second was still trying, and the second
      // then legitimately took over a lease whose holder was gone — which is
      // correct behaviour, and made the test measure the wrong thing.
      const until = ${startAt} + 1200;
      while (Date.now() < until) {
        try {
          const g = acquireLease('race-run', ${JSON.stringify(label)});
          held = true;
          if (commit(g, { events: [{ ts: new Date().toISOString(), type: 'log', level: 'info',
                                    message: ${JSON.stringify(label)} }] })) commits++;
        } catch { /* refused, which is the correct outcome for the loser */ }
      }
      // Outlive the other process, so neither can win by being last standing.
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt + 2200} - Date.now())));
      console.log(JSON.stringify({ label: ${JSON.stringify(label)}, held, commits }));
    `;
    const run = (label: string): Promise<{ label: string; held: boolean; commits: number }> =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', src(label)], {
          env: { ...process.env, CLAWO_WF_DIR: wfDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
        proc.on('exit', () => {
          try {
            resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}'));
          } catch (e) {
            reject(e);
          }
        });
        proc.on('error', reject);
      });

    const results = await Promise.all([run('owner-a'), run('owner-b')]);
    const winners = results.filter((r) => r.held);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.commits > 0)).toHaveLength(1);
    // And only the winner's writes are in the log the next owner would read.
    const messages = new Set(readEvents('race-run').map((e) => (e as { message?: string }).message));
    expect(messages.has(winners[0].label)).toBe(true);
    expect(messages.has(results.find((r) => !r.held)!.label)).toBe(false);
  }, 60_000);

  it('two kernels in ONE process are two owners, not one', async () => {
    // pid is not identity. Two SessionManagers in a process is not exotic, and
    // treating a shared pid as re-entrancy let both execute the same run.
    const { RunKernel } = await import('../kernel/engine.js');
    const seen: string[] = [];
    const k1 = new RunKernel({ nodeTimeoutMs: 5_000 });
    const k2 = new RunKernel({ nodeTimeoutMs: 5_000 });
    expect(k1.ownerId).not.toBe(k2.ownerId);

    k1.setExecutor('agent', async () => {
      seen.push('k1');
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true };
    });
    k2.setExecutor('agent', async () => {
      seen.push('k2');
      return { ok: true };
    });

    const rec = await k1.start(
      { name: 'two-kernels', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'two-kernels' },
    );
    await new Promise((r) => setTimeout(r, 50));
    await expect(k2.resume(rec.runId)).rejects.toThrow(/owned by/);
    await k1.wait(rec.runId);
    expect(seen).toEqual(['k1']);
  }, 30_000);

  it('the fence never repeats within one incarnation, even across release', async () => {
    // It used to be read off the lease, which release deletes — so the counter
    // restarted at 1 and a stale holder's token could match a fresh owner's.
    const { acquireLease, releaseLease } = await import('../kernel/store.js');
    await seedRun('fence-run');
    const first = acquireLease('fence-run', 'owner-1');
    releaseLease(first);
    const second = acquireLease('fence-run', 'owner-2');
    releaseLease(second);
    const third = acquireLease('fence-run', 'owner-3');
    expect(second.fence).toBeGreaterThan(first.fence);
    expect(third.fence).toBeGreaterThan(second.fence);
  });

  it('re-acquiring supersedes the previous guard, even for the same owner', async () => {
    // Re-entrancy that hands back the same capability is not re-entrancy, it is
    // two capabilities for one run. A second claim is a new claim.
    const { acquireLease, commit, loadRun } = await import('../kernel/store.js');
    await seedRun('reclaim-run');
    const first = acquireLease('reclaim-run', 'same-owner');
    const second = acquireLease('reclaim-run', 'same-owner');
    expect(second.acquisitionId).not.toBe(first.acquisitionId);
    expect(commit(second, { record: record('reclaim-run', { workflow: 'second' }) }).outcome).toBe('committed');
    expect(commit(first, { record: record('reclaim-run', { workflow: 'first' }) }).outcome).toBe('superseded');
    expect(loadRun('reclaim-run')!.workflow).toBe('second');
  });

  it('a superseded owner cannot commit — the write is refused, not merely noticed', async () => {
    // The previous version checked the fence once per node, so every checkpoint,
    // event and terminal verdict after that check was unguarded: a stale owner
    // could still declare the run complete.
    const { acquireLease, commit, loadRun } = await import('../kernel/store.js');
    await seedRun('commit-run');
    const mine = acquireLease('commit-run', 'owner-old');
    expect(commit(mine, { record: record('commit-run') }).outcome).toBe('committed');

    // A real takeover, performed by the real acquisition path.
    await goQuietOnAnotherHost('commit-run');
    acquireLease('commit-run', 'owner-new');

    expect(commit(mine, { record: record('commit-run', { state: 'completed' }) }).outcome).toBe('superseded');
    expect(loadRun('commit-run')?.state).not.toBe('completed');
  });

  it('a kernel whose lease is taken mid-node stops writing and does not complete', async () => {
    const { acquireLease } = await import('../kernel/store.js');
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 10_000 });
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    kernel.setExecutor('agent', async () => {
      await gate;
      return { ok: true, output: 'stale owner wrote this' };
    });

    const rec = await kernel.start(
      { name: 'stolen', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'stolen-run' },
    );
    await new Promise((r) => setTimeout(r, 50));
    await goQuietOnAnotherHost('stolen-run');
    acquireLease('stolen-run', 'someone-else');
    released();

    const done = await kernel.wait(rec.runId);
    expect(done!.state).not.toBe('completed');
    const { loadRun } = await import('../kernel/store.js');
    expect(loadRun('stolen-run')?.state).not.toBe('completed');
  }, 30_000);

  it('a superseded owner keeps neither the state nor the output the disk refused', async () => {
    // The half the previous round missed. Refusing the checkpoint is not enough
    // if the record handed back to the caller still carries the output, the
    // cost, the node payload and a passing verdict — that is the same claim,
    // one layer up, and it is what callers actually read.
    const { acquireLease, loadRun, readEvents } = await import('../kernel/store.js');
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 10_000 });
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    kernel.setExecutor('agent', async (_node, ctx) => {
      await gate;
      // Everything a node is able to do to a run, done after losing it.
      ctx.emit({ ts: new Date().toISOString(), type: 'log', level: 'info', message: 'STALE-OWNER-EVENT' });
      ctx.publish({ stale: true });
      return { ok: true, output: 'STALE-OWNER-OUTPUT', costUsd: 9.99, evidenceId: 'stale-ev', passed: true };
    });

    const rec = await kernel.start(
      { name: 'stale-mem', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'stale-mem' },
    );
    await new Promise((r) => setTimeout(r, 50));
    await goQuietOnAnotherHost('stale-mem');
    acquireLease('stale-mem', 'the-new-owner');
    released();

    const done = (await kernel.wait(rec.runId))!;
    for (const view of [done, loadRun('stale-mem')!]) {
      expect(view.state).not.toBe('completed');
      expect(view.outcome).not.toBe('verified');
      expect(view.verdict).toBeUndefined();
      expect(view.evidenceId).toBeUndefined();
      expect(view.costUsd ?? 0).toBe(0);
      expect(view.nodes.a.output).toBeUndefined();
      expect(view.nodes.a.data).toBeUndefined();
    }
    // And nothing reached the log its replacement reads.
    expect(JSON.stringify(readEvents('stale-mem'))).not.toContain('STALE-OWNER-EVENT');
  }, 30_000);

  it('a guard from a deleted run cannot write to the run that reuses its id', async () => {
    // ABA. The fence is monotonic only while the directory it lives in exists,
    // and deleting a run takes the counter with it — so the next run under the
    // same id starts at fence 1 again, and an attempt still holding fence 1 from
    // the deleted run becomes valid a second time. The incarnation id is what
    // makes that impossible; this test asserts the fence really does repeat, so
    // it is testing the thing that actually saves us.
    const { acquireLease, commit, deleteRunDir, loadRun } = await import('../kernel/store.js');
    await seedRun('aba-run');
    const old = acquireLease('aba-run', 'same-owner');
    expect(commit(old, { record: record('aba-run', { workflow: 'old' }) }).outcome).toBe('committed');

    deleteRunDir('aba-run');
    await seedRun('aba-run');
    const fresh = acquireLease('aba-run', 'same-owner');
    expect(fresh.fence).toBe(old.fence);
    expect(fresh.incarnationId).not.toBe(old.incarnationId);
    expect(commit(fresh, { record: record('aba-run', { workflow: 'new' }) }).outcome).toBe('committed');

    // The old attempt, still alive, tries to finish the run it thinks it owns.
    expect(commit(old, { record: record('aba-run', { workflow: 'old', state: 'completed' }) }).outcome).toBe(
      'superseded',
    );
    expect(loadRun('aba-run')!.workflow).toBe('new');
    expect(loadRun('aba-run')!.state).not.toBe('completed');
  });

  it('an abandoned attempt cannot write to the next run that takes its id', async () => {
    // The same ABA, through the kernel: a node whose timeout was abandoned is
    // still running by construction, and it outlives both its run and the
    // delete that frees the id.
    const { loadRun, readEvents } = await import('../kernel/store.js');
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 200 });
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    let first = true;
    kernel.setExecutor('agent', async (_node, ctx) => {
      if (first) {
        first = false;
        await gate;
        ctx.emit({ ts: new Date().toISOString(), type: 'log', level: 'info', message: 'GHOST-EVENT' });
        ctx.publish({ ghost: true });
        return { ok: true, output: 'GHOST-OUTPUT' };
      }
      return { ok: true, output: 'second run output' };
    });

    const one = await kernel.start(
      { name: 'ghost-one', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'reused-id', tag: 't1' },
    );
    await kernel.wait(one.runId);
    expect(kernel.delete('reused-id', { expectTag: 't1' })).toBe(true);

    const two = await kernel.start(
      { name: 'ghost-two', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'reused-id', tag: 't2' },
    );
    await kernel.wait(two.runId);

    released();
    await new Promise((r) => setTimeout(r, 250));

    const disk = loadRun('reused-id')!;
    expect(disk.workflow).toBe('ghost-two');
    expect(disk.nodes.a.output).toBe('second run output');
    expect(disk.nodes.a.data).toBeUndefined();
    expect(JSON.stringify(readEvents('reused-id'))).not.toContain('GHOST');
  }, 30_000);

  it('two real processes creating the same run ids: exactly one wins each', async () => {
    // Creating used to be `runExists()` then `mkdirSync({recursive:true})` —
    // check-then-write, and it lost the race routinely: two processes creating
    // the same id both "succeeded" most of the time, leaving one workflow
    // executing while the other's spec.json sat on disk under it. The
    // non-recursive mkdir is the claim now, so exactly one caller can create a
    // given id.
    const { loadSpec } = await import('../kernel/store.js');
    const ids = Array.from({ length: 40 }, (_, i) => `dup-${i}`);
    const startAt = Date.now() + 700;
    const src = (label: string) => `
      const { createAndAcquire, releaseLease } = await import(${JSON.stringify(`${DIST2}/kernel/store.js`)});
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
      const created = [];
      for (const id of ${JSON.stringify(ids)}) {
        try {
          const g = createAndAcquire(id, { name: ${JSON.stringify(label)}, nodes: [] }, ${JSON.stringify(label)});
          created.push(id);
          releaseLease(g);
        } catch { /* the other process got there first */ }
      }
      console.log(JSON.stringify({ label: ${JSON.stringify(label)}, created }));
    `;
    const run = (label: string): Promise<{ label: string; created: string[] }> =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', src(label)], {
          env: { ...process.env, CLAWO_WF_DIR: wfDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
        proc.on('exit', () => {
          try {
            resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}'));
          } catch (e) {
            reject(e);
          }
        });
        proc.on('error', reject);
      });

    const [a, b] = await Promise.all([run('workflow-a'), run('workflow-b')]);
    const both = a.created.filter((id) => b.created.includes(id));
    expect(both).toEqual([]);
    expect([...a.created, ...b.created].sort()).toEqual([...ids].sort());
    // And the run that exists is the one whose creator believes it created it.
    for (const id of ids) {
      const owner = a.created.includes(id) ? 'workflow-a' : 'workflow-b';
      expect(loadSpec(id)?.name).toBe(owner);
    }
  }, 60_000);

  it('a commit that reports committed has its events, or it is not committed', async () => {
    // The event append used to swallow its own errors, so a commit could report
    // success with a finished checkpoint and no events at all. The batch is
    // published by one atomic directory rename now: either both are there or
    // neither is.
    const { acquireLease, commit, loadRun, readEvents, runDir } = await import('../kernel/store.js');
    await seedRun('batch-run');
    const guard = acquireLease('batch-run', 'o');
    expect(
      commit(guard, {
        record: record('batch-run', { workflow: 'with-events' }),
        events: [{ ts: 't', type: 'log', level: 'info', message: 'IN-THE-BATCH' }],
        artifacts: [{ nodeId: 'a', name: 'out.txt', body: 'artifact body' }],
      }).outcome,
    ).toBe('committed');
    expect(loadRun('batch-run')!.workflow).toBe('with-events');
    expect(JSON.stringify(readEvents('batch-run'))).toContain('IN-THE-BATCH');
    expect(fs.readFileSync(path.join(runDir('batch-run'), 'nodes', 'a', 'out.txt'), 'utf8')).toBe('artifact body');

    // A batch that cannot be staged leaves nothing behind — not the artifact it
    // had already written, which the old order did leave.
    const circular: Record<string, unknown> = { runId: 'batch-run' };
    circular.self = circular;
    const failed = commit(guard, {
      record: circular as never,
      events: [{ ts: 't', type: 'log', level: 'info', message: 'SHOULD-NOT-APPEAR' }],
      artifacts: [{ nodeId: 'b', name: 'out.txt', body: 'should not survive' }],
    });
    expect(failed.outcome).toBe('blocked');
    expect(fs.existsSync(path.join(runDir('batch-run'), 'nodes', 'b', 'out.txt'))).toBe(false);
    expect(JSON.stringify(readEvents('batch-run'))).not.toContain('SHOULD-NOT-APPEAR');
    expect(loadRun('batch-run')!.workflow).toBe('with-events');
  });

  it('a transaction committed but not applied is finished by the next reader', async () => {
    // What a crash between the commit point and the application looks like on
    // disk, and what recovery has to do with it. Applying is idempotent — the
    // manifest records the event log's length before the transaction, so it
    // truncates and re-appends rather than appending twice.
    const { acquireLease, commit, loadRun, readEvents, runDir } = await import('../kernel/store.js');
    await seedRun('recover-run');
    const guard = acquireLease('recover-run', 'o');
    commit(guard, {
      record: record('recover-run', { workflow: 'before' }),
      events: [{ ts: 't0', type: 'log', level: 'info', message: 'FIRST' }],
    });
    const dir = runDir('recover-run');
    const eventsBefore = fs.statSync(path.join(dir, 'events.jsonl')).size;

    const stage = (): void => {
      const tx = path.join(dir, '.tx');
      fs.mkdirSync(tx, { recursive: true });
      fs.writeFileSync(
        path.join(tx, 'manifest.json'),
        JSON.stringify({ eventsOffset: eventsBefore, hasRecord: true, hasEvents: true, artifacts: [] }),
      );
      fs.writeFileSync(path.join(tx, 'run.json'), JSON.stringify(record('recover-run', { workflow: 'after' })));
      fs.writeFileSync(
        path.join(tx, 'events.jsonl'),
        JSON.stringify({ ts: 't1', type: 'log', level: 'info', message: 'SECOND' }) + '\n',
      );
    };

    stage();
    expect(loadRun('recover-run')!.workflow).toBe('after');
    expect(readEvents('recover-run').map((e) => (e as { message?: string }).message)).toEqual(['FIRST', 'SECOND']);
    expect(fs.existsSync(path.join(dir, '.tx'))).toBe(false);

    // Replaying the same transaction must not duplicate its events.
    stage();
    loadRun('recover-run');
    expect(readEvents('recover-run').map((e) => (e as { message?: string }).message)).toEqual(['FIRST', 'SECOND']);
  });

  it('never returns the old checkpoint while a committed transaction cannot be applied', async () => {
    const { acquireLease, commit, loadRun, runDir } = await import('../kernel/store.js');
    await seedRun('unapplied-run');
    const guard = acquireLease('unapplied-run', 'o');
    expect(commit(guard, { record: record('unapplied-run', { workflow: 'old' }) }).outcome).toBe('committed');

    const dir = runDir('unapplied-run');
    fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nodes', 'a'), 'blocks the artifact directory');
    expect(
      commit(guard, {
        record: record('unapplied-run', { workflow: 'new' }),
        artifacts: [{ nodeId: 'a', name: 'out.txt', body: 'new' }],
      }).outcome,
    ).toBe('committed');

    expect(() => loadRun('unapplied-run')).toThrow(/committed transaction.*could not be applied/);
    fs.rmSync(path.join(dir, 'nodes', 'a'));
    expect(loadRun('unapplied-run')?.workflow).toBe('new');
  });

  it("a refused delete does not leave the caller's credentials in memory", async () => {
    // `delete` claims the run before removing it, and refuses when it cannot.
    // The refusal path still has to forget what this process was holding for it
    // — a secret bag kept for a run we are no longer tracking is exactly the
    // material that must not linger.
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel();
    kernel.setExecutor('agent', async () => ({ ok: true }));
    const started = await kernel.start(
      { name: 'forget', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'forget-run', tag: 't', secrets: { customEngine: { env: { TOKEN: 'do-not-keep-this' } } } },
    );
    await kernel.wait(started.runId);

    const holder = new RunKernel();
    holder.setExecutor('agent', async () => ({ ok: true }));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    holder.setExecutor('agent', async () => {
      await gate;
      return { ok: true };
    });
    await holder.resume('forget-run', { restart: true });

    expect(kernel.delete('forget-run')).toBe(false);
    const secrets = (kernel as unknown as { _secrets: Map<string, unknown> })._secrets;
    expect(secrets.has('forget-run')).toBe(false);

    finish();
    await holder.wait('forget-run');
    holder.delete('forget-run');
  }, 30_000);

  it('delete cannot remove a run another kernel resumed', async () => {
    const { RunKernel } = await import('../kernel/engine.js');
    const first = new RunKernel();
    first.setExecutor('agent', async () => ({ ok: true }));
    const started = await first.start(
      { name: 'delete-race', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'delete-race' },
    );
    await first.wait(started.runId);

    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const second = new RunKernel();
    second.setExecutor('agent', async () => {
      await gate;
      return { ok: true };
    });
    await second.resume(started.runId, { restart: true });
    expect(first.delete(started.runId)).toBe(false);
    expect(first.get(started.runId)).toBeDefined();

    finish();
    await second.wait(started.runId);
    expect(second.delete(started.runId)).toBe(true);
  });

  it('three real processes committing at once: every commit is in the log exactly once', async () => {
    // The invariant that actually tests the lock, rather than describing it. A
    // lock that lets two callers in at once does not announce itself — what it
    // does is lose writes, because one caller's recursive cleanup of its own
    // staging directory walks into the transaction directory the other just
    // published. Committed events then vanish, or the run wedges with a
    // transaction that can never be applied.
    //
    // Against the previous lock this test does not merely fail, it throws: the
    // run ends up permanently unreadable.
    const { readEvents } = await import('../kernel/store.js');
    await seedRun('exclusion-run');
    const startAt = Date.now() + 700;
    const src = (label: string) => `
      const { acquireLease, commit } = await import(${JSON.stringify(`${DIST2}/kernel/store.js`)});
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
      const done = [];
      let i = 0;
      // One shared owner id: the lease is not what is under test here, the lock is.
      while (Date.now() < ${startAt} + 1200) {
        const message = ${JSON.stringify(label)} + '-' + i++;
        try {
          const g = acquireLease('exclusion-run', 'shared-owner');
          if (commit(g, { events: [{ ts: 't', type: 'log', level: 'info', message }] }).outcome === 'committed') {
            done.push(message);
          }
        } catch { /* contended */ }
      }
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt + 2200} - Date.now())));
      console.log(JSON.stringify({ done }));
    `;
    const run = (label: string): Promise<{ done: string[] }> =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', src(label)], {
          env: { ...process.env, CLAWO_WF_DIR: wfDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
        proc.on('exit', () => {
          try {
            resolve(JSON.parse(out.trim().split('\n').pop() ?? '{"done":[]}'));
          } catch (e) {
            reject(e);
          }
        });
        proc.on('error', reject);
      });

    const results = await Promise.all([run('a'), run('b'), run('c')]);
    const committed = results.flatMap((r) => r.done);
    expect(committed.length).toBeGreaterThan(20);

    const logged = readEvents('exclusion-run').map((e) => (e as { message?: string }).message);
    const counts = new Map<string | undefined, number>();
    for (const m of logged) counts.set(m, (counts.get(m) ?? 0) + 1);
    // Nothing a commit reported as committed may be missing, and nothing may
    // appear twice — the two ways a broken lock shows up in the data.
    expect(committed.filter((m) => !counts.has(m))).toEqual([]);
    expect([...counts].filter(([, n]) => n > 1)).toEqual([]);
    expect(fs.existsSync(path.join(wfDir, 'exclusion-run', '.tx'))).toBe(false);
  }, 60_000);

  it('a moment of lock contention is not a lost run', async () => {
    // `withLock` threw immediately on a fresh lock and `commit` turned every
    // error into "you no longer own this", so a millisecond of contention ended
    // the run permanently. The lock waits now, and only a real takeover is a
    // takeover.
    const { RunKernel } = await import('../kernel/engine.js');
    const { runDir } = await import('../kernel/store.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 10_000 });
    kernel.setExecutor('agent', async (_node, ctx) => {
      // A real other process holds the lock: the wait is synchronous, so a
      // same-thread holder could never be waited out — and could never exist,
      // since these critical sections do not nest.
      const holder = holdLock(path.join(runDir('contended-run'), 'lease.lock'), 150);
      await new Promise((r) => setTimeout(r, 60));
      // Hits the lock while it is held, and must wait rather than give up.
      ctx.emit({ ts: new Date().toISOString(), type: 'log', level: 'info', message: 'THROUGH-CONTENTION' });
      await holder;
      return { ok: true };
    });
    const rec = await kernel.start(
      { name: 'contended', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'contended-run' },
    );
    const done = await kernel.wait(rec.runId);
    expect(done!.state).toBe('completed');
    const { readEvents } = await import('../kernel/store.js');
    expect(JSON.stringify(readEvents('contended-run'))).toContain('THROUGH-CONTENTION');
  }, 30_000);

  it('a run that truly cannot write hands its claim back instead of wedging', async () => {
    // The other half of the same fix. An owner that gives up must not keep the
    // lease: a live local pid is never judged stale, so a lease left behind by a
    // stopped run can never be taken over and the run is lost for good.
    const { RunKernel } = await import('../kernel/engine.js');
    const { readLease, runDir } = await import('../kernel/store.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 10_000 });
    kernel.setExecutor('agent', async (_node, ctx) => {
      // Held for longer than the lock's wait, so this write genuinely fails.
      holdLock(path.join(runDir('wedged-run'), 'lease.lock'), 900);
      await new Promise((r) => setTimeout(r, 60));
      ctx.emit({ ts: new Date().toISOString(), type: 'log', level: 'info', message: 'NEVER-LANDS' });
      return { ok: true };
    });
    const rec = await kernel.start(
      { name: 'wedged', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'wedged-run' },
    );
    const done = await kernel.wait(rec.runId);
    expect(done!.state).not.toBe('completed');

    // The claim comes back once the lock clears, so the run is resumable.
    for (let i = 0; i < 40 && readLease('wedged-run'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readLease('wedged-run')).toBeUndefined();
    const other = new RunKernel({ nodeTimeoutMs: 5_000 });
    other.setExecutor('agent', async () => ({ ok: true }));
    await expect(other.resume('wedged-run')).resolves.toBeDefined();
    await other.wait('wedged-run');
  }, 30_000);

  it('does not declare a live local owner stale for going quiet', async () => {
    const { leaseIsStale } = await import('../kernel/store.js');
    expect(
      leaseIsStale({
        runId: 'r',
        incarnationId: 'i',
        ownerId: 'o',
        acquisitionId: 'a',
        fence: 1,
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
        renewedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    ).toBe(false);
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
        JSON.stringify({
          pending: [],
          current: null,
          owner: { ownerId: 'other-queue', pid: 1, renewedAt: new Date().toISOString() },
        }),
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
      await expect(q.enqueue('intruder')).rejects.toThrow(/owned by other-queue/);
      expect(seen).toEqual([]);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).owner.ownerId).toBe('other-queue');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 9. The races the previous tests only claimed to cover ──────────────────

describe('races that need real processes', () => {
  const DIST3 = path.resolve('dist/src');

  function child(src: string, env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawn> {
    return spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, CLAWO_WF_DIR: wfDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function collect(proc: ReturnType<typeof spawn>): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = '';
      proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('exit', () => resolve(out));
      proc.on('error', reject);
    });
  }

  function lastJson<T>(out: string): T | undefined {
    try {
      return JSON.parse(out.trim().split('\n').pop() ?? '') as T;
    } catch {
      return undefined;
    }
  }

  it('two processes claiming an EMPTY ultraapp queue: exactly one runs the build', async () => {
    // Two things were wrong with the earlier version. It pre-seeded an owner, so
    // it never exercised the case that actually broke — two constructors, no
    // state file, both concluding they owned it. And it asserted `<= 1`, which
    // zero executions also satisfies, so a queue that ran nothing would have
    // passed. Both processes now construct at the same instant and stay alive
    // past each other, and the assertion is exactly one.
    const statePath = path.join(wfDir, 'contested-queue.json');
    const startAt = Date.now() + 700;
    const src = (label: string) => `
      const { UltraappBuildQueue } = await import(${JSON.stringify(`${DIST3}/ultraapp/build.js`)});
      const seen = [];
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
      const q = new UltraappBuildQueue({
        statePath: ${JSON.stringify(statePath)},
        worker: async (id) => { seen.push(${JSON.stringify(label)} + ':' + id); },
      });
      const owns = q.ownsQueue();
      let refused = false;
      try { await q.enqueue('same-build'); } catch { refused = true; }
      await q.idle();
      // Outlive the other process, so neither can win by being the last one standing.
      await new Promise((r) => setTimeout(r, Math.max(0, ${startAt + 2500} - Date.now())));
      console.log(JSON.stringify({ label: ${JSON.stringify(label)}, owns, refused, seen }));
    `;
    const outs = await Promise.all([collect(child(src('p1'))), collect(child(src('p2')))]);
    const results = outs.map((o) => lastJson<{ owns: boolean; refused: boolean; seen: string[] }>(o));
    expect(results.every(Boolean)).toBe(true);
    expect(results.filter((r) => r!.owns)).toHaveLength(1);
    expect(results.filter((r) => r!.refused)).toHaveLength(1);
    expect(results.flatMap((r) => r!.seen)).toHaveLength(1);
  }, 60_000);

  it("a superseded queue owner's next write does not steal the queue back", async () => {
    // Claiming at construction and then writing unconditionally forever is not
    // ownership: the heartbeat is the same write, so a queue that had been taken
    // over would stamp itself back in as owner on its next persist and run the
    // new owner's builds a second time.
    const { UltraappBuildQueue } = await import('../ultraapp/build.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-inv-q2-'));
    try {
      const statePath = path.join(dir, 'q.json');
      const q = new UltraappBuildQueue({ statePath, worker: async () => {} });
      expect(q.ownsQueue()).toBe(true);

      // A live takeover by someone else, exactly as a second process leaves it.
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          pending: ['theirs'],
          current: null,
          owner: { ownerId: 'the-new-owner', pid: process.pid, renewedAt: new Date().toISOString() },
        }),
      );

      await expect(q.enqueue('mine')).rejects.toThrow(/owned by the-new-owner/);
      const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(after.owner.ownerId).toBe('the-new-owner');
      expect(after.pending).toEqual(['theirs']);
      expect(q.ownsQueue()).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a queue that cannot claim the state file does not run the build anyway', async () => {
    // The recheck added last round mixed two failures into one boolean: "I have
    // been superseded" and "I could not get the lock". `enqueue` and
    // `tryDispatch` both treated the second as permission to proceed, so a queue
    // whose state file on disk already named a new owner still ran the build.
    const { UltraappBuildQueue } = await import('../ultraapp/build.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-inv-q3-'));
    try {
      const statePath = path.join(dir, 'q.json');
      const seen: string[] = [];
      const q = new UltraappBuildQueue({
        statePath,
        worker: async (id: string) => {
          seen.push(id);
        },
      });
      expect(q.ownsQueue()).toBe(true);

      // A new owner is inside the critical section and has already written
      // itself in — exactly the window the old queue used to dispatch through.
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          pending: ['theirs'],
          current: null,
          owner: { ownerId: 'the-new-owner', pid: process.pid, renewedAt: new Date().toISOString() },
        }),
      );
      const holder = holdLock(`${statePath}.lock`, 900);
      await new Promise((r) => setTimeout(r, 60));

      await expect(q.enqueue('stale-work')).rejects.toThrow(/locked by another process/);
      expect(seen).toEqual([]);
      const disk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(disk.owner.ownerId).toBe('the-new-owner');
      expect(disk.pending).toEqual(['theirs']);
      await holder;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a fresh process resumes a custom-engine run only when given the reference', async () => {
    // Credentials are never persisted, so a crashed custom-engine run could not
    // be resumed by anyone who did not still have them in memory. The earlier
    // test for this called `resolveSecretRef` and nothing else — it proved a
    // lookup, not a resume. This one runs the product entry point
    // (`SessionManager.autoloopResume`) in a process that never held the config,
    // twice: without the reference it is refused for the documented reason, with
    // it the run gets past that gate.
    const { acquireLease, commit, createAndAcquire, releaseLease } = await import('../kernel/store.js');
    const runId = 'custom-engine-resume';
    const spec = {
      name: 'autoloop',
      cwd: os.tmpdir(),
      nodes: [
        {
          id: 'main',
          kind: 'autoloop',
          config: { runId, goal: 'g', workspace: os.tmpdir(), plannerEngine: 'custom' },
        },
      ],
    };
    releaseLease(createAndAcquire(runId, spec as never, 'seed'));
    const fixture = acquireLease(runId, 'fixture');
    commit(fixture, {
      record: {
        runId,
        workflow: 'autoloop',
        spec,
        state: 'failed',
        outcome: 'unverified',
        cwd: os.tmpdir(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: { main: { id: 'main', kind: 'autoloop', state: 'failed', attempts: 1, visits: 1 } },
      } as never,
    });
    releaseLease(fixture);

    const src = (withRef: boolean) => `
      const { SessionManager } = await import(${JSON.stringify(`${DIST3}/session-manager.js`)});
      const { resolveSecretRefs } = await import(${JSON.stringify(`${DIST3}/kernel/secrets.js`)});
      const mgr = new SessionManager({ logger: { info(){}, warn(){}, error(){}, debug(){} } });
      const refs = ${withRef ? "resolveSecretRefs({ plannerCustomEngine: 'TEST_ENGINE' })" : '{}'};
      let err = '';
      try { await mgr.autoloopResume(${JSON.stringify(runId)}, refs); } catch (e) { err = String(e && e.message); }
      console.log(JSON.stringify({ err }));
      process.exit(0);
    `;
    const env = {
      HOME,
      USERPROFILE: HOME,
      CLAWO_CUSTOM_ENGINE_TEST_ENGINE: JSON.stringify({
        name: 'test-engine',
        bin: '/nonexistent/definitely-not-a-real-binary',
        args: { prompt: ['-p'] },
        env: { TOKEN: 'never-leaves-the-host' },
      }),
    };
    const [without, withRef] = await Promise.all([collect(child(src(false), env)), collect(child(src(true), env))]);
    const a = lastJson<{ err: string }>(without);
    const b = lastJson<{ err: string }>(withRef);
    expect(a?.err).toMatch(/[Pp]lanner custom engine config is required/);
    // The reference got the config all the way into the resume path: the same
    // call, in the same fresh process, no longer fails for want of it.
    expect(b?.err ?? '').not.toMatch(/[Pp]lanner custom engine config is required/);
    expect(b?.err ?? '').not.toMatch(/Unknown secret reference/);
    // And the credential itself never went to disk.
    expect(runFiles(runId).join('\n')).not.toContain('never-leaves-the-host');
  }, 60_000);

  it('a failed start does not delete the retry that took its run id', async () => {
    // Overlapping, not the serial retry the earlier version did: the loser's
    // late cleanup is fired while the winner's start is still in flight, which
    // is the only ordering in which the bug could bite.
    const { RunKernel } = await import('../kernel/engine.js');
    const kernel = new RunKernel({ nodeTimeoutMs: 5_000 });
    kernel.setExecutor('agent', async () => ({ ok: true }));

    const first = await kernel.start(
      { name: 'r', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'contested-id', tag: 'start-1' },
    );
    await kernel.wait(first.runId);
    kernel.delete('contested-id', { expectTag: 'start-1' });

    // Not awaited: the delete below runs while this start is between its own
    // awaits, holding the id but not yet finished with it.
    const pending = kernel.start(
      { name: 'r', cwd: os.tmpdir(), nodes: [{ id: 'a', kind: 'agent', prompt: 'x' }] },
      { runId: 'contested-id', tag: 'start-2' },
    );
    const late = kernel.delete('contested-id', { expectTag: 'start-1' });
    const second = await pending;
    await kernel.wait(second.runId);

    expect(late).toBe(false);
    expect(kernel.get('contested-id')).toBeDefined();
    // The rightful owner can still remove it.
    expect(kernel.delete('contested-id', { expectTag: 'start-2' })).toBe(true);
  }, 30_000);
});
