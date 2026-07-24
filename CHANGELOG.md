# Changelog

Notable changes to TrendCart. Dates are deploy dates; the bot went live on
2026-07-03. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## 2026-07-24 (later) — Movies & TV as a weighted deal lane

### Added
- **`movies-tv` high-conversion lane** (operator request: weight movies + video
  games well without diminishing other deals). Physical movies/TV — Blu-ray, 4K
  UHD, steelbooks, DVD, box sets, Criterion — now classify into a first-class
  lane at editorial priority **84** (high tier, under the top game lanes so
  games stay first). New keyword rules (`heuristicLane`) put a disc keyword
  ahead of a fandom keyword, so a Marvel Blu-ray is a movie, not a collectible.
  A new **"Movies & TV (Slickdeals)"** source (frontpage + the fresh Amazon
  feed) discovers them — previously movie deals matched no source keyword and
  were dropped as off-lane.
- **Nothing else is diminished.** Video games were already the top-weighted
  lanes (recent-games 90, nintendo 88, controllers 86…); movies slot in at 84.
  And lane priority is only 15% of the candidate score — the other 75% is
  genuine quality (purchase intent 30%, Amazon-match 25%, topic fit 20%) — so
  the lane weight is a gentle nudge, and the existing same-lane diversity
  penalty still guarantees other lanes get slots. Requires a prod re-seed to
  create the new sources.

## 2026-07-24 (later) — Dead-code sweep (issue #15 triage)

### Removed
- **`ws` + `@types/ws`** from `@trendcart/worker` — the Jetstream firehose that
  used websockets was removed in ADR-0008; no source imports `ws`. Real dead
  weight, gone.
- **`armStateTone`** (dashboard `ui.tsx`) and **`InsightsReport`** (worker
  `insights.ts`) — an exported function and an exported type, both referenced
  nowhere.
- Deliberately KEPT (not dead / future placeholders per the operator): the
  PA-API signing + transient code (dark until credentials unlock the deal
  automation), `threshold-sweep.ts` (a manual analysis CLI), and `apps/web`'s
  `@prisma/client`/`prisma` (Knip false positives — used by `next.config.mjs`
  `serverExternalPackages` and the runtime client). The remaining ~30 Knip
  "unused exports/types" are live code that's merely over-exported (used within
  their own module) — not dead; left as-is rather than churn keywords.

## 2026-07-24 — Deal channel unblocked: over-strict sale gate loosened

### Fixed
- **Zero deal posts since 07-20 — the 07-21 "sale-verified" gate blocked
  everything.** Diagnosis: the pipeline was healthy end-to-end (fresh q=amazon
  supply, candidates scoring 85–95 — Ratchet & Clank PS5 $29, Samsung 4K
  monitors), but 100% died at the final web-search sale verification with
  `strict check could not be completed`. The 07-21 gate demanded the verifier
  cite a search-returned exact-ASIN Amazon page **plus** a separate current-sale
  page dated within 6h and naming Amazon as seller — a bar general web search
  essentially never clears, even for a deal a human can see on Slickdeals.
