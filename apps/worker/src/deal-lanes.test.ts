import assert from "node:assert/strict";
import { test } from "node:test";
import { HIGH_CONVERSION_LANE_SLUGS } from "@trendcart/shared";
import { SUGGESTION_SYSTEM } from "./llm/anthropic.js";
import { HIGH_CONVERSION_LANES } from "./deals/rank.js";

/**
 * A lane has to be declared in three places that cannot check each other:
 * the shared slug list (which now derives both the type and the classifier's
 * output schema), the ranking table, and the system prompt's prose.
 *
 * When `anime-figures` was added it landed in the type, the ranking table and
 * the prompt — but not the validator. The model was therefore instructed to
 * return a value the schema rejected, so every anime-figure deal died with
 * "Failed to parse structured output" and was silently dropped. The schema is
 * now derived, which closes that gap structurally; these tests cover the two
 * seams derivation cannot reach.
 */

test("every lane is offered to the model in the system prompt", () => {
  for (const lane of HIGH_CONVERSION_LANE_SLUGS) {
    assert.ok(
      SUGGESTION_SYSTEM.includes(lane),
      `lane "${lane}" is accepted by the schema but never mentioned in SUGGESTION_SYSTEM — ` +
        `the model cannot return a lane it was never told about`,
    );
  }
});

test("every lane has ranking metadata", () => {
  for (const lane of HIGH_CONVERSION_LANE_SLUGS) {
    assert.ok(
      HIGH_CONVERSION_LANES[lane],
      `lane "${lane}" has no entry in HIGH_CONVERSION_LANES — ranking would throw on it`,
    );
  }
});

test("anime-figures specifically survives the round trip", () => {
  // The regression that motivated all of this. Highest-priority lane (85),
  // and the one tied to the only confirmed figure sale.
  assert.ok(HIGH_CONVERSION_LANE_SLUGS.includes("anime-figures"));
  assert.equal(HIGH_CONVERSION_LANES["anime-figures"].priority, 85);
  assert.ok(SUGGESTION_SYSTEM.includes("anime-figures"));
});
