import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsDefault, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acknowledgeDelivery,
  canonicalPayloadSha256,
  DeliveryOutboxError,
  latestTargetGeneration,
  prepareDelivery,
  rebindDelivery,
} from '../autoloop/outbox.js';

describe('Autoloop durable delivery outbox', () => {
  let root: string;
  let decisionsPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-outbox-'));
    decisionsPath = path.join(root, 'decisions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists one immutable intent and reuses it for the same idempotency key', () => {
    const input = {
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive' as const,
      target_role: 'coder' as const,
      target_generation: 1,
      payload: { prompt: 'fix the parser', logical_message_sha256: 'a'.repeat(64) },
    };

    const first = prepareDelivery(decisionsPath, input, {
      now: () => new Date('2026-10-02T09:00:00.000Z'),
      deliveryId: () => 'delivery-1',
    });
    const second = prepareDelivery(decisionsPath, input, {
      now: () => new Date('2026-10-02T09:01:00.000Z'),
      deliveryId: () => 'delivery-2',
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema_version: 1,
      record_type: 'delivery_intent',
      delivery_id: 'delivery-1',
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      created_at: '2026-10-02T09:00:00.000Z',
      payload: input.payload,
    });
    expect(first.payload_sha256).toMatch(/^[a-f0-9]{64}$/);

    const rows = fs
      .readFileSync(decisionsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(rows).toEqual([first]);
  });

  it('flushes a new ledger file and its parent directory before returning the intent', () => {
    const originalFsyncSync = fsDefault.fsyncSync;
    let fsyncCalls = 0;
    fsDefault.fsyncSync = ((fd: number) => {
      fsyncCalls += 1;
      return originalFsyncSync(fd);
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      prepareDelivery(decisionsPath, {
        idempotency_key: 'dispatch-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      });
    } finally {
      fsDefault.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
    }

    expect(fsyncCalls).toBe(2);
  });

  it('does not return an intent when its append cannot be confirmed', () => {
    const originalFsyncSync = fsDefault.fsyncSync;
    fsDefault.fsyncSync = (() => {
      throw new Error('simulated intent fsync failure');
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      expect(() =>
        prepareDelivery(decisionsPath, {
          idempotency_key: 'dispatch-1',
          kind: 'coder_directive',
          target_role: 'coder',
          target_generation: 1,
          payload: { prompt: 'fix' },
        }),
      ).toThrow('simulated intent fsync failure');
    } finally {
      fsDefault.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
    }

    expect(
      prepareDelivery(decisionsPath, {
        idempotency_key: 'dispatch-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      }),
    ).toMatchObject({ idempotency_key: 'dispatch-1' });
    expect(fs.readFileSync(decisionsPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('completes a short filesystem write before returning the intent', () => {
    const originalWriteSync = fsDefault.writeSync;
    let shortened = false;
    fsDefault.writeSync = ((fd: number, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
      if (!shortened) {
        shortened = true;
        const bytes =
          typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const length = Math.max(1, Math.floor(bytes.byteLength / 2));
        return originalWriteSync(fd, bytes, 0, length, null);
      }
      return (originalWriteSync as (...values: unknown[]) => number)(fd, data, ...args);
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    try {
      prepareDelivery(decisionsPath, {
        idempotency_key: 'dispatch-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      });
    } finally {
      fsDefault.writeSync = originalWriteSync;
      syncBuiltinESMExports();
    }

    const contents = fs.readFileSync(decisionsPath, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(contents.trim())).not.toThrow();
  });

  it('fails closed while another writer owns the delivery graph', () => {
    const lockPath = path.join(root, '.delivery-outbox.lock');
    fs.writeFileSync(lockPath, 'held');

    expect(() =>
      prepareDelivery(decisionsPath, {
        idempotency_key: 'dispatch-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({ code: 'AUTOLOOP_DELIVERY_OUTBOX_LOCK_CONTENDED' }),
    );
    expect(fs.existsSync(decisionsPath)).toBe(false);
  });

  it('rejects reuse of an idempotency key for another payload or generation', () => {
    const base = {
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive' as const,
      target_role: 'coder' as const,
      target_generation: 1,
      payload: { prompt: 'first', logical_message_sha256: 'a'.repeat(64) },
    };
    prepareDelivery(decisionsPath, base);

    for (const changed of [
      { ...base, payload: { ...base.payload, prompt: 'second' } },
      { ...base, target_generation: 2 },
    ]) {
      expect(() => prepareDelivery(decisionsPath, changed)).toThrowError(
        expect.objectContaining<Partial<DeliveryOutboxError>>({
          code: 'AUTOLOOP_DELIVERY_IDEMPOTENCY_CONFLICT',
        }),
      );
    }
  });

  it('hashes object payloads canonically rather than by insertion order', () => {
    const left = prepareDelivery(
      decisionsPath,
      {
        idempotency_key: 'dispatch-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'same', metadata: { z: 1, a: 2 } },
      },
      { deliveryId: () => 'delivery-1' },
    );
    const right = prepareDelivery(decisionsPath, {
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload: { metadata: { a: 2, z: 1 }, prompt: 'same' },
    });

    expect(right).toEqual(left);
  });

  it('acknowledges only the exact durable intent and does so idempotently', () => {
    const intent = prepareDelivery(
      decisionsPath,
      {
        idempotency_key: 'dispatch-1',
        kind: 'review_request',
        target_role: 'reviewer',
        target_generation: 3,
        payload: { prompt: 'review' },
      },
      { deliveryId: () => 'delivery-1' },
    );

    const first = acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 3, {
      now: () => new Date('2026-10-02T09:02:00.000Z'),
    });
    const second = acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 3, {
      now: () => new Date('2026-10-02T09:03:00.000Z'),
    });

    expect(second).toEqual(first);
    expect(first).toEqual({
      schema_version: 1,
      record_type: 'delivery_acknowledgement',
      delivery_id: 'delivery-1',
      payload_sha256: intent.payload_sha256,
      target_generation: 3,
      acknowledged_at: '2026-10-02T09:02:00.000Z',
    });
    expect(fs.readFileSync(decisionsPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('does not duplicate an acknowledgement when its first flush outcome is uncertain', () => {
    const intent = prepareDelivery(decisionsPath, {
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload: { prompt: 'fix' },
    });
    const originalFsyncSync = fsDefault.fsyncSync;
    fsDefault.fsyncSync = (() => {
      throw new Error('simulated acknowledgement fsync failure');
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      expect(() => acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 1)).toThrow(
        'simulated acknowledgement fsync failure',
      );
    } finally {
      fsDefault.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
    }

    expect(acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 1)).toMatchObject({
      delivery_id: intent.delivery_id,
      target_generation: 1,
    });
    expect(fs.readFileSync(decisionsPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('rejects an acknowledgement with the wrong payload digest', () => {
    const intent = prepareDelivery(decisionsPath, {
      idempotency_key: 'dispatch-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload: { prompt: 'fix' },
    });

    expect(() => acknowledgeDelivery(decisionsPath, intent.delivery_id, 'f'.repeat(64), 1)).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({
        code: 'AUTOLOOP_DELIVERY_ACKNOWLEDGEMENT_CONFLICT',
      }),
    );
  });

  it('fails closed on a truncated decisions ledger', () => {
    fs.writeFileSync(decisionsPath, '{"record_type":"delivery_intent"}');

    expect(() =>
      prepareDelivery(decisionsPath, {
        idempotency_key: 'dispatch-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      }),
    ).toThrowError(expect.objectContaining<Partial<DeliveryOutboxError>>({ code: 'AUTOLOOP_DELIVERY_LEDGER_INVALID' }));
  });

  it('derives the latest durable target generation per role', () => {
    prepareDelivery(decisionsPath, {
      idempotency_key: 'coder-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 2,
      payload: { prompt: 'fix' },
    });
    prepareDelivery(decisionsPath, {
      idempotency_key: 'reviewer-1',
      kind: 'review_request',
      target_role: 'reviewer',
      target_generation: 4,
      payload: { prompt: 'review' },
    });

    expect(latestTargetGeneration(decisionsPath, 'coder')).toBe(2);
    expect(latestTargetGeneration(decisionsPath, 'reviewer')).toBe(4);
  });

  it('records an explicit monotonic generation rebind before a retry', () => {
    const intent = prepareDelivery(
      decisionsPath,
      {
        idempotency_key: 'coder-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      },
      { deliveryId: () => 'delivery-1' },
    );

    const first = rebindDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 2, {
      now: () => new Date('2026-10-02T09:04:00.000Z'),
    });
    const second = rebindDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 2, {
      now: () => new Date('2026-10-02T09:05:00.000Z'),
    });

    expect(second).toEqual(first);
    expect(first).toEqual({
      schema_version: 1,
      record_type: 'delivery_generation_rebind',
      delivery_id: 'delivery-1',
      payload_sha256: intent.payload_sha256,
      target_role: 'coder',
      from_generation: 1,
      to_generation: 2,
      rebound_at: '2026-10-02T09:04:00.000Z',
    });
    expect(latestTargetGeneration(decisionsPath, 'coder')).toBe(2);
    expect(() => rebindDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 3)).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({
        code: 'AUTOLOOP_DELIVERY_GENERATION_REBIND_CONFLICT',
      }),
    );
  });

  it('acknowledges only the generation currently bound to the delivery', () => {
    const intent = prepareDelivery(
      decisionsPath,
      {
        idempotency_key: 'coder-1',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'fix' },
      },
      { deliveryId: () => 'delivery-1' },
    );
    rebindDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 2);

    expect(() => acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 1)).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({
        code: 'AUTOLOOP_DELIVERY_ACKNOWLEDGEMENT_CONFLICT',
      }),
    );
    expect(acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 2)).toMatchObject({
      target_generation: 2,
    });
  });

  it('rejects a recognized intent whose stored digest does not match its payload', () => {
    fs.writeFileSync(
      decisionsPath,
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'delivery_intent',
        delivery_id: 'delivery-corrupt',
        idempotency_key: 'corrupt',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'tampered' },
        payload_sha256: '0'.repeat(64),
        created_at: '2026-10-02T09:00:00.000Z',
      })}\n`,
    );

    expect(() =>
      prepareDelivery(decisionsPath, {
        idempotency_key: 'new',
        kind: 'coder_directive',
        target_role: 'coder',
        target_generation: 1,
        payload: { prompt: 'new' },
      }),
    ).toThrowError(expect.objectContaining<Partial<DeliveryOutboxError>>({ code: 'AUTOLOOP_DELIVERY_LEDGER_INVALID' }));
  });

  it('rejects reserved delivery record types with an absent or unknown schema version', () => {
    for (const row of [
      { record_type: 'delivery_intent' },
      { schema_version: 2, record_type: 'delivery_generation_rebind' },
      { schema_version: 2, record_type: 'delivery_acknowledgement' },
    ]) {
      fs.writeFileSync(decisionsPath, `${JSON.stringify(row)}\n`);
      expect(() => latestTargetGeneration(decisionsPath, 'coder')).toThrowError(
        expect.objectContaining<Partial<DeliveryOutboxError>>({ code: 'AUTOLOOP_DELIVERY_LEDGER_INVALID' }),
      );
    }
  });

  it('rejects orphan acknowledgements and duplicate delivery identities', () => {
    const payload = { prompt: 'one' };
    const digest = canonicalPayloadSha256(payload);
    const intent = (idempotencyKey: string) => ({
      schema_version: 1,
      record_type: 'delivery_intent',
      delivery_id: 'delivery-duplicate',
      idempotency_key: idempotencyKey,
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload,
      payload_sha256: digest,
      created_at: '2026-10-02T09:00:00.000Z',
    });
    fs.writeFileSync(decisionsPath, `${JSON.stringify(intent('one'))}\n${JSON.stringify(intent('two'))}\n`);

    expect(() => latestTargetGeneration(decisionsPath, 'coder')).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({ code: 'AUTOLOOP_DELIVERY_LEDGER_INVALID' }),
    );

    fs.writeFileSync(
      decisionsPath,
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'delivery_acknowledgement',
        delivery_id: 'orphan',
        payload_sha256: 'a'.repeat(64),
        acknowledged_at: '2026-10-02T09:00:00.000Z',
      })}\n`,
    );
    expect(() => latestTargetGeneration(decisionsPath, 'coder')).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({ code: 'AUTOLOOP_DELIVERY_LEDGER_INVALID' }),
    );
  });

  it('does not rebind a delivery after its receiver acknowledged it', () => {
    const intent = prepareDelivery(decisionsPath, {
      idempotency_key: 'coder-1',
      kind: 'coder_directive',
      target_role: 'coder',
      target_generation: 1,
      payload: { prompt: 'fix' },
    });
    acknowledgeDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 1);

    expect(() => rebindDelivery(decisionsPath, intent.delivery_id, intent.payload_sha256, 2)).toThrowError(
      expect.objectContaining<Partial<DeliveryOutboxError>>({
        code: 'AUTOLOOP_DELIVERY_GENERATION_REBIND_CONFLICT',
      }),
    );
  });
});
