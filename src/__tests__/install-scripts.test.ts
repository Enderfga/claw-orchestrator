/**
 * The plugin must work when its dependencies are installed without lifecycle
 * scripts. OpenClaw installs plugins with `npm install --ignore-scripts`, so a
 * runtime dependency that builds a native addon in an install script installs
 * with exit 0 but fails to load.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

interface LockPackage {
  dev?: boolean;
  peer?: boolean;
  hasInstallScript?: boolean;
}

describe('runtime dependencies', () => {
  it('need no install script', () => {
    const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
      packages: Record<string, LockPackage>;
    };
    // Dev dependencies are not installed with the plugin, and peers come from the host.
    const needScripts = Object.entries(lock.packages)
      .filter(([dir, pkg]) => dir !== '' && pkg.hasInstallScript && !pkg.dev && !pkg.peer)
      .map(([dir]) => dir);
    expect(needScripts).toEqual([]);
  });
});
