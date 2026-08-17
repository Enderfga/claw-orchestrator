/**
 * Agent Client Protocol (ACP) adapter — claw-orchestrator as an ACP *agent*.
 *
 * ACP is the editor↔coding-agent standard (Zed, JetBrains, Neovim, Emacs, the
 * VS Code ACP extension all speak it as clients; `dsh`'s `subagent-acp` provider
 * spawns an arbitrary ACP server as a subagent). Every agent in the ecosystem is
 * a single agent; this one is a fleet, so pointing any of those clients at it
 * gives them a cross-engine session they cannot get anywhere else.
 *
 * This module is the protocol adapter only — it owns translation, not transport.
 * `bin/acp-server.ts` supplies the stdio stream and a stderr-only logger. The
 * split, the module-private structural `SessionManagerLike`, and the
 * "exported pure helpers, testable without a process" shape all mirror
 * `src/openai-compat.ts`, which is the same kind of adapter over the same
 * manager.
 *
 * Built against **stable ACP v1** (`@agentclientprotocol/sdk` 1.3.0). ACP v2 is
 * a published draft whose wire protocol may change incompatibly in any SDK
 * release, so it is deliberately not used.
 */

import * as acp from '@agentclientprotocol/sdk';

import { ACP_SESSION_PREFIX } from './constants.js';
import type { Logger } from './logger.js';
import { getContextWindow, getModelList, resolveEngineAndModel } from './models.js';
import type { CouncilConfig, CouncilEvent, CouncilSession, EngineType, PermissionMode } from './types.js';

// ─── Manager surface ────────────────────────────────────────────────────────

/**
 * The shape ultraplan and ultrareview status calls have in common.
 *
 * They are separate result types upstream (`plan` vs `findings`), but this
 * adapter polls them identically, so one optional-superset avoids branching the
 * poll loop on which mode is running.
 */
interface OrchestrationSnapshot {
  status: string;
  plan?: string;
  findings?: string;
  error?: string;
}

/**
 * SessionManager-like interface to avoid circular imports.
 *
 * Structural, so the real `SessionManager` satisfies it without declaring
 * anything, and a test can pass a small object literal. Same technique as
 * `openai-compat.ts`.
 */
interface SessionManagerLike {
  startSession(config: Record<string, unknown>): Promise<{ name: string }>;
  sendMessage(
    name: string,
    message: string,
    options?: {
      onChunk?: (chunk: string) => void;
      onEvent?: (event: { type: string; tool?: { name?: string; input?: unknown }; result?: string }) => void;
    },
  ): Promise<{ output: string; sessionId?: string }>;
  stopSession(name: string): Promise<void>;
  getStatus?(name: string): { stats: { contextPercent?: number } };
  getCost?(name: string): { totalUsd?: number };

  councilStart?(task: string, config: CouncilConfig): CouncilSession;
  councilStatus?(id: string): CouncilSession | undefined;
  councilAbort?(id: string): void;
  councilAccept?(id: string): Promise<unknown>;
  councilReject?(id: string, feedback: string): Promise<unknown>;
  getCouncil?(id: string): { on(event: string, cb: (e: CouncilEvent) => void): unknown } | undefined;

  ultraplanStart?(task: string, opts?: { model?: string; cwd?: string; timeout?: number }): { id: string };
  ultraplanStatus?(id: string): OrchestrationSnapshot | undefined;
  ultrareviewStart?(cwd: string, opts?: { focus?: string; agentCount?: number }): { id: string };
  ultrareviewStatus?(id: string): OrchestrationSnapshot | undefined;
}

// ─── Modes ──────────────────────────────────────────────────────────────────

/**
 * Session modes advertised to the client.
 *
 * This is the natural home for "what shape of orchestration should this turn
 * use", and it is the whole point of this agent: a single-engine agent has
 * nothing to put here.
 *
 * Whether a client surfaces them is up to the client, though — measured against
 * the VS Code ACP extension 0.2.0, which renders config options but not modes.
 * So every mode also gets a slash command; see ACP_MODE_COMMANDS.
 */
export const ACP_MODES: acp.SessionMode[] = [
  {
    id: 'single',
    name: 'Single agent',
    description: 'One engine answers the turn. The default, and the fastest.',
  },
  {
    id: 'council',
    name: 'Council',
    description: 'Several engines debate in isolated git worktrees and vote on a result.',
  },
  {
    id: 'ultraplan',
    name: 'Ultraplan',
    description: 'Long-horizon planning pass; produces a plan rather than edits.',
  },
  {
    id: 'ultrareview',
    name: 'Ultrareview',
    description: 'Parallel reviewers sweep the working tree and a synthesis pass merges findings.',
  },
];

