import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UltraappManager } from '../../ultraapp/manager.js';
import { UltraappStore } from '../../ultraapp/store.js';

interface FakeSession {
  send: ReturnType<typeof vi.fn>;
}

function fakeSessionManager(reply: string) {
  const session: FakeSession = {
    send: vi.fn().mockResolvedValue({ output: reply, requestId: 'r' }),
  };
  return {
    // Echo the requested session name so narrator-<runId> doesn't collide
    // with the interview session's name.
    startSession: vi.fn().mockImplementation(async (cfg: { name?: string }) => ({ name: cfg.name ?? 'ultraapp-r1' })),
    sendMessage: (_name: string, msg: string) => session.send(msg),
    stopSession: vi.fn().mockResolvedValue(undefined),
    _session: session,
  };
}

function questionReply(): string {
  return '```question\n{"question":"hi","options":[{"label":"a","value":"a"}],"recommended":"a","freeformAccepted":true}\n```';
}

describe('UltraappManager', () => {
  let tmp: string;
  let store: UltraappStore;
  // Tracked at suite scope so afterEach can drain background work before the
  // tmp dir is removed. Tests assign their manager to this slot in addition
  // to (or instead of) using a local `const mgr` binding.
  let activeMgr: UltraappManager | null = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-mgr-'));
    store = new UltraappStore(tmp);
    activeMgr = null;
  });
  afterEach(async () => {
    // Drain in-flight driveTurn() chains (createRun + submitAnswer + addFile +
    // applySpecEdit all fire detached follow-up turns). Otherwise an in-flight
    // appendChat can race rmSync and surface as an unhandled ENOENT rejection
    // that vitest treats as a failure.
    if (activeMgr) await activeMgr.waitForIdle();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('createRun returns runId, persists initial state, starts session', async () => {
    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    expect(id.startsWith('ua-')).toBe(true);
    expect(sm.startSession).toHaveBeenCalled();
    const state = await store.readState(id);
    expect(state.mode).toBe('interview');
  });

  it('createRun emits initial question via subscribe', async () => {
    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const events: unknown[] = [];
    // Subscribe BEFORE createRun's background driveTurn fires
    const id = await mgr.createRun();
    mgr.subscribe(id, (ev) => events.push(ev));
    // Allow driveTurn microtask + send to complete
    await new Promise((r) => setTimeout(r, 50));
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('question');
  });

  it('submitAnswer feeds the answer back into the session and emits next question', async () => {
    const replies = [
      '```question\n{"question":"q1","options":[{"label":"a","value":"a"}],"recommended":"a","freeformAccepted":true}\n```',
      '```question\n{"question":"q2","options":[{"label":"b","value":"b"}],"recommended":"b","freeformAccepted":true}\n```',
    ];
    let i = 0;
    const sm = {
      startSession: vi.fn().mockResolvedValue({ name: 'ultraapp-r1' }),
      sendMessage: vi.fn().mockImplementation(async () => ({ output: replies[i++], requestId: `r${i}` })),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    await new Promise((r) => setTimeout(r, 50));
    await mgr.submitAnswer(id, { value: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    const chat = await store.readChat(id);
    const questions = chat.filter((c) => c.kind === 'question');
    expect(questions.length).toBe(2);
  });

  it('applySpecEdit updates spec and emits spec-updated event', async () => {
    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    const events: unknown[] = [];
    mgr.subscribe(id, (ev) => events.push(ev));
    await mgr.applySpecEdit(id, [{ op: 'replace', path: '/meta/name', value: 'edited' }]);
    const spec = await store.readSpec(id);
    expect(spec.meta.name).toBe('edited');
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('spec-updated');
  });

  it('startBuild transitions interview→queued→building→build-complete and records artifact', async () => {
    const councilMod = await import('../../ultraapp/council-adapter.js');
    const fixMod = await import('../../ultraapp/fix-on-failure.js');
    const synth = vi.spyOn(councilMod, 'runCouncilSynth').mockImplementation(async ({ runDir }) => {
      const codebase = path.join(runDir, 'versions', 'v1', 'codebase');
      fs.mkdirSync(codebase, { recursive: true });
      return { ok: true, worktreePath: codebase, rounds: 1 };
    });
    const fix = vi.spyOn(fixMod, 'runFixOnFailure').mockResolvedValue({ ok: true, rounds: 0 });

    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();

    const events: { type: string }[] = [];
    mgr.subscribe(id, (ev) => events.push(ev as { type: string }));

    await mgr.startBuild(id);
    // Allow queue to drain. The manager persists the mode *before* it emits the
    // matching event, so polling the store alone can release this loop while the
    // terminal event is still undelivered — wait for the event we assert on too.
    const sawTerminalEvent = () =>
      events.some(
        (e) =>
          e.type === 'build-event' &&
          ['build-complete', 'build-failed', 'build-cancelled'].includes(
            (e as unknown as { event: { type: string } }).event.type,
          ),
      );
    for (let i = 0; i < 50; i++) {
      const s = await store.readState(id);
      if ((s.mode === 'build-complete' || s.mode === 'failed') && sawTerminalEvent()) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const finalState = await store.readState(id);
    expect(finalState.mode).toBe('build-complete');
    const arts = await store.readArtifacts(id);
    expect(arts.length).toBe(1);
    expect(arts[0].version).toBe('v1');

    const buildEvents = events
      .filter((e) => e.type === 'build-event')
      .map((e) => (e as unknown as { event: { type: string } }).event.type);
    expect(buildEvents).toContain('build-start');
    expect(buildEvents).toContain('council-consensus');
    expect(buildEvents).toContain('build-complete');

    // v0.4: a narrator session was spawned for the run and stopped after
    // build-complete; at least one narrator chat entry was written.
    const startedSessions = (sm.startSession as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: [{ name?: string }]) => c[0].name,
    );
    expect(startedSessions).toContain(`narrator-${id}`);
    // Narrator stop is fire-and-forget on terminal events; allow a tick.
    await new Promise((r) => setTimeout(r, 50));
    const stoppedSessions = (sm.stopSession as ReturnType<typeof vi.fn>).mock.calls.map((c: [string]) => c[0]);
    expect(stoppedSessions).toContain(`narrator-${id}`);
    const chat = await store.readChat(id);
    expect(chat.some((e) => e.kind === 'narrator')).toBe(true);

    synth.mockRestore();
    fix.mockRestore();
  });

  it('startBuild with router runs deploy after build, transitions to done, emits app-url', async () => {
    const councilMod = await import('../../ultraapp/council-adapter.js');
    const fixMod = await import('../../ultraapp/fix-on-failure.js');
    const synth = vi.spyOn(councilMod, 'runCouncilSynth').mockImplementation(async ({ runDir }) => {
      const codebase = path.join(runDir, 'versions', 'v1', 'codebase');
      fs.mkdirSync(codebase, { recursive: true });
      return { ok: true, worktreePath: codebase, rounds: 1 };
    });
    const fix = vi.spyOn(fixMod, 'runFixOnFailure').mockResolvedValue({ ok: true, rounds: 0 });

    const fakeRouter = {
      register: vi.fn(),
      deregister: vi.fn(),
      list: () => [],
      port: () => 19000,
    } as never;
    const deployFn = vi.fn().mockResolvedValue({
      ok: true,
      url: 'http://localhost:19000/forge/demo/',
      port: 19101,
      containerName: 'ultraapp-demo-v1',
      imageTag: 'ultraapp/demo:v1',
    });

    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({
      store,
      sessionManager: sm as never,
      router: fakeRouter,
      deployFn,
    });
    activeMgr = mgr;
    const id = await mgr.createRun();

    // Push a name onto the spec so the slug is set
    await mgr.applySpecEdit(id, [{ op: 'replace', path: '/meta/name', value: 'demo' }]);

    const events: { type: string }[] = [];
    mgr.subscribe(id, (ev) => events.push(ev as { type: string }));

    await mgr.startBuild(id);
    // `done` is persisted before the app-url event is emitted, so gate on both.
    for (let i = 0; i < 50; i++) {
      const s = await store.readState(id);
      const sawUrl = events.some((e) => e.type === 'app-url');
      if ((s.mode === 'done' && sawUrl) || s.mode === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const finalState = await store.readState(id);
    expect(finalState.mode).toBe('done');
    expect(deployFn).toHaveBeenCalledTimes(1);
    const arts = await store.readArtifacts(id);
    expect(arts[0].deploy?.url).toBe('http://localhost:19000/forge/demo/');
    const urlEvents = events.filter((e) => e.type === 'app-url');
    expect(urlEvents.length).toBe(1);

    synth.mockRestore();
    fix.mockRestore();
  });

  it('startBuild marks failed when deploy fails', async () => {
    const councilMod = await import('../../ultraapp/council-adapter.js');
    const fixMod = await import('../../ultraapp/fix-on-failure.js');
    const synth = vi.spyOn(councilMod, 'runCouncilSynth').mockImplementation(async ({ runDir }) => {
      const codebase = path.join(runDir, 'versions', 'v1', 'codebase');
      fs.mkdirSync(codebase, { recursive: true });
      return { ok: true, worktreePath: codebase, rounds: 1 };
    });
    const fix = vi.spyOn(fixMod, 'runFixOnFailure').mockResolvedValue({ ok: true, rounds: 0 });

    const fakeRouter = {
      register: vi.fn(),
      deregister: vi.fn(),
      list: () => [],
      port: () => 19000,
    } as never;
    const deployFn = vi.fn().mockResolvedValue({ ok: false, reason: 'docker not running' });

    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({
      store,
      sessionManager: sm as never,
      router: fakeRouter,
      deployFn,
    });
    activeMgr = mgr;
    const id = await mgr.createRun();
    await mgr.applySpecEdit(id, [{ op: 'replace', path: '/meta/name', value: 'demo' }]);
    await mgr.startBuild(id);
    for (let i = 0; i < 50; i++) {
      const s = await store.readState(id);
      if (s.mode === 'failed' || s.mode === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = await store.readState(id);
    expect(s.mode).toBe('failed');
    expect(s.failure).toMatch(/docker not running/);

    synth.mockRestore();
    fix.mockRestore();
  });

  it('submitDoneModeMessage cosmetic branch invokes patcher and snapshots a new version', async () => {
    const sm = fakeSessionManager(
      '```classification\n{"class":"cosmetic","reason":"r","proposedAction":"swap color"}\n```',
    );
    // First setup: pretend the run is in 'done' mode with a v1 deploy artifact
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    await store.setMode(id, 'done');
    const wt = path.join(store.runDirAbsolute(id), 'versions', 'v1', 'codebase');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'app.css'), '.btn { color: blue; }\n');
    await store.recordBuildArtifact(id, { worktreePath: wt, version: 'v1' });
    await store.recordDeploy(id, 'v1', {
      url: 'http://localhost:19000/forge/demo/',
      port: 19101,
      containerName: 'ultraapp-demo-v1',
      imageTag: 'ultraapp/demo:v1',
    });

    // Stub the patcher to return a valid diff via session sendMessage replies.
    // We replace the canned reply between calls.
    const patcherMod = await import('../../ultraapp/patcher.js');
    const spy = vi.spyOn(patcherMod, 'runPatcher').mockResolvedValue({ ok: true, newWorktreePath: wt });

    await mgr.submitDoneModeMessage(id, 'make button green');
    await new Promise((r) => setTimeout(r, 50));

    // patcher was called and a v2 snapshot now exists
    expect(spy).toHaveBeenCalledTimes(1);
    const versionsDir = store.versionsDir(id);
    expect(fs.existsSync(path.join(versionsDir, 'v2', 'artifact.json'))).toBe(true);
    spy.mockRestore();
  });

  it('submitDoneModeMessage spec-delta branch flips mode back to interview', async () => {
    const sm = fakeSessionManager(
      '```classification\n{"class":"spec-delta","reason":"r","proposedAction":"focused"}\n```',
    );
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    await store.setMode(id, 'done');
    await mgr.submitDoneModeMessage(id, 'add a thumbnail step');
    await new Promise((r) => setTimeout(r, 50));
    const s = await store.readState(id);
    expect(s.mode).toBe('interview');
  });

  it('submitDoneModeMessage structural branch posts a "start fresh" narrator note', async () => {
    const sm = fakeSessionManager(
      '```classification\n{"class":"structural","reason":"r","proposedAction":"new run"}\n```',
    );
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    await store.setMode(id, 'done');
    await mgr.submitDoneModeMessage(id, 'this is a totally different app');
    await new Promise((r) => setTimeout(r, 50));
    const chat = await store.readChat(id);
    const narration = chat.find((e) => e.kind === 'narrator' && /\+ New|fresh ultraapp/i.test(e.text));
    expect(narration).toBeTruthy();
    // Mode unchanged
    const s = await store.readState(id);
    expect(s.mode).toBe('done');
  });

  it('submitDoneModeMessage outside done mode falls through to submitAnswer', async () => {
    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    // Mode is interview, not done
    await mgr.submitDoneModeMessage(id, 'hi');
    await new Promise((r) => setTimeout(r, 50));
    const chat = await store.readChat(id);
    expect(chat.some((e) => e.kind === 'answer' && e.text.includes('hi'))).toBe(true);
  });

  it('setModeForDelta + interview-complete auto-fires startBuild (no manual click required)', async () => {
    // Mock the heavy build pipeline so this test, which only verifies the
    // INTERVIEW-COMPLETE → startBuild handoff, doesn't actually spawn real
    // council subprocesses + git worktrees. Without this, the council was
    // still writing into <tmp>/.../council-project/.git while afterEach
    // rmSync'd the tmp dir, causing flaky ENOTEMPTY teardown failures
    // in CI (race between rmSync and the live git workers).
    const councilMod = await import('../../ultraapp/council-adapter.js');
    const fixMod = await import('../../ultraapp/fix-on-failure.js');
    const synth = vi
      .spyOn(councilMod, 'runCouncilSynth')
      .mockResolvedValue({ ok: false, reason: 'mocked — skipping build', rounds: 0 });
    const fix = vi.spyOn(fixMod, 'runFixOnFailure').mockResolvedValue({ ok: false, rounds: 0 });

    // Set up a fake session whose sendMessage replies with a [COMPLETE]
    // marker every call EXCEPT the first (the kickoff at createRun must be
    // a question, otherwise the run ends before we can drive it).
    let calls = 0;
    const sm = {
      startSession: vi.fn().mockImplementation(async (cfg: { name?: string }) => ({ name: cfg.name ?? 'ultraapp-r1' })),
      sendMessage: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) return { output: questionReply() };
        return { output: 'Spec delta done.\n[INTERVIEW: COMPLETE]' };
      }),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    // Wait for kickoff driveTurn to consume reply 1
    await new Promise((r) => setTimeout(r, 50));
    // Hand-write a strict-valid spec directly so startBuild won't reject
    const spec = await store.readSpec(id);
    spec.meta.name = 'demo';
    spec.meta.title = 'Demo';
    spec.meta.description = 'demo app';
    spec.inputs.push({ name: 'doc', type: 'text', required: true, description: 'x' });
    spec.outputs.push({ name: 'out', type: 'text', description: 'y' });
    await store.writeSpec(id, spec);
    // Mark as done (post-deploy state) so setModeForDelta makes sense
    await store.setMode(id, 'done');
    await mgr.setModeForDelta(id);
    // Drive a turn — the next reply is [INTERVIEW: COMPLETE] which should
    // auto-fire startBuild because deltaPending is set.
    await mgr.submitAnswer(id, { value: 'go' });
    for (let k = 0; k < 30; k++) {
      const s = await store.readState(id);
      if (s.mode === 'queued' || s.mode === 'building' || s.mode === 'build-complete') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const finalState = await store.readState(id);
    // 'failed' is also acceptable: the mocked council returns ok:false,
    // so once startBuild dispatches the build pipeline correctly, it may
    // race past queued → failed before our 30-iter polling loop catches it.
    // The contract this test guards is "auto-fired startBuild" (mode left
    // 'done'); the exact terminal state isn't load-bearing.
    expect(['queued', 'building', 'build-complete', 'failed']).toContain(finalState.mode);
    synth.mockRestore();
    fix.mockRestore();
  });

  it('startBuild rejects when strict spec validation fails (cross-ref to undeclared input)', async () => {
    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    // Drive a spec into a state that passes lax shape but fails strict cross-ref:
    // a pipeline step references an input that was never declared.
    await mgr.applySpecEdit(id, [
      { op: 'replace', path: '/meta/name', value: 'demo' },
      {
        op: 'add',
        path: '/pipeline/steps/-',
        value: {
          id: 's1',
          description: 'noop',
          inputs: ['inputs.notdeclared'],
          outputs: ['out'],
          hints: {},
          validates: { outputType: 'text' },
        },
      },
    ]);
    // Lax check let it land on disk; strict check at startBuild should reject.
    await expect(mgr.startBuild(id)).rejects.toThrow(/unknown ref/i);
    const state = await store.readState(id);
    // Mode unchanged (still 'interview'); no transition to 'queued'
    expect(state.mode).toBe('interview');
  });

  it('startBuild marks failed when council fails', async () => {
    const councilMod = await import('../../ultraapp/council-adapter.js');
    const fixMod = await import('../../ultraapp/fix-on-failure.js');
    const synth = vi
      .spyOn(councilMod, 'runCouncilSynth')
      .mockResolvedValue({ ok: false, reason: 'no consensus', rounds: 8 });
    const fix = vi.spyOn(fixMod, 'runFixOnFailure').mockResolvedValue({ ok: true, rounds: 0 });

    const sm = fakeSessionManager(questionReply());
    const mgr = new UltraappManager({ store, sessionManager: sm as never });
    activeMgr = mgr;
    const id = await mgr.createRun();
    await mgr.startBuild(id);
    for (let i = 0; i < 50; i++) {
      const s = await store.readState(id);
      if (s.mode === 'failed' || s.mode === 'build-complete') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = await store.readState(id);
    expect(s.mode).toBe('failed');
    expect(s.failure).toMatch(/no consensus/);
    expect(fix).not.toHaveBeenCalled();
    synth.mockRestore();
    fix.mockRestore();
  });
});
