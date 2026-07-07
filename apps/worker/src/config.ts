import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { envBool, envInt, envString, parseDealPostStyle, requireEnv } from "@trendcart/shared";

// Load the repo-root .env whether we're run from the repo root or apps/worker.
for (const candidate of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    break;
  }
}

export type ReplyMode = "dry_run" | "manual" | "auto";

function parseReplyMode(raw: string): ReplyMode {
  if (raw === "dry_run" || raw === "manual" || raw === "auto") return raw;
  throw new Error(`REPLY_MODE must be dry_run | manual | auto, got: ${raw}`);
}

const useFakeLlm = envBool("USE_FAKE_LLM", false);
const paApiAccessKey = envString("PA_API_ACCESS_KEY", "");
const paApiSecretKey = envString("PA_API_SECRET_KEY", "");
let dryRun = envBool("DRY_RUN", true);
// Fail-safe: heuristic fake verdicts must never post to real people. A
// leftover USE_FAKE_LLM=true forces dry-run rather than trusting env-var
// discipline across three independent variables.
if (useFakeLlm && !dryRun) {
  console.warn("USE_FAKE_LLM=true forces DRY_RUN=true — fake verdicts never post live.");
  dryRun = true;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),

  bluesky: {
    handle: envString("BOT_ACCOUNT_HANDLE", ""),
    appPassword: envString("BOT_APP_PASSWORD", ""),
  },

  llm: {
    anthropicApiKey: envString("ANTHROPIC_API_KEY", ""),
    model: envString("ANTHROPIC_MODEL", "claude-opus-4-8"),
    /* Deterministic fake client for pipeline testing without API spend */
    useFake: useFakeLlm,
    maxEvalsPerHour: envInt("MAX_LLM_EVALS_PER_HOUR", 40),
    /* Firehose posts wait this long before evaluation so the engagement
       snapshot is meaningful; manually injected posts skip the wait. */
    evalMinPostAgeMinutes: envInt("EVAL_MIN_POST_AGE_MINUTES", 30),
    /* Trending floor: a firehose post must reach this engagement score
       (likes + 3*reposts + 2*replies + 3*quotes) after maturing, or the LLM
       never sees it. Mentions and manual injections are exempt. */
    minEngagementScore: envInt("MIN_ENGAGEMENT_SCORE", 10),
    /* Low-signal gate: a STATEMENT post (no question / no ask) needs
       floor × this multiplier engagement to justify LLM spend. Enthusiast
       posts are usually statements, so keep this modest. */
    lowSignalMultiplier: envInt("LOW_SIGNAL_MULTIPLIER", 2),
  },

  site: {
    amazonAssociateTag: envString("AMAZON_ASSOCIATE_TAG", ""),
  },

  ingest: {
    minPostLength: envInt("MIN_POST_LENGTH", 40),
    requireEnglish: envBool("REQUIRE_ENGLISH", true),
    /* How often to poll Bluesky search for trending candidates */
    discoverIntervalMinutes: envInt("DISCOVER_INTERVAL_MINUTES", 15),
    rehydrateIntervalMinutes: envInt("REHYDRATE_INTERVAL_MINUTES", 15),
    rehydrateMaxAgeHours: envInt("REHYDRATE_MAX_AGE_HOURS", 24),
  },

  bot: {
    dryRun,
    replyMode: parseReplyMode(envString("REPLY_MODE", "manual")),
    /* Link-quality floor: a recommended search query below this confidence is
       never linked (the category fallback or a skip happens instead). */
    minLinkConfidence: envInt("MIN_LINK_CONFIDENCE", 60),
    /* Autonomous mode (dashboard toggle) self-approves only replies clearing
       BOTH bars; anything weaker still queues for manual approval. */
    autoMinIntentScore: envInt("AUTO_MIN_INTENT_SCORE", 80),
    autoMinLinkConfidence: envInt("AUTO_MIN_LINK_CONFIDENCE", 75),
    maxRepliesPerHour: envInt("MAX_REPLIES_PER_HOUR", 3),
    maxRepliesPerDay: envInt("MAX_REPLIES_PER_DAY", 20),
    replyMaxLength: envInt("REPLY_MAX_LENGTH", 240),
    minProductIntentScore: envInt("MIN_PRODUCT_INTENT_SCORE", 70),
    authorCooldownHours: envInt("AUTHOR_COOLDOWN_HOURS", 168),
    categoryCooldownMinutes: envInt("CATEGORY_COOLDOWN_MINUTES", 120),
    globalReplyCooldownMinutes: envInt("GLOBAL_REPLY_COOLDOWN_MINUTES", 10),
  },

  /* Deal tracker: standalone deal-alert posts to the bot's own profile.
     Whole feature ships dark behind DEALS_ENABLED; DRY_RUN still gates all
     posting. Caps are deliberately tighter than replies — a standalone promo
     post on the bot's profile is more spam-prone than a contextual reply. */
  deals: {
    enabled: envBool("DEALS_ENABLED", false),
    checkIntervalMs: envInt("DEAL_CHECK_INTERVAL_MS", 60_000),
    /* Minimum gap before the same listing is re-polled. */
    listingRecheckMs: envInt("DEAL_LISTING_RECHECK_MS", 900_000),
    /* Soft daily PA-API cap, well under Amazon's 8640/day hard limit. */
    maxPaApiCallsPerDay: envInt("DEAL_MAX_PA_API_CALLS_PER_DAY", 4_000),
    /* A listing auto-deactivates after this many consecutive poll failures. */
    maxConsecutiveErrors: envInt("DEAL_MAX_CONSECUTIVE_ERRORS", 5),
    listingErrorBackoffHours: envInt("DEAL_LISTING_ERROR_BACKOFF_HOURS", 6),
    /* Re-arm hysteresis: re-arm only when price > target*(1+pct/100). */
    rearmBufferPct: envInt("DEAL_REARM_BUFFER_PCT", 3),
    /* Minimum gap between posts for the SAME listing (restart-proof). */
    perListingCooldownHours: envInt("DEAL_PER_LISTING_COOLDOWN_HOURS", 168),
    /* Global caps on standalone deal posts. */
    maxPostsPerDay: envInt("DEAL_MAX_POSTS_PER_DAY", 3),
    globalCooldownMinutes: envInt("DEAL_GLOBAL_COOLDOWN_MINUTES", 60),
    /* Amazon price-freshness: never post a price snapshot older than this. */
    maxPriceAgeHours: envInt("DEAL_MAX_PRICE_AGE_HOURS", 1),
    postMaxLength: envInt("DEAL_POST_MAX_LENGTH", 300),
    paapiBaseBackoffMs: envInt("DEAL_PAAPI_BASE_BACKOFF_MS", 60_000),
    paapiMaxBackoffMs: envInt("DEAL_PAAPI_MAX_BACKOFF_MS", 3_600_000),
    /* "wario" = terse deal-account copy, the price phrase is the link;
       "classic" = the original lead-in format on the fixed anchor. */
    postStyle: parseDealPostStyle(envString("DEAL_POST_STYLE", "wario")),

    /* Deal-feed discovery: PA-API SearchItems polls each active DealFeed for
       products currently on sale (Wario64-style, but approval-gated unless
       DEAL_FEED_AUTOPOST=true). Needs DEALS_ENABLED + PA-API keys. */
    discovery: {
      intervalMinutes: envInt("DEAL_DISCOVERY_INTERVAL_MINUTES", 30),
      /* Feeds polled per tick (each = 1 SearchItems call/page); the rest wait
         their turn, oldest-run first, so quota spreads across feeds. */
      feedsPerTick: envInt("DEAL_DISCOVERY_FEEDS_PER_TICK", 4),
      /* SearchItems pages per feed run (10 items each, 1 call per page). */
      pagesPerFeed: envInt("DEAL_DISCOVERY_PAGES_PER_FEED", 1),
      /* true = discovered deals post without operator approval (the real
         Wario64 mode). false = they queue as PENDING_APPROVAL and expire when
         the price snapshot goes stale. DRY_RUN overrides either way. */
      autopost: envBool("DEAL_FEED_AUTOPOST", false),
      /* Daily budget for DISCOVERED posts only — keep it under
         DEAL_MAX_POSTS_PER_DAY so feed finds can't starve watchlist alerts. */
      maxPostsPerDay: envInt("DEAL_FEED_MAX_POSTS_PER_DAY", 2),
    },

    /* RSS deal suggestions: the no-PA-API bridge. Polls deal RSS feeds
       (Deals page → Suggestion sources), lane-gates the items, and queues
       SUGGESTIONS the operator confirms — this path never posts on its own
       and needs no Amazon keys. */
    suggestions: {
      enabled: envBool("DEAL_SUGGESTIONS_ENABLED", true),
      intervalMinutes: envInt("DEAL_SUGGEST_INTERVAL_MINUTES", 30),
      sourcesPerTick: envInt("DEAL_SUGGEST_SOURCES_PER_TICK", 2),
      /* Newest-first cap per fetch — bounds first-run floods. */
      maxItemsPerFetch: envInt("DEAL_SUGGEST_MAX_ITEMS_PER_FETCH", 30),
      /* NEW suggestions older than this auto-expire (deals rot fast). */
      expireHours: envInt("DEAL_SUGGEST_EXPIRE_HOURS", 48),
      /* Topical-gate floor: below this confidence an item is off-lane. */
      minTopicConfidence: envInt("DEAL_SUGGEST_MIN_TOPIC_CONFIDENCE", 70),
      /* LLM lane judgments per tick across all sources (cost bound). */
      maxLlmPerTick: envInt("DEAL_SUGGEST_MAX_LLM_PER_TICK", 20),
    },
  },

  /* Amazon Product Advertising API 5.0 credentials. When either key is
     absent the deal-check loop stands down and only the manual path runs. */
  paapi: {
    accessKey: paApiAccessKey,
    secretKey: paApiSecretKey,
    partnerTag: envString("PA_API_PARTNER_TAG", "") || envString("AMAZON_ASSOCIATE_TAG", ""),
    marketplace: envString("PA_API_MARKETPLACE", "www.amazon.com"),
    host: envString("PA_API_HOST", "webservices.amazon.com"),
    region: envString("PA_API_REGION", "us-east-1"),
    enabled: Boolean(paApiAccessKey && paApiSecretKey),
  },
} as const;
