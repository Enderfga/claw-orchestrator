/**
 * A council seat works in a worktree whose git metadata is outside it: the
 * repository's common directory and `<common>/worktrees/<name>`. Codex's
 * workspace-write sandbox (its default) keeps both out of a seat's reach, so its
 * `git commit` fails there.
 *
 * Neither is given to the seat as a writable directory: git trusts what is in
 * them. With the common directory writable a seat plants a hook or a
 * `core.fsmonitor`; with its worktree's own, it repoints `commondir` (or removes
 * it, making that directory a repository with a config of its own) or writes a
 * `config.worktree`, and the next git command run outside the sandbox there runs
 * what it wrote. The council commits a sandboxed Codex seat's changes for it
 * instead, and that commit runs nothing the seat wrote either: a repository the
 * seat makes inside its worktree is not staged, and `git add` is kept out of
 * submodules, where it would run `git status` under the submodule's own config.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('../constants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../constants.js')>()),
  INTER_ROUND_DELAY_MS: 0,
  EMPTY_RESPONSE_RETRY_DELAY_MS: 0,
}));

import { Council } from '../council.js';
import type { AgentPersona } from '../types.js';

let tmp: string;
let repo: string;

const git = (cwd: string, cmd: string): string => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-council-gitdirs-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init -q -b main');
  git(repo, 'config user.email t@t.com');
  git(repo, 'config user.name T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  git(repo, 'add -A');
  git(repo, 'commit -q -m init');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seats that vote NO; `work(seat, round, cwd)` is what the seat does in its turn. */
function fakeManager(work: (seat: string, round: number, cwd: string) => void = () => {}) {
  const started: Array<Record<string, unknown>> = [];
  return {
    started,
    startSession: async (cfg: Record<string, unknown>) => {
      started.push(cfg);
      return { name: cfg.name as string, created: '', cwd: (cfg.cwd as string) ?? '', paused: false, stats: {} };
    },
    sendMessage: async (name: string) => {
      const m = /-([A-Za-z0-9]+)-r(\d+)$/.exec(name)!;
      const cfg = started.find((c) => c.name === name)!;
      work(m[1], Number(m[2]), cfg.cwd as string);
      return { output: `${'Did the work. '.repeat(10)}\n[CONSENSUS: NO]`, events: [] };
    },
    stopSession: async () => {},
  };
}

const seat = (name: string, over: Partial<AgentPersona> = {}): AgentPersona => ({
  name,
  emoji: '',
  persona: '',
  ...over,
});

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

async function runCouncil(agents: AgentPersona[], manager: ReturnType<typeof fakeManager>, maxRounds = 1) {
  const council = new Council({ agents, maxRounds, projectDir: repo }, manager as never, quiet);
  await council.run('Build the thing the council was asked to build');
}

/**
 * A repository inside `dir` whose config runs a command (appending to `proof`)
 * when a `git status` there refreshes its index: an fsmonitor, and a clean
 * filter on its files, which runs whatever command-line config says.
 */
function plantRepo(dir: string, proof: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init -q');
  fs.writeFileSync(path.join(dir, 'x'), 'x\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=planted\n');
  git(dir, 'add x .gitattributes');
  git(dir, '-c user.email=e@e -c user.name=E commit -q -m e');
  git(dir, `config core.fsmonitor "echo RAN >> '${proof}'; false #"`);
  git(dir, `config filter.planted.clean "sh -c 'echo RAN >> \\"${proof}\\"; cat'"`);
}

/** Make a planted repository's file look changed to its `git status`, which then reads it through the filter. */
function touchPlanted(dir: string): void {
  const t = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(dir, 'x'), t, t);
}

describe('a council seat’s git directories', { timeout: 30_000 }, () => {
  it('are given to no seat as writable directories', async () => {
    const m = fakeManager();
    await runCouncil(
      [
        seat('alice', { engine: 'codex' }),
        seat('bob', { engine: 'codex-app', sandboxMode: 'workspace-write' }),
        seat('carol', { engine: 'claude' }),
        seat('dave', { engine: 'codex', sandboxMode: 'read-only' }),
        seat('erin', { engine: 'codex', sandboxMode: 'danger-full-access' }),
        seat('frank', { engine: 'grok', sandboxMode: 'workspace-write' }),
      ],
      m,
    );
    expect(m.started).toHaveLength(6);
    for (const cfg of m.started) expect(cfg).not.toHaveProperty('addDir');
  });
});

