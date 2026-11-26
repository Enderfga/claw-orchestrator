#!/usr/bin/env tsx
/**
 * Weekly engine sweep — the measurement half, made deterministic.
 *
 * This is the part of the weekly check that was being done by hand: for each
 * core engine, what version is installed against what is pinned and what is
 * upstream; whether the flags the wrapper passes still exist on the binary and
 * whether the binary grew flags the wrapper does not know; whether one live
 * turn still completes; and whether the ACP and MCP entry points still speak
 * clean protocol. It produces a report. It changes nothing.
 *
 * Deliberately no LLM in here. This script has to be simpler than the wrappers
 * it checks — it is the thing that says a wrapper is broken, so it cannot share
 * the wrapper's failure modes. Judgement (is a new flag AI-facing? what does a
 * changed usage field mean?) is a separate step downstream, with a human gate.
 *
 * Grok runs on this account's free tier, so it gets exactly one short turn from
 * an empty directory — the shape that costs the least — and its usage-limit
 * failure is reported as what it is rather than as a wrapper regression.
 *
 * On the flag surface: a flag the wrapper passes that the binary's --help no
 * longer lists is reported, but it is NOT a regression on its own. Help text is
 * not ground truth — the first run of this script flagged four such Claude
 * options (--max-turns among them), and every one was still accepted by the
 * binary; claude simply omits hidden options from --help, and passes an unknown
 * option straight through to help with exit 0, so there is no free way to ask.
 * The live turn is the regression signal — and it goes through the real
 * wrapper class, not a hand-written argv. The first version of this script used
 * a minimal argv and passed agy while the wrapper's own default model had been
 * dropped by the engine; the wrapper's defaults are part of what is under test.
 * The not-advertised list is a prompt for the judgement step downstream.
 *
 * It also diffs `src/models.ts` against both vendors' published price tables.
 * That half was added after a sweep passed clean while all three GPT-5.6 tiers
 * sat at their launch rates — a wrong cost is silent, so nothing was ever going
 * to go red on its own. Its first run found two more: o3 with no cached rate,
 * and o4-mini copied from the Batch column at half its real price.
 *
 * Usage:
 *   npx tsx scripts/sweep.ts               # human table, exit 1 on a regression
 *   npx tsx scripts/sweep.ts --json        # machine-readable, same exit code
 *   npx tsx scripts/sweep.ts --no-live     # versions + flag surface only
 *   npx tsx scripts/sweep.ts --out report.json
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── Engine table ───────────────────────────────────────────────────────────

interface Engine {
  id: string;
  /** Empty when the binary is not installed by default; see `missingBin`. */
  bin: string;
  /** Why an empty `bin` is skipped, and how to point the sweep at one. */
  missingBin?: string;
  /** Pass `bin` to the wrapper's constructor, for a binary that is not on PATH as `bin`'s default. */
  passBin?: boolean;
  /** Flags the wrapper passes only to another major line of the same CLI, so not expected in this one's help. */
  otherLineFlags?: string[];
  /** The key of its row in the AGENTS.md table, when the CLI cell is not the engine id (`cursor-agent`). */
  pinKey?: string;
  /** The wrapper whose `'--flag'` literals define what we pass. */
  wrapper: string;
  /** argv that prints the headless subcommand's help. */
  helpArgv: string[];
  /** argv that prints the top-level help, whose subcommands are reviewed too. Default `['--help']`. */
  commandsArgv?: string[];
  /** Read-only upstream lookup, or null when the vendor offers none. */
  upstream: (() => Promise<string | null>) | null;
  /** The wrapper class, under dist/src, that the live turn goes through. */
  session: { file: string; cls: string };
  /** Cheapest possible working directory for the live turn. */
  liveCwd: 'repo' | 'empty';
  /** Wall-clock budget for the live turn. Default 240s. */
  liveTimeoutMs?: number;
}

