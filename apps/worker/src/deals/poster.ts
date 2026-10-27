import type { AppBskyRichtextFacet, AtpAgent } from "@atproto/api";
import { prisma, DealPostStatus, DealSource, type DealPost, type TrackedListing } from "@trendcart/db";
import {
  composeDealPost,
  DEAL_ANCHOR,
  dealChannel,
  extractAsin,
  formatMoney,
  hashtagSpans,
  isAmazonHost,
  validateDealText,
  withAffiliateTag,
} from "@trendcart/shared";
import { blueskyAgent, blueskyLoginDisabled, noteBlueskySessionLost } from "../bluesky-agent.js";
import {
  blueskyBackingOff,
  isPermanentPostError,
  noteBlueskyDown,
  noteBlueskyUp,
} from "../bluesky-health.js";
import { config } from "../config.js";
import { isPaused } from "../heartbeat.js";
import { createTrackedLink } from "../tracking.js";

const MAX_POST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10 * 60_000;
/** Bluesky uploadBlob hard cap. */
const MAX_IMAGE_BYTES = 976_560;
const IMAGE_HOST_RE = /(^|\.)media-amazon\.com$|(^|\.)images-amazon\.com$|(^|\.)ssl-images-amazon\.com$/i;

export type DealPostStats = { posted: number; postFailed: number; disabled: boolean };
export type DealPoster = { tick: () => Promise<void>; enabled: boolean };

/** Byte-offset facets over the link anchor and every hashtag ("#ad" plus any
 *  the copy carries, e.g. #NintendoSwitch2 on a manual post). UTF-8 bytes,
 *  not JS char indices — a multibyte title shifts the offsets. The anchor is
 *  per-post (wario style links the price phrase, classic the fixed one). */
