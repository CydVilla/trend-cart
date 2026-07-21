import type { HighConversionLane } from "@trendcart/shared";

export const GIFTABLE_MAX_PRICE_CENTS = 7_500;
export const MAX_FEED_CLOCK_SKEW_MS = 15 * 60_000;

export type LaneMeta = {
  label: string;
  /** Editorial prior only. Click results can move a lane above/below it. */
  priority: number;
};

export const HIGH_CONVERSION_LANES: Record<HighConversionLane, LaneMeta> = {
  "nintendo-switch": { label: "Nintendo / Switch", priority: 88 },
  "playstation-xbox": { label: "PlayStation / Xbox", priority: 82 },
  "pc-gaming": { label: "PC gaming peripherals", priority: 80 },
  "storage-ssd": { label: "Storage cards / SSDs", priority: 84 },
  "controllers-parts": { label: "Controllers / replacement parts", priority: 86 },
  "collectibles-fandom": { label: "Collectibles / fandom", priority: 76 },
  "recent-games": { label: "Recently released games", priority: 90 },
  "giftable-under-75": { label: "Giftable under $75", priority: 78 },
  other: { label: "Outside high-conversion lanes", priority: 0 },
};

type Rule = { lane: Exclude<HighConversionLane, "other">; patterns: RegExp[] };

/** Cheap deterministic fallback and audit cross-check. The LLM remains the
 * semantic classifier; these rules keep no-key/fake runs deterministic and
 * catch obvious lane assignments without trusting a model alone. */
const LANE_RULES: Rule[] = [
  {
    lane: "recent-games",
    patterns: [
      /\bnew(?:ly)? released?\b/i,
      /\bnew release\b/i,
      /\bpre-?order\b/i,
      /\blaunch edition\b/i,
      /\bday one edition\b/i,
    ],
  },
  {
    lane: "nintendo-switch",
    patterns: [
      /\bnintendo\b/i,
      /\bswitch(?:\s*2)?\b/i,
      /\bjoy-?con\b/i,
      /\bmario\b/i,
      /\bzelda\b/i,
      /\bpok[eé]mon\b/i,
      /\bamiibo\b/i,
    ],
  },
  {
    lane: "playstation-xbox",
    patterns: [
      /\bplaystation\b/i,
      /\bps[45]\b/i,
      /\bdualsense\b/i,
      /\bxbox\b/i,
      /\bseries [sx]\b/i,
    ],
  },
  {
    lane: "storage-ssd",
    patterns: [
      /\b(?:nvme|sata|m\.2)\b/i,
      /\bssd\b/i,
      /\bmicro\s*sd(?:xc)?\b/i,
      /\bmemory card\b/i,
      /\bexternal (?:drive|storage)\b/i,
      /\b[1248]\s*tb\b/i,
    ],
  },
  {
    lane: "controllers-parts",
    patterns: [
      /\bcontroller\b/i,
      /\bgamepad\b/i,
      /\bthumbsticks?\b/i,
      /\breplacement (?:parts?|sticks?|shell|battery)\b/i,
      /\bcharging (?:dock|station)\b/i,
      /\bcarrying case\b/i,
      /\bconsole stand\b/i,
    ],
  },
  {
    lane: "pc-gaming",
    patterns: [
      /\bgaming (?:mouse|keyboard|headset|monitor|chair|laptop|desktop|pc)\b/i,
      /\bgraphics card\b/i,
      /\bgeforce\b/i,
      /\bradeon\b/i,
      /\bgpu\b/i,
      /\bmechanical keyboard\b/i,
      /\bsteam deck\b/i,
    ],
  },
  {
    lane: "collectibles-fandom",
    patterns: [
      /\bcollect(?:ible|able)s?\b/i,
      /\baction figures?\b/i,
      /\bfunko\b/i,
      /\blego\b/i,
      /\bstatue\b/i,
      /\bgraphic tee\b/i,
      /\b(?:marvel|star wars|anime|disney|dc comics|harry potter)\b/i,
    ],
  },
];

