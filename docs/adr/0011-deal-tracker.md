# ADR-0011: Deal tracker — target-price alerts as standalone profile posts

**Status:** Accepted

## Context
Beyond replying to other people's posts, the operator wants the bot to
broadcast deals from its own account: a manually-curated watchlist of specific
Amazon listings (a PS5, etc.), each with a target price, that the bot posts
about — with the affiliate link — when the price drops. This is a different
posting mode (top-level posts, not replies) and a different data source
(Amazon prices, not Bluesky).

Two constraints shaped it. First, compliant price data means Amazon's Product
Advertising API (PA-API 5.0), which requires an approved Associate account
with 3 qualifying sales — the operator may not have keys yet. Second,
standalone promotional posts are more spam-prone than contextual replies, so
the anti-spam posture must be tighter.

## Decision
A **manual watchlist + target-price trigger + standalone poster**, reusing
every existing pattern (exactly-once `updateMany` claim, DRY_RUN master gate,
DB-derived cooldowns, byte-offset link facets, `isAmazonHost`/`withAffiliateTag`
tag enforcement).

- **Two models.** `TrackedListing` (watchlist row + persisted detection state)
  and `DealPost` (audit + publish queue, the analog of `BotReply`). Prices are
  integer cents everywhere so the `<=` comparison is exact.
- **Two worker loops**, behind `DEALS_ENABLED`. `dealCheck` polls due listings
  via PA-API GetItems (≤10 ASINs/call, ~1 TPS), runs the trigger, and FIRES
  exactly-once (ARMED→FIRED claim) into a `DealPost`. `dealPost` publishes
  READY rows as standalone `app.bsky.feed.post`s with the link on a fixed
  anchor facet, a `#ad` tag facet, and an optional external card.
- **Full price + optional alert price.** Each listing has a `fullPriceCents`
  (the normal value — the % discount is computed against it, and the listing
  fires on ANY drop below it) and an optional stricter `targetPriceCents` (fire
  only at/below this). The fire threshold is `targetPriceCents ?? fullPriceCents`;
  the full-price guard blocks a post when the item sits at its normal price
  (no real discount). Re-arm hysteresis (rise above `threshold*(1+buffer)`),
  identical-price dedup, and a per-listing cooldown keep it to one post per sale.
- **Two data paths, one queue.** Automated (PA-API) and manual ("Post deal now"
  in the dashboard — operator supplies the sale price, no API needed) both
  create `DealPost`s consumed by the same poster. When PA-API keys are absent
  the check loop stands down and only the manual path runs, so the feature is
  usable before Associate/PA-API approval.
- **Hand-signed SigV4.** The PA-API client signs requests with Node crypto
  (verified against AWS's published test vector) rather than an opaque, often
  stale SDK; every response field path is isolated in one `mapItem()` for the
  eventual classic-Offers → OffersV2 migration.
- **Compliance in the model.** Every link is tag-enforced; every post carries
  `#ad`, an "as of <time>" stamp, and "price subject to change"; prices older
  than `DEAL_MAX_PRICE_AGE_HOURS` (1) are never posted; Amazon images are
  linked live, never re-hosted. The `/about` page carries the profile-level
  backstop.

## Consequences
- The feature ships dark; enabling it is `DEALS_ENABLED=true` (+ PA-API keys for
  automation), no code change. DRY_RUN still gates all posting.
- v1 is single-marketplace (USD); the `marketplace`/`currency` columns exist so
  multi-locale is a later addition, not a migration.
- The bot's account becomes a mixed reply+broadcast account; tight caps
  (3 posts/day, 7-day per-listing cooldown, 60-min global gap) keep it from
  reading as spam.
- A crashed publish leaves a stranded row; the FIRED-recovery sweep re-arms
  safely, and (as with the reply poster) a stuck POSTING row is left for the
  operator rather than auto-retried, trading liveness for no-double-post.
