/**
 * Per-test-file HOME isolation.
 *
 * EmbeddedServer persists its auth token to `~/.openclaw/server-token` and
 * re-reads that file on every request (so a second instance can rotate it
 * mid-life). Vitest runs each test file in its own worker process, but those
 * processes share the *real* filesystem — so multiple server-creating test
 * files clobber each other's token file and requests start getting 401s. The
 * failure is timing-dependent (surfaces only under the right parallel
 * scheduling), which makes it a flaky landmine.
 *
 * Pointing $HOME (and %USERPROFILE% on Windows) at a unique temp dir per file
 * makes `os.homedir()` — and therefore the token file — local to this worker,
 * eliminating the cross-file race without touching token/auth semantics.
 *
 * Call once at the top level of any test file that constructs an
 * EmbeddedServer (or otherwise writes under ~/.openclaw).
 */
import { beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function useIsolatedHome(): void {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  let tmpHome: string | undefined;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-test-home-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (tmpHome) {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });
}
