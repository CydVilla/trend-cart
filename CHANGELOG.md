# Changelog

Notable changes to TrendCart. Dates are deploy dates; the bot went live on
2026-07-03. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## 2026-07-04 — Discovery v2: search replaces the firehose

### Changed
- **Discovery is now Bluesky search** (ADR-0008): every 15 minutes the worker
  polls each category keyword as a query (`sort=top`, last 24h) and saves
  results that clear the cheap gates AND the engagement floor at discovery —
  candidates arrive already trending, already hydrated. Category keywords are
  now literally the search queries (dashboard-editable).

### Removed (feature audit)
- The Jetstream firehose pipeline (`jetstream.ts`, `ingest.ts`,
  CategoryMatcher): live data showed 89% of its captures (521 of 585) never
  reached the engagement floor. ~5M events/day of processing replaced by ~50
  search queries per cycle.
- `engagementVelocity`: computed and stored since Phase 3, consulted by
  nothing. Column dropped; candidates table shows likes/reposts instead.
- `JETSTREAM_URL` config; the maturation wait no longer applies to
  search-discovered posts (they arrive with real counts).

## 2026-07-03 (later) — Operator controls, funnel efficiency, review fixes

### Added
- **Edit & refine pending replies**: approval cards gained a textarea to edit
  the reply text directly (anchor preserved) and a direction box that has the
  LLM regenerate the text per the operator's instruction.
- **Low-signal gate**: firehose statements with no intent markers (no
  question, no "recs?"/"looking for"/…) need 3× the engagement floor to be
  evaluated — obvious non-candidates never reach the LLM.

### Changed
- Operator notes are now **authoritative**: a note means the operator chose
  the post — the LLM's job reduces to safety + category/query selection, and
  the note's framing is carried into the reply (near-verbatim when it reads
  like copy, e.g. "Celebrate the 75th anniversary…").
- Removed the per-reply "(affiliate link)" suffix — disclosure lives in the
  account bio and the anchor text names Amazon explicitly (operator decision).
- Solicited candidates (mentions, injections) evaluate ahead of firehose
  posts instead of competing on engagement score.
- Mobile-friendly dashboard header (scrollable nav row on small screens).

### Fixed (post-live adversarial review — 9 distinct confirmed findings)
- Consent ordering: a mention now clears only opt-outs recorded BEFORE it,
  and only when genuinely new — a stale/replayed mention can no longer erase
  a newer "stop". Notifications are processed oldest-first with pagination
  (bursts > 50 no longer drop opt-outs).
- Opt-out phrases must be directed ("stop replying", "opt out"); bare "stop"
  counts only as a short direct reply to the bot — "can't stop playing" no
  longer opts anyone out.
- Amazon host validation is a strict allowlist (`amazon.evil.com` no longer
  passes anywhere, including the shared tag helper); operator links are
  dropped rather than posted untagged when the tag env is missing.
- The inject-form override reset can no longer delete an in-flight POSTING
  row (double-post window closed).
- Mention thread roots are derived from the parent post's own record, not
  the mention author's claim (reply-steering closed).
- Reserved prompt tags are neutralized inside untrusted text (a post can't
  forge a trusted `<operator_note>`); URL-only model output can no longer
  produce an anchor-only reply; operator-directive verdicts survive model
  switches.

## 2026-07-03 — Link facets, operator overrides, mention requests, go-live

