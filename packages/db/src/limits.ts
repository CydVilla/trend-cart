/**
 * Live counts for the cap bars on the dashboard's Limits page.
 *
 * Every query here MIRRORS the gate it visualizes — same statuses, same
 * rolling window, same exclusions. The worker enforces rolling windows (last
 * 1h / last 24h), not calendar periods, so a bar drawn against "today since
 * midnight" would read empty right after a burst that has the bot fully
 * blocked. Where a query drifts from its gate, the bar becomes a lie exactly
 * when the operator most needs it.
 *
 * Gates mirrored here:
 *   repliesLastHour/Day  apps/worker/src/reply.ts  (ACTIVE_STATUSES, non-banter)
 *   evalsLastHour        apps/worker/src/evaluate.ts (excludes policy/operator)
 *   dealPostsLastDay     apps/worker/src/deals/poster.ts (non-MANUAL, POSTED)
 *   banterLastDay        apps/worker/src/banter.ts
 *   apologiesLastDay     apps/worker/src/apologize.ts
 *   pinsLastDay          apps/worker/src/pinterest/poster.ts
 */

import type { MeterKey } from "@trendcart/shared";
import { prisma, DealPostStatus, DealSource, PinterestPinStatus, PostSource, ReplyStatus } from "./index";

/** Statuses that count as "the bot engaged" — mirrors reply.ts ACTIVE_STATUSES. */
const ACTIVE_REPLY_STATUSES = [
  ReplyStatus.DRY_RUN,
  ReplyStatus.PENDING_APPROVAL,
  ReplyStatus.APPROVED,
  ReplyStatus.POSTING,
  ReplyStatus.POSTED,
];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type LimitUsage = Record<MeterKey, number>;

/**
 * Queried in SEQUENCE, not Promise.all — essential-0 shares a ~20-connection
 * cap with the worker and this package's pool is 4. Each query is milliseconds;
 * the page is not latency-critical.
 */
export async function computeLimitUsage(): Promise<LimitUsage> {
  const now = Date.now();
  const notBanter = { post: { source: { not: PostSource.BANTER } } };

  const repliesLastHour = await prisma.botReply.count({
    where: {
      status: { in: ACTIVE_REPLY_STATUSES },
      createdAt: { gte: new Date(now - HOUR_MS) },
      ...notBanter,
    },
  });
  const repliesLastDay = await prisma.botReply.count({
    where: {
      status: { in: ACTIVE_REPLY_STATUSES },
      createdAt: { gte: new Date(now - DAY_MS) },
      ...notBanter,
    },
  });
  // Cheap policy rejects and operator directives spend no LLM budget, so the
  // worker excludes them from the hourly count — the bar must too.
  const evalsLastHour = await prisma.candidateEvaluation.count({
    where: { createdAt: { gte: new Date(now - HOUR_MS) }, model: { notIn: ["policy", "operator"] } },
  });
  const dealPostsLastDay = await prisma.dealPost.count({
    where: {
      source: { not: DealSource.MANUAL },
      status: DealPostStatus.POSTED,
      postedAt: { gte: new Date(now - DAY_MS) },
    },
  });
  const banterLastDay = await prisma.botReply.count({
    where: {
      status: {
        in: [ReplyStatus.DRY_RUN, ReplyStatus.APPROVED, ReplyStatus.POSTING, ReplyStatus.POSTED],
      },
      createdAt: { gte: new Date(now - DAY_MS) },
      post: { source: PostSource.BANTER },
    },
  });
  const apologiesLastDay = await prisma.apologyReply.count({
    where: {
      status: { in: [ReplyStatus.POSTED, ReplyStatus.POSTING] },
      createdAt: { gte: new Date(now - DAY_MS) },
    },
  });
  const pinsLastDay = await prisma.pinterestPin.count({
    where: { status: PinterestPinStatus.POSTED, postedAt: { gte: new Date(now - DAY_MS) } },
  });

  return {
    repliesLastHour,
    repliesLastDay,
    evalsLastHour,
    dealPostsLastDay,
    banterLastDay,
    apologiesLastDay,
    pinsLastDay,
  };
}

export type ScoreSample = { intent: number; linkConfidence: number; wouldReply: boolean };

/**
 * Recent classifier scores, for plotting WHERE candidates actually land
 * relative to the bars. A threshold with no distribution behind it is a number;
 * with one, it's a decision you can second-guess.
 */
export async function recentScoreSamples(limit = 200): Promise<ScoreSample[]> {
  const rows = await prisma.candidateEvaluation.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 14 * DAY_MS) },
      model: { notIn: ["policy", "operator", "fake"] },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { productIntentScore: true, linkConfidence: true, shouldReply: true },
  });
  return rows.map((r) => ({
    intent: r.productIntentScore,
    linkConfidence: r.linkConfidence,
    wouldReply: r.shouldReply,
  }));
}
