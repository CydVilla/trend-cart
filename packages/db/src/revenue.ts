import type { AssociatesReportKind, PrismaClient } from "@prisma/client";
import {
  channelsForTag,
  extractAsin,
  isEbayUrl,
  tagOfUrl,
  type AffiliateChannel,
  type ParsedAssociatesReport,
  type ParsedTrackingSummary,
  type TrackingSummaryLine,
} from "@trendcart/shared";

/**
 * Per-channel revenue: hand-uploaded Associates reports joined to our own
 * click counts. Amazon attributes sales to a tracking ID and nothing finer,
 * so the join runs two ways — by tracking ID (each channel posts under its
 * own AMAZON_TAG_* ID, read back from TrackedLink.targetUrl's tag param) for
 * the channel view, and by ASIN for the product view.
 */

const day = (ymd: string): Date => new Date(`${ymd}T00:00:00Z`);
const ymdOf = (date: Date): string => date.toISOString().slice(0, 10);

export type ImportResult = { kind: AssociatesReportKind; written: number; replaced: number };

/**
 * Store a parsed report, REPLACING whatever an earlier upload of the same
 * kind stored for the same tracking IDs inside the report's range — so
 * downloading overlapping ranges, or re-downloading after Amazon revises a
 * day (late orders, returns), never double counts. Scoped to the upload's
 * tracking IDs so a report filtered to one ID can't wipe the others.
 */
export async function importAssociatesReport(
  prisma: PrismaClient,
  report: ParsedAssociatesReport,
): Promise<ImportResult> {
  if (!report.range) return { kind: report.kind, written: 0, replaced: 0 };
  const trackingIds = [...new Set(report.lines.map((l) => l.trackingId))];
  // A report with zero rows still records its range: a quiet week is data
  // (clicks, no orders), and conversion needs the window either way.
  const [deleted, created] = await prisma.$transaction([
    prisma.associatesReportRow.deleteMany({
      where: {
        kind: report.kind,
        trackingId: { in: trackingIds },
        day: { gte: day(report.range.from), lte: day(report.range.to) },
      },
    }),
    prisma.associatesReportRow.createMany({
      data: report.lines.map((l) => ({
        kind: report.kind,
        day: day(l.day),
        trackingId: l.trackingId,
        asin: l.asin,
        title: l.title,
        category: l.category,
        items: l.items,
        returns: l.returns,
        salesCents: l.salesCents,
        feeCents: l.feeCents,
        indirectItems: l.indirectItems,
      })),
    }),
    prisma.associatesReportUpload.create({
      data: {
        kind: report.kind,
        fromDay: day(report.range.from),
        toDay: day(report.range.to),
        rows: report.lines.length,
        skipped: report.skipped,
      },
    }),
  ]);
  return { kind: report.kind, written: created.count, replaced: deleted.count };
}

type Money = {
  /** ORDERS report: items ordered and their price. */
  orderedItems: number;
  orderedSalesCents: number;
  /** EARNINGS report: shipped, returned, and the commission we earned. */
  shippedItems: number;
  returnedItems: number;
  feeCents: number;
  indirectItems: number;
};

export type ChannelRevenue = Money & {
  trackingId: string;
  /** Channels whose AMAZON_TAG_* resolves to this ID right now. More than one
   *  = they share it (unsplittable); none = a retired or foreign ID. */
  channels: AffiliateChannel[];
  /** Human clicks on our links carrying this tag (TrackedLink.clickCount). */
  clicks: number;
  links: number;
  /** orderedItems / clicks, null without clicks. */
  conversion: number | null;
};

export type AsinRevenue = Money & {
  asin: string;
  title: string;
  trackingIds: string[];
  clicks: number;
  /** Our deal posts of this ASIN, by DealSource. */
  dealPosts: { source: string; postedAt: Date | null }[];
  /** Our tracked links that pointed straight at it, by surface (reply search
   *  links carry no ASIN, so replies rarely count here). */
  replyLinks: number;
  dealLinks: number;
  conversion: number | null;
};

export type RevenueReport = {
  /** Days covered by uploaded reports (both kinds), null before any upload. */
  coverage: { from: string; to: string } | null;
  /** Window whose links' clicks are the conversion denominator: the Orders
   *  coverage (conversion = ordered items / clicks), else all coverage. */
  clickWindow: { from: string; to: string } | null;
  uploads: { kind: AssociatesReportKind; from: string; to: string; lastImportedAt: Date }[];
  totals: Money & { clicks: number; conversion: number | null };
  channels: ChannelRevenue[];
  asins: AsinRevenue[];
};