export const ACP_DEFAULT_MODE = 'single';

/**
 * Council defaults for the ACP path, deliberately far below the library's own.
 *
 * `getDefaultCouncilConfig` is tuned for a long unattended run: three agents,
 * fifteen rounds, a thirty-minute per-agent timeout, and one session spawned per
 * agent *per round*. Behind an editor turn that is the wrong shape entirely — a
 * client is waiting — so the ACP path uses two agents on distinct engines and
 * three rounds. It also names engines explicitly rather than inheriting the
 * library defaults, which still reference the retired Gemini CLI.
 */
export const ACP_COUNCIL_MAX_ROUNDS = 3;
const ACP_COUNCIL_AGENTS = [
  {
    name: 'Builder',
    emoji: '🟠',
    engine: 'claude' as EngineType,
    persona:
      'You are an implementation engineer. Propose the smallest correct change that satisfies the task, and say plainly what you are unsure of rather than papering over it.',
  },
  {
    name: 'Critic',
    emoji: '🟢',
    engine: 'codex' as EngineType,
    persona:
      'You are an independent quality gate. Do not assume the other agent is right — look for cases where the proposal breaks, and give either a blocking issue list or a reasoned approval.',
  },
];

/** How often the poll-only orchestrations are checked, and how long they may run. */
const ACP_POLL_INTERVAL_MS = 3_000;
const ACP_POLL_TIMEOUT_MS = 1_800_000;

/** Slash commands offered once a council run is parked at its human gate. */
export const ACP_COUNCIL_COMMANDS = [
  { name: 'council_accept', description: 'Accept the council result and merge the winning agent worktree.' },
  { name: 'council_reject', description: 'Reject the council result. Text after the command is passed as feedback.' },
];

/**
 * One slash command per mode, so modes are reachable in clients that do not
 * render the mode picker.
 *
 * `session/new` returns the mode list and ACP defines `session/set_mode`, but
 * whether a client surfaces either is up to the client — the VS Code ACP
 * extension renders config options and not modes, so without these the
 * orchestration modes would be unreachable there. Text after the command runs
 * immediately in that mode, which is a better interaction than a picker anyway:
 * `/council fix the failing test` is one step, not three.
 */
export const ACP_MODE_COMMANDS = ACP_MODES.map((mode) => ({
  name: mode.id,
  description: `${mode.description} Text after the command runs in this mode straight away.`,
}));

// ─── Config options ─────────────────────────────────────────────────────────

export const ACP_CONFIG_MODEL = 'model';
export const ACP_CONFIG_PERMISSION = 'permission';

/** Human-facing group label per engine, used by the model selector. */
const ENGINE_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  'codex-app': 'Codex (app-server)',
  agy: 'Antigravity',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  custom: 'Custom',
};

/**
 * Engines kept out of the picker.
 *
 * `gemini` still works for callers that already name it, but the Gemini CLI is
 * sunset and superseded by Antigravity, so offering it in a new user-facing
 * selector would be advertising a dead end.
 *
 * `opencode` is absent for a different reason: its models are open-ended
 * `provider/model` strings passed straight through, so there is nothing in the
 * registry to enumerate. An opencode session is reachable by naming the model
 * at session start, just not by picking it from this list.
 */
const HIDDEN_ENGINES = new Set<string>(['gemini']);

/**
 * The cross-engine model selector, grouped by engine.
 *
 * This is the cheapest thing that is impossible for a single-engine ACP agent:
 * one dropdown in the editor holding Claude, GPT, Composer and OpenCode models
 * at once. The values come from the shared registry in `models.ts`, so a model
 * added there shows up here with no extra wiring.
 */
export function buildModelConfigOption(currentModel: string): acp.SessionConfigOption {
  const groups = new Map<string, acp.SessionConfigSelectOption[]>();
  for (const entry of getModelList().data) {
    const { engine } = resolveEngineAndModel(entry.id);
    if (HIDDEN_ENGINES.has(engine)) continue;
    const bucket = groups.get(engine) ?? [];
    bucket.push({ value: entry.id, name: entry.id, description: entry.owned_by });
    groups.set(engine, bucket);
  }

  return {
    type: 'select',
    id: ACP_CONFIG_MODEL,
    name: 'Model',
    description: 'Model for this session. Switching model switches engine with it.',
    category: 'model',
    currentValue: currentModel,
    options: [...groups.entries()].map(([engine, options]) => ({
      group: engine,
      name: ENGINE_LABELS[engine] ?? engine,
      options,
    })),
  };
}

