import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { isCreditExhaustionError } from "./credits.js";

/**
 * The detector decides whether an Anthropic failure means "the account cannot
 * pay" or "this request was bad". Getting it wrong is expensive in both
 * directions: a MISS re-creates the bug this module exists to fix (every
 * candidate blamed and tombstoned for an outage), and a FALSE POSITIVE
 * silences a perfectly funded bot for an hour until the probe clears it.
 *
 * Errors are built with APIError.generate — the SDK's own response→error
 * mapper — so these are the exact objects the pipeline would catch.
 */
function apiError(status: number, type: string, message: string): unknown {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    message,
    new Headers(),
  );
}

test("the real out-of-credits refusal is detected", () => {
  assert.equal(
    isCreditExhaustionError(
      apiError(
        400,
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    ),
    true,
  );
});

test("an explicit billing_error is detected whatever the message says", () => {
  assert.equal(isCreditExhaustionError(apiError(403, "billing_error", "organization suspended")), true);
});

test("an ordinary validation 400 is NOT treated as out-of-credits", () => {
  // The critical false-positive case: this shares a status code with the
  // credit refusal, and latching on it would take the bot off the air.
  assert.equal(
    isCreditExhaustionError(
      apiError(400, "invalid_request_error", "messages: roles must alternate between \"user\" and \"assistant\""),
    ),
    false,
  );
});

test("an ordinary rate limit is NOT out-of-credits (it retries on its own)", () => {
  assert.equal(
    isCreditExhaustionError(apiError(429, "rate_limit_error", "Number of requests has exceeded your rate limit")),
    false,
  );
});

test("a spend-limit 429 IS out-of-credits — retrying cannot fix a cap", () => {
  // Same status as the ordinary rate limit above; only the message separates
  // "slow down" (recoverable by waiting) from "you are capped" (not).
  assert.equal(
    isCreditExhaustionError(
      apiError(429, "rate_limit_error", "You have exceeded your organization's spending limit"),
    ),
    true,
  );
});

test("server errors and transport failures stay retryable", () => {
  assert.equal(isCreditExhaustionError(apiError(500, "api_error", "Internal server error")), false);
  assert.equal(isCreditExhaustionError(apiError(529, "overloaded_error", "Overloaded")), false);
  assert.equal(isCreditExhaustionError(new Error("socket hang up")), false);
  assert.equal(isCreditExhaustionError(undefined), false);
});
