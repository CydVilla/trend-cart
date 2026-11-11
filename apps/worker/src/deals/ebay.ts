import {
  cleanDealTitle,
  EBAY_MARKETPLACE,
  extractEbayItemId,
  shortenAmazonTitle,
  validateDealText,
} from "@trendcart/shared";
import { hasPriceClaim } from "./curated.js";
import { stripUnverifiedPriceClaims, type AmazonMatch, type RssItem } from "./rss.js";

/**
 * eBay channel (ADR-0018): turns a Slickdeals feed item into one eBay listing.
 *
 * Slickdeals prints each outbound link as its own anchor text, shortening long
 * ones in the middle ("https://www.ebay.com/itm/96017548...9497"). Only a link
 * printed whole yields a usable item ID. Recovering a shortened one would mean
 * calling Slickdeals' click tracker, which we never do, so those items are
 * skipped. So are items naming more than one listing: no single item, no post.
 */

/** `priceCents` is set when eBay's API reported the price (never advertised). */
export type EbayItem = RssItem & { ebay: AmazonMatch & { priceCents?: number } };

export const EBAY_DEAL_ANCHOR = "check eBay's current offer";

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

function attr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return (match?.[2] ?? "").toLowerCase();
}

/** The one complete eBay item ID an item links to, or null. */
export function matchEbayItemId(item: RssItem): string | null {
  const ids = new Set<string>();
  for (const anchor of `${item.description} ${item.content}`.matchAll(ANCHOR_RE)) {
    const attrs = anchor[1]!;
    if (attr(attrs, "data-store-slug") !== "ebay" && attr(attrs, "data-product-exitwebsite") !== "ebay.com") {
      continue;
    }
    const printed = anchor[2]!.replace(/<wbr\s*\/?>/gi, "").replace(/<[^>]+>/g, "").trim();
    const id = printed.includes("...") || printed.includes("…") ? null : extractEbayItemId(printed);
    if (!id) return null; // an eBay link we can't read could be the real product
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** The feed item with its listing attached, or null when it names none. */
export function ebayFeedItem(item: RssItem): EbayItem | null {
  const asin = matchEbayItemId(item);
  if (!asin) return null;
  return {
    ...item,
    ebay: { asin, marketplace: EBAY_MARKETPLACE, matchConfidence: 95, evidence: "ebay-exit-link" },
  };
}

/** "$626 - Refurb - Acer Aspire 15 on eBay" → "Refurb - Acer Aspire 15". */
export function ebayDealTitle(raw: string): string {
  const cleaned = stripUnverifiedPriceClaims(cleanDealTitle(raw))
    .replace(/^[\s\-–—:,;|+@&/]+/, "")
    .replace(/\s*\b(?:via|at|on|from)?\s*ebay\b[\s.!]*$/i, "")
    .replace(/[\s\-–—:,;|+@&/]+$/, "");
  return shortenAmazonTitle(cleaned, 120);
}

/** Price-free post text, or null when it can't pass the deal-text validator. */
export function composeEbayDeal(input: {
  rawTitle: string;
  sourceLabel: string;
  linkUrl: string;
  maxLength: number;
}): { text: string; anchor: string } | null {
  const title = ebayDealTitle(input.rawTitle);
  if (title.length < 8 || hasPriceClaim(title)) return null;
  const text = `Deal spotted via ${input.sourceLabel}: ${title} is currently discounted on eBay — ${EBAY_DEAL_ANCHOR} #ad`;
  return validateDealText(text, input.linkUrl, input.maxLength, EBAY_DEAL_ANCHOR).ok
    ? { text, anchor: EBAY_DEAL_ANCHOR }
    : null;
}
