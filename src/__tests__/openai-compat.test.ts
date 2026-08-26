/**
 * Unit tests for OpenAI-compatible /v1/chat/completions endpoint.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  resolveSessionKey,
  sessionNameFromKey,
  extractUserMessage,
  formatCompletionResponse,
  formatCompletionChunk,
  buildToolPromptBlock,
  buildToolReminderBlock,
  nativeThreadIsLive,
  parseToolCallsFromText,
  serializeToolResults,
  type OpenAIChatMessage,
  isToolsPerMessageModeEnabled,
  noToolsSystemPrompt,
  buildSessionSystemPrompt,
  handleChatCompletion,
} from '../openai-compat.js';
import { resolveEngineAndModel, getModelList } from '../models.js';

// ─── resolveEngineAndModel ───────────────────────────────────────────────────

describe('resolveEngineAndModel', () => {
  it('maps claude model names to claude engine', () => {
    expect(resolveEngineAndModel('claude-opus-4-6')).toEqual({ engine: 'claude', model: 'claude-opus-4-6' });
    expect(resolveEngineAndModel('claude-sonnet-4-6')).toEqual({ engine: 'claude', model: 'claude-sonnet-4-6' });
  });

  it('maps short aliases to claude engine', () => {
    expect(resolveEngineAndModel('opus')).toEqual({ engine: 'claude', model: 'claude-opus-5' });
    expect(resolveEngineAndModel('sonnet')).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
    expect(resolveEngineAndModel('haiku')).toEqual({ engine: 'claude', model: 'claude-haiku-4-5' });
  });

  it('maps GPT-5.4 models to codex engine', () => {
    expect(resolveEngineAndModel('gpt-5.4')).toEqual({ engine: 'codex', model: 'gpt-5.4' });
    expect(resolveEngineAndModel('gpt-5.4-mini')).toEqual({ engine: 'codex', model: 'gpt-5.4-mini' });
    expect(resolveEngineAndModel('gpt-5.4-nano')).toEqual({ engine: 'codex', model: 'gpt-5.4-nano' });
  });

  it('maps o-series and codex models to codex engine', () => {
    expect(resolveEngineAndModel('o3')).toEqual({ engine: 'codex', model: 'o3' });
    expect(resolveEngineAndModel('o4-mini')).toEqual({ engine: 'codex', model: 'o4-mini' });
    expect(resolveEngineAndModel('codex-mini-latest')).toEqual({ engine: 'codex', model: 'codex-mini-latest' });
  });

  it('maps gemini models to gemini engine by prefix', () => {
    expect(resolveEngineAndModel('gemini-3.1-pro-preview')).toEqual({
      engine: 'gemini',
      model: 'gemini-3.1-pro-preview',
    });
    expect(resolveEngineAndModel('gemini-3-flash-preview')).toEqual({
      engine: 'gemini',
      model: 'gemini-3-flash-preview',
    });
  });

  it('maps composer models to cursor engine', () => {
    expect(resolveEngineAndModel('composer-2-fast')).toEqual({ engine: 'cursor', model: 'composer-2-fast' });
    expect(resolveEngineAndModel('composer-2')).toEqual({ engine: 'cursor', model: 'composer-2' });
    expect(resolveEngineAndModel('composer-1.5')).toEqual({ engine: 'cursor', model: 'composer-1.5' });
  });

  it('defaults unknown models to claude engine with passthrough', () => {
    expect(resolveEngineAndModel('my-custom-model')).toEqual({ engine: 'claude', model: 'my-custom-model' });
  });
});

// ─── resolveSessionKey ───────────────────────────────────────────────────────

describe('resolveSessionKey', () => {
  let savedToolsPerMessage: string | undefined;
  beforeEach(() => {
    savedToolsPerMessage = process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
    delete process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
  });
  afterEach(() => {
    if (savedToolsPerMessage === undefined) delete process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
    else process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = savedToolsPerMessage;
  });

  it('prefers X-Session-Id header', () => {
    const key = resolveSessionKey({ messages: [], user: 'user-1' }, { 'x-session-id': 'my-session' });
    expect(key).toBe('my-session');
  });

  it('falls back to user field', () => {
    const key = resolveSessionKey({ messages: [], user: 'user-42' }, {});
    expect(key).toBe('user-42');
  });

  it('falls back to literal default only when messages is empty and no model', () => {
    const key = resolveSessionKey({ messages: [] }, {});
    expect(key).toBe('default');
  });

  it('trims whitespace from header', () => {
    const key = resolveSessionKey({ messages: [] }, { 'x-session-id': '  spaced  ' });
    expect(key).toBe('spaced');
  });

  it('ignores empty header', () => {
    const key = resolveSessionKey({ messages: [], user: 'u1' }, { 'x-session-id': '  ' });
    expect(key).toBe('u1');
  });

  it('hashes system prompt when no explicit key is provided', () => {
    const key = resolveSessionKey(
      {
        messages: [
          { role: 'system', content: 'You are Alice.' },
          { role: 'user', content: 'hi' },
        ],
      },
      {},
    );
    expect(key).toMatch(/^sys-[0-9a-f]{12}$/);
  });

  it('produces distinct keys for two distinct system prompts', () => {
    const a = resolveSessionKey(
      {
        messages: [
          { role: 'system', content: 'You are Alice.' },
          { role: 'user', content: 'hi' },
        ],
      },
      {},
    );
    const b = resolveSessionKey(
      {
        messages: [
          { role: 'system', content: 'You are Bob.' },
          { role: 'user', content: 'hi' },
        ],
      },
      {},
    );
    expect(a).toMatch(/^sys-[0-9a-f]{12}$/);
    expect(b).toMatch(/^sys-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('produces distinct keys when same system prompt has different requested models', () => {
    const opus = resolveSessionKey(
      {
        model: 'claude-opus-4-6',
        messages: [
          { role: 'system', content: 'SAME' },
          { role: 'user', content: 'hi' },
        ],
      },
      {},
    );
    const sonnet = resolveSessionKey(
      {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'SAME' },
          { role: 'user', content: 'hi' },
        ],
      },
      {},
    );
    expect(opus).toMatch(/^sys-[0-9a-f]{12}$/);
    expect(sonnet).toMatch(/^sys-[0-9a-f]{12}$/);
    expect(opus).not.toBe(sonnet);
  });

  it('hashes model alone when there is no system prompt', () => {
    const key = resolveSessionKey({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(key).toMatch(/^sys-[0-9a-f]{12}$/);
  });

  it('produces distinct keys when system prompt is identical but tools differ', () => {
    const base = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system' as const, content: 'SAME' },
        { role: 'user' as const, content: 'hi' },
      ],
    };
    const withToolsA = resolveSessionKey(
      {
        ...base,
        tools: [{ type: 'function', function: { name: 'foo', description: 'does foo', parameters: {} } }],
      },
      {},
    );
    const withToolsB = resolveSessionKey(
      {
        ...base,
        tools: [{ type: 'function', function: { name: 'bar', description: 'does bar', parameters: {} } }],
      },
      {},
    );
    const withoutTools = resolveSessionKey(base, {});
    expect(withToolsA).not.toBe(withToolsB);
    expect(withToolsA).not.toBe(withoutTools);
    expect(withToolsB).not.toBe(withoutTools);
  });

  it('produces the same key for identical tool lists across calls', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system' as const, content: 'SAME' },
        { role: 'user' as const, content: 'hi' },
      ],
      tools: [
        { type: 'function', function: { name: 'foo', description: 'does foo', parameters: {} } },
        { type: 'function', function: { name: 'bar', description: 'does bar', parameters: {} } },
      ],
    };
    expect(resolveSessionKey(body, {})).toBe(resolveSessionKey(body, {}));
  });

  it('ignores tools in the key when OPENAI_COMPAT_TOOLS_PER_MESSAGE=1 (legacy opt-out)', () => {
    process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = '1';
    const base = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system' as const, content: 'SAME' },
        { role: 'user' as const, content: 'hi' },
      ],
    };
    const withToolsA = resolveSessionKey(
      {
        ...base,
        tools: [{ type: 'function', function: { name: 'foo', description: 'does foo', parameters: {} } }],
      },
      {},
    );
    const withToolsB = resolveSessionKey(
      {
        ...base,
        tools: [{ type: 'function', function: { name: 'bar', description: 'does bar', parameters: {} } }],
      },
      {},
    );
    const withoutTools = resolveSessionKey(base, {});
    // With the opt-out enabled, the tool list is NOT part of the session key,
    // so all three bodies collapse to the same key (the pre-fix behavior).
    expect(withToolsA).toBe(withToolsB);
    expect(withToolsA).toBe(withoutTools);
  });
});

// ─── isToolsPerMessageModeEnabled ────────────────────────────────────────────

describe('isToolsPerMessageModeEnabled', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
    delete process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
    else process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = saved;
  });

  it('defaults to false when the env var is unset', () => {
    expect(isToolsPerMessageModeEnabled()).toBe(false);
  });

  it('returns true for "1", "true", "yes" (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', ' Yes ', 'YES']) {
      process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = v;
      expect(isToolsPerMessageModeEnabled()).toBe(true);
    }
  });

  it('returns false for "0", "false", "no", unknown values', () => {
    for (const v of ['0', 'false', 'no', 'off', 'maybe', '']) {
      process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = v;
      expect(isToolsPerMessageModeEnabled()).toBe(false);
    }
  });
});

// ─── noToolsSystemPrompt ─────────────────────────────────────────────────────

describe('noToolsSystemPrompt', () => {
  it('references "block below" for system location', () => {
    const prompt = noToolsSystemPrompt('system');
    expect(prompt).toContain('block below');
    expect(prompt).not.toContain('in the user message');
  });

  it('references "user message" for user location', () => {
    const prompt = noToolsSystemPrompt('user');
    expect(prompt).toContain('in the user message');
    expect(prompt).not.toContain('block below');
  });

  it('always contains the no-tools preamble', () => {
    for (const loc of ['system', 'user'] as const) {
      const prompt = noToolsSystemPrompt(loc);
      expect(prompt).toContain('You do NOT have access to any tools');
      expect(prompt).toContain('<tool_calls>');
    }
  });
});

// ─── buildSessionSystemPrompt ────────────────────────────────────────────────

describe('buildSessionSystemPrompt', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
    delete process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
    else process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = saved;
  });

  const sampleTools = [
    {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ];

  it('default mode: embeds <available_tools> in the system prompt', () => {
    const result = buildSessionSystemPrompt(sampleTools, undefined);
    expect(result).toContain('<available_tools>');
    expect(result).toContain('get_weather');
    expect(result).toContain('block below');
  });

  it('default mode: appends caller system prompt after tools', () => {
    const result = buildSessionSystemPrompt(sampleTools, 'You are a weather bot.');
    expect(result).toContain('<available_tools>');
    expect(result).toContain('You are a weather bot.');
    // Caller prompt comes after tool block
    const toolIdx = result.indexOf('<available_tools>');
    const callerIdx = result.indexOf('You are a weather bot.');
    expect(callerIdx).toBeGreaterThan(toolIdx);
  });

  it('legacy mode: does NOT embed tool definitions in system prompt', () => {
    process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = '1';
    const result = buildSessionSystemPrompt(sampleTools, undefined);
    // The tool block (with actual tool definitions) should NOT be present
    expect(result).not.toContain('get_weather');
    expect(result).not.toContain('## Available Tools');
    // But the preamble still references user message location
    expect(result).toContain('in the user message');
  });

  it('legacy mode: still includes caller system prompt', () => {
    process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE = '1';
    const result = buildSessionSystemPrompt(sampleTools, 'You are a weather bot.');
    expect(result).not.toContain('get_weather');
    expect(result).toContain('You are a weather bot.');
  });
});

// ─── sessionNameFromKey ──────────────────────────────────────────────────────

describe('sessionNameFromKey', () => {
  it('prefixes with openai-', () => {
    expect(sessionNameFromKey('abc')).toBe('openai-abc');
    expect(sessionNameFromKey('default')).toBe('openai-default');
  });

  // The name becomes a directory: handleChatCompletion builds
  // `os.tmpdir()/openclaw-compat-<name>`, mkdirs it recursively, and starts the
  // session there under bypassPermissions. The key is whatever the caller put in
  // `x-session-id` or `user`. Measured before the fix: the path resolved to
  // `/var/folders/xy/etc/newdir` — outside the temp dir entirely.
  it('cannot carry a path out of the directory it names', () => {
    const os = { tmpdir: () => '/tmp' };
    for (const evil of ['../../../../etc/newdir', '../..', 'a/b', 'a\\b', '..', '.', 'x/../../../y', 'nul\u0000byte']) {
      const name = sessionNameFromKey(evil);
      const dir = path.join(os.tmpdir(), `openclaw-compat-${name}`);
      expect(path.dirname(dir)).toBe(os.tmpdir());
      expect(name).not.toContain('/');
      expect(name).not.toContain('..');
    }
  });

  it('leaves an ordinary key byte-for-byte alone', () => {
    // Sanitising every key would rename every existing caller's session, so the
    // negative case is half the contract.
    for (const ok of ['abc', 'default', 'sys-0123456789ab', 'user_42', 'a.b-c']) {
      expect(sessionNameFromKey(ok)).toBe(`openai-${ok}`);
    }
  });

  it('keeps distinct unsafe keys distinct', () => {
    expect(sessionNameFromKey('a/b')).not.toBe(sessionNameFromKey('a/c'));
  });
});

// ─── extractUserMessage ──────────────────────────────────────────────────────

describe('extractUserMessage', () => {
  // Save + restore the env var so the legacy-heuristic test below can mutate it
  // without leaking into other tests.
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
    delete process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
    else process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC = savedEnv;
  });

  it('extracts last user message', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'world' },
    ];
    const result = extractUserMessage(messages);
    expect(result.userMessage).toBe('world');
    expect(result.isNewConversation).toBe(false);
  });

  it('extracts system prompt without flagging it as a new conversation', () => {
    // Default mode: only X-Session-Reset can mark a new conversation. The
    // shape "[system, user]" alone is NOT a reset signal — many clients
    // (OpenClaw main agent) send that exact shape on every turn.
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ];
    const result = extractUserMessage(messages);
    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.userMessage).toBe('hi');
    expect(result.isNewConversation).toBe(false);
  });

  it('does NOT detect new conversation from [system, user] shape without reset header', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first message' },
    ];
    expect(extractUserMessage(messages).isNewConversation).toBe(false);
  });

  it('detects ongoing conversation (has assistant turns)', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
    ];
    expect(extractUserMessage(messages).isNewConversation).toBe(false);
  });

  it('does NOT treat a single user message as a new conversation without reset header', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'only' }];
    const result = extractUserMessage(messages);
    expect(result.userMessage).toBe('only');
    expect(result.isNewConversation).toBe(false);
    expect(result.systemPrompt).toBeUndefined();
  });

  it('joins multiple system messages', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'line1' },
      { role: 'system', content: 'line2' },
      { role: 'user', content: 'go' },
    ];
    expect(extractUserMessage(messages).systemPrompt).toBe('line1\nline2');
  });

  it('throws on empty messages', () => {
    expect(() => extractUserMessage([])).toThrow('empty');
  });

  it('throws on no user message', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'system', content: 'sys' }];
    expect(() => extractUserMessage(messages)).toThrow('No user message');
  });

  it('honors X-Session-Reset: 1 header', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'fresh start' },
    ];
    const result = extractUserMessage(messages, { 'x-session-reset': '1' });
    expect(result.isNewConversation).toBe(true);
  });

  it('honors X-Session-Reset: true header', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'fresh start' }];
    const result = extractUserMessage(messages, { 'x-session-reset': 'true' });
    expect(result.isNewConversation).toBe(true);
  });

  it('honors X-Session-Reset case-insensitively with whitespace', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'fresh start' }];
    expect(extractUserMessage(messages, { 'x-session-reset': '  TRUE ' }).isNewConversation).toBe(true);
    expect(extractUserMessage(messages, { 'x-session-reset': ' 1' }).isNewConversation).toBe(true);
  });

  it('ignores unrelated x-session-reset values', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(extractUserMessage(messages, { 'x-session-reset': 'no' }).isNewConversation).toBe(false);
    expect(extractUserMessage(messages, { 'x-session-reset': '' }).isNewConversation).toBe(false);
    expect(extractUserMessage(messages, {}).isNewConversation).toBe(false);
  });

  it('restores legacy heuristic when OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1', () => {
    process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC = '1';
    // [system, user] should now flag as new conversation
    expect(
      extractUserMessage([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
      ]).isNewConversation,
    ).toBe(true);
    // [user] alone should also flag as new conversation
    expect(extractUserMessage([{ role: 'user', content: 'only' }]).isNewConversation).toBe(true);
    // Once an assistant turn appears, it's no longer new
    expect(
      extractUserMessage([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]).isNewConversation,
    ).toBe(false);
  });
});

// ─── formatCompletionResponse ────────────────────────────────────────────────

describe('formatCompletionResponse', () => {
  it('returns valid OpenAI response structure', () => {
    const resp = formatCompletionResponse('chatcmpl-123', 'claude-sonnet-4-6', 'Hello!', 100, 50);
    expect(resp.id).toBe('chatcmpl-123');
    expect(resp.object).toBe('chat.completion');
    expect(resp.model).toBe('claude-sonnet-4-6');
    expect(resp.choices).toHaveLength(1);
    expect(resp.choices[0].message.role).toBe('assistant');
    expect(resp.choices[0].message.content).toBe('Hello!');
    expect(resp.choices[0].finish_reason).toBe('stop');
    expect(resp.usage.prompt_tokens).toBe(100);
    expect(resp.usage.completion_tokens).toBe(50);
    expect(resp.usage.total_tokens).toBe(150);
  });

  it('has a valid created timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const resp = formatCompletionResponse('id', 'model', 'text', 0, 0);
    const after = Math.floor(Date.now() / 1000);
    expect(resp.created).toBeGreaterThanOrEqual(before);
    expect(resp.created).toBeLessThanOrEqual(after);
  });
});

// ─── formatCompletionChunk ───────────────────────────────────────────────────

describe('formatCompletionChunk', () => {
  it('returns valid SSE chunk with content delta', () => {
    const chunk = formatCompletionChunk('chatcmpl-1', 'model', { content: 'hi' }, null);
    expect(chunk.id).toBe('chatcmpl-1');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices[0].delta.content).toBe('hi');
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  it('returns valid SSE chunk with role delta', () => {
    const chunk = formatCompletionChunk('chatcmpl-1', 'model', { role: 'assistant' }, null);
    expect(chunk.choices[0].delta.role).toBe('assistant');
    expect(chunk.choices[0].delta.content).toBeUndefined();
  });

  it('returns valid final chunk with finish_reason', () => {
    const chunk = formatCompletionChunk('chatcmpl-1', 'model', {}, 'stop');
    expect(chunk.choices[0].finish_reason).toBe('stop');
  });
});

// ─── getModelList ────────────────────────────────────────────────────────────

describe('getModelList', () => {
  it('returns list object with models', () => {
    const list = getModelList();
    expect(list.object).toBe('list');
    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data[0]).toHaveProperty('id');
    expect(list.data[0]).toHaveProperty('object', 'model');
    expect(list.data[0]).toHaveProperty('owned_by');
  });

  it('includes claude, openai, and google models', () => {
    const list = getModelList();
    const owners = new Set(list.data.map((m) => m.owned_by));
    expect(owners).toContain('anthropic');
    expect(owners).toContain('openai');
    expect(owners).toContain('google');
  });
});

// ─── buildToolPromptBlock ───────────────────────────────────────────────────

describe('buildToolReminderBlock', () => {
  // Regression guard for the context-overflow bug: on an engine that resumes a
  // thread (codex, agy) the schemas from turn 1 are still in the transcript, so
  // resend turns get this block instead. It must keep the calling convention —
  // dropping it entirely makes the CLI try to do the work itself instead of
  // emitting a tool call — while carrying none of the schema text.
  it('restates the calling convention without any schemas', () => {
    const reminder = buildToolReminderBlock();
    expect(reminder).toContain('<available_tools>');
    expect(reminder).toContain('<tool_calls>');
    expect(reminder).toContain('still available');
    // The expensive part of the full block is the pretty-printed JSON Schema.
    expect(reminder).not.toContain('Parameters:');
    expect(reminder).not.toContain('```json');
    expect(reminder).not.toContain('## Available Tools');
  });

  it('is far smaller than the full block it replaces', () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({
      type: 'function' as const,
      function: {
        name: `tool_${i}`,
        description: `Tool number ${i} with a reasonably long description`,
        parameters: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
          required: ['a'],
        },
      },
    }));
    expect(buildToolReminderBlock().length).toBeLessThan(buildToolPromptBlock(tools).length / 10);
  });
});

describe('buildToolPromptBlock', () => {
  it('returns empty string for undefined/empty tools', () => {
    expect(buildToolPromptBlock(undefined)).toBe('');
    expect(buildToolPromptBlock([])).toBe('');
  });

  it('includes tool name, description, and parameters', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ];
    const result = buildToolPromptBlock(tools);
    expect(result).toContain('<available_tools>');
    expect(result).toContain('</available_tools>');
    expect(result).toContain('get_weather');
    expect(result).toContain('Get weather for a city');
    expect(result).toContain('<tool_calls>');
  });

  it('includes multiple tools', () => {
    const tools = [
      { type: 'function' as const, function: { name: 'tool_a', description: 'A', parameters: {} } },
      { type: 'function' as const, function: { name: 'tool_b', description: 'B', parameters: {} } },
    ];
    const result = buildToolPromptBlock(tools);
    expect(result).toContain('### tool_a');
    expect(result).toContain('### tool_b');
  });
});

// ─── parseToolCallsFromText ─────────────────────────────────────────────────

describe('parseToolCallsFromText', () => {
  it('returns text-only when no tool_calls tags', () => {
    const result = parseToolCallsFromText('Hello, world!');
    expect(result.textContent).toBe('Hello, world!');
    expect(result.toolCalls).toEqual([]);
  });

  it('parses single tool call', () => {
    const text = '<tool_calls>\n[{"name": "get_weather", "arguments": {"city": "Tokyo"}}]\n</tool_calls>';
    const result = parseToolCallsFromText(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ city: 'Tokyo' });
    expect(result.toolCalls[0].type).toBe('function');
    expect(result.toolCalls[0].id).toMatch(/^call_/);
  });

  it('parses multiple tool calls', () => {
    const text = '<tool_calls>\n[{"name": "a", "arguments": {}}, {"name": "b", "arguments": {"x": 1}}]\n</tool_calls>';
    const result = parseToolCallsFromText(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe('a');
    expect(result.toolCalls[1].function.name).toBe('b');
  });

  it('preserves text before tool_calls', () => {
    const text = 'Let me search for that.\n<tool_calls>\n[{"name": "search", "arguments": {}}]\n</tool_calls>';
    const result = parseToolCallsFromText(text);
    expect(result.textContent).toBe('Let me search for that.');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('falls back to text on malformed JSON', () => {
    const text = '<tool_calls>\nnot json\n</tool_calls>';
    const result = parseToolCallsFromText(text);
    expect(result.textContent).toBe(text);
    expect(result.toolCalls).toEqual([]);
  });

  it('handles string arguments passthrough', () => {
    const text = '<tool_calls>\n[{"name": "fn", "arguments": "{\\"key\\": \\"val\\"}"}]\n</tool_calls>';
    const result = parseToolCallsFromText(text);
    expect(result.toolCalls[0].function.arguments).toBe('{"key": "val"}');
  });

  it('returns null textContent when empty string', () => {
    const result = parseToolCallsFromText('');
    expect(result.textContent).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it('assigns unique ids to each tool call', () => {
    const text = '<tool_calls>\n[{"name": "a", "arguments": {}}, {"name": "b", "arguments": {}}]\n</tool_calls>';
    const result = parseToolCallsFromText(text);
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
  });
});

// ─── serializeToolResults ───────────────────────────────────────────────────

describe('serializeToolResults', () => {
  it('returns empty string when no tool messages', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(serializeToolResults(messages)).toBe('');
  });

  it('serializes tool results with tool_call_id', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'tool', content: '{"temp": 22}', tool_call_id: 'call_abc' }];
    const result = serializeToolResults(messages);
    expect(result).toContain('<tool_results>');
    expect(result).toContain('tool_call_id="call_abc"');
    expect(result).toContain('{"temp": 22}');
    expect(result).toContain('</tool_results>');
  });

  it('serializes multiple tool results', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'tool', content: 'result1', tool_call_id: 'call_1' },
      { role: 'tool', content: 'result2', tool_call_id: 'call_2' },
    ];
    const result = serializeToolResults(messages);
    expect(result).toContain('call_1');
    expect(result).toContain('call_2');
  });
});

// ─── extractUserMessage with tool role ──────────────────────────────────────

describe('extractUserMessage with tool results', () => {
  it('synthesizes user message from tool results', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      },
      { role: 'tool', content: '{"temp": 22}', tool_call_id: 'call_1' },
    ];
    const result = extractUserMessage(messages);
    expect(result.userMessage).toContain('<tool_results>');
    expect(result.userMessage).toContain('{"temp": 22}');
    expect(result.isNewConversation).toBe(false);
  });

  // This case used to be one test asserting the results are never sent when the array ends in a
  // user message, titled "(tool results already in CLI history)" — but it called
  // extractUserMessage(messages) with no third argument, i.e. threadHasHistory = false, which is
  // the function's way of being told the engine has NO history. The title named a precondition the
  // body never set, and the assertion held only because the code was reading the shape of the
  // array instead of the state of the thread. Split into the two cases the title implies.
  const searchThenFollowUp: OpenAIChatMessage[] = [
    { role: 'user', content: 'Search for news' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    },
    { role: 'tool', content: 'News results here', tool_call_id: 'call_1' },
    { role: 'user', content: 'Summarize the results' },
  ];

  it('drops the results that the CLI history really does hold', () => {
    // The title's original claim, now actually exercised: a thread that is live AND has taken a
    // turn since round one. ROUND-ONE is in the transcript, so it is not re-sent; ROUND-TWO landed
    // after the engine's last assistant turn, so it is.
    const twoRounds: OpenAIChatMessage[] = [
      { role: 'user', content: 'Search for news' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'ROUND-ONE', tool_call_id: 'call_1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'ROUND-TWO', tool_call_id: 'call_2' },
      { role: 'user', content: 'Summarize the results' },
    ];
    const result = extractUserMessage(twoRounds, {}, true);
    expect(result.userMessage).not.toContain('ROUND-ONE');
    expect(result.userMessage).toContain('ROUND-TWO');
    expect(result.userMessage).toContain('Summarize the results');
  });

  it('sends the results when there is no CLI history to hold them', () => {
    // Same array as the original test, same default third argument. On the deployment where this
    // was found, every discard on the revisions that log session state — 337 of those 337 rows, out
    // of 725 discards in total; the other 388 predate the fields — was exactly this shape of
    // thread: no session, engine turn count 0, so the CLI could not have been holding them. The
    // old assertion here is what made the discard look intended.
    const result = extractUserMessage(searchThenFollowUp);
    expect(result.userMessage).toContain('<tool_results>');
    expect(result.userMessage).toContain('News results here');
    expect(result.userMessage).toContain('Summarize the results');
    expect(result.isNewConversation).toBe(false);
  });
});

// ─── formatCompletionResponse with tool_calls ───────────────────────────────

describe('formatCompletionResponse with tool_calls', () => {
  it('returns tool_calls finish_reason when toolCalls provided', () => {
    const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'fn', arguments: '{}' } }];
    const resp = formatCompletionResponse('id', 'model', '', 100, 50, toolCalls);
    expect(resp.choices[0].finish_reason).toBe('tool_calls');
    expect(resp.choices[0].message.tool_calls).toEqual(toolCalls);
    expect(resp.choices[0].message.content).toBeNull();
  });

  it('returns stop finish_reason without toolCalls', () => {
    const resp = formatCompletionResponse('id', 'model', 'Hello', 100, 50);
    expect(resp.choices[0].finish_reason).toBe('stop');
    expect(resp.choices[0].message.content).toBe('Hello');
    expect(resp.choices[0].message.tool_calls).toBeUndefined();
  });

  it('includes both text and tool_calls when both present', () => {
    const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'fn', arguments: '{}' } }];
    const resp = formatCompletionResponse('id', 'model', 'Thinking...', 100, 50, toolCalls);
    expect(resp.choices[0].finish_reason).toBe('tool_calls');
    expect(resp.choices[0].message.content).toBe('Thinking...');
    expect(resp.choices[0].message.tool_calls).toEqual(toolCalls);
  });
});

describe('nativeThreadIsLive', () => {
  // The regression this guards: `!needsCreate` says the session is in the manager's map, which is
  // not the same as the engine having created a conversation. A first send that dies before
  // `thread.started` leaves the session in the map with no id, and the next turn would then send a
  // reminder referring to tools the engine never received — and still answer 200.
  it('requires a captured thread id for codex', () => {
    expect(nativeThreadIsLive('codex', {})).toBe(false);
    expect(nativeThreadIsLive('codex', { codexThreadId: 'thread_abc' })).toBe(true);
  });

  it('requires a captured thread id for codex-app', () => {
    expect(nativeThreadIsLive('codex-app', {})).toBe(false);
    expect(nativeThreadIsLive('codex-app', { codexThreadId: 'thread_abc' })).toBe(true);
  });

  it('requires a harvested conversation id for agy', () => {
    expect(nativeThreadIsLive('agy', {})).toBe(false);
    expect(nativeThreadIsLive('agy', { agyConversationId: 'conv_abc' })).toBe(true);
  });

  it('does not confuse the two ids', () => {
    expect(nativeThreadIsLive('codex', { agyConversationId: 'conv_abc' })).toBe(false);
    expect(nativeThreadIsLive('agy', { codexThreadId: 'thread_abc' })).toBe(false);
  });

  // cursor and opencode joined engineHasNativeConversation() in 4.12.0 while this
  // function still had no case for them, so they fell through to `default: true` —
  // exactly the "it is in the map" signal this predicate exists to replace. Both
  // capture a real id, so both can be checked properly.
  it('requires a captured chat id for cursor', () => {
    expect(nativeThreadIsLive('cursor', {})).toBe(false);
    expect(nativeThreadIsLive('cursor', { cursorChatId: 'chat_abc' })).toBe(true);
  });

  it('requires a captured session id for opencode', () => {
    expect(nativeThreadIsLive('opencode', {})).toBe(false);
    expect(nativeThreadIsLive('opencode', { opencodeSessionId: 'ses_abc' })).toBe(true);
  });

  it('treats engines that keep context in a live process as live', () => {
    // claude and persistent custom engines expose no separate id, so presence in the map is the
    // strongest signal there is; this must not regress to false.
    expect(nativeThreadIsLive('claude', {})).toBe(true);
    expect(nativeThreadIsLive('custom', {})).toBe(true);
    expect(nativeThreadIsLive(undefined, {})).toBe(true);
  });
});

describe('serializeToolResults — latestRoundOnly', () => {
  // Growth is the point: on a resumed thread every result before the engine's last assistant turn
  // is already in the transcript, so re-sending them makes the prompt grow quadratically across a
  // tool loop. Scoping to the latest round keeps it linear.
  const loop: OpenAIChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c2', content: 'RESULT-TWO' },
  ];

  it('sends every result when the thread cannot be trusted to hold them', () => {
    const out = serializeToolResults(loop, false);
    expect(out).toContain('RESULT-ONE');
    expect(out).toContain('RESULT-TWO');
  });

  it('sends only the results answering the latest round when the thread holds the rest', () => {
    const out = serializeToolResults(loop, true);
    expect(out).not.toContain('RESULT-ONE');
    expect(out).toContain('RESULT-TWO');
  });

  it('defaults to the previous behaviour', () => {
    expect(serializeToolResults(loop)).toContain('RESULT-ONE');
  });

  it('keeps every result when no assistant turn has happened yet', () => {
    // First hop of a resumed session: results with no preceding assistant message are all new.
    const noAssistant: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
    ];
    expect(serializeToolResults(noAssistant, true)).toContain('RESULT-ONE');
  });

  it('returns empty when the latest round produced no results', () => {
    const trailingAssistant: OpenAIChatMessage[] = [...loop, { role: 'assistant', content: 'done' }];
    expect(serializeToolResults(trailingAssistant, true)).toBe('');
  });
});

// ─── extractUserMessage — tool results vs. what the engine has actually seen ──
//
// The bug: the decision to send tool results was keyed on the SHAPE of the caller's array (is the
// last non-system message a tool role?) to answer a question about the ENGINE's state (does its
// transcript already hold them?). Those come apart on any thread with no history, and there the
// results were dropped while the request still returned 200.
//
// Measured on one deployment — a codex-engine gateway — across every row the log field has, and
// with OUR OWN verification, smoke, probe and load-test sessions removed (that includes the two
// runs on 2026-08-04 that produced the field's first rows): 8,451 requests carried tool results,
// and on 725 of them (8.6%) every result was discarded — 45,873,844 characters of the 445,349,211
// carried. Trailing role on the discards: 420 `user`, 305 `assistant`, which is why both shapes
// are covered below.
//
// Read those with their denominators, because the traffic is concentrated. 10 of the 12 agents
// that ever sent tool results hit it — 83%, and 12 is the whole set of agents that sent any, so
// there is no larger denominator to divide by. One agent accounts for 74.8% of the discarded
// characters, and one half-hourly cron re-sending one of two payloads accounts for 272 of the 725
// discards (37.5%) while being only 7.5% of the characters. Dropping that cron still leaves 453
// discards across 10 agents on 17 days. It is not one repeating payload either way: the heaviest
// agent's 328 discards carry 193 distinct payload sizes.
//
// Restricting the same data to the 18 complete UTC days 2026-08-05..2026-08-22 gives 8,377 / 715 /
// 44,672,264 characters / 418 `user` + 297 `assistant` — so nothing here rests on the window.
//
// The number that does not move with the denominator: on 720 of the 725 the engine had no live
// conversation to hold the results — the gateway logs the same nativeThreadIsLive predicate this
// fix keys on — and on the 337 discards from the revisions that also log session state, 337 of 337
// had no session at all and a turn count of 0, against 48 of 2,905 for the results that were
// DELIVERED on those same revisions.

describe('extractUserMessage — tool results vs. thread history', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
    delete process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
    else process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC = savedEnv;
  });

  const call = (id: string): OpenAIChatMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
  });

  const oneRound: OpenAIChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    call('c1'),
    { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
  ];
  const twoRounds: OpenAIChatMessage[] = [
    ...oneRound,
    call('c2'),
    { role: 'tool', tool_call_id: 'c2', content: 'RESULT-TWO' },
  ];

  // ── the 420 of 725 measured discards that ended in `user` ──────────────────
  it('sends the results when a trailing user message arrives on a thread with no history', () => {
    const result = extractUserMessage([...oneRound, { role: 'user', content: 'follow up' }], {}, false);
    expect(result.userMessage).toContain('RESULT-ONE');
    expect(result.userMessage).toContain('follow up');
    expect(result.isNewConversation).toBe(false);
  });

  // ── order is chronology, not cosmetics: the results answer the assistant's earlier `tool_calls`,
  //    the caller's text is what came after. Reversed, the engine reads an instruction followed by
  //    a wall of output with nothing saying what asked for it. Asserted on the offsets because
  //    `toContain` twice passes either way.
  it("puts the results before the caller's new text, not after", () => {
    const result = extractUserMessage([...oneRound, { role: 'user', content: 'follow up' }], {}, false);
    // Both offsets asserted non-negative FIRST. Comparing them alone is vacuous on any build that
    // drops the block: indexOf returns -1, and -1 < 0 passes. That is exactly the behaviour this
    // file exists to refute, so the ordering assertion has to be guarded by presence.
    expect(result.userMessage.indexOf('RESULT-ONE')).toBeGreaterThanOrEqual(0);
    expect(result.userMessage.indexOf('follow up')).toBeGreaterThanOrEqual(0);
    expect(result.userMessage.indexOf('RESULT-ONE')).toBeLessThan(result.userMessage.indexOf('follow up'));
  });

  // ── every other assertion in this file on a block-carrying message is `toContain`, which cannot
  //    see the separator, the framing sentence, or a truncated payload. One exact-string assertion
  //    pins the whole assembled message so those stay pinned too.
  it('assembles exactly this message, separator and framing included', () => {
    // Its own fixture, with a payload deliberately longer than any plausible truncation constant:
    // every other tool payload in this file is under 20 characters, so a `.slice(0, 20)` on the
    // serializer passes an exact-string assertion built on those.
    const longPayload = 'Q3 revenue was 4.2M, up 18% year over year, across 11 regions.';
    const result = extractUserMessage(
      [
        { role: 'user', content: 'go' },
        call('c1'),
        { role: 'tool', tool_call_id: 'c1', content: longPayload },
        { role: 'user', content: 'follow up' },
      ],
      {},
      false,
    );
    expect(result.userMessage).toBe(
      `<tool_results>\n<tool_result tool_call_id="c1">\n${longPayload}\n</tool_result>\n</tool_results>\n\n` +
        'Above are the results of the tool calls you requested. Continue your response based on these results.\n\n' +
        'follow up',
    );
  });

  // ── the docstring this PR edited says the parameter "defaults to false so any caller that cannot
  //    establish that keeps the safe behaviour of sending every result". Every existing default-arg
  //    call site carries a one-round array, where scoping is unobservable — so the documented
  //    default was asserted nowhere. Two rounds make it observable.
  it('defaults to sending everything when the caller omits the parameter', () => {
    const result = extractUserMessage([...twoRounds, { role: 'user', content: 'follow up' }]);
    expect(result.userMessage).toContain('RESULT-ONE');
    expect(result.userMessage).toContain('RESULT-TWO');
  });

  // ── the legacy webchat heuristic returns from its own branch, and it is the branch these clients
  //    take: ChatGPT-Next-Web / Open WebUI re-send the whole transcript every turn, so a trailing
  //    `user` turn behind tool results is their normal shape, not an edge case. Reverting just that
  //    return to `lastUserText` restores the bug for all of them and left this file green.
  it('delivers the results on the legacy-heuristic path too', () => {
    const prev = process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
    process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC = '1';
    try {
      const result = extractUserMessage([...oneRound, { role: 'user', content: 'follow up' }], {}, false);
      expect(result.userMessage).toContain('RESULT-ONE');
      expect(result.userMessage).toContain('follow up');
      expect(result.isNewConversation).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC;
      else process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC = prev;
    }
  });

  // ── the 305 of 725 that ended in `assistant`. If the fix does not cover this shape it describes
  //    the bug wrongly: the trailing role was never what decided anything.
  it('sends the results when a trailing assistant message arrives on a thread with no history', () => {
    const result = extractUserMessage([...oneRound, { role: 'assistant', content: 'partial' }], {}, false);
    expect(result.userMessage).toContain('RESULT-ONE');
    expect(result.isNewConversation).toBe(false);
  });

  // ── the same trailing-user shape on a LIVE thread. The engine got no turn between the tool
  //    result and the caller appending a user message, so it has not seen the latest round — but it
  //    HAS seen everything before its own last assistant turn. Both halves are asserted, because
  //    only asserting the first would let a fix pass that re-sends the whole loop.
  it('sends only the unseen round when a trailing user message arrives on a live thread', () => {
    const result = extractUserMessage([...twoRounds, { role: 'user', content: 'follow up' }], {}, true);
    expect(result.userMessage).not.toContain('RESULT-ONE');
    expect(result.userMessage).toContain('RESULT-TWO');
    expect(result.userMessage).toContain('follow up');
  });

  // ── documented, not fixed: on a LIVE thread a trailing assistant message is the engine's own
  //    turn, which it could only have produced with those results in hand, so there is nothing new
  //    to send. Pinned here so the day someone needs the other answer, they see this test first.
  it('sends nothing when a live thread already answered past the results', () => {
    const result = extractUserMessage([...oneRound, { role: 'assistant', content: 'partial' }], {}, true);
    expect(result.userMessage).not.toContain('<tool_results>');
    expect(result.userMessage).toBe('go');
  });

  // ── a reset means the engine is about to be handed a brand new thread, so on that turn it holds
  //    nothing and every result has to go out. Scoping against the thread the caller just asked to
  //    discard would be the same drop with extra steps.
  it('still honors a reset header on a trailing user message carrying tool results', () => {
    const result = extractUserMessage(
      [...twoRounds, { role: 'user', content: 'fresh' }],
      { 'x-session-reset': 'TRUE' },
      true,
    );
    expect(result.isNewConversation).toBe(true);
    expect(result.userMessage).toContain('RESULT-ONE');
    expect(result.userMessage).toContain('RESULT-TWO');
  });

  // ── the regression this replaces must NOT come back. The guard's provenance is v2.11.1, dated
  //    2026-04-11 in this CHANGELOG (2.11.0, the day before, is the release that ADDED tool support;
  //    it is 2.11.1 that narrowed serialization to a trailing `tool` role): "tool results processed
  //    even when last message is not tool role — preventing stale tool results from being
  //    re-injected on user follow-ups". Pre-4.x commits are not in this repo, so that entry is the
  //    provenance. The shape test was the only signal available then; the scoping added since
  //    is a stronger one. On a live thread the exact v2.11.1 shape — engine answered, user follows
  //    up — still sends nothing, because everything before the engine's own assistant turn is
  //    scoped away. With no thread there is no transcript to be stale, so the result goes out.
  it('does not re-inject stale results into a live thread that already answered', () => {
    const answeredThenFollowUp: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'STALE' },
      { role: 'assistant', content: 'here is the answer' },
      { role: 'user', content: 'follow up' },
    ];
    expect(extractUserMessage(answeredThenFollowUp, {}, true).userMessage).toBe('follow up');
    expect(extractUserMessage(answeredThenFollowUp, {}, false).userMessage).toContain('STALE');
  });

  // ── the blocker. The empty-block guard on the line that assembles userMessage is what keeps a
  //    plain conversation out of the tool path. Replacing it with an unconditional prepend — the
  //    obvious simplification — fails 8 tests in this file, 3 of which exist on main already
  //    ('extracts last user message', 'extracts system prompt without flagging it as a new
  //    conversation', 'does NOT treat a single user message as a new conversation without reset
  //    header'), because every message then arrives with a leading blank line. Measured, not
  //    assumed. Asserting the negative shape here so it cannot come back quietly.
  it('leaves a request with no tool results untouched', () => {
    const plain: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    for (const live of [false, true]) {
      const result = extractUserMessage(plain, {}, live);
      expect(result.userMessage).toBe('c');
      expect(result.userMessage).not.toContain('<tool_results>');
      expect(result.systemPrompt).toBe('sys');
      expect(result.isNewConversation).toBe(false);
    }
  });

  // ── the OTHER half of that assembly line, and the one with no test until now. The expression is
  //    `toolResultBlock && lastUserText ? join : toolResultBlock || lastUserText`. Deleting the
  //    `toolResultBlock ||` term leaves `: lastUserText`, which type-checks, keeps every other test
  //    in this file green, and silently reproduces THE BUG THIS PR FIXES — the results vanish —
  //    on any turn where the caller's latest `user` message carries no text. That is a real OpenAI
  //    shape, not a contrivance: a multimodal turn whose content array holds only an image part.
  //    textOf() joins the `text` fields, so it returns '', and the block is then the entire
  //    message. Measured: with the fallback the message is 191 characters and carries the result;
  //    with `: lastUserText` it is ''.
  it('sends the results when the latest user turn carries an image and no text', () => {
    const imageOnly: OpenAIChatMessage[] = [
      { role: 'user', content: [{ type: 'image_url' }] },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
      // A non-`tool` trailing role, or the early return above would handle it instead.
      { role: 'assistant', content: 'let me look at that' },
    ];
    const result = extractUserMessage(imageOnly, {}, false);
    expect(result.userMessage).toContain('<tool_results>');
    expect(result.userMessage).toContain('RESULT-ONE');
    // No stray separator: the block is the whole message, not appended to an empty string.
    expect(result.userMessage.startsWith('<tool_results>')).toBe(true);
    expect(result.userMessage.endsWith('\n')).toBe(false);
  });

  it('leaves the active tool-use cycle exactly as it was', () => {
    // Unchanged on both sides of threadHasHistory: this shape always took the tool path.
    expect(extractUserMessage(twoRounds, {}, false).userMessage).toContain('RESULT-ONE');
    expect(extractUserMessage(twoRounds, {}, true).userMessage).not.toContain('RESULT-ONE');
    expect(extractUserMessage(twoRounds, {}, true).userMessage).toContain('RESULT-TWO');
  });

  // ── the legacy heuristic keeps firing exactly where it fired before. Folding it into a single
  //    early isNewConversation decision reads cleaner but flips this case from "deliver the
  //    results" to "recycle the session first", which is a behaviour change for legacy clients
  //    that this fix has no business making.
  it('does not let the legacy heuristic newly fire on a lone tool result', () => {
    process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC = '1';
    const lone: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
    ];
    for (const live of [false, true]) {
      const result = extractUserMessage(lone, {}, live);
      expect(result.isNewConversation).toBe(false);
      expect(result.userMessage).toContain('RESULT-ONE');
    }
    // And it still fires where it always did.
    expect(
      extractUserMessage([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
      ]).isNewConversation,
    ).toBe(true);
  });

  // ── the 400 contract is unchanged. Both the "no user message anywhere" reject and the carve-out
  //    that lets the active cycle through without one.
  it('keeps rejecting an array with no user message', () => {
    expect(() =>
      extractUserMessage(
        [
          { role: 'system', content: 'sys' },
          { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
          { role: 'assistant', content: 'x' },
        ],
        {},
        false,
      ),
    ).toThrow('No user message');
  });

  it('keeps accepting the active cycle with no user message', () => {
    const result = extractUserMessage(
      [{ role: 'system', content: 'sys' }, call('c1'), { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' }],
      {},
      false,
    );
    expect(result.userMessage).toContain('RESULT-ONE');
  });

  // ── serializeToolResults is untouched, and its quadratic guard has to stay that way. 10 rounds
  //    of 30k: a live thread pays for one round on BOTH shapes the fix now routes through it, so
  //    closing the trailing-user case costs a round, not the whole loop.
  it('keeps the tool loop linear on a live thread at 10 rounds x 30k', () => {
    const batch = 'X'.repeat(30000);
    const loop10: OpenAIChatMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 1; i <= 10; i++) {
      loop10.push(call('c' + i));
      loop10.push({ role: 'tool', tool_call_id: 'c' + i, content: batch });
    }
    const countRounds = (s: string) => (s.match(/<tool_result /g) || []).length;

    // active cycle, live thread: one round (this is upstream behaviour, asserted here so the fix
    // cannot regress it)
    expect(countRounds(extractUserMessage(loop10, {}, true).userMessage)).toBe(1);
    // trailing user message, live thread: also one round — the case the fix opens
    const withFollowUp: OpenAIChatMessage[] = [...loop10, { role: 'user', content: 'follow up' }];
    expect(countRounds(extractUserMessage(withFollowUp, {}, true).userMessage)).toBe(1);
    expect(extractUserMessage(withFollowUp, {}, true).userMessage.length).toBeLessThan(31000);
    // no history: all ten, which is the only correct answer and is one request per session
    expect(countRounds(extractUserMessage(withFollowUp, {}, false).userMessage)).toBe(10);
  });

  // ── and the limit of that guarantee, pinned because CHANGELOG.md now states it. The scoping
  //    slices from the LAST `assistant` message, so an array carrying none at all — a client that
  //    does not echo the `tool_calls` turn it is answering — gets lastIndexOf() === -1, slice(0),
  //    and every round. Unchanged by this fix, and true on the active-cycle shape too; the fix
  //    only makes the trailing-user shape reach the same code.
  it('does not scope at all when the array carries no assistant message', () => {
    const noAssistant: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'c1', content: 'RESULT-ONE' },
      { role: 'tool', tool_call_id: 'c2', content: 'RESULT-TWO' },
    ];
    expect(serializeToolResults(noAssistant, true)).toContain('RESULT-ONE');
    const live = extractUserMessage([...noAssistant, { role: 'user', content: 'follow up' }], {}, true);
    expect(live.userMessage).toContain('RESULT-ONE');
    expect(live.userMessage).toContain('RESULT-TWO');
  });
});

// ─── handleChatCompletion ────────────────────────────────────────────────────
//
// This handler had no unit coverage, which is how a regression reached two
// published releases: a reset turn stopped the live session, started a fresh
// one, and then decided whether to send the caller's system prompt using a
// `threadHasHistory` computed from the session that had just been thrown away.
// The engine got a brand new thread with no identity and the request returned
// 200. See issue #79.

/**
 * Fake SessionManagerLike. `listSessions()` must report the PREFIXED name, or
 * `sessionExists` is false and a resume test passes for the wrong reason.
 * `startSession()` clears the captured id (a new conversation has none yet) and
 * `stopSession()` drops the session, so the create/dispose flow is real.
 */
