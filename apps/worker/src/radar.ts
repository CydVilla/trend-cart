import { AtpAgent, type AppBskyRichtextFacet } from "@atproto/api";
import { prisma, ReplyStatus, type Prisma } from "@trendcart/db";
import { amazonSearchUrl, type LlmClient, type RadarItem } from "@trendcart/shared";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";
import { isPaused } from "./heartbeat.js";
import { truncateReplyToFit } from "./reply.js";

/**
 * Trending radar: one standalone post per day on the bot's OWN profile,
 * synthesized from the bot's own discovery data — what actually trended
 * across its categories in the last 24h. This is data nobody else has, and
 * it's the follower-growth engine: replies only reach the original thread,
 * radar posts compound the profile.
 *
 * Lifecycle mirrors replies: generator drafts → PENDING_APPROVAL (dashboard
 * approve/reject; RADAR_AUTO_APPROVE=true self-approves) → poster publishes
 * APPROVED drafts that are still fresh (<24h). DRY_RUN stores drafts as
 * DRY_RUN and never posts. One LLM call per day, or zero on thin days.
 */

const MAX_LOGIN_FAILURES = 3;
const FRESHNESS_MS = 24 * 3_600_000; // a stale radar reports yesterday's news

export type RadarStats = { drafted: number; posted: number; errors: number; disabled: boolean };

/** "hollow knight silksong" → "hollow knight silksong on Amazon" (reply.ts twin). */
function radarAnchor(query: string): string {
  const short = query.split(/\s+/).slice(0, 4).join(" ");
  return `${short.length > 34 ? short.slice(0, 34).trimEnd() : short} on Amazon`;
}

/** Byte-offset facets for the link anchor and the #ad disclosure tag. */
function buildFacets(text: string, linkUrl: string, anchor: string): AppBskyRichtextFacet.Main[] {
  const enc = new TextEncoder();
  const facets: AppBskyRichtextFacet.Main[] = [];
  const aIdx = text.lastIndexOf(anchor);
  if (aIdx >= 0) {
    const byteStart = enc.encode(text.slice(0, aIdx)).length;
    facets.push({
      index: { byteStart, byteEnd: byteStart + enc.encode(anchor).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: linkUrl }],
    });
  }
  const hIdx = text.lastIndexOf("#ad");
  if (hIdx >= 0) {
    const byteStart = enc.encode(text.slice(0, hIdx)).length;
    facets.push({
      index: { byteStart, byteEnd: byteStart + enc.encode("#ad").length },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: "ad" }],
    });
  }
  return facets;
}

/** Top trending items from the last 24h of worth-replying evaluations. */
async function gatherTrending(): Promise<RadarItem[]> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const evals = await prisma.candidateEvaluation.findMany({
    where: { createdAt: { gte: since }, shouldReply: true },
    select: {
      recommendedSearchQuery: true,
      recommendedCategory: true,
      post: { select: { text: true, engagementScore: true } },
    },
  });
  // Group by the specific product query when there is one, else the category.
  const groups = new Map<string, { item: RadarItem; isQuery: boolean }>();
  for (const ev of evals) {
    const key = ev.recommendedSearchQuery ?? ev.recommendedCategory;
    if (!key) continue;
    const existing = groups.get(key.toLowerCase());
    if (existing) {
      existing.item.mentions += 1;
      if (ev.post.engagementScore > existing.item.topEngagement) {
        existing.item.topEngagement = ev.post.engagementScore;
        existing.item.sample = ev.post.text.slice(0, 140);
      }
    } else {
      groups.set(key.toLowerCase(), {
        isQuery: ev.recommendedSearchQuery !== null,
        item: {
          label: key,
          mentions: 1,
          topEngagement: ev.post.engagementScore,
          sample: ev.post.text.slice(0, 140),
        },
      });
    }
  }
  // Headline must be LINKABLE (a specific product query) — sort queries first,
  // then by mentions and engagement.
  return [...groups.values()]
    .sort(
      (a, b) =>
        Number(b.isQuery) - Number(a.isQuery) ||
        b.item.mentions - a.item.mentions ||
        b.item.topEngagement - a.item.topEngagement,
    )
    .map((g) => g.item)
    .slice(0, 4);
}

