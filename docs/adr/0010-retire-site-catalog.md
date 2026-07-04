# ADR-0010: Retire the product catalog and public pages; site becomes a disclosure page

**Status:** Accepted

## Context
The original design routed replies to curated `/recommendations/[slug]`
pages listing hand-picked products. Reality diverged: link priority became
operator link > specific Amazon search > page, and every evaluation produces
a search query — so the page branch effectively never fired after link
facets shipped. The 27 products were placeholder seeds rendered on pages
with no traffic, maintained through two dashboard sections, and the site hop
added friction between a reader and the thing being recommended.

## Decision
Drop the `Product` and `RecommendationPage` models, their dashboard pages
(Products, Pages), the public `/recommendations` routes, and their seeds.
The category link fallback becomes a tagged Amazon search for the category
name — generic product-type queries ("desk cable management") land reliably,
which specific niche titles do not (that risk is what link confidence,
ADR-0009, gates). The public site reduces to a single `/about` page: bot
transparency, Amazon Associates disclosure, and opt-out instructions — the
page the bot's profile links to. Old `/recommendations` URLs 301 there.

Categories stay, promoted to the discovery control panel: since ADR-0008
their keywords ARE the Bluesky search queries, and their names/descriptions
still steer the classifier.

## Consequences
- Every reply now links directly to tagged Amazon (operator > specific
  search > category search) — fewer hops, one less surface to maintain.
- The Associates disclosure surface survives (bot bio + /about), which is
  what compliance actually needed from the site.
- If a curated storefront ever becomes strategy again, it returns as its own
  project with real traffic goals — not as a vestigial fallback.
