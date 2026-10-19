import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCapabilities } from "@trendcart/shared";

test("Haiku 4.5 keeps temperature and rejects effort", () => {
  assert.deepEqual(modelCapabilities("claude-haiku-4-5"), {
    effort: false,
    temperature: true,
    dynamicWebSearch: false,
    thinksByDefault: false,
  });
  assert.equal(modelCapabilities("claude-haiku-4-5-20251001").effort, false);
});

test("Haiku 5.5 takes effort, 400s on temperature, and thinks by default", () => {
  // The old `includes("haiku")` sniff got all three of these wrong.
  assert.deepEqual(modelCapabilities("claude-haiku-5-5"), {
    effort: true,
    temperature: false,
    dynamicWebSearch: false,
    thinksByDefault: true,
  });
});

test("Opus and Sonnet get dynamic web search; only 4.6 keeps sampling params", () => {
  assert.equal(modelCapabilities("claude-opus-5-5").dynamicWebSearch, true);
  assert.equal(modelCapabilities("claude-sonnet-5-5").dynamicWebSearch, true);
  assert.equal(modelCapabilities("claude-opus-4-8").temperature, false);
  assert.equal(modelCapabilities("claude-sonnet-4-6").temperature, true);
  // Opus 4.7/4.8 run without thinking unless asked.
  assert.equal(modelCapabilities("claude-opus-4-8").thinksByDefault, false);
  assert.equal(modelCapabilities("claude-opus-5").thinksByDefault, true);
});
