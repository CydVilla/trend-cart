import { prisma, SafetyStatus, type Prisma } from "@trendcart/db";
import type { CandidateEvaluationResult, CategoryContext, LlmClient } from "@trendcart/shared";
import { config } from "./config.js";

const TICK_MS = 60_000;
const BATCH_SIZE = 3;
/** Give up on a post after this many failed LLM calls (poison-pill guard). */
const MAX_FAILURES_PER_POST = 3;

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

  const failedGates: string[] = [];
  if (result.safetyStatus !== "safe") failedGates.push(`safety=${result.safetyStatus}`);
  if (score < config.bot.minProductIntentScore) {
    failedGates.push(`intent ${score} < ${config.bot.minProductIntentScore}`);
  }
  if (!slug) failedGates.push("no active category");
  if (!result.shouldReply) failedGates.push("llm declined");

  const shouldReply = failedGates.length === 0;
  return {
    productIntentScore: score,
    safetyStatus: result.safetyStatus,
    recommendedCategorySlug: slug,
    shouldReply,
    reason: shouldReply ? result.reason : `${result.reason} [gates: ${failedGates.join("; ")}]`,
    suggestedReplyAngle: shouldReply ? result.suggestedReplyAngle : null,
  };
}

const failureCounts = new Map<string, number>();

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
 * One evaluation pass: pick the highest-engagement unevaluated candidates
 * (hydrated at least once, < 24h old), classify them, and persist the
 * decision. Respects the hourly LLM budget.
 */
export async function evaluateDueCandidates(llm: LlmClient, stats: EvaluateStats): Promise<void> {
  const hourAgo = new Date(Date.now() - 3_600_000);
  const recentEvals = await prisma.candidateEvaluation.count({
    where: { createdAt: { gte: hourAgo } },
  });
  const budget = config.llm.maxEvalsPerHour - recentEvals;
  if (budget <= 0) return;

  const due = await prisma.post.findMany({
    where: {
      safetyStatus: SafetyStatus.PENDING,
      lastHydratedAt: { not: null },
      createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      evaluations: { none: {} },
    },
    orderBy: { engagementScore: "desc" },
    take: Math.min(BATCH_SIZE, budget),
  });
  if (due.length === 0) return;

  const categories: CategoryContext[] = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: { slug: true, name: true, description: true, exampleProblems: true },
  });
  const activeSlugs = new Set(categories.map((c) => c.slug));

  for (const post of due) {
    const input = {
      postText: post.text,
      authorHandle: post.authorHandle,
      categories,
      keywordMatches: post.detectedCategories,
    };

    let raw: CandidateEvaluationResult;
    try {
      raw = await llm.classifyPost(input);
    } catch (error) {
      stats.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      const failures = (failureCounts.get(post.id) ?? 0) + 1;
      failureCounts.set(post.id, failures);
      console.error(`[evaluate] LLM failed for ${post.uri} (attempt ${failures}): ${message}`);
      if (failures >= MAX_FAILURES_PER_POST) {
        await recordFailedEvaluation(post.id, message);
      }
      continue;
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

/** Starts the loop; returns a stop function. */
export function startEvaluationLoop(llm: LlmClient, stats: EvaluateStats): () => void {
  const run = (): void => {
    evaluateDueCandidates(llm, stats).catch((error) => {
      stats.errors += 1;
      console.error("[evaluate] tick failed:", error instanceof Error ? error.message : error);
    });
  };
  run();
  const timer = setInterval(run, TICK_MS);
  return () => clearInterval(timer);
}
