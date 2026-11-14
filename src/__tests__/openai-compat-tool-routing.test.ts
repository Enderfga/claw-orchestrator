/**
 * A tool round reaches the session that issued its calls.
 *
 * The shape this reproduces: a caller that sends no session id, so each request is keyed by a hash
 * of its model, system prompt and tool list, adds a tool (`process`) part-way through one run. The
 * changed list hashed to a second session, which was handed the first session's tool results, and
 * the two went on answering each other's calls. OpenClaw also returns the ids it was given without
 * their underscore (`call_ab12…` comes back as `callab12…`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleChatCompletion,
  routeToolResults,
  canonicalToolCallId,
  TOOLS_CHANGED_NOTE,
  __resetSeededConversations,
  type OpenAIChatMessage,
} from '../openai-compat.js';

type Tool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
const tool = (name: string): Tool => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
});
const EXEC_ONLY = [tool('exec')];
const EXEC_AND_PROCESS = [tool('exec'), tool('process')];
const SYSTEM: OpenAIChatMessage = { role: 'system', content: 'You are a scheduled maintenance agent.' };
const TASK: OpenAIChatMessage = { role: 'user', content: 'Run the nightly job.' };

/**
 * A manager whose sessions answer from a script, and which records what each session was sent.
 * The script is per session, so a second session would have its own and the test can see it.
 */
function scriptedManager(replies: string[]) {
  const sessions = new Map<string, { sent: string[]; replies: string[] }>();
  const created: string[] = [];
  const manager = {
    startSession: async (config: Record<string, unknown>) => {
      const name = config.name as string;
      created.push(name);
      sessions.set(name, { sent: [], replies: [...replies] });
      return { name };
    },
    sendMessage: async (name: string, message: string) => {
      const s = sessions.get(name)!;
      s.sent.push(message);
      return { output: s.replies.shift() ?? 'done', events: [] };
    },
    stopSession: async (name: string) => {
      sessions.delete(name);
    },
    listSessions: () => [...sessions.keys()].map((name) => ({ name })),
    getStatus: () => ({ stats: { tokensIn: 0, tokensOut: 0, contextPercent: 1 } }),
    compactSession: async () => ({}),
  };
  return { manager, sessions, created };
}

function recordingRes() {
  const seen = { status: 0, body: '' };
  const res = {
    writeHead: (status: number) => {
      seen.status = status;
    },
    end: (body?: string) => {
      if (body !== undefined) seen.body = body;
    },
    setHeader: () => {},
    write: () => true,
    on: () => {},
  };
  return { res: res as unknown as Parameters<typeof handleChatCompletion>[3], seen };
}

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

async function complete(
  manager: ReturnType<typeof scriptedManager>['manager'],
  messages: OpenAIChatMessage[],
  tools: Tool[],
  headers: Record<string, string> = {},
): Promise<{ status: number; toolCalls: ToolCall[]; error?: string }> {
  const { res, seen } = recordingRes();
  await handleChatCompletion(manager as never, { model: 'claude-opus-5-5', messages, tools }, headers, res);
  const body = JSON.parse(seen.body || '{}') as {
    choices?: Array<{ message?: { tool_calls?: ToolCall[] } }>;
    error?: { message?: string };
  };
  return {
    status: seen.status,
    toolCalls: body.choices?.[0]?.message?.tool_calls ?? [],
    error: body.error?.message,
  };
}

/** The assistant turn and its result as OpenClaw sends them back: ids without the underscore. */
function round(call: ToolCall, output: string): OpenAIChatMessage[] {
  const echoed = call.id.replace(/_/g, '');
  return [
    { role: 'assistant', content: '', tool_calls: [{ ...call, id: echoed }] } as unknown as OpenAIChatMessage,
    { role: 'tool', tool_call_id: echoed, content: output },
  ];
}

const callReply = (command: string) =>
  `<tool_calls>[{"name":"exec","arguments":{"command":${JSON.stringify(command)}}}]</tool_calls>`;

