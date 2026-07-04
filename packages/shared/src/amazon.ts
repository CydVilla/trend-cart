/**
 * Amazon affiliate URL helpers.
 * Ported from the amazon-search repo (src/App.js `generateAmazonLink`):
 * links are built dynamically and the associate tag comes from env,
 * never hardcoded, so the tag can change without touching data.
 */

/**
 * Strict Amazon hostname allowlist. A suffix-style regex like
 * `amazon\.[a-z.]+$` is bypassable (amazon.evil.com) — enumerate instead.
 */
const AMAZON_DOMAINS = new Set([
  "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.fr",
  "amazon.es", "amazon.it", "amazon.co.jp", "amazon.com.mx", "amazon.com.au",
  "amazon.in", "amazon.nl", "amazon.se", "amazon.com.br", "amzn.to", "a.co",
]);

/** True only for real Amazon (or Amazon shortener) hostnames. */
export function isAmazonHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return AMAZON_DOMAINS.has(bare);
}

/** Build an Amazon search URL for a query, tagged with the associate ID if provided. */
export function amazonSearchUrl(searchQuery: string, associateTag?: string): string {
  const url = new URL("https://www.amazon.com/s");
  url.searchParams.set("k", searchQuery);
  if (associateTag) {
    url.searchParams.set("tag", associateTag);
  }
  return url.toString();
}

/**
 * Append the associate tag to an existing Amazon URL (product page or search).
 * Non-Amazon URLs and unparseable strings are returned unchanged, so this is
 * safe to call on every Product.url regardless of merchant.
 */
export function withAffiliateTag(rawUrl: string, associateTag: string): string {
  if (!associateTag) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!isAmazonHost(url.hostname)) return rawUrl;
    url.searchParams.set("tag", associateTag);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

const ASIN_RE = /^[A-Z0-9]{10}$/i;

/**
 * Pull the 10-char ASIN out of any Amazon product URL form
 * (/dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN, /product/ASIN, ?asin=…) or a
 * bare ASIN string. Returns uppercase ASIN or null.
 *
 * Returns null for amzn.to / a.co shorteners: they can't be resolved offline,
 * so the caller (dashboard) forces the operator to paste a canonical /dp/ URL.
 */
export function extractAsin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (ASIN_RE.test(trimmed)) return trimmed.toUpperCase();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!isAmazonHost(url.hostname)) return null;
  const bare = url.hostname.toLowerCase().replace(/^www\./, "");
  if (bare === "amzn.to" || bare === "a.co") return null; // unresolvable shortener

  const segments = url.pathname.split("/").filter(Boolean);
  // Strongest signal: the segment right after a known product marker.
  const markers = new Set(["dp", "product", "d", "gp"]);
  for (let i = 0; i < segments.length; i++) {
    if (markers.has(segments[i]!.toLowerCase())) {
      const next = segments[i + 1];
      if (next && ASIN_RE.test(next)) return next.toUpperCase();
    }
  }
  const query = url.searchParams.get("asin") ?? url.searchParams.get("ASIN");
  if (query && ASIN_RE.test(query)) return query.toUpperCase();
  // Fallback: an already-uppercase 10-char segment (avoids matching lowercase
  // title slugs, which are never ASINs).
  for (const seg of segments) {
    if (/^[A-Z0-9]{10}$/.test(seg)) return seg;
  }
  return null;
}

/** Canonical tag-free product URL for an ASIN. Tag is applied separately. */
export function canonicalAmazonUrl(asin: string, host = "www.amazon.com"): string {
  return `https://${host}/dp/${asin}`;
}

/**
 * Parse a human price ("399.99", "$1,299.00") into integer cents, or null if
 * malformed. Rejects negatives and more than two decimal places so the
 * exact-cents price comparison downstream is trustworthy.
 */
export function parseCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}
