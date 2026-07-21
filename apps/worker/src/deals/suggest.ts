import {
  prisma,
  DealArmState,
  DealPostStatus,
  DealSource,
  ListingOrigin,
  SuggestionStatus,
  Prisma,
  type DealSuggestionSource,
} from "@trendcart/db";
import {
  canonicalAmazonUrl,
  cleanDealTitle,
  shortenAmazonTitle,
  validateDealText,
  withAffiliateTag,
  type HighConversionLane,
  type LlmClient,
} from "@trendcart/shared";
import { config } from "../config.js";
import { dealVerdictPasses, factCheckDealListing } from "../factcheck.js";
import { getOperatorFlags } from "../heartbeat.js";
import {
  HIGH_CONVERSION_LANES,
  GIFTABLE_MAX_PRICE_CENTS,
  effectiveCandidateScore,
  hasFreshSaleTimestamp,
  heuristicLane,
  scoreCandidate,
  type LanePerformance,
} from "./rank.js";
import {
  extractPriceHintCents,
  matchAmazonProduct,
  parseRssItems,
  stripUnverifiedPriceClaims,
  type RssItem,
} from "./rss.js";

export type DealSuggestStats = {
  sources: number;
  items: number;
  candidates: number;
  promoted: number;
  suggested: number;
  expired: number;
  skipped: Record<string, number>;
  errors: number;
};

export function newDealSuggestStats(): DealSuggestStats {
  return {
    sources: 0,
    items: 0,
    candidates: 0,
    promoted: 0,
    suggested: 0,
    expired: 0,
    skipped: {},
    errors: 0,
  };
}

export type DealSuggester = { tick: () => Promise<void>; enabled: boolean };

const FETCH_TIMEOUT_MS = 15_000;
/** Feeds ~1MB would be pathological; cap what we'll parse. */
const MAX_FEED_BYTES = 2_000_000;
/** The clickable phrase the affiliate link rides on (price-free channel). */
const RSS_DEAL_ANCHOR = "check Amazon's current offer";
const PERFORMANCE_WINDOW_MS = 30 * 24 * 3_600_000;
const MOMENTUM_WINDOW_MS = 7 * 24 * 3_600_000;
const MAX_CLICKS_PER_POST_FOR_RANKING = 5;
const STALE_VERIFICATION_CLAIM_MS = 10 * 60_000;

type JsonRecord = Record<string, unknown>;

class PromotionBlocked extends Error {
  constructor(
    readonly reason: string,
    readonly retryable = false,
  ) {
    super(reason);
    this.name = "PromotionBlocked";
  }
}

