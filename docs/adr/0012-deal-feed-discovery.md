# ADR-0012: Deal feeds — Wario64-style sale discovery on the bot's profile

**Status:** Accepted

## Context
ADR-0011's deal tracker only posts about listings the operator hand-picked and
priced. The operator wants the bot's profile to work like a deal account
(Wario64 as the reference): a stream of terse posts for Amazon products that
are *currently on sale*, found automatically, always carrying the affiliate
link. Two things had to be designed: where "on sale" comes from, and how an
automated broadcast channel stays inside this project's conservative posture.

## Decision
**Saved PA-API searches ("deal feeds") + the existing DealPost pipeline + a
terser post style.**

- **Discovery = PA-API `SearchItems` with `MinSavingPercent`.** Each `DealFeed`
  row is a saved search (keywords, SearchIndex, min % off, price band, review
  floors, sold-by-Amazon toggle) the worker polls on an interval. "On sale"
  means a real strikethrough: the offer price sits below Amazon's own list
  price (`SavingBasis`). Every gate is re-checked server-side from the response
  (ADR-0002 discipline — the API filter is never trusted alone). Sold-by-Amazon
  is the default because third-party strikethrough prices are routinely
  inflated; review floors keep junk products out and apply only when Amazon
  returns review data.
- **Discovered ASINs become `TrackedListing` rows with `origin=DISCOVERED`** —
  pure dedup/cooldown state reusing the per-listing cooldown, identical-price
  dedup, and the operator's pause switch (a paused discovered listing = "never
  post this again"). They are never polled by the GetItems checker (`origin`
  filter), so the discovered set can grow without burning quota. Deals queue
  through the same `DealPost` ledger and exactly-once poster.
- **Approval-gated by default, autopost by choice.** A standalone promo post is
  the spammiest thing the bot does, and discovered products weren't vetted by a
  human — so discovered deals queue as `PENDING_APPROVAL` unless
  `DEAL_FEED_AUTOPOST=true`. Deals are perishable: a pending approval whose
  price snapshot exceeds the freshness ceiling (1h) auto-expires, so the queue
  only ever shows actionable deals, and DRY_RUN still overrides everything.
- **Separate, smaller daily budget.** Discovered posts spend
  `DEAL_FEED_MAX_POSTS_PER_DAY` (2) inside the global `DEAL_MAX_POSTS_PER_DAY`
  (3), so a hot feed can never starve the operator's hand-picked watchlist
  alerts; the poster throttles DISCOVERED like AUTOMATED (global gap + daily
  cap), while MANUAL keeps its operator-initiated bypass.
- **Wario64-style copy is the new default** (`DEAL_POST_STYLE=wario`,
  `classic` preserved): `"<Title> is $39.99 on Amazon (33% off, reg. $59.99)
  #ad"` with the compliance line (`price as of <time> — subject to change`) on
  its own line. The **price phrase itself is the link anchor**, so the anchor
  is now per-post (`DealPost.linkAnchor`; null = legacy fixed anchor). Amazon's
  keyword-stuffed titles are shortened deterministically (cut at the first
  strong separator outside parentheses — platform markers like "(Switch)"
  survive). No "lowest price ever" claims: we have no price history to back
  them.

## Consequences
- The profile becomes a real deals feed only when the operator raises the caps
  (`DEAL_MAX_POSTS_PER_DAY`, `DEAL_FEED_MAX_POSTS_PER_DAY`, global gap) and
  flips autopost — the defaults stay deliberately timid.
- Feed discovery needs PA-API keys (an approved Associate account); without
  them the loop stands down and the watchlist/manual paths are unaffected.
- SearchItems spends the shared PA-API daily budget alongside GetItems; the
  1 TPS serializer and daily cap cover both.
- A rejected deal at a given price never re-queues (queue-time
  `lastPostedPriceCents` stamp); the same item re-qualifies only at a new
  price or after the cooldown.
