# Changelog

Notable changes to TrendCart. Dates are deploy dates; the bot went live on
2026-07-03. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## 2026-07-08 — Link confidence judges purchasability, not just relevance

### Changed
- **The classifier separates "does this product exist" from "can a buyer buy
  it now."** Operator 👎 ratings kept flagging replies that linked to things
  nobody could purchase — a not-yet-released book pre-order, a sold-out /
  out-of-print Game Boy Color cartridge. Root cause: `linkConfidence` was
  defined purely as *result relevance* ("does the first page show this
  product or same-franchise items"), while rule 3b told the model that
  anything an author owns or is excited about "is real and purchasable." An
  out-of-print game's search still *looks* relevant (used listings, other
  franchise titles), so it scored high and got linked to something unbuyable.
  - **Rule 3b** keeps its real job — never skip a genuinely-released product
    just because training data thinks it isn't out yet — but no longer asserts
    purchasability. Unreleased/pre-order and out-of-print/discontinued items
    stay valid enthusiast candidates; the fix lives in the *link*, not a skip.
  - **`linkConfidence`** now scores relevance AND buyable-new-right-now. A
    page of used/collector listings for a sold-out item is a bad link even
    though it "matches"; unreleased and collector-only items land in the low
    (<50) bucket and fall back to a retargeted in-franchise query (a
    re-release, successor console, physical edition), a category link, or no
    link — never a dead search.
  - **Rule 4's** retarget trigger extends past digital-only/services to cover
    unreleased and out-of-print items, adding re-release/new-edition and the
    successor console to the buyable targets. The
    `CandidateEvaluationResult.linkConfidence` doc comment is updated to match.
- No schema, gate, or threshold change: `MIN_LINK_CONFIDENCE` (60) still does
  the enforcing — the model now feeds it a purchasability-aware score.

## 2026-07-08 — The bot can see: image + comment context

