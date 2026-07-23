# TrendCart

A Bluesky bot + web app that finds trending posts with real product intent
("my desk cables are a mess", "deltarune is a masterpiece") and — conservatively,
with manual approval or confidence-gated autonomy — replies with a clickable
link to a tagged Amazon search for the thing being discussed.

**Design principle: this is not a spam bot.** The bot's PRIMARY channel is
its own profile (automated deal posts) — posts there annoy nobody. A daily
**trending-banter** reply (a genuinely funny, no-link take on a popular
trending-topic post, skipped when nothing clears the humor bar) draws people
to that profile organically. Replies to strangers are the secondary channel: severely
rate-limited (3/day, 1/hour, 90-min gap by default), held to high intent and
link-confidence bars, safety-filtered, opt-out-respecting, and never linking
anywhere the bot isn't confident the results are relevant. Mentions and
operator injections bypass the caps — solicited replies deserve answers.
Disclosure lives in the account bio, in-post #ad tags on profile posts, and
on the public /about page.

## Architecture

```
apps/
  web/        Next.js (App Router) — operator dashboard + public /about disclosure page
  worker/     Node worker — search discovery, evaluation pipeline, reply posting, learning loop
packages/
  db/         Prisma schema + shared PrismaClient
  shared/     Shared types, LLM client interface, engagement scoring, affiliate URL utils
```

Candidates enter three ways:

```
1. SEARCH    Bluesky search, every 15 min: each category keyword runs as a
             query (top posts, last 24h) → cheap filters → engagement floor
             at discovery → LLM evaluation
2. MENTION   someone tags @trend-cart.bsky.social (optionally under another
             post) → evaluated immediately as a solicited request
3. MANUAL    operator pastes a bsky.app URL in the dashboard, optionally with
             a trusted note ("the picture shows the physical edition") and/or
             an Amazon link that forces the reply to use it
```

Every candidate then flows: LLM evaluation (safety + intent + author-profile
signals, injection-hardened) → server-side gates → reply generation →
validation → BotReply (dry_run / pending approval) → dashboard approval →
posted to Bluesky.

Reply links (one per reply): an operator-provided link, or a tagged Amazon
search for the SPECIFIC product ("deltarune on Amazon" — only when the
evaluation's **link confidence** ≥ 75 that results land on relevant,
orderable items). There is NO generic fallback: category-name links are
banned, retro games always link the modern remaster/re-release (never the
used/overpriced original-hardware copy), and no confident specific link
means no reply. Links render as clickable anchor text via rich-text
facets — never raw URLs.

**Autonomous mode** (Overview-page toggle, off by default): the bot
self-approves replies with intent ≥ 85 and link confidence ≥ 75 (matching the
posting floors — or an operator directive); weaker replies still queue for
manual approval, and a pre-publication web-search fact check demotes any
self-approved reply whose product it can't verify as existing/orderable.
**Learning loop**: hourly it measures engagement (likes, replies, reposts,
quotes) on everything it posted — replies, banter, deal alerts — plus
affiliate-link clicks and the text of what people reply back (audience
feedback), keeping both live counts and an `EngagementSnapshot` time series;
daily one small LLM call distills your approvals/edits/rejections plus those
reactions into guidelines injected into its prompts (shown on the Overview
page). The labeled dataset is exportable as JSONL
(`pnpm --filter @trendcart/worker export:dataset`) for offline analysis or a
future fine-tuning loop.

## Prerequisites

- Node.js >= 22
- pnpm >= 10 (`npm i -g pnpm`)
- Docker (for local Postgres)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
#    then fill in BOT_APP_PASSWORD and ANTHROPIC_API_KEY when you get to Phases 3–5

# 3. Start Postgres
pnpm db:up

# 4. Create the schema
pnpm db:migrate

