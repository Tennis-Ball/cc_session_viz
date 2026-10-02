import { describe, expect, it } from 'vitest';
import { FakeClock } from '@engine/ports/clock';
import type { FileStat, FsPort } from '@engine/ports/fs';
import {
  fetchOAuthUsage,
  parseCredentials,
  parseUsageLimits,
  readOAuthToken,
  type SecurityExec,
} from '@engine/usage/oauth';
import { UsageMonitor } from '@engine/usage/monitor';
import { WorldStore } from '@engine/state/worldStore';
import { fmtAgo, fmtResetIn } from '@shared/format';
import { mergePrefs } from '@shared/prefs';

/**
 * The account is the only source of these numbers, so the failures are the
 * feature: every way the account can be out of reach has to reach the panel as
 * its own state, with the last good reading kept where there is one.
 *
 * Nothing here shells out or dials out — the Keychain and fetch boundaries are
 * injected, so the suite can never raise a Keychain prompt or touch the API.
 */

const NOW = Date.parse('2026-09-20T16:49:00Z');
const HOME = '/home/tester';
const CLAUDE_DIR = `${HOME}/.claude`;
const SECRET = 'sk-ant-oat-do-not-leak';

/** The shape the endpoint actually returns, trimmed to the parts that matter. */
const MODERN = {
  five_hour: { utilization: 3.0, resets_at: '2026-09-20T20:50:00.047163+00:00' },
  seven_day: { utilization: 1.0, resets_at: '2026-09-27T07:00:00.047185+00:00' },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 3,
      severity: 'normal',
      resets_at: '2026-09-20T20:50:00.047163+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 1,
      severity: 'normal',
      resets_at: '2026-09-27T07:00:00.047185+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-09-27T07:00:00+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
};

/** Only whole-file reads matter here: the monitor never opens a transcript. */
class MemoryFs implements FsPort {
  constructor(private readonly files: Map<string, string>) {}
  async stat(): Promise<FileStat | null> {
    return null;
  }
  async readdir(): Promise<string[]> {
    return [];
  }
  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async readRange(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  watch(): () => void {
    return () => undefined;
  }
}

function credentials(expiresAt?: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: SECRET, ...(expiresAt ? { expiresAt } : {}) } });
}

function fs(files: Record<string, string> = {}): FsPort {
  return new MemoryFs(new Map(Object.entries({ [`${HOME}/.claude.json`]: accountFile(), ...files })));
}

function accountFile(): string {
  return JSON.stringify({ oauthAccount: { emailAddress: 'tester@example.com' } });
}

/** A Keychain that hands back credentials, like a signed-in machine. */
function keychain(text: string): SecurityExec {
  return async () => text;
}

/** How `security` fails when the item is simply not there. */
const KEYCHAIN_EMPTY: SecurityExec = async () => {
  throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
};

