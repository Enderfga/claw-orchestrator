/**
 * claw-orchestrator — Plugin entry point
 *
 * Registers tools, hooks, and HTTP routes with the OpenClaw Plugin SDK.
 * When used standalone (no OpenClaw), exports SessionManager for direct use.
 *
 * Lazy initialisation: SessionManager and EmbeddedServer are created only on
 * the first tool call. While the plugin is registered but never used, it
 * consumes no memory beyond the tool schema definitions.
 */

import { SessionManager } from './session-manager.js';
import { createProxyHandler } from './proxy/handler.js';
import { EmbeddedServer } from './embedded-server.js';
import { sanitizeCwd, validateRegex } from './validation.js';
import type { PluginConfig, EffortLevel, CouncilConfig, AgentPersona } from './types.js';

// ─── Standalone Export ───────────────────────────────────────────────────────

export { SessionManager } from './session-manager.js';
export { PersistentClaudeSession } from './persistent-session.js';
export { BaseOneShotSession, type OneShotEngineConfig } from './base-oneshot-session.js';
export { PersistentCodexSession } from './persistent-codex-session.js';
export { PersistentGeminiSession } from './persistent-gemini-session.js';
export { PersistentCursorSession } from './persistent-cursor-session.js';
export { PersistentOpencodeSession } from './persistent-opencode-session.js';
export { PersistentCustomSession } from './persistent-custom-session.js';
export { Council, getDefaultCouncilConfig } from './council.js';
export { AutoloopRunner } from './autoloop/runner.js';
export { ClaudeAgentDispatcher } from './autoloop/dispatcher.js';
export { Msg as AutoloopMsg, validateMessage as autoloopValidate } from './autoloop/messages.js';
export type { AutoloopEnvelope, AnyAutoloopMessage, AutoloopMessageType, AutoloopRole } from './autoloop/messages.js';
export type { AgentDispatcher, AutoloopConfig, AutoloopState, AutoloopStatus, PushPolicy } from './autoloop/types.js';
export { parseConsensus, stripConsensusTags, hasConsensusMarker } from './consensus.js';
export { sanitizeCwd, validateRegex, validateName } from './validation.js';
export { type Logger, createConsoleLogger, nullLogger } from './logger.js';
export { CircuitBreaker } from './circuit-breaker.js';
export { InboxManager, type SessionLookup } from './inbox-manager.js';
export type { ISession } from './types.js';
export * from './types.js';

// ─── Plugin Entry ────────────────────────────────────────────────────────────

