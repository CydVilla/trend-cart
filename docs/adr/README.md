# Architecture Decision Records

Short records of the decisions that shaped TrendCart, in the order they were
made. Format: Status / Context / Decision / Consequences.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-firehose-discovery.md) | Jetstream firehose + keyword pre-filter for discovery | Superseded by 0008 |
| [0002](0002-llm-verdicts-are-advisory.md) | LLM verdicts are advisory; server-side gates are authoritative | Accepted |
| [0003](0003-manual-approval-and-exactly-once.md) | Manual approval, DRY_RUN master switch, exactly-once posting | Accepted |
| [0004](0004-disclosed-bot-posture.md) | Disclosed bot with in-reply affiliate disclosure | Accepted |
| [0005](0005-trending-floor.md) | Maturation + engagement floor before evaluation | Accepted |
| [0006](0006-link-facets-and-priority.md) | Links as rich-text facets; operator > search > page priority | Amended by 0010 (page fallback → category search) |
| [0007](0007-solicited-surfaces.md) | Mentions as requests; phrase-based opt-out; operator overrides | Accepted |
| [0008](0008-search-discovery.md) | Search-based discovery: top posts of the last 24h per query | Accepted |
| [0009](0009-autonomous-mode-and-learning.md) | Autonomous mode with escalation; learning from operator decisions | Accepted |
| [0010](0010-retire-site-catalog.md) | Retire product catalog + public pages; direct Amazon links only | Accepted |
| [0011](0011-deal-tracker.md) | Deal tracker: target-price alerts as standalone profile posts | Accepted |
| [0012](0012-deal-feed-discovery.md) | Deal feeds: Wario64-style sale discovery on the bot's profile | Accepted |
| [0013](0013-rss-deal-suggestions.md) | RSS deal suggestions: human-attested prices before PA-API exists | Accepted |
