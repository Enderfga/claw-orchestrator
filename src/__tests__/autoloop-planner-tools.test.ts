/**
 * Tests for the Planner tool-call parser + handler.
 */

import { describe, it, expect } from 'vitest';
import { applyPlannerToolCalls, parsePlannerReply, type PlannerToolEffects } from '../autoloop/planner-tools.js';
import type { AnyAutoloopMessage } from '../autoloop/messages.js';

function makeMockEffects(): {
  fx: PlannerToolEffects;
  calls: string[];
  policyDelta: Record<string, unknown>;
  writes: Array<{ file: string; content: string; msg?: string }>;
} {
  const calls: string[] = [];
  const policyDelta: Record<string, unknown> = {};
  const writes: Array<{ file: string; content: string; msg?: string }> = [];
  const fx: PlannerToolEffects = {
    spawnSubagents: async (args) => {
      calls.push(`spawnSubagents:${JSON.stringify(args)}`);
    },
    updatePushPolicy: (delta) => {
      Object.assign(policyDelta, delta);
      calls.push(`updatePushPolicy:${JSON.stringify(delta)}`);
    },
    writePlanFile: async (file, content, msg) => {
      writes.push({ file, content, msg });
      calls.push(`write:${file}:${msg ?? ''}`);
    },
  };
  return { fx, calls, policyDelta, writes };
}

describe('parsePlannerReply', () => {
  it('extracts a single autoloop block and strips it from the reply', () => {
    const reply = `Sure, here's the plan.

\`\`\`autoloop
{"tool": "notify_user", "args": {"level": "info", "summary": "plan ready"}}
\`\`\`

Let me know if you want to adjust.`;
    const { calls, cleaned_reply, parse_errors } = parsePlannerReply(reply);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('notify_user');
    expect(calls[0].args.summary).toBe('plan ready');
    expect(parse_errors).toEqual([]);
    expect(cleaned_reply).not.toContain('autoloop');
    expect(cleaned_reply).toContain("Sure, here's the plan.");
    expect(cleaned_reply).toContain('Let me know if you want to adjust.');
  });

  it('extracts multiple blocks in order', () => {
    const reply = `\`\`\`autoloop
{"tool": "write_plan", "args": {"content": "# Plan\\n..."}}
\`\`\`

then

\`\`\`autoloop
{"tool": "spawn_subagents", "args": {"coder_model": "sonnet"}}
\`\`\``;
    const { calls } = parsePlannerReply(reply);
    expect(calls.map((c) => c.tool)).toEqual(['write_plan', 'spawn_subagents']);
  });

  it('records parse errors but keeps going on malformed blocks', () => {
    const reply = `\`\`\`autoloop
{not valid json
\`\`\`

\`\`\`autoloop
{"tool": "terminate", "args": {"reason": "ok"}}
\`\`\``;
    const { calls, parse_errors } = parsePlannerReply(reply);
    expect(parse_errors).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('terminate');
  });

  it('rejects blocks missing tool/args fields', () => {
    const reply = `\`\`\`autoloop
{"args": {"x": 1}}
\`\`\``;
    const { calls, parse_errors } = parsePlannerReply(reply);
    expect(calls).toEqual([]);
    expect(parse_errors).toHaveLength(1);
  });
});

