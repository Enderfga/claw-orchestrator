/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Bridges OpenAI API format to persistent Claude Code sessions, enabling
 * webchat frontends (ChatGPT-Next-Web, Open WebUI, etc.) to use the plugin
 * as a drop-in backend. Stateful sessions maximize Anthropic prompt caching.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { resolveEngineAndModel, estimateTokens } from './models.js';
import { engineHasNativeConversation, type EngineType, type SessionStats } from './types.js';
import {
  OPENAI_COMPAT_DEFAULT_MODEL,
  OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD,
  OPENAI_COMPAT_SESSION_PREFIX,
} from './constants.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  user?: string;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: 'stop' | 'length' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Session Key Resolution ──────────────────────────────────────────────────

/**
 * Derive a session key from the request.
 * Priority: X-Session-Id header > user field > sha1(model + systemPrompt) > "default"
 *
 * The system-prompt-hash fallback prevents the bug where every caller without
 * X-Session-Id or `user` collapses onto a single shared "openai-default"
 * plugin session. In multi-caller setups (OpenClaw routing the main agent,
 * cron jobs, and subagents through the same gateway) that previously meant
 * every request serialized against every other and frequently picked up the
 * wrong session's appendSystemPrompt — also a privacy leak across callers.
 *
 * The model is mixed into the hash so that two callers with the same system
 * prompt but different requested models don't collide and silently get
 * responses from the wrong model. Originally diagnosed in PR #40 by
 * @megayounus786.
 */
/**
 * When set (to '1', 'true', 'yes'), the proxy preserves the pre-fix behavior:
 *   - tools injected into every user message
 *   - session key NOT fingerprinted by tools (same session across tool changes)
 * Default (unset) is the new behavior: tools embedded in session system prompt
 * at create time + session key fingerprinted by tools. The new behavior
 * eliminates periodic latency spikes but does not support mutating the tool
 * list within a single session (a new session is created when tools change).
 */
export function isToolsPerMessageModeEnabled(): boolean {
  const v = process.env.OPENAI_COMPAT_TOOLS_PER_MESSAGE;
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}

/**
 * Generate the "no built-in tools" system prompt preamble.
 * The `toolLocation` parameter controls how the model is told where to find
 * tool definitions — 'system' means "in the <available_tools> block below"
 * (tools baked into system prompt), 'user' means "in <available_tools> tags
 * in the user message" (legacy per-turn injection).
 */
export function noToolsSystemPrompt(toolLocation: 'system' | 'user'): string {
  const locationHint =
    toolLocation === 'system'
      ? 'in the <available_tools> block below'
      : 'in <available_tools> tags in the user message';
  return (
    'You are a helpful AI assistant acting as a pure LLM behind an API proxy.\n' +
    'You do NOT have access to any tools such as Bash, Read, Write, Edit, Glob, Grep, or any other built-in tools.\n' +
    'Do NOT attempt to call any tools or execute any commands.\n' +
    `When you need to perform an action, use ONLY the tools defined ${locationHint}, ` +
    'and respond with <tool_calls> tags as instructed there.\n' +
    'If no <available_tools> are provided, respond with text only.'
  );
}

/**
 * Build the full session system prompt for a Claude Code session with tools.
 * Exported for testability — called from `handleChatCompletion`.
 *
 * - Default mode: tools are embedded in the system prompt (cacheable by Anthropic).
 * - Legacy mode (OPENAI_COMPAT_TOOLS_PER_MESSAGE=1): tools are NOT embedded;
 *   they'll be injected per-turn in the user message instead.
 */
export function buildSessionSystemPrompt(
  tools: OpenAIChatCompletionRequest['tools'],
  callerSystemPrompt: string | undefined,
): string {
  if (isToolsPerMessageModeEnabled()) {
    const preamble = noToolsSystemPrompt('user');
    return callerSystemPrompt ? `${preamble}\n\n${callerSystemPrompt}` : preamble;
  }
  const preamble = noToolsSystemPrompt('system');
  const toolBlock = buildToolPromptBlock(tools);
  const systemWithTools = `${preamble}\n\n${toolBlock}`;
  return callerSystemPrompt ? `${systemWithTools}\n\n${callerSystemPrompt}` : systemWithTools;
}

