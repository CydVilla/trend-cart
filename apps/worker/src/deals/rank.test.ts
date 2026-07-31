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
  // Anime-figure terms outrank franchise terms other lanes claim: a Pokémon
  // scale figure is a figure, not a Switch accessory; Nendoroid always wins.
  assert.equal(heuristicLane("Taito Coreful Marin Kitagawa figure", "collectibles", 3_999), "anime-figures");
  assert.equal(heuristicLane("Pokemon Charizard 1/7 scale figure", "collectibles", 12_999), "anime-figures");
  assert.equal(heuristicLane("Nendoroid Hatsune Miku", "collectibles", 5_499), "anime-figures");
  assert.equal(heuristicLane("Demon Slayer anime figure Tanjiro", "collectibles", 2_999), "anime-figures");
  // Movies land in movies-tv — and a disc keyword wins over a fandom keyword
  // (a Marvel Blu-ray is a movie, not a collectible), since movies-tv precedes
  // collectibles-fandom in the rules.
  assert.equal(heuristicLane("Dune: Part Two 4K UHD Steelbook", "movies", 2_499), "movies-tv");
  assert.equal(heuristicLane("Marvel Cinematic Universe Blu-ray box set", "movies", 5_999), "movies-tv");
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
