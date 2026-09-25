import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Ms, UsageBar } from '../../shared/model';
import type { FsPort } from '../ports/fs';

/**
 * The real limits, straight from the account that Claude Code itself uses.
 *
 * The token is read **once per run**, kept in memory, and never written, logged
 * or refreshed: refreshing would rotate the credentials Claude Code is holding
 * and could sign the user out of their own terminal. An expired token is
 * something to report to the user, never something to renew behind their back.
 *
 * Every failure here comes back as a named reason rather than a thrown error,
 * because each one is a different thing to tell the user and only the caller
 * knows whether there are older numbers still worth showing.
 */

const run = promisify(execFile);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 8000;

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Opt-in header the oauth endpoints still require. */
export const OAUTH_BETA = 'oauth-2025-04-20';

export interface OAuthToken {
  accessToken: string;
  expiresAt?: Ms;
}

/** Why there is no token to poll with. Each one is a different panel state. */
export type TokenProblem = 'signedOut' | 'noAccess';

export type TokenRead = { ok: true; token: OAuthToken } | { ok: false; problem: TokenProblem };

/**
 * The `security` call, behind a port so a test run never shells out — and so it
 * can never raise a Keychain prompt on whatever machine is running the suite.
 */
export type SecurityExec = (args: readonly string[]) => Promise<string>;

