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
import {
  ENGINE_TYPES,
  EFFORT_LEVELS,
  type PluginConfig,
  type EffortLevel,
  type CouncilConfig,
  type AgentPersona,
  type EngineType,
  type CustomEngineConfig,
} from './types.js';
import type { FanoutConfig } from './fanout.js';
import {
  councilWorkflow,
  fanoutWorkflow,
  goalWorkflow,
  solveWorkflow,
  type GoalArgs,
  type SolveArgs,
} from './kernel/templates/index.js';
import { readEvents as readKernelEvents } from './kernel/store.js';
import { resolveSecretRefs } from './kernel/secrets.js';
import type { RunState, WorkflowSpec } from './kernel/types.js';
import { AUTOLOOP_TIMEOUT_SCHEMA, validateAutoloopTimeoutConfig } from './autoloop/types.js';

// ─── Standalone Export ───────────────────────────────────────────────────────

export { SessionManager } from './session-manager.js';
export { PersistentClaudeSession } from './persistent-session.js';
export { BaseOneShotSession, type OneShotEngineConfig } from './base-oneshot-session.js';
export { PersistentCodexSession } from './persistent-codex-session.js';
export { PersistentCodexAppServerSession } from './persistent-codex-app-session.js';
export { PersistentGeminiSession } from './persistent-gemini-session.js';
export { PersistentAgySession } from './persistent-agy-session.js';
export { PersistentCursorSession } from './persistent-cursor-session.js';
export { PersistentGrokSession } from './persistent-grok-session.js';
export { PersistentOpencodeSession } from './persistent-opencode-session.js';
export { PersistentCustomSession } from './persistent-custom-session.js';
export { PersistentAcpSession } from './persistent-acp-session.js';
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
type ToolExecute = (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;

interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: ToolExecute;
}

interface AgentToolResult {
  content: unknown[];
  details: unknown;
}

interface PluginAPI {
  pluginConfig: Record<string, unknown>;
  logger: { info(...args: unknown[]): void; error(...args: unknown[]): void; warn(...args: unknown[]): void };
  registerTool(def: ToolDefinition): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<void>): void;
  registerHttpRoute(def: {
    path: string;
    auth?: string;
    match?: string;
    handler: (...args: unknown[]) => Promise<boolean>;
  }): void;
  registerService(def: { id: string; start: () => void; stop: () => void }): void;
}

function isAgentToolResult(result: unknown): result is AgentToolResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'content' in result &&
    Array.isArray(result.content) &&
    'details' in result
  );
}

function normalizeToolResult(result: unknown): AgentToolResult {
  if (isAgentToolResult(result)) return result;

  const text = JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
  return {
    content: [{ type: 'text', text: text ?? 'null' }],
    details: result,
  };
}

const ACP_AGENT_SCHEMA = {
  description:
    'The ACP agent (required when engine is "acp"): the id of a bundled preset (`clawo engines`), or, from a local caller only, an inline config.',
  oneOf: [
    { type: 'string', description: 'Preset id, e.g. "kimi-code"' },
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        command: { type: 'string', description: 'Command that serves ACP on stdio' },
        commandEnv: { type: 'string', description: 'Env var that overrides command' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments, e.g. ["acp"]' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['name', 'command'],
    },
  ],
};

/**
 * `acpAgent` on the surfaces that write their agents into a stored run spec
 * (fan-out, council, workflow templates): a preset id only. An inline config can
 * carry an environment, and the spec is written to disk.
 */
const AUTOLOOP_ENGINES = ENGINE_TYPES.filter((e) => e !== 'acp');

const ACP_AGENT_ID_SCHEMA = {
  type: 'string',
  description: 'With engine "acp": the id of a bundled ACP agent preset (`clawo engines`), such as kimi-code or dsh.',
};

const CUSTOM_ENGINE_SCHEMA = {
  type: 'object',
  description: 'Custom engine config (required when the corresponding engine is "custom").',
  properties: {
    name: { type: 'string', description: 'Engine display name' },
    bin: { type: 'string', description: 'Binary path or command' },
    binEnv: { type: 'string', description: 'Env var that overrides bin' },
    persistent: { type: 'boolean', description: 'true=long-running subprocess, false=spawn per send (default)' },
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
    sanitizePatterns: { type: 'array', maxItems: 100, items: { type: 'string' } },
  },
  required: ['name', 'bin', 'args'],
} as const;

/**
 * `customEngine` on the surfaces that also take a preset id: session_start,
 * session_handoff and council agents all reach `_createSession`, which expands a
 * string through resolveCustomEngine. Autoloop roles validate an inline config
 * and take CUSTOM_ENGINE_SCHEMA itself.
 */
const CUSTOM_ENGINE_OR_PRESET_SCHEMA = {
  description:
    'Custom engine (required when engine is "custom"): the id of a bundled preset (`clawo engines`), or, from a local caller only, an inline config.',
  oneOf: [{ type: 'string', description: 'Preset id, e.g. "zcode"' }, CUSTOM_ENGINE_SCHEMA],
};

/**
 * OpenClaw plugin object — standard format
 */
