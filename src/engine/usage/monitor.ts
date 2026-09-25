import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Ms, UsageBar, UsageSnapshot, UsageState } from '../../shared/model';
import { systemClock, type Clock } from '../ports/clock';
import { NodeFsPort, type FsPort } from '../ports/fs';
import type { WorldStore } from '../state/worldStore';
import {
  fetchOAuthUsage,
  parseUsageLimits,
  readAccountEmail,
  readOAuthToken,
  type OAuthToken,
  type SecurityExec,
} from './oauth';

/**
 * Keeps `world.usage` current from the one place the numbers are real: the
 * account Claude Code is signed in to.
 *
 * There is no second source. When the account cannot be reached the panel is
 * told what went wrong and, where it can recover, when to expect the next try —
 * a plausible-looking local guess would be worse than nothing, because the user
 * cannot tell a guess from a fact once it is drawn as a bar.
 *
 * The limits move slowly and the window is usually in the background, so the
 * API is asked at most every fifteen minutes and only while somebody is looking
 * at it. A failure that might clear on its own is retried sooner; a failure that
 * cannot clear without the user's help is not retried at all.
 */

const POLL_MS = 15 * 60 * 1000;
/** Matches "trying again in a couple of minutes" in the panel. */
const RETRY_MS = 2 * 60 * 1000;
const TICK_MS = 60 * 1000;

/**
 * Failures that stay broken until the user does something. Nothing this run can
 * fix them — the credentials are read once and never refreshed — so retrying
 * would only be a way of asking the same question forever.
 */
const PERMANENT: ReadonlySet<UsageState> = new Set<UsageState>(['signedOut', 'noAccess', 'expired']);

export interface UsageMonitorOptions {
  fs?: FsPort;
  clock?: Clock;
  home?: string;
  claudeDir?: string;
  isFocused?: () => boolean;
  /** Injected by tests so a run never shells out to the Keychain. */
  security?: SecurityExec;
  /** Injected by tests so a run never leaves the machine. */
  fetchImpl?: typeof fetch;
  /**
   * Consult nothing: no Keychain, no network, no snapshot. Set under test, so
   * a screenshot run can never stall on a Keychain prompt or flake on a call,
   * and so a shot never contains numbers from the machine that took it.
   */
  offline?: boolean;
}

export class UsageMonitor {
  private readonly fs: FsPort;
  private readonly clock: Clock;
  private readonly home: string;
  private readonly claudeDir: string;
  private readonly isFocused: () => boolean;
  private readonly security: SecurityExec | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  private locked: boolean;
  private token: OAuthToken | null = null;
  private tokenProblem: UsageState | null = null;
  private tokenRead = false;
  private account: string | undefined;
  private accountRead = false;
  /** The last numbers the account gave, kept across failures. */
  private bars: UsageBar[] = [];
  private barsAt: Ms = 0;
  private published: UsageSnapshot | null = null;
  private nextPollAt: Ms = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly store: WorldStore,
    options: UsageMonitorOptions = {},
  ) {
    this.fs = options.fs ?? new NodeFsPort();
    this.clock = options.clock ?? systemClock;
    this.home = options.home ?? homedir();
    this.claudeDir = options.claudeDir ?? join(this.home, '.claude');
    this.isFocused = options.isFocused ?? (() => true);
    this.security = options.security;
    this.fetchImpl = options.fetchImpl;
    this.locked = options.offline ?? false;
  }

  start(): void {
    this.timer = setInterval(() => void this.check(false), TICK_MS);
    void this.check(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. `start` runs it on a timer, and it is safe to call directly:
   * `force` means "ask now" rather than "ask if the window is in front and the
   * poll is due".
   */
  async check(force: boolean): Promise<void> {
    // Under the test lock the panel simply has nothing to show, which is honest:
    // no account was consulted, so there are no numbers to draw.
    if (this.locked || this.busy) return;
    this.busy = true;
    try {
      await this.run(force);
    } catch {
      // A usage panel is never worth taking the engine down for.
    } finally {
      this.busy = false;
    }
  }

  private async run(force: boolean): Promise<void> {
    const now = this.clock.now();
    await this.ensureAccount();
    await this.ensureToken();

    const token = this.token;
    if (!token) return this.publish(this.tokenProblem ?? 'signedOut');
    // The token is held for the life of the run, so it can go stale in memory
    // while the app is open; the API would only answer 401 anyway.
    if (token.expiresAt !== undefined && token.expiresAt <= now) return this.publish('expired');

    if (!force) {
      if (now < this.nextPollAt) return;
      // Asking on behalf of a window nobody is looking at is how a background
      // app burns a rate limit of its own.
      if (!this.isFocused()) return;
    }

    const result = await fetchOAuthUsage(token, this.fetchImpl);
    if (!result.ok) {
      this.nextPollAt = now + RETRY_MS;
      return this.publish(result.problem, result.detail);
    }

    const bars = parseUsageLimits(result.body, now);
    if (bars.length === 0) {
      // A 200 the parser cannot make bars out of is a shape change at the other
      // end, not an account problem, so it is retried like any other hiccup.
      this.nextPollAt = now + RETRY_MS;
      return this.publish('unreadable');
    }

    this.bars = bars;
    this.barsAt = now;
    this.nextPollAt = now + POLL_MS;
    this.publish('live');
  }

  /**
   * Read once per run, then kept in memory. Never refreshed: the refresh token
   * belongs to Claude Code, and spending it here could sign the user out.
   */
  private async ensureToken(): Promise<void> {
    if (this.tokenRead) return;
    this.tokenRead = true;

    const read = await readOAuthToken(this.fs, this.claudeDir, this.security);
    if (read.ok) this.token = read.token;
    else this.tokenProblem = read.problem;
  }

  /** The signed-in address, so the bars say whose account they describe. */
  private async ensureAccount(): Promise<void> {
    if (this.accountRead) return;
    this.accountRead = true;
    this.account = await readAccountEmail(this.fs, this.home);
  }

  /**
   * Publishes only when something changed. A failed poll every minute would
   * otherwise send a patch a minute saying the same thing, and the panel would
   * flicker its age line for no new information.
   */
  private publish(state: UsageState, detail?: string): void {
    // Retirement is decided here rather than at each call site because a
    // permanent failure arrives from either end: no credentials to start with,
    // or a 401 hours into a run that had been answering perfectly well.
    if (PERMANENT.has(state)) this.nextPollAt = Number.POSITIVE_INFINITY;

    const snapshot: UsageSnapshot = {
      state,
      bars: this.bars,
      updatedAt: this.barsAt,
      ...(this.account ? { account: this.account } : {}),
      ...(detail ? { detail } : {}),
    };
    const previous = this.published;
    if (
      previous &&
      previous.state === snapshot.state &&
      previous.updatedAt === snapshot.updatedAt &&
      previous.detail === snapshot.detail &&
      previous.bars === snapshot.bars
    ) {
      return;
    }

    this.published = snapshot;
    this.store.setUsage(snapshot);
  }
}
