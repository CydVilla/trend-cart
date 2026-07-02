import { prisma, ReplyStatus, type Post } from "@trendcart/db";
import type { LlmClient } from "@trendcart/shared";
import { config } from "./config.js";
import { validateReply } from "./validate.js";

const TICK_MS = 60_000;
const BATCH_SIZE = 5;
/** Statuses that count as "the bot engaged" for cooldowns/limits/dedupe. */
const ACTIVE_STATUSES = [
  ReplyStatus.DRY_RUN,
  ReplyStatus.PENDING_APPROVAL,
  ReplyStatus.APPROVED,
  ReplyStatus.POSTED,
];

export type ReplyStats = {
  generated: number;
  skipped: number;
  deferred: number;
  failed: number;
};

/**
 * skip  = permanent, recorded as a SKIPPED row (auditable, never retried)
 * defer = temporary (rate limit / cooldown window), retried next tick
 */
type PolicyDecision =
  | { action: "proceed" }
  | { action: "skip"; reason: string }
  | { action: "defer"; reason: string };

async function checkReplyPolicy(post: Post, categorySlug: string): Promise<PolicyDecision> {
  const now = Date.now();

  // Replying to old posts reads as necro-spam, even when the match is good.
  if (post.indexedAt.getTime() < now - 24 * 3_600_000) {
    return { action: "skip", reason: "candidate expired (post older than 24h)" };
  }

  // Per-author cooldown — never reply to the same person twice in the window.
  const authorCutoff = new Date(now - config.bot.authorCooldownHours * 3_600_000);
  const authorReply = await prisma.botReply.findFirst({
    where: {
      status: { in: ACTIVE_STATUSES },
      createdAt: { gte: authorCutoff },
      post: { authorDid: post.authorDid },
    },
    select: { id: true },
  });
  if (authorReply) {
    return { action: "skip", reason: `author cooldown (${config.bot.authorCooldownHours}h)` };
  }

  // Hourly/daily caps.
  const hourCount = await prisma.botReply.count({
    where: { status: { in: ACTIVE_STATUSES }, createdAt: { gte: new Date(now - 3_600_000) } },
  });
  if (hourCount >= config.bot.maxRepliesPerHour) {
    return { action: "defer", reason: "hourly reply limit reached" };
  }
  const dayCount = await prisma.botReply.count({
    where: { status: { in: ACTIVE_STATUSES }, createdAt: { gte: new Date(now - 24 * 3_600_000) } },
  });
  if (dayCount >= config.bot.maxRepliesPerDay) {
    return { action: "defer", reason: "daily reply limit reached" };
  }

  // Global cooldown — minimum gap between any two replies.
  if (config.bot.globalReplyCooldownMinutes > 0) {
    const lastReply = await prisma.botReply.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      lastReply &&
      lastReply.createdAt.getTime() > now - config.bot.globalReplyCooldownMinutes * 60_000
    ) {
      return { action: "defer", reason: "global reply cooldown" };
    }
  }

  // Per-category cooldown — don't recommend the same category twice in a row.
  if (config.bot.categoryCooldownMinutes > 0) {
    const categoryCutoff = new Date(now - config.bot.categoryCooldownMinutes * 60_000);
    const recentInCategory = await prisma.botReply.findFirst({
      where: {
        status: { in: ACTIVE_STATUSES },
        createdAt: { gte: categoryCutoff },
        post: {
          evaluations: { some: { recommendedCategory: categorySlug, shouldReply: true } },
        },
      },
      select: { id: true },
    });
    if (recentInCategory) return { action: "defer", reason: "category cooldown" };
  }

  return { action: "proceed" };
}

async function writeSkip(
  postId: string,
  reason: string,
  stats: ReplyStats,
  replyText = "",
): Promise<void> {
  await prisma.botReply.create({
    data: { postId, replyText, status: ReplyStatus.SKIPPED, skipReason: reason },
  });
  stats.skipped += 1;
}

/** Status for a freshly generated, validated reply — DRY_RUN is the master switch. */
function initialStatus(): ReplyStatus {
  if (config.bot.dryRun || config.bot.replyMode === "dry_run") return ReplyStatus.DRY_RUN;
  if (config.bot.replyMode === "manual") return ReplyStatus.PENDING_APPROVAL;
  return ReplyStatus.APPROVED; // auto mode — posting loop picks it up
}

/**
 * One pass: take evaluations that cleared Phase 4's gates and have no reply
 * yet, run the anti-spam policy, generate + validate the reply, and store it
 * in the mode-appropriate status. Every permanent decision leaves a row.
 */
export async function generateDueReplies(llm: LlmClient, stats: ReplyStats): Promise<void> {
  const due = await prisma.candidateEvaluation.findMany({
    where: { shouldReply: true, post: { replies: { none: {} } } },
    include: { post: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const evaluation of due) {
    const slug = evaluation.recommendedCategory;
    if (!slug) {
      await writeSkip(evaluation.postId, "evaluation has no category", stats);
      continue;
    }

    const category = await prisma.productCategory.findUnique({
      where: { slug },
      include: {
        recommendationPage: true,
        products: { where: { isActive: true }, take: 5 },
      },
    });
    const page = category?.recommendationPage;
    if (!category || !page?.isPublished) {
      await writeSkip(evaluation.postId, `no published recommendation page for ${slug}`, stats);
      continue;
    }

    const policy = await checkReplyPolicy(evaluation.post, slug);
    if (policy.action === "skip") {
      await writeSkip(evaluation.postId, policy.reason, stats);
      continue;
    }
    if (policy.action === "defer") {
      stats.deferred += 1;
      continue; // no row — the next tick retries once the window frees up
    }

    const pageUrl = `${config.site.publicUrl}/recommendations/${page.slug}`;
    let text: string;
    try {
      text = await llm.generateReply({
        postText: evaluation.post.text,
        categoryName: category.name,
        suggestedReplyAngle: evaluation.suggestedReplyAngle,
        recommendationPageUrl: pageUrl,
        productNames: category.products.map((p) => p.name),
        maxLength: config.bot.replyMaxLength,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.botReply.create({
        data: {
          postId: evaluation.postId,
          replyText: "",
          status: ReplyStatus.FAILED,
          skipReason: `generation failed: ${message}`,
        },
      });
      stats.failed += 1;
      continue;
    }

    const validation = validateReply(text, pageUrl, config.bot.replyMaxLength);
    if (!validation.ok) {
      await prisma.botReply.create({
        data: {
          postId: evaluation.postId,
          replyText: text,
          status: ReplyStatus.FAILED,
          skipReason: `validation failed: ${validation.reason}`,
        },
      });
      stats.failed += 1;
      continue;
    }

    // Never send the exact same reply text twice in a week.
    const duplicate = await prisma.botReply.findFirst({
      where: {
        replyText: text,
        status: { in: ACTIVE_STATUSES },
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) },
      },
      select: { id: true },
    });
    if (duplicate) {
      await writeSkip(evaluation.postId, "duplicate reply text (used recently)", stats, text);
      continue;
    }

    await prisma.botReply.create({
      data: { postId: evaluation.postId, replyText: text, status: initialStatus() },
    });
    stats.generated += 1;
  }
}

/** Starts the loop; returns a stop function. */
export function startReplyLoop(llm: LlmClient, stats: ReplyStats): () => void {
  const run = (): void => {
    generateDueReplies(llm, stats).catch((error) => {
      console.error("[reply] tick failed:", error instanceof Error ? error.message : error);
    });
  };
  run();
  const timer = setInterval(run, TICK_MS);
  return () => clearInterval(timer);
}
