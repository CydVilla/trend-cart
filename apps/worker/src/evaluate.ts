import Anthropic from "@anthropic-ai/sdk";
import { prisma, SafetyStatus, type Prisma } from "@trendcart/db";
import type {
  AuthorProfileContext,
  CandidateEvaluationResult,
  CategoryContext,
  LlmClient,
} from "@trendcart/shared";
import { config } from "./config.js";
import { findPromotionalMatch } from "./filters.js";
import { isPaused } from "./heartbeat.js";

const BATCH_SIZE = 3;
/** Give up on a post after this many CONTENT-level LLM failures. */
const MAX_FAILURES_PER_POST = 3;
/** Back off the whole loop on transient API errors (auth/rate/network). */
const TRANSIENT_BACKOFF_MS = 10 * 60_000;
/** Max evaluations per author per day — spam floods can't eat the budget. */
const MAX_EVALS_PER_AUTHOR_PER_DAY = 2;

const GETPROFILE_URL = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile";

/** Cheap "is this post actually asking for something" heuristic. */
const INTENT_MARKERS =
  /\?|recommend|\brecs?\b|suggest|any good|looking for|which (one|should)|help( me)?\b|advice|worth (it|buying)|should i (get|buy)|need a\b|in the market for/i;

export type EvaluateStats = {
  evaluated: number;
  wouldReply: number;
  rejected: number;
  errors: number;
};

const SAFETY_MAP: Record<CandidateEvaluationResult["safetyStatus"], SafetyStatus> = {
  safe: SafetyStatus.SAFE,
  unsafe: SafetyStatus.UNSAFE,
  uncertain: SafetyStatus.UNCERTAIN,
};

/** The model tag this run stamps on evaluations (reply loop matches on it). */
export function evaluationModelTag(): string {
  return config.llm.useFake ? "fake" : config.llm.model;
}

/** Short, URL-free, single-line search query — never trust the model blindly. */
function sanitizeSearchQuery(query: string | null): string | null {
  if (!query) return null;
  const cleaned = query
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\n\r#@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned.slice(0, 60);
}

/**
 * Enforce business rules on top of whatever the LLM returned. The model's
 * shouldReply is advisory — every gate is re-checked here so a hallucinated
 * slug or inflated score can never cause a reply.
 */
export function applyGates(
  result: CandidateEvaluationResult,
  activeSlugs: Set<string>,
): CandidateEvaluationResult {
  const score = Math.min(100, Math.max(0, Math.round(result.productIntentScore)));
  const slug =
    result.recommendedCategorySlug && activeSlugs.has(result.recommendedCategorySlug)
      ? result.recommendedCategorySlug
      : null;
  const searchQuery = sanitizeSearchQuery(result.recommendedSearchQuery);

  const failedGates: string[] = [];
  if (result.safetyStatus !== "safe") failedGates.push(`safety=${result.safetyStatus}`);
  if (score < config.bot.minProductIntentScore) {
    failedGates.push(`intent ${score} < ${config.bot.minProductIntentScore}`);
  }
  if (!slug && !searchQuery) failedGates.push("no category and no search query");
  if (!result.shouldReply) failedGates.push("llm declined");

  const shouldReply = failedGates.length === 0;
  return {
    productIntentScore: score,
    safetyStatus: result.safetyStatus,
    recommendedCategorySlug: slug,
    recommendedSearchQuery: searchQuery,
    suggestedNewCategory: result.suggestedNewCategory,
    shouldReply,
    reason: shouldReply ? result.reason : `${result.reason} [gates: ${failedGates.join("; ")}]`,
    suggestedReplyAngle: shouldReply ? result.suggestedReplyAngle : null,
  };
}

async function fetchAuthorProfile(did: string): Promise<AuthorProfileContext> {
  try {
    const url = new URL(GETPROFILE_URL);
    url.searchParams.set("actor", did);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const p = (await response.json()) as {
      followersCount?: number;
      followsCount?: number;
      postsCount?: number;
      description?: string;
      createdAt?: string;
    };
    return {
      followers: p.followersCount ?? 0,
      follows: p.followsCount ?? 0,
      posts: p.postsCount ?? 0,
      bio: (p.description ?? "").slice(0, 500),
      accountAgeDays: p.createdAt
        ? Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86_400_000)
        : null,
    };
  } catch {
    return null; // enrichment is best-effort, never blocks evaluation
  }
}

/** True for API-level failures that should pause the loop, not blame the post. */
export function isTransientError(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  );
}

const failureCounts = new Map<string, number>();
let backoffUntil = 0;

