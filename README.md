# TrendCart

A Bluesky bot + web app that watches public posts for real, product-solvable problems
("my desk cables are a mess") and — conservatively, with manual approval — replies with a
link to a curated recommendation page on this site. Recommendation pages link out to
Amazon with your Associates tag.

**Design principle: this is not a spam bot.** It is rate-limited, safety-filtered,
dry-run by default, and prefers linking to its own recommendation pages (with affiliate
disclosure) instead of dropping raw affiliate links into replies.

## Architecture

```
apps/
  web/        Next.js (App Router) — dashboard + public /recommendations/[slug] pages
  worker/     Node worker — Jetstream ingestion, evaluation pipeline, reply posting
packages/
  db/         Prisma schema + shared PrismaClient
  shared/     Shared types, LLM client interface, engagement scoring, affiliate URL utils
```

Data flow:

```
Jetstream firehose → cheap filters (length, language, keywords) → Post row
  → rehydrate engagement counts by URI → engagement score/velocity
  → LLM evaluation (only for keyword-matched candidates) → CandidateEvaluation row
  → safety + intent + cooldown + rate-limit gates → BotReply (dry_run / pending approval)
  → dashboard approval → post reply linking to /recommendations/[slug]
```

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
pnpm dev:worker   # Jetstream ingestion worker
pnpm db:studio    # browse the database
```

The worker logs a stats line every 30s showing the ingestion funnel, e.g.
`events=12000 creates=4100 saved=6 | not_english=2100 too_short=1300 no_category_match=690 ...`
— most posts should be filtered; only keyword-matched candidates are stored.

Candidate evaluation (Phase 4) needs an LLM: set `ANTHROPIC_API_KEY` in `.env`,
or set `USE_FAKE_LLM=true` to exercise the pipeline with a deterministic
heuristic client (no API calls). Evaluations are capped by
`MAX_LLM_EVALS_PER_HOUR` and every decision — including every rejection reason —
is stored in `CandidateEvaluation`.

Reply generation (Phase 5) turns approved evaluations into `BotReply` rows.
The pipeline requires a **published** recommendation page for the category,
enforces per-author/per-category/global cooldowns and hourly/daily caps,
validates every reply (length, exactly one link — our page, no hashtags,
no banned phrases), and dedupes identical text. `DRY_RUN=true` is the master
switch: rows are stored as `DRY_RUN` and nothing is ever posted. In `manual`
mode rows wait as `PENDING_APPROVAL` for the dashboard (Phase 6); the posting
loop publishes `APPROVED` rows to Bluesky and needs `BOT_APP_PASSWORD`
(create an app password in Bluesky Settings — never use the real password).

## Dashboard

`pnpm dev:web` → http://localhost:3000. Sections: **Candidates** (ingested posts
with evaluation details and a manual Skip), **Replies** (approve/reject the
pending queue; shows a banner while DRY_RUN is on), **Categories** (edit
keywords — the worker hot-reloads them within 5 min), **Products** (add
products with plain Amazon URLs; the affiliate tag is applied at render),
**Pages** (create/publish recommendation pages with inline preview — the bot
only replies for categories with a published page).

⚠️ The dashboard has **no authentication** — it is for local use. Add auth
(e.g. basic-auth middleware) before deploying it anywhere public.

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
| `MAX_REPLIES_PER_HOUR` / `_DAY` | Hard rate limits |
| `MIN_PRODUCT_INTENT_SCORE` | LLM intent threshold (0–100) below which the bot never replies |
| `AMAZON_ASSOCIATE_TAG` | Your Associates store ID, appended to Amazon links at render time |
| `BOT_APP_PASSWORD` | Bluesky **app password** (never your real password) |

## Safety model

The bot only replies when **all** of these pass:

1. Cheap filters: post length, language, keyword match against an active category.
2. LLM evaluation: `productIntentScore >= 70`, `safetyStatus = safe`, category maps to an
   active `ProductCategory`. Sensitive topics (tragedy, politics, illness, personal
   crisis, etc.) are always unsafe.
3. Cooldowns: per-author, per-category, and global gaps between replies.
4. Rate limits: hourly and daily caps.
5. Reply validation: length, at most one link, no banned phrases, not a recent duplicate.
6. Mode gate: dry-run records only; manual mode queues for dashboard approval.

Every skip is recorded with a reason (`BotReply.skipReason`, `CandidateEvaluation.reason`).

## Affiliate compliance notes

- Recommendation pages carry an affiliate disclosure ("As an Amazon Associate I earn
  from qualifying purchases").
- Add your deployed site URL to your Amazon Associates account's site list.
- Replies link to your recommendation pages, not directly to Amazon.

## Deployment (Heroku)

Planned for after the MVP works locally: a `web` dyno (Next.js), a `worker` dyno
(ingestion/bot), and Heroku Postgres. `pnpm db:deploy` runs migrations in release phase.

## Phase status

- [x] Phase 1 — project setup (monorepo, tooling, Docker Postgres)
- [x] Phase 2 — Prisma schema
- [x] Phase 3 — Jetstream ingestion (filters, keyword matching, engagement rehydration)
- [x] Phase 4 — candidate evaluation (LLM classification with server-side gates)
- [x] Phase 5 — reply generation, validation, and Bluesky posting loop
- [x] Phase 6 — dashboard (candidates, reply approval, categories, products, page management)
- [x] Phase 7 — public recommendation pages (/recommendations/[slug] + index)
- [ ] Phase 8 — safety & rate limits
- [ ] Phase 9 — seed data
