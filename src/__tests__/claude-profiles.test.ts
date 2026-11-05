import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeProfilesFile, loadClaudeProfiles, resolveClaudeProfile } from '../claude-profiles.js';

describe('claude profiles', () => {
  let dir: string;
  let file: string;
  let acct: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-profiles-'));
    file = path.join(dir, 'claude-profiles.json');
    acct = path.join(dir, 'acct-work');
    fs.mkdirSync(acct);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats a missing file as no profiles', () => {
    expect(loadClaudeProfiles(file)).toEqual({});
  });

  it('reads names and absolute directories', () => {
    fs.writeFileSync(file, JSON.stringify({ work: acct, 'personal-1': dir }));
    expect(loadClaudeProfiles(file)).toEqual({ work: acct, 'personal-1': dir });
  });

  it('rejects malformed content', () => {
    fs.writeFileSync(file, '{ not json');
    expect(() => loadClaudeProfiles(file)).toThrow(/not valid JSON/);
    fs.writeFileSync(file, '["a"]');
    expect(() => loadClaudeProfiles(file)).toThrow(/must be an object/);
  });

  it('rejects a bad name and a relative directory', () => {
    fs.writeFileSync(file, JSON.stringify({ 'bad name': acct }));
    expect(() => loadClaudeProfiles(file)).toThrow(/not valid/);
    fs.writeFileSync(file, JSON.stringify({ work: 'relative/dir' }));
    expect(() => loadClaudeProfiles(file)).toThrow(/absolute directory/);
  });

  it('resolves a known profile to its directory', () => {
    fs.writeFileSync(file, JSON.stringify({ work: acct }));
    expect(resolveClaudeProfile('work', file)).toBe(acct);
  });

  it('names the known profiles when the requested one is unknown', () => {
    fs.writeFileSync(file, JSON.stringify({ work: acct }));
    expect(() => resolveClaudeProfile('nope', file)).toThrow(/Unknown Claude profile "nope" \(known: work\)/);
  });

  it('says how to create the file when there are no profiles', () => {
    expect(() => resolveClaudeProfile('work', file)).toThrow(/no profiles are defined/);
  });

  it('does not treat a prototype key as a profile', () => {
    fs.writeFileSync(file, JSON.stringify({ work: acct }));
    expect(() => resolveClaudeProfile('constructor', file)).toThrow(/Unknown Claude profile/);
  });

  it('refuses a profile whose directory does not exist', () => {
    fs.writeFileSync(file, JSON.stringify({ gone: path.join(dir, 'missing') }));
    expect(() => resolveClaudeProfile('gone', file)).toThrow(/not an existing directory/);
  });

  it('takes the file location from CLAWO_CLAUDE_PROFILES', () => {
    vi.stubEnv('CLAWO_CLAUDE_PROFILES', file);
    expect(claudeProfilesFile()).toBe(file);
  });
});