function fakeManager(opts: { threadId?: string; engineIdKey?: string; throwOnStatus?: boolean } = {}) {
  const idKey = opts.engineIdKey ?? 'codexThreadId';
  const live = new Map<string, Record<string, string | undefined>>();
  const sent: string[] = [];
  // The session always EXISTS; only the conversation id varies. Omitting it from
  // listSessions() instead would make `sessionExists` false, and a test asserting
  // "the prompt is sent" would then pass without ever reaching nativeThreadIsLive().
  live.set('openai-demo', { [idKey]: opts.threadId });

  const manager = {
    startSession: async (config: Record<string, unknown>) => {
      // A freshly created session has no conversation id yet.
      live.set(config.name as string, { [idKey]: undefined });
      return { name: config.name as string };
    },
    sendMessage: async (_name: string, message: string) => {
      sent.push(message);
      return { output: 'ok', events: [] };
    },
    stopSession: async (name: string) => {
      live.delete(name);
    },
    listSessions: () => [...live.keys()].map((name) => ({ name })),
    getStatus: (name: string) => {
      // The real manager throws for a session it does not know, or one that died between the
      // listSessions() call and this one. A total double makes the handler's catch unreachable.
      if (opts.throwOnStatus) throw new Error('session is gone');
      return { stats: { tokensIn: 0, tokensOut: 0, contextPercent: 1, ...(live.get(name) ?? {}) } };
    },
    compactSession: async () => ({}),
  };
  return { manager, sent };
}

