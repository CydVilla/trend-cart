import {
  EBAY_MARKETPLACE,
  canonicalEbayUrl,
  formatAsOf,
  formatMoney,
  shortenAmazonTitle,
  validateDealText,
} from "@trendcart/shared";
import { hasPriceClaim } from "./curated.js";
import type { EbayItem } from "./ebay.js";

/**
 * eBay Browse API source (ADR-0018): saved searches that find marked-down,
 * single-listing items from established sellers. Each listing is re-read
 * immediately before posting, and only the affiliate URL eBay returns is used,
 * as the API requires for commissions.
 *
 * Posts state the price the re-read returned, stamped with when it was read.
 * eBay's API license limits how stale displayed listing information may be and
 * asks that any lag be disclosed, and a Bluesky post outlives that window. The
 * operator accepted this on 2026-11-10 (ADR-0018). Photos are not posted.
 */

const API_BASE = "https://api.ebay.com";
const SCOPE = "https://api.ebay.com/oauth/api_scope";
const FETCH_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const SEARCH_LIMIT = 100;

/** Listings that look like the product but aren't, or aren't the whole of it. */
const BAD_LISTING_RE =
  /\b(?:bootleg|replica|knock-?off|custom|proxy|reprint|fan[- ]?made|3d[- ]?print(?:ed)?|for parts|not working|empty box|box only|case only|read|digital code|lot of)\b/i;

export type BrowseCreds = { appId: string; certId: string; campaignId: string };

export type BrowseCriteria = {
  minDiscountPercent: number;
  minSellerFeedbackPercent: number;
  minSellerFeedbackScore: number;
};

export type BrowseListing = {
  itemId: string;
  title: string;
  priceCents: number;
  discountPercent: number;
};

/** What the pre-post re-read found. */
export type BrowseCheck =
  | { status: "ok"; title: string; priceCents: number; discountPercent: number; affiliateUrl: string }
  | { status: "unavailable"; reason: string };

type JsonRecord = Record<string, unknown>;