export function createRadar(llm: LlmClient, stats: RadarStats): { tick: () => Promise<void> } | null {
  if (!config.radar.enabled) return null;
  if (!config.bluesky.handle || !config.bluesky.appPassword) return null;
  if (!config.site.amazonAssociateTag) return null;
  console.log(
    `  trending radar:   1/day, ${config.radar.autoApprove ? "auto-approved" : "approval-gated"}${config.bot.dryRun ? " (DRY_RUN: drafts only)" : ""}`,
  );

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
        console.error("[radar] repeated login failures — disabling until restart");
        stats.disabled = true;
        stopped = true;
      }
      return null;
    }
  }

  /** Draft today's radar if none exists yet and the data supports one. */
  async function draft(): Promise<void> {
    const latest = await prisma.radarPost.findFirst({ orderBy: { createdAt: "desc" } });
    if (latest && Date.now() - latest.createdAt.getTime() < FRESHNESS_MS) return; // one per day
    const items = await gatherTrending();
    const totalMentions = items.reduce((sum, item) => sum + item.mentions, 0);
    const headline = items[0];
    if (!headline || totalMentions < config.radar.minItems) return; // thin day — no filler

    const anchor = radarAnchor(headline.label);
    const linkUrl = amazonSearchUrl(headline.label, config.site.amazonAssociateTag);
    // Budget: anchor + " #ad" + separator ride on top of the body.
    const reserved = anchor.length + 5;
    const wordBudget = Math.max(12, Math.floor((config.radar.maxLength - reserved) / 6.5));
    const body = await llm.generateRadarPost({ items, wordBudget });
    const composed = `${truncateReplyToFit(body, anchor, config.radar.maxLength - 4)} #ad`;

    const status = config.bot.dryRun
      ? ReplyStatus.DRY_RUN
      : config.radar.autoApprove
        ? ReplyStatus.APPROVED
        : ReplyStatus.PENDING_APPROVAL;
    await prisma.radarPost.create({
      data: {
        content: composed,
        linkUrl,
        linkAnchor: anchor,
        basis: { items } as unknown as Prisma.InputJsonValue,
        status,
        approvedAt: status === ReplyStatus.APPROVED ? new Date() : null,
      },
    });
    stats.drafted += 1;
    console.log(`[radar] drafted (${status}): ${composed.slice(0, 80)}`);
  }

  /** Publish an APPROVED radar that is still fresh; expire stale drafts. */
  async function publish(): Promise<void> {
    // Yesterday's unapproved/unposted drafts report stale data — expire them.
    await prisma.radarPost.updateMany({
      where: {
        status: { in: [ReplyStatus.PENDING_APPROVAL, ReplyStatus.APPROVED] },
        createdAt: { lt: new Date(Date.now() - FRESHNESS_MS) },
      },
      data: { status: ReplyStatus.SKIPPED, skipReason: "radar went stale before posting" },
    });
    if (config.bot.dryRun) return;

    const due = await prisma.radarPost.findFirst({
      where: { status: ReplyStatus.APPROVED },
      orderBy: { createdAt: "asc" },
    });
    if (!due) return;
    // Exactly-once claim before any network call (poster.ts pattern).
    const claim = await prisma.radarPost.updateMany({
      where: { id: due.id, status: ReplyStatus.APPROVED },
      data: { status: ReplyStatus.POSTING },
    });
    if (claim.count !== 1) return;

    const activeAgent = await ensureAgent();
    if (!activeAgent) {
      await prisma.radarPost.update({
        where: { id: due.id },
        data: { status: ReplyStatus.APPROVED },
      });
      return;
    }
    try {
      const result = await activeAgent.post({
        text: due.content,
        facets: buildFacets(due.content, due.linkUrl, due.linkAnchor),
        createdAt: new Date().toISOString(),
      });
      await prisma.radarPost.update({
        where: { id: due.id },
        data: { status: ReplyStatus.POSTED, postUri: result.uri, postedAt: new Date() },
      });
      noteBlueskyUp();
      stats.posted += 1;
      console.log(`[radar] posted: ${result.uri}`);
    } catch (error) {
      if (noteBlueskyDown(error)) {
        await prisma.radarPost.update({
          where: { id: due.id },
          data: { status: ReplyStatus.APPROVED },
        });
        return;
      }
      stats.errors += 1;
      await prisma.radarPost.update({
        where: { id: due.id },
        data: {
          status: ReplyStatus.FAILED,
          skipReason: `post failed: ${error instanceof Error ? error.message : error}`,
        },
      });
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (await isPaused()) return;
    if (blueskyBackingOff()) return;
    await draft();
    await publish();
  }

  return { tick };
}
