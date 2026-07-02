/**
 * Amazon affiliate URL helpers.
 * Ported from the amazon-search repo (src/App.js `generateAmazonLink`):
 * links are built dynamically and the associate tag comes from env,
 * never hardcoded, so the tag can change without touching data.
 */

const AMAZON_HOSTS = /(^|\.)amazon\.[a-z.]+$|(^|\.)amzn\.to$/i;

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
    if (!AMAZON_HOSTS.test(url.hostname)) return rawUrl;
    url.searchParams.set("tag", associateTag);
    return url.toString();
  } catch {
    return rawUrl;
  }
}
