import { AtpAgent } from "@atproto/api";
import { prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * The bot's ears: polls its notifications and permanently opts out any
 * account that interacts with it (reply, mention, quote). Conservative by
 * design — someone thanking the bot also opts themselves out, which is an
 * acceptable price for never re-targeting someone who told it off.
 * Follows and likes do NOT opt out (they're endorsements, not contact).
 */

export type NotificationStats = { optOuts: number; errors: number };

const OPT_OUT_REASONS = new Set(["reply", "mention", "quote"]);

export function createOptOutListener(stats: NotificationStats): { tick: () => Promise<void> } | null {
  if (!config.bluesky.handle || !config.bluesky.appPassword) return null;

  let agent: AtpAgent | null = null;
  // Only process notifications newer than worker start — no backfill.
  let lastSeen = new Date();

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
      if (!OPT_OUT_REASONS.has(notification.reason)) continue;
      const created = await prisma.authorOptOut.upsert({
        where: { did: notification.author.did },
        create: {
          did: notification.author.did,
          reason: `auto: ${notification.reason} from @${notification.author.handle}`,
        },
        update: {},
      });
      if (created) stats.optOuts += 1;
    }
    lastSeen = newest;
  }

  return { tick };
}