export function buildFacets(text: string, linkUrl: string, anchor: string): AppBskyRichtextFacet.Main[] {
  const enc = new TextEncoder();
  const bytes = (index: number) => enc.encode(text.slice(0, index)).length;
  const facets: AppBskyRichtextFacet.Main[] = [];
  const aIdx = text.lastIndexOf(anchor);
  if (aIdx >= 0) {
    facets.push({
      index: { byteStart: bytes(aIdx), byteEnd: bytes(aIdx + anchor.length) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: linkUrl }],
    });
  }
  for (const { start, end, tag } of hashtagSpans(text)) {
    facets.push({
      index: { byteStart: bytes(start), byteEnd: bytes(end) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }
  return facets;
}

/**
 * Publishes READY DealPosts as STANDALONE posts (no reply ref) on the bot's
 * own profile. Structural twin of the reply poster: exactly-once claim before
 * any network call, DB-derived cooldowns, login-failure disable, transient vs.
 * permanent error split. Disabled entirely under DRY_RUN.
 */
export function createDealPoster(stats: DealPostStats): DealPoster {
  if (config.bot.dryRun) {
    console.log("  deal posting:     disabled (DRY_RUN=true)");
    return { tick: async () => {}, enabled: false };
  }
  if (!config.bluesky.handle || !config.bluesky.appPassword) {
    console.warn("  deal posting:     disabled — missing Bluesky credentials");
    return { tick: async () => {}, enabled: false };
  }
  console.log(`  deal posting:     enabled as @${config.bluesky.handle}`);

  let stopped = false;

  /** The shared session; repeated credential failures there stop this loop. */
  async function ensureAgent(): Promise<AtpAgent | null> {
    const agent = await blueskyAgent();
    if (!agent && blueskyLoginDisabled()) {
      stats.disabled = true;
      stopped = true;
    }
    return agent;
  }

  /** Best-effort external-card thumbnail. Any failure → link-only post. */
  async function uploadThumb(activeAgent: AtpAgent, imageUrl: string | null): Promise<unknown | null> {
    if (!imageUrl) return null;
    try {
      const host = new URL(imageUrl).hostname;
      if (!IMAGE_HOST_RE.test(host)) return null;
      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
      const encoding = response.headers.get("content-type") ?? "image/jpeg";
      const uploaded = await activeAgent.uploadBlob(bytes, { encoding });
      return uploaded.data.blob;
    } catch {
      return null;
    }
  }

  async function terminal(id: string, status: DealPostStatus, skipReason: string): Promise<void> {
    await prisma.dealPost.update({ where: { id }, data: { status, skipReason } });
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (await isPaused()) return;
    if (blueskyBackingOff()) return; // Bluesky is down — skip until the probe window

    const candidate = await prisma.dealPost.findFirst({
      where: {
        status: DealPostStatus.READY,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, source: true },
    });
    if (!candidate) return;

    // Manual "post deal now" posts are operator-initiated — they bypass the
    // global throttles. The AUTOMATED price-trigger and DISCOVERED feed finds
    // are rate-limited here, so a burst of fires can't flood the profile.
    // CURATED (curator-account, ADR-0017) posts run on their own budget and
    // gap, and don't count against the other channels' — or vice versa.
    if (candidate.source !== DealSource.MANUAL) {
      const curated = candidate.source === DealSource.CURATED;
      const channelPosts = curated
        ? { source: DealSource.CURATED }
        : { source: { notIn: [DealSource.MANUAL, DealSource.CURATED] } };
      const cooldownMinutes = curated
        ? config.deals.curated.cooldownMinutes
        : config.deals.globalCooldownMinutes;
      const dailyCap = curated ? config.deals.curated.maxPostsPerDay : config.deals.maxPostsPerDay;
      const lastPosted = await prisma.dealPost.findFirst({
        where: {
          ...channelPosts,
          status: DealPostStatus.POSTED,
          postedAt: { not: null },
        },
        orderBy: { postedAt: "desc" },
        select: { postedAt: true },
      });
      if (
        lastPosted?.postedAt &&
        Date.now() - lastPosted.postedAt.getTime() < cooldownMinutes * 60_000
      ) {
        return;
      }
      const postedToday = await prisma.dealPost.count({
        where: {
          ...channelPosts,
          status: DealPostStatus.POSTED,
          postedAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
        },
      });
      if (postedToday >= dailyCap) return;
    }

    // CLAIM before any network call — count===1 makes publishing exactly-once.
    const claim = await prisma.dealPost.updateMany({
      where: { id: candidate.id, status: DealPostStatus.READY },
      data: { status: DealPostStatus.POSTING },
    });
    if (claim.count !== 1) return;

    const deal = await prisma.dealPost.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { listing: true },
    });
    const listing: TrackedListing = deal.listing;

    // The channel's tracking ID is applied HERE, at publish, not trusted from
    // the queue-time snapshot: rows queued before a channel got its own
    // AMAZON_TAG_* var (or by a script that still uses the base tag) would
    // otherwise post under the wrong ID and blur the per-channel report.
    // withAffiliateTag replaces any existing tag, so this is idempotent.
    const linkUrl = withAffiliateTag(
      deal.linkUrl,
      config.site.affiliateTags[dealChannel(deal.source, deal.feedId)],
    );

    // RSS-sourced posts (DISCOVERED with no feedId) and curator posts
    // (CURATED) are the PRICE-FREE channels: no price is advertised, so price
    // freshness doesn't apply and no priced embed may ever render
    // (salePriceCents is zeroed; any source price stays an unattested hint).
    const rssAutonomous =
      (deal.source === DealSource.DISCOVERED && !deal.feedId) ||
      deal.source === DealSource.CURATED;
    const priceFree = rssAutonomous || deal.salePriceCents <= 0;

    // Pre-flight: paused listing, or a price snapshot too stale to advertise.
    if (!listing.isActive) {
      await terminal(deal.id, DealPostStatus.SKIPPED, "listing was deactivated before posting");
      return;
    }
    if (
      rssAutonomous &&
      listing.lastPostedAt &&
      Date.now() - listing.lastPostedAt.getTime() <
        config.deals.perListingCooldownHours * 3_600_000
    ) {
      await terminal(deal.id, DealPostStatus.SKIPPED, "listing cooldown became active before posting");
      return;
    }
    if (!priceFree && Date.now() - deal.priceAsOf.getTime() > config.deals.maxPriceAgeHours * 3_600_000) {
      await terminal(deal.id, DealPostStatus.SKIPPED, "price snapshot too stale to post");
      return;
    }
    if (
      rssAutonomous &&
      (!deal.saleVerifiedAt ||
        Date.now() - deal.saleVerifiedAt.getTime() >
          config.deals.suggestions.verificationTtlMinutes * 60_000)
    ) {
      await terminal(
        deal.id,
        DealPostStatus.SKIPPED,
        "strict Amazon sale verification missing or stale before posting",
      );
      return;
    }

    // Recompose if the frozen copy is somehow missing; then hard-validate.
    // Legacy rows (null linkAnchor) carry classic copy on the fixed anchor.
    let text = deal.postText ?? "";
    let anchor = deal.linkAnchor ?? DEAL_ANCHOR;
    if (!text) {
      const composed = composeDealPost({
        title: listing.title,
        salePriceCents: deal.salePriceCents,
        wasPriceCents: deal.wasPriceCents,
        currency: deal.currency,
        priceAsOf: deal.priceAsOf,
        linkUrl: linkUrl,
        maxLength: config.deals.postMaxLength,
        style: config.deals.postStyle,
      });
      if ("error" in composed) {
        await terminal(deal.id, DealPostStatus.FAILED, `compose failed: ${composed.error}`);
        return;
      }
      text = composed.text;
      anchor = composed.anchor;
    }
    const validation = validateDealText(text, linkUrl, config.deals.postMaxLength, anchor);
    if (!validation.ok) {
      await terminal(deal.id, DealPostStatus.FAILED, `validation failed: ${validation.reason}`);
      return;
    }
    try {
      if (!isAmazonHost(new URL(linkUrl).hostname)) {
        await terminal(deal.id, DealPostStatus.FAILED, "link is not an Amazon URL");
        return;
      }
      if (rssAutonomous && extractAsin(linkUrl) !== listing.asin) {
        await terminal(deal.id, DealPostStatus.FAILED, "affiliate link ASIN does not match listing");
        return;
      }
    } catch {
      await terminal(deal.id, DealPostStatus.FAILED, "invalid link URL");
      return;
    }

    const activeAgent = await ensureAgent();
    if (!activeAgent) {
      await prisma.dealPost.update({
        where: { id: deal.id },
        data: { status: DealPostStatus.READY, nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
      });
      return;
    }

    try {
      const tracked = await createTrackedLink(linkUrl, "deal", deal.id);
      const facets = buildFacets(text, tracked.url, anchor);
      const thumb = priceFree ? null : await uploadThumb(activeAgent, listing.imageUrl);
      const wasClause =
        deal.wasPriceCents && deal.wasPriceCents > deal.salePriceCents
          ? ` (was ${formatMoney(deal.wasPriceCents, deal.currency)})`
          : "";
      const embed = thumb
        ? {
            $type: "app.bsky.embed.external",
            external: {
              uri: linkUrl,
              title: listing.title,
              description: `Now ${formatMoney(deal.salePriceCents, deal.currency)}${wasClause} on Amazon.`,
              thumb,
            },
          }
        : undefined;

      const result = await activeAgent.post({
        text,
        facets,
        ...(embed ? { embed } : {}),
        createdAt: new Date().toISOString(),
      });
      await prisma.$transaction([
        prisma.dealPost.update({
          where: { id: deal.id },
          // linkUrl too, so the ledger records the tag that actually went out.
          data: { status: DealPostStatus.POSTED, postUri: result.uri, postedAt: new Date(), linkUrl },
        }),
        prisma.trackedListing.update({
          where: { id: listing.id },
          data: { lastPostedAt: new Date() },
        }),
      ]);
      noteBlueskyUp();
      stats.posted += 1;
      console.log(`[dealPoster] posted deal for ${listing.asin} (${listing.title})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Bluesky outage or dead session → release the claim without burning
      // an attempt (the next tick backs off, or logs in afresh).
      if (noteBlueskyDown(error) || noteBlueskySessionLost(error)) {
        await prisma.dealPost.update({
          where: { id: deal.id },
          data: { status: DealPostStatus.READY },
        });
        return;
      }
      const attempts = deal.attemptCount + 1;
      if (isPermanentPostError(error) || attempts >= MAX_POST_ATTEMPTS) {
        await prisma.dealPost.update({
          where: { id: deal.id },
          data: {
            status: DealPostStatus.FAILED,
            skipReason: `post failed (attempt ${attempts}): ${message}`,
            attemptCount: attempts,
          },
        });
        stats.postFailed += 1;
        console.error(`[dealPoster] permanent post failure for ${listing.asin}: ${message}`);
      } else {
        await prisma.dealPost.update({
          where: { id: deal.id },
          data: {
            status: DealPostStatus.READY,
            attemptCount: attempts,
            nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
          },
        });
        console.warn(`[dealPoster] transient post error (attempt ${attempts}), will retry: ${message}`);
      }
    }
  }

  return { tick, enabled: true };
}

/** Exported for the checker's stat typing (kept beside the poster it feeds). */
export type { DealPost };
