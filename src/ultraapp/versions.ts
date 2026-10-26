/**
 * Version snapshot + swap mechanics.
 *
 * Each build and each successful patch takes a new version. Versions live under
 * `<runDir>/versions/v1/`, `v2/`, ..., each with its own `codebase/` and an
 * `artifact.json` carrying worktreePath + (once deployed) deploy info.
 *
 * `swapVersion` retargets the router between two deployed versions: deregister
 * the slug, stop the current container, start the target, register the slug to
 * the target's port.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DeployInfoLite {
  url: string;
  port: number;
  containerName: string;
  imageTag: string;
}

export interface VersionEntry {
  version: string;
  worktreePath: string;
  builtAt: string;
  source?: string;
  deploy?: DeployInfoLite;
  deployedAt?: string;
}

export function listVersions(versionsDir: string): VersionEntry[] {
  if (!fs.existsSync(versionsDir)) return [];
  const out: VersionEntry[] = [];
  for (const v of fs.readdirSync(versionsDir)) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(versionsDir, v, 'artifact.json'), 'utf8')) as Omit<
        VersionEntry,
        'version'
      >;
      out.push({ version: v, ...a });
    } catch {
      /* skip non-version dirs */
    }
  }
  out.sort((a, b) => parseVersionNumber(a.version) - parseVersionNumber(b.version));
  return out;
}

function parseVersionNumber(version: string): number {
  const m = /^v(\d+)$/.exec(version);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * The next free version slot.
 *
 * Counts every `vN` directory, recorded or not, so a slot a failed build or patch
 * left behind is skipped rather than written into.
 */
export function nextVersion(versionsDir: string): string {
  let max = 0;
  try {
    for (const d of fs.readdirSync(versionsDir)) {
      const m = /^v(\d+)$/.exec(d);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    /* no versions yet */
  }
  return `v${max + 1}`;
}

/**
 * Not copied by a fork: every validation and deploy runs `npm install` first.
 * Build output is copied, since a source directory can share its name.
 */
const NOT_FORKED = new Set(['node_modules']);

/**
 * Copy a version's codebase into the next slot, so a change can be made to the
 * copy while the original keeps serving.
 *
 * The copy is not listed until {@link snapshotVersion} records it, so a change
 * that fails leaves nothing that could be promoted.
 */
export function forkVersion(versionsDir: string, fromWorktree: string): { version: string; worktreePath: string } {
  const version = nextVersion(versionsDir);
  const worktreePath = path.join(versionsDir, version, 'codebase');
  fs.cpSync(fromWorktree, worktreePath, {
    recursive: true,
    filter: (src) => !NOT_FORKED.has(path.relative(fromWorktree, src)),
  });
  return { version, worktreePath };
}

/** Record a forked version, which makes it listed and promotable. */
export function snapshotVersion(
  versionsDir: string,
  args: { version: string; worktreePath: string; source: string },
): string {
  fs.writeFileSync(
    path.join(versionsDir, args.version, 'artifact.json'),
    JSON.stringify(
      {
        worktreePath: args.worktreePath,
        builtAt: new Date().toISOString(),
        source: args.source,
      },
      null,
      2,
    ),
  );
  return args.version;
}

export interface SwapArgs {
  versionsDir: string;
  fromVersion: string;
  toVersion: string;
  slug: string;
  router: { register: (slug: string, port: number) => void; deregister: (slug: string) => void };
  startContainer: (containerName: string) => Promise<{ ok: boolean; error?: string }>;
  stopContainer: (containerName: string) => Promise<{ ok: boolean; error?: string }>;
}

export async function swapVersion(args: SwapArgs): Promise<{ ok: boolean; error?: string }> {
  const versions = listVersions(args.versionsDir);
  const from = versions.find((v) => v.version === args.fromVersion);
  const to = versions.find((v) => v.version === args.toVersion);
  if (!to?.deploy) {
    return { ok: false, error: `target version ${args.toVersion} has no deploy info` };
  }
  args.router.deregister(args.slug);
  if (from?.deploy) {
    await args.stopContainer(from.deploy.containerName).catch(() => {
      /* best effort */
    });
  }
  const r = await args.startContainer(to.deploy.containerName);
  if (!r.ok) {
    // Leave the app on the version it was serving rather than on nothing.
    if (from?.deploy) {
      const back = await args.startContainer(from.deploy.containerName).catch(() => ({ ok: false }));
      if (back.ok) args.router.register(args.slug, from.deploy.port);
    }
    return { ok: false, error: r.error };
  }
  args.router.register(args.slug, to.deploy.port);
  return { ok: true };
}
