import type { PrismaClient } from "@prisma/client";

/**
 * Funnel analytics for the autonomous pipeline: where candidates are lost
 * between discovery and a posted reply. Computed from the DB so both the
 * dashboard (live view) and the worker's insights job (daily LLM report) read
 * the exact same numbers.
 */

export type CategoryStat = { category: string; wouldReply: number; posted: number };

export type FunnelReport = {
  /** MIN_ENGAGEMENT_SCORE at compute time (the floor most candidates die at). */
  floor: number;
  /** Optional trailing window in days; omitted = all-time. */
  windowDays: number | null;
  candidates: {
    total: number;
    evaluated: number;
    /** Unevaluated because engagement never reached the floor. */
    belowFloor: number;
    /** Unevaluated but above floor — in flight or awaiting the eval budget. */
    aboveFloorPending: number;
    /** Deleted from the network after discovery. */
    dead: number;
  };
  evaluations: {
    total: number;
    /** Rejected by cheap server-side gates before any LLM spend. */
    policyGated: number;
    /** Reached the LLM (incl. operator directives). */
    llmEvaluated: number;
    wouldReply: number;
  };
  replies: {
    posted: number;
    pendingApproval: number;
    skipped: number;
    failed: number;
    dryRun: number;
  };
  skipReasons: { reason: string; count: number }[];
  categories: CategoryStat[];
  engagement: { postedCount: number; likes: number; replies: number; reposts: number; quotes: number };
  /** Post-hoc operator verdicts on POSTED replies (autonomous feedback loop). */
  operatorRatings: { up: number; down: number; withFeedback: number };
};

/** Normalize a skip reason to its stable prefix (drops the variable tail). */
function normalizeSkip(reason: string | null): string {
  if (!reason) return "other";
  return reason
    .replace(/\(\d+h\)/g, "")
    .replace(/older than \d+h/g, "expired")
    .replace(/query confidence \d+.*$/g, "no confident link")
    .trim();
}

export async function computeFunnel(
  prisma: PrismaClient,
  opts: { floor?: number; windowDays?: number | null } = {},
): Promise<FunnelReport> {
  const floor = opts.floor ?? 10;
  const windowDays = opts.windowDays ?? null;
  const since = windowDays ? new Date(Date.now() - windowDays * 24 * 3_600_000) : null;
  const postWhen = since ? { createdAt: { gte: since } } : {};
  const evalWhen = since ? { createdAt: { gte: since } } : {};
  const replyWhen = since ? { createdAt: { gte: since } } : {};

  // Batched (not one big Promise.all) to stay well under the DB connection cap,
  // which is shared with the running worker on small hosted plans.
  const [total, evaluated, belowFloor, aboveFloorPending] = await Promise.all([
    prisma.post.count({ where: postWhen }),
    prisma.post.count({ where: { ...postWhen, evaluations: { some: {} } } }),
    prisma.post.count({
      where: { ...postWhen, safetyStatus: "PENDING", evaluations: { none: {} }, engagementScore: { lt: floor } },
    }),
    prisma.post.count({
      where: { ...postWhen, safetyStatus: "PENDING", evaluations: { none: {} }, engagementScore: { gte: floor } },
    }),
  ]);
  const [dead, evalTotal, policyGated, wouldReply] = await Promise.all([
    prisma.post.count({ where: { ...postWhen, deadAt: { not: null } } }),
    prisma.candidateEvaluation.count({ where: evalWhen }),
    prisma.candidateEvaluation.count({ where: { ...evalWhen, model: "policy" } }),
    prisma.candidateEvaluation.count({ where: { ...evalWhen, shouldReply: true } }),
  ]);
  const [replyGroups, skips, catWould] = await Promise.all([
    prisma.botReply.groupBy({ by: ["status"], _count: true, where: replyWhen }),
    prisma.botReply.findMany({ where: { ...replyWhen, status: "SKIPPED" }, select: { skipReason: true } }),
    prisma.candidateEvaluation.groupBy({
      by: ["recommendedCategory"],
      _count: true,
      where: { ...evalWhen, shouldReply: true },
    }),
  ]);
  const [postedReplies, engagementAgg, ratedUp, ratedDown, ratedWithFeedback] = await Promise.all([
    prisma.botReply.findMany({
      where: { ...replyWhen, status: "POSTED" },
      select: { post: { select: { evaluations: { where: { shouldReply: true }, select: { recommendedCategory: true }, take: 1 } } } },
    }),
    prisma.botReply.aggregate({
      where: { ...replyWhen, status: "POSTED" },
      _sum: {
        replyLikeCount: true,
        replyReplyCount: true,
        replyRepostCount: true,
        replyQuoteCount: true,
      },
      _count: true,
    }),
    prisma.botReply.count({ where: { ...replyWhen, operatorRating: "up" } }),
    prisma.botReply.count({ where: { ...replyWhen, operatorRating: "down" } }),
    prisma.botReply.count({ where: { ...replyWhen, operatorFeedback: { not: null } } }),
  ]);

  const replyCount = (status: string): number =>
    replyGroups.find((r) => r.status === status)?._count ?? 0;

  const skipTally = new Map<string, number>();
  for (const s of skips) {
    const key = normalizeSkip(s.skipReason);
    skipTally.set(key, (skipTally.get(key) ?? 0) + 1);
  }

  // Merge would-reply and posted counts per category.
  const catMap = new Map<string, CategoryStat>();
  for (const c of catWould) {
    const key = c.recommendedCategory ?? "(specific-product search)";
    catMap.set(key, { category: key, wouldReply: c._count, posted: 0 });
  }
  for (const r of postedReplies) {
    const key = r.post.evaluations[0]?.recommendedCategory ?? "(specific-product search)";
    const stat = catMap.get(key) ?? { category: key, wouldReply: 0, posted: 0 };
    stat.posted += 1;
    catMap.set(key, stat);
  }

  return {
    floor,
    windowDays,
    candidates: { total, evaluated, belowFloor, aboveFloorPending, dead },
    evaluations: {
      total: evalTotal,
      policyGated,
      llmEvaluated: evalTotal - policyGated,
      wouldReply,
    },
    replies: {
      posted: replyCount("POSTED"),
      pendingApproval: replyCount("PENDING_APPROVAL"),
      skipped: replyCount("SKIPPED"),
      failed: replyCount("FAILED"),
      dryRun: replyCount("DRY_RUN"),
    },
    skipReasons: [...skipTally.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    categories: [...catMap.values()].sort((a, b) => b.wouldReply - a.wouldReply),
    engagement: {
      postedCount: engagementAgg._count,
      likes: engagementAgg._sum.replyLikeCount ?? 0,
      replies: engagementAgg._sum.replyReplyCount ?? 0,
      reposts: engagementAgg._sum.replyRepostCount ?? 0,
      quotes: engagementAgg._sum.replyQuoteCount ?? 0,
    },
    operatorRatings: { up: ratedUp, down: ratedDown, withFeedback: ratedWithFeedback },
  };
}
