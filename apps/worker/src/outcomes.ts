import { prisma, ReplyStatus, type Prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * Measure how OUR posted replies actually perform: likes/replies on the
 * bot's reply are the ground-truth signal the reflection job learns from.
 * When someone replied, we also capture WHAT they said (receivedReplies) —
 * "thanks, ordered one" and "spam bot" are opposite feedback at 1 reply each.
 * Uses the public AppView (no credentials, no cost).
 */

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const GETTHREAD_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread";
const BATCH = 25; // getPosts hard limit
const RECHECK_MS = 6 * 3_600_000;
const WINDOW_MS = 14 * 24 * 3_600_000;
/** Thread fetches per tick (one per reply that has new replies) — cost bound. */
const MAX_THREAD_FETCHES = 10;
/** Most-liked replies kept per bot reply; each text clipped so rows stay small. */
const MAX_KEPT = 8;
const MAX_TEXT = 280;

/** One audience reply captured under a posted bot reply. */
export type ReceivedReply = { text: string; likeCount: number; authorHandle: string };

type ThreadReply = {
  post?: {
    author?: { handle?: string };
    record?: { text?: string };
    likeCount?: number;
  };
};

/** Fetch what people said under our reply (bot's own posts excluded). */
async function fetchReceivedReplies(uri: string): Promise<ReceivedReply[] | null> {
  try {
    const url = new URL(GETTHREAD_URL);
    url.searchParams.set("uri", uri);
    url.searchParams.set("depth", "1"); // direct replies only
    url.searchParams.set("parentHeight", "0");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { thread?: { replies?: ThreadReply[] } };
    return (data.thread?.replies ?? [])
      .map((r) => ({
        text: (r.post?.record?.text ?? "").replace(/\s+/g, " ").trim(),
        likeCount: r.post?.likeCount ?? 0,
        authorHandle: r.post?.author?.handle ?? "unknown",
      }))
      .filter((r) => r.text.length > 0 && r.authorHandle !== config.bluesky.handle)
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, MAX_KEPT)
      .map((r) => ({ ...r, text: r.text.slice(0, MAX_TEXT) }));
  } catch {
    return null; // best-effort — counts still update, texts catch up next check
  }
}

export type OutcomeStats = { checked: number; errors: number };

export async function outcomesTick(stats: OutcomeStats): Promise<void> {
  const now = new Date();
  const due = await prisma.botReply.findMany({
    where: {
      status: ReplyStatus.POSTED,
      replyUri: { not: null },
      // A 👎-takedown froze this reply's engagement — nothing left to measure.
      takedownAt: null,
      postedAt: { gte: new Date(now.getTime() - WINDOW_MS) },
      OR: [
        { outcomeCheckedAt: null },
        { outcomeCheckedAt: { lt: new Date(now.getTime() - RECHECK_MS) } },
      ],
    },
    select: { id: true, replyUri: true, replyReplyCount: true, receivedReplies: true },
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

  let threadFetches = 0;
  for (const reply of due) {
    const found = byUri.get(reply.replyUri as string);

    // Someone replied to us and we haven't captured (all of) what they said
    // yet — pull the thread. One extra public-API call, capped per tick.
    let received: ReceivedReply[] | null = null;
    const replyCount = found?.replyCount ?? 0;
    const staleTexts =
      replyCount > 0 && (reply.receivedReplies === null || replyCount !== reply.replyReplyCount);
    if (staleTexts && threadFetches < MAX_THREAD_FETCHES) {
      threadFetches += 1;
      received = await fetchReceivedReplies(reply.replyUri as string);
    }

    // Not found = our reply is gone (deleted/moderated) — keep the last-known
    // counts, but stamp the check so the row doesn't hog the batch forever.
    await prisma.botReply.update({
      where: { id: reply.id },
      data: {
        outcomeCheckedAt: now,
        ...(found
          ? { replyLikeCount: found.likeCount ?? 0, replyReplyCount: found.replyCount ?? 0 }
          : {}),
        ...(received !== null
          ? { receivedReplies: received as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    stats.checked += 1;
  }
}
