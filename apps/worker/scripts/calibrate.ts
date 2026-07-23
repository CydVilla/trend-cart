/**
 * Weekly calibration: replay operator-labeled posts through the CURRENT
 * classifier brain (prompt + learned lessons + operator guidance + gates) and
 * measure agreement. The bot's prompts mutate daily (reflection) — this is
 * the regression check that the drift still matches the operator's judgment.
 *
 * Labels come from the operator's own actions:
 *   expected REPLY:    replies rated 👍, plus manual-era approvals (a human
 *                      clicked Approve) that were never rated 👎
 *   expected NO REPLY: replies rated 👎, dashboard rejections, manual skips
 *
 * Output: a markdown report on stdout (the workflow files it as an issue).
 * Also stores the agreement number in BotMemory("calibration") so next run
 * (and the insights job) can show the trend.
 *
 * Run: pnpm --filter @trendcart/worker calibrate
 * Env: DATABASE_URL, ANTHROPIC_API_KEY (required); ANTHROPIC_MODEL,
 *      CALIBRATE_MAX_PER_CLASS (default 20).
 */
import { computeFunnel, prisma, type Prisma } from "@trendcart/db";
import type { CategoryContext } from "@trendcart/shared";
import { config } from "../src/config.js";
import { applyGates } from "../src/evaluate.js";
import { AnthropicLlmClient } from "../src/llm/anthropic.js";
import { getLearnedGuidelines, getOperatorGuidance } from "../src/reflect.js";
import { gatherLabels } from "./calibration-labels.js";

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD. Replayed post text is sliced
 * to a fixed length for the report, which can cut an emoji/astral character in
 * half and leave a lone surrogate. That serializes fine to stdout but breaks
 * the Prisma BotMemory write ("unexpected end of hex escape") — the query
 * protocol is JSON and a lone surrogate is not valid JSON.
 */
function stripLoneSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

