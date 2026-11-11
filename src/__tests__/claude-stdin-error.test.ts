/**
 * A Claude session whose CLI stops reading its stdin. Writing to it then raises
 * EPIPE twice: in the write callback, and as an 'error' event on the stdin
 * stream. Neither may reach the event loop unheard — inside OpenClaw the
 * session lives in the gateway process, and an unheard 'error' ends it.
 *
 * The fixture stands in for the CLI through `launcher`: it reports a session,
 * closes its stdin, and stays alive, so the process has not exited when the
 * next message is written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-stdin-'));
const savedEnv = { ...process.env };
process.env.CLAWO_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.CLAWO_RUNS_DIR = path.join(tmp, 'runs');

const FIXTURE = `
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: randomUUID() }) + '\\n');
closeSync(0);
setInterval(() => {}, 1000);
`;

type Manager = {
  startSession(c: Record<string, unknown>): Promise<unknown>;
  stopSession(n: string): Promise<void>;
  sendMessage(n: string, m: string, o?: Record<string, unknown>): Promise<{ output: string; error?: string }>;
};
let SessionManager: new (o: unknown) => Manager;
const fixture = path.join(tmp, 'deaf-claude.mjs');

beforeAll(async () => {
  fs.writeFileSync(fixture, FIXTURE);
  ({ SessionManager } = (await import('../session-manager.js')) as unknown as {
    SessionManager: typeof SessionManager;
  });
});

afterAll(() => {
  for (const k of ['CLAWO_SESSIONS_DIR', 'CLAWO_RUNS_DIR']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a Claude CLI that stopped reading', () => {
  it('fails the turn instead of the process', async () => {
    const mgr = new SessionManager({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
    const name = 'deaf';
    await mgr.startSession({ name, engine: 'claude', cwd: tmp, launcher: [process.execPath, fixture] });
    try {
      // Give the fixture time to close its end of the pipe.
      await new Promise((r) => setTimeout(r, 300));
      const outcome = await mgr.sendMessage(name, 'hello', { timeout: 5_000 }).then(
        (r) => r.error ?? `replied: ${r.output}`,
        (e: Error) => e.message,
      );
      expect(outcome).toMatch(/EPIPE|stdin/i);
    } finally {
      await mgr.stopSession(name);
    }
  }, 30_000);
});
