// agy's own /compact (a summary pass over the conversation), run as a turn: the engine has had one since
// 1.5, but the session answered "does not support compaction".
import { describe, expect, it, vi } from 'vitest';

const { PersistentAgySession } = await import('../persistent-agy-session.js');
const CONV = '3003cea8-3e09-4c7a-ba63-14ef444eab46';

describe('PersistentAgySession.compact', () => {
  it('a conversation to compact: a /compact turn, with slash commands on for it alone', async () => {
    const s: any = new PersistentAgySession({
      name: 't',
      cwd: '/tmp',
      permissionMode: 'default',
      resumeSessionId: CONV,
      disableSlashCommands: true,
    });
    let during: boolean | undefined;
    const send = vi.spyOn(s, 'send').mockImplementation(async () => {
      during = s.options.disableSlashCommands;
      return { text: '', event: { type: 'result', result: '' } };
    });
    await s.compact();
    expect(send).toHaveBeenCalledWith('/compact', expect.objectContaining({ timeout: expect.any(Number) }));
    expect(during).toBe(false);
    expect(s.options.disableSlashCommands).toBe(true); // as it was, after
  });

  it('no conversation yet: nothing to compact, nothing sent', async () => {
    const s: any = new PersistentAgySession({ name: 't', cwd: '/tmp', permissionMode: 'default' });
    const send = vi.spyOn(s, 'send');
    const r = await s.compact();
    expect(send).not.toHaveBeenCalled();
    expect(r.text).toMatch(/nothing to compact/i);
  });
});
