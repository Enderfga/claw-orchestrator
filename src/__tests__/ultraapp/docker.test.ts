import { describe, it, expect, vi } from 'vitest';
import { dockerBuild, dockerRun, dockerStop, dockerRm, dockerStart, dockerPs } from '../../ultraapp/docker.js';

function fakeChild(code: number, stdout: string, stderr: string = '') {
  const stream = (data: string) => ({
    on: (event: string, h: (chunk: Buffer) => void) => {
      if (event === 'data' && data) h(Buffer.from(data));
    },
  });
  const obj: {
    stdout: ReturnType<typeof stream>;
    stderr: ReturnType<typeof stream>;
    on: (event: string, h: (...a: unknown[]) => void) => typeof obj;
  } = {
    stdout: stream(stdout),
    stderr: stream(stderr),
    on(event, h) {
      if (event === 'close') {
        setImmediate(() => h(code));
      }
      return obj;
    },
  };
  return obj as never;
}

describe('docker wrapper', () => {
  it('dockerBuild composes the right args (legacy "Successfully built" output)', async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild(0, 'Successfully built abc123\n'));
    const r = await dockerBuild({
      tag: 'foo:v1',
      cwd: '/tmp/wt',
      buildArgs: { BASE_PATH: '/forge/foo' },
      spawnFn: spawn,
    });
    expect(r.ok).toBe(true);
    expect(r.imageId).toBe('abc123');
    const args = spawn.mock.calls[0][1];
    expect(args[0]).toBe('build');
    expect(args).toContain('-t');
    expect(args).toContain('foo:v1');
    expect(args).toContain('--build-arg');
    expect(args).toContain('BASE_PATH=/forge/foo');
    expect(args[args.length - 1]).toBe('/tmp/wt');
  });

  it('dockerBuild parses buildx "writing image sha256:..." output', async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild(0, '#15 writing image sha256:deadbeef done\n'));
    const r = await dockerBuild({ tag: 'x:v1', cwd: '/t', spawnFn: spawn });
    expect(r.ok).toBe(true);
    expect(r.imageId).toBe('deadbeef');
  });

  it('dockerBuild succeeds with unknown image id when no marker matches', async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild(0, 'random buildx output\n'));
    const r = await dockerBuild({ tag: 'x:v1', cwd: '/t', spawnFn: spawn });
    expect(r.ok).toBe(true);
    expect(r.imageId).toBe('unknown');
  });

  it('dockerRun returns container name on success', async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild(0, 'container-name-here\n'));
    const r = await dockerRun({
      image: 'foo:v1',
      name: 'ultraapp-foo-v1',
      hostPort: 19101,
      env: { BASE_PATH: '/forge/foo' },
      volumes: { '/host/data': '/data' },
      spawnFn: spawn,
    });
    expect(r.ok).toBe(true);
    expect(r.containerName).toBe('container-name-here');
    const args = spawn.mock.calls[0][1];
    // Published on loopback only: the router reaches the backend on 127.0.0.1, and a
    // bare HOST_PORT:3000 would publish it on every host interface.
    expect(args[args.indexOf('-p') + 1]).toBe('127.0.0.1:19101:3000');
    expect(args).toContain('--restart');
    expect(args).toContain('unless-stopped');
    expect(args).toContain('-e');
    expect(args).toContain('BASE_PATH=/forge/foo');
    expect(args).toContain('-v');
    expect(args).toContain('/host/data:/data');
    expect(args[args.length - 1]).toBe('foo:v1');
  });

  it('dockerStop / dockerRm / dockerStart return ok on zero exit', async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild(0, ''));
    expect((await dockerStop('foo', spawn)).ok).toBe(true);
    expect((await dockerRm('foo', spawn)).ok).toBe(true);
    expect((await dockerStart('foo', spawn)).ok).toBe(true);
  });

  it('dockerPs returns parsed list', async () => {
    const spawn = vi
      .fn()
      .mockReturnValue(
        fakeChild(
          0,
          '{"Names":"a","State":"running","Ports":"19101->3000"}\n{"Names":"b","State":"exited","Ports":""}\n',
        ),
      );
    const r = await dockerPs(spawn);
    expect(r.containers.length).toBe(2);
    expect(r.containers[0].name).toBe('a');
    expect(r.containers[0].state).toBe('running');
    expect(r.containers[1].state).toBe('exited');
  });

  it('reports failure on non-zero exit', async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild(1, '', 'no such image'));
    const r = await dockerRun({
      image: 'x',
      name: 'y',
      hostPort: 1,
      env: {},
      volumes: {},
      spawnFn: spawn,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no such image');
  });
});
