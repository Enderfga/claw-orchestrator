/**
 * Anthropic ↔ OpenAI Format Adapter
 *
 * Core conversion logic for translating between Anthropic Messages API format
 * and OpenAI Chat Completions format. Replaces the Python server.py (~2300 lines)
 * with pure TypeScript (~600 lines), no litellm dependency.
 *
 * Handles:
 * - Message format conversion (content blocks ↔ role/content strings)
 * - Tool schema conversion (Anthropic tools ↔ OpenAI function tools)
 * - Message normalization (re-interleave merged blocks for OpenAI)
 * - Response conversion (OpenAI response → Anthropic response)
 * - Streaming SSE conversion (OpenAI SSE → Anthropic SSE events)
 */

import { randomUUID } from 'node:crypto';
const uuidv4 = randomUUID;
import { cleanGeminiSchema } from './schema-cleaner.js';
import { cacheThoughtSig } from './thought-cache.js';
import { isGeminiModel, isClaudeModel } from '../models.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: { type: string; budget_tokens?: number };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  model: string;
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function: { name: string } };
  thinking?: { type: string; budget_tokens?: number };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  extra_content?: Record<string, unknown>;
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAIResponse {
  id?: string;
  model?: string;
  choices: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// Re-export for backward compat (tests import from here)
export { isGeminiModel, isClaudeModel };

// ─── Anthropic → OpenAI Conversion ───────────────────────────────────────────

export function convertAnthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const isGemini = isGeminiModel(req.model);

  // 1. System message
  let systemText = '';
  if (typeof req.system === 'string') {
    systemText = req.system;
  } else if (Array.isArray(req.system)) {
    systemText = req.system.map((b) => b.text || '').join('\n');
  }

  // 2. Convert messages
  const rawMessages = convertMessages(req.messages);

  // 3. Normalize for OpenAI interleaving
  const normalized = normalizeMessagesForOpenAI(rawMessages);

  // 4. Prepend system
  const messages: OpenAIMessage[] = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push(...normalized);

  // 5. Max tokens
  let maxTokens = req.max_tokens || 4096;
  if (!isClaudeModel(req.model)) maxTokens = Math.min(maxTokens, 16384);
  if (isGemini && maxTokens < 8192) maxTokens = 8192;

  // 6. Build request
  const openaiReq: OpenAIRequest = {
    model: req.model,
    messages,
    max_completion_tokens: maxTokens,
    temperature: req.temperature ?? 1.0,
    stream: req.stream ?? false,
  };

  if (req.top_p !== undefined) openaiReq.top_p = req.top_p;

  // 7. Thinking (Claude only)
  if (req.thinking && isClaudeModel(req.model)) {
    openaiReq.thinking = {
      type: req.thinking.type === 'enabled' ? 'enabled' : 'disabled',
      budget_tokens: req.thinking.budget_tokens || Math.max(maxTokens - 1000, 1024),
    };
  }

  // 8. Tools
  if (req.tools?.length) {
    openaiReq.tools = req.tools.map((tool) => {
      let schema = tool.input_schema || {};
      if (isGemini) schema = cleanGeminiSchema(schema) as Record<string, unknown>;
      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: schema,
        },
      };
    });
  }

  // 9. Tool choice
  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (tc.type === 'auto') openaiReq.tool_choice = 'auto';
    else if (tc.type === 'any') openaiReq.tool_choice = 'required';
    else if (tc.type === 'none') openaiReq.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  return openaiReq;
}

// ─── Message Conversion ──────────────────────────────────────────────────────

function convertMessages(messages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled separately

    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      continue;
    }

    // Content blocks
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: OpenAIMessage[] = [];

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `tool_${uuidv4()}`,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
          },
        });
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content,
        });
      }
    }

    if (msg.role === 'assistant') {
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      result.push(assistantMsg);
    } else if (msg.role === 'user') {
      // Tool results first, then text
      result.push(...toolResults);
      if (textParts.length) {
        result.push({ role: 'user', content: textParts.join('\n') });
      }
    }
  }

  return result;
}

// ─── Message Normalization ───────────────────────────────────────────────────

/**
 * Re-interleave messages for OpenAI's strict format:
 * - assistant message with tool_calls must be followed by tool messages
 * - No consecutive same-role messages (merge them)
 * - Tool messages must reference a tool_call_id from previous assistant
 */
function normalizeMessagesForOpenAI(messages: OpenAIMessage[]): OpenAIMessage[] {
  const normalized: OpenAIMessage[] = [];

  for (const msg of messages) {
    const last = normalized[normalized.length - 1];

    if (msg.role === 'tool') {
      // Tool result — must follow an assistant with tool_calls
      normalized.push(msg);
    } else if (msg.role === 'assistant') {
      // Merge consecutive assistant messages
      if (last?.role === 'assistant' && !last.tool_calls && !msg.tool_calls) {
        last.content = [last.content || '', msg.content || ''].filter(Boolean).join('\n') || null;
      } else {
        normalized.push({ ...msg });
      }
    } else if (msg.role === 'user') {
      // Merge consecutive user messages
      if (last?.role === 'user') {
        last.content = [last.content || '', msg.content || ''].filter(Boolean).join('\n');
      } else {
        normalized.push({ ...msg });
      }
    } else {
      normalized.push(msg);
    }
  }

  return normalized;
}

