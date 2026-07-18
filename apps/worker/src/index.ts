import { prisma } from "@trendcart/db";
import type { LlmClient } from "@trendcart/shared";
import { config } from "./config.js";
import { createDealChecker, type DealCheckStats } from "./deals/check.js";
import { createDealDiscoverer, newDealDiscoverStats } from "./deals/discover.js";
import { createDealPoster, type DealPostStats } from "./deals/poster.js";
import { createDealSuggester, newDealSuggestStats } from "./deals/suggest.js";
import { blueskyBackoffSeconds } from "./bluesky-health.js";
import { createDiscoverer, newDiscoverStats } from "./discover.js";
import { evaluateDueCandidates, type EvaluateStats } from "./evaluate.js";
import { flushHeartbeat, recordLoopTick, setCountersRef } from "./heartbeat.js";
import { insightsTick, type InsightsStats } from "./insights.js";
import { AnthropicLlmClient } from "./llm/anthropic.js";
import { FakeLlmClient } from "./llm/fake.js";
import { createNotificationListener, type NotificationStats } from "./notifications.js";
import { createNotifier, type NotifyStats } from "./notify.js";
import { outcomesTick, type OutcomeStats } from "./outcomes.js";
import { createPoster, type PosterStats } from "./poster.js";
import { createRadar, type RadarStats } from "./radar.js";
import { reflectTick, type ReflectStats } from "./reflect.js";
import { rehydrateTick, type RehydrateStats } from "./rehydrate.js";
import { generateDueReplies, type ReplyStats } from "./reply.js";
import { createTakedown, type TakedownStats } from "./takedown.js";

const STATS_LOG_MS = 30_000;

/**
 * Self-scheduling loop: the next tick is scheduled only after the current one
 * finishes, so a slow LLM call or hung fetch can never overlap itself.
 * Every tick (success or failure) is recorded in the heartbeat.
 */
