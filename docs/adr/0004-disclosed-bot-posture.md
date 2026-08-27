# ADR-0004: Disclosed bot with in-reply affiliate disclosure

**Status:** Accepted (reversed the original design). **Amended 2026-07-03:**
the per-reply "(affiliate link)" suffix was removed by operator decision —
disclosure now lives at the account level (bio) and in the anchor text
naming Amazon. Trade-off acknowledged: in-feed readers don't see bios, so
this leans on the FTC's tolerance for platform-level disclosure.

## Context
The original prompts instructed the model to sound human and banned
AI-disclosure vocabulary, while every reply carried an affiliate-destined
link from a zero-history account — the canonical spam fingerprint, and an
FTC Endorsement Guides problem (undisclosed material connection).

## Decision
Invert: the account's display name and bio declare it is an automated bot
funded by affiliate links, with opt-out instructions. Direct Amazon links in
replies carry an "(affiliate link)" suffix appended deterministically in
code. The validator ALLOWS disclosure vocabulary and continues to ban hype,
urgency, and claim-making. Recommendation pages keep the Associates
disclosure statement.

## Consequences
- Compliance (FTC + Amazon Associates) and moderation resilience improve;
  the bot's survival no longer depends on not being noticed.
- A few characters of every Amazon-linked reply are spent on disclosure.
- Honesty is also the growth posture: mention requests (ADR-0007) only work
  if people know the bot exists and what it does.

## Addendum (2026-07-17): apologize, never argue

> **Superseded 2026-08-27.** The apology mechanism was removed at the
> operator's request — it did not earn its place. The bot now simply does not
> respond to hostility; a reply that is negative toward it is ignored past the
> opt-out check, which was always the fallback the addendum described.
>
> For the record: it ran from 2026-07-17 to 2026-08-27 and posted **four**
> apologies (2026-07-24, 07-27, and two on 08-21), at a total LLM cost of
> about $0.01. The `ApologyReply` table was dropped; its rows were archived
> outside this repository, since they contain third-party handles and message
> text and this repository is public.
>
> The reasoning below is retained as the record of why it once existed.

A disclosed bot also owns its misses. When a reply to the bot is negative
toward it, the bot apologizes ONCE with a fixed template chosen in code —
the LLM only gates whether an apology is due, so a stranger's words can
never shape what gets posted and the bot cannot be baited into arguing.
Opt-outs get no apology (they asked for silence; silence is the polite
response), and hard caps (one per post ever, one per author per week,
3/day) keep politeness from becoming its own spam vector. Politeness is
unconditional; the learning loop separately internalizes only feedback
that is constructive.
