import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../session-manager.js';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('SessionManager claude binary', () => {
  afterEach(() => vi.unstubAllEnvs());

  const binOf = (m: SessionManager) => (m as unknown as { pluginConfig: { claudeBin: string } }).pluginConfig.claudeBin;

  it('honours CLAUDE_BIN when no binary is configured', () => {
    vi.stubEnv('CLAUDE_BIN', '/opt/tools/claude');
    expect(binOf(new SessionManager({}, nullLogger))).toBe('/opt/tools/claude');
  });

  it('prefers an explicit claudeBin over CLAUDE_BIN', () => {
    vi.stubEnv('CLAUDE_BIN', 'from-env');
    expect(binOf(new SessionManager({ claudeBin: 'from-config' }, nullLogger))).toBe('from-config');
  });

  it('falls back to claude', () => {
    vi.stubEnv('CLAUDE_BIN', '');
    expect(binOf(new SessionManager({}, nullLogger))).toBe('claude');
  });
});
