import { prisma } from "@trendcart/db";
import type { LlmClient } from "@trendcart/shared";
import { config } from "./config.js";
import { startEvaluationLoop, type EvaluateStats } from "./evaluate.js";
import { CategoryMatcher } from "./filters.js";
import { newIngestStats, processPostEvent } from "./ingest.js";
import { JetstreamClient } from "./jetstream.js";
import { AnthropicLlmClient } from "./llm/anthropic.js";
import { FakeLlmClient } from "./llm/fake.js";
import { startPostingLoop, type PosterStats } from "./poster.js";
import { startRehydrationLoop, type RehydrateStats } from "./rehydrate.js";
import { startReplyLoop, type ReplyStats } from "./reply.js";

const CATEGORY_RELOAD_MS = 5 * 60_000;
const STATS_LOG_MS = 30_000;

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
  console.log(`  min post length:  ${config.ingest.minPostLength}`);
  console.log(`  english only:     ${config.ingest.requireEnglish}`);
  console.log(`  rehydrate every:  ${config.ingest.rehydrateIntervalMinutes}m (posts < ${config.ingest.rehydrateMaxAgeHours}h old)`);

  await prisma.$queryRaw`SELECT 1`;

  const matcher = new CategoryMatcher(await loadMatcherCategories());
  if (matcher.categoryCount === 0) {
    console.warn("No active categories — nothing will match. Run: pnpm db:seed");
  } else {
    console.log(`  categories:       ${matcher.categoryCount} active`);
  }

  // Pick up dashboard edits to categories without restarting the worker.
  const categoryTimer = setInterval(() => {
    loadMatcherCategories()
      .then((categories) => matcher.update(categories))
      .catch((error) => console.error("category reload failed:", error));
  }, CATEGORY_RELOAD_MS);

  const ingestStats = newIngestStats();
  const rehydrateStats: RehydrateStats = { hydrated: 0, missing: 0, errors: 0 };

  const jetstream = new JetstreamClient({
    url: config.bluesky.jetstreamUrl,
    wantedCollections: ["app.bsky.feed.post"],
    onEvent: (event) => {
      // Fire-and-forget: only keyword-matched posts ever reach the DB,
      // so in-flight writes stay rare relative to event volume.
      processPostEvent(event, matcher, ingestStats).catch((error) => {
        console.error("ingest failed:", error instanceof Error ? error.message : error);
      });
    },
  });
  jetstream.start();

  const stopRehydration = startRehydrationLoop(rehydrateStats);

  // Evaluation: fake client for pipeline testing, real client otherwise.
  // The Anthropic SDK also resolves credentials from the environment, so an
  // empty ANTHROPIC_API_KEY only disables evaluation if no other source exists
  // (failures surface per-call and are counted, not fatal).
  const evalStats: EvaluateStats = { evaluated: 0, wouldReply: 0, rejected: 0, errors: 0 };
  const llm: LlmClient = config.llm.useFake
    ? new FakeLlmClient()
    : new AnthropicLlmClient(config.llm.anthropicApiKey, config.llm.model);
  console.log(
    `  evaluation:       ${config.llm.useFake ? "FAKE LLM (no API calls)" : config.llm.model} ` +
      `(max ${config.llm.maxEvalsPerHour}/hr)`,
  );
  const stopEvaluation = startEvaluationLoop(llm, evalStats);

  const replyStats: ReplyStats = { generated: 0, skipped: 0, deferred: 0, failed: 0 };
  const stopReplies = startReplyLoop(llm, replyStats);

  const posterStats: PosterStats = { posted: 0, postFailed: 0, disabled: false };
  const stopPosting = startPostingLoop(posterStats);

  const statsTimer = setInterval(() => {
    const skips = Object.entries(ingestStats.skipped)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    console.log(
      `[stats] events=${ingestStats.events} creates=${ingestStats.creates} ` +
        `saved=${ingestStats.saved} deleted=${ingestStats.deletes} | ${skips} | ` +
        `hydrated=${rehydrateStats.hydrated} missing=${rehydrateStats.missing} ` +
        `hydrateErrors=${rehydrateStats.errors} | evaluated=${evalStats.evaluated} ` +
        `wouldReply=${evalStats.wouldReply} rejected=${evalStats.rejected} ` +
        `evalErrors=${evalStats.errors} | replies=${replyStats.generated} ` +
        `replySkips=${replyStats.skipped} replyDefer=${replyStats.deferred} ` +
        `replyFail=${replyStats.failed} posted=${posterStats.posted}`,
    );
  }, STATS_LOG_MS);

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received — shutting down`);
    jetstream.stop();
    stopRehydration();
    stopEvaluation();
    stopReplies();
    stopPosting?.();
    clearInterval(categoryTimer);
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
