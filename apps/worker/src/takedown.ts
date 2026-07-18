import { AtpAgent } from "@atproto/api";
import { prisma, ReplyStatus } from "@trendcart/db";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";

/**
 * Takedown loop: a 👎 on a POSTED reply doesn't just teach the bot — it
 * DELETES the reply from Bluesky. The DB row survives untouched (text,
 * rating, note, engagement counts all keep feeding reflection); only the
 * public post goes. `takedownAt` is the exactly-once marker.
 *
 * Runs even while the bot is paused: this executes an explicit operator
 * decision (remove my bad content), not autonomous behavior — pausing the
 * bot must not leave a disliked reply standing.
 */

const MAX_LOGIN_FAILURES = 3;
const BATCH = 5;

/** "Record already gone" errors — the goal state; stamp and move on. */
function isAlreadyGone(message: string): boolean {
  return /not found|could not find|no record|does not exist/i.test(message);
}

export type TakedownStats = { removed: number; errors: number };

export function createTakedown(stats: TakedownStats): { tick: () => Promise<void> } | null {
  if (!config.bluesky.handle || !config.bluesky.appPassword) return null;

  let agent: AtpAgent | null = null;
  let loginFailures = 0;
  let stopped = false;

  async function ensureAgent(): Promise<AtpAgent | null> {
    if (agent) return agent;
    const candidate = new AtpAgent({ service: "https://bsky.social" });
    try {
      await candidate.login({
        identifier: config.bluesky.handle,
        password: config.bluesky.appPassword,
      });
      loginFailures = 0;
      agent = candidate;
      return agent;
    } catch (error) {
      if (noteBlueskyDown(error)) return null;
      loginFailures += 1;
      if (loginFailures >= MAX_LOGIN_FAILURES) {
        console.error("[takedown] repeated login failures — disabling until restart");
        stopped = true;
      }
      return null;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (blueskyBackingOff()) return;

    const due = await prisma.botReply.findMany({
      where: {
        status: ReplyStatus.POSTED,
        operatorRating: "down",
        replyUri: { not: null },
        takedownAt: null,
      },
      select: { id: true, replyUri: true },
      orderBy: { ratedAt: "asc" },
      take: BATCH,
    });
    if (due.length === 0) return;

    const activeAgent = await ensureAgent();
    if (!activeAgent) return;

    for (const reply of due) {
      try {
        await activeAgent.deletePost(reply.replyUri as string);
        noteBlueskyUp();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (noteBlueskyDown(error)) return; // outage — retry the batch later
        if (!isAlreadyGone(message)) {
          // Transient/unknown failure: leave takedownAt null so the next
          // tick retries. Never stamp a deletion that didn't happen.
          stats.errors += 1;
          console.warn(`[takedown] delete failed for ${reply.replyUri}: ${message}`);
          continue;
        }
        // Already gone (deleted by hand or by moderation) — goal state.
      }
      await prisma.botReply.update({
        where: { id: reply.id },
        data: { takedownAt: new Date() },
      });
      stats.removed += 1;
      console.log(`[takedown] removed 👎-rated reply from Bluesky: ${reply.replyUri}`);
    }
  }

  return { tick };
}