function fakeRes() {
  return {
    writeHead: () => {},
    end: () => {},
    setHeader: () => {},
    write: () => true,
  } as unknown as Parameters<typeof handleChatCompletion>[3];
}

describe('handleChatCompletion — system prompt across a reset', () => {
  const ANCHOR = 'ANCHOR-9c1f';
  const body = {
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: `You are Foo. ${ANCHOR}` },
      { role: 'user', content: 'hello' },
    ],
  };

  it('skips the prompt on a genuine resumed turn', async () => {
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(manager, { ...body }, { 'x-session-id': 'demo' }, fakeRes());
    expect(sent[0]).not.toContain(ANCHOR);
  });

  it('sends the prompt when a reset creates a new thread', async () => {
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(manager, { ...body }, { 'x-session-id': 'demo', 'x-session-reset': '1' }, fakeRes());
    expect(sent[0]).toContain(ANCHOR);
  });

  it('sends the prompt when the engine never captured a conversation id', async () => {
    const { manager, sent } = fakeManager({ threadId: undefined });
    await handleChatCompletion(manager, { ...body }, { 'x-session-id': 'demo' }, fakeRes());
    expect(sent[0]).toContain(ANCHOR);
  });

  // cursor and opencode joined engineHasNativeConversation() in 4.12.0 but had no
  // case in nativeThreadIsLive(), so they took `default: return true` — the weaker
  // "it is in the map" predicate. A session whose first turn died before the id was
  // announced then looked identical to a healthy one, and lost its identity on
  // every subsequent turn, not just once.
  it('sends the prompt to a cursor session with no captured chat id', async () => {
    const { manager, sent } = fakeManager({ threadId: undefined, engineIdKey: 'cursorChatId' });
    await handleChatCompletion(
      manager,
      { model: 'composer-2', messages: body.messages },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent[0]).toContain(ANCHOR);
  });

  it('skips the prompt for a cursor session that has a chat id', async () => {
    const { manager, sent } = fakeManager({ threadId: 'chat_xyz', engineIdKey: 'cursorChatId' });
    await handleChatCompletion(
      manager,
      { model: 'composer-2', messages: body.messages },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent[0]).not.toContain(ANCHOR);
  });
});

