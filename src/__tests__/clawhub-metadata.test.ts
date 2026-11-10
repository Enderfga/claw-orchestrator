/**
 * ClawHub rejects an external code plugin whose package.json lacks
 * `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`. Both must
 * also stay true: the compat range is the OpenClaw peer range, and the build
 * version is the OpenClaw version resolved in package-lock.json.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')) as Record<string, unknown>;

describe('ClawHub package metadata', () => {
  const pkg = readJson('package.json') as {
    peerDependencies: Record<string, string>;
    openclaw: { compat?: { pluginApi?: string }; build?: { openclawVersion?: string } };
  };
  const lock = readJson('package-lock.json') as { packages: Record<string, { version?: string }> };

  it('declares the plugin API range as the OpenClaw peer range', () => {
    expect(pkg.openclaw.compat?.pluginApi).toBe(pkg.peerDependencies.openclaw);
  });

  it('declares the build version as the OpenClaw version in package-lock.json', () => {
    expect(pkg.openclaw.build?.openclawVersion).toBe(lock.packages['node_modules/openclaw']?.version);
  });
});
