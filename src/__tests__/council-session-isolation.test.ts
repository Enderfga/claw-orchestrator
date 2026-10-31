/**
 * Concurrent Council same-member session isolation.
 *
 * Public path: SessionManager.councilStart → kernel → Council → startSession.
 * Only the engine subprocess is replaced with a typed ISession fake.
 *
 * On the truncating base, two concurrent councils that share a member name and
 * round request the same internal session name (`council-` + first 8 run-id
 * chars). SessionManager reuses that session, so the first assertion below
 * fails by equality before either engine send is awaited.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionInfo,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../types.js';
import { SessionManager } from '../session-manager.js';
import { Council } from '../council.js';
import { isValidRunId } from '../kernel/store.js';

const REPORT_BODY = `${'Isolation marker report. '.repeat(8)}\n` + `Detail line for length. `.repeat(4);
const REPORT = `${REPORT_BODY}\n[CONSENSUS: YES]`;
const REPORT_NO = `${REPORT_BODY}\n[CONSENSUS: NO]`;

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeEngine extends EventEmitter implements ISession {
  sessionId?: string;
  stopCalled = 0;
  sendEntered = 0;
  private _busy = false;
  private turns = 0;
  constructor(
    readonly config: SessionConfig,
    private readonly hooks: {
      onSendEnter?: (session: FakeEngine) => void;
      hold?: () => Promise<void>;
      bodyFor: (session: FakeEngine, message: string | unknown[]) => string;
    },
  ) {
    super();
  }
  get isReady() {
    return true;
  }
  get isPaused() {
    return false;
  }
  get isBusy() {
    return this._busy;
  }
  async start(): Promise<this> {
    this.sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
    return this;
  }
  stop(): void {
    this.stopCalled++;
  }
  pause(): void {}
  resume(): void {}
  async send(message: string | unknown[], _options?: SessionSendOptions): Promise<TurnResult> {
    this.sendEntered++;
    this._busy = true;
    this.hooks.onSendEnter?.(this);
    try {
      if (this.hooks.hold) await this.hooks.hold();
      this.turns++;
      const text = this.hooks.bodyFor(this, message);
      return { text, event: { type: 'result', result: text } };
    } finally {
      this._busy = false;
    }
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.turns,
      turnsSucceeded: this.turns,
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
      model: 'fake',
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
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

function gitProject(label: string): string {
  const root = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, `council-iso-${label}-`));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'iso@example.com');
  git('config', 'user.name', 'iso');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${label}\n`);
  git('add', '-A');
  git('commit', '-m', 'init');
  return dir;
}

function architectAgent() {
  return {
    name: 'Architect',
    emoji: '🟠',
    persona: 'Architecture member for isolation regression',
    engine: 'codex' as const,
  };
}

describe('council member-session isolation', () => {
  const managers: SessionManager[] = [];
  const projects: string[] = [];

  beforeEach(() => {
    managers.length = 0;
    projects.length = 0;
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) {
      try {
        await m.shutdown();
      } catch {
        /* ignore */
      }
    }
    for (const dir of projects.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeManager(): SessionManager {
    const mgr = new SessionManager({
      claudeBin: 'mock-claude',
      maxConcurrentSessions: 16,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'bypassPermissions',
      defaultEffort: 'auto',
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    managers.push(mgr);
    return mgr;
  }

  function trackProject(dir: string): string {
    projects.push(dir);
    return dir;
  }

  async function waitRun(mgr: SessionManager, id: string): Promise<void> {
    const kernel = (mgr as unknown as { kernel: { wait(runId: string): Promise<unknown> } }).kernel;
    await kernel.wait(id);
  }

  it(
    'keeps concurrent same-member councils on distinct sessions, engines, cwds and cleanup',
    { timeout: 60_000 },
    async () => {
      const mgr = makeManager();
      const projectA = trackProject(gitProject('a'));
      const projectB = trackProject(gitProject('b'));
      const under = (cwd: string | undefined, root: string) =>
        Boolean(cwd && (cwd === root || cwd.startsWith(root + path.sep)));

      const aSendHold = deferred();
      const bSendHold = deferred();
      const aSendEntered = deferred();
      const bStartDone = deferred<SessionInfo>();
      let sessionAId: string | undefined;
      let sessionBId: string | undefined;

      const fakes: FakeEngine[] = [];
      const startRequests: Array<{ name: string; cwd: string }> = [];

      try {
        (mgr as unknown as { _createSession: (engine: string, config: SessionConfig) => ISession })._createSession = (
          _engine,
          config,
        ) => {
          const fake = new FakeEngine(config, {
            onSendEnter: (session) => {
              if (under(session.config.cwd, projectA)) aSendEntered.resolve();
            },
            hold: async () => {
              if (under(config.cwd, projectA)) await aSendHold.promise;
              else if (under(config.cwd, projectB)) await bSendHold.promise;
            },
            bodyFor: (session) => {
              const marker = under(session.config.cwd, projectA)
                ? 'MARKER-A'
                : under(session.config.cwd, projectB)
                  ? 'MARKER-B'
                  : 'MARKER-X';
              return `${marker}\n${REPORT}`;
            },
          });
          fakes.push(fake);
          return fake;
        };

        const originalStart = mgr.startSession.bind(mgr);
        mgr.startSession = (async (cfg: Parameters<SessionManager['startSession']>[0]) => {
          const name = cfg.name ?? '';
          const cwd = cfg.cwd ?? '';
          startRequests.push({ name, cwd });
          const info = await originalStart(cfg);
          if (under(cwd, projectB)) bStartDone.resolve(info);
          return info;
        }) as SessionManager['startSession'];

        const runA = mgr.councilStart('Isolate concurrent council run A with unique task text', {
          agents: [architectAgent()],
          maxRounds: 1,
          projectDir: projectA,
        });
        await aSendEntered.promise;

        const sessionA = await runA;
        sessionAId = sessionA.id;
        const sessionBPromise = mgr.councilStart('Isolate concurrent council run B with unique task text', {
          agents: [architectAgent()],
          maxRounds: 1,
          projectDir: projectB,
        });

        // B's real startSession has returned. Do not wait for B's engine send yet —
        // on the truncating base that send is serialized behind A's held turn.
        const bStartInfo = await bStartDone.promise;
        const sessionB = await sessionBPromise;
        sessionBId = sessionB.id;

        const aStarts = startRequests.filter((s) => under(s.cwd, projectA));
        const bStarts = startRequests.filter((s) => under(s.cwd, projectB));
        expect(aStarts.length).toBeGreaterThanOrEqual(1);
        expect(bStarts.length).toBeGreaterThanOrEqual(1);

        const nameA = aStarts[0]!.name;
        const nameB = bStarts[0]!.name;
        // Authentic RED on the truncating base: equality here, not a timeout.
        expect(nameA).not.toBe(nameB);
        expect(nameA).toContain(sessionA.id);
        expect(nameB).toContain(sessionB.id);
        expect(nameA).toMatch(/Architect-r1$/);
        expect(nameB).toMatch(/Architect-r1$/);
        expect(bStartInfo.name).toBe(nameB);

        // Finish A while B remains pending on its own send barrier.
        aSendHold.resolve();
        await waitRun(mgr, sessionA.id);

        const fakeB = fakes.find((f) => under(f.config.cwd, projectB));
        expect(fakeB).toBeDefined();
        expect(mgr.listSessions().some((s) => s.name === nameB)).toBe(true);
        expect(fakeB!.stopCalled).toBe(0);
        expect(fakeB!.isBusy).toBe(true);

        bSendHold.resolve();
        await waitRun(mgr, sessionB.id);

        const statusA = mgr.councilStatus(sessionA.id);
        const statusB = mgr.councilStatus(sessionB.id);
        expect(statusA?.status).toBe('awaiting_user');
        expect(statusB?.status).toBe('awaiting_user');
        expect(statusA?.id).toBe(sessionA.id);
        expect(statusB?.id).toBe(sessionB.id);
        expect(statusA?.id).not.toBe(statusB?.id);

        const respA = statusA!.responses.find((r) => r.agent === 'Architect' && r.round === 1)!;
        const respB = statusB!.responses.find((r) => r.agent === 'Architect' && r.round === 1)!;
        expect(respA.sessionKey).toBe(nameA);
        expect(respB.sessionKey).toBe(nameB);
        expect(respA.sessionKey).not.toBe(respB.sessionKey);
        expect(respA.content).toContain('MARKER-A');
        expect(respB.content).toContain('MARKER-B');
        expect(respA.content).not.toContain('MARKER-B');
        expect(respB.content).not.toContain('MARKER-A');

        const fakeA = fakes.find((f) => under(f.config.cwd, projectA));
        expect(fakeA).toBeDefined();
        expect(fakeA!.config.cwd).not.toBe(fakeB!.config.cwd);
        expect(under(fakeA!.config.cwd, projectA)).toBe(true);
        expect(under(fakeB!.config.cwd, projectB)).toBe(true);
        expect(isValidRunId(sessionA.id)).toBe(true);
        expect(isValidRunId(sessionB.id)).toBe(true);
        expect(sessionA.id.startsWith('council-')).toBe(true);
        expect(sessionB.id.startsWith('council-')).toBe(true);

        const ledger = mgr.getRunLedger({ since: '1h' }).rows;
        const rowsA = ledger.filter((r) => r.session === nameA);
        const rowsB = ledger.filter((r) => r.session === nameB);
        expect(rowsA.length).toBeGreaterThan(0);
        expect(rowsB.length).toBeGreaterThan(0);
        expect(rowsA.every((r) => r.parent === sessionA.id)).toBe(true);
        expect(rowsB.every((r) => r.parent === sessionB.id)).toBe(true);
        expect(sessionA.id).not.toBe(sessionB.id);
      } finally {
        aSendHold.resolve();
        bSendHold.resolve();
        if (sessionAId) await waitRun(mgr, sessionAId).catch(() => {});
        if (sessionBId) await waitRun(mgr, sessionBId).catch(() => {});
      }
    },
  );

  it('distinguishes members and rounds inside one run', { timeout: 60_000 }, async () => {
    const mgr = makeManager();
    const project = trackProject(gitProject('members'));
    const names: string[] = [];

    (mgr as unknown as { _createSession: (engine: string, config: SessionConfig) => ISession })._createSession = (
      _engine,
      config,
    ) => {
      if (config.name) names.push(config.name);
      return new FakeEngine(config, {
        // Round 1 must vote strict NO so the council actually opens round 2.
        bodyFor: (session) => (String(session.config.name ?? '').endsWith('-r1') ? REPORT_NO : REPORT),
      });
    };

    const session = await mgr.councilStart('Member and round naming control task', {
      agents: [
        { name: 'Architect', emoji: '🟠', persona: 'A', engine: 'codex' },
        { name: 'Engineer', emoji: '🟢', persona: 'E', engine: 'codex' },
      ],
      maxRounds: 2,
      projectDir: project,
    });
    await waitRun(mgr, session.id);

    const archR1 = names.filter((n) => n.endsWith('Architect-r1'));
    const engR1 = names.filter((n) => n.endsWith('Engineer-r1'));
    const archR2 = names.filter((n) => n.endsWith('Architect-r2'));
    const engR2 = names.filter((n) => n.endsWith('Engineer-r2'));
    expect(archR1).toHaveLength(1);
    expect(engR1).toHaveLength(1);
    expect(archR2).toHaveLength(1);
    expect(engR2).toHaveLength(1);
    expect(archR1[0]).not.toBe(engR1[0]);
    expect(archR1[0]).not.toBe(archR2[0]);
    expect(engR1[0]).not.toBe(engR2[0]);
    for (const n of [archR1[0], engR1[0], archR2[0], engR2[0]]) {
      expect(n).toContain(session.id);
    }

    const status = mgr.councilStatus(session.id);
    expect(status?.status).toBe('awaiting_user');
    const responses = status!.responses;
    expect(responses.filter((r) => r.round === 1)).toHaveLength(2);
    expect(responses.filter((r) => r.round === 2)).toHaveLength(2);

    const resp = (agent: string, round: number) => responses.find((r) => r.agent === agent && r.round === round)!;
    expect(resp('Architect', 1).sessionKey).toBe(archR1[0]);
    expect(resp('Engineer', 1).sessionKey).toBe(engR1[0]);
    expect(resp('Architect', 2).sessionKey).toBe(archR2[0]);
    expect(resp('Engineer', 2).sessionKey).toBe(engR2[0]);
    expect(resp('Architect', 1).consensus).toBe(false);
    expect(resp('Engineer', 1).consensus).toBe(false);
    expect(resp('Architect', 2).consensus).toBe(true);
    expect(resp('Engineer', 2).consensus).toBe(true);

    const ledger = mgr.getRunLedger({ since: '1h' }).rows;
    for (const name of [archR1[0]!, engR1[0]!, archR2[0]!, engR2[0]!]) {
      const owned = ledger.filter((r) => r.session === name);
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every((r) => r.parent === session.id)).toBe(true);
    }
  });

  it('allows a second council execution after the first settles', { timeout: 60_000 }, async () => {
    const mgr = makeManager();
    const project = trackProject(gitProject('second'));
    const names: string[] = [];

    (mgr as unknown as { _createSession: (engine: string, config: SessionConfig) => ISession })._createSession = (
      _engine,
      config,
    ) => {
      if (config.name) names.push(config.name);
      return new FakeEngine(config, { bodyFor: () => REPORT });
    };

    const first = await mgr.councilStart('First execution control task text', {
      agents: [architectAgent()],
      maxRounds: 1,
      projectDir: project,
    });
    await waitRun(mgr, first.id);
    const afterFirst = names.length;

    const second = await mgr.councilStart('Second execution control task text', {
      agents: [architectAgent()],
      maxRounds: 1,
      projectDir: project,
    });
    await waitRun(mgr, second.id);

    expect(second.id).not.toBe(first.id);
    expect(names.length).toBeGreaterThan(afterFirst);
    expect(names.some((n) => n.includes(first.id))).toBe(true);
    expect(names.some((n) => n.includes(second.id))).toBe(true);
    expect(mgr.councilStatus(first.id)?.responses[0]?.sessionKey).toContain(first.id);
    expect(mgr.councilStatus(second.id)?.responses[0]?.sessionKey).toContain(second.id);
  });

  it('standalone Council without runId uses a full UUID in the member session name', { timeout: 60_000 }, async () => {
    const mgr = makeManager();
    const project = trackProject(gitProject('standalone'));
    let startedName = '';

    (mgr as unknown as { _createSession: (engine: string, config: SessionConfig) => ISession })._createSession = (
      _engine,
      config,
    ) => {
      startedName = config.name ?? '';
      return new FakeEngine(config, { bodyFor: () => REPORT });
    };

    const council = new Council(
      {
        agents: [architectAgent()],
        maxRounds: 1,
        projectDir: project,
      },
      mgr,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
    );
    const session = await council.run('Standalone council UUID naming control task');
    expect(isValidRunId(session.id)).toBe(true);
    expect(startedName).toContain(session.id);
    expect(startedName).toMatch(/Architect-r1$/);
    expect(session.responses[0]?.sessionKey).toBe(startedName);
  });
});