### Added
- **Vision + conversation context for classification and replies.** The
  classifier and reply generator were text-only — blind to a post's images and
  to the replies underneath it (the `operatorNote` field existed only to
  hand-describe images the bot couldn't see). Now:
  - **Images**: discovery captures each post's image thumbnails + author alt
    text from the Bluesky embed (previously discarded). Thumbnails are sent to
    Haiku as vision input so it can actually *see* a game screenshot, box art,
    or a physical edition — directly fixing the "virtual photography" /
    hashtag-only posts that calibration flagged as misses. Thumbnails (not
    full-size) keep vision ~$0.10/day at the eval cap.
  - **Comments**: the post's top replies (by likes) are pulled from the public
    AppView — free, no auth — and given to the classifier + reply as untrusted
    conversation context ("is this on Switch?", "the physical edition rules").
  - Both are gated (`VISION_ENABLED`, `COMMENTS_ENABLED`, default on) and
    cost-capped (`VISION_MAX_IMAGES=2`, `COMMENTS_MAX=5`). Untrusted image alt
    text and comments ride the same sanitizer/`untrusted_*` tags as post text,
    so neither can inject instructions.
  - Calibration replays stored images through the vision-capable brain for
    fidelity; the reply reuses the same context so it can reference what was
    actually shared.

## 2026-07-08 — Calibration: honest labels + about-vs-incidental

### Changed
- **Calibration triage over chasing 100%** (issue #2). Two structural fixes,
  then the residue is left to the learning loop:
  - **Stale-draft labels excluded**: a dashboard rejection rejects a reply
    *draft*, not the post. When the draft predates the current format (a raw
    URL — replies now ride a facet — or a link to the retired
    `/recommendations/` pages), it judged a draft the bot can no longer
    produce. `calibrate.ts` drops those so the metric measures post selection.
  - **Classifier — about vs. incidental**: a hashtag / "virtual photography"
    screenshot naming a specific game *is* an identifiable-product candidate
    (fixes the RE Requiem miss); but a product merely incidental to a personal
    joke, anecdote, or mishap is not an opening — a recommendation there
    hijacks a personal moment (matches operator 👎 ratings).
- The remaining disagreements (hard link-confidence calls like whether an
  itch.io indie game is on Amazon; evolving taste) are owned by the
  rating → reflection → lessons loop, not more prompt hand-tuning.

## 2026-07-07 — RSS deal suggestions: the no-PA-API bridge

### Added
- **RSS deal suggestions** (ADR-0013): the worker polls deal-site RSS feeds
  (Deals page → "Deal RSS sources"; Slickdeals frontpage seeded in two lanes:
  **tech & electronics** and **pop-culture apparel** — clothing only when tied
  to a TV/movie/game/fandom franchise) and extracts Amazon items, including
  links hidden inside deal-site redirect params. The source's affiliate tag
  never survives: product URLs are rebuilt canonically from the ASIN.
  - **Two-stage lane gate**: keyword include/exclude prefilter, then one
    deterministic LLM judgment per headline against the source's plain-words
    lane criteria (verdict stored for audit; keyword-only mode without an API
    key; per-tick LLM budget).
  - **Prices stay human-attested**: the parsed price is shown as a hint only
    ("seen at ~$39.99"); the operator checks the live Amazon page, confirms
    the price (+ optional reg. price for the % off), and the post queues
    through the manual path — so nothing PA-API can't verify is ever
    advertised unattested, and the freshness ceiling holds. Dismiss ends a
    suggestion; unactioned ones auto-expire after 48h; per-ASIN dedup,
    cooldown, and the ban switch all apply.
  - Works with **zero Amazon API keys** — this is the bridge to the 3
    qualifying sales that unlock PA-API automation.

## 2026-07-07 — Deal feeds: Wario64-style sale discovery

### Added
- **Deal feeds** (ADR-0012): saved Amazon searches (keywords, category, min
  % off, price band, review floors, sold-by-Amazon toggle) the worker polls
  via PA-API SearchItems for products **currently on sale** — real
  strikethrough discounts only, every gate re-verified server-side. Managed
  in a new Deals-page section; three starter feeds seeded.
  - Discovered deals queue as `PENDING_APPROVAL` with the exact post text and
    approve/reject buttons, and **auto-expire** when the price snapshot passes
    the freshness ceiling — the queue only ever shows actionable deals.
    `DEAL_FEED_AUTOPOST=true` skips approval entirely.
  - Per-ASIN dedup: discovered items become `origin=DISCOVERED` listings
    (never price-polled) carrying the 7-day cooldown + identical-price dedup;
    a new "Discovered by feeds" table can pause (ban) or delete any of them.
  - Discovered posts spend their own daily budget
    (`DEAL_FEED_MAX_POSTS_PER_DAY`, default 2) inside the global cap, so a hot
    feed can't starve watchlist alerts, and are throttled by the global
    gap/day caps at the poster like automated fires.
- **Wario64-style post copy is the new default** for all deal posts
  (`DEAL_POST_STYLE=wario`; `classic` restores the old format):
  `"Title is $39.99 on Amazon (33% off, reg. $59.99) #ad"` + the compliance
  line on its own line — the price phrase itself is the clickable affiliate
  link (per-post `DealPost.linkAnchor`). Amazon's keyword-stuffed titles are
  shortened deterministically (cut at the first strong separator outside
  parentheses, so "(Switch)"-style platform markers survive).
- `.env.example` documents a raise-the-caps recipe for a real deal-feed
  cadence (autopost + 12 posts/day + 20-min gap) once the operator trusts it.

## 2026-07-04 (later) — Deal tracker + reply length fix

### Added
- **Deal tracker** (ADR-0011): a manual watchlist of Amazon listings, each
  with a full (normal) price and an optional stricter alert price. When a
  tracked item drops below its full price (or at/below the alert price) the
  bot posts a standalone deal alert to its own profile — the % off the full
  price, affiliate link on a clickable anchor, an in-post `#ad` disclosure, and
  an "as of <time>; price subject to change" qualifier. One sale = one post
  (re-arm hysteresis).
  - **Two paths**: automated polling via Amazon PA-API 5.0 (`DEALS_ENABLED` +
    `PA_API_*` keys), and a manual "Post deal now" dashboard fallback that
    needs no API keys. New **Deals** dashboard page manages the watchlist,
    target prices, and manual posting.
  - Ships dark behind `DEALS_ENABLED`; DRY_RUN still gates all posting.
    PA-API requests are SigV4-signed with Node crypto (verified against AWS's
    published test vector). Tight caps: 3 posts/day, 7-day per-listing
    cooldown, 60-min global gap, 1-hour price-freshness ceiling.

### Fixed
- Over-long replies (the model overshooting its word budget, e.g. `309 > 240`)
  are now truncated at a word boundary and still posted with the link anchor
  intact, instead of being discarded as a validation failure.
- Manual "Post deal now" posts bypass the global cooldown and daily cap — those
  throttle the automated price-trigger, not the operator deliberately posting.

## 2026-07-07 — Release resilient to transient DB blips

### Fixed
- The release-phase migration (`prisma migrate deploy`) now retries up to 5×
  (15s apart) on a connection failure instead of failing the whole deploy —
  a brief Heroku Postgres network blip killed v47/v48. `migrate deploy` is
  idempotent, so retrying is safe.

## 2026-07-07 — Bluesky outage resilience

### Fixed
- A Bluesky outage (504 gateway timeout, network error, 5xx, rate limit) no
  longer wastes resources or breaks the bot. A shared reachability gate
  (`bluesky-health.ts`) backs off exponentially (1m → 15m cap) and the loops
  themselves probe on recovery; every Bluesky-touching loop (discover, reply
  poster, deal poster, notifications) skips cheaply while it's down.
- **Transient outages no longer permanently disable posting.** The posters'
  3-strikes login-disable now fires only on genuine auth failures (bad
  password) — a 504 spate backs off and retries instead of stopping until a
  dyno restart.
- Discovery stops grinding all ~116 search queries when Bluesky is down — it
  bails on the first transient failure and lets the backoff window pass.
- The worker stats line shows `BLUESKY DOWN (retry Ns)` and the dashboard
  worker card shows `waiting: Bluesky unreachable` during an outage.

## 2026-07-06 — Manual candidates get true end-to-end priority

### Changed
- Candidates you provide (inject form) and mentions now jump every stage,
  not just batch ordering: they **bypass the hourly eval budget** (their
  volume is operator-bounded), **jump the reply-generation queue** ahead of
  the trending backlog, **post first** in the poster queue, and MANUAL
  injections are now exempt from the author/category cooldowns (like
  mentions — a human chose the post). Global reply caps still apply.

## 2026-07-06 — Weekly calibration workflow + CI

### Added
- **Weekly calibration** (GitHub Actions, Mondays + manual trigger): replays
  operator-labeled posts — 👍/👎 ratings, dashboard rejections, manual-era
  approvals — through the CURRENT classifier brain (prompt + lessons +
  guidance + gates) and files the drift report as a GitHub issue: agreement
  %, would-reply-but-you-said-no, would-skip-but-you-approved. The learning
  loop mutates prompts daily; this is the regression check against known
  judgment (~$0.15/run). Result also lands in `BotMemory("calibration")`.
- **CI** on push/PR: typecheck, lint, web build.

## 2026-07-06 — Candidates sort + pagination

### Added
- **Candidates page**: sort chips (Engagement / Newest / Intent score /
  Recently found) and pagination (50 per page, prev/next with totals) — the
  full 800+ candidate pool is now browsable instead of only the top 50.
- **Replies page**: Recent activity is paginated (30 per page), so the
  posted-reply history stays reachable as autonomous volume grows.

## 2026-07-06 — Rate posted replies (operator feedback loop)

### Added
- **👍/👎 on posted replies** (Replies page, "Your verdict" column) with an
  optional written note — the operator's feedback channel for replies the bot
  posted autonomously. Clicking the same thumb again clears it.
- Ratings + notes feed **both learning loops**: the nightly reflection treats
  them as the heaviest-weighted evidence when revising the bot's lessons, and
  the daily insights report gets the verdict counts plus the actual notes —
  a rising down-rate now drives "tighten thresholds/discovery"
  recommendations even when volume looks good. Verdict tallies also show on
  the Insights page.

## 2026-07-05 (later) — Broader discovery, eased caps (still low-cost)

### Changed
- **Discovery broadened a lot**: every category's keywords reworked into
  enthusiast-style Bluesky search queries (what actually converts), six new
  categories added (books, anime & figures, board games/TTRPG, retro gaming,
  LEGO, headphones/audio), kitchen pivoted to gear, desk-cable to desk
  setups. 15 active categories × 8 polled queries ≈ 116 free searches per
  15-min cycle (was 54).
- **Caps eased**: evals 15→30/hr (the real cost lever — hard ceiling ≈
  $2/day on Haiku, realistically well under $1), category cooldown 120→45m,
  author cooldown 72→48h, replies 5→6/hr and 20→30/day.
- **Low-signal gate softened**: statement posts (no question) now need 2×
  the engagement floor instead of 3× — enthusiast posts are usually
  statements, and they're the bot's best candidates. New
  `LOW_SIGNAL_MULTIPLIER` env (default 2).
- The engagement floor (10), Haiku model, per-author eval cap, and all
  safety gates are unchanged — quality and cost ceilings stay.

## 2026-07-05 — Insights report (funnel analytics)

### Added
- **Insights** dashboard page + a daily worker report. Computes the pipeline
  funnel (discovered → cleared the engagement floor → evaluated → judged
  worth-replying → posted), the per-category output, skip reasons, and
  posted-reply engagement — so it's clear where candidates are lost. A daily
  LLM pass turns the numbers into a plain-English summary plus 3–6 concrete,
  ranked recommendations (which categories to cut, which thresholds to
  change) stored in `BotMemory("insights")` and shown at the top of the page.
  Shared `computeFunnel()` lives in `@trendcart/db` so the live dashboard and
  the report read identical numbers.

## 2026-07-05 — Button loading states

### Changed
- Every dashboard action button now shows an inline spinner and disables
  itself while its server action runs (approve/reject/edit/regenerate a
  reply, save guidance/lessons, track/post/save/delete a deal, run/skip a
  candidate, save a category, and the worker toggles) — so slow actions like
  "Regenerate" (an LLM call) give clear in-progress feedback and can't be
  double-clicked.

## 2026-07-05 — Editable learnings, clearer guidance save

### Changed
- The **operator guidance** card is now always-visible with a "✓ saved
  <time>" confirmation (it used to collapse itself on save, so there was no
  feedback that it worked).
- **The bot's learned lessons are now directly editable** on the Overview
  page — edit or delete any line you disagree with. Auto-learning keeps
  running: the daily reflection now *revises* the lessons instead of
  rewriting them from scratch — it preserves your edits, won't re-add
  anything you removed, and only appends genuinely new lessons. The operator
  guidance still outranks the lessons everywhere.

## 2026-07-04 (later) — Operator guidance override

### Added
- **Operator guidance**: a dashboard-editable, free-text standing instruction
  the bot treats as AUTHORITATIVE in every evaluation and reply — it overrides
  the bot's own judgment and anything it learned (only the hard safety/spam
  rules outrank it). This is the operator's direct "here's what to do" channel;
  applied within ~2 minutes, no redeploy. The daily reflection is also given
  the guidance as a constraint, so it can never re-learn a lesson that
  contradicts it.

