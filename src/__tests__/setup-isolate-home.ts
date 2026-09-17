/**
 * Every test file runs against a private HOME and private state directories.
 *
 * Without this the suite wrote into the real ones: turn rows into
 * `~/.claw-orchestrator/runs` (most of that ledger was test fixtures), council
 * transcripts into `~/.openclaw/council-logs`, and it read and rewrote
 * `~/.openclaw/claude-sessions.json` and `session-pids.json` — the files a
 * running orchestrator restores sessions and reaps orphans from.
 *
 * It has to happen here, before the test file is imported: several modules
 * resolve these paths once, at load time, from `os.homedir()`.
 */
import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Real path: on macOS the temp dir sits behind the /var -> /private/var symlink,
// and a real home directory has no symlink in it.
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clawo-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAWO_RUNS_DIR = path.join(home, '.claw-orchestrator', 'runs');
process.env.CLAWO_WF_DIR = path.join(home, '.claw-orchestrator', 'wf');

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
