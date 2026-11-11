/**
 * UltraappRouter — tiny in-process reverse proxy that maps
 *   GET/POST/... /forge/<slug>/* → http://127.0.0.1:<backend-port>/*
 *
 * Default port: 19000. If 19000 is occupied, falls back to the next free
 * port in [19000, 19000 + fallbackPorts]. The slug→port map is persisted
 * synchronously to mapPath so a freshly-constructed router restarts with
 * the same routes after process restart.
 *
 * Backends are detected lazily — proxy errors surface as 502.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The embedded server's full-control auth cookie. Browsers scope cookies by
 * host, not port, so the cookie the dashboard sets on :18796 (`Path=/`) is also
 * sent here. App backends must never see it, nor set it.
 */
const CONTROL_COOKIE = 'clawo_auth';

const cookieName = (pair: string): string => pair.split('=')[0].trim().toLowerCase();

/** The request's Cookie header without the control cookie; undefined when nothing is left. */
function stripControlCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && cookieName(pair) !== CONTROL_COOKIE);
  return kept.length ? kept.join('; ') : undefined;
}

export interface UltraappRouterOptions {
  port: number;
  mapPath: string;
  /** Try up to this many subsequent ports if `port` is taken; default 99. */
  fallbackPorts?: number;
  /**
   * The server's full-control token, asked for on every request because it can
   * change. An `Authorization` header that carries it — a reverse proxy adding
   * the server's token to every request for the host does that — is removed
   * before the app sees the request; an app's own `Authorization` passes through.
   */
  controlToken?: () => string | undefined;
}

export class UltraappRouter {
  private readonly map = new Map<string, number>(); // slug → backend port
  private readonly mapPath: string;
  private readonly basePort: number;
  private readonly fallbackPorts: number;
  private readonly controlToken: (() => string | undefined) | undefined;
  private server: http.Server | null = null;
  private actualPort: number = 0;

  constructor(opts: UltraappRouterOptions) {
    this.mapPath = opts.mapPath;
    this.basePort = opts.port;
    this.fallbackPorts = opts.fallbackPorts ?? 99;
    this.controlToken = opts.controlToken;
    this.loadFromDisk();
  }

  async start(): Promise<number> {
    let lastErr: Error | null = null;
    for (let p = this.basePort; p <= this.basePort + this.fallbackPorts; p++) {
      try {
        await this.listenOn(p);
        this.actualPort = p;
        return p;
      } catch (e) {
        lastErr = e as Error;
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
      }
    }
    throw new Error(
      `UltraappRouter: no free port in [${this.basePort}, ${this.basePort + this.fallbackPorts}]: ${lastErr?.message ?? 'unknown'}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => this.server!.close(() => resolve()));
  }

  port(): number {
    return this.actualPort;
  }

  register(slug: string, backendPort: number): void {
    this.map.set(slug, backendPort);
    this.saveToDisk();
  }

  deregister(slug: string): void {
    this.map.delete(slug);
    this.saveToDisk();
  }

  list(): Array<{ slug: string; port: number }> {
    return [...this.map.entries()].map(([slug, port]) => ({ slug, port }));
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // A throw while proxying fails that request, not the server process.
      const srv = http.createServer((req, res) => {
        try {
          this.handle(req, res);
        } catch (err) {
          if (res.headersSent) res.destroy();
          else {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`proxy error: ${(err as Error).message}`);
          }
        }
      });
      const onError = (err: Error) => {
        srv.removeListener('error', onError);
        reject(err);
      };
      srv.on('error', onError);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', onError);
        // A server error after listening must not go unheard: with no listener,
        // the emit would throw out of the event loop.
        srv.on('error', (err) => console.warn(`[ultraapp] router error: ${err.message}`));
        this.server = srv;
        resolve();
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const m = /^\/forge\/([a-z0-9-]+)(\/.*)?$/.exec(url);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const slug = m[1];
    const backend = this.map.get(slug);
    if (backend === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`forge slug not registered: ${slug}`);
      return;
    }
    // Forward the FULL URL — including the /forge/<slug> prefix. Apps
    // following the conventions mount at BASE_PATH=/forge/<slug>/ (e.g.
    // Hono's `root.basePath('/forge/<slug>')` model), so the framework
    // itself owns prefix-stripping. Stripping here would double-strip and
    // 404 every request.
    // The dashboard's control cookie is removed on the way in and refused on
    // the way out: a generated app is not trusted with the server's token. Nor
    // with credentials meant for this hop: `Proxy-Authorization` is addressed
    // to a proxy, and an `Authorization` carrying the server's token is too.
    const headers: http.OutgoingHttpHeaders = { ...req.headers, 'x-forwarded-prefix': `/forge/${slug}` };
    delete headers.cookie;
    delete headers['proxy-authorization'];
    const token = this.controlToken?.();
    if (token && req.headers.authorization?.includes(token)) delete headers.authorization;
    const cookie = stripControlCookie(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    const proxy = http.request(
      {
        host: '127.0.0.1',
        port: backend,
        path: url,
        method: req.method,
        headers,
      },
      (br) => {
        const out: http.OutgoingHttpHeaders = { ...br.headers };
        const setCookie = br.headers['set-cookie']?.filter((c) => cookieName(c) !== CONTROL_COOKIE);
        if (setCookie?.length) out['set-cookie'] = setCookie;
        else delete out['set-cookie'];
        try {
          res.writeHead(br.statusCode ?? 502, out);
        } catch (e) {
          // A status or header the app sent that Node will not write.
          br.destroy();
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`proxy error: ${(e as Error).message}`);
          return;
        }
        br.pipe(res);
      },
    );
    // The app can fail after its response has started (it closes the connection
    // while the client is still sending, or dies mid-body); by then there is no
    // 502 to send, only a connection to close.
    proxy.on('error', (e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`proxy error: ${e.message}`);
    });
    res.on('close', () => {
      if (!res.writableFinished) proxy.destroy();
    });
    req.pipe(proxy);
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.mapPath, 'utf8');
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const [slug, port] of Object.entries(obj)) this.map.set(slug, port);
    } catch {
      /* no map yet */
    }
  }

  private saveToDisk(): void {
    const obj: Record<string, number> = {};
    for (const [slug, port] of this.map) obj[slug] = port;
    try {
      fs.mkdirSync(path.dirname(this.mapPath), { recursive: true });
      fs.writeFileSync(this.mapPath, JSON.stringify(obj, null, 2));
    } catch {
      /* best effort — non-persistent operation is still fine for current process */
    }
  }
}
