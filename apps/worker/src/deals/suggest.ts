import {
  prisma,
  DealPostStatus,
  ListingOrigin,
  SuggestionStatus,
  type DealSuggestionSource,
} from "@trendcart/db";
import type { LlmClient } from "@trendcart/shared";
import { config } from "../config.js";
import { getOperatorFlags } from "../heartbeat.js";
import { extractAmazonRef, extractPriceHintCents, parseRssItems, type RssItem } from "./rss.js";

export type DealSuggestStats = {
  sources: number;
  items: number;
  suggested: number;
  expired: number;
  skipped: Record<string, number>;
  errors: number;
};

export function newDealSuggestStats(): DealSuggestStats {
  return { sources: 0, items: 0, suggested: 0, expired: 0, skipped: {}, errors: 0 };
}

export type DealSuggester = { tick: () => Promise<void>; enabled: boolean };

const FETCH_TIMEOUT_MS = 15_000;
/** Feeds ~1MB would be pathological; cap what we'll parse. */
const MAX_FEED_BYTES = 2_000_000;

/**
 * The no-PA-API bridge: polls deal RSS feeds (Slickdeals etc.), extracts
 * Amazon items, gates them into topical lanes, and writes SUGGESTIONS the
 * operator confirms on the Deals page. This loop never posts anything and
 * never trusts a third-party price — the parsed price is a hint the operator
 * must re-enter, so every advertised price is human-attested at queue time.
 *
 * Lane filtering is two-stage per the repo's usual split: cheap keyword
 * include/exclude first, then an LLM topical judgment ("pop-culture apparel
 * only") whose verdict is stored for audit. No LLM available → keyword-only
 * mode (the operator remains the real gate either way).
 */
