import { describe, expect, it } from 'vitest';
import { assertTailnetHost, bearerOk } from '../mcp/http-policy.js';

const TOKEN = 'a'.repeat(32);

describe('assertTailnetHost', () => {
  it('accepts a Tailscale address', () => {
    expect(() => assertTailnetHost('100.108.164.113')).not.toThrow();
    expect(() => assertTailnetHost('100.64.0.1')).not.toThrow();
    expect(() => assertTailnetHost('100.127.255.255')).not.toThrow();
  });

  it('refuses public, loopback, and wildcard binds', () => {
    for (const host of ['0.0.0.0', '127.0.0.1', 'localhost', '::', '1.2.3.4', '192.168.1.10', '10.0.0.5', '']) {
      expect(() => assertTailnetHost(host), host).toThrow(/refusing|required/);
    }
  });
});

describe('bearerOk', () => {
  it('accepts only the exact bearer token', () => {
    expect(bearerOk(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerOk('Bearer wrong-token-wrong-token-wrong', TOKEN)).toBe(false);
    expect(bearerOk(undefined, TOKEN)).toBe(false);
    expect(bearerOk(`Bearer ${TOKEN}`, 'short')).toBe(false);
    expect(bearerOk(`bearer ${TOKEN}`, TOKEN)).toBe(false);
  });
});