type CandidateMeta = {
  lane: HighConversionLane;
  baseScore: number;
  publishedAt: Date | null;
  amazonMatchConfidence: number;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseCandidateMeta(value: unknown): CandidateMeta | null {
  const candidate = record(record(value).candidate);
  const lane = candidate.lane;
  if (typeof lane !== "string" || !(lane in HIGH_CONVERSION_LANES) || lane === "other") return null;
  const publishedRaw = candidate.publishedAt;
  const publishedAt = typeof publishedRaw === "string" ? new Date(publishedRaw) : null;
  return {
    lane: lane as HighConversionLane,
    baseScore: numberValue(candidate.baseScore),
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    amazonMatchConfidence: numberValue(candidate.amazonMatchConfidence),
  };
}

/**
 * The no-PA-API Wario64 bridge, fully AUTOMATED: polls deal RSS feeds
 * (Slickdeals etc.), extracts Amazon items, gates them into topical lanes,
 * ranks the survivors across sources, verifies the winner with a strict
 * web-search sale check, and queues a SELF-POSTING alert on the bot's profile.
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
    const now = Date.now();
    const cutoff = new Date(now - config.deals.suggestions.expireHours * 3_600_000);
    // A process can die during the external fact check. Release a recent,
    // stale claim so another tick can retry; truly old candidates expire below.
    await prisma.dealSuggestion.updateMany({
      where: {
        status: SuggestionStatus.VERIFYING,
        createdAt: { gte: cutoff },
        OR: [
          { verificationStartedAt: null },
          { verificationStartedAt: { lt: new Date(now - STALE_VERIFICATION_CLAIM_MS) } },
        ],
      },
      data: { status: SuggestionStatus.NEW, verificationStartedAt: null },
    });
    const expired = await prisma.dealSuggestion.updateMany({
      where: {
        status: { in: [SuggestionStatus.NEW, SuggestionStatus.VERIFYING] },
        createdAt: { lt: cutoff },
      },
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
  ): Promise<string> {
    const row = await prisma.dealSuggestion.create({
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
        gateVerdict: gateVerdict as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** "Tech & electronics (Slickdeals)" → "Slickdeals": the attribution names
   *  the deal SITE, not our internal lane. */
  function attributionLabel(sourceName: string): string {
    const site = sourceName.match(/\(([^)]+)\)\s*$/);
    return site ? site[1]! : sourceName;
  }

  /** Compose the PRICE-FREE deal alert. Returns null if it can't validate. */
  function composeRssDeal(
    rawTitle: string,
    sourceName: string,
    linkUrl: string,
  ): { text: string; anchor: string } | null {
    // Belt-and-suspenders: external money/discount claims never survive. The
    // strict verifier can establish a sale, not an Amazon-attested price.
    const title = stripUnverifiedPriceClaims(
      shortenAmazonTitle(cleanDealTitle(rawTitle), 120),
    )
      .replace(/\s{2,}/g, " ")
      .replace(/[\s\-–—:,+@&]+$/g, "")
      .trim();
    if (title.length < 8) return null; // nothing meaningful left to say
    const text = `Deal spotted via ${attributionLabel(sourceName)}: ${title} is currently discounted on Amazon — ${RSS_DEAL_ANCHOR} #ad`;
    const validation = validateDealText(text, linkUrl, config.deals.postMaxLength, RSS_DEAL_ANCHOR);
    return validation.ok ? { text, anchor: RSS_DEAL_ANCHOR } : null;
  }

  async function listingBlock(ref: { asin: string; marketplace: string }): Promise<string | null> {
    const listing = await prisma.trackedListing.findUnique({
      where: { asin_marketplace: { asin: ref.asin, marketplace: ref.marketplace } },
      select: { id: true, isActive: true, lastPostedAt: true },
    });
    if (!listing) return null;
    if (!listing.isActive) return "listing_banned";
    if (
      listing.lastPostedAt &&
      Date.now() - listing.lastPostedAt.getTime() <
        config.deals.perListingCooldownHours * 3_600_000
    ) {
      return "listing_cooldown";
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
    return inFlight ? "already_queued" : null;
  }

  /** Cheap and semantic gates stage a NEW candidate. Expensive sale
   * verification and scarce posting slots are deliberately deferred until
   * every due source has had a chance to contribute. */
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

    const ref = matchAmazonProduct(item);
    if (!ref) {
      skip("no_or_ambiguous_amazon_link");
      return false;
    }
    if (ref.matchConfidence < config.deals.suggestions.minAmazonMatchConfidence) {
      skip("weak_amazon_match");
      return false;
    }
    // Single-marketplace: only the configured marketplace passes.
    if (ref.marketplace !== config.paapi.marketplace) {
      skip("marketplace_mismatch");
      return false;
    }

    // The hint price is used ONLY for the source's price-band filter and the
    // audit row — it is never advertised.
    const hintPriceCents = extractPriceHintCents(item.title, item.description, item.content);
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

    // A current-sale claim cannot rest on an undated or stale feed item. This
    // is checked before LLM spend and checked again before promotion.
    const policyNow = new Date();
    if (
      !item.publishedAt ||
      !hasFreshSaleTimestamp(
        item.publishedAt,
        policyNow,
        config.deals.suggestions.maxSaleEvidenceAgeHours,
      )
    ) {
      const reason = !item.publishedAt
        ? "missing_feed_timestamp"
        : item.publishedAt.getTime() > policyNow.getTime()
          ? "future_feed_timestamp"
          : "stale_feed_evidence";
      skip(reason);
      await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.DISMISSED, {
        mode: "policy",
        reason:
          reason === "missing_feed_timestamp"
            ? "feed item has no publication time"
            : reason === "future_feed_timestamp"
              ? "feed publication time is implausibly far in the future"
              : "feed item is too old to support a current Amazon sale",
        amazonMatch: {
          confidence: ref.matchConfidence,
          evidence: ref.evidence,
        },
      });
      return false;
    }

    const blocked = await listingBlock(ref);
    if (blocked) {
      skip(blocked);
      return false;
    }

    // Topical lane gate. LLM errors fail CLOSED here — with no human behind
    // this pipeline, "couldn't judge" must mean "don't post".
    let lane = heuristicLane(item.title, `${source.name} ${source.topic}`, hintPriceCents);
    let topicConfidence = lane === "other" ? 0 : 70;
    let purchaseIntentScore = lane === "other" ? 0 : 65;
    let gateVerdict: Record<string, unknown> = { mode: "heuristic" };
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
        lane = verdict.highConversionLane;
        topicConfidence = verdict.confidence;
        purchaseIntentScore = verdict.purchaseIntentScore;
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

    // With an LLM available, `other` is a deliberate fail-closed verdict.
    // Heuristic mode likewise stages only an explicit high-conversion match.
    if (lane === "other") {
      skip("outside_high_conversion_lanes");
      await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.DISMISSED, {
        ...gateVerdict,
        reason: "outside the configured high-conversion lanes",
      });
      return false;
    }

    // "Under $75" is the one lane whose definition is a hard price ceiling.
    // Without PA-API the feed hint is not safe to advertise, but it is still
    // the only available eligibility signal; missing/over-cap hints fail closed.
    if (
      lane === "giftable-under-75" &&
      (hintPriceCents == null ||
        hintPriceCents <= 0 ||
        hintPriceCents > GIFTABLE_MAX_PRICE_CENTS)
    ) {
      skip("giftable_price_unverified_or_over_cap");
      await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.DISMISSED, {
        ...gateVerdict,
        reason: "giftable-under-75 requires a positive feed hint at or below $75",
      });
      return false;
    }

    const scored = scoreCandidate({
      lane,
      topicConfidence,
      purchaseIntentScore,
      amazonMatchConfidence: ref.matchConfidence,
      publishedAt: item.publishedAt,
      hintPriceCents,
    });
    const candidateVerdict: JsonRecord = {
      ...gateVerdict,
      candidate: {
        lane,
        baseScore: scored.score,
        breakdown: scored.breakdown,
        topicConfidence,
        purchaseIntentScore,
        amazonMatchConfidence: ref.matchConfidence,
        amazonMatchEvidence: ref.evidence,
        publishedAt: item.publishedAt.toISOString(),
      },
    };
    if (scored.score < config.deals.suggestions.minCandidateScore) {
      skip("candidate_score_below_floor");
      await writeLedger(
        source,
        item,
        ref,
        hintPriceCents,
        SuggestionStatus.DISMISSED,
        candidateVerdict,
      );
      return false;
    }

    // Cross-source ASIN dedup: keep the stronger staged version so identical
    // front-page feeds cannot crowd the queue with the same product.
    const stagedDuplicate = await prisma.dealSuggestion.findFirst({
      where: {
        asin: ref.asin,
        marketplace: ref.marketplace,
        status: SuggestionStatus.NEW,
      },
      select: { id: true, gateVerdict: true },
      orderBy: { createdAt: "desc" },
    });
    if (stagedDuplicate) {
      const priorScore = parseCandidateMeta(stagedDuplicate.gateVerdict)?.baseScore ?? 0;
      if (priorScore >= scored.score) {
        skip("weaker_cross_source_duplicate");
        await writeLedger(source, item, ref, hintPriceCents, SuggestionStatus.DISMISSED, {
          ...candidateVerdict,
          duplicateOf: stagedDuplicate.id,
        });
        return false;
      }
      await prisma.dealSuggestion.update({
        where: { id: stagedDuplicate.id },
        data: {
          status: SuggestionStatus.DISMISSED,
          gateVerdict: {
            ...record(stagedDuplicate.gateVerdict),
            supersededByStrongerCandidate: true,
          } as Prisma.InputJsonValue,
        },
      });
    }

    await writeLedger(
      source,
      item,
      ref,
      hintPriceCents,
      SuggestionStatus.NEW,
      candidateVerdict,
    );
    stats.candidates += 1;
    console.log(
      `[rssDeal] staged ${ref.asin} lane=${lane} score=${scored.score} (${ref.evidence})`,
    );
    return true;
  }

  async function lanePerformance(): Promise<Map<HighConversionLane, LanePerformance>> {
    const cutoff = new Date(Date.now() - PERFORMANCE_WINDOW_MS);
    const posts = await prisma.dealPost.findMany({
      where: {
        status: DealPostStatus.POSTED,
        laneKey: { not: null },
        postedAt: { gte: cutoff },
      },
      select: {
        id: true,
        laneKey: true,
        postedAt: true,
        likeCount: true,
        repostCount: true,
        replyCount: true,
        quoteCount: true,
      },
    });
    const ids = posts.map((post) => post.id);
    const links =
      ids.length > 0
        ? await prisma.trackedLink.findMany({
            where: { kind: "deal", sourceId: { in: ids } },
            select: { sourceId: true, clickCount: true },
          })
        : [];
    const clicks = new Map<string, number>();
    const trackedPostIds = new Set<string>();
    for (const link of links) {
      if (!link.sourceId) continue;
      trackedPostIds.add(link.sourceId);
      clicks.set(
        link.sourceId,
        Math.min(
          MAX_CLICKS_PER_POST_FOR_RANKING,
          (clicks.get(link.sourceId) ?? 0) + link.clickCount,
        ),
      );
    }
    const result = new Map<HighConversionLane, LanePerformance>();
    const momentumCutoff = Date.now() - MOMENTUM_WINDOW_MS;
    for (const post of posts) {
      if (!post.laneKey || !(post.laneKey in HIGH_CONVERSION_LANES) || post.laneKey === "other") {
        continue;
      }
      const lane = post.laneKey as HighConversionLane;
      const current = result.get(lane) ?? {
        posts: 0,
        trackedPosts: 0,
        clicks: 0,
        engagements: 0,
        recentSuccesses: 0,
      };
      const postClicks = clicks.get(post.id) ?? 0;
      const rawEngagement =
        post.likeCount + post.replyCount + post.repostCount * 2 + post.quoteCount * 2;
      current.posts += 1;
      if (trackedPostIds.has(post.id)) current.trackedPosts += 1;
      current.clicks += postClicks;
      current.engagements += Math.min(3, rawEngagement);
      if (
        post.postedAt &&
        post.postedAt.getTime() >= momentumCutoff &&
        (postClicks > 0 || rawEngagement >= 2)
      ) {
        current.recentSuccesses += 1;
      }
      result.set(lane, current);
    }
    return result;
  }

  async function remainingCapacity(): Promise<number> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const auditOnly = config.bot.dryRun || !config.deals.suggestions.autopost;
    const timeWindow: Prisma.DealPostWhereInput = auditOnly
      ? { status: DealPostStatus.DRY_RUN, createdAt: { gte: since } }
      : {
          OR: [
            { status: DealPostStatus.POSTED, postedAt: { gte: since } },
            {
              status: {
                in: [
                  DealPostStatus.PENDING,
                  DealPostStatus.PENDING_APPROVAL,
                  DealPostStatus.READY,
                  DealPostStatus.POSTING,
                ],
              },
              createdAt: { gte: since },
            },
          ],
        };
    const [rssUsed, globalUsed] = await Promise.all([
      prisma.dealPost.count({
        where: {
          source: DealSource.DISCOVERED,
          feedId: null,
          ...timeWindow,
        },
      }),
      prisma.dealPost.count({
        where: { source: { not: DealSource.MANUAL }, ...timeWindow },
      }),
    ]);
    return Math.max(
      0,
      Math.min(
        config.deals.suggestions.maxPostsPerDay - rssUsed,
        config.deals.maxPostsPerDay - globalUsed,
      ),
    );
  }

  async function dismissCandidate(
    id: string,
    prior: unknown,
    reason: string,
    details: JsonRecord = {},
  ): Promise<void> {
    await prisma.dealSuggestion.updateMany({
      where: {
        id,
        status: { in: [SuggestionStatus.NEW, SuggestionStatus.VERIFYING] },
      },
      data: {
        status: SuggestionStatus.DISMISSED,
        verificationStartedAt: null,
        gateVerdict: {
          ...record(prior),
          promotion: { status: "dismissed", reason, ...details },
        } as Prisma.InputJsonValue,
      },
    });
    skip(reason);
  }

  /** Rank the high-intent queue globally, then spend strict fact checks and
   * posting slots only on the best candidates. Click/engagement results add a
   * bounded, decaying lane boost; an 18-point same-day diversity penalty
   * prevents one lucky topic from monopolizing the profile. */
  async function promoteCandidates(): Promise<void> {
    let capacity = await remainingCapacity();
    if (capacity <= 0) return;
    const now = new Date();

    // In live mode, verify only when a post can move immediately to the
    // publisher. This keeps the strict sale verdict fresh and prevents a
    // second READY row from aging out behind the one-hour profile cooldown.
    if (!config.bot.dryRun && config.deals.suggestions.autopost) {
      const [inFlight, lastPosted] = await Promise.all([
        prisma.dealPost.count({
          where: { status: { in: [DealPostStatus.READY, DealPostStatus.POSTING] } },
        }),
        prisma.dealPost.findFirst({
          where: {
            source: { not: DealSource.MANUAL },
            status: DealPostStatus.POSTED,
            postedAt: { not: null },
          },
          orderBy: { postedAt: "desc" },
          select: { postedAt: true },
        }),
      ]);
      if (inFlight > 0) return;
      if (
        lastPosted?.postedAt &&
        now.getTime() - lastPosted.postedAt.getTime() <
          config.deals.globalCooldownMinutes * 60_000
      ) {
        return;
      }
      capacity = Math.min(capacity, 1);
    }
    const stagedBefore = new Date(
      now.getTime() - config.deals.suggestions.stagingMinutes * 60_000,
    );
    const pool = await prisma.dealSuggestion.findMany({
      where: {
        status: SuggestionStatus.NEW,
        createdAt: { lte: stagedBefore },
        source: { isActive: true },
      },
      include: { source: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, config.deals.suggestions.candidatePoolSize),
    });
    if (pool.length === 0) return;

    const performance = await lanePerformance();
    const laneWindow: Prisma.DealPostWhereInput =
      config.bot.dryRun || !config.deals.suggestions.autopost
        ? { status: DealPostStatus.DRY_RUN, createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }
        : {
            OR: [
              {
                status: DealPostStatus.POSTED,
                postedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
              },
              {
                status: { in: [DealPostStatus.READY, DealPostStatus.POSTING] },
                createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
              },
            ],
          };
    const today = await prisma.dealPost.findMany({
      where: {
        laneKey: { not: null },
        ...laneWindow,
      },
      select: { laneKey: true },
    });
    const laneSlots = new Map<HighConversionLane, number>();
    for (const post of today) {
      if (post.laneKey && post.laneKey in HIGH_CONVERSION_LANES) {
        const lane = post.laneKey as HighConversionLane;
        laneSlots.set(lane, (laneSlots.get(lane) ?? 0) + 1);
      }
    }

    const ranked = pool
      .map((candidate) => {
        const meta = parseCandidateMeta(candidate.gateVerdict);
        if (!meta) return null;
        return { candidate, meta };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const liveScore = (entry: (typeof ranked)[number]): number =>
      effectiveCandidateScore({
        baseScore: entry.meta.baseScore,
        performance: performance.get(entry.meta.lane),
        sameLaneSlotsToday: laneSlots.get(entry.meta.lane) ?? 0,
      });

    let factChecks = 0;
    while (
      ranked.length > 0 &&
      capacity > 0 &&
      factChecks < config.deals.suggestions.maxFactChecksPerTick
    ) {
      // Re-rank after every promotion. The lane that just won a slot receives
      // its diversity penalty immediately, allowing a close runner-up lane to
      // take the next audit/live slot instead of preserving stale order.
      ranked.sort(
        (a, b) =>
          liveScore(b) - liveScore(a) ||
          b.meta.baseScore - a.meta.baseScore ||
          b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime(),
      );
      const entry = ranked.shift()!;
      const { candidate, meta } = entry;
      const effectiveScore = liveScore(entry);
      if (effectiveScore < config.deals.suggestions.minCandidateScore) continue;
      if (
        !hasFreshSaleTimestamp(
          meta.publishedAt,
          now,
          config.deals.suggestions.maxSaleEvidenceAgeHours,
        )
      ) {
        await dismissCandidate(candidate.id, candidate.gateVerdict, "stale_feed_evidence");
        continue;
      }
      const blocked = await listingBlock({ asin: candidate.asin, marketplace: candidate.marketplace });
      if (blocked) {
        await dismissCandidate(candidate.id, candidate.gateVerdict, blocked);
        continue;
      }

      // Atomically own the expensive verification. A second worker sees zero
      // updated rows and cannot spend another call or mint another post.
      const claim = await prisma.dealSuggestion.updateMany({
        where: { id: candidate.id, status: SuggestionStatus.NEW },
        data: {
          status: SuggestionStatus.VERIFYING,
          verificationStartedAt: now,
          gateVerdict: {
            ...record(candidate.gateVerdict),
            promotion: { status: "verifying", claimedAt: now.toISOString() },
          } as Prisma.InputJsonValue,
        },
      });
      if (claim.count !== 1) continue;

      factChecks += 1;
      const verdict = config.llm.useFake
        ? {
            accurate: true,
            exactProductMatch: true,
            orderableOnAmazon: true,
            amazonSaleConfirmed: true,
            confidence: 100,
            amazonProductEvidenceUrl: candidate.productUrl,
            saleEvidenceUrl: candidate.sourceUrl ?? candidate.productUrl,
            saleEvidenceSummary: "simulated evidence for fake dry-run only",
            issues: [],
            summary: "fake: strict sale verification passed for dry-run exercise",
            model: "fake",
            checkedAt: now.toISOString(),
            evidenceUrls: [],
            saleEvidencePublishedAt: meta.publishedAt?.toISOString() ?? now.toISOString(),
          }
        : await factCheckDealListing({
            title: candidate.title,
            sourceName: candidate.source.name,
            asin: candidate.asin,
            productUrl: candidate.productUrl,
            sourceUrl: candidate.sourceUrl,
            publishedAt: meta.publishedAt,
            maxEvidenceAgeHours: config.deals.suggestions.maxSaleEvidenceAgeHours,
          });
      if (!dealVerdictPasses(verdict) && !config.llm.useFake) {
        await dismissCandidate(candidate.id, candidate.gateVerdict, "amazon_sale_unverified", {
          factCheck: verdict ?? { error: "strict check could not be completed" },
        });
        continue;
      }
      const verifiedAt = config.llm.useFake ? null : new Date();

      const linkUrl = withAffiliateTag(
        canonicalAmazonUrl(candidate.asin, candidate.marketplace),
        config.site.amazonAssociateTag,
      );
      const composed = composeRssDeal(candidate.title, candidate.source.name, linkUrl);
      if (!composed) {
        await dismissCandidate(candidate.id, candidate.gateVerdict, "compose_failed");
        continue;
      }

      const status =
        config.bot.dryRun || config.llm.useFake
          ? DealPostStatus.DRY_RUN
          : config.deals.suggestions.autopost
            ? DealPostStatus.READY
            : DealPostStatus.DRY_RUN;
      const promotion = {
        status: "promoted",
        lane: meta.lane,
        baseScore: meta.baseScore,
        effectiveScore,
        lanePerformance: performance.get(meta.lane) ?? null,
        factCheck: verdict,
      };

      let dealPost: { id: string };
      try {
        dealPost = await prisma.$transaction(
          async (tx) => {
            const owned = await tx.dealSuggestion.findFirst({
              where: {
                id: candidate.id,
                status: SuggestionStatus.VERIFYING,
                source: { isActive: true },
              },
              select: { id: true },
            });
            if (!owned) throw new PromotionBlocked("candidate_claim_or_source_lost");

            if (!config.bot.dryRun && config.deals.suggestions.autopost) {
              const since = new Date(now.getTime() - 24 * 3_600_000);
              const liveWindow: Prisma.DealPostWhereInput = {
                OR: [
                  { status: DealPostStatus.POSTED, postedAt: { gte: since } },
                  {
                    status: {
                      in: [
                        DealPostStatus.PENDING,
                        DealPostStatus.PENDING_APPROVAL,
                        DealPostStatus.READY,
                        DealPostStatus.POSTING,
                      ],
                    },
                    createdAt: { gte: since },
                  },
                ],
              };
              const [globalInFlight, lastPosted, globalUsed, rssUsed] = await Promise.all([
                tx.dealPost.count({
                  where: { status: { in: [DealPostStatus.READY, DealPostStatus.POSTING] } },
                }),
                tx.dealPost.findFirst({
                  where: {
                    source: { not: DealSource.MANUAL },
                    status: DealPostStatus.POSTED,
                    postedAt: { not: null },
                  },
                  orderBy: { postedAt: "desc" },
                  select: { postedAt: true },
                }),
                tx.dealPost.count({
                  where: { source: { not: DealSource.MANUAL }, ...liveWindow },
                }),
                tx.dealPost.count({
                  where: {
                    source: DealSource.DISCOVERED,
                    feedId: null,
                    ...liveWindow,
                  },
                }),
              ]);
              if (globalInFlight > 0) {
                throw new PromotionBlocked("global_deal_queue_busy", true);
              }
              if (
                lastPosted?.postedAt &&
                now.getTime() - lastPosted.postedAt.getTime() <
                  config.deals.globalCooldownMinutes * 60_000
              ) {
                throw new PromotionBlocked("global_deal_cooldown", true);
              }
              if (
                globalUsed >= config.deals.maxPostsPerDay ||
                rssUsed >= config.deals.suggestions.maxPostsPerDay
              ) {
                throw new PromotionBlocked("daily_deal_capacity_exhausted", true);
              }
            }

            let listingRow = await tx.trackedListing.findUnique({
              where: {
                asin_marketplace: { asin: candidate.asin, marketplace: candidate.marketplace },
              },
              select: { id: true, isActive: true, lastPostedAt: true },
            });
            if (listingRow) {
              if (!listingRow.isActive) throw new PromotionBlocked("listing_banned");
              if (
                listingRow.lastPostedAt &&
                now.getTime() - listingRow.lastPostedAt.getTime() <
                  config.deals.perListingCooldownHours * 3_600_000
              ) {
                throw new PromotionBlocked("listing_cooldown");
              }
              const queued = await tx.dealPost.count({
                where: {
                  listingId: listingRow.id,
                  status: {
                    in: [
                      DealPostStatus.PENDING,
                      DealPostStatus.PENDING_APPROVAL,
                      DealPostStatus.READY,
                      DealPostStatus.POSTING,
                    ],
                  },
                },
              });
              if (queued > 0) throw new PromotionBlocked("already_queued");
            } else {
              listingRow = await tx.trackedListing.create({
                data: {
                  asin: candidate.asin,
                  marketplace: candidate.marketplace,
                  productUrl: canonicalAmazonUrl(candidate.asin, candidate.marketplace),
                  title:
                    shortenAmazonTitle(cleanDealTitle(candidate.title), 120) ||
                    candidate.title.slice(0, 120),
                  currency: "USD",
                  origin: ListingOrigin.DISCOVERED,
                  armState: DealArmState.DISARMED,
                  lastCheckedAt: now,
                  source: "WEB_VERIFIED",
                },
                select: { id: true, isActive: true, lastPostedAt: true },
              });
            }

            const post = await tx.dealPost.create({
              data: {
                listingId: listingRow.id,
                suggestionId: candidate.id,
                source: DealSource.DISCOVERED,
                status,
                // RSS hints stay exclusively in DealSuggestion. Zeroes make it
                // structurally impossible for the poster to render a price.
                salePriceCents: 0,
                targetPriceCents: 0,
                currency: "USD",
                priceAsOf: now,
                saleVerifiedAt: verifiedAt,
                laneKey: meta.lane,
                candidateScore: Math.round(effectiveScore),
                linkUrl,
                postText: composed.text,
                linkAnchor: composed.anchor,
              },
              select: { id: true },
            });
            const finalized = await tx.dealSuggestion.updateMany({
              where: { id: candidate.id, status: SuggestionStatus.VERIFYING },
              data: {
                status: SuggestionStatus.QUEUED,
                verificationStartedAt: null,
                gateVerdict: {
                  ...record(candidate.gateVerdict),
                  promotion: { ...promotion, dealPostId: post.id },
                } as Prisma.InputJsonValue,
              },
            });
            if (finalized.count !== 1) {
              throw new PromotionBlocked("candidate_claim_lost_before_finalize");
            }
            return post;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof PromotionBlocked && !error.retryable) {
          await dismissCandidate(candidate.id, candidate.gateVerdict, error.reason);
        } else {
          const reason = error instanceof PromotionBlocked ? error.reason : "transaction_error";
          if (!(error instanceof PromotionBlocked)) stats.errors += 1;
          await prisma.dealSuggestion.updateMany({
            where: { id: candidate.id, status: SuggestionStatus.VERIFYING },
            data: {
              status: SuggestionStatus.NEW,
              verificationStartedAt: null,
              gateVerdict: {
                ...record(candidate.gateVerdict),
                promotion: { status: "retry", reason },
              } as Prisma.InputJsonValue,
            },
          });
          if (error instanceof PromotionBlocked) {
            skip(error.reason);
          } else {
            console.warn(
              `[rssDeal] promotion transaction failed for ${candidate.asin}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        continue;
      }

      capacity -= 1;
      laneSlots.set(meta.lane, (laneSlots.get(meta.lane) ?? 0) + 1);
      stats.promoted += 1;
      stats.suggested += 1;
      console.log(
        `[rssDeal] promoted ${candidate.asin} lane=${meta.lane} score=${effectiveScore} ` +
          `(${status}, ${dealPost.id})`,
      );
    }
  }

  async function runSource(source: DealSuggestionSource, llmBudget: { remaining: number }): Promise<void> {
    stats.sources += 1;
    const startedAt = new Date();
    const xml = await fetchFeed(source.url);
    const items = parseRssItems(xml)
      .sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
          (a.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY),
      )
      .slice(0, config.deals.suggestions.maxItemsPerFetch);
    let staged = 0;
    for (const item of items) {
      try {
        if (await handleItem(source, item, llmBudget)) staged += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(
          `[rssDeal] item failed (${source.name}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    stats.items += items.length;
    await prisma.dealSuggestionSource.update({
      where: { id: source.id },
      data: {
        lastFetchedAt: startedAt,
        lastItemCount: items.length,
        lastQueuedCount: staged,
        lastFetchError: null,
      },
    });
    if (staged > 0) console.log(`[rssDeal] ${source.name}: ${staged} ranked candidate(s) staged`);
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

    // Divide the bounded LLM budget fairly across due sources. Unused calls
    // roll forward, while a broad first feed cannot starve every later feed.
    let remainingLlm = config.deals.suggestions.maxLlmPerTick;
    for (const [index, source] of due.entries()) {
      const sourcesLeft = due.length - index;
      const allocated = Math.ceil(remainingLlm / sourcesLeft);
      const llmBudget = { remaining: allocated };
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
      remainingLlm -= allocated - llmBudget.remaining;
    }

    // Promotion runs even when no source was due: staged candidates wait a
    // few minutes so multiple lanes can compete, then a later 60s tick picks
    // the best verified opportunity.
    await promoteCandidates();
  }

  return { tick, enabled: true };
}