export function resolveSessionKey(body: OpenAIChatCompletionRequest, headers: http.IncomingHttpHeaders): string {
  const headerKey = headers['x-session-id'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  if (body.user && body.user.trim()) return body.user.trim();
  const sys = (body.messages || [])
    .filter((m) => m && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const modelTag = (body.model || '').toString();
  // Include a fingerprint of the tool list so that two requests with the same
  // system prompt but different tool definitions land in different sessions.
  // The tool schemas are baked into the session system prompt on create; if
  // tools change we need a new session rather than re-using a stale one.
  // Hash only tool names + a short description prefix to keep the fingerprint
  // small and stable against schema formatting differences.
  //
  // Opt-out: OPENAI_COMPAT_TOOLS_PER_MESSAGE=1 restores the pre-fix behavior
  // of keying sessions only by system prompt + model. Enable this if you have
  // callers that mutate their tool list within one conversation and rely on
  // continuing history across tool changes.
  const toolsFingerprint = isToolsPerMessageModeEnabled()
    ? ''
    : (body.tools || [])
        .map((t) => {
          const fn = t?.function;
          if (!fn?.name) return '';
          const descPrefix = (typeof fn.description === 'string' ? fn.description : '').slice(0, 64);
          return `${fn.name}:${descPrefix}`;
        })
        .filter(Boolean)
        .join('|');
  if (sys || modelTag || toolsFingerprint) {
    return (
      'sys-' +
      createHash('sha1')
        .update(modelTag + '\n' + sys + '\n' + toolsFingerprint)
        .digest('hex')
        .slice(0, 12)
    );
  }
  return 'default';
}

/** Build the full session name from a key */
/**
 * A session key reaches us verbatim from the caller — the `x-session-id` header
 * or the `user` field — and the name derived from it becomes a DIRECTORY name:
 * `handleChatCompletion` builds `os.tmpdir()/openclaw-compat-<name>` and calls
 * `mkdirSync(..., {recursive: true})`, then starts the session there under
 * `permissionMode: 'bypassPermissions'`. A key carrying path separators
 * therefore both creates a directory anywhere the process can write and points
 * a permissionless agent at it — measured: `x-session-id: ../../../../etc/x`
 * resolved outside the temp dir entirely.
 *
 * Keys that are already safe pass through unchanged, so a caller using an
 * ordinary id keeps the session name it has always had. Anything else is
 * replaced by a hash of itself rather than escaped, which keeps distinct keys
 * distinct without having to reason about what a filesystem does with the
 * leftovers.
 */
const SAFE_SESSION_KEY = /^[A-Za-z0-9._-]{1,64}$/;

export function sessionNameFromKey(key: string): string {
  const safe =
    SAFE_SESSION_KEY.test(key) && !key.includes('..')
      ? key
      : `k-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
  return `${OPENAI_COMPAT_SESSION_PREFIX}${safe}`;
}

// ─── Function Calling Support ────────────────────────────────────────────────

/**
 * Convert OpenAI tool definitions into a structured prompt block.
 * Injected into the user message so the CLI model sees tool definitions
 * and responds with <tool_calls> tags when it wants to invoke a function.
 */
export function buildToolPromptBlock(tools: OpenAIChatCompletionRequest['tools']): string {
  if (!tools?.length) return '';

  const toolDefs = tools
    .map((t) => {
      const fn = t.function;
      const params = JSON.stringify(fn.parameters, null, 2);
      return `### ${fn.name}\n${fn.description}\n\nParameters:\n\`\`\`json\n${params}\n\`\`\``;
    })
    .join('\n\n');

  return (
    '<available_tools>\n' +
    'You have access to the following tools. When you need to use a tool, respond with a JSON array wrapped in <tool_calls> tags.\n\n' +
    'FORMAT:\n' +
    '<tool_calls>\n' +
    '[{"name": "tool_name", "arguments": {"param1": "value1"}}]\n' +
    '</tool_calls>\n\n' +
    'If you do NOT need any tools, respond normally with text only (no <tool_calls> tags).\n\n' +
    '## Available Tools\n\n' +
    toolDefs +
    '\n</available_tools>'
  );
}

/**
 * The calling convention without the schemas, for turns that resume a thread the
 * engine already holds.
 *
 * On an engine with a native conversation the full block from the first turn is
 * still in the transcript, so re-sending the schemas every turn only grows the
 * prompt — with a few dozen tools the pretty-printed block runs to tens of
 * thousands of tokens per turn and overflows the context window mid-loop.
 *
 * Injecting nothing is not the answer either: dropping the format rules also
 * drops the "you have no shell of your own, emit a tool call instead of running
 * it yourself" framing, and the CLI starts trying to do the work directly.
 */
export function buildToolReminderBlock(): string {
  return (
    '<available_tools>\n' +
    'The tools defined earlier in this conversation are still available. When you need one, respond with a JSON array wrapped in <tool_calls> tags.\n\n' +
    'FORMAT:\n' +
    '<tool_calls>\n' +
    '[{"name": "tool_name", "arguments": {"param1": "value1"}}]\n' +
    '</tool_calls>\n\n' +
    "Do not carry out a tool's work yourself — emit the tool call and wait for its result.\n" +
    'If you do NOT need any tools, respond normally with text only (no <tool_calls> tags).\n' +
    '</available_tools>'
  );
}

