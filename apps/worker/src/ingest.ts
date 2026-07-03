import { prisma, ReplyStatus } from "@trendcart/db";
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

/** Accept en, en-US, en-GB…; posts with no langs at all also pass (keyword
 *  matching against English phrases is the effective language filter). */
function isEnglish(langs: string[] | undefined): boolean {
  if (!langs || langs.length === 0) return true;
  return langs.some((lang) => lang.toLowerCase().startsWith("en"));
}

/**
 * Handle one Jetstream event. Gate ORDER matters: the category matcher runs
 * BEFORE the sensitive/promo filters so that every post those filters kill
 * was a real candidate — making filter over-reach measurable instead of
 * silently destroying the funnel.
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
    // Soft-kill, never row-delete: POSTED reply rows must survive (rate
    // limits, cooldowns, and dedupe all derive from them).
    const existing = await prisma.post.findUnique({
      where: { uri },
      select: { id: true, deadAt: true },
    });
    if (!existing || existing.deadAt) return;
    await prisma.$transaction([
      prisma.post.update({ where: { id: existing.id }, data: { deadAt: new Date() } }),
      prisma.botReply.updateMany({
        where: {
          postId: existing.id,
          status: { in: [ReplyStatus.PENDING_APPROVAL, ReplyStatus.APPROVED] },
        },
        data: { status: ReplyStatus.SKIPPED, skipReason: "post deleted before reply went out" },
      }),
    ]);
    stats.deletes += 1;
    return;
  }

  if (commit.operation !== "create") return;
  stats.creates += 1;

  const record = commit.record;
  const text = record?.text?.trim() ?? "";

  if (!text) return skip(stats, "empty");
  if (record?.reply) return skip(stats, "is_reply");
  if (text.length < config.ingest.minPostLength) return skip(stats, "too_short");
  if (config.ingest.requireEnglish && !isEnglish(record?.langs)) {
    return skip(stats, "not_english");
  }

  const matches = matcher.match(text);
  if (matches.length === 0) return skip(stats, "no_category_match");

  // Post-match kills: these counters are the filter-over-reach alarm.
  if (findSensitiveMatch(text)) return skip(stats, "sensitive_after_match");
  if (findPromotionalMatch(text)) return skip(stats, "promo_after_match");

  if (!commit.cid) return skip(stats, "missing_cid");

  // createMany + skipDuplicates = single atomic INSERT ... ON CONFLICT DO
  // NOTHING, immune to redelivered events racing each other.
  const result = await prisma.post.createMany({
    data: [
      {
        uri,
        cid: commit.cid,
        authorDid: event.did,
        text,
        // Use network receive time, not the client-set createdAt (can be wrong).
        indexedAt: new Date(event.time_us / 1000),
        detectedCategories: matches.map((m) => m.slug),
        matchedKeywords: matches.map((m) => m.keyword),
      },
    ],
    skipDuplicates: true,
  });
  if (result.count === 0) return skip(stats, "duplicate");
  stats.saved += 1;
}
