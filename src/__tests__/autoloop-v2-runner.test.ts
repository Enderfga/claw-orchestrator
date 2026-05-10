/**
 * Unit tests for autoloop v2 runner skeleton (S1 — no real LLM).
 *
 * Strategy: inject a scripted AgentDispatcher that produces canned replies, then
 * drive the runner through a representative iter and assert routing invariants.
 */

import { describe, it, expect } from 'vitest';
import {
  type AnyAutoloopV2Message,
  AutoloopV2RoutingError,
  Msg,
  deserialise,
  serialise,
  validateMessage,
} from '../autoloop/v2/messages.js';
import { AutoloopV2Runner } from '../autoloop/v2/runner.js';
import type { AgentDispatcher, AutoloopV2Config } from '../autoloop/v2/types.js';

function makeRunner(
  dispatcher: AgentDispatcher,
  recordedPushes: AnyAutoloopV2Message[] = [],
): {
  runner: AutoloopV2Runner;
  pushes: Array<{ level: string; summary: string }>;
} {
  const pushes: Array<{ level: string; summary: string }> = [];
  const config: AutoloopV2Config = {
    run_id: 'test-run',
    workspace: '/tmp/test',
    ledger_dir: '/tmp/test/ledger',
    notifyUser: async (level, summary) => {
      pushes.push({ level, summary });
      void recordedPushes;
    },
    dispatcher,
  };
  return { runner: new AutoloopV2Runner(config), pushes };
}

describe('autoloop v2 messages', () => {
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
    const bad: AnyAutoloopV2Message = {
      msg_id: 'x',
      iter: 0,
      from: 'coder',
      to: 'user', // coder cannot talk to user directly
      type: 'iter_artifacts',
      ts: new Date().toISOString(),
      payload: { diff: '', eval_output: {}, files_changed: [] },
    } as AnyAutoloopV2Message;
    expect(() => validateMessage(bad)).toThrow(AutoloopV2RoutingError);
  });
});

describe('AutoloopV2Runner', () => {
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
    } as AnyAutoloopV2Message;
    await expect(runner.send(bogus)).rejects.toThrow(AutoloopV2RoutingError);
  });
});
