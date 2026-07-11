import { prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * When click tracking is on, mint a first-party /r/<id> redirect for a tagged
 * Amazon URL so clicks get counted; otherwise return the URL unchanged.
 *
 * Best-effort by contract: any failure (DB down, tracking off, no base URL)
 * falls back to the direct Amazon URL. Tracking must NEVER break or delay a
 * revenue link — a working untracked link beats a tracked broken one.
 *
 * Returns the id too so the caller can backfill sourceId once the source row
 * (BotReply / RadarPost / DealPost) exists, for per-source click drill-down.
 */
export async function createTrackedLink(
  targetUrl: string,
  kind: "reply" | "radar" | "deal",
  sourceId?: string,
): Promise<{ url: string; id: string | null }> {
  if (!config.clickTracking.enabled || !config.clickTracking.baseUrl) {
    return { url: targetUrl, id: null };
  }
  try {
    const link = await prisma.trackedLink.create({
      data: { targetUrl, kind, sourceId: sourceId ?? null },
      select: { id: true },
    });
    return { url: `${config.clickTracking.baseUrl}/r/${link.id}`, id: link.id };
  } catch {
    return { url: targetUrl, id: null };
  }
}
