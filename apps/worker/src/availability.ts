import { createPaapiClient, PaapiAuthError, type PaapiClient } from "./paapi.js";

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

let client: PaapiClient | null | undefined;
let authDead = false;

/** Test seam: replace/reset the lazily created client. */
export function setPaapiClientForTest(next: PaapiClient | null | undefined): void {
  client = next;
  authDead = false;
}

export type Availability = "orderable" | "unavailable" | "unknown";

export async function checkSearchAvailability(query: string): Promise<Availability> {
  if (authDead) return "unknown";
  if (client === undefined) client = createPaapiClient();
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
    if (error instanceof PaapiAuthError) {
      // Dead keys: stop asking for the life of the process (same policy as
      // the deal checker) — the check quietly degrades to "unknown".
      authDead = true;
      console.error(`[availability] PA-API auth failed — checks disabled: ${error.message}`);
      return "unknown";
    }
    // Transient/network: never block a reply on Amazon's API being flaky.
    console.warn(
      `[availability] check failed for "${query}" — proceeding unchecked: ${error instanceof Error ? error.message : error}`,
    );
    return "unknown";
  }
}