/** OpenClaw Plugin SDK interface (minimal typing for what we use) */
interface PluginAPI {
  pluginConfig: Record<string, unknown>;
  logger: { info(...args: unknown[]): void; error(...args: unknown[]): void; warn(...args: unknown[]): void };
  registerTool(def: {
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<void>): void;
  registerHttpRoute(def: {
    path: string;
    auth?: string;
    match?: string;
    handler: (...args: unknown[]) => Promise<boolean>;
  }): void;
  registerService(def: { id: string; start: () => void; stop: () => void }): void;
}

/**
 * OpenClaw plugin object — standard format
 */
const plugin = {
  id: 'claw-orchestrator',
  name: 'Claw Orchestrator',
  description:
    'Run Claude Code, Codex, Gemini, Cursor Agent and custom coding CLIs as one unified runtime — persistent sessions, multi-agent council, worktree isolation, multi-model proxy',

  register(api: PluginAPI): void {
    const rawConfig = (api.pluginConfig || {}) as Partial<PluginConfig>;

    // ─── Lazy Init ────────────────────────────────────────────────────────
    //
    // Neither SessionManager nor EmbeddedServer is created at plugin load
    // time. They are initialised on the first tool invocation and reused
    // thereafter. This keeps memory overhead at zero for users who have the
    // plugin installed but do not actively use Claude Code sessions.

    let manager: SessionManager | null = null;
    let server: EmbeddedServer | null = null;

    function getManager(): SessionManager {
      if (!manager) {
        api.logger.info('[claw-orchestrator] First use — initialising SessionManager and embedded server');
        manager = new SessionManager(rawConfig);
        server = new EmbeddedServer(manager);
        server.start().catch((err) => api.logger.error('[claw-orchestrator] Embedded server failed to start:', err));
      }
      return manager;
    }

    // ─── Service Lifecycle ────────────────────────────────────────────────

    api.registerService({
      id: 'claw-orchestrator',
      start: () => api.logger.info('[claw-orchestrator] Plugin registered (lazy init — will activate on first use)'),
      stop: () => {
        if (server) server.stop().catch(() => {});
        if (manager) manager.shutdown().catch(() => {});
        server = null;
        manager = null;
      },
    });

    // ─── Proxy HTTP Route (multi-model support) ───────────────────────────
    //
    // The proxy route handler itself is lightweight (just an HTTP handler
    // function); registering it eagerly is fine. The heavy proxy work only
    // happens when a request actually arrives.

    if (rawConfig.proxy?.enabled !== false) {
      const proxyHandler = createProxyHandler(rawConfig.proxy, {
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        openaiApiKey: process.env.OPENAI_API_KEY,
        geminiApiKey: process.env.GEMINI_API_KEY,
        gatewayUrl: process.env.GATEWAY_URL,
        gatewayKey: process.env.GATEWAY_KEY,
      });
      for (const path of ['/v1/claw-orchestrator-proxy', '/v1/claude-code-proxy']) {
        api.registerHttpRoute({
          path,
          auth: 'gateway',
          match: 'prefix',
          handler: proxyHandler as (...args: unknown[]) => Promise<boolean>,
        });
      }
    }

    // ─── Tool: session_start ──────────────────────────────────────────────

    api.registerTool({
      name: 'session_start',
      description:
        'Start a persistent coding session. Supports multiple engines: claude (default) for Claude Code CLI, codex for OpenAI Codex CLI, gemini for Google Gemini CLI, cursor for Cursor Agent CLI, opencode for sst/opencode CLI, or custom for any user-configured coding agent CLI.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name (auto-generated if omitted)' },
          cwd: { type: 'string', description: 'Working directory' },
          engine: {
            type: 'string',
            enum: ['claude', 'codex', 'codex-app', 'gemini', 'cursor', 'opencode', 'custom'],
            description:
              'Engine to use (default: claude). codex = `codex exec` per send (no /goal). codex-app = long-running `codex app-server` with /goal support. opencode = sst/opencode CLI (provider-agnostic; pass model as `provider/model`). Use "custom" with customEngine config for any CLI.',
          },
          model: { type: 'string', description: 'Model to use (opus, sonnet, haiku, gemini-pro, o4-mini, etc.)' },
          permissionMode: {
            type: 'string',
            enum: ['acceptEdits', 'bypassPermissions', 'default', 'delegate', 'dontAsk', 'plan', 'auto'],
          },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tools to auto-approve' },
          disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Tools to deny' },
          maxTurns: { type: 'number', description: 'Max agent loop turns' },
          maxBudgetUsd: { type: 'number', description: 'Max API spend (USD)' },
          systemPrompt: { type: 'string', description: 'Replace system prompt' },
          appendSystemPrompt: { type: 'string', description: 'Append to system prompt' },
          agents: { type: 'object', description: 'Custom sub-agents JSON' },
          agent: { type: 'string', description: 'Default agent to use' },
          bare: { type: 'boolean', description: 'Minimal mode: skip hooks, LSP, auto-memory, CLAUDE.md' },
          worktree: { type: ['string', 'boolean'], description: 'Run in git worktree' },
          fallbackModel: { type: 'string', description: 'Auto fallback when primary overloaded' },
          jsonSchema: { type: 'string', description: 'JSON Schema for structured output' },
          mcpConfig: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'MCP server config file(s)',
          },
          settings: { type: 'string', description: 'Settings.json path or inline JSON' },
          noSessionPersistence: { type: 'boolean', description: 'Do not save session to disk' },
          betas: { type: ['string', 'array'], items: { type: 'string' }, description: 'Custom beta headers' },
          enableAgentTeams: { type: 'boolean', description: 'Enable experimental agent teams' },
          enableAutoMode: { type: 'boolean', description: 'Enable auto permission mode' },
          includeHookEvents: {
            type: 'boolean',
            description: 'Stream hook lifecycle events (PreToolUse/PostToolUse)',
          },
          permissionPromptTool: {
            type: 'string',
            description: 'Delegate permission prompts to this MCP tool (non-interactive)',
          },
          excludeDynamicSystemPromptSections: {
            type: 'boolean',
            description:
              'Move cwd/env/git from system prompt to user message for better prompt cache hits (auto-enabled with bare)',
          },
          debug: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'Debug categories (e.g. "api", "mcp", "!statsig")',
          },
          debugFile: { type: 'string', description: 'Write debug output to file instead of stderr' },
          fromPr: { type: 'string', description: 'Resume session linked to a GitHub PR number or URL' },
          channels: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'MCP channel subscriptions (research preview)',
          },
          dangerouslyLoadDevelopmentChannels: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'Load development MCP channels',
          },
          enablePromptCaching1H: {
            type: 'boolean',
            description: 'Enable 1-hour prompt cache TTL (auto-enabled with bare)',
          },
          // CLI 2.1.121 features
          forkSubagent: {
            type: 'boolean',
            description: 'Fork subagent for non-interactive sessions (sets CLAUDE_CODE_FORK_SUBAGENT=1)',
          },
          enableToolSearch: {
            type: 'boolean',
            description: 'Enable Vertex AI tool search (sets ENABLE_TOOL_SEARCH=1)',
          },
          otelLogUserPrompts: {
            type: 'boolean',
            description: 'OpenTelemetry: log user prompts (sets OTEL_LOG_USER_PROMPTS=1)',
          },
          otelLogRawApiBodies: {
            type: 'boolean',
            description:
              'OpenTelemetry: log raw API request/response bodies (debug only, sets OTEL_LOG_RAW_API_BODIES=1)',
          },
          // CLI 2.1.122 features
          bedrockServiceTier: {
            type: 'string',
            enum: ['default', 'flex', 'priority'],
            description:
              'AWS Bedrock service tier (sets ANTHROPIC_BEDROCK_SERVICE_TIER). Only effective when routing through Bedrock.',
          },
          customEngine: {
            type: 'object',
            description:
              'Custom engine config (required when engine="custom"). Defines how to invoke any coding agent CLI.',
            properties: {
              name: { type: 'string', description: 'Engine display name' },
              bin: { type: 'string', description: 'Binary path or command' },
              binEnv: { type: 'string', description: 'Env var that overrides bin' },
              persistent: {
                type: 'boolean',
                description: 'true=long-running subprocess, false=spawn per send (default)',
              },
              args: {
                type: 'object',
                description: 'CLI flag mappings',
                properties: {
                  print: { type: 'string' },
                  outputFormat: { type: 'string' },
                  outputFormatValue: { type: 'string' },
                  inputFormat: { type: 'string' },
                  inputFormatValue: { type: 'string' },
                  skipPermissions: { type: 'string' },
                  permissionMode: { type: 'string' },
                  model: { type: 'string' },
                  systemPrompt: { type: 'string' },
                  appendSystemPrompt: { type: 'string' },
                  maxTurns: { type: 'string' },
                  resume: { type: 'string' },
                  verbose: { type: 'string' },
                  replayUserMessages: { type: 'string' },
                  includePartialMessages: { type: 'string' },
                  effort: { type: 'string' },
                  workspace: { type: 'string' },
                  extra: { type: 'array', items: { type: 'string' } },
                },
              },
              permissionModes: { type: 'object', description: 'Map OpenClaw permission names to CLI values' },
              pricing: {
                type: 'object',
                properties: {
                  input: { type: 'number' },
                  output: { type: 'number' },
                  cached: { type: 'number' },
                },
              },
              contextWindow: { type: 'number' },
              env: { type: 'object', description: 'Extra environment variables' },
              sanitizePatterns: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'bin', 'args'],
          },
          resumeSessionId: {
            type: 'string',
            description:
              'Resume an existing Claude Code session by its ID (e.g. from ~/.claude/sessions/). Replays conversation history via session/load instead of starting fresh.',
          },
        },
      },
      execute: async (_id, args) => {
        const sanitized = { ...args };
        if (sanitized.cwd) sanitized.cwd = sanitizeCwd(sanitized.cwd as string);
        const info = await getManager().startSession(sanitized as Parameters<SessionManager['startSession']>[0]);
        return { ok: true, ...info };
      },
    });

    // ─── Tool: session_send ───────────────────────────────────────────────

    api.registerTool({
      name: 'session_send',
      description: 'Send a message to a persistent coding session and get the response',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          message: { type: 'string', description: 'Message to send' },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max'],
            description: 'Effort for this message',
          },
          plan: { type: 'boolean', description: 'Enable plan mode' },
          timeout: { type: 'number', description: 'Timeout in ms (default 300000)' },
          stream: {
            type: 'boolean',
            description:
              'Collect text chunks as they arrive and include them in result.chunks[] (default false). Note: OpenClaw plugin SDK does not yet support mid-tool streaming to the caller, so chunks are buffered and returned with the final result.',
          },
        },
        required: ['name', 'message'],
      },
      execute: async (_id, args) => {
        const wantChunks = args.stream as boolean | undefined;
        const chunks: string[] = [];

        const result = await getManager().sendMessage(args.name as string, args.message as string, {
          effort: args.effort as EffortLevel | undefined,
          plan: args.plan as boolean | undefined,
          timeout: args.timeout as number | undefined,
          // When stream:true, collect chunks into array for caller.
          // True mid-tool streaming requires SDK-level support (not yet available).
          onChunk: wantChunks
            ? (chunk: string) => {
                chunks.push(chunk);
              }
            : undefined,
        });
        return {
          ok: true,
          ...result,
          ...(wantChunks ? { chunks } : {}),
        };
      },
    });

    // ─── Tool: session_stop ───────────────────────────────────────────────

    api.registerTool({
      name: 'session_stop',
      description: 'Stop a persistent coding session',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name' } },
        required: ['name'],
      },
      execute: async (_id, args) => {
        await getManager().stopSession(args.name as string);
        return { ok: true };
      },
    });

    // ─── Tool: session_list ───────────────────────────────────────────────

    api.registerTool({
      name: 'session_list',
      description: 'List all active coding sessions',
      parameters: { type: 'object', properties: {} },
      execute: async (_id) => {
        if (!manager) return { ok: true, sessions: [], persisted: [] };
        return { ok: true, sessions: manager.listSessions(), persisted: manager.listPersistedSessions() };
      },
    });

    // ─── Tool: sessions_overview ──────────────────────────────────────────

    api.registerTool({
      name: 'sessions_overview',
      description:
        'Get an aggregate overview of all active coding sessions — readiness, busy/paused state, cost, context usage, and last activity for each. Use this for a dashboard view across all sessions. For single-session detail, use coding_session_status instead.',
      parameters: { type: 'object', properties: {} },
      execute: async (_id) => {
        if (!manager)
          return {
            ok: true,
            version: 'unknown',
            sessions: 0,
            sessionNames: [],
            uptime: process.uptime(),
            details: [],
          };
        return manager.health();
      },
    });

    // ─── Tool: coding_session_status ──────────────────────────────────────

    api.registerTool({
      name: 'coding_session_status',
      description: 'Get detailed status of a coding session (context %, tokens, cost, uptime)',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name' } },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const status = getManager().getStatus(args.name as string);
        return { ok: true, ...status };
      },
    });

    // ─── Tool: session_grep ───────────────────────────────────────────────

    api.registerTool({
      name: 'session_grep',
      description: 'Search session history for events matching a regex pattern',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          pattern: { type: 'string', description: 'Regex pattern to search' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['name', 'pattern'],
      },
      execute: async (_id, args) => {
        validateRegex(args.pattern as string);
        const matches = await getManager().grepSession(
          args.name as string,
          args.pattern as string,
          args.limit as number | undefined,
        );
        return { ok: true, count: matches.length, matches };
      },
    });

    // ─── Tool: session_compact ────────────────────────────────────────────

    api.registerTool({
      name: 'session_compact',
      description: 'Compact a session to reclaim context window space',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          summary: { type: 'string', description: 'Optional summary for compaction' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        await getManager().compactSession(args.name as string, args.summary as string | undefined);
        return { ok: true };
      },
    });

    // ─── Tool: coding_agents_list ─────────────────────────────────────────

    api.registerTool({
      name: 'coding_agents_list',
      description: 'List agent definitions from .claude/agents/',
      parameters: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Project directory' } },
      },
      execute: async (_id, args) => {
        const agents = getManager().listAgents(sanitizeCwd(args.cwd as string | undefined));
        return { ok: true, agents };
      },
    });

    // ─── Tool: team_list ──────────────────────────────────────────────────

    api.registerTool({
      name: 'team_list',
      description: 'List teammates in an agent team session (requires enableAgentTeams)',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name' } },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const response = await getManager().teamList(args.name as string);
        return { ok: true, response };
      },
    });

    // ─── Tool: team_send ──────────────────────────────────────────────────

    api.registerTool({
      name: 'team_send',
      description: 'Send a message to a specific teammate in an agent team session',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          teammate: { type: 'string', description: 'Teammate name' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['name', 'teammate', 'message'],
      },
      execute: async (_id, args) => {
        const result = await getManager().teamSend(
          args.name as string,
          args.teammate as string,
          args.message as string,
        );
        return { ok: true, ...result };
      },
    });

    // ─── Tool: session_update_tools ───────────────────────────────────────

    api.registerTool({
      name: 'session_update_tools',
      description:
        'Update allowedTools or disallowedTools for a running session. Restarts the session process with --resume to apply the new tool constraints while preserving conversation history. Rejects if the session is currently busy.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'New allowedTools list (replaces existing, or merges if merge:true)',
          },
          disallowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'New disallowedTools list (replaces existing, or merges if merge:true)',
          },
          removeTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools to remove from allowedTools/disallowedTools (applied after merge)',
          },
          merge: { type: 'boolean', description: 'Merge with existing lists instead of replacing (default false)' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const info = await getManager().updateTools(args.name as string, {
          allowedTools: args.allowedTools as string[] | undefined,
          disallowedTools: args.disallowedTools as string[] | undefined,
          removeTools: args.removeTools as string[] | undefined,
          merge: args.merge as boolean | undefined,
        });
        return { ok: true, restarted: true, ...info };
      },
    });

    // ─── Tool: session_switch_model ───────────────────────────────────────

    api.registerTool({
      name: 'session_switch_model',
      description:
        'Switch the model for a running session immediately. Restarts the session process with --resume so the new model takes effect on the next message while preserving conversation history.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          model: { type: 'string', description: 'New model (opus, sonnet, haiku, gemini-pro, etc.)' },
        },
        required: ['name', 'model'],
      },
      execute: async (_id, args) => {
        const info = await getManager().switchModel(args.name as string, args.model as string);
        return { ok: true, restarted: true, ...info };
      },
    });

    // ─── Tool: project_purge (CLI 2.1.126) ────────────────────────────────

    api.registerTool({
      name: 'project_purge',
      description:
        'Delete Claude Code project state (transcripts, tasks, file history, config entry) via `claude project purge`. Defaults to dry-run for safety — pass dry_run=false to actually delete. Use all=true to purge every project.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Project path to purge (resolved to absolute). Ignored when all=true. Defaults to current cwd.',
          },
          all: {
            type: 'boolean',
            description: 'Purge state for every project. Mutually exclusive with path.',
          },
          dry_run: {
            type: 'boolean',
            description: 'List what would be deleted without deleting. Defaults to true for safety.',
          },
        },
      },
      execute: async (_id, args) => {
        const result = await getManager().purgeProject({
          path: args.path as string | undefined,
          all: args.all as boolean | undefined,
          dryRun: args.dry_run as boolean | undefined,
        });
        return { ok: true, ...result };
      },
    });

    // ─── Tool: codex_resume (Codex 0.119+) ──────────────────────────────

    api.registerTool({
      name: 'codex_resume',
      description:
        'Resume a previously recorded Codex thread by UUID/name, or pick the most recent with last=true. Spawns `codex exec resume` with --json so the output is parsed into structured fields. Independent of session manager state — useful for cross-process continuity.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Codex thread UUID or name. Mutually exclusive with last.' },
          last: { type: 'boolean', description: 'Resume the most recent recorded Codex session.' },
          message: { type: 'string', description: 'Prompt to send after resuming.' },
          cwd: { type: 'string', description: 'Working directory to run codex in.' },
          model: { type: 'string', description: 'Override model (e.g. gpt-5.5).' },
          timeout: { type: 'number', description: 'Timeout in ms (default 300000).' },
        },
        required: ['message'],
      },
      execute: async (_id, args) => {
        return await getManager().codexResume({
          sessionId: args.session_id as string | undefined,
          last: args.last as boolean | undefined,
          message: args.message as string,
          cwd: args.cwd as string | undefined,
          model: args.model as string | undefined,
          timeout: args.timeout as number | undefined,
        });
      },
    });

    // ─── Tool: codex_review ─────────────────────────────────────────────

    api.registerTool({
      name: 'codex_review',
      description:
        'Run a non-interactive Codex code review (`codex review`). Pick exactly one diff scope: uncommitted (working-tree changes), base (vs branch), or commit (vs SHA). Output is plain text — Codex `review` does not emit JSON.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Custom review instructions (optional).' },
          cwd: { type: 'string', description: 'Repository to review. Defaults to current cwd.' },
          uncommitted: {
            type: 'boolean',
            description: 'Review staged + unstaged + untracked changes. Mutually exclusive with base/commit.',
          },
          base: {
            type: 'string',
            description: 'Review changes against this base branch. Mutually exclusive with uncommitted/commit.',
          },
          commit: {
            type: 'string',
            description: 'Review changes introduced by this commit SHA. Mutually exclusive with uncommitted/base.',
          },
          title: { type: 'string', description: 'Optional commit title shown in the review summary.' },
          model: { type: 'string', description: 'Override model.' },
          timeout: { type: 'number', description: 'Timeout in ms (default 600000).' },
        },
      },
      execute: async (_id, args) => {
        return await getManager().codexReview({
          prompt: args.prompt as string | undefined,
          cwd: args.cwd as string | undefined,
          uncommitted: args.uncommitted as boolean | undefined,
          base: args.base as string | undefined,
          commit: args.commit as string | undefined,
          title: args.title as string | undefined,
          model: args.model as string | undefined,
          timeout: args.timeout as number | undefined,
        });
      },
    });

    // ─── Tools: codex_goal_* (Codex 0.128 /goal slash commands) ────────
    //
    // Goal mutation in Codex's v2 protocol is **server-side**: clients drive
    // it by sending the `/goal <args>` slash text via `turn/start`. These
    // tools are convenience wrappers around that pattern, scoped to sessions
    // started with engine: "codex-app". Calls against any other engine
    // surface a clear error rather than silently no-op'ing.

    api.registerTool({
      name: 'codex_goal_set',
      description:
        'Set a long-horizon objective on a codex-app session. Sends `/goal <objective>` via the app-server slash command. Requires engine: "codex-app".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name (must be a codex-app session).' },
          objective: {
            type: 'string',
            description: 'The objective text. Codex will pursue this across turns until achieved, paused, or cleared.',
          },
          timeout: { type: 'number', description: 'Timeout in ms for the resulting turn (default 120000).' },
        },
        required: ['name', 'objective'],
      },
      execute: async (_id, args) => {
        return await getManager().codexGoalCommand(
          args.name as string,
          args.objective as string,
          args.timeout as number | undefined,
        );
      },
    });

    api.registerTool({
      name: 'codex_goal_get',
      description:
        'Read the cached goal state on a codex-app session (objective, status, tokensUsed, timeUsedSeconds, tokenBudget). Returns null if no goal is active. Pure read — does not send any turn.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name (must be a codex-app session).' } },
        required: ['name'],
      },
      execute: async (_id, args) => {
        return getManager().codexGoalGet(args.name as string);
      },
    });

    api.registerTool({
      name: 'codex_goal_pause',
      description: 'Pause goal pursuit on a codex-app session. Sends `/goal pause`.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          timeout: { type: 'number', description: 'Timeout in ms (default 120000).' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        return await getManager().codexGoalCommand(args.name as string, 'pause', args.timeout as number | undefined);
      },
    });

    api.registerTool({
      name: 'codex_goal_resume',
      description: 'Resume a paused goal on a codex-app session. Sends `/goal resume`.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          timeout: { type: 'number', description: 'Timeout in ms (default 120000).' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        return await getManager().codexGoalCommand(args.name as string, 'resume', args.timeout as number | undefined);
      },
    });

    api.registerTool({
      name: 'codex_goal_clear',
      description: 'Clear the active goal on a codex-app session. Sends `/goal clear`.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          timeout: { type: 'number', description: 'Timeout in ms (default 120000).' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        return await getManager().codexGoalCommand(args.name as string, 'clear', args.timeout as number | undefined);
      },
    });

    // ─── Tool: council_start ────────────────────────────────────────────

    api.registerTool({
      name: 'council_start',
      description:
        'Start a multi-agent council that collaborates on a task using git worktree isolation, round-based execution, and consensus voting. Agents can use different engines (Claude, Codex) and models.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description for the council to work on' },
          projectDir: { type: 'string', description: 'Working directory for the council project' },
          agents: {
            type: 'array',
            description: 'Agent personas. Defaults to 3-agent team (Planner, Generator, Evaluator) if omitted.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Agent display name' },
                emoji: { type: 'string', description: 'Agent emoji identifier' },
                persona: { type: 'string', description: 'Agent personality/expertise description' },
                engine: {
                  type: 'string',
                  enum: ['claude', 'codex', 'codex-app', 'gemini', 'cursor', 'opencode', 'custom'],
                  description: 'Engine (default: claude). Use "custom" with customEngine for any CLI.',
                },
                model: { type: 'string', description: 'Model to use' },
                baseUrl: { type: 'string', description: 'Custom API endpoint (for proxy)' },
                customEngine: { type: 'object', description: 'Custom engine config (when engine="custom")' },
              },
              required: ['name', 'emoji', 'persona'],
            },
          },
          maxRounds: { type: 'number', description: 'Max collaboration rounds (default 15)' },
          agentTimeoutMs: { type: 'number', description: 'Per-agent timeout in ms (default 1800000)' },
          maxTurnsPerAgent: { type: 'number', description: 'Max tool turns per agent per round (default 30)' },
          maxBudgetUsd: { type: 'number', description: 'Max API spend per agent (USD)' },
          defaultPermissionMode: {
            type: 'string',
            enum: ['acceptEdits', 'bypassPermissions', 'default', 'delegate', 'dontAsk', 'plan', 'auto'],
            description: 'Default permission mode for council agents (default: bypassPermissions)',
          },
        },
        required: ['task', 'projectDir'],
      },
      execute: async (_id, args) => {
        const { getDefaultCouncilConfig } = await import('./council.js');
        const projectDir = sanitizeCwd(args.projectDir as string)!;
        const defaultConfig = getDefaultCouncilConfig(projectDir);

        const config: CouncilConfig = {
          name: 'council',
          agents: (args.agents as AgentPersona[] | undefined) || defaultConfig.agents,
          maxRounds: (args.maxRounds as number | undefined) ?? defaultConfig.maxRounds,
          projectDir,
          agentTimeoutMs: args.agentTimeoutMs as number | undefined,
          maxTurnsPerAgent: args.maxTurnsPerAgent as number | undefined,
          maxBudgetUsd: args.maxBudgetUsd as number | undefined,
          defaultPermissionMode: args.defaultPermissionMode as CouncilConfig['defaultPermissionMode'],
        };

        const session = getManager().councilStart(args.task as string, config);
        return { ok: true, ...session, note: 'Council running in background. Poll with council_status.' };
      },
    });

    // ─── Tool: council_status ───────────────────────────────────────────

    api.registerTool({
      name: 'council_status',
      description: 'Get the status of a running council session',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const session = getManager().councilStatus(args.id as string);
        if (!session) return { ok: false, error: 'Council not found' };
        return { ok: true, ...session };
      },
    });

    // ─── Tool: council_abort ────────────────────────────────────────────

    api.registerTool({
      name: 'council_abort',
      description: 'Abort a running council, stopping all agent sessions',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        getManager().councilAbort(args.id as string);
        return { ok: true };
      },
    });

    // ─── Tool: council_inject ───────────────────────────────────────────

    api.registerTool({
      name: 'council_inject',
      description:
        'Inject a user message into the next round of a running council. The message will be appended to all agent prompts in the next round.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Council session ID' },
          message: { type: 'string', description: 'Message to inject' },
        },
        required: ['id', 'message'],
      },
      execute: async (_id, args) => {
        getManager().councilInject(args.id as string, args.message as string);
        return { ok: true };
      },
    });

    // ─── Tool: council_review ──────────────────────────────────────────

    api.registerTool({
      name: 'council_review',
      description:
        'Review a completed council session. Returns a structured report of all changed files, branches, worktrees, plan.md status, review files, and agent summaries. Does not modify any state — purely informational. Use this before deciding to accept or reject.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = await getManager().councilReview(args.id as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tool: council_accept ──────────────────────────────────────────

    api.registerTool({
      name: 'council_accept',
      description:
        'Accept and finalize council work. Cleans up all council scaffolding: removes worktrees, deletes council/* branches, removes plan.md and reviews/ directory. Only call after reviewing with council_review.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = await getManager().councilAccept(args.id as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tool: council_reject ──────────────────────────────────────────

    api.registerTool({
      name: 'council_reject',
      description:
        'Reject council work and provide feedback. Rewrites plan.md with rejection feedback and commits it. Does NOT delete any worktrees or branches — the council can be restarted to retry. Use this when the council output is incomplete or broken.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Council session ID' },
          feedback: {
            type: 'string',
            description: 'Detailed feedback explaining why the work is rejected and what needs to be fixed',
          },
        },
        required: ['id', 'feedback'],
      },
      execute: async (_id, args) => {
        const result = await getManager().councilReject(args.id as string, args.feedback as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tool: session_send_to ────────────────────────────────────────────

    api.registerTool({
      name: 'session_send_to',
      description:
        'Send a cross-session message from one session to another. If the target is idle, the message is delivered immediately. If busy, it is queued in the inbox for later delivery. Use "*" as target to broadcast to all other sessions.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Sender session name' },
          to: { type: 'string', description: 'Target session name, or "*" for broadcast' },
          message: { type: 'string', description: 'Message text' },
          summary: { type: 'string', description: 'Short preview (5-10 words)' },
        },
        required: ['from', 'to', 'message'],
      },
      execute: async (_id, args) => {
        const result = await getManager().sessionSendTo(
          args.from as string,
          args.to as string,
          args.message as string,
          args.summary as string | undefined,
        );
        return { ok: true, ...result };
      },
    });

    // ─── Tool: session_inbox ──────────────────────────────────────────────

    api.registerTool({
      name: 'session_inbox',
      description: 'Read inbox messages for a session. Returns unread messages by default.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          unreadOnly: { type: 'boolean', description: 'Only unread messages (default true)' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const messages = getManager().sessionInbox(
          args.name as string,
          (args.unreadOnly as boolean | undefined) ?? true,
        );
        return { ok: true, count: messages.length, messages };
      },
    });

    // ─── Tool: session_deliver_inbox ──────────────────────────────────────

    api.registerTool({
      name: 'session_deliver_inbox',
      description:
        'Deliver all queued inbox messages to an idle session. Call this when a session finishes a task to process waiting messages.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name' } },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const count = await getManager().sessionDeliverInbox(args.name as string);
        return { ok: true, delivered: count };
      },
    });

    // ─── Tool: ultraplan_start ──────────────────────────────────────

    api.registerTool({
      name: 'ultraplan_start',
      description:
        'Start an Ultraplan session: a dedicated Opus planning session that explores your project for up to 30 minutes and produces a detailed implementation plan. Runs in background.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to plan — describe the feature, refactor, or problem' },
          cwd: { type: 'string', description: 'Project directory to explore' },
          model: { type: 'string', description: 'Model to use (default: opus)' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 1800000 = 30 min)' },
        },
        required: ['task'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultraplanStart(args.task as string, {
          cwd: sanitizeCwd(args.cwd as string | undefined),
          model: args.model as string | undefined,
          timeout: args.timeout as number | undefined,
        });
        return { ok: true, ...result, note: 'Ultraplan running in background. Poll with ultraplan_status.' };
      },
    });

    // ─── Tool: ultraplan_status ─────────────────────────────────────

    api.registerTool({
      name: 'ultraplan_status',
      description: 'Get the status of an Ultraplan session. Returns the plan text when completed.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ultraplan ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultraplanStatus(args.id as string);
        if (!result) return { ok: false, error: 'Ultraplan not found' };
        return { ok: true, ...result };
      },
    });

    // ─── Tool: ultrareview_start ────────────────────────────────────

    api.registerTool({
      name: 'ultrareview_start',
      description:
        'Start an Ultrareview: a fleet of bug-hunting agents (5-20) that review your codebase from different angles in parallel. Each agent specializes in a different area (security, performance, logic, types, etc.). Runs in background.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project directory to review' },
          agentCount: { type: 'number', description: 'Number of reviewer agents (1-20, default 5)' },
          maxDurationMinutes: { type: 'number', description: 'Max review duration in minutes (5-25, default 10)' },
          model: { type: 'string', description: 'Model for reviewers (default: session default)' },
          focus: { type: 'string', description: 'Review focus area (default: bugs + security + quality)' },
        },
        required: ['cwd'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultrareviewStart(sanitizeCwd(args.cwd as string)!, {
          agentCount: args.agentCount as number | undefined,
          maxDurationMinutes: args.maxDurationMinutes as number | undefined,
          model: args.model as string | undefined,
          focus: args.focus as string | undefined,
        });
        return { ok: true, ...result, note: 'Ultrareview running in background. Poll with ultrareview_status.' };
      },
    });

    // ─── Tool: ultrareview_status ───────────────────────────────────

    api.registerTool({
      name: 'ultrareview_status',
      description: 'Get the status of an Ultrareview. Returns all findings when completed.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ultrareview ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultrareviewStatus(args.id as string);
        if (!result) return { ok: false, error: 'Ultrareview not found' };
        return { ok: true, ...result };
      },
    });

    // ─── Tool: autoloop_start ────────────────────────────────────
    //
    // v2 architecture: three persistent agents (Planner / Coder / Reviewer).
    // Starting a run only launches the Planner — Coder and Reviewer are
    // spawned later by the Planner once the user approves the plan (S3).

    api.registerTool({
      name: 'autoloop_start',
      description:
        'Start a v2 autoloop run in chat mode. The user converses with the persistent Planner (Claude Opus by default) to design plan.md and goal.json; subagents (Coder/Reviewer) are spawned later via the Planner when the plan is ready. Returns a run_id and the Planner session name. See tasks/autoloop.md for the architecture.',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'Stable run identifier (used to address subsequent chat / status calls)',
          },
          workspace: { type: 'string', description: 'Path to the git workspace where the run lives' },
          planner_model: { type: 'string', description: 'Model alias for Planner (default: opus)' },
          send_timeout_ms: { type: 'number', description: 'Per-message wall-clock cap (default 600000 = 10 min)' },
        },
        required: ['run_id', 'workspace'],
      },
      execute: async (_id, args) => {
        const result = await getManager().autoloopStart({
          runId: args.run_id as string,
          workspace: sanitizeCwd(args.workspace as string)!,
          plannerModel: args.planner_model as string | undefined,
          sendTimeoutMs: args.send_timeout_ms as number | undefined,
        });
        return {
          ok: true,
          ...result,
          note: 'Planner ready. Use autoloop_chat to converse. Coder/Reviewer not yet spawned.',
        };
      },
    });

    // ─── Tool: autoloop_chat ─────────────────────────────────────

    api.registerTool({
      name: 'autoloop_chat',
      description:
        "Send a chat message to the Planner of a v2 autoloop run. Returns the Planner's natural-language reply. Blocking: resolves after the Planner finishes its turn.",
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run id from autoloop_start' },
          text: { type: 'string', description: 'User chat input' },
        },
        required: ['run_id', 'text'],
      },
      execute: async (_id, args) => {
        const { reply } = await getManager().autoloopChat(args.run_id as string, args.text as string);
        return { ok: true, reply };
      },
    });

    // ─── Tool: autoloop_status ───────────────────────────────────

    api.registerTool({
      name: 'autoloop_status',
      description: 'Get current state of a v2 autoloop run (status, iter, push count, subagents_spawned).',
      parameters: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
        required: ['run_id'],
      },
      execute: async (_id, args) => {
        const state = getManager().autoloopStatus(args.run_id as string);
        if (!state) return { ok: false, error: 'Run not found' };
        return { ok: true, state };
      },
    });

    // ─── Tool: autoloop_list ─────────────────────────────────────

    api.registerTool({
      name: 'autoloop_list',
      description: 'List all v2 autoloop runs in this manager process.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        if (!manager) return { ok: true, runs: [] };
        return { ok: true, runs: getManager().autoloopList() };
      },
    });

    // ─── Tool: autoloop_reset_agent ──────────────────────────────

    api.registerTool({
      name: 'autoloop_reset_agent',
      description:
        'Reset a single subagent (Coder or Reviewer) on a v2 run. Stops its persistent session; the next directive/review_request will re-prime from the system prompt + ledger artifacts. Use when an agent has drifted (repeated rejects, hallucinated context, token bloat). Planner reset requires force=true because it discards chat history with the user.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          agent: { type: 'string', enum: ['planner', 'coder', 'reviewer'] },
          force: { type: 'boolean', description: 'Required to reset Planner (discards user chat context)' },
          eager_restart: {
            type: 'boolean',
            description: 'Start a fresh session immediately (default: lazy on next message)',
          },
        },
        required: ['run_id', 'agent'],
      },
      execute: async (_id, args) => {
        const ok = await getManager().autoloopResetAgent(
          args.run_id as string,
          args.agent as 'planner' | 'coder' | 'reviewer',
          {
            force: args.force as boolean | undefined,
            eagerRestart: args.eager_restart as boolean | undefined,
          },
        );
        if (!ok) return { ok: false, error: 'Run not found' };
        return { ok: true };
      },
    });

    // ─── Tool: autoloop_stop ─────────────────────────────────────

    api.registerTool({
      name: 'autoloop_stop',
      description: 'Terminate a v2 autoloop run. Stops Planner (and Coder/Reviewer once spawned).',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          reason: { type: 'string', description: 'Optional reason recorded in run state' },
        },
        required: ['run_id'],
      },
      execute: async (_id, args) => {
        const ok = await getManager().autoloopStop(args.run_id as string, args.reason as string | undefined);
        if (!ok) return { ok: false, error: 'Run not found' };
        return { ok: true };
      },
    });
  },
};

export default plugin;
