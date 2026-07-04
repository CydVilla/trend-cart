import {
  prisma,
  DealArmState,
  DealPostStatus,
  DealSource,
  type TrackedListing,
} from "@trendcart/db";
import { canonicalAmazonUrl, composeDealPost, withAffiliateTag } from "@trendcart/shared";
import { config } from "../config.js";
import { getOperatorFlags } from "../heartbeat.js";
import { createPaapiClient, PaapiAuthError, type PaapiItem } from "../paapi.js";

export type DealCheckStats = {
  checked: number;
  fired: number;
  deferred: number;
  errors: number;
  backoffs: number;
};

export type DealChecker = { tick: () => Promise<void>; enabled: boolean };

/**
 * Polls tracked listings via PA-API and runs the target-price trigger with
 * re-arm hysteresis. The exactly-once boundary is the ARMED→FIRED claim
 * (updateMany count===1), so overlapping ticks or a crashed+restarted worker
 * can never double-fire. Stands down to a noop when PA-API keys are absent —
 * the manual "post deal now" path still works.
 */
export function createDealChecker(stats: DealCheckStats): DealChecker {
  const client = createPaapiClient();
  if (!client) {
    console.warn("  deal check:       disabled (no PA-API credentials — manual path only)");
    return { tick: async () => {}, enabled: false };
  }
  console.log("  deal check:       enabled (PA-API GetItems)");
  let backoffUntil = 0;

  /** Crash between the ARMED→FIRED claim and the DealPost create leaves a
   *  stranded FIRED row; put it back where it belongs. Safe: a listing with a
   *  matching DealPost becomes DISARMED, one without becomes ARMED (retry). */
  async function recoverStranded(): Promise<void> {
    const stranded = await prisma.trackedListing.findMany({
      where: { armState: DealArmState.FIRED },
      select: { id: true, lastPriceAsOf: true },
    });
    for (const row of stranded) {
      const since = row.lastPriceAsOf ?? new Date(0);
      const hasPost = await prisma.dealPost.findFirst({
        where: { listingId: row.id, createdAt: { gte: since } },
        select: { id: true },
      });
      await prisma.trackedListing.update({
        where: { id: row.id },
        data: { armState: hasPost ? DealArmState.DISARMED : DealArmState.ARMED },
      });
    }
  }

  async function handleListing(listing: TrackedListing, item: PaapiItem | undefined): Promise<void> {
    const now = new Date();

    // Not returned (not found / throttled / Errors[]) — back off this ASIN and
    // auto-deactivate a listing that keeps failing, never spam-checking it.
    if (!item) {
      const errors = listing.consecutiveErrors + 1;
      await prisma.trackedListing.update({
        where: { id: listing.id },
        data: {
          consecutiveErrors: errors,
          lastCheckError: "not returned by PA-API (not found or throttled)",
          lastCheckedAt: now,
          nextCheckAt: new Date(Date.now() + config.deals.listingErrorBackoffHours * 3_600_000),
          ...(errors >= config.deals.maxConsecutiveErrors ? { isActive: false } : {}),
        },
      });
      stats.errors += 1;
      return;
    }

    stats.checked += 1;
    const currencyOk = !item.currency || item.currency === listing.currency;
    const priceCents = currencyOk ? item.priceCents : null;

    const data: Record<string, unknown> = {
      consecutiveErrors: 0,
      lastCheckError: currencyOk ? null : `currency mismatch (${item.currency} vs ${listing.currency})`,
      lastAvailability: item.available ? "in stock" : "unavailable",
      lastCheckedAt: now,
      nextCheckAt: new Date(Date.now() + config.deals.listingRecheckMs),
      source: "PAAPI",
      ...(priceCents != null ? { lastPriceCents: priceCents, lastPriceAsOf: now } : {}),
    };

    // Re-arm (DISARMED → ARMED) only when the price rises strictly above the
    // hysteresis buffer, so a price hovering around target doesn't flap.
    let armState = listing.armState;
    if (armState === DealArmState.DISARMED && priceCents != null) {
      const rearmThreshold = Math.ceil(
        listing.targetPriceCents * (1 + config.deals.rearmBufferPct / 100),
      );
      if (priceCents > rearmThreshold) {
        armState = DealArmState.ARMED;
        data.armState = DealArmState.ARMED;
      }
    }

    const canFire =
      armState === DealArmState.ARMED &&
      item.available &&
      priceCents != null &&
      priceCents <= listing.targetPriceCents;
    if (!canFire) {
      await prisma.trackedListing.update({ where: { id: listing.id }, data });
      return;
    }

    // Identical-price dedup: this exact price already fired — disarm, no post.
    if (listing.lastPostedPriceCents != null && priceCents === listing.lastPostedPriceCents) {
      await prisma.trackedListing.update({
        where: { id: listing.id },
        data: { ...data, armState: DealArmState.DISARMED },
      });
      return;
    }

    // DEFER gates (stay ARMED, retry next tick): per-listing cooldown + cap.
    const cooldownBlocked =
      listing.lastPostedAt != null &&
      Date.now() - listing.lastPostedAt.getTime() <
        config.deals.perListingCooldownHours * 3_600_000;
    const queuedToday = await prisma.dealPost.count({
      where: {
        status: {
          in: [
            DealPostStatus.POSTED,
            DealPostStatus.POSTING,
            DealPostStatus.READY,
            DealPostStatus.PENDING,
            DealPostStatus.DRY_RUN,
          ],
        },
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
    });
    if (cooldownBlocked || queuedToday >= config.deals.maxPostsPerDay) {
      stats.deferred += 1;
      await prisma.trackedListing.update({ where: { id: listing.id }, data });
      return;
    }

    // Persist the poll result, then FIRE via the exactly-once claim.
    await prisma.trackedListing.update({ where: { id: listing.id }, data });
    const claim = await prisma.trackedListing.updateMany({
      where: { id: listing.id, armState: DealArmState.ARMED },
      data: { armState: DealArmState.FIRED },
    });
    if (claim.count !== 1) return; // another tick already fired this listing

    const linkUrl = withAffiliateTag(
      canonicalAmazonUrl(listing.asin, listing.marketplace),
      config.site.amazonAssociateTag,
    );
    const composed = composeDealPost({
      title: listing.title,
      salePriceCents: priceCents,
      wasPriceCents: item.wasPriceCents,
      currency: listing.currency,
      priceAsOf: now,
      linkUrl,
      maxLength: config.deals.postMaxLength,
    });
    const dryRun = config.bot.dryRun;
    const status = dryRun
      ? DealPostStatus.DRY_RUN
      : "error" in composed
        ? DealPostStatus.PENDING
        : DealPostStatus.READY;
    await prisma.dealPost.create({
      data: {
        listingId: listing.id,
        source: DealSource.AUTOMATED,
        status,
        salePriceCents: priceCents,
        targetPriceCents: listing.targetPriceCents,
        wasPriceCents: item.wasPriceCents ?? null,
        currency: listing.currency,
        priceAsOf: now,
        linkUrl,
        postText: "error" in composed ? null : composed.text,
      },
    });
    await prisma.trackedListing.update({
      where: { id: listing.id },
      data: {
        armState: DealArmState.DISARMED,
        lastPostedPriceCents: priceCents,
        ...(dryRun ? {} : { lastPostedAt: new Date() }),
      },
    });
    stats.fired += 1;
    console.log(
      `[dealCheck] FIRED ${listing.asin} @ ${priceCents}¢ (target ${listing.targetPriceCents}¢)`,
    );
  }

  async function tick(): Promise<void> {
    if ((await getOperatorFlags()).paused) return;
    if (Date.now() < backoffUntil) return;

    await recoverStranded();

    const due = await prisma.trackedListing.findMany({
      where: {
        isActive: true,
        marketplace: config.paapi.marketplace, // v1: only the configured marketplace
        armState: { in: [DealArmState.ARMED, DealArmState.DISARMED] },
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
      },
      orderBy: { nextCheckAt: { sort: "asc", nulls: "first" } },
      take: 10, // one GetItems call
    });
    if (due.length === 0) return;

    let items: Map<string, PaapiItem>;
    try {
      items = await client!.getItemsByAsin(due.map((l) => l.asin));
    } catch (error) {
      if (error instanceof PaapiAuthError) {
        console.error(`[dealCheck] ${error.message} — disabling checks until restart`);
        backoffUntil = Number.MAX_SAFE_INTEGER;
        return;
      }
      stats.backoffs += 1;
      const jitter = 1 + Math.random();
      backoffUntil = Date.now() + Math.min(config.deals.paapiMaxBackoffMs, config.deals.paapiBaseBackoffMs * jitter);
      console.warn(
        `[dealCheck] PA-API error — backing off: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    for (const listing of due) {
      try {
        await handleListing(listing, items.get(listing.asin));
      } catch (error) {
        stats.errors += 1;
        console.error(
          `[dealCheck] listing ${listing.asin} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return { tick, enabled: true };
}