### Changed
- The classifier now treats abstract commentary/analysis that clearly alludes
  to a specific product as a valid enthusiast candidate (what disqualifies a
  post is having no identifiable product, not being abstract) — correcting an
  over-generalized learned lesson.

## 2026-07-04 (later) — Autonomous mode, learning loop, link confidence

### Added
- **Autonomous mode** (ADR-0009): a dashboard toggle that lets the bot
  approve and post its own replies — but only the confident ones (intent
  ≥ 80 AND link confidence ≥ 75, or an operator directive); weaker replies
  still escalate to the manual queue. Off by default, picked up by the
  worker within 30s, always overridden by `DRY_RUN`.
- **Self-learning**: an hourly job measures likes/replies on the bot's own
  posted replies (free public API); a daily job (~1 small LLM call) distills
  your approvals, rejections, hand-edits (before→after pairs), skips, and
  reply engagement into ≤10 guidelines injected into the classifier and
  reply prompts. Visible on the Overview page ("What the bot has learned").
- **Link confidence** (0–100) on every evaluation: the model's confidence
  that the Amazon results for its query show the product or same-franchise
  items. Queries below 60 are never linked (category fallback or skip);
  prompts now retarget un-buyable things (digital-only games, services) to
  what Amazon actually sells (physical editions, merch, soundtracks).

### Removed (ADR-0010)
- The curated product catalog and public recommendation pages (models,
  dashboard sections, routes, seeds): the site-page link branch effectively
  never fired once link facets shipped — replies link straight to tagged
  Amazon searches. Category fallback is now a tagged Amazon search for the
  category name. The public site is a single `/about` disclosure page;
  old `/recommendations` URLs redirect there.

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