describe('applyPlannerToolCalls', () => {
  it('notify_user becomes a push_user envelope', async () => {
    const { fx } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [{ tool: 'notify_user', args: { level: 'info', summary: 'hi', channel: 'wechat' } }],
      fx,
      0,
    );
    expect(r.errors).toEqual([]);
    expect(r.emitted_messages).toHaveLength(1);
    const env = r.emitted_messages[0];
    expect(env.type).toBe('push_user');
    expect(env.from).toBe('planner');
    expect(env.to).toBe('user');
    if (env.type === 'push_user') {
      expect(env.payload.summary).toBe('hi');
      expect(env.payload.channel).toBe('wechat');
    }
  });

  it('spawn_subagents calls effect AND emits initial directive when present', async () => {
    const { fx, calls } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [
        {
          tool: 'spawn_subagents',
          args: {
            coder_model: 'sonnet',
            initial_directive: { goal: 'ship it', constraints: ['no new deps'] },
          },
        },
      ],
      fx,
      3,
    );
    expect(r.errors).toEqual([]);
    expect(calls.some((c) => c.startsWith('spawnSubagents:'))).toBe(true);
    expect(r.emitted_messages).toHaveLength(1);
    const env = r.emitted_messages[0];
    expect(env.type).toBe('directive');
    if (env.type === 'directive') {
      expect(env.payload.goal).toBe('ship it');
      expect(env.payload.constraints).toEqual(['no new deps']);
    }
  });

  it('passes valid coder and reviewer engines to the spawn effect', async () => {
    const { fx, calls } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [
        {
          tool: 'spawn_subagents',
          args: { coder_engine: 'codex', reviewer_engine: 'gemini' },
        },
      ],
      fx,
      0,
    );

    expect(r.errors).toEqual([]);
    expect(calls).toEqual(['spawnSubagents:{"coder_engine":"codex","reviewer_engine":"gemini"}']);
  });

  it('only forwards the documented spawn fields to the effect', async () => {
    const { fx, calls } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [
        {
          tool: 'spawn_subagents',
          args: {
            coder_engine: 'codex',
            reviewer_model: 'reviewer-model',
            env: { SECRET: 'must-not-cross-boundary' },
            unknown_field: 'ignored',
          },
        },
      ],
      fx,
      0,
    );

    expect(r.errors).toEqual([]);
    expect(calls).toEqual(['spawnSubagents:{"coder_engine":"codex","reviewer_model":"reviewer-model"}']);
  });

  it('rejects unknown engines before spawning or emitting an initial directive', async () => {
    const { fx, calls } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [
        {
          tool: 'spawn_subagents',
          args: {
            coder_engine: 'not-real',
            initial_directive: { goal: 'must not run' },
          },
        },
      ],
      fx,
      0,
    );

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toContain('coder_engine');
    expect(r.errors[0].error).toContain('not-real');
    expect(calls).toEqual([]);
    expect(r.emitted_messages).toEqual([]);
  });

  it('rejects custom engine configs emitted by the Planner', async () => {
    const { fx, calls } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [
        {
          tool: 'spawn_subagents',
          args: {
            coder_engine: 'custom',
            coder_custom_engine: { name: 'unsafe', bin: 'unsafe-cli', args: {} },
          },
        },
        {
          tool: 'spawn_subagents',
          args: {
            reviewer_engine: 'custom',
            reviewerCustomEngine: { name: 'unsafe', bin: 'unsafe-cli', args: {} },
          },
        },
      ],
      fx,
      0,
    );

    expect(r.errors).toHaveLength(2);
    expect(r.errors.every((entry) => entry.error.includes('custom engine config'))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('pause_loop / resume_loop / terminate emit runner-targeted envelopes', async () => {
    const { fx } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [
        { tool: 'pause_loop', args: { reason: 'rethink' } },
        { tool: 'resume_loop', args: {} },
        { tool: 'terminate', args: { reason: 'done' } },
      ],
      fx,
      0,
    );
    expect(r.emitted_messages.map((m: AnyAutoloopMessage) => m.type)).toEqual(['pause', 'resume', 'terminate']);
  });

  it('update_push_policy mutates via the effect', async () => {
    const { fx, policyDelta } = makeMockEffects();
    await applyPlannerToolCalls(
      [{ tool: 'update_push_policy', args: { on_iter_done_ok: { level: 'info', channel: 'wechat' } } }],
      fx,
      0,
    );
    expect(policyDelta.on_iter_done_ok).toEqual({ level: 'info', channel: 'wechat' });
  });

  it('records error for unknown tool names without throwing', async () => {
    const { fx } = makeMockEffects();
    const r = await applyPlannerToolCalls([{ tool: 'nonsense' as 'notify_user', args: {} }], fx, 0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].tool).toBe('nonsense');
  });

  it('records error when notify_user is missing summary', async () => {
    const { fx } = makeMockEffects();
    const r = await applyPlannerToolCalls([{ tool: 'notify_user', args: { level: 'info' } }], fx, 0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toContain('summary');
  });

  it('write_plan writes plan.md content via the effect', async () => {
    const { fx, writes } = makeMockEffects();
    const r = await applyPlannerToolCalls(
      [{ tool: 'write_plan', args: { content: '# Plan\n\n## Goal\nbuild it.\n', commit_message: 'first plan' } }],
      fx,
      0,
    );
    expect(r.errors).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0].file).toBe('plan.md');
    expect(writes[0].content).toContain('## Goal');
    expect(writes[0].msg).toBe('first plan');
  });

  it('write_goal validates JSON before delegating to the effect', async () => {
    const { fx, writes } = makeMockEffects();
    const ok = await applyPlannerToolCalls(
      [{ tool: 'write_goal', args: { content: '{"scalar":null,"gates":[]}' } }],
      fx,
      0,
    );
    expect(ok.errors).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0].file).toBe('goal.json');

    const bad = await applyPlannerToolCalls([{ tool: 'write_goal', args: { content: '{not json' } }], fx, 0);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].error).toMatch(/not valid JSON/);
    expect(writes).toHaveLength(1); // unchanged — bad call must not write
  });

  it('write_plan rejects empty content (would erase plan.md)', async () => {
    const { fx, writes } = makeMockEffects();
    const r = await applyPlannerToolCalls([{ tool: 'write_plan', args: { content: '   \n  ' } }], fx, 0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toContain('non-empty');
    expect(writes).toEqual([]);
  });
});