describe('a sandboxed Codex seat’s changes', { timeout: 30_000 }, () => {
  it('are committed to its branch after each of its turns; another seat commits its own', async () => {
    const m = fakeManager((s, round, cwd) => fs.writeFileSync(path.join(cwd, `${s}-r${round}.txt`), `${s} ${round}\n`));
    await runCouncil([seat('alice', { engine: 'codex' }), seat('carol', { engine: 'claude' })], m, 2);

    expect(git(repo, 'log --format=%s council/alice').split('\n')).toEqual([
      'council(alice): round 2',
      'council(alice): round 1',
      'init',
    ]);
    expect(git(repo, 'ls-tree -r --name-only council/alice').split('\n')).toEqual([
      'a.txt',
      'alice-r1.txt',
      'alice-r2.txt',
    ]);
    expect(git(repo, 'log --format=%s council/carol')).toBe('init');

    const charter = (name: string) =>
      m.started.find((c) => (c.name as string).endsWith(`-${name}-r1`))!.appendSystemPrompt as string;
    expect(charter('alice')).toContain('committed to `council/alice` for you');
    expect(charter('carol')).not.toContain('for you');
  });

  it('leave out a repository the seat makes, and never run git inside a submodule', async () => {
    // The project has a submodule at sub/ (a gitlink; the worktree gets it empty).
    const sha = git(repo, 'rev-parse HEAD');
    git(repo, `update-index --add --cacheinfo 160000,${sha},sub`);
    git(repo, 'commit -q -m sub');
    const proof = path.join(tmp, 'proof');
    const m = fakeManager((_s, round, cwd) => {
      fs.writeFileSync(path.join(cwd, `r${round}.txt`), `${round}\n`);
      if (round === 1) {
        plantRepo(path.join(cwd, 'evil'), proof);
        plantRepo(path.join(cwd, 'sub'), proof);
      } else {
        touchPlanted(path.join(cwd, 'evil'));
        touchPlanted(path.join(cwd, 'sub'));
      }
    });
    await runCouncil([seat('alice', { engine: 'codex' })], m, 2);

    expect(fs.existsSync(proof)).toBe(false);
    const tree = git(repo, 'ls-tree -r council/alice');
    expect(tree).toMatch(/\tr1\.txt$/m);
    expect(tree).toMatch(/\tr2\.txt$/m);
    expect(tree).not.toMatch(/\tevil(\/|$)/m);
    // The submodule's entry is the project's, as it was.
    expect(tree).toMatch(new RegExp(`^160000 commit ${sha}\\tsub$`, 'm'));
    // Nor is the seat's repository left staged, for the next git command in the worktree to look inside.
    expect(git(path.join(repo, '.worktrees', 'alice'), 'ls-files -s')).not.toMatch(/\tevil$/m);
  });

  it('do not run when the next council takes the worktree over', async () => {
    const sha = git(repo, 'rev-parse HEAD');
    git(repo, `update-index --add --cacheinfo 160000,${sha},sub`);
    git(repo, 'commit -q -m sub');
    const proof = path.join(tmp, 'proof');
    await runCouncil(
      [seat('alice', { engine: 'codex' })],
      fakeManager((_s, _round, cwd) => {
        plantRepo(path.join(cwd, 'sub'), proof);
        touchPlanted(path.join(cwd, 'sub'));
      }),
    );
    // A later council on the project reuses the seat's worktree: it checks it is clean, checks out and resets it.
    const next = fakeManager();
    await runCouncil([seat('alice', { engine: 'codex' })], next);
    expect(next.started[0].cwd).toBe(path.join(repo, '.worktrees', 'alice'));
    expect(fs.existsSync(proof)).toBe(false);
  });
});
