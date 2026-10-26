#!/usr/bin/env node
// A scripted ACP agent for the `acp` engine's tests, built with the same SDK.
//
// Each prompt answers "echo:<text> turn=<n> session=<id>" after one tool call.
// Words in the prompt change the turn:
//   PERMISSION  ask the client for permission first; the answer's kind is in the reply
//   REFUSE      end the turn with stopReason "refusal"
//   SLOW        wait 3 s before answering
//   CRASH       exit the process mid-turn
// FIXTURE_LOAD=0 removes the loadSession capability; FIXTURE_NO_USAGE=1 drops usage.
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import { setTimeout } from 'node:timers';
import * as acp from '@agentclientprotocol/sdk';

const sessions = new Map();
let next = 0;
// FIXTURE_STDERR: a line the agent writes to stderr on start, as a failing CLI might.
if (process.env.FIXTURE_STDERR) process.stderr.write(`${process.env.FIXTURE_STDERR}\n`);

const app = acp
  .agent({ name: 'fixture-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: process.env.FIXTURE_LOAD !== '0' },
  }))
  .onRequest('session/new', (ctx) => {
    const id = `fx-${++next}-${process.pid}`;
    sessions.set(id, { turns: 0, cwd: ctx.params.cwd });
    return { sessionId: id };
  })
  .onRequest('session/load', async (ctx) => {
    const id = ctx.params.sessionId;
    const state = sessions.get(id) ?? { turns: Number(process.env.FIXTURE_PRIOR_TURNS ?? 0), cwd: ctx.params.cwd };
    sessions.set(id, state);
    // Replay, as the protocol requires: none of it belongs to the next turn.
    await ctx.client.notify('session/update', {
      sessionId: id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } },
    });
    await ctx.client.notify('session/update', {
      sessionId: id,
      update: { sessionUpdate: 'tool_call', toolCallId: 'replayed', title: 'old call', status: 'completed' },
    });
    return {};
  })
  .onRequest('session/prompt', async (ctx) => {
    const id = ctx.params.sessionId;
    const state = sessions.get(id);
    if (!state) throw acp.RequestError.invalidParams(`unknown session ${id}`);
    const text = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    state.turns += 1;
    const emit = (update) => ctx.client.notify('session/update', { sessionId: id, update });

    if (text.includes('CRASH')) process.exit(3);
    if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 3000));

    let answer = '';
    if (text.includes('PERMISSION')) {
      const r = await ctx.client.request('session/request_permission', {
        sessionId: id,
        toolCall: { toolCallId: 'perm-1', title: 'write file' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      answer = ` permission=${r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled'}`;
    }

    await emit({
      sessionUpdate: 'tool_call',
      toolCallId: `t${state.turns}`,
      title: 'read file',
      status: 'in_progress',
    });
    await emit({ sessionUpdate: 'tool_call_update', toolCallId: `t${state.turns}`, status: 'completed' });
    await emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } });
    await emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ` turn=${state.turns} session=${id}${answer}` },
    });
    if (process.env.FIXTURE_NO_USAGE !== '1') {
      await emit({
        sessionUpdate: 'usage_update',
        used: 500 * state.turns,
        size: 10000,
        cost: { amount: 0.01 * state.turns, currency: 'USD' },
      });
    }
    return {
      stopReason: text.includes('REFUSE') ? 'refusal' : 'end_turn',
      ...(process.env.FIXTURE_NO_USAGE === '1'
        ? {}
        : {
            usage: {
              totalTokens: 110 * state.turns,
              inputTokens: 100 * state.turns,
              outputTokens: 10 * state.turns,
              cachedReadTokens: 40 * state.turns,
            },
          }),
    };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
