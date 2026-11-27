/**
 * Who is on a run's forum, and which forum a run's runtime writes to.
 *
 * Each mode contributes its members to the roster under names it derives the
 * same way here and where it joins; the helpers below are those names, so a
 * mode and the roster cannot drift apart.
 */

import { loadRun } from '../store.js';
import type { NodeSpec, RunRecord, SubflowNode, WorkflowSpec } from '../types.js';
import { isForumName, isReservedForumName, normalizeForumConfig, type ForumConfig, type ForumMember } from './types.js';

/** The three roles of an autoloop node, as forum members. */
export const AUTOLOOP_FORUM_ROLES = ['planner', 'coder', 'reviewer'] as const;
export type AutoloopForumRole = (typeof AUTOLOOP_FORUM_ROLES)[number];

/**
 * A node id as the first part of a member name. A forum name starts with a
 * letter or digit, so the leading `_` of the implicit verifier (`__verify`) is
 * dropped.
 */
function namePrefix(nodeId: string): string {
  return nodeId.replace(/^[^A-Za-z0-9]+/, '');
}

/** The member a verifier's fix session is on the forum as: `<nodeId>.fix`. */
export function fixerForumName(nodeId: string): string {
  const head = namePrefix(nodeId);
  return head ? `${head}.fix` : 'fix';
}

/** What a subflow's child run puts in front of its member names: `<subflowId>.`. */
export function subflowForumPrefix(nodeId: string): string {
  const head = namePrefix(nodeId);
  return head ? `${head}.` : '';
}

/**
 * The member a fan-out's synthesis pass is on the forum as: `synthesis` when it
 * is the only fan-out of the spec that synthesises, `<nodeId>.synthesis` otherwise.
 */
export function synthesisForumName(spec: WorkflowSpec, nodeId: string): string {
  const synthesising = spec.nodes.filter((n) => n.kind === 'fanout' && n.synthesize);
  if (synthesising.length <= 1) return 'synthesis';
  const head = namePrefix(nodeId);
  return head ? `${head}.synthesis` : 'synthesis';
}

/** The names every member other than the autoloop roles takes, in node order. */
function baseNames(spec: WorkflowSpec, opts: ForumRosterOptions): string[] {
  return spec.nodes.flatMap((n) => (n.kind === 'autoloop' ? [] : nodeMembers(spec, n, opts).map((m) => m.name)));
}

/**
 * The member an autoloop role is on the forum as: the role itself, or
 * `<nodeId>.<role>` when the spec has more than one autoloop node or another
 * member already has the role's name.
 */
export function autoloopForumName(spec: WorkflowSpec, nodeId: string, role: AutoloopForumRole): string {
  return autoloopPrefixed(spec, {}) ? `${namePrefix(nodeId)}.${role}` : role;
}

function autoloopPrefixed(spec: WorkflowSpec, opts: ForumRosterOptions): boolean {
  if (spec.nodes.filter((n) => n.kind === 'autoloop').length > 1) return true;
  const taken = new Set(baseNames(spec, opts));
  return AUTOLOOP_FORUM_ROLES.some((r) => taken.has(r));
}

function fixRounds(spec: WorkflowSpec, n: Extract<NodeSpec, { kind: 'verifier' }>): number {
  const contract = n.contract === 'run' ? spec.contract : n.contract;
  return contract?.fixOnFailureRounds ?? 0;
}

export interface ForumRosterOptions {
  /** The spec a subflow node runs, for one that names its workflow rather than carrying it. */
  resolveSubflow?: (node: SubflowNode) => WorkflowSpec | undefined;
}

interface NestedRosterOptions extends ForumRosterOptions {
  depth?: number;
}

const MAX_SUBFLOW_DEPTH = 8;

/**
 * Whether a council's seats can be forum members: every name a forum name, and
 * none reserved. A council whose seats cannot be is not on the roster and runs
 * log-only (`councilForumHooks`), so a spec with such a council still starts.
 */
export function councilSeatsAreForumNames(names: string[]): boolean {
  return names.every((n) => isForumName(n) && !isReservedForumName(n));
}

/** The members one node brings, with `mayReturn` relative to that node; autoloop roles excluded. */
function nodeMembers(spec: WorkflowSpec, n: NodeSpec, opts: ForumRosterOptions): Array<Omit<ForumMember, 'node'>> {
  switch (n.kind) {
    case 'fanout':
      return [
        ...n.agents.map((a) => ({ name: a.name, mayReturn: false })),
        ...(n.synthesize ? [{ name: synthesisForumName(spec, n.id), mayReturn: false }] : []),
      ];
    case 'agent':
    case 'goal':
      return [{ name: n.forumName ?? n.id, mayReturn: false }];
    case 'council': {
      const names = n.agents.map((a) => a.name);
      return councilSeatsAreForumNames(names) ? names.map((name) => ({ name, mayReturn: true })) : [];
    }
    case 'verifier':
      return fixRounds(spec, n) > 0 ? [{ name: fixerForumName(n.id), mayReturn: true }] : [];
    case 'ultraapp_synth': {
      const names = n.seats ?? [];
      return councilSeatsAreForumNames(names) ? names.map((name) => ({ name, mayReturn: true })) : [];
    }
    case 'subflow': {
      // A named workflow can name itself; a bounded depth keeps that from recursing forever.
      const depth = (opts as NestedRosterOptions).depth ?? 0;
      if (depth >= MAX_SUBFLOW_DEPTH) return [];
      const child = typeof n.workflow === 'string' ? opts.resolveSubflow?.(n) : n.workflow;
      if (!child || !Array.isArray(child.nodes)) return [];
      const prefix = subflowForumPrefix(n.id);
      const nested: NestedRosterOptions = { ...opts, depth: depth + 1 };
      return forumRoster(child, nested).map((m) => ({ name: `${prefix}${m.name}`, mayReturn: m.mayReturn }));
    }
    default:
      return [];
  }
}