function rec(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function usdCents(value: unknown): number | null {
  const money = rec(value);
  if (money.currency !== "USD") return null;
  const amount = Number(money.value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

/** Why an API item can't be posted, or null when it qualifies. Shared by the
 *  search and the re-read, so a listing is held to one standard. */
export function disqualification(raw: JsonRecord, criteria: BrowseCriteria): string | null {
  if (raw.itemGroupHref || raw.itemGroupType) return "multi_variation";
  if (!String(raw.itemId ?? "").endsWith("|0")) return "multi_variation";
  const options = raw.buyingOptions;
  if (!Array.isArray(options) || !options.includes("FIXED_PRICE")) return "not_fixed_price";
  if (raw.adultOnly === true) return "adult_only";
  if (BAD_LISTING_RE.test(String(raw.title ?? ""))) return "bad_listing_title";
  if (usdCents(raw.price) === null) return "no_usd_price";
  const marketing = rec(raw.marketingPrice);
  // Minimum-advertised-price items restrict where the discount may be stated.
  if (raw.priceDisplayCondition || marketing.priceTreatment === "MINIMUM_ADVERTISED_PRICE") {
    return "map_restricted";
  }
  if (Number(marketing.discountPercentage ?? 0) < criteria.minDiscountPercent) return "discount_too_small";
  const seller = rec(raw.seller);
  if (Number(seller.feedbackPercentage ?? 0) < criteria.minSellerFeedbackPercent) return "seller_feedback_low";
  if (Number(seller.feedbackScore ?? 0) < criteria.minSellerFeedbackScore) return "seller_too_new";
  return null;
}

/** One search response → qualifying listings, deepest discount first. */
export function parseSearchResults(json: unknown, criteria: BrowseCriteria): BrowseListing[] {
  const summaries = rec(json).itemSummaries;
  if (!Array.isArray(summaries)) return [];
  const listings: BrowseListing[] = [];
  for (const entry of summaries) {
    const raw = rec(entry);
    if (disqualification(raw, criteria)) continue;
    const itemId = String(raw.legacyItemId ?? "");
    const title = String(raw.title ?? "").trim();
    const priceCents = usdCents(raw.price);
    if (!/^\d{9,14}$/.test(itemId) || !title || priceCents === null) continue;
    listings.push({
      itemId,
      title,
      priceCents,
      discountPercent: Number(rec(raw.marketingPrice).discountPercentage),
    });
  }
  return listings.sort((a, b) => b.discountPercent - a.discountPercent);
}

/** Judge a re-read item, which also says whether it can still be bought. */
export function parseItemCheck(json: unknown, criteria: BrowseCriteria, now: Date): BrowseCheck {
  const raw = rec(json);
  const failed = disqualification(raw, criteria);
  if (failed) return { status: "unavailable", reason: failed };
  const ends = raw.itemEndDate ? new Date(String(raw.itemEndDate)) : null;
  if (ends && ends.getTime() <= now.getTime()) return { status: "unavailable", reason: "ended" };
  const availability = Array.isArray(raw.estimatedAvailabilities) ? raw.estimatedAvailabilities : [];
  const statuses = availability.map((a) => rec(a).estimatedAvailabilityStatus);
  if (statuses.length === 0 || statuses.every((s) => s === "OUT_OF_STOCK")) {
    return { status: "unavailable", reason: "out_of_stock" };
  }
  const affiliateUrl = String(raw.itemAffiliateWebUrl ?? "");
  if (!affiliateUrl) return { status: "unavailable", reason: "no_affiliate_url" };
  return {
    status: "ok",
    title: String(raw.title ?? "").trim(),
    priceCents: usdCents(raw.price) ?? 0,
    discountPercent: Number(rec(raw.marketingPrice).discountPercentage) || 0,
    affiliateUrl,
  };
}

/** Search-result listing → the feed shape the shared staging gates expect. */
export function browseFeedItem(listing: BrowseListing, fetchedAt: Date): EbayItem {
  return {
    title: listing.title,
    link: canonicalEbayUrl(listing.itemId),
    guid: listing.itemId,
    description: "",
    content: "",
    publishedAt: fetchedAt,
    ebay: {
      asin: listing.itemId,
      marketplace: EBAY_MARKETPLACE,
      matchConfidence: 100,
      evidence: "ebay-browse",
      priceCents: listing.priceCents,
    },
  };
}

export type EbayBrowseClient = {
  search: (query: string, priceBand: { minCents: number | null; maxCents: number | null }) => Promise<BrowseListing[]>;
  /** Null = the check couldn't finish; try again later. `relax` loosens the
   *  saved-search criteria for a listing a curator vouched for; an empty
   *  `postId` reads the listing without minting a post reference. */
  check: (itemId: string, postId: string, relax?: Partial<BrowseCriteria>) => Promise<BrowseCheck | null>;
};

export function createEbayBrowseClient(
  creds: BrowseCreds,
  criteria: BrowseCriteria,
  fetchImpl: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): EbayBrowseClient {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && clock().getTime() < token.expiresAt) return token.value;
    const basic = Buffer.from(`${creds.appId}:${creds.certId}`).toString("base64");
    const response = await fetchImpl(`${API_BASE}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`eBay token request failed: HTTP ${response.status}`);
    const json = rec(await response.json());
    const value = String(json.access_token ?? "");
    if (!value) throw new Error("eBay token response had no access_token");
    token = {
      value,
      expiresAt: clock().getTime() + Number(json.expires_in ?? 0) * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return value;
  }

  async function headers(postId?: string): Promise<Record<string, string>> {
    const context = [`affiliateCampaignId=${creds.campaignId}`];
    if (postId) context.push(`affiliateReferenceId=${postId}`);
    return {
      accept: "application/json",
      authorization: `Bearer ${await accessToken()}`,
      "x-ebay-c-marketplace-id": "EBAY_US",
      "x-ebay-c-enduserctx": context.join(","),
    };
  }

  return {
    async search(query, { minCents, maxCents }) {
      const filters = [
        "buyingOptions:{FIXED_PRICE}",
        "conditions:{NEW}",
        "itemLocationCountry:US",
        "deliveryCountry:US",
      ];
      if (minCents != null || maxCents != null) {
        const bound = (cents: number | null): string => (cents == null ? "" : (cents / 100).toFixed(2));
        filters.push(`price:[${bound(minCents)}..${bound(maxCents)}]`, "priceCurrency:USD");
      }
      const url = new URL(`${API_BASE}/buy/browse/v1/item_summary/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("filter", filters.join(","));
      url.searchParams.set("limit", String(SEARCH_LIMIT));
      const response = await fetchImpl(url, {
        headers: await headers(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`eBay search failed: HTTP ${response.status}`);
      return parseSearchResults(await response.json(), criteria);
    },

    async check(itemId, postId, relax) {
      try {
        const id = encodeURIComponent(`v1|${itemId}|0`);
        const response = await fetchImpl(`${API_BASE}/buy/browse/v1/item/${id}`, {
          headers: await headers(postId || undefined),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status === 404 || response.status === 409) {
          return { status: "unavailable", reason: `http_${response.status}` };
        }
        if (!response.ok) return null;
        return parseItemCheck(await response.json(), { ...criteria, ...relax }, clock());
      } catch {
        return null;
      }
    },
  };
}

/** Priced copy for a verified listing, or null if it can't validate. The
 *  listing's own title can't add a second, unverified price. */
export function composeBrowseDeal(input: {
  listingTitle: string;
  priceCents: number;
  discountPercent: number;
  priceAsOf: Date;
  linkUrl: string;
  maxLength: number;
  /** Credit for the curator whose post surfaced the listing. */
  via?: string | null;
}): { text: string; anchor: string } | null {
  const title = shortenAmazonTitle(input.listingTitle, input.via ? 100 : 120);
  if (title.length < 8 || hasPriceClaim(title) || input.priceCents <= 0) return null;
  const anchor = `${formatMoney(input.priceCents)} on eBay`;
  const pct = Math.round(input.discountPercent);
  const off = pct >= 1 ? ` (${pct}% off)` : "";
  const via = input.via ? ` (via ${input.via})` : "";
  const text = `${title} is ${anchor}${off}${via} #ad\n\n(price as of ${formatAsOf(input.priceAsOf)} — subject to change)`;
  return validateDealText(text, input.linkUrl, input.maxLength, anchor).ok ? { text, anchor } : null;
}
