/**
 * Planner-emitted "tool calls" — parsing + handler dispatch.
 *
 * The Planner is a Claude Code subprocess; we cannot register first-class
 * MCP tools without standing up an MCP server. Instead, the Planner emits
 * structured intent as **fenced code blocks tagged `autoloop`**:
 *
 *   ```autoloop
 *   {"tool": "notify_user", "args": {"level": "info", "summary": "plan ready"}}
 *   ```
 *
 * After each Planner turn, the dispatcher scans the reply for these blocks,
 * validates the complete batch, and translates it into runner-queue messages
 * or direct runner-state mutations. Multiple blocks per turn are allowed, but
 * no effect is applied unless every block is valid.
 *
 * The naming is stable so a future MCP-based implementation can swap the
 * parser for real tool dispatch without changing any Planner-facing
 * semantics.
 */

import { ENGINE_TYPES, type EngineType } from '../types.js';
import { type AnyAutoloopMessage, Msg, type PushChannel, type PushLevel } from './messages.js';

export type PlannerToolName =
  | 'notify_user'
  | 'spawn_subagents'
  | 'send_directive'
  | 'pause_loop'
  | 'resume_loop'
  | 'terminate'
  | 'update_push_policy'
  | 'write_plan'
  | 'write_goal';

export interface PlannerToolCall {
  tool: PlannerToolName;
  args: Record<string, unknown>;
}

export interface PlannerToolParseResult {
  calls: PlannerToolCall[];
  /** Reply text with autoloop blocks stripped — what we actually show to user. */
  cleaned_reply: string;
  /** Per-block parse errors (block kept in cleaned reply for forensics). */
  parse_errors: Array<{ block_index: number; error: string }>;
}

const FENCE_RE = /```autoloop\s*\n([\s\S]*?)\n```/g;

/**
 * Scan reply text for `autoloop` fenced JSON blocks. Returns parsed tool calls
 * plus a cleaned reply with the blocks removed (so we don't show raw JSON to
 * the user).
 */
export function parsePlannerReply(reply: string): PlannerToolParseResult {
  const calls: PlannerToolCall[] = [];
  const parse_errors: Array<{ block_index: number; error: string }> = [];
  let blockIndex = 0;
  const cleaned = reply.replace(FENCE_RE, (_match, body: string) => {
    const idx = blockIndex++;
    try {
      const parsed = JSON.parse(body.trim()) as PlannerToolCall;
      if (typeof parsed?.tool !== 'string' || typeof parsed?.args !== 'object' || parsed.args === null) {
        parse_errors.push({ block_index: idx, error: 'block missing tool/args fields' });
        return ''; // strip even malformed blocks so user doesn't see raw JSON
      }
      calls.push(parsed);
    } catch (err) {
      parse_errors.push({ block_index: idx, error: (err as Error).message });
    }
    return '';
  });
  return { calls, cleaned_reply: cleaned.trim(), parse_errors };
}

// ─── Side-effect interface ───────────────────────────────────────────────────
//
// Most tool calls translate directly to v2 messages and go back to the runner
// via the dispatcher's return value. Only these three need real side effects
// outside the message bus.

export interface SpawnSubagentsArgs {
  coder_model?: string;
  coder_engine?: EngineType;
  reviewer_model?: string;
  reviewer_engine?: EngineType;
  initial_directive?: {
    goal: string;
    constraints?: string[];
    success_criteria?: string[];
    max_attempts?: number;
  };
}

export interface PlannerToolEffects {
  /** Start Coder + Reviewer persistent sessions. */
  spawnSubagents: (args: SpawnSubagentsArgs) => Promise<void>;
  /** Mutate in-memory push policy (key→rule object). Unknown keys ignored. */
  updatePushPolicy: (delta: Record<string, unknown>) => void;
  /** Atomically materialize the complete plan/goal write set. */
  writePlanFiles: (writes: readonly PlannerArtifactWrite[]) => Promise<void>;
}

export interface PlannerArtifactWrite {
  file: 'plan.md' | 'goal.json';
  content: string;
  commitMessage?: string;
}

// ─── Tool execution ──────────────────────────────────────────────────────────

export interface PlannerToolHandlerResult {
  /** Messages the runner should push into its own queue. */
  emitted_messages: AnyAutoloopMessage[];
  /** Errors encountered while handling this batch (does not throw). */
  errors: Array<{ tool: string; error: string }>;
}

