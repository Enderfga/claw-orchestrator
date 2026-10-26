/**
 * Narrator — per-run Haiku summariser of build progress.
 *
 * Subscribes to BuildEvents, batches them, and on flush trigger asks Haiku
 * to write a short conversational chat update. Trigger is whichever fires
 * first: a flush timer (default 15s), a count threshold (default 6 events),
 * or an "urgent" terminal event (build-complete / build-failed / cancelled).
 *
 * If the LLM call fails, we degrade gracefully: emit one raw line per buffered
 * event so the user still sees something rather than silence.
 */

import type { BuildEvent } from './build-events.js';
import { NARRATOR_SYSTEM_PROMPT, composeNarratorBatch } from './narrator-prompt.js';

interface SessionManagerLike {
  startSession(c: {
    name?: string;
    engine?: string;
    model?: string;
    systemPrompt?: string;
    permissionMode?: string;
  }): Promise<{ name: string }>;
  sendMessage(name: string, msg: string): Promise<{ output: string }>;
  stopSession(name: string): Promise<void>;
}

export interface NarratorOptions {
  runId: string;
  sessionManager: SessionManagerLike;
  language: 'zh' | 'en';
  onChat: (text: string) => void;
  flushIntervalMs?: number;
  eventCountThreshold?: number;
}

const URGENT_TYPES = new Set<BuildEvent['type']>(['build-complete', 'build-failed', 'build-cancelled']);

export class Narrator {
  private buffer: BuildEvent[] = [];
  private sessionName: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;

  constructor(private readonly opts: NarratorOptions) {}

  async start(): Promise<void> {
    const r = await this.opts.sessionManager.startSession({
      name: `narrator-${this.opts.runId}`,
      engine: 'claude',
      model: 'haiku',
      systemPrompt: NARRATOR_SYSTEM_PROMPT,
      permissionMode: 'bypassPermissions',
    });
    this.sessionName = r.name;
    const interval = this.opts.flushIntervalMs ?? 15000;
    this.timer = setInterval(() => void this.flush(), interval);
    this.timer.unref?.();
  }

  push(ev: BuildEvent): void {
    if (this.stopped) return;
    this.buffer.push(ev);
    const threshold = this.opts.eventCountThreshold ?? 6;
    if (URGENT_TYPES.has(ev.type) || this.buffer.length >= threshold) {
      void this.flush();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) await this.flush();
    if (this.sessionName) {
      await this.opts.sessionManager.stopSession(this.sessionName).catch(() => {});
      this.sessionName = null;
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0 || !this.sessionName) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    this.flushing = true;
    try {
      const userPrompt = composeNarratorBatch(batch, this.opts.language);
      const r = await this.opts.sessionManager.sendMessage(this.sessionName, userPrompt);
      const text = (r.output ?? '').trim();
      if (text) this.opts.onChat(text);
    } catch {
      for (const ev of batch) this.opts.onChat(rawDescribe(ev));
    } finally {
      this.flushing = false;
    }
  }
}

function rawDescribe(ev: BuildEvent): string {
  return `[${ev.type}] ${JSON.stringify(ev)}`;
}