export function createDealSuggester(llm: LlmClient | null, stats: DealSuggestStats): DealSuggester {
  if (!config.deals.suggestions.enabled) {
    console.log("  deal suggestions: disabled (DEAL_SUGGESTIONS_ENABLED=false)");
    return { tick: async () => {}, enabled: false };
  }
  const hasLlm = llm !== null && (config.llm.useFake || Boolean(config.llm.anthropicApiKey));
  console.log(
    `  deal suggestions: enabled (RSS every ${config.deals.suggestions.intervalMinutes}m/source, ` +
      `${hasLlm ? "LLM topical gate" : "keyword gate only — no LLM key"})`,
  );

  function skip(reason: string): void {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
  }

  /** Suggestions rot fast — a deal from two days ago is dead. Close them out
   *  so the dashboard queue only ever shows plausibly-live deals. */
  async function expireStale(): Promise<void> {
    const cutoff = new Date(Date.now() - config.deals.suggestions.expireHours * 3_600_000);
    const expired = await prisma.dealSuggestion.updateMany({
      where: { status: SuggestionStatus.NEW, createdAt: { lt: cutoff } },
      data: { status: SuggestionStatus.EXPIRED },
    });
    stats.expired += expired.count;
  }

  async function fetchFeed(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        // Honest bot UA; some feed hosts reject blank/browser-spoofed agents.
        "user-agent": "TrendCartBot/1.0 (deal RSS reader)",
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`feed fetch failed: HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_FEED_BYTES) throw new Error("feed too large");
    return body;
  }

  /** All gates for one RSS item; creates a suggestion when everything passes.
   *  Returns true when a suggestion row was written. */
  async function handleItem(
    source: DealSuggestionSource,
    item: RssItem,
    llmBudget: { remaining: number },
  ): Promise<boolean> {
    // Per-source guid dedup — the same item reappears in every fetch.
    const seen = await prisma.dealSuggestion.findUnique({
      where: { sourceId_guid: { sourceId: source.id, guid: item.guid } },
      select: { id: true },
    });
    if (seen) return false; // silent: re-seeing old items is the normal case

    const titleLower = item.title.toLowerCase();
    if (source.excludeKeywords.some((k) => k && titleLower.includes(k.toLowerCase()))) {
      skip("excluded_keyword");
      return false;
    }
    if (
      source.includeKeywords.length > 0 &&
      !source.includeKeywords.some((k) => k && titleLower.includes(k.toLowerCase()))
    ) {
      skip("keyword_miss");
      return false;
    }

    const ref = extractAmazonRef(item.link, item.description);
    if (!ref) {
      skip("no_amazon_link");
      return false;
    }
    // v1 is single-marketplace: a .co.uk item would carry the wrong currency
    // through the confirm form, so only the configured marketplace passes.
    if (ref.marketplace !== config.paapi.marketplace) {
      skip("marketplace_mismatch");
      return false;
    }

    const hintPriceCents = extractPriceHintCents(item.title, item.description);
    if (hintPriceCents != null) {
      if (source.minPriceCents != null && hintPriceCents < source.minPriceCents) {
        skip("below_price_floor");
        return false;
      }
      if (source.maxPriceCents != null && hintPriceCents > source.maxPriceCents) {
        skip("above_price_ceiling");
        return false;
      }
    }

    // Cross-source ASIN dedup + respect the per-ASIN posting state: a banned
    // discovered listing, an in-flight deal, or a recent post all mean the
    // operator does not need this suggestion.
    const dupe = await prisma.dealSuggestion.findFirst({
      where: { asin: ref.asin, status: SuggestionStatus.NEW },
      select: { id: true },
    });
    if (dupe) {
      skip("duplicate_asin");
      return false;
    }
    const listing = await prisma.trackedListing.findUnique({
      where: { asin_marketplace: { asin: ref.asin, marketplace: ref.marketplace } },
      select: { id: true, isActive: true, origin: true, lastPostedAt: true },
    });
    if (listing) {
      if (!listing.isActive && listing.origin === ListingOrigin.DISCOVERED) {
        skip("listing_banned");
        return false;
      }
      if (
        listing.lastPostedAt &&
        Date.now() - listing.lastPostedAt.getTime() <
          config.deals.perListingCooldownHours * 3_600_000
      ) {
        skip("listing_cooldown");
        return false;
      }
      const inFlight = await prisma.dealPost.findFirst({
        where: {
          listingId: listing.id,
          status: {
            in: [
              DealPostStatus.PENDING,
              DealPostStatus.PENDING_APPROVAL,
              DealPostStatus.READY,
              DealPostStatus.POSTING,
            ],
          },
        },
        select: { id: true },
      });
      if (inFlight) {
        skip("already_queued");
        return false;
      }
    }

    // Topical lane gate. LLM errors fail OPEN (suggestion still queues, the
    // operator is the real gate) but an off-lane verdict fails CLOSED.
    let gateVerdict: Record<string, unknown> = { mode: "keywords-only" };
    if (hasLlm && llm) {
      if (llmBudget.remaining <= 0) {
        skip("llm_budget_exhausted");
        return false;
      }
      llmBudget.remaining -= 1;
      try {
        const verdict = await llm.judgeDealSuggestion({ itemTitle: item.title, topic: source.topic });
        gateVerdict = {
          mode: config.llm.useFake ? "fake" : config.llm.model,
          ...verdict,
        };
        if (!verdict.matches || verdict.confidence < config.deals.suggestions.minTopicConfidence) {
          skip("off_topic");
          return false;
        }
      } catch (error) {
        stats.errors += 1;
        gateVerdict = {
          mode: "gate-error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    await prisma.dealSuggestion.create({
      data: {
        sourceId: source.id,
        guid: item.guid,
        title: item.title.slice(0, 300),
        asin: ref.asin,
        marketplace: ref.marketplace,
        productUrl: `https://${ref.marketplace}/dp/${ref.asin}`,
        hintPriceCents,
        sourceUrl: item.link,
        gateVerdict: gateVerdict as object,
      },
    });
    return true;
  }

  async function runSource(source: DealSuggestionSource, llmBudget: { remaining: number }): Promise<void> {
    stats.sources += 1;
    const startedAt = new Date();
    const xml = await fetchFeed(source.url);
    const items = parseRssItems(xml).slice(0, config.deals.suggestions.maxItemsPerFetch);
    let queued = 0;
    for (const item of items) {
      try {
        if (await handleItem(source, item, llmBudget)) queued += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(
          `[dealSuggest] item failed (${source.name}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    stats.items += items.length;
    stats.suggested += queued;
    await prisma.dealSuggestionSource.update({
      where: { id: source.id },
      data: {
        lastFetchedAt: startedAt,
        lastItemCount: items.length,
        lastQueuedCount: queued,
        lastFetchError: null,
      },
    });
    if (queued > 0) console.log(`[dealSuggest] ${source.name}: ${queued} new suggestion(s)`);
  }

  async function tick(): Promise<void> {
    if ((await getOperatorFlags()).paused) return;

    await expireStale();

    const due = await prisma.dealSuggestionSource.findMany({
      where: {
        isActive: true,
        OR: [
          { lastFetchedAt: null }, // "Fetch now" resets this
          {
            lastFetchedAt: {
              lte: new Date(Date.now() - config.deals.suggestions.intervalMinutes * 60_000),
            },
          },
        ],
      },
      orderBy: { lastFetchedAt: { sort: "asc", nulls: "first" } },
      take: Math.max(1, config.deals.suggestions.sourcesPerTick),
    });

    // One shared LLM budget per tick keeps a burst of new feed items from
    // turning into an unbounded string of judgment calls.
    const llmBudget = { remaining: config.deals.suggestions.maxLlmPerTick };
    for (const source of due) {
      try {
        await runSource(source, llmBudget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.errors += 1;
        // Stamp the failed run — a broken feed waits its full interval out
        // instead of hot-looping the host.
        await prisma.dealSuggestionSource
          .update({
            where: { id: source.id },
            data: { lastFetchedAt: new Date(), lastFetchError: message },
          })
          .catch(() => {});
        console.warn(`[dealSuggest] ${source.name} failed: ${message}`);
      }
    }
  }

  return { tick, enabled: true };
}
