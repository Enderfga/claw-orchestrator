#!/usr/bin/env tsx
/**
 * Manual integration smoke runner for ultraapp.
 *
 * Usage:
 *   tsx scripts/test-ultraapp-integration.ts --trace=text-summariser
 *   tsx scripts/test-ultraapp-integration.ts --trace=all
 *   tsx scripts/test-ultraapp-integration.ts --trace=text-summariser --with-council [--with-deploy]
 *
 * Flags:
 *   --trace=<name|all>     Required. Reference trace(s) to run.
 *   --with-council         Run real council against an actual server.
 *                          Requires the dashboard to be running and Anthropic
 *                          credentials. NOT IMPLEMENTED in v1.0 — prints a
 *                          notice and skips. The replay-only path is the
 *                          load-bearing CI check.
 *   --with-deploy          Run docker build + run + URL hit. Same status
 *                          as --with-council.
 *
 * Without --with-council, only the spec-extraction-quality replay runs
 * (free, fast, ~1 second per trace).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACES_DIR = path.join(ROOT, 'src/__tests__/fixtures/ultraapp-traces');

interface Args {
  trace?: string;
  withCouncil: boolean;
  withDeploy: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { withCouncil: false, withDeploy: false };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    if (m[1] === 'trace') out.trace = m[2];
    else if (m[1] === 'with-council') out.withCouncil = true;
    else if (m[1] === 'with-deploy') out.withDeploy = true;
  }
  return out;
}

async function runReplay(trace: string): Promise<void> {
  const { replayTrace, stripVolatile } = await import('../src/__tests__/ultraapp/trace-replayer.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ua-int-${trace}-`));
  try {
    const file = path.join(TRACES_DIR, `${trace}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`trace fixture missing: ${file}`);
    const expectedFile = path.join(TRACES_DIR, 'expected', `${trace}.appspec.json`);
    if (!fs.existsSync(expectedFile)) {
      throw new Error(`expected snapshot missing: ${expectedFile}`);
    }
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    const { specJson } = await replayTrace(file, tmp);
    const got = JSON.stringify(stripVolatile(specJson), null, 2);
    const want = JSON.stringify(stripVolatile(expected), null, 2);
    if (got !== want) {
      throw new Error(`AppSpec mismatch (replay vs expected) for ${trace}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function listTraces(): string[] {
  return fs
    .readdirSync(TRACES_DIR)
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('_'))
    .map((f) => f.replace(/\.jsonl$/, ''));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.trace) {
    console.error('--trace=<name|all> required');
    process.exit(2);
  }
  const traces = args.trace === 'all' ? listTraces() : [args.trace];
  if (traces.length === 0) {
    console.error('no traces found');
    process.exit(2);
  }

  let pass = 0;
  let fail = 0;
  for (const trace of traces) {
    process.stdout.write(`\n=== ${trace} ===\n`);
    try {
      await runReplay(trace);
      pass++;
      console.log(`[${trace}] replay OK`);
      if (args.withCouncil) {
        console.log(
          `[${trace}] --with-council requested but not implemented in this script. ` +
            `Drive the dashboard manually: open Forge → + New, walk the trace, click Start Build.`,
        );
      }
      if (args.withDeploy) {
        console.log(
          `[${trace}] --with-deploy requested but not implemented in this script. ` +
            `After build-complete, the share card URL appears in chat — exercise it from a browser.`,
        );
      }
    } catch (e) {
      fail++;
      console.error(`[${trace}] FAIL: ${(e as Error).message}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
