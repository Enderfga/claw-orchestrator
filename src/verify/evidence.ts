/**
 * Evidence bundles — the machine-readable record of what was checked.
 *
 * A run's claim to be finished is only as good as what can be re-read after the
 * process that made it is gone. So every verifier attempt writes a directory:
 * the verdict and per-check results as JSON, the failure tails as plain text,
 * whatever files the checks produced (screenshots), and the patch the run
 * actually made, against the base commit recorded when it started.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { exec } from '../kernel/exec.js';
import { capturePatch, changedFilesSince, treeFingerprint, type ChangedFile } from './baseline.js';
import { contractPassed, type CheckResult } from './contract.js';

export interface EvidenceBundle {
  evidenceId: string;
  runId: string;
  /** Node that produced it, or `'run'` for a standalone `verify_run`. */
  node: string;
  contractId?: string;
  createdAt: string;
  cwd: string;
  baseSha?: string;
  headSha?: string;
  passed: boolean;
  /** Fix-on-red rounds consumed before this verdict. */
  rounds: number;
  results: CheckResult[];
  changedFiles: ChangedFile[];
  /**
   * Digest of the working tree at the moment the checks finished. The kernel
   * re-computes it when the run ends: if it moved, this bundle describes an
   * earlier tree and the verdict no longer applies to what is on disk.
   * Undefined outside a git repo, where we cannot tell.
   */
  treeFingerprint?: string;
}

export function evidenceRoot(runDir: string): string {
  return path.join(runDir, 'evidence');
}

export function evidenceDir(runDir: string, evidenceId: string): string {
  return path.join(evidenceRoot(runDir), evidenceId);
}

/**
 * `<node>-v<visit>-<attempt>` — stable, sortable, and readable in a ledger row.
 *
 * The visit is part of the id because the attempt alone is not unique across a
 * loop. `attempts` is the per-visit retry counter and restarts at 1 on every
 * fresh visit, so in the `solve` repair loop every pass through the verifier
 * produced `verify-01` and `writeEvidence` overwrote the previous bundle.json,
 * diff.patch and check logs — while both `evidence` events and the record's
 * `evidenceId` collapsed onto the one string. The final verdict stayed correct;
 * the history of what was wrong and what fixed it did not survive.
 */
export function makeEvidenceId(node: string, visit: number, attempt: number): string {
  const n = (x: number): string => String(x).padStart(2, '0');
  return `${node.replace(/[^\w.-]/g, '_')}-v${n(visit)}-${n(attempt)}`;
}

export interface WriteEvidenceArgs {
  runDir: string;
  runId: string;
  node: string;
  evidenceId: string;
  cwd: string;
  baseSha?: string;
  contractId?: string;
  results: CheckResult[];
  rounds: number;
  logger?: Logger;
}

/**
 * Write the bundle. Best-effort like the run ledger: a bundle that fails to land
 * must not change the verdict it is describing — the verdict is already decided
 * by `results`.
 */
export async function writeEvidence(args: WriteEvidenceArgs): Promise<EvidenceBundle> {
  const dir = evidenceDir(args.runDir, args.evidenceId);
  const head = await exec('git', ['-C', args.cwd, 'rev-parse', 'HEAD'], { timeoutMs: 60_000 });
  const headSha = head.code === 0 ? head.out.trim() : undefined;

  let changedFiles: ChangedFile[] = [];
  try {
    changedFiles = await changedFilesSince(args.cwd, args.baseSha);
  } catch (e) {
    args.logger?.warn?.(`[evidence] change listing failed: ${(e as Error).message}`);
  }

  const bundle: EvidenceBundle = {
    evidenceId: args.evidenceId,
    runId: args.runId,
    node: args.node,
    contractId: args.contractId,
    createdAt: new Date().toISOString(),
    cwd: args.cwd,
    baseSha: args.baseSha,
    headSha,
    passed: contractPassed(args.results),
    rounds: args.rounds,
    results: args.results,
    changedFiles,
    treeFingerprint: await treeFingerprint(args.cwd),
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle, null, 2));

    const logDir = path.join(dir, 'checks');
    let wroteLog = false;
    for (const r of args.results) {
      if (!r.tail) continue;
      if (!wroteLog) {
        fs.mkdirSync(logDir, { recursive: true });
        wroteLog = true;
      }
      fs.writeFileSync(path.join(logDir, `${r.id.replace(/[^\w.-]/g, '_')}.log`), r.tail);
    }

    try {
      const patch = await capturePatch(args.cwd, args.baseSha);
      if (patch.trim()) fs.writeFileSync(path.join(dir, 'diff.patch'), patch);
    } catch (e) {
      args.logger?.warn?.(`[evidence] patch capture failed: ${(e as Error).message}`);
    }
  } catch (e) {
    args.logger?.warn?.(`[evidence] write failed: ${(e as Error).message}`);
  }

  return bundle;
}

export function readEvidence(runDir: string, evidenceId: string): EvidenceBundle | undefined {
  try {
    const raw = fs.readFileSync(path.join(evidenceDir(runDir, evidenceId), 'bundle.json'), 'utf8');
    return JSON.parse(raw) as EvidenceBundle;
  } catch {
    return undefined;
  }
}

export function listEvidence(runDir: string): string[] {
  try {
    return fs
      .readdirSync(evidenceRoot(runDir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Render a bundle for the CLI. Pure — no I/O. */
export function formatEvidence(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`evidence ${bundle.evidenceId}  (${bundle.passed ? 'PASSED' : 'FAILED'})`);
  lines.push(`run ${bundle.runId} · node ${bundle.node} · ${bundle.createdAt}`);
  if (bundle.baseSha) {
    lines.push(`base ${bundle.baseSha.slice(0, 12)}${bundle.headSha ? ` → head ${bundle.headSha.slice(0, 12)}` : ''}`);
  }
  if (bundle.rounds > 0) lines.push(`${bundle.rounds} fix round(s) consumed`);
  lines.push('');
  for (const r of bundle.results) {
    const mark = r.passed ? 'PASS' : r.required ? 'FAIL' : 'warn';
    lines.push(`  [${mark}] ${r.id} (${r.type})  ${r.detail}`);
    if (r.artifacts?.length) lines.push(`         artifacts: ${r.artifacts.join(', ')}`);
  }
  if (bundle.changedFiles.length > 0) {
    lines.push('');
    lines.push(`changed files (${bundle.changedFiles.length}):`);
    for (const f of bundle.changedFiles.slice(0, 40)) {
      lines.push(`  ${f.status.padEnd(9)} +${f.insertions} -${f.deletions}  ${f.path}`);
    }
    if (bundle.changedFiles.length > 40) lines.push(`  … ${bundle.changedFiles.length - 40} more`);
  }
  return lines.join('\n');
}
