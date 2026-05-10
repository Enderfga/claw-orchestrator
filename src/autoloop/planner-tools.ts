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
 * validates them, and translates them into runner-queue messages or direct
 * runner-state mutations. Multiple blocks per turn are allowed and processed
 * in order.
 *
 * The naming intentionally mirrors tasks/autoloop.md §4.2 so a future
 * MCP-based implementation can swap the parser for real tool dispatch
 * without changing any Planner-facing semantics.
 */

import { type AnyAutoloopMessage, Msg, type PushChannel, type PushLevel } from './messages.js';

export type PlannerToolName =
  | 'notify_user'
  | 'spawn_subagents'
  | 'send_directive'
  | 'pause_loop'
  | 'resume_loop'
  | 'terminate'
  | 'update_push_policy'
  | 'write_plan_committed'
  | 'write_goal_committed';

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
  coder_engine?: string;
  reviewer_model?: string;
  reviewer_engine?: string;
  initial_directive?: {
    goal: string;
    constraints?: string[];
    success_criteria?: string[];
    max_attempts?: number;
  };
}

export interface PlannerToolEffects {
  /** Start Coder + Reviewer persistent sessions. S4 implements this. */
  spawnSubagents: (args: SpawnSubagentsArgs) => Promise<void>;
  /** Mutate in-memory push policy (key→rule object). Unknown keys ignored. */
  updatePushPolicy: (delta: Record<string, unknown>) => void;
  /** Best-effort `git add <file> && git commit -m <msg>` on the workspace. */
  commitPlanFile: (file: 'plan.md' | 'goal.json', message?: string) => Promise<void>;
}

// ─── Tool execution ──────────────────────────────────────────────────────────

export interface PlannerToolHandlerResult {
  /** Messages the runner should push into its own queue. */
  emitted_messages: AnyAutoloopMessage[];
  /** Errors encountered while handling this batch (does not throw). */
  errors: Array<{ tool: string; error: string }>;
}

/**
 * Apply a batch of parsed tool calls in order. Returns any v2 envelopes that
 * the dispatcher should hand back to the runner so it can route them.
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
  const emitted_messages: AnyAutoloopMessage[] = [];
  const errors: Array<{ tool: string; error: string }> = [];

  for (const call of calls) {
    try {
      switch (call.tool) {
        case 'notify_user': {
          const { level, summary, detail, channel } = call.args as {
            level?: PushLevel;
            summary?: string;
            detail?: string;
            channel?: PushChannel;
          };
          if (!summary) throw new Error('notify_user requires `summary`');
          emitted_messages.push(
            Msg.pushUser(iter, {
              level: level ?? 'info',
              summary,
              detail,
              channel: channel ?? 'auto',
            }),
          );
          break;
        }
        case 'spawn_subagents': {
          await fx.spawnSubagents(call.args as SpawnSubagentsArgs);
          // If caller asked for an initial directive, fire it via the runner queue.
          const init = (call.args as SpawnSubagentsArgs).initial_directive;
          if (init?.goal) {
            emitted_messages.push(
              Msg.directive(iter, {
                goal: init.goal,
                constraints: init.constraints ?? [],
                success_criteria: init.success_criteria ?? [],
                max_attempts: init.max_attempts ?? 1,
              }),
            );
          }
          break;
        }
        case 'send_directive': {
          const { goal, constraints, success_criteria, max_attempts } = call.args as {
            goal?: string;
            constraints?: string[];
            success_criteria?: string[];
            max_attempts?: number;
          };
          if (!goal) throw new Error('send_directive requires `goal`');
          emitted_messages.push(
            Msg.directive(iter, {
              goal,
              constraints: constraints ?? [],
              success_criteria: success_criteria ?? [],
              max_attempts: max_attempts ?? 1,
            }),
          );
          break;
        }
        case 'pause_loop': {
          emitted_messages.push(
            Msg.pause(iter, {
              reason: ((call.args as { reason?: string }).reason as string) ?? 'planner-pause',
            }),
          );
          break;
        }
        case 'resume_loop': {
          emitted_messages.push(Msg.resume(iter));
          break;
        }
        case 'terminate': {
          emitted_messages.push(
            Msg.terminate(iter, {
              reason: ((call.args as { reason?: string }).reason as string) ?? 'planner-terminate',
            }),
          );
          break;
        }
        case 'update_push_policy': {
          fx.updatePushPolicy(call.args);
          break;
        }
        case 'write_plan_committed': {
          await fx.commitPlanFile('plan.md', (call.args as { message?: string }).message);
          break;
        }
        case 'write_goal_committed': {
          await fx.commitPlanFile('goal.json', (call.args as { message?: string }).message);
          break;
        }
        default:
          errors.push({ tool: call.tool as string, error: `unknown planner tool: ${call.tool}` });
      }
    } catch (err) {
      errors.push({ tool: call.tool, error: (err as Error).message });
    }
  }

  return { emitted_messages, errors };
}
