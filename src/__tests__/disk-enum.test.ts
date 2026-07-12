import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listCouncilsFromDisk,
  listAutoloopsFromRegistry,
  appendAutoloopRegistry,
  removeAutoloopFromRegistry,
} from '../session-manager.js';

describe('listCouncilsFromDisk', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-disk-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('parses transcripts with explicit **ID** header', () => {
    const file = path.join(tmpDir, 'council-2026-05-13T05-15-40.md');
    fs.writeFileSync(
      file,
      [
        '# Council Transcript',
        '',
        '- **ID**: abc-123',
        '- **Time**: 2026-05-13T05:15:40.582Z',
        '- **Task**: build the thing',
        '- **Status**: consensus',
        '',
        '---',
        '',
        '## Round 1',
        'agent-A: ...',
      ].join('\n'),
    );
    const results = listCouncilsFromDisk(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('abc-123');
    expect(results[0].task).toBe('build the thing');
    expect(results[0].status).toBe('consensus');
    expect(results[0].startTime).toBe('2026-05-13T05:15:40.582Z');
  });

  it('falls back to filename-derived id when **ID** header is missing (legacy transcripts)', () => {
    const file = path.join(tmpDir, 'council-2026-04-03T03-06-08.md');
    fs.writeFileSync(
      file,
      [
        '# Council Transcript',
        '',
        '- **Time**: 2026-04-03T03:06:08.000Z',
        '- **Task**: legacy task',
        '- **Status**: max_rounds',
      ].join('\n'),
    );
    const results = listCouncilsFromDisk(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('council-2026-04-03T03-06-08');
    expect(results[0].task).toBe('legacy task');
  });

  it('returns [] when the log dir does not exist', () => {
    expect(listCouncilsFromDisk(path.join(tmpDir, 'missing'))).toEqual([]);
  });

  it('skips files that are not council transcripts', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.md'), 'random content');
    fs.writeFileSync(path.join(tmpDir, 'README'), 'not markdown');
    expect(listCouncilsFromDisk(tmpDir)).toEqual([]);
  });
});

describe('autoloop registry', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-reg-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('round-trips one entry', () => {
    const file = path.join(tmpDir, 'autoloop-registry.jsonl');
    fs.mkdirSync(path.join(tmpDir, 'ws'), { recursive: true });
    appendAutoloopRegistry(file, {
      run_id: 'r1',
      workspace: path.join(tmpDir, 'ws'),
      ledger_dir: path.join(tmpDir, 'ws'),
      started_at: '2026-05-13T05:00:00.000Z',
      planner_session: 'planner-r1',
      planner_engine: 'codex',
      planner_model: 'gpt-planner',
      coder_engine: 'custom',
      coder_model: 'custom-coder',
      reviewer_engine: 'gemini',
      reviewer_model: 'gemini-reviewer',
    });
    const rows = listAutoloopsFromRegistry(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: 'r1',
      planner_session: 'planner-r1',
      planner_engine: 'codex',
      planner_model: 'gpt-planner',
      coder_engine: 'custom',
      coder_model: 'custom-coder',
      reviewer_engine: 'gemini',
      reviewer_model: 'gemini-reviewer',
    });
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('customEngine');
    expect(raw).not.toContain('env');
  });

  it('returns [] when the registry does not exist', () => {
    expect(listAutoloopsFromRegistry(path.join(tmpDir, 'missing.jsonl'))).toEqual([]);
  });

  it('skips entries whose ledger_dir is gone (cleanup of moved/deleted workspaces)', () => {
    const file = path.join(tmpDir, 'autoloop-registry.jsonl');
    fs.mkdirSync(path.join(tmpDir, 'alive'), { recursive: true });
    appendAutoloopRegistry(file, {
      run_id: 'dead',
      workspace: '/x',
      ledger_dir: '/tmp/never-existed-xyz123',
      started_at: 't',
      planner_session: 'p',
    });
    appendAutoloopRegistry(file, {
      run_id: 'alive',
      workspace: '/x',
      ledger_dir: path.join(tmpDir, 'alive'),
      started_at: 't',
      planner_session: 'p',
    });
    const rows = listAutoloopsFromRegistry(file);
    expect(rows.map((r) => r.run_id)).toEqual(['alive']);
  });

  it('dedups by run_id — newest entry wins', () => {
    const file = path.join(tmpDir, 'autoloop-registry.jsonl');
    fs.mkdirSync(path.join(tmpDir, 'ws'), { recursive: true });
    appendAutoloopRegistry(file, {
      run_id: 'r1',
      workspace: 'a',
      ledger_dir: path.join(tmpDir, 'ws'),
      started_at: '2026-05-01T00:00:00.000Z',
      planner_session: 'p1-old',
    });
    appendAutoloopRegistry(file, {
      run_id: 'r1',
      workspace: 'b',
      ledger_dir: path.join(tmpDir, 'ws'),
      started_at: '2026-05-13T00:00:00.000Z',
      planner_session: 'p1-new',
    });
    const rows = listAutoloopsFromRegistry(file);
    expect(rows).toHaveLength(1);
    expect(rows[0].planner_session).toBe('p1-new');
    expect(rows[0].workspace).toBe('b');
  });

  it('tolerates malformed lines', () => {
    const file = path.join(tmpDir, 'autoloop-registry.jsonl');
    fs.mkdirSync(path.join(tmpDir, 'ws'), { recursive: true });
    fs.writeFileSync(
      file,
      '{not json}\n' +
        JSON.stringify({
          run_id: 'good',
          workspace: 'a',
          ledger_dir: path.join(tmpDir, 'ws'),
          started_at: 't',
          planner_session: 'p',
        }) +
        '\n',
    );
    const rows = listAutoloopsFromRegistry(file);
    expect(rows.map((r) => r.run_id)).toEqual(['good']);
  });
});