const ENGINES: Engine[] = [
  {
    id: 'claude',
    bin: 'claude',
    wrapper: 'src/persistent-session.ts',
    helpArgv: ['--help'],
    upstream: () => npmLatest('@anthropic-ai/claude-code'),
    session: { file: 'persistent-session.js', cls: 'PersistentClaudeSession' },
    liveCwd: 'repo',
  },
  {
    id: 'codex',
    bin: 'codex',
    wrapper: 'src/persistent-codex-session.ts',
    helpArgv: ['exec', '--help'],
    upstream: () => ghLatestStable('openai/codex', /^rust-v(\d+\.\d+\.\d+)$/),
    session: { file: 'persistent-codex-session.js', cls: 'PersistentCodexSession' },
    liveCwd: 'repo',
  },
  {
    id: 'agy',
    bin: 'agy',
    wrapper: 'src/persistent-agy-session.ts',
    helpArgv: ['--help'],
    upstream: null, // `agy update` upgrades in place; there is no check-only form.
    session: { file: 'persistent-agy-session.js', cls: 'PersistentAgySession' },
    liveCwd: 'repo',
  },
  {
    id: 'grok',
    bin: 'grok',
    wrapper: 'src/persistent-grok-session.ts',
    helpArgv: ['--help'],
    upstream: grokLatest,
    session: { file: 'persistent-grok-session.js', cls: 'PersistentGrokSession' },
    liveCwd: 'empty',
    // Free tier. Once its limit is hit, `grok -p` has been observed to hang
    // with nothing on either stream — in any directory, with or without the
    // leader — rather than exit with the usage-limit error it printed earlier
    // the same day. 90s is enough for a real turn (7–8s measured) and short
    // enough that a hang does not stall the whole sweep.
    liveTimeoutMs: 90_000,
  },
  // Cursor Agent — `cursor-agent`, never the bare `agent`, which xAI's installer
  // also claims. No check-only update command: the official installer names the
  // build it installs.
  {
    id: 'cursor',
    bin: 'cursor-agent',
    pinKey: 'cursor-agent',
    wrapper: 'src/persistent-cursor-session.ts',
    helpArgv: ['--help'],
    upstream: cursorLatest,
    session: { file: 'persistent-cursor-session.js', cls: 'PersistentCursorSession' },
    liveCwd: 'empty',
  },
  // OpenCode 1.x — npm `opencode-ai`, which stays on that line. Still supported
  // for callers on it, but this machine runs OpenCode 2, so the 1.x binary is
  // checked through OPENCODE1_BIN: install it into a scratch prefix
  // (`npm i --prefix <dir> opencode-ai@latest`) and point the variable at
  // `<dir>/node_modules/.bin/opencode`.
  {
    id: 'opencode',
    bin: process.env.OPENCODE1_BIN ?? '',
    missingBin:
      'OPENCODE1_BIN is not set — install opencode-ai into a scratch prefix and point it at that 1.x binary to check its flags and run a live turn',
    passBin: true,
    wrapper: 'src/persistent-opencode-session.ts',
    helpArgv: ['run', '--help'],
    upstream: () => npmLatest('opencode-ai'),
    session: { file: 'persistent-opencode-session.js', cls: 'PersistentOpencodeSession' },
    liveCwd: 'repo',
    otherLineFlags: ['--standalone', '--archived'],
  },
  // OpenCode 2 — npm `@opencode/cli` (what its installer downloads), and also
  // GitHub release binaries. Its first release, 2.2.0, went unseen for three
  // weeks because this sweep only asked `opencode-ai`. The installed `opencode`
  // is checked unless OPENCODE2_BIN names another binary.
  {
    id: 'opencode2',
    bin: process.env.OPENCODE2_BIN || 'opencode',
    passBin: true,
    wrapper: 'src/persistent-opencode-session.ts',
    helpArgv: ['run', '--help'],
    upstream: () => npmLatest('@opencode/cli'),
    session: { file: 'persistent-opencode-session.js', cls: 'PersistentOpencodeSession' },
    liveCwd: 'repo',
    otherLineFlags: ['--variant', '--pure'],
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Ran {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Ran> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    // stdin is closed, not left as a dangling pipe. The one-shot engines
    // (codex exec, grok -p, opencode run) read stdin when it is not a TTY and
    // block until EOF; the first live run of this script timed every one of
    // them out and blamed the wrapper. The opencode wrapper has carried this
    // exact fix for a long time — the script is allowed to be simpler than the
    // wrappers, not more ignorant than them.
    const p = spawn(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err || String(e), ms: Date.now() - t0 });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      // A timeout is reported as what it is, not as whatever the last stderr
      // line happened to be — that line was an unrelated plugin warning on the
      // run that first exposed this.
      if (timedOut) err = `timed out after ${Math.round(timeoutMs / 1000)}s` + (err ? `\n${err}` : '');
      resolve({ code: timedOut ? null : code, out, err, ms: Date.now() - t0 });
    });
  });
}