// ─── handleChatCompletion — the wiring, not the predicate ────────────────────
//
// Everything above calls extractUserMessage() with `threadHasHistory` written out by hand, which
// tests the decision and NOT the wiring that feeds it. A fix whose handler passed the wrong value —
// or a literal — would leave every one of those tests green while production still dropped the
// results. So these drive the real handler with a SessionManager double and never mention
// `threadHasHistory`: the handler has to derive it from `listSessions()` + `getStatus()`.
//
// The shapes are the measured ones. `[user, assistant(tool_calls), tool, user]` with no session is
// what all 337 discards that logged session state looked like: needs_create=yes, engine turn count
// 0. Two of these tests carry TWO rounds rather than one, because with a single round the scoping
// has nothing to remove — `slice(lastIndexOf('assistant') + 1)` keeps the trailing tool message
// either way — so a one-round array cannot tell a correct `false` apart from a hardcoded `true`.
describe('handleChatCompletion — tool results reach the engine that has not seen them', () => {
  const call = (id: string) => ({
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ id, type: 'function' as const, function: { name: 'search', arguments: '{}' } }],
  });

  // The exact production shape: one round, then the caller's next user turn.
  const oneRoundThenUser = [
    { role: 'user', content: 'search for the Q3 numbers' },
    call('c1'),
    { role: 'tool', tool_call_id: 'c1', content: 'ROUND-ONE-PAYLOAD' },
    { role: 'user', content: 'now summarize' },
  ];

  // Two rounds, then the caller's next user turn. On a live thread ROUND-ONE is behind the last
  // `assistant` message and ROUND-TWO is in front of it, so the two values of `threadHasHistory`
  // give observably different messages — which is what makes this shape able to fail.
  const twoRoundsThenUser = [
    { role: 'user', content: 'search for the Q3 numbers' },
    call('c1'),
    { role: 'tool', tool_call_id: 'c1', content: 'ROUND-ONE-PAYLOAD' },
    call('c2'),
    { role: 'tool', tool_call_id: 'c2', content: 'ROUND-TWO-PAYLOAD' },
    { role: 'user', content: 'now summarize' },
  ];

  it('sends the results when the session does not exist yet', async () => {
    // `fresh` is absent from listSessions(), so the handler must resolve threadHasHistory to false
    // on its own. fakeManager is handed a thread id precisely so that a handler that looked the id
    // up on the wrong session, or ignored `sessionExists`, would see a live thread and scope.
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(
      manager,
      { model: 'gpt-5.5', messages: oneRoundThenUser },
      { 'x-session-id': 'fresh' },
      fakeRes(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('now summarize');
  });

  it('sends BOTH rounds when the session does not exist yet', async () => {
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(
      manager,
      { model: 'gpt-5.5', messages: twoRoundsThenUser },
      { 'x-session-id': 'fresh' },
      fakeRes(),
    );
    expect(sent[0]).toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('ROUND-TWO-PAYLOAD');
  });

  it('sends both rounds when the session exists but the engine never announced a conversation', async () => {
    // The other way the handler reaches false: the session is in the map, but codex never emitted
    // `thread.started`, so there is no transcript to have held anything.
    const { manager, sent } = fakeManager({ threadId: undefined });
    await handleChatCompletion(
      manager,
      { model: 'gpt-5.5', messages: twoRoundsThenUser },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent[0]).toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('ROUND-TWO-PAYLOAD');
  });

  it('scopes away the round a live thread already holds', async () => {
    // The regression guard on the other side. A handler that passed a literal false — or dropped
    // the nativeThreadIsLive() lookup — would re-send ROUND-ONE on every hop of the loop.
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(
      manager,
      { model: 'gpt-5.5', messages: twoRoundsThenUser },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent[0]).not.toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('ROUND-TWO-PAYLOAD');
    expect(sent[0]).toContain('now summarize');
  });

  it('sends everything on a reset turn, which throws the live thread away', async () => {
    // threadHasHistory is computed from the session as it was BEFORE the reset stops it, so the
    // `!isReset` term is what keeps the handler from scoping against a conversation it is about to
    // destroy. Driven through the handler because that ordering only exists here.
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(
      manager,
      { model: 'gpt-5.5', messages: twoRoundsThenUser },
      { 'x-session-id': 'demo', 'x-session-reset': '1' },
      fakeRes(),
    );
    expect(sent[0]).toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('ROUND-TWO-PAYLOAD');
  });

  it('leaves a plain conversation alone', async () => {
    // No tool messages: the assembly line must not put an empty block, or a stray blank line, in
    // front of the caller's text.
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(
      manager,
      {
        model: 'gpt-5.5',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'still there?' },
        ],
      },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent[0]).toBe('still there?');
  });

  // ── the handler derives threadHasHistory from THREE things: the session existing, the engine
  //    having a native conversation at all, and nativeThreadIsLive() reading the stats. The two
  //    tests below reach the two arms the codex fixtures above cannot, because a double whose
  //    getStatus never throws and whose engine is always native leaves them dead.

  it('sends everything when the manager cannot report the session state', async () => {
    // getStatus() throws — a session that died between listSessions() and here. The catch must
    // resolve to false (send everything), not to true (scope against a transcript nobody
    // confirmed). Flipping that catch to `true` was invisible to every other test in this file.
    const { manager, sent } = fakeManager({ threadId: 'thread_abc', throwOnStatus: true });
    await handleChatCompletion(
      manager,
      { model: 'gpt-5.5', messages: twoRoundsThenUser },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('ROUND-TWO-PAYLOAD');
  });

  it('sends everything to an engine that has no conversation to resume', async () => {
    // `gemini-9.9-experimental` resolves to the gemini engine, which has no resume surface, so
    // engineHasNativeConversation() is false and nothing may be scoped away however alive the
    // session looks. Without this, dropping that predicate from the guard reached
    // nativeThreadIsLive()'s `default: return true` arm and scoped a one-shot engine.
    const { manager, sent } = fakeManager({ threadId: 'thread_abc' });
    await handleChatCompletion(
      manager,
      { model: 'gemini-9.9-experimental', messages: twoRoundsThenUser },
      { 'x-session-id': 'demo' },
      fakeRes(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ROUND-ONE-PAYLOAD');
    expect(sent[0]).toContain('ROUND-TWO-PAYLOAD');
  });
});

// The trade this fix accepts, pinned rather than described. A client that does not record the
// engine's assistant reply in the array it re-sends is indistinguishable, from here, from one whose
// engine never saw that round — so the round goes out a second time. Duplicating a round costs
// redundant context; dropping it made the model answer without them and still return 200. The
// second half of this test is the part that matters: the duplication is bounded to ONE round —
// but only where the scoping runs, i.e. `threadHasHistory === true`. Every test below passes
// `true` for that reason. With `false` there is no bound to state, because nothing is scoped away
// and the whole array goes out by design: the engine holds nothing, so no round in it is a
// duplicate. The third case pins the other edge, where the bound does not hold even on a live
// thread: an array with no `assistant` message gives the scoping no boundary to slice at.
describe('extractUserMessage — the duplicate-once trade', () => {
  const call = (id: string): OpenAIChatMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'x', arguments: '{}' } }],
  });

  it('re-sends one round when the client omits the engine reply, and only one', () => {
    const hop1: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'ROUND-ONE' },
    ];
    expect(extractUserMessage(hop1, {}, true).userMessage).toContain('ROUND-ONE');

    // Same array plus a user turn, engine reply not recorded: ROUND-ONE goes out again.
    const hop2: OpenAIChatMessage[] = [...hop1, { role: 'user', content: 'and now?' }];
    expect(extractUserMessage(hop2, {}, true).userMessage).toContain('ROUND-ONE');

    // But a round the engine demonstrably closed is still not re-sent.
    const withClosedRound: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      call('c0'),
      { role: 'tool', tool_call_id: 'c0', content: 'ROUND-ZERO' },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'ROUND-ONE' },
      { role: 'user', content: 'and now?' },
    ];
    const out = extractUserMessage(withClosedRound, {}, true);
    expect(out.userMessage).not.toContain('ROUND-ZERO');
    expect(out.userMessage).toContain('ROUND-ONE');
  });

  it('is not bounded at all with no history, and not bounded on a live thread with no assistant', () => {
    const twoClosedRounds: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      call('c0'),
      { role: 'tool', tool_call_id: 'c0', content: 'ROUND-ZERO' },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'ROUND-ONE' },
      { role: 'user', content: 'and now?' },
    ];
    // threadHasHistory=false: nothing is scoped away, so "one round" is not the claim. Both go out,
    // and that is correct — the engine holds neither.
    const noHistory = extractUserMessage(twoClosedRounds, {}, false).userMessage;
    expect(noHistory).toContain('ROUND-ZERO');
    expect(noHistory).toContain('ROUND-ONE');

    // Live thread, but the client never echoes the assistant turn it is answering: lastIndexOf()
    // finds no boundary, slice(0) keeps everything, and the bound does not hold here either.
    const noAssistantEver: OpenAIChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'c0', content: 'ROUND-ZERO' },
      { role: 'tool', tool_call_id: 'c1', content: 'ROUND-ONE' },
      { role: 'user', content: 'and now?' },
    ];
    const live = extractUserMessage(noAssistantEver, {}, true).userMessage;
    expect(live).toContain('ROUND-ZERO');
    expect(live).toContain('ROUND-ONE');
  });
});