/** How it fails when the user dismisses the prompt, or the keychain is locked. */
const KEYCHAIN_DENIED: SecurityExec = async () => {
  throw new Error('security: SecKeychainSearchCopyNext: User interaction is not allowed.');
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function named(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

interface Poller {
  fetchImpl: typeof fetch;
  calls: number;
}

/** Replies in order, repeating the last reply once the script runs out. */
function poller(...replies: (Response | Error | (() => Response))[]): Poller {
  const state = { calls: 0 };
  const fetchImpl: typeof fetch = async () => {
    const reply = replies[Math.min(state.calls, replies.length - 1)];
    state.calls += 1;
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply();
    return reply ?? jsonResponse(MODERN);
  };
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

function monitor(options: {
  store: WorldStore;
  clock: FakeClock;
  security?: SecurityExec;
  fetchImpl?: typeof fetch;
  files?: Record<string, string>;
  isFocused?: () => boolean;
}): UsageMonitor {
  return new UsageMonitor(options.store, {
    fs: fs(options.files),
    clock: options.clock,
    home: HOME,
    claudeDir: CLAUDE_DIR,
    security: options.security ?? KEYCHAIN_EMPTY,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.isFocused ? { isFocused: options.isFocused } : {}),
  });
}

describe('parseUsageLimits', () => {
  it('reads the limits array, newest shape first', () => {
    const bars = parseUsageLimits(MODERN, NOW);
    expect(bars.map((bar) => bar.label)).toEqual(['Session (5h)', 'Weekly (7d)', 'Weekly · Fable']);
    expect(bars[0]).toMatchObject({ pct: 3, binding: true, severity: 'normal' });
    expect(bars[0]?.resetsAt).toBe(Date.parse('2026-09-20T20:50:00.047163+00:00'));
  });

  it('falls back to the legacy five_hour / seven_day objects', () => {
    const bars = parseUsageLimits(
      {
        five_hour: { utilization: 57, resets_at: '2026-09-20T19:03:00+00:00' },
        seven_day: { utilization: 12 },
        seven_day_opus: { utilization: 31, locked_reason: 'weekly_limit' },
        seven_day_sonnet: null,
        extra_usage: { is_enabled: false },
      },
      NOW,
    );
    expect(bars.map((bar) => bar.label)).toEqual(['Session (5h)', 'Weekly (7d)', 'Weekly · Opus']);
    expect(bars[0]?.pct).toBe(57);
    expect(bars[2]).toMatchObject({ pct: 31, severity: 'locked' });
  });

  it('degrades to no bars on a shape it has never seen', () => {
    expect(parseUsageLimits({ hello: 'world', limits: 'soon' }, NOW)).toEqual([]);
    expect(parseUsageLimits([1, 2, 3], NOW)).toEqual([]);
    expect(parseUsageLimits(null, NOW)).toEqual([]);
    expect(parseUsageLimits('<html>502</html>', NOW)).toEqual([]);
  });

  it('drops a reset time that has already passed and clamps stray percentages', () => {
    const bars = parseUsageLimits(
      { limits: [{ kind: 'session', percent: 140, resets_at: '2020-01-01T00:00:00Z' }] },
      NOW,
    );
    expect(bars[0]?.pct).toBe(100);
    expect(bars[0]?.resetsAt).toBeUndefined();
  });
});

describe('parseCredentials', () => {
  it('keeps the expiry, which is the only thing about the token worth holding', () => {
    const token = parseCredentials(credentials(42));
    expect(token?.accessToken).toBe(SECRET);
    expect(token?.expiresAt).toBe(42);
  });

  it('returns nothing for junk rather than throwing', () => {
    expect(parseCredentials('not json')).toBeNull();
    expect(parseCredentials('{"claudeAiOauth":{}}')).toBeNull();
  });
});

describe('readOAuthToken', () => {
  it('prefers the Keychain', async () => {
    const read = await readOAuthToken(fs(), CLAUDE_DIR, keychain(credentials()));
    expect(read).toEqual({ ok: true, token: { accessToken: SECRET } });
  });

  it('falls back to the credentials file when the Keychain has nothing', async () => {
    const read = await readOAuthToken(
      fs({ [`${CLAUDE_DIR}/.credentials.json`]: credentials(99) }),
      CLAUDE_DIR,
      KEYCHAIN_EMPTY,
    );
    expect(read).toMatchObject({ ok: true, token: { expiresAt: 99 } });
  });

  it('tells a machine that was never signed in apart from one that said no', async () => {
    expect(await readOAuthToken(fs(), CLAUDE_DIR, KEYCHAIN_EMPTY)).toEqual({ ok: false, problem: 'signedOut' });
    expect(await readOAuthToken(fs(), CLAUDE_DIR, KEYCHAIN_DENIED)).toEqual({ ok: false, problem: 'noAccess' });
  });

  it('still reads the file when the Keychain refuses, since that is a real setup', async () => {
    const read = await readOAuthToken(
      fs({ [`${CLAUDE_DIR}/.credentials.json`]: credentials() }),
      CLAUDE_DIR,
      KEYCHAIN_DENIED,
    );
    expect(read.ok).toBe(true);
  });

  it('reports the denial when the file is junk too', async () => {
    const files = { [`${CLAUDE_DIR}/.credentials.json`]: 'half-written' };
    const read = await readOAuthToken(fs(files), CLAUDE_DIR, KEYCHAIN_DENIED);
    expect(read).toEqual({ ok: false, problem: 'noAccess' });
  });
});

describe('fetchOAuthUsage', () => {
  const token = { accessToken: SECRET };

  it('sends the bearer token and the oauth beta header, and nothing else', async () => {
    let seen: Headers | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return jsonResponse(MODERN);
    };
    const result = await fetchOAuthUsage(token, fetchImpl);
    expect(result).toMatchObject({ ok: true });
    expect(seen?.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(seen?.get('anthropic-beta')).toBe('oauth-2025-04-20');
  });

  it('reads a 401 or a 403 as credentials that need Claude Code, not a retry', async () => {
    for (const status of [401, 403]) {
      const result = await fetchOAuthUsage(token, async () => jsonResponse({ error: 'nope' }, status));
      expect(result).toEqual({ ok: false, problem: 'expired' });
    }
  });

  it('names the status when the service turns the check away', async () => {
    const result = await fetchOAuthUsage(token, async () => jsonResponse({}, 503));
    expect(result).toEqual({ ok: false, problem: 'serverError', detail: 'HTTP 503' });
  });

  it('separates a dead network from a slow one', async () => {
    const offline = await fetchOAuthUsage(token, async () => {
      throw new TypeError('fetch failed');
    });
    expect(offline).toEqual({ ok: false, problem: 'offline' });

    const slow = await fetchOAuthUsage(token, async () => {
      throw named('TimeoutError');
    });
    expect(slow).toEqual({ ok: false, problem: 'timedOut' });
  });

  it('calls a 200 that is not JSON unreadable, not an outage', async () => {
    const result = await fetchOAuthUsage(token, async () => new Response('<html>hello from the hotel wifi</html>'));
    expect(result).toEqual({ ok: false, problem: 'unreadable' });
  });
});

describe('UsageMonitor failure states', () => {
  it('says signed out, and never dials out, when there are no credentials', async () => {
    const store = new WorldStore();
    const api = poller(jsonResponse(MODERN));
    await monitor({ store, clock: new FakeClock(NOW), fetchImpl: api.fetchImpl }).check(true);

    expect(store.snapshot().usage).toMatchObject({ state: 'signedOut', bars: [], updatedAt: 0 });
    expect(api.calls).toBe(0);
  });

  it('says so when the Keychain prompt is declined', async () => {
    const store = new WorldStore();
    await monitor({ store, clock: new FakeClock(NOW), security: KEYCHAIN_DENIED }).check(true);
    expect(store.snapshot().usage?.state).toBe('noAccess');
  });

  it('reports a token that expired before the app opened without asking the API', async () => {
    const store = new WorldStore();
    const api = poller(jsonResponse(MODERN));
    await monitor({
      store,
      clock: new FakeClock(NOW),
      security: keychain(credentials(NOW - 60_000)),
      fetchImpl: api.fetchImpl,
    }).check(true);

    expect(store.snapshot().usage?.state).toBe('expired');
    expect(api.calls).toBe(0);
  });

  it('reports a 401 as expired credentials', async () => {
    const store = new WorldStore();
    await monitor({
      store,
      clock: new FakeClock(NOW),
      security: keychain(credentials()),
      fetchImpl: poller(jsonResponse({ error: 'expired' }, 401)).fetchImpl,
    }).check(true);

    expect(store.snapshot().usage?.state).toBe('expired');
  });

  it('reports a dead network, a slow one, and a service that says no', async () => {
    const cases: [Response | Error, string, string | undefined][] = [
      [new TypeError('fetch failed'), 'offline', undefined],
      [named('TimeoutError'), 'timedOut', undefined],
      [jsonResponse({}, 500), 'serverError', 'HTTP 500'],
    ];

    for (const [reply, state, detail] of cases) {
      const store = new WorldStore();
      await monitor({
        store,
        clock: new FakeClock(NOW),
        security: keychain(credentials()),
        fetchImpl: poller(reply).fetchImpl,
      }).check(true);

      expect(store.snapshot().usage).toMatchObject({ state, bars: [] });
      expect(store.snapshot().usage?.detail).toBe(detail);
    }
  });

  it('reports a reply it cannot read, whether it is prose or an unknown shape', async () => {
    for (const reply of [new Response('<html>502</html>'), jsonResponse({ limits: 'soon' })]) {
      const store = new WorldStore();
      await monitor({
        store,
        clock: new FakeClock(NOW),
        security: keychain(credentials()),
        fetchImpl: poller(reply).fetchImpl,
      }).check(true);

      expect(store.snapshot().usage?.state).toBe('unreadable');
    }
  });

  it('never lets the token reach the world the renderer sees', async () => {
    const store = new WorldStore();
    await monitor({
      store,
      clock: new FakeClock(NOW),
      security: keychain(credentials()),
      fetchImpl: poller(jsonResponse(MODERN)).fetchImpl,
    }).check(true);

    expect(JSON.stringify(store.snapshot())).not.toContain(SECRET);
  });
});

describe('UsageMonitor polling', () => {
  it('publishes the account bars, with the account they belong to', async () => {
    const store = new WorldStore();
    await monitor({
      store,
      clock: new FakeClock(NOW),
      security: keychain(credentials()),
      fetchImpl: poller(jsonResponse(MODERN)).fetchImpl,
    }).check(true);

    const usage = store.snapshot().usage;
    expect(usage).toMatchObject({ state: 'live', updatedAt: NOW, account: 'tester@example.com' });
    expect(usage?.bars.map((bar) => bar.label)).toEqual(['Session (5h)', 'Weekly (7d)', 'Weekly · Fable']);
  });

  it('keeps the last good numbers, and their age, through a failed refresh', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    const api = poller(jsonResponse(MODERN), new TypeError('fetch failed'));
    const usage = monitor({ store, clock, security: keychain(credentials()), fetchImpl: api.fetchImpl });

    await usage.check(true);
    clock.advance(23 * 60_000);
    await usage.check(false);

    const snapshot = store.snapshot().usage;
    // The panel draws "Updated 23m ago" off this: the bars are the ones the
    // account gave, and the stamp is honest about how old they are.
    expect(snapshot).toMatchObject({ state: 'offline', updatedAt: NOW });
    expect(snapshot?.bars).toHaveLength(3);
    expect(api.calls).toBe(2);
  });

  it('keeps the numbers when the token expires under it, and says what to do', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    const api = poller(jsonResponse(MODERN), () => jsonResponse(MODERN));
    const usage = monitor({
      store,
      clock,
      security: keychain(credentials(NOW + 10 * 60_000)),
      fetchImpl: api.fetchImpl,
    });

    await usage.check(true);
    clock.advance(20 * 60_000);
    await usage.check(false);

    // Still the last real reading, but now under a heading that sends the user
    // to Claude Code: nothing this run does can make the token work again.
    expect(store.snapshot().usage).toMatchObject({ state: 'expired', updatedAt: NOW });
    expect(store.snapshot().usage?.bars).toHaveLength(3);
    expect(api.calls).toBe(1);
  });

  it('comes back to live numbers once the network does', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    const api = poller(new TypeError('fetch failed'), () => jsonResponse(MODERN));
    const usage = monitor({ store, clock, security: keychain(credentials()), fetchImpl: api.fetchImpl });

    await usage.check(true);
    expect(store.snapshot().usage?.state).toBe('offline');

    // Two minutes is the retry gap: a minute in, nothing has been asked yet.
    clock.advance(60_000);
    await usage.check(false);
    expect(api.calls).toBe(1);

    clock.advance(70_000);
    await usage.check(false);
    expect(store.snapshot().usage).toMatchObject({ state: 'live', updatedAt: NOW + 130_000 });
  });

  it('waits a quarter of an hour between successful polls', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    const api = poller(jsonResponse(MODERN), () => jsonResponse(MODERN));
    const usage = monitor({ store, clock, security: keychain(credentials()), fetchImpl: api.fetchImpl });

    await usage.check(true);
    clock.advance(14 * 60_000);
    await usage.check(false);
    expect(api.calls).toBe(1);

    clock.advance(2 * 60_000);
    await usage.check(false);
    expect(api.calls).toBe(2);
  });

  it('does not poll on behalf of a window nobody is looking at', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    const api = poller(jsonResponse(MODERN), () => jsonResponse(MODERN));
    let focused = false;
    const usage = monitor({
      store,
      clock,
      security: keychain(credentials()),
      fetchImpl: api.fetchImpl,
      isFocused: () => focused,
    });

    await usage.check(true);
    clock.advance(30 * 60_000);
    await usage.check(false);
    expect(api.calls).toBe(1);

    focused = true;
    await usage.check(false);
    expect(api.calls).toBe(2);
  });

  it('stops asking once the answer can only change outside the app', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    const api = poller(jsonResponse({ error: 'expired' }, 401));
    const usage = monitor({ store, clock, security: keychain(credentials()), fetchImpl: api.fetchImpl });

    await usage.check(true);
    clock.advance(6 * 60 * 60_000);
    await usage.check(false);
    await usage.check(false);
    expect(api.calls).toBe(1);
    expect(store.snapshot().usage?.state).toBe('expired');
  });

  it('reads the credentials exactly once per run', async () => {
    const store = new WorldStore();
    const clock = new FakeClock(NOW);
    let reads = 0;
    const usage = monitor({
      store,
      clock,
      security: async () => {
        reads += 1;
        return credentials();
      },
      fetchImpl: poller(jsonResponse(MODERN), () => jsonResponse(MODERN)).fetchImpl,
    });

    await usage.check(true);
    clock.advance(20 * 60_000);
    await usage.check(false);
    expect(reads).toBe(1);
  });

  it('is silent under the test lock, so a screenshot run never meets a Keychain prompt', async () => {
    const store = new WorldStore();
    let touched = false;
    const locked = new UsageMonitor(store, {
      fs: fs(),
      clock: new FakeClock(NOW),
      home: HOME,
      claudeDir: CLAUDE_DIR,
      offline: true,
      security: async () => {
        touched = true;
        return credentials();
      },
    });

    await locked.check(true);
    expect(touched).toBe(false);
    expect(store.snapshot().usage).toBeNull();
  });
});

