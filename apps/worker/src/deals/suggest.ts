import {
  prisma,
  DealArmState,
  DealPostStatus,
  DealSource,
  ListingOrigin,
  SuggestionStatus,
  type DealSuggestionSource,
} from "@trendcart/db";
import {
  canonicalAmazonUrl,
  cleanDealTitle,
  shortenAmazonTitle,
  validateDealText,
  withAffiliateTag,
  type LlmClient,
} from "@trendcart/shared";
import { config } from "../config.js";
import { factCheckDealListing } from "../factcheck.js";
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
/** The clickable phrase the affiliate link rides on (price-free channel). */
const RSS_DEAL_ANCHOR = "see the deal on Amazon";

/**
 * The no-PA-API Wario64 bridge, fully AUTOMATED: polls deal RSS feeds
 * (Slickdeals etc.), extracts Amazon items, gates them into topical lanes,
 * corroborates each survivor with a web-search fact check, and queues a
 * SELF-POSTING deal alert on the bot's own profile.
 *
 * The compliance line (ADR-0013) survives automation: no third-party price
 * is ever advertised. The post is PRICE-FREE — "<title> is on sale, spotted
 * via <source>" — so nothing unattested is claimed; the reader sees the real
 * price on Amazon. When PA-API credentials exist, the feed-discovery channel
 * (discover.ts) takes over with real attested prices.
 *
 * Lane filtering is two-stage per the repo's usual split: cheap keyword
 * include/exclude first, then an LLM topical judgment whose verdict is
 * stored for audit. DealSuggestion rows remain as the dedup + audit ledger:
 * QUEUED = a post was minted, DISMISSED = a gate said no.
 */
