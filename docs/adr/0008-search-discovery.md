# ADR-0008: Search-based discovery — top posts of the last 24h per query

**Status:** Accepted (supersedes ADR-0001)

## Context
Live evidence closed the case on the firehose: of 585 posts it captured, only
11% ever reached the engagement floor; the rest were dead rows. Capturing at
creation (zero engagement) forced the maturation wait, the velocity
machinery, and a heavy always-on WebSocket — all to approximate what Bluesky
search answers directly: "which recent posts about X are people actually
liking?" The operator's stated requirement was literally "trending posts
that are recent and have a lot of likes."

## Decision
Discovery polls `app.bsky.feed.searchPosts` (authenticated with the bot's
session; the public AppView 403s unauthenticated search) every
`DISCOVER_INTERVAL_MINUTES`: for each active category, the first 6 `keywords`
run as queries with `sort=top`, `since=now-24h`, 10 results each. Results
pass the same cheap gates (length, language, sensitive, promo) plus the
engagement floor AT DISCOVERY, then persist as `source=SEARCH` candidates —
already hydrated, no maturation wait. Category keywords are therefore now
search queries, dashboard-editable. Retired with the firehose:
`jetstream.ts`, `ingest.ts`, the CategoryMatcher, and the never-consulted
`engagementVelocity` column.

## Consequences
- ~50 HTTP queries per 15-minute cycle replace ~5M firehose events/day, and
  every stored candidate is already worth evaluating.
- Discovery requires bot credentials (like posting); without them the loop
  is disabled with a warning — manual injection still works.
- Search relevance is Bluesky's, not ours: query phrasing matters more than
  regex precision, and the low-signal/statement gate still guards LLM spend.
- Legacy FIREHOSE rows keep their original evaluation rules until they age
  out; the enum value stays for provenance.
