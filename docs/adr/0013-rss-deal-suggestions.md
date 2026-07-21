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

## Addendum (2026-07-18): automated, price-free
The operator dropped the manual confirmation step — the channel's whole point
is now automated Wario64-style self-posting. The price rule SURVIVES the
automation by inverting the solution: instead of a human attesting the price,
the post stops advertising any price at all. Copy is price-free and
source-attributed ("<item> is on sale right now (spotted via Slickdeals) —
see the deal on Amazon #ad"); hint prices from headlines are stripped from
titles and used only for the source's price-band filter and audit rows. A
web-search fact check (same machinery as the reply gate) corroborates each
deal before it posts, gate errors fail closed, and `DEAL_RSS_AUTOPOST`
(default off = audit-only) plus `DEAL_RSS_MAX_POSTS_PER_DAY` bound the
channel. When PA-API credentials arrive, ADR-0012's feed discovery takes over
with real attested prices; this path remains for deals PA-API search wouldn't
surface. The operator-confirmation UI, watchlist, and "Post deal now" manual
path were removed with it.

## Addendum (2026-07-21): ranked candidates and strict sale evidence

Feed order no longer decides what posts. New RSS items enter a short-lived
`DealSuggestion.NEW` staging queue with a high-conversion lane and an
explainable base score. After all due sources contribute, the worker ranks the
queue globally. A bounded rolling boost from real deal-link clicks and profile
engagement promotes successful topics; a same-day lane penalty preserves
diversity and exploration.

Before promotion, Amazon references are collected and ranked instead of using
the first link in feed markup; conflicting ASINs fail closed. The expensive
web-search verifier receives the ASIN, canonical product URL, source URL, and
feed publication time. It must separately affirm exact-product match,
orderability, and fresh evidence that the item is discounted **on Amazon**.
"Plausible sale" is no longer sufficient. Code also requires a successful
search-result block, an exact-ASIN Amazon evidence URL, and a fresh sale-page
URL/date returned by that search; those URLs stay in the audit verdict. The
final post remains price-free, and its verification expires before posting if
the queue is delayed.

Promotion uses an atomic `VERIFYING` claim plus a unique candidate-to-post
relation. Stale claims recover after a worker crash, paused sources cannot
promote staged rows, and cooldown/capacity are rechecked in the serializable
creation transaction and again by the poster.
