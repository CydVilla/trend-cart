import { AtpAgent } from "@atproto/api";
import { prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * The bot's ears, two jobs:
 *
 * 1. OPT-OUT: any reply/mention/quote containing an opt-out phrase permanently
 *    silences the bot for that author.
 * 2. REQUESTS: a mention ("@trend-cart.bsky.social what's a good budget mic?",
 *    or tagged under someone else's post) becomes a MENTION-source candidate —
 *    solicited, so it skips maturation and social cooldowns but still passes
 *    safety evaluation, rate caps, and (in manual mode) human approval.
 *    A fresh request is explicit re-consent: it clears a prior opt-out.
 */

export type NotificationStats = { optOuts: number; requests: number; errors: number };

const OPT_OUT_RE =
  /\b(opt.?out|stop|leave me alone|go away|unsubscribe|don'?t (?:reply|contact|tag|@) ?(?:me|us)?|never (?:reply|contact|tag))\b/i;

const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";

type ReplyRef = { uri: string; cid: string };
type NotificationRecord = {
  text?: string;
  reply?: { root?: ReplyRef; parent?: ReplyRef };
};

async function fetchPostText(uri: string): Promise<string | null> {
  try {
    const url = new URL(GETPOSTS_URL);
    url.searchParams.append("uris", uri);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      posts?: Array<{ uri: string; record?: { text?: string } }>;
    };
    return body.posts?.[0]?.record?.text ?? null;
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
    if (!agent) {
      const candidate = new AtpAgent({ service: "https://bsky.social" });
      await candidate.login({
        identifier: config.bluesky.handle,
        password: config.bluesky.appPassword,
      });
      agent = candidate;
    }
    const response = await agent.listNotifications({ limit: 50 });
    let newest = lastSeen;

    for (const notification of response.data.notifications) {
      const at = new Date(notification.indexedAt);
      if (at <= lastSeen) continue;
      if (at > newest) newest = at;

      const record = notification.record as NotificationRecord;
      const text = record?.text ?? "";

      // Opt-out phrases win over everything, in any interaction type.
      if (
        ["reply", "mention", "quote"].includes(notification.reason) &&
        OPT_OUT_RE.test(text)
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

      // Mentions are recommendation requests.
      if (notification.reason !== "mention") continue;
      if (!text.trim()) continue;

      // Tagged under someone else's post → pull the parent for context and
      // thread our reply into the existing conversation.
      const parentRef = record?.reply?.parent ?? null;
      const rootRef = record?.reply?.root ?? null;
      const contextText = parentRef ? await fetchPostText(parentRef.uri) : null;

      // Asking again is explicit re-consent.
      await prisma.authorOptOut.deleteMany({ where: { did: notification.author.did } });

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
        stats.requests += 1;
        console.log(`[mentions] request from @${notification.author.handle}: "${text.slice(0, 80)}"`);
      }
    }
    lastSeen = newest;
  }

  return { tick };
}