function safeJson(s: string): Record<string, any> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function npmLatest(pkg: string): Promise<string | null> {
  const r = await run('npm', ['view', pkg, 'version'], { timeoutMs: 60_000 });
  const v = r.out.trim().split('\n').pop()?.trim();
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

// The newest stable release whose tag matches. It reads a full page: codex put
// 26 prereleases in front of 0.154.0 in eight days, a 15-release window came
// back empty, and the column read "?". GitHub's own `releases/latest` is no
// shortcut — the codex repo also cuts stable `python-v*` releases.
async function ghLatestStable(repo: string, tagRe: RegExp): Promise<string | null> {
  // `gh api repos/<repo>/releases?per_page=100` carries every release body with
  // it. On openai/codex that payload is big enough that GitHub answers 504, so
  // the lookup went blind for a structural reason rather than a flaky one —
  // reproducibly, on 2026-09-23. `gh release list` asks for the three fields
  // this needs and comes back in under two seconds.
  const r = await run(
    'gh',
    [
      'release',
      'list',
      '--repo',
      repo,
      '--limit',
      '100',
      '--json',
      'tagName,isPrerelease,isDraft',
      '--jq',
      '.[] | select(.isPrerelease == false and .isDraft == false) | .tagName',
    ],
    { timeoutMs: 60_000 },
  );
  // An empty result is already a regression, but "the API call failed" and "no
  // release matched" read identically in that message. Say which, or the next
  // reader re-runs the whole sweep to find out.
  if (r.code !== 0) {
    const reason = r.err.trim().split('\n').pop() ?? `exit ${r.code}`;
    console.warn(`[sweep] gh api ${repo} failed: ${reason}`);
    return null;
  }
  for (const line of r.out.split('\n')) {
    const m = line.trim().match(tagRe);
    if (m) return m[1];
  }
  return null;
}

// The updater's own check-only mode. A self-report — grok's updater has said
// "up to date" wrongly before — so the weekly pass still runs `grok update`.
/** The build Cursor's official installer (cursor.com/install) downloads. */
async function cursorLatest(): Promise<string | null> {
  try {
    const res = await fetch('https://cursor.com/install', { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return (await res.text()).match(/lab\/(\d{4}\.\d{2}\.\d{2})-[0-9a-f]+\//)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function grokLatest(): Promise<string | null> {
  const r = await run('grok', ['update', '--check', '--json'], { timeoutMs: 60_000 });
  const v = safeJson(r.out)?.latestVersion;
  return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

/**
 * Every `--flag` the CLI's help advertises. camelCase counts: lowercase-only
 * matching cut `--allowedTools` to `--allowed` on both sides of the comparison.
 */
function flagsFromHelp(help: string): Set<string> {
  const out = new Set<string>();
  for (const m of help.matchAll(/(?:^|[\s,[(])(--[a-zA-Z][a-zA-Z0-9-]*)/gm)) out.add(m[1]);
  return out;
}

/** Every `'--flag'` literal the wrapper source passes. */
function flagsFromWrapper(file: string): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/'(--[a-zA-Z][a-zA-Z0-9-]*)'/g)) out.add(m[1]);
  return out;
}

/**
 * The subcommands a CLI's top-level help lists, under whichever heading it
 * uses (`Commands:`, `Available subcommands:`, `SUBCOMMANDS`). Only lines at
 * the first entry's indentation are entries; deeper ones continue a
 * description. `opencode run [message..]` names the binary first.
 */
function commandsFromHelp(help: string, bin: string): Set<string> {
  const out = new Set<string>();
  const lines = help.split('\n');
  const binName = path.basename(bin);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(commands|subcommands|available (sub)?commands)\s*:?\s*$/i.test(lines[i])) continue;
    let indent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        if (indent >= 0) break;
        continue;
      }
      const lead = line.length - line.trimStart().length;
      if (lead === 0) break;
      if (indent < 0) indent = lead;
      if (lead !== indent) continue;
      const words = line.trim().split(/\s+/);
      let name = words[0] === binName ? words[1] : words[0];
      if (!name || name.startsWith('[') || name.startsWith('<')) continue;
      name = name.split('|')[0].replace(/,$/, '');
      if (name && name !== 'help') out.add(name);
    }
  }
  return out;
}

/**
 * The flags and subcommands already looked at, per engine, each with the
 * decision and its reason (scripts/sweep-reviewed.json). What the CLI offers
 * and the wrapper does not use is listed until it has a decision here, so
 * what a week adds is a short list rather than the same long one.
 */
interface Reviewed {
  flags?: Record<string, string>;
  commands?: Record<string, string>;
}
function reviewedFor(id: string): Reviewed {
  const file = path.join(ROOT, 'scripts', 'sweep-reviewed.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Reviewed>;
  return all[id] ?? {};
}

/**
 * The "Tested Version" column of the engine table in AGENTS.md, keyed by CLI.
 * A CLI cell such as `` `opencode` 2.x `` names a second major line of the same
 * binary and is keyed `opencode2`.
 */
function pins(): Record<string, string> {
  const md = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of md.split('\n')) {
    const m = line.match(/^\|[^|]+\|\s*`([a-z][a-z-]*)`(?:\s+(\d+)\.x)?\s*\|\s*([\d.]+)\s*\|/);
    if (m) out[`${m[1]}${m[2] ?? ''}`] = m[3];
  }
  return out;
}

function installedVersion(out: string): string | null {
  return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

// ─── Report ─────────────────────────────────────────────────────────────────

interface EngineReport {
  id: string;
  installed: string | null;
  pinned: string | null;
  upstream: string | null | 'n/a';
  /** Flags the wrapper passes that the binary's --help no longer lists. Candidates, not verdicts. */
  notAdvertised: string[];
  /** Flags the binary advertises that the wrapper does not reference and that have no recorded decision. */
  unreferenced: string[];
  /** Subcommands the binary lists that have no recorded decision. */
  unreviewedCommands: string[];
  /** Decisions recorded for flags or subcommands the binary no longer lists. */
  staleReviewed: string[];
  live: { ok: boolean; ms: number; note?: string } | 'skipped';
  /** Why the engine was only partly checked. */
  note?: string;
}

interface Report {
  at: string;
  engines: EngineReport[];
  acp: { ok: boolean; note?: string };
  mcp: { ok: boolean; version?: string; note?: string };
  registry: RegistryReport;
  regressions: string[];
}

async function sweepEngine(e: Engine, pinned: string | null, live: boolean): Promise<EngineReport> {
  if (!e.bin) {
    // The upstream lookup still runs: a newer release than the pin is the one
    // thing this report has to say about an engine that is not installed.
    const upstream = e.upstream ? await e.upstream() : 'n/a';
    return {
      id: e.id,
      installed: null,
      pinned,
      upstream,
      notAdvertised: [],
      unreferenced: [],
      unreviewedCommands: [],
      staleReviewed: [],
      live: 'skipped',
      note: e.missingBin,
    };
  }
  const ver = await run(e.bin, ['--version']);
  const installed = installedVersion(ver.out + ver.err);
  const upstream = e.upstream ? await e.upstream() : 'n/a';

  const help = await run(e.bin, e.helpArgv);
  const cliFlags = flagsFromHelp(help.out + help.err);
  const ours = flagsFromWrapper(e.wrapper);
  for (const f of e.otherLineFlags ?? []) ours.delete(f);
  const notAdvertised = [...ours].filter((f) => !cliFlags.has(f)).sort();
  const reviewed = reviewedFor(e.id);
  const unreferenced = [...cliFlags]
    .filter((f) => !ours.has(f) && !['--help', '--version'].includes(f) && !(f in (reviewed.flags ?? {})))
    .sort();
  const top = await run(e.bin, e.commandsArgv ?? ['--help']);
  const cliCommands = commandsFromHelp(top.out + top.err, e.bin);
  const unreviewedCommands = [...cliCommands].filter((c) => !(c in (reviewed.commands ?? {}))).sort();
  const staleReviewed = [
    ...Object.keys(reviewed.flags ?? {}).filter((f) => !cliFlags.has(f)),
    ...Object.keys(reviewed.commands ?? {})
      .filter((c) => cliCommands.size > 0 && !cliCommands.has(c))
      .map((c) => `command ${c}`),
  ].sort();

  let liveResult: EngineReport['live'] = 'skipped';
  if (live) {
    const cwd = e.liveCwd === 'empty' ? fs.mkdtempSync(path.join(os.tmpdir(), `sweep-${e.id}-`)) : ROOT;
    const t0 = Date.now();
    let ok = false;
    let note: string | undefined;
    try {
      const mod = await import(path.join(ROOT, 'dist', 'src', e.session.file));
      const Cls = mod[e.session.cls];
      const config = { name: `sweep-${e.id}`, cwd, permissionMode: 'bypassPermissions' };
      const session = e.passBin ? new Cls(config, e.bin) : new Cls(config);
      const result: Promise<unknown> = new Promise((resolve) => session.once('result', resolve));
      session.on('log', (m: unknown) => {
        const line = String(m);
        if (/usage limit|rate limit|quota/i.test(line)) note = 'usage limit';
      });
      await session.start();
      await session.send('Reply with exactly: OK', { waitForComplete: true, timeout: e.liveTimeoutMs ?? 240_000 });
      // The persistent claude wrapper resolves send() before the turn ends and
      // reports the outcome on its `result` event; one-shot wrappers have
      // already finished by now, so this only waits when there is something
      // to wait for.
      await Promise.race([result, new Promise((r) => setTimeout(r, e.liveTimeoutMs ?? 240_000))]);
      const stats = session.getStats();
      ok = stats.turnsSucceeded >= 1;
      if (!ok && !note) {
        note =
          stats.turns === 0
            ? 'no turn completed — silent hang (grok on a spent free tier does this); try `grok -p` by hand'
            : `turnsSucceeded=${stats.turnsSucceeded} of ${stats.turns}`;
      }
      await session.stop();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      note = /usage limit|rate limit|quota/i.test(msg) ? 'usage limit' : msg.split('\n')[0].slice(0, 120);
    }
    liveResult = { ok, ms: Date.now() - t0, ...(ok ? {} : { note }) };
    if (e.liveCwd === 'empty') fs.rmSync(cwd, { recursive: true, force: true });
  }

  return {
    id: e.id,
    installed,
    pinned,
    upstream,
    notAdvertised,
    unreferenced,
    unreviewedCommands,
    staleReviewed,
    live: liveResult,
  };
}

async function acpSmoke(): Promise<Report['acp']> {
  const entry = path.join(ROOT, 'dist', 'bin', 'acp-server.js');
  if (!fs.existsSync(entry)) return { ok: false, note: 'dist/bin/acp-server.js missing — run npm run build' };
  const r = await new Promise<Ran>((resolve) => {
    const t0 = Date.now();
    const p = execFile(process.execPath, [entry], { timeout: 20_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? null : 0, out: String(stdout), err: String(stderr), ms: Date.now() - t0 }),
    );
    p.stdin?.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }) + '\n',
    );
  });
  const lines = r.out.split('\n').filter((l) => l.trim());
  const pure = lines.length > 0 && lines.every((l) => safeJson(l)?.jsonrpc === '2.0');
  return pure ? { ok: true } : { ok: false, note: 'stdout carried something other than JSON-RPC frames' };
}

