/**
 * An engine CLI runs through a real session wrapper with the server's token in
 * the server's environment. The engine must not receive it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentCustomSession } from '../persistent-custom-session.js';
import { SessionManager } from '../session-manager.js';

describe('engine environment', () => {
  const saved = process.env.OPENCLAW_SERVER_TOKEN;
  const dirs: string[] = [];

  afterEach(() => {
    if (saved === undefined) delete process.env.OPENCLAW_SERVER_TOKEN;
    else process.env.OPENCLAW_SERVER_TOKEN = saved;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('a custom engine does not see OPENCLAW_SERVER_TOKEN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawo-engine-env-'));
    dirs.push(dir);
    const seen = join(dir, 'seen.txt');
    const bin = join(dir, 'engine.mjs');
    writeFileSync(
      bin,
      `#!${process.execPath}\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(seen)}, String(process.env.OPENCLAW_SERVER_TOKEN));\n` +
        `process.stdout.write('ok\\n');\n`,
    );
    chmodSync(bin, 0o755);
    process.env.OPENCLAW_SERVER_TOKEN = 'server-secret';

    const session = new PersistentCustomSession({
      name: 'env-token',
      cwd: dir,
      customEngine: { name: 'env-probe', bin, args: {} },
    });
    await session.start();
    try {
      await session.send('hi', { waitForComplete: true, timeout: 20_000 });
    } finally {
      session.stop();
    }

    expect(readFileSync(seen, 'utf8')).toBe('undefined');
  });

  // The Claude CLI management subcommands (plugin details, agents, project
  // purge) are one-shot spawns too, outside any session.
  it.skipIf(process.platform === 'win32')(
    'a Claude CLI management call does not see OPENCLAW_SERVER_TOKEN',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'clawo-engine-env-'));
      dirs.push(dir);
      const bin = join(dir, 'claude.mjs');
      writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(String(process.env.OPENCLAW_SERVER_TOKEN));\n`);
      chmodSync(bin, 0o755);
      process.env.OPENCLAW_SERVER_TOKEN = 'server-secret';

      const mgr = new SessionManager({ claudeBin: bin, maxConcurrentSessions: 1 });
      try {
        const { stdout } = await mgr.pluginDetails('some-plugin');
        expect(stdout).toBe('undefined');
      } finally {
        await mgr.shutdown();
      }
    },
  );
});