export function createDealSuggester(llm: LlmClient | null, stats: DealSuggestStats): DealSuggester {
  if (!config.deals.suggestions.enabled) {
    console.log("  deal suggestions: disabled (DEAL_SUGGESTIONS_ENABLED=false)");
    return { tick: async () => {}, enabled: false };
  }
  const hasLlm = llm !== null && (config.llm.useFake || Boolean(config.llm.anthropicApiKey));
  console.log(
    `  rss deal channel: enabled (RSS every ${config.deals.suggestions.intervalMinutes}m/source, ` +
      `${hasLlm ? "LLM lane gate" : "keyword gate only — no LLM key"}, ` +
      `${config.deals.suggestions.autopost ? "AUTOPOST" : "audit-only (DEAL_RSS_AUTOPOST=false)"})`,
  );

  function skip(reason: string): void {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
  }

  /** Audit rows rot fast — close them out so the ledger stays readable. */
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

  /** Record the item in the audit ledger (also the per-source guid dedup). */
  async function writeLedger(
    source: DealSuggestionSource,
    item: RssItem,
    ref: { asin: string; marketplace: string },
    hintPriceCents: number | null,
    status: SuggestionStatus,
    gateVerdict: Record<string, unknown>,
  ): Promise<void> {
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
        status,
        gateVerdict: gateVerdict as object,
      },
    });
  }

  /** Compose the PRICE-FREE deal alert. Returns null if it can't validate. */
  function composeRssDeal(
    rawTitle: string,
    sourceName: string,
    linkUrl: string,
  ): { text: string; anchor: string } | null {
    const title = shortenAmazonTitle(cleanDealTitle(rawTitle), 120)
      // Belt-and-suspenders: no $ amounts or "% off" claims survive into copy —
      // we can't attest third-party prices, so we never repeat them.
      .replace(/\$\s*[0-9][\d,.]*/g, "")
      .replace(/\b\d{1,3}\s*%\s*(?:off|discount)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[\s\-–—:,+@&]+$/g, "")
      .trim();
    if (title.length < 8) return null; // nothing meaningful left to say
    const text = `${title} is on sale right now (spotted via ${sourceName}) — ${RSS_DEAL_ANCHOR} #ad`;
    const validation = validateDealText(text, linkUrl, config.deals.postMaxLength, RSS_DEAL_ANCHOR);
    return validation.ok ? { text, anchor: RSS_DEAL_ANCHOR } : null;
  }

  /** All gates for one RSS item; queues a self-posting deal alert when
   *  everything passes. Returns true when a post was minted. */
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
    // Single-marketplace: only the configured marketplace passes.
    if (ref.marketplace !== config.paapi.marketplace) {
      skip("marketplace_mismatch");
      return false;
    }

    // The hint price is used ONLY for the source's price-band filter and the
    // audit row — it is never advertised.
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

    // Per-ASIN posting state: a banned discovered listing, an in-flight deal,
    // or a recent post all mean this item must not post again.
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

    // Daily budget for RSS-sourced posts (checked before any LLM spend).
    const rssToday = await prisma.dealPost.count({
      where: {
        source: DealSource.DISCOVERED,
        feedId: null, // RSS-sourced (PA-API feed finds carry their feedId)
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
    });
    if (rssToday >= config.deals.suggestions.maxPostsPerDay) {
      skip("daily_budget");
      return false;
    }

    // Topical lane gate. LLM errors fail CLOSED here — with no human behind
    // this pipeline, "couldn't judge" must mean "don't post".
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
          await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.DISMISSED, gateVerdict);
          return false;
        }
      } catch (error) {
        stats.errors += 1;
        skip("gate_error");
        console.warn(
          `[rssDeal] lane gate errored for "${item.title.slice(0, 60)}":`,
          error instanceof Error ? error.message : error,
        );
        return false; // no ledger row — the item retries on a later fetch
      }
    }

    // Web-search corroboration — the same last gate every unreviewed post
    // gets. Fake-LLM mode skips it (fake forces DRY_RUN; nothing publishes).
    let factCheck: Record<string, unknown> | null = null;
    if (!config.llm.useFake) {
      const verdict = await factCheckDealListing({ title: item.title, sourceName: source.name });
      if (
        !verdict ||
        !verdict.accurate ||
        verdict.confidence < config.factCheck.minConfidence
      ) {
        skip("uncorroborated");
        await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.DISMISSED, {
          ...gateVerdict,
          factCheck: verdict ?? { error: "check could not be completed" },
        });
        return false;
      }
      factCheck = verdict as unknown as Record<string, unknown>;
    }

    // Compose the price-free alert; tag the affiliate link.
    const linkUrl = withAffiliateTag(
      canonicalAmazonUrl(ref.asin, ref.marketplace),
      config.site.amazonAssociateTag,
    );
    const composed = composeRssDeal(item.title, source.name, linkUrl);
    if (!composed) {
      skip("compose_failed");
      return false;
    }

    const now = new Date();
    // DISCOVERED listing row = per-ASIN dedup/cooldown state (never polled).
    // Deliberately no imageUrl and no price fields: the poster must never
    // build a priced embed from unattested hints.
    const listingRow = await prisma.trackedListing.upsert({
      where: { asin_marketplace: { asin: ref.asin, marketplace: ref.marketplace } },
      create: {
        asin: ref.asin,
        marketplace: ref.marketplace,
        productUrl: canonicalAmazonUrl(ref.asin, ref.marketplace),
        title: shortenAmazonTitle(cleanDealTitle(item.title), 120) || item.title.slice(0, 120),
        currency: "USD",
        origin: ListingOrigin.DISCOVERED,
        armState: DealArmState.DISARMED, // never polled/armed — dedup state only
        lastCheckedAt: now,
        source: "MANUAL",
      },
      update: {},
    });

    const status =
      config.bot.dryRun || config.llm.useFake
        ? DealPostStatus.DRY_RUN
        : config.deals.suggestions.autopost
          ? DealPostStatus.READY
          : DealPostStatus.DRY_RUN; // audit-only mode: record, never publish
    await prisma.dealPost.create({
      data: {
        listingId: listingRow.id,
        source: DealSource.DISCOVERED,
        status,
        // Internal bookkeeping only — the copy and embed never show these.
        salePriceCents: hintPriceCents ?? 0,
        targetPriceCents: hintPriceCents ?? 0,
        currency: "USD",
        priceAsOf: now,
        linkUrl,
        postText: composed.text,
        linkAnchor: composed.anchor,
      },
    });
    await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.QUEUED, {
      ...gateVerdict,
      ...(factCheck ? { factCheck } : {}),
    });
    console.log(`[rssDeal] queued ${ref.asin} (${status}): ${composed.text.slice(0, 80)}`);
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
          `[rssDeal] item failed (${source.name}):`,
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
    if (queued > 0) console.log(`[rssDeal] ${source.name}: ${queued} deal post(s) queued`);
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
        console.warn(`[rssDeal] ${source.name} failed: ${message}`);
      }
    }
  }

  return { tick, enabled: true };
}
