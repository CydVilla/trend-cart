import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlCache } from "./ttl-cache.js";

test("entries expire after the TTL", () => {
  let now = 0;
  const cache = new TtlCache<string>(1_000, 10, () => now);
  cache.set("B0ASIN", "ok");
  now = 999;
  assert.equal(cache.get("B0ASIN"), "ok");
  now = 1_000;
  assert.equal(cache.get("B0ASIN"), undefined);
});

test("the size cap evicts the oldest insert first", () => {
  const cache = new TtlCache<number>(60_000, 2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 3); // re-insert refreshes position
  cache.set("c", 4);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 3);
  assert.equal(cache.get("c"), 4);
});

test("a zero TTL disables caching", () => {
  const cache = new TtlCache<string>(0);
  cache.set("a", "x");
  assert.equal(cache.get("a"), undefined);
});