const plugin = {
  id: 'claw-orchestrator',
  name: 'Claw Orchestrator',
  description:
    'Run Claude Code, Codex, Antigravity, Grok Build, OpenCode, any ACP agent and custom coding CLIs as one unified runtime — persistent sessions, multi-agent council, worktree isolation, multi-model proxy',

  register(api: PluginAPI): void {
    const rawConfig = (api.pluginConfig || {}) as Partial<PluginConfig>;

    const registerTool = (definition: ToolDefinition): void => {
      api.registerTool({
        ...definition,
        execute: async (toolCallId, params) => normalizeToolResult(await definition.execute(toolCallId, params)),
      });
    };

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
        api.logger.info('[claw-orchestrator] First use — initialising SessionManager');
        // Pass the host's logger through. Without it SessionManager falls back to
        // createConsoleLogger, whose info/debug write to STDOUT — which silently
        // corrupts the frame stream of any stdio-protocol host (`clawo-mcp` is
        // exactly that, and did carry this bug). PluginAPI's logger has no
        // `debug`, so it folds into `info`, which lands on whatever channel the
        // host chose.
        manager = new SessionManager(rawConfig, {
          debug: (msg: string, ...args: unknown[]) => api.logger.info(msg, ...args),
          info: (msg: string, ...args: unknown[]) => api.logger.info(msg, ...args),
          warn: (msg: string, ...args: unknown[]) => api.logger.warn(msg, ...args),
          error: (msg: string, ...args: unknown[]) => api.logger.error(msg, ...args),
        });
        // When running as a pure MCP server (or any standalone use that
        // doesn't need the HTTP control plane), CLAWO_NO_EMBEDDED_SERVER=1
        // avoids binding port 18796 and pulling in the embedded server's
        // dependencies. The OpenClaw plugin path leaves it enabled so the
        // `clawo` CLI can keep talking to it.
        if (process.env.CLAWO_NO_EMBEDDED_SERVER !== '1') {
          api.logger.info('[claw-orchestrator] Starting embedded HTTP server');
          server = new EmbeddedServer(manager);
          server.start().catch((err) => api.logger.error('[claw-orchestrator] Embedded server failed to start:', err));
        }
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

    registerTool({
      name: 'session_start',
      description:
        'Start a persistent coding session. Engines: claude (default) for the Claude Code CLI, codex for the OpenAI Codex CLI, agy for the Google Antigravity CLI, grok for the xAI Grok Build CLI, opencode for the sst/opencode CLI, acp for any Agent Client Protocol agent (Kimi Code, dsh, OpenCode, Claude Code via an ACP adapter), or custom for any user-configured coding agent CLI.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name (auto-generated if omitted)' },
          cwd: { type: 'string', description: 'Working directory' },
          engine: {
            type: 'string',
            enum: ENGINE_TYPES,
            description:
              'Engine to use (default: claude). codex = `codex exec` per send (no /goal). codex-app = long-running `codex app-server` with /goal support. agy = Google Antigravity CLI (stream-json output with reported token usage; the conversation is resumed by its id on each send). grok = xAI Grok Build CLI (reports its own per-turn cost). opencode = sst/opencode CLI (provider-agnostic; pass model as `provider/model`). acp = any Agent Client Protocol agent, chosen with acpAgent. Use "custom" with customEngine config for any CLI. gemini and cursor are legacy, kept for existing callers: use agy and grok instead.',
          },
          model: { type: 'string', description: 'Model to use (opus, sonnet, haiku, gpt-5.5, agy-pro, etc.)' },
          permissionMode: {
            type: 'string',
            enum: ['acceptEdits', 'bypassPermissions', 'default', 'manual', 'dontAsk', 'plan', 'auto'],
          },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto'] },
          allowedTools: {
            type: 'array',
            maxItems: 200,
            items: { type: 'string' },
            description: 'Tools to auto-approve',
          },
          disallowedTools: { type: 'array', maxItems: 200, items: { type: 'string' }, description: 'Tools to deny' },
          tools: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description:
              'Claude engine only. The built-in tool set (`--tools`): names such as ["Bash", "Edit", "Read"], "" for none, or "default".',
          },
          addDir: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Directories the session may use besides cwd (`--add-dir`). Claude and Codex; a resumed Codex thread keeps the directories its first turn opened.',
          },
          maxTurns: { type: 'number', description: 'Max agent loop turns' },
          maxBudgetUsd: { type: 'number', description: 'Max API spend (USD)' },
          autoCompactPercent: {
            type: 'number',
            minimum: 1,
            maximum: 99,
            description:
              'Compact the conversation before a send once context use reaches this percentage. Off by default; for long-lived sessions, where cost grows with context size',
          },
          systemPrompt: { type: 'string', description: 'Replace system prompt' },
          appendSystemPrompt: {
            type: 'string',
            description:
              'Append to the system prompt. Claude Code and Grok take it natively; Codex, Antigravity and OpenCode have no such flag and receive it at the top of the first message of a conversation',
          },
          agents: { type: 'object', description: 'Custom sub-agents JSON' },
          agent: { type: 'string', description: 'Default agent to use' },
          bare: { type: 'boolean', description: 'Minimal mode: skip hooks, LSP, auto-memory, CLAUDE.md' },
          worktree: { type: ['string', 'boolean'], description: 'Run in git worktree' },
          fallbackModel: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'Auto fallback when primary overloaded. String or array (tried in order).',
          },
          jsonSchema: { type: 'string', description: 'JSON Schema for structured output' },
          mcpConfig: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'MCP server config file(s)',
          },
          settings: { type: 'string', description: 'Settings.json path or inline JSON' },
          pluginUrl: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: 'Claude engine only. Plugin .zip URL(s) fetched for this session only (`--plugin-url`).',
          },
          ultracode: {
            type: 'boolean',
            description:
              'Claude engine only. Enable "ultracode" / dynamic workflows: Claude plans a JS orchestration script per substantive task and fans out to subagents. Injected as the ultracode:true settings key (not a --effort value). A workflow runs in the background: session_send returns the launch reply, and the completion arrives later in a turn that no send returns.',
          },
          sandboxMode: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description:
              'Sandbox policy. Codex supports all values (default workspace-write). read-only is enforced on claude, agy, grok and opencode through their own plan/read-only modes; a custom engine must map it via permissionModes or the session refuses to start. The acp engine refuses read-only, because the agent runs its own tools; its permission answers follow permissionMode.',
          },
          launcher: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Argv prefix every engine process of this session runs under, e.g. a sandbox wrapper: ["/opt/sandbox.sh", "task"]. Any engine. It runs with your authority, like a contract command check.',
          },
          codexProfile: {
            type: 'string',
            description:
              'Codex engine only. Named config profile from ~/.codex/config.toml, passed as `codex exec --profile`. Reasoning effort is mapped from the engine-agnostic `effort` param to `-c model_reasoning_effort` automatically.',
          },
          ignoreUserConfig: {
            type: 'boolean',
            description:
              "Codex engine only. Run without loading $CODEX_HOME/config.toml (`codex exec --ignore-user-config`), so the session is decided by what the caller passed rather than by the machine's own Codex config. Auth still resolves from CODEX_HOME.",
          },
          restricted: {
            type: 'boolean',
            description:
              'Claude engine only. Restricted mode (`--restricted`): removes the tools that run commands or code (Bash, PowerShell, the REPL) and WebFetch unless `tools` names them, and ignores user, project and local settings files, including CLAUDE.md and hooks. Separate from sandboxMode read-only, which maps to plan mode.',
          },
          noSessionPersistence: { type: 'boolean', description: 'Do not save session to disk' },
          betas: { type: ['string', 'array'], items: { type: 'string' }, description: 'Custom beta headers' },
          enableAgentTeams: { type: 'boolean', description: 'Enable experimental agent teams' },
          enableAutoMode: { type: 'boolean', description: 'Enable auto permission mode' },
          crossSessionInbound: {
            type: 'string',
            enum: ['accept', 'hold', 'refuse'],
            description:
              'Policy for peer messages from other Claude Code sessions (Claude engine). ' +
              'Without it the CLI holds messages whose sender and receiver run different permission modes, ' +
              'which is the usual case between an orchestrated session and a human terminal.',
          },
          includeHookEvents: {
            type: 'boolean',
            description: 'Stream hook lifecycle events (PreToolUse/PostToolUse)',
          },
          forwardSubagentText: {
            type: 'boolean',
            description: 'Forward subagent text and thinking into the output stream (Claude engine)',
          },
          chrome: {
            type: 'boolean',
            description:
              "Let the session use the user's Chrome through the Claude in Chrome extension, with its sign-ins (Claude engine; off by default)",
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
          customEngine: CUSTOM_ENGINE_OR_PRESET_SCHEMA,
          acpAgent: ACP_AGENT_SCHEMA,
          resumeSessionId: {
            type: 'string',
            description:
              "Resume an earlier conversation by the engine's own id instead of starting fresh: a Claude Code session id (`--resume`), a Codex or codex-app thread id, an Antigravity conversation id, a Grok or OpenCode session id, an ACP agent's session id, or a custom engine's id when its config maps a resume flag.",
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

    registerTool({
      name: 'session_send',
      description: 'Send a message to a persistent coding session and get the response',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          message: { type: 'string', description: 'Message to send' },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            description:
              'Effort for this message. agy, grok and opencode pass it to the engine for this turn; on claude, high and above prefix the message with `ultrathink` (a persistent custom engine does the same for high and max). Other engines ignore it.',
          },
          plan: {
            type: 'boolean',
            description:
              'Ask for a plan only: claude and persistent custom engines prefix the message with a plan-only instruction. The permission mode is unchanged (start with sandboxMode read-only to enforce it); other engines ignore this flag.',
          },
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

    // ─── Tool: session_handoff ────────────────────────────────────────────

    registerTool({
      name: 'session_handoff',
      description:
        "Continue a session's conversation on another engine (or another model). Starts a new session on the target engine in the same working directory and carries the conversation into it as text, so the new agent picks up where the old one left off. The source session keeps running untouched — stop it yourself if you are done with it. Pass `message` to send the next instruction immediately; otherwise the history travels with whatever you send next via session_send.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The session to hand off from' },
          engine: {
            type: 'string',
            enum: ENGINE_TYPES,
            description: 'Engine for the new session. May be the same engine with a different model.',
          },
          model: { type: 'string', description: 'Model for the new session (default: the engine default)' },
          newName: { type: 'string', description: 'Name for the new session (default: `<name>-<engine>`)' },
          message: {
            type: 'string',
            description: 'Send this as the first message now and return the reply (default: wait for session_send)',
          },
          maxChars: {
            type: 'number',
            description:
              'Upper bound on the carried history, in characters (default 240000, minimum 4000). When the conversation is longer, the opening request and the newest turns are kept and the turns between them are left out.',
          },
          customEngine: CUSTOM_ENGINE_OR_PRESET_SCHEMA,
          acpAgent: ACP_AGENT_SCHEMA,
        },
        required: ['name', 'engine'],
      },
      execute: async (_id, args) => {
        const result = await getManager().handoffSession(args.name as string, {
          engine: args.engine as EngineType,
          model: args.model as string | undefined,
          newName: args.newName as string | undefined,
          message: args.message as string | undefined,
          maxChars: args.maxChars as number | undefined,
          customEngine: args.customEngine as Parameters<SessionManager['handoffSession']>[1]['customEngine'],
          acpAgent: args.acpAgent as Parameters<SessionManager['handoffSession']>[1]['acpAgent'],
        });
        return { ok: true, ...result };
      },
    });

    // ─── Tool: session_stop ───────────────────────────────────────────────

    registerTool({
      name: 'session_stop',
      description:
        'Stop a persistent coding session and remove it from the resume registry, so a later session_start under the same name begins a new conversation',
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

    registerTool({
      name: 'session_list',
      description:
        'List the active coding sessions, and the persisted ones that a session_start under the same name resumes',
      parameters: { type: 'object', properties: {} },
      execute: async (_id) => {
        const m = getManager();
        return { ok: true, sessions: m.listSessions(), persisted: m.listPersistedSessions() };
      },
    });

    // ─── Tool: sessions_overview ──────────────────────────────────────────

    registerTool({
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

    registerTool({
      name: 'coding_session_status',
      description:
        'Get detailed status of a coding session: context %, tokens, cost and spend cap, turns, tool calls, retries, start time and last activity',
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

    registerTool({
      name: 'session_grep',
      description:
        "Search the session's in-memory event history (its 100 most recent events) for a regex pattern, case-insensitive",
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

    registerTool({
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

    registerTool({
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

    registerTool({
      name: 'team_list',
      description:
        "List the other active sessions as this session's teammates, with engine, idle/busy/paused state and turn count. Works on every engine; enableAgentTeams is not required.",
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

    registerTool({
      name: 'team_send',
      description:
        'Send a message to another active session through the cross-session inbox: delivered now if it is idle, queued if it is busy.',
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

    registerTool({
      name: 'session_update_tools',
      description:
        'Update allowedTools or disallowedTools for a running session. Restarts the session process with --resume to apply the new tool constraints while preserving conversation history. Rejects if the session is currently busy. Without merge:true both lists are replaced, so a list you omit is cleared.',
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

    registerTool({
      name: 'session_switch_model',
      description:
        'Switch the model for a running session immediately. Restarts the session process with --resume so the new model takes effect on the next message while preserving conversation history.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          model: { type: 'string', description: 'New model (opus, sonnet, haiku, gpt-5.5, agy-pro, etc.)' },
        },
        required: ['name', 'model'],
      },
      execute: async (_id, args) => {
        const info = await getManager().switchModel(args.name as string, args.model as string);
        return { ok: true, restarted: true, ...info };
      },
    });

    // ─── Tool: project_purge (CLI 2.1.126) ────────────────────────────────

    registerTool({
      name: 'project_purge',
      description:
        'Delete Claude Code project state (transcripts, tasks, file history, config entry) via `claude project purge`. Defaults to dry-run for safety — pass dry_run=false to actually delete. Use all=true to purge every project.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "Project path to purge (resolved to absolute). Ignored when all=true. Defaults to the orchestrator process's working directory.",
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

    // ─── Tool: plugin_details (CLI 2.1.139) ─────────────────────────────

    registerTool({
      name: 'plugin_details',
      description:
        "Show a plugin's component inventory (commands, hooks, MCP servers, agents, skills) plus the per-session token cost of loading it. Wraps `claude plugin details <name>` (CLI 2.1.139+).",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Plugin name (e.g. "superpowers" or "superpowers@claude-plugins-official").',
          },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const result = await getManager().pluginDetails(args.name as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tools: claude_goal_* (CLI 2.1.139 /goal slash commands) ────────
    //
    // Wraps Claude Code's /goal command, which keeps Claude working across
    // turns until a stated completion condition is met. The CLI runs a
    // small evaluator (Haiku) after each turn to check the condition.
    // These tools just pre-format the slash text and send it via the
    // normal session channel — there is no separate goal-state event to
    // intercept (unlike Codex). Engine must be "claude".

    registerTool({
      name: 'claude_goal_set',
      description:
        'Set a goal condition on a claude session. Claude Code keeps working across turns until the condition is met, evaluating after each turn via Haiku. Sends `/goal <objective>`. Requires engine: "claude".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name (must be a claude session).' },
          objective: {
            type: 'string',
            description: 'The completion condition. Claude pursues this until satisfied, cleared, or session ends.',
          },
          timeout: { type: 'number', description: 'Timeout in ms for the resulting turn (default 300000).' },
        },
        required: ['name', 'objective'],
      },
      execute: async (_id, args) => {
        return await getManager().claudeGoalSet(
          args.name as string,
          args.objective as string,
          args.timeout as number | undefined,
        );
      },
    });

    registerTool({
      name: 'claude_goal_clear',
      description: 'Clear the active goal on a claude session. Sends `/goal clear`. Requires engine: "claude".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          timeout: { type: 'number', description: 'Timeout in ms (default 300000).' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        return await getManager().claudeGoalClear(args.name as string, args.timeout as number | undefined);
      },
    });

    registerTool({
      name: 'claude_goal_status',
      description:
        'Query the active goal on a claude session (objective, elapsed, turns, tokens). Sends bare `/goal` and returns the assistant reply. Requires engine: "claude".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          timeout: { type: 'number', description: 'Timeout in ms (default 300000).' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        return await getManager().claudeGoalStatus(args.name as string, args.timeout as number | undefined);
      },
    });

    // ─── Tool: codex_resume (Codex 0.119+) ──────────────────────────────

    registerTool({
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

    registerTool({
      name: 'codex_review',
      description:
        'Run a non-interactive Codex code review (`codex review`). Pick at most one diff scope — uncommitted (working-tree changes), base (vs branch), or commit (vs SHA); passing two is an error. Output is plain text — Codex `review` does not emit JSON.',
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

    // ─── Tools: codex_goal_* (codex-app thread/goal/* RPCs) ─────────────
    //
    // Thin wrappers over the app-server's typed goal RPCs, scoped to sessions
    // started with engine: "codex-app". Calls against any other engine surface
    // a clear error rather than silently no-op'ing.

    const GOAL_SHAPE =
      'Returns { ok, goal } where goal is { objective, status: "active"|"paused"|"blocked"|"usageLimited"|"budgetLimited"|"complete", tokenBudget, tokensUsed, timeUsedSeconds, ... } or null.';

    registerTool({
      name: 'codex_goal_set',
      description: `Set a long-horizon objective on a codex-app session (thread/goal/set). Codex then works turn after turn on its own until the goal leaves "active". Requires engine: "codex-app". ${GOAL_SHAPE}`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name (must be a codex-app session).' },
          objective: {
            type: 'string',
            description: 'The objective text. Codex will pursue this across turns until achieved, paused, or cleared.',
          },
          tokenBudget: {
            type: 'number',
            description: 'Optional token budget; the goal stops as "budgetLimited" once it is spent.',
          },
        },
        required: ['name', 'objective'],
      },
      execute: async (_id, args) => {
        return await getManager().codexGoal(args.name as string, {
          action: 'set',
          objective: args.objective as string,
          tokenBudget: args.tokenBudget as number | undefined,
        });
      },
    });

    for (const [action, description] of [
      ['get', 'Read the goal of a codex-app session from the app-server (thread/goal/get). Sends no turn.'],
      ['pause', 'Pause goal pursuit on a codex-app session (thread/goal/set status "paused").'],
      ['resume', 'Resume a paused or stopped goal on a codex-app session (thread/goal/set status "active").'],
      ['clear', 'Remove the goal from a codex-app session (thread/goal/clear).'],
    ] as const) {
      registerTool({
        name: `codex_goal_${action}`,
        description: `${description} ${GOAL_SHAPE}`,
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Session name (must be a codex-app session).' } },
          required: ['name'],
        },
        execute: async (_id, args) => {
          return await getManager().codexGoal(args.name as string, { action });
        },
      });
    }

    // ─── Codex app-server v2 RPC tools (codex-app engine, Codex 0.137) ────

    registerTool({
      name: 'codex_interrupt',
      description: 'Cancel the in-flight turn on a codex-app session (`turn/interrupt`).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name.' } },
        required: ['name'],
      },
      execute: async (_id, args) => getManager().codexInterrupt(args.name as string),
    });

    registerTool({
      name: 'codex_steer',
      description:
        'Add input to the in-flight turn on a codex-app session without restarting it (`turn/steer`). Falls back to a normal turn when idle.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          message: { type: 'string', description: 'Text to steer the turn with.' },
        },
        required: ['name', 'message'],
      },
      execute: async (_id, args) => getManager().codexSteer(args.name as string, args.message as string),
    });

    registerTool({
      name: 'codex_fork',
      description: 'Branch a codex-app thread into a new one (`thread/fork`); returns the forked thread id.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name.' } },
        required: ['name'],
      },
      execute: async (_id, args) => getManager().codexForkThread(args.name as string),
    });

    registerTool({
      name: 'codex_rollback',
      description: 'Drop the last N turns from a codex-app thread (`thread/rollback`).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          numTurns: { type: 'number', minimum: 1, description: 'Number of turns to roll back (>=1).' },
        },
        required: ['name', 'numTurns'],
      },
      execute: async (_id, args) => getManager().codexRollback(args.name as string, args.numTurns as number),
    });

    registerTool({
      name: 'codex_models',
      description: 'List models available to a codex-app session (`model/list`), incl. supported reasoning efforts.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name.' } },
        required: ['name'],
      },
      execute: async (_id, args) => getManager().codexModels(args.name as string),
    });

    registerTool({
      name: 'codex_thread_list',
      description: 'List Codex threads visible to a codex-app session (`thread/list`), with optional filters.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name.' },
          searchTerm: { type: 'string', description: 'Filter threads by text.' },
          cwd: { type: 'string', description: 'Filter to threads under this directory.' },
          archived: { type: 'boolean', description: 'Include archived threads.' },
          cursor: { type: 'string', description: 'Pagination cursor (from a prior nextCursor).' },
          limit: { type: 'number', description: 'Max threads to return.' },
        },
        required: ['name'],
      },
      execute: async (_id, args) =>
        getManager().codexThreads(args.name as string, {
          searchTerm: args.searchTerm as string | undefined,
          cwd: args.cwd ? sanitizeCwd(args.cwd as string) : undefined,
          archived: args.archived as boolean | undefined,
          cursor: args.cursor as string | undefined,
          limit: args.limit as number | undefined,
        }),
    });

    // ─── Tool: claude_agents_list (Claude CLI 2.1.x, claude engine) ───────

    registerTool({
      name: 'claude_agents_list',
      description:
        'List Claude Code background agent sessions via `claude agents --json` (state/model/title/progress). One-shot, not tied to a managed session.',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'Include completed sessions (`--all`).' },
          cwd: { type: 'string', description: 'Scope to sessions started under this directory (`--cwd`).' },
        },
      },
      execute: async (_id, args) =>
        getManager().claudeAgentsList({ all: args.all as boolean | undefined, cwd: args.cwd as string | undefined }),
    });

    // ─── Fan-out tools (parallel multi-engine task, no consensus) ─────────

    registerTool({
      name: 'fanout_start',
      description:
        'Run one task across N engine/model agents IN PARALLEL and collect their answers (optional synthesis). Cross-engine best-of-N / diverse-perspective primitive. No rounds, votes, or worktrees — use council for isolated parallel edits. Runs in background; poll with fanout_status.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The shared task sent to every agent, after persona role instructions when supplied; a non-empty per-agent prompt replaces it.',
          },
          projectDir: { type: 'string', description: 'Working directory all agents run in.' },
          agents: {
            type: 'array',
            maxItems: 16,
            description:
              "Agent specs: { name, engine?, model?, effort?, prompt?, persona?, baseUrl?, permissionMode?, sandboxMode?, customEngine?, acpAgent? }. permissionMode uses each engine's own permission handling as in session_start; workers that must not write should set sandboxMode to read-only. sandboxMode uses the same values and per-engine behavior as session_start.",
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1, description: 'Unique label (forms the session name).' },
                engine: {
                  type: 'string',
                  enum: ENGINE_TYPES,
                },
                model: { type: 'string' },
                effort: { type: 'string', enum: EFFORT_LEVELS },
                prompt: {
                  type: 'string',
                  description: 'Complete per-agent prompt that replaces the shared task when non-empty.',
                },
                persona: {
                  type: 'string',
                  description:
                    'Per-agent role instructions prepended to the shared task when no non-empty prompt is supplied.',
                },
                baseUrl: { type: 'string' },
                permissionMode: {
                  type: 'string',
                  enum: ['acceptEdits', 'bypassPermissions', 'default', 'manual', 'dontAsk', 'plan', 'auto'],
                  description:
                    "Per-agent permission mode (same values as session_start). Passed through to that engine's own permission handling; see session_start for per-engine mapping.",
                },
                sandboxMode: {
                  type: 'string',
                  enum: ['read-only', 'workspace-write', 'danger-full-access'],
                  description:
                    'Same values and per-engine behavior as session_start. Use read-only for workers that must not write.',
                },
                acpAgent: ACP_AGENT_ID_SCHEMA,
              },
              required: ['name'],
            },
          },
          synthesize: {
            type: 'boolean',
            description: 'Run a final synthesis pass over the successful results (>=2 needed).',
          },
          synthesisModel: { type: 'string', description: 'Model for the synthesis pass.' },
          synthesisEngine: {
            type: 'string',
            enum: ENGINE_TYPES,
            description: 'Engine for the synthesis pass (default claude).',
          },
          synthesisAcpAgent: {
            ...ACP_AGENT_ID_SCHEMA,
            description: 'With synthesisEngine "acp": the ACP agent preset the synthesis pass starts.',
          },
          agentTimeoutMs: { type: 'number', description: 'Per-agent timeout in ms (default 600000).' },
          maxTurnsPerAgent: { type: 'number', description: 'Max agent loop turns (default 30).' },
          maxBudgetUsd: { type: 'number', description: 'Per-agent spend cap (USD).' },
        },
        required: ['task', 'projectDir', 'agents'],
      },
      execute: async (_id, args) => {
        const session = await getManager().fanoutStart({
          task: args.task as string,
          projectDir: sanitizeCwd(args.projectDir as string)!,
          agents: args.agents as FanoutConfig['agents'],
          synthesize: args.synthesize as boolean | undefined,
          synthesisModel: args.synthesisModel as string | undefined,
          synthesisEngine: args.synthesisEngine as FanoutConfig['synthesisEngine'],
          synthesisAcpAgent: args.synthesisAcpAgent as string | undefined,
          agentTimeoutMs: args.agentTimeoutMs as number | undefined,
          maxTurnsPerAgent: args.maxTurnsPerAgent as number | undefined,
          maxBudgetUsd: args.maxBudgetUsd as number | undefined,
        });
        return { ok: true, ...session, note: 'Fan-out running in background. Poll with fanout_status.' };
      },
    });

    registerTool({
      name: 'fanout_status',
      description: 'Poll a running or finished fan-out by id; returns per-agent results and any synthesis.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Fan-out id from fanout_start.' } },
        required: ['id'],
      },
      execute: async (_id, args) => ({ ok: true, ...getManager().fanoutStatus(args.id as string) }),
    });

    registerTool({
      name: 'fanout_abort',
      description: 'Abort a running fan-out by id (already-started agents finish; synthesis is skipped).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Fan-out id from fanout_start.' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        getManager().fanoutAbort(args.id as string);
        return { ok: true };
      },
    });

    // ─── Tools: workflow_* (durable run kernel) ─────────────────────────

    registerTool({
      name: 'workflow_start',
      description:
        "Start a durable workflow run. Nodes: agent | fanout | council | goal | verifier | human_gate | router | subflow. Every state transition is checkpointed to disk, so a run survives a process restart and can be resumed. When a contract is supplied the run cannot reach `completed` unless the runtime's own checks pass — without one it completes as `unverified`, which means nothing checked it. Runs in background; poll with workflow_status.",
      parameters: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              'WorkflowSpec: { name, nodes[], cwd?, contract?, maxNodeVisits? }. See skills/references/workflow.md for the node shapes.',
          },
          template: {
            type: 'string',
            enum: ['solve', 'council', 'fanout', 'goal'],
            description:
              'Build a built-in workflow instead of supplying `spec`. `solve` = triage → implement → review → verify → repair-until-green. `goal` = a /goal on one Codex thread or Claude Code session (`task` is the objective) → verify → repair on the same thread.',
          },
          task: { type: 'string', description: 'Task text, when using `template`.' },
          agents: {
            type: 'array',
            maxItems: 16,
            description: 'Agents for the template: { name, engine?, model?, effort?, persona?, acpAgent? }.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1 },
                engine: { type: 'string', enum: ENGINE_TYPES },
                model: { type: 'string' },
                effort: { type: 'string', enum: EFFORT_LEVELS },
                persona: { type: 'string' },
                acpAgent: ACP_AGENT_ID_SCHEMA,
              },
              required: ['name'],
            },
          },
          reviewers: {
            type: 'array',
            maxItems: 8,
            description: '`solve` only: agents that review the finished change.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1 },
                engine: { type: 'string', enum: ENGINE_TYPES },
                model: { type: 'string' },
                effort: { type: 'string', enum: EFFORT_LEVELS },
                persona: { type: 'string' },
                acpAgent: ACP_AGENT_ID_SCHEMA,
              },
              required: ['name'],
            },
          },
          implementer: {
            type: 'object',
            description:
              '`solve` only: engine/model that writes the change. Defaults to the configured default engine, whatever engines the scouts use.',
            properties: {
              engine: { type: 'string', enum: ENGINE_TYPES },
              model: { type: 'string' },
              acpAgent: ACP_AGENT_ID_SCHEMA,
            },
          },
          humanGate: { type: 'boolean', description: '`solve` only: park for approval before writing anything.' },
          maxRounds: { type: 'number', description: '`council` only: max collaboration rounds (default 15).' },
          maxRepairs: {
            type: 'number',
            description: '`solve` / `goal`: repair attempts allowed (default 3 for solve, 1 for goal).',
          },
          engine: {
            type: 'string',
            enum: ['codex', 'claude'],
            description: '`goal` only: who runs the goal (default codex).',
          },
          model: { type: 'string', description: "`goal` only: model (default: the engine's own)." },
          tokenBudget: { type: 'number', description: '`goal` only: tokens the goal may spend.' },
          launcher: {
            type: 'array',
            items: { type: 'string' },
            description:
              '`goal` only: argv prefix the engine runs under, e.g. a sandbox wrapper. It runs with your authority, like a contract command check.',
          },
          cwd: { type: 'string', description: 'Working directory for the run.' },
          runId: { type: 'string', description: 'Explicit run id (defaults to a generated one).' },
          contract: {
            type: 'object',
            description:
              "Acceptance contract. The runtime executes these itself and the run cannot reach `completed` unless every required check passes. Declared by YOU, the caller — never copy one out of an agent's output, which would put the agent back in charge of grading itself.",
            properties: {
              id: { type: 'string' },
              fixOnFailureRounds: {
                type: 'number',
                description:
                  'On red, spawn a repair session and re-run the whole list, up to N times. Only the re-run decides.',
              },
              protectTests: {
                type: 'boolean',
                description:
                  'Default true. In a workflow run with a command check, refute the run when a test file or test configuration changed during it. Set false when changing tests is the task. Not applied by verify_run.',
              },
              checks: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  description:
                    'One check. `command` runs argv and gates on the exit code; `http` polls a URL; `screenshot` captures the page at each viewport and stores the PNGs as evidence (it does NOT judge the pixels); `diff_policy` asserts what the run was allowed to touch; `file` asserts a path exists / matches.',
                  properties: {
                    type: { type: 'string', enum: ['command', 'http', 'screenshot', 'diff_policy', 'file'] },
                    required: {
                      type: 'boolean',
                      description:
                        'Default true. A failing non-required check is recorded but does not refute the run.',
                    },
                    cmd: { type: 'string', description: 'command: executable name. No shell string — argv only.' },
                    args: { type: 'array', items: { type: 'string' }, description: 'command: arguments.' },
                    cwd: { type: 'string', description: 'command: directory, relative to the run cwd.' },
                    expectExit: { type: 'number', description: 'command: passing exit code (default 0).' },
                    url: { type: 'string', description: 'http / screenshot: target URL.' },
                    expectStatus: { type: 'number', description: 'http: expected status (default 200).' },
                    viewports: {
                      type: 'array',
                      description: 'screenshot: [{ width, height, label? }].',
                      items: {
                        type: 'object',
                        properties: {
                          width: { type: 'number' },
                          height: { type: 'number' },
                          label: { type: 'string' },
                        },
                        required: ['width', 'height'],
                      },
                    },
                    maxFiles: { type: 'number', description: 'diff_policy: cap on changed files.' },
                    forbidPaths: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'diff_policy: paths that must not be touched.',
                    },
                    requirePaths: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'diff_policy: at least one change must land under one of these.',
                    },
                    path: { type: 'string', description: 'file: path relative to the run cwd.' },
                    exists: { type: 'boolean', description: 'file: default true; false asserts absence.' },
                    matches: { type: 'string', description: 'file: regex the contents must match.' },
                    timeoutMs: { type: 'number', description: 'Per-check wall clock.' },
                  },
                  required: ['type'],
                },
              },
            },
            required: ['checks'],
          },
        },
        required: [],
      },
      execute: async (_id, args) => {
        const cwd = sanitizeCwd(args.cwd as string | undefined);
        let spec = args.spec as WorkflowSpec | undefined;
        if (!spec) {
          const template = (args.template as string) || 'solve';
          const task = args.task as string;
          if (!task) throw new Error('workflow_start needs `spec`, or `template` with `task`');
          const agents = (args.agents as SolveArgs['scouts']) ?? [{ name: 'agent' }];
          if (template === 'council') {
            spec = councilWorkflow({ task, cwd, agents, maxRounds: args.maxRounds as number | undefined });
          } else if (template === 'fanout') {
            spec = fanoutWorkflow({ task, cwd, agents, synthesize: agents.length >= 2 });
          } else if (template === 'goal') {
            spec = goalWorkflow({
              task,
              cwd,
              contract: args.contract as never,
              engine: args.engine as GoalArgs['engine'],
              model: args.model as string | undefined,
              tokenBudget: args.tokenBudget as number | undefined,
              launcher: args.launcher as string[] | undefined,
              maxRepairs: args.maxRepairs as number | undefined,
            });
          } else {
            spec = solveWorkflow({
              task,
              cwd,
              scouts: agents,
              implementer: args.implementer as SolveArgs['implementer'],
              reviewers: args.reviewers as SolveArgs['reviewers'],
              humanGate: args.humanGate as boolean | undefined,
              maxRepairs: args.maxRepairs as number | undefined,
            });
          }
        }
        const record = await getManager().workflowStart(spec, {
          cwd,
          runId: args.runId as string | undefined,
          contract: args.contract,
        });
        return {
          ok: true,
          runId: record.runId,
          workflow: record.workflow,
          state: record.state,
          nodes: Object.keys(record.nodes),
          note: 'Workflow running in background. Poll with workflow_status.',
        };
      },
    });

    registerTool({
      name: 'workflow_status',
      description:
        'Poll a workflow run. Returns state, per-node status, and the outcome: `verified` (a contract passed), `refuted` (it failed), or `unverified` (nothing checked the work: none was declared, or a pass no longer stands, in which case `outcomeReason` says why).',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          events: { type: 'number', description: 'Also return the last N events from the run log.' },
        },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const record = getManager().workflowStatus(args.runId as string);
        const limit = args.events as number | undefined;
        return {
          ok: true,
          runId: record.runId,
          workflow: record.workflow,
          state: record.state,
          outcome: record.outcome,
          outcomeReason: record.outcomeReason,
          verdict: record.verdict,
          currentNode: record.currentNode,
          evidenceId: record.evidenceId,
          costUsd: record.costUsd,
          error: record.error,
          nodes: record.nodes,
          consensusVotes: record.consensusVotes,
          events: limit ? readKernelEvents(record.runId, limit) : undefined,
        };
      },
    });

    registerTool({
      name: 'workflow_list',
      description: 'List workflow runs on this machine, newest first. Survives restarts.',
      parameters: {
        type: 'object',
        properties: {
          workflow: { type: 'string' },
          state: {
            type: 'string',
            enum: ['pending', 'running', 'awaiting_human', 'verifying', 'completed', 'failed', 'cancelled'],
          },
          limit: { type: 'number' },
        },
      },
      execute: async (_id, args) => ({
        ok: true,
        runs: getManager().workflowList({
          workflow: args.workflow as string | undefined,
          state: args.state as RunState | undefined,
          limit: (args.limit as number | undefined) ?? 25,
        }),
      }),
    });

    registerTool({
      name: 'workflow_resume',
      description:
        'Re-attach to a workflow whose process died. Nodes already marked succeeded are not re-run; the node that was in flight is retried, because a half-finished node left no result to trust.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          agentCustomEngineRefs: {
            type: 'object',
            description:
              'Per-agent custom-engine credentials, by name: { "<agent>": "<REF>" }. The orchestrator resolves each REF from CLAWO_CUSTOM_ENGINE_<REF> on its own host — the credentials themselves are never persisted with the run and never travel here. Required to resume a run whose agents used a custom engine.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const refs = args.agentCustomEngineRefs as Record<string, string> | undefined;
        const record = await getManager().workflowResume(args.runId as string, {
          secrets: refs ? { agentCustomEngines: resolveSecretRefs(refs) } : undefined,
        });
        return { ok: true, runId: record.runId, state: record.state, currentNode: record.currentNode };
      },
    });

    registerTool({
      name: 'workflow_cancel',
      description: 'Cancel a running workflow. The current node is asked to stop; the run ends in `cancelled`.',
      parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      execute: async (_id, args) => ({ ok: true, ...getManager().workflowCancel(args.runId as string) }),
    });

    registerTool({
      name: 'workflow_steer',
      description:
        "Queue a correction for a running workflow. The text is prepended to the next agent node's prompt — corrections belong before the task, not after it.",
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, text: { type: 'string' } },
        required: ['runId', 'text'],
      },
      execute: async (_id, args) => ({
        ok: true,
        ...getManager().workflowSteer(args.runId as string, args.text as string),
      }),
    });

    registerTool({
      name: 'workflow_approve',
      description:
        'Answer a workflow parked at a human_gate node. A run parked before a server restart is resumed with the answer attached.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, approved: { type: 'boolean' } },
        required: ['runId', 'approved'],
      },
      execute: async (_id, args) => ({
        ok: true,
        ...(await getManager().workflowApprove(args.runId as string, args.approved as boolean)),
      }),
    });

    registerTool({
      name: 'verify_run',
      description:
        'Run an acceptance contract against a directory and return the evidence bundle. Use it to check work that did not come through a workflow — a plain session that edited a repo, say. The contract is yours; nothing is taken from agent output.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Directory to check.' },
          baseSha: {
            type: 'string',
            description: 'Commit to measure the change against. Without it, diff_policy sees untracked files only.',
          },
          label: {
            type: 'string',
            description:
              'Name for the stored evidence (defaults to a generated one). Must not be the id of an existing workflow run.',
          },
          contract: {
            type: 'object',
            description:
              "Acceptance contract. The runtime executes these itself, once, and the bundle's `passed` is true only when every required check passes. Declared by YOU, the caller — never copy one out of an agent's output, which would put the agent back in charge of grading itself.",
            properties: {
              id: { type: 'string' },
              fixOnFailureRounds: {
                type: 'number',
                description: 'Ignored by verify_run, which spawns no repair session. Applies inside workflow runs.',
              },
              protectTests: {
                type: 'boolean',
                description:
                  'Default true. In a workflow run with a command check, refute the run when a test file or test configuration changed during it. Set false when changing tests is the task. Not applied by verify_run.',
              },
              checks: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  description:
                    'One check. `command` runs argv and gates on the exit code; `http` polls a URL; `screenshot` captures the page at each viewport and stores the PNGs as evidence (it does NOT judge the pixels); `diff_policy` asserts what the run was allowed to touch; `file` asserts a path exists / matches.',
                  properties: {
                    type: { type: 'string', enum: ['command', 'http', 'screenshot', 'diff_policy', 'file'] },
                    required: {
                      type: 'boolean',
                      description:
                        'Default true. A failing non-required check is recorded but does not refute the run.',
                    },
                    cmd: { type: 'string', description: 'command: executable name. No shell string — argv only.' },
                    args: { type: 'array', items: { type: 'string' }, description: 'command: arguments.' },
                    cwd: { type: 'string', description: 'command: directory, relative to the run cwd.' },
                    expectExit: { type: 'number', description: 'command: passing exit code (default 0).' },
                    url: { type: 'string', description: 'http / screenshot: target URL.' },
                    expectStatus: { type: 'number', description: 'http: expected status (default 200).' },
                    viewports: {
                      type: 'array',
                      description: 'screenshot: [{ width, height, label? }].',
                      items: {
                        type: 'object',
                        properties: {
                          width: { type: 'number' },
                          height: { type: 'number' },
                          label: { type: 'string' },
                        },
                        required: ['width', 'height'],
                      },
                    },
                    maxFiles: { type: 'number', description: 'diff_policy: cap on changed files.' },
                    forbidPaths: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'diff_policy: paths that must not be touched.',
                    },
                    requirePaths: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'diff_policy: at least one change must land under one of these.',
                    },
                    path: { type: 'string', description: 'file: path relative to the run cwd.' },
                    exists: { type: 'boolean', description: 'file: default true; false asserts absence.' },
                    matches: { type: 'string', description: 'file: regex the contents must match.' },
                    timeoutMs: { type: 'number', description: 'Per-check wall clock.' },
                  },
                  required: ['type'],
                },
              },
            },
            required: ['checks'],
          },
        },
        required: ['cwd', 'contract'],
      },
      execute: async (_id, args) => {
        const bundle = await getManager().verifyRun({
          cwd: sanitizeCwd(args.cwd as string)!,
          contract: args.contract,
          baseSha: args.baseSha as string | undefined,
          label: args.label as string | undefined,
        });
        return { ok: true, ...bundle };
      },
    });

    // ─── Tool: council_start ────────────────────────────────────────────

    registerTool({
      name: 'council_start',
      description:
        'Start a multi-agent council that collaborates on a task using git worktree isolation, round-based execution, and consensus voting. Each agent can use its own engine and model. Runs in background; poll with council_status.',
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
                  enum: ENGINE_TYPES,
                  description: 'Engine (default: claude). Use "custom" with customEngine for any CLI.',
                },
                model: { type: 'string', description: 'Model to use' },
                baseUrl: { type: 'string', description: 'Custom API endpoint (for proxy)' },
                customEngine: CUSTOM_ENGINE_OR_PRESET_SCHEMA,
                acpAgent: ACP_AGENT_ID_SCHEMA,
                effort: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto'],
                  description: 'Per-agent reasoning effort.',
                },
                ultracode: {
                  type: 'boolean',
                  description: 'Per-agent ultracode / dynamic workflows (claude engine only).',
                },
              },
              required: ['name', 'emoji', 'persona'],
            },
          },
          maxRounds: { type: 'number', description: 'Max collaboration rounds (default 15)' },
          agentTimeoutMs: { type: 'number', description: 'Per-agent timeout in ms (default 1800000)' },
          maxTurnsPerAgent: { type: 'number', description: 'Max tool turns per agent per round (default 50)' },
          maxBudgetUsd: { type: 'number', description: 'Max API spend per agent (USD)' },
          defaultPermissionMode: {
            type: 'string',
            enum: ['acceptEdits', 'bypassPermissions', 'default', 'manual', 'dontAsk', 'plan', 'auto'],
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

        const session = await getManager().councilStart(args.task as string, config);
        return { ok: true, ...session, note: 'Council running in background. Poll with council_status.' };
      },
    });

    // ─── Tool: council_status ───────────────────────────────────────────

    registerTool({
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

    registerTool({
      name: 'council_abort',
      description:
        'Abort a council running in this process, stopping all agent sessions and removing the worktrees it created. A council that is not running here is left alone and the call returns ok: false.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = getManager().councilAbort(args.id as string);
        if (!result.aborted) return { ok: false, aborted: false, state: result.state, error: result.reason };
        return { ok: true, aborted: true };
      },
    });

    // ─── Tool: council_inject ───────────────────────────────────────────

    registerTool({
      name: 'council_inject',
      description:
        'Inject a user message into the next round of a running council. The message will be appended to all agent prompts in the next round; a second inject before that round replaces the first. The council must be running in this process.',
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

    registerTool({
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

    registerTool({
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

    registerTool({
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

    registerTool({
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

    registerTool({
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

    registerTool({
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

    registerTool({
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
        const result = await getManager().ultraplanStart(args.task as string, {
          cwd: sanitizeCwd(args.cwd as string | undefined),
          model: args.model as string | undefined,
          timeout: args.timeout as number | undefined,
        });
        return { ok: true, ...result, note: 'Ultraplan running in background. Poll with ultraplan_status.' };
      },
    });

    // ─── Tool: ultraplan_status ─────────────────────────────────────

    registerTool({
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

    registerTool({
      name: 'ultrareview_start',
      description:
        'Start an Ultrareview: 1-20 read-only reviewer agents (default 5) that review your codebase in parallel, each from a different angle (security, performance, logic, types, etc.), merged into one report by a read-only synthesis pass. Runs in background.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project directory to review' },
          agentCount: { type: 'number', description: 'Number of reviewer agents (1-20, default 5)' },
          maxDurationMinutes: { type: 'number', description: 'Max review duration in minutes (5-25, default 10)' },
          model: { type: 'string', description: 'Model for reviewers (default: session default)' },
          focus: { type: 'string', description: 'Review focus area (default: bugs + security + quality)' },
          engines: {
            type: 'array',
            // Excluded: 'custom', because ultrareview spawns reviewers without a
            // customEngine config, and 'acp', because an ACP agent cannot be held
            // to the read-only sandbox every reviewer runs in.
            items: { type: 'string', enum: ENGINE_TYPES.filter((e) => e !== 'custom' && e !== 'acp') },
            description:
              'Engines to round-robin reviewers across (default ["claude"]). Every reviewer runs read-only (sandboxMode read-only), so custom and acp are not accepted. Reviewers fan out in parallel; per-agent failures are isolated.',
          },
        },
        required: ['cwd'],
      },
      execute: async (_id, args) => {
        const result = await getManager().ultrareviewStart(sanitizeCwd(args.cwd as string)!, {
          agentCount: args.agentCount as number | undefined,
          maxDurationMinutes: args.maxDurationMinutes as number | undefined,
          model: args.model as string | undefined,
          focus: args.focus as string | undefined,
          engines: args.engines as EngineType[] | undefined,
        });
        return { ok: true, ...result, note: 'Ultrareview running in background. Poll with ultrareview_status.' };
      },
    });

    // ─── Tool: ultrareview_status ───────────────────────────────────

    registerTool({
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

    registerTool({
      name: 'autoloop_start',
      description:
        'Start a v2 autoloop run in chat mode. Planner, Coder, and Reviewer default to Claude (opus/sonnet/sonnet) but each role can use a different engine/model. Coder and Reviewer are spawned later by the Planner after plan approval. Returns a run_id and the Planner session name.',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'Stable run identifier (used to address subsequent chat / status calls)',
          },
          workspace: { type: 'string', description: 'Path to the git workspace where the run lives' },
          // No 'acp': a role is configured by engine name alone and cannot name the ACP agent.
          planner_engine: { type: 'string', enum: AUTOLOOP_ENGINES, description: 'Planner engine (default: claude)' },
          planner_model: {
            type: 'string',
            description: 'Planner model (default: opus for Claude; engine default otherwise)',
          },
          planner_effort: { type: 'string', enum: EFFORT_LEVELS, description: 'Fixed Planner reasoning effort' },
          planner_custom_engine: CUSTOM_ENGINE_SCHEMA,
          coder_engine: {
            type: 'string',
            enum: AUTOLOOP_ENGINES,
            description: 'Default Coder engine (default: claude)',
          },
          coder_model: {
            type: 'string',
            description: 'Default Coder model (default: sonnet for Claude; engine default otherwise)',
          },
          coder_effort: { type: 'string', enum: EFFORT_LEVELS, description: 'Fixed Coder reasoning effort' },
          coder_custom_engine: CUSTOM_ENGINE_SCHEMA,
          reviewer_engine: {
            type: 'string',
            enum: AUTOLOOP_ENGINES,
            description: 'Default Reviewer engine (default: claude)',
          },
          reviewer_model: {
            type: 'string',
            description: 'Default Reviewer model (default: sonnet for Claude; engine default otherwise)',
          },
          reviewer_effort: { type: 'string', enum: EFFORT_LEVELS, description: 'Fixed Reviewer reasoning effort' },
          reviewer_custom_engine: CUSTOM_ENGINE_SCHEMA,
          send_timeout_ms: {
            ...AUTOLOOP_TIMEOUT_SCHEMA.sendTimeoutMs,
            description: 'Per-agent send wall-clock cap in milliseconds (default 600000; inclusive range 5000–7200000)',
          },
          activity_lease_ms: {
            ...AUTOLOOP_TIMEOUT_SCHEMA.activityLeaseMs,
            description:
              'Inactivity lease in milliseconds, renewed by qualified progress (default 1800000; inclusive range 60000–7200000)',
          },
          autoloop_hard_timeout_ms: {
            ...AUTOLOOP_TIMEOUT_SCHEMA.autoloopHardTimeoutMs,
            description:
              'Absolute non-renewable run deadline in milliseconds (default 86400000; inclusive range 600000–259200000)',
          },
        },
        required: ['run_id', 'workspace'],
      },
      execute: async (_id, args) => {
        const timeoutConfig = {
          sendTimeoutMs: args.send_timeout_ms as number | undefined,
          activityLeaseMs: args.activity_lease_ms as number | undefined,
          autoloopHardTimeoutMs: args.autoloop_hard_timeout_ms as number | undefined,
        };
        validateAutoloopTimeoutConfig(timeoutConfig);
        const result = await getManager().autoloopStart({
          runId: args.run_id as string,
          workspace: sanitizeCwd(args.workspace as string)!,
          plannerEngine: args.planner_engine as EngineType | undefined,
          plannerModel: args.planner_model as string | undefined,
          plannerEffort: args.planner_effort as EffortLevel | undefined,
          plannerCustomEngine: args.planner_custom_engine as CustomEngineConfig | undefined,
          coderEngine: args.coder_engine as EngineType | undefined,
          coderModel: args.coder_model as string | undefined,
          coderEffort: args.coder_effort as EffortLevel | undefined,
          coderCustomEngine: args.coder_custom_engine as CustomEngineConfig | undefined,
          reviewerEngine: args.reviewer_engine as EngineType | undefined,
          reviewerModel: args.reviewer_model as string | undefined,
          reviewerEffort: args.reviewer_effort as EffortLevel | undefined,
          reviewerCustomEngine: args.reviewer_custom_engine as CustomEngineConfig | undefined,
          ...timeoutConfig,
        });
        return {
          ok: true,
          ...result,
          note: 'Planner ready. Use autoloop_chat to converse. Coder/Reviewer not yet spawned.',
        };
      },
    });

    // ─── Tool: autoloop_chat ─────────────────────────────────────

    registerTool({
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

    registerTool({
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

    registerTool({
      name: 'autoloop_list',
      description: 'List the v2 autoloop runs recorded on this machine, running and finished, newest first.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, runs: getManager().autoloopList() }),
    });

    // ─── Tool: autoloop_reset_agent ──────────────────────────────

    registerTool({
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

    registerTool({
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

    // ─── Tool: autoloop_resume ────────────────────────────────────
    //
    // Thin native facade over SessionManager.autoloopResume. Caller options are
    // mapped once; omission stays omission. Validation, audit and live/cold
    // semantics stay in the manager. Local catch replaces thrown errors with a
    // fixed message — normalizeToolResult only wraps successful results.

    registerTool({
      name: 'autoloop_resume',
      description:
        'Resume a v2 autoloop run. Ordinary and activity-lease pauses resume with no timeout fields. Live send-timeout pending: omitting timeout fields is a no-op (pending is not cleared); advancing it needs an explicit send_timeout_ms increase and the matching pending_dispatch_id. Cold resume: omission still follows manager reconstruction even when a pending dispatch was stored; pending_dispatch_id is required only when an increase and pending coexist; a cold timeout-only increase without pending remains supported. Optional *CustomEngineRef names resolve against CLAWO_CUSTOM_ENGINE_<REF> on the orchestrator host for cold custom-engine runs. Returns { ok, state }; a paused or terminated state is not completed project work.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run id from autoloop_start' },
          send_timeout_ms: {
            type: 'number',
            minimum: 5_000,
            maximum: 7_200_000,
            description:
              'Optional send-timeout increase in ms (inclusive 5000–7200000). Omission preserves the historical resume path; when supplied it must be a strict increase over the run’s effective value (manager-enforced).',
          },
          pending_dispatch_id: {
            type: 'string',
            description:
              'Optional exact pending dispatch id. Required by the manager only when increasing the timeout while a pending dispatch exists (live or cold); omit for ordinary resume and for cold timeout-only increase without pending.',
          },
          plannerCustomEngineRef: {
            type: 'string',
            description:
              'Secret reference name for the Planner custom engine (CLAWO_CUSTOM_ENGINE_<REF>). Supply only when the stored run used engine "custom" for that role.',
          },
          coderCustomEngineRef: {
            type: 'string',
            description:
              'Secret reference name for the Coder custom engine (CLAWO_CUSTOM_ENGINE_<REF>). Supply only when the stored run used engine "custom" for that role.',
          },
          reviewerCustomEngineRef: {
            type: 'string',
            description:
              'Secret reference name for the Reviewer custom engine (CLAWO_CUSTOM_ENGINE_<REF>). Supply only when the stored run used engine "custom" for that role.',
          },
        },
        required: ['run_id'],
      },
      execute: async (_id, args) => {
        try {
          const runId = args.run_id;
          if (typeof runId !== 'string' || runId.length === 0) {
            throw new Error('run_id must be a non-empty string');
          }
          for (const key of [
            'pending_dispatch_id',
            'plannerCustomEngineRef',
            'coderCustomEngineRef',
            'reviewerCustomEngineRef',
          ] as const) {
            if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
            const value = args[key];
            if (typeof value !== 'string' || value.length === 0) {
              throw new Error(`${key} must be a non-empty string when provided`);
            }
          }

          const resumeOptions: NonNullable<Parameters<SessionManager['autoloopResume']>[1]> = {
            ...(resolveSecretRefs({
              plannerCustomEngine: args.plannerCustomEngineRef as string | undefined,
              coderCustomEngine: args.coderCustomEngineRef as string | undefined,
              reviewerCustomEngine: args.reviewerCustomEngineRef as string | undefined,
            }) as Pick<
              NonNullable<Parameters<SessionManager['autoloopResume']>[1]>,
              'plannerCustomEngine' | 'coderCustomEngine' | 'reviewerCustomEngine'
            >),
          };
          if (Object.prototype.hasOwnProperty.call(args, 'send_timeout_ms')) {
            resumeOptions.sendTimeoutMs = args.send_timeout_ms as number;
          }
          if (Object.prototype.hasOwnProperty.call(args, 'pending_dispatch_id')) {
            resumeOptions.pendingDispatchId = args.pending_dispatch_id as string;
          }

          const state = await getManager().autoloopResume(runId, resumeOptions);
          return { ok: true, state };
        } catch {
          throw new Error('Autoloop resume failed');
        }
      },
    });

    // ─── ultraapp (read-only) ─────────────────────────────────────────────

    registerTool({
      name: 'ultraapp_list',
      description:
        'List all ultraapp runs with title, mode (interview, queued, building, build-complete, deploying, done, failed, cancelled), and timestamps. Read-only — to start a new run, call ultraapp_new or open the Forge dashboard tab.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const ua = getManager().getUltraappManager();
        const runs = await ua.store.listRuns();
        return { ok: true, runs };
      },
    });

    registerTool({
      name: 'ultraapp_get',
      description: 'Get the AppSpec, chat history, and state for one ultraapp run. Pass `runId` from ultraapp_list.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const runId = args.runId as string;
        const [spec, chat, state] = await Promise.all([
          ua.store.readSpec(runId),
          ua.store.readChat(runId),
          ua.store.readState(runId),
        ]);
        return { ok: true, spec, chat, state };
      },
    });

    registerTool({
      name: 'ultraapp_status',
      description: 'Get the run state (mode, failure reason if any) for one ultraapp run. Cheap; no chat or spec data.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const state = await ua.store.readState(args.runId as string);
        return { ok: true, ...state };
      },
    });

    // ─── ultraapp (write) ─────────────────────────────────────────────────

    registerTool({
      name: 'ultraapp_new',
      description:
        'Start a new ultraapp run. Spawns the interview Claude Opus session; the first question lands on the SSE stream / next ultraapp_get call. Returns the runId.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const ua = getManager().getUltraappManager();
        const runId = await ua.createRun();
        return { ok: true, runId };
      },
    });

    registerTool({
      name: 'ultraapp_answer',
      description:
        'Submit an answer to the current interview question. Either pick `value` (one of the option values from the latest question) or pass `freeform` text — both can be used together for "selected X with caveat".',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          value: { type: 'string', description: 'Selected option value (empty string for freeform-only)' },
          freeform: { type: 'string', description: 'Optional free-form text answer' },
        },
        required: ['runId', 'value'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        await ua.submitAnswer(args.runId as string, {
          value: args.value as string,
          freeform: args.freeform as string | undefined,
        });
        return { ok: true };
      },
    });

    registerTool({
      name: 'ultraapp_add_file',
      description:
        'Reference a local example file by absolute path (under $HOME or /tmp; symlinks and dotfiles rejected). Use this to attach reference inputs the interview can extract metadata from. For binary uploads from a browser, use the dashboard.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          absolutePath: { type: 'string', description: 'Absolute path under $HOME or /tmp' },
        },
        required: ['runId', 'absolutePath'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const r = await ua.addFile(args.runId as string, {
          kind: 'path',
          absolutePath: args.absolutePath as string,
        });
        return { ok: true, ...r };
      },
    });

    registerTool({
      name: 'ultraapp_spec_edit',
      description:
        'Manually edit the AppSpec via a JSON Patch (RFC 6902). Use sparingly — the interview engine produces and updates the spec automatically. Useful to correct a slot before clicking build.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          patch: {
            type: 'array',
            description: 'RFC 6902 patch operations',
            items: { type: 'object' },
          },
        },
        required: ['runId', 'patch'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        await ua.applySpecEdit(args.runId as string, args.patch as never);
        return { ok: true };
      },
    });

    registerTool({
      name: 'ultraapp_build_start',
      description:
        'Enqueue a build for the run. Builds run serially. Watch ultraapp_status for transitions: queued → building → build-complete (or → deploying → done if a router is wired).',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        await ua.startBuild(args.runId as string);
        return { ok: true };
      },
    });

    registerTool({
      name: 'ultraapp_build_cancel',
      description:
        "Cancel a queued or in-flight build. A queued build leaves the queue; an in-flight build's workflow run is cancelled, and the build stops at its next cancellation check.",
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        ua.cancelBuild(args.runId as string);
        return { ok: true };
      },
    });

    registerTool({
      name: 'ultraapp_feedback',
      description:
        'Submit a done-mode feedback message (after the run reaches `done`). The text is classified by Haiku into cosmetic / spec-delta / structural and routed: cosmetic runs the patcher (Opus diff + validate + auto-revert + version snapshot); spec-delta flips the run back to `interview` with a focused bootstrap; structural posts a "start fresh" suggestion. Before the run reaches `done`, the text is sent to the interview as a free-form answer instead.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          text: { type: 'string', description: 'The user feedback (1+ chars)' },
        },
        required: ['runId', 'text'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        await ua.submitDoneModeMessage(args.runId as string, args.text as string);
        return { ok: true };
      },
    });

    registerTool({
      name: 'ultraapp_promote_version',
      description:
        'Make a version the one serving the app. A version deployed before is swapped in (the live one is stopped, the target restarted, the router map updated); one never deployed, such as a patched version, is built and deployed first. Requires a router to be wired (see clawo serve).',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          version: { type: 'string', description: 'Target version like "v1", "v2"' },
        },
        required: ['runId', 'version'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const r = await ua.promoteVersion(args.runId as string, args.version as string);
        return r;
      },
    });

    registerTool({
      name: 'ultraapp_start_container',
      description:
        'Start the deployed container for a run (e.g., after `ultraapp_stop_container` or after orchestrator restart with a stopped container). Re-registers the slug on the router.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const r = await ua.startContainer(args.runId as string);
        return r;
      },
    });

    registerTool({
      name: 'ultraapp_stop_container',
      description:
        'Stop the deployed container and deregister the slug from the router. URL returns 404 until ultraapp_start_container.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const r = await ua.stopContainer(args.runId as string);
        return r;
      },
    });

    registerTool({
      name: 'ultraapp_delete',
      description:
        'Delete a run completely: stops the container, removes the image, deregisters the slug, and removes the on-disk run dir at ~/.claw-orchestrator/ultraapps/<runId>/. Irreversible.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      execute: async (_id, args) => {
        const ua = getManager().getUltraappManager();
        const r = await ua.deleteRun(args.runId as string);
        return r;
      },
    });
  },
};

export default plugin;
