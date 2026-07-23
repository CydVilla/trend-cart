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
    /* 50/h clears a discovery burst in ~1 day — at lower caps the July
       insights showed candidates expiring in the eval backlog (81% of all
       reply skips) before the reply loop ever saw them. */
    maxEvalsPerHour: envInt("MAX_LLM_EVALS_PER_HOUR", 50),
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

  /* Multimodal context for classification + reply. Both gated so cost stays
     predictable; thumbnails + free public reads keep it well under $1/day. */
  vision: {
    /* Send post image THUMBNAILS to the model as vision input so it can see a
       game screenshot / physical edition instead of guessing from hashtags.
       Thumbnails (not full-size) keep it ~$0.10/day at the eval cap. */
    enabled: envBool("VISION_ENABLED", true),
    /* Hard cap on images per LLM call (a Bluesky post carries up to 4). */
    maxImagesPerCall: envInt("VISION_MAX_IMAGES", 2),
  },
  comments: {
    /* Pull the post's top replies (public API — free, no auth) and give them
       to the classifier + reply as untrusted conversation context. */
    enabled: envBool("COMMENTS_ENABLED", true),
    /* Top-N replies by like count; bounds prompt size. */
    max: envInt("COMMENTS_MAX", 5),
    /* Drop replies shorter than this — "lol"/emoji add noise, not signal. */
    minLength: envInt("COMMENTS_MIN_LENGTH", 15),
  },

  /* One-shot apologies: when someone replies to the bot with negativity, it
     apologizes once with a FIXED template (the LLM only gates whether an
     apology is due — a stranger's words never shape what gets posted).
     Politeness only; reflection separately decides whether the feedback is
     constructive enough to internalize. */
  apology: {
    enabled: envBool("APOLOGY_ENABLED", true),
    /* Verdict floor: below this confidence that the reply is negative toward
       the BOT (not the world in general), stay silent. */
    minConfidence: envInt("APOLOGY_MIN_CONFIDENCE", 70),
    /* Hard daily cap — being dogpiled must not turn the bot into an
       apology-spam machine. */
    maxPerDay: envInt("APOLOGY_MAX_PER_DAY", 3),
    /* One apology per author per this many days — never argue, never feed
       trolls: repeat negativity from the same person gets silence. */
    authorCooldownDays: envInt("APOLOGY_AUTHOR_COOLDOWN_DAYS", 7),
  },

  /* Pre-publication fact check: replies about to post WITHOUT a human look
     (autonomous/auto self-approvals) get one LLM call with Anthropic's
     server-side web_search tool — does the product exist and is it orderable,
     are the reply's claims right? Fail-safe: any failure or low-confidence
     verdict demotes the reply to the manual-approval queue instead of
     auto-posting. Manually approved replies are never checked (the human is
     the fact-checker there). Cost: ≤1 call + ~1-3 searches per auto-approved
     reply (~$0.01-0.04 each at the daily reply cap). */
  factCheck: {
    enabled: envBool("FACTCHECK_ENABLED", true),
    /* Web searches the checker may run per reply (cost bound). */
    maxSearches: envInt("FACTCHECK_MAX_SEARCHES", 3),
    /* Verdict confidence floor: below this, auto-posting demotes to manual. */
    minConfidence: envInt("FACTCHECK_MIN_CONFIDENCE", 60),
    /* Auto-REJECT floor: a verdict that is inaccurate AND at least this
       confident is adequate evidence the reply is wrong (product missing /
       unorderable / claim contradicted) — the reply is auto-rejected rather
       than queued, and the evidence feeds the learning loop. Higher than the
       demote floor: a merely-unverified check (low confidence, or errored)
       still routes to a human, never auto-rejects. */
    disproofConfidence: envInt("FACTCHECK_DISPROOF_CONFIDENCE", 80),
  },

  site: {
    amazonAssociateTag: envString("AMAZON_ASSOCIATE_TAG", ""),
  },

  /* Click tracking: route posted affiliate links through a first-party
     /r/<id> redirect so clicks can be counted (the one revenue-proximate
     signal Amazon never gives per-post). ON by default when PUBLIC_BASE_URL
     is present; explicitly disable to send links straight to Amazon. */
  clickTracking: {
    enabled: envBool("CLICK_TRACKING_ENABLED", true),
    /* Public origin of the web app (no trailing slash) where /r/<id> lives,
       e.g. https://trend-cart-xxxx.herokuapp.com. Empty disables tracking
       regardless of the flag — a link with no reachable redirect is worse
       than an untracked-but-working one. */
    baseUrl: envString("PUBLIC_BASE_URL", "").replace(/\/+$/, ""),
  },

  /* Operator notifications: an EMAIL (via Resend) when actionable items land
     in the approval queues. Ships dark until RESEND_API_KEY and NOTIFY_EMAIL_TO
     are both set. NOTE: the default from-address (onboarding@resend.dev) only
     delivers to your own Resend account email; set NOTIFY_EMAIL_FROM to a
     verified-domain address to reach any other inbox. */
  notify: {
    resendApiKey: envString("RESEND_API_KEY", ""),
    emailTo: envString("NOTIFY_EMAIL_TO", ""),
    emailFrom: envString("NOTIFY_EMAIL_FROM", "TrendCart <onboarding@resend.dev>"),
    /* Rate limit: at most one ping per this many hours. */
    minIntervalHours: envInt("NOTIFY_MIN_INTERVAL_HOURS", 4),
    /* Optional dashboard link included in the email. */
    dashboardUrl: envString("DASHBOARD_URL", ""),
  },

  /* Trending banter: one humorous reply per day on a popular post under
     Bluesky's trending topics — the organic-growth surface (no link, no ad;
     it exists to draw people to the bot's deal feed). The bot reads the
     post's top-liked replies to sense the room, then writes its OWN take. */
  banter: {
    enabled: envBool("BANTER_ENABLED", true),
    /* Posts per day (DB-derived, restart-proof). */
    perDay: envInt("BANTER_PER_DAY", 1),
    /* LLM judgments per run — how many candidate posts it may consider
       before giving up for the day (cost + quality bound). */
    maxCandidates: envInt("BANTER_MAX_CANDIDATES", 3),
    /* A candidate post must have at least this many likes — banter belongs
       on posts with an audience. */
    minLikes: envInt("BANTER_MIN_LIKES", 50),
    /* Confidence floor from the humor judge: below this, stay silent
       (silence beats cringe — the operator's 👎s taught us that). */
    minConfidence: envInt("BANTER_MIN_CONFIDENCE", 70),
    maxLength: envInt("BANTER_MAX_LENGTH", 240),
  },

  ingest: {
    minPostLength: envInt("MIN_POST_LENGTH", 40),
    requireEnglish: envBool("REQUIRE_ENGLISH", true),
    /* Never ingest a post older than this. Candidates expire 24h after the
       post; ones discovered near that wall burn an LLM eval and die in the
       reply queue (15 of the first 51 expiries were discovered >18h old), and
       a reply that late lands on a dead thread anyway. */
    maxCandidateAgeHours: envInt("MAX_CANDIDATE_AGE_HOURS", 16),
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
    minLinkConfidence: envInt("MIN_LINK_CONFIDENCE", 75),
    /* Autonomous mode (dashboard toggle) self-approves only replies clearing
       BOTH bars; anything weaker still queues for manual approval. Defaults
       match the posting floors (MIN_PRODUCT_INTENT_SCORE / MIN_LINK_CONFIDENCE)
       on purpose: the classifier clusters at 85 for "worth replying", so a
       higher bar left autonomous mode effectively off. The pre-publication
       web-search fact check is the real backstop — it demotes any self-approved
       reply whose product it can't verify as existing/orderable. */
    autoMinIntentScore: envInt("AUTO_MIN_INTENT_SCORE", 85),
    autoMinLinkConfidence: envInt("AUTO_MIN_LINK_CONFIDENCE", 75),
    /* PLAYFUL (joke-first) replies are high-variance — the operator 👎'd two
       earnest attempts at this genre — so they queue for manual approval even
       in autonomous mode until this is flipped on. */
    playfulAutoApprove: envBool("PLAYFUL_AUTO_APPROVE", false),
    /* Replies are the SECONDARY channel (own-profile deal posts carry
       the volume): a trending reply must be rare and excellent. Caps apply to
       unsolicited replies only — mentions and operator injections are exempt. */
    maxRepliesPerHour: envInt("MAX_REPLIES_PER_HOUR", 1),
    maxRepliesPerDay: envInt("MAX_REPLIES_PER_DAY", 3),
    replyMaxLength: envInt("REPLY_MAX_LENGTH", 240),
    minProductIntentScore: envInt("MIN_PRODUCT_INTENT_SCORE", 85),
    authorCooldownHours: envInt("AUTHOR_COOLDOWN_HOURS", 168),
    categoryCooldownMinutes: envInt("CATEGORY_COOLDOWN_MINUTES", 120),
    globalReplyCooldownMinutes: envInt("GLOBAL_REPLY_COOLDOWN_MINUTES", 90),
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

    /* RSS deal channel: the no-PA-API Wario64 bridge, fully AUTOMATED. Polls
       deal RSS feeds (Deals page → Deal sources), lane-gates the items,
       corroborates each survivor with a web-search fact check, and self-posts
       PRICE-FREE copy ("spotted via Slickdeals") — no third-party price is
       ever advertised, honoring ADR-0013's attestation rule without a human
       in the loop. Needs no Amazon keys; PA-API feeds replace it with real
       attested prices once credentials exist. */
    suggestions: {
      enabled: envBool("DEAL_SUGGESTIONS_ENABLED", true),
      /* Master switch for autonomous RSS deal posts. Off = the RSS loop only
         records what it WOULD post (audit rows), nothing publishes. */
      autopost: envBool("DEAL_RSS_AUTOPOST", false),
      /* Daily budget for RSS-sourced posts — keep under DEAL_MAX_POSTS_PER_DAY
         so RSS finds can't starve future PA-API feed finds. */
      maxPostsPerDay: envInt("DEAL_RSS_MAX_POSTS_PER_DAY", 2),
      intervalMinutes: envInt("DEAL_SUGGEST_INTERVAL_MINUTES", 30),
      sourcesPerTick: envInt("DEAL_SUGGEST_SOURCES_PER_TICK", 2),
      /* Newest-first cap per fetch — bounds first-run floods. */
      maxItemsPerFetch: envInt("DEAL_SUGGEST_MAX_ITEMS_PER_FETCH", 30),
      /* Suggestion audit rows older than this auto-expire (deals rot fast). */
      expireHours: envInt("DEAL_SUGGEST_EXPIRE_HOURS", 6),
      /* Topical-gate floor: below this confidence an item is off-lane. */
      minTopicConfidence: envInt("DEAL_SUGGEST_MIN_TOPIC_CONFIDENCE", 70),
      /* LLM lane judgments per tick across all sources (cost bound). */
      maxLlmPerTick: envInt("DEAL_SUGGEST_MAX_LLM_PER_TICK", 20),
      /* Stage first, then let candidates across sources compete before the
         best one spends a posting slot or a web-search fact check. */
      stagingMinutes: envInt("DEAL_RSS_STAGING_MINUTES", 5),
      candidatePoolSize: envInt("DEAL_RSS_CANDIDATE_POOL_SIZE", 100),
      minCandidateScore: envInt("DEAL_RSS_MIN_CANDIDATE_SCORE", 65),
      /* Exact-ASIN matching floor before a candidate can enter the queue. */
      minAmazonMatchConfidence: envInt("DEAL_RSS_MIN_AMAZON_MATCH_CONFIDENCE", 80),
      /* Expensive strict sale-verification calls attempted per worker tick. */
      maxFactChecksPerTick: envInt("DEAL_RSS_MAX_FACTCHECKS_PER_TICK", 3),
      /* External evidence must explicitly confirm a current Amazon sale
         inside this window. The poster then enforces a shorter verification
         TTL so a staged deal cannot publish much later. */
      maxSaleEvidenceAgeHours: envInt("DEAL_RSS_SALE_EVIDENCE_MAX_AGE_HOURS", 6),
      verificationTtlMinutes: envInt("DEAL_RSS_VERIFICATION_TTL_MINUTES", 60),
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