export interface ParsedToolCalls {
  textContent: string | null;
  toolCalls: OpenAIToolCall[];
}

/**
 * Parse tool_calls from CLI text output.
 *
 * Looks for <tool_calls>[...]</tool_calls> tags in the response text.
 * Returns both the extracted text content (before/after tags) and any tool calls found.
 */
export function parseToolCallsFromText(text: string): ParsedToolCalls {
  // Match ALL <tool_calls> blocks (model may output multiple)
  const tagRegex = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/g;
  const allCalls: OpenAIToolCall[] = [];
  let lastIndex = 0;
  const textParts: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRegex.exec(text)) !== null) {
    // Collect text before this block
    const before = text.slice(lastIndex, m.index).trim();
    if (before) textParts.push(before);
    lastIndex = m.index + m[0].length;

    try {
      const parsed = JSON.parse(m[1].trim()) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of arr) {
        const call = raw as Record<string, unknown>;
        if (!call || typeof call !== 'object' || typeof call.name !== 'string') continue;
        let args: string;
        if (typeof call.arguments === 'string') {
          try {
            JSON.parse(call.arguments);
            args = call.arguments;
          } catch {
            args = JSON.stringify({ input: call.arguments });
          }
        } else {
          args = JSON.stringify(call.arguments ?? {});
        }
        allCalls.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function' as const,
          function: { name: call.name, arguments: args },
        });
      }
    } catch {
      // One block failed — keep its text as content
      textParts.push(m[0]);
    }
  }

  // Collect text after last block
  const after = text.slice(lastIndex).trim();
  if (after) textParts.push(after);

  // Strip <tool_result> and <tool_results> tags that the model may echo back
  // from the serialized tool results we injected earlier.
  const stripToolResultTags = (s: string): string =>
    s
      .replace(/<tool_results?>[\s\S]*?<\/tool_results?>/g, '')
      .replace(/<tool_results?[^>]*>/g, '')
      .trim();

  if (allCalls.length > 0) {
    const raw = textParts.join('\n').trim();
    const cleaned = raw ? stripToolResultTags(raw) : null;
    return { textContent: cleaned || null, toolCalls: allCalls };
  }

  const cleaned = text ? stripToolResultTags(text) : null;
  return { textContent: cleaned || null, toolCalls: [] };
}

/**
 * Serialize tool result messages into a text block for the CLI model.
 * Converts OpenAI `tool` role messages into <tool_result> tags.
 */
export function serializeToolResults(messages: OpenAIChatMessage[], latestRoundOnly = false): string {
  // On a thread that already holds the conversation, every tool result before the engine's most
  // recent assistant turn is already in the transcript. Re-serializing them costs the whole
  // history again on every hop, so the prompt grows quadratically across a tool loop: with a
  // 30k-character batch per round, hop 10 re-sends ~300k characters of results the engine has
  // already seen. Scoping to the results that answer the latest round is what keeps it linear.
  const scoped = latestRoundOnly ? messages.slice(messages.map((m) => m.role).lastIndexOf('assistant') + 1) : messages;
  const toolMessages = scoped.filter((m) => m.role === 'tool');
  if (!toolMessages.length) return '';

  const results = toolMessages
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `<tool_result tool_call_id="${m.tool_call_id || 'unknown'}">\n${content}\n</tool_result>`;
    })
    .join('\n\n');

  return `<tool_results>\n${results}\n</tool_results>\n\nAbove are the results of the tool calls you requested. Continue your response based on these results.`;
}

// ─── Message Extraction ──────────────────────────────────────────────────────

export interface ExtractedMessage {
  systemPrompt: string | undefined;
  userMessage: string;
  isNewConversation: boolean;
}

/**
 * Extract the relevant parts from an OpenAI messages array.
 *
 * Sessions are stateful — we only need the last user message. The tricky
 * question is whether to start a fresh session or append to the existing one.
 *
 * Default mode (no env var): only honor an explicit `X-Session-Reset: 1`
 * header. This is correct for clients that maintain their own conversation
 * transcript and forward only the latest user turn (OpenClaw main agent
 * loop, cron jobs, subagents). The previous heuristic
 * (`nonSystemMessages.length <= 1`) fired on every such request, killing the
 * persistent CLI every turn and preventing Anthropic prompt caching from
 * ever warming. Originally diagnosed in PR #40 by @megayounus786.
 *
 * Legacy mode (`OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`): restore the old
 * `system + single user ⇒ new conversation` rule, for clients that re-send
 * the full transcript on every turn (ChatGPT-Next-Web, Open WebUI, data
 * labeling tools, etc). They use the transcript shape itself as their only
 * "start a new conversation" signal.
 *
 * The env var is read on every call so ops can flip it via launchctl setenv
 * without restarting the server.
 */
