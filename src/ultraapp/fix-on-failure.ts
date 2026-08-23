/**
 * Run the verification pipeline in a worktree, spawn a session to fix mechanical
 * errors on red, retry up to N rounds.
 *
 * As of 6.0.0 this is an adapter over `src/verify/`, not its own runner. The
 * logic it used to own — ordered steps, exit-code gating, byte-capped tails, the
 * fix loop — moved out to become mode-agnostic, and came back with the two
 * things it was missing: a per-step timeout (a wedged `npm test` used to hang
 * the pipeline forever) and an honoured `required` flag (the field was declared
 * here and never read, so every step was fatal).
 *
 * Not to be confused with src/autoloop/, which is a planner/coder/reviewer
 * message-bus orchestrator for a different problem shape.
 */

import path from 'node:path';
import os from 'node:os';
import { runContract, type FixerSpawner as VerifyFixerSpawner } from '../verify/runner.js';
import type { AcceptanceContract, CheckResult, ContractCheck } from '../verify/contract.js';

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ShellResult>;

export interface FixerArgs {
  worktreePath: string;
  failingCommand: string;
  tail: string;
}

export type FixerSpawner = (args: FixerArgs) => Promise<void>;

export interface FixOnFailureArgs {
  worktreePath: string;
  maxRounds: number;
  shell?: ShellRunner;
  spawnFixer?: FixerSpawner;
  /** Legacy step list. Each entry becomes a `command` check. */
  steps?: Array<{ cmd: string; args: string[]; required?: boolean; timeoutMs?: number }>;
  /** Full acceptance contract. Takes precedence over `steps`. */
  contract?: AcceptanceContract;
  /** Where screenshot-style checks drop files. Defaults to a temp dir. */
  artifactDir?: string;
}

export interface FixOnFailureResult {
  ok: boolean;
  rounds: number;
  lastError?: string;
  failingCommand?: string;
  /** Per-check outcomes, for an evidence bundle. Absent on stubbed results. */
  results?: CheckResult[];
}

const TEN_MIN = 10 * 60_000;

export const DEFAULT_STEPS: NonNullable<FixOnFailureArgs['steps']> = [
  { cmd: 'npm', args: ['install'] },
  { cmd: 'npm', args: ['run', 'build'] },
  { cmd: 'npm', args: ['test'] },
  { cmd: 'docker', args: ['build', '-t', 'ultraapp-fix:test', '.'] },
];

/** Translate the legacy step list into contract checks, `required` included this time. */
export function stepsToContract(
  steps: NonNullable<FixOnFailureArgs['steps']>,
  fixOnFailureRounds: number,
): AcceptanceContract {
  const checks: ContractCheck[] = steps.map((s, i) => ({
    id: `${s.cmd}-${i + 1}`,
    spec: { type: 'command', cmd: s.cmd, args: s.args, timeoutMs: s.timeoutMs ?? TEN_MIN },
    required: s.required !== false,
  }));
  return { id: 'fix-on-failure', checks, fixOnFailureRounds };
}

export async function runFixOnFailure(args: FixOnFailureArgs): Promise<FixOnFailureResult> {
  const contract = args.contract ?? stepsToContract(args.steps ?? DEFAULT_STEPS, args.maxRounds);
  const spawnFixer: VerifyFixerSpawner | undefined = args.spawnFixer
    ? ({ cwd, failingCheck, tail }) => args.spawnFixer!({ worktreePath: cwd, failingCommand: failingCheck, tail })
    : undefined;

  const { results, passed, rounds } = await runContract(
    { ...contract, fixOnFailureRounds: args.maxRounds },
    {
      cwd: args.worktreePath,
      artifactDir: args.artifactDir ?? path.join(os.tmpdir(), 'clawo-fix-artifacts'),
      exec: args.shell ? shellToExec(args.shell) : undefined,
    },
    spawnFixer,
  );

  const failing = results.find((r) => r.required && !r.passed);
  return {
    ok: passed,
    rounds,
    lastError: failing ? (failing.tail ?? failing.detail).slice(0, 500) : undefined,
    failingCommand: failing?.detail,
    results,
  };
}

/** Keep the injectable `ShellRunner` seam callers already depend on. */
function shellToExec(shell: ShellRunner) {
  return async (cmd: string, cmdArgs: string[], opts: { cwd?: string }) => {
    const r = await shell(cmd, cmdArgs, { cwd: opts.cwd ?? process.cwd() });
    return { code: r.ok ? 0 : 1, out: r.stdout, err: r.stderr, timedOut: false, durationMs: 0 };
  };
}
