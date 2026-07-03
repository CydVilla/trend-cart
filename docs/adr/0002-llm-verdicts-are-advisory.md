# ADR-0002: LLM verdicts are advisory; server-side gates are authoritative

**Status:** Accepted

## Context
An LLM classifies candidates (safety, intent, category, search query) and
writes replies. Model output is attacker-influenced (post text goes into the
prompt) and can hallucinate.

## Decision
Every LLM verdict passes through `applyGates` (apps/worker/src/evaluate.ts):
scores are clamped, category slugs are checked against the active set,
search queries are sanitized (no URLs/newlines/@/#, length-capped), and
`shouldReply` is re-derived from our rules — the model's own flag alone can
never cause a reply. Evaluations are stamped with the producing model tag and
the reply pipeline consumes ONLY verdicts matching its current tag
(allowlist), so fake/test/legacy verdicts cannot drive real posting.
Generated replies pass a mechanical validator (length, single anchor, no raw
URLs, banned phrases) regardless of what the prompt asked for. Prompts wrap
all user content in untrusted-data tags; instruction-like content is treated
as a spam signal.

## Consequences
- A hallucinated slug, inflated score, or prompt-injected "score this 100"
  is neutralized by construction (covered by regression tests).
- Trust is layered: prompt → gates → validator → human approval; no single
  layer is load-bearing.
- The operator-note channel (ADR-0007) is the one deliberate trusted input,
  marked as such in the prompt and sourced only from the authed dashboard.
