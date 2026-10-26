import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { forkVersion, listVersions, nextVersion, snapshotVersion, swapVersion } from '../../ultraapp/versions.js';

function makeArtifact(dir: string, deploy?: object): void {
  fs.writeFileSync(
    path.join(dir, 'artifact.json'),
    JSON.stringify({
      worktreePath: path.join(dir, 'codebase'),
      builtAt: '2026-05-12T00:00:00Z',
      ...(deploy ? { deploy } : {}),
    }),
  );
}

describe('versions', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-ver-'));
    fs.mkdirSync(path.join(tmp, 'v1'));
    makeArtifact(path.join(tmp, 'v1'), {
      url: 'http://localhost:19000/forge/foo/',
      port: 19101,
      containerName: 'ultraapp-foo-v1',
      imageTag: 'ultraapp/foo:v1',
    });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('listVersions returns versions sorted ascending', () => {
    fs.mkdirSync(path.join(tmp, 'v2'));
    makeArtifact(path.join(tmp, 'v2'));
    fs.mkdirSync(path.join(tmp, 'v10'));
    makeArtifact(path.join(tmp, 'v10'));
    const v = listVersions(tmp);
    expect(v.map((x) => x.version)).toEqual(['v1', 'v2', 'v10']);
  });

  it('forkVersion copies a codebase into the next slot, which snapshotVersion then records', () => {
    const src = path.join(tmp, 'v1', 'codebase');
    fs.mkdirSync(path.join(src, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(src, 'build'), { recursive: true });
    fs.writeFileSync(path.join(src, 'app.css'), 'blue');
    fs.writeFileSync(path.join(src, 'build', 'keep.ts'), 'x');
    // A slot a failed attempt left behind is skipped, not reused.
    fs.mkdirSync(path.join(tmp, 'v2'));

    const fork = forkVersion(tmp, src);
    expect(fork).toEqual({ version: 'v3', worktreePath: path.join(tmp, 'v3', 'codebase') });
    expect(fs.readFileSync(path.join(fork.worktreePath, 'app.css'), 'utf8')).toBe('blue');
    expect(fs.existsSync(path.join(fork.worktreePath, 'build', 'keep.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fork.worktreePath, 'node_modules'))).toBe(false);
    expect(listVersions(tmp).map((v) => v.version)).toEqual(['v1']);

    snapshotVersion(tmp, { ...fork, source: 'patcher' });
    const v3 = listVersions(tmp).find((v) => v.version === 'v3');
    expect(v3?.source).toBe('patcher');
    expect(v3?.worktreePath).toBe(fork.worktreePath);
    expect(nextVersion(tmp)).toBe('v4');
  });

  it('listVersions returns [] for missing dir', () => {
    expect(listVersions(path.join(tmp, 'nonexistent'))).toEqual([]);
  });

  it('swapVersion stops old, starts new, updates router', async () => {
    fs.mkdirSync(path.join(tmp, 'v2'));
    makeArtifact(path.join(tmp, 'v2'), {
      url: 'http://localhost:19000/forge/foo/',
      port: 19102,
      containerName: 'ultraapp-foo-v2',
      imageTag: 'ultraapp/foo:v2',
    });
    const router = { register: vi.fn(), deregister: vi.fn() };
    const startContainer = vi.fn().mockResolvedValue({ ok: true });
    const stopContainer = vi.fn().mockResolvedValue({ ok: true });
    const r = await swapVersion({
      versionsDir: tmp,
      fromVersion: 'v1',
      toVersion: 'v2',
      slug: 'foo',
      router,
      startContainer,
      stopContainer,
    });
    expect(r.ok).toBe(true);
    expect(router.deregister).toHaveBeenCalledWith('foo');
    expect(stopContainer).toHaveBeenCalledWith('ultraapp-foo-v1');
    expect(startContainer).toHaveBeenCalledWith('ultraapp-foo-v2');
    expect(router.register).toHaveBeenCalledWith('foo', 19102);
  });

  it('swapVersion fails if target has no deploy info', async () => {
    fs.mkdirSync(path.join(tmp, 'v2'));
    makeArtifact(path.join(tmp, 'v2')); // no deploy
    const r = await swapVersion({
      versionsDir: tmp,
      fromVersion: 'v1',
      toVersion: 'v2',
      slug: 'foo',
      router: { register: vi.fn(), deregister: vi.fn() },
      startContainer: vi.fn(),
      stopContainer: vi.fn(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no deploy info/);
  });

  it('swapVersion fails if startContainer fails', async () => {
    fs.mkdirSync(path.join(tmp, 'v2'));
    makeArtifact(path.join(tmp, 'v2'), {
      url: 'http://localhost:19000/forge/foo/',
      port: 19102,
      containerName: 'ultraapp-foo-v2',
      imageTag: 'ultraapp/foo:v2',
    });
    const r = await swapVersion({
      versionsDir: tmp,
      fromVersion: 'v1',
      toVersion: 'v2',
      slug: 'foo',
      router: { register: vi.fn(), deregister: vi.fn() },
      startContainer: vi.fn().mockResolvedValue({ ok: false, error: 'no such container' }),
      stopContainer: vi.fn().mockResolvedValue({ ok: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no such container/);
  });

  it('swapVersion puts the previous version back when the target does not start', async () => {
    fs.mkdirSync(path.join(tmp, 'v2'));
    makeArtifact(path.join(tmp, 'v2'), {
      url: 'http://localhost:19000/forge/foo/',
      port: 19102,
      containerName: 'ultraapp-foo-v2',
      imageTag: 'ultraapp/foo:v2',
    });
    const router = { register: vi.fn(), deregister: vi.fn() };
    const startContainer = vi.fn(async (name: string) =>
      name === 'ultraapp-foo-v2' ? { ok: false, error: 'no such container' } : { ok: true },
    );
    const r = await swapVersion({
      versionsDir: tmp,
      fromVersion: 'v1',
      toVersion: 'v2',
      slug: 'foo',
      router,
      startContainer,
      stopContainer: vi.fn().mockResolvedValue({ ok: true }),
    });
    expect(r.ok).toBe(false);
    expect(startContainer).toHaveBeenLastCalledWith('ultraapp-foo-v1');
    expect(router.register).toHaveBeenCalledWith('foo', 19101);
  });
});
