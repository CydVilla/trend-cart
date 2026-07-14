import { AtpAgent } from "@atproto/api";
import { prisma } from "@trendcart/db";
import { computeEngagementScore } from "@trendcart/shared";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";
import { findPromotionalMatch, findSensitiveMatch } from "./filters.js";

/**
 * Discovery v2: instead of filtering the entire firehose (89% of whose
 * captures never reached the engagement floor), poll Bluesky search for the
 * TOP posts of the last MAX_CANDIDATE_AGE_HOURS per category keyword —
 * fresh enough that eval + reply still land while the thread is alive.
 * Posts arrive already
 * trending, with real engagement counts — no maturation wait, no
 * rehydration dependency, ~50 cheap queries per cycle instead of millions
 * of events per day.
 *
 * Category `keywords` double as the search queries (dashboard-editable).
 */

const RESULTS_PER_QUERY = 10;
/** Searches are free (Bluesky API) — the eval budget, not query count, is the
 *  cost ceiling. 12 queries × ~15 categories every 15m is well under limits,
 *  and the headroom lets keyword additions to a tuned category actually run
 *  instead of dying past the cap. */
const MAX_QUERIES_PER_CATEGORY = 12;

export type DiscoverStats = {
  queries: number;
  found: number;
  saved: number;
  errors: number;
  skipped: Record<string, number>;
};

export function newDiscoverStats(): DiscoverStats {
  return { queries: 0, found: 0, saved: 0, errors: 0, skipped: {} };
}

function skip(stats: DiscoverStats, reason: string): void {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
}

/** Loose English check: missing langs passes (queries are English phrases). */
function isEnglish(langs: string[] | undefined): boolean {
  if (!langs || langs.length === 0) return true;
  return langs.some((lang) => lang.toLowerCase().startsWith("en"));
}

/** A single image inside a hydrated Bluesky embed view. */
type EmbedImage = { thumb?: string; fullsize?: string; alt?: string };
/** The subset of a hydrated embed view we care about (images live directly on
 *  an images#view, or nested under a recordWithMedia#view's media). */
type EmbedView = {
  $type?: string;
  images?: EmbedImage[];
  media?: { $type?: string; images?: EmbedImage[] };
};

/**
 * Pull image thumbnails + author alt text from a hydrated embed. We keep the
 * THUMBNAIL (a few hundred px), not full-size — vision tokens scale with pixels,
 * so thumbnails hold cost near-zero while still letting the model read a game
 * screenshot or box art. Alt text is free descriptive signal either way.
 */
export function extractImages(embed: EmbedView | undefined): { url: string; alt: string | null }[] {
  if (!embed) return [];
  const imgs =
    embed.$type === "app.bsky.embed.images#view"
      ? embed.images
      : embed.$type === "app.bsky.embed.recordWithMedia#view" &&
          embed.media?.$type === "app.bsky.embed.images#view"
        ? embed.media.images
        : undefined;
  if (!imgs) return [];
  return imgs
    .map((i) => ({ url: i.thumb ?? i.fullsize ?? "", alt: i.alt?.trim() || null }))
    .filter((i) => i.url.length > 0)
    .slice(0, 4); // Bluesky allows at most 4 images per post
}

export type SearchResultPost = {
  uri: string;
  cid: string;
  author: { did: string; handle?: string };
  record?: { text?: string; reply?: unknown; langs?: string[] };
  embed?: EmbedView;
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
};

/** Gate one search result and persist it as a candidate if it qualifies.
 *  `minEngagementScore` is the effective floor for this category — a
 *  per-category override when the operator set one, the global floor
 *  otherwise. */