async function mcpSmoke(): Promise<Report['mcp']> {
  const entry = path.join(ROOT, 'dist', 'bin', 'mcp-server.js');
  if (!fs.existsSync(entry)) return { ok: false, note: 'dist/bin/mcp-server.js missing — run npm run build' };
  const r = await new Promise<Ran>((resolve) => {
    const t0 = Date.now();
    const p = execFile(process.execPath, [entry], { timeout: 20_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? null : 0, out: String(stdout), err: String(stderr), ms: Date.now() - t0 }),
    );
    p.stdin?.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sweep', version: '0' } },
      }) + '\n',
    );
  });
  const first = safeJson(r.out.split('\n').find((l) => l.trim()) ?? '');
  const version = first?.result?.serverInfo?.version;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!version) return { ok: false, note: 'no initialize result' };
  if (version !== pkg) return { ok: false, version, note: `reports ${version}, package.json says ${pkg}` };
  return { ok: true, version };
}

// ─── Registry drift ─────────────────────────────────────────────────────────
//
// The other half of the weekly check, and the half nobody was doing. Every
// regression this sweep caught in its first month was in a wrapper; the ones it
// missed were in `src/models.ts`, where a vendor repriced a model and the
// registry kept the launch number. Nothing goes red for that — costs are just
// reported wrong, indefinitely. It happened to all three GPT-5.6 tiers at once,
// over-reporting one of them fivefold, and the unit test meant to catch it had
// pinned the same stale literals, so it drifted along in step and stayed green.
//
// Both vendors publish their price tables as markdown, so reading them needs no
// model and no HTML parsing: fetch, find the table, split on pipes.
//
// A source that cannot be fetched is a regression, not a skip. An unverified
// pass is exactly what let a spent Grok quota carry a pin for a week.

