import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveCandidateScore,
  hasFreshSaleTimestamp,
  heuristicLane,
  performanceBoost,
  scoreCandidate,
} from "./rank.js";

test("classifies the requested high-conversion lanes", () => {
  assert.equal(heuristicLane("Nintendo Switch 2 Joy-Con charging dock", "gaming", 4_999), "nintendo-switch");
  assert.equal(heuristicLane("2TB NVMe SSD", "tech", 7_499), "storage-ssd");
  assert.equal(heuristicLane("DualSense wireless controller", "gaming", 6_999), "playstation-xbox");
  assert.equal(heuristicLane("Funko Star Wars figure", "collectibles", 1_999), "collectibles-fandom");
});

test("scores exact, fresh, purchase-oriented candidates above weak ones", () => {
  const now = new Date("2026-07-21T16:00:00Z");
  const strong = scoreCandidate({
    lane: "recent-games",
    topicConfidence: 95,
    purchaseIntentScore: 90,
    amazonMatchConfidence: 98,
    publishedAt: new Date("2026-07-21T15:00:00Z"),
    hintPriceCents: 6_999,
    now,
  });
  const weak = scoreCandidate({
    lane: "giftable-under-75",
    topicConfidence: 70,
    purchaseIntentScore: 55,
    amazonMatchConfidence: 76,
    publishedAt: null,
    hintPriceCents: null,
    now,
  });
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score >= 85);
});

test("click success boosts a lane but diversity still protects the feed", () => {
  const performance = {
    posts: 4,
    trackedPosts: 4,
    clicks: 3,
    engagements: 5,
    recentSuccesses: 2,
  };
  assert.ok(performanceBoost(performance) > 0);
  assert.ok(
    effectiveCandidateScore({ baseScore: 80, performance, sameLaneSlotsToday: 0 }) >
      effectiveCandidateScore({ baseScore: 80, performance, sameLaneSlotsToday: 1 }),
  );
});

test("missing click instrumentation is not treated as measured zero clicks", () => {
  const untracked = {
    posts: 5,
    trackedPosts: 0,
    clicks: 0,
    engagements: 0,
    recentSuccesses: 0,
  };
  assert.equal(performanceBoost(untracked), 0);
});

test("sale timestamps fail closed when missing, stale, or future-dated", () => {
  const now = new Date("2026-07-21T16:00:00Z");
  assert.equal(hasFreshSaleTimestamp(null, now, 24), false);
  assert.equal(hasFreshSaleTimestamp(new Date("2026-07-20T15:59:59Z"), now, 24), false);
  assert.equal(hasFreshSaleTimestamp(new Date("2026-07-21T16:16:00Z"), now, 24), false);
  assert.equal(hasFreshSaleTimestamp(new Date("2026-07-21T15:00:00Z"), now, 24), true);
});