const emptyMoney = (): Money => ({
  orderedItems: 0,
  orderedSalesCents: 0,
  shippedItems: 0,
  returnedItems: 0,
  feeCents: 0,
  indirectItems: 0,
});

function addRow(
  m: Money,
  r: { kind: AssociatesReportKind; items: number; returns: number; salesCents: number; feeCents: number; indirectItems: number },
): void {
  if (r.kind === "ORDERS") {
    m.orderedItems += r.items;
    m.orderedSalesCents += r.salesCents;
    m.indirectItems += r.indirectItems;
  } else {
    m.shippedItems += r.items;
    m.returnedItems += r.returns;
    m.feeCents += r.feeCents;
  }
}

const rate = (orders: number, clicks: number): number | null => (clicks > 0 ? orders / clicks : null);

/**
 * Revenue by tracking ID and by ASIN over the uploaded reports' coverage
 * (each kind's earliest declared start to latest declared end — a gap between
 * two uploads is treated as covered, so upload contiguous ranges).
 *
 * Clicks are counted on links CREATED from a day before the Orders coverage
 * starts through its end. TrackedLink keeps a lifetime counter, not per-day clicks,
 * so this is an approximation — but deal and reply links collect nearly all
 * their clicks within hours of posting, and Amazon's 24h cookie means an
 * order on day D came from a click on D or D-1.
 */
export async function computeRevenueReport(
  prisma: PrismaClient,
  opts: { env?: Record<string, string | undefined>; asinLimit?: number } = {},
): Promise<RevenueReport> {
  const env = opts.env ?? process.env;
  const spans = await prisma.associatesReportUpload.groupBy({
    by: ["kind"],
    _min: { fromDay: true },
    _max: { toDay: true, createdAt: true },
  });
  const uploads = spans
    .filter((s) => s._min.fromDay && s._max.toDay && s._max.createdAt)
    .map((s) => ({
      kind: s.kind,
      from: ymdOf(s._min.fromDay!),
      to: ymdOf(s._max.toDay!),
      lastImportedAt: s._max.createdAt!,
    }));
  const empty: RevenueReport = {
    coverage: null,
    clickWindow: null,
    uploads,
    totals: { ...emptyMoney(), clicks: 0, conversion: null },
    channels: [],
    asins: [],
  };
  if (uploads.length === 0) return empty;
  const coverage = {
    from: uploads.map((u) => u.from).sort()[0]!,
    to: uploads.map((u) => u.to).sort().at(-1)!,
  };

  const orders = uploads.find((u) => u.kind === "ORDERS");
  const clickWindow = orders ? { from: orders.from, to: orders.to } : coverage;
  const linkFrom = new Date(day(clickWindow.from).getTime() - 24 * 3_600_000);
  const linkTo = new Date(day(clickWindow.to).getTime() + 24 * 3_600_000);
  const [rows, links] = await Promise.all([
    prisma.associatesReportRow.findMany({
      where: { day: { gte: day(coverage.from), lte: day(coverage.to) } },
      select: {
        kind: true,
        trackingId: true,
        asin: true,
        title: true,
        items: true,
        returns: true,
        salesCents: true,
        feeCents: true,
        indirectItems: true,
      },
    }),
    prisma.trackedLink.findMany({
      where: { createdAt: { gte: linkFrom, lt: linkTo } },
      select: { targetUrl: true, kind: true, sourceId: true, clickCount: true },
    }),
  ]);

  // ── by tracking ID ──
  const byTag = new Map<string, ChannelRevenue>();
  const tagRow = (trackingId: string): ChannelRevenue => {
    const key = trackingId.toLowerCase();
    let entry = byTag.get(key);
    if (!entry) {
      entry = {
        ...emptyMoney(),
        trackingId,
        channels: channelsForTag(trackingId, env),
        clicks: 0,
        links: 0,
        conversion: null,
      };
      byTag.set(key, entry);
    }
    return entry;
  };
  const totals = { ...emptyMoney(), clicks: 0, conversion: null as number | null };
  for (const r of rows) {
    addRow(tagRow(r.trackingId), r);
    addRow(totals, r);
  }

  // ── by ASIN ──
  const byAsin = new Map<string, AsinRevenue>();
  for (const r of rows) {
    let entry = byAsin.get(r.asin);
    if (!entry) {
      entry = {
        ...emptyMoney(),
        asin: r.asin,
        title: r.title,
        trackingIds: [],
        clicks: 0,
        dealPosts: [],
        replyLinks: 0,
        dealLinks: 0,
        conversion: null,
      };
      byAsin.set(r.asin, entry);
    }
    addRow(entry, r);
    if (!entry.trackingIds.includes(r.trackingId)) entry.trackingIds.push(r.trackingId);
    entry.title ||= r.title;
  }

  for (const link of links) {
    if (isEbayUrl(link.targetUrl)) continue; // Amazon's conversion denominator only
    const tag = tagOfUrl(link.targetUrl);
    if (tag) {
      const t = tagRow(tag);
      t.clicks += link.clickCount;
      t.links += 1;
    }
    totals.clicks += link.clickCount;
    const asin = extractAsin(link.targetUrl);
    const a = asin ? byAsin.get(asin) : undefined;
    if (a) {
      a.clicks += link.clickCount;
      if (link.kind === "reply") a.replyLinks += 1;
      else a.dealLinks += 1;
    }
  }

  const ranked = [...byAsin.values()]
    .sort(
      (a, b) =>
        b.feeCents - a.feeCents ||
        b.orderedSalesCents - a.orderedSalesCents ||
        b.orderedItems - a.orderedItems,
    )
    .slice(0, opts.asinLimit ?? 50);
  if (ranked.length > 0) {
    const posts = await prisma.dealPost.findMany({
      where: { status: "POSTED", listing: { asin: { in: ranked.map((a) => a.asin) } } },
      select: { source: true, postedAt: true, listing: { select: { asin: true } } },
      orderBy: { postedAt: "desc" },
    });
    for (const p of posts) {
      byAsin.get(p.listing.asin)?.dealPosts.push({ source: p.source, postedAt: p.postedAt });
    }
  }

  for (const c of byTag.values()) c.conversion = rate(c.orderedItems, c.clicks);
  for (const a of ranked) a.conversion = rate(a.orderedItems, a.clicks);
  totals.conversion = rate(totals.orderedItems, totals.clicks);

  return {
    coverage,
    clickWindow,
    uploads,
    totals,
    channels: [...byTag.values()].sort(
      (a, b) => b.feeCents - a.feeCents || b.orderedItems - a.orderedItems || b.clicks - a.clicks,
    ),
    asins: ranked,
  };
}

