import { AtpAgent } from "@atproto/api";
import { prisma } from "@trendcart/db";
import { considerApology } from "./apologize.js";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";

/**
 * The bot's ears, three jobs:
 *
 * 1. OPT-OUT: any reply/mention/quote containing an opt-out phrase permanently
 *    silences the bot for that author.
 * 2. REQUESTS: a mention ("@trend-cart.bsky.social what's a good budget mic?",
 *    or tagged under someone else's post) becomes a MENTION-source candidate —
 *    solicited, so it skips maturation and social cooldowns but still passes
 *    safety evaluation, rate caps, and (in manual mode) human approval.
 *    A fresh request is explicit re-consent: it clears a prior opt-out.
 * 3. APOLOGIES: a reply that's negative toward the bot (but not an opt-out —
 *    those get silence, as requested) earns one fixed-template apology.
 *    See apologize.ts for the rails.
 */

export type NotificationStats = {
  optOuts: number;
  requests: number;
  apologies: number;
  errors: number;
};

/** Explicit, directed opt-out phrases — safe to honor from any interaction. */
const STRONG_OPT_OUT_RE =
  /\b(opt.?out|unsubscribe|leave me alone|stop (?:replying|tagging|contacting|messaging|following)|do(?:n'?t| not) (?:ever )?(?:reply|contact|tag|@) ?(?:me|us|to me)?|never (?:reply|contact|tag))\b/i;
/** Bare imperatives ("stop", "go away") count only as a short, direct reply
 *  to the bot — not inside longer posts ("can't stop playing this game"). */
const WEAK_OPT_OUT_RE = /^\s*(please\s+)?(stop|go away|leave)\s*[.!]*\s*$/i;

function isOptOut(reason: string, text: string): boolean {
  if (STRONG_OPT_OUT_RE.test(text)) return true;
  return reason === "reply" && text.length <= 40 && WEAK_OPT_OUT_RE.test(text);
}

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";

type ReplyRef = { uri: string; cid: string };
type NotificationRecord = {
  text?: string;
  reply?: { root?: ReplyRef; parent?: ReplyRef };
};

/** Fetch a parent post's text and ITS true thread root from the AppView. */
async function fetchParent(
  uri: string,
): Promise<{ text: string | null; rootRef: ReplyRef | null } | null> {
  try {
    const url = new URL(GETPOSTS_URL);
    url.searchParams.append("uris", uri);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      posts?: Array<{
        uri: string;
        record?: { text?: string; reply?: { root?: ReplyRef } };
      }>;
    };
    const post = body.posts?.[0];
    if (!post) return null;
    return { text: post.record?.text ?? null, rootRef: post.record?.reply?.root ?? null };
  } catch {
    return null;
  }
}

export function createNotificationListener(
  stats: NotificationStats,
): { tick: () => Promise<void> } | null {
  if (!config.bluesky.handle || !config.bluesky.appPassword) return null;

  let agent: AtpAgent | null = null;
  // Start 30 min back so mentions arriving during a restart aren't lost;
  // Post.uri uniqueness + skipDuplicates make reprocessing idempotent.
  let lastSeen = new Date(Date.now() - 30 * 60_000);

  async function tick(): Promise<void> {
    if (blueskyBackingOff()) return; // Bluesky is down — skip until the probe window
    if (!agent) {
      const candidate = new AtpAgent({ service: "https://bsky.social" });
      try {
        await candidate.login({
          identifier: config.bluesky.handle,
          password: config.bluesky.appPassword,
        });
      } catch (error) {
        if (noteBlueskyDown(error)) return; // transient outage — back off, retry later
        throw error;
      }
      agent = candidate;
    }
    // Paginate so a burst (>50 notifications between ticks) can't silently
    // drop opt-outs or requests; process OLDEST-FIRST so a later opt-out is
    // never erased by an earlier mention.
    let response;
    try {
      response = await agent.listNotifications({ limit: 50 });
    } catch (error) {
      if (noteBlueskyDown(error)) return;
      throw error;
    }
    noteBlueskyUp();
    const collected = [...response.data.notifications];
    for (let page = 0; page < 3; page++) {
      const oldest = response.data.notifications.at(-1);
      const cursor = response.data.cursor;
      if (!cursor || !oldest || new Date(oldest.indexedAt) <= lastSeen) break;
      response = await agent.listNotifications({ limit: 50, cursor });
      collected.push(...response.data.notifications);
    }
    collected.sort((a, b) => new Date(a.indexedAt).getTime() - new Date(b.indexedAt).getTime());
    let newest = lastSeen;

    for (const notification of collected) {
      const at = new Date(notification.indexedAt);
      if (at <= lastSeen) continue;
      if (at > newest) newest = at;

      const record = notification.record as NotificationRecord;
      const text = record?.text ?? "";

      // Opt-out phrases win over everything, in any interaction type.
      if (
        ["reply", "mention", "quote"].includes(notification.reason) &&
        isOptOut(notification.reason, text)
      ) {
        await prisma.authorOptOut.upsert({
          where: { did: notification.author.did },
          create: {
            did: notification.author.did,
            reason: `requested via ${notification.reason} from @${notification.author.handle}`,
          },
          update: {},
        });
        stats.optOuts += 1;
        continue;
      }

      // A non-opt-out reply to one of our posts: apologize once if it's
      // negative toward the bot. Best-effort — considerApology never throws,
      // so a failure here can't stall opt-out/mention processing behind it.
      if (notification.reason === "reply") {
        await considerApology(
          {
            uri: notification.uri,
            cid: notification.cid,
            authorDid: notification.author.did,
            authorHandle: notification.author.handle ?? null,
            text,
            rootRef: record?.reply?.root ?? null,
          },
          agent,
          stats,
        );
        continue;
      }

      // Mentions are recommendation requests.
      if (notification.reason !== "mention") continue;
      if (!text.trim()) continue;

      // Tagged under someone else's post → pull the parent for context and
      // thread our reply into the existing conversation. The thread ROOT is
      // derived from the PARENT's own record (not the mention's claim), so a
      // crafted mention can't steer our reply into an unrelated thread.
      const parentRef = record?.reply?.parent ?? null;
      const parent = parentRef ? await fetchParent(parentRef.uri) : null;
      const contextText = parent?.text ?? null;
      const rootRef = parent ? (parent.rootRef ?? parentRef) : null;

      const created = await prisma.post.createMany({
        data: [
          {
            uri: notification.uri,
            cid: notification.cid,
            authorDid: notification.author.did,
            authorHandle: notification.author.handle ?? null,
            text,
            indexedAt: at,
            source: "MENTION",
            lastHydratedAt: new Date(),
            contextText,
            threadRootUri: rootRef?.uri ?? null,
            threadRootCid: rootRef?.cid ?? null,
            matchedKeywords: ["mention-request"],
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0) {
        // A GENUINELY NEW mention is explicit re-consent — but only clear
        // opt-outs recorded BEFORE it (never erase a newer revocation, and
        // never on restart-replayed duplicates, where count === 0).
        await prisma.authorOptOut.deleteMany({
          where: { did: notification.author.did, createdAt: { lt: at } },
        });
        stats.requests += 1;
        console.log(`[mentions] request from @${notification.author.handle}: "${text.slice(0, 80)}"`);
      }
    }
    lastSeen = newest;
  }

  return { tick };
}
