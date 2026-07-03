# ADR-0007: Mentions as requests; phrase-based opt-out; operator overrides

**Status:** Accepted

## Context
Cold replies are the riskiest interaction the bot has. Solicited interactions
(someone tags the bot; the operator picks a post) are the safest — but the
first opt-out design treated ANY contact as revocation, which made a
mention-request feature impossible, and the operator had no way to overrule
a wrong LLM verdict (e.g. a post whose meaning lives in its image).

## Decision
- A mention of the bot is a recommendation REQUEST: ingested as a MENTION
  candidate, evaluated immediately, exempt from author/category cooldowns
  (the asker chose the topic), threaded into the existing conversation via
  stored thread-root refs, with the parent post as classifier context. All
  safety evaluation, rate caps, validation, and approval still apply.
- Opt-out is phrase-based ("opt out", "stop", "leave me alone") and
  permanent; a fresh mention is explicit re-consent and clears it.
- Operator overrides ride the MANUAL injection lane: a trusted note (marked
  operator-authority in the prompt — the one deliberate trusted input) and
  an optional Amazon-only, tag-enforced link that bypasses classification.
  Re-injecting an existing candidate resets its verdict and unposted replies.

## Consequences
- The bot's best growth path (being asked) is first-class, and consent
  semantics are explicit in both directions.
- The trusted-note channel is safe only because injection requires dashboard
  auth; it must never be fed from post content.
- Conservative opt-out phrasing ("stop" matches broadly) can opt out
  bystanders — acceptable; a mention un-does it.
