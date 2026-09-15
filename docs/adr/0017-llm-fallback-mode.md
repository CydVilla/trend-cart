# ADR-0017: LLM fallback mode — run dry without self-destructing

**Status:** Accepted

## Context
Anthropic credits can run out — an ordinary funding gap, potentially lasting
weeks. The bot had no concept of that state, and the way it failed was worse
than not running at all.

Credit exhaustion arrives as an HTTP **400** (`invalid_request_error`, "Your
credit balance is too low…"), sharing a status code with ordinary validation
errors. `isTransientError` lists only auth/rate-limit/5xx/connection failures,
so the refusal fell through to the CONTENT-failure path: each candidate was
blamed, retried three times, then written off via `recordFailedEvaluation` as
permanently `UNCERTAIN`; the reply loop wrote `FAILED` rows the same way. A
month of that would have ground the entire backlog into tombstones and left
nothing to resume — the queue destroyed by an outage that touched no data.

The second observation is that most of TrendCart does not need the model at
all. Discovery, rehydration, posting, outcome measurement, received-reply
capture, takedowns, opt-outs, click tracking, Pinterest mirroring and the
**whole deal channel** run on Bluesky's public API, Amazon's catalog API and
the DB. `deals/poster.ts` makes no Anthropic calls whatsoever.

## Decision
**Treat credit exhaustion as its own failure class, latch it, and keep the
free half of the bot running.**

- `credits.ts` owns detection (`isCreditExhaustionError`) and a **persisted**
  latch (`WorkerHeartbeat.llmOutOfCreditsAt`). Detection is deliberately
  narrow — a false latch silences a funded bot — so anything not clearly about
  money stays an ordinary, retryable error. `credits.test.ts` pins both
  directions, including the validation-400 false positive.
- Every model-dependent tick calls `llmUnavailable()` first and returns.
  Candidates stay `PENDING`; **no verdict, no failure row, nothing to undo.**
- Every catch around a model call routes through `handleLlmError`, which
  latches and tells the caller to abandon the tick *without blaming its work*.
- **Discovery and rehydration stand down too.** They exist only to feed the
  classifier: every candidate saved during an outage expires unevaluated
  inside 24h, and the volume would put a fake cliff in the funnel baseline.
- The RSS deal channel stands down entirely rather than degrading. Its lane
  gate *and* its sale verification are model calls, and ADR-0013 forbids
  self-posting a price nothing corroborated — an unverified autopost is worse
  than silence.
- An hourly probe (one 1-token call, free while the account is dry) clears the
  latch by itself. Recovery needs no redeploy and no operator action.

**What stays live:** posting, outcome measurement, takedowns, opt-outs, click
tracking, the deal poster and the Pinterest mirror.

## The operator channel
With the automated deal paths gated behind a model call, the channel that
survives is the human one: `scripts/post-deal.ts` takes a URL, title and
price, validates and composes the copy, and queues a `MANUAL` `DealPost` the
existing poster publishes within ~30s. No model, no Amazon API.

This is not a downgrade in rigor. The operator reading the price off Amazon
*is* the attestation ADR-0013 requires before any price is advertised — the
same bar the automated channel has to clear with a web-search fact check.
`MANUAL` deals already bypass the global throttles by design: those caps exist
to stop automated bursts flooding the profile, not to restrain a human.

## Consequences
- An outage costs reach, not data. The backlog is untouched and resumes intact.
- Fallback mode **reduces** load — fewer API calls, fewer DB writes, no new
  dyno and no new addon. It cannot increase hosting cost.
- The bot's public presence during an outage is entirely operator-paced.
- Detection is message-based, so a future rewording of Anthropic's refusal
  could stop matching. The failure mode is graceful (back to today's behaviour,
  which the transient-backoff path already absorbs for 10 minutes at a time)
  but it is the piece most worth re-checking after an SDK bump.