/**
 * Permission selector.
 *
 * ACP has `session/request_permission` for asking the user mid-turn, but nothing
 * in this codebase can surface such a request: permission is resolved once into
 * engine CLI flags at session start, and `permissionPromptTool` routes to an MCP
 * tool the caller hosts rather than back through the manager. Offering a
 * per-turn prompt we cannot honour would be worse than saying so, so the choice
 * is made up-front instead — which also suits `dsh-subagent-acp`, whose default
 * is to auto-reject permission requests.
 */
export function buildPermissionConfigOption(current: PermissionMode): acp.SessionConfigOption {
  return {
    type: 'select',
    id: ACP_CONFIG_PERMISSION,
    name: 'Permission',
    description: 'How much the agent may do without asking. Chosen up-front, not per turn.',
    currentValue: current,
    options: [
      { value: 'plan', name: 'Plan (read-only)', description: 'Investigate and propose; never writes.' },
      { value: 'acceptEdits', name: 'Accept edits', description: 'May edit files in the workspace.' },
      { value: 'bypassPermissions', name: 'Full access', description: 'No prompts. Use in trusted workspaces.' },
    ],
  };
}

// ─── Session state ──────────────────────────────────────────────────────────

interface AcpSessionState {
  /** Name of the underlying orchestrator session. */
  name: string;
  cwd: string;
  model: string;
  engine: EngineType;
  permissionMode: PermissionMode;
  modeId: string;
  /** Settles the in-flight prompt as cancelled; see `cancel()`. */
  cancelInFlight?: () => void;
  /** Council run parked at its human gate, awaiting /council_accept or /council_reject. */
  parkedCouncilId?: string;
}

/** Parse a leading slash command out of a prompt. */
export function parseSlashCommand(message: string): { name: string; rest: string } | null {
  const match = /^\/([a-z_]+)\s*([\s\S]*)$/.exec(message.trim());
  return match ? { name: match[1], rest: match[2].trim() } : null;
}

