import { blueskyBackingOff, isBlueskySessionError, noteBlueskyDown } from "./bluesky-health.js";

/**
 * One logged-in Bluesky session for the whole worker. Six loops (reply poster,
 * deal poster, banter, takedown, mentions, discovery) used to each log in
 * their own AtpAgent — six createSession calls per boot against a rate-limited
 * endpoint, six copies of the login-failure bookkeeping drifting apart, and
 * none of them able to recover a dead session:
 *
 * The SDK refreshes the short-lived access JWT on its own, but once the
 * REFRESH token expires or is revoked it drops the session (`hasSession`
 * false) and every later call fails unauthenticated. Each loop held its agent
 * forever, so the bot went deaf until the dyno restarted. Here the next
 * acquire notices and logs in again.
 *
 * Kept free of config so the policy is testable with a fake agent; the
 * worker's singleton lives in bluesky-agent.ts.
 */

/** Consecutive credential failures before login is disabled until restart —
 *  a wrong app password must stop hammering createSession, not retry forever. */
export const MAX_LOGIN_FAILURES = 3;
/** Minimum gap after a credential failure before trying again. Six loops share
 *  the counter now; without the gap they could burn all three attempts in one
 *  minute, where each loop alone used to take three of its own ticks. */
export const LOGIN_RETRY_MS = 5 * 60_000;

/** The slice of AtpAgent the session manager needs. */
export type LoginAgent = {
  login(credentials: { identifier: string; password: string }): Promise<unknown>;
  readonly hasSession: boolean;
};

export type BlueskySession<A extends LoginAgent> = {
  /** A logged-in agent, or null to skip this tick: Bluesky backing off,
   *  login failed, or login disabled. Concurrent callers share one login. */
  agent(): Promise<A | null>;
  /** True once repeated credential failures disabled login until restart. */
  disabled(): boolean;
  /** Record a failed call. Returns true (and forgets the agent so the next
   *  acquire logs in afresh) when the session itself is dead — callers should
   *  retry later without blaming the record they were posting. */
  noteSessionLost(error: unknown): boolean;
};

export function createBlueskySession<A extends LoginAgent>(
  credentials: { identifier: string; password: string },
  makeAgent: () => A,
  now: () => number = Date.now,
): BlueskySession<A> {
  let current: A | null = null;
  let pending: Promise<A | null> | null = null;
  let failures = 0;
  let retryAt = 0;
  let isDisabled = false;

  async function login(): Promise<A | null> {
    const candidate = makeAgent();
    try {
      await candidate.login(credentials);
      if (failures > 0) console.log("[bluesky] login recovered");
      failures = 0;
      current = candidate;
      return candidate;
    } catch (error) {
      // A transient outage (504/network) is NOT a credential problem — back
      // off globally and never let it count toward the disable.
      if (noteBlueskyDown(error)) return null;
      failures += 1;
      retryAt = now() + LOGIN_RETRY_MS;
      console.error(
        `[bluesky] login failed (${failures}/${MAX_LOGIN_FAILURES}):`,
        error instanceof Error ? error.message : error,
      );
      if (failures >= MAX_LOGIN_FAILURES) {
        isDisabled = true;
        console.error(
          "[bluesky] login disabled until restart — check BOT_ACCOUNT_HANDLE / BOT_APP_PASSWORD",
        );
      }
      return null;
    }
  }

  return {
    async agent() {
      if (isDisabled || blueskyBackingOff()) return null;
      if (current?.hasSession) return current;
      if (current) {
        console.warn("[bluesky] session expired — logging in again");
        current = null;
      }
      if (pending) return pending;
      if (now() < retryAt) return null;
      pending = login().finally(() => {
        pending = null;
      });
      return pending;
    },
    disabled: () => isDisabled,
    noteSessionLost(error) {
      if (!isBlueskySessionError(error)) return false;
      current = null;
      return true;
    },
  };
}
