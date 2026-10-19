import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { llmBillingBlocked, noteLlmBillingBlocked, noteLlmCallSucceeded } from "./llm-health.js";
import { gatedLlmCall, llmJobParams } from "./llm-job.js";

/**
 * The periodic jobs (banter, reflection, insights) stand down on billing
 * through gatedLlmCall. These pin the contract they rely on: no request while
 * the gate is armed, a billing error arms it instead of throwing, and nothing
 * else is swallowed.
 */

function apiError(status: number, type: string, message: string): unknown {
  return new Anthropic.APIError(
    status,
    { type: "error", error: { type, message } },
    message,
    new Headers(),
    type as never,
  );
}

const OUT_OF_CREDIT = apiError(
  400,
  "invalid_request_error",
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
);

// The gate is module state shared with the whole worker — reset between cases.
afterEach(() => noteLlmCallSucceeded());

test("while the gate is armed, the job never sends a request", async () => {
  noteLlmBillingBlocked(OUT_OF_CREDIT);
  let called = false;
  const result = await gatedLlmCall(async () => {
    called = true;
    return "spent";
  });
  assert.equal(result, null);
  assert.equal(called, false, "a blocked tick must not probe on its own");
});

test("a billing error stands the job down and arms the gate for everyone", async () => {
  assert.equal(llmBillingBlocked(), false);
  const result = await gatedLlmCall(async () => {
    throw OUT_OF_CREDIT;
  });
  // null, not a throw: the startLoop wrapper would otherwise log a failure
  // every tick for the whole outage — the bug this exists to fix.
  assert.equal(result, null);
  assert.equal(llmBillingBlocked(), true);
});

test("an org-level billing_error stands down too", async () => {
  const result = await gatedLlmCall(async () => {
    throw apiError(403, "billing_error", "spend limit reached");
  });
  assert.equal(result, null);
  assert.equal(llmBillingBlocked(), true);
});

test("ordinary failures still reach the job and never arm the gate", async () => {
  const malformed = apiError(400, "invalid_request_error", "messages: roles must alternate");
  await assert.rejects(
    gatedLlmCall(async () => {
      throw malformed;
    }),
    (error) => error === malformed,
  );
  await assert.rejects(
    gatedLlmCall(async () => {
      throw apiError(529, "overloaded_error", "overloaded");
    }),
  );
  assert.equal(llmBillingBlocked(), false);
});

test("a successful call clears the gate once the window lets a probe through", async () => {
  assert.equal(await gatedLlmCall(async () => "ok"), "ok");
  assert.equal(llmBillingBlocked(), false);
});

test("Haiku 5.5 gets thinking headroom and its effort; Haiku 4.5 gets neither", () => {
  // Haiku 5.5 thinks by default: a 1024 cap sized for the JSON alone would
  // truncate it once thinking spent first.
  assert.deepEqual(llmJobParams("claude-haiku-5-5", { answerTokens: 1200, effort: "medium" }), {
    max_tokens: 4800,
    effort: { effort: "medium" },
  });
  // Haiku 4.5 400s on effort and does not think unasked — params unchanged
  // from what prod sent before.
  assert.deepEqual(llmJobParams("claude-haiku-4-5", { answerTokens: 1200, effort: "medium" }), {
    max_tokens: 1200,
    effort: {},
  });
});

test("a job that wants the model's default effort sends none", () => {
  assert.deepEqual(llmJobParams("claude-haiku-5-5", { answerTokens: 200 }), {
    max_tokens: 1024,
    effort: {},
  });
});
