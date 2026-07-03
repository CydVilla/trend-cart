# ADR-0005: Maturation + engagement floor before evaluation

**Status:** Accepted

## Context
Firehose posts are captured at creation with zero engagement. Evaluating
immediately (a) wastes LLM budget on posts nobody will see, (b) makes the
"trending" premise a no-op, and (c) produces bot-like ~3-minute reply
latency. Live data showed junk posts consuming the entire evaluation budget.

## Decision
Firehose candidates wait `EVAL_MIN_POST_AGE_MINUTES` (30) and must then show
`engagementScore >= MIN_ENGAGEMENT_SCORE` (10) to be evaluated, ordered by
engagement descending. Below-floor posts keep waiting (they may still rise)
and expire unevaluated at 24h — costing nothing. Authors whose bio matches
promotional patterns are rejected before any LLM call. Solicited (MENTION)
and operator-injected (MANUAL) posts skip both gates.

## Consequences
- The LLM only sees posts that are recent AND demonstrably interesting to
  humans; spend correlates with opportunity.
- Reply latency to organic posts is ≥30 minutes by design — acceptable for
  thread-visibility, and it reads less bot-like.
- The floor is an env knob; discovery volume tuning is data, not code.