export const nodeSecurity: SecurityExec = async (args) => {
  const { stdout } = await run('security', [...args], {
    timeout: KEYCHAIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/**
 * Keychain first, `~/.claude/.credentials.json` second — the two places Claude
 * Code itself keeps them. Being signed out is ordinary; being refused access is
 * not, and the two are told apart because only one of them is worth a word of
 * advice in the panel.
 */
export async function readOAuthToken(
  fs: FsPort,
  claudeDir: string,
  security: SecurityExec = nodeSecurity,
): Promise<TokenRead> {
  const keychain = await readFromKeychain(security);
  if (keychain.ok) return keychain;

  const text = await fs.readText(join(claudeDir, '.credentials.json'));
  const fromFile = text ? parseCredentials(text) : null;
  if (fromFile) return { ok: true, token: fromFile };

  return keychain;
}

async function readFromKeychain(security: SecurityExec): Promise<TokenRead> {
  try {
    const token = parseCredentials(await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']));
    return token ? { ok: true, token } : { ok: false, problem: 'signedOut' };
  } catch (err) {
    // `security` says "could not be found" when the item is simply absent, and
    // fails differently when the user denied the prompt or the keychain is
    // locked. Only the second case is something the user can act on.
    const message = err instanceof Error ? err.message : '';
    const missing = /could not be found/i.test(message);
    return { ok: false, problem: missing ? 'signedOut' : 'noAccess' };
  }
}

/** Tolerant: an unfamiliar credentials shape means no token, never a throw. */
export function parseCredentials(text: string): OAuthToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = obj(obj(parsed)?.['claudeAiOauth']);
  const accessToken = str(oauth?.['accessToken']);
  if (!accessToken) return null;

  const expiresAt = num(oauth?.['expiresAt']);
  return { accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Why the account could not be asked, or could not be understood. */
export type FetchProblem = 'expired' | 'offline' | 'timedOut' | 'unreadable' | 'serverError';

export type UsageFetch = { ok: true; body: unknown } | { ok: false; problem: FetchProblem; detail?: string };

export async function fetchOAuthUsage(token: OAuthToken, fetchImpl: typeof fetch = fetch): Promise<UsageFetch> {
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Nothing here is logged: the request carries the token in a header, and an
    // error object is the easiest way for one to end up in a log file.
    return { ok: false, problem: aborted(err) ? 'timedOut' : 'offline' };
  }

  // 401 and 403 both mean the credentials Claude Code left behind no longer
  // work, which the user fixes by running Claude Code, not by retrying.
  if (response.status === 401 || response.status === 403) return { ok: false, problem: 'expired' };
  if (!response.ok) return { ok: false, problem: 'serverError', detail: `HTTP ${response.status}` };

  try {
    return { ok: true, body: await response.json() };
  } catch (err) {
    // A 200 that is not JSON is usually a captive portal or a proxy sitting in
    // front of the API, which is worth saying rather than calling it an outage.
    return { ok: false, problem: aborted(err) ? 'timedOut' : 'unreadable' };
  }
}

function aborted(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Two shapes have to be understood: the current `limits[]` array, and the older
 * `five_hour` / `seven_day` objects. Anything else yields no bars, which the
 * caller reports as a response it could not read.
 */
export function parseUsageLimits(body: unknown, now: Ms): UsageBar[] {
  const root = obj(body);
  if (!root) return [];
  const modern = parseLimitsArray(root['limits'], now);
  return modern.length > 0 ? modern : parseLegacyLimits(root, now);
}

function parseLimitsArray(value: unknown, now: Ms): UsageBar[] {
  if (!Array.isArray(value)) return [];
  const bars: UsageBar[] = [];

  for (const raw of value) {
    const limit = obj(raw);
    if (!limit) continue;
    const pct = num(limit['percent']);
    if (pct === undefined) continue;

    const kind = str(limit['kind']) ?? str(limit['group']) ?? 'limit';
    const model = str(obj(obj(limit['scope'])?.['model'])?.['display_name']);
    bars.push(
      bar({
        id: model ? `${kind}:${model.toLowerCase()}` : kind,
        label: labelFor(kind, model),
        pct,
        resetsAt: parseTime(limit['resets_at'], now),
        severity: str(limit['severity']),
        binding: limit['is_active'] === true,
      }),
    );
  }

  return sortBars(bars);
}

/** `{ five_hour: { utilization }, seven_day: …, seven_day_opus: … }`. */
function parseLegacyLimits(root: Record<string, unknown>, now: Ms): UsageBar[] {
  const bars: UsageBar[] = [];

  for (const [key, value] of Object.entries(root)) {
    const entry = obj(value);
    const pct = num(entry?.['utilization']);
    if (pct === undefined) continue;

    const scoped = /^seven_day_(.+)$/.exec(key)?.[1];
    const kind = key === 'five_hour' ? 'session' : key === 'seven_day' ? 'weekly_all' : 'weekly_scoped';
    bars.push(
      bar({
        id: key,
        label: labelFor(kind, scoped ? titleize(scoped) : undefined),
        pct,
        resetsAt: parseTime(entry?.['resets_at'], now),
        severity: str(entry?.['locked_reason']) ? 'locked' : undefined,
      }),
    );
  }

  return sortBars(bars);
}

interface BarInput {
  id: string;
  label: string;
  pct: number;
  resetsAt?: Ms;
  severity?: string;
  binding?: boolean;
}

function bar(input: BarInput): UsageBar {
  return {
    id: input.id,
    label: input.label,
    pct: clamp(input.pct),
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.binding !== undefined ? { binding: input.binding } : {}),
  };
}

function labelFor(kind: string, model: string | undefined): string {
  const base =
    kind === 'session' || kind === 'five_hour'
      ? 'Session (5h)'
      : kind === 'weekly_all' || kind === 'weekly'
        ? 'Weekly (7d)'
        : kind === 'weekly_scoped'
          ? 'Weekly'
          : titleize(kind);
  return model ? `${base === 'Weekly (7d)' ? 'Weekly' : base} · ${model}` : base;
}

/** Session first, then the account-wide week, then the per-model rows. */
function sortBars(bars: UsageBar[]): UsageBar[] {
  const rank = (b: UsageBar): number => (b.label.startsWith('Session') ? 0 : b.label === 'Weekly (7d)' ? 1 : 2);
  return bars.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/**
 * Which account this machine is signed in as, from `~/.claude.json`. Read-only
 * and best effort: it names the account the numbers belong to, which matters on
 * a machine that has been signed in as more than one.
 */
export async function readAccountEmail(fs: FsPort, homeDir: string): Promise<string | undefined> {
  const text = await fs.readText(join(homeDir, '.claude.json'));
  if (!text) return undefined;
  try {
    return str(obj(obj(JSON.parse(text))?.['oauthAccount'])?.['emailAddress']);
  } catch {
    return undefined;
  }
}

function parseTime(value: unknown, now: Ms): Ms | undefined {
  const text = str(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  // A reset in the past is a stale row, not a countdown worth drawing.
  return Number.isNaN(parsed) || parsed <= now ? undefined : parsed;
}

function titleize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