# 5. Seed the curated product categories (required for ingestion to match anything)
pnpm db:seed
```

## Running

```bash
pnpm dev:web      # Next.js on http://localhost:3000
pnpm dev:worker   # discovery/evaluation/reply worker
pnpm db:studio    # browse the database
```

The worker logs a stats line every 30s showing the discovery funnel, e.g.
`queries=54 found=310 saved=12 | below_floor=180 promotional=40 ...`
— candidates arrive from Bluesky search already trending; only results
clearing the gates and the engagement floor are stored.

Candidate evaluation (Phase 4) needs an LLM: set `ANTHROPIC_API_KEY` in `.env`,
or set `USE_FAKE_LLM=true` to exercise the pipeline with a deterministic
heuristic client (no API calls). Evaluations are capped by
`MAX_LLM_EVALS_PER_HOUR` and every decision — including every rejection reason —
is stored in `CandidateEvaluation`.

Reply generation (Phase 5) turns approved evaluations into `BotReply` rows.
The pipeline links only where the evaluation is confident (link confidence
gate), enforces per-author/per-category/global cooldowns and hourly/daily caps,
validates every reply (length, exactly one link — our page, no hashtags,
no banned phrases), and dedupes identical text. `DRY_RUN=true` is the master
switch: rows are stored as `DRY_RUN` and nothing is ever posted. In `manual`
mode rows wait as `PENDING_APPROVAL` for the dashboard (Phase 6); the posting
loop publishes `APPROVED` rows to Bluesky and needs `BOT_APP_PASSWORD`
(create an app password in Bluesky Settings — never use the real password).

## Dashboard

`pnpm dev:web` → http://localhost:3000. Sections: **Candidates** (posts sorted
by engagement, evaluation verdicts, manual Skip, and the inject/override form:
paste a post URL + optional trusted note + optional forced Amazon link;
re-pasting an existing candidate resets its verdict for a fresh run),
**Replies** (approve/reject the pending queue — cards show the clickable
anchor and its exact link destination; the mode banner reflects the worker's
real heartbeat, not env guesses; pending replies can be edited inline or
regenerated with a direction), **Categories** (the discovery control panel —
keywords are the Bluesky search queries), **Insights** (the live funnel plus
the bot's daily read on it), and — on Overview — a worker status card with
the **Autonomous** toggle and a **Pause bot** kill switch, the **Operator
guidance** box (standing instructions the bot obeys above anything it learned), and an
editable "What the bot has learned" card once the reflection job has run.
Posted replies can be rated 👍/👎 (with an optional note) on the Replies
page — those ratings are the strongest signal the learning loop gets, and a
👎 also DELETES the reply from Bluesky within ~2 minutes (the record stays
in the dashboard and keeps feeding the learning loop).
`/api/health` is public and returns 500 when the worker heartbeat goes stale —
point a free uptime pinger at it.

The bot also answers **mention requests**: anyone who tags the bot gets a
recommendation reply — solicited, so it bypasses the reply caps/cooldowns
(still safety-evaluated and, in manual mode, approval-gated).
Opt-out is phrase-based ("opt out", "stop", "leave me alone") and permanent
until the person mentions the bot again.

### Deal tracker

The **Deals** page runs the bot's own-profile deal channel. Posts default to a
terse, Wario64-style format where the price phrase itself is the clickable
affiliate link (`DEAL_POST_STYLE=classic` restores the old copy):

> Razer BlackShark V2 X Gaming Headset is **$39.99 on Amazon** (33% off,
> reg. $59.99) #ad
> (price as of Jul 6, 9:04 PM UTC — subject to change)

Two automated paths feed the same exactly-once poster:

- **Deal feeds** (ADR-0012, `DEALS_ENABLED=true` + `PA_API_*` keys): saved
  Amazon searches — keywords, category, minimum % off, price band, review
  floors, sold-by-Amazon toggle — that the worker polls via PA-API SearchItems
  for products **currently on sale**. "On sale" means a real strikethrough
  (the offer sits below Amazon's own list price), re-verified server-side.
  Discovered deals queue for your approval on the Deals page and auto-expire
  when their price snapshot goes stale; set `DEAL_FEED_AUTOPOST=true` to post
  without approval. They spend their own daily budget
  (`DEAL_FEED_MAX_POSTS_PER_DAY`, default 2) inside the global cap, and a
  per-ASIN cooldown/dedup row keeps any item from reposting within 7 days —
  pause one in "Discovered by feeds" to ban it permanently.
- **RSS deal channel** (ADR-0013, **no PA-API needed, fully automated**):
  deal-site RSS feeds are polled for Amazon items; exact-ASIN matching and an
  LLM place candidates into high-conversion lanes (Nintendo/Switch,
  PlayStation/Xbox, PC gaming, storage/SSDs, controllers/parts,
  collectibles/fandom, recent games, and giftable-under-$75). Candidates
  stage in a global high-intent queue and compete on purchase intent,
  freshness, exact-link confidence, prior clicks, and topic momentum. Only
  the winners spend a strict web-search verification call, which must confirm
  fresh evidence that the exact ASIN is currently discounted on Amazon. A
  merely plausible sale fails closed. Survivors self-post with **price-free
  copy** attributed to the source. No third-party price or percentage is ever
  advertised without PA-API. Gated by `DEAL_RSS_AUTOPOST` (default off =
  audit-only DRY_RUN rows), budgeted by `DEAL_RSS_MAX_POSTS_PER_DAY`
  (default 2), deduped per ASIN with the same 7-day cooldown, and bannable
  per item from "Discovered by feeds". Set `PUBLIC_BASE_URL` (click tracking
  defaults on) so real deal-link clicks can reallocate future lane slots;
  missing trackers are treated as unknown, never as zero-click failures.

PA-API needs an approved Associate account (3 qualifying sales in 180 days).
The whole feature ships dark behind `DEALS_ENABLED`; `DRY_RUN` still gates all
posting. Caps default deliberately tighter than replies (3 posts/day, 7-day
per-listing cooldown, 60-min global gap, 1-hour price freshness) — see
`.env.example` for the raise-the-caps recipe once you trust the feed.

The dashboard is protected by HTTP Basic auth whenever `DASHBOARD_PASSWORD`
is set (see middleware.ts); the public `/about` page and
`/api/health` stay open. Never deploy publicly without setting it.

## Verifying the scaffold

- `pnpm typecheck` passes across all packages.
- http://localhost:3000 shows live counts from Postgres (or a clear warning if the DB is down).
- `pnpm dev:worker` prints its config and `Database OK`.

## Environment variables

See [.env.example](.env.example) — every variable is documented there. Highlights:

| Variable | Purpose |
| --- | --- |
| `DRY_RUN` | `true` = never post, only record what would be posted |
| `REPLY_MODE` | `dry_run` \| `manual` (approve in dashboard) \| `auto` (off by default) |
| `MAX_REPLIES_PER_HOUR` / `_DAY` | Hard rate limits for unsolicited replies (defaults 1/hour, 3/day — replies are the secondary channel) |
| `MIN_PRODUCT_INTENT_SCORE` | LLM intent threshold (0–100) below which the bot never replies |
| `MIN_ENGAGEMENT_SCORE` | Trending floor — discovered posts below it are never evaluated |
| `MIN_LINK_CONFIDENCE` | Search queries below this confidence (0–100) are never linked (default 75) |
| `AUTO_MIN_INTENT_SCORE` | Autonomous mode self-approves only above this intent (default 85, matches the posting floor) |
| `AUTO_MIN_LINK_CONFIDENCE` | ...and above this link confidence for search links (default 75); the web-search fact check is the real backstop |
| `EVAL_MIN_POST_AGE_MINUTES` | Maturation wait so the engagement snapshot means something |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5` default (cheap); swap to an Opus model for max judgment |
| `AMAZON_ASSOCIATE_TAG` | Your Associates store ID, appended to Amazon links at render time |
| `BOT_APP_PASSWORD` | Bluesky **app password** (never your real password) |
| `DEALS_ENABLED` | Master switch for the deal tracker's worker loops (default false) |
| `PA_API_ACCESS_KEY` / `PA_API_SECRET_KEY` | Amazon Product Advertising API 5.0 keys — enable deal feeds + automated price polling (manual path works without them) |
| `PA_API_PARTNER_TAG` | PA-API PartnerTag; defaults to `AMAZON_ASSOCIATE_TAG` |
| `DEAL_POST_STYLE` | `wario` (default, terse deal-account copy) \| `classic` |
| `DEAL_FEED_AUTOPOST` | `true` = PA-API feed-discovered deals post without approval (default false) |
| `DEAL_FEED_MAX_POSTS_PER_DAY` | Daily budget for feed-discovered posts (default 2) |
| `DEAL_RSS_AUTOPOST` | `true` = automated price-free RSS deal posts publish (default false = audit-only; needs `DEALS_ENABLED`) |
| `DEAL_RSS_MAX_POSTS_PER_DAY` | Daily budget for RSS-sourced deal posts (default 2) |
| `DEAL_SUGGESTIONS_ENABLED` | The RSS deal-discovery loop itself (default true, still needs `DEALS_ENABLED`) |
| `VISION_ENABLED` / `COMMENTS_ENABLED` | Multimodal context: post image thumbnails as vision input; top replies as conversation context (default true) |
| `MAX_CANDIDATE_AGE_HOURS` | Never ingest posts older than this (default 16) — timeliness beats stale volume |
| `PLAYFUL_AUTO_APPROVE` | Joke-first replies self-post in autonomous mode (default false — they queue for approval) |
| `BANTER_ENABLED` / `BANTER_MIN_CONFIDENCE` | Daily humor reply on a trending post — organic growth, no link (on / bar 70 by default) |
| `RESEND_API_KEY` / `NOTIFY_EMAIL_TO` | Email pings when approvals wait (both required; dark otherwise) |
| `CLICK_TRACKING_ENABLED` / `PUBLIC_BASE_URL` | Per-post click counting via first-party `/r/<id>` redirects (default on when the base URL is set) |
| `FACTCHECK_ENABLED` | Web-search fact check before any reply auto-posts unreviewed; failures demote to manual approval (default true) |
| `FACTCHECK_MAX_SEARCHES` / `FACTCHECK_MIN_CONFIDENCE` | Cost bound per check (default 3) and verdict floor for auto-posting (default 60) |
| `APOLOGY_ENABLED` | One-time fixed-template apology when someone replies negatively to the bot (default true) |
| `APOLOGY_MAX_PER_DAY` | Daily apology cap (default 3); plus one per author per `APOLOGY_AUTHOR_COOLDOWN_DAYS` (default 7) |