async function main(): Promise<void> {
  if (!config.llm.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const labels = await gatherLabels();
  const positives = labels.filter((l) => l.expected).length;
  const negatives = labels.length - positives;
  if (labels.length < 6) {
    console.log(
      `## Calibration skipped\n\nOnly ${labels.length} labeled examples exist — rate/reject more replies first.`,
    );
    return;
  }

  const categories: CategoryContext[] = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: { slug: true, name: true, description: true, exampleProblems: true },
  });
  const activeSlugs = new Set(categories.map((c) => c.slug));
  const [guidance, lessons] = await Promise.all([getOperatorGuidance(), getLearnedGuidelines()]);
  const llm = new AnthropicLlmClient(config.llm.anthropicApiKey, config.llm.model);

  type Flip = { text: string; source: string; got: boolean; reason: string };
  const flips: Flip[] = [];
  let agree = 0;
  let errors = 0;

  for (const { post, expected, source } of labels) {
    try {
      const raw = await llm.classifyPost({
        postText: post.text,
        authorHandle: post.authorHandle,
        categories,
        keywordMatches: post.detectedCategories,
        engagement: {
          likeCount: post.likeCount,
          repostCount: post.repostCount,
          replyCount: post.replyCount,
          quoteCount: post.quoteCount,
        },
        postAgeMinutes: 90, // normalized: judge content, not staleness
        authorProfile: null,
        isDirectRequest: post.source === "MENTION",
        threadContext: post.contextText,
        // Replay the stored images through today's (vision-capable) brain.
        // Comments aren't persisted and old threads have drifted, so skip them.
        images: post.imageUrls.map((url, i) => ({ url, alt: post.imageAlts[i]?.trim() || null })),
        comments: [],
        operatorNote: post.operatorNote,
        operatorGuidance: guidance,
        learnedGuidelines: lessons,
      });
      const verdict = applyGates(raw, activeSlugs);
      if (verdict.shouldReply === expected) agree += 1;
      else {
        flips.push({
          text: post.text.slice(0, 110),
          source,
          got: verdict.shouldReply,
          reason: verdict.reason.slice(0, 140),
        });
      }
    } catch (error) {
      errors += 1;
      console.error(`eval failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const scored = labels.length - errors;
  const pct = scored > 0 ? Math.round((agree / scored) * 100) : 0;
  // A run where most replays errored can't measure agreement — and must never
  // masquerade as "0%, still aligned" (nothing was scored). The usual cause is
  // an invalid/expired CI ANTHROPIC_API_KEY: the replay calls the LIVE
  // classifier, so a bad key fails EVERY eval with a 401.
  const reliable = scored > 0 && errors <= Math.floor(labels.length / 2);

  const prev = await prisma.botMemory.findUnique({ where: { id: "calibration" } });
  const prevBasis = (prev?.basis ?? null) as { agreementPct?: number } | null;
  const delta =
    prevBasis?.agreementPct != null ? ` (previous run: ${prevBasis.agreementPct}%)` : "";

  const falsePositives = flips.filter((f) => f.got);
  const falseNegatives = flips.filter((f) => !f.got);
  const lines = [`## Weekly calibration — brain vs. your judgment`, ``];
  if (!reliable) {
    lines.push(
      `⚠️ **Calibration could not run** — ${errors} of ${labels.length} replays errored, so agreement was not measured this week.`,
      ``,
      "This is almost always the CI `ANTHROPIC_API_KEY` secret being invalid or " +
        "expired: calibration replays posts through the LIVE classifier, so a bad " +
        "key fails every eval with a 401. Check the workflow run logs for the exact " +
        "error and rotate the repo secret.",
      ``,
      `**This is NOT an "aligned" result — nothing was scored.** The stored agreement baseline is left untouched so the trend survives a broken run.`,
    );
  } else {
    lines.push(
      `Replayed **${scored}** operator-labeled posts (${positives} expected-reply, ${negatives} expected-skip) through the current classifier + gates + lessons + guidance.`,
      ``,
      `**Agreement: ${pct}%**${delta}${errors ? ` · ${errors} eval errors` : ""}`,
      ``,
    );
    if (falsePositives.length > 0) {
      lines.push(`### Would now reply, but you said no (${falsePositives.length})`, ``);
      for (const f of falsePositives) lines.push(`- (${f.source}) "${f.text}" — bot: ${f.reason}`);
      lines.push(``);
    }
    if (falseNegatives.length > 0) {
      lines.push(`### Would now skip, but you approved (${falseNegatives.length})`, ``);
      for (const f of falseNegatives) lines.push(`- (${f.source}) "${f.text}" — bot: ${f.reason}`);
      lines.push(``);
    }
    lines.push(
      flips.length === 0
        ? `No disagreements — the learning loop is still aligned with your decisions.`
        : `Operator approvals and ratings are ground truth — a flip is always the bot's miss, never a "label error". Fix via Operator guidance (authoritative) or the lessons editor on the Overview page.`,
    );
  }

  // Weekly health snapshot: the last 7 days' funnel + clicks, so this issue
  // is a one-stop check, not just an agreement number. Best-effort — a
  // snapshot failure must never sink the calibration report.
  try {
    const funnel = await computeFunnel(prisma, { windowDays: 7 });
    const clicks = await prisma.trackedLink.aggregate({
      _sum: { clickCount: true },
      _count: true,
      where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } },
    });
    lines.push(
      ``,
      `### Last 7 days`,
      ``,
      `discovered ${funnel.candidates.total} → evaluated ${funnel.candidates.evaluated} → worth replying ${funnel.evaluations.wouldReply} → posted ${funnel.replies.posted}`,
      `engagement: ${funnel.engagement.likes} likes · ${funnel.engagement.replies} replies · clicks ${clicks._sum.clickCount ?? 0} across ${clicks._count} tracked links`,
      `your verdicts this week: 👍 ${funnel.operatorRatings.up} · 👎 ${funnel.operatorRatings.down}`,
      `top skips: ${funnel.skipReasons.slice(0, 3).map((s) => `${s.reason} (${s.count})`).join(" · ") || "none"}`,
    );
  } catch (error) {
    lines.push(``, `_(7-day snapshot unavailable: ${error instanceof Error ? error.message : error})_`);
  }

  // Sanitize once: the report embeds fixed-length slices of replayed post text,
  // which can leave a lone surrogate that breaks the BotMemory write below.
  const report = stripLoneSurrogates(lines.join("\n"));
  console.log(report);

  // Persist the agreement number only when the run actually measured it — an
  // all-errors run must not overwrite the trend baseline with a bogus 0%.
  if (reliable) {
    await prisma.botMemory.upsert({
      where: { id: "calibration" },
      create: {
        id: "calibration",
        content: report,
        basis: { agreementPct: pct, scored, generatedAt: new Date().toISOString() },
      },
      update: {
        content: report,
        basis: {
          agreementPct: pct,
          scored,
          generatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error("CALIBRATION FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
