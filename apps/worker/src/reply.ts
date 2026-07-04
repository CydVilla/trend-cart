import { prisma, ReplyStatus, type CandidateEvaluation, type Post } from "@trendcart/db";
import { amazonSearchUrl, type LlmClient } from "@trendcart/shared";
import { config } from "./config.js";
import { isTransientError } from "./evaluate.js";
import { getOperatorFlags } from "./heartbeat.js";
import { getLearnedGuidelines, getOperatorGuidance } from "./reflect.js";
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
  /** Of `generated`: how many the bot self-approved (autonomous mode). */
  autoApproved: number;
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
  const solicited = post.source === "MENTION";

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
  // Direct requests are exempt: someone asking deserves an answer every time.
  if (!solicited) {
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
  // (Skipped for solicited requests: the asker chose the topic, not the bot.)
  if (!solicited && categorySlug && config.bot.categoryCooldownMinutes > 0) {
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

/**
 * Status for a freshly generated, validated reply — DRY_RUN is the master
 * switch. The operator's `autonomous` toggle self-approves only replies that
 * clear the HIGHER bars (intent + link confidence, or a human-made decision);
 * marginal ones still land in the manual queue for the operator.
 */
function statusFor(
  evaluation: CandidateEvaluation,
  link: ReplyLink,
  autonomous: boolean,
): { status: ReplyStatus; approvedAt: Date | null } {
  if (config.bot.dryRun || config.bot.replyMode === "dry_run") {
    return { status: ReplyStatus.DRY_RUN, approvedAt: null };
  }
  if (config.bot.replyMode === "auto") {
    return { status: ReplyStatus.APPROVED, approvedAt: new Date() };
  }
  if (autonomous) {
    const humanDecided = evaluation.model === "operator" || link.kind === "operator";
    const confident =
      evaluation.productIntentScore >= config.bot.autoMinIntentScore &&
      (link.kind !== "search" || evaluation.linkConfidence >= config.bot.autoMinLinkConfidence);
    if (humanDecided || confident) {
      return { status: ReplyStatus.APPROVED, approvedAt: new Date() };
    }
    return { status: ReplyStatus.PENDING_APPROVAL, approvedAt: null }; // escalate to the human
  }
  return { status: ReplyStatus.PENDING_APPROVAL, approvedAt: null };
}

type ReplyLink = {
  kind: "operator" | "search" | "category";
  url: string;
  /** Human-readable clickable text — the URL rides on it as a facet. */
  anchor: string;
  categoryName: string | null;
};

/** "hollow knight silksong nintendo switch" → "hollow knight silksong on Amazon" */
function searchAnchor(query: string): string {
  const short = query.split(/\s+/).slice(0, 4).join(" ");
  return `${short.length > 34 ? short.slice(0, 34).trimEnd() : short} on Amazon`;
}

/**
 * Deterministically trim an over-long reply body so `${body}… ${anchor}` fits
 * the length cap, cutting at a word boundary. The anchor (and its facet) are
 * always preserved — length is reserved for them first.
 */
export function truncateReplyToFit(body: string, anchor: string, maxLength: number): string {
  const clean = body
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Reserve room for a leading space, the ellipsis, and " " + anchor.
  const budget = maxLength - anchor.length - 2;
  if (budget <= 0) return `${anchor}`; // pathological; validator will reject
  if (clean.length <= budget) return `${clean} ${anchor}`;
  let cut = clean.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > budget * 0.6) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s.,;:!?—-]+$/, "").trimEnd();
  return `${cut}… ${anchor}`;
}

/**
 * Pick the single link a reply will carry, by priority:
 *  1. an operator-provided link (the human already decided),
 *  2. a tagged Amazon search for the SPECIFIC product the LLM identified —
 *     but only when its linkConfidence says the results will be relevant,
 *  3. a tagged Amazon search for the category name (generic product-type
 *     queries reliably land well; niche titles are the risky ones).
 * No link the bot isn't confident in ships: null = permanent skip.
 */