async function recordFailedEvaluation(postId: string, message: string): Promise<void> {
  await prisma.$transaction([
    prisma.candidateEvaluation.create({
      data: {
        postId,
        rawInput: { error: true } as Prisma.InputJsonValue,
        llmOutput: undefined,
        productIntentScore: 0,
        safetyDecision: SafetyStatus.UNCERTAIN,
        recommendedCategory: null,
        model: "policy",
        shouldReply: false,
        reason: `evaluation failed after ${MAX_FAILURES_PER_POST} attempts: ${message}`,
        suggestedReplyAngle: null,
      },
    }),
    prisma.post.update({
      where: { id: postId },
      data: { safetyStatus: SafetyStatus.UNCERTAIN },
    }),
  ]);
  failureCounts.delete(postId);
}

/**
 * One evaluation pass: pick the highest-engagement matured candidates,
 * enrich with the author's public profile, classify, gate, persist.
 * Firehose posts wait EVAL_MIN_POST_AGE_MINUTES so the engagement snapshot
 * means something; manually injected posts evaluate immediately.
 */
export async function evaluateDueCandidates(llm: LlmClient, stats: EvaluateStats): Promise<void> {
  if (Date.now() < backoffUntil) return;
  if (await isPaused()) return;

  const now = Date.now();
  const hourAgo = new Date(now - 3_600_000);
  const recentEvals = await prisma.candidateEvaluation.count({
    where: { createdAt: { gte: hourAgo } },
  });
  const budget = config.llm.maxEvalsPerHour - recentEvals;
  if (budget <= 0) return;

  const maturedBefore = new Date(now - config.llm.evalMinPostAgeMinutes * 60_000);
  const baseWhere = {
    safetyStatus: SafetyStatus.PENDING,
    deadAt: null,
    lastHydratedAt: { not: null },
    createdAt: { gte: new Date(now - 24 * 3_600_000) },
    evaluations: { none: {} },
  } as const;
  const batchLimit = Math.min(BATCH_SIZE, budget);
  // Solicited/injected posts go FIRST (a low-engagement mention must never
  // starve behind trending firehose posts), then trending candidates —
  // which must BOTH mature and clear the floor: recent AND actually liked.
  // Below-floor posts keep waiting (they may still be rising) and expire
  // unevaluated if they never catch on: zero LLM spend.
  const solicited = await prisma.post.findMany({
    where: { ...baseWhere, source: { in: ["MANUAL", "MENTION"] } },
    orderBy: { indexedAt: "asc" },
    take: batchLimit,
  });
  const trending =
    solicited.length < batchLimit
      ? await prisma.post.findMany({
          where: {
            ...baseWhere,
            OR: [
              // Search-discovered posts arrive already trending with real
              // counts — no maturation needed, floor re-checked.
              { source: "SEARCH", engagementScore: { gte: config.llm.minEngagementScore } },
              // Legacy firehose rows keep the original mature+floor rules.
              {
                source: "FIREHOSE",
                indexedAt: { lte: maturedBefore },
                engagementScore: { gte: config.llm.minEngagementScore },
              },
            ],
          },
          orderBy: { engagementScore: "desc" },
          take: batchLimit - solicited.length,
        })
      : [];
  const due = [...solicited, ...trending];
  if (due.length === 0) return;

  const categories: CategoryContext[] = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: { slug: true, name: true, description: true, exampleProblems: true },
  });
  const activeSlugs = new Set(categories.map((c) => c.slug));
  const modelTag = evaluationModelTag();

  for (const post of due) {
    // Operator link override: the human already decided this post gets a
    // reply with a specific link — no LLM judgment needed, just generation.
    if (post.operatorLinkUrl) {
      await prisma.$transaction([
        prisma.candidateEvaluation.create({
          data: {
            postId: post.id,
            rawInput: { operatorNote: post.operatorNote } as Prisma.InputJsonValue,
            productIntentScore: 100,
            safetyDecision: SafetyStatus.SAFE,
            // "operator" survives model switches — the reply pipeline
            // allowlists it alongside the current model tag.
            model: "operator",
            shouldReply: true,
            reason: "operator directive (link provided)",
            suggestedReplyAngle: post.operatorNote,
          },
        }),
        prisma.post.update({
          where: { id: post.id },
          data: { productIntentScore: 100, safetyStatus: SafetyStatus.SAFE },
        }),
      ]);
      stats.evaluated += 1;
      stats.wouldReply += 1;
      continue;
    }

    // Low-signal gate: a firehose STATEMENT (no question / no ask) must show
    // outsized engagement to justify LLM spend; posts actually asking for
    // recommendations evaluate at the normal floor. Solicited and injected
    // posts never hit this.
    if (
      (post.source === "FIREHOSE" || post.source === "SEARCH") &&
      !INTENT_MARKERS.test(post.text) &&
      post.engagementScore < config.llm.minEngagementScore * 3
    ) {
      await prisma.$transaction([
        prisma.candidateEvaluation.create({
          data: {
            postId: post.id,
            rawInput: {} as Prisma.InputJsonValue,
            productIntentScore: 0,
            safetyDecision: SafetyStatus.UNCERTAIN,
            model: "policy",
            shouldReply: false,
            reason: `low signal: no intent markers and engagement ${post.engagementScore} < ${config.llm.minEngagementScore * 3}`,
          },
        }),
        prisma.post.update({
          where: { id: post.id },
          data: { safetyStatus: SafetyStatus.UNCERTAIN },
        }),
      ]);
      continue;
    }

    // Per-author fairness: one prolific account can't monopolize the budget.
    const authorEvals = await prisma.candidateEvaluation.count({
      where: {
        createdAt: { gte: new Date(now - 24 * 3_600_000) },
        post: { authorDid: post.authorDid },
      },
    });
    if (authorEvals >= MAX_EVALS_PER_AUTHOR_PER_DAY) {
      await prisma.$transaction([
        prisma.candidateEvaluation.create({
          data: {
            postId: post.id,
            rawInput: {} as Prisma.InputJsonValue,
            productIntentScore: 0,
            safetyDecision: SafetyStatus.UNCERTAIN,
            model: "policy",
            shouldReply: false,
            reason: `per-author evaluation cap (${MAX_EVALS_PER_AUTHOR_PER_DAY}/24h)`,
          },
        }),
        prisma.post.update({
          where: { id: post.id },
          data: { safetyStatus: SafetyStatus.UNCERTAIN },
        }),
      ]);
      continue;
    }

    const authorProfile = config.llm.useFake ? null : await fetchAuthorProfile(post.authorDid);

    // Sellers advertise in their bios. A promotional author bio disqualifies
    // the post before any LLM spend — the bot only engages with real people.
    if (authorProfile && findPromotionalMatch(authorProfile.bio)) {
      await prisma.$transaction([
        prisma.candidateEvaluation.create({
          data: {
            postId: post.id,
            rawInput: { authorBio: authorProfile.bio } as Prisma.InputJsonValue,
            productIntentScore: 0,
            safetyDecision: SafetyStatus.UNCERTAIN,
            model: "policy",
            shouldReply: false,
            reason: "author bio looks promotional (deal/affiliate account)",
          },
        }),
        prisma.post.update({
          where: { id: post.id },
          data: { safetyStatus: SafetyStatus.UNCERTAIN },
        }),
      ]);
      continue;
    }

    const input = {
      postText: post.text,
      authorHandle: post.authorHandle,
      categories,
      keywordMatches: post.detectedCategories,
      engagement: {
        likeCount: post.likeCount,
        repostCount: post.repostCount,
        replyCount: post.replyCount,
        quoteCount: post.quoteCount,
      },
      postAgeMinutes: (now - post.indexedAt.getTime()) / 60_000,
      authorProfile,
      isDirectRequest: post.source === "MENTION",
      threadContext: post.contextText,
      operatorNote: post.operatorNote,
    };

    let raw: CandidateEvaluationResult;
    try {
      raw = await llm.classifyPost(input);
    } catch (error) {
      stats.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientError(error)) {
        backoffUntil = Date.now() + TRANSIENT_BACKOFF_MS;
        console.error(
          `[evaluate] transient API error — pausing evaluation ${TRANSIENT_BACKOFF_MS / 60000}m ` +
            `(post not blamed): ${message}`,
        );
        return; // whole tick backs off; the post stays PENDING for retry
      }
      const failures = (failureCounts.get(post.id) ?? 0) + 1;
      failureCounts.set(post.id, failures);
      console.error(`[evaluate] LLM failed for ${post.uri} (attempt ${failures}): ${message}`);
      if (failures >= MAX_FAILURES_PER_POST) {
        await recordFailedEvaluation(post.id, message);
      }
      continue;
    }

    // Operator note is intent: if the LLM approved but gave no angle, the
    // note itself is the angle the reply should take.
    if (post.operatorNote && raw.shouldReply && !raw.suggestedReplyAngle) {
      raw.suggestedReplyAngle = post.operatorNote;
    }
    const evaluation = applyGates(raw, activeSlugs);
    await prisma.$transaction([
      prisma.candidateEvaluation.create({
        data: {
          postId: post.id,
          rawInput: input as unknown as Prisma.InputJsonValue,
          llmOutput: raw as unknown as Prisma.InputJsonValue,
          productIntentScore: evaluation.productIntentScore,
          safetyDecision: SAFETY_MAP[evaluation.safetyStatus],
          recommendedCategory: evaluation.recommendedCategorySlug,
          recommendedSearchQuery: evaluation.recommendedSearchQuery,
          suggestedNewCategory: evaluation.suggestedNewCategory,
          model: modelTag,
          shouldReply: evaluation.shouldReply,
          reason: evaluation.reason,
          suggestedReplyAngle: evaluation.suggestedReplyAngle,
        },
      }),
      prisma.post.update({
        where: { id: post.id },
        data: {
          productIntentScore: evaluation.productIntentScore,
          safetyStatus: SAFETY_MAP[evaluation.safetyStatus],
        },
      }),
    ]);

    stats.evaluated += 1;
    if (evaluation.shouldReply) stats.wouldReply += 1;
    else stats.rejected += 1;
  }
}
