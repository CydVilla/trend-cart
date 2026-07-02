import { prisma } from "@trendcart/db";
import type { LlmClient } from "@trendcart/shared";
import { config } from "./config.js";
import { evaluateDueCandidates, type EvaluateStats } from "./evaluate.js";
import { CategoryMatcher } from "./filters.js";
import { flushHeartbeat, recordLoopTick, setCountersRef } from "./heartbeat.js";
import { newIngestStats, processPostEvent } from "./ingest.js";
import { JetstreamClient } from "./jetstream.js";
import { AnthropicLlmClient } from "./llm/anthropic.js";
import { FakeLlmClient } from "./llm/fake.js";
import { createOptOutListener, type NotificationStats } from "./notifications.js";
import { createPoster, type PosterStats } from "./poster.js";
import { rehydrateTick, type RehydrateStats } from "./rehydrate.js";
import { generateDueReplies, type ReplyStats } from "./reply.js";

const CATEGORY_RELOAD_MS = 5 * 60_000;
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

async function loadMatcherCategories() {
  return prisma.productCategory.findMany({
    where: { isActive: true },
    select: { slug: true, keywords: true, negativeKeywords: true },
  });
}

async function main(): Promise<void> {
  console.log("TrendCart worker starting");
  console.log(`  reply mode:       ${config.bot.replyMode} (dry run: ${config.bot.dryRun})`);
  console.log(`  jetstream:        ${config.bluesky.jetstreamUrl}`);
  console.log(`  eval maturation:  ${config.llm.evalMinPostAgeMinutes}m (manual posts skip it)`);
  console.log(`  affiliate tag:    ${config.site.amazonAssociateTag || "(unset)"}`);

  await prisma.$queryRaw`SELECT 1`;

  const matcher = new CategoryMatcher(await loadMatcherCategories());
  if (matcher.categoryCount === 0) {
    console.warn("No active categories — nothing will match. Run: pnpm db:seed");
  } else {
    console.log(`  categories:       ${matcher.categoryCount} active`);
  }

  const ingestStats = newIngestStats();
  const rehydrateStats: RehydrateStats = { hydrated: 0, missing: 0, errors: 0 };
  const evalStats: EvaluateStats = { evaluated: 0, wouldReply: 0, rejected: 0, errors: 0 };
  const replyStats: ReplyStats = { generated: 0, skipped: 0, deferred: 0, failed: 0 };
  const posterStats: PosterStats = { posted: 0, postFailed: 0, disabled: false };
  const notificationStats: NotificationStats = { optOuts: 0, errors: 0 };
  setCountersRef({
    ingest: ingestStats,
    rehydrate: rehydrateStats,
    evaluate: evalStats,
    reply: replyStats,
    poster: posterStats,
    notifications: notificationStats,
  });

  const llm: LlmClient = config.llm.useFake
    ? new FakeLlmClient()
    : new AnthropicLlmClient(config.llm.anthropicApiKey, config.llm.model);
  console.log(
    `  evaluation:       ${config.llm.useFake ? "FAKE LLM (no API calls)" : config.llm.model} ` +
      `(max ${config.llm.maxEvalsPerHour}/hr)`,
  );

  const jetstream = new JetstreamClient({
    url: config.bluesky.jetstreamUrl,
    wantedCollections: ["app.bsky.feed.post"],
    onEvent: (event) => {
      recordLoopTick("ingest");
      // Fire-and-forget: only keyword-matched posts ever reach the DB,
      // so in-flight writes stay rare relative to event volume.
      processPostEvent(event, matcher, ingestStats).catch((error) => {
        console.error("ingest failed:", error instanceof Error ? error.message : error);
      });
    },
  });
  jetstream.start();

  const poster = createPoster(posterStats);
  const optOutListener = createOptOutListener(notificationStats);
  if (!optOutListener) {
    console.warn("  opt-out listener: disabled (no Bluesky credentials)");
  }

  const stops = [
    startLoop("rehydrate", 60_000, () => rehydrateTick(rehydrateStats)),
    startLoop("evaluate", 60_000, () => evaluateDueCandidates(llm, evalStats)),
    startLoop("reply", 60_000, () => generateDueReplies(llm, replyStats)),
    startLoop("poster", 30_000, () => poster.tick()),
    startLoop("heartbeat", 30_000, () => flushHeartbeat()),
    // Pick up dashboard edits to categories without restarting the worker.
    startLoop("categories", CATEGORY_RELOAD_MS, async () => {
      matcher.update(await loadMatcherCategories());
    }),
    ...(optOutListener
      ? [
          startLoop("optout", 3 * 60_000, async () => {
            try {
              await optOutListener.tick();
            } catch (error) {
              notificationStats.errors += 1;
              throw error;
            }
          }),
        ]
      : []),
  ];

  const statsTimer = setInterval(() => {
    const skips = Object.entries(ingestStats.skipped)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    console.log(
      `[stats] events=${ingestStats.events} creates=${ingestStats.creates} ` +
        `saved=${ingestStats.saved} deleted=${ingestStats.deletes} | ${skips} | ` +
        `hydrated=${rehydrateStats.hydrated} dead=${rehydrateStats.missing} ` +
        `| evaluated=${evalStats.evaluated} wouldReply=${evalStats.wouldReply} ` +
        `rejected=${evalStats.rejected} evalErrors=${evalStats.errors} ` +
        `| replies=${replyStats.generated} replySkips=${replyStats.skipped} ` +
        `replyDefer=${replyStats.deferred} replyFail=${replyStats.failed} ` +
        `posted=${posterStats.posted} optOuts=${notificationStats.optOuts}`,
    );
  }, STATS_LOG_MS);

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received — shutting down`);
    jetstream.stop();
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
