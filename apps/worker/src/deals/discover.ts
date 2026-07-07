import {
  prisma,
  DealArmState,
  DealPostStatus,
  DealSource,
  ListingOrigin,
  type DealFeed,
} from "@trendcart/db";
import { canonicalAmazonUrl, composeDealPost, withAffiliateTag } from "@trendcart/shared";
import { config } from "../config.js";
import { getOperatorFlags } from "../heartbeat.js";
import { createPaapiClient, PaapiAuthError, type PaapiItem } from "../paapi.js";

export type DealDiscoverStats = {
  feeds: number;
  found: number;
  queued: number;
  expired: number;
  skipped: Record<string, number>;
  errors: number;
  backoffs: number;
};

export function newDealDiscoverStats(): DealDiscoverStats {
  return { feeds: 0, found: 0, queued: 0, expired: 0, skipped: {}, errors: 0, backoffs: 0 };
}

export type DealDiscoverer = { tick: () => Promise<void>; enabled: boolean };

/** v1 is single-marketplace; prices from www.amazon.com are USD. */
const MARKETPLACE_CURRENCY = "USD";

/**
 * Wario64-style deal discovery: polls each active DealFeed via PA-API
 * SearchItems (server-side MinSavingPercent filter — only products currently
 * on sale come back), re-verifies every gate server-side, and queues passing
 * items as DealPosts. Discovered ASINs get a DISCOVERED TrackedListing row as
 * per-ASIN dedup/cooldown state — never polled by the price checker.
 *
 * Anti-spam posture is tighter than the watchlist trigger: discovered deals
 * queue for operator approval unless DEAL_FEED_AUTOPOST=true, spend a separate
 * (smaller) daily budget, and a pending approval expires as soon as its price
 * snapshot is too stale to advertise.
 */
