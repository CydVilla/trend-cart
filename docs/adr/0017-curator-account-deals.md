# ADR-0017: Curator-account deal sources — relaying Bluesky deal posts, price-free

**Status:** Accepted

## Context
The RSS channel (ADR-0013) is the bot's no-PA-API deal source, but deal-site
feeds refresh slowly and most of what the operator wants to relay is posted
first, and in volume, by curator accounts on Bluesky — Wario64 above all.
Those posts carry the curator's own affiliate links (amzn.to short links),
their prices, and their wording. The bot also has to keep working while the
Anthropic account is out of credit, and pick the LLM steps back up on its own
once credit returns.

## Decision
**A `DealSuggestionSource` whose URL is `https://bsky.app/profile/<handle>`
is a curator account.** The worker reads it through the public, unauthenticated
Bluesky AppView (`app.bsky.feed.getAuthorFeed`, top-level posts only) and
feeds each post into the same staging → ranking → verification → posting
pipeline as RSS items, as a new `CURATED` `DealSource` channel.

- **Our link only.** Each post's Amazon link is resolved to an ASIN by reading
  the short link's redirect `Location` header (HEAD, redirects not followed —
  no Amazon page is loaded, nothing is scraped). The product URL is rebuilt
  canonically from the ASIN and tagged with ours; the curator's tag never
  survives. Store pages, searches, and posts naming several distinct Amazon
  products are skipped — no single ASIN, no post.
- **Price-free, kind-correct, attributed copy.** The product name is extracted
  from the line carrying the Amazon link (falling back to the headline), with
  every price, percentage, and savings figure stripped. The post says the
  item is on sale / up for pre-order / back in stock on Amazon — a pre-order
  is never called a sale — and credits the curator in plain text
  ("(via Wario64)", no @-mention, so the curator isn't pinged per post).
  ADR-0013's rule holds: the reader sees the real price on Amazon.
- **Own budget and cadence.** Curators post far more than RSS feeds refresh:
  polled every `DEAL_CURATED_INTERVAL_MINUTES` (3), capped at
  `DEAL_CURATED_MAX_POSTS_PER_DAY` (12) with a `DEAL_CURATED_COOLDOWN_MINUTES`
  (20) gap. CURATED posts count against neither the RSS nor the PA-API caps,
  and those channels' posts don't count against CURATED. The lane-diversity
  penalty only orders the curated queue (it isn't a floor), so a second
  movie deal in a day can still post. A curator post older than
  `DEAL_CURATED_MAX_AGE_MINUTES` (120) is not evidence of a live deal.
- **Tokenless by default, LLM when credit allows — decided per call.** Every
  LLM step checks the shared billing gate (`llm-health.ts`) at call time:
  | Step | With credit | Without credit / on LLM failure |
  | --- | --- | --- |
  | Lane gate | `judgeDealSuggestion` | keyword lanes (`heuristicLane`) |
  | Verification | web-search corroboration (existence + orderability); a completed failing verdict dismisses | the curator's fresh post is the evidence (`mode: "source-attested"`) |
  | Copy | `writeDealPost` lead, re-validated in code (no price, names Amazon and the product, kind-correct) | concrete template, chosen deterministically per ASIN |
  The audit JSON on each `DealSuggestion` records which path ran. A top-up
  needs no restart: the first successful call clears the gate.
- **Out of credit no longer writes RSS candidates off.** The RSS lane gate and
  promotion stand down while the billing gate is armed (candidates stay NEW
  and are judged when credit returns, or expire), where previously every
  candidate's fact check returned null and was dismissed as unverified.
- `DEAL_CURATED_AUTOPOST` (default off = audit-only DRY_RUN rows) gates
  publishing, under the usual `DEALS_ENABLED` / `DRY_RUN` switches.

## Consequences
- Wario64's deals reach the profile within minutes, with the bot's tag, even
  with zero LLM credit.
- In tokenless mode nothing independently checks the listing: the bot relays
  the curator's claim, attributed, without repeating any price. The exclude
  keywords seeded on the Wario64 row ("likely an error", "price error",
  "YMMV", "targeted", …) keep flagged price mistakes and conditional deals out.
- Heuristic lanes drop items outside the high-conversion lanes (groceries,
  household goods). With credit, the LLM lane judge decides instead.
- Curator attribution names the account in copy. Changing that is a template
  edit in `deals/curated.ts`.