interface PublishedPrice {
  id: string;
  input: number;
  cached: number;
  output: number;
  /** Marked retired or deprecated on the vendor's page — still priced, no longer offered. */
  retired?: boolean;
}

interface RegistryDrift {
  id: string;
  field: 'input' | 'cached' | 'output';
  ours: number | undefined;
  published: number;
}

interface RegistryReport {
  checked: number;
  drift: RegistryDrift[];
  /** Priced by the vendor and selectable by the engine binary, but unregistered. */
  unregistered: string[];
  notes: string[];
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Header cells and body rows of the markdown table following `heading`. */
function tableUnder(md: string, heading: string): { header: string[]; rows: string[][] } {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  const header: string[] = [];
  const rows: string[][] = [];
  if (start < 0) return { header, rows };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) {
      if (header.length) break;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (!header.length) {
      header.push(...cells);
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return { header, rows };
}

/** First dollar amount in a cell; null for a `-` placeholder. */
function money(cell: string): number | null {
  const m = cell.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

async function openaiPrices(): Promise<{ prices: PublishedPrice[]; note?: string }> {
  const md = await fetchText('https://developers.openai.com/api/docs/pricing.md');
  if (!md) return { prices: [], note: 'openai prices NOT verified — pricing table could not be fetched' };
  // Standard tier, short-context columns, found by header name. OpenAI publishes
  // four identically shaped tables per model (Standard, Batch, Flex, Fast);
  // reading the wrong one is how o4-mini ended up in this repo at half price.
  // It has also reordered the columns (output moved ahead of cached input),
  // which a positional read turned into fourteen false drifts. The long-context
  // columns are a separate tier the registry does not model, as `src/models.ts`
  // states at its GPT-5.5 entry.
  const { header, rows } = tableUnder(md, '### Standard pricing data');
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const iInput = col(/^(short context )?input$/i);
  const iCached = col(/^(short context )?cached input$/i);
  const iOutput = col(/^(short context )?output$/i);
  if (iInput < 1 || iCached < 1 || iOutput < 1) {
    return { prices: [], note: `openai Standard pricing columns not found — header is: ${header.join(' | ')}` };
  }
  const prices: PublishedPrice[] = [];
  for (const cells of rows) {
    const id = cells[0].replace(/\s*\(.*$/, '').trim();
    const input = money(cells[iInput] ?? '');
    const cached = money(cells[iCached] ?? '');
    const output = money(cells[iOutput] ?? '');
    if (!id || input === null || cached === null || output === null) continue;
    prices.push({ id, input, cached, output });
  }
  return prices.length
    ? { prices }
    : { prices: [], note: 'openai Standard pricing table parsed empty — format changed?' };
}

async function xaiPrices(): Promise<{ prices: PublishedPrice[]; note?: string }> {
  const md = await fetchText('https://docs.x.ai/docs/models.md');
  if (!md) return { prices: [], note: 'xai prices NOT verified — pricing table could not be fetched' };
  // One row per prompt-length tier ("< 200k prompt tokens" / "≥ 200k"). The
  // registry carries the base tier, so the upper rows are skipped.
  const { header, rows } = tableUnder(md, '### Text API Pricing');
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const iInput = col(/^input\b/i);
  const iCached = col(/^cached input\b/i);
  const iOutput = col(/^output\b/i);
  if (iInput < 1 || iCached < 1 || iOutput < 1) {
    return { prices: [], note: `xai pricing columns not found — header is: ${header.join(' | ')}` };
  }
  const prices: PublishedPrice[] = [];
  for (const cells of rows) {
    if (/≥|>=/.test(cells[0])) continue;
    const id = cells[0].replace(/\s*\(.*$/, '').trim();
    const input = money(cells[iInput] ?? '');
    const cached = money(cells[iCached] ?? '');
    const output = money(cells[iOutput] ?? '');
    if (!id || input === null || cached === null || output === null) continue;
    prices.push({ id, input, cached, output });
  }
  return prices.length ? { prices } : { prices: [], note: 'xai pricing table parsed empty — format changed?' };
}

/**
 * What `agy models` lists as selectable for the signed-in account, with effort
 * suffixes stripped: agy lists only effort-qualified slugs
 * (`gemini-4-hydrogen-xhigh`), and the registry holds the base model.
 */
async function agyModelBases(): Promise<{ bases: Set<string>; xhigh: Set<string> } | null> {
  const r = await run('agy', ['models'], { timeoutMs: 60_000 });
  const bases = new Set<string>();
  const xhigh = new Set<string>();
  for (const m of r.out.matchAll(/^([a-z0-9][a-z0-9.-]+)\t/gm)) {
    const base = m[1].replace(/-(?:low|medium|high|xhigh|max)$/, '');
    bases.add(base);
    if (m[1].endsWith('-xhigh')) xhigh.add(base);
  }
  return bases.size ? { bases, xhigh } : null;
}

/** What `grok models` lists as selectable for the logged-in account. */
async function grokModelIds(): Promise<Set<string> | null> {
  const r = await run('grok', ['models'], { timeoutMs: 60_000 });
  const ids = new Set(r.out.match(/grok-[0-9][a-z0-9.-]*/g) ?? []);
  return ids.size ? ids : null;
}

async function anthropicPrices(): Promise<{ prices: PublishedPrice[]; note?: string }> {
  const md = await fetchText('https://docs.claude.com/en/docs/about-claude/pricing.md');
  if (!md) return { prices: [], note: 'anthropic prices NOT verified — pricing table could not be fetched' };
  // Keyed by display name ("Claude Opus 4.8"), not by API id, and the name cell
  // carries parenthetical status links. Columns: name | input | 5m write |
  // 1h write | cache hits | output. "Cache hits" is what the registry calls
  // `cached`; the two write columns are derived from input and not stored.
  const prices: PublishedPrice[] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('| Claude ')) continue;
    const cells = t
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    // A model priced by prompt length has one row per tier ("for prompts up to
    // 100,000 tokens" / "over"), both naming the same model. The registry is
    // single-tier and carries the base tier; reading every row let the upper
    // tier overwrite it and report the correct entry as drifted.
    if (/\bover\b[^)]*tokens/i.test(cells[0])) continue;
    const id = cells[0]
      .replace(/\s*\(.*$/, '')
      .trim()
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/\s+/g, '-');
    const input = money(cells[1]);
    const cached = money(cells[4]);
    const output = money(cells[5]);
    if (!id || input === null || cached === null || output === null) continue;
    const retired = /retired|deprecat/i.test(cells[0]);
    prices.push({ id, input, cached, output, ...(retired ? { retired } : {}) });
  }
  return prices.length ? { prices } : { prices: [], note: 'anthropic pricing table parsed empty — format changed?' };
}

/**
 * Model ids an engine binary can actually select, found by scanning the binary
 * for `pattern` (which must carry the `g` flag).
 *
 * Read in chunks rather than whole: the codex binary is ~210 MB, and this runs
 * on a box with an OOM history. The overlap keeps an id straddling a chunk
 * boundary from being missed.
 */
async function modelIdsInBinary(bin: string, pattern: RegExp): Promise<Set<string> | null> {
  const ids = new Set<string>();
  // Through PATH first: `bin` is a command name, and `readlink -f` on a bare name
  // resolves it against the working directory, not PATH. That is how this scan
  // returned an empty set on every run from 7.1.1 until it was noticed — and an
  // empty set reads exactly like "no new models", so nothing ever looked wrong.
  const onPath = (await run('which', [bin])).out.trim().split('\n')[0] ?? '';
  const target = onPath ? (await run('readlink', ['-f', onPath])).out.trim() || onPath : '';
  if (!target || !fs.existsSync(target)) return null;
  let fd: number;
  try {
    fd = fs.openSync(target, 'r');
  } catch {
    return null;
  }
  try {
    const CHUNK = 4 << 20;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let tail = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const text = tail + buf.subarray(0, n).toString('latin1');
      for (const m of text.matchAll(pattern)) ids.add(m[0].replace(/[.-]+$/, ''));
      tail = text.slice(-64);
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return ids.size ? ids : null;
}

async function sweepRegistry(codexBin: string, claudeBin: string): Promise<RegistryReport> {
  // Through the module's public lookup rather than a private table, so this
  // check cannot quietly stop matching when the registry's internals move.
  // `lookupModel` also resolves aliases, so the id equality below matters: it
  // keeps an alias from being compared against the entry it points at.
  const { lookupModel, getAliases } = (await import(path.join(ROOT, 'src', 'models.ts'))) as {
    lookupModel: (
      id: string,
    ) => { id: string; engine: string; pricing: { input: number; output: number; cached?: number } } | undefined;
    getAliases: () => Record<string, string>;
  };
  const { AGY_XHIGH_MODELS } = (await import(path.join(ROOT, 'src', 'persistent-agy-session.ts'))) as {
    AGY_XHIGH_MODELS: RegExp;
  };
  const registered = (id: string) => {
    const m = lookupModel(id);
    return m && m.id === id ? m.pricing : undefined;
  };

  const notes: string[] = [];
  const published: PublishedPrice[] = [];
  for (const src of [await openaiPrices(), await anthropicPrices(), await xaiPrices()]) {
    if (src.note) notes.push(src.note);
    published.push(...src.prices);
  }

  const drift: RegistryDrift[] = [];
  let checked = 0;
  for (const p of published) {
    const mine = registered(p.id);
    if (!mine) continue;
    checked++;
    for (const field of ['input', 'cached', 'output'] as const) {
      if (mine[field] !== p[field]) drift.push({ id: p.id, field, ours: mine[field], published: p[field] });
    }
  }

  // Only flag an unregistered model the engine can really select. A vendor
  // prices plenty this project can never reach, and a list that cries wolf is
  // the list nobody reads. `gpt-5.6-pro` and `gpt-5.6-cyber` were each left out
  // for one of these two halves failing.
  //
  // Claude is held to the same test against the claude binary. It was not at
  // first, so a new Claude model would have passed this sweep silently and been
  // priced as the fallback until someone asked whether it had shipped. Retired
  // rows are excluded: the binary keeps their ids for old sessions, and
  // flagging them every week is exactly the noise this filter exists to avoid.
  //
  // A binary that cannot be found or yields no ids at all is a regression, not
  // an empty result: this check once passed every week while scanning nothing.
  const codexIds = await modelIdsInBinary(codexBin, /gpt-[0-9][a-z0-9.-]*/g);
  const claudeIds = await modelIdsInBinary(claudeBin, /claude-(?:opus|sonnet|haiku|fable|mythos)-[0-9][a-z0-9-]*/g);
  if (!codexIds) notes.push(`missing-model check NOT run for codex — no model ids found in the \`${codexBin}\` binary`);
  if (!claudeIds)
    notes.push(`missing-model check NOT run for claude — no model ids found in the \`${claudeBin}\` binary`);
  // grok's binary carries no model list: the account's models come from xAI at
  // run time, which is how grok-4.7 became the default without this sweep
  // noticing. `grok models` asks the same source the CLI does.
  const grokIds = await grokModelIds();
  if (!grokIds) notes.push('missing-model check NOT run for grok — `grok models` listed no model');
  const selectable = (p: PublishedPrice) =>
    p.id.startsWith('gpt-')
      ? !!codexIds?.has(p.id)
      : p.id.startsWith('grok-')
        ? !!grokIds?.has(p.id)
        : p.id.startsWith('claude-') && !p.retired && !!claudeIds?.has(p.id);
  const unregistered = published
    .filter((p) => selectable(p) && !registered(p.id))
    .map((p) => p.id)
    .sort();

  // agy is checked against its own list in both directions, since this sweep
  // fetches no Google price table. A Gemini model agy offers that the registry
  // lacks would be priced as the Flash default and measured against the wrong
  // window. An agy alias whose model agy no longer offers is worse: every turn
  // that names it fails. `agy-pro` pointed at gemini-3.1-pro for a week after
  // agy 1.5.8 dropped it, and this sweep reported nothing. The Claude and
  // GPT-OSS models agy proxies, and its orchestrator entry, are not Gemini
  // API models and are left out.
  const agyList = await agyModelBases();
  const agyBases = agyList?.bases;
  if (!agyList || !agyBases) {
    notes.push('missing-model check NOT run for agy — `agy models` listed no model');
  } else {
    // The wrapper clamps effort to a model's top tier. A model agy lists with an
    // `-xhigh` tier that the wrapper does not know caps `xhigh`/`max` at `high`
    // without a word (gemini-4-neon arrived with one in agy 1.5.12); one the
    // wrapper sends `xhigh` that agy no longer lists fails the turn.
    for (const base of [...agyList.xhigh].sort()) {
      if (base.startsWith('gemini-') && !AGY_XHIGH_MODELS.test(base)) {
        notes.push(`agy lists ${base}-xhigh, but the agy wrapper caps ${base} at high (AGY_XHIGH_MODELS)`);
      }
    }
    for (const base of [...agyBases].sort()) {
      if (AGY_XHIGH_MODELS.test(base) && !agyList.xhigh.has(base)) {
        notes.push(`the agy wrapper sends ${base} xhigh, which \`agy models\` no longer lists`);
      }
    }
    for (const base of [...agyBases].sort()) {
      if (base.startsWith('gemini-') && !base.includes('orchestrator') && !registered(base)) {
        unregistered.push(`${base} (agy)`);
      }
    }
    for (const [alias, target] of Object.entries(getAliases())) {
      if (lookupModel(target)?.engine === 'agy' && !agyBases.has(target)) {
        notes.push(`agy alias ${alias} → ${target}, which \`agy models\` no longer lists`);
      }
    }
  }

  return { checked, drift, unregistered, notes };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const live = !argv.includes('--no-live');
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

  const pinned = pins();
  const engines: EngineReport[] = [];
  for (const e of ENGINES) engines.push(await sweepEngine(e, pinned[e.pinKey ?? e.id] ?? null, live));
  const acp = await acpSmoke();
  const mcp = await mcpSmoke();
  const registry = await sweepRegistry(
    ENGINES.find((e) => e.id === 'codex')!.bin,
    ENGINES.find((e) => e.id === 'claude')!.bin,
  );

  const regressions: string[] = [];
  for (const e of engines) {
    if (e.live !== 'skipped' && !e.live.ok && e.live.note !== 'usage limit')
      regressions.push(`${e.id}: live turn failed (${e.live.note})`);
    // A lookup that exists and returns nothing did not check. Reading "?" as
    // "nothing newer" is how an engine stays behind unnoticed.
    if (e.upstream === null) regressions.push(`${e.id}: upstream version lookup returned nothing`);
    // A flag or subcommand nobody has decided on is a decision still owed:
    // headless ones get wired, the rest get a reason in sweep-reviewed.json.
    // As a note it was read past for months.
    if (e.unreferenced.length) regressions.push(`${e.id}: unreviewed flag(s): ${e.unreferenced.join(' ')}`);
    if (e.unreviewedCommands.length)
      regressions.push(`${e.id}: unreviewed subcommand(s): ${e.unreviewedCommands.join(' ')}`);
  }
  if (!acp.ok) regressions.push(`acp: ${acp.note}`);
  if (!mcp.ok) regressions.push(`mcp: ${mcp.note}`);
  for (const d of registry.drift)
    regressions.push(`registry: ${d.id} ${d.field} is ${d.ours ?? 'not set'}, published ${d.published}`);
  // An unreadable price source is a regression too. It means this run did not
  // check the prices, and calling that a pass is how a stale number keeps its
  // cover for another week.
  for (const n of registry.notes) regressions.push(`registry: ${n}`);

  const report: Report = { at: new Date().toISOString(), engines, acp, mcp, registry, regressions };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`engine    installed  pinned     upstream   flags(new/unlisted)  live`);
    for (const e of engines) {
      const drift = e.installed && e.pinned && e.installed !== e.pinned ? '*' : ' ';
      const up = e.upstream === 'n/a' ? 'n/a' : (e.upstream ?? '?');
      // An engine that is not installed is compared against its pin instead.
      const have = e.installed ?? e.pinned;
      const behind = typeof e.upstream === 'string' && e.upstream !== 'n/a' && have && e.upstream !== have ? '!' : ' ';
      const liveS =
        e.live === 'skipped' ? 'skipped' : e.live.ok ? `ok ${(e.live.ms / 1000).toFixed(1)}s` : `FAIL ${e.live.note}`;
      console.log(
        `${e.id.padEnd(9)} ${(e.installed ?? '?').padEnd(10)}${drift}${(e.pinned ?? '?').padEnd(10)} ${up.padEnd(10)}${behind} ${String(e.unreferenced.length).padStart(3)}/${String(e.notAdvertised.length).padEnd(3)}              ${liveS}`,
      );
    }
    console.log(
      `\nacp: ${acp.ok ? 'ok' : 'FAIL ' + acp.note}    mcp: ${mcp.ok ? 'ok ' + mcp.version : 'FAIL ' + mcp.note}`,
    );
    console.log(
      `registry: ${registry.checked} model(s) checked against published prices, ${registry.drift.length} drifted`,
    );
    console.log(
      `\n* installed differs from the AGENTS.md pin    ! upstream is ahead of installed (of the pin, if not installed)`,
    );
    for (const e of engines) if (e.note) console.log(`  ${e.id}: ${e.note}`);
    for (const d of registry.drift)
      console.log(`  DRIFT ${d.id} ${d.field}: registry ${d.ours ?? 'not set'} vs published ${d.published}`);
    if (registry.unregistered.length)
      console.log(
        `\nunregistered but selectable by an engine (judge before adding): ${registry.unregistered.join(' ')}`,
      );
    for (const e of engines) {
      if (e.notAdvertised.length)
        console.log(
          `\nnot in ${e.id} --help (verify by invocation before treating as removed): ${e.notAdvertised.join(', ')}`,
        );
      if (e.unreferenced.length || e.unreviewedCommands.length)
        console.log(
          `unreviewed on ${e.id} (wire if headless, else record why in scripts/sweep-reviewed.json): ` +
            [...e.unreferenced, ...e.unreviewedCommands.map((c) => `cmd:${c}`)].join(' '),
        );
      if (e.staleReviewed.length)
        console.log(
          `reviewed on ${e.id} but no longer listed (drop from sweep-reviewed.json): ${e.staleReviewed.join(' ')}`,
        );
    }
    if (regressions.length) console.log(`\n${regressions.length} regression(s):\n  ${regressions.join('\n  ')}`);
    else console.log('\nno regressions');
  }
  process.exit(regressions.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
