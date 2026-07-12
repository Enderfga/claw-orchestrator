/**
 * Embedded HTTP Server — auto-starts with plugin, serves CLI commands
 *
 * This is NOT a separate process. It runs inside the plugin (or standalone)
 * and provides HTTP endpoints for the CLI to connect to.
 *
 * Users never need to configure or manage this — it just works.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SessionManager } from './session-manager.js';
import { sanitizeCwd, validateRegex } from './validation.js';
import type { EffortLevel, EngineType } from './types.js';
import { handleChatCompletion } from './openai-compat.js';
import { getModelList } from './models.js';

import {
  DEFAULT_SERVER_PORT,
  MAX_BODY_SIZE,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  OPENAI_COMPAT_SESSION_PREFIX,
} from './constants.js';

// Grace period for server.close() to drain connections before lingering
// SSE/keep-alive sockets are force-dropped (otherwise close() hangs forever).
const SERVER_CLOSE_GRACE_MS = 5000;

function autoloopErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Autoloop run '.+' not found in registry$/.test(message)) return 404;
  if (/^Autoloop with id '.+' (?:already exists|is being deleted|is still starting)$/.test(message)) return 409;
  if (/^Autoloop session name '.+' is already in use$/.test(message)) return 409;
  if (/^(?:Planner|Coder|Reviewer) engine '.+' is not supported$/.test(message)) return 400;
  // Any custom-engine config complaint is caller error, not a server fault.
  // The old form pinned a single dotted segment and the verb "must be", so
  // `config.args.permissionMode must be a string` and `config.env must contain
  // only string values` both fell through to 500 — the opposite of the split
  // this helper exists to provide.
  if (/^(?:Planner|Coder|Reviewer) custom engine config\b/.test(message)) return 400;
  return 500;
}

/**
 * Custom engines name an arbitrary executable (`bin`) plus argv and env. That
 * is fine for a local, programmatic caller, but this HTTP surface is routinely
 * reverse-tunnelled to a public hostname, and its auth token is a *monitoring*
 * credential — it was never meant to confer "run any binary on the host".
 * Accepting a custom-engine object from the request body would turn any
 * dashboard session into remote code execution, so the network surface refuses
 * it outright. Built-in engines (the actual ask in #72) stay fully selectable.
 */
const CUSTOM_ENGINE_BODY_KEYS = ['planner_custom_engine', 'coder_custom_engine', 'reviewer_custom_engine'] as const;

function rejectCustomEngineOverHttp(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of CUSTOM_ENGINE_BODY_KEYS) {
    if (record[key] !== undefined && record[key] !== null) {
      return `${key} is not accepted over HTTP: a custom engine names an executable to spawn, so it may only be configured by a local caller (MCP tool / SessionManager API). Use a built-in engine here.`;
    }
  }
  return null;
}

export class EmbeddedServer {
  private server: http.Server | null = null;
  private manager: SessionManager;
  private port: number;
  private authToken: string | null = null;
  private _rateWindows = new Map<string, number[]>();
  private _rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _rateLimit: number;
  private host: string;

  constructor(manager: SessionManager, port?: number, host?: string) {
    this.manager = manager;
    this.port = port || DEFAULT_SERVER_PORT;
    this.host = host || process.env.OPENCLAW_SERVER_HOST || '127.0.0.1';
    this._rateLimit = parseInt(process.env.OPENCLAW_RATE_LIMIT || '', 10) || RATE_LIMIT_MAX_REQUESTS;
  }

