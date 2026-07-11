import { AtpAgent } from "@atproto/api";
import { prisma, ReplyStatus, type Prisma } from "@trendcart/db";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";

/**
 * Operator ping: a Bluesky DM to the operator's PERSONAL account when
 * actionable items are sitting in the approval queues (pending replies,
 * radar drafts, pending deal posts). Without it the queues are silent —
 * a PLAYFUL reply or radar draft waits invisibly until the dashboard is
 * visited, then lapses.
 *
 * Ships dark until BOTH are true:
 *   - OPERATOR_DM_HANDLE is set (the operator's own handle), and
 *   - the bot's app password was created with "Allow access to your direct
 *     messages" checked (otherwise the chat API 401s — we fail soft and
 *     disable until restart).
 *
 * Pings only when something is NEW since the last ping, at most one per
 * NOTIFY_MIN_INTERVAL_HOURS. State survives restarts in BotMemory.
 */

const PING_MEMORY_ID = "approval-ping";
const CHAT_PROXY = { service: "did:web:api.bsky.chat", type: "bsky_chat" } as const;

export type NotifyStats = { pings: number; errors: number; disabled: boolean };

export function createNotifier(stats: NotifyStats): { tick: () => Promise<void> } | null {
  if (!config.notify.operatorDmHandle) return null;
  if (!config.bluesky.handle || !config.bluesky.appPassword) return null;
  console.log(`  operator pings:   DM to @${config.notify.operatorDmHandle} when approvals wait`);

  let agent: AtpAgent | null = null;
  let operatorDid: string | null = null;
  let stopped = false;

  async function lastPingAt(): Promise<Date | null> {
    const memory = await prisma.botMemory.findUnique({ where: { id: PING_MEMORY_ID } });
    const basis = (memory?.basis ?? null) as { lastSentAt?: string } | null;
    return basis?.lastSentAt ? new Date(basis.lastSentAt) : null;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (blueskyBackingOff()) return;

    const last = await lastPingAt();
    if (last && Date.now() - last.getTime() < config.notify.minIntervalHours * 3_600_000) return;

    // What's actionable right now, and is any of it NEW since the last ping?
    const newSince = last ?? new Date(0);
    const [pendingReplies, newReplies, playful, pendingRadar, newRadar, pendingDeals, newDeals] =
      await Promise.all([
        prisma.botReply.count({ where: { status: ReplyStatus.PENDING_APPROVAL } }),
        prisma.botReply.count({
          where: { status: ReplyStatus.PENDING_APPROVAL, createdAt: { gt: newSince } },
        }),
        prisma.botReply.count({
          where: {
            status: ReplyStatus.PENDING_APPROVAL,
            post: {
              evaluations: { some: { suggestedReplyAngle: { startsWith: "PLAYFUL" } } },
            },
          },
        }),
        prisma.radarPost.count({ where: { status: ReplyStatus.PENDING_APPROVAL } }),
        prisma.radarPost.count({
          where: { status: ReplyStatus.PENDING_APPROVAL, createdAt: { gt: newSince } },
        }),
        config.deals.enabled
          ? prisma.dealPost.count({ where: { status: "PENDING_APPROVAL" } })
          : Promise.resolve(0),
        config.deals.enabled
          ? prisma.dealPost.count({
              where: { status: "PENDING_APPROVAL", createdAt: { gt: newSince } },
            })
          : Promise.resolve(0),
      ]);

    const total = pendingReplies + pendingRadar + pendingDeals;
    const fresh = newReplies + newRadar + newDeals;
    if (total === 0 || fresh === 0) return; // nothing waiting, or nothing new to say

    const parts: string[] = [];
    if (pendingReplies > 0) {
      parts.push(
        `${pendingReplies} repl${pendingReplies === 1 ? "y" : "ies"}${playful > 0 ? ` (${playful} playful)` : ""}`,
      );
    }
    if (pendingRadar > 0) parts.push(`${pendingRadar} radar draft${pendingRadar === 1 ? "" : "s"}`);
    if (pendingDeals > 0) parts.push(`${pendingDeals} deal post${pendingDeals === 1 ? "" : "s"}`);
    const text = `TrendCart: awaiting your approval — ${parts.join(", ")}.${
      config.notify.dashboardUrl ? ` ${config.notify.dashboardUrl}` : ""
    }`;

    try {
      if (!agent) {
        const candidate = new AtpAgent({ service: "https://bsky.social" });
        await candidate.login({
          identifier: config.bluesky.handle,
          password: config.bluesky.appPassword,
        });
        agent = candidate;
      }
      if (!operatorDid) {
        const resolved = await agent.resolveHandle({ handle: config.notify.operatorDmHandle });
        operatorDid = resolved.data.did;
      }
      const chat = agent.withProxy(CHAT_PROXY.type, CHAT_PROXY.service);
      const convo = await chat.chat.bsky.convo.getConvoForMembers({ members: [operatorDid] });
      await chat.chat.bsky.convo.sendMessage({
        convoId: convo.data.convo.id,
        message: { text },
      });
      noteBlueskyUp();
      stats.pings += 1;
      await prisma.botMemory.upsert({
        where: { id: PING_MEMORY_ID },
        create: {
          id: PING_MEMORY_ID,
          content: text,
          basis: { lastSentAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
        update: {
          content: text,
          basis: { lastSentAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (noteBlueskyDown(error)) return; // transient outage — retry next tick
      stats.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      // A scope/permission failure means the app password lacks DM access —
      // permanent until the operator regenerates it. Disable, loudly, once.
      if (/bad token scope|unauthorized|forbidden|401|403/i.test(message)) {
        console.error(
          `[notify] DM failed (${message}) — the bot's app password likely lacks DM access. ` +
            `Regenerate it with "Allow access to your direct messages" checked, update ` +
            `BOT_APP_PASSWORD, and restart. Pings disabled until then.`,
        );
        stats.disabled = true;
        stopped = true;
        return;
      }
      console.error(`[notify] DM ping failed: ${message}`);
    }
  }

  return { tick };
}
