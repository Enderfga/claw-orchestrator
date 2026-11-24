/**
 * The environment a contract's checks run with: minimal — no secrets — when an
 * agent of the run worked in a sandbox, the server's otherwise, and what the
 * contract says when it says.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chooseCheckEnv, minimalCheckEnv, sandboxedAgents } from '../../verify/check-env.js';
import { contractFingerprint, normalizeContract } from '../../verify/contract.js';
import { readEvidence } from '../../verify/evidence.js';
import { RunKernel } from '../../kernel/engine.js';
import { registerDefaultExecutors } from '../../kernel/nodes/index.js';
import { runDir } from '../../kernel/store.js';

const SERVER = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/u',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  NODE_OPTIONS: '--max-old-space-size=4096',
  PYTHONPATH: '/opt/lib',
  OPENAI_API_KEY: 'sk-x',
  AWS_SECRET_ACCESS_KEY: 'aws-x',
  AWS_REGION: 'us-west-2',
  GITHUB_TOKEN: 'gh-x',
  NODE_AUTH_TOKEN: 'npm-x',
  'npm_config_//registry.npmjs.org/:_authToken': 'npm-y',
  npm_config_cache: '/home/u/.npm',
  CLAWO_AUTH_TOKEN: 'server-x',
  DATABASE_URL: 'postgres://u:p@db/x',
};

describe('the minimal environment', () => {
  it('keeps what toolchains need and nothing named like a secret', () => {
    const env = minimalCheckEnv(SERVER);
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'PATH', 'PYTHONPATH', 'npm_config_cache'].sort(),
    );
  });

  it('passes what the contract names, by name or prefix, but never the server credential', () => {
    const env = minimalCheckEnv(SERVER, ['OPENAI_API_KEY', 'AWS_*', 'CLAWO_AUTH_TOKEN']);
    expect(env.OPENAI_API_KEY).toBe('sk-x');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('aws-x');
    expect(env.AWS_REGION).toBe('us-west-2');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CLAWO_AUTH_TOKEN).toBeUndefined();
  });
});

describe('which agents worked in a sandbox', () => {
  it('Codex by default, an explicit read-only or workspace-write, and anything under a launcher', () => {
    const spec = {
      nodes: [
        { id: 'a', kind: 'agent', engine: 'codex' },
        { id: 'b', kind: 'agent', engine: 'codex', sandboxMode: 'danger-full-access' },
        { id: 'c', kind: 'agent', engine: 'claude' },
        { id: 'd', kind: 'agent', engine: 'claude', launcher: ['/opt/sandbox.sh'] },
        { id: 'e', kind: 'goal', engine: 'grok', sandboxMode: 'workspace-write' },
        {
          id: 'f',
          kind: 'fanout',
          agents: [
            { name: 'x', engine: 'claude' },
            { name: 'y', engine: 'codex' },
          ],
        },
        { id: 'g', kind: 'verifier' },
      ],
    };
    expect(sandboxedAgents(spec)).toEqual(['a', 'd', 'e', 'f/y']);
  });

  it('the contract decides when it says, either way', () => {
    const boxed = { nodes: [{ id: 'a', kind: 'agent', engine: 'codex' }] };
    const open = { nodes: [{ id: 'a', kind: 'agent', engine: 'claude' }] };
    expect(chooseCheckEnv({}, boxed, SERVER)).toMatchObject({ mode: 'minimal', reason: 'sandboxed agent: a' });
    const inherited = chooseCheckEnv({}, open, SERVER);
    expect(inherited.mode).toBe('inherit');
    expect(inherited.env).toBeUndefined();
    expect(chooseCheckEnv({ checkEnv: 'inherit' }, boxed, SERVER).mode).toBe('inherit');
    expect(chooseCheckEnv({ checkEnv: 'minimal' }, open, SERVER).env?.OPENAI_API_KEY).toBeUndefined();
    expect(chooseCheckEnv({}, undefined, SERVER).mode).toBe('inherit');
  });

  it('are part of the contract: a contract without them keeps its fingerprint', () => {
    const plain = normalizeContract({ checks: [{ type: 'command', cmd: 'npm', args: ['test'] }] })!;
    const same = normalizeContract({ checks: [{ type: 'command', cmd: 'npm', args: ['test'] }], passEnv: [] })!;
    const withEnv = normalizeContract({
      checks: [{ type: 'command', cmd: 'npm', args: ['test'] }],
      checkEnv: 'minimal',
      passEnv: ['AWS_*', 'not a name', 'X;rm'],
    })!;
    expect(contractFingerprint(same)).toBe(contractFingerprint(plain));
    expect(withEnv.passEnv).toEqual(['AWS_*']);
    expect(contractFingerprint(withEnv)).not.toBe(contractFingerprint(plain));
  });
});

describe('a workflow run', () => {
  let repo: string;
  const saved = process.env.CLAWO_FAKE_API_KEY;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-checkenv-')));
    process.env.CLAWO_FAKE_API_KEY = 'secret-value';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAWO_FAKE_API_KEY;
    else process.env.CLAWO_FAKE_API_KEY = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  async function run(engine: string, extra: Record<string, unknown> = {}) {
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
    kernel.setExecutor('agent', async () => ({ ok: true, output: 'done' }));
    // The check passes when it can see the secret.
    const started = await kernel.start({
      name: 'env',
      cwd: repo,
      contract: {
        checks: [{ spec: { type: 'command', cmd: 'sh', args: ['-c', 'test -n "$CLAWO_FAKE_API_KEY"'] } }],
        ...extra,
      } as never,
      nodes: [{ id: 'impl', kind: 'agent', prompt: 'x', engine: engine as never }],
    });
    const done = await kernel.wait(started.runId);
    return { done: done!, bundle: readEvidence(runDir(started.runId), done!.evidenceId!) };
  }

  it("does not hand a sandboxed agent's checks the server's secrets, and says so in the evidence", async () => {
    const { done, bundle } = await run('codex');
    expect(done.outcome).toBe('refuted');
    expect(bundle?.checkEnv).toEqual({ mode: 'minimal', reason: 'sandboxed agent: impl', passEnv: [] });
  });

  it('hands them over when the agent was not sandboxed, or the contract passes them', async () => {
    expect((await run('claude')).done.outcome).toBe('verified');
    const passed = await run('codex', { passEnv: ['CLAWO_FAKE_*'] });
    expect(passed.done.outcome).toBe('verified');
    expect(passed.bundle?.checkEnv).toMatchObject({ mode: 'minimal', passEnv: ['CLAWO_FAKE_*'] });
    expect((await run('codex', { checkEnv: 'inherit' })).done.outcome).toBe('verified');
  });

  it('runs a metric with the same environment', async () => {
    const kernel = registerDefaultExecutors(new RunKernel({ nodeTimeoutMs: 20_000 }));
    kernel.setExecutor('agent', async () => ({ ok: true, output: 'done' }));
    // The metric is the length of the secret it can see: 0 when it sees none.
    const started = await kernel.start({
      name: 'env-metric',
      cwd: repo,
      contract: {
        checks: [{ spec: { type: 'metric', cmd: 'sh', args: ['-c', 'echo ${#CLAWO_FAKE_API_KEY}'], max: 0 } }],
      } as never,
      nodes: [{ id: 'impl', kind: 'agent', prompt: 'x', engine: 'codex' }],
    });
    expect((await kernel.wait(started.runId))!.outcome).toBe('verified');
  });
});
