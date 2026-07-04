import { prisma, ReplyStatus } from "@trendcart/db";

/**
 * Measure how OUR posted replies actually perform: likes/replies on the
 * bot's reply are the ground-truth signal the reflection job learns from.
 * Uses the public AppView (no credentials, no cost).
 */

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const BATCH = 25; // getPosts hard limit
const RECHECK_MS = 6 * 3_600_000;
const WINDOW_MS = 14 * 24 * 3_600_000;

export type OutcomeStats = { checked: number; errors: number };

export async function outcomesTick(stats: OutcomeStats): Promise<void> {
  const now = new Date();
  const due = await prisma.botReply.findMany({
    where: {
      status: ReplyStatus.POSTED,
      replyUri: { not: null },
      postedAt: { gte: new Date(now.getTime() - WINDOW_MS) },
      OR: [
        { outcomeCheckedAt: null },
        { outcomeCheckedAt: { lt: new Date(now.getTime() - RECHECK_MS) } },
      ],
    },
    select: { id: true, replyUri: true },
    orderBy: { postedAt: "desc" },
    take: BATCH,
  });
  if (due.length === 0) return;

  const url = new URL(GETPOSTS_URL);
  for (const reply of due) url.searchParams.append("uris", reply.replyUri as string);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    stats.errors += 1;
    throw new Error(`getPosts ${response.status} while checking reply outcomes`);
  }
  const body = (await response.json()) as {
    posts?: Array<{ uri: string; likeCount?: number; replyCount?: number }>;
  };
  const byUri = new Map((body.posts ?? []).map((p) => [p.uri, p]));

  for (const reply of due) {
    const found = byUri.get(reply.replyUri as string);
    // Not found = our reply is gone (deleted/moderated) — keep the last-known
    // counts, but stamp the check so the row doesn't hog the batch forever.
    await prisma.botReply.update({
      where: { id: reply.id },
      data: {
        outcomeCheckedAt: now,
        ...(found
          ? { replyLikeCount: found.likeCount ?? 0, replyReplyCount: found.replyCount ?? 0 }
          : {}),
      },
    });
    stats.checked += 1;
  }
}