export function extractUserMessage(
  messages: OpenAIChatMessage[],
  headers?: Record<string, string | string[] | undefined>,
  /**
   * Whether the engine's conversation already holds everything up to the caller's latest tool
   * round. Only meaningful for engines that resume a native conversation and only once the
   * conversation id has been captured — see nativeThreadIsLive(). Defaults to false so any caller
   * that cannot establish that keeps the safe behaviour of sending every result.
   *
   * This — not the shape of the caller's array — is what says whether a tool result is already in
   * the engine's transcript. They are different questions: an array can end in a `user` turn on a
   * thread that holds nothing at all.
   */
  threadHasHistory = false,
): ExtractedMessage {
  if (!messages || messages.length === 0) {
    throw new Error('messages array is empty');
  }

  // Normalize content from any message: OpenAI API allows content as a string
  // OR an array of content parts (e.g. multimodal messages with text + images).
  // We need a string for the CLI, so arrays are joined.
  const textOf = (m: OpenAIChatMessage): string => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .map((p) => p.text || '')
        .filter(Boolean)
        .join('');
    }
    return m.content != null ? String(m.content) : '';
  };

  // Extract system prompt if present
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages.length > 0 ? systemMessages.map(textOf).join('\n') : undefined;

  // Tool results that end the array: an active tool-use cycle, with no new caller text to carry.
  const lastNonSystem = [...messages].reverse().find((m) => m.role !== 'system');
  if (lastNonSystem?.role === 'tool') {
    const toolResultBlock = serializeToolResults(messages, threadHasHistory);
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserText = userMessages.length > 0 ? textOf(userMessages[userMessages.length - 1]) : '';
    const userMessage = lastUserText ? `${toolResultBlock}\n\n${lastUserText}` : toolResultBlock;
    return { systemPrompt, userMessage, isNewConversation: false };
  }

  // Find last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('No user message found in messages array');
  }
  const lastUserText = textOf(userMessages[userMessages.length - 1]);

  // 1. Explicit reset header — honored in both modes. Normalize trim+lowercase
  //    so callers using `TRUE`, ` 1 `, etc. don't silently fail.
  const rawReset = headers?.['x-session-reset'];
  const resetHeader = typeof rawReset === 'string' ? rawReset.trim().toLowerCase() : '';
  const isReset = resetHeader === 'true' || resetHeader === '1';

  // Tool results that did NOT end the array — the caller appended a `user` or `assistant` turn
  // after them. Whether they are already in the CLI's history is a question about the ENGINE, so
  // `threadHasHistory` decides it, not the trailing role: an array ending in `user` says nothing
  // about whether a transcript exists to have held the earlier rounds.
  //
  // A reset zeroes it: the session is about to be stopped and recreated, so on that turn the
  // engine holds nothing regardless of what it held a moment ago. serializeToolResults() returns
  // '' when there is nothing to send, so a request with no tool results is untouched, and on a
  // live thread the existing scoping still trims everything before the engine's last assistant
  // turn. What that bounds the hop to is precisely "the results that follow the engine's last
  // `assistant` turn" — one round for a client that echoes each `assistant` turn it answers, and
  // one round of N results for a single `assistant` announcing N parallel calls. It bounds nothing
  // when no `assistant` message sits after the earliest unsent `tool` message, because then
  // lastIndexOf('assistant') is behind them all and the slice keeps everything.
  const toolResultBlock = serializeToolResults(messages, threadHasHistory && !isReset);
  const userMessage =
    toolResultBlock && lastUserText ? `${toolResultBlock}\n\n${lastUserText}` : toolResultBlock || lastUserText;

  if (isReset) {
    return { systemPrompt, userMessage, isNewConversation: true };
  }

  // 2. Legacy heuristic — only when explicitly opted in via env var.
  if (process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC === '1') {
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    return { systemPrompt, userMessage, isNewConversation: nonSystemMessages.length <= 1 };
  }

  return { systemPrompt, userMessage, isNewConversation: false };
}

// ─── Response Formatting ─────────────────────────────────────────────────────

export function formatCompletionResponse(
  id: string,
  model: string,
  text: string,
  tokensIn: number,
  tokensOut: number,
  toolCalls?: OpenAIToolCall[],
): OpenAIChatCompletionResponse {
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut,
    },
  };
}

export function formatCompletionChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string },
  finishReason: string | null,
): OpenAIChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ─── Main Handler ────────────────────────────────────────────────────────────

