/**
 * Shared Bluesky reachability gate. When Bluesky is unreachable (504 gateway
 * timeout, network error, 5xx, rate limit) the worker should NOT keep hammering
 * it every tick — it should back off exponentially and periodically probe until
 * it recovers. Every Bluesky-touching loop (discover, poster, deal poster,
 * notifications) consults `blueskyBackingOff()` to skip cheaply during an
 * outage, reports outcomes here, and the loops themselves are the periodic
 * probe: the first one to tick after the window expires retries, and either
 * clears the backoff (success) or re-arms it (still down).
 *
 * Crucially, a transient outage is NOT a credential problem — the posters must
 * distinguish the two so a 504 spate never permanently disables posting.
 */

const BASE_BACKOFF_MS = 60_000; // first outage: wait a minute
const MAX_BACKOFF_MS = 15 * 60_000; // then double up to ~15 min between probes

let backoffUntil = 0;
let consecutiveFailures = 0;

/**
 * True for "Bluesky is down / unreachable", NOT for "the request was rejected".
 * A wrong app password (401/invalid credentials) is a real problem the operator
 * must fix — it is deliberately excluded so it still trips the login-disable.
 */
export function isTransientBlueskyError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (status === 429 || status >= 500) return true; // rate limit / gateway / upstream
    return false; // 4xx (incl. 401 auth) is not "unreachable"
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true; // our timeouts
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /timeout|timed out|gateway|econn|socket hang|network|fetch failed|und_err|getaddrinfo|dns|enotfound|502|503|504|unavailable|upstream|temporarily/.test(
    msg,
  );
}

/** True while inside an active backoff window — Bluesky loops skip their tick. */
export function blueskyBackingOff(): boolean {
  return Date.now() < backoffUntil;
}

/** Seconds until the next probe is allowed (0 when not backing off). */
export function blueskyBackoffSeconds(): number {
  return Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000));
}

/**
 * Record a failed Bluesky call. Returns true if it was transient (outage) and a
 * backoff was armed; false if it looks like a real error (e.g. bad credentials)
 * the caller should handle normally.
 */
export function noteBlueskyDown(error: unknown): boolean {
  if (!isTransientBlueskyError(error)) return false;
  consecutiveFailures += 1;
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1));
  backoffUntil = Date.now() + delay;
  if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
    console.warn(
      `[bluesky] unreachable (${consecutiveFailures}x) — backing off ${Math.round(delay / 1000)}s`,
    );
  }
  return true;
}

/** Record a successful Bluesky call — clears any backoff. */
export function noteBlueskyUp(): void {
  if (consecutiveFailures > 0 || backoffUntil > 0) {
    console.log("[bluesky] reachable again — resuming normal cadence");
    consecutiveFailures = 0;
    backoffUntil = 0;
  }
}
