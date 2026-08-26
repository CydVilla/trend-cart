import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { isBillingError } from "./llm-health.js";

/** Build the SDK error the API layer would raise for a given response. */
function apiError(status: number, type: string, message: string): unknown {
  return new Anthropic.APIError(
    status,
    { type: "error", error: { type, message } },
    message,
    new Headers(),
    type as never,
  );
}

test("credit exhaustion is recognised despite arriving as a 400", () => {
  // The whole reason this predicate exists: Anthropic reports an empty balance
  // as invalid_request_error/400, so isTransientError() (401/429/5xx/network)
  // never matches it.
  assert.equal(
    isBillingError(
      apiError(
        400,
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    ),
    true,
  );
});

test("an org-level billing_error is recognised too", () => {
  assert.equal(isBillingError(apiError(403, "billing_error", "spend limit reached")), true);
});

test("an ordinary 400 still blames the post", () => {
  // THE case that must not regress. Widening this to all 400s would stop the
  // loop from ever writing off a genuinely malformed candidate, and one bad
  // post would wedge evaluation forever — a hang traded for a data-loss bug.
  assert.equal(
    isBillingError(apiError(400, "invalid_request_error", "messages: roles must alternate")),
    false,
  );
  assert.equal(
    isBillingError(apiError(400, "invalid_request_error", "image exceeds 5 MB")),
    false,
  );
});

test("errors the transient path already owns are not claimed here", () => {
  // Rate limits and outages must keep their own shorter backoff.
  assert.equal(isBillingError(apiError(429, "rate_limit_error", "rate limited")), false);
  assert.equal(isBillingError(apiError(500, "api_error", "internal")), false);
  assert.equal(isBillingError(apiError(401, "authentication_error", "bad key")), false);
});

test("non-Anthropic failures are never billing", () => {
  assert.equal(isBillingError(new Error("credit balance is too low")), false);
  assert.equal(isBillingError(null), false);
  assert.equal(isBillingError(undefined), false);
});
