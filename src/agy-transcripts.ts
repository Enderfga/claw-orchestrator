/**
 * What agy's own conversation transcripts say about a turn's spend.
 *
 * agy keeps one transcript per conversation, at
 * `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`:
 * one JSON object per step, and every model request (`type: PLANNER_RESPONSE`)
 * carries the model it ran on and its `input_tokens`, `cache_read_tokens` and
 * `output_tokens`. Two things the stream's `result.usage` does not give are read
 * from there (measured on 1.5.18–1.5.19):
 *
 *  - The model each request of an orchestrator turn ran on. `gemini-pro-orchestrator*`
 *    plans on one model and executes on another (`gemini-4-neon-high`, then
 *    `gemini-4-hydrogen-high`), whatever the slug's label says. The transcript's
 *    token counts add up to the result's.
 *  - The spend of the agents a turn started: `/teamwork` members, `/swarm` workers,
 *    `/run-workflow` agents, subagents. Each runs in a conversation of its own,
 *    and none of it is in the parent's `result.usage` (a `/teamwork` turn that
 *    reported 30K input tokens had members that used 528K input, 3.2M cache-read
 *    and 124K output tokens).
 *
 * Members are found only where agy names them: a subagent step's
 * `subagent_info.subagents[].conversation_id` in the stream, an `invoke_subagent`
 * result ("Created the following subagent: {"conversationId": …}") or a `/swarm`
 * worker added (`{"status":"added",…,"conversation_id":…}`) in a transcript, and a workflow
 * agent's line in its task log (`[agent:…] …: done (<id>)`). A conversation id
 * that merely appears in a tool's output (a directory listing of the brain
 * folder) is not taken for a member.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getModelPricing } from './models.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// `invoke_subagent` names it `conversationId`, a `/swarm` worker `conversation_id`.
const CONVERSATION_FIELD_RE = new RegExp(`"conversation_?id"\\s*:\\s*"(${UUID})"`, 'gi');
const SUBAGENT_CREATED_RE = /Created the following subagents?:/;
const SWARM_ADDED_RE = /"status"\s*:\s*"added"/;
const WORKFLOW_AGENT_RE = new RegExp(`\\[agent:[^\\]\\n]*\\][^\\n]*\\((${UUID})\\)`, 'gi');

/** Members followed per session; a run that names more is counted up to here. */
const MAX_MEMBERS = 500;
/** A transcript larger than this is not read (its spend goes uncounted, and the log says so). */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** agy's per-conversation folder root. */
export function agyBrainDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
}

export function agyTranscriptPath(conversationId: string, brainDir = agyBrainDir()): string {
  return path.join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

/** The brain folder a `log_uri` (`file:///…/brain/<id>/.system_generated/logs/transcript.jsonl`) is in. */
export function agyBrainDirOf(logUri: string): string | undefined {
  const m = /^file:\/\/(\/.+)\/[^/]+\/\.system_generated\/logs\/transcript\.jsonl$/.exec(logUri);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** One model request a transcript records. */
export interface AgyRequest {
  step: number;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface AgyTranscript {
  requests: AgyRequest[];
  /** Conversations this one started, as its tool results name them. */
  members: string[];
}

/** Read a transcript; undefined when it is missing, unreadable or too large. */
export function readAgyTranscript(file: string): AgyTranscript | undefined {
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) return undefined;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return parseAgyTranscript(text);
}

export function parseAgyTranscript(text: string): AgyTranscript {
  const requests: AgyRequest[] = [];
  const members = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const step = typeof e.step_index === 'number' ? e.step_index : -1;
    if (e.type === 'PLANNER_RESPONSE' && (e.input_tokens !== undefined || e.output_tokens !== undefined)) {
      requests.push({
        step,
        ...(typeof e.model === 'string' ? { model: e.model } : {}),
        inputTokens: num(e.input_tokens),
        cacheReadTokens: num(e.cache_read_tokens),
        outputTokens: num(e.output_tokens),
      });
    }
    const content = typeof e.content === 'string' ? e.content : '';
    if (e.source !== 'SYSTEM' && (SUBAGENT_CREATED_RE.test(content) || SWARM_ADDED_RE.test(content))) {
      for (const m of content.matchAll(CONVERSATION_FIELD_RE)) members.add(m[1].toLowerCase());
    }
  }
  return { requests, members: [...members] };
}

/** The workflow agents a conversation's `/run-workflow` task logs name. */
export function agyWorkflowMembers(conversationId: string, brainDir = agyBrainDir()): string[] {
  const dir = path.join(brainDir, conversationId, '.system_generated', 'tasks');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(WORKFLOW_AGENT_RE)) out.add(m[1].toLowerCase());
  }
  return [...out];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The registry id a transcript's model is priced as: agy names a request's model
 * with its effort and, for the team tier, `-tiered` (`gemini-4-hydrogen-tiered-high`,
 * `gemini-3.8-flash-low`, `claude-opus-5-5-high`).
 */
