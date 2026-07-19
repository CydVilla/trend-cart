import { DealPostStatus, prisma, ReplyStatus, type Prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * Measure how OUR posted content actually performs: likes/reposts/replies/
 * quotes on the bot's replies and deal alerts are the
 * ground-truth signal the reflection job learns from. Uses the public
 * AppView (no credentials, no cost).
 *
 * Live counts are written back onto the source row (last-known value, cheap
 * to query), and every reading is also appended to EngagementSnapshot so the
 * history survives — the raw material for engagement-over-time analysis and
 * an eventual fine-tuning dataset.
 *
 * For replies specifically, when someone replied we also capture WHAT they
 * said (BotReply.receivedReplies) — "thanks, ordered one" and "spam bot" are
 * opposite feedback at 1 reply each.
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

export type OutcomeStats = { checked: number; errors: number };

type OutcomeTarget = {
  id: string;
  uri: string;
  kind: "reply" | "deal";
  /** reply-kind only: last-known reply count + captured texts, for staleness. */
  priorReplyCount?: number;
  priorReceived?: unknown;
};

type PostCounts = {
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
};

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
 *  deal posts fill whatever batch room remains. */
async function gatherDue(now: Date): Promise<OutcomeTarget[]> {
  const targets: OutcomeTarget[] = [];
  const replies = await prisma.botReply.findMany({
    where: {
      status: ReplyStatus.POSTED,
      replyUri: { not: null },
      // A 👎-takedown froze this reply's engagement — nothing left to measure.
      takedownAt: null,
      ...dueWhere(now),
    },
    select: { id: true, replyUri: true, replyReplyCount: true, receivedReplies: true },
    orderBy: { postedAt: "desc" },
    take: BATCH,
  });
  for (const r of replies) {
    targets.push({
      id: r.id,
      uri: r.replyUri as string,
      kind: "reply",
      priorReplyCount: r.replyReplyCount,
      priorReceived: r.receivedReplies,
    });
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

  let threadFetches = 0;
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
      // Someone replied to us and we haven't captured (all of) what they said
      // yet — pull the thread. One extra public-API call, capped per tick.
      let received: ReceivedReply[] | null = null;
      const replyCount = counts?.replyCount ?? 0;
      const staleTexts =
        replyCount > 0 &&
        (target.priorReceived === null || replyCount !== target.priorReplyCount);
      if (staleTexts && threadFetches < MAX_THREAD_FETCHES) {
        threadFetches += 1;
        received = await fetchReceivedReplies(target.uri);
      }
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
          ...(received !== null
            ? { receivedReplies: received as unknown as Prisma.InputJsonValue }
            : {}),
        },
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
