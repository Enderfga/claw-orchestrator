/**
 * The suite must never touch the real user's state. `os.userInfo().homedir`
 * reads the account database and ignores $HOME, so it names the directory the
 * setup file is meant to keep every test out of.
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { runsDir } from '../run-ledger.js';
import { wfDir } from '../kernel/store.js';

const realHome = os.userInfo().homedir;
const under = (p: string) => p === realHome || p.startsWith(realHome + path.sep);

describe('test isolation', () => {
  it('runs every test file with a private HOME', () => {
    expect(under(os.homedir())).toBe(false);
  });

  it('keeps the run ledger and the workflow store out of the real home', () => {
    expect(under(runsDir())).toBe(false);
    expect(under(wfDir())).toBe(false);
  });
});
