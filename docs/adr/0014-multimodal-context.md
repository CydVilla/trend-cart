# ADR-0014: The classifier sees what it judges — images, comments, purchasability

**Status:** Accepted

## Context
The evaluation brain was text-only. A post's images (and the author's alt
text) were discarded at ingest, and the replies underneath a post were never
fetched — so a "virtual photography" screenshot naming a game only via
hashtag was skipped as low-signal, and `operatorNote` existed largely to
hand-describe images the bot couldn't see. Separately, `linkConfidence`
scored only result *relevance*, so a sold-out Game Boy cartridge or an
unreleased ARC looked linkable ("results match!") while being unbuyable —
the operator's 👎 pattern.

## Decision
**Images.** Discovery captures each post's embed thumbnails + alt text
(previously thrown away; stored as index-aligned `Post.imageUrls`/`imageAlts`)
and sends the thumbnails to the classifier as vision input. Thumbnails, not
full-size: vision tokens scale with pixels, so cost stays ~$0.10–0.15/day at
the eval cap. Alt text is free signal and rides the same `untrusted_*`
sanitizer as post text. Gated by `VISION_ENABLED` / `VISION_MAX_IMAGES`.

**Comments.** The post's top replies (by likes) come from the public AppView
(free, no auth) as untrusted conversation context for both classification and
reply generation. Gated by `COMMENTS_ENABLED` / `COMMENTS_MAX`.

**Purchasability.** Existence and orderability are separate questions:
rule 3b keeps "the post is ground truth for existence," but `linkConfidence`
now also requires that a buyer can *order it right now* — a live pre-order
page counts; no-listing-yet and out-of-print/collector-only score low and
retarget (re-release, successor console, physical edition) or don't link.
When a specific product fails the gate and the reply falls back to a category
link, the generator is told explicitly and must not imply the link leads to
the named item.

## Consequences
- The hashtag/screenshot misses calibration flagged are fixed; replies can
  reference what was actually shared.
- The 👎 "linked something unbuyable" class is closed at both ends (score +
  honest fallback copy).
- Calibration replays stored images so the weekly check exercises the same
  brain that runs live.
- Slight per-eval cost increase (vision tokens), bounded by thumbnails + the
  image cap; comments are free.