- **New `DEAL_RSS_STRICT_SALE_VERIFICATION` (default false)** restores the
  pre-07-21 corroboration (operator decision): a lighter web-search check that
  fail-closes on **existence + orderability** only — the bot never links a dead,
  nonexistent, discontinued, or counterfeit listing. The posts remain price-free
  and Slickdeals-attributed ("spotted via Slickdeals — see the deal on Amazon
  #ad"), so the sale is the feed's claim, not the bot's, and ADR-0013's
  price-free inversion holds. A dedicated corroboration prompt decouples
  `accurate`/`orderableOnAmazon` from sale-confirmation (the strict prompt
  coupled them, so reusing it would have failed the loose gate). `strict:true`
  keeps the exact 07-21 behavior for the day PA-API attested prices exist. Also
  cheaper: the loose check does less search work per candidate. Tests cover both
  gates.

## 2026-07-23 (later) — Deal channel was starved, not broken

### Fixed
- **Two days with no deal post — diagnosed as feed supply, not a fault.** The
  worker was healthy and discovery was running (183 items in 3 days), but the
  last QUEUED candidate was 07-20 23:22. Dismissal breakdown by source:
  - **The Popular Deals sources seeded 07-21 were the main leak** and are now
    **retired** (`isActive=false`). That feed is popularity-ranked, not
    recency-ranked, so its items are structurally too old for the 6h
    sale-freshness gate — measured median age 21h, only 1 of 11 Amazon matches
    inside the window. They produced 106 stale dismissals, 20 wasted LLM
    calls, and 0 posts. Seeding them without measuring freshness first was the
    error; the replacement below was measured before adoption.
  - **The tech lane had an empty keyword prefilter**, so every general-
    merchandise item (bedding, flatware, coffee capsules, pool fountain) paid
    for an LLM lane judgment — 57 wasted calls. It now carries a
    product-category prefilter that kills those pre-LLM at $0. `seed.ts` also
    backfills any lane whose prefilter is empty, guarded so operator keyword
    edits are never clobbered.
- **New supply: `q=amazon` Slickdeals search, newest-first**, seeded for the
  three high-conviction lanes (gaming, tech, LEGO). Measured before adoption:
  22 of 25 items carry an Amazon match (88% density vs the frontpage feed's
  32%) and **all** were inside the 6h window (median age 0.4h). More qualifying
  candidates *and* less waste, since non-Amazon items never reach the extractor.

### Changed
- Ceilings raised: `DEAL_RSS_MAX_POSTS_PER_DAY` 4 → 6, `DEAL_MAX_POSTS_PER_DAY`
  6 → 8. Note the ceiling was never the binding constraint — supply was — so
  this only matters on days the queue actually fills. The 6h freshness gate and
  the strict web-search sale verification are deliberately unchanged: they are
  what make a price-free "on sale now" claim defensible. Verification spend is
  self-limiting (it only runs while a posting slot is open), so the raised
  ceiling raises cost only when it is actually producing posts.

## 2026-07-23 — The fact check can auto-reject and teach itself

### Added
- **The web-search fact check now GATES approval, and disproof auto-rejects.**
  The verdict used to only demote a self-approving reply to the manual queue;
  queue-bound replies got an informational verdict but it changed nothing. Now
  the verdict routes three ways off the classifier's own confidence (line-71
  semantics — confidence is symmetric, low when a claim can't be verified):
  - **Disproved** (`accurate=false` AND confidence ≥ `FACTCHECK_DISPROOF_CONFIDENCE`,
    default 80): the verifier positively found the product missing/unorderable
    or a claim contradicted → **auto-rejected** (`SKIPPED`, reason
    "auto-rejected by fact check"), on both the self-approve and the
    would-queue path. A provably-wrong reply never reaches the operator.
  - **Unverifiable** (inaccurate but low-confidence, or an errored/refused
    check): unchanged fail-safe — a self-approving reply demotes to the manual
    queue; we lack positive disproof, so a human still decides.
  - **Passes**: posts / stays queued as before.
- **Auto-rejections feed the learning loop.** Reflection now reads the bot's
  own disproof evidence (post, drafted reply, the verifier's summary + issues)
  as a new evidence section, framed to learn the GENERAL pattern (which product
  types / editions / availability claims proved un-buyable) rather than
  memorize the title. These are the bot's objective findings, distinct from
  operator taste — and NOT added to the operator-labeled calibration/training
  sets (different `skipReason`, so those matchers skip them). Auto-rejections
  also count toward the reflection signal tally and the daily insights basis.
- **Auditability**: the recent-activity table renders the full fact-check
  verdict (confidence + issues) on auto-rejected rows, so the operator can see
  exactly why the bot killed a reply. Worker stats line gains `factRejected`.
  New `FACTCHECK_DISPROOF_CONFIDENCE` (default 80) tunes the auto-reject bar —
  higher than the demote floor (`FACTCHECK_MIN_CONFIDENCE`, 60) on purpose.
  Unit tests lock the disproved / unverifiable / passing / errored tiers.

## 2026-07-23 — Autonomous self-approval bars aligned to the posting floors

### Changed
- **`AUTO_MIN_INTENT_SCORE` 90 → 85, `AUTO_MIN_LINK_CONFIDENCE` 85 → 75**
  (prod config + code defaults + `.env.example`). Diagnosis: the Haiku
  classifier clusters at 85 — the posting floor `MIN_PRODUCT_INTENT_SCORE` —
  for "worth replying", and almost never emits 90+. So the 90/85 self-approval
  bars sat *above* where good replies actually score, leaving autonomous mode
  effectively off: 12 of 12 queued replies scored intent exactly 85 with
  passing fact checks, yet all escalated for manual approval. The bars now
  match the posting floors, so anything good enough to post self-approves. The
  pre-publication web-search fact check is the real safety net — it already
  demotes any self-approved reply whose product it can't verify as existing or
  orderable (and, since yesterday, annotates queue-bound ones too). PLAYFUL
  replies still queue until `PLAYFUL_AUTO_APPROVE`. Note: the dashboard's
  "Fact check ✓ passed (confidence N)" is the *fact-check's* confidence, a
  separate axis from the intent/link scores that gate self-approval — the two
  were easy to conflate. Docs synced: README, dashboard tooltip, ADR-0009
  amendment.

## 2026-07-22 — Rejections carry the operator's "why"

### Added
- **Queue-bound replies get the web-search fact check too.** The
  existence/orderability/pre-order check used to run only on self-approving
  replies (as the last gate before an unreviewed post); replies escalating to
  the manual queue arrived unverified, leaving the operator to research
  orderability themselves. Now both paths are checked: self-approvals keep
  the fail-safe demotion, and queue-bound replies carry an informational
  verdict the approval card already renders (green ✓ / amber ⚠ with issues).
  Demotion stats/logs only count genuine demotions. Operator-linked replies
  still skip the check. Cost: ≤1 call + 3 searches per queued reply.
- **Rejecting a pending reply now captures feedback.** The approval card's
  four actions share one form (per-button `formAction`), so whatever the
  operator typed in the direction/refine input rides along with a Reject and
  is stored in `operatorFeedback` — the same field 👎 notes use. The nightly
  reflection shows it under REJECTED evidence ("weigh it like a 👎 note"), so
  the bot finally learns WHY a draft was refused, not just that it was.
  `skipReason` stays the byte-exact "rejected via dashboard" that calibration
  and the training-data export match on. A hidden disabled default button
  swallows Enter-key submits, so typing in the direction box can never
  accidentally Approve. Verified end-to-end locally (type → Enter inert →
  Reject → feedback row in DB).

## 2026-07-21 (later) — Profile cadence doubled, deal pool deepened

### Changed
- Own-profile deal cadence raised on prod (v93): `DEAL_RSS_MAX_POSTS_PER_DAY`
  2 → 4 and `DEAL_MAX_POSTS_PER_DAY` 3 → 6 (headroom so RSS can't be starved
  and future PA-API feed posts fit). The 60-min global gap is unchanged, so
  posts stay spread out; slots only fill when the ranked queue has verified
  deals.
- `BANTER_PER_DAY` 1 → 2 on prod: banter is the only follower-growth surface
  and followers multiply every deal post's reach. The humor judge still
  declines freely — this raises attempts, not posts.
- Reply caps raised on prod (operator call, stepped through the day):
  `MAX_REPLIES_PER_DAY` 3 → 15, `MAX_REPLIES_PER_HOUR` 1 → 3, and
  `GLOBAL_REPLY_COOLDOWN_MINUTES` 90 → 20 (the 90-min cooldown would have
  made 3/hour unreachable). Still half the early-July 30/day ceiling, and
  the go-live quality bars (intent ≥ 85, link conf ≥ 75) are unchanged —
  volume only materializes on days with that many gate-clearing candidates.
- **Both dynos Eco → Basic** ($14/mo): with click tracking live, every
  affiliate click routes through the web dyno's `/r/` redirect, and Eco web
  dynos sleep after 30 idle minutes — a click in a sleep window stalled
  10–30s on this app's slow boot, bleeding the exact clicks that must become
  the first 3 qualifying sales. Heroku can't mix Eco with Basic, so the
  worker moved too (guaranteed uptime, no more shared-quota exposure).

### Added
- **Prompt caching on the classifier** (the pipeline's highest-volume LLM
  call): the classify prompt is split at its stability boundary and a
  `cache_control` breakpoint at the end of the category list caches the
  system prompt + categories together (~4.5k tokens — each alone is under
  Haiku's 4096-token cacheable minimum). Within an eval tick, every
  candidate after the first reads that prefix at ~0.1× input price (writes
  cost 1.25×, so any tick with ≥2 evals nets positive). The suggestion-gate
  and reply prompts are far below the minimum, so they're left unmarked — a
  marker there would be a silent no-op. No prompt content or ordering
  changed.
- **Slickdeals Popular Deals feed** seeded as three new RSS sources on the
  highest-conviction lanes (tech, video games, LEGO — per the July insights).
  All six prior sources read the same frontpage feed, so the 4 daily slots
  were picking from one feed filtered six ways; Popular Deals adds ~25
  higher-churn items whose ASIN attributes the extractor already resolves
  (verified: 13/25 matched at confidence 90). Lane definitions are derived
  from the frontpage entries, so tuning stays in one place. Prod
  `DEAL_SUGGEST_SOURCES_PER_TICK` 2 → 3 keeps the full source rotation well
  inside the 6h suggestion expiry; `DEAL_SUGGEST_MAX_LLM_PER_TICK` still caps
  spend.

## 2026-07-21 — Ranked, sale-verified autonomous deals

### Added
- RSS deals now enter a cross-source high-intent queue scored by purchase
  intent, exact Amazon-ASIN match strength, freshness, and eight gaming-led
  conversion lanes. Posting slots are re-ranked after every winner so one
  topic cannot monopolize the profile.
- Deal-link clicks and profile-post engagement now produce a bounded,
  decaying lane boost. Successful topics earn more future slots; same-day
  diversity and no-click penalties keep exploration alive.
- The public `/about` funnel now offers an action-oriented Bluesky request
  template, concrete examples, latest-deals CTA, and plain-language bot and
  affiliate disclosure. The Deals dashboard surfaces the staged queue,
  assigned lane/score, sale-verification time, and per-post clicks.

### Changed
- Autonomous RSS posting fails closed unless the feed has a fresh timestamp,
  an unambiguous exact Amazon product link, and a recent web-search verdict
  explicitly confirming that exact item is currently discounted on Amazon.
  Copy remains price-free until PA-API is available; a third-party price or
  percentage can never leak into the post.

## 2026-07-21 — Solicited-path gate fixes

### Fixed
- **Operator injections could silently never run.** Two gates ate solicited
  posts: the per-author evaluation cap (2/24h, meant for trending fairness)
  blocked operator re-runs of an author the pipeline had already looked at,
  and the eval queue's 24h `createdAt` window orphaned re-injections of any
  post discovered more than a day earlier (the dashboard's "re-paste to
  reset" flow invited exactly that). Solicited posts (MANUAL/MENTION) now
  bypass the author cap and get the reply side's 7-day window. Found while
  re-running the FFX-anniversary candidate under the new retro-remaster rule.

## 2026-07-19 — Trending banter replaces the radar

### Changed
- **Retro games link the modern remaster, never the original copy** (operator
  directive off the FFX-25th-anniversary case): Amazon results for legacy-
  hardware copies (PS2/PS1/GameCube era) are used/marketplace listings at
  collector prices. The classifier now hard-queries the current remaster/
  remake/re-release ("final fantasy x x-2 hd remaster", not "final fantasy x
  ps2"), says so in the reply angle, and scores original-hardware queries low;
  franchise merch/soundtrack remains the fallback only when no modern edition
  exists. Also seeded into live operator guidance.
- **Generic links are dead** (operator directive: "it should never be posting
  generic or general items"). The category-name link fallback ("video games on
  Amazon") is removed from `chooseLink` — a reply now carries either an
  operator link or a confident SPECIFIC-product search, or it doesn't exist.
  The classifier no longer treats a category fit as grounds to reply
  (categories are discovery taxonomy only), broad genre asks get ONE concrete
  named pick instead of a genre link even for direct requests, and the rule is
  seeded into the live operator guidance so it binds immediately.

### Added
- **Trending banter** (`BANTER_ENABLED`, default on; `BANTER_PER_DAY=1`): the
  new organic-growth surface. Once a day the bot finds a popular post under
  Bluesky's trending topics (the trends API's own `category` field plus a
  name blocklist keep politics/news/tragedy out), reads the post's TOP-LIKED
  replies to sense what the room finds funny, and — only if a humor judge
  clears `BANTER_MIN_CONFIDENCE` (70) — replies with its OWN funny take. No
  link, no ad, no product mention: it exists to earn profile visits, and the
  profile is where the deal feed lives. "Silence beats cringe" is designed
  in: sincere posts and taken angles are declined (verified live — the judge
  declined wholesome nature posts at confidence 0 and only cleared a genuine
  angle), and a skipped day is a feature. Banter rides the normal BotReply
  rails: exactly-once poster, opt-out pre-flight, author cooldowns (shared
  with product replies, so nobody gets banter + a rec in the same week),
  engagement + audience-reply tracking, 👍/👎 rating, 👎 takedown, and
  reflection (tagged [banter]; humor lessons learned separately from
  product-fit lessons). Its daily budget is separate from the trending-reply
  caps.

### Removed
- **The trending radar** (RadarPost model, worker loop, dashboard card,
  `RADAR_*` env vars): superseded — it was a once-a-day, LLM-written "what's
  hot" post synthesized from the bot's own discovery data; the automated
  Slickdeals channel now posts real trending deals with real reach, making
  the radar a lesser duplicate. Posted radar posts remain on the profile and
  in `EngagementSnapshot` history.

## 2026-07-18 — Automated deal channel, manual deal surfaces removed

### Changed
- **The bot's primary channel is now its OWN PROFILE** (deal posts + radar);
  replies are secondary. Trending-reply volume cut hard — defaults now
  `MAX_REPLIES_PER_DAY=3`, `MAX_REPLIES_PER_HOUR=1`,
  `GLOBAL_REPLY_COOLDOWN_MINUTES=90` — and the quality bars raised:
  `MIN_PRODUCT_INTENT_SCORE` 70→85, `MIN_LINK_CONFIDENCE` 60→75,
  `AUTO_MIN_INTENT_SCORE` 80→90, `AUTO_MIN_LINK_CONFIDENCE` 75→85. The
  caps/cooldown apply to UNSOLICITED replies only: mentions still get prompt
  answers and operator injections are the deliberate "post more" lever.
  Rationale: replies risk annoying strangers; own-timeline posts don't.
- **RSS deal channel went LIVE** (`DEAL_RSS_AUTOPOST=true` on prod): the
  price-free poster skips the price-freshness gate (no price is advertised,
  so staleness doesn't apply — caps could otherwise delay the 2nd daily post
  past the 1h window and kill it).
- **The RSS deal path is now fully automated** (`DEAL_RSS_AUTOPOST`, default
  off = audit-only): RSS items are keyword- and LLM-lane-gated as before, then
  web-search corroborated (fail-closed) and SELF-POSTED with **price-free**,
  source-attributed copy ("spotted via Slickdeals — see the deal on Amazon
  #ad"). ADR-0013's compliance rule survives by inversion: no third-party
  price is ever advertised, so nothing needs human attestation. Budgeted by
  `DEAL_RSS_MAX_POSTS_PER_DAY` (2), same per-ASIN 7-day cooldown, per-item
  ban from "Discovered by feeds". PA-API feed discovery (real attested
  prices) is unchanged and takes over once credentials exist.

### Removed
- **All manual deal surfaces**: the operator-curated watchlist (add/edit/
  price-confirm UI and the worker's price-check loop), the "Post deal now"
  manual path, and the RSS suggestion confirm/dismiss queue. The Deals page
  is now: pending feed approvals, deal feeds (PA-API, future), RSS sources
  (the live automated channel), discovered-ASIN ban list, recent posts.

## 2026-07-17 — Audience replies as feedback

### Added
- **👎 now takes the reply down.** Rating a posted reply "down" doesn't just
  teach the bot — a worker loop deletes it from Bluesky within ~2 minutes.
  The DB record survives untouched (text, rating, note, engagement keep
  feeding reflection); `takedownAt` is the exactly-once marker, the outcomes
  checker stops polling removed replies, and the dashboard shows a red
  "removed" marker in place of the view link. Deletion is fail-safe (a
  failed delete retries; an already-gone post just gets stamped) and runs
  even while the bot is paused — it executes an explicit operator decision,
  not autonomous behavior. NOTE: any previously 👎-rated posted replies are
  swept on first deploy.
- **Click-aware learning.** Clicks were counted but never fed the loop; now
  they do, as the revenue-proximate signal everywhere the bot learns or
  reports: daily reflection shows per-reply click counts (🔗) next to
  likes/replies and is told a clicked reply outweighs a merely-liked one;
  the insights funnel and daily ops report include click totals; and the
  prompts explicitly forbid inventing click numbers when none exist.
- **Dashboard surfacing of the new signals.** Fact-check verdicts render as
  a banner on queued replies and demoted radar drafts (why is this in my
  queue?); posted replies show ♥/↩/🔗 engagement and a collapsible
  "they said" list of audience replies; the Overview gets a quiet
  Apologies card (latest 5, hidden until one exists). Verified end-to-end
  locally against seeded rows.
- **Pre-publication fact check** (`FACTCHECK_ENABLED`, default on): the
  no-PA-API accuracy bridge. A reply that is about to post with NO human
  review (autonomous/auto self-approval) now gets one LLM call with
  Anthropic's server-side `web_search` tool as the last gate: does the
  product actually exist and is it orderable (or genuinely pre-orderable),
  are the reply's claims (release status, platform, edition) accurate, and
  would the Amazon search query plausibly land on it. We never touch Amazon
  ourselves — the check reads general web evidence, so the Associates
  account stays clean. **Fail-safe, not fail-open**: an inaccurate,
  low-confidence (< `FACTCHECK_MIN_CONFIDENCE`, 60), errored, or refused
  check demotes the reply to the manual-approval queue with the verdict
  stored on `BotReply.factCheck` — a missed auto-post beats a wrong one.
  Operator-linked replies skip the check (the human chose the link);
  manually approved replies are never checked (the human is the
  fact-checker). Cost: ≤1 call + ≤`FACTCHECK_MAX_SEARCHES` (3) searches per
  auto-approved reply — pennies/day at the 20-reply cap.
  - The **trending radar** gets the same gate: with `RADAR_AUTO_APPROVE=true`
    (flipped on 2026-07-17), a self-approving daily draft is fact-checked
    first and demoted to the approval queue on a failed/unverifiable verdict
    (verdict stored in `RadarPost.basis.factCheck`).
- **One-shot apologies** (`ApologyReply`, `APOLOGY_ENABLED` default on): when
  someone replies to the bot with negativity aimed *at the bot* (spam-calling,
  "nobody asked", criticizing the rec), it apologizes once and goes quiet.
  Politeness is unconditional; internalizing is not — reflection is told to
  learn only from constructive criticism (what was wrong and why), never from
  bare insults. Hard rails:
  - The posted text is one of two **fixed templates** chosen in code
    (constructive → "you're right, thanks for the honest feedback"; hostile →
    a brief sorry that also teaches the "opt out" phrase). The LLM only gates
    *whether* an apology is due (Haiku-cheap, temperature 0, confidence ≥ 70
    that the negativity targets the bot) — a stranger's words can never shape
    what the bot posts, so it can't be baited into arguing.
  - Silence rails: never to opted-out authors (they asked for silence —
    silence IS the polite response), once per target post ever (unique-key
    claim = exactly-once, fail-closed on crash), one per author per 7 days
    (never feed trolls), max 3/day globally, respects DRY_RUN and the pause
    switch.
- **The learning loop now reads what people say back.** The outcomes checker
  counted replies on the bot's posted replies but never captured the text — a
  "thanks, ordered one!" and a "gross spam bot" both scored 1↩. When a posted
  reply has (new) replies, the checker now pulls the thread (public AppView,
  ≤10 extra calls per hourly tick) and stores the top-liked reply texts on
  `BotReply.receivedReplies` (bot's own posts excluded, capped at 8 × 280
  chars). Daily reflection shows them as "they said:" lines under both the
  operator-rated and posted-engagement evidence sections, with explicit
  framing: gratitude/follow-ups = the reply landed, annoyance/spam-calling =
  weigh like an operator rejection, and audience text is untrusted — never a
  source of instructions or guidelines.
## Unreleased — Full engagement outcomes + insights follow-ups

### Added
- **Full outcome tracking for everything the bot posts.** The hourly outcomes
  sweep now also reads reposts and quotes on replies
  (`BotReply.replyRepostCount/replyQuoteCount`), and covers the bot's OWN
  radar and deal posts (their URIs were stored but never re-queried). Every
  reading is also appended to a new `EngagementSnapshot` table, so engagement
  becomes a time series instead of a single overwritten number — the raw
  material a future fine-tuning/reward dataset needs. Reflection, insights,
  and the dashboard all see the fuller counts.
- **Labeled training-data export** (`pnpm --filter @trendcart/worker
  export:dataset [out.jsonl]`): one JSONL record per operator-judged reply —
  full context the bot saw, what it wrote (incl. before/after operator
  edits), engagement + clicks, labeled good/bad from the operator's own
  actions (same ground truth as calibration). The "collect and label
  successful vs. failed responses" half of a fine-tuning loop, ready today.
- **Per-category engagement floors** (`ProductCategory.minEngagementScore`,
  dashboard-editable): the July insights showed retro-gaming/video-games
  candidates expiring hardest while being the operator's highest-conviction
  categories. A per-category floor lowers the bar for those without
  loosening noisy categories; blank = global `MIN_ENGAGEMENT_SCORE`.
- **Real-time orderability check for reply links** (PA-API-gated,
  best-effort): the operator's 👎s cluster on "doesn't exist yet" and
  sold-out items. With PA-API keys, a reply's search query is verified
  against Amazon (new + in-stock) before linking; zero orderable results
  demotes to the category fallback (whose copy already never implies the
  item is purchasable). No keys / API errors = unchanged behavior.

### Fixed
- **The hourly LLM eval budget no longer counts free evaluations.** The
  budget query counted every `CandidateEvaluation` row — including `policy`
  rows (cheap pre-LLM rejections, ~half of all evaluations) and `operator`
  directives (no LLM call) — silently halving real LLM throughput at any
  configured `MAX_LLM_EVALS_PER_HOUR`. With policy rejections at 49% of
  evaluations, this alone roughly doubles effective eval pace at the same
  spend cap: the single biggest lever on the 81%-of-skips expiration problem.

### Changed
- **Data migration** applying the insights recommendations the funnel data
  supports: engagement floor 8 for `retro-gaming` and `video-games` (highest
  conviction, hardest hit by expiry; guarded — skipped if the operator set a
  floor), and three intent-heavy discovery queries appended to
  `books-reading` (63%→72% conversion, 3 GOOD / 0 BAD; duplicate-guarded).
- `MAX_QUERIES_PER_CATEGORY` 8 → 12 (searches are free; the eval budget is
  the cost ceiling) so keyword additions to an already-tuned category
  actually poll instead of dying past the cap. Stale "first 6" copy fixed.
- `MAX_LLM_EVALS_PER_HOUR` default 40 → 50 (and `.env.example` 15 → 50):
  81% of all reply skips were candidates expiring in the eval backlog.
  **Check the deployed env var** — a low deployed value overrides this.
- `.env.example` `MIN_PRODUCT_INTENT_SCORE` 60 → 70, matching the code
  default. **Check the deployed env var**: if production still sets 60, the
  marginal 60–69 candidates driving the recent 👎s are getting through.

## 2026-07-11 — Click tracking + single-item radar

### Added
- **Click tracking** (`TrackedLink`, gated by `CLICK_TRACKING_ENABLED`, default
  OFF): the one revenue-proximate signal the bot was blind to. Amazon reports
  clicks per *tag*, never per *post*, so the learning loop couldn't see which
  replies/categories actually earn. Posted links now optionally route through a
  first-party `/r/<id>` redirect that counts the click and 302s to the tagged
  Amazon URL. Wired for reply + radar links (deal links are a fast-follow).
  - **The redirect is guaranteed, the count is best-effort**: any DB failure
    still bounces the user to Amazon (a tagged-homepage fallback if the id is
    unknown), and it only ever redirects to Amazon hosts — never an open
    redirect. Tracking can't break the revenue path.
  - OFF by default because enabling puts the (Eco, sleep-prone) web dyno in
    front of every link — the operator's explicit call. Needs
    `PUBLIC_BASE_URL` set; a "Link clicks" stat appears on the Overview once
    links are minted. Verified end-to-end locally (redirect, fallback,
    public-access, count increment, dashboard surfacing).

### Changed
- **Radar posts are single-item.** The first radar draft name-dropped Elden
  Ring and PlayBound while linking a Donkey Kong LEGO set — a roundup with one
  link reads as a mismatch. The generator now receives only the headline item
  and the prompt forbids mentioning any other product, so the post is about the
  one thing it links. (The incoherent live post was deleted.)

## 2026-07-11 — Trending radar + approval-queue lifecycle

### Added
- **Trending radar** (`RadarPost`): one standalone post per day on the bot's
  own profile, synthesized from the bot's OWN discovery data — what actually
  trended across its categories in the last 24h (data nobody else has; the
  follower-growth engine). One Haiku call/day, zero on thin days
  (`RADAR_MIN_ITEMS`). Drafts queue as PENDING_APPROVAL on the Overview page
  (approve & post / reject) until `RADAR_AUTO_APPROVE=true`; approved drafts
  post within a minute (link facet on the headline item + #ad tag); drafts
  older than 24h auto-expire — a stale radar reports yesterday's news.
  `RADAR_ENABLED=false` turns the whole thing off.
- **Operator email pings** (`notify.ts`): when actionable items are waiting
  (pending replies — playful count called out — radar drafts, pending deal
  posts), the operator gets an email (via Resend). At most one ping per
  `NOTIFY_MIN_INTERVAL_HOURS` (4), only when something is NEW since the last
  ping; state survives restarts in BotMemory. Ships dark until `RESEND_API_KEY`
  and `NOTIFY_EMAIL_TO` are set. (Email, not a Bluesky DM: an account can't DM
  itself — "Convos may only contain two members" — and the operator has no
  separate Bluesky account, so email is the reliable inbox.)
- **Approval-queue hygiene**: PENDING_APPROVAL replies whose post has passed
  the poster's necro window (48h; 7d for operator-injected) auto-expire with
  an audit row — the dashboard queue only ever shows actionable items.

## 2026-07-10 — The PLAYFUL lane + reply-runway eval floor

### Added
- **PLAYFUL replies**: the bot may now answer a comedic mishap with a joke
  whose punchline IS the recommendation (dog toured the neighborhood → a
  leash). Guards learned from the operator's own 👎s: the author must be
  playing it for laughs themselves, the product must genuinely FIX the
  comedic problem AND be missing from their life (never joke-recommend the
  thing they're posting about), any hint of real distress disqualifies, and
  purchasability rules apply. The classifier marks these angles `PLAYFUL:`;
  the reply generator goes joke-first with no earnest-sales pivot.
  **Comedy is curated**: PLAYFUL replies queue for manual approval even in
  autonomous mode until `PLAYFUL_AUTO_APPROVE=true` — the operator's ratings
  teach the humor taste before the bot self-posts it. Calibration held at
  **89%** with the foam-roller/rhythm-game 👎s still correctly skipped.

### Changed
- **Reply-runway floor at eval time**: trending candidates with under ~2h of
  reply window left (post already >22h old) are no longer LLM-evaluated —
  they age out unevaluated at zero spend. The last pre-v56 backlog posts were
  being classified at 19–21h old and swept hours later; that class is closed.
  (Post-v56 the expiry leak is confirmed shut: 77 of 78 all-time expiry skips
  were pre-v56 ingests.)

## 2026-07-09 — Spend-path efficiency: never pay to evaluate a doomed candidate

### Changed
- **Pre-eval doom gates**: opt-outs and author-cooldowns were checked at reply
  time — *after* the LLM eval was paid for, though both are knowable before
  it. Opted-out authors now policy-skip pre-LLM (unconditional — consent wins
  over everything), and since the author cooldown (48h) is longer than a
  post's 24h reply window, any unsolicited candidate whose author got an
  active reply after `post time − 24h` is mathematically unpostable and
  policy-skips pre-LLM too. Every historical author-cooldown skip (13) had
  paid a full classify for a guaranteed skip; that class is now $0. The same
  checks remain in the reply policy as defense-in-depth.
- **Loop-invariant reads hoisted**: the eval and reply loops fetched operator
  guidance + learned lessons from the DB per candidate; now once per tick.

## 2026-07-09 — Funnel tuning from live data: timeliness, honest fallbacks

### Changed
- **Data-driven pass over the insights report's recommendations** — each one
  verified against the live funnel before acting. Confirmed the real leak is
  TIMELINESS, not thresholds or targeting: 51 candidates expired unposted
  (15 discovered already >18h old, 27 died queued behind stale candidates),
  while the numeric gates turned out to decide almost nothing.
  - **Discovery age cap** (`MAX_CANDIDATE_AGE_HOURS`, default 16): search
    ingest skips posts too old to realistically clear eval + reply before the
    24h expiry — those evals were money spent on guaranteed expiries, and a
    reply that late lands on a dead thread anyway.
  - **Reply queue drains freshest-post-first** (was oldest-evaluation-first).
    During bursts, FIFO spent the whole batch racing candidates about to
    expire while fresh ones aged in line. Replies now land while threads are
    hot (the funnel's weak reply engagement — 18 likes / 0 replies — is partly
    reply latency). Stale candidates get a terminal expired-skip row via a
    per-tick sweeper instead of dangling.
  - **Category-fallback honesty** (the "don't link to products that don't
    exist yet" 👎): when a specific product fails the link-confidence gate and
    the reply falls back to a generic category link, the reply generator is
    now told explicitly — it must not imply the link leads to the named item.
    Previously the reply name-dropped an unbuyable ARC while linking a generic
    books search. Complements the purchasability change: low-confidence
    specifics now degrade to an HONEST category recommendation.
  - **Threshold sweep harness** (`scripts/threshold-sweep.ts` +
    `applyGates(_, _, thresholds?)` override param): replays the operator's
    labels once, re-gates at a grid. Verdict: agreement is FLAT (82%) across
    intent 40–75 and linkConf 40–80, so `MIN_PRODUCT_INTENT_SCORE`/
    `MIN_LINK_CONFIDENCE` stay at 60/60 — the insights' "tighten intent to 68"
    would have caught zero of the four 👎s (all scored 75–85) while risking
    real volume above 75.
  - **Label hygiene**: operator-DIRECTIVE posts (operatorLinkUrl set) are no
    longer calibration labels — they bypass the classifier in production, so
    replaying them measured nothing. Shared label module
    (`scripts/calibration-labels.ts`) keeps calibrate + sweep on one set.
  - Calibration after this pass: **86%** (from 80%). The v55 purchasability
    brain now correctly skips the itch.io digital-only posts it used to chase.
- **Explicitly NOT changed**, with the data that said so: engagement floor
  and eval cap stay (policy-gate false-positive rate ~10–18% on a 30-sample
  audit — healthy; the insights' floor-raise would cut real candidates to
  save cost that isn't hurting); anime-figures stays (its "83% skip rate" is
  expiry + cooldown, not targeting); retro/video-games keywords stay (their
  leaks are expiry, and their worth-replying volume is the funnel's best);
  books-reading keywords stay ("just finished reading" was already live);
  author cooldown stays (13 skips across 10 authors, mostly news accounts —
  working as intended).

## 2026-07-08 — Link confidence judges purchasability, not just relevance

### Changed
- **The classifier separates "does this product exist" from "can a buyer
  order it now."** Operator 👎 ratings kept flagging replies that linked to
  things a buyer couldn't get — a book with no buyable Amazon listing yet, a
  sold-out / out-of-print Game Boy Color cartridge. Root cause: `linkConfidence`
  was defined purely as *result relevance* ("does the first page show this
  product or same-franchise items"), while rule 3b told the model that
  anything an author owns or is excited about "is real and purchasable." An
  out-of-print game's search still *looks* relevant (used listings, other
  franchise titles), so it scored high and got linked to something unbuyable.
  - **Rule 3b** keeps its real job — never skip a genuinely-released product
    just because training data thinks it isn't out yet — but no longer asserts
    purchasability. The test is whether a listing can be *ordered*: a live
    **pre-order page counts as buyable** (an upcoming book/game you can
    pre-order is a good link, framed as a pre-order); what fails is a title
    with *no listing yet* (unannounced / "still in development") or an
    out-of-print/discontinued item that survives only as used/collector
    listings.
  - **`linkConfidence`** now scores relevance AND orderable-right-now. A
    page of used/collector listings for a sold-out item is a bad link even
    though it "matches"; no-listing and collector-only items land in the low
    (<50) bucket and fall back to a retargeted in-franchise query (a
    re-release, successor console, physical edition), a category link, or no
    link — never a dead search.
  - **Rule 4's** retarget trigger extends past digital-only/services to cover
    no-listing and out-of-print items, adding re-release/new-edition and the
    successor console to the buyable targets; genuine pre-orders are kept
    (noted as "pre-order" in the reply angle). The
    `CandidateEvaluationResult.linkConfidence` doc comment is updated to match.
- No schema, gate, or threshold change: `MIN_LINK_CONFIDENCE` (60) still does
  the enforcing — the model now feeds it an orderability-aware score.

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
