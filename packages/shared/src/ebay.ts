import { canonicalAmazonUrl } from "./amazon";

/**
 * eBay Partner Network link helpers (ADR-0018). The tracking parameters are
 * the classic EPN set, applied directly to a www.ebay.com listing URL: the
 * Impact API refuses deep links for this program and its tracking domain does
 * not resolve, so there is no redirect hop to depend on.
 */

/** Stored in the `marketplace` columns; the `asin` column holds the item ID. */
export const EBAY_MARKETPLACE = "www.ebay.com";

/** The one deal source the eBay channel reads (seeded by migration). */
export const EBAY_SOURCE_URL =
  "https://slickdeals.net/newsearch.php?q=ebay&searcharea=deals&searchin=first&rss=1";

/** Sources stored under this prefix are saved Browse API searches. The URL is
 *  a real eBay search page, so the operator can open it from the dashboard. */
export const EBAY_SEARCH_URL_PREFIX = "https://www.ebay.com/sch/i.html?";

/** The keywords of a saved eBay search source, or null if it isn't one. */
export function ebaySearchQuery(sourceUrl: string): string | null {
  if (!sourceUrl.startsWith(EBAY_SEARCH_URL_PREFIX)) return null;
  return new URL(sourceUrl).searchParams.get("_nkw")?.trim() || null;
}

const EBAY_HOSTS = new Set(["ebay.com", "www.ebay.com"]);
const ITEM_PATH_RE = /^\/itm\/(?:[^/]+\/)?(\d{9,14})\/?$/;

/** True only for the US eBay site; regional sites earn under other rotations. */
export function isEbayHost(hostname: string): boolean {
  return EBAY_HOSTS.has(hostname.toLowerCase());
}

/** True when the string parses as a URL on the US eBay site. */
export function isEbayUrl(raw: string): boolean {
  try {
    return isEbayHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** The numeric item ID of a /itm/ listing URL, or null for anything else. */
export function extractEbayItemId(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!isEbayHost(url.hostname)) return null;
    return url.pathname.match(ITEM_PATH_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True when a link already carries this post's ID, as eBay's own affiliate
 *  URLs do. Those must be posted as returned, not rebuilt. */
export function hasEbayCustomId(rawUrl: string, customId: string): boolean {
  try {
    return new URL(rawUrl).searchParams.get("customid") === customId;
  } catch {
    return false;
  }
}

/** Canonical parameter-free listing URL. Tracking is applied separately. */
export function canonicalEbayUrl(itemId: string): string {
  return `https://${EBAY_MARKETPLACE}/itm/${itemId}`;
}

/** Canonical product URL for a listing row, whichever marketplace it is on. */
export function canonicalListingUrl(itemId: string, marketplace: string): string {
  return marketplace === EBAY_MARKETPLACE
    ? canonicalEbayUrl(itemId)
    : canonicalAmazonUrl(itemId, marketplace);
}

/**
 * Rebuild a listing URL with our campaign ID, and the post ID as `customid`
 * once there is one. Everything the input carried (a source's tracking, a
 * foreign campaign) is dropped, so this is idempotent. Input that isn't a
 * listing URL is returned unchanged, and validateDealText rejects it.
 */
export function withEbayTracking(rawUrl: string, campaignId: string, customId?: string): string {
  const itemId = extractEbayItemId(rawUrl);
  if (!itemId || !campaignId) return rawUrl;
  const url = new URL(canonicalEbayUrl(itemId));
  url.searchParams.set("mkcid", "1");
  url.searchParams.set("mkrid", "711-53200-19255-0");
  url.searchParams.set("siteid", "0");
  url.searchParams.set("campid", campaignId);
  if (customId) url.searchParams.set("customid", customId);
  url.searchParams.set("toolid", "10001");
  url.searchParams.set("mkevt", "1");
  return url.toString();
}
