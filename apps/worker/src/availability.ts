import { createCatalogClient, CatalogAuthError, type CatalogClient } from "./creators-api.js";

/**
 * Real-time orderability check for reply search links, behind PA-API keys.
 *
 * The operator's 👎 ratings cluster on two failure modes the classifier can
 * only guess at from training data: products that don't exist yet and
 * sold-out/collector-only items. When PA-API credentials exist, ask Amazon
 * directly whether the reply's search query returns anything a buyer can
 * order NEW and IN STOCK right now — and demote the link when it doesn't.
 *
 * Best-effort by design: with no keys, on API errors, or at the daily call
 * cap the answer is "unknown" and the reply pipeline proceeds exactly as
 * before. Only a definitive empty result vetoes a link. Cost is one
 * SearchItems call per generated search-link reply (≤ MAX_REPLIES_PER_DAY/day,
 * negligible against the shared daily PA-API budget).
 */

let client: CatalogClient | null | undefined;
let authDead = false;

/**
 * Test seam: replace/reset the lazily created client.
 * @public — kept ahead of the availability tests that will use it; the tag
 * keeps Knip (repo-janitor's weekly sweep) from flagging it as unused.
 */
export function setCatalogClientForTest(next: CatalogClient | null | undefined): void {
  client = next;
  authDead = false;
}

export type Availability = "orderable" | "unavailable" | "unknown";

export async function checkSearchAvailability(query: string): Promise<Availability> {
  if (authDead) return "unknown";
  if (client === undefined) client = createCatalogClient();
  if (client === null) return "unknown"; // no credentials — feature stands down

  try {
    const items = await client.searchItems({
      keywords: query,
      searchIndex: "All",
      minSavingPercent: 0, // full catalog, not just sale items
      amazonOnly: false, // any merchant counts — the link is a search page
      itemPage: 1,
    });
    // The request already filters Availability=Available + Condition=New;
    // item.available re-verifies in-stock/new per listing. Zero items back
    // is Amazon saying "nothing orderable for this query" — a definitive no.
    return items.some((item) => item.available) ? "orderable" : "unavailable";
  } catch (error) {
    if (error instanceof CatalogAuthError) {
      // Dead keys: stop asking for the life of the process (same policy as
      // the deal checker) — the check quietly degrades to "unknown".
      authDead = true;
      console.error(`[availability] Creators API auth failed — checks disabled: ${error.message}`);
      return "unknown";
    }
    // Transient/network: never block a reply on Amazon's API being flaky.
    console.warn(
      `[availability] check failed for "${query}" — proceeding unchecked: ${error instanceof Error ? error.message : error}`,
    );
    return "unknown";
  }
}

/** The best orderable offer for a reply query, when Amazon will tell us. */
export type ReplyOffer = {
  asin: string;
  title: string | null;
  priceCents: number;
  wasPriceCents: number | null;
  /** Whole-percent discount vs the strikethrough, 0 when not discounted. */
  savingPercent: number;
  priceAsOf: Date;
};

/**
 * Resolve a reply's search query to a concrete, orderable offer — the ASIN,
 * its live price, and whether it is actually discounted.
 *
 * `null` means "no answer", NOT "not on sale": no credentials, an API error,
 * eligibility still pending, or nothing orderable. The caller must treat null
 * as unknown and fall back to its pre-price behaviour — a hard sale gate on a
 * null would silence the bot for as long as Amazon's API is dark.
 *
 * A discount is only counted against Amazon's own strikethrough
 * (`wasPriceCents`), never a computed or third-party "list price" — same
 * attestation rule the deal channel follows.
 */
export async function findBestOffer(query: string): Promise<ReplyOffer | null> {
  if (authDead) return null;
  if (client === undefined) client = createCatalogClient();
  if (client === null) return null;

  try {
    const items = await client.searchItems({
      keywords: query,
      searchIndex: "All",
      minSavingPercent: 0, // rank the whole catalog; the gate is applied here
      amazonOnly: false,
      itemPage: 1,
    });
    const orderable = items.filter((item) => item.available && item.priceCents != null);
    if (orderable.length === 0) return null;

    const scored = orderable.map((item) => {
      const price = item.priceCents as number;
      const was = item.wasPriceCents;
      const savingPercent =
        was != null && was > price ? Math.round(((was - price) / was) * 100) : 0;
      return { item, price, was, savingPercent };
    });
    // Prefer a genuine discount; ties (and an all-full-price set) fall back to
    // Amazon's own relevance order, which the search already sorted.
    scored.sort((a, b) => b.savingPercent - a.savingPercent);
    const best = scored[0];
    if (!best) return null;
    return {
      asin: best.item.asin,
      title: best.item.title,
      priceCents: best.price,
      wasPriceCents: best.was,
      savingPercent: best.savingPercent,
      priceAsOf: new Date(),
    };
  } catch (error) {
    if (error instanceof CatalogAuthError) {
      authDead = true;
      console.error(`[availability] Creators API auth failed — offers disabled: ${error.message}`);
      return null;
    }
    console.warn(
      `[availability] offer lookup failed for "${query}": ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}