export function createDealDiscoverer(stats: DealDiscoverStats): DealDiscoverer {
  const client = createPaapiClient();
  if (!client) {
    console.warn("  deal discovery:   disabled (no PA-API credentials)");
    return { tick: async () => {}, enabled: false };
  }
  if (!config.site.amazonAssociateTag) {
    console.warn("  deal discovery:   disabled (AMAZON_ASSOCIATE_TAG unset)");
    return { tick: async () => {}, enabled: false };
  }
  console.log(
    `  deal discovery:   enabled (each feed every ${config.deals.discovery.intervalMinutes}m, ` +
      `${config.deals.discovery.autopost ? "AUTOPOST" : "approval queue"})`,
  );
  let backoffUntil = 0;

  function skip(reason: string): false {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    return false;
  }

  /** Deals are perishable: a discovered deal nobody approved before its price
   *  snapshot aged out can never publish (the poster would refuse it) — close
   *  it out so the queue only ever shows actionable deals. */
  async function expireStaleApprovals(): Promise<void> {
    const cutoff = new Date(Date.now() - config.deals.maxPriceAgeHours * 3_600_000);
    const expired = await prisma.dealPost.updateMany({
      where: { status: DealPostStatus.PENDING_APPROVAL, priceAsOf: { lt: cutoff } },
      data: {
        status: DealPostStatus.SKIPPED,
        skipReason: "price snapshot went stale awaiting approval",
      },
    });
    stats.expired += expired.count;
  }

  /** All server-side gates for one search result. Returns true when queued. */
  async function handleItem(feed: DealFeed, item: PaapiItem): Promise<boolean> {
    const now = new Date();
    const marketplace = config.paapi.marketplace;

    if (item.priceCents == null || !item.title) return skip("no_price_or_title");
    if (!item.available) return skip("unavailable");
    if (item.currency && item.currency !== MARKETPLACE_CURRENCY) return skip("currency_mismatch");
    // "On sale" means a real strikethrough: Amazon's own list price
    // (SavingBasis) exists and the offer sits below it. Re-verify the % —
    // the API-side MinSavingPercent filter is never trusted alone.
    if (item.wasPriceCents == null || item.wasPriceCents <= item.priceCents) {
      return skip("no_real_discount");
    }
    const pct = Math.round(((item.wasPriceCents - item.priceCents) / item.wasPriceCents) * 100);
    if (pct < feed.minSavingPercent) return skip("below_min_discount");
    if (feed.minPriceCents != null && item.priceCents < feed.minPriceCents) {
      return skip("below_price_floor");
    }
    if (feed.maxPriceCents != null && item.priceCents > feed.maxPriceCents) {
      return skip("above_price_ceiling");
    }
    // Quality floors apply only when Amazon returned review data.
    if (feed.minReviewCount > 0 && item.reviewCount != null && item.reviewCount < feed.minReviewCount) {
      return skip("too_few_reviews");
    }
    if (
      feed.minReviewRating > 0 &&
      item.reviewRating != null &&
      item.reviewRating < feed.minReviewRating
    ) {
      return skip("rating_too_low");
    }

    // Per-ASIN state: the watchlist trigger owns its own ASINs; a deactivated
    // DISCOVERED row is the operator's "never post this again".
    const existing = await prisma.trackedListing.findUnique({
      where: { asin_marketplace: { asin: item.asin, marketplace } },
    });
    if (existing) {
      if (existing.origin === ListingOrigin.WATCHLIST) return skip("on_watchlist");
      if (!existing.isActive) return skip("listing_paused");
      if (existing.lastPostedPriceCents === item.priceCents) return skip("identical_price");
      if (
        existing.lastPostedAt &&
        now.getTime() - existing.lastPostedAt.getTime() <
          config.deals.perListingCooldownHours * 3_600_000
      ) {
        return skip("listing_cooldown");
      }
      const inFlight = await prisma.dealPost.findFirst({
        where: {
          listingId: existing.id,
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
      if (inFlight) return skip("already_queued");
    }

    // Budgets — checked before any row is written, so a capped item leaves no
    // dedup state behind and can re-qualify tomorrow. Discovered deals spend
    // their own (smaller) budget inside the global one, so a hot feed can
    // never starve the operator's hand-picked watchlist alerts.
    const activeStatuses = [
      DealPostStatus.POSTED,
      DealPostStatus.POSTING,
      DealPostStatus.READY,
      DealPostStatus.PENDING,
      DealPostStatus.PENDING_APPROVAL,
      DealPostStatus.DRY_RUN,
    ];
    const dayAgo = new Date(Date.now() - 24 * 3_600_000);
    const queuedToday = await prisma.dealPost.count({
      where: { status: { in: activeStatuses }, createdAt: { gte: dayAgo } },
    });
    if (queuedToday >= config.deals.maxPostsPerDay) return skip("daily_cap");
    const discoveredToday = await prisma.dealPost.count({
      where: {
        source: DealSource.DISCOVERED,
        status: { in: activeStatuses },
        createdAt: { gte: dayAgo },
      },
    });
    if (discoveredToday >= config.deals.discovery.maxPostsPerDay) return skip("feed_daily_cap");

    const linkUrl = withAffiliateTag(
      canonicalAmazonUrl(item.asin, marketplace),
      config.site.amazonAssociateTag,
    );
    const composed = composeDealPost({
      title: item.title,
      salePriceCents: item.priceCents,
      wasPriceCents: item.wasPriceCents,
      currency: MARKETPLACE_CURRENCY,
      priceAsOf: now,
      linkUrl,
      maxLength: config.deals.postMaxLength,
      style: config.deals.postStyle,
    });
    if ("error" in composed) return skip("compose_failed");

    // Queue-time dedup stamp (lastPostedPriceCents), same semantics as the
    // checker's fire-time stamp: an operator-rejected deal at this price is
    // not re-surfaced every tick; a NEW price re-qualifies immediately.
    const listing = await prisma.trackedListing.upsert({
      where: { asin_marketplace: { asin: item.asin, marketplace } },
      create: {
        asin: item.asin,
        marketplace,
        productUrl: canonicalAmazonUrl(item.asin, marketplace),
        title: item.title.slice(0, 300),
        imageUrl: item.imageUrl,
        fullPriceCents: item.wasPriceCents,
        currency: MARKETPLACE_CURRENCY,
        origin: ListingOrigin.DISCOVERED,
        armState: DealArmState.DISARMED, // never polled/armed — dedup state only
        lastPriceCents: item.priceCents,
        lastPriceAsOf: now,
        lastPostedPriceCents: item.priceCents,
        lastCheckedAt: now,
        lastAvailability: "in stock",
        source: "PAAPI",
      },
      update: {
        title: item.title.slice(0, 300),
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        fullPriceCents: item.wasPriceCents,
        lastPriceCents: item.priceCents,
        lastPriceAsOf: now,
        lastPostedPriceCents: item.priceCents,
        lastCheckedAt: now,
        lastAvailability: "in stock",
        source: "PAAPI",
      },
    });

    const status = config.bot.dryRun
      ? DealPostStatus.DRY_RUN
      : config.deals.discovery.autopost
        ? DealPostStatus.READY
        : DealPostStatus.PENDING_APPROVAL;
    await prisma.dealPost.create({
      data: {
        listingId: listing.id,
        feedId: feed.id,
        source: DealSource.DISCOVERED,
        status,
        salePriceCents: item.priceCents,
        targetPriceCents: item.priceCents,
        wasPriceCents: item.wasPriceCents,
        currency: MARKETPLACE_CURRENCY,
        priceAsOf: now,
        linkUrl,
        postText: composed.text,
        linkAnchor: composed.anchor,
      },
    });
    console.log(`[dealDiscover] queued ${item.asin} @ ${item.priceCents}¢ (${pct}% off, ${status})`);
    return true;
  }

  async function runFeed(feed: DealFeed): Promise<void> {
    stats.feeds += 1;
    const startedAt = new Date();
    let found = 0;
    let queued = 0;
    for (let page = 1; page <= Math.max(1, config.deals.discovery.pagesPerFeed); page += 1) {
      const items = await client!.searchItems({
        keywords: feed.keywords,
        searchIndex: feed.searchIndex,
        minSavingPercent: feed.minSavingPercent,
        minPriceCents: feed.minPriceCents,
        maxPriceCents: feed.maxPriceCents,
        minReviewRating: feed.minReviewRating > 0 ? feed.minReviewRating : null,
        amazonOnly: feed.amazonOnly,
        itemPage: page,
      });
      found += items.length;
      for (const item of items) {
        try {
          if (await handleItem(feed, item)) queued += 1;
        } catch (error) {
          stats.errors += 1;
          console.error(
            `[dealDiscover] item ${item.asin} failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      if (items.length < 10) break; // short page = no more results
    }
    stats.found += found;
    stats.queued += queued;
    await prisma.dealFeed.update({
      where: { id: feed.id },
      data: { lastRunAt: startedAt, lastFoundCount: found, lastQueuedCount: queued, lastRunError: null },
    });
  }

  async function tick(): Promise<void> {
    if ((await getOperatorFlags()).paused) return;
    if (Date.now() < backoffUntil) return;

    await expireStaleApprovals();

    const due = await prisma.dealFeed.findMany({
      where: {
        isActive: true,
        OR: [
          { lastRunAt: null }, // "Run now" resets this
          { lastRunAt: { lte: new Date(Date.now() - config.deals.discovery.intervalMinutes * 60_000) } },
        ],
      },
      orderBy: { lastRunAt: { sort: "asc", nulls: "first" } },
      take: Math.max(1, config.deals.discovery.feedsPerTick),
    });

    for (const feed of due) {
      try {
        await runFeed(feed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Stamp the run either way — a broken feed must wait its full
        // interval out instead of hot-looping the API.
        await prisma.dealFeed
          .update({ where: { id: feed.id }, data: { lastRunAt: new Date(), lastRunError: message } })
          .catch(() => {});
        if (error instanceof PaapiAuthError) {
          console.error(`[dealDiscover] ${message} — disabling discovery until restart`);
          backoffUntil = Number.MAX_SAFE_INTEGER;
          return;
        }
        stats.backoffs += 1;
        const jitter = 1 + Math.random();
        backoffUntil =
          Date.now() +
          Math.min(config.deals.paapiMaxBackoffMs, config.deals.paapiBaseBackoffMs * jitter);
        console.warn(`[dealDiscover] PA-API error — backing off: ${message}`);
        return;
      }
    }
  }

  return { tick, enabled: true };
}