export function heuristicLane(
  title: string,
  sourceContext: string,
  hintPriceCents: number | null,
): HighConversionLane {
  const productText = title.replace(/\s+/g, " ");
  for (const rule of LANE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(productText))) return rule.lane;
  }

  // Source context is a weak fallback only. It may say "gaming" while the
  // individual product is unrelated, so require one product-level signal.
  if (/video games?|gaming/i.test(sourceContext) && /\bgame\b|\bedition\b/i.test(productText)) {
    return "recent-games";
  }
  if (
    hintPriceCents != null &&
    hintPriceCents > 0 &&
    hintPriceCents <= GIFTABLE_MAX_PRICE_CENTS &&
    /\b(?:gift|toy|figure|set|kit|accessor|case|headset|game)\b/i.test(productText)
  ) {
    return "giftable-under-75";
  }
  return "other";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function freshnessScore(publishedAt: Date | null, now: Date): number {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return 45;
  const hours = Math.max(0, now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (hours <= 2) return 100;
  if (hours <= 8) return 88;
  if (hours <= 24) return 72;
  if (hours <= 48) return 42;
  return 0;
}

export type CandidateScoreInput = {
  lane: HighConversionLane;
  topicConfidence: number;
  purchaseIntentScore: number;
  amazonMatchConfidence: number;
  publishedAt: Date | null;
  hintPriceCents: number | null;
  now?: Date;
};

export type CandidateScore = {
  score: number;
  breakdown: {
    purchaseIntent: number;
    topicFit: number;
    amazonMatch: number;
    lanePrior: number;
    freshness: number;
    giftableBonus: number;
  };
};

/** Stable 0–100 base score. Revenue feedback is applied later, when the
 * queue is compared as a whole; keeping it out of the stored base score
 * makes the audit explainable even as performance changes. */
export function scoreCandidate(input: CandidateScoreInput): CandidateScore {
  if (input.lane === "other") {
    return {
      score: 0,
      breakdown: {
        purchaseIntent: 0,
        topicFit: 0,
        amazonMatch: 0,
        lanePrior: 0,
        freshness: 0,
        giftableBonus: 0,
      },
    };
  }
  const now = input.now ?? new Date();
  const purchaseIntent = clamp(input.purchaseIntentScore, 0, 100);
  const topicFit = clamp(input.topicConfidence, 0, 100);
  const amazonMatch = clamp(input.amazonMatchConfidence, 0, 100);
  const lanePrior = HIGH_CONVERSION_LANES[input.lane].priority;
  const freshness = freshnessScore(input.publishedAt, now);
  const giftableBonus =
    input.hintPriceCents != null &&
    input.hintPriceCents > 0 &&
    input.hintPriceCents <= GIFTABLE_MAX_PRICE_CENTS
      ? 5
      : 0;
  const score = Math.round(
    purchaseIntent * 0.3 +
      topicFit * 0.2 +
      amazonMatch * 0.25 +
      lanePrior * 0.15 +
      freshness * 0.1 +
      giftableBonus,
  );
  return {
    score: clamp(score, 0, 100),
    breakdown: { purchaseIntent, topicFit, amazonMatch, lanePrior, freshness, giftableBonus },
  };
}

export type LanePerformance = {
  posts: number;
  /** Posted deals that actually received a first-party click tracker. */
  trackedPosts: number;
  clicks: number;
  engagements: number;
  /** Clicked or meaningfully engaged posts in the short momentum window. */
  recentSuccesses: number;
};

/** A bounded feedback bonus: real clicks dominate, engagement bootstraps new
 * installations, and repeated no-click posts receive a small penalty. */
export function performanceBoost(performance: LanePerformance | undefined): number {
  if (!performance || performance.posts === 0) return 0;
  const clickRate =
    performance.trackedPosts > 0 ? performance.clicks / performance.trackedPosts : 0;
  const engagementRate = performance.engagements / performance.posts;
  const clickBoost =
    performance.trackedPosts > 0
      ? Math.min(14, Math.round(performance.clicks * 3 + clickRate * 7))
      : 0;
  const engagementBoost = Math.min(5, Math.round(engagementRate * 2));
  const momentumBoost = Math.min(8, performance.recentSuccesses * 2);
  const noClickPenalty =
    performance.trackedPosts >= 3 && performance.clicks === 0 ? -5 : 0;
  return clamp(clickBoost + engagementBoost + momentumBoost + noClickPenalty, -5, 24);
}

/** A current-sale claim needs a real, recent feed clock. Reject undated,
 * stale, and suspiciously future-dated items before any autonomous action. */
export function hasFreshSaleTimestamp(
  publishedAt: Date | null,
  now: Date,
  maxAgeHours: number,
): boolean {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return false;
  const ageMs = now.getTime() - publishedAt.getTime();
  return ageMs >= -MAX_FEED_CLOCK_SKEW_MS && ageMs <= maxAgeHours * 3_600_000;
}

export function effectiveCandidateScore(input: {
  baseScore: number;
  performance?: LanePerformance;
  sameLaneSlotsToday: number;
}): number {
  const diversityPenalty = Math.max(0, input.sameLaneSlotsToday) * 18;
  return clamp(
    input.baseScore + performanceBoost(input.performance) - diversityPenalty,
    0,
    125,
  );
}