export function agyPricedModel(model: string): string {
  return model.replace(/-(low|medium|high|xhigh)$/, '').replace(/-tiered$/, '');
}

/** What some requests cost, each at its own model's rates. agy's input count leaves cache reads out. */
export function priceAgyRequests(requests: readonly AgyRequest[], fallbackModel: string): number {
  let usd = 0;
  for (const r of requests) {
    const p = getModelPricing(r.model ? agyPricedModel(r.model) : fallbackModel, fallbackModel);
    usd += (r.inputTokens * p.input + r.cacheReadTokens * (p.cached ?? 0) + r.outputTokens * p.output) / 1_000_000;
  }
  return usd;
}

export interface AgySpend {
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  /** Conversations that contributed. */
  conversations: number;
}

/**
 * The spend of the agents a session's turns started, counted once: each member's
 * transcript is read up to the last request counted, so a member still working
 * when one turn ends is counted further by the next.
 */
export class AgyMemberSpend {
  /** Member → the step of its last request counted. */
  private readonly _counted = new Map<string, number>();
  private _truncated = false;

  constructor(
    private readonly fallbackModel: string,
    private readonly log?: (message: string) => void,
  ) {}

  /** Members known so far. */
  get members(): string[] {
    return [...this._counted.keys()];
  }

  /**
   * Find the members `parent` and the given ones started, follow theirs in turn,
   * and return what they spent since the last call.
   */
  collect(parent: string, named: readonly string[], brainDir = agyBrainDir()): AgySpend {
    const spend: AgySpend = { tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd: 0, conversations: 0 };
    const queue: string[] = [];
    const seen = new Set<string>([parent.toLowerCase()]);
    const add = (id: string) => {
      const key = id.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      if (!this._counted.has(key)) {
        if (this._counted.size >= MAX_MEMBERS) {
          if (!this._truncated) {
            this._truncated = true;
            this.log?.(`[agy] more than ${MAX_MEMBERS} member conversations; the spend of the rest is not counted`);
          }
          return;
        }
        this._counted.set(key, -1);
      }
      queue.push(key);
    };
    const own = readAgyTranscript(agyTranscriptPath(parent, brainDir));
    for (const id of [...named, ...(own?.members ?? []), ...agyWorkflowMembers(parent, brainDir)]) add(id);
    for (const id of this._counted.keys()) add(id);
    while (queue.length) {
      const id = queue.shift()!;
      const t = readAgyTranscript(agyTranscriptPath(id, brainDir));
      if (!t) continue;
      for (const m of [...t.members, ...agyWorkflowMembers(id, brainDir)]) add(m);
      const from = this._counted.get(id) ?? -1;
      const fresh = t.requests.filter((r) => r.step > from);
      if (!fresh.length) continue;
      this._counted.set(id, Math.max(from, ...fresh.map((r) => r.step)));
      spend.conversations++;
      for (const r of fresh) {
        spend.tokensIn += r.inputTokens;
        spend.cachedTokens += r.cacheReadTokens;
        spend.tokensOut += r.outputTokens;
      }
      spend.costUsd += priceAgyRequests(fresh, this.fallbackModel);
    }
    return spend;
  }
}