interface PreparedPlannerCall {
  call: PlannerToolCall;
  artifact?: PlannerArtifactWrite;
  message?: AnyAutoloopMessage;
  policyDelta?: Record<string, unknown>;
  spawnArgs?: SpawnSubagentsArgs;
}

interface PreparedDirective {
  goal: string;
  constraints: string[];
  success_criteria: string[];
  max_attempts: number;
}

const PUSH_LEVELS = new Set<PushLevel>(['info', 'warn', 'decision', 'error']);
const PUSH_CHANNELS = new Set<PushChannel>(['auto', 'wechat', 'webchat', 'both', 'email']);

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function prepareDirective(raw: Record<string, unknown>, tool: string): PreparedDirective {
  const goal = raw.goal;
  if (typeof goal !== 'string' || !goal.trim()) throw new Error(`${tool} requires \`goal\``);
  const maxAttempts = raw.max_attempts ?? 1;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${tool} max_attempts must be a positive integer`);
  }
  return {
    goal,
    constraints: optionalStringArray(raw.constraints, `${tool} constraints`),
    success_criteria: optionalStringArray(raw.success_criteria, `${tool} success_criteria`),
    max_attempts: maxAttempts,
  };
}

function preparePlannerCall(call: PlannerToolCall, iter: number): PreparedPlannerCall {
  if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)) {
    throw new Error(`${call.tool} requires an object \`args\``);
  }

  switch (call.tool) {
    case 'notify_user': {
      const { level, summary, detail, channel } = call.args;
      if (typeof summary !== 'string' || !summary.trim()) throw new Error('notify_user requires `summary`');
      if (level !== undefined && (typeof level !== 'string' || !PUSH_LEVELS.has(level as PushLevel))) {
        throw new Error('notify_user has invalid `level`');
      }
      if (detail !== undefined && typeof detail !== 'string') throw new Error('notify_user `detail` must be a string');
      if (channel !== undefined && (typeof channel !== 'string' || !PUSH_CHANNELS.has(channel as PushChannel))) {
        throw new Error('notify_user has invalid `channel`');
      }
      return {
        call,
        message: Msg.pushUser(iter, {
          level: (level as PushLevel | undefined) ?? 'info',
          summary,
          detail,
          channel: (channel as PushChannel | undefined) ?? 'auto',
        }),
      };
    }
    case 'spawn_subagents': {
      const raw = call.args;
      if (
        'coder_custom_engine' in raw ||
        'reviewer_custom_engine' in raw ||
        'coderCustomEngine' in raw ||
        'reviewerCustomEngine' in raw ||
        'customEngine' in raw
      ) {
        throw new Error('spawn_subagents cannot include custom engine config; configure it at autoloop_start');
      }
      for (const field of ['coder_engine', 'reviewer_engine'] as const) {
        const value = raw[field];
        if (value !== undefined && (typeof value !== 'string' || !ENGINE_TYPES.includes(value as EngineType))) {
          throw new Error(`spawn_subagents ${field} has unknown engine '${String(value)}'`);
        }
      }
      for (const field of ['coder_model', 'reviewer_model'] as const) {
        const value = raw[field];
        if (value !== undefined && typeof value !== 'string') {
          throw new Error(`spawn_subagents ${field} must be a string`);
        }
      }
      const args: SpawnSubagentsArgs = {};
      if (raw.coder_engine !== undefined) args.coder_engine = raw.coder_engine as EngineType;
      if (raw.coder_model !== undefined) args.coder_model = raw.coder_model as string;
      if (raw.reviewer_engine !== undefined) args.reviewer_engine = raw.reviewer_engine as EngineType;
      if (raw.reviewer_model !== undefined) args.reviewer_model = raw.reviewer_model as string;
      let message: AnyAutoloopMessage | undefined;
      if (raw.initial_directive !== undefined) {
        if (
          typeof raw.initial_directive !== 'object' ||
          raw.initial_directive === null ||
          Array.isArray(raw.initial_directive)
        ) {
          throw new Error('spawn_subagents initial_directive must be an object');
        }
        const directive = prepareDirective(
          raw.initial_directive as Record<string, unknown>,
          'spawn_subagents initial_directive',
        );
        args.initial_directive = directive;
        message = Msg.directive(iter, directive);
      }
      return { call, message, spawnArgs: args };
    }
    case 'send_directive': {
      const directive = prepareDirective(call.args, 'send_directive');
      return { call, message: Msg.directive(iter, directive) };
    }
    case 'pause_loop': {
      const reason = call.args.reason ?? 'planner-pause';
      if (typeof reason !== 'string') throw new Error('pause_loop `reason` must be a string');
      return { call, message: Msg.pause(iter, { reason }) };
    }
    case 'resume_loop':
      return { call, message: Msg.resume(iter) };
    case 'terminate': {
      const reason = call.args.reason ?? 'planner-terminate';
      if (typeof reason !== 'string') throw new Error('terminate `reason` must be a string');
      return { call, message: Msg.terminate(iter, { reason }) };
    }
    case 'update_push_policy':
      return { call, policyDelta: call.args };
    case 'write_plan': {
      const { content, commit_message } = call.args;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('write_plan requires non-empty `content` (full plan.md body)');
      }
      if (commit_message !== undefined && typeof commit_message !== 'string') {
        throw new Error('write_plan `commit_message` must be a string');
      }
      return {
        call,
        artifact: { file: 'plan.md', content, commitMessage: commit_message as string | undefined },
      };
    }
    case 'write_goal': {
      const { content, commit_message } = call.args;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('write_goal requires non-empty `content` (full goal.json body)');
      }
      try {
        JSON.parse(content);
      } catch (error) {
        throw new Error(`write_goal content is not valid JSON: ${(error as Error).message}`);
      }
      if (commit_message !== undefined && typeof commit_message !== 'string') {
        throw new Error('write_goal `commit_message` must be a string');
      }
      return {
        call,
        artifact: { file: 'goal.json', content, commitMessage: commit_message as string | undefined },
      };
    }
    default:
      throw new Error(`unknown planner tool: ${call.tool}`);
  }
}

