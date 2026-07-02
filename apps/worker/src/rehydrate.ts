import { prisma, ReplyStatus } from "@trendcart/db";
import { computeEngagementScore, computeEngagementVelocity } from "@trendcart/shared";
import { config } from "./config.js";

/**
 * Jetstream commit events carry no engagement counts (the post was just
 * created), so this loop periodically re-fetches stored candidates from the
 * public AppView by URI and updates counts, score, and velocity.
 * A post missing from the AppView is DEAD (deleted/suspended): it is marked
 * so and any not-yet-posted replies for it are cancelled.
 */

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const BATCH_SIZE = 25; // getPosts max
const FETCH_TIMEOUT_MS = 15_000;

/** Subset of app.bsky.feed.defs#postView we consume. */
type AppViewPost = {
  uri: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  author?: { did: string; handle?: string };
};

export type RehydrateStats = {
  hydrated: number;
  missing: number;
  errors: number;
};

async function fetchPosts(uris: string[]): Promise<AppViewPost[]> {
  const url = new URL(GETPOSTS_URL);
  for (const uri of uris) url.searchParams.append("uris", uri);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`getPosts failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { posts?: AppViewPost[] };
  return body.posts ?? [];
}

async function markDead(postId: string, now: Date): Promise<void> {
  await prisma.$transaction([
    prisma.post.update({
      where: { id: postId },
      data: { deadAt: now, lastHydratedAt: now },
    }),
    // Cancel anything not yet posted — never reply to a deleted post.
    prisma.botReply.updateMany({
      where: {
        postId,
        status: { in: [ReplyStatus.PENDING_APPROVAL, ReplyStatus.APPROVED] },
      },
      data: { status: ReplyStatus.SKIPPED, skipReason: "post deleted before reply went out" },
    }),
  ]);
}

export async function rehydrateTick(stats: RehydrateStats): Promise<void> {
  const now = new Date();
  const oldestCreatedAt = new Date(now.getTime() - config.ingest.rehydrateMaxAgeHours * 3_600_000);
  const staleBefore = new Date(now.getTime() - config.ingest.rehydrateIntervalMinutes * 60_000);

  // Never-hydrated posts first, then the longest-stale.
  const due = await prisma.post.findMany({
    where: {
      deadAt: null,
      createdAt: { gte: oldestCreatedAt },
      OR: [{ lastHydratedAt: null }, { lastHydratedAt: { lt: staleBefore } }],
    },
    orderBy: { lastHydratedAt: { sort: "asc", nulls: "first" } },
    take: BATCH_SIZE,
    select: {
      id: true,
      uri: true,
      indexedAt: true,
      engagementScore: true,
      lastHydratedAt: true,
    },
  });
  if (due.length === 0) return;

  const fetched = new Map((await fetchPosts(due.map((p) => p.uri))).map((p) => [p.uri, p]));

  for (const post of due) {
    const view = fetched.get(post.uri);
    if (!view) {
      await markDead(post.id, now);
      stats.missing += 1;
      continue;
    }

    const counts = {
      likeCount: view.likeCount ?? 0,
      repostCount: view.repostCount ?? 0,
      replyCount: view.replyCount ?? 0,
      quoteCount: view.quoteCount ?? 0,
    };
    const score = computeEngagementScore(counts);
    const velocity = computeEngagementVelocity(
      post.engagementScore,
      score,
      post.lastHydratedAt ?? post.indexedAt,
      now,
    );

    await prisma.post.update({
      where: { id: post.id },
      data: {
        ...counts,
        engagementScore: score,
        engagementVelocity: velocity,
        authorHandle: view.author?.handle ?? undefined,
        lastHydratedAt: now,
      },
    });
    stats.hydrated += 1;
  }
}
