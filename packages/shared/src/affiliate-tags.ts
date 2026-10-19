/**
 * Per-channel Amazon tracking IDs.
 *
 * Amazon reports earnings per tracking ID and nothing finer — no per-click,
 * per-post, or per-link attribution — and our only first-party signal is the
 * /r/<id> click counter, which says nothing about sales. Giving each posting
 * channel its own tracking ID is therefore the ONLY way to learn which channel
 * converts: the Associates Orders/Earnings reports then split by channel for
 * free, and the dashboard joins them back to our click counts.
 *
 * Every channel var is optional and falls back to AMAZON_ASSOCIATE_TAG, so
 * unset = today's single-tag behavior. Tracking IDs must be created first in
 * Associates Central (Account settings → Manage tracking IDs); an ID Amazon
 * doesn't know earns nothing, so never set one before creating it.
 *
 * There is deliberately no banter channel: banter replies never carry a link
 * (banter.ts rejects any), so a tag for them could never earn.
 */

export const AFFILIATE_CHANNELS = {
  /** Trending/mention/operator-injected replies (search or /dp/ links). */
  reply: "AMAZON_TAG_REPLY",
  /** Price-free Slickdeals/RSS deal posts (ADR-0013). */
  deal_rss: "AMAZON_TAG_DEAL_RSS",
  /** Curator-account relay posts, e.g. Wario64 (ADR-0017). */
  deal_curated: "AMAZON_TAG_DEAL_CURATED",
  /** Creators API deal-feed discoveries and legacy watchlist triggers. */
  deal_feed: "AMAZON_TAG_DEAL_FEED",
  /** Operator-queued deal posts (queue-deal CLI and successors). */
  deal_manual: "AMAZON_TAG_DEAL_MANUAL",
} as const;

export type AffiliateChannel = keyof typeof AFFILIATE_CHANNELS;

export const AFFILIATE_CHANNEL_NAMES = Object.keys(AFFILIATE_CHANNELS) as AffiliateChannel[];

type Env = Record<string, string | undefined>;

/**
 * Tracking ID for a channel: its own var when set, else AMAZON_ASSOCIATE_TAG,
 * else "" (withAffiliateTag/amazonSearchUrl then leave the link untagged,
 * which callers already treat as "links disabled").
 */
export function affiliateTagFor(channel: AffiliateChannel, env: Env = process.env): string {
  return env[AFFILIATE_CHANNELS[channel]]?.trim() || env.AMAZON_ASSOCIATE_TAG?.trim() || "";
}

/** Every channel's resolved tag — the worker snapshots this into config. */
export function resolveAffiliateTags(env: Env = process.env): Record<AffiliateChannel, string> {
  return Object.fromEntries(
    AFFILIATE_CHANNEL_NAMES.map((c) => [c, affiliateTagFor(c, env)]),
  ) as Record<AffiliateChannel, string>;
}

/**
 * Which channel minted a deal post. DISCOVERED covers two channels: RSS
 * candidates never carry a feedId, Creators API feed finds always do (the
 * poster's price-free check uses the same split).
 */
export function dealChannel(source: string, feedId: string | null): AffiliateChannel {
  if (source === "CURATED") return "deal_curated";
  if (source === "MANUAL") return "deal_manual";
  if (source === "DISCOVERED" && !feedId) return "deal_rss";
  return "deal_feed";
}

/**
 * Reverse map for reports: tracking ID → the channels currently using it.
 * Several channels share an ID until each gets its own var, and a report row
 * under a shared ID can't be split — the dashboard shows all its channels
 * rather than guessing. An ID no channel uses (an old or retired one) maps
 * to an empty list.
 */
export function channelsForTag(tag: string, env: Env = process.env): AffiliateChannel[] {
  const wanted = tag.trim().toLowerCase();
  return AFFILIATE_CHANNEL_NAMES.filter((c) => affiliateTagFor(c, env).toLowerCase() === wanted);
}

/** The `tag` query param of a (tagged) Amazon URL, or null. */
export function tagOfUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get("tag");
  } catch {
    return null;
  }
}
