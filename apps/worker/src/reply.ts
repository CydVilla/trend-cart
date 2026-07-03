import { prisma, ReplyStatus, type CandidateEvaluation, type Post } from "@trendcart/db";
import { amazonSearchUrl, type LlmClient } from "@trendcart/shared";
import { config } from "./config.js";
import { isTransientError } from "./evaluate.js";
import { isPaused } from "./heartbeat.js";
import { validateReply } from "./validate.js";

const BATCH_SIZE = 5;
const GENERATION_BACKOFF_MS = 10 * 60_000;
let generationBackoffUntil = 0;
/** Statuses that count as "the bot engaged" for cooldowns/limits/dedupe. */
const ACTIVE_STATUSES = [
  ReplyStatus.DRY_RUN,
  ReplyStatus.PENDING_APPROVAL,
  ReplyStatus.APPROVED,
  ReplyStatus.POSTING,
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
 * defer = temporary (rate limit / cooldown window / missing page), retried
 *         next tick without writing a row
 */
type PolicyDecision =
  | { action: "proceed" }
  | { action: "skip"; reason: string }
  | { action: "defer"; reason: string };

async function checkReplyPolicy(post: Post, categorySlug: string | null): Promise<PolicyDecision> {
  const now = Date.now();

  if (post.deadAt) return { action: "skip", reason: "post was deleted" };

  // Replying to old posts reads as necro-spam. Operator-injected posts get a
  // longer window — a human explicitly chose them.
  const maxAgeHours = post.source === "MANUAL" ? 7 * 24 : 24;
  if (post.indexedAt.getTime() < now - maxAgeHours * 3_600_000) {
    return { action: "skip", reason: `candidate expired (post older than ${maxAgeHours}h)` };
  }

  // Consent revocation is permanent and checked before anything else social.
  const optOut = await prisma.authorOptOut.findUnique({ where: { did: post.authorDid } });
  if (optOut) return { action: "skip", reason: "author opted out" };

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
  if (categorySlug && config.bot.categoryCooldownMinutes > 0) {
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

type ReplyLink = {
  url: string;
  /** FTC-clear disclosure for direct Amazon links; pages carry it on-site. */
  suffix: string;
  categoryName: string | null;
  productNames: string[];
};

/**
 * Pick the single link a reply will carry: the curated recommendation page
 * when the category has one published, otherwise a tagged Amazon search for
 * the specific product the LLM identified (with in-reply disclosure).
 */
async function chooseLink(evaluation: CandidateEvaluation): Promise<ReplyLink | null> {
  if (evaluation.recommendedCategory) {
    const category = await prisma.productCategory.findUnique({
      where: { slug: evaluation.recommendedCategory },
      include: {
        recommendationPage: true,
        products: { where: { isActive: true }, take: 5 },
      },
    });
    if (category?.recommendationPage?.isPublished) {
      return {
        url: `${config.site.publicUrl}/recommendations/${category.recommendationPage.slug}`,
        suffix: "",
        categoryName: category.name,
        productNames: category.products.map((p) => p.name),
      };
    }
    // Category matched but has no published page — fall through to a direct
    // search if the evaluation carries one.
    if (evaluation.recommendedSearchQuery && config.site.amazonAssociateTag) {
      return {
        url: amazonSearchUrl(evaluation.recommendedSearchQuery, config.site.amazonAssociateTag),
        suffix: " (affiliate link)",
        categoryName: category?.name ?? null,
        productNames: [],
      };
    }
    return null; // wait for the page — defer, don't burn the candidate
  }
  if (evaluation.recommendedSearchQuery && config.site.amazonAssociateTag) {
    return {
      url: amazonSearchUrl(evaluation.recommendedSearchQuery, config.site.amazonAssociateTag),
      suffix: " (affiliate link)",
      categoryName: null,
      productNames: [],
    };
  }
  return null;
}

/**
 * One pass: take evaluations that cleared Phase 4's gates and have no reply
 * yet, run the anti-spam policy, generate + validate the reply, and store it
 * in the mode-appropriate status. Every permanent decision leaves a row.
 */
export async function generateDueReplies(llm: LlmClient, stats: ReplyStats): Promise<void> {
  if (await isPaused()) return;
  if (Date.now() < generationBackoffUntil) return;

  const due = await prisma.candidateEvaluation.findMany({
    where: {
      shouldReply: true,
      // ALLOWLIST the exact model tag this run produces — fake verdicts,
      // policy rows, legacy pre-migration "unknown" rows, and verdicts from
      // other model configurations can never drive this pipeline.
      model: config.llm.useFake ? "fake" : config.llm.model,
      post: { replies: { none: {} }, deadAt: null },
    },
    include: { post: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const evaluation of due) {
    // Policy runs FIRST so the 24h/7d expiry always writes a terminal SKIPPED
    // row — otherwise permanently-deferring candidates (e.g. a category whose
    // page never gets published) wedge the oldest-first queue forever.
    const policy = await checkReplyPolicy(evaluation.post, evaluation.recommendedCategory);
    if (policy.action === "skip") {
      await writeSkip(evaluation.postId, policy.reason, stats);
      continue;
    }
    if (policy.action === "defer") {
      stats.deferred += 1;
      continue; // no row — the next tick retries once the window frees up
    }

    const link = await chooseLink(evaluation);
    if (!link) {
      stats.deferred += 1; // "page not published yet" — bounded by the expiry skip above
      continue;
    }

    const replyInput = {
      postText: evaluation.post.text,
      categoryName: link.categoryName,
      suggestedReplyAngle: evaluation.suggestedReplyAngle,
      linkUrl: link.url,
      linkSuffix: link.suffix,
      productNames: link.productNames,
      maxLength: config.bot.replyMaxLength,
    };

    let text: string;
    try {
      text = await llm.generateReply(replyInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientError(error)) {
        // API outage: back off the whole loop, don't blame the candidate.
        generationBackoffUntil = Date.now() + GENERATION_BACKOFF_MS;
        console.error(`[reply] transient API error — backing off: ${message}`);
        return;
      }
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

    let validation = validateReply(text, link.url, config.bot.replyMaxLength);
    if (!validation.ok) {
      // One retry with a tighter budget — over-length is the common failure.
      try {
        const retryText = await llm.generateReply({
          ...replyInput,
          maxLength: config.bot.replyMaxLength - 30,
        });
        const retryValidation = validateReply(retryText, link.url, config.bot.replyMaxLength);
        if (retryValidation.ok) {
          text = retryText;
          validation = retryValidation;
        }
      } catch {
        // fall through to the FAILED row with the original validation reason
      }
    }
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