### Added
- **Mention requests**: tagging @trend-cart.bsky.social (in a post or under
  someone else's) creates a solicited candidate — evaluated immediately,
  exempt from author/category cooldowns, threaded into the conversation via
  stored thread-root refs, with the parent post as classifier context.
- **Operator overrides** on the dashboard inject form: a trusted note steers
  the classifier (e.g. what a post's image shows — image alt text is also
  captured), and an optional Amazon link (normalized, tag enforced) bypasses
  classification and forces the reply to use it. Re-pasting an existing
  candidate's URL resets its verdict and unposted replies.
- **Worker heartbeat** row with dashboard status card, Pause-bot kill switch,
  and a public `/api/health` endpoint for uptime pingers.
- **Permanent opt-outs** (`AuthorOptOut`): phrase-based ("opt out", "stop",
  "leave me alone") via a notifications listener; a fresh mention clears a
  prior opt-out (explicit re-consent).
- Dashboard "Test a post" injection form; approval cards render the clickable
  anchor and its exact link destination.

### Changed
- **Replies carry links as rich-text facets**: readers see anchor text
  ("deltarune on Amazon"), never raw URLs; direct Amazon links carry an
  "(affiliate link)" disclosure suffix. Link priority: operator link →
  tagged Amazon search for the specific product → category page.
- **Trending floor**: firehose posts must reach `MIN_ENGAGEMENT_SCORE`
  (default 10) after a 30-minute maturation before evaluation — recent AND
  liked, or zero LLM spend. Authors with promotional bios are rejected pre-LLM.
- **Disclosed-bot posture**: bot bio declares automation + affiliate links +
  opt-out; the validator allows disclosure vocabulary (previously banned).
- Classification model switched to `claude-haiku-4-5` (≈10× cheaper);
  `effort` param sent only to models that support it. Eval cap 15/hour.
- Affiliate tag corrected to `villa03b-20`; bot handle renamed to
  @trend-cart.bsky.social.
- Limits loosened per owner: intent ≥ 60, 5 replies/hour, author cooldown
  72h, category cooldown 60m, global gap 5m.

### Fixed (pre-live adversarial review, 6 confirmed findings)
- Reply pipeline consumes only verdicts stamped with the exact current model
  tag (legacy/fake verdicts can never drive posting).
- Policy/expiry runs before link selection — permanently-deferring candidates
  can no longer wedge the oldest-first reply queue.
- `USE_FAKE_LLM=true` force-enables `DRY_RUN` (fake verdicts can't go live).
- Firehose deletions soft-kill posts (`deadAt`) instead of cascading away
  POSTED rows that rate limits/cooldowns/dedupe derive from.
- Reply generation backs off on transient API errors instead of permanently
  failing candidates; poster staleness window is source-aware.
- Poster claims rows (`APPROVED → POSTING`) before any network call —
  exactly-once posting under crashes and overlapping ticks.

## 2026-07-02 — Hardening, dashboard, public pages, Heroku deploy

### Added
- **Phases 4–7**: LLM candidate evaluation (structured outputs, server-side
  gates), reply generation + validation + Bluesky posting loop, the operator
  dashboard (candidates / approval queue / categories / products / pages),
  and public `/recommendations/[slug]` pages with affiliate disclosure.
- **Heroku deployment**: web + worker dynos, Heroku Postgres, release-phase
  migrations, HTTP Basic auth middleware for the dashboard.
- Dynamic recommendations: enthusiast posts about a specific product get a
  tagged Amazon search link when no curated page fits; video-games category.
- Full seed data: 9 categories, 9 published pages, 27 placeholder products.

### Fixed
- Ingestion race on duplicate Jetstream deliveries (atomic createMany).
- Promotional-post filter (deal-bot ads were the only organic "matches").
- LLMs can't count characters: reply text is generated against a word budget
  and links are appended deterministically.
- Prisma-on-Heroku deployment traps: pnpm `deploy` builtin collision,
  `next.config.ts` needing TypeScript at runtime, per-peer-set duplicate
  Prisma client instances, boot-time client regeneration.

## 2026-07-01 — Foundation

### Added
- pnpm monorepo (apps/web, apps/worker, packages/db, packages/shared) with
  Prisma schema for posts, categories, products, pages, replies, evaluations.
- Jetstream firehose ingestion with keyword matching, cheap safety/promo
  filters, and engagement rehydration via the public AppView.
- Affiliate URL utilities ported from the amazon-search app (tag from env,
  never hardcoded).
