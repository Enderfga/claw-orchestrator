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
import { SessionManager } from './session-manager.js';
import { sanitizeCwd, validateRegex } from './validation.js';
import type { EffortLevel } from './types.js';
import { handleChatCompletion } from './openai-compat.js';
import { getModelList } from './models.js';

import {
  DEFAULT_SERVER_PORT,
  MAX_BODY_SIZE,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  OPENAI_COMPAT_SESSION_PREFIX,
} from './constants.js';

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

  async start(): Promise<number> {
    // Auth token: opt-in via OPENCLAW_SERVER_TOKEN env var.
    // When set, all requests (except /health) must include Authorization: Bearer <token>.
    // Default: no auth (localhost-only is the primary security boundary).
    const envToken = process.env.OPENCLAW_SERVER_TOKEN;
    if (envToken) {
      this.authToken = envToken;
      // Write token to file for CLI to read
      const tokenDir = path.join(os.homedir(), '.openclaw');
      try {
        if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
        fs.writeFileSync(path.join(tokenDir, 'server-token'), this.authToken, { mode: 0o600 });
      } catch {
        /* best effort */
      }
    } else {
      this.authToken = null;
    }

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
        if (err.code === 'EADDRINUSE') {
          // Port already in use — another instance running, skip
          console.log(`[embedded-server] Port ${this.port} in use, skipping (another instance running)`);
          this.server = null;
          resolve(0);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        console.log(
          `[embedded-server] Listening on http://${this.host}:${this.port}${this.authToken ? ' (auth enabled)' : ''}`,
        );
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this._rateLimitCleanupTimer) {
      clearInterval(this._rateLimitCleanupTimer);
      this._rateLimitCleanupTimer = null;
    }
    // Only delete token file if it matches our token
    try {
      const tokenPath = path.join(os.homedir(), '.openclaw', 'server-token');
      const stored = fs.readFileSync(tokenPath, 'utf8');
      if (stored === this.authToken) fs.unlinkSync(tokenPath);
    } catch {
      /* ignore */
    }
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS — localhost by default; /v1/ paths allow all origins (for webchat frontends)
    const origin = req.headers.origin || '';
    const urlPath = new URL(req.url || '/', `http://localhost:${this.port}`).pathname;
    const corsAllowAll = process.env.OPENCLAW_CORS_ORIGINS === '*';
    const isV1Path = urlPath.startsWith('/v1/');
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(origin);
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

    // Bearer token auth (skip for health checks)
    if (this.authToken && path !== '/health') {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${this.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized — provide Authorization: Bearer <token>' }));
        return;
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

      // ─── Autoloop SSE ────────────────────────────────────────────
      //
      // GET /autoloop/<id>/events
      // Streams phase / state / push events for a running autoloop. The
      // frontend (webchat) is not yet built; this endpoint exists so it can
      // be added without changing the runner contract.

      const autoloopMatch = path.match(/^\/autoloop\/([^/]+)\/events$/);
      if (autoloopMatch) {
        const id = autoloopMatch[1];
        const runner = this.manager.getAutoloop(id);
        if (!runner) {
          json(404, { ok: false, error: `autoloop not found: ${id}` });
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
        // Replay current handle so the frontend can render immediately.
        send('snapshot', runner.handle());

        const onPhase = (e: unknown): void => send('phase', e);
        const onState = (e: unknown): void => send('state', e);
        const onPush = (e: unknown): void => send('push', e);
        const onTerm = (e: unknown): void => {
          send('terminated', e);
          cleanup();
        };
        const onError = (e: unknown): void => {
          send('error', { message: e instanceof Error ? e.message : String(e) });
          cleanup();
        };
        const cleanup = (): void => {
          runner.off('phase', onPhase);
          runner.off('state', onState);
          runner.off('push', onPush);
          runner.off('terminated', onTerm);
          runner.off('error', onError);
          try {
            res.end();
          } catch {
            // Ignore.
          }
        };
        runner.on('phase', onPhase);
        runner.on('state', onState);
        runner.on('push', onPush);
        runner.on('terminated', onTerm);
        runner.on('error', onError);
        res.on('close', cleanup);
        return;
      }

      // ─── Autoloop v2 — list / state / push log / SSE events ─────
      //
      // Front-end contract (per tasks/autoloop-v2.md §9). Webchat opens these
      // when rendering a 3-pane Orchestrator view.

      if (path === '/autoloop/v2/list') {
        json(200, { ok: true, runs: this.manager.autoloopV2List() });
        return;
      }

      const v2StateMatch = path.match(/^\/autoloop\/v2\/([^/]+)\/state$/);
      if (v2StateMatch) {
        const state = this.manager.autoloopV2Status(v2StateMatch[1]);
        if (!state) {
          json(404, { ok: false, error: 'run not found' });
        } else {
          json(200, { ok: true, state });
        }
        return;
      }

      const v2PushLogMatch = path.match(/^\/autoloop\/v2\/([^/]+)\/push_log$/);
      if (v2PushLogMatch) {
        const id = v2PushLogMatch[1];
        const ctx = this.manager.getAutoloopV2(id);
        if (!ctx) {
          json(404, { ok: false, error: 'run not found' });
          return;
        }
        // push_log lives at <ledger>/push_log.jsonl — the dispatcher knows
        // the ledger dir. We re-derive it here to avoid leaking dispatcher
        // internals through the manager.
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const ledgerDir = pathMod.join(ctx.dispatcher.config.workspace, 'tasks', id);
        const file = pathMod.join(ledgerDir, 'push_log.jsonl');
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

      const v2EventsMatch = path.match(/^\/autoloop\/v2\/([^/]+)\/events$/);
      if (v2EventsMatch) {
        const id = v2EventsMatch[1];
        const ctx = this.manager.getAutoloopV2(id);
        if (!ctx) {
          json(404, { ok: false, error: 'run not found' });
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
        const onCoderReply = (text: unknown): void => send('coder_reply', { text });
        const onReviewerReply = (text: unknown): void => send('reviewer_reply', { text });
        const cleanup = (): void => {
          ctx.runner.off('message', onMessage);
          ctx.runner.off('state', onState);
          ctx.runner.off('push', onPush);
          ctx.runner.off('iter_done', onIterDone);
          ctx.runner.off('terminated', onTerm);
          ctx.dispatcher.off('planner_reply', onPlannerReply);
          ctx.dispatcher.off('coder_reply', onCoderReply);
          ctx.dispatcher.off('reviewer_reply', onReviewerReply);
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
        ctx.dispatcher.on('coder_reply', onCoderReply);
        ctx.dispatcher.on('reviewer_reply', onReviewerReply);
        res.on('close', cleanup);
        return;
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