async function chooseLink(evaluation: CandidateEvaluation, post: Post): Promise<ReplyLink | null> {
  // No per-reply "(affiliate link)" suffix: the account bio discloses the
  // affiliate relationship, and the anchor text names Amazon explicitly.
  if (post.operatorLinkUrl) {
    return {
      kind: "operator",
      url: post.operatorLinkUrl,
      anchor: "this one on Amazon",
      categoryName: null,
    };
  }
  if (!config.site.amazonAssociateTag) return null;
  if (
    evaluation.recommendedSearchQuery &&
    evaluation.linkConfidence >= config.bot.minLinkConfidence
  ) {
    return {
      kind: "search",
      url: amazonSearchUrl(evaluation.recommendedSearchQuery, config.site.amazonAssociateTag),
      anchor: searchAnchor(evaluation.recommendedSearchQuery),
      categoryName: null,
    };
  }
  if (evaluation.recommendedCategory) {
    const category = await prisma.productCategory.findUnique({
      where: { slug: evaluation.recommendedCategory },
      select: { name: true },
    });
    if (category) {
      return {
        kind: "category",
        url: amazonSearchUrl(category.name.toLowerCase(), config.site.amazonAssociateTag),
        anchor: searchAnchor(category.name.toLowerCase()),
        categoryName: category.name,
      };
    }
  }
  return null;
}

/**
 * One pass: take evaluations that cleared Phase 4's gates and have no reply
 * yet, run the anti-spam policy, generate + validate the reply, and store it
 * in the mode-appropriate status. Every permanent decision leaves a row.
 */
export async function generateDueReplies(llm: LlmClient, stats: ReplyStats): Promise<void> {
  const flags = await getOperatorFlags();
  if (flags.paused) return;
  if (Date.now() < generationBackoffUntil) return;

  const due = await prisma.candidateEvaluation.findMany({
    where: {
      shouldReply: true,
      // ALLOWLIST: this run's model tag plus "operator" directives — fake
      // verdicts, policy rows, legacy "unknown" rows, and verdicts from other
      // model configurations can never drive this pipeline.
      model: { in: config.llm.useFake ? ["fake", "operator"] : [config.llm.model, "operator"] },
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

    const link = await chooseLink(evaluation, evaluation.post);
    if (!link) {
      // No link the bot is confident in — a reply that links to junk is worse
      // than silence. Permanent, auditable skip.
      await writeSkip(
        evaluation.postId,
        `no confident link (query confidence ${evaluation.linkConfidence}, category ${evaluation.recommendedCategory ?? "none"})`,
        stats,
      );
      continue;
    }

    // The display text ends with the clickable anchor; the URL itself is
    // attached as a facet at posting time, never shown raw.
    const reserved = link.anchor.length + 1;
    const compose = (text: string) => `${text} ${link.anchor}`;
    const replyInput = {
      postText: evaluation.post.text,
      categoryName: link.categoryName,
      suggestedReplyAngle: evaluation.suggestedReplyAngle,
      textBudget: config.bot.replyMaxLength - reserved,
      isDirectRequest: evaluation.post.source === "MENTION",
      operatorNote: evaluation.post.operatorNote,
      operatorGuidance: config.llm.useFake ? null : await getOperatorGuidance(),
      learnedGuidelines: config.llm.useFake ? null : await getLearnedGuidelines(),
    };

    let body: string;
    try {
      body = await llm.generateReply(replyInput);
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

    let text = compose(body);
    let validation = validateReply(text, link.anchor, config.bot.replyMaxLength);
    if (!validation.ok) {
      // One retry with a tighter budget — over-length is the common failure.
      try {
        const retryBody = await llm.generateReply({
          ...replyInput,
          textBudget: replyInput.textBudget - 30,
        });
        const retryText = compose(retryBody);
        const retryValidation = validateReply(retryText, link.anchor, config.bot.replyMaxLength);
        if (retryValidation.ok) {
          text = retryText;
          validation = retryValidation;
        } else {
          body = retryBody; // shorter body is the better base for truncation
        }
      } catch {
        // fall through to the truncation fallback / FAILED row
      }
    }
    // Length-only safety net: the model overshot its word budget twice. Rather
    // than discard a good candidate, truncate the body at a word boundary so a
    // valid reply still goes out. Only rescues length failures — a banned
    // phrase or stray URL still (correctly) fails below.
    if (!validation.ok && validation.reason.startsWith("too long")) {
      const truncated = truncateReplyToFit(body, link.anchor, config.bot.replyMaxLength);
      const truncatedValidation = validateReply(truncated, link.anchor, config.bot.replyMaxLength);
      if (truncatedValidation.ok) {
        text = truncated;
        validation = truncatedValidation;
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

    const { status, approvedAt } = statusFor(evaluation, link, flags.autonomous);
    await prisma.botReply.create({
      data: {
        postId: evaluation.postId,
        replyText: text,
        linkUrl: link.url,
        linkAnchor: link.anchor,
        status,
        approvedAt,
      },
    });
    stats.generated += 1;
    if (status === ReplyStatus.APPROVED && flags.autonomous) stats.autoApproved += 1;
  }
}
