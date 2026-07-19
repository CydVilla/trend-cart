# ADR-0016: The growth loop — radar posts, click tracking, operator pings

**Status:** Accepted

## Context
Replies only reach the original thread's readers, so the bot's audience never
compounds; Amazon reports clicks per *tag*, never per *post*, so the learning
loop was blind to the one revenue-proximate signal; and the approval queue
was silent — a pending reply (or the new PLAYFUL/joke-lane drafts, which
always escalate to approval) waited invisibly until the dashboard happened to
be visited, then lapsed.

## Decision
**Trending radar** (`RadarPost`): one standalone post per day on the bot's
own profile, synthesized from its OWN discovery data — what actually trended
across its categories in the last 24h. Single-item by rule: the post carries
exactly one link, so it is about exactly one product (a roundup that
name-drops Elden Ring while linking a LEGO set reads as a mismatch — learned
live, post deleted). One Haiku call/day, none on thin days
(`RADAR_MIN_ITEMS`); drafts queue for approval on the Overview page until
`RADAR_AUTO_APPROVE=true`; stale drafts (>24h) auto-expire.

**Click tracking** (`TrackedLink`, `CLICK_TRACKING_ENABLED`): posted reply and
radar links route through a first-party `/r/<id>` redirect that counts the
click and 302s to the tagged Amazon URL. Design rule: **the redirect is
guaranteed, the count is best-effort** — any failure still bounces the user
to Amazon (tagged-homepage fallback for unknown ids), only ever to Amazon
hosts (never an open redirect). Default OFF because it puts the sleep-prone
Eco web dyno in front of every link; the escape hatch at volume is moving
just `/r/` to an always-warm edge (e.g. Cloudflare Workers).

**Operator pings** (`notify.ts`): when actionable items wait (pending
replies with the playful count called out, radar drafts, deal posts), the
operator gets an email via Resend — at most one per
`NOTIFY_MIN_INTERVAL_HOURS`, only when something is NEW since the last ping,
state in `BotMemory`. Email, not a Bluesky DM: an account cannot DM itself
("Convos may only contain two members") and the operator has no separate
Bluesky account. Approval-queue hygiene backs it: pending replies whose post
passed the posting window auto-expire with an audit row.

## Consequences
- The profile accrues original content (follower growth compounds every
  future link); per-post click data becomes the input for making the
  reflection loop revenue-aware once volume accumulates.
- The approval queue is trustworthy: pinged when it matters, never showing
  dead items.
- Two accepted costs: one more LLM call/day, and (when tracking is on) a
  cold-start delay of ~5–10s on the first click after the web dyno sleeps.

## Addendum (2026-07-19): radar removed, banter takes the growth role
The radar was a once-a-day LLM-written "what's hot" post synthesized from the
bot's own discovery data. Once the automated Slickdeals channel (ADR-0013
addendum) began posting real trending deals to the profile daily, the radar
became a lesser duplicate and was removed entirely (model, loop, dashboard
card, env vars). The organic-growth role passes to **trending banter**
(`apps/worker/src/banter.ts`): one humorous, link-free reply per day on a
popular post under Bluesky's trending topics. The bot reads the post's
top-liked replies to sense the room, then writes its own take; a humor judge
must clear `BANTER_MIN_CONFIDENCE` or the day is skipped — silence beats
cringe. Banter rows are ordinary BotReplys on BANTER-source Posts, so every
reply rail (exactly-once poster, opt-outs, cooldowns, ratings, takedowns,
reflection) applies unchanged; reflection sees them tagged [banter] and
learns humor lessons separately from product-fit lessons.
