#!/usr/bin/env node
// A scripted ACP agent that speaks like `grok agent stdio` (1.0.92): every turn
// ends with an `_x.ai/session_notification` `turn_completed` carrying its usage,
// and the prompt response has no standard `usage`, only `_meta.usage`.
//
// Words in the prompt:
//   BACKGROUND       after answering, run a turn of its own (a background run reporting back),
//                    after a subagent's session reports a turn of its own
//   BACKGROUND_FAIL  the same, but that turn is refused at the usage limit
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import { setTimeout } from 'node:timers';
import * as acp from '@agentclientprotocol/sdk';

let next = 0;
const usage = (input, output, ticks) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedReadTokens: Math.floor(input / 4),
  cacheCreationTokens: 0,
  costUsdTicks: ticks,
});

const app = acp
  .agent({ name: 'grok-fixture' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest('session/new', () => ({ sessionId: `gx-${++next}-${process.pid}` }))
  .onRequest('session/prompt', async (ctx) => {
    const id = ctx.params.sessionId;
    const text = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const client = ctx.client;
    const turnCompleted = (sessionId, promptId, extra) =>
      client.notify('_x.ai/session_notification', {
        sessionId,
        update: { sessionUpdate: 'turn_completed', prompt_id: promptId, ...extra },
      });
    await client.notify('session/update', {
      sessionId: id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } },
    });
    const own = usage(1000, 10, 100_000_000);
    await turnCompleted(id, 'p1', { stop_reason: 'end_turn', usage: own });
    if (text.includes('BACKGROUND')) {
      const fail = text.includes('BACKGROUND_FAIL');
      setTimeout(async () => {
        await turnCompleted('child-session', 'c1', { stop_reason: 'end_turn', usage: usage(9999, 99, 9_000_000_000) });
        if (!fail) {
          await client.notify('session/update', {
            sessionId: id,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'workflow report' } },
          });
          await turnCompleted(id, 'workflow-completed-wf_1-11', {
            stop_reason: 'end_turn',
            usage: usage(4000, 200, 500_000_000),
          });
        } else {
          await turnCompleted(id, 'workflow-completed-wf_1-11', {
            stop_reason: 'rate_limit',
            error: {
              code: -32003,
              message: 'Rate limited',
              data: 'API error (status 429 Too Many Requests): free-usage-exhausted',
            },
          });
        }
      }, 50);
    }
    return { stopReason: 'end_turn', _meta: { sessionId: id, usage: own } };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
