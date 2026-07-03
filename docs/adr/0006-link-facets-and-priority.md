# ADR-0006: Links as rich-text facets; operator > search > page priority

**Status:** Accepted

## Context
Early replies ended with a raw ~100-character URL (ugly, ate the character
budget) pointing at a generic category page even when the post was about one
specific product. LLMs also cannot count characters, making URL-in-text
budgets fragile.

## Decision
The model generates TEXT ONLY against a word budget. Code composes the final
reply as `text + anchor + disclosure` and stores `linkUrl`/`linkAnchor` on
the BotReply; the poster attaches the URL to the anchor's byte range as an
`app.bsky.richtext.facet#link` facet. Readers see "deltarune on Amazon" as
clickable text. Link choice priority: operator-provided link (human already
decided) → tagged Amazon search for the specific identified product → the
category's recommendation page. Legacy rows without linkUrl fall back to
URL auto-detection.

## Consequences
- Replies are shorter, cleaner, and the link destination is reviewed on the
  approval card before posting.
- The validator flips from "exactly one URL" to "exactly one anchor, zero
  raw URLs" — anchor-collision edge cases are its new failure surface.
- Amazon search links still attribute via the tag (session cookie covers
  whatever the visitor buys); direct product links convert better and arrive
  via the operator-link lane until PA-API access is earned (3 sales).
