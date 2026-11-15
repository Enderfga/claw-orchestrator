/**
 * host-strategy: end-to-end with a real tiny Node app.
 *
 * Builds a 4-line http.createServer in a tmp dir, runs it on a free port,
 * verifies the URL responds, stops it, restarts it, deletes it. No mocks
 * for spawn — the whole point is to prove host-spawn really works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as http from 'node:http';
import { hostBuild, hostRun, hostStop, hostStart, hostRm, hostPs } from '../../ultraapp/host-strategy.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function waitForUp(port: number, deadlineMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await get(port, '/');
      if (r.status > 0) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('host-strategy end-to-end', () => {
  let cwd: string;
  let port: number;
  const NAME_PREFIX = 'ua-host-test';
  let testName: string;

  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-host-'));
    port = await freePort();
    testName = `${NAME_PREFIX}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'host-test-app',
        version: '0.0.1',
        scripts: { start: 'node server.js' },
      }),
    );
    fs.writeFileSync(
      path.join(cwd, 'server.js'),
      `import * as http from 'node:http';
const port = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok ' + req.url);
}).listen(port, '127.0.0.1');
`,
    );
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'host-test-app',
        version: '0.0.1',
        type: 'module',
        scripts: { start: 'node server.js' },
      }),
    );
  });

  afterEach(async () => {
    await hostRm(testName).catch(() => {});
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('hostBuild succeeds even with no build script', async () => {
    const r = await hostBuild({ tag: 'demo:v1', cwd });
    expect(r.ok).toBe(true);
    expect(r.imageId).toContain('host:');
  });

  it('hostBuild fails cleanly when package.json is missing', async () => {
    const noPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-host-nopkg-'));
    const r = await hostBuild({ tag: 'x', cwd: noPkg });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/package\.json/);
    fs.rmSync(noPkg, { recursive: true, force: true });
  });

  // The generated app and its lifecycle scripts are code the agents wrote:
  // neither may inherit the server's token.
  describe('the server token', () => {
    const saved = { server: process.env.OPENCLAW_SERVER_TOKEN, cli: process.env.CLAWO_AUTH_TOKEN };
    beforeEach(() => {
      process.env.OPENCLAW_SERVER_TOKEN = 'server-secret';
      process.env.CLAWO_AUTH_TOKEN = 'cli-secret';
    });
    afterEach(() => {
      if (saved.server === undefined) delete process.env.OPENCLAW_SERVER_TOKEN;
      else process.env.OPENCLAW_SERVER_TOKEN = saved.server;
      if (saved.cli === undefined) delete process.env.CLAWO_AUTH_TOKEN;
      else process.env.CLAWO_AUTH_TOKEN = saved.cli;
    });

    it.skipIf(process.platform === 'win32')('is not seen by the build scripts', async () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: 'host-test-app',
          version: '0.0.1',
          scripts: {
            build: `node -e "require('fs').writeFileSync('seen.txt', [process.env.OPENCLAW_SERVER_TOKEN, process.env.CLAWO_AUTH_TOKEN].map(String).join('|'))"`,
          },
        }),
      );
      const r = await hostBuild({ tag: 'demo:v1', cwd });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(cwd, 'seen.txt'), 'utf8')).toBe('undefined|undefined');
    });

    it.skipIf(process.platform === 'win32')('is not seen by the running app, even through its env', async () => {
      fs.writeFileSync(
        path.join(cwd, 'server.js'),
        `import * as http from 'node:http';
const port = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
  res.end(String(process.env.OPENCLAW_SERVER_TOKEN) + '|' + String(process.env.CLAWO_AUTH_TOKEN) + '|' + process.env.KEEP);
}).listen(port, '127.0.0.1');
`,
      );
      const run = await hostRun({
        image: cwd,
        name: testName,
        hostPort: port,
        env: { HOST_CWD: cwd, CLAWO_AUTH_TOKEN: 'via-env', KEEP: 'kept' },
      });
      expect(run.ok).toBe(true);
      expect(await waitForUp(port)).toBe(true);
      expect((await get(port, '/')).body).toBe('undefined|undefined|kept');
    });
  });

  it('hostRun → wait for up → GET / → hostStop → port frees', async () => {
    const run = await hostRun({
      image: cwd,
      name: testName,
      hostPort: port,
      env: { HOST_CWD: cwd },
    });
    expect(run.ok).toBe(true);
    expect(run.containerName).toBe(testName);

    const up = await waitForUp(port);
    expect(up).toBe(true);

    const r = await get(port, '/hello');
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok /hello');

    const stop = await hostStop(testName);
    expect(stop.ok).toBe(true);

    // Wait briefly for port release
    await new Promise((r) => setTimeout(r, 300));
    let stillUp = false;
    try {
      await get(port, '/');
      stillUp = true;
    } catch {
      /* expected */
    }
    expect(stillUp).toBe(false);
  });

  it('hostStart re-spawns from saved metadata after a stop', async () => {
    await hostRun({ image: cwd, name: testName, hostPort: port, env: { HOST_CWD: cwd } });
    expect(await waitForUp(port)).toBe(true);
    await hostStop(testName);
    await new Promise((r) => setTimeout(r, 200));
    const restart = await hostStart(testName);
    expect(restart.ok).toBe(true);
    expect(await waitForUp(port)).toBe(true);
  });

  it('hostPs reports running and exited state', async () => {
    await hostRun({ image: cwd, name: testName, hostPort: port, env: { HOST_CWD: cwd } });
    await waitForUp(port);
    const ps1 = await hostPs();
    const me1 = ps1.containers.find((c) => c.name === testName);
    expect(me1?.state).toBe('running');
    await hostStop(testName);
    await new Promise((r) => setTimeout(r, 200));
    const ps2 = await hostPs();
    const me2 = ps2.containers.find((c) => c.name === testName);
    expect(me2?.state).toBe('exited');
  });
});
