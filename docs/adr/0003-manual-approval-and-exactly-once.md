# ADR-0003: Manual approval, DRY_RUN master switch, exactly-once posting

**Status:** Accepted

## Context
The bot's unforgivable failures are posting without consent-to-operate
(spam), posting twice, and posting when the operator believed it couldn't.

## Decision
Three independent controls:
1. `DRY_RUN=true` is the master switch — replies are recorded, never posted;
   `USE_FAKE_LLM=true` force-enables it.
2. `REPLY_MODE=manual` (the operating default) queues replies as
   PENDING_APPROVAL; a human click moves them to APPROVED.
3. The poster CLAIMS a row (`APPROVED → POSTING` via a status-guarded
   updateMany, count===1) before any network call; cooldowns derive from
   `postedAt` in the database, not process memory. All loops self-schedule
   (next tick after the current finishes) so they cannot overlap themselves.

The worker heartbeats its EFFECTIVE mode to the database; the dashboard
renders that (never its own env vars) and offers a `paused` kill switch the
worker checks every tick.

## Consequences
- A crash mid-post leaves a POSTING row (visible, non-retried) rather than a
  double post. Restarts cannot reset rate limits.
- Auto mode exists but is discouraged; every audit treats it as the risk path.
- Approval latency is bounded by candidate expiry (24h) and a 48h/7d
  source-aware staleness guard at posting time — late approvals are skipped,
  not posted.
