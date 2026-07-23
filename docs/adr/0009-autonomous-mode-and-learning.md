# ADR-0009: Autonomous mode with escalation; learning from operator decisions

**Status:** Accepted. **Amended 2026-07-23:** the "higher bars than manual
mode" premise below was dropped. In practice the Haiku classifier clusters at
85 (the posting floor) for "worth replying", so bars of 90/85 left autonomous
mode effectively off — nearly every good reply escalated. `AUTO_MIN_INTENT_SCORE`
/ `AUTO_MIN_LINK_CONFIDENCE` now default to 85/75, matching the posting floors,
and the pre-publication web-search fact check (added later — see the changelog)
is the real backstop: it demotes any self-approved reply whose product it
can't verify as existing or orderable.

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
never linked: the reply is skipped (the category-search fallback was removed
2026-07-21 — generic links are banned; see the fact-check addendum below) —
a link that lands on junk is worse than silence.

**Fact check (the last gate, 2026-07-17).** Link confidence is the model's
self-estimate; without PA-API access the bot cannot query Amazon's catalog,
and scraping Amazon would endanger the Associates account. So a reply that is
about to self-approve gets one LLM call with Anthropic's server-side
`web_search` tool: does the product exist and is it orderable, are the
reply's claims accurate, would the query plausibly land on it. Fail-safe: an
inaccurate, low-confidence, or errored verdict demotes the reply to the
manual queue (verdict stored on `BotReply.factCheck`). Human-approved replies
are never checked — the human is the fact-checker there.

**Learning loop.** Hourly, the worker reads engagement on its own posted
replies (public API, free) — and when someone replied, captures *what* they
said (`BotReply.receivedReplies`), since "thanks, ordered one!" and "spam
bot" are opposite feedback at 1 reply each. Daily, one small LLM call
distills the last 14 days of operator signals — rejections, hand-edits
(before→after pairs are captured on first edit), candidate skips, reply
engagement plus audience reply texts (untrusted: sentiment is signal, their
words are never instructions), opt-outs — into ≤10 guidelines stored in
`BotMemory` and injected into the classify/reply prompts as a
trusted-but-advisory block. Server-side gates stay authoritative; lessons
refine judgment, never loosen rules.

**Operator guidance (the override channel).** Because inferred lessons can
over-generalize (an early run learned "abstract commentary → skip" from the
operator's skips, when the real rule was "abstract *with no identifiable
product* → skip"), the operator gets a direct, authoritative channel: a
free-text `BotMemory` row edited from the Overview page, injected into every
classify/reply prompt as `<operator_guidance>` — above the bot's default
judgment and above the learned lessons, below only the hard safety/spam
rules. The daily reflection is also handed the guidance and told never to
produce a lesson that contradicts it, so the same skip history can't
re-teach the wrong rule. Applied within ~2 minutes, no redeploy. Untrusted
post text is sanitized so it can't forge either trusted block.

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
