import { prisma } from "@trendcart/db";
import { computeEngagementScore, computeEngagementVelocity } from "@trendcart/shared";
import { config } from "./config.js";

/**
 * Jetstream commit events carry no engagement counts (the post was just
 * created), so this loop periodically re-fetches stored candidates from the
 * public AppView by URI and updates counts, score, and velocity.
 * No auth required — this is the same API the public web app uses.
 */

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const BATCH_SIZE = 25; // getPosts max
const TICK_MS = 60_000;

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
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`getPosts failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { posts?: AppViewPost[] };
  return body.posts ?? [];
}

async function tick(stats: RehydrateStats): Promise<void> {
  const now = new Date();
  const oldestCreatedAt = new Date(now.getTime() - config.ingest.rehydrateMaxAgeHours * 3_600_000);
  const staleBefore = new Date(now.getTime() - config.ingest.rehydrateIntervalMinutes * 60_000);

  // Never-hydrated posts first, then the longest-stale.
  const due = await prisma.post.findMany({
    where: {
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
      // Deleted or not indexed — stamp it so it doesn't clog the queue.
      await prisma.post.update({
        where: { id: post.id },
        data: { lastHydratedAt: now },
      });
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

/** Starts the loop; returns a stop function. */
export function startRehydrationLoop(stats: RehydrateStats): () => void {
  const run = (): void => {
    tick(stats).catch((error) => {
      stats.errors += 1;
      console.error("[rehydrate] tick failed:", error instanceof Error ? error.message : error);
    });
  };
  run(); // hydrate immediately on startup
  const timer = setInterval(run, TICK_MS);
  return () => clearInterval(timer);
}
