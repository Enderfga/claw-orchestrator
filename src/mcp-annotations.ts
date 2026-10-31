/**
 * MCP tool annotations for the tools `src/index.ts` registers.
 *
 * Kept apart from `bin/mcp-server.ts`, which starts a stdio server as soon as it
 * is imported, so the test suite can check this map against the registry.
 */

export interface ToolAnnotation {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Hand-curated hints. MCP hosts surface these to the model so it can pick
// safer tools first (Hermes / Cursor / Claude Desktop all read them).
//
//   readOnly      — does not mutate workspace, sessions, files, or branches
//   destructive   — irreversible side-effects (delete worktree, drop branch, kill process)
//   openWorld     — touches things outside the local machine (model APIs)
//
// A hint left unset takes the MCP default: not read-only, destructive and
// open-world. So `{}` makes no lighter claim than the defaults; it records that
// the tool was looked at, and every registered tool has an entry.
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotation> = {
  // pure reads
  session_list: { readOnlyHint: true, idempotentHint: true },
  sessions_overview: { readOnlyHint: true, idempotentHint: true },
  coding_session_status: { readOnlyHint: true, idempotentHint: true },
  session_grep: { readOnlyHint: true, idempotentHint: true },
  session_inbox: { readOnlyHint: true, idempotentHint: true },
  coding_agents_list: { readOnlyHint: true, idempotentHint: true },
  team_list: { readOnlyHint: true, idempotentHint: true },
  council_status: { readOnlyHint: true, idempotentHint: true },
  council_review: { readOnlyHint: true, idempotentHint: true },
  ultraplan_status: { readOnlyHint: true, idempotentHint: true },
  ultrareview_status: { readOnlyHint: true, idempotentHint: true },
  autoloop_status: { readOnlyHint: true, idempotentHint: true },
  autoloop_list: { readOnlyHint: true, idempotentHint: true },
  codex_goal_get: { readOnlyHint: true, idempotentHint: true },
  claude_goal_status: { readOnlyHint: true, idempotentHint: true },
  claude_agents_list: { readOnlyHint: true, idempotentHint: true },
  plugin_details: { readOnlyHint: true, idempotentHint: true },
  codex_models: { readOnlyHint: true, idempotentHint: true },
  codex_thread_list: { readOnlyHint: true, idempotentHint: true },
  fanout_status: { readOnlyHint: true, idempotentHint: true },
  workflow_status: { readOnlyHint: true, idempotentHint: true },
  workflow_list: { readOnlyHint: true, idempotentHint: true },
  ultraapp_list: { readOnlyHint: true, idempotentHint: true },
  ultraapp_get: { readOnlyHint: true, idempotentHint: true },
  ultraapp_status: { readOnlyHint: true, idempotentHint: true },
  // destructive
  session_stop: { destructiveHint: true },
  council_abort: { destructiveHint: true },
  council_accept: { destructiveHint: true },
  council_reject: { destructiveHint: true },
  autoloop_stop: { destructiveHint: true },
  project_purge: { destructiveHint: true },
  codex_interrupt: { destructiveHint: true },
  codex_rollback: { destructiveHint: true },
  fanout_abort: { destructiveHint: true },
  workflow_cancel: { destructiveHint: true },
  ultraapp_build_cancel: { destructiveHint: true },
  ultraapp_promote_version: { destructiveHint: true },
  ultraapp_stop_container: { destructiveHint: true },
  ultraapp_delete: { destructiveHint: true },
  // mutating + open-world (call external model APIs)
  session_start: { openWorldHint: true },
  session_send: { openWorldHint: true },
  session_handoff: { openWorldHint: true },
  team_send: { openWorldHint: true },
  session_send_to: { openWorldHint: true },
  session_deliver_inbox: { openWorldHint: true },
  council_start: { openWorldHint: true },
  council_inject: { openWorldHint: true },
  ultraplan_start: { openWorldHint: true },
  ultrareview_start: { openWorldHint: true },
  autoloop_start: { openWorldHint: true },
  autoloop_chat: { openWorldHint: true },
  autoloop_resume: { openWorldHint: true },
  autoloop_reset_agent: {},
  codex_resume: { openWorldHint: true },
  codex_review: { openWorldHint: true },
  codex_goal_set: { openWorldHint: true },
  codex_goal_pause: {},
  codex_goal_resume: { openWorldHint: true },
  codex_goal_clear: {},
  session_compact: { openWorldHint: true },
  session_update_tools: {},
  session_switch_model: {},
  claude_goal_set: { openWorldHint: true },
  claude_goal_clear: {},
  codex_steer: { openWorldHint: true },
  codex_fork: {},
  fanout_start: { openWorldHint: true },
  workflow_start: { openWorldHint: true },
  workflow_resume: { openWorldHint: true },
  workflow_approve: { openWorldHint: true },
  workflow_steer: {},
  verify_run: { openWorldHint: true },
  ultraapp_new: { openWorldHint: true },
  ultraapp_answer: { openWorldHint: true },
  ultraapp_add_file: { openWorldHint: true },
  ultraapp_spec_edit: { openWorldHint: true },
  ultraapp_build_start: { openWorldHint: true },
  ultraapp_feedback: { openWorldHint: true },
  ultraapp_start_container: {},
};
