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
import { getModelList, resolveEngineAndModel } from './models.js';
import type { EngineType, PermissionMode } from './types.js';

// ─── Manager surface ────────────────────────────────────────────────────────

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
}

// ─── Modes ──────────────────────────────────────────────────────────────────

/**
 * Session modes advertised to the client.
 *
 * ACP renders these as a picker, which is the natural home for "what shape of
 * orchestration should this turn use". Only `single` is dispatched today; the
 * others are declared so the surface is stable, and answer that they are not
 * wired yet rather than silently behaving like `single`.
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

/** Modes accepted by `session/set_mode` but not yet dispatched by `session/prompt`. */
const UNIMPLEMENTED_MODES = new Set(['council', 'ultraplan', 'ultrareview']);

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

      if (UNIMPLEMENTED_MODES.has(state.modeId)) {
        throw acp.RequestError.invalidParams(
          `Mode '${state.modeId}' is advertised but not dispatched yet; switch back to '${ACP_DEFAULT_MODE}'.`,
        );
      }

      const message = flattenPromptContent(ctx.params.prompt);
      if (!message.trim()) throw acp.RequestError.invalidParams('Prompt contained no text content');

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

      const turn = manager.sendMessage(state.name, message, {
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