  private _checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const window = this._rateWindows.get(ip) || [];
    const recent = window.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    this._rateWindows.set(ip, recent);
    return recent.length <= this._rateLimit;
  }

  /**
   * Try to reuse the token persisted by a previous server. Returns null if
   * the file is absent, unreadable, the wrong shape, or the wrong perms.
   * We accept any 32+ hex-char string (the format crypto.randomBytes(32)
   * produces) — anything else is treated as garbage and rotated out.
   */
  private _readPersistedToken(): string | null {
    const tokenPath = path.join(os.homedir(), '.openclaw', 'server-token');
    try {
      const raw = fs.readFileSync(tokenPath, 'utf-8').trim();
      // 64 hex chars from crypto.randomBytes(32).toString('hex'). Accept
      // ≥32 to be lenient with env-token-style strings copied into the file.
      if (/^[0-9a-fA-F]{32,256}$/.test(raw)) return raw;
      return null;
    } catch {
      return null;
    }
  }

  private _writeTokenFile(token: string): void {
    const tokenDir = path.join(os.homedir(), '.openclaw');
    try {
      if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
      fs.writeFileSync(path.join(tokenDir, 'server-token'), token, { mode: 0o600 });
    } catch (err) {
      console.warn(`[embedded-server] failed to write server-token file: ${(err as Error).message}`);
    }
  }

  async start(): Promise<number> {
    // Auth token policy (changed in 3.5.6 — closes CWE-306 from issue #61):
    //
    //   default                    → auto-generate 32-byte random token,
    //                                  write to ~/.openclaw/server-token mode 0600.
    //                                  Required on every non-/health request via
    //                                  Bearer header OR `clawo_auth` cookie OR
    //                                  ?token=<v> query.
    //   OPENCLAW_SERVER_TOKEN=<v>  → use the explicit token (legacy behaviour).
    //   OPENCLAW_SERVER_TOKEN=disabled → opt out of auth entirely. Only safe on
    //                                  a single-user host; loud warning at start.
    //
    // The file is mode 0600 (owner-read-only). Same-user CLI + dashboard read it;
    // other users on the same box cannot. Browsers reach /dashboard via the
    // `?token=<v>` query once; the server replies with a Set-Cookie so subsequent
    // requests authenticate via the cookie.
    const envToken = process.env.OPENCLAW_SERVER_TOKEN;
    if (envToken === 'disabled') {
      this.authToken = null;
      console.warn(
        '[embedded-server] OPENCLAW_SERVER_TOKEN=disabled — authentication is OFF. ' +
          'All endpoints are reachable to any process that can connect. Only safe on a trusted single-user host.',
      );
    } else if (envToken) {
      this.authToken = envToken;
    } else {
      // Reuse the existing on-disk token if one is present and well-formed.
      // Without this, every `clawo serve` restart rotates the token and
      // invalidates the browser cookie / CLI session — users had to re-login
      // to the dashboard after each restart. The token file is mode 0600
      // (owner-read-only), so reuse on a single-user host has the same
      // threat model as the freshly-generated token.
      const persisted = this._readPersistedToken();
      this.authToken = persisted ?? crypto.randomBytes(32).toString('hex');
    }
    // Note: the file write is deferred to the listen()-success callback below,
    // so a loser-of-EADDRINUSE race doesn't clobber the winner's token file.

    this._rateLimitCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, timestamps] of this._rateWindows) {
        const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length === 0) this._rateWindows.delete(ip);
        else this._rateWindows.set(ip, recent);
      }
    }, RATE_LIMIT_WINDOW_MS);
    this._rateLimitCleanupTimer.unref();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        // start() failed after the rate-limit timer was armed — clear it so it
        // does not leak (the listen-success path keeps it; every failure path
        // must tear it down).
        if (this._rateLimitCleanupTimer) {
          clearInterval(this._rateLimitCleanupTimer);
          this._rateLimitCleanupTimer = null;
        }
        if (err.code === 'EADDRINUSE') {
          // Port already in use — another instance running, skip
          console.log(`[embedded-server] Port ${this.port} in use, skipping (another instance running)`);
          this.server = null;
          resolve(0);
        } else {
          this.server = null;
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        // Bound successfully — NOW persist the token. A second instance that
        // loses EADDRINUSE never reaches this callback and leaves the file alone.
        if (this.authToken) {
          this._writeTokenFile(this.authToken);
          const tokenFile = path.join(os.homedir(), '.openclaw', 'server-token');
          console.log(`[embedded-server] Listening on http://${this.host}:${this.port} (auth enabled)`);
          console.log(`[embedded-server] Token file: ${tokenFile}`);
          // Only print the token-bearing convenience URL to an interactive TTY.
          // When stdout is captured (launchd, journald, log files, CI) the token
          // must NOT land in logs — direct the operator to the 0600 token file.
          if (process.stdout.isTTY) {
            console.log(
              `[embedded-server] Dashboard:  http://${this.host}:${this.port}/dashboard?token=${this.authToken}`,
            );
          } else {
            console.log(
              `[embedded-server] Dashboard:  http://${this.host}:${this.port}/dashboard  (token in ${tokenFile})`,
            );
          }
        } else {
          console.log(`[embedded-server] Listening on http://${this.host}:${this.port} (AUTH DISABLED)`);
        }
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this._rateLimitCleanupTimer) {
      clearInterval(this._rateLimitCleanupTimer);
      this._rateLimitCleanupTimer = null;
    }
    // NOTE: we intentionally do NOT delete the token file on stop. Keeping
    // it lets the next server invocation reuse the same token (see
    // _readPersistedToken), which means browser cookies / open dashboard
    // tabs / CLI sessions survive a `clawo serve` restart. The file is
    // mode 0600 so it does not widen the threat surface while the server
    // is down. If you need to rotate the token, delete the file manually
    // or set OPENCLAW_SERVER_TOKEN explicitly.
    if (!this.server) return;
    const server = this.server;
    this.server = null; // clear ref up-front so a concurrent start() can't race on a closing server
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // SSE / keep-alive connections never close on their own, so a bare
      // close() can hang forever. Force-drop lingering sockets after a grace
      // period (and immediately on Node versions that expose the helper).
      const forceTimer = setTimeout(() => {
        const closeAll = (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections;
        if (typeof closeAll === 'function') closeAll.call(server);
        done();
      }, SERVER_CLOSE_GRACE_MS);
      forceTimer.unref();
      server.close(() => {
        clearTimeout(forceTimer);
        done();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS — localhost by default; /v1/ paths allow all origins (for webchat frontends)
    const origin = req.headers.origin || '';
    const urlPath = new URL(req.url || '/', `http://localhost:${this.port}`).pathname;
    const corsAllowAll = process.env.OPENCLAW_CORS_ORIGINS === '*';
    const isV1Path = urlPath.startsWith('/v1/');
    // 0.0.0.0 is a bind/wildcard address, never a legitimate browser Origin —
    // don't reflect it back as an allowed CORS origin.
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
    if (isLocalhost || isV1Path || corsAllowAll) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const path = url.pathname;

    // Auth: accept Bearer header, `clawo_auth` cookie, or `?token=` query.
    // We re-read ~/.openclaw/server-token PER REQUEST (64-byte read, kernel
    // page cache, microseconds). Necessary because another clawo instance
    // (nohup test, second launchd, npm test process) can overwrite the file
    // mid-life; sasha-doctor's reverse proxy reads disk fresh on every
    // request, so without us doing the same we sit with a stale in-memory
    // token and 401 everything the proxy injects.
    if (this.authToken && path !== '/health') {
      const envExplicit =
        typeof process.env.OPENCLAW_SERVER_TOKEN === 'string' &&
        process.env.OPENCLAW_SERVER_TOKEN !== '' &&
        process.env.OPENCLAW_SERVER_TOKEN !== 'disabled';
      const liveToken = envExplicit
        ? (process.env.OPENCLAW_SERVER_TOKEN as string)
        : (this._readPersistedToken() ?? this.authToken);

      const authHeader = req.headers.authorization || '';
      const queryToken = url.searchParams.get('token');
      const cookieHeader = req.headers.cookie || '';
      const cookieToken = /(?:^|;\s*)clawo_auth=([^;]+)/.exec(cookieHeader)?.[1];

      const bearerOk = authHeader === `Bearer ${liveToken}`;
      const queryOk = queryToken === liveToken;
      const cookieOk = cookieToken === liveToken;

      if (!bearerOk && !queryOk && !cookieOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Unauthorized',
            hint: 'Send Authorization: Bearer <token> (token at ~/.openclaw/server-token), or visit /login?token=<token>&redirect=/dashboard in a browser to set the cookie via redirect (so the token does not appear in the bookmark URL).',
          }),
        );
        return;
      }

      // First-touch via query token → persist as cookie so subsequent same-origin
      // requests (including EventSource) authenticate without exposing the token
      // in URLs / referrers / access logs.
      if (queryOk && !cookieOk) {
        res.setHeader('Set-Cookie', `clawo_auth=${liveToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      }
    }

    // Rate limiting
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!this._checkRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Rate limit exceeded' }));
      return;
    }

    // Read body for POST — require JSON content type (CSRF mitigation)
    if (req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }
      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        this.route(path, parsed, url.searchParams, res, req.headers);
      });
    } else {
      this.route(path, {}, url.searchParams, res, req.headers);
    }
  }

  private async route(
    path: string,
    body: Record<string, unknown>,
    query: URLSearchParams,
    res: http.ServerResponse,
    headers: http.IncomingHttpHeaders = {},
  ): Promise<void> {
    try {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      // ─── Session Routes ──────────────────────────────────────────

      if (path === '/session/start') {
        if (body.cwd) body.cwd = sanitizeCwd(body.cwd as string);
        const info = await this.manager.startSession(body as Parameters<SessionManager['startSession']>[0]);
        json(200, { ok: true, ...info });
        return;
      }

      if (path === '/session/send') {
        const result = await this.manager.sendMessage(body.name as string, body.message as string, {
          effort: body.effort as EffortLevel | undefined,
          plan: body.plan as boolean | undefined,
          timeout: body.timeout as number | undefined,
        });
        json(200, { ok: true, ...result });
        return;
      }

      if (path === '/session/stop') {
        await this.manager.stopSession(body.name as string);
        json(200, { ok: true });
        return;
      }

      if (path === '/session/list') {
        json(200, { ok: true, sessions: this.manager.listSessions() });
        return;
      }

      if (path === '/session/status') {
        const status = this.manager.getStatus(body.name as string);
        json(200, { ok: true, ...status });
        return;
      }

      if (path === '/session/grep') {
        validateRegex(body.pattern as string);
        const matches = await this.manager.grepSession(
          body.name as string,
          body.pattern as string,
          body.limit as number | undefined,
        );
        json(200, { ok: true, count: matches.length, matches });
        return;
      }

      if (path === '/session/compact') {
        await this.manager.compactSession(body.name as string, body.summary as string | undefined);
        json(200, { ok: true });
        return;
      }

      if (path === '/session/cost') {
        const cost = this.manager.getCost(body.name as string);
        json(200, { ok: true, ...cost });
        return;
      }

      if (path === '/session/model') {
        this.manager.setModel(body.name as string, body.model as string);
        json(200, { ok: true });
        return;
      }

      if (path === '/session/effort') {
        this.manager.setEffort(body.name as string, body.level as EffortLevel);
        json(200, { ok: true });
        return;
      }

      // ─── Agent Teams ─────────────────────────────────────────────

      if (path === '/session/team-list') {
        const response = await this.manager.teamList(body.name as string);
        json(200, { ok: true, response });
        return;
      }

      if (path === '/session/team-send') {
        const result = await this.manager.teamSend(
          body.name as string,
          body.teammate as string,
          body.message as string,
        );
        json(200, { ok: true, ...result });
        return;
      }

      // ─── File Management ─────────────────────────────────────────

      if (path === '/agents') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, agents: this.manager.listAgents(cwd) });
        return;
      }

      if (path === '/agents/create') {
        const p = this.manager.createAgent(
          body.name as string,
          body.cwd as string | undefined,
          body.description as string | undefined,
          body.prompt as string | undefined,
        );
        json(200, { ok: true, path: p });
        return;
      }

      if (path === '/skills') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, skills: this.manager.listSkills(cwd) });
        return;
      }

      if (path === '/skills/create') {
        const p = this.manager.createSkill(
          body.name as string,
          body.cwd as string | undefined,
          body as Record<string, string>,
        );
        json(200, { ok: true, path: p });
        return;
      }

      if (path === '/rules') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, rules: this.manager.listRules(cwd) });
        return;
      }

      if (path === '/rules/create') {
        const p = this.manager.createRule(
          body.name as string,
          body.cwd as string | undefined,
          body as Record<string, string>,
        );
        json(200, { ok: true, path: p });
        return;
      }

      // ─── Health ──────────────────────────────────────────────────

      if (path === '/health') {
        json(200, { ok: true, version: this.manager.getVersion(), sessions: this.manager.listSessions().length });
        return;
      }

      // ─── OpenAI-Compatible Routes ─────────────────────────────

      if (path === '/v1/chat/completions') {
        await handleChatCompletion(this.manager, body, headers, res);
        return;
      }

      if (path === '/v1/models') {
        json(200, getModelList());
        return;
      }

      if (path === '/v1/sessions') {
        // Inspection endpoint for openai-compat sessions only — not interactive
        // CLI sessions. Production observability: lets ops verify the persistent
        // CLI is being reused (cached_tokens grows turn-over-turn) instead of
        // killed every request. Bearer-token gated like the rest of /v1/*.
        const rows = this.manager
          .listSessions()
          .filter((s) => s.name.startsWith(OPENAI_COMPAT_SESSION_PREFIX))
          .map((s) => {
            let stats: ReturnType<SessionManager['getStatus']>['stats'] | null = null;
            try {
              stats = this.manager.getStatus(s.name).stats;
            } catch {
              /* session may have just been reaped */
            }
            return {
              key: s.name.slice(OPENAI_COMPAT_SESSION_PREFIX.length),
              session_name: s.name,
              model: s.model,
              cwd: s.cwd,
              created: s.created,
              turns: stats?.turns,
              tokens_in: stats?.tokensIn,
              tokens_out: stats?.tokensOut,
              cached_tokens: stats?.cachedTokens,
              context_percent: stats?.contextPercent,
              cost_usd: stats?.costUsd,
            };
          });
        json(200, { object: 'list', data: rows });
        return;
      }

      // ─── Login redirect ─────────────────────────────────────────
      //
      // First-visit pattern for hosted access (e.g., behind a reverse proxy):
      // visit /login?token=<T>&redirect=<path>, which the auth gate above has
      // already validated. Server sets the auth cookie and 302s to redirect,
      // so the bookmark URL never contains the token (no referrer / CF log /
      // browser-history leak). The redirect target is restricted to same-
      // origin (must start with '/') to prevent open-redirect abuse.

      if (path === '/login') {
        // Auth gate above already passed (queryOk set the cookie via Set-Cookie),
        // so reaching here means the token is valid.
        const raw = query.get('redirect') || '/dashboard';
        // Same-origin only: must start with '/', not '//', and contain no scheme.
        const safe = /^\/(?!\/)/.test(raw) && !/^\/[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : '/dashboard';
        res.writeHead(302, { Location: safe });
        res.end();
        return;
      }

      // ─── Dashboard (single static HTML) ─────────────────────────
      //
      // Serves src/dashboard/index.html (or dist/src/dashboard/index.html in
      // a built install). Walks up like resolveConfigPath does so it works
      // both during dev (tsx) and from the published package.

      if (
        path === '/dashboard' ||
        path === '/dashboard/' ||
        path === '/dashboard/index.html' ||
        path === '/dash' ||
        path === '/dash/'
      ) {
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const urlMod = await import('node:url');
        const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
        let dir = here;
        let file = null;
        for (let i = 0; i < 8; i++) {
          const candidate = pathMod.join(dir, 'src', 'dashboard', 'index.html');
          if (fsMod.existsSync(candidate)) {
            file = candidate;
            break;
          }
          const parent = pathMod.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        if (!file) {
          json(404, { ok: false, error: 'dashboard asset not found' });
          return;
        }
        const html = fsMod.readFileSync(file, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }

      // ─── Council — list / state / events ────────────────────────
      //
      // Mirrors the autoloop endpoints below. The dashboard page consumes
      // these to render the council tab.

      if (path === '/council/list') {
        json(200, { ok: true, councils: this.manager.councilList() });
        return;
      }

      // ─── Council — launch new (dashboard "+ New" button) ────────
      //
      // Minimal contract: { task, projectDir, maxRounds? }. Dashboard form
      // uses a 3-agent Claude Opus preset (planner / implementer / critic);
      // power users who want custom personas can call the `council_start`
      // plugin tool through OpenClaw instead.
      if (path === '/council/new') {
        const task = (body as { task?: string }).task;
        const projectDir = (body as { projectDir?: string }).projectDir;
        if (typeof task !== 'string' || !task.trim()) {
          json(400, { ok: false, error: 'task (string) required' });
          return;
        }
        if (typeof projectDir !== 'string' || !projectDir.trim()) {
          json(400, { ok: false, error: 'projectDir (string) required' });
          return;
        }
        const safeProjectDir = sanitizeCwd(projectDir);
        if (!safeProjectDir) {
          json(400, { ok: false, error: 'projectDir failed sanitization' });
          return;
        }
        const session = this.manager.councilStart(task, {
          projectDir: safeProjectDir,
          agents: [
            {
              name: 'agent-A',
              emoji: '🔵',
              persona:
                'You are agent A, a careful planner. Lay out the approach and architecture before changing code.',
              engine: 'claude',
              model: 'claude-opus-4-7',
            },
            {
              name: 'agent-B',
              emoji: '🟠',
              persona: 'You are agent B, a pragmatic implementer. Make the change small, focused, and review-ready.',
              engine: 'claude',
              model: 'claude-opus-4-7',
            },
            {
              name: 'agent-C',
              emoji: '🟢',
              persona:
                'You are agent C, a critical reviewer. Block consensus until the quality bar is met — be specific about what is missing.',
              engine: 'claude',
              model: 'claude-opus-4-7',
            },
          ],
          maxRounds: (body as { maxRounds?: number }).maxRounds ?? 15,
          defaultPermissionMode: 'bypassPermissions',
        });
        json(200, { ok: true, id: session.id, status: session.status });
        return;
      }

      const councilStateMatch = path.match(/^\/council\/([^/]+)\/state$/);
      if (councilStateMatch) {
        const session = this.manager.councilStatus(councilStateMatch[1]);
        if (!session) {
          json(404, { ok: false, error: 'council not found' });
        } else {
          json(200, { ok: true, session });
        }
        return;
      }

      const councilEventsMatch = path.match(/^\/council\/([^/]+)\/events$/);
      if (councilEventsMatch) {
        const id = councilEventsMatch[1];
        const council = this.manager.getCouncil(id);
        if (!council) {
          json(404, { ok: false, error: 'council not found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (event: string, data: unknown): void => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        // Replay current session so the dashboard renders immediately.
        const snap = council.getSession();
        if (snap) send('snapshot', snap);

        const onEvent = (e: unknown): void => send('council-event', e);
        const cleanup = (): void => {
          council.off('council-event', onEvent);
          try {
            res.end();
          } catch {
            /* ignore */
          }
        };
        council.on('council-event', onEvent);
        res.on('close', cleanup);
        return;
      }

      // ─── Autoloop — list / state / push log / SSE events ─────
      //
      // Front-end contract used by the dashboard's 3-pane Orchestrator view.

      if (path === '/autoloop/list') {
        json(200, { ok: true, runs: this.manager.autoloopList() });
        return;
      }

      // ─── Autoloop — launch new (dashboard "+ New" button) ───────
      //
      // Contract: workspace/run_id plus optional per-role engine/model/custom-engine config.
      // When run_id is omitted or malformed, the server generates
      // `auto-{timestamp}-{4-byte-hex}`. Power users wanting a meaningful id
      // (e.g. "ml-refactor-v2") can pass run_id explicitly.
      if (path === '/autoloop/new') {
        const customEngineRejection = rejectCustomEngineOverHttp(body);
        if (customEngineRejection) {
          json(400, { ok: false, error: customEngineRejection });
          return;
        }
        const input = body as {
          workspace?: string;
          run_id?: string;
          planner_engine?: EngineType;
          planner_model?: string;
          coder_engine?: EngineType;
          coder_model?: string;
          reviewer_engine?: EngineType;
          reviewer_model?: string;
          send_timeout_ms?: number;
        };
        const workspace = input.workspace;
        if (typeof workspace !== 'string' || !workspace.trim()) {
          json(400, { ok: false, error: 'workspace (string) required' });
          return;
        }
        const safeWorkspace = sanitizeCwd(workspace);
        if (!safeWorkspace) {
          json(400, { ok: false, error: 'workspace failed sanitization' });
          return;
        }
        const explicitId = input.run_id;
        const runId =
          typeof explicitId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(explicitId)
            ? explicitId
            : `auto-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        try {
          const result = await this.manager.autoloopStart({
            runId,
            workspace: safeWorkspace,
            plannerEngine: input.planner_engine,
            plannerModel: input.planner_model,
            coderEngine: input.coder_engine,
            coderModel: input.coder_model,
            reviewerEngine: input.reviewer_engine,
            reviewerModel: input.reviewer_model,
            sendTimeoutMs: input.send_timeout_ms,
          });
          json(200, {
            ok: true,
            run_id: result.runId,
            planner_session: result.plannerSession,
          });
        } catch (err) {
          json(autoloopErrorStatus(err), { ok: false, error: (err as Error).message });
        }
        return;
      }

      const v2StateMatch = path.match(/^\/autoloop\/([^/]+)\/state$/);
      if (v2StateMatch) {
        const state = this.manager.autoloopStatus(v2StateMatch[1]);
        if (!state) {
          json(404, { ok: false, error: 'run not found' });
        } else {
          json(200, { ok: true, state });
        }
        return;
      }

      const v2PushLogMatch = path.match(/^\/autoloop\/([^/]+)\/push_log$/);
      if (v2PushLogMatch) {
        const id = v2PushLogMatch[1];
        // Use autoloopStatus so terminated/disk-only runs are served from
        // the registry-reconstructed ledger_dir, not just live runs.
        const status = this.manager.autoloopStatus(id);
        if (!status) {
          json(404, { ok: false, error: 'run not found' });
          return;
        }
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const file = pathMod.join(status.ledger_dir, 'push_log.jsonl');
        const lines: unknown[] = [];
        if (fsMod.existsSync(file)) {
          for (const line of fsMod.readFileSync(file, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              lines.push(JSON.parse(line));
            } catch {
              /* skip malformed line */
            }
          }
        }
        json(200, { ok: true, entries: lines });
        return;
      }

      // GET /autoloop/<id>/chat_history → entries from <ledger>/chat.jsonl.
      // Dashboard fetches this when opening a run so historic conversation
      // is restored after page refresh / process restart. Returns [] when
      // the file is missing (new runs).
      const v2HistMatch = path.match(/^\/autoloop\/([^/]+)\/chat_history$/);
      if (v2HistMatch) {
        const id = v2HistMatch[1];
        const status = this.manager.autoloopStatus(id);
        if (!status) {
          json(404, { ok: false, error: 'run not found' });
          return;
        }
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const file = pathMod.join(status.ledger_dir, 'chat.jsonl');
        const lines: unknown[] = [];
        if (fsMod.existsSync(file)) {
          for (const line of fsMod.readFileSync(file, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              lines.push(JSON.parse(line));
            } catch {
              /* skip malformed line */
            }
          }
        }
        json(200, { ok: true, entries: lines });
        return;
      }

      const v2EventsMatch = path.match(/^\/autoloop\/([^/]+)\/events$/);
      if (v2EventsMatch) {
        const id = v2EventsMatch[1];
        const ctx = this.manager.getAutoloop(id);
        if (!ctx) {
          // Run not in this process's memory. If the registry knows about
          // it, serve a single-shot SSE: snapshot of the reconstructed
          // terminated state, then 'terminated' event, then close. Stops
          // the dashboard from hanging on "Waiting…" for historical runs.
          const histState = this.manager.autoloopStatus(id);
          if (!histState) {
            json(404, { ok: false, error: 'run not found' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: snapshot\ndata: ${JSON.stringify({ state: histState })}\n\n`);
          res.write(
            `event: terminated\ndata: ${JSON.stringify({ reason: histState.status_reason ?? 'historical' })}\n\n`,
          );
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let sseClosed = false;
        const send = (event: string, data: unknown): void => {
          // A runner/dispatcher event can fire after the client disconnects or
          // after cleanup() has ended the response. Writing then throws
          // ERR_STREAM_WRITE_AFTER_END inside an emitter callback (unhandled).
          if (sseClosed || res.writableEnded || !res.writable) return;
          try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {
            // Connection broke mid-write; stop sending. res 'close' fires
            // cleanup() to detach listeners and end the response.
            sseClosed = true;
          }
        };
        send('snapshot', { state: ctx.runner.state });

        const onMessage = (env: unknown): void => send('message', env);
        const onState = (s: unknown): void => send('state', s);
        const onPush = (e: unknown): void => send('push', e);
        const onIterDone = (e: unknown): void => send('iter_done', e);
        const onTerm = (r: unknown): void => {
          send('terminated', { reason: r });
          cleanup();
        };
        const onPlannerReply = (text: unknown): void => send('planner_reply', { text });
        const onPlannerError = (err: unknown): void =>
          send('planner_error', { message: err instanceof Error ? err.message : String(err) });
        const onCoderReply = (text: unknown): void => send('coder_reply', { text });
        const onReviewerReply = (text: unknown): void => send('reviewer_reply', { text });
        const onCompact = (e: unknown): void => send('compact', e);
        const cleanup = (): void => {
          sseClosed = true;
          ctx.runner.off('message', onMessage);
          ctx.runner.off('state', onState);
          ctx.runner.off('push', onPush);
          ctx.runner.off('iter_done', onIterDone);
          ctx.runner.off('terminated', onTerm);
          ctx.dispatcher.off('planner_reply', onPlannerReply);
          ctx.dispatcher.off('planner_error', onPlannerError);
          ctx.dispatcher.off('coder_reply', onCoderReply);
          ctx.dispatcher.off('reviewer_reply', onReviewerReply);
          ctx.dispatcher.off('compact', onCompact);
          try {
            res.end();
          } catch {
            /* ignore */
          }
        };
        ctx.runner.on('message', onMessage);
        ctx.runner.on('state', onState);
        ctx.runner.on('push', onPush);
        ctx.runner.on('iter_done', onIterDone);
        ctx.runner.on('terminated', onTerm);
        ctx.dispatcher.on('planner_reply', onPlannerReply);
        ctx.dispatcher.on('planner_error', onPlannerError);
        ctx.dispatcher.on('coder_reply', onCoderReply);
        ctx.dispatcher.on('reviewer_reply', onReviewerReply);
        ctx.dispatcher.on('compact', onCompact);
        res.on('close', cleanup);
        return;
      }

      // ─── Autoloop — chat into the Planner ─────────────────────
      //
      // POST /autoloop/<run_id>/chat  { text }  →  202 { ok, queued: true }
      //
      // Fire-and-forget. The Planner's reply streams back as a planner_reply
      // event on /autoloop/<id>/events (SSE). We DO NOT await it on this
      // request because first-contact replies routinely exceed the
      // Cloudflare Tunnel origin idle limit (~100s, returns 524). The MCP
      // `autoloop_chat` tool path keeps the await-and-return-reply
      // semantics — it runs in-process, not through Cloudflare.
      const v2ChatMatch = path.match(/^\/autoloop\/([^/]+)\/chat$/);
      if (v2ChatMatch) {
        const id = v2ChatMatch[1];
        const text = (body as { text?: string }).text;
        if (typeof text !== 'string' || !text.trim()) {
          json(400, { ok: false, error: 'text (non-empty string) required' });
          return;
        }
        // Validate run exists synchronously so 404 surfaces cleanly. After
        // this point we hand the message off to the runner and return.
        if (!this.manager.getAutoloop(id)) {
          json(404, { ok: false, error: `Autoloop run '${id}' not found` });
          return;
        }
        this.manager.autoloopChat(id, text).catch((err) => {
          // Late failures (planner errors, runner shutdown mid-dispatch) flow
          // to SSE as planner_error events; this catch only exists to keep
          // unhandled rejection from crashing the server.
          console.warn(`[autoloop/${id}] chat dispatch failed: ${(err as Error).message}`);
        });
        json(202, { ok: true, queued: true });
        return;
      }

      // ─── Autoloop — delete a run from the registry ────────────
      //
      // POST /autoloop/<run_id>/delete
      //
      // Stops the runner if still alive in this process, then scrubs the
      // row from ~/.claw-orchestrator/autoloop-registry.jsonl. Ledger files
      // under <workspace>/tasks/<run_id>/ are kept on disk for postmortem.
      const v2DeleteMatch = path.match(/^\/autoloop\/([^/]+)\/delete$/);
      if (v2DeleteMatch) {
        const id = v2DeleteMatch[1];
        try {
          const removed = await this.manager.autoloopDelete(id);
          if (!removed) {
            json(404, { ok: false, error: 'run not found' });
          } else {
            json(200, { ok: true });
          }
        } catch (err) {
          json(500, { ok: false, error: (err as Error).message });
        }
        return;
      }

      // ─── Autoloop — resume a terminated run ───────────────────
      //
      // POST /autoloop/<run_id>/resume
      //
      // Re-attaches a run that exists in the registry but isn't in this
      // process's in-memory map (terminated, or live in a different process).
      // SessionManager.autoloopResume re-creates dispatcher + runner; if the
      // Planner's persistedSessions entry survived shutdown (it does for
      // runs that ended via terminate, NOT for autoloopDelete), Claude will
      // resume the original conversation. Otherwise a fresh Planner is
      // spawned and the dashboard replays chat.jsonl visually.
      const v2ResumeMatch = path.match(/^\/autoloop\/([^/]+)\/resume$/);
      if (v2ResumeMatch) {
        const id = v2ResumeMatch[1];
        const resumeRejection = rejectCustomEngineOverHttp(body);
        if (resumeRejection) {
          json(400, { ok: false, error: resumeRejection });
          return;
        }
        try {
          // No custom-engine configs here by design (see rejectCustomEngineOverHttp).
          // A run whose roles used custom engines therefore cannot be resumed over
          // HTTP; autoloopResume reports that as a caller error, not a 500.
          const state = await this.manager.autoloopResume(id, {});
          json(200, { ok: true, state });
        } catch (err) {
          json(autoloopErrorStatus(err), { ok: false, error: (err as Error).message });
        }
        return;
      }

      // ─── ultraapp ─────────────────────────────────────────────
      // Forge-tab routes. The events endpoint is SSE; the rest return JSON.

      const uaSseMatch = path.match(/^\/ultraapp\/([^/]+)\/events$/);
      if (uaSseMatch) {
        const runId = uaSseMatch[1];
        const ua = this.manager.getUltraappManager?.();
        if (!ua) {
          json(404, { ok: false, error: 'ultraapp manager unavailable' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let unsub: (() => void) | null = null;
        try {
          unsub = ua.subscribe(runId, (ev: unknown) => {
            res.write(`event: ultraapp\n`);
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          });
        } catch (e) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ message: (e as Error).message })}\n\n`);
          res.end();
          return;
        }
        res.on('close', () => unsub?.());
        return;
      }

      const uaMatch = path.match(/^\/ultraapp(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (uaMatch) {
        const ua = this.manager.getUltraappManager?.();
        if (!ua) {
          json(404, { ok: false, error: 'ultraapp manager unavailable' });
          return;
        }
        const seg1 = uaMatch[1];
        const seg2 = uaMatch[2];
        const seg3 = uaMatch[3];

        if (seg1 === 'list' && !seg2) {
          const runs = await ua.store.listRuns();
          json(200, { ok: true, runs });
          return;
        }
        if (seg1 === 'new' && !seg2) {
          const runId = await ua.createRun();
          json(200, { ok: true, runId });
          return;
        }
        if (seg1 && !seg2) {
          try {
            const [spec, chat, state] = await Promise.all([
              ua.store.readSpec(seg1),
              ua.store.readChat(seg1),
              ua.store.readState(seg1),
            ]);
            json(200, { ok: true, spec, chat, state });
          } catch (e) {
            json(404, { ok: false, error: (e as Error).message });
          }
          return;
        }
        if (seg1 && seg2 === 'answer') {
          await ua.submitAnswer(seg1, body as { value: string; freeform?: string });
          json(200, { ok: true });
          return;
        }
        if (seg1 && seg2 === 'spec-edit') {
          await ua.applySpecEdit(seg1, (body as { patch: unknown[] }).patch as never);
          json(200, { ok: true });
          return;
        }
        if (seg1 && seg2 === 'build' && seg3 === 'cancel') {
          ua.cancelBuild(seg1);
          json(200, { ok: true });
          return;
        }
        if (seg1 && seg2 === 'build' && !seg3) {
          await ua.startBuild(seg1);
          json(200, { ok: true });
          return;
        }
        if (seg1 && seg2 === 'artifacts' && !seg3) {
          const arts = await ua.store.readArtifacts(seg1);
          json(200, { ok: true, artifacts: arts });
          return;
        }
        if (seg1 && seg2 === 'start' && !seg3) {
          const r = await ua.startContainer(seg1);
          json(r.ok ? 200 : 500, r);
          return;
        }
        if (seg1 && seg2 === 'stop' && !seg3) {
          const r = await ua.stopContainer(seg1);
          json(r.ok ? 200 : 500, r);
          return;
        }
        if (seg1 && seg2 === 'delete' && !seg3) {
          const r = await ua.deleteRun(seg1);
          json(r.ok ? 200 : 500, r);
          return;
        }
        if (seg1 && seg2 === 'feedback' && !seg3) {
          const t = (body as { text?: string }).text;
          if (typeof t !== 'string' || !t.trim()) {
            json(400, { ok: false, error: 'text required' });
            return;
          }
          await ua.submitDoneModeMessage(seg1, t);
          json(200, { ok: true });
          return;
        }
        if (seg1 && seg2 === 'promote-version' && !seg3) {
          const v = (body as { version?: string }).version;
          if (typeof v !== 'string' || !/^v\d+$/.test(v)) {
            json(400, { ok: false, error: 'version (vN) required' });
            return;
          }
          const r = await ua.promoteVersion(seg1, v);
          json(r.ok ? 200 : 500, r);
          return;
        }
        if (seg1 && seg2 === 'files') {
          const b = body as Record<string, unknown>;
          if (typeof b.absolutePath === 'string') {
            const r = await ua.addFile(seg1, { kind: 'path', absolutePath: b.absolutePath });
            json(200, { ok: true, ...r });
            return;
          }
          if (typeof b.filename === 'string' && typeof b.dataB64 === 'string') {
            const data = Buffer.from(b.dataB64, 'base64');
            const r = await ua.addFile(seg1, { kind: 'upload', filename: b.filename, data });
            json(200, { ok: true, ...r });
            return;
          }
          json(400, { ok: false, error: 'must provide absolutePath OR filename+dataB64' });
          return;
        }
      }

      // Use OpenAI error format for /v1/* paths
      if (path.startsWith('/v1/')) {
        json(404, { error: { message: 'Not found', type: 'invalid_request_error', code: null } });
      } else {
        json(404, { ok: false, error: 'Not found' });
      }
    } catch (err) {
      const message = (err as Error).message;
      if (path.startsWith('/v1/')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: 'server_error', code: null } }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    }
  }
}