/** SessionManager-like interface to avoid circular imports */
interface SessionManagerLike {
  startSession(config: Record<string, unknown>): Promise<{ name: string }>;
  sendMessage(
    name: string,
    message: string,
    options?: Record<string, unknown>,
  ): Promise<{ output: string; sessionId?: string; error?: string; events: unknown[] }>;
  stopSession(name: string): Promise<void>;
  listSessions(): Array<{ name: string }>;
  getStatus(name: string): {
    stats: {
      tokensIn: number;
      tokensOut: number;
      contextPercent: number;
      // Native-conversation ids. Optional because they only exist once the engine has actually
      // announced the conversation — see nativeThreadIsLive().
      codexThreadId?: string;
      agyConversationId?: string;
      cursorChatId?: string;
      opencodeSessionId?: string;
    };
  };
  compactSession(name: string): Promise<unknown>;
}

/**
 * Whether the engine's native conversation is known to exist for this session.
 *
 * `!needsCreate` only says the session is in the manager's map, which is not the same thing:
 * `start()` does not spawn a process, the conversation id is captured later (codex sets it on
 * `thread.started`, agy harvests it from the log after the first turn), and a send that fails
 * before that point leaves the session in the map with no id at all.
 *
 * The distinction matters wherever we decide to send a short reminder instead of the full state,
 * because a reminder that refers to a conversation the engine never created is silently wrong —
 * the request still returns 200.
 */
export function nativeThreadIsLive(
  engine: EngineType | undefined,
  stats: Pick<SessionStats, 'codexThreadId' | 'agyConversationId' | 'cursorChatId' | 'opencodeSessionId'>,
): boolean {
  switch (engine) {
    case 'codex':
    case 'codex-app':
      return !!stats.codexThreadId;
    case 'agy':
      return !!stats.agyConversationId;
    case 'cursor':
      return !!stats.cursorChatId;
    case 'opencode':
      return !!stats.opencodeSessionId;
    default:
      // claude and persistent custom engines hold their context in a live process, so there is no
      // separate id to check — being in the map is the strongest signal available.
      return true;
  }
}

