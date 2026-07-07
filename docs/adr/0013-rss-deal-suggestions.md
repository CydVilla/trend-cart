# ADR-0013: RSS deal suggestions — human-attested prices before PA-API exists

**Status:** Accepted

## Context
The deal feeds (ADR-0012) and watchlist polling both require PA-API keys,
which Amazon grants only after 3 qualifying sales — a chicken-and-egg for a
new Associate: the profile needs deal posts to drive the sales that unlock
automation. The operator wants a semi-automated bridge focused on two lanes —
tech & electronics, and clothing tied to TV/movie/game/pop-culture fandoms —
without scraping Amazon (ToS) and without advertising third-party prices the
bot can't verify.

## Decision
**Poll deal-site RSS feeds into a suggestion queue; the operator attests the
price; the manual posting path does the rest.**

- **`DealSuggestionSource`** = one RSS feed + one topical lane: plain-words
  `topic` criteria, optional include/exclude keyword prefilters, optional
  price band. The worker polls each active source on an interval with a
  dependency-free RSS 2.0 parser (same rationale as the hand-signed SigV4
  client: four fields don't justify an XML dependency).
- **Amazon-only, canonically.** An item qualifies only if a real Amazon
  product URL is found in its link/description — directly or URL-encoded
  inside a deal-site redirect parameter. The ASIN is extracted and the product
  URL **rebuilt canonically**, so the deal site's affiliate tag never
  survives; lookalike hosts fail the existing allowlist; shorteners
  (amzn.to) are skipped as unresolvable.
- **Two-stage lane gate**, mirroring ADR-0002's cheap-filter → LLM →
  server-gates shape: keyword include/exclude first, then one small
  deterministic LLM judgment per headline ("does this fit the lane?") against
  the source's `topic`, stored on the suggestion for audit. Headlines are
  untrusted text and are tagged/sanitized like post content. No LLM key →
  keyword-only mode. LLM errors fail OPEN (the operator is the real gate);
  off-lane verdicts fail CLOSED. Per-tick LLM budget bounds cost.
- **Prices are hints, never facts.** The `$` amount parsed from a headline is
  shown as "seen at ~$X" only. To post, the operator checks the live Amazon
  page and types the price they see — `priceAsOf` = confirmation time, so the
  existing freshness ceiling and the "no unattested third-party price" rule
  hold. Queued posts are `MANUAL` source (operator-initiated → same throttle
  bypass as "Post deal now") and reuse the per-ASIN `DISCOVERED` listing
  dedup, cooldown, and ban switch.
- **Suggestions rot**: NEW rows auto-expire after `DEAL_SUGGEST_EXPIRE_HOURS`
  (48) so the queue only ever shows plausibly-live deals; guid + ASIN dedup
  keeps refetches and cross-source repeats out.

## Consequences
- The bot's deal channel works end-to-end before PA-API approval; the posts it
  produces drive the qualifying sales that unlock ADR-0012's automation, after
  which the RSS path remains useful for deals PA-API search wouldn't surface.
- Each post costs one operator confirmation — deliberate, not a limitation:
  it is what makes the price compliant to advertise.
- The parser handles RSS 2.0 (what deal sites publish); Atom feeds would need
  a small extension.
- Feed hosts may block unfamiliar user agents or change redirect formats; the
  per-source `lastFetchError` surfaces this in the dashboard, and failures
  never hot-loop (a failed fetch waits out the full interval).