describe('removeAutoloopFromRegistry', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-reg-rm-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('drops every line whose run_id matches and keeps the rest', () => {
    const file = path.join(tmpDir, 'autoloop-registry.jsonl');
    fs.mkdirSync(path.join(tmpDir, 'ws'), { recursive: true });
    const ledger = path.join(tmpDir, 'ws');
    appendAutoloopRegistry(file, {
      run_id: 'keep-1',
      workspace: 'a',
      ledger_dir: ledger,
      started_at: 't',
      planner_session: 'p',
    });
    appendAutoloopRegistry(file, {
      run_id: 'drop-me',
      workspace: 'b',
      ledger_dir: ledger,
      started_at: 't',
      planner_session: 'p',
    });
    appendAutoloopRegistry(file, {
      run_id: 'keep-2',
      workspace: 'c',
      ledger_dir: ledger,
      started_at: 't',
      planner_session: 'p',
    });
    appendAutoloopRegistry(file, {
      run_id: 'drop-me',
      workspace: 'b2',
      ledger_dir: ledger,
      started_at: 't',
      planner_session: 'p',
    });

    const removed = removeAutoloopFromRegistry(file, 'drop-me');
    expect(removed).toBe(2);

    const rows = listAutoloopsFromRegistry(file);
    expect(rows.map((r) => r.run_id).sort()).toEqual(['keep-1', 'keep-2']);
  });

  it('returns 0 and leaves the file untouched when run_id is absent', () => {
    const file = path.join(tmpDir, 'autoloop-registry.jsonl');
    fs.mkdirSync(path.join(tmpDir, 'ws'), { recursive: true });
    appendAutoloopRegistry(file, {
      run_id: 'only',
      workspace: 'a',
      ledger_dir: path.join(tmpDir, 'ws'),
      started_at: 't',
      planner_session: 'p',
    });
    const before = fs.readFileSync(file, 'utf-8');
    expect(removeAutoloopFromRegistry(file, 'nope')).toBe(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('returns 0 when the registry file does not exist (idempotent)', () => {
    expect(removeAutoloopFromRegistry(path.join(tmpDir, 'missing.jsonl'), 'whatever')).toBe(0);
  });
});
