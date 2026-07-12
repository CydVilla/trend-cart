# ADR-0015: Timeliness over thresholds — measure gates, spend on the fresh

**Status:** Accepted

## Context
The funnel was losing candidates to expiry (51 of the first 70 skips), and
the daily insights kept proposing threshold tightening. A measured pass —
replaying the operator's own labels through the gates at a grid of thresholds
(`scripts/threshold-sweep.ts`, built on an `applyGates` override param) —
showed agreement FLAT at 82% across intent 40–75 and link-confidence 40–80:
the numeric gates decide almost nothing; the model's own `shouldReply` does.
Meanwhile the expiries decomposed into timeliness failures: posts discovered
already >18h old, posts evaluated with <2h of reply runway, and fresh
candidates dying in a FIFO reply queue behind nearly-expired ones.

## Decision
**Leave the thresholds alone; make every stage respect the clock.**
- Discovery never ingests posts older than `MAX_CANDIDATE_AGE_HOURS` (16) —
  an eval on a too-old post is money spent on a guaranteed expiry, and a
  reply that late lands on a dead thread.
- Evaluation skips candidates with under ~2h of reply runway (>22h old).
- The trending reply queue drains **freshest-post-first** (was
  oldest-evaluation-first), with a per-tick sweeper writing terminal expired
  rows for candidates that age out — under backlog the stalest expire
  unposted *by design*.
- Cheap DOOM gates run before any LLM spend: opted-out authors, and authors
  whose 48h cooldown mathematically outlasts the post's 24h reply window.
- Calibration label hygiene: operator-directive posts (`operatorLinkUrl`)
  are not labels — they bypass the classifier in production.

## Consequences
- Post-fix, expiry of newly ingested candidates ~stopped (77 of 78 all-time
  expiry skips predate the change); the bot posts at its daily cap, and any
  remaining expiry is capacity triage choosing the freshest.
- Replies land while threads are alive — the lever for reply engagement.
- Threshold changes now require sweep evidence, not vibes; the weekly
  calibration measures the brain against a cleaner golden set (86→89%).
- A trade accepted: high-engagement-but-stale posts are deliberately dropped.
