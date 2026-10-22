/**
 * Bind and auth rules for the tailnet MCP listener.
 * The listener may bind only inside the Tailscale CGNAT range (100.64.0.0/10).
 */
import crypto from 'node:crypto';

const TAILNET_LO = 0x64400000; // 100.64.0.0
const TAILNET_HI = 0x647fffff; // 100.127.255.255

export const DEFAULT_TAILNET_TOOLS = [
  'workflow_list',
  'workflow_status',
  'workflow_cancel',
  'workflow_start',
  'fanout_start',
  'fanout_status',
  'council_start',
  'council_status',
  'autoloop_start',
  'autoloop_status',
  'ultrareview_start',
  'ultrareview_status',
  'ultraplan_start',
  'ultraplan_status',
].join(',');

export function assertTailnetHost(host: string): void {
  const value = host.trim();
  if (!value) {
    throw new Error('CLAWO_MCP_HOST is required and must be a Tailscale address in 100.64.0.0/10');
  }
  const parts = value.split('.');
  if (parts.length !== 4) {
    throw new Error(`refusing to bind ${value}: Claw MCP binds to a Tailscale IPv4 address only`);
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`refusing to bind ${value}: not an IPv4 address`);
  }
  const ip = ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
  if (ip < TAILNET_LO || ip > TAILNET_HI) {
    throw new Error(`refusing to bind ${value}: not in 100.64.0.0/10 (no public, no loopback, no 0.0.0.0)`);
  }
}

export function bearerOk(header: string | undefined, token: string): boolean {
  if (token.length < 32 || header == null) return false;
  const expect = `Bearer ${token}`;
  const got = Buffer.from(header);
  const want = Buffer.from(expect);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}