/**
 * Preflight a complete batch, materialize all artifact writes as one effect,
 * then apply policy/spawn effects. Spawn is deliberately last, independent of
 * block order, so roles never start against a partial artifact set.
 *
 * Note: notify_user / pause_loop / resume_loop / terminate / send_directive
 * become v2 messages and flow through the runner's normal queue (so policy,
 * dedup, push_log accounting all apply). Only spawn_subagents / commit /
 * push-policy mutation are direct side effects.
 */
export async function applyPlannerToolCalls(
  calls: PlannerToolCall[],
  fx: PlannerToolEffects,
  iter: number,
): Promise<PlannerToolHandlerResult> {
  const errors: Array<{ tool: string; error: string }> = [];
  const prepared: PreparedPlannerCall[] = [];

  for (const call of calls) {
    try {
      prepared.push(preparePlannerCall(call, iter));
    } catch (err) {
      errors.push({ tool: call.tool, error: (err as Error).message });
    }
  }

  if (errors.length > 0) return { emitted_messages: [], errors };

  for (const singleton of ['write_plan', 'write_goal', 'spawn_subagents'] as const) {
    if (prepared.filter(({ call }) => call.tool === singleton).length > 1) {
      errors.push({ tool: singleton, error: `duplicate ${singleton} control in one Planner batch` });
    }
  }
  if (errors.length > 0) return { emitted_messages: [], errors };

  const artifacts = prepared.flatMap(({ artifact }) => (artifact ? [artifact] : []));
  if (artifacts.length > 0) {
    try {
      await fx.writePlanFiles(artifacts);
    } catch (err) {
      return {
        emitted_messages: [],
        errors: [{ tool: artifacts.map(({ file }) => file).join(','), error: (err as Error).message }],
      };
    }
  }

  for (const entry of prepared) {
    if (!entry.policyDelta) continue;
    try {
      fx.updatePushPolicy(entry.policyDelta);
    } catch (err) {
      return { emitted_messages: [], errors: [{ tool: entry.call.tool, error: (err as Error).message }] };
    }
  }

  const spawnCall = prepared.find(({ spawnArgs }) => spawnArgs !== undefined);
  if (spawnCall?.spawnArgs) {
    try {
      await fx.spawnSubagents(spawnCall.spawnArgs);
    } catch (err) {
      return { emitted_messages: [], errors: [{ tool: spawnCall.call.tool, error: (err as Error).message }] };
    }
  }

  return {
    emitted_messages: prepared.flatMap(({ message }) => (message ? [message] : [])),
    errors,
  };
}
