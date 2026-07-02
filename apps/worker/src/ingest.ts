import { prisma } from "@trendcart/db";
import { config } from "./config.js";
import { CategoryMatcher, findPromotionalMatch, findSensitiveMatch } from "./filters.js";
import type { JetstreamEvent } from "./jetstream.js";

const POST_COLLECTION = "app.bsky.feed.post";

/** Counters for the periodic stats log — how we verify the funnel is sane. */
export type IngestStats = {
  events: number;
  creates: number;
  saved: number;
  deletes: number;
  skipped: Record<string, number>;
};

export function newIngestStats(): IngestStats {
  return { events: 0, creates: 0, saved: 0, deletes: 0, skipped: {} };
}

function skip(stats: IngestStats, reason: string): void {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
}

/**
 * Handle one Jetstream event: apply the cheap filter funnel and persist
 * keyword-matched posts as candidates. Deletions remove any stored candidate
 * so we never evaluate or reply to a post the author took down.
 */
export async function processPostEvent(
  event: JetstreamEvent,
  matcher: CategoryMatcher,
  stats: IngestStats,
): Promise<void> {
  stats.events += 1;

  const commit = event.commit;
  if (event.kind !== "commit" || !commit || commit.collection !== POST_COLLECTION) return;

  const uri = `at://${event.did}/${POST_COLLECTION}/${commit.rkey}`;

  if (commit.operation === "delete") {
    const { count } = await prisma.post.deleteMany({ where: { uri } });
    if (count > 0) stats.deletes += 1;
    return;
  }

  if (commit.operation !== "create") return;
  stats.creates += 1;

  const record = commit.record;
  const text = record?.text?.trim() ?? "";

  if (!text) return skip(stats, "empty");
  if (record?.reply) return skip(stats, "is_reply");
  if (text.length < config.ingest.minPostLength) return skip(stats, "too_short");
  if (config.ingest.requireEnglish && !record?.langs?.includes("en")) {
    return skip(stats, "not_english");
  }
  if (findSensitiveMatch(text)) return skip(stats, "sensitive_topic");
  if (findPromotionalMatch(text)) return skip(stats, "promotional");

  const matchedCategories = matcher.match(text);
  if (matchedCategories.length === 0) return skip(stats, "no_category_match");

  if (!commit.cid) return skip(stats, "missing_cid");

  // createMany + skipDuplicates compiles to a single atomic
  // INSERT ... ON CONFLICT DO NOTHING, so redelivered events (cursor rewinds,
  // at-least-once delivery) can't race each other the way upsert's
  // find-then-create does.
  const result = await prisma.post.createMany({
    data: [
      {
        uri,
        cid: commit.cid,
        authorDid: event.did,
        text,
        // Use network receive time, not the client-set createdAt (can be wrong).
        indexedAt: new Date(event.time_us / 1000),
        detectedCategories: matchedCategories,
      },
    ],
    skipDuplicates: true,
  });
  if (result.count === 0) return skip(stats, "duplicate");
  stats.saved += 1;
}