// ── A changed tool schema must not land in a session baked with the old one.
//
//    On the Claude engine the schemas go into the session's system prompt at
//    create time and are deliberately not re-injected per turn, so the session
//    key is the only thing that can notice a change. It hashed the tool name
//    and the first 64 characters of the description — not the parameters.
describe('resolveSessionKey — tool schema fingerprint', () => {
  const withTool = (parameters: unknown) => ({
    messages: [
      { role: 'system' as const, content: 'be helpful' },
      { role: 'user' as const, content: 'hi' },
    ],
    model: 'claude-sonnet-4-5',
    tools: [
      {
        type: 'function' as const,
        function: { name: 'issue_invoice', description: 'Issue an invoice', parameters },
      },
    ],
  });

  it('separates sessions when a parameter schema changes', () => {
    const before = resolveSessionKey(withTool({ type: 'object', properties: { id: { type: 'string' } } }), {});
    const after = resolveSessionKey(
      withTool({ type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }),
      {},
    );
    expect(before).not.toBe(after);
  });

  it('does not separate them for a re-serialised but identical schema', () => {
    // Key order is not a schema change; splitting on it would start a new
    // session on every request from a client that serialises differently.
    const a = resolveSessionKey(withTool({ type: 'object', properties: { id: { type: 'string' } } }), {});
    const b = resolveSessionKey(withTool({ properties: { id: { type: 'string' } }, type: 'object' }), {});
    expect(a).toBe(b);
  });
});