/** `session/new` ids are ours to mint; keep them short, opaque and prefixed. */
function mintSessionId(): string {
  return `${ACP_SESSION_PREFIX}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Concatenate the text blocks of a prompt into one user message. */
export function flattenPromptContent(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; text?: string; uri?: string; name?: string };
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    // A resource link is flattened to a textual reference the model may open
    // with its own tools; we do not fetch it on the model's behalf.
    else if (b?.type === 'resource_link' && b.uri) parts.push(`[resource_link name=${b.name ?? ''} uri=${b.uri}]`);
  }
  return parts.join('');
}

// ─── Agent ──────────────────────────────────────────────────────────────────

export interface AcpAgentOptions {
  /** Model for a session that does not pick one. */
  defaultModel?: string;
  /** Permission mode for a session that does not pick one. */
  defaultPermissionMode?: PermissionMode;
  logger?: Logger;
}

/**
 * Build the ACP agent over a SessionManager.
 *
 * Returns the configured `AgentApp` without connecting it, so a test can drive
 * the handlers directly and `bin/acp-server.ts` owns the stdio stream.
 */
export function createAcpAgent(manager: SessionManagerLike, options: AcpAgentOptions = {}): acp.AgentApp {
  const sessions = new Map<string, AcpSessionState>();
  const defaultModel = options.defaultModel || 'claude-sonnet-4-6';
  const defaultPermissionMode: PermissionMode = options.defaultPermissionMode || 'acceptEdits';
  const log = options.logger;

  const stateFor = (sessionId: string): AcpSessionState => {
    const state = sessions.get(sessionId);
    if (!state) throw acp.RequestError.invalidParams(`Unknown session: ${sessionId}`);
    return state;
  };

  return acp
    .agent({ name: 'claw-orchestrator' })

    .onRequest('initialize', () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        // Resume is deliberately not advertised: mapping an ACP session id onto
        // each engine's own resume handle (codex thread id, agy's log-harvested
        // conversation id, cursor/opencode session ids) is its own piece of work,
        // and claiming the capability without it would strand a client.
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    }))

    .onRequest('authenticate', () => ({}))

    .onRequest('session/new', async (ctx) => {
      const cwd = ctx.params.cwd;
      if (!cwd || !cwd.startsWith('/')) {
        throw acp.RequestError.invalidParams('cwd must be an absolute path');
      }
      const sessionId = mintSessionId();
      const { engine, model } = resolveEngineAndModel(defaultModel);

      await manager.startSession({
        name: sessionId,
        cwd,
        engine,
        model,
        permissionMode: defaultPermissionMode,
        skipPersistence: true,
      });

      sessions.set(sessionId, {
        name: sessionId,
        cwd,
        model,
        engine,
        permissionMode: defaultPermissionMode,
        modeId: ACP_DEFAULT_MODE,
      });
      log?.info(`session/new ${sessionId} engine=${engine} model=${model} cwd=${cwd}`);

      // Advertise the mode commands once the client knows this session exists.
      // Notifying before returning would reference a sessionId the client has
      // not been told about yet, so this is deferred past the response write.
      setTimeout(() => {
        void ctx.client
          .notify('session/update', {
            sessionId,
            update: { sessionUpdate: 'available_commands_update', availableCommands: ACP_MODE_COMMANDS },
          })
          .catch(() => {});
      }, 0);

      return {
        sessionId,
        modes: { currentModeId: ACP_DEFAULT_MODE, availableModes: ACP_MODES },
        configOptions: [buildModelConfigOption(model), buildPermissionConfigOption(defaultPermissionMode)],
      } as acp.NewSessionResponse;
    })

    .onRequest('session/set_mode', (ctx) => {
      const state = stateFor(ctx.params.sessionId);
      const mode = ACP_MODES.find((m) => m.id === ctx.params.modeId);
      if (!mode) throw acp.RequestError.invalidParams(`Unknown mode: ${ctx.params.modeId}`);
      state.modeId = mode.id;
      return {};
    })

    .onRequest('session/set_config_option', async (ctx) => {
      const state = stateFor(ctx.params.sessionId);
      const value = String(ctx.params.value ?? '');

      if (ctx.params.configId === ACP_CONFIG_MODEL) {
        const { engine, model } = resolveEngineAndModel(value);
        // Engine is fixed at spawn time, so a model that changes engine has to
        // be a new underlying session. The ACP session id is unaffected.
        await manager.stopSession(state.name).catch(() => {});
        await manager.startSession({
          name: state.name,
          cwd: state.cwd,
          engine,
          model,
          permissionMode: state.permissionMode,
          skipPersistence: true,
        });
        state.engine = engine;
        state.model = model;
      } else if (ctx.params.configId === ACP_CONFIG_PERMISSION) {
        state.permissionMode = value as PermissionMode;
        await manager.stopSession(state.name).catch(() => {});
        await manager.startSession({
          name: state.name,
          cwd: state.cwd,
          engine: state.engine,
          model: state.model,
          permissionMode: state.permissionMode,
          skipPersistence: true,
        });
      } else {
        throw acp.RequestError.invalidParams(`Unknown config option: ${ctx.params.configId}`);
      }

      return {
        configOptions: [buildModelConfigOption(state.model), buildPermissionConfigOption(state.permissionMode)],
      };
    })

    .onRequest('session/prompt', async (ctx) => {
      const state = stateFor(ctx.params.sessionId);
      const sessionId = ctx.params.sessionId;

      const message = flattenPromptContent(ctx.params.prompt);
      if (!message.trim()) throw acp.RequestError.invalidParams('Prompt contained no text content');

      const emit = (update: Record<string, unknown>) => ctx.client.notify('session/update', { sessionId, update });
      const say = (text: string) => emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

      // A parked council owns the turn until it is accepted or rejected: any
      // other prompt would start a second run over the same worktrees.
      const command = parseSlashCommand(message);
      if (state.parkedCouncilId) {
        const decided = await resolveParkedCouncil(manager, state, command, say, emit);
        if (decided) return { stopReason: 'end_turn' as const };
      } else if (command && command.name.startsWith('council_')) {
        throw acp.RequestError.invalidParams('No council is awaiting a decision.');
      }

      // `/council`, `/ultraplan`, … switch mode, and run the rest of the line in
      // it when there is one. This is the only way to reach a mode in a client
      // that does not render the picker.
      let task = message;
      if (command && ACP_MODES.some((m) => m.id === command.name)) {
        state.modeId = command.name;
        await emit({ sessionUpdate: 'current_mode_update', currentModeId: command.name });
        if (!command.rest) {
          const mode = ACP_MODES.find((m) => m.id === command.name);
          await say(`Switched to **${mode?.name}**. ${mode?.description ?? ''}`);
          return { stopReason: 'end_turn' as const };
        }
        task = command.rest;
      }

      if (state.modeId === 'council') {
        return runCouncilMode(manager, state, sessionId, task, emit, say, log);
      }
      if (state.modeId === 'ultraplan' || state.modeId === 'ultrareview') {
        return runPollingMode(manager, state, task, emit, say);
      }

      // There is no mid-turn cancel in the session layer, so cancellation is
      // modelled here: the prompt races a settle-on-cancel promise, and the
      // underlying session is torn down separately. The turn returns promptly
      // even though the engine subprocess may take a moment longer to die.
      let cancelled = false;
      const cancelSignal = new Promise<'cancelled'>((resolve) => {
        state.cancelInFlight = () => {
          cancelled = true;
          resolve('cancelled');
        };
      });

      // `sendMessage` reports the whole answer as its return value AND streams it
      // through `onChunk` for engines that have a delta channel. Emitting both
      // would send the answer twice, so the final block is only emitted when
      // nothing streamed — which is the case for one-shot wrappers.
      let streamedChars = 0;

      const turn = manager.sendMessage(state.name, task, {
        onChunk: (chunk: string) => {
          if (cancelled || !chunk) return;
          streamedChars += chunk.length;
          void ctx.client.notify('session/update', {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
          });
        },
        onEvent: (event) => {
          if (cancelled) return;
          if (event.type === 'tool_use' && event.tool?.name) {
            void ctx.client.notify('session/update', {
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `${sessionId}-${event.tool.name}-${Date.now()}`,
                title: event.tool.name,
                kind: 'other',
                status: 'in_progress',
                rawInput: (event.tool.input ?? {}) as Record<string, unknown>,
              },
            });
          }
        },
      });

      try {
        const raced = await Promise.race([turn, cancelSignal]);
        if (raced === 'cancelled') return { stopReason: 'cancelled' };

        // Engines that never stream (one-shot wrappers with no delta channel)
        // still have to deliver something, and the text stream is the only
        // channel some consumers read — dsh's ACP subagent collects nothing else.
        const output = (raced as { output: string }).output ?? '';
        if (output && streamedChars === 0) {
          await ctx.client.notify('session/update', {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } },
          });
        }
        await emitUsage(manager, state, emit);
        return { stopReason: 'end_turn' };
      } catch (err) {
        if (cancelled) return { stopReason: 'cancelled' };
        throw err;
      } finally {
        state.cancelInFlight = undefined;
      }
    })

    .onNotification('session/cancel', (ctx) => {
      const state = sessions.get(ctx.params.sessionId);
      if (!state) return;
      state.cancelInFlight?.();
      // Best-effort teardown. `stopSession` is the only lever the session layer
      // offers, and it destroys the session rather than pausing the turn, so the
      // session is recreated lazily on the next prompt.
      void manager
        .stopSession(state.name)
        .then(() =>
          manager.startSession({
            name: state.name,
            cwd: state.cwd,
            engine: state.engine,
            model: state.model,
            permissionMode: state.permissionMode,
            skipPersistence: true,
          }),
        )
        .catch((err) => log?.warn(`cancel teardown failed for ${state.name}: ${String(err)}`));
    });
}

// ─── Orchestration modes ────────────────────────────────────────────────────

type Emit = (update: Record<string, unknown>) => Promise<void>;
type Say = (text: string) => Promise<void>;

/**
 * Run a council behind one ACP turn.
 *
 * The council emits progress on an EventEmitter and parks at a human gate rather
 * than finishing, so the translation is not a straight pipe:
 *
 * - Each agent becomes a `tool_call` the client can collapse, so an editor shows
 *   who is thinking and how far along they are.
 * - Agent deltas are buffered per agent and delivered on that agent's
 *   `tool_call_update`, NOT streamed into `agent_message_chunk`. Several agents
 *   speak at once, and a consumer that only reads the text stream — `dsh`'s ACP
 *   subagent reads nothing else — would receive them interleaved into one
 *   unreadable blob.
 * - Only the synthesis reaches the text stream, which keeps that stream
 *   self-sufficient without making it a transcript of everyone at once.
 */
async function runCouncilMode(
  manager: SessionManagerLike,
  state: AcpSessionState,
  sessionId: string,
  task: string,
  emit: Emit,
  say: Say,
  log?: Logger,
): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'refusal' }> {
  if (!manager.councilStart || !manager.getCouncil || !manager.councilStatus) {
    throw acp.RequestError.internalError('Council is not available on this manager');
  }

  let council: CouncilSession;
  try {
    council = manager.councilStart(task, {
      name: 'ACP Council',
      agents: ACP_COUNCIL_AGENTS.map((a) => ({ ...a, permissionMode: state.permissionMode })),
      maxRounds: ACP_COUNCIL_MAX_ROUNDS,
      projectDir: state.cwd,
      defaultPermissionMode: state.permissionMode,
    });
  } catch (err) {
    // Council refuses to run outside a git repo, on a too-short task, and on a
    // few other guardrails. Those are the caller's problem to fix, so report the
    // reason rather than a bare failure.
    throw acp.RequestError.invalidParams(`Council could not start: ${(err as Error).message}`);
  }

  const buffers = new Map<string, string>();
  const toolCallId = (agent: string, round?: number) => `${sessionId}-${agent}-r${round ?? 0}`;
  const emitter = manager.getCouncil(council.id);

  let poll: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const terminal = new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      // Clear here rather than after the await: the backstop poll and the
      // 30-minute cap must stop the moment the run is over, or every council
      // turn leaves a live timer behind for the rest of the process's life.
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
      resolve();
    };

    emitter?.on('council-event', (event: CouncilEvent) => {
      const agent = event.agent ?? 'agent';
      switch (event.type) {
        case 'round-start':
          void emit({
            sessionUpdate: 'plan',
            entries: ACP_COUNCIL_AGENTS.map((a) => ({
              content: `Round ${event.round ?? 1}: ${a.name} (${a.engine})`,
              priority: 'medium',
              status: 'in_progress',
            })),
          });
          break;
        case 'agent-start':
          buffers.set(toolCallId(agent, event.round), '');
          void emit({
            sessionUpdate: 'tool_call',
            toolCallId: toolCallId(agent, event.round),
            title: `${agent} — round ${event.round ?? 1}`,
            kind: 'think',
            status: 'in_progress',
          });
          break;
        case 'agent-chunk': {
          const id = toolCallId(agent, event.round);
          buffers.set(id, (buffers.get(id) ?? '') + (event.content ?? ''));
          break;
        }
        case 'agent-complete': {
          const id = toolCallId(agent, event.round);
          void emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: id,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: buffers.get(id) || '(no output)' } }],
          });
          break;
        }
        case 'error':
          log?.warn(`council ${council.id} error: ${event.error ?? 'unknown'}`);
          done();
          break;
        case 'complete':
          done();
          break;
        default:
          break;
      }
    });

    // The emitter is live-only with no replay buffer, and a run that finishes
    // before the first listener attaches would never resolve. Polling the status
    // is the backstop; it is also how the parked state is detected, because
    // parking is a status, not an event.
    poll = setInterval(() => {
      const snapshot = manager.councilStatus?.(council.id);
      if (snapshot && snapshot.status !== 'running') done();
    }, ACP_POLL_INTERVAL_MS);

    timeout = setTimeout(() => {
      manager.councilAbort?.(council.id);
      done();
    }, ACP_POLL_TIMEOUT_MS);

    state.cancelInFlight = () => {
      manager.councilAbort?.(council.id);
      done();
    };
  });

  await terminal;
  state.cancelInFlight = undefined;

  const final = manager.councilStatus(council.id);
  const summary = final?.finalSummary?.trim();
  await say(summary || `Council finished with status '${final?.status ?? 'unknown'}' and produced no summary.`);

  // Consensus parks the run for a human decision rather than completing it, so
  // the ACP turn ends at the gate and the decision becomes a slash command.
  if (final?.status === 'awaiting_user') {
    state.parkedCouncilId = council.id;
    await emit({ sessionUpdate: 'available_commands_update', availableCommands: ACP_COUNCIL_COMMANDS });
    await say(
      '\n\nThe council reached consensus and is holding its worktrees for you. ' +
        'Send `/council_accept` to merge the result, or `/council_reject <feedback>` to discard it.',
    );
  }

  return { stopReason: final?.status === 'error' ? 'refusal' : 'end_turn' };
}

/**
 * Run one of the poll-only orchestrations (ultraplan, ultrareview).
 *
 * Neither emits events — they return a handle and are polled — so progress is
 * reported as periodic thought chunks and the result arrives as both a `plan`
 * update and text. Ultraplan in particular has no abort path at all, so
 * cancelling here abandons the poll rather than stopping the work.
 */
async function runPollingMode(
  manager: SessionManagerLike,
  state: AcpSessionState,
  task: string,
  emit: Emit,
  say: Say,
): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'refusal' }> {
  const isPlan = state.modeId === 'ultraplan';
  const started = isPlan
    ? manager.ultraplanStart?.(task, { cwd: state.cwd, model: state.model })
    : manager.ultrareviewStart?.(state.cwd, { focus: task });
  if (!started) throw acp.RequestError.internalError(`Mode '${state.modeId}' is not available on this manager`);

  const readStatus = () => (isPlan ? manager.ultraplanStatus?.(started.id) : manager.ultrareviewStatus?.(started.id));

  let cancelled = false;
  state.cancelInFlight = () => {
    cancelled = true;
  };

  const deadline = Date.now() + ACP_POLL_TIMEOUT_MS;
  let snapshot = readStatus();
  while (snapshot?.status === 'running' && Date.now() < deadline && !cancelled) {
    await new Promise((r) => setTimeout(r, ACP_POLL_INTERVAL_MS));
    snapshot = readStatus();
    await emit({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '.' },
    });
  }
  state.cancelInFlight = undefined;

  if (cancelled) return { stopReason: 'cancelled' };

  const body = (isPlan ? snapshot?.plan : snapshot?.findings) ?? '';
  if (snapshot?.status === 'error' || !body) {
    await say(snapshot?.error ? `${state.modeId} failed: ${snapshot.error}` : `${state.modeId} produced no output.`);
    return { stopReason: 'refusal' };
  }

  await emit({
    sessionUpdate: 'plan',
    entries: [{ content: body.slice(0, 500), priority: 'high', status: 'completed' }],
  });
  await say(body);
  return { stopReason: 'end_turn' };
}

/**
 * Apply `/council_accept` or `/council_reject` to a parked run.
 *
 * Returns true when the prompt was a decision and the turn is finished.
 */
export async function resolveParkedCouncil(
  manager: SessionManagerLike,
  state: AcpSessionState,
  command: { name: string; rest: string } | null,
  say: Say,
  emit: Emit,
): Promise<boolean> {
  const id = state.parkedCouncilId;
  if (!id || !command) return false;

  if (command.name === 'council_accept') {
    await manager.councilAccept?.(id);
    await say('Council result accepted; the winning worktree has been merged.');
  } else if (command.name === 'council_reject') {
    await manager.councilReject?.(id, command.rest || 'rejected via ACP');
    await say('Council result rejected and its worktrees discarded.');
  } else {
    return false;
  }

  state.parkedCouncilId = undefined;
  // Restore the mode commands rather than clearing: the gate commands replaced
  // them while the run was parked, and an empty list would leave the client with
  // no way to reach any mode again.
  await emit({ sessionUpdate: 'available_commands_update', availableCommands: ACP_MODE_COMMANDS });
  return true;
}

/**
 * Report context occupancy and cumulative cost to the client.
 *
 * ACP wants absolute token counts; the session layer exposes a percentage and a
 * window, so `used` is derived from the two. That is the honest reading — the
 * percentage is what the engines actually report, and reconstructing a token
 * count from it is lossy in the last digit but not in the shape.
 *
 * Cost is the cross-engine total, which is the number worth showing here: a
 * session that switched from Claude to Codex mid-way has spent on both, and no
 * single-engine agent can report that.
 */
async function emitUsage(manager: SessionManagerLike, state: AcpSessionState, emit: Emit): Promise<void> {
  try {
    const percent = manager.getStatus?.(state.name)?.stats?.contextPercent ?? 0;
    const size = getContextWindow(state.model);
    const cost = manager.getCost?.(state.name)?.totalUsd;
    if (!size) return;
    await emit({
      sessionUpdate: 'usage_update',
      used: Math.round((size * percent) / 100),
      size,
      ...(typeof cost === 'number' ? { cost: { amount: cost, currency: 'USD' } } : {}),
    });
  } catch {
    // Usage is decoration. A manager that cannot report it must not break a turn.
  }
}
