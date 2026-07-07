import { AtpAgent } from "@atproto/api";
import { prisma } from "@trendcart/db";
import { computeEngagementScore } from "@trendcart/shared";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";
import { findPromotionalMatch, findSensitiveMatch } from "./filters.js";

/**
 * Discovery v2: instead of filtering the entire firehose (89% of whose
 * captures never reached the engagement floor), poll Bluesky search for the
 * TOP posts of the last 24h per category keyword. Posts arrive already
 * trending, with real engagement counts — no maturation wait, no
 * rehydration dependency, ~50 cheap queries per cycle instead of millions
 * of events per day.
 *
 * Category `keywords` double as the search queries (dashboard-editable).
 */

const RESULTS_PER_QUERY = 10;
/** Searches are free (Bluesky API) — the eval budget, not query count, is the
 *  cost ceiling. 8 queries × ~15 categories every 15m is well under limits. */
const MAX_QUERIES_PER_CATEGORY = 8;

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

export type SearchResultPost = {
  uri: string;
  cid: string;
  author: { did: string; handle?: string };
  record?: { text?: string; reply?: unknown; langs?: string[] };
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
};

/** Gate one search result and persist it as a candidate if it qualifies. */
export async function processSearchResult(
  post: SearchResultPost,
  categorySlug: string,
  query: string,
  stats: DiscoverStats,
): Promise<void> {
  stats.found += 1;
  const text = post.record?.text?.trim() ?? "";
  if (!text) return skip(stats, "empty");
  if (post.record?.reply) return skip(stats, "is_reply");
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
  if (score < config.llm.minEngagementScore) return skip(stats, "below_floor");

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
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const categories = await prisma.productCategory.findMany({
      where: { isActive: true },
      select: { slug: true, keywords: true },
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
