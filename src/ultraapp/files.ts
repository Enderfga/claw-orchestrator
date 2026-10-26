import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The request body `POST /ultraapp/<id>/files` must accept for an upload of
 * {@link MAX_UPLOAD_BYTES}: the file travels base64-encoded inside JSON, which is
 * 4/3 of its size, plus a small envelope for the filename.
 */
export const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 64 * 1024;

export interface PathValidationOptions {
  allow: string[];
  lstat?: (p: string) => { isSymbolicLink: () => boolean };
}

export function validateLocalPath(p: string, opts: PathValidationOptions): void {
  if (!path.isAbsolute(p)) throw new Error('path must be absolute');
  if (p.includes('/.') || p.startsWith('.')) throw new Error('dotfile/dotdir paths are not allowed');
  const inside = opts.allow.some((root) => p === root || p.startsWith(root + path.sep) || p.startsWith(root + '/'));
  if (!inside) throw new Error(`path outside sandbox: ${opts.allow.join(', ')}`);
  const lstat = opts.lstat ?? ((q: string) => fs.lstatSync(q));
  let info;
  try {
    info = lstat(p);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) throw new Error('symlink paths are not allowed');
}

export function defaultAllowedRoots(): string[] {
  const home = process.env.HOME ?? '';
  const allow: string[] = [];
  if (home) allow.push(home);
  allow.push('/tmp');
  return allow;
}

export async function ingestUpload(examplesDir: string, filename: string, data: Buffer): Promise<string> {
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`upload too large (${data.byteLength} bytes, max ${MAX_UPLOAD_BYTES})`);
  }
  await fsp.mkdir(examplesDir, { recursive: true });
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const ref = path.join(examplesDir, `${crypto.randomUUID()}-${safe}`);
  await fsp.writeFile(ref, data);
  return ref;
}

type RunResult = { ok: boolean; stdout: string };
type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const realRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
    child.on('error', () => resolve({ ok: false, stdout: '' }));
  });

export interface ExtractMetaOptions {
  runner?: Runner;
}

export interface FileMetadata {
  fileType?: string;
  ffprobe?: unknown;
  sizeBytes?: number;
}

export async function extractMetadata(p: string, opts: ExtractMetaOptions = {}): Promise<FileMetadata> {
  const runner = opts.runner ?? realRunner;
  const meta: FileMetadata = {};
  try {
    const stat = await fsp.stat(p);
    meta.sizeBytes = stat.size;
  } catch {
    /* missing file — return empty */
  }
  const fileRes = await runner('file', [p]);
  if (fileRes.ok) {
    const m = fileRes.stdout.trim();
    meta.fileType = m.includes(': ') ? m.slice(m.indexOf(': ') + 2) : m;
  }
  const ffRes = await runner('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p]);
  if (ffRes.ok && ffRes.stdout.trim().length > 0) {
    try {
      meta.ffprobe = JSON.parse(ffRes.stdout);
    } catch {
      /* malformed → skip */
    }
  }
  return meta;
}