// ─── OpenAI → Anthropic Response Conversion ──────────────────────────────────

export function convertOpenAIToAnthropic(resp: OpenAIResponse, originalModel: string): AnthropicResponse {
  const choice = resp.choices?.[0];
  const message = choice?.message;

  const content: AnthropicContentBlock[] = [];

  // Text content
  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Tool calls → tool_use blocks
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      let args: unknown = {};
      if (typeof tc.function.arguments === 'string') {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { raw: tc.function.arguments };
        }
      } else if (tc.function.arguments != null) {
        args = tc.function.arguments;
      }
      // Anthropic tool_use.input must be a JSON object — a null/scalar value
      // (some providers send arguments:null for no-arg tools) is invalid.
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        args = typeof args === 'undefined' ? {} : { value: args };
      }
      content.push({
        type: 'tool_use',
        id: tc.id || `tool_${uuidv4()}`,
        name: tc.function.name,
        input: args,
      });
    }
  }

  // Empty content fallback
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Stop reason mapping
  let stopReason = 'end_turn';
  const finishReason = choice?.finish_reason;
  if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'stop') stopReason = 'end_turn';

  // Fix: force tool_use if response has tool blocks but stop was "end_turn"
  const hasToolUse = content.some((c) => c.type === 'tool_use');
  if (stopReason === 'end_turn' && hasToolUse) stopReason = 'tool_use';

  return {
    id: resp.id || `msg_${uuidv4()}`,
    type: 'message',
    model: originalModel,
    role: 'assistant',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ─── Streaming SSE Conversion ────────────────────────────────────────────────

/**
 * Convert an OpenAI SSE stream to Anthropic SSE format.
 * Yields Anthropic-formatted SSE strings.
 */
export async function* convertStreamOpenAIToAnthropic(
  stream: AsyncIterable<string>,
  originalModel: string,
): AsyncGenerator<string> {
  // Emit message_start
  const msgId = `msg_${uuidv4()}`;
  yield sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      model: originalModel,
      role: 'assistant',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // Emit initial text block
  yield sseEvent('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  let textBlockOpen = true;
  let lastToolIndex = 0; // anthropic index (0 = text, 1+ = tools)
  let currentToolCallId: string | null = null;
  let finishReason: string | null = null;
  let completionTokens = 0;

  for await (const line of stream) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(line.slice(6));
    } catch {
      continue;
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) {
      // Usage chunk (OpenAI sends usage in final chunk)
      const usage = chunk.usage as Record<string, number> | undefined;
      if (usage) {
        completionTokens = usage.completion_tokens || 0;
      }
      continue;
    }

    const delta = choices[0].delta as Record<string, unknown> | undefined;
    if (!delta) {
      finishReason = (choices[0].finish_reason as string) || finishReason;
      continue;
    }

    finishReason = (choices[0].finish_reason as string) || finishReason;

    // Text delta
    const textContent = delta.content as string | undefined;
    if (textContent) {
      if (textBlockOpen) {
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: textContent },
        });
      }
    }

    // Tool calls
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const tcId = tc.id as string | undefined;
        const fn = tc.function as Record<string, string> | undefined;

        // New tool call
        if (tcId && tcId !== currentToolCallId) {
          // Close text block if still open
          if (textBlockOpen) {
            yield sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
            textBlockOpen = false;
          }
          // Close previous tool block
          if (currentToolCallId) {
            yield sseEvent('content_block_stop', { type: 'content_block_stop', index: lastToolIndex });
          }

          lastToolIndex++;
          currentToolCallId = tcId;

          // Cache thought signature if present (Gemini)
          const extra = tc.extra_content as Record<string, Record<string, string>> | undefined;
          const sig = extra?.google?.thought_signature || (tc.thought_signature as string | undefined);
          if (sig && tcId) cacheThoughtSig(tcId, sig);

          // Start new tool block
          yield sseEvent('content_block_start', {
            type: 'content_block_start',
            index: lastToolIndex,
            content_block: { type: 'tool_use', id: tcId, name: fn?.name || '', input: {} },
          });
        }

        // Tool arguments delta
        if (fn?.arguments) {
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: lastToolIndex,
            delta: { type: 'input_json_delta', partial_json: fn.arguments },
          });
        }
      }
    }
  }

  // Close remaining blocks
  if (currentToolCallId) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: lastToolIndex });
  } else if (textBlockOpen) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
  }

  // Stop reason
  let stopReason = 'end_turn';
  if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason === 'tool_calls') stopReason = 'tool_use';
  if (stopReason === 'end_turn' && currentToolCallId) stopReason = 'tool_use';

  // message_delta (usage + stop)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: completionTokens },
  });

  // message_stop
  yield sseEvent('message_stop', { type: 'message_stop' });
}

// ─── SSE Helpers ─────────────────────────────────────────────────────────────

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
