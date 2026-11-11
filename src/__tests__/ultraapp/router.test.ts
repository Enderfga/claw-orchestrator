import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UltraappRouter } from '../../ultraapp/router.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startBackend(port: number, body: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${body}|path=${req.url}`);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('UltraappRouter', () => {
  let mapDir: string;
  let mapPath: string;
  let router: UltraappRouter;
  let backend: http.Server;
  let routerPort: number;
  let backendPort: number;

  beforeEach(async () => {
    routerPort = await freePort();
    backendPort = await freePort();
    mapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-router-'));
    mapPath = path.join(mapDir, 'map.json');
    router = new UltraappRouter({ port: routerPort, mapPath, fallbackPorts: 10 });
    await router.start();
    backend = await startBackend(backendPort, 'backend-A');
  });
  afterEach(async () => {
    await router.stop();
    await new Promise<void>((r) => backend.close(() => r()));
    fs.rmSync(mapDir, { recursive: true, force: true });
  });

  it('proxies /forge/<slug>/* to the registered backend with the full URL preserved', async () => {
    // The router does NOT strip the /forge/<slug> prefix — apps mount at
    // BASE_PATH internally (Hono basePath / Next.js basePath) and expect
    // the full URL.
    router.register('foo', backendPort);
    const r = await get(routerPort, '/forge/foo/bar');
    expect(r.status).toBe(200);
    expect(r.body).toContain('backend-A');
    expect(r.body).toContain('path=/forge/foo/bar');
  });

  it('returns 404 for /forge/<slug>/ when slug is unregistered', async () => {
    const r = await get(routerPort, '/forge/missing/');
    expect(r.status).toBe(404);
  });

  it('returns 404 for non-/forge paths', async () => {
    const r = await get(routerPort, '/');
    expect(r.status).toBe(404);
  });

  it('persists registrations to the map file synchronously', async () => {
    router.register('bar', backendPort);
    const onDisk = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as Record<string, number>;
    expect(onDisk.bar).toBe(backendPort);
  });

  it('reloads registrations from disk on construction', async () => {
    router.register('saved', backendPort);
    await router.stop();
    const port2 = await freePort();
    const router2 = new UltraappRouter({ port: port2, mapPath });
    await router2.start();
    try {
      const r = await get(port2, '/forge/saved/');
      expect(r.status).toBe(200);
      expect(r.body).toContain('backend-A');
    } finally {
      await router2.stop();
    }
  });

  it('deregister removes the route', async () => {
    router.register('temp', backendPort);
    router.deregister('temp');
    const r = await get(routerPort, '/forge/temp/');
    expect(r.status).toBe(404);
  });

  it('list() returns current registrations', () => {
    router.register('a', backendPort);
    router.register('b', backendPort + 1);
    const l = router.list();
    expect(l.length).toBe(2);
    expect(l.find((x) => x.slug === 'a')!.port).toBe(backendPort);
  });

  // Browsers scope cookies by host, not port, so the dashboard's full-control
  // `clawo_auth` cookie (set by the embedded server on :18796, Path=/) is also
  // sent to the router on :19000. It must never reach an app backend, and a
  // backend must not be able to set or overwrite it.
  describe('control-plane cookie', () => {
    let echo: http.Server;
    let echoPort: number;
    let seen: Array<string | undefined>;

    beforeEach(async () => {
      seen = [];
      echoPort = await freePort();
      echo = await new Promise<http.Server>((resolve) => {
        const srv = http.createServer((req, res) => {
          seen.push(req.headers.cookie);
          res.setHeader('Set-Cookie', [
            'clawo_auth=from-app; Path=/; HttpOnly',
            'app_session=s1; Path=/forge/c/',
            ' CLAWO_AUTH =x; Path=/',
            'clawo_auth_hint=ok; Path=/forge/c/',
          ]);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        });
        srv.listen(echoPort, '127.0.0.1', () => resolve(srv));
      });
      router.register('c', echoPort);
    });
    afterEach(async () => {
      await new Promise<void>((r) => echo.close(() => r()));
    });

    function request(cookie?: string): Promise<{ status: number; setCookie: string[] }> {
      return new Promise((resolve, reject) => {
        http
          .get(
            { host: '127.0.0.1', port: routerPort, path: '/forge/c/x', headers: cookie ? { cookie } : {} },
            (res) => {
              res.resume();
              res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie'] ?? [] }));
            },
          )
          .on('error', reject);
      });
    }

    it('strips clawo_auth from the Cookie header and keeps the app cookies', async () => {
      await request('app_session=s1; clawo_auth=SECRET-TOKEN; clawo_auth_hint=ok');
      await request('clawo_auth=SECRET-TOKEN');
      await request('a=1;clawo_auth=SECRET-TOKEN;b=2');
      expect(seen).toEqual(['app_session=s1; clawo_auth_hint=ok', undefined, 'a=1; b=2']);
      expect(seen.join(' ')).not.toContain('SECRET-TOKEN');
    });

    it('drops a backend Set-Cookie for clawo_auth and passes the others through', async () => {
      const r = await request();
      expect(r.status).toBe(200);
      expect(r.setCookie).toEqual(['app_session=s1; Path=/forge/c/', 'clawo_auth_hint=ok; Path=/forge/c/']);
    });
  });

  // A reverse proxy that adds the server's token to every request for the host
  // would hand it to the app; `Proxy-Authorization` is addressed to a proxy.
  it("keeps the server's token and proxy credentials from the app, and passes the app's own Authorization", async () => {
    const seen: Array<{ auth?: string; proxy?: string }> = [];
    const echoPort = await freePort();
    const echo = await new Promise<http.Server>((resolve) => {
      const srv = http.createServer((req, res) => {
        seen.push({ auth: req.headers.authorization, proxy: req.headers['proxy-authorization'] as string | undefined });
        res.end('ok');
      });
      srv.listen(echoPort, '127.0.0.1', () => resolve(srv));
    });
    const guardedPort = await freePort();
    const guarded = new UltraappRouter({
      port: guardedPort,
      mapPath: path.join(path.dirname(mapPath), 'guarded.json'),
      fallbackPorts: 10,
      controlToken: () => 'CONTROL-TOKEN',
    });
    const port = await guarded.start();
    guarded.register('g', echoPort);
    const get = (headers: Record<string, string>) =>
      new Promise<void>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/forge/g/x', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve());
          })
          .on('error', reject);
      });
    try {
      await get({ authorization: 'Bearer CONTROL-TOKEN', 'proxy-authorization': 'Basic cHJveHk6cHc=' });
      await get({ authorization: 'Bearer sk-app-own-key' });
      expect(seen).toEqual(
        [{}, { auth: 'Bearer sk-app-own-key' }].map((e) => ({ auth: undefined, proxy: undefined, ...e })),
      );
    } finally {
      await guarded.stop();
      await new Promise<void>((r) => echo.close(() => r()));
    }
  });

  // The app can fail after its response has started. The router answered that
  // with a second writeHead, which threw out of the event loop.
  it('survives an app that resets the connection after its response has started', async () => {
    const appPort = await freePort();
    const app = await new Promise<http.Server>((resolve) => {
      const srv = http.createServer((req, res) => {
        if (req.url === '/forge/r/ok') {
          res.end('fine');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial');
        setTimeout(() => req.socket.resetAndDestroy(), 20);
      });
      srv.listen(appPort, '127.0.0.1', () => resolve(srv));
    });
    router.register('r', appPort);
    const get = (p: string) =>
      new Promise<{ status: number; body: string; error?: string }>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: routerPort, path: p }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          res.on('error', (e) => resolve({ status: res.statusCode ?? 0, body, error: e.message }));
          res.on('aborted', () => resolve({ status: res.statusCode ?? 0, body, error: 'aborted' }));
        });
        req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      });
    try {
      const broken = await get('/forge/r/x');
      expect(broken.status).toBe(200);
      expect(await get('/forge/r/ok')).toEqual({ status: 200, body: 'fine' });
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });

  it('falls back to next free port when basePort taken', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise<void>((r) => blocker.on('listening', () => r()));
    const blockedPort = (blocker.address() as net.AddressInfo).port;
    const r = new UltraappRouter({ port: blockedPort, mapPath, fallbackPorts: 5 });
    try {
      const actual = await r.start();
      expect(actual).toBeGreaterThan(blockedPort);
      expect(r.port()).toBe(actual);
    } finally {
      await r.stop();
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });
});
