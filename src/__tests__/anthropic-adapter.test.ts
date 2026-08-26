/**
 * Unit tests for Anthropic ↔ OpenAI format adapter
 */

import { describe, it, expect } from 'vitest';
import {
  isGeminiModel,
  isClaudeModel,
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  convertStreamOpenAIToAnthropic,
  type AnthropicRequest,
  type OpenAIResponse,
} from '../proxy/anthropic-adapter.js';

// ─── isGeminiModel ──────────────────────────────────────────────────────────

describe('isGeminiModel', () => {
  it('detects gemini-2.5-pro', () => {
    expect(isGeminiModel('gemini-2.5-pro')).toBe(true);
  });

  it('detects case insensitive', () => {
    expect(isGeminiModel('Gemini-Flash')).toBe(true);
  });

  it('rejects claude model', () => {
    expect(isGeminiModel('claude-sonnet-4-6')).toBe(false);
  });

  it('rejects gpt model', () => {
    expect(isGeminiModel('gpt-4o')).toBe(false);
  });
});

// ─── isClaudeModel ──────────────────────────────────────────────────────────

describe('isClaudeModel', () => {
  it('detects claude-opus-4-6', () => {
    expect(isClaudeModel('claude-opus-4-6')).toBe(true);
  });

  it('detects opus alias', () => {
    expect(isClaudeModel('opus')).toBe(true);
  });

  it('detects sonnet alias', () => {
    expect(isClaudeModel('sonnet')).toBe(true);
  });

  it('detects haiku alias', () => {
    expect(isClaudeModel('haiku')).toBe(true);
  });

  it('rejects gemini', () => {
    expect(isClaudeModel('gemini-2.5-pro')).toBe(false);
  });

  it('rejects gpt', () => {
    expect(isClaudeModel('gpt-4o')).toBe(false);
  });
});

// ─── convertAnthropicToOpenAI ───────────────────────────────────────────────

describe('convertAnthropicToOpenAI', () => {
  it('converts basic text messages', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.model).toBe('gpt-4o');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' });
    expect(result.messages[2]).toEqual({ role: 'user', content: 'How are you?' });
  });

  it('extracts system message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('handles array system blocks', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      system: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.messages[0].content).toBe('Part 1\nPart 2');
  });

  it('converts tool schemas to OpenAI format', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe('function');
    expect(result.tools![0].function.name).toBe('get_weather');
    expect(result.tools![0].function.description).toBe('Get current weather');
    expect(result.tools![0].function.parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
  });

  it('maps tool_choice correctly', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ name: 'test', input_schema: {} }],
      tool_choice: { type: 'tool', name: 'test' },
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'test' } });
  });

  it('enforces Gemini min max_tokens of 8192', () => {
    const req: AnthropicRequest = {
      model: 'gemini-2.5-pro',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.max_completion_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('caps non-Claude models at 16384 max_tokens', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100000,
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.max_completion_tokens).toBe(16384);
  });

  it('converts assistant tool_use content blocks', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
      ],
    };
    const result = convertAnthropicToOpenAI(req);
    const assistantMsg = result.messages[0];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toBe('Let me check');
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls![0].id).toBe('tool_1');
    expect(assistantMsg.tool_calls![0].function.name).toBe('get_weather');
    expect(assistantMsg.tool_calls![0].function.arguments).toBe('{"city":"NYC"}');
  });

  it('converts user tool_result blocks to tool messages', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 72F' }],
        },
      ],
    };
    const result = convertAnthropicToOpenAI(req);
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].tool_call_id).toBe('tool_1');
    expect(result.messages[0].content).toBe('Sunny, 72F');
  });
});

// ─── convertOpenAIToAnthropic ───────────────────────────────────────────────