describe('prefs migration', () => {
  it('drops the retired usage source without disturbing its neighbours', () => {
    const merged = mergePrefs({ version: 1, usage: { source: 'estimate' }, hideSdkSessions: false });
    expect(merged).not.toHaveProperty('usage');
    expect(merged.hideSdkSessions).toBe(false);
    expect(merged.sound).toEqual({ enabled: false, master: 0.5 });
  });
});

describe('countdown formatting', () => {
  it('formats the reset line the way the panel shows it', () => {
    expect(fmtResetIn(2 * 3600_000 + 14 * 60_000)).toBe('Resets in 2h 14m');
    expect(fmtResetIn(46 * 60_000)).toBe('Resets in 46m');
    expect(fmtResetIn(3 * 3600_000)).toBe('Resets in 3h');
    expect(fmtResetIn(50 * 3600_000)).toBe('Resets in 2d 2h');
    expect(fmtResetIn(20_000)).toBe('Resets in <1m');
    expect(fmtResetIn(0)).toBe('Resets now');
    expect(fmtResetIn(-5000)).toBe('Resets now');
  });

  it('keeps the freshness stamp coarse', () => {
    expect(fmtAgo(3000)).toBe('just now');
    expect(fmtAgo(3 * 60_000)).toBe('3m ago');
    expect(fmtAgo(23 * 60_000)).toBe('23m ago');
    expect(fmtAgo(90 * 60_000)).toBe('1h ago');
    expect(fmtAgo(50 * 3600_000)).toBe('2d ago');
  });
});