function startLoop(name: string, intervalMs: number, fn: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<void> => {
    try {
      await fn();
      recordLoopTick(name);
    } catch (error) {
      recordLoopTick(name, error);
      console.error(`[${name}] tick failed:`, error instanceof Error ? error.message : error);
    } finally {
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function main(): Promise<void> {
  console.log("TrendCart worker starting");
  console.log(`  reply mode:       ${config.bot.replyMode} (dry run: ${config.bot.dryRun})`);
  console.log(`  discovery:        Bluesky search, every ${config.ingest.discoverIntervalMinutes}m (top posts, last 24h)`);
  console.log(`  trending floor:   engagement >= ${config.llm.minEngagementScore}`);
  console.log(`  affiliate tag:    ${config.site.amazonAssociateTag || "(unset)"}`);

  await prisma.$queryRaw`SELECT 1`;

  const categoryCount = await prisma.productCategory.count({ where: { isActive: true } });
  if (categoryCount === 0) {
    console.warn("No active categories — nothing to search for. Run: pnpm db:seed");
  } else {
    console.log(`  categories:       ${categoryCount} active (keywords = search queries)`);
  }

  const discoverStats = newDiscoverStats();
  const rehydrateStats: RehydrateStats = { hydrated: 0, missing: 0, errors: 0 };
  const evalStats: EvaluateStats = { evaluated: 0, wouldReply: 0, rejected: 0, errors: 0 };
  const replyStats: ReplyStats = {
    generated: 0,
    autoApproved: 0,
    factChecked: 0,
    factFlagged: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
  };
  const posterStats: PosterStats = { posted: 0, postFailed: 0, disabled: false };
  const notificationStats: NotificationStats = { optOuts: 0, requests: 0, apologies: 0, errors: 0 };
  const outcomeStats: OutcomeStats = { checked: 0, errors: 0 };
  const takedownStats: TakedownStats = { removed: 0, errors: 0 };
  const reflectStats: ReflectStats = { reflections: 0, errors: 0 };
  const insightsStats: InsightsStats = { reports: 0, errors: 0 };
  const dealCheckStats: DealCheckStats = { checked: 0, fired: 0, deferred: 0, errors: 0, backoffs: 0 };
  const dealPostStats: DealPostStats = { posted: 0, postFailed: 0, disabled: false };
  const dealDiscoverStats = newDealDiscoverStats();
  const dealSuggestStats = newDealSuggestStats();
  const radarStats: RadarStats = { drafted: 0, posted: 0, errors: 0, disabled: false };
  const notifyStats: NotifyStats = { pings: 0, errors: 0, disabled: false };
  setCountersRef({
    discover: discoverStats,
    rehydrate: rehydrateStats,
    evaluate: evalStats,
    reply: replyStats,
    poster: posterStats,
    notifications: notificationStats,
    outcomes: outcomeStats,
    takedown: takedownStats,
    reflect: reflectStats,
    insights: insightsStats,
    dealCheck: dealCheckStats,
    dealPost: dealPostStats,
    dealDiscover: dealDiscoverStats,
    dealSuggest: dealSuggestStats,
    radar: radarStats,
    notify: notifyStats,
  });

  const llm: LlmClient = config.llm.useFake
    ? new FakeLlmClient()
    : new AnthropicLlmClient(config.llm.anthropicApiKey, config.llm.model);
  console.log(
    `  evaluation:       ${config.llm.useFake ? "FAKE LLM (no API calls)" : config.llm.model} ` +
      `(max ${config.llm.maxEvalsPerHour}/hr)`,
  );

  const discoverer = createDiscoverer(discoverStats);
  if (!discoverer) {
    console.warn("  discovery:        disabled (no Bluesky credentials)");
  }
  const poster = createPoster(posterStats);
  const takedown = createTakedown(takedownStats);
  const notificationListener = createNotificationListener(notificationStats);
  if (!notificationListener) {
    console.warn("  mentions/opt-out:  disabled (no Bluesky credentials)");
  }

  // Deal tracker: the whole feature ships dark behind DEALS_ENABLED. The
  // checker self-disables without PA-API keys; the poster without Bluesky
  // creds or under DRY_RUN — the manual "post deal now" path still queues.
  const radar = createRadar(llm, radarStats);
  const notifier = createNotifier(notifyStats);
  if (!notifier) {
    console.log("  operator email:   disabled (set RESEND_API_KEY + NOTIFY_EMAIL_TO to enable)");
  }

  const dealChecker = config.deals.enabled ? createDealChecker(dealCheckStats) : null;
  const dealDiscoverer = config.deals.enabled ? createDealDiscoverer(dealDiscoverStats) : null;
  const dealPoster = config.deals.enabled ? createDealPoster(dealPostStats) : null;
  // RSS suggestions need no Amazon keys — the point is bridging the
  // pre-PA-API gap — so only DEALS_ENABLED (and its own toggle) gates them.
  const dealSuggester = config.deals.enabled ? createDealSuggester(llm, dealSuggestStats) : null;
  if (!config.deals.enabled) {
    console.log("  deal tracker:     disabled (set DEALS_ENABLED=true to run)");
  }

  const stops = [
    ...(discoverer
      ? [
          startLoop(
            "discover",
            config.ingest.discoverIntervalMinutes * 60_000,
            () => discoverer.tick(),
          ),
        ]
      : []),
    startLoop("rehydrate", 60_000, () => rehydrateTick(rehydrateStats)),
    startLoop("evaluate", 60_000, () => evaluateDueCandidates(llm, evalStats)),
    startLoop("reply", 60_000, () => generateDueReplies(llm, replyStats)),
    startLoop("poster", 30_000, () => poster.tick()),
    // 👎 takedowns: a down-rated posted reply is deleted from Bluesky within
    // ~2 min (the DB row stays — it keeps feeding the learning loop).
    ...(takedown ? [startLoop("takedown", 2 * 60_000, () => takedown.tick())] : []),
    startLoop("heartbeat", 30_000, () => flushHeartbeat()),
    // Radar: internal gating makes each tick a cheap findFirst; the 60s
    // cadence just means dashboard approvals publish promptly.
    ...(radar ? [startLoop("radar", 60_000, () => radar.tick())] : []),
    // Operator DM ping — rate-limited internally (one per N hours, max).
    ...(notifier ? [startLoop("notify", 10 * 60_000, () => notifier.tick())] : []),
    // Learning loop: hourly outcome measurement (free public API), daily
    // reflection (one small LLM call — reflectTick no-ops until stale).
    startLoop("outcomes", 3_600_000, () => outcomesTick(outcomeStats)),
    startLoop("reflect", 6 * 3_600_000, () => reflectTick(reflectStats)),
    // Daily funnel/insights report (one small LLM call — no-ops until stale).
    startLoop("insights", 6 * 3_600_000, () => insightsTick(insightsStats)),
    // Deal tracker loops (only when enabled + preconditions met).
    ...(dealChecker
      ? [startLoop("dealCheck", config.deals.checkIntervalMs, () => dealChecker.tick())]
      : []),
    // Ticks every minute; each feed is only due once per its interval, and
    // feedsPerTick caps the per-minute API burst.
    ...(dealDiscoverer?.enabled
      ? [startLoop("dealDiscover", 60_000, () => dealDiscoverer.tick())]
      : []),
    // Same per-source due-gating pattern as discovery, RSS instead of PA-API.
    ...(dealSuggester?.enabled
      ? [startLoop("dealSuggest", 60_000, () => dealSuggester.tick())]
      : []),
    ...(dealPoster ? [startLoop("dealPost", 30_000, () => dealPoster.tick())] : []),
    ...(notificationListener
      ? [
          // 90s cadence: mention requests deserve a prompt answer.
          startLoop("notifications", 90_000, async () => {
            try {
              await notificationListener.tick();
            } catch (error) {
              notificationStats.errors += 1;
              throw error;
            }
          }),
        ]
      : []),
  ];

  const statsTimer = setInterval(() => {
    const skips = Object.entries(discoverStats.skipped)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    console.log(
      `[stats] queries=${discoverStats.queries} found=${discoverStats.found} ` +
        `saved=${discoverStats.saved} discoverErrors=${discoverStats.errors} | ${skips} | ` +
        `hydrated=${rehydrateStats.hydrated} dead=${rehydrateStats.missing} ` +
        `| evaluated=${evalStats.evaluated} wouldReply=${evalStats.wouldReply} ` +
        `rejected=${evalStats.rejected} evalErrors=${evalStats.errors} ` +
        `| replies=${replyStats.generated} autoApproved=${replyStats.autoApproved} ` +
        `factChecked=${replyStats.factChecked} factFlagged=${replyStats.factFlagged} ` +
        `replySkips=${replyStats.skipped} ` +
        `replyDefer=${replyStats.deferred} replyFail=${replyStats.failed} ` +
        `posted=${posterStats.posted} requests=${notificationStats.requests} ` +
        `optOuts=${notificationStats.optOuts} apologies=${notificationStats.apologies} ` +
        `outcomes=${outcomeStats.checked} takedowns=${takedownStats.removed} ` +
        `lessons=${reflectStats.reflections}` +
        (blueskyBackoffSeconds() > 0 ? ` | BLUESKY DOWN (retry ${blueskyBackoffSeconds()}s)` : "") +
        (config.deals.enabled
          ? ` | dealChecked=${dealCheckStats.checked} dealFired=${dealCheckStats.fired} ` +
            `dealDefer=${dealCheckStats.deferred} dealPosted=${dealPostStats.posted} ` +
            `feedRuns=${dealDiscoverStats.feeds} feedFound=${dealDiscoverStats.found} ` +
            `feedQueued=${dealDiscoverStats.queued} rssItems=${dealSuggestStats.items} ` +
            `rssSuggested=${dealSuggestStats.suggested}`
          : ""),
    );
  }, STATS_LOG_MS);

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received — shutting down`);
    stops.forEach((stop) => stop());
    clearInterval(statsTimer);
    prisma.$disconnect().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Worker failed to start:", error);
  process.exitCode = 1;
});