## Safety model

The bot only replies when **all** of these pass:

1. Cheap filters: post length, language, keyword match, sensitive-topic and
   promotional-post patterns, promotional author bios.
2. Trending floor: 30-min maturation + `MIN_ENGAGEMENT_SCORE` (firehose only).
3. LLM evaluation: `productIntentScore >= MIN_PRODUCT_INTENT_SCORE` (60),
   `safetyStatus = safe`, and a valid category or sanitized search query.
   Sensitive topics (tragedy, politics, illness, personal crisis, etc.) and
   prompt-injection attempts are always unsafe.
4. Cooldowns (per-author, per-category, global — solicited requests exempt
   from the first two), hourly/daily caps, permanent opt-out list.
5. Reply validation: length, exactly one anchored facet link, no raw URLs,
   no banned phrases, not a recent duplicate.
6. Mode gate: dry-run records only; manual mode queues for dashboard
   approval; the poster re-checks existence, opt-out, and staleness, and
   claims the row for exactly-once posting.

Every skip is recorded with a reason (`BotReply.skipReason`, `CandidateEvaluation.reason`).

## Affiliate compliance notes

- The public `/about` page carries the standard disclosure ("As an Amazon
  Associate, TrendCart earns from qualifying purchases"), an ask-the-bot CTA,
  concrete request examples, and opt-out instructions — it is where the bot's
  profile link points.
- The bot account bio discloses automation + affiliate funding; anchor text
  names Amazon explicitly on every link.
- Add the deployed site URL and the Bluesky account to your Amazon Associates
  account's list of properties.

## Deployment (Heroku)

The repo is Heroku-ready: [Procfile](Procfile) defines `web` (dashboard +
public pages), `worker` (bot, scale to 1 when wanted), and a `release` phase
that runs migrations. `heroku-postbuild` generates the Prisma client and
builds Next.js.

```bash
heroku login
heroku create <app-name>
heroku addons:create heroku-postgresql:essential-0   # ~$5/mo
heroku config:set DASHBOARD_PASSWORD=<pick-one> AMAZON_ASSOCIATE_TAG=... \
  DRY_RUN=true
git push heroku main
# one-time seed against the Heroku DB (run locally):
DATABASE_URL="$(heroku config:get DATABASE_URL)" pnpm db:seed
```

The dashboard is protected by HTTP Basic auth whenever `DASHBOARD_PASSWORD`
is set (user `admin`, or override with `DASHBOARD_USER`); `/about`
stays public. The worker dyno additionally needs `ANTHROPIC_API_KEY`,
`BOT_ACCOUNT_HANDLE`, and `BOT_APP_PASSWORD` set before scaling it up.

## Changelog & decisions

See [CHANGELOG.md](CHANGELOG.md) for what shipped when, and
[docs/adr/](docs/adr/README.md) for the architecture decision records.

## Roadmap

The original post-MVP roadmap is fully shipped: search discovery (ADR-0008),
a second own-profile channel (deals ADR-0011..13, radar ADR-0016), the
measurement loop (`/r/<id>` click tracking, reply-outcome tracking, the
Insights funnel), operator notifications (email pings), and the golden set
(weekly calibration + threshold sweep). What's next, ranked by leverage:

1. **PA-API unlock at 3 qualifying sales.** The one milestone that changes
   the product: replies link DIRECTLY to `/dp/<ASIN>` product pages (verified
   in-stock) instead of tagged searches, and the deal channel's automated
   price polling + feed discovery light up. The PA-API client already exists
   (`apps/worker/src/paapi.ts`); wiring replies to it is a modest change.
2. ~~**Click-aware learning.**~~ Shipped 2026-07-17: reflection sees
   per-reply click counts (weighed as the revenue signal), and the insights
   funnel/report include click totals.
3. **Reflection guardrail.** Re-run calibration after each nightly distill
   and auto-revert a lesson set that drops agreement — needs a bigger golden
   set (~30+ per class) before the metric is stable enough to trigger on.
4. **Edge redirect.** If click volume grows, move just `/r/` to an
   always-warm edge (Cloudflare Workers free tier) so the Eco dyno's
   cold-start never eats a click.

## Phase status

- [x] Phase 1 — project setup (monorepo, tooling, Docker Postgres)
- [x] Phase 2 — Prisma schema
- [x] Phase 3 — Jetstream ingestion (filters, keyword matching, engagement rehydration)
- [x] Phase 4 — candidate evaluation (LLM classification with server-side gates)
- [x] Phase 5 — reply generation, validation, and Bluesky posting loop
- [x] Phase 6 — dashboard (candidates, reply approval, categories)
- [x] Phase 7 — public site (now a single /about disclosure page — ADR-0010)
- [x] Phase 8 — safety & rate limits (audited; stale-approval guard added to poster)
- [x] Phase 9 — seed data (9 categories; keywords double as search queries)

Live-era additions (bot went live 2026-07-03; see CHANGELOG + ADRs 0009–0016):

- [x] Autonomous mode with escalation + the learning loop (ratings → nightly
      reflection → editable lessons; operator guidance override channel)
- [x] Deal channel: watchlist alerts, feed discovery (dark until PA-API),
      ranked RSS candidates with strict price-free Amazon-sale verification
- [x] Multimodal evaluation: image thumbnails as vision input, top replies
      as conversation context, purchasability-aware link confidence
- [x] Learning measurement: weekly calibration vs the operator's own labels
      (GitHub Actions → issue) + gate-threshold sweep harness
- [x] Timeliness funnel: discovery/eval age caps, freshest-first reply
      queue, pre-LLM doom gates
- [x] Growth loop: daily trending-radar post, per-post click tracking
      (`/r/<id>`), operator email pings + approval-queue auto-expiry
- [x] PLAYFUL reply lane (joke-first recommendations, approval-gated)

## Going live checklist

1. Fill the bot account's profile and pin a short onboarding post. Suggested
   conversion-oriented copy (edit the handle if needed):

   - Display name: `TrendCart · Amazon Deal Bot`
   - Bio: `🤖 Automated Amazon deal finder. Tag me with what you need, your budget, and where you'll use it. As an Amazon Associate I earn from qualifying purchases. “Opt out” anytime.`
   - Website: the deployed `/about` URL
   - Pinned post: `Need a recommendation? Tag @trend-cart.bsky.social with what you need, your budget, and device/use. Example: “Switch controller under $50 for smaller hands.” If I find a confident match, I’ll reply with one Amazon link. I’m an automated bot; links may earn commissions.`
2. Give the account organic life first — a few own-timeline posts (e.g. its
   recommendation lists) before it ever replies to anyone.
3. Add the deployed site URL to your Amazon Associates account's site list.
4. Put auth in front of the dashboard.
5. Run with `DRY_RUN=true` for a few days; review dry-run replies in the
   dashboard until you trust the judgment.
6. Then `DRY_RUN=false` + `REPLY_MODE=manual` — every reply still needs your
   click. `auto` mode exists but is not recommended.
