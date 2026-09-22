import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Anthropic billing gate — the LLM analog of bluesky-health.ts.
 *
 * Credit exhaustion is unlike every other API failure the worker sees. It is
 * not transient (it will not clear on its own), it is not the candidate's
 * fault, and until someone notices the bot has gone quiet it is invisible.
 *
 * Left to the ordinary non-transient path it is actively DESTRUCTIVE: the
 * evaluate loop blames the post, and after MAX_FAILURES_PER_POST attempts
 * writes a permanent failed evaluation — which the candidate query
 * (`evaluations: { none: {} }`) will never reconsider. An hour of exhausted
 * credit would therefore consume every candidate discovered in that hour
 * rather than deferring them, one batch per minute, unrecoverably.
 *
 * So: detect it precisely, pause the spending loops, and say so loudly. The
 * loops themselves are the probe — the first to tick after the window expires
 * either clears the block (success) or re-arms it (still out of credit). A
 * blocked request is rejected before inference, so probing costs nothing.
 */

/**
 * Recovery lag after a top-up. Deliberately longer than the 10-minute
 * transient backoff — refilling credit is a human action, not something that
 * resolves in seconds — but short enough that the bot restarts promptly once
 * it does, without the operator having to bounce the dyno.
 */
const BILLING_BACKOFF_MS = 15 * 60_000;

let blockedUntil = 0;

/**
 * True ONLY for "we are out of credit", never for "the request was bad".
 *
 * Anthropic reports credit exhaustion as a 400 `invalid_request_error` whose
 * message names the credit balance — not a 401 or 429, which is why the
 * existing isTransientError() misses it. Org-level spend blocks can instead
 * arrive as a `billing_error` (403), so both shapes are matched.
 *
 * The narrowness is the point. An ordinary 400 — malformed request, oversized
 * image, a prompt the schema rejects — genuinely IS the candidate's fault and
 * must keep blaming the post, or one bad candidate wedges the loop forever.
 * Widening this predicate to all 400s would trade a destructive bug for a
 * hanging one.
 */
export function isBillingError(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false;
  if (error.type === "billing_error") return true;
  return (
    error.status === 400 &&
    /credit balance is too low|insufficient credit|purchase credits/i.test(error.message ?? "")
  );
}

/** True while credit is believed exhausted — spending loops skip their tick. */
export function llmBillingBlocked(): boolean {
  return Date.now() < blockedUntil;
}

/** Seconds until the next probe is allowed (0 when not blocked). */
export function llmBillingBlockedSeconds(): number {
  return Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
}

/**
 * Arm the block. Returns true if the error was a billing failure and the
 * caller should stand down; false if it is an ordinary error to handle
 * normally. Logs on every arm — an operator who has to act should not have to
 * go looking for the reason.
 */
export function noteLlmBillingBlocked(error: unknown): boolean {
  if (!isBillingError(error)) return false;
  const firstTrip = !llmBillingBlocked();
  blockedUntil = Date.now() + BILLING_BACKOFF_MS;
  if (firstTrip) {
    console.error(
      `[llm] OUT OF CREDIT — pausing evaluation, reply generation, and RSS deal ` +
        `checks for ${BILLING_BACKOFF_MS / 60_000}m (curator deals continue tokenless). ` +
        `Candidates stay PENDING and are NOT written off; top up at ` +
        `console.anthropic.com and the next tick resumes. ` +
        `Reason: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}

/** A successful call proves credit is back — clear the block immediately. */
export function noteLlmCallSucceeded(): void {
  if (blockedUntil !== 0) {
    console.log("[llm] credit restored — resuming evaluation and reply generation");
    blockedUntil = 0;
  }
}
