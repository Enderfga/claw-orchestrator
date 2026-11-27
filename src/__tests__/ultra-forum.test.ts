/**
 * Ultraplan and ultrareview on the run forum.
 *
 * The mode paths run the real public API, kernel, agent and fan-out nodes and
 * Fanout down to a scripted engine session, as `invariants.test.ts` does: what
 * is checked is what each session was sent and what the forum holds. The
 * projections and the ACP poll are checked on their own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as acp from '@agentclientprotocol/sdk';
import type {
  CostBreakdown,
  EffortLevel,
  ISession,
  SessionConfig,
  SessionSendOptions,
  SessionStats,
  TurnResult,
} from '../types.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ultra-forum-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAWO_WF_DIR = path.join(HOME, 'wf');
const { SessionManager } = await import('../session-manager.js');
const { createAcpAgent } = await import('../acp-server.js');
const { nullLogger } = await import('../logger.js');
const { loadRun } = await import('../kernel/store.js');
const { forumRuntimePost, forumSnapshot } = await import('../kernel/forum.js');
const { joinFindings, replyBlocksAsText, toUltraplanResult, toUltrareviewResult, ULTRAREVIEW_FAIL_TITLES } =
  await import('../kernel/projections.js');
const { ULTRAPLAN_FORUM_NORMS, ULTRAREVIEW_FORUM_NORMS } = await import('../kernel/templates/index.js');
type SessionManager = InstanceType<typeof SessionManager>;
type RunRecord = import('../kernel/types.js').RunRecord;
type ForumPost = import('../kernel/forum.js').ForumPost;

// ─── A scripted engine session ──────────────────────────────────────────────

/** What one session is to answer: text streamed and returned, optionally after `hold` resolves. */
interface Script {
  reply: string;
  hold?: Promise<void>;
}

/** Every session the manager created, with its config and what it was sent. */
interface Observed {
  config: Partial<SessionConfig>;
  messages: string[];
  midTurn: string[];
}

class ScriptedSession extends EventEmitter implements ISession {
  sessionId?: string;
  private turns = 0;
  constructor(
    private readonly seen: Observed,
    private readonly script: Script,
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
    return false;
  }
  async start(): Promise<this> {
    this.sessionId = `scripted-${Math.random().toString(36).slice(2, 8)}`;
    return this;
  }
  stop(): void {}
  pause(): void {}
  resume(): void {}
  async send(message: string | unknown[], options?: SessionSendOptions): Promise<TurnResult> {
    this.seen.messages.push(typeof message === 'string' ? message : JSON.stringify(message));
    options?.callbacks?.onText?.(this.script.reply);
    if (this.script.hold) await this.script.hold;
    this.turns++;
    return { text: this.script.reply, event: { type: 'result', result: this.script.reply } };
  }
  /** Takes text mid-turn, as a Claude or codex-app session does. */
  async deliverMidTurn(text: string): Promise<boolean> {
    this.seen.midTurn.push(text);
    return true;
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
      startTime: null,
      lastActivity: null,
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
      model: 'scripted',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: 0 },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: '', event: { type: 'result', result: '' } };
  }
  getEffort(): EffortLevel {
    return 'auto';
  }
  setEffort(): void {}
  resolveModel(alias: string): string {
    return alias;
  }
}

let observed: Observed[] = [];
let mgr: SessionManager;
const dirs: string[] = [];

/** A manager whose engine sessions answer by `script` (keyed by the end of the session name). */
function makeManager(script: (name: string) => Script, maxConcurrentSessions = 8): SessionManager {
  const m = new SessionManager({ maxConcurrentSessions }, nullLogger);
  (m as unknown as { _createSession: (e: string, c: Partial<SessionConfig>) => ISession })._createSession = (
    _engine,
    config,
  ) => {
    const seen: Observed = { config, messages: [], midTurn: [] };
    observed.push(seen);
    return new ScriptedSession(seen, script(config.name ?? '')) as unknown as ISession;
  };
  return m;
}