export async function handleChatCompletion(
  manager: SessionManagerLike,
  body: Record<string, unknown>,
  headers: http.IncomingHttpHeaders,
  res: http.ServerResponse,
): Promise<void> {
  // Validate before casting
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  // Safe cast: messages validated above, other fields are optional
  const request: OpenAIChatCompletionRequest = {
    messages: body.messages as OpenAIChatMessage[],
    model: body.model as string | undefined,
    stream: body.stream as boolean | undefined,
    temperature: body.temperature as number | undefined,
    max_tokens: body.max_tokens as number | undefined,
    user: body.user as string | undefined,
    tools: body.tools as OpenAIChatCompletionRequest['tools'] | undefined,
  };

  // Validate max_tokens if provided
  if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens <= 0)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'max_tokens must be a positive number', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  const modelStr = request.model || OPENAI_COMPAT_DEFAULT_MODEL;
  const { engine, model: resolvedModel } = resolveEngineAndModel(modelStr);
  const sessionKey = resolveSessionKey(request, headers);
  const sessionName = sessionNameFromKey(sessionKey);
  const isStreaming = request.stream === true;

  // Resolved before extracting, because the extraction needs to know whether the engine's
  // conversation already holds the earlier tool results. In the tool-loop branch
  // `isNewConversation` is always false, so there `needsCreate` reduces to `!sessionExists` and
  // this is the same predicate the create path uses further down.
  const existingSessions = manager.listSessions().map((s) => s.name);
  const sessionExists = existingSessions.includes(sessionName);
  let threadHasHistory = false;
  if (sessionExists && engineHasNativeConversation(engine)) {
    try {
      threadHasHistory = nativeThreadIsLive(engine, manager.getStatus(sessionName).stats);
    } catch {
      threadHasHistory = false;
    }
  }

  let extracted: ExtractedMessage;
  try {
    extracted = extractUserMessage(
      request.messages,
      headers as Record<string, string | string[] | undefined>,
      threadHasHistory,
    );
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'invalid_request_error' } }));
    return;
  }

  // If new conversation detected and session exists, stop old one first
  if (extracted.isNewConversation && sessionExists) {
    try {
      await manager.stopSession(sessionName);
    } catch {
      /* session may have already been cleaned up */
    }
  }

  // Create session if needed
  const needsCreate = !sessionExists || extracted.isNewConversation;
  if (needsCreate) {
    // OpenAI-compat sessions are API proxies, not coding sessions.
    // Use a neutral empty temp dir so the CLI doesn't load CLAUDE.md,
    // git state, or project context from wherever `serve` was started.
    const sessionCwd = path.join(os.tmpdir(), `openclaw-compat-${sessionName}`);
    if (!fs.existsSync(sessionCwd)) fs.mkdirSync(sessionCwd, { recursive: true });
    const sessionConfig: Record<string, unknown> = {
      name: sessionName,
      cwd: sessionCwd,
      engine,
      model: resolvedModel,
      permissionMode: 'bypassPermissions',
      // skipPersistence: tells SessionManager not to write this session to
      // the disk registry, preventing auto-resume of stale sessions.
      // Note: noSessionPersistence (--no-session-persistence) is NOT set
      // because some CLI forks don't support this flag.
      skipPersistence: true,
    };
    // When the caller provides tool definitions, disable CLI built-in tools
    // (Bash, Read, Edit, etc.) so the model uses our text-defined tools
    // instead. Only works on Claude Code; forks that don't support --tools ""
    // will fall back to prompt-only instructions.
    if (request.tools?.length && engine === 'claude') {
      sessionConfig.tools = '';
    }
    // Claude Code CLI supports --system-prompt (replace) and --append-system-prompt (append).
    // When the caller provides tools, use --system-prompt to REPLACE the CLI's entire
    // system prompt via buildSessionSystemPrompt(). See that function's doc for details
    // on default vs legacy (OPENAI_COMPAT_TOOLS_PER_MESSAGE=1) behavior.
    if (engine === 'claude') {
      if (request.tools?.length) {
        sessionConfig.systemPrompt = buildSessionSystemPrompt(request.tools, extracted.systemPrompt);
      } else if (extracted.systemPrompt) {
        sessionConfig.appendSystemPrompt = extracted.systemPrompt;
      }
    }
    try {
      await manager.startSession(sessionConfig);
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Failed to start session: ${(err as Error).message}`, type: 'server_error' },
        }),
      );
      return;
    }
  }

  // Auto-compact if context is getting full
  if (sessionExists && !needsCreate) {
    try {
      const status = manager.getStatus(sessionName);
      if (status.stats.contextPercent > OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD) {
        await manager.compactSession(sessionName);
      }
    } catch {
      /* best effort — session may not support compact */
    }
  }

  // For non-claude engines (Cursor, Codex, Gemini), their CLIs don't support
  // --append-system-prompt, so the upstream system prompt is prepended to the user message here
  // rather than at session creation: these engines spawn a fresh CLI process per turn, and for the
  // ones that start from nothing each time the prepend is the only thing carrying the caller's
  // identity, tool definitions and workspace context forward.
  //
  // For the engines that resume a conversation, though, the process being fresh does not mean the
  // context is: the prompt is already in the transcript from the turn that put it there, so
  // repeating it adds a full copy per hop. This block predates the native-conversation distinction
  // and was not revisited when `schemasAlreadyInThread` introduced it a few lines below.
  //
  // Gated on the same predicate as the tool reminder, which also covers the case that makes this
  // risky: `agy` recovers its conversation id by matching the log of a third-party CLI, and without
  // that id every later send silently starts a fresh conversation. Today the unconditional prepend
  // hides that. `nativeThreadIsLive()` returns false exactly when the id is missing, so those turns
  // keep receiving the full prompt instead of losing their identity quietly.
  //
  // `threadHasHistory` describes the session as it was BEFORE the create block above, which is the
  // only point the tool results could be measured against. A reset turn stops that session and
  // starts a new one, so on that turn the value describes a conversation that no longer exists and
  // the new thread holds nothing — hence the `!needsCreate` term, which the tool gate below has
  // carried since 4.11.0. Recomputing after the create would not do: a freshly started session has
  // no id yet, and for engines whose id is only captured mid-turn that is indistinguishable from a
  // resumed thread that failed early.
  let userMessage = extracted.userMessage;
  if (extracted.systemPrompt && engine !== 'claude' && !(threadHasHistory && !needsCreate)) {
    userMessage = `<system>\n${extracted.systemPrompt}\n</system>\n\n${userMessage}`;
  }

  // Inject tool definitions into the user message.
  //
  // Default path for Claude Code: tools are already embedded in the session
  // system prompt (see session create block above) — do NOT re-inject them
  // per turn. Repeatedly prepending a large <available_tools> block to every
  // user message bloats each turn's input, defeats Anthropic prompt caching,
  // and was the cause of periodic 30-50s latency spikes.
  //
  // Opt-out path for Claude Code (OPENAI_COMPAT_TOOLS_PER_MESSAGE=1): fall
  // back to the legacy behavior of injecting the tool block into each user
  // message. Enables dynamic tool list updates within a single session.
  //
  // Non-claude engines: the CLI is spawned fresh per turn with no persistent
  // system prompt, so tools must be injected per message — but WHICH block
  // depends on whether the engine keeps the conversation itself:
  //
  //   - codex / codex-app / agy resume a thread, so the first turn's schemas are
  //     still in the transcript. Re-sending them every turn only grows the
  //     prompt; with ~50 tools that is tens of thousands of tokens per turn and
  //     the thread overflows the context window mid-loop. Send a reminder that
  //     restates the calling convention without the schemas.
  //   - cursor / opencode / gemini / one-shot custom start from nothing every
  //     send, so the full schemas have to go out every time.
  //
  // A fresh session always gets the full block regardless of engine, so a thread
  // is never created without the definitions (this also covers the case where a
  // session was evicted and is being recreated mid-conversation). A caller that
  // changes its tool list mid-conversation also lands on the full block: the
  // tool list is part of the session-name hash, so a different list resolves to
  // a different session, which is a fresh create.
  //
  // OPENAI_COMPAT_TOOLS_PER_MESSAGE is the exception — its whole purpose is to
  // re-send the full list every turn so the tool set can change within one
  // session (in that mode the tool list is deliberately left out of the session
  // hash), so it keeps getting full blocks.
  const hasTools = !!request.tools?.length;
  const perMessageMode = isToolsPerMessageModeEnabled();
  const injectToolsPerTurn = hasTools && (engine !== 'claude' || perMessageMode);
  if (injectToolsPerTurn) {
    let schemasAlreadyInThread = false;
    if (!needsCreate && !perMessageMode && engineHasNativeConversation(engine)) {
      try {
        schemasAlreadyInThread = nativeThreadIsLive(engine, manager.getStatus(sessionName).stats);
      } catch {
        // getStatus throws once the session is gone from the map; that is not a live thread.
        schemasAlreadyInThread = false;
      }
    }
    const toolBlock = schemasAlreadyInThread ? buildToolReminderBlock() : buildToolPromptBlock(request.tools);
    userMessage = `${toolBlock}\n\n${userMessage}`;
  }

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 29)}`;

  if (isStreaming) {
    await handleStreaming(manager, sessionName, resolvedModel, userMessage, completionId, res, hasTools);
  } else {
    await handleNonStreaming(manager, sessionName, resolvedModel, userMessage, completionId, res, hasTools);
  }

  // Clean up ephemeral sessions immediately after response.
  // When X-Session-Reset is set, each request creates a fresh session that
  // should not persist — leaving it alive leaks CLI subprocesses until TTL.
  if (extracted.isNewConversation) {
    manager.stopSession(sessionName).catch(() => {});
  }
}

// ─── Status Reporting ───────────────────────────────────────────────────────
// Push tool/thinking status to an external webhook so a webchat status bar
// can show what the CLI agent is doing. Best-effort fire-and-forget.

/**
 * Optional status webhook — set `OPENAI_COMPAT_STATUS_URL` to an HTTP endpoint
 * that accepts `POST { state, activity, tool }`. The bridge will fire-and-forget
 * status updates when the CLI agent uses tools, so an external dashboard (e.g.
 * a webchat status bar) can show real-time progress.
 *
 * Example: `OPENAI_COMPAT_STATUS_URL=http://127.0.0.1:18795/my-app/agent-status`
 */
function reportStatus(state: string, activity: string, tool?: string): void {
  const url = process.env.OPENAI_COMPAT_STATUS_URL;
  if (!url) return;
  const payload = JSON.stringify({ state, activity, tool: tool || null });
  const req = http.request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    },
    () => {},
  );
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

