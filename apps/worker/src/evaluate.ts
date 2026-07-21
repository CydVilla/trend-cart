import Anthropic from "@anthropic-ai/sdk";
import { prisma, SafetyStatus, type Prisma } from "@trendcart/db";
import type {
  AuthorProfileContext,
  CandidateEvaluationResult,
  CategoryContext,
  LlmClient,
} from "@trendcart/shared";
import { fetchTopComments } from "./comments.js";
import { config } from "./config.js";
import { findPromotionalMatch } from "./filters.js";
import { isPaused } from "./heartbeat.js";
import { getLearnedGuidelines, getOperatorGuidance } from "./reflect.js";

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

/** Optional threshold overrides for offline analysis (calibration sweeps).
 *  Omitted fields fall back to the live config — production callers pass none. */
export type GateThresholds = {
  minProductIntentScore?: number;
  minLinkConfidence?: number;
};

/**
 * Enforce business rules on top of whatever the LLM returned. The model's
 * shouldReply is advisory — every gate is re-checked here so a hallucinated
 * slug or inflated score can never cause a reply.
 */
export function applyGates(
  result: CandidateEvaluationResult,
  activeSlugs: Set<string>,
  thresholds?: GateThresholds,
): CandidateEvaluationResult {
  const minIntent = thresholds?.minProductIntentScore ?? config.bot.minProductIntentScore;
  const minLink = thresholds?.minLinkConfidence ?? config.bot.minLinkConfidence;
  const score = Math.min(100, Math.max(0, Math.round(result.productIntentScore)));
  const linkConfidence = Math.min(100, Math.max(0, Math.round(result.linkConfidence ?? 0)));
  const slug =
    result.recommendedCategorySlug && activeSlugs.has(result.recommendedCategorySlug)
      ? result.recommendedCategorySlug
      : null;
  const searchQuery = sanitizeSearchQuery(result.recommendedSearchQuery);
  /** A search query only counts as a link path when the model believes the
   *  Amazon results will actually be relevant (same product or franchise). */
  const confidentQuery = searchQuery !== null && linkConfidence >= minLink;

  const failedGates: string[] = [];
  if (result.safetyStatus !== "safe") failedGates.push(`safety=${result.safetyStatus}`);
  if (score < minIntent) {
    failedGates.push(`intent ${score} < ${minIntent}`);
  }
  if (!slug && !searchQuery) failedGates.push("no category and no search query");
  if (!slug && searchQuery && !confidentQuery) {
    failedGates.push(
      `link confidence ${linkConfidence} < ${minLink} and no category fallback`,
    );
  }
  if (!result.shouldReply) failedGates.push("llm declined");

  const shouldReply = failedGates.length === 0;
  return {
    productIntentScore: score,
    safetyStatus: result.safetyStatus,
    recommendedCategorySlug: slug,
    recommendedSearchQuery: searchQuery,
    linkConfidence,
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
  // MAX_LLM_EVALS_PER_HOUR is a COST cap, so only rows that actually spent an
  // LLM call count against it. "policy" rows (cheap pre-LLM rejections — half
  // of all evaluations) and "operator" directives (no LLM judgment) used to be
  // counted too, silently halving real LLM throughput and letting candidates
  // expire in the backlog while budget sat unused.
  const recentEvals = await prisma.candidateEvaluation.count({
    where: { createdAt: { gte: hourAgo }, model: { notIn: ["policy", "operator"] } },
  });
  const budget = config.llm.maxEvalsPerHour - recentEvals;

  const maturedBefore = new Date(now - config.llm.evalMinPostAgeMinutes * 60_000);
  const baseWhere = {
    safetyStatus: SafetyStatus.PENDING,
    deadAt: null,
    lastHydratedAt: { not: null },
    createdAt: { gte: new Date(now - 24 * 3_600_000) },
    evaluations: { none: {} },
  } as const;
  // Solicited/injected posts go FIRST and BYPASS the hourly eval budget: the
  // operator explicitly provided them (inject form / mention), their volume
  // is operator-bounded, and they must never starve behind trending posts
  // that already ate the budget. Trending only spends what budget remains.
  const solicited = await prisma.post.findMany({
    where: { ...baseWhere, source: { in: ["MANUAL", "MENTION"] } },
    orderBy: { indexedAt: "asc" },
    take: BATCH_SIZE,
  });
  const trendingTake = Math.max(
    0,
    Math.min(BATCH_SIZE - solicited.length, budget - solicited.length),
  );
  // Per-category floors: an operator-set ProductCategory.minEngagementScore
  // overrides the global floor for posts that category discovered (lower it
  // where good candidates expire waiting; raise it for noisy categories).
  // The SQL bound uses the most permissive active floor; each post is then
  // re-checked against ITS OWN categories' floor.
  const categoryRows = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: {
      slug: true,
      name: true,
      description: true,
      exampleProblems: true,
      minEngagementScore: true,
    },
  });
  const floorBySlug = new Map(
    categoryRows.map((c) => [c.slug, c.minEngagementScore ?? config.llm.minEngagementScore]),
  );
  const lowestFloor = Math.min(config.llm.minEngagementScore, ...floorBySlug.values());
  /** Effective floor for a post = the most permissive floor among its matched
   *  categories (global floor when nothing matched). */
  const floorFor = (detected: string[]): number => {
    const floors = detected
      .map((slug) => floorBySlug.get(slug))
      .filter((f): f is number => f !== undefined);
    return floors.length > 0 ? Math.min(...floors) : config.llm.minEngagementScore;
  };
  // Trending candidates must BOTH mature and clear the floor: recent AND
  // actually liked. Below-floor posts keep waiting (they may still be
  // rising) and expire unevaluated if they never catch on: zero LLM spend.
  // Reply-runway floor: a candidate expires 24h after the post; evaluating
  // one with under ~2h of runway is a paid classify on a near-guaranteed
  // expiry (the reply queue needs time too). Such posts age out unevaluated.
  const runwayCutoff = new Date(now - 22 * 3_600_000);
  const trendingRaw =
    trendingTake > 0
      ? await prisma.post.findMany({
          where: {
            ...baseWhere,
            indexedAt: { gte: runwayCutoff },
            OR: [
              // Search-discovered posts arrive already trending with real
              // counts — no maturation needed, floor re-checked.
              { source: "SEARCH", engagementScore: { gte: lowestFloor } },
              // Legacy firehose rows keep the original mature+floor rules.
              {
                source: "FIREHOSE",
                indexedAt: { lte: maturedBefore },
                engagementScore: { gte: lowestFloor },
              },
            ],
          },
          orderBy: { engagementScore: "desc" },
          take: trendingTake,
        })
      : [];
  // Posts below their own categories' floor stay PENDING (they may still be
  // rising) and expire unevaluated if they never catch on: zero LLM spend.
  // May under-fill a batch when floors diverge — the next tick catches up.
  const trending = trendingRaw.filter(
    (post) => post.engagementScore >= floorFor(post.detectedCategories),
  );
  const due = [...solicited, ...trending];
  if (due.length === 0) return;

  const categories: CategoryContext[] = categoryRows.map(
    ({ minEngagementScore: _floor, ...rest }) => rest,
  );
  const activeSlugs = new Set(categories.map((c) => c.slug));
  const modelTag = evaluationModelTag();
  // Loop-invariant context — one read per tick, not per candidate.
  const learnedGuidelines = config.llm.useFake ? null : await getLearnedGuidelines();
  const operatorGuidance = config.llm.useFake ? null : await getOperatorGuidance();

  /** Write a cheap pre-LLM rejection (model="policy") and mark the post done. */
  async function policySkip(postId: string, reason: string): Promise<void> {
    await prisma.$transaction([
      prisma.candidateEvaluation.create({
        data: {
          postId,
          rawInput: {} as Prisma.InputJsonValue,
          productIntentScore: 0,
          safetyDecision: SafetyStatus.UNCERTAIN,
          model: "policy",
          shouldReply: false,
          reason,
        },
      }),
      prisma.post.update({ where: { id: postId }, data: { safetyStatus: SafetyStatus.UNCERTAIN } }),
    ]);
  }

  for (const post of due) {
    // ── Doomed-candidate gates: outcomes already decided by reply policy, so
    // an LLM eval would be money spent on a guaranteed skip. The same checks
    // remain in checkReplyPolicy as defense-in-depth (state can change between
    // eval and reply); here they just run BEFORE the spend instead of after.
    // Opt-out is consent — unconditional, even for solicited/operator posts.
    const optOut = await prisma.authorOptOut.findUnique({ where: { did: post.authorDid } });
    if (optOut) {
      await policySkip(post.id, "author opted out (pre-eval)");
      continue;
    }
    // Author cooldown (48h) is longer than a post's reply window (24h): any
    // ACTIVE reply to this author newer than (post expiry − cooldown) makes a
    // reply mathematically impossible before expiry. Solicited posts are
    // cooldown-exempt at reply time, so they are exempt here too.
    if (post.source !== "MANUAL" && post.source !== "MENTION") {
      const expiryMs = post.indexedAt.getTime() + 24 * 3_600_000;
      const doomCutoff = new Date(expiryMs - config.bot.authorCooldownHours * 3_600_000);
      const blockingReply = await prisma.botReply.findFirst({
        where: {
          status: { in: ["DRY_RUN", "PENDING_APPROVAL", "APPROVED", "POSTING", "POSTED"] },
          createdAt: { gte: doomCutoff },
          post: { authorDid: post.authorDid },
        },
        select: { id: true },
      });
      if (blockingReply) {
        await policySkip(
          post.id,
          `author cooldown (${config.bot.authorCooldownHours}h) outlasts the candidate's reply window`,
        );
        continue;
      }
    }
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
    const effectiveFloor = floorFor(post.detectedCategories);
    if (
      (post.source === "FIREHOSE" || post.source === "SEARCH") &&
      !INTENT_MARKERS.test(post.text) &&
      post.engagementScore < effectiveFloor * config.llm.lowSignalMultiplier
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
            reason: `low signal: no intent markers and engagement ${post.engagementScore} < ${effectiveFloor * config.llm.lowSignalMultiplier}`,
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
    // Solicited posts are exempt — an operator injection or a mention must
    // ALWAYS evaluate, whatever the author's trending posts already spent.
    const authorEvals =
      post.source === "MANUAL" || post.source === "MENTION"
        ? 0
        : await prisma.candidateEvaluation.count({
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

    // Pair stored thumbnails with their alt text (arrays are index-aligned).
    const images = post.imageUrls.map((url, i) => ({
      url,
      alt: post.imageAlts[i]?.trim() || null,
    }));
    // Only spend a thread fetch when replies actually exist; free public read.
    const comments =
      config.llm.useFake || post.replyCount === 0 ? [] : await fetchTopComments(post.uri);

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
      images,
      comments,
      operatorNote: post.operatorNote,
      operatorGuidance,
      learnedGuidelines,
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
          linkConfidence: evaluation.linkConfidence,
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