/**
 * The forum's members, each with the node it runs in and whether that node is
 * on a loop. A node that is on none runs at most once per visit chain, so a
 * member whose node has finished is gone for the rest of the run. Council seats,
 * autoloop roles and a verifier's fixer work in rounds of their own node, so
 * they may always return.
 */
export function forumRoster(spec: WorkflowSpec, opts: ForumRosterOptions = {}): ForumMember[] {
  const ids = spec.nodes.map((n) => n.id);
  // Every way control can leave a node, over-approximated: a router's routes,
  // its default and the node after it; anything else, `next` or the node after.
  const out = new Map<string, string[]>();
  spec.nodes.forEach((n, i) => {
    const after = ids[i + 1];
    const to = new Set<string>();
    if (n.next) to.add(n.next);
    if (n.kind === 'router') {
      for (const r of n.routes ?? []) to.add(r.to);
      if (n.default) to.add(n.default);
      if (after) to.add(after);
    } else if (!n.next && after) {
      to.add(after);
    }
    out.set(n.id, [...to]);
  });
  const onLoop = (id: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(out.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(out.get(cur) ?? []));
    }
    return false;
  };
  const prefixRoles = spec.nodes.some((n) => n.kind === 'autoloop') && autoloopPrefixed(spec, opts);
  const members: ForumMember[] = [];
  for (const n of spec.nodes) {
    const names =
      n.kind === 'autoloop'
        ? AUTOLOOP_FORUM_ROLES.map((r) => ({ name: prefixRoles ? `${namePrefix(n.id)}.${r}` : r, mayReturn: true }))
        : nodeMembers(spec, n, opts);
    if (names.length === 0) continue;
    const loop = onLoop(n.id);
    for (const m of names) {
      if (!members.some((x) => x.name === m.name))
        members.push({ name: m.name, node: n.id, mayReturn: m.mayReturn || loop });
    }
  }
  return members;
}

/** Every agent name a spec gives the forum: fan-out agents by name, other agent and goal nodes by id. */
export function forumTeam(spec: WorkflowSpec, opts: ForumRosterOptions = {}): string[] {
  return forumRoster(spec, opts).map((m) => m.name);
}

// ─── A run's forum ──────────────────────────────────────────────────────────

/**
 * The forum a run's runtime writes to. Every kernel run has one: its own (id =
 * the run id), or the forum of the run it is bound to. `exposed` says whether
 * its agents are told about it — briefed, given `clawo forum`, pushed to.
 */
export interface RunForum {
  id: string;
  config: ForumConfig;
  exposed: boolean;
  /** This run's single member name on a forum it is bound to. */
  agent?: string;
  /** What this run puts in front of its member names on a forum it is bound to. */
  prefix?: string;
}

export function runForum(record: RunRecord): RunForum {
  if (record.spec.forum) {
    return { id: record.runId, config: normalizeForumConfig(record.spec.forum) ?? {}, exposed: true };
  }
  if (record.forum) {
    let owner: RunRecord | undefined;
    try {
      owner = loadRun(record.forum.runId);
    } catch {
      owner = undefined;
    }
    if (owner) {
      const config = owner.spec.forum ? (normalizeForumConfig(owner.spec.forum) ?? {}) : undefined;
      return {
        id: record.forum.runId,
        config: config ?? {},
        exposed: !!config,
        ...(record.forum.agent ? { agent: record.forum.agent } : {}),
        ...(record.forum.prefix ? { prefix: record.forum.prefix } : {}),
      };
    }
  }
  return { id: record.runId, config: {}, exposed: false };
}

/** Where the forum of a run is, if its agents are on one: its own, or the one its binding names. */
export function resolveForum(
  record: RunRecord,
): { runId: string; config: ForumConfig; agent?: string; prefix?: string } | undefined {
  const forum = runForum(record);
  if (!forum.exposed) return undefined;
  return {
    runId: forum.id,
    config: forum.config,
    ...(forum.agent ? { agent: forum.agent } : {}),
    ...(forum.prefix ? { prefix: forum.prefix } : {}),
  };
}

/** The name a run's agent or goal node is on its forum as. */
export function memberNameFor(forum: { agent?: string; prefix?: string }, name: string): string {
  return forum.agent ?? `${forum.prefix ?? ''}${name}`;
}
