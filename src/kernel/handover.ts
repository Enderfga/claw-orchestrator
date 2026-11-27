/**
 * What a node leaves for the rest of its run on the run's forum: its handover
 * (`DONE: <member> output`, the output for the other agents to read), and the
 * note naming the ASKs its agents left open.
 *
 * A handover is posted for the agent that produced the output, from the
 * runtime (`via: 'output'`), when the node (or, for a fan-out, the whole node)
 * has finished, so the agents of one fan-out never see each other's results
 * while they work. Its body is the same excerpt `inputs` hands a later agent,
 * and the `@name`s in the output address nobody: an output is not a message.
 * `inputs` itself reads the output from the run directory: the forum's spool is
 * writable by the run's agents, so a handover is a record, never a prompt's source.
 */

import * as path from 'node:path';
import { authorLabel, forumRuntimeAppend, isForumName, openAsksOf, type ForumPost } from './forum.js';
import { nodeDir } from './store.js';
import type { Logger } from '../logger.js';

/** How much of one output a handover and `inputs` carry; the whole is named by path. */
export const HANDOVER_EXCERPT_CHARS = 12_000;

/** Where a node's whole output is kept (`output.txt` in its node directory). */
export function nodeOutputPath(runId: string, nodeId: string): string {
  return path.join(nodeDir(runId, nodeId), 'output.txt');
}

/** An output as a handover and `inputs` carry it: whole, or cut with where the whole is. */
export function outputExcerpt(text: string, wholePath: string | undefined): string {
  if (text.length <= HANDOVER_EXCERPT_CHARS) return text;
  return `${text.slice(0, HANDOVER_EXCERPT_CHARS)}\n\n[cut; the whole output is ${wholePath ? `in ${wholePath}` : 'in the run'}]`;
}

/** The machine part of a handover post. */
export interface HandoverData {
  /** The node whose output it is. */
  node: string;
  /** The run that node belongs to (a subflow's child run posts on its parent's forum). */
  runId: string;
  /** The visit of the node that produced it. */
  visit?: number;
  /** Where the whole output is. */
  path?: string;
  /** For one agent of a fan-out (or its synthesis): the member it is from. Absent for a whole node's output. */
  agent?: string;
}

export interface HandoverInput extends HandoverData {
  /** The member it is posted for. */
  member: string;
  text: string;
}

/**
 * Post one handover on forum `forumId`. Nothing is posted for an empty output or
 * a member name the forum cannot carry; a write that fails is logged, never
 * thrown: a handover is the record, and the node's result does not depend on it.
 */
export function postHandover(forumId: string, input: HandoverInput, logger?: Logger): ForumPost | undefined {
  const text = input.text.trim();
  if (!text || !isForumName(input.member)) return undefined;
  const data: HandoverData = {
    node: input.node,
    runId: input.runId,
    ...(input.visit !== undefined ? { visit: input.visit } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
  };
  try {
    return forumRuntimeAppend(forumId, {
      from: input.member,
      title: `DONE: ${input.member} output`,
      body: outputExcerpt(text, input.path),
      via: 'output',
      mentions: false,
      data: data as unknown as Record<string, unknown>,
    }).post;
  } catch (err) {
    logger?.warn?.(`[forum ${forumId}] could not post ${input.member}'s handover: ${(err as Error).message}`);
    return undefined;
  }
}

/** One open ASK, as a node's result names it. */
export interface OpenAsk {
  id: string;
  from: string;
  to: string[];
  title: string;
}

/**
 * The ASKs on forum `forumId` that `names` posted, or that name one of them,
 * which nobody has answered: the line a node's result ends with, and the list
 * for its data. The note is `''` when there are none. Both name an author as
 * `authorLabel` does: a reserved name the forum does not vouch for is unverified.
 */
export function openAsksNote(forumId: string, names: string[]): { note: string; openAsks: OpenAsk[] } {
  const set = new Set(names);
  let asks: ForumPost[];
  try {
    asks = openAsksOf(forumId).filter((p) => set.has(p.from) || p.to.some((n) => set.has(n)));
  } catch {
    asks = [];
  }
  return {
    note: asks.length
      ? `\n\nOpen ASKs on the forum: ${asks.map((p) => `${p.id} ${authorLabel(forumId, p)}: ${p.title}`).join('; ')}`
      : '',
    openAsks: asks.map((p) => ({ id: p.id, from: authorLabel(forumId, p), to: p.to, title: p.title })),
  };
}