function getToolDescription(toolName: string, toolInput?: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'exec': {
      const cmd = String(toolInput?.command || '');
      return `Running: ${cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd}`;
    }
    case 'Read':
    case 'read':
      return `Reading: ${String(toolInput?.file_path || toolInput?.path || 'file')
        .split('/')
        .pop()}`;
    case 'Write':
    case 'write':
      return `Writing: ${String(toolInput?.file_path || toolInput?.path || 'file')
        .split('/')
        .pop()}`;
    case 'Edit':
    case 'edit':
      return `Editing: ${String(toolInput?.file_path || toolInput?.path || 'file')
        .split('/')
        .pop()}`;
    case 'Glob':
    case 'glob':
      return `Searching files: ${String(toolInput?.pattern || '')}`;
    case 'Grep':
    case 'grep':
      return `Searching content: ${String(toolInput?.pattern || '')}`;
    case 'WebSearch':
      return `Web search: ${String(toolInput?.query || '')}`;
    case 'Agent':
      return `Spawning sub-agent...`;
    default:
      return `Using tool: ${toolName}`;
  }
}

// ─── Non-Streaming ───────────────────────────────────────────────────────────

async function handleNonStreaming(
  manager: SessionManagerLike,
  sessionName: string,
  model: string,
  userMessage: string,
  completionId: string,
  res: http.ServerResponse,
  hasTools: boolean,
): Promise<void> {
  try {
    reportStatus('thinking', 'Processing request...');
    const result = await manager.sendMessage(sessionName, userMessage, {
      onEvent: (event: { type: string; tool?: { name?: string; input?: Record<string, unknown> } }) => {
        if (event.type === 'tool_use' && event.tool?.name) {
          const desc = getToolDescription(event.tool.name, event.tool.input);
          reportStatus('working', desc, event.tool.name);
        }
      },
    });
    reportStatus('idle', 'Ready');
    if (result.error) {
      // A 200 wrapping CLI error text reads as a successful completion to
      // OpenAI-compat callers — a gateway would accept it and stop falling back.
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: result.error, type: 'upstream_error' } }));
      return;
    }
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const status = manager.getStatus(sessionName);
      tokensIn = status.stats.tokensIn;
      tokensOut = status.stats.tokensOut;
    } catch {
      /* stats unavailable */
    }
    // Fall back to a length-based estimate rather than reporting usage as 0,
    // which breaks downstream cost accounting for OpenAI-compatible clients.
    if (tokensIn === 0) tokensIn = estimateTokens(userMessage);
    if (tokensOut === 0) tokensOut = estimateTokens(result.output);

    // Parse tool_calls from response text when caller provided tools
    if (hasTools) {
      const parsed = parseToolCallsFromText(result.output);
      const response = formatCompletionResponse(
        completionId,
        model,
        parsed.textContent ?? '',
        tokensIn,
        tokensOut,
        parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else {
      const response = formatCompletionResponse(completionId, model, result.output, tokensIn, tokensOut);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  } catch (err) {
    reportStatus('idle', 'Request failed');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }));
  }
}

