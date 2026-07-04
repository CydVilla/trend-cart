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
