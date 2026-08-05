import type { SettingsSnapshot, ThresholdEntry } from "@trendcart/shared";
import { config } from "./config.js";

/**
 * Flattens the worker's resolved config into the threshold snapshot the
 * dashboard draws (see packages/shared/src/thresholds.ts for why the worker
 * owns this rather than the web process re-reading env).
 *
 * Only thresholds that CHANGE BEHAVIOUR belong here — poll intervals, backoff
 * windows and buffer sizes are implementation detail, and a page that lists
 * every env var is a page nobody reads. `inactive` marks a threshold whose
 * feature is currently switched off, so a number that isn't doing anything
 * says so instead of implying a limit that never binds.
 */
export function buildSettingsSnapshot(): SettingsSnapshot {
  const deals = config.deals.enabled;
  const rss = deals && config.deals.suggestions.enabled;
  const productLinks = config.bot.productLinksEnabled;

  const thresholds: ThresholdEntry[] = [
    // ── Reply volume ────────────────────────────────────────────
    {
      key: "MAX_REPLIES_PER_HOUR",
      label: "Replies per hour",
      value: config.bot.maxRepliesPerHour,
      kind: "cap",
      group: "Reply volume",
      meter: "repliesLastHour",
      note: "unsolicited only — mentions and your injections are exempt",
    },
    {
      key: "MAX_REPLIES_PER_DAY",
      label: "Replies per day",
      value: config.bot.maxRepliesPerDay,
      kind: "cap",
      group: "Reply volume",
      meter: "repliesLastDay",
      note: "unsolicited only; banter has its own budget",
    },
    {
      key: "GLOBAL_REPLY_COOLDOWN_MINUTES",
      label: "Gap between replies",
      value: config.bot.globalReplyCooldownMinutes,
      kind: "duration",
      group: "Reply volume",
      unit: "min",
    },
    {
      key: "AUTHOR_COOLDOWN_HOURS",
      label: "Same-author cooldown",
      value: config.bot.authorCooldownHours,
      kind: "duration",
      group: "Reply volume",
      unit: "h",
    },
    {
      key: "CATEGORY_COOLDOWN_MINUTES",
      label: "Same-category cooldown",
      value: config.bot.categoryCooldownMinutes,
      kind: "duration",
      group: "Reply volume",
      unit: "min",
    },

    // ── Quality bars ────────────────────────────────────────────
    {
      key: "MIN_PRODUCT_INTENT_SCORE",
      label: "Intent floor to reply at all",
      value: config.bot.minProductIntentScore,
      kind: "score",
      group: "Quality bars",
    },
    {
      key: "MIN_LINK_CONFIDENCE",
      label: "Link confidence floor",
      value: config.bot.minLinkConfidence,
      kind: "score",
      group: "Quality bars",
      note: "below this the query is never linked",
    },
    {
      key: "AUTO_MIN_INTENT_SCORE",
      label: "Intent to self-approve",
      value: config.bot.autoMinIntentScore,
      kind: "score",
      group: "Quality bars",
      note: "autonomous mode only",
    },
    {
      key: "AUTO_MIN_LINK_CONFIDENCE",
      label: "Link confidence to self-approve",
      value: config.bot.autoMinLinkConfidence,
      kind: "score",
      group: "Quality bars",
      note: "autonomous mode only",
    },
    {
      key: "REPLY_MIN_PRODUCT_MATCH",
      label: "Product-match floor",
      value: config.bot.minProductMatch,
      kind: "score",
      group: "Quality bars",
      inactive: !productLinks,
      note: "a resolved ASIN below this queues for your approval",
    },
    {
      key: "MIN_ENGAGEMENT_SCORE",
      label: "Engagement floor to evaluate",
      value: config.llm.minEngagementScore,
      kind: "count",
      group: "Quality bars",
      note: `statements need ${config.llm.lowSignalMultiplier}x this`,
    },

    // ── Sale gate ───────────────────────────────────────────────
    {
      key: "REPLY_PRODUCT_LINKS_ENABLED",
      label: "Direct product links + prices",
      value: productLinks,
      kind: "toggle",
      group: "Sale gate",
      note: "off = today's search links, no catalog calls",
    },
    {
      key: "REPLY_REQUIRE_SALE",
      label: "Require a discount when the author named the product",
      value: config.bot.requireSaleWhenAuthorNamed,
      kind: "toggle",
      group: "Sale gate",
      inactive: !productLinks,
    },
    {
      key: "REPLY_MIN_SAVING_PERCENT",
      label: "Minimum discount",
      value: config.bot.minSavingPercent,
      kind: "count",
      group: "Sale gate",
      unit: "%",
      inactive: !productLinks,
    },

    // ── LLM spend controls ──────────────────────────────────────
    {
      key: "MAX_LLM_EVALS_PER_HOUR",
      label: "Classifications per hour",
      value: config.llm.maxEvalsPerHour,
      kind: "cap",
      group: "LLM spend controls",
      meter: "evalsLastHour",
      note: "the single biggest lever on cost",
    },
    {
      key: "VISION_MAX_IMAGES",
      label: "Images per classification",
      value: config.vision.enabled ? config.vision.maxImagesPerCall : 0,
      kind: "count",
      group: "LLM spend controls",
      inactive: !config.vision.enabled,
    },
    {
      key: "COMMENTS_MAX",
      label: "Post replies read for context",
      value: config.comments.enabled ? config.comments.max : 0,
      kind: "count",
      group: "LLM spend controls",
      inactive: !config.comments.enabled,
      note: "free to fetch, but they lengthen the prompt",
    },
    {
      key: "FACTCHECK_MAX_SEARCHES",
      label: "Web searches per fact check",
      value: config.factCheck.maxSearches,
      kind: "count",
      group: "LLM spend controls",
      inactive: !config.factCheck.enabled,
      note: "billed per search, not per token",
    },
    {
      key: "FACTCHECK_MIN_CONFIDENCE",
      label: "Fact-check floor to auto-post",
      value: config.factCheck.minConfidence,
      kind: "score",
      group: "LLM spend controls",
      inactive: !config.factCheck.enabled,
    },
    {
      key: "DEAL_SUGGEST_MAX_LLM_PER_TICK",
      label: "Lane judgments per RSS tick",
      value: config.deals.suggestions.maxLlmPerTick,
      kind: "count",
      group: "LLM spend controls",
      inactive: !rss,
    },

    // ── Deal channel ────────────────────────────────────────────
    {
      key: "DEAL_MAX_POSTS_PER_DAY",
      label: "Deal posts per day",
      value: config.deals.maxPostsPerDay,
      kind: "cap",
      group: "Deal channel",
      meter: "dealPostsLastDay",
      inactive: !deals,
    },
    {
      key: "DEAL_RSS_MAX_POSTS_PER_DAY",
      label: "…of which from RSS",
      value: config.deals.suggestions.maxPostsPerDay,
      kind: "count",
      group: "Deal channel",
      unit: "/day",
      inactive: !rss,
    },
    {
      key: "DEAL_GLOBAL_COOLDOWN_MINUTES",
      label: "Gap between deal posts",
      value: config.deals.globalCooldownMinutes,
      kind: "duration",
      group: "Deal channel",
      unit: "min",
      inactive: !deals,
    },
    {
      key: "DEAL_MAX_PRICE_AGE_HOURS",
      label: "Price snapshot freshness",
      value: config.deals.maxPriceAgeHours,
      kind: "duration",
      group: "Deal channel",
      unit: "h",
      inactive: !deals,
    },
    {
      key: "DEAL_RSS_MIN_AMAZON_MATCH_CONFIDENCE",
      label: "ASIN match floor",
      value: config.deals.suggestions.minAmazonMatchConfidence,
      kind: "score",
      group: "Deal channel",
      inactive: !rss,
    },
    {
      key: "DEAL_SUGGEST_MIN_TOPIC_CONFIDENCE",
      label: "Lane-fit floor",
      value: config.deals.suggestions.minTopicConfidence,
      kind: "score",
      group: "Deal channel",
      inactive: !rss,
    },

    // ── Other lanes ─────────────────────────────────────────────
    {
      key: "BANTER_PER_DAY",
      label: "Banter posts per day",
      value: config.banter.perDay,
      kind: "cap",
      group: "Other lanes",
      meter: "banterLastDay",
      inactive: !config.banter.enabled,
    },
    {
      key: "BANTER_MIN_CONFIDENCE",
      label: "Humor-judge floor",
      value: config.banter.minConfidence,
      kind: "score",
      group: "Other lanes",
      inactive: !config.banter.enabled,
      note: "silence beats cringe",
    },
    {
      key: "APOLOGY_MAX_PER_DAY",
      label: "Apologies per day",
      value: config.apology.maxPerDay,
      kind: "cap",
      group: "Other lanes",
      meter: "apologiesLastDay",
      inactive: !config.apology.enabled,
    },
    {
      key: "PINTEREST_MAX_PINS_PER_DAY",
      label: "Pins per day",
      value: config.pinterest.maxPinsPerDay,
      kind: "cap",
      group: "Other lanes",
      meter: "pinsLastDay",
      inactive: !config.pinterest.refreshToken,
      note: "$0 in LLM tokens — pure string work",
    },
  ];

  return {
    capturedAt: new Date().toISOString(),
    model: config.llm.useFake ? "fake" : config.llm.model,
    thresholds,
  };
}
