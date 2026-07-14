import { DealPostStatus, prisma, ReplyStatus } from "@trendcart/db";

/**
 * Measure how OUR posted content actually performs: likes/reposts/replies/
 * quotes on the bot's replies, radar posts, and deal alerts are the
 * ground-truth signal the reflection job learns from. Uses the public
 * AppView (no credentials, no cost).
 *
 * Live counts are written back onto the source row (last-known value, cheap
 * to query), and every reading is also appended to EngagementSnapshot so the
 * history survives — the raw material for engagement-over-time analysis and
 * an eventual fine-tuning dataset.
 */

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const BATCH = 25; // getPosts hard limit
const RECHECK_MS = 6 * 3_600_000;
const WINDOW_MS = 14 * 24 * 3_600_000;

export type OutcomeStats = { checked: number; errors: number };

type OutcomeTarget = { id: string; uri: string; kind: "reply" | "radar" | "deal" };

type PostCounts = {
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
};

/** Rows posted within the window whose counts are stale (or never read). */
function dueWhere(now: Date): {
  postedAt: { gte: Date };
  OR: Array<{ outcomeCheckedAt: null } | { outcomeCheckedAt: { lt: Date } }>;
} {
  return {
    postedAt: { gte: new Date(now.getTime() - WINDOW_MS) },
    OR: [
      { outcomeCheckedAt: null },
      { outcomeCheckedAt: { lt: new Date(now.getTime() - RECHECK_MS) } },
    ],
  };
}

/** Replies first (the learning loop's primary signal), then the bot's own
 *  radar and deal posts fill whatever batch room remains. */
async function gatherDue(now: Date): Promise<OutcomeTarget[]> {
  const targets: OutcomeTarget[] = [];
  const replies = await prisma.botReply.findMany({
    where: { status: ReplyStatus.POSTED, replyUri: { not: null }, ...dueWhere(now) },
    select: { id: true, replyUri: true },
    orderBy: { postedAt: "desc" },
    take: BATCH,
  });
  for (const r of replies) targets.push({ id: r.id, uri: r.replyUri as string, kind: "reply" });

  if (targets.length < BATCH) {
    const radars = await prisma.radarPost.findMany({
      where: { status: ReplyStatus.POSTED, postUri: { not: null }, ...dueWhere(now) },
      select: { id: true, postUri: true },
      orderBy: { postedAt: "desc" },
      take: BATCH - targets.length,
    });
    for (const r of radars) targets.push({ id: r.id, uri: r.postUri as string, kind: "radar" });
  }
  if (targets.length < BATCH) {
    const deals = await prisma.dealPost.findMany({
      where: { status: DealPostStatus.POSTED, postUri: { not: null }, ...dueWhere(now) },
      select: { id: true, postUri: true },
      orderBy: { postedAt: "desc" },
      take: BATCH - targets.length,
    });
    for (const d of deals) targets.push({ id: d.id, uri: d.postUri as string, kind: "deal" });
  }
  return targets;
}

export async function outcomesTick(stats: OutcomeStats): Promise<void> {
  const now = new Date();
  const due = await gatherDue(now);
  if (due.length === 0) return;

  const url = new URL(GETPOSTS_URL);
  for (const target of due) url.searchParams.append("uris", target.uri);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    stats.errors += 1;
    throw new Error(`getPosts ${response.status} while checking post outcomes`);
  }
  const body = (await response.json()) as {
    posts?: Array<{ uri: string } & PostCounts>;
  };
  const byUri = new Map((body.posts ?? []).map((p) => [p.uri, p]));

  const snapshots: Array<{ kind: string; sourceId: string } & Required<PostCounts>> = [];
  for (const target of due) {
    const found = byUri.get(target.uri);
    // Not found = the post is gone (deleted/moderated) — keep the last-known
    // counts, but stamp the check so the row doesn't hog the batch forever.
    const counts = found
      ? {
          likeCount: found.likeCount ?? 0,
          repostCount: found.repostCount ?? 0,
          replyCount: found.replyCount ?? 0,
          quoteCount: found.quoteCount ?? 0,
        }
      : null;
    if (target.kind === "reply") {
      await prisma.botReply.update({
        where: { id: target.id },
        data: {
          outcomeCheckedAt: now,
          ...(counts
            ? {
                replyLikeCount: counts.likeCount,
                replyReplyCount: counts.replyCount,
                replyRepostCount: counts.repostCount,
                replyQuoteCount: counts.quoteCount,
              }
            : {}),
        },
      });
    } else if (target.kind === "radar") {
      await prisma.radarPost.update({
        where: { id: target.id },
        data: { outcomeCheckedAt: now, ...(counts ?? {}) },
      });
    } else {
      await prisma.dealPost.update({
        where: { id: target.id },
        data: { outcomeCheckedAt: now, ...(counts ?? {}) },
      });
    }
    if (counts) snapshots.push({ kind: target.kind, sourceId: target.id, ...counts });
    stats.checked += 1;
  }
  if (snapshots.length > 0) {
    await prisma.engagementSnapshot.createMany({ data: snapshots });
  }
}
