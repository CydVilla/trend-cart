import { prisma, ReplyStatus, type Prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * Operator ping: an EMAIL to the operator when actionable items are sitting in
 * the approval queues (pending replies, pending deal posts).
 * Without it the queues are silent — a PLAYFUL reply waits
 * invisibly until the dashboard is visited, then lapses.
 *
 * Delivery is Resend (https://resend.com) — Heroku can't send mail itself.
 * Ships dark until BOTH RESEND_API_KEY and NOTIFY_EMAIL_TO are set.
 *
 * Pings only when something is NEW since the last ping, at most one per
 * NOTIFY_MIN_INTERVAL_HOURS. State survives restarts in BotMemory.
 */

const PING_MEMORY_ID = "approval-ping";
const RESEND_URL = "https://api.resend.com/emails";

export type NotifyStats = { pings: number; errors: number; disabled: boolean };

export function createNotifier(stats: NotifyStats): { tick: () => Promise<void> } | null {
  if (!config.notify.resendApiKey || !config.notify.emailTo) return null;
  console.log(`  operator email:   ping ${config.notify.emailTo} when approvals wait`);
  let stopped = false;

  async function lastPingAt(): Promise<Date | null> {
    const memory = await prisma.botMemory.findUnique({ where: { id: PING_MEMORY_ID } });
    const basis = (memory?.basis ?? null) as { lastSentAt?: string } | null;
    return basis?.lastSentAt ? new Date(basis.lastSentAt) : null;
  }

  async function tick(): Promise<void> {
    if (stopped) return;

    const last = await lastPingAt();
    if (last && Date.now() - last.getTime() < config.notify.minIntervalHours * 3_600_000) return;

    // What's actionable right now, and is any of it NEW since the last ping?
    const newSince = last ?? new Date(0);
    const [pendingReplies, newReplies, playful, pendingDeals, newDeals] =
      await Promise.all([
        prisma.botReply.count({ where: { status: ReplyStatus.PENDING_APPROVAL } }),
        prisma.botReply.count({
          where: { status: ReplyStatus.PENDING_APPROVAL, createdAt: { gt: newSince } },
        }),
        prisma.botReply.count({
          where: {
            status: ReplyStatus.PENDING_APPROVAL,
            post: { evaluations: { some: { suggestedReplyAngle: { startsWith: "PLAYFUL" } } } },
          },
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

    const total = pendingReplies + pendingDeals;
    const fresh = newReplies + newDeals;
    if (total === 0 || fresh === 0) return; // nothing waiting, or nothing new to say

    const parts: string[] = [];
    if (pendingReplies > 0) {
      parts.push(
        `${pendingReplies} repl${pendingReplies === 1 ? "y" : "ies"}${playful > 0 ? ` (${playful} playful)` : ""}`,
      );
    }
    if (pendingDeals > 0) parts.push(`${pendingDeals} deal post${pendingDeals === 1 ? "" : "s"}`);
    const summary = parts.join(", ");
    const subject = `TrendCart: ${total} item${total === 1 ? "" : "s"} awaiting your approval`;
    const link = config.notify.dashboardUrl;
    const text = `Waiting in your approval queue: ${summary}.${link ? `\n\nReview: ${link}` : ""}`;
    const html = `<p>Waiting in your approval queue: <strong>${summary}</strong>.</p>${
      link ? `<p><a href="${link}">Review on the dashboard →</a></p>` : ""
    }`;

    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.notify.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: config.notify.emailFrom,
          to: [config.notify.emailTo],
          subject,
          text,
          html,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        stats.errors += 1;
        const body = await res.text().catch(() => "");
        // Auth/permission failure is permanent until the key is fixed — a bad
        // API key or an unverified from-address (403). Disable, loudly, once.
        if (res.status === 401 || res.status === 403) {
          console.error(
            `[notify] Resend rejected the send (${res.status}: ${body.slice(0, 200)}). ` +
              `Check RESEND_API_KEY and that NOTIFY_EMAIL_FROM is allowed (the default ` +
              `onboarding@resend.dev only delivers to your own Resend account email; ` +
              `use a verified-domain address to reach anyone else). Pings disabled until restart.`,
          );
          stats.disabled = true;
          stopped = true;
          return;
        }
        console.error(`[notify] Resend send failed (${res.status}): ${body.slice(0, 200)}`);
        return; // transient (rate limit / 5xx) — retry next tick
      }
      stats.pings += 1;
      console.log(`[notify] emailed operator: ${summary}`);
      await prisma.botMemory.upsert({
        where: { id: PING_MEMORY_ID },
        create: {
          id: PING_MEMORY_ID,
          content: subject,
          basis: { lastSentAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
        update: {
          content: subject,
          basis: { lastSentAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      stats.errors += 1;
      console.error(`[notify] email ping failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  return { tick };
}