const wait = (id: string): Promise<unknown> =>
  (mgr as unknown as { kernel: { wait(id: string): Promise<unknown> } }).kernel.wait(id);

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ultra-forum-cwd-'));
  dirs.push(dir);
  return dir;
}

/** A gate a scripted turn waits on. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const block = (title: string, body: string) => `<new-forum-post title="${title}">${body}</new-forum-post>`;

beforeEach(() => {
  observed = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-ultra-forum-'));
  dirs.push(tmp);
  process.env.CLAWO_WF_DIR = path.join(tmp, 'wf');
  process.env.CLAWO_FORUM_SPOOL_ROOT = path.join(tmp, 'spool');
});

afterEach(async () => {
  await mgr?.shutdown();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ─── Ultrareview ────────────────────────────────────────────────────────────

describe('ultrareview on the forum', () => {
  it('puts every reviewer on the forum by default, write-only, with the brief after its persona', async () => {
    mgr = makeManager(() => ({ reply: 'nothing found' }));
    const review = await mgr.ultrareviewStart(tempDir(), { agentCount: 2 });
    await wait(review.id);

    const spec = loadRun(review.id)!.spec;
    expect(spec.forum).toEqual({});
    expect(spec.nodes[0]).toMatchObject({
      forumBriefAfter: true,
      forumCanRead: false,
      forumNorms: ULTRAREVIEW_FORUM_NORMS,
    });

    const reviewers = observed.filter((o) => !o.config.name?.endsWith('-synthesis'));
    expect(reviewers).toHaveLength(2);
    for (const r of reviewers) {
      const message = r.messages[0];
      // The persona is still the first line; the brief comes after the task.
      expect(message.split('\n')[0]).toMatch(/^You are a .* (expert|analyst)\./);
      expect(message.indexOf('# Code Review Task')).toBeLessThan(
        message.indexOf('You post to it; you do not read it.'),
      );
      expect(message).toContain('FAIL: <file>:<line>');
      expect(message).not.toContain('The forum now:');
    }
    // Every session the review started is the run's.
    expect(observed.length).toBe(3);
    expect(observed.every((o) => o.config.ownerRunId === review.id)).toBe(true);
  });

  it('keeps reviewers independent: one reviewer is never shown another one’s findings', async () => {
    // One session slot: the reviewers run one after the other, so the second
    // joins a forum that already holds the first one's FAIL.
    mgr = makeManager(
      (name) =>
        name.endsWith('-SecurityReviewer')
          ? { reply: block('FAIL: src/db.ts:42 SQL built by concatenation', 'query(`… ${id}`)') }
          : { reply: block('DONE: 0 findings', 'Nothing in my area.') },
      1,
    );
    const review = await mgr.ultrareviewStart(tempDir(), { agentCount: 2 });
    await wait(review.id);

    const second = observed.find((o) => o.config.name?.endsWith('-LogicReviewer'))!;
    expect(second.messages[0]).toContain('You post to it; you do not read it.');
    expect(second.messages[0]).not.toContain('SQL built by concatenation');
    const joins = forumSnapshot(review.id).events.filter((e) => e.type === 'join');
    expect(joins.filter((e) => e.who.endsWith('Reviewer')).every((e) => e.type === 'join' && e.canRead === false)).toBe(
      true,
    );

    const status = mgr.ultrareviewStatus(review.id)!;
    expect(status.status).toBe('completed');
    expect(status.forum?.failTitles).toEqual(['SecurityReviewer: FAIL: src/db.ts:42 SQL built by concatenation']);
    expect(status.forum?.posts).toBeGreaterThanOrEqual(2);
    expect(status.forum?.openAsks).toEqual([]);
  });

  it('shows the findings posted so far while the review runs, and the whole report at the end', async () => {
    const release = gate();
    mgr = makeManager(() => ({
      reply: `Reviewed the store.\n${block('FAIL: src/store.ts:7 lock never released', 'return before unlock')}\n${block('DONE: 1 findings', '')}`,
      hold: release.promise,
    }));
    const review = await mgr.ultrareviewStart(tempDir(), { agentCount: 1 });

    await expect
      .poll(() => mgr.ultrareviewStatus(review.id)?.forum?.failTitles, { timeout: 5_000 })
      .toEqual(['SecurityReviewer: FAIL: src/store.ts:7 lock never released']);
    const running = mgr.ultrareviewStatus(review.id)!;
    expect(running.status).toBe('running');
    expect(running.findings).toBeUndefined();

    release.open();
    await wait(review.id);
    const done = mgr.ultrareviewStatus(review.id)!;
    expect(done.status).toBe('completed');
    // One reviewer, no synthesis: the joined output, its blocks shown as text.
    expect(done.findings).toContain('## SecurityReviewer');
    expect(done.findings).toContain('**FAIL: src/store.ts:7 lock never released**\n\nreturn before unlock');
    expect(done.findings).not.toContain('<new-forum-post');
  });

  it('runs without a forum when forum is false', async () => {
    mgr = makeManager(() => ({ reply: 'found a bug in src/a.ts:1' }));
    const review = await mgr.ultrareviewStart(tempDir(), { agentCount: 1, forum: false });
    await wait(review.id);

    expect(loadRun(review.id)!.spec.forum).toBeUndefined();
    const reviewer = observed[0];
    expect(reviewer.messages[0]).not.toContain('forum');
    const status = mgr.ultrareviewStatus(review.id)!;
    expect(status.forum).toBeUndefined();
    expect(status.findings).toBe('## SecurityReviewer\n\nfound a bug in src/a.ts:1');
  });
});

// ─── Ultraplan ──────────────────────────────────────────────────────────────

describe('ultraplan on the forum', () => {
  it('puts the planner on the forum as `planner`, with the planning norms, and names its real session', async () => {
    mgr = makeManager(() => ({ reply: '# Plan\n\n1. Do it.' }));
    const plan = await mgr.ultraplanStart('add a cache', { cwd: tempDir() });
    await wait(plan.id);

    const spec = loadRun(plan.id)!.spec;
    expect(spec.forum).toEqual({});
    expect(spec.nodes[0]).toMatchObject({ id: 'main', forumName: 'planner', forumNorms: ULTRAPLAN_FORUM_NORMS });
    expect(observed).toHaveLength(1);
    const planner = observed[0];
    expect(planner.messages[0]).toContain('You are "planner"');
    expect(planner.messages[0]).toContain('ASK @user: <the question>');
    expect(planner.config.ownerRunId).toBe(plan.id);
    // The name the result gives is the session that ran.
    expect(plan.sessionName).toBe(planner.config.name);
    expect(mgr.ultraplanStatus(plan.id)!.sessionName).toBe(planner.config.name);
  });

  it('lists the planner’s question as an open ASK, takes the answer mid-turn, and returns the plan as text', async () => {
    const release = gate();
    mgr = makeManager(() => ({
      reply:
        `${block('ASK @user: Postgres or SQLite for the cache?', 'Postgres scales; SQLite is simpler. I recommend SQLite.')}\n` +
        `# Plan\n\n1. Add the cache.\n${block('DONE: plan', 'A cache in front of the store.')}`,
      hold: release.promise,
    }));
    const plan = await mgr.ultraplanStart('add a cache', { cwd: tempDir() });

    await expect.poll(() => mgr.ultraplanStatus(plan.id)?.openAsks?.length, { timeout: 5_000 }).toBe(1);
    const [ask] = mgr.ultraplanStatus(plan.id)!.openAsks!;
    expect(ask).toMatchObject({ from: 'planner', to: ['user'], title: 'ASK @user: Postgres or SQLite for the cache?' });

    // The caller's answer reaches the planner's turn in flight, as the user's word.
    mgr.workflowForum({ runId: plan.id, action: 'post', as: 'user', title: 'INFO: SQLite', body: 'SQLite is fine.' });
    const planner = observed[0];
    await expect.poll(() => planner.midTurn.length, { timeout: 5_000 }).toBe(1);
    expect(planner.midTurn[0]).toContain('From the user who started this run.');
    expect(planner.midTurn[0]).toContain('SQLite is fine.');

    // An answer that refers to the ASK closes it.
    await forumRuntimePost(plan.id, { from: 'user', title: 'INFO: use SQLite', re: [ask.id] });
    expect(mgr.ultraplanStatus(plan.id)!.openAsks).toEqual([]);

    release.open();
    await wait(plan.id);
    const done = mgr.ultraplanStatus(plan.id)!;
    expect(done.status).toBe('completed');
    expect(done.plan).toContain('# Plan');
    expect(done.plan).toContain('**DONE: plan**\n\nA cache in front of the store.');
    expect(done.plan).not.toContain('<new-forum-post');
  });

  it('runs without a forum when forum is false', async () => {
    mgr = makeManager(() => ({ reply: '# Plan' }));
    const plan = await mgr.ultraplanStart('add a cache', { cwd: tempDir(), forum: false });
    await wait(plan.id);

    expect(loadRun(plan.id)!.spec.forum).toBeUndefined();
    expect(observed[0].messages[0]).not.toContain('forum');
    expect(mgr.ultraplanStatus(plan.id)!.openAsks).toBeUndefined();
  });
});

// ─── Projections ────────────────────────────────────────────────────────────

describe('ultra projections', () => {
  const post = (over: Partial<ForumPost>): ForumPost => ({
    id: 'p00001',
    ts: '2026-01-01T00:00:00.000Z',
    from: 'SecurityReviewer',
    title: 'FAIL: a.ts:1 x',
    body: '',
    tags: ['FAIL'],
    to: [],
    re: [],
    ...over,
  });
  const record = (over: Partial<RunRecord> = {}): RunRecord =>
    ({
      runId: 'ultrareview-1',
      workflow: 'ultrareview',
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      spec: {
        name: 'ultrareview',
        nodes: [{ id: 'main', kind: 'fanout', prompt: 't', agents: [{ name: 'SecurityReviewer' }] }],
      },
      nodes: { main: { id: 'main', kind: 'fanout', state: 'running', attempts: 0, visits: 0 } },
      ...over,
    }) as unknown as RunRecord;

  it('shows forum blocks as text and leaves other text as it was', () => {
    const plain = 'line one\n\nline two\n';
    expect(replyBlocksAsText(plain)).toBe(plain);
    expect(replyBlocksAsText(`a\n${block('FAIL: x.ts:1 bad', 'why')}\nb`)).toBe('a\n**FAIL: x.ts:1 bad**\n\nwhy\nb');
    // No title attribute: the first line is the title.
    expect(replyBlocksAsText('<new-forum-post>DONE: 2 findings\nboth above</new-forum-post>')).toBe(
      '**DONE: 2 findings**\n\nboth above',
    );
    expect(
      joinFindings({
        task: 't',
        agentCount: 1,
        results: [{ agent: 'A', engine: 'claude', ok: true, output: block('FAIL: y', 'z'), durationMs: 1 }],
      }),
    ).toBe('## A\n\n**FAIL: y**\n\nz');
  });

  it('names the agent node’s session for its visit and attempt', () => {
    expect(toUltraplanResult(record({ runId: 'ultraplan-1' }), undefined).sessionName).toBe('ultraplan-1-main-v1a1');
    const later = record({
      runId: 'ultraplan-1',
      nodes: { main: { id: 'main', kind: 'agent', state: 'running', attempts: 3, visits: 2 } },
    });
    expect(toUltraplanResult(later, undefined).sessionName).toBe('ultraplan-1-main-v2a3');
  });

  it('lists only the reviewers’ FAIL posts, at most a bounded number, and every open ASK', () => {
    const many = Array.from({ length: ULTRAREVIEW_FAIL_TITLES + 5 }, (_, i) =>
      post({ id: `p${String(i + 1).padStart(5, '0')}`, title: `FAIL: f.ts:${i} n` }),
    );
    const ask = post({
      id: 'p09000',
      from: 'SecurityReviewer',
      title: 'ASK @user: scope?',
      tags: ['ASK'],
      to: ['user'],
    });
    const others = [
      post({ id: 'p09001', from: 'orchestrator', title: 'FAIL: run failed' }),
      post({ id: 'p09002', from: 'synthesis', title: 'FAIL: a.ts:1 x' }),
      post({ id: 'p09003', title: 'DONE: 1 findings', tags: ['DONE'] }),
    ];
    const result = toUltrareviewResult(record(), undefined, { posts: [...many, ask, ...others], openAsks: [ask] });
    expect(result.forum!.posts).toBe(many.length + 4);
    expect(result.forum!.failTitles).toHaveLength(ULTRAREVIEW_FAIL_TITLES);
    expect(result.forum!.failTitles[0]).toBe('SecurityReviewer: FAIL: f.ts:0 n');
    expect(result.forum!.openAsks).toEqual([
      { id: 'p09000', from: 'SecurityReviewer', to: ['user'], title: 'ASK @user: scope?' },
    ]);
    expect(toUltrareviewResult(record(), undefined).forum).toBeUndefined();
  });
});

// ─── ACP polling mode ───────────────────────────────────────────────────────

type Update = Record<string, unknown>;

async function connectAgent(manager: object, cwd: string) {
  const updates: Update[] = [];
  const app = createAcpAgent(manager as never, { defaultModel: 'claude-sonnet-4-6' });
  const conn = acp
    .client({ name: 'test-editor' })
    .onNotification('session/update', (ctx) => void updates.push(ctx.params.update as unknown as Update))
    .connect(app);
  await conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await conn.agent.request('session/new', { cwd, mcpServers: [] });
  const prompt = (text: string) =>
    conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  return { conn, updates, prompt };
}

/** A manager whose ultrareview finishes on the second status read, with posts on its forum by then. */
function pollingManager(forum: 'posts' | 'none') {
  let reads = 0;
  return {
    async startSession(config: Record<string, unknown>) {
      return { name: String(config.name) };
    },
    async sendMessage() {
      return { output: '' };
    },
    async stopSession() {},
    async ultrareviewStart() {
      return { id: 'ultrareview-acp' };
    },
    ultrareviewStatus() {
      reads++;
      return reads < 2 ? { status: 'running' } : { status: 'completed', findings: 'two findings' };
    },
    ...(forum === 'posts'
      ? {
          workflowForum() {
            return [
              { id: 'p00001', from: 'SecurityReviewer', title: 'FAIL: src/db.ts:42 SQL built by concatenation' },
              { id: 'p00002', from: 'LogicReviewer', title: 'DONE: 0 findings' },
            ];
          },
        }
      : {
          workflowForum() {
            throw new Error("Workflow run 'ultrareview-acp' has no forum");
          },
        }),
  };
}

describe('ACP ultra modes', () => {
  it('streams the titles of new forum posts as thoughts', async () => {
    const { conn, updates, prompt } = await connectAgent(pollingManager('posts'), tempDir());
    await expect(prompt('/ultrareview find bugs')).resolves.toMatchObject({ stopReason: 'end_turn' });
    const thoughts = updates
      .filter((u) => u.sessionUpdate === 'agent_thought_chunk')
      .map((u) => (u.content as { text: string }).text);
    expect(thoughts).toEqual([
      '\nSecurityReviewer: FAIL: src/db.ts:42 SQL built by concatenation\nLogicReviewer: DONE: 0 findings\n',
    ]);
    conn.close();
  }, 15_000);

  it('keeps the plain heartbeat for a run with no forum', async () => {
    const { conn, updates, prompt } = await connectAgent(pollingManager('none'), tempDir());
    await expect(prompt('/ultrareview find bugs')).resolves.toMatchObject({ stopReason: 'end_turn' });
    const thoughts = updates
      .filter((u) => u.sessionUpdate === 'agent_thought_chunk')
      .map((u) => (u.content as { text: string }).text);
    expect(thoughts).toEqual(['.']);
    conn.close();
  }, 15_000);
});