// ─── Streaming ───────────────────────────────────────────────────────────────

async function handleStreaming(
  manager: SessionManagerLike,
  sessionName: string,
  model: string,
  userMessage: string,
  completionId: string,
  res: http.ServerResponse,
  hasTools: boolean,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
  });

  const writeSSE = (data: string) => {
    if (!clientDisconnected) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        clientDisconnected = true;
      }
    }
  };

  // Initial chunk with role
  writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { role: 'assistant' }, null)));

  // SSE keepalive heartbeat
  const heartbeatTimer = setInterval(() => {
    if (!clientDisconnected) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clientDisconnected = true;
      }
    }
  }, 30_000);

  // When tools are present, buffer the full response to parse for tool_calls.
  // Without tools, stream text chunks directly for low latency.
  let bufferedText = '';

  try {
    reportStatus('thinking', 'Processing request...');
    const result = await manager.sendMessage(sessionName, userMessage, {
      onChunk: (chunk: string) => {
        if (hasTools) {
          bufferedText += chunk;
          // Send keepalive comments during buffering to prevent timeouts
        } else {
          writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { content: chunk }, null)));
        }
      },
      onEvent: (event: { type: string; tool?: { name?: string; input?: Record<string, unknown> } }) => {
        if (event.type === 'tool_use' && event.tool?.name) {
          reportStatus('working', getToolDescription(event.tool.name, event.tool.input), event.tool.name);
        }
      },
    });
    reportStatus('idle', 'Ready');
    if (result.error) {
      // Headers already went out as 200; the SSE error object is the only way
      // left to tell the caller this turn failed rather than replied.
      writeSSE(JSON.stringify({ error: { message: result.error, type: 'upstream_error' } }));
      writeSSE('[DONE]');
      if (!clientDisconnected) res.end();
      return;
    }

    // Get token usage for final chunk
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    try {
      const status = manager.getStatus(sessionName);
      usage = {
        prompt_tokens: status.stats.tokensIn,
        completion_tokens: status.stats.tokensOut,
        total_tokens: status.stats.tokensIn + status.stats.tokensOut,
      };
    } catch {
      /* best effort */
    }

    if (hasTools && bufferedText) {
      const parsed = parseToolCallsFromText(bufferedText);

      if (parsed.toolCalls.length > 0) {
        // Emit text content if any
        if (parsed.textContent) {
          writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { content: parsed.textContent }, null)));
        }
        // Emit tool_call chunks
        for (let i = 0; i < parsed.toolCalls.length; i++) {
          const tc = parsed.toolCalls[i];
          writeSSE(
            JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.function.name, arguments: tc.function.arguments },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
        }
        // Final chunk with tool_calls finish reason
        const finalChunk = formatCompletionChunk(completionId, model, {}, 'tool_calls');
        if (usage) finalChunk.usage = usage;
        writeSSE(JSON.stringify(finalChunk));
      } else {
        // No tool calls — emit buffered text as content
        writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { content: bufferedText }, null)));
        const finalChunk = formatCompletionChunk(completionId, model, {}, 'stop');
        if (usage) finalChunk.usage = usage;
        writeSSE(JSON.stringify(finalChunk));
      }
    } else {
      // No tools — standard finish
      const finalChunk = formatCompletionChunk(completionId, model, {}, 'stop');
      if (usage) finalChunk.usage = usage;
      writeSSE(JSON.stringify(finalChunk));
    }
    writeSSE('[DONE]');
  } catch (err) {
    reportStatus('idle', 'Request failed');
    writeSSE(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }));
    writeSSE('[DONE]');
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (!clientDisconnected) {
    res.end();
  }
}
