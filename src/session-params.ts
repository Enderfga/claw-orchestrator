/**
 * The parameters of the `session_start` tool, which are the session options a
 * caller can set. One list, read by the MCP tool (src/index.ts), the CLI's
 * session flags (bin/session-flags.ts) and the defaults file (src/clawo-config.ts),
 * so a field exists in all three or in none.
 */

import { ENGINE_TYPES } from './types.js';

export const ACP_AGENT_SCHEMA = {
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

export const CUSTOM_ENGINE_SCHEMA = {
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

export const CUSTOM_ENGINE_OR_PRESET_SCHEMA = {
  description:
    'Custom engine (required when engine is "custom"): the id of a bundled preset (`clawo engines`), or, from a local caller only, an inline config.',
  oneOf: [{ type: 'string', description: 'Preset id, e.g. "zcode"' }, CUSTOM_ENGINE_SCHEMA],
};

export const SESSION_START_PROPERTIES: Record<string, Record<string, unknown>> = {
  name: { type: 'string', description: 'Session name (auto-generated if omitted)' },
  cwd: { type: 'string', description: 'Working directory' },
  engine: {
    type: 'string',
    enum: ENGINE_TYPES,
    description:
      'Engine to use (default: the configured default engine — `clawo config set defaults.engine <engine>`; claude out of the box). codex = `codex exec` per send (no /goal). codex-app = long-running `codex app-server` with /goal support. agy = Google Antigravity CLI (stream-json output with reported token usage; the conversation is resumed by its id on each send). grok = xAI Grok Build CLI (reports its own per-turn cost). cursor = Cursor Agent CLI (`cursor-agent -p`; the models of a Cursor subscription — Composer, Claude, GPT, Grok, Gemini — by the model ids Cursor lists, `auto` by default). opencode = sst/opencode CLI (provider-agnostic; pass model as `provider/model`). acp = any Agent Client Protocol agent, chosen with acpAgent. Use "custom" with customEngine config for any CLI. gemini is legacy, kept for existing callers: use agy instead.',
  },
  model: { type: 'string', description: 'Model to use (opus, sonnet, haiku, gpt-5.5, agy-pro, etc.)' },
  claudeAccount: {
    type: 'string',
    description:
      "Claude engine only. The Claude account to run under, by name from the server's claude-accounts.json, or 'auto' for the first available one in its rotation. A session on an account in the rotation moves to the next account when it reaches its usage limit and continues the same conversation. Omit for the file's default, else the CLI's own login.",
  },
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
      'Directories the session may use besides cwd (`--add-dir`): Claude Code, Codex, Antigravity, Cursor, and Grok on a new conversation; codex-app adds them as writable roots of a workspace-write session. A resumed Codex thread keeps the directories its first turn opened.',
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
  turnCommand: {
    type: 'string',
    description:
      'An engine command every message of the session goes through, e.g. "/boost" or "/teamwork" on agy, "/best-of-n" on Cursor. A message that is itself a command (starts with "/") is sent as it is. Refused at start on an engine whose sessions take no commands (session_command lists what an engine has).',
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
  fastMode: {
    type: 'boolean',
    description:
      'Claude engine only. Opt the session into fast mode (the fastMode settings key), which a headless process is otherwise refused. The account and model must allow it.',
  },
  advisor: {
    type: 'string',
    description:
      'Claude engine only. The advisor model the session consults at key moments (`--advisor`, e.g. "opus"), for this session only. It must be at least as capable as the main model, or the CLI does not use it.',
  },
  outputStyle: {
    type: 'string',
    description:
      'Claude engine only. The output style (e.g. "Concise", "Explanatory"), set for this session only through --settings rather than written into the project.',
  },
  sandboxMode: {
    type: 'string',
    enum: ['read-only', 'workspace-write', 'danger-full-access'],
    description:
      'Sandbox policy. Codex supports all values (default workspace-write). read-only is enforced on claude, agy, grok, cursor and opencode through their own plan/read-only modes (Cursor: Ask mode behind a permission config that denies writes and shell commands); a custom engine must map it via permissionModes or the session refuses to start. The acp engine refuses read-only, because the agent runs its own tools; its permission answers follow permissionMode.',
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
  sessionName: {
    type: 'string',
    description:
      "The engine's own name for the conversation: Claude Code `-n` (resumable as `--resume <name>`), OpenCode `--title`, the codex-app thread's name. Defaults to the session name on OpenCode.",
  },
  strictMcpConfig: {
    type: 'boolean',
    description:
      "Claude engine only (`--strict-mcp-config`): use only the MCP servers in mcpConfig, not the user's and project's; with no mcpConfig, none.",
  },
  settingSources: {
    type: 'array',
    items: { type: 'string', enum: ['user', 'project', 'local'] },
    description:
      "Claude engine only (`--setting-sources`): the settings files to load. Leaving out `user` drops the user's model, permission mode, plugins, MCP servers and env; `settings` still applies. Empty loads none.",
  },
  systemPromptSnapshot: {
    type: 'string',
    enum: ['on', 'off'],
    description:
      'Claude engine only (`--system-prompt-snapshot`). `on` (the CLI default, except under bare) reuses the system prompt recorded on the first request, through resumes, until compaction; `off` renders it each request, so a resume with a new appendSystemPrompt takes effect.',
  },
  pluginDir: {
    type: ['string', 'array'],
    items: { type: 'string' },
    description:
      'Claude Code and Cursor (`--plugin-dir`): local plugin directories (Claude Code also takes .zip files) for this session only, in the format of the engine they are for.',
  },
  autoCompactWindow: {
    type: ['string', 'number'],
    description:
      "The engine's own auto-compaction window, `auto` or a token count of at least 100000: claude `--autocompact`, agy `AGY_CLI_AUTO_COMPACT_OVERRIDE`. Applies within a turn, unlike autoCompactPercent.",
  },
  appendSubagentSystemPrompt: {
    type: 'string',
    description:
      'Claude engine only (`--append-subagent-system-prompt`): standing instructions for the subagents the session starts.',
  },
  disableSlashCommands: {
    type: 'boolean',
    description:
      'claude, agy and grok (`--disable-slash-commands`, grok `--verbatim`): send messages as text without expanding skills or slash commands. On claude it also removes /compact, so autoCompactPercent cannot compact.',
  },
  trustProject: {
    type: 'boolean',
    description:
      "grok engine only (`--trust`): trust the working directory, loading its AGENTS.md, skills, MCP servers and hooks, which headless grok otherwise skips. Hooks run commands; the caller's decision.",
  },
  codexConfig: {
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
    description:
      'codex and codex-app: config overrides, each as `-c key=value` (TOML values; strings are quoted). sandbox_mode, approval_policy, approvals_reviewer and model_reasoning_effort are refused (the wrapper sets them). Overrides such as notify or mcp_servers can run commands.',
  },
  codexFeatures: {
    type: 'object',
    properties: {
      enable: { type: 'array', items: { type: 'string' } },
      disable: { type: 'array', items: { type: 'string' } },
    },
    description: 'codex and codex-app: features to turn on or off (`--enable` / `--disable`).',
  },
  ignoreRules: {
    type: 'boolean',
    description:
      'codex only: do not load execpolicy .rules files (`--ignore-rules`). codex-app refuses it (the app-server has no such flag).',
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
    description: 'OpenTelemetry: log raw API request/response bodies (debug only, sets OTEL_LOG_RAW_API_BODIES=1)',
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
      "Resume an earlier conversation by the engine's own id instead of starting fresh: a Claude Code session id (`--resume`), a Codex or codex-app thread id, an Antigravity conversation id, a Cursor chat id, a Grok or OpenCode session id, an ACP agent's session id, or a custom engine's id when its config maps a resume flag.",
  },
};