describe('tool rounds and the session that issued them', () => {
  beforeEach(__resetSeededConversations);

  it('keeps a run on one session when the caller changes its tool list mid-run, and gives that session the new list', async () => {
    const { manager, sessions, created } = scriptedManager([
      callReply('echo RESULT-ONE'),
      callReply('echo RESULT-TWO'),
      'All synced.',
    ]);

    const first = await complete(manager, [SYSTEM, TASK], EXEC_ONLY);
    expect(first.status).toBe(200);
    const [callA] = first.toolCalls;
    expect(callA.id).toMatch(/^call_[0-9a-f]{24}$/);

    // The exec went to the background, so OpenClaw now offers `process` too: a new key.
    const second = await complete(manager, [SYSTEM, TASK, ...round(callA, 'RESULT-ONE')], EXEC_AND_PROCESS);
    expect(second.status).toBe(200);
    const [callB] = second.toolCalls;

    // And back to the first list once the process finished.
    const third = await complete(
      manager,
      [SYSTEM, TASK, ...round(callA, 'RESULT-ONE'), ...round(callB, 'RESULT-TWO')],
      EXEC_ONLY,
    );
    expect(third.status).toBe(200);

    expect(created).toHaveLength(1);
    const sent = sessions.get(created[0])!.sent;
    expect(sent).toHaveLength(3);
    expect(sent[1]).toContain('RESULT-ONE');
    expect(sent[2]).toContain('RESULT-TWO');
    // Each change of list reaches the session in full, the added tool included.
    expect(sent[1]).toContain(TOOLS_CHANGED_NOTE);
    expect(sent[1]).toContain('### process');
    expect(sent[2]).toContain(TOOLS_CHANGED_NOTE);
    expect(sent[2]).not.toContain('### process');
  });

  it('refuses results that answer calls from two sessions', async () => {
    const { manager } = scriptedManager([callReply('echo one')]);
    const a = await complete(manager, [SYSTEM, TASK], EXEC_ONLY);
    const b = await complete(manager, [{ role: 'system', content: 'Another agent.' }, TASK], EXEC_ONLY);
    const r = await complete(
      manager,
      [
        SYSTEM,
        TASK,
        {
          role: 'assistant',
          content: '',
          tool_calls: [a.toolCalls[0], b.toolCalls[0]],
        } as unknown as OpenAIChatMessage,
        { role: 'tool', tool_call_id: a.toolCalls[0].id, content: 'one' },
        { role: 'tool', tool_call_id: b.toolCalls[0].id, content: 'two' },
      ],
      EXEC_ONLY,
    );
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/more than one session/);
  });

  it('refuses results for another session when the caller named a session explicitly', async () => {
    const { manager } = scriptedManager([callReply('echo one')]);
    const a = await complete(manager, [SYSTEM, TASK], EXEC_ONLY, { 'x-session-id': 'run-a' });
    const r = await complete(manager, [SYSTEM, TASK, ...round(a.toolCalls[0], 'one')], EXEC_ONLY, {
      'x-session-id': 'run-b',
    });
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/issued by session 'openai-run-a'/);
  });

  it('refuses results nobody issued when the session is waiting for its own', async () => {
    const { manager, sessions, created } = scriptedManager([callReply('echo one')]);
    await complete(manager, [SYSTEM, TASK], EXEC_ONLY);
    const stranger: ToolCall = {
      id: 'call_ffffffffffffffffffffffff',
      type: 'function',
      function: { name: 'exec', arguments: '{}' },
    };
    const r = await complete(manager, [SYSTEM, TASK, ...round(stranger, 'not yours')], EXEC_ONLY);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/do not answer the tool calls/);
    expect(sessions.get(created[0])!.sent).toHaveLength(1);
  });

  it('lets results through by key when nothing is known about them and nothing is awaited', () => {
    // A restarted server has no record of the calls; refusing would strand every run in flight.
    const messages: OpenAIChatMessage[] = [
      SYSTEM,
      TASK,
      { role: 'tool', tool_call_id: 'call_0123456789abcdef01234567', content: 'x' },
    ];
    expect(routeToolResults('openai-sys-x', messages, false)).toEqual({ session: 'openai-sys-x', rerouted: false });
  });

  it('matches a call id however the caller punctuated it', () => {
    const issued = 'call_0123456789abcdef01234567';
    expect(canonicalToolCallId('call0123456789abcdef01234567')).toBe(canonicalToolCallId(issued));
    expect(canonicalToolCallId('functions.call_0123456789ABCDEF01234567')).toBe(canonicalToolCallId(issued));
  });
});