// ── Tracking Id summary ─────────────────────────────────────

/**
 * Store a Tracking Id summary, replacing any earlier upload of the SAME
 * range (a re-download after Amazon revises late orders). Other ranges are
 * kept: summaries can't be split by day, so overlapping ones aren't merged.
 */
export async function importTrackingSummary(
  prisma: PrismaClient,
  summary: ParsedTrackingSummary,
): Promise<{ written: number; replaced: number }> {
  const fromDay = day(summary.range.from);
  const toDay = day(summary.range.to);
  const [deleted, created] = await prisma.$transaction([
    prisma.associatesTrackingSummary.deleteMany({ where: { fromDay, toDay } }),
    prisma.associatesTrackingSummary.createMany({
      data: summary.lines.map((l) => ({ fromDay, toDay, ...l })),
    }),
  ]);
  return { written: created.count, replaced: deleted.count };
}

export type TrackingSummaryRow = TrackingSummaryLine & {
  channels: AffiliateChannel[];
  /** Human clicks on OUR links carrying this tag, created in the range. */
  ourClicks: number;
  /** Amazon clicks / our clicks, null without ours. */
  clickRatio: number | null;
  /** orderedItems / Amazon clicks, null without clicks. */
  conversion: number | null;
};

export type TrackingSummaryView = {
  range: { from: string; to: string };
  importedAt: Date;
  rows: TrackingSummaryRow[];
  /** Totals across rows; ourClicks counts every link in the range, tagged or not. */
  totals: { clicks: number; ourClicks: number; orderedItems: number; earningsCents: number };
};

/**
 * The most recently uploaded Tracking Id summary, each row joined to our own
 * click counter for the same tag over the same range (links created from a
 * day before through a day after — the same lifetime-counter approximation
 * as computeRevenueReport). Null before any upload.
 */
