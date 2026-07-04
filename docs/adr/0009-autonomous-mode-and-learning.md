# ADR-0009: Autonomous mode with escalation; learning from operator decisions

**Status:** Accepted

## Context
Every reply requires manual dashboard approval. That is the right launch
posture, but the operator wants a switch — enabled at a time of their
choosing — where the bot approves and posts on its own, run as cheaply as
possible. Blind auto-posting (the pre-existing `REPLY_MODE=auto`) treats a
barely-passing verdict the same as a slam-dunk, and the bot had no mechanism
to get better from the hundreds of judgments the operator was already making.

## Decision
**Autonomy with escalation.** A dashboard toggle (`WorkerHeartbeat.autonomous`,
operator-owned like `paused`, picked up within 30s, no redeploy) makes the
bot self-approve only replies clearing HIGHER bars than manual mode requires:
product intent ≥ `AUTO_MIN_INTENT_SCORE` (80 vs the normal 60/70) AND, for
search links, link confidence ≥ `AUTO_MIN_LINK_CONFIDENCE` (75). Operator
directives (injected links) are auto-approved — a human already decided.
Everything weaker still lands in the manual queue. `DRY_RUN` remains the
master override, and every downstream guardrail (validator, cooldowns, caps,
opt-outs, exactly-once poster) applies unchanged.

**Link confidence.** The classifier now reports how confident it is that the
first page of Amazon results for its query shows the product or
same-franchise items, and is instructed to retarget un-buyable things
(digital-only games, services) to what Amazon actually sells (physical
editions, merch, soundtracks). Queries under `MIN_LINK_CONFIDENCE` (60) are
never linked: the reply falls back to a category search or is skipped —
a link that lands on junk is worse than silence.

**Learning loop.** Hourly, the worker reads engagement on its own posted
replies (public API, free). Daily, one small LLM call distills the last 14
days of operator signals — rejections, hand-edits (before→after pairs are
captured on first edit), candidate skips, reply engagement, opt-outs — into
≤10 guidelines stored in `BotMemory` and injected into the classify/reply
prompts as a trusted-but-advisory block. Server-side gates stay
authoritative; lessons refine judgment, never loosen rules.

## Consequences
- The operator can turn autonomy on knowing the bot only acts alone on its
  most confident calls and escalates the rest — and can watch what it has
  learned on the Overview page before flipping the switch.
- Marginal cost: ~1 LLM call/day for reflection; outcome polling is free.
- Lessons are model-written text injected into prompts: they are wrapped as
  advisory, derived only from operator-controlled/observed data, and the
  reflection prompt treats reply/post texts as untrusted examples.
- `REPLY_MODE=auto` survives as the blunt env-level instrument; the toggle
  is the recommended path.
