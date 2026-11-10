/**
 * Thin wrapper around the docker CLI. Centralised so tests mock the
 * spawnFn and the rest of ultraapp doesn't touch child_process directly.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';

type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function run(args: string[], spawnFn: SpawnFn): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnFn('docker', args);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code: number | null) => {
      resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 });
    });
  });
}

export interface BuildArgs {
  tag: string;
  cwd: string;
  buildArgs?: Record<string, string>;
  spawnFn?: SpawnFn;
}

export interface BuildResult {
  ok: boolean;
  imageId?: string;
  error?: string;
}

export async function dockerBuild(args: BuildArgs): Promise<BuildResult> {
  const sp = args.spawnFn ?? realSpawn;
  const cli = ['build', '-t', args.tag];
  for (const [k, v] of Object.entries(args.buildArgs ?? {})) {
    cli.push('--build-arg', `${k}=${v}`);
  }
  cli.push(args.cwd);
  const r = await run(cli, sp);
  if (!r.ok) return { ok: false, error: r.stderr || `docker build exited ${r.code}` };
  // Try several patterns. Modern buildx prints "writing image sha256:...";
  // legacy docker prints "Successfully built <hash>".
  const m =
    /Successfully built ([a-f0-9]+)/.exec(r.stdout) ??
    /writing image sha256:([a-f0-9]+)/.exec(r.stdout) ??
    /writing image sha256:([a-f0-9]+)/.exec(r.stderr);
  return { ok: true, imageId: m?.[1] ?? 'unknown' };
}

export interface RunArgs {
  image: string;
  name: string;
  hostPort: number;
  env: Record<string, string>;
  volumes: Record<string, string>;
  spawnFn?: SpawnFn;
}

export interface DockerRunResult {
  ok: boolean;
  containerName?: string;
  error?: string;
}

export async function dockerRun(args: RunArgs): Promise<DockerRunResult> {
  const sp = args.spawnFn ?? realSpawn;
  // Loopback only: the router reaches the backend on 127.0.0.1, and a bare HOST_PORT:3000
  // would publish it on every host interface.
  const cli = [
    'run',
    '-d',
    '--name',
    args.name,
    '--restart',
    'unless-stopped',
    '-p',
    `127.0.0.1:${args.hostPort}:3000`,
  ];
  for (const [k, v] of Object.entries(args.env)) cli.push('-e', `${k}=${v}`);
  for (const [host, container] of Object.entries(args.volumes)) cli.push('-v', `${host}:${container}`);
  cli.push(args.image);
  const r = await run(cli, sp);
  if (!r.ok) return { ok: false, error: r.stderr || `docker run exited ${r.code}` };
  return { ok: true, containerName: r.stdout.trim() };
}

export async function dockerStop(name: string, spawnFn: SpawnFn = realSpawn): Promise<{ ok: boolean; error?: string }> {
  const r = await run(['stop', name], spawnFn);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

export async function dockerRm(name: string, spawnFn: SpawnFn = realSpawn): Promise<{ ok: boolean; error?: string }> {
  const r = await run(['rm', '-f', name], spawnFn);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

export async function dockerStart(
  name: string,
  spawnFn: SpawnFn = realSpawn,
): Promise<{ ok: boolean; error?: string }> {
  const r = await run(['start', name], spawnFn);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

export async function dockerRmi(tag: string, spawnFn: SpawnFn = realSpawn): Promise<{ ok: boolean; error?: string }> {
  const r = await run(['rmi', '-f', tag], spawnFn);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

export interface PsResult {
  containers: Array<{ name: string; state: string; ports: string }>;
}

export async function dockerPs(spawnFn: SpawnFn = realSpawn): Promise<PsResult> {
  const r = await run(['ps', '-a', '--format', '{{json .}}'], spawnFn);
  if (!r.ok) return { containers: [] };
  const containers = r.stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        const j = JSON.parse(l) as { Names: string; State: string; Ports: string };
        return { name: j.Names, state: j.State, ports: j.Ports };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; state: string; ports: string } => x !== null);
  return { containers };
}
