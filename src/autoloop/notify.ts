/**
 * notify_user — wechat → whatsapp → email fallback chain.
 *
 * Mirrors the bash `push()` recipe in ~/.claude/skills/push-api-skill/SKILL.md
 * §B.2.5. Purposefully shells out via `openclaw` and the email script rather
 * than reimplementing the API contracts — the skill is the source of truth.
 *
 * Per the recovery-path principle in CLAUDE.md: this code path must stay
 * thin. If openclaw itself is down, the email fallback is independent
 * (Gmail SMTP via the script).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { PushChannel, PushLevel } from './messages.js';
import { type Logger, nullLogger } from '../logger.js';

// Recipient identifiers are personal contact info — never hard-code them.
// Set the following env vars before relying on the matching channel; if a
// var is unset that channel is silently skipped and the fallback chain moves
// on. Email (independent SMTP via push-api-skill script) is the final tier
// regardless of these. Read at call time (not module load) so the operator
// can rotate the env without restarting the whole orchestrator.
function readRecipientEnv(): {
  wechatRecipient: string;
  wechatAccount: string;
  whatsappRecipient: string;
} {
  return {
    wechatRecipient: process.env.AUTOLOOP_WECHAT_RECIPIENT ?? '',
    wechatAccount: process.env.AUTOLOOP_WECHAT_ACCOUNT ?? '',
    whatsappRecipient: process.env.AUTOLOOP_WHATSAPP_RECIPIENT ?? '',
  };
}

interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

async function runCmd(argv: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));

    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ exit_code: 127, stdout: '', stderr: (err as Error).message, timed_out: false });
    });

    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ exit_code: code ?? 0, stdout, stderr, timed_out: timedOut });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
}

function formatMessage(level: PushLevel, summary: string): string {
  const emoji = level === 'info' ? '🔔' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : '🚦';
  return `${emoji} ${summary}`;
}

async function tryWechat(text: string, logger: Logger): Promise<boolean> {
  const { wechatRecipient, wechatAccount } = readRecipientEnv();
  if (!wechatRecipient || !wechatAccount) {
    logger.info?.('[autoloop/notify] wechat skipped: AUTOLOOP_WECHAT_RECIPIENT / AUTOLOOP_WECHAT_ACCOUNT not set');
    return false;
  }
  const r = await runCmd([
    'openclaw',
    'message',
    'send',
    '--channel',
    'openclaw-weixin',
    '--account',
    wechatAccount,
    '-t',
    wechatRecipient,
    '-m',
    text,
  ]);
  if (r.exit_code === 0 && /✅\s*Sent/.test(r.stdout)) return true;
  logger.warn?.(`[autoloop/notify] wechat failed: code=${r.exit_code} stderr=${r.stderr.slice(0, 200)}`);
  return false;
}

async function tryWhatsApp(text: string, logger: Logger): Promise<boolean> {
  const { whatsappRecipient } = readRecipientEnv();
  if (!whatsappRecipient) {
    logger.info?.('[autoloop/notify] whatsapp skipped: AUTOLOOP_WHATSAPP_RECIPIENT not set');
    return false;
  }
  const r = await runCmd(['openclaw', 'message', 'send', '--channel', 'whatsapp', '-t', whatsappRecipient, '-m', text]);
  if (r.exit_code === 0 && /✅\s*Sent/.test(r.stdout)) return true;
  logger.warn?.(`[autoloop/notify] whatsapp failed: code=${r.exit_code} stderr=${r.stderr.slice(0, 200)}`);
  return false;
}

async function tryEmail(subject: string, body: string, logger: Logger): Promise<boolean> {
  // Prefer the user-installed skill script; tolerate either ~/clawd or ~/.claude path.
  const candidates = [
    path.join(os.homedir(), 'clawd', 'skills', 'push-api-skill', 'scripts', 'send-email.sh'),
    path.join(os.homedir(), '.claude', 'skills', 'push-api-skill', 'scripts', 'send-email.sh'),
  ];
  const script = candidates.find((p) => fs.existsSync(p));
  if (!script) {
    logger.warn?.('[autoloop/notify] email fallback unavailable: send-email.sh not found');
    return false;
  }
  const r = await runCmd(['bash', script, '-s', subject], { stdin: body, timeoutMs: 30_000 });
  if (r.exit_code === 0) return true;
  logger.warn?.(`[autoloop/notify] email failed: code=${r.exit_code} stderr=${r.stderr.slice(0, 200)}`);
  return false;
}

/**
 * Send a notification, walking the fallback chain. Returns the channel that
 * succeeded (or 'none' if all failed). Caller should record both attempt and
 * outcome to the run's push log regardless.
 */
export async function notifyUserFallbackChain(opts: {
  level: PushLevel;
  summary: string;
  detail?: string;
  channel: PushChannel;
  logger?: Logger;
}): Promise<{ channel_used: 'wechat' | 'whatsapp' | 'webchat' | 'email' | 'none' }> {
  const logger = opts.logger ?? nullLogger;
  const wechatText = formatMessage(opts.level, opts.summary);
  const emailSubject = `[autoloop] ${opts.summary}`;
  const emailBody = opts.detail ?? opts.summary;

  // Channel-specific shortcuts: caller asked for a specific channel only.
  if (opts.channel === 'wechat') {
    return { channel_used: (await tryWechat(wechatText, logger)) ? 'wechat' : 'none' };
  }
  if (opts.channel === 'webchat') {
    // S2 has no webchat session id wired up at the run level; treat as no-op.
    return { channel_used: 'none' };
  }
  if (opts.channel === 'email') {
    return { channel_used: (await tryEmail(emailSubject, emailBody, logger)) ? 'email' : 'none' };
  }

  // 'auto' or 'both' → walk the chain.
  if (await tryWechat(wechatText, logger)) return { channel_used: 'wechat' };
  if (await tryWhatsApp(`[微信失败已 fallback] ${wechatText}`, logger)) return { channel_used: 'whatsapp' };
  if (await tryEmail(emailSubject, emailBody, logger)) return { channel_used: 'email' };
  return { channel_used: 'none' };
}

/** Append a single push-log entry as JSONL. Best-effort; swallows fs errors. */
export function appendPushLog(
  ledgerDir: string,
  entry: {
    ts: string;
    level: PushLevel;
    summary: string;
    detail?: string;
    channel_requested: PushChannel;
    channel_used: string;
  },
): void {
  try {
    const file = path.join(ledgerDir, 'push_log.jsonl');
    if (!fs.existsSync(ledgerDir)) fs.mkdirSync(ledgerDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    /* swallow — logging failure shouldn't crash the run */
  }
}
