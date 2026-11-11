import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyPatch } from '../../ultraapp/json-patch.js';
import { runToolCalls } from '../../ultraapp/interview-tools.js';
import { UltraappStore } from '../../ultraapp/store.js';

const probe = 'clawoPolluted';
const polluted = () => (Object.prototype as Record<string, unknown>)[probe];

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>)[probe];
});

describe('applyPatch', () => {
  it('adds, replaces and removes, without touching the input', () => {
    const doc = { a: { b: 1 }, list: [1, 3] };
    const next = applyPatch(doc, [
      { op: 'replace', path: '/a/b', value: 2 },
      { op: 'add', path: '/a/c', value: 'x' },
      { op: 'add', path: '/list/1', value: 2 },
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'remove', path: '/a/b' },
    ]);
    expect(next).toEqual({ a: { c: 'x' }, list: [1, 2, 3, 4] });
    expect(doc).toEqual({ a: { b: 1 }, list: [1, 3] });
  });

  it.each([
    [`/__proto__/${probe}`],
    [`/a/__proto__/${probe}`],
    [`/constructor/prototype/${probe}`],
    [`/a/constructor/prototype/${probe}`],
  ])('refuses %s and leaves Object.prototype alone', (p) => {
    expect(() => applyPatch({ a: {} }, [{ op: 'add', path: p, value: true }])).toThrow(/not allowed/);
    expect(polluted()).toBeUndefined();
  });

  it('decodes ~1 before checking, so an escaped segment cannot slip through', () => {
    expect(() => applyPatch({}, [{ op: 'add', path: '/__proto__~1x', value: 1 }])).not.toThrow();
    expect(() => applyPatch({}, [{ op: 'add', path: `/__proto__/${probe}`, value: 1 }])).toThrow();
    expect(polluted()).toBeUndefined();
  });

  it('does not walk into inherited properties', () => {
    expect(() => applyPatch({ a: {} }, [{ op: 'add', path: '/a/hasOwnProperty/x', value: 1 }])).toThrow();
  });
});

describe('update_spec cannot reach the prototype', () => {
  let tmp: string;
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('fails the tool call and leaves Object.prototype unchanged', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-jsonpatch-'));
    const store = new UltraappStore(tmp);
    const runId = await store.createRun();
    const out = await runToolCalls({
      runId,
      store,
      extractMetadata: vi.fn(),
      calls: [{ name: 'update_spec', argsRaw: JSON.stringify([{ op: 'add', path: `/__proto__/${probe}`, value: 1 }]) }],
    });
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toMatch(/not allowed/);
    expect(polluted()).toBeUndefined();
  });
});