// ── An engine with no delta channel must still say something.
//
//    `sendMessage` reports the whole answer as its return value AND streams it
//    through `onChunk` for engines that have one. opencode, agy, the per-send
//    codex/cursor wrappers and one-shot custom engines never call it — and this
//    path emitted the role chunk and the stop chunk with nothing in between:
//    a 200 with an empty reply.
describe('handleChatCompletion — streaming an engine that does not emit deltas', () => {
  function recordingRes() {
    const written: string[] = [];
    const listeners = new Map<string, () => void>();
    return {
      written,
      res: {
        writeHead: () => {},
        setHeader: () => {},
        end: () => {},
        write: (s: string) => {
          written.push(s);
          return true;
        },
        on: (event: string, fn: () => void) => {
          listeners.set(event, fn);
        },
      } as unknown as Parameters<typeof handleChatCompletion>[3],
    };
  }

  const contentOf = (written: string[]): string =>
    written
      .filter((w) => w.startsWith('data: '))
      .map((w) => w.slice('data: '.length).trim())
      .filter((w) => w !== '[DONE]')
      .map((w) => {
        try {
          return (JSON.parse(w) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .join('');

  it('emits the returned output when nothing streamed', async () => {
    const manager = {
      startSession: async (c: Record<string, unknown>) => ({ name: c.name as string }),
      sendMessage: async () => ({ output: 'the whole answer', events: [] }),
      stopSession: async () => {},
      listSessions: () => [],
      getStatus: () => ({ stats: { tokensIn: 1, tokensOut: 1, contextPercent: 1 } }),
      compactSession: async () => ({}),
    };
    const { res, written } = recordingRes();

    await handleChatCompletion(
      manager as never,
      { model: 'opencode/x', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      {},
      res,
    );

    expect(contentOf(written)).toBe('the whole answer');
  });

  it('does not double it for an engine that does stream', async () => {
    // The counter is the whole point: without it the fallback would append the
    // full answer after the deltas that already carried it.
    const manager = {
      startSession: async (c: Record<string, unknown>) => ({ name: c.name as string }),
      sendMessage: async (_n: string, _m: string, opts?: { onChunk?: (s: string) => void }) => {
        opts?.onChunk?.('the whole ');
        opts?.onChunk?.('answer');
        return { output: 'the whole answer', events: [] };
      },
      stopSession: async () => {},
      listSessions: () => [],
      getStatus: () => ({ stats: { tokensIn: 1, tokensOut: 1, contextPercent: 1 } }),
      compactSession: async () => ({}),
    };
    const { res, written } = recordingRes();

    await handleChatCompletion(
      manager as never,
      { model: 'claude-sonnet-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      {},
      res,
    );

    expect(contentOf(written)).toBe('the whole answer');
  });
});