describe('convertOpenAIToAnthropic', () => {
  it('converts text response', () => {
    const resp: OpenAIResponse = {
      id: 'resp_1',
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = convertOpenAIToAnthropic(resp, 'gpt-4o');
    expect(result.id).toBe('resp_1');
    expect(result.model).toBe('gpt-4o');
    expect(result.role).toBe('assistant');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' });
    expect(result.stop_reason).toBe('end_turn');
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  it('converts tool call response', () => {
    const resp: OpenAIResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const result = convertOpenAIToAnthropic(resp, 'gpt-4o');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('tool_use');
    expect(result.content[0].id).toBe('tc_1');
    expect(result.content[0].name).toBe('get_weather');
    expect(result.content[0].input).toEqual({ city: 'NYC' });
    expect(result.stop_reason).toBe('tool_use');
  });

  it('maps stop reasons correctly', () => {
    const makeResp = (reason: string): OpenAIResponse => ({
      choices: [{ message: { content: 'text' }, finish_reason: reason }],
    });

    expect(convertOpenAIToAnthropic(makeResp('stop'), 'gpt-4o').stop_reason).toBe('end_turn');
    expect(convertOpenAIToAnthropic(makeResp('length'), 'gpt-4o').stop_reason).toBe('max_tokens');
    expect(convertOpenAIToAnthropic(makeResp('tool_calls'), 'gpt-4o').stop_reason).toBe('tool_use');
  });

  it('forces tool_use stop reason when content has tool blocks', () => {
    const resp: OpenAIResponse = {
      choices: [
        {
          message: {
            content: 'text',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'test', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    };
    const result = convertOpenAIToAnthropic(resp, 'gpt-4o');
    expect(result.stop_reason).toBe('tool_use');
  });

  it('adds empty text block when content is empty', () => {
    const resp: OpenAIResponse = {
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
    };
    const result = convertOpenAIToAnthropic(resp, 'gpt-4o');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: '' });
  });
});

// ── `text → tool_use → text` is one valid Anthropic turn.
//
//    `textBlockOpen` was set false when the first tool block opened and never
//    set back, so the `if (textBlockOpen)` guard silently discarded everything
//    the model said after a tool call. Gemini through the OpenAI-compat
//    endpoint — which this file explicitly targets — emits that shape.
describe('convertStreamOpenAIToAnthropic — interleaved text and tool calls', () => {
  async function* lines(...chunks: unknown[]): AsyncGenerator<string> {
    for (const c of chunks) yield `data: ${JSON.stringify(c)}`;
    yield 'data: [DONE]';
  }

  const collect = async (gen: AsyncGenerator<string>) => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    for await (const raw of gen) {
      const [evLine, dataLine] = raw.trim().split('\n');
      events.push({
        event: evLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')) as Record<string, unknown>,
      });
    }
    return events;
  };

  it('keeps the text a model emits after a tool call', async () => {
    const events = await collect(
      convertStreamOpenAIToAnthropic(
        lines(
          { choices: [{ delta: { content: 'let me look' } }] },
          {
            choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] } }],
          },
          { choices: [{ delta: { content: 'here is what I found' } }] },
        ),
        'claude-sonnet-4-6',
      ),
    );

    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => e.data.delta as { type: string; text?: string })
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text)
      .join('');

    expect(text).toBe('let me lookhere is what I found');
  });

  it('gives the trailing text its own block, after the tool block closes', async () => {
    const events = await collect(
      convertStreamOpenAIToAnthropic(
        lines(
          { choices: [{ delta: { content: 'first' } }] },
          { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] },
          { choices: [{ delta: { content: 'second' } }] },
        ),
        'claude-sonnet-4-6',
      ),
    );

    const shape = events.filter((e) => e.event.startsWith('content_block')).map((e) => `${e.event}:${e.data.index}`);

    // text(0) … tool(1) … text(2), each opened and closed exactly once.
    expect(shape).toEqual([
      'content_block_start:0',
      'content_block_delta:0',
      'content_block_stop:0',
      'content_block_start:1',
      'content_block_delta:1',
      'content_block_stop:1',
      'content_block_start:2',
      'content_block_delta:2',
      'content_block_stop:2',
    ]);
  });

  it('leaves a plain text turn exactly as it was', async () => {
    const events = await collect(
      convertStreamOpenAIToAnthropic(lines({ choices: [{ delta: { content: 'hello' } }] }), 'claude-sonnet-4-6'),
    );
    const shape = events.filter((e) => e.event.startsWith('content_block')).map((e) => `${e.event}:${e.data.index}`);
    expect(shape).toEqual(['content_block_start:0', 'content_block_delta:0', 'content_block_stop:0']);
  });
});
