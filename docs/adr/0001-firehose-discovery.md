# ADR-0001: Jetstream firehose + keyword pre-filter for discovery

**Status:** Accepted — supersession by `app.bsky.feed.searchPosts` polling is
planned (see README roadmap #1).

## Context
The bot needs candidate posts. Options: consume the full firehose and filter
locally, or poll Bluesky's search API per category.

## Decision
MVP consumes Jetstream (JSON firehose) and filters with per-category keyword
lists stored in the database (hot-reloaded, dashboard-editable). Cheap regex
gates (sensitive topics, promotional markers) run AFTER category matching so
their kills are observable, and the matched keyword is persisted per post.

## Consequences
- Zero API-quota concerns and full coverage, but poor precision: live data
  showed most keyword hits are false positives, mitigated by the maturation +
  engagement floor (ADR-0005) and the LLM stage.
- Posts are captured at creation with zero engagement, forcing the separate
  rehydration loop against the public AppView.
- Keyword lists double as recall triggers and category labels — a known
  tension; the category the LLM assigns is authoritative, keywords are hints.
- searchPosts polling would give precision + engagement-at-discovery and is
  the intended replacement; the pipeline downstream of `Post` rows is
  discovery-agnostic, so the swap is contained.
