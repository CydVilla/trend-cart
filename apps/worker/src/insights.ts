import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { prisma, computeFunnel, type FunnelReport, type Prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * Daily operations report. Computes the discovery→evaluation→posted funnel and
 * has the LLM turn the numbers into a plain-English summary plus concrete,
 * actionable recommendations to increase quality output. Stored in
 * BotMemory("insights") — read on the dashboard by the operator and kept as
 * part of the bot's own record.
 */

const INSIGHTS_ID = "insights";
const REFRESH_MS = 24 * 3_600_000;
const MIN_CANDIDATES = 20;

const InsightsSchema = z.object({
  summary: z.string(),
  recommendations: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        impact: z.enum(["high", "medium", "low"]),
      }),
    )
    .max(6),
});

export type InsightsReport = z.infer<typeof InsightsSchema>;

const INSIGHTS_SYSTEM = `You are the operations analyst for TrendCart, a disclosed, autonomous Bluesky bot that replies to trending posts with tagged Amazon product recommendations. You are given its pipeline funnel as hard numbers: posts discovered → candidates that cleared the engagement floor → evaluated → judged worth replying to → replies posted, plus per-category output, skip reasons, and the current config.

Write a short operations report for the operator:
1. summary: 2-3 sentences on where the funnel loses the most volume and how healthy the output is right now. Reference the actual numbers.
2. recommendations: 3-6 CONCRETE, actionable changes to increase quality output or efficiency. Ground each in the numbers and name specifics — a config value to change (with the new number), a category to cut or a discovery keyword to add, a threshold to adjust. Rank by impact.

Rules: be specific and honest; never invent numbers or claim a cause the data doesn't support. The anti-spam and safety guardrails (sensitive-topic filter, disclosure, dedupe, per-author cooldown) are non-negotiable — never recommend weakening safety. Prefer improving candidate QUALITY (better discovery, cutting dead categories) over just loosening thresholds. If a category produces evaluations but zero posts, that's a signal it's either poorly targeted or the discovery keywords are wrong.`;

function fmtFunnel(label: string, f: FunnelReport): string {
  const c = f.candidates;
  const e = f.evaluations;
  const r = f.replies;
  const cats = f.categories
    .map((x) => `${x.category}: ${x.wouldReply} worth-replying / ${x.posted} posted`)
    .join("; ");
  const skips = f.skipReasons.map((s) => `${s.reason} (${s.count})`).join("; ");
  return [
    `## ${label}`,
    `Discovered: ${c.total}. Never evaluated: ${c.belowFloor} below the engagement floor (${f.floor}), ${c.aboveFloorPending} above-floor still pending, ${c.dead} deleted.`,
    `Evaluated: ${e.total} (${e.policyGated} cheap policy rejections + ${e.llmEvaluated} reached the LLM). Judged worth replying: ${e.wouldReply}.`,
    `Replies: ${r.posted} posted, ${r.pendingApproval} awaiting approval, ${r.skipped} skipped, ${r.failed} failed.`,
    `Posted-reply engagement: ${f.engagement.likes} likes, ${f.engagement.replies} replies across ${f.engagement.postedCount} posts.`,
    `Per category (worth-replying / posted): ${cats || "none"}.`,
    `Skip reasons: ${skips || "none"}.`,
  ].join("\n");
}

export type InsightsStats = { reports: number; errors: number };

export async function insightsTick(stats: InsightsStats): Promise<void> {
  if (config.llm.useFake || !config.llm.anthropicApiKey) return;

  const existing = await prisma.botMemory.findUnique({ where: { id: INSIGHTS_ID } });
  if (existing && Date.now() - existing.updatedAt.getTime() < REFRESH_MS) return;

  const floor = config.llm.minEngagementScore;
  const [allTime, recent] = await Promise.all([
    computeFunnel(prisma, { floor }),
    computeFunnel(prisma, { floor, windowDays: 7 }),
  ]);
  if (allTime.candidates.total < MIN_CANDIDATES) return;

  const categories = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: { name: true },
  });
  const configBlock = [
    `MIN_ENGAGEMENT_SCORE (floor): ${floor}`,
    `MAX_LLM_EVALS_PER_HOUR: ${config.llm.maxEvalsPerHour}`,
    `MIN_PRODUCT_INTENT_SCORE (to reply): ${config.bot.minProductIntentScore}`,
    `AUTO_MIN_INTENT_SCORE / AUTO_MIN_LINK_CONFIDENCE (to self-post): ${config.bot.autoMinIntentScore} / ${config.bot.autoMinLinkConfidence}`,
    `MAX_REPLIES per hour/day: ${config.bot.maxRepliesPerHour}/${config.bot.maxRepliesPerDay}`,
    `AUTHOR_COOLDOWN_HOURS: ${config.bot.authorCooldownHours}`,
    `Active categories (keywords are the Bluesky search queries): ${categories.map((c) => c.name).join(", ")}`,
  ].join("\n");

  const client = new Anthropic({ apiKey: config.llm.anthropicApiKey, timeout: 60_000 });
  const response = await client.messages.parse({
    model: config.llm.model,
    max_tokens: 1200,
    output_config: { format: zodOutputFormat(InsightsSchema) },
    system: INSIGHTS_SYSTEM,
    messages: [
      {
        role: "user",
        content: `${fmtFunnel("All time", allTime)}\n\n${fmtFunnel("Last 7 days", recent)}\n\n## Current config\n${configBlock}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    stats.errors += 1;
    throw new Error("insights produced no parseable output");
  }
  const report = response.parsed_output;

  const content = [
    report.summary,
    "",
    ...report.recommendations.map((rec) => `- [${rec.impact.toUpperCase()}] ${rec.title}: ${rec.detail}`),
  ].join("\n");

  const basis = {
    generatedAt: new Date().toISOString(),
    model: config.llm.model,
    funnel: allTime,
    recentFunnel: recent,
    recommendations: report.recommendations,
  } as unknown as Prisma.InputJsonValue;

  await prisma.botMemory.upsert({
    where: { id: INSIGHTS_ID },
    create: { id: INSIGHTS_ID, content, basis },
    update: { content, basis },
  });
  stats.reports += 1;
  console.log(`[insights] wrote report: ${report.recommendations.length} recommendations`);
}