export async function processSearchResult(
  post: SearchResultPost,
  categorySlug: string,
  query: string,
  stats: DiscoverStats,
  minEngagementScore: number = config.llm.minEngagementScore,
): Promise<void> {
  stats.found += 1;
  const text = post.record?.text?.trim() ?? "";
  if (!text) return skip(stats, "empty");
  if (post.record?.reply) return skip(stats, "is_reply");
  // Too old to act on: by the time it matures + evaluates + queues, the 24h
  // reply window is gone — an eval here is money spent on a guaranteed expiry.
  if (
    post.indexedAt &&
    Date.now() - new Date(post.indexedAt).getTime() >
      config.ingest.maxCandidateAgeHours * 3_600_000
  ) {
    return skip(stats, "too_old");
  }
  if (text.length < config.ingest.minPostLength) return skip(stats, "too_short");
  if (config.ingest.requireEnglish && !isEnglish(post.record?.langs)) {
    return skip(stats, "not_english");
  }
  if (findSensitiveMatch(text)) return skip(stats, "sensitive");
  if (findPromotionalMatch(text)) return skip(stats, "promotional");

  const counts = {
    likeCount: post.likeCount ?? 0,
    repostCount: post.repostCount ?? 0,
    replyCount: post.replyCount ?? 0,
    quoteCount: post.quoteCount ?? 0,
  };
  const score = computeEngagementScore(counts);
  if (score < minEngagementScore) return skip(stats, "below_floor");

  const images = extractImages(post.embed);

  const result = await prisma.post.createMany({
    data: [
      {
        uri: post.uri,
        cid: post.cid,
        authorDid: post.author.did,
        authorHandle: post.author.handle ?? null,
        text,
        indexedAt: post.indexedAt ? new Date(post.indexedAt) : new Date(),
        ...counts,
        engagementScore: score,
        detectedCategories: [categorySlug],
        matchedKeywords: [query],
        source: "SEARCH",
        lastHydratedAt: new Date(), // counts are current at discovery
        imageUrls: images.map((i) => i.url),
        // Kept index-aligned with imageUrls ("" = no alt) so the pair survives.
        imageAlts: images.map((i) => i.alt ?? ""),
      },
    ],
    skipDuplicates: true,
  });
  if (result.count === 0) return skip(stats, "duplicate");
  stats.saved += 1;
}

export function createDiscoverer(stats: DiscoverStats): { tick: () => Promise<void> } | null {
  if (!config.bluesky.handle || !config.bluesky.appPassword) return null;

  let agent: AtpAgent | null = null;

  async function tick(): Promise<void> {
    if (blueskyBackingOff()) return; // Bluesky is down — skip until the probe window
    if (!agent) {
      const candidate = new AtpAgent({ service: "https://bsky.social" });
      try {
        await candidate.login({
          identifier: config.bluesky.handle,
          password: config.bluesky.appPassword,
        });
      } catch (error) {
        // Transient outage → back off quietly; a real auth error still throws
        // loudly so the operator sees the credential problem.
        if (noteBlueskyDown(error)) return;
        throw error;
      }
      agent = candidate;
    }
    const since = new Date(
      Date.now() - config.ingest.maxCandidateAgeHours * 3_600_000,
    ).toISOString();
    const categories = await prisma.productCategory.findMany({
      where: { isActive: true },
      select: { slug: true, keywords: true, minEngagementScore: true },
    });
    for (const category of categories) {
      for (const query of category.keywords.slice(0, MAX_QUERIES_PER_CATEGORY)) {
        stats.queries += 1;
        try {
          const response = await agent.app.bsky.feed.searchPosts({
            q: query,
            sort: "top",
            since,
            limit: RESULTS_PER_QUERY,
          });
          noteBlueskyUp(); // a working search means Bluesky is back
          for (const post of response.data.posts) {
            await processSearchResult(
              post as unknown as SearchResultPost,
              category.slug,
              query,
              stats,
              category.minEngagementScore ?? config.llm.minEngagementScore,
            );
          }
        } catch (error) {
          stats.errors += 1;
          // Bluesky is down — stop grinding the remaining ~115 queries this
          // cycle; back off and let the next tick probe once the window clears.
          if (noteBlueskyDown(error)) return;
          console.error(
            `[discover] query "${query}" failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }

  return { tick };
}
