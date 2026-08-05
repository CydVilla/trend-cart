import assert from "node:assert/strict";
import { test } from "node:test";
import { costMicros, formatUsd, modelPrice, readAnthropicUsage } from "@trendcart/db";

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
};

test("base input/output tokens price at the model's rate card", () => {
  // Haiku 4.5 is $1/MTok in, $5/MTok out.
  const micros = costMicros(
    "claude-haiku-4-5",
    { ...NO_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    "5m",
  );
  assert.equal(micros, 6_000_000); // $6.00
  assert.equal(formatUsd(micros), "$6.00");
});

test("dated model snapshots resolve to their family's rate card", () => {
  assert.equal(modelPrice("claude-haiku-4-5-20251001").known, true);
  assert.deepEqual(
    modelPrice("claude-haiku-4-5-20251001").price,
    modelPrice("claude-haiku-4-5").price,
  );
});

test("cache reads bill at 0.1x input and 1h writes at 2x", () => {
  // The 1h TTL was chosen in llm/anthropic.ts precisely because it doubles the
  // write price to convert misses into 0.1x reads — if these multipliers drift,
  // the page reports a cache decision that was never actually made.
  const read = costMicros("claude-haiku-4-5", { ...NO_USAGE, cacheReadTokens: 1_000_000 }, "1h");
  assert.equal(read, 100_000); // $0.10 = 0.1 x $1

  const write1h = costMicros("claude-haiku-4-5", { ...NO_USAGE, cacheWriteTokens: 1_000_000 }, "1h");
  assert.equal(write1h, 2_000_000); // $2.00 = 2 x $1

  const write5m = costMicros("claude-haiku-4-5", { ...NO_USAGE, cacheWriteTokens: 1_000_000 }, "5m");
  assert.equal(write5m, 1_250_000); // $1.25 = 1.25 x $1

  // The break-even the 1h choice rests on: one write plus three reads beats
  // three uncached inputs.
  assert.ok(write1h + 3 * read < 3 * costMicros("claude-haiku-4-5", { ...NO_USAGE, inputTokens: 1_000_000 }, "1h"));
});

test("web searches bill per search, not per token", () => {
  // $10 per 1,000 searches — a fact check's 3 searches cost $0.03, which
  // dwarfs its token cost on haiku and is the reason it's counted separately.
  const micros = costMicros("claude-haiku-4-5", { ...NO_USAGE, webSearches: 3 }, "5m");
  assert.equal(micros, 30_000);
});

test("an unknown model prices at the top of the range rather than as free", () => {
  const { known, price } = modelPrice("claude-something-new");
  assert.equal(known, false);
  assert.equal(price.inputPerMTok, 10);
  // A surprise model must never make the dashboard under-report the bill.
  assert.ok(
    costMicros("claude-something-new", { ...NO_USAGE, inputTokens: 1_000_000 }, "5m") >=
      costMicros("claude-opus-5", { ...NO_USAGE, inputTokens: 1_000_000 }, "5m"),
  );
});

test("usage parsing survives a response missing the fields it wants", () => {
  assert.deepEqual(readAnthropicUsage(undefined), NO_USAGE);
  assert.deepEqual(readAnthropicUsage({ input_tokens: null, output_tokens: "12" }), NO_USAGE);
  assert.deepEqual(readAnthropicUsage({ input_tokens: 5, cache_read_input_tokens: 7 }, 2), {
    ...NO_USAGE,
    inputTokens: 5,
    cacheReadTokens: 7,
    webSearches: 2,
  });
});

test("sub-cent amounts keep enough precision to be readable", () => {
  // A single haiku classification is fractions of a cent; "$0.00" would make
  // the per-operation table useless.
  assert.equal(formatUsd(4_100), "$0.0041");
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(1_234_567), "$1.23");
});