export async function latestTrackingSummary(
  prisma: PrismaClient,
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<TrackingSummaryView | null> {
  const env = opts.env ?? process.env;
  const latest = await prisma.associatesTrackingSummary.findFirst({
    orderBy: { importedAt: "desc" },
    select: { fromDay: true, toDay: true, importedAt: true },
  });
  if (!latest) return null;
  const [rows, links] = await Promise.all([
    prisma.associatesTrackingSummary.findMany({
      where: { fromDay: latest.fromDay, toDay: latest.toDay },
      orderBy: { clicks: "desc" },
    }),
    prisma.trackedLink.findMany({
      where: {
        createdAt: {
          gte: new Date(latest.fromDay.getTime() - 24 * 3_600_000),
          lt: new Date(latest.toDay.getTime() + 2 * 24 * 3_600_000),
        },
      },
      select: { targetUrl: true, clickCount: true },
    }),
  ]);
  const ours = new Map<string, number>();
  let ourTotal = 0;
  for (const link of links) {
    if (isEbayUrl(link.targetUrl)) continue;
    ourTotal += link.clickCount;
    const tag = tagOfUrl(link.targetUrl)?.toLowerCase();
    if (tag) ours.set(tag, (ours.get(tag) ?? 0) + link.clickCount);
  }
  const out: TrackingSummaryRow[] = rows.map((r) => {
    const ourClicks = ours.get(r.trackingId.toLowerCase()) ?? 0;
    return {
      trackingId: r.trackingId,
      clicks: r.clicks,
      orderedItems: r.orderedItems,
      orderedSalesCents: r.orderedSalesCents,
      shippedItems: r.shippedItems,
      returnedItems: r.returnedItems,
      shippedSalesCents: r.shippedSalesCents,
      earningsCents: r.earningsCents,
      bonusCents: r.bonusCents,
      channels: channelsForTag(r.trackingId, env),
      ourClicks,
      clickRatio: ourClicks > 0 ? r.clicks / ourClicks : null,
      conversion: rate(r.orderedItems, r.clicks),
    };
  });
  return {
    range: { from: ymdOf(latest.fromDay), to: ymdOf(latest.toDay) },
    importedAt: latest.importedAt,
    rows: out,
    totals: {
      clicks: out.reduce((n, r) => n + r.clicks, 0),
      ourClicks: ourTotal,
      orderedItems: out.reduce((n, r) => n + r.orderedItems, 0),
      earningsCents: out.reduce((n, r) => n + r.earningsCents, 0),
    },
  };
}

// ── eBay ────────────────────────────────────────────────────

export type EbayPostRevenue = {
  dealPostId: string;
  title: string;
  itemId: string;
  postedAt: Date | null;
  clicks: number;
  orders: number;
  saleCents: number;
  payoutCents: number;
};

export type EbayRevenue = {
  totals: { posts: number; clicks: number; orders: number; saleCents: number; payoutCents: number };
  /** Conversions whose sub-ID names none of our posts. */
  unattributed: { orders: number; saleCents: number; payoutCents: number };
  /** Top posts by earnings, then clicks, then recency. */
  posts: EbayPostRevenue[];
};

/** Every eBay post joined to its clicks and non-reversed conversions. */
export async function computeEbayRevenue(
  prisma: PrismaClient,
  opts: { postLimit?: number } = {},
): Promise<EbayRevenue> {
  const [posts, conversions] = await Promise.all([
    prisma.dealPost.findMany({
      where: { source: "EBAY", status: "POSTED" },
      select: { id: true, postedAt: true, listing: { select: { title: true, asin: true } } },
    }),
    prisma.ebayConversion.findMany({
      where: { state: { not: "REVERSED" } },
      select: { dealPostId: true, saleCents: true, payoutCents: true },
    }),
  ]);
  const links = await prisma.trackedLink.findMany({
    where: { kind: "deal", sourceId: { in: posts.map((p) => p.id) } },
    select: { sourceId: true, clickCount: true },
  });
  const rows = new Map<string, EbayPostRevenue>(
    posts.map((p) => [
      p.id,
      {
        dealPostId: p.id,
        title: p.listing.title,
        itemId: p.listing.asin,
        postedAt: p.postedAt,
        clicks: 0,
        orders: 0,
        saleCents: 0,
        payoutCents: 0,
      },
    ]),
  );
  for (const link of links) {
    const row = link.sourceId ? rows.get(link.sourceId) : undefined;
    if (row) row.clicks += link.clickCount;
  }
  const unattributed = { orders: 0, saleCents: 0, payoutCents: 0 };
  for (const c of conversions) {
    const row: { orders: number; saleCents: number; payoutCents: number } =
      (c.dealPostId ? rows.get(c.dealPostId) : undefined) ?? unattributed;
    row.orders += 1;
    row.saleCents += c.saleCents;
    row.payoutCents += c.payoutCents;
  }
  const all = [...rows.values()];
  const sum = (pick: (r: EbayPostRevenue) => number): number =>
    all.reduce((n, r) => n + pick(r), 0);
  return {
    totals: {
      posts: all.length,
      clicks: sum((r) => r.clicks),
      orders: sum((r) => r.orders) + unattributed.orders,
      saleCents: sum((r) => r.saleCents) + unattributed.saleCents,
      payoutCents: sum((r) => r.payoutCents) + unattributed.payoutCents,
    },
    unattributed,
    posts: all
      .sort(
        (a, b) =>
          b.payoutCents - a.payoutCents ||
          b.clicks - a.clicks ||
          (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0),
      )
      .slice(0, opts.postLimit ?? 50),
  };
}
