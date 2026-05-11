/**
 * Unit tests for autoloop runner skeleton (S1 — no real LLM).
 *
 * Strategy: inject a scripted AgentDispatcher that produces canned replies, then
 * drive the runner through a representative iter and assert routing invariants.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  type AnyAutoloopMessage,
  AutoloopRoutingError,
  Msg,
  deserialise,
  serialise,
  validateMessage,
} from '../autoloop/messages.js';
import { AutoloopRunner } from '../autoloop/runner.js';
import type { AgentDispatcher, AutoloopConfig } from '../autoloop/types.js';

function makeRunner(
  dispatcher: AgentDispatcher,
  recordedPushes: AnyAutoloopMessage[] = [],
  overrides: Partial<AutoloopConfig> = {},
): {
  runner: AutoloopRunner;
  pushes: Array<{ level: string; summary: string }>;
} {
  const pushes: Array<{ level: string; summary: string }> = [];
  const config: AutoloopConfig = {
    run_id: 'test-run',
    workspace: '/tmp/test',
    ledger_dir: '/tmp/test/ledger',
    notifyUser: async (level, summary) => {
      pushes.push({ level, summary });
      void recordedPushes;
    },
    dispatcher,
    // Disable the real interval timer in tests by default.
    stallCheckIntervalMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
  const runner = new AutoloopRunner(config);
  return { runner, pushes };
}

describe('autoloop messages', () => {
  it('Msg constructors build well-formed envelopes', () => {
    const e = Msg.chat(0, { text: 'hello' });
    expect(e.from).toBe('user');
    expect(e.to).toBe('planner');
    expect(e.type).toBe('chat');
    expect(e.payload.text).toBe('hello');
    expect(typeof e.msg_id).toBe('string');
    expect(typeof e.ts).toBe('string');
  });

  it('serialise → deserialise round-trips', () => {
    const e = Msg.directive(3, {
      goal: 'fix add_two',
      constraints: ['no new files'],
      success_criteria: ['gate A green'],
      max_attempts: 2,
    });
    const { text, summary } = serialise(e);
    expect(summary).toBe('directive');
    const back = deserialise(text);
    expect(back).toEqual(e);
  });

  it('validateMessage accepts the canonical 11 routes', () => {
    expect(() => validateMessage(Msg.chat(0, { text: 'x' }))).not.toThrow();
    expect(() =>
      validateMessage(Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 })),
    ).not.toThrow();
    expect(() => validateMessage(Msg.terminate(0, { reason: 'done' }))).not.toThrow();
  });

  it('validateMessage rejects bogus routes', () => {
    const bad: AnyAutoloopMessage = {
      msg_id: 'x',
      iter: 0,
      from: 'coder',
      to: 'user', // coder cannot talk to user directly
      type: 'iter_artifacts',
      ts: new Date().toISOString(),
      payload: { diff: '', eval_output: {}, files_changed: [] },
    } as AnyAutoloopMessage;
    expect(() => validateMessage(bad)).toThrow(AutoloopRoutingError);
  });
});

describe('AutoloopRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains a full iter: chat → directive → ack → artifacts → verdict → iter_done', async () => {
    const observed: string[] = [];

    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        observed.push(`${env.from}->${env.to}:${env.type}`);
        // Planner receives chat → emits directive to coder.
        if (env.type === 'chat') {
          return [Msg.directive(env.iter, { goal: 'fix', constraints: [], success_criteria: [], max_attempts: 1 })];
        }
        // Coder receives directive → ack + artifacts.
        if (env.type === 'directive') {
          return [
            Msg.directiveAck(env.iter, { understood: true }),
            Msg.iterArtifacts(env.iter, { diff: 'patch', eval_output: { metric: 0.9 }, files_changed: ['a.py'] }),
          ];
        }
        // Reviewer receives review_request → verdict.
        if (env.type === 'review_request') {
          return [Msg.reviewVerdict(env.iter, { decision: 'advance', metric: 0.9, audit_notes: 'ok' })];
        }
        // Planner receives directive_ack and iter_done → no reply (terminal).
        return [];
      },
    };

    const { runner } = makeRunner(dispatcher);
    await runner.start();

    let iterDoneEvent: { iter: number; verdict: string; metric: number | null } | null = null;
    runner.on('iter_done', (p) => (iterDoneEvent = p));

    await runner.chat('do the thing');

    // Sequence we expect to have observed at the dispatcher boundary:
    expect(observed).toEqual([
      'user->planner:chat',
      'planner->coder:directive',
      'coder->planner:directive_ack',
      'runner->reviewer:review_request',
      'runner->planner:iter_done',
    ]);
    expect(iterDoneEvent).toEqual({ iter: 0, verdict: 'advance', metric: 0.9 });
  });

  it('terminate halts further dispatch', async () => {
    const dispatcher: AgentDispatcher = {
      async deliver() {
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher);
    await runner.start();

    let terminatedReason: string | null = null;
    runner.on('terminated', (r) => (terminatedReason = r));

    await runner.send(Msg.terminate(0, { reason: 'user-request' }));
    expect(terminatedReason).toBe('user-request');
    expect(runner.state.status).toBe('terminated');
  });

  it('pause/resume flips status', async () => {
    const dispatcher: AgentDispatcher = {
      async deliver() {
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher);
    await runner.start();
    runner.markSubagentsSpawned();
    expect(runner.state.status).toBe('running');

    await runner.send(Msg.pause(0, { reason: 'user-pause' }));
    expect(runner.state.status).toBe('paused');

    await runner.send(Msg.resume(0));
    expect(runner.state.status).toBe('running');
  });

  it('push_user dedups identical events within 5 min', async () => {
    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        if (env.type === 'chat') {
          return [
            Msg.pushUser(0, { level: 'info', summary: 'hello', channel: 'auto' }),
            Msg.pushUser(0, { level: 'info', summary: 'hello', channel: 'auto' }), // dup
            Msg.pushUser(0, { level: 'info', summary: 'different', channel: 'auto' }),
          ];
        }
        return [];
      },
    };
    const { runner, pushes } = makeRunner(dispatcher);
    await runner.start();
    await runner.chat('go');
    expect(pushes).toEqual([
      { level: 'info', summary: 'hello' },
      { level: 'info', summary: 'different' },
    ]);
    expect(runner.state.push_log_count).toBe(2);
  });

  it('two consecutive holds trigger reviewer-reject policy push', async () => {
    let iterCount = 0;
    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        if (env.type === 'chat' || env.type === 'iter_done') {
          iterCount++;
          if (iterCount > 2) return []; // bail after 2 iters
          return [Msg.directive(iterCount, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 })];
        }
        if (env.type === 'directive') {
          return [Msg.iterArtifacts(env.iter, { diff: 'p', eval_output: {}, files_changed: [] })];
        }
        if (env.type === 'review_request') {
          return [Msg.reviewVerdict(env.iter, { decision: 'hold', metric: null, audit_notes: 'gate fail' })];
        }
        return [];
      },
    };
    const { runner, pushes } = makeRunner(dispatcher);
    await runner.start();
    await runner.chat('start');
    // After 2 holds, on_reviewer_reject_2 should fire.
    const rejectPush = pushes.find((p) => p.summary.includes('on_reviewer_reject_2'));
    expect(rejectPush).toBeDefined();
  });

  it('state.iter advances after each iter_done', async () => {
    let directiveCount = 0;
    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        if (env.type === 'chat' || env.type === 'iter_done') {
          if (directiveCount >= 2) return [];
          // Mock Planner picks the next iter by advancing past the iter_done's
          // iter (matches the production dispatcher's iter-bump logic).
          const nextIter = env.type === 'iter_done' ? env.iter + 1 : 0;
          directiveCount += 1;
          return [Msg.directive(nextIter, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 })];
        }
        if (env.type === 'directive') {
          return [Msg.iterArtifacts(env.iter, { diff: '', eval_output: {}, files_changed: [] })];
        }
        if (env.type === 'review_request') {
          return [Msg.reviewVerdict(env.iter, { decision: 'advance', metric: 0.5, audit_notes: 'ok' })];
        }
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher);
    await runner.start();
    expect(runner.state.iter).toBe(0);
    await runner.chat('go');
    // After two iters of advance verdicts, state.iter should have advanced
    // from 0 → 1 → 2.
    expect(runner.state.iter).toBe(2);
    runner.stop();
  });

  it('pause parks agent-bound messages and resume replays them in order', async () => {
    const delivered: string[] = [];
    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        delivered.push(env.type);
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher);
    await runner.start();
    runner.markSubagentsSpawned();

    await runner.send(Msg.pause(0, { reason: 'manual' }));
    expect(runner.state.status).toBe('paused');

    // While paused, agent-bound messages park.
    await runner.send(Msg.directive(0, { goal: 'g', constraints: [], success_criteria: [], max_attempts: 1 }));
    expect(delivered).toEqual([]);

    // Resume: parked messages drain in arrival order.
    await runner.send(Msg.resume(0));
    expect(runner.state.status).toBe('running');
    expect(delivered).toEqual(['directive']);
    runner.stop();
  });

  it('phase_error trips circuit after threshold (default 3) → auto-terminate', async () => {
    const dispatcher: AgentDispatcher = {
      async deliver() {
        return [];
      },
    };
    const { runner, pushes } = makeRunner(dispatcher, [], { phaseErrorCircuit: 3 });
    await runner.start();

    let terminatedReason: string | null = null;
    runner.on('terminated', (r) => (terminatedReason = r));

    for (let i = 0; i < 3; i++) {
      await runner.send(Msg.phaseError(0, { agent: 'coder', phase: 'send', error: `boom ${i}` }));
    }
    expect(runner.state.status).toBe('terminated');
    expect(terminatedReason).toBe('phase_error_circuit');
    expect(runner.state.consecutive_phase_errors).toBe(3);
    // A decision-level push should be emitted before terminate.
    const decisionPush = pushes.find((p) => p.level === 'decision' && p.summary.includes('phase-error circuit'));
    expect(decisionPush).toBeDefined();
    // An on_phase_error policy push fires for each error too.
    const errorPushes = pushes.filter((p) => p.summary.includes('on_phase_error'));
    expect(errorPushes.length).toBeGreaterThanOrEqual(1); // dedup may collapse to 1
    runner.stop();
  });

  it('successful iter_done resets consecutive_phase_errors', async () => {
    const dispatcher: AgentDispatcher = {
      async deliver() {
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher, [], { phaseErrorCircuit: 5 });
    await runner.start();

    await runner.send(Msg.phaseError(0, { agent: 'coder', phase: 'send', error: 'x' }));
    expect(runner.state.consecutive_phase_errors).toBe(1);

    // Drive an advance verdict through the runner inbox.
    await runner.send(Msg.iterArtifacts(0, { diff: '', eval_output: {}, files_changed: [] }));
    await runner.send(Msg.reviewVerdict(0, { decision: 'advance', metric: 0.7, audit_notes: 'ok' }));
    expect(runner.state.consecutive_phase_errors).toBe(0);
    expect(runner.state.recent_phase_errors).toEqual([]);
    runner.stop();
  });

  it('prior_metrics accumulates from verdict metrics across iters', async () => {
    const requests: Array<number[]> = [];
    const dispatcher: AgentDispatcher = {
      async deliver(env) {
        if (env.type === 'review_request') {
          requests.push([...(env.payload.prior_metrics ?? [])]);
          return [];
        }
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher);
    await runner.start();

    // Iter 0 verdict (metric 0.1)
    await runner.send(Msg.iterArtifacts(0, { diff: '', eval_output: {}, files_changed: [] }));
    await runner.send(Msg.reviewVerdict(0, { decision: 'advance', metric: 0.1, audit_notes: '' }));
    // Iter 1 verdict (metric 0.3)
    await runner.send(Msg.iterArtifacts(1, { diff: '', eval_output: {}, files_changed: [] }));
    await runner.send(Msg.reviewVerdict(1, { decision: 'advance', metric: 0.3, audit_notes: '' }));
    // Iter 2 review_request should observe both prior metrics.
    await runner.send(Msg.iterArtifacts(2, { diff: '', eval_output: {}, files_changed: [] }));

    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual([]); // before any verdict
    expect(requests[1]).toEqual([0.1]); // after iter 0
    expect(requests[2]).toEqual([0.1, 0.3]); // after iter 1
    runner.stop();
  });

  it('stall detector fires on_stall_30min when idle past stallMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const dispatcher: AgentDispatcher = {
      async deliver() {
        return [];
      },
    };
    const { runner, pushes } = makeRunner(dispatcher, [], {
      stallMs: 1000,
      stallCheckIntervalMs: 100,
    });
    await runner.start();
    runner.markSubagentsSpawned();
    // Advance fake clock past stallMs so the interval observes a stalled run.
    await vi.advanceTimersByTimeAsync(1500);
    // Flush queued microtasks (firePolicyPush is async).
    await vi.advanceTimersByTimeAsync(0);
    const stallPush = pushes.find((p) => p.summary.includes('on_stall_30min'));
    expect(stallPush).toBeDefined();
    runner.stop();
    vi.useRealTimers();
  });

  it('rejects invalid envelopes via validateMessage', async () => {
    const dispatcher: AgentDispatcher = {
      async deliver() {
        return [];
      },
    };
    const { runner } = makeRunner(dispatcher);
    await runner.start();
    const bogus = {
      msg_id: 'x',
      iter: 0,
      from: 'reviewer',
      to: 'coder',
      type: 'directive',
      ts: new Date().toISOString(),
      payload: { goal: 'x', constraints: [], success_criteria: [], max_attempts: 1 },
    } as AnyAutoloopMessage;
    await expect(runner.send(bogus)).rejects.toThrow(AutoloopRoutingError);
  });
});
