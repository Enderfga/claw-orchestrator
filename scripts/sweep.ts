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
  bin: string;
  /** The wrapper whose `'--flag'` literals define what we pass. */
  wrapper: string;
  /** argv that prints the headless subcommand's help. */
  helpArgv: string[];
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
    upstream: null, // `grok update` upgrades in place, and has reported "up to date" wrongly before.
    session: { file: 'persistent-grok-session.js', cls: 'PersistentGrokSession' },
    liveCwd: 'empty',
    // Free tier. Once its limit is hit, `grok -p` has been observed to hang
    // with nothing on either stream — in any directory, with or without the
    // leader — rather than exit with the usage-limit error it printed earlier
    // the same day. 90s is enough for a real turn (7–8s measured) and short
    // enough that a hang does not stall the whole sweep.
    liveTimeoutMs: 90_000,
  },
  {
    id: 'opencode',
    bin: 'opencode',
    wrapper: 'src/persistent-opencode-session.ts',
    helpArgv: ['run', '--help'],
    upstream: () => npmLatest('opencode-ai'),
    session: { file: 'persistent-opencode-session.js', cls: 'PersistentOpencodeSession' },
    liveCwd: 'repo',
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

async function ghLatestStable(repo: string, tagRe: RegExp): Promise<string | null> {
  const r = await run(
    'gh',
    ['api', `repos/${repo}/releases?per_page=15`, '--jq', '.[] | select(.prerelease==false) | .tag_name'],
    {
      timeoutMs: 60_000,
    },
  );
  for (const line of r.out.split('\n')) {
    const m = line.trim().match(tagRe);
    if (m) return m[1];
  }
  return null;
}

/** Every `--flag` the CLI's help advertises. */
function flagsFromHelp(help: string): Set<string> {
  const out = new Set<string>();
  for (const m of help.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/gm)) out.add(m[1]);
  return out;
}

/** Every `'--flag'` literal the wrapper source passes. */
function flagsFromWrapper(file: string): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/'(--[a-z][a-z0-9-]*)'/g)) out.add(m[1]);
  return out;
}

/** The "Tested Version" column of the engine table in CLAUDE.md. */
function pins(): Record<string, string> {
  const md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*\S+\s*\|\s*`([a-z]+)`\s*\|\s*([\d.]+)\s*\|/);
    if (m) out[m[1]] = m[2];
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
  /** Flags the binary advertises that the wrapper does not reference. */
  unreferenced: string[];
  live: { ok: boolean; ms: number; note?: string } | 'skipped';
}

interface Report {
  at: string;
  engines: EngineReport[];
  acp: { ok: boolean; note?: string };
  mcp: { ok: boolean; version?: string; note?: string };
  regressions: string[];
}

async function sweepEngine(e: Engine, pinned: string | null, live: boolean): Promise<EngineReport> {
  const ver = await run(e.bin, ['--version']);
  const installed = installedVersion(ver.out + ver.err);
  const upstream = e.upstream ? await e.upstream() : 'n/a';

  const help = await run(e.bin, e.helpArgv);
  const cliFlags = flagsFromHelp(help.out + help.err);
  const ours = flagsFromWrapper(e.wrapper);
  const notAdvertised = [...ours].filter((f) => !cliFlags.has(f)).sort();
  const unreferenced = [...cliFlags].filter((f) => !ours.has(f) && !['--help', '--version'].includes(f)).sort();

  let liveResult: EngineReport['live'] = 'skipped';
  if (live) {
    const cwd = e.liveCwd === 'empty' ? fs.mkdtempSync(path.join(os.tmpdir(), `sweep-${e.id}-`)) : ROOT;
    const t0 = Date.now();
    let ok = false;
    let note: string | undefined;
    try {
      const mod = await import(path.join(ROOT, 'dist', 'src', e.session.file));
      const Cls = mod[e.session.cls];
      const session = new Cls({ name: `sweep-${e.id}`, cwd, permissionMode: 'bypassPermissions' });
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

  return { id: e.id, installed, pinned, upstream, notAdvertised, unreferenced, live: liveResult };
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const live = !argv.includes('--no-live');
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

  const pinned = pins();
  const engines: EngineReport[] = [];
  for (const e of ENGINES) engines.push(await sweepEngine(e, pinned[e.id] ?? null, live));
  const acp = await acpSmoke();
  const mcp = await mcpSmoke();

  const regressions: string[] = [];
  for (const e of engines) {
    if (e.live !== 'skipped' && !e.live.ok && e.live.note !== 'usage limit')
      regressions.push(`${e.id}: live turn failed (${e.live.note})`);
  }
  if (!acp.ok) regressions.push(`acp: ${acp.note}`);
  if (!mcp.ok) regressions.push(`mcp: ${mcp.note}`);

  const report: Report = { at: new Date().toISOString(), engines, acp, mcp, regressions };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`engine    installed  pinned     upstream   flags(new/unlisted)  live`);
    for (const e of engines) {
      const drift = e.installed && e.pinned && e.installed !== e.pinned ? '*' : ' ';
      const up = e.upstream === 'n/a' ? 'n/a' : (e.upstream ?? '?');
      const behind =
        typeof e.upstream === 'string' && e.upstream !== 'n/a' && e.installed && e.upstream !== e.installed ? '!' : ' ';
      const liveS =
        e.live === 'skipped' ? 'skipped' : e.live.ok ? `ok ${(e.live.ms / 1000).toFixed(1)}s` : `FAIL ${e.live.note}`;
      console.log(
        `${e.id.padEnd(9)} ${(e.installed ?? '?').padEnd(10)}${drift}${(e.pinned ?? '?').padEnd(10)} ${up.padEnd(10)}${behind} ${String(e.unreferenced.length).padStart(3)}/${String(e.notAdvertised.length).padEnd(3)}              ${liveS}`,
      );
    }
    console.log(
      `\nacp: ${acp.ok ? 'ok' : 'FAIL ' + acp.note}    mcp: ${mcp.ok ? 'ok ' + mcp.version : 'FAIL ' + mcp.note}`,
    );
    console.log(`\n* installed differs from the CLAUDE.md pin    ! upstream is ahead of installed`);
    for (const e of engines) {
      if (e.notAdvertised.length)
        console.log(
          `\nnot in ${e.id} --help (verify by invocation before treating as removed): ${e.notAdvertised.join(', ')}`,
        );
      if (e.unreferenced.length) console.log(`new on ${e.id} (judge AI-facing vs TUI): ${e.unreferenced.join(' ')}`);
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
